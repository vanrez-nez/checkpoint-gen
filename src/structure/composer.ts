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
}

/**
 * Turns a config into a single geometry, caching parts per section.
 *
 * Regenerating everything on every slider would roughly double the cost of the
 * most-dragged controls, so callers pass the sections their change actually
 * invalidated (see SECTIONS_BY_SCOPE) and the rest are reused from cache.
 */
export class StructureComposer {
  private readonly cache = new Map<PartSection, GeometryPart[]>();
  private anchors: CompositionAnchors = emptyCompositionAnchors();
  private graph: StructureGraph | null = null;
  private builtTypeId: string | null = null;

  build(
    config: StructureConfig,
    sections?: Iterable<PartSection>,
  ): CompositionResult {
    const startedAt = performance.now();
    // Validation runs before cache invalidation, so a bad parameter combination
    // cannot discard the last renderable composition or reach the renderer.
    validateActiveStructureConfig(config);
    const definition = getStructure(config.typeId);
    // A type switch invalidates every cached part regardless of what the caller
    // asked for, since the parts belong to the previous type's layout. The old
    // type's sections are dropped wholesale rather than by name, because the
    // incoming type may not declare them at all.
    const typeChanged = this.builtTypeId !== config.typeId;

    if (typeChanged) {
      this.disposeAll();
    }

    const requested = typeChanged
      ? new Set<PartSection>(definition.sections)
      : new Set<PartSection>(sections ?? definition.sections);
    this.builtTypeId = config.typeId;

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
      sections: requested,
    });

    for (const section of requested) {
      this.disposeSection(section);
      this.cache.set(section, []);
    }

    for (const part of result.parts) {
      const bucket = this.cache.get(part.section);

      if (!bucket) {
        throw new Error(
          `Structure "" returned a "${part.section}" part that was not requested.`,
        );
      }

      bucket.push(part);
    }

    this.anchors = result.anchors;
    this.graph = result.graph ?? null;

    const ordered = definition.sections.flatMap(
      (section) => this.cache.get(section) ?? [],
    );
    const merged = mergeParts(ordered, definition.sections);

    return {
      geometry: merged.geometry,
      anchors: this.anchors,
      sections: merged.sections,
      totals: merged.totals,
      generationMs: performance.now() - startedAt,
      graph: this.graph,
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
    for (const section of [...this.cache.keys()]) {
      this.disposeSection(section);
    }

    this.cache.clear();
  }

  private disposeSection(section: PartSection): void {
    for (const part of this.cache.get(section) ?? []) {
      part.geometry.dispose();
    }

    this.cache.delete(section);
  }
}
