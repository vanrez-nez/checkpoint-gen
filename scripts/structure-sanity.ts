import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { finalizeGeometry } from "../src/geometry/finalize";
import { mergeParts } from "../src/geometry/merge-parts";
import { SolidBuilder } from "../src/geometry/solid-builder";
import {
  DEFAULT_MASS_LAYOUT,
  cloneMassLayout,
  toStructureSpec,
  validateMassLayout,
  type MassLayoutConfig,
} from "../src/structure/families/mass/config";
import {
  LINEAR_CURVE,
  LINEAR_HANDLES,
  distributeByCurve,
  evaluateCurve,
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
  WALKABLE_TERRACE_WIDTH,
  wallProfileForBatter,
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

// --- solid builder ---------------------------------------------------------
// A tapered, capped band is the shape every battered elevation band reduces to,
// so its normals have to come out right before anything is built on top of it.
const taperedBuilder = new SolidBuilder();
taperedBuilder.addLoft(rect(1, 1), rect(0.5, 0.5), 0, 1);
taperedBuilder.addCap(rect(1, 1), 0, "down");
taperedBuilder.addCap(rect(0.5, 0.5), 1, "up");

const tapered = finalizeGeometry(taperedBuilder);
assert.equal(taperedBuilder.pieceCount, 3);
assert.equal(tapered.vertexCount, 4 * 4 + 4 + 4);
assert.equal(tapered.triangleCount, 4 * 2 + 2 + 2);
assertOutwardNormals(tapered.geometry, "tapered band");

// Winding is normalised on entry, so a caller that authors outlines the other
// way round gets the same solid rather than an inside-out one.
const reversedBuilder = new SolidBuilder();
reversedBuilder.addLoft([...rect(1, 1)].reverse(), [...rect(0.5, 0.5)].reverse(), 0, 1);
reversedBuilder.addCap([...rect(1, 1)].reverse(), 0, "down");
reversedBuilder.addCap([...rect(0.5, 0.5)].reverse(), 1, "up");
assertOutwardNormals(finalizeGeometry(reversedBuilder).geometry, "reversed band");

// A terrace is the ring left exposed where the band above sets back. Emitting it
// as a ring rather than a second full cap is what keeps stacked bands from
// leaving two coplanar faces fighting for the same depth.
const ringBuilder = new SolidBuilder();
ringBuilder.addRing(rect(1, 1), rect(0.5, 0.5), 2, "up");
const ring = finalizeGeometry(ringBuilder);
assert.equal(ring.vertexCount, 4 * 4);
assert.equal(ring.triangleCount, 4 * 2);
assertAllNormalsFace(ring.geometry, new THREE.Vector3(0, 1, 0), "terrace ring");

const downRingBuilder = new SolidBuilder();
downRingBuilder.addRing(rect(1, 1), rect(0.5, 0.5), 2, "down");
assertAllNormalsFace(
  finalizeGeometry(downRingBuilder).geometry,
  new THREE.Vector3(0, -1, 0),
  "soffit ring",
);

// The buffers a builder accumulates must satisfy the shared part contract, or
// mergeParts rejects them at composition time rather than here.
for (const [label, result] of [["tapered", tapered], ["ring", ring]] as const) {
  const { geometry } = result;
  assert.ok(geometry.getIndex(), `${label}: geometry must be indexed.`);
  for (const attribute of ["position", "normal", "uv", "vertexAo", "color"]) {
    assert.ok(geometry.getAttribute(attribute), `${label}: missing ${attribute}.`);
  }
  for (const key of ["baseUvs", "vertexAoBase", "bakedShadowBase"]) {
    assert.ok(geometry.userData[key], `${label}: missing userData.${key}.`);
  }
}

// Mismatched or degenerate outlines are a caller error, not a silent skip.
assert.throws(() => new SolidBuilder().addLoft(rect(1, 1), rect(1, 1).slice(1), 0, 1));
assert.throws(() => new SolidBuilder().addRing(rect(1, 1), rect(1, 1).slice(1), 0, "up"));
assert.throws(() => new SolidBuilder().addCap(rect(1, 1).slice(2), 0, "up"));

// --- shaping curves --------------------------------------------------------
// A linear curve and the handles that reproduce a straight line have to agree,
// or switching a control from Linear to Custom would visibly jump.
for (const x of [0, 0.13, 0.25, 0.5, 0.75, 1]) {
  assert.ok(Math.abs(evaluateCurve(LINEAR_CURVE, x) - x) < 1e-6);
  assert.ok(
    Math.abs(evaluateCurve({ kind: "custom", ...LINEAR_HANDLES }, x) - x) < 1e-6,
    `Linear handles must evaluate to a straight line at x=${x}.`,
  );
}

// Endpoints are pinned, so a curve always spans the whole total.
for (const handles of [
  { p1: { x: 0.1, y: 0.9 }, p2: { x: 0.9, y: 0.95 } },
  { p1: { x: 0.9, y: 0.05 }, p2: { x: 0.95, y: 0.2 } },
]) {
  const curve = { kind: "custom", ...handles } as const;
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

const heavyBase = distributeByCurve(4, 12, {
  kind: "custom",
  p1: { x: 0.1, y: 0.6 },
  p2: { x: 0.5, y: 0.9 },
});
assert.equal(heavyBase.nonMonotonic, false);
assert.ok(Math.abs(sum(heavyBase.values) - 12) < 1e-9);
for (let index = 1; index < heavyBase.values.length; index += 1) {
  assert.ok(
    (heavyBase.values[index] ?? 0) < (heavyBase.values[index - 1] ?? 0),
    "A front-loaded curve must give every band a smaller rise than the one below.",
  );
}

// Handles confined to [0, 1] can never describe a falling curve — the cubic's
// slope stays non-negative across that whole square — so no combination the pane
// can produce asks for a band of zero height. Swept rather than argued, because
// it is the property that lets the handles be dragged freely.
for (let y1 = 0; y1 <= 1.0001; y1 += 0.125) {
  for (let y2 = 0; y2 <= 1.0001; y2 += 0.125) {
    for (const [x1, x2] of [[0.05, 0.95], [0.5, 0.5], [0.9, 0.1]] as const) {
      const split = distributeByCurve(6, 9, {
        kind: "custom",
        p1: { x: x1, y: y1 },
        p2: { x: x2, y: y2 },
      });
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

// A hand-authored curve reaching outside that range can fall, which would ask
// for a band of zero or negative height. That is floored and reported rather
// than silently produced.
const dipping = distributeByCurve(5, 10, {
  kind: "custom",
  p1: { x: 0.25, y: 1.5 },
  p2: { x: 0.75, y: -0.5 },
});
assert.equal(dipping.nonMonotonic, true);
assert.ok(Math.abs(sum(dipping.values) - 10) < 1e-9);
for (const value of dipping.values) {
  assert.ok(value > 0, "Every band must keep a positive rise.");
}

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
      heightCurveP1: { x: 0.16, y: 0.5 },
      heightCurveP2: { x: 0.5, y: 0.86 },
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
  stone: undefined as never,
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
  stone: undefined as never,
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
 * away from the vertical axis, horizontal faces point up, and exactly one face
 * points down, at the bottom of the stack.
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
  let downFacing = 0;

  for (let index = 0; index < position.count; index += 1) {
    point.fromBufferAttribute(position, index);
    facing.fromBufferAttribute(normal, index);

    assert.ok(
      Math.abs(facing.length() - 1) < 1e-3,
      `${label}: vertex ${index} normal is degenerate.`,
    );

    if (facing.y < -0.9) {
      downFacing += 1;
      assert.ok(
        Math.abs(point.y - bounds.min.y) < 1e-4,
        `${label}: vertex ${index} faces down but is not at the base.`,
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

  assert.ok(downFacing > 0, `${label}: the stack was never closed underneath.`);
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
