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
    d: 0,
    regionId: slot.regionId,
    orientation,
  });
}

/**
 * How much of a structure is prepared for ornament.
 *
 * A named vocabulary rather than a bank of per-surface booleans, for the same
 * reason `CORNICE_PLACEMENTS` is one: which surfaces carry ornament is a
 * composition decision with a small number of sensible answers, not sixteen
 * independent switches.
 */
export const SLOT_PLACEMENTS = ["none", "elevations", "all"] as const;

export type SlotPlacement = (typeof SLOT_PLACEMENTS)[number];

/**
 * What each placement reaches. `elevations` prepares the principal wall faces
 * only — a Mass band's wall, a Pillar Hall pier's panel. `all` adds everything
 * that crowns or encloses them: cornices, summit walls, roof fascias, lintels.
 */
export function placementReaches(
  placement: SlotPlacement,
  surface: "elevation" | "crowning",
): boolean {
  if (placement === "none") {
    return false;
  }
  return placement === "all" || surface === "elevation";
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

export interface FaceSlotInput {
  readonly id: string;
  readonly kind: SlotKind;
  readonly part: string;
  readonly face: Orientation;
  readonly faceRole: string;
  readonly bandId: string | null;
  readonly bayId: string | null;
  readonly patchId: string;
  /** Normalised span of the patch this slot may occupy. */
  readonly uRange: readonly [number, number];
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
  const [uMin, uMax] = input.uRange;
  const [vMin, vMax] = input.vRange;

  if (uMax - uMin <= EPS || vMax - vMin <= EPS) {
    return null;
  }

  // The border is measured against the stone actually available, which on a
  // narrowing face is its top edge — the narrowest the field ever gets.
  const widthAt = (v: number) =>
    input.widthBottom + (input.widthTop - input.widthBottom) * v;
  const hostWidth = (uMax - uMin) * Math.min(widthAt(vMin), widthAt(vMax));
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
  const marginU = frame === null ? 0 : frame.insetU + frame.borderWidth;
  const marginV = frame === null ? 0 : frame.insetV + frame.borderWidth;
  const fieldUMin = uMin + marginU / Math.max(input.widthBottom, EPS);
  const fieldUMax = uMax - marginU / Math.max(input.widthBottom, EPS);
  const fieldVMin = vMin + marginV / Math.max(input.faceHeight, EPS);
  const fieldVMax = vMax - marginV / Math.max(input.faceHeight, EPS);

  if (fieldUMax - fieldUMin <= EPS || fieldVMax - fieldVMin <= EPS) {
    return null;
  }

  const boundary = faceBoundary(
    input.widthBottom,
    input.widthTop,
    fieldUMin,
    fieldUMax,
    fieldVMin,
    fieldVMax,
  );
  const inscribed = inscribedRect(boundary);
  const extent = boundaryExtent(
    input.widthBottom,
    input.widthTop,
    fieldUMin,
    fieldUMax,
    fieldVMin,
    fieldVMax,
    input.faceHeight,
  );

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
    const { inscribed } = slot;
    const corners = [
      [inscribed.uMin, inscribed.vMin],
      [inscribed.uMax, inscribed.vMin],
      [inscribed.uMax, inscribed.vMax],
      [inscribed.uMin, inscribed.vMax],
    ].map(([u, v]) => evaluateFrame(patch.frame, u!, v!, 0));
    const bounds = {
      minX: Math.min(...corners.map((c) => c.x)),
      maxX: Math.max(...corners.map((c) => c.x)),
      minY: Math.min(...corners.map((c) => c.y)),
      maxY: Math.max(...corners.map((c) => c.y)),
      minZ: Math.min(...corners.map((c) => c.z)),
      maxZ: Math.max(...corners.map((c) => c.z)),
    };

    if (match === "whole") {
      builder.assignFaceMaterial(
        (face) => sameBounds(face, bounds),
        "slotDebug",
      );
      continue;
    }

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

/** Whether a face occupies exactly the box a slot resolved to. */
function sameBounds(
  face: readonly { readonly x: number; readonly y: number; readonly z: number }[],
  bounds: {
    readonly minX: number; readonly maxX: number;
    readonly minY: number; readonly maxY: number;
    readonly minZ: number; readonly maxZ: number;
  },
): boolean {
  const xs = face.map((point) => point.x);
  const ys = face.map((point) => point.y);
  const zs = face.map((point) => point.z);

  return Math.abs(Math.min(...xs) - bounds.minX) <= SLOT_TINT_MATCH
    && Math.abs(Math.max(...xs) - bounds.maxX) <= SLOT_TINT_MATCH
    && Math.abs(Math.min(...ys) - bounds.minY) <= SLOT_TINT_MATCH
    && Math.abs(Math.max(...ys) - bounds.maxY) <= SLOT_TINT_MATCH
    && Math.abs(Math.min(...zs) - bounds.minZ) <= SLOT_TINT_MATCH
    && Math.abs(Math.max(...zs) - bounds.maxZ) <= SLOT_TINT_MATCH;
}
