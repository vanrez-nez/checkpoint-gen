import { controlsFor, type ControlSpec, type RebuildScope } from "../config/control-spec";
import type {
  MaterialSurfaceId,
  StructureMaterialPalette,
} from "../config/material-palette";
import type { BevelConfig, StoneConfig } from "../config/sections";
import type {
  CompositionAnchors,
  GeometryPart,
  PartSection,
} from "../geometry/part";
import type { FireBowlConfig } from "../props/fire-bowl/config";
import type { PillarConfig } from "../props/pillar/config";
import type { StructureGraph } from "./kernel/graph";
import type { SlotFeatureConfig } from "./kernel/slot";

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
  | "offering"
  | "materialPalette";

/**
 * One structure-owned page in the control pane.
 *
 * Layout controls are routed by their existing folder group, while shared prop
 * controls are routed by prop id. `defineStructure` verifies that every layout
 * group and every declared prop belongs to exactly one tab, so adding a family
 * cannot silently leave controls behind on a global page.
 */
export interface StructureControlTab {
  readonly id: string;
  readonly label: string;
  readonly layoutGroups?: readonly string[];
  readonly props?: readonly PropId[];
}

/**
 * One slot-bearing feature of a structure, and where its settings live.
 *
 * Declared rather than inferred because the pane, the geometry code and the
 * validator all have to agree on the same list, and a feature that reaches one
 * of them but not the others is either an untabbed folder or a setting nobody
 * can edit. `label` doubles as the control folder's title and the layout group
 * a tab assigns, so a feature is tabbed exactly like any other group.
 */
export interface SlotFeatureSpec<TLayout extends object> {
  readonly id: string;
  readonly label: string;
  /**
   * Whether a border can be drawn around this feature's field.
   *
   * False where the border is already real geometry — a pier panel's raised
   * rails, a decorated slab's proud face. Offering an inset there would be a
   * setting that moves nothing, so the feature gets a switch and no more.
   */
  readonly framed?: boolean;
  /** The feature's own settings, in place on the layout so edits land there. */
  select(layout: TLayout): SlotFeatureConfig;
}

const slotControl = controlsFor<SlotFeatureConfig>();

/**
 * The controls every slot feature gets, generated per feature.
 *
 * Mirrors `MATERIAL_SURFACE_CONTROLS`: one table per repeated entity, grouped
 * under that entity's own label and bound to its own sub-object, so the shape
 * is authored once and every feature stays in step with it.
 */
export function slotFeatureControls(
  label: string,
  framed = true,
): readonly ControlSpec<SlotFeatureConfig>[] {
  const enabled = (feature: SlotFeatureConfig) => feature.enabled;
  const shown = [
    slotControl.boolean({
      key: "enabled",
      label: "enabled",
      name: `${label} slots`,
      group: label,
      scopes: ["layout"],
    }),
    slotControl.number({
      key: "borderWidth",
      label: "border",
      name: `${label} slot border`,
      group: label,
      min: 0,
      max: 0.6,
      step: 0.005,
      scopes: ["layout"],
      visibleWhen: enabled,
    }),
    slotControl.number({
      key: "insetU",
      label: "inset u",
      name: `${label} slot horizontal inset`,
      group: label,
      min: 0,
      max: 0.6,
      step: 0.005,
      scopes: ["layout"],
      visibleWhen: enabled,
    }),
    slotControl.number({
      key: "insetV",
      label: "inset v",
      name: `${label} slot vertical inset`,
      group: label,
      min: 0,
      max: 0.6,
      step: 0.005,
      scopes: ["layout"],
      visibleWhen: enabled,
    }),
  ];

  return framed ? shown : shown.slice(0, 1);
}

export interface StructureBuildInput<TLayout extends object> {
  readonly layout: TLayout;
  /** Repaint every published slot in the debug surface. A scene setting. */
  readonly debugSlots: boolean;
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
  /** The structure-specific tabs and the controls assigned to each one. */
  readonly controlTabs: readonly StructureControlTab[];
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
  /** Per-family surface defaults; control shapes remain shared. */
  readonly defaultStone?: Readonly<StoneConfig>;
  readonly defaultBevel?: Readonly<BevelConfig>;
  /** Material defaults, and the surfaces this family actually dresses. */
  readonly defaultMaterialPalette?: Readonly<StructureMaterialPalette>;
  readonly materialSurfaces?: readonly MaterialSurfaceId[];
  readonly layoutControls: readonly ControlSpec<TLayout>[];
  /** Slot-bearing features, each with its own settings folder. */
  readonly slotFeatures?: readonly SlotFeatureSpec<TLayout>[];
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
  validateControlTabs(definition);
  return definition as unknown as StructureDefinition;
}

function validateControlTabs<TLayout extends object>(
  definition: StructureDefinition<TLayout>,
): void {
  if (definition.controlTabs.length === 0) {
    throw new Error(`${definition.id}: at least one control tab is required.`);
  }

  assertUnique(
    definition.controlTabs.map((tab) => tab.id),
    `${definition.id}: control tab ids`,
  );
  assertUnique(
    definition.controlTabs.map((tab) => tab.label),
    `${definition.id}: control tab labels`,
  );
  assertUnique(definition.props, `${definition.id}: props`);

  assertUnique(
    (definition.slotFeatures ?? []).map((feature) => feature.id),
    `${definition.id}: slot feature ids`,
  );

  // A feature's label is a layout group like any other, so the same bijection
  // catches a features folder nobody put on a tab.
  const layoutGroups = new Set([
    ...definition.layoutControls.map((control) => control.group),
    ...(definition.slotFeatures ?? []).map((feature) => feature.label),
  ]);
  const assignedGroups = definition.controlTabs.flatMap(
    (tab) => [...(tab.layoutGroups ?? [])],
  );
  const assignedProps = definition.controlTabs.flatMap(
    (tab) => [...(tab.props ?? [])],
  );

  assertUnique(assignedGroups, `${definition.id}: assigned layout groups`);
  assertUnique(assignedProps, `${definition.id}: assigned props`);

  for (const group of assignedGroups) {
    if (!layoutGroups.has(group)) {
      throw new Error(
        `${definition.id}: control tab assigns unknown layout group "${group}".`,
      );
    }
  }

  for (const group of layoutGroups) {
    if (!assignedGroups.includes(group)) {
      throw new Error(
        `${definition.id}: layout group "${group}" is not assigned to a control tab.`,
      );
    }
  }

  for (const prop of assignedProps) {
    if (!definition.props.includes(prop)) {
      throw new Error(
        `${definition.id}: control tab assigns undeclared prop "${prop}".`,
      );
    }
  }

  for (const prop of definition.props) {
    if (!assignedProps.includes(prop)) {
      throw new Error(
        `${definition.id}: prop "${prop}" is not assigned to a control tab.`,
      );
    }
  }
}

function assertUnique(values: readonly string[], subject: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${subject} must be unique.`);
  }
}

/** True when the structure uses every prop in `required`. */
export function usesProps(
  definition: StructureDefinition,
  ...required: readonly PropId[]
): boolean {
  return required.every((prop) => definition.props.includes(prop));
}
