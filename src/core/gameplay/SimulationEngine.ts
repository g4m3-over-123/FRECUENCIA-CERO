import {
  GUNSHOT_SOURCE_ID,
  type AgentSnapshot,
  type AlertPropagationResult,
  type AlgorithmType,
  type GameCommand,
  type GridCoord,
  type MaraPosture,
  type HeuristicType,
  type MapDefinition,
  type SceneId,
  type SoundEvent,
  type TelemetryLogEntry,
  type WorldSnapshot,
} from '../contracts.ts';
import { runAStar } from '../algorithms/astar.ts';
import { runDijkstra } from '../algorithms/dijkstra.ts';
import type { SearchStats } from '../algorithms/shortestPath.ts';
import { SeededRng } from '../graph/seededRng.ts';
import { WeightedGraph } from '../graph/WeightedGraph.ts';
import {
  AGENT_PROFILES,
  AgentBrain,
  createAgentRuntime,
  toAgentSnapshot,
  type AgentRuntimeState,
  type ExtendedAgentSnapshot,
} from '../agents/AgentBrain.ts';
import { assignDistributedTargets, triggerHordeSpread } from '../agents/hordeSpread.ts';
import {
  buildLocalPerception,
  buildOpaqueCellSet,
  gridDistance,
  hasLineOfSight,
  type ReceivedAlertSignal,
} from '../agents/perception.ts';
import {
  applyExternalMaraMove,
  createInitialMaraSnapshot,
  selectBarricadePlacementCell,
  updateMaraState,
  type ExtendedMaraSnapshot,
  type ExternalMaraMove,
  type MaraInputState,
} from './maraController.ts';
import { consumeRound, getWeaponDefinition, reloadWeapon } from './weapons.ts';
import {
  buildSceneLayout,
  getScenePreset,
  type AgentSpawnConfig,
  type WorldPickup,
} from './scenes.ts';

export type SimulationStatus = 'playing' | 'victory' | 'defeat';
export type DefeatReason = 'none' | 'mara_health' | 'refuge_destroyed' | 'extraction_missed';

export interface ActiveDecoy {
  id: string;
  position: GridCoord;
  remainingTicks: number;
  radius: number;
  intensity: number;
}

export interface AlgorithmMetricBucket {
  runs: number;
  totalExpandedNodes: number;
  totalExecutionTimeMs: number;
  avgExpandedNodes: number;
  avgExecutionTimeMs: number;
  lastCost: number;
}

export interface AlgorithmComparisonMetrics {
  dijkstra: AlgorithmMetricBucket;
  astar: AlgorithmMetricBucket;
}

/**
 * Extended snapshot structurally assignable to WorldSnapshot.
 * Exposes gameplay inventory, refuge/radio progress, barricades, active paths,
 * and live Dijkstra vs A* metrics without modifying src/core/contracts.ts.
 */
export interface ExtendedWorldSnapshot extends WorldSnapshot {
  mara: ExtendedMaraSnapshot;
  agents: ExtendedAgentSnapshot[];
  coordinationEnabled: boolean;
  seed: number;
  status: SimulationStatus;
  defeatReason: DefeatReason;
  sceneName: string;
  sceneObjective: string;
  refugePosition: GridCoord;
  pharmacyPosition: GridCoord;
  refugeIntegrity: number;
  radioActivated: boolean;
  radioInstallProgress: number;
  extractionOpen: boolean;
  extractionTicksRemaining: number | null;
  barricades: GridCoord[];
  activeDecoys: ActiveDecoy[];
  pickups: WorldPickup[];
  algorithmComparison: AlgorithmComparisonMetrics;
}

export interface FireResult {
  fired: boolean;
  /** Agent that took damage, if any. */
  hitAgentId: string | null;
  killed: boolean;
  sound: SoundEvent | null;
}

export interface SimulationEngineOptions {
  seed?: number;
  coordinationEnabled?: boolean;
  allowDiagonal?: boolean;
  algorithm?: AlgorithmType;
  heuristic?: HeuristicType;
  alertRadius?: number;
  alertMaxDepth?: number;
  initialDecoys?: number;
  initialBarricades?: number;
  customAgents?: readonly AgentSpawnConfig[];
  maxLogs?: number;
}

const DEFAULT_MARA_INPUT: MaraInputState = {
  moveDirection: { row: 0, col: 0 },
  sprinting: false,
  crouching: true,
  emitDecoy: false,
  placeBarricade: false,
  interact: false,
};

function createMetricBucket(): AlgorithmMetricBucket {
  return {
    runs: 0,
    totalExpandedNodes: 0,
    totalExecutionTimeMs: 0,
    avgExpandedNodes: 0,
    avgExecutionTimeMs: 0,
    lastCost: 0,
  };
}

function sameCoord(a: GridCoord, b: GridCoord): boolean {
  return a.row === b.row && a.col === b.col;
}

/**
 * Headless deterministic simulation loop managing ticks, Mara mechanics,
 * local agent perception (anti-omniscience), recursive alert propagation,
 * dynamic barricades, acoustic decoys, and the 5-scene progression.
 */
export class SimulationEngine {
  private readonly map: MapDefinition;
  private readonly options: SimulationEngineOptions;
  private readonly brain = new AgentBrain();
  private readonly opaqueCells: Set<number>;

  private graph!: WeightedGraph;
  private rng!: SeededRng;
  private seed: number;
  private sceneId: SceneId;
  private tickCount = 0;
  private elapsedMs = 0;
  private paused = false;
  private algorithm: AlgorithmType;
  private heuristic: HeuristicType;
  private coordinationEnabled: boolean;
  private alertRadius: number;
  private alertMaxDepth: number;
  private maxLogs: number;

  private status: SimulationStatus = 'playing';
  private defeatReason: DefeatReason = 'none';
  private mara!: ExtendedMaraSnapshot;
  private agentRuntimes: AgentRuntimeState[] = [];
  private pendingAlerts = new Map<string, ReceivedAlertSignal>();
  private queuedInput: MaraInputState = { ...DEFAULT_MARA_INPUT };
  /** True once the FPV PlayerController drives Mara through setMaraCell. */
  private externalControl = false;
  private pendingExternalMove: ExternalMaraMove | null = null;
  private pendingSounds: SoundEvent[] = [];
  private activeDecoys: ActiveDecoy[] = [];
  private barricades: GridCoord[] = [];
  private pickups: WorldPickup[] = [];
  private refugePosition!: GridCoord;
  private pharmacyPosition!: GridCoord;
  private extractionPosition!: GridCoord;
  private refugeIntegrity = 100;
  private radioActivated = false;
  private radioInstallProgress = 0;
  private extractionOpen = false;
  private extractionTicksRemaining: number | null = null;
  private pharmacyDoorTriggered = false;
  private activeAlerts: AlertPropagationResult[] = [];
  private lastTickSounds: SoundEvent[] = [];
  private logs: TelemetryLogEntry[] = [];
  private algorithmComparison: AlgorithmComparisonMetrics = {
    dijkstra: createMetricBucket(),
    astar: createMetricBucket(),
  };

  constructor(
    map: MapDefinition,
    sceneId: SceneId = 1,
    options: SimulationEngineOptions = {}
  ) {
    this.map = map;
    this.options = options;
    this.opaqueCells = buildOpaqueCellSet(map);
    this.seed = options.seed ?? 1337;
    this.sceneId = sceneId;
    this.algorithm = options.algorithm ?? 'astar';
    this.heuristic = options.heuristic ?? 'octile';
    this.coordinationEnabled = options.coordinationEnabled ?? true;
    this.alertRadius = options.alertRadius ?? 7;
    this.alertMaxDepth = options.alertMaxDepth ?? 3;
    this.maxLogs = options.maxLogs ?? 80;

    this.initializeScene(sceneId, this.seed);
  }

  getGraph(): WeightedGraph {
    return this.graph;
  }

  getSnapshot(): ExtendedWorldSnapshot {
    const preset = getScenePreset(this.sceneId);
    return {
      sceneId: this.sceneId,
      tick: this.tickCount,
      elapsedMs: this.elapsedMs,
      paused: this.paused,
      algorithm: this.algorithm,
      heuristic: this.heuristic,
      mara: {
        ...this.mara,
        position: { ...this.mara.position },
        facing: { ...this.mara.facing },
      },
      agents: this.agentRuntimes.map((runtime) => toAgentSnapshot(runtime)),
      activeAlerts: this.activeAlerts.map((alert) => ({
        ...alert,
        reachedAgentIds: [...alert.reachedAgentIds],
        hops: alert.hops.map((hop) => ({ ...hop })),
      })),
      soundEvents: this.lastTickSounds.map((s) => ({
        ...s,
        position: { ...s.position },
      })),
      logs: this.logs.map((entry) => ({ ...entry })),
      coordinationEnabled: this.coordinationEnabled,
      seed: this.seed,
      status: this.status,
      defeatReason: this.defeatReason,
      sceneName: preset.name,
      sceneObjective: preset.objective,
      refugePosition: { ...this.refugePosition },
      pharmacyPosition: { ...this.pharmacyPosition },
      refugeIntegrity: this.refugeIntegrity,
      radioActivated: this.radioActivated,
      radioInstallProgress: this.radioInstallProgress,
      extractionOpen: this.extractionOpen,
      extractionTicksRemaining: this.extractionTicksRemaining,
      barricades: this.barricades.map((b) => ({ ...b })),
      activeDecoys: this.activeDecoys.map((d) => ({ ...d, position: { ...d.position } })),
      pickups: this.pickups.map((p) => ({ ...p, position: { ...p.position } })),
      algorithmComparison: {
        dijkstra: { ...this.algorithmComparison.dijkstra },
        astar: { ...this.algorithmComparison.astar },
      },
    };
  }

  setAlgorithm(algorithm: AlgorithmType, heuristic: HeuristicType): void {
    this.algorithm = algorithm;
    this.heuristic = heuristic;
    this.pushLog('system', `Search algorithm set to ${algorithm} (${heuristic})`);
  }

  setCoordinationEnabled(enabled: boolean): void {
    this.coordinationEnabled = enabled;
    this.pushLog(
      'system',
      `Multi-agent coordination ${enabled ? 'enabled (coordinated mode)' : 'disabled (isolated mode)'}`
    );
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  setScene(sceneId: SceneId): void {
    this.initializeScene(sceneId, this.seed);
  }

  reset(sceneId: SceneId = this.sceneId, seed: number = this.seed): void {
    this.initializeScene(sceneId, seed);
  }

  /**
   * Queues Mara's discrete input for the next simulation step.
   */
  queueInput(input: Partial<MaraInputState>): void {
    this.queuedInput = {
      ...this.queuedInput,
      ...input,
      moveDirection: input.moveDirection
        ? { ...input.moveDirection }
        : { ...this.queuedInput.moveDirection },
    };
  }

  /**
   * Direct helper for UI button or key Q to launch an acoustic decoy immediately.
   */
  triggerDecoy(targetCoord?: GridCoord): SoundEvent | null {
    if (this.status !== 'playing' || this.mara.decoysRemaining <= 0) return null;

    const result = updateMaraState(
      this.mara,
      {
        moveDirection: { row: 0, col: 0 },
        sprinting: false,
        crouching: true,
        emitDecoy: true,
        decoyTarget: targetCoord,
      },
      this.tickCount + 1,
      { graph: this.graph }
    );

    if (!result.decoySound) return null;
    // Only the decoy count changes: throwing must not alter posture, stamina or noise.
    this.mara.decoysRemaining = result.mara.decoysRemaining;
    this.registerDecoy(result.decoySound);
    this.pushLog(
      'gameplay',
      `Mara launched acoustic decoy at (${result.decoySound.position.row},${result.decoySound.position.col}) [remaining=${this.mara.decoysRemaining}]`
    );
    return result.decoySound;
  }

  /**
   * Direct helper for UI button or key E to place a barricade that blocks the graph cell.
   */
  placeBarricade(targetCoord?: GridCoord): boolean {
    if (this.status !== 'playing' || this.mara.barricadesRemaining <= 0) return false;

    const occupied = this.livingAgentPositions();
    const protectedCells = [this.refugePosition, this.extractionPosition];
    const cell = selectBarricadePlacementCell(
      this.mara.position,
      this.mara.facing,
      this.graph,
      occupied,
      protectedCells,
      targetCoord
    );

    if (!cell) return false;

    this.mara.barricadesRemaining--;
    this.applyBarricadeToGraph(cell);
    const sound: SoundEvent = {
      id: `sound-barricade-${this.tickCount + 1}`,
      sourceId: 'barricade_place',
      position: { ...cell },
      radius: 5,
      intensity: 0.62,
      timestamp: this.tickCount + 1,
    };
    this.pendingSounds.push(sound);
    this.pushLog(
      'gameplay',
      `Barricade placed at (${cell.row},${cell.col}); graph updated [remaining=${this.mara.barricadesRemaining}]`
    );
    return true;
  }

  /**
   * Injects a custom SoundEvent into the next simulation tick (e.g. scripted door or tests).
   */
  emitSound(sound: Omit<SoundEvent, 'id' | 'timestamp'> & { id?: string }): SoundEvent {
    const full: SoundEvent = {
      id: sound.id ?? `sound-custom-${this.tickCount + 1}-${this.pendingSounds.length}`,
      sourceId: sound.sourceId,
      position: { ...sound.position },
      radius: sound.radius,
      intensity: sound.intensity,
      timestamp: this.tickCount + 1,
    };
    this.pendingSounds.push(full);
    return full;
  }

  /**
   * FPV mode: the browser owns continuous movement and collision and reports the cell
   * Mara stands on. Applied on the next step(); the engine still validates walkability
   * and derives footstep noise from the posture.
   */
  setMaraCell(cell: GridCoord, posture: MaraPosture, facing?: GridCoord): void {
    this.externalControl = true;
    this.pendingExternalMove = {
      cell: { ...cell },
      posture,
      ...(facing ? { facing: { ...facing } } : {}),
    };
  }

  isExternallyControlled(): boolean {
    return this.externalControl;
  }

  /**
   * Fires Mara's weapon. Every shot is a loud SoundEvent that enters local perception and
   * the recursive alert system, so shooting attracts the horde. `hitAgentId` comes from the
   * render raycast; the engine decides damage.
   */
  fire(hitAgentId: string | null): FireResult {
    const none: FireResult = { fired: false, hitAgentId: null, killed: false, sound: null };
    if (this.status !== 'playing' || this.paused) return none;

    const weapon = consumeRound(this.mara.weapon);
    if (!weapon) {
      this.pushLog('gameplay', 'Weapon click: magazine empty (press R to reload)');
      return none;
    }
    this.mara.weapon = weapon;

    const def = getWeaponDefinition(weapon.id);
    const sound = this.emitSound({
      sourceId: GUNSHOT_SOURCE_ID,
      position: { ...this.mara.position },
      radius: def.soundRadius,
      intensity: def.soundIntensity,
    });

    let hit: string | null = null;
    let killed = false;
    if (hitAgentId && this.applyHit(hitAgentId, def.damage)) {
      hit = hitAgentId;
      killed = this.agentRuntimes.find((a) => a.id === hitAgentId)?.state === 'dead';
    }
    this.pushLog(
      'gameplay',
      `Mara fired ${weapon.id} [ammo=${weapon.ammoInMagazine}/${weapon.ammoReserve}]${hit ? ` and hit ${hit}${killed ? ' (killed)' : ''}` : ''}`
    );
    return { fired: true, hitAgentId: hit, killed, sound };
  }

  reload(): boolean {
    const before = this.mara.weapon;
    if (before.ammoInMagazine >= before.magazineSize || before.ammoReserve <= 0) return false;
    this.mara.weapon = reloadWeapon(before);
    this.pushLog(
      'gameplay',
      `Mara reloaded [ammo=${this.mara.weapon.ammoInMagazine}/${this.mara.weapon.ammoReserve}]`
    );
    return true;
  }

  /**
   * Applies damage to an infected agent. Returns false for unknown, dead or non-infected agents.
   * Survivors cannot be damaged. A hit stuns for one tick; health 0 means dead (permanent).
   */
  applyHit(agentId: string, damage: number): boolean {
    const runtime = this.agentRuntimes.find((a) => a.id === agentId);
    if (!runtime || runtime.role === 'radio_survivor' || runtime.state === 'dead') return false;

    runtime.health = Math.max(0, runtime.health - Math.max(0, damage));
    if (runtime.health <= 0) {
      runtime.state = 'dead';
      runtime.currentPath = [];
      runtime.targetPosition = null;
      runtime.goalReason = 'dead';
      this.pushLog('agent', `${agentId} was killed`);
    } else {
      runtime.stunnedUntilTick = this.tickCount + 1;
      runtime.state = 'stunned';
    }
    return true;
  }

  /** Single entry point used by the GameLoop for every browser command. */
  applyCommand(command: GameCommand): void {
    switch (command.type) {
      case 'moveToCell':
        this.setMaraCell(command.cell, command.posture, command.facing);
        break;
      case 'fire':
        this.fire(command.hitAgentId);
        break;
      case 'reload':
        this.reload();
        break;
      case 'decoy':
        this.triggerDecoy(command.target);
        break;
      case 'barricade':
        this.placeBarricade(command.target);
        break;
      case 'interact':
        // Phase 0: pickups are collected by proximity. Front C can require explicit interaction.
        break;
    }
  }

  /**
   * Runs Dijkstra and A* on the live graph (including dynamic barricades) for side-by-side comparison.
   */
  compareAlgorithms(
    start: GridCoord,
    goal: GridCoord
  ): { dijkstra: SearchStats; astar: SearchStats } {
    const dijkstra = runDijkstra(this.graph, start, goal);
    const astar = runAStar(this.graph, start, goal, this.heuristic);
    this.recordSearchMetric('dijkstra', dijkstra);
    this.recordSearchMetric('astar', astar);
    this.pushLog(
      'search',
      `Comparison (${start.row},${start.col})->(${goal.row},${goal.col}): Dijkstra [cost=${dijkstra.totalCost.toFixed(2)}, expanded=${dijkstra.expandedCount}] vs A* (${this.heuristic}) [cost=${astar.totalCost.toFixed(2)}, expanded=${astar.expandedCount}]`
    );
    return { dijkstra, astar };
  }

  /**
   * Advances the simulation by one deterministic tick.
   */
  step(deltaMs = 200): ExtendedWorldSnapshot {
    if (this.paused || this.status !== 'playing') {
      return this.getSnapshot();
    }

    this.tickCount++;
    this.elapsedMs += deltaMs;
    this.activeAlerts = [];

    const tickSounds: SoundEvent[] = [...this.pendingSounds];
    this.pendingSounds = [];

    // 1. Update active acoustic decoys (emit persistent attractant pulses)
    const remainingDecoys: ActiveDecoy[] = [];
    for (const decoy of this.activeDecoys) {
      tickSounds.push({
        id: `${decoy.id}-t${this.tickCount}`,
        sourceId: decoy.id,
        position: { ...decoy.position },
        radius: decoy.radius,
        intensity: decoy.intensity,
        timestamp: this.tickCount,
      });
      if (decoy.remainingTicks > 1) {
        remainingDecoys.push({
          ...decoy,
          remainingTicks: decoy.remainingTicks - 1,
        });
      }
    }
    this.activeDecoys = remainingDecoys;

    // 2. Apply Mara's queued discrete input
    const input = this.queuedInput;
    this.queuedInput = { ...DEFAULT_MARA_INPUT };

    if (this.externalControl) {
      const move: ExternalMaraMove = this.pendingExternalMove ?? {
        cell: { ...this.mara.position },
        posture: this.mara.posture,
      };
      this.pendingExternalMove = null;
      input.moveDirection = { row: 0, col: 0 };
      const external = applyExternalMaraMove(this.mara, move, this.tickCount, this.graph);
      this.mara = external.mara;
      if (external.emittedSound) tickSounds.push(external.emittedSound);
    }

    const maraResult = this.externalControl
      ? {
          mara: this.mara,
          emittedSound: null,
          decoySound: null,
          placedBarricade: null,
          barricadeSound: null,
        }
      : updateMaraState(this.mara, input, this.tickCount, {
          graph: this.graph,
          occupiedByAgents: this.livingAgentPositions(),
          protectedCells: [this.refugePosition, this.extractionPosition],
        });
    this.mara = maraResult.mara;

    if (maraResult.emittedSound) {
      tickSounds.push(maraResult.emittedSound);
    }
    if (maraResult.decoySound) {
      this.registerDecoy(maraResult.decoySound);
      tickSounds.push(maraResult.decoySound);
      this.pushLog(
        'gameplay',
        `Mara threw acoustic decoy at (${maraResult.decoySound.position.row},${maraResult.decoySound.position.col})`
      );
    }
    if (maraResult.placedBarricade) {
      this.applyBarricadeToGraph(maraResult.placedBarricade);
      if (maraResult.barricadeSound) tickSounds.push(maraResult.barricadeSound);
      this.pushLog(
        'gameplay',
        `Mara built barricade at (${maraResult.placedBarricade.row},${maraResult.placedBarricade.col})`
      );
    }

    // 3. Evaluate pickups, pharmacy door noise, radio installation, and scene progression
    this.processGameplayTriggers(tickSounds);
    this.lastTickSounds = tickSounds;

    // 4. Compute distributed flanking slots for infected agents converging on shared foci
    const preset = getScenePreset(this.sceneId);
    const flankingSlots = preset.hordeFlankingEnabled
      ? this.computeHordeFlankingAssignments(tickSounds)
      : new Map<string, GridCoord>();

    // 5. Execute each agent's local Perception -> Memory -> Decision -> Planning -> Execution -> Evaluation cycle
    const pendingBroadcasts: Array<{ originId: string; target: GridCoord }> = [];
    const currentSnapshotsForAlerts: AgentSnapshot[] = this.agentRuntimes
      .filter((r) => r.state !== 'dead')
      .map((r) => toAgentSnapshot(r));

    for (const runtime of this.agentRuntimes) {
      if (runtime.state === 'dead') continue;
      const profile = AGENT_PROFILES[runtime.role];

      // Strictly local LOS check performed by environment; AgentBrain never sees Mara directly.
      let visualTarget: GridCoord | null = null;
      let nearbyThreatForSurvivor: GridCoord | null = null;

      if (runtime.role === 'radio_survivor') {
        nearbyThreatForSurvivor = this.findNearestInfectedNearRefuge(profile.visionRange);
      } else {
        const seesMara = hasLineOfSight(
          this.graph,
          runtime.position,
          this.mara.position,
          profile.visionRange,
          this.opaqueCells
        );
        if (seesMara) {
          visualTarget = { ...this.mara.position };
        }
      }

      const receivedAlert = this.pendingAlerts.get(runtime.id) ?? null;
      this.pendingAlerts.delete(runtime.id);

      const perception = buildLocalPerception(
        runtime.position,
        visualTarget,
        tickSounds,
        receivedAlert,
        profile.minAudibleIntensity
      );

      const cycle = this.brain.executeCycle({
        runtime,
        perception,
        graph: this.graph,
        algorithm: this.algorithm,
        heuristic: this.heuristic,
        tick: this.tickCount,
        rng: this.rng,
        assignedFocusSlot: flankingSlots.get(runtime.id) ?? null,
        nearbyThreatForSurvivor,
      });

      if (cycle.searchExecuted) {
        this.recordSearchMetric(this.algorithm, cycle.searchExecuted);
      }

      if (cycle.planChanged && cycle.planChangeReason) {
        this.pushLog('agent', cycle.planChangeReason);
      }

      if (cycle.shouldBroadcastAlert && cycle.alertTarget) {
        pendingBroadcasts.push({
          originId: runtime.id,
          target: cycle.alertTarget,
        });
      }
    }

    // 6. Propagate bounded recursive alerts for all triggers this tick
    for (const broadcast of pendingBroadcasts) {
      const alertResult = triggerHordeSpread(broadcast.originId, currentSnapshotsForAlerts, {
        coordinationEnabled: this.coordinationEnabled,
        maxRadius: this.alertRadius,
        maxDepth: this.alertMaxDepth,
      });

      this.activeAlerts.push(alertResult);

      if (alertResult.hops.length > 0) {
        for (const hop of alertResult.hops) {
          const existing = this.pendingAlerts.get(hop.toAgentId);
          if (!existing || hop.signalStrength > existing.signalStrength) {
            this.pendingAlerts.set(hop.toAgentId, {
              originAgentId: alertResult.originAgentId,
              fromAgentId: hop.fromAgentId,
              position: { ...broadcast.target },
              signalStrength: hop.signalStrength,
              depth: hop.depth,
              receivedTick: this.tickCount,
            });
          }
        }
        this.pushLog(
          'alert',
          `Recursive alert from ${alertResult.originAgentId}: reached=${alertResult.reachedAgentIds.length}, hops=${alertResult.hops.length}, maxDepth=${alertResult.maxDepth}, maxStack=${alertResult.maxStackDepth}, calls=${alertResult.recursiveCalls}`
        );
      }
    }

    // 7. Resolve melee contact, refuge damage, and win/loss conditions
    this.resolveCombatAndEndConditions();

    return this.getSnapshot();
  }

  private initializeScene(sceneId: SceneId, seed: number): void {
    this.sceneId = sceneId;
    this.seed = seed;
    this.rng = new SeededRng(seed);
    this.graph = new WeightedGraph(this.map, {
      allowDiagonal: this.options.allowDiagonal ?? true,
      preventCornerCutting: true,
    });

    this.tickCount = 0;
    this.elapsedMs = 0;
    this.paused = false;
    this.status = 'playing';
    this.defeatReason = 'none';
    this.pendingAlerts.clear();
    this.queuedInput = { ...DEFAULT_MARA_INPUT };
    this.pendingExternalMove = null;
    this.pendingSounds = [];
    this.activeDecoys = [];
    this.barricades = [];
    this.activeAlerts = [];
    this.lastTickSounds = [];
    this.logs = [];
    this.refugeIntegrity = 100;
    this.radioActivated = sceneId === 5;
    this.radioInstallProgress = sceneId === 5 ? 100 : 0;
    this.extractionOpen = sceneId === 5;
    this.pharmacyDoorTriggered = sceneId >= 3;
    this.algorithmComparison = {
      dijkstra: createMetricBucket(),
      astar: createMetricBucket(),
    };

    const preset = getScenePreset(sceneId);
    const scaledWindow = Math.max(
      preset.extractionWindowTicks,
      Math.round((this.map.width + this.map.height) * 1.5)
    );
    this.extractionTicksRemaining = sceneId === 5 ? scaledWindow : null;

    const layout = buildSceneLayout(
      this.map,
      this.graph,
      sceneId,
      this.rng,
      this.options.customAgents
    );
    this.refugePosition = layout.refugePosition;
    this.pharmacyPosition = layout.pharmacyPosition;
    this.extractionPosition = layout.extractionPosition;
    this.pickups = layout.pickups;

    this.mara = createInitialMaraSnapshot(this.map.spawnMara, {
      hasMedicalKit: sceneId >= 3,
      hasFuel: sceneId >= 4,
      hasBattery: sceneId >= 4,
      decoysRemaining: this.options.initialDecoys ?? 3,
      barricadesRemaining: this.options.initialBarricades ?? 3,
    });

    this.agentRuntimes = layout.agents.map((spawn) =>
      createAgentRuntime(
        spawn.id,
        spawn.role,
        spawn.position,
        spawn.patrolWaypoints ?? [],
        this.algorithm,
        this.heuristic
      )
    );

    this.pushLog(
      'system',
      `Initialized Scene ${sceneId} (${preset.name}) on ${this.map.id} [seed=${this.seed}, algo=${this.algorithm}/${this.heuristic}, coord=${this.coordinationEnabled}]`
    );
  }

  private registerDecoy(sound: SoundEvent): void {
    this.activeDecoys.push({
      id: sound.sourceId,
      position: { ...sound.position },
      remainingTicks: 4,
      radius: sound.radius,
      intensity: sound.intensity,
    });
  }

  private applyBarricadeToGraph(cell: GridCoord): void {
    this.graph.setBlocked(cell, true);
    if (!this.barricades.some((b) => sameCoord(b, cell))) {
      this.barricades.push({ ...cell });
    }
  }

  private processGameplayTriggers(tickSounds: SoundEvent[]): void {
    // Scene 1 -> Scene 2 when approaching the pharmacy sector
    if (
      this.sceneId === 1 &&
      gridDistance(this.mara.position, this.pharmacyPosition) <= 2.5
    ) {
      this.transitionToScene(2, 'Mara reached the pharmacy perimeter');
    }

    // Collect supplies when stepping onto pickup coordinates
    for (const pickup of this.pickups) {
      if (pickup.collected) continue;
      const reach = this.externalControl ? 1 : 0;
      const dRow = Math.abs(this.mara.position.row - pickup.position.row);
      const dCol = Math.abs(this.mara.position.col - pickup.position.col);
      if (Math.max(dRow, dCol) <= reach) {
        pickup.collected = true;
        if (pickup.kind === 'medicine') {
          this.mara.hasMedicalKit = true;
          if (!this.pharmacyDoorTriggered) {
            this.pharmacyDoorTriggered = true;
            const doorSound: SoundEvent = {
              id: `sound-pharmacy-door-${this.tickCount}`,
              sourceId: 'pharmacy_metal_door',
              position: { ...pickup.position },
              radius: 10,
              intensity: 0.95,
              timestamp: this.tickCount,
            };
            tickSounds.push(doorSound);
            this.pushLog(
              'gameplay',
              `Medicine collected at pharmacy (${pickup.position.row},${pickup.position.col}); rusted metal door slammed loudly`
            );
          }
          if (this.sceneId < 3) {
            this.transitionToScene(3, 'Medicine secured; horde alerted across the district');
          }
        } else if (pickup.kind === 'fuel') {
          this.mara.hasFuel = true;
          this.pushLog('gameplay', `Fuel collected at (${pickup.position.row},${pickup.position.col})`);
        } else if (pickup.kind === 'battery') {
          this.mara.hasBattery = true;
          this.pushLog('gameplay', `Battery collected at (${pickup.position.row},${pickup.position.col})`);
        }
      }
    }

    // Scene 3 -> Scene 4 once all three supplies are collected
    if (
      this.sceneId === 3 &&
      this.mara.hasMedicalKit &&
      this.mara.hasFuel &&
      this.mara.hasBattery
    ) {
      this.transitionToScene(4, 'All supplies gathered; return to the refuge to install the battery');
    }

    // Scene 4: install battery & activate radio at the refuge
    const allSuppliesReady =
      this.mara.hasMedicalKit && this.mara.hasFuel && this.mara.hasBattery;
    const atRefuge = gridDistance(this.mara.position, this.refugePosition) <= 1.5;

    if (this.sceneId === 4 && allSuppliesReady && atRefuge && !this.radioActivated) {
      this.radioInstallProgress = Math.min(100, this.radioInstallProgress + 25);
      tickSounds.push({
        id: `sound-radio-hum-${this.tickCount}`,
        sourceId: 'refuge_radio_generator',
        position: { ...this.refugePosition },
        radius: 9,
        intensity: 0.8,
        timestamp: this.tickCount,
      });
      this.pushLog('gameplay', `Refuge radio calibration at ${this.radioInstallProgress}%`);

      if (this.radioInstallProgress >= 100) {
        this.radioActivated = true;
        this.extractionOpen = true;
        const preset = getScenePreset(5);
        this.extractionTicksRemaining = Math.max(
          preset.extractionWindowTicks,
          Math.round((this.map.width + this.map.height) * 1.5)
        );
        tickSounds.push({
          id: `sound-radio-signal-${this.tickCount}`,
          sourceId: 'radio_extraction_signal',
          position: { ...this.refugePosition },
          radius: 12,
          intensity: 0.9,
          timestamp: this.tickCount,
        });
        this.transitionToScene(
          5,
          `Radio activated; extraction corridor open for ${this.extractionTicksRemaining} ticks`
        );
      }
    }

    // Scene 5 extraction countdown
    if (this.sceneId === 5 && this.extractionOpen && this.extractionTicksRemaining !== null) {
      if (!sameCoord(this.mara.position, this.extractionPosition)) {
        this.extractionTicksRemaining = Math.max(0, this.extractionTicksRemaining - 1);
      }
    }
  }

  private transitionToScene(nextScene: SceneId, reason: string): void {
    if (this.sceneId === nextScene) return;
    this.sceneId = nextScene;
    const preset = getScenePreset(nextScene);
    this.pushLog('gameplay', `Scene ${nextScene} - ${preset.name}: ${reason}`);
  }

  /**
   * Computes distributed flanking assignments for groups of infected converging on the same focus.
   * Uses only each agent's own memory or active loud sounds (never Mara's global coordinate).
   */
  private computeHordeFlankingAssignments(tickSounds: readonly SoundEvent[]): Map<string, GridCoord> {
    const assignments = new Map<string, GridCoord>();
    const infected = this.agentRuntimes.filter(
      (r) => r.role !== 'radio_survivor' && r.state !== 'stunned' && r.state !== 'dead'
    );
    if (infected.length <= 1) return assignments;

    const activeDecoySound = tickSounds.find((s) => s.sourceId.startsWith('decoy')) ?? null;

    // Group converging agents by approximate focus cluster (within 2 cells).
    const clusters: Array<{ focus: GridCoord; members: AgentSnapshot[] }> = [];

    for (const runtime of infected) {
      const mem = runtime.memoryStore.getSnapshot();
      let candidateFocus: GridCoord | null = mem ? mem.position : null;

      if (
        activeDecoySound &&
        gridDistance(runtime.position, activeDecoySound.position) <= activeDecoySound.radius
      ) {
        candidateFocus = activeDecoySound.position;
      }

      if (!candidateFocus) continue;

      const snapshot = toAgentSnapshot(runtime);
      const existingCluster = clusters.find(
        (cluster) => gridDistance(cluster.focus, candidateFocus) <= 2
      );
      if (existingCluster) {
        existingCluster.members.push(snapshot);
      } else {
        clusters.push({
          focus: { ...candidateFocus },
          members: [snapshot],
        });
      }
    }

    for (const cluster of clusters) {
      if (cluster.members.length < 2) continue;
      const spread = assignDistributedTargets(this.graph, cluster.focus, cluster.members, 3);
      for (const [agentId, slot] of spread.entries()) {
        assignments.set(agentId, slot);
      }
    }

    return assignments;
  }

  private findNearestInfectedNearRefuge(radius: number): GridCoord | null {
    let best: GridCoord | null = null;
    let bestDist = Infinity;
    for (const runtime of this.agentRuntimes) {
      if (runtime.role === 'radio_survivor' || runtime.state === 'stunned' || runtime.state === 'dead') continue;
      const d = gridDistance(this.refugePosition, runtime.position);
      if (d <= radius && d < bestDist) {
        bestDist = d;
        best = { ...runtime.position };
      }
    }
    return best;
  }

  private resolveCombatAndEndConditions(): void {
    // Check victory first if Mara stepped onto the open extraction point
    if (
      this.radioActivated &&
      this.extractionOpen &&
      this.refugeIntegrity > 0 &&
      this.mara.health > 0 &&
      sameCoord(this.mara.position, this.extractionPosition)
    ) {
      this.mara.reachedExtraction = true;
      this.status = 'victory';
      this.pushLog('gameplay', 'Victory: Mara reached the extraction point while the signal held');
      return;
    }

    for (const runtime of this.agentRuntimes) {
      if (runtime.role === 'radio_survivor' || runtime.state === 'stunned' || runtime.state === 'dead') continue;
      const profile = AGENT_PROFILES[runtime.role];

      if (sameCoord(runtime.position, this.mara.position)) {
        runtime.state = 'attack';
        this.mara.health = Math.max(0, this.mara.health - profile.meleeDamage);
        runtime.stunnedUntilTick = this.tickCount + 1;
        this.pushLog(
          'gameplay',
          `${runtime.id} attacked Mara for ${profile.meleeDamage} damage [health=${this.mara.health}]`
        );
      }

      if (
        (this.sceneId === 4 || this.radioInstallProgress > 0) &&
        gridDistance(runtime.position, this.refugePosition) <= 1
      ) {
        this.refugeIntegrity = Math.max(0, this.refugeIntegrity - 10);
        this.pushLog(
          'gameplay',
          `${runtime.id} damaged refuge defenses [integrity=${this.refugeIntegrity}]`
        );
      }
    }

    if (this.mara.health <= 0) {
      this.status = 'defeat';
      this.defeatReason = 'mara_health';
      this.pushLog('gameplay', 'Defeat: Mara health reached zero');
      return;
    }

    if (this.refugeIntegrity <= 0) {
      this.status = 'defeat';
      this.defeatReason = 'refuge_destroyed';
      this.pushLog('gameplay', 'Defeat: Refuge was overrun and rendered unusable');
      return;
    }

    if (
      this.sceneId === 5 &&
      this.extractionTicksRemaining !== null &&
      this.extractionTicksRemaining <= 0 &&
      !this.mara.reachedExtraction
    ) {
      this.extractionOpen = false;
      this.status = 'defeat';
      this.defeatReason = 'extraction_missed';
      this.pushLog('gameplay', 'Defeat: Temporary extraction window expired');
    }
  }

  private livingAgentPositions(): GridCoord[] {
    return this.agentRuntimes.filter((a) => a.state !== 'dead').map((a) => a.position);
  }

  private recordSearchMetric(algorithm: AlgorithmType, stats: SearchStats): void {
    const bucket = this.algorithmComparison[algorithm];
    bucket.runs++;
    bucket.totalExpandedNodes += stats.expandedCount;
    bucket.totalExecutionTimeMs += stats.executionTimeMs;
    bucket.avgExpandedNodes = bucket.totalExpandedNodes / bucket.runs;
    bucket.avgExecutionTimeMs = bucket.totalExecutionTimeMs / bucket.runs;
    bucket.lastCost = stats.totalCost;
  }

  private pushLog(category: TelemetryLogEntry['category'], message: string): void {
    this.logs.push({
      tick: this.tickCount,
      timestampMs: this.elapsedMs,
      category,
      message,
    });
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
  }
}
