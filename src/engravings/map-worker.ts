import type {
  EngravingMapRequest,
  EngravingMapResponse,
  EngravingSurfaceMaps,
} from "./worker-protocol";

interface PendingRequest {
  resolve(maps: EngravingSurfaceMaps): void;
  reject(error: Error): void;
}

/**
 * The main thread's side of the map worker.
 *
 * Spawned on the first request rather than at construction, because a session
 * that never assigns an engraving should not pay for a thread it will not use —
 * and most sessions are about massing, not ornament.
 *
 * One worker, and requests queue behind each other in its own message loop.
 * Running several would multiply the peak memory of a build that is already
 * lazy, cached and deduplicated, to shorten a wait that is already off the
 * frame.
 */
export class EngravingMapWorker {
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();

  request(
    input: Omit<EngravingMapRequest, "requestId">,
  ): Promise<EngravingSurfaceMaps> {
    const worker = this.ensureWorker();
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;

    return new Promise<EngravingSurfaceMaps>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      worker.postMessage(
        { ...input, requestId } satisfies EngravingMapRequest,
        // Both arrays were copied by the caller precisely so they can be given
        // away here; the catalog keeps its own.
        [input.cellLevels.buffer, input.heightByLevel.buffer] as Transferable[],
      );
    });
  }

  dispose(): void {
    this.rejectAll(new Error("The engraving map worker was disposed."));
    this.worker?.terminate();
    this.worker = null;
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }

    const worker = new Worker(
      new URL("./surface-maps.worker.ts", import.meta.url),
      { type: "module" },
    );

    worker.onmessage = (event: MessageEvent<EngravingMapResponse>) => {
      const response = event.data;
      const request = this.pending.get(response.requestId);

      if (!request) {
        return;
      }

      this.pending.delete(response.requestId);

      if (response.ok) {
        request.resolve(response);
      } else {
        request.reject(new Error(response.message));
      }
    };

    // A module that fails to load, or a reply that will not clone, is not one
    // layer's problem — nothing else queued behind it will arrive either. Fail
    // every waiter, drop the worker, and let the next request spawn a fresh one
    // so a transient failure is not permanent.
    worker.onerror = (event) => {
      this.failWorker(event.message || "The engraving map worker failed.");
    };
    worker.onmessageerror = () => {
      this.failWorker("The engraving map worker sent an unreadable reply.");
    };

    this.worker = worker;
    return worker;
  }

  private failWorker(message: string): void {
    this.rejectAll(new Error(message));
    this.worker?.terminate();
    this.worker = null;
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) {
      request.reject(error);
    }

    this.pending.clear();
  }
}
