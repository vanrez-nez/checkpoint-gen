import {
  DEFAULT_FACE_SHADING,
  type FaceShading,
  type SolidBuilder,
} from "../../../geometry/solid-builder";
import type { Point2 } from "../../../geometry/finalize";
import {
  rectCorners,
  rectDepth,
  rectEdge,
  rectWidth,
  subtractRect,
  type HorizontalOrientation,
  type Rect,
} from "../../kernel/frame";
import type { Patch } from "../../kernel/patch";
import { tintSlots } from "../../kernel/slot";
import {
  SIDE_ORIENTATIONS,
  planOutline,
  type BevelRule,
  type PlanOutline,
} from "./bevel";
import type { ElevationBandRecord } from "../../kernel/graph";
import type { MasonryRule } from "../../kernel/masonry";
import { buildMassShell } from "../../mass/shell";
import { bodyRectAt } from "./resolve";
import type {
  StelaAppliqueRecord,
  StelaPocketRecord,
  StelaRecord,
  StelaTrunkRecord,
} from "./types";

/**
 * Draws the family record directly.
 *
 * The solid is a linear bottom-to-top stack, which is the whole reason contact
 * ownership needs no general solver here: only the neighbour above can cover a
 * top face, and only the neighbour below can cover a bottom one.
 *
 * Nothing is drawn from a rectangle. Every outline passes through `planOutline`
 * first, so an unbevelled stela is the four-sided case of the same code that
 * draws a bevelled one and there is no second path to fall out of step with.
 *
 * A frame is not laid on the stack. It is a recess cut into a band, so the
 * border is stone that was never cut away — one continuous piece, with nothing
 * at its corners to join.
 */

const EPS = 1e-9;

/** The monument-wide gradient sampled between two elevations. */
type Shade = (bottomY: number, topY: number) => FaceShading;

/** Slab depth behind an emitted face. Only the outward side is ever drawn. */
const FACE_SLAB = 0.02;

export interface StelaBuildOptions {
  /** Repaint every published ornament slot in the debug surface. */
  readonly debugSlots?: boolean;
  readonly patches?: ReadonlyMap<string, Patch>;
  /** Rounds the vertical arrises; null leaves every corner hard. */
  readonly bevel?: BevelRule | null;
  /** Courses the base out of set stones; null leaves it carved. */
  readonly masonry?: MasonryRule | null;
  readonly seed?: number;
}

/**
 * The shared stone gradient, sampled over the whole monument rather than over
 * each emitted block.
 *
 * `DEFAULT_FACE_SHADING` runs a face from its bed to its top, dark to light.
 * That is the right contract for masonry, where every block really is a
 * separate stone. A stela is one stone, and this builder cuts it into dozens of
 * slabs — three slices per framed band, nine courses per rounded crown — so
 * applying the per-stone ramp to each of them restarts the gradient at every
 * cut. That is the banding: not a seam, not a UV, just the same dark-to-light
 * sweep repeated down the monument once per slab.
 */
function shadingOver(
  bottomY: number,
  topY: number,
  from: number,
  to: number,
): FaceShading {
  const span = to - from;
  const at = (y: number, low: number, high: number) =>
    span <= EPS ? high : low + (high - low) * clamp01((y - from) / span);
  return {
    bottomAo: at(bottomY, DEFAULT_FACE_SHADING.bottomAo, DEFAULT_FACE_SHADING.topAo),
    topAo: at(topY, DEFAULT_FACE_SHADING.bottomAo, DEFAULT_FACE_SHADING.topAo),
    bottomShadow: at(bottomY, DEFAULT_FACE_SHADING.bottomShadow, DEFAULT_FACE_SHADING.topShadow),
    topShadow: at(topY, DEFAULT_FACE_SHADING.bottomShadow, DEFAULT_FACE_SHADING.topShadow),
  };
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

export function buildStela(
  builder: SolidBuilder,
  stela: StelaRecord,
  options: StelaBuildOptions = {},
): void {
  const bevel = options.bevel ?? null;
  const masonry = options.masonry ?? null;
  const reference = referencePerimeter(stela);

  // A built base and a carved one are alternatives, not layers. The mass system
  // already makes exactly this choice between its shell and its bare bands, and
  // taking the same branch here is what keeps a faced base from being drawn
  // twice — once as courses and once as the slab underneath them.
  const coursed = masonry !== null && stela.base !== null;
  if (coursed && stela.base) {
    const base = stela.base;
    buildMassShell(builder, baseBands(base), {
      rule: masonry,
      seed: options.seed ?? 1,
    });

    // The shell dresses its own stones, so the base would otherwise arrive in
    // the shared masonry slot and lose the surface the family names for it.
    // Reclassifying afterwards keeps one construction grammar and one material
    // owner, rather than a second shell that differs only in its dressing.
    // Read the centroid, not every corner. Set stones are displaced by design,
    // so a stone on the top course sits a millimetre proud of the plane its
    // course nominally ends at; an exact bound leaves those few faces behind in
    // the shared masonry slot, dressed as a different stone from the course
    // they belong to.
    const ceiling = base.topY + Math.max(masonry.displacement, masonry.gap) * 2;
    builder.assignFaceMaterial((face) => {
      const y = face.reduce((sum, point) => sum + point.y, 0) / face.length;
      return y <= ceiling && y >= base.bottomY - 1e-6;
    }, "pedestal");

    // The shell paves the crown of its top course, because for a mass that
    // crown is a terrace someone stands on. Here the body stands on it, so the
    // paving under its footprint is stone nothing can ever see. The body's own
    // bed is not drawn either, which makes this contact interior on both sides
    // rather than a hole.
    builder.cullFaces((face) => face.every((point) =>
      Math.abs(point.y - base.topY) <= 1e-6
      && point.x >= stela.body.lower.minX - 1e-6
      && point.x <= stela.body.lower.maxX + 1e-6
      && point.z >= stela.body.lower.minZ - 1e-6
      && point.z <= stela.body.lower.maxZ + 1e-6));
  }

  const trunk = coursed
    ? stela.trunk.filter((element) => element.part !== "base")
    : stela.trunk;
  const from = trunk[0]?.bottomY ?? 0;
  const to = trunk[trunk.length - 1]?.topY ?? 1;
  const shade = (bottomY: number, topY: number) => shadingOver(bottomY, topY, from, to);

  for (const [index, element] of trunk.entries()) {
    const previous = index > 0 ? trunk[index - 1] : null;
    const next = index < trunk.length - 1 ? trunk[index + 1] : null;

    builder.withMaterial(element.materialRole, () => {
      if (element.pockets.length > 0) {
        addPocketedElement(builder, stela, element, bevel, reference, shade);
      } else {
        addSides(
          builder,
          element,
          element.bottomY,
          element.topY,
          stela.appliques,
          bevel,
          reference,
          shade,
        );
      }

      // The lowest element meets the ground, which this family does not model,
      // so it closes nothing downward.
      if (previous) {
        addExposedHorizontal(
          builder,
          element.lower,
          previous.upper,
          element.bottomY,
          false,
          bevel,
          shade,
        );
      }
      addExposedHorizontal(
        builder,
        element.upper,
        next?.lower ?? null,
        element.topY,
        true,
        bevel,
        shade,
      );
    });
  }

  for (const applique of stela.appliques) {
    builder.withMaterial(applique.materialRole, () => {
      addApplique(builder, stela, applique, shade);
    });
  }

  if (options.debugSlots && options.patches) {
    tintSlots(builder, stela.slots, options.patches);
  }
}

/**
 * Where each outline edge starts, as distance around the perimeter rescaled to
 * one reference perimeter for the whole monument.
 *
 * Two things have to hold at once and only this gives both. Walking the
 * perimeter makes `u` carry from a face onto the facets that round its corner
 * and back onto the next face, which a world-axis projection cannot do because
 * the axis it reads changes at the corner. Rescaling to a shared reference
 * makes the same fractional position map to the same `u` on every element, so
 * a course stacked on a wider one meets it without a jump — raw arc length
 * restarts at zero on each piece with each piece's own perimeter, and every
 * contact between differing perimeters becomes a seam.
 *
 * The price is texel density: a base half again as wide as the body carries the
 * grain half again as coarse. A density gradient is not a seam, and it falls on
 * the silhouette steps between parts rather than across a flat run.
 */
function arcLengths(outline: PlanOutline, reference: number): number[] {
  const raw: number[] = [0];
  for (const edge of outline.edges) {
    raw.push(raw[raw.length - 1]! + distance(edge.start, edge.end));
  }
  const perimeter = raw[raw.length - 1]!;
  const scale = perimeter > EPS ? reference / perimeter : 1;
  return raw.map((value) => value * scale);
}

/**
 * Base courses as elevation bands.
 *
 * `buildMassShell` reads an outline at two elevations and little else about a
 * band, and a plinth course is a prism — the same outline twice. Adapting to the
 * record it already takes reuses the whole construction grammar: coursing,
 * stone division, staggered joints and interlocking corners, all of it already
 * proven against the mass fixtures rather than written again here.
 */
function baseBands(base: NonNullable<StelaRecord["base"]>): ElevationBandRecord[] {
  return base.courses.map((course, index) => ({
    id: course.id,
    index,
    bottomY: course.bottomY,
    topY: course.topY,
    rise: course.topY - course.bottomY,
    lower: course.footprint,
    upper: course.footprint,
    wallProfile: "vertical",
    surfaceRole: "base_plinth",
    upperTransition: "walkable_terrace",
    walkable: true,
    cornice: null,
  }));
}

/**
 * The perimeter every element's `u` is measured against, rounded to a whole
 * unit.
 *
 * Walking a closed loop leaves one place where `u` returns to zero, and the
 * texture only meets itself there if the loop is a whole number of tiles round.
 * Rounding the reference buys that at whole texture scales, at the cost of a
 * few percent of texel density. It does not buy it at a fractional scale — that
 * needs the tile size, which lives in the palette, not here.
 */
function referencePerimeter(stela: StelaRecord): number {
  const raw = 2 * (rectWidth(stela.body.lower) + rectDepth(stela.body.lower));
  return Math.max(1, Math.round(raw));
}

/** Arc length at a normalised position along one of the four faces. */
function perimeterAt(
  outline: PlanOutline,
  lengths: readonly number[],
  face: HorizontalOrientation,
  u: number,
): number | null {
  const index = outline.edges.findIndex((edge) => edge.face === face);
  const edge = outline.edges[index];
  const start = lengths[index];
  const end = lengths[index + 1];
  if (!edge || start === undefined || end === undefined) {
    return null;
  }
  const [from, to] = edge.uRange;
  if (Math.abs(to - from) <= EPS) {
    return null;
  }
  return start + ((u - from) / (to - from)) * (end - start);
}

// --- stacked elements -----------------------------------------------------

/**
 * The sides of a slab between two elevations, one quad per plan edge.
 *
 * A face is emitted around anything that covers it end to end rather than
 * behind it: a ribbon running the full height of a return would otherwise leave
 * a quad nothing can ever see. Corner facets are never covered, because a ribbon
 * lies on a face and a facet belongs to none.
 */
function addSides(
  builder: SolidBuilder,
  element: StelaTrunkRecord,
  bottomY: number,
  topY: number,
  appliques: readonly StelaAppliqueRecord[],
  bevel: BevelRule | null,
  reference: number,
  shade: Shade,
): void {
  const { lower, upper } = sliceRects(element, bottomY, topY);
  if (rectWidth(lower) <= EPS || rectDepth(lower) <= EPS || topY <= bottomY + EPS) {
    return;
  }

  const lowerOutline = planOutline(lower, bevel);
  const upperOutline = planOutline(upper, bevel);
  const lengths = arcLengths(lowerOutline, reference);

  // Perimeter `u` with `v` running world height is a cylindrical wrap, and a
  // cylinder is the wrong shape for anything leaning past 45 degrees: over the
  // shoulder of a dome a whole course of surface fits into almost no height, so
  // the texture pinches to a pinwheel at the pole. Box projection already turns
  // to a planar top there, and it is left to — which is what it is for.
  const rise = topY - bottomY;
  const lean = Math.max(
    Math.abs(rectWidth(upper) - rectWidth(lower)),
    Math.abs(rectDepth(upper) - rectDepth(lower)),
  ) / 2;
  const prismatic = rise > EPS && lean <= rise;

  for (const [index, edge] of lowerOutline.edges.entries()) {
    const top = upperOutline.edges[index];
    if (!top) {
      continue;
    }
    const spanStart = lengths[index]!;
    const spanEnd = lengths[index + 1]!;
    if (!edge.face) {
      addEdgeQuad(
        builder,
        edge.start,
        edge.end,
        top.start,
        top.end,
        bottomY,
        topY,
        prismatic ? [spanStart, spanEnd] : undefined,
        shade,
      );
      continue;
    }

    const covers = appliques
      .filter((applique) =>
        applique.face === edge.face
        && applique.bottomY <= bottomY + EPS
        && applique.topY >= topY - EPS)
      .map((applique) => applique.uRange);

    for (const [from, to] of visibleWithin(edge.uRange, covers)) {
      addEdgeQuad(
        builder,
        lerpPoint(edge.start, edge.end, from),
        lerpPoint(edge.start, edge.end, to),
        lerpPoint(top.start, top.end, from),
        lerpPoint(top.start, top.end, to),
        bottomY,
        topY,
        prismatic
          ? [
            spanStart + (spanEnd - spanStart) * from,
            spanStart + (spanEnd - spanStart) * to,
          ]
          : undefined,
        shade,
      );
    }
  }
}

/**
 * A band with recesses cut into it.
 *
 * The plan is partitioned by every pocket edge, so each cell is a whole box that
 * is either kept or cut away — never partly one and partly the other. That is
 * what lets every face be decided by asking whether its neighbouring cell
 * survived, with no partial-quad bookkeeping anywhere. The bevel joins that
 * partition too, so the four corner cells are exactly the arris and hand their
 * outer faces to the outline that replaces them.
 */
function addPocketedElement(
  builder: SolidBuilder,
  stela: StelaRecord,
  element: StelaTrunkRecord,
  bevel: BevelRule | null,
  reference: number,
  shade: Shade,
): void {
  const fieldBottomY = Math.min(...element.pockets.map((pocket) => pocket.bottomY));
  const fieldTopY = Math.max(...element.pockets.map((pocket) => pocket.topY));

  // The border courses above and below the recesses are uncut full slabs.
  addSides(builder, element, element.bottomY, fieldBottomY, stela.appliques, bevel, reference, shade);
  addSides(builder, element, fieldTopY, element.topY, stela.appliques, bevel, reference, shade);

  const { lower, upper } = sliceRects(element, fieldBottomY, fieldTopY);
  const width = rectWidth(lower);
  const depth = rectDepth(lower);
  const plans = element.pockets.map((pocket) => pocketPlan(pocket, width, depth));

  const ribbons = stela.appliques.filter((applique) =>
    applique.bottomY <= fieldBottomY + EPS && applique.topY >= fieldTopY - EPS);
  const ribbonSpans = ribbons.map((ribbon) => planSpan(ribbon.face, ribbon.uRange));

  const lowerOutline = planOutline(lower, bevel);
  const upperOutline = planOutline(upper, bevel);
  const lengths = arcLengths(lowerOutline, reference);
  const arris = bevel ? Math.min(bevel.amount, Math.min(width, depth) * 0.25) : 0;

  const xCuts = cutsFrom([
    ...plans.flatMap((plan) => [plan.xMin, plan.xMax]),
    ...ribbonSpans.filter((span) => span.axis === "x").flatMap((s) => [s.min, s.max]),
    ...(arris > EPS ? [arris / width, 1 - arris / width] : []),
  ]);
  const zCuts = cutsFrom([
    ...plans.flatMap((plan) => [plan.zMin, plan.zMax]),
    ...ribbonSpans.filter((span) => span.axis === "z").flatMap((s) => [s.min, s.max]),
    ...(arris > EPS ? [arris / depth, 1 - arris / depth] : []),
  ]);

  const solid = (i: number, j: number): boolean => {
    if (i < 0 || j < 0 || i >= xCuts.length - 1 || j >= zCuts.length - 1) {
      return false;
    }
    const x = (xCuts[i]! + xCuts[i + 1]!) / 2;
    const z = (zCuts[j]! + zCuts[j + 1]!) / 2;
    return !plans.some((plan) =>
      x > plan.xMin + EPS && x < plan.xMax - EPS
      && z > plan.zMin + EPS && z < plan.zMax - EPS);
  };

  const lastI = xCuts.length - 2;
  const lastJ = zCuts.length - 2;

  for (let i = 0; i <= lastI; i += 1) {
    for (let j = 0; j <= lastJ; j += 1) {
      if (!solid(i, j)) {
        continue;
      }
      const cellLower = subRect(lower, xCuts[i]!, xCuts[i + 1]!, zCuts[j]!, zCuts[j + 1]!);
      const cellUpper = subRect(upper, xCuts[i]!, xCuts[i + 1]!, zCuts[j]!, zCuts[j + 1]!);
      const onArris = isArris(i, j, lastI, lastJ, arris);

      // Neighbour order matches SIDE_ORIENTATIONS: -X, +Z, +X, -Z.
      const neighbours = [solid(i - 1, j), solid(i, j + 1), solid(i + 1, j), solid(i, j - 1)];
      for (const [side, orientation] of SIDE_ORIENTATIONS.entries()) {
        if (neighbours[side]) {
          continue;
        }
        const outer = isOuterCell(orientation, i, j, lastI, lastJ);

        // An arris cell hands its outer faces to the outline, which owns the
        // facets that replace them.
        if (outer && (onArris || coveredByRibbon(ribbons, orientation, cellLower, lower))) {
          continue;
        }
        // An outer cell face is part of the band's own elevation, so it takes
        // the same perimeter measure the facets around it do. A recess face is
        // enclosed by a hard arris and can stay on the projection.
        const cellSpan = faceSpanOf(orientation, cellLower, lower);
        const from = perimeterAt(lowerOutline, lengths, orientation, cellSpan[0]);
        const to = perimeterAt(lowerOutline, lengths, orientation, cellSpan[1]);
        const uvSpan = outer && from !== null && to !== null
          ? ([from, to] as const)
          : undefined;
        const emit = () =>
          addBoxSide(builder, cellLower, cellUpper, fieldBottomY, fieldTopY, side, uvSpan, shade);
        if (outer) {
          emit();
        } else {
          // A face whose neighbour was cut away is a recess surface, and is
          // dressed as the field rather than as the border around it.
          builder.withMaterial("stelaField", emit);
        }
      }
    }
  }

  // The facets the arris cells gave up, plus the straight runs they shortened.
  if (arris > EPS) {
    for (const [index, edge] of lowerOutline.edges.entries()) {
      const top = upperOutline.edges[index];
      if (!top || edge.face) {
        continue;
      }
      addEdgeQuad(
        builder,
        edge.start,
        edge.end,
        top.start,
        top.end,
        fieldBottomY,
        fieldTopY,
        [lengths[index]!, lengths[index + 1]!],
        shade,
      );
    }
  }

  // Each recess closes against the uncut course above and below it.
  builder.withMaterial("stelaField", () => {
    for (const plan of plans) {
      addPlainQuad(
        builder,
        subRect(lower, plan.xMin, plan.xMax, plan.zMin, plan.zMax),
        fieldBottomY,
        true,
        shade(fieldBottomY, fieldBottomY),
      );
      addPlainQuad(
        builder,
        subRect(upper, plan.xMin, plan.xMax, plan.zMin, plan.zMax),
        fieldTopY,
        false,
        shade(fieldTopY, fieldTopY),
      );
    }
  });
}

/** Whether a cell is one of the four bevelled corners. */
function isArris(
  i: number,
  j: number,
  lastI: number,
  lastJ: number,
  arris: number,
): boolean {
  if (arris <= EPS) {
    return false;
  }
  return (i === 0 || i === lastI) && (j === 0 || j === lastJ);
}

/** A pocket as a normalised plan rectangle on the band's footprint. */
function pocketPlan(
  pocket: StelaPocketRecord,
  width: number,
  depth: number,
): { xMin: number; xMax: number; zMin: number; zMax: number } {
  const [u0, u1] = pocket.uRange;

  switch (pocket.face) {
    case "front":
      return { xMin: u0, xMax: u1, zMin: 1 - pocket.depth / depth, zMax: 1 };
    case "rear":
      return { xMin: 1 - u1, xMax: 1 - u0, zMin: 0, zMax: pocket.depth / depth };
    case "sideNegativeU":
      return { xMin: 0, xMax: pocket.depth / width, zMin: u0, zMax: u1 };
    case "sidePositiveU":
      return { xMin: 1 - pocket.depth / width, xMax: 1, zMin: 1 - u1, zMax: 1 - u0 };
  }
}

/**
 * A face-relative span as a plan-relative one. `u` runs the direction
 * `rectEdge` does, which is reversed against the axis on two of the four faces.
 */
function planSpan(
  face: HorizontalOrientation,
  uRange: readonly [number, number],
): { readonly axis: "x" | "z"; readonly min: number; readonly max: number } {
  const [u0, u1] = uRange;
  switch (face) {
    case "front":
      return { axis: "x", min: u0, max: u1 };
    case "rear":
      return { axis: "x", min: 1 - u1, max: 1 - u0 };
    case "sideNegativeU":
      return { axis: "z", min: u0, max: u1 };
    case "sidePositiveU":
      return { axis: "z", min: 1 - u1, max: 1 - u0 };
  }
}

function isOuterCell(
  orientation: HorizontalOrientation,
  i: number,
  j: number,
  lastI: number,
  lastJ: number,
): boolean {
  switch (orientation) {
    case "sideNegativeU":
      return i === 0;
    case "sidePositiveU":
      return i === lastI;
    case "front":
      return j === lastJ;
    case "rear":
      return j === 0;
  }
}

function coveredByRibbon(
  ribbons: readonly StelaAppliqueRecord[],
  orientation: HorizontalOrientation,
  cell: Rect,
  band: Rect,
): boolean {
  return ribbons.some((ribbon) => {
    if (ribbon.face !== orientation) {
      return false;
    }
    const [uMin, uMax] = faceSpanOf(orientation, cell, band);
    return uMin >= ribbon.uRange[0] - EPS && uMax <= ribbon.uRange[1] + EPS;
  });
}

function faceSpanOf(
  orientation: HorizontalOrientation,
  cell: Rect,
  band: Rect,
): readonly [number, number] {
  const width = rectWidth(band);
  const depth = rectDepth(band);
  switch (orientation) {
    case "front":
      return [(cell.minX - band.minX) / width, (cell.maxX - band.minX) / width];
    case "rear":
      return [(band.maxX - cell.maxX) / width, (band.maxX - cell.minX) / width];
    case "sideNegativeU":
      return [(cell.minZ - band.minZ) / depth, (cell.maxZ - band.minZ) / depth];
    case "sidePositiveU":
      return [(band.maxZ - cell.maxZ) / depth, (band.maxZ - cell.minZ) / depth];
  }
}

// --- appliques ------------------------------------------------------------

/**
 * A ribbon laid over a body face. The inner edge is never emitted, so the face
 * behind it stays whole where it is not subtracted away.
 */
function addApplique(
  builder: SolidBuilder,
  stela: StelaRecord,
  applique: StelaAppliqueRecord,
  shade: Shade,
): void {
  if (
    applique.topY <= applique.bottomY + EPS
    || applique.depth <= EPS
    || applique.uRange[1] <= applique.uRange[0] + EPS
  ) {
    return;
  }

  const bottom = appliqueRing(stela, applique, applique.bottomY);
  const top = appliqueRing(stela, applique, applique.topY);

  builder.addBlock(
    {
      bottom: bottom.map((point) => ({ ...point, y: applique.bottomY })),
      top: top.map((point) => ({ ...point, y: applique.topY })),
    },
    // Ring order is inner start, inner end, outer end, outer start, so edge 0
    // is the contact with the body face.
    {
      sides: [false, true, true, true],
      top: applique.capTop,
      bottom: applique.capBottom,
    },
    shade(applique.bottomY, applique.topY),
  );
}

function appliqueRing(
  stela: StelaRecord,
  applique: StelaAppliqueRecord,
  y: number,
): Point2[] {
  const rect = applique.host ?? bodyRectAt(stela.body, y);
  const edge = rectEdge(rect, applique.face);
  const start = faceParam(edge, applique.uRange[0]);
  const end = faceParam(edge, applique.uRange[1]);
  const outward = { x: edge.normal.x * applique.depth, z: edge.normal.z * applique.depth };

  return [
    start,
    end,
    { x: end.x + outward.x, z: end.z + outward.z },
    { x: start.x + outward.x, z: start.z + outward.z },
  ];
}

/**
 * Normalised position along a face, in the direction `rectEdge` runs. Slot `u`
 * and applique `u` have to agree, so both read it from the same edge.
 */
function faceParam(
  edge: { readonly start: Point2; readonly end: Point2 },
  u: number,
): Point2 {
  return {
    x: edge.start.x + (edge.end.x - edge.start.x) * u,
    z: edge.start.z + (edge.end.z - edge.start.z) * u,
  };
}

// --- primitives -----------------------------------------------------------

/**
 * The part of a horizontal crown its neighbour does not cover.
 *
 * Every outline in this stack is concentric, so the exposed area is either the
 * whole cap or a ring between two outlines — never the four-way rectangle
 * subtraction a general arrangement would need.
 */
function addExposedHorizontal(
  builder: SolidBuilder,
  outer: Rect,
  cover: Rect | null,
  y: number,
  facesUp: boolean,
  bevel: BevelRule | null,
  shade: Shade,
): void {
  if (rectWidth(outer) <= EPS || rectDepth(outer) <= EPS) {
    return;
  }
  if (cover && contains(cover, outer)) {
    return;
  }

  const outline = planOutline(outer, bevel);
  const covered = cover ? intersectRect(outer, cover) : null;
  if (!covered) {
    addCapFan(builder, outline, y, facesUp, shade(y, y));
    return;
  }
  // The covered part is clipped to the crown first, because two elements can
  // each be wider than the other on one axis; without the clip both would emit
  // a full cap at one elevation and fight over it.
  //
  // A ring of bevelled outlines only tiles cleanly when the cover is strictly
  // inside on both axes. When they share an extent the exposed area is a pair
  // of strips rather than an annulus, and the corner facets would overlap them,
  // so those fall back to plain quads — a contact seam, where a hard arris is
  // not visible anyway.
  if (strictlyInside(covered, outer)) {
    addRing(builder, outline, planOutline(covered, bevel), y, facesUp, shade(y, y));
    return;
  }
  for (const piece of subtractRect(outer, covered)) {
    addPlainQuad(builder, piece, y, facesUp, shade(y, y));
  }
}

function strictlyInside(inner: Rect, outer: Rect): boolean {
  return inner.minX > outer.minX + EPS
    && inner.maxX < outer.maxX - EPS
    && inner.minZ > outer.minZ + EPS
    && inner.maxZ < outer.maxZ - EPS;
}

/** The shared area of two rectangles, or null when they barely meet. */
function intersectRect(a: Rect, b: Rect): Rect | null {
  const rect = {
    minX: Math.max(a.minX, b.minX),
    maxX: Math.min(a.maxX, b.maxX),
    minZ: Math.max(a.minZ, b.minZ),
    maxZ: Math.min(a.maxZ, b.maxZ),
  };
  return rectWidth(rect) > EPS && rectDepth(rect) > EPS ? rect : null;
}

/** A convex outline as a fan of quads. An even vertex count leaves no triangle. */
function addCapFan(
  builder: SolidBuilder,
  outline: PlanOutline,
  y: number,
  facesUp: boolean,
  shading?: FaceShading,
): void {
  const points = outline.points;
  const first = points[0];
  if (!first) {
    return;
  }
  for (let index = 0; index + 3 < points.length; index += 2) {
    addFlatQuad(
      builder,
      [first, points[index + 1]!, points[index + 2]!, points[index + 3]!],
      y,
      facesUp,
      shading,
    );
  }
}

/** The band between two concentric outlines, one quad per edge. */
function addRing(
  builder: SolidBuilder,
  outer: PlanOutline,
  inner: PlanOutline,
  y: number,
  facesUp: boolean,
  shading?: FaceShading,
): void {
  const count = Math.min(outer.points.length, inner.points.length);
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count;
    addFlatQuad(
      builder,
      [
        outer.points[index]!,
        outer.points[next]!,
        inner.points[next]!,
        inner.points[index]!,
      ],
      y,
      facesUp,
      shading,
    );
  }
}

function addFlatQuad(
  builder: SolidBuilder,
  ring: readonly Point2[],
  y: number,
  facesUp: boolean,
  shading?: FaceShading,
): void {
  if (ring.length !== 4 || planArea(ring) <= EPS) {
    return;
  }
  const closed = ring.map((point) => ({ ...point, y }));
  builder.addBlock(
    { bottom: closed, top: closed },
    { sides: [false, false, false, false], top: facesUp, bottom: !facesUp },
    shading,
  );
}

/** One outward quad spanning two plan points at two elevations. */
function addEdgeQuad(
  builder: SolidBuilder,
  lowerStart: Point2,
  lowerEnd: Point2,
  upperStart: Point2,
  upperEnd: Point2,
  bottomY: number,
  topY: number,
  uvSpan?: readonly [number, number],
  shade?: Shade,
): void {
  if (topY <= bottomY + EPS || distance(lowerStart, lowerEnd) <= EPS) {
    return;
  }
  const inward = inwardOffset(lowerStart, lowerEnd);
  const slab = (a: Point2, b: Point2, y: number) => [
    { x: a.x, z: a.z, y },
    { x: b.x, z: b.z, y },
    { x: b.x + inward.x, z: b.z + inward.z, y },
    { x: a.x + inward.x, z: a.z + inward.z, y },
  ];
  builder.addBlock(
    {
      bottom: slab(lowerStart, lowerEnd, bottomY),
      top: slab(upperStart, upperEnd, topY),
    },
    { sides: [true, false, false, false], top: false, bottom: false, uvSpan },
    shade?.(bottomY, topY),
  );
}

/** One axis-aligned side of a box, given as the box's outline at two heights. */
function addBoxSide(
  builder: SolidBuilder,
  lower: Rect,
  upper: Rect,
  bottomY: number,
  topY: number,
  side: number,
  uvSpan?: readonly [number, number],
  shade?: Shade,
): void {
  if (rectWidth(lower) <= EPS || rectDepth(lower) <= EPS || topY <= bottomY + EPS) {
    return;
  }
  const flags: [boolean, boolean, boolean, boolean] = [false, false, false, false];
  flags[side] = true;
  builder.addBlock(
    {
      bottom: rectCorners(lower).map((point) => ({ ...point, y: bottomY })),
      top: rectCorners(upper).map((point) => ({ ...point, y: topY })),
    },
    { sides: flags, top: false, bottom: false, uvSpan },
    shade?.(bottomY, topY),
  );
}

function addPlainQuad(
  builder: SolidBuilder,
  rect: Rect,
  y: number,
  facesUp: boolean,
  shading?: FaceShading,
): void {
  addFlatQuad(builder, rectCorners(rect), y, facesUp, shading);
}

/** The element's outline at two elevations inside its own rise. */
function sliceRects(
  element: StelaTrunkRecord,
  bottomY: number,
  topY: number,
): { lower: Rect; upper: Rect } {
  const rise = element.topY - element.bottomY;
  const at = (y: number) => rise <= EPS
    ? element.lower
    : lerpRect(element.lower, element.upper, (y - element.bottomY) / rise);
  return { lower: at(bottomY), upper: at(topY) };
}

/** `span` with every covered interval removed, as fractions along `span`. */
function visibleWithin(
  span: readonly [number, number],
  covers: readonly (readonly [number, number])[],
): [number, number][] {
  const from = span[0];
  const to = span[1];
  const length = to - from;
  if (Math.abs(length) <= EPS) {
    return [];
  }

  let visible: [number, number][] = [[Math.min(from, to), Math.max(from, to)]];
  for (const [coverMin, coverMax] of covers) {
    visible = visible.flatMap(([min, max]): [number, number][] => {
      if (coverMax <= min + EPS || coverMin >= max - EPS) {
        return [[min, max]];
      }
      return ([
        [min, Math.max(coverMin, min)],
        [Math.min(coverMax, max), max],
      ] as [number, number][]).filter(([a, b]) => b - a > EPS);
    });
  }

  return visible.map(([min, max]): [number, number] => {
    const a = (min - from) / length;
    const b = (max - from) / length;
    return a <= b ? [a, b] : [b, a];
  });
}

/** Sorted, de-duplicated partition boundaries including both ends. */
function cutsFrom(values: readonly number[]): number[] {
  const cuts = [0, 1, ...values.filter((value) => value > EPS && value < 1 - EPS)];
  return [...new Set(cuts.map((value) => Math.round(value * 1e9) / 1e9))]
    .sort((a, b) => a - b);
}

function subRect(
  rect: Rect,
  xMin: number,
  xMax: number,
  zMin: number,
  zMax: number,
): Rect {
  const width = rectWidth(rect);
  const depth = rectDepth(rect);
  return {
    minX: rect.minX + width * xMin,
    maxX: rect.minX + width * xMax,
    minZ: rect.minZ + depth * zMin,
    maxZ: rect.minZ + depth * zMax,
  };
}

function lerpRect(a: Rect, b: Rect, t: number): Rect {
  return {
    minX: a.minX + (b.minX - a.minX) * t,
    maxX: a.maxX + (b.maxX - a.maxX) * t,
    minZ: a.minZ + (b.minZ - a.minZ) * t,
    maxZ: a.maxZ + (b.maxZ - a.maxZ) * t,
  };
}

function lerpPoint(a: Point2, b: Point2, t: number): Point2 {
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
}

function distance(a: Point2, b: Point2): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

/** Perpendicular to an edge, pointing into the solid for this winding. */
function inwardOffset(start: Point2, end: Point2): Point2 {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const length = Math.hypot(dx, dz);
  if (length <= EPS) {
    return { x: 0, z: 0 };
  }
  return { x: (dz / length) * FACE_SLAB, z: (-dx / length) * FACE_SLAB };
}

function planArea(ring: readonly Point2[]): number {
  let area = 0;
  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index]!;
    const next = ring[(index + 1) % ring.length]!;
    area += current.x * next.z - next.x * current.z;
  }
  return Math.abs(area) * 0.5;
}

function contains(outer: Rect, inner: Rect): boolean {
  return outer.minX <= inner.minX + EPS
    && outer.maxX >= inner.maxX - EPS
    && outer.minZ <= inner.minZ + EPS
    && outer.maxZ >= inner.maxZ - EPS;
}
