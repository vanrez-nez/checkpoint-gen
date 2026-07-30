import {
  controlsFor,
  validateControls,
  type BezierValue,
  type ControlSpec,
} from "../../../config/control-spec";
import type { StoneConfig } from "../../../config/sections";
import {
  IMPLEMENTED_CORNER_RULES,
  type CornerRule,
  type MasonryRule,
} from "../../kernel/masonry";
import type { StructureGraph } from "../../kernel/graph";
import {
  CURVE_SHAPES,
  LINEAR_BEZIER,
  bezierCurve,
  type CurveShape,
  type ShapingCurve,
} from "../../kernel/curve";
import { createSeedSet } from "../../kernel/seed";
import {
  generateStructure,
  type StructureSpec,
} from "../../mass/generate";
import { createRectangleFootprint } from "../../mass/footprint";
import {
  wallProfileForBatter,
  type BaseTreatment,
  type CornicePlacement,
  type SummitTreatment,
} from "../../mass/elevation";
import type { StairSideTreatment, StairSpec } from "../../connector/stair";
import type { SummitCellSpec } from "../../cell/resolve";
import type { HorizontalOrientation } from "../../kernel/frame";

/**
 * A named height distribution, or `custom` for one authored on the curve editor.
 * Presets are the kernel's generic shapes; the labels in HEIGHT_CURVE_OPTIONS
 * are what those shapes mean when the quantity being distributed is height.
 */
export type HeightCurveMode = CurveShape | "custom";

/**
 * The mass structure's tunable state.
 *
 * These are intent-level controls, in the order the doc recommends exposing
 * them: overall footprint, total height, terrace count, summit size, approach.
 * Nothing here names a style, a proportion preset or a motif — a band's rise is
 * a number, and what that number should be is a decision for later phases.
 */
export interface MassLayoutConfig {
  footprintWidth: number;
  footprintDepth: number;
  bandCount: number;
  totalHeight: number;
  /**
   * How the total height is shared out: a named preset, or `custom` to author
   * the curve directly. Either way it resolves to a curve of cumulative height
   * against band position, so one that climbs early gives a heavy base and one
   * that climbs late gives a tall crown.
   */
  heightCurve: HeightCurveMode;
  /**
   * `[x1, y1, x2, y2]`, as CSS `cubic-bezier`. Kept in step with the preset when
   * one is selected, so it always states the curve in use.
   */
  heightCurveBezier: BezierValue;
  /** Target summit extent as a fraction of the footprint. */
  summitRatio: number;
  frontSetbackScale: number;
  rearSetbackScale: number;
  sideSetbackScale: number;
  /** Zero is a vertical wall; there is no separate profile control. */
  batterAngle: number;
  /** Which bands carry a crowning molding. */
  cornicePlacement: CornicePlacement;
  corniceProjection: number;
  corniceHeight: number;
  /** Set stone laid over the walls and terraces; off leaves them bare. */
  stoneworkEnabled: boolean;
  /** Target bed-to-bed height of a course. */
  courseHeight: number;
  /** Target stone length along a course. */
  stoneWidth: number;
  stoneDepth: number;
  cornerRule: CornerRule;
  baseTreatment: BaseTreatment;
  baseProjection: number;
  baseHeight: number;
  summitTreatment: SummitTreatment;
  /** Rise of the optional summit building pad. */
  summitPadHeight: number;
  /** Whether the summit carries the first enclosed cell assembly. */
  summitBuildingEnabled: boolean;
  /** Authoritative summit placement footprint, relative to the full summit. */
  summitBuildingWidthRatio: number;
  summitBuildingDepthRatio: number;
  summitBuildingHeight: number;
  summitBuildingWallThickness: number;
  summitBuildingPortalWidth: number;
  summitBuildingPortalHeight: number;
  /** Independently enabled centred approach stairs. */
  stairFrontEnabled: boolean;
  stairRearEnabled: boolean;
  stairLeftEnabled: boolean;
  stairRightEnabled: boolean;
  /** Flight width as a fraction of the facade it climbs. */
  stairWidthRatio: number;
  /** Target rise of one step; the generator settles the exact integer count. */
  stairRiser: number;
  /** Target depth of one tread; widened if the flight would sink into the mass. */
  stairTread: number;
  /** Explicit number of masonry tiles laid across every tread. */
  stairTilesPerStep: number;
  stairSideTreatment: StairSideTreatment;
  stairParapetWidth: number;
  stairParapetHeight: number;
  /** Horizontal cornice repeated over stepped parapet caps. */
  stairSteppedParapetCorniceProjection: number;
  stairSteppedParapetCorniceHeight: number;
  /** Continuous raked cornice over a flat parapet. */
  stairParapetCorniceProjection: number;
  stairParapetCorniceHeight: number;
  seed: number;
}

/** Surface defaults tuned specifically for the coursed Mass structure. */
export const DEFAULT_MASS_STONE_CONFIG: Readonly<StoneConfig> = {
  seed: 741,
  gapRatio: 0.026,
  sizeVariation: 0.2,
  displacement: 0.01,
};

export const DEFAULT_MASS_LAYOUT: Readonly<MassLayoutConfig> = {
  footprintWidth: 24,
  footprintDepth: 18,
  bandCount: 3,
  totalHeight: 8.25,
  heightCurve: "even",
  heightCurveBezier: [...LINEAR_BEZIER],
  summitRatio: 0.55,
  frontSetbackScale: 1,
  rearSetbackScale: 1,
  sideSetbackScale: 1,
  batterAngle: 12,
  cornicePlacement: "none",
  corniceProjection: 0.2,
  corniceHeight: 0.25,
  stoneworkEnabled: true,
  courseHeight: 0.86,
  stoneWidth: 1.65,
  stoneDepth: 0.75,
  cornerRule: "butted",
  baseTreatment: "projected_footing",
  baseProjection: 0.5,
  baseHeight: 0.35,
  summitTreatment: "open_floor",
  summitPadHeight: 0.35,
  summitBuildingEnabled: false,
  summitBuildingWidthRatio: 0.8,
  summitBuildingDepthRatio: 0.75,
  summitBuildingHeight: 4,
  summitBuildingWallThickness: 0.5,
  summitBuildingPortalWidth: 2,
  summitBuildingPortalHeight: 2.6,
  stairFrontEnabled: true,
  stairRearEnabled: true,
  stairLeftEnabled: true,
  stairRightEnabled: true,
  stairWidthRatio: 0.3,
  stairRiser: 0.26,
  stairTread: 0.32,
  stairTilesPerStep: 5,
  stairSideTreatment: "stepped_parapet",
  stairParapetWidth: 0.75,
  stairParapetHeight: 0.55,
  stairSteppedParapetCorniceProjection: 0,
  stairSteppedParapetCorniceHeight: 0,
  stairParapetCorniceProjection: 0.2,
  stairParapetCorniceHeight: 0.25,
  seed: 1,
};

/**
 * The presets, named for what they do to a silhouette rather than for the shape
 * of the curve behind them. "Heavy base" is the classic diminishing-course
 * profile; "Base and crown" gives a substantial footing and a tall top band with
 * compressed terraces between.
 */
export const HEIGHT_CURVE_OPTIONS: Readonly<Record<string, HeightCurveMode>> = {
  Linear: "even",
  "Heavy base": "front_loaded",
  "Tall crown": "back_loaded",
  "Base and crown": "ends_emphasised",
  "Tall middle": "middle_emphasised",
  Custom: "custom",
};

/** The `[x1, y1, x2, y2]` a mode stands for, or null when it is authored. */
export function heightCurveBezier(mode: HeightCurveMode): BezierValue | null {
  return mode === "custom" ? null : [...CURVE_SHAPES[mode]];
}

/**
 * Which bands take a cornice. "Terraces" leaves the crown bare so the summit
 * reads as the top of the mass rather than as one more moulded step.
 */
const CORNICE_PLACEMENT_OPTIONS: Readonly<Record<string, CornicePlacement>> = {
  None: "none",
  "Every band": "all",
  "Crown only": "crown",
  "Terraces only": "terraces",
  Alternating: "alternate",
};

/**
 * Only the implemented members are offered, so the pane cannot put the generator
 * into a state it will refuse. The unimplemented members of each vocabulary stay
 * reachable from a hand-authored config, where they produce a named error.
 */
const BASE_TREATMENT_OPTIONS: Readonly<Record<string, BaseTreatment>> = {
  None: "none",
  "Projected footing": "projected_footing",
};

const SUMMIT_TREATMENT_OPTIONS: Readonly<Record<string, SummitTreatment>> = {
  "Open floor": "open_floor",
  "Raised pad": "raised_pad",
};

const CORNER_RULE_OPTIONS: Readonly<Record<string, CornerRule>> = {
  Interlocking: "alternating_interlock",
  Butted: "butted",
};

const STAIR_SIDE_TREATMENT_OPTIONS: Readonly<Record<string, StairSideTreatment>> = {
  None: "none",
  "Stepped parapet": "stepped_parapet",
  "Flat parapet": "sloped_parapet",
};

/** True when at least one facade carries a stair. */
export function hasEnabledStair(layout: MassLayoutConfig): boolean {
  return layout.stairFrontEnabled
    || layout.stairRearEnabled
    || layout.stairLeftEnabled
    || layout.stairRightEnabled;
}

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
    // Selecting a preset writes the curve it stands for, so the stored curve is
    // always the one in use and Custom picks up where the preset left off.
    onChange: (layout) => {
      const preset = heightCurveBezier(layout.heightCurve);

      if (preset) {
        layout.heightCurveBezier = preset;
      }
    },
  }),
  control.bezier({
    key: "heightCurveBezier",
    label: "curve",
    name: "Height curve",
    group: "Elevation",
    scopes: ["layout"],
    visibleWhen: (layout) => layout.heightCurve === "custom",
  }),
  control.list({
    key: "cornicePlacement",
    label: "bands",
    name: "Cornice placement",
    group: "Cornice",
    options: CORNICE_PLACEMENT_OPTIONS,
    scopes: ["layout"],
  }),
  // A cornice is a trim, not a storey: the whole useful range is small, and a
  // slider that ran to metres spent almost all of its travel on values that
  // swallowed the wall. Zero on either reads as no cornice at all.
  control.number({
    key: "corniceProjection",
    label: "projection",
    name: "Cornice projection",
    group: "Cornice",
    min: 0,
    max: 0.3,
    step: 0.005,
    scopes: ["layout"],
    visibleWhen: (layout) => layout.cornicePlacement !== "none",
  }),
  control.number({
    key: "corniceHeight",
    label: "height",
    name: "Cornice height",
    group: "Cornice",
    min: 0,
    max: 0.3,
    step: 0.005,
    scopes: ["layout"],
    visibleWhen: (layout) => layout.cornicePlacement !== "none",
  }),
  control.boolean({
    key: "stoneworkEnabled",
    label: "enabled",
    name: "Stonework",
    group: "Stonework",
    scopes: ["layout"],
  }),
  control.number({
    key: "courseHeight",
    label: "course",
    name: "Course height",
    group: "Stonework",
    min: 0.1,
    max: 2,
    step: 0.01,
    scopes: ["layout"],
    visibleWhen: (layout) => layout.stoneworkEnabled,
  }),
  control.number({
    key: "stoneWidth",
    label: "stone",
    name: "Stone width",
    group: "Stonework",
    min: 0.2,
    max: 4,
    step: 0.05,
    scopes: ["layout"],
    visibleWhen: (layout) => layout.stoneworkEnabled,
  }),
  control.number({
    key: "stoneDepth",
    label: "depth",
    name: "Stone depth",
    group: "Stonework",
    min: 0.15,
    max: 2.5,
    step: 0.05,
    scopes: ["layout"],
    visibleWhen: (layout) => layout.stoneworkEnabled,
  }),
  control.list({
    key: "cornerRule",
    label: "corners",
    name: "Corner rule",
    group: "Stonework",
    options: CORNER_RULE_OPTIONS,
    scopes: ["layout"],
    visibleWhen: (layout) => layout.stoneworkEnabled,
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
    key: "summitPadHeight",
    label: "pad height",
    name: "Summit pad height",
    group: "Summit",
    min: 0.05,
    max: 4,
    step: 0.05,
    scopes: ["layout"],
    visibleWhen: (layout) => layout.summitTreatment === "raised_pad",
  }),
  control.boolean({
    key: "summitBuildingEnabled",
    label: "enabled",
    name: "Summit building",
    group: "Summit building",
    scopes: ["layout"],
  }),
  control.number({
    key: "summitBuildingWidthRatio",
    label: "footprint width ratio",
    name: "Summit placement width ratio",
    group: "Summit building",
    min: 0.2,
    max: 1,
    step: 0.01,
    scopes: ["layout"],
    visibleWhen: (layout) =>
      layout.summitBuildingEnabled || layout.summitTreatment === "raised_pad",
  }),
  control.number({
    key: "summitBuildingDepthRatio",
    label: "footprint depth ratio",
    name: "Summit placement depth ratio",
    group: "Summit building",
    min: 0.2,
    max: 1,
    step: 0.01,
    scopes: ["layout"],
    visibleWhen: (layout) =>
      layout.summitBuildingEnabled || layout.summitTreatment === "raised_pad",
  }),
  control.number({
    key: "summitBuildingHeight",
    label: "height",
    name: "Summit building height",
    group: "Summit building",
    min: 0.5,
    max: 16,
    step: 0.1,
    scopes: ["layout"],
    visibleWhen: (layout) => layout.summitBuildingEnabled,
  }),
  control.number({
    key: "summitBuildingWallThickness",
    label: "wall thickness",
    name: "Summit building wall thickness",
    group: "Summit building",
    min: 0.15,
    max: 2,
    step: 0.05,
    scopes: ["layout"],
    visibleWhen: (layout) => layout.summitBuildingEnabled,
  }),
  control.number({
    key: "summitBuildingPortalWidth",
    label: "portal width",
    name: "Summit building portal width",
    group: "Summit building",
    min: 0.5,
    max: 8,
    step: 0.1,
    scopes: ["layout"],
    visibleWhen: (layout) => layout.summitBuildingEnabled,
  }),
  control.number({
    key: "summitBuildingPortalHeight",
    label: "portal height",
    name: "Summit building portal height",
    group: "Summit building",
    min: 0.5,
    max: 12,
    step: 0.1,
    scopes: ["layout"],
    visibleWhen: (layout) => layout.summitBuildingEnabled,
  }),
  control.boolean({
    key: "stairFrontEnabled",
    label: "front",
    name: "Front stair",
    group: "Stair",
    scopes: ["layout"],
  }),
  control.boolean({
    key: "stairRearEnabled",
    label: "rear",
    name: "Rear stair",
    group: "Stair",
    scopes: ["layout"],
  }),
  control.boolean({
    key: "stairLeftEnabled",
    label: "left",
    name: "Left stair",
    group: "Stair",
    scopes: ["layout"],
  }),
  control.boolean({
    key: "stairRightEnabled",
    label: "right",
    name: "Right stair",
    group: "Stair",
    scopes: ["layout"],
  }),
  control.number({
    key: "stairWidthRatio",
    label: "width ratio",
    name: "Stair width ratio",
    group: "Stair",
    min: 0.05,
    max: 0.9,
    step: 0.01,
    scopes: ["layout"],
    visibleWhen: hasEnabledStair,
  }),
  // Riser and tread are targets, not dimensions: the generator resolves a whole
  // number of steps and reports how far the result drifted.
  control.number({
    key: "stairRiser",
    label: "riser",
    name: "Stair riser",
    group: "Stair",
    min: 0.12,
    max: 0.45,
    step: 0.005,
    scopes: ["layout"],
    visibleWhen: hasEnabledStair,
  }),
  control.number({
    key: "stairTread",
    label: "tread",
    name: "Stair tread",
    group: "Stair",
    min: 0.2,
    max: 0.6,
    step: 0.005,
    scopes: ["layout"],
    visibleWhen: hasEnabledStair,
  }),
  control.number({
    key: "stairTilesPerStep",
    label: "tiles per step",
    name: "Stair tiles per step",
    group: "Stair",
    min: 1,
    max: 32,
    step: 1,
    integer: true,
    scopes: ["layout"],
    visibleWhen: (layout) =>
      hasEnabledStair(layout) && layout.stoneworkEnabled,
  }),
  control.list({
    key: "stairSideTreatment",
    label: "sides",
    name: "Stair side treatment",
    group: "Stair",
    options: STAIR_SIDE_TREATMENT_OPTIONS,
    scopes: ["layout"],
    visibleWhen: hasEnabledStair,
  }),
  control.number({
    key: "stairParapetWidth",
    label: "parapet width",
    name: "Stair parapet width",
    group: "Stair",
    min: 0.2,
    max: 2,
    step: 0.05,
    scopes: ["layout"],
    visibleWhen: (layout) =>
      hasEnabledStair(layout) && layout.stairSideTreatment !== "none",
  }),
  control.number({
    key: "stairParapetHeight",
    label: "parapet height",
    name: "Stair parapet height",
    group: "Stair",
    min: 0,
    max: 2,
    step: 0.05,
    scopes: ["layout"],
    visibleWhen: (layout) =>
      hasEnabledStair(layout) && layout.stairSideTreatment !== "none",
  }),
  control.number({
    key: "stairSteppedParapetCorniceProjection",
    label: "cornice projection",
    name: "Stepped stair parapet cornice projection",
    group: "Stair",
    min: 0,
    max: 0.3,
    step: 0.005,
    scopes: ["layout"],
    visibleWhen: (layout) =>
      hasEnabledStair(layout) && layout.stairSideTreatment === "stepped_parapet",
  }),
  control.number({
    key: "stairSteppedParapetCorniceHeight",
    label: "cornice height",
    name: "Stepped stair parapet cornice height",
    group: "Stair",
    min: 0,
    max: 0.3,
    step: 0.005,
    scopes: ["layout"],
    visibleWhen: (layout) =>
      hasEnabledStair(layout) && layout.stairSideTreatment === "stepped_parapet",
  }),
  control.number({
    key: "stairParapetCorniceProjection",
    label: "cornice projection",
    name: "Flat stair parapet cornice projection",
    group: "Stair",
    min: 0,
    max: 0.3,
    step: 0.005,
    scopes: ["layout"],
    visibleWhen: (layout) =>
      hasEnabledStair(layout) && layout.stairSideTreatment === "sloped_parapet",
  }),
  control.number({
    key: "stairParapetCorniceHeight",
    label: "cornice height",
    name: "Flat stair parapet cornice height",
    group: "Stair",
    min: 0,
    max: 0.3,
    step: 0.005,
    scopes: ["layout"],
    visibleWhen: (layout) =>
      hasEnabledStair(layout) && layout.stairSideTreatment === "sloped_parapet",
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
  // The curve is copied rather than shared, or the pane would write straight
  // through a clone into the module-level defaults.
  return { ...source, heightCurveBezier: [...source.heightCurveBezier] };
}

export function validateMassLayout(layout: MassLayoutConfig): void {
  void resolveMassLayout(layout);
}

/**
 * Validates both individual control ranges and their resolved structural
 * combination. A value can sit inside its slider range yet still collapse the
 * mass when combined with the current footprint, height, batter, or stairs.
 */
export function resolveMassLayout(layout: MassLayoutConfig): StructureGraph {
  validateControls(layout, MASS_LAYOUT_CONTROLS);
  const graph = generateStructure(toStructureSpec(layout));
  const error = graph.diagnostics.find(
    (diagnostic) => diagnostic.severity === "error",
  );

  if (error) {
    throw new RangeError(`${error.message} (${error.code})`);
  }

  return graph;
}

/**
 * The curve the height controls describe.
 *
 * A preset is read from its own table rather than from the stored curve, so a
 * config that was hand-edited into disagreeing with itself still generates the
 * preset it names.
 */
export function toHeightCurve(layout: MassLayoutConfig): ShapingCurve {
  const preset = heightCurveBezier(layout.heightCurve);
  return bezierCurve(preset ?? layout.heightCurveBezier);
}

/**
 * The stonework the controls describe, or null when it is switched off.
 *
 * Size variation, gap and displacement use the shared `StoneConfig` vocabulary
 * and controls, so they retain the same meaning as on the circular checkpoint
 * and a pillar. The Mass owns its live values and defaults. What is particular
 * to a coursed mass is only what a circle has no equivalent of: bed height,
 * stone depth and corner behavior.
 *
 * `gapRatio` is a ratio, as it is everywhere else. The circular shell measures
 * it against its radius and a pillar against its shaft; a course measures it
 * against the stone it is dividing.
 */
export function toMasonry(
  layout: MassLayoutConfig,
  stone: StoneConfig,
): MasonryRule | null {
  if (!layout.stoneworkEnabled) {
    return null;
  }

  return {
    pattern: "mixed_ashlar",
    cornerRule: IMPLEMENTED_CORNER_RULES.includes(layout.cornerRule)
      ? layout.cornerRule
      : "butted",
    courseHeight: layout.courseHeight,
    stoneWidth: layout.stoneWidth,
    depth: layout.stoneDepth,
    sizeVariation: stone.sizeVariation,
    gap: layout.stoneWidth * stone.gapRatio,
    displacement: stone.displacement,
  };
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
      cornice: {
        placement: layout.cornicePlacement,
        projection: layout.corniceProjection,
        height: layout.corniceHeight,
      },
      baseTreatment: layout.baseTreatment,
      baseProjection: layout.baseProjection,
      baseHeight: layout.baseHeight,
      summitTreatment: layout.summitTreatment,
      summitBuildingWidthRatio: layout.summitBuildingWidthRatio,
      summitBuildingDepthRatio: layout.summitBuildingDepthRatio,
      summitPadHeight: layout.summitPadHeight,
    },
    stairs: toStairSpecs(layout),
    cells: toCellSpecs(layout),
  };
}

function toCellSpecs(layout: MassLayoutConfig): SummitCellSpec[] {
  if (!layout.summitBuildingEnabled) {
    return [];
  }

  return [{
    id: "summit_chamber",
    kind: "single_chamber",
    height: layout.summitBuildingHeight,
    wallThickness: layout.summitBuildingWallThickness,
    portalWidth: layout.summitBuildingPortalWidth,
    portalHeight: layout.summitBuildingPortalHeight,
  }];
}

/**
 * Expands the shared controls into one connector intent per enabled facade.
 * Front keeps its established id so the default graph remains stable.
 */
function toStairSpecs(layout: MassLayoutConfig): StairSpec[] {
  const placements: readonly {
    readonly enabled: boolean;
    readonly id: string;
    readonly direction: HorizontalOrientation;
    readonly layout: StairSpec["layout"];
  }[] = [
    {
      enabled: layout.stairFrontEnabled,
      id: "stair_primary",
      direction: "front",
      layout: "front_centered",
    },
    {
      enabled: layout.stairRearEnabled,
      id: "stair_rear",
      direction: "rear",
      layout: "rear",
    },
    {
      enabled: layout.stairLeftEnabled,
      id: "stair_left",
      direction: "sideNegativeU",
      layout: "side",
    },
    {
      enabled: layout.stairRightEnabled,
      id: "stair_right",
      direction: "sidePositiveU",
      layout: "side",
    },
  ];

  return placements.filter((placement) => placement.enabled).map((placement) => ({
    id: placement.id,
    direction: placement.direction,
    layout: placement.layout,
    elevationMode: "continuous",
    landingRule: "none",
    widthRatio: layout.stairWidthRatio,
    targetRiser: layout.stairRiser,
    targetTread: layout.stairTread,
    sideTreatment: layout.stairSideTreatment,
    parapetWidth: layout.stairParapetWidth,
    parapetHeight: layout.stairParapetHeight,
    parapetCorniceProjection: layout.stairSideTreatment === "stepped_parapet"
      ? layout.stairSteppedParapetCorniceProjection
      : layout.stairParapetCorniceProjection,
    parapetCorniceHeight: layout.stairSideTreatment === "stepped_parapet"
      ? layout.stairSteppedParapetCorniceHeight
      : layout.stairParapetCorniceHeight,
  }));
}
