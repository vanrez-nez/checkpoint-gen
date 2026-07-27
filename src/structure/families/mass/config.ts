import {
  controlsFor,
  validateControls,
  type ControlSpec,
} from "../../../config/control-spec";
import { LINEAR_CURVE, LINEAR_HANDLES, type ShapingCurve } from "../../kernel/curve";
import { createSeedSet } from "../../kernel/seed";
import type { StructureSpec } from "../../mass/generate";
import { createRectangleFootprint } from "../../mass/footprint";
import {
  wallProfileForBatter,
  type BaseTreatment,
  type SummitTreatment,
} from "../../mass/elevation";

/**
 * The mass structure's tunable state.
 *
 * These are intent-level controls, in the order the doc recommends exposing
 * them: overall footprint, total height, terrace count, summit size, approach.
 * Nothing here names a style, a proportion preset or a motif — a band's rise is
 * a number, and what that number should be is a decision for later phases.
 */
export type HeightCurveMode = "linear" | "custom";

export interface MassLayoutConfig {
  footprintWidth: number;
  footprintDepth: number;
  bandCount: number;
  totalHeight: number;
  /**
   * How the total height is shared out. `linear` gives every band the same rise;
   * `custom` reads the two handles below as a cubic Bezier of cumulative height
   * against band position, so a curve that climbs early gives a heavy base and
   * one that climbs late gives a tall crown.
   */
  heightCurve: HeightCurveMode;
  heightCurveP1: CurveHandleValue;
  heightCurveP2: CurveHandleValue;
  /** Target summit extent as a fraction of the footprint. */
  summitRatio: number;
  frontSetbackScale: number;
  rearSetbackScale: number;
  sideSetbackScale: number;
  /** Zero is a vertical wall; there is no separate profile control. */
  batterAngle: number;
  baseTreatment: BaseTreatment;
  baseProjection: number;
  baseHeight: number;
  summitTreatment: SummitTreatment;
  summitMargin: number;
  forecourtDepth: number;
  seed: number;
}

/** A mutable curve handle, since Tweakpane writes into the bound object. */
export interface CurveHandleValue {
  x: number;
  y: number;
}

export const DEFAULT_MASS_LAYOUT: Readonly<MassLayoutConfig> = {
  footprintWidth: 24,
  footprintDepth: 18,
  bandCount: 3,
  totalHeight: 6,
  heightCurve: "linear",
  heightCurveP1: { ...LINEAR_HANDLES.p1 },
  heightCurveP2: { ...LINEAR_HANDLES.p2 },
  summitRatio: 0.55,
  frontSetbackScale: 1,
  rearSetbackScale: 1,
  sideSetbackScale: 1,
  batterAngle: 12,
  baseTreatment: "projected_footing",
  baseProjection: 0.5,
  baseHeight: 0.35,
  summitTreatment: "open_floor",
  summitMargin: 1.2,
  forecourtDepth: 3,
  seed: 1,
};

/**
 * Only the implemented members are offered, so the pane cannot put the generator
 * into a state it will refuse. The unimplemented members of each vocabulary stay
 * reachable from a hand-authored config, where they produce a named error.
 */
const HEIGHT_CURVE_OPTIONS: Readonly<Record<string, HeightCurveMode>> = {
  Linear: "linear",
  Custom: "custom",
};

const BASE_TREATMENT_OPTIONS: Readonly<Record<string, BaseTreatment>> = {
  None: "none",
  "Projected footing": "projected_footing",
};

const SUMMIT_TREATMENT_OPTIONS: Readonly<Record<string, SummitTreatment>> = {
  "Open floor": "open_floor",
};

const control = controlsFor<MassLayoutConfig>();

export const MASS_LAYOUT_CONTROLS: readonly ControlSpec<MassLayoutConfig>[] = [
  control.number({
    key: "footprintWidth",
    label: "width",
    name: "Footprint width",
    group: "Footprint",
    min: 2,
    max: 80,
    step: 0.5,
    scopes: ["layout"],
    reframe: true,
  }),
  control.number({
    key: "footprintDepth",
    label: "depth",
    name: "Footprint depth",
    group: "Footprint",
    min: 2,
    max: 80,
    step: 0.5,
    scopes: ["layout"],
    reframe: true,
  }),
  control.number({
    key: "bandCount",
    label: "bands",
    name: "Band count",
    group: "Elevation",
    min: 1,
    max: 12,
    step: 1,
    integer: true,
    scopes: ["layout"],
  }),
  control.number({
    key: "totalHeight",
    label: "height",
    name: "Total height",
    group: "Elevation",
    min: 0.5,
    max: 60,
    step: 0.25,
    scopes: ["layout"],
    reframe: true,
  }),
  control.number({
    key: "batterAngle",
    label: "batter",
    name: "Batter angle",
    group: "Elevation",
    min: 0,
    max: 35,
    step: 0.5,
    scopes: ["layout"],
  }),
  control.list({
    key: "heightCurve",
    label: "height curve",
    name: "Height curve",
    group: "Elevation",
    options: HEIGHT_CURVE_OPTIONS,
    scopes: ["layout"],
  }),
  control.point2({
    key: "heightCurveP1",
    label: "handle 1",
    name: "Height curve handle 1",
    group: "Elevation",
    min: 0,
    max: 1,
    step: 0.01,
    invertY: true,
    scopes: ["layout"],
    visibleWhen: (layout) => layout.heightCurve === "custom",
  }),
  control.point2({
    key: "heightCurveP2",
    label: "handle 2",
    name: "Height curve handle 2",
    group: "Elevation",
    min: 0,
    max: 1,
    step: 0.01,
    invertY: true,
    scopes: ["layout"],
    visibleWhen: (layout) => layout.heightCurve === "custom",
  }),
  control.number({
    key: "summitRatio",
    label: "summit size",
    name: "Summit ratio",
    group: "Setbacks",
    min: 0.05,
    max: 0.95,
    step: 0.01,
    scopes: ["layout"],
  }),
  control.number({
    key: "frontSetbackScale",
    label: "front",
    name: "Front setback scale",
    group: "Setbacks",
    min: 0,
    max: 2,
    step: 0.05,
    scopes: ["layout"],
  }),
  control.number({
    key: "rearSetbackScale",
    label: "rear",
    name: "Rear setback scale",
    group: "Setbacks",
    min: 0,
    max: 2,
    step: 0.05,
    scopes: ["layout"],
  }),
  control.number({
    key: "sideSetbackScale",
    label: "sides",
    name: "Side setback scale",
    group: "Setbacks",
    min: 0,
    max: 2,
    step: 0.05,
    scopes: ["layout"],
  }),
  control.list({
    key: "baseTreatment",
    label: "treatment",
    name: "Base treatment",
    group: "Base",
    options: BASE_TREATMENT_OPTIONS,
    scopes: ["layout"],
  }),
  control.number({
    key: "baseProjection",
    label: "projection",
    name: "Base projection",
    group: "Base",
    min: 0,
    max: 4,
    step: 0.05,
    scopes: ["layout"],
  }),
  control.number({
    key: "baseHeight",
    label: "height",
    name: "Base height",
    group: "Base",
    min: 0,
    max: 4,
    step: 0.05,
    scopes: ["layout"],
  }),
  control.list({
    key: "summitTreatment",
    label: "treatment",
    name: "Summit treatment",
    group: "Summit",
    options: SUMMIT_TREATMENT_OPTIONS,
    scopes: ["layout"],
  }),
  control.number({
    key: "summitMargin",
    label: "no-build margin",
    name: "Summit margin",
    group: "Summit",
    min: 0,
    max: 8,
    step: 0.1,
    scopes: ["layout"],
  }),
  control.number({
    key: "forecourtDepth",
    label: "forecourt depth",
    name: "Forecourt depth",
    group: "Summit",
    min: 0,
    max: 20,
    step: 0.25,
    scopes: ["layout"],
  }),
  control.number({
    key: "seed",
    label: "seed",
    name: "Structure seed",
    group: "Variation",
    min: 1,
    max: 9999,
    step: 1,
    integer: true,
    scopes: ["layout"],
  }),
];

export function cloneMassLayout(
  source: Readonly<MassLayoutConfig> = DEFAULT_MASS_LAYOUT,
): MassLayoutConfig {
  // The curve handles are cloned rather than shared, or the pane would write
  // straight through a clone into the module-level defaults.
  return {
    ...source,
    heightCurveP1: { ...source.heightCurveP1 },
    heightCurveP2: { ...source.heightCurveP2 },
  };
}

export function validateMassLayout(layout: MassLayoutConfig): void {
  validateControls(layout, MASS_LAYOUT_CONTROLS);
}

/** The curve the height controls describe. */
export function toHeightCurve(layout: MassLayoutConfig): ShapingCurve {
  return layout.heightCurve === "custom"
    ? {
      kind: "custom",
      p1: { ...layout.heightCurveP1 },
      p2: { ...layout.heightCurveP2 },
    }
    : LINEAR_CURVE;
}

/** Flattens the tunable config into the shape the mass generator consumes. */
export function toStructureSpec(layout: MassLayoutConfig): StructureSpec {
  return {
    id: "structure",
    seeds: createSeedSet(layout.seed),
    groundY: 0,
    mass: {
      id: "mass_main",
      footprint: createRectangleFootprint(
        layout.footprintWidth,
        layout.footprintDepth,
      ),
      bandCount: layout.bandCount,
      totalHeight: layout.totalHeight,
      heightCurve: toHeightCurve(layout),
      summitRatio: layout.summitRatio,
      setbackScales: {
        front: layout.frontSetbackScale,
        rear: layout.rearSetbackScale,
        sidePositiveU: layout.sideSetbackScale,
        sideNegativeU: layout.sideSetbackScale,
      },
      batterDegrees: layout.batterAngle,
      wallProfile: wallProfileForBatter(layout.batterAngle),
      baseTreatment: layout.baseTreatment,
      baseProjection: layout.baseProjection,
      baseHeight: layout.baseHeight,
      summitTreatment: layout.summitTreatment,
      summitMargin: layout.summitMargin,
      forecourtDepth: layout.forecourtDepth,
    },
  };
}
