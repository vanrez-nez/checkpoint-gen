import { stairBasis } from "../connector/stair";
import {
  HORIZONTAL_ORIENTATIONS,
  rectDepth,
  rectEdge,
  rectIsValid,
  rectWidth,
  type HorizontalOrientation,
  type Rect,
} from "../kernel/frame";
import type { ElevationBandRecord } from "../kernel/graph";
import { structurePath } from "../kernel/ids";
import {
  arrisEdges,
  resolveFaceSlot,
  resolveSlotRelief,
  slotDepthBudget,
  slotRuleOf,
  withoutRange,
  type FrameRecord,
  type SlotFeatureConfig,
  type SlotRecord,
  type SlotRule,
} from "../kernel/slot";
import {
  bandStretches,
  type BandStretch,
  type PreparedField,
} from "./shell";

/**
 * The engravable fields a mass presents, and nothing else.
 *
 * A prepared field needs a plane, and the two things standing between a mass
 * and one are stonework and the stair. Stonework is handled downstream — the
 * tessellator lays a prepared stretch flat — but the stair is handled here,
 * because a flight climbing a facade hides the middle of it and a slot reaching
 * behind the flight would reserve stone nobody can see. So a crossed elevation
 * publishes the two fields flanking the flight rather than one that spans it.
 *
 * Nothing in this module touches geometry. It resolves a table, and every later
 * decision — which stretch loses its coursing, which face gets tinted — is read
 * back off that table rather than re-derived.
 */

const EPS = 1e-9;

const FACADE_SEGMENT: Readonly<Record<HorizontalOrientation, string>> = {
  front: "facade_front",
  rear: "facade_rear",
  sidePositiveU: "facade_side_positive_u",
  sideNegativeU: "facade_side_negative_u",
};

const CORNICE_SEGMENT: Readonly<Record<HorizontalOrientation, string>> = {
  front: "cornice_fascia_front",
  rear: "cornice_fascia_rear",
  sidePositiveU: "cornice_fascia_side_positive_u",
  sideNegativeU: "cornice_fascia_side_negative_u",
};

export function bandFacadePatchId(
  bandId: string,
  orientation: HorizontalOrientation,
): string {
  return structurePath(bandId, FACADE_SEGMENT[orientation]);
}

/**
 * The moulding's own elevation.
 *
 * A band's facade patch spans the whole rise, so its `v = 1` lands on the wall's
 * crown outline — which for a corniced band is *inside* the moulding, since the
 * moulding steps out past it. The fascia therefore needs a surface of its own
 * rather than a sub-rectangle of the wall's.
 */
export function corniceFasciaPatchId(
  bandId: string,
  orientation: HorizontalOrientation,
): string {
  return structurePath(bandId, CORNICE_SEGMENT[orientation]);
}

/**
 * The slot-bearing features of a mass, each with its own settings.
 *
 * One figure covering every surface was the wrong shape for this: a band wall
 * wants a large field, a moulding wants a running strip, and the summit's
 * fascias are narrower again. Each of these is authored on its own.
 */
export interface MassSlotFeatures {
  readonly plinth: SlotFeatureConfig;
  readonly bandWall: SlotFeatureConfig;
  readonly bandCornice: SlotFeatureConfig;
  readonly summitWall: SlotFeatureConfig;
  readonly summitRoofFascia: SlotFeatureConfig;
  readonly summitRoofCornice: SlotFeatureConfig;
}

export interface MassStairReserve {
  readonly direction: HorizontalOrientation;
  readonly spanU: readonly [number, number];
}

export interface MassSlotInput {
  /** Bottom-to-top, including the plinth: every elevation a flight passes. */
  readonly bands: readonly ElevationBandRecord[];
  /**
   * Bands standing clear of every flight — a raised summit pad, which the stair
   * arrives beside rather than climbs. Their elevations reserve nothing, which
   * is the same thing `emitSummitPad` says by publishing no stair region.
   */
  readonly detachedBands: readonly ElevationBandRecord[];
  readonly stairs: readonly MassStairReserve[];
  readonly features: MassSlotFeatures;
  /**
   * How many engravable strips a band elevation carries. Zero prepares the
   * whole face; anything more interleaves flat strips with set stone.
   */
  readonly slotBands: number;
}

/**
 * How much of a banded elevation the engraving takes, leaving the rest as
 * stone. Just under half: the strips have to read as let into the wall rather
 * than as the wall itself.
 */
const SLOT_BAND_SHARE = 0.45;

/**
 * The `v` spans a stretch's fields occupy, in the slot's own domain.
 *
 * Zero bands is one field over the whole face. More divides it into strips
 * separated by runs of set stone — and because the tessellator courses each run
 * on its own, every strip edge lands on a bed joint and the coursing above and
 * below still lines up round the building.
 */
function bandSpans(
  bands: number,
  from: number,
  to: number,
): (readonly [number, number])[] {
  const total = to - from;

  if (bands <= 0 || total <= EPS) {
    return [[from, to]];
  }

  const strip = (total * SLOT_BAND_SHARE) / bands;
  const run = (total * (1 - SLOT_BAND_SHARE)) / (bands + 1);

  return Array.from({ length: bands }, (_, index) => {
    const start = from + run * (index + 1) + strip * index;
    return [start, start + strip] as const;
  });
}

export function resolveMassSlots(
  input: MassSlotInput,
): { readonly frames: FrameRecord[]; readonly slots: SlotRecord[] } {
  const frames: FrameRecord[] = [];
  const slots: SlotRecord[] = [];

  const climbed = input.bands.map((band) => ({ band, stairs: input.stairs }));
  const clear = input.detachedBands.map((band) => ({
    band,
    stairs: [] as readonly MassStairReserve[],
  }));

  for (const { band, stairs } of [...climbed, ...clear]) {
    if (!rectIsValid(band.lower)) {
      continue;
    }

    for (const stretch of bandStretches(band)) {
      const feature = stretch.label === "cornice"
        ? input.features.bandCornice
        : band.index < 0
          ? input.features.plinth
          : input.features.bandWall;

      if (!feature.enabled) {
        continue;
      }

      // A moulding is already a strip, and a footing is too short to divide.
      const bands = stretch.label === "wall" && band.index >= 0
        ? input.slotBands
        : 0;

      for (const orientation of HORIZONTAL_ORIENTATIONS) {
        const found = stretchSlots(
          band,
          stretch,
          orientation,
          stairs,
          slotRuleOf(feature),
          bands,
          feature.relief,
          feature.textureScale,
        );
        for (const resolved of found) {
          if (resolved.frame) {
            frames.push(resolved.frame);
          }
          slots.push(resolved.slot);
        }
      }
    }
  }

  return { frames, slots };
}

/**
 * The fields one stretch presents on one elevation.
 *
 * Usually one. A wall the stair climbs gives two, and a wall the stair covers
 * entirely gives none.
 */
function stretchSlots(
  band: ElevationBandRecord,
  stretch: BandStretch,
  orientation: HorizontalOrientation,
  stairs: readonly MassStairReserve[],
  rule: SlotRule,
  bands: number,
  relief: number,
  textureScale: number,
): { readonly slot: SlotRecord; readonly frame: FrameRecord | null }[] {
  const cornice = stretch.label === "cornice";
  const patchId = cornice
    ? corniceFasciaPatchId(band.id, orientation)
    : bandFacadePatchId(band.id, orientation);

  // A cornice fascia is a plumb rectangle on its own outline. A wall is the
  // band's facade patch, whose domain is measured at the base and runs up the
  // rake — so its `v` is clipped where the moulding takes the top of the band.
  const widthBottom = edgeLength(cornice ? stretch.lower : band.lower, orientation);
  const widthTop = edgeLength(cornice ? stretch.upper : band.upper, orientation);
  const faceHeight = cornice
    ? stretch.topY - stretch.bottomY
    : facadeSlopeLength(band, orientation);
  const domain = slotDomainOf(band, stretch);
  const vMax = domain.rise <= EPS
    ? 1
    : Math.min((stretch.topY - domain.bottomY) / domain.rise, 1);

  if (widthBottom <= EPS || faceHeight <= EPS || vMax <= EPS) {
    return [];
  }

  const reserved = stairs.find((stair) => stair.direction === orientation);
  const whole = arrisEdges([0, 1]);
  const spans = cornice || !reserved
    ? [whole]
    : withoutRange(
      whole,
      stairReserveRange(band.lower, orientation, reserved.spanU),
    );

  // The stone actually behind this face, which is what bounds how deep an
  // ornament may be cut into it.
  const thickness = cornice
    ? stretch.topY - stretch.bottomY
    : Math.min(rectWidth(band.lower), rectDepth(band.lower)) * 0.5;

  const vStretchMin = domain.rise <= EPS
    ? 0
    : Math.max((stretch.bottomY - domain.bottomY) / domain.rise, 0);
  const rows = bandSpans(bands, vStretchMin, vMax);

  return spans.flatMap((span, index) => rows.flatMap((row, rowIndex) => {
    const name = [
      spans.length > 1 ? `slot_${index + 1}` : "slot",
      rows.length > 1 ? `band_${rowIndex + 1}` : null,
    ].filter((part): part is string => part !== null).join("_");
    const resolved = resolveFaceSlot({
      id: structurePath(patchId, name),
      // A strip let into a wall is a running band, not a panel, and is judged
      // on a ribbon's minimums rather than a field's.
      kind: cornice || rows.length > 1 ? "ribbon" : bandSlotKind(band),
      part: bandPart(band),
      face: orientation,
      faceRole: cornice ? "cornice" : band.surfaceRole,
      // The stretch this slot prepares. The tessellator reads it back to decide
      // which stretch loses its coursing.
      bandId: stretch.id,
      bayId: null,
      patchId,
      uEdges: span,
      vRange: row,
      widthBottom,
      widthTop,
      faceHeight,
      hierarchy: cornice ? 20 : 10,
      flow: widthBottom >= faceHeight ? "horizontal" : "vertical",
      // A moulding runs round the building; a wall field belongs to its own
      // elevation and stops at the arris.
      continuity: cornice ? "wrapping" : "per_face",
      depthBudget: slotDepthBudget(thickness, rule.recessDepth),
      // What the feature asked for, against what this member can spare. The
      // budget is the reason the same request gives a deep pocket on a two
      // metre band and a shallow one on a hand's-width cornice.
      textureScale,
      faceOffset: resolveSlotRelief(
        relief,
        slotDepthBudget(thickness, rule.recessDepth),
      ),
      tags: ["engraving", "exterior", stretch.label, orientation],
      rule,
    });

    return resolved ? [resolved] : [];
  }));
}

/**
 * The elevation a stretch's slots are measured against.
 *
 * A moulding has a patch of its own, so its slots run its own height. A wall
 * does not — it shares the band's facade patch, whose domain spans the whole
 * rise including the moulding above it — so a wall slot's `v` is a fraction of
 * the band, not of the wall. Both ends of that conversion read this, so a slot
 * published in one domain cannot be drawn in the other.
 */
export function slotDomainOf(
  band: ElevationBandRecord,
  stretch: BandStretch,
): { readonly bottomY: number; readonly rise: number } {
  return stretch.label === "cornice"
    ? { bottomY: stretch.bottomY, rise: stretch.topY - stretch.bottomY }
    : { bottomY: band.bottomY, rise: band.topY - band.bottomY };
}

/**
 * The fields a prepared stretch presents, as world elevations.
 *
 * The tessellator needs the field where it will draw it, not where it was
 * published, so this is the one place the published `v` is converted back.
 */
export function preparedFieldsOf(
  band: ElevationBandRecord,
  stretch: BandStretch,
  slots: readonly SlotRecord[],
  frames: readonly FrameRecord[] = [],
): PreparedField[] {
  const domain = slotDomainOf(band, stretch);

  return slots
    .filter((slot) => slot.bandId === stretch.id && slot.face !== "top" && slot.face !== "bottom")
    .map((slot) => {
      // The outline, not the rectangle inside it: the four corners are the
      // stone, and a battered face's field is a trapezoid.
      const [bottomLeft, bottomRight, topRight, topLeft] = slot.boundary;
      const orientation = slot.face as HorizontalOrientation;
      // Whichever patch the slot names is the domain the boundary was measured
      // in: a wall shares the band's facade patch and runs up the rake, while a
      // moulding has a plumb patch of its own on its own outline.
      const cornice = stretch.label === "cornice";
      const base = rectEdge(cornice ? stretch.lower : band.lower, orientation);
      const crown = rectEdge(cornice ? stretch.upper : band.upper, orientation);
      const alongOf = (point: { readonly x: number; readonly z: number }) =>
        orientation === "front" || orientation === "rear" ? point.x : point.z;
      const a0 = alongOf(base.start);
      const span = alongOf(base.end) - a0;
      const rake = alongOf(crown.start) - a0;
      const worldAt = (u: number, v: number) => a0 + span * u + rake * v;
      // The border is drawn on the same flat stone as the field, so the strip
      // laid flat is the field grown back by it.
      const frame = frames.find((candidate) => candidate.id === slot.frameId);
      const faceHeight = cornice
        ? stretch.topY - stretch.bottomY
        : facadeSlopeLength(band, orientation);
      const margin = frame && faceHeight > EPS
        ? (frame.insetV + frame.borderWidth) * domain.rise / faceHeight
        : 0;
      const bottomY = domain.bottomY + bottomLeft!.v * domain.rise;
      const topY = domain.bottomY + topLeft!.v * domain.rise;

      return {
        face: orientation,
        left: [
          worldAt(bottomLeft!.u, bottomLeft!.v),
          worldAt(topLeft!.u, topLeft!.v),
        ] as const,
        right: [
          worldAt(bottomRight!.u, bottomRight!.v),
          worldAt(topRight!.u, topRight!.v),
        ] as const,
        bottomY,
        topY,
        // Read off the slot rather than re-resolved. The resolver already
        // decided what this member could spare, and deciding again here would
        // be a second opinion that could disagree with the record every other
        // consumer reads.
        relief: slot.faceOffset,
        textureScale: slot.textureScale,
        rowBottomY: Math.max(bottomY - margin, stretch.bottomY),
        rowTopY: Math.min(topY + margin, stretch.topY),
      };
    });
}

/** A footing carries base ornament; everything above it carries a field. */
function bandSlotKind(band: ElevationBandRecord): "field" | "base_face" {
  return band.index < 0 ? "base_face" : "field";
}

function bandPart(band: ElevationBandRecord): string {
  if (band.index < 0) {
    return "base";
  }
  return band.walkable ? "body" : "crown";
}

function edgeLength(rect: Rect, orientation: HorizontalOrientation): number {
  const edge = rectEdge(rect, orientation);
  return Math.hypot(edge.end.x - edge.start.x, edge.end.z - edge.start.z);
}

/**
 * The distance `v` covers on a facade patch, which on a battered wall is the
 * rake rather than the rise. Mirrors `createFacadeFrame` exactly, because a slot
 * measured against anything else would not match the surface it names.
 */
function facadeSlopeLength(
  band: ElevationBandRecord,
  orientation: HorizontalOrientation,
): number {
  const base = rectEdge(band.lower, orientation).start;
  const crown = rectEdge(band.upper, orientation).start;
  return Math.hypot(
    crown.x - base.x,
    band.topY - band.bottomY,
    crown.z - base.z,
  );
}

/**
 * The strip of a facade a stair climbs in front of, in that facade's own domain.
 *
 * Shared with the `stair_reserve` region the patch publishes, so the ground a
 * slot refuses and the ground the kernel marks reserved cannot disagree.
 */
export function stairReserveRange(
  lower: Rect,
  orientation: HorizontalOrientation,
  spanU: readonly [number, number],
): readonly [number, number] {
  const edge = rectEdge(lower, orientation);
  const basis = stairBasis(orientation);
  const baseU = edge.start.x * basis.across.x + edge.start.z * basis.across.z;
  const width = Math.hypot(
    edge.end.x - edge.start.x,
    edge.end.z - edge.start.z,
  );

  return [
    Math.max((spanU[0] - baseU) / width, 0),
    Math.min((spanU[1] - baseU) / width, 1),
  ];
}


