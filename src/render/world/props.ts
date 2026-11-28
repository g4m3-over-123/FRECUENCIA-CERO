import * as THREE from 'three';
import type { PickupKind } from '../../core/gameplay/scenes.ts';

const cube = new THREE.BoxGeometry();
const drum = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
const hoop = new THREE.RingGeometry(0.46, 0.5, 48).rotateX(-Math.PI / 2);
const surface = (color: number) => new THREE.MeshStandardMaterial({ color, roughness: 0.72 });
const glow = (color: number) => new THREE.MeshBasicMaterial({ color });
const steel = surface(0x55616b);
const dark = surface(0x232d37);
const wood = surface(0x99704a);
const canvas = surface(0x838065);
const green = glow(0x65ffab);
const amber = glow(0xffbc68);
const blue = glow(0x76dfff);
const white = surface(0xeeeecc);
const red = surface(0xb75024);
const navy = surface(0x335674);

function part(group: THREE.Group, material: THREE.Material, x: number, y: number, z: number,
  width: number, height: number, depth: number, geometry: THREE.BufferGeometry = cube) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.scale.set(width, height, depth);
  group.add(mesh);
  return mesh;
}

function handle(group: THREE.Group, y: number) {
  for (const x of [-0.09, 0.09]) part(group, steel, x, y, 0, 0.035, 0.1, 0.045);
  part(group, dark, 0, y + 0.05, 0, 0.22, 0.04, 0.045);
}

export function pickupModel(kind: PickupKind) {
  const group = new THREE.Group();
  if (kind === 'medicine') {
    part(group, white, 0, 0, 0, 0.42, 0.29, 0.17);
    handle(group, 0.18);
    for (const z of [-0.09, 0.09]) {
      part(group, green, 0, 0, z, 0.17, 0.05, 0.012);
      part(group, green, 0, 0, z, 0.05, 0.17, 0.011);
    }
  } else if (kind === 'fuel') {
    part(group, red, 0, 0, 0, 0.32, 0.44, 0.18);
    handle(group, 0.25);
    part(group, amber, 0.12, 0.23, 0, 0.065, 0.07, 0.08, drum);
    for (const angle of [-0.65, 0.65]) {
      part(group, red, 0, 0, 0, 0.028, 0.3, 0.20).rotation.z = angle;
    }
  } else {
    part(group, navy, 0, 0, 0, 0.39, 0.29, 0.21);
    part(group, dark, 0, 0.15, 0, 0.42, 0.055, 0.23);
    for (const x of [-0.13, 0.13]) part(group, blue, x, 0.21, 0, 0.065, 0.085, 0.065, drum);
  }
  return group;
}

export function barricadeModel(width: number) {
  const group = new THREE.Group();
  for (const sign of [-1, 1]) {
    const x = sign * width * 0.37;
    part(group, steel, x, 0.65, 0, 0.075, 1.3, 0.12);
    part(group, dark, x, 0.05, 0, 0.13, 0.10, 0.42);
    part(group, wood, 0, 0.69, sign * 0.077, Math.hypot(width * 0.88, 0.82), 0.17, 0.07)
      .rotation.z = sign * Math.atan2(0.82, width * 0.88);
  }
  part(group, steel, 0, 1.18, 0, width * 0.93, 0.09, 0.1);
  return group;
}

export function decoyModel() {
  const group = new THREE.Group();
  part(group, dark, 0, 0.14, 0, 0.23, 0.28, 0.23, drum);
  for (const y of [0.09, 0.16, 0.23]) part(group, steel, 0, y, 0, 0.245, 0.025, 0.245, drum);
  part(group, amber, 0, 0.29, 0, 0.14, 0.025, 0.14, drum);
  part(group, amber, 0, 0.035, 0, 1, 1, 1, hoop).name = 'sound-ring';
  return group;
}

export function streetLamps(mounts: THREE.Matrix4[]) {
  const group = new THREE.Group();
  const addPart = (geometry: THREE.BufferGeometry, material: THREE.Material, y: number, z: number,
    width: number, height: number, depth: number) => {
    const mesh = new THREE.InstancedMesh(geometry, material, mounts.length);
    const local = new THREE.Matrix4().makeScale(width, height, depth).setPosition(0, y, z);
    const matrix = new THREE.Matrix4();
    mounts.forEach((mount, i) => mesh.setMatrixAt(i, matrix.multiplyMatrices(mount, local)));
    group.add(mesh);
  };
  addPart(drum, dark, 1.8, 0, 0.085, 3.6, 0.085);
  addPart(cube, steel, 3.56, 0.23, 0.07, 0.09, 0.5);
  addPart(cube, dark, 3.51, 0.49, 0.32, 0.13, 0.38);
  addPart(cube, amber, 3.42, 0.49, 0.28, 0.07, 0.32);
  for (const mount of mounts) {
    const light = new THREE.PointLight(0xffbd79, 22, 22, 1.45);
    light.position.set(0, 3.34, 0.49).applyMatrix4(mount);
    group.add(light);
  }
  return group;
}

export function mountPharmacyStorefront(marker: THREE.Group, store: THREE.Group): THREE.Group {
  const facade = new THREE.Group();
  facade.name = 'pharmacy-storefront';
  store.rotation.y = Math.PI / 2;
  facade.add(store);

  const bounds = new THREE.Box3().setFromObject(facade);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  facade.scale.set(3.8 / size.x, 3.18 / size.y, 0.48);
  facade.position.set(-center.x * facade.scale.x, 0.02 - bounds.min.y * facade.scale.y,
    -0.24 - bounds.min.z * facade.scale.z);

  const materials = new Set<THREE.MeshStandardMaterial>();
  facade.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    const surfaceMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of surfaceMaterials) {
      if (material instanceof THREE.MeshStandardMaterial) materials.add(material);
    }
  });
  for (const material of materials) {
    material.color.multiplyScalar(0.8);
    material.roughness = Math.max(material.roughness, 0.96);
    material.emissiveIntensity = 0;
    material.transparent = false;
    material.alphaTest = 0.3;
    material.depthWrite = true;
  }

  const front = facade.position.z + bounds.max.z * facade.scale.z;
  const boardMap = [...materials].find(material => material.map)?.map?.clone();
  if (boardMap) {
    boardMap.repeat.set(0.32, 0.095);
    boardMap.offset.set(0.39, 0.483);
    boardMap.needsUpdate = true;
  }
  const boards = new THREE.MeshStandardMaterial({
    color: 0x96826e, map: boardMap ?? null, roughness: 0.96,
  });
  const boarded = new THREE.Group();
  boarded.name = 'pharmacy-window-boards';
  for (const [x, y, width, angle] of [
    [-0.89, 1.48, 1.46, -0.20],
    [-0.87, 1.17, 1.38, 0.11],
    [0.92, 1.61, 1.18, 0.19],
    [0.91, 1.26, 1.12, -0.15],
  ]) part(boarded, boards, x, y, front + 0.025, width, 0.13, 0.048).rotation.z = angle;
  marker.add(boarded);

  const sign = marker.getObjectByName('pharmacy-sign')!;
  sign.position.set(0, 2.78, front + 0.015);
  const light = marker.getObjectByName('zone-light-pharmacy')!;
  light.position.set(0, 2.06, front + 0.55);
  marker.getObjectByName('pharmacy-door')?.removeFromParent();
  marker.add(facade);
  return facade;
}

export function landmark(kind: 'pharmacy' | 'refuge' | 'extraction') {
  const group = new THREE.Group();
  group.name = kind;
  const light = new THREE.PointLight(0xffaa62, 16, 13, 1.65);
  light.name = 'zone-light-' + kind;
  light.position.set(0, 1.9, 0.5);
  group.add(light);
  if (kind === 'pharmacy') {
    light.color.setHex(0x63ffbc);
    const door = new THREE.Group();
    door.name = 'pharmacy-door';
    part(door, steel, 0, 1.14, 0, 1.0, 2.28, 0.11);
    for (const y of [0.24, 0.81, 1.38, 1.95]) part(door, dark, 0, y, 0.065, 0.98, 0.045, 0.035);
    const sign = new THREE.Group();
    sign.name = 'pharmacy-sign';
    sign.position.y = 2.53;
    part(sign, dark, 0, 0, 0.02, 0.7, 0.7, 0.16);
    part(sign, green, 0, 0, 0.12, 0.53, 0.16, 0.06);
    part(sign, green, 0, 0, 0.12, 0.16, 0.53, 0.055);
    group.add(door, sign);
  } else if (kind === 'refuge') {
    part(group, dark, 0, 0.52, 0, 0.91, 1.04, 0.28);
    part(group, steel, 0, 0.96, 0.12, 0.85, 0.26, 0.13);
    part(group, blue, -0.18, 0.98, 0.195, 0.29, 0.13, 0.02);
    for (const x of [0.09, 0.19, 0.29]) part(group, dark, x, 0.94, 0.2, 0.06, 0.06, 0.04);
    part(group, steel, 0.31, 1.96, 0, 0.032, 1.85, 0.032, drum);
    part(group, glow(0x65bfff), 0.31, 2.92, 0, 0.085, 0.12, 0.085, drum).name = 'radio-indicator';
    for (let i = 0; i < 3; i++) {
      part(group, canvas, -0.49, 0.12 + i * 0.17, 0, 0.28, 0.2, 0.26, drum).rotation.y = i;
    }
  } else {
    const lens = glow(0xff3b3b);
    light.color.copy(lens.color);
    light.position.y = 3.25;
    part(group, steel, 0, 1.45, 0, 0.16, 2.9, 0.16, drum);
    part(group, dark, 0, 2.93, 0, 0.43, 0.12, 0.43, drum);
    part(group, lens, 0, 3.16, 0, 0.31, 0.38, 0.31, drum).name = 'extraction-lens';
    part(group, dark, 0, 3.39, 0, 0.42, 0.09, 0.42, drum);
    part(group, lens, 0, 0.045, 0.48, 0.88, 1, 0.88, hoop).name = 'extraction-ring';
  }
  return group;
}
