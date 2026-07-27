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

/**
 * Handles that reproduce a straight line, used as the starting point when
 * switching to a custom curve so the shape does not jump on the first frame.
 */
export const LINEAR_HANDLES = {
  p1: { x: 1 / 3, y: 1 / 3 },
  p2: { x: 2 / 3, y: 2 / 3 },
} as const;

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
 * and `nonMonotonic` says so. Handles confined to [0, 1] can only produce the
 * first case: the cubic's slope stays non-negative across that whole square, so
 * the second is reachable only from a hand-authored curve.
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
