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
 * How much texture memory the engravings may spend, as a ceiling per layer.
 *
 * The bound above was set when a layer was assigned once per feature and
 * stretched across a whole slot. A glyph grid breaks both halves of that: one
 * feature can name fifteen layers at once, and each of them lands in a cell a
 * few centimetres across rather than on a whole wall. Measured over the shipped
 * catalog, at six bytes a texel plus mip chain:
 *
 * ```
 *  cap   15 glyphs   whole catalog   texels per cell   derive, 15 glyphs
 *  384    16.01 MB        18.12 MB               7.4              ~25.5 s
 *  192     3.99 MB         5.46 MB               3.7               ~6.4 s
 *  128     1.77 MB         2.61 MB               2.5               ~2.8 s
 * ```
 *
 * The time column is the one that decides the default. Derivation is quadratic
 * in this number and runs on a single worker, so the ceiling is not only what a
 * pool costs to hold but what it costs to appear at all.
 *
 * `high` is the original value exactly, so nothing that was tuned against it
 * has moved. `medium` is the default because the comment above already records
 * that 384 resolves a common glyph at over seven texels per cell, which is more
 * than the corner rounding — the only sub-cell detail these layers carry — can
 * use; 192 still clears it.
 */
export const ENGRAVING_RESOLUTION_TIERS = {
  low: 128,
  medium: 192,
  high: ENGRAVING_MAX_DIMENSION,
} as const;

export type EngravingResolution = keyof typeof ENGRAVING_RESOLUTION_TIERS;

/** Label to value, in the shape `ListControlSpec.options` wants. */
export const ENGRAVING_RESOLUTION_OPTIONS: Readonly<
  Record<string, EngravingResolution>
> = {
  Low: "low",
  Medium: "medium",
  High: "high",
};

export const DEFAULT_ENGRAVING_RESOLUTION: EngravingResolution = "medium";

export function engravingResolutionDimension(
  resolution: EngravingResolution,
): number {
  return ENGRAVING_RESOLUTION_TIERS[resolution];
}

/**
 * How many taps the sampler may take when a layer is seen edge-on.
 *
 * A tiled band is the one thing in this project whose two UV derivatives differ
 * by an order of magnitude — a hundred and forty repeats along a twenty-metre
 * cornice against one up its hundred and sixty millimetres. Trilinear alone
 * picks its level from the larger of the two and blurs the whole band to its
 * mean at exactly the grazing angle a running band is meant to be read from.
 *
 * It belongs here rather than beside the upload because it is a sampling
 * decision, and it deliberately stays out of the map cache's key: it changes
 * the sampler, not a single texel.
 */
export const ENGRAVING_ANISOTROPY = 4;

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
  maxDimension: number = ENGRAVING_MAX_DIMENSION,
): EngravingTargetSize {
  const longest = Math.max(1, width, height);
  // The floor still wins over the ceiling, so a four-by-six pattern keeps a
  // usable mip chain at every tier rather than collapsing with the budget.
  const scale = Math.min(
    Math.max(ENGRAVING_PIXELS_PER_CELL, ENGRAVING_MIN_DIMENSION / longest),
    Math.max(ENGRAVING_MIN_DIMENSION, maxDimension) / longest,
  );

  return {
    width: alignToFour(width * scale),
    height: alignToFour(height * scale),
  };
}

function alignToFour(value: number): number {
  return Math.max(4, Math.round(value / 4) * 4);
}
