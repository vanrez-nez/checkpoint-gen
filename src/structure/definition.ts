import type { ControlSpec, RebuildScope } from "../config/control-spec";
import type { BevelConfig, StoneConfig } from "../config/sections";
import type {
  CompositionAnchors,
  GeometryPart,
  PartSection,
} from "../geometry/part";
import type { FireBowlConfig } from "../props/fire-bowl/config";
import type { PillarConfig } from "../props/pillar/config";
import type { StructureGraph } from "./kernel/graph";

/**
 * Shared props a structure can opt into. The pane shows a prop's controls only
 * when the active structure declares it here.
 */
export type PropId =
  | "stone"
  | "bevel"
  | "pillar"
  | "fireBowl"
  | "fire"
  | "offering";

export interface StructureBuildInput<TLayout extends object> {
  readonly layout: TLayout;
  readonly stone: StoneConfig;
  readonly bevel: BevelConfig;
  readonly pillar: PillarConfig;
  readonly fireBowl: FireBowlConfig;
  /**
   * Sections needing fresh parts. A structure may skip building anything else,
   * but must always return complete anchors — they are cheap and the scene
   * needs them on every build.
   */
  readonly sections: ReadonlySet<PartSection>;
}

export interface StructureBuildResult {
  readonly parts: readonly GeometryPart[];
  readonly anchors: CompositionAnchors;
  /**
   * The semantic layer this build resolved, when the structure has one.
   *
   * Returned on every build, like anchors — resolving it is arithmetic, and the
   * scene needs it for the patch overlay and the diagnostics readout even on a
   * rebuild that regenerated no geometry. Structures predating the kernel simply
   * omit it.
   */
  readonly graph?: StructureGraph | null;
}

export interface StructureDefinition<TLayout extends object = object> {
  readonly id: string;
  /** Shown in the structure dropdown. */
  readonly label: string;
  readonly props: readonly PropId[];
  /**
   * Rebuild granularity for this structure, in merge order. The composer caches
   * and regenerates by section, and parts are emitted to the merged geometry in
   * the order declared here.
   */
  readonly sections: readonly PartSection[];
  /**
   * Overrides for which of this structure's sections a control scope
   * invalidates. Only scopes named here are overridden; the rest fall back to
   * the shared SECTIONS_BY_SCOPE table, which covers the prop scopes every
   * structure shares. A structure whose sections are named differently from the
   * shared ones must map at least the scopes its own controls use.
   */
  readonly sectionsByScope?: Partial<Record<RebuildScope, readonly PartSection[]>>;
  readonly defaultLayout: Readonly<TLayout>;
  readonly layoutControls: readonly ControlSpec<TLayout>[];
  cloneLayout(source?: Readonly<TLayout>): TLayout;
  validateLayout(layout: TLayout): void;
  build(input: StructureBuildInput<TLayout>): StructureBuildResult;
}

/**
 * Erases the layout type so definitions with different layout shapes can share
 * one registry. This is the only place that cast lives; each definition stays
 * fully typed internally, and only its own `build` ever sees the real shape.
 */
export function defineStructure<TLayout extends object>(
  definition: StructureDefinition<TLayout>,
): StructureDefinition {
  return definition as unknown as StructureDefinition;
}

/** True when the structure uses every prop in `required`. */
export function usesProps(
  definition: StructureDefinition,
  ...required: readonly PropId[]
): boolean {
  return required.every((prop) => definition.props.includes(prop));
}
