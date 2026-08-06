import * as THREE from "three";

/**
 * What the sun bake is allowed to spend, and where the sun is.
 *
 * These lived in `scene/main.ts` beside the only code that used them, which was
 * right until something else needed to reproduce that pipeline exactly. A
 * benchmark that copies the numbers is a benchmark that measures whatever they
 * were on the day it was written; the moment someone tunes `SHADOW_EDGE_BOUND`
 * the readout keeps reporting confidently and is simply wrong. So the numbers
 * live here, below both callers, and there is one of each.
 *
 * `scene/main.ts` cannot be imported outside a browser — it pulls `three/webgpu`
 * and the GLTF loader — so "below both callers" also has to mean "importable
 * from Node". Nothing here reaches past `three`.
 */

/**
 * Longest edge a face may keep before the sun bake subdivides it.
 *
 * Sized against the stonework rather than the structure: a course is 0.86 tall
 * and a stone 1.65 long, so this leaves the masonry untouched and refines only
 * the plain faces — roofs, pads, plaza slabs — that carry too few vertices to
 * describe a shadow crossing them.
 */
export const SUN_BAKE_MAX_EDGE = 1.5;

/**
 * How wide a shadow's edge may be, in metres, where one falls.
 *
 * The sun is baked per vertex, so an edge is a ramp between a lit vertex and a
 * dark one. `SUN_BAKE_MAX_EDGE` alone leaves that ramp about a metre wide on a
 * default mass, which reads as a gradient rather than a shadow and which any
 * second surface laid over it reconstructs differently. This is the bound the
 * refinement pass applies to those edges alone.
 */
export const SHADOW_EDGE_BOUND = 0.2;

/** Half-angle of the sun's disc. Wider than the real sun, to soften contacts. */
export const SUN_BAKE_SOFTNESS = 0.035;

/**
 * Rays per lit vertex.
 *
 * Cost is the product of this and the vertex count that `SUN_BAKE_MAX_EDGE`
 * implies, and both bite hard: refining to 0.75 with eight rays took nine
 * seconds on this mass, which is not a slider. Halving the bound quarters the
 * vertices it adds, so the edge bound is the dial to reach for first.
 */
export const SUN_BAKE_SAMPLES = 4;

/**
 * Rays per vertex on the pass that only has to classify.
 *
 * The first bake exists so the refinement pass can find shadow boundaries at
 * all — it is asking "lit or dark", not "how lit", and the answer it produces
 * is overwritten by the full-sample bake that follows. Softness needs several
 * rays to resolve a penumbra; a boundary does not, because a penumbra is
 * exactly the region the refinement is about to subdivide anyway.
 *
 * Measured on a 53k-vertex mass: 270 ms at four samples, 115 ms at one.
 */
export const SUN_CLASSIFY_SAMPLES = 1;

/**
 * The unit direction from the structure toward the sun.
 *
 * Single source of truth on purpose: the light's placement and the bake's ray
 * direction must agree exactly, and deriving them from the same azimuth and
 * elevation is what guarantees it.
 *
 * Takes two numbers rather than the illumination config, so that this stays
 * below the layer that owns what a config is.
 */
export function sunDirection(
  azimuthDegrees: number,
  elevationDegrees: number,
): THREE.Vector3 {
  const azimuth = THREE.MathUtils.degToRad(azimuthDegrees);
  const elevation = THREE.MathUtils.degToRad(elevationDegrees);
  const horizontal = Math.cos(elevation);

  return new THREE.Vector3(
    Math.cos(azimuth) * horizontal,
    Math.sin(elevation),
    Math.sin(azimuth) * horizontal,
  );
}
