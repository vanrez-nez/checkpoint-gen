import { DEFAULT_STELA_MATERIAL_PALETTE } from "../../../config/material-palette";
import { emptyCompositionAnchors, type GeometryPart } from "../../../geometry/part";
import { defineStructure } from "../../definition";
import { tessellateStructure } from "../../mass/tessellate";
import {
  DEFAULT_STELA_LAYOUT,
  STELA_FRAMED_SLOT_FEATURES,
  STELA_LAYOUT_CONTROLS,
  STELA_SLOT_FEATURE_IDS,
  STELA_SLOT_FEATURE_LABELS,
  cloneStelaLayout,
  resolveStelaGraph,
  toStelaBevel,
  toStelaMasonry,
  validateStelaLayout,
  type StelaLayoutConfig,
} from "./config";

export const STELA_SECTION = "stela";

/**
 * Free-standing carved monoliths: tablets, banded columns and markers.
 *
 * The family resolves form and slots, and deliberately not content. Engraving,
 * glyphs and figures arrive later from a different pipeline, as geometry or as
 * a texture cut to fit, and read the slot table rather than the composition
 * that produced it. See `docs/stelae-system.md`.
 */
export const stelaStructure = defineStructure<StelaLayoutConfig>({
  id: "stela",
  label: "Stela",
  props: ["materialPalette"],
  controlTabs: [
    {
      id: "structure",
      label: "Structure",
      layoutGroups: ["Archetype", "Body", "Base", "Crown", "Variation"],
    },
    {
      id: "details",
      label: "Details",
      layoutGroups: [
        "Registers",
        "Ribbons",
        "Frames",
        "Bevels",
        "Slots",
        "Condition",
        ...STELA_SLOT_FEATURE_IDS.map((id) => STELA_SLOT_FEATURE_LABELS[id]),
      ],
    },
    { id: "materials", label: "Materials", props: ["materialPalette"] },
  ],
  sections: [STELA_SECTION],
  sectionsByScope: { layout: [STELA_SECTION] },
  defaultLayout: DEFAULT_STELA_LAYOUT,
  defaultMaterialPalette: DEFAULT_STELA_MATERIAL_PALETTE,
  materialSurfaces: [
    "stelaBody",
    "stelaField",
    "stelaCrown",
    "pedestal",
    "frieze",
    "cornice",
  ],
  layoutControls: STELA_LAYOUT_CONTROLS,
  slotFeatures: STELA_SLOT_FEATURE_IDS.map((id) => ({
    id,
    label: STELA_SLOT_FEATURE_LABELS[id],
    framed: STELA_FRAMED_SLOT_FEATURES[id],
    visibleWhen: (layout: StelaLayoutConfig) => {
      if (id === "returnRibbon") {
        return layout.returnRibbons;
      }
      if (id === "baseFace") {
        return layout.baseTreatment !== "none";
      }
      return true;
    },
    select: (layout: StelaLayoutConfig) => layout.slots[id],
  })),
  cloneLayout: cloneStelaLayout,
  validateLayout: validateStelaLayout,

  build({ layout, debugSlots, sections }) {
    const graph = resolveStelaGraph(layout);
    const parts: GeometryPart[] = sections.has(STELA_SECTION)
      ? [...tessellateStructure(graph, {
        // The body is one stone by definition; only a built base takes courses.
        masonry: toStelaMasonry(layout),
        seed: layout.seed,
        debugSlots,
        bevel: toStelaBevel(layout),
        section: STELA_SECTION,
        partId: "stela",
      }).parts]
      : [];
    return { parts, anchors: emptyCompositionAnchors(), graph };
  },
});

export { DEFAULT_STELA_LAYOUT, STELA_PRESETS } from "./config";
export type { StelaLayoutConfig } from "./config";
export type { StelaArchetype, StelaRecord, StelaSlotRecord } from "./types";
