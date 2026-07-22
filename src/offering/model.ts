import * as THREE from "three";
import { createBoxProjectedUvs } from "../geometry/stone-builder";
import { computeVertexAo } from "./ambient-occlusion";

export interface OfferingConfig {
  enabled: boolean;
  pedestalFit: number;
  verticalOffset: number;
  rotationDegrees: number;
  materialScale: number;
}

export const DEFAULT_OFFERING_CONFIG: Readonly<OfferingConfig> = {
  enabled: true,
  pedestalFit: 1.105,
  verticalOffset: 0,
  rotationDegrees: 0,
  materialScale: 6,
};

export interface OfferingAttachment {
  centerTopY: number;
  centerDiameter: number;
}

export interface OfferingTransform {
  scale: number;
  position: THREE.Vector3;
  rotationY: number;
}

const SUPPORT_SAMPLE_HEIGHT_RATIO = 0.12;

export function prepareOfferingGeometry(geometry: THREE.BufferGeometry): void {
  if (!geometry.getAttribute("normal")) {
    geometry.computeVertexNormals();
  }

  const vertexCount = geometry.getAttribute("position").count;
  // Bake real self-occlusion so folds/creases darken like the stone geometry,
  // whose AO is baked per-vertex by its builder.
  const vertexAo = computeVertexAo(geometry);
  const bakedShadow = new Float32Array(vertexCount).fill(1);
  const vertexColors = new Float32Array(vertexCount * 3).fill(1);
  // Prefer the model's authored UVs (a real atlas unwrap) when present; fall back
  // to a per-vertex box projection for UV-less meshes, which inevitably seams.
  const existingUv = geometry.getAttribute("uv");
  const baseUvs = existingUv
    ? Float32Array.from(existingUv.array as ArrayLike<number>)
    : createBoxProjectedUvs(geometry);

  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(baseUvs.slice(), 2));
  geometry.setAttribute("vertexAo", new THREE.Float32BufferAttribute(vertexAo.slice(), 1));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(vertexColors, 3));
  geometry.userData.baseUvs = baseUvs;
  geometry.userData.vertexAoBase = vertexAo;
  geometry.userData.bakedShadowBase = bakedShadow;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}

export function calculateOfferingTransform(
  sourceBounds: THREE.Box3,
  attachment: OfferingAttachment,
  config: OfferingConfig = DEFAULT_OFFERING_CONFIG,
  supportCenter = sourceBounds.getCenter(new THREE.Vector3()),
): OfferingTransform {
  validateOfferingConfig(config);
  const sourceSize = sourceBounds.getSize(new THREE.Vector3());
  const horizontalSize = Math.max(sourceSize.x, sourceSize.z);

  if (!Number.isFinite(horizontalSize) || horizontalSize <= Number.EPSILON) {
    throw new RangeError("Offering model must have a non-zero horizontal size.");
  }

  const scale = attachment.centerDiameter * config.pedestalFit / horizontalSize;
  const rotationY = THREE.MathUtils.degToRad(config.rotationDegrees);
  const rotatedCenter = new THREE.Vector3(
    supportCenter.x * scale,
    0,
    supportCenter.z * scale,
  ).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotationY);

  return {
    scale,
    position: new THREE.Vector3(
      -rotatedCenter.x,
      attachment.centerTopY - sourceBounds.min.y * scale + config.verticalOffset,
      -rotatedCenter.z,
    ),
    rotationY,
  };
}

export function calculateOfferingSupportCenter(
  object: THREE.Object3D,
  sourceBounds: THREE.Box3,
): THREE.Vector3 {
  const sourceSize = sourceBounds.getSize(new THREE.Vector3());
  const sampleMaximumY = sourceBounds.min.y
    + sourceSize.y * SUPPORT_SAMPLE_HEIGHT_RATIO;
  const point = new THREE.Vector3();
  let minimumX = Number.POSITIVE_INFINITY;
  let maximumX = Number.NEGATIVE_INFINITY;
  let minimumZ = Number.POSITIVE_INFINITY;
  let maximumZ = Number.NEGATIVE_INFINITY;

  object.updateMatrixWorld(true);
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }

    const position = child.geometry.getAttribute("position");

    for (let index = 0; index < position.count; index += 1) {
      point.fromBufferAttribute(position, index).applyMatrix4(child.matrixWorld);

      if (point.y > sampleMaximumY) {
        continue;
      }

      minimumX = Math.min(minimumX, point.x);
      maximumX = Math.max(maximumX, point.x);
      minimumZ = Math.min(minimumZ, point.z);
      maximumZ = Math.max(maximumZ, point.z);
    }
  });

  if (![minimumX, maximumX, minimumZ, maximumZ].every(Number.isFinite)) {
    return sourceBounds.getCenter(new THREE.Vector3());
  }

  return new THREE.Vector3(
    (minimumX + maximumX) * 0.5,
    sourceBounds.min.y,
    (minimumZ + maximumZ) * 0.5,
  );
}

export function validateOfferingConfig(config: OfferingConfig): void {
  if (typeof config.enabled !== "boolean") {
    throw new TypeError("Offering enabled must be a boolean.");
  }

  assertRange(config.pedestalFit, 0.1, 1.5, "Offering pedestal fit");
  assertRange(config.verticalOffset, -1, 1, "Offering vertical offset");
  assertRange(config.rotationDegrees, -180, 180, "Offering rotation");
  assertRange(config.materialScale, 0.1, 8, "Offering material scale");
}

function assertRange(value: number, min: number, max: number, label: string): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${label} must be between ${min} and ${max}.`);
  }
}
