import type { Point2 } from "../../geometry/finalize";
import type { Block, SolidBuilder, Vertex3 } from "../../geometry/solid-builder";
import {
  insetRect,
  rectDepth,
  rectEdge,
  rectIsValid,
  rectWidth,
  uniformSetbacks,
  type HorizontalOrientation,
  type Rect,
} from "../kernel/frame";
import {
  createRandom,
  displacementDistance,
  insetAndJitter,
  randomRange,
} from "../../geometry/stone-builder";
import type { ElevationBandRecord } from "../kernel/graph";
import {
  divideCourseRing,
  divideCourses,
  divideRun,
  masonrySeed,
  type MasonryRule,
} from "../kernel/masonry";

/**
 * The mass, laid up out of stones.
 *
 * A stone is a box. A course is a ring of them laid round the building. A band
 * is a stack of courses, each set back from the one below. That is the whole
 * model, and it is how these things were actually built — so the batter is not
 * an angle anything is cut to, it is the accumulated setback of the courses, and
 * an edge of the mass is a **staircase of stone ends** rather than a smooth
 * rake. You can count the courses in the silhouette.
 *
 * This replaces a surface model: an ideal outline, subdivided into facets and
 * stuck onto a solid. That gave every course a face clipped to the ideal rake,
 * which is why the edges came out as clean planes with a pattern on them instead
 * of as stonework. Nothing here clips anything. Every block is an upright box,
 * whole, and where the blocks stop is where the building stops.
 *
 * Two rules keep it coherent:
 *
 * There is no core. A course is stone the whole way through — rings of it laid
 * inward until the middle is reached — so every surface of the building is the
 * side of a stone. A single block behind the facing is quicker, but it is one
 * undivided face metres across, and it shows wherever the stones in front do not
 * quite cover it.
 *
 * One rule keeps it coherent: **a face is drawn only where the space just
 * outside it is empty.** Two stones pressed together share an interior boundary.
 * Drawing both is a z-fight; drawing neither where there is a gap is a hole.
 */

/**
 * The four runs of a course, in the order they go round the building: each run's
 * end corner is the next run's start corner. Deliberately not
 * `HORIZONTAL_ORIENTATIONS`, which is grouped by opposite pairs and would treat
 * two walls that never meet as neighbours.
 */
const RUN_RING: readonly HorizontalOrientation[] = [
  "front",
  "sidePositiveU",
  "rear",
  "sideNegativeU",
];

/** A cornice is a run of long stones, not a facing of small ones. */
const CORNICE_STONE_RATIO = 2.5;

export interface ShellOptions {
  readonly rule: MasonryRule;
  readonly seed: number;
}

/**
 * One stretch of a band over which the outline shrinks smoothly.
 *
 * A plain band is one segment. A corniced band is two, because the outline steps
 * outward at the springing and a course must never straddle that step — the
 * moulding's first course is the one that reaches back over the overhang, and
 * its underside is the soffit.
 */
interface Segment {
  readonly bottomY: number;
  readonly topY: number;
  readonly lower: Rect;
  readonly upper: Rect;
  readonly rule: MasonryRule;
  /** How much further than a stone's depth this segment's first course reaches. */
  readonly overhang: number;
  readonly label: string;
}

export function buildMassShell(
  builder: SolidBuilder,
  bands: readonly ElevationBandRecord[],
  options: ShellOptions,
): void {
  const { rule, seed } = options;

  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];

    if (!band || !rectIsValid(band.lower)) {
      continue;
    }

    const segments = segmentsOf(band, rule);
    const crown = segments[segments.length - 1];

    if (!crown) {
      continue;
    }

    for (const segment of segments) {
      builder.withMaterial(
        segment.label === "cornice" ? "cornice" : "stone",
        () => layCourses(builder, segment, {
          seed: masonrySeed(seed, band.id, segment.label),
          crowned: segment !== crown,
          // What stands on this band, so the courses know how much of their top is
          // open to the sky. Null means nothing does and the whole crown is floor.
          under: segment === crown ? (bands[index + 1]?.lower ?? null) : undefined,
        }),
      );
    }
  }
}

/**
 * A band's outline as one or two smooth stretches.
 *
 * Without a cornice the wall simply steps in from its base to its crown. With
 * one, the wall stops at the springing and the moulding takes over from there,
 * its outline stepped outward by the projection and held constant to the top.
 */
function segmentsOf(band: ElevationBandRecord, rule: MasonryRule): Segment[] {
  const { cornice } = band;

  if (!cornice || !rectIsValid(cornice.springing)) {
    return [{
      bottomY: band.bottomY,
      topY: band.topY,
      lower: band.lower,
      upper: band.upper,
      rule,
      overhang: 0,
      label: "wall",
    }];
  }

  return [
    {
      bottomY: band.bottomY,
      topY: cornice.bottomY,
      lower: band.lower,
      upper: cornice.springing,
      rule,
      overhang: 0,
      label: "wall",
    },
    {
      bottomY: cornice.bottomY,
      topY: band.topY,
      lower: cornice.outline,
      upper: cornice.outline,
      // One course of long stones. A moulding is a run of them; coursing it like
      // the wall would stop it reading as the thing that finishes the wall.
      rule: {
        ...rule,
        courseHeight: Math.max(band.topY - cornice.bottomY, 1e-6),
        stoneWidth: rule.stoneWidth * CORNICE_STONE_RATIO,
        cornerRule: "butted",
      },
      // The moulding oversails the wall, so its first course reaches back past
      // the projection and its underside closes the overhang. That soffit is the
      // cornice; there is no separate piece of geometry for it.
      overhang: cornice.projection,
      label: "cornice",
    },
  ];
}

interface CourseOptions {
  readonly seed: number;
  /**
   * Whether a moulding sits directly on this segment's top course.
   *
   * Its soffit reaches back over the wall as one stone, so the wall's own top
   * faces under it would be a second surface at the same height.
   */
  readonly crowned: boolean;
  /**
   * The footprint of the band standing on this segment, or null where nothing
   * does. `undefined` means this segment is buried and shows no top at all.
   */
  readonly under?: Rect | null;
}

/**
 * Lays every course of one segment.
 *
 * A course's outline is the ideal one taken **at its own bed**, and the course
 * keeps that outline the whole way up. Consecutive courses therefore step in by
 * whatever the batter gives over one course height, which is what makes the
 * elevation a staircase of stones rather than a raked plane — and what lets
 * every stone stay a whole box instead of being cut to an angle.
 */
function layCourses(
  builder: SolidBuilder,
  segment: Segment,
  options: CourseOptions,
): void {
  const height = segment.topY - segment.bottomY;

  if (height <= 0) {
    return;
  }

  const courses = divideCourses(
    height,
    segment.rule,
    masonrySeed(options.seed, "courses"),
  );
  for (const course of courses) {
    const isFirst = course.index === 0;
    const isLast = course.index === courses.length - 1;
    const isExposedCrown = options.under !== undefined && isLast;
    // Courses sit flush on each other. A bed joint would be a slot a stone deep
    // running the whole way round the building, and a level ray entering one
    // travels inside the wall and out the far side; dry-laid stone has no such
    // gap, and the course line reads from the setback and the staggered perpends
    // instead. The joints that exist are the ones between stones in a course.
    const bottomY = segment.bottomY + course.bottom;
    const topY = segment.bottomY + course.bottom + course.height;
    const outline = lerpRect(segment.lower, segment.upper, course.bottom / height);
    // Only the first course of a segment can oversail what is under it. The
    // course carries its own depth in its own rule, so the division that
    // reserves the corners and the stones that fill them cannot disagree — when
    // they did, a moulding's corner stone overlapped the run beside it by
    // exactly the projection.
    const depth = segment.rule.depth + (isFirst ? segment.overhang : 0);
    const courseRule: MasonryRule = depth === segment.rule.depth
      ? segment.rule
      : { ...segment.rule, depth };

    if (topY <= bottomY || !rectIsValid(outline)) {
      continue;
    }

    // A stone's underside shows only where nothing is under it: at the ground,
    // and on the outermost ring of a moulding, which oversails the wall it
    // crowns — that ring's underside IS the soffit. Everything further in is
    // bedded on the course below, and drawing those undersides would put a face
    // where the eye expects solid stone.
    const onSoffit = isFirst && segment.overhang > 0;
    const needsJointUnderside = segment.rule.displacement > 0
      && bottomY > 1e-9;
    const jointUndersideInset = Math.min(course.height * 0.01, 0.003);
    const shared = {
      bottomY,
      topY,
      // A stone's underside is drawn only where it oversails: the soffit of a
      // moulding. The mass sits on the ground, so its own underside is not a
      // surface — and it was the one plane where two stones that had both
      // wandered could end up at the same depth.
      showBottom: false,
    };
    layRing(builder, {
      ...shared,
      rule: courseRule,
      outline,
      unbackedOuterFace: true,
      // The back of a facing stone opens onto the fill only at an exposed
      // terrace or summit. In a buried course the joint is closed by the outer
      // face of the first backing ring; the facing stone's inward face points
      // into solid work and can never be seen.
      showInner: isExposedCrown,
      // Displacement can move an outer arris past the course supporting it.
      // Its underside is then visible through the bed/perpend intersection and
      // must exist; square-set work keeps this face culled.
      showBottom: shared.showBottom || onSoffit || needsJointUnderside,
      bottomInset: needsJointUnderside && !onSoffit
        ? jointUndersideInset
        : 0,
      showTop: !(options.crowned && isLast),
      seed: masonrySeed(options.seed, `course_${course.index}`),
      courseIndex: course.index,
    });


    // The rest of the course, laid inward ring after ring until it is full.
    //
    // There is no core. A course is stone the whole way through, which is the
    // only arrangement in which every surface of the building — the face, the
    // tread the batter leaves, whatever you see down a joint — is the side of a
    // stone. Backing the facing with one big block instead put a single 415 m²
    // face behind it, and that undivided slab is what showed wherever the stones
    // did not quite cover it.
    layInward(builder, {
      ...shared,
      rule: segment.rule,
      // The top of the band's last course is its terrace or its summit, so the
      // rings out to whatever stands on it are all in daylight. Everywhere else
      // only the outermost couple can be reached.
      exposedTop: isExposedCrown,
      under: options.under ?? null,
      // A moulding's soffit is one stone reaching back over the wall, so nothing
      // under it shows a top — not the facing, and not the rings behind it.
      showTop: !(options.crowned && isLast),
      // The first backing ring can be seen behind a displaced facing joint.
      // `layInward` limits this to that ring; deeper undersides remain buried.
      showBottom: needsJointUnderside,
      bottomInset: needsJointUnderside ? jointUndersideInset : 0,
      outline: insetRect(outline, uniformSetbacks(depth + segment.rule.gap)),
      seed: masonrySeed(options.seed, `inward_${course.index}`),
      courseIndex: course.index,
    });
  }
}

interface RingOptions {
  readonly outline: Rect;
  readonly bottomY: number;
  readonly topY: number;
  readonly rule: MasonryRule;
  readonly seed: number;
  readonly courseIndex: number;
  readonly showBottom: boolean;
  /** See BlockFaces.bottomInset. */
  readonly bottomInset?: number;
  /** True only for the building's outer facing, which has no ring outside it. */
  readonly unbackedOuterFace?: boolean;
  /**
   * Whether the ring's inner face is exposed.
   *
   * On a wall it is not: the fill is pressed against it. On a floor it is, since
   * what lies inward is the next ring with a joint between them — and a joint
   * with no cheek on one side is a slot you can see down into the mass.
   */
  readonly showInner?: boolean;
  /** False where something sits directly on this ring and hides its top. */
  readonly showTop?: boolean;
}

/** One closed ring of stones: a course, all the way round the building. */
function layRing(builder: SolidBuilder, options: RingOptions): void {
  const { outline, rule } = options;
  const depth = rule.depth;
  const runs = RUN_RING.map((orientation) => runOf(outline, orientation));

  if (runs.some((run) => run.length <= 0)) {
    return;
  }

  const blocks = divideCourseRing(
    runs.map((run) => run.length),
    rule,
    options.courseIndex,
    options.seed,
  );
  const quoined = blocks.some((block) => block.wrap > 0);
  const joint = rule.gap * 0.5;

  for (const block of blocks) {
    const run = runs[block.run];
    const nextRun = runs[(block.run + 1) % 4];

    if (!run || !nextRun) {
      continue;
    }

    if (block.wrap > 0) {
      layQuoin(builder, run, nextRun, block.from + joint, block.wrap - joint, block.seed, options);
      continue;
    }

    // At a butted corner the run's last stone carries on to the arris, dressed
    // flush, and shows its end as the return on the wall round the corner. The
    // next run's first stone starts a stone's depth along, separated from the
    // return by an ordinary joint — a real one, with both cheeks. It was
    // treated as pressed instead, on the theory that the two touched; the
    // corner insets meant they never did, and the unfaced seam beside every
    // corner was a slot straight into the hollow of the course.
    const buttedStart = !quoined && block.from <= depth + 1e-9;
    const buttedEnd = !quoined && block.to >= run.length - 1e-9;
    const from = block.from + joint;
    const to = buttedEnd ? run.length : block.to - joint;

    if (to <= from) {
      continue;
    }

    builder.addBlock(
      stoneOn(run, from, to, depth, options, block.seed, {
        start: buttedStart,
        end: buttedEnd,
      }),
      // Edges run outer, end, inner, start. A corner stone on the facing ring
      // also shows its inner face: it is the far cheek of the joint beside its
      // return, and without it that joint looks past the stone into the
      // course's hollow.
      {
        sides: [
          true,
          true,
          options.showInner === true
            || (buttedEnd && options.unbackedOuterFace === true),
          true,
        ],
        top: options.showTop !== false,
        bottom: options.showBottom,
        bottomInset: options.bottomInset,
      },
    );
  }
}

/**
 * A quoin: one stone turning the corner, laid as the two legs of its L.
 *
 * Two legs rather than one box because a quoin is longer than a stone is deep,
 * and a box that long would reach past the fill behind it. The legs are flush —
 * no joint, because they are one stone — and the short return at the arris is
 * the long leg's own end face, which is why the second leg starts a stone's
 * depth along instead of at the corner.
 */
function layQuoin(
  builder: SolidBuilder,
  run: Run,
  nextRun: Run,
  from: number,
  wrapTo: number,
  seed: number,
  options: RingOptions,
): void {
  const { showBottom } = options;
  const depth = options.rule.depth;

  if (from < run.length) {
    builder.addBlock(
      // Its far end is the arris, dressed square; only its other end is free to
      // wander, because that is the end with a joint beside it.
      stoneOn(run, from, run.length, depth, options, seed, { end: true }),
      // Outer, then the return at the arris — the same stone showing on the wall
      // round the corner — no inner face, and a joint at its far end.
      {
        sides: [true, true, options.showInner === true, true],
        top: options.showTop !== false,
        bottom: showBottom,
        bottomInset: options.bottomInset,
      },
    );
  }

  if (wrapTo <= depth) {
    return;
  }

  builder.addBlock(
    stoneOn(nextRun, depth, wrapTo, depth, options, seed, { start: true }),
    // Its start face is drawn even though the legs are one stone: the long
    // leg's transverse inset leaves a finger-width seam between the two
    // bodies, and a face there is the difference between a shadow line and a
    // slit into the course.
    {
      sides: [true, true, options.showInner === true, true],
      top: options.showTop !== false,
      bottom: showBottom,
      bottomInset: options.bottomInset,
    },
  );
}

interface InwardOptions {
  readonly outline: Rect;
  /** False where a moulding's soffit reaches back over this course. */
  readonly showTop?: boolean;
  /** Whether this course's top is the band's crown rather than buried. */
  readonly exposedTop?: boolean;
  /** The footprint of whatever stands on that crown, if anything does. */
  readonly under?: Rect | null;
  readonly bottomY: number;
  readonly topY: number;
  readonly rule: MasonryRule;
  readonly seed: number;
  readonly courseIndex: number;
  readonly showBottom: boolean;
  /** See BlockFaces.bottomInset. */
  readonly bottomInset?: number;
}

/**
 * The rest of a course, laid inward ring after ring until the middle is reached.
 *
 * The same stones as the face, laid the same way. Rings rather than a grid
 * because a ring has no corner to mitre — every stone in it is an upright box
 * like every other stone in the mass.
 *
 * Every ring takes a joint against the one behind it, and both cheeks of that
 * joint are drawn. Butting them instead is cheaper and closes the same holes,
 * but then a stone is only outlined at its two ends: looking down at a course
 * you see rows of short dashes rather than stones.
 */
function layInward(builder: SolidBuilder, options: InwardOptions): void {
  const { rule } = options;
  const depth = rule.depth;
  const step = uniformSetbacks(depth + rule.gap);
  // Where the rings would run to if the course were laid solid.
  const outlines: Rect[] = [];
  let reach = options.outline;

  while (
    rectIsValid(reach)
    && Math.min(rectWidth(reach), rectDepth(reach)) >= depth * 2 + rule.gap
  ) {
    outlines.push(reach);
    reach = insetRect(reach, step);
  }

  // How many of them anything can actually reach.
  //
  // A ring's face is seen through the joints of the ring in front, and its top
  // is seen wherever the band above does not stand on it — so a course needs the
  // outermost ring, one behind it to close its joints, and on the band's crown
  // every ring out to the footprint of whatever stands there. The rest is stone
  // buried in stone: the middle of a course of a battered pyramid is a dozen
  // rings deep and not one of them is ever visible.
  let visible = -1;

  for (let ring = 0; ring < outlines.length; ring += 1) {
    if (options.exposedTop === true
      && !(options.under && covers(options.under, outlines[ring]!))) {
      visible = ring;
    }
  }

  // Two rings are the minimum joint backing even when the whole crown is
  // covered. `visible` starts at -1 so that case does not accidentally mark the
  // outermost backing-ring top as exposed.
  const kept = Math.min(Math.max(visible + 2, 2), outlines.length);

  for (let ring = 0; ring < kept; ring += 1) {
    const topIsExposed = options.exposedTop === true && ring <= visible;
    const innerIsExposed = topIsExposed;

    layRing(builder, {
      ...options,
      outline: outlines[ring]!,
      unbackedOuterFace: false,
      showBottom: options.showBottom && ring === 0,
      // This is the closure directly behind the facing joints. Keeping its
      // exposed arris square prevents a widened outer joint from lining up with
      // a second opening into the culled centre.
      rule: ring === 0
        ? { ...options.rule, displacement: 0 }
        : options.rule,
      // A buried backing ring is capped by the course above, so neither its top
      // nor the inner cheek of its joint can be reached. On a terrace both are
      // visible down into the joint. The retained ring behind this one closes
      // outward views through the perpends; an inward-facing wall around the
      // culled centre would only be visible from inside that sealed centre.
      showInner: innerIsExposed,
      showTop: options.showTop !== false && topIsExposed,
      seed: masonrySeed(options.seed, `ring_${ring}`),
      courseIndex: options.courseIndex + ring,
    });
  }

  if (kept < outlines.length) {
    return;
  }

  const middle = reach;

  if (!rectIsValid(middle)) {
    return;
  }

  // Whatever the rings could not close: a slab too narrow for another ring,
  // divided into stones along its length so the middle of a course is laid like
  // the rest of it rather than left as one enormous slab.
  layStrip(builder, {
    ...options,
    rect: middle,
    showBottom: false,
    seed: masonrySeed(options.seed, "middle"),
  });
}

interface StripOptions {
  readonly rect: Rect;
  readonly bottomY: number;
  readonly topY: number;
  /** False when this course is buried under another course or a moulding. */
  readonly showTop?: boolean;
  /** Whether this course ends at an exposed band crown. */
  readonly exposedTop?: boolean;
  readonly showBottom: boolean;
  readonly rule: MasonryRule;
  readonly seed: number;
}

/** A run of stones filling a slab too narrow for a ring. */
function layStrip(builder: SolidBuilder, options: StripOptions): void {
  const { rect, rule, bottomY, topY } = options;
  const alongX = rectWidth(rect) >= rectDepth(rect);
  const along = alongX ? rectWidth(rect) : rectDepth(rect);
  const widths = divideRun(along, rule, options.seed);
  const joint = rule.gap * 0.5;
  let cursor = 0;

  for (let stone = 0; stone < widths.length; stone += 1) {
    const width = widths[stone] ?? 0;
    const first = stone === 0;
    const last = stone === widths.length - 1;
    const from = cursor + (first ? 0 : joint);
    const to = cursor + width - (last ? 0 : joint);
    cursor += width;

    if (to <= from) {
      continue;
    }

    const bounds: Rect = alongX
      ? { ...rect, minX: rect.minX + from, maxX: rect.minX + to }
      : { ...rect, minZ: rect.minZ + from, maxZ: rect.minZ + to };

    builder.addBlock(
      boxOf(bounds, bottomY, topY),
      // Every side: the two ends face their neighbours in the strip, and the two
      // long sides face the innermost ring. All four have a joint beside them.
      {
        sides: [true, true, true, true],
        top: options.showTop !== false && options.exposedTop === true,
        bottom: options.showBottom,
      },
    );
  }
}

/** One run of a course: where it starts, which way it goes, and how long it is. */
interface Run {
  readonly origin: Point2;
  readonly along: Point2;
  readonly normal: Point2;
  readonly length: number;
}

function runOf(outline: Rect, orientation: HorizontalOrientation): Run {
  const edge = rectEdge(outline, orientation);
  const span = { x: edge.end.x - edge.start.x, z: edge.end.z - edge.start.z };
  const length = Math.hypot(span.x, span.z);

  return {
    origin: edge.start,
    along: length > 0 ? { x: span.x / length, z: span.z / length } : { x: 1, z: 0 },
    normal: { x: edge.normal.x, z: edge.normal.z },
    length,
  };
}

/**
 * One stone on a run: an upright box, `from`..`to` along the wall and `depth`
 * back into it.
 *
 * Whole, always. With displacement off it is an upright rectangular block. The
 * surface model this replaced sampled a course's top edge from the ideal rake,
 * turning every stone into a trapezoid and the elevation into a smooth plane
 * with a pattern on it. Here the batter lives in where the *courses* sit.
 * Displacement may roughen the two visible top arrises, but the buried pair
 * remains seated at the exact course bed.
 */
function stoneOn(
  run: Run,
  from: number,
  to: number,
  depth: number,
  options: RingOptions,
  seed: number,
  /**
   * Ends that are dressed square and may not wander, because the stone they meet
   * there is pressed against them rather than separated by a gap: the arris of a
   * corner, and the two legs of a quoin where they run into one another.
   */
  pinned: { readonly start?: boolean; readonly end?: boolean } = {},
): Block {
  const at2 = (station: number, offset: number): Point2 => ({
    x: run.origin.x + run.along.x * station - run.normal.x * offset,
    z: run.origin.z + run.along.z * station - run.normal.z * offset,
  });
  const cell = [at2(from, 0), at2(to, 0), at2(to, depth), at2(from, depth)];
  // The shared Circular setting: inset off the cell by half the gap, then move
  // every plan corner by shortest-edge × displacement. Ring order is start,
  // end, end-back, start-back.
  const dressed = insetAndJitter(cell, options.rule.gap, 0, createRandom(seed));
  // A dressed end is cut to the line: it keeps the transverse inset, so its
  // outer face stays in plane with its neighbours', but it reaches its station
  // exactly. The radial inset alone left every pinned end half a gap short —
  // and since a butted corner sits at the same station on every course, those
  // shortfalls stacked into an open column up the whole arris, seen straight
  // through from two elevations at once.
  const flushed = (corner: number): Point2 => {
    const raw = cell[corner]!;
    const soft = dressed[corner]!;
    const alongDrift = (soft.x - raw.x) * run.along.x + (soft.z - raw.z) * run.along.z;

    return {
      x: soft.x - run.along.x * alongDrift,
      z: soft.z - run.along.z * alongDrift,
    };
  };
  const cellScale = Math.min(Math.max(to - from, 0), Math.max(depth, 0));
  const normalJitter = displacementDistance(
    cellScale,
    options.rule.displacement,
  );
  const jointJitter = displacementDistance(
    depth,
    options.rule.displacement,
  );
  const verticalJitter = jointJitter;
  const square = [pinned.start === true, pinned.end === true, pinned.end === true, pinned.start === true];
  const jointStationAt = (corner: number) => corner === 0
    ? from - (pinned.start === true ? 0 : options.rule.gap * 0.5)
    : to + (pinned.end === true ? 0 : options.rule.gap * 0.5);
  const jointRandom = (channel: string, corner: number) => createRandom(
    masonrySeed(
      options.seed,
      [
        channel,
        run.origin.x.toFixed(9),
        run.origin.z.toFixed(9),
        run.along.x.toFixed(9),
        run.along.z.toFixed(9),
        jointStationAt(corner).toFixed(9),
      ].join("_"),
    ),
  );
  const outwardNormalJitter = options.unbackedOuterFace === true
    ? normalJitter
    : Math.min(normalJitter, options.rule.gap * 0.45);
  const wandered = dressed.map((point, corner) => {
    // The inner two arrises are buried against the backing ring. Moving those
    // would translate the whole stone into (or away from) its backing and turn
    // a visible surface control into hidden overlap or a sight path. Circular
    // has no backing; Mass keeps this buried edge seated and displaces the two
    // exposed arrises by the same cell-relative amount.
    if (corner >= 2) {
      return point;
    }

    // Keyed by the shared course joint, exactly like alongOffset below: two
    // neighbouring stones read the same joint station and so draw the same
    // normal-axis offset for the corner they share. Drawing it from the
    // stone's own stream instead let two neighbours step toward and away from
    // the wall by different amounts, opening a real crack at their joint that
    // a shallow enough sightline could see straight through.
    const normalOffset = randomRange(
      jointRandom("joint_normal", corner),
      -normalJitter,
      outwardNormalJitter,
    );
    // Circular's tangential component uses the full cell-relative amount too.
    // Key it by the shared course joint instead of by either neighboring stone:
    // both ends then move together and keep the joint open without crossing.
    const alongOffset = randomRange(
      jointRandom("joint", corner),
      -jointJitter,
      jointJitter,
    );

    return {
      x: point.x
        + run.normal.x * normalOffset
        + run.along.x * alongOffset,
      z: point.z
        + run.normal.z * normalOffset
        + run.along.z * alongOffset,
    };
  });
  const ring = cell.map((_, corner) =>
    (square[corner] === true ? flushed(corner) : wandered[corner]!));
  // Use the same cell-scaled amount vertically as in plan; attenuating this to
  // Circular's subtle top-surface roughness made the Mass control visually
  // inert. On a stacked course, downward movement would open a crack beneath
  // the next course, so supported arrises lift from the bed while an exposed
  // crown may wander in both directions. Joint-keyed values keep neighboring
  // ends aligned and dressed corner ends stay seated.
  const topY = ring.map((_, corner) => {
    if (corner >= 2 || square[corner] === true || verticalJitter <= 0) {
      return options.topY;
    }

    return options.topY + randomRange(
      jointRandom("joint_y", corner),
      options.showInner === true ? -verticalJitter : 0,
      verticalJitter,
    );
  });

  return {
    bottom: ring.map((point) => at(point, options.bottomY)),
    top: ring.map((point, corner) => at(point, topY[corner] ?? options.topY)),
  };
}

/** True when `cover` contains `rect` entirely. */
function covers(cover: Rect, rect: Rect): boolean {
  return cover.minX <= rect.minX + 1e-9
    && cover.maxX >= rect.maxX - 1e-9
    && cover.minZ <= rect.minZ + 1e-9
    && cover.maxZ >= rect.maxZ - 1e-9;
}

/** A block filling a rectangle between two heights. */
function boxOf(rect: Rect, bottomY: number, topY: number): Block {
  const ring: Point2[] = [
    { x: rect.minX, z: rect.minZ },
    { x: rect.minX, z: rect.maxZ },
    { x: rect.maxX, z: rect.maxZ },
    { x: rect.maxX, z: rect.minZ },
  ];

  return {
    bottom: ring.map((point) => at(point, bottomY)),
    top: ring.map((point) => at(point, topY)),
  };
}

function at(point: Point2, y: number): Vertex3 {
  return { x: point.x, y, z: point.z };
}

/** The ideal outline partway up a segment, which is linear because the batter is. */
function lerpRect(from: Rect, to: Rect, t: number): Rect {
  return {
    minX: from.minX + (to.minX - from.minX) * t,
    maxX: from.maxX + (to.maxX - from.maxX) * t,
    minZ: from.minZ + (to.minZ - from.minZ) * t,
    maxZ: from.maxZ + (to.maxZ - from.maxZ) * t,
  };
}
