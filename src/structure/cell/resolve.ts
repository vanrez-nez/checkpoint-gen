import {
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
import {
  type CellOpeningRecord,
  type CellRecord,
  type CellWallRecord,
  type SummitPlacementRecord,
} from "../kernel/graph";
import { structurePath } from "../kernel/ids";
import {
  PATCH_ROLES,
  type Patch,
  type PatchEdges,
  type PatchFeature,
  type PatchRegion,
} from "../kernel/patch";
import { DiagnosticCollector } from "../kernel/validate";

export interface SummitCellSpec {
  readonly id: string;
  readonly kind: "single_chamber";
  readonly height: number;
  readonly wallThickness: number;
  readonly portalWidth: number;
  readonly portalHeight: number;
}

export interface ResolvedCell {
  readonly record: CellRecord;
  readonly patches: readonly Patch[];
  readonly links: readonly (readonly [string, string])[];
}

/**
 * Resolves the first cell assembly: one centred room whose portals follow the
 * configured stair facades. All dimensions are fixed here so patch emission
 * and tessellation read the same rectangles rather than independently
 * reapplying ratios or inventing openings.
 */
export function resolveSummitCell(
  structureId: string,
  spec: SummitCellSpec,
  placement: SummitPlacementRecord | null,
  portalDirections: readonly HorizontalOrientation[],
  diagnostics: DiagnosticCollector,
): ResolvedCell | null {
  const id = structurePath(structureId, spec.id);

  if (!placement) {
    diagnostics.error(
      "cell.no_summit_placement",
      id,
      "The summit has no resolved placement footprint for the chamber.",
    );
    return null;
  }

  if (
    spec.height <= 0
    || spec.wallThickness <= 0
    || spec.portalWidth <= 0
    || spec.portalHeight <= 0
  ) {
    diagnostics.error(
      "cell.invalid_dimensions",
      id,
      "The chamber wall dimensions and portal dimensions must be positive.",
    );
    return null;
  }

  // The mass generator has already resolved the one authoritative summit
  // footprint. The cell consumes it exactly instead of applying a second pair
  // of ratios and silently shrinking the building again.
  const footprint: Rect = { ...placement.rect };
  const interior = insetRect(footprint, uniformSetbacks(spec.wallThickness));
  const portalFacades = new Set(portalDirections);

  if (!rectIsValid(footprint) || !rectIsValid(interior)) {
    diagnostics.error(
      "cell.walls_do_not_fit",
      id,
      `Wall thickness ${spec.wallThickness} leaves no usable chamber interior.`,
    );
    return null;
  }

  for (const direction of portalFacades) {
    const span = wallSpan(interior, direction);

    if (spec.portalWidth >= span) {
      diagnostics.error(
        "cell.portal_too_wide",
        id,
        `Portal width ${spec.portalWidth} must be smaller than the ${span} ${wallSegment(direction)} wall interior.`,
      );
      return null;
    }
  }

  if (spec.portalHeight >= spec.height) {
    diagnostics.error(
      "cell.portal_too_tall",
      id,
      `Portal height ${spec.portalHeight} must be lower than wall height ${spec.height}.`,
    );
    return null;
  }

  const bottomY = placement.y;
  const topY = bottomY + spec.height;
  const floorPatchId = structurePath(id, "floor");
  const wallRecords: CellWallRecord[] = [];
  const patches: Patch[] = [];
  const links: (readonly [string, string])[] = [];

  patches.push(floorPatch(floorPatchId, interior, bottomY));

  for (const orientation of [
    "front",
    "rear",
    "sidePositiveU",
    "sideNegativeU",
  ] as const) {
    const outerPatchId = structurePath(id, `wall_${wallSegment(orientation)}_exterior`);
    const innerPatchId = structurePath(id, `wall_${wallSegment(orientation)}_interior`);
    const hasPortal = portalFacades.has(orientation);
    const outerPortal = hasPortal
      ? portalRegion(
        outerPatchId,
        footprint,
        orientation,
        spec.portalWidth,
        spec.portalHeight,
        spec.height,
      )
      : null;
    const innerPortal = hasPortal
      ? portalRegion(
        innerPatchId,
        interior,
        orientation,
        spec.portalWidth,
        spec.portalHeight,
        spec.height,
      )
      : null;

    patches.push(
      wallPatch({
        id: outerPatchId,
        rect: footprint,
        orientation,
        bottomY,
        topY,
        interior: false,
        portal: outerPortal,
      }),
      wallPatch({
        id: innerPatchId,
        rect: interior,
        orientation,
        bottomY,
        topY,
        interior: true,
        portal: innerPortal,
      }),
    );
    wallRecords.push({ orientation, outerPatchId, innerPatchId });
    links.push(
      [placement.patchId, outerPatchId],
      [floorPatchId, innerPatchId],
    );
  }

  linkWallLoop(wallRecords, "outerPatchId", links);
  linkWallLoop(wallRecords, "innerPatchId", links);

  const openings: CellOpeningRecord[] = [];

  for (const direction of portalFacades) {
    const wall = wallRecords.find((candidate) => candidate.orientation === direction)!;
    const portalId = structurePath(id, "portal", wallSegment(direction));
    const threshold = portalThreshold(
      footprint,
      interior,
      direction,
      spec.portalWidth,
    );
    const revealIds = {
      start: structurePath(portalId, "jamb_start"),
      end: structurePath(portalId, "jamb_end"),
      head: structurePath(portalId, "soffit"),
    };

    patches.push(
      portalJambPatch(
        revealIds.start,
        threshold,
        direction,
        "start",
        bottomY,
        spec.portalHeight,
      ),
      portalJambPatch(
        revealIds.end,
        threshold,
        direction,
        "end",
        bottomY,
        spec.portalHeight,
      ),
      portalSoffitPatch(
        revealIds.head,
        threshold,
        bottomY + spec.portalHeight,
      ),
    );
    for (const revealId of Object.values(revealIds)) {
      links.push(
        [wall.outerPatchId, revealId],
        [wall.innerPatchId, revealId],
      );
    }
    links.push(
      [revealIds.start, revealIds.head],
      [revealIds.end, revealIds.head],
    );

    openings.push({
      id: portalId,
      kind: "portal",
      direction,
      width: spec.portalWidth,
      height: spec.portalHeight,
      bottomY,
      topY: bottomY + spec.portalHeight,
      threshold,
      exteriorPatchId: placement.patchId,
      interiorPatchId: floorPatchId,
      revealPatchIds: Object.values(revealIds),
    });
  }

  const record: CellRecord = {
    id,
    kind: "cell",
    layout: spec.kind,
    occupancy: "room",
    footprint,
    interior,
    bottomY,
    topY,
    height: spec.height,
    wallThickness: spec.wallThickness,
    supportPatchId: placement.patchId,
    placementAnchorId: placement.anchorId,
    floorPatchId,
    walls: wallRecords,
    openings,
    patchIds: patches.map((patch) => patch.id),
  };

  return { record, patches, links };
}

function wallSegment(orientation: HorizontalOrientation): string {
  switch (orientation) {
    case "front":
      return "front";
    case "rear":
      return "rear";
    case "sidePositiveU":
      return "right";
    case "sideNegativeU":
      return "left";
  }
}

function portalRegion(
  patchId: string,
  rect: Rect,
  orientation: HorizontalOrientation,
  portalWidth: number,
  portalHeight: number,
  wallHeight: number,
): PatchRegion {
  const centerU = 0.5;
  const halfU = portalWidth / wallSpan(rect, orientation) * 0.5;

  return {
    id: structurePath(patchId, "portal"),
    uRange: [centerU - halfU, centerU + halfU],
    vRange: [0, portalHeight / wallHeight],
    priority: 100,
    tags: ["opening", "portal", "circulation"],
  };
}

function wallSpan(rect: Rect, orientation: HorizontalOrientation): number {
  return orientation === "front" || orientation === "rear"
    ? rectWidth(rect)
    : rectDepth(rect);
}

function portalThreshold(
  footprint: Rect,
  interior: Rect,
  direction: HorizontalOrientation,
  width: number,
): Rect {
  const centerX = (footprint.minX + footprint.maxX) * 0.5;
  const centerZ = (footprint.minZ + footprint.maxZ) * 0.5;

  switch (direction) {
    case "front":
      return {
        minX: centerX - width * 0.5,
        maxX: centerX + width * 0.5,
        minZ: interior.maxZ,
        maxZ: footprint.maxZ,
      };
    case "rear":
      return {
        minX: centerX - width * 0.5,
        maxX: centerX + width * 0.5,
        minZ: footprint.minZ,
        maxZ: interior.minZ,
      };
    case "sidePositiveU":
      return {
        minX: interior.maxX,
        maxX: footprint.maxX,
        minZ: centerZ - width * 0.5,
        maxZ: centerZ + width * 0.5,
      };
    case "sideNegativeU":
      return {
        minX: footprint.minX,
        maxX: interior.minX,
        minZ: centerZ - width * 0.5,
        maxZ: centerZ + width * 0.5,
      };
  }
}

function wallPatch(input: {
  readonly id: string;
  readonly rect: Rect;
  readonly orientation: HorizontalOrientation;
  readonly bottomY: number;
  readonly topY: number;
  readonly interior: boolean;
  readonly portal: PatchRegion | null;
}): Patch {
  const edge = rectEdge(input.rect, input.orientation);
  const frame = createFacadeFrame(
    input.interior
      ? {
        ...edge,
        normal: {
          x: -edge.normal.x,
          y: -edge.normal.y,
          z: -edge.normal.z,
        },
      }
      : edge,
    input.bottomY,
    input.topY,
    edge.start,
  );
  const regions = input.portal ? [input.portal] : [];
  const features: PatchFeature[] = input.portal
    ? [{
      id: structurePath(input.id, "cut_portal"),
      operation: "cut",
      regionId: input.portal.id,
      order: 0,
    }]
    : [];

  return {
    id: input.id,
    role: input.interior
      ? PATCH_ROLES.cellWallInterior
      : PATCH_ROLES.cellWallExterior,
    frame,
    dimensions: {
      u: frame.uLength,
      v: frame.vLength,
      thickness: 0,
    },
    evaluator: "planar",
    edges: wallEdges(input.id, input.orientation),
    adjacency: [],
    regions,
    features,
    anchors: [],
    tags: [
      input.interior ? "interior" : "exterior",
      "cell_wall",
      input.orientation,
      "roof_bearing",
    ],
  };
}

function floorPatch(id: string, rect: Rect, y: number): Patch {
  const frame = createHorizontalFrame(rect, y);

  return {
    id,
    role: PATCH_ROLES.cellFloor,
    frame,
    dimensions: {
      u: rectWidth(rect),
      v: rectDepth(rect),
      thickness: 0,
    },
    evaluator: "planar",
    edges: horizontalEdges(id),
    adjacency: [],
    regions: [],
    features: [],
    anchors: [],
    tags: ["traversable", "interior", "cell_floor"],
  };
}

function portalJambPatch(
  id: string,
  threshold: Rect,
  direction: HorizontalOrientation,
  end: "start" | "end",
  bottomY: number,
  height: number,
): Patch {
  const alongX = direction === "front" || direction === "rear";
  const atStart = end === "start";
  const frame: LocalFrame = alongX
    ? {
      origin: {
        x: atStart ? threshold.minX : threshold.maxX,
        y: bottomY,
        z: threshold.minZ,
      },
      uAxis: { x: 0, y: 0, z: 1 },
      vAxis: { x: 0, y: 1, z: 0 },
      normal: { x: atStart ? 1 : -1, y: 0, z: 0 },
      uLength: rectDepth(threshold),
      vLength: height,
    }
    : {
      origin: {
        x: threshold.minX,
        y: bottomY,
        z: atStart ? threshold.minZ : threshold.maxZ,
      },
      uAxis: { x: 1, y: 0, z: 0 },
      vAxis: { x: 0, y: 1, z: 0 },
      normal: { x: 0, y: 0, z: atStart ? 1 : -1 },
      uLength: rectWidth(threshold),
      vLength: height,
    };

  return revealPatch(id, frame, "jamb");
}

function portalSoffitPatch(
  id: string,
  threshold: Rect,
  y: number,
): Patch {
  const frame: LocalFrame = {
    origin: { x: threshold.minX, y, z: threshold.minZ },
    uAxis: { x: 1, y: 0, z: 0 },
    vAxis: { x: 0, y: 0, z: 1 },
    normal: { x: 0, y: -1, z: 0 },
    uLength: rectWidth(threshold),
    vLength: rectDepth(threshold),
  };

  return revealPatch(id, frame, "soffit");
}

function revealPatch(id: string, frame: LocalFrame, member: string): Patch {
  return {
    id,
    role: PATCH_ROLES.cellOpeningReveal,
    frame,
    dimensions: {
      u: frame.uLength,
      v: frame.vLength,
      thickness: 0,
    },
    evaluator: "planar",
    edges: revealEdges(id),
    adjacency: [],
    regions: [],
    features: [],
    anchors: [],
    tags: ["opening", "portal", "reveal", member],
  };
}

function linkWallLoop(
  walls: readonly CellWallRecord[],
  key: "outerPatchId" | "innerPatchId",
  links: (readonly [string, string])[],
): void {
  const ring: readonly HorizontalOrientation[] = [
    "front",
    "sidePositiveU",
    "rear",
    "sideNegativeU",
  ];

  for (let index = 0; index < ring.length; index += 1) {
    const current = walls.find((wall) => wall.orientation === ring[index]);
    const next = walls.find((wall) => wall.orientation === ring[(index + 1) % ring.length]);

    if (current && next) {
      links.push([current[key], next[key]]);
    }
  }
}

function wallEdges(id: string, orientation: HorizontalOrientation): PatchEdges {
  return {
    uMin: patchEdge(id, "u_min", orientation),
    uMax: patchEdge(id, "u_max", orientation),
    vMin: patchEdge(id, "v_min", "bottom"),
    vMax: patchEdge(id, "v_max", "top", "roof_bearing"),
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

function revealEdges(id: string): PatchEdges {
  return {
    uMin: patchEdge(id, "u_min", "sideNegativeU"),
    uMax: patchEdge(id, "u_max", "sidePositiveU"),
    vMin: patchEdge(id, "v_min", "bottom"),
    vMax: patchEdge(id, "v_max", "top"),
  };
}

function patchEdge(
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
