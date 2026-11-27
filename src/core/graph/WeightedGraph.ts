import type { GridCoord, MapDefinition } from '../contracts.ts';

export interface GraphEdge {
  to: GridCoord;
  weight: number;
}

/**
 * Weighted grid graph representation for headless pathfinding.
 */
export class WeightedGraph {
  readonly width: number;
  readonly height: number;

  constructor(map: MapDefinition) {
    this.width = map.width;
    this.height = map.height;
    // TODO: Build adjacency and traversal weights from MapDefinition cells.
  }

  getNeighbors(_node: GridCoord): GraphEdge[] {
    // TODO: Return walkable 4-way or 8-way neighbors with movement costs.
    return [];
  }

  isWalkable(_node: GridCoord): boolean {
    // TODO: Check bounds and cell walkability.
    return false;
  }
}
