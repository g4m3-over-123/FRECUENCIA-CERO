import * as THREE from 'three';
import type { MapDefinition } from '../core/contracts.ts';

/**
 * Builds 3D city geometry (streets, buildings, barricades, landmarks) from MapDefinition.
 */
export class CityBuilder {
  build(_scene: THREE.Scene, _map: MapDefinition): void {
    // TODO: Instantiate procedural or GLTF city blocks from MapDefinition.
  }
}
