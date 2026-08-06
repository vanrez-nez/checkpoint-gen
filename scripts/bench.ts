/**
 * Per-stage timings for a structure rebuild.
 *
 * Exists because the only generation timer in the app measured the wrong third
 * of the work and the sun-bake timer measured the wrong bake, so every claim
 * about what a knob costs was guesswork. Measured on a default mass, generation
 * is 7% of a rebuild and the sun bake is 72% — the opposite of what the module
 * layout suggests, and not something anyone was going to guess.
 *
 * This mirrors `MainScene.prepareStructureGeometry`, which cannot be imported
 * here: `scene/main.ts` pulls `three/webgpu` and the GLTF loader, neither of
 * which exists in Node. The bounds and sample counts it uses come from
 * `geometry/shading-budget.ts` rather than being restated, so a retuned bound
 * moves this readout with it instead of quietly invalidating it.
 *
 * Run with `npm run bench`. Not part of `npm test` — it is a measurement, and a
 * measurement that fails the build on a slow machine is a nuisance rather than
 * a signal.
 */

import assert from "node:assert/strict";
import { createDefaultStructureConfig } from "../src/config/structure-config";
import { StructureComposer } from "../src/structure/composer";
import { subdivideLongEdges } from "../src/geometry/subdivide";
import { SunBakeScene } from "../src/geometry/sun-bake";
import {
  SHADOW_EDGE_BOUND,
  SUN_BAKE_MAX_EDGE,
  SUN_BAKE_SAMPLES,
  SUN_BAKE_SOFTNESS,
  SUN_CLASSIFY_SAMPLES,
  sunDirection,
} from "../src/geometry/shading-budget";
import { DETAIL_LEVELS, DETAIL_PROFILES } from "../src/structure/kernel/detail";
import { getStructure, listStructures } from "../src/structure/registry";
import { DEFAULT_ILLUMINATION_CONFIG } from "../src/config/sections";
import type { DetailLevel } from "../src/structure/kernel/detail";

/** Stages in pipeline order, so a run reads top to bottom like the code does. */
const STAGES = [
  "generate",
  "subdivide1",
  "bvh1",
  "classify",
  "bake1",
  "subdivide2",
  "bvh2",
  "bake2",
] as const;

type Stage = (typeof STAGES)[number];

/**
 * What a still-moving control pays: everything up to and including the cheap
 * classification bake, and nothing after it.
 */
const INTERIM_STAGES = ["generate", "subdivide1", "bvh1", "classify"] as const;

/**
 * What the rebuild after the release pays.
 *
 * It repeats `generate`, `subdivide1` and `bvh1` because a settle is a second
 * whole rebuild rather than a continuation — the composer serves the same parts
 * from cache, but the merge and the first subdivision run again. Counting them
 * twice is the honest reading of a drag-then-release.
 */
const SETTLED_STAGES = [
  "generate",
  "subdivide1",
  "bvh1",
  "bake1",
  "subdivide2",
  "bvh2",
  "bake2",
] as const;

interface Run {
  readonly timings: Readonly<Record<Stage, number>>;
  readonly merged: number;
  readonly pass1: number;
  readonly pass2: number;
}

const direction = sunDirection(
  DEFAULT_ILLUMINATION_CONFIG.keyAzimuth,
  DEFAULT_ILLUMINATION_CONFIG.keyElevation,
);

const only = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const levels: readonly DetailLevel[] = process.argv.includes("--full-only")
  ? ["full"]
  : DETAIL_LEVELS;

function measure(typeId: string, detail: DetailLevel): Run {
  const config = createDefaultStructureConfig();
  config.typeId = typeId;
  config.view.detailLevel = detail;

  const composer = new StructureComposer();
  // Warm: the first build of a family pays module-level lazy work and a cold
  // JIT, neither of which a user ever pays twice.
  composer.build(config);

  const timings = {} as Record<Stage, number>;
  const at = <T>(stage: Stage, run: () => T): T => {
    const started = performance.now();
    const value = run();
    timings[stage] = performance.now() - started;
    return value;
  };

  // Every section invalidated, which is what a layout knob does on three of the
  // four families anyway — so this measures the case that actually hurts.
  const composition = at("generate", () =>
    composer.build(config, getStructure(typeId).sections));
  const merged = composition.geometry.getAttribute("position").count;

  const bound = SUN_BAKE_MAX_EDGE * DETAIL_PROFILES[detail].edgeScale;
  const refined = at("subdivide1", () =>
    subdivideLongEdges(composition.geometry, bound));
  const pass1 = refined.geometry.getAttribute("position").count;

  const first = at("bvh1", () => SunBakeScene.from([{ geometry: refined.geometry }]));
  // The interim frame's bake. Measured on the same hierarchy the full one uses,
  // because that is what the scene does — the interim path stops here.
  at("classify", () =>
    first.bake({ direction, softness: SUN_BAKE_SOFTNESS, samples: SUN_CLASSIFY_SAMPLES }));
  at("bake1", () =>
    first.bake({ direction, softness: SUN_BAKE_SOFTNESS, samples: SUN_BAKE_SAMPLES }));

  const sharpened = at("subdivide2", () =>
    subdivideLongEdges(refined.geometry, bound, {
      shadowEdge: SHADOW_EDGE_BOUND * DETAIL_PROFILES[detail].edgeScale,
    }));
  const pass2 = sharpened.geometry.getAttribute("position").count;

  if (sharpened.geometry !== refined.geometry) {
    const second = at("bvh2", () =>
      SunBakeScene.from([{ geometry: sharpened.geometry }]));
    // Only the midpoints pass 2 added, which is what the scene does. Everything
    // below `pass1` was traced above at the same position and is already exact.
    at("bake2", () =>
      second.bakeTargets(
        [{ geometry: sharpened.geometry, fromVertex: pass1 }],
        { direction, softness: SUN_BAKE_SOFTNESS, samples: SUN_BAKE_SAMPLES },
      ));
  } else {
    timings.bvh2 = 0;
    timings.bake2 = 0;
  }

  return { timings, merged, pass1, pass2 };
}

function pad(value: string, width: number): string {
  return value.padStart(width);
}

const structures = listStructures()
  .map((definition) => definition.id)
  .filter((id) => only.length === 0 || only.includes(id));

for (const typeId of structures) {
  console.log(`\n${typeId}`);
  console.log(
    `  ${"level".padEnd(7)}${STAGES.map((s) => pad(s, 11)).join("")}`
    + `${pad("interim", 11)}${pad("settled", 11)}   vertices`,
  );

  for (const detail of levels) {
    const run = measure(typeId, detail);
    const sum = (stages: readonly Stage[]): number =>
      stages.reduce((total, stage) => total + run.timings[stage], 0);
    const cells = STAGES.map((stage) => pad(run.timings[stage].toFixed(1), 11)).join("");
    const growth = (run.pass2 / run.merged).toFixed(2);

    console.log(
      `  ${detail.padEnd(7)}${cells}`
      + `${pad(sum(INTERIM_STAGES).toFixed(1), 11)}${pad(sum(SETTLED_STAGES).toFixed(1), 11)}`
      + `   ${run.merged}→${run.pass2} (${growth}x)`,
    );
  }
}

// ---------------------------------------------------------------------------
// The partial second bake is lossless, and this is what says so.
// ---------------------------------------------------------------------------
//
// `bake2` traces only the vertices subdivision appended, on the reasoning that
// everything below that index kept its position and its number and therefore
// its answer. That reasoning rests on two things the geometry layer is free to
// change: that a split *appends* its midpoint, and that `reorderBySlot`
// permutes the index rather than the vertices. If either stops being true, the
// structure goes subtly wrong in a way no mesh invariant would catch — it would
// still be a valid mesh, just lit from a shape it no longer has.
//
// So the check is a comparison against tracing everything, on the family with
// the most boundary to get wrong.
{
  const config = createDefaultStructureConfig();
  config.typeId = "mass";
  config.view.detailLevel = "full";

  const composer = new StructureComposer();
  const composition = composer.build(config, getStructure("mass").sections);
  const refined = subdivideLongEdges(composition.geometry, SUN_BAKE_MAX_EDGE);
  const settings = {
    direction,
    softness: SUN_BAKE_SOFTNESS,
    samples: SUN_BAKE_SAMPLES,
  };

  SunBakeScene.from([{ geometry: refined.geometry }]).bake(settings);
  const pass1 = refined.geometry.getAttribute("position").count;
  const sharpened = subdivideLongEdges(refined.geometry, SUN_BAKE_MAX_EDGE, {
    shadowEdge: SHADOW_EDGE_BOUND,
  });
  const scene = SunBakeScene.from([{ geometry: sharpened.geometry }]);

  let started = performance.now();
  scene.bakeTargets([{ geometry: sharpened.geometry, fromVertex: pass1 }], settings);
  const partialMs = performance.now() - started;
  const partial = Float32Array.from(
    sharpened.geometry.userData.sunVisibilityBase as Float32Array,
  );

  started = performance.now();
  scene.bake(settings);
  const wholeMs = performance.now() - started;
  const whole = sharpened.geometry.userData.sunVisibilityBase as Float32Array;

  let mismatches = 0;

  for (let vertex = 0; vertex < whole.length; vertex += 1) {
    if (partial[vertex] !== whole[vertex]) {
      mismatches += 1;
    }
  }

  assert.equal(
    mismatches,
    0,
    `Tracing only the ${whole.length - pass1} appended vertices must equal tracing `
    + `all ${whole.length}. ${mismatches} differ, so subdivision no longer appends `
    + "or no longer leaves earlier vertices in place.",
  );

  // Both timings, because the vertex ratio badly overstates the saving and it
  // would be easy to quote it instead. The carried vertices are the *originals*,
  // which include every face turned away from the sun — and `traceSun` culls
  // those on the normal alone, before casting a single ray. So skipping a third
  // of the vertices skips well under a third of the work, and the honest number
  // is the one measured here.
  console.log(
    `\nPartial bake verified lossless: ${pass1} carried, ${whole.length - pass1} traced, `
    + `0 of ${whole.length} differ.`,
  );
  console.log(
    `  partial ${partialMs.toFixed(0)} ms vs whole ${wholeMs.toFixed(0)} ms `
    + `(${(100 * (1 - partialMs / wholeMs)).toFixed(0)}% saved on ${
      (100 * (1 - pass1 / whole.length)).toFixed(0)}% of the vertices)`,
  );
}

console.log(
  "\nAll times in ms. Stage names match MainScene.prepareStructureGeometry."
  + "\n`interim` is what a still-moving control pays; `settled` is the rebuild after"
  + "\nthe release. A drag costs one interim per sampled frame, then one settled.",
);
