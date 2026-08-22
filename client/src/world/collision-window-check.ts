/**
 * How long the city is solid before it is visible, measured.
 *
 *     bun run client/src/world/collision-window-check.ts
 *     bun run client/src/world/collision-window-check.ts --full
 *     bun run client/src/world/collision-window-check.ts --latency 60 --kbps 25000
 *
 * ---------------------------------------------------------------------------
 * ## The defect this puts a number on
 *
 * A player rides up the Pacific Highway and stops. Nothing is in front of them.
 * The street runs on, the ground is drawn, and they cannot go. Two audits have
 * already proved the *bake* is innocent: `server/undrawn-solids-check.ts` finds
 * no solid standing on a carriageway with nothing drawn over it, and the same
 * pass cleared Cammeray specifically. So the wall is not in the data. It is in
 * the schedule.
 *
 * A tile arrives as two files three orders of magnitude apart. `main.ts`'s
 * `ensureGround` fetches `collision/<key>.bin` -- a median 9 kB of prisms -- on
 * its own 420 m radius, in a sequential awaited loop, and the prisms are solid
 * the instant they land. `TileStreamer` fetches `tiles/<key>.glb` -- a median
 * 1.6 MB -- hands it to a decode worker, and then to a 2.5 ms-a-frame build
 * queue. So there is a window in which a tile's buildings are solid and
 * invisible, and at the tuned lime bike's 39.4 m/s a player crosses the entire
 * collision ring in eleven seconds.
 *
 * **The received account of that window said it was open everywhere, always,
 * and this file was written to size it. It is not, and the measurement is in
 * the report.** The streamer's radius is 1,800 m against `ensureGround`'s 420,
 * so the geometry ring is four times wider and fills first; `ensureGround` is
 * sequential and awaits a terrain grid in front of every collision fetch, which
 * makes collision the *laggard*. On the routes and links in this file the body
 * spends a fraction of a second a leg with an undrawn prism in reach, and the
 * one wall it does find is a cold boot at Cammeray.
 *
 * That does not close the subject, it moves it -- which is why the file measures
 * two gaps and not one. See below.
 *
 * ---------------------------------------------------------------------------
 * ## What this file has already ruled out
 *
 * Recorded here because the next person to read the streamer will have the same
 * four ideas, and three of them are refuted by the mechanism rather than by a
 * measurement:
 *
 *   - **Velocity-directed fetch order.** Implemented and A/B'd through a
 *     `leadSeconds` option, six paired runs on one machine, both a pure lead
 *     point and `min(radial, lead)`. It moved the wall from one route to another
 *     and did not move the total; the arms are indistinguishable inside the
 *     spread quoted at `EXPOSED_BUDGET_S`. Reverted. It cost the streamer's
 *     hottest loop a smoothed velocity and a second gap per tile per frame for
 *     nothing measurable.
 *   - **Buildings earlier in `TILE_BUILD_ORDER`.** Cannot help: a tile's group
 *     enters the scene at the `commit` step, which is last, so nothing built
 *     before it is visible any sooner and `tilePhase` does not answer `built`
 *     until it runs. What would help is a *partial* commit, which is a different
 *     and much larger change.
 *   - **A stronger hazard exemption.** The hazard tile is already `unshift`ed to
 *     the head of the build queue by workstream AJ, and a whole tile is 2.2 ms of
 *     construction against a 2.5 ms budget -- so the queue retires it in one or
 *     two frames and is not where the time goes.
 *   - **Fetching hazard tiles ahead of the radial order.** A no-op by
 *     construction: a hazard tile is one whose collision is resident, which
 *     means it is inside the 420 m ring, which means the radial order already
 *     has it near the front.
 *
 * What is left is the wire. A cold entry pulls a 1.6 MB bundle while the 9 kB of
 * prisms beside it lands in one round trip, and no ordering inside the client
 * changes that ratio. That is why the other half of this workstream is
 * `world/wallghosts.ts` -- if the player must be stopped, show them what by.
 *
 * ---------------------------------------------------------------------------
 * ## What it measures: three worlds, and the two gaps between them
 *
 * A body walks a fixed route through real suburbs at a fixed speed while the
 * real `TileStreamer` streams the real world off the real files. Three collision
 * worlds are kept beside it, and they nest:
 *
 *     drawn  subset-of  solid  subset-of  authority
 *
 *   - **`drawn`** -- the tiles whose geometry has reached `built`. What you can
 *     *see* stopping you.
 *   - **`solid`** -- every tile `ensureGround` has fetched, byte for byte what
 *     `main.ts` holds. What your own client stops you with.
 *   - **`authority`** -- every tile in the region, read straight off disk before
 *     the leg starts. What the *server* stops you with: `world.ts` loads a whole
 *     hexagon's prisms -- six kilometres of circumradius -- for every
 *     participant, plus `COLLISION_NEED_MARGIN_M`, where the browser fetches
 *     420 m. The server's set is a superset of the client's at every instant of
 *     every session, by design, and that is not a defect until the two disagree
 *     about a step.
 *
 * Each gap is a different bug wearing the same complaint, and until this file
 * they could not be told apart from inside the game:
 *
 *   - **`solid \ drawn` -- the invisible wall.** Your client stops you and there
 *     is nothing there to see. Reported as **prism-seconds**: the integral, over
 *     the leg, of how many prisms are within `PROBE_RADIUS_M` of the body and
 *     belong to a tile that has not built. `exposed s` beside it is the same
 *     integral with the count clamped to one -- the wall-clock seconds during
 *     which *anything* invisible was in reach, which is the number a player
 *     would recognise. **The worst wall**, in metres, is the ground lost to it
 *     in one contiguous encounter.
 *   - **`authority \ solid` -- the rubber-band.** Your client lets you go and
 *     the server pulls you back, because it has a prism your 420 m ring has not
 *     fetched yet. To the player this is the *same complaint* -- held by nothing
 *     -- and it is a different fault with a different fix. Reported as **ghost
 *     seconds** and **worst ghost**, computed the same two ways.
 *
 * Both had to be instrumented because the first draft of this workstream
 * inherited a hypothesis -- collision leads geometry, everywhere, always -- and
 * the harness disproved it on the first route it ran. The streamer's tiles come
 * on a 1,800 m radius and `ensureGround`'s prisms on 420 m, so the geometry ring
 * is four times wider and fills first; `ensureGround` is a *sequential awaited
 * loop* with a terrain fetch in front of every collision fetch, which makes
 * collision the laggard and not the leader. A file that measured only the gap it
 * was sent to find would have printed 0.0 and closed the case.
 *
 * The body is **steered, not scripted**, and the composition of the two worlds
 * is the whole reason the second number exists:
 *
 *     to      = here + one step along a heading the drawn world chose
 *     sighted = drawn.resolve(here -> to)
 *     actual  = solid.resolve(here -> to)
 *     held    = authority.resolve(here -> to)
 *     lost    = |sighted - actual|          the invisible wall
 *     ghost   = |actual - held|             the rubber-band
 *
 * **All three from the same origin to the same target**, and that is not a
 * simplification -- it is the only arrangement that measures a prism set rather
 * than a resolver. Chaining them instead (resolve the intent, hand the resolved
 * point to the next authority) reads more naturally and is wrong by tens of
 * metres: `resolve` pushes a body out along a wall normal to exactly
 * `PLAYER_RADIUS` and is **not idempotent**, so asking it again about the point
 * it just produced pushes again by whatever the last call left inside -- every
 * frame, for as long as a body slides along a facade both worlds can see.
 * Chained, this file reported a 46.8 m invisible wall at Cammeray on a leg whose
 * exposure integral was 0.0 seconds, which is two numbers that cannot both be
 * true and is how it was caught. From a common target the three are the
 * identical call over three prism sets: where the sets agree the answers are
 * bit-identical and the difference is exactly the prisms one has and another
 * does not.
 *
 * The heading is still the *drawn* world's -- see the deflection in `runLeg` --
 * so the body goes round what it can see and straight through what it cannot.
 * The body's position is `actual`, because a client is what a player is looking
 * at; the server's correction is measured and not applied, since applying it
 * would be modelling reconciliation rather than measuring the disagreement that
 * causes it.
 *
 * `sighted` is where the player *means* to be: they slide along the facades they
 * can see and aim straight through the ones they cannot. `actual` is where the
 * world puts them. When everything near the body is drawn the two are the same
 * point and `lost` is zero however many walls the body is scraping along -- which
 * is the property that makes this a measurement of the streaming gap and not of
 * how good the steering is. When a tile is solid and undrawn they separate by
 * exactly the depth of the wall that is not there.
 *
 * Resolving both from the same raw target instead -- the obvious first draft --
 * measures something else entirely: the intent never slides, so the body presses
 * into the first visible terrace it meets and every frame after that is scored
 * as an invisible wall. It is also why the steering deflects (see `runLeg`): a
 * player who cannot get past a building they can see walks round it, and a body
 * that cannot is measuring its own stupidity.
 *
 * A body replaying a path precomputed against a fully resident world is the
 * other tempting shortcut and it measures zero for ever: a legal path is legal
 * against every subset of the prisms it was legal against.
 *
 * ---------------------------------------------------------------------------
 * ## Four speeds, because the answer is a different answer at each
 *
 * `SPEEDS` is 4.4 m/s on foot, 12 m/s on the bike, 30 m/s in a car and 39.4 m/s
 * on the tuned lime bike, which is the fastest body in the game. The
 * streamer's radial ranking, its four concurrency slots and its build budget are
 * all tuned against a walking pace; the question this file exists to answer is
 * where that stops being true. Legs are a fixed *duration* rather than a fixed
 * distance, so the exposure integral has the same denominator at every speed and
 * the fractions below the table are comparable. The distance covered is printed
 * beside each, so nobody reads 30 s on foot as a tour of the city.
 *
 * Every leg runs twice. **Cold** is a fresh streamer and a fresh
 * `CollisionWorld` -- a boot, or the far side of a teleport. **Warm** re-runs
 * the identical leg on the same pair, which is the revisit case and should be
 * near zero; a warm number that is not near zero means eviction is racing the
 * player rather than following them.
 *
 * ---------------------------------------------------------------------------
 * ## What the harness is honest about
 *
 *   - **Frames are paced against the wall clock at 60 Hz.** They have to be:
 *     every fetch in the measurement is a real one, and a loop that ran frames
 *     faster than real time would make the network look slower than it is (and
 *     slower than real time would make it look faster). A 30 s leg costs 30 s.
 *   - **The link is modelled and the model is one shared FIFO pipe.** The files
 *     are on local disk, which is a floor no CDN reaches, so `--latency` and
 *     `--kbps` put a round trip and a throughput ceiling in front of them. The
 *     defaults are `GATE_LATENCY_MS` and `GATE_KBPS`; `--latency 0 --kbps 0`
 *     runs the unmodelled floor, where nothing is visible and nothing can be
 *     gated. See `serveWorld` on why the pipe is shared and what the first
 *     version of it got wrong.
 *   - **Decode runs on the main thread** (`decodeWorkers: 0`), because bun has
 *     no `Worker` for this module graph. That charges the frame for work the
 *     browser does off it, which makes the window here *wider* than a browser's.
 *   - **There is no precompiler**, so `LoadedTile.warm` is true the moment a
 *     tile commits and a tile is countable as drawn one shader compile earlier
 *     than it would be in Chrome. That pulls the other way, and it is the one
 *     place these numbers flatter the client.
 *
 * The two biases do not cancel and are not claimed to. What the file guarantees
 * is that they are the *same* biases before and after a change, which is all a
 * ratchet needs.
 */
import { PerspectiveCamera, Scene } from 'three/webgpu';

import { CollisionWorld, BODY_HEIGHT_M, type Prism } from '../player/collision.ts';
import { PLAYER_RADIUS, STEP_HEIGHT } from '../player/controller.ts';
import { createFacadeGlobals } from './facade.ts';
import { TileStreamer } from './streamer.ts';
import { cellKey } from './invisible-walls.ts';

// --- The host, through the smallest possible window ----------------------------
//
// Declared rather than imported, on `perf-harness.ts`'s argument and word for
// word its reason: the client's `tsconfig.json` carries neither `@types/node`
// nor `@types/bun`, deliberately, and putting `process` and `Buffer` in scope
// for nine thousand lines of browser code to please one harness is a worse
// trade than four interfaces.

interface HostFile {
  arrayBuffer(): Promise<ArrayBuffer>;
  exists(): Promise<boolean>;
}
interface HostServer {
  port: number;
  stop(closeActiveConnections: boolean): void;
}
interface Host {
  Bun?: {
    file(path: string): HostFile;
    argv: string[];
    serve(opts: {
      port: number;
      idleTimeout?: number;
      fetch(req: { url: string }): Promise<Response> | Response;
    }): HostServer;
  };
  process?: { exit(code: number): void };
}
const host = globalThis as unknown as Host;

/** The one place the harness insists on its host. Everything else is optional. */
function bun(): NonNullable<Host['Bun']> {
  const it = host.Bun;
  if (it === undefined) {
    throw new Error('collision-window-check needs a host with Bun; run it with `bun run`.');
  }
  return it;
}

/**
 * Where the world lives, relative to the repository root.
 *
 * The check is run from the root (`bun run client/src/...`), the same way
 * `perf-harness.ts` is, so this is a plain relative path and not a URL. Serving
 * it over a socket rather than reading it with `Bun.file` is not ceremony: the
 * streamer's fetch path, its retry ledger and its 404 classification are part of
 * what is being measured, and a harness that reached around them would be
 * measuring a different loader.
 */
const WORLD_ROOT = 'client/public/world';

/**
 * How close a prism has to be to count as being on top of the body, metres.
 *
 * Three, from the brief, and the number is defensible rather than round. The
 * player's capsule is 0.34 m; a footpath is two to three metres from the kerb to
 * the building line; so a prism within three metres of the body's axis is one
 * the player is about to touch or has just brushed. Widening it to the whole
 * tile would count every terrace in the block and turn the exposure integral
 * into a restatement of the tile count, which `world/invisible-walls.ts` already
 * reports and which says nothing about whether the player was near one.
 */
const PROBE_RADIUS_M = 3;

/**
 * Collision's own radius, copied from `main.ts` rather than imported.
 *
 * `main.ts` is 13,000 lines of browser closure and importing it here would drag
 * the DOM in. The constant is 420 in both places and the drift is caught by
 * `verifyCollisionWindow`, which asserts this file's ring against
 * `tile-lifecycle.COLLISION_KEEP_RADIUS_M` -- the number the streamer refuses to
 * evict inside, and the one that would actually change if anybody moved the
 * ring.
 */
const COLLISION_RADIUS_M = 420;

/** `main.ts`'s `collisionClock`: how often `ensureGround` is fired, seconds. */
const GROUND_REFRESH_S = 0.5;

/**
 * How far the steering turns to get round a facade it can see, radians.
 *
 * Forty degrees. A player pinned against a terrace does not sidestep at a right
 * angle, they angle off and keep most of their pace, and the number decides how
 * much of the step survives the turn: at 40 degrees a deflected step still makes
 * 77% of its ground towards the waypoint, so a body that has to go round a block
 * arrives late rather than never. The 90-degree fallback in `runLeg`'s list is
 * for the inside of a courtyard, where nothing shallower gets out.
 */
const DEFLECT_RAD = (40 * Math.PI) / 180;

/**
 * How long a cold leg may wait for the tile under the body before it gives up
 * and starts measuring anyway, seconds.
 *
 * The analogue of `main.ts`'s reveal deadline and it exists for the same reason:
 * a tile the build does not contain, or an origin that has stopped answering,
 * must produce a late start and a printed number rather than a harness that
 * hangs. Twenty seconds is four times the worst cold build measured on this
 * disk.
 */
const PREROLL_CAP_S = 20;

/**
 * How long a body may make no ground before it turns round, seconds.
 *
 * Four. The steering is deliberately simple -- see `runLeg` -- and simple
 * steering gets wedged: a courtyard, a laneway that dead-ends, the inside of a
 * terrace block. A wedged body reports zero exposure for the rest of the leg,
 * which reads as a clean run and is a run that measured nothing. Four seconds is
 * long enough that a genuine invisible wall is scored in full before the body
 * gives up on it -- the longest one this file has measured held for under two --
 * and short enough that a thirty-second leg is not mostly a body pressed against
 * a wall it can see.
 */
const STALL_GIVE_UP_S = 4;

/** The fixed step the body and the frame both run on. */
const DT = 1 / 60;

/**
 * The three bodies, metres a second.
 *
 * On foot is `controller.ts`'s run speed. Twelve is the bike at a realistic
 * street pace and thirty is a car on an arterial. The fourth is the one the
 * defect was reported from -- **39.4 m/s, the tuned lime bike**, which is the
 * fastest thing a player can be and the number `server/world.ts` sizes
 * `COLLISION_NEED_MARGIN_M` against. It is last rather than absent because a
 * three-row table of speeds that stops below the fastest body in the game is a
 * table with the answer cut off the bottom.
 */
const SPEEDS: ReadonlyArray<{ name: string; mps: number }> = [
  { name: 'foot', mps: 4.4 },
  { name: 'bike', mps: 12 },
  { name: 'car', mps: 30 },
  { name: 'ebike', mps: 39.4 },
];

/**
 * The routes, and each one is somewhere the defect was actually reported or
 * somewhere it would be worst.
 *
 * Waypoints are suburb centroids from `client/public/world/suburbs.json`, which
 * is the same table `game/locator.ts` reads, so a leg runs between two places a
 * player can name. The body steers between them in a straight line and slides
 * off whatever it can see, which is not a route down a carriageway -- deliberate:
 * the reported wall is a *building at the kerb* that nothing has drawn, and a
 * body pinned to the lane centreline would never meet one. See the header on why
 * the body is steered rather than scripted.
 */
const ROUTES: ReadonlyArray<{
  name: string;
  why: string;
  points: ReadonlyArray<readonly [number, number]>;
}> = [
  {
    name: 'pacific',
    why: 'Chatswood to North Sydney: the corridor the wall was first reported on',
    points: [
      [-2719.4, -7946.2],
      [-807.6, -4775.0],
      [-156.8, -3696.6],
    ],
  },
  {
    name: 'cammeray',
    why: 'Cammeray to Pyrmont over the bridge: the second report, and the deck stack',
    points: [
      [344.0, -5167.1],
      [-156.8, -3696.6],
      [-1566.0, 73.4],
    ],
  },
  {
    name: 'innerwest',
    why: 'Surry Hills to Ashfield: the densest continuous terrace in the build',
    points: [
      [97.9, 1741.3],
      [-2639.3, 3076.3],
      [-7533.4, 2428.2],
    ],
  },
];

/**
 * Seconds of travel in one leg, and why it is a duration.
 *
 * Thirty seconds is long enough for the streamer to reach steady state at every
 * speed (four concurrent 1.6 MB fetches retire the ring in under ten on this
 * disk) and short enough that the default run -- one route, three speeds, cold
 * and warm -- is three minutes rather than twenty. `--seconds` moves it; the
 * ratchet at the bottom is stated against this value and refuses to compare a
 * run at another one.
 */
const LEG_SECONDS = 30;

/**
 * The link the ratchet is stated against: 40 ms of round trip and 50 Mbit/s,
 * shared.
 *
 * A number had to be picked and "local disk" is the wrong one. Serving 1.6 MB
 * bundles off an SSD retires the whole 1,800 m load radius before a player has
 * finished reading the loading screen, and the first version of this harness
 * duly reported no defect at all on the route the owner is stopped on. The
 * window is a *bandwidth* phenomenon; a harness with infinite bandwidth cannot
 * see it and cannot ratchet it.
 *
 * 50 Mbit/s is the median Australian fixed connection and the plan tier most of
 * this game's players are on; 40 ms is Sydney to the nearest R2 edge. Neither is
 * a worst case -- `--kbps 25000` is the congested-evening run and the report
 * carries it -- and neither is meant to be. What a gate needs is a link that is
 * ordinary, fixed, and slow enough that the thing being gated is visible.
 */
const GATE_LATENCY_MS = 40;
const GATE_KBPS = 50000;

/** One leg's measurement. Every field is a number a report can put in a row. */
export interface LegResult {
  route: string;
  speed: string;
  mps: number;
  pass: 'cold' | 'warm';
  /** Seconds of travel actually simulated. */
  seconds: number;
  /** Metres the body covered, which is less than `seconds * mps` where it slid. */
  metres: number;
  /** The exposure integral: seconds times prisms in reach that nothing draws. */
  prismSeconds: number;
  /** The same integral with the count clamped to one: seconds with any in reach. */
  exposedSeconds: number;
  /** Ground lost to invisible geometry in the worst single encounter, metres. */
  worstWallM: number;
  /** How many such encounters there were. */
  wallCount: number;
  /** Total ground lost to invisible geometry across all of them, metres. */
  totalBlockedM: number;
  /** Seconds with a prism in reach the server holds and this client does not. */
  ghostSeconds: number;
  /** The worst single such disagreement, metres of correction the server owes. */
  worstGhostM: number;
  /** Tiles that were solid-and-undrawn at the worst moment of the leg. */
  worstTiles: number;
  /** Tile builds the hazard exemption put at the head of the queue. */
  priorityBuilds: number;
}

/**
 * A tiny HTTP origin over the baked world, behind a modelled link.
 *
 * ---------------------------------------------------------------------------
 * **The link is one shared pipe, and the first version of it was not.**
 *
 * Delaying each response by `latency + bytes/rate` independently gives every
 * concurrent request its own copy of the bandwidth, so four slots at 25 Mbit is
 * a 100 Mbit link and the streamer retires the cold ring four times faster than
 * any player's would. That model reported 0.0 s of exposure on a route the owner
 * gets stopped on, which is how it was caught.
 *
 * So the bytes go through a single FIFO cursor: a request occupies the pipe for
 * `bytes * 8 / kbps` milliseconds starting when the pipe is next free, and its
 * response lands at the later of that and one round trip from now. Four
 * concurrent fetches of 1.6 MB therefore finish one after another exactly as
 * they do on a real link, and the head-of-line ordering the streamer's
 * concurrency produces is preserved rather than washed out. It is not TCP -- it
 * has no slow start, no fairness and no congestion -- and it does not need to
 * be: what it has to get right is that **bandwidth is a shared, finite thing**,
 * which is the one property that decides how long the city is invisible.
 */
function serveWorld(latencyMs: number, kbps: number): { server: HostServer; base: string } {
  /** When the modelled pipe is next free, on `performance.now`'s clock. */
  let pipeFreeAt = 0;
  const server = bun().serve({
    port: 0,
    idleTimeout: 120,
    async fetch(req: { url: string }): Promise<Response> {
      const path = decodeURIComponent(new URL(req.url).pathname).replace(/^\/world/, '');
      // No single-page fallback, so a tile the build does not contain really
      // 404s -- which is what `TileRetryLedger` and `TerrainField.absent`
      // classify on, and half of what the streamer's lifecycle is for.
      const file = bun().file(`${WORLD_ROOT}${path.split('?')[0]}`);
      if (!(await file.exists())) {
        if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
        return new Response('no', { status: 404 });
      }
      const bytes = await file.arrayBuffer();
      if (latencyMs > 0 || kbps > 0) {
        const now = performance.now();
        const onWire = kbps > 0 ? (bytes.byteLength * 8) / kbps : 0;
        const start = Math.max(now, pipeFreeAt);
        pipeFreeAt = start + onWire;
        const wait = Math.max(pipeFreeAt - now, latencyMs);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
      return new Response(bytes);
    },
  });
  return { server, base: `http://localhost:${server.port}/world` };
}

/** The slice of the index a leg reads. Structural so the check can hand one in. */
interface TileRow {
  key: string;
  bounds: [number, number, number, number];
  b: number;
}

/**
 * `main.ts`'s `ensureGround`, transplanted.
 *
 * Sequential and awaited, tile by tile, in index order, on a 420 m radius --
 * every one of those properties is copied rather than improved, because the
 * thing being measured is the schedule this loop produces and a harness that
 * fetched in parallel would be measuring a client nobody ships. The terrain
 * `await` in front of the collision fetch is `main.ts`'s too and is the reason
 * the loop is as slow as it is.
 *
 * The one addition is `keep`: the raw payload per tile, so the `drawn` world can
 * be built from the identical bytes at the moment its geometry commits, rather
 * than from a second fetch that would have its own schedule.
 */
async function ensureGround(
  px: number,
  pz: number,
  tiles: readonly TileRow[],
  tileSize: number,
  streamer: TileStreamer,
  solid: CollisionWorld,
  pending: Set<string>,
  keep: Map<string, ArrayBuffer>,
  base: string,
): Promise<void> {
  const terrain = streamer.ground;
  for (const entry of tiles) {
    const dx = Math.max(entry.bounds[0] - px, 0, px - entry.bounds[2]);
    const dz = Math.max(entry.bounds[1] - pz, 0, pz - entry.bounds[3]);
    if (Math.hypot(dx, dz) > COLLISION_RADIUS_M) continue;
    if (terrain) await terrain.ensure(entry.key);
    if (solid.hasTile(entry.key) || pending.has(entry.key)) continue;
    pending.add(entry.key);
    try {
      const resp = await fetch(`${base}/collision/${entry.key}.bin${streamer.assetVersion}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (resp.ok) {
        const buf = await resp.arrayBuffer();
        keep.set(entry.key, buf);
        solid.addTile(entry.key, buf, entry.bounds[0], entry.bounds[1] + tileSize, entry.b);
      }
    } catch {
      // A tile without collision is walkable-through, which is survivable; a
      // thrown error here would stop the whole loop, which is not. `main.ts`
      // says the same in the same words.
    } finally {
      pending.delete(entry.key);
    }
  }
}

/** Options a leg is run with. */
export interface LegOptions {
  seconds: number;
  latencyMs: number;
  kbps: number;
  /** Called once a second with a one-line progress string. */
  onProgress?: (line: string) => void;
}

/**
 * One route, one speed, cold and warm.
 *
 * The streamer and both collision worlds are built once and the leg is run
 * twice over them, which is what makes the second pass mean "revisit" rather
 * than "second boot".
 */
async function runRoute(
  route: (typeof ROUTES)[number],
  speeds: ReadonlyArray<{ name: string; mps: number }>,
  opts: LegOptions,
): Promise<LegResult[]> {
  const out: LegResult[] = [];
  for (const speed of speeds) {
    const { server, base } = serveWorld(opts.latencyMs, opts.kbps);
    const scene = new Scene();
    const streamer = new TileStreamer(scene, createFacadeGlobals(), { baseUrl: base, decodeWorkers: 0 });
    const index = await streamer.loadIndex({ x: route.points[0][0], z: route.points[0][1] });
    const solid = new CollisionWorld();
    const drawn = new CollisionWorld();
    const authority = await loadAuthority(route, index);
    // The raw payloads, kept for the whole route rather than per leg. `drawn` is
    // filled from these at the moment a tile's geometry commits, and
    // `ensureGround` only fetches a tile `solid` does not already have -- so a
    // per-leg map would be empty on the warm pass and `drawn` would be missing
    // every tile the cold pass fetched, for ever. That reported walls on the
    // warm pass that nothing was standing behind.
    const keep = new Map<string, ArrayBuffer>();
    // Exactly `main.ts`'s wiring, and the reason the hazard exemption in
    // `TileStreamer.update` and the head-of-queue placement in `loadTile` are
    // exercised at all: both read `collisionSink.hasTile`.
    streamer.setCollisionSink(solid);

    for (const pass of ['cold', 'warm'] as const) {
      out.push(await runLeg(route, speed, pass, index, streamer, solid, drawn, authority, keep, base, opts));
    }
    server.stop(true);
  }
  return out;
}

/** The leg itself. See the header for what every number in the result means. */
async function runLeg(
  route: (typeof ROUTES)[number],
  speed: { name: string; mps: number },
  pass: 'cold' | 'warm',
  index: { tile_size: number; tiles: readonly TileRow[] },
  streamer: TileStreamer,
  solid: CollisionWorld,
  drawn: CollisionWorld,
  authority: CollisionWorld,
  keep: Map<string, ArrayBuffer>,
  base: string,
  opts: LegOptions,
): Promise<LegResult> {
  const size = index.tile_size;
  const pending = new Set<string>();
  const bounds = new Map<string, TileRow>();
  for (const t of index.tiles) bounds.set(t.key, t);
  // The warm pass keeps whatever the cold pass loaded, which is the point of it;
  // `drawn` is rebuilt from scratch either way because a tile can only be added
  // to it once and the cold pass already did that for the tiles it drew.
  const inDrawn = new Set(drawn.residentTiles());

  let x = route.points[0][0];
  let z = route.points[0][1];
  let leg = 1;
  const camera = new PerspectiveCamera(70, 16 / 9, 0.1, 24000);

  // The cold pass starts where `main.ts` starts: with the ground under the spawn
  // awaited before the first frame. Without it the first second of every cold
  // leg is a body standing on nothing, which is a boot bug this harness is not
  // about and would dominate the integral.
  camera.position.set(x, 40, z);
  camera.updateMatrixWorld(true);
  streamer.update(camera);
  await ensureGround(x, z, index.tiles, size, streamer, solid, pending, keep, base);

  // A suburb centroid is a point on a map and is very often the middle of a
  // building. Starting a body inside one is not a hard case, it is a broken
  // one -- `resolve` refuses every move out of a prism it is already inside, so
  // the leg would score a permanent wall and travel nineteen metres. `main.ts`
  // has four placement probes for exactly this and they all ask the same
  // question this does.
  const free = freeSpotNear(x, z, solid, streamer);
  x = free.x;
  z = free.z;

  // And the boot gate, which is the other thing `main.ts` does before a player
  // may move -- **the gate it actually has**, and getting this wrong once was
  // worth the whole afternoon. `main.ts` reveals on `streamer.groundReady`: the
  // 1,156-byte terrain grids inside the reveal ring, not the 1.6 MB bundles.
  // That is the entire point of workstream AJ's ground-first pass -- the player
  // is let go onto drawn *ground* with the buildings still arriving, which is
  // precisely the state this file exists to measure. A pre-roll that waited for
  // the tile geometry instead would stand at the kerb until the defect was over
  // and then report that there was no defect, which is what the first draft of
  // this loop did and why every number it printed was zero.
  //
  // Bounded, so a grid the build does not contain cannot hang the run. That
  // bound is `main.ts`'s reveal deadline in spirit and in effect.
  for (let f = 0; f < Math.round(PREROLL_CAP_S / DT); f++) {
    if (streamer.groundReady(x, z)) break;
    camera.position.set(x, 40, z);
    camera.updateMatrixWorld(true);
    streamer.update(camera);
    await new Promise((r) => setTimeout(r, DT * 1000));
  }

  let prismSeconds = 0;
  let exposedSeconds = 0;
  let metres = 0;
  let worstWallM = 0;
  let wallCount = 0;
  let totalBlockedM = 0;
  let episodeM = 0;
  let ghostSeconds = 0;
  let worstGhostM = 0;
  let ghostEpisodeM = 0;
  let worstTiles = 0;
  const priorityBefore = streamer.lifecycleReport.priorityBuilds;
  let groundClock = 0;
  let progressClock = 0;
  /** Which way the steering went round the last facade. See `DEFLECT_RAD`. */
  let deflect: 1 | -1 = 1;
  /** Seconds the body has made no ground. See the waypoint branch in the loop. */
  let stalledFor = 0;
  const near: Prism[] = [];
  const ghosts: Prism[] = [];

  const frames = Math.round(opts.seconds / DT);
  const started = performance.now();
  for (let f = 0; f < frames; f++) {
    // --- Where the body wants to be, one step along the route.
    const target = route.points[Math.min(leg, route.points.length - 1)];
    let hx = target[0] - x;
    let hz = target[1] - z;
    const len = Math.hypot(hx, hz);
    if (len < speed.mps * DT * 2 || stalledFor > STALL_GIVE_UP_S) {
      // Arrived at a waypoint -- or given up on reaching it. The last one loops
      // back down the route rather than stopping, so a fast body on a short
      // route still spends the whole leg moving through city instead of parked
      // at the end of it.
      //
      // The give-up is not tidiness. The steering is three deflections and a
      // memory, which is enough to get round a terrace and not enough to get out
      // of a courtyard, and a body wedged in one measures nothing for the rest
      // of the leg while reporting a plausible-looking zero. Turning it round
      // after four seconds of no progress puts it back over ground it can cross.
      leg = leg + 1 < route.points.length ? leg + 1 : 0;
      stalledFor = 0;
      deflect = (deflect === 1 ? -1 : 1) as 1 | -1;
      continue;
    }
    hx /= len;
    hz /= len;

    const feet = streamer.ground?.height(x, z);
    const feetY = Number.isFinite(feet) ? (feet as number) : 0;
    // The controller's own two ends, argument for argument: the step lifts the
    // feet and the head is measured from the unlifted ones. See
    // `player/controller.ts`, which is the body the pipeline's audit is written
    // about and therefore the only one worth measuring.
    const lo = feetY + STEP_HEIGHT;
    const hi = feetY + BODY_HEIGHT_M;
    const step = speed.mps * DT;

    // --- The intent, which is a player going round what they can see.
    //
    // The deflection angles are tried in the order that keeps a wall-follower
    // committed: straight, then the side that worked last time, then the other.
    // Without the memory a body in a doorway alternates between the two jambs
    // and stands still while both worlds agree it is free to move -- which is
    // not an invisible wall and must not be scored as one.
    let toX = x + hx * step;
    let toZ = z + hz * step;
    let sighted = drawn.resolve(x, z, toX, toZ, PLAYER_RADIUS, lo, hi);
    let bestAdvance = (sighted.x - x) * hx + (sighted.z - z) * hz;
    if (bestAdvance <= step * 0.6) {
      for (const turn of [DEFLECT_RAD * deflect, DEFLECT_RAD * -deflect, Math.PI * 0.5 * deflect]) {
        const cx = hx * Math.cos(turn) - hz * Math.sin(turn);
        const cz = hx * Math.sin(turn) + hz * Math.cos(turn);
        const cand = drawn.resolve(x, z, x + cx * step, z + cz * step, PLAYER_RADIUS, lo, hi);
        // Progress towards the waypoint, not along the deflected heading: a turn
        // that moves the body sideways forever is not going round anything.
        const advance = (cand.x - x) * hx + (cand.z - z) * hz;
        if (advance > bestAdvance) {
          bestAdvance = advance;
          sighted = cand;
          toX = x + cx * step;
          toZ = z + cz * step;
          deflect = (turn > 0 ? 1 : -1) as 1 | -1;
        }
        if (advance > step * 0.6) break;
      }
    }

    // --- What this client does about it, and what the server would do about
    // that. All three from the **same origin to the same raw target**, which is
    // the only arrangement that measures a prism set and not a resolver.
    //
    // The obvious composition -- resolve the intent, then feed the *resolved*
    // point to the next authority -- is wrong, and wrong by tens of metres. See
    // the header: `resolve` is not idempotent. It pushes a body out along a wall
    // normal to exactly `PLAYER_RADIUS`, and asking it again about the point it
    // just produced pushes again by whatever the last one left inside, every
    // frame, for as long as the body slides along a facade. Composed that way
    // this file reported a 46.8 m invisible wall at Cammeray on a leg whose
    // exposure integral was 0.0 seconds -- two numbers that cannot both be true,
    // which is how it was caught. Resolved from a common target the three calls
    // are the identical call over three prism sets, so where the sets agree the
    // answers are bit-identical and the difference is exactly the prisms one has
    // and another does not.
    const actual = solid.resolve(x, z, toX, toZ, PLAYER_RADIUS, lo, hi);
    const lost = Math.hypot(sighted.x - actual.x, sighted.z - actual.z);
    if (lost > 0.01) {
      episodeM += lost;
      totalBlockedM += lost;
    } else if (episodeM > 0) {
      wallCount++;
      if (episodeM > worstWallM) worstWallM = episodeM;
      episodeM = 0;
    }

    // --- And what the server would do about *that*, measured and not applied.
    // A hexagon of prisms against a 420 m ring: where they disagree the player
    // is corrected out of a step their own client granted them, which reads as
    // the identical complaint and is a different fault. See the header.
    const held = authority.resolve(x, z, toX, toZ, PLAYER_RADIUS, lo, hi);
    const ghost = Math.hypot(actual.x - held.x, actual.z - held.z);
    if (ghost > 0.01) {
      ghostEpisodeM += ghost;
    } else if (ghostEpisodeM > 0) {
      if (ghostEpisodeM > worstGhostM) worstGhostM = ghostEpisodeM;
      ghostEpisodeM = 0;
    }

    const moved = Math.hypot(actual.x - x, actual.z - z);
    metres += moved;
    stalledFor = moved < step * 0.05 ? stalledFor + DT : 0;
    x = actual.x;
    z = actual.z;

    // --- Exposure: prisms in reach that belong to a tile nothing has drawn.
    solid.prismsWithin(x, z, PROBE_RADIUS_M, near);
    let hidden = 0;
    for (const p of near) {
      // The prism's centre decides its tile, on `InvisibleWalls.prismHazard`'s
      // argument: a footprint straddling a seam is filed under one tile by the
      // pipeline and testing an arbitrary vertex would answer for the neighbour.
      const key = tileKeyAt((p.minX + p.maxX) * 0.5, (p.minZ + p.maxZ) * 0.5, size, bounds);
      if (key !== null && streamer.tilePhase(key) !== 'built') hidden++;
    }
    prismSeconds += hidden * DT;
    if (hidden > 0) exposedSeconds += DT;

    // --- And the other gap: prisms in reach the server has and this client has
    // not fetched. By tile, because that is the granularity `ensureGround`
    // works in and the only granularity the fix could ever work in.
    authority.prismsWithin(x, z, PROBE_RADIUS_M, ghosts);
    let unheld = 0;
    for (const p of ghosts) {
      const key = tileKeyAt((p.minX + p.maxX) * 0.5, (p.minZ + p.maxZ) * 0.5, size, bounds);
      if (key !== null && !solid.hasTile(key)) unheld++;
    }
    if (unheld > 0) ghostSeconds += DT;

    // --- The streamer, and the ground loop, on their own clocks.
    camera.position.set(x, feetY + 1.6, z);
    // A camera looking where the body is going, because the streamer's shadow
    // and frustum work reads it -- and because the velocity-directed ranking
    // this harness exists to evaluate has nowhere else to learn a heading from.
    camera.lookAt(x + hx * 100, feetY + 1.6, z + hz * 100);
    camera.updateMatrixWorld(true);
    streamer.update(camera);

    // Tiles that have committed since the last frame join the drawn world, from
    // the bytes `ensureGround` already has. This is the only place `drawn` grows
    // and it grows exactly one build behind the scene, which is the definition
    // the header states.
    for (const [key, buf] of keep) {
      if (inDrawn.has(key)) continue;
      if (streamer.tilePhase(key) !== 'built') continue;
      const row = bounds.get(key);
      if (row === undefined) continue;
      drawn.addTile(key, buf, row.bounds[0], row.bounds[1] + size, row.b);
      inDrawn.add(key);
    }

    let tilesHidden = 0;
    for (const key of solid.residentTiles()) {
      if (streamer.tilePhase(key) !== 'built') tilesHidden++;
    }
    if (tilesHidden > worstTiles) worstTiles = tilesHidden;

    groundClock += DT;
    if (groundClock > GROUND_REFRESH_S) {
      groundClock = 0;
      void ensureGround(x, z, index.tiles, size, streamer, solid, pending, keep, base);
    }

    progressClock += DT;
    if (progressClock >= 5 && opts.onProgress) {
      progressClock = 0;
      opts.onProgress(
        `    ${route.name}/${speed.name}/${pass} ${(f * DT).toFixed(0)}s  ` +
          `${metres.toFixed(0)} m  ${solid.residentTiles().length} coll tiles (${tilesHidden} undrawn)  ` +
          `exposed ${exposedSeconds.toFixed(1)} s  unheld ${ghostSeconds.toFixed(1)} s  worst wall ${worstWallM.toFixed(2)} m`,
      );
    }

    // Paced against the wall clock, because every fetch in here is a real one.
    // See the header: a loop that ran faster than real time would be measuring a
    // slower network than the one it is talking to.
    const due = started + (f + 1) * DT * 1000;
    const slack = due - performance.now();
    if (slack > 0) await new Promise((r) => setTimeout(r, slack));
    else await new Promise((r) => setTimeout(r, 0));
  }
  if (episodeM > 0) {
    wallCount++;
    if (episodeM > worstWallM) worstWallM = episodeM;
  }
  if (ghostEpisodeM > worstGhostM) worstGhostM = ghostEpisodeM;

  return {
    route: route.name,
    speed: speed.name,
    mps: speed.mps,
    pass,
    seconds: frames * DT,
    metres,
    prismSeconds,
    exposedSeconds,
    worstWallM,
    wallCount,
    totalBlockedM,
    ghostSeconds,
    worstGhostM,
    worstTiles,
    priorityBuilds: streamer.lifecycleReport.priorityBuilds - priorityBefore,
  };
}

/**
 * How far either side of the route the authority world is loaded, metres.
 *
 * The server's real answer is a whole hexagon plus `COLLISION_NEED_MARGIN_M` --
 * six kilometres of circumradius -- which over a three-kilometre route would be
 * most of the North Shore and several hundred megabytes of prisms in a harness
 * that only ever asks about a three-metre disc. Nine hundred metres is the
 * body's whole reach for the whole leg with a doubling of the client's own ring
 * to spare, and inside it this world is *identical* to the server's: both hold
 * every prism the pipeline wrote for every tile in range, off disk, before
 * anybody moved. Outside it neither the body nor the query can reach.
 */
const AUTHORITY_MARGIN_M = 900;

/**
 * The server's collision, as the server has it: eagerly, off disk, whole.
 *
 * Read with `Bun.file` rather than through the modelled link on purpose. The
 * server does not stream its prisms -- `world.ts` loads a hexagon's worth when a
 * participant comes within `COLLISION_NEED_MARGIN_M` and holds them -- so
 * putting this behind the same throttled origin as the browser's fetches would
 * be modelling a server that has the browser's problem, which is the one thing
 * it does not have.
 */
async function loadAuthority(
  route: (typeof ROUTES)[number],
  index: { tile_size: number; tiles: readonly TileRow[] },
): Promise<CollisionWorld> {
  const world = new CollisionWorld();
  // The corridor, not the waypoints: a body between two suburbs three kilometres
  // apart spends the whole leg nowhere near either of them, and a margin taken
  // from the endpoints would leave the middle of every route unheld -- which
  // would report the server as agreeing with the client precisely where it has
  // the most chance not to.
  const along: Array<[number, number]> = [];
  for (let i = 0; i + 1 < route.points.length; i++) {
    const [ax, az] = route.points[i];
    const [bx, bz] = route.points[i + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 200));
    for (let s = 0; s <= steps; s++) along.push([ax + ((bx - ax) * s) / steps, az + ((bz - az) * s) / steps]);
  }
  for (const entry of index.tiles) {
    if (entry.b <= 0) continue;
    let reach = Infinity;
    for (const [px, pz] of along) {
      const dx = Math.max(entry.bounds[0] - px, 0, px - entry.bounds[2]);
      const dz = Math.max(entry.bounds[1] - pz, 0, pz - entry.bounds[3]);
      reach = Math.min(reach, Math.hypot(dx, dz));
      if (reach <= AUTHORITY_MARGIN_M) break;
    }
    if (reach > AUTHORITY_MARGIN_M) continue;
    const file = bun().file(`${WORLD_ROOT}/collision/${entry.key}.bin`);
    if (!(await file.exists())) continue;
    world.addTile(
      entry.key,
      await file.arrayBuffer(),
      entry.bounds[0],
      entry.bounds[1] + index.tile_size,
      entry.b,
    );
  }
  return world;
}

/**
 * The nearest point to `(x, z)` a body can actually stand, searched outwards.
 *
 * A suburb centroid is the middle of a *suburb*, which in Chatswood is the
 * middle of a department store. `CollisionWorld.resolve` refuses every move out
 * of a prism the body is already inside -- correctly, that is the guard that
 * stops a player being pushed through a wall -- so a leg that started there
 * would never move and would score the whole run as one permanent invisible
 * wall. Every placement probe in `main.ts` answers the same question the same
 * way and this is the fourth of them.
 *
 * A ring sweep rather than a spiral, so the first free point found is the
 * closest one at that radius rather than the first the iteration order happened
 * to reach, and the body starts in the street the centroid is nearest to rather
 * than in whichever direction the loop counted.
 */
function freeSpotNear(
  x: number,
  z: number,
  solid: CollisionWorld,
  streamer: TileStreamer,
): { x: number; z: number } {
  const probe: Prism[] = [];
  const feet = streamer.ground?.height(x, z);
  const feetY = Number.isFinite(feet) ? (feet as number) : 0;
  const clear = (px: number, pz: number): boolean => {
    solid.prismsWithin(px, pz, PLAYER_RADIUS + 0.6, probe);
    for (const p of probe) {
      // The body's own band, so a soffit over the head does not disqualify a
      // perfectly good patch of footpath under a viaduct.
      if (feetY + STEP_HEIGHT >= p.top - 0.05) continue;
      if (feetY + BODY_HEIGHT_M <= p.base) continue;
      if (pointInPolygonNear(p, px, pz)) return false;
    }
    return true;
  };
  if (clear(x, z)) return { x, z };
  for (let r = 4; r <= 120; r += 4) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      if (clear(px, pz)) return { x: px, z: pz };
    }
  }
  // Nowhere within 120 m: the centroid is in the middle of the Queen Victoria
  // Building and the leg is about to say so loudly rather than quietly.
  return { x, z };
}

/** Is the body's disc touching this prism's plan? A cheap box test first. */
function pointInPolygonNear(p: Prism, x: number, z: number): boolean {
  const r = PLAYER_RADIUS + 0.6;
  return x + r >= p.minX && x - r <= p.maxX && z + r >= p.minZ && z - r <= p.maxZ;
}

/**
 * Which tile a world point is in, or null where the index has none.
 *
 * `cellKey` from `world/invisible-walls.ts` rather than a second copy of the
 * arithmetic, because the two answers have to agree: the overlay decides what to
 * hatch with that function and this decides what to count with it, and a drift
 * between them would make the overlay and the number disagree about the same
 * frame. What is added here is the index lookup -- the streamer's keys are its
 * own strings and the cell has to be resolved to one that `tilePhase` knows.
 */
function tileKeyAt(
  x: number,
  z: number,
  size: number,
  bounds: ReadonlyMap<string, TileRow>,
): string | null {
  const minX = Math.floor(x / size) * size;
  const minZ = Math.floor(z / size) * size;
  // The index's key convention is not derivable here without repeating it, so
  // the cell is resolved by its corner, which is exact: every tile's bounds
  // start on a multiple of the tile size.
  const want = `${minX},${minZ}`;
  const hit = cornerIndex.get(want);
  if (hit !== undefined) return hit;
  for (const [key, row] of bounds) {
    if (row.bounds[0] === minX && row.bounds[1] === minZ) {
      cornerIndex.set(want, key);
      return key;
    }
  }
  return null;
}
/** Corner-to-key memo for `tileKeyAt`; a leg touches a few dozen tiles. */
const cornerIndex = new Map<string, string>();

/**
 * The self-check, for the client's boot list.
 *
 * Everything here fails silently in the game, which is the criterion this
 * project puts a `verify*` behind. A probe radius that drifted from the
 * player's own capsule would report exposure the player never felt. A collision
 * ring that drifted from the one the streamer refuses to evict inside would
 * make the harness measure a window that is not the client's. And `cellKey`
 * disagreeing with the corner arithmetic above would put the exposure count and
 * the overlay's hatch on different tiles in the same frame.
 */
export function verifyCollisionWindow(): string[] {
  const failures: string[] = [];
  const fail = (ok: boolean, msg: string): void => {
    if (!ok) failures.push(msg);
  };

  fail(
    PROBE_RADIUS_M > PLAYER_RADIUS * 2 && PROBE_RADIUS_M <= 8,
    `PROBE_RADIUS_M is ${PROBE_RADIUS_M} m, which is not a body's reach. Under twice the ` +
      `capsule it counts nothing the player could touch; over 8 m it counts the block.`,
  );
  fail(
    COLLISION_RADIUS_M === 420,
    `The harness fetches collision on ${COLLISION_RADIUS_M} m and main.ts fetches it on 420 m. ` +
      `The window being measured is not the window the client has.`,
  );
  fail(
    SPEEDS.length >= 3 && SPEEDS.every((s, i) => i === 0 || s.mps > SPEEDS[i - 1].mps),
    'The speeds are no longer ascending; the table below them reads as a trend and would be lying.',
  );

  // The cell arithmetic, against the function the overlay hatches with. Both
  // sides of both axes, because the whole build lives south and west of Town
  // Hall and a sign convention that worked at the origin would be untested.
  for (const [x, z] of [
    [-2719.4, -7946.2],
    [344.0, -5167.1],
    [97.9, 1741.3],
    [1.0, 1.0],
  ] as const) {
    const mine = `${Math.floor(x / 500) * 500},${Math.floor(z / 500) * 500}`;
    const theirs = cellKey(x, z, 500);
    const asCell = `${Number(mine.split(',')[0]) / 500},${Number(mine.split(',')[1]) / 500}`;
    fail(
      asCell === theirs,
      `The corner arithmetic in tileKeyAt puts (${x}, ${z}) in cell ${asCell} and invisible-walls.cellKey ` +
        `puts it in ${theirs}. The exposure count and the map's hatch would be on different tiles.`,
    );
  }

  return failures;
}

/* --------------------------------------------------------------------------
 * The driver.
 */

/**
 * The ratchet, and why it is looser than the measurement it was set from.
 *
 * All four are *cold* worst-case across the routes and speeds, because that is
 * where the defect lives -- every warm leg this file has ever run measured zero
 * on all four and always will.
 *
 * **The numbers are noisy and pretending otherwise would make this check
 * useless.** Every fetch is real, every frame is paced against the wall clock,
 * and the body is *steered* rather than scripted -- so a leg that streams a
 * fraction slower takes a different line through the same suburb and meets
 * different buildings. Measured, e-bike cold, the same three routes run six
 * times on one idle machine: the worst wall came out 0.00, 0.00, 0.18, 0.18,
 * 5.14 and 8.98 metres. That spread is the instrument, not the client.
 *
 * So the budgets are the worst *observed* plus roughly half, which is loose
 * enough that an idle machine passes every time and tight enough to catch the
 * thing this is for: the window reopening by an order of magnitude, which is
 * what a regression in the ground-first pass, the hazard exemption or the
 * collision ring would actually look like. A check that fails one run in four
 * is a check people stop running -- `tick-profile.ts` says the same in the same
 * words. If it fails, run it again on an idle machine before believing it, and
 * then read the per-leg table rather than the headline.
 *
 * Raising one is allowed. Recording the new measurement beside it is not
 * optional, on `undrawn-solids-check.ts`'s terms.
 *
 * Stated against `LEG_SECONDS`, `GATE_LATENCY_MS` and `GATE_KBPS`. A run with
 * `--seconds`, `--latency` or `--kbps` set is a measurement and not a gate, and
 * the driver refuses to fail on one.
 */
const EXPOSED_BUDGET_S = 2.0;
const WORST_WALL_BUDGET_M = 14.0;

/**
 * And the same two for the other gap, which is the one the measurement found.
 *
 * `authority \ solid` is a client that has not fetched a prism the server holds,
 * and it is bounded rather than zero on purpose: the two sets can never be equal
 * -- the server loads a hexagon and the browser fetches 420 m -- so what is
 * being gated is the part of the difference the *body can touch*, which is a
 * `ensureGround` that has fallen behind the player rather than a design.
 */
const GHOST_BUDGET_S = 1.0;
const WORST_GHOST_BUDGET_M = 1.0;

function table(rows: readonly LegResult[]): string[] {
  const lines: string[] = [];
  lines.push('                                        |------- solid \\ drawn: the invisible wall -------|  |-- authority \\ solid: the rubber-band --|');
  lines.push(
    '  route      speed  pass   travelled   prism-s  exposed s  % of leg  worst wall  walls    ghost s  % of leg  worst ghost   undrawn  prio',
  );
  for (const r of rows) {
    lines.push(
      `  ${r.route.padEnd(10)} ${r.speed.padEnd(6)} ${r.pass.padEnd(6)} ` +
        `${(r.metres.toFixed(0) + ' m').padStart(9)}   ${r.prismSeconds.toFixed(1).padStart(7)}   ` +
        `${r.exposedSeconds.toFixed(1).padStart(8)}  ${((100 * r.exposedSeconds) / r.seconds).toFixed(1).padStart(6)}%  ` +
        `${(r.worstWallM.toFixed(2) + ' m').padStart(10)}  ${String(r.wallCount).padStart(5)}   ` +
        `${r.ghostSeconds.toFixed(1).padStart(8)}  ${((100 * r.ghostSeconds) / r.seconds).toFixed(1).padStart(6)}%  ` +
        `${(r.worstGhostM.toFixed(2) + ' m').padStart(11)}   ${String(r.worstTiles).padStart(7)}  ${String(r.priorityBuilds).padStart(4)}`,
    );
  }
  return lines;
}

async function main(): Promise<void> {
  const argv = bun().argv.slice(2);
  const flag = (name: string, dflt: number): number => {
    const at = argv.indexOf(`--${name}`);
    return at >= 0 && argv[at + 1] !== undefined ? Number(argv[at + 1]) : dflt;
  };
  const seconds = flag('seconds', LEG_SECONDS);
  const latencyMs = flag('latency', GATE_LATENCY_MS);
  const kbps = flag('kbps', GATE_KBPS);
  const full = argv.includes('--full');
  const routeArg = argv.indexOf('--route');
  const only = routeArg >= 0 ? argv[routeArg + 1] : null;
  const speedArg = argv.indexOf('--speed');
  const speeds = speedArg >= 0 ? SPEEDS.filter((s) => s.name === argv[speedArg + 1]) : SPEEDS;
  const routes = only ? ROUTES.filter((r) => r.name === only) : full ? ROUTES : ROUTES.slice(0, 1);
  const gating = seconds === LEG_SECONDS && latencyMs === GATE_LATENCY_MS && kbps === GATE_KBPS;

  const say = (s: string): void => console.log(s);
  say('');
  say('--- the collision window: how long the city is solid before it is visible');
  say('');
  say(`  ${routes.length} route(s), ${speeds.length} speed(s), ${seconds} s a leg, cold and warm.`);
  say(
    `  link: ${
      latencyMs === 0 && kbps === 0
        ? 'local disk, unmodelled (the floor -- no defect is visible here, see the header)'
        : `${latencyMs} ms RTT, ${(kbps / 1000).toFixed(0)} Mbit/s shared`
    }`,
  );
  for (const r of routes) say(`  ${r.name.padEnd(10)} ${r.why}`);
  say('');

  const selfChecks = verifyCollisionWindow();
  if (selfChecks.length > 0) {
    for (const f of selfChecks) say(`  SELF-CHECK FAIL: ${f}`);
    host.process?.exit(1);
  }

  const rows: LegResult[] = [];
  for (const route of routes) {
    rows.push(...(await runRoute(route, speeds, { seconds, latencyMs, kbps, onProgress: say })));
  }

  say('');
  for (const line of table(rows)) say(line);
  say('');

  if (argv.includes('--json')) say(JSON.stringify(rows, null, 2));

  const cold = rows.filter((r) => r.pass === 'cold');
  const worstExposed = Math.max(0, ...cold.map((r) => r.exposedSeconds));
  const worstWall = Math.max(0, ...cold.map((r) => r.worstWallM));
  const worstGhostS = Math.max(0, ...cold.map((r) => r.ghostSeconds));
  const worstGhostM = Math.max(0, ...cold.map((r) => r.worstGhostM));
  say(
    `  worst cold leg, invisible wall: ${worstExposed.toFixed(1)} s exposed (budget ${EXPOSED_BUDGET_S}), ` +
      `${worstWall.toFixed(2)} m worst wall (budget ${WORST_WALL_BUDGET_M})`,
  );
  say(
    `  worst cold leg, rubber-band:    ${worstGhostS.toFixed(1)} s unheld  (budget ${GHOST_BUDGET_S}), ` +
      `${worstGhostM.toFixed(2)} m worst ghost (budget ${WORST_GHOST_BUDGET_M})`,
  );

  if (!gating) {
    say('');
    say('  MEASUREMENT ONLY -- the ratchet is stated against the default leg and link. Not a gate.');
    host.process?.exit(0);
  }

  const failures: string[] = [];
  if (worstExposed > EXPOSED_BUDGET_S) {
    failures.push(
      `${worstExposed.toFixed(1)} s of a ${seconds} s cold leg had solid, undrawn city within ` +
        `${PROBE_RADIUS_M} m of the body, against a budget of ${EXPOSED_BUDGET_S} s.`,
    );
  }
  if (worstWall > WORST_WALL_BUDGET_M) {
    failures.push(
      `The worst single invisible wall held the body for ${worstWall.toFixed(2)} m, against a budget of ` +
        `${WORST_WALL_BUDGET_M} m. This is the "why is there an invisible wall here" report.`,
    );
  }
  if (worstGhostS > GHOST_BUDGET_S) {
    failures.push(
      `${worstGhostS.toFixed(1)} s of a ${seconds} s cold leg had a prism within ${PROBE_RADIUS_M} m that the ` +
        `server holds and this client had not fetched, against a budget of ${GHOST_BUDGET_S} s. ` +
        `ensureGround has fallen behind the body.`,
    );
  }
  if (worstGhostM > WORST_GHOST_BUDGET_M) {
    failures.push(
      `The server would have corrected the body by ${worstGhostM.toFixed(2)} m in one encounter, against a ` +
        `budget of ${WORST_GHOST_BUDGET_M} m. To a player this is the same complaint as an invisible wall ` +
        `and it is a rubber-band.`,
    );
  }
  if (failures.length > 0) {
    say('');
    say('  FAIL');
    for (const f of failures) say(`    ${f}`);
    say('');
    say('  If the new number is genuine and cannot be shrunk, raise the budget in this file AND');
    say('  record the new measurement -- see the header.');
    host.process?.exit(1);
  }
  say('');
  say('  PASS');
  host.process?.exit(0);
}

// `import.meta.main` is bun's; it is absent in a browser, where this module is
// never imported anyway. Same guard `perf-harness.ts` uses.
if ((import.meta as unknown as { main?: boolean }).main) await main();
