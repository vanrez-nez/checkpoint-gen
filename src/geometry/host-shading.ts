import * as THREE from "three";
import { SurfaceBvh } from "./bvh";

/**
 * The stone's own baked shading, read at a point standing off it.
 *
 * A decal is a separate mesh lying a few millimetres proud of a wall, and it
 * used to carry no shading of its own at all — `mergeDecalQuads` filled its
 * occlusion and crack-shadow arrays with ones, on the reasoning that a prepared
 * field is flat stone with neither courses nor bevels and so is already at one.
 *
 * Measured against what the families actually emit, that is not close: a wall
 * averages 0.62 occlusion and 0.39 crack shadow, because `DEFAULT_FACE_SHADING`
 * runs a 0.28-to-0.72 gradient up every face. A decal at a flat one therefore
 * sits at the top of a gradient the stone around it is halfway down, and reads
 * as a brighter plate laid on the wall rather than as carving in it. One
 * instance filling a whole slot hid that, because the bright patch coincided
 * with the slot's own edge; a grid of glyphs in the middle of a field does not.
 *
 * So the decal reads the wall instead of assuming it. Nothing here computes
 * occlusion — it samples what the builders already baked, which is what keeps a
 * decal agreeing with its host under every one of the strength sliders.
 */
export interface HostShading {
  readonly ambientOcclusion: number;
  readonly bakedShadow: number;
}

/**
 * How far past its own stand-off a sample may look for the stone.
 *
 * A decal knows how far it was pushed out, so the search only has to cover that
 * plus enough for the face to be a little further back than advertised — a
 * battered face displaces along the patch normal rather than its own, so the
 * true perpendicular gap is slightly under the nominal one. Generous enough to
 * find the wall, short enough that a decal overhanging an opening finds nothing
 * rather than the floor two metres below.
 */
const SEARCH_MARGIN = 0.05;

export class HostShadingSampler {
  private readonly bvh: SurfaceBvh;
  private readonly index: THREE.TypedArray;
  private readonly ambientOcclusion: Float32Array | null;
  private readonly bakedShadow: Float32Array | null;

  private constructor(
    bvh: SurfaceBvh,
    index: THREE.TypedArray,
    ambientOcclusion: Float32Array | null,
    bakedShadow: Float32Array | null,
  ) {
    this.bvh = bvh;
    this.index = index;
    this.ambientOcclusion = ambientOcclusion;
    this.bakedShadow = bakedShadow;
  }

  /**
   * Builds over one geometry, in its own triangle order.
   *
   * One geometry rather than a scene, deliberately. The sun hierarchy is built
   * over the concatenation of every occluder, which is right for occlusion and
   * useless here: a triangle index into a concatenation says nothing about
   * which target it came from, and the whole point of this hierarchy is to get
   * back to three vertices of one known buffer.
   *
   * Pass the geometry the decals were actually placed against — the subdivided
   * one. `subdivideLongEdges` interpolates both base arrays through every split,
   * so the pre-subdivision merge carries different values at the same point.
   */
  static from(geometry: THREE.BufferGeometry): HostShadingSampler | null {
    const index = geometry.getIndex();
    const position = geometry.getAttribute("position");

    if (!index || !position) {
      return null;
    }

    const triangles = new Float32Array(index.count * 3);

    for (let corner = 0; corner < index.count; corner += 1) {
      const vertex = index.getX(corner);
      triangles[corner * 3] = position.getX(vertex);
      triangles[corner * 3 + 1] = position.getY(vertex);
      triangles[corner * 3 + 2] = position.getZ(vertex);
    }

    const userData = geometry.userData as {
      vertexAoBase?: Float32Array;
      bakedShadowBase?: Float32Array;
    };
    const expected = position.count;

    return new HostShadingSampler(
      SurfaceBvh.build(triangles),
      index.array,
      userData.vertexAoBase?.length === expected ? userData.vertexAoBase : null,
      userData.bakedShadowBase?.length === expected ? userData.bakedShadowBase : null,
    );
  }

  /**
   * The stone's shading behind a point, or null where there is no stone.
   *
   * `standOff` is how far the point was pushed out along `normal`, which the
   * caller knows exactly and this cannot guess: the decal offset, plus any
   * applied-moulding projection, plus any relief the slot's face was given.
   *
   * Null rather than a default, so the caller decides what a miss means. It
   * leaves the value at one, which is what a decal with no host behind it —
   * an applique standing free of the structure — should keep.
   */
  sample(
    x: number,
    y: number,
    z: number,
    normalX: number,
    normalY: number,
    normalZ: number,
    standOff: number,
  ): HostShading | null {
    // Back along the normal, from slightly in front of where the point sits, so
    // a decal placed exactly on its host still has a segment to travel.
    const reach = Math.max(0, standOff) + SEARCH_MARGIN;
    const hit = this.bvh.nearest(
      x + normalX * SEARCH_MARGIN,
      y + normalY * SEARCH_MARGIN,
      z + normalZ * SEARCH_MARGIN,
      -normalX,
      -normalY,
      -normalZ,
      reach + SEARCH_MARGIN,
    );

    if (!hit) {
      return null;
    }

    const corner = hit.triangle * 3;
    const a = this.index[corner]!;
    const b = this.index[corner + 1]!;
    const c = this.index[corner + 2]!;
    const weightA = 1 - hit.u - hit.v;

    return {
      ambientOcclusion: this.ambientOcclusion
        ? weightA * this.ambientOcclusion[a]!
          + hit.u * this.ambientOcclusion[b]!
          + hit.v * this.ambientOcclusion[c]!
        : 1,
      bakedShadow: this.bakedShadow
        ? weightA * this.bakedShadow[a]!
          + hit.u * this.bakedShadow[b]!
          + hit.v * this.bakedShadow[c]!
        : 1,
    };
  }
}
