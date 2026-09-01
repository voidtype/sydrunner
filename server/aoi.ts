/**
 * Interest management: which slice of the world each client is actually sent.
 *
 * PERFORMANCE.md phase 2, and the whole of what protocol v8 exists to carry. The
 * phase 1 capacity curve found that the simulation runs to about 2,700 players
 * on one core and the *broadcast* stops it at 500 -- 2.2 Gbit/s out of one
 * process at 750, because every client was sent every player. This file is the
 * answer: a client is sent the players it can see, and "can see" is a rule with
 * three numbers in it that live in `net/protocol.ts` so both ends state them
 * once.
 *
 * ---------------------------------------------------------------------------
 * ## The rule, in one sentence
 *
 * **A client's working set is the `AOI_MAX_PLAYERS` nearest *eligible* players,
 * where eligible means within `AOI_ENTER_RADIUS`, or within `AOI_LEAVE_RADIUS`
 * and already a member.**
 *
 * That is one sentence rather than two because the alternative -- "keep old
 * members, then add new ones until full" -- is subtly wrong and the wrongness is
 * visible. Consider a player at the edge of a crowd with a full set of forty
 * people at 200 m, all retained by the band. Somebody walks up and punches them.
 * Under "keep, then add", the attacker cannot get in: the cap is full of distant
 * retainees and the nearest player in the game is invisible. Under the rule
 * above, hysteresis decides *eligibility* and distance decides *priority*, so the
 * attacker displaces the furthest retainee and the set is always the nearest
 * forty of whoever qualifies.
 *
 * Ties -- two players at exactly the same distance, which happens at a spawn
 * ring and nowhere else -- go to the lower id, so the selection is a total order
 * and two runs of the same tick produce the same set. That matters more here
 * than it looks: the set is the **dedup key** (see below), so a selection that
 * was merely usually-the-same would split a group in half at random and halve
 * the saving.
 *
 * ---------------------------------------------------------------------------
 * ## And the same rule for the balls, which took a load run to notice
 *
 * WORKSTREAM AD. The paragraphs above are about *players*, and for four
 * versions that was the whole of interest management: the ball section had a
 * radius and no cap, which is half a rule. PERFORMANCE.md phase 4 found the
 * other half missing the hard way -- a CBD pileup at 372 kbit/s a client, *"the
 * rest is the ball section, which interest management does not bound in a
 * pileup because all the balls are in the same place as all the people"* -- and
 * a re-measurement on this tree found the section had since grown to **105
 * balls in the air**, over 2 kB a snapshot, half of everything a client was
 * being sent.
 *
 * So `selectBalls` is now the same shape as `select`: a radius
 * (`AOI_BALL_RADIUS`, tighter, because a football is not a person), a cap
 * (`AOI_MAX_BALLS`, the same forty), the same nearest-first insertion with the
 * same tie-break, and the same ascending output order so the dedup below still
 * groups. The two places it deliberately differs -- no hysteresis band, and
 * your own throws dropped rather than privileged -- are argued at the method.
 *
 * ---------------------------------------------------------------------------
 * ## Why the query is one 220 m sweep and not the two the phase 1 note predicted
 *
 * `game/spatialhash.ts`'s header wrote the recipe down as
 * `forEachWithin(x, z, 220, cb)` for the hysteresis sweep and
 * `nearestK(x, z, 180, 40, out)` for the cap, and it is one sweep here instead.
 * The reason is the paragraph above: `nearestK(180, 40)` answers "the forty
 * nearest within 180", which cannot express "and these three at 200 m who were
 * already members", and unioning the two answers puts the cap back on the
 * outside where it has to be re-applied anyway. So the walk is done once at
 * `AOI_LEAVE_RADIUS`, the eligibility test is applied per candidate, and the cap
 * is a forty-long insertion -- which is exactly what `nearestK` does internally,
 * over a candidate set this file has already filtered.
 *
 * The cell is **64 m**, not the melee's 8 m, and that is the other half of the
 * phase 1 note. A 220 m query at cell 8 walks 55x55 = 3,025 cells; at cell 64 it
 * walks 8x8 = 64. The cost of the coarser cell is longer chains -- a 64 m square
 * of Sydney holds more people than an 8 m one -- and that is the right trade
 * here because this query *wants* everybody in the area, where the melee wants
 * the two people within arm's reach.
 *
 * ---------------------------------------------------------------------------
 * ## The dedup, which is what keeps the encode off the critical path
 *
 * Phase 1's pooled encoder rested on every client being sent identical bytes:
 * one encode, one buffer, a two-byte ack patched per client. AOI takes that away
 * by construction -- a filtered snapshot is per client by definition -- and the
 * measured cost of giving it back is the reason this file has a second half.
 *
 * The observation is that a **frame set** (the ids of the players, balls and
 * actors a client is sent) is shared by everybody standing in the same place.
 * Six people brawling on one corner have the same six-member working set, see the
 * same two balls in the air and the same officer, so their frames are the same
 * 150 bytes with a different ack -- which is exactly phase 1's case again, at
 * the granularity of a neighbourhood instead of a room. So clients are clustered
 * by frame set, one buffer is encoded per **distinct set**, and the ack is
 * patched per client out of it. `checkAoi` asserts the byte-identity that makes
 * that legal, exactly as `checkSpatialHash` asserts phase 1's.
 *
 * **The cap is what bounds how well this can work, and the direction is the
 * opposite of what it looks like.** Measured (`checkAoi`, and PERFORMANCE.md
 * phase 4):
 *
 *   - A cluster **under** the cap dedups almost perfectly. Twenty-four people
 *     inside 30 m with nobody else within 400 m all have the *same* twenty-four
 *     member set, so twenty-four clients are served by one encode.
 *   - A cluster **over** the cap dedups poorly, because each client is sent its
 *     own forty nearest and forty-five people on a ring do not agree about who
 *     those are. Ninety players half-piled and half-scattered measured **1.25**.
 *
 * That is worth stating plainly rather than rounding up, because the intuition
 * ("a pileup dedups perfectly") is wrong and would have been repeated. What
 * makes it acceptable is that the cap is doing the *bigger* job in exactly that
 * case: forty-five people in one place cost each client forty records rather
 * than forty-five, and it is the cap, not the dedup, that stops a hundred and
 * twenty-eight. The dedup is a second-order saving on encode CPU -- and encode
 * CPU was never the wall.
 *
 * ---------------------------------------------------------------------------
 * ## Allocation
 *
 * Zero per tick after warm-up, on `game/spatialhash.ts`'s terms and for its
 * reason. Working sets are arrays owned by an `InterestSet` and rewritten in
 * place; the enter/leave deltas are pooled records; the frame groups are pooled
 * objects reused across ticks with their buffers grown to a high-water mark. A
 * 60 Hz room with 128 clients allocates nothing here.
 */

import {
  AOI_BALL_RADIUS,
  AOI_ENTER_RADIUS,
  AOI_LEAVE_RADIUS,
  AOI_MAX_BALLS,
  AOI_MAX_PLAYERS,
  type SnapshotBall,
  type SnapshotNpc,
  type SnapshotPlayer,
} from '../client/src/net/protocol.ts';
import { SpatialHash } from '../client/src/game/spatialhash.ts';
// Interiors. **The first question this file asks, before any distance.** See
// `sameSpace`'s own note there, and INTERIORS.md.
import { CITY_SPACE } from '../client/src/net/spaces.ts';

/**
 * The AOI grid's cell edge, metres. See the header, and `game/spatialhash.ts`'s
 * own note about 8 versus 64.
 */
export const AOI_CELL = 64;

const ENTER2 = AOI_ENTER_RADIUS * AOI_ENTER_RADIUS;
const LEAVE2 = AOI_LEAVE_RADIUS * AOI_LEAVE_RADIUS;
/** The ball section's own radius, squared. See `InterestIndex.selectBalls`. */
const BALL2 = AOI_BALL_RADIUS * AOI_BALL_RADIUS;

/**
 * What one client currently holds, and what changed about it this snapshot.
 *
 * One of these per connection, living as long as the connection does -- which is
 * what gives the hysteresis a memory. Everything in it is owned by this object
 * and rewritten in place; a caller must serialise before the next `update`,
 * which is the contract every pooled thing in this codebase already has.
 */
export class InterestSet {
  /**
   * The members, **ascending by id**. This is what the snapshot is encoded from
   * and what the dedup key is computed over.
   *
   * Ascending rather than nearest-first, and the difference is the whole of why
   * the dedup works: two clients with the same members must produce the same
   * bytes, so the record order has to be a function of the *set* and not of
   * where either of them is standing. Distance decides who is in; the id decides
   * what order they are written in.
   */
  readonly members: number[] = [];
  /** The same ids, for the O(1) "was this a member" test the band needs. */
  private readonly memberOf = new Set<number>();

  /** Ids that joined this snapshot, and ids that left it. Rewritten per update. */
  readonly entered: number[] = [];
  readonly left: number[] = [];

  /** A rolling hash of `members`. See `frameKey`. */
  key = 0;

  has(id: number): boolean {
    return this.memberOf.has(id);
  }

  /**
   * Adopt `next` (ascending ids), filling `entered` and `left` with the delta.
   *
   * A merge of two ascending lists rather than two set differences, which is
   * what keeps this allocation-free and O(n + m): both sides are already sorted,
   * so the delta falls out of one walk.
   */
  update(next: readonly number[]): void {
    this.entered.length = 0;
    this.left.length = 0;
    let i = 0;
    let j = 0;
    while (i < this.members.length || j < next.length) {
      const a = i < this.members.length ? this.members[i] : Infinity;
      const b = j < next.length ? next[j] : Infinity;
      if (a === b) {
        i++;
        j++;
      } else if (a < b) {
        this.left.push(a);
        i++;
      } else {
        this.entered.push(b);
        j++;
      }
    }
    if (this.entered.length > 0 || this.left.length > 0) {
      for (const id of this.left) this.memberOf.delete(id);
      for (const id of this.entered) this.memberOf.add(id);
      this.members.length = next.length;
      for (let k = 0; k < next.length; k++) this.members[k] = next[k];
    }
  }

  /** Forget everything. Used when a client's own body is replaced (it is not). */
  clear(): void {
    this.members.length = 0;
    this.memberOf.clear();
    this.entered.length = 0;
    this.left.length = 0;
    this.key = 0;
  }
}

/**
 * The grid every client's working set is selected out of, rebuilt per snapshot.
 *
 * Built from the **snapshot records** rather than from the combatants, which is
 * not incidental: those records are the pooled arrays `Simulation.snapshot`
 * already produced for this tick, they are already in ascending id order, and
 * building the interest index off them means AOI reads nothing the transport was
 * not already holding. The alternative -- a second index over `Simulation`'s own
 * bodies -- would have needed the simulation to expose its internals to the
 * transport for no gain at all.
 */
export class InterestIndex {
  private readonly hash = new SpatialHash<number>(AOI_CELL);
  private players: readonly SnapshotPlayer[] = [];
  private balls: readonly SnapshotBall[] = [];
  private npcs: readonly SnapshotNpc[] = [];
  /**
   * Player id to its index in `players`, rebuilt per snapshot tick.
   *
   * A working set is a list of *ids* -- it has to be, because it outlives the
   * tick and drives the enter/leave deltas -- and the encoder wants *records*.
   * One map lookup per member beats walking the room to merge two sorted lists:
   * at 128 players and 40 members that is 40 lookups against 168 comparisons,
   * per client, per snapshot.
   */
  private readonly bySlot = new Map<number, number>();
  /**
   * Which world each slot's player is in, by slot. See `begin`.
   *
   * A parallel array rather than a field on `SnapshotPlayer`, because the space
   * is deliberately **not on the wire** (`PROTOCOL_VERSION`'s v23 note): a
   * record is what goes out, and this is a fact about the sender that never
   * does. Grown to a high-water mark and rewritten in place, on this file's own
   * allocation rule.
   */
  private readonly spaces: number[] = [];

  /** Distances and ids of the current selection, kept sorted nearest-first. */
  private readonly selD2: number[] = [];
  private readonly selId: number[] = [];
  /** The same pair for the ball cap. See `selectBalls`. */
  private readonly ballD2: number[] = [];
  private readonly ballIdx: number[] = [];

  /** How many candidates the last `select` walk considered. For `/stats`. */
  candidatesSeen = 0;

  /**
   * Take this snapshot tick's records. Call once per snapshot tick, per room.
   *
   * The arrays are **borrowed, not copied** -- they are the simulation's pooled
   * ones and are valid until the next `step`, which is the same window the
   * encode already runs in.
   */
  begin(
    players: readonly SnapshotPlayer[],
    balls: readonly SnapshotBall[],
    npcs: readonly SnapshotNpc[],
    spaceOf: ((id: number) => number) | null = null,
  ): void {
    this.players = players;
    this.balls = balls;
    this.npcs = npcs;
    this.hash.clear();
    this.bySlot.clear();
    this.spaces.length = players.length;
    for (let i = 0; i < players.length; i++) {
      this.hash.insert(i, players[i].x, players[i].z);
      this.bySlot.set(players[i].id, i);
      // Null means a world with no interiors in it, which is what every check
      // below runs against and what this file did before there were any.
      this.spaces[i] = spaceOf === null ? CITY_SPACE : spaceOf(players[i].id);
    }
  }

  /** The records `begin` was given, for a caller that wants to encode from them. */
  get playerRecords(): readonly SnapshotPlayer[] {
    return this.players;
  }

  /**
   * Where a member id sits in this tick's records, or -1.
   *
   * -1 is reachable and is not an error: a client's working set is computed
   * before the delta is applied, so nothing in it can be stale -- but a caller
   * that held an id across a `begin` (a departure between two snapshot ticks)
   * would ask about somebody who has left, and returning -1 lets it skip the
   * record rather than encode a hole.
   */
  slotOf(id: number): number {
    return this.bySlot.get(id) ?? -1;
  }

  /**
   * The working set for a client standing at `(x, z)`, into `out` (ascending
   * ids). `held` is what that client had last snapshot; see the header's rule.
   *
   * A client's **own** id needs no special case: it is at distance zero from
   * itself, so it is always eligible and always the first thing the cap keeps.
   * That is worth stating because prediction depends on it -- `net/client.ts`
   * reconciles against its own record in every snapshot, and a set that could
   * omit you would be a client that stopped being able to reconcile in a crowd.
   */
  select(x: number, z: number, space: number, held: InterestSet, out: number[]): number[] {
    const d2s = this.selD2;
    const ids = this.selId;
    d2s.length = 0;
    ids.length = 0;
    let seen = 0;

    this.hash.forEachWithin(x, z, AOI_LEAVE_RADIUS, (slot) => {
      seen++;
      // **The space, before the distance, and it is not a refinement of it.**
      //
      // An interior sits at its building's own coordinates (see
      // `world/interior.ts`), so somebody standing in a terrace and somebody on
      // the pavement outside are a metre and a half apart in two different
      // worlds. Every radius in this file contains that, and no radius could
      // ever exclude it -- distance is simply not the question across a space
      // boundary. Without this line the two of them draw each other through the
      // wall, and `server/sim.ts` lets them punch each other through it.
      //
      // Asked here rather than by filtering the records in `begin`, because the
      // index is built once per snapshot tick and consulted once per client:
      // one array lookup per candidate against a second index per space.
      if (this.spaces[slot] !== space) return;
      const p = this.players[slot];
      const dx = p.x - x;
      const dz = p.z - z;
      const d2 = dx * dx + dz * dz;
      // The band. Inside 180 anybody qualifies; between 180 and 220 only
      // somebody who was already here, which is what stops a player standing on
      // the line entering and leaving on alternate snapshots forever.
      if (d2 > ENTER2 && !(d2 <= LEAVE2 && held.has(p.id))) return;
      const id = p.id;
      // A `k`-long insertion, which is `SpatialHash.nearestK`'s selection over a
      // candidate set this callback has already filtered. Ties to the lower id,
      // so the set is a total order and the dedup key is stable.
      if (ids.length === AOI_MAX_PLAYERS) {
        const worstD2 = d2s[AOI_MAX_PLAYERS - 1];
        if (d2 > worstD2 || (d2 === worstD2 && id > ids[AOI_MAX_PLAYERS - 1])) return;
      }
      let i = ids.length < AOI_MAX_PLAYERS ? ids.length : AOI_MAX_PLAYERS - 1;
      if (ids.length < AOI_MAX_PLAYERS) {
        ids.push(id);
        d2s.push(d2);
      }
      while (i > 0 && (d2s[i - 1] > d2 || (d2s[i - 1] === d2 && ids[i - 1] > id))) {
        ids[i] = ids[i - 1];
        d2s[i] = d2s[i - 1];
        i--;
      }
      ids[i] = id;
      d2s[i] = d2;
    });
    this.candidatesSeen = seen;

    // Nearest-first became the selection; ascending-by-id is what goes on the
    // wire. An insertion sort over at most forty, which beats a comparator sort
    // at this size and allocates nothing.
    out.length = 0;
    for (const id of ids) {
      let i = out.length;
      out.push(id);
      while (i > 0 && out[i - 1] > id) {
        out[i] = out[i - 1];
        i--;
      }
      out[i] = id;
    }
    return out;
  }

  /**
   * The balls one client is sent, as indices into this tick's ball records:
   * within `AOI_BALL_RADIUS`, the `AOI_MAX_BALLS` nearest of those, and never
   * one this client threw.
   *
   * **Interest by the ball's own position, not by its thrower's**, which was
   * the first thing worth stating about this filter and still is. A ball is
   * most interesting to the player it is about to reach, who by definition is
   * nowhere near whoever threw it -- so filtering by thrower would hide
   * precisely the ball that mattered. Filtering by where the ball *is* means it
   * enters your stream as it crosses into your radius, which at 110 m and a
   * 28 m/s launch is 3.9 seconds of warning.
   *
   * ---------------------------------------------------------------------------
   * ## WORKSTREAM AD: why the radius was never the bound, and the cap is
   *
   * PERFORMANCE.md phase 4's CBD pileup measured a client's downlink at
   * 372 kbit/s and found *"mostly footballs, not people"* -- 67 balls in the
   * air, about 60% of the stream. The radius above did nothing about it and
   * could not have: the balls in a pileup are in the same forty metres as the
   * people, so **every** radius in this file contains all of them. What the
   * player section has and this one did not is the other half of the rule --
   * the cap. `AOI_MAX_BALLS` is that half, and the selection is the same
   * `k`-long insertion `select` uses, over the same total order (distance, then
   * the record's own index for ties) so that two clients standing together
   * agree byte for byte and the frame dedup still works.
   *
   * **The three differences from the player rule are all deliberate:**
   *
   *   - **No hysteresis band.** A ball that flapped across the boundary would
   *     be flapping 110 m away, where it is two pixels and has no identity
   *     anybody is holding. The band exists to stop a *remote actor* being
   *     built and disposed twenty times a second; a ball is a record in a map,
   *     rebuilt from the newest snapshot's list every frame by
   *     `net/client.interpolateBalls`.
   *   - **A tighter radius**, 110 m against the players' 220. Argued at
   *     `AOI_BALL_RADIUS`: the floor is what a player could still *act* on
   *     (11 m, four rewind windows of the fastest ball there is) and the
   *     ceiling is what a player can still *see* (a football at 220 m is 2.2
   *     pixels on a 1080p 60-degree view).
   *   - **Your own throws are dropped, not privileged.** The obvious rule is
   *     the opposite -- always keep the thrower's own ball, because it is what
   *     corrects their prediction -- and this client does not work that way.
   *     `net/client.interpolateBalls` opens with
   *     `if (this.ownBall(b.thrower)) continue`, because `main.ts` flies its own
   *     `localBalls` copy at present time and the wire's copy is 100 ms behind
   *     it; the correction a thrower gets is the `MSG.SWAT` event instead. A
   *     swat deliberately leaves `thrower` alone (`footy.Footy.owner` is the
   *     field that changes), so the filter holds for the ball's whole life and
   *     those records are seventeen bytes each that the receiver discards on
   *     its first line. `verifyAoi` pins it, because it is the kind of saving
   *     somebody would "fix" back.
   *
   * `ownId` is the selecting client's player id. Pass 0 for a viewer that threw
   * nothing -- no live player is 0 (`protocol.AOI_ID_LIFECYCLE`), and a ball
   * whose thrower has left carries `thrower === 0`, which is why the test is
   * `ownId !== 0 &&` rather than a bare comparison: without it, every orphaned
   * ball in the room would be hidden from everybody.
   */
  selectBalls(x: number, z: number, ownId: number, space: number, out: number[]): number[] {
    const d2s = this.ballD2;
    const idx = this.ballIdx;
    d2s.length = 0;
    idx.length = 0;
    out.length = 0;
    // Indoors sees no footballs, because there are none: `server/sim.ts` clears
    // the throw button for a body in a building, on the grounds that a ball is
    // an object with its own physics against the *city's* collision and one
    // thrown in a pub would sail through the wall. Every ball in the room is
    // therefore in the city, and the sender is not.
    if (space !== CITY_SPACE) return out;
    for (let i = 0; i < this.balls.length; i++) {
      const b = this.balls[i];
      if (ownId !== 0 && b.thrower === ownId) continue;
      const dx = b.x - x;
      const dz = b.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > BALL2) continue;
      // The same `k`-long insertion `select` runs, and for the same two
      // reasons: it is `SpatialHash.nearestK`'s selection over a candidate set
      // already filtered, and the tie-break makes the result a total order so
      // the dedup key is stable. A linear scan rather than a grid because
      // `footy.MAX_BALLS` bounds the room's ball count in the low hundreds --
      // the same argument `selectNpcs` makes about 24 actors.
      if (idx.length === AOI_MAX_BALLS) {
        const worstD2 = d2s[AOI_MAX_BALLS - 1];
        if (d2 > worstD2 || (d2 === worstD2 && i > idx[AOI_MAX_BALLS - 1])) continue;
      }
      let k = idx.length < AOI_MAX_BALLS ? idx.length : AOI_MAX_BALLS - 1;
      if (idx.length < AOI_MAX_BALLS) {
        idx.push(i);
        d2s.push(d2);
      }
      while (k > 0 && (d2s[k - 1] > d2 || (d2s[k - 1] === d2 && idx[k - 1] > i))) {
        idx[k] = idx[k - 1];
        d2s[k] = d2s[k - 1];
        k--;
      }
      idx[k] = i;
      d2s[k] = d2;
    }
    // Nearest-first became the selection; ascending-by-index is what goes on
    // the wire, on `select`'s argument exactly -- two clients with the same set
    // must produce the same bytes, so the order has to be a function of the set
    // and not of where either of them is standing.
    out.length = 0;
    for (const i of idx) {
      let k = out.length;
      out.push(i);
      while (k > 0 && out[k - 1] > i) {
        out[k] = out[k - 1];
        k--;
      }
      out[k] = i;
    }
    return out;
  }

  /**
   * Every faction actor within interest, as indices into the actor records.
   *
   * A linear scan rather than a grid, and deliberately: `factions.MAX_ACTORS` is
   * **24 per room**, so this is 24 distance tests per client per snapshot --
   * 61,000 a second at a full room, which is a rounding error against the
   * 26 million the pickup sweep used to cost before phase 1. A second spatial
   * hash to accelerate a 24-element scan would be more code, more rebuild cost,
   * and slower.
   */
  selectNpcs(x: number, z: number, space: number, out: number[]): number[] {
    out.length = 0;
    // And no police indoors, on the balls' argument: an officer walks a beat on
    // the city's footpaths, so an actor within 220 m of somebody in a building
    // is an actor on the other side of its wall.
    if (space !== CITY_SPACE) return out;
    for (let i = 0; i < this.npcs.length; i++) {
      const n = this.npcs[i];
      const dx = n.x - x;
      const dz = n.z - z;
      if (dx * dx + dz * dz <= LEAVE2) out.push(i);
    }
    return out;
  }
}

// --- The dedup: clustering clients by what they are being sent ------------------

/**
 * A rolling hash of one frame's three id lists.
 *
 * FNV-1a's constants over `Math.imul`, which is the integer hash this project
 * uses everywhere and is exact in both runtimes. The section separators are not
 * decoration: without them, `players [1,2] balls []` and `players [1] balls [2]`
 * hash the same, and two clients seeing genuinely different things would land in
 * one group -- where the array comparison below would reject them, but only
 * after doing the work.
 */
export function frameKey(players: readonly number[], balls: readonly number[], npcs: readonly number[]): number {
  let h = 0x811c9dc5 | 0;
  for (const id of players) h = Math.imul(h ^ id, 0x01000193);
  h = Math.imul(h ^ 0x5eeded, 0x01000193);
  for (const id of balls) h = Math.imul(h ^ id, 0x01000193);
  h = Math.imul(h ^ 0xba11, 0x01000193);
  for (const id of npcs) h = Math.imul(h ^ id, 0x01000193);
  return h >>> 0;
}

/**
 * One distinct frame set, and the bytes every client holding it is sent.
 *
 * The `buffer` grows to its own high-water mark and is never shrunk, on
 * `server/index.ts`'s own terms about the phase 1 snapshot pool: a group that
 * has held forty players once will hold forty again, and a reallocating encoder
 * is the thing all of this exists to avoid. Groups themselves are pooled by
 * `FrameGroups` and reused across ticks, so a steady room allocates nothing.
 */
export class FrameGroup {
  key = 0;
  readonly players: number[] = [];
  readonly balls: number[] = [];
  readonly npcs: number[] = [];
  /** How many clients are being sent these bytes. The dedup ratio's numerator. */
  clients = 0;
  buffer: ArrayBuffer = new ArrayBuffer(0);
  view: DataView = new DataView(this.buffer);
  bytes: Uint8Array = new Uint8Array(this.buffer);
  /** Bytes actually written by the last encode. */
  length = 0;

  /** Grow the buffer to hold `need` bytes, keeping it if it already does. */
  reserve(need: number): void {
    if (this.buffer.byteLength >= need) return;
    this.buffer = new ArrayBuffer(need);
    this.view = new DataView(this.buffer);
    this.bytes = new Uint8Array(this.buffer);
  }

  /** Whether this group's set is exactly these three lists. */
  matches(players: readonly number[], balls: readonly number[], npcs: readonly number[]): boolean {
    if (this.players.length !== players.length || this.balls.length !== balls.length || this.npcs.length !== npcs.length) {
      return false;
    }
    for (let i = 0; i < players.length; i++) if (this.players[i] !== players[i]) return false;
    for (let i = 0; i < balls.length; i++) if (this.balls[i] !== balls[i]) return false;
    for (let i = 0; i < npcs.length; i++) if (this.npcs[i] !== npcs[i]) return false;
    return true;
  }

  private adopt(players: readonly number[], balls: readonly number[], npcs: readonly number[]): void {
    copyInto(this.players, players);
    copyInto(this.balls, balls);
    copyInto(this.npcs, npcs);
  }

  /** For `FrameGroups.intern`, which owns the lifecycle. */
  reset(key: number, players: readonly number[], balls: readonly number[], npcs: readonly number[]): void {
    this.key = key;
    this.clients = 0;
    this.length = 0;
    this.adopt(players, balls, npcs);
  }
}

function copyInto(dst: number[], src: readonly number[]): void {
  dst.length = src.length;
  for (let i = 0; i < src.length; i++) dst[i] = src[i];
}

/**
 * The frame sets in play this snapshot, and the pool they are drawn from.
 *
 * A hash to a **bucket of groups** rather than to one, because a hash collision
 * between two genuinely different sets must produce two groups rather than one
 * wrong one -- and `FrameGroup.matches` is what turns "probably the same" into
 * "the same". At the sizes this runs at (a few hundred groups) collisions are
 * rare and cost one array comparison.
 */
export class FrameGroups {
  private readonly byKey = new Map<number, FrameGroup[]>();
  /** Every group in use this tick, in the order they were first seen. */
  readonly live: FrameGroup[] = [];
  /** Groups from previous ticks, kept for their buffers. */
  private readonly pool: FrameGroup[] = [];

  begin(): void {
    for (const g of this.live) this.pool.push(g);
    this.live.length = 0;
    this.byKey.clear();
  }

  /**
   * The group for this frame set, creating it if this is the first client with
   * it. The caller encodes into a group whose `length` is still 0.
   */
  intern(players: readonly number[], balls: readonly number[], npcs: readonly number[]): FrameGroup {
    const key = frameKey(players, balls, npcs);
    let bucket = this.byKey.get(key);
    if (bucket === undefined) {
      bucket = [];
      this.byKey.set(key, bucket);
    }
    for (const g of bucket) {
      if (g.matches(players, balls, npcs)) {
        g.clients++;
        return g;
      }
    }
    const group = this.pool.pop() ?? new FrameGroup();
    group.reset(key, players, balls, npcs);
    group.clients = 1;
    bucket.push(group);
    this.live.push(group);
    return group;
  }

  /**
   * Clients served divided by frames encoded, this tick.
   *
   * 1.0 is "AOI gave nothing back" -- every client saw something different --
   * and the room size is the ceiling, reached when everybody sees exactly the
   * same thing. PERFORMANCE.md phase 4 reports both ends of that.
   */
  ratio(): number {
    if (this.live.length === 0) return 1;
    let clients = 0;
    for (const g of this.live) clients += g.clients;
    return clients / this.live.length;
  }
}

// --- The self-check ---------------------------------------------------------

/**
 * The selection rule, against a brute-force scan that states it directly.
 *
 * Every failure in here is silent in this project's sense, and they are silent
 * in three different ways:
 *
 *   - **A set that is missing somebody nearby** is a player who is invisible
 *     while punching you. There is no frame in which that looks like a
 *     networking bug rather than a hit-detection one.
 *   - **A band that is not a band** -- an enter radius at or above the leave
 *     radius, or a `has` test against the wrong set -- is an enter/leave pair
 *     every snapshot for everybody standing at the boundary. The picture is a
 *     remote actor being built and disposed twenty times a second, which reads
 *     as a rendering stutter on other people's screens and costs the *server*
 *     the bandwidth AOI was supposed to save.
 *   - **A cap that keeps the wrong forty** is the failure argued out in the
 *     header: the nearest player in the game invisible because forty distant
 *     ones got there first.
 *
 * Run standalone:
 *
 *     bun -e "import {verifyAoi} from './server/aoi.ts'; console.log(verifyAoi())"
 */
export function verifyAoi(): string[] {
  const failures: string[] = [];

  let seed = 20260805;
  const rand = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return ((seed >>> 8) & 0xffffff) / 0x1000000;
  };

  const player = (id: number, x: number, z: number): SnapshotPlayer => ({
    id, x, y: 1.7, z, yaw: 0, pitch: 0, anim: 0, health: 3, stamina: 4, phase: 0, flags: 0, ballCharges: 3,
  });

  /** The rule, written out as a scan. This is what the grid has to agree with. */
  const brute = (players: readonly SnapshotPlayer[], x: number, z: number, held: Set<number>): number[] => {
    const eligible: Array<{ id: number; d2: number }> = [];
    for (const p of players) {
      const dx = p.x - x;
      const dz = p.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= ENTER2 || (d2 <= LEAVE2 && held.has(p.id))) eligible.push({ id: p.id, d2 });
    }
    eligible.sort((a, b) => a.d2 - b.d2 || a.id - b.id);
    return eligible.slice(0, AOI_MAX_PLAYERS).map((e) => e.id).sort((a, b) => a - b);
  };

  // --- 1. The grid agrees with the scan, over randomised crowds, at every
  // density from "a paddock" to "a pileup", and across the origin so a cell
  // index that truncated instead of flooring is caught.
  {
    const index = new InterestIndex();
    const out: number[] = [];
    let trials = 0;
    let disagreements = 0;
    let cappedTrials = 0;
    for (let trial = 0; trial < 120; trial++) {
      const n = 2 + Math.floor(rand() * 140);
      // Half scattered over a kilometre, half packed into forty metres --
      // which is what makes the cap actually bind in some of the trials.
      const spread = rand() < 0.5 ? 1000 : 40;
      const ox = (rand() - 0.5) * 6000;
      const oz = (rand() - 0.5) * 6000;
      const players: SnapshotPlayer[] = [];
      for (let i = 0; i < n; i++) {
        players.push(player(i + 1, ox + (rand() - 0.5) * spread, oz + (rand() - 0.5) * spread));
      }
      index.begin(players, [], []);

      for (let q = 0; q < 6; q++) {
        const from = players[Math.floor(rand() * players.length)];
        // Some queries from a body, some from an arbitrary point, so the
        // "always contains yourself" property is exercised and so is the
        // general case.
        const qx = rand() < 0.7 ? from.x : ox + (rand() - 0.5) * spread * 1.4;
        const qz = rand() < 0.7 ? from.z : oz + (rand() - 0.5) * spread * 1.4;
        // A randomly-populated held set, so the band is genuinely in play
        // rather than always empty.
        const held = new InterestSet();
        const seeded: number[] = [];
        for (const p of players) if (rand() < 0.3) seeded.push(p.id);
        held.update(seeded);
        const heldIds = new Set(seeded);

        index.select(qx, qz, CITY_SPACE, held, out);
        const want = brute(players, qx, qz, heldIds);
        trials++;
        if (want.length === AOI_MAX_PLAYERS) cappedTrials++;
        if (out.length !== want.length || out.some((id, i) => id !== want[i])) {
          disagreements++;
          if (disagreements === 1) {
            failures.push(
              `The grid's working set disagreed with the brute-force rule: got [${out.slice(0, 8).join(',')}...] ` +
                `(${out.length}), want [${want.slice(0, 8).join(',')}...] (${want.length}).`,
            );
          }
        }
      }
    }
    if (trials < 500) failures.push(`Only ${trials} selection trials ran; the check is not exercising anything.`);
    if (cappedTrials < 20) {
      failures.push(
        `Only ${cappedTrials} of ${trials} trials hit the ${AOI_MAX_PLAYERS} cap. A check where the cap ` +
          `never binds does not test the cap.`,
      );
    }
    if (disagreements > 0) {
      failures.push(`${disagreements} of ${trials} selections disagreed with the brute-force rule.`);
    }
  }

  // --- 2. Ascending order, and yourself always in it.
  {
    const index = new InterestIndex();
    const players: SnapshotPlayer[] = [];
    for (let i = 0; i < 60; i++) players.push(player(100 - i, (rand() - 0.5) * 300, (rand() - 0.5) * 300));
    index.begin(players, [], []);
    const held = new InterestSet();
    const out: number[] = [];
    index.select(players[0].x, players[0].z, CITY_SPACE, held, out);
    for (let i = 1; i < out.length; i++) {
      if (out[i - 1] >= out[i]) {
        failures.push(`The working set came back as ${out.join(',')}; it must ascend, or the dedup key is unstable.`);
        break;
      }
    }
    if (!out.includes(players[0].id)) {
      failures.push('A client selecting from its own position was not in its own working set; prediction has nothing to reconcile against.');
    }
  }

  // --- 3. The hysteresis, at the boundary it exists for.
  //
  // One player walks from 100 m out to 300 m and back. Under a single radius
  // this produces a transition every time they cross 180; under the band it is
  // one enter on the way in and one leave on the way out, and the leave happens
  // at 220 rather than at 180.
  {
    const index = new InterestIndex();
    const held = new InterestSet();
    const out: number[] = [];
    let enters = 0;
    let leaves = 0;
    let insideAt200Out = false;
    const me = player(1, 0, 0);
    const them = player(2, 0, 0);
    const walk = (d: number): void => {
      them.z = d;
      index.begin([me, them], [], []);
      index.select(0, 0, CITY_SPACE, held, out);
      held.update(out);
      enters += held.entered.length;
      leaves += held.left.length;
    };
    // In from 300 m: nothing until 180.
    for (let d = 300; d >= 100; d -= 1) walk(d);
    if (!held.has(2)) failures.push('A player 100 m away was not in the working set at all.');
    // Out again. At 200 m they must still be held -- that is the band.
    for (let d = 100; d <= 200; d += 1) walk(d);
    insideAt200Out = held.has(2);
    for (let d = 200; d <= 300; d += 1) walk(d);
    if (!insideAt200Out) {
      failures.push(
        `A member at 200 m was dropped on the way out. The band is ${AOI_ENTER_RADIUS}/${AOI_LEAVE_RADIUS}; ` +
          `leaving at the enter radius is what makes a boundary flap.`,
      );
    }
    if (held.has(2)) failures.push('A player 300 m away was still in the working set; the leave radius does nothing.');
    // Two of each: one for me (who never leaves) is impossible, so this is
    // exactly one enter and one leave for the walker.
    if (enters !== 2 || leaves !== 1) {
      failures.push(
        `A single there-and-back walk produced ${enters} enters and ${leaves} leaves; it must be ` +
          `2 (me at t=0, them at 180 m) and 1 (them at 220 m). Anything more is the band flapping.`,
      );
    }
  }

  // --- 4. The cap keeps the *nearest*, not the *earliest*.
  //
  // The case argued out in the header: a full set of distant retainees, and
  // somebody walks up and punches you. If the newcomer cannot get in, the
  // nearest player in the game is invisible.
  {
    const index = new InterestIndex();
    const players: SnapshotPlayer[] = [player(1, 0, 0)];
    // Forty-one people in a ring at 200 m, which is inside the band and outside
    // the enter radius, so they only qualify because they are held.
    for (let i = 0; i < 41; i++) {
      const a = (i / 41) * Math.PI * 2;
      players.push(player(10 + i, Math.cos(a) * 200, Math.sin(a) * 200));
    }
    const held = new InterestSet();
    const out: number[] = [];
    // Seed the set with all of them by placing them inside 180 for one tick.
    for (const p of players) if (p.id !== 1) { p.x *= 0.8; p.z *= 0.8; }
    index.begin(players, [], []);
    index.select(0, 0, CITY_SPACE, held, out);
    held.update(out);
    for (const p of players) if (p.id !== 1) { p.x /= 0.8; p.z /= 0.8; }
    // Now a newcomer, at arm's length.
    players.push(player(999, 1, 0));
    index.begin(players, [], []);
    index.select(0, 0, CITY_SPACE, held, out);
    if (out.length !== AOI_MAX_PLAYERS) {
      failures.push(`A crowded selection returned ${out.length} members, not the ${AOI_MAX_PLAYERS} cap.`);
    }
    if (!out.includes(999)) {
      failures.push(
        'A player 1 m away was excluded from a full working set by retainees 200 m away. The cap must ' +
          'keep the nearest eligible, not the earliest -- that is a player invisible while punching you.',
      );
    }
    if (!out.includes(1)) failures.push('A client fell out of its own full working set.');
  }

  // --- 5. The delta merge, which is what the wire carries.
  {
    const set = new InterestSet();
    set.update([1, 4, 9]);
    if (set.entered.join(',') !== '1,4,9' || set.left.length !== 0) {
      failures.push(`The first update reported ${set.entered.join(',')} in and ${set.left.join(',')} out; it must be all three in.`);
    }
    set.update([1, 4, 9]);
    if (set.entered.length !== 0 || set.left.length !== 0) {
      failures.push('An unchanged working set reported a delta; that is a message sent every snapshot for nothing.');
    }
    set.update([1, 5, 9, 12]);
    if (set.entered.join(',') !== '5,12' || set.left.join(',') !== '4') {
      failures.push(`A mixed update reported ${set.entered.join(',')} in / ${set.left.join(',')} out; want 5,12 in and 4 out.`);
    }
    if (set.members.join(',') !== '1,5,9,12') failures.push(`The members are ${set.members.join(',')} after a mixed update.`);
    if (!set.has(12) || set.has(4)) failures.push('The membership set and the member list disagree after an update.');
    set.update([]);
    if (set.left.join(',') !== '1,5,9,12' || set.members.length !== 0) {
      failures.push('Emptying a working set did not report everybody leaving.');
    }
  }

  // --- 6. The dedup: identical sets share a group, different ones do not, and a
  // hash collision cannot merge two genuinely different frames.
  {
    const groups = new FrameGroups();
    groups.begin();
    const a = groups.intern([1, 2, 3], [7], []);
    const b = groups.intern([1, 2, 3], [7], []);
    const c = groups.intern([1, 2, 4], [7], []);
    const d = groups.intern([1, 2, 3], [], [7]);
    if (a !== b) failures.push('Two clients with the same frame set were given different groups; the dedup does nothing.');
    if (a === c) failures.push('Two clients with different players shared a group; they would be sent each other\'s bytes.');
    if (a === d) {
      failures.push(
        'A frame with a ball 7 and one with an actor 7 shared a group. The key needs section separators.',
      );
    }
    if (a.clients !== 2) failures.push(`A group serving two clients counted ${a.clients}.`);
    if (groups.live.length !== 3) failures.push(`Three distinct frame sets produced ${groups.live.length} groups.`);
    if (Math.abs(groups.ratio() - 4 / 3) > 1e-9) failures.push(`The dedup ratio came out at ${groups.ratio()}, not 4/3.`);
    // And the pool is reused rather than regrown. The pool is a stack and does
    // not promise which group comes back -- a buffer is a buffer -- so what is
    // asserted is that a second tick's groups come out of it already carrying
    // one, which is what makes the encode below allocation-free after warm-up.
    for (const g of groups.live) g.reserve(512);
    groups.begin();
    const again = groups.intern([1, 2, 3], [7], []);
    const alsoAgain = groups.intern([9], [], []);
    if (again.buffer.byteLength < 512 || alsoAgain.buffer.byteLength < 512) {
      failures.push('A recycled frame group lost its buffer; the encode would reallocate every tick.');
    }
    if (again.length !== 0 || again.clients !== 1) {
      failures.push('A recycled frame group came back with the last tick\'s length or client count on it.');
    }
  }

  // --- 7. Balls and actors are filtered by their own position.
  {
    const index = new InterestIndex();
    const balls: SnapshotBall[] = [
      { id: 1, thrower: 5, x: 10, z: 0, y: 2, vx: 0, vy: 0, vz: 0, bounces: 0 },
      { id: 2, thrower: 5, x: 400, z: 0, y: 2, vx: 0, vy: 0, vz: 0, bounces: 0 },
    ];
    const npcs: SnapshotNpc[] = [
      { id: 1, kind: 1, x: 0, y: 0, z: 50, yaw: 0, state: 0 },
      { id: 2, kind: 1, x: 0, y: 0, z: 900, yaw: 0, state: 0 },
    ];
    index.begin([player(1, 0, 0)], balls, npcs);
    const out: number[] = [];
    index.selectBalls(0, 0, 1, CITY_SPACE, out);
    if (out.length !== 1 || out[0] !== 0) {
      failures.push(`A ball 400 m away was carried (got ${out.length} of 2). Interest is by the ball's own position.`);
    }
    index.selectNpcs(0, 0, CITY_SPACE, out);
    if (out.length !== 1 || out[0] !== 0) {
      failures.push(`An officer 900 m away was carried (got ${out.length} of 2).`);
    }
    // And a ball flying toward somebody enters their stream while it is still
    // 100 m off, which is the property the "no hysteresis" note rests on: at a
    // 28 m/s launch that is three and a half seconds of warning.
    balls[1].x = 100;
    index.begin([player(1, 0, 0)], balls, npcs);
    index.selectBalls(0, 0, 1, CITY_SPACE, out);
    if (out.length !== 2) failures.push('A ball 100 m away was not carried; it arrives before it can be reacted to.');
  }

  // --- 8. WORKSTREAM AD: the ball cap, the ball radius and the own-ball rule.
  //
  // Every failure in here is a *bandwidth* failure rather than a visible one,
  // which is why they need a check at all -- nothing on a screen goes wrong
  // when this section quietly stops being bounded, and PERFORMANCE.md phase 4
  // is the record of what that cost: 60% of a pileup's stream, discovered by a
  // load run rather than by anybody playing.
  {
    const index = new InterestIndex();
    const out: number[] = [];
    const ball = (id: number, thrower: number, x: number, z: number): SnapshotBall =>
      ({ id, thrower, x, y: 2, z, vx: 0, vy: 0, vz: 0, bounces: 0 });

    // A pileup: a hundred balls inside forty metres, which is the shape phase 4
    // measured and the one every radius in this file contains whole.
    {
      const balls: SnapshotBall[] = [];
      for (let i = 0; i < 100; i++) {
        const a = (i / 100) * Math.PI * 2;
        balls.push(ball(i + 1, 500 + i, Math.cos(a) * (5 + (i % 20)), Math.sin(a) * (5 + (i % 20))));
      }
      index.begin([player(1, 0, 0)], balls, []);
      index.selectBalls(0, 0, 1, CITY_SPACE, out);
      if (out.length !== AOI_MAX_BALLS) {
        failures.push(
          `A hundred balls inside forty metres put ${out.length} on the wire, not the ${AOI_MAX_BALLS} ` +
            `cap. The radius does not bound a pileup -- all of the balls are where all of the people ` +
            `are -- so the cap is the only thing that does.`,
        );
      }
      // Ascending indices, or two clients standing together stop sharing a
      // frame and the dedup halves.
      for (let i = 1; i < out.length; i++) {
        if (out[i - 1] >= out[i]) {
          failures.push(`The ball selection came back as ${out.join(',')}; it must ascend, or the dedup key is unstable.`);
          break;
        }
      }
      // And it keeps the *nearest* forty. The nearest ball in the room being
      // missing is the only version of this that a player could see.
      const nearest = balls
        .map((b, i) => ({ i, d2: b.x * b.x + b.z * b.z }))
        .sort((a, b) => a.d2 - b.d2 || a.i - b.i)
        .slice(0, AOI_MAX_BALLS)
        .map((e) => e.i)
        .sort((a, b) => a - b);
      if (out.join(',') !== nearest.join(',')) {
        failures.push('The ball cap kept a different forty from the nearest forty.');
      }
    }

    // The radius, at both sides of it.
    {
      const balls = [
        ball(1, 500, AOI_BALL_RADIUS - 1, 0),
        ball(2, 500, AOI_BALL_RADIUS + 1, 0),
      ];
      index.begin([player(1, 0, 0)], balls, []);
      index.selectBalls(0, 0, 1, CITY_SPACE, out);
      if (out.length !== 1 || out[0] !== 0) {
        failures.push(
          `The ball radius is ${AOI_BALL_RADIUS} m and a ball at ${AOI_BALL_RADIUS + 1} m ` +
            `${out.length === 2 ? 'was still carried' : 'took the near one with it'}.`,
        );
      }
    }

    // The own-ball rule, and the orphan that must not be caught by it.
    {
      const balls = [
        ball(1, 7, 5, 0),      // mine
        ball(2, 9, 6, 0),      // somebody else's
        ball(3, 0, 7, 0),      // thrown by somebody who has since left
      ];
      index.begin([player(7, 0, 0)], balls, []);
      index.selectBalls(0, 0, 7, CITY_SPACE, out);
      if (out.includes(0)) {
        failures.push(
          'A client was sent a ball it threw itself. `net/client.interpolateBalls` discards those on ' +
            'its first line, so they are pure wire cost -- see `selectBalls`.',
        );
      }
      if (!out.includes(1) || !out.includes(2)) {
        failures.push(
          `A client was sent ${out.length} of the 2 balls it did not throw. The orphan (thrower 0, ` +
            `whoever threw it has left) is the one the own-ball test must not swallow -- 0 is nobody, ` +
            `and hiding it would hide every abandoned ball in the room from everybody.`,
        );
      }
      // And a viewer with no id of its own still sees all three.
      index.selectBalls(0, 0, 0, CITY_SPACE, out);
      if (out.length !== 3) failures.push(`A client with no id was sent ${out.length} of 3 balls.`);
    }
  }

  // --- Interiors: the space, asked before the distance. Protocol v23.
  //
  // The case that makes this necessary rather than tidy: an interior sits at
  // its building's own coordinates, so a body inside a terrace and a body on
  // the pavement outside it are **a metre and a half apart** in two different
  // worlds. Every radius in this file contains that. Four assertions, and each
  // of them is a different way for the feature to be broken --
  //
  //   - two people in one pub see each other (an interior that is not shared is
  //     not what was asked for),
  //   - somebody indoors and somebody outdoors do not, at any distance,
  //   - two people in *different* buildings do not, however close their
  //     coordinates,
  //   - and everybody still sees themselves, which prediction depends on:
  //     `net/client.reconcile` reconciles against its own record in every
  //     snapshot, and a set that could omit you is a client that stops being
  //     able to reconcile the moment it walks through a door.
  {
    const PUB = 4242;
    const SHOP = 99;
    const index = new InterestIndex();
    const held = new InterestSet();
    const out: number[] = [];
    // Four bodies within two metres of each other, which is what a terrace row
    // with two people inside it actually looks like.
    const bodies = [player(1, 0, 0), player(2, 1, 0), player(3, 2, 0), player(4, 0, 1)];
    const spaceOf = (id: number): number =>
      id === 1 || id === 2 ? PUB : id === 3 ? SHOP : CITY_SPACE;
    index.begin(bodies, [], [], spaceOf);

    index.select(0, 0, PUB, held, out);
    if (!out.includes(1)) failures.push('a player indoors could not see themselves; prediction would stop reconciling.');
    if (!out.includes(2)) failures.push('two players in one pub could not see each other; the interior is not shared.');
    if (out.includes(3)) failures.push('somebody in a shop was drawn into a pub two metres away.');
    if (out.includes(4)) failures.push('somebody on the pavement was drawn inside the pub they were leaning on.');

    index.select(0, 1, CITY_SPACE, held, out);
    if (!out.includes(4)) failures.push('a player in the street could not see themselves.');
    if (out.includes(1) || out.includes(2) || out.includes(3)) {
      failures.push('somebody in the street was sent the people inside the building beside them.');
    }

    // And the two sections that are city-only by construction, because nothing
    // puts a ball or an officer in a building. See `selectBalls`.
    const balls = [{ id: 1, thrower: 9, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, bounces: 0 }];
    const npcs = [{ id: 1, kind: 0, x: 0, y: 0, z: 0, yaw: 0, state: 0 }];
    index.begin(bodies, balls, npcs, spaceOf);
    index.selectBalls(0, 0, 1, PUB, out);
    if (out.length !== 0) failures.push(`a player indoors was sent ${out.length} footballs from the street.`);
    index.selectNpcs(0, 0, PUB, out);
    if (out.length !== 0) failures.push(`a player indoors was sent ${out.length} police officers from the street.`);
    // Own id 4 -- the one body in the street -- and the ball was thrown by 9,
    // who is nobody here: `selectBalls` drops your own throws, so asking as the
    // thrower would have measured that rule instead of this one.
    index.selectBalls(0, 0, 4, CITY_SPACE, out);
    if (out.length !== 1) failures.push('the city stopped getting its own footballs.');
    index.selectNpcs(0, 0, CITY_SPACE, out);
    if (out.length !== 1) failures.push('the city stopped getting its own officers.');

    // A world with no interiors in it is the one every check above this line
    // runs in, and it has to keep behaving exactly as it did: `begin` with no
    // space function means everybody is outdoors.
    index.begin(bodies, [], []);
    index.select(0, 0, CITY_SPACE, held, out);
    if (out.length !== 4) failures.push(`with no interiors anywhere, a client saw ${out.length} of 4 players.`);
  }

  return failures;
}
