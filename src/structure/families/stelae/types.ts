import type { MaterialSlot } from "../../../geometry/part";
import type { HorizontalOrientation, Orientation, Rect } from "../../kernel/frame";

/**
 * Stela vocabulary and family-owned records.
 *
 * Every enumeration below ships as a `FOO` / `IMPLEMENTED_FOO` pair. A typed
 * name is not a promise that a reader can execute it: the resolver reports a
 * named error for anything outside the implemented list, so a composition
 * authored today cannot quietly come to mean something else once the missing
 * reader lands. See `docs/stelae-system.md` for the full specification.
 */

export const STELA_ARCHETYPES = [
  "tablet",
  "framed_tablet",
  "banded_column",
] as const;

export type StelaArchetype = (typeof STELA_ARCHETYPES)[number];

export const STELA_GROUND_CONTACTS = [
  "flush",
  "sunk",
  "mounded",
  "socketed",
] as const;

export type StelaGroundContact = (typeof STELA_GROUND_CONTACTS)[number];

/** `mounded` and `socketed` need terrain the family does not own yet. */
export const IMPLEMENTED_STELA_GROUND_CONTACTS: readonly StelaGroundContact[] = [
  "flush",
  "sunk",
];

export const STELA_BASE_TREATMENTS = [
  "none",
  "flush_ground",
  "simple_plinth",
  "double_plinth",
  "stepped_pedestal",
  "stepped_apron",
  "socket_block",
  "projecting_footing",
  "battered_footing",
  "buried_base",
  "rubble_packing",
] as const;

export type StelaBaseTreatment = (typeof STELA_BASE_TREATMENTS)[number];

export const IMPLEMENTED_STELA_BASE_TREATMENTS: readonly StelaBaseTreatment[] = [
  "none",
  "simple_plinth",
  "double_plinth",
  "stepped_pedestal",
  "stepped_apron",
  "socket_block",
];

export const STELA_CROWN_TREATMENTS = [
  "flat",
  "rounded",
  "smooth",
  "pointed",
  "gabled",
  "stepped_cap",
  "corbel_cap",
  "flared_cap",
  "capital_and_capstone",
  "notched",
  "t_shaped",
  "tenon",
] as const;

export type StelaCrownTreatment = (typeof STELA_CROWN_TREATMENTS)[number];

/**
 * `pointed` and `gabled` need raking planes, which the block primitive cannot
 * express without a second kind of geometry. `rounded` and `smooth` are lofted
 * arcs — faceted, but continuous, with no ledge between courses.
 */
export const IMPLEMENTED_STELA_CROWN_TREATMENTS: readonly StelaCrownTreatment[] = [
  "flat",
  "rounded",
  "smooth",
  "stepped_cap",
  "corbel_cap",
  "flared_cap",
  "capital_and_capstone",
  "t_shaped",
  "tenon",
];

export const STELA_CROSS_SECTIONS = ["tablet", "square", "rectangular"] as const;

export type StelaCrossSection = (typeof STELA_CROSS_SECTIONS)[number];

export const STELA_TAPERS = ["none", "tapered", "battered"] as const;

export type StelaTaper = (typeof STELA_TAPERS)[number];

/**
 * `tapered` narrows both plan axes; `battered` leans only the primary faces and
 * leaves the returns vertical, which is what a broad tablet actually does.
 */
export const IMPLEMENTED_STELA_TAPERS: readonly StelaTaper[] = [
  "none",
  "tapered",
  "battered",
];

export const STELA_EDGE_TREATMENTS = ["square", "chamfered", "rounded"] as const;

export type StelaEdgeTreatment = (typeof STELA_EDGE_TREATMENTS)[number];

/** A chamfer turns the body into an eight-sided prism; blocks have four sides. */
export const IMPLEMENTED_STELA_EDGE_TREATMENTS: readonly StelaEdgeTreatment[] = [
  "square",
];

export const STELA_FACE_ROLES = ["primary", "secondary", "return", "none"] as const;

export type StelaFaceRole = (typeof STELA_FACE_ROLES)[number];

export const STELA_BAND_ROLES = [
  "base_return",
  "register",
  "ribbon",
  "frieze",
  "crown_return",
  "margin",
] as const;

export type StelaBandRole = (typeof STELA_BAND_ROLES)[number];

export const IMPLEMENTED_STELA_BAND_ROLES: readonly StelaBandRole[] = [
  "base_return",
  "register",
  "ribbon",
  "crown_return",
];

export const STELA_BAY_ROLES = [
  "field",
  "ribbon",
  "cartouche",
  "margin",
  "corner_reserve",
] as const;

export type StelaBayRole = (typeof STELA_BAY_ROLES)[number];

export const IMPLEMENTED_STELA_BAY_ROLES: readonly StelaBayRole[] = [
  "field",
  "ribbon",
];

/**
 * `wrapping` runs one `v` interval around every body face and closes on itself.
 * It needs its own member because `continuous` only promises continuity across
 * the bays of one face.
 */
export const STELA_BAND_CONTINUITIES = [
  "per_face",
  "continuous",
  "wrapping",
] as const;

export type StelaBandContinuity = (typeof STELA_BAND_CONTINUITIES)[number];

export const STELA_FRAME_STYLES = [
  "none",
  "raised_border",
  "recessed_field",
  "double_border",
  "corner_blocks",
  "banded_border",
] as const;

export type StelaFrameStyle = (typeof STELA_FRAME_STYLES)[number];

/**
 * The implemented frame is a recess. A `raised_border` would be a moulding laid
 * on the face — a different construction, not a rename of this one.
 */
export const IMPLEMENTED_STELA_FRAME_STYLES: readonly StelaFrameStyle[] = [
  "none",
  "recessed_field",
];

export const STELA_FRAME_RETURNS = ["square", "stepped", "sloped"] as const;

export type StelaFrameReturn = (typeof STELA_FRAME_RETURNS)[number];

export const IMPLEMENTED_STELA_FRAME_RETURNS: readonly StelaFrameReturn[] = [
  "square",
];

export const STELA_SLOT_KINDS = [
  "field",
  "ribbon",
  "cartouche",
  "crown_face",
  "base_face",
] as const;

export type StelaSlotKind = (typeof STELA_SLOT_KINDS)[number];

export const STELA_SLOT_CONDITIONS = ["intact", "partial", "lost"] as const;

export type StelaSlotCondition = (typeof STELA_SLOT_CONDITIONS)[number];

export const STELA_CONDITION_STAGES = [
  "new",
  "maintained",
  "weathered",
  "abandoned",
  "ruined",
  "excavated",
  "partially_reconstructed",
] as const;

export type StelaConditionStage = (typeof STELA_CONDITION_STAGES)[number];

export const IMPLEMENTED_STELA_CONDITION_STAGES: readonly StelaConditionStage[] = [
  "new",
  "weathered",
  "ruined",
];

export const STELA_DAMAGE_TYPES = [
  "weathered_surface",
  "edge_loss",
  "corner_loss",
  "chipped_field",
  "spalled_face",
  "crack_network",
  "split_body",
  "broken_crown",
  "truncated_body",
  "missing_base",
  "tilt",
  "partial_burial",
] as const;

export type StelaDamageType = (typeof STELA_DAMAGE_TYPES)[number];

/**
 * Only the two events that change resolved geometry are executable. The rest
 * are surface and material work, and would be a silent no-op rather than an
 * honest omission if they were selectable here.
 */
export const IMPLEMENTED_STELA_DAMAGE_TYPES: readonly StelaDamageType[] = [
  "truncated_body",
  "partial_burial",
];

/** Normalised sub-rectangle of a face's parametric domain. */
export interface StelaUvRect {
  readonly uMin: number;
  readonly uMax: number;
  readonly vMin: number;
  readonly vMax: number;
}

/** One point in a face's parametric domain. */
export interface StelaUv {
  readonly u: number;
  readonly v: number;
}

export interface StelaGroundRecord {
  readonly contact: StelaGroundContact;
  readonly burialDepth: number;
  readonly groundY: number;
}

export interface StelaBaseCourseRecord {
  readonly id: string;
  readonly index: number;
  readonly footprint: Rect;
  readonly bottomY: number;
  readonly topY: number;
}

export interface StelaBaseRecord {
  readonly treatment: StelaBaseTreatment;
  /** Widest course; the base must contain the body footprint at their shared plane. */
  readonly footprint: Rect;
  readonly bottomY: number;
  readonly topY: number;
  readonly courses: readonly StelaBaseCourseRecord[];
}

export interface StelaBodyRecord {
  readonly crossSection: StelaCrossSection;
  readonly taper: StelaTaper;
  readonly taperRatio: number;
  readonly edgeTreatment: StelaEdgeTreatment;
  readonly lower: Rect;
  readonly upper: Rect;
  readonly bottomY: number;
  readonly topY: number;
  /** Stone that must survive between two opposed recessed faces. */
  readonly minCoreThickness: number;
}

export interface StelaCrownRecord {
  readonly treatment: StelaCrownTreatment;
  readonly footprint: Rect;
  readonly bottomY: number;
  readonly topY: number;
  readonly exposesFace: boolean;
}

export interface StelaFaceRecord {
  readonly id: string;
  readonly orientation: HorizontalOrientation;
  readonly role: StelaFaceRole;
  readonly patchId: string;
  /** Real width at the body's bottom and top planes. */
  readonly widthBottom: number;
  readonly widthTop: number;
}

export interface StelaBandRecord {
  readonly id: string;
  readonly index: number;
  readonly role: StelaBandRole;
  readonly continuity: StelaBandContinuity;
  readonly bottomY: number;
  readonly topY: number;
  readonly height: number;
  /** Outward step beyond the body face; zero for a flush band. */
  readonly projection: number;
  readonly materialRole: MaterialSlot;
  readonly condition: StelaSlotCondition;
}

export interface StelaBayRecord {
  readonly id: string;
  readonly bandId: string;
  readonly faceId: string;
  readonly index: number;
  readonly role: StelaBayRole;
  readonly uRange: readonly [number, number];
  readonly hierarchy: number;
}

export interface StelaFrameRecord {
  readonly id: string;
  readonly style: StelaFrameStyle;
  readonly bandId: string;
  readonly bayId: string;
  readonly faceId: string;
  readonly borderWidth: number;
  /** How far the field sits behind its border. */
  readonly recessDepth: number;
  readonly insetU: number;
  readonly insetV: number;
  readonly returnProfile: StelaFrameReturn;
}

/**
 * A rectangular recess cut into one face of a band.
 *
 * A frame is not four rails laid on a surface. It is the part of the band that
 * was never cut away, which is why it reads as one continuous piece of stone
 * and why its corners need no welding: there is nothing there to join.
 */
export interface StelaPocketRecord {
  readonly id: string;
  readonly frameId: string;
  readonly face: HorizontalOrientation;
  /** Normalised span along the face, in the direction `rectEdge` runs. */
  readonly uRange: readonly [number, number];
  readonly bottomY: number;
  readonly topY: number;
  readonly depth: number;
}

/**
 * A reserved, addressable rectangle. This is the family's product: everything
 * else exists to resolve it. A slot carries no motif and no style — only where
 * it is, how big it is, and how much depth an ornament may occupy.
 */
export interface StelaSlotRecord {
  readonly id: string;
  readonly kind: StelaSlotKind;
  readonly part: "base" | "body" | "crown";
  readonly face: Orientation;
  readonly faceRole: StelaFaceRole;
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
  readonly boundary: readonly StelaUv[];
  /**
   * Largest axis-aligned rectangle inside `boundary`. This is what the published
   * patch region carries, and what a consumer needing a rectangle should use.
   */
  readonly inscribed: StelaUvRect;
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
  readonly condition: StelaSlotCondition;
  readonly tags: readonly string[];
}

export interface StelaDamageRecord {
  readonly id: string;
  readonly type: StelaDamageType;
  readonly severity: number;
  /** Elevation the event acts at, when it has one. */
  readonly y: number | null;
}

export type StelaTrunkKind =
  | "base_course"
  | "socket"
  | "band"
  | "crown_course";

/**
 * One element of the stacked solid. The trunk is a linear bottom-to-top list,
 * which is what lets contact ownership be resolved pairwise instead of by a
 * general solver: only the neighbour above can cover a top face.
 */
export interface StelaTrunkRecord {
  readonly id: string;
  readonly kind: StelaTrunkKind;
  readonly part: "base" | "body" | "crown";
  readonly bandId: string | null;
  readonly lower: Rect;
  readonly upper: Rect;
  readonly bottomY: number;
  readonly topY: number;
  readonly materialRole: MaterialSlot;
  /** Recesses cut into this element's faces; empty for a plain slab. */
  readonly pockets: readonly StelaPocketRecord[];
}

/**
 * Something laid over a trunk face rather than stacked in it. An applique never
 * emits its inner face, so the face behind it stays one whole quad and no two
 * surfaces end up coplanar.
 */
export interface StelaAppliqueRecord {
  readonly id: string;
  readonly kind: "ribbon_strip" | "apron_rib";
  readonly face: HorizontalOrientation;
  readonly bandId: string;
  readonly uRange: readonly [number, number];
  readonly bottomY: number;
  readonly topY: number;
  readonly depth: number;
  /**
   * Whether each end is an exposed edge or a contact. A ribbon between two
   * projecting bands closes neither; a rib standing on a tier closes its top,
   * because the narrower tier above steps away and leaves it open, and not its
   * bottom, where it sits on the ring below.
   */
  readonly capBottom: boolean;
  readonly capTop: boolean;
  /**
   * Outline this sits on, when that is not the body — a base course, say. The
   * body's own outline varies with height, so a ribbon on it derives its host
   * per elevation; a rib on a prismatic tier states it once.
   */
  readonly host: Rect | null;
  readonly materialRole: MaterialSlot;
}

/** Family-owned semantic record; no generic Frame abstraction sits beneath it. */
export interface StelaRecord {
  readonly id: string;
  readonly kind: "stela";
  readonly archetype: StelaArchetype;
  readonly ground: StelaGroundRecord;
  readonly base: StelaBaseRecord | null;
  readonly body: StelaBodyRecord;
  readonly crown: StelaCrownRecord | null;
  readonly faces: readonly StelaFaceRecord[];
  readonly bands: readonly StelaBandRecord[];
  readonly bays: readonly StelaBayRecord[];
  readonly frames: readonly StelaFrameRecord[];
  readonly slots: readonly StelaSlotRecord[];
  readonly damage: readonly StelaDamageRecord[];
  readonly conditionStage: StelaConditionStage;
  readonly trunk: readonly StelaTrunkRecord[];
  readonly appliques: readonly StelaAppliqueRecord[];
  readonly patchIds: readonly string[];
}
