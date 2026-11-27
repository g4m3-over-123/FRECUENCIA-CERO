import * as THREE from 'three';

/**
 * Manages the Three.js WebGLRenderer, scene, camera, lighting, and resize lifecycle.
 */
export class SceneManager {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  private animationFrameId: number | null = null;
  private onResizeBound: () => void;

  constructor(private readonly container: HTMLElement) {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0f17);

    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;

    this.camera = new THREE.PerspectiveCamera(48, width / height, 0.1, 200);
    // Inclined top-down (cenital) camera angle
    this.camera.position.set(0, 18, 14);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.container.appendChild(this.renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0xd8e4ff, 0.85);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.9);
    directionalLight.position.set(10, 20, 10);
    this.scene.add(directionalLight);

    const gridHelper = new THREE.GridHelper(20, 10, 0x38bdf8, 0x1e293b);
    this.scene.add(gridHelper);

    const placeholderGeometry = new THREE.BoxGeometry(1.2, 1.2, 1.2);
    const placeholderMaterial = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      roughness: 0.35,
      metalness: 0.2,
    });
    const placeholderCube = new THREE.Mesh(placeholderGeometry, placeholderMaterial);
    placeholderCube.position.set(0, 0.6, 0);
    placeholderCube.name = 'placeholder-cube';
    this.scene.add(placeholderCube);

    this.onResizeBound = this.handleResize.bind(this);
    window.addEventListener('resize', this.onResizeBound);
  }

  start(): void {
    const animate = () => {
      this.animationFrameId = window.requestAnimationFrame(animate);
      const cube = this.scene.getObjectByName('placeholder-cube');
      if (cube) {
        cube.rotation.y += 0.008;
      }
      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  dispose(): void {
    if (this.animationFrameId !== null) {
      window.cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    window.removeEventListener('resize', this.onResizeBound);
    this.renderer.dispose();
  }

  private handleResize(): void {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }
}
