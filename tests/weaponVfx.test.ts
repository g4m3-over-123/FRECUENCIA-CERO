import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { WEAPON_ORDER, type WeaponId } from '../src/core/gameplay/weapons.ts';
import { CombatEffects } from '../src/render/weapons/CombatEffects.ts';
import { WeaponView } from '../src/render/weapons/WeaponView.ts';

function installGltfNodeStubs(): () => void {
  const g = globalThis as Record<string, unknown>;
  const prevCreateBitmap = g.createImageBitmap;
  const prevSelf = g.self;
  const prevImage = g.Image;
  const prevFetch = g.fetch;
  const PrevRequest = g.Request as typeof Request;
  const origCreateObjectURL = URL.createObjectURL;
  const origRevokeObjectURL = URL.revokeObjectURL;

  g.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
  if (!g.self) g.self = globalThis;
  g.Image = class {
    height = 1;
    width = 1;
    onload?: () => void;
    set src(_value: string) {
      queueMicrotask(() => {
        this.height = 1;
        this.width = 1;
        this.onload?.();
      });
    }
  };
  URL.createObjectURL = () => 'blob:mock';
  URL.revokeObjectURL = () => {};

  g.Request = class extends PrevRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      const normalized = typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input;
      super(normalized, init);
    }
  };

  g.fetch = async (input: unknown) => {
    const raw = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    if (raw.startsWith('blob:')) {
      const empty = new Uint8Array(8);
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        url: raw,
        headers: new Headers(),
        arrayBuffer: async () => empty.buffer,
        blob: async () => new Blob([empty]),
      } as unknown as Response;
    }
    const rel = raw.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+/, '');
    const filePath = resolve(process.cwd(), 'public', rel);
    const buf = await readFile(filePath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      url: raw,
      headers: new Headers(),
      arrayBuffer: async () => ab,
    } as unknown as Response;
  };

  return () => {
    if (prevCreateBitmap === undefined) delete g.createImageBitmap;
    else g.createImageBitmap = prevCreateBitmap;
    if (prevSelf === undefined) delete g.self;
    else g.self = prevSelf;
    if (prevImage === undefined) delete g.Image;
    else g.Image = prevImage;
    g.Request = PrevRequest;
    g.fetch = prevFetch;
    URL.createObjectURL = origCreateObjectURL;
    URL.revokeObjectURL = origRevokeObjectURL;
  };
}

function findObjectByName(root: THREE.Object3D, name: string): THREE.Object3D | null {
  return root.getObjectByName(name) ?? null;
}

function measureGunMinZInCamera(
  mount: THREE.Object3D,
  camera: THREE.Camera,
  meshFilter?: RegExp,
): number {
  camera.updateMatrixWorld(true);
  const invCam = camera.matrixWorldInverse;
  const vertex = new THREE.Vector3();
  let minZ = Infinity;

  mount.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (meshFilter && !meshFilter.test(object.name)) return;
    const matName = Array.isArray(object.material)
      ? object.material.map((m) => m.name).join(' ')
      : object.material?.name ?? '';
    if (/arm|hand|glove|shirt|comando|Object_67/i.test(object.name) || /arm|hand|glove|shirt/i.test(matName)) {
      return;
    }
    const pos = object.geometry.attributes.position;
    if (!pos) return;
    for (let i = 0; i < pos.count; i++) {
      vertex.fromBufferAttribute(pos, i);
      if (object instanceof THREE.SkinnedMesh) {
        object.applyBoneTransform(i, vertex);
      }
      vertex.applyMatrix4(object.matrixWorld).applyMatrix4(invCam);
      if (vertex.z < minZ) minZ = vertex.z;
    }
  });
  return minZ;
}

describe('WeaponView muzzle flash and barrel anchors', () => {
  let restoreStubs: (() => void) | null = null;

  afterEach(() => {
    restoreStubs?.();
    restoreStubs = null;
  });

  it('uses a forward SpotLight with zero PointLights and fades flash cleanly after firing', () => {
    restoreStubs = installGltfNodeStubs();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
    const view = new WeaponView(camera);

    const pointLights: THREE.PointLight[] = [];
    const spotLights: THREE.SpotLight[] = [];
    camera.traverse((obj) => {
      if (obj instanceof THREE.PointLight) pointLights.push(obj);
      if (obj instanceof THREE.SpotLight) spotLights.push(obj);
    });

    expect(pointLights).toHaveLength(0);
    expect(spotLights).toHaveLength(1);
    const spot = spotLights[0];
    const flashGroup = findObjectByName(camera, 'weapon-muzzle-flash')!;
    const muzzle = findObjectByName(camera, 'weapon-muzzle')!;
    expect(flashGroup).not.toBeNull();
    expect(muzzle).not.toBeNull();
    expect(flashGroup.visible).toBe(false);
    expect(spot.visible).toBe(true);
    expect(spot.intensity).toBe(0);

    view.fire();
    expect(flashGroup.visible).toBe(true);
    expect(spot.visible).toBe(true);
    expect(spot.intensity).toBeGreaterThan(0);
    expect(spot.position.z).toBeLessThan(muzzle.position.z - 0.1);

    view.update(0.2);
    expect(flashGroup.visible).toBe(false);
    expect(spot.visible).toBe(true);
    expect(spot.intensity).toBe(0);

    view.dispose();
    expect(camera.children).toHaveLength(0);
  });

  it('clamps M4 physical IOR, positions every weapon muzzle ahead of its barrel, and alternates dual barrels', async () => {
    restoreStubs = installGltfNodeStubs();
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
    camera.position.set(4, 1.58, -3);
    camera.rotation.y = 0.6;
    const view = new WeaponView(camera);

    const internal = view as unknown as {
      rigs: Map<WeaponId, { mount: THREE.Group; model: THREE.Object3D }>;
      loading: Map<WeaponId, Promise<void>>;
    };

    for (const weaponId of WEAPON_ORDER) {
      view.setWeapon(weaponId);
      const pending = internal.loading.get(weaponId);
      if (pending) await pending;

      const rig = internal.rigs.get(weaponId);
      expect(rig).toBeDefined();
      view.update(0.6);

      rig!.model.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        for (const mat of Array.isArray(obj.material) ? obj.material : [obj.material]) {
          if (mat instanceof THREE.MeshPhysicalMaterial) {
            expect(mat.ior).toBeLessThanOrEqual(2.5);
          }
        }
      });

      const cameraLocalMuzzle = () => {
        const worldPos = view.muzzlePosition(new THREE.Vector3());
        return camera.worldToLocal(worldPos);
      };

      const spotLight = findObjectByName(camera, 'weapon-flash-light') as THREE.SpotLight;
      const idleMuzzle = cameraLocalMuzzle();
      const idleMinZ = measureGunMinZInCamera(rig!.mount, camera);
      expect(idleMuzzle.z).toBeLessThan(idleMinZ);
      expect(spotLight.position.z).toBeLessThan(idleMinZ);

      view.fire();
      view.update(0.02);
      const fireMuzzle = cameraLocalMuzzle();
      const allFireMinZ = measureGunMinZInCamera(rig!.mount, camera);
      const fireBarrelFilter = weaponId === 'dual_sawnoffs' ? /^front_sawnoff_0$/ : undefined;
      const fireMinZ = measureGunMinZInCamera(rig!.mount, camera, fireBarrelFilter);
      expect(fireMuzzle.z).toBeLessThan(fireMinZ);
      expect(spotLight.position.z).toBeLessThan(allFireMinZ);

      if (weaponId === 'dual_mac10' || weaponId === 'dual_sawnoffs') {
        const firstX = fireMuzzle.x;
        view.fire();
        view.update(0.02);
        const secondMuzzle = cameraLocalMuzzle();
        const secondX = secondMuzzle.x;
        const allSecondMinZ = measureGunMinZInCamera(rig!.mount, camera);
        if (weaponId === 'dual_sawnoffs') {
          expect(secondMuzzle.z).toBeLessThan(
            measureGunMinZInCamera(rig!.mount, camera, /^front_2_sawnoff_0$/),
          );
        } else {
          expect(secondMuzzle.z).toBeLessThan(allSecondMinZ);
        }
        expect(spotLight.position.z).toBeLessThan(allSecondMinZ);
        expect(Math.sign(firstX)).not.toBe(Math.sign(secondX));
        expect(Math.abs(firstX)).toBeGreaterThan(0.05);
        expect(Math.abs(secondX)).toBeGreaterThan(0.05);
      }
    }

    view.dispose();
  });
});

describe('CombatEffects tracers, zombie blood VFX, and surface impacts', () => {
  it('spawns 1 tracer for M4 and 6 buckshot tracers for shotguns that expire cleanly', () => {
    const scene = new THREE.Scene();
    const effects = new CombatEffects(scene);

    effects.spawnShot({
      weaponId: 'm4',
      origin: new THREE.Vector3(0, 1.4, 0),
      direction: new THREE.Vector3(0, 0, -1),
      hitPoint: null,
      hitNormal: null,
      hitAgentId: null,
    });
    expect(effects.getActiveCounts().tracers).toBe(1);

    effects.spawnShot({
      weaponId: 'sawnoff',
      origin: new THREE.Vector3(0, 1.4, 0),
      direction: new THREE.Vector3(0, 0, -1),
      hitPoint: null,
      hitNormal: null,
      hitAgentId: null,
    });
    expect(effects.getActiveCounts().tracers).toBe(7);

    for (let i = 0; i < 6; i++) effects.update(0.05);
    expect(effects.getActiveCounts().tracers).toBe(0);

    effects.spawnShot({
      weaponId: 'm4',
      origin: new THREE.Vector3(0, 1.4, 0),
      direction: new THREE.Vector3(0, 0, -1),
      hitPoint: null,
      hitNormal: null,
      hitAgentId: null,
    });
    effects.update(0.1);
    expect(effects.getActiveCounts().tracers).toBe(1);
    effects.update(0.1);
    expect(effects.getActiveCounts().tracers).toBe(0);

    effects.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it('drops blood splatters onto lower ground beside a raised fixture instead of floating at hit elevation', () => {
    const scene = new THREE.Scene();
    const road = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial());
    road.rotation.x = -Math.PI / 2;
    road.position.y = -0.04;
    road.updateMatrixWorld(true);

    const raisedCurb = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.265, 0.3), new THREE.MeshBasicMaterial());
    raisedCurb.position.set(0, 0.225 - 0.1325, -3);
    raisedCurb.updateMatrixWorld(true);
    scene.add(road, raisedCurb);

    const effects = new CombatEffects(scene);
    for (let i = 0; i < 6; i++) {
      effects.spawnShot({
        weaponId: 'pistol',
        origin: new THREE.Vector3(0, 1.4, 2),
        direction: new THREE.Vector3(0, 0, -1),
        hitPoint: new THREE.Vector3(0, 1.1, -3),
        hitNormal: new THREE.Vector3(0, 0, 1),
        hitAgentId: 'z-1',
        worldTargets: [road, raisedCurb],
      });
    }

    const splats = effects.root.children.filter((obj) => obj.name === 'blood-ground-splat');
    expect(splats.length).toBeGreaterThan(0);
    for (const splat of splats) {
      expect(splat.position.y).toBeCloseTo(-0.025, 3);
    }

    effects.dispose();
    road.geometry.dispose();
    road.material.dispose();
    raisedCurb.geometry.dispose();
    raisedCurb.material.dispose();
  });

  it('spawns blood droplets, mist, and floor-aligned ground splatters on zombie hits with cap enforcement', () => {
    const scene = new THREE.Scene();
    const road = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial());
    road.rotation.x = -Math.PI / 2;
    road.position.y = -0.04;
    road.updateMatrixWorld(true);
    scene.add(road);

    const effects = new CombatEffects(scene);
    effects.spawnShot({
      weaponId: 'pistol',
      origin: new THREE.Vector3(0, 1.4, 2),
      direction: new THREE.Vector3(0, 0, -1),
      hitPoint: new THREE.Vector3(0, 1.1, -3),
      hitNormal: new THREE.Vector3(0, 0, 1),
      hitAgentId: 'z-1',
      worldTargets: [road],
    });

    const counts = effects.getActiveCounts();
    expect(counts.tracers).toBe(6);
    expect(counts.droplets).toBe(26);
    expect(counts.mist).toBe(5);
    expect(counts.groundSplats).toBe(2);
    expect(counts.sparks).toBe(0);

    const splats = effects.root.children.filter((obj) => obj.name === 'blood-ground-splat');
    expect(splats).toHaveLength(2);
    for (const splat of splats) {
      expect(splat.position.y).toBeCloseTo(-0.025, 3);
    }

    for (let i = 0; i < 60; i++) {
      effects.spawnShot({
        weaponId: 'm4',
        origin: new THREE.Vector3(0, 1.4, 2),
        direction: new THREE.Vector3(0, 0, -1),
        hitPoint: new THREE.Vector3(0, 1.1, -3),
        hitNormal: new THREE.Vector3(0, 0, 1),
        hitAgentId: 'z-1',
        worldTargets: [road],
      });
    }
    expect(effects.getActiveCounts().groundSplats).toBeLessThanOrEqual(48);

    effects.clear();
    expect(effects.getActiveCounts()).toEqual({
      tracers: 0,
      droplets: 0,
      mist: 0,
      groundSplats: 0,
      sparks: 0,
    });

    effects.dispose();
    road.geometry.dispose();
    road.material.dispose();
  });

  it('spawns impact sparks and dust with zero blood when hitting world geometry', () => {
    const scene = new THREE.Scene();
    const effects = new CombatEffects(scene);

    effects.spawnShot({
      weaponId: 'persuader',
      origin: new THREE.Vector3(0, 1.4, 2),
      direction: new THREE.Vector3(0, 0, -1),
      hitPoint: new THREE.Vector3(0, 1.4, -4),
      hitNormal: new THREE.Vector3(0, 0, 1),
      hitAgentId: null,
    });

    const counts = effects.getActiveCounts();
    expect(counts.tracers).toBe(1);
    expect(counts.sparks).toBe(8);
    expect(counts.mist).toBe(2);
    expect(counts.droplets).toBe(0);
    expect(counts.groundSplats).toBe(0);

    effects.dispose();
  });
});
