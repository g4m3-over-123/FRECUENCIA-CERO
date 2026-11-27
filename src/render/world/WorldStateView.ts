import * as THREE from 'three';
import type { MapDefinition } from '../../core/contracts.ts';
import type { ExtendedWorldSnapshot } from '../../core/gameplay/SimulationEngine.ts';
import { gridToWorld } from '../../core/world/gridSpace.ts';

/**
 * Dynamic world objects driven by the snapshot: pickups, barricades and decoys.
 * Phase 0 uses simple shapes; front A replaces them with props (keep the update signature).
 */

const PICKUP_COLORS = { medicine: 0x4ade80, fuel: 0xf59e0b, battery: 0x60a5fa } as const;

export class WorldStateView {
  private readonly group = new THREE.Group();
  private readonly pickups = new Map<string, THREE.Mesh>();
  private readonly barricades = new Map<string, THREE.Mesh>();
  private readonly decoys = new Map<string, THREE.Mesh>();
  private readonly barricadeGeometry: THREE.BoxGeometry;
  private readonly barricadeMaterial = new THREE.MeshStandardMaterial({ color: 0x7c4a21, roughness: 0.9 });
  private time = 0;

  constructor(
    scene: THREE.Scene,
    private readonly map: MapDefinition
  ) {
    this.group.name = 'world-state';
    scene.add(this.group);
    this.barricadeGeometry = new THREE.BoxGeometry(map.cellSize * 0.95, 1.4, map.cellSize * 0.35);
  }

  /** Barricade meshes also stop bullets. */
  getCollidables(): THREE.Object3D[] {
    return [...this.barricades.values()];
  }

  update(snapshot: ExtendedWorldSnapshot, dt: number): void {
    this.time += dt;

    for (const pickup of snapshot.pickups) {
      let mesh = this.pickups.get(pickup.id);
      if (!mesh) {
        mesh = new THREE.Mesh(
          new THREE.OctahedronGeometry(0.25),
          new THREE.MeshStandardMaterial({ color: PICKUP_COLORS[pickup.kind], emissive: PICKUP_COLORS[pickup.kind], emissiveIntensity: 1.4 })
        );
        const light = new THREE.PointLight(PICKUP_COLORS[pickup.kind], 3, 4, 2);
        mesh.add(light);
        this.group.add(mesh);
        this.pickups.set(pickup.id, mesh);
      }
      const p = gridToWorld(pickup.position, this.map);
      mesh.visible = !pickup.collected;
      mesh.position.set(p.x, 0.9 + Math.sin(this.time * 2) * 0.1, p.z);
      mesh.rotation.y = this.time;
    }

    this.syncSet(this.barricades, snapshot.barricades.map((b) => `${b.row},${b.col}`), (key) => {
      const [row, col] = key.split(',').map(Number);
      const mesh = new THREE.Mesh(this.barricadeGeometry, this.barricadeMaterial);
      const p = gridToWorld({ row, col }, this.map);
      mesh.position.set(p.x, 0.7, p.z);
      mesh.castShadow = true;
      return mesh;
    });

    this.syncSet(this.decoys, snapshot.activeDecoys.map((d) => d.id), (id) => {
      const decoy = snapshot.activeDecoys.find((d) => d.id === id)!;
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.15),
        new THREE.MeshStandardMaterial({ color: 0xfacc15, emissive: 0xfacc15, emissiveIntensity: 2 })
      );
      const p = gridToWorld(decoy.position, this.map);
      mesh.position.set(p.x, 0.15, p.z);
      mesh.add(new THREE.PointLight(0xfacc15, 4, 5, 2));
      return mesh;
    });
    for (const mesh of this.decoys.values()) mesh.scale.setScalar(1 + 0.3 * Math.sin(this.time * 12));
  }

  private syncSet(map: Map<string, THREE.Mesh>, keys: string[], create: (key: string) => THREE.Mesh): void {
    const wanted = new Set(keys);
    for (const [key, mesh] of map) {
      if (!wanted.has(key)) {
        this.group.remove(mesh);
        map.delete(key);
      }
    }
    for (const key of wanted) {
      if (!map.has(key)) {
        const mesh = create(key);
        this.group.add(mesh);
        map.set(key, mesh);
      }
    }
  }
}
