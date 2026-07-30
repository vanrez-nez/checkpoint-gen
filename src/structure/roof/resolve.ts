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
import { DiagnosticCollector } from "../kernel/validate";

export interface SummitRoofSpec {
  readonly id: string;
  readonly kind: "flat_slab";
  readonly thickness: number;
  readonly projection: number;
  readonly corniceProjection: number;
  readonly corniceHeight: number;
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

  const bearingPatchIds = cell.walls.flatMap(
    (wall) => [wall.outerPatchId, wall.innerPatchId],
  );
  for (const bearingPatchId of bearingPatchIds) {
    links.push([bearingPatchId, ceilingPatchId]);
  }

  const record: RoofRecord = {
    id,
    kind: "roof",
    roofType: "flat_slab",
    coversCellIds: [cell.id],
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
  };

  return { record, patches, links };
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
