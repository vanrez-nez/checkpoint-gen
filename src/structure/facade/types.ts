import type { HorizontalOrientation } from "../kernel/frame";

export const FACADE_STYLES = ["plain", "hierarchical"] as const;
export type FacadeStyle = (typeof FACADE_STYLES)[number];

export const FACADE_SYMMETRIES = ["none", "bilateral"] as const;
export type FacadeSymmetry = (typeof FACADE_SYMMETRIES)[number];

export interface FacadeSpec {
  readonly style: FacadeStyle;
  /** How far niches and recessed panels retreat behind the wall face. */
  readonly recessDepth: number;
  /** How far pilasters stand proud of the wall face. */
  readonly pilasterProjection: number;
  /** Real height of the continuous upper facade band. */
  readonly friezeHeight: number;
  /** How far the frieze stands proud of the wall face. */
  readonly friezeProjection: number;
}

export type FacadeBayRole =
  | "solid"
  | "secondary"
  | "primary"
  | "entrance"
  | "window"
  | "niche"
  | "recess"
  | "panel"
  | "corner_reserve";

export type FacadeBandRole =
  | "plinth"
  | "wall_body"
  | "opening_zone"
  | "frieze"
  | "cornice";

export interface FacadeBayRule {
  readonly id: string;
  readonly role: FacadeBayRole;
  /** Fixed real width. Exactly one of width and weight must be positive. */
  readonly width?: number;
  /** Share of the width left after fixed bays and margins. */
  readonly weight?: number;
  readonly hierarchy: number;
}

export interface FacadeBandRule {
  readonly id: string;
  readonly role: FacadeBandRole;
  /** Fixed real height. Exactly one of height and weight must be positive. */
  readonly height?: number;
  /** Share of the height left after fixed bands. */
  readonly weight?: number;
  readonly continuity: "per_bay" | "continuous";
}

export interface FacadeBayRecord {
  readonly id: string;
  readonly index: number;
  readonly role: FacadeBayRole;
  readonly hierarchy: number;
  readonly uRange: readonly [number, number];
  readonly width: number;
}

export interface FacadeBandRecord {
  readonly id: string;
  readonly index: number;
  readonly role: FacadeBandRole;
  readonly continuity: "per_bay" | "continuous";
  readonly vRange: readonly [number, number];
  readonly height: number;
}

/** One resolved exterior wall grammar. */
export interface FacadeRecord {
  readonly id: string;
  readonly cellId: string;
  readonly orientation: HorizontalOrientation;
  readonly exteriorPatchId: string;
  readonly interiorPatchId: string;
  readonly style: FacadeStyle;
  readonly symmetry: FacadeSymmetry;
  readonly bays: readonly FacadeBayRecord[];
  readonly bands: readonly FacadeBandRecord[];
  readonly featureIds: readonly string[];
}
