import type * as THREE from "three";
import type { CheckpointConfig } from "../config/checkpoint-config";
import { mergeParts } from "../geometry/merge-parts";
import {
  PART_SECTIONS,
  emptyCompositionAnchors,
  type CompositionAnchors,
  type GeometryPart,
  type PartSection,
  type PartStats,
} from "../geometry/part";
import { getCheckpointType } from "./registry";

export interface CompositionResult {
  /** One geometry for the whole checkpoint, with coalesced material groups. */
  readonly geometry: THREE.BufferGeometry;
  readonly anchors: CompositionAnchors;
  readonly sections: Readonly<Record<PartSection, PartStats>>;
  readonly totals: PartStats;
}

/**
 * Turns a config into a single geometry, caching parts per section.
 *
 * Regenerating everything on every slider would roughly double the cost of the
 * most-dragged controls, so callers pass the sections their change actually
 * invalidated (see SECTIONS_BY_SCOPE) and the rest are reused from cache.
 */
export class CheckpointComposer {
  private readonly cache = new Map<PartSection, GeometryPart[]>();
  private anchors: CompositionAnchors = emptyCompositionAnchors();
  private builtTypeId: string | null = null;

  build(
    config: CheckpointConfig,
    sections?: Iterable<PartSection>,
  ): CompositionResult {
    const definition = getCheckpointType(config.typeId);
    // A type switch invalidates every cached part regardless of what the caller
    // asked for, since the parts belong to the previous type's layout.
    const requested = this.builtTypeId === config.typeId
      ? new Set<PartSection>(sections ?? PART_SECTIONS)
      : new Set<PartSection>(PART_SECTIONS);
    this.builtTypeId = config.typeId;

    const layout = config.layouts[config.typeId] ?? definition.cloneLayout();
    config.layouts[config.typeId] = layout;

    const result = definition.build({
      layout,
      stone: config.stone,
      bevel: config.bevel,
      pillar: config.pillar,
      fireBowl: config.fireBowl,
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
          `Checkpoint type "${definition.id}" returned a "${part.section}" part that was not requested.`,
        );
      }

      bucket.push(part);
    }

    this.anchors = result.anchors;

    const ordered = PART_SECTIONS.flatMap((section) => this.cache.get(section) ?? []);
    const merged = mergeParts(ordered);

    return {
      geometry: merged.geometry,
      anchors: this.anchors,
      sections: merged.sections,
      totals: merged.totals,
    };
  }

  getAnchors(): CompositionAnchors {
    return this.anchors;
  }

  dispose(): void {
    for (const section of PART_SECTIONS) {
      this.disposeSection(section);
    }

    this.cache.clear();
    this.anchors = emptyCompositionAnchors();
    this.builtTypeId = null;
  }

  private disposeSection(section: PartSection): void {
    for (const part of this.cache.get(section) ?? []) {
      part.geometry.dispose();
    }

    this.cache.delete(section);
  }
}
