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
import { StructureComposer } from "../structure/composer";
import { createPatchOverlay, type PatchOverlay } from "../structure/kernel/debug-overlay";
import type { StructureGraph } from "../structure/kernel/graph";
import type { Diagnostic } from "../structure/kernel/validate";
import type { StructureConfig } from "../config/structure-config";
import { DEFAULT_VIEW_CONFIG, type IlluminationConfig } from "../config/sections";
import {
  emptySectionStats,
  emptyPartStats,
  type CompositionAnchors,
  type PartSection,
  type PartStats,
} from "../geometry/part";
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
const CSM_CASCADES = 3;
const CSM_MAX_FAR = 80;
const CSM_LIGHT_MARGIN = 20;
const SHADOW_MAP_SIZE = 1024;
const MAX_FIRE_FLAMES = 16;
const FIRE_GLOW_COLOR = 0xff5a12;
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

export class MainScene {
  readonly scene = new THREE.Scene();
  private readonly composer = new StructureComposer();
  private readonly greyboxMaterial: THREE.MeshStandardMaterial;
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
  private patchDebugVisible = false;
  private patchOverlay: PatchOverlay | null = null;
  private graph: StructureGraph | null = null;
  private anchors: CompositionAnchors;
  private sectionStats = emptySectionStats();
  private totalStats = emptyPartStats();
  private currentOfferingStats: OfferingStats = emptyOfferingStats();
  private offeringConfig: OfferingConfig;
  private stoneSurfaceMaterial: THREE.Material;
  private ironSurfaceMaterial: THREE.Material;
  private offeringSurfaceMaterial: THREE.Material;
  private stoneMaterialRuntime: MaterialGraphRuntime | null = null;
  private ironMaterialRuntime: MaterialGraphRuntime | null = null;
  private offeringMaterialRuntime: MaterialGraphRuntime | null = null;
  private stopListeningForStoneRebuild: (() => void) | null = null;
  private stopListeningForIronRebuild: (() => void) | null = null;
  private stopListeningForOfferingRebuild: (() => void) | null = null;
  private materialScale: number;
  private ambientOcclusionStrength: number;
  private crackShadowStrength: number;
  private fireTime = 0;
  private wireframeVisible = false;

  constructor(config: StructureConfig) {
    validateOfferingConfig(config.offering);
    this.offeringConfig = { ...config.offering };
    this.materialScale = config.view.materialScale;
    this.ambientOcclusionStrength = config.illumination.ambientOcclusion;
    this.crackShadowStrength = config.illumination.crackShadow;
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
    this.stoneSurfaceMaterial = this.fallbackStoneMaterial;
    this.ironSurfaceMaterial = this.fallbackIronMaterial;
    this.offeringSurfaceMaterial = this.fallbackOfferingMaterial;

    const composition = this.composer.build(config);
    this.anchors = composition.anchors;
    this.graph = composition.graph;
    this.sectionStats = composition.sections;
    this.totalStats = composition.totals;
    this.applyGeometryAttributes(composition.geometry);
    // Always both materials, so material group 1 stays addressable even on a
    // build with no iron parts.
    this.structure = new THREE.Mesh(composition.geometry, [
      this.fallbackStoneMaterial,
      this.fallbackIronMaterial,
    ]);
    this.structure.name = "Structure";
    this.structure.castShadow = true;
    this.structure.receiveShadow = true;
    this.scene.add(this.structure, this.fireBatch.object);
    this.applyFireEffects(config.fire);

    this.sunLight = new THREE.DirectionalLight();
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    this.sunLight.shadow.bias = -0.0001;
    this.sunLight.shadow.normalBias = 0.01;
    this.sunShadow = new CSMShadowNode(this.sunLight, {
      cascades: CSM_CASCADES,
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

  async loadStoneMaterial(
    renderer: WebGPURenderer,
    documentUrl: string,
  ): Promise<void> {
    const runtime = await this.loadMaterialRuntime(renderer, documentUrl, "Stone");
    this.stopListeningForStoneRebuild?.();
    this.stoneMaterialRuntime?.dispose();
    this.stoneMaterialRuntime = runtime;
    this.useStoneRuntimeMaterial(runtime);
    this.stopListeningForStoneRebuild = runtime.surface.onRebuilt(() => {
      this.useStoneRuntimeMaterial(runtime);
    });
  }

  async loadIronMaterial(
    renderer: WebGPURenderer,
    documentUrl: string,
  ): Promise<void> {
    const runtime = await this.loadMaterialRuntime(renderer, documentUrl, "Iron");
    this.stopListeningForIronRebuild?.();
    this.ironMaterialRuntime?.dispose();
    this.ironMaterialRuntime = runtime;
    this.useIronRuntimeMaterial(runtime);
    this.stopListeningForIronRebuild = runtime.surface.onRebuilt(() => {
      this.useIronRuntimeMaterial(runtime);
    });
  }

  async loadOfferingMaterial(
    renderer: WebGPURenderer,
    documentUrl: string,
  ): Promise<void> {
    const runtime = await this.loadMaterialRuntime(
      renderer,
      documentUrl,
      "Offering",
      this.offeringConfig.materialScale,
    );
    this.stopListeningForOfferingRebuild?.();
    this.offeringMaterialRuntime?.dispose();
    this.offeringMaterialRuntime = runtime;
    this.useOfferingRuntimeMaterial(runtime);
    this.stopListeningForOfferingRebuild = runtime.surface.onRebuilt(() => {
      this.useOfferingRuntimeMaterial(runtime);
    });
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
        prepareOfferingGeometry(object.geometry);
        this.applyMaterialScale(
          object.geometry,
          this.offeringConfig.materialScale,
        );
        this.applyAmbientOcclusion(object.geometry);
        this.applyBakedShadow(object.geometry);
        preparedGeometries.add(object.geometry);
      }

      object.material = this.offeringSurfaceMaterial;
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
    this.applyGeometryAttributes(composition.geometry);
    this.structure.geometry = composition.geometry;
    this.anchors = composition.anchors;
    this.graph = composition.graph;
    this.sectionStats = composition.sections;
    this.totalStats = composition.totals;
    // Rebuilding the wireframe on every geometry swap costs more than the
    // geometry itself, and it is hidden almost always, so drop it and rebuild
    // lazily if the user is actually looking at it.
    this.invalidateWireframe();
    this.rebuildPatchOverlay();
    this.rebuildVertexNormalsHelper();
    this.updateOfferingTransform();
    this.refreshOfferingPresentation();
    this.applyFireEffects(config.fire);
    previousGeometry.dispose();

    return this.getStats();
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
    this.materialScale = scale;
    this.stoneMaterialRuntime?.surface.setScale(scale);
    this.ironMaterialRuntime?.surface.setScale(scale);
    this.applyMaterialScale(this.structure.geometry);
  }

  setOfferingConfig(config: OfferingConfig): void {
    validateOfferingConfig(config);
    this.offeringConfig = { ...config };
    this.offeringMaterialRuntime?.surface.setScale(config.materialScale);

    for (const mesh of this.offeringMeshes) {
      this.applyMaterialScale(mesh.geometry, config.materialScale);
    }

    this.updateOfferingTransform();
    this.refreshOfferingPresentation();
  }

  setWireframe(enabled: boolean): void {
    this.wireframeVisible = enabled;
    this.structure.visible = !enabled;
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
    this.refreshStructureMaterials();
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
    this.sunLight.color.set(config.keyColor);
    this.sunLight.intensity = config.keyIntensity;

    const azimuth = THREE.MathUtils.degToRad(config.keyAzimuth);
    const elevation = THREE.MathUtils.degToRad(config.keyElevation);
    const horizontalDistance = Math.cos(elevation) * 10;
    this.sunLight.position.set(
      Math.cos(azimuth) * horizontalDistance,
      Math.sin(elevation) * 10,
      Math.sin(azimuth) * horizontalDistance,
    );

    this.hemisphereLight.color.set(config.skyColor);
    this.hemisphereLight.groundColor.set(config.groundColor);
    this.hemisphereLight.intensity = config.ambientIntensity;
    this.ambientOcclusionStrength = THREE.MathUtils.clamp(
      config.ambientOcclusion,
      0,
      1,
    );
    this.crackShadowStrength = THREE.MathUtils.clamp(config.crackShadow, 0, 1);
    this.applyAmbientOcclusion(this.structure.geometry);
    this.applyBakedShadow(this.structure.geometry);

    for (const mesh of this.offeringMeshes) {
      this.applyAmbientOcclusion(mesh.geometry);
      this.applyBakedShadow(mesh.geometry);
    }
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
    this.stopListeningForStoneRebuild?.();
    this.stopListeningForStoneRebuild = null;
    this.stopListeningForIronRebuild?.();
    this.stopListeningForIronRebuild = null;
    this.stopListeningForOfferingRebuild?.();
    this.stopListeningForOfferingRebuild = null;
    this.stoneMaterialRuntime?.dispose();
    this.stoneMaterialRuntime = null;
    this.ironMaterialRuntime?.dispose();
    this.ironMaterialRuntime = null;
    this.offeringMaterialRuntime?.dispose();
    this.offeringMaterialRuntime = null;
    this.disposeOffering();
    this.disposeFireGlowLights();
    this.fireBatch.object.removeFromParent();
    this.fireBatch.dispose();
    this.patchOverlay?.dispose();
    this.patchOverlay = null;
    this.greyboxMaterial.dispose();
    this.fallbackStoneMaterial.dispose();
    this.fallbackIronMaterial.dispose();
    this.fallbackOfferingMaterial.dispose();
    this.offeringWireframeMaterial.dispose();
    this.structure.geometry.dispose();
    this.invalidateWireframe();
    this.wireframeMaterial.dispose();
    this.disposeVertexNormalsHelper();
    this.composer.dispose();
    this.sunShadow.dispose();
    this.sunLight.dispose();
  }

  /** Re-derives the live attributes the sliders drive off `userData`. */
  private applyGeometryAttributes(geometry: THREE.BufferGeometry): void {
    this.applyMaterialScale(geometry);
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

    for (let index = 0; index < base.length; index += 1) {
      const shade = THREE.MathUtils.lerp(
        1,
        base[index] ?? 1,
        this.crackShadowStrength,
      );
      attribute.setXYZ(index, shade, shade, shade);
    }

    attribute.needsUpdate = true;
  }

  private applyMaterialScale(
    geometry: THREE.BufferGeometry,
    scale = this.materialScale,
  ): void {
    const baseUvs = geometry.userData.baseUvs as Float32Array | undefined;
    const attribute = geometry.getAttribute("uv");

    if (!baseUvs || !(attribute instanceof THREE.BufferAttribute)) {
      return;
    }

    for (let index = 0; index < attribute.count; index += 1) {
      attribute.setXY(
        index,
        (baseUvs[index * 2] ?? 0) * scale,
        (baseUvs[index * 2 + 1] ?? 0) * scale,
      );
    }

    attribute.needsUpdate = true;
  }

  private useStoneRuntimeMaterial(runtime: MaterialGraphRuntime): void {
    const material = runtime.getNodeMaterial();
    material.vertexColors = true;
    material.needsUpdate = true;
    this.stoneSurfaceMaterial = material;
    this.refreshStructureMaterials();
  }

  private useIronRuntimeMaterial(runtime: MaterialGraphRuntime): void {
    const material = runtime.getNodeMaterial();
    material.vertexColors = true;
    material.needsUpdate = true;
    this.ironSurfaceMaterial = material;
    this.refreshStructureMaterials();
  }

  private useOfferingRuntimeMaterial(runtime: MaterialGraphRuntime): void {
    const material = runtime.getNodeMaterial();
    material.vertexColors = true;
    material.needsUpdate = true;
    this.offeringSurfaceMaterial = material;
    this.refreshOfferingPresentation();
  }

  private refreshStructureMaterials(): void {
    this.structure.material = this.greyboxEnabled
      ? [this.greyboxMaterial, this.greyboxMaterial]
      : [this.stoneSurfaceMaterial, this.ironSurfaceMaterial];
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
    scale = this.materialScale,
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
    runtime.surface.setTriplanar(false);
    runtime.surface.setScale(scale);

    await runtime.refresh();

    if (runtime.lastError) {
      runtime.dispose();
      throw new Error(`${label} material failed to compile: ${runtime.lastError}`);
    }

    return runtime;
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
      : this.offeringSurfaceMaterial;

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
      light.intensity = fireConfig.glowIntensity;
      light.distance = fireConfig.glowDistance;
      light.decay = 2;
      light.position.set(
        anchor.x,
        anchor.y
          + fireConfig.baseHeight
          + fireConfig.height * fireConfig.scale * 0.35,
        anchor.z,
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
