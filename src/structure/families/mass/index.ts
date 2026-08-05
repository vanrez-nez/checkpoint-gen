import {
  createPlacementMatrix,
  type CompositionAnchor,
  type GeometryPart,
} from "../../../geometry/part";
import { defineStructure } from "../../definition";
import { DEFAULT_MASS_MATERIAL_PALETTE } from "../../../config/material-palette";
import { createFireBowlGeometry } from "../../../props/fire-bowl/generator";
import { MASS_SECTION, tessellateStructure } from "../../mass/tessellate";
import {
  DEFAULT_MASS_LAYOUT,
  DEFAULT_MASS_STONE_CONFIG,
  MASS_LAYOUT_CONTROLS,
  MASS_SLOT_FEATURE_IDS,
  MASS_SLOT_FEATURE_LABELS,
  cloneMassLayout,
  resolveMassLayout,
  toMasonry,
  validateMassLayout,
  type MassLayoutConfig,
} from "./config";
import {
  resolveMassFireBowlSlots,
  type MassFireBowlSlot,
} from "./fire-bowl-slots";

export const MASS_FIRE_BOWL_SECTION = "fireBowls";

/**
 * Massing: a footprint and an elevation profile resolved into semantic patches
 * and drawn as plain solids.
 *
 * It declares the shared `stone` control schema, so seed, gap, size variation
 * and displacement mean the same thing here as on the circular checkpoint.
 * Each family owns its values and defaults. What is particular to a coursed
 * mass — bed height, stone depth and corner behavior — is what this family adds.
 *
 * Architectural attachments remain readers of that resolved graph. The first
 * such prop is the shared fire bowl: Mass owns only its parapet-terminal slots,
 * while the prop package continues to own the bowl mesh and fire effects.
 */
export const massStructure = defineStructure<MassLayoutConfig>({
  id: "mass",
  label: "Mass",
  props: ["stone", "fireBowl", "fire", "materialPalette"],
  controlTabs: [
    {
      id: "structure",
      label: "Structure",
      layoutGroups: [
        "Footprint",
        "Elevation",
        "Cornice",
        "Stonework",
        "Setbacks",
        "Base",
        "Variation",
        MASS_SLOT_FEATURE_LABELS.plinth,
        MASS_SLOT_FEATURE_LABELS.bandWall,
        MASS_SLOT_FEATURE_LABELS.bandCornice,
      ],
      props: ["stone"],
    },
    { id: "stairs", label: "Stairs", layoutGroups: ["Stair"] },
    {
      id: "summit",
      label: "Summit",
      layoutGroups: [
        "Summit",
        "Summit building",
        "Facade",
        "Roof",
        MASS_SLOT_FEATURE_LABELS.summitWall,
        MASS_SLOT_FEATURE_LABELS.summitRoofFascia,
        MASS_SLOT_FEATURE_LABELS.summitRoofCornice,
      ],
    },
    {
      id: "fire",
      label: "Fire",
      layoutGroups: ["Fire bowl slots"],
      props: ["fireBowl", "fire"],
    },
    { id: "materials", label: "Materials", props: ["materialPalette"] },
  ],
  sections: [MASS_SECTION, MASS_FIRE_BOWL_SECTION],
  // Layout controls invalidate this structure's own section, not the circular
  // checkpoint's "layout" section that the shared table names.
  sectionsByScope: {
    layout: [MASS_SECTION, MASS_FIRE_BOWL_SECTION],
    bowls: [MASS_FIRE_BOWL_SECTION],
  },
  defaultLayout: DEFAULT_MASS_LAYOUT,
  defaultStone: DEFAULT_MASS_STONE_CONFIG,
  defaultMaterialPalette: DEFAULT_MASS_MATERIAL_PALETTE,
  materialSurfaces: [
    "stone",
    "trim",
    "stairs",
    "parapet",
    "summit",
    "interior",
    "roof",
    "portalReveal",
    "windowReveal",
    "niche",
    "panel",
    "pilaster",
    "frieze",
    "pillar",
    "cornice",
    "iron",
  ],
  layoutControls: MASS_LAYOUT_CONTROLS,
  slotFeatures: MASS_SLOT_FEATURE_IDS.map((id) => ({
    id,
    label: MASS_SLOT_FEATURE_LABELS[id],
    // A surface the composition never builds has nothing to engrave.
    visibleWhen: (layout: MassLayoutConfig) => {
      switch (id) {
        case "plinth":
          return layout.baseTreatment !== "none";
        case "bandCornice":
          return layout.cornicePlacement !== "none";
        case "summitWall":
          return layout.summitBuildingEnabled;
        case "summitRoofFascia":
        case "summitRoofCornice":
          return layout.summitBuildingEnabled && layout.summitRoofEnabled;
        default:
          return true;
      }
    },
    select: (layout: MassLayoutConfig) => layout.slots[id],
  })),
  cloneLayout: cloneMassLayout,
  validateLayout: validateMassLayout,

  build({ layout, stone, fireBowl, debugSlots, detail, sections }) {
    // The graph is resolved on every build regardless of what was requested:
    // it is arithmetic over a handful of rectangles, and the scene needs the
    // semantic layer for the debug overlay and the diagnostics readout even
    // when no geometry had to be regenerated.
    const graph = resolveMassLayout(layout);
    const parts: GeometryPart[] = sections.has(MASS_SECTION)
      ? [...tessellateStructure(graph, {
        masonry: toMasonry(layout, stone),
        seed: stone.seed,
        stairTilesPerStep: layout.stairTilesPerStep,
        debugSlots,
        detail,
      }).parts]
      : [];

    const slots = resolveMassFireBowlSlots(layout, graph, fireBowl);
    const activeSlots = fireBowl.enabled ? slots : [];
    if (sections.has(MASS_FIRE_BOWL_SECTION) && fireBowl.enabled) {
      for (const slot of slots) {
        const bowl = createFireBowlGeometry(
          { ...fireBowl, scale: slot.bowlScale },
          slot.referenceWidth,
        );
        parts.push({
          id: slot.id,
          section: MASS_FIRE_BOWL_SECTION,
          slot: "iron",
          geometry: bowl.geometry,
          matrix: createPlacementMatrix(slot.x, slot.y, slot.z, 0),
          stoneCount: 0,
        });
      }
    }

    const flames: CompositionAnchor[] = activeSlots.map((slot) => ({
      label: slot.id,
      x: slot.x,
      y: slot.y,
      z: slot.z,
    }));

    return {
      parts,
      anchors: {
        offering: null,
        flames,
        glows: groupGlowsByTerminal(activeSlots),
      },
      graph,
    };
  },
});

/** One point light midway between each left/right bowl pair. */
function groupGlowsByTerminal(
  slots: readonly MassFireBowlSlot[],
): CompositionAnchor[] {
  const pairs = new Map<string, MassFireBowlSlot[]>();

  for (const slot of slots) {
    const key = `${slot.connectorId}/${slot.level}`;
    const pair = pairs.get(key) ?? [];
    pair.push(slot);
    pairs.set(key, pair);
  }

  return [...pairs.entries()].map(([key, pair]) => ({
    label: `${key}/fire_glow`,
    x: average(pair.map((slot) => slot.x)),
    y: average(pair.map((slot) => slot.y)),
    z: average(pair.map((slot) => slot.z)),
    outwardX: average(pair.map((slot) => slot.outwardX)),
    outwardZ: average(pair.map((slot) => slot.outwardZ)),
  }));
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
