import * as THREE from 'three';
import type { GameCommand } from '../../core/contracts.ts';
import { AudioManager } from '../AudioManager.ts';
import type { SceneManager } from '../SceneManager.ts';
import { WeaponView } from './WeaponView.ts';

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
  private readonly aim = new THREE.Vector2();
  private readonly audioPosition = new THREE.Vector3();
  private readonly viewModel: WeaponView;
  private readonly listeners = new Set<(shot: ShotResult) => void>();
  private lastShotMs = -Infinity;
  private enabled = true;

  constructor(
    private readonly sceneManager: SceneManager,
    private readonly targets: WeaponTargets,
    private readonly send: (command: GameCommand) => void
  ) {
    this.viewModel = new WeaponView(sceneManager.camera);
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
    this.viewModel.update(dt);
  }

  fire(): ShotResult | null {
    const now = performance.now();
    if (!this.enabled || now - this.lastShotMs < FIRE_COOLDOWN_MS) return null;
    this.lastShotMs = now;

    const ammo = this.targets.ammoInMagazine();
    if (ammo <= 0) {
      this.playCue('dry_fire');
      this.send({ type: 'fire', hitAgentId: null });
      return null;
    }

    this.sceneManager.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.aim, this.sceneManager.camera);
    const [hit] = this.raycaster.intersectObjects([...this.targets.agents(), ...this.targets.world()], true);
    let hitAgentId: string | null = null;
    for (let object: THREE.Object3D | null = hit?.object ?? null; object; object = object.parent) {
      if (typeof object.userData.agentId === 'string') {
        hitAgentId = object.userData.agentId;
        break;
      }
    }

    this.send({ type: 'fire', hitAgentId });
    if (this.targets.ammoInMagazine() >= ammo) return null;
    this.viewModel.fire();
    this.playCue('gunshot');
    const shot = { hitAgentId, point: hit?.point.clone() ?? null };
    for (const listener of this.listeners) listener(shot);
    return shot;
  }

  dispose(): void {
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('keydown', this.onKeyDown);
    this.viewModel.dispose();
    this.listeners.clear();
  }

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0 || !this.sceneManager.isPointerLocked()) return;
    this.fire();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== 'KeyR' || event.repeat || !this.enabled) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const ammo = this.targets.ammoInMagazine();
    this.send({ type: 'reload' });
    if (this.targets.ammoInMagazine() > ammo) {
      this.viewModel.reload();
      this.playCue('reload');
    }
  };

  private playCue(cue: 'gunshot' | 'dry_fire' | 'reload'): void {
    const position = this.viewModel.muzzlePosition(this.audioPosition);
    AudioManager.playWeaponCue(this.sceneManager.camera, cue, position);
  }
}
