import * as THREE from 'three';
import type { WeaponId } from '../../core/gameplay/weapons.ts';

const MAX_TRACERS = 24;
const MAX_DROPLETS = 160;
const MAX_MIST = 32;
const MAX_GROUND_SPLATS = 48;
const MAX_SPARKS = 64;
const DEFAULT_TRACER_DISTANCE = 45;
const GRAVITY_BLOOD = -11.5;
const GRAVITY_SPARK = -10;
const SPLAT_LIFT = .015;

export interface ShotEffectParams {
  weaponId: WeaponId;
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  hitPoint: THREE.Vector3 | null;
  hitNormal: THREE.Vector3 | null;
  hitAgentId: string | null;
  worldTargets?: readonly THREE.Object3D[];
}

export interface CombatEffectCounts {
  tracers: number;
  droplets: number;
  mist: number;
  groundSplats: number;
  sparks: number;
}

interface TracerEntry {
  mesh: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  start: THREE.Vector3;
  end: THREE.Vector3;
  dir: THREE.Vector3;
  totalDist: number;
  streakLength: number;
  thickness: number;
  baseOpacity: number;
  age: number;
  duration: number;
  fresh: boolean;
}

interface DropletEntry {
  sprite: THREE.Sprite;
  velocity: THREE.Vector3;
  floorY: number;
  age: number;
  duration: number;
  settled: boolean;
}

interface MistEntry {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  velocity: THREE.Vector3;
  startScale: number;
  endScale: number;
  baseOpacity: number;
  age: number;
  duration: number;
}

interface SplatEntry {
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  targetScale: number;
  baseOpacity: number;
  age: number;
  growDuration: number;
  holdDuration: number;
  fadeDuration: number;
}

interface SparkEntry {
  sprite: THREE.Sprite;
  velocity: THREE.Vector3;
  startScale: number;
  age: number;
  duration: number;
}

export class CombatEffects {
  readonly root = new THREE.Group();

  private readonly bloodDropTexture = createBloodDropTexture();
  private readonly bloodMistTexture = createBloodMistTexture();
  private readonly bloodSplatTexture = createBloodSplatTexture();
  private readonly sparkTexture = createSparkTexture();

  private readonly tracerGeo: THREE.CylinderGeometry;
  private readonly splatGeo: THREE.PlaneGeometry;

  private readonly bloodBrightMat: THREE.SpriteMaterial;
  private readonly bloodDarkMat: THREE.SpriteMaterial;
  private readonly sparkMat: THREE.SpriteMaterial;

  private readonly groundRaycaster = new THREE.Raycaster();
  private readonly downDir = new THREE.Vector3(0, -1, 0);
  private readonly tmpVec = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpOrthoA = new THREE.Vector3();
  private readonly tmpOrthoB = new THREE.Vector3();

  private readonly tracers: TracerEntry[] = [];
  private readonly droplets: DropletEntry[] = [];
  private readonly mist: MistEntry[] = [];
  private readonly groundSplats: SplatEntry[] = [];
  private readonly sparks: SparkEntry[] = [];
  private disposed = false;

  constructor(scene: THREE.Scene) {
    this.root.name = 'combat-effects';
    scene.add(this.root);

    this.tracerGeo = new THREE.CylinderGeometry(.004, .01, 1, 5, 1, true);
    this.tracerGeo.rotateX(Math.PI / 2);

    this.splatGeo = new THREE.PlaneGeometry(1, 1);
    this.splatGeo.rotateX(-Math.PI / 2);

    this.bloodBrightMat = new THREE.SpriteMaterial({
      color: 0xc21822,
      map: this.bloodDropTexture,
      transparent: true,
      opacity: .95,
      depthWrite: false,
      fog: true,
    });
    this.bloodDarkMat = new THREE.SpriteMaterial({
      color: 0x730a10,
      map: this.bloodDropTexture,
      transparent: true,
      opacity: .95,
      depthWrite: false,
      fog: true,
    });
    this.sparkMat = new THREE.SpriteMaterial({
      color: 0xffc26e,
      map: this.sparkTexture,
      transparent: true,
      opacity: .95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });

    this.groundRaycaster.far = 6;
  }

  spawnShot(params: ShotEffectParams): void {
    if (this.disposed) return;

    const dir = this.tmpDir.copy(params.direction);
    if (dir.lengthSq() < 1e-8) dir.set(0, 0, -1);
    else dir.normalize();

    const baseEnd = params.hitPoint
      ? params.hitPoint.clone()
      : params.origin.clone().addScaledVector(dir, DEFAULT_TRACER_DISTANCE);

    const profile = tracerProfileFor(params.weaponId);
    const totalBaseDist = params.origin.distanceTo(baseEnd);
    const pelletReach = Math.min(DEFAULT_TRACER_DISTANCE, Math.max(4, totalBaseDist));

    buildBasis(dir, this.tmpOrthoA, this.tmpOrthoB);

    for (let i = 0; i < profile.pellets; i++) {
      let end: THREE.Vector3;
      if (i === 0) {
        end = baseEnd.clone();
      } else {
        const angle = ((i - 1) / Math.max(1, profile.pellets - 1)) * Math.PI * 2 + (Math.random() - .5) * .6;
        const spread = profile.spreadRad * (.45 + Math.random() * .65);
        const pelletDir = dir
          .clone()
          .addScaledVector(this.tmpOrthoA, Math.cos(angle) * spread)
          .addScaledVector(this.tmpOrthoB, Math.sin(angle) * spread)
          .normalize();
        end = params.origin.clone().addScaledVector(pelletDir, pelletReach);
      }
      this.spawnTracer(params.origin, end, profile.color, profile.opacity, profile.thickness);
    }

    if (!params.hitPoint) return;

    const normal = params.hitNormal ? params.hitNormal.clone().normalize() : dir.clone().negate();
    if (params.hitAgentId) {
      this.spawnBloodVfx(params.weaponId, params.hitPoint, dir, normal, params.worldTargets);
    } else {
      this.spawnSurfaceImpact(params.hitPoint, normal);
    }
  }

  update(dt: number): void {
    if (this.disposed || dt <= 0) return;
    const step = Math.min(dt, .1);

    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const entry = this.tracers[i];
      if (entry.fresh) {
        entry.fresh = false;
        continue;
      }
      entry.age += step;
      if (entry.age >= entry.duration) {
        entry.mesh.removeFromParent();
        entry.mesh.material.dispose();
        this.tracers.splice(i, 1);
        continue;
      }
      const p = entry.age / entry.duration;
      const head = Math.min(entry.totalDist, p * (entry.totalDist + entry.streakLength));
      const tail = Math.max(0, head - entry.streakLength);
      const segLen = Math.max(.05, head - tail);
      const mid = (head + tail) * .5;
      entry.mesh.position.copy(entry.start).addScaledVector(entry.dir, mid);
      entry.mesh.scale.set(entry.thickness, entry.thickness, segLen);
      entry.mesh.lookAt(entry.end);
      entry.mesh.material.opacity = entry.baseOpacity * (1 - p * p);
    }

    for (let i = this.droplets.length - 1; i >= 0; i--) {
      const entry = this.droplets[i];
      entry.age += step;
      if (entry.age >= entry.duration) {
        entry.sprite.removeFromParent();
        this.droplets.splice(i, 1);
        continue;
      }
      if (!entry.settled) {
        entry.velocity.y += GRAVITY_BLOOD * step;
        entry.velocity.multiplyScalar(Math.max(0, 1 - 1.8 * step));
        entry.sprite.position.addScaledVector(entry.velocity, step);
        if (entry.sprite.position.y <= entry.floorY + .02) {
          entry.sprite.position.y = entry.floorY + .02;
          entry.velocity.set(0, 0, 0);
          entry.settled = true;
        }
      }
    }

    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const entry = this.sparks[i];
      entry.age += step;
      if (entry.age >= entry.duration) {
        entry.sprite.removeFromParent();
        this.sparks.splice(i, 1);
        continue;
      }
      const p = entry.age / entry.duration;
      entry.velocity.y += GRAVITY_SPARK * step;
      entry.sprite.position.addScaledVector(entry.velocity, step);
      const s = entry.startScale * Math.max(.1, 1 - p);
      entry.sprite.scale.set(s, s, 1);
    }

    for (let i = this.mist.length - 1; i >= 0; i--) {
      const entry = this.mist[i];
      entry.age += step;
      if (entry.age >= entry.duration) {
        entry.sprite.removeFromParent();
        entry.material.dispose();
        this.mist.splice(i, 1);
        continue;
      }
      const p = entry.age / entry.duration;
      entry.velocity.multiplyScalar(Math.max(0, 1 - 3.2 * step));
      entry.sprite.position.addScaledVector(entry.velocity, step);
      const s = THREE.MathUtils.lerp(entry.startScale, entry.endScale, 1 - (1 - p) * (1 - p));
      entry.sprite.scale.set(s, s, 1);
      entry.material.opacity = entry.baseOpacity * (1 - p) * (1 - p);
    }

    for (let i = this.groundSplats.length - 1; i >= 0; i--) {
      const entry = this.groundSplats[i];
      entry.age += step;
      const total = entry.holdDuration + entry.fadeDuration;
      if (entry.age >= total) {
        entry.mesh.removeFromParent();
        entry.mesh.material.dispose();
        this.groundSplats.splice(i, 1);
        continue;
      }
      const growT = Math.min(1, entry.age / Math.max(.001, entry.growDuration));
      const scale = entry.targetScale * (.55 + .45 * (1 - (1 - growT) * (1 - growT)));
      entry.mesh.scale.setScalar(scale);
      if (entry.age > entry.holdDuration) {
        const fadeT = (entry.age - entry.holdDuration) / Math.max(.001, entry.fadeDuration);
        entry.mesh.material.opacity = entry.baseOpacity * (1 - fadeT);
      }
    }
  }

  getActiveCounts(): CombatEffectCounts {
    return {
      tracers: this.tracers.length,
      droplets: this.droplets.length,
      mist: this.mist.length,
      groundSplats: this.groundSplats.length,
      sparks: this.sparks.length,
    };
  }

  clear(): void {
    for (const entry of this.tracers) {
      entry.mesh.removeFromParent();
      entry.mesh.material.dispose();
    }
    this.tracers.length = 0;

    for (const entry of this.droplets) entry.sprite.removeFromParent();
    this.droplets.length = 0;

    for (const entry of this.sparks) entry.sprite.removeFromParent();
    this.sparks.length = 0;

    for (const entry of this.mist) {
      entry.sprite.removeFromParent();
      entry.material.dispose();
    }
    this.mist.length = 0;

    for (const entry of this.groundSplats) {
      entry.mesh.removeFromParent();
      entry.mesh.material.dispose();
    }
    this.groundSplats.length = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.root.removeFromParent();
    this.tracerGeo.dispose();
    this.splatGeo.dispose();
    this.bloodBrightMat.dispose();
    this.bloodDarkMat.dispose();
    this.sparkMat.dispose();
    this.bloodDropTexture.dispose();
    this.bloodMistTexture.dispose();
    this.bloodSplatTexture.dispose();
    this.sparkTexture.dispose();
  }

  private spawnTracer(
    origin: THREE.Vector3,
    end: THREE.Vector3,
    color: number,
    baseOpacity: number,
    thickness: number,
  ): void {
    const start = origin.clone();
    const totalDist = start.distanceTo(end);
    if (totalDist < .05) return;

    while (this.tracers.length >= MAX_TRACERS) {
      const oldest = this.tracers.shift()!;
      oldest.mesh.removeFromParent();
      oldest.mesh.material.dispose();
    }

    const dir = end.clone().sub(start).divideScalar(totalDist);
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: baseOpacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      toneMapped: true,
    });
    const mesh = new THREE.Mesh(this.tracerGeo, material);
    mesh.name = 'shot-tracer';
    mesh.frustumCulled = false;

    const streakLength = Math.min(4.5, Math.max(.6, totalDist * .45));
    const initialLen = Math.min(totalDist, streakLength * .35);
    mesh.position.copy(start).addScaledVector(dir, initialLen * .5);
    mesh.scale.set(thickness, thickness, Math.max(.05, initialLen));
    mesh.lookAt(end);
    this.root.add(mesh);

    this.tracers.push({
      mesh,
      start,
      end,
      dir,
      totalDist,
      streakLength,
      thickness,
      baseOpacity,
      age: 0,
      duration: Math.min(.095, Math.max(.065, totalDist / 160)),
      fresh: true,
    });
  }

  private spawnBloodVfx(
    weaponId: WeaponId,
    hitPoint: THREE.Vector3,
    shotDir: THREE.Vector3,
    hitNormal: THREE.Vector3,
    worldTargets?: readonly THREE.Object3D[],
  ): void {
    const heavy = weaponId === 'pistol' || weaponId === 'sawnoff' || weaponId === 'dual_sawnoffs';
    const hitGroundY = this.resolveGroundYAt(hitPoint.x, hitPoint.z, hitPoint.y, worldTargets);

    const dropletCount = heavy ? 26 : 16;
    for (let i = 0; i < dropletCount; i++) {
      if (this.droplets.length >= MAX_DROPLETS) {
        const oldest = this.droplets.shift()!;
        oldest.sprite.removeFromParent();
      }
      const entrySplash = i < Math.ceil(dropletCount * .35);
      const baseAxis = entrySplash ? hitNormal : shotDir;
      const velocity = randomConeVector(baseAxis, entrySplash ? .85 : .55)
        .multiplyScalar(2.2 + Math.random() * 5.3);
      velocity.y += .7 + Math.random() * 2.2;

      const sprite = new THREE.Sprite(i % 3 === 0 ? this.bloodDarkMat : this.bloodBrightMat);
      sprite.name = 'blood-droplet';
      sprite.position.copy(hitPoint);
      const scale = .035 + Math.random() * .05;
      sprite.scale.set(scale, scale, 1);
      this.root.add(sprite);

      this.droplets.push({
        sprite,
        velocity,
        floorY: hitGroundY,
        age: 0,
        duration: .35 + Math.random() * .37,
        settled: false,
      });
    }

    const mistCount = heavy ? 5 : 3;
    for (let i = 0; i < mistCount; i++) {
      if (this.mist.length >= MAX_MIST) {
        const oldest = this.mist.shift()!;
        oldest.sprite.removeFromParent();
        oldest.material.dispose();
      }
      const material = new THREE.SpriteMaterial({
        color: 0x850c14,
        map: this.bloodMistTexture,
        transparent: true,
        opacity: .68,
        depthWrite: false,
        fog: true,
      });
      const sprite = new THREE.Sprite(material);
      sprite.name = 'blood-mist';
      sprite.position.copy(hitPoint).add(new THREE.Vector3(
        (Math.random() - .5) * .12,
        (Math.random() - .5) * .12,
        (Math.random() - .5) * .12,
      ));
      const startScale = .18 + Math.random() * .08;
      const endScale = .58 + Math.random() * .34;
      sprite.scale.set(startScale, startScale, 1);
      this.root.add(sprite);

      const velocity = randomConeVector(shotDir, .75).multiplyScalar(.8 + Math.random() * 1.4);
      velocity.y += .25;

      this.mist.push({
        sprite,
        material,
        velocity,
        startScale,
        endScale,
        baseOpacity: .68,
        age: 0,
        duration: .28 + Math.random() * .16,
      });
    }

    const splatCount = heavy ? 2 : 1;
    const flatShotX = shotDir.x;
    const flatShotZ = shotDir.z;
    const flatLen = Math.hypot(flatShotX, flatShotZ);
    const stepX = flatLen > 1e-4 ? flatShotX / flatLen : 0;
    const stepZ = flatLen > 1e-4 ? flatShotZ / flatLen : 0;

    for (let i = 0; i < splatCount; i++) {
      if (this.groundSplats.length >= MAX_GROUND_SPLATS) {
        const oldest = this.groundSplats.shift()!;
        oldest.mesh.removeFromParent();
        oldest.mesh.material.dispose();
      }
      const distBack = .15 + Math.random() * .6;
      const sideJitter = (Math.random() - .5) * .35;
      const splatX = hitPoint.x + stepX * distBack - stepZ * sideJitter;
      const splatZ = hitPoint.z + stepZ * distBack + stepX * sideJitter;
      const targetScale = .4 + Math.random() * .55;
      const splatGroundY = this.resolveSplatGroundY(splatX, splatZ, hitPoint.y, targetScale, worldTargets);

      const material = new THREE.MeshBasicMaterial({
        color: 0x7a0910,
        map: this.bloodSplatTexture,
        transparent: true,
        opacity: .9,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
        fog: true,
      });
      const mesh = new THREE.Mesh(this.splatGeo, material);
      mesh.name = 'blood-ground-splat';
      mesh.position.set(splatX, splatGroundY + SPLAT_LIFT, splatZ);
      mesh.rotation.y = Math.random() * Math.PI * 2;
      mesh.scale.setScalar(targetScale * .55);
      this.root.add(mesh);

      this.groundSplats.push({
        mesh,
        targetScale,
        baseOpacity: .9,
        age: 0,
        growDuration: .16,
        holdDuration: 20,
        fadeDuration: 4,
      });
    }
  }

  private spawnSurfaceImpact(hitPoint: THREE.Vector3, hitNormal: THREE.Vector3): void {
    for (let i = 0; i < 8; i++) {
      if (this.sparks.length >= MAX_SPARKS) {
        const oldest = this.sparks.shift()!;
        oldest.sprite.removeFromParent();
      }
      const sprite = new THREE.Sprite(this.sparkMat);
      sprite.name = 'impact-spark';
      sprite.position.copy(hitPoint).addScaledVector(hitNormal, .02);
      const startScale = .05 + Math.random() * .045;
      sprite.scale.set(startScale, startScale, 1);
      this.root.add(sprite);

      const velocity = randomConeVector(hitNormal, .9).multiplyScalar(2.4 + Math.random() * 4.2);
      velocity.y += .6 + Math.random() * 1.4;

      this.sparks.push({
        sprite,
        velocity,
        startScale,
        age: 0,
        duration: .14 + Math.random() * .14,
      });
    }

    for (let i = 0; i < 2; i++) {
      if (this.mist.length >= MAX_MIST) {
        const oldest = this.mist.shift()!;
        oldest.sprite.removeFromParent();
        oldest.material.dispose();
      }
      const material = new THREE.SpriteMaterial({
        color: 0x8e96a3,
        map: this.bloodMistTexture,
        transparent: true,
        opacity: .4,
        depthWrite: false,
        fog: true,
      });
      const sprite = new THREE.Sprite(material);
      sprite.name = 'impact-dust';
      sprite.position.copy(hitPoint).addScaledVector(hitNormal, .04);
      const startScale = .12;
      const endScale = .34 + Math.random() * .12;
      sprite.scale.set(startScale, startScale, 1);
      this.root.add(sprite);

      const velocity = randomConeVector(hitNormal, .7).multiplyScalar(.6 + Math.random() * .7);
      this.mist.push({
        sprite,
        material,
        velocity,
        startScale,
        endScale,
        baseOpacity: .4,
        age: 0,
        duration: .26,
      });
    }
  }

  private resolveSplatGroundY(
    x: number,
    z: number,
    maxHitY: number,
    splatScale: number,
    worldTargets?: readonly THREE.Object3D[],
  ): number {
    const centerY = this.resolveGroundYAt(x, z, maxHitY, worldTargets);
    if (!worldTargets || worldTargets.length === 0) return centerY;
    const edge = splatScale * .4;
    let floorY = centerY;
    for (const [dx, dz] of [[edge, 0], [-edge, 0], [0, edge], [0, -edge]] as const) {
      const sampleY = this.resolveGroundYAt(x + dx, z + dz, maxHitY, worldTargets);
      if (sampleY < floorY && centerY - sampleY <= 1) floorY = sampleY;
    }
    return floorY;
  }

  private resolveGroundYAt(
    x: number,
    z: number,
    maxHitY: number,
    worldTargets?: readonly THREE.Object3D[],
  ): number {
    if (!worldTargets || worldTargets.length === 0) return 0;
    const probeY = Math.max(.8, Math.min(maxHitY + .25, 1.4));
    this.tmpVec.set(x, probeY, z);
    this.groundRaycaster.set(this.tmpVec, this.downDir);
    const hits = this.groundRaycaster.intersectObjects([...worldTargets], true);
    for (const hit of hits) {
      if (hit.point.y <= maxHitY + .05) return hit.point.y;
    }
    return 0;
  }
}

function tracerProfileFor(weaponId: WeaponId): {
  pellets: number;
  spreadRad: number;
  color: number;
  opacity: number;
  thickness: number;
} {
  if (weaponId === 'pistol' || weaponId === 'sawnoff' || weaponId === 'dual_sawnoffs') {
    return {
      pellets: 6,
      spreadRad: weaponId === 'pistol' ? .032 : .048,
      color: 0xffe3a8,
      opacity: .85,
      thickness: 1.15,
    };
  }
  if (weaponId === 'dual_mac10') {
    return {
      pellets: 1,
      spreadRad: 0,
      color: 0xd8ccb8,
      opacity: .55,
      thickness: .85,
    };
  }
  return {
    pellets: 1,
    spreadRad: 0,
    color: 0xffe4ad,
    opacity: .9,
    thickness: 1.0,
  };
}

function buildBasis(forward: THREE.Vector3, orthoA: THREE.Vector3, orthoB: THREE.Vector3): void {
  const up = Math.abs(forward.y) > .9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  orthoA.crossVectors(forward, up).normalize();
  orthoB.crossVectors(orthoA, forward).normalize();
}

function randomConeVector(axis: THREE.Vector3, spread: number): THREE.Vector3 {
  const orthoA = new THREE.Vector3();
  const orthoB = new THREE.Vector3();
  buildBasis(axis, orthoA, orthoB);
  const angle = Math.random() * Math.PI * 2;
  const radius = spread * Math.sqrt(Math.random());
  return axis
    .clone()
    .addScaledVector(orthoA, Math.cos(angle) * radius)
    .addScaledVector(orthoB, Math.sin(angle) * radius)
    .normalize();
}

function createBloodDropTexture(size = 32): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const ny = (y / (size - 1)) * 2 - 1;
    for (let x = 0; x < size; x++) {
      const nx = (x / (size - 1)) * 2 - 1;
      const angle = Math.atan2(ny, nx);
      const lobe = 1 + .16 * Math.sin(3 * angle + .5) + .1 * Math.cos(5 * angle);
      const r = Math.hypot(nx * .95, ny * 1.08) / lobe;
      const edge = clamp01((.9 - r) / .38);
      const alpha = r >= .92 ? 0 : edge * edge * (3 - 2 * edge);
      const idx = (y * size + x) * 4;
      data[idx] = 255;
      data[idx + 1] = 255;
      data[idx + 2] = 255;
      data[idx + 3] = Math.round(255 * alpha);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function createBloodMistTexture(size = 32): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const ny = (y / (size - 1)) * 2 - 1;
    for (let x = 0; x < size; x++) {
      const nx = (x / (size - 1)) * 2 - 1;
      const angle = Math.atan2(ny, nx);
      const puff = 1 + .12 * Math.cos(4 * angle - .7) + .08 * Math.sin(7 * angle);
      const r = Math.hypot(nx, ny) / puff;
      const soft = clamp01((.96 - r) / .9);
      const alpha = r >= .96 ? 0 : Math.pow(soft, 1.8);
      const idx = (y * size + x) * 4;
      data[idx] = 255;
      data[idx + 1] = 255;
      data[idx + 2] = 255;
      data[idx + 3] = Math.round(255 * alpha);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function createBloodSplatTexture(size = 64): THREE.DataTexture {
  const blobs = [
    { x: 0, y: 0, rx: .38, ry: .34, a: .2 },
    { x: .24, y: .12, rx: .22, ry: .16, a: .5 },
    { x: -.26, y: -.14, rx: .25, ry: .15, a: -.4 },
    { x: -.12, y: .29, rx: .2, ry: .14, a: 1.1 },
    { x: .16, y: -.28, rx: .18, ry: .13, a: .9 },
    { x: .46, y: .22, rx: .12, ry: .09, a: .4 },
    { x: -.48, y: .06, rx: .11, ry: .08, a: -.2 },
    { x: .06, y: .5, rx: .1, ry: .08, a: 1.4 },
    { x: -.32, y: .42, rx: .09, ry: .07, a: .8 },
    { x: .38, y: -.38, rx: .08, ry: .07, a: -.7 },
  ];
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const ny = (y / (size - 1)) * 2 - 1;
    for (let x = 0; x < size; x++) {
      const nx = (x / (size - 1)) * 2 - 1;
      const radialMask = clamp01((.96 - Math.hypot(nx, ny)) / .14);
      let cov = 0;
      for (const b of blobs) {
        const dx = nx - b.x;
        const dy = ny - b.y;
        const cosA = Math.cos(b.a);
        const sinA = Math.sin(b.a);
        const lx = (dx * cosA + dy * sinA) / b.rx;
        const ly = (-dx * sinA + dy * cosA) / b.ry;
        const d = Math.hypot(lx, ly);
        cov = Math.max(cov, clamp01((1 - d) / .24));
      }
      const alpha = cov * radialMask;
      const idx = (y * size + x) * 4;
      data[idx] = 255;
      data[idx + 1] = 255;
      data[idx + 2] = 255;
      data[idx + 3] = Math.round(255 * alpha);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function createSparkTexture(size = 32): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const ny = (y / (size - 1)) * 2 - 1;
    for (let x = 0; x < size; x++) {
      const nx = (x / (size - 1)) * 2 - 1;
      const r = Math.hypot(nx, ny);
      const alpha = r >= .95 ? 0 : Math.exp(-r * r * 7.5) * clamp01((.95 - r) / .25);
      const idx = (y * size + x) * 4;
      data[idx] = 255;
      data[idx + 1] = 255;
      data[idx + 2] = 255;
      data[idx + 3] = Math.round(255 * alpha);
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
