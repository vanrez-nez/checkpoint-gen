import * as THREE from "three";

/**
 * Splits long edges on a composed geometry so per-vertex shading has somewhere
 * to land.
 *
 * The stonework is already dense enough to carry a baked term at roughly a
 * sample per stone corner. The flat faces are not: a summit roof is two
 * triangles, and four samples cannot describe a shadow crossing it. This adds
 * vertices where — and only where — the geometry is too coarse to hold one.
 *
 * The split decision is a property of an *edge*, never of a triangle: an edge
 * longer than `maxEdge` is bisected, whoever it belongs to. Two triangles
 * sharing an edge therefore always agree about it, which is what keeps the
 * result free of T-junctions and the hairline shading seams they cause. That
 * is also why the triangle templates below enumerate one, two and three long
 * edges separately rather than always splitting four ways.
 *
 * This is a scene-layer concern, deliberately: the structure kernel's own
 * invariants are stated in stones and faces, and inflating its face count to
 * serve a lighting decision would make those invariants mean something else.
 */

/** Refinement passes before giving up. Children shrink by half, so this is generous. */
const MAX_PASSES = 6;

/** Per-vertex attributes carried through a split, with their item size. */
const INTERPOLATED_ATTRIBUTES: readonly (readonly [string, number])[] = [
  ["position", 3],
  ["normal", 3],
  ["uv", 2],
  ["vertexAo", 1],
  ["color", 3],
];

/** `userData` base arrays the scene re-derives sliders from, with their item size. */
const INTERPOLATED_BASES: readonly (readonly [string, number])[] = [
  ["baseUvs", 2],
  ["vertexAoBase", 1],
  ["bakedShadowBase", 1],
];

export interface SubdivisionResult {
  readonly geometry: THREE.BufferGeometry;
  /** Vertices added. Zero means the input was already fine enough to return as-is. */
  readonly addedVertices: number;
  readonly addedTriangles: number;
}

/**
 * Returns a geometry whose every edge is at most `maxEdge` long, subdividing
 * the input where it is not. The input is left untouched.
 *
 * A geometry that already satisfies the bound is returned unchanged rather than
 * copied, so the common case of dense stonework costs one measuring pass.
 */
export function subdivideLongEdges(
  source: THREE.BufferGeometry,
  maxEdge: number,
): SubdivisionResult {
  if (!(maxEdge > 0)) {
    throw new RangeError(`maxEdge must be positive; received ${maxEdge}.`);
  }

  const index = source.getIndex();

  if (!index) {
    throw new Error("Subdivision needs an indexed geometry.");
  }

  const attributes = INTERPOLATED_ATTRIBUTES.map(([name, itemSize]) => {
    const attribute = source.getAttribute(name);

    if (!attribute) {
      throw new Error(`Subdivision needs a "${name}" attribute.`);
    }
    if (attribute.itemSize !== itemSize) {
      throw new Error(
        `Attribute "${name}" has item size ${attribute.itemSize}; expected ${itemSize}.`,
      );
    }

    return { name, itemSize, values: Array.from(attribute.array as ArrayLike<number>) };
  });

  const bases = INTERPOLATED_BASES.map(([name, itemSize]) => {
    const values = source.userData[name] as ArrayLike<number> | undefined;

    if (!values) {
      throw new Error(`Subdivision needs userData.${name}.`);
    }

    return { name, itemSize, values: Array.from(values) };
  });

  const slotAttribute = source.getAttribute("surfaceMaterial");

  if (!slotAttribute) {
    throw new Error('Subdivision needs a "surfaceMaterial" attribute.');
  }

  const slots = Array.from(slotAttribute.array as ArrayLike<number>);
  const originalVertexCount = slots.length;
  const originalTriangleCount = index.count / 3;

  let triangles = Array.from(index.array as ArrayLike<number>);
  let split = false;

  const position = attributes.find((entry) => entry.name === "position")!;
  const maxEdgeSquared = maxEdge * maxEdge;

  /**
   * Midpoints are cached per undirected edge so both owners of a shared edge
   * land on the same new vertex. Without this the two sides drift apart by a
   * float and the crack shows as a lit seam.
   */
  const midpoints = new Map<number, number>();

  const midpointOf = (a: number, b: number): number => {
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    const key = low * originalVertexCountUpperBound(slots.length) + high;
    const cached = midpoints.get(key);

    if (cached !== undefined) {
      return cached;
    }

    const created = slots.length;

    for (const attribute of attributes) {
      for (let component = 0; component < attribute.itemSize; component += 1) {
        const first = attribute.values[a * attribute.itemSize + component] ?? 0;
        const second = attribute.values[b * attribute.itemSize + component] ?? 0;
        attribute.values.push((first + second) / 2);
      }
    }

    for (const base of bases) {
      for (let component = 0; component < base.itemSize; component += 1) {
        const first = base.values[a * base.itemSize + component] ?? 0;
        const second = base.values[b * base.itemSize + component] ?? 0;
        base.values.push((first + second) / 2);
      }
    }

    // A slot is a semantic identity, not a quantity: averaging "masonry" with
    // "rake" would name a surface that does not exist. Both endpoints of an
    // interior edge share one, and on a boundary either answer is defensible.
    slots.push(slots[a] ?? 0);
    midpoints.set(key, created);
    return created;
  };

  const isLong = (a: number, b: number): boolean => {
    const dx = position.values[a * 3]! - position.values[b * 3]!;
    const dy = position.values[a * 3 + 1]! - position.values[b * 3 + 1]!;
    const dz = position.values[a * 3 + 2]! - position.values[b * 3 + 2]!;
    return dx * dx + dy * dy + dz * dz > maxEdgeSquared;
  };

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const next: number[] = [];
    let refined = false;

    for (let triangle = 0; triangle < triangles.length; triangle += 3) {
      const a = triangles[triangle]!;
      const b = triangles[triangle + 1]!;
      const c = triangles[triangle + 2]!;

      const ab = isLong(a, b);
      const bc = isLong(b, c);
      const ca = isLong(c, a);
      const longCount = (ab ? 1 : 0) + (bc ? 1 : 0) + (ca ? 1 : 0);

      if (longCount === 0) {
        next.push(a, b, c);
        continue;
      }

      refined = true;
      split = true;

      if (longCount === 3) {
        const mab = midpointOf(a, b);
        const mbc = midpointOf(b, c);
        const mca = midpointOf(c, a);
        next.push(a, mab, mca, mab, b, mbc, mca, mbc, c, mab, mbc, mca);
        continue;
      }

      if (longCount === 1) {
        // Bisect the single long edge toward the opposite corner.
        if (ab) {
          const m = midpointOf(a, b);
          next.push(a, m, c, m, b, c);
        } else if (bc) {
          const m = midpointOf(b, c);
          next.push(b, m, a, m, c, a);
        } else {
          const m = midpointOf(c, a);
          next.push(c, m, b, m, a, b);
        }
        continue;
      }

      // Two long edges: cut both, then split the resulting quad along its
      // shorter diagonal so the pair does not degenerate into slivers.
      const rotate = (first: number, second: number, third: number): void => {
        const m1 = midpointOf(first, second);
        const m2 = midpointOf(second, third);
        next.push(second, m2, m1);

        if (isLong(m1, third) && !isLong(m2, first)) {
          next.push(m1, m2, first, m2, third, first);
        } else {
          next.push(m1, m2, third, m1, third, first);
        }
      };

      if (!ca) rotate(a, b, c);
      else if (!ab) rotate(b, c, a);
      else rotate(c, a, b);
    }

    triangles = next;

    if (!refined) {
      break;
    }
  }

  if (!split) {
    return { geometry: source, addedVertices: 0, addedTriangles: 0 };
  }

  const geometry = new THREE.BufferGeometry();

  for (const attribute of attributes) {
    geometry.setAttribute(
      attribute.name,
      new THREE.Float32BufferAttribute(new Float32Array(attribute.values), attribute.itemSize),
    );
  }

  geometry.setAttribute(
    "surfaceMaterial",
    new THREE.Uint8BufferAttribute(Uint8Array.from(slots), 1),
  );

  for (const base of bases) {
    geometry.userData[base.name] = new Float32Array(base.values);
  }

  // Normals were averaged component-wise on the way in, which shortens them
  // wherever an edge spans a crease. Renormalising keeps lighting comparable
  // to the unsubdivided face instead of dimming the new interior vertices.
  renormalise(geometry);

  geometry.setIndex(reorderBySlot(geometry, triangles, slots));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return {
    geometry,
    addedVertices: slots.length - originalVertexCount,
    addedTriangles: triangles.length / 3 - originalTriangleCount,
  };
}

/**
 * A stable multiplier for the edge cache key. Vertices are appended as edges
 * split, so the count grows during the walk; the key has to stay collision-free
 * against the final count, not the count at first use.
 */
function originalVertexCountUpperBound(current: number): number {
  return Math.max(1 << 22, current * 4);
}

function renormalise(geometry: THREE.BufferGeometry): void {
  const normal = geometry.getAttribute("normal") as THREE.BufferAttribute;

  for (let vertex = 0; vertex < normal.count; vertex += 1) {
    const x = normal.getX(vertex);
    const y = normal.getY(vertex);
    const z = normal.getZ(vertex);
    const length = Math.hypot(x, y, z);

    if (length > 1e-8) {
      normal.setXYZ(vertex, x / length, y / length, z / length);
    }
  }

  normal.needsUpdate = true;
}

/**
 * Rebuilds the one-draw-group-per-slot layout `mergeParts` established.
 *
 * Subdivision emits each triangle's children where the parent stood, so slot
 * runs survive in order — but a child count varies per parent, so the group
 * offsets do not. Grouping explicitly is cheaper than trusting that and being
 * wrong on a geometry whose draw calls silently double.
 */
function reorderBySlot(
  geometry: THREE.BufferGeometry,
  triangles: readonly number[],
  slots: readonly number[],
): THREE.BufferAttribute {
  const bySlot = new Map<number, number[]>();

  for (let triangle = 0; triangle < triangles.length; triangle += 3) {
    const slot = slots[triangles[triangle]!] ?? 0;
    const bucket = bySlot.get(slot);

    if (bucket) {
      bucket.push(triangles[triangle]!, triangles[triangle + 1]!, triangles[triangle + 2]!);
    } else {
      bySlot.set(slot, [triangles[triangle]!, triangles[triangle + 1]!, triangles[triangle + 2]!]);
    }
  }

  const ordered: number[] = [];
  geometry.clearGroups();

  for (const slot of [...bySlot.keys()].sort((left, right) => left - right)) {
    const bucket = bySlot.get(slot)!;
    geometry.addGroup(ordered.length, bucket.length, slot);

    // Appended one at a time rather than spread: a slot on a subdivided
    // structure holds hundreds of thousands of indices, and spreading that
    // many arguments overflows the call stack.
    for (const value of bucket) {
      ordered.push(value);
    }
  }

  const array = ordered.length > 65535
    ? new Uint32Array(ordered)
    : new Uint16Array(ordered);

  return new THREE.BufferAttribute(array, 1);
}
