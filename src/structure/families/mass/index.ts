import { emptyCompositionAnchors, type GeometryPart } from "../../../geometry/part";
import { defineStructure } from "../../definition";
import { generateStructure } from "../../mass/generate";
import { MASS_SECTION, tessellateStructure } from "../../mass/tessellate";
import {
  DEFAULT_MASS_LAYOUT,
  DEFAULT_MASS_STONE_CONFIG,
  MASS_LAYOUT_CONTROLS,
  cloneMassLayout,
  toMasonry,
  toStructureSpec,
  validateMassLayout,
  type MassLayoutConfig,
} from "./config";

/**
 * Massing: a footprint and an elevation profile resolved into semantic patches
 * and drawn as plain solids.
 *
 * It declares the shared `stone` control schema, so seed, gap, size variation
 * and displacement mean the same thing here as on the circular checkpoint.
 * Each family owns its values and defaults. What is particular to a coursed
 * mass — bed height, stone depth and corner behavior — is what this family adds.
 *
 * There is no bevel, no ornament and no style
 * here on purpose — this structure exists to make the mass grammar tunable on
 * its silhouette alone, and everything that would dress it up arrives in later
 * phases as a reader of the graph it produces.
 */
export const massStructure = defineStructure<MassLayoutConfig>({
  id: "mass",
  label: "Mass",
  props: ["stone"],
  sections: [MASS_SECTION],
  // Layout controls invalidate this structure's own section, not the circular
  // checkpoint's "layout" section that the shared table names.
  sectionsByScope: { layout: [MASS_SECTION] },
  defaultLayout: DEFAULT_MASS_LAYOUT,
  defaultStone: DEFAULT_MASS_STONE_CONFIG,
  layoutControls: MASS_LAYOUT_CONTROLS,
  cloneLayout: cloneMassLayout,
  validateLayout: validateMassLayout,

  build({ layout, stone, sections }) {
    validateMassLayout(layout);

    // The graph is resolved on every build regardless of what was requested:
    // it is arithmetic over a handful of rectangles, and the scene needs the
    // semantic layer for the debug overlay and the diagnostics readout even
    // when no geometry had to be regenerated.
    const graph = generateStructure(toStructureSpec(layout));
    const parts: GeometryPart[] = sections.has(MASS_SECTION)
      ? [...tessellateStructure(graph, { masonry: toMasonry(layout, stone), seed: stone.seed }).parts]
      : [];

    return { parts, anchors: emptyCompositionAnchors(), graph };
  },
});
