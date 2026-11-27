import type { CellType, GridCoord, MapCellData, MapDefinition } from '../contracts.ts';

const CELL_TYPES: ReadonlySet<CellType> = new Set<CellType>([
  'street',
  'sidewalk',
  'building',
  'obstacle',
  'barricade',
  'pharmacy',
  'refuge',
  'extraction',
]);

export class MapValidationError extends Error {
  constructor(message: string) {
    super(`Invalid map: ${message}`);
    this.name = 'MapValidationError';
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function parseCoord(raw: unknown, label: string, width: number, height: number): GridCoord {
  if (!isObject(raw) || !Number.isInteger(raw.row) || !Number.isInteger(raw.col)) {
    throw new MapValidationError(`${label} must be { row: integer, col: integer }`);
  }
  const coord = { row: raw.row as number, col: raw.col as number };
  if (coord.row < 0 || coord.row >= height || coord.col < 0 || coord.col >= width) {
    throw new MapValidationError(`${label} (${coord.row}, ${coord.col}) is out of bounds`);
  }
  return coord;
}

/**
 * Validates and normalizes raw map JSON into a MapDefinition.
 * Checks dimensions, a complete and non-duplicated cell grid, valid types,
 * non-negative finite costs, and walkable spawn / extraction points.
 * Cells are returned sorted in row-major order.
 */
export function parseMapDefinition(raw: unknown): MapDefinition {
  if (!isObject(raw)) throw new MapValidationError('root must be an object');

  const { id, name, width, height, cellSize } = raw;
  if (typeof id !== 'string' || id.length === 0) throw new MapValidationError('id must be a non-empty string');
  if (typeof name !== 'string') throw new MapValidationError('name must be a string');
  if (!isPositiveInt(width) || !isPositiveInt(height)) {
    throw new MapValidationError('width and height must be positive integers');
  }
  if (typeof cellSize !== 'number' || !(cellSize > 0)) {
    throw new MapValidationError('cellSize must be a positive number');
  }
  if (!Array.isArray(raw.cells)) throw new MapValidationError('cells must be an array');
  if (raw.cells.length !== width * height) {
    throw new MapValidationError(`expected ${width * height} cells, found ${raw.cells.length}`);
  }

  const grid = new Array<MapCellData | undefined>(width * height);
  for (const [index, rawCell] of raw.cells.entries()) {
    if (!isObject(rawCell)) throw new MapValidationError(`cell #${index} must be an object`);
    const { row, col, type, walkable, cost, elevation } = rawCell;
    if (!Number.isInteger(row) || !Number.isInteger(col)) {
      throw new MapValidationError(`cell #${index} has non-integer row/col`);
    }
    const r = row as number;
    const c = col as number;
    if (r < 0 || r >= height || c < 0 || c >= width) {
      throw new MapValidationError(`cell (${r}, ${c}) is out of bounds`);
    }
    if (typeof type !== 'string' || !CELL_TYPES.has(type as CellType)) {
      throw new MapValidationError(`cell (${r}, ${c}) has unknown type "${String(type)}"`);
    }
    if (typeof walkable !== 'boolean') {
      throw new MapValidationError(`cell (${r}, ${c}) walkable must be boolean`);
    }
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
      throw new MapValidationError(`cell (${r}, ${c}) cost must be a finite non-negative number`);
    }
    if (elevation !== undefined && typeof elevation !== 'number') {
      throw new MapValidationError(`cell (${r}, ${c}) elevation must be a number`);
    }
    const slot = r * width + c;
    if (grid[slot]) throw new MapValidationError(`duplicated cell (${r}, ${c})`);
    const cell: MapCellData = { row: r, col: c, type: type as CellType, walkable, cost };
    if (elevation !== undefined) cell.elevation = elevation as number;
    grid[slot] = cell;
  }

  const spawnMara = parseCoord(raw.spawnMara, 'spawnMara', width, height);
  const extractionPoint = parseCoord(raw.extractionPoint, 'extractionPoint', width, height);
  for (const [label, p] of [
    ['spawnMara', spawnMara],
    ['extractionPoint', extractionPoint],
  ] as const) {
    if (!grid[p.row * width + p.col]?.walkable) {
      throw new MapValidationError(`${label} (${p.row}, ${p.col}) is not walkable`);
    }
  }

  return {
    id,
    name,
    width,
    height,
    cellSize,
    spawnMara,
    extractionPoint,
    cells: grid as MapCellData[],
  };
}
