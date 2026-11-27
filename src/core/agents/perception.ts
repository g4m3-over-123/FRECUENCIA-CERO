import type { GridCoord, SoundEvent } from '../contracts.ts';
import type { WeightedGraph } from '../graph/WeightedGraph.ts';

/**
 * Evaluates local line-of-sight and audible sound events for an agent.
 */
export function hasLineOfSight(
  _graph: WeightedGraph,
  _from: GridCoord,
  _to: GridCoord,
  _visionRange: number
): boolean {
  // TODO: Implement grid raycast / Bresenham visibility check blocked by buildings.
  return false;
}

export function filterAudibleSounds(
  _listenerPos: GridCoord,
  _events: SoundEvent[]
): SoundEvent[] {
  // TODO: Filter sound events within hearing radius and attenuation threshold.
  return [];
}
