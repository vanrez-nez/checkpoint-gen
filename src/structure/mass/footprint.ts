import { rectFromSize, type Rect } from "../kernel/frame";

/**
 * A mass footprint.
 *
 * The canonical plan is a rectangle, but the doc's larger plans — stepped, cross,
 * T, L, U, twin platforms, perimeter platforms around a court — are all
 * compositions of rectangles, and they stay useful only if their constituent
 * rectangular domains survive rather than collapsing into an anonymous polygon.
 * So the footprint is a list from the start. This phase generates the
 * single-rectangle case; composite plans add an implementation later without
 * moving the schema or invalidating a config written today.
 */
export interface Footprint {
  readonly rects: readonly Rect[];
  readonly symmetryAxes: readonly SymmetryAxis[];
  readonly cornerTreatment: CornerTreatment;
}

export type SymmetryAxis = "u" | "v";

export const CORNER_TREATMENTS = [
  "none",
  "chamfer",
  "clip",
  "radius",
] as const;

export type CornerTreatment = (typeof CORNER_TREATMENTS)[number];

/** Corner treatments this phase can actually build. */
export const IMPLEMENTED_CORNER_TREATMENTS: readonly CornerTreatment[] = ["none"];

export function createRectangleFootprint(
  width: number,
  depth: number,
  cornerTreatment: CornerTreatment = "none",
): Footprint {
  return {
    rects: [rectFromSize(width, depth)],
    symmetryAxes: ["u", "v"],
    cornerTreatment,
  };
}

/** The single rectangle a simple footprint resolves to, or null if composite. */
export function primaryRect(footprint: Footprint): Rect | null {
  return footprint.rects.length === 1 ? footprint.rects[0] ?? null : null;
}
