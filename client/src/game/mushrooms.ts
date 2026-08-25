/**
 * What grows under the trees in the national park, and what it does to you.
 *
 * ---------------------------------------------------------------------------
 * ## Placement is a pure function of the tree, and that is the whole design
 *
 * A mushroom is not a record anybody stores. It is `(tile, tree index)` put
 * through a hash, exactly as `game/footy.ts` and `game/traffic.ts` decide where
 * ambient things are -- which is what makes it free to stream (a tile already
 * carries its trees, so the mushrooms under them cost no bytes and no server
 * state) and what lets *both ends agree without talking*. The client draws the
 * one you walked onto; the server, handed the same tile and index, can say
 * whether it is really there and really that colour before it poisons anybody.
 *
 * `SPAWN_RATE` is the owner's number: 5 trees in ten thousand. Over the bushland
 * inside `REGION_RADIUS_M` of the anchor that is a few hundred across a forest
 * you can walk for twenty minutes in, which is the density he asked for -- rare
 * enough to be a find, common enough to be a habit.
 *
 * **They move between visits and that is deliberate.** The hash takes an
 * `epoch`, and a client rolls a fresh one per session, so a patch you cleared on
 * Tuesday is somewhere else on Wednesday. Inside a session the epoch is fixed,
 * so walking away and coming back finds the same mushrooms in the same
 * places rather than a field that reshuffles behind your back -- the owner's
 * "temp perma", which is a stable world that is not a permanent one.
 *
 * ## The three caps
 *
 * Brown is the one worth eating. Orange costs a pip and takes your legs for half
 * an in-game hour. White kills you where you stand -- there is no saving throw
 * and no warning beyond the colour, which is the entire game of picking
 * mushrooms and is why the stems are all identical white.
 *
 * ## Stacking
 *
 * Brown caps stack to `MAX_STACK` (7), each for `BUFF_HOURS` in-game hours, and
 * the stack is what the screen is doing: one is a shimmer and seven is not a
 * screen any more. The count is a *number of live buffs*, not a level, so one
 * expiring drops you from six to five and the world comes back a notch -- which
 * is the shape a player can learn, and the shape WoW's buff bar has taught
 * everybody to read.
 */

/** East metres of the anchor the owner gave, and north metres. */
export const REGION_EAST = -5116;
export const REGION_NORTH = 8684;

/** How far from the anchor a mushroom may grow. */
export const REGION_RADIUS_M = 3000;

/**
 * How many trees carry one.
 *
 * **TEMPORARY: 5% for testing, not the shipping number.** The owner's rate is
 * `0.0005` -- five trees in ten thousand -- which is a find rather than a
 * feature you can walk to on purpose, and is what this must go back to before
 * anybody else plays. One line, and `SHIPPING_SPAWN_RATE` below is what to put
 * in it.
 */
export const SPAWN_RATE = 0.05;

/** What `SPAWN_RATE` is when the testing is over. See the note above it. */
export const SHIPPING_SPAWN_RATE = 0.0005;

/** How far from the trunk it sits, metres. Close enough to read as "its". */
export const OFFSET_MIN_M = 0.35;
export const OFFSET_MAX_M = 1.6;

/** Walk within this of one to eat it. */
export const EAT_RADIUS_M = 1.1;

export const CAP_BROWN = 0;
export const CAP_ORANGE = 1;
export const CAP_WHITE = 2;
export type CapKind = 0 | 1 | 2;

/**
 * How the three are distributed among the mushrooms that exist.
 *
 * Brown is common because it is the one the feature is *for*; white is rare
 * because it is instant death and a forest where one pick in three kills you is
 * a forest nobody walks into twice. Orange sits between as the honest mistake.
 */
export const CAP_WEIGHTS: readonly number[] = [0.6, 0.28, 0.12];

/** In-game hours a brown cap's buff lasts. */
export const BUFF_HOURS = 3;

/** In-game minutes an orange cap slows you for. */
export const ORANGE_SLOW_MINUTES = 30;

/** Pips an orange cap costs. */
export const ORANGE_DAMAGE = 1;

/** The most brown caps that can be live at once. Seven is the god room. */
export const MAX_STACK = 7;

/**
 * A 32-bit mix. `game/footy.ts`'s reason for having its own: this must produce
 * the same number on a server with no renderer and a browser with no `Math.sin`,
 * so it is integer operations and nothing else.
 */
export function hash32(a: number, b: number, c: number, d: number): number {
  let h = (a | 0) ^ Math.imul(b | 0, 0x27d4eb2d) ^ Math.imul(c | 0, 0x85ebca6b) ^ Math.imul(d | 0, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 15), 0x2545f491);
  h = Math.imul(h ^ (h >>> 13), 0x3f1d5b1f);
  return (h ^ (h >>> 16)) >>> 0;
}

/** `hash32` as a fraction in [0, 1). */
export function hashUnit(a: number, b: number, c: number, d: number): number {
  return hash32(a, b, c, d) / 4294967296;
}

/** Is this point inside the region mushrooms grow in? World metres, `z` south. */
export function insideRegion(x: number, z: number): boolean {
  const dx = x - REGION_EAST;
  // The anchor is given as north metres and the world's `z` runs south, which is
  // the one conversion in this file and the one place it could be wrong.
  const dz = z - -REGION_NORTH;
  return dx * dx + dz * dz <= REGION_RADIUS_M * REGION_RADIUS_M;
}

export interface Mushroom {
  /** Tile-local metres, the frame `TileVegetation` speaks. */
  x: number;
  z: number;
  cap: CapKind;
  /** Which tree it grew under, so an eat names something both ends can check. */
  treeIndex: number;
}

/**
 * Does this tree carry one, and if so what and where.
 *
 * `tileKey` is hashed as its two integers rather than its string, so the server
 * and the client cannot disagree about text encoding.
 */
export function mushroomFor(
  tileX: number,
  tileZ: number,
  treeIndex: number,
  epoch: number,
  treeLocalX: number,
  treeLocalZ: number,
): Mushroom | null {
  if (hashUnit(tileX, tileZ, treeIndex, epoch) >= SPAWN_RATE) return null;
  // A second, independent stream for everything about it, so changing the rate
  // does not reshuffle the colours of the ones that survive.
  const roll = hashUnit(tileX ^ 0x5bf03635, tileZ, treeIndex, epoch ^ 0x9e3779b9);
  let cap: CapKind = CAP_BROWN;
  let acc = 0;
  for (let i = 0; i < CAP_WEIGHTS.length; i++) {
    acc += CAP_WEIGHTS[i];
    if (roll < acc) {
      cap = i as CapKind;
      break;
    }
  }
  const angle = hashUnit(tileX, tileZ ^ 0x1b873593, treeIndex, epoch) * Math.PI * 2;
  const reach = OFFSET_MIN_M + hashUnit(tileX, tileZ, treeIndex ^ 0x7feb352d, epoch) * (OFFSET_MAX_M - OFFSET_MIN_M);
  return {
    x: treeLocalX + Math.cos(angle) * reach,
    z: treeLocalZ + Math.sin(angle) * reach,
    cap,
    treeIndex,
  };
}

/** One live brown-cap buff. */
export interface Trip {
  /** In-game milliseconds when it ends. */
  endsAtMs: number;
}

/** How long a brown cap lasts, in in-game milliseconds. */
export function buffDurationMs(msPerGameHour: number): number {
  return BUFF_HOURS * msPerGameHour;
}

/** How long an orange cap slows you, in in-game milliseconds. */
export function slowDurationMs(msPerGameHour: number): number {
  return (ORANGE_SLOW_MINUTES / 60) * msPerGameHour;
}

/**
 * The live stack at `nowMs`, newest last, expired dropped.
 *
 * Returns a new array rather than mutating, because the HUD reads it every frame
 * and the sim writes it on a pickup, and one shared array is how a countdown
 * ends up showing a buff that was eaten two seconds ago.
 */
export function liveTrips(trips: readonly Trip[], nowMs: number): Trip[] {
  return trips.filter((t) => t.endsAtMs > nowMs);
}

/** Seconds left on a buff, for the icon. Real seconds, at `rate` game-ms per real-ms. */
export function realSecondsLeft(trip: Trip, nowMs: number, gameMsPerRealMs: number): number {
  if (gameMsPerRealMs <= 0) return 0;
  return Math.max(0, (trip.endsAtMs - nowMs) / gameMsPerRealMs / 1000);
}

/**
 * What a stack of `n` brown caps is actually worth.
 *
 * **No speed.** The owner has refused speed buffs since the talent trees were
 * drawn and the refusal is in `game/teams.ts`'s header; a mushroom that made you
 * run faster would be the one thing in this feature he has already said no to
 * twice. So the ladder is *recovery and resilience* -- you come back faster,
 * you keep your feet, and you hit harder -- which is the same shape as being
 * hard to stop without being hard to catch.
 *
 * The curve is deliberately not linear. One through four are a good afternoon.
 * **Five is meant to feel amazing** and six **unbelievable**, because five is
 * where the screen stops being a screen and six is where it stops being a game
 * -- and a player who has eaten six and can still be knocked over by an eshay
 * has been lied to by the visuals. Seven is not on this ladder at all: seven is
 * the room, and what you come back with is `Double Health` or nothing.
 *
 * Every field is a multiplier or a flag so the sim can apply them the way it
 * already applies talent effects -- see `game/teams.FX` -- rather than growing a
 * second parallel notion of what a buff is.
 */
export interface TripPowers {
  /** Health regeneration, x normal. */
  regen: number;
  /** Damage taken, x normal. Under 1 is armour. */
  incoming: number;
  /** Swing damage, x normal. */
  outgoing: number;
  /** Knockdowns become staggers. */
  standsUp: boolean;
  /** Nothing knocks you down at all, and fall damage stops. */
  unshakeable: boolean;
}

const LADDER: readonly TripPowers[] = [
  { regen: 1, incoming: 1, outgoing: 1, standsUp: false, unshakeable: false },
  // 1: you notice it, and that is all.
  { regen: 1.6, incoming: 1, outgoing: 1, standsUp: false, unshakeable: false },
  // 2: pips come back between fights instead of after them.
  { regen: 2.4, incoming: 0.9, outgoing: 1.1, standsUp: false, unshakeable: false },
  // 3: you stop losing exchanges you used to lose.
  { regen: 3.4, incoming: 0.78, outgoing: 1.25, standsUp: true, unshakeable: false },
  // 4: you keep your feet, which is worth more than any number here.
  { regen: 4.6, incoming: 0.66, outgoing: 1.45, standsUp: true, unshakeable: false },
  // 5: amazing. Regeneration outruns an ordinary fight.
  { regen: 7, incoming: 0.45, outgoing: 1.9, standsUp: true, unshakeable: true },
  // 6: unbelievable, and meant to be. Half damage in, double out, nothing moves
  //    you, and you heal through most of what is left.
  { regen: 12, incoming: 0.3, outgoing: 2.6, standsUp: true, unshakeable: true },
];

/** The powers for a live stack of `n`. Clamped; `n` over `MAX_STACK` is the room. */
export function tripPowers(n: number): TripPowers {
  const i = Math.max(0, Math.min(LADDER.length - 1, Math.floor(n)));
  return LADDER[i];
}

export function verifyMushrooms(): string[] {
  const failures: string[] = [];

  // --- The region is where the owner put it, and `z` is south.
  if (!insideRegion(REGION_EAST, -REGION_NORTH)) {
    failures.push('The anchor is not inside its own region; the north-to-z conversion is inverted.');
  }
  if (insideRegion(REGION_EAST, REGION_NORTH)) {
    failures.push('A point the same distance *south* of the origin read as inside the region: `z` is south, `north` is not.');
  }
  if (insideRegion(REGION_EAST + REGION_RADIUS_M + 10, -REGION_NORTH)) {
    failures.push('A point past the radius read as inside it.');
  }
  if (!insideRegion(REGION_EAST + REGION_RADIUS_M - 10, -REGION_NORTH)) {
    failures.push('A point just inside the radius read as outside it.');
  }

  // --- The rate is the owner's, measured rather than trusted.
  {
    let found = 0;
    const trees = 400000;
    for (let i = 0; i < trees; i++) {
      if (mushroomFor(3, -7, i, 11, 0, 0) !== null) found++;
    }
    const rate = found / trees;
    if (Math.abs(rate - SPAWN_RATE) > SPAWN_RATE * 0.35) {
      failures.push(`${(rate * 100).toFixed(4)}% of trees carried one against the ${(SPAWN_RATE * 100).toFixed(2)}% asked for.`);
    }
    if (found === 0) failures.push('No tree in four hundred thousand carried a mushroom.');
  }

  // --- Deterministic: the same tree is the same mushroom, every time.
  {
    let checked = 0;
    for (let i = 0; i < 60000 && checked < 40; i++) {
      const a = mushroomFor(1, 2, i, 5, 10, 20);
      if (a === null) continue;
      checked++;
      const b = mushroomFor(1, 2, i, 5, 10, 20);
      if (b === null || a.x !== b.x || a.z !== b.z || a.cap !== b.cap) {
        failures.push('The same tree produced two different mushrooms; both ends would disagree.');
        break;
      }
    }
    if (checked === 0) failures.push('No mushroom was found to test determinism with.');
  }

  // --- A new epoch moves them, which is the "temp" half of temp-perma.
  {
    const before = new Set<number>();
    const after = new Set<number>();
    for (let i = 0; i < 200000; i++) {
      if (mushroomFor(4, 4, i, 1, 0, 0) !== null) before.add(i);
      if (mushroomFor(4, 4, i, 2, 0, 0) !== null) after.add(i);
    }
    if (before.size === 0 || after.size === 0) failures.push('An epoch produced no mushrooms at all.');
    let same = 0;
    for (const i of before) if (after.has(i)) same++;
    if (before.size > 0 && same === before.size) {
      failures.push('A new epoch grew the same mushrooms under the same trees; they would never move.');
    }
  }

  // --- It sits near its trunk, never on it and never a tree away.
  {
    let checked = 0;
    for (let i = 0; i < 200000 && checked < 200; i++) {
      const m = mushroomFor(2, 9, i, 3, 100, -50);
      if (m === null) continue;
      checked++;
      const d = Math.hypot(m.x - 100, m.z - -50);
      if (d < OFFSET_MIN_M - 1e-6 || d > OFFSET_MAX_M + 1e-6) {
        failures.push(`A mushroom grew ${d.toFixed(2)} m from its trunk, outside ${OFFSET_MIN_M}-${OFFSET_MAX_M}.`);
        break;
      }
    }
  }

  // --- All three caps happen, and the deadly one is the rare one.
  {
    const seen = [0, 0, 0];
    for (let i = 0; i < 400000; i++) {
      const m = mushroomFor(6, 6, i, 6, 0, 0);
      if (m !== null) seen[m.cap]++;
    }
    for (let c = 0; c < 3; c++) if (seen[c] === 0) failures.push(`Cap ${c} never occurred in four hundred thousand trees.`);
    if (seen[CAP_WHITE] >= seen[CAP_BROWN]) {
      failures.push(`White caps (${seen[CAP_WHITE]}) are not rarer than brown (${seen[CAP_BROWN]}); the forest kills more than it feeds.`);
    }
  }
  if (Math.abs(CAP_WEIGHTS.reduce((a, b) => a + b, 0) - 1) > 1e-9) {
    failures.push('The cap weights do not sum to 1; the last one absorbs the remainder silently.');
  }

  // --- The stack expires, oldest first, and never exceeds the god number.
  {
    const HOUR = 3_600_000;
    const trips: Trip[] = [{ endsAtMs: 1000 }, { endsAtMs: 5000 }, { endsAtMs: 9000 }];
    if (liveTrips(trips, 0).length !== 3) failures.push('A fresh stack was not all live.');
    if (liveTrips(trips, 5000).length !== 1) failures.push('An expired buff stayed in the stack.');
    if (liveTrips(trips, 20000).length !== 0) failures.push('The stack never empties.');
    if (buffDurationMs(HOUR) !== BUFF_HOURS * HOUR) failures.push('A brown cap does not last its stated hours.');
    if (slowDurationMs(HOUR) !== HOUR / 2) failures.push('An orange cap does not slow for half an in-game hour.');
    if (MAX_STACK !== 7) failures.push(`The stack caps at ${MAX_STACK}; the god room is the seventh.`);
  }

  // --- The icon counts down in the player's seconds, not the world's.
  {
    // Ten in-game minutes at ten game-ms per real-ms is one real minute.
    const left = realSecondsLeft({ endsAtMs: 600_000 }, 0, 10);
    if (Math.abs(left - 60) > 1e-9) failures.push(`A ten-minute buff read as ${left.toFixed(1)} real seconds, not 60.`);
    if (realSecondsLeft({ endsAtMs: 0 }, 5000, 10) !== 0) failures.push('An expired buff counted down past zero.');
    if (realSecondsLeft({ endsAtMs: 100 }, 0, 0) !== 0) failures.push('A stopped clock produced a division by zero.');
  }

  // --- The ladder climbs, and it never once mentions speed.
  {
    const zero = tripPowers(0);
    if (zero.regen !== 1 || zero.incoming !== 1 || zero.outgoing !== 1 || zero.standsUp || zero.unshakeable) {
      failures.push('An empty stack was not a plain player.');
    }
    for (let n = 1; n <= MAX_STACK - 1; n++) {
      const prev = tripPowers(n - 1);
      const cur = tripPowers(n);
      if (cur.regen <= prev.regen) failures.push(`Stack ${n} does not recover faster than ${n - 1}.`);
      if (cur.incoming > prev.incoming) failures.push(`Stack ${n} takes more damage than ${n - 1}.`);
      if (cur.outgoing < prev.outgoing) failures.push(`Stack ${n} hits softer than ${n - 1}.`);
      if (prev.standsUp && !cur.standsUp) failures.push(`Stack ${n} lost a footing ${n - 1} had.`);
      if (prev.unshakeable && !cur.unshakeable) failures.push(`Stack ${n} lost an immunity ${n - 1} had.`);
    }
    // Five is amazing and six is unbelievable, asserted as *gaps* rather than
    // as numbers, so tuning the ladder cannot quietly flatten its own shape.
    const four = tripPowers(4);
    const five = tripPowers(5);
    const six = tripPowers(6);
    if (!five.unshakeable) failures.push('Five is meant to be amazing and can still be knocked over.');
    if (five.regen < four.regen * 1.4) failures.push('Five is not a step up from four; the screen promises more than the sim delivers.');
    if (six.regen < five.regen * 1.4 || six.outgoing < five.outgoing * 1.25) {
      failures.push('Six is not unbelievable, it is just six.');
    }
    if (six.incoming > 0.35) failures.push(`Six takes ${six.incoming}x damage; a player who has eaten six should be very hard to stop.`);
    // Seven is the room, not a rung.
    if (tripPowers(MAX_STACK).regen !== six.regen) failures.push('Seven has its own powers; seven is the room.');
    if (tripPowers(99).regen !== six.regen) failures.push('The ladder is not clamped.');
    // **The standing refusal.** See `game/teams.ts`: no speed buffs, ever.
    for (let n = 0; n <= MAX_STACK; n++) {
      const keys = Object.keys(tripPowers(n));
      if (keys.some((k) => /speed|sprint|pace|haste/i.test(k))) {
        failures.push(`Stack ${n} carries a speed field; the owner has refused speed buffs since the trees were drawn.`);
      }
    }
  }

  return failures;
}
