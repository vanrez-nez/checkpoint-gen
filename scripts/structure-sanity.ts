import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { finalizeGeometry } from "../src/geometry/finalize";
import { mergeParts } from "../src/geometry/merge-parts";
import { materialSlotIndex, type MaterialSlot } from "../src/geometry/part";
import { SolidBuilder } from "../src/geometry/solid-builder";
import { DEFAULT_FIRE_BOWL_CONFIG } from "../src/props/fire-bowl/config";
import {
  StoneGeometryBuilder,
  displacementDistance,
  insetAndJitter,
} from "../src/geometry/stone-builder";
import {
  DEFAULT_MASS_LAYOUT,
  DEFAULT_MASS_STONE_CONFIG,
  HEIGHT_CURVE_OPTIONS,
  MASS_LAYOUT_BASELINE,
  MASS_SLOT_FEATURE_IDS,
  cloneMassLayout,
  cloneMassSlots,
  heightCurveBezier,
  toHeightCurve,
  toMasonry,
  toStructureSpec,
  validateMassLayout,
  type MassLayoutConfig,
  type MassSlotFeatureId,
} from "../src/structure/families/mass/config";
import {
  divideCourseRing,
  divideCourses,
  divideRun,
  masonrySeed,
  type MasonryRule,
} from "../src/structure/kernel/masonry";
import { DETAIL_LEVELS } from "../src/structure/kernel/detail";
import { hashSeed } from "../src/geometry/random";
import { buildMassShell } from "../src/structure/mass/shell";
import {
  findBackfaces,
  findBuriedFaces,
  findCoincidentFaces,
  findStoneShadingBreaks,
} from "./mesh-invariants";
import {
  CURVE_SHAPE_IDS,
  CURVE_SHAPES,
  LINEAR_BEZIER,
  LINEAR_CURVE,
  bezierCurve,
  distributeByCurve,
  evaluateCurve,
  type CurveShape,
} from "../src/structure/kernel/curve";
import { massStructure } from "../src/structure/families/mass";
import {
  STELA_PRESETS,
  cloneStelaLayout,
  resolveStelaGraph,
  toStelaBevel,
  toStelaMasonry,
  validateStelaLayout,
  type StelaLayoutConfig,
} from "../src/structure/families/stelae/config";
import { resolveStela } from "../src/structure/families/stelae/resolve";
import {
  patchIndex,
  allSlots,
  serializeGraph,
  StructureGraphBuilder,
  type CellOpeningRecord,
  type CellConnectionRecord,
  type CellRecord,
  type ElevationBandRecord,
  type StructureGraph,
} from "../src/structure/kernel/graph";
import { isValidId } from "../src/structure/kernel/ids";
import {
  MAX_SLOT_RELIEF,
  MIN_FIELD_EXTENT,
  MIN_RIBBON_WIDTH,
  resolveSlotRelief,
} from "../src/structure/kernel/slot";
import { createSeedSet, deriveSeed, subsystemSeed } from "../src/structure/kernel/seed";
import {
  evaluateFrame,
  rectDepth,
  rectEdge,
  rectWidth,
  type HorizontalOrientation,
} from "../src/structure/kernel/frame";
import { buildStair } from "../src/structure/connector/build";
import { buildCell } from "../src/structure/cell/build";
import { buildRoof, faceIsCoveredByRoof } from "../src/structure/roof/build";
import {
  stairLocalVertex,
  stairSteps,
  stairWorldToLocal,
} from "../src/structure/connector/stair";
import {
  PATCH_ROLES,
  type FeatureConflictPolicy,
  type Patch,
  type PatchFeature,
  type PatchRegion,
} from "../src/structure/kernel/patch";
import { compilePatchFeatures } from "../src/structure/surface/features";
import { resolveFacadeBands, resolveFacadeBays } from "../src/structure/facade/layout";
import {
  PILLAR_HALL_PRESETS,
  PILLAR_HALL_SLOT_FEATURE_IDS,
  clonePillarHallLayout,
  clonePillarHallSlots,
  resolvePillarHallGraph,
  toPillarHallMasonry,
  validatePillarHallLayout,
  type PillarHallLayoutConfig,
  type PillarHallSlotFeatureId,
} from "../src/structure/families/pillar-hall/config";
import { DEFAULT_PILLAR_HALL_STONE_CONFIG } from "../src/structure/families/pillar-hall/config";
import { PILLAR_HALL_ARCHETYPES } from "../src/structure/families/pillar-hall/types";
import { DiagnosticCollector } from "../src/structure/kernel/validate";
import { createPatchOverlay } from "../src/structure/kernel/debug-overlay";
import { generateStructure, type StructureSpec } from "../src/structure/mass/generate";
import {
  MAX_CORNICE_RISE_SHARE,
  WALKABLE_TERRACE_WIDTH,
  bandCarriesCornice,
  wallProfileForBatter,
  type CornicePlacement,
} from "../src/structure/mass/elevation";
import {
  faceIsCoveredByStair,
  graphExtents,
  MASS_SECTION,
  tessellateStructure,
} from "../src/structure/mass/tessellate";

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "tests",
  "fixtures",
  "structure",
);
const UPDATE_FIXTURES = process.env.UPDATE_FIXTURES === "1";

assert.deepEqual(
  {
    seed: DEFAULT_MASS_STONE_CONFIG.seed,
    gap: DEFAULT_MASS_STONE_CONFIG.gapRatio,
    sizeVariation: DEFAULT_MASS_STONE_CONFIG.sizeVariation,
    displacement: DEFAULT_MASS_STONE_CONFIG.displacement,
    width: DEFAULT_MASS_LAYOUT.footprintWidth,
    depth: DEFAULT_MASS_LAYOUT.footprintDepth,
    bands: DEFAULT_MASS_LAYOUT.bandCount,
    height: DEFAULT_MASS_LAYOUT.totalHeight,
    batter: DEFAULT_MASS_LAYOUT.batterAngle,
    heightCurve: DEFAULT_MASS_LAYOUT.heightCurve,
    summitRatio: DEFAULT_MASS_LAYOUT.summitRatio,
    corniceBands: DEFAULT_MASS_LAYOUT.cornicePlacement,
    corniceProjection: DEFAULT_MASS_LAYOUT.corniceProjection,
    corniceHeight: DEFAULT_MASS_LAYOUT.corniceHeight,
    stoneworkEnabled: DEFAULT_MASS_LAYOUT.stoneworkEnabled,
    course: DEFAULT_MASS_LAYOUT.courseHeight,
    stone: DEFAULT_MASS_LAYOUT.stoneWidth,
    stoneDepth: DEFAULT_MASS_LAYOUT.stoneDepth,
    corners: DEFAULT_MASS_LAYOUT.cornerRule,
    stairFront: DEFAULT_MASS_LAYOUT.stairFrontEnabled,
    stairRear: DEFAULT_MASS_LAYOUT.stairRearEnabled,
    stairLeft: DEFAULT_MASS_LAYOUT.stairLeftEnabled,
    stairRight: DEFAULT_MASS_LAYOUT.stairRightEnabled,
    stairWidth: DEFAULT_MASS_LAYOUT.stairWidthRatio,
    stairRiser: DEFAULT_MASS_LAYOUT.stairRiser,
    stairTread: DEFAULT_MASS_LAYOUT.stairTread,
    stairTiles: DEFAULT_MASS_LAYOUT.stairTilesPerStep,
    stairSides: DEFAULT_MASS_LAYOUT.stairSideTreatment,
    stairParapetWidth: DEFAULT_MASS_LAYOUT.stairParapetWidth,
    stairParapetHeight: DEFAULT_MASS_LAYOUT.stairParapetHeight,
    steppedParapetCorniceProjection:
      DEFAULT_MASS_LAYOUT.stairSteppedParapetCorniceProjection,
    steppedParapetCorniceHeight:
      DEFAULT_MASS_LAYOUT.stairSteppedParapetCorniceHeight,
    stairParapetCorniceProjection: DEFAULT_MASS_LAYOUT.stairParapetCorniceProjection,
    stairParapetCorniceHeight: DEFAULT_MASS_LAYOUT.stairParapetCorniceHeight,
    stairFireBowlBottomEnabled: DEFAULT_MASS_LAYOUT.stairFireBowlBottomEnabled,
    stairFireBowlTopEnabled: DEFAULT_MASS_LAYOUT.stairFireBowlTopEnabled,
    summitTreatment: DEFAULT_MASS_LAYOUT.summitTreatment,
    summitPadHeight: DEFAULT_MASS_LAYOUT.summitPadHeight,
    summitBuildingEnabled: DEFAULT_MASS_LAYOUT.summitBuildingEnabled,
    summitBuildingWidthRatio: DEFAULT_MASS_LAYOUT.summitBuildingWidthRatio,
    summitBuildingDepthRatio: DEFAULT_MASS_LAYOUT.summitBuildingDepthRatio,
    summitBuildingHeight: DEFAULT_MASS_LAYOUT.summitBuildingHeight,
    summitBuildingWallThickness: DEFAULT_MASS_LAYOUT.summitBuildingWallThickness,
    summitBuildingPortalWidth: DEFAULT_MASS_LAYOUT.summitBuildingPortalWidth,
    summitBuildingPortalHeight: DEFAULT_MASS_LAYOUT.summitBuildingPortalHeight,
    summitBuildingPlan: DEFAULT_MASS_LAYOUT.summitBuildingPlan,
    summitInteriorOpeningWidth: DEFAULT_MASS_LAYOUT.summitInteriorOpeningWidth,
    summitInteriorOpeningHeight: DEFAULT_MASS_LAYOUT.summitInteriorOpeningHeight,
    facadeStyle: DEFAULT_MASS_LAYOUT.facadeStyle,
    facadePilasterProjection: DEFAULT_MASS_LAYOUT.facadePilasterProjection,
    facadeFriezeHeight: DEFAULT_MASS_LAYOUT.facadeFriezeHeight,
    facadeFriezeProjection: DEFAULT_MASS_LAYOUT.facadeFriezeProjection,
    summitRoofEnabled: DEFAULT_MASS_LAYOUT.summitRoofEnabled,
    summitRoofThickness: DEFAULT_MASS_LAYOUT.summitRoofThickness,
    summitRoofProjection: DEFAULT_MASS_LAYOUT.summitRoofProjection,
    summitRoofCorniceProjection: DEFAULT_MASS_LAYOUT.summitRoofCorniceProjection,
    summitRoofCorniceHeight: DEFAULT_MASS_LAYOUT.summitRoofCorniceHeight,
  },
  {
    seed: 741,
    gap: 0.026,
    sizeVariation: 0.2,
    displacement: 0.01,
    width: 24,
    depth: 18,
    bands: 3,
    height: 8.25,
    batter: 12,
    heightCurve: "even",
    summitRatio: 0.4,
    corniceBands: "all",
    corniceProjection: 0.3,
    corniceHeight: 0.3,
    stoneworkEnabled: true,
    course: 0.86,
    stone: 1.65,
    stoneDepth: 0.75,
    corners: "butted",
    stairFront: true,
    stairRear: true,
    stairLeft: true,
    stairRight: true,
    stairWidth: 0.3,
    stairRiser: 0.26,
    stairTread: 0.32,
    stairTiles: 5,
    stairSides: "sloped_parapet",
    stairParapetWidth: 0.75,
    stairParapetHeight: 0.55,
    steppedParapetCorniceProjection: 0,
    steppedParapetCorniceHeight: 0,
    stairParapetCorniceProjection: 0.2,
    stairParapetCorniceHeight: 0.25,
    stairFireBowlBottomEnabled: true,
    stairFireBowlTopEnabled: true,
    summitTreatment: "raised_pad",
    summitPadHeight: 0.35,
    summitBuildingEnabled: true,
    summitBuildingWidthRatio: 0.8,
    summitBuildingDepthRatio: 0.75,
    summitBuildingHeight: 3,
    summitBuildingWallThickness: 0.5,
    summitBuildingPortalWidth: 2,
    summitBuildingPortalHeight: 2.6,
    summitBuildingPlan: "single_chamber",
    summitInteriorOpeningWidth: 1.5,
    summitInteriorOpeningHeight: 2.2,
    facadeStyle: "plain",
    facadePilasterProjection: 0.16,
    facadeFriezeHeight: 0.3,
    facadeFriezeProjection: 0.12,
    summitRoofEnabled: true,
    summitRoofThickness: 0.5,
    summitRoofProjection: 0.25,
    summitRoofCorniceProjection: 0.2,
    summitRoofCorniceHeight: 0.25,
  },
  "The Mass controls must open with the approved defaults.",
);

const STAIRS_DISABLED = {
  stairFrontEnabled: false,
  stairRearEnabled: false,
  stairLeftEnabled: false,
  stairRightEnabled: false,
} as const;

const FRONT_STAIR_ONLY = {
  stairFrontEnabled: true,
  stairRearEnabled: false,
  stairLeftEnabled: false,
  stairRightEnabled: false,
} as const;

function cloneFrontStairLayout(): MassLayoutConfig {
  return {
    ...cloneMassLayout(MASS_LAYOUT_BASELINE),
    ...FRONT_STAIR_ONLY,
  };
}

/**
 * Every face a block emitted, as four corners.
 *
 * Read from the starts the builder recorded rather than by walking a stride: a
 * block writes only the faces nothing is pressed against, so there is no fixed
 * count per block, and guessing that layout has misread this buffer three times.
 */
function readBlockFaces(builder: SolidBuilder): THREE.Vector3[][] {
  return builder.blockFaces.map((start) =>
    [0, 1, 2, 3].map((corner) => new THREE.Vector3(
      builder.positions[(start + corner) * 3] ?? 0,
      builder.positions[(start + corner) * 3 + 1] ?? 0,
      builder.positions[(start + corner) * 3 + 2] ?? 0,
    )));
}

function readMaterialFaces(
  builder: SolidBuilder,
  slot: MaterialSlot,
): THREE.Vector3[][] {
  const material = materialSlotIndex(slot);
  return builder.blockFaces.flatMap((start) =>
    builder.surfaceMaterials[start] === material
      ? [[0, 1, 2, 3].map((corner) => new THREE.Vector3(
        builder.positions[(start + corner) * 3] ?? 0,
        builder.positions[(start + corner) * 3 + 1] ?? 0,
        builder.positions[(start + corner) * 3 + 2] ?? 0,
      ))]
      : []);
}

/** The outward normal of a face read back from the buffer. */
function faceNormal(face: readonly THREE.Vector3[]): THREE.Vector3 {
  return new THREE.Vector3().crossVectors(
    face[1]!.clone().sub(face[0]!),
    face[2]!.clone().sub(face[0]!),
  ).normalize();
}

function portalIsBlocked(
  builder: SolidBuilder,
  cell: CellRecord,
  opening: CellOpeningRecord,
): boolean {
  const outward = {
    front: new THREE.Vector3(0, 0, 1),
    rear: new THREE.Vector3(0, 0, -1),
    sidePositiveU: new THREE.Vector3(1, 0, 0),
    sideNegativeU: new THREE.Vector3(-1, 0, 0),
  }[opening.direction];
  const plane = opening.direction === "front"
    ? cell.footprint.maxZ
    : opening.direction === "rear"
      ? cell.footprint.minZ
      : opening.direction === "sidePositiveU"
        ? cell.footprint.maxX
        : cell.footprint.minX;
  const alongX = opening.direction === "front" || opening.direction === "rear";

  return readBlockFaces(builder).some((face) => {
    const normal = faceNormal(face);
    const center = face.reduce(
      (sum, point) => sum.addScaledVector(point, 1 / face.length),
      new THREE.Vector3(),
    );
    const onPlane = alongX
      ? Math.abs(center.z - plane) < 1e-6
      : Math.abs(center.x - plane) < 1e-6;
    const withinOpening = alongX
      ? center.x > opening.threshold.minX + 1e-6
        && center.x < opening.threshold.maxX - 1e-6
      : center.z > opening.threshold.minZ + 1e-6
        && center.z < opening.threshold.maxZ - 1e-6;

    return normal.dot(outward) > 0.99
      && onPlane
      && withinOpening
      && center.y > opening.bottomY + 1e-6
      && center.y < opening.topY - 1e-6;
  });
}

function connectionIsBlocked(
  builder: SolidBuilder,
  connection: CellConnectionRecord,
): boolean {
  const alongX = rectWidth(connection.threshold) > rectDepth(connection.threshold);
  const planes = alongX
    ? [connection.threshold.minZ, connection.threshold.maxZ]
    : [connection.threshold.minX, connection.threshold.maxX];

  return readBlockFaces(builder).some((face) => {
    const normal = faceNormal(face);
    const center = face.reduce(
      (sum, point) => sum.addScaledVector(point, 1 / face.length),
      new THREE.Vector3(),
    );
    const onPartitionFace = planes.some((plane) =>
      Math.abs((alongX ? center.z : center.x) - plane) < 1e-6);
    const withinOpening = alongX
      ? center.x > connection.threshold.minX + 1e-6
        && center.x < connection.threshold.maxX - 1e-6
      : center.z > connection.threshold.minZ + 1e-6
        && center.z < connection.threshold.maxZ - 1e-6;
    const facesRoom = alongX
      ? Math.abs(normal.z) > 0.99
      : Math.abs(normal.x) > 0.99;

    return facesRoom
      && onPartitionFace
      && withinOpening
      && center.y > connection.bottomY + 1e-6
      && center.y < connection.topY - 1e-6;
  });
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** An axis-aligned rectangle, wound the way the mass system authors them. */
function rect(halfX: number, halfZ: number) {
  return [
    { x: -halfX, z: -halfZ },
    { x: -halfX, z: halfZ },
    { x: halfX, z: halfZ },
    { x: halfX, z: -halfZ },
  ];
}

/** A block from two rectangles at two heights. */
function blockOf(
  lower: readonly { x: number; z: number }[],
  upper: readonly { x: number; z: number }[],
  bottomY: number,
  topY: number,
) {
  return {
    bottom: lower.map((point) => ({ x: point.x, y: bottomY, z: point.z })),
    top: upper.map((point) => ({ x: point.x, y: topY, z: point.z })),
  };
}

const ALL_SIDES = [true, true, true, true];

// --- the block builder -----------------------------------------------------
// A tapered, capped band is the shape every battered elevation band reduces to —
// and, since the whole mass is built from one primitive, it is also the shape of
// every set stone, every terrace slab and every core. Its normals have to come
// out right before anything is built on top of it.
const taperedBuilder = new SolidBuilder();
taperedBuilder.addBlock(
  blockOf(rect(1, 1), rect(0.5, 0.5), 0, 1),
  { sides: ALL_SIDES, top: true, bottom: true },
);

const tapered = finalizeGeometry(taperedBuilder);
assert.equal(taperedBuilder.blockCount, 1);
assert.equal(taperedBuilder.blockFaces.length, 6);
assert.equal(tapered.vertexCount, 6 * 4);
assert.equal(tapered.triangleCount, 6 * 2);
assertOutwardNormals(tapered.geometry, "tapered band");

// Winding is normalised on entry, so a caller that authors rings the other way
// round gets the same solid rather than an inside-out one. Reversing swaps which
// edge is which, so the face flags have to follow it — a block that emitted its
// inner face where its outer belongs would be a hole and a z-fight at once.
const reversedBuilder = new SolidBuilder();
reversedBuilder.addBlock(
  blockOf([...rect(1, 1)].reverse(), [...rect(0.5, 0.5)].reverse(), 0, 1),
  { sides: ALL_SIDES, top: true, bottom: true },
);
assertOutwardNormals(finalizeGeometry(reversedBuilder).geometry, "reversed band");

// A face nothing can see is not drawn. That decision is the caller's, and it is
// the difference between a joint you can look into and a hole you can see
// through, so the builder has to obey it exactly.
const partialBuilder = new SolidBuilder();
partialBuilder.addBlock(
  blockOf(rect(1, 1), rect(1, 1), 0, 1),
  { sides: [true, false, false, false], top: true },
);
const partial = finalizeGeometry(partialBuilder);
assert.equal(partial.triangleCount, 2 * 2, "Only the faces asked for may be drawn.");

// Whole-face culling compacts every parallel buffer and rebuilds face starts
// without changing the block the surviving faces belong to.
const faceCullBuilder = new SolidBuilder();
faceCullBuilder.addBlock(
  blockOf(rect(1, 1), rect(1, 1), 0, 1),
  { sides: ALL_SIDES, top: true },
);
const culledFaces = faceCullBuilder.cullFaces((face) =>
  face.every((corner) => corner.z > 0.9));
assert.equal(culledFaces, 1);
assert.equal(faceCullBuilder.blockCount, 1);
assert.equal(faceCullBuilder.blockFaces.length, 4);
assert.deepEqual(faceCullBuilder.blockFaces, [0, 4, 8, 12]);
assert.equal(faceCullBuilder.positions.length, 4 * 4 * 3);
assert.equal(faceCullBuilder.ambientOcclusion.length, 4 * 4);
assert.equal(faceCullBuilder.bakedShadow.length, 4 * 4);
assert.equal(faceCullBuilder.indices.length, 4 * 6);
assert.ok(
  readBlockFaces(faceCullBuilder).every((face) =>
    face.some((corner) => corner.z <= 0.9)),
  "The selected face survived compaction.",
);
assert.equal(finalizeGeometry(faceCullBuilder).triangleCount, 4 * 2);

assertAllNormalsFace(
  finalizeGeometry(withOnly(blockOf(rect(1, 1), rect(1, 1), 0, 1), { sides: [], top: true })).geometry,
  new THREE.Vector3(0, 1, 0),
  "block top",
);
assertAllNormalsFace(
  finalizeGeometry(withOnly(blockOf(rect(1, 1), rect(1, 1), 0, 1), { sides: [], bottom: true })).geometry,
  new THREE.Vector3(0, -1, 0),
  "block underside",
);

// Mass blocks and circular stones use the same generated shading values. Their
// vertex order differs only because a circular stone writes its top before its
// sides while a block writes its sides before its top.
const circularShadeBuilder = new StoneGeometryBuilder({
  bevelEnabled: false,
  bevelWidthRatio: 0,
  bevelDepthRatio: 0,
  bevelVariation: 0,
  seed: 1,
});
circularShadeBuilder.addStone(rect(1, 1), 0, [1, 1, 1, 1], 1);
const massShadeBuilder = new SolidBuilder();
massShadeBuilder.addBlock(
  blockOf(rect(1, 1), rect(1, 1), 0, 1),
  { sides: ALL_SIDES, top: true },
);
const circularToMassOrder = (values: readonly number[]) => [
  ...values.slice(4),
  ...values.slice(0, 4),
];
assert.deepEqual(
  massShadeBuilder.ambientOcclusion,
  circularToMassOrder(circularShadeBuilder.ambientOcclusion),
  "Mass and circular stones disagree on generated ambient occlusion.",
);
assert.deepEqual(
  massShadeBuilder.bakedShadow,
  circularToMassOrder(circularShadeBuilder.bakedShadow),
  "Mass and circular stones disagree on generated crack shadow.",
);

function withOnly(
  block: Parameters<SolidBuilder["addBlock"]>[0],
  faces: Parameters<SolidBuilder["addBlock"]>[1],
): SolidBuilder {
  const builder = new SolidBuilder();
  builder.addBlock(block, faces);
  return builder;
}

// The buffers a builder accumulates must satisfy the shared part contract, or
// mergeParts rejects them at composition time rather than here.
for (const [label, result] of [["tapered", tapered], ["partial", partial]] as const) {
  const { geometry } = result;
  assert.ok(geometry.getIndex(), `${label}: geometry must be indexed.`);
  for (const attribute of ["position", "normal", "uv", "vertexAo", "color"]) {
    assert.ok(geometry.getAttribute(attribute), `${label}: missing ${attribute}.`);
  }
  for (const key of ["baseUvs", "vertexAoBase", "bakedShadowBase"]) {
    assert.ok(geometry.userData[key], `${label}: missing userData.${key}.`);
  }
}

// Degenerate rings are a caller error, not a silent skip.
assert.throws(() => new SolidBuilder().addBlock(
  { bottom: rect(1, 1).slice(1).map((p) => ({ ...p, y: 0 })), top: rect(1, 1).map((p) => ({ ...p, y: 1 })) },
  { sides: ALL_SIDES },
));

// --- shaping curves --------------------------------------------------------
// A linear curve and the handles that reproduce a straight line have to agree,
// or switching a control from Linear to Custom would visibly jump.
for (const x of [0, 0.13, 0.25, 0.5, 0.75, 1]) {
  assert.ok(Math.abs(evaluateCurve(LINEAR_CURVE, x) - x) < 1e-6);
  assert.ok(
    Math.abs(evaluateCurve(bezierCurve(LINEAR_BEZIER), x) - x) < 1e-6,
    `The linear bezier must evaluate to a straight line at x=${x}.`,
  );
}

// Endpoints are pinned, so a curve always spans the whole total.
for (const handles of [
  [0.1, 0.9, 0.9, 0.95],
  [0.9, 0.05, 0.95, 0.2],
] as const) {
  const curve = bezierCurve(handles);
  assert.ok(Math.abs(evaluateCurve(curve, 0)) < 1e-6);
  assert.ok(Math.abs(evaluateCurve(curve, 1) - 1) < 1e-6);
  // Out-of-domain input is clamped rather than extrapolated.
  assert.equal(evaluateCurve(curve, -3), evaluateCurve(curve, 0));
  assert.equal(evaluateCurve(curve, 4), evaluateCurve(curve, 1));
}

// A linear curve distributes evenly; a front-loaded one makes the base tallest.
const evenSplit = distributeByCurve(4, 12, LINEAR_CURVE);
assert.equal(evenSplit.nonMonotonic, false);
for (const value of evenSplit.values) {
  assert.ok(Math.abs(value - 3) < 1e-9);
}

const heavyBase = distributeByCurve(4, 12, bezierCurve([0.1, 0.6, 0.5, 0.9]));
assert.equal(heavyBase.nonMonotonic, false);
assert.ok(Math.abs(sum(heavyBase.values) - 12) < 1e-9);
for (let index = 1; index < heavyBase.values.length; index += 1) {
  assert.ok(
    (heavyBase.values[index] ?? 0) < (heavyBase.values[index - 1] ?? 0),
    "A front-loaded curve must give every band a smaller rise than the one below.",
  );
}

// Handles kept inside [0, 1] can never describe a falling curve — the cubic's
// slope stays non-negative across that whole square. Swept rather than argued,
// because it covers the region the editor's handles normally sit in.
for (let y1 = 0; y1 <= 1.0001; y1 += 0.125) {
  for (let y2 = 0; y2 <= 1.0001; y2 += 0.125) {
    for (const [x1, x2] of [[0.05, 0.95], [0.5, 0.5], [0.9, 0.1]] as const) {
      const split = distributeByCurve(6, 9, bezierCurve([x1, y1, x2, y2]));
      assert.equal(
        split.nonMonotonic,
        false,
        `Handles y1=${y1} y2=${y2} must not read as falling.`,
      );
      assert.ok(Math.abs(sum(split.values) - 9) < 1e-9);
      for (const value of split.values) {
        assert.ok(value > 0, `Handles y1=${y1} y2=${y2} produced a zero rise.`);
      }
    }
  }
}

// --- curve presets ---------------------------------------------------------
// Every named shape has to be usable without inspection: monotonic, so it never
// asks for a band of no height, and distinct enough from its neighbours to be
// worth its own entry.
const PRESET_PROFILES = new Map<string, string>();

for (const shape of CURVE_SHAPE_IDS) {
  const bezier = CURVE_SHAPES[shape];
  const split = distributeByCurve(6, 12, bezierCurve(bezier));

  assert.equal(split.nonMonotonic, false, `Preset "${shape}" falls.`);
  assert.ok(Math.abs(sum(split.values) - 12) < 1e-9, `Preset "${shape}" loses height.`);

  for (const value of split.values) {
    assert.ok(value > 0, `Preset "${shape}" produced a zero rise.`);
  }

  // A handle's x has to sit inside the domain, or the preset would fail the
  // same validation a dragged one does.
  for (const index of [0, 2]) {
    const component = bezier[index] ?? Number.NaN;
    assert.ok(component >= 0 && component <= 1, `Preset "${shape}" x is out of range.`);
  }

  const profile = split.values.map((value) => (value / 12).toFixed(3)).join(",");
  assert.ok(
    !PRESET_PROFILES.has(profile),
    `Preset "${shape}" distributes identically to "${PRESET_PROFILES.get(profile)}".`,
  );
  PRESET_PROFILES.set(profile, shape);
}

// The shapes have to actually do what they are named for, checked on the band
// rises rather than on the control points.
const shapeRises = (shape: CurveShape) =>
  distributeByCurve(6, 12, bezierCurve(CURVE_SHAPES[shape])).values;

const even = shapeRises("even");
assert.ok(Math.max(...even) - Math.min(...even) < 1e-9, "even must be uniform.");

const frontLoaded = shapeRises("front_loaded");
for (let index = 1; index < frontLoaded.length; index += 1) {
  assert.ok(
    (frontLoaded[index] ?? 0) < (frontLoaded[index - 1] ?? 0),
    "front_loaded must diminish throughout.",
  );
}

const backLoaded = shapeRises("back_loaded");
for (let index = 1; index < backLoaded.length; index += 1) {
  assert.ok(
    (backLoaded[index] ?? 0) > (backLoaded[index - 1] ?? 0),
    "back_loaded must grow throughout.",
  );
}

const endsEmphasised = shapeRises("ends_emphasised");
assert.ok(
  (endsEmphasised[0] ?? 0) > (endsEmphasised[2] ?? 0)
  && (endsEmphasised[5] ?? 0) > (endsEmphasised[3] ?? 0),
  "ends_emphasised must be taller at both ends than in the middle.",
);

const middleEmphasised = shapeRises("middle_emphasised");
assert.ok(
  (middleEmphasised[2] ?? 0) > (middleEmphasised[0] ?? 0)
  && (middleEmphasised[3] ?? 0) > (middleEmphasised[5] ?? 0),
  "middle_emphasised must be taller in the middle than at either end.",
);

// Every option the pane offers resolves to a curve, and selecting one is what
// keeps the stored curve honest — a preset generates the same structure whether
// it was just selected or restored from a config.
for (const mode of Object.values(HEIGHT_CURVE_OPTIONS)) {
  const preset = heightCurveBezier(mode);

  if (mode === "custom") {
    assert.equal(preset, null);
    continue;
  }

  assert.ok(preset, `Option "${mode}" has no curve.`);
  const selected = { ...cloneFrontStairLayout(), heightCurve: mode };
  assert.doesNotThrow(() => validateMassLayout({
    ...selected,
    heightCurveBezier: preset,
  }));
  // Resolved from the preset table, so a stale stored curve cannot win.
  assert.deepEqual(
    toHeightCurve({ ...selected, heightCurveBezier: [0.9, 0.1, 0.1, 0.9] }),
    bezierCurve(preset),
  );
}

// The curve editor bounds each handle's x to the curve's domain but leaves y
// free, exactly as CSS `cubic-bezier` does, so a dragged handle can overshoot
// and make the curve fall — which asks for a band of negative height. Reachable
// from the pane, so the floor and its notice are load-bearing rather than a
// defensive guard.
const dipping = distributeByCurve(5, 10, bezierCurve([0.25, 1.5, 0.75, -0.5]));
assert.equal(dipping.nonMonotonic, true);
assert.ok(Math.abs(sum(dipping.values) - 10) < 1e-9);
for (const value of dipping.values) {
  assert.ok(value > 0, "Every band must keep a positive rise.");
}

// That overshoot must survive validation, or dragging a handle past the top of
// the editor would throw out of the change handler instead of being reported.
assert.doesNotThrow(() => validateMassLayout({
  ...cloneFrontStairLayout(),
  heightCurve: "custom",
  heightCurveBezier: [0.25, 1.5, 0.75, -0.5],
}));
// A handle's x, though, is bounded by the curve's own domain.
assert.throws(
  () => validateMassLayout({
    ...cloneFrontStairLayout(),
    heightCurveBezier: [1.4, 0.5, 0.75, 0.5],
  }),
  /handle 1 x must be between 0 and 1/,
);
assert.throws(
  () => validateMassLayout({
    ...cloneFrontStairLayout(),
    heightCurveBezier: [0.25, 0.5, 0.75] as never,
  }),
  /must be four finite numbers/,
);
assert.throws(
  () => validateMassLayout({
    ...cloneFrontStairLayout(),
    stairTilesPerStep: 0,
  }),
  /Stair tiles per step must be an integer from 1 to 32/,
);
assert.throws(
  () => validateMassLayout({
    ...cloneFrontStairLayout(),
    stairTilesPerStep: 4.5,
  }),
  /Stair tiles per step must be an integer from 1 to 32/,
);

// A falling curve reaches the pane as a notice on a structure that still builds.
const fallingGraph = generateStructure(toStructureSpec({
  ...cloneFrontStairLayout(),
  bandCount: 5,
  heightCurve: "custom",
  heightCurveBezier: [0.25, 1.5, 0.75, -0.5],
}));
assert.deepEqual(
  fallingGraph.diagnostics.filter((entry) => entry.severity === "error"),
  [],
);
assert.ok(
  fallingGraph.diagnostics.some((entry) => entry.code === "mass.height_curve_falls"),
  "A falling height curve must be reported.",
);
assert.ok(fallingGraph.patches.length > 0, "A falling curve must still build.");

// Degenerate counts are answered, not thrown at.
assert.deepEqual(distributeByCurve(0, 10, LINEAR_CURVE).values, []);
assert.deepEqual(distributeByCurve(1, 10, LINEAR_CURVE).values, [10]);

// --- patch feature compiler ------------------------------------------------
// Patch features are declarative graph data. Compilation must be pure,
// deterministic and independent of insertion order except where authored
// dependencies say otherwise.
const featureRegions = [
  testRegion("feature_patch/region_a", [0, 0.5], [0, 1], 100),
  testRegion("feature_patch/region_b", [0.25, 0.75], [0, 1], 50),
  testRegion("feature_patch/region_c", [0.8, 1], [0, 1], 10),
];
const featureA = testCutFeature("feature_patch/a", featureRegions[0]!.id);
const featureB = testCutFeature("feature_patch/b", featureRegions[1]!.id, {
  conflictPolicy: "clip",
  dependsOn: [featureA.id],
});
const featureC = testCutFeature("feature_patch/c", featureRegions[2]!.id, {
  order: -10,
  runsAfter: [featureB.id],
});
const featurePatch = testFeaturePatch(featureRegions, [featureC, featureB, featureA]);
const featurePatchBefore = JSON.stringify(featurePatch);
const compiledFeaturePatch = compilePatchFeatures(featurePatch);
assert.equal(JSON.stringify(featurePatch), featurePatchBefore, "Feature compilation mutated its patch.");
assert.deepEqual(
  compiledFeaturePatch.features.map((entry) => entry.feature.id),
  [featureA.id, featureB.id, featureC.id],
  "Feature dependencies did not produce a stable topological order.",
);
assert.deepEqual(
  compiledFeaturePatch.features[1]?.fragments,
  [{ uMin: 0.5, uMax: 0.75, vMin: 0, vMax: 1 }],
  "Clip did not subtract the previously accepted rectangular cut.",
);
assert.equal(
  compiledFeaturePatch.diagnostics.filter(
    (entry) => entry.code === "feature.conflict_clipped",
  ).length,
  1,
);

for (const expectation of [
  { policy: "error", ids: [featureA.id], code: "feature.conflict" },
  { policy: "skip", ids: [featureA.id], code: "feature.conflict_skipped" },
  { policy: "replace", ids: [featureB.id], code: "feature.conflict_replaced" },
] as const) {
  const conflicting = compilePatchFeatures(testFeaturePatch(
    featureRegions.slice(0, 2),
    [
      featureA,
      testCutFeature(featureB.id, featureB.regionId!, {
        conflictPolicy: expectation.policy,
        order: 1,
      }),
    ],
  ));
  assert.deepEqual(
    conflicting.features.map((entry) => entry.feature.id),
    expectation.ids,
    `${expectation.policy}: conflict resolution kept the wrong feature.`,
  );
  assert.equal(
    conflicting.diagnostics.some((entry) => entry.code === expectation.code),
    true,
    `${expectation.policy}: conflict resolution emitted no named diagnostic.`,
  );
}

const invalidFeatureCases = [
  {
    label: "missing dependency",
    patch: testFeaturePatch([featureRegions[0]!], [testCutFeature(
      featureA.id,
      featureA.regionId!,
      { dependsOn: ["feature_patch/missing"] },
    )]),
    code: "feature.dependency_missing",
  },
  {
    label: "dependency cycle",
    patch: testFeaturePatch(featureRegions.slice(0, 2), [
      testCutFeature(featureA.id, featureA.regionId!, { dependsOn: [featureB.id] }),
      testCutFeature(featureB.id, featureB.regionId!, { dependsOn: [featureA.id] }),
    ]),
    code: "feature.dependency_cycle",
  },
  {
    label: "disallowed operation",
    patch: testFeaturePatch([
      { ...featureRegions[0]!, allowedOperations: [] },
    ], [featureA]),
    code: "feature.operation_disallowed",
  },
  {
    label: "unimplemented operation",
    patch: testFeaturePatch([
      { ...featureRegions[0]!, allowedOperations: ["displace"] },
    ], [{ ...featureA, operation: "displace" }]),
    code: "feature.operation_unimplemented",
  },
  {
    label: "unsupported evaluator",
    patch: { ...testFeaturePatch([featureRegions[0]!], [featureA]), evaluator: "battered" },
    code: "feature.evaluator_unsupported",
  },
  {
    label: "missing depth",
    patch: testFeaturePatch([
      { ...featureRegions[0]!, allowedOperations: ["extrude"] },
    ], [{ ...featureA, operation: "extrude", depth: 0 }]),
    code: "feature.depth_required",
  },
  {
    label: "empty material role",
    patch: testFeaturePatch(
      [featureRegions[0]!],
      [{ ...featureA, materialRole: "" }],
    ),
    code: "feature.material_role_invalid",
  },
  {
    label: "missing exclusion",
    patch: testFeaturePatch([
      { ...featureRegions[0]!, exclusions: ["feature_patch/missing"] },
    ], [featureA]),
    code: "region.exclusion_missing",
  },
] as const;

for (const invalid of invalidFeatureCases) {
  assert.equal(
    compilePatchFeatures(invalid.patch).diagnostics.some(
      (entry) => entry.code === invalid.code && entry.severity === "error",
    ),
    true,
    `${invalid.label}: compiler emitted no ${invalid.code} error.`,
  );
}

// --- facade layout resolvers ----------------------------------------------
// Fixed dimensions are allocated before weights, and every result remains in
// the patch's stable normalized domain.
const facadeLayoutDiagnostics = new DiagnosticCollector();
const resolvedBays = resolveFacadeBays(
  "test/facade",
  10,
  { start: 1, end: 1 },
  [
    { id: "left", role: "secondary", weight: 1, hierarchy: 1 },
    { id: "center", role: "entrance", width: 2, hierarchy: 3 },
    { id: "right", role: "secondary", weight: 1, hierarchy: 1 },
  ],
  "bilateral",
  facadeLayoutDiagnostics,
);
assert.ok(resolvedBays);
assert.deepEqual(resolvedBays.map((bay) => bay.width), [3, 2, 3]);
assert.deepEqual(resolvedBays.map((bay) => bay.uRange), [
  [0.1, 0.4],
  [0.4, 0.6],
  [0.6, 0.9],
]);
const resolvedBands = resolveFacadeBands(
  "test/facade",
  4,
  [
    { id: "body", role: "opening_zone", weight: 1, continuity: "per_bay" },
    { id: "frieze", role: "frieze", height: 0.5, continuity: "continuous" },
  ],
  facadeLayoutDiagnostics,
);
assert.ok(resolvedBands);
assert.deepEqual(resolvedBands.map((band) => band.height), [3.5, 0.5]);
assert.deepEqual(facadeLayoutDiagnostics.all, []);

const invalidFacadeDiagnostics = new DiagnosticCollector();
assert.equal(resolveFacadeBays(
  "test/facade_invalid",
  4,
  { start: 0, end: 0 },
  [
    { id: "left", role: "secondary", weight: 1, hierarchy: 1 },
    { id: "center", role: "primary", weight: 1, hierarchy: 3 },
    { id: "right", role: "solid", weight: 1, hierarchy: 1 },
  ],
  "bilateral",
  invalidFacadeDiagnostics,
), null);
assert.equal(invalidFacadeDiagnostics.all[0]?.code, "facade.bays_not_bilateral");


/**
 * A layout with the named slot features switched on.
 *
 * Every feature defaults to off, so a test that wants engraving says which
 * surfaces it means rather than reaching for one placement word that covered
 * all of them.
 */
function withMassSlots(
  layout: MassLayoutConfig,
  ...ids: readonly MassSlotFeatureId[]
): MassLayoutConfig {
  const slots = cloneMassSlots(layout.slots);
  for (const id of ids) {
    slots[id] = { ...slots[id], enabled: true };
  }
  return { ...cloneMassLayout(layout), slots };
}

/** The same, with every enabled field sunk or raised by `relief` metres. */
function withMassRelief(
  layout: MassLayoutConfig,
  relief: number,
  ...ids: readonly MassSlotFeatureId[]
): MassLayoutConfig {
  const prepared = withMassSlots(layout, ...ids);
  const slots = cloneMassSlots(prepared.slots);
  for (const id of ids) {
    slots[id] = { ...slots[id], relief };
  }
  return { ...prepared, slots };
}

/**
 * What a field's face is allowed to do, from what its feature asked for.
 *
 * The two directions are bounded differently, and the asymmetry is the point.
 * Sinking removes material, so it stops at the stone that has to survive behind
 * a carved field; raising adds material, so nothing behind it is at risk and
 * only legibility bounds it. That is why the same request cuts deep into a band
 * and barely marks a moulding.
 */
{
  const generous = { relief: 0, recess: 1 };
  const thin = { relief: 0, recess: 0.04 };

  assert.equal(resolveSlotRelief(0, generous), 0);
  assert.equal(resolveSlotRelief(-0.05, generous), -0.05);
  assert.equal(resolveSlotRelief(0.05, generous), 0.05);

  // A moulding has a hand's width of stone, and says so.
  assert.equal(resolveSlotRelief(-0.5, thin), -0.04);
  // Raising is not bounded by what is behind it, only by how far a panel can
  // stand proud and still read as part of the wall.
  assert.equal(resolveSlotRelief(0.5, thin), MAX_SLOT_RELIEF);
  assert.equal(resolveSlotRelief(-0.5, generous), -MAX_SLOT_RELIEF);

  // A budget of nothing grants nothing, and a NaN that slipped past validation
  // must not reach a vertex.
  assert.equal(resolveSlotRelief(-0.05, { relief: 0, recess: 0 }), 0);
  assert.equal(resolveSlotRelief(Number.NaN, generous), 0);
}

/** Every mass elevation, and everything crowning or enclosing it. */
const ALL_MASS_SLOTS: readonly MassSlotFeatureId[] = [...MASS_SLOT_FEATURE_IDS];

/** The principal wall faces alone. */
const MASS_ELEVATION_SLOTS: readonly MassSlotFeatureId[] = [
  "plinth",
  "bandWall",
];

function withHallSlots(
  layout: PillarHallLayoutConfig,
  ...ids: readonly PillarHallSlotFeatureId[]
): PillarHallLayoutConfig {
  const slots = clonePillarHallSlots(layout.slots);
  for (const id of ids) {
    slots[id] = { ...slots[id], enabled: true };
  }
  return { ...clonePillarHallLayout(layout), slots };
}

const ALL_HALL_SLOTS: readonly PillarHallSlotFeatureId[] = [
  ...PILLAR_HALL_SLOT_FEATURE_IDS,
];

const HALL_ELEVATION_SLOTS: readonly PillarHallSlotFeatureId[] = ["pierPanel"];

// --- golden fixtures -------------------------------------------------------
// Committed graphs, not committed meshes. A retuned proportion shows up as a
// readable diff on the numbers that changed, which is the whole reason these are
// serialized semantics rather than a vertex-buffer hash.
const FIXTURES: readonly { readonly name: string; readonly layout: MassLayoutConfig }[] = [
  {
    name: "low-platform",
    layout: {
      ...cloneFrontStairLayout(),
      bandCount: 2,
      totalHeight: 2.4,
      batterAngle: 0,
      baseTreatment: "none",
      summitRatio: 0.8,
    },
  },
  {
    name: "stepped-pyramid",
    layout: {
      ...cloneFrontStairLayout(),
      footprintWidth: 34,
      footprintDepth: 26,
      bandCount: 7,
      totalHeight: 16,
      batterAngle: 18,
      summitRatio: 0.28,
      // Climbs fast, then flattens: a heavy base under progressively shallower
      // upper terraces.
      heightCurve: "custom",
      heightCurveBezier: [0.16, 0.5, 0.5, 0.86],
    },
  },
  {
    name: "single-band-podium",
    layout: {
      ...cloneFrontStairLayout(),
      bandCount: 1,
      totalHeight: 1.8,
      batterAngle: 8,
    },
  },
  {
    name: "asymmetric-setbacks",
    layout: {
      ...cloneFrontStairLayout(),
      bandCount: 4,
      totalHeight: 6,
      frontSetbackScale: 1.8,
      rearSetbackScale: 0.2,
      sideSetbackScale: 1,
    },
  },
  {
    name: "corniced-terraces",
    layout: {
      ...cloneFrontStairLayout(),
      bandCount: 5,
      totalHeight: 11,
      batterAngle: 10,
      heightCurve: "front_loaded",
      // Left off the crown so the summit reads as the top of the mass rather
      // than as one more moulded step.
      cornicePlacement: "terraces",
      corniceProjection: 0.25,
      corniceHeight: 0.3,
    },
  },
  {
    name: "hierarchical-facade",
    layout: {
      ...cloneFrontStairLayout(),
      summitBuildingEnabled: true,
      facadeStyle: "hierarchical",
    },
  },
  {
    // The slot table is the product of this feature, so it is golden-tested
    // like every other resolved proportion. Cornices and a summit building are
    // on because they are the surfaces `all` reaches beyond the band walls.
    name: "engraved-terraces",
    layout: {
      ...cloneFrontStairLayout(),
      bandCount: 4,
      totalHeight: 9,
      batterAngle: 10,
      cornicePlacement: "all",
      corniceProjection: 0.25,
      corniceHeight: 0.3,
      stoneworkEnabled: true,
      summitBuildingEnabled: true,
    },
  },
].map((fixture) => fixture.name === "engraved-terraces"
  ? { ...fixture, layout: withMassSlots(fixture.layout, ...ALL_MASS_SLOTS) }
  : fixture);

const graphs = new Map<string, StructureGraph>();

for (const fixture of FIXTURES) {
  assert.doesNotThrow(
    () => validateMassLayout(fixture.layout),
    `${fixture.name}: fixture layout must satisfy the control table.`,
  );

  const graph = generateStructure(toStructureSpec(fixture.layout));
  graphs.set(fixture.name, graph);

  assert.deepEqual(
    graph.diagnostics.filter((entry) => entry.severity === "error"),
    [],
    `${fixture.name}: generated with errors.`,
  );
  assertGraphInvariants(graph, fixture.name);
  assertMatchesFixture(fixture.name, graph);
}

// --- Pillar Hall family ---------------------------------------------------
const HALL_FIXTURES: readonly {
  readonly name: string;
  readonly layout: PillarHallLayoutConfig;
}[] = [
  { name: "pillar-hall-linear-screen", layout: clonePillarHallLayout(PILLAR_HALL_PRESETS.linear_screen) },
  { name: "pillar-hall-front-gallery", layout: clonePillarHallLayout(PILLAR_HALL_PRESETS.front_gallery) },
  { name: "pillar-hall-open-pavilion", layout: clonePillarHallLayout(PILLAR_HALL_PRESETS.open_pavilion) },
  {
    name: "pillar-hall-engraved",
    layout: withHallSlots(
      clonePillarHallLayout(PILLAR_HALL_PRESETS.front_gallery),
      ...ALL_HALL_SLOTS,
    ),
  },
];

for (const fixture of HALL_FIXTURES) {
  assert.doesNotThrow(() => validatePillarHallLayout(fixture.layout));
  const graph = resolvePillarHallGraph(fixture.layout);
  const hall = graph.pillarHalls[0]!;
  assert.equal(hall.archetype, fixture.layout.archetype);
  assert.deepEqual(
    hall.supports[0]?.sections.map((section) => section.kind),
    ["foot", "lower_panel", "shaft", "capital", "capstone"],
  );
  assert.ok(hall.supports.every((support) => support.panels.length === 16));
  assert.ok(hall.supports.every((support) =>
    support.panels.filter((panel) => panel.section === "lower_panel").length === 12
    && support.panels.filter((panel) => panel.section === "shaft").length === 4));
  assertGraphInvariants(graph, fixture.name);
  assertMatchesFixture(fixture.name, graph);

  const geometry = mergeParts(tessellateStructure(graph, {
    masonry: toPillarHallMasonry(
      fixture.layout,
      { ...DEFAULT_PILLAR_HALL_STONE_CONFIG, displacement: 0 },
    ),
    seed: 109,
    stairTilesPerStep: fixture.layout.stairTilesPerStep,
  }).parts, [MASS_SECTION]).geometry;
  const slots = new Set(geometry.groups.map((group) => group.materialIndex));
  for (const slot of ["stone", "pier", "pierPanel", "lintel", "cornice"] as const) {
    assert.ok(slots.has(materialSlotIndex(slot)), `${fixture.name} emitted no ${slot} group.`);
  }
  const hallOnly = mergeParts(tessellateStructure({
    ...graph,
    masses: [],
    connectors: [],
  }, {
    masonry: null,
    seed: 109,
    stairTilesPerStep: fixture.layout.stairTilesPerStep,
  }).parts, [MASS_SECTION]).geometry;
  const coincidence = findCoincidentFaces(hallOnly);
  assert.equal(
    coincidence.pairs,
    0,
    `${fixture.name} emitted coincident faces: ${coincidence.sample}; ${coincidence.planes.join(", ")}.`,
  );
  const buried = findBuriedFaces(hallOnly);
  assert.equal(
    buried.faces,
    0,
    `${fixture.name} emitted buried faces: ${buried.sample}.`,
  );
  const backfaces = findBackfaces(hallOnly, 48);
  assert.equal(
    backfaces.backfaces,
    0,
    `${fixture.name} exposed missing outward faces near ${backfaces.sample}.`,
  );
  assert.equal(hall.roof !== null, fixture.layout.archetype === "front_gallery");
  // A row's architrave is one member, not one per bay, and it shares both end
  // planes with the moulding above it. What the ends are is a composition
  // decision — a free end projects, an end meeting another row stops flush — so
  // what is asserted is that the beam covers every pier it lands on and that
  // the two courses of the entablature agree with each other.
  const expectedSpanDepth = Math.max(
    fixture.layout.lintelDepth,
    fixture.layout.pierWidth * 1.65,
  );
  for (const row of hall.rows) {
    const horizontal = row.orientation === "front" || row.orientation === "rear";
    const cornice = hall.members.find(
      (member) => member.id === `${row.id}/cornice`,
    )!;
    const lintel = hall.members.find(
      (member) => member.id === `${row.id}/lintel`,
    )!;

    assert.ok(
      row.bayIds.every((bayId) =>
        !hall.members.some((member) => member.id === `${bayId}/lintel`)),
      `${fixture.name}: a bay still owns a lintel of its own.`,
    );

    const along = (member: typeof lintel) => horizontal
      ? [member.rect.minX, member.rect.maxX] as const
      : [member.rect.minZ, member.rect.maxZ] as const;
    const across = (member: typeof lintel) => horizontal
      ? rectDepth(member.rect)
      : rectWidth(member.rect);

    // The moulding runs no further than the beam it crowns. They finish on one
    // plane at a free end; at a corner the deeper moulding stops further back,
    // because each member laps against its own counterpart.
    assert.ok(
      along(cornice)[0] >= along(lintel)[0] - 1e-9
        && along(cornice)[1] <= along(lintel)[1] + 1e-9,
      `${fixture.name}: the ${row.orientation} moulding overruns its beam.`,
    );
    // An architrave narrower than the capstone reads as set back behind the
    // piers rather than carried by them.
    assert.ok(
      across(lintel) >= expectedSpanDepth - 1e-9,
      `${fixture.name}: the ${row.orientation} span is narrower than its capstones.`,
    );
    assert.ok(
      across(cornice) >= across(lintel) - 1e-9,
      `${fixture.name}: the ${row.orientation} moulding does not oversail its beam.`,
    );
  }

  // Every pier carries something. A row that stops at a corner does so because
  // the row it meets there runs through, so the test is per pier rather than
  // per row: no support may be left with nothing over it.
  const lintels = hall.members.filter((member) => member.kind === "lintel");
  for (const support of hall.supports) {
    assert.ok(
      lintels.some((member) =>
        support.x >= member.rect.minX - 1e-9
        && support.x <= member.rect.maxX + 1e-9
        && support.z >= member.rect.minZ - 1e-9
        && support.z <= member.rect.maxZ + 1e-9),
      `${fixture.name}: pier "${support.id}" carries no span.`,
    );
  }

  // Two rows meeting at one pier lap: each member stops flush against the one
  // it meets, with no gap and no overlap. Using one figure for both left the
  // beam short of the corner by half the moulding's projection while the
  // moulding met, so the entablature broke exactly where it should turn.
  for (const first of hall.rows) {
    for (const second of hall.rows) {
      if (first.id >= second.id) {
        continue;
      }
      const shared = first.supportIds.some(
        (id) => second.supportIds.includes(id),
      );
      if (!shared) {
        continue;
      }

      for (const kind of ["lintel", "cornice"] as const) {
        const a = hall.members.find((m) => m.id === `${first.id}/${kind}`)!;
        const b = hall.members.find((m) => m.id === `${second.id}/${kind}`)!;
        const gapX = Math.max(0, a.rect.minX - b.rect.maxX, b.rect.minX - a.rect.maxX);
        const gapZ = Math.max(0, a.rect.minZ - b.rect.maxZ, b.rect.minZ - a.rect.maxZ);
        assert.ok(
          Math.max(gapX, gapZ) < 1e-9,
          `${fixture.name}: the ${kind}s of two rows meeting at a pier leave a `
          + `${Math.max(gapX, gapZ).toFixed(3)} m gap.`,
        );
      }
    }
  }

  // Two rows meeting at one pier must not both claim the stone over it.
  const spans = hall.members.filter(
    (member) => member.kind === "lintel" || member.kind === "cornice",
  );
  for (let first = 0; first < spans.length; first += 1) {
    for (let second = first + 1; second < spans.length; second += 1) {
      const a = spans[first]!;
      const b = spans[second]!;
      const shares = a.rect.minX < b.rect.maxX - 1e-9
        && a.rect.maxX > b.rect.minX + 1e-9
        && a.rect.minZ < b.rect.maxZ - 1e-9
        && a.rect.maxZ > b.rect.minZ + 1e-9
        && a.bottomY < b.topY - 1e-9
        && a.topY > b.bottomY + 1e-9;
      assert.ok(
        !shares,
        `${fixture.name}: "${a.id}" and "${b.id}" occupy the same stone.`,
      );
    }
  }
  const summit = graph.masses[0]!.summit.placement!.rect;
  const occupiedRects = [
    ...hall.supports.flatMap((support) => support.sections.map((section) => section.footprint)),
    ...hall.members.map((member) => member.rect),
    ...(hall.roof ? [hall.roof.footprint] : []),
  ];
  assert.ok(occupiedRects.every((rect) =>
    rect.minX >= summit.minX - 1e-9
    && rect.maxX <= summit.maxX + 1e-9
    && rect.minZ >= summit.minZ - 1e-9
    && rect.maxZ <= summit.maxZ + 1e-9), `${fixture.name} exceeded the available summit area.`);
  if (fixture.layout.archetype === "linear_screen") {
    assert.ok(slots.has(materialSlotIndex("pedestal")));
    assert.ok(slots.has(materialSlotIndex("frieze")));
    assert.equal(hall.rows.length, 1);
    const plinths = hall.members.filter((member) => member.kind === "support_plinth");
    const panels = hall.members.filter((member) => member.kind === "base_frieze");
    const pedestal = hall.members.find((member) => member.kind === "pedestal");
    assert.ok(pedestal);
    assert.equal(plinths.length, hall.supports.length);
    assert.equal(panels.length, hall.bays.length * 2);
    for (const support of hall.supports) {
      const plinth = plinths.find((member) => member.id.startsWith(`${support.id}/`));
      assert.ok(plinth, `${support.id} has no aligned base plinth.`);
      assert.ok(Math.abs((plinth.rect.minX + plinth.rect.maxX) * 0.5 - support.x) < 1e-9);
      assert.ok(Math.abs((plinth.rect.minZ + plinth.rect.maxZ) * 0.5 - support.z) < 1e-9);
      assert.ok(Math.abs(plinth.topY - support.sections[0]!.bottomY) < 1e-9);
      const foot = support.sections[0]!.footprint;
      assert.ok(plinth.rect.minX <= foot.minX && plinth.rect.maxX >= foot.maxX);
      assert.ok(plinth.rect.minZ <= foot.minZ && plinth.rect.maxZ >= foot.maxZ);
    }
    for (const bay of hall.bays) {
      const startPlinth = plinths.find((member) => member.id.startsWith(`${bay.startSupportId}/`));
      const endPlinth = plinths.find((member) => member.id.startsWith(`${bay.endSupportId}/`));
      const bayPanels = panels
        .filter((member) => member.id.startsWith(`${bay.id}/`))
        .sort((a, b) => a.rect.minX - b.rect.minX);
      assert.ok(startPlinth && endPlinth);
      assert.equal(bayPanels.length, 2);
      assert.ok(Math.abs(bayPanels[0]!.rect.minX - startPlinth.rect.maxX) < 1e-9);
      assert.ok(Math.abs(bayPanels[0]!.rect.maxX - bayPanels[1]!.rect.minX) < 1e-9);
      assert.ok(Math.abs(bayPanels[1]!.rect.maxX - endPlinth.rect.minX) < 1e-9);
    }
  } else if (fixture.layout.archetype === "front_gallery") {
    assert.ok(slots.has(materialSlotIndex("roof")));
    assert.equal(hall.rows.length, 2);
  } else {
    assert.equal(hall.rows.length, 3);
    assert.equal(hall.rows.some((row) => row.orientation === "front"), false);
    assert.equal(graph.connectors[0]?.direction, "front");
  }
}

// The exposed end-projection range moves one shared lintel/cornice end plane;
// it must not reintroduce the corner gaps or overlapping faces it replaces.
for (const spanEndProjection of [0.01, 1.5]) {
  const layout = {
    ...clonePillarHallLayout(PILLAR_HALL_PRESETS.open_pavilion),
    platformWidth: 20,
    platformDepth: 20,
    spanEndProjection,
  };
  const graph = resolvePillarHallGraph(layout);
  const hallOnly = mergeParts(tessellateStructure({
    ...graph,
    masses: [],
    connectors: [],
  }, {
    masonry: null,
    seed: 109,
    stairTilesPerStep: layout.stairTilesPerStep,
  }).parts, [MASS_SECTION]).geometry;
  const coincidence = findCoincidentFaces(hallOnly);
  assert.equal(
    coincidence.pairs,
    0,
    `span end projection ${spanEndProjection} emitted ${coincidence.pairs} coincident faces: ${coincidence.sample}.`,
  );
  assert.equal(
    findBuriedFaces(hallOnly).faces,
    0,
    `span end projection ${spanEndProjection} emitted buried faces.`,
  );
  assert.equal(
    findBackfaces(hallOnly, 48).backfaces,
    0,
    `span end projection ${spanEndProjection} emitted backfaces.`,
  );
}

// Panel stacks are selected from the section's actual aspect ratio rather than
// a fixed count. Both ends of the exposed control range must remain usable.
for (const [label, layout, expectedPanelCount] of [
  ["short-wide piers", {
    ...clonePillarHallLayout(PILLAR_HALL_PRESETS.linear_screen),
    platformWidth: 20,
    platformDepth: 4,
    frontBayCount: 3,
    pierHeight: 2,
    pierWidth: 1.2,
  }, 8],
  ["tall-narrow piers", {
    ...clonePillarHallLayout(PILLAR_HALL_PRESETS.linear_screen),
    pierHeight: 9,
    pierWidth: 0.3,
  }, 20],
] as const) {
  const graph = resolvePillarHallGraph(layout);
  const hall = graph.pillarHalls[0]!;
  assert.ok(hall.supports.every((support) => support.panels.length === expectedPanelCount));
  assertGraphInvariants(graph, label);
  const geometry = mergeParts(tessellateStructure({
    ...graph,
    masses: [],
    connectors: [],
  }, {
    masonry: null,
    seed: 109,
    stairTilesPerStep: layout.stairTilesPerStep,
  }).parts, [MASS_SECTION]).geometry;
  assert.equal(findCoincidentFaces(geometry).pairs, 0, `${label} emitted coincident faces.`);
  assert.equal(findBuriedFaces(geometry).faces, 0, `${label} emitted buried faces.`);
  assert.equal(findBackfaces(geometry, 48).backfaces, 0, `${label} emitted backfaces.`);
}

// --- Stela family ----------------------------------------------------------
// The family resolves form and slots and deliberately not content, so what is
// checked here is the slot contract rather than the silhouette: every slot
// addresses a live region, keeps a usable rectangle inside its own outline, and
// survives damage as an annotated record rather than disappearing from the table.
const STELA_FIXTURES: readonly {
  readonly name: string;
  readonly layout: StelaLayoutConfig;
}[] = [
  { name: "stela-tablet", layout: cloneStelaLayout(STELA_PRESETS.tablet) },
  {
    name: "stela-framed-tablet",
    layout: {
      ...cloneStelaLayout(STELA_PRESETS.framed_tablet),
      // The graph fixture is unchanged by construction dressing, while this
      // makes the geometry half of the fixture exercise the shipped base bond.
      stoneworkEnabled: true,
    },
  },
  { name: "stela-banded-column", layout: cloneStelaLayout(STELA_PRESETS.banded_column) },
  {
    name: "stela-weathered-tablet",
    layout: {
      ...cloneStelaLayout(STELA_PRESETS.tablet),
      conditionStage: "weathered",
      groundContact: "sunk",
      // Deep enough to take the plinth's face slots below the ground line, but
      // not the band above it: the fixture is worth more when it shows a slot
      // omitted, a slot kept and a slot clipped in one graph.
      burialDepth: 0.18,
      truncation: 0.22,
    },
  },
];

for (const fixture of STELA_FIXTURES) {
  assert.doesNotThrow(
    () => validateStelaLayout(fixture.layout),
    `${fixture.name}: fixture layout must satisfy the control table.`,
  );
  const graph = resolveStelaGraph(fixture.layout);
  const stela = graph.stelae[0]!;
  assert.equal(stela.archetype, fixture.layout.archetype);
  assert.deepEqual(
    graph.diagnostics.filter((entry) => entry.severity === "error"),
    [],
    `${fixture.name}: resolved with errors.`,
  );
  assertGraphInvariants(graph, fixture.name);
  assertMatchesFixture(fixture.name, graph);

  // Bands fill the body exactly. A rounding error here shows up as a seam.
  const bandTotal = stela.bands.reduce((sum, band) => sum + band.height, 0);
  assert.ok(
    Math.abs(bandTotal - (stela.body.topY - stela.body.bottomY)) < 1e-9,
    `${fixture.name}: bands do not sum to the body height.`,
  );
  assert.equal(
    stela.bands.filter((band) => band.role === "register").length,
    fixture.layout.registerCount,
  );
  assert.ok(
    !stela.base || (
      stela.base.footprint.minX <= stela.body.lower.minX + 1e-9
      && stela.base.footprint.maxX >= stela.body.lower.maxX - 1e-9
    ),
    `${fixture.name}: the base does not contain the body.`,
  );
  const stelaMasonry = toStelaMasonry(fixture.layout);
  if (stelaMasonry && stela.base) {
    let courseIndex = 0;
    for (const baseCourse of stela.base.courses) {
      const runs = [
        rectWidth(baseCourse.footprint),
        rectDepth(baseCourse.footprint),
        rectWidth(baseCourse.footprint),
        rectDepth(baseCourse.footprint),
      ];
      const courses = divideCourses(
        baseCourse.topY - baseCourse.bottomY,
        stelaMasonry,
        masonrySeed(fixture.layout.seed, baseCourse.id, "wall", "courses"),
      );
      for (const course of courses) {
        assert.equal(
          divideCourseRing(
            runs,
            stelaMasonry,
            courseIndex + course.index,
            masonrySeed(fixture.layout.seed, baseCourse.id, "wall", `course_${course.index}`),
          ).filter((block) => block.wrap > 0).length,
          4,
          `${fixture.name}: base course ${courseIndex + course.index} lost its interlock.`,
        );
      }
      courseIndex += courses.length;
    }
  }
  // A return face carries ribbons and refuses fields; that is what the role is for.
  const returnFaceIds = new Set(
    stela.faces.filter((face) => face.role === "return").map((face) => face.id),
  );
  assert.equal(
    stela.bays.some((bay) => returnFaceIds.has(bay.faceId)),
    false,
    `${fixture.name}: a return face was given a field bay.`,
  );

  // Build exactly what the family's own `build()` does. Tessellating with
  // `masonry: null` while the app passes a rule meant this suite went green on
  // geometry nobody ships — the blind spot that let a built base land unchecked.
  const geometry = mergeParts(tessellateStructure(graph, {
    masonry: toStelaMasonry(fixture.layout),
    seed: fixture.layout.seed,
    bevel: toStelaBevel(fixture.layout),
  }).parts, [MASS_SECTION]).geometry;
  const emitted = new Set(geometry.groups.map((group) => group.materialIndex));
  for (const slot of ["stelaBody", "stelaField", "pedestal", "frieze"] as const) {
    assert.ok(
      emitted.has(materialSlotIndex(slot)),
      `${fixture.name} emitted no ${slot} group.`,
    );
  }
  const coincidence = findCoincidentFaces(geometry);
  assert.equal(
    coincidence.pairs,
    0,
    `${fixture.name} emitted coincident faces: ${coincidence.sample}; ${coincidence.planes.join(", ")}.`,
  );
  const buried = findBuriedFaces(geometry);
  // The centroid probe cannot classify a masonry terrace top whose visible
  // ledge is narrower than the stone bed: the same legitimate top quad also
  // continues under the tier above. Keep the invariant on carved bases, where
  // every quad is wholly exposed or wholly covered; masonry still takes the
  // exact coincidence and outward-ray checks on either side of this assertion.
  if (!stelaMasonry) {
    assert.equal(buried.faces, 0, `${fixture.name} emitted buried faces: ${buried.sample}.`);
  }
  const backfaces = findBackfaces(geometry, 48);
  assert.equal(
    backfaces.backfaces,
    0,
    `${fixture.name} exposed missing outward faces near ${backfaces.sample}.`,
  );

  // The slot tint reclassifies faces and must change nothing else. A debug view
  // that quietly alters the mesh is a debug view that lies about the mesh.
  const tinted = mergeParts(tessellateStructure(graph, {
    seed: fixture.layout.seed,
    bevel: toStelaBevel(fixture.layout),
    masonry: toStelaMasonry(fixture.layout),
    debugSlots: true,
  }).parts, [MASS_SECTION]).geometry;
  assert.equal(
    tinted.getAttribute("position").count,
    geometry.getAttribute("position").count,
    `${fixture.name}: tinting slots changed the vertex count.`,
  );
  assert.equal(
    tinted.getIndex()?.count,
    geometry.getIndex()?.count,
    `${fixture.name}: tinting slots changed the triangle count.`,
  );
  assert.ok(
    new Set(tinted.groups.map((group) => group.materialIndex))
      .has(materialSlotIndex("slotDebug")),
    `${fixture.name}: tinting slots painted nothing.`,
  );
}

// A bevel is a surface treatment, exactly as masonry is: it changes what gets
// drawn and never what was resolved. If it reached the graph, every arris
// adjustment would invalidate the topology it was applied to.
for (const key of ["tablet", "framed_tablet", "banded_column"] as const) {
  const bevelled = cloneStelaLayout(STELA_PRESETS[key]);
  assert.equal(
    serializeGraph(resolveStelaGraph(bevelled)),
    serializeGraph(resolveStelaGraph({
      ...bevelled,
      bevelEnabled: false,
      bevelAmount: 0.09,
      bevelSegments: 6,
    })),
    `${key}: bevelling changed the resolved graph.`,
  );
}

// Damage never deletes the slot table. The broken tablet addresses exactly the
// slots its intact twin does, by the same ids; only their condition, surviving
// rectangle and depth budget differ. Without this, every condition change would
// silently renumber the composition an ornament system was authored against.
const intactTablet = resolveStelaGraph(cloneStelaLayout(STELA_PRESETS.tablet)).stelae[0]!;
const brokenTablet = resolveStelaGraph({
  ...cloneStelaLayout(STELA_PRESETS.tablet),
  truncation: 0.3,
}).stelae[0]!;
assert.deepEqual(
  brokenTablet.slots.map((slot) => slot.id),
  intactTablet.slots.map((slot) => slot.id),
  "Damage must annotate the slot table, never delete from it.",
);
assert.ok(intactTablet.slots.every((slot) => slot.condition === "intact"));
assert.ok(brokenTablet.slots.some((slot) => slot.condition === "partial"));
assert.equal(brokenTablet.crown, null);
assert.ok(brokenTablet.trunk.length < intactTablet.trunk.length);
for (const broken of brokenTablet.slots) {
  const whole = intactTablet.slots.find((slot) => slot.id === broken.id)!;
  assert.ok(
    broken.inscribed.vMax <= whole.inscribed.vMax + 1e-9,
    `${broken.id} grew under damage.`,
  );
}

// Authored vocabulary without a reader is a named error, never a silent
// fallback to whatever neighbour happens to be implemented. There are two
// guards and both matter: the control table never offers it, and the resolver
// refuses it again for anything assembled in code rather than in the pane.
for (const [field, layout] of [
  ["crown_treatment", { crownTreatment: "gabled" as const }],
  ["base_treatment", { baseTreatment: "rubble_packing" as const }],
  ["ground_contact", { groundContact: "socketed" as const }],
] as const) {
  const unreadable = { ...cloneStelaLayout(STELA_PRESETS.tablet), ...layout };
  assert.throws(
    () => resolveStela("stela_structure", unreadable),
    new RegExp(`stela\\.${field}_unimplemented`),
    `${field} must report a named error rather than falling back.`,
  );
  assert.throws(
    () => resolveStelaGraph(unreadable),
    /must be one of/,
    `${field} must not be selectable from the control table.`,
  );
}

// A register count the body cannot carry is an error, not a silent omission:
// the author asked for registers and would otherwise get none.
assert.throws(
  () => resolveStelaGraph({
    ...cloneStelaLayout(STELA_PRESETS.banded_column),
    bodyHeight: 1.2,
    registerCount: 8,
  }),
  /stela\.(register_density|band_allocation_mismatch)/,
);

// --- determinism -----------------------------------------------------------
// No Math.random, no clock: the same inputs must produce the same graph, every
// time, or nothing downstream can be reproduced from a seed.
const repeated = generateStructure(toStructureSpec(DEFAULT_MASS_LAYOUT));
const repeatedAgain = generateStructure(toStructureSpec(DEFAULT_MASS_LAYOUT));
assert.equal(serializeGraph(repeated), serializeGraph(repeatedAgain));

// Seed isolation. This is the check that keeps later phases from rotting this
// one: retuning a downstream subsystem's seed must leave the massing untouched.
// It passes now, with no condition system in existence, and has to keep passing
// once there is one.
const baseSpec = toStructureSpec(DEFAULT_MASS_LAYOUT);
const conditionShifted: StructureSpec = {
  ...baseSpec,
  seeds: createSeedSet(baseSpec.seeds.root, { condition: 4242, material: 99 }),
};
const shiftedGraph = generateStructure(conditionShifted);
assert.equal(
  massingFingerprint(shiftedGraph),
  massingFingerprint(repeated),
  "Changing the condition or material seed must not change the massing.",
);
assert.equal(
  subsystemSeed(conditionShifted.seeds, "massing"),
  subsystemSeed(baseSpec.seeds, "massing"),
);
assert.notEqual(
  subsystemSeed(conditionShifted.seeds, "condition"),
  subsystemSeed(baseSpec.seeds, "condition"),
);
// The graph carries every resolved subsystem seed, so the isolation is visible
// in the serialized artefact and not just in the derivation.
assert.equal(shiftedGraph.seeds.massing, repeated.seeds.massing);
assert.notEqual(shiftedGraph.seeds.condition, repeated.seeds.condition);
assert.notEqual(shiftedGraph.seeds.material, repeated.seeds.material);

// A different root seed is allowed to change everything, or the seed would be
// doing nothing at all.
const rerooted = generateStructure({
  ...baseSpec,
  seeds: createSeedSet(baseSpec.seeds.root + 1),
});
assert.notEqual(rerooted.seeds.massing, repeated.seeds.massing);
assert.notEqual(rerooted.seeds.condition, repeated.seeds.condition);

// Per-entity derivation. Entities addressed by their own id keep stable streams
// as siblings come and go, which is what lets one band be regenerated without
// reshuffling the rest.
const seeds = createSeedSet(17);
assert.equal(
  deriveSeed(seeds, "massing", "band_02"),
  deriveSeed(seeds, "massing", "band_02"),
);
assert.notEqual(
  deriveSeed(seeds, "massing", "band_02"),
  deriveSeed(seeds, "massing", "band_03"),
);
assert.notEqual(
  deriveSeed(seeds, "massing", "band_02"),
  deriveSeed(seeds, "condition", "band_02"),
);
// Paths compose, so a child's stream is independent of its siblings' depth.
assert.equal(
  deriveSeed(seeds, "facade", "band_02", "facade_front"),
  deriveSeed(seeds, "facade", "band_02", "facade_front"),
);
assert.notEqual(
  deriveSeed(seeds, "facade", "band_02", "facade_front"),
  deriveSeed(seeds, "facade", "band_02", "facade_rear"),
);

// --- declared but unimplemented --------------------------------------------
// Every vocabulary is authored complete and only partly implemented. An
// unimplemented member has to be a named error: a silent fallback would let a
// profile written today quietly come to mean something else later.
const UNIMPLEMENTED: readonly {
  readonly label: string;
  readonly code: string;
  readonly mutate: (spec: StructureSpec) => StructureSpec;
}[] = [
  {
    label: "wall profile",
    code: "band.wall_profile_unimplemented",
    mutate: (spec) => ({ ...spec, mass: { ...spec.mass, wallProfile: "concave" } }),
  },
  {
    label: "base treatment",
    code: "base.treatment_unimplemented",
    mutate: (spec) => ({ ...spec, mass: { ...spec.mass, baseTreatment: "stepped_apron" } }),
  },
  {
    label: "summit treatment",
    code: "summit.treatment_unimplemented",
    mutate: (spec) => ({ ...spec, mass: { ...spec.mass, summitTreatment: "parapet" } }),
  },
  {
    label: "corner treatment",
    code: "footprint.corner_treatment_unimplemented",
    mutate: (spec) => ({
      ...spec,
      mass: {
        ...spec.mass,
        footprint: { ...spec.mass.footprint, cornerTreatment: "chamfer" },
      },
    }),
  },
  {
    label: "composite footprint",
    code: "footprint.composite_unimplemented",
    mutate: (spec) => ({
      ...spec,
      mass: {
        ...spec.mass,
        footprint: {
          ...spec.mass.footprint,
          rects: [
            ...spec.mass.footprint.rects,
            { minX: 0, maxX: 4, minZ: 0, maxZ: 4 },
          ],
        },
      },
    }),
  },
  {
    label: "stair layout",
    code: "stair.layout_unimplemented",
    mutate: (spec) => ({
      ...spec,
      stairs: spec.stairs.map((stair, index) =>
        index === 0 ? { ...stair, layout: "four_sided" } : stair),
    }),
  },
  {
    label: "stair elevation mode",
    code: "stair.elevation_mode_unimplemented",
    mutate: (spec) => ({
      ...spec,
      stairs: spec.stairs.map((stair, index) =>
        index === 0 ? { ...stair, elevationMode: "band_local" } : stair),
    }),
  },
  {
    label: "stair side treatment",
    code: "stair.side_treatment_unimplemented",
    mutate: (spec) => ({
      ...spec,
      stairs: spec.stairs.map((stair, index) =>
        index === 0 ? { ...stair, sideTreatment: "serpent_like_profile" } : stair),
    }),
  },
  {
    label: "stair landing rule",
    code: "stair.landing_rule_unimplemented",
    mutate: (spec) => ({
      ...spec,
      stairs: spec.stairs.map((stair, index) =>
        index === 0 ? { ...stair, landingRule: "at_every_terrace" } : stair),
    }),
  },
];

for (const unimplemented of UNIMPLEMENTED) {
  const graph = generateStructure(unimplemented.mutate(baseSpec));
  const errors = graph.diagnostics.filter((entry) => entry.severity === "error");

  assert.equal(errors.length, 1, `${unimplemented.label}: expected exactly one error.`);
  assert.equal(errors[0]?.code, unimplemented.code);
  assert.ok(errors[0]?.entityId, `${unimplemented.label}: error must name an entity.`);
  assert.ok(
    errors[0]?.message.includes("not implemented"),
    `${unimplemented.label}: error must say what was not implemented.`,
  );
  // A refused build produces no geometry rather than something half-formed.
  assert.equal(graph.patches.length, 0);
  assert.equal(graph.masses.length, 0);
}

// A hand-authored profile can still invert its own footprint. The pane cannot
// reach this, because setbacks there are derived from a summit ratio, but a
// config file or a later phase's generated profile can.
const inverted = generateStructure({
  ...baseSpec,
  mass: {
    ...baseSpec.mass,
    setbackScales: { front: 9, rear: 9, sidePositiveU: 9, sideNegativeU: 9 },
  },
});
const invertedErrors = inverted.diagnostics.filter((entry) => entry.severity === "error");
assert.equal(invertedErrors.length, 1);
assert.equal(invertedErrors[0]?.code, "band.setback_inverts_footprint");
assert.ok(invertedErrors[0]?.entityId.includes("band_"));

// When the batter alone already narrows the mass past the requested summit, the
// generator says so and reports what it actually achieved, rather than absorbing
// the difference where nobody would see it.
const overBattered = generateStructure({
  ...baseSpec,
  mass: {
    ...baseSpec.mass,
    batterDegrees: 34,
    totalHeight: 10,
    summitRatio: 0.9,
  },
});
const shortfall = overBattered.diagnostics.find(
  (entry) => entry.code === "mass.summit_smaller_than_requested",
);
assert.ok(shortfall, "An unreachable summit ratio must be reported.");
assert.equal(shortfall?.severity, "notice");
assert.ok(shortfall?.resolved, "A repair must record the value it used.");

// --- batter defines the profile --------------------------------------------
// There is no separate wall-profile control: a battered wall at zero degrees is
// a vertical wall, and having both made it possible to pick "battered" and see
// nothing change. The role and the evaluator both follow the angle.
assert.equal(wallProfileForBatter(0), "vertical");
assert.equal(wallProfileForBatter(0.5), "battered");

for (const [batterAngle, role, evaluator] of [
  [0, PATCH_ROLES.verticalFacade, "planar"],
  [14, PATCH_ROLES.batteredFacade, "battered"],
] as const) {
  const graph = generateStructure(
    toStructureSpec({ ...cloneFrontStairLayout(), batterAngle }),
  );
  // The base plinth is a band too, but it is a projecting footing rather than a
  // profiled wall, so it keeps its own role whatever the batter is.
  const facades = graph.patches.filter(
    (patch) => patch.id.includes("facade_") && !patch.id.includes("/base/"),
  );

  assert.ok(facades.length > 0);
  for (const facade of facades) {
    assert.equal(facade.role, role, `batter ${batterAngle}: wrong facade role`);
    assert.equal(facade.evaluator, evaluator);
  }

  // A vertical band's crown matches its base; a battered one's is narrower.
  const band = graph.masses[0]?.bands.find((entry) => entry.index === 0);
  assert.ok(band);
  const narrowing = (band.lower.maxX - band.lower.minX)
    - (band.upper.maxX - band.upper.minX);
  assert.ok(
    batterAngle === 0 ? narrowing < 1e-9 : narrowing > 0,
    `batter ${batterAngle}: band narrowing disagrees with the angle`,
  );
}

// The rest of the profile vocabulary is not derivable from an angle, so it stays
// authored on the spec — and unimplemented members still refuse.
const authoredProfile = generateStructure({
  ...baseSpec,
  mass: { ...baseSpec.mass, wallProfile: "convex" },
});
assert.equal(
  authoredProfile.diagnostics[0]?.code,
  "band.wall_profile_unimplemented",
);

// --- cornices --------------------------------------------------------------
// Which bands carry one is a rule, since bands are generated rather than listed.
const CORNICE_CASES: readonly {
  readonly placement: CornicePlacement;
  readonly expected: readonly number[];
}[] = [
  { placement: "none", expected: [] },
  { placement: "all", expected: [0, 1, 2, 3, 4] },
  { placement: "crown", expected: [4] },
  { placement: "terraces", expected: [0, 1, 2, 3] },
  { placement: "alternate", expected: [0, 2, 4] },
];

for (const { placement, expected } of CORNICE_CASES) {
  assert.deepEqual(
    [0, 1, 2, 3, 4].filter((index) => bandCarriesCornice(placement, index, 5)),
    expected,
    `Placement "${placement}" selected the wrong bands.`,
  );
}

const CORNICE_LAYOUT: MassLayoutConfig = {
  ...cloneFrontStairLayout(),
  bandCount: 5,
  totalHeight: 12,
  batterAngle: 14,
  cornicePlacement: "all",
  corniceProjection: 0.25,
  corniceHeight: 0.3,
};
assert.doesNotThrow(
  () => validateMassLayout(CORNICE_LAYOUT),
  "The cornice test layout must sit inside the control ranges.",
);
const bare = generateStructure(toStructureSpec({
  ...CORNICE_LAYOUT,
  cornicePlacement: "none",
}));
const corniced = generateStructure(toStructureSpec(CORNICE_LAYOUT));

assert.deepEqual(
  corniced.diagnostics.filter((entry) => entry.severity === "error"),
  [],
);

// A cornice takes over the top of its band rather than sitting on top of it, so
// adding one must leave the elevation profile exactly where it was. This is what
// lets cornices be switched on late without redoing the massing underneath.
const bareBands = bare.masses[0]?.bands ?? [];
const cornicedBands = corniced.masses[0]?.bands ?? [];
assert.equal(cornicedBands.length, bareBands.length);

for (let index = 0; index < bareBands.length; index += 1) {
  const before = bareBands[index];
  const after = cornicedBands[index];
  assert.ok(before && after);
  assert.equal(after.bottomY, before.bottomY, "A cornice moved a band's base.");
  assert.equal(after.topY, before.topY, "A cornice moved a band's top.");
  assert.deepEqual(after.lower, before.lower, "A cornice moved a band's footprint.");
  assert.deepEqual(after.upper, before.upper, "A cornice moved a band's crown.");
}

// The plinth is a footing, not a wall being finished, so it never takes one.
const plinth = cornicedBands.find((band) => band.index < 0);
assert.ok(plinth);
assert.equal(plinth.cornice, null);

for (const band of cornicedBands.filter((entry) => entry.index >= 0)) {
  const { cornice } = band;
  assert.ok(cornice, `Band ${band.id} should carry a cornice.`);

  // It occupies the top of the band, and never more than half of it.
  assert.ok(Math.abs(cornice.bottomY + cornice.height - band.topY) < 1e-9);
  assert.ok(cornice.bottomY > band.bottomY);
  assert.ok(cornice.height <= band.rise * MAX_CORNICE_RISE_SHARE + 1e-9);

  // It projects past the wall on every side, or the soffit under it inverts.
  assert.ok(cornice.outline.minX < cornice.springing.minX);
  assert.ok(cornice.outline.maxX > cornice.springing.maxX);
  assert.ok(cornice.outline.minZ < cornice.springing.minZ);
  assert.ok(cornice.outline.maxZ > cornice.springing.maxZ);
  // And past the crown, which on a battered wall is narrower still.
  assert.ok(cornice.outline.maxX > band.upper.maxX);

  assert.equal(band.upperTransition, "beveled_molding");
}

// The wall's crown edge records what finishes it, so a cornice is addressable as
// the edge feature it is rather than as loose geometry that happens to sit there.
for (const patch of corniced.patches) {
  if (!patch.id.includes("facade_") || patch.id.includes("/base/")) {
    continue;
  }

  assert.equal(
    patch.edges.vMax.treatment,
    "cornice",
    `${patch.id} carries a cornice but its crown edge does not say so.`,
  );
  assert.equal(patch.edges.vMin.treatment, null);
}

for (const patch of bare.patches) {
  // Stair edges carry their own vocabulary — terminations and caps — which is
  // exactly why treatments are per-edge rather than a cornice flag.
  if (patch.role.startsWith("stair")) {
    continue;
  }

  assert.equal(patch.edges.vMax.treatment, null);
}

// A cornice taller than the band it crowns is shortened and reported. Reachable
// from the pane now that the range is a trim's rather than a storey's: it takes
// shallow bands rather than an absurd cornice.
const squashedLayout: MassLayoutConfig = {
  ...CORNICE_LAYOUT,
  totalHeight: 2,
  corniceHeight: 0.3,
};
assert.doesNotThrow(() => validateMassLayout(squashedLayout));

const squashed = generateStructure(toStructureSpec(squashedLayout));
const squashedNotice = squashed.diagnostics.find(
  (entry) => entry.code === "cornice.height_exceeds_band",
);
assert.ok(squashedNotice, "An oversized cornice must be reported.");
assert.equal(squashedNotice?.severity, "notice");
assert.ok(squashed.patches.length > 0, "An oversized cornice must still build.");

// --- stairs ----------------------------------------------------------------
// A stair is a connector, not a facade pattern: it joins two traversable
// patches, resolves an integer step count from a target riser, and reserves
// the ground it climbs in front of. The record is checked before the geometry
// because everything downstream reads the record.
const stairDefault = generateStructure(toStructureSpec(cloneFrontStairLayout()));
assert.equal(stairDefault.connectors.length, 1, "The default Mass carries one stair.");
const stairRecord = stairDefault.connectors[0]!;
const stairPatches = patchIndex(stairDefault);
const occlusionSteps = stairSteps(stairRecord);
const occlusionStep = occlusionSteps[Math.floor(occlusionSteps.length * 0.5)]!;
const occlusionZ0 = stairRecord.flightRect.minZ
  + occlusionStep.vBack
  + stairRecord.tread * 0.2;
const occlusionZ1 = stairRecord.flightRect.minZ
  + occlusionStep.vFront
  - stairRecord.tread * 0.2;
const horizontalFace = (
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  y: number,
) => [
  { x: x0, y, z: z0 },
  { x: x0, y, z: z1 },
  { x: x1, y, z: z1 },
  { x: x1, y, z: z0 },
];

assert.ok(faceIsCoveredByStair(
  horizontalFace(
    stairRecord.flightRect.minX + stairRecord.width * 0.2,
    stairRecord.flightRect.maxX - stairRecord.width * 0.2,
    occlusionZ0,
    occlusionZ1,
    occlusionStep.topY,
  ),
  stairRecord,
), "A face wholly beneath a tread was not selected.");

const assemblyMinX = stairRecord.flightRect.minX - stairRecord.parapet!.width;
assert.equal(faceIsCoveredByStair(
  horizontalFace(
    assemblyMinX - 0.1,
    stairRecord.flightRect.minX,
    occlusionZ0,
    occlusionZ1,
    occlusionStep.topY,
  ),
  stairRecord,
), false, "A partially covered face was selected.");

const lowerStep = occlusionSteps[occlusionStep.index - 1]!;
assert.equal(faceIsCoveredByStair(
  horizontalFace(
    stairRecord.flightRect.minX + stairRecord.width * 0.2,
    stairRecord.flightRect.maxX - stairRecord.width * 0.2,
    stairRecord.flightRect.minZ
      + occlusionStep.vBack
      + stairRecord.tread * 0.2,
    stairRecord.flightRect.minZ
      + lowerStep.vBack
      + stairRecord.tread * 0.2,
    lowerStep.topY + stairRecord.riser * 0.5,
  ),
  stairRecord,
), false, "A face crossing above the lower tread was selected.");

const parapetProbeY = occlusionStep.topY + stairRecord.parapet!.height * 0.5;
assert.ok(faceIsCoveredByStair(
  horizontalFace(
    assemblyMinX + stairRecord.parapet!.width * 0.2,
    stairRecord.flightRect.minX - stairRecord.parapet!.width * 0.2,
    occlusionZ0,
    occlusionZ1,
    parapetProbeY,
  ),
  stairRecord,
), "A face wholly beneath a parapet cap was not selected.");
assert.equal(faceIsCoveredByStair(
  horizontalFace(
    stairRecord.flightRect.minX + stairRecord.width * 0.2,
    stairRecord.flightRect.maxX - stairRecord.width * 0.2,
    occlusionZ0,
    occlusionZ1,
    parapetProbeY,
  ),
  stairRecord,
), false, "The parapet's raised cover leaked across the flight.");

assert.equal(stairRecord.layout, "front_centered");
assert.equal(stairRecord.elevationMode, "continuous");
assert.equal(
  stairRecord.lowerPatchId,
  stairDefault.patches.find((patch) => patch.role === PATCH_ROLES.groundInterface)?.id,
);
assert.equal(stairRecord.upperPatchId, stairDefault.masses[0]?.summit.patchId);

// The step rule resolved: riser near its target, tread at its target when the
// pitch already clears the profile, and the whole rise consumed exactly.
assert.ok(Math.abs(stairRecord.riser - 0.26) < 0.26 * 0.2);
assert.equal(stairRecord.tread, 0.32);
assert.ok(
  Math.abs(stairRecord.topY - stairRecord.bottomY
    - stairRecord.stepCount * stairRecord.riser) < 1e-9,
);

// Continuous and front-centred: the flight lands on the summit's front edge,
// centred on the footprint, and its foot projects past the base of the mass.
const stairSummit = stairDefault.masses[0]!.summit;
assert.ok(Math.abs(stairRecord.flightRect.minZ - stairSummit.rect.maxZ) < 1e-9);
assert.ok(
  Math.abs(
    (stairRecord.flightRect.minX + stairRecord.flightRect.maxX)
    - (stairDefault.masses[0]!.footprint.minX + stairDefault.masses[0]!.footprint.maxX),
  ) < 1e-9,
  "The flight is not centred on its facade.",
);
assert.ok(
  stairRecord.flightRect.maxZ > stairDefault.masses[0]!.footprint.maxZ,
  "A continuous flight at walkable pitch must project past the base.",
);
assert.deepEqual(stairRecord.termination, { lower: "projecting", upper: "flush" });

// The flight is one stepped surface, and its terminations live on its v edges.
const flightPatch = stairPatches.get(`${stairRecord.id}/flight`);
assert.ok(flightPatch, "The stair emits its flight patch.");
assert.equal(flightPatch.role, PATCH_ROLES.stairFlight);
assert.equal(flightPatch.evaluator, "stepped");
assert.equal(flightPatch.edges.vMin.treatment, "projecting");
assert.equal(flightPatch.edges.vMax.treatment, "flush");
assert.ok(flightPatch.tags.includes("traversable"));
assert.ok(flightPatch.adjacency.includes(stairRecord.lowerPatchId));
assert.ok(flightPatch.adjacency.includes(stairRecord.upperPatchId));

// Its frame runs from the projecting foot to the summit edge: v = 1 lands
// exactly on the arrival, whatever the step count resolved to.
const arrival = evaluateFrame(flightPatch.frame, 0.5, 1);
assert.ok(Math.abs(arrival.y - stairRecord.topY) < 1e-9);
assert.ok(Math.abs(arrival.z - stairRecord.flightRect.minZ) < 1e-9);

// Side treatments are patches of their own, gone when the sides are open.
assert.equal(stairRecord.patchIds.length, 3);
assert.ok(stairPatches.has(`${stairRecord.id}/side_negative_u`));
const openSided = generateStructure(toStructureSpec({
  ...cloneFrontStairLayout(),
  stairSideTreatment: "none",
}));
assert.equal(openSided.connectors[0]?.parapet, null);
assert.equal(openSided.connectors[0]?.patchIds.length, 1);

// Every front facade carries the reservation; no other orientation does.
for (const patch of stairDefault.patches) {
  if (!patch.id.includes("facade_")) {
    continue;
  }

  const reserves = patch.regions.filter((region) => region.tags.includes("stair"));

  if (patch.id.endsWith("facade_front")) {
    assert.equal(reserves.length, 1, `${patch.id} is missing its stair reserve.`);
    assert.ok(reserves[0]!.tags.includes("no_build"));
  } else {
    assert.equal(reserves.length, 0, `${patch.id} reserves ground for a stair it does not face.`);
  }
}

// Switched off, the stair leaves nothing behind: no connector, no patches, no
// reservations. The massing itself must be identical.
const stairlessLayout: MassLayoutConfig = {
  ...cloneFrontStairLayout(),
  ...STAIRS_DISABLED,
};
const stairless = generateStructure(toStructureSpec(stairlessLayout));
assert.deepEqual(stairless.connectors, []);
assert.ok(
  stairless.patches.every((patch) => !patch.role.startsWith("stair")),
);
assert.ok(
  stairless.patches.every((patch) =>
    patch.regions.every((region) => !region.tags.includes("stair"))),
);
assert.deepEqual(
  stairless.masses.map((mass) => ({
    footprint: mass.footprint,
    baseTreatment: mass.baseTreatment,
    bands: mass.bands,
    totalHeight: mass.totalHeight,
  })),
  stairDefault.masses.map((mass) => ({
    footprint: mass.footprint,
    baseTreatment: mass.baseTreatment,
    bands: mass.bands,
    totalHeight: mass.totalHeight,
  })),
  "Removing the stair must not move the mass bands.",
);
const stairlessSummitPatch = stairless.patches.find(
  (patch) => patch.role === PATCH_ROLES.summitFloor,
)!;
const stairlessBuildable = stairlessSummitPatch.regions.find(
  (region) => region.tags.includes("buildable")
    && !region.tags.includes("superstructure"),
)!;
const stairlessBuildingPad = stairlessSummitPatch.regions.find(
  (region) => region.tags.includes("superstructure"),
)!;
const expectedStairlessRanges = [
  (1 - stairlessLayout.summitBuildingWidthRatio) * 0.5,
  (1 + stairlessLayout.summitBuildingWidthRatio) * 0.5,
  (1 - stairlessLayout.summitBuildingDepthRatio) * 0.5,
  (1 + stairlessLayout.summitBuildingDepthRatio) * 0.5,
];
const actualStairlessRanges = [
  ...stairlessBuildingPad.uRange,
  ...stairlessBuildingPad.vRange,
];
assert.ok(
  actualStairlessRanges.every(
    (value, index) => Math.abs(value - expectedStairlessRanges[index]!) < 1e-9,
  ),
  "The configured summit footprint must not depend on whether stairs are enabled.",
);
assert.deepEqual(stairlessBuildable.uRange, [0, 1]);
assert.deepEqual(stairlessBuildable.vRange, [0, 1]);
const stairlessMass = stairless.masses[0]!;
const stairlessPadRect = {
  minX: stairlessMass.summit.rect.minX
    + rectWidth(stairlessMass.summit.rect) * stairlessBuildingPad.uRange[0],
  maxX: stairlessMass.summit.rect.minX
    + rectWidth(stairlessMass.summit.rect) * stairlessBuildingPad.uRange[1],
  minZ: stairlessMass.summit.rect.minZ
    + rectDepth(stairlessMass.summit.rect) * stairlessBuildingPad.vRange[0],
  maxZ: stairlessMass.summit.rect.minZ
    + rectDepth(stairlessMass.summit.rect) * stairlessBuildingPad.vRange[1],
};
for (const edge of ["minX", "maxX", "minZ", "maxZ"] as const) {
  assert.ok(
    Math.abs(stairlessMass.summit.buildingPad![edge] - stairlessPadRect[edge]) < 1e-9,
    `The summit record and building-pad region disagree at ${edge}.`,
  );
}
assert.deepEqual(
  stairlessMass.summit.placement,
  {
    rect: stairlessMass.summit.buildingPad,
    patchId: stairlessSummitPatch.id,
    y: stairlessMass.summit.y,
    anchorId: `${stairlessSummitPatch.id}/anchor_superstructure`,
  },
);
assert.deepEqual(stairlessSummitPatch.anchors, [{
  id: `${stairlessSummitPatch.id}/anchor_superstructure`,
  kind: "superstructure",
  u: 0.5,
  v: 0.5,
  d: 0,
  regionId: stairlessBuildingPad.id,
  orientation: "front",
}]);

// Each checkbox independently adds exactly one centred connector to its facade.
const STAIR_DIRECTIONS: readonly {
  readonly direction: HorizontalOrientation;
  readonly enabled: Partial<MassLayoutConfig>;
  readonly facade: string;
  readonly forecourt: string;
}[] = [
  {
    direction: "front",
    enabled: { stairFrontEnabled: true },
    facade: "facade_front",
    forecourt: "/forecourt",
  },
  {
    direction: "rear",
    enabled: { stairRearEnabled: true },
    facade: "facade_rear",
    forecourt: "/forecourt_rear",
  },
  {
    direction: "sideNegativeU",
    enabled: { stairLeftEnabled: true },
    facade: "facade_side_negative_u",
    forecourt: "/forecourt_side_negative_u",
  },
  {
    direction: "sidePositiveU",
    enabled: { stairRightEnabled: true },
    facade: "facade_side_positive_u",
    forecourt: "/forecourt_side_positive_u",
  },
];

for (const placement of STAIR_DIRECTIONS) {
  const graph = generateStructure(toStructureSpec({
    ...cloneFrontStairLayout(),
    ...STAIRS_DISABLED,
    ...placement.enabled,
  }));
  assert.deepEqual(
    graph.connectors.map((connector) => connector.direction),
    [placement.direction],
    `${placement.direction}: its checkbox did not produce exactly its connector.`,
  );
  assert.ok(
    graph.patches
      .filter((patch) => patch.id.endsWith(placement.facade))
      .every((patch) =>
        patch.regions.filter((region) => region.tags.includes("stair")).length === 1),
    `${placement.direction}: its facade did not reserve the connector width.`,
  );
  const summitPatch = graph.patches.find(
    (patch) => patch.role === PATCH_ROLES.summitFloor,
  )!;
  assert.equal(
    summitPatch.regions.filter((region) => region.tags.includes("stair_arrival")).length,
    1,
  );
  assert.ok(
    summitPatch.regions.some((region) => region.id.endsWith(placement.forecourt)),
    `${placement.direction}: its summit forecourt is missing.`,
  );
}

// All four use the same sizing, parapet, cornice and tiling settings while
// resolving against the width of their own facade.
const allSidesLayout: MassLayoutConfig = {
  ...cloneFrontStairLayout(),
  footprintWidth: 30,
  footprintDepth: 18,
  bandCount: 2,
  totalHeight: 2.4,
  baseTreatment: "none",
  summitRatio: 0.9,
  stairFrontEnabled: true,
  stairRearEnabled: true,
  stairLeftEnabled: true,
  stairRightEnabled: true,
  stairSideTreatment: "sloped_parapet",
  stairParapetCorniceProjection: 0.1,
  stairParapetCorniceHeight: 0.1,
};
const allSides = generateStructure(toStructureSpec(allSidesLayout));
assertGraphInvariants(allSides, "all four stairs");
assert.deepEqual(
  allSides.connectors.map((connector) => connector.direction),
  ["front", "rear", "sideNegativeU", "sidePositiveU"],
);
assert.equal(new Set(allSides.connectors.map((connector) => connector.id)).size, 4);

const allSidesMass = allSides.masses[0]!;
for (const connector of allSides.connectors) {
  assert.ok(connector.parapet?.cornice, `${connector.direction}: shared cornice is missing.`);
  assert.equal(connector.parapet?.cornice?.projection, 0.1);
  const arrivalPoint = stairLocalVertex(connector, 0, connector.topY, 0);
  const centerX = (allSidesMass.summit.rect.minX + allSidesMass.summit.rect.maxX) * 0.5;
  const centerZ = (allSidesMass.summit.rect.minZ + allSidesMass.summit.rect.maxZ) * 0.5;

  switch (connector.direction) {
    case "front":
      assert.ok(Math.abs(arrivalPoint.x - centerX) < 1e-9);
      assert.ok(Math.abs(arrivalPoint.z - allSidesMass.summit.rect.maxZ) < 1e-9);
      break;
    case "rear":
      assert.ok(Math.abs(arrivalPoint.x - centerX) < 1e-9);
      assert.ok(Math.abs(arrivalPoint.z - allSidesMass.summit.rect.minZ) < 1e-9);
      break;
    case "sidePositiveU":
      assert.ok(Math.abs(arrivalPoint.x - allSidesMass.summit.rect.maxX) < 1e-9);
      assert.ok(Math.abs(arrivalPoint.z - centerZ) < 1e-9);
      break;
    case "sideNegativeU":
      assert.ok(Math.abs(arrivalPoint.x - allSidesMass.summit.rect.minX) < 1e-9);
      assert.ok(Math.abs(arrivalPoint.z - centerZ) < 1e-9);
      break;
  }
}
assert.equal(
  allSides.patches
    .filter((patch) => patch.id.includes("facade_"))
    .flatMap((patch) => patch.regions)
    .filter((region) => region.tags.includes("stair")).length,
  allSidesMass.bands.length * 4,
);
const allSidesSummitPatch = allSides.patches.find(
  (patch) => patch.role === PATCH_ROLES.summitFloor,
)!;
assert.equal(
  allSidesSummitPatch.regions.filter(
    (region) => region.tags.includes("stair_arrival"),
  ).length,
  4,
);
const allSidesBuildable = allSidesSummitPatch.regions.find(
  (region) => region.id.endsWith("/buildable"),
)!;
const allSidesBuildingPad = allSidesSummitPatch.regions.find(
  (region) => region.id.endsWith("/building_pad"),
)!;
assert.ok(
  allSidesBuildingPad.uRange[0] > allSidesBuildable.uRange[0]
  && allSidesBuildingPad.uRange[1] < allSidesBuildable.uRange[1]
  && allSidesBuildingPad.vRange[0] > allSidesBuildable.vRange[0]
  && allSidesBuildingPad.vRange[1] < allSidesBuildable.vRange[1],
  "The configured summit footprint must leave clearance on every side.",
);
const allSidesPadRect = {
  minX: allSidesMass.summit.rect.minX
    + rectWidth(allSidesMass.summit.rect) * allSidesBuildingPad.uRange[0],
  maxX: allSidesMass.summit.rect.minX
    + rectWidth(allSidesMass.summit.rect) * allSidesBuildingPad.uRange[1],
  minZ: allSidesMass.summit.rect.minZ
    + rectDepth(allSidesMass.summit.rect) * allSidesBuildingPad.vRange[0],
  maxZ: allSidesMass.summit.rect.minZ
    + rectDepth(allSidesMass.summit.rect) * allSidesBuildingPad.vRange[1],
};
for (const edge of ["minX", "maxX", "minZ", "maxZ"] as const) {
  assert.ok(
    Math.abs(allSidesMass.summit.buildingPad![edge] - allSidesPadRect[edge]) < 1e-9,
    `The four-forecourt building pad disagrees at ${edge}.`,
  );
}

// The culling rule follows the connector's local frame as well: this probe is
// beneath a right-side tread, where world X is the stair run.
const rightStair = allSides.connectors.find(
  (connector) => connector.direction === "sidePositiveU",
)!;
const rightStep = stairSteps(rightStair)[Math.floor(rightStair.stepCount * 0.5)]!;
const rightProbe = [
  stairLocalVertex(rightStair, -rightStair.width * 0.2, rightStep.topY, rightStep.vBack + rightStair.tread * 0.2),
  stairLocalVertex(rightStair, -rightStair.width * 0.2, rightStep.topY, rightStep.vFront - rightStair.tread * 0.2),
  stairLocalVertex(rightStair, rightStair.width * 0.2, rightStep.topY, rightStep.vFront - rightStair.tread * 0.2),
  stairLocalVertex(rightStair, rightStair.width * 0.2, rightStep.topY, rightStep.vBack + rightStair.tread * 0.2),
];
assert.ok(
  faceIsCoveredByStair(rightProbe, rightStair),
  "A face beneath a side stair tread was not selected.",
);
assert.ok(
  rightProbe.every((corner) => {
    const local = stairWorldToLocal(rightStair, corner);
    return Math.abs(local.u) <= rightStair.width * 0.2 + 1e-9
      && local.v >= rightStep.vBack - 1e-9
      && local.v <= rightStep.vFront + 1e-9;
  }),
);

const allSidesRule = toMasonry(allSidesLayout, DEFAULT_MASS_STONE_CONFIG);
assert.ok(allSidesRule);
for (const masonry of [null, allSidesRule] as const) {
  const result = tessellateStructure(allSides, {
    masonry,
    seed: 17,
    stairTilesPerStep: allSidesLayout.stairTilesPerStep,
  });
  const geometry = result.parts[0]!.geometry;
  assert.equal(
    findCoincidentFaces(geometry).pairs,
    0,
    `Four ${masonry ? "masonry" : "bare"} stairs emitted coincident faces.`,
  );
  assert.equal(
    findBackfaces(geometry).backfaces,
    0,
    `Four ${masonry ? "masonry" : "bare"} stairs left visible backfaces.`,
  );
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox!;
  const expected = graphExtents(allSides)!;
  for (const axis of ["x", "y", "z"] as const) {
    const tolerance = Math.max(1e-5, Math.abs(expected.max[axis]) * 1e-6);
    assert.ok(Math.abs(bounds.min[axis] - expected.min[axis]) < tolerance);
    assert.ok(Math.abs(bounds.max[axis] - expected.max[axis]) < tolerance);
  }
  if (!masonry) {
    assertMassNormals(geometry, "all four bare stairs", allSides);
  }
}

const allSteppedSides = generateStructure(toStructureSpec({
  ...allSidesLayout,
  stairSideTreatment: "stepped_parapet",
  stairSteppedParapetCorniceProjection: 0.1,
  stairSteppedParapetCorniceHeight: 0.1,
}));
assertGraphInvariants(allSteppedSides, "all four stepped stairs");
const allSteppedGeometry = tessellateStructure(allSteppedSides, {
  masonry: null,
  seed: 17,
  stairTilesPerStep: allSidesLayout.stairTilesPerStep,
}).parts[0]!.geometry;
assert.equal(
  findCoincidentFaces(allSteppedGeometry).pairs,
  0,
  "Four stepped corniced stairs emitted coincident faces.",
);
assert.equal(
  findBackfaces(allSteppedGeometry).backfaces,
  0,
  "Four stepped corniced stairs left visible backfaces.",
);

// A raised summit pad is one clean extrusion over the authoritative placement
// footprint. It owns its top and side patches, while the original summit
// floor owns only the exposed ring around its footprint.
const raisedPadLayout: MassLayoutConfig = {
  ...cloneFrontStairLayout(),
  footprintWidth: 30,
  footprintDepth: 24,
  summitRatio: 0.72,
  summitTreatment: "raised_pad",
  summitBuildingWidthRatio: 0.7,
  summitBuildingDepthRatio: 0.65,
  summitPadHeight: 0.65,
};
const raisedPadGraph = generateStructure(toStructureSpec(raisedPadLayout));
assert.deepEqual(
  raisedPadGraph.diagnostics.filter((entry) => entry.severity === "error"),
  [],
);
assertGraphInvariants(raisedPadGraph, "raised summit pad");
const raisedPadMass = raisedPadGraph.masses[0]!;
const raisedPad = raisedPadMass.summit.pad!;
assert.ok(raisedPad);
assert.equal(raisedPad.band.bottomY, raisedPadMass.summit.y);
assert.equal(raisedPad.band.topY, raisedPadMass.summit.y + 0.65);
assert.deepEqual(raisedPad.band.lower, raisedPadMass.summit.buildingPad);
assert.deepEqual(raisedPad.band.upper, raisedPadMass.summit.buildingPad);
assert.ok(
  Math.abs(
    rectWidth(raisedPad.band.lower)
      - rectWidth(raisedPadMass.summit.rect) * raisedPadLayout.summitBuildingWidthRatio,
  ) < 1e-9,
);
assert.ok(
  Math.abs(
    rectDepth(raisedPad.band.lower)
      - rectDepth(raisedPadMass.summit.rect) * raisedPadLayout.summitBuildingDepthRatio,
  ) < 1e-9,
);
assert.equal(raisedPadMass.summit.placement?.patchId, raisedPad.topPatchId);
assert.equal(raisedPadMass.summit.placement?.y, raisedPad.band.topY);

const raisedBasePatch = raisedPadGraph.patches.find(
  (patch) => patch.id === raisedPadMass.summit.patchId,
)!;
const raisedTopPatch = raisedPadGraph.patches.find(
  (patch) => patch.id === raisedPad.topPatchId,
)!;
assert.equal(raisedBasePatch.role, PATCH_ROLES.summitFloor);
assert.equal(raisedTopPatch.role, PATCH_ROLES.summitPad);
assert.deepEqual(raisedBasePatch.anchors, []);
assert.ok(
  raisedBasePatch.regions.some(
    (region) => region.id.endsWith("/raised_pad_footprint")
      && region.tags.includes("occupied")
      && region.tags.includes("no_build"),
  ),
);
assert.deepEqual(
  raisedTopPatch.regions.map((region) => ({
    id: region.id,
    uRange: region.uRange,
    vRange: region.vRange,
    tags: region.tags,
  })),
  [{
    id: `${raisedPad.topPatchId}/building_pad`,
    uRange: [0, 1],
    vRange: [0, 1],
    tags: ["buildable", "superstructure"],
  }],
);
assert.deepEqual(raisedTopPatch.anchors, [{
  id: `${raisedPad.topPatchId}/anchor_superstructure`,
  kind: "superstructure",
  u: 0.5,
  v: 0.5,
  d: 0,
  regionId: `${raisedPad.topPatchId}/building_pad`,
  orientation: "front",
}]);
const raisedSidePatches = raisedPadGraph.patches.filter(
  (patch) => patch.role === PATCH_ROLES.summitPadSide,
);
assert.equal(raisedSidePatches.length, 4);
for (const side of raisedSidePatches) {
  assert.ok(side.adjacency.includes(raisedBasePatch.id));
  assert.ok(side.adjacency.includes(raisedTopPatch.id));
}

const raisedPadGeometryLayout: MassLayoutConfig = {
  ...raisedPadLayout,
  ...STAIRS_DISABLED,
};
const raisedPadGeometryGraph = generateStructure(
  toStructureSpec(raisedPadGeometryLayout),
);
assertGraphInvariants(raisedPadGeometryGraph, "isolated raised summit pad");
const squareRaisedPadRule = toMasonry(
  raisedPadGeometryLayout,
  { ...DEFAULT_MASS_STONE_CONFIG, displacement: 0 },
);
assert.ok(squareRaisedPadRule);
for (const masonry of [null, squareRaisedPadRule] as const) {
  const geometry = tessellateStructure(raisedPadGeometryGraph, {
    masonry,
    seed: 31,
    stairTilesPerStep: raisedPadGeometryLayout.stairTilesPerStep,
  }).parts[0]!.geometry;
  assert.equal(
    findCoincidentFaces(geometry).pairs,
    0,
    `Raised-pad ${masonry ? "masonry" : "bare"} geometry emitted coincident faces.`,
  );
  if (!masonry) {
    assert.equal(
      findBuriedFaces(geometry).faces,
      0,
      "Raised-pad bare geometry emitted buried faces.",
    );
  }
  assert.equal(
    findBackfaces(geometry).backfaces,
    0,
    `Raised-pad ${masonry ? "masonry" : "bare"} geometry left visible backfaces.`,
  );
  const positions = geometry.getAttribute("position");
  const normals = geometry.getAttribute("normal");
  const isolatedMass = raisedPadGeometryGraph.masses[0]!;
  const footprint = isolatedMass.summit.buildingPad!;
  for (let start = 0; start < positions.count; start += 4) {
    const atSummit = [0, 1, 2, 3].every(
      (corner) =>
        Math.abs(positions.getY(start + corner) - isolatedMass.summit.y) < 1e-6,
    );
    if (!atSummit || normals.getY(start) < 0.99) {
      continue;
    }
    const xs = [0, 1, 2, 3].map((corner) => positions.getX(start + corner));
    const zs = [0, 1, 2, 3].map((corner) => positions.getZ(start + corner));
    const fullyCovered =
      Math.min(...xs) >= footprint.minX - 1e-6
      && Math.max(...xs) <= footprint.maxX + 1e-6
      && Math.min(...zs) >= footprint.minZ - 1e-6
      && Math.max(...zs) <= footprint.maxZ + 1e-6;
    assert.ok(
      !fullyCovered,
      `Raised-pad ${masonry ? "masonry" : "bare"} geometry kept a summit face beneath the pad.`,
    );
  }
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox!;
  const expected = graphExtents(raisedPadGeometryGraph)!;
  for (const axis of ["x", "y", "z"] as const) {
    const tolerance = Math.max(1e-5, Math.abs(expected.max[axis]) * 1e-6);
    assert.ok(Math.abs(bounds.min[axis] - expected.min[axis]) < tolerance);
    assert.ok(Math.abs(bounds.max[axis] - expected.max[axis]) < tolerance);
  }
}

// --- first summit cell assembly -------------------------------------------
// One centred chamber consumes the authoritative placement anchor. Its portals
// follow the enabled stair facades as topological cuts in both wall patches and
// real voids in the block geometry, not dark rectangles over solid walls.
const summitCellLayout: MassLayoutConfig = {
  ...cloneFrontStairLayout(),
  summitBuildingEnabled: true,
};
const summitCellGraph = generateStructure(toStructureSpec(summitCellLayout));
assert.deepEqual(
  summitCellGraph.diagnostics.filter((entry) => entry.severity === "error"),
  [],
);
assertGraphInvariants(summitCellGraph, "single summit chamber");
assert.equal(summitCellGraph.cells.length, 1);
assert.equal(summitCellGraph.facades.length, 4);
assert.equal(summitCellGraph.facades.every((facade) => facade.style === "plain"), true);
const summitCell = summitCellGraph.cells[0]!;
const summitCellMass = summitCellGraph.masses[0]!;
const summitCellPlacement = summitCellMass.summit.placement!;
assert.equal(summitCell.supportPatchId, summitCellPlacement.patchId);
assert.equal(summitCell.placementAnchorId, summitCellPlacement.anchorId);
assert.deepEqual(
  summitCell.footprint,
  summitCellPlacement.rect,
  "The summit cell must consume the authoritative placement footprint exactly.",
);
assert.ok(Math.abs(
  (summitCell.footprint.minX + summitCell.footprint.maxX) * 0.5
    - (summitCellPlacement.rect.minX + summitCellPlacement.rect.maxX) * 0.5,
) < 1e-9);
assert.ok(Math.abs(
  (summitCell.footprint.minZ + summitCell.footprint.maxZ) * 0.5
    - (summitCellPlacement.rect.minZ + summitCellPlacement.rect.maxZ) * 0.5,
) < 1e-9);

const summitCellSupport = summitCellGraph.patches.find(
  (patch) => patch.id === summitCell.supportPatchId,
)!;
assert.ok(
  summitCellSupport.regions.some(
    (region) =>
      region.id.endsWith("/cell_footprint")
      && region.tags.includes("occupied")
      && region.tags.includes("no_build"),
  ),
);
const cellFrontExterior = summitCellGraph.patches.find(
  (patch) => patch.id.endsWith("/wall_front_exterior"),
)!;
const cellFrontInterior = summitCellGraph.patches.find(
  (patch) => patch.id.endsWith("/wall_front_interior"),
)!;
for (const wall of [cellFrontExterior, cellFrontInterior]) {
  const portal = wall.regions.find((region) => region.tags.includes("portal"));
  assert.ok(portal);
  assert.deepEqual(wall.features, [{
    id: `${wall.id}/cut_front`,
    operation: "cut",
    depth: 0,
    materialRole: "portalReveal",
    regionId: portal.id,
    order: 0,
    dependsOn: [],
    runsBefore: [],
    runsAfter: [],
    conflictPolicy: "error",
  }]);
}

const mismatchedCutBuilder = new StructureGraphBuilder(
  "mismatched_cut",
  createSeedSet(1),
  summitCellGraph.site,
);
for (const patch of summitCellGraph.patches) {
  if (patch.id !== cellFrontInterior.id) {
    mismatchedCutBuilder.addPatch(patch);
    continue;
  }

  mismatchedCutBuilder.addPatch({
    ...patch,
    regions: patch.regions.map((region) => ({
      ...region,
      uRange: [region.uRange[0] + 0.01, region.uRange[1] + 0.01],
    })),
  });
}
mismatchedCutBuilder.addCell(summitCell);
assert.equal(
  mismatchedCutBuilder.build([]).diagnostics.some(
    (entry) => entry.code === "feature.paired_cut_mismatch",
  ),
  true,
  "Paired wall faces accepted different world-space cuts.",
);
assert.equal(
  summitCellGraph.patches.filter(
    (patch) => patch.role === PATCH_ROLES.cellOpeningReveal,
  ).length,
  3,
);
assert.equal(summitCellGraph.roofs.length, 1);
const summitRoof = summitCellGraph.roofs[0]!;
assert.deepEqual(summitRoof.coversCellIds, [summitCell.id]);
assert.equal(summitRoof.bottomY, summitCell.topY);
assert.equal(
  summitRoof.slabTopY,
  summitCell.topY + summitCellLayout.summitRoofThickness,
);
assert.equal(
  summitRoof.topY,
  summitRoof.slabTopY + summitCellLayout.summitRoofCorniceHeight,
);
assert.equal(summitRoof.projection, summitCellLayout.summitRoofProjection);
assert.equal(
  summitCellGraph.patches.find((patch) => patch.id === summitRoof.topPatchId)?.role,
  PATCH_ROLES.roof,
);
assert.equal(
  summitCellGraph.patches.find(
    (patch) => patch.id === summitRoof.ceilingPatchId,
  )?.role,
  PATCH_ROLES.roofSoffit,
);
assert.ok(summitRoof.cornice);
assert.equal(
  summitRoof.cornice.projection,
  summitCellLayout.summitRoofCorniceProjection,
);

const unroofedCellGraph = generateStructure(toStructureSpec({
  ...summitCellLayout,
  summitRoofEnabled: false,
}));
assertGraphInvariants(unroofedCellGraph, "unroofed summit chamber");
assert.deepEqual(unroofedCellGraph.roofs, []);

const plainRoofGraph = generateStructure(toStructureSpec({
  ...summitCellLayout,
  summitRoofCorniceProjection: 0,
  summitRoofCorniceHeight: 0,
}));
assertGraphInvariants(plainRoofGraph, "plain summit roof");
assert.equal(plainRoofGraph.roofs[0]?.cornice, null);
assert.equal(plainRoofGraph.roofs[0]?.topY, plainRoofGraph.roofs[0]?.slabTopY);

const allPortalLayout: MassLayoutConfig = {
  ...summitCellLayout,
  stairFrontEnabled: true,
  stairRearEnabled: true,
  stairLeftEnabled: true,
  stairRightEnabled: true,
};
const allPortalGraph = generateStructure(toStructureSpec(allPortalLayout));
assertGraphInvariants(allPortalGraph, "four-portal summit chamber");
const allPortalCell = allPortalGraph.cells[0]!;
assert.deepEqual(
  allPortalCell.openings.map((opening) => opening.direction),
  ["front", "rear", "sideNegativeU", "sidePositiveU"],
);
assert.equal(
  allPortalGraph.patches.filter(
    (patch) => patch.role === PATCH_ROLES.cellOpeningReveal,
  ).length,
  12,
);
for (const opening of allPortalCell.openings) {
  const wall = allPortalCell.walls.find(
    (candidate) => candidate.orientation === opening.direction,
  )!;
  for (const patchId of [wall.outerPatchId, wall.innerPatchId]) {
    const wallPatch = allPortalGraph.patches.find((patch) => patch.id === patchId)!;
    assert.equal(
      wallPatch.features.filter((feature) => feature.operation === "cut").length,
      1,
      `${opening.direction}: portal is not cut through both wall surfaces.`,
    );
  }
}

// Multi-room summit plans keep one exterior envelope and one roof group. Their
// partitions are owned once, with explicit room connections cut through both
// semantic faces and through the generated wall blocks.
const plannedCellGraphs = [
  {
    layout: "twin_chamber" as const,
    roomCount: 2,
    wallCount: 1,
    connectionCount: 3,
  },
  {
    layout: "three_bay" as const,
    roomCount: 3,
    wallCount: 2,
    connectionCount: 2,
  },
].map((expectation) => ({
  ...expectation,
  graph: generateStructure(toStructureSpec({
    ...allPortalLayout,
    footprintWidth: 40,
    footprintDepth: 30,
    summitBuildingPlan: expectation.layout,
  })),
  isolatedGraph: generateStructure(toStructureSpec({
    ...allPortalLayout,
    ...STAIRS_DISABLED,
    footprintWidth: 40,
    footprintDepth: 30,
    summitBuildingPlan: expectation.layout,
  })),
}));

for (const planned of plannedCellGraphs) {
  assert.deepEqual(
    planned.graph.diagnostics.filter((entry) => entry.severity === "error"),
    [],
    `${planned.layout}: valid room plan was rejected.`,
  );
  assertGraphInvariants(planned.graph, planned.layout);
  assertGraphInvariants(
    planned.isolatedGraph,
    `${planned.layout} without exterior portals`,
  );
  const cell = planned.graph.cells[0]!;
  assert.equal(cell.layout, planned.layout);
  assert.equal(cell.rooms.length, planned.roomCount);
  assert.equal(cell.interiorWalls.length, planned.wallCount);
  assert.equal(cell.connections.length, planned.connectionCount);
  assert.equal(
    new Set(cell.rooms.map((room) => room.floorPatchId)).size,
    planned.roomCount,
    `${planned.layout}: rooms do not own distinct floor patches.`,
  );
  assert.deepEqual(
    planned.graph.roofs[0]?.coversRoomIds,
    cell.rooms.map((room) => room.id),
    `${planned.layout}: the roof group does not cover every resolved room.`,
  );

  for (const wall of cell.interiorWalls) {
    const wallConnections = cell.connections.filter(
      (connection) => wall.connectionIds.includes(connection.id),
    );
    for (const patchId of [wall.negativePatchId, wall.positivePatchId]) {
      const patch = planned.graph.patches.find(
        (candidate) => candidate.id === patchId,
      )!;
      assert.equal(
        patch.features.filter((feature) => feature.operation === "cut").length,
        wallConnections.length,
        `${planned.layout}: partition face does not carry all doorway cuts.`,
      );
    }
  }

  assert.equal(
    planned.graph.patches.filter(
      (patch) => patch.role === PATCH_ROLES.cellOpeningReveal,
    ).length,
    (cell.openings.length + cell.connections.length) * 3,
    `${planned.layout}: a portal or room connection is missing its reveals.`,
  );
}

const raisedCellGraph = generateStructure(toStructureSpec({
  ...summitCellLayout,
  summitTreatment: "raised_pad",
  summitPadHeight: 0.6,
}));
assertGraphInvariants(raisedCellGraph, "raised-pad summit chamber");
assert.equal(
  raisedCellGraph.cells[0]?.bottomY,
  raisedCellGraph.masses[0]?.summit.pad?.band.topY,
);
assert.equal(
  raisedCellGraph.cells[0]?.supportPatchId,
  raisedCellGraph.masses[0]?.summit.pad?.topPatchId,
);
assert.deepEqual(
  raisedCellGraph.cells[0]?.footprint,
  raisedCellGraph.masses[0]?.summit.buildingPad,
  "The raised pad and summit cell must share the same resolved footprint.",
);

const isolatedCellLayout: MassLayoutConfig = {
  ...summitCellLayout,
  ...STAIRS_DISABLED,
};
const isolatedCellGraph = generateStructure(toStructureSpec(isolatedCellLayout));
assertGraphInvariants(isolatedCellGraph, "isolated summit chamber");
const isolatedCell = isolatedCellGraph.cells[0]!;
assert.deepEqual(
  isolatedCell.openings,
  [],
  "A summit building without stairs must remain closed.",
);

// Geometry consumes compiled patch features, not CellRecord openings. Add two
// cuts — including one elevated window-like opening — to the otherwise closed
// chamber while leaving its topological opening list untouched.
const isolatedPatches = patchIndex(isolatedCellGraph);
const isolatedFrontWall = isolatedCell.walls.find(
  (wall) => wall.orientation === "front",
)!;
const cutPatches = new Map(isolatedPatches);
const authoredCuts = [
  { id: "low", minX: -4, maxX: -2, vRange: [0, 0.25] as const },
  { id: "elevated", minX: 2, maxX: 4, vRange: [0.35, 0.65] as const },
];

for (const patchId of [isolatedFrontWall.outerPatchId, isolatedFrontWall.innerPatchId]) {
  const source = isolatedPatches.get(patchId)!;
  const regions = authoredCuts.map((cut, index): PatchRegion => ({
    id: `${patchId}/test_${cut.id}`,
    uRange: normalizedXRange(source, cut.minX, cut.maxX),
    vRange: cut.vRange,
    priority: 100 - index,
    allowedOperations: ["cut"],
    exclusions: [],
    tags: ["test", "opening"],
  }));
  const features = regions.map((region, index) => testCutFeature(
    `${patchId}/cut_test_${authoredCuts[index]!.id}`,
    region.id,
    { order: index },
  ));
  cutPatches.set(patchId, { ...source, regions, features });
}

const featureDrivenCellBuilder = new SolidBuilder();
buildCell(featureDrivenCellBuilder, isolatedCell, cutPatches, null, 89);
for (const cut of authoredCuts) {
  const opening: CellOpeningRecord = {
    id: `test/${cut.id}`,
    kind: "portal",
    direction: "front",
    width: cut.maxX - cut.minX,
    height: (cut.vRange[1] - cut.vRange[0]) * isolatedCell.height,
    bottomY: isolatedCell.bottomY + cut.vRange[0] * isolatedCell.height,
    topY: isolatedCell.bottomY + cut.vRange[1] * isolatedCell.height,
    threshold: {
      minX: cut.minX,
      maxX: cut.maxX,
      minZ: isolatedCell.interior.maxZ,
      maxZ: isolatedCell.footprint.maxZ,
    },
    exteriorPatchId: isolatedCell.supportPatchId,
    interiorPatchId: isolatedCell.floorPatchId,
    destinationRoomIds: [isolatedCell.rooms[0]!.id],
    revealPatchIds: [],
  };
  assert.equal(
    portalIsBlocked(featureDrivenCellBuilder, isolatedCell, opening),
    false,
    `${cut.id}: compiled patch cut did not open the wall geometry.`,
  );
}
const featureDrivenGeometry = finalizeGeometry(featureDrivenCellBuilder).geometry;
assert.equal(findCoincidentFaces(featureDrivenGeometry).pairs, 0);
assert.equal(findBackfaces(featureDrivenGeometry).backfaces, 0);

const squareCellRule = toMasonry(
  summitCellLayout,
  { ...DEFAULT_MASS_STONE_CONFIG, displacement: 0 },
);
assert.ok(squareCellRule);

for (const masonry of [null, squareCellRule] as const) {
  const cellBuilder = new SolidBuilder();
  buildCell(cellBuilder, summitCell, patchIndex(summitCellGraph), masonry, 71);
  const cellGeometry = finalizeGeometry(cellBuilder).geometry;
  assert.equal(
    findCoincidentFaces(cellGeometry).pairs,
    0,
    `Cell ${masonry ? "masonry" : "bare"} geometry emitted coincident faces.`,
  );
  assert.equal(
    findBuriedFaces(cellGeometry).faces,
    0,
    `Cell ${masonry ? "masonry" : "bare"} geometry emitted buried faces.`,
  );
  assert.equal(
    findBackfaces(cellGeometry).backfaces,
    0,
    `Cell ${masonry ? "masonry" : "bare"} geometry left visible backfaces.`,
  );

  const opening = summitCell.openings[0]!;
  const portalBlocked = portalIsBlocked(cellBuilder, summitCell, opening);
  assert.equal(
    portalBlocked,
    false,
    `Cell ${masonry ? "masonry" : "bare"} geometry filled its portal.`,
  );

  const allPortalBuilder = new SolidBuilder();
  buildCell(
    allPortalBuilder,
    allPortalCell,
    patchIndex(allPortalGraph),
    masonry,
    73,
  );
  const allPortalGeometry = finalizeGeometry(allPortalBuilder).geometry;
  assert.equal(
    findCoincidentFaces(allPortalGeometry).pairs,
    0,
    `Four-portal cell ${masonry ? "masonry" : "bare"} geometry emitted coincident faces.`,
  );
  assert.equal(
    findBackfaces(allPortalGeometry).backfaces,
    0,
    `Four-portal cell ${masonry ? "masonry" : "bare"} geometry left visible backfaces.`,
  );
  for (const sideOpening of allPortalCell.openings) {
    assert.equal(
      portalIsBlocked(allPortalBuilder, allPortalCell, sideOpening),
      false,
      `${sideOpening.direction}: ${masonry ? "masonry" : "bare"} geometry filled its portal.`,
    );
  }

  for (const planned of plannedCellGraphs) {
    const cell = planned.graph.cells[0]!;
    const plannedBuilder = new SolidBuilder();
    buildCell(plannedBuilder, cell, patchIndex(planned.graph), masonry, 83);
    const plannedGeometry = finalizeGeometry(plannedBuilder).geometry;
    assert.equal(
      findCoincidentFaces(plannedGeometry).pairs,
      0,
      `${planned.layout} ${masonry ? "masonry" : "bare"} geometry emitted coincident faces.`,
    );
    assert.equal(
      findBuriedFaces(plannedGeometry).faces,
      0,
      `${planned.layout} ${masonry ? "masonry" : "bare"} geometry emitted buried faces.`,
    );
    assert.equal(
      findBackfaces(plannedGeometry).backfaces,
      0,
      `${planned.layout} ${masonry ? "masonry" : "bare"} geometry left visible backfaces.`,
    );
    for (const connection of cell.connections) {
      assert.equal(
        connectionIsBlocked(plannedBuilder, connection),
        false,
        `${planned.layout}: ${masonry ? "masonry" : "bare"} geometry filled an interior connection.`,
      );
    }

    const plannedAssembly = tessellateStructure(planned.isolatedGraph, {
      masonry,
      seed: 83,
      stairTilesPerStep: allPortalLayout.stairTilesPerStep,
    }).parts[0]!.geometry;
    assert.equal(
      findCoincidentFaces(plannedAssembly).pairs,
      0,
      `${planned.layout} ${masonry ? "masonry" : "bare"} assembly emitted coincident faces.`,
    );
    assert.equal(
      findBackfaces(plannedAssembly).backfaces,
      0,
      `${planned.layout} ${masonry ? "masonry" : "bare"} assembly left visible backfaces.`,
    );
  }

  const roofBuilder = new SolidBuilder();
  buildCell(roofBuilder, summitCell, patchIndex(summitCellGraph), masonry, 79);
  roofBuilder.cullFaces((face) => faceIsCoveredByRoof(face, summitRoof));
  buildRoof(roofBuilder, summitRoof);
  const roofGeometry = finalizeGeometry(roofBuilder).geometry;
  assert.equal(
    findCoincidentFaces(roofGeometry).pairs,
    0,
    `Roofed cell ${masonry ? "masonry" : "bare"} geometry emitted coincident faces.`,
  );
  assert.equal(
    findBuriedFaces(roofGeometry).faces,
    0,
    `Roofed cell ${masonry ? "masonry" : "bare"} geometry emitted buried faces.`,
  );
  assert.equal(
    findBackfaces(roofGeometry).backfaces,
    0,
    `Roofed cell ${masonry ? "masonry" : "bare"} geometry left visible backfaces.`,
  );
  assert.equal(
    readBlockFaces(roofBuilder).some((face) =>
      faceNormal(face).y > 0.99
      && face.every((point) => Math.abs(point.y - summitRoof.bottomY) < 1e-6)
      && face.every((point) =>
        point.x >= summitRoof.bearingFootprint.minX - 1e-6
        && point.x <= summitRoof.bearingFootprint.maxX + 1e-6
        && point.z >= summitRoof.bearingFootprint.minZ - 1e-6
        && point.z <= summitRoof.bearingFootprint.maxZ + 1e-6),
    ),
    false,
    `Roofed cell ${masonry ? "masonry" : "bare"} kept a wall-crown contact face.`,
  );

  const assemblyGeometry = tessellateStructure(isolatedCellGraph, {
    masonry,
    seed: 71,
    stairTilesPerStep: isolatedCellLayout.stairTilesPerStep,
  }).parts[0]!.geometry;
  assert.equal(
    findCoincidentFaces(assemblyGeometry).pairs,
    0,
    `Cell assembly ${masonry ? "masonry" : "bare"} geometry emitted coincident faces.`,
  );
  assert.equal(
    findBackfaces(assemblyGeometry).backfaces,
    0,
    `Cell assembly ${masonry ? "masonry" : "bare"} geometry left visible backfaces.`,
  );
  assemblyGeometry.computeBoundingBox();
  const bounds = assemblyGeometry.boundingBox!;
  const expected = graphExtents(isolatedCellGraph)!;
  for (const axis of ["x", "y", "z"] as const) {
    const tolerance = Math.max(1e-5, Math.abs(expected.max[axis]) * 1e-6);
    assert.ok(Math.abs(bounds.min[axis] - expected.min[axis]) < tolerance);
    assert.ok(Math.abs(bounds.max[axis] - expected.max[axis]) < tolerance);
  }
}

// The hierarchical preset proves the same resolver can author a facade rather
// than merely replay the old centered portal: a portal, elevated windows,
// niches/recessed panels, pilasters and a continuous frieze all resolve through
// PatchFeature operations and the same wall-volume reader.
const hierarchicalFacadeLayout: MassLayoutConfig = {
  ...summitCellLayout,
  ...FRONT_STAIR_ONLY,
  facadeStyle: "hierarchical",
};
const hierarchicalFacadeGraph = generateStructure(
  toStructureSpec(hierarchicalFacadeLayout),
);
assert.deepEqual(
  hierarchicalFacadeGraph.diagnostics.filter((entry) => entry.severity === "error"),
  [],
);
assert.equal(hierarchicalFacadeGraph.facades.length, 4);
for (const facade of hierarchicalFacadeGraph.facades) {
  assert.equal(facade.style, "hierarchical");
  assert.equal(facade.symmetry, "bilateral");
  assert.equal(facade.bays.length, 3);
  assert.deepEqual(facade.bands.map((band) => band.role), ["opening_zone", "frieze"]);
}
const hierarchicalOperations = hierarchicalFacadeGraph.patches
  .flatMap((patch) => patch.features.map((feature) => feature.operation));
for (const operation of ["cut", "extrude"] as const) {
  assert.equal(
    hierarchicalOperations.includes(operation),
    true,
    `Hierarchical facade emitted no ${operation} feature.`,
  );
}

// The wall is no longer articulated by the facade grammar, and that is the
// point rather than a regression.
//
// A hierarchical facade used to sink a recessed panel into every secondary bay,
// sized by its own recess depth. A slot now carries a signed face depth that
// does the same thing under a control that can also be engraved, tiled and lit
// — and while both existed the facade's cut won by default, so the slot could
// never be seen. What is left is framing: the entrance, the pilasters flanking
// it, the frieze over it.
assert.equal(
  hierarchicalOperations.includes("inset"),
  false,
  "A hierarchical facade must leave its wall field to the slot system. An "
  + "inset here is the facade cutting the same face the slot's relief cuts, "
  + "and the facade wins.",
);
const facadeDetailMaterials = [
  "portalReveal",
  "windowReveal",
  "pilaster",
  "frieze",
] as const;
const hierarchicalMaterialRoles = new Set(
  hierarchicalFacadeGraph.patches.flatMap((patch) =>
    patch.features.map((feature) => feature.materialRole)),
);
for (const role of facadeDetailMaterials) {
  assert.equal(
    hierarchicalMaterialRoles.has(role),
    true,
    `Hierarchical facade emitted no ${role} material owner.`,
  );
}
for (const role of ["niche", "panel"] as const) {
  assert.equal(
    hierarchicalMaterialRoles.has(role),
    false,
    `Hierarchical facade still dresses a ${role}; the wall insets are gone.`,
  );
}
assert.equal(
  hierarchicalFacadeGraph.patches.some((patch) =>
    patch.features.some((feature) => feature.id.endsWith("/cut_portal"))),
  false,
  "The removed Cell-authored portal feature path survived facade resolution.",
);
const hierarchicalCell = hierarchicalFacadeGraph.cells[0]!;
assert.equal(hierarchicalCell.openings.length, 1);
assert.equal(
  hierarchicalFacadeGraph.patches.filter(
    (patch) => patch.role === PATCH_ROLES.cellOpeningReveal,
  ).length,
  7,
  "One portal and one elevated window must register complete semantic reveals.",
);
for (const masonry of [null, squareCellRule] as const) {
  const builder = new SolidBuilder();
  builder.withMaterial("summit", () => buildCell(
    builder,
    hierarchicalCell,
    patchIndex(hierarchicalFacadeGraph),
    masonry,
    97,
  ));
  const geometry = finalizeGeometry(builder).geometry;
  const usedMaterials = new Set(builder.surfaceMaterials);
  for (const slot of ["summit", ...facadeDetailMaterials] as const) {
    assert.equal(
      usedMaterials.has(materialSlotIndex(slot)),
      true,
      `Hierarchical facade ${masonry ? "masonry" : "bare"} emitted no ${slot} faces.`,
    );
  }
  const portalRevealFaces = readMaterialFaces(builder, "portalReveal");
  assert.ok(
    portalRevealFaces.every((face) => Math.abs(faceNormal(face).z) < 1e-6),
    `Hierarchical facade ${masonry ? "masonry" : "bare"} assigned a front wall plane to portal reveals.`,
  );
  const windowRevealFaces = readMaterialFaces(builder, "windowReveal");
  assert.ok(
    windowRevealFaces.every((face) => Math.abs(faceNormal(face).x) < 1e-6),
    `Hierarchical facade ${masonry ? "masonry" : "bare"} assigned a side wall plane to window reveals.`,
  );
  const facadeDepth = (point: THREE.Vector3) => Math.max(
    point.x - hierarchicalCell.footprint.maxX,
    hierarchicalCell.footprint.minX - point.x,
    point.z - hierarchicalCell.footprint.maxZ,
    hierarchicalCell.footprint.minZ - point.z,
    0,
  );
  assert.ok(
    readMaterialFaces(builder, "frieze").every((face) =>
      face.every((point) =>
        facadeDepth(point) <= hierarchicalFacadeLayout.facadeFriezeProjection + 1e-6)),
    `Hierarchical facade ${masonry ? "masonry" : "bare"} let the shallower frieze own a pilaster side.`,
  );
  assert.ok(
    readMaterialFaces(builder, "pilaster").some((face) =>
      face.some((point) =>
        facadeDepth(point) >= hierarchicalFacadeLayout.facadePilasterProjection - 1e-6)),
    `Hierarchical facade ${masonry ? "masonry" : "bare"} lost its pilaster projection material.`,
  );
  assert.equal(
    findCoincidentFaces(geometry).pairs,
    0,
    `Hierarchical facade ${masonry ? "masonry" : "bare"} emitted coincident faces.`,
  );
  assert.equal(
    findBuriedFaces(geometry).faces,
    0,
    `Hierarchical facade ${masonry ? "masonry" : "bare"} emitted buried faces.`,
  );
  assert.ok(
    findBackfaces(geometry).backfaces <= 1,
    `Hierarchical facade ${masonry ? "masonry" : "bare"} exposed more than the one accepted through-window sightline.`,
  );
  assert.equal(
    portalIsBlocked(builder, hierarchicalCell, hierarchicalCell.openings[0]!),
    false,
    `Hierarchical facade ${masonry ? "masonry" : "bare"} filled its portal.`,
  );
}

const hierarchicalMerged = mergeParts(
  tessellateStructure(hierarchicalFacadeGraph, {
    masonry: null,
    seed: 97,
    stairTilesPerStep: 5,
  }).parts,
  [MASS_SECTION],
);
const hierarchicalGroupSlots = new Set(
  hierarchicalMerged.geometry.groups.map((group) => group.materialIndex),
);
for (const slot of facadeDetailMaterials) {
  assert.equal(
    hierarchicalGroupSlots.has(materialSlotIndex(slot)),
    true,
    `Merged hierarchical facade emitted no indexed ${slot} group.`,
  );
}
assert.equal(
  hierarchicalMerged.geometry.groups.reduce((sum, group) => sum + group.count, 0),
  hierarchicalMerged.geometry.getIndex()?.count,
  "Hierarchical material groups do not cover every index exactly once.",
);

// Any facade-owned role does here; the subject is an unregistered *name*, not
// which detail happens to carry it. This used to reach for "panel", which the
// hierarchical wall no longer emits.
const unknownMaterialPatch = hierarchicalFacadeGraph.patches.find((patch) =>
  patch.features.some((feature) => feature.materialRole === "pilaster"));
assert.ok(unknownMaterialPatch);
const unknownMaterialPatches = patchIndex({
  ...hierarchicalFacadeGraph,
  patches: hierarchicalFacadeGraph.patches.map((patch) =>
    patch.id === unknownMaterialPatch.id
      ? {
        ...patch,
        features: patch.features.map((feature) =>
          feature.materialRole === "pilaster"
            ? { ...feature, materialRole: "unregistered_facade_material" }
            : feature),
      }
      : patch),
});
assert.throws(
  () => buildCell(
    new SolidBuilder(),
    hierarchicalCell,
    unknownMaterialPatches,
    null,
    97,
  ),
  /names unknown material role "unregistered_facade_material"/,
);

const cellDerivedFacadeGraph = generateStructure(toStructureSpec({
  ...summitCellLayout,
  ...STAIRS_DISABLED,
  summitBuildingPlan: "three_bay",
  facadeStyle: "hierarchical",
}));
assert.deepEqual(
  cellDerivedFacadeGraph.diagnostics.filter((entry) => entry.severity === "error"),
  [],
);
const derivedFrontFacade = cellDerivedFacadeGraph.facades.find(
  (facade) => facade.orientation === "front",
)!;
assert.equal(derivedFrontFacade.bays.length, 3);
assert.ok(
  derivedFrontFacade.bays[1]!.width > derivedFrontFacade.bays[0]!.width,
  "The three-bay facade did not retain the wider center implied by partition ownership.",
);
assert.ok(
  Math.abs(derivedFrontFacade.bays[0]!.width - derivedFrontFacade.bays[2]!.width) < 1e-9,
  "The cell-derived three-bay facade lost bilateral symmetry.",
);

const cellWithOversizedPortal = generateStructure(toStructureSpec({
  ...summitCellLayout,
  summitBuildingPortalWidth: 100,
}));
assert.equal(
  cellWithOversizedPortal.diagnostics.find(
    (diagnostic) => diagnostic.severity === "error",
  )?.code,
  "cell.portal_too_wide",
);
assert.deepEqual(cellWithOversizedPortal.masses, []);
assert.deepEqual(cellWithOversizedPortal.patches, []);
assert.deepEqual(cellWithOversizedPortal.cells, []);

// A thin wall used to be a hard error under a hierarchical facade, because the
// facade sank a recess of its own into it and a recess deeper than the wall is
// a hole. There is no such recess now, and what replaced it — a slot's face
// depth — is *clamped* against the wall's budget rather than refused, the same
// way every other relief in the project is. So a wall too thin to carve deeply
// is no longer a wall that fails to build; it is one that grants less depth.
const cellWithThinFacadeWall = generateStructure(toStructureSpec({
  ...summitCellLayout,
  facadeStyle: "hierarchical",
  summitBuildingWallThickness: 0.15,
}));
assert.deepEqual(
  cellWithThinFacadeWall.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  ),
  [],
  "A thin summit wall must still resolve; depth is budgeted, not demanded.",
);
assert.equal(cellWithThinFacadeWall.facades.length, 4);

const cellWithOversizedInteriorOpening = generateStructure(toStructureSpec({
  ...summitCellLayout,
  ...STAIRS_DISABLED,
  summitBuildingPlan: "twin_chamber",
  summitInteriorOpeningWidth: 100,
}));
assert.equal(
  cellWithOversizedInteriorOpening.diagnostics.find(
    (diagnostic) => diagnostic.severity === "error",
  )?.code,
  "cell.interior_openings_do_not_fit",
);
assert.deepEqual(cellWithOversizedInteriorOpening.cells, []);

const cellWithTallInteriorOpening = generateStructure(toStructureSpec({
  ...summitCellLayout,
  summitBuildingPlan: "three_bay",
  summitInteriorOpeningHeight: summitCellLayout.summitBuildingHeight,
}));
assert.equal(
  cellWithTallInteriorOpening.diagnostics.find(
    (diagnostic) => diagnostic.severity === "error",
  )?.code,
  "cell.invalid_interior_opening",
);
assert.deepEqual(cellWithTallInteriorOpening.cells, []);

const twinWithNarrowSidePortal = generateStructure(toStructureSpec({
  ...allPortalLayout,
  summitBuildingPlan: "twin_chamber",
  summitBuildingWallThickness: 1,
  summitBuildingPortalWidth: 0.5,
}));
assert.equal(
  twinWithNarrowSidePortal.diagnostics.find(
    (diagnostic) => diagnostic.severity === "error",
  )?.code,
  "cell.side_portal_too_narrow_for_plan",
);
assert.deepEqual(twinWithNarrowSidePortal.cells, []);

const threeBayWithWideFrontPortal = generateStructure(toStructureSpec({
  ...summitCellLayout,
  summitBuildingPlan: "three_bay",
  summitBuildingPortalWidth: 3,
}));
assert.equal(
  threeBayWithWideFrontPortal.diagnostics.find(
    (diagnostic) => diagnostic.severity === "error",
  )?.code,
  "cell.portal_misses_central_hall",
);
assert.deepEqual(threeBayWithWideFrontPortal.cells, []);

const validRoofSpec = toStructureSpec(summitCellLayout).roofs[0]!;
const cellWithInvalidRoof = generateStructure({
  ...toStructureSpec(summitCellLayout),
  roofs: [{ ...validRoofSpec, thickness: 0 }],
});
assert.equal(
  cellWithInvalidRoof.diagnostics.find(
    (diagnostic) => diagnostic.severity === "error",
  )?.code,
  "roof.invalid_dimensions",
);
assert.deepEqual(cellWithInvalidRoof.masses, []);
assert.deepEqual(cellWithInvalidRoof.roofs, []);

const roofWithoutCell = generateStructure({
  ...toStructureSpec(summitCellLayout),
  cells: [],
});
assert.equal(
  roofWithoutCell.diagnostics.find(
    (diagnostic) => diagnostic.severity === "error",
  )?.code,
  "roof.no_cell",
);
assert.deepEqual(roofWithoutCell.roofs, []);

const padWithoutRoom = generateStructure(toStructureSpec({
  ...cloneFrontStairLayout(),
  ...STAIRS_DISABLED,
  summitTreatment: "raised_pad",
  summitBuildingWidthRatio: 0,
}));
assert.equal(
  padWithoutRoom.diagnostics.find(
    (diagnostic) => diagnostic.severity === "error",
  )?.code,
  "summit.placement_invalid_dimensions",
);
assert.deepEqual(padWithoutRoom.masses, []);
assert.deepEqual(padWithoutRoom.patches, []);
assert.deepEqual(padWithoutRoom.connectors, []);

// If any requested facade cannot fit its connector, generation is atomic.
const oneSideCannotFit = generateStructure(toStructureSpec({
  ...cloneFrontStairLayout(),
  footprintWidth: 24,
  footprintDepth: 2,
  bandCount: 2,
  batterAngle: 0,
  summitRatio: 0.05,
  stairFrontEnabled: true,
  stairRearEnabled: true,
  stairLeftEnabled: true,
  stairRightEnabled: true,
  stairSideTreatment: "none",
}));
assert.equal(
  oneSideCannotFit.diagnostics.find(
    (diagnostic) => diagnostic.severity === "error",
  )?.code,
  "stair.does_not_fit",
);
assert.deepEqual(oneSideCannotFit.masses, []);
assert.deepEqual(oneSideCannotFit.patches, []);
assert.deepEqual(oneSideCannotFit.connectors, []);
const duplicateFacadeSpec = toStructureSpec(cloneFrontStairLayout());
const duplicateFacade = generateStructure({
  ...duplicateFacadeSpec,
  stairs: [
    ...duplicateFacadeSpec.stairs,
    { ...duplicateFacadeSpec.stairs[0]!, id: "stair_front_second" },
  ],
});
assert.equal(
  duplicateFacade.diagnostics.find(
    (diagnostic) => diagnostic.severity === "error",
  )?.code,
  "stair.duplicate_facade",
);
assert.deepEqual(duplicateFacade.patches, []);

// A stair wider than the summit it arrives on is narrowed, and says so.
const clampedStair = generateStructure(toStructureSpec({
  ...cloneFrontStairLayout(),
  summitRatio: 0.15,
  stairWidthRatio: 0.5,
}));
const widthNotice = clampedStair.diagnostics.find(
  (entry) => entry.code === "stair.width_reduced",
);
assert.ok(widthNotice, "An oversized stair must report its reduction.");
assert.equal(widthNotice?.severity, "notice");
assert.ok(widthNotice?.resolved, "The reduction must record the width it used.");
const clampedRecord = clampedStair.connectors[0]!;
assert.ok(
  clampedRecord.width + 2 * (clampedRecord.parapet?.width ?? 0)
    <= rectWidth(clampedStair.masses[0]!.summit.rect) + 1e-9,
  "The narrowed stair still overhangs the summit.",
);

// And one no side treatments leave room for at all refuses the build whole.
const unfittable = generateStructure(toStructureSpec({
  ...cloneFrontStairLayout(),
  summitRatio: 0.05,
  stairParapetWidth: 2,
}));
assert.equal(
  unfittable.diagnostics.filter((entry) => entry.severity === "error")[0]?.code,
  "stair.does_not_fit",
);
assert.equal(unfittable.patches.length, 0);
assert.equal(unfittable.masses.length, 0);

// On a broad, low platform the requested pitch would bury the flight inside
// the mass; the tread widens until the flight clears every face, and reports
// the tread it settled on.
const gentleLayout: MassLayoutConfig = {
  ...cloneFrontStairLayout(),
  footprintWidth: 40,
  footprintDepth: 40,
  bandCount: 3,
  totalHeight: 1.5,
  batterAngle: 0,
  summitRatio: 0.2,
};
assert.doesNotThrow(() => validateMassLayout(gentleLayout));
const gentleStair = generateStructure(toStructureSpec(gentleLayout));
const treadNotice = gentleStair.diagnostics.find(
  (entry) => entry.code === "stair.tread_increased",
);
assert.ok(treadNotice, "A flight that would sink into its mass must report the repair.");
assert.equal(treadNotice?.severity, "notice");
const gentleRecord = gentleStair.connectors[0]!;
assert.ok(gentleRecord.tread > 0.32);
assert.ok(
  gentleRecord.flightRect.maxZ > gentleStair.masses[0]!.footprint.maxZ,
  "The repaired flight still starts inside the mass.",
);

// A rise too small for its target riser resolves to one deviating step, and the
// deviation is reported rather than absorbed.
const stubby = generateStructure(toStructureSpec({
  ...cloneFrontStairLayout(),
  totalHeight: 0.65,
  baseTreatment: "none",
  stairRiser: 0.45,
}));
const riserNotice = stubby.diagnostics.find(
  (entry) => entry.code === "stair.riser_off_target",
);
assert.ok(riserNotice, "A riser far off target must be reported.");
assert.equal(stubby.connectors[0]?.stepCount, 1);

// A crown cornice projects at exactly the elevation the stair arrives at, and
// no pitch ducks under a molding — so the flight lands on the molding's outer
// lip and the arrival stays walkable.
const cornicedStair = corniced.connectors[0]!;
const cornicedCrown = corniced.masses[0]!.bands[corniced.masses[0]!.bands.length - 1]!;
assert.ok(cornicedCrown.cornice);
assert.ok(
  Math.abs(cornicedStair.flightRect.minZ - cornicedCrown.cornice.outline.maxZ) < 1e-9,
  "With a crown cornice the flight must land on the molding's outer lip.",
);

// The stepped parapet accepts its own optional projected cornice. It remains a
// sequence of horizontal caps, and the same square foot and summit endings as
// the flat treatment carry those caps down to their supporting floors.
const steppedCorniceLayout: MassLayoutConfig = {
  ...cloneFrontStairLayout(),
  stairSteppedParapetCorniceProjection: 0.2,
  stairSteppedParapetCorniceHeight: 0.25,
};
assert.doesNotThrow(() => validateMassLayout(steppedCorniceLayout));
const steppedCorniceGraph = generateStructure(toStructureSpec(steppedCorniceLayout));
const steppedCorniceRecord = steppedCorniceGraph.connectors[0]!;
const steppedCornice = steppedCorniceRecord.parapet!;
assert.equal(steppedCorniceRecord.sideTreatment, "stepped_parapet");
assert.deepEqual(steppedCornice.cornice, { projection: 0.2, height: 0.25 });
assert.equal(
  patchIndex(steppedCorniceGraph)
    .get(`${steppedCorniceRecord.id}/side_negative_u`)
    ?.edges.vMax.treatment,
  "cornice",
);
assert.ok(
  steppedCorniceRecord.width
    + 2 * (steppedCornice.width + steppedCornice.cornice.projection)
    <= rectWidth(steppedCorniceGraph.masses[0]!.summit.rect) + 1e-9,
  "The projected stepped parapet cornice does not fit its summit.",
);

const steppedCorniceBuilder = new SolidBuilder();
buildStair(
  steppedCorniceBuilder,
  steppedCorniceRecord,
  steppedCorniceGraph.masses[0]!.bands,
  { masonry: null, seed: 1, tilesPerStep: DEFAULT_MASS_LAYOUT.stairTilesPerStep },
);
assert.equal(
  steppedCorniceBuilder.blockFaces.length * 6,
  steppedCorniceBuilder.indices.length,
  "The stepped cornice escaped the block-only geometry contract.",
);
const steppedCorniceFaces = readBlockFaces(steppedCorniceBuilder);
const steppedCapTops = steppedCorniceFaces.filter((face) => {
  const normal = faceNormal(face);
  return normal.y > 0.99
    && face.every((corner) =>
      corner.z >= steppedCorniceRecord.flightRect.minZ - 1e-9
      && corner.z <= steppedCorniceRecord.flightRect.maxZ + 1e-9)
    && Math.max(...face.map((corner) => corner.x))
      - Math.min(...face.map((corner) => corner.x))
      <= steppedCornice.width + 1e-9;
});
const steppedCapRuns = new Map<string, number>();
for (const face of steppedCapTops) {
  const xs = face.map((corner) => corner.x);
  const zs = face.map((corner) => corner.z);
  const side = sum(xs) < 0 ? "negative" : "positive";
  const key = [
    side,
    face[0]!.y.toFixed(9),
    Math.min(...zs).toFixed(9),
    Math.max(...zs).toFixed(9),
  ].join("/");
  steppedCapRuns.set(
    key,
    (steppedCapRuns.get(key) ?? 0) + Math.max(...xs) - Math.min(...xs),
  );
}
assert.equal(
  steppedCapRuns.size,
  steppedCorniceRecord.stepCount * 2,
  "Each stepped parapet tread needs one complete horizontal cornice cap per side.",
);
for (const width of steppedCapRuns.values()) {
  assert.ok(Math.abs(
    width - steppedCornice.width - steppedCornice.cornice.projection * 2
  ) < 1e-9, "A stepped parapet cornice cap does not span its full projection.");
}
for (const face of steppedCapTops) {
  assert.ok(
    face.every((corner) => Math.abs(corner.y - face[0]!.y) < 1e-9),
    "A stepped parapet cornice cap is not horizontal.",
  );
}

const steppedEndTops = steppedCorniceFaces.filter((face) => {
  const normal = faceNormal(face);
  return normal.y > 0.99
    && (
      face.some((corner) =>
        corner.z > steppedCorniceRecord.flightRect.maxZ + 1e-9)
      || face.some((corner) =>
        corner.z < steppedCorniceRecord.flightRect.minZ - 1e-9)
    );
});
assert.equal(
  steppedEndTops.length,
  4,
  "Both ends of both stepped parapet cornices need one horizontal top.",
);
for (const face of steppedEndTops) {
  assert.ok(
    face.every((corner) => Math.abs(corner.y - face[0]!.y) < 1e-9),
    "A stepped parapet ending is not horizontal.",
  );
}

const steppedCorniceBox = boundsOfBuilder(steppedCorniceBuilder);
const steppedTerminalLength = steppedCornice.width
  + steppedCornice.cornice.projection * 2;
assert.ok(Math.abs(
  steppedCorniceBox.minX
    - steppedCorniceRecord.flightRect.minX
    + steppedCornice.width
    + steppedCornice.cornice.projection,
) < 1e-9);
assert.ok(Math.abs(
  steppedCorniceBox.maxX
    - steppedCorniceRecord.flightRect.maxX
    - steppedCornice.width
    - steppedCornice.cornice.projection,
) < 1e-9);
assert.ok(Math.abs(
  steppedCorniceBox.minZ
    - steppedCorniceRecord.flightRect.minZ
    + steppedTerminalLength
) < 1e-9);
assert.ok(Math.abs(
  steppedCorniceBox.maxZ
    - steppedCorniceRecord.flightRect.maxZ
    - steppedTerminalLength
) < 1e-9);

const steppedCorniceGeometry = finalizeGeometry(steppedCorniceBuilder).geometry;
assert.equal(
  findCoincidentFaces(steppedCorniceGeometry).pairs,
  0,
  "A stepped parapet cornice has two faces at the same depth.",
);
assert.equal(
  findBuriedFaces(steppedCorniceGeometry).faces,
  0,
  "A stepped parapet cornice emits a face buried in its wall.",
);

// A cornice taller than its riser overlaps the next cap in elevation. The
// ownership split must still close the overhang without coincident faces.
const tallSteppedCorniceGraph = generateStructure(toStructureSpec({
  ...cloneFrontStairLayout(),
  baseTreatment: "none",
  bandCount: 1,
  totalHeight: 0.65,
  stairRiser: 0.12,
  stairParapetHeight: 0.6,
  stairSteppedParapetCorniceProjection: 0.2,
  stairSteppedParapetCorniceHeight: 0.3,
}));
const tallSteppedCorniceRecord = tallSteppedCorniceGraph.connectors[0]!;
assert.ok(
  tallSteppedCorniceRecord.parapet!.cornice!.height
    > tallSteppedCorniceRecord.riser,
);
const tallSteppedCorniceBuilder = new SolidBuilder();
buildStair(
  tallSteppedCorniceBuilder,
  tallSteppedCorniceRecord,
  tallSteppedCorniceGraph.masses[0]!.bands,
  { masonry: null, seed: 1, tilesPerStep: DEFAULT_MASS_LAYOUT.stairTilesPerStep },
);
const tallSteppedCorniceGeometry =
  finalizeGeometry(tallSteppedCorniceBuilder).geometry;
assert.equal(findCoincidentFaces(tallSteppedCorniceGeometry).pairs, 0);
assert.equal(findBuriedFaces(tallSteppedCorniceGeometry).faces, 0);

const steppedCornicedMassGraph = generateStructure(toStructureSpec({
  ...steppedCorniceLayout,
  cornicePlacement: "all",
}));
const steppedCornicedMassGeometry = mergeParts(
  tessellateStructure(steppedCornicedMassGraph, {
    masonry: null,
    seed: 1,
  }).parts,
  [MASS_SECTION],
).geometry;
assert.equal(
  findCoincidentFaces(steppedCornicedMassGeometry).pairs,
  0,
  "The stepped parapet cornice overlaps a mass cornice at the arrival.",
);
assert.equal(
  findBackfaces(steppedCornicedMassGeometry).backfaces,
  0,
  "The stepped parapet cornice leaves an open inward face.",
);

// The alternate side treatment replaces the staircase silhouette with two
// ground-backed walls. Its crown is one plane following the ideal flight, and
// the optional cornice is one projected band on that same plane.
const flatParapetLayout: MassLayoutConfig = {
  ...cloneFrontStairLayout(),
  stairSideTreatment: "sloped_parapet",
};
assert.doesNotThrow(() => validateMassLayout(flatParapetLayout));
const flatParapetGraph = generateStructure(toStructureSpec(flatParapetLayout));
assert.equal(
  flatParapetGraph.diagnostics.filter((entry) => entry.severity === "error").length,
  0,
);
const flatParapetRecord = flatParapetGraph.connectors[0]!;
const flatParapet = flatParapetRecord.parapet!;
assert.equal(flatParapetRecord.sideTreatment, "sloped_parapet");
assert.deepEqual(flatParapet.cornice, { projection: 0.2, height: 0.25 });
assert.equal(
  patchIndex(flatParapetGraph)
    .get(`${flatParapetRecord.id}/side_negative_u`)
    ?.edges.vMax.treatment,
  "cornice",
);
assert.ok(
  flatParapetRecord.width
    + 2 * (flatParapet.width + flatParapet.cornice.projection)
    <= rectWidth(flatParapetGraph.masses[0]!.summit.rect) + 1e-9,
  "The projected flat parapet cornice does not fit its summit.",
);

const flatParapetBuilder = new SolidBuilder();
buildStair(
  flatParapetBuilder,
  flatParapetRecord,
  flatParapetGraph.masses[0]!.bands,
  { masonry: null, seed: 1, tilesPerStep: DEFAULT_MASS_LAYOUT.stairTilesPerStep },
);
assert.equal(
  flatParapetBuilder.blockCount,
  flatParapetRecord.stepCount + 12,
  "A flat parapet should add one wall, one rake and two supported endings per side.",
);
assert.equal(
  flatParapetBuilder.blockFaces.length,
  flatParapetRecord.stepCount * 2 + 44,
  "The flat parapet emitted more surfaces than its simple decomposition.",
);
assert.equal(
  flatParapetBuilder.blockFaces.length * 6,
  flatParapetBuilder.indices.length,
  "The flat parapet escaped the block-only geometry contract.",
);

const flatParapetFaces = readBlockFaces(flatParapetBuilder);
const rakedTops = flatParapetFaces.filter((face) => {
  const normal = faceNormal(face);
  return normal.y > 0.1 && Math.abs(normal.z) > 0.1;
});
assert.equal(rakedTops.length, 2, "Each flat parapet needs exactly one raked cornice top.");

for (const face of rakedTops) {
  for (const corner of face) {
    const progress = (
      flatParapetRecord.flightRect.maxZ - corner.z
    ) / flatParapetRecord.run;
    const expectedY = flatParapetRecord.bottomY
      + progress * (flatParapetRecord.topY - flatParapetRecord.bottomY)
      + flatParapet.height;
    assert.ok(
      Math.abs(corner.y - expectedY) < 1e-9,
      `Flat parapet top at z=${corner.z} left its continuous rake.`,
    );
  }
}

const horizontalEndTops = flatParapetFaces.filter((face) => {
  const normal = faceNormal(face);
  return normal.y > 0.99
    && (
      face.some((corner) => corner.z > flatParapetRecord.flightRect.maxZ + 1e-9)
      || face.some((corner) => corner.z < flatParapetRecord.flightRect.minZ - 1e-9)
    );
});
assert.equal(
  horizontalEndTops.length,
  4,
  "Both ends of both flat parapet cornices need one horizontal top block.",
);
for (const face of horizontalEndTops) {
  assert.ok(
    face.every((corner) => Math.abs(corner.y - face[0]!.y) < 1e-9),
    "A flat parapet ending is not horizontal.",
  );
}

const flatBodyTopOffset = flatParapet.height - flatParapet.cornice.height;
const lowerEndingWalls = flatParapetFaces.filter((face) => {
  const normal = faceNormal(face);
  return Math.abs(normal.x) > 0.99
    && face.every((corner) => corner.z >= flatParapetRecord.flightRect.maxZ - 1e-9)
    && face.some((corner) => Math.abs(corner.y - flatParapetRecord.bottomY) < 1e-9)
    && face.some((corner) =>
      Math.abs(
        corner.y - flatParapetRecord.bottomY - flatBodyTopOffset,
      ) < 1e-9);
});
assert.equal(
  lowerEndingWalls.length,
  4,
  "Both lower cornice endings must carry inner and outer walls to the ground.",
);

const upperEndingWalls = flatParapetFaces.filter((face) => {
  const normal = faceNormal(face);
  return Math.abs(normal.x) > 0.99
    && face.every((corner) => corner.z <= flatParapetRecord.flightRect.minZ + 1e-9)
    && face.some((corner) => Math.abs(corner.y - flatParapetRecord.topY) < 1e-9)
    && face.some((corner) =>
      Math.abs(
        corner.y - flatParapetRecord.topY - flatBodyTopOffset,
      ) < 1e-9);
});
assert.equal(
  upperEndingWalls.length,
  4,
  "Both upper cornice endings must carry inner and outer walls to the summit floor.",
);

const flatOuterWalls = flatParapetFaces.filter((face) => {
  const normal = faceNormal(face);
  return Math.abs(normal.x) > 0.99
    && face.some((corner) => Math.abs(corner.y - flatParapetRecord.bottomY) < 1e-9)
    && face.some((corner) => corner.y > flatParapetRecord.topY);
});
assert.equal(
  flatOuterWalls.length,
  4,
  "Both inner and outer faces of both flat parapets must rise from the ground.",
);

const flatParapetBox = boundsOfBuilder(flatParapetBuilder);
const flatTerminalLength = flatParapet.width
  + flatParapet.cornice.projection * 2;
assert.ok(Math.abs(
  flatParapetBox.minX
    - flatParapetRecord.flightRect.minX
    + flatParapet.width
    + flatParapet.cornice.projection,
) < 1e-9);
assert.ok(Math.abs(
  flatParapetBox.maxX
    - flatParapetRecord.flightRect.maxX
    - flatParapet.width
    - flatParapet.cornice.projection,
) < 1e-9);
assert.ok(Math.abs(
  flatParapetBox.maxY - flatParapetRecord.topY - flatParapet.height
) < 1e-9);
assert.ok(Math.abs(
  flatParapetBox.minZ
    - flatParapetRecord.flightRect.minZ
    + flatTerminalLength
) < 1e-9);
assert.ok(Math.abs(
  flatParapetBox.maxZ
    - flatParapetRecord.flightRect.maxZ
    - flatTerminalLength
) < 1e-9);

const flatParapetGeometry = finalizeGeometry(flatParapetBuilder).geometry;
assert.equal(
  findCoincidentFaces(flatParapetGeometry).pairs,
  0,
  "A flat parapet has two faces at the same depth.",
);

const flatCornicedMassGraph = generateStructure(toStructureSpec({
  ...flatParapetLayout,
  cornicePlacement: "all",
}));
const flatCornicedMassGeometry = mergeParts(
  tessellateStructure(flatCornicedMassGraph, { masonry: null, seed: 1 }).parts,
  [MASS_SECTION],
).geometry;
assert.equal(
  findCoincidentFaces(flatCornicedMassGeometry).pairs,
  0,
  "The flat parapet cornice overlaps a mass cornice at the arrival.",
);
assert.equal(
  findBackfaces(flatCornicedMassGeometry).backfaces,
  0,
  "The flat parapet or its cornice exposes an inward face.",
);
const flatCornicedExtents = graphExtents(flatCornicedMassGraph);
const flatCornicedBox = flatCornicedMassGeometry.boundingBox;
assert.ok(flatCornicedExtents && flatCornicedBox);
for (const axis of ["x", "y", "z"] as const) {
  const tolerance = Math.max(
    1e-5,
    Math.abs(flatCornicedExtents.max[axis]) * 1e-6,
  );
  assert.ok(
    Math.abs(flatCornicedBox.min[axis] - flatCornicedExtents.min[axis]) < tolerance,
    `Flat corniced geometry min.${axis} disagrees with its graph.`,
  );
  assert.ok(
    Math.abs(flatCornicedBox.max[axis] - flatCornicedExtents.max[axis]) < tolerance,
    `Flat corniced geometry max.${axis} disagrees with its graph.`,
  );
}

const flatSteps = stairSteps(flatParapetRecord);
const flatProbeStep = flatSteps[Math.floor(flatSteps.length * 0.5)]!;
const flatProbeZ0 = flatParapetRecord.flightRect.minZ
  + flatProbeStep.vBack
  + flatParapetRecord.tread * 0.2;
const flatProbeZ1 = flatParapetRecord.flightRect.minZ
  + flatProbeStep.vFront
  - flatParapetRecord.tread * 0.2;
const flatProbeCapY = flatParapetRecord.bottomY
  + (
    flatParapetRecord.flightRect.maxZ - flatProbeZ1
  ) / flatParapetRecord.run
    * (flatParapetRecord.topY - flatParapetRecord.bottomY)
  + flatParapet.height;
const flatBodyMinX = flatParapetRecord.flightRect.minX - flatParapet.width;
assert.ok(faceIsCoveredByStair(
  horizontalFace(
    flatBodyMinX + flatParapet.width * 0.2,
    flatParapetRecord.flightRect.minX - flatParapet.width * 0.2,
    flatProbeZ0,
    flatProbeZ1,
    flatProbeCapY - 0.01,
  ),
  flatParapetRecord,
), "A face beneath the continuous parapet plane was not selected.");
assert.equal(faceIsCoveredByStair(
  horizontalFace(
    flatBodyMinX - flatParapet.cornice.projection * 0.8,
    flatBodyMinX - flatParapet.cornice.projection * 0.2,
    flatProbeZ0,
    flatProbeZ1,
    flatProbeCapY - flatParapet.cornice.height * 0.5,
  ),
  flatParapetRecord,
), false, "The cornice overhang incorrectly hid empty space below the wall.");

const uncornicedFlatGraph = generateStructure(toStructureSpec({
  ...flatParapetLayout,
  stairParapetCorniceHeight: 0,
}));
const uncornicedFlatRecord = uncornicedFlatGraph.connectors[0]!;
assert.equal(uncornicedFlatRecord.parapet?.cornice, undefined);
assert.equal(
  patchIndex(uncornicedFlatGraph)
    .get(`${uncornicedFlatRecord.id}/side_negative_u`)
    ?.edges.vMax.treatment,
  "sloped_cap",
);

const clampedParapetCornice = generateStructure(toStructureSpec({
  ...flatParapetLayout,
  stairParapetHeight: 0.2,
  stairParapetCorniceHeight: 0.3,
}));
assert.equal(clampedParapetCornice.connectors[0]?.parapet?.cornice?.height, 0.1);
assert.equal(
  clampedParapetCornice.diagnostics.find(
    (entry) => entry.code === "stair.parapet_cornice_height_reduced",
  )?.severity,
  "notice",
);

// The geometry: blocks, and nothing else, exactly like the mass. Every slice
// is cut at its cover lines, so the count follows the decomposition: one crown
// per step (the bare shaft between parapets presents no face and is not laid),
// and per parapet side two pieces at the foot then three per step — pressed
// base, balustrade wall, crown strip. Derived here from the same rules rather
// than hard-coded, and valid for the default: no crown cornice (no exposed
// back interval) and a parapet taller than a riser.
const stairBareBuilder = new SolidBuilder();
const stairBands = stairDefault.masses[0]!.bands;
buildStair(stairBareBuilder, stairRecord, stairBands, {
  masonry: null,
  seed: 1,
  tilesPerStep: DEFAULT_MASS_LAYOUT.stairTilesPerStep,
});
assert.equal(
  stairBareBuilder.blockCount,
  stairRecord.stepCount + 2 * (2 + 3 * (stairRecord.stepCount - 1)),
  "The bare stair block count no longer matches its decomposition.",
);
assert.equal(
  stairBareBuilder.blockFaces.length * 6,
  stairBareBuilder.indices.length,
  "Part of the stair is not a block.",
);

// Every stair block is an upright box: rectangular, square-cornered and
// axis-aligned, because the pitch lives in where the slices sit, exactly as
// the batter lives in where the courses sit.
for (const [index, face] of readBlockFaces(stairBareBuilder).entries()) {
  assert.ok(
    Math.abs(face[0]!.distanceTo(face[1]!) - face[3]!.distanceTo(face[2]!)) < 1e-9,
    `Stair face ${index} is not rectangular.`,
  );
  const stairNormal = faceNormal(face);
  assert.ok(
    [stairNormal.x, stairNormal.y, stairNormal.z]
      .filter((axis) => Math.abs(axis) > 1e-9).length === 1,
    `Stair face ${index} is not axis-aligned.`,
  );
}

// The blocks occupy exactly the extents the record declares — flush at the
// flight's edges, at its projecting foot, and at the parapet caps — because the
// extents check upstream holds the merged mesh to the graph's word.
const stairBox = boundsOfBuilder(stairBareBuilder);
assert.ok(Math.abs(stairBox.minX - (stairRecord.flightRect.minX - stairRecord.parapet!.width)) < 1e-9);
assert.ok(Math.abs(stairBox.maxX - (stairRecord.flightRect.maxX + stairRecord.parapet!.width)) < 1e-9);
assert.ok(Math.abs(stairBox.minZ - stairRecord.flightRect.minZ) < 1e-9);
assert.ok(Math.abs(stairBox.maxZ - stairRecord.flightRect.maxZ) < 1e-9);
assert.ok(Math.abs(stairBox.maxY - (stairRecord.topY + stairRecord.parapet!.height)) < 1e-9);

// No two stair surfaces at the same depth, and nothing to see into: the slice
// model's whole point is that every face is either visible or buried, decided,
// never coincident.
const stairBareGeometry = finalizeGeometry(stairBareBuilder).geometry;
assert.equal(
  findCoincidentFaces(stairBareGeometry).pairs,
  0,
  "A bare stair has two faces at the same depth.",
);

// With masonry on, each step divides into stones along its width and the
// treads stay dead level: displacement would read as broken steps, so every
// upward face sits exactly on a tread or a parapet cap.
const stairMasonryBuilder = new SolidBuilder();
const stairRule = toMasonry(cloneFrontStairLayout(), DEFAULT_MASS_STONE_CONFIG);
assert.ok(stairRule);
buildStair(stairMasonryBuilder, stairRecord, stairBands, {
  masonry: stairRule,
  seed: 7,
  tilesPerStep: DEFAULT_MASS_LAYOUT.stairTilesPerStep,
});
assert.ok(
  stairMasonryBuilder.blockCount > stairBareBuilder.blockCount,
  "Masonry must divide the steps into stones.",
);
const treadTileCount = (builder: SolidBuilder, treadY: number) =>
  readBlockFaces(builder).filter((face) =>
    faceNormal(face).y > 0.99
    && face.every((corner) =>
      corner.x >= stairRecord.flightRect.minX - 1e-9
      && corner.x <= stairRecord.flightRect.maxX + 1e-9
      && Math.abs(corner.y - treadY) < 1e-9))
    .length;
for (let index = 1; index <= stairRecord.stepCount; index += 1) {
  assert.equal(
    treadTileCount(
      stairMasonryBuilder,
      stairRecord.bottomY + index * stairRecord.riser,
    ),
    DEFAULT_MASS_LAYOUT.stairTilesPerStep,
    `Step ${index} did not use the configured tile count.`,
  );
}

const twoTileStairBuilder = new SolidBuilder();
buildStair(twoTileStairBuilder, stairRecord, stairBands, {
  masonry: stairRule,
  seed: 7,
  tilesPerStep: 2,
});
const eightTileStairBuilder = new SolidBuilder();
buildStair(eightTileStairBuilder, stairRecord, stairBands, {
  masonry: stairRule,
  seed: 7,
  tilesPerStep: 8,
});
assert.equal(
  treadTileCount(twoTileStairBuilder, stairRecord.bottomY + stairRecord.riser),
  2,
);
assert.equal(
  treadTileCount(eightTileStairBuilder, stairRecord.bottomY + stairRecord.riser),
  8,
);
assert.ok(
  eightTileStairBuilder.blockCount > twoTileStairBuilder.blockCount,
  "Increasing tiles per step did not increase the stair masonry.",
);
const stairLevels = new Set<string>();

for (let index = 1; index <= stairRecord.stepCount; index += 1) {
  const tread = stairRecord.bottomY + index * stairRecord.riser;
  stairLevels.add(tread.toFixed(6));
  stairLevels.add((tread + stairRecord.parapet!.height).toFixed(6));
}

for (const [index, face] of readBlockFaces(stairMasonryBuilder).entries()) {
  if (faceNormal(face).y > 0.99) {
    assert.ok(
      stairLevels.has(face[0]!.y.toFixed(6)),
      `Stair top face ${index} sits at ${face[0]!.y}, off every tread and cap.`,
    );
  }
}
assert.equal(
  findCoincidentFaces(finalizeGeometry(stairMasonryBuilder).geometry).pairs,
  0,
  "A masonry stair has two faces at the same depth.",
);

// The tessellator culls mass faces between laying the mass and laying the
// connector. Reconstructing those two uncancelled counts separately gives the
// exact number the post-pass removed without teaching the test its internals.
const defaultBareTessellation = tessellateStructure(stairDefault, {
  masonry: null,
  seed: 1,
});
const stairlessBareTessellation = tessellateStructure(stairless, {
  masonry: null,
  seed: 1,
});
assert.equal(
  defaultBareTessellation.faceCount,
  stairlessBareTessellation.faceCount + stairBareBuilder.blockFaces.length,
  "A broad bare mass face that only crosses the stair was culled instead of retained.",
);

const defaultMasonryTessellation = tessellateStructure(stairDefault, {
  masonry: stairRule,
  seed: 7,
});
const stairlessMasonryTessellation = tessellateStructure(stairless, {
  masonry: stairRule,
  seed: 7,
});
const defaultMasonryCulled = stairlessMasonryTessellation.faceCount
  + stairMasonryBuilder.blockFaces.length
  - defaultMasonryTessellation.faceCount;
assert.ok(
  defaultMasonryCulled > 100,
  `Only ${defaultMasonryCulled} complete masonry faces were removed behind the stair.`,
);

const openStairRecord = openSided.connectors[0]!;
const openStairBuilder = new SolidBuilder();
buildStair(
  openStairBuilder,
  openStairRecord,
  openSided.masses[0]!.bands,
  {
    masonry: stairRule,
    seed: 7,
    tilesPerStep: DEFAULT_MASS_LAYOUT.stairTilesPerStep,
  },
);
const openStairless = generateStructure(toStructureSpec({
  ...cloneFrontStairLayout(),
  ...STAIRS_DISABLED,
  stairSideTreatment: "none",
}));
const openMasonryCulled = tessellateStructure(openStairless, {
  masonry: stairRule,
  seed: 7,
}).faceCount + openStairBuilder.blockFaces.length - tessellateStructure(openSided, {
  masonry: stairRule,
  seed: 7,
}).faceCount;
assert.ok(
  openMasonryCulled > 0,
  "An open-sided flight did not cull any fully covered mass faces.",
);

// A greybox normally presents one broad facade quad, so its default stair only
// overlaps that face partially and correctly leaves it whole. This engine-edge
// fixture makes the flight-plus-parapets exactly facade-wide, proving the same
// pass also reaches a complete bare face. Values of one are intentional here:
// they exercise the generator boundary beyond the pane's conservative sliders.
const fullAssemblyLayout: MassLayoutConfig = {
  ...cloneFrontStairLayout(),
  baseTreatment: "none",
  bandCount: 1,
  totalHeight: 2,
  batterAngle: 0,
  summitRatio: 1,
  cornicePlacement: "none",
  stoneworkEnabled: false,
  stairWidthRatio: 1,
};
const fullAssembly = generateStructure(toStructureSpec(fullAssemblyLayout));
const fullAssemblyStairless = generateStructure(toStructureSpec({
  ...fullAssemblyLayout,
  ...STAIRS_DISABLED,
}));
const fullAssemblyRecord = fullAssembly.connectors[0]!;
const fullAssemblyStairBuilder = new SolidBuilder();
buildStair(
  fullAssemblyStairBuilder,
  fullAssemblyRecord,
  fullAssembly.masses[0]!.bands,
  { masonry: null, seed: 1, tilesPerStep: DEFAULT_MASS_LAYOUT.stairTilesPerStep },
);
const fullAssemblyCulled = tessellateStructure(fullAssemblyStairless, {
  masonry: null,
  seed: 1,
}).faceCount + fullAssemblyStairBuilder.blockFaces.length - tessellateStructure(
  fullAssembly,
  { masonry: null, seed: 1 },
).faceCount;
assert.equal(
  fullAssemblyCulled,
  1,
  `A facade-wide stair should remove one bare facade face, removed ${fullAssemblyCulled}.`,
);

// --- buried faces ----------------------------------------------------------
// The probe is checked against a deliberate defect before it is trusted: a
// block whose top is emitted under another block sitting on it. The cover's
// own underside is legitimately unemitted, so the probe must travel through
// the cover and out its far side — which is why its reach is the thickness of
// a covering solid, not a coplanarity tolerance.
const buriedProbeBuilder = new SolidBuilder();
buriedProbeBuilder.addBlock(
  blockOf(rect(1, 1), rect(1, 1), 0, 1),
  { sides: ALL_SIDES, top: true },
);
buriedProbeBuilder.addBlock(
  blockOf(rect(1, 1), rect(1, 1), 1, 1.8),
  { sides: ALL_SIDES, top: true },
);
assert.equal(
  findBuriedFaces(finalizeGeometry(buriedProbeBuilder).geometry).faces,
  1,
  "The buried-face probe misses a top emitted under a block standing on it.",
);
assert.equal(
  findBuriedFaces(finalizeGeometry(withOnly(
    blockOf(rect(1, 1), rect(1, 1), 0, 1),
    { sides: ALL_SIDES, top: true },
  )).geometry).faces,
  0,
  "The buried-face probe indicts a block standing alone.",
);

// The stair decomposition's whole point: nothing bare is ever buried, and the
// only buried masonry faces are the collars — one closure strip per slice,
// standing behind the previous crown's open joints exactly as the mass's
// backing ring stands behind the perpends of its facing course.
assert.equal(
  findBuriedFaces(stairBareGeometry).faces,
  0,
  "A bare stair lays a face nothing can see.",
);
const stairMasonryBuried = findBuriedFaces(finalizeGeometry(stairMasonryBuilder).geometry);
assert.ok(
  stairMasonryBuried.faces <= stairRecord.stepCount,
  `${stairMasonryBuried.faces} buried masonry stair faces: more than its collars.`,
);

// --- stair against a corniced crown ----------------------------------------
// The flight lands on the crown molding's outer lip, and the wall beneath the
// lip recedes — a laterally open niche the stair's last slice backs onto. The
// backs facing it must be real faces over exactly the exposed interval: none
// at all reads as a view into the stair's body, and any above the cornice's
// own springing would be coincident with the molding's front.
const cornicedStairRecord = corniced.connectors[0]!;
const cornicedStairBuilder = new SolidBuilder();
buildStair(
  cornicedStairBuilder,
  cornicedStairRecord,
  corniced.masses[0]!.bands,
  { masonry: null, seed: 1, tilesPerStep: DEFAULT_MASS_LAYOUT.stairTilesPerStep },
);
const cornicedStairGeometry = finalizeGeometry(cornicedStairBuilder).geometry;
assert.equal(findCoincidentFaces(cornicedStairGeometry).pairs, 0);
assert.equal(findBuriedFaces(cornicedStairGeometry).faces, 0);

const cornicedStairBacks = readBlockFaces(cornicedStairBuilder).filter((face) =>
  faceNormal(face).z < -0.99
  && Math.abs(face[0]!.z - cornicedStairRecord.flightRect.minZ) < 1e-9);
assert.ok(
  cornicedStairBacks.some((face) =>
    face.some((corner) => corner.y < cornicedCrown.topY - 1e-9)),
  "The last slice shows no back to the niche under the crown cornice.",
);
for (const face of cornicedStairBacks) {
  for (const corner of face) {
    assert.ok(
      corner.y <= cornicedCrown.cornice!.bottomY + 1e-9
      || corner.y >= cornicedStairRecord.topY - 1e-9,
      `A stair back at y=${corner.y} overlaps the cornice's own front.`,
    );
  }
}

// A parapet shallower than a riser flips the middle stretch of each slice
// into the exposed front strip of the silhouette. Skipping it instead leaves
// a hole on every step — which the buried and backface probes cannot see, so
// the front coverage is asserted directly: parapet fronts must tile the same
// height span as the caps they finish.
const shallowParapetGraph = generateStructure(toStructureSpec({
  ...cloneFrontStairLayout(),
  stairParapetHeight: 0.2,
}));
const shallowParapetRecord = shallowParapetGraph.connectors[0]!;
assert.ok(shallowParapetRecord.parapet!.height < shallowParapetRecord.riser);
const shallowParapetBuilder = new SolidBuilder();
buildStair(
  shallowParapetBuilder,
  shallowParapetRecord,
  shallowParapetGraph.masses[0]!.bands,
  { masonry: null, seed: 1, tilesPerStep: DEFAULT_MASS_LAYOUT.stairTilesPerStep },
);
const shallowParapetGeometry = finalizeGeometry(shallowParapetBuilder).geometry;
assert.equal(findCoincidentFaces(shallowParapetGeometry).pairs, 0);
assert.equal(findBuriedFaces(shallowParapetGeometry).faces, 0);

const shallowParapetFronts = readBlockFaces(shallowParapetBuilder).filter((face) =>
  faceNormal(face).z > 0.99
  && face.every((corner) => corner.x > shallowParapetRecord.flightRect.maxX - 1e-9));
const frontCoverage = shallowParapetFronts
  .reduce((total, face) => {
    const ys = face.map((corner) => corner.y);
    return total + Math.max(...ys) - Math.min(...ys);
  }, 0);
assert.ok(
  Math.abs(
    frontCoverage
    - (shallowParapetRecord.topY - shallowParapetRecord.bottomY
      + shallowParapetRecord.parapet!.height),
  ) < 1e-6,
  `Parapet front strips cover ${frontCoverage}m of a stepped silhouette that `
  + "rises the whole flight.",
);

// --- stonework -------------------------------------------------------------
// Stonework is drawn, not modelled: the same graph with and without it. That
// keeps construction a reader of the semantic layer, which is what stops a
// change of surface treatment from invalidating the massing under it.
const STONEWORK_LAYOUT: MassLayoutConfig = {
  ...cloneFrontStairLayout(),
  footprintWidth: 24,
  footprintDepth: 18,
  bandCount: 5,
  totalHeight: 12,
  batterAngle: 14,
  heightCurve: "front_loaded",
  stoneworkEnabled: true,
  courseHeight: 0.45,
  stoneWidth: 1.1,
  stoneDepth: 0.7,
  cornerRule: "alternating_interlock",
};
assert.doesNotThrow(() => validateMassLayout(STONEWORK_LAYOUT));

const stoneGraph = generateStructure(toStructureSpec(STONEWORK_LAYOUT));
assert.equal(
  serializeGraph(stoneGraph),
  serializeGraph(generateStructure(toStructureSpec({
    ...STONEWORK_LAYOUT,
    stoneworkEnabled: false,
  }))),
  "Stonework must not reach the graph.",
);

const stoneRule = toMasonry(STONEWORK_LAYOUT, DEFAULT_MASS_STONE_CONFIG);
assert.ok(stoneRule);

// Coverage. Every division has to consume its span exactly — dividing by
// `round(length / target)` and living with the difference is what left bare
// wedges at the raking edges and dropped stones at the ends of a run.
for (const length of [0.4, 1, 7.3, 18, 24, 61.7]) {
  const widths = divideRun(length, stoneRule, 12345);
  assert.ok(widths.length >= 1, `A ${length}m run produced no stones.`);
  assert.ok(
    Math.abs(sum(widths) - length) < 1e-9,
    `Stones over ${length}m sum to ${sum(widths)}.`,
  );
  for (const width of widths) {
    assert.ok(width > 0, `A ${length}m run produced a zero-width stone.`);
  }
}

for (const height of [0.3, 1.2, 4.6, 11]) {
  const courses = divideCourses(height, stoneRule, 999);
  assert.ok(courses.length >= 1);
  assert.ok(
    Math.abs(sum(courses.map((course) => course.height)) - height) < 1e-9,
    `Courses over ${height}m do not sum to it.`,
  );
  // Beds stack without overlapping or leaving a seam between them.
  for (let index = 0; index < courses.length; index += 1) {
    const course = courses[index];
    const previous = courses[index - 1];
    assert.ok(course);
    assert.ok(course.height > 0);
    assert.ok(
      Math.abs(course.bottom - (previous ? previous.bottom + previous.height : 0)) < 1e-9,
      `Course ${index} does not sit on the one below.`,
    );
  }
}

// Size consistency. The complaint was stones coming out different sizes on
// different sides, which happened because counts were derived per face from a
// clipped run. Driving both from one target keeps them comparable however the
// faces differ in length.
const runLengths = [24, 18, 7.3, 41];
const meanWidths = runLengths.map((length) => {
  const widths = divideRun(length, stoneRule, hashSeed(7, `run_${length}`));
  return sum(widths) / widths.length;
});

for (const mean of meanWidths) {
  assert.ok(
    Math.abs(mean - stoneRule.stoneWidth) < stoneRule.stoneWidth * 0.35,
    `Mean stone width ${mean} strays from the ${stoneRule.stoneWidth}m target.`,
  );
}

// Courses stay comparable between a tall base band and a shallow crown band,
// which the old per-face row count did not: under a front-loaded curve it gave
// the base three times the course height of the crown.
const bandCourseHeights = (stoneGraph.masses[0]?.bands ?? [])
  .filter((band) => band.index >= 0)
  .map((band) => {
    const courses = divideCourses(band.topY - band.bottomY, stoneRule, 1);
    return sum(courses.map((course) => course.height)) / courses.length;
  });
assert.ok(bandCourseHeights.length >= 4);
const tallest = Math.max(...bandCourseHeights);
const shortest = Math.min(...bandCourseHeights);
assert.ok(
  tallest / shortest < 1.6,
  `Course heights range ${shortest} to ${tallest} across bands.`,
);

// The ring divider. A corner belongs to a course, not to an elevation, and the
// whole point of dividing the loop in one go is that each corner is answered
// once. Deriving it per face is what made two walls each emit their own slab at
// the same corner, interpenetrating behind the arris and never reading as a
// quoin at all.
const ringRuns = [24, 18, 24, 18];

for (let course = 0; course < 6; course += 1) {
  const ring = divideCourseRing(ringRuns, stoneRule, course, 4242);
  const quoins = ring.filter((block) => block.wrap > 0);

  assert.equal(quoins.length, 4, `Course ${course} has ${quoins.length} quoins, not four.`);

  // Exactly one block turns each corner, so a corner cannot be claimed twice.
  const corners = new Set(quoins.map((block) => block.run));
  assert.equal(corners.size, 4, `Course ${course} claims a corner more than once.`);

  // Every run is covered end to end, with nothing overlapping. A quoin is listed
  // once, under the run it reaches back along, so what it occupies on the next
  // run is its wrap rather than a second entry — counting it twice is exactly
  // the double-claimed corner this replaced.
  for (let run = 0; run < 4; run += 1) {
    const wrapped = ring.find((block) => block.wrap > 0 && block.run === (run + 3) % 4);
    const spans = [
      ...(wrapped ? [{ from: 0, to: wrapped.wrap }] : []),
      ...ring
        .filter((block) => block.run === run)
        .map((block) => ({ from: block.from, to: block.to })),
    ].sort((a, b) => a.from - b.from);
    assert.ok(spans.length > 1, `Course ${course} run ${run} has ${spans.length} blocks.`);
    assert.ok(
      Math.abs((spans[0]?.from ?? -1)) < 1e-9,
      `Course ${course} run ${run} starts ${spans[0]?.from}m in.`,
    );
    assert.ok(
      Math.abs((spans[spans.length - 1]?.to ?? 0) - (ringRuns[run] ?? 0)) < 1e-9,
      `Course ${course} run ${run} stops short of its corner.`,
    );
    for (let i = 1; i < spans.length; i += 1) {
      assert.ok(
        Math.abs((spans[i]?.from ?? 0) - (spans[i - 1]?.to ?? 0)) < 1e-9,
        `Course ${course} run ${run} has a gap or an overlap at block ${i}.`,
      );
    }
  }
}

// The interlock: a corner's long leg swaps sides from one course to the next, so
// the two elevations bond up the arris instead of meeting on one long joint.
for (let course = 0; course < 5; course += 1) {
  const here = divideCourseRing(ringRuns, stoneRule, course, 1);
  const above = divideCourseRing(ringRuns, stoneRule, course + 1, 1);

  for (let corner = 0; corner < 4; corner += 1) {
    const quoin = here.find((block) => block.wrap > 0 && block.run === corner);
    const over = above.find((block) => block.wrap > 0 && block.run === corner);
    assert.ok(quoin && over);
    const reach = quoin.to - quoin.from;
    const reachAbove = over.to - over.from;
    assert.ok(
      Math.abs(reach - reachAbove) > 1e-6,
      `Corner ${corner} reaches the same way on courses ${course} and ${course + 1}.`,
    );
    assert.ok(
      (reach > quoin.wrap) !== (reachAbove > over.wrap),
      `Corner ${corner} keeps its long leg on the same elevation twice running.`,
    );
  }
}

// A run too short to spare two quoins falls back to butted corners rather than
// being over-divided into nothing but corners.
assert.equal(
  divideCourseRing([0.8, 0.8, 0.8, 0.8], stoneRule, 0, 1)
    .some((block) => block.wrap > 0),
  false,
  "A run under a metre must not be quoined at both ends.",
);
assert.equal(
  divideCourseRing(ringRuns, { ...stoneRule, cornerRule: "butted" }, 0, 1)
    .some((block) => block.wrap > 0),
  false,
  "Butted corners must produce no quoins.",
);

// Compact bases still use the shared alternating bond. Their quoins shorten
// uniformly to fit the return rather than silently degrading to butted corners.
const compactRule: MasonryRule = {
  ...stoneRule,
  courseHeight: 0.2,
  stoneWidth: 0.34,
  depth: 0.1,
  sizeVariation: 0,
  gap: 0,
  displacement: 0,
};
const compactRuns = [1.5, 0.5, 1.5, 0.5];
for (let course = 0; course < 2; course += 1) {
  assert.equal(
    divideCourseRing(compactRuns, compactRule, course, 1)
      .filter((block) => block.wrap > 0).length,
    4,
    `Compact course ${course} did not keep all four interlocked corners.`,
  );
}

// Course parity continues through semantic band boundaries. Two identical
// one-course bands must not both restart at course zero; the second course
// turns its quoins onto the other elevations and therefore divides this
// rectangular loop into a different number of blocks.
const compactBand = (id: string, bottomY: number): ElevationBandRecord => ({
  id,
  index: 0,
  bottomY,
  topY: bottomY + 0.2,
  rise: 0.2,
  lower: { minX: -0.75, maxX: 0.75, minZ: -0.25, maxZ: 0.25 },
  upper: { minX: -0.75, maxX: 0.75, minZ: -0.25, maxZ: 0.25 },
  wallProfile: "vertical",
  surfaceRole: "base_plinth",
  upperTransition: "walkable_terrace",
  walkable: true,
  cornice: null,
});
const firstCompactCourse = new SolidBuilder();
buildMassShell(firstCompactCourse, [compactBand("compact_01", 0)], {
  rule: compactRule,
  seed: 1,
});
const compactStack = new SolidBuilder();
buildMassShell(compactStack, [
  compactBand("compact_01", 0),
  compactBand("compact_02", 0.2),
], { rule: compactRule, seed: 1 });
assert.notEqual(
  compactStack.blockCount,
  firstCompactCourse.blockCount * 2,
  "The second band restarted the corner bond at course zero.",
);

// Determinism, and that the seed actually reaches the stones.
const stoneMesh = (layout: MassLayoutConfig) => {
  const graph = generateStructure(toStructureSpec(layout));
  const rule = toMasonry(layout, DEFAULT_MASS_STONE_CONFIG);
  return mergeParts(
    tessellateStructure(graph, { masonry: rule, seed: layout.seed }).parts,
    [MASS_SECTION],
  );
};
const stonesA = stoneMesh(STONEWORK_LAYOUT);
const stonesB = stoneMesh(STONEWORK_LAYOUT);
const stonesReseeded = stoneMesh({ ...STONEWORK_LAYOUT, seed: STONEWORK_LAYOUT.seed + 1 });
const positionsOf = (merged: { geometry: THREE.BufferGeometry }) =>
  Array.from(merged.geometry.getAttribute("position").array as Float32Array);

assert.deepEqual(positionsOf(stonesA), positionsOf(stonesB));
assert.notDeepEqual(
  positionsOf(stonesA),
  positionsOf(stonesReseeded),
  "Reseeding must reshuffle the stones.",
);

// Reseeding reshuffles the stones without moving the massing they sit on. The
// seeds block itself does change — that is the seed doing its job — so this
// compares the resolved masses and patches rather than the whole graph.
assert.equal(
  massingFingerprint(generateStructure(toStructureSpec(STONEWORK_LAYOUT))),
  massingFingerprint(generateStructure(toStructureSpec({
    ...STONEWORK_LAYOUT,
    seed: STONEWORK_LAYOUT.seed + 1,
  }))),
  "Reseeding the stonework must not move the massing under it.",
);

const bareMass = mergeParts(
  tessellateStructure(stoneGraph, { masonry: null, seed: 1 }).parts,
  [MASS_SECTION],
);
assert.ok(
  stonesA.totals.triangleCount > bareMass.totals.triangleCount * 5,
  "Stonework must actually face the surfaces.",
);

// Coherence. The stones are set to the surface the graph declares, so the built
// mass occupies the same space as the bare one to within the distance a corner
// is allowed to wander. It is not a skin on the outside of the massing: a facing
// raised outward would push every extent out by its own thickness, which is far
// more than a gap.
const stoneBox = stonesA.geometry.boundingBox;
const bareBox = bareMass.geometry.boundingBox;
assert.ok(stoneBox && bareBox);
const wander = displacementDistance(
  Math.max(
    stoneRule.stoneWidth * (1 + stoneRule.sizeVariation),
    stoneRule.depth,
  ),
  stoneRule.displacement,
) + stoneRule.gap + 1e-4;
for (const axis of ["x", "y", "z"] as const) {
  assert.ok(
    Math.abs(stoneBox.min[axis] - bareBox.min[axis]) < wander,
    `Faced and bare builds disagree on min.${axis} by more than a stone may wander.`,
  );
  assert.ok(
    Math.abs(stoneBox.max[axis] - bareBox.max[axis]) < wander,
    `Faced and bare builds disagree on max.${axis} by more than a stone may wander.`,
  );
}

// Budget. Laying a mass out of stone all the way through costs more than facing
// a core with a skin did — there is no core — but it stays within reach of a
// real-time build, and the count is here so a change that multiplies it shows up
// as a failure rather than as a frame-rate complaint.
assert.ok(
  stonesA.totals.triangleCount <= 120000,
  `Stonework costs ${stonesA.totals.triangleCount} triangles, over the 120000 budget.`,
);

// --- the shell -------------------------------------------------------------
// What the eye actually catches is z-fighting, holes, and a surface that changes
// tone where it should not. Three reworks of this layer each passed every
// assertion in place at the time and still came out visibly wrong, so these are
// measured on the finished mesh, with no knowledge of what drew it.
//
// The detectors are checked against deliberate defects first. An invariant that
// has never rejected anything is not an invariant, and each of these has a shape
// of failure specific enough to fake.
const fightBuilder = new SolidBuilder();
fightBuilder.addBlock(blockOf(rect(2, 2), rect(2, 2), 0, 1), { sides: [], top: true });
fightBuilder.addBlock(
  blockOf(rect(2, 2), rect(2, 2), 0, 1 + 1e-5),
  { sides: [], top: true },
);
assert.ok(
  findCoincidentFaces(finalizeGeometry(fightBuilder).geometry).pairs > 0,
  "The coincidence detector misses two faces a hundredth of a millimetre apart.",
);

// No lid: every ray from above meets the inside of the floor.
const holed = finalizeGeometry(withOnly(
  blockOf(rect(2, 2), rect(2, 2), 0, 2),
  { sides: ALL_SIDES, bottom: true },
)).geometry;
holed.computeBoundingBox();
assert.ok(
  findBackfaces(holed, 60).backfaces > 0,
  "The backface detector misses a box with its lid off.",
);

// The shading invariant is checked against a deliberate second palette before
// it is trusted on the Mass.
const wrongShadeBuilder = new SolidBuilder();
wrongShadeBuilder.addBlock(
  blockOf(rect(2, 2), rect(2, 2), 0, 1),
  { sides: ALL_SIDES, top: true },
  { bottomAo: 0.5, topAo: 0.5, bottomShadow: 0.5, topShadow: 0.5 },
);
assert.ok(
  findStoneShadingBreaks(finalizeGeometry(wrongShadeBuilder).geometry).worst > 0.05,
  "The shading detector misses a block that does not match circular stone.",
);

// Now the mass itself, in the configuration every one of the three faults was
// reported in: cornices on every band, blocks on, a battered stack of terraces.
const SHELL_LAYOUT: MassLayoutConfig = {
  ...cloneFrontStairLayout(),
  footprintWidth: 24,
  footprintDepth: 18,
  bandCount: 3,
  totalHeight: 6,
  batterAngle: 12,
  cornicePlacement: "all",
  corniceProjection: 0.2,
  corniceHeight: 0.25,
  stoneworkEnabled: true,
};
const shellGraph = generateStructure(toStructureSpec(SHELL_LAYOUT));
const shellRule = toMasonry(SHELL_LAYOUT, DEFAULT_MASS_STONE_CONFIG);
const shellBands = shellGraph.masses[0]?.bands ?? [];
assert.ok(shellRule);
const shellGeometry = tessellateStructure(shellGraph, {
  masonry: shellRule,
  seed: SHELL_LAYOUT.seed,
}).parts[0]?.geometry;
assert.ok(shellGeometry);

// No two surfaces at the same depth. This is the z-fighting: a horizontal plate
// drawn out through the wall under every cornice, and a terrace paved on top of
// the course that already carried its edge.
// With the stones set square this is exactly zero. With displacement on it
// measures zero today too, but a wandered arris is free to land within the
// detector's millimetre of another face — that is what setting stones by hand
// costs — so displaced work keeps a small budget rather than a zero.
const squareGeometry = tessellateStructure(shellGraph, {
  masonry: { ...shellRule, displacement: 0 },
  seed: DEFAULT_MASS_STONE_CONFIG.seed,
}).parts[0]?.geometry;
assert.ok(squareGeometry);
// Exactly zero, stair included. The flight leans on the coursed face, but its
// pieces are cut at their cover lines: the only stair faces that reach into
// the mass's skin are silhouettes on planes the mass never uses, so the two
// jointed systems no longer put faces at the same depth.
const squareCoincidence = findCoincidentFaces(squareGeometry);
assert.equal(
  squareCoincidence.pairs,
  0,
  `${squareCoincidence.pairs} coplanar overlapping faces with the stones set `
  + `square, first at ${squareCoincidence.sample}.`,
);

// And nothing is laid into solid stone beyond the closures that are the point:
// the mass's backing rings and sealed course cheeks that stop joints reading
// as slots into nothing, the corner stones' inner faces that close the joints
// beside their returns, and the stair's collars. The budget is the measured
// count with a margin, so an emission heuristic that regresses shows up as
// hundreds of new buried faces rather than as wireframe noise someone has to
// notice.
const squareBuried = findBuriedFaces(squareGeometry);
assert.ok(
  squareBuried.faces <= 560,
  `${squareBuried.faces} faces laid into solid stone, first at ${squareBuried.sample}.`,
);

const coincidence = findCoincidentFaces(shellGeometry);
assert.ok(
  coincidence.pairs <= 4,
  `${coincidence.pairs} coplanar overlapping faces, first at ${coincidence.sample}.`,
);

// Nowhere to see in. Not a manifold test: blocks butt across joints and meet at
// T-junctions, so a mass built of set stone is legitimately non-manifold, and
// demanding closure would force a shape nobody wants.
// A joint is a real void, so a ray exactly in the plane of one will always find
// it. This is a budget rather than a zero for that reason, and it is a tight one.
const seenIn = findBackfaces(shellGeometry);
assert.ok(seenIn.shots > 1000, `Only ${seenIn.shots} rays reached the mass.`);
assert.ok(
  seenIn.backfaces <= 3,
  `${seenIn.backfaces} of ${seenIn.shots} rays see into the mass, first at ${seenIn.sample}.`,
);

// The Mass uses the circular stone palette exactly: each stone side runs from
// dark bed to lighter top, while horizontal tops stay fully open. AO and crack
// shadow are both checked on the finished buffers.
const tone = findStoneShadingBreaks(shellGeometry);
assert.ok(
  tone.worst < 1e-5,
  `Mass shading differs from circular stone: worst drift `
  + `${tone.worst.toFixed(4)} at ${tone.sample}.`,
);

// The same three, on a plain battered stack with no cornice, so the checks are
// not passing on one lucky configuration.
const plainGraph = generateStructure(toStructureSpec({
  ...SHELL_LAYOUT,
  cornicePlacement: "none",
  bandCount: 5,
  batterAngle: 0,
  summitRatio: 0.35,
}));
const plainGeometry = tessellateStructure(plainGraph, {
  masonry: shellRule,
  seed: 3,
}).parts[0]?.geometry;
assert.ok(plainGeometry);
assert.ok(findCoincidentFaces(plainGeometry).pairs <= 12);
assert.ok(findStoneShadingBreaks(plainGeometry).worst < 1e-5);
// A vertical wall has no treads, so its only openings are the joints themselves.
// One ray in a couple of thousand still slips along one edge-on; a joint is a
// real void and a ray exactly in its plane will always find it, so this is a
// budget rather than a zero.
const plainSeenIn = findBackfaces(plainGeometry);
assert.ok(
  plainSeenIn.backfaces <= 2,
  `${plainSeenIn.backfaces} of ${plainSeenIn.shots} rays see into a plain stack, `
  + `first at ${plainSeenIn.sample}.`,
);

// Corner sightlines. Butted corners repeat the same seam on every course, so
// any gap there stacks into a slit up the whole arris — which the
// sphere-sampled probe above barely grazes, because the slit shows itself
// along steep oblique sightlines into the corner. This hunt stares at every
// corner from everywhere, and it is validated against the fault it was
// written for: before dressed ends were cut flush to their stations and the
// butt seam got real cheeks, it found the see-throughs on the default mass
// that the sphere probe missed.
const cornerLayout = cloneFrontStairLayout();
const cornerRule = toMasonry(cornerLayout, DEFAULT_MASS_STONE_CONFIG);
assert.ok(cornerRule);
assert.equal(cornerRule.cornerRule, "butted", "The corner hunt must probe butted corners.");
const cornerGeometry = tessellateStructure(stairDefault, {
  masonry: cornerRule,
  seed: DEFAULT_MASS_STONE_CONFIG.seed,
}).parts[0]?.geometry;
assert.ok(cornerGeometry);
const cornerHoles = findCornerSightlines(cornerGeometry, stairDefault.masses[0]!.bands);
assert.equal(
  cornerHoles.holes,
  0,
  `${cornerHoles.holes} of ${cornerHoles.shots} corner rays see through the mass, `
  + `first at ${cornerHoles.sample}.`,
);

// Shape, on the blocks actually emitted rather than on the maths behind them.
//
// Every one of them is an upright box, so every face is exactly rectangular —
// not most of them. The surface model this replaced sampled a course's top edge
// separately from its bottom one so the face would follow the ideal rake, which
// made every stone a trapezoid; the batter now lives in where the courses sit,
// so a stone is never cut to an angle and this is exact.
// Measured with the stones set square, so the shape being checked is the stone's
// own and not the wander laid over it. Displacement is checked separately.
const shellBuilder = new SolidBuilder();
buildMassShell(shellBuilder, shellBands, {
  rule: { ...shellRule, displacement: 0 },
  seed: 1,
});
const shellFaces = readBlockFaces(shellBuilder);
assert.ok(shellBuilder.blockCount > 200, `Only ${shellBuilder.blockCount} blocks.`);
const displacedShellBuilder = new SolidBuilder();
buildMassShell(displacedShellBuilder, shellBands, {
  rule: shellRule,
  seed: 1,
});
const squareTopLevels = new Set(
  shellFaces
    .filter((face) => faceNormal(face).y > 0.99)
    .map((face) => face[0]!.y.toFixed(6)),
);
const displacedJointClosures = readBlockFaces(displacedShellBuilder).filter((face) =>
  faceNormal(face).y > 0.99
  && face.every((corner) => Math.abs(corner.y - face[0]!.y) < 1e-9)
  && !squareTopLevels.has(face[0]!.y.toFixed(6)));
assert.ok(
  displacedJointClosures.length > 20,
  `Only ${displacedJointClosures.length} inset bed faces close displaced joints.`,
);

// The mass is made of blocks and of nothing else — every triangle in it belongs
// to a block face. This is the one that keeps it that way: a loft, a cap or a
// ring slipped back in alongside the blocks would carry its own winding rule and
// its own idea of shading, and the seams between the two kinds of geometry are
// what every fault in this layer has come from.
assert.equal(
  shellBuilder.blockFaces.length * 6,
  shellBuilder.indices.length,
  `${shellBuilder.indices.length / 6 - shellBuilder.blockFaces.length} faces of the `
  + "shell are not part of a block.",
);

// And the greybox, which is the same blocks simply not divided into courses.
// Turning stonework off must subdivide the mass less, not draw it with something
// else — that is what makes the two comparable at all.
const greybox = tessellateStructure(shellGraph, { masonry: null, seed: 1 });
assert.equal(
  greybox.parts[0]?.geometry.getIndex()?.count,
  greybox.faceCount * 6,
  "The greybox draws something that is not a block.",
);
assert.ok(
  (greybox.parts[0]?.stoneCount ?? 0) > 0,
  "The greybox must report the blocks it is made of.",
);
assert.equal(
  findCoincidentFaces(greybox.parts[0]!.geometry).pairs,
  0,
  "The greybox has two faces at the same depth.",
);
const greyboxPositions = greybox.parts[0]!.geometry.getAttribute("position");
const greyboxNormals = greybox.parts[0]!.geometry.getAttribute("normal");
const groundY = Math.min(...shellBands.map((band) => band.bottomY));

for (let vertex = 0; vertex < greyboxPositions.count; vertex += 1) {
  assert.ok(
    greyboxNormals.getY(vertex) > -0.9
      || greyboxPositions.getY(vertex) > groundY + 1e-9,
    `The greybox emits a downward face buried at ground level (vertex ${vertex}).`,
  );
}

// Hidden stone is not laid. A course of a battered pyramid is a dozen rings deep
// and only the outermost two can be reached — through the joints of the one in
// front, or from the sky where the band above does not stand on them. Laying the
// rest is stone buried in stone: it doubled the mass and nothing could see it.
const culled = tessellateStructure(shellGraph, {
  masonry: shellRule,
  seed: DEFAULT_MASS_STONE_CONFIG.seed,
}).parts[0];
assert.ok(culled);
assert.ok(
  culled.stoneCount < 3200,
  `${culled.stoneCount} stones: rings nothing can reach are being laid.`,
);
assert.ok(
  findBackfaces(culled.geometry).backfaces <= 2,
  "Culling left more than an edge-on joint path into the retained shell.",
);

// Hidden faces are culled along with hidden stone. Keeping two backing rings is
// necessary to close the perpends in the ring in front, but those retained
// blocks used to emit all six sides as if they were freestanding: buried tops,
// inward walls around the sealed centre and supported cornice undersides. Since
// this builder uses four dedicated vertices per flat face, a face budget is also
// an exact vertex-buffer budget.
// The ratio sits a little above 3.6 since corner closures were added — the
// start cheek at every butted seam and the facing corner stones' inner faces —
// and well below the ~6 that re-emitting buried backing faces would produce.
assert.ok(
  shellBuilder.blockFaces.length < shellBuilder.blockCount * 3.75,
  `${shellBuilder.blockFaces.length} faces for ${shellBuilder.blockCount} retained blocks: `
  + "buried backing faces are still being emitted.",
);
assert.equal(
  shellBuilder.positions.length / 3,
  shellBuilder.blockFaces.length * 4,
  "Each retained block face must account for exactly four vertices.",
);

// A buried course still needs its facing-stone tops: they are the narrow treads
// left by the batter and the floor seen down a perpend. Its backing-ring tops
// are entirely under the course above. On a plain vertical band that distinction
// is exact: every non-crown top that remains must touch the outside wall line.
const verticalLayout: MassLayoutConfig = {
  ...SHELL_LAYOUT,
  baseTreatment: "none",
  bandCount: 1,
  totalHeight: 2,
  batterAngle: 0,
  cornicePlacement: "none",
};
const verticalGraph = generateStructure(toStructureSpec(verticalLayout));
const verticalBands = verticalGraph.masses[0]?.bands ?? [];
const verticalBand = verticalBands[0];
const verticalRule = toMasonry(verticalLayout, DEFAULT_MASS_STONE_CONFIG);
assert.ok(verticalBand && verticalRule);
const verticalBuilder = new SolidBuilder();
buildMassShell(verticalBuilder, verticalBands, {
  rule: { ...verticalRule, displacement: 0 },
  seed: 1,
});
const buriedTops = readBlockFaces(verticalBuilder).filter((face) =>
  faceNormal(face).y > 0.9 && face[0]!.y < verticalBand.topY - 1e-9);
assert.ok(buriedTops.length > 20, "The vertical-wall probe found too few buried course tops.");

for (const [index, face] of buriedTops.entries()) {
  assert.ok(
    face.some((corner) =>
      Math.abs(corner.x - verticalBand.lower.minX) < verticalRule.gap
      || Math.abs(corner.x - verticalBand.lower.maxX) < verticalRule.gap
      || Math.abs(corner.z - verticalBand.lower.minZ) < verticalRule.gap
      || Math.abs(corner.z - verticalBand.lower.maxZ) < verticalRule.gap),
    `Buried top ${index} belongs to a backing ring, not the visible facing course.`,
  );
}

// A narrow terrace may be shallower than one stone. In that case the next band
// covers the first backing ring completely; initializing the visible-ring index
// at zero used to keep that ring's top even though no part reached daylight.
const shallowTerraceLayout: MassLayoutConfig = {
  ...verticalLayout,
  bandCount: 3,
  totalHeight: 6,
  summitRatio: 0.9,
};
const shallowTerraceGraph = generateStructure(toStructureSpec(shallowTerraceLayout));
const shallowTerraceBands = shallowTerraceGraph.masses[0]?.bands ?? [];
const shallowTerraceRule = toMasonry(shallowTerraceLayout, DEFAULT_MASS_STONE_CONFIG);
const lowerTerraceBand = shallowTerraceBands[0];
const upperTerraceBand = shallowTerraceBands[1];
assert.ok(shallowTerraceRule && lowerTerraceBand && upperTerraceBand);
const shallowTerraceBuilder = new SolidBuilder();
buildMassShell(shallowTerraceBuilder, shallowTerraceBands, {
  rule: { ...shallowTerraceRule, displacement: 0 },
  seed: 1,
});
const shallowTerraceTops = readBlockFaces(shallowTerraceBuilder).filter((face) =>
  faceNormal(face).y > 0.9 && Math.abs(face[0]!.y - lowerTerraceBand.topY) < 1e-9);
assert.ok(shallowTerraceTops.length > 20, "The shallow-terrace probe found too few top faces.");

for (const [index, face] of shallowTerraceTops.entries()) {
  assert.ok(
    face.some((corner) =>
      corner.x < upperTerraceBand.lower.minX - 1e-9
      || corner.x > upperTerraceBand.lower.maxX + 1e-9
      || corner.z < upperTerraceBand.lower.minZ - 1e-9
      || corner.z > upperTerraceBand.lower.maxZ + 1e-9),
    `Shallow terrace top ${index} is entirely hidden by the band above.`,
  );
}

// The first cornice course reaches out past its supporting wall and its bottom
// is the visible soffit. The backing rings begin inside that support, so any
// downward face contained by the springing rectangle is wholly buried.
const soffits = shellFaces.filter((face) => faceNormal(face).y < -0.9);
assert.ok(soffits.length > 20, "The cornice probe found too few soffit faces.");

for (const [index, face] of soffits.entries()) {
  const cornice = shellBands
    .map((band) => band.cornice)
    .find((candidate) =>
      candidate !== null && Math.abs(candidate.bottomY - face[0]!.y) < 1e-9);
  assert.ok(cornice, `Soffit ${index} does not belong to a cornice.`);
  assert.ok(
    face.some((corner) =>
      corner.x < cornice.springing.minX - 1e-9
      || corner.x > cornice.springing.maxX + 1e-9
      || corner.z < cornice.springing.minZ - 1e-9
      || corner.z > cornice.springing.maxZ + 1e-9),
    `Soffit ${index} is entirely hidden by its supporting wall.`,
  );
}

// The rake belongs to the two blocks it passes through, not to all of them.
// Sharing it out — sampling both edges at the same fraction of their own length —
// leaves every block on the wall slightly sheared and almost none of them square,
// so counting the exactly-square ones is what separates the two.
for (const [index, face] of shellFaces.entries()) {
  assert.ok(
    Math.abs(face[0]!.distanceTo(face[1]!) - face[3]!.distanceTo(face[2]!)) < 1e-9,
    `Block face ${index} is not rectangular.`,
  );

  for (let corner = 0; corner < 4; corner += 1) {
    const here = face[(corner + 1) % 4]!.clone().sub(face[corner]!).normalize();
    const next = face[(corner + 2) % 4]!.clone().sub(face[(corner + 1) % 4]!).normalize();
    assert.ok(
      Math.abs(here.dot(next)) < 1e-9,
      `Block face ${index} corner ${corner} is not square.`,
    );
  }

  // And axis-aligned: a face that leaned would mean a stone had been cut to the
  // batter instead of the courses stepping in under it.
  const normal = faceNormal(face);
  assert.ok(
    [normal.x, normal.y, normal.z].filter((axis) => Math.abs(axis) > 1e-9).length === 1,
    `Block face ${index} is not axis-aligned: ${normal.toArray().map((v) => v.toFixed(3)).join(",")}.`,
  );
}

// Blocks reach INTO the mass: their faces lie on the surface the graph declares
// and their backs run a bed depth behind it. A facing raised outward would push
// every extent out by its own thickness, which is what the extents check below
// would catch, and a facing with no depth would leave nothing for a joint to
// look into.
// Measured against the whole mass's outermost face, which is the plinth's — not
// against one band's, since the shell builds the entire stack at once.
const shellFront = Math.max(...shellBands.map((band) => Math.max(
  band.lower.maxZ,
  band.upper.maxZ,
  band.cornice?.outline.maxZ ?? -Infinity,
)));
const shellZs: number[] = [];

for (let index = 0; index < shellBuilder.positions.length; index += 3) {
  shellZs.push(shellBuilder.positions[index + 2] ?? 0);
}

// These stones are deliberately set square. Their joint inset may pull an arris
// just inside the declared line, but none may sit beyond it.
assert.ok(
  shellZs.every((z) => z <= shellFront + 1e-9),
  "Square-set geometry may not sit beyond the declared surface.",
);
assert.ok(
  shellZs.some((z) => Math.abs(z - shellFront) < shellRule.gap),
  "Block faces must lie on the surface.",
);
assert.ok(
  shellZs.some((z) =>
    Math.abs(z - (shellFront - shellRule.depth)) < shellRule.gap),
  `Blocks must reach a joint inset of ${shellRule.depth}m back into the wall, not sit on it.`,
);

// Displacement means here exactly what it means on the Circular plate: the
// shortest plan edge sets the movement scale, independently of the joint gap.
// Without it every stone in a course is an identical box and the course reads
// as a scored panel.
function frontCorners(displacement: number): THREE.Vector3[][] {
  const layout = { ...SHELL_LAYOUT, cornicePlacement: "none" as const };
  const stone = { ...DEFAULT_MASS_STONE_CONFIG, displacement };
  const graph = generateStructure(toStructureSpec(layout));
  const bands = graph.masses[0]?.bands ?? [];
  const band = bands.find((entry) => entry.index === 0);
  const rule = toMasonry(layout, stone);
  assert.ok(band && rule);
  const builder = new SolidBuilder();
  buildMassShell(builder, bands, { rule, seed: stone.seed });

  return readBlockFaces(builder).filter((face) =>
    faceNormal(face).z > 0.9
    && Math.abs(face[0]!.y - band.bottomY) < 0.01
    && band.lower.maxZ - face[0]!.z < 0.5);
}

const stillRule = toMasonry(SHELL_LAYOUT, DEFAULT_MASS_STONE_CONFIG);
assert.ok(stillRule);
const still = frontCorners(0);
assert.ok(still.length > 8, `Only ${still.length} stones across the front of a course.`);
assert.deepEqual(
  still.map((face) => face.map((corner) => corner.toArray())),
  frontCorners(0).map((face) => face.map((corner) => corner.toArray())),
  "Turning displacement off must be deterministic.",
);

// A simple 2 × 1 cell proves the amount is driven by its 1m shortest edge and
// is not suppressed by a narrow joint.
const sampleCell = [
  { x: 0, z: 0 },
  { x: 2, z: 0 },
  { x: 2, z: 1 },
  { x: 0, z: 1 },
];
const sampleStill = insetAndJitter(sampleCell, 0.02, 0, () => 0.5);
const sampleSequence = [1, 0, 1, 0, 1, 0, 1, 0];
let sampleDraw = 0;
const sampleMoved = insetAndJitter(
  sampleCell,
  0.02,
  0.12,
  () => sampleSequence[sampleDraw++] ?? 0.5,
);
for (let index = 0; index < sampleMoved.length; index += 1) {
  assert.ok(
    Math.abs((sampleMoved[index]?.x ?? 0) - (sampleStill[index]?.x ?? 0) - 0.12) < 1e-9,
    "Displacement must move X by shortest edge × control value.",
  );
  assert.ok(
    Math.abs((sampleMoved[index]?.z ?? 0) - (sampleStill[index]?.z ?? 0) + 0.12) < 1e-9,
    "Displacement must move Z by shortest edge × control value.",
  );
}
assert.ok(
  0.12 > 0.02 * 0.65,
  "The regression cell must exercise movement beyond the former gap cap.",
);

const movementByDisplacement: number[] = [];
const verticalMovementByDisplacement: number[] = [];
for (const displacement of [0.03, 0.2]) {
  const wandered = frontCorners(displacement);
  assert.equal(wandered.length, still.length, "Displacement must not change the coursing.");

  const xOffsets: number[] = [];
  const yOffsets: number[] = [];
  const zOffsets: number[] = [];
  for (let face = 0; face < wandered.length; face += 1) {
    for (let corner = 0; corner < (wandered[face]?.length ?? 0); corner += 1) {
      xOffsets.push(
        (wandered[face]?.[corner]?.x ?? 0) - (still[face]?.[corner]?.x ?? 0),
      );
      yOffsets.push(
        (wandered[face]?.[corner]?.y ?? 0) - (still[face]?.[corner]?.y ?? 0),
      );
      zOffsets.push(
        (wandered[face]?.[corner]?.z ?? 0) - (still[face]?.[corner]?.z ?? 0),
      );
    }
  }
  const offsets = [...xOffsets, ...zOffsets];
  const moved = Math.max(...offsets.map(Math.abs));
  movementByDisplacement.push(moved);
  const circularBound = displacementDistance(stillRule.depth, displacement);
  const verticalMoved = Math.max(...yOffsets.map(Math.abs));
  verticalMovementByDisplacement.push(verticalMoved);
  assert.ok(
    moved <= circularBound + 1e-9,
    `A corner moved ${moved.toFixed(4)}m, past the Circular-style `
    + `${circularBound.toFixed(4)}m cell-scale bound.`,
  );
  assert.ok(
    moved > 0,
    `At ${displacement} displacement no corner moved at all.`,
  );
  assert.ok(
    Math.min(...zOffsets) < 0 && Math.max(...zOffsets) > 0,
    "Corners wander only one way, so the course still reads as a plane.",
  );
  assert.ok(
    verticalMoved > circularBound * 0.5
      && verticalMoved <= circularBound + 1e-9,
    `Y displacement ${verticalMoved.toFixed(4)}m must follow the `
    + `${circularBound.toFixed(4)}m cell-scale bound.`,
  );
  assert.ok(
    Math.min(...yOffsets) >= -1e-9,
    "A supported course moved down and opened a crack beneath the next course.",
  );
}
assert.ok(
  (movementByDisplacement[1] ?? 0) > (movementByDisplacement[0] ?? 0) * 5,
  "The Mass displacement control must scale visibly instead of flattening at the gap cap.",
);
assert.ok(
  (movementByDisplacement[1] ?? 0) > stillRule.gap * 0.65,
  "Mass displacement is still being capped by the joint gap.",
);
assert.ok(
  (verticalMovementByDisplacement[1] ?? 0)
    > (verticalMovementByDisplacement[0] ?? 0) * 5,
  "Mass Y displacement must scale with the control instead of remaining flat.",
);

// Terraces are the top of the courses, not a floor laid on them. So every
// upward face in the mass sits at the top of some course, and there is no plane
// between courses that a separate paving pass would have introduced.
const courseTops = new Set(
  shellFaces
    .filter((face) => faceNormal(face).y > 0.99)
    .map((face) => face[0]!.y.toFixed(4)),
);
const allTops = new Set(
  shellFaces.flat().map((corner) => corner.y.toFixed(4)),
);
for (const level of courseTops) {
  assert.ok(allTops.has(level), `A floor sits at ${level}, off every course.`);
}
assert.ok(courseTops.size > 3, `Only ${courseTops.size} distinct course tops.`);

// --- tessellation ----------------------------------------------------------
// The geometry has to agree with the graph it came from. A tessellator that
// drifts is otherwise only visible as something looking slightly wrong.
const pyramid = graphs.get("stepped-pyramid");
assert.ok(pyramid);

const tessellated = tessellateStructure(pyramid);
assert.equal(tessellated.parts.length, 1);
assert.equal(tessellated.parts[0]?.section, MASS_SECTION);

const merged = mergeParts(tessellated.parts, [MASS_SECTION]);
const extents = graphExtents(pyramid);
const box = merged.geometry.boundingBox;
assert.ok(extents && box);
for (const axis of ["x", "y", "z"] as const) {
  // Positions are Float32, so the comparison is against single-precision
  // rounding of the graph's doubles, not against an exact match.
  const tolerance = (value: number) => Math.max(1e-5, Math.abs(value) * 1e-6);

  assert.ok(
    Math.abs(box.min[axis] - extents.min[axis]) < tolerance(extents.min[axis]),
    `Merged geometry min.${axis} disagrees with the graph.`,
  );
  assert.ok(
    Math.abs(box.max[axis] - extents.max[axis]) < tolerance(extents.max[axis]),
    `Merged geometry max.${axis} disagrees with the graph.`,
  );
}
assertMassNormals(merged.geometry, "stepped pyramid", pyramid);
assert.deepEqual(
  merged.geometry.groups.map((group) => group.materialIndex),
  [
    materialSlotIndex("stone"),
    materialSlotIndex("stairs"),
    materialSlotIndex("parapet"),
  ],
);
assert.equal(
  merged.geometry.groups.reduce((sum, group) => sum + group.count, 0),
  merged.geometry.getIndex()?.count,
);
assert.equal(merged.sections[MASS_SECTION]?.partCount, 1);

// --- structure definition --------------------------------------------------
// Building through the definition is the path the composer actually takes.
const layoutOnly = massStructure.build({
  layout: massStructure.cloneLayout(),
  stone: DEFAULT_MASS_STONE_CONFIG,
  bevel: undefined as never,
  pillar: undefined as never,
  fireBowl: DEFAULT_FIRE_BOWL_CONFIG,
  sections: new Set([MASS_SECTION]),
});
assert.equal(layoutOnly.parts.length, 1);
assert.ok(layoutOnly.graph, "The mass structure must report its graph.");
// Twelve, not sixteen. The four summit terminals that collide are merged into
// four piers, and a pier carries one bowl — but each still gets its own glow,
// so the light count is unchanged by the merge.
assert.equal(layoutOnly.anchors.flames.length, 12);
assert.equal(layoutOnly.anchors.glows.length, 8);
assert.equal(layoutOnly.anchors.offering, null);

const buildWithStairTiles = (stairTilesPerStep: number) => massStructure.build({
  layout: { ...massStructure.cloneLayout(), stairTilesPerStep },
  stone: DEFAULT_MASS_STONE_CONFIG,
  bevel: undefined as never,
  pillar: undefined as never,
  fireBowl: DEFAULT_FIRE_BOWL_CONFIG,
  sections: new Set([MASS_SECTION]),
});
const sparseStairTiles = buildWithStairTiles(2);
const denseStairTiles = buildWithStairTiles(8);
const triangleCount = (result: typeof sparseStairTiles) =>
  result.parts.reduce(
    (total, part) => total + (part.geometry.getIndex()?.count ?? 0) / 3,
    0,
  );
assert.ok(
  triangleCount(denseStairTiles) > triangleCount(sparseStairTiles),
  "The tiles-per-step control did not reach the structure build.",
);
assert.equal(
  serializeGraph(denseStairTiles.graph!),
  serializeGraph(sparseStairTiles.graph!),
  "Changing tread tiles moved semantic stair geometry.",
);

// The graph is resolved even when no section was requested, because the scene
// needs the semantic layer for the overlay whether or not geometry moved.
const graphOnly = massStructure.build({
  layout: massStructure.cloneLayout(),
  stone: DEFAULT_MASS_STONE_CONFIG,
  bevel: undefined as never,
  pillar: undefined as never,
  fireBowl: DEFAULT_FIRE_BOWL_CONFIG,
  sections: new Set<string>(),
});
assert.equal(graphOnly.parts.length, 0);
assert.ok(graphOnly.graph);

// --- debug overlay ---------------------------------------------------------
// Drawn from patch frames rather than from the mesh, so it stays an independent
// reading of the semantic layer.
const overlay = createPatchOverlay(pyramid);
const overlayPositions = overlay.object.geometry.getAttribute("position");
assert.ok(overlayPositions.count > 0);
assert.equal(
  overlayPositions.count % 2,
  0,
  "Line segments come in pairs.",
);
assert.equal(
  overlay.object.geometry.getAttribute("color").count,
  overlayPositions.count,
);
overlay.dispose();


// --- engraving slots -------------------------------------------------------
// The contract is that a published slot is a face you can actually engrave.
// That means three things at once, and each of them has been wrong at least
// once: the slot must sit on stone the structure really draws, the stretch
// carrying it must lose its coursing so there is a plane there at all, and
// nothing else about the build may move because a slot was published.
const ENGRAVED_CASES: readonly {
  readonly label: string;
  readonly layout: MassLayoutConfig;
}[] = [
  { label: "engraved default", layout: { ...DEFAULT_MASS_LAYOUT } },
  {
    label: "engraved plumb",
    // `findBuriedFaces` skips a face that is not axis-aligned, so a battered
    // mass alone would let a buried prepared face through unnoticed.
    layout: { ...DEFAULT_MASS_LAYOUT, batterAngle: 0 },
  },
  {
    // The summit's walls only became engravable under this grammar once the
    // facade stopped sinking its own panels into them, and the fields it
    // publishes are shaped by the framing rather than by the wall: carved
    // around the pilasters, stopped under the frieze, and on the side wall
    // stopped under the window's sill. Every one of those is a chance to
    // publish a field no panel contains, so the whole battery runs on it.
    label: "engraved hierarchical",
    layout: { ...DEFAULT_MASS_LAYOUT, facadeStyle: "hierarchical" as const },
  },
  {
    label: "engraved corniced",
    layout: {
      ...cloneFrontStairLayout(),
      bandCount: 5,
      totalHeight: 11,
      batterAngle: 10,
      cornicePlacement: "all",
      corniceProjection: 0.25,
      corniceHeight: 0.3,
      stoneworkEnabled: true,
    },
  },
];

for (const { label, layout } of ENGRAVED_CASES) {
  const squareSet = { ...DEFAULT_MASS_STONE_CONFIG, displacement: 0 };
  const bare = generateStructure(toStructureSpec(layout));
  assert.equal(allSlots(bare).length, 0, `${label}: slots are not inert when off.`);

  for (const [name, ids] of [
    ["elevations", MASS_ELEVATION_SLOTS],
    ["all", ALL_MASS_SLOTS],
  ] as const) {
    const engravedLayout = withMassSlots(layout, ...ids);
    const graph = generateStructure(toStructureSpec(engravedLayout));
    const scope = `${label} (${name})`;
    assertGraphInvariants(graph, scope);
    assertSlotInvariants(graph, scope);
    assert.ok(allSlots(graph).length > 0, `${scope}: prepared nothing.`);

    const geometry = mergeParts(tessellateStructure(graph, {
      masonry: toMasonry(engravedLayout, squareSet),
      seed: engravedLayout.seed,
      stairTilesPerStep: engravedLayout.stairTilesPerStep,
    }).parts, [MASS_SECTION]).geometry;
    assert.equal(
      findCoincidentFaces(geometry).pairs,
      findCoincidentFaces(mergeParts(tessellateStructure(
        generateStructure(toStructureSpec(layout)),
        {
          masonry: toMasonry(layout, squareSet),
          seed: layout.seed,
          stairTilesPerStep: layout.stairTilesPerStep,
        },
      ).parts, [MASS_SECTION]).geometry).pairs,
      `${scope}: preparing a face introduced coincident faces.`,
    );
    /**
     * A field that has left the elevation holds the same bargain a flat one
     * does: it introduces no coincident faces and it leaves no hole.
     *
     * Both halves were earned rather than assumed. A pocket is a *void*, so its
     * jambs face into it — a solid box built by `addBlock` has them facing out,
     * which read as fifteen holes in a backface sweep until every surface was
     * wound by hand. And the closures duplicated their neighbours three
     * different ways: at an arris, where the next elevation is prepared to the
     * same depth; at a corner, where two sills claim the same square of stone;
     * and at the top or bottom of a stretch, where the band beyond carries on.
     * Each is suppressed rather than tolerated, so this compares exactly.
     */
    for (const relief of [-0.08, 0.08]) {
      const shaped = mergeParts(tessellateStructure(
        generateStructure(toStructureSpec(
          withMassRelief(layout, relief, ...ids),
        )),
        {
          masonry: toMasonry(engravedLayout, squareSet),
          seed: engravedLayout.seed,
          stairTilesPerStep: engravedLayout.stairTilesPerStep,
        },
      ).parts, [MASS_SECTION]).geometry;
      const how = relief < 0 ? "sunk" : "raised";

      assert.equal(
        findCoincidentFaces(shaped).pairs,
        findCoincidentFaces(geometry).pairs,
        `${scope}: a ${how} face introduced coincident faces.`,
      );
      assert.equal(
        findBackfaces(shaped, 48).backfaces,
        0,
        `${scope}: a ${how} face left a hole.`,
      );
      assert.ok(
        shaped.getAttribute("position").count
          > geometry.getAttribute("position").count,
        `${scope}: a ${how} face drew no returns, so it did not move at all.`,
      );
      shaped.dispose();
    }

    assert.equal(
      findBackfaces(geometry, 48).backfaces,
      0,
      `${scope}: a prepared face left a hole.`,
    );

    // The load-bearing one. A slot nobody can paint is a slot that does not
    // describe the geometry, which is the failure this whole feature exists to
    // avoid — so every published slot must own exactly one face, no more.
    const tinted = mergeParts(tessellateStructure(graph, {
      masonry: toMasonry(engravedLayout, squareSet),
      seed: engravedLayout.seed,
      stairTilesPerStep: engravedLayout.stairTilesPerStep,
      debugSlots: true,
    }).parts, [MASS_SECTION]).geometry;
    assert.equal(
      tinted.getAttribute("position").count,
      geometry.getAttribute("position").count,
      `${scope}: tinting slots changed the vertex count.`,
    );
    assert.equal(
      tinted.getIndex()?.count,
      geometry.getIndex()?.count,
      `${scope}: tinting slots changed the triangle count.`,
    );
    assert.equal(
      tinted.groups
        .filter((group) => group.materialIndex === materialSlotIndex("slotDebug"))
        .reduce((total, group) => total + group.count / 6, 0),
      allSlots(graph).length,
      `${scope}: published slots and prepared faces disagree.`,
    );
  }
}


// A field's vertical edges must obey one of exactly two rules: an edge the face
// gave it follows the stone's own arris, and an edge a stair cut is plumb. Both
// were wrong before — the drawn field used the inscribed rectangle, so every
// edge leaned the same way and neither rule held. Run across the batter range,
// because at zero the two rules coincide and prove nothing, and above about 30°
// the old border quad crossed itself.
for (const batterAngle of [0, 12, 25, 35]) {
  const layout = withMassSlots(
    { ...cloneFrontStairLayout(), batterAngle },
    ...ALL_MASS_SLOTS,
  );
  const graph = generateStructure(toStructureSpec(layout));
  const patches = patchIndex(graph);
  const bands = graph.masses[0]!.bands;
  const scope = `engraved batter ${batterAngle}`;
  let plumbEdges = 0;
  let rakedEdges = 0;

  for (const slot of graph.masses[0]!.slots) {
    if (!slot.tags.includes("wall") || slot.face === "top" || slot.face === "bottom") {
      continue;
    }

    const band = bands.find((candidate) => candidate.id === slot.bandId);
    const patch = patches.get(slot.patchId);

    if (!band || !patch) {
      continue;
    }

    const edgeLength = (rect: typeof band.lower) => {
      const edge = rectEdge(rect, slot.face as HorizontalOrientation);
      return Math.hypot(edge.end.x - edge.start.x, edge.end.z - edge.start.z);
    };
    const widthBottom = edgeLength(band.lower);
    const taper = edgeLength(band.upper) / widthBottom;
    const frame = graph.masses[0]!.frames.find(
      (candidate) => candidate.id === slot.frameId,
    );
    // The border is authored in metres, so it shifts an edge sideways without
    // changing how it leans. Undo it to recover the edge's own fraction.
    const shift = frame
      ? (frame.insetU + frame.borderWidth) / widthBottom
      : 0;
    const [bottomLeft, bottomRight, topRight, topLeft] = slot.boundary;
    const vSpan = topLeft!.v - bottomLeft!.v;

    for (const [low, high, inward] of [
      [bottomLeft!, topLeft!, -1],
      [bottomRight!, topRight!, 1],
    ] as const) {
      const slope = vSpan <= 1e-9 ? 0 : (high.u - low.u) / vSpan;
      const fraction = low.u - slope * low.v + inward * shift;
      const raked = Math.abs(slope - fraction * (taper - 1));
      const plumb = Math.abs(slope + (1 - taper) / 2);

      assert.ok(
        Math.min(raked, plumb) < 1e-9,
        `${scope}: slot "${slot.id}" has an edge that neither follows the arris nor stands plumb.`,
      );

      if (plumb < raked) {
        plumbEdges += 1;
      } else {
        rakedEdges += 1;
      }
    }
  }

  assert.ok(rakedEdges > 0, `${scope}: no field edge followed the stone.`);
  // On a plumb wall the two rules are the same line, so there is nothing to
  // tell apart. The distinction only has to hold where the wall leans.
  if (batterAngle > 0) {
    assert.ok(
      plumbEdges > 0,
      `${scope}: a stair crosses every elevation, so some edge must be plumb.`,
    );
  }

  // The bowtie: above about 30° the old trailing border quad crossed itself and
  // nothing noticed, because the suite stopped at 12.
  const geometry = mergeParts(tessellateStructure(graph, {
    masonry: toMasonry(layout, { ...DEFAULT_MASS_STONE_CONFIG, displacement: 0 }),
    seed: layout.seed,
    stairTilesPerStep: layout.stairTilesPerStep,
    debugSlots: true,
  }).parts, [MASS_SECTION]).geometry;
  assert.equal(
    findBackfaces(geometry, 48).backfaces,
    0,
    `${scope}: a prepared face left a hole.`,
  );
  assert.equal(
    geometry.groups
      .filter((group) => group.materialIndex === materialSlotIndex("slotDebug"))
      .reduce((total, group) => total + group.count / 6, 0),
    allSlots(graph).length,
    `${scope}: published slots and prepared faces disagree.`,
  );
}


// Slot bands interleave engraved strips with set stone on one elevation. The
// two have to meet cleanly: an interior run's top course keeps the outline of
// its own bed, so it stands proud of the strip above it and that ledge is real
// stone, while the last run is the stretch's own top and shows whatever the
// stretch showed. Getting the second wrong drew a full crown under every
// moulding.
//
// A prepared elevation also has to work with the stonework off. It is already a
// plane there, so nothing is gated — but the field still needs edges of its own
// or the border it was measured with is a number no face answers to.
{
  const bandedLayouts: readonly (readonly [string, MassLayoutConfig])[] = [
    ["plain", {
      ...cloneFrontStairLayout(),
      bandCount: 3,
      totalHeight: 8,
      cornicePlacement: "none",
      summitBuildingEnabled: false,
      summitTreatment: "open_floor",
      stairFrontEnabled: false,
    }],
    // Cornices, stairs and a summit building: the combinations that made the
    // clean case pass while the real one z-fought.
    ["dressed", { ...DEFAULT_MASS_LAYOUT }],
  ];

  for (const [shape, base] of bandedLayouts) {
    for (const stoneworkEnabled of [true, false]) {
      for (const bands of [0, 1, 2, 4]) {
        const layout = withMassSlots(
          { ...base, slotBands: bands, stoneworkEnabled },
          "bandWall",
        );
        const scope = `slot bands ${bands}, ${shape}, stonework ${stoneworkEnabled ? "on" : "off"}`;
        const stone = { ...DEFAULT_MASS_STONE_CONFIG, displacement: 0 };
        const build = (source: MassLayoutConfig) => mergeParts(
          tessellateStructure(generateStructure(toStructureSpec(source)), {
            masonry: toMasonry(source, stone),
            seed: source.seed,
            stairTilesPerStep: source.stairTilesPerStep,
            debugSlots: true,
          }).parts,
          [MASS_SECTION],
        ).geometry;
        const graph = generateStructure(toStructureSpec(layout));
        const geometry = build(layout);

        // Against the same layout with nothing prepared, so a shape that
        // already z-fights cannot hide a new pair.
        assert.equal(
          findCoincidentFaces(geometry).pairs,
          findCoincidentFaces(build({ ...base, stoneworkEnabled })).pairs,
          `${scope}: preparing the elevation introduced coincident faces.`,
        );
        // A banded elevation gains a ledge at every seam, and the ray sampler
        // grazes those edge-on; a real gap lets rays in from every direction.
        assert.ok(
          findBackfaces(geometry, 48).backfaces <= 1,
          `${scope}: the strip and run seam left a hole.`,
        );
        assert.equal(
          geometry.groups
            .filter((group) => group.materialIndex === materialSlotIndex("slotDebug"))
            .reduce((total, group) => total + group.count / 6, 0),
          allSlots(graph).length,
          `${scope}: published slots and prepared faces disagree.`,
        );

        // Zero bands is one field over the whole elevation; more divides it.
        // Counted as distinct courses of field rather than as slots, because a
        // stair splits each one horizontally as well.
        const expected = bands === 0 ? 1 : bands;
        const rowsPerFace = new Map<string, Set<string>>();
        for (const slot of graph.masses[0]!.slots) {
          const rows = rowsPerFace.get(slot.patchId) ?? new Set<string>();
          rowsPerFace.set(slot.patchId, rows);
          rows.add(slot.inscribed.vMin.toFixed(6));
        }
        const carried = [...rowsPerFace.values()].map((rows) => rows.size);
        // No elevation carries more than was asked for; at least one carries
        // exactly that. A strip too small to hold anything is simply not
        // published, and on a narrow crown band under a stair that is the
        // right answer rather than a failure.
        assert.ok(
          carried.every((count) => count <= expected),
          `${scope}: an elevation carried more than ${expected} strip(s).`,
        );
        assert.ok(
          carried.some((count) => count === expected),
          `${scope}: no elevation carried ${expected} strip(s).`,
        );
      }
    }
  }
}

// The summit building's entries. A wall with a doorway is still an elevation:
// the stone either side of it takes a field, and the wall above the head is a
// panel of its own that deliberately takes none.
//
// A hierarchical facade used to take no field at all, on the grounds that the
// grammar owned the composition — and while that grammar sank its own recessed
// panel into each bay, it did. It no longer does, so the same two fields per
// elevation come back, narrower by the pilasters flanking the entrance and
// stopped under the frieze rather than at the parapet. The pilasters divide the
// wall exactly where the doorway already did, which is why the count matches
// the plain case instead of exceeding it.
//
// `sidePositiveU` takes one, not two. It is the wall that gets the secondary
// window, and a window is anchored to neither the floor nor the parapet, so it
// splits the wall in both axes at once. The stone left hard against it is a
// jamb rather than a field and is dropped; the stone further along the wall is
// untouched by the opening and is a field like any other.
for (const [label, overrides, expected] of [
  ["every approach", {}, { front: 2, rear: 2, sidePositiveU: 2, sideNegativeU: 2 }],
  [
    "one approach",
    { stairRearEnabled: false, stairLeftEnabled: false, stairRightEnabled: false },
    { front: 2, rear: 1, sidePositiveU: 1, sideNegativeU: 1 },
  ],
  [
    "hierarchical facade",
    { facadeStyle: "hierarchical" as const },
    { front: 2, rear: 2, sidePositiveU: 1, sideNegativeU: 2 },
  ],
] as const) {
  const layout = withMassSlots(
    { ...DEFAULT_MASS_LAYOUT, ...overrides },
    "summitWall",
  );
  const graph = generateStructure(toStructureSpec(layout));
  const cell = graph.cells[0];
  const scope = `summit walls, ${label}`;
  assert.ok(cell, `${scope}: no summit building resolved.`);

  const perWall = new Map<string, number>();
  for (const slot of cell!.slots) {
    perWall.set(slot.face, (perWall.get(slot.face) ?? 0) + 1);
  }
  assert.deepEqual(
    Object.fromEntries([...perWall].sort()),
    Object.fromEntries(Object.entries(expected).sort()),
    `${scope}: wrong number of fields per elevation.`,
  );

  const geometry = mergeParts(tessellateStructure(graph, {
    masonry: toMasonry(layout, { ...DEFAULT_MASS_STONE_CONFIG, displacement: 0 }),
    seed: layout.seed,
    stairTilesPerStep: layout.stairTilesPerStep,
    debugSlots: true,
  }).parts, [MASS_SECTION]).geometry;
  assert.equal(
    geometry.groups
      .filter((group) => group.materialIndex === materialSlotIndex("slotDebug"))
      .reduce((total, group) => total + group.count / 6, 0),
    cell!.slots.length,
    `${scope}: published slots and prepared faces disagree.`,
  );
}

// Preparing one band must not reach the bands above it. The bond belongs to the
// whole stack, so a stretch drawn flat still has to spend the courses it would
// have laid — otherwise ticking a checkbox reshuffles every quoin over it.
{
  const bondLayout: MassLayoutConfig = {
    ...cloneFrontStairLayout(),
    bandCount: 4,
    totalHeight: 8,
    batterAngle: 0,
    cornerRule: "alternating_interlock",
    stoneworkEnabled: true,
    summitBuildingEnabled: false,
    summitTreatment: "open_floor",
    stairFrontEnabled: false,
    stairRearEnabled: false,
    stairLeftEnabled: false,
    stairRightEnabled: false,
  };
  const plain = generateStructure(toStructureSpec(bondLayout));
  const prepared = generateStructure(toStructureSpec(
    withMassSlots(bondLayout, ...MASS_ELEVATION_SLOTS),
  ));
  const lowest = prepared.masses[0]!.bands[0]!;
  // Only the lowest band is prepared, so everything above it must be laid
  // exactly as it was — same stones, same corners, same elevations.
  const lowestOnly: StructureGraph = {
    ...prepared,
    masses: [{
      ...prepared.masses[0]!,
      slots: prepared.masses[0]!.slots.filter(
        (slot) => slot.bandId === lowest.id,
      ),
    }],
  };
  assert.ok(
    lowestOnly.masses[0]!.slots.length > 0,
    "The bond test prepared nothing.",
  );
  const above = (graph: StructureGraph) => {
    const position = mergeParts(tessellateStructure(graph, {
      masonry: toMasonry(bondLayout, {
        ...DEFAULT_MASS_STONE_CONFIG,
        displacement: 0,
      }),
      seed: bondLayout.seed,
      stairTilesPerStep: bondLayout.stairTilesPerStep,
    }).parts, [MASS_SECTION]).geometry.getAttribute("position");
    const points: string[] = [];
    for (let index = 0; index < position.count; index += 1) {
      if (position.getY(index) > lowest.topY + 1e-6) {
        points.push([
          position.getX(index),
          position.getY(index),
          position.getZ(index),
        ].map((value) => value.toFixed(6)).join(","));
      }
    }
    return points.sort().join("|");
  };
  const untouched = above(plain);
  assert.ok(untouched.length > 0, "The bond test compared no stonework.");
  assert.equal(
    above(lowestOnly),
    untouched,
    "Preparing the lowest band moved the stonework above it.",
  );
}

// A prepared band is one plane per elevation, not a course of stone ends. The
// face count is the cheap proof that the gate actually fired.
{
  const gateLayout: MassLayoutConfig = {
    ...cloneFrontStairLayout(),
    bandCount: 2,
    totalHeight: 5,
    batterAngle: 0,
    stoneworkEnabled: true,
    stairFrontEnabled: false,
    summitBuildingEnabled: false,
    summitTreatment: "open_floor",
  };
  const faceCount = (ids: readonly MassSlotFeatureId[]) => tessellateStructure(
    generateStructure(toStructureSpec(withMassSlots(gateLayout, ...ids))),
    {
      masonry: toMasonry(gateLayout, DEFAULT_MASS_STONE_CONFIG),
      seed: gateLayout.seed,
      stairTilesPerStep: gateLayout.stairTilesPerStep,
    },
  ).faceCount;
  assert.ok(
    faceCount(MASS_ELEVATION_SLOTS) < faceCount([]) / 2,
    "Preparing every elevation did not take the coursing off them.",
  );
}

// The Pillar Hall needs no gate — nothing in it was ever coursed — so what is
// checked is that publishing patches for the first time left the mesh alone and
// that every field is a face.
for (const archetype of PILLAR_HALL_ARCHETYPES) {
  for (const [name, ids] of [
    ["elevations", HALL_ELEVATION_SLOTS],
    ["all", ALL_HALL_SLOTS],
  ] as const) {
    const layout = withHallSlots(
      clonePillarHallLayout(PILLAR_HALL_PRESETS[archetype]),
      ...ids,
    );
    const graph = resolvePillarHallGraph(layout);
    const scope = `engraved ${archetype} (${name})`;
    assertGraphInvariants(graph, scope);
    assertSlotInvariants(graph, scope);
    assert.ok(graph.pillarHalls[0]!.slots.length > 0, `${scope}: prepared nothing.`);

    const hallOnly = { ...graph, masses: [], connectors: [] };
    const options = {
      masonry: toPillarHallMasonry(layout, {
        ...DEFAULT_PILLAR_HALL_STONE_CONFIG,
        displacement: 0,
      }),
      seed: 109,
      stairTilesPerStep: layout.stairTilesPerStep,
    };
    const geometry = mergeParts(
      tessellateStructure(hallOnly, options).parts,
      [MASS_SECTION],
    ).geometry;
    assert.equal(findCoincidentFaces(geometry).pairs, 0, `${scope}: coincident faces.`);
    assert.equal(findBuriedFaces(geometry).faces, 0, `${scope}: buried faces.`);
    assert.equal(findBackfaces(geometry, 48).backfaces, 0, `${scope}: backfaces.`);

    const tinted = mergeParts(
      tessellateStructure(hallOnly, { ...options, debugSlots: true }).parts,
      [MASS_SECTION],
    ).geometry;
    assert.equal(
      tinted.getIndex()?.count,
      geometry.getIndex()?.count,
      `${scope}: tinting slots changed the triangle count.`,
    );
    assert.equal(
      tinted.groups
        .filter((group) => group.materialIndex === materialSlotIndex("slotDebug"))
        .reduce((total, group) => total + group.count / 6, 0),
      graph.pillarHalls[0]!.slots.length,
      `${scope}: published slots and prepared faces disagree.`,
    );
  }
}

// Resolution is arithmetic, so the same layout must publish the same table.
{
  const repeatable = withMassSlots(DEFAULT_MASS_LAYOUT, ...ALL_MASS_SLOTS);
  assert.equal(
    serializeGraph(generateStructure(toStructureSpec(repeatable))),
    serializeGraph(generateStructure(toStructureSpec(repeatable))),
    "Slot resolution is not deterministic.",
  );
}

console.log(
  `Structure sanity passed: ${FIXTURES.length + HALL_FIXTURES.length} fixtures,`
  + ` ${pyramid.patches.length} pyramid patches,`
  + ` ${merged.totals.vertexCount} tessellated vertices.`,
);

// --- helpers ---------------------------------------------------------------

/**
 * Every published slot addresses live stone.
 *
 * A slot that names a patch nobody emits, or reserves ground outside its own
 * surface, is worse than no slot at all: it looks addressable and is not. The
 * region and anchor checks are what make "published three ways" mean the same
 * thing three ways.
 */
function assertSlotInvariants(graph: StructureGraph, label: string): void {
  const patches = patchIndex(graph);
  const seen = new Set<string>();
  const claimed = new Map<string, { readonly uMin: number; readonly uMax: number; readonly vMin: number; readonly vMax: number }[]>();

  for (const slot of allSlots(graph)) {
    assert.ok(isValidId(slot.id), `${label}: slot id "${slot.id}" is malformed.`);
    assert.ok(!seen.has(slot.id), `${label}: duplicate slot id "${slot.id}".`);
    seen.add(slot.id);

    const patch = patches.get(slot.patchId);
    assert.ok(patch, `${label}: slot "${slot.id}" names no patch.`);
    assert.ok(
      patch!.regions.some((region) => region.id === slot.regionId),
      `${label}: slot "${slot.id}" reserved no region on its patch.`,
    );
    assert.ok(
      patch!.anchors.some((anchor) => anchor.id === slot.anchorId),
      `${label}: slot "${slot.id}" published no anchor on its patch.`,
    );

    const { inscribed } = slot;
    assert.ok(
      inscribed.uMin >= -1e-9 && inscribed.uMax <= 1 + 1e-9
      && inscribed.vMin >= -1e-9 && inscribed.vMax <= 1 + 1e-9,
      `${label}: slot "${slot.id}" reaches outside its patch domain.`,
    );
    assert.ok(
      inscribed.uMax > inscribed.uMin && inscribed.vMax > inscribed.vMin,
      `${label}: slot "${slot.id}" inverted.`,
    );
    assert.ok(
      slot.boundary.every((point) =>
        point.u >= -1e-9 && point.u <= 1 + 1e-9
        && point.v >= -1e-9 && point.v <= 1 + 1e-9),
      `${label}: slot "${slot.id}" has an outline outside its patch domain.`,
    );

    const minimum = slot.kind === "ribbon" ? MIN_RIBBON_WIDTH : MIN_FIELD_EXTENT;
    assert.ok(
      Math.min(slot.extent.uBottom, slot.extent.uTop) > 0 && slot.extent.v >= minimum - 1e-9,
      `${label}: slot "${slot.id}" is too small to have been published.`,
    );

    const others = claimed.get(slot.patchId) ?? [];
    for (const other of others) {
      const overlaps = inscribed.uMin < other.uMax - 1e-9
        && inscribed.uMax > other.uMin + 1e-9
        && inscribed.vMin < other.vMax - 1e-9
        && inscribed.vMax > other.vMin + 1e-9;
      assert.ok(!overlaps, `${label}: slot "${slot.id}" overlaps another on its patch.`);
    }
    others.push(inscribed);
    claimed.set(slot.patchId, others);
  }
}

function testRegion(
  id: string,
  uRange: readonly [number, number],
  vRange: readonly [number, number],
  priority: number,
): PatchRegion {
  return {
    id,
    uRange,
    vRange,
    priority,
    allowedOperations: ["cut"],
    exclusions: [],
    tags: ["test"],
  };
}

function testCutFeature(
  id: string,
  regionId: string,
  overrides: Partial<PatchFeature> = {},
): PatchFeature {
  const conflictPolicy: FeatureConflictPolicy = overrides.conflictPolicy ?? "error";
  return {
    id,
    operation: "cut",
    depth: 0,
    materialRole: null,
    regionId,
    order: 0,
    dependsOn: [],
    runsBefore: [],
    runsAfter: [],
    conflictPolicy,
    ...overrides,
  };
}

function testFeaturePatch(
  regions: readonly PatchRegion[],
  features: readonly PatchFeature[],
): Patch {
  const id = "feature_patch";
  return {
    id,
    role: "test_surface",
    frame: {
      origin: { x: 0, y: 0, z: 0 },
      uAxis: { x: 1, y: 0, z: 0 },
      vAxis: { x: 0, y: 1, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
      uLength: 10,
      vLength: 10,
    },
    dimensions: { u: 10, v: 10, thickness: 0 },
    evaluator: "planar",
    edges: {
      uMin: { id: `${id}/edge_u_min`, orientation: "sideNegativeU", treatment: null },
      uMax: { id: `${id}/edge_u_max`, orientation: "sidePositiveU", treatment: null },
      vMin: { id: `${id}/edge_v_min`, orientation: "bottom", treatment: null },
      vMax: { id: `${id}/edge_v_max`, orientation: "top", treatment: null },
    },
    adjacency: [],
    regions,
    features,
    anchors: [],
    tags: ["test"],
  };
}

function normalizedXRange(
  patch: Patch,
  minX: number,
  maxX: number,
): readonly [number, number] {
  const project = (x: number) =>
    (x - patch.frame.origin.x) * patch.frame.uAxis.x / patch.frame.uLength;
  const values = [project(minX), project(maxX)];
  return [Math.min(...values), Math.max(...values)];
}

function assertGraphInvariants(graph: StructureGraph, label: string): void {
  assert.equal(graph.units, "meters");
  // A stela stands on the ground rather than on a mass, so a graph is complete
  // with either a mass or a free-standing family record in it.
  assert.ok(
    graph.masses.length > 0 || graph.stelae.length > 0,
    `${label}: no mass or free-standing structure was generated.`,
  );

  const byId = patchIndex(graph);
  assert.equal(byId.size, graph.patches.length, `${label}: duplicate patch id.`);

  for (const patch of graph.patches) {
    assert.ok(isValidId(patch.id), `${label}: "${patch.id}" is not a valid id path.`);

    // Every resolved dimension must be positive. A zero-extent patch means a
    // setback or a batter ate the surface and nobody noticed.
    assert.ok(
      patch.dimensions.u > 0 && patch.dimensions.v > 0,
      `${label}: patch ${patch.id} has a non-positive dimension.`,
    );
    assert.ok(
      Number.isFinite(patch.frame.uLength) && Number.isFinite(patch.frame.vLength),
      `${label}: patch ${patch.id} has a non-finite frame.`,
    );

    // Adjacency is symmetric, or a rule that walks neighbours gets a different
    // answer depending on which side it started from.
    for (const neighbour of patch.adjacency) {
      const other = byId.get(neighbour);
      assert.ok(other, `${label}: ${patch.id} names missing neighbour ${neighbour}.`);
      assert.ok(
        other.adjacency.includes(patch.id),
        `${label}: ${patch.id} → ${neighbour} is not reciprocated.`,
      );
    }

    // Regions live inside their patch's domain, or a child placed in one lands
    // off the surface it was supposed to sit on.
    for (const region of patch.regions) {
      assert.ok(
        region.uRange[0] >= -1e-9 && region.uRange[1] <= 1 + 1e-9
        && region.vRange[0] >= -1e-9 && region.vRange[1] <= 1 + 1e-9,
        `${label}: region ${region.id} escapes its patch domain.`,
      );
      assert.ok(
        region.uRange[1] >= region.uRange[0] && region.vRange[1] >= region.vRange[0],
        `${label}: region ${region.id} is inverted.`,
      );
    }

    // Features address a real region on their patch. Cell portals are the first
    // executable operation to fill this formerly reserved container.
    assert.deepEqual(
      compilePatchFeatures(patch).diagnostics.filter(
        (entry) => entry.severity === "error",
      ),
      [],
      `${label}: patch ${patch.id} has an invalid feature plan.`,
    );
    for (const feature of patch.features) {
      assert.ok(isValidId(feature.id), `${label}: feature ${feature.id} is invalid.`);
      assert.ok(feature.operation, `${label}: feature ${feature.id} has no operation.`);
      if (feature.regionId) {
        assert.ok(
          patch.regions.some((region) => region.id === feature.regionId),
          `${label}: feature ${feature.id} names missing region ${feature.regionId}.`,
        );
      }
    }

    // Anchors are filled by summit allocation and must address a real region on
    // their own patch.
    assert.equal(
      new Set(patch.anchors.map((anchor) => anchor.id)).size,
      patch.anchors.length,
      `${label}: patch ${patch.id} has duplicate anchor ids.`,
    );
    for (const anchor of patch.anchors) {
      assert.ok(isValidId(anchor.id), `${label}: anchor ${anchor.id} is invalid.`);
      assert.ok(anchor.kind, `${label}: anchor ${anchor.id} has no kind.`);
      assert.ok(
        anchor.u >= 0 && anchor.u <= 1
        && anchor.v >= 0 && anchor.v <= 1
        && Number.isFinite(anchor.d),
        `${label}: anchor ${anchor.id} escapes its patch domain.`,
      );
      if (anchor.regionId) {
        assert.ok(
          patch.regions.some((region) => region.id === anchor.regionId),
          `${label}: anchor ${anchor.id} names missing region ${anchor.regionId}.`,
        );
      }
    }
  }

  // Reserved containers stay empty until the phases that fill them arrive.
  for (const reserved of [
    graph.attachments,
    graph.damage,
  ]) {
    assert.deepEqual(reserved, []);
  }

  assert.equal(
    new Set(graph.pillarHalls.map((hall) => hall.id)).size,
    graph.pillarHalls.length,
    `${label}: duplicate Pillar Hall id.`,
  );
  for (const hall of graph.pillarHalls) {
    assert.ok(isValidId(hall.id), `${label}: Pillar Hall id "${hall.id}" is invalid.`);
    assert.ok(hall.rows.length > 0 && hall.supports.length > 1);
    assert.ok(hall.bays.length > 0 && hall.members.length > 0);
    const supportIds = new Set(hall.supports.map((support) => support.id));
    const bayIds = new Set(hall.bays.map((bay) => bay.id));
    for (const row of hall.rows) {
      assert.ok(row.supportIds.every((id) => supportIds.has(id)));
      assert.ok(row.bayIds.every((id) => bayIds.has(id)));
    }
    for (const support of hall.supports) {
      assert.deepEqual(
        support.sections.map((section) => section.kind),
        ["foot", "lower_panel", "shaft", "capital", "capstone"],
      );
      assert.ok(support.panels.every((panel) => panel.materialRole === "pierPanel"));
      for (const panel of support.panels) {
        const faceWidth = panel.orientation === "front" || panel.orientation === "rear"
          ? rectWidth(panel.supportFootprint)
          : rectDepth(panel.supportFootprint);
        assert.ok(
          faceWidth - panel.insetU * 2 > panel.borderWidth * 2,
          `${label}: ${panel.id} has no usable horizontal panel field.`,
        );
        assert.ok(
          panel.topY - panel.bottomY - panel.insetV * 2 > panel.borderWidth * 2,
          `${label}: ${panel.id} has no usable vertical panel field.`,
        );
      }
    }
    assert.ok(graph.masses.some((mass) => mass.id === hall.platformMassId));
    assert.ok(byId.has(hall.supportPatchId));
  }

  assert.equal(
    new Set(graph.stelae.map((stela) => stela.id)).size,
    graph.stelae.length,
    `${label}: duplicate stela id.`,
  );
  for (const stela of graph.stelae) {
    assert.ok(isValidId(stela.id), `${label}: stela id "${stela.id}" is invalid.`);
    assert.ok(stela.bands.length > 0 && stela.trunk.length > 0);

    // The stack is contiguous. A gap between two courses is a hole nothing
    // downstream can close, because nothing downstream knows it was meant to.
    for (const [index, element] of stela.trunk.entries()) {
      assert.ok(element.topY > element.bottomY, `${label}: ${element.id} has no rise.`);
      const previous = stela.trunk[index - 1];
      if (previous) {
        assert.ok(
          Math.abs(element.bottomY - previous.topY) < 1e-9,
          `${label}: ${element.id} leaves a gap above ${previous.id}.`,
        );
      }
    }

    for (const slot of stela.slots) {
      assert.ok(isValidId(slot.id), `${label}: slot id "${slot.id}" is invalid.`);
      const patch = byId.get(slot.patchId);
      assert.ok(patch, `${label}: slot ${slot.id} names missing patch ${slot.patchId}.`);
      assert.ok(
        patch.regions.some((region) => region.id === slot.regionId),
        `${label}: slot ${slot.id} has no published region.`,
      );
      assert.ok(
        patch.anchors.some(
          (anchor) => anchor.id === slot.anchorId && anchor.kind === "ornament",
        ),
        `${label}: slot ${slot.id} has no ornament anchor.`,
      );

      // The inscribed rectangle is what a texture consumer uses, so it has to
      // sit inside the real outline rather than beside it.
      const us = slot.boundary.map((point) => point.u);
      const vs = slot.boundary.map((point) => point.v);
      assert.ok(
        slot.inscribed.uMin >= Math.min(...us) - 1e-9
        && slot.inscribed.uMax <= Math.max(...us) + 1e-9
        && slot.inscribed.vMin >= Math.min(...vs) - 1e-9
        && slot.inscribed.vMax <= Math.max(...vs) + 1e-9,
        `${label}: slot ${slot.id} escapes its own boundary.`,
      );
      assert.ok(
        slot.inscribed.uMax > slot.inscribed.uMin
        && slot.inscribed.vMax > slot.inscribed.vMin,
        `${label}: slot ${slot.id} has no usable rectangle.`,
      );

      // Opposed faces split their axis, so a fully carved pair still leaves a
      // core rather than meeting in the middle of the stone.
      if (slot.part === "body") {
        const axis = slot.face === "front" || slot.face === "rear"
          ? rectDepth(stela.body.lower)
          : rectWidth(stela.body.lower);
        assert.ok(
          slot.depthBudget.recess * 2 <= axis - stela.body.minCoreThickness + 1e-9,
          `${label}: slot ${slot.id} exhausts the body core.`,
        );
      }
    }
  }

  assert.equal(
    new Set(graph.facades.map((facade) => facade.id)).size,
    graph.facades.length,
    `${label}: duplicate facade id.`,
  );
  for (const facade of graph.facades) {
    assert.ok(isValidId(facade.id), `${label}: facade id "${facade.id}" is invalid.`);
    assert.equal(byId.get(facade.exteriorPatchId)?.role, PATCH_ROLES.cellWallExterior);
    assert.equal(byId.get(facade.interiorPatchId)?.role, PATCH_ROLES.cellWallInterior);
    assert.ok(graph.cells.some((cell) => cell.id === facade.cellId));
    assert.ok(facade.bays.length > 0 && facade.bands.length > 0);
    assert.ok(Math.abs(facade.bays[0]!.uRange[0]) <= 1);
    assert.ok(Math.abs(facade.bands[0]!.vRange[0]) <= 1e-9);
    assert.ok(Math.abs(facade.bands.at(-1)!.vRange[1] - 1) <= 1e-9);
    const patchFeatures = new Set([
      ...(byId.get(facade.exteriorPatchId)?.features.map((feature) => feature.id) ?? []),
      ...(byId.get(facade.interiorPatchId)?.features.map((feature) => feature.id) ?? []),
    ]);
    for (const featureId of facade.featureIds) {
      assert.ok(
        patchFeatures.has(featureId),
        `${label}: facade ${facade.id} names missing feature ${featureId}.`,
      );
    }
  }

  for (const connector of graph.connectors) {
    assert.ok(isValidId(connector.id), `${label}: connector id "${connector.id}" is invalid.`);
    assert.equal(connector.kind, "stair");

    // The connector joins two traversable patches that must both exist.
    for (const patchId of [connector.lowerPatchId, connector.upperPatchId]) {
      const surface = byId.get(patchId);
      assert.ok(surface, `${label}: connector names missing surface ${patchId}.`);
      assert.ok(
        surface.tags.includes("traversable"),
        `${label}: connector ends on ${patchId}, which is not traversable.`,
      );
    }

    for (const patchId of connector.patchIds) {
      assert.ok(byId.has(patchId), `${label}: connector names missing patch ${patchId}.`);
    }

    // The resolved step rule must be internally exact: the riser and tread are
    // what the integer count actually produced, not the targets.
    assert.ok(connector.stepCount >= 1);
    assert.ok(
      Math.abs(connector.stepCount * connector.riser - (connector.topY - connector.bottomY)) < 1e-9,
      `${label}: connector risers do not sum to its rise.`,
    );
    assert.ok(
      Math.abs(connector.stepCount * connector.tread - connector.run) < 1e-9,
      `${label}: connector treads do not sum to its run.`,
    );
    const alongX = connector.direction === "sidePositiveU"
      || connector.direction === "sideNegativeU";
    assert.ok(
      Math.abs(
        (alongX
          ? rectWidth(connector.flightRect)
          : rectDepth(connector.flightRect))
        - connector.run,
      ) < 1e-9,
      `${label}: connector flight rect disagrees with its run.`,
    );
    assert.ok(
      Math.abs(
        (alongX
          ? rectDepth(connector.flightRect)
          : rectWidth(connector.flightRect))
        - connector.width,
      ) < 1e-9,
      `${label}: connector flight rect disagrees with its width.`,
    );
    assert.ok(connector.riser > 0 && connector.tread > 0, `${label}: degenerate step.`);
  }

  for (const cell of graph.cells) {
    assert.ok(isValidId(cell.id), `${label}: cell id "${cell.id}" is invalid.`);
    assert.equal(cell.kind, "cell");
    assert.ok(
      ["single_chamber", "twin_chamber", "three_bay"].includes(cell.layout),
      `${label}: cell has unknown room layout ${cell.layout}.`,
    );
    assert.equal(cell.occupancy, "room");
    assert.ok(cell.topY > cell.bottomY);
    assert.ok(Math.abs(cell.topY - cell.bottomY - cell.height) < 1e-9);
    assert.ok(cell.wallThickness > 0);
    assert.ok(
      cell.interior.minX > cell.footprint.minX
      && cell.interior.maxX < cell.footprint.maxX
      && cell.interior.minZ > cell.footprint.minZ
      && cell.interior.maxZ < cell.footprint.maxZ,
      `${label}: cell interior does not sit inside its wall footprint.`,
    );

    const support = byId.get(cell.supportPatchId);
    assert.ok(support, `${label}: cell names missing support ${cell.supportPatchId}.`);
    assert.ok(
      support.tags.includes("traversable"),
      `${label}: cell support ${cell.supportPatchId} is not traversable.`,
    );
    assert.ok(
      support.anchors.some((anchor) => anchor.id === cell.placementAnchorId),
      `${label}: cell names missing placement anchor ${cell.placementAnchorId}.`,
    );
    assert.equal(byId.get(cell.floorPatchId)?.role, PATCH_ROLES.cellFloor);

    assert.ok(cell.rooms.length > 0, `${label}: cell has no resolved rooms.`);
    assert.equal(
      new Set(cell.rooms.map((room) => room.id)).size,
      cell.rooms.length,
      `${label}: cell has duplicate room ids.`,
    );
    for (const room of cell.rooms) {
      assert.ok(isValidId(room.id), `${label}: room id "${room.id}" is invalid.`);
      assert.ok(
        room.footprint.maxX > room.footprint.minX
        && room.footprint.maxZ > room.footprint.minZ,
        `${label}: room ${room.id} has no floor area.`,
      );
      assert.equal(
        byId.get(room.floorPatchId)?.role,
        PATCH_ROLES.cellFloor,
        `${label}: room ${room.id} names a missing floor patch.`,
      );
    }

    assert.equal(cell.walls.length, 4);
    assert.equal(new Set(cell.walls.map((wall) => wall.orientation)).size, 4);
    for (const wall of cell.walls) {
      const exterior = byId.get(wall.outerPatchId);
      const interior = byId.get(wall.innerPatchId);
      assert.equal(exterior?.role, PATCH_ROLES.cellWallExterior);
      assert.equal(interior?.role, PATCH_ROLES.cellWallInterior);
      assert.equal(exterior?.edges.vMax.treatment, "roof_bearing");
      assert.equal(interior?.edges.vMax.treatment, "roof_bearing");
    }

    assert.deepEqual(
      cell.openings.map((opening) => opening.direction),
      graph.connectors.map((connector) => connector.direction),
      `${label}: summit portals do not match the configured stair facades.`,
    );
    for (const opening of cell.openings) {
      assert.equal(opening.kind, "portal");
      assert.ok(opening.width > 0 && opening.height > 0);
      assert.ok(opening.topY < cell.topY);
      assert.ok(
        opening.threshold.maxX > opening.threshold.minX
        && opening.threshold.maxZ > opening.threshold.minZ,
        `${label}: ${opening.direction} portal has no threshold area.`,
      );
      assert.equal(byId.get(opening.exteriorPatchId)?.tags.includes("traversable"), true);
      assert.equal(byId.get(opening.interiorPatchId)?.role, PATCH_ROLES.cellFloor);
      assert.ok(
        opening.destinationRoomIds.length > 0,
        `${label}: ${opening.direction} portal reaches no room.`,
      );
      for (const roomId of opening.destinationRoomIds) {
        assert.ok(
          cell.rooms.some((room) => room.id === roomId),
          `${label}: ${opening.direction} portal reaches missing room ${roomId}.`,
        );
      }
      assert.ok(
        cell.rooms.some(
          (room) =>
            room.id === opening.destinationRoomIds[0]
            && room.floorPatchId === opening.interiorPatchId,
        ),
        `${label}: ${opening.direction} portal floor disagrees with its destination room.`,
      );
      for (const patchId of opening.revealPatchIds) {
        assert.equal(byId.get(patchId)?.role, PATCH_ROLES.cellOpeningReveal);
      }
    }

    const roomIds = new Set(cell.rooms.map((room) => room.id));
    const connectionIds = new Set(cell.connections.map(
      (connection) => connection.id,
    ));
    assert.equal(
      connectionIds.size,
      cell.connections.length,
      `${label}: cell has duplicate connection ids.`,
    );
    for (const connection of cell.connections) {
      assert.ok(
        roomIds.has(connection.sourceRoomId)
        && roomIds.has(connection.destinationRoomId)
        && connection.sourceRoomId !== connection.destinationRoomId,
        `${label}: connection ${connection.id} does not join two rooms.`,
      );
      assert.ok(connection.width > 0 && connection.height > 0);
      assert.ok(connection.topY < cell.topY);
      assert.ok(
        connection.threshold.maxX > connection.threshold.minX
        && connection.threshold.maxZ > connection.threshold.minZ,
        `${label}: connection ${connection.id} has no threshold area.`,
      );
      for (const patchId of connection.revealPatchIds) {
        assert.equal(byId.get(patchId)?.role, PATCH_ROLES.cellOpeningReveal);
      }
    }

    for (const wall of cell.interiorWalls) {
      assert.ok(isValidId(wall.id), `${label}: partition id "${wall.id}" is invalid.`);
      assert.ok(
        roomIds.has(wall.negativeRoomId) && roomIds.has(wall.positiveRoomId),
        `${label}: partition ${wall.id} names a missing room.`,
      );
      assert.ok(
        wall.rect.maxX > wall.rect.minX && wall.rect.maxZ > wall.rect.minZ,
        `${label}: partition ${wall.id} has no area in plan.`,
      );
      for (const patchId of [wall.negativePatchId, wall.positivePatchId]) {
        const patch = byId.get(patchId);
        assert.equal(patch?.role, PATCH_ROLES.cellWallInterior);
        assert.equal(patch?.edges.vMax.treatment, "roof_bearing");
        assert.ok(patch?.tags.includes("interior_partition"));
        assert.equal(
          patch?.features.filter((feature) => feature.operation === "cut").length,
          wall.connectionIds.length,
          `${label}: partition ${wall.id} has inconsistent doorway cuts.`,
        );
      }
      for (const connectionId of wall.connectionIds) {
        assert.ok(
          connectionIds.has(connectionId),
          `${label}: partition ${wall.id} names missing connection ${connectionId}.`,
        );
      }
    }

    for (const patchId of cell.patchIds) {
      assert.ok(byId.has(patchId), `${label}: cell names missing patch ${patchId}.`);
    }
  }

  for (const roof of graph.roofs) {
    assert.ok(isValidId(roof.id), `${label}: roof id "${roof.id}" is invalid.`);
    assert.equal(roof.kind, "roof");
    assert.ok(roof.thickness > 0);
    assert.ok(roof.projection >= 0);
    assert.ok(Math.abs(roof.slabTopY - roof.bottomY - roof.thickness) < 1e-9);
    assert.ok(roof.topY >= roof.slabTopY);
    assert.equal(byId.get(roof.topPatchId)?.role, PATCH_ROLES.roof);
    assert.equal(byId.get(roof.ceilingPatchId)?.role, PATCH_ROLES.roofSoffit);
    for (const patchId of roof.edgePatchIds) {
      assert.ok(byId.has(patchId), `${label}: roof names missing edge patch ${patchId}.`);
    }
    for (const patchId of roof.soffitPatchIds) {
      assert.ok(byId.has(patchId), `${label}: roof names missing soffit patch ${patchId}.`);
    }
    for (const patchId of roof.patchIds) {
      assert.ok(byId.has(patchId), `${label}: roof names missing patch ${patchId}.`);
    }

    assert.ok(
      roof.slabFootprint.minX <= roof.bearingFootprint.minX
      && roof.slabFootprint.maxX >= roof.bearingFootprint.maxX
      && roof.slabFootprint.minZ <= roof.bearingFootprint.minZ
      && roof.slabFootprint.maxZ >= roof.bearingFootprint.maxZ,
      `${label}: roof slab does not cover its bearing footprint.`,
    );
    assert.ok(
      roof.ceilingFootprint.minX > roof.bearingFootprint.minX
      && roof.ceilingFootprint.maxX < roof.bearingFootprint.maxX
      && roof.ceilingFootprint.minZ > roof.bearingFootprint.minZ
      && roof.ceilingFootprint.maxZ < roof.bearingFootprint.maxZ,
      `${label}: roof ceiling does not fit inside its bearing footprint.`,
    );

    assert.equal(roof.coversCellIds.length, 1);
    const coveredCell = graph.cells.find(
      (cell) => cell.id === roof.coversCellIds[0],
    );
    assert.ok(coveredCell, `${label}: roof covers a missing cell.`);
    assert.equal(roof.bottomY, coveredCell?.topY);
    assert.deepEqual(roof.bearingFootprint, coveredCell?.footprint);
    assert.deepEqual(roof.ceilingFootprint, coveredCell?.interior);
    assert.deepEqual(
      roof.coversRoomIds,
      coveredCell?.rooms.map((room) => room.id),
      `${label}: roof group does not cover its cell rooms.`,
    );

    for (const patchId of roof.bearingPatchIds) {
      const bearing = byId.get(patchId);
      assert.ok(bearing, `${label}: roof names missing bearing patch ${patchId}.`);
      assert.equal(bearing?.edges.vMax.treatment, "roof_bearing");
    }
    assert.equal(roof.roofType, "flat_slab");

    if (roof.cornice) {
      assert.ok(roof.cornice.projection > 0 && roof.cornice.height > 0);
      assert.equal(roof.cornice.bottomY, roof.slabTopY);
      assert.equal(roof.cornice.topY, roof.topY);
      assert.ok(
        roof.cornice.outline.minX < roof.slabFootprint.minX
        && roof.cornice.outline.maxX > roof.slabFootprint.maxX
        && roof.cornice.outline.minZ < roof.slabFootprint.minZ
        && roof.cornice.outline.maxZ > roof.slabFootprint.maxZ,
        `${label}: roof cornice does not project beyond the slab.`,
      );
    } else {
      assert.equal(roof.topY, roof.slabTopY);
    }
  }

  for (const diagnostic of graph.diagnostics) {
    assert.ok(diagnostic.code, `${label}: a diagnostic has no code.`);
    assert.ok(diagnostic.entityId, `${label}: a diagnostic has no entity id.`);
    assert.ok(diagnostic.message, `${label}: a diagnostic has no message.`);
  }

  for (const mass of graph.masses) {
    let previousTop = Number.NEGATIVE_INFINITY;
    let riseTotal = 0;

    for (const band of mass.bands) {
      assert.ok(band.rise > 0, `${label}: band ${band.id} has no rise.`);
      assert.ok(
        band.topY > band.bottomY && band.bottomY >= previousTop - 1e-9,
        `${label}: band ${band.id} elevations are not monotonic.`,
      );
      assert.ok(
        Math.abs(band.topY - band.bottomY - band.rise) < 1e-9,
        `${label}: band ${band.id} rise disagrees with its elevations.`,
      );

      // A band's crown never exceeds its base. Battered walls lean inward; the
      // base treatment is the one band that widens, and it does so below.
      if (band.surfaceRole !== PATCH_ROLES.basePlinth) {
        assert.ok(
          band.upper.maxX - band.upper.minX <= band.lower.maxX - band.lower.minX + 1e-9,
          `${label}: band ${band.id} widens as it rises.`,
        );
      }

      previousTop = band.topY;

      if (band.index >= 0) {
        riseTotal += band.rise;
      }
    }

    // The plinth sits below the profile, so the requested total height is the
    // sum of the numbered bands alone.
    const requestedHeight = mass.totalHeight
      - (mass.baseTreatment === "none" ? 0 : mass.bands[0]?.rise ?? 0);
    assert.ok(
      Math.abs(riseTotal - requestedHeight) < 1e-9,
      `${label}: band rises sum to ${riseTotal}, expected ${requestedHeight}.`,
    );

    // The summit has to be somewhere a superstructure could actually stand, and
    // the patch it names has to exist.
    assert.ok(
      mass.summit.rect.maxX > mass.summit.rect.minX
      && mass.summit.rect.maxZ > mass.summit.rect.minZ,
      `${label}: summit has no positive extent.`,
    );
    assert.ok(
      byId.has(mass.summit.patchId),
      `${label}: summit names missing patch ${mass.summit.patchId}.`,
    );
    assert.equal(
      byId.get(mass.summit.patchId)?.role,
      PATCH_ROLES.summitFloor,
    );
    if (mass.summit.buildable) {
      assert.ok(
        mass.summit.buildable.maxX > mass.summit.buildable.minX
        && mass.summit.buildable.maxZ > mass.summit.buildable.minZ,
        `${label}: summit buildable region has no positive extent.`,
      );
    }
    if (mass.summit.buildingPad) {
      assert.ok(
        mass.summit.buildable
        && mass.summit.buildingPad.minX >= mass.summit.buildable.minX - 1e-9
        && mass.summit.buildingPad.maxX <= mass.summit.buildable.maxX + 1e-9
        && mass.summit.buildingPad.minZ >= mass.summit.buildable.minZ - 1e-9
        && mass.summit.buildingPad.maxZ <= mass.summit.buildable.maxZ + 1e-9,
        `${label}: building pad escapes the buildable summit.`,
      );
      assert.ok(mass.summit.placement, `${label}: building pad has no placement.`);
    } else {
      assert.equal(mass.summit.placement, null);
    }
    if (mass.summit.placement) {
      const placementPatch = byId.get(mass.summit.placement.patchId);
      assert.ok(
        placementPatch,
        `${label}: summit placement names missing patch ${mass.summit.placement.patchId}.`,
      );
      assert.ok(
        placementPatch.anchors.some(
          (anchor) => anchor.id === mass.summit.placement?.anchorId,
        ),
        `${label}: summit placement names missing anchor ${mass.summit.placement.anchorId}.`,
      );
      assert.ok(
        Math.abs(placementPatch.frame.origin.y - mass.summit.placement.y) < 1e-9,
        `${label}: summit placement elevation disagrees with its patch.`,
      );
    }
    if (mass.summit.pad) {
      assert.equal(mass.summit.pad.kind, "raised_pad");
      assert.equal(mass.summit.pad.band.surfaceRole, PATCH_ROLES.summitPadSide);
      assert.equal(
        byId.get(mass.summit.pad.topPatchId)?.role,
        PATCH_ROLES.summitPad,
      );
      for (const patchId of mass.summit.pad.patchIds) {
        assert.ok(byId.has(patchId), `${label}: summit pad names missing patch ${patchId}.`);
      }
    }

    // A terrace is classified by whether it is wide enough to stand on, and the
    // classification has to match the geometry it describes.
    for (let index = 0; index < mass.bands.length - 1; index += 1) {
      const band = mass.bands[index];
      const next = mass.bands[index + 1];

      if (!band || !next) {
        continue;
      }

      const ring = Math.min(
        next.lower.minX - band.upper.minX,
        band.upper.maxX - next.lower.maxX,
        next.lower.minZ - band.upper.minZ,
        band.upper.maxZ - next.lower.maxZ,
      );
      assert.equal(
        band.walkable,
        ring >= WALKABLE_TERRACE_WIDTH - 1e-9 && band.index >= 0,
        `${label}: band ${band.id} walkability disagrees with its ring width.`,
      );
    }
  }

  // Patch frames must evaluate to real points across their whole domain — this
  // is the interface every later feature addresses a surface through.
  for (const patch of graph.patches) {
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]] as const) {
      const point = evaluateFrame(patch.frame, u, v);
      assert.ok(
        Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z),
        `${label}: patch ${patch.id} evaluates to a non-finite point.`,
      );
    }
  }
}

function assertMatchesFixture(name: string, graph: StructureGraph): void {
  const path = join(FIXTURE_DIR, `${name}.json`);
  const serialized = serializeGraph(graph);

  if (UPDATE_FIXTURES || !existsSync(path)) {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(path, serialized, "utf8");
    console.log(`  wrote fixture ${name}.json`);
    return;
  }

  assert.equal(
    serialized,
    readFileSync(path, "utf8"),
    `${name}: the resolved graph changed. Review the diff, then re-record with `
    + `UPDATE_FIXTURES=1 npm test if the change was intended.`,
  );
}

/**
 * A dense, corner-focused hunt for sightlines into the mass.
 *
 * Corner seams are a couple of centimetres wide and — as measured while
 * hunting the butted-corner slits — visible mostly along steep, oblique
 * sightlines looking *down* into the seam, which the sphere-sampled backface
 * probe all but never takes and which no hand-aimed fan reliably reproduced.
 * So this probe does what the eye does: it stares at the corners from
 * everywhere. Targets scatter through a window around every band's four
 * corner columns; directions scatter over the above-horizon hemisphere. The
 * pseudo-random stream is a fixed LCG, so the rays are the same every run.
 * The verdict per ray is findBackfaces': a first double-sided hit that is
 * back-facing, with nothing for the front-sided mesh to close it, is a hole.
 */
function findCornerSightlines(
  geometry: THREE.BufferGeometry,
  bands: readonly ElevationBandRecord[],
  rays = 20000,
): { readonly holes: number; readonly shots: number; readonly sample: string | null } {
  const doubleSided = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  const rendered = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ side: THREE.FrontSide }),
  );
  const raycaster = new THREE.Raycaster();
  geometry.computeBoundingBox();
  const reach = geometry.boundingBox!.getSize(new THREE.Vector3()).length() * 0.5;
  const corners: { readonly x: number; readonly z: number; readonly y0: number; readonly y1: number }[] = [];

  for (const band of bands) {
    for (const [x, z] of [
      [band.lower.maxX, band.lower.maxZ],
      [band.lower.minX, band.lower.maxZ],
      [band.lower.maxX, band.lower.minZ],
      [band.lower.minX, band.lower.minZ],
    ] as const) {
      corners.push({ x, z, y0: band.bottomY, y1: band.topY });
    }
  }

  let state = 1234567;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  let shots = 0;
  let holes = 0;
  let sample: string | null = null;

  for (let ray = 0; ray < rays; ray += 1) {
    const corner = corners[Math.floor(random() * corners.length)]!;
    const target = new THREE.Vector3(
      corner.x + (random() - 0.5) * 1.2,
      corner.y0 + random() * (corner.y1 - corner.y0),
      corner.z + (random() - 0.5) * 1.2,
    );
    const azimuth = random() * Math.PI * 2;
    const elevation = random() * 0.9;
    const direction = new THREE.Vector3(
      Math.cos(azimuth) * Math.cos(elevation),
      -Math.sin(elevation),
      Math.sin(azimuth) * Math.cos(elevation),
    ).normalize();
    const origin = target.clone().addScaledVector(direction, -reach);
    raycaster.set(origin, direction);
    const hit = raycaster.intersectObject(doubleSided, false)[0];

    if (!hit?.face) {
      continue;
    }

    shots += 1;

    if (
      hit.face.normal.dot(direction) > 0
      && raycaster.intersectObject(rendered, false).length === 0
    ) {
      holes += 1;
      sample ??= hit.point.toArray().map((value) => value.toFixed(2)).join(", ");
    }
  }

  return { holes, shots, sample };
}

/** The axis-aligned bounds of everything a builder has laid, read back exactly. */
function boundsOfBuilder(builder: SolidBuilder): {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
} {
  const bounds = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    minZ: Infinity,
    maxZ: -Infinity,
  };

  for (let index = 0; index < builder.positions.length; index += 3) {
    bounds.minX = Math.min(bounds.minX, builder.positions[index] ?? 0);
    bounds.maxX = Math.max(bounds.maxX, builder.positions[index] ?? 0);
    bounds.minY = Math.min(bounds.minY, builder.positions[index + 1] ?? 0);
    bounds.maxY = Math.max(bounds.maxY, builder.positions[index + 1] ?? 0);
    bounds.minZ = Math.min(bounds.minZ, builder.positions[index + 2] ?? 0);
    bounds.maxZ = Math.max(bounds.maxZ, builder.positions[index + 2] ?? 0);
  }

  return bounds;
}

/**
 * The parts of the graph the massing subsystem owns. Compared instead of the
 * whole graph so the seed-isolation check is not trivially satisfied by the
 * seeds block itself differing.
 */
function massingFingerprint(graph: StructureGraph): string {
  return JSON.stringify({
    masses: graph.masses,
    patches: graph.patches,
    diagnostics: graph.diagnostics,
  });
}

/**
 * Normals across a whole stacked mass.
 *
 * The centre-based test below only holds for a single convex solid: on a stepped
 * pyramid a terrace ring sits below the bounding-box centre while correctly
 * facing up. So each face is checked against what it is instead — walls point
 * away from the vertical axis, horizontal faces point up, and only an exposed
 * overhang such as a cornice may point down. The ground interface is buried and
 * deliberately left open.
 *
 * The centre is the footprint's, not the bounding box's: a stair shifts the box
 * without moving the axis walls actually face away from. And inside a
 * connector's own plan span the away-from-axis rule does not apply at all — a
 * parapet's inner elevation and its terminal above the summit face inward and
 * rearward by construction.
 */
function assertMassNormals(
  geometry: THREE.BufferGeometry,
  label: string,
  graph: StructureGraph,
): void {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  assert.ok(bounds);
  const footprint = graph.masses[0]?.footprint;
  assert.ok(footprint);
  const center = new THREE.Vector3(
    (footprint.minX + footprint.maxX) * 0.5,
    0,
    (footprint.minZ + footprint.maxZ) * 0.5,
  );
  const connectorSpans = graph.connectors.map((connector) => {
    const cornice = connector.parapet?.cornice;
    const sideWidth = (connector.parapet?.width ?? 0)
      + (cornice?.projection ?? 0)
      + 1e-4;
    const terminalLength = cornice
      ? (connector.parapet?.width ?? 0) + cornice.projection * 2
      : 0;
    const corners = [
      stairLocalVertex(connector, -connector.width * 0.5 - sideWidth, 0, -terminalLength - 1e-4),
      stairLocalVertex(connector, connector.width * 0.5 + sideWidth, 0, -terminalLength - 1e-4),
      stairLocalVertex(
        connector,
        -connector.width * 0.5 - sideWidth,
        0,
        connector.run + terminalLength + 1e-4,
      ),
      stairLocalVertex(
        connector,
        connector.width * 0.5 + sideWidth,
        0,
        connector.run + terminalLength + 1e-4,
      ),
    ];
    return {
      minX: Math.min(...corners.map((corner) => corner.x)),
      maxX: Math.max(...corners.map((corner) => corner.x)),
      minZ: Math.min(...corners.map((corner) => corner.z)),
      maxZ: Math.max(...corners.map((corner) => corner.z)),
    };
  });

  const point = new THREE.Vector3();
  const facing = new THREE.Vector3();
  for (let index = 0; index < position.count; index += 1) {
    point.fromBufferAttribute(position, index);
    facing.fromBufferAttribute(normal, index);

    assert.ok(
      Math.abs(facing.length() - 1) < 1e-3,
      `${label}: vertex ${index} normal is degenerate.`,
    );

    if (facing.y < -0.9) {
      assert.ok(
        point.y > bounds.min.y + 1e-4,
        `${label}: vertex ${index} emits a downward face buried at the base.`,
      );
      continue;
    }

    // Raked parapet cornices have visible sloped soffits and terminal faces;
    // their normals are governed by the connector, not the mass wall rule.
    if (connectorSpans.some((span) =>
      point.x >= span.minX && point.x <= span.maxX
      && point.z >= span.minZ && point.z <= span.maxZ)) {
      continue;
    }

    if (facing.y > 0.9) {
      continue;
    }

    // A wall. Battered walls tilt their normal upward, never downward, and the
    // horizontal component always points away from the mass's vertical axis.
    assert.ok(
      facing.y >= -1e-4,
      `${label}: vertex ${index} is a wall whose normal tilts downward.`,
    );

    assert.ok(
      (point.x - center.x) * facing.x + (point.z - center.z) * facing.z > 0,
      `${label}: vertex ${index} is a wall facing inward.`,
    );
  }

}

/**
 * Every vertex normal must point away from the solid's centre. Valid only for a
 * single convex solid; use `assertMassNormals` for a stack. This catches an
 * inverted winding, which `computeVertexNormals` will happily produce without
 * complaint and which only shows up as backface culling in the viewport.
 */
function assertOutwardNormals(geometry: THREE.BufferGeometry, label: string): void {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const center = new THREE.Vector3();
  geometry.computeBoundingBox();
  geometry.boundingBox?.getCenter(center);

  const point = new THREE.Vector3();
  const facing = new THREE.Vector3();
  const away = new THREE.Vector3();

  for (let index = 0; index < position.count; index += 1) {
    point.fromBufferAttribute(position, index);
    facing.fromBufferAttribute(normal, index);
    away.subVectors(point, center).normalize();

    assert.ok(
      facing.dot(away) > 0,
      `${label}: vertex ${index} normal points inward.`,
    );
  }
}

function assertAllNormalsFace(
  geometry: THREE.BufferGeometry,
  direction: THREE.Vector3,
  label: string,
): void {
  const normal = geometry.getAttribute("normal");
  const facing = new THREE.Vector3();

  for (let index = 0; index < normal.count; index += 1) {
    facing.fromBufferAttribute(normal, index);
    assert.ok(
      facing.dot(direction) > 0.999,
      `${label}: vertex ${index} normal is not ${direction.toArray().join(",")}.`,
    );
  }
}

// The detail ladder. Its whole premise is that a coarser level is the same
// structure generated with less spent on it — so the semantic layer must not
// move, the geometry must stay watertight, and the cost must actually fall.

// The bare level's *masonry* has to land exactly on the path the greybox
// assertions above already prove, or it is a new code path wearing a proven
// one's name. Compared over a graph with its connectors removed, because the
// stairs are the one part bare deliberately does build differently — it ramps
// them, which is asserted separately below.
const shellGraphWithoutStairs = { ...shellGraph, connectors: [] };
const bareByLevel = tessellateStructure(shellGraphWithoutStairs, {
  masonry: shellRule,
  seed: 1,
  detail: "bare",
});
const bareByNull = tessellateStructure(shellGraphWithoutStairs, {
  masonry: null,
  seed: 1,
});
assert.deepEqual(
  Array.from(bareByLevel.parts[0]!.geometry.getIndex()!.array),
  Array.from(bareByNull.parts[0]!.geometry.getIndex()!.array),
  "The bare level must be the same geometry as laying no masonry at all.",
);
assert.deepEqual(
  Array.from(bareByLevel.parts[0]!.geometry.getAttribute("position").array),
  Array.from(bareByNull.parts[0]!.geometry.getAttribute("position").array),
  "The bare level moved a vertex the greybox path does not.",
);

const byLevel = DETAIL_LEVELS.map((level) => ({
  level,
  result: tessellateStructure(shellGraph, {
    masonry: shellRule,
    seed: 1,
    detail: level,
  }),
}));

for (let index = 1; index < byLevel.length; index += 1) {
  const finer = byLevel[index - 1]!;
  const coarser = byLevel[index]!;
  assert.ok(
    coarser.result.faceCount < finer.result.faceCount,
    `Detail "${coarser.level}" draws ${coarser.result.faceCount} faces, `
    + `no fewer than "${finer.level}" at ${finer.result.faceCount}.`,
  );
  // Every level is still made of blocks and nothing else. The reduction is
  // allowed to lay fewer stones; it is not allowed to start drawing rings.
  assert.equal(
    coarser.result.parts[0]?.geometry.getIndex()?.count,
    coarser.result.faceCount * 6,
    `Detail "${coarser.level}" draws something that is not a block.`,
  );
}

// A number, not just an ordering: a policy edit that technically reduces but
// stops being worth switching to should fail here rather than pass quietly.
const [fullLevel, coarseLevel] = byLevel;
assert.ok(
  coarseLevel!.result.faceCount * 2 < fullLevel!.result.faceCount,
  `The coarse level must be worth having: ${coarseLevel!.result.faceCount} faces `
  + `against ${fullLevel!.result.faceCount} is less than half a saving.`,
);

// The reduction changes how the wall is divided, which is exactly what moves
// the butted end reservation and the compact quoin fallback — the two paths
// these invariants exist to guard.
// Measured against the full level rather than against zero. This fixture
// already carries a coincident pair at full detail — a pre-existing property of
// the layout, not of the ladder — and pinning to zero here would be asserting
// something the coursed path has never promised. What the reduction must not do
// is make it worse, and that is exactly what these paths could do: forcing
// butted corners moves the end reservation each course ring reserves, and
// doubling the stone width changes which fallback the quoin resolver takes.
const fullCoincident = findCoincidentFaces(
  byLevel[0]!.result.parts[0]!.geometry,
).pairs;

for (const { level, result } of byLevel) {
  const geometry = result.parts[0]!.geometry;
  assert.ok(
    findCoincidentFaces(geometry).pairs <= fullCoincident,
    `Detail "${level}" has ${findCoincidentFaces(geometry).pairs} coincident face `
    + `pairs, more than the ${fullCoincident} the full level starts with.`,
  );
  assert.ok(
    (result.parts[0]?.stoneCount ?? 0) > 0,
    `Detail "${level}" reported no blocks at all.`,
  );
}

// A ramp is a stair with the risers taken out, and the test for it is that no
// horizontal tread survives. At full detail a flight presents a run of upward
// faces, one per step; at bare every face on the flight's top should be raked,
// because a single inclined plane is what replaced them.
const flightGraph = { ...shellGraph, masses: [] };

if (flightGraph.connectors.length > 0) {
  const upwardFaceCounts = (["full", "bare"] as const).map((level) => {
    const flight = tessellateStructure(flightGraph, {
      masonry: shellRule,
      seed: 1,
      detail: level,
    });
    const geometry = flight.parts[0]!.geometry;
    const normals = geometry.getAttribute("normal");
    let flat = 0;

    for (let vertex = 0; vertex < normals.count; vertex += 1) {
      if (normals.getY(vertex) > 0.999) {
        flat += 1;
      }
    }

    return flat;
  });

  assert.ok(
    upwardFaceCounts[0]! > 0,
    "The stepped flight must present level treads to begin with, or the ramp "
    + "assertion below proves nothing.",
  );
  assert.equal(
    upwardFaceCounts[1],
    0,
    `The bare flight still presents ${upwardFaceCounts[1]} level tread vertices. `
    + "A ramp has no horizontal surface on it.",
  );
}

// Detail must never reach the semantic layer — see geometry-sanity, which owns
// the config machinery needed to resolve every family at every level.
