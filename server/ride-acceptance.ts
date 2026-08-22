/**
 * The acceptance run: two real WebSocket clients against a real server process.
 *
 *     bun run server/index.ts &
 *     bun run server/ride-acceptance.ts          # RIDE_S=230 for two stops
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR, AND WHY IT IS NOT THE CHECK.
 *
 * `integration-check.checkRidingOnline` is the check. It runs in a second, it
 * asserts, it goes red, and it belongs in the gate. What it does *not* have is
 * an operating system: its room is in the same process, its socket is a class
 * with an array in it, and its clock is a variable. Everything real about a
 * deployment that is not the protocol -- the WebSocket framing, the scheduler,
 * two processes disagreeing about the millisecond -- is out of its scope.
 *
 * This is the other half, and it is the half the rolled-back round never ran:
 * a separately-launched `server/index.ts`, two OS sockets, the real wall clock,
 * and a real ninety-second wait for a real dwell. It prints rather than
 * asserts, because the numbers worth reading here are the ones you have to
 * interpret -- see the along/across split on the position gap, which is the
 * difference between "the snapshot I am holding is 168 ms old" and "the two
 * ends disagree about where in the carriage I am".
 *
 * ---------------------------------------------------------------------------
 * It drives the SAME seam the browser does -- `riding.boardHere` and
 * `riding.rideEnter` -- and it asks the SERVER to place it, through
 * `/platform`. There is no client-side teleport anywhere in it, because the
 * previous harness had one and that is precisely why the feature shipped
 * broken.
 *
 * ---------------------------------------------------------------------------
 * SECTIONS 0 AND 0E ARE OFFLINE, AND ON PURPOSE. The modes, in one place:
 *
 *     RIDE_GANGWAY=off|on|only   section 0  -- walking a moving Metropolis
 *     RIDE_E2E=off|on|only       section 0e -- Hornsby to Penrith, one seat
 *     RIDE_S=<seconds>           sections 1-6, how long the networked ride runs
 *     SYDNEY_RIDE_FROM=<station> sections 1-6, where the networked ride boards
 *     SYDNEY_SERVER=<ws url>     sections 1-6, which server to drive
 *
 * The gangway case below the imports runs **before anything opens a socket**,
 * against the shipped bake and nothing else, and `RIDE_GANGWAY=only` runs it and
 * exits. That is not a shortcut around the networked half; it is what the case
 * actually needs. Walking the length of a Metropolis between stations requires a
 * Metro that is *moving*, and the online harness is built round waiting ninety
 * seconds for a train to *stop* -- so the two want opposite halves of the same
 * timetable, and solving for a moving train is a division rather than a wait.
 * What it drives is the real seam either way: `rideEnter`, `combat.advance`,
 * `rideExit`, tick by tick, which is the same three calls `sim.step` makes.
 *
 * ---------------------------------------------------------------------------
 * AND SECTION 0E IS OFFLINE FOR A HARDER REASON: THE CLOCK.
 *
 * *"i wanna be able to go from hornsby to penrith if a train will do that for
 * me"*. A train will: T1's Berowra -> Emu Plains calls at both, forty-one hops
 * apart, and the run between them is **3,670 seconds** of timetable. There is no
 * version of that which a networked harness can sit through, and there is no
 * knob on a separately-launched `server/index.ts` that makes its wall clock run
 * faster -- `Simulation.railNowMs` is a field on an object this process does not
 * own.
 *
 * So 0e owns the object. It builds a **real `Simulation` over the real world**,
 * drives `railNowMs` at the tick rate the way `integration-check.rideAt` has
 * since the rail round, and steps `sim.step` 220,000 times: the authority's own
 * boarding, the authority's own `enterCarriage`, the authority's own alight. It
 * gives up exactly two things against sections 1-6 -- the WebSocket framing and
 * a second process's opinion of the millisecond -- and those two are what
 * sections 1-6 are for. What it buys is the only thing that matters here: a
 * whole journey, end to end, in a check that finishes.
 */
import { NetClient } from '../client/src/net/client.ts';
import {
  ABOARD_STEP_M, TICK_HZ, createSnapshot, decodeSnapshot, encodeSnapshot,
  quantiseAcross, quantiseAlong, quantiseRise,
  type SnapshotAboard,
} from '../client/src/net/protocol.ts';
import { advance, createCombatant } from '../client/src/game/combat.ts';
import { EYE_HEIGHT } from '../client/src/player/controller.ts';
import { createTrainPose, decodeRail, poseTrain, railSeconds } from '../client/src/game/rail.ts';
import {
  RIDE_ON, aboardFrame, aboardPose, boardHere, carriageFloor, clearAboard, consistOf,
  consistOffset, createBoardOffer, createCarFrame, createCarriageStand, carSign, dirOf,
  dwellStand, findBoarding, interiorOfCar, isAboard,
  nextDwell, projectAboard, rideEnter, rideExit, verifyGangway, worldToLocal,
  type Stand,
} from '../client/src/game/riding.ts';
import {
  ANNOUNCE_ARRIVE, announcementAt, callToStop, createRailAnnouncement,
} from '../client/src/game/rail-audio.ts';
import { RAIL_EPOCH_MS } from '../client/src/game/rail.ts';
import { Simulation, type TickOutput } from './sim.ts';
import { loadWorld, roomWorld } from './world.ts';
import type { CombatWorld } from '../client/src/game/combat.ts';

const URL_ = process.env.SYDNEY_SERVER ?? 'ws://localhost:8788';
const FROM = process.env.SYDNEY_RIDE_FROM ?? 'St Peters';
const FIXED_DT = 1 / TICK_HZ;

const bake = decodeRail(await Bun.file('./client/public/rail/rail.bin').arrayBuffer());

/** Scratch pose for section 0's solve. `game/rail.ts` never allocates one either. */
const posePad = createTrainPose();

const say = (s: string): void => { console.log(s); };

/**
 * An offline section went red, remembered rather than acted on.
 *
 * Section 0e can fail on the shape of the railway, which is a real failure and
 * is also nothing to do with the WebSocket half below it -- and exiting on it
 * would mean a pathing defect in the bake silently stopping anybody from ever
 * seeing sections 1-6 again. So the exit code is carried to the bottom of the
 * file. `RIDE_E2E=only` still exits immediately, because that is what `only`
 * means.
 */
let offlineFailed = false;

// --- 0. The gangway: walking a Metropolis end to end while it is moving.
//
// See the header for why this is offline and why it is first. `RIDE_GANGWAY=off`
// skips it, `RIDE_GANGWAY=only` runs it and stops.
if ((process.env.RIDE_GANGWAY ?? 'on') !== 'off') {
  say('--- 0. walking between Metro carriages, between stations ---');
  const failures = verifyGangway();
  say(`riding.verifyGangway: ${failures.length === 0 ? 'clean' : `${failures.length} failure(s)`}`);
  for (const f of failures) say(`  ! ${f}`);

  // A real Metro trip on the real bake, at an instant it is **moving**. Solved
  // rather than polled, on `nextDwell`'s own argument: a Metro's doors are open
  // for fifteen seconds in every couple of minutes, so stepping the clock a
  // second at a time from now until `poseTrain` says the train is running with
  // its doors shut and real speed under it is one short loop and no waiting.
  const FIXED = 1 / TICK_HZ;
  let found: { li: number; di: number; trip: number; t: number } | null = null;
  const now = railSeconds(Date.now());
  outer: for (let li = 0; li < bake.lines.length && found === null; li++) {
    const line = bake.lines[li];
    if (!line.metro) continue;
    for (const dir of line.dirs) {
      const live = Math.floor(dir.duration / line.period) + 2;
      for (let j = 0; j <= live; j++) {
        const trip = Math.floor((now - dir.offset) / line.period) - j;
        for (let dt = 0; dt < 240; dt += 1) {
          const t = now + dt;
          if (!poseTrain(bake, dir, trip, t, posePad)) continue;
          // Moving, doors shut, and far enough into the run that a 132 m consist
          // is entirely on the line -- `consistOffset` clamps a carriage whose
          // centre is behind the start and a clamped carriage is not a carriage
          // anybody can walk into.
          if (posePad.doorsOpen || posePad.speed < 20 || posePad.s < 200) continue;
          // And it has to stay between stations for the whole walk. A rider
          // covers 4.4 m/s and a six-car Metropolis is 132 m, so the walk is
          // thirty seconds; sampled rather than swept because `doorsOpen` is a
          // fifteen-second phase and four probes ten seconds apart cannot miss
          // one. A train that pulls in halfway through is not a wrong answer, it
          // is a weaker one -- the request was for a walk on a moving train.
          let stays = true;
          for (let ahead = 10; ahead <= 40 && stays; ahead += 10) {
            stays = poseTrain(bake, dir, trip, t + ahead, posePad) && !posePad.doorsOpen;
          }
          if (!stays) continue;
          found = { li, di: dir.index, trip, t };
          break outer;
        }
      }
    }
  }

  if (found === null) {
    say('  ! no Metro service in the bake is between stations in the next four minutes');
  } else {
    const dir = dirOf(bake, found.li, found.di)!;
    const consist = consistOf(dir, found.trip);
    const n = consist.cars.length;
    const combat = createCombatant(0, 0, 0);
    const a = combat.aboard;
    const frame = createCarFrame();
    const stand = createCarriageStand();
    const it0 = interiorOfCar(consist, n - 1)!;
    a.line = found.li;
    a.dir = found.di;
    a.trip = found.trip;
    // The rear driving car, standing at its cab end, facing down the train. A
    // local yaw of pi/2 is a forward of (-1, 0) in the carriage's own plan --
    // `controller.step`'s `(-sin yaw, -cos yaw)` -- so "hold W" walks -X.
    a.car = n - 1;
    a.x = it0.xMax - 1;
    a.y = it0.vestibuleY + EYE_HEIGHT;
    a.z = 0;
    a.yaw = Math.PI / 2;
    if (!aboardFrame(bake, a, found.t, frame)) throw new Error('the trip vanished');
    projectAboard(a, combat.body, frame);
    combat.body.onGround = true;

    // --- `Opal Hop`, tested on the one thing in the bake that is hard to
    // stage: a train that is moving.
    //
    // The section already had to find a service between stations with its doors
    // shut, which is exactly the fixture this node is about, so the assertions
    // cost one `findBoarding` each and no server at all.
    //
    // The probe is placed by `projectAboard` rather than by a hand-rolled
    // rotation, and that is not fussiness: `findBoarding` locates a door with
    // `worldToLocal`, and a world position built by a second, independently
    // written transform tests my arithmetic instead of the rule. Placed *at* a
    // door bay too -- `doorBayAt` refuses any x more than 0.35 m off one, for
    // everybody and every talent.
    {
      const probe = createBoardOffer();
      const beside = createCombatant(0, 0, 0);
      const it = interiorOfCar(consist, a.car)!;
      const at = (lateral: number): void => {
        const spot = { ...a, x: it.doors[0].x, y: it.vestibuleY + EYE_HEIGHT, z: it.halfWidth + lateral };
        projectAboard(spot, beside.body, frame);
      };
      const ask = (moving: boolean): boolean =>
        findBoarding(
          bake, beside.body.position.x, beside.body.position.y - EYE_HEIGHT, beside.body.position.z,
          found.t, probe, { moving },
        );

      at(1.5);
      const without = ask(false);
      const with_ = ask(true);
      say(`  Opal Hop: 1.5 m off a moving door -- without the node ${without ? 'BOARDED' : 'refused'}, with it ${with_ ? 'boarded' : 'REFUSED'}`);
      if (without) say('  ! FAILED: a moving train was boardable without Opal Hop; the doors-open gate is gone for everybody');
      if (!with_) say('  ! FAILED: Opal Hop did not open the moving door it is sold as');

      // And the extra metre is bounded rather than a free pass.
      at(6);
      const tooFar = ask(true);
      say(`  Opal Hop: six metres off the side -- ${tooFar ? 'BOARDED (FAILED: the reach is unbounded)' : 'refused, as the 4 m reach says'}`);
    }

    const input = {
      forward: 1, right: 0, jump: false, sprint: false,
      yaw: a.yaw, pitch: 0, speedScale: 1, jumpScale: 1,
      punch: false, throwBall: false, mount: false,
    };
    const snap = createSnapshot();
    const wire: SnapshotAboard[] = [{
      id: 1, line: 0, dir: 0, tripLow: 0, car: 0, x: 0, y: 0, z: 0,
    }];

    let ticks = 0;
    let crossings = 0;
    let lastCar = a.car;
    let lastArc = -Infinity;
    let arcBackwards = 0;
    let offConsist = 0;
    let skipped = 0;
    let wireBad = 0;
    let wireCarBad = 0;
    let minSpeed = Infinity;
    let ended = '';
    const startArc = (() => {
      const p = aboardPose(bake, a, found.t)!;
      return consistOffset(p.s, a.car, n, consist.pitch) + carSign(consist, a.car) * a.x - p.s;
    })();
    let endArc = startArc;

    // 4.4 m/s over 132 m of train, with room for the two cab ends and a margin.
    for (; ticks < 2600; ticks++) {
      const t = found.t + ticks * FIXED;
      const got = rideEnter(bake, a, combat.body, t, frame, stand);
      if (got !== RIDE_ON) { ended = `rideEnter said ${got}`; break; }
      advance(combat, input, FIXED, stand as unknown as CombatWorld);
      input.yaw += rideExit(bake, a, combat.body, t, frame);

      const pose = aboardPose(bake, a, t);
      if (pose === null) { ended = 'the trip stopped running'; break; }
      if (pose.speed < minSpeed) minSpeed = pose.speed;

      // (a) never off the end of the consist, and one coupling at a time.
      if (a.car < 0 || a.car >= n) { offConsist++; break; }
      if (a.car !== lastCar) {
        crossings++;
        if (Math.abs(a.car - lastCar) !== 1) skipped++;
        lastCar = a.car;
      }
      // (b) the carriage index and the position along the train move together:
      //     the rider's arc length relative to the train's own reference point
      //     never goes backwards while they hold W.
      const arc =
        consistOffset(pose.s, a.car, n, consist.pitch) + carSign(consist, a.car) * a.x - pose.s;
      if (arc < lastArc - 1e-6) arcBackwards++;
      lastArc = arc;
      endArc = arc;

      // (c) the wire carries the change. Encoded and decoded every tick, so the
      //     three bits of carriage are exercised at every index the walk visits
      //     rather than at the one it finishes on.
      wire[0].line = a.line;
      wire[0].dir = a.dir;
      wire[0].tripLow = a.trip & 0xff;
      wire[0].car = a.car;
      wire[0].x = a.x;
      wire[0].y = a.y;
      wire[0].z = a.z;
      const back = decodeSnapshot(encodeSnapshot(ticks, 0, [], [], [], wire), snap);
      const rec = back?.aboard[0];
      if (!rec || rec.car !== a.car) wireCarBad++;
      else if (
        Math.abs(rec.x - quantiseAlong(a.x) * ABOARD_STEP_M) > 1e-9 ||
        Math.abs(rec.y - quantiseRise(a.y) * ABOARD_STEP_M) > 1e-9 ||
        Math.abs(rec.z - quantiseAcross(a.z) * ABOARD_STEP_M) > 1e-9
      ) wireBad++;

      if (a.car === 0 && a.x > (interiorOfCar(consist, 0)!.xMax - 1.5)) {
        ended = 'reached the leading cab';
        break;
      }
    }

    const walked = endArc - startArc;
    say(
      `  ${bake.lines[found.li].id} trip ${found.trip}, ${n} cars at ` +
        `${(minSpeed * 3.6).toFixed(0)} km/h minimum: walked ${walked.toFixed(1)} m of train in ` +
        `${ticks} ticks (${(ticks * FIXED).toFixed(1)} s), ${crossings} gangway crossing(s) -- ${ended}`,
    );
    say(
      `  carriage ${n - 1} -> ${a.car}; skipped couplings ${skipped}, left the consist ` +
        `${offConsist} time(s), went backwards along the train ${arcBackwards} tick(s)`,
    );
    say(
      `  the wire round-tripped the rider on ${ticks - wireCarBad - wireBad}/${ticks} ticks ` +
        `(${wireCarBad} wrong carriage, ${wireBad} outside the 2.5 cm quantiser)`,
    );
    const ok =
      crossings === n - 1 && skipped === 0 && offConsist === 0 && arcBackwards === 0 &&
      wireCarBad === 0 && wireBad === 0 && a.car === 0;
    say(`  gangway walk: ${ok ? 'PASS' : 'FAILED'}`);
    if (!ok) process.exit(1);
  }
  if ((process.env.RIDE_GANGWAY ?? 'on') === 'only') process.exit(0);
}

// --- 0e. Hornsby to Penrith, in one seat, without getting up.
//
// See the header for why this one is offline too. `RIDE_E2E=off` skips it,
// `RIDE_E2E=only` runs it and stops, and `RIDE_E2E_FROM` / `RIDE_E2E_TO` point
// it at some other pair of stations on some other line.
//
// ---------------------------------------------------------------------------
// WHAT IS BEING ASSERTED, AND WHY IT IS NOT "THE TRAIN GOT THERE".
//
// The train getting there was never in doubt: `poseTrain` is a closed-form
// lookup over a baked curve and workstream AF rode 95 km of this very direction
// through it with no rider attached. What has never been run is a **passenger**
// staying on for a whole direction, and every one of the seven things below is
// a thing a person would notice and none of them is visible to a pose sweep:
//
//   (a) aboard on every tick, from the first stop to the last;
//   (b) in the carriage they sat down in, having never stood up;
//   (c) moving forwards -- arc length never goes backwards, the world position
//       never jumps further in a tick than a train can travel in one, and the
//       body stays inside the carriage box the whole way;
//   (d) every station called at, in the timetable's order, none skipped;
//   (e) the PA naming each of them exactly once, in the same order;
//   (f) the wire carrying the rider on every tick -- the invariant section 0
//       checks over thirty seconds, checked over sixty-one minutes;
//   (g) nothing reaching them through the side of it. This one was added after
//       the run found something doing exactly that; see the counter.
//
// And then the rider gets off at the far end and lands on a platform -- twice,
// because the far end has two meanings and both are a way a ride ends: pressing
// E at Penrith, and staying on until the trip itself stops existing.
if ((process.env.RIDE_E2E ?? 'on') !== 'off') {
  const FROM_E2E = process.env.RIDE_E2E_FROM ?? 'Hornsby';
  const TO_E2E = process.env.RIDE_E2E_TO ?? 'Penrith';
  say(`--- 0e. ${FROM_E2E} to ${TO_E2E}, one seat, the whole way ---`);

  // **The instant is an argument, not a sample.** `integration-check.rideAt`
  // learned this the hard way and the reason transfers verbatim: the timetable
  // is a pure function of the millisecond, so a journey is a pure function of
  // the millisecond it starts at, and a failure that cannot be pointed at an
  // instant cannot be re-run. `RIDE_E2E_AT` replays one; the default is now, and
  // it is printed either way.
  const askedAtMs = Number(process.env.RIDE_E2E_AT ?? Date.now());
  const askedAt = railSeconds(askedAtMs);

  // Which service. `nextDwell`'s `then` is the whole of "a train that is any use
  // to me": Hornsby is served in both directions and one of them goes to
  // Berowra, which is four minutes the wrong way up a line that never sees
  // Penrith. One call ahead is not enough either -- `minAhead` is left at its
  // default because `then` is strictly stronger.
  const dwell = nextDwell(bake, FROM_E2E, askedAt, { then: TO_E2E });
  if (dwell === null) {
    say(`  ! no service in the bake calls at ${FROM_E2E} and then at ${TO_E2E}`);
    process.exit(1);
  }
  const dir = dirOf(bake, dwell.line, dwell.dir)!;

  // The stops between the two, off the timetable rather than off the ride, so
  // (d) is checked against what the bake promises rather than against what the
  // simulation happened to do.
  const calling = dir.stops.filter((s) => s.calls);
  const fromCall = calling.findIndex((s) => s.name === FROM_E2E);
  const toCall = calling.findIndex((s, i) => i > fromCall && s.name === TO_E2E);
  const wanted = calling.slice(fromCall + 1, toCall + 1);
  say(
    `  ${dwell.lineId} "${dir.line.name}" ${dir.label}: ${wanted.length} stations from ` +
      `${FROM_E2E} to ${TO_E2E}, ${((calling[toCall].s - calling[fromCall].s) / 1000).toFixed(1)} km, ` +
      `${((dir.arrivals[toCall] - dir.arrivals[fromCall]) / 60).toFixed(1)} minutes of timetable`,
  );
  say(`  boarding trip ${dwell.trip}, doors open at rail second ${dwell.opensAt.toFixed(1)} (asked at ${askedAtMs})`);

  // --- The route, before anybody rides it: does it ever double back on itself?
  //
  // ---------------------------------------------------------------------------
  // WHY THIS IS A PRE-FLIGHT AND NOT A CONSEQUENCE OF THE RIDE.
  //
  // A carriage's frame is built from two bogie samples fourteen metres apart
  // (`riding.carFrameAt`), so where the route's heading reverses the whole
  // carriage swings through 180 degrees and back -- and a rider sitting 4.7 m
  // along it and 1 m off the centreline is thrown eight metres sideways in a
  // single tick while the train's own reference point moves two thirds of one.
  // From the seat it is the city whipping round; from a check it looks like a
  // teleport, and blaming the teleport on the rider is how this would get fixed
  // in the wrong file.
  //
  // So it is measured **off the polyline**, before a `Simulation` exists, and it
  // is measured the way `STATIONS.md` already measures it for the terrain carve:
  // *"a reversal is a turn of 180 degrees and is refused by the same test that
  // lets a two-degree bend through"*. That test is `CHAIN_STRAIGHT_COS` and it
  // guards the chaining of cutting runs. **The service polylines the timetable
  // rides have no equivalent guard**, and this is what that costs.
  //
  // 90 degrees rather than the carve's 32: this is not asking whether the route
  // is smooth, it is asking whether it goes backwards, and nothing short of
  // backwards produces the swing.
  interface Reversal { cum: number; deg: number; legA: number; legB: number; near: string }
  const reversalsOn = (d: typeof dir): Reversal[] => {
    const found: Reversal[] = [];
    for (let i = d.vertexOff + 1; i < d.vertexOff + d.vertexCount - 1; i++) {
      const a = (i - 1) * 3;
      const b = i * 3;
      const c = (i + 1) * 3;
      const h1x = bake.vertices[b] - bake.vertices[a];
      const h1z = bake.vertices[b + 2] - bake.vertices[a + 2];
      const h2x = bake.vertices[c] - bake.vertices[b];
      const h2z = bake.vertices[c + 2] - bake.vertices[b + 2];
      const l1 = Math.sqrt(h1x * h1x + h1z * h1z);
      const l2 = Math.sqrt(h2x * h2x + h2z * h2z);
      if (l1 === 0 || l2 === 0) continue;
      const cos = (h1x * h2x + h1z * h2z) / (l1 * l2);
      if (cos >= 0) continue;
      const cum = bake.cum[i];
      let near = '?';
      let gap = Infinity;
      for (const st of d.stops) {
        const g = Math.abs(st.s - cum);
        if (g < gap) { gap = g; near = `${st.name} ${cum > st.s ? '+' : '-'}${gap.toFixed(0)} m`; }
      }
      found.push({
        cum,
        deg: (Math.acos(cos < -1 ? -1 : cos) * 180) / Math.PI,
        legA: l1,
        legB: l2,
        near,
      });
    }
    return found;
  };
  const reversals = reversalsOn(dir);
  // The whole network, so the report says whether this is one bad direction or
  // the pathing. It is 22 directions of a few thousand vertices; it costs nothing.
  let networkReversals = 0;
  let networkDirs = 0;
  for (const l of bake.lines) {
    for (const d of l.dirs) {
      const n = reversalsOn(d).length;
      networkReversals += n;
      if (n > 0) networkDirs++;
    }
  }
  say(
    `  the route doubles back on itself ${reversals.length} time(s) on this direction, ` +
      `${networkReversals} across all ${bake.lines.length * 2} directions (${networkDirs} of them affected)`,
  );
  for (const r of reversals) {
    say(`      ! ${r.deg.toFixed(0)} deg at ${r.cum.toFixed(0)} m, legs ${r.legA.toFixed(0)}/${r.legB.toFixed(0)} m -- near ${r.near}`);
  }

  // One second into the dwell, which is where `dwellStand` wants to be asked and
  // is a second a real boarder has in hand.
  const boardAt = Math.max(dwell.opensAt + 1, askedAt);
  const place: Stand = { x: 0, y: 0, z: 0, yaw: 0 };
  if (!dwellStand(bake, dwell, boardAt, place)) {
    say(`  ! the solved dwell at ${FROM_E2E} places nobody -- no carriage of trip ${dwell.trip} is on the platform`);
    process.exit(1);
  }

  // The world, whole. `loadWorld`'s default caps are the deployed ones and this
  // is deliberately not `loadWholeWorld`: a rider crossing the basin is exactly
  // the case the residency was written for, and a check that pinned every
  // hexagon resident would be checking a host nobody runs.
  const t0Load = Date.now();
  const shared = await loadWorld(
    process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname,
  );
  const sim = new Simulation(roomWorld(shared));
  say(`  world loaded in ${((Date.now() - t0Load) / 1000).toFixed(1)} s`);

  // The rail clock, driven at the tick rate. `Simulation.railNowMs` is the seam
  // and it has been there since the rail round; see the header for why nothing
  // networked can use it.
  let railMs = RAIL_EPOCH_MS + boardAt * 1000;
  sim.railNowMs = () => railMs;
  const tickClock = (): void => { railMs += 1000 / TICK_HZ; };

  const p = sim.join(0, null, 'E2E');
  // `placeAt` and not a hand-set position: it is the authority's own move, it
  // seeds the rewind ring, and it ends any ride the join spot left behind.
  sim.placeAt(p, place.x, place.y, place.z, place.yaw);
  p.input.yaw = place.yaw;

  // The residency, driven the way `Rooms.step` drives it -- before the tick, on
  // the union of where everybody is. One player, so one pair.
  const occupants: number[] = [0, 0];
  const pumpResidency = (): void => {
    occupants[0] = p.combat.body.position.x;
    occupants[1] = p.combat.body.position.z;
    shared.segments?.update(occupants);
  };

  const out: TickOutput = { tick: 0, events: [], snapshot: null };
  const stepOne = (): void => {
    pumpResidency();
    sim.step(out);
    tickClock();
  };

  // Press E. One tick with it down; the sim edges the level bit itself.
  p.input.mount = true;
  stepOne();
  p.input.mount = false;
  const a = p.combat.aboard;
  if (!isAboard(a)) {
    say(`  ! FAILED: E on the platform at ${FROM_E2E} did not board anything`);
    process.exit(1);
  }
  const boardedCar = a.car;
  const consist = consistOf(dir, a.trip);
  say(`  boarded carriage ${boardedCar} of ${consist.cars.length} (${consist.cars[boardedCar].key})`);

  // --- The ride.
  const ann = createRailAnnouncement();
  const snap = createSnapshot();
  const wire: SnapshotAboard[] = [{ id: 1, line: 0, dir: 0, tripLow: 0, car: 0, x: 0, y: 0, z: 0 }];

  let ticks = 0;
  let notAboard = 0;
  let firstLost = -1;
  let carMoved = 0;
  let arcBackwards = 0;
  let worstBack = 0;
  let jumps = 0;
  let worstJump = 0;
  /** Of those, the ones the pre-flight already accounts for. See `atReversal`. */
  let jumpsAtReversal = 0;
  let outsideBox = 0;
  let worstOutside = 0;
  let wireBad = 0;
  let wireCarBad = 0;
  /**
   * The lowest the rider's health got, and where -- **(g), and it found one**.
   *
   * A sealed carriage with one passenger in it, no second player and no bot, has
   * nothing in it that can cost a pip. It cost one anyway: 3.0 down to 2.75 at
   * arc length 32,728 m, in four runs out of six and then in none, which is what
   * a bug that depends on the *wall* clock looks like from here -- the rail
   * clock is driven at the tick rate but the street factions still run on
   * `Date.now()`, so whether an actor is standing beside that piece of railway
   * is a property of the minute the check was started in.
   *
   * It was an NPC on the ground reaching through the side of the train. See the
   * `isAboard` guard at the top of `Simulation.shoot`, which is the fix and
   * which also says what is *not* fixed. The counter stays, and it is a gate
   * rather than a report, because the same defect can now only come back
   * through a door somebody adds.
   */
  let minHealth = p.combat.health;
  let minHealthAt = -1;
  let minHealthS = 0;
  let lastS = -Infinity;
  let lastX = p.combat.body.position.x;
  let lastZ = p.combat.body.position.z;
  /**
   * Which `dir.stops` index the doors were last open at, so a dwell counts once.
   *
   * Seeded with the station being boarded at rather than with -1, and the same
   * for the PA below. The rider gets on one second into a fifteen-second dwell,
   * so on the first tick of the ride the doors at `FROM_E2E` are still open and
   * its own approach announcement is still two seconds from finishing. Counting
   * either would put the station you are standing on into the list of stations
   * you travelled to.
   */
  let dwellingAt = callToStop(dir, fromCall);
  const called: string[] = [];
  /** The `dir.arrivals` index the PA was last naming, so a clip counts once. */
  let announcing = fromCall;
  const announced: number[] = [];
  let arrived = false;
  let endedBy = 'the tick budget ran out';

  // A tick a second of timetable at 60 Hz, plus a minute of slack. The budget is
  // the trip's own remaining duration and not a constant, so pointing this at a
  // Metro shuttle does not sit through an hour of nothing.
  const budget = Math.ceil((dir.duration - dir.arrivals[fromCall] + 60) * TICK_HZ);
  const wallFrom = Date.now();
  for (; ticks < budget; ticks++) {
    stepOne();

    // (a) aboard, every tick.
    if (!isAboard(a)) {
      notAboard++;
      if (firstLost < 0) firstLost = ticks;
      endedBy = `the ride ended under the rider at tick ${ticks}`;
      break;
    }
    // (b) the carriage they sat down in.
    if (a.car !== boardedCar) carMoved++;
    if (p.combat.health < minHealth) {
      minHealth = p.combat.health;
      minHealthAt = ticks;
      minHealthS = aboardPose(bake, a, railSeconds(railMs))!.s;
    }

    const pose = aboardPose(bake, a, railSeconds(railMs))!;

    // (c) forwards, and inside the box.
    if (pose.s < lastS - 1e-6) {
      arcBackwards++;
      const back = lastS - pose.s;
      if (back > worstBack) worstBack = back;
    }
    lastS = pose.s;
    const step = Math.hypot(p.combat.body.position.x - lastX, p.combat.body.position.z - lastZ);
    // The express cruise is 66.6 m/s -- `bake.physics.vExpress`, deliberately
    // 1.5x TRAINS.md's plan number so a train beats a 3x bike, see
    // `rail.V_EXPRESS` -- which is 1.11 m in a tick; a rider adds their own walk
    // on top. Two metres is a teleport by any reading and nothing legitimate
    // reaches it.
    if (ticks > 0 && step > 2) {
      jumps++;
      if (step > worstJump) worstJump = step;
      // **Attributed rather than merely counted.** A swing within a consist
      // length of a place the route reverses is the pre-flight's finding
      // happening, not a second bug; one anywhere else would be a new one, and
      // the two must not be summed into a number that hides which.
      if (reversals.some((r) => Math.abs(r.cum - pose.s) < 2 * consist.pitch * consist.cars.length)) {
        jumpsAtReversal++;
      }
    }
    lastX = p.combat.body.position.x;
    lastZ = p.combat.body.position.z;
    const it = interiorOfCar(consistOf(dir, a.trip), a.car);
    if (it !== null) {
      const floor = carriageFloor(it, a.x, a.z, a.y - EYE_HEIGHT);
      const outBy = Math.max(
        it.xMin - a.x, a.x - it.xMax, Math.abs(a.z) - it.halfWidth,
        Math.abs((a.y - EYE_HEIGHT) - floor) - 0.5, 0,
      );
      if (outBy > 0) {
        outsideBox++;
        if (outBy > worstOutside) worstOutside = outBy;
      }
    }

    // (d) the stations, each counted once per dwell.
    if (pose.doorsOpen && pose.atStop >= 0) {
      if (pose.atStop !== dwellingAt) {
        dwellingAt = pose.atStop;
        called.push(dir.stops[pose.atStop].name);
        if (dir.stops[pose.atStop].name === TO_E2E) {
          arrived = true;
          endedBy = `arrived at ${TO_E2E}`;
        }
      }
    } else {
      dwellingAt = -1;
    }

    // (e) the PA, the same way -- one entry per clip rather than per tick.
    if (announcementAt(bake, dir, pose.age, ANNOUNCE_ARRIVE, ann)) {
      if (ann.call !== announcing) {
        announcing = ann.call;
        announced.push(ann.call);
      }
    } else {
      announcing = -1;
    }

    // (f) the wire, every tick, exactly as section 0 does it.
    wire[0].line = a.line;
    wire[0].dir = a.dir;
    wire[0].tripLow = a.trip & 0xff;
    wire[0].car = a.car;
    wire[0].x = a.x;
    wire[0].y = a.y;
    wire[0].z = a.z;
    const back = decodeSnapshot(encodeSnapshot(ticks, 0, [], [], [], wire), snap);
    const rec = back?.aboard[0];
    if (!rec || rec.car !== a.car) wireCarBad++;
    else if (
      Math.abs(rec.x - quantiseAlong(a.x) * ABOARD_STEP_M) > 1e-9 ||
      Math.abs(rec.y - quantiseRise(a.y) * ABOARD_STEP_M) > 1e-9 ||
      Math.abs(rec.z - quantiseAcross(a.z) * ABOARD_STEP_M) > 1e-9
    ) wireBad++;

    if (arrived) break;
  }
  const wallS = (Date.now() - wallFrom) / 1000;

  // --- Off, at the far end.
  const alightFrom = { x: p.combat.body.position.x, z: p.combat.body.position.z };
  const alightS = lastS;
  let landed = { onGround: false, feet: 0, surface: -Infinity, health: p.combat.health };
  if (isAboard(a)) {
    p.input.mount = true;
    stepOne();
    p.input.mount = false;
    // Half a second of physics on whatever they were put on: a body placed on a
    // platform stays on it, and a body placed a metre above one falls onto it.
    for (let i = 0; i < 30; i++) stepOne();
    landed = {
      onGround: p.combat.body.onGround,
      feet: p.combat.body.position.y - EYE_HEIGHT,
      surface: shared.platforms?.surfaceAt(p.combat.body.position.x, p.combat.body.position.z) ?? -Infinity,
      health: p.combat.health,
    };
  }

  // --- What happened.
  const missed = wanted.filter((s) => !called.includes(s.name));
  const orderOk = (() => {
    let i = 0;
    for (const name of called) {
      while (i < wanted.length && wanted[i].name !== name) i++;
      if (i >= wanted.length) return false;
      i++;
    }
    return true;
  })();
  const wantedCalls = wanted.map((s) => calling.findIndex((c) => c === s));
  const missedPA = wantedCalls.filter((c) => !announced.includes(c));
  const paTwice = announced.filter((c, i) => announced.indexOf(c) !== i);
  const terminusGap = Math.abs(alightS - calling[toCall].s);

  say(`  rode ${ticks} ticks (${(ticks / TICK_HZ / 60).toFixed(1)} min of timetable) in ${wallS.toFixed(1)} s of wall clock -- ${endedBy}`);
  say(`  (a) aboard on ${ticks - notAboard}/${ticks} ticks${firstLost >= 0 ? `, first lost at tick ${firstLost}` : ''}`);
  say(`  (b) carriage ${boardedCar} throughout: ${carMoved === 0 ? 'yes' : `NO, moved on ${carMoved} tick(s)`}`);
  say(
    `  (c) arc length went backwards ${arcBackwards} tick(s) (worst ${worstBack.toFixed(3)} m), ` +
      `outside the carriage box ${outsideBox} tick(s) (worst ${worstOutside.toFixed(3)} m)`,
  );
  say(
    `      world jumps over 2 m: ${jumps} (worst ${worstJump.toFixed(2)} m), of which ` +
      `${jumpsAtReversal} are the route doubling back and ${jumps - jumpsAtReversal} are not`,
  );
  say(`  (d) called at ${called.length} of ${wanted.length} stations, in order: ${orderOk ? 'yes' : 'NO'}`);
  if (missed.length > 0) say(`      ! never called at: ${missed.map((s) => s.name).join(', ')}`);
  say(`      ${called.join(' -> ')}`);
  say(`  (e) the PA named ${announced.length} approaches; missed ${missedPA.length}, repeated ${paTwice.length}`);
  if (missedPA.length > 0) {
    say(`      ! never announced: ${missedPA.map((c) => calling[c].name).join(', ')}`);
  }
  say(`  (f) the wire round-tripped the rider on ${ticks - wireCarBad - wireBad}/${ticks} ticks (${wireCarBad} wrong carriage, ${wireBad} outside the quantiser)`);
  say(
    minHealthAt < 0
      ? `  (g) nothing reached the rider through the side of the train: health ${p.combat.health.toFixed(1)} the whole way`
      : `  (g) ! something hurt the rider aboard: down to ${minHealth.toFixed(2)} at tick ${minHealthAt}, ` +
        `arc length ${minHealthS.toFixed(0)} m -- see the note on this counter`,
  );
  say(
    `  off at ${TO_E2E}: ${terminusGap.toFixed(1)} m from the platform's own arc length, ` +
      `moved ${(Math.hypot(p.combat.body.position.x - alightFrom.x, p.combat.body.position.z - alightFrom.z)).toFixed(1)} m getting out`,
  );
  say(
    `  landed: onGround ${landed.onGround}, feet at ${landed.feet.toFixed(2)} m, platform under them at ` +
      `${landed.surface === -Infinity ? 'nothing' : `${landed.surface.toFixed(2)} m`}, health ${landed.health.toFixed(1)}`,
  );
  if (shared.segments !== undefined) {
    const st = shared.segments.stats();
    say(
      `  residency at the end: ${st.resident}/${st.hexes} hexagons of collision resident, ` +
        `${st.loads} load(s) and ${st.evictions} eviction(s) over the run, ` +
        `${(st.bytes / 1e6).toFixed(0)} MB of ${(st.capBytes / 1e6).toFixed(0)} MB`,
    );
  }

  // --- The one edge case the brief named: still aboard when the trip ends.
  //
  // A trip is a pure function of `(dir, trip, t)` and it stops being one the
  // instant `t` passes `dir.duration` -- `poseTrain` returns false, `rideEnter`
  // says `RIDE_TRIP_GONE`, and `sim.strandRider` is the whole of the answer. It
  // is the one way a ride ends that nobody asked for, and the passenger who fell
  // asleep is exactly the passenger this section is about, so it is checked here
  // rather than left to the argument in `strandRider`'s header.
  //
  // Cheap, because it reuses the world and the `Simulation` that are already
  // built: board at the last station before the buffers, stay on, and see where
  // the far end puts you.
  const terminus = calling[calling.length - 1].name;
  const beforeIt = calling[calling.length - 2].name;
  let terminusOk = false;
  let terminusWhy = '';
  {
    const d2 = nextDwell(bake, beforeIt, railSeconds(railMs), {
      lineId: dwell.lineId, then: terminus,
    });
    const place2: Stand = { x: 0, y: 0, z: 0, yaw: 0 };
    if (d2 === null) {
      terminusWhy = `no ${dwell.lineId} service calls at ${beforeIt} and then at ${terminus}`;
    } else if (!dwellStand(bake, d2, Math.max(d2.opensAt + 1, railSeconds(railMs)), place2)) {
      terminusWhy = `the dwell at ${beforeIt} places nobody`;
    } else {
      railMs = RAIL_EPOCH_MS + Math.max(d2.opensAt + 1, railSeconds(railMs)) * 1000;
      sim.placeAt(p, place2.x, place2.y, place2.z, place2.yaw);
      p.input.yaw = place2.yaw;
      p.input.mount = true;
      stepOne();
      p.input.mount = false;
      if (!isAboard(a)) {
        terminusWhy = `E on the platform at ${beforeIt} did not board anything`;
      } else {
        const d2dir = dirOf(bake, d2.line, d2.dir)!;
        // Past the buffers: the remaining run plus half a minute, and **no `E`
        // is ever pressed**. The ride has to end on its own.
        const past = Math.ceil((d2dir.duration - d2dir.arrivals[calling.length - 2] + 30) * TICK_HZ);
        let n = 0;
        for (; n < past && isAboard(a); n++) stepOne();
        for (let i = 0; i < 30; i++) stepOne();
        const feet = p.combat.body.position.y - EYE_HEIGHT;
        const surface = shared.platforms?.surfaceAt(
          p.combat.body.position.x, p.combat.body.position.z,
        ) ?? -Infinity;
        const site = bake.stations.find((s) => s.name === terminus);
        const fromSite = site === undefined
          ? Infinity
          : Math.hypot(p.combat.body.position.x - site.siteX, p.combat.body.position.z - site.siteZ);
        terminusOk = !isAboard(a) && p.combat.body.onGround && surface > -Infinity && fromSite < 200;
        terminusWhy =
          `rode ${(n / TICK_HZ / 60).toFixed(1)} min past ${beforeIt} and the trip ended under them; ` +
          `left standing ${fromSite.toFixed(0)} m from ${terminus}, feet at ${feet.toFixed(2)} m, ` +
          `platform under them at ${surface === -Infinity ? 'nothing' : `${surface.toFixed(2)} m`}, ` +
          `onGround ${p.combat.body.onGround}`;
      }
    }
  }
  say(`  the terminus: ${terminusOk ? '' : '! '}${terminusWhy}`);

  // --- The verdict, in two halves, because they are two different owners.
  //
  // **The journey** is everything the rider does and everything the two ends
  // agree about: it is this file's and `game/riding.ts`'s, and it is what the
  // owner asked for by name. **The route** is the shape of the railway under it,
  // which is `pipeline/sydney/rail.py`'s and cannot be corrected on this side of
  // the bake -- see the pre-flight. Summing the two into one boolean would mean
  // a pathing fix in the pipeline showing up as a riding fix here, and a real
  // riding regression hiding behind a known pathing defect.
  const journeyOk =
    arrived && notAboard === 0 && carMoved === 0 && arcBackwards === 0 &&
    outsideBox === 0 && missed.length === 0 && orderOk && missedPA.length === 0 &&
    paTwice.length === 0 && wireCarBad === 0 && wireBad === 0 &&
    jumps - jumpsAtReversal === 0 && terminusOk && minHealthAt < 0 &&
    terminusGap < consist.pitch && landed.onGround && landed.surface > -Infinity;
  const routeOk = reversals.length === 0;
  say(`  the journey ${FROM_E2E} -> ${TO_E2E}: ${journeyOk ? 'PASS' : 'FAILED'}`);
  say(
    `  the route it rides on: ${routeOk ? 'PASS' : `FAILED -- ${reversals.length} reversal(s) on this ` +
      `direction and ${networkReversals} across the network. The service polylines are pathed with no ` +
      `straight-ahead gate; STATIONS.md's CHAIN_STRAIGHT_COS is the precedent and it guards the terrain ` +
      `carve only. Fixing it is a pipeline round and a world republish.`}`,
  );
  const e2eOk = journeyOk && routeOk;
  if ((process.env.RIDE_E2E ?? 'on') === 'only') process.exit(e2eOk ? 0 : 1);
  if (!e2eOk) offlineFailed = true;
}

/** The city, as far as a headless pilot needs one: flat, and never consulted aboard. */
let lastGround = -55;
const city: CombatWorld = {
  collision: null as never,
  groundHeight: (): number => lastGround,
  waterSurface: (): number => -1e9,
};

class Pilot {
  readonly net: NetClient;
  readonly combat = createCombatant(0, 0, 0);
  readonly frame = createCarFrame();
  readonly stand = createCarriageStand();
  readonly offer = createBoardOffer();
  readonly input = {
    forward: 0, right: 0, jump: false, sprint: false,
    yaw: 0, pitch: 0, speedScale: 1, jumpScale: 1,
    punch: false, throwBall: false, mount: false,
  };
  readonly correction = this.combat.body.velocity.clone();
  rideEnded = 0;
  worstGap = 0;
  worstGapAt = '';
  worstCorrection = 0;
  corrections0 = 0;

  constructor(readonly name: string) {
    this.net = new NetClient(URL_, {
      onHit: () => {}, onSwat: () => {}, onBounce: () => {}, onPickup: () => {}, onJoin: () => {},
      onLeave: () => {}, onDrop: () => {}, onStatus: () => {},
    }, { name });
    this.net.setRail(bake);
  }

  get aboard(): boolean { return isAboard(this.combat.aboard); }
  get pos() { return this.combat.body.position; }

  /** The server's own last word about this body, straight off the decoded snapshot. */
  serverSelf(): { x: number; y: number; z: number } | null {
    const held = (this.net as unknown as {
      snapshots: Array<{ players: Array<{ id: number; x: number; y: number; z: number }> }>;
    }).snapshots;
    const newest = held.length > 0 ? held[held.length - 1] : null;
    return newest?.players.find((p) => p.id === this.net.id) ?? null;
  }

  serverAboard(): { id: number; line: number; dir: number; car: number; x: number; y: number; z: number } | null {
    const held = (this.net as unknown as {
      snapshots: Array<{ aboard: Array<{ id: number; line: number; dir: number; car: number; x: number; y: number; z: number }> }>;
    }).snapshots;
    const newest = held.length > 0 ? held[held.length - 1] : null;
    return newest?.aboard.find((a) => a.id === this.net.id) ?? null;
  }

  step(judge: boolean): void {
    this.net.reconcile(this.combat, city, this.correction);
    const c = Math.hypot(this.correction.x, this.correction.y, this.correction.z);
    if (judge && c > this.worstCorrection) this.worstCorrection = c;

    let world: CombatWorld = city;
    if (this.aboard) {
      const got = rideEnter(bake, this.combat.aboard, this.combat.body, railSeconds(Date.now()), this.frame, this.stand);
      if (got === RIDE_ON) world = this.stand as unknown as CombatWorld;
      else { this.rideEnded++; clearAboard(this.combat.aboard); }
    } else {
      lastGround = this.pos.y - EYE_HEIGHT;
    }
    advance(this.combat, this.input, FIXED_DT, world);
    // `rideExit` rather than `exitLocal`, which is the browser's own line and the
    // server's: the crossing between two Metro carriages happens here, inside the
    // step, before the composition. The yaw delta goes on `input.yaw` because
    // while aboard that field *is* the rider's carriage-local heading, exactly as
    // it is in `main.ts` -- see `riding.crossGangway`.
    if (world !== city) {
      this.input.yaw += rideExit(
        bake, this.combat.aboard, this.combat.body, railSeconds(Date.now()), this.frame,
      );
    }
    this.net.sendInput(this.input, this.combat.body.velocity);
    this.net.update(FIXED_DT);

    if (judge) {
      const s = this.serverSelf();
      if (s) {
        const g = Math.hypot(this.pos.x - s.x, this.pos.y - s.y, this.pos.z - s.z);
        if (g > this.worstGap) {
          this.worstGap = g;
          // Split along the railway and across it. A gap that is purely ALONG
          // the track is the snapshot being one interval old at 44 m/s -- an
          // artefact of what this script can see, since a real client never
          // compares itself to a stale snapshot. A gap ACROSS the track is a
          // genuine disagreement about where in the carriage this body is.
          const pose = isAboard(this.combat.aboard)
            ? aboardPose(bake, this.combat.aboard, railSeconds(Date.now()))
            : null;
          const dx = this.pos.x - s.x;
          const dz = this.pos.z - s.z;
          const along = pose ? Math.abs(dx * pose.dx + dz * pose.dz) : NaN;
          const across = pose ? Math.abs(dx * -pose.dz + dz * pose.dx) : NaN;
          const speed = pose ? pose.speed : 0;
          this.worstGapAt =
            `${((Date.now() - judgeFrom) / 1000).toFixed(1)} s in, ` +
            `${this.aboard ? 'aboard' : 'NOT aboard'}; ` +
            `${along.toFixed(2)} m along the track and ${across.toFixed(2)} m across it, ` +
            `at ${(speed * 3.6).toFixed(0)} km/h -- the along-track part is ` +
            `${speed > 1 ? ((along / speed) * 1000).toFixed(0) : '?'} ms of train`;
        }
      }
    }
  }

  board(): boolean {
    if (!boardHere(bake, this.combat.aboard, this.combat.body, railSeconds(Date.now()), this.frame, this.offer, EYE_HEIGHT)) {
      return false;
    }
    this.net.predictedAboardChange();
    return true;
  }
}

const until = async (want: () => boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (want()) return true; await Bun.sleep(20); }
  return want();
};

const rider = new Pilot('acc-rider');
const watcher = new Pilot('acc-watch');
const pilots = [rider, watcher];

let judging = false;
let judgeFrom = Date.now();
let running = true;
const loop = (async (): Promise<void> => {
  let next = Date.now();
  while (running) {
    next += 1000 / TICK_HZ;
    for (const p of pilots) if (p.net.status === 'online') p.step(judging);
    const slack = next - Date.now();
    if (slack > 0) await Bun.sleep(slack);
    else next = Date.now();
  }
})();

const ok = await until(() => pilots.every((p) => p.net.status === 'online'), 15000);
if (!ok) { say(`FAILED to connect to ${URL_}: ${pilots.map((p) => p.net.status).join(', ')}`); process.exit(1); }
say(`connected to ${URL_}: rider id ${rider.net.id}, watcher id ${watcher.net.id}`);

// --- 1. Ask the SERVER to put us on the platform.
const before = { x: rider.pos.x, z: rider.pos.z };
rider.net.armTeleport();
rider.net.sendChat(`/platform ${FROM}`);
watcher.net.armTeleport();
await Bun.sleep(150);
watcher.net.sendChat(`/platform ${FROM}`);
const moved = await until(() => Math.hypot(rider.pos.x - before.x, rider.pos.z - before.z) > 20, 8000);
say(moved
  ? `/platform moved the rider to (${rider.pos.x.toFixed(1)}, ${rider.pos.z.toFixed(1)}) -- the server placed us`
  : 'FAILED: /platform did not move us');
if (!moved) process.exit(1);

// --- 2. Wait for the doors, solved rather than polled.
const dwell = nextDwell(bake, FROM, railSeconds(Date.now()), {});
if (!dwell) { say(`no service calls at ${FROM}`); process.exit(1); }
const wait = dwell.opensAt - railSeconds(Date.now());
say(`${dwell.lineId} to ${dwell.towards}: doors open in ${wait.toFixed(1)} s`);
await Bun.sleep(Math.max(0, wait + 2) * 1000);

// --- 3. Board, both of them, and check the SERVER agrees.
const got = rider.board();
rider.input.mount = true;
watcher.input.mount = true;
say(`the rider's own findBoarding: ${got ? `carriage ${rider.offer.car}, bay ${rider.offer.bay}` : 'REFUSED'}`);
await Bun.sleep(120);
rider.input.mount = false;
watcher.input.mount = false;

const agreed = await until(() => rider.serverAboard() !== null, 3000);
say(agreed
  ? `the SERVER put the rider aboard: its snapshot carries the aboard section for id ${rider.net.id}`
  : 'FAILED: the server never put the rider aboard');
if (!agreed) process.exit(1);
const watchAboard = watcher.serverAboard() !== null;
say(`the watcher (which predicted nothing, only pressed the button) is aboard: ${watchAboard}`);

// --- 4. Ride. Judged from three seconds after the server confirmed the
//     boarding, so the transition itself -- which is a real correction, and is
//     supposed to be -- is not counted as riding.
await Bun.sleep(3000);
judgeFrom = Date.now();
judging = true;
const startPos = { x: rider.pos.x, z: rider.pos.z };
const rideFor = Number(process.env.RIDE_S ?? 100);
let insideChecks = 0;
let insideHits = 0;
let worstOut = 0;
let lostServer = 0;
const wf = createCarFrame();
const scratch = { x: 0, y: 0, z: 0 };
const t0 = Date.now();
while (Date.now() - t0 < rideFor * 1000) {
  await Bun.sleep(250);
  if (rider.serverAboard() === null) { lostServer++; continue; }
  // What the SECOND client draws for the rider, pushed back into the carriage.
  const remote = watcher.net.remotes.get(rider.net.id);
  const a = rider.combat.aboard;
  if (remote && isAboard(a)) {
    const dir = dirOf(bake, a.line, a.dir);
    const it = dir === null ? null : interiorOfCar(consistOf(dir, a.trip), a.car);
    if (it && aboardFrame(bake, a, railSeconds(Date.now()), wf)) {
      worldToLocal(wf, remote.position.x, remote.position.y, remote.position.z, scratch);
      insideChecks++;
      const out = Math.max(it.xMin - scratch.x, scratch.x - it.xMax, Math.abs(scratch.z) - it.halfWidth, 0);
      if (out > worstOut) worstOut = out;
      if (out < 0.6) insideHits++;
    }
  }
}
const travelled = Math.hypot(rider.pos.x - startPos.x, rider.pos.z - startPos.z);
say(`rode ${rideFor} s and moved ${travelled.toFixed(0)} m; the ride ended under the client ${rider.rideEnded} time(s)`);
say(`worst client-vs-server world position gap: ${rider.worstGap.toFixed(3)} m (${rider.worstGapAt})`);
say(`worst eased camera correction: ${rider.worstCorrection.toFixed(4)} m; corrections ${rider.net.corrections}, snaps ${rider.net.snaps}`);
say(`the second client drew the rider inside the carriage on ${insideHits}/${insideChecks} samples (worst ${worstOut.toFixed(2)} m outside the box)`);
say(`snapshots in which the server said "not aboard": ${lostServer}`);

// --- 5. And a swing, aboard, at line speed.
if (watcher.serverAboard() !== null && rider.serverAboard() !== null) {
  const before = rider.combat.health;
  const w = watcher.combat.aboard;
  const r = rider.combat.aboard;
  watcher.input.yaw = Math.atan2(-(r.x - w.x), -(r.z - w.z));
  watcher.input.punch = true;
  await Bun.sleep(60);
  watcher.input.punch = false;
  await Bun.sleep(1200);
  say(`bat aboard: the rider's health went ${before.toFixed(1)} -> ${rider.combat.health.toFixed(1)} ` +
    `(${(Math.hypot(r.x - w.x, r.z - w.z)).toFixed(2)} m apart in the carriage)`);
}

// --- 6. Off.
judging = false;
clearAboard(rider.combat.aboard);
rider.net.predictedAboardChange();
rider.input.mount = true;
clearAboard(watcher.combat.aboard);
watcher.net.predictedAboardChange();
watcher.input.mount = true;
await Bun.sleep(150);
rider.input.mount = false;
watcher.input.mount = false;
await Bun.sleep(1500);
const off = rider.serverAboard() === null;
const s = rider.serverSelf();
say(`E got the rider off: server aboard = ${!off ? 'STILL ABOARD' : 'no'}; ` +
  `client at (${rider.pos.x.toFixed(1)}, ${rider.pos.z.toFixed(1)}), server at ` +
  `(${s?.x.toFixed(1)}, ${s?.z.toFixed(1)}), ` +
  `${s ? Math.hypot(rider.pos.x - s.x, rider.pos.z - s.z).toFixed(2) : '?'} m apart, ` +
  `onGround ${rider.combat.body.onGround}`);

running = false;
await loop;
for (const p of pilots) p.net.close();
process.exit(offlineFailed ? 1 : 0);
