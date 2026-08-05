import { engravingCatalog } from "./catalog";
import type { EngravingGlyphOrder } from "./decal-geometry";
import type { EngravingLayer } from "./document";
import { createRandom, hashSeed } from "../geometry/random";

/**
 * Which engravings a grid draws from, written as text rather than chosen from a
 * list.
 *
 * A list would be the idiomatic control and is the wrong one here. Every other
 * choice in this project is a closed set the table can name, but a grid names
 * *several* layers out of a catalog another program rewrites, and it has to be
 * able to say "all of them" without that meaning "the fifteen that existed when
 * this was typed". So the field is a small grammar instead:
 *
 * ```
 *   glyph-sun, glyph-eagle     two layers, in that order
 *   glyph-*                    every layer whose id starts with `glyph-`
 *   glyph-*, pattern-c         a family, then one more
 *   (empty)                    every layer in the catalog
 * ```
 *
 * Tokens expand where they were written rather than being sorted into catalog
 * order, because with a sequential arrangement the pool *is* the sequence and
 * quietly reordering it would carve something other than what was asked for.
 * Only a wildcard's own expansion follows the catalog, since it has no order of
 * its own. Repeats collapse to their first appearance.
 *
 * A named layer the catalog no longer carries is a rejection rather than a
 * silent omission — the same stance the single-document choice takes, and for
 * the same reason: the project file is a build asset another program rewrites,
 * so a saved selection can outlive the layer it named, and a grid that quietly
 * dropped a glyph would read as a glyph that failed to carve.
 */
export function resolveGlyphPool(
  spec: string,
  name = "Engraving glyphs",
): readonly EngravingLayer[] {
  const catalog = engravingCatalog();

  // An empty catalog rejects nothing, because there is nothing to reject
  // against. The project file is loaded from disk after this module is
  // evaluated, and every default has to validate before that happens — the same
  // reason the document list carries `None` as a real value. A load that failed
  // then degrades to bare stone rather than to a config that cannot be built.
  if (catalog.ids.length === 0) {
    return [];
  }

  const tokens = spec.split(",").map((token) => token.trim()).filter(Boolean);
  const ids = tokens.length === 0 ? [...catalog.ids] : expand(tokens, name);
  const pool: EngravingLayer[] = [];
  const seen = new Set<string>();

  for (const id of ids) {
    const layer = catalog.layers.get(id);

    if (layer && !seen.has(id)) {
      seen.add(id);
      pool.push(layer);
    }
  }

  if (pool.length === 0) {
    throw new RangeError(`${name} names no engraving that exists.`);
  }

  return pool;
}

/**
 * Hands out one glyph per cell.
 *
 * Stateful because neither arrangement is a function of the cell alone.
 * `sequential` runs one counter across every slot the feature matches, so a
 * colonnade reads as a single text rather than as one panel repeated; `random`
 * reseeds per slot, so a panel is stable under every rebuild that leaves its
 * slot id alone and only re-rolls when the layout actually moves.
 *
 * The random stream is drawn in order rather than indexed per cell. A stream
 * derived by name is the seeding law the rest of the project follows, and
 * drawing from it is what keeps neighbouring cells independent instead of
 * relying on a hash to scatter adjacent integers.
 */
export interface GlyphPicker {
  /** Starts a slot. Required before `next`, and what reseeds a random run. */
  beginSlot(slotId: string): void;
  next(): EngravingLayer;
}

export function createGlyphPicker(
  pool: readonly EngravingLayer[],
  order: EngravingGlyphOrder,
): GlyphPicker {
  if (pool.length === 0) {
    throw new RangeError("A glyph picker needs at least one engraving.");
  }

  let cursor = 0;
  let random: (() => number) | null = null;

  return {
    beginSlot(slotId: string): void {
      if (order === "random") {
        random = createRandom(hashSeed(0, `engraving-grid:${slotId}`));
      }
    },
    next(): EngravingLayer {
      if (order === "random") {
        const draw = random ? random() : 0;
        return pool[Math.min(pool.length - 1, Math.floor(draw * pool.length))]!;
      }

      const layer = pool[cursor % pool.length]!;
      cursor += 1;
      return layer;
    },
  };
}

function expand(tokens: readonly string[], name: string): string[] {
  const catalog = engravingCatalog();
  const ids: string[] = [];

  for (const token of tokens) {
    if (!token.includes("*")) {
      if (!catalog.layers.has(token)) {
        throw new RangeError(`${name} names no engraving "${token}".`);
      }

      ids.push(token);
      continue;
    }

    const pattern = wildcard(token);
    const matched = catalog.ids.filter((id) => pattern.test(id));

    if (matched.length === 0) {
      throw new RangeError(`${name} pattern "${token}" matches no engraving.`);
    }

    ids.push(...matched);
  }

  return ids;
}

/**
 * A glob, anchored, with everything but `*` taken literally. Escaping first and
 * substituting after is what keeps a `.` or a `+` in a future layer id from
 * quietly becoming a metacharacter.
 */
function wildcard(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.split("\\*").join(".*")}$`);
}
