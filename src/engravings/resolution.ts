/**
 * How large a map to derive for an engraving layer.
 *
 * The editor sizes its own maps for a full-screen slab preview and always lands
 * on 1024 along the longest axis. Here an engraving occupies a slot on a wall —
 * a fraction of the frame, seen from across a plaza as often as from arm's
 * length — and the maps are derived on the CPU at roughly 148 samples per
 * texel, so a fixed 1024 would spend four times the work of 512 on detail that
 * never reaches a pixel.
 *
 * The dial that matters is resolution per logical cell rather than absolute
 * size: rounded corners, which is the only sub-cell detail these layers carry,
 * are reconstructed from the cell grid, so their smoothness tracks that ratio.
 * The two bounds catch the ends — a 4 by 6 pattern would otherwise derive a map
 * too small to carry a useful mip chain, and a 110 by 110 glyph would otherwise
 * cost four seconds.
 */
export const ENGRAVING_PIXELS_PER_CELL = 12;
export const ENGRAVING_MIN_DIMENSION = 96;

/**
 * The ceiling is set from measurement rather than from what looks like a round
 * number. Derivation cost is quadratic in this, and on the machine this was
 * tuned on the largest shipped glyph took 4.0 s at 512, 1.7 s at 384, 1.1 s at
 * 320 and 0.5 s at 256. At 384 a 52-cell glyph — the common size, rather than
 * the 110-cell extreme — still resolves at over seven texels per cell, which is
 * more than the corner rounding can use. Every pattern layer is small enough to
 * be governed by the ratio above and is untouched by this bound.
 */
export const ENGRAVING_MAX_DIMENSION = 384;

/**
 * How far apart the two height samples of a normal are, in texels.
 *
 * Constant rather than a control: it participates in the map cache key, so a
 * slider on it would re-derive every assigned layer on every drag. Shading
 * intensity is exposed instead, which is the knob a user actually reaches for.
 */
export const ENGRAVING_NORMAL_RADIUS = 1;

export interface EngravingTargetSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Both axes come back as multiples of four.
 *
 * A deliberate departure from the editor, whose sizes derived from 1024 and
 * were aligned by construction. Ours are not, and an unaligned row length is
 * the classic source of a sheared texture on any backend that pads rows.
 */
export function engravingTargetSize(
  width: number,
  height: number,
): EngravingTargetSize {
  const longest = Math.max(1, width, height);
  const scale = Math.min(
    Math.max(ENGRAVING_PIXELS_PER_CELL, ENGRAVING_MIN_DIMENSION / longest),
    ENGRAVING_MAX_DIMENSION / longest,
  );

  return {
    width: alignToFour(width * scale),
    height: alignToFour(height * scale),
  };
}

function alignToFour(value: number): number {
  return Math.max(4, Math.round(value / 4) * 4);
}
