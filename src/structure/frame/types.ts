import type { MaterialSlot } from "../../geometry/part";
import type { HorizontalOrientation, Rect } from "../kernel/frame";

export const FRAME_LAYOUTS = [
  "single_row_portico",
  "perimeter_colonnade",
] as const;

export type FrameLayout = (typeof FRAME_LAYOUTS)[number];

export interface FrameRoofSpec {
  readonly enabled: boolean;
  readonly thickness: number;
  readonly projection: number;
}

/** Intent for one support-and-span assembly resolved on a summit placement. */
export interface FrameSpec {
  readonly id: string;
  readonly layout: FrameLayout;
  readonly frontBayCount: number;
  readonly sideBayCount: number;
  readonly height: number;
  readonly shaftWidth: number;
  readonly cellClearance: number;
  readonly stylobateHeight: number;
  readonly stylobateProjection: number;
  readonly lintelHeight: number;
  readonly architraveHeight: number;
  readonly friezeHeight: number;
  readonly corniceHeight: number;
  readonly roof: FrameRoofSpec;
}

export type FrameSupportSectionKind =
  | "plinth"
  | "base"
  | "shaft"
  | "capital"
  | "bearing";

export interface FrameSupportSectionRecord {
  readonly kind: FrameSupportSectionKind;
  readonly footprint: Rect;
  readonly bottomY: number;
  readonly topY: number;
  readonly materialRole: "pillar";
}

export interface FrameSupportRecord {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly footprint: Rect;
  readonly sections: readonly FrameSupportSectionRecord[];
  readonly patchIds: readonly string[];
  readonly bearingPatchId: string;
}

export interface FrameBayRecord {
  readonly id: string;
  readonly index: number;
  readonly rowId: string;
  readonly startSupportId: string;
  readonly endSupportId: string;
  readonly width: number;
  readonly entrance: boolean;
}

export interface FrameMemberRecord {
  readonly id: string;
  readonly kind:
    | "stylobate"
    | "lintel"
    | "architrave"
    | "frieze"
    | "cornice";
  readonly rect: Rect;
  readonly bottomY: number;
  readonly topY: number;
  readonly materialRole: MaterialSlot;
  readonly patchIds: readonly string[];
}

export interface FrameRowRecord {
  readonly id: string;
  readonly orientation: HorizontalOrientation;
  readonly supportIds: readonly string[];
  readonly bayIds: readonly string[];
  readonly entranceBayId: string | null;
  readonly stylobateIds: readonly string[];
  readonly lintelIds: readonly string[];
  readonly entablatureIds: readonly string[];
}

/** Resolved Frame ownership: supports, bays and the members spanning them. */
export interface FrameRecord {
  readonly id: string;
  readonly kind: "frame";
  readonly layout: FrameLayout;
  readonly attachedCellIds: readonly string[];
  readonly footprint: Rect;
  readonly bottomY: number;
  readonly topY: number;
  readonly shaftWidth: number;
  readonly rows: readonly FrameRowRecord[];
  readonly supports: readonly FrameSupportRecord[];
  readonly bays: readonly FrameBayRecord[];
  readonly members: readonly FrameMemberRecord[];
  readonly roofId: string | null;
  readonly patchIds: readonly string[];
}
