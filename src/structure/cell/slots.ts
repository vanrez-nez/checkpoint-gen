import {
  rectEdge,
  type HorizontalOrientation,
  type Rect,
} from "../kernel/frame";
import type { CellRecord } from "../kernel/graph";
import { structurePath } from "../kernel/ids";
import type { Patch } from "../kernel/patch";
import {
  arrisEdges,
  resolveFaceSlot,
  slotDepthBudget,
  slotRuleOf,
  withSlotReservations,
  withoutRange,
  type FaceEdgeSource,
  type FrameRecord,
  type SlotFeatureConfig,
  type SlotRecord,
} from "../kernel/slot";
import { compiledSurfaceFragments } from "../surface/features";

/**
 * The engravable fields a summit building's exterior walls present.
 *
 * A wall carrying surface features is not one of them. `profileWallPanels`
 * breaks a featured wall into a grid at every feature edge, so a portal or a
 * hierarchical facade leaves a wall made of stacked panels rather than one
 * plane — and a field spanning several of them would belong to none. A wall
 * with no features resolves to exactly one panel, which is exactly what an
 * engraving needs. Emitting nothing for the rest is the correct answer, not a
 * gap: the facade grammar already owns that elevation's composition.
 */

const EPS = 1e-9;

const WALL_SEGMENT: Readonly<Record<HorizontalOrientation, string>> = {
  front: "front",
  rear: "rear",
  sidePositiveU: "side_positive_u",
  sideNegativeU: "side_negative_u",
};

export interface CellSlotInput {
  readonly cell: CellRecord;
  readonly patches: readonly Patch[];
  readonly feature: SlotFeatureConfig;
}

export interface ResolvedCellSlots {
  readonly frames: readonly FrameRecord[];
  readonly slots: readonly SlotRecord[];
  readonly patches: readonly Patch[];
}

export function resolveCellSlots(input: CellSlotInput): ResolvedCellSlots {
  const frames: FrameRecord[] = [];
  const slots: SlotRecord[] = [];

  if (!input.feature.enabled) {
    return { frames, slots, patches: input.patches };
  }

  const rule = slotRuleOf(input.feature);

  const byId = new Map(input.patches.map((patch) => [patch.id, patch]));

  for (const wall of input.cell.walls) {
    const patch = byId.get(wall.outerPatchId);

    if (!patch) {
      continue;
    }

    const compiled = compiledSurfaceFragments(patch);

    // An entry is a hole in the wall, and stone either side of it is still an
    // elevation. Anything else on the wall is a facade grammar, and that owns
    // the composition — a field competing with it would read as a mistake.
    if (compiled.some((entry) => entry.feature.operation !== "cut")) {
      continue;
    }

    // The corner blocks own the returns, so the panel this wall is drawn as
    // runs only the interior's span. The patch spans the whole footprint edge,
    // so the slot says which part of it the wall actually is.
    let spans: (readonly [FaceEdgeSource, FaceEdgeSource])[] = [
      arrisEdges(drawnWallRange(
        wall.orientation,
        input.cell.footprint,
        input.cell.interior,
      )),
    ];

    let head = 1;

    for (const entry of compiled) {
      for (const fragment of entry.fragments) {
        spans = spans.flatMap((span) =>
          withoutRange(span, [fragment.uMin, fragment.uMax]));
        head = Math.min(head, fragment.vMax);
      }
    }

    for (const [index, span] of spans.entries()) {
      const resolved = resolveFaceSlot({
        id: structurePath(
          input.cell.id,
          spans.length > 1
            ? `wall_${WALL_SEGMENT[wall.orientation]}_slot_${index + 1}`
            : `wall_${WALL_SEGMENT[wall.orientation]}_slot`,
        ),
        kind: "field",
        part: "cell",
        face: wall.orientation,
        faceRole: patch.role,
        bandId: null,
        bayId: null,
        patchId: patch.id,
        uEdges: span,
        // Stone beside an entry stops at its head: `profileWallPanels` breaks
        // the wall there, so the band above the opening is a panel of its own
        // and a field reaching into it would belong to neither.
        vRange: [0, head],
        widthBottom: patch.dimensions.u,
        widthTop: patch.dimensions.u,
        faceHeight: patch.dimensions.v,
        hierarchy: 10,
        flow: patch.dimensions.u >= patch.dimensions.v ? "horizontal" : "vertical",
        continuity: "per_face",
        depthBudget: slotDepthBudget(input.cell.wallThickness, rule.recessDepth),
        tags: ["engraving", "exterior", "cell_wall", wall.orientation],
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

  return { frames, slots, patches: withSlotReservations(input.patches, slots) };
}

/**
 * The part of a wall's own edge that the wall panel is drawn over.
 *
 * `cellPanels` gives the four corner blocks the returns between adjacent wall
 * spans, so each wall runs the interior's extent rather than the footprint's.
 */
function drawnWallRange(
  orientation: HorizontalOrientation,
  footprint: Rect,
  interior: Rect,
): readonly [number, number] {
  const edge = rectEdge(footprint, orientation);
  const alongX = orientation === "front" || orientation === "rear";
  const from = alongX ? edge.start.x : edge.start.z;
  const to = alongX ? edge.end.x : edge.end.z;
  const span = to - from;

  if (Math.abs(span) <= EPS) {
    return [0, 1];
  }

  const bounds = alongX
    ? [interior.minX, interior.maxX]
    : [interior.minZ, interior.maxZ];
  const first = (bounds[0]! - from) / span;
  const second = (bounds[1]! - from) / span;

  return [
    Math.max(Math.min(first, second), 0),
    Math.min(Math.max(first, second), 1),
  ];
}

/**
 * Each published wall field, in the coordinates the builder draws in.
 *
 * Keyed by the panel `cellPanels` gives that wall, so the builder can ask "does
 * this panel carry a field" without re-deriving where the field is.
 */
export interface PreparedCellField {
  readonly orientation: HorizontalOrientation;
  /** Along the wall: world X for a front or rear wall, world Z otherwise. */
  readonly minU: number;
  readonly maxU: number;
  readonly minV: number;
  readonly maxV: number;
}

export function preparedCellFields(
  cell: CellRecord,
  patches: ReadonlyMap<string, Patch>,
): Map<HorizontalOrientation, PreparedCellField[]> {
  const prepared = new Map<HorizontalOrientation, PreparedCellField[]>();

  for (const slot of cell.slots) {
    const patch = patches.get(slot.patchId);
    const wall = cell.walls.find(
      (candidate) => candidate.outerPatchId === slot.patchId,
    );

    if (!patch || !wall) {
      continue;
    }

    const alongX = wall.orientation === "front" || wall.orientation === "rear";
    const edge = rectEdge(cell.footprint, wall.orientation);
    const from = alongX ? edge.start.x : edge.start.z;
    const to = alongX ? edge.end.x : edge.end.z;
    const at = (u: number) => from + (to - from) * u;
    const first = at(slot.inscribed.uMin);
    const second = at(slot.inscribed.uMax);
    const height = cell.topY - cell.bottomY;

    const carried = prepared.get(wall.orientation) ?? [];
    prepared.set(wall.orientation, carried);
    carried.push({
      orientation: wall.orientation,
      // Kept in `u` order rather than sorted: `rectEdge` runs backwards along
      // the axis on a rear or positive-side wall.
      minU: first,
      maxU: second,
      minV: cell.bottomY + slot.inscribed.vMin * height,
      maxV: cell.bottomY + slot.inscribed.vMax * height,
    });
  }

  return prepared;
}
