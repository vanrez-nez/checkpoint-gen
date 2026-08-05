import * as THREE from "three";
import { createBoxProjectedUvs } from "../geometry/finalize";
import { evaluateFrame, type LocalFrame, type Vec3 } from "../structure/kernel/frame";
import type { SlotRecord, Uv } from "../structure/kernel/slot";

/**
 * How an engraving is fitted to the slot it was assigned to.
 *
 * Both modes place exactly one instance. Repeating a motif across a field is a
 * different decision — it needs a cell size, a phase and a rule for what
 * happens at the edges — and belongs to the tiling system rather than here.
 * The `(s, t)` rectangle below is the seam that system will attach to.
 */
export const ENGRAVING_FITS = ["contain", "stretch"] as const;

export type EngravingFit = (typeof ENGRAVING_FITS)[number];

/**
 * How far a decal stands off the stone, in metres.
 *
 * Sized against the depth buffer rather than against the stonework. At the
 * default framing of a large mass the camera sits about sixty metres out with a
 * near plane around 0.12, which resolves roughly two millimetres of separation;
 * six is a comfortable multiple of that and still a four-thousandth of the
 * structure's height, far too little to break a silhouette. The decal also
 * carries a polygon offset, which handles every closer distance for free.
 */
export const DECAL_NORMAL_OFFSET = 0.006;

/**
 * Longest edge a decal may span before it is divided, in metres.
 *
 * Not a shading-quality nicety but a continuity requirement. The sun is baked
 * per vertex, so a decal drawn as a single quad can only interpolate a shadow
 * bilinearly across its whole width — and a stair's shadow crossing an engraved
 * elevation would stop at the engraving and resume after it. The structure's own
 * geometry is refined against the same bound before its bake, for the same
 * reason, so matching it is what keeps the two agreeing at the decal's edge.
 */
export const DECAL_MAX_EDGE = 1.5;

/**
 * Where a decal sits inside its slot, in the slot's own parameter space.
 *
 * `s` runs along the slot's width and `t` up its height, both from zero to one
 * across the published boundary. Keeping this as a value of its own is what
 * lets a tiling system produce many of them per slot later without any of the
 * corner mapping, winding or attribute work below having to change.
 */
export interface DecalRect {
  readonly sMin: number;
  readonly sMax: number;
  readonly tMin: number;
  readonly tMax: number;
}

export interface EngravingDecalQuad {
  /** World corners, bottom-left first — the order `slot.boundary` publishes. */
  readonly corners: readonly [Vec3, Vec3, Vec3, Vec3];
  readonly normal: Vec3;
  /**
   * True when the frame's `u` and `v` axes cross *against* its normal, so the
   * corner order above would wind the quad away from the viewer.
   */
  readonly flipWinding: boolean;
}

export interface DecalPlacement {
  readonly fit: EngravingFit;
  /** Metres taken off every side of the slot before fitting. */
  readonly margin: number;
  /** The layer's own width over its height, in cells. */
  readonly aspect: number;
  readonly offset?: number;
}

/**
 * Where the engraving lands inside the slot.
 *
 * The margin is converted from metres using the slot's *mean* width. A slot on
 * a battered face is a trapezoid, and insetting each edge by a true constant
 * distance would round its corners into something that is no longer a
 * trapezoid; insetting by a constant fraction keeps the shape and puts the
 * margin exactly right at mid-height, drifting by the taper ratio towards the
 * ends. On the batters this project builds that is a few per cent of the
 * margin, which is not a distance anyone can see.
 */
export function resolveDecalRect(
  slot: SlotRecord,
  placement: DecalPlacement,
): DecalRect | null {
  const width = (slot.extent.uBottom + slot.extent.uTop) / 2;
  const height = slot.extent.v;

  if (!(width > 0) || !(height > 0)) {
    return null;
  }

  const margin = Math.max(0, placement.margin);
  const insetS = clamp(margin / width, 0, MAX_MARGIN_FRACTION);
  const insetT = clamp(margin / height, 0, MAX_MARGIN_FRACTION);

  let rect: DecalRect = {
    sMin: insetS,
    sMax: 1 - insetS,
    tMin: insetT,
    tMax: 1 - insetT,
  };

  if (placement.fit === "contain" && placement.aspect > 0) {
    const spanWidth = width * (rect.sMax - rect.sMin);
    const spanHeight = height * (rect.tMax - rect.tMin);
    const spanAspect = spanWidth / spanHeight;

    // The engraving is shrunk to fit rather than letterboxed inside the full
    // rectangle. Letterboxing would run the engraving's own UVs outside zero to
    // one, which needs clamped sampling and a blank border row in every layer;
    // shrinking is exact and needs neither. It also leaves no seam, because the
    // stone the decal no longer covers is dressed from the same material at the
    // same UVs.
    rect = spanAspect > placement.aspect
      ? shrinkS(rect, placement.aspect / spanAspect)
      : shrinkT(rect, spanAspect / placement.aspect);
  }

  return rect.sMax > rect.sMin && rect.tMax > rect.tMin ? rect : null;
}

/**
 * Places a rectangle of the slot's parameter space in the world.
 *
 * The boundary is bilinearly interpolated in patch coordinates and only then
 * evaluated. That is not an approximation: `evaluateFrame` is affine in `u` and
 * `v`, so interpolating before it and after it give the same points, and a
 * sub-rectangle of a trapezoid stays a trapezoid — which is what keeps the quad
 * planar on a battered face.
 */
export function decalQuadFromRect(
  slot: SlotRecord,
  frame: LocalFrame,
  rect: DecalRect,
  offset: number = DECAL_NORMAL_OFFSET,
): EngravingDecalQuad | null {
  const boundary = slot.boundary;

  if (boundary.length !== 4) {
    return null;
  }

  const [bottomLeft, bottomRight, topRight, topLeft] = boundary as readonly [Uv, Uv, Uv, Uv];
  const at = (s: number, t: number): Vec3 => {
    const bottomU = lerp(bottomLeft.u, bottomRight.u, s);
    const bottomV = lerp(bottomLeft.v, bottomRight.v, s);
    const topU = lerp(topLeft.u, topRight.u, s);
    const topV = lerp(topLeft.v, topRight.v, s);
    return evaluateFrame(frame, lerp(bottomU, topU, t), lerp(bottomV, topV, t), offset);
  };

  return {
    corners: [
      at(rect.sMin, rect.tMin),
      at(rect.sMax, rect.tMin),
      at(rect.sMax, rect.tMax),
      at(rect.sMin, rect.tMax),
    ],
    normal: frame.normal,
    // The kernel's frames are not consistently handed: a facade's u crossed
    // into its v gives its outward normal, while a horizontal frame's gives the
    // opposite. A terrace or plinth-top slot would therefore be built
    // inside-out by the corner order alone, and would only be noticed when a
    // decal vanished from above and appeared from below.
    flipWinding: dot(cross(frame.uAxis, frame.vAxis), frame.normal) < 0,
  };
}

export function resolveDecalQuad(
  slot: SlotRecord,
  frame: LocalFrame,
  placement: DecalPlacement,
): EngravingDecalQuad | null {
  const rect = resolveDecalRect(slot, placement);
  return rect ? decalQuadFromRect(slot, frame, rect, placement.offset) : null;
}

/**
 * Gathers every quad sharing an engraving and a dressed surface into one mesh.
 *
 * That pair is the natural draw-call unit: the material needs the layer's
 * derived maps and the surface's material channels, so two quads agreeing on
 * both can share everything. A mass with all six of its slot features engraved
 * therefore costs six draw calls, whatever the bay count multiplied that into.
 *
 * The material-channel UVs are box projected here exactly as the structure's
 * are. Because that projection reads the two world axes the surface does *not*
 * face, and the decal is offset along the third, a decal's UVs come out
 * identical to the stone underneath rather than merely close — which is what
 * lets the engraving sit in the stone instead of on it.
 */
export function mergeDecalQuads(
  quads: readonly EngravingDecalQuad[],
): THREE.BufferGeometry | null {
  if (quads.length === 0) {
    return null;
  }

  const grids = quads.map(gridOf);
  const vertexCount = grids.reduce(
    (total, grid) => total + (grid.columns + 1) * (grid.rows + 1),
    0,
  );
  const triangleCount = grids.reduce(
    (total, grid) => total + grid.columns * grid.rows * 2,
    0,
  );
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const engravingUvs = new Float32Array(vertexCount * 2);
  const indices = new Uint32Array(triangleCount * 3);
  let vertex = 0;
  let index = 0;

  quads.forEach((quad, quadIndex) => {
    const { columns, rows } = grids[quadIndex]!;
    const base = vertex;
    const [bottomLeft, bottomRight, topRight, topLeft] = quad.corners;

    for (let row = 0; row <= rows; row += 1) {
      const t = row / rows;

      for (let column = 0; column <= columns; column += 1) {
        const s = column / columns;
        // Bilinear across the four corners. The quad is planar even when it is
        // a trapezoid, so this reproduces the same surface rather than
        // approximating it, and the engraving's own UVs stay linear in s and t.
        positions[vertex * 3] = bilinear(bottomLeft.x, bottomRight.x, topRight.x, topLeft.x, s, t);
        positions[vertex * 3 + 1] = bilinear(bottomLeft.y, bottomRight.y, topRight.y, topLeft.y, s, t);
        positions[vertex * 3 + 2] = bilinear(bottomLeft.z, bottomRight.z, topRight.z, topLeft.z, s, t);
        normals[vertex * 3] = quad.normal.x;
        normals[vertex * 3 + 1] = quad.normal.y;
        normals[vertex * 3 + 2] = quad.normal.z;
        engravingUvs[vertex * 2] = s;
        engravingUvs[vertex * 2 + 1] = t;
        vertex += 1;
      }
    }

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const corner = base + row * (columns + 1) + column;
        const cell = [
          corner,
          corner + 1,
          corner + columns + 2,
          corner + columns + 1,
        ];
        const order = quad.flipWinding ? FLIPPED_TRIANGLES : TRIANGLES;

        for (const step of order) {
          indices[index] = cell[step]!;
          index += 1;
        }
      }
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("engravingUv", new THREE.BufferAttribute(engravingUvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  // A prepared field is flat stone with no courses and no bevels, so the
  // crevice occlusion and crack shadow the structure carries are already about
  // one there. The engraving supplies its own occlusion through its maps, which
  // is the whole point of deriving them.
  const ones = new Float32Array(vertexCount).fill(1);
  const shade = new Float32Array(vertexCount * 3).fill(1);
  geometry.setAttribute("vertexAo", new THREE.BufferAttribute(ones.slice(), 1));
  geometry.setAttribute("color", new THREE.BufferAttribute(shade, 3));

  const baseUvs = createBoxProjectedUvs(geometry);
  geometry.setAttribute("uv", new THREE.BufferAttribute(baseUvs.slice(), 2));

  // The same three arrays the merged structure geometry carries, so the scene's
  // existing per-vertex passes run over a decal unchanged.
  geometry.userData.baseUvs = baseUvs;
  geometry.userData.vertexAoBase = ones;
  geometry.userData.bakedShadowBase = ones.slice();
  geometry.userData.sunVisibilityBase = ones.slice();
  geometry.computeBoundingSphere();
  return geometry;
}

/** No margin may eat more than this fraction of a slot from either side. */
const MAX_MARGIN_FRACTION = 0.49;

const TRIANGLES: readonly number[] = [0, 1, 2, 0, 2, 3];
const FLIPPED_TRIANGLES: readonly number[] = [0, 2, 1, 0, 3, 2];

/** No decal is divided beyond this, whatever face it lands on. */
const MAX_DECAL_DIVISIONS = 8;

/** How finely one quad has to be divided to carry a shadow crossing it. */
function gridOf(quad: EngravingDecalQuad): {
  readonly columns: number;
  readonly rows: number;
} {
  const [bottomLeft, bottomRight, topRight, topLeft] = quad.corners;

  return {
    columns: divisions(Math.max(
      distance(bottomLeft, bottomRight),
      distance(topLeft, topRight),
    )),
    rows: divisions(Math.max(
      distance(bottomLeft, topLeft),
      distance(bottomRight, topRight),
    )),
  };
}

function divisions(length: number): number {
  return Math.max(
    1,
    Math.min(MAX_DECAL_DIVISIONS, Math.ceil(length / DECAL_MAX_EDGE)),
  );
}

function distance(from: Vec3, to: Vec3): number {
  return Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
}

function bilinear(
  bottomLeft: number,
  bottomRight: number,
  topRight: number,
  topLeft: number,
  s: number,
  t: number,
): number {
  return lerp(
    lerp(bottomLeft, bottomRight, s),
    lerp(topLeft, topRight, s),
    t,
  );
}

function shrinkS(rect: DecalRect, factor: number): DecalRect {
  const center = (rect.sMin + rect.sMax) / 2;
  const half = ((rect.sMax - rect.sMin) * factor) / 2;
  return { ...rect, sMin: center - half, sMax: center + half };
}

function shrinkT(rect: DecalRect, factor: number): DecalRect {
  const center = (rect.tMin + rect.tMax) / 2;
  const half = ((rect.tMax - rect.tMin) * factor) / 2;
  return { ...rect, tMin: center - half, tMax: center + half };
}

function cross(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function dot(left: Vec3, right: Vec3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function lerp(from: number, to: number, factor: number): number {
  return from + (to - from) * factor;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
