import type { SurfaceMapMipLevel } from "./surface-maps";

/**
 * What crosses the wire between the scene and the map worker.
 *
 * Both sides import this file, so the message shape cannot drift on one side
 * only. The request carries the layer's *cell* grid rather than a rasterised
 * height field — the optimized export is already the cell grid, so rasterising
 * on the main thread first would move the expensive half of the work back onto
 * the frame it was moved off.
 */

export interface EngravingMapRequest {
  readonly requestId: number;
  /** `sourceWidth * sourceHeight` depth levels. Transferred, not copied. */
  readonly cellLevels: Uint8Array;
  /** Grey per level. Transferred, not copied. */
  readonly heightByLevel: Uint8Array;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly targetWidth: number;
  readonly targetHeight: number;
  readonly pixelCornerRadius: number;
  readonly normalRadius: number;
}

export interface EngravingSurfaceMaps {
  readonly width: number;
  readonly height: number;
  readonly normalMipmaps: SurfaceMapMipLevel[];
  readonly ambientOcclusionMipmaps: SurfaceMapMipLevel[];
  readonly moistureAccumulationMipmaps: SurfaceMapMipLevel[];
}

/**
 * A failure is a message rather than an exception, so one unusable layer
 * rejects one promise instead of killing the worker every other layer is
 * queued behind.
 */
export type EngravingMapResponse =
  | ({ readonly requestId: number; readonly ok: true } & EngravingSurfaceMaps)
  | { readonly requestId: number; readonly ok: false; readonly message: string };
