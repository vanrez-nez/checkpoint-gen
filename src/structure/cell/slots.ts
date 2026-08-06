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
  resolveSlotRelief,
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
 * `profileWallPanels` breaks a featured wall into a grid at every feature edge,
 * so a portal or a hierarchical facade leaves a wall made of stacked panels
 * rather than one plane, and a field spanning several of them would belong to
 * none. The answer is to hand back the panels the features leave *between*
 * them, rather than the whole face.
 *
 * This used to refuse any wall carrying a feature that was not a cut, which
 * meant a hierarchical facade published nothing at all: its pilasters and
 * frieze are extrusions, so every wall was skipped and the summit-wall control
 * was a switch with nothing behind it. That was defensible while the facade
 * owned the composition outright — it drew its own recessed panels into the
 * field, and a slot competing with them would have read as a mistake. Those
 * panels are gone now, and what is left is framing: pilasters flanking the
 * entrance, a frieze capping the wall. Framing is exactly what a field wants
 * around it.
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

    // Which horizontal bands the grid offers, and which of them are stone.
    //
    // A field is drawable exactly when it fits inside one cell of the grid
    // `profileWallPanels` cuts — one straddling a split belongs to no panel and
    // is published, tinted by nothing, and never drawn. The bands are therefore
    // the feature bounds, and the field takes the tallest one its own column
    // leaves free.
    //
    // The tallest, not the lowest. Running the field up from the floor is the
    // obvious rule and it is wrong on any wall whose features do not stand on
    // the ground: a window floating in a side wall puts a split at its sill,
    // and a field starting at the floor gets the strip underneath — a 0.17 m
    // ledge where the 1.62 m panel beside the window was the field worth
    // having.
    const fragments = compiled.flatMap((entry) => entry.fragments);

    // Stone that only exists because a window stopped short of the corner is a
    // jamb, not a field.
    //
    // A window is anchored to neither the floor nor the parapet, so unlike a
    // doorway or a frieze it splits the wall in both axes at once. What it
    // leaves hard against itself is a remnant — on the default summit, 0.04 of
    // the wall's width against its neighbour's 0.19 — and engraving it puts a
    // stripe beside the opening that reads as a mistake. The stone further
    // along the same wall is untouched by any of that and is a field like any
    // other.
    const floating = fragments.filter((fragment) =>
      fragment.vMin > EPS && fragment.vMax < 1 - EPS);
    const cuts = [...new Set([
      0,
      1,
      ...fragments.flatMap((fragment) => [fragment.vMin, fragment.vMax]),
    ])]
      .filter((v) => v >= -EPS && v <= 1 + EPS)
      .sort((left, right) => left - right);

    // A capping band — a frieze hanging off the parapet — spans nearly the
    // whole face, so carving its width would leave slivers at the wall's ends
    // and nothing between them. It takes a band instead, and the loop below
    // finds it occupied. Everything else divides the wall across and is cut
    // out of it: the entrance, the pilasters flanking it, the window.
    for (const fragment of fragments) {
      if (fragment.vMax >= 1 - EPS) {
        continue;
      }

      spans = spans.flatMap((span) =>
        withoutRange(span, [fragment.uMin, fragment.uMax]));
    }

    // Dropped after carving rather than before, because a remnant is only
    // recognisable once the spans exist: it is a span that a floating feature
    // put an edge on.
    spans = spans.filter((span) => !floating.some((fragment) =>
      Math.abs(span[0].at - fragment.uMax) <= EPS
      || Math.abs(span[1].at - fragment.uMin) <= EPS));

    for (const [index, span] of spans.entries()) {
      const band = tallestFreeBand(span, cuts, fragments);

      if (!band) {
        continue;
      }

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
        vRange: band,
        widthBottom: patch.dimensions.u,
        widthTop: patch.dimensions.u,
        faceHeight: patch.dimensions.v,
        hierarchy: 10,
        flow: patch.dimensions.u >= patch.dimensions.v ? "horizontal" : "vertical",
        continuity: "per_face",
        depthBudget: slotDepthBudget(input.cell.wallThickness, rule.recessDepth),
        textureScale: input.feature.textureScale,
        // Against the wall's own thickness, which is what makes the same
        // request a shallow mark on a thin screen and a real pocket on a
        // thick one.
        faceOffset: resolveSlotRelief(
          input.feature.relief,
          slotDepthBudget(input.cell.wallThickness, rule.recessDepth),
        ),
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
/**
 * The tallest unbroken run of stone in a column, or null if there is none.
 *
 * Runs, not single bands. A feature's bounds split the grid across the whole
 * wall, so a window in one bay puts a sill and a head through every other bay
 * too — and taking one band at a time gave the column beside a window a 1.26 m
 * field where the same column on the opposite wall had 2.24 m. Consecutive
 * bands that are both plain stone are one face, and are merged here.
 *
 * `profileWallPanels` merges the same runs when it emits the wall, and it has
 * to: a field is drawable only if some panel contains it, so a run this joins
 * and that leaves split is a field published and never drawn. Both test a
 * cell's centre against the same fragments, which is what keeps them agreeing.
 */
function tallestFreeBand(
  span: readonly [FaceEdgeSource, FaceEdgeSource],
  cuts: readonly number[],
  fragments: readonly { uMin: number; uMax: number; vMin: number; vMax: number }[],
): readonly [number, number] | null {
  const u = (span[0].at + span[1].at) * 0.5;
  let best: readonly [number, number] | null = null;
  let runFrom: number | null = null;

  for (let index = 0; index < cuts.length - 1; index += 1) {
    const bottom = cuts[index]!;
    const top = cuts[index + 1]!;

    if (top - bottom <= EPS) {
      continue;
    }

    const v = (bottom + top) * 0.5;
    const covered = fragments.some((fragment) =>
      u > fragment.uMin + EPS
      && u < fragment.uMax - EPS
      && v > fragment.vMin + EPS
      && v < fragment.vMax - EPS);

    if (covered) {
      runFrom = null;
      continue;
    }

    runFrom ??= bottom;

    if (!best || top - runFrom > best[1] - best[0]) {
      best = [runFrom, top];
    }
  }

  return best;
}

export interface PreparedCellField {
  readonly orientation: HorizontalOrientation;
  /** Along the wall: world X for a front or rear wall, world Z otherwise. */
  readonly minU: number;
  readonly maxU: number;
  readonly minV: number;
  readonly maxV: number;
  /**
   * Signed metres the field's face leaves the wall by, already resolved
   * against the budget. Negative sinks a pocket, positive raises a panel.
   */
  readonly relief: number;
  readonly textureScale: number;
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
      // Read off the record rather than recomputed from the feature: the slot
      // is what every other consumer reads, and a second opinion here could
      // disagree with it.
      relief: slot.faceOffset,
      textureScale: slot.textureScale,
    });
  }

  return prepared;
}
