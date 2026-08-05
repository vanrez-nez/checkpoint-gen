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
import type { MassLayoutConfig } from "../src/structure/families/mass/config";

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
