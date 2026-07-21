import "./style.css";
import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Pane } from "tweakpane";
import {
  DEFAULT_CHECKPOINT_CONFIG,
  type CheckpointGeometryConfig,
  type CheckpointGeometryResult,
} from "./checkpoint/generator";
import {
  DEFAULT_PILLAR_CONFIG,
  type PillarGeometryConfig,
} from "./pillar/generator";
import {
  DEFAULT_MATERIAL_SCALE,
  DEFAULT_ILLUMINATION_CONFIG,
  MainScene,
  type IlluminationConfig,
  type PillarSetStats,
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
};

const pillarConfig: PillarGeometryConfig = {
  ...DEFAULT_PILLAR_CONFIG,
  fireBowl: { ...DEFAULT_PILLAR_CONFIG.fireBowl },
};

const illuminationConfig: IlluminationConfig = {
  ...DEFAULT_ILLUMINATION_CONFIG,
};

const geometryStats = {
  stones: 0,
  vertices: 0,
  triangles: 0,
};

const pillarStats = {
  pillars: 0,
  stones: 0,
  vertices: 0,
  triangles: 0,
};

const fireBowlStats = {
  bowls: 0,
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

const mainScene = new MainScene(checkpointConfig, pillarConfig);

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

const pane = new Pane({ container: paneHost, title: "Checkpoint + Pillars" });
pane.registerPlugin(StatsPanePluginBundle);
const stats = pane.addBlade({ view: "stats" }) as StatsBladeApi;
const rendererBackend = renderer.backend as { isWebGPUBackend?: boolean };
stats.setRenderer(rendererBackend.isWebGPUBackend === true ? "WebGPU" : "WebGL2");
const tabs = pane.addTab({
  pages: [
    { title: "Checkpoint" },
    { title: "Pillars" },
    { title: "Fire Bowl" },
    { title: "Scene" },
  ],
});
const checkpointTab = tabs.pages[0];
const pillarTab = tabs.pages[1];
const fireBowlTab = tabs.pages[2];
const sceneTab = tabs.pages[3];

if (!checkpointTab || !pillarTab || !fireBowlTab || !sceneTab) {
  throw new Error("Failed to create control tabs.");
}

const viewFolder = sceneTab.addFolder({ title: "View" });
viewFolder.addBinding(params, "wireframe").on("change", () => {
  mainScene.setWireframe(params.wireframe);
});
viewFolder.addBinding(params, "vertexNormals", {
  label: "vertex normals",
}).on("change", () => {
  mainScene.setVertexNormalsVisible(params.vertexNormals);
});

const layoutFolder = checkpointTab.addFolder({ title: "Layout" });
layoutFolder.addBinding(checkpointConfig, "radius", {
  min: 1,
  max: 10,
  step: 0.1,
}).on("change", () => {
  rebuildCheckpointAndPillars();
  frameComposition();
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
}).on("change", () => {
  rebuildCheckpointAndPillars();
  frameComposition();
});
layoutFolder.addBinding(checkpointConfig, "entryLengthRatio", {
  label: "entry length",
  min: 0.25,
  max: 3,
  step: 0.05,
}).on("change", () => {
  rebuildCheckpoint();
  frameComposition();
});

const entriesFolder = checkpointTab.addFolder({ title: "Entries" });
entriesFolder.addBinding(checkpointConfig, "entryCount", {
  label: "count",
  min: 1,
  max: 8,
  step: 1,
}).on("change", () => {
  rebuildCheckpointAndPillars();
  frameComposition();
});

const edgesFolder = checkpointTab.addFolder({ title: "Entry Edges" });
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

const stonesFolder = checkpointTab.addFolder({ title: "Stones" });
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

const bevelFolder = checkpointTab.addFolder({ title: "Bevel" });
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

const pillarLayoutFolder = pillarTab.addFolder({ title: "Layout" });
pillarLayoutFolder.addBinding(pillarConfig, "height", {
  min: 1,
  max: 12,
  step: 0.1,
}).on("change", () => {
  rebuildPillars();
  frameComposition();
});
pillarLayoutFolder.addBinding(pillarConfig, "shaftWidth", {
  label: "shaft width",
  min: 0.1,
  max: 3,
  step: 0.01,
}).on("change", () => {
  rebuildPillars();
  frameComposition();
});
pillarLayoutFolder.addBinding(pillarConfig, "baseSteps", {
  label: "base steps",
  min: 1,
  max: 4,
  step: 1,
}).on("change", () => {
  rebuildPillars();
  frameComposition();
});
pillarLayoutFolder.addBinding(pillarConfig, "shaftCourses", {
  label: "shaft courses",
  min: 1,
  max: 8,
  step: 1,
}).on("change", rebuildPillars);
pillarLayoutFolder.addBinding(pillarConfig, "shaftSubdivisions", {
  label: "shaft subdivisions",
  min: 1,
  max: 4,
  step: 1,
}).on("change", rebuildPillars);

const pillarStonesFolder = pillarTab.addFolder({ title: "Stones" });
pillarStonesFolder.addBinding(pillarConfig, "seed", {
  min: 0,
  max: 9999,
  step: 1,
}).on("change", rebuildPillars);
pillarStonesFolder.addBinding(pillarConfig, "stoneGapRatio", {
  label: "gap",
  min: 0.002,
  max: 0.04,
  step: 0.001,
}).on("change", rebuildPillars);
pillarStonesFolder.addBinding(pillarConfig, "sizeVariation", {
  label: "size variation",
  min: 0.05,
  max: 0.4,
  step: 0.01,
}).on("change", rebuildPillars);
pillarStonesFolder.addBinding(pillarConfig, "displacement", {
  min: 0.01,
  max: 0.2,
  step: 0.01,
}).on("change", rebuildPillars);

const pillarBevelFolder = pillarTab.addFolder({ title: "Bevel" });
pillarBevelFolder.addBinding(pillarConfig, "bevelEnabled", {
  label: "enabled",
}).on("change", rebuildPillars);
pillarBevelFolder.addBinding(pillarConfig, "bevelWidthRatio", {
  label: "width",
  min: 0.02,
  max: 0.3,
  step: 0.01,
}).on("change", rebuildPillars);
pillarBevelFolder.addBinding(pillarConfig, "bevelDepthRatio", {
  label: "depth",
  min: 0.05,
  max: 0.6,
  step: 0.01,
}).on("change", rebuildPillars);
pillarBevelFolder.addBinding(pillarConfig, "bevelVariation", {
  label: "variation",
  min: 0,
  max: 0.6,
  step: 0.01,
}).on("change", rebuildPillars);

const fireBowlFolder = fireBowlTab.addFolder({ title: "Geometry" });
fireBowlFolder.addBinding(pillarConfig.fireBowl, "enabled").on("change", () => {
  rebuildPillars();
  frameComposition();
});
fireBowlFolder.addBinding(pillarConfig.fireBowl, "scale", {
  min: 0.5,
  max: 2,
  step: 0.05,
}).on("change", () => {
  rebuildPillars();
  frameComposition();
});
fireBowlFolder.addBinding(pillarConfig.fireBowl, "radialSegments", {
  label: "radial detail",
  min: 16,
  max: 64,
  step: 4,
}).on("change", rebuildPillars);

const materialFolder = sceneTab.addFolder({ title: "Material" });
materialFolder.addBinding(params, "materialScale", {
  label: "material scale",
  min: 0.1,
  max: 4,
  step: 0.05,
}).on("change", () => {
  mainScene.setMaterialScale(params.materialScale);
});

const illuminationFolder = sceneTab.addFolder({ title: "Illumination" });
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

const metricsFolder = checkpointTab.addFolder({ title: "Geometry", expanded: false });
metricsFolder.addBinding(geometryStats, "stones", { readonly: true });
metricsFolder.addBinding(geometryStats, "vertices", { readonly: true });
metricsFolder.addBinding(geometryStats, "triangles", { readonly: true });
const pillarMetricsFolder = pillarTab.addFolder({ title: "Geometry", expanded: false });
pillarMetricsFolder.addBinding(pillarStats, "pillars", { readonly: true });
pillarMetricsFolder.addBinding(pillarStats, "stones", { readonly: true });
pillarMetricsFolder.addBinding(pillarStats, "vertices", { readonly: true });
pillarMetricsFolder.addBinding(pillarStats, "triangles", { readonly: true });
const fireBowlMetricsFolder = fireBowlTab.addFolder({ title: "Stats", expanded: false });
fireBowlMetricsFolder.addBinding(fireBowlStats, "bowls", { readonly: true });
fireBowlMetricsFolder.addBinding(fireBowlStats, "vertices", { readonly: true });
fireBowlMetricsFolder.addBinding(fireBowlStats, "triangles", { readonly: true });
updateGeometryStats(mainScene.getGeometryStats());
updatePillarStats(mainScene.getPillarStats());

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

function rebuildCheckpoint(): void {
  updateGeometryStats(mainScene.rebuild(checkpointConfig));
  pane.refresh();
}

function rebuildPillars(): void {
  updatePillarStats(mainScene.rebuildPillars(checkpointConfig, pillarConfig));
  pane.refresh();
}

function rebuildCheckpointAndPillars(): void {
  updateGeometryStats(mainScene.rebuild(checkpointConfig));
  updatePillarStats(mainScene.rebuildPillars(checkpointConfig, pillarConfig));
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

function updatePillarStats(result: PillarSetStats): void {
  pillarStats.pillars = result.pillarCount;
  pillarStats.stones = result.stoneCount;
  pillarStats.vertices = result.vertexCount;
  pillarStats.triangles = result.triangleCount;
  fireBowlStats.bowls = pillarConfig.fireBowl.enabled ? result.pillarCount : 0;
  fireBowlStats.vertices = result.fireBowlVertexCount;
  fireBowlStats.triangles = result.fireBowlTriangleCount;
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

window.addEventListener("resize", resize);
window.addEventListener("beforeunload", dispose, { once: true });
resize();
frameComposition();
void renderer.setAnimationLoop(animate);

function dispose(): void {
  window.removeEventListener("resize", resize);
  void renderer.setAnimationLoop(null);
  controls.dispose();
  mainScene.dispose();
  void renderer.dispose();
}
