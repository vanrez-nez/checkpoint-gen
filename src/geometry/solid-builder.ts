import type { GeometryBuffers, Point2 } from "./finalize";

/**
 * Shading written onto a face. These are the generated values the AO and
 * crack-shadow sliders later rescale from `userData`, not final lighting.
 */
export interface FaceShading {
  readonly topAo: number;
  readonly bottomAo: number;
  readonly topShadow: number;
  readonly bottomShadow: number;
}

/**
 * Matches the masonry builder's side gradient, so a greybox mass and a stone
 * prop respond to the same AO slider the same way.
 */
export const DEFAULT_FACE_SHADING: FaceShading = {
  topAo: 0.72,
  bottomAo: 0.28,
  topShadow: 0.38,
  bottomShadow: 0.06,
};

/** Flat, fully-lit shading for horizontal surfaces. */
export const FLAT_FACE_SHADING: FaceShading = {
  topAo: 1,
  bottomAo: 1,
  topShadow: 1,
  bottomShadow: 1,
};

/**
 * Builds closed solids from horizontal polygons.
 *
 * The masonry builder extrudes a single polygon straight up with per-vertex top
 * heights, which cannot express a taper — a battered wall's top outline is
 * smaller than its base. This builder lofts between two separate polygons
 * instead, and emits caps and rings as their own pieces so a mass can expose
 * exactly the surfaces that are actually visible: the terrace ring left over
 * where the band above sets back, rather than two coplanar caps fighting for
 * the same depth.
 *
 * Winding is normalised on entry, so callers may pass polygons in either
 * direction; every emitted face ends up with an outward normal.
 */
export class SolidBuilder implements GeometryBuffers {
  readonly positions: number[] = [];
  readonly indices: number[] = [];
  readonly ambientOcclusion: number[] = [];
  readonly bakedShadow: number[] = [];
  /** Faces emitted so far, for stats and for seeding per-piece variation. */
  pieceCount = 0;

  /**
   * Side walls between two outlines. The polygons must have the same vertex
   * count; vertex `i` of `bottom` connects to vertex `i` of `top`.
   */
  addLoft(
    bottom: readonly Point2[],
    top: readonly Point2[],
    bottomY: number,
    topY: number,
    shading: FaceShading = DEFAULT_FACE_SHADING,
  ): void {
    if (bottom.length < 3 || bottom.length !== top.length) {
      throw new Error(
        "A loft requires matching outlines of at least three points.",
      );
    }

    const lower = orient(bottom);
    const upper = orient(top, lower.reversed);

    for (let index = 0; index < lower.points.length; index += 1) {
      const next = (index + 1) % lower.points.length;
      const bottomCurrent = lower.points[index];
      const bottomNext = lower.points[next];
      const topNext = upper.points[next];
      const topCurrent = upper.points[index];

      if (!bottomCurrent || !bottomNext || !topNext || !topCurrent) {
        continue;
      }

      const start = this.vertexCount();
      this.push(bottomCurrent.x, bottomY, bottomCurrent.z, shading.bottomAo, shading.bottomShadow);
      this.push(bottomNext.x, bottomY, bottomNext.z, shading.bottomAo, shading.bottomShadow);
      this.push(topNext.x, topY, topNext.z, shading.topAo, shading.topShadow);
      this.push(topCurrent.x, topY, topCurrent.z, shading.topAo, shading.topShadow);
      this.indices.push(
        start, start + 1, start + 2,
        start, start + 2, start + 3,
      );
    }

    this.pieceCount += 1;
  }

  /**
   * A filled horizontal face. Triangulated as a fan, so the outline must be
   * convex — every footprint in the mass system is a rectangle or a rectangle
   * with clipped corners.
   */
  addCap(
    polygon: readonly Point2[],
    y: number,
    facing: "up" | "down",
    shading: FaceShading = FLAT_FACE_SHADING,
  ): void {
    if (polygon.length < 3) {
      throw new Error("A cap requires at least three points.");
    }

    const outline = orient(polygon);
    const start = this.vertexCount();
    const ao = facing === "up" ? shading.topAo : shading.bottomAo;
    const shadow = facing === "up" ? shading.topShadow : shading.bottomShadow;

    for (const point of outline.points) {
      this.push(point.x, y, point.z, ao, shadow);
    }

    for (let index = 1; index < outline.points.length - 1; index += 1) {
      if (facing === "up") {
        this.indices.push(start, start + index, start + index + 1);
      } else {
        this.indices.push(start, start + index + 1, start + index);
      }
    }

    this.pieceCount += 1;
  }

  /**
   * The horizontal band between two nested outlines — a terrace walkway, a
   * plinth ledge, a coping strip. Both outlines need the same vertex count, and
   * `inner` must lie inside `outer`.
   */
  addRing(
    outer: readonly Point2[],
    inner: readonly Point2[],
    y: number,
    facing: "up" | "down",
    shading: FaceShading = FLAT_FACE_SHADING,
  ): void {
    if (outer.length < 3 || outer.length !== inner.length) {
      throw new Error(
        "A ring requires matching outlines of at least three points.",
      );
    }

    const outside = orient(outer);
    const inside = orient(inner, outside.reversed);
    const ao = facing === "up" ? shading.topAo : shading.bottomAo;
    const shadow = facing === "up" ? shading.topShadow : shading.bottomShadow;

    for (let index = 0; index < outside.points.length; index += 1) {
      const next = (index + 1) % outside.points.length;
      const outerCurrent = outside.points[index];
      const outerNext = outside.points[next];
      const innerNext = inside.points[next];
      const innerCurrent = inside.points[index];

      if (!outerCurrent || !outerNext || !innerNext || !innerCurrent) {
        continue;
      }

      const start = this.vertexCount();
      this.push(outerCurrent.x, y, outerCurrent.z, ao, shadow);
      this.push(outerNext.x, y, outerNext.z, ao, shadow);
      this.push(innerNext.x, y, innerNext.z, ao, shadow);
      this.push(innerCurrent.x, y, innerCurrent.z, ao, shadow);

      if (facing === "up") {
        this.indices.push(
          start, start + 1, start + 2,
          start, start + 2, start + 3,
        );
      } else {
        this.indices.push(
          start, start + 2, start + 1,
          start, start + 3, start + 2,
        );
      }
    }

    this.pieceCount += 1;
  }

  private vertexCount(): number {
    return this.positions.length / 3;
  }

  private push(
    x: number,
    y: number,
    z: number,
    ambientOcclusion: number,
    bakedShadow: number,
  ): void {
    this.positions.push(x, y, z);
    this.ambientOcclusion.push(ambientOcclusion);
    this.bakedShadow.push(bakedShadow);
  }
}

type OrientedPolygon = {
  readonly points: readonly Point2[];
  readonly reversed: boolean;
};

/**
 * Normalises an outline to the winding this builder's index order assumes:
 * negative shoelace area, which makes a fan over the outline face +Y and a side
 * quad walking it face outward.
 *
 * `force` pins the result to a previous polygon's decision, so the two outlines
 * of a loft or a ring stay index-aligned even if one was authored the other way
 * round.
 */
function orient(polygon: readonly Point2[], force?: boolean): OrientedPolygon {
  const reversed = force ?? signedArea(polygon) > 0;
  return { points: reversed ? [...polygon].reverse() : polygon, reversed };
}

function signedArea(points: readonly Point2[]): number {
  let area = 0;

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];

    if (current && next) {
      area += current.x * next.z - next.x * current.z;
    }
  }

  return area * 0.5;
}
