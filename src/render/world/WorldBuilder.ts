import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { GridCoord, MapDefinition } from '../../core/contracts.ts';
import { createWalkableLookup, getGridExtent, gridToWorld } from '../../core/world/gridSpace.ts';

import { landmark, streetLamp } from './props.ts';

const sides = [{ row: -1, col: 0 }, { row: 1, col: 0 }, { row: 0, col: -1 }, { row: 0, col: 1 }];
type Edge = { cell: GridCoord; side: GridCoord };
const distanceSq = (a: GridCoord, b: GridCoord) => (a.row - b.row) ** 2 + (a.col - b.col) ** 2;

export class WorldBuilder {
  readonly root = new THREE.Group();
  private readonly collidables: THREE.Object3D[] = [];
  private gridOverlay: THREE.Group | null = null;

  constructor(private readonly scene: THREE.Scene) {
    this.root.name = 'world';
    this.scene.add(this.root);
  }

  async build(map: MapDefinition): Promise<void> {
    if (map.world?.asset) {
      try {
        await this.loadAsset(map);
      } catch (error) {
        console.warn(`[WorldBuilder] Could not load ${map.world.asset.url}; using grid blocks.`, error);
        this.buildBlocks(map);
      }
    } else {
      this.buildBlocks(map);
    }
    this.addStreetFixtures(map);
    this.gridOverlay = this.createGridOverlay(map);
    this.gridOverlay.visible = false;
    this.root.add(this.gridOverlay);
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
    const gltf = await new GLTFLoader().loadAsync(asset.url);
    const model = gltf.scene;
    model.position.set(asset.offset[0], asset.offset[1], asset.offset[2]);
    model.scale.setScalar(asset.scale ?? 1);
    model.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
      }
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

  private addStreetFixtures(map: MapDefinition): void {
    const walkable = createWalkableLookup(map);
    const edges: Edge[] = [];
    for (const cell of map.cells) {
      if (!cell.walkable) continue;
      const side = sides.find(d => !walkable({ row: cell.row + d.row, col: cell.col + d.col }));
      if (side) edges.push({ cell, side });
    }
    if (!edges.length) return;

    const mount = (model: THREE.Group, { cell, side }: Edge, inset: number) => {
      const center = gridToWorld(cell, map);
      const offset = map.cellSize / 2 - inset;
      model.position.set(center.x + side.col * offset, 0, center.z + side.row * offset);
      model.rotation.y = Math.atan2(-side.col, -side.row);
      this.root.add(model);
      this.collidables.push(model);
    };

    const reserved: GridCoord[] = [];
    for (const kind of ['pharmacy', 'refuge', 'extraction'] as const) {
      const cell = kind === 'extraction' ? map.extractionPoint : map.cells.find(c => c.type === kind);
      if (!cell) continue;
      const edge = edges.reduce((best, e) => distanceSq(e.cell, cell) < distanceSq(best.cell, cell) ? e : best);
      const model = landmark(kind);
      model.scale.x = Math.min(1, map.cellSize / 1.75);
      mount(model, edge, 0.09);
      if (kind === 'extraction') {
        const ring = model.getObjectByName('extraction-ring')!;
        const center = gridToWorld(cell, map);
        this.root.add(ring);
        ring.position.set(center.x, 0.045, center.z);
      }
      reserved.push(edge.cell);
    }

    // Put each lamp in the widest remaining gap between light pools.
    const sites = edges.map(edge => ({ edge, clearance: Math.min(...reserved.map(c => distanceSq(c, edge.cell))) }));
    for (let i = 0; i < 10; i++) {
      const site = sites.reduce((best, s) => s.clearance > best.clearance ? s : best);
      if (site.clearance * map.cellSize ** 2 < 9) break;
      mount(streetLamp(), site.edge, 0.06);
      for (const s of sites) s.clearance = Math.min(s.clearance, distanceSq(s.edge.cell, site.edge.cell));
    }
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
