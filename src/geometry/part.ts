import * as THREE from "three";

/**
 * Material slots a part can be assigned to. The index in this array is both the
 * `materialIndex` of the merged geometry's draw group and the index into the
 * mesh's material array, so the order here is load-bearing.
 */
export const MATERIAL_SLOTS = ["stone", "iron"] as const;

export type MaterialSlot = (typeof MATERIAL_SLOTS)[number];

/**
 * Rebuild granularity. A checkpoint type emits parts tagged by section so the
 * composer can regenerate just the sections whose configuration changed.
 */
export const PART_SECTIONS = ["layout", "pillars", "fireBowls"] as const;

export type PartSection = (typeof PART_SECTIONS)[number];

/**
 * A local-space chunk of a checkpoint composition.
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
  /** Null when the active checkpoint type has no offering surface. */
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

export function emptySectionStats(): Record<PartSection, PartStats> {
  return {
    layout: emptyPartStats(),
    pillars: emptyPartStats(),
    fireBowls: emptyPartStats(),
  };
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
