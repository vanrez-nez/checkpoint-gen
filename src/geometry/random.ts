/**
 * Deterministic randomness for every generator.
 *
 * Nothing in this project may call `Math.random`. A generated structure must be
 * reproducible from its seed alone, so variation is always drawn from a stream
 * derived by `hashSeed` from a root seed plus a label describing what is being
 * varied. Labels make the derivation hierarchical: two subsystems reading from
 * the same root seed stay independent as long as their labels differ, which is
 * what lets one subsystem be regenerated without disturbing its siblings.
 */

/**
 * Folds a label into a seed. The same `(seed, label)` pair always yields the
 * same stream, and neighbouring labels ("row-3" / "row-4") diverge immediately.
 */
export function hashSeed(seed: number, label: string): number {
  let hash = seed | 0;

  for (let index = 0; index < label.length; index += 1) {
    hash = Math.imul(hash ^ label.charCodeAt(index), 0x45d9f3b);
    hash ^= hash >>> 16;
  }

  return hash >>> 0;
}

/** A uniform [0, 1) stream. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

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
