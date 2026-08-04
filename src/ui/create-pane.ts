import { Pane } from "tweakpane";
import type {
  BladeApi,
  FolderApi,
  TabApi,
  TabPageApi,
} from "@tweakpane/core";
import * as EssentialsPlugin from "@tweakpane/plugin-essentials";
import {
  structureOptions,
  getStructure,
} from "../structure/registry";
import {
  slotFeatureControls,
  type PropId,
  type StructureControlTab,
  type StructureDefinition,
} from "../structure/definition";
import {
  restoreStructureConfig,
  sectionsForScopes,
  snapshotStructureConfig,
  validateActiveStructureConfig,
  type StructureConfig,
} from "../config/structure-config";
import type { RebuildScope } from "../config/control-spec";
import {
  MATERIAL_SURFACE_CONTROLS,
  MATERIAL_SURFACE_IDS,
} from "../config/material-palette";
import {
  ILLUMINATION_COLOR_KEYS,
  ILLUMINATION_CONTROLS,
  VIEW_CONTROLS,
  createBevelControls,
  createStoneControls,
} from "../config/sections";
import { FIRE_CONTROLS } from "../props/fire/config";
import { FIRE_BOWL_CONTROLS } from "../props/fire-bowl/config";
import { OFFERING_CONTROLS } from "../props/offering/config";
import {
  PILLAR_BEVEL_CONTROLS,
  PILLAR_LAYOUT_CONTROLS,
  PILLAR_STONE_CONTROLS,
} from "../props/pillar/config";
import { emptyPartStats, type PartSection, type PartStats } from "../geometry/part";
import type { MainScene } from "../scene/main";
import { StatsBladeApi, StatsPanePluginBundle } from "../tweak-pane/stats-blade";
import {
  bindControls,
  createFolderRegistry,
  findControl,
  type BoundControl,
  type DispatchChange,
} from "./binder";
import {
  createStatMirrors,
  statRow,
  summarizeDiagnostics,
  type StatMirrors,
  type StatRow,
} from "./stats";
import { VisibilityRegistry } from "./visibility";
import { ValidationLog } from "./validation-log";

export interface ControlPaneOptions {
  container: HTMLElement;
  config: StructureConfig;
  scene: MainScene;
  rendererLabel: string;
  fireGlowShadowsSupported?: boolean;
  /** Called only after a valid structure-owned control has been applied. */
  onStructureConfigChange?: () => void;
}

export interface ControlPane {
  readonly stats: StatsBladeApi;
  /** Rebinds the tabs and regenerates after an external geometry-code restore. */
  reloadStructureConfig(): void;
  dispose(): void;
}

const SHARED_STONE_CONTROLS = createStoneControls(["layout"]);
const SHARED_BEVEL_CONTROLS = createBevelControls(["layout"]);

export function createControlPane(options: ControlPaneOptions): ControlPane {
  const {
    container,
    config,
    scene,
    rendererLabel,
    fireGlowShadowsSupported = true,
    onStructureConfigChange,
  } = options;
  const pane = new Pane({ container, title: "Structure" });
  pane.registerPlugin(StatsPanePluginBundle);
  // Supplies the cubic-bezier curve editor the shaping controls bind to.
  pane.registerPlugin(EssentialsPlugin);
  const stats = pane.addBlade({ view: "stats" }) as StatsBladeApi;
  stats.setRenderer(rendererLabel);
  const mirrors = createStatMirrors();
  const validationLog = new ValidationLog();

  // These rows describe whichever structure type is currently selected, so
  // they remain global and stable while the type-specific tab bar is rebuilt.
  for (const row of [
    statRow(mirrors.structure, "stones", "stones"),
    statRow(mirrors.structure, "vertices", "vertices"),
    statRow(mirrors.structure, "triangles", "triangles"),
    statRow(mirrors.structure, "generationMs", "generation (ms)"),
    statRow(mirrors.validation, "status", "status"),
  ]) {
    pane.addBinding(row.target as Record<string, number | string>, row.key, {
      label: row.label,
      readonly: true,
    });
  }

  const validationLogFolder = pane.addFolder({
    title: "Validation log",
    expanded: true,
  });
  validationLogFolder.addBinding(validationLog.mirror, "text", {
    label: "",
    readonly: true,
    multiline: true,
    rows: 8,
    bufferSize: 1,
    interval: 0,
  });
  validationLogFolder.addButton({ title: "Clear log" }).on("click", () => {
    validationLog.clear();
    pane.refresh();
  });

  let visibility = new VisibilityRegistry();
  let tabs: TabApi | null = null;
  let lastValidConfig = snapshotStructureConfig(config);

  // Global state, so it sits above the tab bar rather than inside a tab.
  pane.addBinding(config, "typeId", {
    label: "type",
    options: structureOptions(),
  }).on("change", (event) => {
    buildControlTabs();
    // Every section belongs to the previous type's layout, so rebuild all.
    dispatch(
      ["layout", "pillars", "bowls", "fire", "offering", "material"],
      { key: "typeId", label: "Structure type", value: event.value },
    );
  });

  buildControlTabs();
  refreshStats();
  visibility.apply(config);

  return {
    stats,
    reloadStructureConfig(): void {
      buildControlTabs();
      dispatch(["layout", "pillars", "bowls", "fire", "offering", "material"]);
    },
    dispose(): void {
      pane.dispose();
    },
  };

  function activeStructure() {
    return getStructure(config.typeId);
  }

  /**
   * Replaces the whole tab bar from the active structure's declaration.
   * Tweakpane cannot hide individual tab buttons reliably, so rebuilding this
   * one UI subtree is what makes irrelevant tabs genuinely absent rather than
   * present-but-empty. Config objects stay stable and retain their values.
   */
  function buildControlTabs(): void {
    tabs?.dispose();
    visibility = new VisibilityRegistry();

    const definition = activeStructure();
    tabs = pane.addTab({
      pages: [
        ...definition.controlTabs.map((tab) => ({ title: tab.label })),
        { title: "Scene" },
      ],
    });

    definition.controlTabs.forEach((tab, index) => {
      const page = tabs?.pages[index];

      if (!page) {
        throw new Error(`Failed to create "${tab.label}" control tab.`);
      }

      buildStructureTab(page, definition, tab);
    });

    const scenePage = tabs.pages[definition.controlTabs.length];

    if (!scenePage) {
      throw new Error("Failed to create Scene control tab.");
    }

    buildSceneTab(scenePage);
  }

  function dispatch(
    scopes: readonly RebuildScope[],
    change?: DispatchChange,
  ): void {
    const rejectedTypeId = config.typeId;

    try {
      validateActiveStructureConfig(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rejectedChange = change === undefined
        ? `External update (${scopes.join(", ") || "no rebuild scope"})`
        : `${change.label} (${change.key}) = ${formatLogValue(change.value)}`;
      restoreStructureConfig(config, lastValidConfig);
      mirrors.validation.status = `error: ${message}`;
      validationLog.rejected(rejectedChange, message);

      // A type change rebuilds the tabs before dispatch. If the newly selected
      // family's retained state is invalid, restore both the selector and the
      // tab bar to the last valid family.
      if (config.typeId !== rejectedTypeId) {
        buildControlTabs();
      }

      visibility.apply(config);
      pane.refresh();
      return;
    }

    // Resolved against the active structure, since a scope maps to whichever
    // sections that structure declares rather than to a fixed set.
    const sections = sectionsForScopes(scopes, activeStructure());

    if (sections.size > 0) {
      scene.rebuild(config, sections);
    } else if (scopes.includes("fire")) {
      scene.updateFireEffects(config);
    }

    if (scopes.includes("offering")) {
      scene.setOfferingConfig(config.offering);
    }
    if (scopes.includes("illumination")) {
      scene.setIllumination(config.illumination);
    }
    if (scopes.includes("material")) {
      scene.setMaterialScale(config.view.materialScale);
      const definition = activeStructure();
      const palette = config.materialPalettes[definition.id];

      if (palette) {
        void scene.setStructureMaterialPalette(
          palette,
          definition.materialSurfaces ?? ["stone"],
        );
      }
    }
    if (scopes.includes("view")) {
      scene.setWireframe(config.view.wireframe);
      scene.setWireframeWidth(config.view.wireframeWidth);
      scene.setVertexNormalsVisible(config.view.vertexNormals);
      scene.setGreybox(config.view.greybox);
      scene.setPatchDebugVisible(config.view.patchDebug);
    }

    refreshStats();
    visibility.apply(config);
    lastValidConfig = snapshotStructureConfig(config);

    if (scopes.some(isStructureScope)) {
      onStructureConfigChange?.();
    }
  }

  function refreshStats(): void {
    const sceneStats = scene.getStats();
    applyStats(mirrors, sceneStats, activeStructure().sections[0] ?? "");
    validationLog.diagnostics(sceneStats.diagnostics);
    pane.refresh();
  }

  function buildStructureTab(
    page: TabPageApi,
    definition: StructureDefinition,
    tab: StructureControlTab,
  ): void {
    const folders = createFolderRegistry();
    const layout = config.layouts[definition.id] ?? definition.cloneLayout();
    config.layouts[definition.id] = layout;
    const groups = new Set(tab.layoutGroups ?? []);
    const layoutControls = definition.layoutControls.filter(
      (control) => groups.has(control.group),
    );
    const bound = bindControls(
      page,
      layout,
      layoutControls,
      dispatch,
      folders,
    );

    for (const control of bound) {
      const { visibleWhen } = control.spec;
      visibility.addBlade(
        control.binding,
        () => visibleWhen === undefined || visibleWhen(layout),
        control.onShow,
      );
    }

    // A slot feature is one folder of its own settings, bound to its own
    // sub-object. Its label is the group a tab assigned, so it lands here.
    for (const feature of definition.slotFeatures ?? []) {
      if (!groups.has(feature.label)) {
        continue;
      }

      const target = feature.select(layout);
      const featureBound = bindControls(
        page,
        target,
        slotFeatureControls(feature.label, feature.framed),
        dispatch,
        folders,
      );

      for (const control of featureBound) {
        const { visibleWhen } = control.spec;
        visibility.addBlade(
          control.binding,
          () => visibleWhen === undefined || visibleWhen(target),
          control.onShow,
        );
      }
    }

    for (const prop of tab.props ?? []) {
      bindPropControls(page, definition, prop, folders);
    }

    autoHideFolders(folders);
    addPropStats(page, tab.props ?? []);
  }

  function bindPropControls(
    page: TabPageApi,
    definition: StructureDefinition,
    prop: PropId,
    folders: Map<string, FolderApi>,
  ): void {
    switch (prop) {
      case "stone": {
        const stone = config.stones[definition.id];

        if (!stone) {
          throw new Error(`Missing stone config for structure "${definition.id}".`);
        }

        bindControls(page, stone, SHARED_STONE_CONTROLS, dispatch, folders);
        return;
      }
      case "bevel": {
        const bevelConfig = config.bevels[definition.id];

        if (!bevelConfig) {
          throw new Error(`Missing bevel config for structure "${definition.id}".`);
        }

        const bevel = bindControls(
          page,
          bevelConfig,
          SHARED_BEVEL_CONTROLS,
          dispatch,
          folders,
        );
        gateBevelDetails(bevel, () => bevelConfig.enabled);
        return;
      }
      case "pillar":
        bindPillarControls(page, folders);
        return;
      case "fireBowl":
        bindFireBowlControls(page, folders);
        return;
      case "fire":
        bindFireControls(page, folders);
        return;
      case "offering":
        bindOfferingControls(page, folders);
        return;
      case "materialPalette": {
        const palette = config.materialPalettes[definition.id];

        if (!palette) {
          throw new Error(
            `Missing material palette for structure "${definition.id}".`,
          );
        }

        // One folder per dressed surface, holding that surface's material and
        // texture scale together, in the order the surfaces are declared rather
        // than the order this structure happens to list them.
        const surfaces = new Set(definition.materialSurfaces ?? ["stone"]);

        for (const surface of MATERIAL_SURFACE_IDS) {
          if (!surfaces.has(surface)) {
            continue;
          }

          bindControls(
            page,
            palette[surface],
            MATERIAL_SURFACE_CONTROLS[surface],
            dispatch,
            folders,
          );
        }

        return;
      }
    }
  }

  function bindPillarControls(
    page: TabPageApi,
    folders: Map<string, FolderApi>,
  ): void {
    bindControls(page, config.pillar, PILLAR_LAYOUT_CONTROLS, dispatch, folders);
    bindControls(page, config.pillar.stone, PILLAR_STONE_CONTROLS, dispatch, folders);
    const bevel = bindControls(page, config.pillar.bevel, PILLAR_BEVEL_CONTROLS, dispatch, folders);
    gateBevelDetails(bevel, () => config.pillar.bevel.enabled);
  }

  function bindFireBowlControls(
    page: TabPageApi,
    folders: Map<string, FolderApi>,
  ): void {
    const bowl = bindControls(page, config.fireBowl, FIRE_BOWL_CONTROLS, dispatch, folders);
    visibility.addBlades(
      [findControl(bowl, "scale"), findControl(bowl, "radialSegments")],
      () => config.fireBowl.enabled,
    );
  }

  function bindFireControls(
    page: TabPageApi,
    folders: Map<string, FolderApi>,
  ): void {
    const fire = bindControls(page, config.fire, FIRE_CONTROLS, dispatch, folders);
    // Flames need a bowl to sit in, so the whole flame group follows the bowl.
    const flameKeys = ["enabled", "scale", "radius", "height", "baseHeight",
      "radialSegments", "speed", "noiseScale", "turbulence", "intensity"] as const;
    visibility.addBlade(
      findControl(fire, "enabled"),
      () => config.fireBowl.enabled,
    );
    visibility.addBlades(
      flameKeys.filter((key) => key !== "enabled").map((key) => findControl(fire, key)),
      () => config.fireBowl.enabled && config.fire.enabled,
    );
    visibility.addBlade(
      findControl(fire, "glowEnabled"),
      () => config.fireBowl.enabled && config.fire.enabled,
    );
    visibility.addBlade(
      findControl(fire, "glowCastShadow"),
      () => fireGlowShadowsSupported
        && config.fireBowl.enabled
        && config.fire.enabled
        && config.fire.glowEnabled,
    );
    visibility.addBlades(
      [
        findControl(fire, "glowIntensity"),
        findControl(fire, "glowDistance"),
        findControl(fire, "glowHorizontalDistance"),
        findControl(fire, "glowVerticalDistance"),
        findControl(fire, "glowFlicker"),
      ],
      () => config.fireBowl.enabled
        && config.fire.enabled
        && config.fire.glowEnabled,
    );
  }

  function bindOfferingControls(
    page: TabPageApi,
    folders: Map<string, FolderApi>,
  ): void {
    const offering = bindControls(page, config.offering, OFFERING_CONTROLS, dispatch, folders);
    visibility.addBlades(
      offering
        .filter((control) => control.spec.key !== "enabled")
        .map((control) => control.binding),
      () => config.offering.enabled,
    );
  }

  function addPropStats(page: TabPageApi, props: readonly PropId[]): void {
    if (props.includes("pillar")) {
      addStatsFolder(page, "Geometry", [
        statRow(mirrors.pillars, "parts", "pillars"),
        statRow(mirrors.pillars, "stones", "stones"),
        statRow(mirrors.pillars, "vertices", "vertices"),
        statRow(mirrors.pillars, "triangles", "triangles"),
      ]);
    }
    if (props.includes("fireBowl") || props.includes("fire")) {
      addStatsFolder(page, "Stats", [
        statRow(mirrors.bowls, "parts", "bowls"),
        statRow(mirrors.bowls, "vertices", "bowl vertices"),
        statRow(mirrors.bowls, "triangles", "bowl triangles"),
        statRow(mirrors.flames, "count", "flames"),
        statRow(mirrors.flames, "vertices", "flame vertices"),
        statRow(mirrors.flames, "triangles", "flame triangles"),
        statRow(mirrors.flames, "draws", "flame draws"),
        statRow(mirrors.flames, "glowLights", "glow lights"),
      ]);
    }
    if (props.includes("offering")) {
      addStatsFolder(page, "Geometry", [
        statRow(mirrors.offering, "meshes", "meshes"),
        statRow(mirrors.offering, "vertices", "vertices"),
        statRow(mirrors.offering, "triangles", "triangles"),
      ]);
    }
  }

  function buildSceneTab(page: TabPageApi): void {
    const folders = createFolderRegistry();
    bindControls(page, config.view, VIEW_CONTROLS, dispatch, folders);
    bindControls(page, config.illumination, ILLUMINATION_CONTROLS, dispatch, folders);

    const illuminationFolder = folders.get("Illumination");

    if (illuminationFolder) {
      for (const { key, label } of ILLUMINATION_COLOR_KEYS) {
        illuminationFolder
          .addBinding(config.illumination, key, { label })
          .on("change", (event) => dispatch(["illumination"], {
            key,
            label,
            value: event.value,
          }));
      }
    }

    addStatsFolder(page, "Composition", [
      statRow(mirrors.totals, "parts", "parts"),
      statRow(mirrors.totals, "stones", "stones"),
      statRow(mirrors.totals, "vertices", "vertices"),
      statRow(mirrors.totals, "triangles", "triangles"),
    ]);
  }

  /** Bevel width/depth/variation only matter while the bevel is enabled. */
  function gateBevelDetails<T extends object>(
    bound: readonly BoundControl<T>[],
    visible: () => boolean,
  ): void {
    visibility.addBlades(
      bound
        .filter((control) => control.spec.key !== "enabled")
        .map((control) => control.binding),
      visible,
    );
  }

  function autoHideFolders(folders: Map<string, FolderApi>): void {
    for (const folder of folders.values()) {
      visibility.addFolder(folder, folder.children as BladeApi[]);
    }
  }

  function addStatsFolder(
    page: TabPageApi,
    title: string,
    rows: readonly StatRow[],
  ): void {
    const folder = page.addFolder({ title, expanded: false });

    for (const row of rows) {
      // The cast keeps addBinding's key inference from collapsing to never on
      // the erased `object` target. Rows are numbers apart from the validation
      // line, which Tweakpane renders as a readonly string just as happily.
      folder.addBinding(row.target as Record<string, number | string>, row.key, {
        label: row.label,
        readonly: true,
      });
    }
  }
}

function isStructureScope(scope: RebuildScope): boolean {
  return scope === "layout"
    || scope === "pillars"
    || scope === "bowls"
    || scope === "fire"
    || scope === "offering";
}

function applyStats(
  mirrors: StatMirrors,
  stats: ReturnType<MainScene["getStats"]>,
  primarySection: PartSection,
): void {
  // Section names are per-structure now, so a lookup can legitimately miss —
  // the mass structure has no "pillars" section and never will.
  const section = (name: PartSection): PartStats =>
    stats.sections[name] ?? emptyPartStats();

  const primary = section(primarySection);
  mirrors.structure.stones = primary.stoneCount;
  mirrors.structure.vertices = primary.vertexCount;
  mirrors.structure.triangles = primary.triangleCount;
  mirrors.structure.generationMs = Math.round(stats.generationMs * 100) / 100;
  mirrors.pillars.parts = section("pillars").partCount;
  mirrors.pillars.stones = section("pillars").stoneCount;
  mirrors.pillars.vertices = section("pillars").vertexCount;
  mirrors.pillars.triangles = section("pillars").triangleCount;
  mirrors.bowls.parts = section("fireBowls").partCount;
  mirrors.bowls.vertices = section("fireBowls").vertexCount;
  mirrors.bowls.triangles = section("fireBowls").triangleCount;
  mirrors.flames.count = stats.flames.count;
  mirrors.flames.vertices = stats.flames.vertexCount;
  mirrors.flames.triangles = stats.flames.triangleCount;
  mirrors.flames.draws = stats.flames.drawCallCount;
  mirrors.flames.glowLights = stats.glowLightCount;
  mirrors.offering.meshes = stats.offering.meshCount;
  mirrors.offering.vertices = stats.offering.vertexCount;
  mirrors.offering.triangles = stats.offering.triangleCount;
  mirrors.validation.status = summarizeDiagnostics(stats.diagnostics);
  mirrors.totals.parts = stats.totals.partCount;
  mirrors.totals.stones = stats.totals.stoneCount;
  mirrors.totals.vertices = stats.totals.vertexCount;
  mirrors.totals.triangles = stats.totals.triangleCount;
}

function formatLogValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
