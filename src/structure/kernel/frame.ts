import type { Point2 } from "../../geometry/finalize";

/**
 * The coordinate and measurement model every structure system shares.
 *
 * Dimensions are stored in real units (metres). Anything expressed as a ratio is
 * resolved against a real dimension before it reaches geometry, so a rule reads
 * the same whether it is applied to a two-metre podium or a forty-metre pyramid.
 */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Named directions, so no rule ever has to say "left" without a reference frame.
 * `front` is the primary approach direction and points along +Z; `sidePositiveU`
 * and `sideNegativeU` are +X and -X.
 */
export const ORIENTATIONS = [
  "front",
  "rear",
  "sidePositiveU",
  "sideNegativeU",
  "top",
  "bottom",
] as const;

export type Orientation = (typeof ORIENTATIONS)[number];

/** The four directions a footprint can be set back along. */
export const HORIZONTAL_ORIENTATIONS = [
  "front",
  "rear",
  "sidePositiveU",
  "sideNegativeU",
] as const;

export type HorizontalOrientation = (typeof HORIZONTAL_ORIENTATIONS)[number];

export type Setbacks = Readonly<Record<HorizontalOrientation, number>>;

/**
 * A patch's local coordinate domain. Normalised `u` and `v` span the patch
 * regardless of its real size, which is what lets a feature ("frieze band at
 * v 0.72-0.88") be written once and applied at any scale.
 */
export interface LocalFrame {
  readonly origin: Vec3;
  readonly uAxis: Vec3;
  readonly vAxis: Vec3;
  readonly normal: Vec3;
  readonly uLength: number;
  readonly vLength: number;
}

/** P(u, v, d) = origin + uAxis·(u·uLength) + vAxis·(v·vLength) + normal·d */
export function evaluateFrame(
  frame: LocalFrame,
  u: number,
  v: number,
  d = 0,
): Vec3 {
  const uScale = u * frame.uLength;
  const vScale = v * frame.vLength;

  return {
    x: frame.origin.x + frame.uAxis.x * uScale + frame.vAxis.x * vScale + frame.normal.x * d,
    y: frame.origin.y + frame.uAxis.y * uScale + frame.vAxis.y * vScale + frame.normal.y * d,
    z: frame.origin.z + frame.uAxis.z * uScale + frame.vAxis.z * vScale + frame.normal.z * d,
  };
}

/** An axis-aligned footprint rectangle on the ground plane. */
export interface Rect {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export function rectFromSize(width: number, depth: number): Rect {
  return {
    minX: -width * 0.5,
    maxX: width * 0.5,
    minZ: -depth * 0.5,
    maxZ: depth * 0.5,
  };
}

export function rectWidth(rect: Rect): number {
  return rect.maxX - rect.minX;
}

export function rectDepth(rect: Rect): number {
  return rect.maxZ - rect.minZ;
}

/** True when the rectangle still has positive extent on both axes. */
export function rectIsValid(rect: Rect): boolean {
  return rectWidth(rect) > 0 && rectDepth(rect) > 0;
}

/**
 * Corner order used everywhere a rectangle becomes geometry. Two rectangles
 * converted this way are index-aligned, which is what lets `SolidBuilder.addLoft`
 * pair a band's base outline with its narrower top outline.
 */
export function rectCorners(rect: Rect): Point2[] {
  return [
    { x: rect.minX, z: rect.minZ },
    { x: rect.minX, z: rect.maxZ },
    { x: rect.maxX, z: rect.maxZ },
    { x: rect.maxX, z: rect.minZ },
  ];
}

/**
 * Pulls each edge inward by its own setback. The result may be degenerate; the
 * caller checks `rectIsValid` and reports it rather than this silently clamping,
 * because a footprint that inverts is a configuration error worth naming.
 */
export function insetRect(rect: Rect, setbacks: Setbacks): Rect {
  return {
    minX: rect.minX + setbacks.sideNegativeU,
    maxX: rect.maxX - setbacks.sidePositiveU,
    minZ: rect.minZ + setbacks.rear,
    maxZ: rect.maxZ - setbacks.front,
  };
}

/**
 * `source` with `cover` removed, as up to four rectangles.
 *
 * This is how a horizontal crown works out what its neighbour left visible. It
 * subtracts rather than tests a centroid on purpose: a member may cover the
 * middle of a larger surface, and erasing the whole quad for that would delete
 * two exposed ends nobody asked to lose.
 */
export function subtractRect(source: Rect, cover: Rect): Rect[] {
  const overlap = {
    minX: Math.max(source.minX, cover.minX),
    maxX: Math.min(source.maxX, cover.maxX),
    minZ: Math.max(source.minZ, cover.minZ),
    maxZ: Math.min(source.maxZ, cover.maxZ),
  };

  if (rectWidth(overlap) <= RECT_EPS || rectDepth(overlap) <= RECT_EPS) {
    return [source];
  }

  return [
    { minX: source.minX, maxX: overlap.minX, minZ: source.minZ, maxZ: source.maxZ },
    { minX: overlap.maxX, maxX: source.maxX, minZ: source.minZ, maxZ: source.maxZ },
    { minX: overlap.minX, maxX: overlap.maxX, minZ: source.minZ, maxZ: overlap.minZ },
    { minX: overlap.minX, maxX: overlap.maxX, minZ: overlap.maxZ, maxZ: source.maxZ },
  ].filter((rect) => rectWidth(rect) > RECT_EPS && rectDepth(rect) > RECT_EPS);
}

const RECT_EPS = 1e-9;

export function uniformSetbacks(value: number): Setbacks {
  return {
    front: value,
    rear: value,
    sidePositiveU: value,
    sideNegativeU: value,
  };
}

/** The edge of `rect` facing `orientation`, as a start and end point. */
export function rectEdge(
  rect: Rect,
  orientation: HorizontalOrientation,
): { readonly start: Point2; readonly end: Point2; readonly normal: Vec3 } {
  switch (orientation) {
    case "front":
      return {
        start: { x: rect.minX, z: rect.maxZ },
        end: { x: rect.maxX, z: rect.maxZ },
        normal: { x: 0, y: 0, z: 1 },
      };
    case "rear":
      return {
        start: { x: rect.maxX, z: rect.minZ },
        end: { x: rect.minX, z: rect.minZ },
        normal: { x: 0, y: 0, z: -1 },
      };
    case "sidePositiveU":
      return {
        start: { x: rect.maxX, z: rect.maxZ },
        end: { x: rect.maxX, z: rect.minZ },
        normal: { x: 1, y: 0, z: 0 },
      };
    case "sideNegativeU":
      return {
        start: { x: rect.minX, z: rect.minZ },
        end: { x: rect.minX, z: rect.maxZ },
        normal: { x: -1, y: 0, z: 0 },
      };
  }
}

/**
 * A facade frame: `u` runs along the wall's base edge, `v` runs up its face.
 *
 * `vLength` is the slope length rather than the rise when the wall is battered,
 * so `v = 1` lands on the crown edge instead of somewhere inside the wall.
 */
export function createFacadeFrame(
  base: { readonly start: Point2; readonly end: Point2; readonly normal: Vec3 },
  bottomY: number,
  topY: number,
  topStart: Point2,
): LocalFrame {
  const uSpan = {
    x: base.end.x - base.start.x,
    z: base.end.z - base.start.z,
  };
  const uLength = Math.hypot(uSpan.x, uSpan.z);
  const vSpan = {
    x: topStart.x - base.start.x,
    y: topY - bottomY,
    z: topStart.z - base.start.z,
  };
  const vLength = Math.hypot(vSpan.x, vSpan.y, vSpan.z);

  return {
    origin: { x: base.start.x, y: bottomY, z: base.start.z },
    uAxis: normalize({ x: uSpan.x, y: 0, z: uSpan.z }),
    vAxis: normalize(vSpan),
    normal: base.normal,
    uLength,
    vLength,
  };
}

/**
 * A horizontal frame over a rectangle: `u` runs along +X, `v` along +Z, and the
 * normal points up. Used for terraces, summits, ground and plinth tops.
 */
export function createHorizontalFrame(rect: Rect, y: number): LocalFrame {
  return {
    origin: { x: rect.minX, y, z: rect.minZ },
    uAxis: { x: 1, y: 0, z: 0 },
    vAxis: { x: 0, y: 0, z: 1 },
    normal: { x: 0, y: 1, z: 0 },
    uLength: rectWidth(rect),
    vLength: rectDepth(rect),
  };
}

function normalize(vector: Vec3): Vec3 {
  const length = Math.hypot(vector.x, vector.y, vector.z);

  if (length <= 1e-12) {
    return { x: 0, y: 1, z: 0 };
  }

  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}
