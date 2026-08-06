import type { SlotFeatureConfig, SlotRecord } from "../../kernel/slot";
import {
  controlsFor,
  validateControls,
  type ControlSpec,
} from "../../../config/control-spec";
import type { MaterialSurfaceId } from "../../../config/material-palette";
import { StructureGraphBuilder, type StructureGraph } from "../../kernel/graph";
import { createSeedSet } from "../../kernel/seed";
import { resolveStela } from "./resolve";
import type { BevelRule } from "./bevel";
import {
  IMPLEMENTED_CORNER_RULES,
  type CornerRule,
  type MasonryRule,
} from "../../kernel/masonry";
import {
  STELA_ARCHETYPES,
  type StelaArchetype,
  type StelaBaseTreatment,
  type StelaConditionStage,
  type StelaCrossSection,
  type StelaCrownTreatment,
  type StelaFrameStyle,
  type StelaGroundContact,
  type StelaTaper,
} from "./types";

export interface StelaLayoutConfig {
  archetype: StelaArchetype;

  crossSection: StelaCrossSection;
  bodyWidth: number;
  bodyThickness: number;
  bodyHeight: number;
  taper: StelaTaper;
  taperRatio: number;

  baseTreatment: StelaBaseTreatment;
  baseHeight: number;
  baseTierCount: number;

  stoneworkEnabled: boolean;
  courseHeight: number;
  stoneWidth: number;
  stoneDepth: number;
  cornerRule: CornerRule;

  crownTreatment: StelaCrownTreatment;
  crownHeight: number;

  registerCount: number;
  bayCount: number;

  baseRibbon: boolean;
  crownRibbon: boolean;
  ribbonsBetweenRegisters: boolean;
  ribbonHeight: number;
  ribbonProjection: number;
  returnRibbons: boolean;
  ribbonWidth: number;

  frameStyle: StelaFrameStyle;
  frameRecessDepth: number;

  maxRelief: number;

  /** Engravable fields, authored per feature. */
  slots: StelaSlotFeatures;

  bevelEnabled: boolean;
  bevelAmount: number;
  bevelSegments: number;

  groundContact: StelaGroundContact;
  burialDepth: number;
  conditionStage: StelaConditionStage;
  truncation: number;

  seed: number;
}

/**
 * The slot-bearing features of a stela.
 *
 * Only the register field is framed — the family cuts a real pocket for it, and
 * `frameStyle` and `frameRecessDepth` describe that recess. A ribbon, a crown
 * top and a base face carry ornament directly on the stone they already are, so
 * there is nothing to inset them from.
 */
export interface StelaSlotFeatures {
  readonly bayField: SlotFeatureConfig;
  readonly bandRibbon: SlotFeatureConfig;
  readonly returnRibbon: SlotFeatureConfig;
  readonly crownFace: SlotFeatureConfig;
  readonly baseFace: SlotFeatureConfig;
}

export const STELA_SLOT_FEATURE_IDS = [
  "bayField",
  "bandRibbon",
  "returnRibbon",
  "crownFace",
  "baseFace",
] as const;

export type StelaSlotFeatureId = (typeof STELA_SLOT_FEATURE_IDS)[number];

export const STELA_SLOT_FEATURE_LABELS: Readonly<
  Record<StelaSlotFeatureId, string>
> = {
  bayField: "Register slots",
  bandRibbon: "Band ribbon slots",
  returnRibbon: "Return ribbon slots",
  crownFace: "Crown slots",
  baseFace: "Base slots",
};

/**
 * Which dressed surface each feature's slots are cut into. A decal is carved
 * from the same material document as the face carrying it, and this is the
 * table that says which face that is. Both ribbons run over the monolith
 * itself rather than over a member of their own, so both name the body.
 */
export const STELA_SLOT_FEATURE_SURFACES: Readonly<
  Record<StelaSlotFeatureId, MaterialSurfaceId>
> = {
  bayField: "stelaField",
  bandRibbon: "stelaBody",
  returnRibbon: "stelaBody",
  crownFace: "stelaCrown",
  baseFace: "pedestal",
};

/**
 * How each feature recognises the slots it resolved.
 *
 * A stela's slot kinds are almost a partition on their own. The exception is
 * the two ribbons, which are the same kind on the same part and differ only in
 * where they run: one wraps the monolith and one returns down a single face.
 * Both already say which in their tags, because that distinction is what a
 * reader following a band round the stone needs.
 */
export const STELA_SLOT_FEATURE_MATCHERS: Readonly<
  Record<StelaSlotFeatureId, (slot: SlotRecord) => boolean>
> = {
  bayField: (slot) => slot.kind === "field" && slot.part === "body",
  bandRibbon: (slot) => slot.kind === "ribbon" && slot.tags.includes("wrapping"),
  returnRibbon: (slot) => slot.kind === "ribbon" && slot.tags.includes("return"),
  crownFace: (slot) => slot.kind === "crown_face",
  baseFace: (slot) => slot.kind === "base_face",
};

/**
 * How far a feature's stone stands in front of the patch its slots name.
 *
 * Only the two ribbons appear: they are appliques, strips laid on the body face
 * and published against the body's own patch, so anything placed from the slot
 * alone lands inside the moulding rather than on it. Every other feature is the
 * face it says it is, and says nothing here.
 */
export const STELA_SLOT_FEATURE_STAND_OFFS: Readonly<
  Partial<Record<StelaSlotFeatureId, (layout: StelaLayoutConfig) => number>>
> = {
  bandRibbon: (layout) => layout.ribbonProjection,
  returnRibbon: (layout) => layout.ribbonProjection,
};

/** Only the register field is framed; the rest take a switch and no border. */
export const STELA_FRAMED_SLOT_FEATURES: Readonly<
  Record<StelaSlotFeatureId, boolean>
> = {
  bayField: true,
  bandRibbon: false,
  returnRibbon: false,
  crownFace: false,
  baseFace: false,
};

/**
 * A stela's slots are the family's product rather than an addition to it, so
 * every feature ships switched on. Turning one off is a composition decision.
 */
function stelaSlots(
  borderWidth: number,
  inset: number,
): StelaSlotFeatures {
  const plain = {
    enabled: true,
    borderWidth: 0,
    insetU: 0,
    insetV: 0,
    relief: 0,
    textureScale: 1,
  };

  return {
    bayField: {
      enabled: true,
      borderWidth,
      insetU: inset,
      insetV: inset,
      relief: 0,
      textureScale: 1,
    },
    bandRibbon: { ...plain },
    returnRibbon: { ...plain },
    crownFace: { ...plain },
    baseFace: { ...plain },
  };
}

export function cloneStelaSlots(
  source: Readonly<StelaSlotFeatures>,
): StelaSlotFeatures {
  return {
    bayField: { ...source.bayField },
    bandRibbon: { ...source.bandRibbon },
    returnRibbon: { ...source.returnRibbon },
    crownFace: { ...source.crownFace },
    baseFace: { ...source.baseFace },
  };
}

export const STELA_PRESETS: Readonly<
  Record<StelaArchetype, Readonly<StelaLayoutConfig>>
> = {
  tablet: {
    archetype: "tablet",
    crossSection: "tablet",
    bodyWidth: 1.4,
    bodyThickness: 0.4,
    bodyHeight: 3.2,
    taper: "battered",
    taperRatio: 0.9,
    baseTreatment: "simple_plinth",
    baseHeight: 0.3,
    baseTierCount: 5,
    stoneworkEnabled: false,
    courseHeight: 0.16,
    stoneWidth: 0.34,
    stoneDepth: 0.2,
    cornerRule: "alternating_interlock",
    crownTreatment: "rounded",
    crownHeight: 0.55,
    registerCount: 1,
    bayCount: 1,
    baseRibbon: true,
    crownRibbon: false,
    ribbonsBetweenRegisters: false,
    ribbonHeight: 0.12,
    ribbonProjection: 0.03,
    returnRibbons: false,
    ribbonWidth: 0.12,
    frameStyle: "recessed_field",
    frameRecessDepth: 0.03,
    slots: stelaSlots(0.07, 0.09),
    maxRelief: 0.06,
    bevelEnabled: true,
    bevelAmount: 0.02,
    bevelSegments: 3,
    groundContact: "flush",
    burialDepth: 0,
    conditionStage: "new",
    truncation: 0,
    seed: 17,
  },
  framed_tablet: {
    archetype: "framed_tablet",
    crossSection: "tablet",
    bodyWidth: 1.1,
    bodyThickness: 0.34,
    bodyHeight: 3.4,
    taper: "battered",
    taperRatio: 0.95,
    baseTreatment: "stepped_pedestal",
    baseHeight: 0.5,
    baseTierCount: 5,
    stoneworkEnabled: false,
    courseHeight: 0.16,
    stoneWidth: 0.34,
    stoneDepth: 0.2,
    cornerRule: "alternating_interlock",
    crownTreatment: "stepped_cap",
    crownHeight: 0.22,
    registerCount: 3,
    bayCount: 1,
    baseRibbon: true,
    crownRibbon: true,
    ribbonsBetweenRegisters: false,
    ribbonHeight: 0.14,
    ribbonProjection: 0.025,
    returnRibbons: true,
    ribbonWidth: 0.12,
    frameStyle: "recessed_field",
    frameRecessDepth: 0.035,
    slots: stelaSlots(0.075, 0.05),
    maxRelief: 0.05,
    bevelEnabled: true,
    bevelAmount: 0.016,
    bevelSegments: 3,
    groundContact: "flush",
    burialDepth: 0,
    conditionStage: "new",
    truncation: 0,
    seed: 29,
  },
  banded_column: {
    archetype: "banded_column",
    crossSection: "square",
    bodyWidth: 0.8,
    bodyThickness: 0.8,
    bodyHeight: 3.4,
    taper: "tapered",
    taperRatio: 0.94,
    baseTreatment: "socket_block",
    baseHeight: 0.5,
    baseTierCount: 5,
    stoneworkEnabled: false,
    courseHeight: 0.16,
    stoneWidth: 0.34,
    stoneDepth: 0.2,
    cornerRule: "alternating_interlock",
    crownTreatment: "capital_and_capstone",
    crownHeight: 0.7,
    registerCount: 4,
    bayCount: 1,
    baseRibbon: true,
    crownRibbon: true,
    ribbonsBetweenRegisters: true,
    ribbonHeight: 0.14,
    ribbonProjection: 0.035,
    returnRibbons: false,
    ribbonWidth: 0.12,
    frameStyle: "recessed_field",
    frameRecessDepth: 0.028,
    slots: stelaSlots(0.055, 0.03),
    maxRelief: 0.04,
    bevelEnabled: true,
    bevelAmount: 0.014,
    bevelSegments: 3,
    groundContact: "sunk",
    burialDepth: 0.12,
    conditionStage: "new",
    truncation: 0,
    seed: 41,
  },
};

export const DEFAULT_STELA_LAYOUT = STELA_PRESETS.framed_tablet;

const ARCHETYPE_OPTIONS: Readonly<Record<string, StelaArchetype>> = {
  Tablet: "tablet",
  "Framed tablet": "framed_tablet",
  "Banded column": "banded_column",
};

const CROSS_SECTION_OPTIONS: Readonly<Record<string, StelaCrossSection>> = {
  Tablet: "tablet",
  Square: "square",
  Rectangular: "rectangular",
};

const TAPER_OPTIONS: Readonly<Record<string, StelaTaper>> = {
  None: "none",
  Tapered: "tapered",
  Battered: "battered",
};

/** Only the members with a reader; the rest are a named error, not a fallback. */
const BASE_OPTIONS: Readonly<Record<string, StelaBaseTreatment>> = {
  None: "none",
  "Simple plinth": "simple_plinth",
  "Double plinth": "double_plinth",
  "Stepped pedestal": "stepped_pedestal",
  "Stepped apron": "stepped_apron",
  "Socket block": "socket_block",
};

const CROWN_OPTIONS: Readonly<Record<string, StelaCrownTreatment>> = {
  Flat: "flat",
  Rounded: "rounded",
  Smooth: "smooth",
  "Stepped cap": "stepped_cap",
  "Corbel cap": "corbel_cap",
  "Flared cap": "flared_cap",
  "Capital and capstone": "capital_and_capstone",
  "T shaped": "t_shaped",
  Tenon: "tenon",
};

const FRAME_OPTIONS: Readonly<Record<string, StelaFrameStyle>> = {
  None: "none",
  "Recessed field": "recessed_field",
};

const GROUND_OPTIONS: Readonly<Record<string, StelaGroundContact>> = {
  Flush: "flush",
  Sunk: "sunk",
};

const CORNER_RULE_OPTIONS: Readonly<Record<string, CornerRule>> = {
  Interlocking: "alternating_interlock",
  Butted: "butted",
};

const STAGE_OPTIONS: Readonly<Record<string, StelaConditionStage>> = {
  New: "new",
  Weathered: "weathered",
  Ruined: "ruined",
};

const control = controlsFor<StelaLayoutConfig>();

export const STELA_LAYOUT_CONTROLS: readonly ControlSpec<StelaLayoutConfig>[] = [
  control.list({
    key: "archetype",
    label: "form",
    name: "Stela form",
    group: "Archetype",
    options: ARCHETYPE_OPTIONS,
    scopes: ["layout"],
    onChange: (layout) => {
      Object.assign(layout, cloneStelaLayout(STELA_PRESETS[layout.archetype]));
    },
  }),

  control.list({ key: "crossSection", label: "section", name: "Body cross-section", group: "Body", options: CROSS_SECTION_OPTIONS, scopes: ["layout"] }),
  control.number({ key: "bodyWidth", label: "width", name: "Body width", group: "Body", min: 0.3, max: 4, step: 0.01, scopes: ["layout"] }),
  control.number({ key: "bodyThickness", label: "thickness", name: "Body thickness", group: "Body", min: 0.15, max: 3, step: 0.01, scopes: ["layout"] }),
  control.number({ key: "bodyHeight", label: "height", name: "Body height", group: "Body", min: 0.6, max: 9, step: 0.05, scopes: ["layout"] }),
  control.list({ key: "taper", label: "taper", name: "Body taper", group: "Body", options: TAPER_OPTIONS, scopes: ["layout"] }),
  control.number({ key: "taperRatio", label: "ratio", name: "Taper ratio", group: "Body", min: 0.5, max: 1, step: 0.005, scopes: ["layout"], visibleWhen: (layout) => layout.taper !== "none" }),

  control.list({ key: "baseTreatment", label: "treatment", name: "Base treatment", group: "Base", options: BASE_OPTIONS, scopes: ["layout"] }),
  control.number({ key: "baseHeight", label: "height", name: "Base height", group: "Base", min: 0.05, max: 2.5, step: 0.01, scopes: ["layout"], visibleWhen: (layout) => layout.baseTreatment !== "none" }),
  control.number({ key: "baseTierCount", label: "tiers", name: "Apron tier count", group: "Base", min: 2, max: 9, step: 1, integer: true, scopes: ["layout"], visibleWhen: apron }),
  control.boolean({ key: "stoneworkEnabled", label: "stonework", name: "Base stonework", group: "Base", scopes: ["layout"], visibleWhen: (layout) => layout.baseTreatment !== "none" }),
  control.number({ key: "courseHeight", label: "course", name: "Course height", group: "Base", min: 0.05, max: 0.6, step: 0.005, scopes: ["layout"], visibleWhen: built }),
  control.number({ key: "stoneWidth", label: "stone", name: "Stone width", group: "Base", min: 0.1, max: 1.2, step: 0.01, scopes: ["layout"], visibleWhen: built }),
  control.number({ key: "stoneDepth", label: "stone depth", name: "Stone depth", group: "Base", min: 0.08, max: 0.6, step: 0.01, scopes: ["layout"], visibleWhen: built }),
  control.list({ key: "cornerRule", label: "corners", name: "Corner rule", group: "Base", options: CORNER_RULE_OPTIONS, scopes: ["layout"], visibleWhen: built }),

  control.list({ key: "crownTreatment", label: "treatment", name: "Crown treatment", group: "Crown", options: CROWN_OPTIONS, scopes: ["layout"] }),
  control.number({ key: "crownHeight", label: "height", name: "Crown height", group: "Crown", min: 0, max: 2, step: 0.01, scopes: ["layout"] }),

  control.number({ key: "registerCount", label: "registers", name: "Register count", group: "Registers", min: 1, max: 8, step: 1, integer: true, scopes: ["layout"] }),
  control.number({ key: "bayCount", label: "bays", name: "Bays per register", group: "Registers", min: 1, max: 4, step: 1, integer: true, scopes: ["layout"] }),

  control.boolean({ key: "baseRibbon", label: "at base", name: "Base ribbon band", group: "Ribbons", scopes: ["layout"] }),
  control.boolean({ key: "crownRibbon", label: "at crown", name: "Crown ribbon band", group: "Ribbons", scopes: ["layout"] }),
  control.boolean({ key: "ribbonsBetweenRegisters", label: "between registers", name: "Wrapping ribbons between registers", group: "Ribbons", scopes: ["layout"] }),
  control.number({ key: "ribbonHeight", label: "height", name: "Ribbon band height", group: "Ribbons", min: 0.03, max: 0.6, step: 0.005, scopes: ["layout"], visibleWhen: hasRibbons }),
  control.number({ key: "ribbonProjection", label: "projection", name: "Ribbon projection", group: "Ribbons", min: 0.005, max: 0.25, step: 0.005, scopes: ["layout"] }),
  control.boolean({ key: "returnRibbons", label: "returns", name: "Return-face ribbons", group: "Ribbons", scopes: ["layout"] }),
  control.number({ key: "ribbonWidth", label: "width", name: "Return ribbon width", group: "Ribbons", min: 0.04, max: 0.8, step: 0.005, scopes: ["layout"], visibleWhen: (layout) => layout.returnRibbons }),

  control.list({ key: "frameStyle", label: "style", name: "Frame style", group: "Frames", options: FRAME_OPTIONS, scopes: ["layout"] }),
  control.number({ key: "frameRecessDepth", label: "recess", name: "Field recess depth", group: "Frames", min: 0.005, max: 0.2, step: 0.005, scopes: ["layout"], visibleWhen: framed }),

  control.number({ key: "maxRelief", label: "max relief", name: "Slot relief cap", group: "Slots", min: 0.005, max: 0.3, step: 0.005, scopes: ["layout"] }),

  control.boolean({ key: "bevelEnabled", label: "enabled", name: "Bevelled arrises", group: "Bevels", scopes: ["layout"] }),
  control.number({ key: "bevelAmount", label: "amount", name: "Bevel amount", group: "Bevels", min: 0.002, max: 0.15, step: 0.002, scopes: ["layout"], visibleWhen: (layout) => layout.bevelEnabled }),
  control.number({ key: "bevelSegments", label: "segments", name: "Bevel segments", group: "Bevels", min: 1, max: 6, step: 1, integer: true, scopes: ["layout"], visibleWhen: (layout) => layout.bevelEnabled }),

  control.list({ key: "groundContact", label: "contact", name: "Ground contact", group: "Condition", options: GROUND_OPTIONS, scopes: ["layout"] }),
  control.number({ key: "burialDepth", label: "burial", name: "Burial depth", group: "Condition", min: 0, max: 2, step: 0.01, scopes: ["layout"], visibleWhen: (layout) => layout.groundContact === "sunk" }),
  control.list({ key: "conditionStage", label: "stage", name: "Condition stage", group: "Condition", options: STAGE_OPTIONS, scopes: ["layout"] }),
  control.number({ key: "truncation", label: "truncation", name: "Body truncation", group: "Condition", min: 0, max: 0.9, step: 0.01, scopes: ["layout"] }),

  control.number({ key: "seed", label: "layout seed", name: "Stela seed", group: "Variation", min: 0, max: 9999, step: 1, integer: true, scopes: ["layout"] }),
];

/** Stonework only makes sense where there is a base to build out of stones. */
function built(layout: StelaLayoutConfig): boolean {
  return layout.stoneworkEnabled && layout.baseTreatment !== "none";
}

function apron(layout: StelaLayoutConfig): boolean {
  return layout.baseTreatment === "stepped_apron";
}

function framed(layout: StelaLayoutConfig): boolean {
  return layout.frameStyle !== "none";
}

function hasRibbons(layout: StelaLayoutConfig): boolean {
  return layout.baseRibbon || layout.crownRibbon || layout.ribbonsBetweenRegisters;
}

/**
 * The bevel never reaches the graph: it is a surface treatment, exactly as
 * masonry is, so turning it on leaves the serialized semantics untouched.
 */
export function toStelaBevel(layout: StelaLayoutConfig): BevelRule | null {
  return layout.bevelEnabled && layout.bevelAmount > 0
    ? { amount: layout.bevelAmount, segments: layout.bevelSegments }
    : null;
}

/**
 * Stonework for the base, and never for the body.
 *
 * A stela is one carved stone, so course lines across it would contradict the
 * form. Its plinth is the one part that may be built rather than carved, which
 * is the family's only departure from the shared construction grammar. Like the
 * bevel, none of this reaches the graph.
 */
export function toStelaMasonry(layout: StelaLayoutConfig): MasonryRule | null {
  if (!layout.stoneworkEnabled || layout.baseTreatment === "none") {
    return null;
  }
  return {
    pattern: "mixed_ashlar",
    cornerRule: IMPLEMENTED_CORNER_RULES.includes(layout.cornerRule)
      ? layout.cornerRule
      : "butted",
    courseHeight: layout.courseHeight,
    stoneWidth: layout.stoneWidth,
    // Facing depth is clamped against the body's thinner plan axis. A mass is
    // metres through and can take any bed depth an author asks for; a stela's
    // plinth is centimetres, and two facings at the authored depth would meet
    // in the middle and bury the core between them.
    depth: Math.min(
      layout.stoneDepth,
      Math.min(layout.bodyWidth, layout.bodyThickness) * 0.3,
    ),
    sizeVariation: 0.16,
    gap: layout.stoneWidth * 0.022,
    displacement: 0.01,
  };
}

export function cloneStelaLayout(
  source: Readonly<StelaLayoutConfig> = DEFAULT_STELA_LAYOUT,
): StelaLayoutConfig {
  // Every feature is copied rather than shared: the archetype control assigns a
  // preset straight onto the live layout, and a shallow spread would leave the
  // pane writing into the module-level preset.
  return { ...source, slots: cloneStelaSlots(source.slots) };
}

export function validateStelaLayout(layout: StelaLayoutConfig): void {
  void resolveStelaGraph(layout);
}

/**
 * A stela stands on the ground rather than on a host mass, so it assembles its
 * own graph instead of decorating one. The container it fills is the same shape
 * every other family's is.
 */
export function resolveStelaGraph(layout: StelaLayoutConfig): StructureGraph {
  validateControls(layout, STELA_LAYOUT_CONTROLS);

  const structureId = "stela_structure";
  const builder = new StructureGraphBuilder(
    structureId,
    createSeedSet(layout.seed),
    {
      upAxis: { x: 0, y: 1, z: 0 },
      frontAxis: { x: 0, y: 0, z: 1 },
      groundY: 0,
    },
  );

  const { record, patches } = resolveStela(structureId, layout);
  for (const patch of patches) {
    builder.addPatch(patch);
  }
  const ground = patches[0];
  if (ground) {
    for (const patch of patches.slice(1)) {
      builder.link(ground.id, patch.id);
    }
  }
  builder.addStela(record);

  return builder.build([]);
}

export { STELA_ARCHETYPES };
