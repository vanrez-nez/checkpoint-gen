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
 * Resolves the first cell assembly: one centred room with one axial front
 * portal. All dimensions are fixed here so patch emission and tessellation read
 * the same rectangles rather than independently reapplying ratios.
 */
export function resolveSummitCell(
  structureId: string,
  spec: SummitCellSpec,
  placement: SummitPlacementRecord | null,
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
  const centerX = (footprint.minX + footprint.maxX) * 0.5;

  if (!rectIsValid(footprint) || !rectIsValid(interior)) {
    diagnostics.error(
      "cell.walls_do_not_fit",
      id,
      `Wall thickness ${spec.wallThickness} leaves no usable chamber interior.`,
    );
    return null;
  }

  if (spec.portalWidth >= rectWidth(interior)) {
    diagnostics.error(
      "cell.portal_too_wide",
      id,
      `Portal width ${spec.portalWidth} must be smaller than the ${rectWidth(interior)} chamber interior.`,
    );
    return null;
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
  const portalMinX = centerX - spec.portalWidth * 0.5;
  const portalMaxX = centerX + spec.portalWidth * 0.5;
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
    const hasPortal = orientation === "front";
    const outerPortal = hasPortal
      ? portalRegion(outerPatchId, footprint, spec.portalWidth, spec.portalHeight, spec.height)
      : null;
    const innerPortal = hasPortal
      ? portalRegion(innerPatchId, interior, spec.portalWidth, spec.portalHeight, spec.height)
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

  const frontWall = wallRecords.find((wall) => wall.orientation === "front")!;
  const revealIds = {
    left: structurePath(id, "portal", "jamb_left"),
    right: structurePath(id, "portal", "jamb_right"),
    head: structurePath(id, "portal", "soffit"),
  };
  patches.push(
    portalJambPatch(
      revealIds.left,
      portalMinX,
      interior.maxZ,
      footprint.maxZ,
      bottomY,
      spec.portalHeight,
      1,
    ),
    portalJambPatch(
      revealIds.right,
      portalMaxX,
      interior.maxZ,
      footprint.maxZ,
      bottomY,
      spec.portalHeight,
      -1,
    ),
    portalSoffitPatch(
      revealIds.head,
      portalMinX,
      portalMaxX,
      interior.maxZ,
      footprint.maxZ,
      bottomY + spec.portalHeight,
    ),
  );
  for (const revealId of Object.values(revealIds)) {
    links.push(
      [frontWall.outerPatchId, revealId],
      [frontWall.innerPatchId, revealId],
    );
  }
  links.push(
    [revealIds.left, revealIds.head],
    [revealIds.right, revealIds.head],
  );

  const opening: CellOpeningRecord = {
    id: structurePath(id, "portal"),
    kind: "portal",
    direction: "front",
    width: spec.portalWidth,
    height: spec.portalHeight,
    bottomY,
    topY: bottomY + spec.portalHeight,
    minX: portalMinX,
    maxX: portalMaxX,
    exteriorPatchId: placement.patchId,
    interiorPatchId: floorPatchId,
    revealPatchIds: Object.values(revealIds),
  };
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
    openings: [opening],
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
  portalWidth: number,
  portalHeight: number,
  wallHeight: number,
): PatchRegion {
  const centerU = 0.5;
  const halfU = portalWidth / rectWidth(rect) * 0.5;

  return {
    id: structurePath(patchId, "portal"),
    uRange: [centerU - halfU, centerU + halfU],
    vRange: [0, portalHeight / wallHeight],
    priority: 100,
    tags: ["opening", "portal", "circulation"],
  };
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
  x: number,
  innerZ: number,
  outerZ: number,
  bottomY: number,
  height: number,
  normalX: 1 | -1,
): Patch {
  const frame: LocalFrame = {
    origin: { x, y: bottomY, z: innerZ },
    uAxis: { x: 0, y: 0, z: 1 },
    vAxis: { x: 0, y: 1, z: 0 },
    normal: { x: normalX, y: 0, z: 0 },
    uLength: outerZ - innerZ,
    vLength: height,
  };

  return revealPatch(id, frame, "jamb");
}

function portalSoffitPatch(
  id: string,
  minX: number,
  maxX: number,
  innerZ: number,
  outerZ: number,
  y: number,
): Patch {
  const frame: LocalFrame = {
    origin: { x: minX, y, z: innerZ },
    uAxis: { x: 1, y: 0, z: 0 },
    vAxis: { x: 0, y: 0, z: 1 },
    normal: { x: 0, y: -1, z: 0 },
    uLength: maxX - minX,
    vLength: outerZ - innerZ,
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
