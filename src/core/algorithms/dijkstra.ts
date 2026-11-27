import type { GridCoord, SearchResult } from '../contracts.ts';
import type { WeightedGraph } from '../graph/WeightedGraph.ts';

/**
 * Shortest path search using Dijkstra's algorithm.
 */
export function runDijkstra(
  _graph: WeightedGraph,
  _start: GridCoord,
  _goal: GridCoord
): SearchResult {
  // TODO: Implement Dijkstra using BinaryHeap.
  return {
    found: false,
    path: [],
    totalCost: 0,
    expandedNodes: [],
    expandedCount: 0,
    executionTimeMs: 0,
  };
}
