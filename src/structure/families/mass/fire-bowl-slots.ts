import type { FireBowlConfig } from "../../../props/fire-bowl/config";
import { FIRE_BOWL_MAX_DIAMETER_FACTOR } from "../../../props/fire-bowl/generator";
import { stairBasis, stairLocalVertex } from "../../connector/stair";
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
        });
      }
    }
  }

  return slots;
}
