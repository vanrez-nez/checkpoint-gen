import assert from "node:assert/strict";
import * as THREE from "three";
import {
  DEFAULT_CHECKPOINT_CONFIG,
  createCheckpointGeometry,
  type CheckpointGeometryConfig,
} from "../src/checkpoint/generator";
import {
  DEFAULT_PILLAR_CONFIG,
  createPillarGeometry,
  getPillarBaseWidth,
  type PillarGeometryConfig,
} from "../src/pillar/generator";
import { createPillarPlacements } from "../src/pillar/layout";

const checkpointConfig: CheckpointGeometryConfig = {
  ...DEFAULT_CHECKPOINT_CONFIG,
  entries: { ...DEFAULT_CHECKPOINT_CONFIG.entries },
};
const pillarConfig: PillarGeometryConfig = {
  ...DEFAULT_PILLAR_CONFIG,
};

const checkpoint = createCheckpointGeometry(checkpointConfig);
const pillar = createPillarGeometry(pillarConfig);
assertValidGeometry(checkpoint.geometry, "checkpoint");
assertValidGeometry(pillar.geometry, "pillar");
assert.equal(pillar.geometry.boundingBox?.min.y, 0);
assert.ok(Math.abs((pillar.geometry.boundingBox?.max.y ?? 0) - pillarConfig.height) < 1e-6);
const defaultBaseHalfWidth = getPillarBaseWidth(pillarConfig) * 0.5;
assert.ok(Math.abs((pillar.geometry.boundingBox?.min.x ?? 0) + defaultBaseHalfWidth) < 1e-6);
assert.ok(Math.abs((pillar.geometry.boundingBox?.max.x ?? 0) - defaultBaseHalfWidth) < 1e-6);
assert.ok(Math.abs((pillar.geometry.boundingBox?.min.z ?? 0) + defaultBaseHalfWidth) < 1e-6);
assert.ok(Math.abs((pillar.geometry.boundingBox?.max.z ?? 0) - defaultBaseHalfWidth) < 1e-6);

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

const northOnly: CheckpointGeometryConfig = {
  ...checkpointConfig,
  entries: { north: true, east: false, south: false, west: false },
};
const northPlacements = createPillarPlacements(northOnly, pillarConfig);
const allPlacements = createPillarPlacements(checkpointConfig, pillarConfig);
assert.equal(northPlacements.length, 2);
assert.equal(allPlacements.length, 8);
assert.equal(new Set(allPlacements.map((placement) => placement.label)).size, 8);
assert.equal(new Set(allPlacements.map((placement) => placement.seed)).size, 8);
assert.ok(northPlacements.every((placement) => Number.isFinite(placement.x)));
assert.ok(northPlacements.every((placement) => Number.isFinite(placement.y)));
assert.ok(northPlacements.every((placement) => Number.isFinite(placement.z)));

const entryHalfWidth = checkpointConfig.radius * checkpointConfig.entryWidthRatio * 0.5;
const baseHalfWidth = defaultBaseHalfWidth;
const junctionDistance = Math.sqrt(
  checkpointConfig.radius ** 2 - entryHalfWidth ** 2,
);
const placementFrames = {
  north: { axisX: 0, axisZ: 1, lateralX: 1, lateralZ: 0 },
  east: { axisX: 1, axisZ: 0, lateralX: 0, lateralZ: -1 },
  south: { axisX: 0, axisZ: -1, lateralX: -1, lateralZ: 0 },
  west: { axisX: -1, axisZ: 0, lateralX: 0, lateralZ: 1 },
};

for (const placement of allPlacements) {
  const frame = placementFrames[placement.direction];
  const axial = placement.x * frame.axisX + placement.z * frame.axisZ;
  const lateral = placement.x * frame.lateralX + placement.z * frame.lateralZ;
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

for (const result of [
  checkpoint,
  pillar,
  repeatedPillar,
  changedSeed,
  hardEdges,
  moreCourses,
  moreSubdivisions,
  moreSteps,
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
