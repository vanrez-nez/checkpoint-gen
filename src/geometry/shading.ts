/**
 * How every surface of a mass is shaded.
 *
 * One ramp, one table, one place. The values here are the *generated* AO and
 * crack-shadow the sliders later rescale from `userData` — not final lighting.
 *
 * This module exists because the mass used to shade itself five different ways
 * at once: a gradient on the core, the same gradient recomputed per course on
 * the wall blocks, that gradient squeezed into a cornice's own height, a flat
 * value on paving and caps, and a hard-coded 0.6 on block sides. Two surfaces
 * meeting at the same height therefore never agreed, and a terrace read as a
 * different material from the wall holding it up. Shading is a function of
 * height and which way a face points, and of nothing else.
 */

export interface FaceShading {
  readonly topAo: number;
  readonly bottomAo: number;
  readonly topShadow: number;
  readonly bottomShadow: number;
}

/** Flat, fully-open shading. Kept for callers with nothing to ramp over. */
export const FLAT_FACE_SHADING: FaceShading = {
  topAo: 1,
  bottomAo: 1,
  topShadow: 1,
  bottomShadow: 1,
};

/**
 * A default gradient for a caller that has no mass to measure against — a bare
 * builder in a test, mostly. Real geometry passes a ramp.
 */
export const DEFAULT_FACE_SHADING: FaceShading = {
  topAo: 0.72,
  bottomAo: 0.28,
  topShadow: 0.38,
  bottomShadow: 0.06,
};

/** Which way a surface faces. The only distinction shading makes. */
export type SurfaceOrientation = "up" | "side" | "down";

/** The height range the ramp spans: the whole mass, base to crown. */
export interface HeightRamp {
  readonly bottomY: number;
  readonly topY: number;
}

export interface SurfaceShading {
  readonly ao: number;
  readonly shadow: number;
}

/** Openness at the foot of a mass and at its crown. */
const BASE_AO = 0.36;
const CROWN_AO = 0.94;
const BASE_SHADOW = 0.12;
const CROWN_SHADOW = 0.6;

/**
 * How much of the ramp a face keeps, by which way it points.
 *
 * A joint's cheek and the block face beside it are the same stone lit the same
 * way, so they take the same multiplier — the joint reads as a joint because it
 * is a real 3cm slot with real depth, not because it was painted darker.
 */
const ORIENTATION_AO: Readonly<Record<SurfaceOrientation, number>> = {
  up: 1,
  side: 0.88,
  down: 0.6,
};

const ORIENTATION_SHADOW: Readonly<Record<SurfaceOrientation, number>> = {
  up: 1,
  side: 0.86,
  down: 0.55,
};

/** Where `y` sits in the ramp, clamped so nothing outside it runs away. */
function level(ramp: HeightRamp, y: number): number {
  const span = ramp.topY - ramp.bottomY;
  return span > 0 ? Math.min(Math.max((y - ramp.bottomY) / span, 0), 1) : 1;
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** The shading of one point on one surface. The only source of these numbers. */
export function shadeAt(
  ramp: HeightRamp,
  y: number,
  orientation: SurfaceOrientation,
): SurfaceShading {
  const t = level(ramp, y);

  return {
    ao: lerp(BASE_AO, CROWN_AO, t) * ORIENTATION_AO[orientation],
    shadow: lerp(BASE_SHADOW, CROWN_SHADOW, t) * ORIENTATION_SHADOW[orientation],
  };
}

/**
 * The same numbers in the shape `addLoft` wants. The ramp is linear, so a loft
 * interpolating between its two ends reproduces `shadeAt` exactly at every
 * height in between — a wall drawn as one loft and a wall drawn as fifty blocks
 * shade identically.
 */
export function loftShading(
  ramp: HeightRamp,
  bottomY: number,
  topY: number,
): FaceShading {
  const low = shadeAt(ramp, bottomY, "side");
  const high = shadeAt(ramp, topY, "side");

  return {
    bottomAo: low.ao,
    topAo: high.ao,
    bottomShadow: low.shadow,
    topShadow: high.shadow,
  };
}

/** The same, for a flat surface handed to `addCap` or `addRing`. */
export function capShading(
  ramp: HeightRamp,
  y: number,
  facing: "up" | "down",
): FaceShading {
  const { ao, shadow } = shadeAt(ramp, y, facing);

  return { topAo: ao, bottomAo: ao, topShadow: shadow, bottomShadow: shadow };
}

/**
 * Which orientation a normal counts as. Used by the invariant suite to check a
 * finished mesh against `shadeAt` without knowing what drew it.
 */
export function orientationOf(normalY: number): SurfaceOrientation {
  if (normalY > 0.5) {
    return "up";
  }

  return normalY < -0.5 ? "down" : "side";
}
