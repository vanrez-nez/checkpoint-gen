import type { Point2 } from "../../../geometry/finalize";
import {
  rectCorners,
  rectDepth,
  rectWidth,
  type HorizontalOrientation,
  type Rect,
} from "../../kernel/frame";

/**
 * Bevelled plan outlines.
 *
 * A bevel is a surface treatment, not a proportion: it never reaches the graph,
 * exactly as masonry never does. The resolver states rectangles and this turns
 * each one into the polygon the tessellator actually draws, so turning bevels
 * off leaves the serialized semantics byte-identical.
 *
 * One segment gives a flat chamfer; more give a faceted arc. There is no vertex
 * normal averaging anywhere in this project, so a rounded arris is rounded by
 * having facets small enough not to read as facets, not by shading a coarse one
 * as though it were smooth.
 */

export interface BevelRule {
  readonly amount: number;
  readonly segments: number;
}

const EPS = 1e-9;

/**
 * Block edge `i` runs from ring corner `i` to `i + 1`, and `rectCorners` starts
 * at the minimum corner, so these are the orientations in that order. They are
 * also the directions `rectEdge` runs, which is what keeps a slot's `u` and an
 * applique's `u` describing the same place.
 */
export const SIDE_ORIENTATIONS: readonly HorizontalOrientation[] = [
  "sideNegativeU",
  "front",
  "sidePositiveU",
  "rear",
];

export interface PlanEdge {
  readonly start: Point2;
  readonly end: Point2;
  /** Which of the rectangle's four arrises this edge came from. */
  readonly corner: number;
  /** Null on a corner facet, which belongs to no face. */
  readonly face: HorizontalOrientation | null;
  /** Span of the parent face this edge covers, in that face's own direction. */
  readonly uRange: readonly [number, number];
}

export interface PlanOutline {
  readonly points: readonly Point2[];
  readonly edges: readonly PlanEdge[];
}

/**
 * The outline of a rectangle with its four vertical arrises bevelled.
 *
 * The bevel is clamped to a quarter of the shorter side: past that the four
 * corners meet and the outline stops being a bevelled rectangle at all.
 */
export function planOutline(rect: Rect, bevel: BevelRule | null): PlanOutline {
  const corners = rectCorners(rect);
  const limit = Math.min(rectWidth(rect), rectDepth(rect)) * 0.25;
  const amount = bevel ? Math.min(bevel.amount, limit) : 0;
  const segments = bevel ? Math.max(Math.round(bevel.segments), 1) : 0;

  if (amount <= EPS || segments < 1) {
    return outlineFrom(corners, corners.map(() => 1), rect);
  }

  const points: Point2[] = [];
  const perCorner: number[] = [];
  for (const [index, corner] of corners.entries()) {
    const previous = corners[(index + corners.length - 1) % corners.length]!;
    const next = corners[(index + 1) % corners.length]!;
    const arc = cornerArc(corner, previous, next, amount, segments);
    points.push(...arc);
    perCorner.push(arc.length);
  }

  return outlineFrom(points, perCorner, rect);
}

/**
 * Points along one bevelled corner, from the incoming edge to the outgoing one.
 *
 * The arc centre is the corner pulled back along both edges, so the facets meet
 * each face tangentially and the outline never crosses the original rectangle.
 */
function cornerArc(
  corner: Point2,
  previous: Point2,
  next: Point2,
  amount: number,
  segments: number,
): Point2[] {
  const toPrevious = unit(previous, corner);
  const toNext = unit(next, corner);
  const start = {
    x: corner.x + toPrevious.x * amount,
    z: corner.z + toPrevious.z * amount,
  };
  const end = { x: corner.x + toNext.x * amount, z: corner.z + toNext.z * amount };
  const centre = {
    x: corner.x + (toPrevious.x + toNext.x) * amount,
    z: corner.z + (toPrevious.z + toNext.z) * amount,
  };

  if (segments === 1) {
    return [start, end];
  }

  const from = Math.atan2(start.z - centre.z, start.x - centre.x);
  let sweep = Math.atan2(end.z - centre.z, end.x - centre.x) - from;
  // The short way round: a corner turns a quarter circle, never three of them.
  while (sweep > Math.PI) {
    sweep -= Math.PI * 2;
  }
  while (sweep < -Math.PI) {
    sweep += Math.PI * 2;
  }

  return Array.from({ length: segments + 1 }, (_, index) => {
    const angle = from + sweep * (index / segments);
    return {
      x: centre.x + Math.cos(angle) * amount,
      z: centre.z + Math.sin(angle) * amount,
    };
  });
}

/**
 * Labels each edge with the face it belongs to.
 *
 * Corner `c` is followed by the straight run to corner `c + 1`, which is the
 * face `SIDE_ORIENTATIONS[c]`. Every other edge is a corner facet and belongs to
 * no face, which is what keeps a ribbon from ever being asked to cover one.
 */
function outlineFrom(
  points: readonly Point2[],
  perCorner: readonly number[],
  rect: Rect,
): PlanOutline {
  const edges: PlanEdge[] = [];
  let index = 0;

  for (const [corner, count] of perCorner.entries()) {
    const face = SIDE_ORIENTATIONS[corner]!;
    for (let step = 0; step < count; step += 1) {
      const start = points[index]!;
      const end = points[(index + 1) % points.length]!;
      const isLast = step === count - 1;
      edges.push({
        start,
        end,
        corner,
        face: isLast ? face : null,
        uRange: isLast ? faceSpan(face, start, end, rect) : [0, 0],
      });
      index += 1;
    }
  }

  return { points, edges };
}

/** Where an edge sits along its face, in that face's own direction. */
function faceSpan(
  face: HorizontalOrientation,
  start: Point2,
  end: Point2,
  rect: Rect,
): readonly [number, number] {
  const width = rectWidth(rect);
  const depth = rectDepth(rect);
  const along = (point: Point2): number => {
    switch (face) {
      case "front":
        return (point.x - rect.minX) / width;
      case "rear":
        return (rect.maxX - point.x) / width;
      case "sideNegativeU":
        return (point.z - rect.minZ) / depth;
      case "sidePositiveU":
        return (rect.maxZ - point.z) / depth;
    }
  };
  return [along(start), along(end)];
}

function unit(to: Point2, from: Point2): Point2 {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz);
  return length <= EPS ? { x: 0, z: 0 } : { x: dx / length, z: dz / length };
}
