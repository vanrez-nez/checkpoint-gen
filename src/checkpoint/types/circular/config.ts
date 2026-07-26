import {
  assertPositive,
  controlsFor,
  validateControls,
  type ControlSpec,
} from "../../../config/control-spec";
import {
  toStoneDetail,
  type BevelConfig,
  type StoneConfig,
} from "../../../config/sections";
import type { CircularShellConfig } from "./shell";

/** Layout fields specific to the circular checkpoint. */
export interface CircularLayoutConfig {
  radius: number;
  rowsPerTier: number;
  entryCount: number;
  entryWidthRatio: number;
  entryLengthRatio: number;
  entryFadeRatio: number;
  edgeFragmentation: number;
  entryEndHeightRatio: number;
  tierRiseRatio: number;
}

export const DEFAULT_CIRCULAR_LAYOUT: Readonly<CircularLayoutConfig> = {
  radius: 3,
  rowsPerTier: 4,
  entryCount: 4,
  entryWidthRatio: 0.35,
  entryLengthRatio: 0.6,
  entryFadeRatio: 0.5,
  edgeFragmentation: 1,
  entryEndHeightRatio: 0.04,
  tierRiseRatio: 0.06,
};

export const DEFAULT_CIRCULAR_STONE: Readonly<StoneConfig> = {
  seed: 741,
  gapRatio: 0.008,
  sizeVariation: 0.4,
  displacement: 0.03,
};

export const DEFAULT_CIRCULAR_BEVEL: Readonly<BevelConfig> = {
  enabled: true,
  widthRatio: 0.03,
  depthRatio: 0.11,
  variation: 0.6,
};

const control = controlsFor<CircularLayoutConfig>();

export const CIRCULAR_LAYOUT_CONTROLS: readonly ControlSpec<CircularLayoutConfig>[] = [
  control.number({
    key: "radius",
    group: "Layout",
    name: "Checkpoint radius",
    min: 1,
    max: 10,
    step: 0.1,
    // The plate radius sets where entries meet the boundary, so the pillars
    // flanking each entry move with it.
    scopes: ["layout", "pillars"],
    reframe: true,
  }),
  control.number({
    key: "rowsPerTier",
    label: "rows / tier",
    name: "Rows per tier",
    group: "Layout",
    min: 1,
    max: 4,
    step: 1,
    integer: true,
    scopes: ["layout"],
  }),
  control.number({
    key: "entryWidthRatio",
    label: "entry width",
    name: "Entry width ratio",
    group: "Layout",
    min: 0.25,
    max: 1.5,
    step: 0.01,
    scopes: ["layout", "pillars"],
    reframe: true,
  }),
  control.number({
    key: "entryLengthRatio",
    label: "entry length",
    name: "Entry length ratio",
    group: "Layout",
    min: 0.25,
    max: 3,
    step: 0.05,
    scopes: ["layout"],
    reframe: true,
  }),
  control.number({
    key: "entryCount",
    label: "count",
    name: "Entry count",
    group: "Entries",
    min: 1,
    max: 8,
    step: 1,
    integer: true,
    // Entry count changes each pillar's placement label, which feeds
    // derivePillarSeed, so the pillars must regenerate too.
    scopes: ["layout", "pillars"],
    reframe: true,
  }),
  control.number({
    key: "entryFadeRatio",
    label: "fade length",
    name: "Entry fade ratio",
    group: "Entry Edges",
    min: 0.1,
    max: 0.5,
    step: 0.01,
    scopes: ["layout"],
  }),
  control.number({
    key: "edgeFragmentation",
    label: "fragmentation",
    name: "Edge fragmentation",
    group: "Entry Edges",
    min: 0,
    max: 1,
    step: 0.01,
    scopes: ["layout"],
  }),
  control.number({
    key: "entryEndHeightRatio",
    label: "last height",
    name: "Entry end height ratio",
    group: "Entry Edges",
    min: 0.01,
    max: 1,
    step: 0.01,
    scopes: ["layout"],
  }),
  control.number({
    key: "tierRiseRatio",
    label: "tier rise",
    name: "Tier rise ratio",
    group: "Stones",
    min: 0.005,
    max: 0.12,
    step: 0.005,
    scopes: ["layout"],
  }),
];

export function cloneCircularLayout(
  source: Readonly<CircularLayoutConfig> = DEFAULT_CIRCULAR_LAYOUT,
): CircularLayoutConfig {
  return { ...source };
}

export function validateCircularLayout(layout: CircularLayoutConfig): void {
  assertPositive(layout.radius, "Checkpoint radius");
  validateControls(layout, CIRCULAR_LAYOUT_CONTROLS);
}

/**
 * Flattens the layout plus its stone and bevel sections into the shape the
 * shell generator consumes, keeping that generator's body unchanged.
 */
export function toShellConfig(
  layout: CircularLayoutConfig,
  stone: StoneConfig,
  bevel: BevelConfig,
): CircularShellConfig {
  return {
    ...layout,
    stoneGapRatio: stone.gapRatio,
    sizeVariation: stone.sizeVariation,
    displacement: stone.displacement,
    ...toStoneDetail(stone, bevel),
  };
}
