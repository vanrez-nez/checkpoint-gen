import type * as THREE from "three";
import {
  validateActiveStructureConfig,
  type StructureConfig,
} from "../config/structure-config";
import { mergeParts } from "../geometry/merge-parts";
import {
  emptyCompositionAnchors,
  type CompositionAnchors,
  type GeometryPart,
  type PartSection,
  type PartStats,
} from "../geometry/part";
import type { DetailLevel } from "./kernel/detail";
import type { StructureGraph } from "./kernel/graph";
import { getStructure } from "./registry";

export interface CompositionResult {
  /** One geometry for the whole structure, with coalesced material groups. */
  readonly geometry: THREE.BufferGeometry;
  readonly anchors: CompositionAnchors;
  readonly sections: Readonly<Record<PartSection, PartStats>>;
  readonly totals: PartStats;
  /** Time spent validating, generating requested sections, and merging them. */
  readonly generationMs: number;
  /** The semantic layer, for structures that resolve one. */
  readonly graph: StructureGraph | null;
  /** The level this composition was generated at. */
  readonly detail: DetailLevel;
}

/**
 * Turns a config into a single geometry, caching parts per section and level.
 *
 * Regenerating everything on every slider would roughly double the cost of the
 * most-dragged controls, so callers say which sections their change actually
 * invalidated (see SECTIONS_BY_SCOPE) and the rest are reused from cache.
 *
 * The caller states what went *stale*, not what to build. What to build is
 * derived here, as whatever is missing at the level being composed. That is
 * what lets one argument serve three cases that would otherwise need telling
 * apart: a cold level misses everything, a config change misses exactly what
 * was evicted, and returning to a level already built misses nothing.
 *
 * Eviction always sweeps every level, and `evictSection` is the only way to
 * remove anything. A layout change while sitting on a coarse level has to
 * invalidate the full level too, or returning to it later would serve geometry
 * built from configuration the user has since changed. There is deliberately
 * no function that evicts one level, so that mistake cannot be written.
 *
 * Holding several levels is cheap in the way that matters: a part's geometry is
 * never attached to a `Mesh`, so a warm level costs RAM and no VRAM. Only the
 * merged result the scene takes is ever uploaded, and there is only ever one.
 */
export class StructureComposer {
  private readonly cache = new Map<DetailLevel, Map<PartSection, GeometryPart[]>>();
  private anchors: CompositionAnchors = emptyCompositionAnchors();
  private graph: StructureGraph | null = null;
  private builtTypeId: string | null = null;

  build(
    config: StructureConfig,
    invalidated?: Iterable<PartSection>,
  ): CompositionResult {
    const startedAt = performance.now();
    // Validation runs before cache invalidation, so a bad parameter combination
    // cannot discard the last renderable composition or reach the renderer.
    validateActiveStructureConfig(config);
    const definition = getStructure(config.typeId);
    const detail = config.view.detailLevel;
    // A type switch invalidates every cached part regardless of what the caller
    // asked for, since the parts belong to the previous type's layout. The old
    // type's sections are dropped wholesale rather than by name, because the
    // incoming type may not declare them at all.
    const typeChanged = this.builtTypeId !== config.typeId;

    if (typeChanged) {
      this.disposeAll();
    }

    for (const section of invalidated ?? definition.sections) {
      this.evictSection(section);
    }

    this.builtTypeId = config.typeId;
    let bucket = this.cache.get(detail);

    if (!bucket) {
      bucket = new Map<PartSection, GeometryPart[]>();
      this.cache.set(detail, bucket);
    }

    // Presence is the key existing, never the array being non-empty: a section
    // may legitimately produce nothing — fire bowls with bowls disabled — and
    // reading emptiness as absence would regenerate it on every single build.
    const requested = new Set<PartSection>(
      definition.sections.filter((section) => !bucket.has(section)),
    );

    const layout = config.layouts[config.typeId] ?? definition.cloneLayout();
    config.layouts[config.typeId] = layout;
    const stone = config.stones[config.typeId];
    const bevel = config.bevels[config.typeId];

    if (!stone || !bevel) {
      throw new Error(`Missing surface config for structure "${config.typeId}".`);
    }

    const result = definition.build({
      layout,
      stone,
      bevel,
      pillar: config.pillar,
      fireBowl: config.fireBowl,
      debugSlots: config.view.slotDebug,
      detail,
      sections: requested,
    });

    // Seeding only. Whatever these sections held was already disposed by
    // `evictSection`, so nothing here can drop a geometry still reachable from
    // another level, and nothing can be disposed twice.
    for (const section of requested) {
      bucket.set(section, []);
    }

    for (const part of result.parts) {
      const parts = bucket.get(part.section);

      if (!parts) {
        throw new Error(
          `Structure "${config.typeId}" returned a "${part.section}" part that was not requested.`,
        );
      }

      // Stamped from the cache key rather than authored by the family, so the
      // tag cannot disagree with the level the part is filed under. A shallow
      // copy, never an assignment: a cached part is immutable once built.
      parts.push({ ...part, detail });
    }

    this.anchors = result.anchors;
    this.graph = result.graph ?? null;

    const ordered = definition.sections.flatMap(
      (section) => bucket.get(section) ?? [],
    );
    const merged = mergeParts(ordered, definition.sections);

    return {
      geometry: merged.geometry,
      anchors: this.anchors,
      sections: merged.sections,
      totals: merged.totals,
      generationMs: performance.now() - startedAt,
      graph: this.graph,
      detail,
    };
  }

  getAnchors(): CompositionAnchors {
    return this.anchors;
  }

  getGraph(): StructureGraph | null {
    return this.graph;
  }

  dispose(): void {
    this.disposeAll();
    this.anchors = emptyCompositionAnchors();
    this.graph = null;
    this.builtTypeId = null;
  }

  private disposeAll(): void {
    for (const bucket of this.cache.values()) {
      for (const parts of bucket.values()) {
        for (const part of parts) {
          part.geometry.dispose();
        }
      }
    }

    this.cache.clear();
  }

  /**
   * Drops a section at every level, disposing what it held.
   *
   * The sweep is unconditional by design. A section goes stale because the
   * configuration behind it changed, and that is true of every level's copy at
   * once — evicting only the level on screen would leave the others to surface
   * later, built from configuration that no longer exists.
   */
  private evictSection(section: PartSection): void {
    for (const bucket of this.cache.values()) {
      for (const part of bucket.get(section) ?? []) {
        part.geometry.dispose();
      }

      bucket.delete(section);
    }
  }
}
