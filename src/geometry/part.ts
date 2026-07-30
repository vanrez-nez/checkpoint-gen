import * as THREE from "three";

/**
 * Material slots a part can be assigned to. The index in this array is both the
 * `materialIndex` of the merged geometry's draw group and the index into the
 * mesh's material array, so the order here is load-bearing.
 */
export const MATERIAL_SLOTS = [
  "stone",
  "trim",
  "stairs",
  "parapet",
  "summit",
  "interior",
  "roof",
  "pillar",
  "iron",
] as const;

export type MaterialSlot = (typeof MATERIAL_SLOTS)[number];

export function materialSlotIndex(slot: MaterialSlot): number {
  const index = MATERIAL_SLOTS.indexOf(slot);

  if (index < 0) {
    throw new RangeError(`Unknown material slot "${slot}".`);
  }

  return index;
}

/**
 * Rebuild granularity. A type emits parts tagged by section so the composer can
 * regenerate just the sections whose configuration changed.
 *
 * Section names are open rather than a fixed union: each type declares its own
 * list, and the composer, the stats and the merge ordering all read that list.
 * A masonry checkpoint's sections ("layout", "pillars", "fireBowls") and a mass
 * structure's ("mass") have nothing in common, and neither should have to know
 * the other exists.
 */
export type PartSection = string;

/**
 * A local-space chunk of a structure composition.
 *
 * The geometry must carry `position`, `normal`, an index, and the three
 * `userData` base arrays produced by `finalizeStoneGeometry`. Parts are cached
 * across rebuilds and shared between compositions, so nothing may mutate a
 * part's geometry after construction — placement lives entirely in `matrix`.
 */
export interface GeometryPart {
  /** Stable identifier, e.g. "shell" or "pillar/entry-0-left". */
  readonly id: string;
  readonly section: PartSection;
  readonly slot: MaterialSlot;
  readonly geometry: THREE.BufferGeometry;
  /** Local space to composition space. Rotation and translation only. */
  readonly matrix: THREE.Matrix4;
  /** Masonry stones in this part; zero for non-masonry parts such as fire bowls. */
  readonly stoneCount: number;
}

export interface PartStats {
  partCount: number;
  stoneCount: number;
  vertexCount: number;
  triangleCount: number;
}

/** A named point in composition space that a non-geometry prop attaches to. */
export interface CompositionAnchor {
  readonly label: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Mount surface for the offering statue. */
export interface OfferingAnchor {
  readonly centerTopY: number;
  readonly centerDiameter: number;
}

/**
 * Attachment points the generator hands to the scene for props that are not
 * part of the merged geometry: the loaded statue, the instanced flames, and the
 * flickering glow lights.
 */
export interface CompositionAnchors {
  /** Null when the active structure has no offering surface. */
  readonly offering: OfferingAnchor | null;
  /** One per fire bowl. `y` is the absolute mount height, flame base excluded. */
  readonly flames: readonly CompositionAnchor[];
  /** One per glow group, already averaged across the group's flames. */
  readonly glows: readonly CompositionAnchor[];
}

/** Shared identity matrix for parts that sit at the composition origin. */
export const IDENTITY_MATRIX: THREE.Matrix4 = new THREE.Matrix4();

export function emptyPartStats(): PartStats {
  return {
    partCount: 0,
    stoneCount: 0,
    vertexCount: 0,
    triangleCount: 0,
  };
}

/**
 * Zeroed stats for every declared section, so a section that produced nothing
 * this build still reports zero rather than vanishing from the readout.
 */
export function emptySectionStats(
  sections: Iterable<PartSection> = [],
): Record<PartSection, PartStats> {
  const stats: Record<PartSection, PartStats> = {};

  for (const section of sections) {
    stats[section] = emptyPartStats();
  }

  return stats;
}

export function emptyCompositionAnchors(): CompositionAnchors {
  return { offering: null, flames: [], glows: [] };
}

/** Builds the placement matrix for a part positioned on the ground plane. */
export function createPlacementMatrix(
  x: number,
  y: number,
  z: number,
  rotationY: number,
): THREE.Matrix4 {
  return new THREE.Matrix4().makeRotationY(rotationY).setPosition(x, y, z);
}
