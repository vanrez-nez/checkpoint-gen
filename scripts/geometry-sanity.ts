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
  DEFAULT_PILLAR_CONFIG,
  createPillarGeometry,
  getPillarBaseWidth,
  type PillarGeometryConfig,
} from "../src/pillar/generator";
import { createPillarPlacements } from "../src/pillar/layout";

const checkpointConfig: CheckpointGeometryConfig = {
  ...DEFAULT_CHECKPOINT_CONFIG,
};
const pillarConfig: PillarGeometryConfig = {
  ...DEFAULT_PILLAR_CONFIG,
  fireBowl: { ...DEFAULT_PILLAR_CONFIG.fireBowl },
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
