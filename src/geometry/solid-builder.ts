import type { GeometryBuffers } from "./finalize";
import {
  materialSlotIndex,
  type MaterialSlot,
} from "./part";
import {
  DEFAULT_FACE_SHADING,
  horizontalShading,
  sideShading,
  type FaceShading,
} from "./shading";

export {
  DEFAULT_FACE_SHADING,
  FLAT_FACE_SHADING,
  type FaceShading,
} from "./shading";

/** A point in space. Exported because callers hand block corners in directly. */
export type Vertex3 = { readonly x: number; readonly y: number; readonly z: number };

/**
 * A block: two horizontal rings of four corners, bottom and top.
 *
 * Both rings run **outer start, outer end, inner end, inner start** — outward
 * face first, then round the block away from the surface it sits on. The two
 * rings are index-aligned and independent, so a block on a battered wall is a
 * genuine eight-cornered box with a raked outer face, and a whole band is one
 * block of exactly the same kind.
 */
export interface Block {
  readonly bottom: readonly Vertex3[];
  readonly top: readonly Vertex3[];
}

/**
 * Which of a block's faces anything can see.
 *
 * Positional rather than named, because not every block has one outer face: a
 * quoin's leg presents to two elevations, and a band drawn as a single block
 * presents to four. An ordinary course block's edges run outer, end, inner,
 * start. Naming them would have forced those cases to be several blocks, which
 * is the fault this replaced.
 */
export interface BlockFaces {
  /** One flag per ring edge. Edge `i` runs from ring corner `i` to `i + 1`. */
  readonly sides: readonly boolean[];
  readonly top?: boolean;
  readonly bottom?: boolean;
  /**
   * Moves a retained bed closure upward inside its own block.
   *
   * Used for a displaced joint closure: the real bed is occupied by the course
   * below, while the inset upward-facing ledge closes only the part exposed by
   * an overhanging arris without becoming coplanar with that support.
   */
  readonly bottomInset?: number;
  /**
   * Optional semantic material overrides for individual emitted faces. Side
   * order matches `sides`; omitted entries inherit the builder's active slot.
   */
  readonly materials?: BlockFaceMaterials;
  /**
   * Real distance along the surface at this block's authored edge 0, start and
   * end. Given it, that side's `u` runs the surface rather than a world axis,
   * so a run of facets around a bevelled corner stays continuous.
   */
  readonly uvSpan?: readonly [number, number];
}

export interface BlockFaceMaterials {
  readonly sides?: readonly (MaterialSlot | undefined)[];
  readonly top?: MaterialSlot;
  readonly bottom?: MaterialSlot;
}

/** Returns true when a complete emitted quad can be discarded. */
export type FaceCullPredicate = (corners: readonly Vertex3[]) => boolean;

/**
 * Builds a mass out of blocks, and out of nothing else.
 *
 * There is one primitive here on purpose. This builder used to offer lofts, caps
 * and rings alongside blocks, and every one of them carried its own winding
 * rule, its own shading argument and its own idea of where a surface belonged —
 * so a mass came out as several kinds of geometry that met by arithmetic and
 * disagreed wherever the arithmetic was wrong. A greybox band, the core behind a
 * wall, a terrace slab and a single set stone are all the same shape: a box with
 * two independent horizontal rings. They are all `addBlock` now, so there is no
 * second way for a surface to be drawn and nothing for the block layer to fall
 * out of step with.
 *
 * Winding is normalised on entry, so callers may author rings either way round.
 */
export class SolidBuilder implements GeometryBuffers {
  readonly positions: number[] = [];
  readonly indices: number[] = [];
  readonly ambientOcclusion: number[] = [];
  readonly bakedShadow: number[] = [];
  readonly surfaceMaterials: number[] = [];
  /** Authored UVs; NaN wherever the caller left the projection to decide. */
  readonly uvs: number[] = [];
  private activeMaterial: MaterialSlot = "stone";
  /** Blocks laid, whichever of their faces turned out to be visible. */
  blockCount = 0;
  /**
   * Where each face a block emitted begins in the vertex buffer.
   *
   * A block writes only the faces nothing is pressed against, so there is no
   * stride to walk and no fixed count per block. Recording the starts is what
   * lets the invariant suite read the faces back without assuming a layout —
   * guessing one has misread this buffer three times. It is also the proof that
   * every triangle in a mass belongs to a block: `blockFaces.length * 6` has to
   * equal the index count.
   */
  readonly blockFaces: number[] = [];

  /** Emits every face in `callback` with one semantic material owner. */
  withMaterial<T>(slot: MaterialSlot, callback: () => T): T {
    const previous = this.activeMaterial;
    this.activeMaterial = slot;

    try {
      return callback();
    } finally {
      this.activeMaterial = previous;
    }
  }

  /**
   * Reclassifies already-emitted complete faces without touching their topology.
   *
   * This is used when a support slab is built before the rooms that determine
   * which parts of its crown are interior floors.
   */
  assignFaceMaterial(
    predicate: FaceCullPredicate,
    slot: MaterialSlot,
  ): number {
    const material = materialSlotIndex(slot);
    let assigned = 0;

    for (const start of this.blockFaces) {
      const corners = this.faceCorners(start);

      if (!predicate(corners)) {
        continue;
      }

      for (let corner = 0; corner < 4; corner += 1) {
        this.surfaceMaterials[start + corner] = material;
      }
      assigned += 1;
    }

    return assigned;
  }

  /**
   * Removes complete quads selected by `predicate`, compacting every raw buffer.
   *
   * This deliberately operates on faces rather than blocks. A block may still
   * present a terrace or joint cheek while another complete face is buried by a
   * later assembly such as a stair. Every emitted face owns four vertices and
   * six indices, so compaction preserves the builder's fixed face contract
   * without triangulating, clipping or changing the semantic block count.
   */
  cullFaces(predicate: FaceCullPredicate): number {
    const positions: number[] = [];
    const ambientOcclusion: number[] = [];
    const bakedShadow: number[] = [];
    const surfaceMaterials: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const blockFaces: number[] = [];
    let removed = 0;

    for (const start of this.blockFaces) {
      const corners = this.faceCorners(start);

      if (predicate(corners)) {
        removed += 1;
        continue;
      }

      const nextStart = positions.length / 3;
      blockFaces.push(nextStart);

      for (let corner = 0; corner < 4; corner += 1) {
        const vertex = start + corner;
        positions.push(
          this.positions[vertex * 3] ?? 0,
          this.positions[vertex * 3 + 1] ?? 0,
          this.positions[vertex * 3 + 2] ?? 0,
        );
        ambientOcclusion.push(this.ambientOcclusion[vertex] ?? 1);
        bakedShadow.push(this.bakedShadow[vertex] ?? 1);
        surfaceMaterials.push(
          this.surfaceMaterials[vertex] ?? materialSlotIndex("stone"),
        );
        uvs.push(
          this.uvs[vertex * 2] ?? Number.NaN,
          this.uvs[vertex * 2 + 1] ?? Number.NaN,
        );
      }

      indices.push(
        nextStart, nextStart + 1, nextStart + 2,
        nextStart, nextStart + 2, nextStart + 3,
      );
    }

    replaceContents(this.positions, positions);
    replaceContents(this.ambientOcclusion, ambientOcclusion);
    replaceContents(this.bakedShadow, bakedShadow);
    replaceContents(this.surfaceMaterials, surfaceMaterials);
    replaceContents(this.uvs, uvs);
    replaceContents(this.indices, indices);
    replaceContents(this.blockFaces, blockFaces);

    return removed;
  }

  /**
   * One block, and only the faces of it that anything can see.
   *
   * `faces` is the caller's answer to one question per face: is the space just
   * outside it empty? Where two blocks are pressed together, neither surface is
   * emitted — that boundary is interior. Getting it wrong in either direction is
   * visible, as a hole or as two faces at the same depth fighting, so it is
   * decided by the layout that knows rather than guessed here.
   *
   * Every block uses the same per-stone shading as the circular structure unless
   * a caller explicitly supplies another face palette: dark at the bed, lighter
   * at the top, and fully open across a horizontal top.
   */
  addBlock(
    block: Block,
    faces: BlockFaces,
    shading: FaceShading = DEFAULT_FACE_SHADING,
  ): void {
    if (block.bottom.length !== 4 || block.top.length !== 4) {
      throw new Error("A block needs four corners top and bottom.");
    }

    // Authored either way round, like every outline in this project. Reversing a
    // ring maps edge `e` onto the reverse of edge `2 - e`, so the flags follow.
    const flip = signedArea(block.bottom) > 0;
    const bottom = flip ? [...block.bottom].reverse() : block.bottom;
    const top = flip ? [...block.top].reverse() : block.top;
    const authoredEdge = (edge: number) => flip ? (2 - edge + 4) % 4 : edge;
    const sideAt = (edge: number) => faces.sides[authoredEdge(edge)] === true;

    for (let edge = 0; edge < 4; edge += 1) {
      if (!sideAt(edge)) {
        continue;
      }

      const next = (edge + 1) % 4;
      const bottomCurrent = bottom[edge];
      const bottomNext = bottom[next];
      const topNext = top[next];
      const topCurrent = top[edge];

      if (!bottomCurrent || !bottomNext || !topNext || !topCurrent) {
        continue;
      }

      const low = sideShading(shading, "bottom");
      const high = sideShading(shading, "top");

      // Winding may have been reversed on entry, so the authored span runs the
      // authored direction: swap it when this edge is walking the other way.
      const span = faces.uvSpan;
      const forward = !flip;
      const uv = span
        ? {
          start: forward ? span[0] : span[1],
          end: forward ? span[1] : span[0],
        }
        : null;

      this.addFace(
        [bottomCurrent, bottomNext, topNext, topCurrent],
        [low.ao, low.ao, high.ao, high.ao],
        [low.shadow, low.shadow, high.shadow, high.shadow],
        faces.materials?.sides?.[authoredEdge(edge)],
        uv
          ? [
            [uv.start, bottomCurrent.y],
            [uv.end, bottomNext.y],
            [uv.end, topNext.y],
            [uv.start, topCurrent.y],
          ]
          : undefined,
      );
    }

    if (faces.top === true) {
      this.addHorizontalFace(top, "up", shading, faces.materials?.top);
    }

    if (faces.bottom === true) {
      const inset = Math.max(faces.bottomInset ?? 0, 0);
      this.addHorizontalFace(
        inset > 0
          ? bottom.map((corner) => ({ ...corner, y: corner.y + inset }))
          : bottom,
        inset > 0 ? "up" : "down",
        shading,
        faces.materials?.bottom,
      );
    }

    this.blockCount += 1;
  }

  /** A block's top or bottom, shaded from the shared stone palette. */
  private addHorizontalFace(
    ring: readonly Vertex3[],
    facing: "up" | "down",
    shading: FaceShading,
    material?: MaterialSlot,
  ): void {
    const [a, b, c, d] = ring;

    if (!a || !b || !c || !d) {
      return;
    }

    const { ao, shadow } = horizontalShading(shading, facing);

    this.addFace(
      facing === "up" ? [a, b, c, d] : [d, c, b, a],
      [ao, ao, ao, ao],
      [shadow, shadow, shadow, shadow],
      material,
    );
  }

  /** One flat quad of a block, wound so it points out of the block. */
  private addFace(
    corners: readonly Vertex3[],
    ao: readonly number[],
    shadow: readonly number[],
    material?: MaterialSlot,
    uvs?: readonly (readonly [number, number])[],
  ): void {
    const start = this.vertexCount();

    for (let index = 0; index < 4; index += 1) {
      const corner = corners[index];

      if (!corner) {
        return;
      }

      this.push(
        corner.x,
        corner.y,
        corner.z,
        ao[index] ?? 1,
        shadow[index] ?? 1,
        material,
        uvs?.[index],
      );
    }

    this.blockFaces.push(start);
    this.indices.push(
      start, start + 1, start + 2,
      start, start + 2, start + 3,
    );
  }

  private vertexCount(): number {
    return this.positions.length / 3;
  }

  private push(
    x: number,
    y: number,
    z: number,
    ambientOcclusion: number,
    bakedShadow: number,
    material?: MaterialSlot,
    uv?: readonly [number, number],
  ): void {
    this.positions.push(x, y, z);
    this.ambientOcclusion.push(ambientOcclusion);
    this.bakedShadow.push(bakedShadow);
    this.surfaceMaterials.push(materialSlotIndex(material ?? this.activeMaterial));
    this.uvs.push(uv?.[0] ?? Number.NaN, uv?.[1] ?? Number.NaN);
  }

  private faceCorners(start: number): Vertex3[] {
    return [0, 1, 2, 3].map((corner): Vertex3 => {
      const vertex = start + corner;

      return {
        x: this.positions[vertex * 3] ?? 0,
        y: this.positions[vertex * 3 + 1] ?? 0,
        z: this.positions[vertex * 3 + 2] ?? 0,
      };
    });
  }
}

/**
 * Twice the signed area of a ring in the (x, z) plane.
 *
 * Negative is the winding this builder's index order assumes: it makes a fan
 * over the ring face +Y and a side quad walking it face outward.
 */
function signedArea(points: readonly Vertex3[]): number {
  let area = 0;

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];

    if (current && next) {
      area += current.x * next.z - next.x * current.z;
    }
  }

  return area * 0.5;
}

/** Replaces a large numeric buffer without spreading it through call arguments. */
function replaceContents(target: number[], source: readonly number[]): void {
  target.length = 0;

  for (const value of source) {
    target.push(value);
  }
}
