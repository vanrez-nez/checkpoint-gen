import type { SolidBuilder } from "../../geometry/solid-builder";
import { evaluateFrame, type Orientation } from "./frame";
import { structurePath } from "./ids";
import type { Patch, PatchAnchor, PatchRegion } from "./patch";

/**
 * The reserved, addressable rectangle every family publishes for ornament.
 *
 * A slot carries no motif and no style — only where it is, how big it is, and
 * how much depth an ornament may occupy. It is deliberately resolved by the
 * families that shape stone and consumed by systems that have not been written
 * yet: engraving, glyphs, figures and texturing all arrive later and read this
 * table rather than re-deriving geometry from the mesh.
 *
 * A slot has no plane of its own. World placement comes from `patch.frame` via
 * `evaluateFrame`, which is what makes it impossible for a slot to drift from
 * the surface it names. A family that wants to publish a slot must therefore
 * publish a patch for the surface first.
 *
 * This vocabulary was resolved first by the stelae family and lifted here
 * unchanged when Mass and Pillar Hall needed the same contract. Nothing below
 * is stela-specific; the family-facing aliases live in
 * `families/stelae/types.ts`.
 */

const EPS = 1e-9;

export const SLOT_KINDS = [
  "field",
  "ribbon",
  "cartouche",
  "crown_face",
  "base_face",
] as const;

export type SlotKind = (typeof SLOT_KINDS)[number];

export const SLOT_CONDITIONS = ["intact", "partial", "lost"] as const;

export type SlotCondition = (typeof SLOT_CONDITIONS)[number];

/**
 * Below these, a slot has no room for content and is simply not emitted. This
 * is a normal omission and never a validation error: a design that leaves no
 * engravable face is a design decision, not a broken one.
 *
 * Filtering is by linear extent on each axis rather than by area, because a
 * long thin strip and a small square can have the same area and only one of
 * them can carry anything.
 */
export const MIN_FIELD_EXTENT = 0.12;
export const MIN_RIBBON_WIDTH = 0.04;
export const MIN_RIBBON_LENGTH = 0.2;

/** Normalised sub-rectangle of a face's parametric domain. */
export interface UvRect {
  readonly uMin: number;
  readonly uMax: number;
  readonly vMin: number;
  readonly vMax: number;
}

/** One point in a face's parametric domain. */
export interface Uv {
  readonly u: number;
  readonly v: number;
}

/**
 * The border a slot's field sits inside.
 *
 * A frame is not four rails laid on a surface. It is the part of the element
 * that was never cut away, which is why it reads as one continuous piece of
 * stone and why its corners need no welding: there is nothing there to join.
 * `recessDepth` of zero leaves the field coplanar with its border, which is
 * all an engraving needs.
 */
export interface FrameRecord {
  readonly id: string;
  readonly style: string;
  readonly bandId: string | null;
  readonly bayId: string | null;
  readonly faceId: string;
  readonly borderWidth: number;
  /** How far the field sits behind its border. */
  readonly recessDepth: number;
  readonly insetU: number;
  readonly insetV: number;
  readonly returnProfile: string;
}

/**
 * A reserved, addressable rectangle. This is what every ornament-bearing family
 * produces: everything else exists to resolve it.
 *
 * `part` and `faceRole` are open strings for the same reason `PatchRole` is —
 * rules query them rather than switching on a fixed list, and every later phase
 * introduces names this one has never heard of.
 */
export interface SlotRecord {
  readonly id: string;
  readonly kind: SlotKind;
  readonly part: string;
  readonly face: Orientation;
  readonly faceRole: string;
  /**
   * The horizontal division of the elevation this slot belongs to, when it
   * belongs to one. Readers that gate geometry per division — turning stonework
   * off over a prepared face, say — key off this.
   */
  readonly bandId: string | null;
  readonly bayId: string | null;
  readonly frameId: string | null;
  readonly patchId: string;
  readonly regionId: string;
  readonly anchorId: string;
  /**
   * The slot's true outline in its patch's domain, bottom-left first. A patch
   * frame is a parallelogram, so a slot on a narrowing face is a trapezoid here
   * rather than a rectangle; a consumer that can follow the taper uses this.
   */
  readonly boundary: readonly Uv[];
  /**
   * Largest axis-aligned rectangle inside `boundary`. This is what the published
   * patch region carries, and what a consumer needing a rectangle should use.
   */
  readonly inscribed: UvRect;
  /** Metres. `uBottom` and `uTop` differ only on a tapered face. */
  readonly extent: {
    readonly uBottom: number;
    readonly uTop: number;
    readonly v: number;
  };
  readonly aspect: number;
  /**
   * How far this slot's stone stands off the plane its patch describes, in
   * metres along `patch.frame.normal`. Negative is sunk into the member,
   * positive is raised off it, zero is flush and is what most slots are.
   *
   * A slot has no plane of its own — world placement comes from the patch, and
   * that is what stops one drifting from the surface it names. But a face that
   * has been carved into or raised off its member is genuinely somewhere else,
   * and the record has to say so or everything placed from it lands in the
   * wrong place: an engraving in a pocket would float at the uncut plane,
   * present and correct to the millimetre and hanging in front of the stone.
   *
   * Set by whichever resolver actually built the stone, since only it knows.
   * Distinct from `SlotFeatureSpec.standOff`, which is a family saying "this
   * feature's whole stone is an applique laid on the face" — descriptive, one
   * number for every slot the feature resolves, and read from the layout. This
   * is per slot and resolved.
   */
  readonly faceOffset: number;
  readonly depthBudget: {
    readonly relief: number;
    readonly recess: number;
  };
  readonly flow: "horizontal" | "vertical" | "none";
  readonly continuity: "per_face" | "wrapping";
  readonly hierarchy: number;
  readonly condition: SlotCondition;
  readonly tags: readonly string[];
}

/**
 * Resolves the border around a field, or null when the border would consume it.
 *
 * The caps exist so a frame authored in metres stays a frame at every scale: an
 * inset may never take more than a fifth of the face, and a border never more
 * than a quarter of what the inset leaves. Returning null is a normal omission,
 * and the caller keeps its unframed rectangle.
 */
export function resolveSlotFrame(input: {
  readonly id: string;
  readonly style: string;
  readonly bandId: string | null;
  readonly bayId: string | null;
  readonly faceId: string;
  /** Real extents of the face the frame is drawn on, in metres. */
  readonly width: number;
  readonly height: number;
  readonly insetU: number;
  readonly insetV: number;
  readonly borderWidth: number;
  readonly recessDepth: number;
  readonly returnProfile: string;
}): FrameRecord | null {
  const insetU = Math.min(input.insetU, input.width * 0.2);
  const insetV = Math.min(input.insetV, input.height * 0.2);
  const border = Math.min(
    input.borderWidth,
    (input.width - insetU * 2) * 0.24,
    (input.height - insetV * 2) * 0.24,
  );

  if (
    border <= EPS
    || input.width - insetU * 2 <= border * 2 + MIN_FIELD_EXTENT
    || input.height - insetV * 2 <= border * 2 + MIN_FIELD_EXTENT
  ) {
    return null;
  }

  return {
    id: input.id,
    style: input.style,
    bandId: input.bandId,
    bayId: input.bayId,
    faceId: input.faceId,
    borderWidth: border,
    recessDepth: input.recessDepth,
    insetU,
    insetV,
    returnProfile: input.returnProfile,
  };
}

/**
 * Where one vertical edge of a field came from, and therefore how it leans.
 *
 * A battered facade's patch domain is sheared: the left arris is `u = 0` and
 * the right one closes in as `v` rises, so every line on the face is affine in
 * `v` and there are exactly two rules for which line to draw.
 *
 * `arris` keeps a constant fraction of the face's real width, so the edge runs
 * parallel to the stone's own arris — right for an edge inherited from the face
 * itself. `plumb` holds a constant world position, so the edge is vertical —
 * right for an edge cut by something that is itself vertical, like the flank of
 * a stair. The two rules coincide only at the face's centre-line.
 */
export type FaceEdgeRule = "arris" | "plumb";

export interface FaceEdgeSource {
  /** Where the edge sits in the domain measured at the face's base. */
  readonly at: number;
  readonly rule: FaceEdgeRule;
}

/** One edge as `u` at `v = 0` and at `v = 1`; every such edge is affine. */
export type FaceEdgeLine = readonly [number, number];

export function faceEdgeLine(
  source: FaceEdgeSource,
  widthBottom: number,
  widthTop: number,
): FaceEdgeLine {
  const taper = widthBottom <= EPS ? 1 : widthTop / widthBottom;

  return source.rule === "arris"
    // A constant fraction of the width: the edge closes in with the face.
    ? [source.at, source.at * taper]
    // A constant world position: the face slides inward beneath a fixed line.
    : [source.at, source.at - (1 - taper) / 2];
}

/**
 * A plain span, both of whose edges belong to the face itself.
 *
 * On a plumb face the two rules are identical, so every family whose surfaces
 * do not lean says what it means with this rather than choosing between them.
 */
export function arrisEdges(
  span: readonly [number, number],
): readonly [FaceEdgeSource, FaceEdgeSource] {
  return [{ at: span[0], rule: "arris" }, { at: span[1], rule: "arris" }];
}

/**
 * `source` with `cover` removed, as the zero, one or two spans that remain.
 *
 * The edges the cut introduces are plumb, because what cut them is: a stair's
 * flank is a vertical plane at a fixed world position, whatever the wall behind
 * it is doing. The edges inherited from `source` keep whatever rule they had.
 */
export function withoutRange(
  source: readonly [FaceEdgeSource, FaceEdgeSource],
  cover: readonly [number, number],
): (readonly [FaceEdgeSource, FaceEdgeSource])[] {
  const [from, to] = source;
  const [coverFrom, coverTo] = cover;

  if (coverTo <= from.at + EPS || coverFrom >= to.at - EPS) {
    return [source];
  }

  const cutLow: FaceEdgeSource = {
    at: Math.min(coverFrom, to.at),
    rule: "plumb",
  };
  const cutHigh: FaceEdgeSource = {
    at: Math.max(coverTo, from.at),
    rule: "plumb",
  };

  return [
    [from, cutLow] as const,
    [cutHigh, to] as const,
  ].filter((span) => span[1].at - span[0].at > EPS);
}

/** The outline two edges enclose between two heights, bottom-left first. */
export function edgeBoundary(
  left: FaceEdgeLine,
  right: FaceEdgeLine,
  vMin: number,
  vMax: number,
): Uv[] {
  const at = (line: FaceEdgeLine, v: number) => line[0] + (line[1] - line[0]) * v;

  return [
    { u: at(left, vMin), v: vMin },
    { u: at(right, vMin), v: vMin },
    { u: at(right, vMax), v: vMax },
    { u: at(left, vMax), v: vMax },
  ];
}

/**
 * A slot's true outline in the patch domain.
 *
 * The patch frame is a parallelogram — the same frame every battered facade in
 * this project uses — so a slot that keeps a constant fraction of a narrowing
 * face is a trapezoid here, not a rectangle. Publishing the real corners is
 * what lets a consumer follow the taper instead of overrunning the stone.
 */
export function faceBoundary(
  widthBottom: number,
  widthTop: number,
  uMin: number,
  uMax: number,
  vMin: number,
  vMax: number,
): Uv[] {
  const scaleAt = (v: number) =>
    (widthBottom + (widthTop - widthBottom) * v) / widthBottom;
  const low = scaleAt(vMin);
  const high = scaleAt(vMax);
  return [
    { u: uMin * low, v: vMin },
    { u: uMax * low, v: vMin },
    { u: uMax * high, v: vMax },
    { u: uMin * high, v: vMax },
  ];
}

/** The whole parametric domain, for a face that does not taper. */
export function unitBoundary(): Uv[] {
  return [
    { u: 0, v: 0 },
    { u: 1, v: 0 },
    { u: 1, v: 1 },
    { u: 0, v: 1 },
  ];
}

/** Largest axis-aligned rectangle inside a boundary whose edges converge. */
export function inscribedRect(boundary: readonly Uv[]): UvRect {
  const us = boundary.map((point) => point.u);
  const vs = boundary.map((point) => point.v);
  const [bottomLeft, bottomRight, topRight, topLeft] = boundary;
  if (!bottomLeft || !bottomRight || !topRight || !topLeft) {
    return {
      uMin: Math.min(...us),
      uMax: Math.max(...us),
      vMin: Math.min(...vs),
      vMax: Math.max(...vs),
    };
  }
  return {
    uMin: Math.max(bottomLeft.u, topLeft.u),
    uMax: Math.min(bottomRight.u, topRight.u),
    vMin: Math.min(bottomLeft.v, bottomRight.v),
    vMax: Math.max(topLeft.v, topRight.v),
  };
}

/** The real metres a normalised span covers on a face that may taper. */
export function boundaryExtent(
  widthBottom: number,
  widthTop: number,
  uMin: number,
  uMax: number,
  vMin: number,
  vMax: number,
  faceHeight: number,
): { readonly uBottom: number; readonly uTop: number; readonly v: number } {
  const widthAt = (v: number) => widthBottom + (widthTop - widthBottom) * v;
  return {
    uBottom: (uMax - uMin) * widthAt(vMin),
    uTop: (uMax - uMin) * widthAt(vMax),
    v: (vMax - vMin) * faceHeight,
  };
}

export function aspectOf(
  inscribed: UvRect,
  widthBottom: number,
  faceHeight: number,
): number {
  const width = (inscribed.uMax - inscribed.uMin) * widthBottom;
  const height = (inscribed.vMax - inscribed.vMin) * faceHeight;
  return height <= EPS ? 0 : width / height;
}

/**
 * A slot reaches the kernel as a reservation: an empty operation list is the
 * kernel's existing "nothing may target this yet" state, which is exactly what
 * a slot is until an ornament system claims it.
 */
export function slotRegion(slot: SlotRecord): PatchRegion {
  return {
    id: slot.regionId,
    uRange: [slot.inscribed.uMin, slot.inscribed.uMax],
    vRange: [slot.inscribed.vMin, slot.inscribed.vMax],
    priority: slot.hierarchy,
    allowedOperations: [],
    exclusions: [],
    tags: [...slot.tags, slot.kind, `condition_${slot.condition}`],
  };
}

/**
 * Republishes patches with the reservations their slots imply.
 *
 * A slot is only addressable if the patch it names says so, so this is how a
 * family gets from "I resolved a table" to "the kernel knows this ground is
 * spoken for". Patches without slots come back untouched.
 */
export function withSlotReservations(
  patches: readonly Patch[],
  slots: readonly SlotRecord[],
): Patch[] {
  const byPatch = new Map<string, SlotRecord[]>();
  for (const slot of slots) {
    const existing = byPatch.get(slot.patchId);
    if (existing) {
      existing.push(slot);
    } else {
      byPatch.set(slot.patchId, [slot]);
    }
  }

  return patches.map((patch) => {
    const owned = byPatch.get(patch.id);

    if (!owned || owned.length === 0) {
      return patch;
    }

    return {
      ...patch,
      regions: [...patch.regions, ...owned.map(slotRegion)],
      anchors: [...patch.anchors, ...owned.map((slot) => slotAnchor(slot.face)(slot))],
    };
  });
}

export function slotAnchor(orientation: Orientation) {
  return (slot: SlotRecord): PatchAnchor => ({
    id: slot.anchorId,
    kind: "ornament",
    u: (slot.inscribed.uMin + slot.inscribed.uMax) / 2,
    v: (slot.inscribed.vMin + slot.inscribed.vMax) / 2,
    // On the stone, which is not always the patch plane. Anything that attaches
    // here — a prop, a figure, an inlay — has to land on the face that was
    // actually built rather than the one the patch describes.
    d: slot.faceOffset,
    regionId: slot.regionId,
    orientation,
  });
}

/**
 * What one feature of a structure asks of its own engravable faces.
 *
 * Settings belong to the feature, not to the family. A band wall wants a large
 * field, a cornice wants a running strip, and a pier panel is already framed by
 * its rails — one border figure covering all three would be a border figure
 * that suits none of them. Every slot-bearing feature therefore carries its own
 * copy of this, generated as its own control folder.
 */
export interface SlotFeatureConfig {
  enabled: boolean;
  borderWidth: number;
  insetU: number;
  insetV: number;
  /**
   * How far this feature's prepared faces leave the plane of their member, in
   * metres. Negative sinks a pocket into it, positive raises a panel off it.
   *
   * Requested rather than granted: what a slot actually gets is clamped by the
   * stone available behind it, and by whether its family says the host can take
   * a pocket at all. See `resolveSlotRelief`.
   */
  relief: number;
}

/** A feature that is switched off, for a family that has not authored one. */
export const DISABLED_SLOT_FEATURE: SlotFeatureConfig = {
  enabled: false,
  borderWidth: 0,
  insetU: 0,
  insetV: 0,
  relief: 0,
};

/** Which directions a family's host can take a prepared face moving in. */
export interface SlotRelief {
  readonly sink: boolean;
  readonly raise: boolean;
}

/**
 * The deepest a prepared face may be sunk or raised, in metres.
 *
 * A judgement rather than a derivation, and the thing it is judging is the
 * batter. A face displaces along its patch's normal, which on a raked wall is
 * horizontal while the stone leans — so a pocket's returns meet its floor at
 * ninety degrees less the batter angle rather than square. That angle is fixed
 * by the wall and no depth changes it; what depth changes is how much of the
 * lean is on show. Fifteen centimetres is deep enough to read as carved and
 * shallow enough that a thirty-five degree face does not put a visibly
 * parallelogram pocket on the elevation.
 */
export const MAX_SLOT_RELIEF = 0.15;

/**
 * What a slot's face actually gets, from what its feature asked for.
 *
 * Sinking is bounded by `depthBudget.recess` — the stone that must survive
 * behind a carved field — because it removes material. Raising is not, because
 * it adds: nothing behind the face is at risk, and the only bound is how far a
 * panel can stand proud before it stops reading as part of the wall.
 *
 * Direction is not checked here. A feature whose host cannot take a pocket has
 * no relief control at all — `slotFeatureControls` ranges the slider by what
 * the family declared, so a raise-only feature cannot hold a negative value to
 * begin with, and validation rejects one that somehow does. Re-deciding it here
 * would be a second opinion on a question already answered.
 */
export function resolveSlotRelief(
  requested: number,
  budget: SlotRecord["depthBudget"],
): number {
  if (!Number.isFinite(requested) || requested === 0) {
    return 0;
  }

  const granted = requested < 0
    ? -Math.min(-requested, Math.max(budget.recess, 0), MAX_SLOT_RELIEF)
    : Math.min(requested, MAX_SLOT_RELIEF);

  // Negating a clamp to nothing gives negative zero, which is flush by every
  // arithmetic that reads it and a diff against a plain zero in the fixtures
  // that record it. `serializeGraph` already normalises it on the way out; not
  // producing it in the first place is better.
  return granted === 0 ? 0 : granted;
}

/**
 * Stone that must survive behind a carved field. An ornament may sink as far
 * as the frame's own recess and no further into the member carrying it.
 */
const SLOT_RECESS_RATIO = 0.25;

export function slotDepthBudget(
  memberThickness: number,
  recessDepth: number,
): { readonly relief: number; readonly recess: number } {
  return {
    relief: Math.max(recessDepth, 0),
    recess: Math.max(memberThickness, 0) * SLOT_RECESS_RATIO,
  };
}

/** The border a family wants drawn around every field it prepares. */
export interface SlotRule {
  readonly style: string;
  readonly insetU: number;
  readonly insetV: number;
  readonly borderWidth: number;
  readonly recessDepth: number;
}

/** A frame that resolves to nothing costs nothing; the field takes the face. */
export const NO_SLOT_RULE: SlotRule = {
  style: "plain_field",
  insetU: 0,
  insetV: 0,
  borderWidth: 0,
  recessDepth: 0,
};

/**
 * The authored feature settings as a resolution rule.
 *
 * `style` and `recessDepth` stay with the family because they describe the
 * recess rather than the border: only the stelae family carves one, and it
 * chooses one style for the whole monument.
 */
export function slotRuleOf(
  feature: SlotFeatureConfig,
  recess: { readonly style: string; readonly recessDepth: number } = {
    style: "plain_field",
    recessDepth: 0,
  },
): SlotRule {
  return {
    style: recess.style,
    insetU: feature.insetU,
    insetV: feature.insetV,
    borderWidth: feature.borderWidth,
    recessDepth: recess.recessDepth,
  };
}

export interface FaceSlotInput {
  readonly id: string;
  readonly kind: SlotKind;
  readonly part: string;
  readonly face: Orientation;
  readonly faceRole: string;
  readonly bandId: string | null;
  readonly bayId: string | null;
  readonly patchId: string;
  /**
   * The two vertical edges bounding the span this slot may occupy, each saying
   * where it came from so it can be drawn leaning the right way.
   */
  readonly uEdges: readonly [FaceEdgeSource, FaceEdgeSource];
  readonly vRange: readonly [number, number];
  /** Real width of the whole patch at `v = 0` and `v = 1`; equal when plumb. */
  readonly widthBottom: number;
  readonly widthTop: number;
  /** Real height of the whole patch, measured up its own plane. */
  readonly faceHeight: number;
  readonly hierarchy: number;
  readonly flow: SlotRecord["flow"];
  readonly continuity: SlotRecord["continuity"];
  readonly depthBudget: SlotRecord["depthBudget"];
  /** Omitted where the prepared face sits in the member's own plane. */
  readonly faceOffset?: number;
  readonly tags: readonly string[];
  readonly rule: SlotRule;
}

export interface ResolvedFaceSlot {
  readonly slot: SlotRecord;
  readonly frame: FrameRecord | null;
}

/**
 * Prepares one rectangle of one patch as an ornament slot.
 *
 * This is the single road every family takes to a slot, so a field on a Mass
 * band, a Pillar Hall lintel and a stela register are all measured, framed and
 * rejected by the same rules. Returns null when the field would be too small to
 * carry anything after its border — a normal omission, never an error.
 *
 * `uRange` and `vRange` are how a caller says "not the whole face": a band
 * splits its `u` around the stair that climbs it, and clips its `v` where a
 * cornice takes over the top.
 */
export function resolveFaceSlot(input: FaceSlotInput): ResolvedFaceSlot | null {
  const [leftSource, rightSource] = input.uEdges;
  const [vMin, vMax] = input.vRange;

  if (rightSource.at - leftSource.at <= EPS || vMax - vMin <= EPS) {
    return null;
  }

  const left = faceEdgeLine(leftSource, input.widthBottom, input.widthTop);
  const right = faceEdgeLine(rightSource, input.widthBottom, input.widthTop);
  // The border is measured against the stone actually available, which on a
  // narrowing face is its top edge — the narrowest the field ever gets.
  const spanAt = (v: number) =>
    (right[0] + (right[1] - right[0]) * v) - (left[0] + (left[1] - left[0]) * v);
  const hostWidth = Math.min(spanAt(vMin), spanAt(vMax)) * input.widthBottom;
  const hostHeight = (vMax - vMin) * input.faceHeight;

  const frame = resolveSlotFrame({
    id: structurePath(input.id, "frame"),
    style: input.rule.style,
    bandId: input.bandId,
    bayId: input.bayId,
    faceId: input.patchId,
    width: hostWidth,
    height: hostHeight,
    insetU: input.rule.insetU,
    insetV: input.rule.insetV,
    borderWidth: input.rule.borderWidth,
    recessDepth: input.rule.recessDepth,
    returnProfile: "square",
  });

  // Without a frame the field is the whole rectangle. With one it retreats by
  // the inset and the border together, which is the stone the border occupies.
  // The border is authored in metres, and a constant offset in `u` is a
  // constant offset in metres at every height, so both ends of an edge shift by
  // the same amount and the edge keeps its lean.
  const frameSet = frame !== null;
  const marginU = frameSet ? (frame.insetU + frame.borderWidth) : 0;
  const marginV = frameSet ? (frame.insetV + frame.borderWidth) : 0;
  const shift = marginU / Math.max(input.widthBottom, EPS);
  const fieldLeft: FaceEdgeLine = [left[0] + shift, left[1] + shift];
  const fieldRight: FaceEdgeLine = [right[0] - shift, right[1] - shift];
  const fieldVMin = vMin + marginV / Math.max(input.faceHeight, EPS);
  const fieldVMax = vMax - marginV / Math.max(input.faceHeight, EPS);

  if (
    fieldRight[0] - fieldLeft[0] <= EPS
    || fieldRight[1] - fieldLeft[1] <= EPS
    || fieldVMax - fieldVMin <= EPS
  ) {
    return null;
  }

  const boundary = edgeBoundary(fieldLeft, fieldRight, fieldVMin, fieldVMax);
  const inscribed = inscribedRect(boundary);
  const spanAtField = (v: number) =>
    (fieldRight[0] + (fieldRight[1] - fieldRight[0]) * v)
    - (fieldLeft[0] + (fieldLeft[1] - fieldLeft[0]) * v);
  const extent = {
    uBottom: spanAtField(fieldVMin) * input.widthBottom,
    uTop: spanAtField(fieldVMax) * input.widthBottom,
    v: (fieldVMax - fieldVMin) * input.faceHeight,
  };

  // A narrowing face's domain is a trapezoid anchored at `u = 0`, so a field far
  // enough to the right can run off the stone before it reaches the top. There
  // is then no rectangle inside the outline at all, and the inscribed bounds
  // invert. That is a normal omission — the stone simply is not there.
  if (
    inscribed.uMax - inscribed.uMin <= EPS
    || inscribed.vMax - inscribed.vMin <= EPS
  ) {
    return null;
  }

  // Judged on the rectangle actually reserved rather than on the outline around
  // it, because the region a consumer receives is the rectangle.
  const usable = {
    uBottom: (inscribed.uMax - inscribed.uMin) * input.widthBottom,
    uTop: (inscribed.uMax - inscribed.uMin) * input.widthBottom,
    v: (inscribed.vMax - inscribed.vMin) * input.faceHeight,
  };

  if (!fieldIsUsable(input.kind, usable)) {
    return null;
  }

  return {
    frame,
    slot: {
      id: input.id,
      kind: input.kind,
      part: input.part,
      face: input.face,
      faceRole: input.faceRole,
      bandId: input.bandId,
      bayId: input.bayId,
      frameId: frame?.id ?? null,
      patchId: input.patchId,
      regionId: structurePath(input.id, "region"),
      anchorId: structurePath(input.id, "anchor"),
      boundary,
      inscribed,
      extent,
      aspect: aspectOf(inscribed, input.widthBottom, input.faceHeight),
      // Flush by default. Every family that reaches this road draws its
      // prepared face in the plane of the member, so the only slots that are
      // anywhere else are the ones whose resolver says so.
      faceOffset: input.faceOffset ?? 0,
      depthBudget: input.depthBudget,
      flow: input.flow,
      continuity: input.continuity,
      hierarchy: input.hierarchy,
      condition: "intact",
      tags: input.tags,
    },
  };
}

/**
 * Whether a field has room for content.
 *
 * A ribbon is judged on two different axes from a field: it is allowed to be
 * thin, because a frieze is, but it must still run far enough to read as one.
 */
function fieldIsUsable(
  kind: SlotKind,
  extent: { readonly uBottom: number; readonly uTop: number; readonly v: number },
): boolean {
  const running = Math.min(extent.uBottom, extent.uTop);

  if (kind === "ribbon") {
    return running >= MIN_RIBBON_LENGTH && extent.v >= MIN_RIBBON_WIDTH;
  }

  return running >= MIN_FIELD_EXTENT && extent.v >= MIN_FIELD_EXTENT;
}

/**
 * How far a face corner may sit outside a slot's world box and still count as
 * part of it. Displacement moves a laid stone's arris by a few millimetres.
 */
const SLOT_TINT_TOLERANCE = 0.05;

/** How closely a whole face has to agree with its slot to be that slot. */
const SLOT_TINT_MATCH = 1e-3;

/**
 * How a family's geometry answers to its slots.
 *
 * `whole` is for a family that draws each field as one quad — the Mass and the
 * Pillar Hall both split a prepared elevation into its border and its field —
 * so a slot is matched to the single face that *is* it. `fragments` is for one
 * whose field is a recess made of many small faces, as a stela's pocket is;
 * there the test is containment.
 *
 * The distinction earns its keep: containment alone repaints a border thinner
 * than the tolerance, which is exactly what a small pier panel has.
 */
export type SlotTintMatch = "whole" | "fragments";

/**
 * Repaints the geometry each published slot reserves.
 *
 * The slot table is a family's product and is otherwise invisible, so this is
 * the only way to check by eye that what was reserved is what got prepared. It
 * reclassifies faces and changes no topology.
 */
export function tintSlots(
  builder: SolidBuilder,
  slots: readonly SlotRecord[],
  patches: ReadonlyMap<string, Patch>,
  match: SlotTintMatch = "fragments",
): void {
  for (const slot of slots) {
    const patch = patches.get(slot.patchId);
    if (!patch || slot.condition === "lost") {
      continue;
    }
    // The outline, not the rectangle inside it: on a leaning face the two are
    // different shapes, and it is the outline that was drawn. And at the depth
    // the face was drawn at — a `whole` match compares corners to the
    // millimetre, so a sunk face compared against the patch plane would match
    // nothing and the tint would silently paint an empty set.
    const corners = slot.boundary.map(
      (point) => evaluateFrame(patch.frame, point.u, point.v, slot.faceOffset),
    );
    if (match === "whole") {
      builder.assignFaceMaterial(
        (face) => sameCorners(face, corners),
        "slotDebug",
      );
      continue;
    }

    const bounds = {
      minX: Math.min(...corners.map((c) => c.x)),
      maxX: Math.max(...corners.map((c) => c.x)),
      minY: Math.min(...corners.map((c) => c.y)),
      maxY: Math.max(...corners.map((c) => c.y)),
      minZ: Math.min(...corners.map((c) => c.z)),
      maxZ: Math.max(...corners.map((c) => c.z)),
    };
    const box = {
      minX: bounds.minX - SLOT_TINT_TOLERANCE,
      maxX: bounds.maxX + SLOT_TINT_TOLERANCE,
      minY: bounds.minY - SLOT_TINT_TOLERANCE,
      maxY: bounds.maxY + SLOT_TINT_TOLERANCE,
      minZ: bounds.minZ - SLOT_TINT_TOLERANCE,
      maxZ: bounds.maxZ + SLOT_TINT_TOLERANCE,
    };
    builder.assignFaceMaterial(
      (face) => face.every((point) =>
        point.x >= box.minX && point.x <= box.maxX
        && point.y >= box.minY && point.y <= box.maxY
        && point.z >= box.minZ && point.z <= box.maxZ),
      "slotDebug",
    );
  }
}

/**
 * Whether a face is the slot, corner for corner.
 *
 * Stronger than comparing bounding boxes, and it has to be: a leaning field and
 * the upright rectangle around it share a box but are not the same stone. The
 * comparison is order-independent because the builder is free to wind a quad
 * either way.
 */
function sameCorners(
  face: readonly { readonly x: number; readonly y: number; readonly z: number }[],
  corners: readonly { readonly x: number; readonly y: number; readonly z: number }[],
): boolean {
  if (face.length !== corners.length) {
    return false;
  }

  const near = (
    a: { readonly x: number; readonly y: number; readonly z: number },
    b: { readonly x: number; readonly y: number; readonly z: number },
  ) => Math.abs(a.x - b.x) <= SLOT_TINT_MATCH
    && Math.abs(a.y - b.y) <= SLOT_TINT_MATCH
    && Math.abs(a.z - b.z) <= SLOT_TINT_MATCH;

  return corners.every((corner) => face.some((point) => near(point, corner)))
    && face.every((point) => corners.some((corner) => near(point, corner)));
}
