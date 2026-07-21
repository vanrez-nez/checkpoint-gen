import {
  type CardinalDirection,
  type CheckpointGeometryConfig,
} from "../checkpoint/generator";
import {
  derivePillarSeed,
  getPillarBaseWidth,
  type PillarGeometryConfig,
} from "./generator";

export type PillarSide = "left" | "right";

export interface PillarPlacement {
  direction: CardinalDirection;
  side: PillarSide;
  label: string;
  seed: number;
  x: number;
  y: number;
  z: number;
  rotationY: number;
}

type DirectionFrame = {
  axisX: number;
  axisZ: number;
  lateralX: number;
  lateralZ: number;
  rotationY: number;
};

const DIRECTIONS: readonly CardinalDirection[] = ["north", "east", "south", "west"];
const DIRECTION_FRAMES: Record<CardinalDirection, DirectionFrame> = {
  north: { axisX: 0, axisZ: 1, lateralX: 1, lateralZ: 0, rotationY: 0 },
  east: { axisX: 1, axisZ: 0, lateralX: 0, lateralZ: -1, rotationY: Math.PI * 0.5 },
  south: { axisX: 0, axisZ: -1, lateralX: -1, lateralZ: 0, rotationY: Math.PI },
  west: { axisX: -1, axisZ: 0, lateralX: 0, lateralZ: 1, rotationY: -Math.PI * 0.5 },
};

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

  for (const direction of DIRECTIONS) {
    if (!checkpoint.entries[direction]) {
      continue;
    }

    const frame = DIRECTION_FRAMES[direction];

    for (const side of ["left", "right"] as const) {
      const sideSign = side === "left" ? -1 : 1;
      const label = `${direction}-${side}`;
      placements.push({
        direction,
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
