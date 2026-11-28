/**
 * Composes the expanded urban district GLB and generates an aligned MapDefinition grid.
 *
 *   npx tsx scripts/generate-street-map.ts --compose [src.glb] [out.glb]
 *   npm run map:street
 *   npx tsx scripts/generate-street-map.ts <in.glb> <out.json> [--cell 1] [--band 0.35,1.9]
 *     [--scale 1] [--id map_street] [--name "..."] [--url /assets/props/street.glb]
 *
 * Grid generation workflow:
 * 1. Reads every triangle of the GLB in world space (including EXT_texture_webp assets).
 * 2. Ground level = height with the most upward-facing area.
 * 3. Places the model with its XZ center at the origin and ground at Y = 0
 *    (that offset is written to map.world.asset.offset so the renderer uses the same one).
 * 4. Samples each triangle; a cell is blocked if geometry lies inside the body band
 *    (default 0.35 m to 1.9 m above the ground). Overhead cables and curbs are ignored.
 * 5. Keeps the largest connected walkable component and selects narrative zones
 *    (spawnMara, pharmacy, refuge, extraction) with balanced BFS distances.
 * 6. Writes <out>.collision.json: the same sampling at 1/4 cell, used by the FPV player so it
 *    collides with the real wall faces instead of whole 1 m cells.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  Document,
  Extension,
  Node,
  NodeIO,
  PropertyType,
  type ReaderContext,
  type WriterContext,
} from '@gltf-transform/core';
import type { CellType, GridCoord, MapCellData, MapDefinition } from '../src/core/contracts.ts';

interface WebPTextureDef {
  source?: number;
  extensions?: {
    EXT_texture_webp?: { source?: number };
    [key: string]: unknown;
  };
}

/**
 * Minimal EXT_texture_webp extension for @gltf-transform/core so WebP textures
 * are preserved losslessly on read and write without extra packages.
 */
class ExtTextureWebP extends Extension {
  public static readonly EXTENSION_NAME = 'EXT_texture_webp';
  public readonly extensionName = ExtTextureWebP.EXTENSION_NAME;
  public readonly prereadTypes = [PropertyType.TEXTURE];

  public override preread(context: ReaderContext, _propertyType: PropertyType): this {
    const textureDefs = (context.jsonDoc.json.textures ?? []) as WebPTextureDef[];
    for (const texDef of textureDefs) {
      const ext = texDef.extensions?.EXT_texture_webp;
      if (ext && typeof ext.source === 'number' && texDef.source === undefined) {
        texDef.source = ext.source;
      }
    }
    return this;
  }

  public read(_context: ReaderContext): this {
    return this;
  }

  public write(context: WriterContext): this {
    const json = context.jsonDoc.json;
    const images = json.images ?? [];
    const textureDefs = (json.textures ?? []) as WebPTextureDef[];
    for (const texDef of textureDefs) {
      if (texDef.source === undefined) continue;
      const imageDef = images[texDef.source];
      if (imageDef?.mimeType !== 'image/webp') continue;
      texDef.extensions = texDef.extensions ?? {};
      texDef.extensions[ExtTextureWebP.EXTENSION_NAME] = { source: texDef.source };
      delete texDef.source;
    }
    return this;
  }
}

function createIO(): NodeIO {
  return new NodeIO().registerExtensions([ExtTextureWebP]);
}

interface Options {
  compose: boolean;
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
  let compose = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--compose') {
      compose = true;
    } else if (arg.startsWith('--')) {
      flags.set(arg.slice(2), argv[i + 1] ?? '');
      i++;
    } else {
      positional.push(arg);
    }
  }
  const defaultInput = compose
    ? 'public/assets/props/abandoned_city_street_for_games.glb'
    : 'public/assets/props/street.glb';
  const defaultOutput = compose
    ? 'public/assets/props/street.glb'
    : 'public/maps/map_street.json';
  const [input = defaultInput, output = defaultOutput] = positional;
  const [bandLow, bandHigh] = (flags.get('band') ?? '0.35,1.9').split(',').map(Number);
  return {
    compose,
    input,
    output,
    cellSize: Number(flags.get('cell') ?? 1),
    scale: Number(flags.get('scale') ?? 1),
    bandLow,
    bandHigh,
    id: flags.get('id') ?? 'map_street',
    name: flags.get('name') ?? 'Distrito urbano (street.glb)',
    url: flags.get('url') ?? '/' + input.replace(/^public\//, ''),
  };
}

// Base ground plane (Plane.002) center and width in source model coordinates.
const BASE_FLOOR_CENTER_X = 0.34;
const BASE_FLOOR_CENTER_Z = 0.39;
// Ground plane width is 15.84; 15.80 gives a tight 0.04 overlap (8 cm at scale 2) with no cracks.
const DISTRICT_PITCH_X = 15.8;

// Nodes omitted from every tile: out-of-floor backdrop, interior fences, and alley-blocking pole.
const ALWAYS_OMIT_NODES = [
  'Cube.048',
  'Cube.053',
  'Cube.059',
  'Cube.061',
  'Cube.068',
  'Plane.013',
  'Plane',
  'Plane.001',
  'Plane.005',
  'Plane.006',
  'Plane.007',
  'Plane.008',
  'Cube.063',
];

// Nodes omitted along the shared interior seam so multi-lane avenues connect both blocks.
// Perimeter caps (Cube.014, Cube.040, Cube.041) and twin central cover blocks (Cube.020, Cube.022) stay.
const SEAM_OMIT_NODES = [
  'Cube.016_Material.003_0',
  'Cube.015',
  'Cube.017',
  'Cube.018',
  'Cube.019',
  'Cube.021',
  'Cube.023',
  'node_0.001',
  'Cube.066',
];

function cloneNodeSubtree(doc: Document, source: Node, omitNames: Set<string>, suffix: string): Node | null {
  if (omitNames.has(source.getName())) return null;
  const clone = doc.createNode(source.getName() ? `${source.getName()}${suffix}` : '');
  clone.setTranslation(source.getTranslation());
  clone.setRotation(source.getRotation());
  clone.setScale(source.getScale());
  const mesh = source.getMesh();
  if (mesh) clone.setMesh(mesh);
  for (const child of source.listChildren()) {
    const clonedChild = cloneNodeSubtree(doc, child, omitNames, suffix);
    if (clonedChild) clone.addChild(clonedChild);
  }
  return clone;
}

/**
 * Builds a connected 2x1 urban district GLB from the base street asset,
 * reusing all meshes, materials and WebP textures by reference.
 */
async function composeDistrict(inputPath: string, outputPath: string): Promise<void> {
  const io = createIO();
  const doc = await io.readBinary(new Uint8Array(readFileSync(inputPath)));
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const origRoot = scene.listChildren()[0];
  if (!origRoot) throw new Error(`No root node found in ${inputPath}`);

  scene.removeChild(origRoot);
  const omit = new Set([...ALWAYS_OMIT_NODES, ...SEAM_OMIT_NODES]);

  const tiles = [
    { name: 'W', tx: -DISTRICT_PITCH_X / 2, ty: 0, rotDeg: 0 },
    // 0.001 Y lift avoids floor z-fighting on the 8 cm seam overlap while staying invisible.
    { name: 'E', tx: DISTRICT_PITCH_X / 2, ty: 0.001, rotDeg: 180 },
  ];

  for (const tile of tiles) {
    const wrapper = doc.createNode(`District_Tile_${tile.name}`);
    wrapper.setTranslation([tile.tx, tile.ty, 0]);
    const rad = (tile.rotDeg * Math.PI) / 180;
    wrapper.setRotation([0, Math.sin(rad / 2), 0, Math.cos(rad / 2)]);

    const recenter = doc.createNode(`District_Recenter_${tile.name}`);
    recenter.setTranslation([-BASE_FLOOR_CENTER_X, 0, -BASE_FLOOR_CENTER_Z]);

    const cloned = cloneNodeSubtree(doc, origRoot, omit, `_${tile.name}`);
    if (cloned) recenter.addChild(cloned);
    wrapper.addChild(recenter);
    scene.addChild(wrapper);
  }

  // Dispose only the unreferenced template nodes; shared meshes/materials/textures remain intact.
  origRoot.traverse((n) => n.dispose());

  const glb = await io.writeBinary(doc);
  writeFileSync(outputPath, glb);

  const sizeMb = glb.byteLength / (1024 * 1024);
  console.log(
    `Composed ${outputPath}: ${sizeMb.toFixed(2)} MB (${glb.byteLength} bytes), ` +
      `meshes=${root.listMeshes().length}, materials=${root.listMaterials().length}, ` +
      `textures=${root.listTextures().length}, nodes=${root.listNodes().length}`
  );
}

type Vec3 = [number, number, number];
type Triangle = [Vec3, Vec3, Vec3] & { source?: string };

async function readTriangles(path: string): Promise<Triangle[]> {
  const io = createIO();
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

interface NarrativeZones {
  spawn: number;
  pharmacy: number;
  refuge: number;
  extraction: number;
}

function pickNarrativeZones(
  width: number,
  height: number,
  isMain: (i: number) => boolean,
  firstMain: number
): NarrativeZones {
  const dirs: readonly [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  const bfs = (from: number, forbidden = -1): Int32Array => {
    const dist = new Int32Array(width * height).fill(-1);
    if (from === forbidden) return dist;
    dist[from] = 0;
    const queue = [from];
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      const r = Math.floor(cur / width);
      const c = cur % width;
      for (const [dr, dc] of dirs) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= height || nc < 0 || nc >= width) continue;
        const n = nr * width + nc;
        if (n === forbidden || !isMain(n) || dist[n] !== -1) continue;
        dist[n] = dist[cur] + 1;
        queue.push(n);
      }
    }
    return dist;
  };

  const argmax = (dist: Int32Array): number => {
    let best = -1;
    for (let i = 0; i < dist.length; i++) {
      if (dist[i] >= 0 && (best < 0 || dist[i] > dist[best])) best = i;
    }
    return best;
  };

  const degree = (i: number): number => {
    const r = Math.floor(i / width);
    const c = i % width;
    let deg = 0;
    for (const [dr, dc] of dirs) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < height && nc >= 0 && nc < width && isMain(nr * width + nc)) deg++;
    }
    return deg;
  };

  // True if blocking the first step along a shortest path still leaves an alternate route.
  const hasAlternateRoute = (from: number, to: number, distToTarget: Int32Array): boolean => {
    const d = distToTarget[from];
    if (d <= 1) return false;
    const r = Math.floor(from / width);
    const c = from % width;
    let firstStep = -1;
    for (const [dr, dc] of dirs) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr < 0 || nr >= height || nc < 0 || nc >= width) continue;
      const n = nr * width + nc;
      if (isMain(n) && distToTarget[n] === d - 1) {
        firstStep = n;
        break;
      }
    }
    if (firstStep < 0) return false;
    return bfs(from, firstStep)[to] >= 0;
  };

  // 1. Find diameter endpoints; place spawn on the western/southern end and extraction opposite.
  const endA = argmax(bfs(firstMain));
  const endB = argmax(bfs(endA));
  const colA = endA % width;
  const colB = endB % width;
  const rowA = Math.floor(endA / width);
  const rowB = Math.floor(endB / width);
  const aIsWest = colA < colB || (colA === colB && rowA >= rowB);
  const spawnAnchor = aIsWest ? endA : endB;
  const extAnchor = aIsWest ? endB : endA;

  const pickNearAnchor = (anchor: number, exclude: number): number => {
    const dist = bfs(anchor);
    let best = anchor;
    let bestScore = Infinity;
    for (let i = 0; i < width * height; i++) {
      if (!isMain(i) || i === exclude || dist[i] < 0 || dist[i] > 5) continue;
      const deg = degree(i);
      const walls = 4 - deg;
      if (deg < 2) continue;
      // Prefer street edge with nearby cover (1-2 walls) and breathing room (deg >= 2).
      const coverPenalty = walls >= 1 && walls <= 2 ? 0 : 4;
      const score = dist[i] * 1.5 + coverPenalty;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  };

  const spawn = pickNearAnchor(spawnAnchor, -1);
  const extraction = pickNearAnchor(extAnchor, spawn);
  const fromSpawn = bfs(spawn);
  const fromExtraction = bfs(extraction);
  const total = fromSpawn[extraction];

  const centerRow = Math.floor(height / 2);
  const centerCol = Math.floor(width / 2);
  const distToCenter = (i: number): number =>
    Math.hypot(Math.floor(i / width) - centerRow, (i % width) - centerCol);

  const pickBy = (score: (i: number) => number, excluded: Set<number>): number => {
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < width * height; i++) {
      if (!isMain(i) || excluded.has(i)) continue;
      const s = score(i);
      if (s < bestScore) {
        bestScore = s;
        best = i;
      }
    }
    return best;
  };

  // 2. Pharmacy (Scene 2): intermediate storefront/courtyard at ~25-45% of journey from spawn.
  const pharmacyTarget = Math.max(4, Math.round(total * 0.35));
  const pharmacyMin = Math.max(2, Math.floor(total * 0.25));
  const pharmacyMax = Math.max(pharmacyMin + 2, Math.ceil(total * 0.45));
  const pharmacy = pickBy((i) => {
    const ds = fromSpawn[i];
    const de = fromExtraction[i];
    const deg = degree(i);
    const walls = 4 - deg;
    const r = Math.floor(i / width);
    let penalty = Math.abs(ds - pharmacyTarget) * 3;
    if (ds < pharmacyMin || ds > pharmacyMax) penalty += 100;
    // Keep clear of central crossroads (Scene 3) and prefer storefront wall + multi-route access.
    if (distToCenter(i) < 10) penalty += (10 - distToCenter(i)) * 4;
    if (walls < 1 || walls > 2) penalty += 12;
    if (deg < 2) penalty += 30;
    // Favor the northern intermediate street/courtyard for clean narrative progression.
    if (r > height * 0.45) penalty += 8;
    // Slight preference for staying close to the main progression corridor.
    penalty += Math.abs(ds + de - total) * 0.35;
    return penalty;
  }, new Set([spawn, extraction]));

  const fromPharmacy = bfs(pharmacy);

  // 3. Refuge (Scene 4): defendable courtyard pocket connected by multiple routes,
  //    18-36 BFS steps from extraction so the 45-tick window is tense yet achievable.
  const refugeExtMin = total >= 24 ? 18 : Math.max(4, Math.floor(total * 0.3));
  const refugeExtMax = total >= 24 ? 36 : Math.max(refugeExtMin + 4, Math.floor(total * 0.75));
  const refugeExtTarget = Math.min(30, Math.max(22, Math.round(total * 0.38)));

  const refuge = pickBy((i) => {
    const ds = fromSpawn[i];
    const de = fromExtraction[i];
    const dp = fromPharmacy[i];
    const deg = degree(i);
    const walls = 4 - deg;
    const r = Math.floor(i / width);
    let penalty = Math.abs(de - refugeExtTarget) * 2.5;
    if (de < refugeExtMin || de > refugeExtMax) penalty += 200;
    if (ds < total * 0.45) penalty += 40;
    if (dp < 14) penalty += (14 - dp) * 5;
    // Keep away from the geometric center reserved for Scene 3 pickups.
    if (distToCenter(i) < 9) penalty += (9 - distToCenter(i)) * 5;
    // Defendable courtyard pocket: adjacent to 1-2 walls and connected by multiple routes.
    if (walls < 1 || walls > 2) penalty += 15;
    if (deg < 2) penalty += 50;
    if (!hasAlternateRoute(i, extraction, fromExtraction)) penalty += 120;
    // Favor southern courtyard opposite pharmacy so the 5 scenes trace a full urban arc.
    if (r < height * 0.65) penalty += 10;
    return penalty;
  }, new Set([spawn, extraction, pharmacy]));

  return { spawn, pharmacy, refuge, extraction };
}

/** Upward-facing enough to stand on. */
function isFlatFloor(p: Vec3[]): boolean {
  const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2];
  const vx = p[2][0] - p[0][0], vy = p[2][1] - p[0][1], vz = p[2][2] - p[0][2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  return len >= 1e-9 && Math.abs(ny / len) >= 0.75;
}

async function generateMap(opts: Options): Promise<void> {
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
    if (!isFlatFloor(p)) return;
    const ux = p[1][0] - p[0][0], uz = p[1][2] - p[0][2];
    const vx = p[2][0] - p[0][0], vz = p[2][2] - p[0][2];
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
    // Lower bound -1.2 covers uneven asphalt/puddle depressions in the street ground mesh.
    if (yMax < 0.3 && yMin > -1.2) markFloor(p);
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
  const toCoord = (i: number): GridCoord => ({ row: Math.floor(i / width), col: i % width });

  // Player collision mask at 1/4 cell. Open: every sub-cell of a walkable cell, plus the free,
  // floored sub-cells of blocked cells that touch the walkable area (the strip in front of a
  // wall that only grazes its cell). Only the part reachable from the walkable area is kept.
  const fine = 4;
  const fcs = cs / fine;
  const fw = width * fine;
  const fh = height * fine;
  const fineBlocked = new Uint8Array(fw * fh);
  const fineFloor = new Uint8Array(fw * fh);
  const fineStep = fcs / 2;
  const sampleTriangle = (p: Vec3[], visit: (x: number, y: number, z: number) => void): void => {
    const edge = Math.max(
      Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]),
      Math.hypot(p[2][0] - p[1][0], p[2][1] - p[1][1], p[2][2] - p[1][2]),
      Math.hypot(p[0][0] - p[2][0], p[0][1] - p[2][1], p[0][2] - p[2][2])
    );
    const k = Math.max(1, Math.ceil(edge / fineStep));
    for (let i = 0; i <= k; i++) {
      for (let j = 0; j <= k - i; j++) {
        const u = i / k, v = j / k, w = 1 - u - v;
        visit(
          p[0][0] * w + p[1][0] * u + p[2][0] * v,
          p[0][1] * w + p[1][1] * u + p[2][1] * v,
          p[0][2] * w + p[1][2] * u + p[2][2] * v
        );
      }
    }
  };
  const fineIndex = (x: number, z: number): number => {
    const fc = Math.floor((x - origin.x) / fcs);
    const fr = Math.floor((z - origin.z) / fcs);
    return fr < 0 || fr >= fh || fc < 0 || fc >= fw ? -1 : fr * fw + fc;
  };
  for (const tri of triangles) {
    const p = tri.map((v) => [v[0] + offset[0], v[1] + offset[1], v[2] + offset[2]] as Vec3);
    const yMin = Math.min(p[0][1], p[1][1], p[2][1]);
    const yMax = Math.max(p[0][1], p[1][1], p[2][1]);
    if (yMax < 0.3 && yMin > -1.2 && isFlatFloor(p)) {
      sampleTriangle(p, (x, _y, z) => {
        const i = fineIndex(x, z);
        if (i >= 0) fineFloor[i] = 1;
      });
    }
    if (yMax < opts.bandLow || yMin > opts.bandHigh) continue;
    sampleTriangle(p, (x, y, z) => {
      if (y < opts.bandLow || y > opts.bandHigh) return;
      const i = fineIndex(x, z);
      if (i >= 0) fineBlocked[i] = 1;
    });
  }
  const touchesMain = (row: number, col: number): boolean => {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const r = row + dr, c = col + dc;
        if (r >= 0 && r < height && c >= 0 && c < width && isMain(r * width + c)) return true;
      }
    }
    return false;
  };
  const fineOpen = new Uint8Array(fw * fh);
  for (let fr = 0; fr < fh; fr++) {
    for (let fc = 0; fc < fw; fc++) {
      const row = Math.floor(fr / fine), col = Math.floor(fc / fine);
      const parent = row * width + col;
      const i = fr * fw + fc;
      fineOpen[i] = isMain(parent) ||
        (floor[parent] && touchesMain(row, col) && !fineBlocked[i] && fineFloor[i]) ? 1 : 0;
    }
  }
  const mainStart = component.indexOf(main);
  const fineStart = (Math.floor(mainStart / width) * fine) * fw + (mainStart % width) * fine;
  const fineReach = new Uint8Array(fw * fh);
  fineReach[fineStart] = 1;
  for (const queue = [fineStart]; queue.length;) {
    const cur = queue.pop()!;
    const r = Math.floor(cur / fw), c = cur % fw;
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= fh || nc < 0 || nc >= fw) continue;
      const n = nr * fw + nc;
      if (!fineOpen[n] || fineReach[n]) continue;
      fineReach[n] = 1;
      queue.push(n);
    }
  }

  const { spawn, pharmacy, refuge, extraction } = pickNarrativeZones(
    width,
    height,
    isMain,
    component.indexOf(main)
  );

  // Measure BFS distances between narrative zones for verification output.
  const bfsDist = (from: number): Int32Array => {
    const dist = new Int32Array(width * height).fill(-1);
    dist[from] = 0;
    const q = [from];
    for (let head = 0; head < q.length; head++) {
      const cur = q[head];
      const r = Math.floor(cur / width);
      const c = cur % width;
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= height || nc < 0 || nc >= width) continue;
        const n = nr * width + nc;
        if (!isMain(n) || dist[n] !== -1) continue;
        dist[n] = dist[cur] + 1;
        q.push(n);
      }
    }
    return dist;
  };
  const dSpawn = bfsDist(spawn);
  const dPharm = bfsDist(pharmacy);
  const dRefuge = bfsDist(refuge);

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
  const collisionPath = opts.output.replace(/\.json$/, '') + '.collision.json';
  const rows: string[] = [];
  for (let fr = 0; fr < fh; fr++) {
    let line = '';
    for (let fc = 0; fc < fw; fc++) line += fineReach[fr * fw + fc] ? '.' : '#';
    rows.push(line);
  }
  writeFileSync(collisionPath, JSON.stringify({ cellSize: fcs, width: fw, height: fh, origin, rows }) + '\n');

  const glyph: Partial<Record<CellType, string>> = {
    street: '.',
    building: '#',
    obstacle: 'o',
    refuge: 'R',
    pharmacy: 'F',
    extraction: 'X',
  };
  console.log(`Walkable regions (cells): ${[...sizes].sort((a, b) => b - a).slice(0, 8).join(', ')}`);
  console.log(
    `${opts.output}: ${width}x${height} cells of ${cs} m, ground at y=${groundY.toFixed(2)} (model), walkable=${sizes[main]}`
  );
  console.log(
    `Zones: spawn=(${toCoord(spawn).row},${toCoord(spawn).col}) ` +
      `pharmacy=(${toCoord(pharmacy).row},${toCoord(pharmacy).col}) ` +
      `refuge=(${toCoord(refuge).row},${toCoord(refuge).col}) ` +
      `extraction=(${toCoord(extraction).row},${toCoord(extraction).col})`
  );
  console.log(
    `BFS distances: spawn->pharmacy=${dSpawn[pharmacy]}, pharmacy->refuge=${dPharm[refuge]}, ` +
      `refuge->extraction=${dRefuge[extraction]}, spawn->extraction=${dSpawn[extraction]}`
  );
  for (let row = 0; row < height; row++) {
    let line = '';
    for (let col = 0; col < width; col++) {
      const i = row * width + col;
      line += i === spawn ? 'S' : glyph[cells[i].type] ?? '?';
    }
    console.log(line);
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.compose) {
    await composeDistrict(opts.input, opts.output);
    return;
  }
  await generateMap(opts);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
