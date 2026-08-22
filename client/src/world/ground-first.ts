/**
 * The ground draws first, and the curtain stays down until it has.
 *
 * The arithmetic behind two promises the streamer and the boot make between
 * them, kept in one three-free file so a check on either end of the wire can
 * hold it still -- `world/tile-lifecycle.ts`'s argument, for the same reason.
 * Nothing here imports `three`, touches the DOM, or knows what a mesh is.
 *
 * ---------------------------------------------------------------------------
 * ## Why the ground was ever late, which is a fact about the payload rather
 * ## than about the queue
 *
 * A tile is eleven requests and one of them is the ground. `tiles/<key>.glb`
 * averages **311 kB** over the shipped build and reaches 1.6 MB in the CBD;
 * `tiles/<key>.terr.bin` is **1,156 bytes, always** -- a 17 x 17 grid of
 * float32 heights, four hundredths of one per cent of the tile. And yet
 * `TileStreamer.loadTile` asked for all eleven in one `Promise.all`, so the
 * ground of a tile could not be *drawn* until the last byte of its geometry had
 * landed and been decoded and the build queue had reached it.
 *
 * That is the whole of the defect the player reports. Where a tile has not
 * arrived, `far-terrain.bin` is still drawn -- the coarse extent heightfield,
 * sunk `sink_m` (about 3 m) below the fine surface so the fine one always wins
 * the depth test -- so the symptom is not a hole in the world. It is worse than
 * a hole, because it is plausible: a smooth, roadless, uncarved sheet three
 * metres under where the ground really is. Walk into it and you step down a
 * ledge. Ride a train into it and the train ploughs through a hillside that has
 * no cutting in it yet, because `world/rail-cut.ts` carves the *fine* ground and
 * nothing carves the coarse one.
 *
 * So the ground gets its own pass. 1,156 bytes is small enough that the near
 * ring can be fetched outright rather than budgeted, the grid is a
 * `Float32Array` view with no decode worth the name, `TerrainField` never evicts
 * so a re-visit needs no request at all, and `buildTerrainMesh` is 640 triangles
 * of a shared, boot-warmed, non-instanced material. Every property that makes a
 * tile expensive is absent from its ground.
 *
 * ---------------------------------------------------------------------------
 * ## The two questions
 *
 * **`groundRing`** answers *which* tiles' ground a player at (x, z) must have.
 * **`coverage`** answers how much of it they do have. Between them they are the
 * loading screen's progress line, the streamer's fetch priority, and the boot's
 * reveal condition -- one piece of arithmetic serving all three, so the number
 * the player reads is the number the gate tests.
 *
 * A tile counts as **settled** rather than built, and that distinction is load
 * bearing in both directions. A tile whose `.terr.bin` the pipeline never
 * emitted can never have a ground sheet, and a gate that waited for one would
 * hold the curtain down forever over a hole in the *build*. A tile whose fetch
 * merely failed is not settled, because that one is coming back -- see
 * `TerrainField.ensure`'s backoff, and `GROUND_REVEAL_DEADLINE_MS` for what
 * bounds the wait when it does not.
 */

/**
 * The only shape of a tile this file needs: a key and a plan rectangle.
 *
 * Structurally satisfied by `streamer.TileEntry` without either file importing
 * the other, which is what keeps this module three-free while the streamer hands
 * it the real index.
 */
export interface GroundTile {
  key: string;
  /** [minX, minZ, maxX, maxZ] in world metres. */
  bounds: readonly [number, number, number, number] | [number, number, number, number];
}

/**
 * How far from the player the ground must be built before the boot uncovers the
 * world, metres.
 *
 * **600 m, and it is three arguments meeting rather than a round number.**
 *
 *   1. *One whole tile in every direction.* Tiles are 500 m, so a radius of 600
 *      guarantees the tile the player stands on plus a complete ring around it,
 *      wherever inside their own tile the spawn dither put them. The nearest
 *      seam between fine ground and coarse is therefore never closer than
 *      600 m, at which distance the coarse sheet's 3 m sink subtends under 0.3
 *      degrees -- a handful of pixels at 1080p, and behind the fog. Any smaller
 *      radius has the player revealing onto the edge of the built world, which
 *      is the one thing `SPAWN_DITHER_RADIUS`'s 100 m disc makes easy to do by
 *      accident: measure from the disc *centre* at 500 m and the drawn point can
 *      be 100 m from the rim.
 *   2. *The sun's footprint.* The shadow volume's ground reach is 342 m at the
 *      reference altitude (`streamer.sunReceiveRange`), so 600 m contains every
 *      tile that can have a real shadow on it. Ground arriving after the reveal
 *      inside that distance is the most visible late arrival there is: not a
 *      surface appearing, but a surface appearing *with the shadows of the
 *      buildings on it*, which reads as a light flicking on.
 *   3. *It has to be cheap enough to be worth waiting for.* 600 m is 11 or 12
 *      tiles at the spawn -- 13.5 kB of terrain and a dozen sub-millisecond
 *      mesh builds. 1,000 m would be 23 tiles for ground the far sheet already
 *      covers convincingly, and the extra second of curtain buys nothing a
 *      player would notice.
 *
 * Well inside the streamer's 1,800 m `loadRadius`, by a factor of three, so the
 * gate can never want a tile the streamer is not already asking for.
 */
export const GROUND_REVEAL_RADIUS_M = 600;

/**
 * The cross-tile half of "the ground draws first" is not a constant, and it is
 * worth saying so here where a reader will look for one.
 *
 * There is no separate lead radius. The ground pass runs over the streamer's own
 * `loadRadius` -- the same 1,800 m ranking `update` already computes to decide
 * what to fetch -- so it costs no extra pass over the index and covers exactly
 * the world the near tiles are drawn in. The whole ring is 57 tiles at the
 * spawn, which is 64 kB of terrain: less than a fifth of *one* tile's geometry.
 *
 * The ordering is then enforced per tile rather than by rationing connections:
 * **a tile's 311 kB bundle does not start until that tile's own 1,156 bytes have
 * settled.** The ground pass runs in front of the fetch pass in the same frame,
 * so a tile's grid is always requested first and, being 270 times smaller,
 * always lands first. A per-tile rule cannot starve the streamer the way a
 * global throttle can: a tile whose ground is slow delays only itself, a tile
 * whose ground the build does not contain is settled and proceeds immediately,
 * and a tile the player is standing inside of -- one whose prisms are resident,
 * an invisible wall -- is exempt outright, because a solid block of city nobody
 * can see outranks every ordering preference in this file.
 */

/**
 * How long the reveal waits for the ground before it goes ahead without it,
 * milliseconds.
 *
 * **9,000, and the shape of it is `WARMUP_DEADLINE_MS`'s rather than
 * `SHADER_WARMUP_DEADLINE_MS`'s.** This is a fetch with a fallback -- lose the
 * race and the first second of the game is drawn on the coarse far sheet, which
 * is exactly what shipped before this pass existed -- so it takes the shorter,
 * asset-shaped deadline. A driver that has decided to compile one shader forever
 * is a different failure and gets 25 s; a CDN that has stopped answering must
 * not cost the player more than a glance.
 *
 * The number comes from the one below it. `TerrainField` abandons a `terr.bin`
 * at `FETCH_TIMEOUT_MS` = 8,000 ms and does not retry for another 5,000, so
 * 8 s is the longest a grid can legitimately still be coming; past it the next
 * attempt has not started and waiting means waiting up to twenty-one seconds
 * for a 1.2 kB file. One second on top covers the mesh builds and whichever
 * frame the poll lands on. Anything under 8,000 would give up on requests that
 * were still in flight, which is the same mistake in the other direction.
 *
 * **The clock starts at the first frame the renderer draws**, not when the gate
 * is installed. Everything between the two -- the far layer, the rail bake, the
 * name prompt, the socket, the scene shader pass -- is boot the streamer sleeps
 * through, and one of those steps waits on a human typing. A deadline armed
 * before them would expire while nothing was even being fetched, every time.
 */
export const GROUND_REVEAL_DEADLINE_MS = 9000;

/**
 * Plan distance from a point to a tile's rectangle, metres; zero inside it.
 *
 * `streamer.distanceToBounds` with the `Vector3` taken apart, and the two must
 * agree exactly: the streamer decides what to *fetch* with its copy and this
 * decides what to *wait for*, so a disagreement of one tile is a curtain waiting
 * on ground nothing is loading.
 */
export function tileGap(
  x: number,
  z: number,
  b: readonly [number, number, number, number] | [number, number, number, number],
): number {
  const dx = Math.max(b[0] - x, 0, x - b[2]);
  const dz = Math.max(b[1] - z, 0, z - b[3]);
  return Math.hypot(dx, dz);
}

/**
 * Every tile whose ground a player at (x, z) needs, nearest first.
 *
 * Nearest first because the order *is* the fetch priority: the player notices
 * the ground at their feet, not the ground at the far end of the ring, and the
 * ring is small enough that sorting it is free.
 *
 * Tiles absent from the index are absent from the answer, which is the right
 * reading rather than a convenience: a point in the harbour has no ground to
 * wait for and a gate that invented some would never open.
 */
export function groundRing(
  tiles: readonly GroundTile[],
  x: number,
  z: number,
  radiusM: number,
): string[] {
  const near: Array<{ key: string; gap: number }> = [];
  for (const t of tiles) {
    const gap = tileGap(x, z, t.bounds);
    if (gap <= radiusM) near.push({ key: t.key, gap });
  }
  near.sort((a, b) => a.gap - b.gap);
  return near.map((n) => n.key);
}

export interface GroundCoverage {
  /** Tiles in the ring whose ground is settled. */
  built: number;
  /** Tiles in the ring at all. */
  total: number;
  /** The unsettled ones, still nearest first. */
  missing: string[];
  /** Whether every tile in the ring is settled. See `ready` on the empty case. */
  ready: boolean;
}

/**
 * How much of a ring is settled.
 *
 * **An empty ring is ready.** There is a temptation to call it "not ready yet"
 * on the grounds that a world with no tiles under the player has clearly not
 * finished loading, and it is wrong twice: the index is parsed before any of
 * this runs so an empty ring means genuinely no tiles here, and a gate that
 * refuses to open over water would hold the curtain down for the entire
 * `GROUND_REVEAL_DEADLINE_MS` on a boot with nothing wrong with it.
 */
export function coverage(ring: readonly string[], settled: ReadonlySet<string>): GroundCoverage {
  const missing: string[] = [];
  for (const key of ring) if (!settled.has(key)) missing.push(key);
  return {
    built: ring.length - missing.length,
    total: ring.length,
    missing,
    ready: missing.length === 0,
  };
}

/**
 * What the loading screen says while it waits. Honest progress, not a spinner.
 *
 * Spec 8's HUD voice: lowercase, terminal-plain, no punctuation it does not
 * need. It says tiles because tiles are what arrive; a percentage over eleven
 * items is a number that jumps by nine and reads as a lie.
 */
export function groundProgressLine(cover: GroundCoverage): string {
  if (cover.total === 0) return 'laying the ground';
  return `laying the ground — ${cover.built} of ${cover.total} tiles`;
}

/** Why the curtain went up, or why it has not. */
export type RevealReason = 'waiting' | 'ground' | 'deadline';

export interface RevealState {
  /**
   * Whether the renderer has drawn a frame.
   *
   * **This is the whole of "everything the boot used to wait for"**, and the
   * collapse is honest rather than lazy. `main.ts` dropped the curtain
   * immediately after the shader warm-up and then went on to spend the rest of
   * the boot -- the far layer, the rail bake, the name prompt, the socket, the
   * spawn, the scene pass -- with nothing rendered at all, because
   * `setAnimationLoop` is the last statement in the function. So the old
   * condition ("the warm-up is done") was satisfied thousands of lines before
   * anything could be seen, and the player watched an unrendered canvas through
   * the difference. Every one of those steps is upstream of the first frame, so
   * one flag stands for all of them and cannot be satisfied early.
   */
  drawing: boolean;
  /** `coverage(...).ready` at the camera. */
  ground: boolean;
  /** Milliseconds since the first drawn frame. */
  elapsedMs: number;
  deadlineMs: number;
}

/**
 * The reveal rule.
 *
 * A deadline here is a **bound, not a wait** -- `SHADER_WARMUP_DEADLINE_MS`'s
 * philosophy, which this deliberately copies: a wedged CDN or a dropped fetch
 * must produce a late reveal and a console line, never a boot that hangs
 * forever. So the deadline overrides a false `ground`, and that is the only
 * thing it overrides. It cannot override `drawing`, because revealing before a
 * frame exists is not a degraded boot, it is the black screen this pass is
 * here to delete.
 */
export function revealReason(s: RevealState): RevealReason {
  if (!s.drawing) return 'waiting';
  if (s.ground) return 'ground';
  if (s.elapsedMs >= s.deadlineMs) return 'deadline';
  return 'waiting';
}

/**
 * The order a tile's parts are constructed in, and the reason it is a table
 * rather than a comment.
 *
 * `TileStreamer.buildTile` is a generator whose steps are grouped by what they
 * build; the order is visible only by reading four hundred lines of it, and the
 * one property this workstream exists to guarantee -- that the ground is never
 * behind the buildings -- was therefore an invariant nothing could test. So the
 * builder now calls `stepOrder` at every step and throws if it has gone
 * backwards, which makes the sequence below *the* order rather than a
 * description of it.
 *
 * The ground is not in this list, and its absence is the change. A tile's ground
 * is no longer built by the tile: it is a sheet in the streamer's ground layer,
 * built the moment the 1,156-byte grid lands, and the tile's own group cannot
 * enter the scene without it -- see `TileStreamer.ensureGroundSheet`, which the
 * commit step calls as its last chance to be sure.
 *
 * `lanes` stays first for the reason it was moved there: the ways block is where
 * the carriageways are and the ground carve has to know about them before it
 * cuts.
 */
export const TILE_BUILD_ORDER = [
  'lanes',
  'water',
  'buildings',
  'trees',
  'cars',
  'power',
  'furniture',
  'powerups',
  'column-lamps',
  'birds',
  'commit',
] as const;

export type TileBuildStep = (typeof TILE_BUILD_ORDER)[number];

/**
 * Where a step sits in the table. `-1` for a name that is not in it, which the
 * builder treats as a fault rather than as a skip.
 */
export function stepOrder(step: string): number {
  return (TILE_BUILD_ORDER as readonly string[]).indexOf(step);
}

/**
 * The self-check, in both boot lists.
 *
 * Every failure here is silent in the game. A ring computed one tile too small
 * is a reveal onto the edge of the built world, which looks like a rendering
 * bug. A coverage predicate that treats an empty ring as unready is nine
 * seconds of loading screen on a perfectly good boot. A reveal rule that lets
 * the deadline outrank `drawing` puts the player back on the black screen this
 * whole pass exists to remove -- and it would do it only on the machines slow
 * enough to reach the deadline, which are the machines nobody develops on.
 */
export function verifyGroundFirst(): string[] {
  const failures: string[] = [];
  const fail = (ok: boolean, msg: string): void => {
    if (!ok) failures.push(msg);
  };

  // --- The ring, over a synthetic 5 x 5 of 500 m tiles centred on (0, 0).
  //
  // World z runs south and the key convention is the streamer's, but nothing
  // here reads a key's arithmetic -- only its identity -- so the grid is built
  // the simple way on purpose: a check that re-derived `floor(-z / size)` would
  // be testing that derivation rather than the ring.
  const size = 500;
  const tiles: GroundTile[] = [];
  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) {
      tiles.push({
        key: `${i}_${j}`,
        bounds: [i * size, j * size, (i + 1) * size, (j + 1) * size],
      });
    }
  }
  // A point 43 m inside the north edge of tile 0_0, which is the shape the real
  // spawn has: deep in its own tile on one axis and hard against a seam on the
  // other. The tile it stands in must always be first.
  const px = 250;
  const pz = 43;
  const ring600 = groundRing(tiles, px, pz, 600);
  fail(ring600[0] === '0_0', `the tile under the player must be the first of the ring, got ${ring600[0]}`);
  fail(
    ring600.includes('0_-1') && ring600.includes('-1_0') && ring600.includes('1_0'),
    'a 600 m ring must contain every tile sharing an edge with the player\'s',
  );
  // 600 m from a point inside a 500 m tile always reaches the whole 3 x 3.
  for (const key of ['-1_-1', '-1_0', '-1_1', '0_-1', '0_0', '0_1', '1_-1', '1_0', '1_1']) {
    fail(ring600.includes(key), `a 600 m ring must contain ${key}; it is one tile away at most`);
  }
  fail(
    groundRing(tiles, px, pz, 0).length === 1,
    'a zero-radius ring is the tile the player is standing in and nothing else',
  );
  fail(groundRing([], px, pz, 600).length === 0, 'an empty index has an empty ring');
  // Monotonic in the radius, which is what lets the gate's 600 m ring and the
  // ground pass's 1,800 m one be the same arithmetic asked twice: the pass must
  // reach every tile the gate waits for, or the curtain hangs on ground nothing
  // is fetching.
  const wide = new Set(groundRing(tiles, px, pz, 1800));
  fail(
    groundRing(tiles, px, pz, GROUND_REVEAL_RADIUS_M).every((k) => wide.has(k)),
    'the load-radius ring must contain the reveal ring, or the gate waits on tiles nothing fetches',
  );
  fail(
    GROUND_REVEAL_RADIUS_M < 1800,
    'the reveal radius must be inside the streamer\'s load radius or the gate waits forever',
  );
  fail(
    tileGap(px, pz, [0, 0, size, size]) === 0,
    'a point inside a tile is zero from it',
  );
  fail(
    Math.abs(tileGap(0, 0, [300, 400, 800, 900]) - 500) < 1e-9,
    'the gap to a rectangle is measured to its nearest corner, not its centre',
  );

  // --- Coverage.
  const full = new Set(ring600);
  fail(coverage(ring600, full).ready, 'a fully settled ring is ready');
  fail(coverage(ring600, full).missing.length === 0, 'a fully settled ring has nothing missing');
  fail(!coverage(ring600, new Set()).ready, 'an empty resident set over a real ring is not ready');
  fail(
    coverage(ring600, new Set()).built === 0 && coverage(ring600, new Set()).total === ring600.length,
    'an empty resident set is 0 of N, not 0 of 0',
  );
  // The partial ring, and then the one case a naive count would pass and a
  // player would fall through: everything settled *except* the tile under
  // their feet.
  const partial = new Set(ring600.slice(1));
  fail(!coverage(ring600, partial).ready, 'a ring missing its innermost tile is not ready');
  fail(
    coverage(ring600, partial).missing[0] === ring600[0],
    'the missing list stays nearest-first, so the progress line names the tile that matters',
  );
  const outerGone = new Set(ring600.slice(0, ring600.length - 1));
  fail(!coverage(ring600, outerGone).ready, 'a ring missing its outermost tile is not ready either');
  fail(coverage([], new Set()).ready, 'an empty ring is ready: there is no ground here to wait for');
  fail(coverage([], new Set()).total === 0, 'an empty ring is 0 of 0');
  fail(
    groundProgressLine(coverage(ring600, partial)).includes(`${ring600.length - 1} of ${ring600.length}`),
    'the progress line reports the real counts',
  );

  // --- The reveal rule.
  const base = { drawing: true, ground: false, elapsedMs: 0, deadlineMs: GROUND_REVEAL_DEADLINE_MS };
  fail(revealReason({ ...base, ground: true }) === 'ground', 'settled ground reveals');
  fail(revealReason(base) === 'waiting', 'unsettled ground inside the deadline waits');
  fail(
    revealReason({ ...base, elapsedMs: GROUND_REVEAL_DEADLINE_MS }) === 'deadline',
    'the deadline overrides a false groundReady -- that is the whole of what it is for',
  );
  fail(
    revealReason({ ...base, elapsedMs: GROUND_REVEAL_DEADLINE_MS * 10 }) === 'deadline',
    'a long-expired deadline still reveals rather than reporting ground it has not got',
  );
  // And the half that must *not* be overridable. A deadline that could outrank
  // `drawing` is the black screen this pass deletes, reintroduced on exactly
  // the slow machines nobody tests on.
  fail(
    revealReason({ ...base, drawing: false, elapsedMs: GROUND_REVEAL_DEADLINE_MS * 10 }) === 'waiting',
    'nothing reveals before a frame has been drawn, deadline included',
  );
  fail(
    revealReason({ ...base, drawing: false, ground: true }) === 'waiting',
    'ground with nothing drawn is still not a reveal',
  );
  fail(
    GROUND_REVEAL_DEADLINE_MS >= 8000,
    'the deadline must outlast TerrainField.FETCH_TIMEOUT_MS or it abandons requests still in flight',
  );

  // --- The build order.
  fail(
    stepOrder('terrain') === -1,
    'the ground is not a step of the tile build any more; it is a sheet built when its 1,156 bytes land',
  );
  fail(TILE_BUILD_ORDER[0] === 'lanes', 'the ways block is decoded first: the ground carve needs the roads');
  fail(
    TILE_BUILD_ORDER[TILE_BUILD_ORDER.length - 1] === 'commit',
    'the commit is last, because it is what tells the world the tile exists',
  );
  fail(
    stepOrder('buildings') > stepOrder('lanes'),
    'the buildings cannot be built before the roads their ground is carved around',
  );
  fail(
    new Set(TILE_BUILD_ORDER).size === TILE_BUILD_ORDER.length,
    'a repeated step name makes the monotonic order check unable to convict anything',
  );
  fail(stepOrder('nonsense') === -1, 'an unknown step name is a fault, not a skip');

  return failures;
}
