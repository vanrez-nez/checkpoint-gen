import * as THREE from "three";

export interface AoBakeOptions {
  /** Rays cast per vertex over the cosine-weighted hemisphere. */
  rayCount: number;
  /** Occlusion search radius, as a fraction of the bounding-box diagonal. */
  maxDistanceRatio: number;
  /** AO value for a fully occluded vertex (matches the stone floor of 0.28). */
  minAo: number;
}

export const DEFAULT_AO_BAKE_OPTIONS: Readonly<AoBakeOptions> = {
  rayCount: 24,
  maxDistanceRatio: 0.16,
  minAo: 0.3,
};

const GOLDEN_FRACTION = 0.618033988749895;

/**
 * Bakes per-vertex ambient occlusion by casting hemisphere rays against the
 * mesh's own triangles. Returns a Float32Array (one value per vertex) in
 * [minAo, 1], where 1 is fully open and minAo is fully occluded. A uniform
 * spatial grid plus 3D DDA traversal keeps the any-hit queries local, so cost
 * scales with the occlusion radius rather than the triangle count.
 */
export function computeVertexAo(
  geometry: THREE.BufferGeometry,
  options: Partial<AoBakeOptions> = {},
): Float32Array {
  const { rayCount, maxDistanceRatio, minAo } = {
    ...DEFAULT_AO_BAKE_OPTIONS,
    ...options,
  };

  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const vertexCount = position.count;
  const ao = new Float32Array(vertexCount).fill(1);

  if (!normal || vertexCount === 0) {
    return ao;
  }

  const positions = position.array as ArrayLike<number>;
  const index = geometry.getIndex();
  const triangleCount = (index ? index.count : vertexCount) / 3;

  if (triangleCount < 1) {
    return ao;
  }

  const box = new THREE.Box3().setFromBufferAttribute(
    position as THREE.BufferAttribute,
  );
  const size = box.getSize(new THREE.Vector3());
  const diagonal = size.length();

  if (!Number.isFinite(diagonal) || diagonal <= Number.EPSILON) {
    return ao;
  }

  const maxDistance = diagonal * maxDistanceRatio;
  const originBias = diagonal * 1e-3;
  const hitEpsilon = diagonal * 1e-4;

  const readTriangle = makeTriangleReader(positions, index);
  const grid = buildTriangleGrid(box, size, triangleCount, readTriangle);
  const localDirections = cosineHemisphereDirections(rayCount);

  const tangent = new THREE.Vector3();
  const bitangent = new THREE.Vector3();
  const worldNormal = new THREE.Vector3();
  const origin = new THREE.Vector3();
  const direction = new THREE.Vector3();

  // The atlas unwrap duplicates vertices along UV seams; those share an exact
  // position (and normal), so AO is computed once per unique position and
  // scattered to its duplicates.
  const computed = new Map<string, number>();

  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const px = position.getX(vertex);
    const py = position.getY(vertex);
    const pz = position.getZ(vertex);
    const key = `${px},${py},${pz}`;
    const cached = computed.get(key);

    if (cached !== undefined) {
      ao[vertex] = cached;
      continue;
    }

    worldNormal.set(
      normal.getX(vertex),
      normal.getY(vertex),
      normal.getZ(vertex),
    );

    if (worldNormal.lengthSq() < 1e-12) {
      computed.set(key, 1);
      continue;
    }

    worldNormal.normalize();
    buildBasis(worldNormal, tangent, bitangent);

    origin.set(px, py, pz).addScaledVector(worldNormal, originBias);

    let occluded = 0;

    for (let ray = 0; ray < rayCount; ray += 1) {
      const lx = localDirections[ray * 3];
      const ly = localDirections[ray * 3 + 1];
      const lz = localDirections[ray * 3 + 2];

      direction.set(
        tangent.x * lx + bitangent.x * ly + worldNormal.x * lz,
        tangent.y * lx + bitangent.y * ly + worldNormal.y * lz,
        tangent.z * lx + bitangent.z * ly + worldNormal.z * lz,
      );

      if (grid.intersectsAny(origin, direction, maxDistance, hitEpsilon, readTriangle)) {
        occluded += 1;
      }
    }

    // Cosine-weighted sampling makes the occluded fraction the AO term directly.
    const openness = 1 - occluded / rayCount;
    const value = minAo + (1 - minAo) * openness;
    ao[vertex] = value;
    computed.set(key, value);
  }

  return ao;
}

type TriangleReader = (
  triangle: number,
  out: Float32Array,
) => void;

function makeTriangleReader(
  positions: ArrayLike<number>,
  index: THREE.BufferAttribute | null,
): TriangleReader {
  if (index) {
    const indices = index.array as ArrayLike<number>;
    return (triangle, out) => {
      const base = triangle * 3;
      for (let corner = 0; corner < 3; corner += 1) {
        const vertex = indices[base + corner] * 3;
        out[corner * 3] = positions[vertex];
        out[corner * 3 + 1] = positions[vertex + 1];
        out[corner * 3 + 2] = positions[vertex + 2];
      }
    };
  }

  return (triangle, out) => {
    const base = triangle * 9;
    for (let component = 0; component < 9; component += 1) {
      out[component] = positions[base + component];
    }
  };
}

interface TriangleGrid {
  intersectsAny(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance: number,
    epsilon: number,
    readTriangle: TriangleReader,
  ): boolean;
}

function buildTriangleGrid(
  box: THREE.Box3,
  size: THREE.Vector3,
  triangleCount: number,
  readTriangle: TriangleReader,
): TriangleGrid {
  const resolution = THREE.MathUtils.clamp(
    Math.round(Math.cbrt(triangleCount)),
    16,
    64,
  );
  const min = box.min.clone();
  // Guard flat axes so the cell size never collapses to zero.
  const cell = new THREE.Vector3(
    Math.max(size.x, Number.EPSILON) / resolution,
    Math.max(size.y, Number.EPSILON) / resolution,
    Math.max(size.z, Number.EPSILON) / resolution,
  );

  const cells: number[][] = new Array(resolution ** 3);
  const corners = new Float32Array(9);

  const cellIndex = (ix: number, iy: number, iz: number): number =>
    ix + iy * resolution + iz * resolution * resolution;
  const axisCell = (value: number, axisMin: number, axisSize: number): number =>
    THREE.MathUtils.clamp(
      Math.floor((value - axisMin) / axisSize),
      0,
      resolution - 1,
    );

  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    readTriangle(triangle, corners);

    const minX = Math.min(corners[0], corners[3], corners[6]);
    const maxX = Math.max(corners[0], corners[3], corners[6]);
    const minY = Math.min(corners[1], corners[4], corners[7]);
    const maxY = Math.max(corners[1], corners[4], corners[7]);
    const minZ = Math.min(corners[2], corners[5], corners[8]);
    const maxZ = Math.max(corners[2], corners[5], corners[8]);

    const ix0 = axisCell(minX, min.x, cell.x);
    const ix1 = axisCell(maxX, min.x, cell.x);
    const iy0 = axisCell(minY, min.y, cell.y);
    const iy1 = axisCell(maxY, min.y, cell.y);
    const iz0 = axisCell(minZ, min.z, cell.z);
    const iz1 = axisCell(maxZ, min.z, cell.z);

    for (let iz = iz0; iz <= iz1; iz += 1) {
      for (let iy = iy0; iy <= iy1; iy += 1) {
        for (let ix = ix0; ix <= ix1; ix += 1) {
          const key = cellIndex(ix, iy, iz);
          (cells[key] ??= []).push(triangle);
        }
      }
    }
  }

  return {
    intersectsAny(origin, direction, maxDistance, epsilon, reader) {
      return traverseGrid(
        origin,
        direction,
        maxDistance,
        epsilon,
        resolution,
        min,
        cell,
        cells,
        cellIndex,
        axisCell,
        reader,
      );
    },
  };
}

/** Amanatides & Woo voxel traversal with per-cell any-hit triangle tests. */
function traverseGrid(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  maxDistance: number,
  epsilon: number,
  resolution: number,
  min: THREE.Vector3,
  cell: THREE.Vector3,
  cells: number[][],
  cellIndex: (ix: number, iy: number, iz: number) => number,
  axisCell: (value: number, axisMin: number, axisSize: number) => number,
  readTriangle: TriangleReader,
): boolean {
  let ix = axisCell(origin.x, min.x, cell.x);
  let iy = axisCell(origin.y, min.y, cell.y);
  let iz = axisCell(origin.z, min.z, cell.z);

  const stepX = direction.x > 0 ? 1 : -1;
  const stepY = direction.y > 0 ? 1 : -1;
  const stepZ = direction.z > 0 ? 1 : -1;

  const tDeltaX = direction.x !== 0 ? Math.abs(cell.x / direction.x) : Infinity;
  const tDeltaY = direction.y !== 0 ? Math.abs(cell.y / direction.y) : Infinity;
  const tDeltaZ = direction.z !== 0 ? Math.abs(cell.z / direction.z) : Infinity;

  let tMaxX = nextBoundary(origin.x, min.x, cell.x, ix, stepX, direction.x);
  let tMaxY = nextBoundary(origin.y, min.y, cell.y, iy, stepY, direction.y);
  let tMaxZ = nextBoundary(origin.z, min.z, cell.z, iz, stepZ, direction.z);

  const corners = new Float32Array(9);

  for (;;) {
    const bucket = cells[cellIndex(ix, iy, iz)];

    if (bucket) {
      for (let entry = 0; entry < bucket.length; entry += 1) {
        readTriangle(bucket[entry], corners);
        const t = rayTriangle(origin, direction, corners, epsilon, maxDistance);

        if (t >= 0) {
          return true;
        }
      }
    }

    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      if (tMaxX > maxDistance) return false;
      ix += stepX;
      if (ix < 0 || ix >= resolution) return false;
      tMaxX += tDeltaX;
    } else if (tMaxY < tMaxZ) {
      if (tMaxY > maxDistance) return false;
      iy += stepY;
      if (iy < 0 || iy >= resolution) return false;
      tMaxY += tDeltaY;
    } else {
      if (tMaxZ > maxDistance) return false;
      iz += stepZ;
      if (iz < 0 || iz >= resolution) return false;
      tMaxZ += tDeltaZ;
    }
  }
}

function nextBoundary(
  originAxis: number,
  minAxis: number,
  cellAxis: number,
  cellCoord: number,
  step: number,
  directionAxis: number,
): number {
  if (directionAxis === 0) {
    return Infinity;
  }

  const boundaryCoord = step > 0 ? cellCoord + 1 : cellCoord;
  const boundary = minAxis + boundaryCoord * cellAxis;
  return (boundary - originAxis) / directionAxis;
}

/** Möller–Trumbore, double-sided, returns hit distance in (epsilon, maxDistance) or -1. */
function rayTriangle(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  corners: Float32Array,
  epsilon: number,
  maxDistance: number,
): number {
  const e1x = corners[3] - corners[0];
  const e1y = corners[4] - corners[1];
  const e1z = corners[5] - corners[2];
  const e2x = corners[6] - corners[0];
  const e2y = corners[7] - corners[1];
  const e2z = corners[8] - corners[2];

  const px = direction.y * e2z - direction.z * e2y;
  const py = direction.z * e2x - direction.x * e2z;
  const pz = direction.x * e2y - direction.y * e2x;

  const determinant = e1x * px + e1y * py + e1z * pz;

  if (determinant > -1e-12 && determinant < 1e-12) {
    return -1;
  }

  const inverse = 1 / determinant;
  const tx = origin.x - corners[0];
  const ty = origin.y - corners[1];
  const tz = origin.z - corners[2];

  const u = (tx * px + ty * py + tz * pz) * inverse;

  if (u < 0 || u > 1) {
    return -1;
  }

  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;

  const v = (direction.x * qx + direction.y * qy + direction.z * qz) * inverse;

  if (v < 0 || u + v > 1) {
    return -1;
  }

  const t = (e2x * qx + e2y * qy + e2z * qz) * inverse;

  return t > epsilon && t < maxDistance ? t : -1;
}

/** Cosine-weighted hemisphere directions (z = surface normal), Fibonacci-spaced. */
function cosineHemisphereDirections(rayCount: number): Float32Array {
  const directions = new Float32Array(rayCount * 3);

  for (let ray = 0; ray < rayCount; ray += 1) {
    const u = (ray + 0.5) / rayCount;
    const phi = 2 * Math.PI * ((ray * GOLDEN_FRACTION) % 1);
    const radius = Math.sqrt(u);

    directions[ray * 3] = radius * Math.cos(phi);
    directions[ray * 3 + 1] = radius * Math.sin(phi);
    directions[ray * 3 + 2] = Math.sqrt(Math.max(0, 1 - u));
  }

  return directions;
}

function buildBasis(
  normal: THREE.Vector3,
  tangent: THREE.Vector3,
  bitangent: THREE.Vector3,
): void {
  // Choose a reference axis least aligned with the normal to avoid degeneracy.
  if (Math.abs(normal.x) <= Math.abs(normal.y) && Math.abs(normal.x) <= Math.abs(normal.z)) {
    tangent.set(0, -normal.z, normal.y);
  } else if (Math.abs(normal.y) <= Math.abs(normal.z)) {
    tangent.set(-normal.z, 0, normal.x);
  } else {
    tangent.set(-normal.y, normal.x, 0);
  }

  tangent.normalize();
  bitangent.copy(normal).cross(tangent);
}
