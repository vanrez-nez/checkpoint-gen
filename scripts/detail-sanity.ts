import assert from "node:assert/strict";
import type * as THREE from "three";
import { createDefaultStructureConfig, sectionsForScopes } from "../src/config/structure-config";
import { subdivideLongEdges } from "../src/geometry/subdivide";
import { StructureComposer } from "../src/structure/composer";
import {
  DETAIL_LEVELS,
  DETAIL_PROFILES,
  type DetailLevel,
} from "../src/structure/kernel/detail";
import { getStructure, listStructures } from "../src/structure/registry";
import { resolveMassLayout, type MassLayoutConfig } from "../src/structure/families/mass/config";
import { resolveMassFireBowlSlots } from "../src/structure/families/mass/fire-bowl-slots";
import { DEFAULT_FIRE_BOWL_CONFIG } from "../src/props/fire-bowl/config";
import {
  overlappingTerminals,
  summitTerminalCaps,
  unionCells,
} from "../src/structure/connector/terminal";

/**
 * The detail ladder at the composer.
 *
 * Its own script rather than another block on the end of geometry-sanity, and
 * for a mundane reason: every composition here retains a full set of vertex
 * buffers, and appended to a script that already holds three thousand lines of
 * them the process runs out of heap before reaching the first assertion. A
 * separate entry point costs one line in `npm test` and keeps both scripts
 * inside their budget.
 */

const massDefinition = getStructure("mass");


// Cost has to fall for every registered structure, not just the ones that run
// through tessellateStructure. Asserting against the registry rather than a
// list is what catches circular — which takes a different path entirely — and
// any family added later that forgets to thread the level through. One sweep
// collects both facts, because a composition retains enough that walking every
// family at every level twice is the difference between fitting in memory and
// not; each composer is released as soon as its numbers are read.
for (const definition of listStructures()) {
  const byLevel = DETAIL_LEVELS.map((level) => {
    const levelConfig = createDefaultStructureConfig();
    levelConfig.typeId = definition.id;
    levelConfig.view.detailLevel = level;
    const composer = new StructureComposer();
    const built = composer.build(levelConfig);
    const observed = {
      level,
      triangles: built.totals.triangleCount,
      anchors: structuredClone(built.anchors),
    };
    built.geometry.dispose();
    composer.dispose();
    return observed;
  });

  for (let index = 1; index < byLevel.length; index += 1) {
    const finer = byLevel[index - 1]!;
    const coarser = byLevel[index]!;
    assert.ok(
      coarser.triangles < finer.triangles,
      `Structure "${definition.id}" draws ${coarser.triangles} triangles at `
      + `"${coarser.level}", no fewer than ${finer.triangles} at "${finer.level}".`,
    );
    // Anchors are level-invariant. The offering stands on one, so a level that
    // moved one would sink the statue into the summit or float it above.
    assert.deepEqual(
      coarser.anchors,
      byLevel[0]!.anchors,
      `Structure "${definition.id}" publishes different anchors at `
      + `"${coarser.level}" than at "${byLevel[0]!.level}".`,
    );
  }

  // A level change must invalidate nothing. It does not make any section stale;
  // it asks for the same sections somewhere else, and the composer works out
  // what is missing on its own.
  assert.equal(
    sectionsForScopes(["detail"], definition).size,
    0,
    `Structure "${definition.id}" maps the detail scope onto a section, which `
    + "would make a level change invalidate work it should be reusing.",
  );
}

// The staleness trap itself, and the reason the cache sweeps every level rather
// than only the one on screen. Edit the layout while sitting on a coarse level,
// then go back: the full level must have been evicted too, or it serves
// geometry built from configuration the user has since changed.
// Both cases below switch level the way the pane does — with the empty section
// set the detail scope resolves to. Passing nothing would mean "invalidate
// everything", which is a different instruction and would test nothing.
const switchLevel = sectionsForScopes(["detail"], massDefinition);

const staleConfig = createDefaultStructureConfig();
staleConfig.typeId = "mass";
const staleComposer = new StructureComposer();
staleComposer.build(staleConfig);
staleConfig.view.detailLevel = "bare";
staleComposer.build(staleConfig, switchLevel);
(staleConfig.layouts.mass as MassLayoutConfig).footprintWidth = 30;
staleComposer.build(staleConfig, sectionsForScopes(["layout"], massDefinition));
staleConfig.view.detailLevel = "full";
const afterRoundTrip = staleComposer.build(staleConfig, switchLevel);

const freshConfig = createDefaultStructureConfig();
freshConfig.typeId = "mass";
(freshConfig.layouts.mass as MassLayoutConfig).footprintWidth = 30;
const freshBuild = new StructureComposer().build(freshConfig);

assertSamePositions(
  afterRoundTrip.geometry,
  freshBuild.geometry,
  "Returning to a level served geometry built from stale configuration.",
);
assert.equal(afterRoundTrip.detail, "full");

// And the other half of the bargain: a level already built is reused rather
// than regenerated. Probed by mutating the config *without* telling the
// composer, which a correct cache must not notice.
const warmConfig = createDefaultStructureConfig();
warmConfig.typeId = "mass";
const warmComposer = new StructureComposer();
const warmFull = warmComposer.build(warmConfig);
const warmFullPositions = Float32Array.from(
  warmFull.geometry.getAttribute("position").array,
);
warmConfig.view.detailLevel = "bare";
warmComposer.build(warmConfig, switchLevel);
(warmConfig.layouts.mass as MassLayoutConfig).footprintWidth = 21;
warmConfig.view.detailLevel = "full";
const warmAgain = warmComposer.build(warmConfig, switchLevel);

assertSameValues(
  warmAgain.geometry.getAttribute("position").array,
  warmFullPositions,
  "A level that was already built must be reused, not regenerated.",
);

// The end-to-end check that the ladder is a ladder. Preparing a level for the
// sun bake subdivides it, and subdivision cost tracks surface area rather than
// stone count — so without scaling the edge bound per level, the bare level
// would be refined straight back to the vertex count the full level carries and
// the whole feature would quietly stop saving anything.
const preparedVertexCounts = (["full", "bare"] as const).map((level) => {
  const composer = new StructureComposer();
  const built = composer.build(preparedTestConfig(level));
  const refined = subdivideLongEdges(
    built.geometry,
    1.5 * DETAIL_PROFILES[level].edgeScale,
  );
  const count = refined.geometry.getAttribute("position").count;

  if (refined.geometry !== built.geometry) {
    refined.geometry.dispose();
  }

  built.geometry.dispose();
  composer.dispose();
  return count;
});

assert.ok(
  preparedVertexCounts[1]! < preparedVertexCounts[0]!,
  `After preparation the bare level carries ${preparedVertexCounts[1]} vertices `
  + `against the full level's ${preparedVertexCounts[0]}. The edge bound is not `
  + "being scaled by the level.",
);

/**
 * A smaller mass than the default, but not a degenerate one.
 *
 * Subdivision is the most allocation-hungry pass in the project and this runs
 * it twice, so the footprint is trimmed — but only as far as the summit's
 * portal still fits the wall it is cut into, which is what the layout validator
 * checks. The assertion is about the ratio between levels, and a smaller
 * structure shows that just as well as a large one.
 */
function preparedTestConfig(level: DetailLevel) {
  const detailConfig = createDefaultStructureConfig();
  detailConfig.typeId = "mass";
  detailConfig.view.detailLevel = level;
  const massLayout = detailConfig.layouts.mass as MassLayoutConfig;
  massLayout.footprintWidth = 14;
  massLayout.footprintDepth = 12;
  massLayout.bandCount = 1;
  return detailConfig;
}
console.log(`Detail sanity passed: ${listStructures().length} structures across ${DETAIL_LEVELS.length} levels.`);

/**
 * Compares two vertex buffers without letting a failure become the problem.
 *
 * `assert.deepEqual` on a pair of hundred-thousand-element arrays builds a diff
 * of both in full when they differ, which exhausts the heap before it can print
 * anything — a failing assertion that kills the process with no message is
 * worse than no assertion. This reports the first index that disagrees instead.
 */
function assertSameValues(
  actual: ArrayLike<number>,
  expected: ArrayLike<number>,
  message: string,
): void {
  assert.equal(
    actual.length,
    expected.length,
    `${message} (lengths ${actual.length} and ${expected.length})`,
  );

  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expected[index]) {
      assert.fail(
        `${message} (first difference at ${index}: `
        + `${actual[index]} against ${expected[index]})`,
      );
    }
  }
}

function assertSamePositions(
  actual: THREE.BufferGeometry,
  expected: THREE.BufferGeometry,
  message: string,
): void {
  assertSameValues(
    actual.getAttribute("position").array,
    expected.getAttribute("position").array,
    message,
  );
}

// Summit terminals that run into each other.
//
// Two stairs arriving on one summit from different sides put their inner
// parapet caps in the same place. The pair is one pier, and a pier carries one
// bowl — but only when the caps genuinely overlap, which is a property of the
// layout rather than something to assume.
const terminalCases = [0.3, 0.2].map((stairWidthRatio) => {
  const terminalConfig = createDefaultStructureConfig();
  terminalConfig.typeId = "mass";
  const massLayout = terminalConfig.layouts.mass as MassLayoutConfig;
  massLayout.stairWidthRatio = stairWidthRatio;
  const graph = resolveMassLayout(massLayout);
  const slots = resolveMassFireBowlSlots(
    massLayout,
    graph,
    DEFAULT_FIRE_BOWL_CONFIG,
  );
  const top = slots.filter((slot) => slot.level === "top");

  return {
    stairWidthRatio,
    overlaps: overlappingTerminals(
      graph.connectors.flatMap(summitTerminalCaps),
    ).length,
    top,
    bottom: slots.filter((slot) => slot.level === "bottom").length,
  };
});

const [collided, clear] = terminalCases;

assert.ok(
  collided!.overlaps > 0,
  "The wide-stair case must actually collide, or the merge below proves nothing.",
);
assert.equal(
  clear!.overlaps,
  0,
  "The narrow-stair case must not collide, or the gate below proves nothing.",
);

// One bowl per collision, and none of the originals left behind.
assert.equal(
  collided!.top.length,
  collided!.overlaps,
  `${collided!.overlaps} merged piers carry ${collided!.top.length} summit bowls.`,
);
assert.ok(
  collided!.top.every((slot) => slot.merged),
  "A collided summit must carry only merged bowls, never a survivor of the pair.",
);

// The gate: nothing changes where nothing collides.
assert.ok(
  clear!.top.every((slot) => !slot.merged),
  "A summit with no collision must not merge anything.",
);
assert.equal(
  clear!.top.length,
  collided!.top.length * 2,
  "Every uncollided stair should still carry both of its own summit bowls.",
);

// The foot is untouched either way — it is the summit the flights converge on.
assert.equal(
  collided!.bottom,
  clear!.bottom,
  "Merging summit caps must not disturb the bowls at the foot of the stairs.",
);

// A merged bowl has to stand on stone. The shared region is the only part of a
// corner merge every cap covers, so the slot must land inside both.
for (const slot of collided!.top) {
  const caps = resolveMassLayout(
    (() => {
      const merged = createDefaultStructureConfig();
      merged.typeId = "mass";
      return merged.layouts.mass as MassLayoutConfig;
    })(),
  ).connectors.flatMap(summitTerminalCaps);
  const standing = caps.filter(
    (cap) => slot.x >= cap.minX - 1e-6 && slot.x <= cap.maxX + 1e-6
      && slot.z >= cap.minZ - 1e-6 && slot.z <= cap.maxZ + 1e-6,
  );
  assert.ok(
    standing.length >= 2,
    `Merged bowl ${slot.id} stands on ${standing.length} caps; it should sit on `
    + "the region both of its terminals share.",
  );
}

// The merged terminal's plan decomposition.
//
// Two properties matter and neither is visible from a screenshot: the cells
// must cover the union exactly, and no flank may be left open where another
// cell stands against it. A missed cell is a hole; a wrongly open flank is two
// faces at the same depth.
const soloCells = unionCells([{ minX: 0, maxX: 2, minZ: 0, maxZ: 2 }]);
assert.equal(soloCells.length, 1, "A lone rectangle needs no cutting up.");
assert.ok(
  soloCells[0]!.open.every(Boolean),
  "A lone rectangle stands in open air on every flank.",
);

// The corner overlap of the summit, in miniature. Two 2x2 squares offset by
// one leave a step on each side of the diagonal, and each step gets the wedge
// that turns its two right angles into one.
const cornerRects = [
  { minX: 0, maxX: 2, minZ: 0, maxZ: 2 },
  { minX: 1, maxX: 3, minZ: 1, maxZ: 3 },
];
const cornerCells = unionCells(cornerRects);
const area = (cell: { ring: readonly { x: number; z: number }[] }) => {
  let total = 0;

  for (let index = 0; index < cell.ring.length; index += 1) {
    const here = cell.ring[index]!;
    const next = cell.ring[(index + 1) % cell.ring.length]!;
    total += here.x * next.z - next.x * here.z;
  }

  return Math.abs(total) / 2;
};
const covered = cornerCells.reduce((total, cell) => total + area(cell), 0);

// 7 for the union of the two squares, plus half a cell for each of the two
// wedges that fill the steps.
assert.ok(
  Math.abs(covered - 8) < 1e-9,
  `The cells cover ${covered}; the mitred union is 8.`,
);

// A wedge is the cell that closed on itself: a triangle written as four
// corners repeats one. Counting open flanks would not do — a filled cell
// hemmed in on three sides also has exactly one.
const wedges = cornerCells.filter(
  (cell) => Math.abs(cell.ring[0]!.x - cell.ring[3]!.x) < 1e-9
    && Math.abs(cell.ring[0]!.z - cell.ring[3]!.z) < 1e-9,
);
assert.equal(
  wedges.length,
  2,
  `A corner overlap has two steps and so two wedges; found ${wedges.length}.`,
);

for (const wedge of wedges) {
  // The one open edge is the diagonal, and a diagonal is neither axis.
  const index = wedge.open.findIndex(Boolean);
  assert.ok(index >= 0, "A wedge must expose its diagonal.");
  const from = wedge.ring[index]!;
  const to = wedge.ring[(index + 1) % wedge.ring.length]!;
  assert.ok(
    Math.abs(from.x - to.x) > 1e-9 && Math.abs(from.z - to.z) > 1e-9,
    "A wedge's open edge must run diagonally; that is the whole point of it.",
  );
}

// And the whole point of the merge: one solid, no faces buried inside it.
const mergedMassConfig = createDefaultStructureConfig();
mergedMassConfig.typeId = "mass";
const mergedMass = new StructureComposer().build(mergedMassConfig);
assert.ok(
  overlappingTerminals(
    resolveMassLayout(mergedMassConfig.layouts.mass as MassLayoutConfig)
      .connectors.flatMap(summitTerminalCaps),
  ).length > 0,
  "The default mass must still collide its terminals for this to mean anything.",
);
mergedMass.geometry.dispose();
