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
const tungsten = glow(0xffd294);
const white = surface(0xeeeecc);
const red = surface(0xb75024);
const copper = surface(0xb3743c);
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

function decoratePharmacy(room: THREE.Group): void {
  const decor = new THREE.Group();
  decor.name = 'pharmacy-decor';

  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 384;
  const ink = canvas.getContext('2d');
  if (ink) {
    ink.fillStyle = '#c5bba1';
    ink.fillRect(0, 0, 512, 384);
    for (const [x, y, radius] of [[28, 348, 54], [474, 12, 81], [490, 335, 62]]) {
      const stain = ink.createRadialGradient(x, y, 0, x, y, radius);
      stain.addColorStop(0, 'rgba(75, 59, 39, 0.50)');
      stain.addColorStop(1, 'rgba(75, 59, 39, 0)');
      ink.fillStyle = stain;
      ink.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
    ink.fillStyle = '#4f653c';
    ink.fillRect(22, 30, 468, 64);
    ink.fillStyle = '#f5eddb';
    ink.font = 'bold 37px sans-serif';
    ink.fillText('AVISO DE EVACUACIÓN', 39, 73);
    ink.fillStyle = '#383827';
    ink.font = 'bold 27px sans-serif';
    ink.fillText('TURNO DE GUARDIA', 40, 146);
    ink.font = '26px sans-serif';
    ink.fillText('Reservar el último botiquín', 40, 198);
    ink.fillText('para el refugio.', 40, 235);
    ink.strokeStyle = '#817558';
    ink.lineWidth = 2;
    ink.beginPath();
    ink.moveTo(40, 265);
    ink.lineTo(468, 265);
    ink.stroke();
    ink.fillStyle = '#704238';
    ink.font = 'bold 24px sans-serif';
    ink.fillText('CIERRE DE EMERGENCIA', 40, 316);

    const notice = new THREE.CanvasTexture(canvas);
    notice.colorSpace = THREE.SRGBColorSpace;
    const paper = new THREE.MeshStandardMaterial({ color: 0xb4ac9c, map: notice, roughness: 1 });
    const board = new THREE.Mesh(new THREE.PlaneGeometry(0.96, 0.72), paper);
    board.position.set(1.325, 1.65, -1.27);
    board.rotation.y = -Math.PI / 2;
    decor.add(board);
    part(decor, steel, 1.329, 1.98, -1.27, 0.015, 0.055, 0.92);
  }

  const palePaper = surface(0xa9a28b);
  const oldCardboard = surface(0x9a8466);
  const brownBottle = surface(0x734021);
  const label = surface(0xb6b39c);
  const fadedGreen = surface(0x617b55);
  part(decor, dark, 1.253, 1.105, 1.13, 0.16, 0.035, 0.84);
  for (const [z, height] of [[0.85, 0.19], [1.00, 0.15], [1.15, 0.22]]) {
    part(decor, brownBottle, 1.225, 1.123 + height / 2, z, 0.085, height, 0.085, drum);
    part(decor, label, 1.225, 1.157 + height / 2, z, 0.088, 0.048, 0.088, drum);
    part(decor, dark, 1.225, 1.128 + height, z, 0.074, 0.032, 0.074, drum);
  }
  part(decor, oldCardboard, 1.227, 1.182, 1.44, 0.105, 0.115, 0.20);
  part(decor, fadedGreen, 1.173, 1.179, 1.44, 0.009, 0.041, 0.19);

  // The counter top is part of the imported model.
  const inventory = new THREE.Group();
  inventory.position.set(-1.12, 0.61, -1.83);
  inventory.rotation.y = -0.12;
  decor.add(inventory);
  part(inventory, dark, 0, 0.008, 0, 0.20, 0.013, 0.25);
  part(inventory, palePaper, 0, 0.017, 0, 0.17, 0.006, 0.22);
  for (const z of [-0.067, -0.032, 0.003, 0.038, 0.073]) {
    part(inventory, fadedGreen, 0, 0.021, z, 0.13, 0.001, 0.004);
  }
  part(decor, oldCardboard, -1.05, 0.638, -1.16, 0.12, 0.055, 0.18).rotation.y = 0.25;
  part(decor, label, -1.05, 0.667, -1.16, 0.07, 0.005, 0.11).rotation.y = 0.25;

  // Decorations are visual even when rays traverse the collidable room.
  decor.traverse(object => {
    if (object instanceof THREE.Mesh) object.raycast = () => {};
  });
  room.add(decor);
}

export function mountPharmacyInterior(marker: THREE.Group, model: THREE.Group): THREE.Group {
  const room = new THREE.Group();
  room.name = 'pharmacy-interior';
  model.position.set(-1.82, -0.02, -0.5);
  model.scale.setScalar(0.6);
  const materials = new Set<THREE.MeshStandardMaterial>();
  model.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    object.name = 'pharmacy-' + object.name;
    const surfaces = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of surfaces) {
      if (material instanceof THREE.MeshStandardMaterial) materials.add(material);
    }
  });
  for (const material of materials) {
    material.color.multiplyScalar(0.85);
    material.roughness = Math.max(material.roughness, 0.86);
    material.emissiveIntensity = 0;
    if (material.transparent) {
      material.transparent = false;
      material.alphaTest = 0.32;
      material.depthWrite = true;
    }
  }
  room.add(model);

  const wallTexture = [...materials].find(material => material.name === 'Material.001')?.map;
  const masonry = new THREE.MeshStandardMaterial({ color: 0x777a71, map: wallTexture ?? null, roughness: 0.94 });
  part(room, masonry, 1.43, 1.41, -0.5, 0.19, 2.82, 5.25);
  decoratePharmacy(room);
  part(marker, masonry, 0, 2.56, -0.24, 1.22, 0.50, 0.53);
  marker.getObjectByName('pharmacy-door')?.removeFromParent();
  const sign = marker.getObjectByName('pharmacy-sign')!;
  sign.position.set(0, 2.64, 0.10);
  const entrance = marker.getObjectByName('zone-light-pharmacy') as THREE.PointLight;
  entrance.position.set(0, 2.13, 0.33);
  entrance.intensity = 11;
  entrance.distance = 6;

  const interior = new THREE.SpotLight(0x80cfb1, 9, 5, Math.PI / 3, 0.8, 1.6);
  interior.name = 'pharmacy-interior-light';
  interior.position.set(-0.7, 2.48, 0.15);
  interior.target.position.set(0.55, 0.36, -0.18);
  room.add(interior, interior.target);
  part(room, green, -0.7, 2.49, 0.15, 0.42, 0.045, 0.10);
  return room;
}

/** Normalizes and mounts portable_generator.glb flush along the wall beside the radio console. */
export function mountRefugeStation(marker: THREE.Group, generator?: THREE.Group): THREE.Group {
  const unit = new THREE.Group();
  unit.name = 'refuge-generator';
  if (generator) {
    const materials = new Set<THREE.MeshStandardMaterial>();
    generator.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.name = 'refuge-generator-' + object.name;
      object.castShadow = true;
      object.receiveShadow = true;
      const surfaces = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of surfaces) {
        if (material instanceof THREE.MeshStandardMaterial) materials.add(material);
      }
    });
    for (const material of materials) {
      material.roughness = Math.max(material.roughness, 0.78);
      material.emissiveIntensity = 0;
    }
    const pivot = new THREE.Group();
    pivot.add(generator);
    pivot.updateMatrixWorld(true);
    const rawBox = new THREE.Box3().setFromObject(pivot);
    const rawSize = new THREE.Vector3();
    rawBox.getSize(rawSize);
    const maxSpan = Math.max(rawSize.x, rawSize.z);
    const scale = maxSpan > 0 ? 0.95 / maxSpan : 1;
    pivot.scale.setScalar(scale);
    pivot.updateMatrixWorld(true);
    const scaledBox = new THREE.Box3().setFromObject(pivot);
    const scaledCenter = new THREE.Vector3();
    scaledBox.getCenter(scaledCenter);
    pivot.position.set(-scaledCenter.x, -scaledBox.min.y, -scaledCenter.z);
    unit.add(pivot);
  } else {
    // Compact fallback generator frame when the GLB asset is unavailable.
    part(unit, red, 0, 0.28, 0, 0.74, 0.42, 0.44);
    part(unit, dark, 0, 0.50, 0, 0.78, 0.06, 0.48);
    part(unit, steel, 0, 0.04, 0, 0.80, 0.08, 0.50);
  }
  unit.position.set(-0.98, 0, 0.24);
  marker.add(unit);
  return unit;
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
    light.color.setHex(0xffb266);
    light.intensity = 24;
    light.distance = 14;
    light.decay = 1.5;
    light.position.set(0, 2.35, 0.75);

    const workLight = new THREE.SpotLight(0xffc27a, 26, 10, Math.PI / 2.6, 0.68, 1.4);
    workLight.name = 'refuge-work-light';
    workLight.position.set(0, 2.72, 0.55);
    workLight.target.position.set(0, 0.35, 1.15);
    group.add(workLight, workLight.target);

    // Overhead warm tungsten work-lamp arm and housing.
    part(group, steel, 0, 2.80, 0.22, 0.05, 0.05, 0.56);
    part(group, dark, 0, 2.78, 0.50, 0.42, 0.07, 0.22);
    part(group, tungsten, 0, 2.73, 0.50, 0.34, 0.04, 0.14);

    // Radio console cabinet, transceiver faceplate, battery dock, and antenna.
    part(group, dark, 0, 0.52, 0, 0.91, 1.04, 0.28);
    part(group, steel, 0, 0.96, 0.12, 0.85, 0.26, 0.13);
    part(group, glow(0x76dfff), -0.18, 0.98, 0.195, 0.29, 0.13, 0.02).name = 'radio-screen';
    for (const x of [0.09, 0.19, 0.29]) part(group, dark, x, 0.94, 0.20, 0.06, 0.06, 0.04);
    part(group, steel, -0.22, 0.56, 0.145, 0.36, 0.26, 0.04);
    part(group, dark, -0.22, 0.56, 0.165, 0.28, 0.18, 0.03);
    for (const x of [-0.28, -0.16]) part(group, copper, x, 0.56, 0.182, 0.04, 0.08, 0.02);
    part(group, steel, 0.31, 1.96, 0, 0.032, 1.85, 0.032, drum);
    part(group, glow(0x65bfff), 0.31, 2.92, 0, 0.085, 0.12, 0.085, drum).name = 'radio-indicator';

    // Power cables running flush along the wall base toward the portable generator.
    part(group, dark, -0.58, 0.025, 0.14, 0.52, 0.03, 0.035);
    part(group, red, -0.58, 0.025, 0.185, 0.50, 0.025, 0.025);
    part(group, dark, -0.35, 0.28, 0.155, 0.03, 0.52, 0.03);

    // Non-blocking emergency field crate/table flush along the wall.
    part(group, wood, 0.84, 0.25, 0.14, 0.56, 0.50, 0.36);
    part(group, dark, 0.84, 0.51, 0.14, 0.58, 0.04, 0.38);
    part(group, steel, 0.84, 0.25, 0.325, 0.12, 0.08, 0.02);
    part(group, canvas, 0.76, 0.555, 0.14, 0.24, 0.05, 0.20).rotation.y = 0.18;
    part(group, amber, 0.99, 0.575, 0.16, 0.075, 0.09, 0.075, drum);
  } else {
    const lens = glow(0xff3b3b);
    light.color.copy(lens.color);
    light.position.set(0, 4.2, 0.35);
    light.distance = 28;
    light.decay = 1.4;
    part(group, dark, 0, 0.14, 0, 0.44, 0.28, 0.44);
    part(group, steel, 0, 1.92, 0, 0.18, 3.84, 0.18, drum);
    part(group, dark, 0, 3.85, 0, 0.50, 0.14, 0.50, drum);
    part(group, lens, 0, 4.18, 0, 0.42, 0.58, 0.42, drum).name = 'extraction-lens';
    part(group, dark, 0, 4.52, 0, 0.48, 0.10, 0.48, drum);
    part(group, lens, 0, 0.045, 0.48, 1.28, 1, 1.28, hoop).name = 'extraction-ring';
  }
  return group;
}
