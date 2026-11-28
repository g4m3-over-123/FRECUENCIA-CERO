import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CellType, GridCoord, MapDefinition } from '../src/core/contracts.ts';
import { GUNSHOT_SOURCE_ID } from '../src/core/contracts.ts';
import { parseMapDefinition } from '../src/core/graph/mapLoader.ts';
import { WeightedGraph } from '../src/core/graph/WeightedGraph.ts';
import { runAStar } from '../src/core/algorithms/index.ts';
import { SimulationEngine } from '../src/core/gameplay/SimulationEngine.ts';
import {
  createWalkableLookup,
  getGridOrigin,
  gridToWorld,
  worldDirectionToGrid,
  worldToGrid,
} from '../src/core/world/gridSpace.ts';
import { MockWorld } from '../src/dev/mockSnapshot.ts';
import { GameLoop, tickMsForMap } from '../src/game/GameLoop.ts';

/**
 * Phase 0 integration contract: shared grid space, FPV-driven Mara, weapon noise,
 * hits and death, the mock source and the fixed-step loop.
 */

function asciiMap(rows: string[]): MapDefinition {
  const cells: MapDefinition['cells'] = [];
  let spawnMara: GridCoord = { row: 0, col: 0 };
  let extractionPoint: GridCoord = { row: rows.length - 1, col: rows[0].length - 1 };
  rows.forEach((line, row) => {
    [...line].forEach((ch, col) => {
      let type: CellType = 'street';
      if (ch === '#') type = 'building';
      if (ch === 'R') type = 'refuge';
      if (ch === 'P') type = 'pharmacy';
      if (ch === 'E') {
        type = 'extraction';
        extractionPoint = { row, col };
      }
      if (ch === 'S') spawnMara = { row, col };
      const walkable = type !== 'building';
      cells.push({ row, col, type, walkable, cost: walkable ? 1 : 999 });
    });
  });
  return { id: 'fase0', name: 'fase0', width: rows[0].length, height: rows.length, cellSize: 1, spawnMara, extractionPoint, cells };
}

function loadMap(id: string): MapDefinition {
  return parseMapDefinition(JSON.parse(readFileSync(resolve(process.cwd(), `public/maps/${id}.json`), 'utf-8')));
}

// Zombie behind a wall: no line of sight to S, but within gunshot range.
const WALLED = asciiMap([
  'R.............',
  '..............',
  '......#.......',
  '..S...#....P..',
  '......#.......',
  '..............',
  '.............E',
]);

describe('gridSpace', () => {
  const map = loadMap('map_street');

  it('round-trips every cell center through world space', () => {
    for (const cell of map.cells) {
      expect(worldToGrid(gridToWorld(cell, map), map)).toEqual({ row: cell.row, col: cell.col });
    }
  });

  it('centers maps without world alignment on the origin', () => {
    const plain = loadMap('map_medium');
    expect(plain.world).toBeUndefined();
    expect(getGridOrigin(plain)).toEqual({ x: -32, z: -32 });
  });

  it('snaps world directions to the 8 grid directions (col = +X, row = +Z)', () => {
    expect(worldDirectionToGrid(1, 0)).toEqual({ row: 0, col: 1 });
    expect(worldDirectionToGrid(0, -1)).toEqual({ row: -1, col: 0 });
    expect(worldDirectionToGrid(0.7, 0.7)).toEqual({ row: 1, col: 1 });
  });
});

describe('map_street.json', () => {
  const map = loadMap('map_street');

  it('is a valid map aligned with the packaged street asset', () => {
    expect(map.cells).toHaveLength(map.width * map.height);
    expect(map.world?.asset?.url).toBe('/assets/props/street_enhanced.glb');
    expect(existsSync(resolve(process.cwd(), 'public', map.world!.asset!.url.slice(1)))).toBe(true);
    expect(map.world?.asset?.offset).toHaveLength(3);
    for (const type of ['refuge', 'pharmacy', 'extraction'] as const) {
      expect(map.cells.some((c) => c.type === type && c.walkable)).toBe(true);
    }
  });

  it('connects spawn, pharmacy, refuge and extraction', () => {
    const graph = new WeightedGraph(map);
    const of = (type: string): GridCoord => map.cells.find((c) => c.type === type)!;
    for (const goal of [map.extractionPoint, of('pharmacy'), of('refuge')]) {
      expect(runAStar(graph, map.spawnMara, goal, 'octile').found).toBe(true);
    }
  });

  it('runs the real engine headless on it', () => {
    const engine = new SimulationEngine(map, 1, { seed: 3 });
    for (let i = 0; i < 30; i++) engine.step(385);
    expect(engine.getSnapshot().status).toBe('playing');
  });
});

describe('SimulationEngine FPV mode', () => {
  it('moves Mara to the reported cell and derives noise from posture', () => {
    const engine = new SimulationEngine(WALLED, 1, { seed: 1, customAgents: [] });
    engine.setMaraCell({ row: 3, col: 3 }, 'walk');
    let snap = engine.step();
    expect(snap.mara.position).toEqual({ row: 3, col: 3 });
    expect(snap.soundEvents.some((s) => s.sourceId === 'mara_step')).toBe(true);

    engine.setMaraCell({ row: 3, col: 4 }, 'stealth');
    snap = engine.step();
    expect(snap.mara.posture).toBe('stealth');
    expect(snap.soundEvents.some((s) => s.sourceId.startsWith('mara_'))).toBe(false);
  });

  it('ignores cells that are not walkable', () => {
    const engine = new SimulationEngine(WALLED, 1, { seed: 1, customAgents: [] });
    engine.setMaraCell({ row: 3, col: 6 }, 'walk');
    expect(engine.step().mara.position).toEqual(WALLED.spawnMara);
  });

  it('a gunshot attracts a zombie that cannot see Mara (no omniscience)', () => {
    const engine = new SimulationEngine(WALLED, 1, {
      seed: 1,
      customAgents: [{ id: 'z1', role: 'explorer', position: { row: 3, col: 9 }, patrolWaypoints: [{ row: 3, col: 9 }] }],
    });
    engine.setMaraCell(WALLED.spawnMara, 'stealth');
    engine.step();
    expect(engine.getSnapshot().agents.find((a) => a.id === 'z1')!.memory).toBeNull();

    const shot = engine.fire(null);
    expect(shot.fired).toBe(true);
    expect(shot.sound?.sourceId).toBe(GUNSHOT_SOURCE_ID);
    const snap = engine.step();
    const zombie = snap.agents.find((a) => a.id === 'z1')!;
    expect(zombie.memory?.source).toBe('sound');
    expect(['investigate', 'pursue']).toContain(zombie.state);
    expect(snap.mara.weapon.ammoInMagazine).toBe(snap.mara.weapon.magazineSize - 1);
  });

  it('hits stun, enough damage kills, and the dead stay dead and silent', () => {
    const engine = new SimulationEngine(WALLED, 1, {
      seed: 1,
      customAgents: [
        { id: 'z1', role: 'explorer', position: { row: 0, col: 8 } },
        { id: 'z2', role: 'pursuer', position: { row: 1, col: 9 } },
      ],
    });
    expect(engine.fire('z1').hitAgentId).toBe('z1');
    expect(engine.getSnapshot().agents.find((a) => a.id === 'z1')!.state).toBe('stunned');
    // Explorer: 70 hp, pistol: 35 damage -> the second hit kills.
    const kill = engine.fire('z1');
    expect(kill.killed).toBe(true);
    expect(engine.fire('z1').hitAgentId).toBeNull();

    const position = engine.getSnapshot().agents.find((a) => a.id === 'z1')!.position;
    for (let i = 0; i < 10; i++) {
      const snap = engine.step();
      const z1 = snap.agents.find((a) => a.id === 'z1')!;
      expect(z1.state).toBe('dead');
      expect(z1.health).toBe(0);
      expect(z1.position).toEqual(position);
      for (const alert of snap.activeAlerts) expect(alert.reachedAgentIds).not.toContain('z1');
    }
    expect(engine.applyHit('z1', 50)).toBe(false);
  });

  it('runs out of ammo, then reloads from the reserve', () => {
    const engine = new SimulationEngine(WALLED, 1, { seed: 1, customAgents: [] });
    const size = engine.getSnapshot().mara.weapon.magazineSize;
    for (let i = 0; i < size; i++) expect(engine.fire(null).fired).toBe(true);
    expect(engine.fire(null).fired).toBe(false);
    expect(engine.reload()).toBe(true);
    expect(engine.getSnapshot().mara.weapon.ammoInMagazine).toBe(size);
  });

  it('throwing a decoy does not change posture', () => {
    const engine = new SimulationEngine(WALLED, 1, { seed: 1, customAgents: [] });
    engine.setMaraCell({ row: 3, col: 2 }, 'walk');
    engine.step();
    engine.applyCommand({ type: 'decoy' });
    expect(engine.getSnapshot().mara.posture).toBe('walk');
    expect(engine.getSnapshot().mara.decoysRemaining).toBe(2);
  });
});

describe('MockWorld (?mock=1)', () => {
  const map = loadMap('map_street');

  it('is deterministic for a seed and cycles through every agent state', () => {
    const a = new MockWorld(map, 5);
    const b = new MockWorld(map, 5);
    const states = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const sa = a.step(385);
      const sb = b.step(385);
      expect(sa.agents.map((x) => x.position)).toEqual(sb.agents.map((x) => x.position));
      for (const agent of sa.agents) states.add(agent.state);
    }
    for (const state of ['patrol', 'investigate', 'pursue', 'attack', 'stunned', 'alert']) {
      expect(states.has(state)).toBe(true);
    }
  });

  it('produces real paths and searches for the X-ray overlay', () => {
    const mock = new MockWorld(map, 5);
    let snap = mock.step(385);
    for (let i = 0; i < 5; i++) snap = mock.step(385);
    expect(snap.agents.some((a) => a.currentPath.length > 1 && (a.lastSearch?.expandedCount ?? 0) > 0)).toBe(true);
  });

  it('honours fire commands', () => {
    const mock = new MockWorld(map, 5);
    const target = mock.getSnapshot().agents.find((a) => a.role === 'explorer')!;
    for (let i = 0; i < 3; i++) mock.applyCommand({ type: 'fire', hitAgentId: target.id });
    expect(mock.getSnapshot().agents.find((a) => a.id === target.id)!.state).toBe('dead');
  });
});

describe('GameLoop', () => {
  it('derives tick length from cell size', () => {
    expect(tickMsForMap({ cellSize: 1 })).toBe(385);
    expect(tickMsForMap({ cellSize: 2 })).toBe(769);
  });

  it('steps at a fixed rate and interpolates between ticks', () => {
    const loop = new GameLoop(new MockWorld(loadMap('map_street'), 1), 100);
    expect(loop.frame(0.5).ticked).toBe(false); // not started
    loop.start();
    const f1 = loop.frame(0.05);
    expect(f1.ticked).toBe(false);
    expect(f1.alpha).toBeCloseTo(0.5);
    const f2 = loop.frame(0.06);
    expect(f2.ticked).toBe(true);
    expect(f2.current.tick).toBe(1);
  });

  it('player collision lookup blocks buildings and out-of-bounds cells', () => {
    const walkable = createWalkableLookup(WALLED);
    expect(walkable({ row: 3, col: 6 })).toBe(false);
    expect(walkable({ row: -1, col: 0 })).toBe(false);
    expect(walkable({ row: 3, col: 3 })).toBe(true);
  });
});
