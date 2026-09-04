/**
 * Lights in the station rooms.
 *
 * The owner, the first time he walked into Wynyard's chamber rather than a
 * tunnel tube: *"also need some lights in the station haha its dark af"*. He
 * was right, and it is worth saying exactly why it was dark, because the two
 * halves of the answer live in two different files and this one only joins
 * them.
 *
 * A tunnel in this game is lit by nothing. Its lining is a near-black concrete
 * (`rail-geo.LINING`, albedo 0.085) and the lamps along its walls
 * (`world/tunnellights.ts`) are painted quads -- an additive batten, a head --
 * that *read* as light without casting any. That is the right trade for a
 * tube you pass through at 60 km/h: the eye wants the strobe of battens going
 * by, and the only surfaces a real light could reach are a metre away and
 * black. The three real lights this client owns (`world/nightlights.ts`: the
 * torch and the two `PointLight`s that follow the nearest street lamps) stay
 * on the street, and stay off in daylight.
 *
 * A station room is neither of those things. It is thirty metres wide, you
 * stand still in it, and you are trying to read which of four trains is yours.
 * Painted battens twelve metres apart on the bore wall do not light a room;
 * they mark where a tube used to be. And in daylight the two real lights are
 * off, because `nightLevel` is a function of the sun, and the sun is what a
 * station is under.
 *
 * So, three things, and this file is the table they share:
 *
 * 1. **Where the lamps are.** Two rows, one over each platform strip, at the
 *    strip's mid-line (`PLATFORM_INNER_M + PLATFORM_WIDTH_M / 2`) so the light
 *    lands on the kerb and the doorway of a stopped train rather than on the
 *    concourse between them. Eight metres apart -- a carriage is twenty, and
 *    two or three lamps along a car is what a platform looks like -- hung a
 *    third of a metre under the ceiling, and stopping six metres short of the
 *    end walls, where the kerbs stop too. `stationLampPositions` is that, and
 *    it is a pure function of the room box, so the two readers below cannot
 *    disagree about where a lamp is.
 *
 * 2. **The painted lamp**, so there is something to see hanging there:
 *    `tunnellights.buildTunnelLamps` takes the rooms and appends these
 *    positions with `side = 0`, a third template that hangs from a ceiling
 *    rather than a wall. Same mesh, same material, same refill.
 *
 * 3. **The real light.** `buildStationLampRecords` writes the same positions
 *    as `LampSource` records -- the four-float form `nightlights` reads,
 *    x, y, z and a sodium flag, here always 0 for the cool white of a
 *    fluorescent batten -- and `main.ts` composes them over the street's lamps
 *    with `giverlamp.lampsOver`, the same trick that put a light over the
 *    Ladmaster. The two `PointLight`s then pick the two nearest of *these*
 *    when a body is on a platform, because the street's poles are twenty
 *    metres up and forty away. And because the rig is a function of the sun,
 *    `main.ts` hands it `NIGHT_FULL_ALTITUDE` whenever `underground()` is
 *    true: under a station the sun has set, whatever the clock says. The sky
 *    shader keeps the real altitude; only the rig is told a lie, and it is a
 *    true one.
 *
 * Three-free, like everything the server imports through `riding.ts`, and
 * deterministic in the project's sense: arithmetic on the box, no `Math.sin`.
 * The one number this file cannot check is the record stride it promises
 * `nightlights` -- that file is three-bound -- so `verifyTunnelLights`, which
 * imports both, asserts the two constants agree.
 */

import { PLATFORM_INNER_M, PLATFORM_WIDTH_M } from '../game/riding.ts';

/** Along the platform, lamp to lamp. A carriage is 20 m; two or three per car. */
export const STATION_LAMP_PITCH = 8;
/** How far under the ceiling a lamp hangs. */
export const STATION_LAMP_DROP = 0.35;
/** The kerbs stop six metres short of the end walls (`rail-geo`, `L - 6`); so do the lamps. */
export const STATION_LAMP_END_M = 6;
/** The row's offset from the centreline: the middle of the platform strip. */
export const STATION_LAMP_ROW = PLATFORM_INNER_M + PLATFORM_WIDTH_M / 2;
/** Floats per lamp position: x, y, z, then the room's along direction. */
export const STATION_LAMP_FLOATS = 5;
/** Floats per `LampSource` record: x, y, z, sodium. Must equal `nightlights.LAMP_RECORD_STRIDE`. */
export const STATION_LAMP_RECORD_STRIDE = 4;

/** What a lamp needs of a room: `riding.StationBox`, or a check's stand-in. */
export interface LampRoom {
  name: string;
  x: number;
  z: number;
  ux: number;
  uz: number;
  halfLength: number;
  halfWidth: number;
  floorY: number;
  ceilY: number;
}

/**
 * Whether a box is a room. The field also holds each station's `access`
 * passage and `tunnel` link under suffixed names, and those are lit by nothing
 * here: the passage is a lining tube and reads as one.
 */
export function isLampRoom(name: string): boolean {
  return !name.endsWith(' access') && !name.endsWith(' tunnel');
}

/**
 * Whether a point is inside one of the rooms, in the room's own frame -- the
 * test `StationBoxField.roomAt` makes, restated here so `tunnellights` can ask
 * it of a plain room list. The tunnel lamps use it to stay out of the chamber:
 * `rail-geo.writeTunnel` already skips the tube's pieces inside a room, and a
 * batten on a wall that is not drawn is the owner's *"tunnel lights floating"*.
 */
export function insideLampRoom(rooms: readonly LampRoom[], x: number, z: number): boolean {
  for (const r of rooms) {
    const dx = x - r.x;
    const dz = z - r.z;
    const along = dx * r.ux + dz * r.uz;
    if (along < -r.halfLength || along > r.halfLength) continue;
    const across = dx * -r.uz + dz * r.ux;
    if (across < -r.halfWidth || across > r.halfWidth) continue;
    return true;
  }
  return false;
}

/** The rooms among a field's boxes, in the field's order. */
export function lampRooms<T extends LampRoom>(boxes: readonly T[]): T[] {
  return boxes.filter((b) => isLampRoom(b.name));
}

/**
 * Every lamp in one room: `STATION_LAMP_FLOATS` per lamp, the left row first,
 * each row from the room's near end to its far end.
 *
 * Empty for a room too short to hold a lamp inside its end margins or too
 * narrow to hold the row inside its walls -- neither exists in the bake, and
 * a lamp in a wall is worse than no lamp.
 */
export function stationLampPositions(room: LampRoom): Float32Array<ArrayBuffer> {
  const span = room.halfLength - STATION_LAMP_END_M;
  if (!(span >= 0) || !(room.halfWidth > STATION_LAMP_ROW)) return new Float32Array(0);
  const n = Math.floor(span / STATION_LAMP_PITCH);
  const perRow = 2 * n + 1;
  const out = new Float32Array(perRow * 2 * STATION_LAMP_FLOATS);
  const y = room.ceilY - STATION_LAMP_DROP;
  let w = 0;
  for (const side of [-1, 1]) {
    const across = STATION_LAMP_ROW * side;
    for (let k = -n; k <= n; k++) {
      const along = k * STATION_LAMP_PITCH;
      // The across unit is (-uz, ux): the same frame `StationBoxField.roomAt`
      // reads a body's position in, so a lamp at +ROW is over the same strip
      // the kerb at +PLATFORM_INNER_M is drawn on.
      out[w++] = room.x + room.ux * along - room.uz * across;
      out[w++] = y;
      out[w++] = room.z + room.uz * along + room.ux * across;
      out[w++] = room.ux;
      out[w++] = room.uz;
    }
  }
  return out;
}

/**
 * The same lamps as `LampSource` records for the night rig: x, y, z and a
 * sodium flag of 0, all rooms in one array. Rebuilt whenever the field is.
 */
export function buildStationLampRecords(rooms: readonly LampRoom[]): Float32Array<ArrayBuffer> {
  const parts: Float32Array<ArrayBuffer>[] = [];
  let lamps = 0;
  for (const room of rooms) {
    const p = stationLampPositions(room);
    parts.push(p);
    lamps += p.length / STATION_LAMP_FLOATS;
  }
  const out = new Float32Array(lamps * STATION_LAMP_RECORD_STRIDE);
  let w = 0;
  for (const p of parts) {
    for (let i = 0; i < p.length; i += STATION_LAMP_FLOATS) {
      out[w++] = p[i];
      out[w++] = p[i + 1];
      out[w++] = p[i + 2];
      out[w++] = 0;
    }
  }
  return out;
}

export function verifyStationLamps(): string[] {
  const failures: string[] = [];
  // The check's frame: a room rotated off the axes, so a lamp that ignored
  // (ux, uz) would land outside it.
  const room: LampRoom = {
    name: 'Wynyard', x: 100, z: -200, ux: 0.6, uz: 0.8,
    halfLength: 80, halfWidth: 16, floorY: -20, ceilY: -14,
  };
  const inRoom = (x: number, z: number): { along: number; across: number } => {
    const dx = x - room.x;
    const dz = z - room.z;
    return { along: dx * room.ux + dz * room.uz, across: dx * -room.uz + dz * room.ux };
  };

  // --- The row hangs over the platform strip, not the concourse or a track.
  if (!(STATION_LAMP_ROW > PLATFORM_INNER_M && STATION_LAMP_ROW < PLATFORM_INNER_M + PLATFORM_WIDTH_M)) {
    failures.push(`the lamp row at ${STATION_LAMP_ROW} m is not over the platform strip (${PLATFORM_INNER_M}-${PLATFORM_INNER_M + PLATFORM_WIDTH_M} m).`);
  }

  // --- Two rows at the pitch, inside the walls and the end margins, under the ceiling.
  {
    const p = stationLampPositions(room);
    const count = p.length / STATION_LAMP_FLOATS;
    const expectPerRow = 2 * Math.floor((room.halfLength - STATION_LAMP_END_M) / STATION_LAMP_PITCH) + 1;
    if (count !== 2 * expectPerRow) failures.push(`${count} lamps in a 160 m room; two rows of ${expectPerRow} expected.`);
    let lastAlong = -Infinity;
    for (let i = 0; i < p.length; i += STATION_LAMP_FLOATS) {
      const { along, across } = inRoom(p[i], p[i + 2]);
      const row = i / STATION_LAMP_FLOATS < expectPerRow ? -1 : 1;
      if (Math.abs(across - row * STATION_LAMP_ROW) > 1e-3) {
        failures.push(`lamp ${i / STATION_LAMP_FLOATS} sits ${across.toFixed(2)} m across; its row is at ${row * STATION_LAMP_ROW}.`);
        break;
      }
      if (Math.abs(along) > room.halfLength - STATION_LAMP_END_M + 1e-6) {
        failures.push(`lamp ${i / STATION_LAMP_FLOATS} at ${along.toFixed(1)} m along is inside the end margin.`);
        break;
      }
      if (!(p[i + 1] < room.ceilY && p[i + 1] > room.floorY + 2)) {
        failures.push(`lamp ${i / STATION_LAMP_FLOATS} hangs at ${p[i + 1]} in a room from ${room.floorY} to ${room.ceilY}.`);
        break;
      }
      if (i / STATION_LAMP_FLOATS !== 0 && i / STATION_LAMP_FLOATS !== expectPerRow) {
        if (Math.abs(along - lastAlong - STATION_LAMP_PITCH) > 1e-3) {
          failures.push(`lamps ${i / STATION_LAMP_FLOATS - 1} and ${i / STATION_LAMP_FLOATS} are ${(along - lastAlong).toFixed(2)} m apart; the pitch is ${STATION_LAMP_PITCH}.`);
          break;
        }
      }
      lastAlong = along;
      if (Math.abs(p[i + 3] - room.ux) > 1e-6 || Math.abs(p[i + 4] - room.uz) > 1e-6) {
        failures.push('a lamp does not carry the room\'s along direction.');
        break;
      }
    }
    const again = stationLampPositions(room);
    if (again.length !== p.length || again.some((v, i) => v !== p[i])) failures.push('stationLampPositions is not deterministic.');
  }

  // --- A room with no room for a lamp gets none, rather than one in a wall.
  {
    if (stationLampPositions({ ...room, halfWidth: STATION_LAMP_ROW - 0.1 }).length !== 0) {
      failures.push('a room narrower than the lamp row still got lamps.');
    }
    if (stationLampPositions({ ...room, halfLength: STATION_LAMP_END_M - 1 }).length !== 0) {
      failures.push('a room shorter than its end margins still got lamps.');
    }
    const one = stationLampPositions({ ...room, halfLength: STATION_LAMP_END_M + 1 });
    if (one.length !== 2 * STATION_LAMP_FLOATS) failures.push(`a room just long enough for one lamp a row got ${one.length / STATION_LAMP_FLOATS}.`);
  }

  // --- Inside is inside in the room's own frame, not the world's.
  {
    const mid = { x: room.x + room.ux * 70, z: room.z + room.uz * 70 };
    if (!insideLampRoom([room], mid.x, mid.z)) failures.push('a point 70 m along the room is not inside it.');
    if (insideLampRoom([room], room.x + room.ux * 90, room.z + room.uz * 90)) failures.push('a point 90 m along an 80 m half-length room is inside it.');
    if (insideLampRoom([room], room.x - room.uz * 17, room.z + room.ux * 17)) failures.push('a point 17 m across a 16 m half-width room is inside it.');
    if (insideLampRoom([], room.x, room.z)) failures.push('no rooms contain a point.');
  }

  // --- The passage and the link are not rooms; the records are the positions, white.
  {
    const boxes = [room, { ...room, name: 'Wynyard access' }, { ...room, name: 'Wynyard tunnel' }, { ...room, name: 'Town Hall' }];
    const rooms = lampRooms(boxes);
    if (rooms.length !== 2 || rooms[0].name !== 'Wynyard' || rooms[1].name !== 'Town Hall') {
      failures.push(`lampRooms kept [${rooms.map((r) => r.name).join(', ')}] of four boxes; the two rooms were expected.`);
    }
    const records = buildStationLampRecords(rooms);
    const positions = rooms.flatMap((r) => Array.from(stationLampPositions(r)));
    const lamps = positions.length / STATION_LAMP_FLOATS;
    if (records.length !== lamps * STATION_LAMP_RECORD_STRIDE) {
      failures.push(`${records.length} floats of records for ${lamps} lamps at a stride of ${STATION_LAMP_RECORD_STRIDE}.`);
    } else {
      for (let i = 0; i < lamps; i++) {
        const r = i * STATION_LAMP_RECORD_STRIDE;
        const p = i * STATION_LAMP_FLOATS;
        if (records[r] !== positions[p] || records[r + 1] !== positions[p + 1] || records[r + 2] !== positions[p + 2]) {
          failures.push(`record ${i} is not at its lamp.`);
          break;
        }
        if (records[r + 3] !== 0) {
          failures.push(`record ${i} is flagged sodium; a station batten is white.`);
          break;
        }
      }
    }
    if (buildStationLampRecords([]).length !== 0) failures.push('no rooms gave some records.');
  }

  return failures;
}
