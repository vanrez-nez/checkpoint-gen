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
  addHorizontalRect(builder, cell.interior, y);

  const portal = cell.openings[0];
  if (portal) {
    addHorizontalRect(builder, {
      minX: portal.minX,
      maxX: portal.maxX,
      minZ: cell.interior.maxZ,
      maxZ: cell.footprint.maxZ,
    }, y);
  }
}

function cellPanels(cell: CellRecord): CellPanel[] {
  const { footprint: outer, interior: inner, bottomY, topY } = cell;
  const portal = cell.openings[0];

  if (!portal) {
    return [];
  }

  const headerBottom = portal.topY;
  const panels: CellPanel[] = [
    // Left wall: the corner segments own the rear/front returns; only the
    // centre segment exposes its inner face to the chamber.
    panel("left_rear", {
      minX: outer.minX, maxX: inner.minX,
      minZ: outer.minZ, maxZ: inner.minZ,
    }, bottomY, topY, [true, false, false, true], "z"),
    panel("left_center", {
      minX: outer.minX, maxX: inner.minX,
      minZ: inner.minZ, maxZ: inner.maxZ,
    }, bottomY, topY, [true, false, true, false], "z"),
    panel("left_front", {
      minX: outer.minX, maxX: inner.minX,
      minZ: inner.maxZ, maxZ: outer.maxZ,
    }, bottomY, topY, [true, true, false, false], "z"),

    // Right wall, mirrored.
    panel("right_rear", {
      minX: inner.maxX, maxX: outer.maxX,
      minZ: outer.minZ, maxZ: inner.minZ,
    }, bottomY, topY, [false, false, true, true], "z"),
    panel("right_center", {
      minX: inner.maxX, maxX: outer.maxX,
      minZ: inner.minZ, maxZ: inner.maxZ,
    }, bottomY, topY, [true, false, true, false], "z"),
    panel("right_front", {
      minX: inner.maxX, maxX: outer.maxX,
      minZ: inner.maxZ, maxZ: outer.maxZ,
    }, bottomY, topY, [false, true, true, false], "z"),

    // Rear wall between the two side walls.
    panel("rear", {
      minX: inner.minX, maxX: inner.maxX,
      minZ: outer.minZ, maxZ: inner.minZ,
    }, bottomY, topY, [false, true, false, true], "x"),

    // Portal piers. Their tops are supported by the header and stay un-emitted.
    panel("front_pier_left", {
      minX: inner.minX, maxX: portal.minX,
      minZ: inner.maxZ, maxZ: outer.maxZ,
    }, bottomY, headerBottom, [false, true, true, true], "x", false),
    panel("front_pier_right", {
      minX: portal.maxX, maxX: inner.maxX,
      minZ: inner.maxZ, maxZ: outer.maxZ,
    }, bottomY, headerBottom, [true, true, false, true], "x", false),

    // Three header blocks keep the portal soffit exposed only over the void.
    panel("front_header_left", {
      minX: inner.minX, maxX: portal.minX,
      minZ: inner.maxZ, maxZ: outer.maxZ,
    }, headerBottom, topY, [false, true, false, true], "x"),
    panel("front_header_portal", {
      minX: portal.minX, maxX: portal.maxX,
      minZ: inner.maxZ, maxZ: outer.maxZ,
    }, headerBottom, topY, [false, true, false, true], "x", true, true),
    panel("front_header_right", {
      minX: portal.maxX, maxX: inner.maxX,
      minZ: inner.maxZ, maxZ: outer.maxZ,
    }, headerBottom, topY, [false, true, false, true], "x"),
  ];

  return panels.filter(
    (candidate) =>
      rectIsValid(candidate.rect) && candidate.topY > candidate.bottomY,
  );
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
