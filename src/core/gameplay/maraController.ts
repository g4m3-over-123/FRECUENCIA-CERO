import type { GridCoord, MaraPosture, MaraSnapshot, SoundEvent } from '../contracts.ts';
import type { WeightedGraph } from '../graph/WeightedGraph.ts';
import { createWeaponSnapshot } from './weapons.ts';

export type { MaraPosture };

/**
 * Extended Mara snapshot structurally assignable to MaraSnapshot.
 */
export interface ExtendedMaraSnapshot extends MaraSnapshot {
  hasFuel: boolean;
  hasBattery: boolean;
  decoysRemaining: number;
  barricadesRemaining: number;
  posture: MaraPosture;
  facing: GridCoord;
}

export interface MaraInputState {
  moveDirection: GridCoord;
  sprinting: boolean;
  crouching: boolean;
  emitDecoy: boolean;
  placeBarricade?: boolean;
  barricadeTarget?: GridCoord;
  decoyTarget?: GridCoord;
  interact?: boolean;
}

export interface MaraUpdateResult {
  mara: ExtendedMaraSnapshot;
  emittedSound: SoundEvent | null;
  decoySound: SoundEvent | null;
  placedBarricade: GridCoord | null;
  barricadeSound: SoundEvent | null;
  moved: boolean;
}

export interface MaraControllerOptions {
  graph?: WeightedGraph;
  occupiedByAgents?: readonly GridCoord[];
  protectedCells?: readonly GridCoord[];
  decoyThrowRange?: number;
  cellSize?: number;
}

export function getScaledRadiiForCellSize(cellSize = 2): {
  stepRadius: number;
  sprintRadius: number;
  decoyRadius: number;
  decoyThrowRange: number;
  barricadeRadius: number;
} {
  const isFineGrid = cellSize <= 1;
  return isFineGrid
    ? {
        stepRadius: 5,
        sprintRadius: 12,
        decoyRadius: 18,
        decoyThrowRange: 7,
        barricadeRadius: 9,
      }
    : {
        stepRadius: 2.5,
        sprintRadius: 7,
        decoyRadius: 12,
        decoyThrowRange: 4,
        barricadeRadius: 5,
      };
}

const SPRINT_STAMINA_COST = 8;
const WALK_STAMINA_RECOVERY = 3;
const STEALTH_STAMINA_RECOVERY = 1;
const IDLE_STAMINA_RECOVERY = 5;

export function createInitialMaraSnapshot(
  spawn: GridCoord,
  overrides: Partial<ExtendedMaraSnapshot> = {}
): ExtendedMaraSnapshot {
  return {
    position: { ...spawn },
    noiseLevel: 0,
    health: 100,
    stamina: 100,
    hasMedicalKit: false,
    reachedExtraction: false,
    hasFuel: false,
    hasBattery: false,
    decoysRemaining: 3,
    barricadesRemaining: 3,
    posture: 'stealth',
    facing: { row: 0, col: 1 },
    weapon: createWeaponSnapshot(),
    ...overrides,
  };
}

function toExtendedMara(mara: MaraSnapshot): ExtendedMaraSnapshot {
  const maybe = mara as Partial<ExtendedMaraSnapshot>;
  return {
    position: { ...mara.position },
    noiseLevel: mara.noiseLevel,
    health: mara.health,
    stamina: mara.stamina,
    hasMedicalKit: mara.hasMedicalKit,
    reachedExtraction: mara.reachedExtraction,
    hasFuel: maybe.hasFuel ?? false,
    hasBattery: maybe.hasBattery ?? false,
    decoysRemaining: maybe.decoysRemaining ?? 3,
    barricadesRemaining: maybe.barricadesRemaining ?? 3,
    posture: maybe.posture ?? 'stealth',
    facing: maybe.facing ? { ...maybe.facing } : { row: 0, col: 1 },
    weapon: mara.weapon ? { ...mara.weapon } : createWeaponSnapshot(),
  };
}

function clampStep(value: number): number {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

function isSameCoord(a: GridCoord, b: GridCoord): boolean {
  return a.row === b.row && a.col === b.col;
}

function canStepTo(graph: WeightedGraph | undefined, from: GridCoord, to: GridCoord): boolean {
  if (!graph) return to.row >= 0 && to.col >= 0;
  if (!graph.isWalkable(to)) return false;

  const dr = to.row - from.row;
  const dc = to.col - from.col;
  if (dr !== 0 && dc !== 0) {
    if (!graph.allowDiagonal) return false;
    if (
      graph.preventCornerCutting &&
      (!graph.isWalkable({ row: from.row + dr, col: from.col }) ||
        !graph.isWalkable({ row: from.row, col: from.col + dc }))
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Computes the furthest walkable cell along a throw vector up to maxRange for an acoustic decoy.
 */
export function computeDecoyLandingCell(
  origin: GridCoord,
  direction: GridCoord,
  graph?: WeightedGraph,
  explicitTarget?: GridCoord,
  maxRange = 4
): GridCoord {
  if (explicitTarget && (!graph || graph.isWalkable(explicitTarget))) {
    return { ...explicitTarget };
  }

  const stepR = clampStep(direction.row);
  const stepC = clampStep(direction.col);
  const dr = stepR === 0 && stepC === 0 ? 0 : stepR;
  const dc = stepR === 0 && stepC === 0 ? 1 : stepC;

  let landing: GridCoord = { ...origin };
  for (let dist = 1; dist <= maxRange; dist++) {
    const candidate: GridCoord = {
      row: origin.row + dr * dist,
      col: origin.col + dc * dist,
    };
    if (graph && !graph.isWalkable(candidate)) break;
    if (!graph && (candidate.row < 0 || candidate.col < 0)) break;
    landing = candidate;
  }

  return landing;
}

/**
 * Selects a valid adjacent walkable cell to place a dynamic barricade.
 */
export function selectBarricadePlacementCell(
  maraPos: GridCoord,
  preferredDirection: GridCoord,
  graph: WeightedGraph,
  occupiedByAgents: readonly GridCoord[] = [],
  protectedCells: readonly GridCoord[] = [],
  explicitTarget?: GridCoord
): GridCoord | null {
  const isAvailable = (coord: GridCoord): boolean => {
    if (!graph.isWalkable(coord)) return false;
    if (isSameCoord(coord, maraPos)) return false;
    if (occupiedByAgents.some((pos) => isSameCoord(pos, coord))) return false;
    if (protectedCells.some((pos) => isSameCoord(pos, coord))) return false;
    return true;
  };

  if (explicitTarget && isAvailable(explicitTarget)) {
    return { ...explicitTarget };
  }

  const dr = clampStep(preferredDirection.row);
  const dc = clampStep(preferredDirection.col);
  const candidates: GridCoord[] = [];

  if (dr !== 0 || dc !== 0) {
    candidates.push({ row: maraPos.row + dr, col: maraPos.col + dc });
    candidates.push({ row: maraPos.row - dr, col: maraPos.col - dc });
  }

  const cardinalOffsets: ReadonlyArray<readonly [number, number]> = [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ];
  for (const [or, oc] of cardinalOffsets) {
    candidates.push({ row: maraPos.row + or, col: maraPos.col + oc });
  }

  for (const candidate of candidates) {
    if (isAvailable(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Pure simulation controller for Mara's discrete movement, stealth/sprint posture,
 * stamina, acoustic decoys (key Q), and dynamic barricades (key E).
 */
export function updateMaraState(
  mara: MaraSnapshot,
  input: MaraInputState,
  tick: number,
  options: MaraControllerOptions = {}
): MaraUpdateResult {
  const next = toExtendedMara(mara);
  const stepR = clampStep(input.moveDirection.row);
  const stepC = clampStep(input.moveDirection.col);
  const wantsToMove = stepR !== 0 || stepC !== 0;

  if (wantsToMove) {
    next.facing = { row: stepR, col: stepC };
  }

  const actuallySprinting = wantsToMove && input.sprinting && !input.crouching && next.stamina >= SPRINT_STAMINA_COST;
  const actuallyCrouching = input.crouching;

  let posture: MaraPosture = 'walk';
  if (actuallyCrouching) posture = 'stealth';
  else if (actuallySprinting) posture = 'sprint';
  next.posture = posture;

  let moved = false;
  if (wantsToMove) {
    const candidate: GridCoord = {
      row: next.position.row + stepR,
      col: next.position.col + stepC,
    };
    if (canStepTo(options.graph, next.position, candidate)) {
      next.position = candidate;
      moved = true;
    } else if (stepR !== 0 && stepC !== 0) {
      // Slide orthogonally if diagonal is blocked by corner-cutting or obstacle.
      const altA = { row: next.position.row + stepR, col: next.position.col };
      const altB = { row: next.position.row, col: next.position.col + stepC };
      if (canStepTo(options.graph, next.position, altA)) {
        next.position = altA;
        moved = true;
      } else if (canStepTo(options.graph, next.position, altB)) {
        next.position = altB;
        moved = true;
      }
    }
  }

  const scaled = getScaledRadiiForCellSize(options.cellSize);
  const emittedSound = applyMovementNoise(next, posture, moved, tick, options.cellSize);

  let decoySound: SoundEvent | null = null;
  if (input.emitDecoy && next.decoysRemaining > 0) {
    const landing = computeDecoyLandingCell(
      next.position,
      next.facing,
      options.graph,
      input.decoyTarget,
      options.decoyThrowRange ?? scaled.decoyThrowRange
    );
    next.decoysRemaining--;
    decoySound = {
      id: `sound-decoy-${tick}`,
      sourceId: `decoy-${tick}`,
      position: landing,
      radius: scaled.decoyRadius,
      intensity: 1,
      timestamp: tick,
    };
  }

  let placedBarricade: GridCoord | null = null;
  let barricadeSound: SoundEvent | null = null;
  if (input.placeBarricade && next.barricadesRemaining > 0 && options.graph) {
    const cell = selectBarricadePlacementCell(
      next.position,
      next.facing,
      options.graph,
      options.occupiedByAgents,
      options.protectedCells,
      input.barricadeTarget
    );
    if (cell) {
      next.barricadesRemaining--;
      placedBarricade = cell;
      barricadeSound = {
        id: `sound-barricade-${tick}`,
        sourceId: 'barricade_place',
        position: { ...cell },
        radius: scaled.barricadeRadius,
        intensity: 0.62,
        timestamp: tick,
      };
    }
  }

  return {
    mara: next,
    emittedSound,
    decoySound,
    placedBarricade,
    barricadeSound,
    moved,
  };
}

/**
 * Updates noise and stamina after a movement attempt and returns the footstep sound, if any.
 * Shared by discrete input (updateMaraState) and FPV-driven movement (applyExternalMaraMove).
 */
function applyMovementNoise(
  next: ExtendedMaraSnapshot,
  posture: MaraPosture,
  moved: boolean,
  tick: number,
  cellSize = 2
): SoundEvent | null {
  if (!moved) {
    next.noiseLevel = 0;
    next.stamina = Math.min(100, next.stamina + IDLE_STAMINA_RECOVERY);
    return null;
  }
  if (posture === 'stealth') {
    next.noiseLevel = 0;
    next.stamina = Math.min(100, next.stamina + STEALTH_STAMINA_RECOVERY);
    return null;
  }
  const scaled = getScaledRadiiForCellSize(cellSize);
  if (posture === 'sprint') {
    next.noiseLevel = 0.85;
    next.stamina = Math.max(0, next.stamina - SPRINT_STAMINA_COST);
    return {
      id: `sound-sprint-${tick}`,
      sourceId: 'mara_sprint',
      position: { ...next.position },
      radius: scaled.sprintRadius,
      intensity: 0.85,
      timestamp: tick,
    };
  }
  next.noiseLevel = 0.25;
  next.stamina = Math.min(100, next.stamina + WALK_STAMINA_RECOVERY);
  return {
    id: `sound-step-${tick}`,
    sourceId: 'mara_step',
    position: { ...next.position },
    radius: scaled.stepRadius,
    intensity: 0.32,
    timestamp: tick,
  };
}

export interface ExternalMaraMove {
  cell: GridCoord;
  posture: MaraPosture;
  facing?: GridCoord;
  cellSize?: number;
}

/**
 * Applies a position reported by the FPV PlayerController (the browser owns continuous
 * movement and collision). The engine still validates the cell and derives noise and
 * stamina from the posture, so stealth rules keep working.
 * Sprint falls back to walk when stamina is exhausted.
 */
export function applyExternalMaraMove(
  mara: MaraSnapshot,
  move: ExternalMaraMove,
  tick: number,
  graph?: WeightedGraph,
  cellSize = move.cellSize ?? 2
): { mara: ExtendedMaraSnapshot; emittedSound: SoundEvent | null; moved: boolean } {
  const next = toExtendedMara(mara);
  const target = move.cell;
  const valid = graph ? graph.isWalkable(target) : target.row >= 0 && target.col >= 0;
  const moved = valid && !isSameCoord(target, next.position);

  if (moved) {
    const dr = clampStep(target.row - next.position.row);
    const dc = clampStep(target.col - next.position.col);
    next.facing = { row: dr, col: dc };
    next.position = { ...target };
  }
  if (move.facing && (move.facing.row !== 0 || move.facing.col !== 0)) {
    next.facing = { row: clampStep(move.facing.row), col: clampStep(move.facing.col) };
  }

  let posture = move.posture;
  if (posture === 'sprint' && next.stamina < SPRINT_STAMINA_COST) posture = 'walk';
  next.posture = posture;

  const emittedSound = applyMovementNoise(next, posture, moved, tick, cellSize);
  return { mara: next, emittedSound, moved };
}
