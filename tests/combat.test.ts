import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AgentBrain, createAgentRuntime } from '../src/core/agents/AgentBrain.ts';
import { triggerHordeSpread } from '../src/core/agents/hordeSpread.ts';
import {
  buildLocalPerception,
  buildOpaqueCellSet,
  gridDistance,
  hasLineOfSight,
} from '../src/core/agents/perception.ts';
import { runDijkstra } from '../src/core/algorithms/dijkstra.ts';
import type { AgentRole, CellType, GridCoord, MapDefinition, MaraPosture, SceneId } from '../src/core/contracts.ts';
import {
  SimulationEngine,
  type ExtendedWorldSnapshot,
} from '../src/core/gameplay/SimulationEngine.ts';
import type { AgentSpawnConfig } from '../src/core/gameplay/scenes.ts';
import { WeightedGraph } from '../src/core/graph/WeightedGraph.ts';
import { parseMapDefinition } from '../src/core/graph/mapLoader.ts';
import { SeededRng } from '../src/core/graph/seededRng.ts';
import { WEAPON_ORDER, cancelTimedReload, getWeaponDefinition } from '../src/core/gameplay/weapons.ts';
import { MockWorld } from '../src/dev/mockSnapshot.ts';

const street = parseMapDefinition(JSON.parse(
  readFileSync(new URL('../public/maps/map_street.json', import.meta.url), 'utf8')
));
const tickMs = 385;
const seed = 3;

function cell(row: number, col: number): GridCoord {
  return { row, col };
}

function spawn(id: string, position: GridCoord, role: AgentRole = 'explorer'): AgentSpawnConfig {
  return { id, role, position, patrolWaypoints: [position] };
}

function streetEngine(customAgents: AgentSpawnConfig[] = []): SimulationEngine {
  return new SimulationEngine(street, 1, { seed, customAgents });
}

function move(engine: SimulationEngine, target: GridCoord, posture: MaraPosture = 'stealth') {
  engine.applyCommand({ type: 'moveToCell', cell: target, posture });
  return engine.step(tickMs);
}

function shortestPath(engine: SimulationEngine, from: GridCoord, to: GridCoord): GridCoord[] {
  const result = runDijkstra(engine.getGraph(), from, to);
  expect(result.found, `Route from ${from.row},${from.col} to ${to.row},${to.col}`).toBe(true);
  return result.path;
}

function walk(engine: SimulationEngine, target: GridCoord): ExtendedWorldSnapshot[] {
  const path = shortestPath(engine, engine.getSnapshot().mara.position, target);
  const snapshots: ExtendedWorldSnapshot[] = [];
  for (const next of path.slice(1)) {
    const snapshot = move(engine, next);
    snapshots.push(snapshot);
    if (snapshot.status !== 'playing') break;
    expect(snapshot.mara.position).toEqual(next);
  }
  return snapshots;
}

describe('Combat on the 1 m street grid', () => {
  it('emits scaled footsteps and sprint noise through moveToCell', () => {
    const engine = streetEngine();
    expect(street.cellSize).toBe(1);
    expect(move(engine, cell(10, 6), 'walk').soundEvents).toContainEqual(
      expect.objectContaining({ sourceId: 'mara_step', radius: 5 })
    );
    expect(move(engine, cell(11, 7), 'sprint').soundEvents).toContainEqual(
      expect.objectContaining({ sourceId: 'mara_sprint', radius: 12 })
    );
  });

  it('detects Mara at explorer range and relays evidence beyond the coarse-grid alert radius', () => {
    const scout = spawn('scout', cell(10, 13));
    const receiver = spawn('receiver', cell(10, 24), 'pursuer');
    const engine = streetEngine([scout, receiver]);
    expect(gridDistance(scout.position, street.spawnMara)).toBeGreaterThan(5);
    expect(gridDistance(scout.position, receiver.position)).toBeGreaterThan(7);

    const first = engine.step(tickMs);
    expect(first.agents[0].memory).toMatchObject({ source: 'vision', position: street.spawnMara });
    expect(first.agents[1].memory).toBeNull();
    expect(first.activeAlerts[0].hops).toContainEqual(expect.objectContaining({
      fromAgentId: scout.id,
      toAgentId: receiver.id,
      depth: 1,
    }));
    expect(engine.step(tickMs).agents[1].memory).toMatchObject({
      source: 'alert',
      position: street.spawnMara,
    });
  });

  it('gives pursuers a longer line of sight than explorers on the street grid', () => {
    const observer = cell(17, 33);
    const target = cell(17, 43);
    const engine = streetEngine([spawn('scout', observer), spawn('pursuer', observer, 'pursuer')]);
    const [scout, pursuer] = move(engine, target).agents;
    expect(scout.memory).toBeNull();
    expect(pursuer.memory).toMatchObject({ source: 'vision', position: target });
  });

  it.each([
    { role: 'explorer', damage: 10, cooldown: 5 },
    { role: 'pursuer', damage: 16, cooldown: 4 },
  ] as const)('spaces $role melee hits by $cooldown ticks without stunning it', ({ role, damage, cooldown }) => {
    const engine = streetEngine([spawn('attacker', street.spawnMara, role)]);
    const first = engine.step(tickMs);
    expect(first.agents[0].state).toBe('attack');
    expect(first.mara.health).toBe(100 - damage);

    for (let elapsed = 1; elapsed < cooldown; elapsed++) {
      const waiting = engine.step(tickMs);
      expect(waiting.agents[0].state).toBe('pursue');
      expect(waiting.mara.health).toBe(first.mara.health);
    }

    const nextHit = engine.step(tickMs);
    expect(nextHit.agents[0].state).toBe('attack');
    expect(nextHit.mara.health).toBe(100 - damage * 2);
  });

  it('excludes dead infected as alert recipients, relays and origins', () => {
    const engine = streetEngine([
      spawn('origin', cell(10, 13)),
      spawn('bridge', cell(10, 19)),
      spawn('distant', cell(10, 25)),
    ]);
    const { agents } = engine.getSnapshot();
    const options = { maxRadius: 7 };
    expect(triggerHordeSpread('origin', agents, options).reachedAgentIds)
      .toEqual(['origin', 'bridge', 'distant']);

    expect(engine.applyHit('bridge', 100)).toBe(true);
    const afterKill = engine.getSnapshot().agents;
    expect(triggerHordeSpread('origin', afterKill, options).reachedAgentIds).toEqual(['origin']);
    for (const coordinationEnabled of [true, false]) {
      expect(triggerHordeSpread('bridge', afterKill, { coordinationEnabled }).reachedAgentIds)
        .toEqual([]);
    }
  });

  it('fills the magazine immediately but locks both actions until the reload countdown ends', () => {
    const engine = streetEngine();
    expect(engine.fire(null).fired).toBe(true);
    const before = engine.getSnapshot().mara.weapon;
    expect(engine.reload()).toBe(true);
    const started = engine.getSnapshot();
    const duration = started.reloadTicksRemaining ?? 0;
    expect(duration).toBeGreaterThan(0);
    expect(started.mara.weapon).toMatchObject({
      reloading: true,
      ammoInMagazine: before.magazineSize,
      ammoReserve: before.ammoReserve - 1,
    });

    for (let remaining = duration; remaining > 0; remaining--) {
      expect(engine.fire(null)).toMatchObject({ fired: false, sound: null });
      expect(engine.reload()).toBe(false);
      expect(engine.getSnapshot().mara.weapon).toEqual(started.mara.weapon);
      expect(engine.step(tickMs).reloadTicksRemaining).toBe(remaining - 1);
    }
    expect(engine.getSnapshot().mara.weapon.reloading).toBe(false);
    expect(engine.fire(null).fired).toBe(true);
    expect(engine.getSnapshot().mara.weapon.ammoInMagazine).toBe(before.ammoInMagazine);
  });

  it('uses interact to collect nearby ammo and heals with scavenged medkits', () => {
    const engine = streetEngine([spawn('attacker', street.spawnMara)]);
    const injured = engine.step(tickMs);
    expect(injured.mara.health).toBeLessThan(100);
    expect(engine.applyHit('attacker', 100)).toBe(true);
    const ammo = injured.lootPickups!.find((pickup) => pickup.kind === 'ammo')!;
    const medkit = injured.lootPickups!.find((pickup) => pickup.kind === 'medkit')!;
    const approach = shortestPath(engine, injured.mara.position, ammo.position).at(-3)!;

    const nearby = walk(engine, approach).at(-1)!;
    expect(nearby.lootPickups!.find((pickup) => pickup.id === ammo.id)?.collected).toBe(false);
    engine.applyCommand({ type: 'interact' });
    const resupplied = engine.step(tickMs);
    expect(resupplied.lootPickups!.find((pickup) => pickup.id === ammo.id)?.collected).toBe(true);
    expect(resupplied.mara.weapon.ammoReserve).toBe(nearby.mara.weapon.ammoReserve + ammo.amount);

    const healed = walk(engine, medkit.position).at(-1)!;
    expect(healed.lootPickups!.find((pickup) => pickup.id === medkit.id)?.collected).toBe(true);
    expect(healed.mara).toMatchObject({ health: 100, hasMedicalKit: false });
  });
});

describe('Street scene progression', () => {
  it('starts every scene with no agent memory and reachable supplies and loot', () => {
    const scenes: SceneId[] = [1, 2, 3, 4, 5];
    for (const scene of scenes) {
      const engine = new SimulationEngine(street, scene, { seed });
      const snapshot = engine.getSnapshot();
      expect(snapshot.tick).toBe(0);
      expect(snapshot.agents.length).toBeGreaterThan(0);
      expect(snapshot.agents.every((agent) => agent.memory === null)).toBe(true);
      expect(snapshot.pickups.map((pickup) => pickup.kind)).toEqual(['medicine', 'fuel', 'battery']);
      expect(new Set(snapshot.lootPickups!.map((loot) => loot.kind))).toEqual(new Set(['ammo', 'medkit']));
      for (const pickup of [...snapshot.pickups, ...snapshot.lootPickups!]) {
        shortestPath(engine, street.spawnMara, pickup.position);
      }
    }
  });

  it('completes scenes 1 through 5 and reaches extraction along shortest paths', () => {
    // Isolate mission triggers from combat so every move follows the shortest route.
    const engine = streetEngine();
    const initial = engine.getSnapshot();
    const journey = [initial];
    for (const pickup of initial.pickups) {
      journey.push(...walk(engine, pickup.position));
    }
    const supplies = engine.getSnapshot();
    expect(supplies.mara).toMatchObject({ hasMedicalKit: true, hasFuel: true, hasBattery: true });
    expect(supplies.pickups.every((pickup) => pickup.collected)).toBe(true);

    journey.push(...walk(engine, supplies.refugePosition));
    for (let tick = 0; tick < 5 && !engine.getSnapshot().extractionOpen; tick++) {
      journey.push(engine.step(tickMs));
    }
    const stages = journey.map((snapshot) => snapshot.sceneId)
      .filter((scene, index, all) => index === 0 || scene !== all[index - 1]);
    expect(stages).toEqual([1, 2, 3, 4, 5]);
    expect(journey.flatMap((snapshot) => snapshot.soundEvents)).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: 'pharmacy_metal_door', radius: 18 }),
      expect.objectContaining({ sourceId: 'refuge_radio_generator', radius: 16 }),
      expect.objectContaining({ sourceId: 'radio_extraction_signal', radius: 22 }),
    ]));
    expect(engine.getSnapshot()).toMatchObject({ radioActivated: true, extractionOpen: true });

    const extraction = walk(engine, street.extractionPoint);
    expect(extraction.at(-1)).toMatchObject({ status: 'victory', mara: { reachedExtraction: true } });
  });

  it('loses when the extraction timer expires while Mara is still outside the zone', () => {
    const engine = new SimulationEngine(street, 5, { seed, customAgents: [] });
    const route = walk(engine, engine.getSnapshot().refugePosition);
    const remaining = route.at(-1)?.extractionTicksRemaining ?? 0;
    expect(remaining).toBeGreaterThan(1);
    for (let tick = 1; tick < remaining; tick++) engine.step(tickMs);
    expect(engine.getSnapshot()).toMatchObject({ status: 'playing', extractionTicksRemaining: 1 });
    expect(engine.step(tickMs)).toMatchObject({
      status: 'defeat',
      defeatReason: 'extraction_missed',
      extractionOpen: false,
      extractionTicksRemaining: 0,
    });
  });
});

describe('Street agent acceptance', () => {
  it('keeps Mara hidden behind a building and redirects the patrol to an acoustic decoy', () => {
    const hidden = cell(26, 30);
    const zombie = { ...spawn('zombie', cell(26, 38)), patrolWaypoints: [cell(26, 40)] };
    const engine = streetEngine([zombie]);
    // The block at rows 23-29, cols 32-36 sits between Mara and the patrol.
    expect(gridDistance(zombie.position, hidden)).toBeLessThan(9);
    expect(hasLineOfSight(engine.getGraph(), zombie.position, hidden, 9, buildOpaqueCellSet(street))).toBe(false);
    const silent = move(engine, hidden);
    expect(silent.soundEvents).toEqual([]);
    expect(silent.agents[0]).toMatchObject({
      state: 'patrol', memory: null, targetPosition: cell(26, 40),
    });

    const target = cell(23, 30);
    expect(engine.triggerDecoy(target)).toMatchObject({ position: target, radius: 18 });
    const lured = engine.step(tickMs).agents[0];
    expect(lured).toMatchObject({
      state: 'investigate',
      targetPosition: target,
      memory: { source: 'sound', position: target },
    });
  });

  it('keeps a threat behind opaque cells out of the radio survivor\'s visual memory', () => {
    const refuge = cell(30, 31);
    const threat = cell(26, 38); // behind the block north-east of the refuge
    const engine = streetEngine([
      spawn('radio', refuge, 'radio_survivor'),
      spawn('zombie', threat),
    ]);
    expect(gridDistance(refuge, threat)).toBeLessThan(9);
    expect(hasLineOfSight(engine.getGraph(), refuge, threat, 9, buildOpaqueCellSet(street))).toBe(false);
    expect(engine.step(tickMs).agents[0]).toMatchObject({ state: 'idle', memory: null });
  });

  it.each([
    {
      label: 'choke cell',
      mara: cell(6, 22), zombie: cell(8, 26), target: cell(6, 21),
      blocked: cell(6, 23), onPath: true,
    },
    {
      label: 'diagonal corner',
      mara: cell(6, 14), zombie: cell(7, 17), target: cell(6, 12),
      blocked: cell(6, 13), onPath: false,
    },
  ])('replans over an alternate route after a barricade blocks a $label', ({
    mara, zombie, target, blocked, onPath,
  }) => {
    const engine = streetEngine([spawn('zombie', zombie)]);
    const graph = engine.getGraph();
    engine.applyCommand({ type: 'moveToCell', cell: mara, posture: 'stealth' });
    expect(engine.triggerDecoy(target)).not.toBeNull();
    const before = engine.step(tickMs).agents[0];
    const original = runDijkstra(graph, before.position, target);
    expect(before.currentPath).toEqual(original.path);
    expect(before.currentPath.some((position) => gridDistance(position, blocked) === 0)).toBe(onPath);

    expect(engine.placeBarricade(blocked)).toBe(true);
    expect(graph.isWalkable(blocked)).toBe(false);
    const alternate = runDijkstra(graph, before.position, target);
    expect(alternate.found).toBe(true);
    expect(alternate.totalCost).toBeGreaterThan(original.totalCost);

    const snapshot = engine.step(tickMs);
    expect(snapshot.soundEvents).toContainEqual(
      expect.objectContaining({ sourceId: 'barricade_place', position: blocked, radius: 9 })
    );
    const replanned = snapshot.agents[0];
    expect(replanned.knownBlockedCells).toContainEqual(blocked);
    expect(replanned.planChanges).toBeGreaterThan(before.planChanges);
    expect(replanned.lastSearch?.totalCost).toBeCloseTo(alternate.totalCost);
    expect(replanned.position).toEqual(replanned.lastSearch?.path[1]);
    expect(replanned.currentPath.at(-1)).toEqual(target);
  });
});

function fineAsciiMap(rows: string[]): MapDefinition {
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
      } else if (ch === 'P') {
        type = 'pharmacy';
      } else if (ch === 'E') {
        type = 'extraction';
        extractionPoint = { row, col };
      } else if (ch === 'S') {
        spawnMara = { row, col };
      }
      cells.push({ row, col, type, walkable, cost });
    });
  });
  return {
    id: 'scream_test_map',
    name: 'scream_test_map',
    width: rows[0].length,
    height: rows.length,
    cellSize: 1,
    spawnMara,
    extractionPoint,
    cells,
  };
}

describe('Explorer scream behavior', () => {
  it('holds in alert, emits zombie_scream at its own cell, waits stationary, then transitions to pursue', () => {
    const startPos = cell(10, 13);
    const engine = new SimulationEngine(street, 1, {
      seed,
      coordinationEnabled: false,
      customAgents: [spawn('screamer', startPos, 'explorer')],
    });

    const t1 = engine.step(tickMs);
    expect(t1.agents[0]).toMatchObject({
      state: 'alert',
      position: startPos,
      goalReason: 'screaming to alert nearby infected',
    });
    expect(t1.soundEvents.some((s) => s.sourceId === 'zombie_scream')).toBe(false);

    const t2 = engine.step(tickMs);
    expect(t2.soundEvents).toContainEqual(
      expect.objectContaining({
        sourceId: 'zombie_scream',
        position: startPos,
        radius: 16,
        intensity: 0.85,
      })
    );
    expect(t2.agents[0]).toMatchObject({ state: 'alert', position: startPos });

    const t3 = engine.step(tickMs);
    expect(t3.agents[0]).toMatchObject({ state: 'alert', position: startPos });

    const t4 = engine.step(tickMs);
    expect(t4.agents[0].state).toBe('pursue');
    expect(t4.agents[0].position).not.toEqual(startPos);

    // Pursuers do not scream; they pursue and advance immediately.
    const pursuerEngine = new SimulationEngine(street, 1, {
      seed,
      coordinationEnabled: false,
      customAgents: [spawn('rusher', startPos, 'pursuer')],
    });
    const p1 = pursuerEngine.step(tickMs);
    expect(p1.agents[0].state).toBe('pursue');
    expect(p1.agents[0].position).not.toEqual(startPos);
    expect(pursuerEngine.step(tickMs).soundEvents.some((s) => s.sourceId === 'zombie_scream')).toBe(false);
  });

  it('attracts an out-of-LOS zombie locally when coordination is off while preserving alert priority when on', () => {
    const walled = fineAsciiMap([
      'R..........P',
      '.S..........',
      '####........',
      '............',
      '............',
      '...........E',
    ]);
    const screamPos = cell(1, 4);
    const listenerStart = cell(5, 1);

    const isolated = new SimulationEngine(walled, 1, {
      seed,
      coordinationEnabled: false,
      customAgents: [
        spawn('screamer', screamPos, 'explorer'),
        spawn('listener', listenerStart, 'explorer'),
      ],
    });
    expect(
      hasLineOfSight(isolated.getGraph(), listenerStart, walled.spawnMara, 9, buildOpaqueCellSet(walled))
    ).toBe(false);

    const iso1 = isolated.step(tickMs);
    expect(iso1.activeAlerts.flatMap((a) => a.hops)).toHaveLength(0);
    expect(iso1.agents[1]).toMatchObject({ state: 'patrol', memory: null });

    const iso2 = isolated.step(tickMs);
    expect(iso2.soundEvents).toContainEqual(
      expect.objectContaining({
        sourceId: 'zombie_scream',
        position: screamPos,
        radius: 16,
        intensity: 0.85,
      })
    );
    expect(iso2.agents[1].state).toBe('investigate');
    expect(iso2.agents[1].memory).toMatchObject({
      source: 'sound',
      position: screamPos,
    });
    expect(iso2.agents[1].memory?.position).not.toEqual(walled.spawnMara);
    expect(gridDistance(iso2.agents[1].position, screamPos)).toBeLessThan(
      gridDistance(iso1.agents[1].position, screamPos)
    );

    // With coordination enabled, a nearby pursuer within alertRadius prioritizes receivedAlert over zombie_scream.
    const coordinated = new SimulationEngine(walled, 1, {
      seed,
      coordinationEnabled: true,
      customAgents: [
        spawn('screamer', screamPos, 'explorer'),
        spawn('listener', listenerStart, 'pursuer'),
      ],
    });
    const coord1 = coordinated.step(tickMs);
    expect(coord1.activeAlerts[0]?.hops).toContainEqual(
      expect.objectContaining({ fromAgentId: 'screamer', toAgentId: 'listener', depth: 1 })
    );
    const coord2 = coordinated.step(tickMs);
    expect(coord2.agents[1].memory).toMatchObject({
      source: 'alert',
      position: walled.spawnMara,
    });
  });

  it('interrupts scream hold on stun or death and enforces cooldown against scream loops', () => {
    const startPos = cell(10, 13);

    // Stun interrupts the remaining scream hold ticks immediately.
    const stunEngine = new SimulationEngine(street, 1, {
      seed,
      coordinationEnabled: false,
      customAgents: [spawn('exp', startPos, 'explorer')],
    });
    expect(stunEngine.step(tickMs).agents[0].state).toBe('alert');
    expect(stunEngine.fire('exp')).toMatchObject({ fired: true, hitAgentId: 'exp', killed: false });
    expect(stunEngine.step(tickMs).agents[0]).toMatchObject({ state: 'stunned', position: startPos });

    const resumed = stunEngine.step(tickMs);
    expect(resumed.agents[0].state).toBe('pursue');
    expect(resumed.agents[0].position).not.toEqual(startPos);
    expect(stunEngine.step(tickMs).soundEvents.some((s) => s.sourceId === 'zombie_scream')).toBe(false);

    // Death stops any further scream hold or emission permanently.
    const deathEngine = new SimulationEngine(street, 1, {
      seed,
      coordinationEnabled: false,
      customAgents: [spawn('exp', startPos, 'explorer')],
    });
    expect(deathEngine.step(tickMs).agents[0].state).toBe('alert');
    expect(deathEngine.applyHit('exp', 100)).toBe(true);
    expect(deathEngine.step(tickMs).agents[0]).toMatchObject({ state: 'dead', position: startPos });
    const afterDeath = deathEngine.step(tickMs);
    expect(afterDeath.agents[0]).toMatchObject({ state: 'dead', position: startPos });
    expect(afterDeath.soundEvents.some((s) => s.sourceId === 'zombie_scream')).toBe(false);

    // 18-tick cooldown prevents repeated screaming while maintaining continuous line of sight.
    const corridor = fineAsciiMap([
      'R............................P',
      '.S............................',
      '.............................E',
    ]);
    const graph = new WeightedGraph(corridor);
    const brain = new AgentBrain();
    const rng = new SeededRng(seed);
    const runtime = createAgentRuntime('exp-cd', 'explorer', cell(1, 1), [cell(1, 1)], 'astar', 'octile');

    const screamTicks: number[] = [];
    const statesByTick: Record<number, string> = {};
    for (let tick = 1; tick <= 19; tick++) {
      const target = cell(1, runtime.position.col + 5);
      const perception = buildLocalPerception(runtime.position, target, []);
      const cycle = brain.executeCycle({
        runtime,
        perception,
        graph,
        algorithm: 'astar',
        heuristic: 'octile',
        tick,
        rng,
      });
      statesByTick[tick] = cycle.snapshot.state;
      if (cycle.emittedSound?.sourceId === 'zombie_scream') {
        screamTicks.push(tick);
      }
    }

    expect(screamTicks).toEqual([1, 19]);
    expect([statesByTick[1], statesByTick[2], statesByTick[3]]).toEqual(['alert', 'alert', 'alert']);
    for (let tick = 4; tick <= 18; tick++) {
      expect(statesByTick[tick]).toBe('pursue');
    }
    expect(statesByTick[19]).toBe('alert');
  });

  it('lets a co-located zombie hear another explorer scream and cancels alert hold upon melee contact', () => {
    const sharedCell = cell(1, 4);
    const walled = fineAsciiMap([
      'R..........P',
      '.S..........',
      '####........',
      '............',
      '............',
      '...........E',
    ]);
    const colocateGraph = new WeightedGraph(walled);
    const colocateBrain = new AgentBrain();
    const colocateRng = new SeededRng(seed);
    const screamer = createAgentRuntime('screamer', 'explorer', sharedCell, [sharedCell], 'astar', 'octile');
    const teammate = createAgentRuntime('teammate', 'explorer', sharedCell, [sharedCell], 'astar', 'octile');
    const sharedScream = {
      id: 'sound-zombie_scream-screamer-2',
      sourceId: 'zombie_scream',
      position: sharedCell,
      radius: 16,
      intensity: 0.85,
      timestamp: 2,
    };
    const screamerCycle = colocateBrain.executeCycle({
      runtime: screamer,
      perception: buildLocalPerception(sharedCell, null, [sharedScream]),
      graph: colocateGraph,
      algorithm: 'astar',
      heuristic: 'octile',
      tick: 2,
      rng: colocateRng,
    });
    expect(screamer.memoryStore.getHistory()).toHaveLength(0);
    expect(screamerCycle.snapshot.state).toBe('patrol');
    const teammateCycle = colocateBrain.executeCycle({
      runtime: teammate,
      perception: buildLocalPerception(sharedCell, null, [sharedScream]),
      graph: colocateGraph,
      algorithm: 'astar',
      heuristic: 'octile',
      tick: 2,
      rng: colocateRng,
    });
    expect(teammate.memoryStore.getHistory()).toContainEqual(
      expect.objectContaining({ source: 'sound', position: sharedCell })
    );
    expect(teammateCycle.snapshot.goalReason).toBe('target site cleared; resuming local patrol');

    // Overlapping hyphenated emitter IDs must not match listener prefix ("screamer" vs "screamer-rear").
    const rearPos = cell(1, 7);
    const rearScream = {
      id: 'sound-zombie_scream-screamer-rear-2',
      sourceId: 'zombie_scream',
      position: rearPos,
      radius: 16,
      intensity: 0.85,
      timestamp: 2,
    };
    const weakerCue = {
      id: 'sound-step-2',
      sourceId: 'step',
      position: cell(1, 0),
      radius: 6,
      intensity: 0.3,
      timestamp: 2,
    };
    const overlapListener = createAgentRuntime('screamer', 'explorer', sharedCell, [sharedCell], 'astar', 'octile');
    const overlapCycle = colocateBrain.executeCycle({
      runtime: overlapListener,
      perception: buildLocalPerception(sharedCell, null, [rearScream, weakerCue]),
      graph: colocateGraph,
      algorithm: 'astar',
      heuristic: 'octile',
      tick: 2,
      rng: colocateRng,
    });
    expect(overlapCycle.snapshot.memory).toMatchObject({ source: 'sound', position: rearPos });

    // Entering melee contact during an active scream hold cancels the hold and keeps combat state coherent.
    const startPos = cell(10, 13);
    const meleeEngine = new SimulationEngine(street, 1, {
      seed,
      coordinationEnabled: false,
      customAgents: [spawn('exp', startPos, 'explorer')],
    });
    const m1 = meleeEngine.step(tickMs);
    expect(m1.agents[0]).toMatchObject({
      state: 'alert',
      goalReason: 'screaming to alert nearby infected',
    });

    const m2 = move(meleeEngine, startPos, 'stealth');
    expect(m2.agents[0].state).toBe('attack');
    expect(m2.agents[0].goalReason).not.toBe('screaming to alert nearby infected');

    const m3 = move(meleeEngine, cell(10, 11), 'stealth');
    expect(m3.agents[0].state).toBe('pursue');
  });
});

describe('Multi-weapon arsenal', () => {
  it('supports switching across all 6 unlocked weapons with independent ammo inventories', () => {
    expect(WEAPON_ORDER).toEqual(['pistol', 'm4', 'persuader', 'dual_mac10', 'sawnoff', 'dual_sawnoffs']);
    const engine = streetEngine();

    for (const id of WEAPON_ORDER) {
      const def = getWeaponDefinition(id);
      engine.applyCommand({ type: 'switchWeapon', weaponId: id });
      const active = engine.getSnapshot().mara.weapon;
      expect(active.id).toBe(id);
      expect(active.magazineSize).toBe(def.magazineSize);
      expect(active.ammoInMagazine).toBe(def.magazineSize);
      expect(active.ammoReserve).toBe(def.initialReserve);
      expect(def.fireAudioCue).toBeTruthy();
      expect(def.reloadAudioCue).toBeTruthy();
    }

    // Fire 3 rounds with M4, switch to Dual MAC-10 and fire 2, then verify M4 preserved its counts.
    engine.applyCommand({ type: 'switchWeapon', weaponId: 'm4' });
    expect(engine.fire(null).fired).toBe(true);
    expect(engine.fire(null).fired).toBe(true);
    expect(engine.fire(null).fired).toBe(true);
    expect(engine.getSnapshot().mara.weapon).toMatchObject({ id: 'm4', ammoInMagazine: 27, ammoReserve: 90 });

    engine.applyCommand({ type: 'switchWeapon', weaponId: 'dual_mac10' });
    expect(engine.fire(null).fired).toBe(true);
    expect(engine.fire(null).fired).toBe(true);
    expect(engine.getSnapshot().mara.weapon).toMatchObject({ id: 'dual_mac10', ammoInMagazine: 30 });

    engine.applyCommand({ type: 'switchWeapon', weaponId: 'm4' });
    expect(engine.getSnapshot().mara.weapon).toMatchObject({ id: 'm4', ammoInMagazine: 27, ammoReserve: 90 });
  });

  it('cancels timed reload cleanly on weapon switch without duplicating ammo or locking weapons', () => {
    const engine = streetEngine();
    engine.applyCommand({ type: 'switchWeapon', weaponId: 'm4' });
    expect(engine.fire(null).fired).toBe(true);
    expect(engine.fire(null).fired).toBe(true);
    expect(engine.getSnapshot().mara.weapon).toMatchObject({ ammoInMagazine: 28, ammoReserve: 90 });

    expect(engine.reload()).toBe(true);
    expect(engine.getSnapshot().mara.weapon.reloading).toBe(true);
    expect(engine.getSnapshot().reloadTicksRemaining).toBe(6);

    // Switch mid-reload to Persuader: Persuader is ready immediately and M4 refunds the 2 pending rounds.
    engine.applyCommand({ type: 'switchWeapon', weaponId: 'persuader' });
    expect(engine.getSnapshot().mara.weapon).toMatchObject({ id: 'persuader', reloading: false });
    expect(engine.getSnapshot().reloadTicksRemaining).toBe(0);
    expect(engine.fire(null).fired).toBe(true);

    engine.applyCommand({ type: 'switchWeapon', weaponId: 'm4' });
    expect(engine.getSnapshot().mara.weapon).toMatchObject({
      id: 'm4',
      ammoInMagazine: 28,
      ammoReserve: 90,
      reloading: false,
    });
    expect(engine.fire(null).fired).toBe(true);

    // Collecting ammo while reloading must not allow a cancelled reload to exceed maxReserve.
    expect(
      cancelTimedReload(
        { id: 'sawnoff', ammoInMagazine: 2, magazineSize: 2, ammoReserve: 32, reloading: true },
        1
      )
    ).toEqual({
      id: 'sawnoff',
      ammoInMagazine: 1,
      magazineSize: 2,
      ammoReserve: 32,
      reloading: false,
    });
    const ammoBoxes = engine.getSnapshot().lootPickups!.filter((l) => l.kind === 'ammo');
    expect(ammoBoxes.length).toBeGreaterThanOrEqual(2);
    engine.applyCommand({ type: 'switchWeapon', weaponId: 'sawnoff' });
    walk(engine, ammoBoxes[0].position);
    expect(engine.getSnapshot().mara.weapon.ammoReserve).toBe(16 + ammoBoxes[0].amount);

    const pathToSecond = shortestPath(
      engine,
      engine.getSnapshot().mara.position,
      ammoBoxes[1].position
    );
    expect(pathToSecond.length).toBeGreaterThanOrEqual(3);
    walk(engine, pathToSecond.at(-3)!);
    const secondBeforeReload = engine
      .getSnapshot()
      .lootPickups!.find((l) => l.id === ammoBoxes[1].id);
    expect(secondBeforeReload?.collected).toBe(false);

    expect(engine.fire(null).fired).toBe(true);
    expect(engine.reload()).toBe(true);
    move(engine, pathToSecond.at(-2)!);

    const pickedDuringReload = engine.getSnapshot();
    const secondAfterPickup = pickedDuringReload.lootPickups!.find(
      (l) => l.id === ammoBoxes[1].id
    );
    expect(secondAfterPickup?.collected).toBe(true);
    expect(pickedDuringReload.mara.weapon.reloading).toBe(true);
    expect(pickedDuringReload.reloadTicksRemaining).toBeGreaterThan(0);
    expect(pickedDuringReload.mara.weapon.ammoInMagazine).toBe(2);
    expect(pickedDuringReload.mara.weapon.ammoReserve).toBe(
      getWeaponDefinition('sawnoff').maxReserve
    );

    engine.applyCommand({ type: 'switchWeapon', weaponId: 'pistol' });
    engine.applyCommand({ type: 'switchWeapon', weaponId: 'sawnoff' });
    const afterSwitchBack = engine.getSnapshot().mara.weapon;
    expect(afterSwitchBack.ammoInMagazine).toBe(1);
    expect(afterSwitchBack.ammoReserve).toBe(getWeaponDefinition('sawnoff').maxReserve);
    expect(afterSwitchBack.reloading).toBe(false);
  });

  it('applies per-weapon damage, sound radii, magazine reload timing, and MockWorld switching', () => {
    // 1. Sawed-Off one-shots a 70-HP explorer and triggers distant zombies; Dual MAC-10 is suppressed.
    const walled = fineAsciiMap([
      'R.................P',
      '.S.................',
      '###################',
      '...................E',
    ]);
    // Zombie at (3, 14) is ~13.15 cells from Mara at (1, 1): beyond MAC-10 radius 10, inside Sawed-Off radius 26.
    const silentEngine = new SimulationEngine(walled, 1, {
      seed,
      coordinationEnabled: false,
      customAgents: [spawn('far', cell(3, 14), 'explorer')],
    });
    silentEngine.applyCommand({ type: 'switchWeapon', weaponId: 'dual_mac10' });
    const macShot = silentEngine.fire(null);
    expect(macShot.sound).toMatchObject({ radius: 10, intensity: 0.65 });
    const afterMac = silentEngine.step(tickMs);
    expect(afterMac.agents[0]).toMatchObject({ state: 'patrol', memory: null });

    const loudEngine = new SimulationEngine(walled, 1, {
      seed,
      coordinationEnabled: false,
      customAgents: [
        spawn('far', cell(3, 14), 'explorer'),
        spawn('close', cell(1, 5), 'explorer'),
      ],
    });
    loudEngine.applyCommand({ type: 'switchWeapon', weaponId: 'sawnoff' });
    const sawnShot = loudEngine.fire('close');
    expect(sawnShot.killed).toBe(true);
    expect(sawnShot.sound).toMatchObject({ radius: 26, intensity: 1 });
    const afterSawn = loudEngine.step(tickMs);
    expect(afterSawn.agents[0].memory).toMatchObject({ source: 'sound', position: walled.spawnMara });
    expect(afterSawn.agents[1].state).toBe('dead');

    // 2. M4 finishes its fixed 6-tick magazine reload cleanly.
    const reloadEngine = streetEngine();
    reloadEngine.applyCommand({ type: 'switchWeapon', weaponId: 'm4' });
    for (let i = 0; i < 4; i++) expect(reloadEngine.fire(null).fired).toBe(true);
    expect(reloadEngine.reload()).toBe(true);
    for (let remaining = 6; remaining > 0; remaining--) {
      expect(reloadEngine.fire(null).fired).toBe(false);
      expect(reloadEngine.step(tickMs).reloadTicksRemaining).toBe(remaining - 1);
    }
    expect(reloadEngine.getSnapshot().mara.weapon).toMatchObject({
      id: 'm4',
      ammoInMagazine: 30,
      ammoReserve: 86,
      reloading: false,
    });

    // 3. MockWorld supports switchWeapon and per-weapon damage.
    const mock = new MockWorld(street, 1);
    const victim = mock.getSnapshot().agents.find((a) => a.role === 'explorer')!;
    mock.applyCommand({ type: 'switchWeapon', weaponId: 'sawnoff' });
    expect(mock.getSnapshot().mara.weapon.id).toBe('sawnoff');
    mock.applyCommand({ type: 'fire', hitAgentId: victim.id });
    expect(mock.getSnapshot().agents.find((a) => a.id === victim.id)!.state).toBe('dead');
  });
});
