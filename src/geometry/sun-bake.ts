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
  /**
   * Skip this target's vertices below this index, keeping what they carry.
   *
   * For the refinement pass, which is the only caller that can honestly use it.
   * Subdivision *appends*: a split writes its midpoint at `slots.length`, and
   * `reorderBySlot` permutes the index rather than the vertices, so every
   * vertex the first bake traced keeps both its position and its number. Their
   * visibility is not stale — it is exact — and re-tracing it spends a third of
   * the second bake re-deriving numbers that are already right. The vertices
   * at and above this index are the new midpoints, which carry an interpolated
   * value from the split and genuinely need tracing.
   *
   * So this is lossless rather than approximate: the result is identical to
   * tracing everything, and `scripts/bench.ts` asserts exactly that.
   *
   * Per target rather than per bake, because a bake covers several and only one
   * of them was subdivided — the structure. An offering is handed to the same
   * call unchanged, and skipping its vertices on the structure's say-so would
   * leave it lit by whatever it happened to hold.
   *
   * Requires the geometry to already carry a `sunVisibilityBase` at least this
   * long; without one the bake throws rather than going half dark.
   */
  readonly fromVertex?: number;
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

  /**
   * Lights geometry that was not part of this scene, through this scene's
   * occluders.
   *
   * For receivers that must be shaded by the structure without joining it as
   * casters — an engraved decal lying a few millimetres proud of the wall it
   * belongs to is the case this exists for. Adding one as an ordinary target
   * would put it in the hierarchy, and every ray leaving the stone beneath it
   * would strike it within a centimetre of travel: the wall would go black
   * under its own ornament.
   *
   * Also how a target already *in* the scene gets re-lit on its own — the
   * refinement pass hands back the structure with a `fromVertex`, to trace the
   * midpoints subdivision just added without re-tracing the offerings, whose
   * occluders did not move. Being in the hierarchy is not a problem for a
   * receiver: an ordinary `bake` traces every target through a hierarchy that
   * contains it, and `ORIGIN_OFFSET` is what keeps a vertex off its own surface.
   *
   * A sibling of `bake` rather than a parameter on it, because that method's
   * second argument is already its clock.
   */
  bakeTargets(
    targets: readonly SunBakeTarget[],
    options: SunBakeOptions,
    now: () => number = () => performance.now(),
  ): SunBakeReport {
    return traceSun(targets, this.bvh, this.reach, this.occluderCount, options, now);
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

    const from = Math.min(
      position.count,
      Math.max(0, Math.trunc(target.fromVertex ?? 0)),
    );
    const visibility = seedVisibility(target.geometry, position.count, from);
    const matrix = target.matrixWorld;

    if (matrix) {
      normalMatrix.getNormalMatrix(matrix);
    }

    for (let vertex = from; vertex < position.count; vertex += 1) {
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
    vertexTotal += position.count - from;
  }

  return {
    vertices: vertexTotal,
    occluders: occluderCount,
    rays: rayTotal,
    milliseconds: now() - started,
  };
}

/**
 * The array a trace writes into, carrying forward anything it will not retrace.
 *
 * A full bake gets a fresh array, because every entry is about to be written.
 * A partial one has to start from what the geometry already holds, and it has
 * to be a copy: the caller's array may be the one a previous pass handed out,
 * and a bake that mutated it in place would rewrite history for anyone still
 * reading the old geometry.
 */
function seedVisibility(
  geometry: THREE.BufferGeometry,
  count: number,
  from: number,
): Float32Array {
  if (from <= 0) {
    return new Float32Array(count);
  }

  const existing = geometry.userData.sunVisibilityBase as Float32Array | undefined;

  if (!existing || existing.length < from) {
    throw new Error(
      "A partial sun bake needs the visibility its earlier pass produced; "
      + `this geometry carries ${existing?.length ?? 0} of the ${from} required.`,
    );
  }

  const seeded = new Float32Array(count);
  seeded.set(existing.subarray(0, Math.min(from, existing.length)));
  return seeded;
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
