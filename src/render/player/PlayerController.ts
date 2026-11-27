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
  private cellCenter: WorldPoint;
  private readonly probe: GridCoord = { row: 0, col: 0 };
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
    this.cellCenter = gridToWorld(this.cell, map);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  spawn(cell: GridCoord): void {
    this.position = gridToWorld(cell, this.map);
    this.cellCenter = { ...this.position };
    this.cell = { ...cell };
    this.sceneManager.setPlayerPose(this.position.x, this.position.z, false, 1);
    this.posture = 'walk';
    let longest = 0;
    this.facing = { row: -1, col: 0 };
    for (const [dr, dc] of [[-1, 0], [0, 1], [1, 0], [0, -1], [-1, 1], [1, 1], [1, -1], [-1, -1]]) {
      let { row, col } = cell;
      let steps = 0;
      while (this.isStaticWalkable({ row: row + dr, col: col + dc })) {
        if (dr && dc && (!this.isStaticWalkable({ row: row + dr, col }) ||
          !this.isStaticWalkable({ row, col: col + dc }))) break;
        row += dr;
        col += dc;
        steps++;
      }
      const distance = steps * Math.hypot(dr, dc);
      if (distance > longest) {
        longest = distance;
        this.facing = { row: dr, col: dc };
      }
    }
    const ahead = gridToWorld({ row: cell.row + this.facing.row, col: cell.col + this.facing.col }, this.map);
    this.sceneManager.camera.lookAt(ahead.x, this.sceneManager.camera.position.y, ahead.z);
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

    const recovering = this.recoverFromBarricade(dt);
    if (moving && !recovering) {
      let dx = this.forward.x * forwardInput - this.forward.z * strafeInput;
      let dz = this.forward.z * forwardInput + this.forward.x * strafeInput;
      const len = Math.hypot(dx, dz) || 1;
      const step = SPEED[posture] * Math.min(dt, 0.05);
      dx = (dx / len) * step;
      dz = (dz / len) * step;
      // Axis-separated moves let the player slide along walls.
      this.slideAxis('x', dx);
      this.slideAxis('z', dz);
    }

    this.sceneManager.setPlayerPose(this.position.x, this.position.z, posture === 'stealth', dt);

    const cell = moving && !recovering ? worldToGrid(this.position, this.map) : this.cell;
    const movedCell = cell.row !== this.cell.row || cell.col !== this.cell.col;
    const changed =
      movedCell ||
      posture !== this.posture ||
      facing.row !== this.facing.row ||
      facing.col !== this.facing.col;
    this.posture = posture;
    if (facing.row !== 0 || facing.col !== 0) this.facing = facing;
    if (changed && this.isWalkable(cell)) {
      if (movedCell) this.cellCenter = gridToWorld(cell, this.map);
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

  private recoverFromBarricade(dt: number): boolean {
    const blocked = this.options.isDynamicallyBlocked;
    if (!blocked) return false;
    const dx = this.position.x - this.cellCenter.x;
    const dz = this.position.z - this.cellCenter.z;
    const half = this.map.cellSize / 2;
    const gapX = half - Math.abs(dx);
    const gapZ = half - Math.abs(dz);
    const col = this.cell.col + Math.sign(dx);
    const row = this.cell.row + Math.sign(dz);
    this.probe.row = this.cell.row;
    this.probe.col = col;
    let overlaps = gapX < PLAYER_RADIUS && blocked(this.probe);
    this.probe.row = row;
    this.probe.col = this.cell.col;
    overlaps ||= gapZ < PLAYER_RADIUS && blocked(this.probe);
    this.probe.col = col;
    overlaps ||= gapX * gapX + gapZ * gapZ < PLAYER_RADIUS ** 2 && blocked(this.probe);
    if (!overlaps) return false;
    const correction = 1 - Math.exp(-12 * dt);
    this.position.x -= dx * correction;
    this.position.z -= dz * correction;
    return true;
  }

  /** Sweep the player's circle to the first contact along this axis. */
  private slideAxis(axis: 'x' | 'z', delta: number): void {
    if (delta === 0) return;
    const { x, z } = this.position;
    const endX = axis === 'x' ? x + delta : x;
    const endZ = axis === 'z' ? z + delta : z;
    const r = PLAYER_RADIUS;
    const min = worldToGrid({ x: Math.min(x, endX) - r, z: Math.min(z, endZ) - r }, this.map);
    const max = worldToGrid({ x: Math.max(x, endX) + r, z: Math.max(z, endZ) + r }, this.map);
    const across = axis === 'x' ? 'z' : 'x';
    const half = this.map.cellSize / 2;
    const start = this.position[axis];
    let travel = Math.abs(delta);
    const sign = Math.sign(delta);
    for (let row = min.row; row <= max.row; row++) {
      for (let col = min.col; col <= max.col; col++) {
        this.probe.row = row;
        this.probe.col = col;
        if (this.isWalkable(this.probe)) continue;
        const center = gridToWorld(this.probe, this.map);
        const gap = Math.max(0, Math.abs(center[across] - this.position[across]) - half);
        const ahead = (center[axis] - start) * sign;
        if (gap >= r || ahead <= 0) continue;
        const contact = ahead - half - Math.sqrt(r * r - gap * gap);
        travel = Math.min(travel, Math.max(0, contact - 1e-7));
      }
    }
    this.position[axis] += sign * travel;
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
