import type {
  AlgorithmType,
  GameCommand,
  GridCoord,
  HeuristicType,
  MapDefinition,
} from '../core/contracts.ts';
import type { SearchStats } from '../core/algorithms/shortestPath.ts';
import type { ExtendedWorldSnapshot } from '../core/gameplay/SimulationEngine.ts';

/**
 * Anything that produces snapshots: the real SimulationEngine or the MockWorld (?mock=1).
 * SimulationEngine satisfies this interface structurally.
 */
export interface SimulationSource {
  getSnapshot(): ExtendedWorldSnapshot;
  step(deltaMs: number): ExtendedWorldSnapshot;
  applyCommand(command: GameCommand): void;
  setPaused(paused: boolean): void;
  reset(): void;
  setAlgorithm(algorithm: AlgorithmType, heuristic: HeuristicType): void;
  setCoordinationEnabled(enabled: boolean): void;
  compareAlgorithms?(start: GridCoord, goal: GridCoord): { dijkstra: SearchStats; astar: SearchStats };
}

/** What every renderer receives each frame. */
export interface FrameState {
  /** Snapshot of the previous tick (same as `current` right after a reset). */
  previous: ExtendedWorldSnapshot;
  /** Snapshot of the latest tick. Positions interpolate from previous to current. */
  current: ExtendedWorldSnapshot;
  /** 0..1 progress between previous and current tick. */
  alpha: number;
  /** Seconds since last frame. */
  dt: number;
  /** True on the frame right after a new tick was produced. */
  ticked: boolean;
}

/** Zombie chase speed the tick length is derived from (one cell per active tick). */
export const ZOMBIE_CHASE_SPEED_MPS = 2.6;

/**
 * Fixed tick length so that an agent moving one cell per tick runs at ZOMBIE_CHASE_SPEED_MPS.
 * 1 m cells -> ~385 ms, 2 m cells -> ~770 ms (clamped to 250..900 ms).
 */
export function tickMsForMap(map: Pick<MapDefinition, 'cellSize'>): number {
  const ms = (map.cellSize / ZOMBIE_CHASE_SPEED_MPS) * 1000;
  return Math.round(Math.min(900, Math.max(250, ms)));
}

/**
 * Fixed-step simulation + per-frame interpolation.
 * The simulation advances at `tickMs`; rendering runs every frame and interpolates.
 */
export class GameLoop {
  private previous: ExtendedWorldSnapshot;
  private current: ExtendedWorldSnapshot;
  private accumulatorMs = 0;
  private running = false;
  private readonly tickListeners = new Set<(snapshot: ExtendedWorldSnapshot) => void>();

  constructor(
    readonly source: SimulationSource,
    readonly tickMs: number
  ) {
    this.current = source.getSnapshot();
    this.previous = this.current;
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Sends a command to the simulation. Effects (sounds, damage) resolve on the next tick. */
  send(command: GameCommand): void {
    this.source.applyCommand(command);
    this.refresh();
  }

  /** Re-reads instant values (ammo, pause flag) without breaking interpolation of positions. */
  refresh(): void {
    const latest = this.source.getSnapshot();
    this.current = { ...latest, agents: this.current.agents, tick: this.current.tick };
  }

  /** Latest values for HUDs (ammo, health). Positions should come from frame(). */
  latest(): ExtendedWorldSnapshot {
    return this.current;
  }

  reset(): void {
    this.source.reset();
    this.accumulatorMs = 0;
    this.current = this.source.getSnapshot();
    this.previous = this.current;
    for (const listener of this.tickListeners) listener(this.current);
  }

  onTick(listener: (snapshot: ExtendedWorldSnapshot) => void): () => void {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

  /** Call once per animation frame. */
  frame(dt: number): FrameState {
    let ticked = false;
    if (this.running && !this.current.paused && this.current.status === 'playing') {
      this.accumulatorMs += dt * 1000;
      let steps = 0;
      while (this.accumulatorMs >= this.tickMs && steps < 3) {
        this.accumulatorMs -= this.tickMs;
        this.previous = this.current;
        this.current = this.source.step(this.tickMs);
        steps++;
        ticked = true;
        for (const listener of this.tickListeners) listener(this.current);
      }
      if (steps === 3) this.accumulatorMs = 0;
    } else {
      // Keep paused/finished state fresh (pause flag, final status) without stepping.
      this.accumulatorMs = 0;
    }
    return {
      previous: this.previous,
      current: this.current,
      alpha: Math.min(1, this.accumulatorMs / this.tickMs),
      dt,
      ticked,
    };
  }
}
