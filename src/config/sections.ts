import type { StoneDetailConfig } from "../geometry/stone-builder";
import {
  DEFAULT_DETAIL_LEVEL,
  DETAIL_LEVEL_OPTIONS,
  type DetailLevel,
} from "../structure/kernel/detail";
import {
  controlsFor,
  validateControls,
  type ControlSpec,
  type RebuildScope,
} from "./control-spec";

/**
 * Masonry tuning shared by every stone-built prop. The shell and the pillars
 * each own an instance with their own values; only the shape and the ranges are
 * shared.
 */
export interface StoneConfig {
  seed: number;
  gapRatio: number;
  sizeVariation: number;
  displacement: number;
}

/** Chamfer tuning, paired with a StoneConfig on every stone-built prop. */
export interface BevelConfig {
  enabled: boolean;
  widthRatio: number;
  depthRatio: number;
  variation: number;
}

/**
 * Baseline masonry, shared by every structure that opts into the `stone` and
 * `bevel` props. These values were tuned against the circular checkpoint, which
 * is the default structure; a structure that declares neither prop never reads
 * them.
 */
export const DEFAULT_STONE_CONFIG: Readonly<StoneConfig> = {
  seed: 741,
  gapRatio: 0.006,
  sizeVariation: 0.33,
  displacement: 0.08,
};

export const DEFAULT_BEVEL_CONFIG: Readonly<BevelConfig> = {
  enabled: true,
  widthRatio: 0.03,
  depthRatio: 0.11,
  variation: 0.6,
};

/**
 * How the structure is presented rather than what it is.
 *
 * Two of these do reach geometry generation — `slotDebug` and `detailLevel` —
 * because only the builder knows what they mean and neither can be applied
 * after the fact. What makes them belong here anyway is that neither is part of
 * a structure's identity: the same structure debug-tinted, or laid at a coarser
 * level, is still the same structure. That is why `collectFields` never reads
 * this section, and so nothing here is ever encoded into the URL.
 */
export interface ViewConfig {
  wireframe: boolean;
  /** Wireframe stroke width in pixels. Wide lines, not GL_LINES' fixed 1px. */
  wireframeWidth: number;
  vertexNormals: boolean;
  /**
   * Replaces the surface materials with a neutral matte, so massing can be
   * judged on silhouette and proportion rather than on how the stone reads.
   */
  greybox: boolean;
  /**
   * Draws the semantic layer: one frame per patch, coloured by role. Without it
   * only the silhouette is visible, and the patches are the part that actually
   * has to be right.
   */
  patchDebug: boolean;
  /**
   * Reddens every published engraving slot, whatever family is loaded.
   *
   * The slot table is otherwise invisible, and the only way to check that what
   * was reserved is what got prepared is to see the two coincide.
   */
  slotDebug: boolean;
  /**
   * How much geometry the structure spends on itself.
   *
   * Coarser levels are regenerated from the kernel rather than simplified from
   * the finished mesh, so every per-vertex channel stays correct by
   * construction. See `structure/kernel/detail.ts` for the ladder itself.
   */
  detailLevel: DetailLevel;
  materialScale: number;
}

export const DEFAULT_VIEW_CONFIG: Readonly<ViewConfig> = {
  wireframe: false,
  wireframeWidth: 1.5,
  vertexNormals: false,
  greybox: false,
  patchDebug: false,
  slotDebug: false,
  detailLevel: DEFAULT_DETAIL_LEVEL,
  materialScale: 1,
};

/** Lighting, plus the two baked-attribute strengths driven from userData. */
export interface IlluminationConfig {
  keyColor: string;
  keyIntensity: number;
  keyAzimuth: number;
  keyElevation: number;
  skyColor: string;
  groundColor: string;
  ambientIntensity: number;
  ambientOcclusion: number;
  crackShadow: number;
  /** Weight of the baked sun occlusion. The sun casts no realtime shadow. */
  sunShadow: number;
}

export const DEFAULT_ILLUMINATION_CONFIG: Readonly<IlluminationConfig> = {
  keyColor: "#cce2ff",
  keyIntensity: 0.6,
  keyAzimuth: -74,
  keyElevation: 26,
  skyColor: "#f3f7ff",
  groundColor: "#4c5047",
  ambientIntensity: 0.23,
  ambientOcclusion: 0.75,
  crackShadow: 1,
  sunShadow: 1,
};

/**
 * Colour pickers are bound by hand in the pane; only the numeric fields are
 * spec-driven, since ControlSpec deliberately covers numbers and booleans only.
 */
export const ILLUMINATION_COLOR_KEYS = [
  { key: "keyColor", label: "sun color" },
  { key: "skyColor", label: "sky color" },
  { key: "groundColor", label: "ground color" },
] as const;

const stone = controlsFor<StoneConfig>();
const bevel = controlsFor<BevelConfig>();
const view = controlsFor<ViewConfig>();
const illumination = controlsFor<IlluminationConfig>();

/**
 * Stone controls for one owner. Scopes differ per owner (the shell rebuilds the
 * layout section, a pillar rebuilds the pillar section) while the ranges and
 * validation names are identical, so the table is generated rather than copied.
 */
export function createStoneControls(
  scopes: readonly RebuildScope[],
): readonly ControlSpec<StoneConfig>[] {
  return [
    stone.number({
      key: "seed",
      group: "Stones",
      name: "Seed",
      min: 0,
      max: 9999,
      step: 1,
      integer: true,
      scopes,
    }),
    stone.number({
      key: "gapRatio",
      label: "gap",
      name: "Stone gap ratio",
      group: "Stones",
      min: 0.002,
      max: 0.04,
      step: 0.001,
      scopes,
    }),
    stone.number({
      key: "sizeVariation",
      label: "size variation",
      name: "Size variation",
      group: "Stones",
      min: 0.05,
      max: 0.4,
      step: 0.01,
      scopes,
    }),
    stone.number({
      key: "displacement",
      label: "displacement",
      name: "Displacement",
      group: "Stones",
      min: 0.01,
      max: 0.2,
      step: 0.01,
      scopes,
    }),
  ];
}

export function createBevelControls(
  scopes: readonly RebuildScope[],
): readonly ControlSpec<BevelConfig>[] {
  return [
    bevel.boolean({
      key: "enabled",
      label: "enabled",
      name: "Bevel enabled",
      group: "Bevel",
      scopes,
    }),
    bevel.number({
      key: "widthRatio",
      label: "width",
      name: "Bevel width ratio",
      group: "Bevel",
      min: 0.02,
      max: 0.3,
      step: 0.01,
      scopes,
    }),
    bevel.number({
      key: "depthRatio",
      label: "depth",
      name: "Bevel depth ratio",
      group: "Bevel",
      min: 0.05,
      max: 0.6,
      step: 0.01,
      scopes,
    }),
    bevel.number({
      key: "variation",
      label: "variation",
      name: "Bevel variation",
      group: "Bevel",
      min: 0,
      max: 0.6,
      step: 0.01,
      scopes,
    }),
  ];
}

export const VIEW_CONTROLS: readonly ControlSpec<ViewConfig>[] = [
  view.boolean({ key: "wireframe", group: "View", name: "Wireframe", scopes: ["view"] }),
  view.number({
    key: "wireframeWidth",
    label: "line width",
    name: "Wireframe line width",
    group: "View",
    min: 1,
    max: 6,
    step: 0.25,
    scopes: ["view"],
    visibleWhen: (config) => config.wireframe,
  }),
  view.boolean({
    key: "vertexNormals",
    label: "vertex normals",
    name: "Vertex normals",
    group: "View",
    scopes: ["view"],
  }),
  view.list({
    key: "detailLevel",
    label: "detail",
    name: "Detail level",
    group: "View",
    options: DETAIL_LEVEL_OPTIONS,
    scopes: ["detail"],
  }),
  view.boolean({
    key: "greybox",
    label: "greybox shading",
    name: "Greybox shading",
    group: "View",
    scopes: ["view"],
  }),
  view.boolean({
    key: "patchDebug",
    label: "patch debug",
    name: "Patch debug",
    group: "View",
    scopes: ["view"],
  }),
  view.boolean({
    key: "slotDebug",
    label: "slot debug",
    name: "Slot debug tint",
    group: "View",
    // Deliberately not the "view" scope. A slot is repainted while the geometry
    // is built, because only the builder knows which quad answers to which
    // slot — and `SECTIONS_BY_SCOPE.view` invalidates nothing, so a view-scoped
    // toggle would never reach it. The flag still stays out of the geometry
    // code: `collectFields` never reads `config.view`.
    scopes: ["layout"],
  }),
  view.number({
    key: "materialScale",
    label: "material scale",
    name: "Material scale",
    group: "Material",
    min: 0.1,
    max: 4,
    step: 0.05,
    scopes: ["material"],
  }),
];

export const ILLUMINATION_CONTROLS: readonly ControlSpec<IlluminationConfig>[] = [
  illumination.number({
    key: "keyIntensity",
    label: "sun intensity",
    name: "Sun intensity",
    group: "Illumination",
    min: 0,
    max: 10,
    step: 0.1,
    scopes: ["illumination"],
  }),
  illumination.number({
    key: "keyAzimuth",
    label: "sun azimuth",
    name: "Sun azimuth",
    group: "Illumination",
    min: -180,
    max: 180,
    step: 1,
    scopes: ["illumination"],
  }),
  illumination.number({
    key: "keyElevation",
    label: "sun elevation",
    name: "Sun elevation",
    group: "Illumination",
    min: 5,
    max: 90,
    step: 1,
    scopes: ["illumination"],
  }),
  illumination.number({
    key: "ambientIntensity",
    label: "hemisphere intensity",
    name: "Hemisphere intensity",
    group: "Illumination",
    min: 0,
    max: 5,
    step: 0.05,
    scopes: ["illumination"],
  }),
  illumination.number({
    key: "ambientOcclusion",
    label: "AO strength",
    name: "Ambient occlusion strength",
    group: "Illumination",
    min: 0,
    max: 1,
    step: 0.01,
    scopes: ["illumination"],
  }),
  illumination.number({
    key: "crackShadow",
    label: "crack shadow",
    name: "Crack shadow",
    group: "Illumination",
    min: 0,
    max: 1,
    step: 0.01,
    scopes: ["illumination"],
  }),
  illumination.number({
    key: "sunShadow",
    label: "sun shadow",
    name: "Baked sun shadow",
    group: "Illumination",
    min: 0,
    max: 1,
    step: 0.01,
    scopes: ["illumination"],
  }),
];

export function cloneIlluminationConfig(
  source: Readonly<IlluminationConfig>,
): IlluminationConfig {
  return { ...source };
}

/** Flattens a stone/bevel pair into the shape the stone builder expects. */
export function toStoneDetail(
  stoneConfig: StoneConfig,
  bevelConfig: BevelConfig,
): StoneDetailConfig {
  return {
    seed: stoneConfig.seed,
    bevelEnabled: bevelConfig.enabled,
    bevelWidthRatio: bevelConfig.widthRatio,
    bevelDepthRatio: bevelConfig.depthRatio,
    bevelVariation: bevelConfig.variation,
  };
}

export function cloneStoneConfig(source: Readonly<StoneConfig>): StoneConfig {
  return { ...source };
}

export function cloneBevelConfig(source: Readonly<BevelConfig>): BevelConfig {
  return { ...source };
}

/** Validates every tunable field in one structure-owned stone surface. */
export function validateStoneConfig(config: StoneConfig): void {
  validateControls(config, createStoneControls([]));
}

/** Validates every tunable field in one structure-owned bevel surface. */
export function validateBevelConfig(config: BevelConfig): void {
  validateControls(config, createBevelControls([]));
}

export function validateViewConfig(config: ViewConfig): void {
  validateControls(config, VIEW_CONTROLS);
}

export function validateIlluminationConfig(config: IlluminationConfig): void {
  validateControls(config, ILLUMINATION_CONTROLS);

  for (const { key, label } of ILLUMINATION_COLOR_KEYS) {
    const value = config[key];

    if (
      typeof value !== "string"
      || !/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)
    ) {
      throw new RangeError(`${label} must be a hexadecimal color.`);
    }
  }
}
