import { DEFAULT_PILLAR_HALL_MATERIAL_PALETTE } from "../../../config/material-palette";
import { emptyCompositionAnchors, type GeometryPart } from "../../../geometry/part";
import { defineStructure } from "../../definition";
import { tessellateStructure } from "../../mass/tessellate";
import {
  DEFAULT_PILLAR_HALL_LAYOUT,
  DEFAULT_PILLAR_HALL_STONE_CONFIG,
  PILLAR_HALL_LAYOUT_CONTROLS,
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
      layoutGroups: ["Piers", "Spans", "Roof", "Stonework"],
    },
    { id: "materials", label: "Materials", props: ["materialPalette"] },
  ],
  sections: [PILLAR_HALL_SECTION],
  sectionsByScope: { layout: [PILLAR_HALL_SECTION] },
  defaultLayout: DEFAULT_PILLAR_HALL_LAYOUT,
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
  cloneLayout: clonePillarHallLayout,
  validateLayout: validatePillarHallLayout,

  build({ layout, stone, sections }) {
    const graph = resolvePillarHallGraph(layout);
    const parts: GeometryPart[] = sections.has(PILLAR_HALL_SECTION)
      ? [...tessellateStructure(graph, {
        masonry: toPillarHallMasonry(layout, stone),
        seed: stone.seed,
        stairTilesPerStep: layout.stairTilesPerStep,
        section: PILLAR_HALL_SECTION,
        partId: "pillar-hall",
      }).parts]
      : [];
    return { parts, anchors: emptyCompositionAnchors(), graph };
  },
});

export { DEFAULT_PILLAR_HALL_LAYOUT, PILLAR_HALL_PRESETS } from "./config";
export type { PillarHallLayoutConfig } from "./config";
export type { PillarHallArchetype, PillarHallRecord } from "./types";
