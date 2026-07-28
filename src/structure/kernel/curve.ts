/**
 * Shaping curves.
 *
 * Wherever a quantity is distributed across a series — band rises now, setback
 * falloff and bay rhythm later — a single bias number can only tilt the
 * distribution one way. A curve lets the shape itself be authored: heavy base
 * with a light crown, an even middle with emphasis at both ends, a steep start
 * that flattens out.
 *
 * The custom form is a cubic Bezier easing with endpoints pinned at (0, 0) and
 * (1, 1), read the same way a CSS `cubic-bezier` is: `x` is position through the
 * series, `y` is cumulative fraction of the total, and only the two interior
 * control points are authored.
 */

export interface CurveHandle {
  readonly x: number;
  readonly y: number;
}

export type ShapingCurve =
  | { readonly kind: "linear" }
  | { readonly kind: "custom"; readonly p1: CurveHandle; readonly p2: CurveHandle };

export const LINEAR_CURVE: ShapingCurve = { kind: "linear" };

export type Bezier = readonly [number, number, number, number];

/**
 * The `[x1, y1, x2, y2]` that reproduces a straight line, used as the starting
 * point when switching to a custom curve so the shape does not jump.
 */
export const LINEAR_BEZIER: Bezier = [1 / 3, 1 / 3, 2 / 3, 2 / 3];

/**
 * Named distributions, so the common shapes are one selection rather than four
 * numbers to arrive at by dragging.
 *
 * They are described by where the quantity concentrates rather than by what they
 * are for, because a curve is reused wherever something is shared across a
 * series — band rises here, setback falloff and bay rhythm later — and
 * "front-loaded" means the same thing in all of them. Callers supply their own
 * labels.
 *
 * Every shape is monotonic, so none of them can ask for a step of no size, and
 * each is far enough from its neighbours to read as a different silhouette.
 */
export const CURVE_SHAPES = {
  /** Equal steps throughout. */
  even: LINEAR_BEZIER,
  /** Steps diminish upward: about ten to one across six. */
  front_loaded: [0.2, 0.55, 0.55, 0.95],
  /** Steps grow upward — front-loaded, mirrored. */
  back_loaded: [0.45, 0.05, 0.8, 0.4],
  /** Both ends emphasised, with the run between them compressed. */
  ends_emphasised: [0.25, 0.45, 0.75, 0.55],
  /** The middle emphasised, tapering to shallow steps at both ends. */
  middle_emphasised: [0.35, 0.08, 0.65, 0.92],
} as const satisfies Record<string, Bezier>;

export type CurveShape = keyof typeof CURVE_SHAPES;

export const CURVE_SHAPE_IDS = Object.keys(CURVE_SHAPES) as readonly CurveShape[];

/** The curve a `[x1, y1, x2, y2]` describes. */
export function bezierCurve(bezier: Bezier): ShapingCurve {
  const [x1, y1, x2, y2] = bezier;
  return { kind: "custom", p1: { x: x1, y: y1 }, p2: { x: x2, y: y2 } };
}

/** Cumulative fraction at position `x`, where x and the result both span [0, 1]. */
export function evaluateCurve(curve: ShapingCurve, x: number): number {
  const clamped = Math.min(Math.max(x, 0), 1);

  if (curve.kind === "linear") {
    return clamped;
  }

  return bezierY(curve.p1, curve.p2, solveForT(curve.p1, curve.p2, clamped));
}

/**
 * Splits a total across `count` steps according to the curve's slope.
 *
 * A step's share is the curve's rise across its span, so a linear curve gives
 * uniform steps and a curve that climbs early gives a heavy base.
 *
 * Every share is floored to a small positive weight, which matters in two
 * different situations that are worth keeping apart. A steep but perfectly valid
 * curve can leave one step almost nothing; that is an extreme shape, not a
 * mistake, and it passes without comment. A curve that actually falls asks for a
 * step of negative size, which is never what was meant — the floor rescues it
 * and `nonMonotonic` says so.
 *
 * Only the second needs a handle's vertical position outside [0, 1]: across that
 * square the cubic's slope stays non-negative. A curve editor bounds each
 * handle's `x` to the domain but leaves `y` free, as CSS `cubic-bezier` does, so
 * both cases are reachable by dragging.
 */
export function distributeByCurve(
  count: number,
  total: number,
  curve: ShapingCurve,
): { readonly values: number[]; readonly nonMonotonic: boolean } {
  if (count < 1) {
    return { values: [], nonMonotonic: false };
  }

  if (count === 1) {
    return { values: [total], nonMonotonic: false };
  }

  const minimumWeight = 1 / (count * 100);
  let nonMonotonic = false;

  const weights = Array.from({ length: count }, (_unused, index) => {
    const span = evaluateCurve(curve, (index + 1) / count)
      - evaluateCurve(curve, index / count);

    if (span < 0) {
      nonMonotonic = true;
    }

    return Math.max(span, minimumWeight);
  });

  // Normalising after the floor keeps every share strictly positive and the sum
  // exactly `total`, which clamping the resolved sizes directly would not.
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);

  return {
    values: weights.map((weight) => (weight / weightTotal) * total),
    nonMonotonic,
  };
}

function bezierY(p1: CurveHandle, p2: CurveHandle, t: number): number {
  return cubic(p1.y, p2.y, t);
}

function bezierX(p1: CurveHandle, p2: CurveHandle, t: number): number {
  return cubic(p1.x, p2.x, t);
}

/** B(t) for endpoints pinned at 0 and 1, so only the interior values matter. */
function cubic(a: number, b: number, t: number): number {
  const inverse = 1 - t;
  return 3 * inverse * inverse * t * a + 3 * inverse * t * t * b + t * t * t;
}

function cubicSlope(a: number, b: number, t: number): number {
  const inverse = 1 - t;
  return 3 * inverse * inverse * a
    + 6 * inverse * t * (b - a)
    + 3 * t * t * (1 - b);
}

/**
 * Inverts x(t). Newton-Raphson converges in a few steps for the well-behaved
 * majority; bisection takes over where the slope is near zero, which a handle
 * dragged to the edge of its range produces.
 */
function solveForT(p1: CurveHandle, p2: CurveHandle, x: number): number {
  const epsilon = 1e-7;
  let t = x;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const error = bezierX(p1, p2, t) - x;

    if (Math.abs(error) < epsilon) {
      return t;
    }

    const slope = cubicSlope(p1.x, p2.x, t);

    if (Math.abs(slope) < epsilon) {
      break;
    }

    t -= error / slope;
  }

  let low = 0;
  let high = 1;
  t = x;

  for (let attempt = 0; attempt < 32; attempt += 1) {
    const error = bezierX(p1, p2, t) - x;

    if (Math.abs(error) < epsilon) {
      return t;
    }

    if (error > 0) {
      high = t;
    } else {
      low = t;
    }

    t = (low + high) * 0.5;
  }

  return t;
}
