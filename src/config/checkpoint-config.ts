import type { PartSection } from "../geometry/part";
import {
  DEFAULT_CIRCULAR_BEVEL,
  DEFAULT_CIRCULAR_STONE,
  cloneCircularLayout,
  type CircularLayoutConfig,
} from "../checkpoint/types/circular/config";
import {
  DEFAULT_FIRE_BOWL_CONFIG,
  cloneFireBowlConfig,
  type FireBowlConfig,
} from "../props/fire-bowl/config";
import {
  DEFAULT_FIRE_CONFIG,
  cloneFireConfig,
  type FireConfig,
} from "../props/fire/config";
import {
  DEFAULT_OFFERING_CONFIG,
  cloneOfferingConfig,
  type OfferingConfig,
} from "../props/offering/config";
import {
  DEFAULT_PILLAR_CONFIG,
  clonePillarConfig,
  type PillarConfig,
} from "../props/pillar/config";
import {
  DEFAULT_ILLUMINATION_CONFIG,
  DEFAULT_VIEW_CONFIG,
  cloneBevelConfig,
  cloneIlluminationConfig,
  cloneStoneConfig,
  type BevelConfig,
  type IlluminationConfig,
  type StoneConfig,
  type ViewConfig,
} from "./sections";
import type { RebuildScope } from "./control-spec";

/**
 * Per-type layout state. Every registered type keeps its own live object so
 * switching types preserves what each one was tuned to, and so Tweakpane can
 * bind to a stable object reference that never has to be torn down.
 *
 * Registering a new type adds one property here.
 */
export interface CheckpointLayouts {
  circular: CircularLayoutConfig;
  [typeId: string]: object;
}

/**
 * The whole tunable state of the sandbox. Prop sections are shared across
 * checkpoint types; only `layouts` is per-type.
 */
export interface CheckpointConfig {
  typeId: string;
  layouts: CheckpointLayouts;
  /** Paving masonry for the active type's shell. */
  stone: StoneConfig;
  bevel: BevelConfig;
  pillar: PillarConfig;
  fireBowl: FireBowlConfig;
  fire: FireConfig;
  offering: OfferingConfig;
  illumination: IlluminationConfig;
  view: ViewConfig;
}

export function createDefaultCheckpointConfig(): CheckpointConfig {
  return {
    typeId: "circular",
    layouts: {
      circular: cloneCircularLayout(),
    },
    stone: cloneStoneConfig(DEFAULT_CIRCULAR_STONE),
    bevel: cloneBevelConfig(DEFAULT_CIRCULAR_BEVEL),
    pillar: clonePillarConfig(DEFAULT_PILLAR_CONFIG),
    fireBowl: cloneFireBowlConfig(DEFAULT_FIRE_BOWL_CONFIG),
    fire: cloneFireConfig(DEFAULT_FIRE_CONFIG),
    offering: cloneOfferingConfig(DEFAULT_OFFERING_CONFIG),
    illumination: cloneIlluminationConfig(DEFAULT_ILLUMINATION_CONFIG),
    view: { ...DEFAULT_VIEW_CONFIG },
  };
}

/**
 * Which part sections a control change invalidates. Transcribed from the
 * rebuild split the pane used before this refactor, so dragging any given
 * slider costs what it always did rather than regenerating everything.
 *
 * Fire bowls follow pillars because a bowl is sized from `pillar.shaftWidth`
 * and mounted at `pillar.height`.
 */
export const SECTIONS_BY_SCOPE: Readonly<Record<RebuildScope, readonly PartSection[]>> = {
  layout: ["layout"],
  pillars: ["pillars", "fireBowls"],
  bowls: ["fireBowls"],
  fire: [],
  offering: [],
  material: [],
  illumination: [],
  view: [],
};

export function sectionsForScopes(
  scopes: Iterable<RebuildScope>,
): Set<PartSection> {
  const sections = new Set<PartSection>();

  for (const scope of scopes) {
    for (const section of SECTIONS_BY_SCOPE[scope]) {
      sections.add(section);
    }
  }

  return sections;
}
