import type { GridCoord, MapDefinition } from '../contracts.ts';

export interface GraphEdge {
  to: GridCoord;
  weight: number;
}

/** Edge using numeric node ids (row * width + col); used by the search hot loop. */
export interface IdEdge {
  to: number;
  weight: number;
}

export interface WeightedGraphOptions {
  /** 8-way movement when true (default), 4-way otherwise. */
  allowDiagonal?: boolean;
  /** Forbid diagonal moves that squeeze between two blocked orthogonal cells. Default true. */
  preventCornerCutting?: boolean;
}

const ORTHOGONAL: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

const DIAGONAL: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

/**
 * Weighted grid graph with adjacency lists.
 *
 * Vertices: walkable cells. Edges: moves to adjacent walkable cells.
 * Edge weight u -> v = cost(v) * stepLength, stepLength = 1 (orthogonal) or sqrt(2) (diagonal).
 * All weights are non-negative, as required by Dijkstra and A*.
 *
 * Space: O(V + E), with E <= 8V on a grid.
 */
export class WeightedGraph {
  readonly width: number;
  readonly height: number;
  readonly allowDiagonal: boolean;
  readonly preventCornerCutting: boolean;

  private readonly walkable: Uint8Array;
  private readonly cellCost: Float64Array;
  private adjacency: IdEdge[][];
  private minCostCache: number | null = null;

  constructor(map: MapDefinition, options: WeightedGraphOptions = {}) {
    this.width = map.width;
    this.height = map.height;
    this.allowDiagonal = options.allowDiagonal ?? true;
    this.preventCornerCutting = options.preventCornerCutting ?? true;

    const size = this.width * this.height;
    this.walkable = new Uint8Array(size);
    this.cellCost = new Float64Array(size).fill(1);

    for (const cell of map.cells) {
      if (!this.inBounds(cell)) continue;
      const id = this.toId(cell);
      this.walkable[id] = cell.walkable ? 1 : 0;
      this.cellCost[id] = cell.cost;
    }

    this.adjacency = new Array<IdEdge[]>(size);
    for (let id = 0; id < size; id++) {
      this.adjacency[id] = this.buildEdges(id);
    }
  }

  get nodeCount(): number {
    return this.width * this.height;
  }

  get walkableCount(): number {
    let count = 0;
    for (let i = 0; i < this.walkable.length; i++) count += this.walkable[i];
    return count;
  }

  get edgeCount(): number {
    let count = 0;
    for (const edges of this.adjacency) count += edges.length;
    return count;
  }

  toId(node: GridCoord): number {
    return node.row * this.width + node.col;
  }

  toCoord(id: number): GridCoord {
    return { row: Math.floor(id / this.width), col: id % this.width };
  }

  inBounds(node: GridCoord): boolean {
    return node.row >= 0 && node.row < this.height && node.col >= 0 && node.col < this.width;
  }

  isWalkable(node: GridCoord): boolean {
    return this.inBounds(node) && this.walkable[this.toId(node)] === 1;
  }

  getCost(node: GridCoord): number {
    return this.cellCost[this.toId(node)];
  }

  getNeighbors(node: GridCoord): GraphEdge[] {
    if (!this.inBounds(node)) return [];
    return this.adjacency[this.toId(node)].map((edge) => ({
      to: this.toCoord(edge.to),
      weight: edge.weight,
    }));
  }

  /** Adjacency list by numeric id. Returned array must not be mutated. */
  neighborsById(id: number): readonly IdEdge[] {
    return this.adjacency[id];
  }

  /** Minimum traversal cost among walkable cells; scales heuristics to stay admissible. */
  get minCellCost(): number {
    if (this.minCostCache === null) {
      let min = Infinity;
      for (let i = 0; i < this.walkable.length; i++) {
        if (this.walkable[i] === 1 && this.cellCost[i] < min) min = this.cellCost[i];
      }
      this.minCostCache = Number.isFinite(min) ? min : 0;
    }
    return this.minCostCache;
  }

  /** Blocks or unblocks a cell (e.g. a barricade) and updates only the affected edges. */
  setBlocked(node: GridCoord, blocked: boolean): void {
    if (!this.inBounds(node)) return;
    this.walkable[this.toId(node)] = blocked ? 0 : 1;
    this.refreshAround(node);
  }

  /** Changes the traversal cost of a cell and updates only the affected edges. */
  setCost(node: GridCoord, cost: number): void {
    if (!this.inBounds(node)) return;
    if (!Number.isFinite(cost) || cost < 0) {
      throw new Error(`Invalid cell cost ${cost}: costs must be finite and non-negative`);
    }
    this.cellCost[this.toId(node)] = cost;
    this.refreshAround(node);
  }

  /** Independent copy, useful to test environment changes without mutating the original. */
  clone(): WeightedGraph {
    const copy = Object.create(WeightedGraph.prototype) as WeightedGraph;
    Object.assign(copy, {
      width: this.width,
      height: this.height,
      allowDiagonal: this.allowDiagonal,
      preventCornerCutting: this.preventCornerCutting,
      walkable: this.walkable.slice(),
      cellCost: this.cellCost.slice(),
      adjacency: this.adjacency.map((edges) => edges.map((e) => ({ ...e }))),
      minCostCache: this.minCostCache,
    });
    return copy;
  }

  private refreshAround(node: GridCoord): void {
    this.minCostCache = null;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const n = { row: node.row + dr, col: node.col + dc };
        if (this.inBounds(n)) this.adjacency[this.toId(n)] = this.buildEdges(this.toId(n));
      }
    }
  }

  private isOpen(row: number, col: number): boolean {
    return (
      row >= 0 &&
      row < this.height &&
      col >= 0 &&
      col < this.width &&
      this.walkable[row * this.width + col] === 1
    );
  }

  private buildEdges(id: number): IdEdge[] {
    if (this.walkable[id] !== 1) return [];
    const row = Math.floor(id / this.width);
    const col = id % this.width;
    const edges: IdEdge[] = [];

    for (const [dr, dc] of ORTHOGONAL) {
      const r = row + dr;
      const c = col + dc;
      if (this.isOpen(r, c)) {
        const to = r * this.width + c;
        edges.push({ to, weight: this.cellCost[to] });
      }
    }

    if (this.allowDiagonal) {
      for (const [dr, dc] of DIAGONAL) {
        const r = row + dr;
        const c = col + dc;
        if (!this.isOpen(r, c)) continue;
        if (this.preventCornerCutting && (!this.isOpen(row + dr, col) || !this.isOpen(row, col + dc))) {
          continue;
        }
        const to = r * this.width + c;
        edges.push({ to, weight: this.cellCost[to] * Math.SQRT2 });
      }
    }

    return edges;
  }
}
