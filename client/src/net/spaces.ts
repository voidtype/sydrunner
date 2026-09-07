/**
 * Which world a participant is standing in.
 *
 * Every player has been in exactly one place since this game started: Greater
 * Sydney. Interiors change that — a building's inside is its own space, entered
 * through a door, shared by everybody who walks through that door, and simulated
 * apart from the street outside it.
 *
 * This is the shared half: what a space id *is*, how a building becomes one, and
 * what "two participants can see each other" means once there is more than one
 * world. It is in `net/` and imports nothing, because both ends must agree about
 * it exactly — the browser predicts your position in a space and the server
 * adjudicates it in the same one, and a disagreement about *which* is not a
 * rubber-band, it is one player standing in a room nobody else is in.
 *
 * ## The three decisions, and they are the owner's
 *
 * - **Global and shared.** One building, one inside, for everybody. Not
 *   per-party and not per-player: a pub with one drinker in it is a worse pub.
 *   So the id is a pure function of the building and carries no session in it.
 * - **Persistent.** Log out inside and you log in inside, which means the space
 *   travels with the account beside the position it belongs to. See
 *   `net/accounts.ts`'s `LiveSpot`.
 * - **One door.** You leave by the one you came in, so a space needs to
 *   remember its doorway rather than compute a way out.
 *
 * ## Why the id is derived and not allocated
 *
 * A server that handed out instance numbers would have to remember them, agree
 * about them across a restart, and answer what happens when it forgets. Derived
 * from the building's own geometry -- `world/doorway.buildingSeed` -- the id is
 * the same on every host, in every session, forever, with nothing stored. A
 * cold server and a warm one send you to the same room.
 */

/**
 * The city. Zero, and it has to be: every participant record written before
 * interiors existed has no space field at all, and the missing value must mean
 * "outside", not "in an unknown room".
 */
export const CITY_SPACE = 0;

/**
 * The wire's ceiling for a space id.
 *
 * A `u32`, because `buildingSeed` is one and the field will be one. Stated so
 * the round trip below is a check rather than a hope.
 */
export const MAX_SPACE = 0xffffffff;

/**
 * The space behind a building's door.
 *
 * Takes the building's own seed and guarantees the one property `CITY_SPACE`
 * needs: **never zero**. A building whose geometry happens to hash to zero would
 * otherwise put its inside on the street, which is the single worst bug this
 * file could have -- two players in different worlds drawing each other.
 */
export function spaceForBuilding(seed: number): number {
  if (!Number.isFinite(seed)) return 1;
  const id = (Math.trunc(seed) >>> 0) || 1;
  return id === CITY_SPACE ? 1 : id;
}

/** Is this participant outdoors? */
export function isCity(space: number): boolean {
  return sanitiseSpace(space) === CITY_SPACE;
}

/**
 * A space id off the wire or out of a stored account.
 *
 * Anything that is not a whole number in range becomes the city. That default is
 * deliberate and is the safe direction: a corrupt value putting somebody outside
 * is a player standing in the street, and a corrupt value putting them *inside*
 * is a player in a room that may not exist, with no door out of it.
 */
export function sanitiseSpace(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return CITY_SPACE;
  const t = Math.trunc(n);
  if (t < 0 || t > MAX_SPACE) return CITY_SPACE;
  return t >>> 0;
}

/**
 * Can these two see each other at all?
 *
 * The first question the area of interest asks, before any distance: two
 * participants in different spaces are never in each other's working set however
 * close their coordinates are — and their coordinates *will* be close, because
 * an interior is generated wherever it likes and two buildings' insides can
 * occupy the same metres. Distance is meaningless across spaces, so this is
 * asked first and asked cheaply.
 */
export function sameSpace(a: number, b: number): boolean {
  return sanitiseSpace(a) === sanitiseSpace(b);
}

// --- Occupancy: the space and the storey, as one number -----------------------

/**
 * Where somebody actually is: a space and, inside a building, a floor.
 *
 * ## Why the space alone was not enough
 *
 * `sameSpace` was the whole of the interest test for three protocol versions
 * and it is exactly half right. Two people in one building are in one space,
 * which is correct and is the owner's first decision about interiors ("a pub
 * with one drinker in it is a worse pub"). But `world/interior.ts` has made
 * every storey the plan draws walkable, and a building is eight of them: two
 * people in the same space can be eighteen metres apart *vertically* and one
 * metre apart in the (x, z) the area of interest measures. Every radius in
 * `server/aoi.ts` is horizontal, so the AOI cannot separate them, and the
 * symptom is the one `server/interior-share-check.ts` measured before this
 * existed: **a body drawn six metres up through the ceiling**, with a nameplate
 * over it, in a room it is not in.
 *
 * That is the same failure the space itself was written to fix, one axis over,
 * and it gets the same answer: ask about the room before you measure a
 * distance, because distance is not the question across a slab either.
 *
 * ## Why it is one number and not two
 *
 * `InterestIndex.select`'s callback runs once per candidate per client per
 * snapshot -- it is the hottest loop this feature touches, and its own comment
 * defends "one array lookup per candidate" as the reason the space test lives
 * there rather than in a second index. Two fields would be two lookups and two
 * compares. Packed, it stays one of each, and the parallel array in `aoi.ts`
 * stays one array.
 *
 * `space * 256 + level` is exact in a float64 for every space id: a `u32` space
 * shifted eight bits is under 2^40, which is thirteen bits inside the 2^53 an
 * integer-valued double holds without rounding. It is deliberately **not** a
 * bitwise pack: `|` and `<<` in JavaScript are 32-bit operations and would fold
 * a space of 0xffffffff onto -1. This file is the bottom of the import graph on
 * both ends and gets asked about the worst seed available, so the arithmetic is
 * the arithmetic that survives it.
 *
 * ## And why nothing about it is on the wire
 *
 * For the same reason the space is not, argued out in `protocol.ts`'s v23 note
 * and in INTERIORS.md: interest filters by occupancy **before** it measures a
 * distance, so everybody in a snapshot is by construction in the sender's own
 * room. A level byte on `PLAYER_BYTES` would be 20 B/s per player in view -- 6.4
 * kbit/s at `AOI_MAX_PLAYERS` -- to carry a number already known to be equal.
 * What a client needs to know about a remote's floor is whether it is its own,
 * and the answer is yes for everybody it is sent.
 */
export const LEVELS_PER_SPACE = 256;

/** The city, and the storey a body outdoors is on. Zero, as `CITY_SPACE` is. */
export const CITY_OCCUPANCY = 0;

/**
 * The occupancy key for a space and a storey.
 *
 * The level is clamped rather than masked, on `sanitiseSpace`'s rule: a level
 * of 300 arriving from a generator that grew a storey should read as the top of
 * the building rather than wrap to level 44 in the same one, which would put
 * two bodies in one room that are eight hundred metres apart vertically. A
 * non-finite level, or any level at all in the city, reads as the ground.
 */
export function occupancyOf(space: number, level: number): number {
  const s = sanitiseSpace(space);
  if (s === CITY_SPACE) return CITY_OCCUPANCY;
  const raw = typeof level === 'number' ? level : Number(level);
  const k = !Number.isFinite(raw)
    ? 0
    : Math.trunc(raw) < 0
      ? 0
      : Math.min(Math.trunc(raw), LEVELS_PER_SPACE - 1);
  return s * LEVELS_PER_SPACE + k;
}

/** The space an occupancy key names. `CITY_SPACE` for the street. */
export function occupancySpace(key: number): number {
  const n = typeof key === 'number' && Number.isFinite(key) ? Math.trunc(key) : 0;
  if (n <= 0) return CITY_SPACE;
  return sanitiseSpace(Math.floor(n / LEVELS_PER_SPACE));
}

/** The storey an occupancy key names. Zero outdoors. */
export function occupancyLevel(key: number): number {
  const n = typeof key === 'number' && Number.isFinite(key) ? Math.trunc(key) : 0;
  if (n <= 0) return 0;
  return n % LEVELS_PER_SPACE;
}

/**
 * Are these two in the same room?
 *
 * `sameSpace`'s question with the floor in it, and the one the working set asks.
 * Everything that belongs to a *building* rather than to a body -- the
 * furniture, the lift cab's ride -- still asks `sameSpace`, and that difference
 * is the whole of why both functions exist.
 */
export function sameOccupancy(a: number, b: number): boolean {
  return a === b;
}

/** Self-check. On both boot lists. */
export function verifySpaces(): string[] {
  const failures: string[] = [];

  // --- The city is zero, and absence means the city.
  //
  // Every participant and every stored account written before interiors has no
  // space at all, and the missing value has to mean "outside".
  {
    if (CITY_SPACE !== 0) failures.push('the city is not space zero; every record written before interiors would be indoors.');
    if (!isCity(CITY_SPACE)) failures.push('the city does not read as the city.');
    if (sanitiseSpace(undefined) !== CITY_SPACE) failures.push('a missing space did not default to the city.');
    if (sanitiseSpace(null) !== CITY_SPACE) failures.push('a null space did not default to the city.');
    if (sanitiseSpace('') !== CITY_SPACE) failures.push('an empty space did not default to the city.');
  }

  // --- **A building is never the city.**
  //
  // The worst bug available here: a footprint that hashes to zero would put its
  // inside on the street, and two players in different worlds would draw each
  // other and swing at each other through a wall.
  {
    if (spaceForBuilding(0) === CITY_SPACE) failures.push('a building that hashed to zero was given the city as its inside.');
    if (spaceForBuilding(-0) === CITY_SPACE) failures.push('negative zero produced the city.');
    if (spaceForBuilding(NaN) === CITY_SPACE) failures.push('a NaN seed produced the city.');
    for (let seed = 0; seed < 5000; seed++) {
      if (spaceForBuilding(seed) === CITY_SPACE) {
        failures.push(`seed ${seed} produced the city as an interior.`);
        break;
      }
    }
  }

  // --- Derived, so a cold server and a warm one agree.
  {
    const a = spaceForBuilding(0xdeadbeef);
    const b = spaceForBuilding(0xdeadbeef);
    if (a !== b) failures.push('one building produced two spaces; a restart would strand everybody inside it.');
    if (spaceForBuilding(0xdeadbeef) === spaceForBuilding(0xdeadbeee)) {
      failures.push('two buildings share one inside; every pub in Sydney would be the same room.');
    }
  }

  // --- It survives the wire.
  {
    for (const seed of [1, 2, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff]) {
      const id = spaceForBuilding(seed);
      if (id > MAX_SPACE || id < 0 || !Number.isInteger(id)) {
        failures.push(`seed ${seed} produced ${id}, which does not fit a u32 on the wire.`);
        break;
      }
      if (sanitiseSpace(id) !== id) failures.push(`space ${id} did not survive a round trip through the wire.`);
    }
    if (sanitiseSpace(MAX_SPACE + 1) !== CITY_SPACE) failures.push('a space past the wire ceiling was accepted.');
    if (sanitiseSpace(-1) !== CITY_SPACE) failures.push('a negative space was accepted.');
    if (sanitiseSpace(2.7) !== 2) failures.push('a fractional space did not truncate.');
  }

  // --- Distance means nothing across spaces.
  //
  // Two interiors are generated wherever they like and *will* overlap in metres.
  // This is the first question the AOI asks, before any radius.
  {
    const pub = spaceForBuilding(1111);
    const shop = spaceForBuilding(2222);
    if (!sameSpace(pub, pub)) failures.push('a player could not see themselves.');
    if (sameSpace(pub, shop)) failures.push('two different interiors were treated as one world.');
    if (sameSpace(pub, CITY_SPACE)) failures.push('somebody indoors shared a working set with the street.');
    if (!sameSpace(CITY_SPACE, CITY_SPACE)) failures.push('two people outdoors could not see each other.');
    // And an absent field on one side still means the city on both.
    if (!sameSpace(sanitiseSpace(undefined), CITY_SPACE)) {
      failures.push('a participant with no space field fell out of the city.');
    }
  }

  // --- The floor, which is the half a space id cannot carry.
  //
  // Every property here is one the interest filter reads directly, so a failure
  // is a person drawn in a room they are not in -- through a ceiling, which is
  // what makes it invisible to every other check in this file.
  {
    const pub = spaceForBuilding(0xabc123);
    const shop = spaceForBuilding(0xabc124);

    // The city is still zero, so every call site that passed `CITY_SPACE` where
    // an occupancy is now wanted is still asking the right question.
    if (CITY_OCCUPANCY !== CITY_SPACE) failures.push('the city and the city occupancy are different numbers.');
    if (occupancyOf(CITY_SPACE, 0) !== CITY_OCCUPANCY) failures.push('the ground of the city was not the city.');
    // A storey outdoors is meaningless and must not split the street in two: a
    // player standing on a roof and a player in the gutter are in one world.
    if (occupancyOf(CITY_SPACE, 7) !== CITY_OCCUPANCY) failures.push('a storey outdoors split the city into floors.');

    // Two floors of one building are two rooms; two buildings are never one.
    if (sameOccupancy(occupancyOf(pub, 0), occupancyOf(pub, 1))) {
      failures.push('two floors of one building read as the same room; a body would be drawn through the ceiling.');
    }
    if (!sameOccupancy(occupancyOf(pub, 3), occupancyOf(pub, 3))) failures.push('one floor did not equal itself.');
    if (sameOccupancy(occupancyOf(pub, 0), occupancyOf(shop, 0))) {
      failures.push('the ground floors of two different buildings read as one room.');
    }
    if (sameOccupancy(occupancyOf(pub, 0), CITY_OCCUPANCY)) {
      failures.push('a ground floor read as the street; the wall stopped being opaque.');
    }

    // **No two (space, level) pairs may collide**, which is the one property the
    // packing could get wrong and the only one whose symptom is two strangers in
    // different buildings punching each other. The neighbouring case is the
    // sharp one: space s at level 255 must not be space s+1 at level 0.
    {
      const top = occupancyOf(1234, LEVELS_PER_SPACE - 1);
      const next = occupancyOf(1235, 0);
      if (top === next) failures.push('the top floor of one building is the ground floor of the next.');
    }

    // It survives the worst space id there is. `|` and `<<` would fold
    // 0xffffffff to -1 here, which is why the packing is arithmetic.
    for (const seed of [1, 2, 0x7fffffff, 0x80000000, 0xfffffffe, MAX_SPACE]) {
      const space = spaceForBuilding(seed);
      for (const level of [0, 1, 127, LEVELS_PER_SPACE - 1]) {
        const key = occupancyOf(space, level);
        if (!Number.isSafeInteger(key)) {
          failures.push(`space ${space} on level ${level} produced ${key}, which is past what a double holds exactly.`);
          break;
        }
        if (occupancySpace(key) !== space) failures.push(`space ${space} did not survive the pack (got ${occupancySpace(key)}).`);
        if (occupancyLevel(key) !== level) failures.push(`level ${level} did not survive the pack (got ${occupancyLevel(key)}).`);
      }
    }

    // Rubbish clamps rather than wraps, on `sanitiseSpace`'s direction: a level
    // past the top is the top, never a different floor of the same building.
    const pubTop = occupancyOf(pub, LEVELS_PER_SPACE - 1);
    if (occupancyOf(pub, 10_000) !== pubTop) failures.push('a level past the top wrapped instead of clamping.');
    if (occupancyOf(pub, -3) !== occupancyOf(pub, 0)) failures.push('a negative level was not folded to the ground.');
    if (occupancyOf(pub, NaN) !== occupancyOf(pub, 0)) failures.push('a NaN level was not folded to the ground.');
    if (occupancySpace(CITY_OCCUPANCY) !== CITY_SPACE) failures.push('the city occupancy did not read back as the city.');
    if (occupancyLevel(CITY_OCCUPANCY) !== 0) failures.push('the city occupancy had a storey in it.');
    if (occupancySpace(-5) !== CITY_SPACE) failures.push('a negative occupancy was not folded to the city.');
  }

  return failures;
}
