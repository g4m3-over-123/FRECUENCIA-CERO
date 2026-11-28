import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMapDefinition } from '../src/core/graph/mapLoader.ts';
import { CollisionMask } from '../src/render/world/collisionMask.ts';

const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../public/maps/${name}`, import.meta.url), 'utf8'));

describe('map_street player collision mask', () => {
  const map = parseMapDefinition(read('map_street.json'));
  const mask = CollisionMask.parse(read('map_street.collision.json'))!;
  const fine = Math.round(map.cellSize / mask.cellSize);

  it('covers the same grid as the map (regenerate both with npm run map:street)', () => {
    expect(mask).not.toBeNull();
    expect(fine * mask.cellSize).toBeCloseTo(map.cellSize);
    expect(mask.width).toBe(map.width * fine);
    expect(mask.height).toBe(map.height * fine);
    expect(mask.origin).toEqual(map.world!.origin);
  });

  it('keeps every walkable cell open and only opens strips next to walkable cells', () => {
    const walkable = new Set(map.cells.filter((c) => c.walkable).map((c) => c.row * map.width + c.col));
    for (let row = 0; row < mask.height; row++) {
      for (let col = 0; col < mask.width; col++) {
        const r = Math.floor(row / fine);
        const c = Math.floor(col / fine);
        if (walkable.has(r * map.width + c)) {
          expect(mask.isSolid(row, col), `sub-cell ${row},${col}`).toBe(false);
        } else if (!mask.isSolid(row, col)) {
          const nearWalkable = [-1, 0, 1].some((dr) =>
            [-1, 0, 1].some((dc) => walkable.has((r + dr) * map.width + (c + dc))));
          expect(nearWalkable, `open sub-cell ${row},${col} far from the walkable area`).toBe(true);
        }
      }
    }
  });
});
