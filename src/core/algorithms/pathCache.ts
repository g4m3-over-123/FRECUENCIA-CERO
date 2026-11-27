import type { AlgorithmType, GridCoord, HeuristicType } from '../contracts.ts';
import type { WeightedGraph } from '../graph/WeightedGraph.ts';
import { runAStar } from './astar.ts';
import { runDijkstra } from './dijkstra.ts';
import type { SearchStats } from './shortestPath.ts';

/** SearchStats returned by the cache. `cacheHit` is true when no new search was run. */
export interface CachedSearchStats extends SearchStats {
  cacheHit: boolean;
}

export interface PathCacheStats {
  hits: number;
  misses: number;
  /** Times the whole cache was dropped because the graph changed. */
  invalidations: number;
  size: number;
  capacity: number;
  hitRate: number;
}

/**
 * Memoizes shortest-path searches for one graph state.
 *
 * Key: (algorithm, heuristic, start, goal). Every entry is valid only for the graph
 * version it was computed on: when `graph.version` changes (a barricade, a cost change)
 * or a different graph is passed, the cache is cleared, so a hit is always the exact
 * result a fresh search would return (searches are deterministic).
 *
 * Use it so agents replan only when their target or the graph changes: repeated requests
 * for the same (start, goal) cost O(1) instead of O((V + E) log V).
 * Eviction: least recently used, bounded by `capacity`.
 */
export class PathCache {
  private readonly entries = new Map<string, SearchStats>();
  private graph: WeightedGraph | null = null;
  private graphVersion = -1;
  private hits = 0;
  private misses = 0;
  private invalidations = 0;

  constructor(readonly capacity = 512) {
    if (!(capacity > 0)) throw new Error('PathCache capacity must be positive');
  }

  find(
    graph: WeightedGraph,
    algorithm: AlgorithmType,
    start: GridCoord,
    goal: GridCoord,
    heuristic: HeuristicType = 'octile'
  ): CachedSearchStats {
    const t0 = performance.now();
    this.syncGraph(graph);
    const key = `${algorithm === 'dijkstra' ? 'dijkstra' : `astar:${heuristic}`}|${graph.toId(start)}|${graph.toId(goal)}`;
    const cached = this.entries.get(key);
    if (cached) {
      this.hits++;
      this.entries.delete(key);
      this.entries.set(key, cached);
      return {
        ...cached,
        path: cached.path.map((p) => ({ ...p })),
        executionTimeMs: performance.now() - t0,
        cacheHit: true,
      };
    }

    this.misses++;
    const result =
      algorithm === 'dijkstra' ? runDijkstra(graph, start, goal) : runAStar(graph, start, goal, heuristic);
    this.entries.set(key, result);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    return { ...result, path: result.path.map((p) => ({ ...p })), cacheHit: false };
  }

  /** Drops every entry (also called automatically when the graph changes). */
  clear(): void {
    this.entries.clear();
  }

  stats(): PathCacheStats {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      invalidations: this.invalidations,
      size: this.entries.size,
      capacity: this.capacity,
      hitRate: total === 0 ? 0 : this.hits / total,
    };
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.invalidations = 0;
  }

  private syncGraph(graph: WeightedGraph): void {
    if (graph === this.graph && graph.version === this.graphVersion) return;
    if (this.entries.size > 0) this.invalidations++;
    this.entries.clear();
    this.graph = graph;
    this.graphVersion = graph.version;
  }
}

/**
 * True when every step of `path` is still walkable and connected by an edge in `graph`.
 * O(L * d) for a path of L cells and d <= 8 neighbors. Lets an agent keep its plan after
 * an unrelated graph change and replan only when its own route is cut.
 */
export function isPathStillValid(graph: WeightedGraph, path: readonly GridCoord[]): boolean {
  if (path.length === 0) return false;
  if (!graph.isWalkable(path[0])) return false;
  for (let i = 1; i < path.length; i++) {
    const from = graph.toId(path[i - 1]);
    const to = graph.toId(path[i]);
    if (!graph.isWalkable(path[i])) return false;
    if (!graph.neighborsById(from).some((edge) => edge.to === to)) return false;
  }
  return true;
}
