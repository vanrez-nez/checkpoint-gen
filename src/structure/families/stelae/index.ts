import { DEFAULT_STELA_MATERIAL_PALETTE } from "../../../config/material-palette";
import { emptyCompositionAnchors, type GeometryPart } from "../../../geometry/part";
import { defineStructure } from "../../definition";
import { tessellateStructure } from "../../mass/tessellate";
import {
  DEFAULT_STELA_LAYOUT,
  STELA_LAYOUT_CONTROLS,
  cloneStelaLayout,
  resolveStelaGraph,
  toStelaBevel,
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
      layoutGroups: ["Registers", "Ribbons", "Frames", "Bevels", "Slots", "Condition"],
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
    "slotDebug",
    "pedestal",
    "frieze",
    "cornice",
  ],
  layoutControls: STELA_LAYOUT_CONTROLS,
  cloneLayout: cloneStelaLayout,
  validateLayout: validateStelaLayout,

  build({ layout, sections }) {
    const graph = resolveStelaGraph(layout);
    const parts: GeometryPart[] = sections.has(STELA_SECTION)
      ? [...tessellateStructure(graph, {
        // The body is one stone by definition, so no masonry is laid over it.
        masonry: null,
        seed: layout.seed,
        debugSlots: layout.debugSlots,
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
