/**
 * The pool of decode threads, and the one place that knows a worker might not
 * exist.
 *
 * ---------------------------------------------------------------------------
 * HOW MANY. Two, and the number falls out of the two rates it sits between.
 * `TileStreamer.concurrency` is four in-flight fetches; a tile decodes in 2-15 ms
 * on a fast machine and 10-90 ms on the laptop this change is for; and a tile is
 * 1.6 MB, so even a warm CDN cannot deliver four of them in less than a hundred
 * milliseconds. Two decoders retire the queue faster than the network can fill
 * it at every point on that curve, and a third would spend its life idle while
 * costing another module-evaluation of this bundle at boot.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FALLBACK IS NOT DEAD CODE. `new Worker` can fail for reasons that have
 * nothing to do with this project -- a `Worker` constructor that is not there at
 * all (a headless tile-loading test, which is a configuration this streamer
 * already supports), a Content-Security-Policy without `worker-src`, or a
 * browser that refuses a module worker. In every one of those the game must
 * still load the city; it simply loads it the way it did before this change,
 * with the decode on the main thread and only the *construction* time-sliced.
 * That is a slower game, not a broken one, and it is strictly better than the
 * alternative of a blank world.
 *
 * The fallback runs `decodeTilePayload`, which is the identical function the
 * worker runs. There is no second implementation to keep in step.
 */

import {
  decodeTilePayload,
  type TileDecodeRequest,
  type TileDecodeResult,
} from './tile-decode.ts';
import type { DecodeWorkerReply, DecodeWorkerRequest } from './decode.worker.ts';

/** What the HUD and the dev handle can ask about the pool. */
export interface DecoderStats {
  /** Live workers. Zero means every decode is running on the main thread. */
  workers: number;
  /** Jobs posted and not yet answered. */
  inFlight: number;
  /** Why there are no workers, when there are none. */
  reason: string;
}

interface Pending {
  resolve: (result: TileDecodeResult) => void;
  reject: (err: Error) => void;
  worker: number;
}

export class TileDecoder {
  private readonly workers: Worker[] = [];
  private readonly load: number[] = [];
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private reason = '';

  constructor(size = 2) {
    if (typeof Worker === 'undefined') {
      this.reason = 'no Worker in this environment';
      return;
    }
    for (let i = 0; i < size; i++) {
      try {
        // The URL form Vite requires: it is what lets the bundler see the
        // dependency and emit the worker as its own chunk. A string path would
        // resolve at runtime against the page and 404 in the production build.
        const worker = new Worker(new URL('./decode.worker.ts', import.meta.url), {
          type: 'module',
        });
        const slot = this.workers.length;
        worker.onmessage = (event: MessageEvent<DecodeWorkerReply>): void => {
          this.settle(event.data);
        };
        // A worker that dies takes its outstanding jobs with it. They are
        // rejected rather than left hanging: the streamer treats a rejected
        // decode exactly as it treats a corrupt tile, which is to record the
        // failure and move on, and a promise that never settles would instead
        // pin the tile in `loading` for the life of the session.
        worker.onerror = (event: ErrorEvent): void => {
          this.fail(slot, event.message || 'decode worker error');
        };
        this.workers.push(worker);
        this.load.push(0);
      } catch (err) {
        this.reason = err instanceof Error ? err.message : String(err);
        break;
      }
    }
    if (this.workers.length === 0 && !this.reason) this.reason = 'no worker could be created';
  }

  get stats(): DecoderStats {
    return { workers: this.workers.length, inFlight: this.pending.size, reason: this.reason };
  }

  /**
   * Decode one tile.
   *
   * The request's buffers are **transferred**, so the caller must not read them
   * afterwards -- which is exactly what the streamer wants, since it fetched
   * them for this and nothing else. The inline path does not transfer, and the
   * asymmetry is harmless for the same reason.
   */
  decode(req: TileDecodeRequest): Promise<TileDecodeResult> {
    if (this.workers.length === 0) {
      // Inline. Synchronous, and therefore one task -- but the *construction*
      // half is still time-sliced by the streamer, so this is the old decode
      // cost and not the old cost plus the old build.
      try {
        return Promise.resolve(decodeTilePayload(req));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }

    // Least-loaded rather than round-robin: tiles differ by an order of
    // magnitude in size, so a strict rotation can put both of a pair of CBD
    // tiles behind one worker while the other idles.
    let slot = 0;
    for (let i = 1; i < this.load.length; i++) if (this.load[i] < this.load[slot]) slot = i;

    const id = this.nextId++;
    const message: DecodeWorkerRequest = { ...req, id };
    const transfer: ArrayBuffer[] = [req.glb];
    for (const buf of [req.veg, req.power, req.furn, req.pow, req.names, req.water]) {
      if (buf !== null && buf.byteLength > 0) transfer.push(buf);
    }

    return new Promise<TileDecodeResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, worker: slot });
      this.load[slot]++;
      this.workers[slot].postMessage(message, transfer);
    });
  }

  private settle(reply: DecodeWorkerReply): void {
    const entry = this.pending.get(reply.id);
    if (!entry) return;
    this.pending.delete(reply.id);
    this.load[entry.worker] = Math.max(0, this.load[entry.worker] - 1);
    if (reply.tile) entry.resolve(reply.tile);
    else entry.reject(new Error(reply.error ?? 'decode failed'));
  }

  private fail(slot: number, message: string): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.worker !== slot) continue;
      this.pending.delete(id);
      entry.reject(new Error(message));
    }
    this.load[slot] = 0;
  }

  dispose(): void {
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    this.load.length = 0;
    this.reason = 'disposed';
    for (const [, entry] of this.pending) entry.reject(new Error('decoder disposed'));
    this.pending.clear();
  }
}

/**
 * Run one tile's bytes through the pool *and* through the main thread, and
 * report every way the two answers differ.
 *
 * The regression net for the thing that cannot be proved by reading the code:
 * the arithmetic is one function, so what is actually under test here is the
 * **message protocol** -- the transfer list, the structured clone, the shape of
 * the reply. A buffer left off the transfer list still arrives (cloned); a
 * buffer transferred *twice* throws; a field forgotten in the reply arrives as
 * `undefined` and reads as "this tile has no trees". None of those has a
 * picture, and all three are silent.
 *
 * The caller supplies two copies of the bytes because both paths consume what
 * they are given -- the worker transfers its request away.
 */
export async function verifyDecoderRoundTrip(
  decoder: TileDecoder,
  forWorker: TileDecodeRequest,
  forInline: TileDecodeRequest,
): Promise<string[]> {
  const failures: string[] = [];
  let remote: TileDecodeResult;
  try {
    remote = await decoder.decode(forWorker);
  } catch (err) {
    return [`worker decode threw: ${err instanceof Error ? err.message : String(err)}`];
  }
  const local = decodeTilePayload(forInline);
  compare('', local as unknown, remote as unknown, failures);
  return failures;
}

/**
 * Deep structural equality over decoded tile data, reported as a list of paths
 * rather than a boolean, because "the tiles differ" is not a bug report.
 *
 * Typed arrays are compared element-wise. `NaN` is treated as equal to itself:
 * a terrain-less corner can legitimately produce one, and `NaN !== NaN` would
 * turn a correct decode into a failing check.
 */
function compare(path: string, a: unknown, b: unknown, out: string[], depth = 0): void {
  if (out.length > 12 || depth > 8) return;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    const x = a as { length?: number; [i: number]: number };
    const y = b as { length?: number; [i: number]: number };
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) {
      out.push(`${path}: one side is a typed array and the other is not`);
      return;
    }
    if (x.length !== y.length) {
      out.push(`${path}: length ${x.length} vs ${y.length}`);
      return;
    }
    for (let i = 0; i < (x.length ?? 0); i++) {
      if (x[i] !== y[i] && !(Number.isNaN(x[i]) && Number.isNaN(y[i]))) {
        out.push(`${path}[${i}]: ${x[i]} vs ${y[i]}`);
        return;
      }
    }
    return;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      out.push(`${path}: array shape differs`);
      return;
    }
    for (let i = 0; i < a.length; i++) compare(`${path}[${i}]`, a[i], b[i], out, depth + 1);
    return;
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.join(',') !== kb.join(',')) {
      out.push(`${path}: keys ${ka.join(',')} vs ${kb.join(',')}`);
      return;
    }
    for (const k of ka) {
      compare(
        path ? `${path}.${k}` : k,
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        out,
        depth + 1,
      );
    }
    return;
  }
  if (a !== b && !(typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b))) {
    out.push(`${path}: ${String(a)} vs ${String(b)}`);
  }
}
