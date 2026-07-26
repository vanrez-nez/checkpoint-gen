import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { validateFireBowlConfig, type FireBowlConfig } from "./config";

export interface FireBowlGeometryResult {
  geometry: THREE.BufferGeometry;
  vertexCount: number;
  triangleCount: number;
  supportCount: number;
  footCount: number;
}

const SUPPORT_COUNT = 8;
const FOOT_COUNT = 4;

export function createFireBowlGeometry(
  config: FireBowlConfig,
  referenceWidth: number,
): FireBowlGeometryResult {
  validateFireBowlConfig(config, referenceWidth);

  const unit = referenceWidth * config.scale;
  const radialSegments = config.radialSegments;
  const bowlSegments = Math.max(8, Math.round(radialSegments / 4));
  const curveSegments = Math.max(6, Math.round(radialSegments / 4));
  const parts: THREE.BufferGeometry[] = [];

  parts.push(createBowlShell(unit, radialSegments, bowlSegments));

  const rim = new THREE.TorusGeometry(
    unit * 1.25,
    unit * 0.09,
    Math.max(6, Math.round(radialSegments / 4)),
    radialSegments,
  );
  rim.rotateX(Math.PI * 0.5);
  rim.translate(0, unit * 1.52, 0);
  parts.push(rim);

  const upperRing = createAnnularBand(
    unit * 1.49,
    unit * 1.65,
    unit * 0.18,
    radialSegments,
  );
  upperRing.translate(0, unit * 1.68, 0);
  parts.push(upperRing);

  const lowerRing = createAnnularBand(
    unit * 1.21,
    unit * 1.35,
    unit * 0.14,
    radialSegments,
  );
  lowerRing.translate(0, unit * 0.38, 0);
  parts.push(lowerRing);

  const support = createSupportStrap(unit, curveSegments);

  for (let index = 0; index < SUPPORT_COUNT; index += 1) {
    const copy = support.clone();
    copy.rotateY((index / SUPPORT_COUNT) * Math.PI * 2);
    parts.push(copy);
  }

  support.dispose();

  const foot = new THREE.BoxGeometry(unit * 0.38, unit * 0.16, unit * 0.7);
  foot.translate(0, unit * 0.08, unit * 0.9);

  for (let index = 0; index < FOOT_COUNT; index += 1) {
    const copy = foot.clone();
    copy.rotateY((index / FOOT_COUNT) * Math.PI * 2);
    parts.push(copy);
  }

  foot.dispose();

  for (const part of parts) {
    prepareIronPart(part);
  }

  const geometry = mergeGeometries(parts, false);

  for (const part of parts) {
    part.dispose();
  }

  if (!geometry) {
    throw new Error("Failed to merge fire bowl geometry.");
  }

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const position = geometry.getAttribute("position");
  const uv = geometry.getAttribute("uv");
  const vertexAo = geometry.getAttribute("vertexAo");
  geometry.userData.baseUvs = new Float32Array(uv.array as ArrayLike<number>);
  geometry.userData.vertexAoBase = new Float32Array(vertexAo.array as ArrayLike<number>);
  geometry.userData.bakedShadowBase = new Float32Array(position.count).fill(1);
  geometry.userData.supportCount = SUPPORT_COUNT;
  geometry.userData.footCount = FOOT_COUNT;

  return {
    geometry,
    vertexCount: position.count,
    triangleCount: (geometry.index?.count ?? 0) / 3,
    supportCount: SUPPORT_COUNT,
    footCount: FOOT_COUNT,
  };
}

function createBowlShell(
  unit: number,
  radialSegments: number,
  verticalSegments: number,
): THREE.BufferGeometry {
  const outerRadius = unit * 1.3;
  const thickness = unit * 0.08;
  const innerRadius = outerRadius - thickness;
  const rimY = unit * 1.52;
  const rowSize = radialSegments + 1;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (const radius of [outerRadius, innerRadius]) {
    for (let vertical = 0; vertical <= verticalSegments; vertical += 1) {
      const theta = (vertical / verticalSegments) * Math.PI * 0.5;
      const ringRadius = Math.sin(theta) * radius;
      const y = rimY - Math.cos(theta) * radius;

      for (let radial = 0; radial <= radialSegments; radial += 1) {
        const progress = radial / radialSegments;
        const angle = progress * Math.PI * 2;
        positions.push(
          Math.cos(angle) * ringRadius,
          y,
          Math.sin(angle) * ringRadius,
        );
        uvs.push(progress, vertical / verticalSegments);
      }
    }
  }

  const surfaceSize = rowSize * (verticalSegments + 1);

  for (let vertical = 0; vertical < verticalSegments; vertical += 1) {
    for (let radial = 0; radial < radialSegments; radial += 1) {
      const outerA = vertical * rowSize + radial;
      const outerB = outerA + rowSize;
      const outerC = outerB + 1;
      const outerD = outerA + 1;
      indices.push(outerA, outerB, outerC, outerA, outerC, outerD);

      const innerA = surfaceSize + outerA;
      const innerB = surfaceSize + outerB;
      const innerC = surfaceSize + outerC;
      const innerD = surfaceSize + outerD;
      indices.push(innerA, innerC, innerB, innerA, innerD, innerC);
    }
  }

  const outerRimStart = verticalSegments * rowSize;
  const innerRimStart = surfaceSize + outerRimStart;

  for (let radial = 0; radial < radialSegments; radial += 1) {
    const outerA = outerRimStart + radial;
    const outerB = outerA + 1;
    const innerA = innerRimStart + radial;
    const innerB = innerA + 1;
    indices.push(outerA, innerA, innerB, outerA, innerB, outerB);
  }

  return createIndexedGeometry(positions, uvs, indices);
}

function createAnnularBand(
  innerRadius: number,
  outerRadius: number,
  height: number,
  radialSegments: number,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const halfHeight = height * 0.5;

  for (let radial = 0; radial <= radialSegments; radial += 1) {
    const progress = radial / radialSegments;
    const angle = progress * Math.PI * 2;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    positions.push(
      cosine * outerRadius, -halfHeight, sine * outerRadius,
      cosine * outerRadius, halfHeight, sine * outerRadius,
      cosine * innerRadius, -halfHeight, sine * innerRadius,
      cosine * innerRadius, halfHeight, sine * innerRadius,
    );
    uvs.push(
      progress, 0,
      progress, 1,
      progress, 0,
      progress, 1,
    );
  }

  for (let radial = 0; radial < radialSegments; radial += 1) {
    const current = radial * 4;
    const next = current + 4;
    const outerBottom = current;
    const outerTop = current + 1;
    const innerBottom = current + 2;
    const innerTop = current + 3;
    const nextOuterBottom = next;
    const nextOuterTop = next + 1;
    const nextInnerBottom = next + 2;
    const nextInnerTop = next + 3;
    indices.push(
      outerBottom, outerTop, nextOuterTop,
      outerBottom, nextOuterTop, nextOuterBottom,
      innerBottom, nextInnerTop, innerTop,
      innerBottom, nextInnerBottom, nextInnerTop,
      outerTop, innerTop, nextInnerTop,
      outerTop, nextInnerTop, nextOuterTop,
      outerBottom, nextInnerBottom, innerBottom,
      outerBottom, nextOuterBottom, nextInnerBottom,
    );
  }

  return createIndexedGeometry(positions, uvs, indices);
}

function createSupportStrap(unit: number, curveSegments: number): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, unit * 0.14, unit * 1.22),
    new THREE.Vector3(0, unit * 0.55, unit * 1.25),
    new THREE.Vector3(0, unit * 1.1, unit * 1.42),
    new THREE.Vector3(0, unit * 1.68, unit * 1.57),
    new THREE.Vector3(0, unit * 2.05, unit * 1.68),
  ], false, "centripetal");
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const thickness = unit * 0.08;

  for (let segment = 0; segment <= curveSegments; segment += 1) {
    const progress = segment / curveSegments;
    const point = curve.getPoint(progress);
    const tangent = curve.getTangent(progress).normalize();
    const thicknessNormal = new THREE.Vector3(0, -tangent.z, tangent.y).normalize();
    const width = THREE.MathUtils.lerp(
      unit * 0.18,
      unit * 0.12,
      THREE.MathUtils.smoothstep(progress, 0.72, 1),
    );

    for (const [side, face] of [[-1, 1], [1, 1], [1, -1], [-1, -1]] as const) {
      positions.push(
        point.x + side * width * 0.5,
        point.y + thicknessNormal.y * face * thickness * 0.5,
        point.z + thicknessNormal.z * face * thickness * 0.5,
      );
      uvs.push(side < 0 ? 0 : 1, progress);
    }
  }

  for (let segment = 0; segment < curveSegments; segment += 1) {
    const current = segment * 4;
    const next = current + 4;

    for (let side = 0; side < 4; side += 1) {
      const sideNext = (side + 1) % 4;
      indices.push(
        current + side,
        next + side,
        next + sideNext,
        current + side,
        next + sideNext,
        current + sideNext,
      );
    }
  }

  const end = curveSegments * 4;
  indices.push(0, 2, 1, 0, 3, 2);
  indices.push(end, end + 1, end + 2, end, end + 2, end + 3);

  return createIndexedGeometry(positions, uvs, indices);
}

function createIndexedGeometry(
  positions: number[],
  uvs: number[],
  indices: number[],
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function prepareIronPart(geometry: THREE.BufferGeometry): void {
  if (!geometry.getAttribute("normal")) {
    geometry.computeVertexNormals();
  }

  const vertexCount = geometry.getAttribute("position").count;
  geometry.setAttribute(
    "color",
    new THREE.Float32BufferAttribute(new Float32Array(vertexCount * 3).fill(1), 3),
  );
  geometry.setAttribute(
    "vertexAo",
    new THREE.Float32BufferAttribute(new Float32Array(vertexCount).fill(1), 1),
  );
}

