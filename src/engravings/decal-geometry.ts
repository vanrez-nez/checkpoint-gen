import * as THREE from "three";
import { createBoxProjectedUvs } from "../geometry/finalize";
import { evaluateFrame, type LocalFrame, type Vec3 } from "../structure/kernel/frame";
import type { SlotRecord, Uv } from "../structure/kernel/slot";

/**
 * How an engraving is fitted to the slot it was assigned to.
 *
 * Both modes shape exactly one *instance*. How many instances there are is a
 * separate decision — see `ENGRAVING_TILINGS` — and deliberately not a third
 * member here: a fit answers what shape, a tiling answers how often, and
 * folding them together would make "contained, four across" unsayable.
 *
 * Once a motif repeats, its proportions come from the tiling rather than from
 * here, so a fit is consulted only where the placement resolves to a single
 * instance. With no tiling that is always, and this behaves exactly as it did
 * before there was one.
 */
export const ENGRAVING_FITS = ["contain", "stretch"] as const;

export type EngravingFit = (typeof ENGRAVING_FITS)[number];

/**
 * How often a motif repeats across the slot it was fitted to.
 *
 * The axes are the slot's own: `horizontal` runs along its width and `vertical`
 * up its height, which is why the values match `SlotRecord.flow` rather than
 * naming world directions — on a terrace or a plinth top, "up the slot" is
 * horizontal in the world.
 *
 * The two seamless modes cost nothing. Their repeat rides a vertex attribute,
 * so a hundred of a motif is the same quad, the same bake and the same upload
 * as one of it; what that forecloses is anything an instance has to know about
 * *which* instance it is. `grid` is the mode that needs exactly that — every
 * cell carries a different glyph — so it is the one that spends a quad per
 * cell, and `DecalRect` is where it attaches.
 */
export const ENGRAVING_TILINGS = [
  "none",
  "horizontal",
  "vertical",
  "grid",
] as const;

export type EngravingTiling = (typeof ENGRAVING_TILINGS)[number];

/** How a grid walks its glyph pool. */
export const ENGRAVING_GLYPH_ORDERS = ["sequential", "random"] as const;

export type EngravingGlyphOrder = (typeof ENGRAVING_GLYPH_ORDERS)[number];

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
 * The most times a motif may repeat across one slot on one axis.
 *
 * A guard against a degenerate slot rather than a bound on the design. The
 * repeat rides a float32 attribute, where 256 is a sub-texel step of 256/2^24
 * on the largest map this project derives, so nothing here is about precision.
 * It is sized so it never clamps the *natural* repeat on the worst field the
 * families actually publish — a square motif on the 23.42 by 0.16 metre band
 * cornice asks for 146 — and only bites where a slot's height has collapsed.
 */
export const MAX_TILE_REPEATS = 256;

/**
 * The most cells one slot's grid may be divided into.
 *
 * This one *is* a cost bound, because a grid spends a quad per cell: a hall
 * publishes a hundred and ninety-two pier panels, so the cap is what stands
 * between a cell-size slider and fifty thousand decal vertices under a sun bake.
 * Ordinary settings never approach it — the fitter prefers the largest cell that
 * fits, which lands real slots between one and nine cells — and it is only
 * reachable by driving the maximum cell size down deliberately.
 */
export const MAX_GRID_CELLS = 64;

/**
 * Where a decal sits inside its slot, in the slot's own parameter space.
 *
 * `s` runs along the slot's width and `t` up its height, both from zero to one
 * across the published boundary. Keeping this as a value of its own is what
 * lets the grid produce many of them per slot without any of the corner
 * mapping, winding or attribute work below having to change.
 */
export interface DecalRect {
  readonly sMin: number;
  readonly sMax: number;
  readonly tMin: number;
  readonly tMax: number;
}

/**
 * How many motifs a placed rectangle carries on each axis.
 *
 * Fractional on purpose for the seamless modes: the run starts at the slot's
 * origin corner and the last motif is cut by the far edge, which is what a
 * running band does where it meets a corner. A grid's counts are whole, because
 * half a glyph is not a glyph.
 */
export interface DecalRepeat {
  readonly s: number;
  readonly t: number;
}

export const NO_DECAL_REPEAT: DecalRepeat = { s: 1, t: 1 };

/** The cell counts a grid divided its block into. */
export interface DecalGrid {
  readonly columns: number;
  readonly rows: number;
}

export interface DecalTiling {
  readonly mode: EngravingTiling;
  /**
   * Tile size against the motif's own proportions, for the seamless modes. One
   * is undistorted: the tile spans the slot's binding axis and takes the layer's
   * authored aspect along the other.
   */
  readonly scale: number;
  /** Smallest and largest a grid cell may be, in metres. */
  readonly cellMin: number;
  readonly cellMax: number;
  /** Bare stone left around each glyph, as a fraction of its cell per side. */
  readonly gutter: number;
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
  /** How many motifs this quad carries. `NO_DECAL_REPEAT` is one of them. */
  readonly repeat: DecalRepeat;
}

export interface DecalPlacement {
  readonly fit: EngravingFit;
  /** Metres taken off every side of the slot before fitting. */
  readonly margin: number;
  /** The layer's own width over its height, in cells. */
  readonly aspect: number;
  readonly offset?: number;
  /** Absent is the same as `mode: "none"`. */
  readonly tiling?: DecalTiling;
}

/** A resolved placement: where the block sits, and how it is divided. */
export interface ResolvedDecalPlacement {
  readonly rect: DecalRect;
  readonly repeat: DecalRepeat;
  /** Set only by `grid`; the seamless modes carry their count in `repeat`. */
  readonly grid: DecalGrid | null;
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
export function resolveDecalPlacement(
  slot: SlotRecord,
  placement: DecalPlacement,
): ResolvedDecalPlacement | null {
  const span = slotSpan(slot);

  if (!span) {
    return null;
  }

  // Three steps, and the order is the design. The margin comes off first,
  // because it is stated in metres against the slot and nothing later may move
  // it. The division is counted next, against the *margined* field — before a
  // fit has shrunk anything, or the shrink would depend on the count and the
  // count on the shrink. The fit runs last, against the aspect of the whole
  // divided block rather than of one motif, which is the line that makes the
  // two orthogonal: each cell then comes out at the motif's own proportions and
  // whatever the block does not cover reads as bare stone.
  const margined = insetRect(span, placement.margin);
  const spanWidth = span.width * (margined.sMax - margined.sMin);
  const spanHeight = span.height * (margined.tMax - margined.tMin);
  const tiling = placement.tiling;

  const grid = tiling?.mode === "grid"
    ? resolveGridLayout(spanWidth, spanHeight, tiling.cellMin, tiling.cellMax)
    : null;
  const repeat = grid
    ? { s: grid.columns, t: grid.rows }
    : resolveDecalRepeat(spanWidth, spanHeight, placement.aspect, tiling);

  // A grid always contains, because its cells have to be square for a glyph to
  // sit in one undistorted. Elsewhere a fit shapes a single instance, so it is
  // consulted only where the placement resolved to one — which with no tiling
  // is always, and is why this returns exactly what it used to.
  const contained = grid !== null
    ? containRect(span, margined, grid.columns / grid.rows)
    : placement.fit === "contain" && repeat.s === 1 && repeat.t === 1
      ? containRect(span, margined, placement.aspect)
      : margined;

  return contained && contained.sMax > contained.sMin
    && contained.tMax > contained.tMin
    ? { rect: contained, repeat, grid }
    : null;
}

/**
 * Where the engraving lands inside the slot.
 *
 * Kept as a view onto `resolveDecalPlacement` rather than folded into it: this
 * is the shape the coverage checks and the placement tests read, and a single
 * instance's rectangle is a question worth being able to ask on its own.
 */
export function resolveDecalRect(
  slot: SlotRecord,
  placement: DecalPlacement,
): DecalRect | null {
  return resolveDecalPlacement(slot, placement)?.rect ?? null;
}

/**
 * How many times a motif repeats across a field, from its own proportions.
 *
 * The tile is derived rather than typed. One assignment resolves every slot its
 * feature matches — a mass's band wall publishes both a 7.68 metre panel and a
 * 0.42 metre strip — and a stated size would be right for one of them and wrong
 * for the rest. Taking the tile from the slot's binding axis and the layer's own
 * aspect makes the motif the same shape everywhere and lets the count be
 * whatever that costs.
 *
 * The guards are written `!(x > 0)` rather than `x <= 0` so a NaN that reached
 * here from a config that slipped past validation returns one repeat instead of
 * propagating into a vertex attribute, where it would blank a whole draw call
 * with nothing to point at.
 */
export function resolveDecalRepeat(
  spanWidth: number,
  spanHeight: number,
  aspect: number,
  tiling?: DecalTiling,
): DecalRepeat {
  if (
    !tiling
    || (tiling.mode !== "horizontal" && tiling.mode !== "vertical")
    || !(tiling.scale > 0)
    || !(spanWidth > 0)
    || !(spanHeight > 0)
  ) {
    return NO_DECAL_REPEAT;
  }

  // A layer with no stated aspect is treated as square rather than as
  // degenerate. The catalog should never publish one, and a division by zero
  // here would surface three frames later as a missing decal.
  const motif = aspect > 0 ? aspect : 1;

  if (tiling.mode === "horizontal") {
    return {
      s: repeatCount(spanWidth, spanHeight * motif * tiling.scale),
      t: 1,
    };
  }

  return {
    s: 1,
    t: repeatCount(spanHeight, (spanWidth / motif) * tiling.scale),
  };
}

/**
 * How to divide a field into square cells, from a size range alone.
 *
 * The largest cell that fits wins, and how much of the field it covers only
 * breaks a tie. That ordering is the whole rule: the maximum is the control
 * that decides the grid and the minimum is a floor under it, so raising the
 * maximum always means bigger, fewer glyphs.
 *
 * It has to be that way round. Coverage on its own is not a criterion, because
 * smaller squares always tile a rectangle more completely — scoring on it first
 * would quietly mean "the smallest cell allowed" and the minimum would become
 * the operative control instead. As a tie-break it does exactly what is wanted:
 * a two by one metre field takes one metre cells either way, and covering all
 * of it rather than half is what picks two across.
 *
 * There is no ratio bias in it and none is needed. A field a tenth taller than
 * it is wide takes a single one-metre cell, because a column of two would have
 * to halve the cell to fit — so the near-square slot a bias was meant to protect
 * never reaches for a vertical grid in the first place.
 *
 * The search is one dimensional: for any column count the best row count is the
 * one that makes the cell squarest, so only the columns have to be walked, and
 * then the same again with the axes swapped.
 */
export function resolveGridLayout(
  spanWidth: number,
  spanHeight: number,
  cellMin: number,
  cellMax: number,
): DecalGrid {
  if (!(spanWidth > 0) || !(spanHeight > 0)) {
    return { columns: 1, rows: 1 };
  }

  const low = Math.max(0, Math.min(cellMin, cellMax));
  const high = Math.max(low, cellMax);
  let best: DecalGrid = { columns: 1, rows: 1 };
  let bestRank = -Infinity;
  let bestCoverage = -Infinity;
  let legalFound = false;

  const consider = (columns: number, rows: number): void => {
    if (columns < 1 || rows < 1 || columns * rows > MAX_GRID_CELLS) {
      return;
    }

    const cell = Math.min(spanWidth / columns, spanHeight / rows);
    const legal = cell >= low && cell <= high;

    // A field thinner than the smallest cell has no legal division at all, so
    // rather than refusing to place anything the nearest cell to the range wins
    // — and any legal candidate always beats any illegal one.
    if (legalFound && !legal) {
      return;
    }

    const coverage = (columns * rows * cell * cell) / (spanWidth * spanHeight);
    const rank = legal
      ? cell
      : -Math.abs(Math.log(cell / clamp(cell, low, high)));

    if (
      (legal && !legalFound)
      || rank > bestRank + SCORE_EPSILON
      || (Math.abs(rank - bestRank) <= SCORE_EPSILON
        && coverage > bestCoverage + SCORE_EPSILON)
    ) {
      best = { columns, rows };
      bestRank = rank;
      bestCoverage = coverage;
      legalFound = legalFound || legal;
    }
  };

  for (let columns = 1; columns <= MAX_GRID_CELLS; columns += 1) {
    consider(columns, clamp(Math.round((spanHeight * columns) / spanWidth), 1, MAX_GRID_CELLS));
  }

  for (let rows = 1; rows <= MAX_GRID_CELLS; rows += 1) {
    consider(clamp(Math.round((spanWidth * rows) / spanHeight), 1, MAX_GRID_CELLS), rows);
  }

  return best;
}

/**
 * One rectangle per grid cell, in reading order: top row first, left to right.
 *
 * Reading order rather than the parameter space's own, because a sequential
 * glyph run is a text and a text starts at the top. `t` runs up the slot, so the
 * first row is the last one along it.
 *
 * The gutter is taken here rather than baked into a map. Each cell owns its own
 * UV square, so insetting the rectangle leaves bare stone exactly where the
 * inset was — no padded texture, no second derivation, and the same layer serves
 * a gutter of zero and a gutter of a third.
 */
export function gridCellRects(
  rect: DecalRect,
  grid: DecalGrid,
  gutter: number,
): DecalRect[] {
  const inset = clamp(gutter, 0, MAX_GUTTER_FRACTION);
  const cellS = (rect.sMax - rect.sMin) / grid.columns;
  const cellT = (rect.tMax - rect.tMin) / grid.rows;
  const rects: DecalRect[] = [];

  for (let row = 0; row < grid.rows; row += 1) {
    const top = grid.rows - 1 - row;

    for (let column = 0; column < grid.columns; column += 1) {
      const sMin = rect.sMin + column * cellS;
      const tMin = rect.tMin + top * cellT;
      rects.push({
        sMin: sMin + cellS * inset,
        sMax: sMin + cellS * (1 - inset),
        tMin: tMin + cellT * inset,
        tMax: tMin + cellT * (1 - inset),
      });
    }
  }

  return rects;
}

/**
 * Shrinks a rectangle to a motif's proportions, centred on where it was.
 *
 * Public because a grid's cells are contained one at a time: the cell is square
 * in metres and the glyph in it keeps whatever shape it was authored as, which
 * is what "normalised to a square, never stretched" means once each cell has a
 * different glyph in it.
 */
export function containDecalRect(
  slot: SlotRecord,
  rect: DecalRect,
  aspect: number,
): DecalRect | null {
  const span = slotSpan(slot);
  return span && aspect > 0 ? containRect(span, rect, aspect) : rect;
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
  repeat: DecalRepeat = NO_DECAL_REPEAT,
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
    repeat,
  };
}

export function resolveDecalQuad(
  slot: SlotRecord,
  frame: LocalFrame,
  placement: DecalPlacement,
): EngravingDecalQuad | null {
  const placed = resolveDecalPlacement(slot, placement);
  return placed
    ? decalQuadFromRect(slot, frame, placed.rect, placement.offset, placed.repeat)
    : null;
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
  const engravingTileUvs = new Float32Array(vertexCount * 2);
  const indices = new Uint32Array(triangleCount * 3);
  let vertex = 0;
  let index = 0;

  quads.forEach((quad, quadIndex) => {
    const { columns, rows } = grids[quadIndex]!;
    const base = vertex;
    const { s: repeatS, t: repeatT } = quad.repeat;
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
        // The base UVs stay slot-local zero to one whatever the repeat is. No
        // shader reads them now — the blotching that used to is anchored to the
        // wall instead — but they are what the tiled pair is derived from, and
        // the suite holds the two to that relationship. Nothing about a decal's
        // placement is easy to see once it is wrong, so the reference stays.
        engravingTileUvs[vertex * 2] = s * repeatS;
        engravingTileUvs[vertex * 2 + 1] = t * repeatT;
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
  geometry.setAttribute(
    "engravingTileUv",
    new THREE.BufferAttribute(engravingTileUvs, 2),
  );
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

/** Nor may a gutter, or a cell would invert. */
const MAX_GUTTER_FRACTION = 0.45;

/** Coverage differences below this are a tie, and the larger cell breaks it. */
const SCORE_EPSILON = 1e-9;

interface SlotSpan {
  readonly width: number;
  readonly height: number;
}

/**
 * The slot's own extent in metres, or null if it has collapsed.
 *
 * The mean width is what the margin and every span below are measured against.
 * A slot on a battered face is a trapezoid, and insetting each edge by a true
 * constant distance would round its corners into something that is no longer a
 * trapezoid; insetting by a constant fraction keeps the shape and puts the
 * margin exactly right at mid-height, drifting by the taper ratio towards the
 * ends. On the batters this project builds that is a few per cent of the
 * margin, which is not a distance anyone can see.
 */
function slotSpan(slot: SlotRecord): SlotSpan | null {
  const width = (slot.extent.uBottom + slot.extent.uTop) / 2;
  const height = slot.extent.v;
  return width > 0 && height > 0 ? { width, height } : null;
}

function insetRect(span: SlotSpan, margin: number): DecalRect {
  const inset = Math.max(0, margin);
  const insetS = clamp(inset / span.width, 0, MAX_MARGIN_FRACTION);
  const insetT = clamp(inset / span.height, 0, MAX_MARGIN_FRACTION);

  return {
    sMin: insetS,
    sMax: 1 - insetS,
    tMin: insetT,
    tMax: 1 - insetT,
  };
}

/**
 * The engraving is shrunk to fit rather than letterboxed inside the full
 * rectangle. Letterboxing would run the engraving's own UVs outside zero to one,
 * which needs clamped sampling and a blank border row in every layer; shrinking
 * is exact and needs neither. It also leaves no seam, because the stone the
 * decal no longer covers is dressed from the same material at the same UVs.
 */
function containRect(
  span: SlotSpan,
  rect: DecalRect,
  aspect: number,
): DecalRect {
  if (!(aspect > 0)) {
    return rect;
  }

  const spanWidth = span.width * (rect.sMax - rect.sMin);
  const spanHeight = span.height * (rect.tMax - rect.tMin);

  if (!(spanWidth > 0) || !(spanHeight > 0)) {
    return rect;
  }

  const spanAspect = spanWidth / spanHeight;
  return spanAspect > aspect
    ? shrinkS(rect, aspect / spanAspect)
    : shrinkT(rect, spanAspect / aspect);
}

/**
 * Never below one, and never rounded.
 *
 * Not rounded because the far edge cutting the last motif is the intended
 * behaviour, and never below one because a fraction of a single motif is a
 * shape with no beginning — a slot too narrow for one repeat is better served by
 * one squeezed into it, which is what the untiled placement would have done.
 */
function repeatCount(span: number, tile: number): number {
  if (!(span > 0) || !(tile > 0)) {
    return 1;
  }

  return clamp(span / tile, 1, MAX_TILE_REPEATS);
}

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
