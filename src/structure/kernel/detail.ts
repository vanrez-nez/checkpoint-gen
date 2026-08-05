import type { MasonryRule } from "./masonry";

/**
 * How much geometry a structure is asked to spend on itself.
 *
 * The ladder is not new machinery. `tessellateStructure` has always branched on
 * whether it was handed a masonry rule — with one it lays coursed stonework,
 * with `null` it lays one block per band stretch — and that branch is two to
 * three orders of magnitude wide. A level is just a policy for what rule to
 * hand it, stated once here rather than per family.
 *
 * The two reductions are different in kind, which is why there are three levels
 * and not a slider. `coarse` reduces the *masonry*: the same silhouette, the
 * same bands, the same cornices and stairs, laid in fewer and larger stones.
 * `bare` reduces the *massing*: the stonework is gone entirely and only the
 * form remains. One step apart, and each is legible on its own terms.
 *
 * A caution for whoever adds distance selection. Levels do not nest. Courses
 * come from `round(wallHeight / courseHeight)` and the per-course size spread
 * redraws a different random sequence whenever that count changes, so a coarse
 * course is not a merge of two full ones and a coarse stone is not a union of
 * full ones. With one level resident that is invisible. The day two levels are
 * on screen together, or cross-faded, it is the whole problem.
 */
export const DETAIL_LEVELS = ["full", "coarse", "bare"] as const;

export type DetailLevel = (typeof DETAIL_LEVELS)[number];

export const DEFAULT_DETAIL_LEVEL: DetailLevel = "full";

/** Label to value, for the list control. */
export const DETAIL_LEVEL_OPTIONS: Readonly<Record<string, DetailLevel>> = {
  Full: "full",
  Coarse: "coarse",
  Bare: "bare",
};

export interface DetailProfile {
  /** Multiplies the target bed-to-bed height; larger means fewer courses. */
  readonly courseScale: number;
  /** Multiplies the target stone length; larger means fewer stones per run. */
  readonly stoneScale: number;
  /** Scales corner wander. Zero also retires a bottom face on every block. */
  readonly displacementScale: number;
  /** False forces butted corners, which retires the paired quoin blocks. */
  readonly quoins: boolean;
  /** Bevel segments a rounded arris is allowed; zero leaves the corner hard. */
  readonly bevelSegments: number;
  /** Scales the masonry tile count across a stair tread. */
  readonly stairTileScale: number;
  /** False lays bare blocks instead of stonework. */
  readonly stonework: boolean;
  /**
   * How much coarser this level's faces are, dimensionless.
   *
   * The scene multiplies its own world-unit edge bound by this before
   * subdividing for the sun bake. It has to exist, because subdivision cost
   * tracks total surface *area*, which barely changes between levels: left at
   * one bound, `bare`'s enormous faces would be refined back into roughly the
   * vertex count `full` carries, and the level whose only purpose is to be
   * cheap would cost the same to prepare and to bake.
   */
  readonly edgeScale: number;
  /**
   * Ceiling on the circular family's rows per tier.
   *
   * Circular does not run through `tessellateStructure`, so it cannot take the
   * masonry reduction. This is its equivalent, and a good one: rows and the
   * segments each row is divided into both fall with it, so the saving is
   * quadratic.
   */
  readonly maxRowsPerTier: number;
  /** Scales circular's edge fragmentation. */
  readonly fragmentationScale: number;
}

export const DETAIL_PROFILES: Readonly<Record<DetailLevel, DetailProfile>> = {
  full: {
    courseScale: 1,
    stoneScale: 1,
    displacementScale: 1,
    quoins: true,
    bevelSegments: Number.POSITIVE_INFINITY,
    stairTileScale: 1,
    stonework: true,
    edgeScale: 1,
    maxRowsPerTier: Number.POSITIVE_INFINITY,
    fragmentationScale: 1,
  },
  coarse: {
    courseScale: 2,
    stoneScale: 2,
    // Zero rather than merely small: any non-zero displacement makes every
    // block in the facing ring carry a bottom face it would otherwise skip.
    displacementScale: 0,
    quoins: false,
    bevelSegments: 1,
    stairTileScale: 0.4,
    stonework: true,
    edgeScale: 2,
    maxRowsPerTier: 2,
    fragmentationScale: 0.5,
  },
  bare: {
    courseScale: 1,
    stoneScale: 1,
    displacementScale: 0,
    quoins: false,
    bevelSegments: 0,
    stairTileScale: 0.2,
    stonework: false,
    edgeScale: 4,
    maxRowsPerTier: 1,
    fragmentationScale: 0,
  },
};

/**
 * The masonry rule this level asks for, or `null` to lay the mass bare.
 *
 * Returns a fresh rule and never touches the one it was given: the authored
 * rule is the user's, and a level round trip that wrote reductions back into it
 * would quietly destroy their configuration.
 *
 * `gap` is deliberately not scaled. A joint is a real width between real
 * stones, not a fraction of one, and widening it with the stones reads as a
 * different wall rather than the same wall further away.
 *
 * `depth` is deliberately not scaled either. It would reduce the number of
 * backing rings, but it also sets the butted end reservation and the short leg
 * of a quoin, so raising it visibly widens the plain run at every corner.
 */
export function reduceMasonry(
  rule: MasonryRule | null,
  level: DetailLevel,
): MasonryRule | null {
  const profile = DETAIL_PROFILES[level];

  if (!rule || !profile.stonework) {
    return null;
  }

  return {
    ...rule,
    courseHeight: rule.courseHeight * profile.courseScale,
    stoneWidth: rule.stoneWidth * profile.stoneScale,
    displacement: rule.displacement * profile.displacementScale,
    cornerRule: profile.quoins ? rule.cornerRule : "butted",
  };
}

/**
 * The bevel this level asks for, or `null` to leave every arris hard.
 *
 * Generic over the shape rather than typed against the stela family's rule, so
 * the kernel states the policy without importing a family that states a form.
 */
export function reduceBevel<Rule extends { readonly segments: number }>(
  rule: Rule | null | undefined,
  level: DetailLevel,
): Rule | null {
  const allowed = DETAIL_PROFILES[level].bevelSegments;

  if (!rule || allowed < 1) {
    return null;
  }

  return { ...rule, segments: Math.min(rule.segments, allowed) };
}

/** Masonry tiles across a stair tread at this level, never fewer than one. */
export function reduceStairTiles(tiles: number, level: DetailLevel): number {
  return Math.max(1, Math.round(tiles * DETAIL_PROFILES[level].stairTileScale));
}
