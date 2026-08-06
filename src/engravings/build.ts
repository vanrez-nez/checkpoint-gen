import type * as THREE from "three";
import type { MaterialSurfaceId } from "../config/material-palette";
import type { SlotFeatureSpec } from "../structure/definition";
import { allSlots, patchIndex, type StructureGraph } from "../structure/kernel/graph";
import { engravingCatalog } from "./catalog";
import {
  NO_ENGRAVING,
  type EngravingAssignment,
  type StructureEngravings,
} from "./config";
import {
  containDecalRect,
  DECAL_NORMAL_OFFSET,
  decalQuadFromRect,
  gridCellRects,
  mergeDecalQuads,
  NO_DECAL_REPEAT,
  resolveDecalPlacement,
  type DecalTiling,
  type EngravingDecalQuad,
} from "./decal-geometry";
import type { EngravingLayer } from "./document";
import { createGlyphPicker, resolveGlyphPool } from "./glyph-pool";

export interface EngravingDecalBatch {
  readonly layer: EngravingLayer;
  readonly hostSurface: MaterialSurfaceId;
  readonly geometry: THREE.BufferGeometry;
  /**
   * How many quads this batch covers. Reported, never used for rendering.
   *
   * Quads rather than slots, because a grid spends one per cell and a batch
   * collects the cells of one glyph out of many slots.
   */
  readonly quadCount: number;
  /**
   * The furthest any of these quads stands off the stone, in metres.
   *
   * Not a placement — the quads already carry that in their corners. It is how
   * far back the scene has to look to find the wall each one belongs to, and
   * the maximum because a batch can gather quads from two features whose stone
   * is at different depths.
   */
  readonly standOff: number;
  /**
   * Everything the decal's material needs beyond the layer and the host.
   *
   * Carried on the batch rather than looked up per surface by the scene,
   * because the batch is the only thing that knows which features actually
   * contributed to it. The scene used to resolve these by taking the strongest
   * reading across every feature on the surface — a fudge that was already
   * coarser than the batching it served, and one that a per-feature tint would
   * have made incoherent rather than merely approximate.
   */
  readonly appearance: DecalAppearance;
}

/** The per-feature half of a decal's material. */
export interface DecalAppearance {
  readonly aoIntensity: number;
  readonly normalStrength: number;
  readonly tint: string;
  /**
   * The density of the stone under this decal, read off the slot rather than
   * chosen here.
   *
   * A carving and the face it is cut into have to be dressed at one density or
   * the face reads as a differently-grained square laid on the wall. There is
   * one number, it belongs to the slot, and this is a copy of it.
   */
  readonly textureScale: number;
}

function appearanceOf(
  assignment: EngravingAssignment,
  textureScale: number,
): DecalAppearance {
  return {
    aoIntensity: assignment.aoIntensity,
    normalStrength: assignment.normalStrength,
    tint: assignment.tint,
    textureScale,
  };
}

/** Two features agreeing on all of this can share one mesh; nothing else can. */
function appearanceKey(appearance: DecalAppearance): string {
  return `${appearance.aoIntensity}|${appearance.normalStrength}`
    + `|${appearance.tint}|${appearance.textureScale}`;
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
    standOff: number;
    appearance: DecalAppearance;
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
    const tiling: DecalTiling = {
      mode: assignment.tiling,
      scale: assignment.tileScale,
      cellMin: assignment.cellMin,
      cellMax: assignment.cellMax,
      gutter: assignment.cellGutter,
    };
    // Resolved once for the feature rather than once per slot: the pool is what
    // the assignment says, and a sequential run has to keep one counter across
    // every slot the feature matches or each panel would repeat the last.
    const picker = assignment.tiling === "grid"
      ? glyphPicker(assignment.glyphs, assignment.glyphOrder)
      : null;

    if (assignment.tiling === "grid" && !picker) {
      continue;
    }

    const appearance = appearanceOf(
      assignment,
      layout ? feature.select(layout).textureScale : 1,
    );
    const push = (
      target: EngravingLayer,
      quad: EngravingDecalQuad,
      standOff: number,
    ): void => {
      const key = `${target.id}|${feature.surface}|${appearanceKey(appearance)}`;
      let batch = quadsByBatch.get(key);

      if (!batch) {
        batch = {
          layer: target,
          hostSurface: feature.surface,
          quads: [],
          standOff: 0,
          appearance,
        };
        quadsByBatch.set(key, batch);
      }

      batch.quads.push(quad);
      // How far this quad's own stone is from the patch plane, not how far the
      // feature declares. A sunk face is further away, and the scene has to
      // look that much further back to find it.
      batch.standOff = Math.max(batch.standOff, Math.abs(standOff));
    };

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

      // The patch says where the face would be; the slot says where it is. A
      // sunk face is genuinely further back, and a decal that ignored that
      // would hang the pocket's whole depth in front of the stone.
      const placedOffset = offset + slot.faceOffset;
      const placed = resolveDecalPlacement(slot, {
        fit: assignment.fit,
        margin: assignment.margin,
        aspect: layer.width / layer.height,
        offset: placedOffset,
        tiling,
      });

      if (!placed) {
        continue;
      }

      if (!placed.grid || !picker) {
        const quad = decalQuadFromRect(
          slot,
          patch.frame,
          placed.rect,
          placedOffset,
          placed.repeat,
        );

        if (quad) {
          push(layer, quad, placedOffset);
        }

        continue;
      }

      // One quad per cell, each carrying its own glyph and its own zero-to-one
      // square. Containing per cell is what normalises a glyph that was not
      // authored square: the cell is square in metres and the glyph keeps the
      // shape it was drawn as, centred in it.
      picker.beginSlot(slot.id);

      for (const cell of gridCellRects(placed.rect, placed.grid, tiling.gutter)) {
        const glyph = picker.next();
        const rect = containDecalRect(slot, cell, glyph.width / glyph.height);
        const quad = rect
          && decalQuadFromRect(slot, patch.frame, rect, placedOffset, NO_DECAL_REPEAT);

        if (quad) {
          push(glyph, quad, placedOffset);
        }
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
        quadCount: batch.quads.length,
        standOff: batch.standOff,
        appearance: batch.appearance,
      });
    }
  }

  return batches;
}

/**
 * A picker, or null if the pool cannot be resolved.
 *
 * Validation rejects an unresolvable pool at the pane, so reaching this means
 * the config was written past it — and a reader's answer to that is bare stone,
 * exactly as it is for a document the catalog no longer carries.
 */
function glyphPicker(
  spec: string,
  order: EngravingAssignment["glyphOrder"],
): ReturnType<typeof createGlyphPicker> | null {
  try {
    return createGlyphPicker(resolveGlyphPool(spec), order);
  } catch {
    return null;
  }
}

