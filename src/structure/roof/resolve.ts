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
  type LocalFrame,
  type Rect,
} from "../kernel/frame";
import type {
  CellRecord,
  RoofCorniceRecord,
  RoofRecord,
} from "../kernel/graph";
import { structurePath } from "../kernel/ids";
import {
  PATCH_ROLES,
  type Patch,
  type PatchEdges,
  type PatchRole,
} from "../kernel/patch";
import {
  arrisEdges,
  resolveFaceSlot,
  slotDepthBudget,
  slotRuleOf,
  withSlotReservations,
  type FrameRecord,
  type SlotFeatureConfig,
  type SlotRecord,
} from "../kernel/slot";
import { DiagnosticCollector } from "../kernel/validate";

export interface SummitRoofSpec {
  readonly id: string;
  readonly kind: "flat_slab";
  readonly thickness: number;
  readonly projection: number;
  readonly corniceProjection: number;
  readonly corniceHeight: number;
  /** Slot settings for the slab's own fascia and for the moulding above it. */
  readonly fasciaSlots: SlotFeatureConfig;
  readonly corniceSlots: SlotFeatureConfig;
}

export interface ResolvedRoof {
  readonly record: RoofRecord;
  readonly patches: readonly Patch[];
  readonly links: readonly (readonly [string, string])[];
}

/**
 * Resolves a roof from the cell's actual crown rather than independently
 * reapplying summit ratios. The slab and optional molding are each one
 * rectangular layer; patch subdivision only names their exposed surfaces.
 */
export function resolveSummitRoof(
  structureId: string,
  spec: SummitRoofSpec,
  cell: CellRecord | null,
  diagnostics: DiagnosticCollector,
): ResolvedRoof | null {
  const id = structurePath(structureId, spec.id);

  if (!cell) {
    diagnostics.error(
      "roof.no_cell",
      id,
      "A summit roof requires a resolved summit cell to carry it.",
    );
    return null;
  }

  if (
    spec.thickness <= 0
    || spec.projection < 0
    || spec.corniceProjection < 0
    || spec.corniceHeight < 0
  ) {
    diagnostics.error(
      "roof.invalid_dimensions",
      id,
      "Roof thickness must be positive and roof projections and cornice height cannot be negative.",
    );
    return null;
  }

  const slabFootprint = insetRect(
    cell.footprint,
    uniformSetbacks(-spec.projection),
  );
  const bottomY = cell.topY;
  const slabTopY = bottomY + spec.thickness;
  const hasCornice = spec.corniceProjection > 0 && spec.corniceHeight > 0;
  const corniceOutline = hasCornice
    ? insetRect(slabFootprint, uniformSetbacks(-spec.corniceProjection))
    : slabFootprint;
  const topY = slabTopY + (hasCornice ? spec.corniceHeight : 0);

  if (!rectIsValid(slabFootprint) || !rectIsValid(corniceOutline)) {
    diagnostics.error(
      "roof.invalid_footprint",
      id,
      "The resolved roof footprint has no positive extent.",
    );
    return null;
  }

  const patches: Patch[] = [];
  const links: (readonly [string, string])[] = [];
  const ceilingPatchId = structurePath(id, "ceiling");
  const topPatchId = structurePath(id, "surface_top");
  const slabEdgePatchIds: string[] = [];
  const slabSoffitPatchIds: string[] = [];

  patches.push(horizontalPatch(
    ceilingPatchId,
    PATCH_ROLES.roofSoffit,
    cell.interior,
    bottomY,
    "down",
    ["roof", "ceiling", "interior"],
  ));

  for (const orientation of HORIZONTAL_ORIENTATIONS) {
    const edgePatchId = structurePath(
      id,
      "slab",
      `fascia_${directionSegment(orientation)}`,
    );
    slabEdgePatchIds.push(edgePatchId);
    patches.push(verticalPatch(
      edgePatchId,
      PATCH_ROLES.roofEdge,
      slabFootprint,
      orientation,
      bottomY,
      slabTopY,
      ["roof", "slab", "exterior", directionSegment(orientation)],
    ));
    links.push([ceilingPatchId, edgePatchId]);

    const soffitRect = ringSideRect(
      slabFootprint,
      cell.footprint,
      orientation,
    );
    if (rectIsValid(soffitRect)) {
      const soffitPatchId = structurePath(
        id,
        "slab",
        `soffit_${directionSegment(orientation)}`,
      );
      slabSoffitPatchIds.push(soffitPatchId);
      patches.push(horizontalPatch(
        soffitPatchId,
        PATCH_ROLES.roofSoffit,
        soffitRect,
        bottomY,
        "down",
        ["roof", "slab", "overhang", "exterior", directionSegment(orientation)],
      ));
      links.push(
        [soffitPatchId, edgePatchId],
        [soffitPatchId, ceilingPatchId],
      );
    }
  }
  linkLoop(slabEdgePatchIds, links);
  linkLoop(slabSoffitPatchIds, links);

  let cornice: RoofCorniceRecord | null = null;
  let finalEdgePatchIds = slabEdgePatchIds;
  let finalSoffitPatchIds = slabSoffitPatchIds;

  if (hasCornice) {
    const corniceEdgePatchIds: string[] = [];
    const corniceSoffitPatchIds: string[] = [];

    for (const orientation of HORIZONTAL_ORIENTATIONS) {
      const segment = directionSegment(orientation);
      const edgePatchId = structurePath(id, "cornice", `fascia_${segment}`);
      const soffitPatchId = structurePath(id, "cornice", `soffit_${segment}`);
      corniceEdgePatchIds.push(edgePatchId);
      corniceSoffitPatchIds.push(soffitPatchId);
      patches.push(
        verticalPatch(
          edgePatchId,
          PATCH_ROLES.roofCornice,
          corniceOutline,
          orientation,
          slabTopY,
          topY,
          ["roof", "cornice", "exterior", segment],
        ),
        horizontalPatch(
          soffitPatchId,
          PATCH_ROLES.roofCornice,
          ringSideRect(corniceOutline, slabFootprint, orientation),
          slabTopY,
          "down",
          ["roof", "cornice", "soffit", "exterior", segment],
        ),
      );
      const slabEdgePatchId = slabEdgePatchIds[
        HORIZONTAL_ORIENTATIONS.indexOf(orientation)
      ];
      if (slabEdgePatchId) {
        links.push([slabEdgePatchId, soffitPatchId]);
      }
      links.push([soffitPatchId, edgePatchId]);
    }
    linkLoop(corniceEdgePatchIds, links);
    linkLoop(corniceSoffitPatchIds, links);
    finalEdgePatchIds = [...slabEdgePatchIds, ...corniceEdgePatchIds];
    finalSoffitPatchIds = [...slabSoffitPatchIds, ...corniceSoffitPatchIds];
    cornice = {
      projection: spec.corniceProjection,
      height: spec.corniceHeight,
      bottomY: slabTopY,
      topY,
      outline: corniceOutline,
      edgePatchIds: corniceEdgePatchIds,
      soffitPatchIds: corniceSoffitPatchIds,
    };
  }

  patches.push(horizontalPatch(
    topPatchId,
    PATCH_ROLES.roof,
    corniceOutline,
    topY,
    "up",
    ["roof", "exterior", "traversable"],
  ));
  const topEdges = cornice?.edgePatchIds ?? slabEdgePatchIds;
  for (const edgePatchId of topEdges) {
    links.push([topPatchId, edgePatchId]);
  }

  const bearingPatchIds = [
    ...cell.walls.flatMap(
      (wall) => [wall.outerPatchId, wall.innerPatchId],
    ),
    ...cell.interiorWalls.flatMap(
      (wall) => [wall.negativePatchId, wall.positivePatchId],
    ),
  ];
  for (const bearingPatchId of bearingPatchIds) {
    links.push([bearingPatchId, ceilingPatchId]);
  }

  // `buildRoof` draws the projected ring only where the slab really oversails
  // the walls; without a projection the fascia is the bearing ring instead.
  const slabProjects = rectWidth(slabFootprint) - rectWidth(cell.footprint) > 1e-9
    || rectDepth(slabFootprint) - rectDepth(cell.footprint) > 1e-9;
  const { frames, slots } = resolveRoofSlots(
    spec,
    slabFootprint,
    bottomY,
    slabTopY,
    slabEdgePatchIds,
    cornice,
    slabProjects ? cell.footprint : cell.interior,
  );

  const record: RoofRecord = {
    id,
    kind: "roof",
    roofType: "flat_slab",
    coversCellIds: [cell.id],
    coversRoomIds: cell.rooms.map((room) => room.id),
    bearingPatchIds,
    bearingFootprint: { ...cell.footprint },
    ceilingFootprint: { ...cell.interior },
    slabFootprint,
    bottomY,
    slabTopY,
    topY,
    thickness: spec.thickness,
    projection: spec.projection,
    cornice,
    topPatchId,
    ceilingPatchId,
    edgePatchIds: finalEdgePatchIds,
    soffitPatchIds: finalSoffitPatchIds,
    patchIds: patches.map((patch) => patch.id),
    frames,
    slots,
  };

  return { record, patches: withSlotReservations(patches, slots), links };
}

/**
 * Prepares the roof's two rings of fascia.
 *
 * A fascia is already one flat quad per side — the roof is never coursed — so
 * nothing has to be gated here, and these slots are pure reservation. They are
 * ribbons rather than fields: a slab edge is a long thin run, and judging it by
 * a field's minimum height would reject every roof this project builds.
 */
function resolveRoofSlots(
  spec: SummitRoofSpec,
  slabFootprint: Rect,
  bottomY: number,
  slabTopY: number,
  slabEdgePatchIds: readonly string[],
  cornice: RoofCorniceRecord | null,
  slabInner: Rect,
): { readonly frames: FrameRecord[]; readonly slots: SlotRecord[] } {
  const frames: FrameRecord[] = [];
  const slots: SlotRecord[] = [];

  const rings = [
    {
      role: "slab",
      feature: spec.fasciaSlots,
      outline: slabFootprint,
      bottomY,
      topY: slabTopY,
      patchIds: slabEdgePatchIds,
      projection: spec.projection,
      hierarchy: 10,
      inner: slabInner,
    },
    ...(cornice
      ? [{
        role: "cornice",
        feature: spec.corniceSlots,
        outline: cornice.outline,
        bottomY: cornice.bottomY,
        topY: cornice.topY,
        patchIds: cornice.edgePatchIds,
        projection: cornice.projection,
        hierarchy: 20,
        inner: slabFootprint,
      }]
      : []),
  ];

  for (const ring of rings) {
    if (!ring.feature.enabled) {
      continue;
    }

    const rule = slotRuleOf(ring.feature);

    for (const [index, orientation] of HORIZONTAL_ORIENTATIONS.entries()) {
      // The patch ids were pushed in this same order, one per orientation.
      const patchId = ring.patchIds[index];

      if (!patchId) {
        continue;
      }

      const edge = rectEdge(ring.outline, orientation);
      const width = Math.hypot(
        edge.end.x - edge.start.x,
        edge.end.z - edge.start.z,
      );
      // A ring's front and rear pieces run the full width and own both corners,
      // so its side pieces are short by the projection at each end. The patch
      // spans the whole edge either way, so the slot says which part of it the
      // fascia is actually drawn over.
      const uRange = drawnFasciaRange(orientation, ring.outline, ring.inner);
      const resolved = resolveFaceSlot({
        id: structurePath(patchId, "slot"),
        kind: "ribbon",
        part: "roof",
        face: orientation,
        faceRole: ring.role,
        bandId: null,
        bayId: null,
        patchId,
        uEdges: arrisEdges(uRange),
        vRange: [0, 1],
        widthBottom: width,
        widthTop: width,
        faceHeight: ring.topY - ring.bottomY,
        hierarchy: ring.hierarchy,
        flow: "horizontal",
        continuity: "wrapping",
        depthBudget: slotDepthBudget(ring.projection, rule.recessDepth),
        tags: ["roof", ring.role, "exterior", directionSegment(orientation)],
        rule,
      });

      if (!resolved) {
        continue;
      }
      if (resolved.frame) {
        frames.push(resolved.frame);
      }
      slots.push(resolved.slot);
    }
  }

  return { frames, slots };
}

/**
 * The part of a fascia's own edge that `addRingBlocks` draws it over.
 *
 * Front and rear pieces span the outer rectangle and take the corners with
 * them; the side pieces are left running only the inner rectangle's depth.
 */
function drawnFasciaRange(
  orientation: HorizontalOrientation,
  outer: Rect,
  inner: Rect,
): readonly [number, number] {
  if (orientation === "front" || orientation === "rear") {
    return [0, 1];
  }

  const depth = rectDepth(outer);

  if (depth <= 1e-9) {
    return [0, 1];
  }

  // `rectEdge` runs +Z to -Z on the positive side and -Z to +Z on the negative
  // one, so the span is read in the direction that edge actually walks.
  const range = orientation === "sidePositiveU"
    ? [(outer.maxZ - inner.maxZ) / depth, (outer.maxZ - inner.minZ) / depth]
    : [(inner.minZ - outer.minZ) / depth, (inner.maxZ - outer.minZ) / depth];

  return [
    Math.max(Math.min(range[0]!, range[1]!), 0),
    Math.min(Math.max(range[0]!, range[1]!), 1),
  ];
}

function directionSegment(direction: HorizontalOrientation): string {
  switch (direction) {
    case "front":
      return "front";
    case "rear":
      return "rear";
    case "sidePositiveU":
      return "side_positive_u";
    case "sideNegativeU":
      return "side_negative_u";
  }
}

function ringSideRect(
  outer: Rect,
  inner: Rect,
  direction: HorizontalOrientation,
): Rect {
  switch (direction) {
    case "front":
      return {
        minX: outer.minX,
        maxX: outer.maxX,
        minZ: inner.maxZ,
        maxZ: outer.maxZ,
      };
    case "rear":
      return {
        minX: outer.minX,
        maxX: outer.maxX,
        minZ: outer.minZ,
        maxZ: inner.minZ,
      };
    case "sidePositiveU":
      return {
        minX: inner.maxX,
        maxX: outer.maxX,
        minZ: inner.minZ,
        maxZ: inner.maxZ,
      };
    case "sideNegativeU":
      return {
        minX: outer.minX,
        maxX: inner.minX,
        minZ: inner.minZ,
        maxZ: inner.maxZ,
      };
  }
}

function horizontalPatch(
  id: string,
  role: PatchRole,
  rect: Rect,
  y: number,
  facing: "up" | "down",
  tags: readonly string[],
): Patch {
  const frame: LocalFrame = facing === "up"
    ? createHorizontalFrame(rect, y)
    : {
      origin: { x: rect.minX, y, z: rect.minZ },
      uAxis: { x: 1, y: 0, z: 0 },
      vAxis: { x: 0, y: 0, z: 1 },
      normal: { x: 0, y: -1, z: 0 },
      uLength: rectWidth(rect),
      vLength: rectDepth(rect),
    };

  return {
    id,
    role,
    frame,
    dimensions: { u: frame.uLength, v: frame.vLength, thickness: 0 },
    evaluator: "planar",
    edges: horizontalEdges(id),
    adjacency: [],
    regions: [],
    features: [],
    anchors: [],
    tags,
  };
}

function verticalPatch(
  id: string,
  role: PatchRole,
  rect: Rect,
  orientation: HorizontalOrientation,
  bottomY: number,
  topY: number,
  tags: readonly string[],
): Patch {
  const edge = rectEdge(rect, orientation);
  const frame = createFacadeFrame(edge, bottomY, topY, edge.start);

  return {
    id,
    role,
    frame,
    dimensions: { u: frame.uLength, v: frame.vLength, thickness: 0 },
    evaluator: "planar",
    edges: verticalEdges(id, orientation),
    adjacency: [],
    regions: [],
    features: [],
    anchors: [],
    tags,
  };
}

function horizontalEdges(id: string): PatchEdges {
  return {
    uMin: patchEdge(id, "u_min", "sideNegativeU"),
    uMax: patchEdge(id, "u_max", "sidePositiveU"),
    vMin: patchEdge(id, "v_min", "rear"),
    vMax: patchEdge(id, "v_max", "front"),
  };
}

function verticalEdges(
  id: string,
  orientation: HorizontalOrientation,
): PatchEdges {
  return {
    uMin: patchEdge(id, "u_min", orientation),
    uMax: patchEdge(id, "u_max", orientation),
    vMin: patchEdge(id, "v_min", "bottom"),
    vMax: patchEdge(id, "v_max", "top"),
  };
}

function patchEdge(
  patchId: string,
  segment: string,
  orientation: PatchEdges["uMin"]["orientation"],
): PatchEdges["uMin"] {
  return {
    id: structurePath(patchId, segment),
    orientation,
    treatment: null,
  };
}

function linkLoop(
  patchIds: readonly string[],
  links: (readonly [string, string])[],
): void {
  if (patchIds.length < 2) {
    return;
  }

  for (let index = 0; index < patchIds.length; index += 1) {
    const current = patchIds[index];
    const next = patchIds[(index + 1) % patchIds.length];

    if (current && next) {
      links.push([current, next]);
    }
  }
}
