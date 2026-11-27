import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';

const ASSET = 'fps_character_animation_pack_saps-12.glb';
const PREFIX = 'RIG_UE5_Comando_';
const REST = new THREE.Vector3(.015, -.14, -.27);

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

  constructor(camera: THREE.Camera) {
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
    this.root.position.z = REST.z + this.recoil * .035;
    this.root.rotation.x = this.recoil * .05;
    this.flashTimer = Math.max(0, this.flashTimer - dt);
    this.flash.intensity = this.flashTimer > 0 ? 21 : 0;
  }

  fire(): void {
    this.recoil = 1;
    this.flashTimer = .052;
    this.playSequence([['Fire', .34]]);
  }

  reload(): void {
    this.playSequence([['IdleToReload', .26], ['Reload', .77], ['ReloadToIdle', .24]]);
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

  private install(asset: GLTF): void {
    this.clips = new Map(asset.animations.map((clip) => [clip.name.replace(PREFIX, ''), clip]));
    const idle = this.clips.get('Idle');
    if (!idle || !this.clips.has('Fire') || !this.clips.has('Reload')) {
      this.disposeModel(asset.scene);
      return;
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
    if (this.current && this.current !== action) this.current.crossFadeTo(action, .045, false);
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
