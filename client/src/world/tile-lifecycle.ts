/**
 * The two rules that decide when a tile is *allowed* to be an invisible wall.
 *
 * Both of them belong to `world/streamer.ts` and neither of them can be tested
 * there, because that file imports `three/webgpu` and pulls a WebGPU renderer
 * into any process that so much as reads it. What is in here is the arithmetic
 * with no scene graph in it: a failure taxonomy with a backoff, and the one
 * distance that says whether a tile's collision may be dropped. The streamer
 * imports both; `server/integration-check.ts` imports both and asserts them
 * against a real `CollisionWorld`.
 *
 * ---------------------------------------------------------------------------
 * 1. WHY A TRANSIENT FAILURE MUST NOT BE A PERMANENT ONE.
 *
 * `TileStreamer.update` used to gate on a `failed` set that nothing ever
 * emptied. One aborted fetch, one 502 from a reverse proxy, one worker that
 * threw decoding a truncated GLB, and that tile's **geometry** was never
 * requested again for the life of the session -- while `main.ts` went on
 * fetching its 9 kB collision payload on its own 420 m ring every half second,
 * successfully, because a 9 kB request and a 1.6 MB one do not fail together.
 * The result is the worst shape this bug has: a block of the city that stops
 * the player, draws nothing, and never repairs itself, caused by a network blip
 * that lasted 200 ms.
 *
 * `world/terrain.ts` already had the answer and the streamer did not use it. A
 * **404 or 410 is a fact about the build** -- the pipeline did not emit that
 * tile -- and asking again produces the identical 404 until somebody re-runs
 * the pipeline, so it is remembered for the session. **Everything else is a
 * fact about one moment** -- a dropped connection, a 5xx, an abandoned request,
 * a decode that threw -- and is retried on a widening backoff.
 *
 * The backoff numbers are chosen against what a player is doing rather than
 * against the network. 5 s is inside the time it takes to walk a block, so the
 * common case -- one flaky request while the city streams in -- repairs itself
 * before the player has left the tile. 15 s and 45 s cover a lift-and-drop of a
 * whole connection. The 2-minute steady state is for a tab that has genuinely
 * lost its network: retrying a 1.6 MB payload every two minutes is a rounding
 * error against the streaming the tab is not doing, and it means the city
 * repairs itself within two minutes of the connection coming back with nothing
 * for the player to press.
 *
 * ---------------------------------------------------------------------------
 * 2. WHY COLLISION MAY ONLY BE DROPPED A LONG WAY AWAY.
 *
 * The second defect is not a failure at all, it is a lifetime mismatch.
 * `CollisionWorld` never evicted anything -- its tile map only ever grew -- and
 * the streamer evicts geometry the moment a tile leaves the 1,800 m render
 * radius. So every tile the player has *ever* been within 420 m of keeps its
 * prisms forever, and any of those the player walks 1.8 km away from loses its
 * geometry. Walk back and the two are guaranteed to disagree: collision
 * resident, geometry evicted and re-queued. Measured on the shipped build, a
 * lap out of the CBD and back put **676 walls across 6 tiles** into the
 * hazard overlay every single time, with no network fault anywhere in it.
 *
 * The fix is to give collision the same lifetime as geometry -- but collision
 * is *safety*, and geometry is not. A tile whose geometry is missing is a hole
 * in the picture; a tile whose collision is missing is a player walking through
 * a warehouse and, online, being rewound into it by a server that still has the
 * prisms. So the eviction is one-directional and heavily hysteretic:
 *
 *     collision may be dropped only when the tile's geometry has just been
 *     dropped AND the tile is at least COLLISION_KEEP_RADIUS_M away.
 *
 * `COLLISION_KEEP_RADIUS_M` is 1,000 m against the 420 m ring `main.ts` loads
 * on, which is the ring plus a whole tile plus 80 m. Three things make that
 * safe, and they compound:
 *
 *   - Geometry eviction happens at *1,800 m* (out of the render radius) or, in
 *     the budget path, to the furthest tiles of a set that only reaches 1,800 m.
 *     So this bound is never the binding one -- it is the assertion that a
 *     future radius change cannot quietly make it binding.
 *   - Coming back, `main.ts` starts re-fetching at 420 m, and the player then
 *     has to cross 420 m more to touch the tile at all. At a 8 m/s sprint that
 *     is 52 seconds of warning for a 9 kB request.
 *   - The 580 m between the two radii is longer than a tile, so no tile can sit
 *     inside the load ring and outside the keep ring at the same time, which is
 *     the state that would thrash.
 */

/**
 * What a failed tile load says about the world.
 *
 * `permanent` is a claim about the *build*: this tile is not in it, and no
 * amount of asking will change that before somebody re-runs the pipeline.
 * `transient` is a claim about *this moment* and nothing else.
 */
export type TileFailure = 'transient' | 'permanent';

/**
 * A fetch that came back with a status, carried as a number rather than as
 * prose.
 *
 * `cdn.fetchWorldBuffer` throws `new Error('tiles/5_-1.glb 404')`, which is a
 * perfectly good message and a poor sum type: classifying on a regex over a
 * human-readable string is the kind of thing that works until somebody
 * translates a message or a proxy appends its own text. The streamer throws
 * this instead, and `classifyTileFailure` still falls back to the regex for
 * anything thrown from further away.
 */
export class TileFetchError extends Error {
  readonly status: number;
  constructor(path: string, status: number) {
    super(`${path} ${status}`);
    this.name = 'TileFetchError';
    this.status = status;
  }
}

/**
 * The statuses that mean "this file is not in this build".
 *
 * 404 and 410 and nothing else. Not 403, which is a misconfigured bucket and
 * repairs itself when somebody fixes the policy; not 429, which is explicitly
 * "ask again later"; not any 5xx, which is the origin having a bad minute.
 * Every one of those is retried, because the cost of retrying something that
 * will never work is one request every two minutes and the cost of *not*
 * retrying something that would have worked is a permanent invisible wall.
 */
const PERMANENT_STATUS = new Set([404, 410]);

/** Trailing status code in a `fetchWorldBuffer`-style message. See the class above. */
const STATUS_IN_MESSAGE = /(?:^|\s)(\d{3})\s*$/;

/**
 * Is this thrown value a fact about the build, or about the moment?
 *
 * Defaults to `transient` for everything it cannot read, and that default is
 * the whole safety argument: mistaking a permanent failure for a transient one
 * costs one request every two minutes, and mistaking a transient one for a
 * permanent one costs a tile for the rest of the session.
 */
export function classifyTileFailure(err: unknown): TileFailure {
  const status =
    err instanceof TileFetchError
      ? err.status
      : typeof err === 'object' && err !== null && typeof (err as { status?: unknown }).status === 'number'
        ? (err as { status: number }).status
        : err instanceof Error
          ? Number(STATUS_IN_MESSAGE.exec(err.message)?.[1] ?? Number.NaN)
          : Number.NaN;
  return Number.isFinite(status) && PERMANENT_STATUS.has(status) ? 'permanent' : 'transient';
}

/**
 * The backoff, in milliseconds, for the first three attempts. See the header
 * for why these three numbers and not others.
 */
export const RETRY_BACKOFF_MS: readonly number[] = [5_000, 15_000, 45_000];

/** And the steady state after them, for as long as the tile stays in radius. */
export const RETRY_STEADY_MS = 120_000;

/** How long after the `n`th consecutive failure the next attempt may run. */
export function retryDelayMs(attempt: number): number {
  if (attempt <= 0) return 0;
  return attempt <= RETRY_BACKOFF_MS.length ? RETRY_BACKOFF_MS[attempt - 1] : RETRY_STEADY_MS;
}

/** What the ledger remembers about a tile that is still being retried. */
export interface TileRetryState {
  /** Consecutive failures. Reset to zero by `clear`, never decremented. */
  attempts: number;
  /** Wall clock, milliseconds, at which the next attempt may run. */
  nextAt: number;
  /** The last thing that went wrong, for the console and the overlay. */
  reason: string;
}

/**
 * Which tiles are being retried, which are gone for good, and when to ask again.
 *
 * A class rather than two maps on the streamer because it is the piece with the
 * arithmetic in it, and the arithmetic is what a check can hold still. It knows
 * nothing about tiles beyond their keys and takes `now` from its caller, so a
 * check drives it with a number rather than with a clock.
 */
export class TileRetryLedger {
  private readonly retrying = new Map<string, TileRetryState>();
  /** Key to the reason it will never load. Session-lifetime by construction. */
  private readonly permanent = new Map<string, string>();

  /**
   * Record a failure that may repair itself, and say when to try again.
   *
   * Idempotent in the sense that matters: the attempt counter climbs, so the
   * fourth failure of one tile waits two minutes rather than five seconds
   * however the failures were interleaved with other tiles'.
   */
  noteTransient(key: string, now: number, reason: string): TileRetryState {
    const prior = this.retrying.get(key);
    const attempts = (prior?.attempts ?? 0) + 1;
    const state: TileRetryState = { attempts, nextAt: now + retryDelayMs(attempts), reason };
    this.retrying.set(key, state);
    return state;
  }

  /**
   * Record a failure that will not repair itself. Returns true exactly once per
   * key, which is what lets the caller log a build defect without logging it
   * sixty times a second.
   */
  notePermanent(key: string, reason: string): boolean {
    if (this.permanent.has(key)) return false;
    this.permanent.set(key, reason);
    // A tile that turns out to be absent from the build stops being a retry --
    // otherwise it would be counted in both readouts at once and the HUD's two
    // numbers would not add up to the tiles anybody is waiting on.
    this.retrying.delete(key);
    return true;
  }

  /** The tile loaded. Forget everything, including the attempt count. */
  clear(key: string): void {
    this.retrying.delete(key);
  }

  /**
   * Forget a key entirely, **including a permanent verdict**.
   *
   * Deliberately not `clear`, and deliberately not reachable from the load
   * path: a 404 that could be un-remembered by anything the streamer does on
   * its own is not a suppression. This exists for the two callers outside it --
   * a console that wants to force one more attempt after re-running the
   * pipeline into a live tab, and the self-check, which drives a synthetic key
   * through the real ledger and must not leave a phantom absent tile behind on
   * the overlay.
   */
  forget(key: string): void {
    this.retrying.delete(key);
    this.permanent.delete(key);
  }

  /**
   * May this tile be requested now?
   *
   * False for a permanently absent tile forever, false for a tile inside its
   * backoff, true for everything else -- including every tile that has never
   * failed, which is the overwhelming majority and is one `Map.get` miss.
   */
  ready(key: string, now: number): boolean {
    if (this.permanent.has(key)) return false;
    const state = this.retrying.get(key);
    return state === undefined || now >= state.nextAt;
  }

  isRetrying(key: string): boolean {
    return this.retrying.has(key);
  }

  isPermanent(key: string): boolean {
    return this.permanent.has(key);
  }

  attemptsOf(key: string): number {
    return this.retrying.get(key)?.attempts ?? 0;
  }

  /** Milliseconds until this tile may be asked for again; 0 if it may be now. */
  nextRetryInMs(key: string, now: number): number {
    const state = this.retrying.get(key);
    if (state === undefined) return 0;
    return Math.max(0, state.nextAt - now);
  }

  /**
   * The soonest any retry is due, milliseconds, or `Infinity` when nothing is
   * waiting. What the HUD's countdown reads.
   */
  soonestRetryInMs(now: number): number {
    let soonest = Infinity;
    for (const state of this.retrying.values()) {
      const wait = Math.max(0, state.nextAt - now);
      if (wait < soonest) soonest = wait;
    }
    return soonest;
  }

  get retryingCount(): number {
    return this.retrying.size;
  }

  get permanentCount(): number {
    return this.permanent.size;
  }

  /** The absent tiles and why, for the console. A build defect worth naming. */
  permanentEntries(): Array<[string, string]> {
    return [...this.permanent];
  }
}

/**
 * The ring `main.ts` fetches collision on, restated here so the eviction rule
 * can be read against it in one place. Changing it there without changing it
 * here is what `verifyTileLifecycle` case 4 exists to catch.
 */
export const COLLISION_LOAD_RADIUS_M = 420;

/**
 * A tile whose near edge is closer than this keeps its prisms whatever the
 * renderer does with its geometry. See the header, part 2.
 */
export const COLLISION_KEEP_RADIUS_M = 1000;

/**
 * May the tile at this distance have its collision dropped?
 *
 * Called only from the geometry eviction path, so the question it is really
 * answering is "is this tile far enough away that losing its prisms cannot
 * reach the player before `main.ts` has fetched them back".
 */
export function mayEvictCollision(distanceM: number): boolean {
  return distanceM >= COLLISION_KEEP_RADIUS_M;
}

/**
 * Boot check. Arithmetic only -- no network, no scene, no clock.
 *
 * Every case here is a way one of these two rules fails *silently*: a
 * misclassified status is a tile that never comes back and nothing says so, and
 * a keep radius that slipped under the load radius is prisms disappearing from
 * under a player's feet with no error anywhere.
 */
/** What a tile is, from the outside. See `tilePhaseOf`. */
export type TilePhase = 'built' | 'building' | 'loading' | 'failed' | 'missing' | 'absent';

/** The flags `TileStreamer` holds about one tile. */
export interface TileFlags {
  /** Its geometry has been constructed and inserted into the scene. */
  loaded: boolean;
  /**
   * Its pipelines have been compiled, so it is allowed to draw.
   *
   * `TileStreamer` sets this after a `compileAsync` over the tile's group, and
   * its visibility test is `tile.group.visible = tile.warm && ...`. A tile that
   * is loaded and not warm is **in the scene and not on the screen**.
   */
  warm: boolean;
  building: boolean;
  loading: boolean;
  permanent: boolean;
  retrying: boolean;
}

/**
 * What phase one tile is in, and `built` means *the player can see it*.
 *
 * **It used to mean "the geometry is resident", and that cost the owner a wall
 * at Lilyfield.** The streamer draws a tile only when `warm` is set, which is
 * after a `compileAsync` over the whole tile group -- so between the geometry
 * landing and the pipelines finishing there is a window where the tile is in
 * the scene, invisible, and its collision prisms are solid. That window is the
 * invisible wall this codebase has been chasing, and reporting it as `built`
 * hid it from the two things built to catch it: `world/invisible-walls.ts`
 * skips any tile whose phase is `built`, so it drew no hazard, and
 * `world/wallghosts.ts` only draws a box where there is a hazard -- so the one
 * feature whose entire job is "show the player what stopped them" was switched
 * off by a word meaning the wrong thing.
 *
 * A tile that is loaded and not warm reports `building`, which is what it is:
 * still being made ready. Nothing downstream needed a new case, and every
 * consumer got more correct for free -- including
 * `world/collision-window-check.ts`, which will now measure the true width of
 * the window rather than the half of it that ends at residency.
 *
 * Here rather than on the streamer because the streamer imports three and this
 * file does not, which is the difference between a rule a check can hold still
 * and one that needs a renderer to ask.
 */
export function tilePhaseOf(f: TileFlags): TilePhase {
  if (f.loaded) return f.warm ? 'built' : 'building';
  if (f.building) return 'building';
  if (f.loading) return 'loading';
  if (f.permanent) return 'missing';
  if (f.retrying) return 'failed';
  return 'absent';
}

export function verifyTileLifecycle(): string[] {
  const failures: string[] = [];

  // --- `built` means the player can see it.
  //
  // The whole of the Lilyfield wall. A tile in the scene whose pipelines have
  // not compiled is invisible and solid, and calling that `built` switched off
  // both things written to catch it: `invisible-walls` skips a built tile, and
  // `wallghosts` only draws where `invisible-walls` found a hazard.
  {
    const flags = (over: Partial<TileFlags>): TileFlags => ({
      loaded: false,
      warm: false,
      building: false,
      loading: false,
      permanent: false,
      retrying: false,
      ...over,
    });
    if (tilePhaseOf(flags({ loaded: true, warm: false })) === 'built') {
      failures.push(
        'a tile that is in the scene but not warm reported `built`. It is invisible and its prisms are ' +
          'solid, and every hazard check skips a built tile -- which is an invisible wall with the one ' +
          'overlay that would have shown it switched off.',
      );
    }
    if (tilePhaseOf(flags({ loaded: true, warm: true })) !== 'built') {
      failures.push('a drawn tile did not report `built`; the map would hatch the whole city as a hazard.');
    }
    if (tilePhaseOf(flags({ loaded: true, warm: false })) !== 'building') {
      failures.push('a loaded-but-unwarm tile did not report `building`.');
    }
    // The rest of the ladder, in the order the streamer checks it.
    if (tilePhaseOf(flags({ building: true })) !== 'building') failures.push('a decoded tile did not report `building`.');
    if (tilePhaseOf(flags({ loading: true })) !== 'loading') failures.push('an in-flight tile did not report `loading`.');
    if (tilePhaseOf(flags({ permanent: true })) !== 'missing') failures.push('a 404 tile did not report `missing`.');
    if (tilePhaseOf(flags({ retrying: true })) !== 'failed') failures.push('a backing-off tile did not report `failed`.');
    if (tilePhaseOf(flags({})) !== 'absent') failures.push('an unknown tile did not report `absent`.');
    // Residency outranks the rest: a loaded tile is never "loading" again.
    if (tilePhaseOf(flags({ loaded: true, warm: true, loading: true })) !== 'built') {
      failures.push('a drawn tile that is also re-fetching reported something other than `built`.');
    }
  }

  // --- 1. The taxonomy. Both directions, because both are silent.
  {
    const permanent: unknown[] = [
      new TileFetchError('tiles/5_-1.glb', 404),
      new TileFetchError('tiles/5_-1.params.bin', 410),
      new Error('tiles/5_-1.glb 404'),
      { status: 404 },
    ];
    for (const err of permanent) {
      if (classifyTileFailure(err) !== 'permanent') {
        failures.push(
          `A 404/410 was classified transient (${String(err)}). The streamer would re-fetch a ` +
            'tile the build does not contain every two minutes forever.',
        );
      }
    }
    const transient: unknown[] = [
      new TileFetchError('tiles/5_-1.glb', 500),
      new TileFetchError('tiles/5_-1.glb', 502),
      new TileFetchError('tiles/5_-1.glb', 429),
      new TileFetchError('tiles/5_-1.glb', 403),
      new Error('The operation was aborted'),
      new Error('NetworkError when attempting to fetch resource.'),
      new DOMException('signal timed out', 'TimeoutError'),
      'decode worker died',
      null,
      undefined,
    ];
    for (const err of transient) {
      if (classifyTileFailure(err) !== 'transient') {
        failures.push(
          `A transient failure was classified permanent (${String(err)}). That tile's geometry ` +
            'would never be requested again and its collision is an invisible wall for the session.',
        );
      }
    }
  }

  // --- 2. The backoff widens, and it stops widening.
  {
    const want = [5_000, 15_000, 45_000, 120_000, 120_000];
    for (let attempt = 1; attempt <= want.length; attempt++) {
      const got = retryDelayMs(attempt);
      if (got !== want[attempt - 1]) {
        failures.push(`Attempt ${attempt} waits ${got} ms; the schedule says ${want[attempt - 1]} ms.`);
      }
    }
    for (let attempt = 2; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
      if (retryDelayMs(attempt) <= retryDelayMs(attempt - 1)) {
        failures.push('The retry backoff does not widen; a tile that keeps failing would hammer the origin.');
      }
    }
  }

  // --- 3. The ledger: a transient failure retries and a success forgets it.
  //
  // The success clause is the one worth asserting. Without it the attempt
  // counter survives a load, so a tile that failed twice hours ago and has
  // loaded a hundred times since would wait 45 s on its next hiccup.
  {
    const ledger = new TileRetryLedger();
    const t0 = 1_000_000;
    if (!ledger.ready('a', t0)) failures.push('A tile that has never failed was not ready to load.');

    ledger.noteTransient('a', t0, 'fetch failed');
    if (ledger.ready('a', t0)) failures.push('A tile was retried in the same millisecond it failed.');
    if (ledger.ready('a', t0 + 4_999)) failures.push('A tile was retried before its 5 s backoff elapsed.');
    if (!ledger.ready('a', t0 + 5_000)) failures.push('A tile was not retried after its 5 s backoff elapsed.');
    if (ledger.retryingCount !== 1) failures.push(`The ledger reports ${ledger.retryingCount} tiles retrying, not 1.`);
    if (Math.round(ledger.nextRetryInMs('a', t0 + 2_000) / 1000) !== 3) {
      failures.push('The retry countdown does not read the seconds remaining.');
    }

    ledger.noteTransient('a', t0 + 5_000, 'fetch failed');
    if (ledger.ready('a', t0 + 5_000 + 14_999)) failures.push('The second attempt did not widen to 15 s.');
    if (!ledger.ready('a', t0 + 5_000 + 15_000)) failures.push('The second attempt widened past 15 s.');

    ledger.clear('a');
    if (!ledger.ready('a', t0)) failures.push('A tile that loaded was still held by its old backoff.');
    if (ledger.retryingCount !== 0) failures.push('A tile that loaded is still counted as retrying.');
    ledger.noteTransient('a', t0, 'fetch failed');
    if (!ledger.ready('a', t0 + 5_000)) {
      failures.push('The attempt count survived a successful load; the next hiccup would wait too long.');
    }

    // And the permanent side: suppressed forever, counted once, logged once.
    if (!ledger.notePermanent('b', '404')) failures.push('The first permanent failure did not report itself as new.');
    if (ledger.notePermanent('b', '404')) failures.push('A permanent failure reported itself as new twice; it would log forever.');
    if (ledger.ready('b', t0 + 86_400_000)) failures.push('A 404 tile was retried a day later.');
    if (ledger.permanentCount !== 1) failures.push(`The ledger reports ${ledger.permanentCount} absent tiles, not 1.`);
    if (ledger.isRetrying('b')) failures.push('A tile is counted as both retrying and permanently absent.');

    // The countdown across several tiles is the soonest of them, which is what
    // a one-line HUD readout can honestly say.
    const many = new TileRetryLedger();
    many.noteTransient('x', t0, 'fetch failed');
    many.noteTransient('y', t0, 'fetch failed');
    many.noteTransient('y', t0, 'fetch failed');
    if (Math.round(many.soonestRetryInMs(t0) / 1000) !== 5) {
      failures.push('The soonest retry is not the soonest of the tiles waiting.');
    }
    if (many.soonestRetryInMs(t0 + 60_000) !== 0) failures.push('A retry that is overdue does not read zero.');
    if (new TileRetryLedger().soonestRetryInMs(t0) !== Infinity) {
      failures.push('An empty ledger claims a retry is due.');
    }
  }

  // --- 4. The safety radius, against the ring `main.ts` actually loads on.
  //
  // The clause that matters is the *gap*: it has to exceed one tile, or a tile
  // could be outside the keep ring and inside the load ring at the same time
  // and would be dropped and re-fetched on alternate frames forever -- with the
  // player inside the gap, which is to say inside the tile.
  {
    if (COLLISION_KEEP_RADIUS_M <= COLLISION_LOAD_RADIUS_M) {
      failures.push(
        `Collision is dropped at ${COLLISION_KEEP_RADIUS_M} m and re-fetched at ` +
          `${COLLISION_LOAD_RADIUS_M} m. The player would lose the prisms under their feet.`,
      );
    }
    if (COLLISION_KEEP_RADIUS_M - COLLISION_LOAD_RADIUS_M < 500) {
      failures.push(
        'The gap between the collision keep radius and the load radius is under one tile; ' +
          'a tile can be dropped and re-fetched on alternate frames.',
      );
    }
    if (mayEvictCollision(0) || mayEvictCollision(COLLISION_LOAD_RADIUS_M) || mayEvictCollision(COLLISION_KEEP_RADIUS_M - 1)) {
      failures.push('Collision may be evicted for a tile the player is standing in or near.');
    }
    if (!mayEvictCollision(COLLISION_KEEP_RADIUS_M) || !mayEvictCollision(1800)) {
      failures.push('Collision is never evicted, so a revisited tile is a guaranteed invisible wall.');
    }
  }

  return failures;
}
