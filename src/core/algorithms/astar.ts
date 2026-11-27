import type { GridCoord, HeuristicType } from '../contracts.ts';
import type { WeightedGraph } from '../graph/WeightedGraph.ts';
import { createHeuristic } from './heuristics.ts';
import { bestFirstSearch, type SearchStats } from './shortestPath.ts';

/**
 * Heuristic shortest path search using A*, f(n) = g(n) + h(n).
 * h is scaled by the graph's minimum cell cost, so octile (8-way) and manhattan (4-way)
 * are admissible and consistent, and the returned path is optimal.
 * Worst case time O((V + E) log V), same as Dijkstra; usually far fewer expansions.
 */
export function runAStar(
  graph: WeightedGraph,
  start: GridCoord,
  goal: GridCoord,
  heuristic: HeuristicType = 'octile'
): SearchStats {
  return bestFirstSearch(graph, start, goal, createHeuristic(heuristic, graph.minCellCost));
}
