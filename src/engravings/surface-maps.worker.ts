import { rasterizeRoundedPixelField } from "./rounded-pixels";
import { deriveSurfaceMaps } from "./surface-maps";
import type {
  EngravingMapRequest,
  EngravingMapResponse,
} from "./worker-protocol";

/**
 * Derives one engraving's surface maps off the frame.
 *
 * The work is a few tens of millions of neighbourhood samples per layer, which
 * is a visible stall on the main thread and nothing at all here. It is the only
 * worker in the project, and it stays that way by being genuinely expensive:
 * the sun bake, which is comparable in cost, runs synchronously because it must
 * complete before the frame it feeds.
 *
 * `lib.webworker.d.ts` is deliberately not referenced. This file sits under
 * `src`, so a `/// <reference lib="webworker" />` would add that lib to the
 * whole program alongside the DOM lib, and the two redeclare several hundred
 * interfaces and dozens of globals. A worker needs exactly two things from its
 * own scope, so they are named here instead. `MessageEvent` and `Transferable`
 * are structural and come from the DOM lib unchanged.
 */
interface EngravingWorkerScope {
  onmessage: ((event: MessageEvent<EngravingMapRequest>) => void) | null;
  postMessage(message: EngravingMapResponse, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as EngravingWorkerScope;

scope.onmessage = (event: MessageEvent<EngravingMapRequest>) => {
  const request = event.data;

  try {
    // Always rasterised, never branched: at a radius of zero the reconstruction
    // degenerates to a supersampled nearest upsample, which is exactly what an
    // unrounded cell grid should become.
    const height = rasterizeRoundedPixelField(
      request.cellLevels,
      request.sourceWidth,
      request.sourceHeight,
      request.targetWidth,
      request.targetHeight,
      request.pixelCornerRadius,
      request.heightByLevel,
    );

    const maps = deriveSurfaceMaps(
      height,
      request.targetWidth,
      request.targetHeight,
      request.normalRadius,
      // How many texels one authored cell now spans. The moisture search reads
      // this to size its neighbourhood in cells rather than in texels, so a
      // cavity means the same thing whatever resolution it was derived at.
      Math.min(
        request.targetWidth / Math.max(1, request.sourceWidth),
        request.targetHeight / Math.max(1, request.sourceHeight),
      ),
    );

    scope.postMessage(
      {
        requestId: request.requestId,
        ok: true,
        width: request.targetWidth,
        height: request.targetHeight,
        ...maps,
      },
      [
        ...maps.normalMipmaps.map((level) => level.data.buffer),
        ...maps.ambientOcclusionMipmaps.map((level) => level.data.buffer),
        ...maps.moistureAccumulationMipmaps.map((level) => level.data.buffer),
      ] as Transferable[],
    );
  } catch (error) {
    scope.postMessage({
      requestId: request.requestId,
      ok: false,
      message: error instanceof Error
        ? error.message
        : "Engraving map derivation failed.",
    });
  }
};

export {};
