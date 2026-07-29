import { finalizeGeometry } from "../../geometry/finalize";
import { IDENTITY_MATRIX, type GeometryPart } from "../../geometry/part";
import { SolidBuilder, type Vertex3 } from "../../geometry/solid-builder";
import { rectCorners, rectIsValid, type Rect } from "../kernel/frame";
import type {
  ElevationBandRecord,
  StairConnectorRecord,
  StructureGraph,
} from "../kernel/graph";
import type { MasonryRule } from "../kernel/masonry";
import { buildStair } from "../connector/build";
import { stairSteps, type StairStep } from "../connector/stair";
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
const EPS = 1e-9;

export interface TessellationResult {
  readonly parts: readonly GeometryPart[];
  readonly faceCount: number;
}

export interface TessellationOptions {
  /** Stonework laid over the walls and horizontal surfaces; null leaves them bare. */
  readonly masonry: MasonryRule | null;
  /** Root seed the stonework derives its per-course variation from. */
  readonly seed: number;
  /** Exact masonry tile count across each stair tread. */
  readonly stairTilesPerStep?: number;
}

export function tessellateStructure(
  graph: StructureGraph,
  options: TessellationOptions = { masonry: null, seed: 1, stairTilesPerStep: 5 },
): TessellationResult {
  const builder = new SolidBuilder();
  const { masonry, seed, stairTilesPerStep = 5 } = options;

  for (const mass of graph.masses) {
    if (masonry) {
      buildMassShell(builder, mass.bands, { rule: masonry, seed });
      continue;
    }

    layBareMass(builder, mass.bands);
  }

  // A stair is resolved before tessellation, so its complete stepped envelope
  // is known before any of its blocks are laid. Remove only mass quads wholly
  // beneath that envelope. Doing this after the mass is complete covers bare
  // bands, facing stones, terrace tops and joint cheeks with one rule; doing it
  // before connectors are built prevents the stair from culling itself.
  for (const connector of graph.connectors) {
    const steps = stairSteps(connector);
    builder.cullFaces((face) => faceIsCoveredByStair(face, connector, steps));
  }

  // Connectors are read from the same graph and drawn with the same one
  // primitive, so a stair is blocks exactly as its mass is. The bands are
  // handed over for the burial profile: a slice stops where the mass it climbs
  // swallows it.
  for (const connector of graph.connectors) {
    buildStair(builder, connector, graph.masses[0]?.bands ?? [], {
      masonry,
      seed,
      tilesPerStep: stairTilesPerStep,
    });
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
 * Whether every point of a mass quad lies beneath the resolved stair assembly.
 *
 * Mass faces are planar quads and a continuous stair is a monotone stepped
 * heightfield over its plan rectangle. The lowest tread crossed by the face's
 * z span therefore bounds the whole face: if its highest point fits under that
 * tread, the interior does too. Faces crossing the flight and a parapet use the
 * lower flight ceiling; a face wholly inside one side strip may use the raised
 * parapet cap. Any partial plan overlap remains untouched.
 */
export function faceIsCoveredByStair(
  face: readonly Vertex3[],
  stair: StairConnectorRecord,
  steps: readonly StairStep[] = stairSteps(stair),
): boolean {
  if (face.length !== 4) {
    return false;
  }

  const xs = face.map((corner) => corner.x);
  const ys = face.map((corner) => corner.y);
  const zs = face.map((corner) => corner.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const { flightRect, parapet } = stair;
  const sideWidth = parapet?.width ?? 0;
  const corniceProjection = parapet?.cornice?.projection ?? 0;
  const assemblyMinX = flightRect.minX - sideWidth - corniceProjection;
  const assemblyMaxX = flightRect.maxX + sideWidth + corniceProjection;

  if (
    minX < assemblyMinX - EPS
    || maxX > assemblyMaxX + EPS
    || minZ < flightRect.minZ - EPS
    || maxZ > flightRect.maxZ + EPS
    || minY < stair.bottomY - EPS
  ) {
    return false;
  }

  // Steps are ordered foot first. On a shared riser boundary, choosing the
  // earlier/lower tread is conservative and keeps a face unless the lower
  // volume hides it too.
  const coveringStep = steps.find((step) =>
    maxZ >= step.zBack - EPS && maxZ <= step.zFront + EPS);

  if (!coveringStep) {
    return false;
  }

  const bodyMinX = flightRect.minX - sideWidth;
  const bodyMaxX = flightRect.maxX + sideWidth;
  const whollyInNegativeSide = parapet !== null
    && minX >= bodyMinX - EPS
    && maxX < flightRect.minX - EPS;
  const whollyInPositiveSide = parapet !== null
    && minX > flightRect.maxX + EPS
    && maxX <= bodyMaxX + EPS;
  const whollyInSide = whollyInNegativeSide || whollyInPositiveSide;

  // The flat parapet is a continuous ground-backed heightfield rather than one
  // cap per tread. Its lowest point across a face's z span is at maxZ, toward
  // the stair foot. Projection-only strips contain just the cornice, not wall
  // below it, so they remain conservatively uncancelled.
  if (stair.sideTreatment === "sloped_parapet" && parapet) {
    if (!whollyInSide) {
      return maxY <= coveringStep.topY + EPS
        && minX >= flightRect.minX - EPS
        && maxX <= flightRect.maxX + EPS;
    }

    const progress = (flightRect.maxZ - maxZ) / stair.run;
    const coverY = stair.bottomY
      + progress * (stair.topY - stair.bottomY)
      + parapet.height;

    return maxY <= coverY + EPS;
  }

  const coverY = coveringStep.topY
    + (whollyInSide ? parapet?.height ?? 0 : 0);

  return maxY <= coverY + EPS;
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
    const cornice = connector.parapet?.cornice;
    const sideWidth = (connector.parapet?.width ?? 0)
      + (cornice?.projection ?? 0);
    const capY = connector.topY + (connector.parapet?.height ?? 0);
    const terminalLength = cornice
      ? (connector.parapet?.width ?? 0) + cornice.projection * 2
      : 0;

    if (min && max) {
      min = {
        x: Math.min(min.x, connector.flightRect.minX - sideWidth),
        y: Math.min(min.y, connector.bottomY),
        z: Math.min(min.z, connector.flightRect.minZ - terminalLength),
      };
      max = {
        x: Math.max(max.x, connector.flightRect.maxX + sideWidth),
        y: Math.max(max.y, capY),
        z: Math.max(max.z, connector.flightRect.maxZ + terminalLength),
      };
    }
  }

  return min && max ? { min, max } : null;
}
