/**
 * Getting unstuck: `/unstuck` in the chat box, and a random road to land on.
 *
 * The instruction was *"make it so i can kill my toon to move me if i am stuck
 * somewhere. just move to a random road within 200m"*. This module is the rule
 * -- where you go and whether you may go there -- and nothing else. The two
 * authorities call it:
 *
 *   - `server/chat.ts` intercepts the command before the line is broadcast and
 *     `server/sim.ts` applies the move, which is what makes it authoritative;
 *   - `client/src/main.ts` runs the identical function offline, where the client
 *     *is* the authority, so `?offline` is a real test of the feature rather
 *     than a demo of one.
 *
 * Three.js-free and `combat`-free on `game/spawn.ts`'s argument, which is the
 * module this one is built on: the server imports it and the server draws
 * nothing. It takes its world as `SpawnWorld` -- the structural interface both
 * ends' `CombatWorld` already satisfies -- and its roads as bare polylines, so
 * neither end has to build anything new to ask it a question.
 *
 * ---------------------------------------------------------------------------
 * ## WHY THIS IS A CHAT COMMAND AND NOT A MESSAGE ID
 *
 * `MSG.CHAT_SAY` already carries arbitrary client-authored text to the server
 * and is already rate-limited, sanitised and attributed there. An unstuck
 * request is *a short string the player types*, which is exactly the payload
 * that channel exists for -- so this feature adds **zero bytes of new wire
 * surface**: no message id to allocate out of `protocol.MSG`'s one shared
 * space, no encoder and decoder to keep in step across two directories, no new
 * frame for `verifyNet` to round-trip, and no version skew between a client
 * built today and a server built last week. A client that has never heard of
 * this feature can still use it by typing the word.
 *
 * The cost of that choice is one rule, and it is enforced in `server/chat.ts`
 * rather than trusted: **a command is never broadcast as chat text.** The
 * interception happens before the fan-out and before the token bucket, so
 * `/unstuck` three times in a row is not eaten by the repeat guard either.
 *
 * ---------------------------------------------------------------------------
 * ## WHY A ROAD, AND WHY THE LANE GRAPH IS THE ANSWER
 *
 * "A random road within 200 m" needs road centrelines, and both ends already
 * hold them: the `.lanes.bin` sidecars decoded by `game/traffic.ts` are the
 * street network, in world metres, with `y` already sitting on the running
 * surface (`LaneRoute`'s own contract). The server adopts every one of them at
 * boot (`server/world.ts`) and the client's streamer adopts the resident ones,
 * so neither end loads a single extra byte for this feature.
 *
 * A `LaneRoute` polyline is a *lane-offset* line rather than the kerb-to-kerb
 * centreline, which is the right answer here twice over: it is inside the
 * carriageway by construction, and its `y` is the surface a car drives on --
 * so a road on the Cahill or the Anzac Bridge puts you on the deck rather than
 * in the water underneath it. That is the whole reason the ground query below
 * asks with the lane's own height rather than with `-Infinity`.
 *
 * ---------------------------------------------------------------------------
 * ## WHAT "VALID" MEANS, and it is `game/spawn.ts`'s answer verbatim
 *
 * A destination that is not checked is a teleport out of one piece of stuck
 * geometry into another, which is worse than not having the command. So every
 * candidate is put through `isSpawnable` -- the same predicate a join uses:
 * finite ground, not inside a collision prism, 1.2 m of clearance on four
 * sides, and not standing in water deeper than the wading floor. Reusing it
 * rather than restating it is the point: a spawn rule that improved would
 * improve this, and a bug found in one is fixed for both.
 *
 * The one thing added on top is `ROAD_SURFACE_TOLERANCE`, which catches a lane
 * point whose ground answer came back from somewhere other than that lane --
 * a tile whose terrain has not arrived offline, or a road over a tunnel.
 *
 * ---------------------------------------------------------------------------
 * ## THIS MODULE NEVER FIRES ON ITS OWN, AND ONE REPORT TURNED ON THAT
 *
 * *"moving anywhere on foot underground tps me to surface"* was filed against
 * this file, on the reading that something here notices a body below the
 * terrain and rescues it. **Nothing here fires unless a player types the
 * command.** The only two callers are `server/chat.ts`, which intercepts the
 * typed line, and `main.ts`'s `unstuckLocally`, which the same typed line
 * reaches offline; there is no tick, no watchdog and no automatic path, and a
 * grep for `unstuckDestination` finds exactly those two.
 *
 * What actually moved the player was the **ground query** -- `main.ts`'s
 * `groundHeightAt` and `server/world.groundFor` -- which asked
 * `PlatformField.heightAt`, then `RailCut.cutAt`, and then fell through to the
 * DEM. Inside a station box the first answers only within a step of a 5.5 m
 * deck and the second declines by design (a bore has no surface expression to
 * carve), so the concourse was answered by the terrain twenty metres overhead
 * and the controller stood the body on it. The fix is a third field,
 * `game/riding.StationBoxField`, consulted between the two.
 *
 * This module still has to be right about the same world, though, and the way
 * it is right is by construction: **every destination is validated through
 * `isSpawnable` against the caller's own `SpawnWorld`**, which is the same
 * ground query. So a body inside a station box is not "below the terrain" to
 * anything here -- it is standing on a floor the world reports -- and the
 * ground fallback rings outward from that floor rather than up to the street.
 * `verifyUnstuck` case 8 asserts exactly that, because it is the property the
 * report would have needed and the one nothing was checking.
 *
 * ---------------------------------------------------------------------------
 * ## NO DEATH IS RECORDED, and that is a deliberate reading of the request
 *
 * The user said "kill my toon". What they *asked for* is in the next clause --
 * "to move me if i am stuck somewhere" -- and a knockout is only the mechanism
 * they reached for because it is the one that already existed. So this credits
 * no KO to anybody and does not increment the player's `downs`: being trapped
 * by a building footprint is a terrain bug, and a leaderboard that counted it
 * would be a leaderboard measuring the world's flaws. `unstuckReply` says so
 * in the reply, because a rule nobody is told about is a rule nobody can rely
 * on -- and because somebody who genuinely wants the death can then ask for it.
 */

import {
  SPAWN_STEP_HEIGHT,
  isSpawnable,
  spawnGround,
  type SpawnWorld,
} from './spawn.ts';

// --- The command surface ---------------------------------------------------

/**
 * What you may type, and every one of them means the same thing.
 *
 * `/unstuck` is the name; `/stuck` is what somebody types when they are
 * describing their problem rather than asking for the fix; `/kill` is the
 * user's own word for it and is the one a player who read the changelog will
 * reach for. Aliases are free -- they are three strings in a comparison -- and
 * the cost of not having them is a player typing the wrong one, being
 * broadcast saying "/kill" to the whole server, and concluding the feature
 * does not exist.
 */
export const UNSTUCK_COMMANDS: readonly string[] = ['/unstuck', '/kill', '/stuck'];

/**
 * Is this line a command rather than something to say?
 *
 * Matched **exactly** after folding case, against text that has already been
 * through `sanitiseChat` (which collapses whitespace and trims). Exact rather
 * than prefixed, so "/kill bazza" is a sentence and reaches the chat log: a
 * player aiming an insult at somebody should not be silently teleported, and a
 * prefix match is how a command surface grows arguments nobody designed.
 */
export function unstuckCommand(text: string): boolean {
  const folded = text.trim().toLowerCase();
  return UNSTUCK_COMMANDS.includes(folded);
}

/**
 * One use per this long, per player.
 *
 * Ten seconds, and the number is chosen against what the command *costs* rather
 * than against how often somebody gets stuck. A call walks up to a few thousand
 * lane samples and runs a couple of hundred collision probes, on the tick
 * thread; at one per ten seconds a full room of 128 could not add a millisecond
 * to a tick between them. It is also long enough that "teleport 200 m" is not a
 * movement ability -- which it would be at one per second, and which is the
 * only way this feature could affect a fight.
 */
export const UNSTUCK_COOLDOWN_MS = 10000;

// --- The search -------------------------------------------------------------

/** What was asked for: "a random road within 200m". */
export const UNSTUCK_RADIUS_M = 200;

/**
 * The radii tried, in order, when 200 m has nothing.
 *
 * Doubling rather than stepping, because the case this exists for is not "the
 * road is at 210 m" -- it is being in the middle of Centennial Park, on the
 * harbour foreshore, or inside a rail corridor, where the nearest street is a
 * different order of magnitude away.
 *
 * **Five rungs, not four, and the fifth is the sixty-kilometre world.** Four
 * rungs reached 1.6 km, and the note that used to be here said that was
 * "further than anywhere in this city is from a road". That was true of the
 * 19.3 km build and it stopped being true when the extent went to 60 km: the
 * disc now contains Broken Bay, the lower Hawkesbury and Pittwater, which are
 * kilometres of open water on built tiles a player can be standing in. Swept
 * over the 3,080-point, 1,200 m lattice `checkUnstuck` walks, the five start
 * points that reached no road at any rung sit **1,024 m to 2,996 m** from the
 * nearest lane -- all five in deep water, all five on a tile the pipeline
 * built. 3,200 m covers the worst of them with room, and it costs nothing
 * anywhere else because a rung is only tried when every tighter one came back
 * empty.
 *
 * The rung that answered is reported back to the player, because "you were
 * moved 900 m" with no explanation reads as a bug.
 */
export const UNSTUCK_LADDER: readonly number[] = [UNSTUCK_RADIUS_M, 400, 800, 1600, 3200];

/**
 * How finely a lane polyline is sampled, metres.
 *
 * Five metres is about a car length, which is the resolution at which two
 * candidate points are genuinely different places to stand. Finer would be
 * more work for a set of points that all pass or all fail together; coarser
 * would start missing the short kerb-to-kerb stubs that are the only road
 * inside a laneway block.
 */
const ROAD_SAMPLE_STEP = 5;

/**
 * The most candidates one call will hold, as triples.
 *
 * A 1.6 km rung over the CBD reaches a lot of street. The cap bounds the work
 * and costs nothing in quality: the pick is uniform over whatever was
 * collected, and four thousand points spread over the search area is already
 * far more choice than "random" needs.
 */
const MAX_CANDIDATES = 4096;

/**
 * How many candidates get validated before the rung gives up.
 *
 * Bounded because this runs on the server's tick thread and a search that can
 * spin is a server that can stall -- `game/spawn.ts`'s `SPAWN_ATTEMPTS` makes
 * the identical argument. A carriageway passes the clearance test essentially
 * always, so in practice this exits on the first or second candidate; the
 * budget is for the pathological case where every sample near you is under a
 * viaduct soffit.
 */
const VALIDATE_ATTEMPTS = 160;

/**
 * How far the ground under a lane sample may sit from the lane itself, metres.
 *
 * The lane's `y` is the running surface, so on any street the terrain under it
 * agrees to within the grid's own resolution. A large disagreement means the
 * answer came from somewhere else -- a tile whose terrain has not decoded yet
 * (which is the normal state offline, a few hundred metres out), or a lane
 * crossing over a tunnel portal where the prism under the query is not the
 * thing the road is carried on. Four metres is well over a terrain cell's
 * relief and well under a storey.
 */
const ROAD_SURFACE_TOLERANCE = 4;

/**
 * The fallback's rings, metres, and how many bearings each gets.
 *
 * **The last three rings are the sixty-kilometre world's, and they are measured
 * rather than padded.** The ladder above can reach a road 3.2 km away, but a
 * road is only an answer if a *sample on it* passes the spawn rule, and the
 * five worst starts in the extent -- the middle of Broken Bay, the lower
 * Hawkesbury, Port Hacking -- are surrounded by water and by lanes carried on
 * bridge decks whose ground answer disagrees with the lane by more than
 * `ROAD_SURFACE_TOLERANCE`. For those, open ground is the real rescue, and the
 * nearest standable ground at those five points is **79 m to 156 m** away.
 * Ninety metres was the whole ladder, so all five fell off the end of it and
 * `unstuckDestination` returned null -- which is the one answer this command is
 * not allowed to give. Rings at 140, 200 and 280 m clear the worst of them with
 * a ring to spare.
 *
 * They stay in ascending order and nothing before 90 m moves, so a player who
 * used to be rescued at 6 m is still rescued at 6 m: this only extends the tail
 * that used to give up.
 */
const GROUND_RINGS: readonly number[] = [3, 6, 10, 16, 25, 40, 60, 90, 140, 200, 280];
const GROUND_BEARINGS = 16;

/**
 * How much room a destination wants from a moving car, metres.
 *
 * A route polyline is a *driving lane*, so "a random road" is by construction a
 * place cars go -- and the first live online trial of this command landed the
 * player in front of one and took two pips off them before they had finished
 * reading the reply. Being run over is a real mechanic (`applyCarHit`) and it is
 * not being disabled here; what is wrong is arriving with no time to react to
 * something you did not choose to stand in front of.
 *
 * Fifteen metres is a second of warning at the 14 m/s an arterial runs at, which
 * is enough to step off. It is a **preference and not a veto** -- see
 * `pickRoadPoint`, which falls back to a car-adjacent road rather than widening
 * the search, because a road with traffic on it is still a road and the ladder's
 * next rung is 200 m further from where you were.
 */
export const UNSTUCK_CAR_CLEAR_M = 15;

/**
 * A road, as this file wants it: a polyline in world metres.
 *
 * Structural rather than an import of `LaneRoute`, so this module does not
 * depend on the traffic timetable to answer a question about geometry.
 * `LaneRoute` satisfies it as written, and so does `LaneWay` -- which matters
 * for the checks, where a synthetic street is three typed arrays.
 */
export interface RoadPolyline {
  count: number;
  x: Float32Array;
  /** Absolute world height, already on the running surface. */
  y: Float32Array;
  z: Float32Array;
}

/** Where the player is being sent, in feet height. Callers add `EYE_HEIGHT`. */
export interface UnstuckSpot {
  x: number;
  y: number;
  z: number;
  /** How far they are being moved, metres, in the plan. */
  distance: number;
  /**
   * Which rung of `UNSTUCK_LADDER` found it, or 0 for the ground fallback.
   * Reported to the player; see `unstuckReply`.
   */
  radius: number;
  kind: 'road' | 'ground';
}

/**
 * A random validated point on one of `roads`, within `radius` of the player.
 *
 * The roads are handed in rather than looked up, because the two callers have
 * different indexes over the same data -- the server's `TrafficField` holds
 * every route in the extent and the client's holds the resident tiles -- and
 * both already answer `near(x, z, radius, out)`. Passing the result keeps this
 * function a rule about geometry rather than a second opinion about storage.
 *
 * `rand` is a parameter on `pickSpawnPoint`'s argument: a check that wants two
 * hundred reproducible draws must be able to supply its own.
 *
 * `clearOfTraffic` is optional and is a *preference*: see `UNSTUCK_CAR_CLEAR_M`.
 * It is a callback rather than a `TrafficField` so this module stays free of the
 * timetable -- the two callers already own a broadphase, a `CarPose` and a tick,
 * and a second opinion about any of those here would be a second fleet.
 */
export function pickRoadPoint(
  fromX: number,
  fromZ: number,
  radius: number,
  roads: readonly RoadPolyline[],
  world: SpawnWorld,
  rand: () => number = Math.random,
  clearOfTraffic?: (x: number, z: number, y: number) => boolean,
): UnstuckSpot | null {
  // Flat triples rather than objects: a 1.6 km rung over the CBD is a few
  // thousand candidates, and this runs inside a 60 Hz tick's thread.
  const points: number[] = [];
  const r2 = radius * radius;

  for (const road of roads) {
    const n = road.count;
    if (n < 2) continue;
    for (let i = 0; i + 1 < n; i++) {
      const ax = road.x[i];
      const az = road.z[i];
      const ay = road.y[i];
      const bx = road.x[i + 1];
      const bz = road.z[i + 1];
      const by = road.y[i + 1];
      const seg = Math.hypot(bx - ax, bz - az);
      // The vertices themselves are always sampled (`s = 0`), so a polyline of
      // very short segments is not skipped by a step longer than its segments.
      const steps = Math.max(1, Math.ceil(seg / ROAD_SAMPLE_STEP));
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        const px = ax + (bx - ax) * t;
        const pz = az + (bz - az) * t;
        const dx = px - fromX;
        const dz = pz - fromZ;
        if (dx * dx + dz * dz > r2) continue;
        points.push(px, ay + (by - ay) * t, pz);
        if (points.length >= MAX_CANDIDATES * 3) break;
      }
      if (points.length >= MAX_CANDIDATES * 3) break;
    }
    if (points.length >= MAX_CANDIDATES * 3) break;
  }

  const total = (points.length / 3) | 0;
  if (total === 0) return null;

  // Shuffled rather than scanned in order, and that is the "random" in the
  // request: a scan would put every unstuck on whichever street happens to be
  // first in the tile that decoded first, which over a session reads as the
  // command always sending you to the same corner.
  const order = new Int32Array(total);
  for (let i = 0; i < total; i++) order[i] = i;
  for (let i = total - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }

  // The first valid point that also had no car near it, and -- separately -- the
  // first valid point of any kind. Two slots rather than one because the traffic
  // test is a preference: if every road inside this radius happens to have a car
  // on it right now, the answer is still that road. Widening to the next rung
  // instead would move somebody 200 m further from where they were in order to
  // avoid something that will have driven past by the time they land.
  let fallback: UnstuckSpot | null = null;
  const tries = Math.min(total, VALIDATE_ATTEMPTS);
  for (let k = 0; k < tries; k++) {
    const at = order[k] * 3;
    const px = points[at];
    const laneY = points[at + 1];
    const pz = points[at + 2];

    // The lane's own height as the feet hint, **not** `-Infinity`. That is what
    // puts a player on the Cahill's deck rather than under it: `roofHeight`
    // answers with the highest prism top below the query, so asking from just
    // above the running surface returns the viaduct the road is carried on and
    // returns the terrain everywhere else. See the header.
    const y = world.groundHeight(px, pz, laneY + SPAWN_STEP_HEIGHT);
    if (!Number.isFinite(y)) continue;
    if (Math.abs(y - laneY) > ROAD_SURFACE_TOLERANCE) continue;
    if (!isSpawnable(px, pz, y, world)) continue;

    const spot: UnstuckSpot = {
      x: px,
      y,
      z: pz,
      distance: Math.hypot(px - fromX, pz - fromZ),
      radius,
      kind: 'road',
    };
    if (!clearOfTraffic || clearOfTraffic(px, pz, y)) return spot;
    if (!fallback) fallback = spot;
  }
  return fallback;
}

/**
 * The last resort: the nearest point around the player that anybody could
 * stand on, road or not.
 *
 * For the parts of this world that genuinely have no street in them -- the
 * middle of the harbour, the bushland edge of the extent, the inside of a rail
 * cutting. Rings outward rather than a disc draw, because what is wanted here
 * is *the nearest* valid ground and not a random one: this is a rescue, and a
 * rescue that moved somebody 90 m when 3 m would have done has lost them their
 * place in the world for no reason.
 */
export function nearestOpenGround(
  fromX: number,
  fromZ: number,
  world: SpawnWorld,
  rand: () => number = Math.random,
): UnstuckSpot | null {
  for (const radius of GROUND_RINGS) {
    for (let i = 0; i < GROUND_BEARINGS; i++) {
      // Stratified with jitter, `pickRespawn`'s pattern: uniform draws leave
      // gaps, and the one bearing with open ground in it is the one that gets
      // missed.
      const bearing = ((i + rand()) / GROUND_BEARINGS) * Math.PI * 2;
      const px = fromX + Math.sin(bearing) * radius;
      const pz = fromZ + Math.cos(bearing) * radius;
      const y = spawnGround(world, px, pz);
      if (!Number.isFinite(y)) continue;
      if (!isSpawnable(px, pz, y, world)) continue;
      return { x: px, y, z: pz, distance: radius, radius: 0, kind: 'ground' };
    }
  }
  return null;
}

/**
 * Where this player is going: a road inside 200 m, or the best answer the
 * ladder can reach, or open ground, or nothing at all.
 *
 * `roadsWithin` is a closure rather than a flat list because each rung of the
 * ladder is a wider query, and both callers' road index is a spatial one --
 * handing over every road in Sydney so this could filter them would throw away
 * exactly the broadphase both ends already have.
 *
 * Returns null only when the world around the player is unbuilt in every
 * direction for 90 m, which on a loaded server cannot happen and offline means
 * the streamer has not answered yet. The caller says so rather than moving
 * somebody into the dark.
 */
export function unstuckDestination(
  fromX: number,
  fromZ: number,
  roadsWithin: (radius: number) => readonly RoadPolyline[],
  world: SpawnWorld,
  rand: () => number = Math.random,
  clearOfTraffic?: (x: number, z: number, y: number) => boolean,
): UnstuckSpot | null {
  for (const radius of UNSTUCK_LADDER) {
    const spot = pickRoadPoint(fromX, fromZ, radius, roadsWithin(radius), world, rand, clearOfTraffic);
    if (spot) return spot;
  }
  return nearestOpenGround(fromX, fromZ, world, rand);
}

// --- What the player is told ---------------------------------------------------

/**
 * The private line the sender gets back. One sentence, and it always says what
 * happened to their score.
 *
 * Every branch names the no-death rule, because that is the part nobody can
 * observe: a player who used this mid-fight has no way to tell whether the
 * board moved, and a feature whose scoring behaviour is a guess is a feature
 * people stop using. See the header for why it is that way round.
 */
export function unstuckReply(spot: UnstuckSpot | null): string {
  if (!spot) {
    return 'could not find anywhere to put you — walk a few steps and try again';
  }
  const d = Math.round(spot.distance);
  if (spot.kind === 'ground') {
    const widest = UNSTUCK_LADDER[UNSTUCK_LADDER.length - 1];
    return `no road within ${widest} m — moved you ${d} m to open ground; no death recorded`;
  }
  if (spot.radius <= UNSTUCK_RADIUS_M) {
    return `moved you ${d} m to a road — no death recorded`;
  }
  return `no road within ${UNSTUCK_RADIUS_M} m — moved you ${d} m to a road, searching ${spot.radius} m; no death recorded`;
}

/** Refused because they are already on the pavement; the respawn handles that. */
export const UNSTUCK_KO_NOTICE = 'you are knocked out — you will get up on your own in a moment';

/** Refused because they just used it. `waitMs` is what is left of the cooldown. */
export function unstuckWaitNotice(waitMs: number): string {
  const seconds = Math.max(1, Math.ceil(waitMs / 1000));
  return `unstuck is once every ${UNSTUCK_COOLDOWN_MS / 1000} s — ${seconds} s to go`;
}

// --- The self-check -------------------------------------------------------------

/**
 * The five things here that fail silently, asserted on synthetic worlds.
 *
 * Each of these leaves a game that runs and a command that appears to work:
 *
 *   - **A prefix match instead of an exact one** turns every sentence starting
 *     with "/kill" into a teleport, and the player never sees their own words.
 *   - **A destination that is not validated** moves somebody out of one piece
 *     of stuck geometry into another, or into the harbour, and reads as the
 *     command being broken rather than as a missing check.
 *   - **A ladder that does not widen** answers "nowhere to go" on the foreshore
 *     forever, which is exactly where somebody is most likely to be stuck.
 *   - **A scan instead of a shuffle** sends every unstuck in a session to the
 *     same corner, which nobody reports because each individual use worked.
 *   - **A reply over the chat byte cap** is clipped mid-word by the encoder, so
 *     the one sentence explaining the no-death rule loses its end.
 *
 * Run standalone:
 *
 *     bun -e "import {verifyUnstuck} from './client/src/game/unstuck.ts';
 *             console.log(verifyUnstuck())"
 */
export function verifyUnstuck(): string[] {
  const failures: string[] = [];

  // A deterministic PRNG, so this check is the same every time it runs.
  let seed = 987654321;
  const rand = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  /** A straight 1 km street along +x at z = 0, flat, one metre off the datum. */
  const street = (offsetZ: number): RoadPolyline => {
    const n = 101;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    const z = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = i * 10 - 500;
      y[i] = 1;
      z[i] = offsetZ;
    }
    return { count: n, x, y, z };
  };

  const flat: SpawnWorld = { collision: null, groundHeight: () => 1 };

  // --- 1. The command surface: the three aliases, and everything that is not.
  {
    for (const yes of ['/unstuck', '/kill', '/stuck', '/UNSTUCK', ' /Kill ', '/Stuck']) {
      if (!unstuckCommand(yes)) failures.push(`${JSON.stringify(yes)} was not recognised as the unstuck command.`);
    }
    for (const no of ['/kill bazza', 'unstuck', '/unstuckme', '/killer', 'oi', '', '/', 'kill', '//kill']) {
      if (unstuckCommand(no)) failures.push(`${JSON.stringify(no)} was treated as a command; it is a chat line.`);
    }
  }

  // --- 2. A road inside 200 m is found, landed on, and is inside the radius.
  {
    const roads = [street(0)];
    let worst = 0;
    let offLine = 0;
    for (let i = 0; i < 200; i++) {
      const spot = pickRoadPoint(0, 40, UNSTUCK_RADIUS_M, roads, flat, rand);
      if (!spot) {
        failures.push('a straight street 40 m away produced no unstuck destination.');
        break;
      }
      worst = Math.max(worst, spot.distance);
      if (Math.abs(spot.z) > 1e-3) offLine++;
      if (Math.abs(spot.y - 1) > 1e-6) failures.push(`a destination came back at y ${spot.y}, not the street's own surface.`);
    }
    if (worst > UNSTUCK_RADIUS_M + 1e-6) {
      failures.push(`a destination landed ${worst.toFixed(1)} m away, outside the ${UNSTUCK_RADIUS_M} m radius.`);
    }
    if (offLine > 0) failures.push(`${offLine} of 200 destinations were not on the street polyline.`);
  }

  // --- 3. The pick is spread rather than deterministic. A scan would return the
  //        same point every time; 200 draws over ~80 candidates must not.
  {
    const roads = [street(0)];
    const seenX = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const spot = pickRoadPoint(0, 40, UNSTUCK_RADIUS_M, roads, flat, rand);
      if (spot) seenX.add(Math.round(spot.x));
    }
    if (seenX.size < 10) {
      failures.push(`200 unstuck draws over a 400 m stretch of street landed on ${seenX.size} distinct points; the pick is not random.`);
    }
  }

  // --- 4. Validation actually rejects. A world entirely inside a prism, and a
  //        world entirely under water, must both refuse the street.
  {
    const walled: SpawnWorld = { collision: { resolve: () => ({ hit: true }) }, groundHeight: () => 1 };
    if (pickRoadPoint(0, 40, UNSTUCK_RADIUS_M, [street(0)], walled, rand) !== null) {
      failures.push('a street buried in a collision prism still produced a destination.');
    }
    const flooded: SpawnWorld = { collision: null, groundHeight: () => 1, waterSurface: () => 3 };
    if (pickRoadPoint(0, 40, UNSTUCK_RADIUS_M, [street(0)], flooded, rand) !== null) {
      failures.push('a street under 2 m of water still produced a destination.');
    }
    // And a world with no ground at all under the lane.
    const holed: SpawnWorld = { collision: null, groundHeight: () => NaN };
    if (pickRoadPoint(0, 40, UNSTUCK_RADIUS_M, [street(0)], holed, rand) !== null) {
      failures.push('a street over unbuilt ground still produced a destination.');
    }
    // A lane whose ground answer disagrees with the lane's own surface by a
    // storey is the tunnel case, and must be refused rather than dropped into.
    const tunnel: SpawnWorld = { collision: null, groundHeight: () => -30 };
    if (pickRoadPoint(0, 40, UNSTUCK_RADIUS_M, [street(0)], tunnel, rand) !== null) {
      failures.push(`a lane whose ground sits 31 m below its surface was accepted; the tolerance is ${ROAD_SURFACE_TOLERANCE} m.`);
    }
  }

  // --- 5. The traffic preference: avoided where it can be, and never at the
  //        cost of the answer.
  {
    const roads = [street(0)];
    // Cars all over the western half of the street. Every draw must land east
    // of the line, and none may fail.
    let west = 0;
    for (let i = 0; i < 100; i++) {
      const spot = pickRoadPoint(0, 40, UNSTUCK_RADIUS_M, roads, flat, rand, (x) => x > 0);
      if (!spot) {
        failures.push('the traffic preference turned a findable road into no answer at all.');
        break;
      }
      if (spot.x <= 0) west++;
    }
    if (west > 0) {
      failures.push(`${west} of 100 draws landed on the half of the street with cars on it while the other half was clear.`);
    }
    // And when the whole street is in traffic, the street is still the answer.
    // Falling through to the next rung here would move somebody 200 m further to
    // dodge a car that will have driven past by the time they land.
    const jammed = pickRoadPoint(0, 40, UNSTUCK_RADIUS_M, roads, flat, rand, () => false);
    if (!jammed) {
      failures.push('a street with cars along the whole of it produced no destination; the traffic test is a preference, not a veto.');
    }
  }

  // --- 6. The ladder widens, and reports which rung answered.
  {
    // The only street is 600 m away, so the first two rungs must miss and the
    // third must find it.
    const far = [street(600)];
    const roadsWithin = (radius: number): readonly RoadPolyline[] => (radius >= 800 ? far : []);
    const spot = unstuckDestination(0, 0, roadsWithin, flat, rand);
    if (!spot || spot.kind !== 'road') {
      failures.push('a street 600 m away was not reached by the ladder.');
    } else if (spot.radius !== 800) {
      failures.push(`the ladder reported rung ${spot.radius} m for a street only the 800 m rung was offered.`);
    }
    // Nothing but the search itself: no roads at any radius falls back to
    // ground, and says so.
    const none = unstuckDestination(0, 0, () => [], flat, rand);
    if (!none || none.kind !== 'ground') {
      failures.push('a world with no roads at any radius did not fall back to open ground.');
    } else if (none.distance > GROUND_RINGS[0] + 1e-6) {
      failures.push(`the ground fallback moved the player ${none.distance} m when the first ring is ${GROUND_RINGS[0]} m.`);
    }
    // And a world with no roads *and* nowhere to stand refuses outright rather
    // than putting somebody in the dark.
    const nowhere: SpawnWorld = { collision: null, groundHeight: () => NaN };
    if (unstuckDestination(0, 0, () => [], nowhere, rand) !== null) {
      failures.push('a world with no ground anywhere still produced a destination.');
    }
  }

  // --- 7. Every reply fits the wire and names the scoring rule. `MAX_CHAT_BYTES`
  //        is 240 and the encoder clips silently; a clipped reply loses exactly
  //        the clause nobody could otherwise observe.
  {
    const enc = new TextEncoder();
    const replies = [
      unstuckReply(null),
      unstuckReply({ x: 0, y: 0, z: 0, distance: 137.4, radius: 200, kind: 'road' }),
      unstuckReply({ x: 0, y: 0, z: 0, distance: 913.2, radius: 1600, kind: 'road' }),
      unstuckReply({ x: 0, y: 0, z: 0, distance: 6, radius: 0, kind: 'ground' }),
      UNSTUCK_KO_NOTICE,
      unstuckWaitNotice(4200),
    ];
    for (const line of replies) {
      const bytes = enc.encode(line).length;
      if (bytes > 240) failures.push(`the reply ${JSON.stringify(line)} is ${bytes} bytes, over the 240 byte chat cap.`);
    }
    for (const line of replies.slice(1, 4)) {
      if (!line.includes('no death')) failures.push(`the reply ${JSON.stringify(line)} does not say that no death was recorded.`);
    }
    // Rounded **up**, so "1 s to go" never means "try now and be refused".
    if (!unstuckWaitNotice(4200).includes('5 s to go')) {
      failures.push(`4.2 s of cooldown should read as 5 s to go; got ${JSON.stringify(unstuckWaitNotice(4200))}.`);
    }
    if (!unstuckWaitNotice(1).includes('1 s to go')) {
      failures.push(`a millisecond of cooldown should read as 1 s to go; got ${JSON.stringify(unstuckWaitNotice(1))}.`);
    }
  }

  // --- 8. A body inside an underground station is not rescued to the street.
  //
  // The report this file was blamed for. Nothing here fires on its own -- see
  // the header -- but the property it *would* have needed is real and was
  // unasserted: this module's whole notion of "where can somebody stand" is the
  // caller's `SpawnWorld.groundHeight`, so a world that knows about station
  // boxes must produce answers **at the station floor** and never at the
  // terrain over it.
  //
  // The world below is Town Hall's numbers: platform surface at -36.6, George
  // Street 19 m over it at -17.3. A ground query that had not heard of the box
  // would answer -17.3 everywhere and the fallback would place a body there,
  // which is precisely "tps me to surface"; one that has answers -36.6 inside
  // the box, and the rescue keeps the player in the station they were in.
  {
    const FLOOR = -36.6;
    const STREET = -17.3;
    const station: SpawnWorld = {
      collision: null,
      // Inside the box (feet under the street) the floor is the station's; a
      // body up at street level gets the street. Exactly `groundHeightAt`'s
      // banded shape, in eight characters of arithmetic.
      groundHeight: (_x, _z, feet) => (feet < STREET - 1.5 ? FLOOR : STREET),
    };
    const spot = nearestOpenGround(0, 0, station, rand);
    if (!spot) {
      failures.push('a body inside a station box found nowhere to stand at all.');
    } else if (Math.abs(spot.y - FLOOR) > 1e-6) {
      failures.push(
        `the ground fallback put a body standing on a station floor at y ${spot.y} ` +
        `rather than ${FLOOR}; it was rescued ${(spot.y - FLOOR).toFixed(1)} m up to the surface.`,
      );
    }
    // And the control: the same rescue in a world with no station box answers
    // the street, so the assertion above is about the box and not about the
    // arithmetic. Without this the case passes on a stub that returns FLOOR
    // unconditionally, which is the shape of check that proves nothing.
    const bare: SpawnWorld = { collision: null, groundHeight: () => STREET };
    const control = nearestOpenGround(0, 0, bare, rand);
    if (!control || Math.abs(control.y - STREET) > 1e-6) {
      failures.push(
        'NEGATIVE CONTROL: a world with no station box under the body did not answer the street; ' +
        'the case above is not measuring the box.',
      );
    }
  }

  return failures;
}
