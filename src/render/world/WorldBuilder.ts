import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { CellType, GridCoord, MapDefinition } from '../../core/contracts.ts';
import { getGridExtent, gridToWorld } from '../../core/world/gridSpace.ts';

/**
 * Phase 0 world: places the map's GLB exactly where the grid generator measured it
 * (map.world.asset) or, when a map has no asset, raises simple blocks from the grid.
 * Front A (world) owns this file: zone lighting, scene presets, props, performance.
 */

const ZONE_LIGHTS: Partial<Record<CellType, { color: number; intensity: number }>> = {
  pharmacy: { color: 0x4dff9a, intensity: 14 },
  refuge: { color: 0xffb066, intensity: 16 },
  extraction: { color: 0xff3b3b, intensity: 18 },
};

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
    this.addZoneLights(map);
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
    if (asset.scale) model.scale.setScalar(asset.scale);
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

  private addZoneLights(map: MapDefinition): void {
    const placed = new Set<CellType>();
    for (const cell of map.cells) {
      const zone = ZONE_LIGHTS[cell.type];
      if (!zone || placed.has(cell.type)) continue;
      placed.add(cell.type);
      const p = gridToWorld(cell, map);
      const light = new THREE.PointLight(zone.color, zone.intensity, 12 * map.cellSize, 1.6);
      light.position.set(p.x, 3, p.z);
      light.name = `zone-light-${cell.type}`;
      this.root.add(light);
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
