import type { GridCoord } from '../contracts.ts';
import type { WeightedGraph } from '../graph/WeightedGraph.ts';
import { bestFirstSearch, type SearchStats } from './shortestPath.ts';

/**
 * Shortest path search using Dijkstra's algorithm (binary heap, adjacency list).
 * Optimal for non-negative weights. Time O((V + E) log V), space O(V + E).
 */
export function runDijkstra(graph: WeightedGraph, start: GridCoord, goal: GridCoord): SearchStats {
  return bestFirstSearch(graph, start, goal, null);
}
