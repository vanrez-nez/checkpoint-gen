import * as THREE from "three";
import type { WebGPURenderer } from "three/webgpu";
import { CSMShadowNode } from "three/examples/jsm/csm/CSMShadowNode.js";
import { VertexNormalsHelper } from "three/examples/jsm/helpers/VertexNormalsHelper.js";
import {
  MaterialGraphRuntime,
  migrateMaterialDocument,
  type MaterialGraphDocument,
} from "material-designer-runtime";
import {
  createCheckpointGeometry,
  type CheckpointGeometryConfig,
  type CheckpointGeometryResult,
} from "../checkpoint/generator";
import {
  VertexConeFireBatch,
  validateFireConfig,
  type FireConfig,
} from "../fire/vertex-cone";
import { type StoneGeometryResult } from "../geometry/stone-builder";
import {
  createPillarGeometry,
  type PillarGeometryConfig,
} from "../pillar/generator";
import {
  createPillarPlacements,
  type PillarPlacement,
} from "../pillar/layout";

const MATERIAL_OUTPUT_RESOLUTION = 512;
export const DEFAULT_MATERIAL_SCALE = 1;
const CSM_CASCADES = 3;
const CSM_MAX_FAR = 80;
const CSM_LIGHT_MARGIN = 20;
const SHADOW_MAP_SIZE = 1024;
const MAX_FIRE_FLAMES = 16;
const FIRE_GLOW_COLOR = 0xff5a12;

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
};

export interface PillarSetStats {
  pillarCount: number;
  stoneCount: number;
  vertexCount: number;
  triangleCount: number;
  fireBowlVertexCount: number;
  fireBowlTriangleCount: number;
  flameCount: number;
  flameVertexCount: number;
  flameTriangleCount: number;
  flameDrawCallCount: number;
  glowLightCount: number;
}

type PillarSceneEntry = {
  mesh: THREE.Mesh;
  wireframe: THREE.LineSegments<THREE.WireframeGeometry, THREE.LineBasicMaterial>;
};

type FireGlowEntry = {
  light: THREE.PointLight;
  baseIntensity: number;
  phase: number;
  flicker: number;
};

export class MainScene {
  readonly scene = new THREE.Scene();
  private readonly fallbackStoneMaterial: THREE.MeshStandardMaterial;
  private readonly fallbackIronMaterial: THREE.MeshStandardMaterial;
  private readonly checkpoint: THREE.Mesh;
  private readonly checkpointWireframe: THREE.LineSegments<
    THREE.WireframeGeometry,
    THREE.LineBasicMaterial
  >;
  private readonly pillarGroup = new THREE.Group();
  private readonly pillarWireframeGroup = new THREE.Group();
  private readonly pillarEntries: PillarSceneEntry[] = [];
  private readonly fireBatch: VertexConeFireBatch;
  private readonly fireGlowEntries: FireGlowEntry[] = [];
  private readonly sunLight: THREE.DirectionalLight;
  private readonly hemisphereLight: THREE.HemisphereLight;
  private readonly sunShadow: CSMShadowNode;
  private readonly vertexNormalsHelpers: VertexNormalsHelper[] = [];
  private vertexNormalsVisible = false;
  private vertexNormalsSize: number;
  private currentCheckpointStats: Omit<CheckpointGeometryResult, "geometry">;
  private currentPillarStats: PillarSetStats = emptyPillarStats();
  private stoneSurfaceMaterial: THREE.Material;
  private ironSurfaceMaterial: THREE.Material;
  private stoneMaterialRuntime: MaterialGraphRuntime | null = null;
  private ironMaterialRuntime: MaterialGraphRuntime | null = null;
  private stopListeningForStoneRebuild: (() => void) | null = null;
  private stopListeningForIronRebuild: (() => void) | null = null;
  private materialScale = DEFAULT_MATERIAL_SCALE;
  private ambientOcclusionStrength = DEFAULT_ILLUMINATION_CONFIG.ambientOcclusion;
  private crackShadowStrength = DEFAULT_ILLUMINATION_CONFIG.crackShadow;
  private fireTime = 0;
  private wireframeVisible = false;

  constructor(
    config: CheckpointGeometryConfig,
    pillarConfig: PillarGeometryConfig,
    fireConfig: FireConfig,
  ) {
    this.scene.background = new THREE.Color(0x171714);
    this.vertexNormalsSize = config.radius * 0.04;
    this.fireBatch = new VertexConeFireBatch(
      fireConfig.radialSegments,
      MAX_FIRE_FLAMES,
    );

    const result = createCheckpointGeometry(config);
    this.applyMaterialScale(result.geometry);
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
    this.stoneSurfaceMaterial = this.fallbackStoneMaterial;
    this.ironSurfaceMaterial = this.fallbackIronMaterial;
    this.checkpoint = new THREE.Mesh(result.geometry, this.fallbackStoneMaterial);
    this.checkpoint.castShadow = true;
    this.checkpoint.receiveShadow = true;
    this.checkpointWireframe = new THREE.LineSegments(
      new THREE.WireframeGeometry(result.geometry),
      new THREE.LineBasicMaterial({ color: 0xd8d8d8 }),
    );
    this.checkpointWireframe.visible = false;
    this.currentCheckpointStats = geometryStats(result);
    this.scene.add(
      this.checkpoint,
      this.checkpointWireframe,
      this.pillarGroup,
      this.pillarWireframeGroup,
      this.fireBatch.object,
    );
    this.rebuildPillars(config, pillarConfig, fireConfig);

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
    this.setIllumination(DEFAULT_ILLUMINATION_CONFIG);
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

  rebuild(config: CheckpointGeometryConfig): CheckpointGeometryResult {
    const result = createCheckpointGeometry(config);
    const previousGeometry = this.checkpoint.geometry;
    const previousWireframeGeometry = this.checkpointWireframe.geometry;
    this.applyMaterialScale(result.geometry);
    this.applyAmbientOcclusion(result.geometry);
    this.applyBakedShadow(result.geometry);
    this.checkpoint.geometry = result.geometry;
    this.checkpointWireframe.geometry = new THREE.WireframeGeometry(result.geometry);
    this.vertexNormalsSize = config.radius * 0.04;
    this.rebuildVertexNormalsHelpers();
    this.currentCheckpointStats = geometryStats(result);
    previousGeometry.dispose();
    previousWireframeGeometry.dispose();

    return result;
  }

  rebuildPillars(
    checkpointConfig: CheckpointGeometryConfig,
    pillarConfig: PillarGeometryConfig,
    fireConfig: FireConfig,
  ): PillarSetStats {
    this.disposePillars();

    const stats = emptyPillarStats();
    const placements = createPillarPlacements(checkpointConfig, pillarConfig);

    for (const placement of placements) {
      const result = createPillarGeometry({
        ...pillarConfig,
        seed: placement.seed,
      });
      this.applyMaterialScale(result.geometry);
      this.applyAmbientOcclusion(result.geometry);
      this.applyBakedShadow(result.geometry);

      const mesh = new THREE.Mesh(result.geometry, [
        this.stoneSurfaceMaterial,
        this.ironSurfaceMaterial,
      ]);
      mesh.position.set(placement.x, placement.y, placement.z);
      mesh.rotation.y = placement.rotationY;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const wireframe = new THREE.LineSegments(
        new THREE.WireframeGeometry(result.geometry),
        new THREE.LineBasicMaterial({ color: 0xd8d8d8 }),
      );
      wireframe.position.copy(mesh.position);
      wireframe.rotation.copy(mesh.rotation);
      wireframe.visible = this.checkpointWireframe.visible;
      mesh.visible = this.checkpoint.visible;
      this.pillarGroup.add(mesh);
      this.pillarWireframeGroup.add(wireframe);
      this.pillarEntries.push({ mesh, wireframe });

      stats.pillarCount += 1;
      stats.stoneCount += result.stoneCount;
      stats.vertexCount += result.vertexCount;
      stats.triangleCount += result.triangleCount;
      stats.fireBowlVertexCount += result.fireBowlVertexCount;
      stats.fireBowlTriangleCount += result.fireBowlTriangleCount;
    }

    Object.assign(
      stats,
      this.applyFireEffects(checkpointConfig, pillarConfig, fireConfig, placements),
    );

    this.currentPillarStats = stats;
    this.rebuildVertexNormalsHelpers();
    return { ...stats };
  }

  rebuildFireEffects(
    checkpointConfig: CheckpointGeometryConfig,
    pillarConfig: PillarGeometryConfig,
    fireConfig: FireConfig,
  ): PillarSetStats {
    const placements = createPillarPlacements(checkpointConfig, pillarConfig);
    Object.assign(
      this.currentPillarStats,
      this.applyFireEffects(checkpointConfig, pillarConfig, fireConfig, placements),
    );
    return { ...this.currentPillarStats };
  }

  getGeometryStats(): Omit<CheckpointGeometryResult, "geometry"> {
    return this.currentCheckpointStats;
  }

  getPillarStats(): PillarSetStats {
    return { ...this.currentPillarStats };
  }

  getCompositionBounds(): THREE.Box3 {
    this.scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(this.checkpoint);

    for (const entry of this.pillarEntries) {
      bounds.expandByObject(entry.mesh);
    }

    this.fireBatch.expandBounds(bounds);

    return bounds;
  }

  setMaterialScale(scale: number): void {
    this.materialScale = scale;
    this.stoneMaterialRuntime?.surface.setScale(scale);
    this.ironMaterialRuntime?.surface.setScale(scale);
    this.applyMaterialScale(this.checkpoint.geometry);

    for (const entry of this.pillarEntries) {
      this.applyMaterialScale(entry.mesh.geometry);
    }
  }

  setWireframe(enabled: boolean): void {
    this.wireframeVisible = enabled;
    this.checkpoint.visible = !enabled;
    this.checkpointWireframe.visible = enabled;
    this.fireBatch.setSceneVisible(!enabled);

    for (const entry of this.fireGlowEntries) {
      entry.light.visible = !enabled;
    }

    for (const entry of this.pillarEntries) {
      entry.mesh.visible = !enabled;
      entry.wireframe.visible = enabled;
    }
  }

  setVertexNormalsVisible(enabled: boolean): void {
    this.vertexNormalsVisible = enabled;
    this.rebuildVertexNormalsHelpers();
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
    this.applyAmbientOcclusion(this.checkpoint.geometry);
    this.applyBakedShadow(this.checkpoint.geometry);

    for (const entry of this.pillarEntries) {
      this.applyAmbientOcclusion(entry.mesh.geometry);
      this.applyBakedShadow(entry.mesh.geometry);
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
    this.stoneMaterialRuntime?.dispose();
    this.stoneMaterialRuntime = null;
    this.ironMaterialRuntime?.dispose();
    this.ironMaterialRuntime = null;
    this.disposePillars();
    this.disposeFireGlowLights();
    this.fireBatch.object.removeFromParent();
    this.fireBatch.dispose();
    this.fallbackStoneMaterial.dispose();
    this.fallbackIronMaterial.dispose();
    this.checkpoint.geometry.dispose();
    this.checkpointWireframe.geometry.dispose();
    this.checkpointWireframe.material.dispose();
    this.disposeVertexNormalsHelpers();
    this.sunShadow.dispose();
    this.sunLight.dispose();
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

  private useStoneRuntimeMaterial(runtime: MaterialGraphRuntime): void {
    const material = runtime.getNodeMaterial();
    material.vertexColors = true;
    material.needsUpdate = true;
    this.stoneSurfaceMaterial = material;
    this.checkpoint.material = material;
    this.refreshPillarMaterials();
  }

  private useIronRuntimeMaterial(runtime: MaterialGraphRuntime): void {
    const material = runtime.getNodeMaterial();
    material.vertexColors = true;
    material.needsUpdate = true;
    this.ironSurfaceMaterial = material;
    this.refreshPillarMaterials();
  }

  private refreshPillarMaterials(): void {
    for (const entry of this.pillarEntries) {
      entry.mesh.material = [this.stoneSurfaceMaterial, this.ironSurfaceMaterial];
    }
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
    runtime.surface.setTriplanar(false);
    runtime.surface.setScale(this.materialScale);

    await runtime.refresh();

    if (runtime.lastError) {
      runtime.dispose();
      throw new Error(`${label} material failed to compile: ${runtime.lastError}`);
    }

    return runtime;
  }

  private applyMaterialScale(geometry: THREE.BufferGeometry): void {
    const baseUvs = geometry.userData.baseUvs as Float32Array | undefined;
    const attribute = geometry.getAttribute("uv");

    if (!baseUvs || !(attribute instanceof THREE.BufferAttribute)) {
      return;
    }

    for (let index = 0; index < attribute.count; index += 1) {
      attribute.setXY(
        index,
        (baseUvs[index * 2] ?? 0) * this.materialScale,
        (baseUvs[index * 2 + 1] ?? 0) * this.materialScale,
      );
    }

    attribute.needsUpdate = true;
  }

  private rebuildVertexNormalsHelpers(): void {
    this.disposeVertexNormalsHelpers();

    if (!this.vertexNormalsVisible) {
      return;
    }

    const meshes = [
      this.checkpoint,
      ...this.pillarEntries.map((entry) => entry.mesh),
    ];

    for (const mesh of meshes) {
      const helper = new VertexNormalsHelper(mesh, this.vertexNormalsSize, 0x22d3ee);
      this.vertexNormalsHelpers.push(helper);
      this.scene.add(helper);
    }
  }

  private disposeVertexNormalsHelpers(): void {
    for (const helper of this.vertexNormalsHelpers) {
      helper.removeFromParent();
      helper.dispose();
    }

    this.vertexNormalsHelpers.length = 0;
  }

  private disposePillars(): void {
    this.disposeVertexNormalsHelpers();

    for (const entry of this.pillarEntries) {
      entry.mesh.removeFromParent();
      entry.mesh.geometry.dispose();
      entry.wireframe.removeFromParent();
      entry.wireframe.geometry.dispose();
      entry.wireframe.material.dispose();
    }

    this.pillarEntries.length = 0;
  }

  private rebuildFireGlowLights(
    pillarConfig: PillarGeometryConfig,
    fireConfig: FireConfig,
    placements: readonly PillarPlacement[],
  ): void {
    if (
      !pillarConfig.fireBowl.enabled
      || !fireConfig.enabled
      || !fireConfig.glowEnabled
    ) {
      this.disposeFireGlowLights();
      return;
    }

    const placementsByEntry = new Map<number, PillarPlacement[]>();

    for (const placement of placements) {
      const entryPlacements = placementsByEntry.get(placement.entryIndex) ?? [];
      entryPlacements.push(placement);
      placementsByEntry.set(placement.entryIndex, entryPlacements);
    }

    const groupedPlacements = [...placementsByEntry.entries()];

    while (this.fireGlowEntries.length > groupedPlacements.length) {
      const entry = this.fireGlowEntries.pop();
      entry?.light.removeFromParent();
      entry?.light.dispose();
    }

    while (this.fireGlowEntries.length < groupedPlacements.length) {
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

    for (let index = 0; index < groupedPlacements.length; index += 1) {
      const group = groupedPlacements[index];
      const glowEntry = this.fireGlowEntries[index];

      if (!group || !glowEntry) {
        continue;
      }

      const [entryIndex, entryPlacements] = group;
      const x = entryPlacements.reduce((sum, placement) => sum + placement.x, 0)
        / entryPlacements.length;
      const y = entryPlacements.reduce((sum, placement) => sum + placement.y, 0)
        / entryPlacements.length;
      const z = entryPlacements.reduce((sum, placement) => sum + placement.z, 0)
        / entryPlacements.length;
      const { light } = glowEntry;
      light.name = `Fire glow entry ${entryIndex + 1}`;
      light.color.setHex(FIRE_GLOW_COLOR);
      light.intensity = fireConfig.glowIntensity;
      light.distance = fireConfig.glowDistance;
      light.decay = 2;
      light.position.set(
        x,
        y
          + pillarConfig.height
          + fireConfig.baseHeight
          + fireConfig.height * fireConfig.scale * 0.35,
        z,
      );
      light.visible = !this.wireframeVisible;
      glowEntry.baseIntensity = fireConfig.glowIntensity;
      glowEntry.phase = entryIndex * 1.7;
      glowEntry.flicker = fireConfig.glowFlicker;
    }
  }

  private applyFireEffects(
    _checkpointConfig: CheckpointGeometryConfig,
    pillarConfig: PillarGeometryConfig,
    fireConfig: FireConfig,
    placements: readonly PillarPlacement[],
  ): Pick<
    PillarSetStats,
    | "flameCount"
    | "flameVertexCount"
    | "flameTriangleCount"
    | "flameDrawCallCount"
    | "glowLightCount"
  > {
    validateFireConfig(fireConfig);
    const flameStats = this.fireBatch.update({
      enabled: pillarConfig.fireBowl.enabled && fireConfig.enabled,
      scale: fireConfig.scale,
      radius: fireConfig.radius,
      height: fireConfig.height,
      baseHeight: fireConfig.baseHeight,
      speed: fireConfig.speed,
      noiseScale: fireConfig.noiseScale,
      turbulence: fireConfig.turbulence,
      intensity: fireConfig.intensity,
      pillarHeight: pillarConfig.height,
      radialSegments: fireConfig.radialSegments,
      placements,
    });
    this.fireBatch.setSceneVisible(!this.wireframeVisible);
    this.rebuildFireGlowLights(pillarConfig, fireConfig, placements);

    return {
      flameCount: flameStats.flameCount,
      flameVertexCount: flameStats.vertexCount,
      flameTriangleCount: flameStats.triangleCount,
      flameDrawCallCount: flameStats.drawCallCount,
      glowLightCount: this.fireGlowEntries.length,
    };
  }

  private disposeFireGlowLights(): void {
    for (const entry of this.fireGlowEntries) {
      entry.light.removeFromParent();
      entry.light.dispose();
    }

    this.fireGlowEntries.length = 0;
  }
}

function geometryStats(
  result: StoneGeometryResult,
): Omit<CheckpointGeometryResult, "geometry"> {
  return {
    stoneCount: result.stoneCount,
    vertexCount: result.vertexCount,
    triangleCount: result.triangleCount,
  };
}

function emptyPillarStats(): PillarSetStats {
  return {
    pillarCount: 0,
    stoneCount: 0,
    vertexCount: 0,
    triangleCount: 0,
    fireBowlVertexCount: 0,
    fireBowlTriangleCount: 0,
    flameCount: 0,
    flameVertexCount: 0,
    flameTriangleCount: 0,
    flameDrawCallCount: 0,
    glowLightCount: 0,
  };
}
