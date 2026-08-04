import * as THREE from "three";
import { MATERIAL_SLOTS, materialSlotIndex, type MaterialSlot } from "./part";

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
  /** One semantic material-slot index per vertex. */
  readonly surfaceMaterials?: readonly number[];
  /**
   * Two authored UVs per vertex, or NaN where the emitter had nothing to say.
   *
   * Box projection cannot be continuous around a corner: it reads a world axis,
   * and which axis it reads changes. A hard arris hides that seam; a bevel
   * replaces the arris with facets and puts the seam on surfaces you can see.
   * An emitter that knows the real distance along its own surface says so here,
   * and every vertex it leaves alone still falls through to the projection.
   */
  readonly uvs?: readonly number[];
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
 *
 * `fallbackSlot` names the semantic surface a builder that assigns no per-vertex
 * materials belongs to as a whole — a pillar is masonry, but it is the *pillar*
 * surface, so it takes its own material and texture scale rather than the shell's.
 */
export function finalizeGeometry(
  buffers: GeometryBuffers,
  fallbackSlot: MaterialSlot = "stone",
): FinalizedGeometry {
  const vertexCount = buffers.positions.length / 3;

  if (!Number.isInteger(vertexCount)) {
    throw new Error("Position buffer length must be divisible by three.");
  }
  if (buffers.ambientOcclusion.length !== vertexCount) {
    throw new Error(
      `Ambient-occlusion buffer has ${buffers.ambientOcclusion.length} entries; expected ${vertexCount}.`,
    );
  }
  if (buffers.bakedShadow.length !== vertexCount) {
    throw new Error(
      `Baked-shadow buffer has ${buffers.bakedShadow.length} entries; expected ${vertexCount}.`,
    );
  }
  if (
    buffers.surfaceMaterials
    && buffers.surfaceMaterials.length !== vertexCount
  ) {
    throw new Error(
      `Surface-material buffer has ${buffers.surfaceMaterials.length} entries; expected ${vertexCount}.`,
    );
  }

  const geometry = new THREE.BufferGeometry();
  const ambientOcclusion = new Float32Array(buffers.ambientOcclusion);
  const bakedShadow = new Float32Array(buffers.bakedShadow);
  const surfaceMaterials = Uint8Array.from(
    buffers.surfaceMaterials
      ?? new Array(vertexCount).fill(materialSlotIndex(fallbackSlot)),
    (value) => {
      if (
        !Number.isInteger(value)
        || value < 0
        || value >= MATERIAL_SLOTS.length
      ) {
        throw new RangeError(
          `Surface material ${value} must identify a registered material slot.`,
        );
      }

      return value;
    },
  );
  const vertexColors = new Float32Array(bakedShadow.length * 3).fill(1);
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(buffers.positions as number[], 3),
  );
  geometry.setAttribute(
    "vertexAo",
    new THREE.Float32BufferAttribute(ambientOcclusion.slice(), 1),
  );
  geometry.setAttribute(
    "surfaceMaterial",
    new THREE.Uint8BufferAttribute(surfaceMaterials, 1),
  );
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(vertexColors, 3));
  geometry.userData.vertexAoBase = ambientOcclusion;
  geometry.userData.bakedShadowBase = bakedShadow;
  geometry.setIndex(buffers.indices as number[]);
  geometry.computeVertexNormals();
  const baseUvs = createBoxProjectedUvs(geometry);
  const authored = buffers.uvs;
  if (authored) {
    for (let index = 0; index < baseUvs.length; index += 1) {
      const value = authored[index];
      if (value !== undefined && Number.isFinite(value)) {
        baseUvs[index] = value;
      }
    }
  }
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(baseUvs.slice(), 2));
  geometry.userData.baseUvs = baseUvs;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return {
    geometry,
    vertexCount,
    triangleCount: buffers.indices.length / 3,
  };
}

/**
 * Hard box projection: each vertex takes its UV from whichever world axis its
 * normal points most strongly along. Tops, sides and bevels therefore sample the
 * baked maps at a consistent world scale without triplanar blending, at the cost
 * of a visible seam wherever a face turns past 45 degrees.
 *
 * Projecting a face that does not face its axis squarely foreshortens it: a
 * bevel facet turned 45 degrees between two axes covers only 71% of the axis it
 * projects onto, so its texture is stretched across it by the reciprocal. The
 * horizontal span is divided back out by that cosine, which restores the world
 * scale on every angled face and is exactly 1 — and so changes nothing — on a
 * face that already squares up to its axis, including a battered one.
 */
/** Keeps a face that is edge-on to its own axis from scaling to infinity. */
const FORESHORTEN_FLOOR = 0.2;

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

    // How much of the normal lies in the horizontal plane. A wall leaning back
    // is not foreshortened along its length, only up its face, so the cosine
    // that matters here is measured within that plane rather than against the
    // axis outright.
    const horizontal = Math.hypot(normalX, normalZ);

    if (absoluteY >= absoluteX && absoluteY >= absoluteZ) {
      u = x;
      v = z;
    } else if (absoluteX >= absoluteZ) {
      u = (normalX < 0 ? z : -z) * (horizontal / Math.max(absoluteX, FORESHORTEN_FLOOR));
      v = y;
    } else {
      u = (normalZ < 0 ? -x : x) * (horizontal / Math.max(absoluteZ, FORESHORTEN_FLOOR));
      v = y;
    }

    uvs[index * 2] = u;
    uvs[index * 2 + 1] = v;
  }

  return uvs;
}
