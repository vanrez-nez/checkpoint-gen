import { hashString, mulberry32 } from "proc-seed";

/**
 * Deterministic randomness for every generator.
 *
 * Nothing in this project may call `Math.random`. A generated structure must be
 * reproducible from its seed alone, so variation is always drawn from a stream
 * derived by `hashSeed` from a root seed plus a label describing what is being
 * varied. Labels make the derivation hierarchical: two subsystems reading from
 * the same root seed stay independent as long as their labels differ, which is
 * what lets one subsystem be regenerated without disturbing its siblings.
 *
 * The stream itself and the label-folding law both come from `proc-seed`, the
 * primitives shared with this project's sibling repo, so both speak the same
 * seeding law.
 */

/**
 * Folds a label into a seed. The same `(seed, label)` pair always yields the
 * same stream, and neighbouring labels ("row-3" / "row-4") diverge immediately.
 *
 * `proc-seed` has no two-argument (seed, label) primitive of its own — only
 * `hashString`, which hashes a single string — so the pair is folded into one
 * string first. `:` never appears in a label used anywhere in this project, so
 * there is no risk of two distinct `(seed, label)` pairs colliding on the same
 * string.
 */
export function hashSeed(seed: number, label: string): number {
  return hashString(`${seed}:${label}`);
}

/** A uniform [0, 1) stream. */
export const createRandom: (seed: number) => () => number = mulberry32;

export function randomRange(random: () => number, min: number, max: number): number {
  return min + (max - min) * random();
}

/**
 * Splits `total` into `count` parts whose sizes vary by up to `variation` but
 * always sum back to `total`. Used wherever a span has to be subdivided without
 * the subdivisions drifting away from the span they belong to.
 */
export function normalizedSpans(
  count: number,
  total: number,
  variation: number,
  random: () => number,
): number[] {
  const weights = Array.from(
    { length: count },
    () => 1 + randomRange(random, -variation, variation),
  );
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  return weights.map((weight) => (weight / weightTotal) * total);
}
