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

/** How far ahead of the player to look for the "next" tile, metres. */
export const LOOKAHEAD_M = 320;

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
): { current: string | null; next: string | null } {
  let current: string | null = null;
  for (const t of tiles) {
    if (contains(t.bounds, x, z)) {
      current = t.key;
      break;
    }
  }
  if (speed < MOVING_MPS) return { current, next: null };
  const len = Math.sqrt(headX * headX + headZ * headZ);
  if (!(len > 0)) return { current, next: null };
  const ax = x + (headX / len) * LOOKAHEAD_M;
  const az = z + (headZ / len) * LOOKAHEAD_M;
  let next: string | null = null;
  for (const t of tiles) {
    if (contains(t.bounds, ax, az)) {
      next = t.key;
      break;
    }
  }
  return { current, next: next === current ? null : next };
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
