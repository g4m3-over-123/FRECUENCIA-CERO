import type * as THREE from 'three';
import type { FrameState } from './GameLoop.ts';

/**
 * Interfaces between main.ts and each render front. Implementations can be replaced freely
 * (capsules -> animated models, box gun -> real weapon) as long as they keep these shapes.
 */

/** Front B: draws agents. Phase 0 implementation: AgentCapsules. */
export interface AgentView {
  sync(frame: FrameState): void;
  /** Objects the weapon raycast can hit. Each must carry userData.agentId (on itself or a parent). */
  getHitTargets(): THREE.Object3D[];
  dispose(): void;
}

/** Front D: X-ray overlay (paths, expanded nodes, sounds, alerts). */
export interface DebugView {
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  sync(frame: FrameState): void;
}
