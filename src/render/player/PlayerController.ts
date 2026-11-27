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
import type { CollisionMask } from '../world/collisionMask.ts';

/**
 * Phase 0 FPV player: WASD movement with collision against the logical grid, posture
 * (C crouch = silent, Shift sprint = loud) and moveToCell commands to the simulation.
 * The browser owns continuous movement; the engine owns noise, stamina and rules.
 * Front A (world/player) owns this file.
 */

const SPEED: Record<MaraPosture, number> = { stealth: 1.7, walk: 3.2, sprint: 5.6 };
const PLAYER_RADIUS = 0.28;
/** Longest move between collision checks; well under the radius so walls are never skipped. */
const MAX_SUBSTEP = 0.1;
const MAX_PUSHES = 8;

interface Box {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface PlayerControllerOptions {
  /** Extra blocked cells (dynamic barricades from the snapshot). */
  isDynamicallyBlocked?: (cell: GridCoord) => boolean;
  /** Stamina gate for sprint (the engine also enforces it). */
  canSprint?: () => boolean;
  /** Fine collision against the real walls; without it the player collides with whole cells. */
  collision?: CollisionMask | null;
}

export class PlayerController {
  private readonly keys = new Set<string>();
  private readonly isStaticWalkable: (cell: GridCoord) => boolean;
  private position: WorldPoint = { x: 0, z: 0 };
  private cell: GridCoord = { row: 0, col: 0 };
  private readonly probe: GridCoord = { row: 0, col: 0 };
  private readonly boxes: Box[] = [];
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

    if (moving) {
      const dx = this.forward.x * forwardInput - this.forward.z * strafeInput;
      const dz = this.forward.z * forwardInput + this.forward.x * strafeInput;
      const len = Math.hypot(dx, dz) || 1;
      // SceneManager already caps dt at 0.1 s; sub-steps keep the speed right on slow frames.
      const distance = SPEED[posture] * dt;
      const steps = Math.max(1, Math.ceil(distance / MAX_SUBSTEP));
      const stepX = (dx / len) * (distance / steps);
      const stepZ = (dz / len) * (distance / steps);
      for (let i = 0; i < steps; i++) {
        this.position.x += stepX;
        this.position.z += stepZ;
        this.resolveCollisions();
      }
    } else {
      // A barricade can appear next to a standing player: push out of it.
      this.resolveCollisions();
    }

    this.sceneManager.setPlayerPose(this.position.x, this.position.z, posture === 'stealth', dt);

    const cell = this.logicalCell();
    const movedCell = cell.row !== this.cell.row || cell.col !== this.cell.col;
    const changed =
      movedCell ||
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

  /**
   * Cell reported to the simulation. Fine collision lets the player stand in the strip of a
   * blocked cell in front of a wall; then the closest walkable neighbour is reported.
   */
  private logicalCell(): GridCoord {
    const here = worldToGrid(this.position, this.map);
    if (this.isWalkable(here)) return here;
    let best: GridCoord | null = null;
    let bestDistance = Infinity;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const cell = { row: here.row + dr, col: here.col + dc };
        if (!this.isWalkable(cell)) continue;
        const center = gridToWorld(cell, this.map);
        const distance = (center.x - this.position.x) ** 2 + (center.z - this.position.z) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = cell;
        }
      }
    }
    return best ?? this.cell;
  }

  /** Solid boxes that may touch the player's circle: fine walls, then grid cells or barricades. */
  private collectBoxes(): Box[] {
    const boxes = this.boxes;
    boxes.length = 0;
    const r = PLAYER_RADIUS;
    const { x, z } = this.position;
    const mask = this.options.collision;
    if (mask) {
      const s = mask.cellSize;
      const c0 = Math.floor((x - r - mask.origin.x) / s);
      const c1 = Math.floor((x + r - mask.origin.x) / s);
      const r0 = Math.floor((z - r - mask.origin.z) / s);
      const r1 = Math.floor((z + r - mask.origin.z) / s);
      for (let row = r0; row <= r1; row++) {
        for (let col = c0; col <= c1; col++) {
          if (!mask.isSolid(row, col)) continue;
          const minX = mask.origin.x + col * s;
          const minZ = mask.origin.z + row * s;
          boxes.push({ minX, minZ, maxX: minX + s, maxZ: minZ + s });
        }
      }
    }
    const min = worldToGrid({ x: x - r, z: z - r }, this.map);
    const max = worldToGrid({ x: x + r, z: z + r }, this.map);
    const half = this.map.cellSize / 2;
    for (let row = min.row; row <= max.row; row++) {
      for (let col = min.col; col <= max.col; col++) {
        this.probe.row = row;
        this.probe.col = col;
        const blocked = mask
          ? this.options.isDynamicallyBlocked?.(this.probe) ?? false
          : !this.isWalkable(this.probe);
        if (!blocked) continue;
        const center = gridToWorld(this.probe, this.map);
        boxes.push({ minX: center.x - half, minZ: center.z - half, maxX: center.x + half, maxZ: center.z + half });
      }
    }
    return boxes;
  }

  /**
   * Pushes the player's circle out of solid boxes, deepest contact first, so it slides along
   * walls and round corners without catching on the seams between neighbouring boxes.
   */
  private resolveCollisions(): void {
    const r = PLAYER_RADIUS;
    const boxes = this.collectBoxes();
    for (let push = 0; push < MAX_PUSHES; push++) {
      let deepest = 0;
      let pushX = 0;
      let pushZ = 0;
      const { x, z } = this.position;
      for (const box of boxes) {
        const nearX = Math.min(Math.max(x, box.minX), box.maxX);
        const nearZ = Math.min(Math.max(z, box.minZ), box.maxZ);
        const dx = x - nearX;
        const dz = z - nearZ;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        let depth: number;
        let nx: number;
        let nz: number;
        if (d2 > 1e-12) {
          const d = Math.sqrt(d2);
          depth = r - d;
          nx = dx / d;
          nz = dz / d;
        } else {
          // Centre inside the box: leave through the nearest face.
          const exits = [
            [x - box.minX, -1, 0],
            [box.maxX - x, 1, 0],
            [z - box.minZ, 0, -1],
            [box.maxZ - z, 0, 1],
          ];
          const [inside, ex, ez] = exits.reduce((a, b) => (b[0] < a[0] ? b : a));
          depth = inside + r;
          nx = ex;
          nz = ez;
        }
        if (depth > deepest) {
          deepest = depth;
          pushX = nx * depth;
          pushZ = nz * depth;
        }
      }
      if (deepest <= 1e-6) return;
      this.position.x += pushX * 1.0001;
      this.position.z += pushZ * 1.0001;
    }
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
