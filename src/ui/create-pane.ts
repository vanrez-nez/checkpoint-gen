import { Pane } from "tweakpane";
import type { BladeApi, FolderApi, TabPageApi } from "@tweakpane/core";
import {
  structureOptions,
  getStructure,
  listStructures,
} from "../structure/registry";
import type { PropId } from "../structure/definition";
import {
  sectionsForScopes,
  type StructureConfig,
} from "../config/structure-config";
import type { RebuildScope } from "../config/control-spec";
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
} from "./binder";
import {
  createStatMirrors,
  statRow,
  summarizeDiagnostics,
  type StatMirrors,
  type StatRow,
} from "./stats";
import { VisibilityRegistry } from "./visibility";

export interface ControlPaneOptions {
  container: HTMLElement;
  config: StructureConfig;
  scene: MainScene;
  rendererLabel: string;
  onReframe: () => void;
}

export interface ControlPane {
  readonly stats: StatsBladeApi;
  dispose(): void;
}

const SHARED_STONE_CONTROLS = createStoneControls(["layout"]);
const SHARED_BEVEL_CONTROLS = createBevelControls(["layout"]);

export function createControlPane(options: ControlPaneOptions): ControlPane {
  const { container, config, scene, rendererLabel, onReframe } = options;
  const pane = new Pane({ container, title: "Structure" });
  pane.registerPlugin(StatsPanePluginBundle);
  const stats = pane.addBlade({ view: "stats" }) as StatsBladeApi;
  stats.setRenderer(rendererLabel);

  const visibility = new VisibilityRegistry();
  const mirrors = createStatMirrors();

  // Global state, so it sits above the tab bar rather than inside a tab.
  pane.addBinding(config, "typeId", {
    label: "type",
    options: structureOptions(),
  }).on("change", () => {
    // Every section belongs to the previous type's layout, so rebuild all.
    dispatch(["layout", "pillars", "bowls", "fire", "offering"], true);
  });

  const tabs = pane.addTab({
    pages: [
      { title: "Structure" },
      { title: "Pillars" },
      { title: "Fire" },
      { title: "Offering" },
      { title: "Scene" },
    ],
  });
  const [structureTab, pillarTab, fireTab, offeringTab, sceneTab] = tabs.pages;

  if (!structureTab || !pillarTab || !fireTab || !offeringTab || !sceneTab) {
    throw new Error("Failed to create control tabs.");
  }

  buildStructureTab(structureTab);
  buildPillarTab(pillarTab);
  buildFireTab(fireTab);
  buildOfferingTab(offeringTab);
  buildSceneTab(sceneTab);

  refreshStats();
  visibility.apply(config);

  return {
    stats,
    dispose(): void {
      pane.dispose();
    },
  };

  function activeStructure() {
    return getStructure(config.typeId);
  }

  function usesProp(prop: PropId): boolean {
    return activeStructure().props.includes(prop);
  }

  function dispatch(scopes: readonly RebuildScope[], reframe: boolean): void {
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
    }
    if (scopes.includes("view")) {
      scene.setWireframe(config.view.wireframe);
      scene.setVertexNormalsVisible(config.view.vertexNormals);
      scene.setGreybox(config.view.greybox);
      scene.setPatchDebugVisible(config.view.patchDebug);
    }

    refreshStats();
    visibility.apply(config);

    if (reframe) {
      onReframe();
    }
  }

  function refreshStats(): void {
    applyStats(mirrors, scene.getStats(), activeStructure().sections[0] ?? "");
    pane.refresh();
  }

  function buildStructureTab(page: TabPageApi): void {
    const folders = createFolderRegistry();

    // One layout group per registered structure, gated on the active one. A new
    // structure contributes its folders here purely from its layoutControls
    // table, including any control that gates on one of its own fields.
    for (const definition of listStructures()) {
      const layout = config.layouts[definition.id] ?? definition.cloneLayout();
      config.layouts[definition.id] = layout;
      const bound = bindControls(
        page,
        layout,
        definition.layoutControls,
        dispatch,
        folders,
      );

      for (const control of bound) {
        const { visibleWhen } = control.spec;
        visibility.addBlades(
          [control.binding],
          (current) => current.typeId === definition.id
            && (visibleWhen === undefined || visibleWhen(layout)),
        );
      }
    }

    const stone = bindControls(page, config.stone, SHARED_STONE_CONTROLS, dispatch, folders);
    visibility.addBlades(
      stone.map((control) => control.binding),
      () => usesProp("stone"),
    );

    const bevel = bindControls(page, config.bevel, SHARED_BEVEL_CONTROLS, dispatch, folders);
    visibility.addBlades(
      bevel.map((control) => control.binding),
      () => usesProp("bevel"),
    );
    gateBevelDetails(bevel, () => usesProp("bevel") && config.bevel.enabled);

    autoHideFolders(folders);
    addStatsFolder(page, "Geometry", [
      statRow(mirrors.structure, "stones", "stones"),
      statRow(mirrors.structure, "vertices", "vertices"),
      statRow(mirrors.structure, "triangles", "triangles"),
      statRow(mirrors.validation, "status", "validation"),
    ]);
  }

  function buildPillarTab(page: TabPageApi): void {
    const folders = createFolderRegistry();
    const layout = bindControls(page, config.pillar, PILLAR_LAYOUT_CONTROLS, dispatch, folders);
    const stone = bindControls(page, config.pillar.stone, PILLAR_STONE_CONTROLS, dispatch, folders);
    const bevel = bindControls(page, config.pillar.bevel, PILLAR_BEVEL_CONTROLS, dispatch, folders);
    const usesPillar = () => usesProp("pillar");

    visibility.addBlades(layout.map((control) => control.binding), usesPillar);
    visibility.addBlades(stone.map((control) => control.binding), usesPillar);
    visibility.addBlades(bevel.map((control) => control.binding), usesPillar);
    gateBevelDetails(bevel, () => usesPillar() && config.pillar.bevel.enabled);

    autoHideFolders(folders);
    addTabNote(page, () => !usesPillar());
    addStatsFolder(page, "Geometry", [
      statRow(mirrors.pillars, "parts", "pillars"),
      statRow(mirrors.pillars, "stones", "stones"),
      statRow(mirrors.pillars, "vertices", "vertices"),
      statRow(mirrors.pillars, "triangles", "triangles"),
    ]);
  }

  function buildFireTab(page: TabPageApi): void {
    const folders = createFolderRegistry();
    const bowl = bindControls(page, config.fireBowl, FIRE_BOWL_CONTROLS, dispatch, folders);
    const fire = bindControls(page, config.fire, FIRE_CONTROLS, dispatch, folders);

    visibility.addBlade(findControl(bowl, "enabled"), () => usesProp("fireBowl"));
    visibility.addBlades(
      [findControl(bowl, "scale"), findControl(bowl, "radialSegments")],
      () => usesProp("fireBowl") && config.fireBowl.enabled,
    );

    // Flames need a bowl to sit in, so the whole flame group follows the bowl.
    const flameKeys = ["enabled", "scale", "radius", "height", "baseHeight",
      "radialSegments", "speed", "noiseScale", "turbulence", "intensity"] as const;
    visibility.addBlade(
      findControl(fire, "enabled"),
      () => usesProp("fire") && config.fireBowl.enabled,
    );
    visibility.addBlades(
      flameKeys.filter((key) => key !== "enabled").map((key) => findControl(fire, key)),
      () => usesProp("fire") && config.fireBowl.enabled && config.fire.enabled,
    );
    visibility.addBlade(
      findControl(fire, "glowEnabled"),
      () => usesProp("fire") && config.fireBowl.enabled && config.fire.enabled,
    );
    visibility.addBlades(
      [
        findControl(fire, "glowIntensity"),
        findControl(fire, "glowDistance"),
        findControl(fire, "glowFlicker"),
      ],
      () => usesProp("fire")
        && config.fireBowl.enabled
        && config.fire.enabled
        && config.fire.glowEnabled,
    );

    autoHideFolders(folders);
    addTabNote(page, () => !usesProp("fireBowl"));
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

  function buildOfferingTab(page: TabPageApi): void {
    const folders = createFolderRegistry();
    const offering = bindControls(page, config.offering, OFFERING_CONTROLS, dispatch, folders);
    const usesOffering = () => usesProp("offering");

    visibility.addBlade(findControl(offering, "enabled"), usesOffering);
    visibility.addBlades(
      offering
        .filter((control) => control.spec.key !== "enabled")
        .map((control) => control.binding),
      () => usesOffering() && config.offering.enabled,
    );

    autoHideFolders(folders);
    addTabNote(page, () => !usesOffering());
    addStatsFolder(page, "Geometry", [
      statRow(mirrors.offering, "meshes", "meshes"),
      statRow(mirrors.offering, "vertices", "vertices"),
      statRow(mirrors.offering, "triangles", "triangles"),
    ]);
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
          .on("change", () => dispatch(["illumination"], false));
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

  /**
   * Tab buttons cannot be hidden in Tweakpane, so a tab whose props the active
   * type does not use gets an explanatory line instead of looking broken.
   */
  function addTabNote(page: TabPageApi, visible: () => boolean): void {
    const note = { note: "Not used by this structure" };
    const binding = page.addBinding(note, "note", {
      label: "",
      readonly: true,
    }) as unknown as BladeApi;
    visibility.addBlade(binding, visible);
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
