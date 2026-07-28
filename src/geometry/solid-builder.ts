import type { GeometryBuffers } from "./finalize";
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
}

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
    const sideAt = (edge: number) =>
      faces.sides[flip ? (2 - edge + 4) % 4 : edge] === true;

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

      this.addFace(
        [bottomCurrent, bottomNext, topNext, topCurrent],
        [low.ao, low.ao, high.ao, high.ao],
        [low.shadow, low.shadow, high.shadow, high.shadow],
      );
    }

    if (faces.top === true) {
      this.addHorizontalFace(top, "up", shading);
    }

    if (faces.bottom === true) {
      this.addHorizontalFace(bottom, "down", shading);
    }

    this.blockCount += 1;
  }

  /** A block's top or bottom, shaded from the shared stone palette. */
  private addHorizontalFace(
    ring: readonly Vertex3[],
    facing: "up" | "down",
    shading: FaceShading,
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
    );
  }

  /** One flat quad of a block, wound so it points out of the block. */
  private addFace(
    corners: readonly Vertex3[],
    ao: readonly number[],
    shadow: readonly number[],
  ): void {
    const start = this.vertexCount();

    for (let index = 0; index < 4; index += 1) {
      const corner = corners[index];

      if (!corner) {
        return;
      }

      this.push(corner.x, corner.y, corner.z, ao[index] ?? 1, shadow[index] ?? 1);
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
  ): void {
    this.positions.push(x, y, z);
    this.ambientOcclusion.push(ambientOcclusion);
    this.bakedShadow.push(bakedShadow);
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
