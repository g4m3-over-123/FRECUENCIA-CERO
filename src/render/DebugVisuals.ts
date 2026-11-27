import * as THREE from 'three';
import type {
  AlertPropagationResult,
  SearchResult,
  SoundEvent,
} from '../core/contracts.ts';

/**
 * Renders algorithm overlays: expanded nodes, active paths, sound rings, and alert hops.
 */
export class DebugVisuals {
  updateSearchOverlay(_scene: THREE.Scene, _result: SearchResult | null): void {
    // TODO: Render expanded nodes and optimal path lines.
  }

  updateAlertOverlay(
    _scene: THREE.Scene,
    _alerts: AlertPropagationResult[],
    _sounds: SoundEvent[]
  ): void {
    // TODO: Render acoustic rings and recursive radio/horde hop arcs.
  }
}
