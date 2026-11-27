import * as THREE from 'three';
import type { GameCommand, GridCoord, MapDefinition, MaraPosture } from '../../core/contracts.ts';
import {
  createWalkableLookup,
  gridToWorld,
  worldDirectionToGrid,
  worldToGrid,
  type WorldPoint,
} from '../../core/world/gridSpace.ts';
import type { SceneManager } from '../SceneManager.ts';

/**
 * Phase 0 FPV player: WASD movement with collision against the logical grid, posture
 * (C crouch = silent, Shift sprint = loud) and moveToCell commands to the simulation.
 * The browser owns continuous movement; the engine owns noise, stamina and rules.
 * Front A (world/player) owns this file.
 */

const SPEED: Record<MaraPosture, number> = { stealth: 1.7, walk: 3.2, sprint: 5.6 };
const PLAYER_RADIUS = 0.28;

export interface PlayerControllerOptions {
  /** Extra blocked cells (dynamic barricades from the snapshot). */
  isDynamicallyBlocked?: (cell: GridCoord) => boolean;
  /** Stamina gate for sprint (the engine also enforces it). */
  canSprint?: () => boolean;
}

export class PlayerController {
  private readonly keys = new Set<string>();
  private readonly isStaticWalkable: (cell: GridCoord) => boolean;
  private position: WorldPoint = { x: 0, z: 0 };
  private cell: GridCoord = { row: 0, col: 0 };
  private posture: MaraPosture = 'walk';
  private facing: GridCoord = { row: 0, col: 1 };
  private readonly forward = new THREE.Vector3();
  private enabled = true;

  constructor(
    private readonly sceneManager: SceneManager,
    private readonly map: MapDefinition,
    private readonly send: (command: GameCommand) => void,
    private readonly options: PlayerControllerOptions = {}
  ) {
    this.isStaticWalkable = createWalkableLookup(map);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  spawn(cell: GridCoord): void {
    this.position = gridToWorld(cell, this.map);
    this.cell = { ...cell };
    this.sceneManager.setPlayerPose(this.position.x, this.position.z, false, 1);
    this.sceneManager.camera.lookAt(this.position.x, 1.5, this.position.z - 5);
    this.emitMove();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.keys.clear();
  }

  getCell(): GridCoord {
    return { ...this.cell };
  }

  getPosition(): WorldPoint {
    return { ...this.position };
  }

  getPosture(): MaraPosture {
    return this.posture;
  }

  getFacing(): GridCoord {
    return { ...this.facing };
  }

  update(dt: number): void {
    // C crouches. Ctrl is avoided on purpose: Ctrl+W closes the browser tab mid-game.
    const crouch = this.keys.has('KeyC');
    const sprintKey = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');

    let forwardInput = 0;
    let strafeInput = 0;
    if (this.enabled) {
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) forwardInput += 1;
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) forwardInput -= 1;
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) strafeInput += 1;
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) strafeInput -= 1;
    }
    const moving = forwardInput !== 0 || strafeInput !== 0;

    let posture: MaraPosture = 'walk';
    if (crouch) posture = 'stealth';
    else if (sprintKey && moving && forwardInput > 0 && (this.options.canSprint?.() ?? true)) posture = 'sprint';

    this.sceneManager.getForwardVector(this.forward);
    const facing = worldDirectionToGrid(this.forward.x, this.forward.z);

    if (moving) {
      const right = { x: -this.forward.z, z: this.forward.x };
      let dx = this.forward.x * forwardInput + right.x * strafeInput;
      let dz = this.forward.z * forwardInput + right.z * strafeInput;
      const len = Math.hypot(dx, dz) || 1;
      const step = SPEED[posture] * Math.min(dt, 0.05);
      dx = (dx / len) * step;
      dz = (dz / len) * step;
      // Axis-separated moves let the player slide along walls.
      if (this.canOccupy(this.position.x + dx, this.position.z)) this.position.x += dx;
      if (this.canOccupy(this.position.x, this.position.z + dz)) this.position.z += dz;
    }

    this.sceneManager.setPlayerPose(this.position.x, this.position.z, posture === 'stealth', dt);

    const cell = worldToGrid(this.position, this.map);
    const changed =
      cell.row !== this.cell.row ||
      cell.col !== this.cell.col ||
      posture !== this.posture ||
      facing.row !== this.facing.row ||
      facing.col !== this.facing.col;
    this.posture = posture;
    if (facing.row !== 0 || facing.col !== 0) this.facing = facing;
    if (changed && this.isWalkable(cell)) {
      this.cell = cell;
      this.emitMove();
    }
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }

  private emitMove(): void {
    this.send({ type: 'moveToCell', cell: { ...this.cell }, posture: this.posture, facing: { ...this.facing } });
  }

  private isWalkable(cell: GridCoord): boolean {
    return this.isStaticWalkable(cell) && !(this.options.isDynamicallyBlocked?.(cell) ?? false);
  }

  /** True when a circle of PLAYER_RADIUS at (x, z) only overlaps walkable cells. */
  private canOccupy(x: number, z: number): boolean {
    const r = PLAYER_RADIUS;
    const corners: WorldPoint[] = [
      { x: x - r, z: z - r },
      { x: x + r, z: z - r },
      { x: x - r, z: z + r },
      { x: x + r, z: z + r },
    ];
    return corners.every((p) => this.isWalkable(worldToGrid(p, this.map)));
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    this.keys.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private readonly onBlur = (): void => {
    this.keys.clear();
  };
}
