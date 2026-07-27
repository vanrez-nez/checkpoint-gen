import { finalizeGeometry } from "../../geometry/finalize";
import { IDENTITY_MATRIX, type GeometryPart } from "../../geometry/part";
import { SolidBuilder } from "../../geometry/solid-builder";
import { rectCorners, rectIsValid, type Rect } from "../kernel/frame";
import type { StructureGraph } from "../kernel/graph";

/**
 * Turns a resolved structure graph into render geometry.
 *
 * This module reads the graph and never writes to it. That direction is the
 * whole point: masonry, materials, weathering and LODs all arrive later as
 * further readers, so retuning any of them changes what gets drawn without
 * touching the topology it was drawn from. Nothing here decides proportions,
 * profiles or ornament — those are resolved upstream, in numbers.
 *
 * The output is deliberately plain: one lofted solid per band, one ring per
 * terrace, one cap for the summit. Flat, unbevelled, unsubdivided — massing you
 * can judge on its silhouette alone.
 */

export const MASS_SECTION = "mass";

export interface TessellationResult {
  readonly parts: readonly GeometryPart[];
  readonly faceCount: number;
}

export function tessellateStructure(graph: StructureGraph): TessellationResult {
  const builder = new SolidBuilder();

  for (const mass of graph.masses) {
    const { bands } = mass;

    for (let index = 0; index < bands.length; index += 1) {
      const band = bands[index];

      if (!band) {
        continue;
      }

      const lower = rectCorners(band.lower);
      const upper = rectCorners(band.upper);

      builder.addLoft(lower, upper, band.bottomY, band.topY);

      // The bottom of the stack is the only face that needs closing from below;
      // every band above sits on the one beneath it.
      if (index === 0) {
        builder.addCap(lower, band.bottomY, "down");
      }

      const next = bands[index + 1];

      if (!next) {
        builder.addCap(upper, band.topY, "up");
        continue;
      }

      // Only the ring the next band leaves exposed is drawn. Capping the band
      // fully and letting the next band's underside sit on top of it would put
      // two faces at the same depth, and they would flicker against each other.
      if (coversCompletely(band.upper, next.lower)) {
        continue;
      }

      builder.addRing(upper, rectCorners(next.lower), band.topY, "up");
    }
  }

  const { geometry } = finalizeGeometry(builder);

  return {
    parts: [{
      id: "mass",
      section: MASS_SECTION,
      slot: "stone",
      geometry,
      matrix: IDENTITY_MATRIX,
      stoneCount: 0,
    }],
    faceCount: builder.pieceCount,
  };
}

/** True when the band above leaves no ring, so there is nothing to draw. */
function coversCompletely(crown: Rect, next: Rect): boolean {
  if (!rectIsValid(crown)) {
    return true;
  }

  const epsilon = 1e-9;

  return next.minX - crown.minX <= epsilon
    && crown.maxX - next.maxX <= epsilon
    && next.minZ - crown.minZ <= epsilon
    && crown.maxZ - next.maxZ <= epsilon;
}

/**
 * The extents the graph says the structure occupies, independent of the
 * geometry. The invariant suite checks the merged bounding box against this, so
 * a tessellation that drifts from the semantic layer is caught rather than just
 * looking slightly wrong.
 */
export function graphExtents(graph: StructureGraph): {
  readonly min: { x: number; y: number; z: number };
  readonly max: { x: number; y: number; z: number };
} | null {
  let min: { x: number; y: number; z: number } | null = null;
  let max: { x: number; y: number; z: number } | null = null;

  for (const mass of graph.masses) {
    for (const band of mass.bands) {
      for (const [rect, y] of [
        [band.lower, band.bottomY],
        [band.upper, band.topY],
      ] as const) {
        min = min === null
          ? { x: rect.minX, y, z: rect.minZ }
          : {
            x: Math.min(min.x, rect.minX),
            y: Math.min(min.y, y),
            z: Math.min(min.z, rect.minZ),
          };
        max = max === null
          ? { x: rect.maxX, y, z: rect.maxZ }
          : {
            x: Math.max(max.x, rect.maxX),
            y: Math.max(max.y, y),
            z: Math.max(max.z, rect.maxZ),
          };
      }
    }
  }

  return min && max ? { min, max } : null;
}
