import * as THREE from "three";
import {
  createPlacementMatrix,
  type CompositionAnchor,
  type GeometryPart,
  type PartSection,
} from "../../geometry/part";
import { createFireBowlGeometry } from "../fire-bowl/generator";
import type { FireBowlConfig } from "../fire-bowl/config";
import { createPillarGeometry } from "./generator";
import { toPillarGeometryConfig, type PillarConfig } from "./config";

/** Where one pillar stands, and which seed drives its masonry. */
export interface PillarPlacementInput {
  readonly label: string;
  readonly seed: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rotationY: number;
}

export interface PillarPartsResult {
  readonly parts: readonly GeometryPart[];
  /** One per bowl, at the bowl mount height. Empty when bowls are disabled. */
  readonly flames: readonly CompositionAnchor[];
}

/**
 * Builds the pillar and fire-bowl parts for a set of placements.
 *
 * This is where the pillar/bowl coupling lives — a bowl is sized from the
 * pillar's shaft width and mounted at its height — so checkpoint types only
 * have to decide *where* pillars go.
 *
 * Anchors are always returned in full; `sections` only gates geometry work, so
 * the caller can reuse cached parts for sections it did not ask to rebuild.
 */
export function buildPillarParts(input: {
  readonly placements: readonly PillarPlacementInput[];
  readonly pillar: PillarConfig;
  readonly fireBowl: FireBowlConfig;
  readonly sections: ReadonlySet<PartSection>;
}): PillarPartsResult {
  const { placements, pillar, fireBowl, sections } = input;
  const buildPillars = sections.has("pillars");
  const buildBowls = sections.has("fireBowls") && fireBowl.enabled;
  const parts: GeometryPart[] = [];
  const flames: CompositionAnchor[] = [];

  for (const placement of placements) {
    const matrix = createPlacementMatrix(
      placement.x,
      placement.y,
      placement.z,
      placement.rotationY,
    );

    if (buildPillars) {
      const geometry = createPillarGeometry(
        toPillarGeometryConfig(pillar, placement.seed),
      );
      parts.push({
        id: `pillar/${placement.label}`,
        section: "pillars",
        slot: "stone",
        geometry: geometry.geometry,
        matrix,
        stoneCount: geometry.stoneCount,
      });
    }

    if (buildBowls) {
      const bowl = createFireBowlGeometry(fireBowl, pillar.shaftWidth);
      parts.push({
        id: `fire-bowl/${placement.label}`,
        section: "fireBowls",
        slot: "iron",
        geometry: bowl.geometry,
        // The bowl is authored at its own origin; mounting it on the pillar top
        // is a matrix concern now, not a geometry mutation.
        matrix: matrix.clone().multiply(
          new THREE.Matrix4().makeTranslation(0, pillar.height, 0),
        ),
        stoneCount: 0,
      });
    }

    if (fireBowl.enabled) {
      flames.push({
        label: placement.label,
        x: placement.x,
        y: placement.y + pillar.height,
        z: placement.z,
      });
    }
  }

  return { parts, flames };
}
