import type { GridCoord, MapDefinition, SoundEvent } from '../contracts.ts';
import type { WeightedGraph } from '../graph/WeightedGraph.ts';

export interface ReceivedAlertSignal {
  originAgentId: string;
  fromAgentId: string;
  position: GridCoord;
  signalStrength: number;
  depth: number;
  receivedTick: number;
}

export interface LocalPerception {
  /** Populated strictly when an unobstructed target is inside local vision range. */
  visualTarget: GridCoord | null;
  audibleSounds: SoundEvent[];
  strongestSound: SoundEvent | null;
  receivedAlert: ReceivedAlertSignal | null;
  summary: string;
}

/**
 * Builds a lookup set of vision-blocking cell ids (buildings and tall obstacles).
 * Low street barricades block movement in the graph without blocking line of sight.
 */
export function buildOpaqueCellSet(map: MapDefinition): Set<number> {
  const opaque = new Set<number>();
  for (const cell of map.cells) {
    if (cell.type === 'building' || cell.type === 'obstacle') {
      opaque.add(cell.row * map.width + cell.col);
    }
  }
  return opaque;
}

/**
 * Computes Euclidean distance between two grid coordinates.
 */
export function gridDistance(a: GridCoord, b: GridCoord): number {
  return Math.hypot(a.row - b.row, a.col - b.col);
}

/**
 * Evaluates local line-of-sight using a Bresenham grid raycast bounded by visionRange.
 * Intermediate cells that are opaque (or non-walkable when opaqueCells is omitted) block sight.
 */
export function hasLineOfSight(
  graph: WeightedGraph,
  from: GridCoord,
  to: GridCoord,
  visionRange: number,
  opaqueCells?: ReadonlySet<number>
): boolean {
  if (!graph.inBounds(from) || !graph.inBounds(to)) return false;
  if (visionRange < 0) return false;

  const dist = gridDistance(from, to);
  if (dist > visionRange) return false;
  if (from.row === to.row && from.col === to.col) return true;

  let r = from.row;
  let c = from.col;
  const dr = Math.abs(to.row - from.row);
  const dc = Math.abs(to.col - from.col);
  const stepR = from.row < to.row ? 1 : -1;
  const stepC = from.col < to.col ? 1 : -1;
  let err = dc - dr;

  const isOpaque = (row: number, col: number): boolean => {
    const coord = { row, col };
    if (!graph.inBounds(coord)) return true;
    if (opaqueCells) return opaqueCells.has(graph.toId(coord));
    return !graph.isWalkable(coord);
  };

  while (r !== to.row || c !== to.col) {
    const e2 = 2 * err;
    const prevR = r;
    const prevC = c;
    let movedR = false;
    let movedC = false;

    if (e2 > -dr) {
      err -= dr;
      c += stepC;
      movedC = true;
    }
    if (e2 < dc) {
      err += dc;
      r += stepR;
      movedR = true;
    }

    if (r === to.row && c === to.col) {
      // Prevent peeking diagonally through two touching corner walls.
      if (movedR && movedC && isOpaque(prevR, c) && isOpaque(r, prevC)) {
        return false;
      }
      return true;
    }

    if (isOpaque(r, c)) return false;
    if (movedR && movedC && isOpaque(prevR, c) && isOpaque(r, prevC)) {
      return false;
    }
  }

  return true;
}

/**
 * Computes attenuated sound intensity at listenerPos; returns 0 when out of hearing radius.
 */
export function computePerceivedSoundIntensity(
  listenerPos: GridCoord,
  event: SoundEvent
): number {
  if (event.radius <= 0 || event.intensity <= 0) return 0;
  const dist = gridDistance(listenerPos, event.position);
  if (dist > event.radius) return 0;
  const attenuation = 1 - (dist / event.radius) * 0.85;
  return event.intensity * attenuation;
}

/**
 * Filters sound events within hearing radius and attenuation threshold.
 * Results are ordered by perceived intensity descending, then recency and proximity.
 */
export function filterAudibleSounds(
  listenerPos: GridCoord,
  events: SoundEvent[],
  minAudibleIntensity = 0.08
): SoundEvent[] {
  const scored: Array<{ event: SoundEvent; perceived: number; distance: number }> = [];

  for (const event of events) {
    const perceived = computePerceivedSoundIntensity(listenerPos, event);
    if (perceived >= minAudibleIntensity) {
      scored.push({
        event,
        perceived,
        distance: gridDistance(listenerPos, event.position),
      });
    }
  }

  scored.sort(
    (a, b) =>
      b.perceived - a.perceived ||
      b.event.timestamp - a.event.timestamp ||
      a.distance - b.distance ||
      a.event.id.localeCompare(b.event.id)
  );

  return scored.map((entry) => entry.event);
}

/**
 * Builds a concise human-readable local perception bundle for an agent.
 * Anti-omniscience: callers only supply a visualTarget after passing hasLineOfSight.
 */
export function buildLocalPerception(
  listenerPos: GridCoord,
  visualTarget: GridCoord | null,
  events: SoundEvent[],
  receivedAlert: ReceivedAlertSignal | null = null,
  minAudibleIntensity = 0.08
): LocalPerception {
  const audibleSounds = filterAudibleSounds(listenerPos, events, minAudibleIntensity);
  const strongestSound = audibleSounds.length > 0 ? audibleSounds[0] : null;

  const parts: string[] = [];
  if (visualTarget) {
    parts.push(`LOS target (${visualTarget.row},${visualTarget.col})`);
  }
  if (strongestSound) {
    parts.push(
      `sound "${strongestSound.sourceId}" at (${strongestSound.position.row},${strongestSound.position.col})`
    );
  }
  if (receivedAlert) {
    parts.push(
      `alert depth ${receivedAlert.depth} -> (${receivedAlert.position.row},${receivedAlert.position.col})`
    );
  }

  return {
    visualTarget: visualTarget ? { ...visualTarget } : null,
    audibleSounds,
    strongestSound,
    receivedAlert,
    summary: parts.length > 0 ? parts.join(' | ') : 'no local stimuli',
  };
}
