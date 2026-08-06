import "./style.css";
import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { createDefaultStructureConfig } from "./config/structure-config";
import {
  applyStructureHash,
  encodeStructureHash,
} from "./config/structure-hash";
import { setEngravingCatalog } from "./engravings/catalog";
import { loadEngravingCatalog } from "./engravings/document";
import { MainScene } from "./scene/main";
import { createControlPane } from "./ui/create-pane";
import { getStructure } from "./structure/registry";
import {
  fireGlowShadowCascadeCount,
  requestedSamplerLimit,
  requestedSampledTextureLimit,
  supportsFireGlowShadows,
} from "./scene/webgpu-limits";

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
// Loaded before anything reads the config, not merely before the pane.
//
// The engraving dropdowns are populated from what the project actually carries,
// so the pane needs it — but so does the geometry code, whose field schema now
// includes an engraving's document list and glyph pool. Decoding a hash against
// an empty catalog reads a different schema than the one that wrote it, and the
// code is discarded as corrupt: the structure silently resets to the default.
//
// A failure here leaves an empty catalog and every slot offering nothing but
// "None", which is a state the user can see and the console explains — the
// alternative is a pane that cannot be built at all.
try {
  setEngravingCatalog(await loadEngravingCatalog());
} catch (error) {
  console.error(
    "The engraving catalog failed to load; slots stay bare.",
    error,
  );
}

const config = createDefaultStructureConfig();

if (window.location.hash.length > 1) {
  try {
    applyStructureHash(config, window.location.hash);
  } catch (error) {
    console.warn("Ignoring invalid geometry code.", error);
  }
}

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
const adapter = await navigator.gpu?.requestAdapter({
  // Three requests the compatibility feature level internally as well. The
  // DOM type has not caught up with this WebGPU option yet.
  featureLevel: "compatibility",
} as GPURequestAdapterOptions);
const sampledTextureLimit = requestedSampledTextureLimit(
  adapter?.limits.maxSampledTexturesPerShaderStage,
);
const samplerLimit = requestedSamplerLimit(
  adapter?.limits.maxSamplersPerShaderStage,
);
const requiredLimits: Record<string, number> = {};
if (sampledTextureLimit !== null) {
  requiredLimits.maxSampledTexturesPerShaderStage = sampledTextureLimit;
}
if (samplerLimit !== null) {
  requiredLimits.maxSamplersPerShaderStage = samplerLimit;
}
const renderer = new WebGPURenderer({
  canvas: sceneCanvas,
  antialias: true,
  requiredLimits: Object.keys(requiredLimits).length > 0
    ? requiredLimits
    : undefined,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
await renderer.init();
renderer.shadowMap.enabled = true;
const rendererBackend = renderer.backend as {
  isWebGPUBackend?: boolean;
  device?: GPUDevice;
};
const deviceSampledTextureLimit =
  rendererBackend.device?.limits.maxSampledTexturesPerShaderStage;
const deviceSamplerLimit = rendererBackend.device?.limits.maxSamplersPerShaderStage;
const sunShadowCascades = fireGlowShadowCascadeCount(
  deviceSampledTextureLimit,
  deviceSamplerLimit,
);
const fireGlowShadowsSupported = rendererBackend.isWebGPUBackend === true
  && supportsFireGlowShadows(
    deviceSampledTextureLimit,
    deviceSamplerLimit,
    sunShadowCascades,
  );
applyRendererCapabilities();

const controls = new OrbitControls(camera, sceneCanvas);
controls.enableDamping = true;

const mainScene = new MainScene(config, {
  fireGlowShadowsSupported,
  sunShadowCascades,
});

// A debug handle on the composed scene, because the shading has no other
// witness. The suite can assert what the builders emit, but the per-vertex
// occlusion, crack shadow and sun visibility a decal ends up wearing are
// resolved against the subdivided host at compose time — there is no seam a
// script can read them from, and every one of the four shading bugs found so
// far was invisible until the arrays were compared in a live frame.
(window as unknown as Record<string, unknown>).__scene = mainScene;

const activeDefinition = getStructure(config.typeId);
const activePalette = config.materialPalettes[activeDefinition.id];

if (!activePalette) {
  throw new Error(
    `Missing material palette for structure "${activeDefinition.id}".`,
  );
}

await mainScene.loadStructureMaterialPalette(
  renderer,
  activePalette,
  activeDefinition.materialSurfaces ?? ["stone"],
);


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

const pane = createControlPane({
  container: paneHost,
  config,
  scene: mainScene,
  rendererLabel: rendererBackend.isWebGPUBackend === true ? "WebGPU" : "WebGL2",
  fireGlowShadowsSupported,
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

    applyRendererCapabilities();
    pane.reloadStructureConfig();
  } catch (error) {
    console.warn("Ignoring invalid geometry code.", error);
    writeGeometryHash();
  }
}

function applyRendererCapabilities(): void {
  if (!fireGlowShadowsSupported && config.fire.glowCastShadow) {
    config.fire.glowCastShadow = false;
    console.warn(
      "Fire glow shadows are unavailable because this GPU device does not expose "
      + "enough sampled-texture and sampler bindings.",
    );
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
