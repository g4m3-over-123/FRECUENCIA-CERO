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

export function streetLamp() {
  const group = new THREE.Group();
  part(group, dark, 0, 1.8, 0, 0.085, 3.6, 0.085, drum);
  part(group, steel, 0, 3.56, 0.23, 0.07, 0.09, 0.5);
  part(group, dark, 0, 3.51, 0.49, 0.32, 0.13, 0.38);
  part(group, amber, 0, 3.42, 0.49, 0.28, 0.07, 0.32);
  const light = new THREE.PointLight(0xffbd79, 19, 15, 1.65);
  light.position.set(0, 3.34, 0.49);
  group.add(light);
  return group;
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
    part(group, dark, 0, 1.14, 0, 1.7, 2.28, 0.11);
    for (let i = 0; i < 14; i++) part(group, steel, 0, 0.12 + i * 0.145, 0.075, 1.5, 0.12, 0.045);
    part(group, dark, 0, 2.53, 0.02, 0.7, 0.7, 0.16);
    part(group, green, 0, 2.53, 0.12, 0.53, 0.16, 0.06);
    part(group, green, 0, 2.53, 0.12, 0.16, 0.53, 0.055);
  } else if (kind === 'refuge') {
    part(group, dark, 0, 0.52, 0, 0.91, 1.04, 0.28);
    part(group, steel, 0, 0.96, 0.12, 0.85, 0.26, 0.13);
    part(group, blue, -0.18, 0.98, 0.195, 0.29, 0.13, 0.02);
    for (const x of [0.09, 0.19, 0.29]) part(group, dark, x, 0.94, 0.2, 0.06, 0.06, 0.04);
    part(group, steel, 0.31, 1.96, 0, 0.032, 1.85, 0.032, drum);
    part(group, glow(0x65bfff), 0.31, 2.92, 0, 0.085, 0.12, 0.085, drum).name = 'radio-indicator';
    for (let i = 0; i < 3; i++) {
      part(group, canvas, -0.65, 0.12 + i * 0.17, 0, 0.46, 0.2, 0.32, drum).rotation.y = i;
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
