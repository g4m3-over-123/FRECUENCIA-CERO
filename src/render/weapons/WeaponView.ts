import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';

const ASSET = 'fps_character_animation_pack_saps-12.glb';
const PREFIX = 'RIG_UE5_Comando_';
// Puts the rig's eye (its 'Camera' node, model space (0, 3.864, 0.054)) on the game camera,
// so the arms are seen from where the animation pack was authored. With the eye 0.29 m ahead
// of the camera the left shoulder and upper arm showed up as a large blob at the bottom left.
// Held 16 cm further than the eye so more of the weapon shows; past about 20 cm the left
// shoulder enters the view again.
const REST = new THREE.Vector3(.05, -.15, -.16);
/** Steps per second: running lengthens the stride more than it quickens the cadence. */
const STEP_CADENCE = { base: 1.6, perMps: .22 };
/** Bob amplitude at walking speed, in metres; it grows with speed up to BOB_MAX_GAIN. */
const BOB_SIDE = .0055;
const BOB_LIFT = .0045;
const BOB_MAX_GAIN = 1.9;
/**
 * Part of the Reload clip for one round: the left hand rises, pushes the shell into the tube
 * (0.56-1.11 s) and starts back down. The clip's ends are the hand resting low, off the weapon.
 */
const INSERT_CLIP = { from: .3, to: 1.35 };
/** Seconds; matches the simulation (2 ticks + 1.5 ticks per round, 0.385 s ticks on the street). */
const RELOAD_TIMING = { raise: .38, perRound: .58, lower: .38 };
const WALK_SPEED = 3.2;
/** Above this ground speed the weapon is lowered and tilted as when running. */
const SPRINT_SPEED = 4.6;

type Motion = { clip: THREE.AnimationClip; seconds?: number };

export class WeaponView {
  private readonly root = new THREE.Group();
  private readonly muzzle = new THREE.Object3D();
  private readonly flash = new THREE.PointLight(0xffbe79, 0, 5, 2);
  private readonly fallback = new THREE.Group();
  private model?: THREE.Object3D;
  private mixer?: THREE.AnimationMixer;
  private current?: THREE.AnimationAction;
  private clips = new Map<string, THREE.AnimationClip>();
  private queue: Motion[] = [];
  private recoil = 0;
  private flashTimer = 0;
  private disposed = false;
  private readonly camera: THREE.Camera;
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
    this.root.position.copy(REST);
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

    void new GLTFLoader().loadAsync(`${import.meta.env.BASE_URL}assets/weapons/${ASSET}`)
      .then((asset) => {
        if (this.disposed) this.disposeModel(asset.scene);
        else this.install(asset);
      }).catch(() => undefined);
  }

  update(dt: number): void {
    this.mixer?.update(dt);
    this.recoil *= Math.exp(-14 * dt);
    this.updateBob(dt);
    const gain = Math.min(BOB_MAX_GAIN, this.speed / WALK_SPEED);
    const side = Math.sin(this.bobPhase) * BOB_SIDE * gain * this.bobWeight;
    // abs(cos) dips once per step, like the shoulders settling on each footfall.
    const lift = (Math.abs(Math.cos(this.bobPhase)) - .5) * BOB_LIFT * gain * this.bobWeight;
    const run = this.sprintWeight;
    this.root.position.set(
      REST.x + side + run * .016,
      REST.y + lift - run * .032,
      REST.z + this.recoil * .035 + run * .01,
    );
    this.root.rotation.set(
      this.recoil * .05 - run * .06,
      run * .08,
      -side * 2.6 + run * .14,
    );
    this.flashTimer = Math.max(0, this.flashTimer - dt);
    this.flash.intensity = this.flashTimer > 0 ? 21 : 0;
  }

  fire(): void {
    this.recoil = 1;
    this.flashTimer = .052;
    this.playSequence([['Fire', .34]]);
  }

  /** Raises the weapon, feeds `rounds` rounds one by one and lowers it again. */
  reload(rounds: number): void {
    const sequence: [string, number][] = [['IdleToReload', RELOAD_TIMING.raise]];
    // Two copies of the clip alternate so each round cross-fades into the next instead of snapping.
    for (let i = 0; i < Math.max(1, rounds); i++) sequence.push([`Insert${i % 2}`, RELOAD_TIMING.perRound]);
    sequence.push(['ReloadToIdle', RELOAD_TIMING.lower]);
    this.playSequence(sequence);
  }

  muzzlePosition(target: THREE.Vector3): THREE.Vector3 {
    return this.muzzle.getWorldPosition(target);
  }

  dispose(): void {
    this.disposed = true;
    this.root.removeFromParent();
    this.mixer?.stopAllAction();
    if (this.model) {
      this.mixer?.uncacheRoot(this.model);
      this.disposeModel(this.model);
    }
    this.disposeModel(this.fallback);
  }

  /** Ground speed from the camera's own motion, so the view needs no player input. */
  private updateBob(dt: number): void {
    const position = this.camera.getWorldPosition(this.cameraPosition);
    if (dt > 0 && this.hasLastCamera) {
      // Horizontal only: crouching moves the camera vertically and must not bob the weapon.
      let moved = Math.hypot(position.x - this.lastCamera.x, position.z - this.lastCamera.z);
      // A jump of metres in one frame is a respawn, not a step.
      if (moved > 1) moved = 0;
      this.speed += (moved / dt - this.speed) * (1 - Math.exp(-10 * dt));
      const cadence = this.speed > .3 ? STEP_CADENCE.base + STEP_CADENCE.perMps * this.speed : 0;
      // abs(cos) below has a period of PI, so PI of phase is one step.
      this.bobPhase = (this.bobPhase + cadence * Math.PI * dt) % (Math.PI * 2);
    }
    this.lastCamera.copy(position);
    this.hasLastCamera = true;
    const blend = 1 - Math.exp(-8 * dt);
    this.bobWeight += ((this.speed > .3 ? 1 : 0) - this.bobWeight) * blend;
    this.sprintWeight += ((this.speed > SPRINT_SPEED ? 1 : 0) - this.sprintWeight) * blend;
  }

  private install(asset: GLTF): void {
    this.clips = new Map(asset.animations.map((clip) => [clip.name.replace(PREFIX, ''), clip]));
    const idle = this.clips.get('Idle');
    if (!idle || !this.clips.has('Fire') || !this.clips.has('Reload')) {
      this.disposeModel(asset.scene);
      return;
    }

    const reload = this.clips.get('Reload')!;
    const fps = 30;
    for (const name of ['Insert0', 'Insert1']) {
      this.clips.set(name, THREE.AnimationUtils.subclip(
        reload, name, Math.round(INSERT_CLIP.from * fps), Math.round(INSERT_CLIP.to * fps), fps));
    }

    const model = asset.scene;
    this.model = model;
    this.mixer = new THREE.AnimationMixer(model);
    this.mixer.addEventListener('finished', (event) => {
      if (event.action === this.current) this.advance();
    });
    this.play({ clip: idle }, true);
    this.mixer.update(0);
    model.updateMatrixWorld(true);
    const barrel = model.getObjectByName('DEF-Weapon_09');
    if (barrel) {
      this.muzzle.position.copy(barrel.worldToLocal(new THREE.Vector3(-.28, 3.53, 2.145)));
      barrel.add(this.muzzle);
    }

    model.name = 'weapon-saps12';
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

    const mount = new THREE.Group();
    mount.rotation.y = Math.PI;
    mount.scale.setScalar(.4);
    mount.position.set(-.02, -1.4, 0);
    mount.add(model);
    this.root.add(mount);
    this.fallback.removeFromParent();
  }

  private playSequence(sequence: readonly [name: string, seconds: number][]): void {
    const motions: Motion[] = [];
    for (const [name, seconds] of sequence) {
      const clip = this.clips.get(name);
      if (clip) motions.push({ clip, seconds });
    }
    if (motions.length === 0) return;
    this.queue = motions;
    this.advance();
  }

  private advance(): void {
    const next = this.queue.shift();
    if (next) {
      this.play(next, false);
      return;
    }
    const idle = this.clips.get('Idle');
    if (idle) this.play({ clip: idle }, true);
  }

  private play(motion: Motion, loop: boolean): void {
    if (!this.mixer) return;
    const action = this.mixer.clipAction(motion.clip);
    action.reset().setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;
    action.setDuration(motion.seconds ?? motion.clip.duration).setEffectiveWeight(1).play();
    // Between rounds the hand travels from the weapon back down, so it needs a longer blend.
    const fade = motion.clip.name.startsWith('Insert') ? .1 : .045;
    if (this.current && this.current !== action) this.current.crossFadeTo(action, fade, false);
    this.current = action;
  }

  private disposeModel(root: THREE.Object3D): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const textures = new Set<THREE.Texture>();
    const materials = new Set<THREE.Material>();
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      if (object instanceof THREE.SkinnedMesh) object.skeleton.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        materials.add(material);
        for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      }
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
  }
}
