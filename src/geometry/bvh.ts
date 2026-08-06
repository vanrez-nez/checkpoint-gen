/**
 * Bounded-volume hierarchies over triangles.
 *
 * Two of them, because there are two questions and they want opposite things
 * from a traversal. `TriangleBvh` answers "does anything stand between this
 * point and the sun?" and may stop at the first blocker it meets, which is most
 * of its speed. `SurfaceBvh` answers "which surface is directly behind this
 * point, and where on it?" and cannot stop early, because the nearest hit is the
 * answer rather than any hit.
 *
 * They share a builder and nothing else. Keeping them apart is what stops the
 * occlusion query from growing a hit record that callers would start depending
 * on — the ordering it deliberately does not maintain.
 */

/** Triangles per leaf. Small enough to prune, large enough to amortise a node. */
const LEAF_SIZE = 8;

/** Rays that start exactly on a surface must not be stopped by it. */
const SURFACE_EPSILON = 1e-4;

/**
 * The node arrays, plus the permutation that put the triangles in leaf order.
 *
 * `order` is what a caller needs to get from "leaf slot 137" back to "the
 * hundred and thirty-seventh triangle you handed me". The occlusion hierarchy
 * discards it; a hierarchy that reports what it hit cannot.
 */
interface BvhNodes {
  readonly bounds: Float32Array;
  readonly rightChild: Int32Array;
  readonly triangleStart: Int32Array;
  readonly triangleCount: Int32Array;
  readonly order: Uint32Array;
}

/**
 * Builds the hierarchy over `triangles`, nine floats per triangle: three
 * world-space corners, already transformed out of any local frame.
 */
function buildNodes(triangles: Float32Array, count: number): BvhNodes {
  // Centroids drive the split; the bounds that get stored are the real
  // triangle extents, so a sliver whose centroid sits far from its bulk
  // still occludes everything it actually covers.
  const centroids = new Float32Array(count * 3);

  for (let triangle = 0; triangle < count; triangle += 1) {
    const base = triangle * 9;
    centroids[triangle * 3] = (triangles[base]! + triangles[base + 3]! + triangles[base + 6]!) / 3;
    centroids[triangle * 3 + 1] = (triangles[base + 1]! + triangles[base + 4]! + triangles[base + 7]!) / 3;
    centroids[triangle * 3 + 2] = (triangles[base + 2]! + triangles[base + 5]! + triangles[base + 8]!) / 3;
  }

  const order = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) order[index] = index;

  // A binary tree over `count` leaves of at least LEAF_SIZE cannot exceed
  // this many nodes, so every array is sized once and never grown.
  const maxNodes = Math.max(1, 2 * Math.ceil(count / LEAF_SIZE) * 2 + 1);
  const bounds = new Float32Array(maxNodes * 6);
  const rightChild = new Int32Array(maxNodes).fill(-1);
  const triangleStart = new Int32Array(maxNodes);
  const triangleCount = new Int32Array(maxNodes);

  let nodeTotal = 0;

  const enclose = (node: number, start: number, end: number): void => {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (let slot = start; slot < end; slot += 1) {
      const base = order[slot]! * 9;

      for (let corner = 0; corner < 3; corner += 1) {
        const x = triangles[base + corner * 3]!;
        const y = triangles[base + corner * 3 + 1]!;
        const z = triangles[base + corner * 3 + 2]!;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
    }

    bounds[node * 6] = minX;
    bounds[node * 6 + 1] = minY;
    bounds[node * 6 + 2] = minZ;
    bounds[node * 6 + 3] = maxX;
    bounds[node * 6 + 4] = maxY;
    bounds[node * 6 + 5] = maxZ;
  };

  const build = (start: number, end: number): number => {
    const node = nodeTotal;
    nodeTotal += 1;
    enclose(node, start, end);

    const span = end - start;

    if (span <= LEAF_SIZE) {
      rightChild[node] = -1;
      triangleStart[node] = start;
      triangleCount[node] = span;
      return node;
    }

    // Split on the widest axis of the centroid spread. Degenerate spreads
    // (every centroid coincident) fall through to a median split, which
    // still terminates because it always moves at least one triangle.
    const minAxis = [Infinity, Infinity, Infinity];
    const maxAxis = [-Infinity, -Infinity, -Infinity];

    for (let slot = start; slot < end; slot += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = centroids[order[slot]! * 3 + axis]!;
        if (value < minAxis[axis]!) minAxis[axis] = value;
        if (value > maxAxis[axis]!) maxAxis[axis] = value;
      }
    }

    let axis = 0;
    let widest = maxAxis[0]! - minAxis[0]!;

    for (let candidate = 1; candidate < 3; candidate += 1) {
      const extent = maxAxis[candidate]! - minAxis[candidate]!;
      if (extent > widest) {
        widest = extent;
        axis = candidate;
      }
    }

    const middle = (start + end) >> 1;
    partitionByMedian(order, centroids, start, end, middle, axis);

    build(start, middle);
    rightChild[node] = build(middle, end);
    triangleCount[node] = 0;
    return node;
  };

  build(0, count);
  return { bounds, rightChild, triangleStart, triangleCount, order };
}

/** Corners copied into leaf order, so a leaf sweep walks memory forward. */
function permuteCorners(
  triangles: Float32Array,
  order: Uint32Array,
): Float32Array {
  const corners = new Float32Array(order.length * 9);

  for (let slot = 0; slot < order.length; slot += 1) {
    corners.set(triangles.subarray(order[slot]! * 9, order[slot]! * 9 + 9), slot * 9);
  }

  return corners;
}

export class TriangleBvh {
  /** Six floats per node: min xyz then max xyz. */
  private readonly bounds: Float32Array;
  /** Interior nodes point at their right child; leaves store `-1`. */
  private readonly rightChild: Int32Array;
  /** First triangle and count, meaningful on leaves only. */
  private readonly triangleStart: Int32Array;
  private readonly triangleCount: Int32Array;
  /** Nine floats per triangle: the three corners, world space, in leaf order. */
  private readonly corners: Float32Array;
  /**
   * Traversal scratch, reused across queries. Sized for a tree far deeper than
   * a median split over any plausible triangle count can produce; each level
   * pushes at most two entries.
   */
  private readonly stack = new Int32Array(128);

  private constructor(
    bounds: Float32Array,
    rightChild: Int32Array,
    triangleStart: Int32Array,
    triangleCount: Int32Array,
    corners: Float32Array,
  ) {
    this.bounds = bounds;
    this.rightChild = rightChild;
    this.triangleStart = triangleStart;
    this.triangleCount = triangleCount;
    this.corners = corners;
  }

  /**
   * Builds a hierarchy over `triangles`, given as nine floats per triangle:
   * three world-space corners, already transformed out of any local frame.
   */
  static build(triangles: Float32Array): TriangleBvh {
    const count = Math.floor(triangles.length / 9);

    if (count === 0) {
      return new TriangleBvh(
        new Float32Array(6),
        Int32Array.from([-1]),
        Int32Array.from([0]),
        Int32Array.from([0]),
        new Float32Array(0),
      );
    }

    const nodes = buildNodes(triangles, count);
    // The permutation is dropped here on purpose: this hierarchy reports only
    // whether something was hit, so nothing may map a hit back to a triangle.
    return new TriangleBvh(
      nodes.bounds,
      nodes.rightChild,
      nodes.triangleStart,
      nodes.triangleCount,
      permuteCorners(triangles, nodes.order),
    );
  }

  /**
   * True when any triangle blocks the segment from the origin along
   * `direction` (which must be normalised) up to `maxDistance`.
   */
  occludes(
    originX: number,
    originY: number,
    originZ: number,
    directionX: number,
    directionY: number,
    directionZ: number,
    maxDistance: number,
  ): boolean {
    if (this.corners.length === 0) {
      return false;
    }

    const inverseX = 1 / directionX;
    const inverseY = 1 / directionY;
    const inverseZ = 1 / directionZ;

    // The stack is owned by the hierarchy, not the query. A bake casts one ray
    // per vertex, and allocating a fresh array for each of several hundred
    // thousand of them costs more than the traversal it serves.
    const stack = this.stack;
    stack[0] = 0;
    let depth = 1;

    while (depth > 0) {
      depth -= 1;
      const node = stack[depth]!;

      if (!intersectsBox(
        this.bounds,
        node,
        originX,
        originY,
        originZ,
        inverseX,
        inverseY,
        inverseZ,
        maxDistance,
      )) {
        continue;
      }

      const right = this.rightChild[node]!;

      if (right < 0) {
        const start = this.triangleStart[node]!;
        const end = start + this.triangleCount[node]!;

        for (let slot = start; slot < end; slot += 1) {
          if (this.hits(slot, originX, originY, originZ, directionX, directionY, directionZ, maxDistance)) {
            return true;
          }
        }

        continue;
      }

      stack[depth] = right;
      stack[depth + 1] = node + 1;
      depth += 2;
    }

    return false;
  }

  /** Möller–Trumbore, any-hit and single-sided disabled: a wall occludes from both faces. */
  private hits(
    slot: number,
    originX: number,
    originY: number,
    originZ: number,
    directionX: number,
    directionY: number,
    directionZ: number,
    maxDistance: number,
  ): boolean {
    const base = slot * 9;
    const ax = this.corners[base]!;
    const ay = this.corners[base + 1]!;
    const az = this.corners[base + 2]!;
    const edge1x = this.corners[base + 3]! - ax;
    const edge1y = this.corners[base + 4]! - ay;
    const edge1z = this.corners[base + 5]! - az;
    const edge2x = this.corners[base + 6]! - ax;
    const edge2y = this.corners[base + 7]! - ay;
    const edge2z = this.corners[base + 8]! - az;

    const pvecX = directionY * edge2z - directionZ * edge2y;
    const pvecY = directionZ * edge2x - directionX * edge2z;
    const pvecZ = directionX * edge2y - directionY * edge2x;
    const determinant = edge1x * pvecX + edge1y * pvecY + edge1z * pvecZ;

    if (Math.abs(determinant) < 1e-12) {
      return false;
    }

    const inverse = 1 / determinant;
    const tvecX = originX - ax;
    const tvecY = originY - ay;
    const tvecZ = originZ - az;
    const u = (tvecX * pvecX + tvecY * pvecY + tvecZ * pvecZ) * inverse;

    if (u < 0 || u > 1) {
      return false;
    }

    const qvecX = tvecY * edge1z - tvecZ * edge1y;
    const qvecY = tvecZ * edge1x - tvecX * edge1z;
    const qvecZ = tvecX * edge1y - tvecY * edge1x;
    const v = (directionX * qvecX + directionY * qvecY + directionZ * qvecZ) * inverse;

    if (v < 0 || u + v > 1) {
      return false;
    }

    const distance = (edge2x * qvecX + edge2y * qvecY + edge2z * qvecZ) * inverse;
    return distance > SURFACE_EPSILON && distance < maxDistance;
  }
}

/** Where a segment met a surface, and which triangle it was. */
export interface SurfaceHit {
  /** Index into the triangle list the hierarchy was built from. */
  readonly triangle: number;
  readonly distance: number;
  /** Barycentric weights of the second and third corners. */
  readonly u: number;
  readonly v: number;
}

/**
 * A hierarchy that reports what it hit.
 *
 * The sibling of `TriangleBvh`, for the opposite question: not "is anything in
 * the way" but "what is directly behind this point, and where on it". A decal
 * lies a few millimetres proud of a wall and has to read that wall's baked
 * shading rather than assume it — so it needs the triangle, and the weights to
 * interpolate the wall's per-vertex values across it.
 *
 * It keeps the build permutation as `triangleIndex`, which is the whole
 * difference between the two classes: without it a hit is a distance and
 * nothing more, and there is no route back to the three vertices whose values
 * were the point of asking.
 *
 * It also cannot stop at the first hit. Where a face has been sunk into its
 * member, the ray crosses the pocket's own return before reaching the floor,
 * and an any-hit traversal would sample the return.
 */
export class SurfaceBvh {
  private readonly bounds: Float32Array;
  private readonly rightChild: Int32Array;
  private readonly triangleStart: Int32Array;
  private readonly triangleCount: Int32Array;
  private readonly corners: Float32Array;
  /** Leaf slot to the caller's own triangle numbering. */
  private readonly triangleIndex: Uint32Array;
  private readonly stack = new Int32Array(128);
  /** Scratch for the nearest hit, so a leaf sweep allocates nothing. */
  private hitU = 0;
  private hitV = 0;

  private constructor(nodes: BvhNodes, corners: Float32Array) {
    this.bounds = nodes.bounds;
    this.rightChild = nodes.rightChild;
    this.triangleStart = nodes.triangleStart;
    this.triangleCount = nodes.triangleCount;
    this.corners = corners;
    this.triangleIndex = nodes.order;
  }

  static build(triangles: Float32Array): SurfaceBvh {
    const count = Math.floor(triangles.length / 9);

    if (count === 0) {
      return new SurfaceBvh(
        {
          bounds: new Float32Array(6),
          rightChild: Int32Array.from([-1]),
          triangleStart: Int32Array.from([0]),
          triangleCount: Int32Array.from([0]),
          order: new Uint32Array(0),
        },
        new Float32Array(0),
      );
    }

    const nodes = buildNodes(triangles, count);
    return new SurfaceBvh(nodes, permuteCorners(triangles, nodes.order));
  }

  /**
   * The nearest triangle along the segment, or null if it meets nothing.
   *
   * `direction` must be normalised. The search bound shrinks as closer hits are
   * found, which prunes the rest of the tree — the one optimisation an any-hit
   * traversal cannot make and a nearest-hit one gets for free.
   */
  nearest(
    originX: number,
    originY: number,
    originZ: number,
    directionX: number,
    directionY: number,
    directionZ: number,
    maxDistance: number,
  ): SurfaceHit | null {
    if (this.corners.length === 0) {
      return null;
    }

    const inverseX = 1 / directionX;
    const inverseY = 1 / directionY;
    const inverseZ = 1 / directionZ;
    const stack = this.stack;
    stack[0] = 0;
    let depth = 1;
    let bestDistance = maxDistance;
    let bestSlot = -1;
    let bestU = 0;
    let bestV = 0;

    while (depth > 0) {
      depth -= 1;
      const node = stack[depth]!;

      if (!intersectsBox(
        this.bounds,
        node,
        originX,
        originY,
        originZ,
        inverseX,
        inverseY,
        inverseZ,
        bestDistance,
      )) {
        continue;
      }

      const right = this.rightChild[node]!;

      if (right < 0) {
        const start = this.triangleStart[node]!;
        const end = start + this.triangleCount[node]!;

        for (let slot = start; slot < end; slot += 1) {
          const distance = this.intersect(
            slot,
            originX,
            originY,
            originZ,
            directionX,
            directionY,
            directionZ,
            bestDistance,
          );

          if (distance >= 0) {
            bestDistance = distance;
            bestSlot = slot;
            bestU = this.hitU;
            bestV = this.hitV;
          }
        }

        continue;
      }

      stack[depth] = right;
      stack[depth + 1] = node + 1;
      depth += 2;
    }

    return bestSlot < 0
      ? null
      : {
        triangle: this.triangleIndex[bestSlot]!,
        distance: bestDistance,
        u: bestU,
        v: bestV,
      };
  }

  /**
   * Möller–Trumbore returning the distance, or -1. Double sided for the same
   * reason the occlusion test is: a wall is a wall from either face, and a
   * decal on an inward-facing surface must still find the stone behind it.
   */
  private intersect(
    slot: number,
    originX: number,
    originY: number,
    originZ: number,
    directionX: number,
    directionY: number,
    directionZ: number,
    maxDistance: number,
  ): number {
    const base = slot * 9;
    const ax = this.corners[base]!;
    const ay = this.corners[base + 1]!;
    const az = this.corners[base + 2]!;
    const edge1x = this.corners[base + 3]! - ax;
    const edge1y = this.corners[base + 4]! - ay;
    const edge1z = this.corners[base + 5]! - az;
    const edge2x = this.corners[base + 6]! - ax;
    const edge2y = this.corners[base + 7]! - ay;
    const edge2z = this.corners[base + 8]! - az;

    const pvecX = directionY * edge2z - directionZ * edge2y;
    const pvecY = directionZ * edge2x - directionX * edge2z;
    const pvecZ = directionX * edge2y - directionY * edge2x;
    const determinant = edge1x * pvecX + edge1y * pvecY + edge1z * pvecZ;

    if (Math.abs(determinant) < 1e-12) {
      return -1;
    }

    const inverse = 1 / determinant;
    const tvecX = originX - ax;
    const tvecY = originY - ay;
    const tvecZ = originZ - az;
    const u = (tvecX * pvecX + tvecY * pvecY + tvecZ * pvecZ) * inverse;

    if (u < 0 || u > 1) {
      return -1;
    }

    const qvecX = tvecY * edge1z - tvecZ * edge1y;
    const qvecY = tvecZ * edge1x - tvecX * edge1z;
    const qvecZ = tvecX * edge1y - tvecY * edge1x;
    const v = (directionX * qvecX + directionY * qvecY + directionZ * qvecZ) * inverse;

    if (v < 0 || u + v > 1) {
      return -1;
    }

    const distance = (edge2x * qvecX + edge2y * qvecY + edge2z * qvecZ) * inverse;

    if (distance <= SURFACE_EPSILON || distance >= maxDistance) {
      return -1;
    }

    this.hitU = u;
    this.hitV = v;
    return distance;
  }
}

/** Slab test against the node's box, tolerant of axis-parallel rays. */
function intersectsBox(
  bounds: Float32Array,
  node: number,
  originX: number,
  originY: number,
  originZ: number,
  inverseX: number,
  inverseY: number,
  inverseZ: number,
  maxDistance: number,
): boolean {
  const base = node * 6;

  let near = (bounds[base]! - originX) * inverseX;
  let far = (bounds[base + 3]! - originX) * inverseX;
  if (near > far) [near, far] = [far, near];

  let nearY = (bounds[base + 1]! - originY) * inverseY;
  let farY = (bounds[base + 4]! - originY) * inverseY;
  if (nearY > farY) [nearY, farY] = [farY, nearY];

  if (nearY > near) near = nearY;
  if (farY < far) far = farY;
  if (near > far) return false;

  let nearZ = (bounds[base + 2]! - originZ) * inverseZ;
  let farZ = (bounds[base + 5]! - originZ) * inverseZ;
  if (nearZ > farZ) [nearZ, farZ] = [farZ, nearZ];

  if (nearZ > near) near = nearZ;
  if (farZ < far) far = farZ;

  return near <= far && far >= 0 && near <= maxDistance;
}

/**
 * Reorders `order[start..end)` so the element at `middle` is the one a full
 * sort would put there, with smaller centroids before it. Quickselect rather
 * than a sort: the build only needs the pivot position, and paying O(n log n)
 * per node for an ordering nothing reads is most of a naive build's cost.
 */
function partitionByMedian(
  order: Uint32Array,
  centroids: Float32Array,
  start: number,
  end: number,
  middle: number,
  axis: number,
): void {
  let low = start;
  let high = end - 1;

  while (low < high) {
    const pivot = centroids[order[(low + high) >> 1]! * 3 + axis]!;
    let left = low;
    let right = high;

    while (left <= right) {
      while (centroids[order[left]! * 3 + axis]! < pivot) left += 1;
      while (centroids[order[right]! * 3 + axis]! > pivot) right -= 1;

      if (left <= right) {
        const swap = order[left]!;
        order[left] = order[right]!;
        order[right] = swap;
        left += 1;
        right -= 1;
      }
    }

    // Coincident centroids can leave the pivot immovable; splitting at the
    // midpoint anyway keeps the recursion shrinking.
    if (right < low && left > high) {
      return;
    }

    if (middle <= right) high = right;
    else if (middle >= left) low = left;
    else return;
  }
}
