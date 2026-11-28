import * as THREE from 'three';
import type { GameCommand } from '../../core/contracts.ts';
import {
  DEFAULT_WEAPON,
  WEAPON_ORDER,
  getWeaponDefinition,
  isWeaponId,
  type WeaponFireCue,
  type WeaponId,
  type WeaponReloadCue,
} from '../../core/gameplay/weapons.ts';
import { AudioManager } from '../AudioManager.ts';
import type { SceneManager } from '../SceneManager.ts';
import { CombatEffects } from './CombatEffects.ts';
import { WeaponView } from './WeaponView.ts';

const SWITCH_COOLDOWN_MS = 120;
const MAX_RANGE = 60;

export interface WeaponTargets {
  /** Agent meshes (userData.agentId on the object or a parent). */
  agents: () => THREE.Object3D[];
  /** World geometry that blocks bullets. */
  world: () => THREE.Object3D[];
  /** Current ammo, to avoid firing an empty gun (the engine also checks). */
  ammoInMagazine: () => number;
  /** Current active weapon identifier from the simulation snapshot. */
  weaponId?: () => string;
}

export interface ShotResult {
  hitAgentId: string | null;
  point: THREE.Vector3 | null;
}

type WeaponControllerCue = WeaponFireCue | WeaponReloadCue | 'dry_fire' | 'weapon_switch';

export class WeaponController {
  private readonly raycaster = new THREE.Raycaster();
  private readonly aim = new THREE.Vector2();
  private readonly audioPosition = new THREE.Vector3();
  private readonly muzzleOrigin = new THREE.Vector3();
  private readonly hitNormal = new THREE.Vector3();
  private readonly normalMatrix = new THREE.Matrix3();
  private readonly viewModel: WeaponView;
  private readonly effects: CombatEffects;
  private readonly listeners = new Set<(shot: ShotResult) => void>();
  private activeWeaponId: WeaponId = DEFAULT_WEAPON;
  private lastShotMs = -Infinity;
  private lastSwitchMs = -Infinity;
  private enabled = true;

  constructor(
    private readonly sceneManager: SceneManager,
    private readonly targets: WeaponTargets,
    private readonly send: (command: GameCommand) => void
  ) {
    this.viewModel = new WeaponView(sceneManager.camera);
    this.effects = new CombatEffects(sceneManager.scene);
    this.raycaster.far = MAX_RANGE;
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('wheel', this.onWheel, { passive: true });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  onShot(listener: (shot: ShotResult) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(dt: number): void {
    const simId = this.currentWeaponId();
    if (simId !== this.activeWeaponId) {
      this.activeWeaponId = simId;
      this.viewModel.setWeapon(simId);
    }
    this.viewModel.update(dt);
    this.effects.update(dt);
  }

  switchWeapon(weaponId: string): boolean {
    if (!this.enabled || !isWeaponId(weaponId) || weaponId === this.currentWeaponId()) return false;
    this.send({ type: 'switchWeapon', weaponId });
    if (this.currentWeaponId() !== weaponId) return false;
    this.activeWeaponId = weaponId;
    this.viewModel.setWeapon(weaponId);
    this.playCue('weapon_switch');
    return true;
  }

  fire(): ShotResult | null {
    const weaponId = this.currentWeaponId();
    const def = getWeaponDefinition(weaponId);
    const now = performance.now();
    if (!this.enabled || now - this.lastShotMs < def.fireCooldownMs) return null;
    this.lastShotMs = now;

    const ammo = this.targets.ammoInMagazine();
    if (ammo <= 0) {
      this.playCue('dry_fire');
      this.send({ type: 'fire', hitAgentId: null });
      return null;
    }

    if (weaponId !== this.activeWeaponId) {
      this.activeWeaponId = weaponId;
      this.viewModel.setWeapon(weaponId);
    }

    this.sceneManager.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.aim, this.sceneManager.camera);
    const worldTargets = this.targets.world();
    const [hit] = this.raycaster.intersectObjects([...this.targets.agents(), ...worldTargets], true);
    let hitAgentId: string | null = null;
    for (let object: THREE.Object3D | null = hit?.object ?? null; object; object = object.parent) {
      if (typeof object.userData.agentId === 'string') {
        hitAgentId = object.userData.agentId;
        break;
      }
    }

    let hitNormal: THREE.Vector3 | null = null;
    if (hit) {
      if (hit.face) {
        this.normalMatrix.getNormalMatrix(hit.object.matrixWorld);
        this.hitNormal.copy(hit.face.normal).applyMatrix3(this.normalMatrix).normalize();
      } else {
        this.hitNormal.copy(this.raycaster.ray.direction).negate();
      }
      if (this.hitNormal.dot(this.raycaster.ray.direction) > 0) {
        this.hitNormal.negate();
      }
      hitNormal = this.hitNormal;
    }

    this.send({ type: 'fire', hitAgentId });
    if (this.targets.ammoInMagazine() >= ammo) return null;
    this.viewModel.fire();
    this.playCue(def.fireAudioCue);

    const origin = this.viewModel.muzzlePosition(this.muzzleOrigin);
    this.effects.spawnShot({
      weaponId,
      origin,
      direction: this.raycaster.ray.direction,
      hitPoint: hit ? hit.point : null,
      hitNormal,
      hitAgentId,
      worldTargets,
    });

    const shot = { hitAgentId, point: hit?.point.clone() ?? null };
    for (const listener of this.listeners) listener(shot);
    return shot;
  }

  dispose(): void {
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('wheel', this.onWheel);
    this.viewModel.dispose();
    this.effects.dispose();
    this.listeners.clear();
  }

  private currentWeaponId(): WeaponId {
    const raw = this.targets.weaponId?.() ?? DEFAULT_WEAPON;
    return isWeaponId(raw) ? raw : DEFAULT_WEAPON;
  }

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0 || !this.sceneManager.isPointerLocked()) return;
    this.fire();
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.enabled || !this.sceneManager.isPointerLocked() || event.deltaY === 0) return;
    const now = performance.now();
    if (now - this.lastSwitchMs < SWITCH_COOLDOWN_MS) return;
    this.lastSwitchMs = now;
    const currentIndex = WEAPON_ORDER.indexOf(this.currentWeaponId());
    const delta = event.deltaY > 0 ? 1 : -1;
    const nextIndex = (currentIndex + delta + WEAPON_ORDER.length) % WEAPON_ORDER.length;
    this.switchWeapon(WEAPON_ORDER[nextIndex]);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat || !this.enabled) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return;

    const slotMatch = /^(?:Digit|Numpad)([1-6])$/.exec(event.code);
    if (slotMatch) {
      const next = WEAPON_ORDER[Number(slotMatch[1]) - 1];
      if (next) this.switchWeapon(next);
      return;
    }

    if (event.code !== 'KeyR') return;
    const def = getWeaponDefinition(this.currentWeaponId());
    const ammo = this.targets.ammoInMagazine();
    const wasEmpty = ammo === 0;
    this.send({ type: 'reload' });
    const loaded = this.targets.ammoInMagazine() - ammo;
    if (loaded > 0) {
      this.viewModel.reload(loaded, wasEmpty);
      this.playCue(def.reloadAudioCue);
    }
  };

  private playCue(cue: WeaponControllerCue): void {
    const position = this.viewModel.muzzlePosition(this.audioPosition);
    AudioManager.playWeaponCue(this.sceneManager.camera, cue, position);
  }
}
