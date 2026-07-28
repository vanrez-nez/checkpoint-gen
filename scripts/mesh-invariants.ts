import * as THREE from "three";
import {
  DEFAULT_FACE_SHADING,
  FLAT_FACE_SHADING,
} from "../src/geometry/shading";

/**
 * Properties a finished mass mesh has to hold, measured on the mesh rather than
 * on the maths behind it.
 *
 * These exist because three separate reworks of the surface layer each passed
 * every assertion in place at the time and still came out visibly wrong. What
 * the eye actually catches is z-fighting, holes and a surface that changes tone
 * where it should not — so those are what is measured here, on the buffer, with
 * no knowledge of what drew it.
 */

interface Triangle {
  readonly normal: readonly number[];
  readonly points: readonly (readonly number[])[];
  readonly min: readonly number[];
  readonly max: readonly number[];
}

function trianglesOf(geometry: THREE.BufferGeometry): Triangle[] {
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();

  if (!index) {
    throw new Error("Expected indexed geometry.");
  }

  const triangles: Triangle[] = [];

  for (let start = 0; start < index.count; start += 3) {
    const ids = [index.getX(start), index.getX(start + 1), index.getX(start + 2)];
    const points = ids.map((id) => [
      position.getX(id),
      position.getY(id),
      position.getZ(id),
    ]);
    const u = [0, 1, 2].map((axis) => points[1]![axis]! - points[0]![axis]!);
    const v = [0, 1, 2].map((axis) => points[2]![axis]! - points[0]![axis]!);
    const raw = [
      u[1]! * v[2]! - u[2]! * v[1]!,
      u[2]! * v[0]! - u[0]! * v[2]!,
      u[0]! * v[1]! - u[1]! * v[0]!,
    ];
    const length = Math.hypot(raw[0]!, raw[1]!, raw[2]!);

    if (length < 1e-12) {
      continue;
    }

    triangles.push({
      normal: raw.map((value) => value / length),
      points,
      min: [0, 1, 2].map((axis) => Math.min(...points.map((p) => p[axis]!))),
      max: [0, 1, 2].map((axis) => Math.max(...points.map((p) => p[axis]!))),
    });
  }

  return triangles;
}

/**
 * Whether two coplanar triangles share area rather than merely touching.
 *
 * Separating-axis, with a margin, because the two halves of every quad are
 * coplanar and share an edge: they separate exactly on that edge's normal, and
 * without the margin every quad in the mesh reports as fighting with itself.
 */
function sharesArea(a: Triangle, b: Triangle): boolean {
  const dominant = a.normal
    .map(Math.abs)
    .indexOf(Math.max(...a.normal.map(Math.abs)));
  const axes = [0, 1, 2].filter((axis) => axis !== dominant);
  const flatten = (triangle: Triangle) =>
    triangle.points.map((p) => [p[axes[0]!]!, p[axes[1]!]!]);
  const first = flatten(a);
  const second = flatten(b);
  const margin = 1e-4;

  for (const triangle of [first, second]) {
    for (let corner = 0; corner < 3; corner += 1) {
      const from = triangle[corner]!;
      const to = triangle[(corner + 1) % 3]!;
      const axis = [-(to[1]! - from[1]!), to[0]! - from[0]!];
      const length = Math.hypot(axis[0]!, axis[1]!);

      if (length < 1e-12) {
        continue;
      }

      const project = (polygon: number[][]) => {
        const values = polygon.map(
          (point) => (point[0]! * axis[0]! + point[1]! * axis[1]!) / length,
        );
        return { low: Math.min(...values), high: Math.max(...values) };
      };
      const one = project(first);
      const other = project(second);

      if (one.high - other.low <= margin || other.high - one.low <= margin) {
        return false;
      }
    }
  }

  return true;
}

export interface CoincidenceReport {
  readonly pairs: number;
  readonly sample: string | null;
  /** A few distinct planes at fault, which is what points at the cause. */
  readonly planes: readonly string[];
}

/**
 * Pairs of triangles on the same plane that overlap.
 *
 * This is the z-fighting, measured directly: two surfaces at the same depth have
 * no defined draw order, so which one you see changes with the camera and the
 * seam crawls. Nothing else in the suite could see it — every one of the
 * offenders was individually well-formed.
 */
export function findCoincidentFaces(
  geometry: THREE.BufferGeometry,
  /** How close two parallel faces have to be before they are the same depth. */
  tolerance = 1e-3,
): CoincidenceReport {
  const groups = new Map<string, { readonly triangle: Triangle; readonly depth: number }[]>();

  for (const triangle of trianglesOf(geometry)) {
    // Unsigned, so a face and one pointing the other way at the same depth still
    // count — those fight just as badly.
    const sign = triangle.normal.reduce((total, value) => total + value, 0) < 0 ? -1 : 1;
    const depth = [0, 1, 2].reduce(
      (total, axis) => total + triangle.normal[axis]! * triangle.points[0]![axis]!,
      0,
    ) * sign;
    // Grouped by direction only, then swept by depth. Quantising the depth into
    // buckets instead would let a pair straddling a bucket edge slip through,
    // which is exactly the kind of near-miss this is looking for.
    const key = triangle.normal
      .map((value) => (Math.round(value * sign * 1000) / 1000).toFixed(3))
      .join(",");
    groups.set(key, [...(groups.get(key) ?? []), { triangle, depth }]);
  }

  let pairs = 0;
  let sample: string | null = null;
  const planes = new Set<string>();

  for (const [key, group] of groups) {
    const sorted = [...group].sort((a, b) => a.depth - b.depth);

    for (let i = 0; i < sorted.length; i += 1) {
      const a = sorted[i]!;

      for (let j = i + 1; j < sorted.length; j += 1) {
        const b = sorted[j]!;

        if (b.depth - a.depth > tolerance) {
          break;
        }

        // Only the two axes the plane actually spans. Including the normal's own
        // axis would let two parallel faces a hundredth of a millimetre apart
        // separate on it, which is the pair that matters most.
        const dominant = a.triangle.normal
          .map(Math.abs)
          .indexOf(Math.max(...a.triangle.normal.map(Math.abs)));
        const near = [0, 1, 2]
          .filter((axis) => axis !== dominant)
          .every((axis) =>
            a.triangle.min[axis]! < b.triangle.max[axis]!
            && b.triangle.min[axis]! < a.triangle.max[axis]!);

        if (!near || !sharesArea(a.triangle, b.triangle)) {
          continue;
        }

        pairs += 1;
        sample ??= a.triangle.points[0]!.map((value) => value.toFixed(2)).join(", ");

        if (planes.size < 8) {
          planes.add(
            `normal ${key} at ${a.depth.toFixed(3)}, e.g. `
            + a.triangle.points[0]!.map((value) => value.toFixed(2)).join(","),
          );
        }
      }
    }
  }

  return { pairs, sample, planes: [...planes] };
}

export interface BackfaceReport {
  readonly shots: number;
  readonly backfaces: number;
  readonly sample: string | null;
}

/**
 * Rays fired at the mass from all round it, checking each meets a front face.
 *
 * A hole reads as a back face: you look through the gap and see the inside of
 * the far wall. Testing it this way rather than by demanding a closed manifold
 * is deliberate — blocks butt across joints and meet at T-junctions, so a mass
 * built of set stone is legitimately non-manifold, and asking for closure would
 * force a shape nobody wants. What matters is only that you cannot see in.
 */
export function findBackfaces(
  geometry: THREE.BufferGeometry,
  directions = 240,
): BackfaceReport {
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  const box = geometry.boundingBox ?? new THREE.Box3().setFromBufferAttribute(
    geometry.getAttribute("position") as THREE.BufferAttribute,
  );
  const centre = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length();
  const raycaster = new THREE.Raycaster();
  let shots = 0;
  let backfaces = 0;
  let sample: string | null = null;

  for (let step = 0; step < directions; step += 1) {
    // Fibonacci sphere, entirely above the horizon: a viewer stands on the
    // ground, and a building's underside is not a surface it presents.
    const y = 1 - (step / (directions - 1)) * 0.95;
    const ring = Math.sqrt(Math.max(1 - y * y, 0));
    const theta = Math.PI * (1 + Math.sqrt(5)) * step;
    const direction = new THREE.Vector3(
      Math.cos(theta) * ring,
      y,
      Math.sin(theta) * ring,
    ).normalize();
    const right = new THREE.Vector3(0, 1, 0).cross(direction).normalize();
    const up = direction.clone().cross(right).normalize();

    for (let across = -3; across <= 3; across += 1) {
      for (let down = -3; down <= 3; down += 1) {
        const origin = centre.clone()
          .addScaledVector(direction, radius)
          .addScaledVector(right, (across / 3) * radius * 0.45)
          .addScaledVector(up, (down / 3) * radius * 0.45);
        raycaster.set(origin, direction.clone().negate());
        const hit = raycaster.intersectObject(mesh, false)[0];

        if (!hit?.face) {
          continue;
        }

        shots += 1;

        if (hit.face.normal.dot(raycaster.ray.direction) > 0) {
          backfaces += 1;
          sample ??= hit.point.toArray().map((value) => value.toFixed(2)).join(", ");
        }
      }
    }
  }

  return { shots, backfaces, sample };
}

export interface ShadingReport {
  readonly worst: number;
  readonly sample: string | null;
}

/**
 * How far any block vertex's generated shading strays from the circular stone
 * contract.
 *
 * Block faces own four vertices in bottom, bottom, top, top order. Horizontal
 * tops are fully open; sides use the same bed-to-top AO and crack-shadow values
 * as `StoneGeometryBuilder`. Checking both arrays catches a Mass that still
 * looks different even though it reaches the same material slot.
 */
export function findStoneShadingBreaks(
  geometry: THREE.BufferGeometry,
): ShadingReport {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const ao = geometry.getAttribute("vertexAo");
  const shadow = geometry.userData.bakedShadowBase as Float32Array | undefined;
  let worst = 0;
  let sample: string | null = null;

  if (!shadow || shadow.length !== position.count || position.count % 4 !== 0) {
    return {
      worst: Number.POSITIVE_INFINITY,
      sample: "Geometry does not satisfy the four-vertex stone-face shading contract.",
    };
  }

  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const normalY = normal.getY(vertex);
    const corner = vertex % 4;
    const expected = normalY > 0.5
      ? {
        ao: FLAT_FACE_SHADING.topAo,
        shadow: FLAT_FACE_SHADING.topShadow,
      }
      : normalY < -0.5 || corner < 2
        ? {
          ao: DEFAULT_FACE_SHADING.bottomAo,
          shadow: DEFAULT_FACE_SHADING.bottomShadow,
        }
        : {
          ao: DEFAULT_FACE_SHADING.topAo,
          shadow: DEFAULT_FACE_SHADING.topShadow,
        };
    const aoDrift = Math.abs(ao.getX(vertex) - expected.ao);
    const shadowDrift = Math.abs((shadow[vertex] ?? 1) - expected.shadow);
    const drift = Math.max(aoDrift, shadowDrift);

    if (drift > worst) {
      worst = drift;
      sample = `face=${Math.floor(vertex / 4)} corner=${corner} `
        + `ao=${ao.getX(vertex).toFixed(3)}/${expected.ao.toFixed(3)} `
        + `shadow=${(shadow[vertex] ?? 1).toFixed(3)}/${expected.shadow.toFixed(3)}`;
    }
  }

  return { worst, sample };
}
