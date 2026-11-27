import type { GridCoord, SearchResult } from '../contracts.ts';
import type { WeightedGraph } from '../graph/WeightedGraph.ts';
import { BinaryHeap } from './BinaryHeap.ts';
import type { HeuristicFn } from './heuristics.ts';

/** SearchResult plus extra measurements used by benchmarks. Assignable to SearchResult. */
export interface SearchStats extends SearchResult {
  /** Times a node was pushed into the open set (includes stale duplicates). */
  pushCount: number;
  /** Largest open set size reached: proxy for peak memory of the frontier. */
  maxFrontierSize: number;
  /** Closed nodes re-expanded because a cheaper path appeared (0 with consistent h). */
  reopenedCount: number;
}

/**
 * Best-first search shared by Dijkstra (h = 0) and A* (h admissible).
 * Priority f(n) = g(n) + h(n). Uses lazy deletion: stale heap entries are skipped on pop.
 *
 * Time:  O((V + E) log V) with a binary heap (each relaxation is at most one push).
 * Space: O(V) for g, parent and closed arrays plus O(E) heap entries in the worst case.
 */
export function bestFirstSearch(
  graph: WeightedGraph,
  start: GridCoord,
  goal: GridCoord,
  heuristic: HeuristicFn | null
): SearchStats {
  const t0 = performance.now();
  const empty: SearchStats = {
    found: false,
    path: [],
    totalCost: 0,
    expandedNodes: [],
    expandedCount: 0,
    executionTimeMs: 0,
    pushCount: 0,
    maxFrontierSize: 0,
    reopenedCount: 0,
  };

  if (!graph.isWalkable(start) || !graph.isWalkable(goal)) {
    empty.executionTimeMs = performance.now() - t0;
    return empty;
  }

  const n = graph.nodeCount;
  const startId = graph.toId(start);
  const goalId = graph.toId(goal);
  const g = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const h = (id: number): number => (heuristic ? heuristic(graph.toCoord(id), goal) : 0);

  const open = new BinaryHeap<number>();
  const expandedNodes: GridCoord[] = [];
  let pushCount = 1;
  let maxFrontierSize = 1;
  let reopenedCount = 0;

  g[startId] = 0;
  open.push(startId, h(startId));

  while (!open.isEmpty()) {
    const priority = open.peekPriority() as number;
    const u = open.pop() as number;
    // Skip stale entries left by lazy deletion.
    if (closed[u] === 1 || priority > g[u] + h(u) + 1e-9) continue;

    closed[u] = 1;
    expandedNodes.push(graph.toCoord(u));

    if (u === goalId) {
      return {
        found: true,
        path: reconstructPath(graph, parent, goalId),
        totalCost: g[goalId],
        expandedNodes,
        expandedCount: expandedNodes.length,
        executionTimeMs: performance.now() - t0,
        pushCount,
        maxFrontierSize,
        reopenedCount,
      };
    }

    for (const edge of graph.neighborsById(u)) {
      const candidate = g[u] + edge.weight;
      if (candidate < g[edge.to] - 1e-12) {
        if (closed[edge.to] === 1) {
          // Only reachable with an inconsistent heuristic: reopen to keep optimality.
          closed[edge.to] = 0;
          reopenedCount++;
        }
        g[edge.to] = candidate;
        parent[edge.to] = u;
        open.push(edge.to, candidate + h(edge.to));
        pushCount++;
        if (open.size > maxFrontierSize) maxFrontierSize = open.size;
      }
    }
  }

  return {
    ...empty,
    expandedNodes,
    expandedCount: expandedNodes.length,
    executionTimeMs: performance.now() - t0,
    pushCount,
    maxFrontierSize,
    reopenedCount,
  };
}

function reconstructPath(graph: WeightedGraph, parent: Int32Array, goalId: number): GridCoord[] {
  const path: GridCoord[] = [];
  for (let id = goalId; id !== -1; id = parent[id]) path.push(graph.toCoord(id));
  return path.reverse();
}
