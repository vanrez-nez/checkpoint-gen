import type { MaterialSlot } from "../../../geometry/part";
import type { HorizontalOrientation, Rect } from "../../kernel/frame";
import type { FrameRecord, SlotRecord } from "../../kernel/slot";

export const PILLAR_HALL_ARCHETYPES = [
  "linear_screen",
  "front_gallery",
  "open_pavilion",
] as const;

export type PillarHallArchetype = (typeof PILLAR_HALL_ARCHETYPES)[number];

export type PillarSectionKind =
  | "foot"
  | "lower_panel"
  | "shaft"
  | "capital"
  | "capstone";

export interface PillarSectionRecord {
  readonly kind: PillarSectionKind;
  readonly footprint: Rect;
  readonly bottomY: number;
  readonly topY: number;
  readonly materialRole: "pier";
}

export interface PillarPanelRecord {
  readonly id: string;
  readonly orientation: HorizontalOrientation;
  readonly section: "lower_panel" | "shaft";
  readonly index: number;
  readonly supportFootprint: Rect;
  readonly bottomY: number;
  readonly topY: number;
  readonly insetU: number;
  readonly insetV: number;
  readonly borderWidth: number;
  readonly depth: number;
  readonly materialRole: "pierPanel";
}

export interface PillarSupportRecord {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly sections: readonly PillarSectionRecord[];
  readonly panels: readonly PillarPanelRecord[];
}

export interface PillarHallBayRecord {
  readonly id: string;
  readonly index: number;
  readonly rowId: string;
  readonly startSupportId: string;
  readonly endSupportId: string;
  readonly width: number;
}

export interface PillarHallRowRecord {
  readonly id: string;
  readonly orientation: HorizontalOrientation;
  readonly supportIds: readonly string[];
  readonly bayIds: readonly string[];
}

export interface PillarHallMemberRecord {
  readonly id: string;
  readonly kind:
    | "pedestal"
    | "support_plinth"
    | "base_frieze"
    | "lintel"
    | "cornice"
    | "buttress";
  readonly rect: Rect;
  readonly bottomY: number;
  readonly topY: number;
  readonly materialRole: MaterialSlot;
}

export interface PillarHallRoofRecord {
  readonly id: string;
  readonly footprint: Rect;
  readonly bottomY: number;
  readonly topY: number;
  readonly thickness: number;
  readonly projection: number;
  readonly materialRole: "roof";
}

/** Family-owned semantic record; no generic Frame abstraction sits beneath it. */
export interface PillarHallRecord {
  readonly id: string;
  readonly kind: "pillar_hall";
  readonly archetype: PillarHallArchetype;
  readonly platformMassId: string;
  readonly supportPatchId: string;
  readonly footprint: Rect;
  readonly bottomY: number;
  readonly topY: number;
  readonly rows: readonly PillarHallRowRecord[];
  readonly supports: readonly PillarSupportRecord[];
  readonly bays: readonly PillarHallBayRecord[];
  readonly members: readonly PillarHallMemberRecord[];
  readonly roof: PillarHallRoofRecord | null;
  readonly patchIds: readonly string[];
  /** Borders resolved around this hall's engravable fields. */
  readonly frames: readonly FrameRecord[];
  /** Ornament slots reserved on this hall's flat outward faces. */
  readonly slots: readonly SlotRecord[];
}
