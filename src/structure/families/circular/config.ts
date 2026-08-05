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
import {
  DEFAULT_DETAIL_LEVEL,
  DETAIL_PROFILES,
  type DetailLevel,
} from "../../kernel/detail";
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
  edgeFragmentation: 0.76,
  entryEndHeightRatio: 0.04,
  tierRiseRatio: 0.06,
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
 *
 * This is also where the circular family takes its detail reduction, because
 * it is the one family that never reaches `tessellateStructure` and so cannot
 * take the masonry one. `rowsPerTier` is the right lever and a better one than
 * the masonry reduction gets: the ring count falls with it, and so does the
 * segment count each ring is divided into, because a ring's target arc length
 * is derived from the radial step. The saving is quadratic.
 *
 * Every reduction lands in the returned object and never in `layout`, which
 * stays exactly as the user authored it — a level round trip that clobbered
 * `rowsPerTier` would silently destroy their configuration.
 */
export function toShellConfig(
  layout: CircularLayoutConfig,
  stone: StoneConfig,
  bevel: BevelConfig,
  detail: DetailLevel = DEFAULT_DETAIL_LEVEL,
): CircularShellConfig {
  const profile = DETAIL_PROFILES[detail];
  const stoneDetail = toStoneDetail(stone, bevel);

  return {
    ...layout,
    rowsPerTier: Math.min(layout.rowsPerTier, profile.maxRowsPerTier),
    edgeFragmentation: layout.edgeFragmentation * profile.fragmentationScale,
    stoneGapRatio: stone.gapRatio,
    sizeVariation: stone.sizeVariation,
    displacement: stone.displacement,
    ...stoneDetail,
    // A chamfered stone costs about twice a hard one, so retiring the chamfer
    // roughly halves the plate again on top of the row reduction.
    bevelEnabled: stoneDetail.bevelEnabled && profile.bevelSegments >= 1,
  };
}
