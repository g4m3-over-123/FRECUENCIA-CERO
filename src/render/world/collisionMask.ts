import type { WorldPoint } from '../../core/world/gridSpace.ts';

/**
 * Fine player-collision grid (public/maps/<map>.collision.json, written by
 * scripts/generate-street-map.ts). Each sub-cell is solid or open; the FPV player collides
 * with these boxes so it can walk up to the real wall faces instead of whole 1 m cells.
 * Front A (world/player) owns this file.
 */
export class CollisionMask {
  private constructor(
    readonly cellSize: number,
    readonly width: number,
    readonly height: number,
    readonly origin: WorldPoint,
    private readonly solid: Uint8Array
  ) {}

  static parse(raw: unknown): CollisionMask | null {
    const data = raw as { cellSize?: unknown; width?: unknown; height?: unknown; origin?: WorldPoint; rows?: unknown };
    if (typeof data?.cellSize !== 'number' || typeof data.width !== 'number' || typeof data.height !== 'number') return null;
    if (!Array.isArray(data.rows) || data.rows.length !== data.height || !data.origin) return null;
    const { cellSize, width, height, origin, rows } = data;
    const solid = new Uint8Array(width * height);
    rows.forEach((row: unknown, r: number) => {
      const line = String(row);
      for (let c = 0; c < width; c++) solid[r * width + c] = line[c] === '.' ? 0 : 1;
    });
    return new CollisionMask(cellSize, width, height, { ...origin }, solid);
  }

  static async load(url: string): Promise<CollisionMask | null> {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      return CollisionMask.parse(await response.json());
    } catch {
      return null;
    }
  }

  /** Out-of-bounds sub-cells count as solid. */
  isSolid(row: number, col: number): boolean {
    if (row < 0 || row >= this.height || col < 0 || col >= this.width) return true;
    return this.solid[row * this.width + col] === 1;
  }

  /** Marks the sub-cells under a world XZ rectangle as solid (props placed at runtime). */
  stamp(minX: number, minZ: number, maxX: number, maxZ: number): void {
    const c0 = Math.max(0, Math.floor((minX - this.origin.x) / this.cellSize));
    const c1 = Math.min(this.width - 1, Math.floor((maxX - this.origin.x) / this.cellSize));
    const r0 = Math.max(0, Math.floor((minZ - this.origin.z) / this.cellSize));
    const r1 = Math.min(this.height - 1, Math.floor((maxZ - this.origin.z) / this.cellSize));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) this.solid[r * this.width + c] = 1;
    }
  }
}
