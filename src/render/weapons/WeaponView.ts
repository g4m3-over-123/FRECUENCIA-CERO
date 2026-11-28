import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { DEFAULT_WEAPON, getWeaponDefinition, type WeaponId } from '../../core/gameplay/weapons.ts';

const STEP_CADENCE = { base: 1.6, perMps: .22 };
const BOB_SIDE = .0055;
const BOB_LIFT = .0045;
const BOB_MAX_GAIN = 1.9;
const INSERT_CLIP = { from: .3, to: 1.35 };
const RELOAD_TIMING = { raise: .38, perRound: .58, lower: .38 };
const WALK_SPEED = 3.2;
const SPRINT_SPEED = 4.6;
const TICK_SECONDS = .385;

type ClipSlice = {
  source: string;
  from: number;
  to: number;
};

interface WeaponRigConfig {
  asset: string;
  rest: readonly [number, number, number];
  mount: { position: readonly [number, number, number]; rotationY: number; scale: number };
  muzzleLocal?: readonly [number, number, number];
  flashPower: number;
  fireDuration: number;
  clipPrefix?: string;
  slices?: Record<string, ClipSlice>;
}

const RIG_CONFIGS: Record<WeaponId, WeaponRigConfig> = {
  pistol: {
    asset: 'fps_character_animation_pack_saps-12.glb',
    rest: [.05, -.15, -.16],
    mount: { position: [-.02, -1.4, 0], rotationY: Math.PI, scale: .4 },
    flashPower: 21,
    fireDuration: .34,
    clipPrefix: 'RIG_UE5_Comando_',
  },
  m4: {
    asset: 'm4_-_fps_weapon_animations_pack_v.1.glb',
    rest: [.01, -.04, -.06],
    mount: { position: [.011, -1.539, -.101], rotationY: Math.PI, scale: 1 },
    muzzleLocal: [0, 1.44, .63],
    flashPower: 21,
    fireDuration: .18,
    slices: {
      Equip: { source: 'Draw', from: 8.967, to: 10.0 },
      Idle: { source: 'Draw', from: 9.75, to: 10.0 },
      Fire: { source: 'Fire', from: 7.533, to: 8.333 },
      Reload: { source: 'Reload', from: .033, to: 3.667 },
      ReloadEmpty: { source: 'Reload_Empty', from: 3.7, to: 7.5 },
    },
  },
  persuader: {
    asset: 'persuader_animated.glb',
    rest: [.06, -.12, -.10],
    mount: { position: [0, 0, 0], rotationY: Math.PI, scale: .85 },
    muzzleLocal: [0, .08, .66],
    flashPower: 19,
    fireDuration: .24,
    slices: {
      Fire: { source: 'allanims', from: 0, to: .35 },
      Reload: { source: 'allanims', from: .35, to: 2.4 },
      Equip: { source: 'allanims', from: 6.5, to: 7.1 },
      Idle: { source: 'allanims', from: 7.1, to: 7.7 },
    },
  },
  dual_mac10: {
    asset: 'dual_mac10_smg_-_animated.glb',
    rest: [0, -.12, -.22],
    mount: { position: [0, 0, 0], rotationY: 0, scale: .9 },
    muzzleLocal: [.13, .04, -.4],
    flashPower: 10,
    fireDuration: .15,
    slices: {
      Fire: { source: 'Scene', from: .03, to: .35 },
      Reload: { source: 'Scene', from: .5, to: 2.55 },
      Idle: { source: 'Scene', from: 2.65, to: 3.45 },
      Equip: { source: 'Scene', from: 3.55, to: 4.15 },
    },
  },
  sawnoff: {
    asset: 'sawnoff_animated.glb',
    rest: [.04, -.13, -.14],
    mount: { position: [0, 0, 0], rotationY: Math.PI, scale: .012 },
    muzzleLocal: [0, 4.5, 50],
    flashPower: 24,
    fireDuration: .36,
    slices: {
      Fire: { source: 'allanims', from: 0, to: .5 },
      Reload: { source: 'allanims', from: .65, to: 3.85 },
      Idle: { source: 'allanims', from: 7.4, to: 8.25 },
      Equip: { source: 'allanims', from: 8.4, to: 9.0 },
    },
  },
  dual_sawnoffs: {
    asset: 'sawnoffs_animated.glb',
    rest: [0, -.12, -.16],
    mount: { position: [0, 0, 0], rotationY: Math.PI, scale: .011 },
    muzzleLocal: [12, 4.5, 49],
    flashPower: 24,
    fireDuration: .26,
    slices: {
      Fire: { source: 'CINEMA_4D_Main', from: 0, to: .38 },
      FireAlt: { source: 'CINEMA_4D_Main', from: .4, to: .82 },
      Reload: { source: 'CINEMA_4D_Main', from: .95, to: 3.35 },
      Idle: { source: 'CINEMA_4D_Main', from: 3.45, to: 4.25 },
      Equip: { source: 'CINEMA_4D_Main', from: 4.4, to: 5.0 },
    },
  },
};

type Motion = { clip: THREE.AnimationClip; seconds?: number };

interface LoadedRig {
  id: WeaponId;
  mount: THREE.Group;
  model: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  clips: Map<string, THREE.AnimationClip>;
  muzzleAnchor: THREE.Object3D;
}

export class WeaponView {
  private readonly loader = new GLTFLoader();
  private readonly root = new THREE.Group();
  private readonly muzzle = new THREE.Object3D();
  private readonly flash = new THREE.PointLight(0xffbe79, 0, 5, 2);
  private readonly fallback = new THREE.Group();
  private readonly rigs = new Map<WeaponId, LoadedRig>();
  private readonly loading = new Map<WeaponId, Promise<void>>();
  private activeId: WeaponId = DEFAULT_WEAPON;
  private current?: THREE.AnimationAction;
  private queue: Motion[] = [];
  private fireToggle = 0;
  private recoil = 0;
  private flashTimer = 0;
  private equipDip = 0;
  private disposed = false;
  private readonly camera: THREE.Camera;
  private readonly currentRest = new THREE.Vector3(...RIG_CONFIGS[DEFAULT_WEAPON].rest);
  private readonly targetRest = new THREE.Vector3(...RIG_CONFIGS[DEFAULT_WEAPON].rest);
  private readonly lastCamera = new THREE.Vector3();
  private readonly cameraPosition = new THREE.Vector3();
  private hasLastCamera = false;
  private speed = 0;
  private bobPhase = 0;
  private bobWeight = 0;
  private sprintWeight = 0;

  constructor(camera: THREE.Camera) {
    this.camera = camera;
    this.root.name = 'weapon-view';
    this.root.position.copy(this.currentRest);
    this.muzzle.name = 'weapon-muzzle';
    this.muzzle.position.set(.09, .035, -.56);
    this.muzzle.add(this.flash);

    const receiver = new THREE.Mesh(
      new THREE.BoxGeometry(.085, .085, .37),
      new THREE.MeshStandardMaterial({ color: 0x2f3643, metalness: .4, roughness: .64 }),
    );
    receiver.position.set(.09, -.025, -.24);
    this.fallback.add(receiver);
    this.root.add(this.fallback, this.muzzle);
    camera.add(this.root);

    this.ensureRigLoaded(DEFAULT_WEAPON);
  }

  setWeapon(id: WeaponId): void {
    if (this.activeId === id) return;
    this.activeId = id;
    this.targetRest.set(...RIG_CONFIGS[id].rest);
    this.queue = [];
    this.current = undefined;
    this.recoil = 0;
    this.flashTimer = 0;
    this.equipDip = 1;
    this.fireToggle = 0;

    for (const [rigId, rig] of this.rigs) {
      rig.mount.visible = rigId === id;
      if (rigId !== id) rig.mixer.stopAllAction();
    }

    const ready = this.rigs.get(id);
    if (ready) {
      this.activateRig(ready);
      return;
    }

    this.root.add(this.fallback, this.muzzle);
    this.muzzle.position.set(.09, .035, -.56);
    this.ensureRigLoaded(id);
  }

  update(dt: number): void {
    const activeRig = this.rigs.get(this.activeId);
    activeRig?.mixer.update(dt);
    this.recoil *= Math.exp(-14 * dt);
    this.equipDip *= Math.exp(-10 * dt);
    this.currentRest.lerp(this.targetRest, 1 - Math.exp(-14 * dt));
    this.updateBob(dt);
    const gain = Math.min(BOB_MAX_GAIN, this.speed / WALK_SPEED);
    const side = Math.sin(this.bobPhase) * BOB_SIDE * gain * this.bobWeight;
    const lift = (Math.abs(Math.cos(this.bobPhase)) - .5) * BOB_LIFT * gain * this.bobWeight;
    const run = this.sprintWeight;
    this.root.position.set(
      this.currentRest.x + side + run * .016,
      this.currentRest.y + lift - run * .032 - this.equipDip * .045,
      this.currentRest.z + this.recoil * .035 + run * .01,
    );
    this.root.rotation.set(
      this.recoil * .05 - run * .06 - this.equipDip * .12,
      run * .08,
      -side * 2.6 + run * .14,
    );
    this.flashTimer = Math.max(0, this.flashTimer - dt);
    this.flash.intensity = this.flashTimer > 0 ? RIG_CONFIGS[this.activeId].flashPower : 0;
  }

  fire(): void {
    const config = RIG_CONFIGS[this.activeId];
    this.recoil = 1;
    this.flashTimer = .052;
    const rig = this.rigs.get(this.activeId);
    const useAlt = rig?.clips.has('FireAlt') && this.fireToggle++ % 2 === 1;
    this.playSequence([[useAlt ? 'FireAlt' : 'Fire', config.fireDuration]]);
  }

  reload(rounds: number, emptyReload = false): void {
    const def = getWeaponDefinition(this.activeId);
    if (def.reloadMode === 'shell') {
      const sequence: [string, number][] = [['IdleToReload', RELOAD_TIMING.raise]];
      for (let i = 0; i < Math.max(1, rounds); i++) sequence.push([`Insert${i % 2}`, RELOAD_TIMING.perRound]);
      sequence.push(['ReloadToIdle', RELOAD_TIMING.lower]);
      this.playSequence(sequence);
      return;
    }

    const rig = this.rigs.get(this.activeId);
    const clipName = emptyReload && rig?.clips.has('ReloadEmpty') ? 'ReloadEmpty' : 'Reload';
    const seconds = Math.max(.7, def.reloadDurationTicks * TICK_SECONDS);
    this.playSequence([[clipName, seconds]]);
  }

  muzzlePosition(target: THREE.Vector3): THREE.Vector3 {
    return this.muzzle.getWorldPosition(target);
  }

  dispose(): void {
    this.disposed = true;
    this.root.removeFromParent();
    for (const rig of this.rigs.values()) {
      rig.mixer.stopAllAction();
      rig.mixer.uncacheRoot(rig.model);
      this.disposeModel(rig.model);
    }
    this.rigs.clear();
    this.loading.clear();
    this.disposeModel(this.fallback);
  }

  private ensureRigLoaded(id: WeaponId): void {
    if (this.rigs.has(id) || this.loading.has(id) || this.disposed) return;
    const config = RIG_CONFIGS[id];
    const promise = this.loader
      .loadAsync(`${import.meta.env.BASE_URL}assets/weapons/${config.asset}`)
      .then((asset) => {
        this.loading.delete(id);
        if (this.disposed) {
          this.disposeModel(asset.scene);
          return;
        }
        const rig = this.buildRig(id, config, asset);
        if (!rig) {
          this.disposeModel(asset.scene);
          return;
        }
        this.rigs.set(id, rig);
        this.root.add(rig.mount);
        if (this.activeId === id) {
          this.activateRig(rig);
        } else {
          rig.mount.visible = false;
        }
      })
      .catch(() => {
        this.loading.delete(id);
      });
    this.loading.set(id, promise);
  }

  private buildRig(id: WeaponId, config: WeaponRigConfig, asset: GLTF): LoadedRig | null {
    const rawClips = new Map(
      asset.animations.map((clip) => [config.clipPrefix ? clip.name.replace(config.clipPrefix, '') : clip.name, clip]),
    );
    const clips = new Map<string, THREE.AnimationClip>();

    if (config.slices) {
      for (const [name, slice] of Object.entries(config.slices)) {
        const source = rawClips.get(slice.source);
        if (source) clips.set(name, trimClip(source, name, slice.from, slice.to));
      }
    } else {
      for (const [name, clip] of rawClips) clips.set(name, clip);
      const reload = clips.get('Reload');
      if (reload) {
        for (const name of ['Insert0', 'Insert1']) clips.set(name, trimClip(reload, name, INSERT_CLIP.from, INSERT_CLIP.to));
      }
    }

    const idle = clips.get('Idle');
    if (!idle || !clips.has('Fire')) return null;

    const model = asset.scene;
    model.name = `weapon-${id}`;
    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.frustumCulled = false;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!(material instanceof THREE.MeshStandardMaterial)) continue;
        material.fog = false;
        material.emissive.setHex(0xc8d9ea);
        material.emissiveMap = material.map;
        material.emissiveIntensity = .27;
        material.needsUpdate = true;
      }
    });

    const mixer = new THREE.AnimationMixer(model);
    const idleAction = mixer.clipAction(idle);
    idleAction.play();
    mixer.update(0);
    model.updateMatrixWorld(true);

    // Measure SPAS-12 barrel anchor before parenting under mount so world coordinates match REST/camera.
    const muzzleAnchor = new THREE.Object3D();
    muzzleAnchor.name = `weapon-muzzle-${id}`;
    if (id === 'pistol') {
      const barrel = model.getObjectByName('DEF-Weapon_09');
      if (barrel) {
        muzzleAnchor.position.copy(barrel.worldToLocal(new THREE.Vector3(-.28, 3.53, 2.145)));
        barrel.add(muzzleAnchor);
      } else {
        model.add(muzzleAnchor);
      }
    } else if (config.muzzleLocal) {
      muzzleAnchor.position.set(...config.muzzleLocal);
      model.add(muzzleAnchor);
    } else {
      model.add(muzzleAnchor);
    }
    mixer.stopAllAction();

    const mount = new THREE.Group();
    mount.rotation.y = config.mount.rotationY;
    mount.scale.setScalar(config.mount.scale);
    mount.position.set(...config.mount.position);
    mount.add(model);

    const rig: LoadedRig = { id, mount, model, mixer, clips, muzzleAnchor };
    mixer.addEventListener('finished', (event) => {
      if (this.activeId === id && event.action === this.current) this.advance();
    });
    return rig;
  }

  private activateRig(rig: LoadedRig): void {
    rig.mount.visible = true;
    rig.muzzleAnchor.add(this.muzzle);
    this.muzzle.position.set(0, 0, 0);
    this.fallback.removeFromParent();
    rig.mixer.stopAllAction();
    this.current = undefined;

    const equip = rig.clips.get('Equip');
    if (equip) {
      this.playSequence([['Equip', Math.min(.48, Math.max(.24, equip.duration * .55))]]);
      return;
    }
    const idle = rig.clips.get('Idle');
    if (idle) this.play(rig, { clip: idle }, true);
  }

  private updateBob(dt: number): void {
    const position = this.camera.getWorldPosition(this.cameraPosition);
    if (dt > 0 && this.hasLastCamera) {
      let moved = Math.hypot(position.x - this.lastCamera.x, position.z - this.lastCamera.z);
      if (moved > 1) moved = 0;
      this.speed += (moved / dt - this.speed) * (1 - Math.exp(-10 * dt));
      const cadence = this.speed > .3 ? STEP_CADENCE.base + STEP_CADENCE.perMps * this.speed : 0;
      this.bobPhase = (this.bobPhase + cadence * Math.PI * dt) % (Math.PI * 2);
    }
    this.lastCamera.copy(position);
    this.hasLastCamera = true;
    const blend = 1 - Math.exp(-8 * dt);
    this.bobWeight += ((this.speed > .3 ? 1 : 0) - this.bobWeight) * blend;
    this.sprintWeight += ((this.speed > SPRINT_SPEED ? 1 : 0) - this.sprintWeight) * blend;
  }

  private playSequence(sequence: readonly [name: string, seconds: number][]): void {
    const rig = this.rigs.get(this.activeId);
    if (!rig) return;
    const motions: Motion[] = [];
    for (const [name, seconds] of sequence) {
      const clip = rig.clips.get(name);
      if (clip) motions.push({ clip, seconds });
    }
    if (motions.length === 0) return;
    this.queue = motions;
    this.advance();
  }

  private advance(): void {
    const rig = this.rigs.get(this.activeId);
    if (!rig) return;
    const next = this.queue.shift();
    if (next) {
      this.play(rig, next, false);
      return;
    }
    const idle = rig.clips.get('Idle');
    if (idle) this.play(rig, { clip: idle }, true);
  }

  private play(rig: LoadedRig, motion: Motion, loop: boolean): void {
    const action = rig.mixer.clipAction(motion.clip);
    action.reset().setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;
    action.setDuration(motion.seconds ?? motion.clip.duration).setEffectiveWeight(1).play();
    const fade = motion.clip.name.startsWith('Insert') ? .1 : .045;
    if (this.current && this.current !== action) this.current.crossFadeTo(action, fade, false);
    this.current = action;
  }

  private disposeModel(root: THREE.Object3D): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const textures = new Set<THREE.Texture>();
    const materials = new Set<THREE.Material>();
    const bitmaps = new Set<ImageBitmap>();
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      if (object instanceof THREE.SkinnedMesh) object.skeleton.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material);
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      }
    });
    for (const texture of textures) {
      const img = texture.image as unknown;
      if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) {
        bitmaps.add(img);
      } else if (img && typeof (img as { close?: unknown }).close === 'function') {
        bitmaps.add(img as ImageBitmap);
      }
    }
    for (const bitmap of bitmaps) {
      try {
        bitmap.close();
      } catch {
        // Shared bitmaps may already be closed when duplicate textures dispose.
      }
    }
    for (const texture of textures) texture.dispose();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  }
}

/**
 * Cuts [from, to] out of a clip keeping every track. AnimationUtils.subclip drops tracks with no
 * key inside the range, which froze part of the left arm and left the hand short of the weapon.
 */
function trimClip(clip: THREE.AnimationClip, name: string, rawFrom: number, rawTo: number): THREE.AnimationClip {
  const from = Math.max(0, Math.min(rawFrom, Math.max(0, clip.duration - .02)));
  const to = Math.max(from + .02, Math.min(rawTo, clip.duration));
  const tracks = clip.tracks.map((track) => {
    const size = track.getValueSize();
    const interpolant = track.createInterpolant();
    const times = [from, ...Array.from(track.times).filter((t) => t > from && t < to), to];
    const values = new Float32Array(times.length * size);
    times.forEach((time, i) => values.set(interpolant.evaluate(time), i * size));
    const TrackType = track.constructor as new (name: string, times: number[], values: Float32Array) => THREE.KeyframeTrack;
    return new TrackType(track.name, times.map((time) => time - from), values);
  });
  return new THREE.AnimationClip(name, to - from, tracks);
}
