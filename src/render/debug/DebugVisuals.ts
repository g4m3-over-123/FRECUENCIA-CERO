import * as THREE from 'three';
import type { AgentRole, MapDefinition } from '../../core/contracts.ts';
import type { ExtendedWorldSnapshot } from '../../core/gameplay/SimulationEngine.ts';
import { gridToWorld } from '../../core/world/gridSpace.ts';
import type { FrameState } from '../../game/GameLoop.ts';
import type { DebugView } from '../../game/views.ts';

/**
 * Phase 0 X-ray (Tab): current path of every agent, expanded nodes of the last search,
 * sound rings and recursive alert hops colored by depth. Drawn through walls.
 * Front D owns this file: polish, legend, per-agent filter, Dijkstra vs A* side by side.
 */

const PATH_COLOR: Record<AgentRole, number> = {
  explorer: 0xa3e635,
  pursuer: 0xf87171,
  radio_survivor: 0x60a5fa,
};
const HOP_COLORS = [0xfacc15, 0xfb923c, 0xef4444, 0xc026d3];
const MAX_EXPANDED = 4000;

export class DebugVisuals implements DebugView {
  private readonly root = new THREE.Group();
  private readonly paths = new THREE.Group();
  private readonly hops = new THREE.Group();
  private readonly rings: Array<{ mesh: THREE.Mesh; age: number; maxRadius: number }> = [];
  private readonly expanded: THREE.InstancedMesh;
  private readonly seenSounds = new Set<string>();
  private enabled = false;
  private lastTick = -1;

  constructor(
    scene: THREE.Scene,
    private readonly map: MapDefinition
  ) {
    this.root.name = 'xray';
    this.root.visible = false;
    this.root.renderOrder = 999;
    const square = new THREE.PlaneGeometry(map.cellSize * 0.8, map.cellSize * 0.8);
    square.rotateX(-Math.PI / 2);
    this.expanded = new THREE.InstancedMesh(
      square,
      new THREE.MeshBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.18, depthTest: false, depthWrite: false }),
      MAX_EXPANDED
    );
    this.expanded.count = 0;
    this.expanded.frustumCulled = false;
    this.root.add(this.expanded, this.paths, this.hops);
    scene.add(this.root);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.root.visible = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  sync(frame: FrameState): void {
    const snapshot = frame.current;
    if (snapshot.tick !== this.lastTick) {
      this.lastTick = snapshot.tick;
      if (this.enabled) this.rebuild(snapshot);
    }
    for (const ring of this.rings) {
      ring.age += frame.dt;
      const t = Math.min(1, ring.age / 1.2);
      ring.mesh.scale.setScalar(Math.max(0.01, t * ring.maxRadius));
      (ring.mesh.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - t);
    }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      if (this.rings[i].age > 1.2) {
        const { mesh } = this.rings[i];
        this.root.remove(mesh);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        this.rings.splice(i, 1);
      }
    }
  }

  private rebuild(snapshot: ExtendedWorldSnapshot): void {
    this.clear(this.paths);
    this.clear(this.hops);

    let count = 0;
    const m = new THREE.Matrix4();
    for (const agent of snapshot.agents) {
      if (agent.state === 'dead') continue;
      if (agent.currentPath.length > 1) {
        const points = agent.currentPath.map((cell) => {
          const p = gridToWorld(cell, this.map);
          return new THREE.Vector3(p.x, 0.12, p.z);
        });
        const line = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(points),
          new THREE.LineBasicMaterial({ color: PATH_COLOR[agent.role], depthTest: false, transparent: true })
        );
        line.renderOrder = 999;
        this.paths.add(line);
      }
      for (const node of agent.lastSearch?.expandedNodes ?? []) {
        if (count >= MAX_EXPANDED) break;
        const p = gridToWorld(node, this.map);
        m.makeTranslation(p.x, 0.06, p.z);
        this.expanded.setMatrixAt(count++, m);
      }
    }
    this.expanded.count = count;
    this.expanded.instanceMatrix.needsUpdate = true;

    const positions = new Map(snapshot.agents.map((a) => [a.id, gridToWorld(a.position, this.map)]));
    for (const alert of snapshot.activeAlerts) {
      for (const hop of alert.hops) {
        const from = positions.get(hop.fromAgentId);
        const to = positions.get(hop.toAgentId);
        if (!from || !to) continue;
        const mid = new THREE.Vector3((from.x + to.x) / 2, 2.5 + hop.depth * 0.5, (from.z + to.z) / 2);
        const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(from.x, 1.8, from.z), mid, new THREE.Vector3(to.x, 1.8, to.z));
        const arc = new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(curve.getPoints(16)),
          new THREE.LineBasicMaterial({ color: HOP_COLORS[Math.min(hop.depth, HOP_COLORS.length) - 1] ?? 0xffffff, depthTest: false, transparent: true })
        );
        arc.renderOrder = 999;
        this.hops.add(arc);
      }
    }

    for (const sound of snapshot.soundEvents) {
      if (this.seenSounds.has(sound.id)) continue;
      this.seenSounds.add(sound.id);
      const p = gridToWorld(sound.position, this.map);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.95, 1, 48).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xe879f9, transparent: true, opacity: 0.7, depthTest: false, side: THREE.DoubleSide })
      );
      ring.position.set(p.x, 0.1, p.z);
      ring.renderOrder = 999;
      this.root.add(ring);
      this.rings.push({ mesh: ring, age: 0, maxRadius: sound.radius * this.map.cellSize });
    }
    if (this.seenSounds.size > 2000) this.seenSounds.clear();
  }

  private clear(group: THREE.Group): void {
    for (const child of [...group.children]) {
      group.remove(child);
      if (child instanceof THREE.Line) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    }
  }
}
