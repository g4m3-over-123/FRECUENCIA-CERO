import { mkdir, writeFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// The glTF exporter reads a Blob through FileReader in browsers.
globalThis.FileReader ??= class {
  async readAsArrayBuffer(blob) {
    this.result = await blob.arrayBuffer();
    this.onloadend?.();
  }
};

const OUTPUT = new URL('../../../public/assets/characters/', import.meta.url);
const variants = [
  {
    file: 'refugio_explorer.glb', name: 'Explorador', height: 1.68, width: .94,
    jacket: 0x686850, sleeves: 0x83806a, trim: 0xa19a6f, pants: 0x343943,
    boots: 0x282833, skin: 0xada480, hair: 0x453d34, eyes: 0xe9c58d, infected: true,
  },
  {
    file: 'refugio_pursuer.glb', name: 'Perseguidor', height: 1.89, width: 1.24,
    jacket: 0x633b3b, sleeves: 0x824946, trim: 0x996e58, pants: 0x4a4145,
    boots: 0x332f36, skin: 0xb58272, hair: 0x3f373b, eyes: 0xff9b65, infected: true, armored: true,
  },
  {
    file: 'refugio_radio_survivor.glb', name: 'Superviviente de la radio', height: 1.75, width: 1,
    jacket: 0x395875, sleeves: 0x506f8a, trim: 0xdcb273, pants: 0x4d5464,
    boots: 0x343740, skin: 0xb98e70, hair: 0x513e39, eyes: 0xd8c2a3, infected: false,
  },
];

function createRig() {
  const bones = {};
  function add(name, parent, x, y, z = 0) {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(x, y, z);
    parent?.add(bone);
    bones[name] = bone;
    return bone;
  }

  const hips = add('Hips', null, 0, .86);
  const chest = add('Chest', hips, 0, .12);
  add('Head', chest, 0, .49, .03);
  for (const [side, sign] of [['L', -1], ['R', 1]]) {
    const arm = add(`UpperArm${side}`, chest, sign * .235, .365);
    add(`Forearm${side}`, arm, 0, -.275);
    const thigh = add(`Thigh${side}`, hips, sign * .112, -.027);
    const shin = add(`Shin${side}`, thigh, 0, -.385);
    add(`Foot${side}`, shin, 0, -.325);
  }
  hips.updateMatrixWorld(true);
  return bones;
}

function makeSkin(bones, variant) {
  const joints = Object.values(bones);
  const colors = {
    coat: variant.jacket, sleeve: variant.sleeves, trim: variant.trim, pants: variant.pants,
    boot: variant.boots, skin: variant.skin, hair: variant.hair, eye: variant.eyes,
    shadow: 0x342b35, injury: 0x713f48, band: 0x958e7d, metal: 0x616775,
  };
  const pieces = new Map();
  const transform = new THREE.Matrix4();
  const translation = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);

  function add(joint, color, shape, at, angle = 0) {
    const index = joints.indexOf(bones[joint]);
    translation.fromArray(at);
    rotation.setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle);
    const geometry = shape.index ? shape.toNonIndexed() : shape;
    geometry.deleteAttribute('uv');
    geometry.applyMatrix4(transform.compose(translation, rotation, scale).premultiply(bones[joint].matrixWorld));
    const count = geometry.attributes.position.count;
    const skinIndex = new Uint16Array(count * 4);
    const skinWeight = new Float32Array(count * 4);
    for (let i = 0; i < count * 4; i += 4) {
      skinIndex[i] = index;
      skinWeight[i] = 1;
    }
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
    if (!pieces.has(color)) pieces.set(color, []);
    pieces.get(color).push(geometry);
  }

  const box = (joint, color, at, size, angle) => {
    add(joint, color, new THREE.BoxGeometry(...size), at, angle);
  };
  const facet = (joint, color, at, size, detail = 0) => {
    add(joint, color, new THREE.IcosahedronGeometry(.5, detail).scale(...size), at);
  };
  const taper = (joint, color, at, top, bottom, length, depth = .87) => {
    add(joint, color, new THREE.CylinderGeometry(top, bottom, length, 8).scale(1, 1, depth), at);
  };

  const w = variant.width;
  taper('Hips', 'pants', [0, 0, 0], .175 * w, .185 * w, .19, .83);
  taper('Chest', 'coat', [0, .192, 0], .255 * w, .175 * w, .43, .68);
  taper('Chest', 'coat', [0, .378, 0], .19 * w, .235 * w, .13, .69);
  taper('Chest', 'trim', [0, .434, .015], .105, .128, .085, .91);
  taper('Chest', 'boot', [0, -.008, 0], .18 * w, .177 * w, .046, .88);
  box('Chest', 'metal', [0, -.01, .16 * w], [.066, .047, .016]);

  taper('Head', 'skin', [0, .022, 0], .072, .07, .112);
  facet('Head', 'skin', [0, .132, .018], [.279, .31, .264], 1);
  facet('Head', 'skin', [0, .074, .076], [.194, .134, .14], 1);
  facet('Head', 'skin', [0, .122, .151], [.064, .085, .068]);
  facet('Head', 'hair', [0, .227, -.019], [.273, .125, .235], 1);
  for (const sign of [-1, 1]) {
    facet('Head', 'skin', [sign * .119, .127, .005], [.052, .08, .064]);
    box('Head', 'shadow', [sign * .053, .151, .12], [.062, .034, .032]);
    box('Head', 'eye', [sign * .053, .152, .138], [.03, .013, .012]);
    if (!variant.infected) box('Head', 'hair', [sign * .055, .169, .129], [.038, .009, .012]);
  }
  box('Head', 'shadow', [0, .075, .142], [variant.infected ? .094 : .053, .012, .012]);

  for (const [side, sign] of [['L', -1], ['R', 1]]) {
    const arm = `UpperArm${side}`;
    const forearm = `Forearm${side}`;
    const thigh = `Thigh${side}`;
    const shin = `Shin${side}`;
    const foot = `Foot${side}`;
    facet(arm, 'sleeve', [sign * .015, -.031, .009], [.215 * w, .245, .225 * w], 1);
    taper(arm, 'sleeve', [sign * .012, -.141, 0], .104 * w, .074 * w, .248);
    taper(forearm, variant.infected && side === 'R' ? 'skin' : 'sleeve', [0, -.117, .01], .077 * w, .049 * w, .245);
    facet(forearm, variant.infected ? 'skin' : 'shadow', [0, -.272, .031], [.096 * w, .135, .105 * w], 1);
    for (const offset of [-.022, 0, .022]) {
      facet(forearm, variant.infected ? 'skin' : 'shadow', [offset * w, -.325, .042], [.032 * w, .067, .048]);
    }
    taper(thigh, 'pants', [0, -.18, 0], .12 * w, .087 * w, .386);
    taper(shin, 'pants', [0, -.134, 0], .09 * w, .073 * w, .292);
    facet(shin, 'shadow', [0, -.038, .074], [.146 * w, .16, .087]);
    facet(foot, 'boot', [0, -.023, .055], [.17 * w, .15, .29], 1);
    box(foot, 'shadow', [0, -.08, .06], [.145 * w, .028, .224]);
    box(foot, 'band', [0, .019, .12], [.102 * w, .012, .039]);
  }

  if (variant.infected) {
    box('Chest', 'trim', [-.113 * w, .176, .14 * w], [.095, .11, .019], -.15);
    facet('Chest', 'injury', [.112 * w, .3, .15 * w], [.13 * w, .155, .044]);
    facet('Head', 'injury', [-.087, .096, .111], [.1, .099, .032]);
    box('UpperArmL', 'band', [0, -.11, .08 * w], [.132 * w, .038, .046]);
    if (variant.armored) {
      facet('UpperArmL', 'trim', [-.075, -.04, .016], [.29, .29, .28], 1);
      facet('UpperArmL', 'coat', [-.111, -.081, .022], [.242, .22, .264]);
      box('ForearmR', 'metal', [.049, -.126, .02], [.104, .20, .175], .1);
      box('Chest', 'trim', [0, .255, .177], [.255, .038, .027], -.14);
    }
  } else {
    taper('Head', 'coat', [0, .24, -.004], .113, .148, .079, .88);
    box('Head', 'boot', [0, .2, .13], [.2, .022, .15]);
    box('Chest', 'trim', [0, .277, .147], [.3, .06, .036]);
    for (const sign of [-1, 1]) {
      box('Chest', 'shadow', [sign * .111, .19, .154], [.035, .324, .031], sign * .135);
      box('Chest', 'trim', [sign * .111, .041, .13], [.068, .091, .054]);
    }
    box('Chest', 'boot', [0, .228, -.196], [.275, .343, .158]);
    box('Chest', 'band', [0, .286, -.28], [.236, .117, .027]);
    box('Chest', 'metal', [.16, .372, .11], [.069, .127, .045]);
    box('Chest', 'shadow', [.179, .458, .111], [.013, .09, .014]);
    box('Chest', 'trim', [.161, .392, .136], [.03, .024, .012]);
  }

  const materials = [];
  const byMaterial = [];
  for (const [color, geometry] of pieces) {
    const emissive = color === 'eye' && variant.infected ? variant.eyes : 0;
    materials.push(new THREE.MeshStandardMaterial({
      name: color, color: colors[color], roughness: .87, emissive, emissiveIntensity: .52,
    }));
    byMaterial.push(mergeGeometries(geometry));
  }
  const mesh = new THREE.SkinnedMesh(mergeGeometries(byMaterial, true), materials);
  mesh.name = 'Character';
  mesh.add(bones.Hips);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(joints));
  return mesh;
}

function createAnimations(bones, variant) {
  const infected = variant.infected;
  const idle = {
    Chest: [infected ? .19 : .025, 0, infected ? -.05 : 0], Head: [-.11, -.1, .04],
    UpperArmL: [-.15, 0, -.13], UpperArmR: [-.3, 0, .13],
    ForearmL: [-.23, 0, 0], ForearmR: [-.38, 0, 0],
  };
  const pose = (overrides = {}, vertical = 0, forward = 0) => ({
    rotation: { ...idle, ...overrides }, vertical, forward,
  });
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();

  function clip(name, duration, poses) {
    const times = poses.map(([fraction]) => fraction * duration);
    const tracks = Object.keys(bones).map((name) => {
      const values = poses.flatMap(([, frame]) => q.setFromEuler(e.fromArray(frame.rotation[name] ?? [0, 0, 0])).toArray());
      return new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, values);
    });
    tracks.push(new THREE.VectorKeyframeTrack('Hips.position', times,
      poses.flatMap(([, frame]) => [0, bones.Hips.position.y + frame.vertical, frame.forward])));
    return new THREE.AnimationClip(name, duration, tracks);
  }

  function gait(name, duration, speed) {
    return clip(name, duration, Array.from({ length: 17 }, (_, frame) => {
      const time = frame / 16;
      const swing = Math.cos(time * 2 * Math.PI);
      const lift = Math.sin(time * 2 * Math.PI);
      const stride = speed * .6;
      return [time, pose({
        Chest: [.15 + .24 * speed, swing * .1, lift * .065],
        Head: [-.11, swing * -.075, lift * -.04],
        ThighL: [-swing * stride, 0, -.04], ThighR: [swing * stride, 0, .04],
        ShinL: [Math.max(0, -lift) * speed * .95, 0, 0],
        ShinR: [Math.max(0, lift) * speed * .95, 0, 0],
        FootL: [swing * .23, 0, 0], FootR: [-swing * .23, 0, 0],
        UpperArmL: [(infected ? -.53 : -.18) + swing * .35 * speed, 0, -.19],
        UpperArmR: [(infected ? -.59 : -.18) - swing * .38 * speed, 0, .18],
        ForearmL: [-.38 - speed * .42, 0, 0], ForearmR: [-.51 - speed * .39, 0, 0],
      }, -.014 + Math.abs(swing) * .045 * speed)];
    }));
  }

  return [
    clip('idle', 2.3, [
      [0, pose()],
      [.29, pose({ Chest: [.11, .05, -.035], Head: [-.06, .20, -.09] }, .012)],
      [.60, pose({ Chest: [.24, -.06, .03], Head: [-.11, -.16, .055] }, -.012)],
      [1, pose()],
    ]),
    gait('walk', 1.14, .55),
    gait('run', .67, 1),
    clip('attack', .53, [
      [0, pose()],
      [.36, pose({ Chest: [-.16, -.28, -.16], Head: [.12, .22, .12], UpperArmR: [.55, .25, .50], ForearmR: [-1.48, 0, 0], UpperArmL: [-.64, -.15, -.3] }, -.05)],
      [.64, pose({ Chest: [.55, .38, .12], UpperArmR: [-1.71, -.20, -.31], ForearmR: [-.16, 0, 0], UpperArmL: [-.88, .08, -.12] }, -.032, .11)],
      [1, pose({ Chest: [.29, .11, .05], UpperArmR: [-.82, 0, .11], UpperArmL: [-.45, 0, -.14] })],
    ]),
    clip('impact', .38, [
      [0, pose()],
      [.22, pose({ Chest: [-.57, -.31, .24], Head: [-.48, .2, -.11], UpperArmL: [.16, 0, -.60], UpperArmR: [-.3, 0, .51] }, -.06, -.085)],
      [.57, pose({ Chest: [.11, .17, -.13], Head: [.2, -.16, .16], UpperArmL: [-.34, 0, -.23] }, -.045, -.02)],
      [1, pose()],
    ]),
    clip('death', .75, [
      [0, pose()],
      [.32, pose({ Hips: [-.29, 0, .11], Chest: [-.56, -.18, .12], Head: [-.4, 0, .09], ThighL: [-.66, 0, 0], ThighR: [-.48, 0, 0], ShinL: [.62, 0, 0], ShinR: [.71, 0, 0], UpperArmL: [-.35, 0, -.65], UpperArmR: [.3, 0, .55] }, -.30, -.1)],
      [.76, pose({ Hips: [-1.44, 0, .08], Chest: [-.15, 0, .02], Head: [.22, -.1, -.25], UpperArmL: [.01, 0, -.96], UpperArmR: [.06, 0, .90], ThighL: [-.24, 0, -.12], ThighR: [.08, 0, .12] }, -.70, -.28)],
      [1, pose({ Hips: [-1.52, 0, .05], Chest: [-.09, 0, .01], Head: [.25, -.15, -.20], UpperArmL: [.04, 0, -.91], UpperArmR: [.01, 0, .87], ForearmL: [-.07, 0, 0], ForearmR: [-.07, 0, 0], ThighL: [-.09, 0, -.15], ThighR: [-.06, 0, .14], ShinL: [.13, 0, 0], ShinR: [.10, 0, 0] }, -.72, -.31)],
    ]),
  ];
}

await mkdir(OUTPUT, { recursive: true });
for (const variant of variants) {
  const bones = createRig();
  const root = new THREE.Group();
  root.name = variant.name;
  root.userData = { origin: 'Modelo y animaciones originales de Z3R0-FRECUENCY' };
  root.scale.setScalar(variant.height / 1.77);
  root.add(makeSkin(bones, variant));
  const glb = await new GLTFExporter().parseAsync(root, {
    binary: true, animations: createAnimations(bones, variant),
  });
  await writeFile(new URL(variant.file, OUTPUT), new Uint8Array(glb));
}
