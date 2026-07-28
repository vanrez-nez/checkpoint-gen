import { finalizeGeometry } from "../../geometry/finalize";
import { IDENTITY_MATRIX, type GeometryPart } from "../../geometry/part";
import { SolidBuilder } from "../../geometry/solid-builder";
import { rectCorners, rectIsValid, type Rect } from "../kernel/frame";
import type { ElevationBandRecord, StructureGraph } from "../kernel/graph";
import type { MasonryRule } from "../kernel/masonry";
import { buildStair } from "../connector/build";
import { buildMassShell } from "./shell";

/**
 * Turns a resolved structure graph into render geometry.
 *
 * This module reads the graph and never writes to it. That direction is the
 * whole point: masonry, materials, weathering and LODs all arrive later as
 * further readers, so retuning any of them changes what gets drawn without
 * touching the topology it was drawn from. Nothing here decides proportions,
 * profiles or ornament — those are resolved upstream, in numbers.
 *
 * A mass is made of blocks and of nothing else. There are two subdivisions of
 * it, and they are alternatives rather than layers: **bare**, one block per
 * band, which is massing you can judge on its silhouette alone; and **built**,
 * where `mass/shell` divides the same volume into courses of set stone over a
 * core block. Both go through `SolidBuilder.addBlock`, which is the only thing
 * that builder can do — there is no second kind of geometry for the block layer
 * to fall out of step with.
 */

export const MASS_SECTION = "mass";

export interface TessellationResult {
  readonly parts: readonly GeometryPart[];
  readonly faceCount: number;
}

export interface TessellationOptions {
  /** Stonework laid over the walls and horizontal surfaces; null leaves them bare. */
  readonly masonry: MasonryRule | null;
  /** Root seed the stonework derives its per-course variation from. */
  readonly seed: number;
}

export function tessellateStructure(
  graph: StructureGraph,
  options: TessellationOptions = { masonry: null, seed: 1 },
): TessellationResult {
  const builder = new SolidBuilder();
  const { masonry, seed } = options;
  // The plan strip the stair permanently covers on the front elevation.
  // Facing stones inside it never show their outer face; the shell reads the
  // connector rather than the reverse, keeping construction a pure reader.
  const stair = graph.connectors[0] ?? null;
  const frontReserve = stair
    ? {
      minX: stair.flightRect.minX - (stair.parapet?.width ?? 0),
      maxX: stair.flightRect.maxX + (stair.parapet?.width ?? 0),
      minZBehind: stair.flightRect.minZ,
    }
    : null;

  for (const mass of graph.masses) {
    if (masonry) {
      buildMassShell(builder, mass.bands, { rule: masonry, seed, frontReserve });
      continue;
    }

    layBareMass(builder, mass.bands);
  }

  // Connectors are read from the same graph and drawn with the same one
  // primitive, so a stair is blocks exactly as its mass is. The bands are
  // handed over for the burial profile: a slice stops where the mass it climbs
  // swallows it.
  for (const connector of graph.connectors) {
    buildStair(builder, connector, graph.masses[0]?.bands ?? [], { masonry, seed });
  }

  const { geometry } = finalizeGeometry(builder);

  return {
    parts: [{
      id: "mass",
      section: MASS_SECTION,
      slot: "stone",
      geometry,
      matrix: IDENTITY_MATRIX,
      stoneCount: builder.blockCount,
    }],
    faceCount: builder.blockFaces.length,
  };
}

/**
 * The greybox: one block per band, flat and unsubdivided.
 *
 * The same blocks the shell is built from, just not divided into courses — a
 * whole band is one stone. That is what makes the two paths comparable: turning
 * stonework on subdivides the mass, it does not swap it for a different kind of
 * geometry drawn by different code. A cornice is a step in the outline here too,
 * so it is simply a second block sitting on the first.
 */
function layBareMass(
  builder: SolidBuilder,
  bands: readonly ElevationBandRecord[],
): void {
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];

    if (!band || !rectIsValid(band.lower)) {
      continue;
    }

    const { cornice } = band;
    // A cornice takes over the top of the band, so the wall stops short and the
    // moulding finishes it. Without one the wall runs the full rise.
    const stack: readonly {
      readonly lower: Rect;
      readonly upper: Rect;
      readonly bottomY: number;
      readonly topY: number;
    }[] = cornice
      ? [
        {
          lower: band.lower,
          upper: cornice.springing,
          bottomY: band.bottomY,
          topY: cornice.bottomY,
        },
        {
          lower: cornice.outline,
          upper: cornice.outline,
          bottomY: cornice.bottomY,
          topY: band.topY,
        },
      ]
      : [{
        lower: band.lower,
        upper: band.upper,
        bottomY: band.bottomY,
        topY: band.topY,
      }];

    for (let part = 0; part < stack.length; part += 1) {
      const piece = stack[part];

      if (!piece || !rectIsValid(piece.lower) || !rectIsValid(piece.upper)) {
        continue;
      }

      const isCrown = part === stack.length - 1;

      builder.addBlock(
        {
          bottom: rectCorners(piece.lower).map((point) => ({
            x: point.x,
            y: piece.bottomY,
            z: point.z,
          })),
          top: rectCorners(piece.upper).map((point) => ({
            x: point.x,
            y: piece.topY,
            z: point.z,
          })),
        },
        {
          sides: [true, true, true, true],
          // Only the topmost piece shows its crown; whatever sits above a lower
          // one covers it. The mass's ground face is buried and is never emitted.
          // A moulding's underside is its soffit, which oversails the wall and
          // remains visible around the supporting wall.
          top: isCrown,
          bottom: cornice !== null && part === 1,
        },
      );
    }
  }
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
      // The cornice is included because it projects past the wall: it is the
      // outermost thing the band presents, and leaving it out would make the
      // graph disagree with the geometry drawn from it.
      const outlines = band.cornice
        ? [
          [band.lower, band.bottomY],
          [band.upper, band.topY],
          [band.cornice.outline, band.cornice.bottomY],
          [band.cornice.outline, band.topY],
        ] as const
        : [
          [band.lower, band.bottomY],
          [band.upper, band.topY],
        ] as const;

      for (const [rect, y] of outlines) {
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

  // A stair projects past the base of the mass it climbs, and its parapets rise
  // past the summit it arrives on; both are part of what the structure occupies.
  for (const connector of graph.connectors) {
    const sideWidth = connector.parapet?.width ?? 0;
    const capY = connector.topY + (connector.parapet?.height ?? 0);

    if (min && max) {
      min = {
        x: Math.min(min.x, connector.flightRect.minX - sideWidth),
        y: Math.min(min.y, connector.bottomY),
        z: Math.min(min.z, connector.flightRect.minZ),
      };
      max = {
        x: Math.max(max.x, connector.flightRect.maxX + sideWidth),
        y: Math.max(max.y, capY),
        z: Math.max(max.z, connector.flightRect.maxZ),
      };
    }
  }

  return min && max ? { min, max } : null;
}
