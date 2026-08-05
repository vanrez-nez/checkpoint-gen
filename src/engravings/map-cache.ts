import type { EngravingLayer } from "./document";
import { EngravingMapWorker } from "./map-worker";
import { ENGRAVING_NORMAL_RADIUS, engravingTargetSize } from "./resolution";
import {
  createEngravingTextures,
  disposeEngravingTextures,
  type EngravingTextures,
} from "./textures";

/**
 * How many derived layers to keep uploaded.
 *
 * This used to be twelve, on the reasoning that a structure dresses at most one
 * engraving per slot-bearing feature and the widest family declares six. A glyph
 * grid ends that: a single feature can name every glyph in the catalog, so
 * twelve would evict layers that are on screen and re-derive them on the next
 * frame — the one failure this cache exists to prevent.
 *
 * Sized above the catalog instead, so within one project file nothing resident
 * is ever evicted and the ceiling is what the catalog costs rather than what the
 * count allows. That cost is the user's to set: the resolution tier in
 * `resolution.ts` puts the whole catalog at 2.61 MB, 5.46 MB or 18.12 MB.
 */
const MAX_CACHED_LAYERS = 32;

interface CacheEntry {
  readonly textures: Promise<EngravingTextures>;
  /** Set once resolved. Only a settled entry can be safely evicted. */
  resolved: EngravingTextures | null;
}

/**
 * Derived engraving maps, keyed by what actually determines them.
 *
 * The key deliberately excludes everything the shader can vary at no cost —
 * normal strength, occlusion intensity, moisture — so dragging any of those
 * rebuilds a node graph rather than a megabyte of texture. It includes the
 * target size and the normal radius, because those change the pixels.
 *
 * Entries are stored as promises rather than results, so a second request for a
 * layer already being derived joins the first instead of queueing a duplicate
 * behind it. That is the same shape the material runtimes use for documents.
 */
export class EngravingMapCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly worker = new EngravingMapWorker();

  ensure(
    layer: EngravingLayer,
    maxDimension?: number,
  ): Promise<EngravingTextures> {
    const target = engravingTargetSize(layer.width, layer.height, maxDimension);
    // The budget reaches the key through the size it produced rather than by
    // name, which is what lets two tiers of the same layer coexist and makes
    // returning to a tier already derived free.
    const key = `${layer.id}|${target.width}x${target.height}`
      + `|r${ENGRAVING_NORMAL_RADIUS}`;
    const cached = this.entries.get(key);

    if (cached) {
      // Re-inserting moves the key to the end of the iteration order, which is
      // what makes the eviction below least-recently-used rather than oldest.
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached.textures;
    }

    const entry: CacheEntry = {
      resolved: null,
      textures: this.worker.request({
        // Sliced because the worker takes ownership of what it is handed, and
        // the catalog has to survive being asked again.
        cellLevels: layer.cellLevels.slice(),
        heightByLevel: layer.heightByLevel.slice(),
        sourceWidth: layer.width,
        sourceHeight: layer.height,
        targetWidth: target.width,
        targetHeight: target.height,
        pixelCornerRadius: layer.pixelCornerRadius,
        normalRadius: ENGRAVING_NORMAL_RADIUS,
      }).then((maps) => {
        const textures = createEngravingTextures(maps);
        entry.resolved = textures;
        return textures;
      }).catch((error: unknown) => {
        // A layer that cannot be derived must not stay cached as a permanent
        // failure: the next attempt should be allowed to try again.
        this.entries.delete(key);
        throw error;
      }),
    };

    this.entries.set(key, entry);
    this.evictExcess();
    return entry.textures;
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      disposeEngravingTextures(entry.resolved);
    }

    this.entries.clear();
    this.worker.dispose();
  }

  private evictExcess(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= MAX_CACHED_LAYERS) {
        return;
      }

      // Never evict a layer still being derived. Disposing its textures out
      // from under the waiter would hand the scene a texture with no GPU
      // resource behind it, which fails far away from the cause.
      if (!entry.resolved) {
        continue;
      }

      disposeEngravingTextures(entry.resolved);
      this.entries.delete(key);
    }
  }
}
