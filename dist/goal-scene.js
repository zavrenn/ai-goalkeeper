import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KeeperRig } from './keeper-rig.js';
import { KeeperMotion } from './keeper-motion.js';

const DIRECTIONS = ['left', 'center', 'right'];
const MAX_TEXTURE_SIZE = 2048;

/**
 * Create the live goal panel. Directions use the viewer's screen coordinates.
 * The factory resolves when the skinned model is ready to react.
 */
export async function createGoalScene(container, { onReady, onError, onZoneLayout, onRendered } = {}) {
  if (!(container instanceof HTMLElement)) throw new TypeError('A goal scene container is required.');

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#14291c');
  scene.fog = new THREE.Fog('#14291c', 13, 38);
  const camera = new THREE.OrthographicCamera(-4.6, 4.6, 2.2, -2.2, .1, 100);
  camera.position.set(0, 2.8, 13);
  camera.lookAt(new THREE.Vector3(0, 1.10, -.35));

  const zoneMaterials = new Map();
  const ownedImages = new Set();
  let loadedModels = [];
  let renderer, observer, rig, modelReady = false, disposed = false;
  let motion;
  let selectedZone = null, probabilities = null;

  async function capModelTextures(models) {
    const textures = new Set();
    for (const model of models) model.traverse(object => {
      if (!object.material) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
      }
    });
    // A GLB can share one decoded image between several texture instances.
    // Replace every consumer before closing that image, and resize it once.
    const consumers = new Map();
    for (const texture of textures) {
      const image = texture.source?.data;
      if (!image) continue;
      if (!consumers.has(image)) consumers.set(image, []);
      consumers.get(image).push(texture);
    }
    const ownsOriginalImages = !THREE.Cache.enabled;
    for (const [image, imageTextures] of consumers) {
      if (ownsOriginalImages && typeof image.close === 'function') ownedImages.add(image);
      const width = image.width || image.naturalWidth;
      const height = image.height || image.naturalHeight;
      if (typeof createImageBitmap !== 'function' || !width || !height || Math.max(width, height) <= MAX_TEXTURE_SIZE) continue;
      const scale = MAX_TEXTURE_SIZE / Math.max(width, height);
      let resized;
      try {
        // glTF's decoded bitmap orientation is already established. Keep those
        // pixels and the existing texture.flipY/colorSpace settings unchanged.
        resized = await createImageBitmap(image, {
          resizeWidth: Math.max(1, Math.round(width * scale)),
          resizeHeight: Math.max(1, Math.round(height * scale)),
          resizeQuality: 'high',
          imageOrientation: 'none',
          premultiplyAlpha: 'none',
          colorSpaceConversion: 'none',
        });
      } catch {
        // Older implementations may reject resize options; the model still loads.
        continue;
      }
      if (!resized.width || !resized.height || Math.max(resized.width, resized.height) > MAX_TEXTURE_SIZE) {
        resized.close();
        continue;
      }
      ownedImages.add(resized);
      for (const texture of imageTextures) {
        texture.source.data = resized;
        texture.needsUpdate = true;
      }
      // Cached image bitmaps may belong to another loader, so leave those open.
      if (ownedImages.delete(image)) image.close();
    }
  }

  function cylinderBetween(start, end, radius, material) {
    const from = new THREE.Vector3(...start), to = new THREE.Vector3(...end);
    const vector = to.clone().sub(from);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, vector.length(), 16), material);
    mesh.position.copy(from).add(to).multiplyScalar(.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), vector.normalize());
    mesh.castShadow = true;
    scene.add(mesh);
  }

  function buildGoal() {
    const postMaterial = new THREE.MeshStandardMaterial({ color: '#f0f4e9', roughness: .47, metalness: .1 });
    const backMaterial = new THREE.MeshStandardMaterial({ color: '#728b77', roughness: .7 });
    const x = 3.66, h = 2.44, front = -.5, back = -1.7;
    cylinderBetween([-x, 0, front], [-x, h, front], .055, postMaterial);
    cylinderBetween([x, 0, front], [x, h, front], .055, postMaterial);
    cylinderBetween([-x, h, front], [x, h, front], .055, postMaterial);
    for (const sign of [-1, 1]) {
      cylinderBetween([sign * x, 0, front], [sign * x, 0, back], .022, backMaterial);
      cylinderBetween([sign * x, h, front], [sign * x, h * .87, back], .022, backMaterial);
      cylinderBetween([sign * x, h * .87, back], [sign * x, 0, back], .022, backMaterial);
    }
    const vertices = [];
    const line = (a, b) => vertices.push(...a, ...b);
    for (let sx = -x; sx <= x + .01; sx += .183) {
      line([sx, 0, back], [sx, h * .87, back]);
      line([sx, h * .87, back], [sx, h, front]);
    }
    for (let y = 0; y <= h * .87; y += .178) {
      line([-x, y, back], [x, y, back]);
      for (const sign of [-1, 1]) line([sign * x, y, back], [sign * x, y / .87, front]);
    }
    for (let z = back; z <= front; z += .18) {
      const roof = THREE.MathUtils.lerp(h * .87, h, (z - back) / (front - back));
      line([-x, roof, z], [x, roof, z]);
      for (const sign of [-1, 1]) line([sign * x, 0, z], [sign * x, roof, z]);
    }
    scene.add(new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3)),
      new THREE.LineBasicMaterial({ color: '#9bb5a0', transparent: true, opacity: .27 }),
    ));
    for (const [index, direction] of DIRECTIONS.entries()) {
      const material = new THREE.MeshBasicMaterial({
        color: '#c9f38b', transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
      });
      const zone = new THREE.Mesh(new THREE.PlaneGeometry(2.39, 2.35), material);
      zone.position.set((index - 1) * 2.44, 1.22, front - .04);
      scene.add(zone);
      zoneMaterials.set(direction, material);
    }
    for (const boundary of [-1.22, 1.22]) {
      const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(boundary, .02, front), new THREE.Vector3(boundary, h - .04, front),
      ]);
      const divider = new THREE.Line(geometry, new THREE.LineDashedMaterial({
        color: '#b1c4ae', transparent: true, opacity: .22, dashSize: .08, gapSize: .10,
      }));
      divider.computeLineDistances();
      scene.add(divider);
    }
  }

  function buildPitch() {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100),
      new THREE.MeshStandardMaterial({ color: '#213e29', roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    const stripeMaterial = new THREE.MeshStandardMaterial({ color: '#27472f', roughness: 1 });
    for (let z = -16; z <= 20; z += 4) {
      const stripe = new THREE.Mesh(new THREE.PlaneGeometry(80, 2), stripeMaterial);
      stripe.rotation.x = -Math.PI / 2;
      stripe.position.set(0, .001, z);
      stripe.receiveShadow = true;
      scene.add(stripe);
    }
    const goalLine = new THREE.Mesh(new THREE.PlaneGeometry(15, .035),
      new THREE.MeshBasicMaterial({ color: '#a8bda0', transparent: true, opacity: .45 }));
    goalLine.rotation.x = -Math.PI / 2;
    goalLine.position.set(0, .006, -.5);
    scene.add(goalLine);
    const box = new THREE.BufferGeometry().setFromPoints(
      [[-6, .01, -.5], [-6, .01, 4], [6, .01, 4], [6, .01, -.5]].map(p => new THREE.Vector3(...p)),
    );
    scene.add(new THREE.Line(box,
      new THREE.LineBasicMaterial({ color: '#8ca284', transparent: true, opacity: .28 })));
  }

  function updateZones() {
    for (const [direction, material] of zoneMaterials) {
      const probability = probabilities?.[direction] ?? 0;
      material.opacity = direction === selectedZone ? .13 : probability * .045;
    }
  }

  function highlight(direction = null) {
    if (direction !== null && !DIRECTIONS.includes(direction)) throw new RangeError('Unknown goal direction.');
    selectedZone = direction;
    updateZones();
  }

  /** Optional visual tint only; values must be actual API probabilities in [0, 1]. */
  function setProbabilities(values = null) {
    if (values !== null && !DIRECTIONS.every(direction => Number.isFinite(values[direction]) && values[direction] >= 0 && values[direction] <= 1)) {
      throw new RangeError('Goal zone probabilities must be numbers between zero and one.');
    }
    probabilities = values === null ? null : Object.fromEntries(DIRECTIONS.map(direction => [direction, values[direction]]));
    updateZones();
  }

  function pose(now) {
    if (!motion || disposed) return;
    motion.update(now);
    container.dataset.motion = motion.mode;
  }

  /** Start at the actual call time. A positive offset can align an intentionally delayed render. */
  function react(direction, elapsedSeconds = 0) {
    if (!DIRECTIONS.includes(direction)) throw new RangeError('Unknown goalkeeper reaction.');
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) throw new RangeError('Reaction offset must be a nonnegative time.');
    if (!modelReady || disposed) return false;
    const now = performance.now();
    motion.react(direction, now, elapsedSeconds);
    highlight(direction);
    pose(now);
    return true;
  }

  function reset() {
    if (disposed) return;
    motion?.warmUp(performance.now());
    probabilities = null;
    highlight(null);
    pose(performance.now());
  }

  /** Hold the current pose while keeping the canvas responsive to resize. */
  function stop() {
    if (disposed) return;
    const now = performance.now();
    motion?.stop(now);
    pose(now);
  }

  function greet() {
    if (!modelReady || disposed) return 0;
    const duration = motion.greet(performance.now()); pose(performance.now()); return duration;
  }

  function complain() {
    if (!modelReady || disposed) return 0;
    const duration = motion.complain(performance.now()); pose(performance.now()); return duration;
  }

  function warmUp() {
    if (!modelReady || disposed) return;
    motion.warmUp(performance.now()); pose(performance.now());
  }

  function resize() {
    if (!renderer || disposed) return;
    const width = container.clientWidth, height = container.clientHeight;
    if (width <= 0 || height <= 0) return;
    renderer.setSize(width, height, false);
    const viewHeight = Math.max(3.25, 8.5 * height / width);
    camera.left = -viewHeight * width / height / 2;
    camera.right = -camera.left;
    camera.top = viewHeight / 2;
    camera.bottom = -camera.top;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    if (onZoneLayout) {
      // DOM labels follow projected goal geometry even when the panel resizes.
      const project = (x, y) => {
        const point = new THREE.Vector3(x, y, -.49).project(camera);
        return { x: (point.x + 1) / 2, y: (1 - point.y) / 2 };
      };
      const layout = Object.fromEntries(DIRECTIONS.map((direction, index) => {
        const center = (index - 1) * 2.44;
        const point = project(center, 2.35);
        return [direction, { ...point, width: project(center + 1.22, 2.35).x - project(center - 1.22, 2.35).x }];
      }));
      onZoneLayout(layout);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    modelReady = false;
    observer?.disconnect();
    renderer?.setAnimationLoop(null);
    motion?.dispose();
    const geometries = new Set(), materials = new Set(), textures = new Set(), skeletons = new Set();
    const collectResources = object => {
      if (object.geometry) geometries.add(object.geometry);
      if (object.material) {
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
      }
      if (object.skeleton) skeletons.add(object.skeleton);
      object.shadow?.map?.dispose();
    };
    scene.traverse(collectResources);
    for (const model of loadedModels) model.traverse(collectResources);
    for (const material of materials) {
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
      material.dispose();
    }
    for (const geometry of geometries) geometry.dispose();
    for (const texture of textures) texture.dispose();
    for (const skeleton of skeletons) skeleton.dispose();
    for (const image of ownedImages) image.close();
    ownedImages.clear();
    loadedModels = [];
    renderer?.dispose();
    renderer?.domElement.remove();
  }

  const api = {
    get ready() { return modelReady && !disposed; },
    react, greet, warmUp, complain, highlight, setProbabilities, reset, stop, dispose, resize,
  };

  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.domElement.setAttribute('aria-label', 'AI goalkeeper in a goal divided into left, center, and right zones');
    renderer.domElement.setAttribute('role', 'img');
    renderer.domElement.style.cssText = 'display:block;width:100%;height:100%';
    container.append(renderer.domElement);

    scene.add(new THREE.HemisphereLight('#e4f1ff', '#58734c', 2.1));
    const sun = new THREE.DirectionalLight('#fff3dd', 3.1);
    sun.position.set(-3, 7, 5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -6;
    sun.shadow.camera.right = 6;
    sun.shadow.camera.top = 5;
    sun.shadow.camera.bottom = -4;
    sun.shadow.normalBias = .02;
    sun.shadow.bias = -.0001;
    sun.shadow.radius = 3;
    scene.add(sun);
    const rim = new THREE.DirectionalLight('#cadfd4', 1.4);
    rim.position.set(4, 4, -3);
    scene.add(rim);
    buildPitch();
    buildGoal();
    resize();
    observer = new ResizeObserver(resize);
    observer.observe(container);
    renderer.setAnimationLoop(now => {
      pose(now);
      renderer.render(scene, camera);
      // A recording copies WebGL pixels in this same frame, before the browser
      // clears the default drawing buffer. Normal playback needs no extra copy.
      onRendered?.(now);
    });

    const gltf = await new GLTFLoader().loadAsync('/assets/goalkeeper-animated.glb');
    loadedModels = [...new Set(gltf.scenes?.length ? gltf.scenes : [gltf.scene])];
    // Finish resizing before the skin enters the scene or uploads any maps.
    await capModelTextures(loadedModels);
    gltf.scene.traverse(object => {
      if (!object.isMesh) return;
      object.castShadow = true;
      object.receiveShadow = true;
      // Animated skin extends beyond the static T-pose bounding volume.
      object.frustumCulled = false;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        material.metalness = 0;
        material.roughness = .84;
        material.normalScale?.setScalar(.6);
      }
    });
    rig = new KeeperRig(gltf.scene);
    motion = new KeeperMotion(rig, gltf.animations);
    scene.add(rig.root);
    modelReady = true;
    reset();
    resize();
    onReady?.(api);
    return api;
  } catch (error) {
    dispose();
    onError?.(error);
    throw error;
  }
}
