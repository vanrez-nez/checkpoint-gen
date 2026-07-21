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

const MATERIAL_OUTPUT_RESOLUTION = 512;
export const DEFAULT_MATERIAL_SCALE = 1;
const CSM_CASCADES = 3;
const CSM_MAX_FAR = 80;
const CSM_LIGHT_MARGIN = 20;
const SHADOW_MAP_SIZE = 1024;

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

export class MainScene {
  readonly scene = new THREE.Scene();
  private readonly fallbackMaterial: THREE.MeshStandardMaterial;
  private readonly checkpoint: THREE.Mesh;
  private readonly checkpointWireframe: THREE.LineSegments<
    THREE.WireframeGeometry,
    THREE.LineBasicMaterial
  >;
  private readonly sunLight: THREE.DirectionalLight;
  private readonly hemisphereLight: THREE.HemisphereLight;
  private readonly sunShadow: CSMShadowNode;
  private vertexNormalsHelper: VertexNormalsHelper | null = null;
  private vertexNormalsVisible = false;
  private vertexNormalsSize: number;
  private currentStats: Omit<CheckpointGeometryResult, "geometry">;
  private materialRuntime: MaterialGraphRuntime | null = null;
  private stopListeningForMaterialRebuild: (() => void) | null = null;
  private materialScale = DEFAULT_MATERIAL_SCALE;
  private ambientOcclusionStrength = DEFAULT_ILLUMINATION_CONFIG.ambientOcclusion;
  private crackShadowStrength = DEFAULT_ILLUMINATION_CONFIG.crackShadow;

  constructor(config: CheckpointGeometryConfig) {
    this.scene.background = new THREE.Color(0x171714);
    this.vertexNormalsSize = config.radius * 0.04;

    const result = createCheckpointGeometry(config);
    this.applyMaterialScale(result.geometry);
    this.fallbackMaterial = new THREE.MeshStandardMaterial({
      color: 0xa99b81,
      roughness: 0.92,
      metalness: 0,
      vertexColors: true,
    });
    this.checkpoint = new THREE.Mesh(result.geometry, this.fallbackMaterial);
    this.checkpoint.castShadow = true;
    this.checkpoint.receiveShadow = true;
    this.checkpointWireframe = new THREE.LineSegments(
      new THREE.WireframeGeometry(result.geometry),
      new THREE.LineBasicMaterial({ color: 0xd8d8d8 }),
    );
    this.checkpointWireframe.visible = false;
    this.currentStats = geometryStats(result);
    this.scene.add(this.checkpoint, this.checkpointWireframe);

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
    const response = await fetch(documentUrl);

    if (!response.ok) {
      throw new Error(`Failed to load stone material: ${response.status} ${response.statusText}`);
    }

    const sourceDocument = await response.json() as MaterialGraphDocument;
    const document = migrateMaterialDocument(sourceDocument);
    const outputNode = document.nodes.find((node) => node.type === "material-output");

    if (!outputNode) {
      throw new Error("Stone material document has no material output node.");
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
      throw new Error(`Stone material failed to compile: ${runtime.lastError}`);
    }

    this.stopListeningForMaterialRebuild?.();
    this.materialRuntime?.dispose();
    this.materialRuntime = runtime;
    this.useRuntimeMaterial(runtime);
    this.stopListeningForMaterialRebuild = runtime.surface.onRebuilt(() => {
      this.useRuntimeMaterial(runtime);
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
    this.rebuildVertexNormalsHelper();
    this.currentStats = geometryStats(result);
    previousGeometry.dispose();
    previousWireframeGeometry.dispose();

    return result;
  }

  getGeometryStats(): Omit<CheckpointGeometryResult, "geometry"> {
    return this.currentStats;
  }

  setMaterialScale(scale: number): void {
    this.materialScale = scale;
    this.materialRuntime?.surface.setScale(scale);
    this.applyMaterialScale(this.checkpoint.geometry);
  }

  setWireframe(enabled: boolean): void {
    this.checkpoint.visible = !enabled;
    this.checkpointWireframe.visible = enabled;
  }

  setVertexNormalsVisible(enabled: boolean): void {
    this.vertexNormalsVisible = enabled;
    this.rebuildVertexNormalsHelper();
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
  }

  update(_deltaTime: number): void {
    // Scene update hook. Keep object transforms static until scene logic needs motion.
  }

  updateShadowFrustums(): void {
    if (this.sunShadow.camera) {
      this.sunShadow.updateFrustums();
    }
  }

  dispose(): void {
    this.stopListeningForMaterialRebuild?.();
    this.stopListeningForMaterialRebuild = null;
    this.materialRuntime?.dispose();
    this.materialRuntime = null;
    this.fallbackMaterial.dispose();
    this.checkpoint.geometry.dispose();
    this.checkpointWireframe.geometry.dispose();
    this.checkpointWireframe.material.dispose();
    this.vertexNormalsHelper?.removeFromParent();
    this.vertexNormalsHelper?.dispose();
    this.vertexNormalsHelper = null;
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

  private useRuntimeMaterial(runtime: MaterialGraphRuntime): void {
    const material = runtime.getNodeMaterial();
    material.vertexColors = true;
    material.needsUpdate = true;
    this.checkpoint.material = material;
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

  private rebuildVertexNormalsHelper(): void {
    this.vertexNormalsHelper?.removeFromParent();
    this.vertexNormalsHelper?.dispose();
    this.vertexNormalsHelper = null;

    if (!this.vertexNormalsVisible) {
      return;
    }

    this.vertexNormalsHelper = new VertexNormalsHelper(
      this.checkpoint,
      this.vertexNormalsSize,
      0x22d3ee,
    );
    this.scene.add(this.vertexNormalsHelper);
  }
}

function geometryStats(
  result: CheckpointGeometryResult,
): Omit<CheckpointGeometryResult, "geometry"> {
  return {
    stoneCount: result.stoneCount,
    vertexCount: result.vertexCount,
    triangleCount: result.triangleCount,
  };
}
