import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const NIGHT_SKY_COLOR = 0x0b1220;
const FPV_FOG_DENSITY = 0.018;
const EYE_HEIGHT_STANDING = 1.65;
const EYE_HEIGHT_CROUCHING = 1.05;
const CROUCH_SMOOTH_SPEED = 10;
const PREVIEW_WALK_SPEED = 3.8;
const PREVIEW_CROUCH_SPEED = 2.0;
const DEFAULT_STREET_ASSET_URL = '/assets/props/street.glb';

export interface SceneManagerOptions {
  /**
   * Loads street.glb centered on the origin for a standalone preview (default true).
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

  constructor(
    private readonly container: HTMLElement,
    options: SceneManagerOptions = {}
  ) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(NIGHT_SKY_COLOR);
    this.scene.fog = new THREE.FogExp2(NIGHT_SKY_COLOR, FPV_FOG_DENSITY);

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    this.camera = new THREE.PerspectiveCamera(72, width / height, 0.1, 180);
    this.camera.position.set(0, EYE_HEIGHT_STANDING, 8);
    this.camera.lookAt(0, EYE_HEIGHT_STANDING - 0.1, 0);
    // Add camera to scene so child lights (flashlight) affect world geometry
    this.scene.add(this.camera);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);

    this.controls = new PointerLockControls(this.camera, this.renderer.domElement);

    // Camera-mounted tactical flashlight (OFF by default; toggle with F)
    this.flashlight = new THREE.SpotLight(0xfff1d6, 32, 34, Math.PI / 5.5, 0.5, 1.6);
    this.flashlight.position.set(0.18, -0.15, -0.05);
    this.flashlight.visible = false;
    this.flashlight.castShadow = true;
    this.flashlight.shadow.mapSize.set(1024, 1024);
    this.flashlight.shadow.camera.near = 0.25;
    this.flashlight.shadow.camera.far = 34;
    this.flashlight.shadow.bias = -0.0004;
    this.flashlight.shadow.normalBias = 0.02;

    const flashlightTarget = new THREE.Object3D();
    flashlightTarget.position.set(0, -0.1, -12);
    this.camera.add(flashlightTarget);
    this.flashlight.target = flashlightTarget;
    this.camera.add(this.flashlight);

    // Clear nocturnal ambience with moonlight and soft bounce
    const hemisphereLight = new THREE.HemisphereLight(0x789cd6, 0x243044, 0.95);
    this.scene.add(hemisphereLight);

    this.moonLight = new THREE.DirectionalLight(0xb5d0ff, 1.3);
    this.moonLight.position.set(24, 42, 18);
    this.moonLight.castShadow = true;
    this.moonLight.shadow.mapSize.set(2048, 2048);
    this.moonLight.shadow.camera.near = 1;
    this.moonLight.shadow.camera.far = 140;
    const shadowHalfExtent = 48;
    this.moonLight.shadow.camera.left = -shadowHalfExtent;
    this.moonLight.shadow.camera.right = shadowHalfExtent;
    this.moonLight.shadow.camera.top = shadowHalfExtent;
    this.moonLight.shadow.camera.bottom = -shadowHalfExtent;
    this.moonLight.shadow.bias = -0.0005;
    this.moonLight.shadow.normalBias = 0.03;
    this.scene.add(this.moonLight);

    this.setupBaseGround();

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

    this.clock.start();

    const animate = () => {
      this.animationFrameId = window.requestAnimationFrame(animate);
      const dt = Math.min(this.clock.getDelta(), 0.1);

      if (onUpdate) {
        onUpdate(dt);
      } else if (this.previewWalkEnabled) {
        this.stepPreviewWalk(dt);
      }

      this.renderer.render(this.scene, this.camera);
    };

    animate();
  }

  /**
   * Updates Mara's FPV camera world position and smoothly interpolates eye height
   * between standing (1.65m) and crouching (1.05m).
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
    ground.position.y = -0.02;
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
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }
}
