/**
 * The underground stations, walked: from the street to the platform, on the
 * server's own ground, for every bore station a service calls at.
 *
 * ---------------------------------------------------------------------------
 * Reported, in these words: *"cant reliably find entry, i just fall into the
 * ground if i run over it, no space to navigate underground"* and *"the
 * entrance to stations is impassible and also not really drawn properly"*.
 * Every one of those is a ground answer, and a ground answer can be asked
 * without a browser. This asks it the way a body would: stand on the street
 * two metres outside the mouth `game/riding.stationAccessPlan` chose, walk
 * down the incline and along the tunnel a quarter-metre at a time with the
 * feet following `groundFor(world).groundHeight`, and then cross the room
 * from wall to wall. A step over `STEP_HEIGHT` is a wall; a drop over three
 * metres is a hole; arriving anywhere but the concourse is the incline and
 * the room disagreeing. The street over the room is asked too, from above,
 * because that is the fall-in.
 *
 * The first run of this, before the fixes it gated, walked 1 station of 28.
 * The failures it named, in the order they were fixed: OSM entrances inside
 * tower footprints (`stationAccessPlan` now nudges a mouth clear of every
 * building over the pad and the head of the incline); a trench carved
 * through the CBD over untagged bores (`rail.SPAN_DEEP`, measured from the
 * clearance the pipeline already wrote); a room floor 1.45 m below the
 * platforms (`RailStation.concourseY`, the highest calling platform); a lid
 * five metres above York Street (`riding.roomCeilY`); an incline pad that
 * climbed 1.25 m over the pavement (`StationBox.riseMax`); a room that
 * caught every body walking over it (`floorAt`'s ground rule); and a field
 * the server built before the buildings landed (`world.boxesOf`).
 *
 * Run: `bun run server/underground-check.ts` (loads the world; ~90 s). Exit
 * 1 if any station fails. `SYDNEY_UG_TRACE=<station>` prints the walk.
 */
import { loadWorld, groundFor, accessWorldOf } from './world.ts';
import { stationAccessPlan, roomCeilY, concourseY } from '../client/src/game/riding.ts';
import { heightAlong } from '../client/src/game/rail.ts';
import { pointInPolygon, type Prism } from '../client/src/player/collision.ts';
import { STEP_HEIGHT } from '../client/src/player/controller.ts';

const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
const world = await loadWorld(root);
const g = groundFor(world);
// A first ask refreshes the field over every tile the boot loaded.
g.groundHeight(0, 0, 0);
const aw = accessWorldOf(world);
const bake = world.rail;
if (!bake) {
  console.log('no rail bake; nothing to walk');
  process.exit(0);
}
let pass = 0;
const rows: string[] = [];
const scratch: Prism[] = [];
for (const st of bake.stations) {
  const plan = stationAccessPlan(st, aw);
  if (!plan) continue;
  const probs: string[] = [];
  const notes: string[] = [];
  // 1. the street at the mouth is the height the plan says it is
  const streetY = g.groundHeight(plan.mouthX - plan.dirX * 2, plan.mouthZ - plan.dirZ * 2, Infinity);
  if (Math.abs(streetY - plan.mouthY) > 0.6) probs.push(`the street at the mouth is ${(streetY - plan.mouthY).toFixed(1)} m off the mouth height`);
  // 2. walk in: mouth -> foot -> tunnel -> room, feet following the ground
  let feet = streetY;
  let ok = true;
  let worstStep = 0;
  let fell = false;
  let intoBuilding = '';
  const walk = (x: number, z: number): void => {
    scratch.length = 0;
    world.collision.prismsWithin(x, z, 2, scratch);
    for (const q of scratch) {
      if (intoBuilding || q.structural || feet < q.base - 0.05 || feet + 1.7 <= q.base || !pointInPolygon(q.points, x, z)) continue;
      intoBuilding = `the way in walks into a building (base ${q.base.toFixed(1)}) at feet ${feet.toFixed(1)}`;
    }
    const y = g.groundHeight(x, z, feet);
    const dy = y - feet;
    if (dy < -3) fell = true;
    if (Math.abs(dy) > worstStep) worstStep = Math.abs(dy);
    if (dy > STEP_HEIGHT + 0.02) ok = false;
    if (process.env.SYDNEY_UG_TRACE === st.name) console.log(`   walk ${x.toFixed(1)},${z.toFixed(1)} -> ${y.toFixed(2)} (dy ${dy.toFixed(2)})`);
    feet = y;
  };
  for (let d = -2; d < plan.inclineM; d += 0.25) walk(plan.mouthX + plan.dirX * d, plan.mouthZ + plan.dirZ * d);
  for (let d = 0; d < plan.tunnelM + 3; d += 0.25) walk(plan.footX + plan.tunDirX * d, plan.footZ + plan.tunDirZ * d);
  if (intoBuilding) probs.push(intoBuilding);
  else if (!ok) probs.push(`a rise over the step height (${worstStep.toFixed(2)} m) on the way in`);
  if (fell) probs.push('a drop of more than 3 m on the way in');
  if (Math.abs(feet - plan.floorY) > 0.6) probs.push(`arrived at ${feet.toFixed(1)} m, the concourse is ${plan.floorY.toFixed(1)}`);
  // 3. across the room, wall to wall: the floor holds
  const px = -st.siteDz;
  const pz = st.siteDx;
  let roomFeet = feet;
  let roomWhy = '';
  for (let o = -st.boxHalfWidth + 1; o < st.boxHalfWidth - 1; o += 0.5) {
    const y = g.groundHeight(st.siteX + px * o, st.siteZ + pz * o, roomFeet);
    if (y === -Infinity || Math.abs(y - roomFeet) > STEP_HEIGHT + 0.02) {
      roomWhy = `the room floor does not hold at ${o.toFixed(0)} m across: ${y.toFixed(1)} from ${roomFeet.toFixed(1)}`;
      break;
    }
    roomFeet = y;
  }
  if (roomWhy) probs.push(roomWhy);
  // 4. the street over the station does not drop you in
  const over = g.groundHeight(st.siteX, st.siteZ, Infinity);
  const ceil = roomCeilY(st, aw);
  if (over < ceil - 1) probs.push(`the street over the station answers ${over.toFixed(1)} m, under the lid at ${ceil.toFixed(1)}`);
  const onStreet = g.groundHeight(st.siteX, st.siteZ, over);
  if (Math.abs(onStreet - over) > 0.05) probs.push(`a body on the street over the station is handed ${onStreet.toFixed(1)} m`);
  // 5. every calling platform's sill against the concourse: a note, not a failure
  const floor = concourseY(st);
  for (const line of bake.lines) {
    for (const dir of line.dirs) {
      for (const stop of dir.stops) {
        if (!stop.calls || stop.name !== st.name) continue;
        const sill = heightAlong(bake, dir, stop.s) + 1.05;
        if (floor - sill > 0.5) notes.push(`${line.name} ${dir.index} sill ${(floor - sill).toFixed(1)} m under the floor`);
      }
    }
  }
  const slope = (plan.mouthY - plan.floorY) / plan.inclineM;
  const head = `${probs.length ? 'FAIL' : 'ok  '} ${st.name.padEnd(22)} mouth ${Math.hypot(plan.mouthX - st.siteX, plan.mouthZ - st.siteZ).toFixed(0).padStart(3)} m off, incline ${plan.inclineM.toFixed(0)} m at 1:${(1 / slope).toFixed(1)}`;
  rows.push(head + (probs.length ? ' -- ' + probs.join('; ') : '') + (notes.length ? ' [' + notes.join('; ') + ']' : ''));
  if (!probs.length) pass++;
}
console.log(rows.join('\n'));
console.log(`${pass} of ${rows.length} underground stations walk from the street to the platform`);
process.exit(pass === rows.length ? 0 : 1);
