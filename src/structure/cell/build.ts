import type { SolidBuilder } from "../../geometry/solid-builder";
import { rectCorners, rectIsValid, type Rect } from "../kernel/frame";
import type { CellRecord } from "../kernel/graph";
import {
  divideCourses,
  divideRun,
  masonrySeed,
  type MasonryRule,
} from "../kernel/masonry";

const EPS = 1e-9;
type SideFlags = readonly [boolean, boolean, boolean, boolean];

interface CellPanel {
  readonly id: string;
  readonly rect: Rect;
  readonly bottomY: number;
  readonly topY: number;
  /** Rect side order: left, front, right, rear. */
  readonly sides: SideFlags;
  readonly top: boolean;
  readonly bottom: boolean;
  readonly axis: "x" | "z";
}

export function buildCell(
  builder: SolidBuilder,
  cell: CellRecord,
  masonry: MasonryRule | null,
  seed: number,
): void {
  const panels = cellPanels(cell);

  if (!masonry) {
    for (const panel of panels) {
      addPanelBlock(builder, panel);
    }
    return;
  }

  const boundaries = courseBoundaries(cell, masonry, seed);
  for (const panel of panels) {
    layPanelStones(builder, panel, masonry, seed, boundaries);
  }
}

/**
 * Whether a horizontal support face is wholly beneath a cell wall panel.
 * Tessellation calls this before emitting the cell, so its own floor and wall
 * faces can never cull themselves.
 */
export function faceIsCoveredByCellWall(
  face: readonly { readonly x: number; readonly y: number; readonly z: number }[],
  cell: CellRecord,
): boolean {
  if (
    face.length !== 4
    || face.some((point) => Math.abs(point.y - cell.bottomY) > EPS)
    || faceNormalY(face) < 0.99
  ) {
    return false;
  }

  return cellPanels(cell)
    .filter((panel) => Math.abs(panel.bottomY - cell.bottomY) <= EPS)
    .some((panel) => face.every((point) => pointInsideRect(point, panel.rect)));
}

/**
 * Exposed support surface when bare massing is used: outside the chamber,
 * inside the room, and through the portal threshold. The wall ring itself is
 * deliberately absent.
 */
export function addBareCellFloorSurface(
  builder: SolidBuilder,
  surface: Rect,
  cell: CellRecord,
  y: number,
): void {
  addHorizontalRing(builder, surface, cell.footprint, y);

  for (const room of cell.rooms) {
    addHorizontalRect(builder, room.footprint, y);
  }

  for (const portal of cell.openings) {
    addHorizontalRect(builder, portal.threshold, y);
  }
  for (const connection of cell.connections) {
    addHorizontalRect(builder, connection.threshold, y);
  }
}

function cellPanels(cell: CellRecord): CellPanel[] {
  const { footprint: outer, interior: inner, bottomY, topY } = cell;
  const panels: CellPanel[] = [
    // Corner blocks own the returns between adjacent wall spans. Their contact
    // faces stay closed, so adding portals to either neighbour cannot create
    // overlaps or expose the room through a corner joint.
    panel("corner_left_rear", {
      minX: outer.minX, maxX: inner.minX,
      minZ: outer.minZ, maxZ: inner.minZ,
    }, bottomY, topY, [true, false, false, true], "z"),
    panel("corner_left_front", {
      minX: outer.minX, maxX: inner.minX,
      minZ: inner.maxZ, maxZ: outer.maxZ,
    }, bottomY, topY, [true, true, false, false], "z"),
    panel("corner_right_rear", {
      minX: inner.maxX, maxX: outer.maxX,
      minZ: outer.minZ, maxZ: inner.minZ,
    }, bottomY, topY, [false, false, true, true], "z"),
    panel("corner_right_front", {
      minX: inner.maxX, maxX: outer.maxX,
      minZ: inner.maxZ, maxZ: outer.maxZ,
    }, bottomY, topY, [false, true, true, false], "z"),
  ];

  for (const direction of [
    "front",
    "rear",
    "sidePositiveU",
    "sideNegativeU",
  ] as const) {
    panels.push(...wallPanels(
      cell,
      direction,
      cell.openings.find((opening) => opening.direction === direction) ?? null,
    ));
  }

  for (const wall of cell.interiorWalls) {
    panels.push(...interiorWallPanels(cell, wall));
  }

  return panels.filter(
    (candidate) =>
      rectIsValid(candidate.rect) && candidate.topY > candidate.bottomY,
  );
}

function interiorWallPanels(
  cell: CellRecord,
  wall: CellRecord["interiorWalls"][number],
): CellPanel[] {
  const axis = wall.axis;
  const openings = wall.connectionIds
    .map((connectionId) =>
      cell.connections.find((connection) => connection.id === connectionId))
    .filter((connection) => connection !== undefined)
    .sort((a, b) =>
      openingStart(a.threshold, axis) - openingStart(b.threshold, axis));
  const surfaces: SideFlags = axis === "x"
    ? [false, true, false, true]
    : [true, false, true, false];
  const start = axis === "x" ? wall.rect.minX : wall.rect.minZ;
  const end = axis === "x" ? wall.rect.maxX : wall.rect.maxZ;
  const startSide = axis === "x" ? 0 : 3;
  const endSide = axis === "x" ? 2 : 1;
  const panels: CellPanel[] = [];
  let cursor = start;

  for (let index = 0; index < openings.length; index += 1) {
    const opening = openings[index]!;
    const openingFrom = openingStart(opening.threshold, axis);
    const openingTo = openingEnd(opening.threshold, axis);
    const pierSides = cursor > start + EPS
      ? withSide(surfaces, startSide)
      : surfaces;

    panels.push(panel(
      `${wall.id}_pier_${String(index + 1).padStart(2, "0")}`,
      spanRect(wall.rect, axis, cursor, openingFrom),
      cell.bottomY,
      cell.topY,
      withSide(pierSides, endSide),
      axis,
    ));
    panels.push(...interiorHeaderPanels(
      cell,
      wall,
      opening,
      index,
      surfaces,
      startSide,
      endSide,
      start,
      end,
    ));
    cursor = openingTo;
  }

  const finalSides = cursor > start + EPS
    ? withSide(surfaces, startSide)
    : surfaces;
  panels.push(panel(
    `${wall.id}_pier_end`,
    spanRect(wall.rect, axis, cursor, end),
    cell.bottomY,
    cell.topY,
    finalSides,
    axis,
  ));

  return panels;
}

function interiorHeaderPanels(
  cell: CellRecord,
  wall: CellRecord["interiorWalls"][number],
  opening: CellRecord["connections"][number],
  index: number,
  surfaces: SideFlags,
  startSide: number,
  endSide: number,
  wallStart: number,
  wallEnd: number,
): CellPanel[] {
  const axis = wall.axis;
  const openingFrom = openingStart(opening.threshold, axis);
  const openingTo = openingEnd(opening.threshold, axis);
  const headerRect = spanRect(wall.rect, axis, openingFrom, openingTo);
  const endpoint = Math.abs(openingFrom - wallStart) <= EPS
    ? {
      side: startSide,
      direction: axis === "x" ? "sideNegativeU" : "rear",
    } as const
    : Math.abs(openingTo - wallEnd) <= EPS
      ? {
        side: endSide,
        direction: axis === "x" ? "sidePositiveU" : "front",
      } as const
      : null;
  const exteriorPortal = endpoint
    ? cell.openings.find((candidate) => candidate.direction === endpoint.direction)
    : null;
  const exposedTopY = Math.min(
    exteriorPortal?.topY ?? opening.topY,
    cell.topY,
  );
  const id = `${wall.id}_header_${String(index + 1).padStart(2, "0")}`;

  if (endpoint && exposedTopY > opening.topY + EPS) {
    return [
      panel(
        `${id}_exposed`,
        headerRect,
        opening.topY,
        exposedTopY,
        withSide(surfaces, endpoint.side),
        axis,
        false,
        true,
      ),
      panel(
        id,
        headerRect,
        exposedTopY,
        cell.topY,
        surfaces,
        axis,
      ),
    ];
  }

  return [panel(
    id,
    headerRect,
    opening.topY,
    cell.topY,
    surfaces,
    axis,
    true,
    true,
  )];
}

function openingStart(
  threshold: Rect,
  axis: CellPanel["axis"],
): number {
  return axis === "x" ? threshold.minX : threshold.minZ;
}

function openingEnd(
  threshold: Rect,
  axis: CellPanel["axis"],
): number {
  return axis === "x" ? threshold.maxX : threshold.maxZ;
}

function wallPanels(
  cell: CellRecord,
  direction: CellRecord["walls"][number]["orientation"],
  opening: CellRecord["openings"][number] | null,
): CellPanel[] {
  const { footprint: outer, interior: inner, bottomY, topY } = cell;
  const axis = direction === "front" || direction === "rear" ? "x" : "z";
  const rect = wallCenterRect(outer, inner, direction);
  const id = wallPanelId(direction);
  const surfaces = wallSurfaceSides(direction);

  if (!opening) {
    return [panel(id, rect, bottomY, topY, surfaces, axis)];
  }

  const start = axis === "x" ? rect.minX : rect.minZ;
  const end = axis === "x" ? rect.maxX : rect.maxZ;
  const portalStart = axis === "x"
    ? opening.threshold.minX
    : opening.threshold.minZ;
  const portalEnd = axis === "x"
    ? opening.threshold.maxX
    : opening.threshold.maxZ;
  const startRect = spanRect(rect, axis, start, portalStart);
  const portalRect = spanRect(rect, axis, portalStart, portalEnd);
  const endRect = spanRect(rect, axis, portalEnd, end);
  const startSide = axis === "x" ? 0 : 3;
  const endSide = axis === "x" ? 2 : 1;
  const startPierSides = withSide(surfaces, endSide);
  const endPierSides = withSide(surfaces, startSide);
  const headerBottom = opening.topY;

  return [
    // The piers expose only their portal-facing jamb. Their tops are supported
    // by the header and remain un-emitted.
    panel(
      `${id}_pier_start`,
      startRect,
      bottomY,
      headerBottom,
      startPierSides,
      axis,
      false,
    ),
    panel(
      `${id}_pier_end`,
      endRect,
      bottomY,
      headerBottom,
      endPierSides,
      axis,
      false,
    ),
    // Three header blocks keep the soffit limited to the opening itself while
    // retaining whole rectangular masonry blocks on either side.
    panel(
      `${id}_header_start`,
      startRect,
      headerBottom,
      topY,
      surfaces,
      axis,
    ),
    panel(
      `${id}_header_portal`,
      portalRect,
      headerBottom,
      topY,
      surfaces,
      axis,
      true,
      true,
    ),
    panel(
      `${id}_header_end`,
      endRect,
      headerBottom,
      topY,
      surfaces,
      axis,
    ),
  ];
}

function wallCenterRect(
  outer: Rect,
  inner: Rect,
  direction: CellRecord["walls"][number]["orientation"],
): Rect {
  switch (direction) {
    case "front":
      return {
        minX: inner.minX,
        maxX: inner.maxX,
        minZ: inner.maxZ,
        maxZ: outer.maxZ,
      };
    case "rear":
      return {
        minX: inner.minX,
        maxX: inner.maxX,
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

function wallPanelId(
  direction: CellRecord["walls"][number]["orientation"],
): string {
  switch (direction) {
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

function wallSurfaceSides(
  direction: CellRecord["walls"][number]["orientation"],
): SideFlags {
  switch (direction) {
    case "front":
      return [false, true, false, true];
    case "rear":
      return [false, true, false, true];
    case "sidePositiveU":
      return [true, false, true, false];
    case "sideNegativeU":
      return [true, false, true, false];
  }
}

function spanRect(
  rect: Rect,
  axis: CellPanel["axis"],
  from: number,
  to: number,
): Rect {
  return axis === "x"
    ? { ...rect, minX: from, maxX: to }
    : { ...rect, minZ: from, maxZ: to };
}

function withSide(sides: SideFlags, index: number): SideFlags {
  const result: [boolean, boolean, boolean, boolean] = [...sides];
  result[index] = true;
  return result;
}

function panel(
  id: string,
  rect: Rect,
  bottomY: number,
  topY: number,
  sides: SideFlags,
  axis: "x" | "z",
  top = true,
  bottom = false,
): CellPanel {
  return { id, rect, bottomY, topY, sides, axis, top, bottom };
}

function addPanelBlock(builder: SolidBuilder, panel: CellPanel): void {
  const bottom = rectCorners(panel.rect).map((point) => ({
    x: point.x,
    y: panel.bottomY,
    z: point.z,
  }));
  const top = rectCorners(panel.rect).map((point) => ({
    x: point.x,
    y: panel.topY,
    z: point.z,
  }));

  builder.addBlock(
    { bottom, top },
    {
      sides: panel.sides,
      top: panel.top,
      bottom: panel.bottom,
    },
  );
}

function courseBoundaries(
  cell: CellRecord,
  rule: MasonryRule,
  seed: number,
): number[] {
  const courses = divideCourses(
    cell.height,
    rule,
    masonrySeed(seed, cell.id, "courses"),
  );
  const boundaries = [cell.bottomY];

  for (const course of courses) {
    boundaries.push(cell.bottomY + course.bottom + course.height);
  }
  for (const opening of cell.openings) {
    boundaries.push(opening.topY);
  }
  for (const connection of cell.connections) {
    boundaries.push(connection.topY);
  }

  return [...new Set(boundaries.map((value) => value.toFixed(9)))]
    .map(Number)
    .sort((a, b) => a - b);
}

function layPanelStones(
  builder: SolidBuilder,
  panel: CellPanel,
  rule: MasonryRule,
  seed: number,
  boundaries: readonly number[],
): void {
  const spans = boundaries
    .filter((value) =>
      value >= panel.bottomY - EPS && value <= panel.topY + EPS)
    .map((value) => Math.min(Math.max(value, panel.bottomY), panel.topY));
  const unique = [...new Set(spans.map((value) => value.toFixed(9)))].map(Number);
  const runLength = panel.axis === "x"
    ? panel.rect.maxX - panel.rect.minX
    : panel.rect.maxZ - panel.rect.minZ;

  for (let course = 0; course < unique.length - 1; course += 1) {
    const bottomY = unique[course]!;
    const topY = unique[course + 1]!;

    if (topY <= bottomY + EPS) {
      continue;
    }

    const widths = divideRun(
      runLength,
      rule,
      masonrySeed(seed, panel.id, `course_${course}`),
    );
    let cursor = 0;

    for (let stone = 0; stone < widths.length; stone += 1) {
      const width = widths[stone] ?? 0;
      const first = stone === 0;
      const last = stone === widths.length - 1;
      // The initial cell wall is one structural wythe. Opening a plan gap
      // through a full-depth stone would make every perpend a sightline through
      // the room wall; until bonded inner/outer wythes arrive, stones meet dry
      // and their separate outer quads retain the course division.
      const from = cursor;
      const to = cursor + width;
      cursor += width;

      if (to <= from + EPS) {
        continue;
      }

      const rect: Rect = panel.axis === "x"
        ? {
          ...panel.rect,
          minX: panel.rect.minX + from,
          maxX: panel.rect.minX + to,
        }
        : {
          ...panel.rect,
          minZ: panel.rect.minZ + from,
          maxZ: panel.rect.minZ + to,
        };
      const sides = stoneSides(panel, first, last);
      const piece: CellPanel = {
        ...panel,
        rect,
        bottomY,
        topY,
        sides,
        top: panel.top && course === unique.length - 2,
        bottom: panel.bottom && course === 0,
      };
      addPanelBlock(builder, piece);
    }
  }
}

function stoneSides(
  panel: CellPanel,
  first: boolean,
  last: boolean,
): SideFlags {
  const [left, front, right, rear] = panel.sides;

  if (panel.axis === "x") {
    return [
      first ? left : false,
      front,
      last ? right : false,
      rear,
    ];
  }

  return [
    left,
    last ? front : false,
    right,
    first ? rear : false,
  ];
}

function addHorizontalRing(
  builder: SolidBuilder,
  outer: Rect,
  covered: Rect,
  y: number,
): void {
  const pieces: readonly Rect[] = [
    {
      minX: outer.minX, maxX: covered.minX,
      minZ: outer.minZ, maxZ: outer.maxZ,
    },
    {
      minX: covered.maxX, maxX: outer.maxX,
      minZ: outer.minZ, maxZ: outer.maxZ,
    },
    {
      minX: covered.minX, maxX: covered.maxX,
      minZ: outer.minZ, maxZ: covered.minZ,
    },
    {
      minX: covered.minX, maxX: covered.maxX,
      minZ: covered.maxZ, maxZ: outer.maxZ,
    },
  ];

  for (const piece of pieces) {
    addHorizontalRect(builder, piece, y);
  }
}

function addHorizontalRect(
  builder: SolidBuilder,
  rect: Rect,
  y: number,
): void {
  if (!rectIsValid(rect)) {
    return;
  }

  const ring = rectCorners(rect).map((point) => ({ ...point, y }));
  builder.addBlock(
    { bottom: ring, top: ring },
    { sides: [false, false, false, false], top: true, bottom: false },
  );
}

function pointInsideRect(
  point: { readonly x: number; readonly z: number },
  rect: Rect,
): boolean {
  return point.x >= rect.minX - EPS
    && point.x <= rect.maxX + EPS
    && point.z >= rect.minZ - EPS
    && point.z <= rect.maxZ + EPS;
}

function faceNormalY(
  face: readonly { readonly x: number; readonly y: number; readonly z: number }[],
): number {
  const a = face[0]!;
  const b = face[1]!;
  const c = face[2]!;
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const y = ab.z * ac.x - ab.x * ac.z;
  const length = Math.hypot(
    ab.y * ac.z - ab.z * ac.y,
    y,
    ab.x * ac.y - ab.y * ac.x,
  );

  return length > EPS ? y / length : 0;
}
