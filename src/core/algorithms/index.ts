import type { AlgorithmType, GridCoord, HeuristicType } from '../contracts.ts';
import type { WeightedGraph } from '../graph/WeightedGraph.ts';
import { runAStar } from './astar.ts';
import { runDijkstra } from './dijkstra.ts';
import type { SearchStats } from './shortestPath.ts';

export { BinaryHeap } from './BinaryHeap.ts';
export { runDijkstra } from './dijkstra.ts';
export { runAStar } from './astar.ts';
export { createHeuristic, isHeuristicAdmissible } from './heuristics.ts';
export { propagateAlertRecursive } from './alertRecursion.ts';
export type { SearchStats } from './shortestPath.ts';
export type { AlertPropagationOptions } from './alertRecursion.ts';

/** Single entry point so gameplay can switch algorithms at runtime. */
export function findPath(
  graph: WeightedGraph,
  algorithm: AlgorithmType,
  start: GridCoord,
  goal: GridCoord,
  heuristic: HeuristicType = 'octile'
): SearchStats {
  return algorithm === 'dijkstra'
    ? runDijkstra(graph, start, goal)
    : runAStar(graph, start, goal, heuristic);
}
