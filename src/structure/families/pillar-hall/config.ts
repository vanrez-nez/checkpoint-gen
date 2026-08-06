import { controlsFor, validateControls, type ControlSpec } from "../../../config/control-spec";
import type { StoneConfig } from "../../../config/sections";
import type { MaterialSurfaceId } from "../../../config/material-palette";
import type { StairSpec } from "../../connector/stair";
import { LINEAR_BEZIER, bezierCurve } from "../../kernel/curve";
import type { StructureGraph } from "../../kernel/graph";
import { IMPLEMENTED_CORNER_RULES, type CornerRule, type MasonryRule } from "../../kernel/masonry";
import { createSeedSet } from "../../kernel/seed";
import { DISABLED_SLOT_FEATURE, type SlotRecord } from "../../kernel/slot";

import { generateStructure, type StructureSpec } from "../../mass/generate";
import { createRectangleFootprint } from "../../mass/footprint";
import type { PillarHallSlotFeatures } from "./slots";
import { resolvePillarHall } from "./resolve";
import type { PillarHallArchetype } from "./types";

export interface PillarHallLayoutConfig {
  archetype: PillarHallArchetype;
  platformWidth: number;
  platformDepth: number;
  platformTierCount: number;
  platformHeight: number;
  stairWidthRatio: number;
  stairRiser: number;
  stairTread: number;
  stairTilesPerStep: number;
  frontBayCount: number;
  sideBayCount: number;
  rowDepth: number;
  pierHeight: number;
  pierWidth: number;
  panelDepth: number;
  lintelHeight: number;
  lintelDepth: number;
  spanEndProjection: number;
  roofThickness: number;
  roofProjection: number;
  stoneworkEnabled: boolean;
  courseHeight: number;
  stoneWidth: number;
  stoneDepth: number;
  cornerRule: CornerRule;
  /** Engravable fields, authored per feature. */
  slots: PillarHallSlotFeatures;
  seed: number;
}

/** Every feature of a hall that can carry an engraving, in pane order. */
export const PILLAR_HALL_SLOT_FEATURE_IDS = [
  "pierPanel",
  "span",
  "spanCornice",
  "basePanel",
  "roofFascia",
] as const;

export type PillarHallSlotFeatureId =
  (typeof PILLAR_HALL_SLOT_FEATURE_IDS)[number];

export const PILLAR_HALL_SLOT_FEATURE_LABELS: Readonly<
  Record<PillarHallSlotFeatureId, string>
> = {
  pierPanel: "Pier panel slots",
  span: "Span slots",
  spanCornice: "Span cornice slots",
  basePanel: "Base panel slots",
  roofFascia: "Roof fascia slots",
};

/**
 * Which dressed surface each feature's slots are cut into. A decal is carved
 * from the same material document as the face carrying it, and this is the
 * table that says which face that is.
 */
export const PILLAR_HALL_SLOT_FEATURE_SURFACES: Readonly<
  Record<PillarHallSlotFeatureId, MaterialSurfaceId>
> = {
  pierPanel: "pierPanel",
  span: "lintel",
  spanCornice: "cornice",
  basePanel: "pedestal",
  roofFascia: "roof",
};

/**
 * How each feature recognises the slots it resolved.
 *
 * A pier panel and a decorated base slab are both published under the panel
 * role, because both are a field framed by proud stone; the member carrying
 * them is what separates them, and a pier's own sections are named for the
 * pier rather than for the base.
 */
export const PILLAR_HALL_SLOT_FEATURE_MATCHERS: Readonly<
  Record<PillarHallSlotFeatureId, (slot: SlotRecord) => boolean>
> = {
  pierPanel: (slot) => slot.faceRole === "pier_panel" && slot.part !== "base",
  span: (slot) => slot.faceRole === "lintel",
  spanCornice: (slot) => slot.faceRole === "cornice",
  basePanel: (slot) => slot.faceRole === "pier_panel" && slot.part === "base",
  roofFascia: (slot) => slot.faceRole === "roof_edge",
};

/**
 * A pier panel and a decorated base slab are already framed by real geometry —
 * raised rails and a proud face — so they take a switch and no border.
 */
export const PILLAR_HALL_FRAMED_SLOT_FEATURES: Readonly<
  Record<PillarHallSlotFeatureId, boolean>
> = {
  pierPanel: false,
  span: true,
  spanCornice: true,
  basePanel: false,
  roofFascia: true,
};

function defaultPillarHallSlots(): PillarHallSlotFeatures {
  const off = (borderWidth: number, inset: number) => ({
    enabled: false,
    borderWidth,
    insetU: inset,
    insetV: inset,
    relief: 0,
    textureScale: 1,
  });

  return {
    pierPanel: off(0, 0),
    span: off(0.05, 0.02),
    spanCornice: off(0.02, 0.015),
    basePanel: off(0, 0),
    roofFascia: off(0.03, 0.02),
  };
}

export function clonePillarHallSlots(
  source: Readonly<PillarHallSlotFeatures>,
): PillarHallSlotFeatures {
  return {
    pierPanel: { ...source.pierPanel },
    span: { ...source.span },
    spanCornice: { ...source.spanCornice },
    basePanel: { ...source.basePanel },
    roofFascia: { ...source.roofFascia },
  };
}

export const DEFAULT_PILLAR_HALL_STONE_CONFIG: Readonly<StoneConfig> = {
  seed: 863,
  gapRatio: 0.022,
  sizeVariation: 0.16,
  displacement: 0.01,
};

export const PILLAR_HALL_PRESETS: Readonly<
  Record<PillarHallArchetype, Readonly<PillarHallLayoutConfig>>
> = {
  linear_screen: {
    archetype: "linear_screen",
    platformWidth: 14,
    platformDepth: 2.8,
    platformTierCount: 2,
    platformHeight: 0.8,
    stairWidthRatio: 0.34,
    stairRiser: 0.25,
    stairTread: 0.32,
    stairTilesPerStep: 5,
    frontBayCount: 5,
    sideBayCount: 3,
    rowDepth: 2,
    pierHeight: 4.3,
    pierWidth: 0.58,
    panelDepth: 0.055,
    lintelHeight: 0.38,
    lintelDepth: 0.72,
    spanEndProjection: 0.08,
    roofThickness: 0.35,
    roofProjection: 0.35,
    stoneworkEnabled: true,
    courseHeight: 0.38,
    stoneWidth: 1.1,
    stoneDepth: 0.55,
    cornerRule: "butted",
    slots: defaultPillarHallSlots(),
    seed: 31,
  },
  front_gallery: {
    archetype: "front_gallery",
    platformWidth: 15,
    platformDepth: 8,
    platformTierCount: 3,
    platformHeight: 1.5,
    stairWidthRatio: 0.34,
    stairRiser: 0.25,
    stairTread: 0.32,
    stairTilesPerStep: 7,
    frontBayCount: 5,
    sideBayCount: 3,
    rowDepth: 3.2,
    pierHeight: 4.3,
    pierWidth: 0.58,
    panelDepth: 0.055,
    lintelHeight: 0.38,
    lintelDepth: 0.72,
    spanEndProjection: 0.08,
    roofThickness: 0.35,
    roofProjection: 0.35,
    stoneworkEnabled: true,
    courseHeight: 0.42,
    stoneWidth: 1.15,
    stoneDepth: 0.6,
    cornerRule: "butted",
    slots: defaultPillarHallSlots(),
    seed: 41,
  },
  open_pavilion: {
    archetype: "open_pavilion",
    platformWidth: 11,
    platformDepth: 9,
    platformTierCount: 3,
    platformHeight: 1.2,
    stairWidthRatio: 0.65,
    stairRiser: 0.24,
    stairTread: 0.32,
    stairTilesPerStep: 9,
    frontBayCount: 4,
    sideBayCount: 3,
    rowDepth: 3.2,
    pierHeight: 4.2,
    pierWidth: 0.56,
    panelDepth: 0.05,
    lintelHeight: 0.36,
    lintelDepth: 0.7,
    spanEndProjection: 0.08,
    roofThickness: 0.35,
    roofProjection: 0.35,
    stoneworkEnabled: true,
    courseHeight: 0.4,
    stoneWidth: 1.05,
    stoneDepth: 0.55,
    cornerRule: "butted",
    slots: defaultPillarHallSlots(),
    seed: 53,
  },
};

export const DEFAULT_PILLAR_HALL_LAYOUT = PILLAR_HALL_PRESETS.front_gallery;

export const PILLAR_HALL_ARCHETYPE_OPTIONS: Readonly<
  Record<string, PillarHallArchetype>
> = {
  "Linear screen": "linear_screen",
  "Front gallery": "front_gallery",
  "Open pavilion": "open_pavilion",
};

const CORNER_RULE_OPTIONS: Readonly<Record<string, CornerRule>> = {
  Interlocking: "alternating_interlock",
  Butted: "butted",
};

const control = controlsFor<PillarHallLayoutConfig>();
const nonLinear = (layout: PillarHallLayoutConfig) =>
  layout.archetype !== "linear_screen";

export const PILLAR_HALL_LAYOUT_CONTROLS: readonly ControlSpec<PillarHallLayoutConfig>[] = [
  control.list({
    key: "archetype",
    label: "form",
    name: "Pillar Hall form",
    group: "Archetype",
    options: PILLAR_HALL_ARCHETYPE_OPTIONS,
    scopes: ["layout"],
    onChange: (layout) => {
      const archetype = layout.archetype;
      Object.assign(layout, clonePillarHallLayout(PILLAR_HALL_PRESETS[archetype]));
    },
  }),
  control.number({ key: "platformWidth", label: "width", name: "Platform width", group: "Platform", min: 4, max: 40, step: 0.1, scopes: ["layout"] }),
  control.number({ key: "platformDepth", label: "depth", name: "Platform depth", group: "Platform", min: 2, max: 30, step: 0.1, scopes: ["layout"] }),
  control.number({ key: "platformTierCount", label: "tiers", name: "Platform tier count", group: "Platform", min: 1, max: 8, step: 1, integer: true, scopes: ["layout"] }),
  control.number({ key: "platformHeight", label: "height", name: "Platform height", group: "Platform", min: 0.25, max: 6, step: 0.05, scopes: ["layout"] }),
  control.number({ key: "stairWidthRatio", label: "width", name: "Approach stair width ratio", group: "Approach", min: 0.1, max: 0.9, step: 0.01, scopes: ["layout"], visibleWhen: nonLinear }),
  control.number({ key: "stairRiser", label: "riser", name: "Approach stair riser", group: "Approach", min: 0.12, max: 0.4, step: 0.01, scopes: ["layout"], visibleWhen: nonLinear }),
  control.number({ key: "stairTread", label: "tread", name: "Approach stair tread", group: "Approach", min: 0.2, max: 0.75, step: 0.01, scopes: ["layout"], visibleWhen: nonLinear }),
  control.number({ key: "stairTilesPerStep", label: "tiles", name: "Approach tiles per tread", group: "Approach", min: 1, max: 15, step: 1, integer: true, scopes: ["layout"], visibleWhen: nonLinear }),
  control.number({ key: "frontBayCount", label: "main bays", name: "Main row bay count", group: "Layout", min: 1, max: 9, step: 1, integer: true, scopes: ["layout"] }),
  control.number({ key: "sideBayCount", label: "side bays", name: "Side row bay count", group: "Layout", min: 1, max: 9, step: 1, integer: true, scopes: ["layout"], visibleWhen: (layout) => layout.archetype === "open_pavilion" }),
  control.number({ key: "rowDepth", label: "row depth", name: "Gallery row depth", group: "Layout", min: 1.25, max: 8, step: 0.05, scopes: ["layout"], visibleWhen: (layout) => layout.archetype === "front_gallery" }),
  control.number({ key: "pierHeight", label: "height", name: "Pier height", group: "Piers", min: 2, max: 9, step: 0.05, scopes: ["layout"] }),
  control.number({ key: "pierWidth", label: "shaft width", name: "Pier shaft width", group: "Piers", min: 0.3, max: 1.2, step: 0.01, scopes: ["layout"] }),
  control.number({ key: "panelDepth", label: "panel depth", name: "Pier panel depth", group: "Piers", min: 0.015, max: 0.18, step: 0.005, scopes: ["layout"] }),
  control.number({ key: "lintelHeight", label: "height", name: "Lintel height", group: "Spans", min: 0.2, max: 1.2, step: 0.01, scopes: ["layout"] }),
  control.number({ key: "lintelDepth", label: "depth", name: "Lintel depth", group: "Spans", min: 0.35, max: 1.5, step: 0.01, scopes: ["layout"] }),
  control.number({ key: "spanEndProjection", label: "end projection", name: "Span end projection", group: "Spans", min: 0.01, max: 1.5, step: 0.01, scopes: ["layout"] }),
  control.number({ key: "roofThickness", label: "thickness", name: "Gallery roof thickness", group: "Roof", min: 0.15, max: 1, step: 0.01, scopes: ["layout"], visibleWhen: (layout) => layout.archetype === "front_gallery" }),
  control.number({ key: "roofProjection", label: "projection", name: "Gallery roof projection", group: "Roof", min: 0, max: 1, step: 0.01, scopes: ["layout"], visibleWhen: (layout) => layout.archetype === "front_gallery" }),
  control.boolean({ key: "stoneworkEnabled", label: "enabled", name: "Stonework", group: "Stonework", scopes: ["layout"] }),
  control.number({ key: "courseHeight", label: "course", name: "Course height", group: "Stonework", min: 0.1, max: 1, step: 0.01, scopes: ["layout"], visibleWhen: (layout) => layout.stoneworkEnabled }),
  control.number({ key: "stoneWidth", label: "stone", name: "Stone width", group: "Stonework", min: 0.25, max: 3, step: 0.05, scopes: ["layout"], visibleWhen: (layout) => layout.stoneworkEnabled }),
  control.number({ key: "stoneDepth", label: "depth", name: "Stone depth", group: "Stonework", min: 0.2, max: 1.5, step: 0.05, scopes: ["layout"], visibleWhen: (layout) => layout.stoneworkEnabled }),
  control.list({ key: "cornerRule", label: "corners", name: "Corner rule", group: "Stonework", options: CORNER_RULE_OPTIONS, scopes: ["layout"], visibleWhen: (layout) => layout.stoneworkEnabled }),
  control.number({ key: "seed", label: "layout seed", name: "Pillar Hall seed", group: "Variation", min: 0, max: 9999, step: 1, integer: true, scopes: ["layout"] }),
];

export function clonePillarHallLayout(
  source: Readonly<PillarHallLayoutConfig> = DEFAULT_PILLAR_HALL_LAYOUT,
): PillarHallLayoutConfig {
  // Every feature is copied rather than shared, or the pane would write
  // straight through a clone into the module-level presets.
  return { ...source, slots: clonePillarHallSlots(source.slots) };
}

export function validatePillarHallLayout(layout: PillarHallLayoutConfig): void {
  void resolvePillarHallGraph(layout);
}

export function resolvePillarHallGraph(layout: PillarHallLayoutConfig): StructureGraph {
  validateControls(layout, PILLAR_HALL_LAYOUT_CONTROLS);
  const graph = generateStructure(toPlatformSpec(layout));
  const error = graph.diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (error) {
    throw new RangeError(`${error.message} (${error.code})`);
  }
  const mass = graph.masses[0];
  const placement = mass?.summit.placement;
  if (!mass || !placement) {
    throw new RangeError(
      "The platform did not resolve a summit placement for the Pillar Hall. (pillar_hall.placement_missing)",
    );
  }
  const hall = resolvePillarHall(graph.id, layout, placement, mass.id);
  return {
    ...graph,
    patches: [...graph.patches, ...hall.patches],
    pillarHalls: [hall.record],
    diagnostics: [...graph.diagnostics, ...hall.diagnostics],
  };
}

export function toPillarHallMasonry(
  layout: PillarHallLayoutConfig,
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

function toPlatformSpec(layout: PillarHallLayoutConfig): StructureSpec {
  const stair: StairSpec[] = layout.archetype === "linear_screen" ? [] : [{
    id: "approach",
    direction: "front",
    layout: "front_centered",
    elevationMode: "continuous",
    landingRule: "none",
    widthRatio: layout.stairWidthRatio,
    targetRiser: layout.stairRiser,
    targetTread: layout.stairTread,
    sideTreatment: "none",
    parapetWidth: 0,
    parapetHeight: 0,
    parapetCorniceProjection: 0,
    parapetCorniceHeight: 0,
  }];
  return {
    id: "pillar_hall_structure",
    seeds: createSeedSet(layout.seed),
    groundY: 0,
    mass: {
      id: "platform",
      footprint: createRectangleFootprint(layout.platformWidth, layout.platformDepth),
      bandCount: layout.platformTierCount,
      totalHeight: layout.platformHeight,
      heightCurve: bezierCurve(LINEAR_BEZIER),
      summitRatio: 0.82,
      setbackScales: { front: 1, rear: 1, sidePositiveU: 1, sideNegativeU: 1 },
      batterDegrees: 8,
      wallProfile: "battered",
      cornice: { placement: "none", projection: 0, height: 0 },
      baseTreatment: "none",
      baseProjection: 0,
      baseHeight: 0,
      summitTreatment: "open_floor",
      summitBuildingWidthRatio: 1,
      summitBuildingDepthRatio: 1,
      summitPadHeight: 0,
    },
    stairs: stair,
    cells: [],
    facade: { style: "plain", pilasterProjection: 0.1, friezeHeight: 0.2, friezeProjection: 0.1 },
    roofs: [],
    // The platform under a hall is a mass, and none of its own elevations are
    // prepared: the hall's features are resolved separately.
    slots: {
      plinth: DISABLED_SLOT_FEATURE,
      bandWall: DISABLED_SLOT_FEATURE,
      bandCornice: DISABLED_SLOT_FEATURE,
      summitPad: DISABLED_SLOT_FEATURE,
      summitWall: DISABLED_SLOT_FEATURE,
      summitRoofFascia: DISABLED_SLOT_FEATURE,
      summitRoofCornice: DISABLED_SLOT_FEATURE,
    },
    slotBands: 0,
  };
}
