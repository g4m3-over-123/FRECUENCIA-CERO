import type {
  AgentRole,
  AgentState,
  AlertPropagationResult,
  AlgorithmType,
  GameCommand,
  GridCoord,
  HeuristicType,
  MapDefinition,
  SceneId,
  SoundEvent,
  TelemetryLogEntry,
} from '../core/contracts.ts';
import { GUNSHOT_SOURCE_ID } from '../core/contracts.ts';
import { runAStar, runDijkstra, type SearchStats } from '../core/algorithms/index.ts';
import { SeededRng } from '../core/graph/seededRng.ts';
import { WeightedGraph } from '../core/graph/WeightedGraph.ts';
import type { ExtendedAgentSnapshot } from '../core/agents/AgentBrain.ts';
import type { ExtendedMaraSnapshot } from '../core/gameplay/maraController.ts';
import type { ActiveDecoy, ExtendedWorldSnapshot } from '../core/gameplay/SimulationEngine.ts';
import type { WorldPickup } from '../core/gameplay/scenes.ts';
import { consumeRound, createWeaponSnapshot, reloadWeapon } from '../core/gameplay/weapons.ts';
import type { SimulationSource } from '../game/GameLoop.ts';

/**
 * Fake world for ?mock=1. Produces ExtendedWorldSnapshot without the SimulationEngine so
 * render, HUD and debug work can start before gameplay is finished.
 *
 * It is NOT the game: zombies here are omniscient and follow a scripted state cycle so every
 * animation and overlay can be seen (patrol, investigate, pursue, attack, stunned, dead).
 * Paths and searches are real (A* over the map graph), so X-ray overlays get real data.
 */

const STATE_CYCLE: AgentState[] = ['patrol', 'investigate', 'pursue', 'attack', 'stunned', 'alert'];
const TICKS_PER_STATE = 8;

interface MockAgent {
  id: string;
  role: AgentRole;
  state: AgentState;
  health: number;
  position: GridCoord;
  goal: GridCoord | null;
  path: GridCoord[];
  lastSearch: SearchStats | null;
  phase: number;
  deadUntilTick: number;
}

function same(a: GridCoord, b: GridCoord): boolean {
  return a.row === b.row && a.col === b.col;
}

export class MockWorld implements SimulationSource {
  private readonly graph: WeightedGraph;
  private readonly walkable: GridCoord[];
  private rng!: SeededRng;
  private tick = 0;
  private elapsedMs = 0;
  private paused = false;
  private algorithm: AlgorithmType = 'astar';
  private heuristic: HeuristicType = 'octile';
  private coordination = true;
  private mara!: ExtendedMaraSnapshot;
  private agents: MockAgent[] = [];
  private sounds: SoundEvent[] = [];
  private pendingSounds: SoundEvent[] = [];
  private alerts: AlertPropagationResult[] = [];
  private logs: TelemetryLogEntry[] = [];
  private pickups: WorldPickup[] = [];
  private barricades: GridCoord[] = [];
  private barricadeHistory: GridCoord[] = [];
  private decoys: ActiveDecoy[] = [];
  private refuge!: GridCoord;
  private pharmacy!: GridCoord;

  constructor(
    private readonly map: MapDefinition,
    private readonly seed = 7
  ) {
    this.graph = new WeightedGraph(map, { allowDiagonal: true, preventCornerCutting: true });
    this.walkable = map.cells.filter((c) => c.walkable).map((c) => ({ row: c.row, col: c.col }));
    if (this.walkable.length === 0) throw new Error(`MockWorld: map ${map.id} has no walkable cells`);
    this.reset();
  }

  reset(): void {
    this.rng = new SeededRng(this.seed);
    this.tick = 0;
    this.elapsedMs = 0;
    this.paused = false;
    this.sounds = [];
    this.pendingSounds = [];
    this.alerts = [];
    this.logs = [];
    this.barricades = [];
    this.decoys = [];
    for (const b of this.barricadeHistory) this.graph.setBlocked(b, false);
    this.barricadeHistory = [];

    const ofType = (type: string): GridCoord | null => {
      const cell = this.map.cells.find((c) => c.type === type && c.walkable);
      return cell ? { row: cell.row, col: cell.col } : null;
    };
    this.refuge = ofType('refuge') ?? { ...this.map.spawnMara };
    this.pharmacy = ofType('pharmacy') ?? this.rng.pick(this.walkable);

    this.mara = {
      position: { ...this.map.spawnMara },
      noiseLevel: 0,
      health: 100,
      stamina: 100,
      hasMedicalKit: false,
      reachedExtraction: false,
      hasFuel: false,
      hasBattery: false,
      decoysRemaining: 3,
      barricadesRemaining: 3,
      posture: 'walk',
      facing: { row: 0, col: 1 },
      weapon: createWeaponSnapshot(),
    };

    const far = this.walkable.filter(
      (c) => Math.max(Math.abs(c.row - this.map.spawnMara.row), Math.abs(c.col - this.map.spawnMara.col)) >= 5
    );
    const pool = far.length >= 6 ? far : this.walkable;
    const pick = (): GridCoord => ({ ...this.rng.pick(pool) });

    this.pickups = [
      { id: 'pickup-medicine', kind: 'medicine', position: { ...this.pharmacy }, collected: false },
      { id: 'pickup-fuel', kind: 'fuel', position: pick(), collected: false },
      { id: 'pickup-battery', kind: 'battery', position: pick(), collected: false },
    ];

    const roles: AgentRole[] = ['explorer', 'explorer', 'pursuer', 'pursuer', 'explorer'];
    this.agents = [
      this.makeAgent('survivor-radio', 'radio_survivor', { ...this.refuge }, 0),
      ...roles.map((role, i) => this.makeAgent(`${role}-${i + 1}`, role, pick(), i * 3)),
    ];
    this.log('system', `MockWorld ready on ${this.map.id} (fake data, not the real AI)`);
  }

  private makeAgent(id: string, role: AgentRole, position: GridCoord, phase: number): MockAgent {
    return {
      id,
      role,
      state: role === 'radio_survivor' ? 'idle' : 'patrol',
      health: role === 'pursuer' ? 105 : role === 'explorer' ? 70 : 100,
      position,
      goal: null,
      path: [],
      lastSearch: null,
      phase,
      deadUntilTick: -1,
    };
  }

  getSnapshot(): ExtendedWorldSnapshot {
    const sceneId = (Math.min(5, 1 + Math.floor(this.tick / 60)) as SceneId);
    return {
      sceneId,
      tick: this.tick,
      elapsedMs: this.elapsedMs,
      paused: this.paused,
      algorithm: this.algorithm,
      heuristic: this.heuristic,
      mara: { ...this.mara, position: { ...this.mara.position }, facing: { ...this.mara.facing }, weapon: { ...this.mara.weapon } },
      agents: this.agents.map((a) => this.toSnapshot(a)),
      activeAlerts: this.alerts.map((a) => ({ ...a, hops: a.hops.map((h) => ({ ...h })), reachedAgentIds: [...a.reachedAgentIds] })),
      soundEvents: this.sounds.map((s) => ({ ...s, position: { ...s.position } })),
      logs: this.logs.map((l) => ({ ...l })),
      coordinationEnabled: this.coordination,
      seed: this.seed,
      status: 'playing',
      defeatReason: 'none',
      sceneName: `Mock escena ${sceneId}`,
      sceneObjective: 'Datos falsos (?mock=1): sirve para probar render, HUD y Rayos X.',
      refugePosition: { ...this.refuge },
      pharmacyPosition: { ...this.pharmacy },
      refugeIntegrity: 100,
      radioActivated: false,
      radioInstallProgress: 0,
      extractionOpen: sceneId === 5,
      extractionTicksRemaining: sceneId === 5 ? 60 : null,
      barricades: this.barricades.map((b) => ({ ...b })),
      activeDecoys: this.decoys.map((d) => ({ ...d, position: { ...d.position } })),
      pickups: this.pickups.map((p) => ({ ...p, position: { ...p.position } })),
      algorithmComparison: {
        dijkstra: { runs: 0, totalExpandedNodes: 0, totalExecutionTimeMs: 0, avgExpandedNodes: 0, avgExecutionTimeMs: 0, lastCost: 0 },
        astar: { runs: 0, totalExpandedNodes: 0, totalExecutionTimeMs: 0, avgExpandedNodes: 0, avgExecutionTimeMs: 0, lastCost: 0 },
      },
    };
  }

  step(deltaMs: number): ExtendedWorldSnapshot {
    if (this.paused) return this.getSnapshot();
    this.tick++;
    this.elapsedMs += deltaMs;
    this.sounds = [...this.pendingSounds];
    this.pendingSounds = [];
    this.alerts = [];

    for (const decoy of this.decoys) decoy.remainingTicks--;
    this.decoys = this.decoys.filter((d) => d.remainingTicks > 0);

    for (const agent of this.agents) this.stepAgent(agent);

    if (this.tick % 6 === 0) {
      const cell = this.rng.pick(this.walkable);
      this.sounds.push({ id: `mock-sound-${this.tick}`, sourceId: 'mock_noise', position: { ...cell }, radius: 6, intensity: 0.6, timestamp: this.tick });
    }
    if (this.tick % 12 === 0) this.fakeAlert();

    for (const pickup of this.pickups) {
      const d = Math.max(Math.abs(pickup.position.row - this.mara.position.row), Math.abs(pickup.position.col - this.mara.position.col));
      if (!pickup.collected && d <= 1) {
        pickup.collected = true;
        if (pickup.kind === 'medicine') this.mara.hasMedicalKit = true;
        if (pickup.kind === 'fuel') this.mara.hasFuel = true;
        if (pickup.kind === 'battery') this.mara.hasBattery = true;
        this.log('gameplay', `Mock: picked up ${pickup.kind}`);
      }
    }
    return this.getSnapshot();
  }

  private stepAgent(agent: MockAgent): void {
    if (agent.role === 'radio_survivor') return;
    if (agent.state === 'dead') {
      if (this.tick >= agent.deadUntilTick) {
        agent.state = 'patrol';
        agent.health = agent.role === 'pursuer' ? 105 : 70;
        this.log('agent', `Mock: ${agent.id} revived (mock only)`);
      }
      return;
    }

    agent.state = STATE_CYCLE[Math.floor((this.tick + agent.phase) / TICKS_PER_STATE) % STATE_CYCLE.length];
    if (agent.state === 'attack' || agent.state === 'stunned') return;

    const chasing = agent.state === 'pursue';
    if (chasing) {
      agent.goal = { ...this.mara.position };
    } else if (!agent.goal || same(agent.goal, agent.position) || agent.path.length <= 1) {
      agent.goal = { ...this.rng.pick(this.walkable) };
    }

    if (chasing || agent.path.length <= 1 || this.tick % 5 === 0) {
      const search = this.algorithm === 'dijkstra'
        ? runDijkstra(this.graph, agent.position, agent.goal)
        : runAStar(this.graph, agent.position, agent.goal, this.heuristic);
      agent.lastSearch = search;
      agent.path = search.found ? search.path : [];
    }

    const moveEvery = chasing ? 1 : 2;
    if (this.tick % moveEvery === 0 && agent.path.length > 1 && this.graph.isWalkable(agent.path[1])) {
      agent.path = agent.path.slice(1);
      agent.position = { ...agent.path[0] };
    }
  }

  private fakeAlert(): void {
    const living = this.agents.filter((a) => a.role !== 'radio_survivor' && a.state !== 'dead');
    if (living.length < 2 || !this.coordination) return;
    const origin = this.rng.pick(living);
    const others = living.filter((a) => a !== origin).slice(0, 3);
    const hops = others.map((to, i) => ({
      fromAgentId: i === 0 ? origin.id : others[i - 1].id,
      toAgentId: to.id,
      depth: i + 1,
      distance: Math.hypot(to.position.row - origin.position.row, to.position.col - origin.position.col),
      signalStrength: Math.max(0.1, 1 - 0.3 * (i + 1)),
    }));
    this.alerts.push({
      originAgentId: origin.id,
      maxDepth: hops.length,
      reachedAgentIds: [origin.id, ...others.map((o) => o.id)],
      hops,
      maxStackDepth: hops.length + 1,
      recursiveCalls: hops.length + 1,
    });
    this.log('alert', `Mock alert from ${origin.id} (${hops.length} hops)`);
  }

  applyCommand(command: GameCommand): void {
    switch (command.type) {
      case 'moveToCell':
        if (this.graph.isWalkable(command.cell)) this.mara.position = { ...command.cell };
        this.mara.posture = command.posture;
        if (command.facing) this.mara.facing = { ...command.facing };
        break;
      case 'fire': {
        const weapon = consumeRound(this.mara.weapon);
        if (!weapon) return;
        this.mara.weapon = weapon;
        this.pendingSounds.push({ id: `mock-shot-${this.tick}-${weapon.ammoInMagazine}`, sourceId: GUNSHOT_SOURCE_ID, position: { ...this.mara.position }, radius: 20, intensity: 1, timestamp: this.tick + 1 });
        const target = this.agents.find((a) => a.id === command.hitAgentId);
        if (target && target.role !== 'radio_survivor' && target.state !== 'dead') {
          target.health -= 35;
          if (target.health <= 0) {
            target.state = 'dead';
            target.deadUntilTick = this.tick + 25;
            this.log('agent', `Mock: ${target.id} killed`);
          }
        }
        break;
      }
      case 'reload':
        this.mara.weapon = reloadWeapon(this.mara.weapon);
        break;
      case 'decoy':
        if (this.mara.decoysRemaining <= 0) return;
        this.mara.decoysRemaining--;
        this.decoys.push({ id: `decoy-${this.tick}`, position: { ...(command.target ?? this.mara.position) }, remainingTicks: 4, radius: 12, intensity: 1 });
        this.pendingSounds.push({ id: `decoy-${this.tick}`, sourceId: `decoy-${this.tick}`, position: { ...(command.target ?? this.mara.position) }, radius: 12, intensity: 1, timestamp: this.tick + 1 });
        break;
      case 'barricade': {
        if (this.mara.barricadesRemaining <= 0) return;
        const cell = command.target ?? { row: this.mara.position.row + this.mara.facing.row, col: this.mara.position.col + this.mara.facing.col };
        if (!this.graph.isWalkable(cell) || same(cell, this.mara.position)) return;
        this.mara.barricadesRemaining--;
        this.graph.setBlocked(cell, true);
        this.barricades.push({ ...cell });
        this.barricadeHistory.push({ ...cell });
        break;
      }
      case 'interact':
        break;
    }
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  setAlgorithm(algorithm: AlgorithmType, heuristic: HeuristicType): void {
    this.algorithm = algorithm;
    this.heuristic = heuristic;
  }

  setCoordinationEnabled(enabled: boolean): void {
    this.coordination = enabled;
  }

  compareAlgorithms(start: GridCoord, goal: GridCoord): { dijkstra: SearchStats; astar: SearchStats } {
    return {
      dijkstra: runDijkstra(this.graph, start, goal),
      astar: runAStar(this.graph, start, goal, this.heuristic),
    };
  }

  private toSnapshot(agent: MockAgent): ExtendedAgentSnapshot {
    return {
      id: agent.id,
      role: agent.role,
      state: agent.state,
      position: { ...agent.position },
      targetPosition: agent.goal ? { ...agent.goal } : null,
      alertDepth: 0,
      memory: null,
      health: agent.state === 'dead' ? 0 : agent.health,
      currentPath: agent.state === 'dead' ? [] : agent.path.map((p) => ({ ...p })),
      lastSearch: agent.lastSearch,
      perceptionSummary: `mock: ${agent.state}`,
      algorithmUsed: this.algorithm,
      heuristicUsed: this.heuristic,
      goalReason: 'mock script',
      planChanges: 0,
      knownBlockedCells: [],
    };
  }

  private log(category: TelemetryLogEntry['category'], message: string): void {
    this.logs.push({ tick: this.tick, timestampMs: this.elapsedMs, category, message });
    if (this.logs.length > 60) this.logs.shift();
  }
}
