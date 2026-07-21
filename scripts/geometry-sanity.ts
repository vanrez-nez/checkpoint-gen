import assert from "node:assert/strict";
import * as THREE from "three";
import { createPolarEntryFrames } from "../src/checkpoint/entries";
import {
  DEFAULT_CHECKPOINT_CONFIG,
  createCheckpointGeometry,
  type CheckpointGeometryConfig,
} from "../src/checkpoint/generator";
import {
  DEFAULT_FIRE_BOWL_CONFIG,
  createFireBowlGeometry,
} from "../src/fire-bowl/generator";
import {
  DEFAULT_FIRE_CONFIG,
  VertexConeFireBatch,
  validateFireConfig,
  type FireConfig,
  type VertexConeFireConfig,
} from "../src/fire/vertex-cone";
import {
  DEFAULT_PILLAR_CONFIG,
  createPillarGeometry,
  getPillarBaseWidth,
  type PillarGeometryConfig,
} from "../src/pillar/generator";
import { createPillarPlacements } from "../src/pillar/layout";
import { MainScene } from "../src/scene/main";

const checkpointConfig: CheckpointGeometryConfig = {
  ...DEFAULT_CHECKPOINT_CONFIG,
};
const pillarConfig: PillarGeometryConfig = {
  ...DEFAULT_PILLAR_CONFIG,
  fireBowl: { ...DEFAULT_PILLAR_CONFIG.fireBowl },
};
const fireConfig: FireConfig = {
  ...DEFAULT_FIRE_CONFIG,
};

const checkpoint = createCheckpointGeometry(checkpointConfig);
const pillar = createPillarGeometry(pillarConfig);
const barePillar = createPillarGeometry({
  ...pillarConfig,
  fireBowl: { ...pillarConfig.fireBowl, enabled: false },
});
const fireBowl = createFireBowlGeometry(
  { ...DEFAULT_FIRE_BOWL_CONFIG },
  pillarConfig.shaftWidth,
);
assertValidGeometry(checkpoint.geometry, "checkpoint");
assertValidGeometry(pillar.geometry, "pillar");
assertValidGeometry(barePillar.geometry, "bare pillar");
assertValidGeometry(fireBowl.geometry, "fire bowl");
assert.ok(Math.abs(barePillar.geometry.boundingBox?.min.y ?? 1) < 1e-6);
assert.ok(Math.abs((barePillar.geometry.boundingBox?.max.y ?? 0) - pillarConfig.height) < 1e-6);
const defaultBaseHalfWidth = getPillarBaseWidth(pillarConfig) * 0.5;
assert.ok(Math.abs((barePillar.geometry.boundingBox?.min.x ?? 0) + defaultBaseHalfWidth) < 1e-6);
assert.ok(Math.abs((barePillar.geometry.boundingBox?.max.x ?? 0) - defaultBaseHalfWidth) < 1e-6);
assert.ok(Math.abs((barePillar.geometry.boundingBox?.min.z ?? 0) + defaultBaseHalfWidth) < 1e-6);
assert.ok(Math.abs((barePillar.geometry.boundingBox?.max.z ?? 0) - defaultBaseHalfWidth) < 1e-6);
assert.equal(fireBowl.supportCount, 8);
assert.equal(fireBowl.footCount, 4);
assert.equal(pillar.fireBowlVertexCount, fireBowl.vertexCount);
assert.equal(pillar.fireBowlTriangleCount, fireBowl.triangleCount);
assert.equal(pillar.geometry.groups.length, 2);
assert.equal(pillar.geometry.groups[0]?.materialIndex, 0);
assert.equal(pillar.geometry.groups[1]?.materialIndex, 1);
assert.equal(
  pillar.geometry.groups.reduce((sum, group) => sum + group.count, 0),
  pillar.geometry.index?.count,
);
assert.equal(barePillar.geometry.groups.length, 1);
assert.equal(barePillar.geometry.groups[0]?.materialIndex, 0);
assert.equal(barePillar.fireBowlVertexCount, 0);
assert.equal(barePillar.fireBowlTriangleCount, 0);
assert.ok(Math.abs(groupMinimumY(pillar.geometry, 1) - pillarConfig.height) < 1e-6);
assert.equal(
  (pillar.geometry.userData.baseUvs as Float32Array).length,
  pillar.geometry.getAttribute("uv").count * 2,
);
assert.equal(
  (pillar.geometry.userData.vertexAoBase as Float32Array).length,
  pillar.geometry.getAttribute("vertexAo").count,
);

const detailedFireBowl = createFireBowlGeometry(
  { ...DEFAULT_FIRE_BOWL_CONFIG, radialSegments: 64 },
  pillarConfig.shaftWidth,
);
const scaledFireBowl = createFireBowlGeometry(
  { ...DEFAULT_FIRE_BOWL_CONFIG, scale: DEFAULT_FIRE_BOWL_CONFIG.scale * 2 },
  pillarConfig.shaftWidth,
);
assert.ok(detailedFireBowl.vertexCount > fireBowl.vertexCount);
assert.ok(detailedFireBowl.triangleCount > fireBowl.triangleCount);
assert.ok(Math.abs(
  (scaledFireBowl.geometry.boundingBox?.max.x ?? 0)
    / (fireBowl.geometry.boundingBox?.max.x ?? 1)
    - 2,
) < 1e-6);

const repeatedPillar = createPillarGeometry(pillarConfig);
assert.deepEqual(
  Array.from(repeatedPillar.geometry.getAttribute("position").array),
  Array.from(pillar.geometry.getAttribute("position").array),
  "Pillar positions must be deterministic for the same seed.",
);
assert.deepEqual(
  Array.from(repeatedPillar.geometry.index?.array ?? []),
  Array.from(pillar.geometry.index?.array ?? []),
  "Pillar indices must be deterministic for the same seed.",
);

const changedSeed = createPillarGeometry({ ...pillarConfig, seed: pillarConfig.seed + 1 });
assert.notDeepEqual(
  Array.from(changedSeed.geometry.getAttribute("position").array),
  Array.from(pillar.geometry.getAttribute("position").array),
  "Changing the pillar seed must change its masonry detail.",
);

const hardEdges = createPillarGeometry({ ...pillarConfig, bevelEnabled: false });
assert.ok(hardEdges.vertexCount < pillar.vertexCount);
assert.ok(hardEdges.triangleCount < pillar.triangleCount);

const moreCourses = createPillarGeometry({
  ...pillarConfig,
  shaftCourses: pillarConfig.shaftCourses + 1,
});
const moreSubdivisions = createPillarGeometry({
  ...pillarConfig,
  shaftSubdivisions: pillarConfig.shaftSubdivisions + 1,
});
const moreSteps = createPillarGeometry({
  ...pillarConfig,
  baseSteps: pillarConfig.baseSteps + 1,
});
assert.ok(moreCourses.stoneCount > pillar.stoneCount);
assert.ok(moreSubdivisions.stoneCount > pillar.stoneCount);
assert.ok(moreSteps.stoneCount > pillar.stoneCount);

const extremePillars = [
  createPillarGeometry({
    ...pillarConfig,
    height: 1,
    shaftWidth: 0.25,
    baseSteps: 1,
    shaftCourses: 1,
    shaftSubdivisions: 1,
    stoneGapRatio: 0.002,
    sizeVariation: 0.05,
    displacement: 0.01,
    bevelWidthRatio: 0.02,
    bevelDepthRatio: 0.05,
    bevelVariation: 0,
  }),
  createPillarGeometry({
    ...pillarConfig,
    height: 12,
    shaftWidth: 3,
    baseSteps: 4,
    shaftCourses: 8,
    shaftSubdivisions: 4,
    stoneGapRatio: 0.04,
    sizeVariation: 0.4,
    displacement: 0.2,
    bevelWidthRatio: 0.3,
    bevelDepthRatio: 0.6,
    bevelVariation: 0.6,
  }),
];

for (const [index, result] of extremePillars.entries()) {
  assertValidGeometry(result.geometry, `extreme pillar ${index + 1}`);
}

const singleEntry: CheckpointGeometryConfig = {
  ...checkpointConfig,
  entryCount: 1,
};
const singleEntryPlacements = createPillarPlacements(singleEntry, pillarConfig);
const allPlacements = createPillarPlacements(checkpointConfig, pillarConfig);
assert.equal(singleEntryPlacements.length, 2);
assert.equal(allPlacements.length, checkpointConfig.entryCount * 2);
assert.equal(
  new Set(allPlacements.map((placement) => placement.label)).size,
  allPlacements.length,
);
assert.equal(
  new Set(allPlacements.map((placement) => placement.seed)).size,
  allPlacements.length,
);
assert.ok(singleEntryPlacements.every((placement) => Number.isFinite(placement.x)));
assert.ok(singleEntryPlacements.every((placement) => Number.isFinite(placement.y)));
assert.ok(singleEntryPlacements.every((placement) => Number.isFinite(placement.z)));

const fireBatch = new VertexConeFireBatch(
  fireConfig.radialSegments,
  16,
);
const fireMaterial = fireBatch.object.material;
const initialFireGeometry = fireBatch.object.geometry;
const fireBatchConfig: Omit<VertexConeFireConfig, "placements"> = {
  enabled: fireConfig.enabled,
  scale: fireConfig.scale,
  radius: fireConfig.radius,
  height: fireConfig.height,
  baseHeight: fireConfig.baseHeight,
  speed: fireConfig.speed,
  noiseScale: fireConfig.noiseScale,
  turbulence: fireConfig.turbulence,
  intensity: fireConfig.intensity,
  pillarHeight: pillarConfig.height,
  radialSegments: fireConfig.radialSegments,
};
const defaultFireStats = fireBatch.update({
  ...fireBatchConfig,
  placements: allPlacements,
});
assert.equal(fireBatch.object.count, allPlacements.length);
assert.equal(fireBatch.object.geometry.getAttribute("position").count, 425);
assert.equal(defaultFireStats.flameCount, 8);
assert.equal(defaultFireStats.vertexCount, 3_400);
assert.equal(defaultFireStats.triangleCount, 6_016);
assert.equal(defaultFireStats.drawCallCount, 1);
assert.equal(fireMaterial.transparent, true);
assert.equal(fireMaterial.blending, THREE.AdditiveBlending);
assert.equal(fireMaterial.depthWrite, false);
assert.equal(fireMaterial.depthTest, true);
assert.equal(fireMaterial.side, THREE.DoubleSide);
assert.ok(fireBatch.object.boundingBox && !fireBatch.object.boundingBox.isEmpty());
assert.ok(fireBatch.object.boundingSphere && fireBatch.object.boundingSphere.radius > 0);

const firstFireMatrix = new THREE.Matrix4();
const firstFirePosition = new THREE.Vector3();
fireBatch.object.getMatrixAt(0, firstFireMatrix);
firstFirePosition.setFromMatrixPosition(firstFireMatrix);
assert.ok(Math.abs(firstFirePosition.x - (allPlacements[0]?.x ?? 0)) < 1e-6);
assert.ok(Math.abs(firstFirePosition.z - (allPlacements[0]?.z ?? 0)) < 1e-6);
assert.ok(Math.abs(
  firstFirePosition.y - pillarConfig.height - fireConfig.baseHeight,
) < 1e-6);

fireBatch.update({
  ...fireBatchConfig,
  radius: fireConfig.radius * 2,
  height: fireConfig.height * 2,
  baseHeight: fireConfig.baseHeight * 2,
  pillarHeight: pillarConfig.height * 2,
  placements: singleEntryPlacements,
});
assert.equal(fireBatch.object.geometry, initialFireGeometry);
assert.equal(fireBatch.object.material, fireMaterial);

const detailedFireStats = fireBatch.update({
  ...fireBatchConfig,
  radialSegments: 64,
  placements: allPlacements,
});
assert.notEqual(fireBatch.object.geometry, initialFireGeometry);
assert.equal(fireBatch.object.material, fireMaterial);
assert.equal(fireBatch.object.geometry.getAttribute("position").count, 1_625);
assert.equal(detailedFireStats.vertexCount, 13_000);
assert.equal(detailedFireStats.triangleCount, 24_064);
assert.equal(detailedFireStats.drawCallCount, 1);

const disabledFireStats = fireBatch.update({
  ...fireBatchConfig,
  enabled: false,
  radialSegments: 64,
  placements: allPlacements,
});
assert.equal(fireBatch.object.count, 0);
assert.equal(fireBatch.object.visible, false);
assert.deepEqual(disabledFireStats, {
  flameCount: 0,
  vertexCount: 0,
  triangleCount: 0,
  drawCallCount: 0,
});
assert.throws(
  () => fireBatch.update({
    ...fireBatchConfig,
    radialSegments: 16,
    placements: Array.from({ length: 17 }, () => ({ x: 0, y: 0, z: 0 })),
  }),
  /cannot exceed 16/,
);
fireBatch.dispose();

const scene = new MainScene(checkpointConfig, pillarConfig, fireConfig);
assert.deepEqual(scene.getPillarStats(), {
  pillarCount: 8,
  stoneCount: pillar.stoneCount * 8,
  vertexCount: pillar.vertexCount * 8,
  triangleCount: pillar.triangleCount * 8,
  fireBowlVertexCount: pillar.fireBowlVertexCount * 8,
  fireBowlTriangleCount: pillar.fireBowlTriangleCount * 8,
  flameCount: 8,
  flameVertexCount: 3_400,
  flameTriangleCount: 6_016,
  flameDrawCallCount: 1,
  glowLightCount: 4,
});
assert.equal(
  scene.scene.children.filter((child) => child.type === "PointLight").length,
  4,
);
assert.equal(scene.scene.getObjectByName("Fire bowl flames")?.type, "Mesh");

const firstGlowLight = scene.scene.children.find((child) => child.type === "PointLight");
const flameObject = scene.scene.getObjectByName("Fire bowl flames") as THREE.Mesh;
const flameGeometry = flameObject.geometry;
const tunedFireStats = scene.rebuildFireEffects(
  checkpointConfig,
  pillarConfig,
  {
    ...fireConfig,
    speed: 5,
    noiseScale: 6,
    turbulence: 1.5,
    intensity: 2,
    glowIntensity: 1.2,
  },
);
assert.equal(tunedFireStats.flameCount, 8);
assert.equal(scene.scene.getObjectByName("Fire bowl flames"), flameObject);
assert.equal(flameObject.geometry, flameGeometry);
assert.equal(
  scene.scene.children.find((child) => child.type === "PointLight"),
  firstGlowLight,
);
assert.equal((firstGlowLight as THREE.PointLight).intensity, 1.2);

const eightEntryConfig = { ...checkpointConfig, entryCount: 8 };
const maximumFireStats = scene.rebuildPillars(
  eightEntryConfig,
  pillarConfig,
  fireConfig,
);
assert.equal(maximumFireStats.pillarCount, 16);
assert.equal(maximumFireStats.flameCount, 16);
assert.equal(maximumFireStats.flameDrawCallCount, 1);
assert.equal(maximumFireStats.glowLightCount, 8);
assert.equal(
  scene.scene.children.filter((child) => child.type === "PointLight").length,
  8,
);

const noFireStats = scene.rebuildPillars(
  checkpointConfig,
  {
    ...pillarConfig,
    fireBowl: { ...pillarConfig.fireBowl, enabled: false },
  },
  fireConfig,
);
assert.equal(noFireStats.flameCount, 0);
assert.equal(noFireStats.flameDrawCallCount, 0);
assert.equal(noFireStats.glowLightCount, 0);
assert.equal(
  scene.scene.children.filter((child) => child.type === "PointLight").length,
  0,
);

const independentFireStats = scene.rebuildPillars(
  checkpointConfig,
  {
    ...pillarConfig,
    fireBowl: { ...pillarConfig.fireBowl, scale: 2 },
  },
  fireConfig,
);
assert.equal(independentFireStats.flameVertexCount, 3_400);
assert.equal(independentFireStats.flameTriangleCount, 6_016);
assert.equal(independentFireStats.glowLightCount, 4);

const explicitlyDisabledFireStats = scene.rebuildFireEffects(
  checkpointConfig,
  pillarConfig,
  { ...fireConfig, enabled: false },
);
assert.equal(explicitlyDisabledFireStats.flameCount, 0);
assert.equal(explicitlyDisabledFireStats.glowLightCount, 0);
scene.dispose();

assert.throws(
  () => validateFireConfig({ ...fireConfig, scale: 0 }),
  /Fire scale/,
);
assert.throws(
  () => validateFireConfig({ ...fireConfig, radius: 0 }),
  /Fire radius/,
);
assert.throws(
  () => validateFireConfig({ ...fireConfig, glowFlicker: 0.51 }),
  /Fire glow flicker/,
);

const threeEntryFrames = createPolarEntryFrames(3);
const threeEntryCheckpoint = createCheckpointGeometry({ ...checkpointConfig, entryCount: 3 });
assertValidGeometry(threeEntryCheckpoint.geometry, "three-entry checkpoint");
assert.ok(Math.abs(threeEntryFrames[0]?.angle ?? 1) < 1e-12);
assert.ok(Math.abs((threeEntryFrames[1]?.angle ?? 0) - Math.PI * 2 / 3) < 1e-12);
assert.ok(Math.abs((threeEntryFrames[2]?.angle ?? 0) - Math.PI * 4 / 3) < 1e-12);

const entryHalfWidth = checkpointConfig.radius * checkpointConfig.entryWidthRatio * 0.5;
const baseHalfWidth = defaultBaseHalfWidth;
const junctionDistance = Math.sqrt(
  checkpointConfig.radius ** 2 - entryHalfWidth ** 2,
);
for (const placement of allPlacements) {
  const axisX = Math.sin(placement.angle);
  const axisZ = Math.cos(placement.angle);
  const lateralX = Math.cos(placement.angle);
  const lateralZ = -Math.sin(placement.angle);
  const axial = placement.x * axisX + placement.z * axisZ;
  const lateral = placement.x * lateralX + placement.z * lateralZ;
  assert.ok(Math.abs(axial - baseHalfWidth - junctionDistance) < 1e-9);
  assert.ok(Math.abs(Math.abs(lateral) - baseHalfWidth - entryHalfWidth) < 1e-9);
  assert.equal(placement.y, 0);
}

assert.throws(
  () => createPillarGeometry({ ...pillarConfig, baseSteps: 0 }),
  /Base steps/,
);
assert.throws(
  () => createPillarGeometry({ ...pillarConfig, height: 0 }),
  /height/,
);
assert.throws(
  () => createFireBowlGeometry({ ...DEFAULT_FIRE_BOWL_CONFIG, scale: 0.49 }, 1),
  /scale/,
);
assert.throws(
  () => createFireBowlGeometry({ ...DEFAULT_FIRE_BOWL_CONFIG, radialSegments: 18 }, 1),
  /radial segments/,
);
assert.throws(
  () => createCheckpointGeometry({ ...checkpointConfig, entryCount: 0 }),
  /Entry count/,
);
assert.throws(
  () => createCheckpointGeometry({ ...checkpointConfig, entryCount: 9 }),
  /Entry count/,
);

for (const result of [
  checkpoint,
  pillar,
  barePillar,
  fireBowl,
  detailedFireBowl,
  scaledFireBowl,
  repeatedPillar,
  changedSeed,
  hardEdges,
  moreCourses,
  moreSubdivisions,
  moreSteps,
  threeEntryCheckpoint,
  ...extremePillars,
]) {
  result.geometry.dispose();
}

console.log(
  `Geometry sanity passed: ${pillar.stoneCount} stones per default pillar, ${allPlacements.length} default placements.`,
);

function assertValidGeometry(geometry: THREE.BufferGeometry, label: string): void {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv");
  const vertexAo = geometry.getAttribute("vertexAo");
  const color = geometry.getAttribute("color");
  const index = geometry.index;

  assert.ok(position.count > 0, `${label} must contain vertices.`);
  assert.equal(normal.count, position.count);
  assert.equal(uv.count, position.count);
  assert.equal(vertexAo.count, position.count);
  assert.equal(color.count, position.count);
  assert.ok(index && index.count > 0, `${label} must contain indices.`);
  assert.equal(index.count % 3, 0);
  assert.ok(Array.from(position.array).every(Number.isFinite));
  assert.ok(Array.from(normal.array).every(Number.isFinite));
  assert.ok(Array.from(uv.array).every(Number.isFinite));
  assert.ok(Array.from(index.array).every((value) => value >= 0 && value < position.count));
  assert.ok(geometry.boundingBox && !geometry.boundingBox.isEmpty());
  assert.ok(geometry.boundingSphere && Number.isFinite(geometry.boundingSphere.radius));
}

function groupMinimumY(geometry: THREE.BufferGeometry, materialIndex: number): number {
  const group = geometry.groups.find((candidate) => candidate.materialIndex === materialIndex);
  const position = geometry.getAttribute("position");
  const index = geometry.index;

  assert.ok(group, `Geometry must contain material group ${materialIndex}.`);
  assert.ok(index, "Geometry must be indexed.");

  let minimum = Number.POSITIVE_INFINITY;

  for (let offset = group.start; offset < group.start + group.count; offset += 1) {
    minimum = Math.min(minimum, position.getY(index.getX(offset)));
  }

  return minimum;
}
