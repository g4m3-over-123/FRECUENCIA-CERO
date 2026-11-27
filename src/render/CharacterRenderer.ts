import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { AgentSnapshot, MaraSnapshot } from '../core/contracts.ts';

/**
 * Renders Mara and duplicated animated zombie agents.
 * All duplicated animated models must use SkeletonUtils.clone and a dedicated AnimationMixer.
 */
export class CharacterRenderer {
  private readonly mixers = new Map<string, THREE.AnimationMixer>();

  cloneAnimatedCharacter(source: THREE.Object3D, id: string): THREE.Object3D {
    const cloned = SkeletonUtils.clone(source);
    const mixer = new THREE.AnimationMixer(cloned);
    this.mixers.set(id, mixer);
    return cloned;
  }

  sync(_mara: MaraSnapshot, _agents: AgentSnapshot[], deltaSeconds: number): void {
    // TODO: Sync transforms and clip states for Mara and zombie instances.
    for (const mixer of this.mixers.values()) {
      mixer.update(deltaSeconds);
    }
  }
}
