import type { FireBowlConfig } from "../../../props/fire-bowl/config";
import { FIRE_BOWL_MAX_DIAMETER_FACTOR } from "../../../props/fire-bowl/generator";
import { stairBasis, stairLocalVertex } from "../../connector/stair";
import {
  groupOverlappingTerminals,
  summitTerminalCaps,
  terminalCapKey,
  type TerminalGroup,
} from "../../connector/terminal";
import type { StructureGraph } from "../../kernel/graph";
import {
  MIN_STAIR_FIRE_BOWL_SLOT_WIDTH,
  type MassLayoutConfig,
} from "./config";

/** Keeps the widest iron ring clear of every edge of its square cornice slot. */
export const MAX_FIRE_BOWL_SLOT_FILL = 0.9;

export interface MassFireBowlSlot {
  readonly id: string;
  readonly connectorId: string;
  readonly level: "bottom" | "top";
  readonly side: "negative" | "positive";
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Unit direction away from the mass, shared by both sides of the stair. */
  readonly outwardX: number;
  /** Unit direction away from the mass, shared by both sides of the stair. */
  readonly outwardZ: number;
  /** Both dimensions of the square terminal cornice. */
  readonly availableWidth: number;
  /** Reference passed to the shared bowl generator. */
  readonly referenceWidth: number;
  /** Requested shared scale, clamped so the widest ring remains on the slot. */
  readonly bowlScale: number;
  /**
   * True when this slot stands on a cap formed by two or more terminals that
   * ran into each other, rather than on one flight's own ending.
   */
  readonly merged: boolean;
}

/**
 * Resolves the two side slots at each enabled end of every Mass stair.
 *
 * A slot exists only on the square horizontal ending emitted for a real
 * parapet cornice. The ending is `parapet width + 2 * projection` on both axes,
 * so it is also the authoritative sizing surface for the bowl.
 */
export function resolveMassFireBowlSlots(
  layout: MassLayoutConfig,
  graph: StructureGraph,
  fireBowl: FireBowlConfig,
): MassFireBowlSlot[] {
  if (!layout.stairFireBowlBottomEnabled && !layout.stairFireBowlTopEnabled) {
    return [];
  }

  const slots: MassFireBowlSlot[] = [];
  // Resolved once, over every connector, because a collision belongs to a pair
  // of stairs and no single stair can see one.
  const mergeGroups = groupOverlappingTerminals(
    graph.connectors.flatMap(summitTerminalCaps),
  );
  const merged = new Set(
    mergeGroups.flatMap((group) =>
      group.caps.map((cap) => terminalCapKey(cap.connectorId, cap.side))
    ),
  );

  for (const connector of graph.connectors) {
    const parapet = connector.parapet;
    const cornice = parapet?.cornice;
    if (!parapet || !cornice) {
      continue;
    }

    const availableWidth = parapet.width + cornice.projection * 2;
    if (availableWidth < MIN_STAIR_FIRE_BOWL_SLOT_WIDTH) {
      continue;
    }

    const referenceWidth = availableWidth / FIRE_BOWL_MAX_DIAMETER_FACTOR;
    const bowlScale = Math.min(fireBowl.scale, MAX_FIRE_BOWL_SLOT_FILL);
    const outward = stairBasis(connector.direction).outward;
    const sideCenters = [
      ["negative", -connector.width * 0.5 - parapet.width * 0.5],
      ["positive", connector.width * 0.5 + parapet.width * 0.5],
    ] as const;
    const levels = [
      ...(layout.stairFireBowlBottomEnabled
        ? [{
          level: "bottom" as const,
          y: connector.sideTreatment === "stepped_parapet"
            ? connector.bottomY + connector.riser + parapet.height
            : connector.bottomY + parapet.height,
          v: connector.run + availableWidth * 0.5,
        }]
        : []),
      ...(layout.stairFireBowlTopEnabled
        ? [{
          level: "top" as const,
          y: connector.topY + parapet.height,
          v: -availableWidth * 0.5,
        }]
        : []),
    ];

    for (const level of levels) {
      for (const [side, u] of sideCenters) {
        // A summit cap that has been merged into a neighbour's is one pier, and
        // one pier carries one bowl. The pair is collapsed rather than having
        // one of the two suppressed, because neither of them is the survivor:
        // the bowl belongs on the merged cap, which is centred on neither.
        if (level.level === "top" && merged.has(terminalCapKey(connector.id, side))) {
          continue;
        }

        const point = stairLocalVertex(connector, u, level.y, level.v);
        slots.push({
          id: `${connector.id}/fire_bowl_${level.level}_${side}`,
          connectorId: connector.id,
          level: level.level,
          side,
          x: point.x,
          y: point.y,
          z: point.z,
          outwardX: outward.x,
          outwardZ: outward.z,
          availableWidth,
          referenceWidth,
          bowlScale,
          merged: false,
        });
      }
    }
  }

  if (layout.stairFireBowlTopEnabled) {
    slots.push(...mergedSummitSlots(mergeGroups, fireBowl));
  }

  return slots;
}

/**
 * One slot per group of summit caps that ran into each other.
 *
 * Placed at the centre of the region the caps share, which is the only point
 * guaranteed to sit on every cap in the group — the union of two rectangles
 * meeting at a corner is L-shaped, and its centroid can fall off the stone
 * entirely. The bowl keeps the size a lone terminal would give it so a merged
 * pier does not announce itself with a larger flame than its neighbours.
 */
function mergedSummitSlots(
  groups: readonly TerminalGroup[],
  fireBowl: FireBowlConfig,
): MassFireBowlSlot[] {
  return groups.map((group, index) => {
    const availableWidth = Math.min(...group.caps.map((cap) => cap.width));
    const outward = normalizeOutward(group.caps);

    return {
      id: `structure/fire_bowl_summit_merged_${index}`,
      connectorId: group.caps[0]!.connectorId,
      level: "top" as const,
      side: "positive" as const,
      x: (group.minX + group.maxX) * 0.5,
      y: Math.max(...group.caps.map((cap) => cap.topY)),
      z: (group.minZ + group.maxZ) * 0.5,
      outwardX: outward.x,
      outwardZ: outward.z,
      availableWidth,
      referenceWidth: availableWidth / FIRE_BOWL_MAX_DIAMETER_FACTOR,
      bowlScale: Math.min(fireBowl.scale, MAX_FIRE_BOWL_SLOT_FILL),
      merged: true,
    };
  });
}

/**
 * The bisector of the directions the merged caps face.
 *
 * A merged pier sits on a corner and belongs to neither flight, so taking one
 * flight's outward direction would tilt the bowl toward it. Degenerate sums —
 * caps facing exactly opposite ways — fall back to the first, since any answer
 * is arbitrary there and an unnormalisable one is not an answer at all.
 */
function normalizeOutward(
  caps: readonly { readonly outwardX: number; readonly outwardZ: number }[],
): { x: number; z: number } {
  const x = caps.reduce((total, cap) => total + cap.outwardX, 0);
  const z = caps.reduce((total, cap) => total + cap.outwardZ, 0);
  const length = Math.hypot(x, z);

  return length > 1e-6
    ? { x: x / length, z: z / length }
    : { x: caps[0]!.outwardX, z: caps[0]!.outwardZ };
}
