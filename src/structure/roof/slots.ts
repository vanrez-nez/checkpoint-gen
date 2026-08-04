import type { HorizontalOrientation, Rect } from "../kernel/frame";
import type { RoofRecord } from "../kernel/graph";
import { evaluateFrame } from "../kernel/frame";
import type { Patch } from "../kernel/patch";
import type { PreparedField } from "../mass/shell";

export type RoofFascia = ReadonlyMap<HorizontalOrientation, PreparedField>;

/**
 * Each published fascia field, in the coordinates the builder draws in.
 *
 * A roof is drawn as a ring of plan pieces rather than from its patches, so
 * this is where the published rectangle is converted back — once, and only for
 * the fascias that were actually reserved. The two rings are kept apart because
 * both present a `front`, and a single map keyed by direction would let the
 * moulding above quietly take the slab's place.
 */
export function preparedRoofFields(
  roof: RoofRecord,
  patches: ReadonlyMap<string, Patch>,
): { readonly slab: RoofFascia; readonly cornice: RoofFascia } {
  const corniceEdges = new Set(roof.cornice?.edgePatchIds ?? []);
  const slab = new Map<HorizontalOrientation, PreparedField>();
  const cornice = new Map<HorizontalOrientation, PreparedField>();

  for (const slot of roof.slots) {
    const patch = patches.get(slot.patchId);

    if (!patch || slot.face === "top" || slot.face === "bottom") {
      continue;
    }

    const orientation = slot.face;
    const corners = [
      evaluateFrame(patch.frame, slot.inscribed.uMin, slot.inscribed.vMin, 0),
      evaluateFrame(patch.frame, slot.inscribed.uMax, slot.inscribed.vMax, 0),
    ];
    // Kept in `u` order, not sorted: `rectEdge` runs backwards along the axis
    // on a rear or positive-side face, so the lower `u` is the larger world
    // coordinate there and sorting would mirror the field.
    const alongOf = (point: { readonly x: number; readonly z: number }) =>
      orientation === "front" || orientation === "rear" ? point.x : point.z;
    const low = alongOf(corners[0]!);
    const high = alongOf(corners[1]!);

    (corniceEdges.has(slot.patchId) ? cornice : slab).set(orientation, {
      face: orientation,
      left: [low, low],
      right: [high, high],
      bottomY: Math.min(corners[0]!.y, corners[1]!.y),
      topY: Math.max(corners[0]!.y, corners[1]!.y),
      // A fascia is never banded; the strip laid flat is the whole face.
      rowBottomY: Math.min(corners[0]!.y, corners[1]!.y),
      rowTopY: Math.max(corners[0]!.y, corners[1]!.y),
    });
  }

  return { slab, cornice };
}

/**
 * Whether this ring piece is the one drawn over a reserved fascia.
 *
 * A ring's front and rear pieces run the full width and own the corners, so its
 * side pieces are shorter. The slot was resolved against exactly that, and the
 * field is already in world coordinates, so this is a containment test rather
 * than a conversion.
 */
export function fieldForPiece(
  prepared: RoofFascia,
  orientation: HorizontalOrientation,
  piece: Rect,
): PreparedField | undefined {
  const field = prepared.get(orientation);

  if (!field) {
    return undefined;
  }

  const alongX = orientation === "front" || orientation === "rear";
  const from = alongX ? piece.minX : piece.minZ;
  const to = alongX ? piece.maxX : piece.maxZ;
  const low = Math.min(field.left[0], field.right[0]);
  const high = Math.max(field.left[0], field.right[0]);

  return low >= from - 1e-6 && high <= to + 1e-6 ? field : undefined;
}
