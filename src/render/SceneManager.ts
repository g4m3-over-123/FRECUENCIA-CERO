import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { CityBuilder } from './CityBuilder.ts';

const NIGHT_SKY_COLOR = 0x090f1c;
const FPV_FOG_DENSITY = 0.037;
const FILL_SCALE = 0.165;
const MOON_SCALE = 0.28;
const FOG_SCALE = 2.5;
const SKY_SCALE = 0.58;
const EYE_HEIGHT_STANDING = 1.58;
const EYE_HEIGHT_CROUCHING = 1.0;
const CROUCH_SMOOTH_SPEED = 10;
const PREVIEW_WALK_SPEED = 3.8;
const PREVIEW_CROUCH_SPEED = 2.0;
const DEFAULT_STREET_ASSET_URL = `${import.meta.env.BASE_URL}assets/props/street_enhanced.glb`;

function createNightEnvironment(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
  const environment = new THREE.Scene();
  environment.background = new THREE.Color(0x080e1c);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const panels = [
    { position: [-5, 7, 1], size: [12, 5], color: 0x779dcd, intensity: 0.75 },
    { position: [7, 3, -5], size: [3, 5], color: 0xffad71, intensity: 0.52 },
  ];
  for (const { position, size, color, intensity } of panels) {
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).multiplyScalar(intensity),
    });
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(size[0], size[1]), material);
    panel.position.set(position[0], position[1], position[2]);
    panel.lookAt(0, 0, 0);
    environment.add(panel);
  }
  const target = pmrem.fromScene(environment, 0.032, 0.1, 32);
  for (const panel of environment.children as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[]) {
    panel.geometry.dispose();
    panel.material.dispose();
  }
  pmrem.dispose();
  return target;
}

function createRain() {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(1600 * 3);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = Math.random() * 26;
    positions[i + 1] = Math.random() * 10;
    positions[i + 2] = Math.random() * 26;
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const size = 32;
  const streak = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const height = y / (size - 1);
    const fade = Math.sin(Math.PI * height) ** 1.6 * (0.35 + 0.65 * height);
    const center = size / 2 + (height - 0.5) * 5;
    for (let x = 0; x < size; x++) {
      const alpha = Math.exp(-((x - center) ** 2) / 1.25) * fade;
      streak.set([255, 255, 255, Math.round(255 * alpha)], (y * size + x) * 4);
    }
  }
  const map = new THREE.DataTexture(streak, size, size);
  map.magFilter = map.minFilter = THREE.LinearFilter;
  map.needsUpdate = true;
  const material = new THREE.PointsMaterial({
    color: 0xb7d4f5, map, size: 0.24, opacity: 0.55,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const time = { value: 0 };
  const center = { value: new THREE.Vector3() };
  const direction = { value: new THREE.Vector3() };
  const flashlight = { value: 0 };
  material.onBeforeCompile = shader => {
    shader.uniforms.rainTime = time;
    shader.uniforms.rainCenter = center;
    shader.uniforms.rainDirection = direction;
    shader.uniforms.rainFlashlight = flashlight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `
        #include <common>
        uniform float rainTime;
        uniform vec3 rainCenter;
        uniform vec3 rainDirection;
        uniform float rainFlashlight;
        varying float vRainBrightness;
      `)
      .replace('#include <begin_vertex>', `
        #include <begin_vertex>
        float speed = mix(9.0, 14.0, fract(position.z * 1.9 + position.x * 0.71));
        transformed.xz = mod(position.xz + vec2(1.3, -0.75) * rainTime - rainCenter.xz, 26.0)
          - 13.0 + rainCenter.xz;
        transformed.y = mod(position.y - speed * rainTime, 10.0) + 0.12;
        vec3 ray = transformed - rainCenter;
        float distanceToEye = max(length(ray), 0.001);
        float lit = smoothstep(0.88, 0.975, dot(ray / distanceToEye, rainDirection));
        lit *= (1.0 - smoothstep(6.0, 20.0, distanceToEye)) * rainFlashlight;
        vRainBrightness = (0.32 + 1.4 * lit) * smoothstep(0.55, 1.5, distanceToEye);
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vRainBrightness;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= vRainBrightness;');
  };
  const drops = new THREE.Points(geometry, material);
  drops.name = 'night-rain';
  drops.frustumCulled = false;
  return { drops, map, time, center, direction, flashlight };
}

/** Horizontal field of view kept on wide screens; a wider one stretches the screen edges. */
const HORIZONTAL_FOV_DEG = 78;
const VERTICAL_FOV_RANGE_DEG: [number, number] = [48, 62];
/** Longest frame step; above it (tab switch, debugger) the game slows down instead of jumping. */
const MAX_FRAME_DT = 0.25;
/** WebGL running on the CPU: the browser has no hardware acceleration. */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|microsoft basic render/i;

export type GraphicsQuality = 'high' | 'low';

export interface SceneManagerOptions {
  /**
   * Loads street_enhanced.glb centered on the origin for a standalone preview (default true).
   * The game passes false: WorldBuilder places the asset aligned with the map grid.
   */
  autoloadStreetPreview?: boolean;
}

/**
 * Manages the Three.js WebGLRenderer, nocturnal atmosphere, pure First-Person (FPV)
 * PointerLockControls camera, camera-mounted flashlight, and resize lifecycle.
 */
export class SceneManager {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: PointerLockControls;
  readonly flashlight: THREE.SpotLight;

  private readonly clock = new THREE.Clock();
  private readonly environment: THREE.WebGLRenderTarget;
  private readonly city: CityBuilder;
  private readonly rain = createRain();
  private readonly flashlightBeam: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  private readonly fog: THREE.FogExp2;
  private readonly fill: THREE.HemisphereLight;
  private readonly moonLight: THREE.DirectionalLight;
  private readonly forwardDir = new THREE.Vector3();
  private readonly rightDir = new THREE.Vector3();
  private readonly moveDelta = new THREE.Vector3();
  private readonly pressedKeys = new Set<string>();

  private currentEyeHeight = EYE_HEIGHT_STANDING;
  private previewWalkEnabled = true;
  private animationFrameId: number | null = null;
  private previewGroup: THREE.Group | null = null;

  private readonly onResizeBound: () => void;
  private readonly onCanvasClickBound: () => void;
  private readonly onKeyDownBound: (event: KeyboardEvent) => void;
  private readonly onKeyUpBound: (event: KeyboardEvent) => void;
  private readonly onPointerLockChangeBound: () => void;

  /** 'low' when the browser renders WebGL in software (see detectSoftwareRenderer). */
  readonly quality: GraphicsQuality;
  readonly rendererName: string;
  private composer: EffectComposer | null = null;

  constructor(
    private readonly container: HTMLElement,
    options: SceneManagerOptions = {}
  ) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(NIGHT_SKY_COLOR);
    this.fog = new THREE.FogExp2(NIGHT_SKY_COLOR, FPV_FOG_DENSITY);
    this.scene.fog = this.fog;

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    this.camera = new THREE.PerspectiveCamera(fovForAspect(width / height), width / height, 0.1, 180);
    this.camera.position.set(0, EYE_HEIGHT_STANDING, 8);
    this.camera.lookAt(0, EYE_HEIGHT_STANDING - 0.1, 0);
    // Add camera to scene so child lights (flashlight) affect world geometry
    this.scene.add(this.camera);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    this.renderer.setSize(width, height);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.20;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);

    this.rendererName = readRendererName(this.renderer);
    this.quality = SOFTWARE_RENDERER.test(this.rendererName) ? 'low' : 'high';
    if (this.quality === 'low') {
      // Software WebGL manages a few frames per second at full quality.
      this.renderer.setPixelRatio(0.4);
      this.renderer.shadowMap.enabled = false;
      this.showSoftwareRenderingWarning();
    }
    this.environment = createNightEnvironment(this.renderer);
    this.scene.environment = this.environment.texture;
    this.scene.environmentIntensity = 0.35;

    this.city = new CityBuilder(this.renderer, this.scene);
    this.scene.add(this.rain.drops);

    this.controls = new PointerLockControls(this.camera, this.renderer.domElement);

    // Camera-mounted tactical flashlight (OFF by default; toggle with F)
    this.flashlight = new THREE.SpotLight(0xfff0d9, 86, 36, Math.PI / 6.5, 0.55, 1.6);
    this.flashlight.position.set(-0.23, 0.10, -0.09);
    this.flashlight.visible = false;
    this.flashlight.castShadow = true;
    this.flashlight.shadow.mapSize.set(768, 768);
    this.flashlight.shadow.camera.near = 0.25;
    this.flashlight.shadow.camera.far = 36;
    this.flashlight.shadow.bias = -0.0004;
    this.flashlight.shadow.normalBias = 0.02;

    const flashlightTarget = new THREE.Object3D();
    flashlightTarget.position.set(0, -0.1, -12);
    this.camera.add(flashlightTarget);
    this.flashlight.target = flashlightTarget;
    this.camera.add(this.flashlight);
    const endOfBeam = flashlightTarget.position.clone().sub(this.flashlight.position)
      .normalize().multiplyScalar(7.5).add(this.flashlight.position);
    this.flashlightBeam = this.city.makeBeam(this.flashlight.position, endOfBeam, 3.05, 0xffe4ba, 0.035);
    this.flashlightBeam.visible = false;
    this.camera.add(this.flashlightBeam);

    this.fill = new THREE.HemisphereLight(0x6894cb, 0x19263f, 0.18);
    this.fill.name = 'scene-hemisphere-light';
    this.scene.add(this.fill);

    this.moonLight = new THREE.DirectionalLight(0xb5d0ff, 0.37);
    this.moonLight.name = 'scene-moon-light';
    this.moonLight.position.set(24, 42, 18);
    this.moonLight.castShadow = true;
    this.moonLight.shadow.autoUpdate = false;
    this.moonLight.shadow.needsUpdate = true;
    const moonShadowSize = this.quality === 'high' ? 4096 : 1024;
    this.moonLight.shadow.mapSize.set(moonShadowSize, moonShadowSize);
    this.moonLight.shadow.camera.near = 1;
    this.moonLight.shadow.camera.far = 115;
    this.moonLight.shadow.camera.left = -38;
    this.moonLight.shadow.camera.right = 38;
    this.moonLight.shadow.camera.top = 28;
    this.moonLight.shadow.camera.bottom = -28;
    this.moonLight.shadow.camera.updateProjectionMatrix();
    this.moonLight.shadow.bias = -0.0005;
    this.moonLight.shadow.normalBias = 0.03;
    this.scene.add(this.moonLight);

    this.setupBaseGround();
    if (this.quality === 'high') this.setupPostProcessing(width, height);

    this.onResizeBound = this.handleResize.bind(this);
    this.onCanvasClickBound = this.handleCanvasClick.bind(this);
    this.onKeyDownBound = this.handleKeyDown.bind(this);
    this.onKeyUpBound = this.handleKeyUp.bind(this);
    this.onPointerLockChangeBound = this.handlePointerLockChange.bind(this);

    window.addEventListener('resize', this.onResizeBound);
    this.renderer.domElement.addEventListener('click', this.onCanvasClickBound);
    window.addEventListener('keydown', this.onKeyDownBound);
    window.addEventListener('keyup', this.onKeyUpBound);
    document.addEventListener('pointerlockchange', this.onPointerLockChangeBound);

    if (options.autoloadStreetPreview !== false) {
      void this.loadStreetPreview(DEFAULT_STREET_ASSET_URL);
    }
  }

  start(onUpdate?: (dt: number) => void): void {
    if (this.animationFrameId !== null) {
      return;
    }

    const world = this.scene.getObjectByName('world');
    if (world) this.city.apply(world);
    this.clock.start();
    this.sharpenTextures();
    if (this.quality === 'low') this.dropPointLights();

    let moonShadowAge = 0;
    const animate = () => {
      this.animationFrameId = window.requestAnimationFrame(animate);
      const dt = Math.min(this.clock.getDelta(), MAX_FRAME_DT);

      if (onUpdate) {
        this.updateNightPreset(onUpdate, dt);
      } else if (this.previewWalkEnabled) {
        this.stepPreviewWalk(dt);
      }

      // The fixed moon needs periodic refreshes only for moving shadow casters.
      moonShadowAge += dt;
      if (moonShadowAge >= 1 / 15) {
        this.moonLight.shadow.needsUpdate = true;
        moonShadowAge = 0;
      }
      this.rain.time.value += dt;
      this.camera.getWorldPosition(this.rain.center.value);
      this.camera.getWorldDirection(this.rain.direction.value);
      this.rain.flashlight.value = this.flashlight.visible ? 1 : 0;
      this.flashlightBeam.visible = this.flashlight.visible;
      this.city.update(dt);
      if (this.composer) this.composer.render(dt);
      else this.renderer.render(this.scene, this.camera);
    };

    animate();
  }

  private updateNightPreset(update: (dt: number) => void, dt: number): void {
    // WorldStateView blends the mission presets. Scale the result for rendering.
    const sky = this.scene.background;
    if (sky instanceof THREE.Color) sky.multiplyScalar(1 / SKY_SCALE);
    this.fog.color.multiplyScalar(1 / SKY_SCALE);
    this.fog.density /= FOG_SCALE;
    this.fill.intensity /= FILL_SCALE;
    this.moonLight.intensity /= MOON_SCALE;
    update(dt);
    if (sky instanceof THREE.Color) sky.multiplyScalar(SKY_SCALE);
    this.fog.color.multiplyScalar(SKY_SCALE);
    this.fog.density *= FOG_SCALE;
    this.fill.intensity *= FILL_SCALE;
    this.moonLight.intensity *= MOON_SCALE;
  }

  /**
   * Updates Mara's FPV camera world position and smoothly interpolates eye height
   * between standing (1.58m) and crouching (1.0m).
   */
  setPlayerPose(x: number, z: number, isCrouching: boolean, dt: number): void {
    const targetHeight = isCrouching ? EYE_HEIGHT_CROUCHING : EYE_HEIGHT_STANDING;
    const alpha = 1 - Math.exp(-CROUCH_SMOOTH_SPEED * Math.max(dt, 0));
    this.currentEyeHeight = THREE.MathUtils.lerp(this.currentEyeHeight, targetHeight, alpha);
    this.camera.position.set(x, this.currentEyeHeight, z);
  }

  /**
   * Returns horizontal camera yaw in radians (Three.js convention: 0 looks along -Z,
   * forward vector is (-sin(yaw), 0, -cos(yaw))).
   */
  getCameraYaw(): number {
    this.camera.getWorldDirection(this.forwardDir);
    return Math.atan2(-this.forwardDir.x, -this.forwardDir.z);
  }

  /**
   * Writes the normalized horizontal forward direction (XZ plane) into `out`.
   */
  getForwardVector(out = new THREE.Vector3()): THREE.Vector3 {
    const yaw = this.getCameraYaw();
    return out.set(-Math.sin(yaw), 0, -Math.cos(yaw)).normalize();
  }

  isPointerLocked(): boolean {
    return this.controls.isLocked;
  }

  lockPointer(): void {
    if (!this.controls.isLocked) {
      this.controls.lock();
    }
  }

  unlockPointer(): void {
    if (this.controls.isLocked) {
      this.controls.unlock();
    }
  }

  setFlashlightEnabled(enabled: boolean): void {
    this.flashlight.visible = enabled;
  }

  toggleFlashlight(): boolean {
    this.flashlight.visible = !this.flashlight.visible;
    console.info(`[SceneManager] Flashlight: ${this.flashlight.visible ? 'ON' : 'OFF'}`);
    return this.flashlight.visible;
  }

  isFlashlightEnabled(): boolean {
    return this.flashlight.visible;
  }

  setPreviewWalkEnabled(enabled: boolean): void {
    this.previewWalkEnabled = enabled;
    if (!enabled) {
      this.pressedKeys.clear();
    }
  }

  clearStreetPreview(): void {
    if (!this.previewGroup) {
      return;
    }

    this.city.clear();
    this.scene.remove(this.previewGroup);
    this.previewGroup.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of materials) {
          mat.dispose();
        }
      }
    });
    this.previewGroup = null;
  }

  dispose(): void {
    if (this.animationFrameId !== null) {
      window.cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    this.clearStreetPreview();
    this.controls.dispose();
    window.removeEventListener('resize', this.onResizeBound);
    this.renderer.domElement.removeEventListener('click', this.onCanvasClickBound);
    window.removeEventListener('keydown', this.onKeyDownBound);
    window.removeEventListener('keyup', this.onKeyUpBound);
    document.removeEventListener('pointerlockchange', this.onPointerLockChangeBound);
    this.flashlightBeam.material.dispose();
    this.city.dispose();
    this.rain.drops.geometry.dispose();
    this.rain.drops.material.dispose();
    this.rain.map.dispose();
    this.scene.environment = null;
    this.environment.dispose();
    if (this.composer) {
      for (const pass of this.composer.passes) pass.dispose();
      this.composer.dispose();
    }
    this.renderer.dispose();
  }

  private setupBaseGround(): void {
    const groundGeometry = new THREE.PlaneGeometry(240, 240);
    const groundMaterial = new THREE.MeshStandardMaterial({
      color: 0x0f1520,
      roughness: 0.92,
      metalness: 0.05,
    });
    const ground = new THREE.Mesh(groundGeometry, groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    // Filler beyond the map, kept well under the street mesh so it never hides the road.
    ground.position.y = -0.3;
    ground.castShadow = true;
    ground.receiveShadow = true;
    ground.name = 'base-night-ground';
    this.scene.add(ground);
  }

  private async loadStreetPreview(assetUrl: string): Promise<void> {
    this.clearStreetPreview();

    const loader = new GLTFLoader();
    try {
      const gltf = await loader.loadAsync(assetUrl);
      const root = gltf.scene;
      root.updateMatrixWorld(true);

      const overallBox = new THREE.Box3().setFromObject(root);
      const overallCenter = new THREE.Vector3();
      overallBox.getCenter(overallCenter);

      // Center on XZ and rest lowest point on Y = 0; aerial cables stay visible in FPV
      root.position.set(-overallCenter.x, -overallBox.min.y, -overallCenter.z);
      root.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.castShadow = true;
          obj.receiveShadow = true;
        }
      });

      const group = new THREE.Group();
      group.name = 'street-fpv-preview';
      group.add(root);
      this.addPreviewStreetLights(group);
      this.scene.add(group);
      this.previewGroup = group;
      this.city.apply(group);
      this.moonLight.shadow.needsUpdate = true;

      console.info(`[SceneManager] FPV preview loaded: ${assetUrl}`);
    } catch (error) {
      console.warn(
        `[SceneManager] Could not load ${assetUrl}; using fallback street corridor.`,
        error
      );
      this.createFallbackCorridor();
    }
  }

  private addPreviewStreetLights(parent: THREE.Group): void {
    // Warm amber streetlamps and cool intersection fill for clear nocturnal visibility
    const lamps: Array<{ pos: [number, number, number]; color: number; intensity: number; distance: number }> = [
      { pos: [-1.5, 4.4, 5.5], color: 0xffb86b, intensity: 18, distance: 20 },
      { pos: [1.5, 4.4, -1.0], color: 0xffb86b, intensity: 20, distance: 22 },
      { pos: [-1.5, 4.4, -7.5], color: 0xffa952, intensity: 18, distance: 20 },
      { pos: [5.5, 4.2, 2.5], color: 0x7dd3fc, intensity: 12, distance: 18 },
    ];

    for (const lamp of lamps) {
      const pointLight = new THREE.PointLight(lamp.color, lamp.intensity, lamp.distance, 1.5);
      pointLight.position.set(lamp.pos[0], lamp.pos[1], lamp.pos[2]);
      parent.add(pointLight);
    }
  }

  private createFallbackCorridor(): void {
    const group = new THREE.Group();
    group.name = 'street-fpv-fallback';

    const wallMat = new THREE.MeshStandardMaterial({
      color: 0x263144,
      roughness: 0.85,
      metalness: 0.1,
    });

    const positions: Array<[number, number, number, number, number, number]> = [
      [-6, 3, 0, 4, 6, 16],
      [6, 3, 0, 4, 6, 16],
      [0, 1.5, -10, 8, 3, 2],
    ];

    for (const [x, y, z, w, h, d] of positions) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }

    this.scene.add(group);
    this.previewGroup = group;
    this.city.apply(group);
    this.moonLight.shadow.needsUpdate = true;
  }

  private stepPreviewWalk(dt: number): void {
    const isCrouching =
      this.pressedKeys.has('ControlLeft') ||
      this.pressedKeys.has('ControlRight') ||
      this.pressedKeys.has('KeyC');

    let forwardInput = 0;
    let strafeInput = 0;

    if (this.pressedKeys.has('KeyW') || this.pressedKeys.has('ArrowUp')) {
      forwardInput += 1;
    }
    if (this.pressedKeys.has('KeyS') || this.pressedKeys.has('ArrowDown')) {
      forwardInput -= 1;
    }
    if (this.pressedKeys.has('KeyD') || this.pressedKeys.has('ArrowRight')) {
      strafeInput += 1;
    }
    if (this.pressedKeys.has('KeyA') || this.pressedKeys.has('ArrowLeft')) {
      strafeInput -= 1;
    }

    let nextX = this.camera.position.x;
    let nextZ = this.camera.position.z;

    if (forwardInput !== 0 || strafeInput !== 0) {
      this.getForwardVector(this.forwardDir);
      this.rightDir.set(-this.forwardDir.z, 0, this.forwardDir.x);

      this.moveDelta
        .set(0, 0, 0)
        .addScaledVector(this.forwardDir, forwardInput)
        .addScaledVector(this.rightDir, strafeInput)
        .normalize();

      const speed = isCrouching ? PREVIEW_CROUCH_SPEED : PREVIEW_WALK_SPEED;
      nextX += this.moveDelta.x * speed * dt;
      nextZ += this.moveDelta.z * speed * dt;
    }

    this.setPlayerPose(nextX, nextZ, isCrouching, dt);
  }

  private handleCanvasClick(): void {
    this.lockPointer();
  }

  private handlePointerLockChange(): void {
    const locked = document.pointerLockElement === this.renderer.domElement;
    if (!locked) {
      this.pressedKeys.clear();
    }
    console.info(
      `[SceneManager] Pointer lock: ${locked ? 'LOCKED (FPV mouse look active)' : 'UNLOCKED (HUD clickable)'}`
    );
  }

  private handleKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
    ) {
      return;
    }

    this.pressedKeys.add(event.code);

    if (!event.repeat && event.code === 'KeyF') {
      this.toggleFlashlight();
    }
  }

  private handleKeyUp(event: KeyboardEvent): void {
    this.pressedKeys.delete(event.code);
  }

  private handleResize(): void {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.fov = fovForAspect(this.camera.aspect);
    this.camera.updateProjectionMatrix();
    const pixelRatio = this.quality === 'low' ? 0.4 : Math.min(window.devicePixelRatio, 1.25);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height);
    this.composer?.setPixelRatio(pixelRatio);
    this.composer?.setSize(width, height);
  }

  /**
   * Ambient occlusion darkens wall bases, corners and the ground under props; a light bloom
   * lets lamps and glowing signs bleed into the fog. OutputPass applies tone mapping.
   */
  private setupPostProcessing(width: number, height: number): void {
    const target = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, samples: 4 });
    const composer = new EffectComposer(this.renderer, target);
    composer.addPass(new RenderPass(this.scene, this.camera));
    const ao = new GTAOPass(this.scene, this.camera, width, height);
    ao.updateGtaoMaterial({ radius: 0.7, distanceExponent: 1.4, thickness: 1.5, scale: 1.1, samples: 16 });
    ao.blendIntensity = 0.85;
    composer.addPass(ao);
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(width, height), 0.55, 0.40, 0.72));
    composer.addPass(new OutputPass());
    this.composer = composer;
  }

  /**
   * Software WebGL shades every point light per pixel on the CPU; the lamps go and the
   * ambient light rises so the street stays readable.
   */
  private dropPointLights(): void {
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.PointLight) obj.visible = false;
      if (obj instanceof THREE.HemisphereLight) obj.intensity *= 1.8;
    });
  }

  /** Full anisotropic filtering: ground and walls stay sharp at grazing angles. */
  private sharpenTextures(): void {
    const anisotropy = this.quality === 'high' ? this.renderer.capabilities.getMaxAnisotropy() : 1;
    this.scene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      for (const material of Array.isArray(obj.material) ? obj.material : [obj.material]) {
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture && value.anisotropy !== anisotropy) {
            value.anisotropy = anisotropy;
            value.needsUpdate = true;
          }
        }
      }
    });
  }

  private showSoftwareRenderingWarning(): void {
    const note = document.createElement('div');
    note.className = 'software-render-warning';
    note.style.cssText =
      'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:50;max-width:640px;' +
      'padding:10px 14px;border-radius:8px;background:rgba(120,20,20,.92);color:#fff;' +
      'font:13px/1.45 system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.4)';
    note.innerHTML =
      '<b>El navegador no usa la tarjeta grafica</b> (WebGL por software: ' + this.rendererName.replace(/[<>&]/g, '') + '). ' +
      'El juego ira muy lento. En Chrome abre <code>chrome://settings/system</code> y activa la aceleracion por hardware; ' +
      'si sigue igual, en <code>chrome://flags/#use-angle</code> elige <b>OpenGL</b> y reinicia. ' +
      'Comprueba el resultado en <code>chrome://gpu</code>. ' +
      '<button style="margin-left:6px;cursor:pointer">Cerrar</button>';
    note.querySelector('button')!.addEventListener('click', () => note.remove());
    document.body.appendChild(note);
    console.warn(`[SceneManager] Software WebGL renderer: ${this.rendererName}. Low quality mode.`);
  }
}

function fovForAspect(aspect: number): number {
  const half = THREE.MathUtils.degToRad(HORIZONTAL_FOV_DEG / 2);
  const vertical = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(half) / aspect));
  return THREE.MathUtils.clamp(vertical, VERTICAL_FOV_RANGE_DEG[0], VERTICAL_FOV_RANGE_DEG[1]);
}

function readRendererName(renderer: THREE.WebGLRenderer): string {
  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  return String(info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
}
