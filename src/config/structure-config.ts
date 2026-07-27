import type { PartSection } from "../geometry/part";
import type { StructureDefinition } from "../structure/definition";
import {
  DEFAULT_STRUCTURE_ID,
  listStructures,
} from "../structure/registry";
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
  DEFAULT_BEVEL_CONFIG,
  DEFAULT_ILLUMINATION_CONFIG,
  DEFAULT_STONE_CONFIG,
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
 * Per-structure layout state, keyed by structure id. Every registered structure
 * keeps its own live object so switching structures preserves what each one was
 * tuned to, and so Tweakpane can bind to a stable object reference that never
 * has to be torn down.
 *
 * Keys come from the registry rather than being declared here, so registering a
 * structure is still a single line in STRUCTURES.
 */
export type StructureLayouts = Record<string, object>;

/**
 * The whole tunable state of the sandbox. Prop sections are shared across
 * structures; only `layouts` is per-structure.
 */
export interface StructureConfig {
  typeId: string;
  layouts: StructureLayouts;
  /** Paving masonry for the active structure's shell. */
  stone: StoneConfig;
  bevel: BevelConfig;
  pillar: PillarConfig;
  fireBowl: FireBowlConfig;
  fire: FireConfig;
  offering: OfferingConfig;
  illumination: IlluminationConfig;
  view: ViewConfig;
}

export function createDefaultStructureConfig(): StructureConfig {
  const layouts: StructureLayouts = {};

  // Every registered structure gets its live layout up front, so the pane can
  // bind all of them once and a structure switch never has to create or tear
  // down a binding target.
  for (const definition of listStructures()) {
    layouts[definition.id] = definition.cloneLayout();
  }

  return {
    typeId: DEFAULT_STRUCTURE_ID,
    layouts,
    stone: cloneStoneConfig(DEFAULT_STONE_CONFIG),
    bevel: cloneBevelConfig(DEFAULT_BEVEL_CONFIG),
    pillar: clonePillarConfig(DEFAULT_PILLAR_CONFIG),
    fireBowl: cloneFireBowlConfig(DEFAULT_FIRE_BOWL_CONFIG),
    fire: cloneFireConfig(DEFAULT_FIRE_CONFIG),
    offering: cloneOfferingConfig(DEFAULT_OFFERING_CONFIG),
    illumination: cloneIlluminationConfig(DEFAULT_ILLUMINATION_CONFIG),
    view: { ...DEFAULT_VIEW_CONFIG },
  };
}

/**
 * Which part sections a control change invalidates, for the prop sections every
 * structure shares. Transcribed from the rebuild split the pane used before this
 * refactor, so dragging any given slider costs what it always did rather than
 * regenerating everything.
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

/**
 * Resolves the sections a set of control scopes invalidates for one structure.
 *
 * A structure's own `sectionsByScope` wins where it declares a scope, because
 * section names are per-structure: a mass structure's "layout" scope invalidates
 * its "mass" section, not the circular checkpoint's "layout" section. Anything
 * it does not declare falls through to the shared prop table above.
 */
export function sectionsForScopes(
  scopes: Iterable<RebuildScope>,
  definition?: Pick<StructureDefinition, "sectionsByScope">,
): Set<PartSection> {
  const sections = new Set<PartSection>();

  for (const scope of scopes) {
    for (const section of definition?.sectionsByScope?.[scope] ?? SECTIONS_BY_SCOPE[scope]) {
      sections.add(section);
    }
  }

  return sections;
}
