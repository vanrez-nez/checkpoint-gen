import * as THREE from "three";
import { evaluateFrame, type Vec3 } from "./frame";
import type { StructureGraph } from "./graph";
import type { Patch } from "./patch";

/**
 * Draws the semantic layer.
 *
 * The silhouette alone does not tell you whether the patches underneath it are
 * right — whether a facade's normal faces out, whether a terrace was classified
 * as walkable, where the summit reserved its forecourt. Every later phase places
 * things against those frames, so being able to see them is not a debugging
 * nicety, it is how the layer gets tuned at all.
 *
 * Each patch contributes an outline of its `u`/`v` domain, a normal tick at its
 * centre, and an outline per declared region, all coloured by role.
 */

const ROLE_COLORS: Readonly<Record<string, number>> = {
  ground_interface: 0x4c5047,
  base_plinth: 0x8b6f47,
  vertical_facade: 0x38bdf8,
  battered_facade: 0x22d3ee,
  terrace: 0x4ade80,
  transition_band: 0xfbbf24,
  summit_floor: 0xf472b6,
};

const FALLBACK_COLOR = 0x94a3b8;
const REGION_COLOR = 0xffffff;
/** Normal tick length, as a fraction of the structure's diagonal. */
const NORMAL_TICK_RATIO = 0.02;
/** Patch outlines are lifted off the surface so they do not z-fight with it. */
const SURFACE_OFFSET_RATIO = 0.002;

export interface PatchOverlay {
  readonly object: THREE.LineSegments;
  dispose(): void;
}

export function createPatchOverlay(graph: StructureGraph): PatchOverlay {
  const scale = graphScale(graph);
  const tick = scale * NORMAL_TICK_RATIO;
  const offset = scale * SURFACE_OFFSET_RATIO;
  const positions: number[] = [];
  const colors: number[] = [];

  for (const patch of graph.patches) {
    const color = new THREE.Color(ROLE_COLORS[patch.role] ?? FALLBACK_COLOR);

    // The domain boundary. Drawn from the frame rather than from the geometry,
    // so a tessellation that disagrees with the patch it came from is visible.
    addLoop(positions, colors, color, [
      surfacePoint(patch, 0, 0, offset),
      surfacePoint(patch, 1, 0, offset),
      surfacePoint(patch, 1, 1, offset),
      surfacePoint(patch, 0, 1, offset),
    ]);

    const centre = surfacePoint(patch, 0.5, 0.5, offset);
    addSegment(positions, colors, color, centre, {
      x: centre.x + patch.frame.normal.x * tick,
      y: centre.y + patch.frame.normal.y * tick,
      z: centre.z + patch.frame.normal.z * tick,
    });

    const regionColor = new THREE.Color(REGION_COLOR);

    for (const region of patch.regions) {
      const [uMin, uMax] = region.uRange;
      const [vMin, vMax] = region.vRange;

      addLoop(positions, colors, regionColor, [
        surfacePoint(patch, uMin, vMin, offset * 2),
        surfacePoint(patch, uMax, vMin, offset * 2),
        surfacePoint(patch, uMax, vMax, offset * 2),
        surfacePoint(patch, uMin, vMax, offset * 2),
      ]);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));

  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    depthTest: false,
    transparent: true,
    opacity: 0.9,
  });
  const object = new THREE.LineSegments(geometry, material);
  object.name = "Patch debug";
  // Drawn after everything else so the overlay reads as an overlay.
  object.renderOrder = 999;

  return {
    object,
    dispose(): void {
      object.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}

function surfacePoint(patch: Patch, u: number, v: number, offset: number): Vec3 {
  return evaluateFrame(patch.frame, u, v, offset);
}

function addLoop(
  positions: number[],
  colors: number[],
  color: THREE.Color,
  corners: readonly Vec3[],
): void {
  for (let index = 0; index < corners.length; index += 1) {
    const from = corners[index];
    const to = corners[(index + 1) % corners.length];

    if (from && to) {
      addSegment(positions, colors, color, from, to);
    }
  }
}

function addSegment(
  positions: number[],
  colors: number[],
  color: THREE.Color,
  from: Vec3,
  to: Vec3,
): void {
  positions.push(from.x, from.y, from.z, to.x, to.y, to.z);
  colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
}

/** The structure's diagonal, so tick sizes track the thing being drawn. */
function graphScale(graph: StructureGraph): number {
  let diagonal = 0;

  for (const mass of graph.masses) {
    const width = mass.footprint.maxX - mass.footprint.minX;
    const depth = mass.footprint.maxZ - mass.footprint.minZ;
    diagonal = Math.max(diagonal, Math.hypot(width, depth, mass.totalHeight));
  }

  return diagonal > 0 ? diagonal : 1;
}
