import type { ControlSpec } from "../config/control-spec";
import type { BevelConfig, StoneConfig } from "../config/sections";
import type {
  CompositionAnchors,
  GeometryPart,
  PartSection,
} from "../geometry/part";
import type { FireBowlConfig } from "../props/fire-bowl/config";
import type { PillarConfig } from "../props/pillar/config";

/**
 * Shared props a checkpoint type can opt into. The pane shows a prop's controls
 * only when the active type declares it here.
 */
export type PropId =
  | "stone"
  | "bevel"
  | "pillar"
  | "fireBowl"
  | "fire"
  | "offering";

export interface CheckpointBuildInput<TLayout extends object> {
  readonly layout: TLayout;
  readonly stone: StoneConfig;
  readonly bevel: BevelConfig;
  readonly pillar: PillarConfig;
  readonly fireBowl: FireBowlConfig;
  /**
   * Sections needing fresh parts. A type may skip building anything else, but
   * must always return complete anchors — they are cheap and the scene needs
   * them on every build.
   */
  readonly sections: ReadonlySet<PartSection>;
}

export interface CheckpointTypeBuildResult {
  readonly parts: readonly GeometryPart[];
  readonly anchors: CompositionAnchors;
}

export interface CheckpointTypeDefinition<TLayout extends object = object> {
  readonly id: string;
  /** Shown in the type dropdown. */
  readonly label: string;
  readonly props: readonly PropId[];
  readonly defaultLayout: Readonly<TLayout>;
  readonly layoutControls: readonly ControlSpec<TLayout>[];
  cloneLayout(source?: Readonly<TLayout>): TLayout;
  validateLayout(layout: TLayout): void;
  build(input: CheckpointBuildInput<TLayout>): CheckpointTypeBuildResult;
}

/**
 * Erases the layout type so definitions with different layout shapes can share
 * one registry. This is the only place that cast lives; each definition stays
 * fully typed internally, and only its own `build` ever sees the real shape.
 */
export function defineCheckpointType<TLayout extends object>(
  definition: CheckpointTypeDefinition<TLayout>,
): CheckpointTypeDefinition {
  return definition as unknown as CheckpointTypeDefinition;
}

/** True when the type uses every prop in `required`. */
export function usesProps(
  definition: CheckpointTypeDefinition,
  ...required: readonly PropId[]
): boolean {
  return required.every((prop) => definition.props.includes(prop));
}
