import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  AgentSnapshot,
  CellType,
  GridCoord,
  MapDefinition,
  SoundEvent,
  WorldSnapshot,
} from '../src/core/contracts.ts';
import { WeightedGraph } from '../src/core/graph/WeightedGraph.ts';
import { runAStar } from '../src/core/algorithms/astar.ts';
import { generateCityMap } from '../src/core/graph/mapGenerator.ts';
import { parseMapDefinition } from '../src/core/graph/mapLoader.ts';
import {
  buildOpaqueCellSet,
  filterAudibleSounds,
  gridDistance,
  hasLineOfSight,
} from '../src/core/agents/perception.ts';
import { AgentMemoryStore, decayMemory } from '../src/core/agents/memory.ts';
import { assignDistributedTargets, triggerHordeSpread } from '../src/core/agents/hordeSpread.ts';
import { AgentBrain } from '../src/core/agents/AgentBrain.ts';
import {
  createInitialMaraSnapshot,
  updateMaraState,
} from '../src/core/gameplay/maraController.ts';
import { SCENE_PRESETS } from '../src/core/gameplay/scenes.ts';
import { SimulationEngine } from '../src/core/gameplay/SimulationEngine.ts';

/**
 * Helper to build deterministic test maps from ASCII rows:
 * '.' street, '#' building, 'R' refuge, 'P' pharmacy, 'E' extraction, 'S' spawn (street).
 */
function buildAsciiMap(rows: string[], id = 'test_map'): MapDefinition {
  const cells: MapDefinition['cells'] = [];
  let spawnMara: GridCoord = { row: 0, col: 0 };
  let extractionPoint: GridCoord = { row: rows.length - 1, col: rows[0].length - 1 };

  rows.forEach((line, row) => {
    [...line].forEach((ch, col) => {
      let type: CellType = 'street';
      let walkable = true;
      let cost = 1;

      if (ch === '#') {
        type = 'building';
        walkable = false;
        cost = 999;
      } else if (ch === 'R') {
        type = 'refuge';
        spawnMara = { row, col };
      } else if (ch === 'P') {
        type = 'pharmacy';
      } else if (ch === 'E') {
        type = 'extraction';
        extractionPoint = { row, col };
      } else if (ch === 'S') {
        type = 'street';
        spawnMara = { row, col };
      }

      cells.push({ row, col, type, walkable, cost });
    });
  });

  return {
    id,
    name: id,
    width: rows[0].length,
    height: rows.length,
    cellSize: 2,
    spawnMara,
    extractionPoint,
    cells,
  };
}

function loadSampleMap(): MapDefinition {
  const path = resolve(process.cwd(), 'public/maps/map_sample.json');
  return parseMapDefinition(JSON.parse(readFileSync(path, 'utf-8')));
}

function moveMaraOneStepToward(engine: SimulationEngine, target: GridCoord, crouching = true): void {
  const snap = engine.getSnapshot();
  const dr = Math.sign(target.row - snap.mara.position.row);
  const dc = Math.sign(target.col - snap.mara.position.col);
  engine.queueInput({
    moveDirection: { row: dr, col: dc },
    crouching,
    sprinting: false,
    emitDecoy: false,
  });
  engine.step();
}

function walkMaraTo(engine: SimulationEngine, target: GridCoord, maxSteps = 40): void {
  for (let i = 0; i < maxSteps; i++) {
    const pos = engine.getSnapshot().mara.position;
    if (pos.row === target.row && pos.col === target.col) return;
    moveMaraOneStepToward(engine, target, true);
  }
}

describe('Local perception (perception.ts)', () => {
  it('checks unobstructed line of sight within vision range and blocks through buildings', () => {
    const map = buildAsciiMap([
      'R....',
      '..#..',
      '....E',
    ]);
    const graph = new WeightedGraph(map);
    const opaque = buildOpaqueCellSet(map);

    expect(hasLineOfSight(graph, { row: 0, col: 0 }, { row: 0, col: 4 }, 5, opaque)).toBe(true);
    expect(hasLineOfSight(graph, { row: 0, col: 0 }, { row: 0, col: 4 }, 3, opaque)).toBe(false);
    // Blocked by '#' at (1,2)
    expect(hasLineOfSight(graph, { row: 1, col: 0 }, { row: 1, col: 4 }, 6, opaque)).toBe(false);
    expect(hasLineOfSight(graph, { row: 0, col: 1 }, { row: 2, col: 3 }, 6, opaque)).toBe(false);
  });

  it('prevents diagonal line of sight through two touching corner walls', () => {
    const map = buildAsciiMap([
      'R#.',
      '#..',
      '..E',
    ]);
    const graph = new WeightedGraph(map);
    const opaque = buildOpaqueCellSet(map);

    expect(hasLineOfSight(graph, { row: 0, col: 0 }, { row: 1, col: 1 }, 4, opaque)).toBe(false);
  });

  it('filters audible sounds by radius and sorts by attenuated intensity descending', () => {
    const events: SoundEvent[] = [
      { id: 'far-quiet', sourceId: 'step', position: { row: 0, col: 9 }, radius: 4, intensity: 0.5, timestamp: 1 },
      { id: 'mid', sourceId: 'door', position: { row: 0, col: 4 }, radius: 8, intensity: 0.7, timestamp: 1 },
      { id: 'close-loud', sourceId: 'decoy', position: { row: 0, col: 2 }, radius: 10, intensity: 1.0, timestamp: 2 },
    ];

    const heard = filterAudibleSounds({ row: 0, col: 0 }, events);
    expect(heard.map((e) => e.id)).toEqual(['close-loud', 'mid']);
  });
});

describe('Agent memory and decay (memory.ts)', () => {
  it('decays confidence linearly and expires entries below threshold', () => {
    const entry = {
      position: { row: 3, col: 4 },
      confidence: 1,
      lastSeenTick: 10,
      source: 'sound' as const,
    };

    const atTick15 = decayMemory(entry, 15, 0.1);
    expect(atTick15).not.toBeNull();
    expect(atTick15?.confidence).toBeCloseTo(0.5, 5);

    const expired = decayMemory(entry, 25, 0.1);
    expect(expired).toBeNull();
  });

  it('records evidence priority, velocity, and blocked cells in AgentMemoryStore', () => {
    const store = new AgentMemoryStore({ decayRate: 0.05, minConfidence: 0.1 });
    expect(store.recordEvidence({ position: { row: 2, col: 2 }, confidence: 1, lastSeenTick: 1, source: 'vision' })).toBe(true);
    expect(store.recordEvidence({ position: { row: 2, col: 3 }, confidence: 1, lastSeenTick: 2, source: 'vision' })).toBe(true);

    expect(store.getEstimatedVelocity()).toEqual({ row: 0, col: 1 });

    // Stale vision can be overridden by a fresh loud sound decoy later on
    store.tick(6);
    const switched = store.recordEvidence(
      { position: { row: 7, col: 7 }, confidence: 0.95, lastSeenTick: 6, source: 'sound' },
      true
    );
    expect(switched).toBe(true);
    expect(store.getSnapshot()?.position).toEqual({ row: 7, col: 7 });

    store.recordBlockedCell({ row: 4, col: 4 }, 6);
    expect(store.getKnownBlockedCells()).toEqual([{ row: 4, col: 4 }]);
  });
});

describe('Horde spread and recursive alerts (hordeSpread.ts)', () => {
  it('distributes distinct flanking cells around a focus so zombies avoid stacking', () => {
    const map = buildAsciiMap([
      'R......',
      '.......',
      '.......',
      '.......',
      '......E',
    ]);
    const graph = new WeightedGraph(map);
    const focus: GridCoord = { row: 2, col: 3 };
    const agents: AgentSnapshot[] = [
      { id: 'z1', role: 'pursuer', state: 'pursue', position: { row: 2, col: 1 }, targetPosition: null, alertDepth: 0, memory: null, health: 100 },
      { id: 'z2', role: 'pursuer', state: 'pursue', position: { row: 0, col: 3 }, targetPosition: null, alertDepth: 0, memory: null, health: 100 },
      { id: 'z3', role: 'explorer', state: 'alert', position: { row: 4, col: 3 }, targetPosition: null, alertDepth: 1, memory: null, health: 100 },
      { id: 'z4', role: 'explorer', state: 'alert', position: { row: 2, col: 6 }, targetPosition: null, alertDepth: 1, memory: null, health: 100 },
    ];

    const assigned = assignDistributedTargets(graph, focus, agents, 3);
    expect(assigned.size).toBe(4);

    const uniqueKeys = new Set(Array.from(assigned.values()).map((c) => `${c.row},${c.col}`));
    expect(uniqueKeys.size).toBe(4);

    for (const target of assigned.values()) {
      expect(graph.isWalkable(target)).toBe(true);
      expect(gridDistance(target, focus)).toBeLessThanOrEqual(4.5);
    }
  });

  it('propagates recursive alerts among infected only and stops when coordination is disabled', () => {
    const agents: AgentSnapshot[] = [
      { id: 'exp-1', role: 'explorer', state: 'alert', position: { row: 0, col: 0 }, targetPosition: null, alertDepth: 0, memory: null, health: 100 },
      { id: 'pur-1', role: 'pursuer', state: 'patrol', position: { row: 0, col: 3 }, targetPosition: null, alertDepth: 0, memory: null, health: 100 },
      { id: 'pur-2', role: 'pursuer', state: 'patrol', position: { row: 0, col: 6 }, targetPosition: null, alertDepth: 0, memory: null, health: 100 },
      { id: 'survivor-radio', role: 'radio_survivor', state: 'idle', position: { row: 0, col: 1 }, targetPosition: null, alertDepth: 0, memory: null, health: 100 },
    ];

    const coordinated = triggerHordeSpread('exp-1', agents, {
      coordinationEnabled: true,
      maxRadius: 4,
      maxDepth: 3,
    });
    expect(coordinated.reachedAgentIds).toEqual(['exp-1', 'pur-1', 'pur-2']);
    expect(coordinated.reachedAgentIds).not.toContain('survivor-radio');
    expect(coordinated.hops).toHaveLength(2);
    expect(coordinated.maxStackDepth).toBeGreaterThanOrEqual(2);

    const isolated = triggerHordeSpread('exp-1', agents, {
      coordinationEnabled: false,
      maxRadius: 4,
      maxDepth: 3,
    });
    expect(isolated.reachedAgentIds).toEqual(['exp-1']);
    expect(isolated.hops).toHaveLength(0);
  });
});

describe('Mara controller (maraController.ts)', () => {
  it('emits zero noise while sneaking and loud SoundEvent while sprinting', () => {
    const map = buildAsciiMap(['R....E']);
    const graph = new WeightedGraph(map);
    const mara = createInitialMaraSnapshot({ row: 0, col: 0 });

    const stealthRes = updateMaraState(
      mara,
      { moveDirection: { row: 0, col: 1 }, sprinting: false, crouching: true, emitDecoy: false },
      1,
      { graph }
    );
    expect(stealthRes.mara.position).toEqual({ row: 0, col: 1 });
    expect(stealthRes.mara.noiseLevel).toBe(0);
    expect(stealthRes.emittedSound).toBeNull();

    const sprintRes = updateMaraState(
      stealthRes.mara,
      { moveDirection: { row: 0, col: 1 }, sprinting: true, crouching: false, emitDecoy: false },
      2,
      { graph }
    );
    expect(sprintRes.mara.position).toEqual({ row: 0, col: 2 });
    expect(sprintRes.mara.stamina).toBeLessThan(stealthRes.mara.stamina);
    expect(sprintRes.emittedSound).not.toBeNull();
    expect(sprintRes.emittedSound?.radius).toBeGreaterThanOrEqual(6);
  });
});

describe('Mandatory acceptance tests (Anti-Omniscience, Decoy, Barricade, Coordination)', () => {
  it('ACCEPTANCE 1 - Anti-omniscience: without noise or line of sight, zombies never know where Mara is', () => {
    // Solid wall separates Mara on row 0 from infected patrolling rows 4-5 and pharmacy on row 5.
    const map = buildAsciiMap([
      'R.........',
      '##########',
      '..........',
      '..........',
      '..........',
      'P........E',
    ]);

    const engine = new SimulationEngine(map, 1, {
      seed: 101,
      coordinationEnabled: true,
      customAgents: [
        {
          id: 'exp-1',
          role: 'explorer',
          position: { row: 4, col: 2 },
          patrolWaypoints: [
            { row: 4, col: 2 },
            { row: 4, col: 7 },
            { row: 5, col: 7 },
          ],
        },
        {
          id: 'pur-1',
          role: 'pursuer',
          position: { row: 5, col: 5 },
          patrolWaypoints: [
            { row: 5, col: 5 },
            { row: 3, col: 5 },
            { row: 3, col: 1 },
          ],
        },
      ],
    });

    // Mara moves silently (crouching) behind the opaque wall for 12 ticks.
    for (let t = 0; t < 12; t++) {
      const colDir = t < 5 ? 1 : -1;
      engine.queueInput({
        moveDirection: { row: 0, col: colDir },
        crouching: true,
        sprinting: false,
        emitDecoy: false,
      });
      const snap = engine.step();

      for (const agent of snap.agents) {
        expect(agent.state).toBe('patrol');
        expect(agent.memory).toBeNull();
        expect(agent.targetPosition).not.toEqual(snap.mara.position);
      }
    }
  });

  it('ACCEPTANCE 2 - Acoustic decoy: launching a decoy makes the horde reconsider and switch target', () => {
    const map = buildAsciiMap([
      'R..........',
      '...........',
      '...........',
      '...........',
      '...........',
      '..........E',
    ]);

    const engine = new SimulationEngine(map, 4, {
      seed: 202,
      coordinationEnabled: true,
      customAgents: [
        {
          id: 'pur-1',
          role: 'pursuer',
          position: { row: 4, col: 5 },
          patrolWaypoints: [{ row: 4, col: 5 }, { row: 4, col: 8 }],
        },
        {
          id: 'exp-1',
          role: 'explorer',
          position: { row: 3, col: 6 },
          patrolWaypoints: [{ row: 3, col: 6 }, { row: 3, col: 9 }],
        },
      ],
    });

    // Initial sound pulls infected toward (1, 1)
    engine.emitSound({
      sourceId: 'initial_noise',
      position: { row: 1, col: 1 },
      radius: 12,
      intensity: 0.9,
    });
    engine.step();

    const beforeDecoy = engine.getSnapshot();
    const purBefore = beforeDecoy.agents.find((a) => a.id === 'pur-1');
    expect(purBefore?.memory?.position).toEqual({ row: 1, col: 1 });

    // Mara launches an acoustic decoy at the far corner (5, 9)
    const decoyTarget: GridCoord = { row: 5, col: 9 };
    const decoyEvent = engine.triggerDecoy(decoyTarget);
    expect(decoyEvent).not.toBeNull();
    expect(engine.getSnapshot().mara.decoysRemaining).toBe(2);

    const distBefore = gridDistance(purBefore!.position, decoyTarget);
    for (let i = 0; i < 3; i++) {
      engine.step();
    }

    const afterDecoy = engine.getSnapshot();
    const purAfter = afterDecoy.agents.find((a) => a.id === 'pur-1')!;
    const expAfter = afterDecoy.agents.find((a) => a.id === 'exp-1')!;

    expect(purAfter.memory?.position).toEqual(decoyTarget);
    expect(expAfter.memory?.position).toEqual(decoyTarget);
    expect(gridDistance(purAfter.position, decoyTarget)).toBeLessThan(distBefore);
    expect(afterDecoy.logs.some((l) => l.message.includes('decoy'))).toBe(true);
  });

  it('ACCEPTANCE 3 - Dynamic barricade: blocking a corridor forces agents to replan an alternate route', () => {
    // Row 1 is the direct corridor; Row 3 is the longer detour corridor.
    const map = buildAsciiMap([
      'R........',
      '.........',
      '.#######.',
      '.........',
      '........E',
    ]);

    const engine = new SimulationEngine(map, 4, {
      seed: 303,
      allowDiagonal: false,
      algorithm: 'astar',
      heuristic: 'manhattan',
      customAgents: [
        {
          id: 'pur-1',
          role: 'pursuer',
          position: { row: 1, col: 7 },
          patrolWaypoints: [{ row: 1, col: 7 }],
        },
      ],
    });

    // Attract pursuer to (1, 0) via sound -> shortest path goes straight along row 1
    engine.emitSound({
      sourceId: 'door_slam',
      position: { row: 1, col: 0 },
      radius: 14,
      intensity: 0.95,
    });
    const tick1 = engine.step();
    const agentBefore = tick1.agents[0];
    expect(agentBefore.currentPath.some((p) => p.row === 1 && p.col === 3)).toBe(true);
    const changesBefore = agentBefore.planChanges;

    // Mara places a barricade blocking the direct corridor at (1, 3) and (0, 3)
    const placed1 = engine.placeBarricade({ row: 1, col: 3 });
    const placed2 = engine.placeBarricade({ row: 0, col: 3 });
    expect(placed1).toBe(true);
    expect(placed2).toBe(true);
    expect(engine.getGraph().isWalkable({ row: 1, col: 3 })).toBe(false);
    expect(engine.getGraph().isWalkable({ row: 0, col: 3 })).toBe(false);

    // On the next tick, Evaluation detects the blocked path and replans around row 3
    const tick2 = engine.step();
    const agentAfter = tick2.agents[0];
    expect(agentAfter.planChanges).toBeGreaterThan(changesBefore);
    expect(agentAfter.knownBlockedCells.some((c) => c.row === 1 && c.col === 3)).toBe(true);
    expect(agentAfter.lastSearch?.found).toBe(true);
    expect(agentAfter.currentPath.some((p) => p.row === 3)).toBe(true);
    expect(agentAfter.currentPath.some((p) => p.row === 1 && p.col === 3)).toBe(false);
  });

  it('ACCEPTANCE 4 - Same seed comparison: isolated vs coordinated agents show observable alert spread', () => {
    // Wall separates Mara on row 0 from the 3-agent chain on row 3 so only local sound triggers exp-1.
    const map = buildAsciiMap([
      'R...............',
      '################',
      '................',
      '................',
      '...............E',
    ]);

    const chainAgents = [
      { id: 'exp-1', role: 'explorer' as const, position: { row: 3, col: 3 }, patrolWaypoints: [{ row: 3, col: 3 }] },
      { id: 'pur-1', role: 'pursuer' as const, position: { row: 3, col: 7 }, patrolWaypoints: [{ row: 3, col: 7 }] },
      { id: 'pur-2', role: 'pursuer' as const, position: { row: 3, col: 11 }, patrolWaypoints: [{ row: 3, col: 11 }] },
    ];

    const isolatedEngine = new SimulationEngine(map, 2, {
      seed: 404,
      coordinationEnabled: false,
      alertRadius: 5,
      alertMaxDepth: 3,
      customAgents: chainAgents,
    });

    const coordinatedEngine = new SimulationEngine(map, 2, {
      seed: 404,
      coordinationEnabled: true,
      alertRadius: 5,
      alertMaxDepth: 3,
      customAgents: chainAgents,
    });

    // Emit sound heard ONLY by exp-1 (radius 2.5 around (3,2))
    const localNoise = {
      sourceId: 'pharmacy_door',
      position: { row: 3, col: 2 },
      radius: 2.5,
      intensity: 0.9,
    };

    isolatedEngine.emitSound(localNoise);
    coordinatedEngine.emitSound(localNoise);

    // Step 2 ticks so propagated alerts are delivered and processed by recipients
    isolatedEngine.step();
    const isoSnap = isolatedEngine.step();

    const coordTick1 = coordinatedEngine.step();
    const coordSnap = coordinatedEngine.step();

    expect(coordTick1.activeAlerts.some((a) => a.hops.length === 2)).toBe(true);

    const isoPur2 = isoSnap.agents.find((a) => a.id === 'pur-2')!;
    const coordPur2 = coordSnap.agents.find((a) => a.id === 'pur-2')!;

    expect(isoPur2.state).toBe('patrol');
    expect(isoPur2.memory).toBeNull();

    expect(coordPur2.state).toBe('alert');
    expect(coordPur2.alertDepth).toBe(2);
    expect(coordPur2.memory?.source).toBe('alert');
    expect(coordPur2.memory?.position).toEqual({ row: 3, col: 2 });
  });
});

describe('5-Scene progression, algorithm switching, and end conditions', () => {
  it('defines the 5 official storyboard scenes from 02_refugio.pdf', () => {
    expect(SCENE_PRESETS).toHaveLength(5);
    expect(SCENE_PRESETS.map((s) => s.name)).toEqual([
      'Ciudad silenciosa',
      'La farmacia',
      'La horda',
      'El refugio',
      'Extraccion',
    ]);
  });

  it('completes the full Scene 1 -> 2 -> 3 -> 4 -> 5 -> Victory loop', () => {
    const map = buildAsciiMap([
      'R..P....',
      '........',
      '........',
      '........',
      '.......E',
    ]);

    const engine = new SimulationEngine(map, 1, {
      seed: 505,
      customAgents: [
        { id: 'survivor-radio', role: 'radio_survivor', position: { row: 0, col: 0 }, patrolWaypoints: [{ row: 0, col: 0 }] },
      ],
    });

    expect(engine.getSnapshot().sceneId).toBe(1);

    // Walk toward pharmacy -> transitions to Scene 2
    walkMaraTo(engine, { row: 0, col: 1 });
    expect(engine.getSnapshot().sceneId).toBe(2);

    // Collect medicine at pharmacy (0,3) -> triggers noisy metal door and transitions to Scene 3
    walkMaraTo(engine, { row: 0, col: 3 });
    const afterPharmacy = engine.getSnapshot();
    expect(afterPharmacy.mara.hasMedicalKit).toBe(true);
    expect(afterPharmacy.sceneId).toBe(3);
    expect(afterPharmacy.soundEvents.some((s) => s.sourceId === 'pharmacy_metal_door')).toBe(true);

    // Collect fuel and battery -> transitions to Scene 4
    const fuelPickup = afterPharmacy.pickups.find((p) => p.kind === 'fuel')!;
    const batteryPickup = afterPharmacy.pickups.find((p) => p.kind === 'battery')!;
    walkMaraTo(engine, fuelPickup.position);
    walkMaraTo(engine, batteryPickup.position);
    const afterSupplies = engine.getSnapshot();
    expect(afterSupplies.mara.hasFuel).toBe(true);
    expect(afterSupplies.mara.hasBattery).toBe(true);
    expect(afterSupplies.sceneId).toBe(4);

    // Return to refuge (0,0) and install battery/activate radio -> transitions to Scene 5
    walkMaraTo(engine, afterSupplies.refugePosition);
    for (let i = 0; i < 4; i++) {
      engine.step();
    }
    const afterRadio = engine.getSnapshot();
    expect(afterRadio.radioActivated).toBe(true);
    expect(afterRadio.extractionOpen).toBe(true);
    expect(afterRadio.sceneId).toBe(5);

    // Reach extraction point (4,7) -> Victory
    walkMaraTo(engine, map.extractionPoint);
    const finalSnap = engine.getSnapshot();
    expect(finalSnap.mara.reachedExtraction).toBe(true);
    expect(finalSnap.status).toBe('victory');
  });

  it('triggers defeat when Mara health drops to 0 or refuge integrity drops to 0', () => {
    const map = buildAsciiMap([
      'R....',
      '.....',
      '....E',
    ]);

    // Case A: Mara health depleted
    const healthEngine = new SimulationEngine(map, 3, {
      seed: 601,
      customAgents: [
        { id: 'pur-1', role: 'pursuer', position: { row: 0, col: 0 }, patrolWaypoints: [{ row: 0, col: 0 }] },
      ],
    });
    for (let i = 0; i < 20 && healthEngine.getSnapshot().status === 'playing'; i++) {
      healthEngine.step();
    }
    expect(healthEngine.getSnapshot().status).toBe('defeat');
    expect(healthEngine.getSnapshot().defeatReason).toBe('mara_health');

    // Case B: Refuge overrun in Scene 4 while Mara is safely separated behind a wall
    const refugeMap = buildAsciiMap([
      'R....',
      '#####',
      '...SE',
    ]);
    const refugeEngine = new SimulationEngine(refugeMap, 4, {
      seed: 602,
      customAgents: [
        { id: 'pur-1', role: 'pursuer', position: { row: 0, col: 0 }, patrolWaypoints: [{ row: 0, col: 0 }] },
      ],
    });
    for (let i = 0; i < 20 && refugeEngine.getSnapshot().status === 'playing'; i++) {
      refugeEngine.step();
    }
    expect(refugeEngine.getSnapshot().status).toBe('defeat');
    expect(refugeEngine.getSnapshot().defeatReason).toBe('refuge_destroyed');

    // Case C: Extraction window expires in Scene 5
    const timeoutEngine = new SimulationEngine(map, 5, {
      seed: 603,
      customAgents: [
        { id: 'survivor-radio', role: 'radio_survivor', position: { row: 0, col: 0 }, patrolWaypoints: [{ row: 0, col: 0 }] },
      ],
    });
    const limit = timeoutEngine.getSnapshot().extractionTicksRemaining ?? 50;
    for (let i = 0; i < limit + 2 && timeoutEngine.getSnapshot().status === 'playing'; i++) {
      timeoutEngine.step();
    }
    expect(timeoutEngine.getSnapshot().status).toBe('defeat');
    expect(timeoutEngine.getSnapshot().defeatReason).toBe('extraction_missed');
  });

  it('supports runtime switching between Dijkstra and A* with equal optimal costs and deterministic seeds', () => {
    const sample = loadSampleMap();
    const engineA = new SimulationEngine(sample, 1, { seed: 777, algorithm: 'dijkstra', heuristic: 'octile' });
    const engineB = new SimulationEngine(sample, 1, { seed: 777, algorithm: 'dijkstra', heuristic: 'octile' });

    const comparison = engineA.compareAlgorithms(sample.spawnMara, sample.extractionPoint);
    expect(comparison.dijkstra.found).toBe(true);
    expect(comparison.astar.found).toBe(true);
    expect(comparison.astar.totalCost).toBeCloseTo(comparison.dijkstra.totalCost, 6);
    expect(comparison.astar.expandedCount).toBeLessThanOrEqual(comparison.dijkstra.expandedCount);

    for (let i = 0; i < 6; i++) {
      engineA.step();
      engineB.step();
    }
    expect(engineA.getSnapshot().agents.map((a) => a.position)).toEqual(
      engineB.getSnapshot().agents.map((a) => a.position)
    );

    engineA.setAlgorithm('astar', 'octile');
    const snap: WorldSnapshot = engineA.step();
    expect(snap.algorithm).toBe('astar');
    expect(engineA.getSnapshot().algorithmComparison.dijkstra.runs).toBeGreaterThan(0);
    expect(engineA.getSnapshot().algorithmComparison.astar.runs).toBeGreaterThan(0);
  });

  it('runs cleanly headless on generated 20x20 and 32x32 city maps and preserves AgentBrain helper', () => {
    const brain = new AgentBrain();
    const basicAgent: AgentSnapshot = {
      id: 'exp-1',
      role: 'explorer',
      state: 'patrol',
      position: { row: 1, col: 1 },
      targetPosition: null,
      alertDepth: 0,
      memory: null,
      health: 100,
    };
    const next = brain.decideNextState(
      basicAgent,
      [{ id: 's1', sourceId: 'step', position: { row: 2, col: 2 }, radius: 5, intensity: 0.7, timestamp: 1 }],
      false
    );
    expect(next.state).toBe('investigate');

    for (const size of [20, 32]) {
      const generated = generateCityMap(size, size, 900 + size);
      const engine = new SimulationEngine(generated, 3, { seed: 900 + size });
      for (let t = 0; t < 5; t++) {
        engine.step();
      }
      const snap = engine.getSnapshot();
      expect(snap.tick).toBe(5);
      expect(snap.agents.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('Act pacing on map_street (pharmacy door and supplies)', () => {
  const street = parseMapDefinition(
    JSON.parse(readFileSync(resolve(__dirname, '../public/maps/map_street.json'), 'utf8'))
  );
  const chebyshev = (a: GridCoord, b: GridCoord): number =>
    Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));

  const walkToPharmacy = (engine: SimulationEngine) => {
    let snap = engine.getSnapshot();
    const path = runAStar(engine.getGraph(), snap.mara.position, snap.pharmacyPosition, 'octile').path;
    for (const cell of path.slice(1)) {
      engine.applyCommand({ type: 'moveToCell', cell, posture: 'stealth' });
      snap = engine.step(200);
      if (snap.mara.hasMedicalKit) break;
    }
    return snap;
  };

  it.each([1337, 7, 42, 99, 2024])('door slam relays an AlertHop and leaves the exit open (seed %i)', (seed) => {
    const engine = new SimulationEngine(street, 1, { seed });
    const snap = walkToPharmacy(engine);
    expect(snap.mara.hasMedicalKit).toBe(true);
    expect(snap.soundEvents.some((s) => s.sourceId === 'pharmacy_metal_door')).toBe(true);
    expect(snap.activeAlerts.reduce((n, a) => n + a.hops.length, 0)).toBeGreaterThan(0);

    const threats = snap.agents
      .filter((a) => a.role !== 'radio_survivor' && a.state !== 'dead')
      .map((a) => a.position);
    const probe = engine.getGraph().clone();
    for (const t of threats) {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const cell = { row: t.row + dr, col: t.col + dc };
          if (probe.isWalkable(cell) && chebyshev(cell, snap.mara.position) > 0) probe.setBlocked(cell, true);
        }
      }
    }
    expect(runAStar(probe, snap.mara.position, street.extractionPoint, 'octile').found).toBe(true);
  });

  it('starting at scene 3 puts fuel and battery far from the refuge and no infected on key points', () => {
    const engine = new SimulationEngine(street, 3, { seed: 1337 });
    const snap = engine.getSnapshot();
    const graph = engine.getGraph();
    const steps = (cell: GridCoord): number => runAStar(graph, snap.refugePosition, cell, 'octile').path.length - 1;
    const fuel = snap.pickups.find((p) => p.kind === 'fuel')!.position;
    const battery = snap.pickups.find((p) => p.kind === 'battery')!.position;
    const farthest = Math.max(...street.cells.filter((c) => c.walkable).map((c) => chebyshev(c, snap.refugePosition)));
    expect(chebyshev(fuel, snap.refugePosition)).toBeGreaterThan(farthest * 0.4);
    expect(steps(battery)).toBeGreaterThanOrEqual(steps(fuel) * 0.8);
    for (const agent of snap.agents.filter((a) => a.role !== 'radio_survivor')) {
      expect(chebyshev(agent.position, snap.refugePosition)).toBeGreaterThanOrEqual(6);
      expect(chebyshev(agent.position, street.extractionPoint)).toBeGreaterThanOrEqual(6);
    }
  });

  it('scene 5 extraction window is tight but covers the refuge-to-exit route', () => {
    const engine = new SimulationEngine(street, 5, { seed: 1337 });
    const snap = engine.getSnapshot();
    const route = runAStar(engine.getGraph(), snap.refugePosition, street.extractionPoint, 'octile');
    const window = snap.extractionTicksRemaining!;
    expect(window).toBe(Math.max(24, Math.round(route.totalCost * 1.4) + 6));
    expect(window).toBeGreaterThan(route.path.length - 1);
    expect(window).toBeLessThan((route.path.length - 1) * 2);
  });
});
