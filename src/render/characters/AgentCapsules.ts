import * as THREE from 'three';
import type { AgentRole, AgentState, MapDefinition } from '../../core/contracts.ts';
import type { ExtendedAgentSnapshot } from '../../core/agents/AgentBrain.ts';
import { gridToWorld } from '../../core/world/gridSpace.ts';
import type { FrameState } from '../../game/GameLoop.ts';
import type { AgentView } from '../../game/views.ts';

/**
 * Phase 0 placeholder for agents: one capsule per agent, interpolated between ticks.
 * Front B replaces this with animated models (SkeletonUtils.clone + one AnimationMixer each)
 * implementing the same AgentView interface. State hints to reproduce with animations:
 * patrol/investigate walk, pursue run, attack strike, stunned flinch, dead falls over.
 */

const ROLE_COLOR: Record<AgentRole, number> = {
  explorer: 0x7c8f5a,
  pursuer: 0xa33b2f,
  radio_survivor: 0x3b82f6,
};

const STATE_EMISSIVE: Partial<Record<AgentState, number>> = {
  pursue: 0x661100,
  attack: 0xaa0000,
  alert: 0x664400,
  investigate: 0x333300,
};

interface Body {
  group: THREE.Group;
  mesh: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  yaw: number;
}

export class AgentCapsules implements AgentView {
  private readonly root = new THREE.Group();
  private readonly bodies = new Map<string, Body>();
  private readonly geometry = new THREE.CapsuleGeometry(0.3, 1.05, 4, 10);
  private readonly eyeGeometry = new THREE.BoxGeometry(0.32, 0.08, 0.08);
  private time = 0;

  constructor(
    scene: THREE.Scene,
    private readonly map: MapDefinition
  ) {
    this.root.name = 'agents';
    scene.add(this.root);
  }

  sync(frame: FrameState): void {
    this.time += frame.dt;
    const previous = new Map(frame.previous.agents.map((a) => [a.id, a]));
    const alive = new Set<string>();

    for (const agent of frame.current.agents) {
      alive.add(agent.id);
      const body = this.bodies.get(agent.id) ?? this.create(agent);
      const before = previous.get(agent.id) ?? agent;
      const from = gridToWorld(before.position, this.map);
      const to = gridToWorld(agent.position, this.map);
      const x = THREE.MathUtils.lerp(from.x, to.x, frame.alpha);
      const z = THREE.MathUtils.lerp(from.z, to.z, frame.alpha);
      body.group.position.set(x, 0, z);

      const dx = to.x - from.x;
      const dz = to.z - from.z;
      if (Math.hypot(dx, dz) > 0.01) body.yaw = Math.atan2(dx, dz);
      body.group.rotation.y = body.yaw;
      this.applyState(body, agent);
    }

    for (const [id, body] of this.bodies) {
      if (!alive.has(id)) {
        this.root.remove(body.group);
        this.bodies.delete(id);
      }
    }
  }

  getHitTargets(): THREE.Object3D[] {
    return [...this.bodies.values()].filter((b) => b.mesh.userData.alive).map((b) => b.mesh);
  }

  dispose(): void {
    this.root.parent?.remove(this.root);
    this.geometry.dispose();
    this.eyeGeometry.dispose();
  }

  private create(agent: ExtendedAgentSnapshot): Body {
    const material = new THREE.MeshStandardMaterial({ color: ROLE_COLOR[agent.role], roughness: 0.7 });
    const mesh = new THREE.Mesh(this.geometry, material);
    mesh.position.y = 0.825;
    mesh.castShadow = true;
    mesh.userData.agentId = agent.id;
    const eyes = new THREE.Mesh(
      this.eyeGeometry,
      new THREE.MeshStandardMaterial({ color: 0xffeeaa, emissive: agent.role === 'radio_survivor' ? 0x000000 : 0xff2200, emissiveIntensity: 2 })
    );
    eyes.position.set(0, 0.45, 0.27);
    mesh.add(eyes);
    const group = new THREE.Group();
    group.name = `agent-${agent.id}`;
    group.add(mesh);
    this.root.add(group);
    const body: Body = { group, mesh, material, yaw: 0 };
    this.bodies.set(agent.id, body);
    return body;
  }

  private applyState(body: Body, agent: ExtendedAgentSnapshot): void {
    const dead = agent.state === 'dead';
    body.mesh.userData.alive = !dead;
    body.material.color.setHex(dead ? 0x2a2a2a : ROLE_COLOR[agent.role]);
    body.material.emissive.setHex(STATE_EMISSIVE[agent.state] ?? 0x000000);

    // Dead: lying on the ground. Stunned: wobble. Attack: lunge.
    body.mesh.rotation.x = dead ? -Math.PI / 2 : 0;
    body.mesh.position.y = dead ? 0.3 : 0.825;
    body.mesh.rotation.z = agent.state === 'stunned' ? Math.sin(this.time * 30) * 0.15 : 0;
    body.mesh.position.z = agent.state === 'attack' ? Math.max(0, Math.sin(this.time * 14)) * 0.35 : 0;
  }
}
