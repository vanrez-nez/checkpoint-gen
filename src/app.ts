import "./style.css";
import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { createDefaultStructureConfig } from "./config/structure-config";
import {
  applyStructureHash,
  encodeStructureHash,
} from "./config/structure-hash";
import { MainScene } from "./scene/main";
import { createControlPane } from "./ui/create-pane";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app root element");
}

const canvas = app.querySelector<HTMLCanvasElement>(".scene");
const paneHost = app.querySelector<HTMLDivElement>(".pane-host");

if (!canvas || !paneHost) {
  throw new Error("Missing app elements");
}

const sceneCanvas = canvas;
const config = createDefaultStructureConfig();

if (window.location.hash.length > 1) {
  try {
    applyStructureHash(config, window.location.hash);
  } catch (error) {
    console.warn("Ignoring invalid geometry code.", error);
  }
}

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
const renderer = new WebGPURenderer({ canvas: sceneCanvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
await renderer.init();
renderer.shadowMap.enabled = true;

const controls = new OrbitControls(camera, sceneCanvas);
controls.enableDamping = true;

const mainScene = new MainScene(config);

try {
  await mainScene.loadStoneMaterial(
    renderer,
    `${import.meta.env.BASE_URL}materials/stone.json`,
  );
} catch (error) {
  console.error(
    "Stone material failed to load; using the fallback material.",
    error,
  );
}

try {
  await mainScene.loadIronMaterial(
    renderer,
    `${import.meta.env.BASE_URL}materials/hammered-iron.json`,
  );
} catch (error) {
  console.error(
    "Iron material failed to load; using the fallback material.",
    error,
  );
}

try {
  await mainScene.loadOfferingMaterial(
    renderer,
    `${import.meta.env.BASE_URL}materials/stone.json`,
  );
} catch (error) {
  console.error(
    "Offering material failed to load; using the fallback material.",
    error,
  );
}

try {
  await mainScene.loadOffering(
    `${import.meta.env.BASE_URL}models/xochipilli_offering.glb`,
    `${import.meta.env.BASE_URL}draco/`,
  );
} catch (error) {
  console.error(
    "Xochipilli offering failed to load; continuing without it.",
    error,
  );
}

const rendererBackend = renderer.backend as { isWebGPUBackend?: boolean };
const pane = createControlPane({
  container: paneHost,
  config,
  scene: mainScene,
  rendererLabel: rendererBackend.isWebGPUBackend === true ? "WebGPU" : "WebGL2",
  onStructureConfigChange: writeGeometryHash,
});
const { stats } = pane;
writeGeometryHash();

const timer = new THREE.Timer();
timer.connect(document);

function resize(): void {
  const { clientWidth, clientHeight } = sceneCanvas;
  renderer.setSize(clientWidth, clientHeight, false);
  camera.aspect = clientWidth / Math.max(clientHeight, 1);
  camera.updateProjectionMatrix();
  mainScene.updateShadowFrustums();
}

function animate(timestamp?: number): void {
  stats.begin();
  timer.update(timestamp);

  mainScene.update(timer.getDelta());
  controls.update();
  renderer.render(mainScene.scene, camera);
  stats.end();
}

function frameComposition(): void {
  const bounds = mainScene.getCompositionBounds();
  const center = bounds.getCenter(new THREE.Vector3());
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  const direction = new THREE.Vector3(0.82, 1.05, 0.82).normalize();
  const halfFov = THREE.MathUtils.degToRad(camera.fov * 0.5);
  const distance = Math.max(sphere.radius / Math.sin(halfFov), 1) * 1.15;
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.near = Math.max(distance * 0.002, 0.01);
  camera.far = Math.max(distance + sphere.radius * 4, 200);
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
  mainScene.updateShadowFrustums();
}

function writeGeometryHash(): void {
  const code = encodeStructureHash(config);

  if (window.location.hash.slice(1) === code) {
    return;
  }

  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${window.location.search}#${code}`,
  );
}

function restoreGeometryHash(): void {
  try {
    if (window.location.hash.length <= 1) {
      const defaults = createDefaultStructureConfig();
      applyStructureHash(config, encodeStructureHash(defaults));
    } else {
      applyStructureHash(config, window.location.hash);
    }

    pane.reloadStructureConfig();
  } catch (error) {
    console.warn("Ignoring invalid geometry code.", error);
    writeGeometryHash();
  }
}

window.addEventListener("resize", resize);
window.addEventListener("hashchange", restoreGeometryHash);
window.addEventListener("beforeunload", dispose, { once: true });
resize();
frameComposition();
void renderer.setAnimationLoop(animate);

function dispose(): void {
  window.removeEventListener("resize", resize);
  window.removeEventListener("hashchange", restoreGeometryHash);
  void renderer.setAnimationLoop(null);
  controls.dispose();
  pane.dispose();
  mainScene.dispose();
  void renderer.dispose();
}
