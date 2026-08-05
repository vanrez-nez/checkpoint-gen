import { finalizeGeometry } from "../../geometry/finalize";
import { IDENTITY_MATRIX, type GeometryPart } from "../../geometry/part";
import { SolidBuilder, type Vertex3 } from "../../geometry/solid-builder";
import { evaluateFrame, rectIsValid } from "../kernel/frame";
import type {
  ElevationBandRecord,
  MassRecord,
  StairConnectorRecord,
  StructureGraph,
} from "../kernel/graph";
import { patchIndex } from "../kernel/graph";
import type { MasonryRule } from "../kernel/masonry";
import { tintSlots } from "../kernel/slot";
import { buildStair } from "../connector/build";
import {
  stairLocalVertex,
  stairSteps,
  stairWorldToLocal,
  type StairStep,
} from "../connector/stair";
import {
  bandStretches,
  buildMassShell,
  layBareStretch,
  type CrownClaim,
  type PreparedField,
} from "./shell";
import { preparedFieldsOf } from "./slots";
import {
  addBareCellFloorSurface,
  buildCell,
  faceIsCellInteriorFloor,
  faceIsCoveredByCellWall,
} from "../cell/build";
import { buildRoof, faceIsCoveredByRoof } from "../roof/build";
import { compiledSurfaceFragments } from "../surface/features";
import { buildPillarHall } from "../families/pillar-hall/build";
import { buildStela } from "../families/stelae/build";
import type { BevelRule } from "../families/stelae/bevel";

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
  /** Family-owned cache section and part id; Mass remains the default reader. */
  readonly section?: string;
  readonly partId?: string;
  /** Repaint every published ornament slot in the debug surface. */
  readonly debugSlots?: boolean;
  /** Rounds stela arrises; null or absent leaves every corner hard. */
  readonly bevel?: BevelRule | null;
}

export function tessellateStructure(
  graph: StructureGraph,
  options: TessellationOptions = { masonry: null, seed: 1, stairTilesPerStep: 5 },
): TessellationResult {
  const builder = new SolidBuilder();
  const {
    masonry,
    seed,
    stairTilesPerStep = 5,
    section = MASS_SECTION,
    partId = "mass",
    debugSlots = false,
    bevel = null,
  } = options;
  const patches = patchIndex(graph);

  for (const mass of graph.masses) {
    const bands = mass.summit.pad
      ? [...mass.bands, mass.summit.pad.band]
      : mass.bands;
    // Resolved before either path branches, because a stretch laid flat inside
    // an otherwise coursed mass reaches the same crown the greybox does.
    const cell = graph.cells.find(
      (candidate) =>
        candidate.supportPatchId === mass.summit.placement?.patchId,
    ) ?? null;
    const crownClaim: CrownClaim | null = cell
      ? {
        y: cell.bottomY,
        fill: (upper, y) => addBareCellFloorSurface(builder, upper, cell, y),
      }
      : null;

    const prepared = preparedStretches(mass, bands);

    if (masonry) {
      buildMassShell(builder, bands, {
        rule: masonry,
        seed,
        preparedStretches: prepared,
        crownClaim,
      });
      continue;
    }

    layBareMass(builder, bands, crownClaim, prepared);
  }

  // The cell walls own their contact area on the supporting summit surface.
  // Cull before the cells themselves are emitted so no wall or floor face can
  // select itself.
  for (const cell of graph.cells) {
    builder.assignFaceMaterial(
      (face) => faceIsCellInteriorFloor(face, cell),
      "interior",
    );
    builder.cullFaces((face) => faceIsCoveredByCellWall(face, cell, patches));
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

  for (const cell of graph.cells) {
    builder.withMaterial(
      "summit",
      () => buildCell(builder, cell, patches, masonry, seed),
    );
  }


  for (const hall of graph.pillarHalls) {
    buildPillarHall(builder, hall, masonry, seed);
  }

  // A stela stands on the ground rather than on anything the graph owns, so it
  // neither culls nor is culled by the surfaces above.
  for (const stela of graph.stelae) {
    buildStela(builder, stela, { debugSlots, patches, bevel, masonry, seed });
  }

  // The roof owns the room ceiling and projected soffits. Remove only the
  // upward wall-crown faces beneath its bearing footprint, then emit the roof
  // so neither assembly leaves a coincident contact plane.
  for (const roof of graph.roofs) {
    builder.cullFaces((face) => faceIsCoveredByRoof(face, roof));
    builder.withMaterial("roof", () => buildRoof(builder, roof, patches));
  }

  // Connectors are read from the same graph and drawn with the same one
  // primitive, so a stair is blocks exactly as its mass is. The bands are
  // handed over for the burial profile: a slice stops where the mass it climbs
  // swallows it.
  for (const connector of graph.connectors) {
    builder.withMaterial("stairs", () => {
      buildStair(builder, connector, graph.masses[0]?.bands ?? [], {
        masonry,
        seed,
        tilesPerStep: stairTilesPerStep,
      });
    });
  }

  // Last, so every face the structure will show already exists. Stelae tint
  // their own as they are built; everything else is repainted from here.
  if (debugSlots) {
    tintSlots(
      builder,
      [
        ...graph.masses.flatMap((mass) => mass.slots),
        ...graph.cells.flatMap((cell) => cell.slots),
        ...graph.roofs.flatMap((roof) => roof.slots),
        ...graph.pillarHalls.flatMap((hall) => hall.slots),
      ],
      patches,
      "whole",
    );
  }

  const { geometry } = finalizeGeometry(builder);

  return {
    parts: [{
      id: partId,
      section,
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

  const ys = face.map((corner) => corner.y);
  const local = face.map((corner) => stairWorldToLocal(stair, corner));
  const us = local.map((corner) => corner.u);
  const vs = local.map((corner) => corner.v);
  const minU = Math.min(...us);
  const maxU = Math.max(...us);
  const minV = Math.min(...vs);
  const maxV = Math.max(...vs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const { parapet } = stair;
  const sideWidth = parapet?.width ?? 0;
  const corniceProjection = parapet?.cornice?.projection ?? 0;
  const flightMinU = -stair.width * 0.5;
  const flightMaxU = stair.width * 0.5;
  const assemblyMinU = flightMinU - sideWidth - corniceProjection;
  const assemblyMaxU = flightMaxU + sideWidth + corniceProjection;

  if (
    minU < assemblyMinU - EPS
    || maxU > assemblyMaxU + EPS
    || minV < -EPS
    || maxV > stair.run + EPS
    || minY < stair.bottomY - EPS
  ) {
    return false;
  }

  // Steps are ordered foot first. On a shared riser boundary, choosing the
  // earlier/lower tread is conservative and keeps a face unless the lower
  // volume hides it too.
  const coveringStep = steps.find((step) =>
    maxV >= step.vBack - EPS && maxV <= step.vFront + EPS);

  if (!coveringStep) {
    return false;
  }

  const bodyMinU = flightMinU - sideWidth;
  const bodyMaxU = flightMaxU + sideWidth;
  const whollyInNegativeSide = parapet !== null
    && minU >= bodyMinU - EPS
    && maxU < flightMinU - EPS;
  const whollyInPositiveSide = parapet !== null
    && minU > flightMaxU + EPS
    && maxU <= bodyMaxU + EPS;
  const whollyInSide = whollyInNegativeSide || whollyInPositiveSide;

  // The flat parapet is a continuous ground-backed heightfield rather than one
  // cap per tread. Its lowest point across a face's z span is at maxZ, toward
  // the stair foot. Projection-only strips contain just the cornice, not wall
  // below it, so they remain conservatively uncancelled.
  if (stair.sideTreatment === "sloped_parapet" && parapet) {
    if (!whollyInSide) {
      return maxY <= coveringStep.topY + EPS
        && minU >= flightMinU - EPS
        && maxU <= flightMaxU + EPS;
    }

    const progress = (stair.run - maxV) / stair.run;
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
 * The band stretches this mass has prepared for engraving, and the fields on
 * each.
 *
 * A slot's `bandId` is the stretch it was cut from, so the gating rule is one
 * lookup rather than a second traversal of the elevation: whatever the resolver
 * decided to publish is exactly what the tessellator lays flat. Reading it back
 * off the graph is also what keeps this module a pure reader.
 */
function preparedStretches(
  mass: MassRecord,
  bands: readonly ElevationBandRecord[],
): ReadonlyMap<string, readonly PreparedField[]> {
  const prepared = new Map<string, readonly PreparedField[]>();

  if (mass.slots.length === 0) {
    return prepared;
  }

  for (const band of bands) {
    for (const stretch of bandStretches(band)) {
      const fields = preparedFieldsOf(band, stretch, mass.slots, mass.frames);

      if (fields.length > 0) {
        prepared.set(stretch.id, fields);
      }
    }
  }

  return prepared;
}

/**
 * The greybox: one block per band stretch, flat and unsubdivided.
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
  crownClaim: CrownClaim | null,
  prepared: ReadonlyMap<string, readonly PreparedField[]>,
): void {
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];

    if (!band || !rectIsValid(band.lower)) {
      continue;
    }

    const stretches = bandStretches(band);
    const under = bands[index + 1]?.lower ?? null;

    for (const [part, stretch] of stretches.entries()) {
      // A bare elevation is already a plane, so nothing has to be gated — but
      // the field still needs edges of its own, or the border it was measured
      // with is a number no face answers to.
      layBareStretch(builder, stretch, {
        isCrown: part === stretches.length - 1,
        under,
        crownClaim,
        fields: prepared.get(stretch.id),
      });
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
    const bands = mass.summit.pad
      ? [...mass.bands, mass.summit.pad.band]
      : mass.bands;

    for (const band of bands) {
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

    const halfU = connector.width * 0.5 + sideWidth;
    const corners = [
      stairLocalVertex(
        connector,
        -halfU,
        connector.bottomY,
        -terminalLength,
      ),
      stairLocalVertex(
        connector,
        halfU,
        connector.bottomY,
        -terminalLength,
      ),
      stairLocalVertex(
        connector,
        -halfU,
        capY,
        connector.run + terminalLength,
      ),
      stairLocalVertex(
        connector,
        halfU,
        capY,
        connector.run + terminalLength,
      ),
    ];

    for (const corner of corners) {
      min = min === null
        ? { ...corner }
        : {
          x: Math.min(min.x, corner.x),
          y: Math.min(min.y, corner.y),
          z: Math.min(min.z, corner.z),
        };
      max = max === null
        ? { ...corner }
        : {
          x: Math.max(max.x, corner.x),
          y: Math.max(max.y, corner.y),
          z: Math.max(max.z, corner.z),
        };
    }
  }

  for (const cell of graph.cells) {
    const outlines = [
      [cell.footprint, cell.bottomY],
      [cell.footprint, cell.topY],
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

  for (const hall of graph.pillarHalls) {
    const outlines = [
      ...hall.supports.flatMap((support) => support.sections.map((section) => [
        section.footprint,
        section.topY,
      ] as const)),
      ...hall.members.map((member) => [member.rect, member.topY] as const),
      ...(hall.roof ? [[hall.roof.footprint, hall.roof.topY] as const] : []),
    ];
    for (const [rect, y] of outlines) {
      min = min === null
        ? { x: rect.minX, y: hall.bottomY, z: rect.minZ }
        : {
          x: Math.min(min.x, rect.minX),
          y: Math.min(min.y, hall.bottomY),
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

  // Facade projections are resolved surface depth, so they may extend beyond
  // the Cell footprint even though they do not change the Cell's plan record.
  const patches = patchIndex(graph);
  for (const facade of graph.facades) {
    const patch = patches.get(facade.exteriorPatchId);
    if (!patch) {
      continue;
    }
    for (const compiled of compiledSurfaceFragments(patch)) {
      if (compiled.feature.operation !== "extrude") {
        continue;
      }
      for (const fragment of compiled.fragments) {
        for (const [u, v] of [
          [fragment.uMin, fragment.vMin],
          [fragment.uMax, fragment.vMin],
          [fragment.uMin, fragment.vMax],
          [fragment.uMax, fragment.vMax],
        ] as const) {
          const point = evaluateFrame(patch.frame, u, v, compiled.feature.depth);
          min = min === null
            ? { ...point }
            : {
              x: Math.min(min.x, point.x),
              y: Math.min(min.y, point.y),
              z: Math.min(min.z, point.z),
            };
          max = max === null
            ? { ...point }
            : {
              x: Math.max(max.x, point.x),
              y: Math.max(max.y, point.y),
              z: Math.max(max.z, point.z),
            };
        }
      }
    }
  }

  for (const roof of graph.roofs) {
    const outline = roof.roofType === "flat_slab"
      ? roof.cornice?.outline ?? roof.slabFootprint
      : roof.slabFootprint;
    const corners = [
      [roof.slabFootprint, roof.bottomY],
      [outline, roof.topY],
    ] as const;

    for (const [rect, y] of corners) {
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

  return min && max ? { min, max } : null;
}
