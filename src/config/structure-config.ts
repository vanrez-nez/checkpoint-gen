import {
  cloneStructureEngravings,
  validateStructureEngravings,
  type StructureEngravings,
} from "../engravings/config";
import type { PartSection } from "../geometry/part";
import type { StructureDefinition } from "../structure/definition";
import {
  DEFAULT_STRUCTURE_ID,
  getStructure,
  listStructures,
} from "../structure/registry";
import {
  DEFAULT_FIRE_BOWL_CONFIG,
  cloneFireBowlConfig,
  validateFireBowlConfig,
  type FireBowlConfig,
} from "../props/fire-bowl/config";
import {
  DEFAULT_FIRE_CONFIG,
  cloneFireConfig,
  validateFireConfig,
  type FireConfig,
} from "../props/fire/config";
import {
  DEFAULT_OFFERING_CONFIG,
  cloneOfferingConfig,
  validateOfferingConfig,
  type OfferingConfig,
} from "../props/offering/config";
import {
  DEFAULT_PILLAR_CONFIG,
  clonePillarConfig,
  validatePillarConfig,
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
  validateBevelConfig,
  validateIlluminationConfig,
  validateStoneConfig,
  validateViewConfig,
  type BevelConfig,
  type IlluminationConfig,
  type StoneConfig,
  type ViewConfig,
} from "./sections";
import type { RebuildScope } from "./control-spec";
import {
  DEFAULT_STRUCTURE_MATERIAL_PALETTE,
  cloneMaterialPalette,
  validateMaterialPalette,
  type StructureMaterialPalette,
} from "./material-palette";

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
 * The whole tunable state of the sandbox. Structural surface state is keyed by
 * family just like layout state, so switching type preserves each structure's
 * own tuned defaults and subsequent edits. Composition props remain shared.
 */
export interface StructureConfig {
  typeId: string;
  layouts: StructureLayouts;
  stones: Record<string, StoneConfig>;
  bevels: Record<string, BevelConfig>;
  materialPalettes: Record<string, StructureMaterialPalette>;
  /** Which engraving each slot-bearing feature carries, keyed by structure. */
  engravings: Record<string, StructureEngravings>;
  pillar: PillarConfig;
  /**
   * The bowl and its flame, keyed by structure.
   *
   * Per structure rather than shared, because these are the two props both
   * families declare and the only ones that were ever linked — `pillar` and
   * `offering` belong to the circular checkpoint alone, so nothing could
   * observe them being global. A brazier sized for a circular hearth is not the
   * one that belongs on a pyramid's parapet terminals, and tuning one used to
   * retune the other behind your back.
   */
  fireBowls: Record<string, FireBowlConfig>;
  fires: Record<string, FireConfig>;
  offering: OfferingConfig;
  illumination: IlluminationConfig;
  view: ViewConfig;
}

export function createDefaultStructureConfig(): StructureConfig {
  const layouts: StructureLayouts = {};
  const stones: Record<string, StoneConfig> = {};
  const bevels: Record<string, BevelConfig> = {};
  const materialPalettes: Record<string, StructureMaterialPalette> = {};
  const engravings: Record<string, StructureEngravings> = {};
  const fireBowls: Record<string, FireBowlConfig> = {};
  const fires: Record<string, FireConfig> = {};

  // Every registered structure gets its live layout up front, so the pane can
  // bind all of them once. Surface objects follow the same rule, allowing one
  // shared control schema to expose family-specific values without rebinding.
  for (const definition of listStructures()) {
    layouts[definition.id] = definition.cloneLayout();
    stones[definition.id] = cloneStoneConfig(
      definition.defaultStone ?? DEFAULT_STONE_CONFIG,
    );
    bevels[definition.id] = cloneBevelConfig(
      definition.defaultBevel ?? DEFAULT_BEVEL_CONFIG,
    );
    materialPalettes[definition.id] = cloneMaterialPalette(
      definition.defaultMaterialPalette ?? DEFAULT_STRUCTURE_MATERIAL_PALETTE,
    );
    // A structure with no slot-bearing features gets an empty record rather
    // than no record, so every reader can index without a presence check.
    engravings[definition.id] = cloneStructureEngravings(definition);
    // Seeded for every structure, not only those declaring the props: the pane
    // binds all of them once, and a family that gains a fire later must not
    // find a missing record.
    fireBowls[definition.id] = cloneFireBowlConfig(DEFAULT_FIRE_BOWL_CONFIG);
    fires[definition.id] = cloneFireConfig(DEFAULT_FIRE_CONFIG);
  }

  return {
    typeId: DEFAULT_STRUCTURE_ID,
    layouts,
    stones,
    bevels,
    materialPalettes,
    engravings,
    pillar: clonePillarConfig(DEFAULT_PILLAR_CONFIG),
    fireBowls,
    fires,
    offering: cloneOfferingConfig(DEFAULT_OFFERING_CONFIG),
    illumination: cloneIlluminationConfig(DEFAULT_ILLUMINATION_CONFIG),
    view: { ...DEFAULT_VIEW_CONFIG },
  };
}

/**
 * The fire and bowl belonging to whichever structure is selected.
 *
 * A named accessor rather than an index at each call site, because there are
 * six of them across the scene and the composer and every one of them wants the
 * same record — and because a missing one is a broken config rather than a
 * `undefined` to be threaded onward.
 */
export function activeFire(config: StructureConfig): FireConfig {
  const fire = config.fires[config.typeId];

  if (!fire) {
    throw new Error(`Missing fire config for structure "${config.typeId}".`);
  }

  return fire;
}

export function activeFireBowl(config: StructureConfig): FireBowlConfig {
  const bowl = config.fireBowls[config.typeId];

  if (!bowl) {
    throw new Error(
      `Missing fire bowl config for structure "${config.typeId}".`,
    );
  }

  return bowl;
}

/**
 * Captures a detached copy of the complete live configuration.
 *
 * The pane uses this as its last-known-good checkpoint. Keeping the snapshot
 * detached is important because Tweakpane writes a binding before the shared
 * validation boundary has a chance to accept or reject that edit.
 */
export function snapshotStructureConfig(
  config: StructureConfig,
): StructureConfig {
  return structuredClone(config);
}

/**
 * Restores a snapshot without replacing any existing config object or array.
 * Tweakpane bindings retain references to those nested values, so assigning a
 * fresh top-level config would leave the controls attached to stale state.
 */
export function restoreStructureConfig(
  config: StructureConfig,
  snapshot: Readonly<StructureConfig>,
): void {
  restoreRecord(
    config as unknown as Record<string, unknown>,
    snapshot as unknown as Readonly<Record<string, unknown>>,
  );
}

function restoreRecord(
  target: Record<string, unknown>,
  source: Readonly<Record<string, unknown>>,
): void {
  for (const key of Object.keys(target)) {
    if (!(key in source)) {
      delete target[key];
    }
  }

  for (const [key, value] of Object.entries(source)) {
    const current = target[key];

    if (isPlainRecord(current) && isPlainRecord(value)) {
      restoreRecord(current, value);
    } else if (Array.isArray(current) && Array.isArray(value)) {
      current.splice(0, current.length, ...structuredClone(value));
    } else {
      target[key] = structuredClone(value);
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates every parameter that can affect the active composition before any
 * cached geometry or render state is mutated.
 *
 * Inactive families keep independent live state and are validated when
 * selected; validating them here would make it impossible to switch away from
 * an invalid family in order to keep working on another one.
 */
export function validateActiveStructureConfig(config: StructureConfig): void {
  validateActiveStructureGeometryConfig(config);
  const definition = getStructure(config.typeId);
  const palette = config.materialPalettes[definition.id];

  if (!palette) {
    throw new Error(
      `Missing material palette for structure "${definition.id}".`,
    );
  }

  validateMaterialPalette(palette);
  // Deliberately here rather than in the geometry validator below: an engraving
  // dresses a slot without changing the stone it is cut into, so it must never
  // become part of whether a structure is encodable.
  validateStructureEngravings(definition, config.engravings[definition.id] ?? {});
  validateIlluminationConfig(config.illumination);
  validateViewConfig(config.view);
}

/**
 * Validates only the state owned by the selected structure.
 *
 * This is deliberately separate from `validateActiveStructureConfig`: URL
 * geometry codes use this boundary, so a camera/debug/lighting value can never
 * become part of whether a structure is encodable.
 */
export function validateActiveStructureGeometryConfig(
  config: StructureConfig,
): void {
  const definition = getStructure(config.typeId);
  const layout = config.layouts[definition.id];

  if (!layout) {
    throw new Error(`Missing layout config for structure "${definition.id}".`);
  }

  definition.validateLayout(layout);

  if (definition.props.includes("stone")) {
    const stone = config.stones[definition.id];

    if (!stone) {
      throw new Error(`Missing stone config for structure "${definition.id}".`);
    }

    validateStoneConfig(stone);
  }
  if (definition.props.includes("bevel")) {
    const bevel = config.bevels[definition.id];

    if (!bevel) {
      throw new Error(`Missing bevel config for structure "${definition.id}".`);
    }

    validateBevelConfig(bevel);
  }
  if (definition.props.includes("pillar")) {
    validatePillarConfig(config.pillar);
  }
  if (definition.props.includes("fireBowl")) {
    const fireBowl = config.fireBowls[definition.id];

    if (!fireBowl) {
      throw new Error(
        `Missing fire bowl config for structure "${definition.id}".`,
      );
    }

    validateFireBowlConfig(
      fireBowl,
      definition.props.includes("pillar") ? config.pillar.shaftWidth : 1,
    );
  }
  if (definition.props.includes("fire")) {
    const fire = config.fires[definition.id];

    if (!fire) {
      throw new Error(`Missing fire config for structure "${definition.id}".`);
    }

    validateFireConfig(fire);
  }
  if (definition.props.includes("offering")) {
    validateOfferingConfig(config.offering);
  }
}

/**
 * Which part sections a control change invalidates, for the prop sections every
 * structure shares. Transcribed from the rebuild split the pane used before this
 * refactor, so dragging any given slider costs what it always did rather than
 * regenerating everything.
 *
 * Pillar changes rebuild attached circular bowls. Structures with independent
 * bowl slots, such as Mass parapet terminals, use only the bowl scope.
 */
export const SECTIONS_BY_SCOPE: Readonly<Record<RebuildScope, readonly PartSection[]>> = {
  layout: ["layout"],
  pillars: ["pillars", "fireBowls"],
  bowls: ["fireBowls"],
  fire: [],
  offering: [],
  material: [],
  // Invalidates nothing, like `material`: a decal is built from the published
  // slot table rather than from the mesh, so changing one never makes any part
  // of the structure stale.
  engraving: [],
  illumination: [],
  // Invalidates nothing: a level change does not make any section stale, it
  // asks for the same sections somewhere else. The composer works out what is
  // missing at the requested level on its own.
  detail: [],
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
