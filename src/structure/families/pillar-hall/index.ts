import { DEFAULT_PILLAR_HALL_MATERIAL_PALETTE } from "../../../config/material-palette";
import { emptyCompositionAnchors, type GeometryPart } from "../../../geometry/part";
import { defineStructure } from "../../definition";
import { tessellateStructure } from "../../mass/tessellate";
import {
  DEFAULT_PILLAR_HALL_STONE_CONFIG,
  PILLAR_HALL_FRAMED_SLOT_FEATURES,
  PILLAR_HALL_LAYOUT_CONTROLS,
  PILLAR_HALL_SLOT_FEATURE_IDS,
  PILLAR_HALL_SLOT_FEATURE_LABELS,
  PILLAR_HALL_SLOT_FEATURE_MATCHERS,
  PILLAR_HALL_SLOT_FEATURE_SURFACES,
  clonePillarHallLayout,
  resolvePillarHallGraph,
  toPillarHallMasonry,
  validatePillarHallLayout,
  type PillarHallLayoutConfig,
} from "./config";

export const PILLAR_HALL_SECTION = "pillarHall";

/**
 * Inspired square-pier galleries and screens on low stepped platforms. The
 * family is intentionally labelled by form, not by a culture or historical
 * claim, and owns its U/gallery/screen grammar directly.
 */
export const pillarHallStructure = defineStructure<PillarHallLayoutConfig>({
  id: "pillar_hall",
  label: "Pillar Hall",
  props: ["stone", "materialPalette"],
  controlTabs: [
    {
      id: "structure",
      label: "Structure",
      layoutGroups: ["Archetype", "Platform", "Approach", "Layout", "Variation"],
      props: ["stone"],
    },
    {
      id: "details",
      label: "Details",
      layoutGroups: [
        "Piers",
        "Spans",
        "Roof",
        "Stonework",
        ...PILLAR_HALL_SLOT_FEATURE_IDS.map(
          (id) => PILLAR_HALL_SLOT_FEATURE_LABELS[id],
        ),
      ],
    },
    { id: "materials", label: "Materials", props: ["materialPalette"] },
  ],
  sections: [PILLAR_HALL_SECTION],
  sectionsByScope: { layout: [PILLAR_HALL_SECTION] },
  defaultStone: DEFAULT_PILLAR_HALL_STONE_CONFIG,
  defaultMaterialPalette: DEFAULT_PILLAR_HALL_MATERIAL_PALETTE,
  materialSurfaces: [
    "stone",
    "stairs",
    "pedestal",
    "pier",
    "pierPanel",
    "lintel",
    "frieze",
    "cornice",
    "roof",
  ],
  layoutControls: PILLAR_HALL_LAYOUT_CONTROLS,
  slotFeatures: PILLAR_HALL_SLOT_FEATURE_IDS.map((id) => ({
    id,
    label: PILLAR_HALL_SLOT_FEATURE_LABELS[id],
    surface: PILLAR_HALL_SLOT_FEATURE_SURFACES[id],
    matches: PILLAR_HALL_SLOT_FEATURE_MATCHERS[id],
    framed: PILLAR_HALL_FRAMED_SLOT_FEATURES[id],
    // A decorated base belongs to the Linear Screen and a roof to the Front
    // Gallery; neither resolves anywhere else, so neither is offered there.
    visibleWhen: (layout: PillarHallLayoutConfig) => {
      if (id === "basePanel") {
        return layout.archetype === "linear_screen";
      }
      if (id === "roofFascia") {
        return layout.archetype === "front_gallery";
      }
      return true;
    },
    select: (layout: PillarHallLayoutConfig) => layout.slots[id],
  })),
  cloneLayout: clonePillarHallLayout,
  validateLayout: validatePillarHallLayout,

  build({ layout, stone, debugSlots, detail, sections }) {
    const graph = resolvePillarHallGraph(layout);
    const parts: GeometryPart[] = sections.has(PILLAR_HALL_SECTION)
      ? [...tessellateStructure(graph, {
        masonry: toPillarHallMasonry(layout, stone),
        seed: stone.seed,
        stairTilesPerStep: layout.stairTilesPerStep,
        debugSlots,
        section: PILLAR_HALL_SECTION,
        partId: "pillar-hall",
        detail,
      }).parts]
      : [];
    return { parts, anchors: emptyCompositionAnchors(), graph };
  },
});

export { DEFAULT_PILLAR_HALL_LAYOUT, PILLAR_HALL_PRESETS } from "./config";
export type { PillarHallLayoutConfig } from "./config";
export type { PillarHallArchetype, PillarHallRecord } from "./types";
