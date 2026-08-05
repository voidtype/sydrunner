/**
 * The tile decode thread.
 *
 * Deliberately almost empty. Everything it does is in `tile-decode.ts`, which
 * the main thread imports as well -- so there is one implementation of the
 * parse, running in two places, and nothing here that could drift away from
 * what the fallback path does.
 *
 * What this file *is*, is the message protocol, and there are three things about
 * it worth stating because each one was a decision:
 *
 *  1. **It never fetches.** The bytes arrive from the main thread, transferred.
 *     Workers can fetch perfectly well, and the reason this one does not is
 *     `world/cdn.ts`: that module holds the CDN's health as module state -- the
 *     one-shot probe, the five-strike counter, the hit/fallback/origin tallies
 *     the HUD reads. A worker gets its *own* copy of every module it imports, so
 *     fetching here would mean two probes, two strike counters, and a `__cdn()`
 *     in the console reporting half the session's traffic. One place decides
 *     where a byte comes from, and that place is the main thread.
 *
 *  2. **Errors come back as messages, never as `throw`.** An uncaught throw in a
 *     worker surfaces as an `error` event with no request id attached, which
 *     would leave the streamer's pending-promise map holding an entry forever
 *     and the tile permanently mid-flight. Every failure is a reply.
 *
 *  3. **The reply transfers its buffers.** See `tileDecodeTransfers`: cloning
 *     would deserialise 1.6 MB per tile on the render thread, which is a good
 *     fraction of the cost this whole change exists to remove.
 */

import {
  decodeTilePayload,
  tileDecodeTransfers,
  type TileDecodeRequest,
  type TileDecodeResult,
} from './tile-decode.ts';

/** A job, as the streamer posts it. */
export interface DecodeWorkerRequest extends TileDecodeRequest {
  id: number;
}

/** The answer, as the streamer reads it. Exactly one of `tile`/`error` is set. */
export interface DecodeWorkerReply {
  id: number;
  key: string;
  tile: TileDecodeResult | null;
  error: string | null;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<DecodeWorkerRequest>) => void) | null;
  postMessage: (message: DecodeWorkerReply, transfer?: Transferable[]) => void;
};

scope.onmessage = (event: MessageEvent<DecodeWorkerRequest>): void => {
  const req = event.data;
  try {
    const tile = decodeTilePayload(req);
    scope.postMessage({ id: req.id, key: req.key, tile, error: null }, tileDecodeTransfers(tile));
  } catch (err) {
    scope.postMessage({
      id: req.id,
      key: req.key,
      tile: null,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
