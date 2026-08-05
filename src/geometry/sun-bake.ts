import * as THREE from "three";
import { TriangleBvh } from "./bvh";

/**
 * Bakes directional sun visibility into a per-vertex channel.
 *
 * This exists because the realtime path cannot be made to behave here.
 * `WebGPURenderer` represents shadow maps as depth textures rather than
 * rendering `MeshDepthMaterial`, which is an acknowledged upstream source of
 * far heavier acne than the WebGL path shows for identical settings, and the
 * cascaded node on top of it scales its constant bias per cascade but not its
 * normal bias. Between them, the bias a raking sun needs on a flat face is
 * large enough to detach contact shadows everywhere else. A structure that
 * does not move does not need any of that decided per frame.
 *
 * The result is one float per vertex — 1 lit, 0 fully occluded — left in
 * `userData.sunVisibilityBase` for the scene to weight and composite. Nothing
 * here touches a live attribute: the base array is the generated truth, and a
 * strength slider must stay able to re-derive from it without a re-bake.
 */

/** Lifted off the surface before casting, so a vertex cannot shadow itself. */
const ORIGIN_OFFSET = 1e-3;

/** Golden angle, for spreading soft-shadow samples without clumping. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export interface SunBakeTarget {
  readonly geometry: THREE.BufferGeometry;
  /** Local-to-world, applied to both occluders and sample origins. */
  readonly matrixWorld?: THREE.Matrix4;
}

export interface SunBakeOptions {
  /** Direction *toward* the sun. Need not be normalised. */
  readonly direction: THREE.Vector3;
  /**
   * Half-angle of the sun's disc, in radians. Zero bakes hard shadows; a few
   * degrees softens contact edges the way a real sun does. The sample count
   * rises with this, so it is the main cost dial.
   */
  readonly softness?: number;
  /** Rays per vertex when `softness` is non-zero. Ignored otherwise. */
  readonly samples?: number;
}

export interface SunBakeReport {
  readonly vertices: number;
  readonly occluders: number;
  readonly rays: number;
  readonly milliseconds: number;
}

/**
 * Casts every vertex of every target at the sun, through the union of all
 * targets as occluders, and writes the result to each geometry's
 * `userData.sunVisibilityBase`.
 *
 * Targets occlude each other: an offering bowl standing on the structure is
 * both a receiver and a caster, and baking them in separate passes would light
 * each one through the other.
 */
/**
 * The sun-independent half of a bake, kept so the sun can move without paying
 * for it again.
 *
 * Flattening the triangles and building the hierarchy over them costs roughly
 * as much as the tracing does, and neither depends on where the sun is. Only
 * the ray directions do. Holding this across sun changes is the difference
 * between an azimuth slider that stutters and one that does not.
 */
export class SunBakeScene {
  private constructor(
    private readonly targets: readonly SunBakeTarget[],
    private readonly bvh: TriangleBvh,
    private readonly reach: number,
    private readonly occluderCount: number,
  ) {}

  /** Flattens every target to world space and builds the occlusion hierarchy. */
  static from(targets: readonly SunBakeTarget[]): SunBakeScene {
    const occluders = collectTriangles(targets);

    return new SunBakeScene(
      targets,
      TriangleBvh.build(occluders),
      spanOf(occluders) * 2 + 1,
      occluders.length / 9,
    );
  }

  bake(
    options: SunBakeOptions,
    now: () => number = () => performance.now(),
  ): SunBakeReport {
    return traceSun(this.targets, this.bvh, this.reach, this.occluderCount, options, now);
  }
}

/**
 * Bakes in one shot, building the hierarchy and discarding it.
 *
 * Convenient for a single bake; use {@link SunBakeScene} when the same geometry
 * will be re-lit, which is every case where the sun is a live control.
 */
export function bakeSunVisibility(
  targets: readonly SunBakeTarget[],
  options: SunBakeOptions,
  now: () => number = () => performance.now(),
): SunBakeReport {
  return SunBakeScene.from(targets).bake(options, now);
}

function traceSun(
  targets: readonly SunBakeTarget[],
  bvh: TriangleBvh,
  reach: number,
  occluderCount: number,
  options: SunBakeOptions,
  now: () => number,
): SunBakeReport {
  const started = now();
  const direction = options.direction.clone();

  if (direction.lengthSq() < 1e-12) {
    throw new RangeError("Sun direction must be non-zero.");
  }

  direction.normalize();

  const directions = sampleDirections(direction, options.softness ?? 0, options.samples ?? 1);

  let vertexTotal = 0;
  let rayTotal = 0;

  const worldPosition = new THREE.Vector3();
  const worldNormal = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();

  for (const target of targets) {
    const position = target.geometry.getAttribute("position");
    const normal = target.geometry.getAttribute("normal");

    if (!position || !normal) {
      throw new Error("Sun baking needs position and normal attributes.");
    }

    const visibility = new Float32Array(position.count);
    const matrix = target.matrixWorld;

    if (matrix) {
      normalMatrix.getNormalMatrix(matrix);
    }

    for (let vertex = 0; vertex < position.count; vertex += 1) {
      worldPosition.fromBufferAttribute(position as THREE.BufferAttribute, vertex);
      worldNormal.fromBufferAttribute(normal as THREE.BufferAttribute, vertex);

      if (matrix) {
        worldPosition.applyMatrix4(matrix);
        worldNormal.applyMatrix3(normalMatrix);
      }

      worldNormal.normalize();

      // A surface turned away from the sun is already dark by its own
      // orientation. Tracing it would spend the majority of the ray budget
      // re-deriving a fact the normal already states.
      if (worldNormal.dot(direction) <= 0) {
        visibility[vertex] = 0;
        continue;
      }

      const originX = worldPosition.x + worldNormal.x * ORIGIN_OFFSET;
      const originY = worldPosition.y + worldNormal.y * ORIGIN_OFFSET;
      const originZ = worldPosition.z + worldNormal.z * ORIGIN_OFFSET;

      let clear = 0;

      for (const ray of directions) {
        rayTotal += 1;

        if (!bvh.occludes(originX, originY, originZ, ray.x, ray.y, ray.z, reach)) {
          clear += 1;
        }
      }

      visibility[vertex] = clear / directions.length;
    }

    target.geometry.userData.sunVisibilityBase = visibility;
    vertexTotal += position.count;
  }

  return {
    vertices: vertexTotal,
    occluders: occluderCount,
    rays: rayTotal,
    milliseconds: now() - started,
  };
}

/** Flattens every target's indexed triangles into world-space corner triples. */
function collectTriangles(targets: readonly SunBakeTarget[]): Float32Array {
  let total = 0;

  for (const target of targets) {
    const index = target.geometry.getIndex();

    if (!index) {
      throw new Error("Sun baking needs indexed geometry.");
    }

    total += index.count / 3;
  }

  const triangles = new Float32Array(total * 9);
  const corner = new THREE.Vector3();
  let cursor = 0;

  for (const target of targets) {
    const index = target.geometry.getIndex()!;
    const position = target.geometry.getAttribute("position") as THREE.BufferAttribute;
    const matrix = target.matrixWorld;

    for (let slot = 0; slot < index.count; slot += 1) {
      corner.fromBufferAttribute(position, index.getX(slot));

      if (matrix) {
        corner.applyMatrix4(matrix);
      }

      triangles[cursor] = corner.x;
      triangles[cursor + 1] = corner.y;
      triangles[cursor + 2] = corner.z;
      cursor += 3;
    }
  }

  return triangles;
}

/** Longest axis of the occluder set, used to bound ray length. */
function spanOf(triangles: Float32Array): number {
  if (triangles.length === 0) {
    return 1;
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (let cursor = 0; cursor < triangles.length; cursor += 3) {
    const x = triangles[cursor]!;
    const y = triangles[cursor + 1]!;
    const z = triangles[cursor + 2]!;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  return Math.max(maxX - minX, maxY - minY, maxZ - minZ);
}

/**
 * Builds the cone of directions standing in for the sun's disc.
 *
 * Deterministic by construction — a golden-angle spiral rather than jitter —
 * because a bake that changes when nothing changed reads as flicker the moment
 * any other control triggers a rebuild.
 */
function sampleDirections(
  centre: THREE.Vector3,
  softness: number,
  samples: number,
): readonly THREE.Vector3[] {
  const count = Math.max(1, Math.floor(samples));

  if (softness <= 0 || count === 1) {
    return [centre.clone()];
  }

  // Any vector not parallel to the centre gives a usable tangent frame.
  const helper = Math.abs(centre.y) < 0.9
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(1, 0, 0);
  const tangent = new THREE.Vector3().crossVectors(helper, centre).normalize();
  const bitangent = new THREE.Vector3().crossVectors(centre, tangent).normalize();
  const directions: THREE.Vector3[] = [];

  for (let sample = 0; sample < count; sample += 1) {
    // sqrt keeps the samples area-uniform on the disc rather than crowding
    // the centre, which would make the penumbra narrower than the angle asks.
    const radius = Math.sqrt((sample + 0.5) / count) * Math.tan(softness);
    const angle = sample * GOLDEN_ANGLE;

    directions.push(
      centre
        .clone()
        .addScaledVector(tangent, Math.cos(angle) * radius)
        .addScaledVector(bitangent, Math.sin(angle) * radius)
        .normalize(),
    );
  }

  return directions;
}
