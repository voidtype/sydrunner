/**
 * The railway's walls, on the authority.
 *
 * ---------------------------------------------------------------------------
 * ## The disagreement this closes
 *
 * `STATIONS.md` ends on one rule -- *a boundary may have many renderings and
 * exactly one definition* -- and `world/rail-solids.ts` is that definition for
 * everything the railway stands on the world. Both ends already read it for the
 * question "how high is the railway over this point": the browser through
 * `main.ts`'s composed ground, this process through `groundFor`'s
 * `RailSolidField.roofHeight`. On that question the two ends agree exactly,
 * because they call the same function over the same boxes.
 *
 * They did not agree at all on the other question a body asks. **A trench wall
 * is something you walk into.** So is a viaduct pier, a station wall, a parapet,
 * the flank of a subway shaft head. `world/rail-geo.buildChunk` hands every one
 * of those to the browser's `CollisionWorld` as a prism -- `addPrisms`, 4,522 of
 * them near a player in the CBD -- and it hands them to *nobody else*, because
 * `buildChunk` is a renderer and this process has no renderer. The server's
 * lateral collision was the pipeline's baked prisms and only those: buildings,
 * road decks, landmark podia. The railway was not in it.
 *
 * The result is the shape of bug that produces the worst possible report,
 * because the player is not wrong about anything they can see:
 *
 *   - **The client stops you and the server does not.** You push against the
 *     coping of the Chatswood cutting, your own client holds you, and the
 *     server -- which believes that square metre is open ground -- keeps
 *     accepting your input and correcting you forward. You are held against a
 *     wall you can see, jittering, by two authorities that disagree.
 *   - **The other way costs a shot.** `blocked` is the sight line the police and
 *     every ranged path read. A trench wall between an officer and a player
 *     stopped the *client's* bullet and not the server's, so cover that was
 *     visibly cover was not cover.
 *
 * Neither is a streaming window and neither closes itself in a second. They are
 * permanent, everywhere the railway is, and they are what
 * `client/src/world/collision-window-check.ts` was written to look for and did
 * not find in the schedule.
 *
 * ---------------------------------------------------------------------------
 * ## Why the fix is a *registration* and not a second resolver
 *
 * The obvious shape is a `MoveResolver` that asks `RailSolidField` whether a
 * step is blocked, and composes with `CollisionWorld.resolve`. It is the wrong
 * shape. `resolve` is not a predicate -- it is a two-pass push-out along wall
 * normals with a refusal guard on the end, and every one of those properties is
 * load-bearing (see `player/collision.ts`). A second implementation of it over a
 * second prism set would be a second description of how a body slides along a
 * facade, which is precisely the duplication `STATIONS.md` forbids and precisely
 * the kind that goes subtly out of step.
 *
 * So the rail solids are **put into the `CollisionWorld` the server already
 * has**, through `addPrisms` -- the same method, under keys of the same
 * discipline, carrying the same `structural: true` -- which is *exactly* what
 * `rail-geo.buildChunk` does in the browser. One resolver, one set, two
 * processes. A deck's soffit is walked under on both ends because it is the same
 * `[base, top)` band tested by the same code, not because two functions were
 * written to match.
 *
 * ---------------------------------------------------------------------------
 * ## Residency: by entity, not by chunk, and not by hexagon
 *
 * The prisms cannot all be resident. There are 22,390 segments and 361 stations
 * in the extent at up to ten and ninety-six solids each; `rail-solids.ts`'s own
 * header measures a whole-city sweep at 95,537 records, which is six figures of
 * `Float32Array` on a box whose `MemoryHigh` is 587 MB. So this holds what is
 * near somebody, on the pattern the three hex layers in `world.ts` already
 * follow, with one difference in the key.
 *
 * **The unit is the entity -- one station, one segment -- rather than a chunk of
 * ground.** `rail-geo` files its prisms by 512 m chunk because it is drawing and
 * a draw call is a chunk; that forces it to decide which chunk a segment that
 * crosses three of them belongs to. Here there is nothing to draw and the
 * indices are already stable and already indexed by two grids, so a segment is
 * its own key and the question "is this registered" has one answer instead of
 * three. `CollisionWorld.addPrisms` is a no-op on a key already resident and
 * `removeTile` takes exactly that key back, so the whole residency is two set
 * differences a second.
 *
 * ---------------------------------------------------------------------------
 * ## The radius, and why it is not the browser's
 *
 * The first version of this file held `rail-solids.KEEP_RADIUS` -- 1,500 m, the
 * radius the browser keeps its own rail chunks to -- on the argument that the
 * authority's set must be a *superset* of every client's. That argument is
 * wrong, and `server/rail-lateral-check.ts` cost it at **1.6 ms of every tick**,
 * which is eighty times `tick-profile.AMBIENT_BUDGET_MS` for a layer nobody
 * asked a question of.
 *
 * It is wrong because a superset of the client's *residency* is not what parity
 * needs. What has to agree is the **answer to a query**, and there are exactly
 * two queries this layer feeds:
 *
 *   - `CollisionWorld.resolve`, which reaches `PLAYER_RADIUS` from a body. A
 *     player fourteen hundred metres from a trench wall is not being stopped by
 *     it on either end, so holding it changes no answer anywhere.
 *   - `CollisionWorld.blocked`, the sight line the police and every ranged path
 *     read. That is a segment between two combatants, and the far end of it is
 *     an officer inside `factions.PROMOTE_RADIUS` -- 120 m -- of the player they
 *     are shooting at.
 *
 * `RAIL_LATERAL_RADIUS_M` is 300 m, which covers the longer of the two twice
 * over and covers a body's travel between sweeps twenty times over. Inside it
 * this process holds every rail solid the browser does; outside it neither end
 * can be asked a question whose answer differs. The height query is unaffected
 * either way -- `groundFor` calls `RailSolidField.roofHeight` directly and it
 * answers anywhere, at any distance, with no residency at all.
 *
 * `verifyRailLateral` asserts the radius against `PROMOTE_RADIUS` and against
 * the sweep interval below, which are the two things that could move under it.
 *
 * ---------------------------------------------------------------------------
 * ## What it costs
 *
 * A player standing in the North Shore cutting holds a few dozen entities and a
 * few hundred prisms, and the *build* of them is work `RailSolidField` caches
 * and shares with `roofHeight` -- so somebody who has walked that ground has
 * already paid most of it for the ground query. The measured figures are in
 * `server/rail-lateral-check.ts`, which is a gate and not a note.
 *
 * Two things keep the per-tick number down and both were put in after the
 * measurement, not before it:
 *
 *   - **The decision is throttled to `SWEEP_INTERVAL_TICKS`**, on
 *     `HexResidency`'s own argument in the same words: noticing late is free
 *     when the margin is large, and at 4 Hz the worst-case delay is 250 ms,
 *     which is ten metres of travel against three hundred of lead.
 *   - **The residency is keyed by integer, not by string.** The entity indices
 *     are what the grids hand out and what the set difference runs over; the
 *     `rail:` key is built only when a registration actually changes, which on a
 *     standing player is never. The first version built two strings per entity
 *     per tick, which on its own was most of the 1.6 ms.
 *
 * ---------------------------------------------------------------------------
 * ## Trains are not in this, and that is a decision rather than an omission
 *
 * `world/trains.ts` puts a prism round every carriage body in the city and hands
 * them to the browser's `CollisionWorld` under one key it takes back and refills
 * every frame. Those are client-only for the same reason the trench walls were,
 * and the obvious next step is to do to them what this file does to the
 * railway's fixed solids. It should not be done, for four reasons that are all
 * about the *moving* part:
 *
 *   1. **`resolve` has no idea a wall can move.** It pushes a body out along a
 *      wall normal and, when it cannot find a free spot, refuses the move and
 *      returns the body to where it started -- which for a body a train has just
 *      driven over is *inside the train*, every tick, for as long as the
 *      carriage covers it. The guard that makes `resolve` safe against static
 *      geometry is what makes it a trap against geometry that arrives.
 *   2. **The two ends could not agree to the metre.** `poseTrain` is closed form
 *      over the timetable, so both ends can compute the same carriage -- but the
 *      browser computes it on a render frame and this process on a fixed tick,
 *      and at line speed one frame is half a metre of prism. A permanent
 *      half-metre disagreement about a solid, beside every railway in the city,
 *      is a low-grade rubber-band that would never be traced back to here.
 *   3. **It is the wrong mechanic.** What should happen when a player walks into
 *      a moving train is that they are *hit* -- `Simulation` already has the
 *      shape of that in the car path -- and not that they are quietly stopped.
 *      A wall that runs you down is a hazard, and a hazard belongs on the damage
 *      path. DESIGN.md's ledger is unambiguous about which of the two a melee
 *      game wants.
 *   4. **The cost is the one shape this grid is bad at.** Ninety trains of eight
 *      cars re-indexed at 60 Hz is a `removeTile` and an `addPrisms` over seven
 *      hundred records into a 32 m cell map every tick, which is precisely the
 *      churn `world.ts` measured at 21.6 ms for one hexagon's release.
 *
 * The browser keeps its carriage prisms, because there they are doing a
 * different job at a different scale: stopping the local prediction and the
 * camera from passing through a carriage the player is looking at. A player who
 * briefly clips a passing train on this process's reckoning has reached nowhere
 * they could not already walk -- the trackbed is open ground -- so there is
 * nothing to cheat with and nothing to enforce.
 *
 * ---------------------------------------------------------------------------
 *
 * An entity whose solids came back **unsettled** is registered and then
 * deliberately forgotten again on the next sweep. `StationPlan.measured` and
 * `TrenchProfile.complete` are false when the terrain under the geometry had not
 * arrived, and `RailSolidField` refuses to cache those answers for exactly that
 * reason -- the answer will change. A prism set registered from a guess and
 * never revisited is a wall in the wrong place that outlives the guess, which is
 * a permanent invisible wall introduced by the fix for permanent invisible
 * walls. So `settled === false` means "hold it this sweep, ask again next
 * sweep", which converges the moment the hexagon's terrain lands.
 */
import type { CollisionWorld } from '../client/src/player/collision.ts';
import { PROMOTE_RADIUS } from '../client/src/game/factions.ts';
import { RAIL_BUILD_BUDGET_MS, type RailSolidField } from '../client/src/world/rail-solids.ts';

/**
 * How far from a participant the railway's walls are held, metres.
 *
 * Three hundred. See the header for the derivation and for the 1,500 m this
 * replaced: the two queries this layer feeds reach `PLAYER_RADIUS` and
 * `PROMOTE_RADIUS`, and 300 m covers the longer of them twice over.
 */
export const RAIL_LATERAL_RADIUS_M = 300;

/**
 * How often the resident set is recomputed, in ticks.
 *
 * Every fifteenth, which is 4 Hz, and it is `world.HexResidency`'s
 * `NEED_INTERVAL_TICKS` copied together with its argument: noticing late is free
 * when the margin is large. The worst-case delay is 250 ms, which on the fastest
 * body in the game is ten metres against three hundred of lead. Recomputing
 * every tick is what the first version did and it cost 1.6 ms of every one.
 */
export const SWEEP_INTERVAL_TICKS = 15;

/**
 * How long one sweep may spend **building** entities it has not seen before,
 * milliseconds.
 *
 * The steady-state sweep is a set difference and costs microseconds. The first
 * sweep at a place is not: every trench profile inside the radius is measured
 * against the DEM for the first time, and at Central -- the largest station kit
 * in the build -- that was **45.8 ms in one tick**, which is three frames of
 * hitch for everybody on the host. `server/rail-lateral-check.ts` caught it and
 * its own header named the fix, which is this rather than a bigger budget.
 *
 * It is `rail-solids.RAIL_BUILD_BUDGET_MS`, imported rather than chosen, and the
 * symmetry is the argument. That constant is what `world/rail-geo.buildChunk`
 * spends a frame spreading a rail chunk over in the browser, so a client walking
 * into Central gets its walls over the same ramp this process gets them over. A
 * server that registered everything at once would be *ahead* of the client for a
 * second -- which is the disagreement this whole file exists to remove, pointed
 * the other way.
 *
 * An unfinished sweep asks for the **next tick** rather than the next interval
 * (see `update`), so the ramp is measured in ticks and not in quarter-seconds:
 * Central's whole kit lands in about forty of them, two thirds of a second.
 *
 * A check between entities and not a pre-emption, exactly as
 * `streamer.BUILD_BUDGET_MS` is, so the real bound on one sweep is this plus the
 * worst single entity -- which `server/rail-lateral-check.ts` gates separately.
 */
const ADOPT_BUDGET_MS = RAIL_BUILD_BUDGET_MS;

/**
 * The key prefix, and why it is a prefix rather than a namespace.
 *
 * `CollisionWorld` files everything under one `Map<string, Prism[]>` -- the
 * pipeline's tiles under their tile keys, and now these. A tile key is
 * `<x>_<z>`, so nothing the pipeline writes can begin with a colon and no
 * collision is possible. It also means `residentTiles()` and the `/stats`
 * readout show the railway's registrations by name, which is what anybody
 * debugging a wall wants to see.
 */
const RAIL_KEY = 'rail:';

/** One sweep's answer. Diagnostics, and the check reads it. */
export interface RailLateralStats {
  /** Entities registered right now. */
  resident: number;
  /** Prisms those entities put in the collision world. */
  prisms: number;
  /** Of the resident set, how many were built from terrain that had not landed. */
  provisional: number;
  /** Registrations made since boot, which counts the re-registrations too. */
  adopted: number;
  /** Registrations taken back since boot. */
  dropped: number;
  /** Did the last sweep run out of `ADOPT_BUDGET_MS` with entities still to build? */
  unfinished: boolean;
}

/**
 * The railway's walls, held near whoever is standing near them.
 *
 * Driven from `Rooms.step` on the same list of occupants the hex residency gets
 * and for the same reason it is host-wide: the rooms share one `CollisionWorld`
 * by reference, so what has to be resident is the union of what everybody on
 * this host needs.
 */
export class RailLateralField {
  /**
   * What is registered, by entity index, and whether the set behind each one was
   * a guess.
   *
   * Two integer-keyed maps rather than one string-keyed one, which is the whole
   * of the per-tick cost. See the header: the sweep runs a set difference over
   * these every quarter second and never touches a string unless a registration
   * actually changes.
   */
  private readonly heldStations = new Map<number, boolean>();
  private readonly heldSegments = new Map<number, boolean>();
  /** Scratch for one sweep. Reused; grows to its high-water mark and stays. */
  private readonly stations = new Set<number>();
  private readonly segments = new Set<number>();
  private readonly stale: number[] = [];
  private prismCount = 0;
  private adopted = 0;
  private dropped = 0;
  private ticks = 0;
  /** Did the last sweep run out of `ADOPT_BUDGET_MS`? See `update`. */
  private unfinished = false;

  constructor(
    private readonly solids: RailSolidField,
    private readonly collision: CollisionWorld,
  ) {}

  /**
   * Bring the resident set in line with where everybody is.
   *
   * `points` is `Rooms.occupants`' flat `x, z` pairs -- the same array the hex
   * residency is handed, reused rather than copied, which is why nothing here
   * keeps a reference to it.
   *
   * Runs every tick it is called and does no clock of its own. It can afford to:
   * the broad phase is two grid sweeps per participant over integer keys, the
   * set difference is over a few hundred entries, and the only expensive branch
   * -- building an entity's solids -- happens once per entity per session and is
   * shared with `roofHeight`. The one thing that repeats is a *provisional*
   * entity, and that is the point of it.
   */
  update(points: readonly number[]): void {
    if (this.ticks++ % SWEEP_INTERVAL_TICKS !== 0) return;
    // A sweep that ran out of `ADOPT_BUDGET_MS` last time has entities still to
    // build, and waiting the full interval for them would make arriving
    // somewhere new take four seconds instead of one. So an unfinished sweep
    // asks for the next tick rather than the next interval; a finished one falls
    // back to 4 Hz. `ticks` is set rather than reset so the phase does not
    // depend on how many partial sweeps there were.
    if (this.unfinished) this.ticks = 0;

    this.stations.clear();
    this.segments.clear();
    for (let i = 0; i + 1 < points.length; i += 2) {
      this.solids.entitiesIn(
        points[i] - RAIL_LATERAL_RADIUS_M,
        points[i + 1] - RAIL_LATERAL_RADIUS_M,
        points[i] + RAIL_LATERAL_RADIUS_M,
        points[i + 1] + RAIL_LATERAL_RADIUS_M,
        this.stations,
        this.segments,
      );
    }

    // Drop first, so a sweep that wants nothing releases the memory before a
    // sweep that wants a lot asks for it -- the same ordering `HexLayer.trim`
    // takes and for the same reason on a 1 GB box. A provisional entity is
    // dropped even when it is still wanted, so the loop below rebuilds it
    // against whatever terrain has landed since. See the header.
    this.release('station', this.heldStations, this.stations);
    this.release('segment', this.heldSegments, this.segments);

    // Budgeted, and the stations first: a station's kit is what a player walks
    // *into* -- a platform edge, a stair, a building wall -- where a segment's
    // is mostly a trench they are beside. If one sweep can only do half, the
    // half that stops somebody is the half to do.
    const deadline = performance.now() + ADOPT_BUDGET_MS;
    this.unfinished =
      !this.adoptAll('station', this.heldStations, this.stations, deadline) ||
      !this.adoptAll('segment', this.heldSegments, this.segments, deadline);
  }

  /**
   * Adopt everything in `wanted` that is not held yet, inside the budget.
   * Returns whether it got to the end.
   *
   * **The residency test comes before the clock, and that is not a micro-
   * optimisation.** `performance.now()` per entity per sweep is 1,700 clock
   * reads at Central in the steady state, where the steady state is supposed to
   * be a set difference and nothing else -- `server/rail-lateral-check.ts`
   * measured that mistake at 0.609 ms a sweep against a 0.3 ms budget, five
   * times what the sweep cost before the budget was added. A `Map.has` is the
   * cheap answer for every entity that is already held, which after the first
   * second is all of them, so the clock is read once per entity that is
   * genuinely built and never otherwise.
   */
  private adoptAll(
    kind: 'station' | 'segment',
    held: Map<number, boolean>,
    wanted: ReadonlySet<number>,
    deadline: number,
  ): boolean {
    for (const i of wanted) {
      if (held.has(i)) continue;
      if (performance.now() >= deadline) return false;
      this.adopt(kind, held, i);
    }
    return true;
  }

  /** Take back everything in `held` that `wanted` does not want, or that guessed. */
  private release(
    kind: 'station' | 'segment',
    held: Map<number, boolean>,
    wanted: ReadonlySet<number>,
  ): void {
    // Collected first and deleted after, because deleting from a `Map` while
    // iterating it is the one thing `Map` does not promise. Into a reused array
    // rather than a spread of the whole map, which is the allocation this loop
    // runs every quarter second for the life of the process.
    this.stale.length = 0;
    for (const [i, settled] of held) if (!settled || !wanted.has(i)) this.stale.push(i);
    for (const i of this.stale) {
      this.prismCount -= this.collision.removeTile(keyOf(kind, i));
      held.delete(i);
      this.dropped++;
    }
  }

  private adopt(kind: 'station' | 'segment', held: Map<number, boolean>, i: number): void {
    if (held.has(i)) return;
    const built = this.solids.solidsOf(kind, i);
    if (built.prisms.length === 0) {
      // A segment with no solids -- plain track on grade, which is most of the
      // network -- is still recorded, so the broad phase does not rebuild it
      // every sweep to be told the same nothing. `addPrisms` of an empty list
      // would file an empty array under the key and `removeTile` would take it
      // back, which is the same bookkeeping with an allocation in it.
      held.set(i, built.settled);
      return;
    }
    this.prismCount += this.collision.addPrisms(keyOf(kind, i), built.prisms);
    held.set(i, built.settled);
    this.adopted++;
  }

  /**
   * Forget everything, because the corridor moved under it.
   *
   * `RailSolidField.invalidateCorridor` empties the segment cache when the road
   * or vessel layer changes what a trench looks like, and a prism registered
   * from the old profile would outlive it inside `CollisionWorld` -- which is a
   * wall standing where the railway no longer is. The stations are dropped too
   * rather than filtered: a full re-adopt is one sweep of work a few times a
   * boot, against a second rule about which half of the set survives.
   */
  invalidate(): void {
    for (const i of this.heldStations.keys()) this.prismCount -= this.collision.removeTile(keyOf('station', i));
    for (const i of this.heldSegments.keys()) this.prismCount -= this.collision.removeTile(keyOf('segment', i));
    this.dropped += this.heldStations.size + this.heldSegments.size;
    this.heldStations.clear();
    this.heldSegments.clear();
    // The next `update` sweeps rather than skipping, whatever the tick count was
    // standing at: an invalidation that landed on tick fourteen would otherwise
    // leave the world with no rail walls in it for a quarter of a second.
    this.ticks = 0;
    this.unfinished = false;
  }

  stats(): RailLateralStats {
    let provisional = 0;
    for (const settled of this.heldStations.values()) if (!settled) provisional++;
    for (const settled of this.heldSegments.values()) if (!settled) provisional++;
    return {
      resident: this.heldStations.size + this.heldSegments.size,
      prisms: this.prismCount,
      provisional,
      adopted: this.adopted,
      dropped: this.dropped,
      unfinished: this.unfinished,
    };
  }
}

/**
 * One entity's registration key.
 *
 * Built only where a registration changes -- see the header on why the sweep
 * itself never touches a string. `s` and `c` for station and corridor, which is
 * the split `RailSolidField` keeps its two grids and its two caches on.
 */
function keyOf(kind: 'station' | 'segment', i: number): string {
  return `${RAIL_KEY}${kind === 'station' ? 's' : 'c'}${i}`;
}

/**
 * The self-check, in the server's boot list.
 *
 * Both failures here are silent. A radius that slipped under the browser's
 * would put the server's set *inside* the client's, which is the gap this file
 * exists to close, reopened -- and it would reopen it only for players near the
 * edge of their own rail keep radius, which is nobody a test walks past. A key
 * prefix that could collide with a tile key would have a hexagon eviction take
 * the railway's prisms with it, or the railway's registration shadow a tile's,
 * and neither would look like anything but an intermittent wall.
 */
export function verifyRailLateral(): string[] {
  const failures: string[] = [];
  const fail = (ok: boolean, msg: string): void => {
    if (!ok) failures.push(msg);
  };

  // The two queries the radius has to cover, asserted against the constants they
  // are derived from rather than against a number written here twice. See the
  // header: this replaced a radius five times larger whose argument was wrong.
  fail(
    RAIL_LATERAL_RADIUS_M >= PROMOTE_RADIUS * 2,
    `The server holds rail solids to ${RAIL_LATERAL_RADIUS_M} m and an officer engages within ` +
      `${PROMOTE_RADIUS} m. A sight line between a player and somebody shooting at them has to be ` +
      `inside this radius end to end or cover the player can see is not cover this process enforces.`,
  );
  // The fastest body in the game is the tuned lime bike at 39.4 m/s and the
  // sweep is at 60 / SWEEP_INTERVAL_TICKS Hz. What it must not do is let
  // somebody arrive at a wall before the sweep that would have registered it.
  fail(
    RAIL_LATERAL_RADIUS_M > (39.4 * SWEEP_INTERVAL_TICKS) / 60 * 4,
    `At ${SWEEP_INTERVAL_TICKS} ticks a sweep, the fastest body travels ` +
      `${((39.4 * SWEEP_INTERVAL_TICKS) / 60).toFixed(1)} m between decisions, against a ` +
      `${RAIL_LATERAL_RADIUS_M} m radius. The margin has to be several times the step or a rider ` +
      `reaches a trench wall this process has not registered yet.`,
  );
  fail(
    RAIL_KEY.includes(':'),
    `The rail registration prefix "${RAIL_KEY}" contains no colon, so it is a string a pipeline tile ` +
      `key could take. A collision either way is a hexagon eviction dropping the railway's walls.`,
  );
  fail(
    /^[a-z]+:$/.test(RAIL_KEY),
    `The rail registration prefix "${RAIL_KEY}" is not of the form "name:", which is what makes it ` +
      `readable in residentTiles() and in /stats.`,
  );

  return failures;
}
