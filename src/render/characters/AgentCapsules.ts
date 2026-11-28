import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import type { AgentRole, AgentState, MapDefinition } from '../../core/contracts.ts';
import type { ExtendedAgentSnapshot } from '../../core/agents/AgentBrain.ts';
import { createWalkableLookup, gridToWorld, worldToGrid } from '../../core/world/gridSpace.ts';
import { tickMsForMap, type FrameState } from '../../game/GameLoop.ts';
import type { AgentView } from '../../game/views.ts';
import { AudioManager } from '../AudioManager.ts';
import { explorerScreamAt } from './explorerScream.ts';

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
/** Scales the 1.68-1.89 m models down to read as average adults next to the player's eye height. */
const CHARACTER_SCALE = .9;
const SURVIVOR_HALF_WIDTH = .42;

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
  screamId?: string;
}

function motionFor(
  role: AgentRole,
  state: AgentState,
  moving: boolean,
  operatingRadio: boolean,
  evacuating: boolean
): string {
  if (role === 'radio_survivor') {
    if (moving || evacuating) return 'run';
    if (operatingRadio || state === 'alert') return 'scream';
    return 'idle';
  }
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

function industrialRadioSpot(scene: THREE.Scene, map: MapDefinition) {
  if (map.id !== 'map_industrial') return undefined;
  const radio = scene.getObjectByName('radio-indicator')?.parent;
  if (!radio) return undefined;
  const walkable = createWalkableLookup(map);
  const forward = radio.getWorldDirection(new THREE.Vector3());
  const yaw = Math.atan2(forward.x, forward.z);
  radio.updateWorldMatrix(true, true);
  const fixtures: THREE.Box3[] = [];
  radio.traverse((part) => {
    if (part instanceof THREE.Mesh) fixtures.push(new THREE.Box3().setFromObject(part));
  });

  const positions = [[.96, .62], [-1.06, .62], [0, 1.1]].map(([side, front]) =>
    radio.localToWorld(new THREE.Vector3(side, 0, front)));
  const refuge = map.cells.find((cell) => cell.type === 'refuge');
  if (refuge) {
    const { x, z } = gridToWorld(refuge, map);
    positions.unshift(new THREE.Vector3(x, 0, z));
  }

  const stance = new THREE.Box3();
  for (const position of positions) {
    if (!walkable(worldToGrid(position, map))) continue;
    stance.min.set(position.x - SURVIVOR_HALF_WIDTH, .06, position.z - SURVIVOR_HALF_WIDTH);
    stance.max.set(position.x + SURVIVOR_HALF_WIDTH, 1.8, position.z + SURVIVOR_HALF_WIDTH);
    if (!fixtures.some((bounds) => bounds.intersectsBox(stance))) return { position, yaw };
  }
  return undefined;
}

// Keeps the existing AgentView entry point and the loading fallback.
export class AgentCapsules implements AgentView {
  private readonly root = new THREE.Group();
  private readonly bodies = new Map<string, Body>();
  private readonly assets = new Map<AgentRole, GLTF>();
  private readonly geometry = new THREE.CapsuleGeometry(0.28, 1.04, 4, 10);
  private readonly materials = new Map<AgentRole, THREE.MeshStandardMaterial>();
  private readonly disconnectAudio: () => void;
  private readonly radioSurvivorSpot: ReturnType<typeof industrialRadioSpot>;
  private lastTick = -1;
  private elapsed = 0;
  private disposed = false;

  constructor(scene: THREE.Scene, private readonly map: MapDefinition) {
    this.root.name = 'agents';
    scene.add(this.root);
    this.radioSurvivorSpot = industrialRadioSpot(scene, map);
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
      const refuge = frame.current.refugePosition;
      const besideRadio = agent.role === 'radio_survivor' && !moving &&
        agent.position.row === refuge.row && agent.position.col === refuge.col && this.radioSurvivorSpot;
      if (besideRadio) {
        body.group.position.copy(besideRadio.position);
      } else {
        body.group.position.set(
          THREE.MathUtils.lerp(from.x, to.x, frame.alpha),
          0,
          THREE.MathUtils.lerp(from.z, to.z, frame.alpha),
        );
      }

      const maraWorld = gridToWorld(frame.current.mara.position, this.map);
      let look: { x: number; z: number } | null =
        state === 'attack' && agent.targetPosition ? gridToWorld(agent.targetPosition, this.map) : null;
      if (agent.role === 'radio_survivor' && !moving) {
        if (state === 'alert' && agent.targetPosition) {
          look = gridToWorld(agent.targetPosition, this.map);
        } else if (Math.hypot(maraWorld.x - body.group.position.x, maraWorld.z - body.group.position.z) <= 9) {
          look = maraWorld;
        }
      }
      const dx = look ? look.x - body.group.position.x : to.x - from.x;
      const dz = look ? look.z - body.group.position.z : to.z - from.z;
      if (state !== 'dead' && (dx !== 0 || dz !== 0)) {
        const targetYaw = Math.atan2(dx, dz);
        const delta = Math.atan2(Math.sin(targetYaw - body.yaw), Math.cos(targetYaw - body.yaw));
        body.yaw += delta * (1 - Math.exp(-15 * dt));
      } else if (besideRadio) {
        const delta = Math.atan2(Math.sin(besideRadio.yaw - body.yaw), Math.cos(besideRadio.yaw - body.yaw));
        body.yaw += delta * (1 - Math.exp(-8 * dt));
      }
      body.group.rotation.y = body.yaw;

      const previousScreamId = body.screamId;
      if (state !== 'alert' || moving) body.screamId = undefined;
      else if (!frame.current.paused) {
        body.screamId = explorerScreamAt(agent, frame.current.soundEvents)?.id ?? body.screamId;
      }
      const evacuating =
        agent.role === 'radio_survivor' &&
        Boolean(frame.current.radioActivated) &&
        state === 'alert';
      const operatingRadio =
        agent.role === 'radio_survivor' &&
        !moving &&
        !evacuating &&
        frame.current.radioInstallProgress > 0 &&
        !frame.current.radioActivated;
      const hit = state === 'stunned' && agent.health < body.health;
      const newScream = body.screamId !== undefined && body.screamId !== previousScreamId;
      if (body.model) this.animate(body, state, moving, dt, hit, newScream, operatingRadio, evacuating);
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
    group.scale.setScalar(CHARACTER_SCALE);
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

    const mixer = new THREE.AnimationMixer(root);
    const clips = new Map(asset.animations.map((clip) => [clip.name, clip]));
    const idle = clips.get('idle');
    if (body.role === 'radio_survivor' && this.radioSurvivorSpot && idle) {
      const standing = mixer.clipAction(idle).play();
      mixer.update(0);
      root.updateWorldMatrix(true, true);
      const feet = new THREE.Box3().setFromObject(root, true).min.y;
      standing.stop();
      if (Number.isFinite(feet)) root.position.y -= feet;
    }

    body.fallback.removeFromParent();
    body.group.add(root);
    body.model = { root, meshes, mixer, clips };
  }

  private animate(
    body: Body,
    state: AgentState,
    moving: boolean,
    dt: number,
    hit: boolean,
    newScream: boolean,
    operatingRadio: boolean,
    evacuating: boolean
  ): void {
    const model = body.model!;
    const scream = body.screamId === undefined ? undefined : model.clips.get('scream');
    const screamTime = scream ? model.mixer.existingAction(scream)?.time ?? 0 : 0;
    const screaming = scream !== undefined && (newScream || screamTime < scream.duration);
    const clip = screaming
      ? scream
      : model.clips.get(motionFor(body.role, state, moving, operatingRadio, evacuating)) ?? model.clips.get('idle');
    const restart = hit || (screaming && newScream);
    if (clip && (restart || model.action?.getClip() !== clip)) {
      const action = model.mixer.clipAction(clip);
      const loop = LOOPS.has(clip.name) || (body.role === 'radio_survivor' && clip.name === 'scream');
      action.reset().setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
      if (screaming) {
        // The sound arrives one tick into the three-tick hold.
        action.setDuration(Math.min(clip.duration, 2 * tickMsForMap(this.map) / 1000));
      }
      action.clampWhenFinished = !loop;
      action.play();
      if (model.action && model.action !== action) {
        const interrupted = state === 'attack' || state === 'stunned' || state === 'dead';
        const fade = model.action.getClip().name === 'scream' && !interrupted ? .15 : .10;
        model.action.crossFadeTo(action, fade, false);
      } else if (state === 'dead' && body.state === 'dead') {
        action.time = clip.duration;
      }
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
