import * as THREE from 'three';
import type { GridCoord, MapDefinition } from '../../core/contracts.ts';
import type { ExtendedWorldSnapshot } from '../../core/gameplay/SimulationEngine.ts';
import { gridToWorld } from '../../core/world/gridSpace.ts';
import { barricadeModel, decoyModel, pickupModel } from './props.ts';

function night(sky: number, density: number, upper: number, ground: number, moon: number, fill: number, key: number) {
  return { sky: new THREE.Color(sky), density, upper: new THREE.Color(upper), ground: new THREE.Color(ground),
    moon: new THREE.Color(moon), fill, key };
}

const nights = {
  1: night(0x17253a, 0.014, 0xb0cbef, 0x505967, 0xc6deff, 1.22, 1.55),
  2: night(0x112936, 0.017, 0x9acbdb, 0x405460, 0xaadbec, 1.18, 1.45),
  3: night(0x302627, 0.019, 0xccc1ba, 0x624c42, 0xffc69b, 1.10, 1.35),
  4: night(0x10192c, 0.016, 0x96afcf, 0x49404a, 0xb6c6f1, 1.02, 1.30),
  5: night(0x1a2333, 0.013, 0xb4c2df, 0x4a5062, 0xd3e6ff, 1.28, 1.65),
};
const closed = new THREE.Color(0xff3b3b);
const open = new THREE.Color(0x22c55e);
const radioBlue = new THREE.Color(0x65bfff);
const radioAmber = new THREE.Color(0xffa64d);
type Indicator = THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

export class WorldStateView {
  private readonly group = new THREE.Group();
  private readonly pickups = new Map<string, THREE.Group>();
  private readonly barricades = new Map<string, THREE.Group>();
  private readonly decoys = new Map<string, THREE.Group>();
  private readonly wanted = new Set<string>();
  private readonly collidables: THREE.Object3D[] = [];
  private readonly soundRings: THREE.Object3D[] = [];
  private readonly pickupTemplates = { medicine: pickupModel('medicine'), fuel: pickupModel('fuel'), battery: pickupModel('battery') };
  private readonly decoyTemplate = decoyModel();
  private readonly barricadeTemplate: THREE.Group;
  private readonly hemisphere?: THREE.HemisphereLight;
  private readonly moon?: THREE.DirectionalLight;
  private readonly beacon?: THREE.PointLight;
  private readonly lens?: Indicator;
  private readonly refugeLight?: THREE.PointLight;
  private readonly refugeWorkLight?: THREE.SpotLight;
  private readonly radio?: Indicator;
  private readonly radioScreen?: Indicator;
  private previous?: ExtendedWorldSnapshot;
  private time = 0;

  constructor(private readonly scene: THREE.Scene, private readonly map: MapDefinition) {
    this.group.name = 'world-state';
    scene.add(this.group);
    this.barricadeTemplate = barricadeModel(map.cellSize);
    this.hemisphere = scene.getObjectByName('scene-hemisphere-light') as THREE.HemisphereLight | undefined;
    this.moon = scene.getObjectByName('scene-moon-light') as THREE.DirectionalLight | undefined;
    this.beacon = scene.getObjectByName('zone-light-extraction') as THREE.PointLight | undefined;
    this.lens = scene.getObjectByName('extraction-lens') as Indicator | undefined;
    this.refugeLight = scene.getObjectByName('zone-light-refuge') as THREE.PointLight | undefined;
    this.refugeWorkLight = scene.getObjectByName('refuge-work-light') as THREE.SpotLight | undefined;
    this.radio = scene.getObjectByName('radio-indicator') as Indicator | undefined;
    this.radioScreen = scene.getObjectByName('radio-screen') as Indicator | undefined;
  }

  getCollidables(): THREE.Object3D[] {
    return this.collidables;
  }

  update(snapshot: ExtendedWorldSnapshot, dt: number): void {
    this.time += dt;
    if (this.previous !== snapshot) {
      const pickups = snapshot.pickups.filter(
        p => !p.collected && (this.map.id !== 'map_street' || p.kind === 'medicine')
      );
      this.sync(this.pickups, pickups, p => p.id, p => p.position, p => this.pickupTemplates[p.kind]);
      if (this.sync(this.barricades, snapshot.barricades, p => p.row + ',' + p.col, p => p, () => this.barricadeTemplate)) {
        this.collidables.length = 0;
        for (const model of this.barricades.values()) this.collidables.push(model);
      }
      if (this.sync(this.decoys, snapshot.activeDecoys, d => d.id, d => d.position, () => this.decoyTemplate)) {
        this.soundRings.length = 0;
        for (const model of this.decoys.values()) this.soundRings.push(model.getObjectByName('sound-ring')!);
      }
      this.previous = snapshot;
    }
    for (const model of this.pickups.values()) {
      model.position.y = 0.65 + 0.08 * Math.sin(this.time * 2 + model.position.x);
      model.rotation.y = this.time * 0.7;
    }
    for (const ring of this.soundRings) {
      ring.scale.setScalar(0.35 + (this.time % 1) * 0.9);
    }

    const target = nights[snapshot.sceneId];
    const alpha = 1 - Math.exp(-dt * 2);
    if (this.scene.background instanceof THREE.Color) this.scene.background.lerp(target.sky, alpha);
    const fog = this.scene.fog;
    if (fog instanceof THREE.FogExp2) {
      fog.color.lerp(target.sky, alpha);
      fog.density = THREE.MathUtils.lerp(fog.density, target.density, alpha);
    }
    if (this.hemisphere) {
      this.hemisphere.color.lerp(target.upper, alpha);
      this.hemisphere.groundColor.lerp(target.ground, alpha);
      this.hemisphere.intensity = THREE.MathUtils.lerp(this.hemisphere.intensity, target.fill, alpha);
    }
    if (this.moon) {
      this.moon.color.lerp(target.moon, alpha);
      this.moon.intensity = THREE.MathUtils.lerp(this.moon.intensity, target.key, alpha);
    }
    if (this.beacon && this.lens) {
      const act1ExitReady = this.map.id === 'map_street' && snapshot.mara.hasMedicalKit;
      const active =
        act1ExitReady ||
        snapshot.sceneId === 5 ||
        snapshot.extractionOpen ||
        snapshot.extractionTicksRemaining !== null;
      this.beacon.color.copy(active ? open : closed);
      const pulse = 0.5 + 0.5 * Math.sin(this.time * (active ? 5 : 4));
      // The lens and ground ring share this material; HDR boost drives green Bloom when active.
      this.lens.material.color.copy(this.beacon.color).multiplyScalar(active ? 1.8 + 0.8 * pulse : 1.0);
      this.beacon.distance = active ? 28 : 16;
      this.beacon.intensity = active ? 22 + 12 * pulse : 13 + 9 * pulse;
    }
    if (snapshot.radioActivated) {
      this.radio?.material.color.copy(open).multiplyScalar(1.8);
      this.radioScreen?.material.color.copy(open).multiplyScalar(1.35);
      if (this.refugeLight) this.refugeLight.intensity = 24;
      if (this.refugeWorkLight) this.refugeWorkLight.intensity = 26;
    } else if (snapshot.radioInstallProgress > 0) {
      const progress = Math.min(1, snapshot.radioInstallProgress / 100);
      const fastPulse = 0.5 + 0.5 * Math.sin(this.time * (10 + 8 * progress));
      const warmPulse = 0.5 + 0.5 * Math.sin(this.time * 6);
      this.radio?.material.color.copy(radioAmber).multiplyScalar(0.95 + 1.15 * fastPulse);
      this.radioScreen?.material.color.copy(radioAmber).multiplyScalar(0.75 + 0.65 * fastPulse);
      if (this.refugeLight) this.refugeLight.intensity = 21 + 6 * warmPulse;
      if (this.refugeWorkLight) this.refugeWorkLight.intensity = 23 + 5 * warmPulse;
    } else {
      const pulse = (1 + Math.cos(this.time * (snapshot.sceneId === 4 ? 5 : 2))) / 2;
      this.radio?.material.color.copy(radioBlue).lerp(radioAmber, pulse ** 6);
      this.radioScreen?.material.color.copy(radioBlue);
      if (this.refugeLight) this.refugeLight.intensity = 24;
      if (this.refugeWorkLight) this.refugeWorkLight.intensity = 26;
    }
  }

  private sync<T>(models: Map<string, THREE.Group>, items: readonly T[], id: (item: T) => string,
    position: (item: T) => GridCoord, template: (item: T) => THREE.Group): boolean {
    let changed = false;
    this.wanted.clear();
    for (const item of items) {
      const key = id(item);
      this.wanted.add(key);
      let model = models.get(key);
      if (!model) {
        changed = true;
        model = template(item).clone();
        models.set(key, model);
        this.group.add(model);
      }
      const p = gridToWorld(position(item), this.map);
      model.position.set(p.x, 0, p.z);
    }
    for (const [key, model] of models) {
      if (this.wanted.has(key)) continue;
      changed = true;
      this.group.remove(model);
      models.delete(key);
    }
    return changed;
  }
}
