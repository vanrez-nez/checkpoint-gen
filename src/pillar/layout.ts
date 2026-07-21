import { createPolarEntryFrames } from "../checkpoint/entries";
import { type CheckpointGeometryConfig } from "../checkpoint/generator";
import {
  derivePillarSeed,
  getPillarBaseWidth,
  type PillarGeometryConfig,
} from "./generator";

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

export function createPillarPlacements(
  checkpoint: CheckpointGeometryConfig,
  pillar: PillarGeometryConfig,
): PillarPlacement[] {
  const placements: PillarPlacement[] = [];
  const entryHalfWidth = checkpoint.radius * checkpoint.entryWidthRatio * 0.5;
  const baseHalfWidth = getPillarBaseWidth(pillar) * 0.5;
  const lateralDistance = entryHalfWidth + baseHalfWidth;
  const axialDistance = Math.sqrt(Math.max(
    checkpoint.radius * checkpoint.radius - entryHalfWidth * entryHalfWidth,
    0,
  )) + baseHalfWidth;

  for (const frame of createPolarEntryFrames(checkpoint.entryCount)) {
    for (const side of ["left", "right"] as const) {
      const sideSign = side === "left" ? -1 : 1;
      const label = `entry-${frame.index}-${side}`;
      placements.push({
        entryIndex: frame.index,
        angle: frame.angle,
        side,
        label,
        seed: derivePillarSeed(pillar.seed, label),
        x: frame.axisX * axialDistance + frame.lateralX * lateralDistance * sideSign,
        y: 0,
        z: frame.axisZ * axialDistance + frame.lateralZ * lateralDistance * sideSign,
        rotationY: frame.rotationY,
      });
    }
  }

  return placements;
}
