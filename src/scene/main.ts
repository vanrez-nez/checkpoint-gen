import * as THREE from "three";
import { Line2NodeMaterial, type WebGPURenderer } from "three/webgpu";
import {
  cameraFar,
  cameraNear,
  cameraPosition,
  color,
  depth,
  mix,
  perspectiveDepthToViewZ,
  smoothstep,
  uniform,
} from "three/tsl";
import { CSMShadowNode } from "three/examples/jsm/csm/CSMShadowNode.js";
import { Wireframe } from "three/examples/jsm/lines/webgpu/Wireframe.js";
import { WireframeGeometry2 } from "three/examples/jsm/lines/WireframeGeometry2.js";
import { VertexNormalsHelper } from "three/examples/jsm/helpers/VertexNormalsHelper.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  MaterialGraphRuntime,
  migrateMaterialDocument,
  type MaterialGraphDocument,
} from "material-designer-runtime";
import { buildEngravingDecalBatches } from "../engravings/build";
import type { StructureEngravings } from "../engravings/config";
import {
  buildEngravingDecalMaterial,
  disposeEngravingDecalMaterial,
} from "../engravings/decal-material";
import { EngravingMapCache } from "../engravings/map-cache";
import { MoistureNoiseTextureResource } from "../engravings/moisture-noise";
import {
  engravingResolutionDimension,
  type EngravingResolution,
} from "../engravings/resolution";
import type { EngravingTextures } from "../engravings/textures";
import { HostShadingSampler } from "../geometry/host-shading";
import { subdivideLongEdges } from "../geometry/subdivide";
import { SunBakeScene, type SunBakeTarget } from "../geometry/sun-bake";
import { StructureComposer } from "../structure/composer";
import {
  DEFAULT_DETAIL_LEVEL,
  DETAIL_PROFILES,
  type DetailLevel,
} from "../structure/kernel/detail";
import { createPatchOverlay, type PatchOverlay } from "../structure/kernel/debug-overlay";
import type { SlotFeatureSpec, StructureDefinition } from "../structure/definition";
import type { StructureGraph } from "../structure/kernel/graph";
import type { Diagnostic } from "../structure/kernel/validate";
import type { StructureConfig } from "../config/structure-config";
import {
  cloneMaterialPalette,
  materialDocumentUrl,
  validateMaterialPalette,
  type MaterialDocumentId,
  type MaterialSurfaceId,
  type StructureMaterialPalette,
} from "../config/material-palette";
import {
  DEFAULT_VIEW_CONFIG,
  validateIlluminationConfig,
  type IlluminationConfig,
} from "../config/sections";
import {
  MATERIAL_SLOTS,
  emptySectionStats,
  emptyPartStats,
  type CompositionAnchors,
  type PartSection,
  type PartStats,
} from "../geometry/part";
import { getStructure } from "../structure/registry";
import { VertexConeFireBatch } from "../props/fire/vertex-cone";
import { validateFireConfig, type FireConfig } from "../props/fire/config";
import {
  calculateOfferingSupportCenter,
  calculateOfferingTransform,
  prepareOfferingGeometry,
} from "../props/offering/model";
import {
  validateOfferingConfig,
  type OfferingConfig,
} from "../props/offering/config";

const MATERIAL_OUTPUT_RESOLUTION = 512;
/**
 * Longest edge a face may keep before the sun bake subdivides it.
 *
 * Sized against the stonework rather than the structure: a course is 0.86 tall
 * and a stone 1.65 long, so this leaves the masonry untouched and refines only
 * the plain faces — roofs, pads, plaza slabs — that carry too few vertices to
 * describe a shadow crossing them.
 */
const SUN_BAKE_MAX_EDGE = 1.5;

/**
 * How wide a shadow's edge may be, in metres, where one falls.
 *
 * The sun is baked per vertex, so an edge is a ramp between a lit vertex and a
 * dark one. `SUN_BAKE_MAX_EDGE` alone leaves that ramp about a metre wide on a
 * default mass, which reads as a gradient rather than a shadow and which any
 * second surface laid over it reconstructs differently. This is the bound the
 * refinement pass applies to those edges alone.
 */
const SHADOW_EDGE_BOUND = 0.2;

/** Half-angle of the sun's disc. Wider than the real sun, to soften contacts. */
const SUN_BAKE_SOFTNESS = 0.035;

/**
 * Rays per lit vertex.
 *
 * Cost is the product of this and the vertex count that `SUN_BAKE_MAX_EDGE`
 * implies, and both bite hard: refining to 0.75 with eight rays took nine
 * seconds on this mass, which is not a slider. Halving the bound quarters the
 * vertices it adds, so the edge bound is the dial to reach for first.
 */
const SUN_BAKE_SAMPLES = 4;

/**
 * The unit direction from the structure toward the sun.
 *
 * Single source of truth on purpose: the light's placement and the bake's ray
 * direction must agree exactly, and deriving them from the same azimuth and
 * elevation twice is how they stop agreeing.
 */
function sunDirectionOf(config: IlluminationConfig): THREE.Vector3 {
  const azimuth = THREE.MathUtils.degToRad(config.keyAzimuth);
  const elevation = THREE.MathUtils.degToRad(config.keyElevation);
  const horizontal = Math.cos(elevation);

  return new THREE.Vector3(
    Math.cos(azimuth) * horizontal,
    Math.sin(elevation),
    Math.sin(azimuth) * horizontal,
  );
}

const CSM_CASCADES = 3;
// Sized to the structure, not to the horizon. Every cascade is fit to a slice of
// this range, so an oversized far plane spreads the same 1024 texels over more
// world and drives the shadow-map texel footprint — and with it the acne — up.
const CSM_MAX_FAR = 50;
const CSM_LIGHT_MARGIN = 20;
const SHADOW_MAP_SIZE = 1024;
const MAX_FIRE_FLAMES = 16;
const FIRE_GLOW_COLOR = 0xff5a12;
const FIRE_GLOW_SHADOW_MAP_SIZE = 512;
const FIRE_GLOW_SHADOW_NEAR = 0.01;
const FIRE_GLOW_SHADOW_BIAS = -0.0002;
const FIRE_GLOW_SHADOW_NORMAL_BIAS = 0.02;
/** Vertex-normal helper length, as a fraction of the composition's diagonal. */
const VERTEX_NORMAL_SIZE_RATIO = 0.008;

export interface OfferingStats {
  meshCount: number;
  vertexCount: number;
  triangleCount: number;
}

export interface FlameStats {
  count: number;
  vertexCount: number;
  triangleCount: number;
  drawCallCount: number;
}

export interface CompositionStats {
  sections: Readonly<Record<PartSection, PartStats>>;
  totals: PartStats;
  generationMs: number;
  /** Time spent tracing the sun into the vertex channel, separate from generation. */
  sunBakeMs: number;
  /** The level the resident geometry was generated at. */
  detail: DetailLevel;
  flames: FlameStats;
  glowLightCount: number;
  offering: OfferingStats;
  /** Structural diagnostics from the last build, empty for structures without a graph. */
  diagnostics: readonly Diagnostic[];
}

type FireGlowEntry = {
  light: THREE.PointLight;
  baseIntensity: number;
  phase: number;
  flicker: number;
};

export interface MainSceneOptions {
  /** Capability gate derived from the initialized renderer device. */
  readonly fireGlowShadowsSupported?: boolean;
  /** Two on 16-sampler devices, otherwise the normal three-cascade sun. */
  readonly sunShadowCascades?: number;
}

export class MainScene {
  readonly scene = new THREE.Scene();
  private readonly composer = new StructureComposer();
  private readonly greyboxMaterial: THREE.MeshStandardMaterial;
  /** Flat, and unmistakable. See `fallbackSurfaceMaterial`. */
  private readonly slotDebugMaterial: THREE.MeshStandardMaterial;
  private readonly fallbackStoneMaterial: THREE.MeshStandardMaterial;
  private readonly fallbackIronMaterial: THREE.MeshStandardMaterial;
  private readonly fallbackOfferingMaterial: THREE.MeshStandardMaterial;
  private readonly offeringWireframeMaterial: THREE.MeshBasicMaterial;
  /** The entire generated structure, merged into one mesh. */
  private readonly structure: THREE.Mesh;
  private readonly wireframeMaterial: Line2NodeMaterial;
  private structureWireframe: Wireframe | null = null;
  /** Centre and radius of the wireframed geometry, for the depth fade range. */
  private readonly wireframeFocus = uniform(new THREE.Vector3());
  private readonly wireframeRadius = uniform(1);
  private readonly fireBatch: VertexConeFireBatch;
  private readonly fireGlowEntries: FireGlowEntry[] = [];
  private readonly fireGlowShadowsSupported: boolean;
  private readonly sunLight: THREE.DirectionalLight;
  private readonly hemisphereLight: THREE.HemisphereLight;
  private readonly sunShadow: CSMShadowNode;
  private vertexNormalsHelper: VertexNormalsHelper | null = null;
  private offeringRoot: THREE.Group | null = null;
  private offeringSourceBounds: THREE.Box3 | null = null;
  private offeringSupportCenter: THREE.Vector3 | null = null;
  private readonly offeringMeshes: THREE.Mesh[] = [];
  private vertexNormalsVisible = false;
  private greyboxEnabled = false;
  /**
   * Engraved decals, and everything they are derived from.
   *
   * They hang off a group of their own rather than joining the merged mesh
   * because they are dressing: a decal is built from the published slot table
   * and disposed on the next rebuild, and nothing about the structure's own
   * geometry, its material slots or its baked channels has to know they exist.
   */
  private readonly engravingRoot = new THREE.Group();
  private readonly engravingMaps = new EngravingMapCache();
  private readonly moistureNoise = new MoistureNoiseTextureResource();
  private engravingMeshes: THREE.Mesh[] = [];
  private activeEngravings: StructureEngravings = {};
  private activeSlotFeatures: readonly SlotFeatureSpec<object>[] = [];
  /** The active family's layout, for the features that place stone off-patch. */
  private activeLayout: object | null = null;
  /**
   * Which decal build is current.
   *
   * Map derivation runs on a worker and takes up to a second or two, so a user
   * dragging through a dropdown can start several builds before the first
   * lands. Only the newest may reach the scene.
   */
  private engravingBuildToken = 0;
  private patchDebugVisible = false;
  private patchOverlay: PatchOverlay | null = null;
  private graph: StructureGraph | null = null;
  private anchors: CompositionAnchors;
  private sectionStats = emptySectionStats();
  private totalStats = emptyPartStats();
  private generationMs = 0;
  private currentOfferingStats: OfferingStats = emptyOfferingStats();
  private offeringConfig: OfferingConfig;
  private activeMaterialPalette: StructureMaterialPalette;
  private activeMaterialSurfaces: ReadonlySet<MaterialSurfaceId>;
  private materialRenderer: WebGPURenderer | null = null;
  private readonly structureMaterialRuntimes = new Map<
    MaterialDocumentId,
    MaterialGraphRuntime
  >();
  private readonly structureSurfaceMaterials = new Map<
    MaterialDocumentId,
    THREE.Material
  >();
  private readonly structureMaterialLoads = new Map<
    MaterialDocumentId,
    Promise<MaterialGraphRuntime>
  >();
  private readonly stopListeningForStructureMaterialRebuild = new Map<
    MaterialDocumentId,
    () => void
  >();
  /** Master multiplier over every surface's own texture scale. */
  private materialScale: number;
  private engravingResolution: EngravingResolution;
  /**
   * The stone's baked shading, for decals to read. Built on the first decal
   * that needs it and dropped with the bake hierarchy, since both are indexed
   * against the same subdivided geometry.
   */
  private hostShading: HostShadingSampler | null = null;
  private ambientOcclusionStrength: number;
  private crackShadowStrength: number;
  private sunShadowStrength: number;
  private sunBakeMs = 0;
  private detail: DetailLevel = DEFAULT_DETAIL_LEVEL;
  /**
   * The direction the current bake was taken from. Re-baking is far too
   * expensive to do for a colour or intensity change, so the sun's *angle* is
   * the only illumination input that invalidates it.
   */
  private readonly bakedSunDirection = new THREE.Vector3(NaN, NaN, NaN);
  /** Discarded whenever the geometry it was built over is replaced. */
  private sunBakeScene: SunBakeScene | null = null;
  private fireTime = 0;
  private wireframeVisible = false;

  constructor(config: StructureConfig, options: MainSceneOptions = {}) {
    validateOfferingConfig(config.offering);
    this.fireGlowShadowsSupported = options.fireGlowShadowsSupported ?? true;
    this.offeringConfig = { ...config.offering };
    this.materialScale = config.view.materialScale;
    this.engravingResolution = config.view.engravingResolution;
    this.ambientOcclusionStrength = config.illumination.ambientOcclusion;
    this.crackShadowStrength = config.illumination.crackShadow;
    this.sunShadowStrength = config.illumination.sunShadow;
    this.scene.background = new THREE.Color(0x171714);
    this.fireBatch = new VertexConeFireBatch(
      config.fire.radialSegments,
      MAX_FIRE_FLAMES,
    );

    this.fallbackStoneMaterial = new THREE.MeshStandardMaterial({
      color: 0xa99b81,
      roughness: 0.92,
      metalness: 0,
      vertexColors: true,
    });
    this.fallbackIronMaterial = new THREE.MeshStandardMaterial({
      color: 0x242729,
      roughness: 0.58,
      metalness: 0.95,
      vertexColors: true,
    });
    this.fallbackOfferingMaterial = new THREE.MeshStandardMaterial({
      color: 0x302a22,
      roughness: 0.94,
      metalness: 0.02,
      vertexColors: true,
    });
    this.offeringWireframeMaterial = new THREE.MeshBasicMaterial({
      color: 0xd8d8d8,
      wireframe: true,
    });
    // Deliberately featureless: no vertex colours, no baked AO, nothing that
    // could flatter a shape. Only form reads through it.
    this.greyboxMaterial = new THREE.MeshStandardMaterial({
      color: 0xb4b4b4,
      roughness: 1,
      metalness: 0,
    });
    // A debug tint that can be mistaken for a material choice is not a debug
    // tint, so this one is not a palette entry at all: it is flat red and no
    // dressing can change it.
    this.slotDebugMaterial = new THREE.MeshStandardMaterial({
      color: 0xd42222,
      roughness: 1,
      metalness: 0,
    });
    // Wide screen-space lines rather than GL_LINES: LineBasicMaterial's
    // `linewidth` is silently ignored on every real platform, so a tunable
    // stroke needs the fat-line path — segments expanded to camera-facing
    // quads, in pixels regardless of zoom.
    this.wireframeMaterial = new Line2NodeMaterial({
      linewidth: DEFAULT_VIEW_CONFIG.wireframeWidth,
    });
    // Depth cueing. Every edge of the whole mass at one brightness is an
    // unreadable lattice — the far side bleeds into the near side. The line
    // colour fades with distance across the structure's own bounding sphere,
    // so the facing surface stays bright and the far side recedes toward the
    // background. The fragment's true depth is reconstructed rather than a
    // varying interpolated, because the fat-line vertex stage positions quad
    // corners, not line points. `lineColorNode` is the hook the material
    // reads in place of its flat colour.
    // The window is asymmetric around the centre because the visible surfaces
    // live in the middle band of the sphere along the view axis — the radius is
    // dominated by the plan extent, not the view depth. Spanning the full
    // sphere reads as barely any cueing; ending at the centre dims even the
    // facing surface. Three quarters in front to one quarter behind keeps the
    // near surface bright and retires everything past the midline.
    const viewDistance = perspectiveDepthToViewZ(depth, cameraNear, cameraFar).negate();
    const focusDistance = cameraPosition.sub(this.wireframeFocus).length();
    const fade = smoothstep(
      focusDistance.sub(this.wireframeRadius.mul(0.75)),
      focusDistance.add(this.wireframeRadius.mul(0.25)),
      viewDistance,
    );
    this.wireframeMaterial.lineColorNode = mix(color(0xf0f0f0), color(0x2e2e29), fade);
    const definition = getStructure(config.typeId);
    const palette = config.materialPalettes[definition.id];

    if (!palette) {
      throw new Error(
        `Missing material palette for structure "${definition.id}".`,
      );
    }

    this.activeMaterialPalette = cloneMaterialPalette(palette);
    this.activeMaterialSurfaces = new Set(
      definition.materialSurfaces ?? ["stone"],
    );
    // Seeded here so a structure restored from a geometry code comes up
    // engraved rather than waiting for the first control change. The decals
    // themselves are built once the first material document has loaded.
    this.activeEngravings = config.engravings[definition.id] ?? {};
    this.activeSlotFeatures = definition.slotFeatures ?? [];
    this.activeLayout = config.layouts[definition.id] ?? null;

    const composition = this.composer.build(config);
    this.anchors = composition.anchors;
    this.graph = composition.graph;
    this.sectionStats = composition.sections;
    this.totalStats = composition.totals;
    this.generationMs = composition.generationMs;
    this.detail = composition.detail;
    const initialGeometry = this.prepareStructureGeometry(
      composition.geometry,
      config.illumination,
      composition.detail,
    );
    this.applyGeometryAttributes(initialGeometry);
    // Every semantic slot remains addressable even when the current structure
    // does not emit it. This keeps group indices stable across structure types.
    this.structure = new THREE.Mesh(
      initialGeometry,
      MATERIAL_SLOTS.map((slot) => this.fallbackSurfaceMaterial(slot)),
    );
    this.structure.name = "Structure";
    this.structure.castShadow = true;
    // Still a receiver: the fire glow lights stay realtime, because they
    // flicker and their casters move. Only the sun's contribution is baked.
    this.structure.receiveShadow = true;
    this.engravingRoot.name = "Engraving decals";
    this.scene.add(this.structure, this.engravingRoot, this.fireBatch.object);
    this.applyFireEffects(config.fire);

    this.sunLight = new THREE.DirectionalLight();
    // The sun's occlusion is baked per structure, so it casts nothing at
    // runtime. This is what retires the WebGPU shadow acne rather than biasing
    // around it: there is no depth comparison left to go wrong. The cascade
    // node below stays wired so re-enabling this is a one-line change, and the
    // bias values it carries only mean anything if that happens.
    this.sunLight.castShadow = false;
    this.sunLight.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    this.sunLight.shadow.bias = -0.0001;
    // A shadow-map texel spans ~0.03 world units on the middle cascade, and a
    // sun low enough to rake the roofs climbs about 0.07 units of depth across
    // one of them. Anything less than that self-shadows every texel row and the
    // flat faces band. CSM scales `bias` per cascade but not this, so it is
    // sized for the widest cascade rather than the nearest.
    this.sunLight.shadow.normalBias = 0.08;
    this.sunShadow = new CSMShadowNode(this.sunLight, {
      cascades: options.sunShadowCascades ?? CSM_CASCADES,
      maxFar: CSM_MAX_FAR,
      mode: "practical",
      lightMargin: CSM_LIGHT_MARGIN,
    });
    this.sunShadow.fade = true;
    (this.sunLight.shadow as THREE.DirectionalLight["shadow"] & {
      shadowNode?: CSMShadowNode;
    }).shadowNode = this.sunShadow;

    this.hemisphereLight = new THREE.HemisphereLight();
    this.scene.add(this.sunLight, this.sunLight.target, this.hemisphereLight);
    this.setIllumination(config.illumination);
  }

  async loadStructureMaterialPalette(
    renderer: WebGPURenderer,
    palette: StructureMaterialPalette,
    surfaces: readonly MaterialSurfaceId[],
  ): Promise<void> {
    this.materialRenderer = renderer;
    await this.setStructureMaterialPalette(palette, surfaces);
  }

  /**
   * Changes surface dressing — material documents and texture scales — without
   * rebuilding geometry. The offering statue is dressed from the same palette, so
   * one call covers every surface the active structure has.
   *
   * Material documents are cached by id and loaded only when an active surface
   * selects them. A failed document falls back independently, so one bad layer
   * cannot blank the entire structure.
   */
  async setStructureMaterialPalette(
    palette: StructureMaterialPalette,
    surfaces: readonly MaterialSurfaceId[],
  ): Promise<void> {
    validateMaterialPalette(palette);
    this.activeMaterialPalette = cloneMaterialPalette(palette);
    this.activeMaterialSurfaces = new Set(surfaces);
    this.refreshSurfaceMaterials();
    this.refreshTextureScales();

    const renderer = this.materialRenderer;

    if (!renderer) {
      return;
    }

    const ids = [
      ...new Set(
        surfaces.map((surface) => this.activeMaterialPalette[surface].document),
      ),
    ];
    const results = await Promise.allSettled(
      ids.map((id) => this.ensureStructureMaterialRuntime(renderer, id)),
    );

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(
          `Structure material "${ids[index] ?? "unknown"}" failed to load; `
          + "using the fallback material.",
          result.reason,
        );
      }
    });
    this.refreshSurfaceMaterials();
    // Unconditionally, not only when a document had to be fetched: switching a
    // surface to a document already in the cache loads nothing, so the rebuild
    // hook on the loader never fires and the decals would keep wearing the
    // stone they were built against.
    this.rebuildEngravingDecals();
  }

  async loadOffering(modelUrl: string, decoderPath: string): Promise<void> {
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath(decoderPath);
    dracoLoader.setWorkerLimit(1);
    const loader = new GLTFLoader();
    loader.setDRACOLoader(dracoLoader);

    let scene: THREE.Group;

    try {
      scene = (await loader.loadAsync(modelUrl)).scene;
    } finally {
      dracoLoader.dispose();
    }

    this.disposeOffering();

    const embeddedMaterials = new Set<THREE.Material>();
    const preparedGeometries = new Set<THREE.BufferGeometry>();

    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) {
        return;
      }

      const materials = Array.isArray(object.material)
        ? object.material
        : [object.material];

      for (const material of materials) {
        embeddedMaterials.add(material);
      }

      if (!preparedGeometries.has(object.geometry)) {
        const offeringScale = this.textureScaleFor("offering");
        prepareOfferingGeometry(object.geometry);
        this.applyTextureScale(object.geometry, () => offeringScale);
        this.applyAmbientOcclusion(object.geometry);
        this.applyBakedShadow(object.geometry);
        preparedGeometries.add(object.geometry);
      }

      object.material = this.surfaceMaterial("offering");
      object.castShadow = true;
      object.receiveShadow = true;
      this.offeringMeshes.push(object);
    });

    for (const material of embeddedMaterials) {
      material.dispose();
    }

    if (this.offeringMeshes.length === 0) {
      for (const geometry of preparedGeometries) {
        geometry.dispose();
      }
      throw new Error("Offering model contains no meshes.");
    }

    const root = new THREE.Group();
    root.name = "Xochipilli offering";
    root.add(scene);
    root.updateMatrixWorld(true);
    const sourceBounds = new THREE.Box3().setFromObject(root);

    if (sourceBounds.isEmpty()) {
      for (const geometry of preparedGeometries) {
        geometry.dispose();
      }
      this.offeringMeshes.length = 0;
      throw new Error("Offering model has empty bounds.");
    }

    this.offeringRoot = root;
    this.offeringSourceBounds = sourceBounds;
    this.offeringSupportCenter = calculateOfferingSupportCenter(root, sourceBounds);
    this.currentOfferingStats = offeringStats(this.offeringMeshes);
    this.updateOfferingTransform();
    this.refreshOfferingPresentation();
    this.scene.add(root);
  }

  /**
   * Regenerates the requested part sections and swaps in the merged geometry.
   * Omitting `sections` rebuilds everything.
   */
  rebuild(
    config: StructureConfig,
    sections?: Iterable<PartSection>,
  ): CompositionStats {
    const composition = this.composer.build(config, sections);
    const previousGeometry = this.structure.geometry;
    const geometry = this.prepareStructureGeometry(
      composition.geometry,
      config.illumination,
      composition.detail,
    );
    this.applyGeometryAttributes(geometry);
    this.structure.geometry = geometry;
    this.anchors = composition.anchors;
    this.graph = composition.graph;
    this.sectionStats = composition.sections;
    this.totalStats = composition.totals;
    this.generationMs = composition.generationMs;
    this.detail = composition.detail;
    // Rebuilding the wireframe on every geometry swap costs more than the
    // geometry itself, and it is hidden almost always, so drop it and rebuild
    // lazily if the user is actually looking at it.
    this.invalidateWireframe();
    this.rebuildPatchOverlay();
    this.rebuildVertexNormalsHelper();
    this.updateOfferingTransform();
    this.refreshOfferingPresentation();
    this.applyFireEffects(config.fire);
    // Re-read here rather than only on an engraving change, because switching
    // structure type comes through this path and brings a different family's
    // features with it.
    const engraved = getStructure(config.typeId);
    this.activeEngravings = config.engravings[engraved.id] ?? {};
    this.activeSlotFeatures = engraved.slotFeatures ?? [];
    this.activeLayout = config.layouts[engraved.id] ?? null;
    // The slot table is republished by every build, so the decals standing on
    // it are stale the moment the graph is replaced. Rebuilt asynchronously,
    // because deriving an engraving's maps takes far longer than a frame and
    // `rebuild` is read for its stats the moment it returns.
    this.rebuildEngravingDecals();
    previousGeometry.dispose();

    return this.getStats();
  }

  /**
   * Changes which engraving each slot-bearing feature carries.
   *
   * Geometry is untouched: a decal is derived from the published slot table,
   * so choosing a different motif costs a quad and a node graph rather than a
   * regeneration.
   */
  setStructureEngravings(
    engravings: StructureEngravings,
    definition: StructureDefinition,
    layout: object | null = this.activeLayout,
  ): void {
    this.activeEngravings = engravings;
    this.activeSlotFeatures = definition.slotFeatures ?? [];
    this.activeLayout = layout;
    this.rebuildEngravingDecals();
  }

  /** Retunes flames and glow lights without touching geometry. */
  updateFireEffects(config: StructureConfig): CompositionStats {
    this.applyFireEffects(config.fire);
    return this.getStats();
  }

  getStats(): CompositionStats {
    const flames = this.fireBatch.getStats();

    return {
      sections: this.sectionStats,
      totals: this.totalStats,
      generationMs: this.generationMs,
      sunBakeMs: this.sunBakeMs,
      detail: this.detail,
      flames: {
        count: flames.flameCount,
        vertexCount: flames.vertexCount,
        triangleCount: flames.triangleCount,
        drawCallCount: flames.drawCallCount,
      },
      glowLightCount: this.fireGlowEntries.length,
      // Zeroed when the model is not shown, so the readout never credits a
      // structure with geometry that is not in its composition.
      offering: this.offeringRoot?.visible === true
        ? { ...this.currentOfferingStats }
        : emptyOfferingStats(),
      diagnostics: this.graph?.diagnostics ?? [],
    };
  }

  getCompositionBounds(): THREE.Box3 {
    this.scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(this.structure);

    if (this.offeringRoot?.visible === true) {
      bounds.expandByObject(this.offeringRoot);
    }

    this.fireBatch.expandBounds(bounds);

    return bounds;
  }

  setMaterialScale(scale: number): void {
    if (Object.is(this.materialScale, scale)) {
      return;
    }

    this.materialScale = scale;
    this.refreshTextureScales();
  }

  /**
   * How much texture memory the engravings may spend.
   *
   * Rebuilds the decals because the budget is a property of the derived maps
   * rather than of the shader, and the map cache keys on the size it produced —
   * so a tier already visited comes back without re-deriving anything.
   */
  setEngravingResolution(resolution: EngravingResolution): void {
    if (this.engravingResolution === resolution) {
      return;
    }

    this.engravingResolution = resolution;
    this.rebuildEngravingDecals();
  }

  setOfferingConfig(config: OfferingConfig): void {
    validateOfferingConfig(config);
    this.offeringConfig = { ...config };
    this.updateOfferingTransform();
    this.refreshOfferingPresentation();
  }

  setWireframe(enabled: boolean): void {
    this.wireframeVisible = enabled;
    this.structure.visible = !enabled;
    this.refreshEngravingVisibility();
    this.fireBatch.setSceneVisible(!enabled);
    this.refreshOfferingPresentation();

    for (const entry of this.fireGlowEntries) {
      entry.light.visible = !enabled;
    }

    if (enabled) {
      this.ensureWireframe().visible = true;
    } else if (this.structureWireframe) {
      this.structureWireframe.visible = false;
    }
  }

  setWireframeWidth(width: number): void {
    this.wireframeMaterial.linewidth = width;
  }

  setVertexNormalsVisible(enabled: boolean): void {
    this.vertexNormalsVisible = enabled;
    this.rebuildVertexNormalsHelper();
  }

  /**
   * Swaps the surface materials for a neutral matte. Massing is a decision about
   * proportion and silhouette, and a convincing stone surface makes it much
   * harder to see whether the proportions are actually right.
   */
  setGreybox(enabled: boolean): void {
    this.greyboxEnabled = enabled;
    this.refreshSurfaceMaterials();
  }

  setPatchDebugVisible(enabled: boolean): void {
    this.patchDebugVisible = enabled;
    this.rebuildPatchOverlay();
  }

  /** The semantic layer behind the current geometry, when there is one. */
  getGraph(): StructureGraph | null {
    return this.graph;
  }

  setIllumination(config: IlluminationConfig): void {
    validateIlluminationConfig(config);
    this.sunLight.color.set(config.keyColor);
    this.sunLight.intensity = config.keyIntensity;

    this.sunLight.position.copy(sunDirectionOf(config)).multiplyScalar(10);

    this.hemisphereLight.color.set(config.skyColor);
    this.hemisphereLight.groundColor.set(config.groundColor);
    this.hemisphereLight.intensity = config.ambientIntensity;
    this.ambientOcclusionStrength = THREE.MathUtils.clamp(
      config.ambientOcclusion,
      0,
      1,
    );
    this.crackShadowStrength = THREE.MathUtils.clamp(config.crackShadow, 0, 1);
    // The three modes are exclusive: a baked sun and a cascaded one applied at
    // once would darken every contact twice, and neither would be a fair look
    // at what the other is doing.
    const baked = config.shadowMode === "baked";
    this.sunShadowStrength = baked
      ? THREE.MathUtils.clamp(config.sunShadow, 0, 1)
      : 0;
    this.sunLight.castShadow = config.shadowMode === "dynamic";

    // Only the sun's *angle* invalidates a bake. Colour, intensity and the
    // strength sliders all re-derive from the base arrays, which is the whole
    // reason those arrays are kept separate from the live attribute.
    const direction = sunDirectionOf(config);

    if (direction.distanceToSquared(this.bakedSunDirection) > 1e-12) {
      this.bakeSun(this.structure.geometry, config);
      // Decals follow the sun with the stone, and share its gate for the same
      // reason they must not be skipped: an engraving lit from an angle the
      // wall around it has moved off is the failure, and the two moving
      // together is what prevents it. This used to run unconditionally, on the
      // grounds that four vertices a quad made it a rounding error beside the
      // structure's own bake. A glyph grid spends a quad per cell across every
      // slot a feature matches, so it is no longer one — and the cost would
      // otherwise land on sliders that never move the sun at all.
      this.readEngravingShading();
    }

    this.applyAmbientOcclusion(this.structure.geometry);
    this.applyBakedShadow(this.structure.geometry);

    for (const mesh of this.offeringMeshes) {
      this.applyAmbientOcclusion(mesh.geometry);
      this.applyBakedShadow(mesh.geometry);
    }

    this.applyEngravingShading();
  }

  update(deltaTime: number): void {
    this.fireTime += deltaTime;

    for (const entry of this.fireGlowEntries) {
      const slow = Math.sin(this.fireTime * 8 + entry.phase) * entry.flicker * 2 / 3;
      const fast = Math.sin(this.fireTime * 19 + entry.phase * 1.7)
        * entry.flicker / 3;
      entry.light.intensity = entry.baseIntensity * (
        1 - entry.flicker * 2 / 3 + slow + fast
      );
    }
  }

  updateShadowFrustums(): void {
    if (this.sunShadow.camera) {
      this.sunShadow.updateFrustums();
    }
  }

  dispose(): void {
    for (const stopListening of this.stopListeningForStructureMaterialRebuild.values()) {
      stopListening();
    }
    this.stopListeningForStructureMaterialRebuild.clear();
    for (const runtime of this.structureMaterialRuntimes.values()) {
      runtime.dispose();
    }
    this.structureMaterialRuntimes.clear();
    this.structureSurfaceMaterials.clear();
    this.structureMaterialLoads.clear();
    this.disposeOffering();
    this.disposeFireGlowLights();
    this.fireBatch.object.removeFromParent();
    this.fireBatch.dispose();
    this.patchOverlay?.dispose();
    this.patchOverlay = null;
    this.greyboxMaterial.dispose();
    this.slotDebugMaterial.dispose();
    this.fallbackStoneMaterial.dispose();
    this.fallbackIronMaterial.dispose();
    this.fallbackOfferingMaterial.dispose();
    this.offeringWireframeMaterial.dispose();
    this.structure.geometry.dispose();
    this.invalidateWireframe();
    this.wireframeMaterial.dispose();
    this.disposeEngravingDecals();
    // Terminates the map worker and releases every derived texture it uploaded.
    this.engravingMaps.dispose();
    this.moistureNoise.dispose();
    this.disposeVertexNormalsHelper();
    this.composer.dispose();
    this.sunShadow.dispose();
    this.sunLight.dispose();
  }

  /** Re-derives the live attributes the sliders drive off `userData`. */
  private applyGeometryAttributes(geometry: THREE.BufferGeometry): void {
    this.applySurfaceTextureScales(geometry);
    this.applyAmbientOcclusion(geometry);
    this.applyBakedShadow(geometry);
  }

  private applyAmbientOcclusion(geometry: THREE.BufferGeometry): void {
    const base = geometry.userData.vertexAoBase as Float32Array | undefined;
    const attribute = geometry.getAttribute("vertexAo");

    if (!base || !(attribute instanceof THREE.BufferAttribute) || attribute.count !== base.length) {
      return;
    }

    for (let index = 0; index < base.length; index += 1) {
      attribute.setX(
        index,
        THREE.MathUtils.lerp(1, base[index] ?? 1, this.ambientOcclusionStrength),
      );
    }

    attribute.needsUpdate = true;
  }

  private applyBakedShadow(geometry: THREE.BufferGeometry): void {
    const base = geometry.userData.bakedShadowBase as Float32Array | undefined;
    const attribute = geometry.getAttribute("color");

    if (!base || !(attribute instanceof THREE.BufferAttribute) || attribute.count !== base.length) {
      return;
    }

    // The sun term rides the same vertex-colour channel as the crack shadow
    // rather than claiming a third attribute. That is not a shortcut: the
    // material graph runtime binds exactly `vertexAo` and vertex colour, so a
    // separate attribute would need every material document rewired to read
    // it. Both remain independently tunable because each keeps its own base
    // array — the attribute is only ever the product of the two.
    const sun = geometry.userData.sunVisibilityBase as Float32Array | undefined;
    const sunIsUsable = sun !== undefined && sun.length === base.length;

    for (let index = 0; index < base.length; index += 1) {
      const crack = THREE.MathUtils.lerp(
        1,
        base[index] ?? 1,
        this.crackShadowStrength,
      );
      const daylight = sunIsUsable
        ? THREE.MathUtils.lerp(1, sun[index] ?? 1, this.sunShadowStrength)
        : 1;
      const shade = crack * daylight;
      attribute.setXYZ(index, shade, shade, shade);
    }

    attribute.needsUpdate = true;
  }

  /**
   * Refines the composed geometry where it is too coarse to hold a baked
   * sample, then bakes the sun into it.
   *
   * Subdivision happens here rather than in the composer because the structure
   * kernel states its invariants in stones and faces; inflating its face count
   * for a lighting decision would quietly change what those invariants assert.
   */
  private prepareStructureGeometry(
    source: THREE.BufferGeometry,
    illumination: IlluminationConfig,
    detail: DetailLevel,
  ): THREE.BufferGeometry {
    // Scaled by the level, and this is what makes the ladder worth having.
    // Subdivision cost tracks total surface *area*, which barely changes
    // between levels — the coarse levels have the same silhouette, just fewer
    // stones in it. Held at one bound, a bare mass's enormous faces would be
    // refined straight back into roughly the vertex count the full level
    // carries, and the cheapest level would cost the most to prepare.
    const bound = SUN_BAKE_MAX_EDGE * DETAIL_PROFILES[detail].edgeScale;
    const refined = subdivideLongEdges(source, bound);

    if (refined.geometry !== source) {
      source.dispose();
    }

    // Both hierarchies are indexed against this geometry, so both die with it.
    this.sunBakeScene = null;
    this.hostShading = null;
    this.bakeSun(refined.geometry, illumination);

    // A second pass, now that there is a shadow to refine against.
    //
    // The first bake is what makes the second one targetable: until the sun has
    // been traced, nothing knows which edges carry a boundary. Measured on a
    // default mass, 13% of triangles straddle one and 99.3% of vertices come
    // back fully lit or fully dark — so the whole quality problem lives on an
    // eighth of the surface, and refining the other seven eighths would buy
    // nothing at several times the cost.
    const sharpened = subdivideLongEdges(refined.geometry, bound, {
      shadowEdge: SHADOW_EDGE_BOUND * DETAIL_PROFILES[detail].edgeScale,
    });

    if (sharpened.geometry !== refined.geometry) {
      refined.geometry.dispose();
      this.sunBakeScene = null;
      this.hostShading = null;
      this.bakeSun(sharpened.geometry, illumination);
    }

    return sharpened.geometry;
  }

  /**
   * Casts the structure and every loaded offering at the sun in one pass.
   *
   * They go together because they occlude each other: an offering standing on
   * the summit is both caster and receiver, and baking them separately would
   * light each one straight through the other.
   */
  private bakeSun(
    structureGeometry: THREE.BufferGeometry,
    illumination: IlluminationConfig,
  ): void {
    const direction = sunDirectionOf(illumination);

    // The hierarchy outlives a sun move: flattening the triangles and building
    // it is about as expensive as the tracing, and neither depends on where the
    // sun is. Only a geometry change invalidates it.
    if (!this.sunBakeScene) {
      const targets: SunBakeTarget[] = [{ geometry: structureGeometry }];

      for (const mesh of this.offeringMeshes) {
        mesh.updateWorldMatrix(true, false);
        targets.push({ geometry: mesh.geometry, matrixWorld: mesh.matrixWorld });
      }

      this.sunBakeScene = SunBakeScene.from(targets);
    }

    const report = this.sunBakeScene.bake({
      direction,
      softness: SUN_BAKE_SOFTNESS,
      samples: SUN_BAKE_SAMPLES,
    });

    this.sunBakeMs = report.milliseconds;
    this.bakedSunDirection.copy(direction);
  }

  /**
   * Rewrites the merged geometry's UVs at each surface's own texture density.
   *
   * Texture scale is a UV concern rather than a material one: surfaces share
   * material documents, and the runtime's own scale uniform only participates in
   * triplanar sampling, which this project deliberately does not use. Every
   * vertex already names its semantic surface, so the whole structure rescales in
   * one pass over one buffer regardless of how many surfaces it dresses.
   */
  private applySurfaceTextureScales(geometry: THREE.BufferGeometry): void {
    const slots = geometry.getAttribute("surfaceMaterial");
    const scales = MATERIAL_SLOTS.map((slot) => this.textureScaleFor(slot));
    this.applyTextureScale(
      geometry,
      (vertex) => scales[slots ? slots.getX(vertex) : 0] ?? this.materialScale,
    );
  }

  private applyTextureScale(
    geometry: THREE.BufferGeometry,
    scaleAt: (vertex: number) => number,
  ): void {
    const baseUvs = geometry.userData.baseUvs as Float32Array | undefined;
    const attribute = geometry.getAttribute("uv");

    if (!baseUvs || !(attribute instanceof THREE.BufferAttribute)) {
      return;
    }

    for (let index = 0; index < attribute.count; index += 1) {
      const scale = scaleAt(index);
      attribute.setXY(
        index,
        (baseUvs[index * 2] ?? 0) * scale,
        (baseUvs[index * 2 + 1] ?? 0) * scale,
      );
    }

    attribute.needsUpdate = true;
  }

  /** Re-tiles every dressed surface after a scale or palette change. */
  private refreshTextureScales(): void {
    this.applySurfaceTextureScales(this.structure.geometry);

    // A decal reads the material channels at its host's own density, or the
    // stone would change grain across the edge of the engraving.
    for (const mesh of this.engravingMeshes) {
      const surface = mesh.userData.engravingSurface as MaterialSurfaceId;
      const density = (mesh.userData.engravingTextureScale as number | undefined) ?? 1;
      this.applyTextureScale(
        mesh.geometry,
        () => this.textureScaleFor(surface) * density,
      );
    }

    const offeringScale = this.textureScaleFor("offering");

    for (const mesh of this.offeringMeshes) {
      this.applyTextureScale(mesh.geometry, () => offeringScale);
    }
  }

  /**
   * A surface's effective tiling: its own texture scale under the Scene tab's
   * master material scale. A surface this structure does not dress contributes
   * nothing of its own, so it tiles at the master scale alone.
   */
  private textureScaleFor(surface: MaterialSurfaceId): number {
    return this.activeMaterialSurfaces.has(surface)
      ? this.materialScale * this.activeMaterialPalette[surface].textureScale
      : this.materialScale;
  }

  private surfaceMaterial(surface: MaterialSurfaceId): THREE.Material {
    const material = this.activeMaterialSurfaces.has(surface)
      ? this.structureSurfaceMaterials.get(
        this.activeMaterialPalette[surface].document,
      )
      : undefined;

    return material ?? this.fallbackSurfaceMaterial(surface);
  }

  /** What a surface renders as until its document is loaded, or if it fails. */
  private fallbackSurfaceMaterial(surface: MaterialSurfaceId): THREE.Material {
    if (surface === "iron") {
      return this.fallbackIronMaterial;
    }
    if (surface === "slotDebug") {
      return this.slotDebugMaterial;
    }

    return surface === "offering"
      ? this.fallbackOfferingMaterial
      : this.fallbackStoneMaterial;
  }

  private refreshSurfaceMaterials(): void {
    this.structure.material = this.greyboxEnabled
      // Greybox and the slot tint are the combination worth having: form on
      // its own, with the reserved faces still calling out.
      ? MATERIAL_SLOTS.map((slot) =>
        slot === "slotDebug" ? this.slotDebugMaterial : this.greyboxMaterial)
      : MATERIAL_SLOTS.map((slot) => this.surfaceMaterial(slot));
    this.refreshEngravingVisibility();
    this.refreshOfferingPresentation();
  }

  /**
   * Rebuilds every engraved decal from the current graph and assignments.
   *
   * Placement is synchronous and cheap — it reads the slot table and produces
   * quads — while deriving an engraving's maps is neither, so the two are split
   * either side of one await. A build that finishes after a newer one started
   * throws its geometry away rather than displacing it.
   */
  private async refreshEngravingDecals(): Promise<void> {
    const token = ++this.engravingBuildToken;
    const batches = buildEngravingDecalBatches(
      this.graph,
      this.activeSlotFeatures,
      this.activeEngravings,
      this.activeLayout,
    );

    if (batches.length === 0) {
      return;
    }

    // Each batch is placed the moment its own maps land, rather than the whole
    // set waiting on the slowest. That used to be a distinction without a
    // difference, because a structure named at most one layer per feature; a
    // glyph grid can name fifteen at once against a single derivation worker,
    // which would otherwise be one long wait with nothing on screen.
    const maxDimension = engravingResolutionDimension(this.engravingResolution);
    await Promise.all(batches.map(async (batch) => {
      let derived: EngravingTextures;

      try {
        derived = await this.engravingMaps.ensure(batch.layer, maxDimension);
      } catch (error: unknown) {
        console.error(
          `Engraving "${batch.layer.id}" could not be derived; `
          + "its slots stay bare.",
          error,
        );
        batch.geometry.dispose();
        return;
      }

      if (token !== this.engravingBuildToken) {
        batch.geometry.dispose();
        return;
      }

      const runtime = this.structureMaterialRuntimes.get(
        this.activeMaterialPalette[batch.hostSurface].document,
      );

      if (!runtime) {
        // The host's document has not finished loading. Its `onRebuilt` hook
        // brings the decals back the moment it does, so this is a wait rather
        // than a failure.
        batch.geometry.dispose();
        return;
      }

      const mesh = new THREE.Mesh(
        batch.geometry,
        buildEngravingDecalMaterial({
          runtime,
          textures: derived,
          moistureNoise: this.moistureNoise.get(),
          aoIntensity: batch.appearance.aoIntensity,
          normalStrength: batch.appearance.normalStrength,
          moistureLevel: batch.layer.moisture,
        }),
      );
      mesh.name = `Engraving ${batch.layer.id} on ${batch.hostSurface}`;
      mesh.userData.engravingSurface = batch.hostSurface;
      // A quad standing six millimetres proud of its own host must not cast a
      // realtime shadow onto it: that reads as a hairline seam round the decal
      // under a raking sun. It still receives, and its sun term is baked.
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      // The opaque sort is by bounding-sphere distance, which says nothing
      // useful between one decal batch and the whole structure.
      mesh.renderOrder = 1;
      // The same number the stone under it was dressed at, so the grain runs
      // from wall to carving without a boundary anywhere in it.
      mesh.userData.engravingTextureScale = batch.appearance.textureScale;
      this.applyTextureScale(
        batch.geometry,
        () => this.textureScaleFor(batch.hostSurface) * batch.appearance.textureScale,
      );
      this.engravingMeshes.push(mesh);
      this.engravingRoot.add(mesh);
      this.readHostShading(batch.geometry, batch.standOff);
      this.refreshEngravingVisibility();
    }));
  }

  /**
   * Gives a decal the shading of the stone it lies on.
   *
   * `mergeDecalQuads` fills both base arrays with ones, because it builds
   * geometry with no scene to ask. Here there is one, and the difference is not
   * subtle: a wall averages 0.62 occlusion and 0.39 crack shadow against a
   * decal's flat 1.0, so a decal that keeps the ones reads as a brighter plate
   * laid on the stone rather than as carving in it.
   *
   * A vertex that finds nothing keeps its one. That is the right answer for a
   * decal with no host behind it, and the only safe one — a miss must not
   * blacken an engraving.
   */
  private readHostShading(
    geometry: THREE.BufferGeometry,
    standOff: number,
  ): void {
    const sampler = this.hostShading ??= HostShadingSampler.from(
      this.structure.geometry,
    );
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    const ambientOcclusion = geometry.userData.vertexAoBase as Float32Array;
    const bakedShadow = geometry.userData.bakedShadowBase as Float32Array;
    const sunVisibility = geometry.userData.sunVisibilityBase as Float32Array;
    geometry.userData.decalStandOff = standOff;

    if (!sampler || !position || !normal) {
      return;
    }

    for (let vertex = 0; vertex < position.count; vertex += 1) {
      const shading = sampler.sample(
        position.getX(vertex),
        position.getY(vertex),
        position.getZ(vertex),
        normal.getX(vertex),
        normal.getY(vertex),
        normal.getZ(vertex),
        standOff,
      );

      if (shading) {
        ambientOcclusion[vertex] = shading.ambientOcclusion;
        bakedShadow[vertex] = shading.bakedShadow;
        sunVisibility[vertex] = shading.sunVisibility;
      }
    }
  }

  /**
   * Lights the decals with the same sun that lit the stone under them.
   *
   * Without this a decal is a bright patch on a wall the sun never reached, and
   * a shadow crossing an engraved elevation stops dead at the engraving. They
   * are traced through the structure's existing hierarchy as receivers only —
   * see `SunBakeScene.bakeTargets` for why they must not join it as casters.
   */
  /**
   * Re-reads every decal's shading from the stone it lies on.
   *
   * A decal used to trace its own rays at the sun, through the structure as an
   * occluder. That was right in principle and measurably wrong in fact: the
   * rays leave from a few millimetres out in front of the wall, clear of the
   * course joints and stone offsets that shadow the surface underneath, so a
   * decal came back better lit than its own host — 0.31 against 0.20 on a
   * coursed elevation. Uniform across a quad and stepping at its edge, which is
   * a lighter rectangle round every carving and the reason those rectangles
   * vanished the moment the sun's shadow was switched off.
   *
   * Reading the wall's own answer is both correct and cheaper: a decal is not a
   * separate surface that happens to be near the stone, it *is* the stone, and
   * nothing about how it is lit should be derived independently.
   */
  private readEngravingShading(): void {
    for (const mesh of this.engravingMeshes) {
      const standOff = (mesh.geometry.userData.decalStandOff as number | undefined)
        ?? 0;
      this.readHostShading(mesh.geometry, standOff);
    }

    this.applyEngravingShading();
  }

  /**
   * Re-derives the two strength-driven channels from the arrays the bake left.
   *
   * Split out because it is the cheap half. A colour, an intensity or either
   * strength slider only rescales what is already there, exactly as it does for
   * the structure — so this runs on every illumination change while the bake
   * above waits for the sun to actually move.
   */
  private applyEngravingShading(
    meshes: readonly THREE.Mesh[] = this.engravingMeshes,
  ): void {
    for (const mesh of meshes) {
      this.applyAmbientOcclusion(mesh.geometry);
      this.applyBakedShadow(mesh.geometry);
    }
  }

  /**
   * Drops every decal and starts building them again.
   *
   * The single entry point for all four reasons a decal can go stale: the graph
   * was rebuilt, the choices changed, the palette changed, or a material
   * document finished baking and handed back new channel textures. Cheap to
   * call repeatedly — the derived maps are cached, and the build token makes
   * overlapping calls resolve to the newest.
   */
  private rebuildEngravingDecals(): void {
    this.disposeEngravingDecals();
    void this.refreshEngravingDecals();
  }

  /**
   * Greybox exists so massing can be judged on silhouette and proportion, and
   * an engraving is the most flattering thing that could be on a surface — a
   * greybox that keeps it is not a greybox. The slot debug tint is the
   * opposite: watching a decal land inside the reddened quad is exactly the
   * check that tint exists for, so it stays.
   */
  private refreshEngravingVisibility(): void {
    this.engravingRoot.visible = !this.greyboxEnabled && !this.wireframeVisible;
  }

  private disposeEngravingDecals(): void {
    for (const mesh of this.engravingMeshes) {
      mesh.removeFromParent();
      mesh.geometry.dispose();
      disposeEngravingDecalMaterial(mesh.material as THREE.Material);
    }

    this.engravingMeshes = [];
  }

  private rebuildPatchOverlay(): void {
    this.patchOverlay?.dispose();
    this.patchOverlay = null;

    if (!this.patchDebugVisible || !this.graph) {
      return;
    }

    this.patchOverlay = createPatchOverlay(this.graph);
    this.scene.add(this.patchOverlay.object);
  }

  private async loadMaterialRuntime(
    renderer: WebGPURenderer,
    documentUrl: string,
    label: string,
  ): Promise<MaterialGraphRuntime> {
    const response = await fetch(documentUrl);

    if (!response.ok) {
      throw new Error(`Failed to load ${label.toLowerCase()} material: ${response.status} ${response.statusText}`);
    }

    const sourceDocument = await response.json() as MaterialGraphDocument;
    const document = migrateMaterialDocument(sourceDocument);
    const outputNode = document.nodes.find((node) => node.type === "material-output");

    if (!outputNode) {
      throw new Error(`${label} material document has no material output node.`);
    }

    outputNode.params.outputResolution = String(MATERIAL_OUTPUT_RESOLUTION);

    const runtime = new MaterialGraphRuntime({
      document,
      source: documentUrl,
    }).setRenderer(renderer);
    runtime.surface.setBackend("offline");
    // Texture density is carried by the geometry's UVs, not by the surface's own
    // scale uniform, which only takes part in triplanar sampling. One document
    // can therefore dress several surfaces at different densities.
    runtime.surface.setTriplanar(false);

    await runtime.refresh();

    if (runtime.lastError) {
      runtime.dispose();
      throw new Error(`${label} material failed to compile: ${runtime.lastError}`);
    }

    return runtime;
  }

  private ensureStructureMaterialRuntime(
    renderer: WebGPURenderer,
    id: MaterialDocumentId,
  ): Promise<MaterialGraphRuntime> {
    const cached = this.structureMaterialRuntimes.get(id);

    if (cached) {
      return Promise.resolve(cached);
    }

    const pending = this.structureMaterialLoads.get(id);

    if (pending) {
      return pending;
    }

    const load = this.loadMaterialRuntime(
      renderer,
      materialDocumentUrl(id),
      id,
    ).then((runtime) => {
      this.structureMaterialRuntimes.set(id, runtime);
      this.useStructureRuntimeMaterial(id, runtime);
      this.stopListeningForStructureMaterialRebuild.set(
        id,
        runtime.surface.onRebuilt(() =>
          this.useStructureRuntimeMaterial(id, runtime)),
      );
      return runtime;
    }).finally(() => {
      this.structureMaterialLoads.delete(id);
    });

    this.structureMaterialLoads.set(id, load);
    return load;
  }

  private useStructureRuntimeMaterial(
    id: MaterialDocumentId,
    runtime: MaterialGraphRuntime,
  ): void {
    const material = runtime.getNodeMaterial();
    material.vertexColors = true;
    material.needsUpdate = true;
    this.structureSurfaceMaterials.set(id, material);
    this.refreshSurfaceMaterials();
    // A rebake hands back new channel textures, and a TSL `texture()` node
    // captured the old objects. Decal materials read those channels directly,
    // so they have to be composed again against the new ones.
    this.rebuildEngravingDecals();
  }

  private ensureWireframe(): Wireframe {
    if (!this.structureWireframe) {
      const geometry = new WireframeGeometry2(this.structure.geometry);
      geometry.computeBoundingSphere();

      // The depth fade spans this geometry's own extent, so it needs no
      // per-frame update: the camera's side of the range moves with
      // `cameraPosition` inside the shader.
      const bounds = geometry.boundingSphere;

      if (bounds) {
        this.wireframeFocus.value.copy(bounds.center);
        this.wireframeRadius.value = Math.max(bounds.radius, 1e-3);
      }

      this.structureWireframe = new Wireframe(geometry, this.wireframeMaterial);
      this.structureWireframe.name = "Structure wireframe";
      this.scene.add(this.structureWireframe);
    }

    return this.structureWireframe;
  }

  private invalidateWireframe(): void {
    if (!this.structureWireframe) {
      return;
    }

    this.structureWireframe.removeFromParent();
    this.structureWireframe.geometry.dispose();
    this.structureWireframe = null;

    if (this.wireframeVisible) {
      this.ensureWireframe().visible = true;
    }
  }

  private rebuildVertexNormalsHelper(): void {
    this.disposeVertexNormalsHelper();

    if (!this.vertexNormalsVisible) {
      return;
    }

    // Derived from the composition rather than a type-specific radius, so this
    // works for any structure.
    const size = new THREE.Box3()
      .setFromObject(this.structure)
      .getSize(new THREE.Vector3())
      .length() * VERTEX_NORMAL_SIZE_RATIO;
    this.vertexNormalsHelper = new VertexNormalsHelper(
      this.structure,
      size,
      0x22d3ee,
    );
    this.scene.add(this.vertexNormalsHelper);
  }

  private disposeVertexNormalsHelper(): void {
    this.vertexNormalsHelper?.removeFromParent();
    this.vertexNormalsHelper?.dispose();
    this.vertexNormalsHelper = null;
  }

  private updateOfferingTransform(): void {
    if (!this.offeringRoot || !this.offeringSourceBounds || !this.anchors.offering) {
      return;
    }

    const transform = calculateOfferingTransform(
      this.offeringSourceBounds,
      this.anchors.offering,
      this.offeringConfig,
      this.offeringSupportCenter ?? undefined,
    );
    this.offeringRoot.scale.setScalar(transform.scale);
    this.offeringRoot.position.copy(transform.position);
    this.offeringRoot.rotation.y = transform.rotationY;
    this.offeringRoot.updateMatrixWorld(true);
  }

  private refreshOfferingPresentation(): void {
    if (!this.offeringRoot) {
      return;
    }

    // A structure that exposes no offering anchor has nowhere to stand one, so
    // the model is hidden rather than left where the last structure put it.
    // `updateOfferingTransform` bails without an anchor, so anything still
    // visible would be frozen at another structure's position.
    this.offeringRoot.visible = this.offeringConfig.enabled
      && this.anchors.offering !== null;
    const material = this.wireframeVisible
      ? this.offeringWireframeMaterial
      : this.surfaceMaterial("offering");

    for (const mesh of this.offeringMeshes) {
      mesh.material = material;
    }
  }

  private disposeOffering(): void {
    this.offeringRoot?.removeFromParent();
    const geometries = new Set(
      this.offeringMeshes.map((mesh) => mesh.geometry),
    );

    for (const geometry of geometries) {
      geometry.dispose();
    }

    this.offeringMeshes.length = 0;
    this.offeringRoot = null;
    this.offeringSourceBounds = null;
    this.offeringSupportCenter = null;
    this.currentOfferingStats = emptyOfferingStats();
  }

  /**
   * Positions flames and glow lights from the generator's anchors. Bowls being
   * disabled yields no anchors at all, so only `fire.enabled` needs checking.
   */
  private applyFireEffects(fireConfig: FireConfig): void {
    validateFireConfig(fireConfig);
    this.fireBatch.update({
      enabled: fireConfig.enabled,
      scale: fireConfig.scale,
      radius: fireConfig.radius,
      height: fireConfig.height,
      baseHeight: fireConfig.baseHeight,
      speed: fireConfig.speed,
      noiseScale: fireConfig.noiseScale,
      turbulence: fireConfig.turbulence,
      intensity: fireConfig.intensity,
      radialSegments: fireConfig.radialSegments,
      placements: this.anchors.flames,
    });
    this.fireBatch.setSceneVisible(!this.wireframeVisible);
    this.rebuildFireGlowLights(fireConfig);
  }

  private rebuildFireGlowLights(fireConfig: FireConfig): void {
    const anchors = fireConfig.enabled && fireConfig.glowEnabled
      ? this.anchors.glows
      : [];

    while (this.fireGlowEntries.length > anchors.length) {
      const entry = this.fireGlowEntries.pop();
      entry?.light.removeFromParent();
      entry?.light.dispose();
    }

    while (this.fireGlowEntries.length < anchors.length) {
      const light = new THREE.PointLight(FIRE_GLOW_COLOR, 0, 0, 2);
      light.castShadow = false;
      light.shadow.mapSize.set(
        FIRE_GLOW_SHADOW_MAP_SIZE,
        FIRE_GLOW_SHADOW_MAP_SIZE,
      );
      light.shadow.bias = FIRE_GLOW_SHADOW_BIAS;
      light.shadow.normalBias = FIRE_GLOW_SHADOW_NORMAL_BIAS;
      this.scene.add(light);
      this.fireGlowEntries.push({
        light,
        baseIntensity: 0,
        phase: 0,
        flicker: 0,
      });
    }

    for (let index = 0; index < anchors.length; index += 1) {
      const anchor = anchors[index];
      const glowEntry = this.fireGlowEntries[index];

      if (!anchor || !glowEntry) {
        continue;
      }

      const { light } = glowEntry;
      light.name = `Fire glow ${anchor.label}`;
      light.color.setHex(FIRE_GLOW_COLOR);
      light.castShadow = this.fireGlowShadowsSupported
        && fireConfig.glowCastShadow;
      light.intensity = fireConfig.glowIntensity;
      light.distance = fireConfig.glowDistance;
      light.decay = 2;
      light.shadow.camera.near = FIRE_GLOW_SHADOW_NEAR;
      light.shadow.camera.far = fireConfig.glowDistance;
      light.shadow.camera.updateProjectionMatrix();

      const horizontalLength = Math.hypot(
        anchor.outwardX ?? 0,
        anchor.outwardZ ?? 0,
      );
      const outwardX = horizontalLength > 0
        ? (anchor.outwardX ?? 0) / horizontalLength
        : 0;
      const outwardZ = horizontalLength > 0
        ? (anchor.outwardZ ?? 0) / horizontalLength
        : 0;
      light.position.set(
        anchor.x + outwardX * fireConfig.glowHorizontalDistance,
        anchor.y
          + fireConfig.baseHeight
          + fireConfig.height * fireConfig.scale * 0.35
          + fireConfig.glowVerticalDistance,
        anchor.z + outwardZ * fireConfig.glowHorizontalDistance,
      );
      light.visible = !this.wireframeVisible;
      glowEntry.baseIntensity = fireConfig.glowIntensity;
      glowEntry.phase = index * 1.7;
      glowEntry.flicker = fireConfig.glowFlicker;
    }
  }

  private disposeFireGlowLights(): void {
    for (const entry of this.fireGlowEntries) {
      entry.light.removeFromParent();
      entry.light.dispose();
    }

    this.fireGlowEntries.length = 0;
  }
}

function emptyOfferingStats(): OfferingStats {
  return {
    meshCount: 0,
    vertexCount: 0,
    triangleCount: 0,
  };
}

function offeringStats(meshes: readonly THREE.Mesh[]): OfferingStats {
  const stats = emptyOfferingStats();

  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute("position");
    const index = mesh.geometry.index;
    stats.meshCount += 1;
    stats.vertexCount += position.count;
    stats.triangleCount += index ? index.count / 3 : position.count / 3;
  }

  return stats;
}
