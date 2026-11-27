import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import type { AgentRole, AgentState, MapDefinition } from '../../core/contracts.ts';
import type { ExtendedAgentSnapshot } from '../../core/agents/AgentBrain.ts';
import { gridToWorld } from '../../core/world/gridSpace.ts';
import type { FrameState } from '../../game/GameLoop.ts';
import type { AgentView } from '../../game/views.ts';
import { AudioManager } from '../AudioManager.ts';

const MODEL_FILES: Record<AgentRole, string> = {
  explorer: 'refugio_explorer.glb',
  pursuer: 'refugio_pursuer.glb',
  radio_survivor: 'refugio_radio_survivor.glb',
};

const ROLE_COLOR: Record<AgentRole, number> = {
  explorer: 0x7c8f5a,
  pursuer: 0xa33b2f,
  radio_survivor: 0x3b82f6,
};

const LOOPS = new Set(['idle', 'walk', 'run']);

interface ModelInstance {
  root: THREE.Object3D;
  meshes: THREE.Mesh[];
  mixer: THREE.AnimationMixer;
  clips: Map<string, THREE.AnimationClip>;
  action?: THREE.AnimationAction;
}

interface Body {
  group: THREE.Group;
  fallback: THREE.Mesh;
  model?: ModelInstance;
  role: AgentRole;
  state: AgentState;
  health: number;
  alive: boolean;
  yaw: number;
}

function motionFor(state: AgentState, moving: boolean): string {
  switch (state) {
    case 'pursue': return moving ? 'run' : 'idle';
    case 'patrol':
    case 'investigate':
    case 'alert': return moving ? 'walk' : 'idle';
    case 'attack': return 'attack';
    case 'stunned': return 'impact';
    case 'dead': return 'death';
    default: return 'idle';
  }
}

// Keeps the existing AgentView entry point and the loading fallback.
export class AgentCapsules implements AgentView {
  private readonly root = new THREE.Group();
  private readonly bodies = new Map<string, Body>();
  private readonly assets = new Map<AgentRole, GLTF>();
  private readonly geometry = new THREE.CapsuleGeometry(0.28, 1.04, 4, 10);
  private readonly materials = new Map<AgentRole, THREE.MeshStandardMaterial>();
  private readonly disconnectAudio: () => void;
  private lastTick = -1;
  private elapsed = 0;
  private disposed = false;

  constructor(scene: THREE.Scene, private readonly map: MapDefinition) {
    this.root.name = 'agents';
    scene.add(this.root);
    this.disconnectAudio = AudioManager.bindScene(scene, map);
    const loader = new GLTFLoader();
    for (const role of Object.keys(MODEL_FILES) as AgentRole[]) {
      const url = `${import.meta.env.BASE_URL}assets/characters/${MODEL_FILES[role]}`;
      void loader.loadAsync(url).then((asset) => {
        if (this.disposed) this.disposeAsset(asset.scene);
        else this.assets.set(role, asset);
      }).catch(() => undefined);
    }
  }

  sync(frame: FrameState): void {
    if (frame.current.tick < this.lastTick) this.clearBodies();
    this.lastTick = frame.current.tick;
    const dt = frame.current.paused ? 0 : frame.dt;
    this.elapsed += dt;
    const previous = new Map(frame.previous.agents.map((agent) => [agent.id, agent]));
    const seen = new Set<string>();

    for (const agent of frame.current.agents) {
      seen.add(agent.id);
      let body = this.bodies.get(agent.id);
      if (body?.role !== agent.role) {
        if (body) this.removeBody(body);
        body = this.create(agent);
      }
      const asset = this.assets.get(agent.role);
      if (!body.model && asset) this.attachModel(body, asset, agent.id);
      body.alive = agent.health > 0 && agent.state !== 'dead';
      const state = body.alive ? agent.state : 'dead';
      const before = previous.get(agent.id) ?? agent;
      const from = gridToWorld(before.position, this.map);
      const to = gridToWorld(agent.position, this.map);
      const moving = from.x !== to.x || from.z !== to.z;
      body.group.position.set(
        THREE.MathUtils.lerp(from.x, to.x, frame.alpha),
        0,
        THREE.MathUtils.lerp(from.z, to.z, frame.alpha),
      );

      const look = state === 'attack' && agent.targetPosition ? gridToWorld(agent.targetPosition, this.map) : null;
      const dx = look ? look.x - to.x : to.x - from.x;
      const dz = look ? look.z - to.z : to.z - from.z;
      if (state !== 'dead' && (dx !== 0 || dz !== 0)) {
        const targetYaw = Math.atan2(dx, dz);
        const delta = Math.atan2(Math.sin(targetYaw - body.yaw), Math.cos(targetYaw - body.yaw));
        body.yaw += delta * (1 - Math.exp(-15 * dt));
      }
      body.group.rotation.y = body.yaw;

      if (body.model) this.animate(body, state, moving, dt, state === 'stunned' && agent.health < body.health);
      else this.animateFallback(body.fallback, state);
      body.state = state;
      body.health = agent.health;
    }

    for (const [id, body] of this.bodies) {
      if (seen.has(id)) continue;
      this.removeBody(body);
      this.bodies.delete(id);
    }
  }

  getHitTargets(): THREE.Object3D[] {
    const targets: THREE.Object3D[] = [];
    for (const body of this.bodies.values()) {
      if (body.alive && body.role !== 'radio_survivor') targets.push(...(body.model?.meshes ?? [body.fallback]));
    }
    return targets;
  }

  dispose(): void {
    this.disposed = true;
    this.disconnectAudio();
    this.clearBodies();
    this.root.removeFromParent();
    this.geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    for (const asset of this.assets.values()) this.disposeAsset(asset.scene);
    this.assets.clear();
  }

  private create(agent: ExtendedAgentSnapshot): Body {
    let material = this.materials.get(agent.role);
    if (!material) {
      material = new THREE.MeshStandardMaterial({ color: ROLE_COLOR[agent.role], roughness: .82 });
      this.materials.set(agent.role, material);
    }
    const fallback = new THREE.Mesh(this.geometry, material);
    fallback.position.y = .8;
    fallback.castShadow = true;
    fallback.userData.agentId = agent.id;
    const group = new THREE.Group();
    group.name = `agent-${agent.id}`;
    group.userData.agentId = agent.id;
    group.add(fallback);
    this.root.add(group);
    const body = { group, fallback, role: agent.role, state: agent.state, health: agent.health, alive: true, yaw: 0 };
    this.bodies.set(agent.id, body);
    return body;
  }

  private attachModel(body: Body, asset: GLTF, id: string): void {
    const root = clone(asset.scene);
    const meshes: THREE.Mesh[] = [];
    root.name = `character-${body.role}`;
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.userData.agentId = id;
      object.castShadow = true;
      object.receiveShadow = true;
      if (object instanceof THREE.SkinnedMesh) {
        // The in-place rig can reach and fall outside its bind pose.
        object.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, .8, 0), 1.8);
      }
      meshes.push(object);
    });
    if (meshes.length === 0) return;
    body.fallback.removeFromParent();
    body.group.add(root);
    body.model = {
      root, meshes,
      mixer: new THREE.AnimationMixer(root),
      clips: new Map(asset.animations.map((clip) => [clip.name, clip])),
    };
  }

  private animate(body: Body, state: AgentState, moving: boolean, dt: number, restart: boolean): void {
    const model = body.model!;
    const name = motionFor(state, moving);
    const clip = model.clips.get(name) ?? model.clips.get('idle');
    if (clip && (restart || model.action?.getClip() !== clip)) {
      const action = model.mixer.clipAction(clip);
      const loop = LOOPS.has(clip.name);
      action.reset().setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
      action.clampWhenFinished = !loop;
      action.play();
      if (model.action && model.action !== action) model.action.crossFadeTo(action, .10, false);
      else if (state === 'dead' && body.state === 'dead') action.time = clip.duration;
      model.action = action;
    }
    model.mixer.update(dt);
  }

  private animateFallback(mesh: THREE.Mesh, state: AgentState): void {
    mesh.rotation.x = state === 'dead' ? -Math.PI / 2 : 0;
    mesh.position.y = state === 'dead' ? .28 : .8;
    mesh.rotation.z = state === 'stunned' ? Math.sin(this.elapsed * 28) * .12 : 0;
    mesh.position.z = state === 'attack' ? Math.max(0, Math.sin(this.elapsed * 13)) * .24 : 0;
  }

  private removeBody(body: Body): void {
    const model = body.model;
    if (model) {
      model.mixer.stopAllAction();
      model.mixer.uncacheRoot(model.root);
      for (const mesh of model.meshes) if (mesh instanceof THREE.SkinnedMesh) mesh.skeleton.dispose();
    }
    body.group.removeFromParent();
  }

  private clearBodies(): void {
    for (const body of this.bodies.values()) this.removeBody(body);
    this.bodies.clear();
  }

  private disposeAsset(root: THREE.Object3D): void {
    const materials = new Set<THREE.Material>();
    const geometries = new Set<THREE.BufferGeometry>();
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  }
}
