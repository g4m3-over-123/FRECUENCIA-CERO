import type { GridCoord, HeuristicType, SearchResult } from '../contracts.ts';
import type { WeightedGraph } from '../graph/WeightedGraph.ts';

/**
 * Heuristic shortest path search using A*.
 */
export function runAStar(
  _graph: WeightedGraph,
  _start: GridCoord,
  _goal: GridCoord,
  _heuristic: HeuristicType = 'octile'
): SearchResult {
  // TODO: Implement A* using BinaryHeap and configurable heuristic.
  return {
    found: false,
    path: [],
    totalCost: 0,
    expandedNodes: [],
    expandedCount: 0,
    executionTimeMs: 0,
  };
}
