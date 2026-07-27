import * as THREE from "three";

/**
 * A point on the ground plane. Every builder here works from horizontal
 * polygons extruded or lofted through Y, so this is the vertex type footprints,
 * courses, stone outlines and patch boundaries are all expressed in.
 */
export type Point2 = { x: number; z: number };

/**
 * The vertex-buffer contract every geometry builder in this project shares.
 *
 * `merge-parts` and `MainScene` both assume a part carries `position`, an index,
 * `normal`, `uv`, `vertexAo` and `color`, plus the three `userData` base arrays
 * the AO, baked-shadow and material-scale sliders re-derive from without
 * regenerating anything. Building that set by hand in each builder is how the
 * arrays drift apart, so builders only accumulate the four raw arrays below and
 * hand them here.
 */
export interface GeometryBuffers {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
  /** One per vertex. 1 is fully open, 0 fully occluded. */
  readonly ambientOcclusion: readonly number[];
  /** One per vertex. Crack/contact shadow, sampled independently of AO. */
  readonly bakedShadow: readonly number[];
}

export interface FinalizedGeometry {
  geometry: THREE.BufferGeometry;
  vertexCount: number;
  triangleCount: number;
}

/**
 * Turns accumulated buffers into a render-ready geometry.
 *
 * The `userData` arrays are the originals; the matching attributes are copies,
 * so a consumer can rescale `uv` or reweight `vertexAo` in place and still
 * recover the generated values on the next pass.
 */
export function finalizeGeometry(buffers: GeometryBuffers): FinalizedGeometry {
  const geometry = new THREE.BufferGeometry();
  const ambientOcclusion = new Float32Array(buffers.ambientOcclusion);
  const bakedShadow = new Float32Array(buffers.bakedShadow);
  const vertexColors = new Float32Array(bakedShadow.length * 3).fill(1);
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(buffers.positions as number[], 3),
  );
  geometry.setAttribute(
    "vertexAo",
    new THREE.Float32BufferAttribute(ambientOcclusion.slice(), 1),
  );
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(vertexColors, 3));
  geometry.userData.vertexAoBase = ambientOcclusion;
  geometry.userData.bakedShadowBase = bakedShadow;
  geometry.setIndex(buffers.indices as number[]);
  geometry.computeVertexNormals();
  const baseUvs = createBoxProjectedUvs(geometry);
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(baseUvs.slice(), 2));
  geometry.userData.baseUvs = baseUvs;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return {
    geometry,
    vertexCount: buffers.positions.length / 3,
    triangleCount: buffers.indices.length / 3,
  };
}

/**
 * Hard box projection: each vertex takes its UV from whichever world axis its
 * normal points most strongly along. Tops, sides and bevels therefore sample the
 * baked maps at a consistent world scale without triplanar blending, at the cost
 * of a visible seam wherever a face turns past 45 degrees.
 */
export function createBoxProjectedUvs(geometry: THREE.BufferGeometry): Float32Array {
  const positions = geometry.getAttribute("position");
  const normals = geometry.getAttribute("normal");
  const uvs = new Float32Array(positions.count * 2);

  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const normalX = normals.getX(index);
    const normalY = normals.getY(index);
    const normalZ = normals.getZ(index);
    const absoluteX = Math.abs(normalX);
    const absoluteY = Math.abs(normalY);
    const absoluteZ = Math.abs(normalZ);
    let u: number;
    let v: number;

    if (absoluteY >= absoluteX && absoluteY >= absoluteZ) {
      u = x;
      v = z;
    } else if (absoluteX >= absoluteZ) {
      u = normalX < 0 ? z : -z;
      v = y;
    } else {
      u = normalZ < 0 ? -x : x;
      v = y;
    }

    uvs[index * 2] = u;
    uvs[index * 2 + 1] = v;
  }

  return uvs;
}
