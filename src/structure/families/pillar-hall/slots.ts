import {
  HORIZONTAL_ORIENTATIONS,
  createFacadeFrame,
  rectDepth,
  rectEdge,
  rectWidth,
  type HorizontalOrientation,
  type Rect,
} from "../../kernel/frame";
import { structurePath } from "../../kernel/ids";
import { PATCH_ROLES, type Patch } from "../../kernel/patch";
import {
  NO_SLOT_RULE,
  placementReaches,
  resolveFaceSlot,
  slotDepthBudget,
  withSlotReservations,
  type FrameRecord,
  type SlotKind,
  type SlotPlacement,
  type SlotRecord,
  type SlotRule,
} from "../../kernel/slot";
import type {
  PillarHallMemberRecord,
  PillarHallRecord,
  PillarHallRoofRecord,
  PillarPanelRecord,
} from "./types";

/**
 * The engravable fields a Pillar Hall presents.
 *
 * Nothing here has to be gated. Every piece of this family is an axis-aligned
 * box drawn whole — `buildPillarHall` ignores the masonry rule outright — so a
 * hall's elevations are already the planes an engraving needs. What was missing
 * was addressability: the family published no patches at all, so there was
 * nowhere for a slot to live. It publishes them now, which also means the patch
 * debug overlay finally has something to draw for a hall.
 *
 * The pier panel is the case this family was already halfway to. Four raised
 * rails leave the pier face visible behind them, and that visible face is a
 * prepared field in everything but name — so its slot takes the rails as its
 * frame rather than imposing a second one inside them.
 */

const EPS = 1e-9;

const ORIENTATION_SEGMENT: Readonly<Record<HorizontalOrientation, string>> = {
  front: "front",
  rear: "rear",
  sidePositiveU: "side_positive_u",
  sideNegativeU: "side_negative_u",
};

/**
 * The pier face a panel's rails enclose.
 *
 * Shared with `buildPanelFrame`, which lays the rails around exactly this
 * rectangle. Two copies of the clamp would drift the moment either was tuned,
 * and the drift would put an engraving under a rail.
 */
export interface PanelFrame {
  /** The face's own plane, on the axis the orientation faces along. */
  readonly plane: number;
  readonly uMin: number;
  readonly uMax: number;
  readonly bottomY: number;
  readonly topY: number;
  readonly border: number;
}

export function panelFrameOf(panel: PillarPanelRecord): PanelFrame | null {
  const face = panelFace(panel);
  const uMin = face.uMin + panel.insetU;
  const uMax = face.uMax - panel.insetU;
  const bottomY = panel.bottomY + panel.insetV;
  const topY = panel.topY - panel.insetV;
  const border = Math.min(
    panel.borderWidth,
    (uMax - uMin) * 0.22,
    (topY - bottomY) * 0.22,
  );

  if (uMax - uMin <= border * 2 || topY - bottomY <= border * 2) {
    return null;
  }

  return { plane: face.plane, uMin, uMax, bottomY, topY, border };
}

function panelFace(
  panel: PillarPanelRecord,
): { readonly plane: number; readonly uMin: number; readonly uMax: number } {
  const rect = panel.supportFootprint;
  switch (panel.orientation) {
    case "front":
      return { plane: rect.maxZ, uMin: rect.minX, uMax: rect.maxX };
    case "rear":
      return { plane: rect.minZ, uMin: rect.minX, uMax: rect.maxX };
    case "sidePositiveU":
      return { plane: rect.maxX, uMin: rect.minZ, uMax: rect.maxZ };
    case "sideNegativeU":
      return { plane: rect.minX, uMin: rect.minZ, uMax: rect.maxZ };
  }
}

/** The panel field as a plan rectangle of zero depth on its own face. */
function panelFieldRect(
  orientation: HorizontalOrientation,
  frame: PanelFrame,
): Rect {
  const from = frame.uMin + frame.border;
  const to = frame.uMax - frame.border;

  switch (orientation) {
    case "front":
      return { minX: from, maxX: to, minZ: frame.plane, maxZ: frame.plane };
    case "rear":
      return { minX: from, maxX: to, minZ: frame.plane, maxZ: frame.plane };
    case "sidePositiveU":
      return { minX: frame.plane, maxX: frame.plane, minZ: from, maxZ: to };
    case "sideNegativeU":
      return { minX: frame.plane, maxX: frame.plane, minZ: from, maxZ: to };
  }
}

export interface PillarHallSlotInput {
  readonly hall: PillarHallRecord;
  readonly placement: SlotPlacement;
  readonly rule: SlotRule;
}

/**
 * Every elevation this hall could give away, whether or not it does.
 *
 * The resolver filters this by placement and the builder joins it back against
 * the published table, so the rectangle a slot was measured on is the rectangle
 * the border is drawn around. Deriving it twice from the record was how the two
 * would have drifted.
 */
export function hallFaces(
  hall: PillarHallRecord,
  rule: SlotRule,
): SlotFace[] {
  const faces: SlotFace[] = [];

  for (const support of hall.supports) {
    for (const panel of support.panels) {
      const frame = panelFrameOf(panel);

      if (!frame) {
        continue;
      }

      faces.push({
        id: structurePath(panel.id, "field"),
        role: PATCH_ROLES.pierPanel,
        orientation: panel.orientation,
        rect: panelFieldRect(panel.orientation, frame),
        bottomY: frame.bottomY + frame.border,
        topY: frame.topY - frame.border,
        kind: "field",
        part: panel.section,
        hierarchy: 30,
        thickness: panel.depth,
        surface: "elevation",
        host: panel.supportFootprint,
        // The rails are the border. Framing the stone they already enclose
        // would be a second border inside the first.
        rule: NO_SLOT_RULE,
      });
    }
  }

  for (const member of hall.members) {
    faces.push(...memberFaces(member, rule));
  }

  if (hall.roof) {
    faces.push(
      ...roofFaces(structurePath(hall.id, "roof"), hall.roof, rule),
    );
  }

  // Stone pressed against another member is not an elevation. A lintel's ends
  // meet the lintels of the bays either side, and reserving a field there would
  // publish a rectangle the builder is right never to draw. A face only partly
  // covered is refused too: the builder splits it around whatever presses on
  // it, and a field spanning two of those pieces belongs to neither.
  const occluders = hallOccluders(hall);
  return faces.filter((face) => !faceIsObstructed(face, occluders));
}

interface HallOccluder {
  readonly rect: Rect;
  readonly bottomY: number;
  readonly topY: number;
}

/** Every solid this hall is made of, as the volumes that can hide a face. */
function hallOccluders(hall: PillarHallRecord): HallOccluder[] {
  return [
    ...hall.supports.flatMap((support) =>
      support.sections.map((section) => ({
        rect: section.footprint,
        bottomY: section.bottomY,
        topY: section.topY,
      }))),
    ...hall.members.map((member) => ({
      rect: member.rect,
      bottomY: member.bottomY,
      topY: member.topY,
    })),
    ...(hall.roof
      ? [{
        rect: hall.roof.footprint,
        bottomY: hall.roof.bottomY,
        topY: hall.roof.topY,
      }]
      : []),
  ];
}

/**
 * Whether anything stands against the outside of this face.
 *
 * Mirrors the probe `addExposedVertical` uses to decide what to draw, so a face
 * this rejects is exactly a face the builder does not emit whole.
 */
function faceIsObstructed(
  face: SlotFace,
  occluders: readonly HallOccluder[],
): boolean {
  const host = face.host;

  if (!host) {
    return false;
  }

  const probe = 1e-5;
  const alongZ = face.orientation === "sidePositiveU"
    || face.orientation === "sideNegativeU";
  const outside = face.orientation === "front"
    ? { axis: "z" as const, at: host.maxZ + probe }
    : face.orientation === "rear"
      ? { axis: "z" as const, at: host.minZ - probe }
      : face.orientation === "sidePositiveU"
        ? { axis: "x" as const, at: host.maxX + probe }
        : { axis: "x" as const, at: host.minX - probe };
  const span = alongZ
    ? [host.minZ, host.maxZ] as const
    : [host.minX, host.maxX] as const;

  return occluders.some((candidate) => {
    if (candidate.rect === host) {
      return false;
    }

    const reaches = outside.axis === "z"
      ? outside.at >= candidate.rect.minZ - EPS
        && outside.at <= candidate.rect.maxZ + EPS
      : outside.at >= candidate.rect.minX - EPS
        && outside.at <= candidate.rect.maxX + EPS;

    if (!reaches) {
      return false;
    }

    const candidateSpan = alongZ
      ? [candidate.rect.minZ, candidate.rect.maxZ] as const
      : [candidate.rect.minX, candidate.rect.maxX] as const;

    return candidateSpan[0] < span[1] - EPS
      && candidateSpan[1] > span[0] + EPS
      && candidate.bottomY < face.topY - EPS
      && candidate.topY > face.bottomY + EPS;
  });
}

/**
 * Each published field as a world-space rectangle on its own face.
 *
 * The builder works in plan coordinates and elevations, not in a patch domain,
 * so this is where the published `inscribed` rectangle is converted back — once,
 * from the same face list the resolver measured against.
 */
export function preparedHallFields(
  hall: PillarHallRecord,
): PreparedHallField[] {
  const bySlotPatch = new Map(hall.slots.map((slot) => [slot.patchId, slot]));
  const prepared: PreparedHallField[] = [];

  for (const face of hallFaces(hall, NO_SLOT_RULE)) {
    const slot = bySlotPatch.get(face.id);

    if (!slot || !face.host) {
      continue;
    }

    const edge = rectEdge(face.rect, face.orientation);
    const along = face.orientation === "front" || face.orientation === "rear"
      ? [edge.start.x, edge.end.x] as const
      : [edge.start.z, edge.end.z] as const;
    const at = (u: number) => along[0] + (along[1] - along[0]) * u;
    const first = at(slot.inscribed.uMin);
    const second = at(slot.inscribed.uMax);
    const height = face.topY - face.bottomY;

    prepared.push({
      faceId: face.id,
      orientation: face.orientation,
      host: face.host,
      bottomY: face.bottomY,
      topY: face.topY,
      minU: Math.min(first, second),
      maxU: Math.max(first, second),
      minV: face.bottomY + slot.inscribed.vMin * height,
      maxV: face.bottomY + slot.inscribed.vMax * height,
    });
  }

  return prepared;
}

/** One published field, in the coordinates the builder draws in. */
export interface PreparedHallField {
  readonly faceId: string;
  readonly orientation: HorizontalOrientation;
  /** The volume this face belongs to, which is how the builder recognises it. */
  readonly host: Rect;
  readonly bottomY: number;
  readonly topY: number;
  /** Along the face: world X for a front or rear face, world Z otherwise. */
  readonly minU: number;
  readonly maxU: number;
  readonly minV: number;
  readonly maxV: number;
}

export interface ResolvedPillarHallSlots {
  readonly frames: readonly FrameRecord[];
  readonly slots: readonly SlotRecord[];
  readonly patches: readonly Patch[];
}

export function resolvePillarHallSlots(
  input: PillarHallSlotInput,
): ResolvedPillarHallSlots {
  const frames: FrameRecord[] = [];
  const slots: SlotRecord[] = [];
  const patches: Patch[] = [];

  if (input.placement === "none") {
    return { frames, slots, patches };
  }

  const emit = (face: SlotFace) => {
    const patch = facePatch(face);

    if (!patch) {
      return;
    }

    const resolved = resolveFaceSlot({
      id: structurePath(patch.id, "slot"),
      kind: face.kind,
      part: face.part,
      face: face.orientation,
      faceRole: face.role,
      bandId: null,
      bayId: null,
      patchId: patch.id,
      uRange: [0, 1],
      vRange: [0, 1],
      widthBottom: patch.dimensions.u,
      widthTop: patch.dimensions.u,
      faceHeight: patch.dimensions.v,
      hierarchy: face.hierarchy,
      flow: patch.dimensions.u >= patch.dimensions.v ? "horizontal" : "vertical",
      continuity: "per_face",
      depthBudget: slotDepthBudget(face.thickness, face.rule.recessDepth),
      tags: ["engraving", "exterior", face.role, face.orientation],
      rule: face.rule,
    });

    if (!resolved) {
      return;
    }

    patches.push(patch);
    slots.push(resolved.slot);
    if (resolved.frame) {
      frames.push(resolved.frame);
    }
  };

  for (const face of hallFaces(input.hall, input.rule)) {
    if (placementReaches(input.placement, face.surface)) {
      emit(face);
    }
  }

  return { frames, slots, patches: withSlotReservations(patches, slots) };
}

interface SlotFace {
  readonly id: string;
  readonly role: string;
  readonly orientation: HorizontalOrientation;
  readonly rect: Rect;
  readonly bottomY: number;
  readonly topY: number;
  readonly kind: SlotKind;
  readonly part: string;
  readonly hierarchy: number;
  /** Stone behind the face, which bounds how deep an ornament may be cut. */
  readonly thickness: number;
  /** Which placements reach this face. */
  readonly surface: "elevation" | "crowning";
  /**
   * The volume whose side this face is, when the builder draws it as part of
   * one. Null where the face is already a block of its own — a decorated front
   * slab is laid proud and needs no splitting.
   */
  readonly host: Rect | null;
  readonly rule: SlotRule;
}

/**
 * The proud front slab a plinth or a frieze carries, and the stone inside its
 * border.
 *
 * `buildDecoratedFrontMember` lays exactly this, so the insets live here rather
 * than at each call site — a slot measured against a different inset would sit
 * off the panel it names.
 */
export const DECORATED_FRONT_INSETS: Readonly<
  Partial<Record<PillarHallMemberRecord["kind"], {
    readonly horizontal: number;
    readonly vertical: number;
  }>>
> = {
  support_plinth: { horizontal: 0.18, vertical: 0.1 },
  base_frieze: { horizontal: 0.06, vertical: 0.16 },
};

/** How far a decorated front slab stands proud of the member behind it. */
export const DECORATED_FRONT_DEPTH = 0.025;

export function decoratedFrontOf(
  member: PillarHallMemberRecord,
): { readonly rect: Rect; readonly bottomY: number; readonly topY: number } | null {
  const insets = DECORATED_FRONT_INSETS[member.kind];

  if (!insets) {
    return null;
  }

  const inset = Math.min(insets.horizontal, rectWidth(member.rect) * 0.18);
  const bottomY = member.bottomY + insets.vertical;
  const topY = member.topY - insets.vertical;

  if (topY - bottomY <= EPS) {
    return null;
  }

  return {
    rect: {
      minX: member.rect.minX + inset,
      maxX: member.rect.maxX - inset,
      minZ: member.rect.maxZ,
      maxZ: member.rect.maxZ + DECORATED_FRONT_DEPTH,
    },
    bottomY,
    topY,
  };
}

/**
 * Which of a member's elevations are its own to give away.
 *
 * A plinth and a frieze hand their front to the decorated slab laid over it, so
 * the slab's own outward face is the elevation they carry. A lintel and a
 * cornice present all four of theirs. A pedestal's front is owned by the panels
 * and plinths aligned along it, and its remaining faces are returns.
 */
function memberFaces(
  member: PillarHallMemberRecord,
  rule: SlotRule,
): SlotFace[] {
  const shared = {
    rect: member.rect,
    bottomY: member.bottomY,
    topY: member.topY,
    kind: "ribbon" as const,
    thickness: Math.min(rectWidth(member.rect), rectDepth(member.rect)),
    surface: "crowning" as const,
    host: member.rect,
    rule,
  };

  switch (member.kind) {
    case "lintel":
    case "cornice":
      return HORIZONTAL_ORIENTATIONS.map((orientation) => ({
        ...shared,
        id: structurePath(member.id, ORIENTATION_SEGMENT[orientation]),
        role: member.kind === "lintel" ? PATCH_ROLES.lintel : PATCH_ROLES.roofCornice,
        orientation,
        part: "span",
        hierarchy: member.kind === "cornice" ? 20 : 10,
      }));
    case "support_plinth":
    case "base_frieze": {
      const front = decoratedFrontOf(member);

      return front
        ? [{
          id: structurePath(member.id, "front_panel"),
          role: PATCH_ROLES.pierPanel,
          orientation: "front" as const,
          rect: front.rect,
          bottomY: front.bottomY,
          topY: front.topY,
          kind: "field" as const,
          part: "base",
          hierarchy: 25,
          thickness: DECORATED_FRONT_DEPTH,
          surface: "crowning" as const,
          // The slab is laid proud as a block of its own, so its outward face
          // is already exactly the field.
          host: null,
          rule: NO_SLOT_RULE,
        }]
        : [];
    }
    default:
      return [];
  }
}

function roofFaces(
  roofId: string,
  roof: PillarHallRoofRecord,
  rule: SlotRule,
): SlotFace[] {
  return HORIZONTAL_ORIENTATIONS.map((orientation) => ({
    id: structurePath(roofId, ORIENTATION_SEGMENT[orientation]),
    role: PATCH_ROLES.roofEdge,
    orientation,
    rect: roof.footprint,
    bottomY: roof.bottomY,
    topY: roof.topY,
    kind: "ribbon" as const,
    part: "roof",
    hierarchy: 40,
    thickness: roof.thickness,
    surface: "crowning" as const,
    host: roof.footprint,
    rule,
  }));
}

/**
 * One flat outward elevation, as a patch.
 *
 * Every piece of this family is prismatic, so `topStart` is the base edge's own
 * start: `v` runs straight up and the domain is a rectangle rather than the
 * trapezoid a battered wall gives.
 */
function facePatch(face: SlotFace): Patch | null {
  const edge = rectEdge(face.rect, face.orientation);
  const frame = createFacadeFrame(edge, face.bottomY, face.topY, edge.start);

  if (frame.uLength <= EPS || frame.vLength <= EPS) {
    return null;
  }

  return {
    id: face.id,
    role: face.role,
    frame,
    dimensions: { u: frame.uLength, v: frame.vLength, thickness: 0 },
    evaluator: "planar",
    edges: verticalEdges(face.id),
    adjacency: [],
    regions: [],
    features: [],
    anchors: [],
    tags: ["exterior", face.role, face.orientation],
  };
}

function verticalEdges(patchId: string) {
  return {
    uMin: {
      id: structurePath(patchId, "edge_u_min"),
      orientation: "sideNegativeU" as const,
      treatment: null,
    },
    uMax: {
      id: structurePath(patchId, "edge_u_max"),
      orientation: "sidePositiveU" as const,
      treatment: null,
    },
    vMin: {
      id: structurePath(patchId, "edge_v_min"),
      orientation: "bottom" as const,
      treatment: null,
    },
    vMax: {
      id: structurePath(patchId, "edge_v_max"),
      orientation: "top" as const,
      treatment: null,
    },
  };
}
