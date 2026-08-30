/*
 * tilepriority.ts -- which tile is allowed to take the link, and which is asked
 * to get off it.
 *
 * The streamer already fetched nearest-first: `update` ranks every tile inside
 * `loadRadius` by distance every frame and starts the closest missing one. That
 * is the right order and it was never the complaint. The complaint was
 *
 *     "it eagerly queues stuff to load, but really only the current loaded and
 *      next should be settable, and if I am on a tile it should stop any other
 *      coming loading"
 *
 * and the reason it is right is that **the ranking is recomputed every frame but
 * the four concurrency slots are not.** A slot is committed at the moment a
 * fetch starts and held until the bytes land. Drive for three seconds and all
 * four are held by tiles chosen from where you *were*, while the tile you are
 * standing on waits behind them for a megabyte and a half of city you have
 * already left. Sorting harder cannot fix that; nothing re-reads the sort.
 *
 * So there are two tiers, and only two:
 *
 *   - **The tile under the player, and the one they are moving into.** Never
 *     queued behind anything, and allowed a slot even when every slot is taken
 *     -- the same argument `HAZARD_EXTRA_SLOTS` makes for a tile whose collision
 *     is already resident, and for the same reason: this one is not a hole in
 *     the distance, it is the ground at your feet.
 *   - **Everything else**, which may only start while neither of those is
 *     outstanding, and which is asked to stand down if one becomes outstanding
 *     while it is in flight.
 *
 * **What is deliberately never cancelled.** A load that was itself priority when
 * it started keeps its slot for its whole life -- the owner's own "unless it's
 * previous current and already downloading it". Without that clause, driving
 * across a boundary would cancel the tile you just left *while it was arriving*,
 * and then want it again a second later because it is still well inside the
 * radius: a strictly worse world than not cancelling at all, paid for in bytes.
 * A tile whose collision prisms are resident is never cancelled either, on
 * `world/invisible-walls.ts`' argument that a solid invisible block of city
 * outranks every ordering preference there is.
 *
 * Pure, and separate from `streamer.ts`, because the interesting part is a
 * decision rather than a fetch: it needs no camera, no index and no network to
 * hold still under a check, which is the whole of why `game/framestep.ts` and
 * `world/boundarylog.ts` live where they do.
 */

/**
 * How many seconds of travel ahead the prediction reaches.
 *
 * **Seconds and not metres**, which is the whole of the second pass over this
 * file. A fixed distance is wrong at both ends of the speed range: 320 m is
 * seven seconds at the 44 m/s top speed -- barely the time to pull 1.6 MB of
 * tile -- and a full minute at walking pace, where it nominates a tile the
 * player will probably never reach and spends the one slot that outranks
 * everything on it. A horizon in seconds is the same lead at every speed, which
 * is what "take the velocity into account" actually means.
 *
 * **Twenty-five and not twelve**, and the first attempt at this number was
 * wrong in a way worth recording: twelve seconds at the 44 m/s top speed is
 * 528 m, barely one tile, so a driver got no lead at all beyond the tile they
 * were entering. The lead has to cover *crossing* a tile (11 s at top speed)
 * and *fetching* the next one, so twenty-five seconds is a little over two
 * tiles of reach at speed and comfortably inside the 1,800 m radius.
 */
export const HORIZON_S = 25;

/**
 * The shortest and longest that horizon is allowed to become, metres.
 *
 * The floor is half a tile, so somebody strolling still gets the tile they are
 * walking into rather than nothing. The ceiling is inside `loadRadius` (1,800 m)
 * on purpose: nominating a tile the streamer would not fetch anyway is a
 * priority slot spent on something that cannot be started.
 */
/*
 * The floor is a tile plus a step, and that is arithmetic rather than taste.
 * `contains` is half-open, so crossing east happens at exactly `d = 500` while
 * crossing west needs `d > 250` from mid-tile -- and the march samples every
 * `RAY_STEP_M`, so the first sample that is strictly inside the neighbour can
 * be a whole step further than the geometry suggests. Anything less than
 * `tile_size + RAY_STEP_M` leaves a direction and a standing position from
 * which the adjacent tile is never nominated at all; 260 did, and the check
 * caught it going west.
 */
export const MIN_LOOKAHEAD_M = 640;
export const MAX_LOOKAHEAD_M = 1400;

/**
 * How far apart the ray is sampled, metres.
 *
 * Must be under `tile_size` (500) or the march can step clean over a tile and
 * nominate the one behind it. 125 m is `world/boundarylog.RING_STEP_M`, which
 * is the same number for the same reason and worth keeping the same.
 */
export const RAY_STEP_M = 125;

/**
 * How much of a frame's heading survives into the smoothed one, 0..1.
 *
 * The raw heading is one frame's movement, and one frame of a car on a rough
 * surface is noisy enough to swing the nomination between two tiles several
 * times a second -- which spends the priority slot on churn. At 0.12 the
 * direction settles in about a quarter of a second and still turns a corner
 * faster than the tile behind it can load.
 */
export const HEADING_BLEND = 0.12;

/**
 * Below this speed there is no "next" tile and the current one is the only
 * priority.
 *
 * A player turning on the spot has a heading that swings through every point of
 * the compass, and a lookahead driven by it would nominate a different
 * neighbour every frame -- four slots' worth of churn from someone who has not
 * moved. Metres per second.
 */
export const MOVING_MPS = 1.5;

/** The rectangle a tile occupies: `[minX, minZ, maxX, maxZ]`, as three stores it. */
export type Bounds = readonly number[];

/** Just enough of a tile for this file to rank it. */
export interface RankedTile {
  key: string;
  bounds: Bounds;
}

/** The tile containing `(x, z)`, or null outside the built world. */
export function tileAt(tiles: readonly RankedTile[], x: number, z: number): string | null {
  for (const t of tiles) {
    if (contains(t.bounds, x, z)) return t.key;
  }
  return null;
}

/** True when `(x, z)` is inside the tile, edges included on the low side. */
export function contains(bounds: Bounds, x: number, z: number): boolean {
  return x >= bounds[0] && x < bounds[2] && z >= bounds[1] && z < bounds[3];
}

/**
 * The one or two tiles that outrank everything else.
 *
 * `current` is the tile the player is standing in; `next` is the one the
 * lookahead lands in, and is `null` when the player is slow enough that a
 * heading means nothing, when the lookahead stays inside the current tile, or
 * when it leaves the built world entirely.
 */
export function priorityTiles(
  tiles: readonly RankedTile[],
  x: number,
  z: number,
  headX: number,
  headZ: number,
  speed: number,
  isLoaded: (key: string) => boolean = () => false,
): { current: string | null; next: string | null } {
  const current = tileAt(tiles, x, z);
  if (speed < MOVING_MPS) return { current, next: null };
  const len = Math.sqrt(headX * headX + headZ * headZ);
  if (!(len > 0)) return { current, next: null };
  const ux = headX / len;
  const uz = headZ / len;
  /*
   * --- March the ray, and walk *past* what is already here.
   *
   * The owner asked for "download the best next tile, and as soon as that's
   * done, do the next", and skipping the resident ones is the entire mechanism.
   * A single sample point at a fixed distance cannot chain: once the tile it
   * lands in has arrived, the same sample keeps landing in the same tile and
   * nothing further is ever nominated until the player physically moves into
   * it. Stepping along the heading and taking the first tile that is *not* here
   * yet means the moment one lands the next one is nominated on the same frame,
   * for free, with no queue and nothing to drain.
   *
   * The reach scales with speed, so what is being asked is always "where will I
   * be in twelve seconds" rather than "what is 320 m away".
   */
  const reach = Math.min(MAX_LOOKAHEAD_M, Math.max(MIN_LOOKAHEAD_M, speed * HORIZON_S));
  for (let d = RAY_STEP_M; d <= reach; d += RAY_STEP_M) {
    const key = tileAt(tiles, x + ux * d, z + uz * d);
    if (key === null || key === current) continue;
    if (isLoaded(key)) continue;
    return { current, next: key };
  }
  return { current, next: null };
}

/**
 * One frame of heading smoothing. Returns the blended direction.
 *
 * Kept here rather than in `streamer.ts` so the churn case can be held still by
 * a check: a car on a rough surface produces a per-frame step vector that swings
 * several degrees, and the nomination follows it. See `HEADING_BLEND`.
 */
export function blendHeading(
  prevX: number,
  prevZ: number,
  stepX: number,
  stepZ: number,
): { x: number; z: number } {
  const a = HEADING_BLEND;
  return { x: prevX + (stepX - prevX) * a, z: prevZ + (stepZ - prevZ) * a };
}

/** What the scheduler knows about one in-flight or candidate tile. */
export interface SlotFacts {
  /** In the priority pair this frame. */
  priority: boolean;
  /** Was priority at the moment its fetch started, so it keeps its slot. */
  startedAsPriority: boolean;
  /** Collision prisms already resident: a solid invisible block, never cut. */
  hazard: boolean;
}

/**
 * May a fetch for this tile start now?
 *
 * `priorityOutstanding` is the whole gate: while the ground under the player is
 * still missing, nothing else takes the link. A priority tile itself ignores the
 * slot count, which is what stops it queueing behind four tiles chosen from
 * where the player used to be.
 */
export function admits(
  facts: SlotFacts,
  priorityOutstanding: boolean,
  inFlight: number,
  slots: number,
): boolean {
  if (facts.priority || facts.hazard) return true;
  if (priorityOutstanding) return false;
  return inFlight < slots;
}

/**
 * Should an in-flight fetch be asked to stand down?
 *
 * Only ever to clear the way for the ground at the player's feet, and never for
 * a load that was itself priority when it started or whose collision is already
 * resident. A cancellation that is not paying for a priority tile is pure waste:
 * the bytes are gone and the tile is still wanted.
 */
export function cancels(facts: SlotFacts, priorityOutstanding: boolean): boolean {
  if (!priorityOutstanding) return false;
  return !facts.priority && !facts.startedAsPriority && !facts.hazard;
}

export function verifyTilePriority(): string[] {
  const failures: string[] = [];
  const t = (key: string, minX: number, minZ: number): RankedTile => ({
    key,
    bounds: [minX, minZ, minX + 500, minZ + 500],
  });
  // A three-by-one strip: the player stands in the middle one.
  const tiles = [t('west', -500, 0), t('here', 0, 0), t('east', 500, 0)];

  // Standing still: the tile underfoot and nothing else.
  const still = priorityTiles(tiles, 250, 250, 1, 0, 0);
  if (still.current !== 'here') failures.push(`standing at (250,250) the current tile read "${still.current}".`);
  if (still.next !== null) {
    failures.push(
      `a player who has not moved nominated "${still.next}" as next; a heading that means nothing would ` +
        `churn the slots of somebody standing on the spot.`,
    );
  }

  // Moving east: the neighbour ahead, not the one behind.
  const east = priorityTiles(tiles, 250, 250, 1, 0, 20);
  if (east.current !== 'here' || east.next !== 'east') {
    failures.push(`driving east the pair read current="${east.current}" next="${east.next}".`);
  }
  const west = priorityTiles(tiles, 250, 250, -1, 0, 20);
  if (west.next !== 'west') failures.push(`driving west nominated "${west.next}" as the tile ahead.`);

  // Deep inside a tile, the lookahead does not leave it, and a tile is never
  // its own successor -- that would spend the pair on one tile.
  const inside = priorityTiles(tiles, 10, 250, 1, 0, 20);
  if (inside.next !== 'east' && inside.next !== null) {
    failures.push(`a lookahead from the near edge nominated "${inside.next}".`);
  }
  const same = priorityTiles([t('here', 0, 0)], 10, 250, 1, 0, 20);
  if (same.next !== null) failures.push('a tile was nominated as its own successor; the pair collapses to one.');

  // Off the edge of the built world: no current, no next, no crash.
  const away = priorityTiles(tiles, 99999, 99999, 1, 0, 20);
  if (away.current !== null || away.next !== null) {
    failures.push(`outside the world the pair read current="${away.current}" next="${away.next}".`);
  }

  // --- Velocity, angle, and chaining: the three things the rewrite is for.
  {
    // A long strip east, so a march has somewhere to go.
    const strip = [t('a', 0, 0), t('b', 500, 0), t('c', 1000, 0), t('d', 1500, 0), t('e', 2000, 0)];
    const from = 250;

    // Walking pace and driving pace must not nominate the same tile: the whole
    // point of a horizon in seconds is that it moves with the speed.
    const slow = priorityTiles(strip, from, 250, 1, 0, 3);
    const fast = priorityTiles(strip, from, 250, 1, 0, 40);
    if (slow.next !== 'b') failures.push(`at walking pace the next tile was "${slow.next}", not the one adjacent.`);
    if (fast.next !== 'b') failures.push(`at speed the first missing tile was "${fast.next}".`);
    // ...and once the adjacent one is here, speed decides how far past it we look.
    const here = new Set(['a', 'b']);
    const loaded = (k: string): boolean => here.has(k);
    // ...and this is where the two speeds must *disagree*. A driver needs the
    // tile past the one they are entering; a stroller does not, and asking for
    // it would spend the priority slot on somewhere they may never walk.
    const slowNext = priorityTiles(strip, from, 250, 1, 0, 3, loaded);
    const fastNext = priorityTiles(strip, from, 250, 1, 0, 40, loaded);
    if (fastNext.next !== 'c') failures.push(`at speed the march stopped at "${fastNext.next}" instead of reaching past the next tile.`);
    if (slowNext.next !== null) {
      failures.push(`a stroller with the next two tiles resident still asked for "${slowNext.next}"; the horizon is not scaling with speed.`);
    }

    // **Chaining.** The owner's "as soon as that's done, do the next": each tile
    // arriving must nominate the one beyond it on the same frame, with no queue.
    const arrived = new Set(['a']);
    const chain: string[] = [];
    for (let i = 0; i < 4; i++) {
      const step = priorityTiles(strip, from, 250, 1, 0, 40, (k) => arrived.has(k));
      if (step.next === null) break;
      chain.push(step.next);
      arrived.add(step.next);
    }
    // Outward, in order, and further than one -- the chain stops where the
    // horizon does, which is the point of having one.
    if (chain.join(',') !== 'b,c') {
      failures.push(`the march did not chain outward as tiles landed; it went ${chain.join(',') || '(nowhere)'}.`);
    }

    // A world that is entirely resident has nothing left to ask for.
    const all = priorityTiles(strip, from, 250, 1, 0, 40, () => true);
    if (all.next !== null) failures.push(`with every tile resident the march still nominated "${all.next}".`);

    // Angle: the same speed in a different direction picks a different tile.
    const north = priorityTiles([t('a', 0, 0), t('n', 0, 500)], 250, 250, 0, 1, 20);
    if (north.next !== 'n') failures.push(`heading north nominated "${north.next}".`);
  }

  // --- The heading is smoothed, or a rough surface churns the nomination.
  {
    let h = { x: 1, z: 0 };
    // One frame of noise must not swing the direction.
    const jolted = blendHeading(h.x, h.z, 0, 1);
    if (Math.abs(jolted.z) > 0.2) {
      failures.push(`one noisy frame moved the heading ${jolted.z.toFixed(2)} off axis; the nomination would churn.`);
    }
    // A real turn still gets there.
    for (let i = 0; i < 60; i++) h = blendHeading(h.x, h.z, 0, 1);
    if (h.z < 0.9 || Math.abs(h.x) > 0.1) {
      failures.push(`after a second of turning the heading was (${h.x.toFixed(2)}, ${h.z.toFixed(2)}); it does not follow.`);
    }
  }

  // --- The gate.
  const plain: SlotFacts = { priority: false, startedAsPriority: false, hazard: false };
  const prio: SlotFacts = { priority: true, startedAsPriority: true, hazard: false };
  const haz: SlotFacts = { priority: false, startedAsPriority: false, hazard: true };

  if (!admits(prio, true, 99, 4)) {
    failures.push('the tile under the player was refused a slot because the others were full; that is the bug.');
  }
  if (admits(plain, true, 0, 4)) {
    failures.push('a distant tile started while the ground under the player was still missing.');
  }
  if (!admits(plain, false, 0, 4)) failures.push('nothing may start with the priority pair settled; the world stops.');
  if (admits(plain, false, 4, 4)) failures.push('the concurrency cap was ignored once the pair had settled.');
  if (!admits(haz, true, 99, 4)) failures.push('a tile with resident collision was refused; that is an invisible wall.');

  // --- Standing down.
  if (cancels(plain, false)) failures.push('a fetch was cancelled with nothing waiting on it; the bytes are pure waste.');
  if (!cancels(plain, true)) failures.push('a distant fetch kept the link while the ground under the player waited.');
  if (cancels(prio, true)) failures.push("the player's own tile was cancelled to make room for itself.");
  if (cancels({ priority: false, startedAsPriority: true, hazard: false }, true)) {
    failures.push(
      'a tile that was priority when it started was cancelled on the boundary crossing; it is still well ' +
        'inside the radius and would be asked for again a second later, which is worse than never cancelling.',
    );
  }
  if (cancels(haz, true)) failures.push('a tile with resident collision was cancelled; that is an invisible wall.');
  return failures;
}
