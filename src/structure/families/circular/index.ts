import {
  DEFAULT_BEVEL_CONFIG,
  DEFAULT_STONE_CONFIG,
} from "../../../config/sections";
import { DEFAULT_CIRCULAR_MATERIAL_PALETTE } from "../../../config/material-palette";
import {
  IDENTITY_MATRIX,
  type CompositionAnchor,
  type GeometryPart,
} from "../../../geometry/part";
import { buildPillarParts } from "../../../props/pillar/build";
import { defineStructure } from "../../definition";
import {
  CIRCULAR_LAYOUT_CONTROLS,
  DEFAULT_CIRCULAR_LAYOUT,
  cloneCircularLayout,
  toShellConfig,
  validateCircularLayout,
  type CircularLayoutConfig,
} from "./config";
import { createCircularPlacements } from "./layout";
import { buildCircularShell, circularCenterMetrics } from "./shell";

/**
 * The tiered circular plate: concentric paving rings, radial entries, a square
 * center block for the offering, and a flanking pillar pair per entry.
 */
export const circularStructure = defineStructure<CircularLayoutConfig>({
  id: "circular",
  label: "Circular",
  props: [
    "stone",
    "bevel",
    "pillar",
    "fireBowl",
    "fire",
    "offering",
    "materialPalette",
  ],
  controlTabs: [
    {
      id: "structure",
      label: "Structure",
      layoutGroups: ["Layout", "Entries", "Entry Edges", "Stones"],
      props: ["stone", "bevel"],
    },
    { id: "pillars", label: "Pillars", props: ["pillar"] },
    { id: "fire", label: "Fire", props: ["fireBowl", "fire"] },
    { id: "offering", label: "Offering", props: ["offering"] },
    { id: "materials", label: "Materials", props: ["materialPalette"] },
  ],
  sections: ["layout", "pillars", "fireBowls"],
  defaultLayout: DEFAULT_CIRCULAR_LAYOUT,
  defaultStone: DEFAULT_STONE_CONFIG,
  defaultBevel: DEFAULT_BEVEL_CONFIG,
  defaultMaterialPalette: DEFAULT_CIRCULAR_MATERIAL_PALETTE,
  // The plate, its pillars, their fire bowls and the statue are four surfaces a
  // composition this small still wants dressed apart: forged iron on the bowls
  // is not the shell's masonry, and the statue takes the same stone at a
  // completely different tiling density.
  materialSurfaces: ["stone", "pillar", "iron", "offering"],
  layoutControls: CIRCULAR_LAYOUT_CONTROLS,
  cloneLayout: cloneCircularLayout,
  validateLayout: validateCircularLayout,

  build({ layout, stone, bevel, pillar, fireBowl, sections }) {
    validateCircularLayout(layout);

    const parts: GeometryPart[] = [];

    if (sections.has("layout")) {
      const shell = buildCircularShell(toShellConfig(layout, stone, bevel));
      parts.push({
        id: "shell",
        section: "layout",
        slot: "stone",
        geometry: shell.geometry,
        matrix: IDENTITY_MATRIX,
        stoneCount: shell.stoneCount,
      });
    }

    const placements = createCircularPlacements(layout, pillar);
    const pillarParts = buildPillarParts({
      placements,
      pillar,
      fireBowl,
      sections,
    });
    parts.push(...pillarParts.parts);

    return {
      parts,
      anchors: {
        // Derived from the layout, so it stays correct even on a rebuild that
        // skipped the shell.
        offering: circularCenterMetrics(layout.radius, layout.tierRiseRatio),
        flames: pillarParts.flames,
        glows: groupGlowsByEntry(placements, pillarParts.flames),
      },
    };
  },
});

/**
 * One glow per entry, centred between that entry's pillar pair. Pairing pillars
 * by entry is circular-layout knowledge, which is why it lives here rather than
 * in the scene.
 */
function groupGlowsByEntry(
  placements: readonly { label: string; entryIndex: number }[],
  flames: readonly CompositionAnchor[],
): CompositionAnchor[] {
  const flamesByLabel = new Map(flames.map((flame) => [flame.label, flame]));
  const grouped = new Map<number, CompositionAnchor[]>();

  for (const placement of placements) {
    const flame = flamesByLabel.get(placement.label);

    if (!flame) {
      continue;
    }

    const entry = grouped.get(placement.entryIndex) ?? [];
    entry.push(flame);
    grouped.set(placement.entryIndex, entry);
  }

  return [...grouped.entries()].map(([entryIndex, entryFlames]) => ({
    label: `entry-${entryIndex}`,
    x: average(entryFlames.map((flame) => flame.x)),
    y: average(entryFlames.map((flame) => flame.y)),
    z: average(entryFlames.map((flame) => flame.z)),
  }));
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
