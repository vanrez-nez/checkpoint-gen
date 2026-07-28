import { createRandom, hashSeed, normalizedSpans } from "../../geometry/random";

/**
 * How a surface is divided into set stones.
 *
 * Division only — no geometry. Every function here answers "where do the joints
 * fall", and the tessellator turns those answers into faces. Keeping it separate
 * is what lets the same rule govern a battered wall, a terrace ring and a summit
 * without any of them knowing about the others.
 *
 * Two properties matter more than anything else, because getting them wrong is
 * what a viewer notices first:
 *
 * 1. **Divisions leave no remainder.** Everything goes through `normalizedSpans`,
 *    which varies its pieces but always sums to exactly the span it was given.
 *    Dividing by `round(length / target)` and living with the difference is what
 *    drops stones at the ends of a run.
 * 2. **Courses are decided once per wall, not once per face.** All four faces of
 *    a band take the same course heights, so course lines meet around every
 *    corner instead of each face keeping its own rhythm.
 */

export const MASONRY_PATTERNS = [
  "uniform_ashlar",
  "large_cut_blocks",
  "mixed_ashlar",
  "cyclopean",
  "polygonal",
  "rubble",
  "thin_layered",
  "alternating_courses",
  "header_stretcher",
  "panelized_megalithic",
  "plastered_over_masonry",
] as const;

export type MasonryPattern = (typeof MASONRY_PATTERNS)[number];

/**
 * Coursed ashlar is what this phase builds: level beds, varied stone lengths.
 * The rest of the vocabulary needs its own division rules and arrives with the
 * construction grammar.
 */
export const IMPLEMENTED_MASONRY_PATTERNS: readonly MasonryPattern[] = [
  "mixed_ashlar",
];

export const CORNER_RULES = [
  "butted",
  "alternating_interlock",
  "enlarged_quoin",
  "wrapped_courses",
  "quoin_strip",
  "rounded_erosion",
  "collapsed_corner",
  "later_repair",
] as const;

export type CornerRule = (typeof CORNER_RULES)[number];

export const IMPLEMENTED_CORNER_RULES: readonly CornerRule[] = [
  "butted",
  "alternating_interlock",
];

export interface MasonryRule {
  readonly pattern: MasonryPattern;
  readonly cornerRule: CornerRule;
  /** Target bed-to-bed height; the real height is whatever divides the wall. */
  readonly courseHeight: number;
  /** Target stone length along a course. */
  readonly stoneWidth: number;
  /**
   * Spread of stone sizes, from the shared `StoneConfig`. Same meaning as on
   * every other stone-built prop: 0 gives stones all one size.
   */
  readonly sizeVariation: number;
  /** Gap between neighbouring stones, in world units. */
  readonly gap: number;
  /**
   * How deep a stone is: how far it reaches back into the wall from its face.
   *
   * A real dimension of a real block, not the thickness of a facing. It is what
   * a quoin's short return is as wide as, what a joint looks into, and what the
   * rings of a terrace step in by — so a mass laid with deep stones is coarser
   * throughout rather than just having deeper grooves on it.
   */
  readonly depth: number;
  /**
   * How far a stone's corners wander, from the shared `StoneConfig`.
   *
   * The same meaning it has on the circular checkpoint and on a pillar: each
   * corner of a stone's plan is jittered by `min(distance × displacement,
   * gap × 0.65)`. The cap against the gap is what keeps neighbours from ever
   * growing into one another, and it is why the value is a ratio rather than a
   * distance.
   */
  readonly displacement: number;
}

/** A course: where its bed sits within the wall, and how tall it is. */
export interface Course {
  readonly index: number;
  /** Height above the wall's base, not above the ground. */
  readonly bottom: number;
  readonly height: number;
}

/**
 * Divides a wall into courses.
 *
 * Called once per wall and handed to every face of it, which is the whole point:
 * a course is a horizontal layer of the building, not a row of one elevation.
 */
export function divideCourses(
  wallHeight: number,
  rule: MasonryRule,
  seed: number,
): Course[] {
  if (wallHeight <= 0) {
    return [];
  }

  const count = Math.max(1, Math.round(wallHeight / rule.courseHeight));
  // Bed heights vary less than stone lengths do: a course that wandered as much
  // as its stones would stop reading as a course at all.
  const heights = normalizedSpans(
    count,
    wallHeight,
    rule.sizeVariation * COURSE_HEIGHT_VARIATION,
    createRandom(seed),
  );
  const courses: Course[] = [];
  let bottom = 0;

  for (let index = 0; index < count; index += 1) {
    const height = heights[index] ?? 0;
    courses.push({ index, bottom, height });
    bottom += height;
  }

  return courses;
}

/** Divides one course of one face into stone lengths that fill it exactly. */
export function divideRun(
  runLength: number,
  rule: MasonryRule,
  seed: number,
): number[] {
  if (runLength <= 0) {
    return [];
  }

  const count = Math.max(1, Math.round(runLength / rule.stoneWidth));
  return normalizedSpans(count, runLength, rule.sizeVariation, createRandom(seed));
}

/**
 * One block of a course, placed on the loop.
 *
 * `run` is which of the four runs its principal face lies on and `from`/`to` are
 * metres along that run. `wrap` is the only thing that makes a corner special:
 * a quoin turns the corner, so it also reaches `wrap` metres onto the next run
 * and presents a face to that elevation too.
 */
export interface RingBlock {
  readonly run: number;
  readonly from: number;
  readonly to: number;
  /** How far it turns onto the next run. Zero for every ordinary block. */
  readonly wrap: number;
  /** This stone's own stream, so its corners wander the same way every build. */
  readonly seed: number;
}

/**
 * Divides one course into blocks, all the way round the loop.
 *
 * The whole of the corner logic lives here, and the reason it is one function is
 * that a corner belongs to a course, not to an elevation. Deriving it per face —
 * which is what this replaces — made each of the two walls meeting at a corner
 * emit its own separate slab, sized by its own rule; the two interpenetrated
 * behind the arris and never formed a quoin at all.
 *
 * A quoin is instead **one** block, listed once, that reaches along one run and
 * turns `wrap` metres onto the next. Which of the two legs is the long one
 * alternates with the course, so the two elevations interlock up the arris.
 */
export function divideCourseRing(
  runLengths: readonly number[],
  rule: MasonryRule,
  courseIndex: number,
  seed: number,
): RingBlock[] {
  if (runLengths.length !== 4) {
    throw new Error("A course ring is divided over exactly four runs.");
  }

  const quoins = resolveQuoins(runLengths, rule, courseIndex);
  const blocks: RingBlock[] = [];

  for (let run = 0; run < 4; run += 1) {
    const length = runLengths[run] ?? 0;
    // What the corners at this run's two ends have already taken. A quoin turns
    // onto this run, so its `wrap` is what it occupies here; a butted corner
    // still takes a stone's depth, because the run before it carries on to the
    // arris and shows its end on this wall. Reserving that here rather than
    // where the stones are laid is what stops a short first stone being dropped
    // and the one after it starting inside the corner.
    const from = quoins ? (quoins[(run + 3) % 4]?.wrap ?? 0) : rule.depth;
    const to = length - (quoins ? (quoins[run]?.reach ?? 0) : 0);

    if (to <= from) {
      continue;
    }

    const widths = divideRun(to - from, rule, hashSeed(seed, `run_${run}`));
    let cursor = from;

    for (let stone = 0; stone < widths.length; stone += 1) {
      const width = widths[stone] ?? 0;
      blocks.push({
        run,
        from: cursor,
        to: cursor + width,
        wrap: 0,
        seed: hashSeed(seed, `stone_${run}_${stone}`),
      });
      cursor += width;
    }
  }

  if (!quoins) {
    return blocks;
  }

  for (let corner = 0; corner < 4; corner += 1) {
    const quoin = quoins[corner];
    const length = runLengths[corner] ?? 0;

    if (!quoin) {
      continue;
    }

    blocks.push({
      run: corner,
      from: length - quoin.reach,
      to: length,
      wrap: quoin.wrap,
      seed: hashSeed(seed, `quoin_${corner}`),
    });
  }

  return blocks;
}

/**
 * How far the quoin at each corner reaches back along its run and forward onto
 * the next, or null where the runs are too short to spare them and the course
 * falls back to butted corners.
 *
 * The long leg alternates with `(courseIndex + corner)`, so on one course the
 * front and rear run through the corners while the sides tuck in, and on the
 * next it is the other way round. That alternation is the interlock; without it
 * every corner is one continuous vertical joint up the whole wall.
 */
function resolveQuoins(
  runLengths: readonly number[],
  rule: MasonryRule,
  courseIndex: number,
): readonly { readonly reach: number; readonly wrap: number }[] | null {
  if (rule.cornerRule !== "alternating_interlock") {
    return null;
  }

  const long = rule.stoneWidth;
  // The short leg of a quoin is not a separate size: it is the same stone seen
  // end-on from the wall round the corner, so it is exactly as wide as the stone
  // is deep. Choosing it independently is how the two legs came to overlap
  // whenever the stones were deeper than that guess.
  const short = rule.depth;
  const quoins = [0, 1, 2, 3].map((corner) => {
    const runsThrough = (courseIndex + corner) % 2 === 0;
    return {
      reach: runsThrough ? long : short,
      wrap: runsThrough ? short : long,
    };
  });

  // Every run has to keep a stone of its own between the two quoins, or the
  // course is nothing but corners and the wall loses its bond.
  const spare = runLengths.every((length, run) => {
    const atStart = quoins[(run + 3) % 4]?.wrap ?? 0;
    const atEnd = quoins[run]?.reach ?? 0;
    return length - atStart - atEnd >= rule.stoneWidth * MIN_FREE_RUN;
  });

  return spare ? quoins : null;
}

/**
 * A seed for one addressable piece of the stonework. Paths keep each course's
 * variation stable as its neighbours change — restacking a band does not
 * reshuffle the courses that were already there.
 */
export function masonrySeed(seed: number, ...path: readonly string[]): number {
  return path.reduce((value, segment) => hashSeed(value, segment), seed);
}

/** Bed heights vary at this fraction of the size variation stones do. */
const COURSE_HEIGHT_VARIATION = 0.45;
/** However the corners fall, a run keeps at least this much stone between them. */
const MIN_FREE_RUN = 1.2;
