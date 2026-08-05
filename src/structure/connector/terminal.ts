import type { StairConnectorRecord } from "../kernel/graph";
import { stairBasis, stairLocalVertex } from "./stair";

/**
 * Where a stair's summit terminals land, and which of them run into each other.
 *
 * A flight finishes each of its parapets with a square cap on the arrival
 * floor. Two stairs arriving on the same summit from different sides put their
 * inner caps in the same place, and a summit small enough to force the flights
 * together — which the layout does routinely, and reports as `stair.width_reduced`
 * — makes those caps overlap outright. Left alone that reads as two slabs
 * driven through one another, and it puts two fire bowls a few centimetres
 * apart on what should be one pier.
 *
 * This module answers only "where are they, and do any two collide". What to do
 * about a collision is the caller's: the tessellator merges the caps, the fire
 * bowl slots collapse to one. Both need the same answer, and neither can be the
 * one that decides it, because a cap belongs to a stair and a collision belongs
 * to a pair of them.
 *
 * Every stair frame is world-axis-aligned (see `stairBasis`), so a cap is an
 * axis-aligned rectangle in plan whatever direction its flight faces. That is
 * what keeps this arithmetic to interval overlap, and what lets a merged cap
 * stay a set of rectangles rather than becoming a polygon boolean.
 */

/** Caps closer than this are treated as touching rather than overlapping. */
const TOUCH_EPSILON = 1e-6;

export interface TerminalCap {
  readonly connectorId: string;
  readonly side: "negative" | "positive";
  /** Plan extent in world space; axis-aligned by construction. */
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  /** Underside and top of the cornice cap itself. */
  readonly bottomY: number;
  readonly topY: number;
  /**
   * Plan extent of the wall beneath the cap, which is narrower than the cap by
   * the cornice projection on both axes. Merging has to union the two levels
   * separately or the wall inherits the molding's overhang.
   */
  readonly bodyMinX: number;
  readonly bodyMaxX: number;
  readonly bodyMinZ: number;
  readonly bodyMaxZ: number;
  /** Floor the wall stands on. */
  readonly floorY: number;
  /** Side length of the square cap, and the sizing surface for anything on it. */
  readonly width: number;
  /** Unit direction away from the mass, carried from the owning flight. */
  readonly outwardX: number;
  readonly outwardZ: number;
}

export interface TerminalGroup {
  readonly caps: readonly TerminalCap[];
  /** The region every cap in the group covers. */
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface TerminalOverlap {
  readonly a: TerminalCap;
  readonly b: TerminalCap;
  /** The shared plan region, always non-empty for a reported overlap. */
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/**
 * The two summit caps a stair finishes its parapets with, or none.
 *
 * Mirrors the geometry `laySupportedCorniceEndings` lays: the cap spans the
 * parapet's own width plus its cornice projection on both axes, and sits on the
 * arrival side of the flight's plan rectangle.
 */
export function summitTerminalCaps(
  record: StairConnectorRecord,
): TerminalCap[] {
  const parapet = record.parapet;
  const cornice = parapet?.cornice;

  if (!parapet || !cornice) {
    return [];
  }

  const outward = stairBasis(record.direction).outward;
  const halfWidth = record.width * 0.5;
  const projection = cornice.projection;
  const length = parapet.width + projection * 2;
  const bodyTop = record.topY + parapet.height - cornice.height;
  const capTop = record.topY + parapet.height;

  const spans: readonly (readonly ["negative" | "positive", number, number])[] = [
    ["negative", -halfWidth - parapet.width - projection, -halfWidth + projection],
    ["positive", halfWidth - projection, halfWidth + parapet.width + projection],
  ];

  return spans.map(([side, u0, u1]) => {
    // The local frame is axis-aligned but may be rotated by a quarter turn, so
    // the corners are transformed and re-bounded rather than assumed in order.
    const cap = planBounds(record, u0, u1, -length, 0, capTop);
    const body = planBounds(
      record,
      u0 + projection,
      u1 - projection,
      -length,
      0,
      capTop,
    );

    return {
      connectorId: record.id,
      side,
      ...cap,
      bodyMinX: body.minX,
      bodyMaxX: body.maxX,
      bodyMinZ: body.minZ,
      bodyMaxZ: body.maxZ,
      floorY: record.topY,
      bottomY: bodyTop,
      topY: capTop,
      width: length,
      outwardX: outward.x,
      outwardZ: outward.z,
    };
  });
}

/** World plan extent of a local rectangle, whatever quarter turn the frame is at. */
function planBounds(
  record: StairConnectorRecord,
  u0: number,
  u1: number,
  v0: number,
  v1: number,
  y: number,
): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const corners = [
    stairLocalVertex(record, u0, y, v0),
    stairLocalVertex(record, u1, y, v0),
    stairLocalVertex(record, u1, y, v1),
    stairLocalVertex(record, u0, y, v1),
  ];

  return {
    minX: Math.min(...corners.map((corner) => corner.x)),
    maxX: Math.max(...corners.map((corner) => corner.x)),
    minZ: Math.min(...corners.map((corner) => corner.z)),
    maxZ: Math.max(...corners.map((corner) => corner.z)),
  };
}

/**
 * Overlapping caps gathered into connected groups, each with the region they
 * all share.
 *
 * Connected rather than pairwise because a tight summit can run three caps
 * together, and treating that as two independent pairs would put two bowls back
 * on one pier. The shared region is intersected across the whole group; if that
 * collapses — three caps in a row where the ends do not reach each other — the
 * group falls back to the region its first reported pair shares, which is
 * always non-empty and always on stone.
 */
export function groupOverlappingTerminals(
  caps: readonly TerminalCap[],
): TerminalGroup[] {
  const overlaps = overlappingTerminals(caps);
  const groupOf = new Map<string, number>();
  const groups: TerminalCap[][] = [];

  for (const overlap of overlaps) {
    const keyA = terminalCapKey(overlap.a.connectorId, overlap.a.side);
    const keyB = terminalCapKey(overlap.b.connectorId, overlap.b.side);
    const existing = groupOf.get(keyA) ?? groupOf.get(keyB);

    if (existing === undefined) {
      groupOf.set(keyA, groups.length);
      groupOf.set(keyB, groups.length);
      groups.push([overlap.a, overlap.b]);
      continue;
    }

    for (const [key, cap] of [[keyA, overlap.a], [keyB, overlap.b]] as const) {
      if (!groupOf.has(key)) {
        groupOf.set(key, existing);
        groups[existing]!.push(cap);
      }
    }
  }

  return groups.map((members, index) => {
    const shared = {
      minX: Math.max(...members.map((cap) => cap.minX)),
      maxX: Math.min(...members.map((cap) => cap.maxX)),
      minZ: Math.max(...members.map((cap) => cap.minZ)),
      maxZ: Math.min(...members.map((cap) => cap.maxZ)),
    };

    if (shared.maxX - shared.minX > TOUCH_EPSILON
      && shared.maxZ - shared.minZ > TOUCH_EPSILON) {
      return { caps: members, ...shared };
    }

    const fallback = overlaps.find(
      (overlap) => groupOf.get(
        terminalCapKey(overlap.a.connectorId, overlap.a.side),
      ) === index,
    )!;

    return {
      caps: members,
      minX: fallback.minX,
      maxX: fallback.maxX,
      minZ: fallback.minZ,
      maxZ: fallback.maxZ,
    };
  });
}

/**
 * Every pair of summit caps that genuinely occupy the same space.
 *
 * Caps that merely abut are not overlaps: they already meet cleanly, and
 * merging them would replace two correct blocks with one that says the same
 * thing. The elevation test matters as much as the plan one — two stairs
 * arriving at different heights may cross in plan while passing well clear of
 * each other, and that is a bridge, not a collision.
 */
export function overlappingTerminals(
  caps: readonly TerminalCap[],
): TerminalOverlap[] {
  const overlaps: TerminalOverlap[] = [];

  for (let first = 0; first < caps.length; first += 1) {
    for (let second = first + 1; second < caps.length; second += 1) {
      const a = caps[first]!;
      const b = caps[second]!;

      if (a.connectorId === b.connectorId) {
        continue;
      }

      const minX = Math.max(a.minX, b.minX);
      const maxX = Math.min(a.maxX, b.maxX);
      const minZ = Math.max(a.minZ, b.minZ);
      const maxZ = Math.min(a.maxZ, b.maxZ);

      if (maxX - minX <= TOUCH_EPSILON || maxZ - minZ <= TOUCH_EPSILON) {
        continue;
      }

      if (
        Math.min(a.topY, b.topY) - Math.max(a.bottomY, b.bottomY) <= TOUCH_EPSILON
      ) {
        continue;
      }

      overlaps.push({ a, b, minX, maxX, minZ, maxZ });
    }
  }

  return overlaps;
}

/** Identifies a cap for suppression, since caps cross module boundaries by name. */
export function terminalCapKey(connectorId: string, side: string): string {
  return `${connectorId}/${side}`;
}

export interface PlanRect {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/**
 * The region a set of axis-aligned rectangles covers between them, cut into
 * blocks that tile it exactly and know which of their flanks are open.
 *
 * Cells rather than one outline because `SolidBuilder.addBlock` takes four
 * corners and no more, so the union cannot be one prism however convenient that
 * would be. What it must not become is a pile of boxes that each emit their
 * whole boundary: where two of them meet, that boundary is emitted twice, and
 * two faces at the same depth is the exact fault the block-face flags exist to
 * prevent. Each cell here reports its neighbours, so an internal wall is never
 * laid at all.
 *
 * The cut is taken on every input edge, which makes the method indifferent to
 * how the rectangles are arranged — corner overlap, edge overlap, one swallowing
 * another, or three in a row. A summit that pushes flights together produces all
 * of those.
 */
export interface UnionCell {
  /**
   * Four plan corners. A wedge repeats one of them, because `addBlock` takes
   * exactly four and a wedge is a triangle.
   */
  readonly ring: readonly { readonly x: number; readonly z: number }[];
  /** One flag per ring edge: true where nothing of the union stands against it. */
  readonly open: readonly boolean[];
}

/** Which way a wedge's two square sides face. */
type Direction = "positiveX" | "negativeX" | "positiveZ" | "negativeZ";

const OPPOSITE: Readonly<Record<Direction, Direction>> = {
  positiveX: "negativeX",
  negativeX: "positiveX",
  positiveZ: "negativeZ",
  negativeZ: "positiveZ",
};

export function unionCells(rects: readonly PlanRect[]): UnionCell[] {
  const xs = dedupe(rects.flatMap((rect) => [rect.minX, rect.maxX]));
  const zs = dedupe(rects.flatMap((rect) => [rect.minZ, rect.maxZ]));

  if (xs.length < 2 || zs.length < 2) {
    return [];
  }

  const inside = (column: number, row: number): boolean => {
    if (column < 0 || row < 0 || column + 1 >= xs.length || row + 1 >= zs.length) {
      return false;
    }

    const x = (xs[column]! + xs[column + 1]!) * 0.5;
    const z = (zs[row]! + zs[row + 1]!) * 0.5;

    return rects.some(
      (rect) => x > rect.minX && x < rect.maxX && z > rect.minZ && z < rect.maxZ,
    );
  };

  // A notch is an empty cell with exactly two filled neighbours at right
  // angles to each other — the inside of a step. Filling it with the triangle
  // that spans those two sides is what turns the step into a mitre, which is
  // the whole reason this is not just a grid of rectangles.
  const wedges = new Map<string, readonly [Direction, Direction]>();

  for (let column = 0; column + 1 < xs.length; column += 1) {
    for (let row = 0; row + 1 < zs.length; row += 1) {
      if (inside(column, row)) {
        continue;
      }

      const filled = ([
        ["positiveX", inside(column + 1, row)],
        ["negativeX", inside(column - 1, row)],
        ["positiveZ", inside(column, row + 1)],
        ["negativeZ", inside(column, row - 1)],
      ] as const).filter(([, covered]) => covered).map(([side]) => side);

      // Two filled neighbours facing each other is a gap between two runs, not
      // a corner, and cutting it diagonally would close a passage rather than
      // ease a step.
      if (filled.length !== 2 || OPPOSITE[filled[0]!] === filled[1]!) {
        continue;
      }

      wedges.set(cellKey(column, row), [filled[0]!, filled[1]!]);
    }
  }

  /** True where the neighbour fully closes the edge the two cells share. */
  const closes = (column: number, row: number, facing: Direction): boolean => {
    if (inside(column, row)) {
      return true;
    }

    const wedge = wedges.get(cellKey(column, row));

    // A wedge covers its two square sides completely and its diagonal not at
    // all, so it closes a neighbour only across one of those two.
    return wedge !== undefined && wedge.includes(OPPOSITE[facing]);
  };

  const cells: UnionCell[] = [];

  for (let column = 0; column + 1 < xs.length; column += 1) {
    for (let row = 0; row + 1 < zs.length; row += 1) {
      const x0 = xs[column]!;
      const x1 = xs[column + 1]!;
      const z0 = zs[row]!;
      const z1 = zs[row + 1]!;
      const corner: Readonly<Record<Direction, { x: number; z: number }[]>> = {
        positiveX: [{ x: x1, z: z1 }, { x: x1, z: z0 }],
        negativeX: [{ x: x0, z: z0 }, { x: x0, z: z1 }],
        positiveZ: [{ x: x0, z: z1 }, { x: x1, z: z1 }],
        negativeZ: [{ x: x1, z: z0 }, { x: x0, z: z0 }],
      };

      if (inside(column, row)) {
        cells.push({
          ring: [
            { x: x0, z: z1 },
            { x: x1, z: z1 },
            { x: x1, z: z0 },
            { x: x0, z: z0 },
          ],
          open: [
            !closes(column, row + 1, "positiveZ"),
            !closes(column + 1, row, "positiveX"),
            !closes(column, row - 1, "negativeZ"),
            !closes(column - 1, row, "negativeX"),
          ],
        });
        continue;
      }

      const wedge = wedges.get(cellKey(column, row));

      if (!wedge) {
        continue;
      }

      // The two sides meet at the corner they share; walking one side into the
      // other gives the triangle, and the edge that closes it is the diagonal.
      const [first, second] = wedge;
      const start = corner[first]!.find(
        (point) => corner[second]!.some((other) => same(point, other)),
      )
        ? corner[first]!.find((point) => !corner[second]!.some((other) => same(point, other)))!
        : corner[first]![0]!;
      const shared = corner[first]!.find(
        (point) => corner[second]!.some((other) => same(point, other)),
      )!;
      const end = corner[second]!.find((point) => !same(point, shared))!;

      cells.push({
        ring: [start, shared, end, start],
        open: [false, false, true, false],
      });
    }
  }

  return cells;
}

function cellKey(column: number, row: number): string {
  return `${column},${row}`;
}

function same(
  left: { readonly x: number; readonly z: number },
  right: { readonly x: number; readonly z: number },
): boolean {
  return Math.abs(left.x - right.x) < TOUCH_EPSILON
    && Math.abs(left.z - right.z) < TOUCH_EPSILON;
}
function dedupe(values: readonly number[]): number[] {
  const sorted = [...values].sort((left, right) => left - right);

  return sorted.filter(
    (value, index) => index === 0 || value - sorted[index - 1]! > TOUCH_EPSILON,
  );
}
