import "./style.css";
import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Pane } from "tweakpane";
import {
  DEFAULT_CHECKPOINT_CONFIG,
  type CardinalDirection,
  type CheckpointGeometryConfig,
  type CheckpointGeometryResult,
} from "./checkpoint/generator";
import {
  DEFAULT_MATERIAL_SCALE,
  DEFAULT_ILLUMINATION_CONFIG,
  MainScene,
  type IlluminationConfig,
} from "./scene/main";
import {
  StatsBladeApi,
  StatsPanePluginBundle,
} from "./tweak-pane/stats-blade";

const params = {
  materialScale: DEFAULT_MATERIAL_SCALE,
  wireframe: false,
  vertexNormals: false,
};

const checkpointConfig: CheckpointGeometryConfig = {
  ...DEFAULT_CHECKPOINT_CONFIG,
  entries: { ...DEFAULT_CHECKPOINT_CONFIG.entries },
};

const illuminationConfig: IlluminationConfig = {
  ...DEFAULT_ILLUMINATION_CONFIG,
};

const geometryStats = {
  stones: 0,
  vertices: 0,
  triangles: 0,
};

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
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 200);
const renderer = new WebGPURenderer({ canvas: sceneCanvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
await renderer.init();
renderer.shadowMap.enabled = true;

const controls = new OrbitControls(camera, sceneCanvas);
controls.enableDamping = true;

const mainScene = new MainScene(checkpointConfig);
frameCheckpoint();

try {
  await mainScene.loadStoneMaterial(
    renderer,
    `${import.meta.env.BASE_URL}materials/stone.json`,
  );
} catch (error) {
  console.error("Stone material failed to load; using the fallback material.", error);
}

const pane = new Pane({ container: paneHost, title: "Checkpoint" });
pane.registerPlugin(StatsPanePluginBundle);
const stats = pane.addBlade({ view: "stats" }) as StatsBladeApi;
const rendererBackend = renderer.backend as { isWebGPUBackend?: boolean };
stats.setRenderer(rendererBackend.isWebGPUBackend === true ? "WebGPU" : "WebGL2");

const viewFolder = pane.addFolder({ title: "View" });
viewFolder.addBinding(params, "wireframe").on("change", () => {
  mainScene.setWireframe(params.wireframe);
});
viewFolder.addBinding(params, "vertexNormals", {
  label: "vertex normals",
}).on("change", () => {
  mainScene.setVertexNormalsVisible(params.vertexNormals);
});

const layoutFolder = pane.addFolder({ title: "Layout" });
layoutFolder.addBinding(checkpointConfig, "radius", {
  min: 1,
  max: 10,
  step: 0.1,
}).on("change", () => {
  rebuildCheckpoint();
  frameCheckpoint();
});
layoutFolder.addBinding(checkpointConfig, "rowsPerTier", {
  label: "rows / tier",
  min: 1,
  max: 4,
  step: 1,
}).on("change", rebuildCheckpoint);
layoutFolder.addBinding(checkpointConfig, "entryWidthRatio", {
  label: "entry width",
  min: 0.25,
  max: 1.5,
  step: 0.01,
}).on("change", rebuildCheckpoint);
layoutFolder.addBinding(checkpointConfig, "entryLengthRatio", {
  label: "entry length",
  min: 0.25,
  max: 3,
  step: 0.05,
}).on("change", rebuildCheckpoint);

const entriesFolder = pane.addFolder({ title: "Entries" });
bindEntry(entriesFolder, "north");
bindEntry(entriesFolder, "east");
bindEntry(entriesFolder, "south");
bindEntry(entriesFolder, "west");

const edgesFolder = pane.addFolder({ title: "Entry Edges" });
edgesFolder.addBinding(checkpointConfig, "entryFadeRatio", {
  label: "fade length",
  min: 0.1,
  max: 0.5,
  step: 0.01,
}).on("change", rebuildCheckpoint);
edgesFolder.addBinding(checkpointConfig, "edgeFragmentation", {
  label: "fragmentation",
  min: 0,
  max: 1,
  step: 0.01,
}).on("change", rebuildCheckpoint);
edgesFolder.addBinding(checkpointConfig, "entryEndHeightRatio", {
  label: "last height",
  min: 0.01,
  max: 1,
  step: 0.01,
}).on("change", rebuildCheckpoint);

const stonesFolder = pane.addFolder({ title: "Stones" });
stonesFolder.addBinding(params, "materialScale", {
  label: "material scale",
  min: 0.1,
  max: 4,
  step: 0.05,
}).on("change", () => {
  mainScene.setMaterialScale(params.materialScale);
});
stonesFolder.addBinding(checkpointConfig, "seed", {
  min: 0,
  max: 9999,
  step: 1,
}).on("change", rebuildCheckpoint);
stonesFolder.addBinding(checkpointConfig, "stoneGapRatio", {
  label: "gap",
  min: 0.002,
  max: 0.04,
  step: 0.001,
}).on("change", rebuildCheckpoint);
stonesFolder.addBinding(checkpointConfig, "sizeVariation", {
  label: "size variation",
  min: 0.05,
  max: 0.4,
  step: 0.01,
}).on("change", rebuildCheckpoint);
stonesFolder.addBinding(checkpointConfig, "displacement", {
  min: 0.01,
  max: 0.2,
  step: 0.01,
}).on("change", rebuildCheckpoint);
stonesFolder.addBinding(checkpointConfig, "tierRiseRatio", {
  label: "tier rise",
  min: 0.005,
  max: 0.12,
  step: 0.005,
}).on("change", rebuildCheckpoint);

const bevelFolder = pane.addFolder({ title: "Bevel" });
bevelFolder.addBinding(checkpointConfig, "bevelEnabled", {
  label: "enabled",
}).on("change", rebuildCheckpoint);
bevelFolder.addBinding(checkpointConfig, "bevelWidthRatio", {
  label: "width",
  min: 0.02,
  max: 0.3,
  step: 0.01,
}).on("change", rebuildCheckpoint);
bevelFolder.addBinding(checkpointConfig, "bevelDepthRatio", {
  label: "depth",
  min: 0.05,
  max: 0.6,
  step: 0.01,
}).on("change", rebuildCheckpoint);
bevelFolder.addBinding(checkpointConfig, "bevelVariation", {
  label: "variation",
  min: 0,
  max: 0.6,
  step: 0.01,
}).on("change", rebuildCheckpoint);

const illuminationFolder = pane.addFolder({ title: "Illumination" });
illuminationFolder.addBinding(illuminationConfig, "keyIntensity", {
  label: "sun intensity",
  min: 0,
  max: 10,
  step: 0.1,
}).on("change", updateIllumination);
illuminationFolder.addBinding(illuminationConfig, "keyColor", {
  label: "sun color",
}).on("change", updateIllumination);
illuminationFolder.addBinding(illuminationConfig, "keyAzimuth", {
  label: "sun azimuth",
  min: -180,
  max: 180,
  step: 1,
}).on("change", updateIllumination);
illuminationFolder.addBinding(illuminationConfig, "keyElevation", {
  label: "sun elevation",
  min: 5,
  max: 90,
  step: 1,
}).on("change", updateIllumination);
illuminationFolder.addBinding(illuminationConfig, "ambientIntensity", {
  label: "hemisphere intensity",
  min: 0,
  max: 5,
  step: 0.05,
}).on("change", updateIllumination);
illuminationFolder.addBinding(illuminationConfig, "ambientOcclusion", {
  label: "AO strength",
  min: 0,
  max: 1,
  step: 0.01,
}).on("change", updateIllumination);
illuminationFolder.addBinding(illuminationConfig, "crackShadow", {
  label: "crack shadow",
  min: 0,
  max: 1,
  step: 0.01,
}).on("change", updateIllumination);
illuminationFolder.addBinding(illuminationConfig, "skyColor", {
  label: "sky color",
}).on("change", updateIllumination);
illuminationFolder.addBinding(illuminationConfig, "groundColor", {
  label: "ground color",
}).on("change", updateIllumination);

const metricsFolder = pane.addFolder({ title: "Geometry", expanded: false });
metricsFolder.addBinding(geometryStats, "stones", { readonly: true });
metricsFolder.addBinding(geometryStats, "vertices", { readonly: true });
metricsFolder.addBinding(geometryStats, "triangles", { readonly: true });
updateGeometryStats(mainScene.getGeometryStats());

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

function bindEntry(
  folder: ReturnType<Pane["addFolder"]>,
  direction: CardinalDirection,
): void {
  folder.addBinding(checkpointConfig.entries, direction).on("change", () => {
    const activeEntries = Object.values(checkpointConfig.entries).filter(Boolean).length;

    if (activeEntries === 0) {
      checkpointConfig.entries[direction] = true;
      pane.refresh();
      return;
    }

    rebuildCheckpoint();
  });
}

function rebuildCheckpoint(): void {
  updateGeometryStats(mainScene.rebuild(checkpointConfig));
  pane.refresh();
}

function updateIllumination(): void {
  mainScene.setIllumination(illuminationConfig);
}

function updateGeometryStats(
  result: Omit<CheckpointGeometryResult, "geometry">,
): void {
  geometryStats.stones = result.stoneCount;
  geometryStats.vertices = result.vertexCount;
  geometryStats.triangles = result.triangleCount;
}

function frameCheckpoint(): void {
  const visibleRadius = checkpointConfig.radius * (1 + checkpointConfig.entryLengthRatio);
  camera.position.set(visibleRadius * 0.82, visibleRadius * 1.05, visibleRadius * 0.82);
  controls.target.set(0, checkpointConfig.radius * 0.08, 0);
  controls.update();
}

window.addEventListener("resize", resize);
window.addEventListener("beforeunload", dispose, { once: true });
resize();
void renderer.setAnimationLoop(animate);

function dispose(): void {
  window.removeEventListener("resize", resize);
  void renderer.setAnimationLoop(null);
  controls.dispose();
  mainScene.dispose();
  void renderer.dispose();
}
