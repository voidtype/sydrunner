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

  return failures;
}
