// Type-only so this module emits no runtime import of ./config, which imports
// CircularShellConfig from ./shell, which imports createPolarEntryFrames here.
import type { CircularLayoutConfig } from "./config";
import {
  derivePillarSeed,
  getPillarBaseWidth,
} from "../../../props/pillar/generator";
import type { PillarConfig } from "../../../props/pillar/config";

export interface PolarEntryFrame {
  index: number;
  angle: number;
  axisX: number;
  axisZ: number;
  lateralX: number;
  lateralZ: number;
  rotationY: number;
}

export type PillarSide = "left" | "right";

export interface PillarPlacement {
  entryIndex: number;
  angle: number;
  side: PillarSide;
  label: string;
  seed: number;
  x: number;
  y: number;
  z: number;
  rotationY: number;
}

export function createPolarEntryFrames(entryCount: number): PolarEntryFrame[] {
  if (!Number.isInteger(entryCount) || entryCount < 1) {
    throw new RangeError("Entry count must be a positive integer.");
  }

  return Array.from({ length: entryCount }, (_, index) => {
    const angle = (index / entryCount) * Math.PI * 2;

    return {
      index,
      angle,
      axisX: Math.sin(angle),
      axisZ: Math.cos(angle),
      lateralX: Math.cos(angle),
      lateralZ: -Math.sin(angle),
      rotationY: angle,
    };
  });
}

/**
 * Places a flanking pillar pair at each entry mouth. This is circular-layout
 * knowledge, not pillar knowledge: it reads the plate radius and entry geometry
 * to find where the entry meets the circle boundary.
 */
export function createCircularPlacements(
  layout: CircularLayoutConfig,
  pillar: PillarConfig,
): PillarPlacement[] {
  const placements: PillarPlacement[] = [];
  const entryHalfWidth = layout.radius * layout.entryWidthRatio * 0.5;
  const baseHalfWidth = getPillarBaseWidth(pillar) * 0.5;
  const lateralDistance = entryHalfWidth + baseHalfWidth;
  const axialDistance = Math.sqrt(Math.max(
    layout.radius * layout.radius - entryHalfWidth * entryHalfWidth,
    0,
  )) + baseHalfWidth;

  for (const frame of createPolarEntryFrames(layout.entryCount)) {
    for (const side of ["left", "right"] as const) {
      const sideSign = side === "left" ? -1 : 1;
      const label = `entry-${frame.index}-${side}`;
      placements.push({
        entryIndex: frame.index,
        angle: frame.angle,
        side,
        label,
        seed: derivePillarSeed(pillar.stone.seed, label),
        x: frame.axisX * axialDistance + frame.lateralX * lateralDistance * sideSign,
        y: 0,
        z: frame.axisZ * axialDistance + frame.lateralZ * lateralDistance * sideSign,
        rotationY: frame.rotationY,
      });
    }
  }

  return placements;
}
