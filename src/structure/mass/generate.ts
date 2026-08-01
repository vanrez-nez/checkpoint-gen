import {
  HORIZONTAL_ORIENTATIONS,
  createFacadeFrame,
  createHorizontalFrame,
  insetRect,
  rectDepth,
  rectEdge,
  rectIsValid,
  rectWidth,
  uniformSetbacks,
  type HorizontalOrientation,
  type Rect,
  type Setbacks,
} from "../kernel/frame";
import {
  StructureGraphBuilder,
  type ElevationBandRecord,
  type MassRecord,
  type SiteRecord,
  type StructureGraph,
  type SummitPadRecord,
  type SummitRecord,
} from "../kernel/graph";
import type { ShapingCurve } from "../kernel/curve";
import { ordinalSegment, structurePath } from "../kernel/ids";
import {
  PATCH_ROLES,
  type Patch,
  type PatchEdges,
  type PatchEvaluator,
  type PatchAnchor,
  type PatchRegion,
  type PatchRole,
} from "../kernel/patch";
import type { SeedSet } from "../kernel/seed";
import { DiagnosticCollector } from "../kernel/validate";
import {
  resolveStair,
  stairBasis,
  unimplementedStairMember,
  type ResolvedStair,
  type StairSpec,
} from "../connector/stair";
import {
  resolveSummitCell,
  type ResolvedCell,
  type SummitCellSpec,
} from "../cell/resolve";
import { resolveCellFacades } from "../facade/resolve";
import type { FacadeSpec } from "../facade/types";
import {
  frameCellPlacement,
  resolveFrame,
  type ResolvedFrame,
} from "../frame/resolve";
import type { FrameSpec } from "../frame/types";
import {
  resolveSummitRoof,
  type SummitRoofSpec,
} from "../roof/resolve";
import {
  IMPLEMENTED_BASE_TREATMENTS,
  IMPLEMENTED_SUMMIT_TREATMENTS,
  resolveElevation,
  type BaseTreatment,
  type CorniceRule,
  type SummitTreatment,
  type WallProfile,
} from "./elevation";
import {
  IMPLEMENTED_CORNER_TREATMENTS,
  primaryRect,
  type Footprint,
} from "./footprint";

/**
 * The mass system: footprint plus elevation profile in, semantic patches out.
 *
 * Nothing here produces geometry. It resolves numbers into a graph of surfaces
 * that know their own role, frame, edges and neighbours; tessellation, and every
 * later system, reads that graph.
 */

export interface MassSpec {
  readonly id: string;
  readonly footprint: Footprint;
  readonly bandCount: number;
  readonly totalHeight: number;
  readonly heightCurve: ShapingCurve;
  readonly summitRatio: number;
  readonly setbackScales: Setbacks;
  readonly batterDegrees: number;
  /**
   * Derived from the batter angle for the profiles this phase builds. It stays
   * an authored field on the spec because the rest of the vocabulary — stepped,
   * concave, compound — is not a function of an angle and will be chosen
   * outright.
   */
  readonly wallProfile: WallProfile;
  /** Which bands carry a crowning molding, and its dimensions. */
  readonly cornice: CorniceRule;
  readonly baseTreatment: BaseTreatment;
  readonly baseProjection: number;
  readonly baseHeight: number;
  readonly summitTreatment: SummitTreatment;
  /** One authoritative placement footprint, relative to the full summit. */
  readonly summitBuildingWidthRatio: number;
  readonly summitBuildingDepthRatio: number;
  /** Rise of a `raised_pad` above the summit floor. */
  readonly summitPadHeight: number;
}

export interface StructureSpec {
  readonly id: string;
  readonly seeds: SeedSet;
  readonly groundY: number;
  readonly mass: MassSpec;
  /** Independently enabled facade-centred approach stairs. */
  readonly stairs: readonly StairSpec[];
  /** Enclosed summit assemblies. This phase supports one single chamber. */
  readonly cells: readonly SummitCellSpec[];
  /** Surface grammar applied to each enclosed cell's exterior walls. */
  readonly facade: FacadeSpec;
  /** Open support-and-span assemblies resolved independently from Cells. */
  readonly frames: readonly FrameSpec[];
  /** Roof assemblies resolved from the cells they cover. */
  readonly roofs: readonly SummitRoofSpec[];
}

const FACADE_SEGMENT: Readonly<Record<HorizontalOrientation, string>> = {
  front: "facade_front",
  rear: "facade_rear",
  sidePositiveU: "facade_side_positive_u",
  sideNegativeU: "facade_side_negative_u",
};

interface SummitForecourt {
  readonly direction: HorizontalOrientation;
  readonly rect: Rect;
}

/**
 * One resolved allocation shared by graph records, patch regions and summit
 * geometry. Keeping this in world units prevents each reader from independently
 * re-applying margins and disagreeing about where a child may stand.
 */
interface SummitPlan {
  readonly buildable: Rect;
  readonly forecourts: readonly SummitForecourt[];
  readonly buildingPad: Rect;
}

/**
 * Builds the structure graph.
 *
 * Always returns a graph, even when generation failed: the diagnostics travel
 * with it so the pane can show what went wrong instead of the caller having to
 * distinguish a thrown error from an empty result.
 */
export function generateStructure(spec: StructureSpec): StructureGraph {
  const diagnostics = new DiagnosticCollector();
  const site: SiteRecord = {
    upAxis: { x: 0, y: 1, z: 0 },
    frontAxis: { x: 0, y: 0, z: 1 },
    groundY: spec.groundY,
  };
  const graph = new StructureGraphBuilder(spec.id, spec.seeds, site);
  const massId = structurePath(spec.id, spec.mass.id);

  // Declared-but-unimplemented vocabulary members refuse the build outright.
  // Carrying on without the treatment would produce a mass that looks finished
  // and is not the one that was asked for.
  if (!IMPLEMENTED_SUMMIT_TREATMENTS.includes(spec.mass.summitTreatment)) {
    diagnostics.error(
      "summit.treatment_unimplemented",
      massId,
      `Summit treatment "${spec.mass.summitTreatment}" is declared but not implemented in this phase.`,
    );
    return graph.build(diagnostics.all);
  }

  if (!IMPLEMENTED_BASE_TREATMENTS.includes(spec.mass.baseTreatment)) {
    diagnostics.error(
      "base.treatment_unimplemented",
      massId,
      `Base treatment "${spec.mass.baseTreatment}" is declared but not implemented in this phase.`,
    );
    return graph.build(diagnostics.all);
  }

  for (const stairSpec of spec.stairs) {
    const unimplemented = unimplementedStairMember(stairSpec);

    if (unimplemented) {
      diagnostics.error(
        unimplemented.code,
        structurePath(spec.id, stairSpec.id),
        unimplemented.message,
      );
      return graph.build(diagnostics.all);
    }
  }

  const stairDirections = new Set<HorizontalOrientation>();

  for (const stairSpec of spec.stairs) {
    if (stairDirections.has(stairSpec.direction)) {
      diagnostics.error(
        "stair.duplicate_facade",
        structurePath(spec.id, stairSpec.id),
        `Facade "${stairSpec.direction}" has more than one stair; only one centred stair per facade is supported.`,
      );
      return graph.build(diagnostics.all);
    }

    stairDirections.add(stairSpec.direction);
  }

  const footprint = resolveFootprint(spec.mass.footprint, massId, diagnostics);

  if (!footprint) {
    return graph.build(diagnostics.all);
  }

  const plinth = resolvePlinth(spec, massId, footprint);
  const bandsBottomY = spec.groundY + (plinth?.rise ?? 0);
  const elevation = resolveElevation(
    {
      massId,
      footprint,
      groundY: bandsBottomY,
      bandCount: spec.mass.bandCount,
      totalHeight: spec.mass.totalHeight,
      heightCurve: spec.mass.heightCurve,
      summitRatio: spec.mass.summitRatio,
      setbackScales: spec.mass.setbackScales,
      batterDegrees: spec.mass.batterDegrees,
      wallProfile: spec.mass.wallProfile,
      cornice: spec.mass.cornice,
    },
    diagnostics,
  );

  if (!elevation) {
    return graph.build(diagnostics.all);
  }

  // The plinth is just another band, sitting below the profile and projecting
  // outward instead of stepping in, so everything downstream treats it the same.
  const bands = plinth ? [plinth.band, ...elevation.bands] : elevation.bands;
  const groundRect = plinth ? plinth.band.lower : footprint;

  // Circulation is resolved before any patch is emitted, for two reasons: a
  // stair that cannot fit refuses the whole build the way every other refusal
  // does, with nothing half-formed left behind; and the stair reserves ground
  // on the facades it climbs in front of, so the reservation has to exist on
  // each patch from the moment the patch does.
  const groundPatchId = structurePath(massId, "ground_interface");
  const stairs: ResolvedStair[] = [];

  for (const stairSpec of spec.stairs) {
    const stair = resolveStair(
      {
        structureId: spec.id,
        spec: stairSpec,
        groundY: spec.groundY,
        groundRect,
        summitRect: elevation.summitRect,
        summitY: elevation.summitY,
        bands,
        lowerPatchId: groundPatchId,
        upperPatchId: structurePath(
          massId,
          ordinalSegment("band", spec.mass.bandCount - 1),
          "summit_floor",
        ),
      },
      diagnostics,
    );

    if (!stair) {
      return graph.build(diagnostics.all);
    }

    stairs.push(stair);
  }

  const summitPlan = resolveSummitPlan(
    spec.mass,
    massId,
    elevation.summitRect,
    stairs.map((stair) => stair.record.direction),
    diagnostics,
  );

  if (!summitPlan) {
    return graph.build(diagnostics.all);
  }
  const summitPad = resolveSummitPad(
    spec.mass,
    massId,
    elevation.summitY,
    summitPlan,
    diagnostics,
  );

  if (spec.mass.summitTreatment === "raised_pad" && !summitPad) {
    return graph.build(diagnostics.all);
  }

  if (spec.cells.length > 1) {
    diagnostics.error(
      "cell.multiple_unimplemented",
      massId,
      "This phase supports one summit chamber; multiple cell assemblies are not implemented yet.",
    );
    return graph.build(diagnostics.all);
  }
  if (spec.roofs.length > 1) {
    diagnostics.error(
      "roof.multiple_unimplemented",
      massId,
      "This phase supports one summit roof; multiple roof assemblies are not implemented yet.",
    );
    return graph.build(diagnostics.all);
  }
  if (spec.frames.length > 1) {
    diagnostics.error(
      "frame.multiple_unimplemented",
      massId,
      "This phase supports one Frame assembly; multiple Frames are not implemented yet.",
    );
    return graph.build(diagnostics.all);
  }

  const summitFloorPatchId = structurePath(
    massId,
    ordinalSegment("band", spec.mass.bandCount - 1),
    "summit_floor",
  );
  const placement = summitPlacement(
    elevation.summitY,
    summitFloorPatchId,
    summitPlan,
    summitPad,
  );
  const frameSpec = spec.frames[0] ?? null;
  const cellPlacement = frameSpec && spec.cells[0]
    ? frameCellPlacement(placement, frameSpec)
    : placement;
  if (frameSpec && spec.cells[0] && !cellPlacement) {
    diagnostics.error(
      "frame.cell_clearance_invalid",
      structurePath(spec.id, frameSpec.id),
      "The Frame support and circulation inset leaves no valid footprint for the attached Cell.",
    );
    return graph.build(diagnostics.all);
  }
  const cell = spec.cells[0]
    ? resolveSummitCell(
      spec.id,
      spec.cells[0],
      cellPlacement ?? placement,
      stairs.map((stair) => stair.record.direction),
      diagnostics,
    )
    : null;

  if (spec.cells[0] && !cell) {
    return graph.build(diagnostics.all);
  }
  const resolvedFacades = cell
    ? resolveCellFacades(cell, spec.facade, diagnostics)
    : null;

  if (cell && !resolvedFacades) {
    return graph.build(diagnostics.all);
  }

  const facadedCell: ResolvedCell | null = cell && resolvedFacades
    ? {
      record: resolvedFacades.cell,
      patches: resolvedFacades.patches,
      links: resolvedFacades.links,
      exteriorOpenings: cell.exteriorOpenings,
    }
    : null;
  if (frameSpec?.roof.enabled && spec.roofs[0]) {
    diagnostics.error(
      "frame.roof_conflict",
      structurePath(spec.id, frameSpec.id),
      "An attached Frame roof replaces the separate summit Cell roof; both cannot be enabled.",
    );
    return graph.build(diagnostics.all);
  }
  const frame: ResolvedFrame | null = frameSpec
    ? resolveFrame(
      spec.id,
      frameSpec,
      placement,
      facadedCell?.record ?? null,
      stairs.map((stair) => stair.record),
      diagnostics,
    )
    : null;

  if (frameSpec && !frame) {
    return graph.build(diagnostics.all);
  }
  const roof = spec.roofs[0]
    ? resolveSummitRoof(
      spec.id,
      spec.roofs[0],
      facadedCell?.record ?? null,
      diagnostics,
    )
    : null;

  if (spec.roofs[0] && !roof) {
    return graph.build(diagnostics.all);
  }

  graph.addPatch(horizontalPatch({
    id: groundPatchId,
    role: PATCH_ROLES.groundInterface,
    rect: groundRect,
    y: spec.groundY,
    tags: ["traversable", "exterior"],
    regions: [],
  }));

  let previousTopPatchId: string | null = null;

  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];

    if (!band) {
      continue;
    }

    const next = bands[index + 1];
    const facadeIds = emitBandFacades(graph, band, stairs);

    // A facade meets the ground or the terrace it rises from, and its two
    // neighbours around the corner.
    for (const facadeId of facadeIds) {
      graph.link(facadeId, previousTopPatchId ?? groundPatchId);
    }

    for (let corner = 0; corner < facadeIds.length; corner += 1) {
      const current = facadeIds[corner];
      const neighbour = facadeIds[(corner + 1) % facadeIds.length];

      if (current && neighbour) {
        graph.link(current, neighbour);
      }
    }

    const topPatchId = next
      ? emitTerrace(graph, band, next.lower)
      : emitSummit(
        graph,
        spec.mass,
        band,
        elevation.summitRect,
        summitPlan,
        summitPad,
        facadedCell,
      );

    for (const facadeId of facadeIds) {
      graph.link(facadeId, topPatchId);
    }

    previousTopPatchId = topPatchId;
  }

  const summit = summitRecord(
    spec.mass,
    elevation.summitRect,
    elevation.summitY,
    summitFloorPatchId,
    summitPlan,
    summitPad,
  );

  graph.addMass({
    id: massId,
    footprint: groundRect,
    baseTreatment: spec.mass.baseTreatment,
    bands,
    summit,
    totalHeight: elevation.summitY - spec.groundY,
    patchIds: [
      ...bands.flatMap((band) => bandPatchIds(band)),
      ...(summitPad?.patchIds ?? []),
    ],
  } satisfies MassRecord);

  if (facadedCell) {
    for (const patch of facadedCell.patches) {
      graph.addPatch(patch);
    }
    for (const [a, b] of facadedCell.links) {
      graph.link(a, b);
    }
    graph.addCell(facadedCell.record);
    for (const facade of resolvedFacades?.facades ?? []) {
      graph.addFacade(facade);
    }
  }
  if (roof) {
    for (const patch of roof.patches) {
      graph.addPatch(patch);
    }
    for (const [a, b] of roof.links) {
      graph.link(a, b);
    }
    graph.addRoof(roof.record);
  }
  if (frame) {
    for (const patch of frame.patches) {
      graph.addPatch(patch);
    }
    for (const [a, b] of frame.links) {
      graph.link(a, b);
    }
    graph.addFrame(frame.record);
    if (frame.roof) {
      for (const patch of frame.roof.patches) {
        graph.addPatch(patch);
      }
      for (const [a, b] of frame.roof.links) {
        graph.link(a, b);
      }
      graph.addRoof(frame.roof.record);
    }
  }

  // The stair's own surfaces, once both ends it connects exist to be linked to.
  for (const stair of stairs) {
    for (const patch of stair.patches) {
      graph.addPatch(patch);
    }

    for (const [a, b] of stair.links) {
      graph.link(a, b);
    }

    graph.addConnector(stair.record);
  }

  return graph.build(diagnostics.all);
}

function resolveFootprint(
  footprint: Footprint,
  massId: string,
  diagnostics: DiagnosticCollector,
): Rect | null {
  if (!IMPLEMENTED_CORNER_TREATMENTS.includes(footprint.cornerTreatment)) {
    diagnostics.error(
      "footprint.corner_treatment_unimplemented",
      massId,
      `Corner treatment "${footprint.cornerTreatment}" is declared but not implemented in this phase.`,
    );
    return null;
  }

  const rect = primaryRect(footprint);

  if (!rect) {
    diagnostics.error(
      "footprint.composite_unimplemented",
      massId,
      `Composite footprints (${footprint.rects.length} rectangles) are not implemented in this phase.`,
    );
    return null;
  }

  return rect;
}

/**
 * The base treatment as a band below the profile. A projected footing widens the
 * footprint, so the exposed ring above it faces outward rather than being a
 * setback terrace, but it is generated by the same code path.
 */
function resolvePlinth(
  spec: StructureSpec,
  massId: string,
  footprint: Rect,
): { readonly band: ElevationBandRecord; readonly rise: number } | null {
  const { baseTreatment, baseProjection, baseHeight } = spec.mass;

  if (baseTreatment === "none" || baseHeight <= 0 || baseProjection <= 0) {
    return null;
  }

  const rect = insetRect(footprint, uniformSetbacks(-baseProjection));

  return {
    rise: baseHeight,
    band: {
      id: structurePath(massId, "base"),
      index: -1,
      bottomY: spec.groundY,
      topY: spec.groundY + baseHeight,
      rise: baseHeight,
      lower: rect,
      upper: rect,
      wallProfile: "vertical",
      surfaceRole: PATCH_ROLES.basePlinth,
      upperTransition: "ledge",
      walkable: false,
      // A footing is not a wall the profile finishes, so it never takes one.
      cornice: null,
    },
  };
}

function emitBandFacades(
  graph: StructureGraphBuilder,
  band: ElevationBandRecord,
  stairs: readonly ResolvedStair[],
): string[] {
  const evaluator: PatchEvaluator = band.wallProfile === "battered"
    ? "battered"
    : "planar";

  return HORIZONTAL_ORIENTATIONS.map((orientation) => {
    const id = structurePath(band.id, FACADE_SEGMENT[orientation]);
    const base = rectEdge(band.lower, orientation);
    const crown = rectEdge(band.upper, orientation);
    const frame = createFacadeFrame(base, band.bottomY, band.topY, crown.start);
    // A continuous stair passes every band on the facade it climbs, so that
    // facade reserves the whole assembly width against portals and damage.
    const stair = stairs.find(
      (candidate) => candidate.record.direction === orientation,
    );
    const regions = stair
      ? [stairReserveRegion(id, band.lower, orientation, stair.spanU)]
      : [];

    graph.addPatch({
      id,
      role: band.surfaceRole,
      frame,
      dimensions: {
        // The domain is measured at the base. A battered wall's visible crown is
        // shorter, which is exactly the case the stable rectangular domain
        // exists to absorb: a feature at u 0.4-0.6 stays centred either way.
        u: frame.uLength,
        v: frame.vLength,
        thickness: 0,
      },
      evaluator,
      edges: facadeEdges(id, orientation, band.cornice ? "cornice" : null),
      adjacency: [],
      regions,
      features: [],
      anchors: [],
      tags: ["exterior", orientation],
    } satisfies Patch);

    return id;
  });
}

/**
 * The strip of a facade the stair climbs in front of, in that facade's own
 * domain. The whole rise is reserved because a continuous flight passes the
 * whole band.
 */
function stairReserveRegion(
  facadeId: string,
  lower: Rect,
  orientation: HorizontalOrientation,
  spanU: readonly [number, number],
): PatchRegion {
  const edge = rectEdge(lower, orientation);
  const basis = stairBasis(orientation);
  const baseU = edge.start.x * basis.across.x
    + edge.start.z * basis.across.z;
  const width = Math.hypot(
    edge.end.x - edge.start.x,
    edge.end.z - edge.start.z,
  );

  return {
    id: structurePath(facadeId, "stair_reserve"),
    uRange: [
      Math.max((spanU[0] - baseU) / width, 0),
      Math.min((spanU[1] - baseU) / width, 1),
    ],
    vRange: [0, 1],
    priority: 100,
    allowedOperations: [],
    exclusions: [],
    tags: ["circulation", "stair", "no_build"],
  };
}

/** The ring of a band's crown left exposed by the band above. */
function emitTerrace(
  graph: StructureGraphBuilder,
  band: ElevationBandRecord,
  covered: Rect,
): string {
  const id = structurePath(band.id, band.walkable ? "terrace" : "ledge");
  const role: PatchRole = band.walkable
    ? PATCH_ROLES.terrace
    : PATCH_ROLES.transitionBand;

  graph.addPatch(horizontalPatch({
    id,
    role,
    rect: band.upper,
    y: band.topY,
    tags: band.walkable ? ["traversable", "exterior"] : ["exterior"],
    regions: [{
      id: structurePath(id, "covered"),
      ...normalizedBounds(band.upper, covered),
      priority: 100,
      allowedOperations: [],
      exclusions: [],
      tags: ["occupied", "no_build"],
    }],
  }));

  return id;
}

function emitSummit(
  graph: StructureGraphBuilder,
  mass: MassSpec,
  band: ElevationBandRecord,
  summitRect: Rect,
  plan: SummitPlan,
  pad: SummitPadRecord | null,
  cell: ResolvedCell | null,
): string {
  const id = structurePath(band.id, "summit_floor");
  const buildingPadRegionId = structurePath(id, "building_pad");
  const anchors = mass.summitTreatment === "open_floor"
    ? [superstructureAnchor(id, buildingPadRegionId)]
    : [];

  graph.addPatch(horizontalPatch({
    id,
    role: PATCH_ROLES.summitFloor,
    rect: summitRect,
    y: band.topY,
    tags: ["traversable", "exterior", "buildable"],
    regions: summitRegions(
      id,
      mass.summitTreatment,
      summitRect,
      plan,
      cell?.record.supportPatchId === id ? cell : null,
    ),
    anchors,
  }));

  if (pad) {
    emitSummitPad(graph, id, pad, cell);
  }

  return id;
}

/**
 * The placement regions the summit exposes to whatever gets built on it: the
 * whole buildable summit, a forecourt in the clearance between each requested
 * stair arrival and the configured footprint, and that authoritative footprint.
 */
function summitRegions(
  patchId: string,
  treatment: SummitTreatment,
  summitRect: Rect,
  plan: SummitPlan,
  cell: ResolvedCell | null,
): PatchRegion[] {
  const regions: PatchRegion[] = [{
    id: structurePath(patchId, "buildable"),
    ...normalizedBounds(summitRect, plan.buildable),
    priority: 10,
    allowedOperations: [],
    exclusions: [],
    tags: ["buildable"],
  }];
  const forecourtIds: Readonly<Record<HorizontalOrientation, string>> = {
    front: "forecourt",
    rear: "forecourt_rear",
    sidePositiveU: "forecourt_side_positive_u",
    sideNegativeU: "forecourt_side_negative_u",
  };

  for (const forecourt of plan.forecourts) {
    regions.push({
      id: structurePath(patchId, forecourtIds[forecourt.direction]),
      ...normalizedBounds(summitRect, forecourt.rect),
      priority: 100,
      allowedOperations: [],
      exclusions: [],
      tags: ["circulation", "stair_arrival", "no_build"],
    });
  }

  const raised = treatment === "raised_pad";
  regions.push({
    id: structurePath(patchId, raised ? "raised_pad_footprint" : "building_pad"),
    ...normalizedBounds(summitRect, plan.buildingPad),
    priority: raised ? 100 : 50,
    allowedOperations: [],
    exclusions: [],
    tags: raised
      ? ["occupied", "no_build", "summit_pad"]
      : ["buildable", "superstructure"],
  });

  if (cell) {
    regions.push(cellFootprintRegion(patchId, summitRect, cell));
  }

  return regions;
}

function resolveSummitPlan(
  mass: MassSpec,
  massId: string,
  summitRect: Rect,
  stairDirections: readonly HorizontalOrientation[],
  diagnostics: DiagnosticCollector,
): SummitPlan | null {
  const widthRatio = mass.summitBuildingWidthRatio;
  const depthRatio = mass.summitBuildingDepthRatio;

  if (
    !Number.isFinite(widthRatio)
    || !Number.isFinite(depthRatio)
    || widthRatio <= 0
    || widthRatio > 1
    || depthRatio <= 0
    || depthRatio > 1
  ) {
    diagnostics.error(
      "summit.placement_invalid_dimensions",
      massId,
      "Summit placement width and depth ratios must be greater than zero and at most one.",
    );
    return null;
  }

  const width = rectWidth(summitRect) * widthRatio;
  const depth = rectDepth(summitRect) * depthRatio;
  const centerX = (summitRect.minX + summitRect.maxX) * 0.5;
  const centerZ = (summitRect.minZ + summitRect.maxZ) * 0.5;
  const buildingPad: Rect = {
    minX: centerX - width * 0.5,
    maxX: centerX + width * 0.5,
    minZ: centerZ - depth * 0.5,
    maxZ: centerZ + depth * 0.5,
  };
  const directions = new Set(stairDirections);
  const forecourts: SummitForecourt[] = [];

  for (const direction of HORIZONTAL_ORIENTATIONS) {
    if (!directions.has(direction)) {
      continue;
    }

    switch (direction) {
      case "front":
        addForecourt(forecourts, {
          direction,
          rect: {
            minX: buildingPad.minX,
            maxX: buildingPad.maxX,
            minZ: buildingPad.maxZ,
            maxZ: summitRect.maxZ,
          },
        });
        break;
      case "rear":
        addForecourt(forecourts, {
          direction,
          rect: {
            minX: buildingPad.minX,
            maxX: buildingPad.maxX,
            minZ: summitRect.minZ,
            maxZ: buildingPad.minZ,
          },
        });
        break;
      case "sidePositiveU":
        addForecourt(forecourts, {
          direction,
          rect: {
            minX: buildingPad.maxX,
            maxX: summitRect.maxX,
            minZ: buildingPad.minZ,
            maxZ: buildingPad.maxZ,
          },
        });
        break;
      case "sideNegativeU":
        addForecourt(forecourts, {
          direction,
          rect: {
            minX: summitRect.minX,
            maxX: buildingPad.minX,
            minZ: buildingPad.minZ,
            maxZ: buildingPad.maxZ,
          },
        });
        break;
    }
  }

  return {
    buildable: summitRect,
    forecourts,
    buildingPad,
  };
}

function addForecourt(
  forecourts: SummitForecourt[],
  forecourt: SummitForecourt,
): void {
  if (rectIsValid(forecourt.rect)) {
    forecourts.push(forecourt);
  }
}

function resolveSummitPad(
  mass: MassSpec,
  massId: string,
  summitY: number,
  plan: SummitPlan,
  diagnostics: DiagnosticCollector,
): SummitPadRecord | null {
  if (mass.summitTreatment !== "raised_pad") {
    return null;
  }

  if (mass.summitPadHeight <= 0) {
    diagnostics.error(
      "summit.pad_invalid_height",
      massId,
      "A raised summit pad needs a positive height.",
    );
    return null;
  }

  const id = structurePath(massId, "summit_pad");
  const topPatchId = structurePath(id, "top");
  const band: ElevationBandRecord = {
    id,
    index: mass.bandCount,
    bottomY: summitY,
    topY: summitY + mass.summitPadHeight,
    rise: mass.summitPadHeight,
    lower: plan.buildingPad,
    upper: plan.buildingPad,
    wallProfile: "vertical",
    surfaceRole: PATCH_ROLES.summitPadSide,
    upperTransition: "none",
    walkable: true,
    cornice: null,
  };

  return {
    id,
    kind: "raised_pad",
    band,
    topPatchId,
    patchIds: [...bandPatchIds(band), topPatchId],
  };
}

function emitSummitPad(
  graph: StructureGraphBuilder,
  summitFloorPatchId: string,
  pad: SummitPadRecord,
  cell: ResolvedCell | null,
): void {
  const facadeIds = emitBandFacades(graph, pad.band, []);
  const buildingPadRegionId = structurePath(pad.topPatchId, "building_pad");

  graph.addPatch(horizontalPatch({
    id: pad.topPatchId,
    role: PATCH_ROLES.summitPad,
    rect: pad.band.upper,
    y: pad.band.topY,
    tags: ["traversable", "exterior", "buildable"],
    regions: [{
      id: buildingPadRegionId,
      uRange: [0, 1],
      vRange: [0, 1],
      priority: 50,
      allowedOperations: [],
      exclusions: [],
      tags: ["buildable", "superstructure"],
    }, ...(
      cell?.record.supportPatchId === pad.topPatchId
        ? [cellFootprintRegion(pad.topPatchId, pad.band.upper, cell)]
        : []
    )],
    anchors: [superstructureAnchor(pad.topPatchId, buildingPadRegionId)],
  }));

  for (let index = 0; index < facadeIds.length; index += 1) {
    const facadeId = facadeIds[index];
    const neighbour = facadeIds[(index + 1) % facadeIds.length];

    if (!facadeId) {
      continue;
    }

    graph.link(facadeId, summitFloorPatchId);
    graph.link(facadeId, pad.topPatchId);

    if (neighbour) {
      graph.link(facadeId, neighbour);
    }
  }
}

function cellFootprintRegion(
  patchId: string,
  surface: Rect,
  cell: ResolvedCell,
): PatchRegion {
  return {
    id: structurePath(patchId, "cell_footprint"),
    ...normalizedBounds(surface, cell.record.footprint),
    priority: 150,
    allowedOperations: [],
    exclusions: [],
    tags: ["occupied", "no_build", "cell"],
  };
}

function summitRecord(
  mass: MassSpec,
  summitRect: Rect,
  summitY: number,
  summitFloorPatchId: string,
  plan: SummitPlan,
  pad: SummitPadRecord | null,
): SummitRecord {
  const placement = summitPlacement(
    summitY,
    summitFloorPatchId,
    plan,
    pad,
  );

  return {
    y: summitY,
    rect: summitRect,
    buildable: plan.buildable,
    buildingPad: plan.buildingPad,
    treatment: mass.summitTreatment,
    patchId: summitFloorPatchId,
    placement,
    pad,
  };
}

function summitPlacement(
  summitY: number,
  summitFloorPatchId: string,
  plan: SummitPlan,
  pad: SummitPadRecord | null,
) {
  const patchId = pad?.topPatchId ?? summitFloorPatchId;

  return {
    rect: plan.buildingPad,
    patchId,
    y: pad?.band.topY ?? summitY,
    anchorId: structurePath(patchId, "anchor_superstructure"),
  };
}

function superstructureAnchor(
  patchId: string,
  regionId: string,
): PatchAnchor {
  return {
    id: structurePath(patchId, "anchor_superstructure"),
    kind: "superstructure",
    u: 0.5,
    v: 0.5,
    d: 0,
    regionId,
    orientation: "front",
  };
}

function horizontalPatch(input: {
  readonly id: string;
  readonly role: PatchRole;
  readonly rect: Rect;
  readonly y: number;
  readonly tags: readonly string[];
  readonly regions: readonly PatchRegion[];
  readonly anchors?: readonly PatchAnchor[];
}): Patch {
  const frame = createHorizontalFrame(input.rect, input.y);

  return {
    id: input.id,
    role: input.role,
    frame,
    dimensions: {
      u: rectWidth(input.rect),
      v: rectDepth(input.rect),
      thickness: 0,
    },
    evaluator: "planar",
    edges: horizontalEdges(input.id),
    adjacency: [],
    regions: input.regions,
    features: [],
    anchors: input.anchors ?? [],
    tags: input.tags,
  };
}

/**
 * `crownTreatment` records what finishes the wall at its top edge, which is what
 * makes a cornice addressable as the edge feature it is rather than as loose
 * geometry that happens to sit there.
 */
function facadeEdges(
  patchId: string,
  orientation: HorizontalOrientation,
  crownTreatment: string | null,
): PatchEdges {
  return {
    uMin: edge(patchId, "u_min", orientation),
    uMax: edge(patchId, "u_max", orientation),
    vMin: edge(patchId, "v_min", "bottom"),
    vMax: edge(patchId, "v_max", "top", crownTreatment),
  };
}

function horizontalEdges(patchId: string): PatchEdges {
  return {
    uMin: edge(patchId, "u_min", "sideNegativeU"),
    uMax: edge(patchId, "u_max", "sidePositiveU"),
    vMin: edge(patchId, "v_min", "rear"),
    vMax: edge(patchId, "v_max", "front"),
  };
}

function edge(
  patchId: string,
  segment: string,
  orientation: PatchEdges["uMin"]["orientation"],
  treatment: string | null = null,
) {
  return {
    id: structurePath(patchId, `edge_${segment}`),
    orientation,
    treatment,
  };
}

/** `inner` expressed in `outer`'s normalised domain. */
function normalizedBounds(outer: Rect, inner: Rect): {
  readonly uRange: readonly [number, number];
  readonly vRange: readonly [number, number];
} {
  const width = rectWidth(outer);
  const depth = rectDepth(outer);

  return {
    uRange: [(inner.minX - outer.minX) / width, (inner.maxX - outer.minX) / width],
    vRange: [(inner.minZ - outer.minZ) / depth, (inner.maxZ - outer.minZ) / depth],
  };
}

function bandPatchIds(band: ElevationBandRecord): string[] {
  return HORIZONTAL_ORIENTATIONS.map(
    (orientation) => structurePath(band.id, FACADE_SEGMENT[orientation]),
  );
}
