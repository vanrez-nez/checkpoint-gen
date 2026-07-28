/**
 * Generated shading shared by every procedural stone.
 *
 * These are the source values the scene's ambient-occlusion and crack-shadow
 * controls rescale from `geometry.userData`; they are not final lighting. A
 * stone shades from its bed to its top, independently of where that stone sits
 * in a structure. That is the contract established by the circular structure,
 * and keeping it here prevents another structure from looking like a different
 * material before the shared stone material is even evaluated.
 */

export interface FaceShading {
  readonly topAo: number;
  readonly bottomAo: number;
  readonly topShadow: number;
  readonly bottomShadow: number;
}

/** Open horizontal stone surfaces: paving, terraces and caps. */
export const FLAT_FACE_SHADING: FaceShading = {
  topAo: 1,
  bottomAo: 1,
  topShadow: 1,
  bottomShadow: 1,
};

/** The circular structure's established bottom-to-top shading for stone sides. */
export const DEFAULT_FACE_SHADING: FaceShading = {
  topAo: 0.72,
  bottomAo: 0.28,
  topShadow: 0.38,
  bottomShadow: 0.06,
};

export interface SurfaceShading {
  readonly ao: number;
  readonly shadow: number;
}

/** One end of the shared vertical stone-side gradient. */
export function sideShading(
  face: FaceShading,
  level: "bottom" | "top",
): SurfaceShading {
  return level === "top"
    ? { ao: face.topAo, shadow: face.topShadow }
    : { ao: face.bottomAo, shadow: face.bottomShadow };
}

/**
 * Horizontal shading for a stone.
 *
 * Tops are open like the circular structure's paving. A downward soffit has no
 * circular equivalent, so it takes the dark bed value of the same stone rather
 * than introducing a second palette.
 */
export function horizontalShading(
  face: FaceShading,
  facing: "up" | "down",
): SurfaceShading {
  return facing === "up"
    ? { ao: FLAT_FACE_SHADING.topAo, shadow: FLAT_FACE_SHADING.topShadow }
    : { ao: face.bottomAo, shadow: face.bottomShadow };
}
