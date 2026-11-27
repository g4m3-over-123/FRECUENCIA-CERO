import type { GridCoord, HeuristicType } from '../contracts.ts';

export type HeuristicFn = (a: GridCoord, b: GridCoord) => number;

/**
 * Builds a heuristic scaled by the minimum cell cost of the graph.
 *
 * Admissibility: every move into a cell costs at least minCost * stepLength, so the true
 * remaining cost is >= minCost * (grid distance under the same movement model).
 * - manhattan: admissible and consistent for 4-way movement only.
 * - octile:    admissible and consistent for 8-way movement (tightest for 8-way).
 * - euclidean: admissible and consistent for both, but less informed.
 * Consistency (h(u) <= w(u,v) + h(v)) holds because each base distance satisfies the
 * triangle inequality and w(u,v) >= minCost * stepLength(u,v).
 */
export function createHeuristic(type: HeuristicType, minCost: number): HeuristicFn {
  const k = minCost;
  switch (type) {
    case 'manhattan':
      return (a, b) => k * (Math.abs(a.row - b.row) + Math.abs(a.col - b.col));
    case 'euclidean':
      return (a, b) => k * Math.hypot(a.row - b.row, a.col - b.col);
    case 'octile':
      return (a, b) => {
        const dr = Math.abs(a.row - b.row);
        const dc = Math.abs(a.col - b.col);
        return k * (Math.max(dr, dc) + (Math.SQRT2 - 1) * Math.min(dr, dc));
      };
  }
}

/** True when the heuristic is guaranteed admissible for the given movement model. */
export function isHeuristicAdmissible(type: HeuristicType, allowDiagonal: boolean): boolean {
  return !(type === 'manhattan' && allowDiagonal);
}
