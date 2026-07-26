import assert from "node:assert/strict";
import * as THREE from "three";
import { CheckpointComposer } from "../src/checkpoint/composer";
import {
  CHECKPOINT_TYPES,
  checkpointTypeOptions,
  getCheckpointType,
  listCheckpointTypes,
} from "../src/checkpoint/registry";
import {
  DEFAULT_CIRCULAR_BEVEL,
  DEFAULT_CIRCULAR_LAYOUT,
  DEFAULT_CIRCULAR_STONE,
  CIRCULAR_LAYOUT_CONTROLS,
  toShellConfig,
  validateCircularLayout,
} from "../src/checkpoint/types/circular/config";
import {
  createCircularPlacements,
  createPolarEntryFrames,
} from "../src/checkpoint/types/circular/layout";
import {
  buildCircularShell,
  circularCenterMetrics,
} from "../src/checkpoint/types/circular/shell";
import {
  createDefaultCheckpointConfig,
  sectionsForScopes,
} from "../src/config/checkpoint-config";
import { validateControls, type ControlSpec } from "../src/config/control-spec";
import {
  ILLUMINATION_CONTROLS,
  VIEW_CONTROLS,
  DEFAULT_ILLUMINATION_CONFIG,
  DEFAULT_VIEW_CONFIG,
  createBevelControls,
  createStoneControls,
} from "../src/config/sections";
import {
  IDENTITY_MATRIX,
  createPlacementMatrix,
  type GeometryPart,
  type MaterialSlot,
  type PartSection,
} from "../src/geometry/part";
import { mergeParts } from "../src/geometry/merge-parts";
import {
  DEFAULT_FIRE_BOWL_CONFIG,
  FIRE_BOWL_CONTROLS,
} from "../src/props/fire-bowl/config";
import { createFireBowlGeometry } from "../src/props/fire-bowl/generator";
import {
  DEFAULT_FIRE_CONFIG,
  FIRE_CONTROLS,
  validateFireConfig,
} from "../src/props/fire/config";
import {
  VertexConeFireBatch,
  type VertexConeFireConfig,
} from "../src/props/fire/vertex-cone";
import {
  DEFAULT_PILLAR_CONFIG,
  PILLAR_BEVEL_CONTROLS,
  PILLAR_LAYOUT_CONTROLS,
  PILLAR_STONE_CONTROLS,
  toPillarGeometryConfig,
} from "../src/props/pillar/config";
import {
  createPillarGeometry,
  getPillarBaseWidth,
} from "../src/props/pillar/generator";
import {
  DEFAULT_OFFERING_CONFIG,
  OFFERING_CONTROLS,
  validateOfferingConfig,
} from "../src/props/offering/config";
import {
  calculateOfferingSupportCenter,
  calculateOfferingTransform,
  prepareOfferingGeometry,
} from "../src/props/offering/model";
import { MainScene } from "../src/scene/main";

const config = createDefaultCheckpointConfig();
const layout = DEFAULT_CIRCULAR_LAYOUT;
const pillarConfig = config.pillar;

// --- shell -----------------------------------------------------------------
const shell = buildCircularShell(
  toShellConfig(layout, DEFAULT_CIRCULAR_STONE, DEFAULT_CIRCULAR_BEVEL),
);
const pillar = createPillarGeometry(
  toPillarGeometryConfig(pillarConfig, pillarConfig.stone.seed),
);
const fireBowl = createFireBowlGeometry(
  { ...DEFAULT_FIRE_BOWL_CONFIG },
  pillarConfig.shaftWidth,
);
assertValidGeometry(shell.geometry, "shell");
assertValidGeometry(pillar.geometry, "pillar");
assertValidPart(fireBowl.geometry, "fire bowl");
assert.ok(Math.abs(
  (shell.geometry.boundingBox?.max.y ?? 0) - shell.centerTopY,
) < 1e-6);
assert.ok(Math.abs(shell.centerDiameter - layout.radius * 0.28) < 1e-12);

// The standalone metric helper must agree with what the shell actually built,
// since the composer reports the offering anchor from the helper alone.
const centerMetrics = circularCenterMetrics(layout.radius, layout.tierRiseRatio);
assert.ok(Math.abs(centerMetrics.centerTopY - shell.centerTopY) < 1e-12);
assert.ok(Math.abs(centerMetrics.centerDiameter - shell.centerDiameter) < 1e-12);

// The center block's vertex range is reported explicitly rather than assumed to
// be the tail of the buffer, which only held while it was the last stone added.
const flatCenterShell = buildCircularShell(toShellConfig(
  layout,
  DEFAULT_CIRCULAR_STONE,
  { ...DEFAULT_CIRCULAR_BEVEL, enabled: false },
));
const flatCenterPositions = flatCenterShell.geometry.getAttribute("position");
assert.equal(flatCenterShell.centerVertexCount, 4 + 4 * 4);
assert.equal(
  flatCenterShell.centerVertexStart + flatCenterShell.centerVertexCount,
  flatCenterPositions.count,
);

for (
  let index = flatCenterShell.centerVertexStart;
  index < flatCenterShell.centerVertexStart + flatCenterShell.centerVertexCount;
  index += 1
) {
  const y = flatCenterPositions.getY(index);

  if (y > 0) {
    assert.ok(Math.abs(y - flatCenterShell.centerTopY) < 1e-6);
  }
}

// --- offering --------------------------------------------------------------
const offeringGeometry = new THREE.BoxGeometry(2, 4, 1);
offeringGeometry.deleteAttribute("uv");
prepareOfferingGeometry(offeringGeometry);
assert.equal(offeringGeometry.getAttribute("uv").count, offeringGeometry.getAttribute("position").count);
assert.equal(offeringGeometry.getAttribute("vertexAo").count, offeringGeometry.getAttribute("position").count);
assert.equal(offeringGeometry.getAttribute("color").count, offeringGeometry.getAttribute("position").count);
assert.equal(
  (offeringGeometry.userData.baseUvs as Float32Array).length,
  offeringGeometry.getAttribute("position").count * 2,
);

const offeringBounds = new THREE.Box3(
  new THREE.Vector3(-1, -2, -0.5),
  new THREE.Vector3(1, 2, 0.5),
);
const offeringTransform = calculateOfferingTransform(offeringBounds, shell);
assert.ok(Math.abs(
  offeringTransform.scale * 2
    - shell.centerDiameter * DEFAULT_OFFERING_CONFIG.pedestalFit,
) < 1e-12);
assert.ok(Math.abs(
  offeringTransform.position.y + offeringBounds.min.y * offeringTransform.scale
    - shell.centerTopY,
) < 1e-12);
assert.ok(Math.abs(offeringTransform.position.x) < 1e-12);
assert.ok(Math.abs(offeringTransform.position.z) < 1e-12);
assert.equal(offeringTransform.rotationY, 0);

const adjustedOfferingTransform = calculateOfferingTransform(
  offeringBounds,
  shell,
  {
    ...DEFAULT_OFFERING_CONFIG,
    pedestalFit: 1.1,
    verticalOffset: 0.25,
    rotationDegrees: 90,
    materialScale: 2,
  },
);
assert.ok(Math.abs(
  adjustedOfferingTransform.scale * 2 - shell.centerDiameter * 1.1,
) < 1e-12);
assert.ok(Math.abs(
  adjustedOfferingTransform.position.y
    + offeringBounds.min.y * adjustedOfferingTransform.scale
    - shell.centerTopY
    - 0.25,
) < 1e-12);
assert.ok(Math.abs(adjustedOfferingTransform.rotationY - Math.PI * 0.5) < 1e-12);
assert.throws(
  () => validateOfferingConfig({ ...DEFAULT_OFFERING_CONFIG, pedestalFit: 0 }),
  /pedestal fit/,
);
assert.throws(
  () => validateOfferingConfig({ ...DEFAULT_OFFERING_CONFIG, materialScale: 8.1 }),
  /material scale/,
);

const offsetOffering = new THREE.Group();
const offeringBaseGeometry = new THREE.BoxGeometry(2, 1, 2);
const offeringUpperGeometry = new THREE.BoxGeometry(4, 3, 2);
const offeringBaseMesh = new THREE.Mesh(offeringBaseGeometry);
const offeringUpperMesh = new THREE.Mesh(offeringUpperGeometry);
offeringBaseMesh.position.set(-2, 0.5, 0);
offeringUpperMesh.position.set(1, 2.5, 0);
offsetOffering.add(offeringBaseMesh, offeringUpperMesh);
offsetOffering.updateMatrixWorld(true);
const offsetOfferingBounds = new THREE.Box3().setFromObject(offsetOffering);
const supportCenter = calculateOfferingSupportCenter(
  offsetOffering,
  offsetOfferingBounds,
);
assert.ok(Math.abs(supportCenter.x + 2) < 1e-12);
assert.ok(Math.abs(supportCenter.z) < 1e-12);
const supportAlignedTransform = calculateOfferingTransform(
  offsetOfferingBounds,
  shell,
  { ...DEFAULT_OFFERING_CONFIG },
  supportCenter,
);
assert.ok(Math.abs(
  supportAlignedTransform.position.x
    + supportCenter.x * supportAlignedTransform.scale,
) < 1e-12);

// --- pillar ----------------------------------------------------------------
assert.ok(Math.abs(pillar.geometry.boundingBox?.min.y ?? 1) < 1e-6);
assert.ok(Math.abs((pillar.geometry.boundingBox?.max.y ?? 0) - pillarConfig.height) < 1e-6);
const defaultBaseHalfWidth = getPillarBaseWidth(pillarConfig) * 0.5;
assert.ok(Math.abs((pillar.geometry.boundingBox?.min.x ?? 0) + defaultBaseHalfWidth) < 1e-6);
assert.ok(Math.abs((pillar.geometry.boundingBox?.max.x ?? 0) - defaultBaseHalfWidth) < 1e-6);
assert.ok(Math.abs((pillar.geometry.boundingBox?.min.z ?? 0) + defaultBaseHalfWidth) < 1e-6);
assert.ok(Math.abs((pillar.geometry.boundingBox?.max.z ?? 0) - defaultBaseHalfWidth) < 1e-6);
assert.equal(fireBowl.supportCount, 8);
assert.equal(fireBowl.footCount, 4);
// The pillar generator no longer emits groups; the composer owns that now.
assert.equal(pillar.geometry.groups.length, 0);
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

const repeatedPillar = createPillarGeometry(
  toPillarGeometryConfig(pillarConfig, pillarConfig.stone.seed),
);
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

const changedSeed = createPillarGeometry(
  toPillarGeometryConfig(pillarConfig, pillarConfig.stone.seed + 1),
);
assert.notDeepEqual(
  Array.from(changedSeed.geometry.getAttribute("position").array),
  Array.from(pillar.geometry.getAttribute("position").array),
  "Changing the pillar seed must change its masonry detail.",
);

const hardEdges = createPillarGeometry(toPillarGeometryConfig(
  { ...pillarConfig, bevel: { ...pillarConfig.bevel, enabled: false } },
  pillarConfig.stone.seed,
));
assert.ok(hardEdges.vertexCount < pillar.vertexCount);
assert.ok(hardEdges.triangleCount < pillar.triangleCount);

const moreCourses = createPillarGeometry(toPillarGeometryConfig(
  { ...pillarConfig, shaftCourses: pillarConfig.shaftCourses + 1 },
  pillarConfig.stone.seed,
));
const moreSubdivisions = createPillarGeometry(toPillarGeometryConfig(
  { ...pillarConfig, shaftSubdivisions: pillarConfig.shaftSubdivisions + 1 },
  pillarConfig.stone.seed,
));
const moreSteps = createPillarGeometry(toPillarGeometryConfig(
  { ...pillarConfig, baseSteps: pillarConfig.baseSteps + 1 },
  pillarConfig.stone.seed,
));
assert.ok(moreCourses.stoneCount > pillar.stoneCount);
assert.ok(moreSubdivisions.stoneCount > pillar.stoneCount);
assert.ok(moreSteps.stoneCount > pillar.stoneCount);

const extremePillars = [
  createPillarGeometry(toPillarGeometryConfig({
    height: 1,
    shaftWidth: 0.25,
    baseSteps: 1,
    shaftCourses: 1,
    shaftSubdivisions: 1,
    stone: { seed: 1, gapRatio: 0.002, sizeVariation: 0.05, displacement: 0.01 },
    bevel: { enabled: true, widthRatio: 0.02, depthRatio: 0.05, variation: 0 },
  }, 1)),
  createPillarGeometry(toPillarGeometryConfig({
    height: 12,
    shaftWidth: 3,
    baseSteps: 4,
    shaftCourses: 8,
    shaftSubdivisions: 4,
    stone: { seed: 2, gapRatio: 0.04, sizeVariation: 0.4, displacement: 0.2 },
    bevel: { enabled: true, widthRatio: 0.3, depthRatio: 0.6, variation: 0.6 },
  }, 2)),
];

for (const [index, result] of extremePillars.entries()) {
  assertValidGeometry(result.geometry, `extreme pillar ${index + 1}`);
}

// --- circular layout -------------------------------------------------------
const singleEntryPlacements = createCircularPlacements(
  { ...layout, entryCount: 1 },
  pillarConfig,
);
const allPlacements = createCircularPlacements(layout, pillarConfig);
assert.equal(singleEntryPlacements.length, 2);
assert.equal(allPlacements.length, layout.entryCount * 2);
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
assert.ok(Math.abs(threeEntryFrames[0]?.angle ?? 1) < 1e-12);
assert.ok(Math.abs((threeEntryFrames[1]?.angle ?? 0) - Math.PI * 2 / 3) < 1e-12);
assert.ok(Math.abs((threeEntryFrames[2]?.angle ?? 0) - Math.PI * 4 / 3) < 1e-12);
assertValidGeometry(
  buildCircularShell(toShellConfig(
    { ...layout, entryCount: 3 },
    DEFAULT_CIRCULAR_STONE,
    DEFAULT_CIRCULAR_BEVEL,
  )).geometry,
  "three-entry shell",
);

const entryHalfWidth = layout.radius * layout.entryWidthRatio * 0.5;
const junctionDistance = Math.sqrt(layout.radius ** 2 - entryHalfWidth ** 2);

for (const placement of allPlacements) {
  const axisX = Math.sin(placement.angle);
  const axisZ = Math.cos(placement.angle);
  const lateralX = Math.cos(placement.angle);
  const lateralZ = -Math.sin(placement.angle);
  const axial = placement.x * axisX + placement.z * axisZ;
  const lateral = placement.x * lateralX + placement.z * lateralZ;
  assert.ok(Math.abs(axial - defaultBaseHalfWidth - junctionDistance) < 1e-9);
  assert.ok(Math.abs(Math.abs(lateral) - defaultBaseHalfWidth - entryHalfWidth) < 1e-9);
  assert.equal(placement.y, 0);
}

// --- part merging ----------------------------------------------------------
// Synthetic parts first: distinct patterned base arrays make the concatenation
// order observable, and passing iron before stone proves the merger reorders by
// material slot rather than by argument order.
const syntheticStoneGeometry = new THREE.BoxGeometry(1, 1, 1);
const syntheticIronGeometry = new THREE.BoxGeometry(2, 2, 2);
const syntheticStone = createSyntheticPart(
  "synthetic/stone",
  "layout",
  "stone",
  syntheticStoneGeometry,
  IDENTITY_MATRIX,
  3,
);
const syntheticIron = createSyntheticPart(
  "synthetic/iron",
  "fireBowls",
  "iron",
  syntheticIronGeometry,
  new THREE.Matrix4().makeTranslation(5, 0, 0),
  0,
);
const syntheticStoneCount = syntheticStoneGeometry.getAttribute("position").count;
const syntheticIronCount = syntheticIronGeometry.getAttribute("position").count;
const syntheticMerge = mergeParts([syntheticIron, syntheticStone]);
const syntheticPositions = syntheticMerge.geometry.getAttribute("position");
const syntheticIndex = syntheticMerge.geometry.getIndex();

assert.ok(syntheticIndex, "Merged geometry must be indexed.");
assert.equal(syntheticPositions.count, syntheticStoneCount + syntheticIronCount);
assert.equal(
  syntheticIndex.count,
  (syntheticStoneGeometry.getIndex()?.count ?? 0) + (syntheticIronGeometry.getIndex()?.count ?? 0),
);
assert.equal(syntheticMerge.totals.vertexCount, syntheticPositions.count);
assert.equal(syntheticMerge.sections.layout.vertexCount, syntheticStoneCount);
assert.equal(syntheticMerge.sections.fireBowls.vertexCount, syntheticIronCount);
assert.equal(syntheticMerge.sections.layout.stoneCount, 3);
assert.equal(syntheticMerge.sections.pillars.partCount, 0);

assert.equal(syntheticMerge.geometry.groups.length, 2);
assert.equal(syntheticMerge.geometry.groups[0]?.materialIndex, 0);
assert.equal(syntheticMerge.geometry.groups[1]?.materialIndex, 1);
assert.equal(syntheticMerge.geometry.groups[0]?.start, 0);
assert.equal(
  syntheticMerge.geometry.groups[0]?.count,
  syntheticStoneGeometry.getIndex()?.count,
);
assert.equal(
  syntheticMerge.geometry.groups[1]?.start,
  syntheticMerge.geometry.groups[0]?.count,
);
assert.equal(
  syntheticMerge.geometry.groups.reduce((sum, group) => sum + group.count, 0),
  syntheticIndex.count,
);

const syntheticStonePositions = syntheticStoneGeometry.getAttribute("position");
const syntheticIronPositions = syntheticIronGeometry.getAttribute("position");

for (let vertex = 0; vertex < syntheticStoneCount; vertex += 1) {
  assert.equal(syntheticPositions.getX(vertex), syntheticStonePositions.getX(vertex));
  assert.equal(syntheticPositions.getY(vertex), syntheticStonePositions.getY(vertex));
}

for (let vertex = 0; vertex < syntheticIronCount; vertex += 1) {
  const merged = syntheticStoneCount + vertex;
  assert.ok(Math.abs(
    syntheticPositions.getX(merged) - (syntheticIronPositions.getX(vertex) + 5),
  ) < 1e-6);
  assert.ok(Math.abs(
    syntheticPositions.getZ(merged) - syntheticIronPositions.getZ(vertex),
  ) < 1e-6);
}

for (let cursor = 0; cursor < syntheticIndex.count; cursor += 1) {
  const value = syntheticIndex.getX(cursor);
  assert.ok(Number.isInteger(value) && value >= 0 && value < syntheticPositions.count);
}

const syntheticIronIndex = syntheticIronGeometry.getIndex();
assert.ok(syntheticIronIndex);
const syntheticIronIndexStart = syntheticMerge.geometry.groups[1]?.start ?? 0;

for (let cursor = 0; cursor < syntheticIronIndex.count; cursor += 1) {
  assert.equal(
    syntheticIndex.getX(syntheticIronIndexStart + cursor),
    syntheticIronIndex.getX(cursor) + syntheticStoneCount,
  );
}

const syntheticBaseUvs = syntheticMerge.geometry.userData.baseUvs as Float32Array;
const syntheticAo = syntheticMerge.geometry.userData.vertexAoBase as Float32Array;
const syntheticShadow = syntheticMerge.geometry.userData.bakedShadowBase as Float32Array;
assert.equal(syntheticBaseUvs.length, syntheticPositions.count * 2);
assert.equal(syntheticAo.length, syntheticPositions.count);
assert.equal(syntheticShadow.length, syntheticPositions.count);
assert.deepEqual(
  Array.from(syntheticBaseUvs.subarray(0, syntheticStoneCount * 2)),
  Array.from(syntheticStoneGeometry.userData.baseUvs as Float32Array),
);
assert.deepEqual(
  Array.from(syntheticBaseUvs.subarray(syntheticStoneCount * 2)),
  Array.from(syntheticIronGeometry.userData.baseUvs as Float32Array),
);
assert.deepEqual(
  Array.from(syntheticAo.subarray(0, syntheticStoneCount)),
  Array.from(syntheticStoneGeometry.userData.vertexAoBase as Float32Array),
);
// Live attributes are seeded from the base arrays, never from the part's own,
// so a part the scene already scaled cannot leak that state into the merge.
assert.deepEqual(
  Array.from(syntheticMerge.geometry.getAttribute("uv").array),
  Array.from(syntheticBaseUvs),
);
assert.deepEqual(
  Array.from(syntheticMerge.geometry.getAttribute("vertexAo").array),
  Array.from(syntheticAo),
);
assert.ok(
  Array.from(syntheticMerge.geometry.getAttribute("color").array).every((value) => value === 1),
);

// A single-slot composition still emits one full-coverage group, because a mesh
// with an array material draws nothing when the geometry has no groups.
const stoneOnlyMerge = mergeParts([syntheticStone]);
assert.equal(stoneOnlyMerge.geometry.groups.length, 1);
assert.equal(stoneOnlyMerge.geometry.groups[0]?.materialIndex, 0);
assert.equal(stoneOnlyMerge.geometry.groups[0]?.start, 0);
assert.equal(
  stoneOnlyMerge.geometry.groups[0]?.count,
  stoneOnlyMerge.geometry.getIndex()?.count,
);
assert.equal(stoneOnlyMerge.sections.fireBowls.vertexCount, 0);

// Contract violations fail loudly, naming the offending part.
const missingUserDataGeometry = new THREE.BoxGeometry(1, 1, 1);
assert.throws(
  () => mergeParts([{
    id: "broken/part",
    section: "layout",
    slot: "stone",
    geometry: missingUserDataGeometry,
    matrix: IDENTITY_MATRIX,
    stoneCount: 0,
  }]),
  /broken\/part.*userData\.baseUvs/,
);
assert.throws(
  () => mergeParts([createSyntheticPart(
    "mirrored/part",
    "layout",
    "stone",
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.Matrix4().makeScale(-1, 1, 1),
    0,
  )]),
  /mirrored\/part.*mirrored or degenerate/,
);

// --- composition -----------------------------------------------------------
const composer = new CheckpointComposer();
const composition = composer.build(config);
const compositionPositions = composition.geometry.getAttribute("position");
const compositionNormals = composition.geometry.getAttribute("normal");
assertValidGeometry(composition.geometry, "composition");

assert.equal(composition.sections.layout.vertexCount, shell.vertexCount);
assert.equal(composition.sections.layout.stoneCount, shell.stoneCount);
assert.equal(
  composition.sections.pillars.vertexCount,
  pillar.vertexCount * allPlacements.length,
);
assert.equal(
  composition.sections.pillars.stoneCount,
  pillar.stoneCount * allPlacements.length,
);
assert.equal(
  composition.sections.fireBowls.vertexCount,
  fireBowl.vertexCount * allPlacements.length,
);
assert.equal(
  composition.sections.fireBowls.triangleCount,
  fireBowl.triangleCount * allPlacements.length,
);
assert.equal(
  composition.totals.vertexCount,
  shell.vertexCount
    + (pillar.vertexCount + fireBowl.vertexCount) * allPlacements.length,
);
assert.equal(
  composition.totals.triangleCount,
  shell.triangleCount
    + (pillar.triangleCount + fireBowl.triangleCount) * allPlacements.length,
);

// Exactly two coalesced groups, unlike mergeGeometries' one-per-input.
assert.equal(composition.geometry.groups.length, 2);
assert.equal(composition.geometry.groups[0]?.materialIndex, 0);
assert.equal(composition.geometry.groups[1]?.materialIndex, 1);
assert.equal(
  composition.geometry.groups.reduce((sum, group) => sum + group.count, 0),
  composition.geometry.getIndex()?.count,
);

// The iron slot starts exactly at the pillar top — end-to-end proof that the
// bowl's placement matrix reproduces the old geometry-mutating translate.
assert.ok(Math.abs(
  groupMinimumY(composition.geometry, 1) - pillarConfig.height,
) < 1e-6);

// Anchors describe the props that stay outside the merged geometry.
assert.ok(composition.anchors.offering);
assert.ok(Math.abs(
  composition.anchors.offering.centerTopY - shell.centerTopY,
) < 1e-12);
assert.equal(composition.anchors.flames.length, allPlacements.length);
assert.equal(composition.anchors.glows.length, layout.entryCount);
assert.ok(composition.anchors.flames.every(
  (flame) => Math.abs(flame.y - pillarConfig.height) < 1e-9,
));

// The shell keeps the leading vertex range untouched, so per-part determinism
// survived composition.
for (let vertex = 0; vertex < shell.vertexCount; vertex += 1) {
  assert.equal(
    compositionPositions.getX(vertex),
    shell.geometry.getAttribute("position").getX(vertex),
  );
  assert.equal(
    compositionPositions.getY(vertex),
    shell.geometry.getAttribute("position").getY(vertex),
  );
}

// Placed pillars match the same geometry transformed by hand. Entry 0 is
// axis-aligned, so a rotated placement is probed too — otherwise a dropped
// rotation would pass unnoticed.
const probeVertex = new THREE.Vector3();
const probeNormal = new THREE.Vector3();
const rotatedPlacementIndex = allPlacements.findIndex(
  (placement) => Math.abs(placement.rotationY) > 1e-6,
);
assert.ok(rotatedPlacementIndex > 0, "Expected at least one rotated placement.");
const probePillars: { geometry: THREE.BufferGeometry }[] = [];

for (const placementIndex of [0, rotatedPlacementIndex]) {
  const probePlacement = allPlacements[placementIndex];
  assert.ok(probePlacement);
  // Each placement derives its own seed, so the expected masonry must be
  // regenerated with that seed rather than reusing the base-seed pillar.
  const probePillar = createPillarGeometry(
    toPillarGeometryConfig(pillarConfig, probePlacement.seed),
  );
  probePillars.push(probePillar);
  const pillarPositions = probePillar.geometry.getAttribute("position");
  const pillarNormals = probePillar.geometry.getAttribute("normal");
  const probeMatrix = createPlacementMatrix(
    probePlacement.x,
    probePlacement.y,
    probePlacement.z,
    probePlacement.rotationY,
  );
  const probeNormalMatrix = new THREE.Matrix3().getNormalMatrix(probeMatrix);
  const partStart = shell.vertexCount + placementIndex * pillar.vertexCount;

  for (let vertex = 0; vertex < pillarPositions.count; vertex += 1) {
    probeVertex.set(
      pillarPositions.getX(vertex),
      pillarPositions.getY(vertex),
      pillarPositions.getZ(vertex),
    ).applyMatrix4(probeMatrix);
    const merged = partStart + vertex;
    assert.ok(Math.abs(compositionPositions.getX(merged) - probeVertex.x) < 1e-5);
    assert.ok(Math.abs(compositionPositions.getY(merged) - probeVertex.y) < 1e-5);
    assert.ok(Math.abs(compositionPositions.getZ(merged) - probeVertex.z) < 1e-5);

    probeNormal.set(
      pillarNormals.getX(vertex),
      pillarNormals.getY(vertex),
      pillarNormals.getZ(vertex),
    ).applyMatrix3(probeNormalMatrix);

    if (probeNormal.lengthSq() > 0) {
      probeNormal.normalize();
    }

    assert.ok(
      Math.abs(compositionNormals.getX(merged) - probeNormal.x) < 1e-5
        && Math.abs(compositionNormals.getY(merged) - probeNormal.y) < 1e-5
        && Math.abs(compositionNormals.getZ(merged) - probeNormal.z) < 1e-5,
      `Normal ${vertex} of placement ${placementIndex} was not transformed.`,
    );
  }
}

// Rotating a part must not denormalize normals or introduce new degenerate
// ones. The fire bowl ships two zero-length normals per bowl from
// computeVertexNormals over degenerate triangles; that predates composition.
const expectedZeroNormals = countZeroNormals(fireBowl.geometry.getAttribute("normal"))
  * allPlacements.length;
let zeroNormals = 0;
let worstNormalError = 0;

for (let vertex = 0; vertex < compositionNormals.count; vertex += 1) {
  const length = Math.hypot(
    compositionNormals.getX(vertex),
    compositionNormals.getY(vertex),
    compositionNormals.getZ(vertex),
  );

  if (length === 0) {
    zeroNormals += 1;
  } else {
    worstNormalError = Math.max(worstNormalError, Math.abs(length - 1));
  }
}

assert.equal(zeroNormals, expectedZeroNormals);
assert.ok(worstNormalError < 1e-5, `Merged normals drifted by ${worstNormalError}.`);

// Building the same config twice is deterministic.
const repeatedComposition = new CheckpointComposer().build(config);
assert.deepEqual(
  Array.from(repeatedComposition.geometry.getAttribute("position").array),
  Array.from(compositionPositions.array),
);
assert.deepEqual(
  Array.from(repeatedComposition.geometry.getIndex()?.array ?? []),
  Array.from(composition.geometry.getIndex()?.array ?? []),
);

// A scoped rebuild must equal a full rebuild of the same mutated config, and
// must leave the cached shell byte-identical. This is what stands between the
// part cache and a stale-geometry bug.
const mutatedConfig = createDefaultCheckpointConfig();
mutatedConfig.pillar.height = 2;
const incrementalComposer = new CheckpointComposer();
incrementalComposer.build(createDefaultCheckpointConfig());
const incremental = incrementalComposer.build(
  mutatedConfig,
  sectionsForScopes(["pillars"]),
);
const fullRebuild = new CheckpointComposer().build(mutatedConfig);
assert.deepEqual(
  Array.from(incremental.geometry.getAttribute("position").array),
  Array.from(fullRebuild.geometry.getAttribute("position").array),
  "An incremental rebuild must match a full rebuild of the same config.",
);

for (let vertex = 0; vertex < shell.vertexCount; vertex += 1) {
  assert.equal(
    incremental.geometry.getAttribute("position").getX(vertex),
    shell.geometry.getAttribute("position").getX(vertex),
  );
}

// Bowls off collapses to a single stone group and drops every fire anchor.
const noBowlConfig = createDefaultCheckpointConfig();
noBowlConfig.fireBowl.enabled = false;
const noBowlComposition = new CheckpointComposer().build(noBowlConfig);
assert.equal(noBowlComposition.geometry.groups.length, 1);
assert.equal(noBowlComposition.geometry.groups[0]?.materialIndex, 0);
assert.equal(
  noBowlComposition.geometry.groups[0]?.count,
  noBowlComposition.geometry.getIndex()?.count,
);
assert.equal(noBowlComposition.sections.fireBowls.vertexCount, 0);
assert.equal(noBowlComposition.anchors.flames.length, 0);
assert.equal(noBowlComposition.anchors.glows.length, 0);

// --- registry --------------------------------------------------------------
assert.ok(listCheckpointTypes().length >= 1);
assert.equal(
  new Set(CHECKPOINT_TYPES.map((type) => type.id)).size,
  CHECKPOINT_TYPES.length,
  "Checkpoint type ids must be unique.",
);
assert.throws(() => getCheckpointType("nope"), /Unknown checkpoint type/);
assert.deepEqual(checkpointTypeOptions(), { Circular: "circular" });

for (const definition of CHECKPOINT_TYPES) {
  // Props form a dependency chain: flames need a bowl, bowls need a pillar.
  if (definition.props.includes("fire")) {
    assert.ok(definition.props.includes("fireBowl"), `${definition.id}: fire needs fireBowl`);
  }
  if (definition.props.includes("fireBowl")) {
    assert.ok(definition.props.includes("pillar"), `${definition.id}: fireBowl needs pillar`);
  }
  assert.ok(definition.layoutControls.length > 0, `${definition.id} has no layout controls`);
  assert.doesNotThrow(() => definition.validateLayout(definition.cloneLayout()));
}

// --- control specs ---------------------------------------------------------
// Every spec must describe a real field whose default sits inside its own
// range. This is what makes the UI/validator range drift that existed before
// impossible to reintroduce.
assertSpecCoverage(CIRCULAR_LAYOUT_CONTROLS, DEFAULT_CIRCULAR_LAYOUT, "circular layout");
assertSpecCoverage(createStoneControls(["layout"]), DEFAULT_CIRCULAR_STONE, "circular stone");
assertSpecCoverage(createBevelControls(["layout"]), DEFAULT_CIRCULAR_BEVEL, "circular bevel");
assertSpecCoverage(PILLAR_LAYOUT_CONTROLS, DEFAULT_PILLAR_CONFIG, "pillar layout");
assertSpecCoverage(PILLAR_STONE_CONTROLS, DEFAULT_PILLAR_CONFIG.stone, "pillar stone");
assertSpecCoverage(PILLAR_BEVEL_CONTROLS, DEFAULT_PILLAR_CONFIG.bevel, "pillar bevel");
assertSpecCoverage(FIRE_BOWL_CONTROLS, DEFAULT_FIRE_BOWL_CONFIG, "fire bowl");
assertSpecCoverage(FIRE_CONTROLS, DEFAULT_FIRE_CONFIG, "fire");
assertSpecCoverage(OFFERING_CONTROLS, DEFAULT_OFFERING_CONFIG, "offering");
assertSpecCoverage(VIEW_CONTROLS, DEFAULT_VIEW_CONFIG, "view");
assertSpecCoverage(ILLUMINATION_CONTROLS, DEFAULT_ILLUMINATION_CONFIG, "illumination");

// --- validators ------------------------------------------------------------
assert.throws(
  () => createPillarGeometry(toPillarGeometryConfig(
    { ...pillarConfig, baseSteps: 0 },
    pillarConfig.stone.seed,
  )),
  /Base steps/,
);
assert.throws(
  () => createPillarGeometry(toPillarGeometryConfig(
    { ...pillarConfig, height: 0 },
    pillarConfig.stone.seed,
  )),
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
  () => validateCircularLayout({ ...layout, entryCount: 0 }),
  /Entry count/,
);
assert.throws(
  () => validateCircularLayout({ ...layout, entryCount: 9 }),
  /Entry count/,
);
assert.throws(
  () => validateFireConfig({ ...DEFAULT_FIRE_CONFIG, scale: 0 }),
  /Fire scale/,
);
assert.throws(
  () => validateFireConfig({ ...DEFAULT_FIRE_CONFIG, radius: 0 }),
  /Fire radius/,
);
assert.throws(
  () => validateFireConfig({ ...DEFAULT_FIRE_CONFIG, glowFlicker: 0.51 }),
  /Fire glow flicker/,
);

// --- fire batch ------------------------------------------------------------
const fireBatch = new VertexConeFireBatch(DEFAULT_FIRE_CONFIG.radialSegments, 16);
const fireMaterial = fireBatch.object.material;
const initialFireGeometry = fireBatch.object.geometry;
const fireBatchConfig: Omit<VertexConeFireConfig, "placements"> = {
  enabled: DEFAULT_FIRE_CONFIG.enabled,
  scale: DEFAULT_FIRE_CONFIG.scale,
  radius: DEFAULT_FIRE_CONFIG.radius,
  height: DEFAULT_FIRE_CONFIG.height,
  baseHeight: DEFAULT_FIRE_CONFIG.baseHeight,
  speed: DEFAULT_FIRE_CONFIG.speed,
  noiseScale: DEFAULT_FIRE_CONFIG.noiseScale,
  turbulence: DEFAULT_FIRE_CONFIG.turbulence,
  intensity: DEFAULT_FIRE_CONFIG.intensity,
  radialSegments: DEFAULT_FIRE_CONFIG.radialSegments,
};
const defaultFireStats = fireBatch.update({
  ...fireBatchConfig,
  placements: composition.anchors.flames,
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

// Flames sit at the anchor plus the flame base offset; the batch no longer
// knows anything about pillar height.
const firstFireMatrix = new THREE.Matrix4();
const firstFirePosition = new THREE.Vector3();
const firstFlameAnchor = composition.anchors.flames[0];
assert.ok(firstFlameAnchor);
fireBatch.object.getMatrixAt(0, firstFireMatrix);
firstFirePosition.setFromMatrixPosition(firstFireMatrix);
assert.ok(Math.abs(firstFirePosition.x - firstFlameAnchor.x) < 1e-6);
assert.ok(Math.abs(firstFirePosition.z - firstFlameAnchor.z) < 1e-6);
assert.ok(Math.abs(
  firstFirePosition.y - firstFlameAnchor.y - DEFAULT_FIRE_CONFIG.baseHeight,
) < 1e-6);

fireBatch.update({
  ...fireBatchConfig,
  radius: DEFAULT_FIRE_CONFIG.radius * 2,
  height: DEFAULT_FIRE_CONFIG.height * 2,
  baseHeight: DEFAULT_FIRE_CONFIG.baseHeight * 2,
  placements: composition.anchors.flames.slice(0, 2),
});
assert.equal(fireBatch.object.geometry, initialFireGeometry);
assert.equal(fireBatch.object.material, fireMaterial);

const detailedFireStats = fireBatch.update({
  ...fireBatchConfig,
  radialSegments: 64,
  placements: composition.anchors.flames,
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
  placements: composition.anchors.flames,
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

// --- scene -----------------------------------------------------------------
const sceneConfig = createDefaultCheckpointConfig();
const scene = new MainScene(sceneConfig);
const sceneStats = scene.getStats();
assert.equal(sceneStats.sections.pillars.partCount, 8);
assert.equal(sceneStats.sections.pillars.vertexCount, pillar.vertexCount * 8);
assert.equal(sceneStats.sections.fireBowls.partCount, 8);
assert.equal(sceneStats.sections.fireBowls.vertexCount, fireBowl.vertexCount * 8);
assert.equal(sceneStats.totals.vertexCount, composition.totals.vertexCount);
assert.equal(sceneStats.flames.count, 8);
assert.equal(sceneStats.flames.vertexCount, 3_400);
assert.equal(sceneStats.flames.triangleCount, 6_016);
assert.equal(sceneStats.flames.drawCallCount, 1);
assert.equal(sceneStats.glowLightCount, 4);
// One static mesh for the whole checkpoint, where there used to be nine (the
// plate plus one per pillar). The flame batch is instanced and stays separate.
const staticMeshes = scene.scene.children.filter((child) => (
  child instanceof THREE.Mesh
  && !(child as THREE.InstancedMesh).isInstancedMesh
));
assert.equal(staticMeshes.length, 1);
assert.equal(staticMeshes[0]?.name, "Checkpoint");
assert.equal(
  scene.scene.children.filter((child) => child.type === "PointLight").length,
  4,
);
assert.equal(scene.scene.getObjectByName("Fire bowl flames")?.type, "Mesh");

const checkpointMesh = scene.scene.getObjectByName("Checkpoint") as THREE.Mesh;
assert.ok(Array.isArray(checkpointMesh.material));
assert.equal((checkpointMesh.material as THREE.Material[]).length, 2);
assert.equal(checkpointMesh.geometry.groups.length, 2);

// Fire retuning must not rebuild geometry or recreate the flame batch.
const firstGlowLight = scene.scene.children.find((child) => child.type === "PointLight");
const flameObject = scene.scene.getObjectByName("Fire bowl flames") as THREE.Mesh;
const flameGeometry = flameObject.geometry;
const checkpointGeometry = checkpointMesh.geometry;
sceneConfig.fire.speed = 5;
sceneConfig.fire.noiseScale = 6;
sceneConfig.fire.turbulence = 1.5;
sceneConfig.fire.intensity = 2;
sceneConfig.fire.glowIntensity = 1.2;
const tunedFireStats = scene.updateFireEffects(sceneConfig);
assert.equal(tunedFireStats.flames.count, 8);
assert.equal(scene.scene.getObjectByName("Fire bowl flames"), flameObject);
assert.equal(flameObject.geometry, flameGeometry);
assert.equal(checkpointMesh.geometry, checkpointGeometry);
assert.equal(
  scene.scene.children.find((child) => child.type === "PointLight"),
  firstGlowLight,
);
assert.equal((firstGlowLight as THREE.PointLight).intensity, 1.2);

const eightEntryConfig = createDefaultCheckpointConfig();
eightEntryConfig.layouts.circular.entryCount = 8;
const maximumFireStats = scene.rebuild(eightEntryConfig);
assert.equal(maximumFireStats.sections.pillars.partCount, 16);
assert.equal(maximumFireStats.flames.count, 16);
assert.equal(maximumFireStats.flames.drawCallCount, 1);
assert.equal(maximumFireStats.glowLightCount, 8);
assert.equal(
  scene.scene.children.filter((child) => child.type === "PointLight").length,
  8,
);

const noFireConfig = createDefaultCheckpointConfig();
noFireConfig.fireBowl.enabled = false;
const noFireStats = scene.rebuild(noFireConfig);
assert.equal(noFireStats.flames.count, 0);
assert.equal(noFireStats.flames.drawCallCount, 0);
assert.equal(noFireStats.glowLightCount, 0);
assert.equal(noFireStats.sections.fireBowls.partCount, 0);
assert.equal(
  scene.scene.children.filter((child) => child.type === "PointLight").length,
  0,
);

// Bowl size is independent of flame size.
const scaledBowlConfig = createDefaultCheckpointConfig();
scaledBowlConfig.fireBowl.scale = 2;
const independentFireStats = scene.rebuild(scaledBowlConfig);
assert.equal(independentFireStats.flames.vertexCount, 3_400);
assert.equal(independentFireStats.flames.triangleCount, 6_016);
assert.equal(independentFireStats.glowLightCount, 4);

const disabledFlameConfig = createDefaultCheckpointConfig();
disabledFlameConfig.fire.enabled = false;
const explicitlyDisabledFireStats = scene.updateFireEffects(disabledFlameConfig);
assert.equal(explicitlyDisabledFireStats.flames.count, 0);
assert.equal(explicitlyDisabledFireStats.glowLightCount, 0);
scene.dispose();

// --- cleanup ---------------------------------------------------------------
for (const result of [
  shell,
  pillar,
  fireBowl,
  detailedFireBowl,
  scaledFireBowl,
  repeatedPillar,
  changedSeed,
  hardEdges,
  moreCourses,
  moreSubdivisions,
  moreSteps,
  flatCenterShell,
  ...extremePillars,
  ...probePillars,
]) {
  result.geometry.dispose();
}
composer.dispose();
syntheticMerge.geometry.dispose();
stoneOnlyMerge.geometry.dispose();
composition.geometry.dispose();
repeatedComposition.geometry.dispose();
incremental.geometry.dispose();
fullRebuild.geometry.dispose();
noBowlComposition.geometry.dispose();
syntheticStoneGeometry.dispose();
syntheticIronGeometry.dispose();
missingUserDataGeometry.dispose();
offeringGeometry.dispose();
offeringBaseGeometry.dispose();
offeringUpperGeometry.dispose();

console.log(
  `Geometry sanity passed: ${pillar.stoneCount} stones per default pillar, `
  + `${allPlacements.length} default placements, `
  + `${composition.totals.vertexCount} composed vertices in `
  + `${composition.geometry.groups.length} material groups.`,
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

/**
 * The part contract, which is looser than a renderable geometry: a part needs
 * position, normal, an index and the three userData base arrays, but the merger
 * synthesises uv/vertexAo/color from userData rather than reading them.
 */
function assertValidPart(geometry: THREE.BufferGeometry, label: string): void {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const index = geometry.index;

  assert.ok(position.count > 0, `${label} must contain vertices.`);
  assert.equal(normal.count, position.count);
  assert.ok(index && index.count > 0, `${label} must contain indices.`);
  assert.equal(index.count % 3, 0);
  assert.ok(Array.from(index.array).every((value) => value >= 0 && value < position.count));
  assert.equal(
    (geometry.userData.baseUvs as Float32Array).length,
    position.count * 2,
    `${label} userData.baseUvs length`,
  );
  assert.equal(
    (geometry.userData.vertexAoBase as Float32Array).length,
    position.count,
    `${label} userData.vertexAoBase length`,
  );
  assert.equal(
    (geometry.userData.bakedShadowBase as Float32Array).length,
    position.count,
    `${label} userData.bakedShadowBase length`,
  );
}

/**
 * Wraps a plain geometry as a part, fabricating the three userData base arrays
 * with distinct patterned values so concatenation order is observable.
 */
function createSyntheticPart(
  id: string,
  section: PartSection,
  slot: MaterialSlot,
  geometry: THREE.BufferGeometry,
  matrix: THREE.Matrix4,
  stoneCount: number,
): GeometryPart {
  const count = geometry.getAttribute("position").count;
  geometry.userData.baseUvs = Float32Array.from(
    { length: count * 2 },
    (_, index) => index * 0.5,
  );
  geometry.userData.vertexAoBase = Float32Array.from(
    { length: count },
    (_, index) => index * 0.25,
  );
  geometry.userData.bakedShadowBase = new Float32Array(count).fill(0.5);

  return { id, section, slot, geometry, matrix, stoneCount };
}

function countZeroNormals(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
): number {
  let zero = 0;

  for (let vertex = 0; vertex < attribute.count; vertex += 1) {
    const length = Math.hypot(
      attribute.getX(vertex),
      attribute.getY(vertex),
      attribute.getZ(vertex),
    );

    if (length === 0) {
      zero += 1;
    }
  }

  return zero;
}

function assertSpecCoverage<T extends object>(
  specs: readonly ControlSpec<T>[],
  defaults: Readonly<T>,
  label: string,
): void {
  for (const spec of specs) {
    assert.ok(
      spec.key in defaults,
      `${label}: spec "${spec.key}" has no matching default.`,
    );

    if (spec.kind === "number") {
      const value = defaults[spec.key] as unknown as number;
      assert.ok(
        typeof value === "number" && value >= spec.min && value <= spec.max,
        `${label}: default ${spec.key}=${String(value)} outside [${spec.min}, ${spec.max}].`,
      );
    }
  }

  assert.doesNotThrow(
    () => validateControls({ ...defaults }, specs),
    `${label}: defaults must satisfy their own spec table.`,
  );
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
