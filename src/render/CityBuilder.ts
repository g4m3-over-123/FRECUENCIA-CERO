
import * as THREE from 'three';

const ROAD_MESH = /^Plane\.?002(?:_|$)/i;
const BUILDING_MESH = /^(?:Cube|node_0)/i;
const size = 256;

function hash(x: number, y: number): number {
  let state = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  state = Math.imul(state ^ (state >>> 13), 1274126177);
  return ((state ^ (state >>> 16)) >>> 0) / 4294967296;
}

function noise(u: number, v: number, period: number): number {
  const x = Math.floor(u * period);
  const y = Math.floor(v * period);
  const fx = THREE.MathUtils.smoothstep(u * period - x, 0, 1);
  const fy = THREE.MathUtils.smoothstep(v * period - y, 0, 1);
  const wrap = (value: number) => THREE.MathUtils.euclideanModulo(value, period);
  const a = THREE.MathUtils.lerp(hash(wrap(x), wrap(y)), hash(wrap(x + 1), wrap(y)), fx);
  const b = THREE.MathUtils.lerp(hash(wrap(x), wrap(y + 1)), hash(wrap(x + 1), wrap(y + 1)), fx);
  return THREE.MathUtils.lerp(a, b, fy);
}

function crack(u: number, v: number): number {
  const frequency = 7;
  const x = u * frequency + (noise(u, v, 14) - 0.5) * 0.27;
  const y = v * frequency + (noise(v, u, 14) - 0.5) * 0.27;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let nearest = Infinity;
  let second = Infinity;
  for (let row = iy - 1; row <= iy + 1; row++) {
    for (let col = ix - 1; col <= ix + 1; col++) {
      const gridX = THREE.MathUtils.euclideanModulo(col, frequency);
      const gridY = THREE.MathUtils.euclideanModulo(row, frequency);
      const dx = col + 0.19 + hash(gridX, gridY) * 0.62 - x;
      const dy = row + 0.19 + hash(gridY + 19, gridX) * 0.62 - y;
      const d = dx * dx + dy * dy;
      if (d < nearest) {
        second = nearest;
        nearest = d;
      } else if (d < second) {
        second = d;
      }
    }
  }

  const edge = Math.sqrt(second) - Math.sqrt(nearest);
  return (1 - THREE.MathUtils.smoothstep(edge, 0.012, 0.043))
    * THREE.MathUtils.smoothstep(noise(u, v, 9), 0.25, 0.52);
}

function surfaceMaps(anisotropy: number) {
  const color = new Uint8Array(size * size * 4);
  const asphalt = new Uint8Array(color.length);
  const concrete = new Uint8Array(color.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const u = x / size;
      const v = y / size;
      const grain = hash(x, y);
      const fractured = crack(u, v);
      const tone = 35 + 17 * noise(u, v, 21) + 27 * grain - 34 * fractured;
      color.set([tone * 0.94, tone, tone * 1.06, 255], i);
      asphalt.set([110 + 115 * grain - 95 * fractured, 0, 0, 255], i);
      concrete.set([100 + 95 * hash(y + 8, x) + 45 * noise(u, v, 46), 0, 0, 255], i);
    }
  }

  const texture = (data: typeof color) => {
    const map = new THREE.DataTexture(data, size, size);
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.magFilter = THREE.LinearFilter;
    map.minFilter = THREE.LinearMipmapLinearFilter;
    map.generateMipmaps = true;
    map.anisotropy = anisotropy;
    map.needsUpdate = true;
    return map;
  };
  const albedo = texture(color);
  albedo.colorSpace = THREE.SRGBColorSpace;
  return { albedo, asphalt: texture(asphalt), concrete: texture(concrete) };
}

export class CityBuilder {
  private readonly effects = new THREE.Group();
  private readonly cone = new THREE.CylinderGeometry(0.035, 1, 1, 20, 1, true);
  private readonly emitter = new THREE.SphereGeometry(1, 10, 6);
  private readonly coneFade: THREE.DataTexture;
  private readonly maps: ReturnType<typeof surfaceMaps>;
  private beaconTime = 0;
  private readonly materials = new Set<THREE.Material>();
  private readonly originalSurfaces = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private beacon: {
    light: THREE.PointLight;
    beam: THREE.MeshBasicMaterial;
    bulb: THREE.MeshBasicMaterial;
  } | undefined;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    this.maps = surfaceMaps(Math.min(8, renderer.capabilities.getMaxAnisotropy()));
    this.effects.name = 'night-city-effects';
    scene.add(this.effects);

    const fade = new Uint8Array(64 * 4);
    for (let i = 0; i < 64; i++) {
      const height = i / 63;
      const alpha = Math.sin(Math.PI * height) ** 1.2 * (0.43 + 0.57 * height);
      fade.set([255, Math.round(alpha * 255), 255, 255], i * 4);
    }
    this.coneFade = new THREE.DataTexture(fade, 1, 64);
    this.coneFade.magFilter = this.coneFade.minFilter = THREE.LinearFilter;
    this.coneFade.needsUpdate = true;
  }

  makeBeam(source: THREE.Vector3, end: THREE.Vector3, radius: number, color: THREE.ColorRepresentation,
    opacity = 0.08): THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial> {
    const material = new THREE.MeshBasicMaterial({
      color, alphaMap: this.coneFade, transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      forceSinglePass: true,
    });
    material.customProgramCacheKey = () => 'night-light-volume';
    material.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vBeamNormal;\nvarying vec3 vBeamView;')
        .replace('#include <project_vertex>', `
          #include <project_vertex>
          vBeamNormal = normalMatrix * normal;
          vBeamView = -mvPosition.xyz;
        `);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vBeamNormal;\nvarying vec3 vBeamView;')
        .replace('#include <alphamap_fragment>', `
          #include <alphamap_fragment>
          float facing = abs(dot(normalize(vBeamNormal), normalize(vBeamView)));
          diffuseColor.a *= smoothstep(0.0, 0.4, facing);
        `);
    };
    const direction = new THREE.Vector3().subVectors(source, end);
    const mesh = new THREE.Mesh(this.cone, material);
    mesh.position.addVectors(source, end).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize());
    mesh.scale.set(radius, direction.length(), radius);
    return mesh;
  }

  apply(world: THREE.Object3D): void {
    this.clear();
    world.updateWorldMatrix(true, true);
    const concrete = new Map<THREE.Material, THREE.Material>();
    const lights: THREE.PointLight[] = [];
    const roads: THREE.Mesh[] = [];
    let fallbackFloor: THREE.Mesh | undefined;

    world.traverse(object => {
      if (object instanceof THREE.PointLight) lights.push(object);
      if (!(object instanceof THREE.Mesh) || object.parent?.name === 'grid-overlay') return;
      object.castShadow = true;
      object.receiveShadow = true;
      if (ROAD_MESH.test(object.name)) roads.push(object);
      if (object.parent === world && object.geometry.type === 'PlaneGeometry') fallbackFloor = object;
      if (BUILDING_MESH.test(object.name) || (object instanceof THREE.InstancedMesh && object.parent === world)) {
        this.setConcrete(object, concrete);
      }
    });

    if (!roads.length && fallbackFloor) roads.push(fallbackFloor);
    if (roads.length) this.setAsphalt(roads);
    this.addFixtures(world, lights);
  }

  update(dt: number): void {
    if (!this.beacon) return;
    this.beaconTime += dt;
    const { light, beam, bulb } = this.beacon;
    const pulse = (0.5 + 0.5 * Math.sin(this.beaconTime * 4)) ** 2;
    beam.color.copy(light.color);
    beam.opacity = 0.045 + pulse * 0.035;
    bulb.color.copy(light.color).multiplyScalar(3.3 + 3.5 * pulse);
  }

  clear(): void {
    for (const [mesh, material] of this.originalSurfaces) mesh.material = material;
    this.originalSurfaces.clear();
    this.effects.clear();
    for (const material of this.materials) material.dispose();
    this.materials.clear();
    this.beacon = undefined;
  }

  dispose(): void {
    this.clear();
    this.effects.removeFromParent();
    this.cone.dispose();
    this.emitter.dispose();
    this.coneFade.dispose();
    for (const texture of Object.values(this.maps)) texture.dispose();
  }

  private setAsphalt(roads: THREE.Mesh[]): void {
    const material = new THREE.MeshPhysicalMaterial({
      map: this.maps.albedo,
      bumpMap: this.maps.asphalt,
      bumpScale: 0.017,
      roughness: 0.93,
      metalness: 0,
      specularIntensity: 0.22,
      side: THREE.DoubleSide,
    });
    material.name = 'matte-asphalt';
    material.customProgramCacheKey = () => 'night-matte-asphalt';
    material.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
        #include <project_vertex>
        vec3 asphaltPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vMapUv = asphaltPosition.xz * 0.33;
        vBumpMapUv = vMapUv;
      `);
    };
    this.materials.add(material);
    for (const road of roads) {
      this.originalSurfaces.set(road, road.material);
      road.material = material;
    }
  }

  private setConcrete(mesh: THREE.Mesh, cache: Map<THREE.Material, THREE.Material>): void {
    const coat = (source: THREE.Material) => {
      if (!(source instanceof THREE.MeshStandardMaterial) || source.bumpMap || source.transparent) return source;
      const existing = cache.get(source);
      if (existing) return existing;
      const result = source.clone();
      result.bumpMap = this.maps.concrete;
      result.bumpScale = 0.010;
      result.customProgramCacheKey = () => 'night-concrete';
      result.onBeforeCompile = shader => {
        shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', `
          #include <project_vertex>
          vec4 concretePosition = vec4(transformed, 1.0);
          vec3 concreteNormal = objectNormal;
          #ifdef USE_INSTANCING
            concretePosition = instanceMatrix * concretePosition;
            concreteNormal = mat3(instanceMatrix) * concreteNormal;
          #endif
          vec3 surfacePoint = (modelMatrix * concretePosition).xyz;
          vec3 axis = abs(mat3(modelMatrix) * concreteNormal);
          vBumpMapUv = axis.y > max(axis.x, axis.z) ? surfacePoint.xz : vec2(
            axis.x > axis.z ? surfacePoint.z : surfacePoint.x, surfacePoint.y);
          vBumpMapUv *= 1.5;
        `);
        shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `
          #include <normal_fragment_maps>
          #if defined(USE_NORMALMAP_TANGENTSPACE) || defined(USE_NORMALMAP_OBJECTSPACE)
            normal = perturbNormalArb(-vViewPosition, normal, dHdxy_fwd(), faceDirection);
          #endif
        `);
      };
      cache.set(source, result);
      this.materials.add(result);
      return result;
    };

    this.originalSurfaces.set(mesh, mesh.material);
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(coat) : coat(mesh.material);
  }

  private addFixtures(world: THREE.Object3D, lights: THREE.PointLight[]): void {
    let amberBulbs = 0;
    for (const light of lights) {
      const source = light.getWorldPosition(new THREE.Vector3());
      const zone = light.name.startsWith('zone-light-');
      const end = new THREE.Vector3(source.x, 0.03, source.z);
      if (end.y >= source.y) continue;
      const beam = this.makeBeam(source, end, zone ? 1.6 : 2.15, light.color);
      this.effects.add(beam);
      this.materials.add(beam.material);

      if (!zone && amberBulbs >= 3) continue;
      if (!zone) amberBulbs++;
      const bulbMaterial = new THREE.MeshBasicMaterial({
        color: light.color.clone().multiplyScalar(zone ? 3.4 : 2.75),
      });
      const bulb = new THREE.Mesh(this.emitter, bulbMaterial);
      bulb.scale.setScalar(zone ? 0.095 : 0.075);

      if (light.name === 'zone-light-pharmacy') {
        light.parent?.localToWorld(bulb.position.set(0, 2.53, 0.169));
      } else if (light.name === 'zone-light-refuge') {
        light.parent?.localToWorld(bulb.position.set(0.31, 2.92, 0.069));
      } else if (light.name === 'zone-light-extraction') {
        world.getObjectByName('extraction-lens')?.getWorldPosition(bulb.position);
        bulb.scale.setScalar(0.188);
        this.beacon = { light, beam: beam.material, bulb: bulbMaterial };
      } else {
        bulb.position.copy(source);
      }

      this.effects.add(bulb);
      this.materials.add(bulbMaterial);
    }
  }
}
