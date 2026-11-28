import * as THREE from 'three';
import type { AgentRole, GridCoord, MapDefinition } from '../../core/contracts.ts';
import type { ExtendedWorldSnapshot } from '../../core/gameplay/SimulationEngine.ts';
import { gridToWorld } from '../../core/world/gridSpace.ts';
import type { FrameState } from '../../game/GameLoop.ts';
import type { DebugView } from '../../game/views.ts';

/**
 * X-ray overlay (Tab). Draws, through walls:
 *  - current path of every agent, colored by role, and a marker on its target;
 *  - nodes expanded by the last search (heat: brighter where several searches overlap);
 *  - cells each agent believes blocked (its own memory, not the real grid);
 *  - where each agent believes Mara is (memory entry, opacity = confidence);
 *  - sound rings and recursive alert hops colored by depth.
 *
 * Performance: every layer uses one preallocated buffer or instanced mesh, so a rebuild
 * is a few typed-array writes regardless of the number of zombies (no per-agent
 * geometry or material allocation). Rebuilds happen once per tick and only when enabled.
 *
 * V cycles the focus (all agents -> one agent -> ...). With a focus, only that agent's
 * path, expanded nodes, blocked cells and memory are drawn.
 */

const ROLE_COLOR: Record<AgentRole, number> = {
  explorer: 0xa3e635,
  pursuer: 0xf87171,
  radio_survivor: 0x60a5fa,
};
const HOP_COLORS = [0xfacc15, 0xfb923c, 0xef4444, 0xc026d3];
const EXPANDED_COLOR = new THREE.Color(0x38bdf8);
const BLOCKED_COLOR = 0xff3b3b;
const SOUND_COLOR = 0xe879f9;
const MEMORY_COLOR: Record<'vision' | 'sound' | 'alert', number> = {
  vision: 0xffffff,
  sound: 0xe879f9,
  alert: 0xfacc15,
};

const MAX_EXPANDED = 6000;
const MAX_PATH_SEGMENTS = 8192;
const MAX_ARC_SEGMENTS = 4096;
const ARC_STEPS = 12;
const MAX_MARKERS = 256;
const MAX_BLOCKED = 1024;
const RING_POOL = 32;
const RING_SECONDS = 1.2;

interface XrayAgent {
  id: string;
  role: AgentRole;
  state: string;
  position: GridCoord;
  targetPosition: GridCoord | null;
  memory: { position: GridCoord; confidence: number; source: 'vision' | 'sound' | 'alert' } | null;
  currentPath?: GridCoord[];
  lastSearch?: { expandedNodes: GridCoord[]; expandedCount: number } | null;
  knownBlockedCells?: GridCoord[];
}

interface Ring {
  mesh: THREE.Mesh;
  age: number;
  maxRadius: number;
}

export interface XrayStats {
  agents: number;
  paths: number;
  expanded: number;
  blocked: number;
  hops: number;
  rebuildMs: number;
}

/** Preallocated LineSegments with per-vertex colors. */
class SegmentBuffer {
  readonly lines: THREE.LineSegments;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.positions = new Float32Array(capacity * 6);
    this.colors = new Float32Array(capacity * 6);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setDrawRange(0, 0);
    this.lines = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, transparent: true })
    );
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 999;
  }

  get size(): number {
    return this.count;
  }

  reset(): void {
    this.count = 0;
  }

  push(ax: number, ay: number, az: number, bx: number, by: number, bz: number, color: THREE.Color): boolean {
    if (this.count >= this.capacity) return false;
    const o = this.count * 6;
    this.positions.set([ax, ay, az, bx, by, bz], o);
    this.colors.set([color.r, color.g, color.b, color.r, color.g, color.b], o);
    this.count++;
    return true;
  }

  commit(): void {
    const geometry = this.lines.geometry;
    geometry.setDrawRange(0, this.count * 2);
    (geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.lines.geometry.dispose();
    (this.lines.material as THREE.Material).dispose();
  }
}

function overlayMaterial(color: number, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

function instanced(geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.renderOrder = 999;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  return mesh;
}

/** Flat X made of two crossed bars, lying on the ground. */
function crossGeometry(size: number): THREE.BufferGeometry {
  const w = size * 0.16;
  const h = size;
  const corners = (angle: number): number[] => {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const pts = [
      [-w / 2, -h / 2],
      [w / 2, -h / 2],
      [w / 2, h / 2],
      [-w / 2, h / 2],
    ].map(([x, z]) => [x * c - z * s, 0, x * s + z * c]);
    return [...pts[0], ...pts[1], ...pts[2], ...pts[0], ...pts[2], ...pts[3]];
  };
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([...corners(Math.PI / 4), ...corners(-Math.PI / 4)], 3));
  return geometry;
}

export class DebugVisuals implements DebugView {
  private readonly root = new THREE.Group();
  private readonly paths = new SegmentBuffer(MAX_PATH_SEGMENTS);
  private readonly arcs = new SegmentBuffer(MAX_ARC_SEGMENTS);
  private readonly memoryLinks = new SegmentBuffer(MAX_MARKERS);
  private readonly expanded: THREE.InstancedMesh;
  private readonly blocked: THREE.InstancedMesh;
  private readonly targets: THREE.InstancedMesh;
  private readonly memories: THREE.InstancedMesh;
  private readonly rings: Ring[] = [];
  private readonly seenSounds: string[] = [];
  private readonly seenSoundSet = new Set<string>();
  private readonly legend: HTMLElement | null;
  private readonly legendStats: HTMLElement | null;
  private readonly legendFocus: HTMLElement | null;
  private readonly onKeyDown = (event: KeyboardEvent): void => this.handleKey(event);
  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpColor = new THREE.Color();
  private readonly heat = new Map<number, number>();
  private enabled = false;
  private lastTick = -1;
  private lastSnapshot: ExtendedWorldSnapshot | null = null;
  private focusId: string | null = null;
  private stats: XrayStats = { agents: 0, paths: 0, expanded: 0, blocked: 0, hops: 0, rebuildMs: 0 };

  constructor(
    scene: THREE.Scene,
    private readonly map: MapDefinition,
    legendContainer: HTMLElement | null = typeof document !== 'undefined'
      ? (document.getElementById('app') ?? document.body)
      : null
  ) {
    this.root.name = 'xray';
    this.root.visible = false;
    this.root.renderOrder = 999;
    const cs = map.cellSize;

    const square = new THREE.PlaneGeometry(cs * 0.8, cs * 0.8).rotateX(-Math.PI / 2);
    this.expanded = instanced(square, overlayMaterial(0xffffff, 0.22), MAX_EXPANDED);
    this.expanded.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_EXPANDED * 3), 3);
    this.blocked = instanced(crossGeometry(cs * 0.85), overlayMaterial(BLOCKED_COLOR, 0.85), MAX_BLOCKED);
    this.targets = instanced(
      new THREE.RingGeometry(cs * 0.28, cs * 0.4, 4).rotateX(-Math.PI / 2),
      overlayMaterial(0xffffff, 0.9),
      MAX_MARKERS
    );
    this.targets.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_MARKERS * 3), 3);
    this.memories = instanced(
      new THREE.RingGeometry(cs * 0.3, cs * 0.45, 16).rotateX(-Math.PI / 2),
      overlayMaterial(0xffffff, 0.75),
      MAX_MARKERS
    );
    this.memories.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_MARKERS * 3), 3);
    (this.memoryLinks.lines.material as THREE.LineBasicMaterial).opacity = 0.45;

    const ringGeometry = new THREE.RingGeometry(0.95, 1, 48).rotateX(-Math.PI / 2);
    for (let i = 0; i < RING_POOL; i++) {
      const mesh = new THREE.Mesh(ringGeometry, overlayMaterial(SOUND_COLOR, 0));
      mesh.visible = false;
      mesh.renderOrder = 999;
      mesh.frustumCulled = false;
      this.rings.push({ mesh, age: RING_SECONDS, maxRadius: 1 });
      this.root.add(mesh);
    }

    this.root.add(
      this.expanded,
      this.blocked,
      this.paths.lines,
      this.targets,
      this.memoryLinks.lines,
      this.memories,
      this.arcs.lines
    );
    scene.add(this.root);

    this.legend = legendContainer ? this.buildLegend(legendContainer) : null;
    this.legendStats = this.legend?.querySelector('[data-xray="stats"]') ?? null;
    this.legendFocus = this.legend?.querySelector('[data-xray="focus"]') ?? null;
    if (typeof window !== 'undefined') window.addEventListener('keydown', this.onKeyDown);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.root.visible = enabled;
    if (this.legend) this.legend.hidden = !enabled;
    if (enabled && this.lastSnapshot) this.rebuild(this.lastSnapshot);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /** Restricts the per-agent layers to one agent (null = all). */
  setFocusAgent(agentId: string | null): void {
    this.focusId = agentId;
    this.updateFocusLabel();
    if (this.enabled && this.lastSnapshot) this.rebuild(this.lastSnapshot);
  }

  getFocusAgent(): string | null {
    return this.focusId;
  }

  /** Counters of the last rebuild (also shown in the legend). */
  getStats(): XrayStats {
    return { ...this.stats };
  }

  sync(frame: FrameState): void {
    const snapshot = frame.current;
    this.lastSnapshot = snapshot;
    if (snapshot.tick !== this.lastTick) {
      this.lastTick = snapshot.tick;
      if (this.enabled) this.rebuild(snapshot);
    }
    for (const ring of this.rings) {
      if (!ring.mesh.visible) continue;
      ring.age += frame.dt;
      const t = Math.min(1, ring.age / RING_SECONDS);
      ring.mesh.scale.setScalar(Math.max(0.01, t * ring.maxRadius));
      (ring.mesh.material as THREE.MeshBasicMaterial).opacity = 0.7 * (1 - t);
      if (t >= 1) ring.mesh.visible = false;
    }
  }

  dispose(): void {
    if (typeof window !== 'undefined') window.removeEventListener('keydown', this.onKeyDown);
    this.legend?.remove();
    this.root.removeFromParent();
    for (const buffer of [this.paths, this.arcs, this.memoryLinks]) buffer.dispose();
    for (const mesh of [this.expanded, this.blocked, this.targets, this.memories]) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      mesh.dispose();
    }
    this.rings[0]?.mesh.geometry.dispose();
    for (const ring of this.rings) (ring.mesh.material as THREE.Material).dispose();
  }

  private rebuild(snapshot: ExtendedWorldSnapshot): void {
    const t0 = performance.now();
    const agents = snapshot.agents as unknown as XrayAgent[];
    if (this.focusId && !agents.some((a) => a.id === this.focusId && a.state !== 'dead')) {
      this.focusId = null;
      this.updateFocusLabel();
    }
    const visible = agents.filter((a) => a.state !== 'dead' && (!this.focusId || a.id === this.focusId));

    const pathCount = this.buildPaths(visible);
    const expandedCount = this.buildExpanded(visible);
    const blockedCount = this.buildBlocked(visible);
    this.buildMemories(visible);
    const hopCount = this.buildArcs(snapshot);
    this.spawnRings(snapshot);

    this.stats = {
      agents: agents.filter((a) => a.state !== 'dead').length,
      paths: pathCount,
      expanded: expandedCount,
      blocked: blockedCount,
      hops: hopCount,
      rebuildMs: performance.now() - t0,
    };
    this.updateLegendStats();
  }

  private buildPaths(agents: XrayAgent[]): number {
    this.paths.reset();
    this.targets.count = 0;
    let drawn = 0;
    for (const agent of agents) {
      const color = this.tmpColor.setHex(ROLE_COLOR[agent.role]);
      const path = agent.currentPath ?? [];
      if (path.length > 1) {
        drawn++;
        let prev = gridToWorld(path[0], this.map);
        for (let i = 1; i < path.length; i++) {
          const next = gridToWorld(path[i], this.map);
          if (!this.paths.push(prev.x, 0.12, prev.z, next.x, 0.12, next.z, color)) break;
          prev = next;
        }
      }
      if (agent.targetPosition && this.targets.count < MAX_MARKERS) {
        const p = gridToWorld(agent.targetPosition, this.map);
        this.tmpMatrix.makeTranslation(p.x, 0.14, p.z);
        this.targets.setMatrixAt(this.targets.count, this.tmpMatrix);
        this.targets.setColorAt(this.targets.count, color);
        this.targets.count++;
      }
    }
    this.paths.commit();
    this.targets.instanceMatrix.needsUpdate = true;
    if (this.targets.instanceColor) this.targets.instanceColor.needsUpdate = true;
    return drawn;
  }

  /** One instance per distinct cell; brightness grows with the number of searches that expanded it. */
  private buildExpanded(agents: XrayAgent[]): number {
    this.heat.clear();
    for (const agent of agents) {
      for (const node of agent.lastSearch?.expandedNodes ?? []) {
        const id = node.row * this.map.width + node.col;
        this.heat.set(id, (this.heat.get(id) ?? 0) + 1);
      }
    }
    let count = 0;
    for (const [id, hits] of this.heat) {
      if (count >= MAX_EXPANDED) break;
      const p = gridToWorld({ row: Math.floor(id / this.map.width), col: id % this.map.width }, this.map);
      this.tmpMatrix.makeTranslation(p.x, 0.06, p.z);
      this.expanded.setMatrixAt(count, this.tmpMatrix);
      const k = Math.min(1, 0.35 + 0.22 * hits);
      this.expanded.setColorAt(count, this.tmpColor.copy(EXPANDED_COLOR).multiplyScalar(k));
      count++;
    }
    this.expanded.count = count;
    this.expanded.instanceMatrix.needsUpdate = true;
    if (this.expanded.instanceColor) this.expanded.instanceColor.needsUpdate = true;
    return count;
  }

  private buildBlocked(agents: XrayAgent[]): number {
    const seen = new Set<number>();
    let count = 0;
    for (const agent of agents) {
      for (const cell of agent.knownBlockedCells ?? []) {
        const id = cell.row * this.map.width + cell.col;
        if (seen.has(id) || count >= MAX_BLOCKED) continue;
        seen.add(id);
        const p = gridToWorld(cell, this.map);
        this.tmpMatrix.makeTranslation(p.x, 0.2, p.z);
        this.blocked.setMatrixAt(count++, this.tmpMatrix);
      }
    }
    this.blocked.count = count;
    this.blocked.instanceMatrix.needsUpdate = true;
    return count;
  }

  private buildMemories(agents: XrayAgent[]): void {
    this.memoryLinks.reset();
    let count = 0;
    for (const agent of agents) {
      const memory = agent.memory;
      if (!memory || count >= MAX_MARKERS) continue;
      const p = gridToWorld(memory.position, this.map);
      const from = gridToWorld(agent.position, this.map);
      const color = this.tmpColor.setHex(MEMORY_COLOR[memory.source]).multiplyScalar(0.3 + 0.7 * memory.confidence);
      this.tmpMatrix.makeTranslation(p.x, 0.16, p.z);
      this.memories.setMatrixAt(count, this.tmpMatrix);
      this.memories.setColorAt(count, color);
      count++;
      this.memoryLinks.push(from.x, 1.2, from.z, p.x, 0.16, p.z, color);
    }
    this.memories.count = count;
    this.memories.instanceMatrix.needsUpdate = true;
    if (this.memories.instanceColor) this.memories.instanceColor.needsUpdate = true;
    this.memoryLinks.commit();
  }

  private buildArcs(snapshot: ExtendedWorldSnapshot): number {
    this.arcs.reset();
    const positions = new Map(snapshot.agents.map((a) => [a.id, gridToWorld(a.position, this.map)]));
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const mid = new THREE.Vector3();
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    const p0 = new THREE.Vector3();
    const p1 = new THREE.Vector3();
    let hops = 0;
    for (const alert of snapshot.activeAlerts) {
      for (const hop of alert.hops) {
        const from = positions.get(hop.fromAgentId);
        const to = positions.get(hop.toAgentId);
        if (!from || !to) continue;
        hops++;
        a.set(from.x, 1.8, from.z);
        b.set(to.x, 1.8, to.z);
        mid.set((from.x + to.x) / 2, 2.5 + hop.depth * 0.5, (from.z + to.z) / 2);
        const color = this.tmpColor.setHex(HOP_COLORS[Math.min(Math.max(hop.depth, 1), HOP_COLORS.length) - 1]);
        curve.getPoint(0, p0);
        for (let i = 1; i <= ARC_STEPS; i++) {
          curve.getPoint(i / ARC_STEPS, p1);
          this.arcs.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, color);
          p0.copy(p1);
        }
      }
    }
    this.arcs.commit();
    return hops;
  }

  private spawnRings(snapshot: ExtendedWorldSnapshot): void {
    for (const sound of snapshot.soundEvents) {
      if (this.seenSoundSet.has(sound.id)) continue;
      this.seenSoundSet.add(sound.id);
      this.seenSounds.push(sound.id);
      if (this.seenSounds.length > 512) this.seenSoundSet.delete(this.seenSounds.shift()!);
      // Reuse the oldest ring of the pool.
      let ring = this.rings[0];
      for (const candidate of this.rings) {
        if (!candidate.mesh.visible) {
          ring = candidate;
          break;
        }
        if (candidate.age > ring.age) ring = candidate;
      }
      const p = gridToWorld(sound.position, this.map);
      ring.mesh.position.set(p.x, 0.1, p.z);
      ring.mesh.scale.setScalar(0.01);
      ring.mesh.visible = true;
      ring.age = 0;
      ring.maxRadius = sound.radius * this.map.cellSize;
    }
  }

  private handleKey(event: KeyboardEvent): void {
    if (!this.enabled || event.code !== 'KeyV' || event.repeat) return;
    const target = event.target as HTMLElement | null;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    const ids = (this.lastSnapshot?.agents ?? []).filter((a) => a.state !== 'dead').map((a) => a.id);
    if (ids.length === 0) {
      this.setFocusAgent(null);
      return;
    }
    if (event.shiftKey) {
      this.setFocusAgent(null);
      return;
    }
    const index = this.focusId ? ids.indexOf(this.focusId) : -1;
    this.setFocusAgent(index + 1 < ids.length ? ids[index + 1] : null);
  }

  private buildLegend(container: HTMLElement): HTMLElement {
    const hex = (n: number): string => `#${n.toString(16).padStart(6, '0')}`;
    const item = (color: string, label: string, shape = 'line'): string =>
      `<li><i class="xray-swatch xray-${shape}" style="--c:${color}"></i>${label}</li>`;
    const legend = document.createElement('aside');
    legend.className = 'xray-legend';
    legend.hidden = true;
    legend.setAttribute('aria-label', 'Leyenda de Rayos X');
    legend.innerHTML = `
      <p class="xray-title">Rayos X <span data-xray="focus">Todos los agentes</span></p>
      <ul>
        ${item(hex(ROLE_COLOR.explorer), 'Ruta explorador')}
        ${item(hex(ROLE_COLOR.pursuer), 'Ruta perseguidor')}
        ${item(hex(ROLE_COLOR.radio_survivor), 'Ruta superviviente')}
        ${item('#ffffff', 'Destino del agente', 'diamond')}
        ${item(hex(EXPANDED_COLOR.getHex()), 'Nodos expandidos (más claro = varias búsquedas)', 'square')}
        ${item(hex(BLOCKED_COLOR), 'Celda que el zombi cree bloqueada', 'cross')}
        ${item(hex(MEMORY_COLOR.vision), 'Memoria: lo vio', 'ring')}
        ${item(hex(MEMORY_COLOR.sound), 'Memoria: lo oyó / anillo de sonido', 'ring')}
        ${item(hex(MEMORY_COLOR.alert), 'Memoria: alerta recibida', 'ring')}
        ${HOP_COLORS.map((c, i) => item(hex(c), `Alerta profundidad ${i + 1}${i === HOP_COLORS.length - 1 ? '+' : ''}`)).join('')}
      </ul>
      <p class="xray-stats" data-xray="stats">—</p>
      <p class="xray-hint">V: enfocar siguiente agente · Shift+V: todos</p>`;
    container.appendChild(legend);
    return legend;
  }

  private updateFocusLabel(): void {
    if (!this.legendFocus) return;
    const agent = this.lastSnapshot?.agents.find((a) => a.id === this.focusId);
    this.legendFocus.textContent = agent ? `Foco: ${agent.id}` : 'Todos los agentes';
  }

  private updateLegendStats(): void {
    if (!this.legendStats) return;
    const s = this.stats;
    const text =
      `${s.agents} agentes · ${s.paths} rutas · ${s.expanded} nodos · ` +
      `${s.blocked} bloqueos creídos · ${s.hops} saltos · ${s.rebuildMs.toFixed(2)} ms`;
    if (this.legendStats.textContent !== text) this.legendStats.textContent = text;
  }
}
