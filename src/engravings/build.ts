import type * as THREE from "three";
import type { MaterialSurfaceId } from "../config/material-palette";
import type { SlotFeatureSpec } from "../structure/definition";
import { allSlots, patchIndex, type StructureGraph } from "../structure/kernel/graph";
import { engravingCatalog } from "./catalog";
import { NO_ENGRAVING, type StructureEngravings } from "./config";
import {
  DECAL_NORMAL_OFFSET,
  mergeDecalQuads,
  resolveDecalQuad,
  type EngravingDecalQuad,
} from "./decal-geometry";
import type { EngravingLayer } from "./document";

export interface EngravingDecalBatch {
  readonly layer: EngravingLayer;
  readonly hostSurface: MaterialSurfaceId;
  readonly geometry: THREE.BufferGeometry;
  /** How many slots this batch covers. Reported, never used for rendering. */
  readonly slotCount: number;
}

/**
 * Turns a resolved structure and its engraving choices into meshes to build.
 *
 * Entirely synchronous and entirely a reader: it takes the published slot table
 * and the patches those slots name, and produces geometry. Nothing here touches
 * the graph, the mesh, or the GPU — which is what lets the same function serve
 * all four families without knowing about any of them.
 *
 * Quads are gathered by layer and host surface rather than by feature. Two
 * features engraved with the same motif on the same stone need exactly the same
 * material, so batching them together is what keeps a hall with hundreds of
 * pier panels down to a handful of draw calls.
 */
export function buildEngravingDecalBatches(
  graph: StructureGraph | null,
  features: readonly SlotFeatureSpec<object>[],
  engravings: StructureEngravings,
  layout: object | null,
): EngravingDecalBatch[] {
  if (!graph) {
    return [];
  }

  const assigned = features.filter((feature) => {
    const document = engravings[feature.id]?.document;
    return document !== undefined && document !== NO_ENGRAVING;
  });

  if (assigned.length === 0) {
    return [];
  }

  const catalog = engravingCatalog();
  const patches = patchIndex(graph);
  const slots = allSlots(graph);
  const quadsByBatch = new Map<string, {
    layer: EngravingLayer;
    hostSurface: MaterialSurfaceId;
    quads: EngravingDecalQuad[];
  }>();

  for (const feature of assigned) {
    const assignment = engravings[feature.id]!;
    const layer = catalog.layers.get(assignment.document);

    if (!layer) {
      // The project file is rewritten by another program, so a saved choice can
      // outlive the layer it named. Validation rejects that at the pane; a
      // reader reached anyway just leaves the slots bare.
      continue;
    }

    // A decal stands off the stone, which is not always the patch: an applied
    // moulding is published against the face it was laid on.
    const offset = DECAL_NORMAL_OFFSET
      + (layout ? feature.standOff?.(layout) ?? 0 : 0);
    const key = `${layer.id}|${feature.surface}`;
    let batch = quadsByBatch.get(key);

    if (!batch) {
      batch = { layer, hostSurface: feature.surface, quads: [] };
      quadsByBatch.set(key, batch);
    }

    for (const slot of slots) {
      // A slot whose stone is gone carries no engraving. The same rule the
      // debug tint applies, and for the same reason: there is no face left.
      if (slot.condition === "lost" || !feature.matches(slot)) {
        continue;
      }

      const patch = patches.get(slot.patchId);

      if (!patch) {
        continue;
      }

      const quad = resolveDecalQuad(slot, patch.frame, {
        fit: assignment.fit,
        margin: assignment.margin,
        aspect: layer.width / layer.height,
        offset,
      });

      if (quad) {
        batch.quads.push(quad);
      }
    }
  }

  const batches: EngravingDecalBatch[] = [];

  for (const batch of quadsByBatch.values()) {
    const geometry = mergeDecalQuads(batch.quads);

    if (geometry) {
      batches.push({
        layer: batch.layer,
        hostSurface: batch.hostSurface,
        geometry,
        slotCount: batch.quads.length,
      });
    }
  }

  return batches;
}

