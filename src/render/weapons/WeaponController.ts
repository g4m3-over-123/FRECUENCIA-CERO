import * as THREE from 'three';
import type { GameCommand } from '../../core/contracts.ts';
import type { SceneManager } from '../SceneManager.ts';

/**
 * Phase 0 weapon: a box "gun" on the camera, hitscan from the screen center, muzzle flash,
 * recoil and a synthesized shot sound. Front B replaces the view model and audio
 * (GLB arms + weapon with idle/fire/reload clips) and keeps the fire command contract:
 * the render decides WHAT was hit, the engine decides damage, ammo and noise.
 */

const FIRE_COOLDOWN_MS = 220;
const MAX_RANGE = 60;

export interface WeaponTargets {
  /** Agent meshes (userData.agentId on the object or a parent). */
  agents: () => THREE.Object3D[];
  /** World geometry that blocks bullets. */
  world: () => THREE.Object3D[];
  /** Current ammo, to avoid firing an empty gun (the engine also checks). */
  ammoInMagazine: () => number;
}

export interface ShotResult {
  hitAgentId: string | null;
  point: THREE.Vector3 | null;
}

export class WeaponController {
  private readonly raycaster = new THREE.Raycaster();
  private readonly viewModel = new THREE.Group();
  private readonly flash: THREE.PointLight;
  private lastShotMs = -Infinity;
  private recoil = 0;
  private flashTimer = 0;
  private audio: AudioContext | null = null;
  private enabled = true;
  private listeners = new Set<(shot: ShotResult) => void>();

  constructor(
    private readonly sceneManager: SceneManager,
    private readonly targets: WeaponTargets,
    private readonly send: (command: GameCommand) => void
  ) {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.07, 0.11, 0.38),
      new THREE.MeshStandardMaterial({ color: 0x1f2328, roughness: 0.5, metalness: 0.6 })
    );
    const grip = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.16, 0.08),
      new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.8 })
    );
    grip.position.set(0, -0.1, 0.1);
    grip.rotation.x = -0.25;
    this.viewModel.add(body, grip);
    this.viewModel.position.set(0.22, -0.2, -0.45);
    this.flash = new THREE.PointLight(0xffc26b, 0, 6, 2);
    this.flash.position.set(0.22, -0.15, -0.7);
    sceneManager.camera.add(this.viewModel, this.flash);

    this.raycaster.far = MAX_RANGE;
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('keydown', this.onKeyDown);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  onShot(listener: (shot: ShotResult) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(dt: number): void {
    this.recoil = Math.max(0, this.recoil - dt * 6);
    this.viewModel.position.z = -0.45 + this.recoil * 0.08;
    this.viewModel.rotation.x = this.recoil * 0.25;
    this.flashTimer = Math.max(0, this.flashTimer - dt);
    this.flash.intensity = this.flashTimer > 0 ? 25 : 0;
  }

  /** Fires if allowed. Exposed for tests and for a future "fire" HUD button. */
  fire(): ShotResult | null {
    const now = performance.now();
    if (!this.enabled || now - this.lastShotMs < FIRE_COOLDOWN_MS) return null;
    this.lastShotMs = now;

    if (this.targets.ammoInMagazine() <= 0) {
      this.playClick();
      this.send({ type: 'fire', hitAgentId: null });
      return null;
    }

    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.sceneManager.camera);
    const agents = this.targets.agents();
    const hits = this.raycaster.intersectObjects([...agents, ...this.targets.world()], true);
    let hitAgentId: string | null = null;
    let point: THREE.Vector3 | null = null;
    if (hits.length > 0) {
      point = hits[0].point.clone();
      let obj: THREE.Object3D | null = hits[0].object;
      while (obj && hitAgentId === null) {
        if (typeof obj.userData.agentId === 'string') hitAgentId = obj.userData.agentId;
        obj = obj.parent;
      }
    }

    this.send({ type: 'fire', hitAgentId });
    this.recoil = 1;
    this.flashTimer = 0.06;
    this.playShot();
    const shot = { hitAgentId, point };
    for (const listener of this.listeners) listener(shot);
    return shot;
  }

  dispose(): void {
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('keydown', this.onKeyDown);
    this.sceneManager.camera.remove(this.viewModel, this.flash);
    void this.audio?.close();
  }

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0 || !this.sceneManager.isPointerLocked()) return;
    this.fire();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === 'KeyR' && !event.repeat && this.enabled) this.send({ type: 'reload' });
  };

  private context(): AudioContext | null {
    if (!this.audio) {
      try {
        this.audio = new AudioContext();
      } catch {
        return null;
      }
    }
    return this.audio;
  }

  /** Placeholder gunshot: filtered noise burst. Front B replaces it with a real sample. */
  private playShot(): void {
    const ctx = this.context();
    if (!ctx) return;
    const length = Math.floor(ctx.sampleRate * 0.25);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 4);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1800;
    const gain = ctx.createGain();
    gain.gain.value = 0.5;
    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start();
  }

  private playClick(): void {
    const ctx = this.context();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 900;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.06);
  }
}
