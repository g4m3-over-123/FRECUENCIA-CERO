import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { triggerHordeSpread } from '../src/core/agents/hordeSpread.ts';
import {
  buildOpaqueCellSet,
  gridDistance,
  hasLineOfSight,
} from '../src/core/agents/perception.ts';
import { runDijkstra } from '../src/core/algorithms/dijkstra.ts';
import type { AgentRole, GridCoord, MaraPosture, SceneId } from '../src/core/contracts.ts';
import {
  SimulationEngine,
  type ExtendedWorldSnapshot,
} from '../src/core/gameplay/SimulationEngine.ts';
import type { AgentSpawnConfig } from '../src/core/gameplay/scenes.ts';
import { parseMapDefinition } from '../src/core/graph/mapLoader.ts';

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
