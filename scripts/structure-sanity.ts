import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { finalizeGeometry } from "../src/geometry/finalize";
import { mergeParts } from "../src/geometry/merge-parts";
import { SolidBuilder } from "../src/geometry/solid-builder";
import {
  StoneGeometryBuilder,
  displacementDistance,
  insetAndJitter,
} from "../src/geometry/stone-builder";
import {
  DEFAULT_MASS_LAYOUT,
  DEFAULT_MASS_STONE_CONFIG,
  HEIGHT_CURVE_OPTIONS,
  cloneMassLayout,
  heightCurveBezier,
  toHeightCurve,
  toMasonry,
  toStructureSpec,
  validateMassLayout,
  type MassLayoutConfig,
} from "../src/structure/families/mass/config";
import {
  divideCourseRing,
  divideCourses,
  divideRun,
  masonrySeed,
  type MasonryRule,
} from "../src/structure/kernel/masonry";
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
  patchIndex,
  serializeGraph,
  STRUCTURE_SCHEMA_VERSION,
  type ElevationBandRecord,
  type StructureGraph,
} from "../src/structure/kernel/graph";
import { isValidId } from "../src/structure/kernel/ids";
import { createSeedSet, deriveSeed, subsystemSeed } from "../src/structure/kernel/seed";
import { evaluateFrame, rectWidth } from "../src/structure/kernel/frame";
import { buildStair } from "../src/structure/connector/build";
import { stairSteps } from "../src/structure/connector/stair";
import { PATCH_ROLES } from "../src/structure/kernel/patch";
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
    corniceBands: DEFAULT_MASS_LAYOUT.cornicePlacement,
    stoneworkEnabled: DEFAULT_MASS_LAYOUT.stoneworkEnabled,
    course: DEFAULT_MASS_LAYOUT.courseHeight,
    stone: DEFAULT_MASS_LAYOUT.stoneWidth,
    stoneDepth: DEFAULT_MASS_LAYOUT.stoneDepth,
    corners: DEFAULT_MASS_LAYOUT.cornerRule,
    stairEnabled: DEFAULT_MASS_LAYOUT.stairEnabled,
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
  },
  {
    seed: 741,
    gap: 0.026,
    sizeVariation: 0.2,
    displacement: 0.12,
    width: 24,
    depth: 18,
    bands: 3,
    height: 8.25,
    batter: 12,
    heightCurve: "even",
    corniceBands: "none",
    stoneworkEnabled: true,
    course: 0.86,
    stone: 1.65,
    stoneDepth: 0.75,
    corners: "butted",
    stairEnabled: true,
    stairWidth: 0.3,
    stairRiser: 0.26,
    stairTread: 0.32,
    stairTiles: 5,
    stairSides: "stepped_parapet",
    stairParapetWidth: 0.75,
    stairParapetHeight: 0.55,
    steppedParapetCorniceProjection: 0,
    steppedParapetCorniceHeight: 0,
    stairParapetCorniceProjection: 0.2,
    stairParapetCorniceHeight: 0.25,
  },
  "The Mass controls must open with the approved defaults.",
);

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

/** The outward normal of a face read back from the buffer. */
function faceNormal(face: readonly THREE.Vector3[]): THREE.Vector3 {
  return new THREE.Vector3().crossVectors(
    face[1]!.clone().sub(face[0]!),
    face[2]!.clone().sub(face[0]!),
  ).normalize();
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
  const selected = { ...cloneMassLayout(), heightCurve: mode };
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
  ...cloneMassLayout(),
  heightCurve: "custom",
  heightCurveBezier: [0.25, 1.5, 0.75, -0.5],
}));
// A handle's x, though, is bounded by the curve's own domain.
assert.throws(
  () => validateMassLayout({
    ...cloneMassLayout(),
    heightCurveBezier: [1.4, 0.5, 0.75, 0.5],
  }),
  /handle 1 x must be between 0 and 1/,
);
assert.throws(
  () => validateMassLayout({
    ...cloneMassLayout(),
    heightCurveBezier: [0.25, 0.5, 0.75] as never,
  }),
  /must be four finite numbers/,
);
assert.throws(
  () => validateMassLayout({
    ...cloneMassLayout(),
    stairTilesPerStep: 0,
  }),
  /Stair tiles per step must be an integer from 1 to 32/,
);
assert.throws(
  () => validateMassLayout({
    ...cloneMassLayout(),
    stairTilesPerStep: 4.5,
  }),
  /Stair tiles per step must be an integer from 1 to 32/,
);

// A falling curve reaches the pane as a notice on a structure that still builds.
const fallingGraph = generateStructure(toStructureSpec({
  ...cloneMassLayout(),
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

// --- golden fixtures -------------------------------------------------------
// Committed graphs, not committed meshes. A retuned proportion shows up as a
// readable diff on the numbers that changed, which is the whole reason these are
// serialized semantics rather than a vertex-buffer hash.
const FIXTURES: readonly { readonly name: string; readonly layout: MassLayoutConfig }[] = [
  {
    name: "low-platform",
    layout: {
      ...cloneMassLayout(),
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
      ...cloneMassLayout(),
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
      ...cloneMassLayout(),
      bandCount: 1,
      totalHeight: 1.8,
      batterAngle: 8,
    },
  },
  {
    name: "asymmetric-setbacks",
    layout: {
      ...cloneMassLayout(),
      bandCount: 4,
      totalHeight: 6,
      frontSetbackScale: 1.8,
      rearSetbackScale: 0.2,
      sideSetbackScale: 1,
      forecourtDepth: 5,
    },
  },
  {
    name: "corniced-terraces",
    layout: {
      ...cloneMassLayout(),
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
];

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
    mutate: (spec) => ({ ...spec, stair: { ...spec.stair!, layout: "four_sided" } }),
  },
  {
    label: "stair elevation mode",
    code: "stair.elevation_mode_unimplemented",
    mutate: (spec) => ({ ...spec, stair: { ...spec.stair!, elevationMode: "band_local" } }),
  },
  {
    label: "stair side treatment",
    code: "stair.side_treatment_unimplemented",
    mutate: (spec) => ({
      ...spec,
      stair: { ...spec.stair!, sideTreatment: "serpent_like_profile" },
    }),
  },
  {
    label: "stair landing rule",
    code: "stair.landing_rule_unimplemented",
    mutate: (spec) => ({ ...spec, stair: { ...spec.stair!, landingRule: "at_every_terrace" } }),
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
    toStructureSpec({ ...cloneMassLayout(), batterAngle }),
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
  ...cloneMassLayout(),
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
const stairDefault = generateStructure(toStructureSpec(cloneMassLayout()));
assert.equal(stairDefault.connectors.length, 1, "The default Mass carries one stair.");
const stairRecord = stairDefault.connectors[0]!;
const stairPatches = patchIndex(stairDefault);
const occlusionSteps = stairSteps(stairRecord);
const occlusionStep = occlusionSteps[Math.floor(occlusionSteps.length * 0.5)]!;
const occlusionZ0 = occlusionStep.zBack + stairRecord.tread * 0.2;
const occlusionZ1 = occlusionStep.zFront - stairRecord.tread * 0.2;
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
    occlusionStep.zBack + stairRecord.tread * 0.2,
    lowerStep.zBack + stairRecord.tread * 0.2,
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
  ...cloneMassLayout(),
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
const stairless = generateStructure(toStructureSpec({
  ...cloneMassLayout(),
  stairEnabled: false,
}));
assert.deepEqual(stairless.connectors, []);
assert.ok(
  stairless.patches.every((patch) => !patch.role.startsWith("stair")),
);
assert.ok(
  stairless.patches.every((patch) =>
    patch.regions.every((region) => !region.tags.includes("stair"))),
);
assert.deepEqual(
  stairless.masses,
  stairDefault.masses,
  "Removing the stair must not move the massing.",
);

// A stair wider than the summit it arrives on is narrowed, and says so.
const clampedStair = generateStructure(toStructureSpec({
  ...cloneMassLayout(),
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
  ...cloneMassLayout(),
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
  ...cloneMassLayout(),
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
  ...cloneMassLayout(),
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
  ...cloneMassLayout(),
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
  ...cloneMassLayout(),
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
  ...cloneMassLayout(),
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
const flatProbeZ0 = flatProbeStep.zBack + flatParapetRecord.tread * 0.2;
const flatProbeZ1 = flatProbeStep.zFront - flatParapetRecord.tread * 0.2;
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
const stairRule = toMasonry(cloneMassLayout(), DEFAULT_MASS_STONE_CONFIG);
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
  ...cloneMassLayout(),
  stairEnabled: false,
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
  ...cloneMassLayout(),
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
  stairEnabled: false,
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
  ...cloneMassLayout(),
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
  ...cloneMassLayout(),
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
  ...cloneMassLayout(),
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
const cornerLayout = cloneMassLayout();
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
assert.equal(merged.geometry.groups.length, 1);
assert.equal(merged.sections[MASS_SECTION]?.partCount, 1);

// --- structure definition --------------------------------------------------
// Building through the definition is the path the composer actually takes.
const layoutOnly = massStructure.build({
  layout: massStructure.cloneLayout(),
  stone: DEFAULT_MASS_STONE_CONFIG,
  bevel: undefined as never,
  pillar: undefined as never,
  fireBowl: undefined as never,
  sections: new Set([MASS_SECTION]),
});
assert.equal(layoutOnly.parts.length, 1);
assert.ok(layoutOnly.graph, "The mass structure must report its graph.");
assert.equal(layoutOnly.anchors.flames.length, 0);
assert.equal(layoutOnly.anchors.glows.length, 0);
assert.equal(layoutOnly.anchors.offering, null);

const buildWithStairTiles = (stairTilesPerStep: number) => massStructure.build({
  layout: { ...massStructure.cloneLayout(), stairTilesPerStep },
  stone: DEFAULT_MASS_STONE_CONFIG,
  bevel: undefined as never,
  pillar: undefined as never,
  fireBowl: undefined as never,
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
  fireBowl: undefined as never,
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

console.log(
  `Structure sanity passed: ${FIXTURES.length} fixtures,`
  + ` ${pyramid.patches.length} pyramid patches,`
  + ` ${merged.totals.vertexCount} tessellated vertices.`,
);

// --- helpers ---------------------------------------------------------------

function assertGraphInvariants(graph: StructureGraph, label: string): void {
  assert.equal(graph.schemaVersion, STRUCTURE_SCHEMA_VERSION);
  assert.equal(graph.units, "meters");
  assert.ok(graph.masses.length > 0, `${label}: no mass was generated.`);

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

    // Reserved containers stay empty until the phases that fill them arrive.
    assert.deepEqual(patch.features, []);
    assert.deepEqual(patch.anchors, []);
  }

  // Reserved containers stay empty until the phases that fill them arrive;
  // connectors are filled by the stair system and validated below.
  for (const reserved of [
    graph.cells,
    graph.frames,
    graph.roofs,
    graph.attachments,
    graph.damage,
  ]) {
    assert.deepEqual(reserved, []);
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
    assert.ok(
      Math.abs(connector.flightRect.maxZ - connector.flightRect.minZ - connector.run) < 1e-9,
      `${label}: connector flight rect disagrees with its run.`,
    );
    assert.ok(
      Math.abs(connector.flightRect.maxX - connector.flightRect.minX - connector.width) < 1e-9,
      `${label}: connector flight rect disagrees with its width.`,
    );
    assert.ok(connector.riser > 0 && connector.tread > 0, `${label}: degenerate step.`);
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
    const sideWidth = connector.parapet?.width ?? 0;
    return {
      minX: connector.flightRect.minX - sideWidth - 1e-4,
      maxX: connector.flightRect.maxX + sideWidth + 1e-4,
      minZ: connector.flightRect.minZ - 1e-4,
      maxZ: connector.flightRect.maxZ + 1e-4,
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

    if (facing.y > 0.9) {
      continue;
    }

    // A wall. Battered walls tilt their normal upward, never downward, and the
    // horizontal component always points away from the mass's vertical axis.
    assert.ok(
      facing.y >= -1e-4,
      `${label}: vertex ${index} is a wall whose normal tilts downward.`,
    );

    if (connectorSpans.some((span) =>
      point.x >= span.minX && point.x <= span.maxX
      && point.z >= span.minZ && point.z <= span.maxZ)) {
      continue;
    }

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
