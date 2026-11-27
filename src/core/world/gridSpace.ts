import type { GridCoord, MapDefinition } from '../contracts.ts';

/**
 * Single source of truth for converting between grid cells and world meters.
 * Convention (shared with render code): col -> +X, row -> +Z, Y is up.
 * Everyone must use these helpers instead of computing positions by hand.
 */

export interface WorldPoint {
  x: number;
  z: number;
}

type GridShape = Pick<MapDefinition, 'width' | 'height' | 'cellSize' | 'world'>;

/** World XZ position of the outer corner of cell (0, 0). Centered on the origin when the map has no `world`. */
export function getGridOrigin(map: GridShape): WorldPoint {
  if (map.world) return { x: map.world.origin.x, z: map.world.origin.z };
  return { x: (-map.width * map.cellSize) / 2, z: (-map.height * map.cellSize) / 2 };
}

/** World position of the center of a cell. */
export function gridToWorld(cell: GridCoord, map: GridShape): WorldPoint {
  const origin = getGridOrigin(map);
  return {
    x: origin.x + (cell.col + 0.5) * map.cellSize,
    z: origin.z + (cell.row + 0.5) * map.cellSize,
  };
}

/** Cell that contains a world point. May be out of bounds: check with isInsideGrid. */
export function worldToGrid(point: WorldPoint, map: GridShape): GridCoord {
  const origin = getGridOrigin(map);
  return {
    row: Math.floor((point.z - origin.z) / map.cellSize),
    col: Math.floor((point.x - origin.x) / map.cellSize),
  };
}

export function isInsideGrid(cell: GridCoord, map: Pick<MapDefinition, 'width' | 'height'>): boolean {
  return cell.row >= 0 && cell.row < map.height && cell.col >= 0 && cell.col < map.width;
}

/** World-space size of the whole grid. */
export function getGridExtent(map: GridShape): { min: WorldPoint; max: WorldPoint } {
  const min = getGridOrigin(map);
  return {
    min,
    max: { x: min.x + map.width * map.cellSize, z: min.z + map.height * map.cellSize },
  };
}

/**
 * Builds a fast walkability lookup from the static map definition.
 * Dynamic barricades come from WorldSnapshot and must be added by the caller.
 */
export function createWalkableLookup(map: MapDefinition): (cell: GridCoord) => boolean {
  const walkable = new Uint8Array(map.width * map.height);
  for (const cell of map.cells) {
    walkable[cell.row * map.width + cell.col] = cell.walkable ? 1 : 0;
  }
  return (cell) => isInsideGrid(cell, map) && walkable[cell.row * map.width + cell.col] === 1;
}

/** Unit grid direction (-1, 0, 1 per axis) closest to a world XZ direction. */
export function worldDirectionToGrid(dx: number, dz: number): GridCoord {
  const length = Math.hypot(dx, dz);
  if (length < 1e-6) return { row: 0, col: 0 };
  const nx = dx / length;
  const nz = dz / length;
  const snap = (v: number): number => (v > 0.38 ? 1 : v < -0.38 ? -1 : 0);
  return { row: snap(nz), col: snap(nx) };
}
