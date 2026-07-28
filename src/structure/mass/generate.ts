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
  type SummitRecord,
} from "../kernel/graph";
import type { ShapingCurve } from "../kernel/curve";
import { ordinalSegment, structurePath } from "../kernel/ids";
import {
  PATCH_ROLES,
  type Patch,
  type PatchEdges,
  type PatchEvaluator,
  type PatchRegion,
  type PatchRole,
} from "../kernel/patch";
import type { SeedSet } from "../kernel/seed";
import { DiagnosticCollector } from "../kernel/validate";
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
  /** No-build margin inset from the summit edge. */
  readonly summitMargin: number;
  /** Depth of the front strip on the summit reserved for stair arrival. */
  readonly forecourtDepth: number;
}

export interface StructureSpec {
  readonly id: string;
  readonly seeds: SeedSet;
  readonly groundY: number;
  readonly mass: MassSpec;
}

const FACADE_SEGMENT: Readonly<Record<HorizontalOrientation, string>> = {
  front: "facade_front",
  rear: "facade_rear",
  sidePositiveU: "facade_side_positive_u",
  sideNegativeU: "facade_side_negative_u",
};

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

  const groundPatchId = structurePath(massId, "ground_interface");
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
    const facadeIds = emitBandFacades(graph, band);

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
      : emitSummit(graph, spec.mass, band, elevation.summitRect);

    for (const facadeId of facadeIds) {
      graph.link(facadeId, topPatchId);
    }

    previousTopPatchId = topPatchId;
  }

  const summit = summitRecord(spec.mass, elevation.summitRect, elevation.summitY, massId);

  graph.addMass({
    id: massId,
    footprint: groundRect,
    baseTreatment: spec.mass.baseTreatment,
    bands,
    summit,
    totalHeight: elevation.summitY - spec.groundY,
    patchIds: bands.flatMap((band) => bandPatchIds(band)),
  } satisfies MassRecord);

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
): string[] {
  const evaluator: PatchEvaluator = band.wallProfile === "battered"
    ? "battered"
    : "planar";

  return HORIZONTAL_ORIENTATIONS.map((orientation) => {
    const id = structurePath(band.id, FACADE_SEGMENT[orientation]);
    const base = rectEdge(band.lower, orientation);
    const crown = rectEdge(band.upper, orientation);
    const frame = createFacadeFrame(base, band.bottomY, band.topY, crown.start);

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
      regions: [],
      features: [],
      anchors: [],
      tags: ["exterior", orientation],
    } satisfies Patch);

    return id;
  });
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
): string {
  const id = structurePath(band.id, "summit_floor");

  graph.addPatch(horizontalPatch({
    id,
    role: PATCH_ROLES.summitFloor,
    rect: summitRect,
    y: band.topY,
    tags: ["traversable", "exterior", "buildable"],
    regions: summitRegions(id, mass, summitRect),
  }));

  return id;
}

/**
 * The placement regions the summit exposes to whatever gets built on it: the
 * buildable area inside the no-build margin, the front strip reserved for stair
 * arrival, and the pad left over behind it.
 */
function summitRegions(
  patchId: string,
  mass: MassSpec,
  summitRect: Rect,
): PatchRegion[] {
  const buildable = insetRect(summitRect, uniformSetbacks(mass.summitMargin));

  if (!rectIsValid(buildable)) {
    return [];
  }

  const buildableBounds = normalizedBounds(summitRect, buildable);
  const depth = rectDepth(summitRect);
  const forecourtDepth = Math.min(mass.forecourtDepth, rectDepth(buildable));
  // v runs along +Z and front is +Z, so the forecourt is the high-v end.
  const forecourtStart = buildableBounds.vRange[1] - forecourtDepth / depth;

  return [
    {
      id: structurePath(patchId, "buildable"),
      ...buildableBounds,
      priority: 10,
      tags: ["buildable"],
    },
    {
      id: structurePath(patchId, "forecourt"),
      uRange: buildableBounds.uRange,
      vRange: [forecourtStart, buildableBounds.vRange[1]],
      priority: 100,
      tags: ["circulation", "stair_arrival", "no_build"],
    },
    {
      id: structurePath(patchId, "building_pad"),
      uRange: buildableBounds.uRange,
      vRange: [buildableBounds.vRange[0], forecourtStart],
      priority: 50,
      tags: ["buildable", "superstructure"],
    },
  ];
}

function summitRecord(
  mass: MassSpec,
  summitRect: Rect,
  summitY: number,
  massId: string,
): SummitRecord {
  const buildable = insetRect(summitRect, uniformSetbacks(mass.summitMargin));

  return {
    y: summitY,
    rect: summitRect,
    buildable: rectIsValid(buildable) ? buildable : summitRect,
    treatment: mass.summitTreatment,
    patchId: structurePath(
      massId,
      ordinalSegment("band", mass.bandCount - 1),
      "summit_floor",
    ),
  };
}

function horizontalPatch(input: {
  readonly id: string;
  readonly role: PatchRole;
  readonly rect: Rect;
  readonly y: number;
  readonly tags: readonly string[];
  readonly regions: readonly PatchRegion[];
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
    anchors: [],
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
