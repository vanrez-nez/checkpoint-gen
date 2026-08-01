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
  FrameRoofRecord,
  StairConnectorRecord,
  SummitPlacementRecord,
} from "../kernel/graph";
import { structurePath } from "../kernel/ids";
import {
  PATCH_ROLES,
  type Patch,
  type PatchEdges,
  type PatchRole,
} from "../kernel/patch";
import { DiagnosticCollector } from "../kernel/validate";
import type {
  FrameBayRecord,
  FrameMemberRecord,
  FrameRecord,
  FrameRowRecord,
  FrameSpec,
  FrameSupportRecord,
  FrameSupportSectionKind,
} from "./types";

const MAX_BAY_SPAN = 3.2;
const ENTRANCE_CLEARANCE = 0.3;
const SUPPORT_HEIGHT_RATIOS: readonly number[] = [0.12, 0.1, 0.58, 0.12, 0.08];
const SUPPORT_WIDTH_MULTIPLIERS: readonly number[] = [1.5, 1.25, 1, 1.3, 1.5];
const SUPPORT_SECTION_KINDS: readonly FrameSupportSectionKind[] = [
  "plinth",
  "base",
  "shaft",
  "capital",
  "bearing",
];

export interface ResolvedFrame {
  readonly record: FrameRecord;
  readonly patches: readonly Patch[];
  readonly links: readonly (readonly [string, string])[];
  readonly roof: {
    readonly record: FrameRoofRecord;
    readonly patches: readonly Patch[];
    readonly links: readonly (readonly [string, string])[];
  } | null;
}

/**
 * Divides one row into real bay widths. The centre bay is widened to preserve
 * an approach when requested; every other bay shares the remaining run.
 */
export function resolveFrameBayWidths(
  run: number,
  bayCount: number,
  entranceWidth = 0,
  maxBaySpan = MAX_BAY_SPAN,
): number[] | null {
  if (run <= 0 || bayCount < 1 || !Number.isInteger(bayCount)) {
    return null;
  }

  if (entranceWidth <= 0) {
    const width = run / bayCount;
    return width <= maxBaySpan ? Array.from({ length: bayCount }, () => width) : null;
  }

  if (bayCount % 2 === 0 || entranceWidth >= run) {
    return null;
  }
  if (bayCount === 1) {
    return run >= entranceWidth && run <= maxBaySpan ? [run] : null;
  }

  const sideWidth = (run - entranceWidth) / (bayCount - 1);
  if (sideWidth <= 0 || sideWidth > maxBaySpan || entranceWidth > maxBaySpan) {
    return null;
  }

  return Array.from(
    { length: bayCount },
    (_, index) => index === Math.floor(bayCount / 2) ? entranceWidth : sideWidth,
  );
}

/** Footprint a Cell may occupy once a Frame claims its support/circulation zone. */
export function frameCellPlacement(
  placement: SummitPlacementRecord,
  spec: FrameSpec,
): SummitPlacementRecord | null {
  const inset = spec.shaftWidth * SUPPORT_WIDTH_MULTIPLIERS[0] * 0.5
    + spec.cellClearance;
  const rect = spec.layout === "single_row_portico"
    ? insetRect(placement.rect, {
      front: inset,
      rear: 0,
      sidePositiveU: 0,
      sideNegativeU: 0,
    })
    : insetRect(placement.rect, uniformSetbacks(inset));

  return rectIsValid(rect) ? { ...placement, rect } : null;
}

export function resolveFrame(
  structureId: string,
  spec: FrameSpec,
  placement: SummitPlacementRecord,
  cell: CellRecord | null,
  stairs: readonly StairConnectorRecord[],
  diagnostics: DiagnosticCollector,
): ResolvedFrame | null {
  const id = structurePath(structureId, spec.id);
  const baseWidth = spec.shaftWidth * SUPPORT_WIDTH_MULTIPLIERS[0];
  const overheadHeight = spec.lintelHeight
    + spec.architraveHeight
    + spec.friezeHeight
    + spec.corniceHeight;
  const topY = cell?.topY ?? placement.y + spec.height;
  const supportBottomY = placement.y + spec.stylobateHeight;
  const supportTopY = topY - overheadHeight;

  if (
    spec.frontBayCount < 1
    || spec.frontBayCount % 2 === 0
    || spec.sideBayCount < 1
    || spec.sideBayCount % 2 === 0
  ) {
    diagnostics.error(
      "frame.bay_count_invalid",
      id,
      "Frame rows require a positive odd bay count so the entrance remains centred.",
    );
    return null;
  }

  if (
    spec.shaftWidth <= 0
    || spec.cellClearance < 0
    || spec.stylobateHeight < 0
    || spec.stylobateProjection < 0
    || spec.lintelHeight <= 0
    || spec.architraveHeight <= 0
    || spec.friezeHeight <= 0
    || spec.corniceHeight <= 0
    || supportTopY <= supportBottomY
  ) {
    diagnostics.error(
      "frame.invalid_profile",
      id,
      "Frame support, stylobate and entablature dimensions must leave a positive support profile.",
    );
    return null;
  }

  const supportRect = insetRect(placement.rect, uniformSetbacks(baseWidth * 0.5));
  if (!rectIsValid(supportRect)) {
    diagnostics.error(
      "frame.supports_do_not_fit",
      id,
      "The Frame placement is too small for the configured square support profile.",
    );
    return null;
  }

  const rowOrientations: readonly HorizontalOrientation[] =
    spec.layout === "single_row_portico"
      ? ["front"]
      : HORIZONTAL_ORIENTATIONS;
  const supports = new Map<string, FrameSupportRecord>();
  const bays: FrameBayRecord[] = [];
  const members: FrameMemberRecord[] = [];
  const rows: FrameRowRecord[] = [];
  const patches: Patch[] = [];
  const links: (readonly [string, string])[] = [];

  for (const orientation of rowOrientations) {
    const rowId = structurePath(id, `row_${directionSegment(orientation)}`);
    const edge = rectEdge(supportRect, orientation);
    const run = Math.hypot(edge.end.x - edge.start.x, edge.end.z - edge.start.z);
    const bayCount = orientation === "front" || orientation === "rear"
      ? spec.frontBayCount
      : spec.sideBayCount;
    const stair = stairs.find((candidate) => candidate.direction === orientation);
    const entranceWidth = stair ? stairAssemblyWidth(stair) + ENTRANCE_CLEARANCE : 0;
    const widths = resolveFrameBayWidths(run, bayCount, entranceWidth);

    if (!widths) {
      diagnostics.error(
        entranceWidth > 0 ? "frame.entrance_bay_does_not_fit" : "frame.bay_span_invalid",
        rowId,
        entranceWidth > 0
          ? `The ${directionSegment(orientation)} row cannot preserve a ${entranceWidth.toFixed(2)}m stair entrance within ${bayCount} bays.`
          : `The ${directionSegment(orientation)} row cannot resolve ${bayCount} bays at or below ${MAX_BAY_SPAN}m.`,
      );
      return null;
    }

    const rowSupportIds: string[] = [];
    const rowBayIds: string[] = [];
    let cursor = 0;
    for (let index = 0; index <= widths.length; index += 1) {
      const t = run <= 0 ? 0 : cursor / run;
      const x = edge.start.x + (edge.end.x - edge.start.x) * t;
      const z = edge.start.z + (edge.end.z - edge.start.z) * t;
      const key = coordinateKey(x, z);
      let support = supports.get(key);

      if (!support) {
        support = createSupport(
          structurePath(id, `support_${supports.size}`),
          x,
          z,
          spec.shaftWidth,
          supportBottomY,
          supportTopY,
        );
        supports.set(key, support);
        patches.push(...supportPatches(support));
      }
      rowSupportIds.push(support.id);
      cursor += widths[index] ?? 0;
    }

    const entranceIndex = stair ? Math.floor(widths.length / 2) : -1;
    const lintelIds: string[] = [];
    for (let index = 0; index < widths.length; index += 1) {
      const start = requireSupport(supportById(supports, rowSupportIds[index]));
      const end = requireSupport(supportById(supports, rowSupportIds[index + 1]));
      const bayId = structurePath(rowId, `bay_${index}`);
      const bay: FrameBayRecord = {
        id: bayId,
        index,
        rowId,
        startSupportId: start.id,
        endSupportId: end.id,
        width: widths[index] ?? 0,
        entrance: index === entranceIndex,
      };
      bays.push(bay);
      rowBayIds.push(bay.id);

      const member = createMember(
        structurePath(bayId, "lintel"),
        "lintel",
        spanRect(start, end, spec.shaftWidth * 1.5),
        supportTopY,
        supportTopY + spec.lintelHeight,
        "beam",
      );
      members.push(member);
      lintelIds.push(member.id);
      patches.push(...memberPatches(member, orientation));
    }

    const stylobates = createStylobateMembers(
      rowId,
      orientation,
      rowSupportIds.map((supportId) => requireSupport(supportById(supports, supportId))),
      entranceIndex,
      baseWidth + spec.stylobateProjection * 2,
      placement.y,
      supportBottomY,
      spec.layout === "perimeter_colonnade"
        && orientation !== "front"
        && orientation !== "rear",
    );
    members.push(...stylobates);
    for (const member of stylobates) {
      patches.push(...memberPatches(member, orientation));
    }

    const rowRect = rowMemberRect(
      supportRect,
      orientation,
      spec.shaftWidth * 1.5,
      spec.layout === "perimeter_colonnade",
    );
    const entablature: FrameMemberRecord[] = [];
    let bandBottomY = supportTopY + spec.lintelHeight;
    for (const band of [
      ["architrave", spec.architraveHeight, "architrave"],
      ["frieze", spec.friezeHeight, "frieze"],
      ["cornice", spec.corniceHeight, "cornice"],
    ] as const) {
      const member = createMember(
        structurePath(rowId, band[0]),
        band[0],
        band[0] === "cornice"
          ? expandAcrossRow(rowRect, orientation, spec.shaftWidth * 0.2)
          : rowRect,
        bandBottomY,
        bandBottomY + band[1],
        band[2],
      );
      bandBottomY = member.topY;
      entablature.push(member);
      members.push(member);
      patches.push(...memberPatches(member, orientation));
    }

    rows.push({
      id: rowId,
      orientation,
      supportIds: rowSupportIds,
      bayIds: rowBayIds,
      entranceBayId: entranceIndex >= 0 ? rowBayIds[entranceIndex] ?? null : null,
      stylobateIds: stylobates.map((member) => member.id),
      lintelIds,
      entablatureIds: entablature.map((member) => member.id),
    });
  }

  const supportRecords = [...supports.values()];
  const patchIds = patches.map((patch) => patch.id);
  const roofId = spec.roof.enabled ? structurePath(id, "roof") : null;
  const record: FrameRecord = {
    id,
    kind: "frame",
    layout: spec.layout,
    attachedCellIds: cell ? [cell.id] : [],
    footprint: placement.rect,
    bottomY: placement.y,
    topY,
    shaftWidth: spec.shaftWidth,
    rows,
    supports: supportRecords,
    bays,
    members,
    roofId,
    patchIds,
  };
  const roof = spec.roof.enabled
    ? resolveFrameRoof(record, spec, cell, diagnostics)
    : null;

  if (spec.roof.enabled && !roof) {
    return null;
  }

  return { record, patches, links, roof };
}

function createSupport(
  id: string,
  x: number,
  z: number,
  shaftWidth: number,
  bottomY: number,
  topY: number,
): FrameSupportRecord {
  const height = topY - bottomY;
  let y = bottomY;
  const sections = SUPPORT_SECTION_KINDS.map((kind, index) => {
    const sectionHeight = height * (SUPPORT_HEIGHT_RATIOS[index] ?? 0);
    const width = shaftWidth * (SUPPORT_WIDTH_MULTIPLIERS[index] ?? 1);
    const section = {
      kind,
      footprint: centeredRect(x, z, width, width),
      bottomY: y,
      topY: y + sectionHeight,
      materialRole: "pillar" as const,
    };
    y += sectionHeight;
    return section;
  });
  const patchIds = HORIZONTAL_ORIENTATIONS.map((orientation) =>
    structurePath(id, `face_${directionSegment(orientation)}`));
  const bearingPatchId = structurePath(id, "bearing");
  return {
    id,
    x,
    z,
    footprint: sections[0]?.footprint ?? centeredRect(x, z, shaftWidth, shaftWidth),
    sections,
    patchIds: [...patchIds, bearingPatchId],
    bearingPatchId,
  };
}

function supportPatches(support: FrameSupportRecord): Patch[] {
  const shaft = support.sections[2] ?? support.sections[0];
  const bearing = support.sections[support.sections.length - 1];
  if (!shaft || !bearing) {
    return [];
  }
  const patches = HORIZONTAL_ORIENTATIONS.map((orientation, index) =>
    verticalPatch(
      support.patchIds[index] ?? structurePath(support.id, `face_${index}`),
      PATCH_ROLES.frameSupport,
      shaft.footprint,
      orientation,
      shaft.bottomY,
      shaft.topY,
      ["frame", "support", "exterior", directionSegment(orientation)],
    ));
  patches.push(horizontalPatch(
    support.bearingPatchId,
    PATCH_ROLES.frameSupport,
    bearing.footprint,
    bearing.topY,
    "up",
    ["frame", "support", "bearing"],
    [{
      id: structurePath(support.bearingPatchId, "centre"),
      kind: "frame_bearing",
      u: 0.5,
      v: 0.5,
      d: 0,
    }],
  ));
  return patches;
}

function createMember(
  id: string,
  kind: FrameMemberRecord["kind"],
  rect: Rect,
  bottomY: number,
  topY: number,
  materialRole: FrameMemberRecord["materialRole"],
): FrameMemberRecord {
  return {
    id,
    kind,
    rect,
    bottomY,
    topY,
    materialRole,
    patchIds: [structurePath(id, "outer"), structurePath(id, "top")],
  };
}

function memberPatches(
  member: FrameMemberRecord,
  orientation: HorizontalOrientation,
): Patch[] {
  return [
    verticalPatch(
      member.patchIds[0] ?? structurePath(member.id, "outer"),
      member.kind === "stylobate"
        ? PATCH_ROLES.frameStylobate
        : member.kind === "lintel"
          ? PATCH_ROLES.frameLintel
          : PATCH_ROLES.frameEntablature,
      member.rect,
      orientation,
      member.bottomY,
      member.topY,
      ["frame", member.kind, "exterior", directionSegment(orientation)],
    ),
    horizontalPatch(
      member.patchIds[1] ?? structurePath(member.id, "top"),
      member.kind === "stylobate"
        ? PATCH_ROLES.frameStylobate
        : member.kind === "lintel"
          ? PATCH_ROLES.frameLintel
          : PATCH_ROLES.frameEntablature,
      member.rect,
      member.topY,
      "up",
      ["frame", member.kind, member.kind === "cornice" ? "bearing" : "exterior"],
    ),
  ];
}

function createStylobateMembers(
  rowId: string,
  orientation: HorizontalOrientation,
  supports: readonly FrameSupportRecord[],
  entranceIndex: number,
  depth: number,
  bottomY: number,
  topY: number,
  trimEnds: boolean,
): FrameMemberRecord[] {
  const first = supports[0];
  const last = supports[supports.length - 1];
  if (!first || !last) {
    return [];
  }

  const horizontal = orientation === "front" || orientation === "rear";
  const start = horizontal ? Math.min(first.x, last.x) : Math.min(first.z, last.z);
  const end = horizontal ? Math.max(first.x, last.x) : Math.max(first.z, last.z);
  const centre = horizontal ? first.z : first.x;
  const outerStart = start + (trimEnds ? depth * 0.5 : -depth * 0.5);
  const outerEnd = end - (trimEnds ? depth * 0.5 : -depth * 0.5);
  const ranges: readonly (readonly [number, number])[] = entranceIndex < 0
    ? [[outerStart, outerEnd]]
    : (() => {
      const left = supports[entranceIndex];
      const right = supports[entranceIndex + 1];
      if (!left || !right) {
        return [];
      }
      const a = horizontal ? Math.min(left.x, right.x) : Math.min(left.z, right.z);
      const b = horizontal ? Math.max(left.x, right.x) : Math.max(left.z, right.z);
      return [
        [outerStart, a + depth * 0.5],
        [b - depth * 0.5, outerEnd],
      ];
    })();

  return ranges
    .filter(([min, max]) => max > min)
    .map(([min, max], index) => createMember(
      structurePath(rowId, `stylobate_${index}`),
      "stylobate",
      horizontal
        ? { minX: min, maxX: max, minZ: centre - depth * 0.5, maxZ: centre + depth * 0.5 }
        : { minX: centre - depth * 0.5, maxX: centre + depth * 0.5, minZ: min, maxZ: max },
      bottomY,
      topY,
      "stylobate",
    ));
}

function resolveFrameRoof(
  frame: FrameRecord,
  spec: FrameSpec,
  cell: CellRecord | null,
  diagnostics: DiagnosticCollector,
): ResolvedFrame["roof"] {
  const id = frame.roofId ?? structurePath(frame.id, "roof");
  if (!cell && frame.layout === "single_row_portico") {
    diagnostics.error(
      "frame.roof_missing_rear_bearing",
      id,
      "A standalone single-row portico has no rear bearing for a roof range.",
    );
    return null;
  }
  if (
    !cell
    && (rectWidth(frame.footprint) > 8 || rectDepth(frame.footprint) > 8)
  ) {
    diagnostics.error(
      "frame.roof_range_unsupported",
      id,
      "A standalone perimeter Frame roof cannot span more than 8m in either direction.",
    );
    return null;
  }
  if (spec.roof.thickness <= 0 || spec.roof.projection < 0) {
    diagnostics.error(
      "frame.roof_invalid_dimensions",
      id,
      "Frame roof thickness must be positive and projection cannot be negative.",
    );
    return null;
  }

  const slabFootprint = insetRect(frame.footprint, uniformSetbacks(-spec.roof.projection));
  const bottomY = frame.topY;
  const topY = bottomY + spec.roof.thickness;
  const ceilingPatchId = structurePath(id, "soffit");
  const topPatchId = structurePath(id, "surface_top");
  const edgePatchIds = HORIZONTAL_ORIENTATIONS.map((orientation) =>
    structurePath(id, `edge_${directionSegment(orientation)}`));
  const patches: Patch[] = [
    horizontalPatch(
      ceilingPatchId,
      PATCH_ROLES.roofSoffit,
      slabFootprint,
      bottomY,
      "down",
      ["frame", "roof", "soffit", "exterior"],
    ),
    horizontalPatch(
      topPatchId,
      PATCH_ROLES.roof,
      slabFootprint,
      topY,
      "up",
      ["frame", "roof", "exterior", "traversable"],
    ),
    ...HORIZONTAL_ORIENTATIONS.map((orientation, index) => verticalPatch(
      edgePatchIds[index] ?? structurePath(id, `edge_${index}`),
      PATCH_ROLES.roofEdge,
      slabFootprint,
      orientation,
      bottomY,
      topY,
      ["frame", "roof", "exterior", directionSegment(orientation)],
    )),
  ];
  const cornices = frame.members.filter((member) => member.kind === "cornice");
  const bearingPatchIds = [
    ...cornices.flatMap((member) => member.patchIds.slice(1)),
    ...(cell?.walls.flatMap((wall) => [wall.outerPatchId, wall.innerPatchId]) ?? []),
  ];
  const bearingFootprints = [
    ...cornices.map((member) => member.rect),
    ...(cell ? [cell.footprint] : []),
  ];
  const record: FrameRoofRecord = {
    id,
    kind: "roof",
    roofType: "frame_range",
    coversFrameId: frame.id,
    coversCellIds: cell ? [cell.id] : [],
    coversRoomIds: cell?.rooms.map((room) => room.id) ?? [],
    bearingPatchIds,
    bearingFootprints,
    slabFootprint,
    bottomY,
    slabTopY: topY,
    topY,
    thickness: spec.roof.thickness,
    projection: spec.roof.projection,
    topPatchId,
    ceilingPatchId,
    edgePatchIds,
    soffitPatchIds: [ceilingPatchId],
    patchIds: patches.map((patch) => patch.id),
  };
  const links: (readonly [string, string])[] = [];
  for (const edgePatchId of edgePatchIds) {
    links.push([edgePatchId, topPatchId], [edgePatchId, ceilingPatchId]);
  }
  for (const bearingPatchId of bearingPatchIds) {
    links.push([bearingPatchId, ceilingPatchId]);
  }
  return { record, patches, links };
}

function rowMemberRect(
  rect: Rect,
  orientation: HorizontalOrientation,
  depth: number,
  trimCorners: boolean,
): Rect {
  const half = depth * 0.5;
  switch (orientation) {
    case "front":
      return { minX: rect.minX - half, maxX: rect.maxX + half, minZ: rect.maxZ - half, maxZ: rect.maxZ + half };
    case "rear":
      return { minX: rect.minX - half, maxX: rect.maxX + half, minZ: rect.minZ - half, maxZ: rect.minZ + half };
    case "sidePositiveU":
      return { minX: rect.maxX - half, maxX: rect.maxX + half, minZ: rect.minZ + (trimCorners ? half : -half), maxZ: rect.maxZ - (trimCorners ? half : -half) };
    case "sideNegativeU":
      return { minX: rect.minX - half, maxX: rect.minX + half, minZ: rect.minZ + (trimCorners ? half : -half), maxZ: rect.maxZ - (trimCorners ? half : -half) };
  }
}

function expandAcrossRow(rect: Rect, orientation: HorizontalOrientation, amount: number): Rect {
  return orientation === "front" || orientation === "rear"
    ? { ...rect, minZ: rect.minZ - amount, maxZ: rect.maxZ + amount }
    : { ...rect, minX: rect.minX - amount, maxX: rect.maxX + amount };
}

function spanRect(
  start: FrameSupportRecord,
  end: FrameSupportRecord,
  depth: number,
): Rect {
  const horizontal = Math.abs(end.x - start.x) >= Math.abs(end.z - start.z);
  return horizontal
    ? {
      minX: Math.min(start.x, end.x),
      maxX: Math.max(start.x, end.x),
      minZ: start.z - depth * 0.5,
      maxZ: start.z + depth * 0.5,
    }
    : {
      minX: start.x - depth * 0.5,
      maxX: start.x + depth * 0.5,
      minZ: Math.min(start.z, end.z),
      maxZ: Math.max(start.z, end.z),
    };
}

function centeredRect(x: number, z: number, width: number, depth: number): Rect {
  return {
    minX: x - width * 0.5,
    maxX: x + width * 0.5,
    minZ: z - depth * 0.5,
    maxZ: z + depth * 0.5,
  };
}

function stairAssemblyWidth(stair: StairConnectorRecord): number {
  const sideWidth = stair.parapet?.width ?? 0;
  const projection = stair.parapet?.cornice?.projection ?? 0;
  return stair.width + 2 * (sideWidth + projection);
}

function coordinateKey(x: number, z: number): string {
  return `${x.toFixed(9)},${z.toFixed(9)}`;
}

function supportById(
  supports: ReadonlyMap<string, FrameSupportRecord>,
  id: string | undefined,
): FrameSupportRecord | undefined {
  return [...supports.values()].find((support) => support.id === id);
}

function requireSupport(support: FrameSupportRecord | undefined): FrameSupportRecord {
  if (!support) {
    throw new Error("Resolved Frame row lost one of its supports.");
  }
  return support;
}

function directionSegment(direction: HorizontalOrientation): string {
  switch (direction) {
    case "front": return "front";
    case "rear": return "rear";
    case "sidePositiveU": return "side_positive_u";
    case "sideNegativeU": return "side_negative_u";
  }
}

function horizontalPatch(
  id: string,
  role: PatchRole,
  rect: Rect,
  y: number,
  facing: "up" | "down",
  tags: readonly string[],
  anchors: Patch["anchors"] = [],
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
    anchors,
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

function verticalEdges(id: string, orientation: HorizontalOrientation): PatchEdges {
  return {
    uMin: patchEdge(id, "u_min", orientation),
    uMax: patchEdge(id, "u_max", orientation),
    vMin: patchEdge(id, "v_min", "bottom"),
    vMax: patchEdge(id, "v_max", "top"),
  };
}

function patchEdge(
  id: string,
  segment: string,
  orientation: PatchEdges["uMin"]["orientation"],
): PatchEdges["uMin"] {
  return { id: structurePath(id, segment), orientation, treatment: null };
}
