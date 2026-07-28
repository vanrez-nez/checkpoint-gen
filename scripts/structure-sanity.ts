import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { finalizeGeometry } from "../src/geometry/finalize";
import { mergeParts } from "../src/geometry/merge-parts";
import { SolidBuilder } from "../src/geometry/solid-builder";
import { StoneGeometryBuilder } from "../src/geometry/stone-builder";
import {
  DEFAULT_MASS_LAYOUT,
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
} from "../src/structure/kernel/masonry";
import { hashSeed } from "../src/geometry/random";
import { DEFAULT_STONE_CONFIG } from "../src/config/sections";
import { buildMassShell } from "../src/structure/mass/shell";
import {
  findBackfaces,
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
  type StructureGraph,
} from "../src/structure/kernel/graph";
import { isValidId } from "../src/structure/kernel/ids";
import { createSeedSet, deriveSeed, subsystemSeed } from "../src/structure/kernel/seed";
import { evaluateFrame } from "../src/structure/kernel/frame";
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

const stoneRule = toMasonry(STONEWORK_LAYOUT, DEFAULT_STONE_CONFIG);
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
  const rule = toMasonry(layout, DEFAULT_STONE_CONFIG);
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
const wander = stoneRule.gap * 1.15 + 1e-4;
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
const shellRule = toMasonry(SHELL_LAYOUT, DEFAULT_STONE_CONFIG);
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
// With the stones set square this is exactly zero. With displacement on, a
// handful of independently-set faces land within the detector's millimetre of
// each other; that is what setting stones by hand costs, and the budget is here
// so a change that turns it back into hundreds shows up as a failure.
const squareGeometry = tessellateStructure(shellGraph, {
  masonry: { ...shellRule, displacement: 0 },
  seed: DEFAULT_STONE_CONFIG.seed,
}).parts[0]?.geometry;
assert.ok(squareGeometry);
const squareCoincidence = findCoincidentFaces(squareGeometry);
assert.equal(
  squareCoincidence.pairs,
  0,
  `${squareCoincidence.pairs} coplanar overlapping faces with the stones set `
  + `square, first at ${squareCoincidence.sample}.`,
);

const coincidence = findCoincidentFaces(shellGeometry);
assert.ok(
  coincidence.pairs <= 12,
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
  seed: DEFAULT_STONE_CONFIG.seed,
}).parts[0];
assert.ok(culled);
assert.ok(
  culled.stoneCount < 3200,
  `${culled.stoneCount} stones: rings nothing can reach are being laid.`,
);
assert.equal(
  findBackfaces(culled.geometry).backfaces,
  0,
  "Culling reached a stone something could see.",
);

// Hidden faces are culled along with hidden stone. Keeping two backing rings is
// necessary to close the perpends in the ring in front, but those retained
// blocks used to emit all six sides as if they were freestanding: buried tops,
// inward walls around the sealed centre and supported cornice undersides. Since
// this builder uses four dedicated vertices per flat face, a face budget is also
// an exact vertex-buffer budget.
assert.ok(
  shellBuilder.blockFaces.length < shellBuilder.blockCount * 3.6,
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
const verticalRule = toMasonry(verticalLayout, DEFAULT_STONE_CONFIG);
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
      Math.abs(corner.x - verticalBand.lower.minX) < 1e-9
      || Math.abs(corner.x - verticalBand.lower.maxX) < 1e-9
      || Math.abs(corner.z - verticalBand.lower.minZ) < 1e-9
      || Math.abs(corner.z - verticalBand.lower.maxZ) < 1e-9),
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
const shallowTerraceRule = toMasonry(shallowTerraceLayout, DEFAULT_STONE_CONFIG);
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

// Displacement lets a corner stand proud, so the surface the graph declares is
// the line the stones are set to rather than a hard ceiling. It is bounded by
// the gap, which is what keeps the overshoot at millimetres.
assert.ok(
  shellZs.every((z) => z <= shellFront + shellRule.gap * 1.15 + 1e-9),
  "No geometry may sit further out than the gap allows a corner to wander.",
);
assert.ok(
  shellZs.some((z) => Math.abs(z - shellFront) < shellRule.gap),
  "Block faces must lie on the surface.",
);
assert.ok(
  shellZs.some((z) => Math.abs(z - (shellFront - shellRule.depth)) < 1e-6),
  `Blocks must reach ${shellRule.depth}m back into the wall, not sit on it.`,
);

// Displacement, which means here exactly what it means on the circular
// checkpoint and on a pillar: each corner of a stone's plan wanders by up to
// `min(distance from the middle x displacement, gap x 0.65)`. The cap against
// the gap is what stops a corner ever reaching its neighbour, and it is why the
// control is a ratio. Without it every stone in a course is an identical box and
// the course reads as a scored panel.
function frontCorners(displacement: number): THREE.Vector3[][] {
  const layout = { ...SHELL_LAYOUT, cornicePlacement: "none" as const };
  const stone = { ...DEFAULT_STONE_CONFIG, displacement };
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

const stillRule = toMasonry(SHELL_LAYOUT, DEFAULT_STONE_CONFIG);
assert.ok(stillRule);
// A corner is inset by up to half the gap and then wanders by up to 0.65 of it,
// so measured against the line the stones were set to it can be 1.15 gaps off.
const jitterBound = stillRule.gap * 1.15;
const still = frontCorners(0);
assert.ok(still.length > 8, `Only ${still.length} stones across the front of a course.`);

const stillFront = Math.max(...still.flat().map((corner) => corner.z));
for (const [index, face] of still.entries()) {
  for (const corner of face) {
    assert.ok(
      Math.abs(corner.z - stillFront) < 1e-9 || Math.abs(corner.z - (stillFront - stillRule.depth)) < 1e-6,
      `With displacement off, stone ${index} has a corner off the course line.`,
    );
  }
}

for (const displacement of [0.03, 0.2]) {
  const wandered = frontCorners(displacement);
  assert.equal(wandered.length, still.length, "Displacement must not change the coursing.");

  const offsets = wandered.flat()
    .map((corner) => corner.z)
    .filter((z) => Math.abs(z - stillFront) < jitterBound * 4)
    .map((z) => z - stillFront);
  assert.ok(offsets.length > 8, "Expected the front corners to be found.");
  assert.ok(
    Math.max(...offsets.map(Math.abs)) <= jitterBound + 1e-9,
    `A corner moved ${Math.max(...offsets.map(Math.abs)).toFixed(4)}m, past the `
    + `${jitterBound.toFixed(4)}m the gap allows — neighbouring stones can meet.`,
  );
  assert.ok(
    Math.max(...offsets.map(Math.abs)) > 0,
    `At ${displacement} displacement no corner moved at all.`,
  );
  // Both ways: a stone may stand a little proud as well as sit back, which is
  // what `insetAndJitter` does on the circular shell.
  assert.ok(
    Math.min(...offsets) < 0 && Math.max(...offsets) > 0,
    "Corners wander only one way, so the course still reads as a plane.",
  );
}

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
assertMassNormals(merged.geometry, "stepped pyramid");
assert.equal(merged.geometry.groups.length, 1);
assert.equal(merged.sections[MASS_SECTION]?.partCount, 1);

// --- structure definition --------------------------------------------------
// Building through the definition is the path the composer actually takes.
const layoutOnly = massStructure.build({
  layout: massStructure.cloneLayout(),
  stone: DEFAULT_STONE_CONFIG,
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

// The graph is resolved even when no section was requested, because the scene
// needs the semantic layer for the overlay whether or not geometry moved.
const graphOnly = massStructure.build({
  layout: massStructure.cloneLayout(),
  stone: DEFAULT_STONE_CONFIG,
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

  for (const reserved of [
    graph.connectors,
    graph.cells,
    graph.frames,
    graph.roofs,
    graph.attachments,
    graph.damage,
  ]) {
    assert.deepEqual(reserved, []);
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
 */
function assertMassNormals(geometry: THREE.BufferGeometry, label: string): void {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const center = new THREE.Vector3();
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  assert.ok(bounds);
  bounds.getCenter(center);

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
