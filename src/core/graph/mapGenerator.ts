import type { CellType, GridCoord, MapCellData, MapDefinition } from '../contracts.ts';
import { SeededRng } from './seededRng.ts';

export interface GeneratedMapOptions {
  /** Interior size of each city block (street lines are placed between blocks). Default 4. */
  blockSize?: number;
  /** Probability that a block holds a building. Default 0.7. */
  buildingDensity?: number;
  /** Probability that a street cell is blocked by debris. Default 0.06. */
  obstacleDensity?: number;
  /** Probability that a street cell is rubble (walkable, expensive). Default 0.08. */
  rubbleDensity?: number;
  cellSize?: number;
}

const COST: Record<CellType, number> = {
  street: 1,
  sidewalk: 1.2,
  building: 999,
  obstacle: 999,
  barricade: 3.5,
  pharmacy: 1,
  refuge: 1,
  extraction: 1,
};

/**
 * Deterministic city map generator: the same (width, height, seed) always yields the same map.
 * Streets form a grid between blocks, blocks hold buildings or open plazas, and streets get
 * random debris (blocked) and rubble (expensive). Spawn (top-left) and extraction
 * (bottom-right) are always connected; a corridor is carved if needed.
 */
export function generateCityMap(
  width: number,
  height: number,
  seed: number,
  options: GeneratedMapOptions = {}
): MapDefinition {
  const rng = new SeededRng(seed);
  const blockSize = options.blockSize ?? 4;
  const buildingDensity = options.buildingDensity ?? 0.7;
  const obstacleDensity = options.obstacleDensity ?? 0.06;
  const rubbleDensity = options.rubbleDensity ?? 0.08;
  const period = blockSize + 1;

  const types = new Array<CellType>(width * height).fill('street');
  const costs = new Float64Array(width * height).fill(1);
  const set = (r: number, c: number, type: CellType, cost = COST[type]): void => {
    types[r * width + c] = type;
    costs[r * width + c] = cost;
  };

  // Blocks: buildings surrounded by sidewalks, or open plazas.
  for (let br = 1; br < height; br += period) {
    for (let bc = 1; bc < width; bc += period) {
      const hasBuilding = rng.chance(buildingDensity);
      for (let r = br; r < Math.min(br + blockSize, height); r++) {
        for (let c = bc; c < Math.min(bc + blockSize, width); c++) {
          const edge = r === br || c === bc || r === br + blockSize - 1 || c === bc + blockSize - 1;
          if (hasBuilding && !edge) set(r, c, 'building');
          else set(r, c, 'sidewalk');
        }
      }
    }
  }

  // Street debris and rubble.
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (types[r * width + c] !== 'street') continue;
      if (rng.chance(obstacleDensity)) set(r, c, 'obstacle');
      else if (rng.chance(rubbleDensity)) set(r, c, 'street', rng.range(2, 4));
    }
  }

  const spawn: GridCoord = { row: 0, col: 0 };
  const extraction: GridCoord = { row: height - 1, col: width - 1 };

  if (!isConnected(types, width, height, spawn, extraction)) {
    carveCorridor(types, costs, width, spawn, extraction, rng);
  }

  // Points of interest on walkable cells.
  set(spawn.row, spawn.col, 'refuge');
  set(extraction.row, extraction.col, 'extraction');
  const free: GridCoord[] = [];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (types[r * width + c] === 'sidewalk') free.push({ row: r, col: c });
    }
  }
  if (free.length > 0) {
    const pharmacy = rng.pick(free);
    set(pharmacy.row, pharmacy.col, 'pharmacy');
  }

  const cells: MapCellData[] = [];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const type = types[r * width + c];
      const walkable = type !== 'building' && type !== 'obstacle';
      const cell: MapCellData = {
        row: r,
        col: c,
        type,
        walkable,
        cost: Math.round(costs[r * width + c] * 100) / 100,
      };
      if (type === 'building') cell.elevation = 4 + rng.int(0, 6);
      cells.push(cell);
    }
  }

  return {
    id: `gen_${width}x${height}_s${seed}`,
    name: `Generated city ${width}x${height} (seed ${seed})`,
    width,
    height,
    cellSize: options.cellSize ?? 2,
    spawnMara: spawn,
    extractionPoint: extraction,
    cells,
  };
}

function isBlocked(type: CellType): boolean {
  return type === 'building' || type === 'obstacle';
}

function isConnected(types: CellType[], width: number, height: number, a: GridCoord, b: GridCoord): boolean {
  if (isBlocked(types[a.row * width + a.col]) || isBlocked(types[b.row * width + b.col])) return false;
  const seen = new Uint8Array(width * height);
  const queue = [a.row * width + a.col];
  seen[queue[0]] = 1;
  const target = b.row * width + b.col;
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    if (id === target) return true;
    const r = Math.floor(id / width);
    const c = id % width;
    for (const [dr, dc] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= height || nc < 0 || nc >= width) continue;
      const nid = nr * width + nc;
      if (seen[nid] || isBlocked(types[nid])) continue;
      seen[nid] = 1;
      queue.push(nid);
    }
  }
  return false;
}

/** Carves a monotone staircase corridor from a to b, turning blocked cells into street. */
function carveCorridor(
  types: CellType[],
  costs: Float64Array,
  width: number,
  a: GridCoord,
  b: GridCoord,
  rng: SeededRng
): void {
  let { row, col } = a;
  const open = (r: number, c: number): void => {
    const id = r * width + c;
    if (isBlocked(types[id])) {
      types[id] = 'street';
      costs[id] = COST.street;
    }
  };
  open(row, col);
  while (row !== b.row || col !== b.col) {
    const moveRow = col === b.col || (row !== b.row && rng.chance(0.5));
    if (moveRow) row += Math.sign(b.row - row);
    else col += Math.sign(b.col - col);
    open(row, col);
  }
}
