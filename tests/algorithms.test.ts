import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentSnapshot, CellType, GridCoord, MapDefinition } from '../src/core/contracts.ts';
import { SeededRng } from '../src/core/graph/seededRng.ts';
import { WeightedGraph } from '../src/core/graph/WeightedGraph.ts';
import { MapValidationError, parseMapDefinition } from '../src/core/graph/mapLoader.ts';
import { generateCityMap } from '../src/core/graph/mapGenerator.ts';
import { BinaryHeap } from '../src/core/algorithms/BinaryHeap.ts';
import { runDijkstra } from '../src/core/algorithms/dijkstra.ts';
import { runAStar } from '../src/core/algorithms/astar.ts';
import { createHeuristic } from '../src/core/algorithms/heuristics.ts';
import { propagateAlertRecursive } from '../src/core/algorithms/alertRecursion.ts';
import { PathCache, findPath, isPathStillValid } from '../src/core/algorithms/index.ts';
import { runTickCostBenchmarks, summarizeTickCost } from '../src/benchmarks/tickCost.ts';

/** Builds a map from ASCII rows: '.' street, '#' building, '~' cost 5, 'S' spawn, 'E' extraction. */
function asciiMap(rows: string[]): MapDefinition {
  const cells: MapDefinition['cells'] = [];
  let spawn: GridCoord = { row: 0, col: 0 };
  let exit: GridCoord = { row: 0, col: 0 };
  rows.forEach((line, row) => {
    [...line].forEach((ch, col) => {
      let type: CellType = 'street';
      let cost = 1;
      let walkable = true;
      if (ch === '#') {
        type = 'building';
        cost = 999;
        walkable = false;
      } else if (ch === '~') {
        cost = 5;
      } else if (ch === 'S') {
        type = 'refuge';
        spawn = { row, col };
      } else if (ch === 'E') {
        type = 'extraction';
        exit = { row, col };
      }
      cells.push({ row, col, type, walkable, cost });
    });
  });
  return {
    id: 'ascii',
    name: 'ascii',
    width: rows[0].length,
    height: rows.length,
    cellSize: 1,
    spawnMara: spawn,
    extractionPoint: exit,
    cells,
  };
}

function loadSample(): MapDefinition {
  const raw = JSON.parse(readFileSync(resolve(process.cwd(), 'public/maps/map_sample.json'), 'utf-8'));
  return parseMapDefinition(raw);
}

function pathCost(graph: WeightedGraph, path: GridCoord[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const edge = graph.getNeighbors(path[i - 1]).find((e) => e.to.row === path[i].row && e.to.col === path[i].col);
    if (!edge) throw new Error(`Invalid step ${JSON.stringify(path[i - 1])} -> ${JSON.stringify(path[i])}`);
    total += edge.weight;
  }
  return total;
}

function agent(id: string, row: number, col: number): AgentSnapshot {
  return { id, role: 'explorer', state: 'patrol', position: { row, col }, targetPosition: null, alertDepth: 0, memory: null, health: 100 };
}

describe('SeededRng', () => {
  it('is deterministic for the same seed and differs across seeds', () => {
    const a = new SeededRng(42);
    const b = new SeededRng(42);
    const c = new SeededRng(43);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    const seqC = Array.from({ length: 20 }, () => c.next());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    expect(seqA.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it('int stays within inclusive bounds', () => {
    const rng = new SeededRng(7);
    for (let i = 0; i < 1000; i++) {
      const v = rng.int(-3, 3);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThanOrEqual(3);
    }
  });
});

describe('BinaryHeap', () => {
  it('pops elements in ascending priority order', () => {
    const rng = new SeededRng(1);
    const heap = new BinaryHeap<number>();
    const values = Array.from({ length: 500 }, () => rng.range(0, 1000));
    values.forEach((v) => heap.push(v, v));
    const out: number[] = [];
    while (!heap.isEmpty()) out.push(heap.pop() as number);
    expect(out).toEqual([...values].sort((x, y) => x - y));
    expect(heap.pop()).toBeUndefined();
  });

  it('breaks ties in insertion order', () => {
    const heap = new BinaryHeap<string>();
    heap.push('a', 1);
    heap.push('b', 1);
    heap.push('c', 0);
    heap.push('d', 1);
    expect([heap.pop(), heap.pop(), heap.pop(), heap.pop()]).toEqual(['c', 'a', 'b', 'd']);
  });
});

describe('parseMapDefinition', () => {
  it('accepts the sample map', () => {
    const map = loadSample();
    expect(map.cells).toHaveLength(100);
  });

  it('rejects negative costs, missing cells and blocked spawn', () => {
    const base = asciiMap(['S..', '...', '..E']);
    expect(() => parseMapDefinition({ ...base, cells: base.cells.slice(1) })).toThrow(MapValidationError);
    const negative = { ...base, cells: base.cells.map((c, i) => (i === 4 ? { ...c, cost: -1 } : c)) };
    expect(() => parseMapDefinition(negative)).toThrow(/non-negative/);
    const blocked = { ...base, cells: base.cells.map((c, i) => (i === 0 ? { ...c, walkable: false } : c)) };
    expect(() => parseMapDefinition(blocked)).toThrow(/spawnMara/);
  });
});

describe('WeightedGraph', () => {
  it('builds non-negative edges and prevents corner cutting', () => {
    const graph = new WeightedGraph(asciiMap(['S#.', '.#.', '..E']));
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        for (const e of graph.getNeighbors({ row: r, col: c })) expect(e.weight).toBeGreaterThanOrEqual(0);
      }
    }
    // (1,0) -> (0,1) would cut a building corner and (0,1) is a building anyway.
    const fromBottomLeft = graph.getNeighbors({ row: 2, col: 0 }).map((e) => `${e.to.row}:${e.to.col}`);
    expect(fromBottomLeft).toContain('2:1');
    expect(fromBottomLeft).not.toContain('1:1');
  });

  it('updates adjacency when a cell is blocked and unblocked', () => {
    const graph = new WeightedGraph(asciiMap(['S..', '...', '..E']));
    const center = { row: 1, col: 1 };
    expect(graph.getNeighbors({ row: 0, col: 1 }).some((e) => e.to.row === 1 && e.to.col === 1)).toBe(true);
    graph.setBlocked(center, true);
    expect(graph.isWalkable(center)).toBe(false);
    expect(graph.getNeighbors(center)).toHaveLength(0);
    expect(graph.getNeighbors({ row: 0, col: 1 }).some((e) => e.to.row === 1 && e.to.col === 1)).toBe(false);
    graph.setBlocked(center, false);
    expect(graph.getNeighbors({ row: 0, col: 1 }).some((e) => e.to.row === 1 && e.to.col === 1)).toBe(true);
  });

  it('clone is independent from the original', () => {
    const graph = new WeightedGraph(asciiMap(['S..', '...', '..E']));
    const copy = graph.clone();
    copy.setBlocked({ row: 1, col: 1 }, true);
    expect(graph.isWalkable({ row: 1, col: 1 })).toBe(true);
    expect(copy.isWalkable({ row: 1, col: 1 })).toBe(false);
  });
});

describe('Dijkstra and A*', () => {
  it('find the known optimal path on a small weighted map', () => {
    const map = asciiMap(['S~~~E', '.###.', '.....']);
    const graph = new WeightedGraph(map, { allowDiagonal: false });
    const d = runDijkstra(graph, map.spawnMara, map.extractionPoint);
    const a = runAStar(graph, map.spawnMara, map.extractionPoint, 'manhattan');
    // Top row costs 5*3 + 1 = 16; the detour below costs 8.
    expect(d.found).toBe(true);
    expect(d.totalCost).toBeCloseTo(8);
    expect(a.totalCost).toBeCloseTo(8);
    expect(d.path[0]).toEqual(map.spawnMara);
    expect(d.path[d.path.length - 1]).toEqual(map.extractionPoint);
    expect(pathCost(graph, d.path)).toBeCloseTo(d.totalCost);
    expect(pathCost(graph, a.path)).toBeCloseTo(a.totalCost);
  });

  it('return the same optimal cost on many seeded maps (8-way, admissible heuristics)', () => {
    for (const size of [12, 20, 32]) {
      for (let seed = 0; seed < 8; seed++) {
        const map = generateCityMap(size, size, seed * 31 + size);
        const graph = new WeightedGraph(map);
        const rng = new SeededRng(seed);
        for (let k = 0; k < 4; k++) {
          const pick = (): GridCoord => {
            for (;;) {
              const p = { row: rng.int(0, size - 1), col: rng.int(0, size - 1) };
              if (graph.isWalkable(p)) return p;
            }
          };
          const s = k === 0 ? map.spawnMara : pick();
          const g = k === 0 ? map.extractionPoint : pick();
          const d = runDijkstra(graph, s, g);
          for (const h of ['octile', 'euclidean'] as const) {
            const a = runAStar(graph, s, g, h);
            expect(a.found).toBe(d.found);
            expect(a.totalCost).toBeCloseTo(d.totalCost, 6);
            expect(a.expandedCount).toBeLessThanOrEqual(d.expandedCount);
            expect(a.reopenedCount).toBe(0);
            if (a.found) expect(pathCost(graph, a.path)).toBeCloseTo(a.totalCost, 6);
          }
        }
      }
    }
  });

  it('return the same optimal cost on 4-way graphs with manhattan', () => {
    for (let seed = 0; seed < 10; seed++) {
      const map = generateCityMap(24, 24, seed);
      const graph = new WeightedGraph(map, { allowDiagonal: false });
      const d = runDijkstra(graph, map.spawnMara, map.extractionPoint);
      const a = runAStar(graph, map.spawnMara, map.extractionPoint, 'manhattan');
      expect(a.totalCost).toBeCloseTo(d.totalCost, 6);
    }
  });

  it('respect barricades and replan around them', () => {
    const map = asciiMap(['S...E', '.....', '.....']);
    const graph = new WeightedGraph(map);
    const before = runAStar(graph, map.spawnMara, map.extractionPoint);
    expect(before.totalCost).toBeCloseTo(4);
    const barricade = { row: 0, col: 2 };
    graph.setBlocked(barricade, true);
    for (const result of [runDijkstra(graph, map.spawnMara, map.extractionPoint), runAStar(graph, map.spawnMara, map.extractionPoint)]) {
      expect(result.found).toBe(true);
      expect(result.path.some((p) => p.row === barricade.row && p.col === barricade.col)).toBe(false);
      expect(result.totalCost).toBeGreaterThan(before.totalCost);
    }
  });

  it('report not found when the goal is enclosed or blocked', () => {
    const map = asciiMap(['S.#..', '..#.E', '..#..']);
    const graph = new WeightedGraph(map);
    expect(runDijkstra(graph, map.spawnMara, map.extractionPoint).found).toBe(false);
    expect(runAStar(graph, map.spawnMara, map.extractionPoint).found).toBe(false);
    expect(runAStar(graph, map.spawnMara, { row: 0, col: 2 }).found).toBe(false);
  });

  it('handle start equal to goal', () => {
    const map = asciiMap(['S.E']);
    const graph = new WeightedGraph(map);
    const r = runAStar(graph, map.spawnMara, map.spawnMara);
    expect(r.found).toBe(true);
    expect(r.totalCost).toBe(0);
    expect(r.path).toEqual([map.spawnMara]);
  });

  it('fill SearchResult fields consistently on the sample map', () => {
    const map = loadSample();
    const graph = new WeightedGraph(map);
    for (const algorithm of ['dijkstra', 'astar'] as const) {
      const r = findPath(graph, algorithm, map.spawnMara, map.extractionPoint);
      expect(r.found).toBe(true);
      expect(r.expandedCount).toBe(r.expandedNodes.length);
      expect(r.executionTimeMs).toBeGreaterThanOrEqual(0);
      expect(r.path.every((p) => graph.isWalkable(p))).toBe(true);
    }
  });

  it('octile heuristic is consistent on generated maps', () => {
    const map = generateCityMap(20, 20, 5);
    const graph = new WeightedGraph(map);
    const goal = map.extractionPoint;
    const h = createHeuristic('octile', graph.minCellCost);
    for (let r = 0; r < 20; r++) {
      for (let c = 0; c < 20; c++) {
        const u = { row: r, col: c };
        for (const e of graph.getNeighbors(u)) {
          expect(h(u, goal)).toBeLessThanOrEqual(e.weight + h(e.to, goal) + 1e-9);
        }
      }
    }
  });
});

describe('generateCityMap', () => {
  it('is deterministic and always connects spawn and extraction', () => {
    expect(generateCityMap(20, 20, 99)).toEqual(generateCityMap(20, 20, 99));
    for (let seed = 0; seed < 30; seed++) {
      const map = parseMapDefinition(generateCityMap(32, 32, seed, { obstacleDensity: 0.3 }));
      const graph = new WeightedGraph(map);
      expect(runAStar(graph, map.spawnMara, map.extractionPoint).found).toBe(true);
    }
  });
});

describe('propagateAlertRecursive', () => {
  it('reaches a chain of agents up to the depth limit', () => {
    const agents = [agent('a', 0, 0), agent('b', 0, 3), agent('c', 0, 6), agent('d', 0, 9), agent('e', 0, 12)];
    const limited = propagateAlertRecursive('a', agents, 3, 2);
    expect(limited.reachedAgentIds).toEqual(['a', 'b', 'c']);
    expect(limited.maxDepth).toBe(2);
    expect(limited.maxStackDepth).toBe(3);

    const full = propagateAlertRecursive('a', agents, 3, 10, { minSignal: 0 });
    expect(full.reachedAgentIds).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(full.hops.map((h) => h.depth)).toEqual([1, 2, 3, 4]);
  });

  it('terminates on fully connected clusters and never visits an agent twice', () => {
    const rng = new SeededRng(3);
    const agents = Array.from({ length: 60 }, (_, i) => agent(`z${i}`, rng.int(0, 5), rng.int(0, 5)));
    const result = propagateAlertRecursive('z0', agents, 100, 1000, { minSignal: 0 });
    expect(new Set(result.reachedAgentIds).size).toBe(result.reachedAgentIds.length);
    expect(result.reachedAgentIds).toHaveLength(60);
    expect(result.hops).toHaveLength(59);
    expect(result.recursiveCalls).toBeLessThanOrEqual(60);
    // Everyone is in range of the origin, so the alert needs a single hop.
    expect(result.maxDepth).toBe(1);
  });

  it('respects the base case of depth 0 and isolated agents', () => {
    const agents = [agent('a', 0, 0), agent('b', 0, 1), agent('far', 20, 20)];
    const zero = propagateAlertRecursive('a', agents, 5, 0);
    expect(zero.reachedAgentIds).toEqual(['a']);
    expect(zero.recursiveCalls).toBe(1);
    const result = propagateAlertRecursive('a', agents, 5, 5);
    expect(result.reachedAgentIds).not.toContain('far');
  });

  it('signal strength decays with each hop and stops below the threshold', () => {
    const agents = Array.from({ length: 30 }, (_, i) => agent(`z${i}`, 0, i * 2));
    const result = propagateAlertRecursive('z0', agents, 2, 100, { decayPerHop: 0.5, minSignal: 0.1 });
    for (let i = 1; i < result.hops.length; i++) {
      expect(result.hops[i].signalStrength).toBeLessThan(result.hops[i - 1].signalStrength);
    }
    expect(result.hops.every((h) => h.signalStrength >= 0.1)).toBe(true);
    expect(result.reachedAgentIds.length).toBeLessThan(30);
  });

  it('returns an empty result for an unknown origin', () => {
    const result = propagateAlertRecursive('ghost', [agent('a', 0, 0)], 5, 5);
    expect(result.reachedAgentIds).toEqual([]);
    expect(result.recursiveCalls).toBe(0);
  });
});

describe('WeightedGraph.version', () => {
  it('increments only when the graph really changes', () => {
    const graph = new WeightedGraph(generateCityMap(12, 12, 3));
    const v0 = graph.version;
    graph.setBlocked({ row: 0, col: 0 }, false);
    expect(graph.version).toBe(v0);
    graph.setBlocked({ row: 0, col: 0 }, true);
    expect(graph.version).toBe(v0 + 1);
    graph.setCost({ row: 0, col: 1 }, graph.getCost({ row: 0, col: 1 }));
    expect(graph.version).toBe(v0 + 1);
    graph.setCost({ row: 0, col: 1 }, 7);
    expect(graph.version).toBe(v0 + 2);
    expect(graph.clone().version).toBe(graph.version);
  });
});

describe('PathCache', () => {
  const map = generateCityMap(30, 30, 99);
  const start = map.spawnMara;
  const goal = map.extractionPoint;

  it('returns the same optimal result as a fresh search and counts hits', () => {
    const graph = new WeightedGraph(map);
    const cache = new PathCache();
    const first = cache.find(graph, 'astar', start, goal, 'octile');
    const second = cache.find(graph, 'astar', start, goal, 'octile');
    const fresh = findPath(graph, 'astar', start, goal, 'octile');
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.totalCost).toBeCloseTo(fresh.totalCost, 9);
    expect(second.path).toEqual(fresh.path);
    expect(second.path).not.toBe(first.path);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, size: 1 });
  });

  it('keeps algorithms and heuristics apart', () => {
    const graph = new WeightedGraph(map);
    const cache = new PathCache();
    cache.find(graph, 'astar', start, goal, 'octile');
    expect(cache.find(graph, 'dijkstra', start, goal).cacheHit).toBe(false);
    expect(cache.find(graph, 'astar', start, goal, 'euclidean').cacheHit).toBe(false);
    expect(cache.stats().size).toBe(3);
  });

  it('invalidates when a barricade changes the graph', () => {
    const graph = new WeightedGraph(map);
    const cache = new PathCache();
    const before = cache.find(graph, 'astar', start, goal, 'octile');
    const cut = before.path[Math.floor(before.path.length / 2)];
    graph.setBlocked(cut, true);
    const after = cache.find(graph, 'astar', start, goal, 'octile');
    expect(after.cacheHit).toBe(false);
    expect(after.path.some((p) => p.row === cut.row && p.col === cut.col)).toBe(false);
    expect(after.totalCost).toBeCloseTo(runDijkstra(graph, start, goal).totalCost, 9);
    expect(cache.stats().invalidations).toBe(1);
  });

  it('evicts the least recently used entry when full', () => {
    const graph = new WeightedGraph(map);
    const cache = new PathCache(2);
    const cells = map.cells.filter((c) => c.walkable).slice(0, 3);
    cache.find(graph, 'astar', start, cells[0]);
    cache.find(graph, 'astar', start, cells[1]);
    cache.find(graph, 'astar', start, cells[0]);
    cache.find(graph, 'astar', start, cells[2]);
    expect(cache.find(graph, 'astar', start, cells[0]).cacheHit).toBe(true);
    expect(cache.find(graph, 'astar', start, cells[1]).cacheHit).toBe(false);
  });
});

describe('isPathStillValid', () => {
  it('detects when a path is cut and ignores unrelated changes', () => {
    const map = generateCityMap(30, 30, 5);
    const graph = new WeightedGraph(map);
    const path = runAStar(graph, map.spawnMara, map.extractionPoint).path;
    expect(isPathStillValid(graph, path)).toBe(true);
    const onPath = new Set(path.map((p) => `${p.row},${p.col}`));
    const unrelated = map.cells.find((c) => c.walkable && !onPath.has(`${c.row},${c.col}`) && Math.abs(c.row - path[0].row) > 3)!;
    graph.setBlocked(unrelated, true);
    expect(isPathStillValid(graph, path)).toBe(true);
    graph.setBlocked(path[Math.floor(path.length / 2)], true);
    expect(isPathStillValid(graph, path)).toBe(false);
    expect(isPathStillValid(graph, [])).toBe(false);
  });
});

describe('tick cost benchmark', () => {
  it('measures the same number of ticks for isolated and coordinated runs', () => {
    const map = generateCityMap(24, 24, 11);
    const rows = runTickCostBenchmarks([{ label: 'gen_24', map }], {
      zombieCounts: [4],
      repetitions: 1,
      ticks: 30,
      algorithms: [{ algorithm: 'astar', heuristic: 'octile' }],
    });
    expect(rows.map((r) => r.mode)).toEqual(['isolated', 'coordinated']);
    for (const row of rows) {
      expect(row.ticks).toBe(30);
      expect(Number(row.tick_ms_mean)).toBeGreaterThanOrEqual(0);
      expect(Number(row.redundant_rate)).toBeGreaterThanOrEqual(0);
    }
    expect(summarizeTickCost(rows)).toHaveLength(2);
  });
});
