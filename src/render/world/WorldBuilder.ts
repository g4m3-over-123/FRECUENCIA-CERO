import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GridCoord, MapDefinition } from '../../core/contracts.ts';
import { createWalkableLookup, getGridExtent, gridToWorld } from '../../core/world/gridSpace.ts';

import { CollisionMask } from './collisionMask.ts';
import { landmark, mountPharmacyInterior, streetLamps } from './props.ts';

/** street.glb ground mesh: its road sits up to 0.85 m below the sidewalks. */
const GROUND_MESH = /^Plane\.?002(?:_|$)/i;
/** The game treats the ground as flat at Y = 0, so the sunken road is raised to this height. */
const ROAD_SURFACE_Y = -0.04;
/** Props taller than this above the ground block the player (same band as the map generator). */
const BODY_BAND = { low: 0.1, high: 1.9 };
const LAMP_POLE_HALF = 0.08;

function freezeTransform(obj: THREE.Object3D): void {
  obj.updateMatrix();
  obj.matrixAutoUpdate = false;
}

const sides = [{ row: -1, col: 0 }, { row: 1, col: 0 }, { row: 0, col: -1 }, { row: 0, col: 1 }];
type Edge = { cell: GridCoord; side: GridCoord };
const distanceSq = (a: GridCoord, b: GridCoord) => (a.row - b.row) ** 2 + (a.col - b.col) ** 2;

export class WorldBuilder {
  readonly root = new THREE.Group();
  private readonly collidables: THREE.Object3D[] = [];
  private gridOverlay: THREE.Group | null = null;
  private collision: CollisionMask | null = null;

  constructor(private readonly scene: THREE.Scene) {
    this.root.name = 'world';
    this.scene.add(this.root);
  }

  async build(map: MapDefinition): Promise<void> {
    if (map.world?.asset) {
      try {
        [, this.collision] = await Promise.all([
          this.loadAsset(map),
          CollisionMask.load(`${import.meta.env.BASE_URL}maps/${map.id}.collision.json`),
        ]);
      } catch (error) {
        console.warn(`[WorldBuilder] Could not load ${map.world.asset.url}; using grid blocks.`, error);
        this.buildBlocks(map);
      }
    } else {
      this.buildBlocks(map);
    }
    const pharmacy = map.id === 'map_street' ? await this.loadPharmacyInterior() : undefined;
    this.addStreetFixtures(map, pharmacy);
    this.gridOverlay = this.createGridOverlay(map);
    this.gridOverlay.visible = false;
    this.root.add(this.gridOverlay);
  }

  /** Fine player collision for the GLB map, or null to collide with whole grid cells. */
  getPlayerCollision(): CollisionMask | null {
    return this.collision;
  }

  /** Meshes that stop bullets (used by the weapon raycast). */
  getCollidables(): THREE.Object3D[] {
    return this.collidables;
  }

  /** Debug: draws walkable (cyan) and blocked (red) cells. Key G in the game. */
  toggleGridOverlay(): boolean {
    if (!this.gridOverlay) return false;
    this.gridOverlay.visible = !this.gridOverlay.visible;
    return this.gridOverlay.visible;
  }

  private async loadAsset(map: MapDefinition): Promise<void> {
    const asset = map.world!.asset!;
    const assetUrl = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(asset.url)
      ? asset.url
      : `${import.meta.env.BASE_URL}${asset.url.replace(/^\//, '')}`;
    const gltf = await new GLTFLoader().loadAsync(assetUrl);
    const model = gltf.scene;
    model.position.set(asset.offset[0], asset.offset[1], asset.offset[2]);
    model.scale.setScalar(asset.scale ?? 1);
    model.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = !/^Plane\.?(002|009|01[0-5])(?:_|$)/i.test(obj.name);
        obj.receiveShadow = true;
      }
      freezeTransform(obj);
    });
    model.updateMatrixWorld(true);
    model.traverse((obj) => {
      if (obj instanceof THREE.Mesh && GROUND_MESH.test(obj.name)) raiseRoad(obj);
    });
    this.root.add(model);
    this.collidables.push(model);
  }

  private buildBlocks(map: MapDefinition): void {
    const extent = getGridExtent(map);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(extent.max.x - extent.min.x, extent.max.z - extent.min.z),
      new THREE.MeshStandardMaterial({ color: 0x1b222c, roughness: 0.95 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set((extent.min.x + extent.max.x) / 2, 0, (extent.min.z + extent.max.z) / 2);
    floor.receiveShadow = true;
    this.root.add(floor);

    const building = new THREE.MeshStandardMaterial({ color: 0x343c4a, roughness: 0.85 });
    const obstacle = new THREE.MeshStandardMaterial({ color: 0x5a4636, roughness: 0.8 });
    const blocked = map.cells.filter((c) => !c.walkable);
    const box = new THREE.BoxGeometry(1, 1, 1);
    for (const [material, cells] of [
      [building, blocked.filter((c) => c.type !== 'obstacle')],
      [obstacle, blocked.filter((c) => c.type === 'obstacle')],
    ] as const) {
      if (cells.length === 0) continue;
      const mesh = new THREE.InstancedMesh(box, material, cells.length);
      const m = new THREE.Matrix4();
      cells.forEach((cell, i) => {
        const height = cell.elevation ?? (cell.type === 'obstacle' ? 1.2 : 5);
        const p = gridToWorld(cell, map);
        m.compose(
          new THREE.Vector3(p.x, height / 2, p.z),
          new THREE.Quaternion(),
          new THREE.Vector3(map.cellSize, height, map.cellSize)
        );
        mesh.setMatrixAt(i, m);
      });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.root.add(mesh);
      this.collidables.push(mesh);
    }
  }

  private async loadPharmacyInterior(): Promise<THREE.Group | undefined> {
    try {
      const url = import.meta.env.BASE_URL + 'assets/props/pharmacy_interior.glb';
      return (await new GLTFLoader().loadAsync(url)).scene;
    } catch (error) {
      console.warn('[WorldBuilder] Could not load the pharmacy interior.', error);
      return undefined;
    }
  }

  private addStreetFixtures(map: MapDefinition, pharmacy?: THREE.Group): void {
    const walkable = createWalkableLookup(map);
    const edges: Edge[] = [];
    const clinic = pharmacy ? map.cells.find(cell => cell.type === 'pharmacy') : undefined;
    for (const cell of map.cells) {
      if (!cell.walkable) continue;
      if (clinic && cell.row >= clinic.row - 5 && cell.row <= clinic.row + 1 &&
        cell.col >= clinic.col - 2 && cell.col <= clinic.col + 3) continue;
      const side = sides.find(d => !walkable({ row: cell.row + d.row, col: cell.col + d.col }));
      if (side) edges.push({ cell, side });
    }
    if (!edges.length) return;

    const place = (model: THREE.Object3D, { cell, side }: Edge, inset: number) => {
      const center = gridToWorld(cell, map);
      const offset = map.cellSize / 2 - inset;
      model.position.set(center.x + side.col * offset, 0, center.z + side.row * offset);
      model.rotation.y = Math.atan2(-side.col, -side.row);
      model.updateMatrix();
    };

    const reserved: GridCoord[] = [];
    for (const kind of ['pharmacy', 'refuge', 'extraction'] as const) {
      const cell = kind === 'extraction' ? map.extractionPoint : map.cells.find(c => c.type === kind);
      if (!cell) continue;
      const edge = edges.reduce((best, e) => distanceSq(e.cell, cell) < distanceSq(best.cell, cell) ? e : best);
      const model = landmark(kind);
      if (kind === 'pharmacy' && pharmacy) {
        const entranceCell = { row: cell.row - 6, col: cell.col };
        const entrance = gridToWorld(entranceCell, map);
        model.position.set(entrance.x, 0, entrance.z + 0.58);
        model.rotation.y = Math.PI;
        const room = mountPharmacyInterior(model, pharmacy);
        const roomCenter = gridToWorld(cell, map);
        room.position.set(roomCenter.x, 0, roomCenter.z);
        room.rotation.y = -Math.PI / 2;
        this.root.add(room);
        this.collidables.push(room);
        reserved.push(entranceCell);
      } else {
        place(model, edge, 0.09);
        this.blockProp(model);
        reserved.push(edge.cell);
      }
      this.root.add(model);
      this.collidables.push(model);
      if (kind === 'extraction') {
        const ring = model.getObjectByName('extraction-ring')!;
        const center = gridToWorld(cell, map);
        this.root.add(ring);
        ring.position.set(center.x, 0.045, center.z);
      }
      model.traverse(obj => {
        if (obj.name !== 'extraction-lens' && obj.name !== 'radio-indicator') freezeTransform(obj);
      });
    }

    // Put each lamp in the widest remaining gap between light pools.
    const sites = edges.map(edge => ({ edge, clearance: Math.min(...reserved.map(c => distanceSq(c, edge.cell))) }));
    const mounts: THREE.Matrix4[] = [];
    const placement = new THREE.Object3D();
    for (let i = 0; i < 6; i++) {
      const site = sites.reduce((best, s) => s.clearance > best.clearance ? s : best);
      if (site.clearance * map.cellSize ** 2 < 9) break;
      place(placement, site.edge, 0.06);
      mounts.push(placement.matrix.clone());
      for (const s of sites) s.clearance = Math.min(s.clearance, distanceSq(s.edge.cell, site.edge.cell));
    }
    if (mounts.length) {
      const pole = new THREE.Vector3();
      for (const mount of mounts) {
        pole.setFromMatrixPosition(mount);
        this.collision?.stamp(pole.x - LAMP_POLE_HALF, pole.z - LAMP_POLE_HALF, pole.x + LAMP_POLE_HALF, pole.z + LAMP_POLE_HALF);
      }
      const lamps = streetLamps(mounts);
      lamps.traverse(freezeTransform);
      this.root.add(lamps);
      this.collidables.push(lamps);
    }
  }

  /** Stamps the body-height parts of a runtime prop into the player collision mask. */
  private blockProp(model: THREE.Object3D): void {
    if (!this.collision) return;
    model.updateWorldMatrix(true, true);
    const box = new THREE.Box3();
    model.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      box.setFromObject(obj);
      if (box.max.y < BODY_BAND.low || box.min.y > BODY_BAND.high) return;
      this.collision!.stamp(box.min.x, box.min.z, box.max.x, box.max.z);
    });
  }

  private createGridOverlay(map: MapDefinition): THREE.Group {
    const group = new THREE.Group();
    group.name = 'grid-overlay';
    const square = new THREE.PlaneGeometry(map.cellSize * 0.9, map.cellSize * 0.9);
    square.rotateX(-Math.PI / 2);
    const make = (cells: GridCoord[], color: number): void => {
      if (cells.length === 0) return;
      const mesh = new THREE.InstancedMesh(
        square,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, depthWrite: false }),
        cells.length
      );
      const m = new THREE.Matrix4();
      cells.forEach((cell, i) => {
        const p = gridToWorld(cell, map);
        m.makeTranslation(p.x, 0.04, p.z);
        mesh.setMatrixAt(i, m);
      });
      group.add(mesh);
    };
    make(map.cells.filter((c) => c.walkable), 0x22d3ee);
    make(map.cells.filter((c) => !c.walkable), 0xef4444);
    return group;
  }
}

/** Lifts every ground vertex below ROAD_SURFACE_Y up to it, in world space. */
function raiseRoad(mesh: THREE.Mesh): void {
  const geometry = mesh.geometry.clone();
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  const toLocal = mesh.matrixWorld.clone().invert();
  const v = new THREE.Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
    if (v.y >= ROAD_SURFACE_Y) continue;
    v.y = ROAD_SURFACE_Y;
    v.applyMatrix4(toLocal);
    position.setXYZ(i, v.x, v.y, v.z);
  }
  position.needsUpdate = true;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  mesh.geometry = geometry;
}
