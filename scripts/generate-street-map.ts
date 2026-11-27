/**
 * Generates a MapDefinition (logical grid) aligned with a GLB scene.
 *
 *   npm run map:street
 *   npx tsx scripts/generate-street-map.ts <in.glb> <out.json> [--cell 1] [--band 0.35,1.9]
 *     [--scale 1] [--id map_street] [--name "..."] [--url /assets/props/street.glb]
 *
 * How it works:
 * 1. Reads every triangle of the GLB in world space.
 * 2. Ground level = height with the most upward-facing area.
 * 3. Places the model with its XZ center at the origin and the ground at Y = 0
 *    (that offset is written to map.world.asset.offset so the renderer uses the same one).
 * 4. Samples each triangle; a cell is blocked if any geometry lies inside the body band
 *    (default 0.35 m to 1.9 m above the ground). Overhead cables and curbs are ignored.
 * 5. Keeps only the largest connected walkable area and picks spawn, refuge, pharmacy and
 *    extraction automatically. Front A can hand-edit the JSON afterwards.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import type { CellType, GridCoord, MapCellData, MapDefinition } from '../src/core/contracts.ts';

interface Options {
  input: string;
  output: string;
  cellSize: number;
  /** Uniform scale applied to the model (the source asset may not be in real meters). */
  scale: number;
  bandLow: number;
  bandHigh: number;
  id: string;
  name: string;
  url: string;
}

function parseArgs(argv: string[]): Options {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      flags.set(arg.slice(2), argv[i + 1] ?? '');
      i++;
    } else {
      positional.push(arg);
    }
  }
  const [input = 'public/assets/props/street.glb', output = 'public/maps/map_street.json'] = positional;
  const [bandLow, bandHigh] = (flags.get('band') ?? '0.35,1.9').split(',').map(Number);
  return {
    input,
    output,
    cellSize: Number(flags.get('cell') ?? 1),
    scale: Number(flags.get('scale') ?? 1),
    bandLow,
    bandHigh,
    id: flags.get('id') ?? 'map_street',
    name: flags.get('name') ?? 'Calle principal (street.glb)',
    url: flags.get('url') ?? '/' + input.replace(/^public\//, ''),
  };
}

type Vec3 = [number, number, number];
type Triangle = [Vec3, Vec3, Vec3] & { source?: string };

async function readTriangles(path: string): Promise<Triangle[]> {
  const io = new NodeIO();
  const doc = await io.readBinary(new Uint8Array(readFileSync(path)));
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const triangles: Triangle[] = [];

  scene.traverse((node) => {
    const mesh = node.getMesh();
    if (!mesh) return;
    const m = node.getWorldMatrix();
    const transform = (v: number[]): Vec3 => [
      m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
      m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
      m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
    ];
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue; // TRIANGLES only
      const position = prim.getAttribute('POSITION');
      if (!position) continue;
      const vertices: Vec3[] = [];
      const tmp: number[] = [0, 0, 0];
      for (let i = 0; i < position.getCount(); i++) vertices.push(transform(position.getElement(i, tmp)));
      const indices = prim.getIndices();
      const count = indices ? indices.getCount() : vertices.length;
      const at = (i: number): number => (indices ? indices.getScalar(i) : i);
      for (let i = 0; i + 2 < count; i += 3) {
        const tri = [vertices[at(i)], vertices[at(i + 1)], vertices[at(i + 2)]] as Triangle;
        tri.source = node.getName();
        triangles.push(tri);
      }
    }
  });
  return triangles;
}

function findGroundLevel(triangles: Triangle[]): number {
  const bins = new Map<number, number>();
  for (const [a, b, c] of triangles) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9 || Math.abs(ny / len) < 0.9) continue;
    const area = len / 2;
    const bin = Math.round(((a[1] + b[1] + c[1]) / 3) / 0.05);
    bins.set(bin, (bins.get(bin) ?? 0) + area);
  }
  let best = 0;
  let bestArea = -1;
  for (const [bin, area] of bins) {
    if (area > bestArea) {
      bestArea = area;
      best = bin;
    }
  }
  return best * 0.05;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const triangles = (await readTriangles(opts.input)).map((tri) => {
    const scaled = tri.map((v) => v.map((c) => c * opts.scale) as Vec3) as Triangle;
    scaled.source = tri.source;
    return scaled;
  });
  if (triangles.length === 0) throw new Error(`No triangles found in ${opts.input}`);

  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const tri of triangles) {
    for (const v of tri) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], v[k]);
        max[k] = Math.max(max[k], v[k]);
      }
    }
  }
  const groundY = findGroundLevel(triangles);
  const centerX = (min[0] + max[0]) / 2;
  const centerZ = (min[2] + max[2]) / 2;
  const offset: Vec3 = [-centerX, -groundY, -centerZ];

  const cs = opts.cellSize;
  const width = Math.ceil((max[0] - min[0]) / cs);
  const height = Math.ceil((max[2] - min[2]) / cs);
  const origin = { x: (-width * cs) / 2, z: (-height * cs) / 2 };

  const blocked = new Uint8Array(width * height);
  // Cells with walkable floor (upward-facing surface close to ground level). Outside the
  // modelled street there is no floor, so those cells are void and never walkable.
  const floor = new Uint8Array(width * height);
  const topHeight = new Float32Array(width * height);
  const step = Math.min(0.2, cs / 4);
  const markFloor = (p: Vec3[]): void => {
    const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
    const vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1], vz = p[2][2] - p[0][2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9 || Math.abs(ny / len) < 0.85) return;
    const edge = Math.max(Math.hypot(ux, uz), Math.hypot(vx, vz), Math.hypot(p[2][0] - p[1][0], p[2][2] - p[1][2]));
    const k = Math.max(1, Math.ceil(edge / step));
    for (let i = 0; i <= k; i++) {
      for (let j = 0; j <= k - i; j++) {
        const u = i / k, v = j / k, w = 1 - u - v;
        const col = Math.floor((p[0][0] * w + p[1][0] * u + p[2][0] * v - origin.x) / cs);
        const row = Math.floor((p[0][2] * w + p[1][2] * u + p[2][2] * v - origin.z) / cs);
        if (row >= 0 && row < height && col >= 0 && col < width) floor[row * width + col] = 1;
      }
    }
  };
  // Diagnostics: DEBUG_CELL="row,col" prints which meshes block that cell.
  const debugCell = process.env.DEBUG_CELL?.split(',').map(Number);
  const debugSources = new Map<string, number>();

  for (const tri of triangles) {
    const p = tri.map((v) => [v[0] + offset[0], v[1] + offset[1], v[2] + offset[2]] as Vec3);
    const yMin = Math.min(p[0][1], p[1][1], p[2][1]);
    const yMax = Math.max(p[0][1], p[1][1], p[2][1]);
    if (yMax < 0.3 && yMin > -0.6) markFloor(p);
    if (yMax < opts.bandLow || yMin > opts.bandHigh) continue;
    const edge = Math.max(
      Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]),
      Math.hypot(p[2][0] - p[1][0], p[2][1] - p[1][1], p[2][2] - p[1][2]),
      Math.hypot(p[0][0] - p[2][0], p[0][1] - p[2][1], p[0][2] - p[2][2])
    );
    const k = Math.max(1, Math.ceil(edge / step));
    for (let i = 0; i <= k; i++) {
      for (let j = 0; j <= k - i; j++) {
        const u = i / k;
        const v = j / k;
        const w = 1 - u - v;
        const x = p[0][0] * w + p[1][0] * u + p[2][0] * v;
        const y = p[0][1] * w + p[1][1] * u + p[2][1] * v;
        const z = p[0][2] * w + p[1][2] * u + p[2][2] * v;
        if (y < opts.bandLow || y > opts.bandHigh) continue;
        const col = Math.floor((x - origin.x) / cs);
        const row = Math.floor((z - origin.z) / cs);
        if (row < 0 || row >= height || col < 0 || col >= width) continue;
        blocked[row * width + col] = 1;
        if (debugCell && debugCell[0] === row && debugCell[1] === col) {
          const key = `${tri.source ?? '?'} y=${y.toFixed(2)}`;
          debugSources.set(key, (debugSources.get(key) ?? 0) + 1);
        }
      }
    }
    // Remember how tall the blocking geometry is, to tell buildings from low obstacles.
    for (const v of p) {
      const col = Math.floor((v[0] - origin.x) / cs);
      const row = Math.floor((v[2] - origin.z) / cs);
      if (row < 0 || row >= height || col < 0 || col >= width) continue;
      topHeight[row * width + col] = Math.max(topHeight[row * width + col], v[1]);
    }
  }

  if (debugCell) {
    console.log(`Cell ${debugCell.join(',')} blocked by:`, [...debugSources.entries()].slice(0, 20));
  }

  for (let i = 0; i < width * height; i++) if (!floor[i]) blocked[i] = 1;

  // Largest 4-connected walkable component.
  const component = new Int32Array(width * height).fill(-1);
  const sizes: number[] = [];
  for (let start = 0; start < width * height; start++) {
    if (blocked[start] || component[start] !== -1) continue;
    const id = sizes.length;
    let size = 0;
    const queue = [start];
    component[start] = id;
    while (queue.length) {
      const cur = queue.pop()!;
      size++;
      const r = Math.floor(cur / width);
      const c = cur % width;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= height || nc < 0 || nc >= width) continue;
        const n = nr * width + nc;
        if (blocked[n] || component[n] !== -1) continue;
        component[n] = id;
        queue.push(n);
      }
    }
    sizes.push(size);
  }
  if (sizes.length === 0) throw new Error('No walkable cells found: check --band');
  const main = sizes.indexOf(Math.max(...sizes));
  const isMain = (i: number): boolean => component[i] === main;

  const bfs = (from: number): Int32Array => {
    const dist = new Int32Array(width * height).fill(-1);
    dist[from] = 0;
    const queue = [from];
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      const r = Math.floor(cur / width);
      const c = cur % width;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= height || nc < 0 || nc >= width) continue;
        const n = nr * width + nc;
        if (!isMain(n) || dist[n] !== -1) continue;
        dist[n] = dist[cur] + 1;
        queue.push(n);
      }
    }
    return dist;
  };
  const argmax = (dist: Int32Array): number => {
    let best = -1;
    for (let i = 0; i < dist.length; i++) if (dist[i] >= 0 && (best < 0 || dist[i] > dist[best])) best = i;
    return best;
  };
  const toCoord = (i: number): GridCoord => ({ row: Math.floor(i / width), col: i % width });

  // Spawn and extraction at the two ends of the longest walk.
  const firstMain = component.indexOf(main);
  const spawn = argmax(bfs(firstMain));
  const fromSpawn = bfs(spawn);
  const extraction = argmax(fromSpawn);
  const fromExtraction = bfs(extraction);
  const total = fromSpawn[extraction];

  const pickBy = (score: (i: number) => number): number => {
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < width * height; i++) {
      if (!isMain(i) || i === spawn || i === extraction) continue;
      const s = score(i);
      if (s < bestScore) {
        bestScore = s;
        best = i;
      }
    }
    return best;
  };
  const refuge = pickBy((i) => Math.abs(fromSpawn[i] - Math.min(4, Math.floor(total / 4))) + fromExtraction[i] * 0.001);
  const pharmacy = pickBy(
    (i) => Math.abs(fromSpawn[i] - fromExtraction[i]) + Math.abs(fromSpawn[i] + fromExtraction[i] - total) * 2 + (i === refuge ? 1e9 : 0)
  );

  const cells: MapCellData[] = [];
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = row * width + col;
      if (!isMain(i)) {
        const tall = topHeight[i] > 2.2;
        cells.push({
          row,
          col,
          type: tall ? 'building' : 'obstacle',
          walkable: false,
          cost: 999,
          elevation: Math.round(Math.max(topHeight[i], 1) * 100) / 100,
        });
        continue;
      }
      let type: CellType = 'street';
      if (i === refuge) type = 'refuge';
      else if (i === pharmacy) type = 'pharmacy';
      else if (i === extraction) type = 'extraction';
      cells.push({ row, col, type, walkable: true, cost: 1 });
    }
  }

  const map: MapDefinition = {
    id: opts.id,
    name: opts.name,
    width,
    height,
    cellSize: cs,
    spawnMara: toCoord(spawn),
    extractionPoint: toCoord(extraction),
    cells,
    world: {
      origin,
      asset: {
        url: opts.url,
        offset: offset.map((v) => Math.round(v * 10000) / 10000) as Vec3,
        ...(opts.scale !== 1 ? { scale: opts.scale } : {}),
      },
    },
  };
  writeFileSync(opts.output, JSON.stringify(map, null, 2) + '\n');

  const glyph: Partial<Record<CellType, string>> = { street: '.', building: '#', obstacle: 'o', refuge: 'R', pharmacy: 'F', extraction: 'X' };
  console.log(`Walkable regions (cells): ${[...sizes].sort((a, b) => b - a).slice(0, 8).join(', ')}`);
  console.log(`${opts.output}: ${width}x${height} cells of ${cs} m, ground at y=${groundY.toFixed(2)} (model), walkable=${sizes[main]}`);
  for (let row = 0; row < height; row++) {
    let line = '';
    for (let col = 0; col < width; col++) {
      const i = row * width + col;
      line += i === spawn ? 'S' : glyph[cells[i].type] ?? '?';
    }
    console.log(line);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
