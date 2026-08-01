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
  type CellConnectionRecord,
  type CellInteriorWallRecord,
  type CellRecord,
  type CellRoomRecord,
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
  readonly kind: "single_chamber" | "twin_chamber" | "three_bay";
  readonly height: number;
  readonly wallThickness: number;
  readonly portalWidth: number;
  readonly portalHeight: number;
  readonly interiorOpeningWidth: number;
  readonly interiorOpeningHeight: number;
}

export interface ResolvedCell {
  readonly record: CellRecord;
  readonly patches: readonly Patch[];
  readonly links: readonly (readonly [string, string])[];
  /** Topological requests placed onto the exterior wall by facade grammar. */
  readonly exteriorOpenings: readonly CellExteriorOpeningRequest[];
}

export interface CellExteriorOpeningRequest {
  readonly id: string;
  readonly kind: "portal";
  readonly direction: HorizontalOrientation;
  readonly width: number;
  readonly height: number;
  readonly bottomY: number;
  readonly topY: number;
  readonly threshold: Rect;
  readonly exteriorWallPatchId: string;
  readonly interiorWallPatchId: string;
  readonly exteriorPatchId: string;
  readonly interiorPatchId: string;
  readonly destinationRoomIds: readonly string[];
}

/**
 * Resolves one summit cell assembly. The plan may divide its authoritative
 * exterior envelope into rooms, but every partition and connection is owned
 * once here so patch emission and tessellation consume the same rectangles.
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
  if (
    spec.kind !== "single_chamber"
    && (
      spec.interiorOpeningWidth <= 0
      || spec.interiorOpeningHeight <= 0
      || spec.interiorOpeningHeight >= spec.height
    )
  ) {
    diagnostics.error(
      "cell.invalid_interior_opening",
      id,
      "Interior opening dimensions must be positive and lower than the building height.",
    );
    return null;
  }

  const bottomY = placement.y;
  const topY = bottomY + spec.height;
  const roomPlan = resolveRoomPlan(
    id,
    spec,
    interior,
    bottomY,
    portalFacades,
    diagnostics,
  );

  if (!roomPlan) {
    return null;
  }

  const wallRecords: CellWallRecord[] = [];
  const patches: Patch[] = [];
  const links: (readonly [string, string])[] = [];

  for (const room of roomPlan.rooms) {
    patches.push(floorPatch(room.floorPatchId, room.footprint, bottomY));
  }

  for (const orientation of [
    "front",
    "rear",
    "sidePositiveU",
    "sideNegativeU",
  ] as const) {
    const outerPatchId = structurePath(id, `wall_${wallSegment(orientation)}_exterior`);
    const innerPatchId = structurePath(id, `wall_${wallSegment(orientation)}_interior`);

    patches.push(
      wallPatch({
        id: outerPatchId,
        rect: footprint,
        orientation,
        bottomY,
        topY,
        interior: false,
      }),
      wallPatch({
        id: innerPatchId,
        rect: interior,
        orientation,
        bottomY,
        topY,
        interior: true,
      }),
    );
    wallRecords.push({ orientation, outerPatchId, innerPatchId });
    links.push([placement.patchId, outerPatchId]);

    for (const room of roomsAtExteriorWall(roomPlan.rooms, orientation, interior)) {
      links.push([room.floorPatchId, innerPatchId]);
    }
  }

  linkWallLoop(wallRecords, "outerPatchId", links);
  linkWallLoop(wallRecords, "innerPatchId", links);

  const exteriorOpenings: CellExteriorOpeningRequest[] = [];

  for (const direction of portalFacades) {
    const wall = wallRecords.find((candidate) => candidate.orientation === direction)!;
    const portalId = structurePath(id, "portal", wallSegment(direction));
    const threshold = portalThreshold(
      footprint,
      interior,
      direction,
      spec.portalWidth,
    );
    const destinations = destinationRooms(
      roomPlan.rooms,
      spec.kind,
      direction,
    );

    exteriorOpenings.push({
      id: portalId,
      kind: "portal",
      direction,
      width: spec.portalWidth,
      height: spec.portalHeight,
      bottomY,
      topY: bottomY + spec.portalHeight,
      threshold,
      exteriorWallPatchId: wall.outerPatchId,
      interiorWallPatchId: wall.innerPatchId,
      exteriorPatchId: placement.patchId,
      interiorPatchId: destinations[0]?.floorPatchId
        ?? roomPlan.rooms[0]!.floorPatchId,
      destinationRoomIds: destinations.map((room) => room.id),
    });
  }

  for (const wall of roomPlan.interiorWalls) {
    const connections = roomPlan.connections.filter(
      (connection) => wall.connectionIds.includes(connection.id),
    );
    const negativeOrientation: HorizontalOrientation = wall.axis === "x"
      ? "rear"
      : "sideNegativeU";
    const positiveOrientation: HorizontalOrientation = wall.axis === "x"
      ? "front"
      : "sidePositiveU";

    patches.push(
      interiorWallPatch(
        wall.negativePatchId,
        wall.rect,
        negativeOrientation,
        bottomY,
        topY,
        connections,
      ),
      interiorWallPatch(
        wall.positivePatchId,
        wall.rect,
        positiveOrientation,
        bottomY,
        topY,
        connections,
      ),
    );

    const negativeRoom = roomPlan.rooms.find(
      (room) => room.id === wall.negativeRoomId,
    )!;
    const positiveRoom = roomPlan.rooms.find(
      (room) => room.id === wall.positiveRoomId,
    )!;
    links.push(
      [wall.negativePatchId, negativeRoom.floorPatchId],
      [wall.positivePatchId, positiveRoom.floorPatchId],
    );

    for (const connection of connections) {
      const direction = wall.axis === "x"
        ? "front"
        : "sidePositiveU";
      const revealIds = {
        start: structurePath(connection.id, "jamb_start"),
        end: structurePath(connection.id, "jamb_end"),
        head: structurePath(connection.id, "soffit"),
      };

      patches.push(
        portalJambPatch(
          revealIds.start,
          connection.threshold,
          direction,
          "start",
          bottomY,
          connection.height,
        ),
        portalJambPatch(
          revealIds.end,
          connection.threshold,
          direction,
          "end",
          bottomY,
          connection.height,
        ),
        portalSoffitPatch(
          revealIds.head,
          connection.threshold,
          connection.topY,
        ),
      );

      for (const revealId of Object.values(revealIds)) {
        links.push(
          [wall.negativePatchId, revealId],
          [wall.positivePatchId, revealId],
        );
      }
      links.push(
        [revealIds.start, revealIds.head],
        [revealIds.end, revealIds.head],
      );
    }
  }

  const floorPatchId = roomPlan.rooms.find(
    (room) => room.id === roomPlan.primaryRoomId,
  )?.floorPatchId ?? roomPlan.rooms[0]!.floorPatchId;

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
    openings: [],
    rooms: roomPlan.rooms,
    interiorWalls: roomPlan.interiorWalls,
    connections: roomPlan.connections,
    patchIds: patches.map((patch) => patch.id),
  };

  return { record, patches, links, exteriorOpenings };
}

interface ResolvedRoomPlan {
  readonly rooms: readonly CellRoomRecord[];
  readonly interiorWalls: readonly CellInteriorWallRecord[];
  readonly connections: readonly CellConnectionRecord[];
  readonly primaryRoomId: string;
}

function resolveRoomPlan(
  cellId: string,
  spec: SummitCellSpec,
  interior: Rect,
  bottomY: number,
  portalFacades: ReadonlySet<HorizontalOrientation>,
  diagnostics: DiagnosticCollector,
): ResolvedRoomPlan | null {
  if (spec.kind === "single_chamber") {
    const room = cellRoom(
      structurePath(cellId, "room"),
      "chamber",
      interior,
      structurePath(cellId, "floor"),
    );

    return {
      rooms: [room],
      interiorWalls: [],
      connections: [],
      primaryRoomId: room.id,
    };
  }

  if (spec.kind === "twin_chamber") {
    if (
      (
        portalFacades.has("sideNegativeU")
        || portalFacades.has("sidePositiveU")
      )
      && spec.portalWidth < spec.wallThickness - 1e-9
    ) {
      diagnostics.error(
        "cell.side_portal_too_narrow_for_plan",
        cellId,
        "A twin-chamber side portal must be at least as wide as the partition it meets.",
      );
      return null;
    }

    const centerZ = (interior.minZ + interior.maxZ) * 0.5;
    const halfWall = spec.wallThickness * 0.5;
    const wallRect: Rect = {
      minX: interior.minX,
      maxX: interior.maxX,
      minZ: centerZ - halfWall,
      maxZ: centerZ + halfWall,
    };
    const rear = cellRoom(
      structurePath(cellId, "room_rear"),
      "rear_chamber",
      { ...interior, maxZ: wallRect.minZ },
    );
    const front = cellRoom(
      structurePath(cellId, "room_front"),
      "front_chamber",
      { ...interior, minZ: wallRect.maxZ },
    );

    if (!rectIsValid(rear.footprint) || !rectIsValid(front.footprint)) {
      diagnostics.error(
        "cell.plan_does_not_fit",
        cellId,
        "The twin-chamber plan leaves no usable room around its interior wall.",
      );
      return null;
    }

    const wallId = structurePath(cellId, "partition_rear_front");
    const intervals: { readonly id: string; readonly start: number; readonly end: number }[] = [];
    const centerX = (interior.minX + interior.maxX) * 0.5;
    const halfOpening = spec.interiorOpeningWidth * 0.5;
    intervals.push({
      id: "center",
      start: centerX - halfOpening,
      end: centerX + halfOpening,
    });

    if (portalFacades.has("sideNegativeU")) {
      intervals.push({
        id: "left_entry",
        start: interior.minX,
        end: interior.minX + spec.interiorOpeningWidth,
      });
    }
    if (portalFacades.has("sidePositiveU")) {
      intervals.push({
        id: "right_entry",
        start: interior.maxX - spec.interiorOpeningWidth,
        end: interior.maxX,
      });
    }

    if (!openingIntervalsFit(
      intervals,
      interior.minX,
      interior.maxX,
      spec.wallThickness * 0.5,
    )) {
      diagnostics.error(
        "cell.interior_openings_do_not_fit",
        cellId,
        "The twin-chamber interior openings overlap or leave no supporting pier.",
      );
      return null;
    }

    const connections = intervals.map((interval) => {
      const connectionId = structurePath(wallId, `door_${interval.id}`);
      return cellConnection(
        connectionId,
        rear.id,
        front.id,
        {
          minX: interval.start,
          maxX: interval.end,
          minZ: wallRect.minZ,
          maxZ: wallRect.maxZ,
        },
        interval.end - interval.start,
        spec.interiorOpeningHeight,
        bottomY,
      );
    });
    const wall = interiorWall(
      wallId,
      "x",
      wallRect,
      rear.id,
      front.id,
      connections,
    );

    return {
      rooms: [rear, front],
      interiorWalls: [wall],
      connections,
      primaryRoomId: front.id,
    };
  }

  const usableWidth = rectWidth(interior) - spec.wallThickness * 2;
  const roomWidth = usableWidth / 3;

  if (roomWidth <= spec.wallThickness * 0.5) {
    diagnostics.error(
      "cell.plan_does_not_fit",
      cellId,
      "The three-bay plan leaves no usable rooms between its interior walls.",
    );
    return null;
  }

  const leftWallRect: Rect = {
    minX: interior.minX + roomWidth,
    maxX: interior.minX + roomWidth + spec.wallThickness,
    minZ: interior.minZ,
    maxZ: interior.maxZ,
  };
  const rightWallRect: Rect = {
    minX: leftWallRect.maxX + roomWidth,
    maxX: leftWallRect.maxX + roomWidth + spec.wallThickness,
    minZ: interior.minZ,
    maxZ: interior.maxZ,
  };
  const left = cellRoom(
    structurePath(cellId, "room_left"),
    "side_chamber",
    { ...interior, maxX: leftWallRect.minX },
  );
  const center = cellRoom(
    structurePath(cellId, "room_center"),
    "central_hall",
    {
      ...interior,
      minX: leftWallRect.maxX,
      maxX: rightWallRect.minX,
    },
  );
  const right = cellRoom(
    structurePath(cellId, "room_right"),
    "side_chamber",
    { ...interior, minX: rightWallRect.maxX },
  );
  const halfOpening = spec.interiorOpeningWidth * 0.5;
  const centerZ = (interior.minZ + interior.maxZ) * 0.5;

  if (
    ![left, center, right].every((room) => rectIsValid(room.footprint))
    || spec.interiorOpeningWidth >= rectDepth(interior)
  ) {
    diagnostics.error(
      "cell.interior_openings_do_not_fit",
      cellId,
      "The three-bay rooms or their interior openings do not fit the chamber.",
    );
    return null;
  }
  if (
    (
      portalFacades.has("front")
      || portalFacades.has("rear")
    )
    && spec.portalWidth > rectWidth(center.footprint) + 1e-9
  ) {
    diagnostics.error(
      "cell.portal_misses_central_hall",
      cellId,
      "A three-bay front or rear portal must fit within the central hall.",
    );
    return null;
  }

  const leftWallId = structurePath(cellId, "partition_left_center");
  const rightWallId = structurePath(cellId, "partition_center_right");
  const leftConnection = cellConnection(
    structurePath(leftWallId, "door_center"),
    left.id,
    center.id,
    {
      minX: leftWallRect.minX,
      maxX: leftWallRect.maxX,
      minZ: centerZ - halfOpening,
      maxZ: centerZ + halfOpening,
    },
    spec.interiorOpeningWidth,
    spec.interiorOpeningHeight,
    bottomY,
  );
  const rightConnection = cellConnection(
    structurePath(rightWallId, "door_center"),
    center.id,
    right.id,
    {
      minX: rightWallRect.minX,
      maxX: rightWallRect.maxX,
      minZ: centerZ - halfOpening,
      maxZ: centerZ + halfOpening,
    },
    spec.interiorOpeningWidth,
    spec.interiorOpeningHeight,
    bottomY,
  );

  return {
    rooms: [left, center, right],
    interiorWalls: [
      interiorWall(
        leftWallId,
        "z",
        leftWallRect,
        left.id,
        center.id,
        [leftConnection],
      ),
      interiorWall(
        rightWallId,
        "z",
        rightWallRect,
        center.id,
        right.id,
        [rightConnection],
      ),
    ],
    connections: [leftConnection, rightConnection],
    primaryRoomId: center.id,
  };
}

function cellRoom(
  id: string,
  role: CellRoomRecord["role"],
  footprint: Rect,
  floorPatchId = structurePath(id, "floor"),
): CellRoomRecord {
  return { id, role, footprint, floorPatchId };
}

function cellConnection(
  id: string,
  sourceRoomId: string,
  destinationRoomId: string,
  threshold: Rect,
  width: number,
  height: number,
  bottomY: number,
): CellConnectionRecord {
  return {
    id,
    kind: "door",
    sourceRoomId,
    destinationRoomId,
    width,
    height,
    bottomY,
    topY: bottomY + height,
    threshold,
    revealPatchIds: [
      structurePath(id, "jamb_start"),
      structurePath(id, "jamb_end"),
      structurePath(id, "soffit"),
    ],
  };
}

function interiorWall(
  id: string,
  axis: CellInteriorWallRecord["axis"],
  rect: Rect,
  negativeRoomId: string,
  positiveRoomId: string,
  connections: readonly CellConnectionRecord[],
): CellInteriorWallRecord {
  return {
    id,
    axis,
    rect,
    negativeRoomId,
    positiveRoomId,
    negativePatchId: structurePath(id, "face_negative"),
    positivePatchId: structurePath(id, "face_positive"),
    connectionIds: connections.map((connection) => connection.id),
  };
}

function openingIntervalsFit(
  intervals: readonly { readonly start: number; readonly end: number }[],
  minimum: number,
  maximum: number,
  minimumPier: number,
): boolean {
  const ordered = [...intervals].sort((a, b) => a.start - b.start);

  return ordered.every(
    (interval) => interval.start >= minimum - 1e-9
      && interval.end <= maximum + 1e-9
      && interval.end > interval.start,
  ) && ordered.every(
    (interval, index) =>
      index === 0
      || interval.start - ordered[index - 1]!.end >= minimumPier - 1e-9,
  );
}

function roomsAtExteriorWall(
  rooms: readonly CellRoomRecord[],
  orientation: HorizontalOrientation,
  interior: Rect,
): CellRoomRecord[] {
  return rooms.filter((room) => {
    switch (orientation) {
      case "front":
        return Math.abs(room.footprint.maxZ - interior.maxZ) < 1e-9;
      case "rear":
        return Math.abs(room.footprint.minZ - interior.minZ) < 1e-9;
      case "sidePositiveU":
        return Math.abs(room.footprint.maxX - interior.maxX) < 1e-9;
      case "sideNegativeU":
        return Math.abs(room.footprint.minX - interior.minX) < 1e-9;
    }
  });
}

function destinationRooms(
  rooms: readonly CellRoomRecord[],
  layout: SummitCellSpec["kind"],
  direction: HorizontalOrientation,
): CellRoomRecord[] {
  if (layout === "single_chamber") {
    return [...rooms];
  }
  if (layout === "twin_chamber") {
    if (direction === "front") {
      return rooms.filter((room) => room.role === "front_chamber");
    }
    if (direction === "rear") {
      return rooms.filter((room) => room.role === "rear_chamber");
    }
    return [...rooms];
  }

  if (direction === "sideNegativeU") {
    return rooms.filter(
      (room) =>
        room.role === "side_chamber"
        && room.footprint.minX === Math.min(...rooms.map((item) => item.footprint.minX)),
    );
  }
  if (direction === "sidePositiveU") {
    return rooms.filter(
      (room) =>
        room.role === "side_chamber"
        && room.footprint.maxX === Math.max(...rooms.map((item) => item.footprint.maxX)),
    );
  }

  return rooms.filter((room) => room.role === "central_hall");
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
    regions: [],
    features: [],
    anchors: [],
    tags: [
      input.interior ? "interior" : "exterior",
      "cell_wall",
      input.orientation,
      "roof_bearing",
    ],
  };
}

function interiorWallPatch(
  id: string,
  rect: Rect,
  orientation: HorizontalOrientation,
  bottomY: number,
  topY: number,
  connections: readonly CellConnectionRecord[],
): Patch {
  const edge = rectEdge(rect, orientation);
  const frame = createFacadeFrame(edge, bottomY, topY, edge.start);
  const regions = connections.map((connection, index) =>
    connectionRegion(
      id,
      frame,
      connection,
      topY - bottomY,
      index,
    ));
  const features: PatchFeature[] = regions.map((region, index) => ({
    id: structurePath(id, `cut_door_${String(index + 1).padStart(2, "0")}`),
    operation: "cut",
    depth: 0,
    materialRole: null,
    regionId: region.id,
    order: index,
    dependsOn: [],
    runsBefore: [],
    runsAfter: [],
    conflictPolicy: "error",
  }));

  return {
    id,
    role: PATCH_ROLES.cellWallInterior,
    frame,
    dimensions: {
      u: frame.uLength,
      v: frame.vLength,
      thickness: 0,
    },
    evaluator: "planar",
    edges: wallEdges(id, orientation),
    adjacency: [],
    regions,
    features,
    anchors: [],
    tags: [
      "interior",
      "cell_wall",
      "interior_partition",
      orientation,
      "roof_bearing",
    ],
  };
}

function connectionRegion(
  patchId: string,
  frame: LocalFrame,
  connection: CellConnectionRecord,
  wallHeight: number,
  index: number,
): PatchRegion {
  const points = [
    { x: connection.threshold.minX, z: connection.threshold.minZ },
    { x: connection.threshold.minX, z: connection.threshold.maxZ },
    { x: connection.threshold.maxX, z: connection.threshold.minZ },
    { x: connection.threshold.maxX, z: connection.threshold.maxZ },
  ];
  const projected = points.map((point) =>
    (
      (point.x - frame.origin.x) * frame.uAxis.x
      + (point.z - frame.origin.z) * frame.uAxis.z
    ) / frame.uLength);

  return {
    id: structurePath(
      patchId,
      `connection_${String(index + 1).padStart(2, "0")}`,
    ),
    uRange: [Math.min(...projected), Math.max(...projected)],
    vRange: [0, connection.height / wallHeight],
    priority: 100,
    allowedOperations: ["cut"],
    exclusions: [],
    tags: ["opening", "door", "circulation", "interior_connection"],
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
