import type { SolidBuilder } from "../../geometry/solid-builder";
import {
  evaluateFrame,
  rectCorners,
  rectIsValid,
  type Rect,
} from "../kernel/frame";
import type { CellRecord } from "../kernel/graph";
import type { Patch } from "../kernel/patch";
import {
  divideCourses,
  divideRun,
  masonrySeed,
  type MasonryRule,
} from "../kernel/masonry";
import { compiledCutFragments } from "../surface/features";

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
  patches: ReadonlyMap<string, Patch>,
  masonry: MasonryRule | null,
  seed: number,
): void {
  const panels = cellPanels(cell, patches);

  if (!masonry) {
    for (const panel of panels) {
      addPanelBlock(builder, panel);
    }
    return;
  }

  const boundaries = courseBoundaries(cell, masonry, seed, panels);
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
  patches: ReadonlyMap<string, Patch>,
): boolean {
  if (
    face.length !== 4
    || face.some((point) => Math.abs(point.y - cell.bottomY) > EPS)
    || faceNormalY(face) < 0.99
  ) {
    return false;
  }

  return cellPanels(cell, patches)
    .filter((panel) => Math.abs(panel.bottomY - cell.bottomY) <= EPS)
    .some((panel) => face.every((point) => pointInsideRect(point, panel.rect)));
}

/** True for an upward support face wholly owned by a room or threshold floor. */
export function faceIsCellInteriorFloor(
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

  const floors = [
    ...cell.rooms.map((room) => room.footprint),
    ...cell.openings.map((opening) => opening.threshold),
    ...cell.connections.map((connection) => connection.threshold),
  ];

  return floors.some((floor) =>
    face.every((point) => pointInsideRect(point, floor)));
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

  builder.withMaterial("interior", () => {
    for (const room of cell.rooms) {
      addHorizontalRect(builder, room.footprint, y);
    }

    for (const portal of cell.openings) {
      addHorizontalRect(builder, portal.threshold, y);
    }
    for (const connection of cell.connections) {
      addHorizontalRect(builder, connection.threshold, y);
    }
  });
}

function cellPanels(
  cell: CellRecord,
  patches: ReadonlyMap<string, Patch>,
): CellPanel[] {
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
    const wall = cell.walls.find((candidate) => candidate.orientation === direction);
    const patch = wall ? patches.get(wall.outerPatchId) : undefined;

    if (!wall || !patch) {
      throw new Error(`Cell "${cell.id}" is missing its ${direction} wall patch.`);
    }

    const axis = direction === "front" || direction === "rear" ? "x" : "z";
    panels.push(...cutWallPanels({
      id: wallPanelId(direction),
      rect: wallCenterRect(outer, inner, direction),
      axis,
      bottomY,
      topY,
      surfaces: wallSurfaceSides(direction),
      cuts: worldCuts(patch, axis),
      boundaryExposed: () => false,
    }));
  }

  for (const wall of cell.interiorWalls) {
    panels.push(...interiorWallPanels(cell, wall, patches));
  }

  return panels.filter(
    (candidate) =>
      rectIsValid(candidate.rect) && candidate.topY > candidate.bottomY,
  );
}

function interiorWallPanels(
  cell: CellRecord,
  wall: CellRecord["interiorWalls"][number],
  patches: ReadonlyMap<string, Patch>,
): CellPanel[] {
  const axis = wall.axis;
  const patch = patches.get(wall.negativePatchId);

  if (!patch) {
    throw new Error(`Interior wall "${wall.id}" is missing patch "${wall.negativePatchId}".`);
  }

  const surfaces: SideFlags = axis === "x"
    ? [false, true, false, true]
    : [true, false, true, false];
  const boundaryCuts = {
    start: interiorBoundaryCuts(cell, patches, wall, "start"),
    end: interiorBoundaryCuts(cell, patches, wall, "end"),
  };
  return cutWallPanels({
    id: wall.id,
    rect: wall.rect,
    axis,
    bottomY: cell.bottomY,
    topY: cell.topY,
    surfaces,
    cuts: worldCuts(patch, axis),
    boundaryBreaks: [...boundaryCuts.start, ...boundaryCuts.end]
      .flatMap((cut) => [cut.bottomY, cut.topY]),
    boundaryExposed: (end, fromY, toY) => boundaryCuts[end].some((cut) =>
      fromY < cut.topY - EPS && toY > cut.bottomY + EPS),
  });
}

interface WallCut {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly bottomY: number;
  readonly topY: number;
}

interface CutWallInput {
  readonly id: string;
  readonly rect: Rect;
  readonly axis: "x" | "z";
  readonly bottomY: number;
  readonly topY: number;
  readonly surfaces: SideFlags;
  readonly cuts: readonly WallCut[];
  /** Vertical divisions inherited from adjoining openings at the wall ends. */
  readonly boundaryBreaks?: readonly number[];
  readonly boundaryExposed: (
    end: "start" | "end",
    bottomY: number,
    topY: number,
  ) => boolean;
}

/**
 * Partitions one planar wall on every compiled cut boundary.
 *
 * Each occupied grid cell becomes one block. Faces between occupied cells stay
 * hidden; a solid-to-cut boundary becomes a jamb, sill or soffit. This supports
 * any number of rectangular openings, including openings above the floor,
 * without teaching the cell builder what a portal or window means.
 */
function cutWallPanels(input: CutWallInput): CellPanel[] {
  const start = input.axis === "x" ? input.rect.minX : input.rect.minZ;
  const end = input.axis === "x" ? input.rect.maxX : input.rect.maxZ;
  const cuts = input.cuts
    .map((cut) => ({
      ...cut,
      from: clamp(cut.from, start, end),
      to: clamp(cut.to, start, end),
      bottomY: clamp(cut.bottomY, input.bottomY, input.topY),
      topY: clamp(cut.topY, input.bottomY, input.topY),
    }))
    .filter((cut) => cut.to > cut.from + EPS && cut.topY > cut.bottomY + EPS);
  const along = uniqueSorted([
    start,
    end,
    ...cuts.flatMap((cut) => [cut.from, cut.to]),
  ]);
  const vertical = uniqueSorted([
    input.bottomY,
    input.topY,
    ...cuts.flatMap((cut) => [cut.bottomY, cut.topY]),
    ...(input.boundaryBreaks ?? []).map((value) =>
      clamp(value, input.bottomY, input.topY)),
  ]);
  const occupied = Array.from(
    { length: along.length - 1 },
    (_, u) => Array.from({ length: vertical.length - 1 }, (_, v) => {
      const centre = {
        along: ((along[u] ?? 0) + (along[u + 1] ?? 0)) * 0.5,
        y: ((vertical[v] ?? 0) + (vertical[v + 1] ?? 0)) * 0.5,
      };
      return !cuts.some((cut) =>
        centre.along > cut.from + EPS
        && centre.along < cut.to - EPS
        && centre.y > cut.bottomY + EPS
        && centre.y < cut.topY - EPS);
    }),
  );
  const panels: CellPanel[] = [];
  const startSide = input.axis === "x" ? 0 : 3;
  const endSide = input.axis === "x" ? 2 : 1;

  for (let u = 0; u < along.length - 1; u += 1) {
    for (let v = 0; v < vertical.length - 1; v += 1) {
      if (occupied[u]?.[v] !== true) {
        continue;
      }

      const from = along[u]!;
      const to = along[u + 1]!;
      const bottomY = vertical[v]!;
      const topY = vertical[v + 1]!;
      const atStart = u === 0;
      const atEnd = u === along.length - 2;
      const startVisible = atStart
        ? input.boundaryExposed("start", bottomY, topY)
        : occupied[u - 1]?.[v] === false;
      const endVisible = atEnd
        ? input.boundaryExposed("end", bottomY, topY)
        : occupied[u + 1]?.[v] === false;
      const belowVisible = v > 0 && occupied[u]?.[v - 1] === false;
      const aboveVisible = v === vertical.length - 2
        || occupied[u]?.[v + 1] === false;
      const sides: [boolean, boolean, boolean, boolean] = [...input.surfaces];
      sides[startSide] = startVisible;
      sides[endSide] = endVisible;

      panels.push(panel(
        `${input.id}_u${String(u).padStart(2, "0")}_v${String(v).padStart(2, "0")}`,
        spanRect(input.rect, input.axis, from, to),
        bottomY,
        topY,
        sides,
        input.axis,
        aboveVisible,
        belowVisible,
      ));
    }
  }

  return panels;
}

function worldCuts(patch: Patch, axis: "x" | "z"): WallCut[] {
  return compiledCutFragments(patch).map((fragment, index) => {
    const corners = [
      evaluateFrame(patch.frame, fragment.uMin, fragment.vMin),
      evaluateFrame(patch.frame, fragment.uMax, fragment.vMin),
      evaluateFrame(patch.frame, fragment.uMin, fragment.vMax),
      evaluateFrame(patch.frame, fragment.uMax, fragment.vMax),
    ];
    const along = corners.map((point) => axis === "x" ? point.x : point.z);
    const vertical = corners.map((point) => point.y);

    return {
      id: `${patch.id}/cut_${String(index + 1).padStart(2, "0")}`,
      from: Math.min(...along),
      to: Math.max(...along),
      bottomY: Math.min(...vertical),
      topY: Math.max(...vertical),
    };
  });
}

function interiorBoundaryCuts(
  cell: CellRecord,
  patches: ReadonlyMap<string, Patch>,
  wall: CellRecord["interiorWalls"][number],
  end: "start" | "end",
): WallCut[] {
  const direction = wall.axis === "x"
    ? end === "start" ? "sideNegativeU" : "sidePositiveU"
    : end === "start" ? "rear" : "front";
  const exterior = cell.walls.find((candidate) => candidate.orientation === direction);
  const patch = exterior ? patches.get(exterior.outerPatchId) : undefined;

  if (!patch) {
    return [];
  }

  const boundaryAxis = wall.axis === "x" ? "z" : "x";
  const coordinate = boundaryAxis === "x"
    ? (wall.rect.minX + wall.rect.maxX) * 0.5
    : (wall.rect.minZ + wall.rect.maxZ) * 0.5;

  return worldCuts(patch, boundaryAxis).filter((cut) =>
    coordinate > cut.from - EPS
    && coordinate < cut.to + EPS);
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values.map((value) => value.toFixed(9)))]
    .map(Number)
    .sort((a, b) => a - b);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
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
  panels: readonly CellPanel[],
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
  for (const panel of panels) {
    boundaries.push(panel.bottomY, panel.topY);
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
