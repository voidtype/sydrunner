/**
 * Lights on the tunnel wall, at a pitch chosen so that a train reads as fast.
 *
 * The report is one sentence -- *"put horizontal lights or smt in rail tunnels
 * to make it feel like movement"* -- and it is a report about **optic flow**,
 * not about brightness. Above ground a train at 240 km/h is obviously doing
 * 240 km/h, because the whole city is streaming past the window; the bore takes
 * all of that away at once. `rail-geo.writeTunnel` draws a ten-sided concrete
 * tube of exactly uniform cross-section, and a uniform tube swept along a
 * straight line produces a retinal image that **does not change with speed**.
 * There is no parallax in it, no texture gradient, nothing entering frame and
 * nothing leaving it. So the tunnel does not read as slow; it reads as *stopped*,
 * which is precisely the complaint.
 *
 * A row of lights at a known spacing puts the flow back, and it does it in the
 * one way that also carries the *magnitude*: the interval between two lights
 * passing the window is `pitch / speed`, so the ear and the eye between them
 * read a rate off the wall and the rate is the speedometer. Everything below is
 * about choosing that number.
 *
 * ---------------------------------------------------------------------------
 * 1. THE PITCH, WHICH IS THE WHOLE FEATURE, DONE AS ARITHMETIC.
 *
 * The brief that asked for this suggested 25 m and suspected it was too slow.
 * It is, and the bake says so louder than the brief did: `pipeline/sydney/
 * rail.py` raised the service to `V_LOCAL = 54.15` m/s (195 km/h) and
 * `V_EXPRESS = 66.6` m/s (240 km/h) -- half again on TRAINS.md's original 36 and
 * 44.4 -- and the tunnels are mostly the *express* half of the network, because
 * the City Circle, the ESR, the Airport line and every Metro bore are where the
 * long legs are. So the number to design against is 66.6 m/s, not 30.
 *
 *     pitch   lamps/s at 66.6   at 54.15   in a 600 m bore
 *      25 m        2.66           2.17           24
 *      18 m        3.70           3.01           33
 *   >> 12 m        5.55           4.51           50
 *       9 m        7.40           6.02           67
 *       6 m       11.10           9.03          100
 *
 * **12 m**, and the two ends of the table are what rule it in:
 *
 *   - Below about two events a second a repeating stimulus stops fusing into
 *     motion and reads as a sequence of separate objects going past -- which is
 *     the *slow* reading, and is what 25 m gives at line speed. It is also only
 *     24 lamps down a 600 m sight-line, and the receding chain converging on the
 *     vanishing point is doing at least as much work here as the flicker is: a
 *     row you can see fifty of is a road, a row you can see twenty of is a row.
 *   - Above about 8/s the individual lamps stop resolving at 60 Hz. At 66.6 m/s
 *     a frame is 1.11 m, so a 12 m pitch puts 10.8 frames between lamps and
 *     nothing aliases; a 6 m pitch halves that, and a 4 m pitch would put the
 *     lamp train and the frame rate close enough to beat against each other.
 *
 * **And they alternate walls**, which is not decoration. One wall at 12 m would
 * pulse the *same place in the frame* 5.55 times a second for the length of a
 * ride, and 5.55 Hz is inside the band general flashing-content guidance asks
 * you to stay under. Alternating puts 24 m between two lamps on either given
 * wall -- 2.78 Hz at express, 2.26 at stopping-pattern speed, both under three --
 * while the *combined* rate the player experiences is still 5.55. It also looks
 * better: two rows converging on the vanishing point from opposite sides say
 * "tube" where one row says "wall".
 *
 * Walking pace, for completeness, because a player who jumps out mid-tunnel is
 * relocated but not instantly: 5 m/s is 0.42 lamps a second, which is a lit
 * tunnel and not a disco.
 *
 * ---------------------------------------------------------------------------
 * 2. WHERE THEY GO: `drawnAsTunnel`, AND NOTHING ELSE.
 *
 * The brief named `SPAN_TUNNEL` **and** `SPAN_SUBWAY`. Only the first is right,
 * and the bake is what settles it: 207.9 km of the network carries one flag or
 * the other and only 164.1 km carries `SPAN_TUNNEL`, so reading both would hang
 * 43.8 km of tunnel lighting in the open air -- most of it along the Metro
 * viaduct out past Rouse Hill, which is `railway=subway` all the way and is up on
 * concrete legs in the sun. `rail-cut.ts` has already had this exact argument
 * once, in writing, and lost 70 spans of the open cutting at Sydenham to it.
 *
 * So the predicate is **imported** rather than restated: `drawnAsTunnel(flags)`
 * is the same function `rail-geo` asks before it calls `writeTunnel`, so a lamp
 * exists on precisely the spans that have a wall to hang it on. Two copies of
 * that rule is the shape of a bug where a light hangs in a paddock.
 *
 * ---------------------------------------------------------------------------
 * 3. ONE LIT BORE PER RAIL, NOT ONE PER SERVICE.
 *
 * `rail-geo.ts` section 2 is the reason this file cannot simply walk the twenty
 * polylines: T1 down and T1 up are the same rails reversed, and T2, T3 and T8
 * share the approach to Central, so a naive pass would light the City Circle
 * three times. Doubled *geometry* is what that costs `rail-geo`; here it would
 * cost the feature itself, because the three copies have unrelated arc-length
 * origins and their lamps would interleave at random offsets. A regular pitch is
 * the entire effect and three overlaid irregular ones are noise.
 *
 * `buildTunnelLamps` therefore uses `buildNetwork`'s own dedup key -- endpoints
 * quantised to 25 mm, ordered canonically -- and the first direction in bake
 * order that finds a segment *tunnelled* claims it. Two parallel tracks stay two
 * lit bores, which is right: they are separate ways four metres apart and each
 * has its own tube.
 *
 * The seam this leaves is where a run changes owner, at the junctions where one
 * line diverges from another: the incoming and outgoing runs measure arc length
 * from different origins, so their lamps can land closer together than the
 * pitch. `mergeSeam` rejects those, and the shape of that test is the one thing
 * in this file that had to be measured before it was believed. A plain "within
 * `MIN_GAP` of any placed lamp" rejection deleted **1,225 lamps of 12,557**,
 * which is not a seam, it is the *parallel track*: the up and down roads of a
 * twin bore are four metres apart in the bake and a lamp on one road's wall is
 * routinely within six metres of a lamp on the other's. Both are real, both have
 * their own tube, and deleting either leaves a dark bore beside a lit one.
 *
 * So the test is directional -- same wall, and the offset almost entirely
 * *along* the track rather than across it -- which is a statement about being on
 * the same rail rather than merely nearby. It costs nine `Map` probes a lamp,
 * once, at load, and it finds **59** -- which is what a seam count should look
 * like, and is the number that says the 1,225 were something else.
 *
 * The whole placement is 12,498 lamps over 164 km of bore, built in 9 ms beside
 * `buildNetwork`'s 75, and the table it produces is 256 kB.
 *
 * ---------------------------------------------------------------------------
 * 4. WHY THIS IS ONE PLAIN `Mesh` AND NOT AN `InstancedMesh`.
 *
 * Instancing is the obvious shape and is what `rail-geo` uses for its sleepers
 * and its masts, and it is the wrong call here for one reason:
 * `RenderObject.getMaterialCacheKey` appends `object.uuid` for anything
 * instanced, so **no stand-in can warm an instanced draw** and the warm-up
 * coverage audit skips them by name. Workstream AE's finding is the reason that
 * matters: a renderer whose warm-up declares the wrong attribute layout compiles
 * its real pipeline inside `render`, on the frame the thing first appears, and
 * "the frame the thing first appears" for this feature is *the frame the train
 * enters the tunnel* -- the single worst place in the game to put a compile.
 *
 * A plain `Mesh` over a shared material is exactly the case a stand-in covers,
 * so `tunnelLightWarmupParts` warms it and `bun run client/src/perf-harness.ts
 * --coverage` audits the claim. `verifyTunnelLights` asserts the part's layout
 * against the real geometry's from this side as well, because the audit needs a
 * renderer built for real and the boot check does not.
 *
 * It is not more expensive, either, and that is the second half of the argument.
 * The set is refilled by writing 36 floats per lamp into a buffer allocated once
 * at construction -- position only, because **the colour buffer never changes**:
 * every lamp is the same fitting, so the twelve vertex colours are written once
 * to capacity in the constructor and never touched again. A thousand lamps is
 * 36,000 float stores, which is the same order as a thousand `Matrix4` composes
 * and uploads a third as much.
 *
 * ---------------------------------------------------------------------------
 * 5. NO `nightOpacity`, WHICH IS THE SECOND EXCEPTION EVER GRANTED.
 *
 * `world/nightlights.ts` gives every additive sprite in the city one day/night
 * term -- a single uniform off one dusk ramp -- and `TrainLights` section 1 is
 * the only thing that has ever been allowed out of it, on the grounds that *a
 * train in a bore is in the dark at noon*. A tunnel is the other half of that
 * same sentence and has the stronger claim: it is dark at noon **by
 * construction**, always, everywhere, with no second case to get wrong. The
 * material's opacity is 1 and there is no ramp to read.
 *
 * `fog` is off for a related reason. `main.ts` sets `scene.fog` to a pale blue
 * matched to the sky band, and fog on an *additive* surface does not fade it, it
 * adds the fog colour -- so fifty lamps at the far end of a bore would composite
 * into a blue-grey wash inside a hole in the ground. The distance term here is
 * the residency radius and nothing else.
 *
 * ---------------------------------------------------------------------------
 * 6. WHAT A TEST CANNOT ANSWER. Whether it *feels* like movement. Everything
 * below is provable -- the placement is deterministic in arc length, the lamps
 * land only where there is a bore, the pitch is the constant, the ring adds and
 * disposes symmetrically, the warm-up layout matches -- and none of it is the
 * question that was asked. That one needs a ride through the ESR and an opinion.
 *
 * Two things to look at while forming it, both chosen because they are the
 * places the arithmetic could be right and the picture still wrong:
 *
 *   - **The far end of the chain.** A head is 0.38 m across, which is about two
 *     pixels at 300 m, so the twenty-fifth lamp down a straight bore is at the
 *     edge of what a pixel grid can hold still. If it shimmers rather than
 *     recedes, the answer is a bigger head or a bloom pass, not a shorter
 *     radius -- the length of the row is doing half the work.
 *   - **Underground stations.** `rail-geo` draws the bore through a station and
 *     puts a box over the top of it, so the lamps run straight through Town Hall
 *     at 12 m like everywhere else. Whether that reads as a platform or as a
 *     tunnel somebody parked a train in is a question about the station, and it
 *     belongs to whoever owns the station box.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  FrontSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  type Material,
} from 'three/webgpu';

import { SPAN_TUNNEL } from '../game/rail.ts';
import { uploadAttribute } from './instupload.ts';
import { drawnAsTunnel } from './rail-cut.ts';
import { LAMP_RECORD_STRIDE } from './nightlights.ts';
import { CHUNK_M, TUNNEL_RADIUS, TUNNEL_RISE, chunkKey } from './rail-solids.ts';
import {
  STATION_LAMP_FLOATS,
  STATION_LAMP_RECORD_STRIDE,
  type LampRoom,
  insideLampRoom,
  stationLampPositions,
} from './stationlamps.ts';
import { geometryLayout, warmupGeometry, type WarmupPart } from './warmup.ts';

/** Linear RGB, `world/nightlights.ts`' own. */
type Rgb = readonly [number, number, number];

// --- The numbers ------------------------------------------------------------------

/**
 * Metres between one lamp and the next along the bore. See section 1.
 *
 * Consecutive lamps are on **opposite walls**, so each wall carries one every
 * `2 * TUNNEL_LIGHT_PITCH` and the flicker rate at any one place in the frame is
 * half `tunnelLightRate`.
 */
export const TUNNEL_LIGHT_PITCH = 12;

/**
 * Two lamps closer than this are one lamp.
 *
 * Only ever triggered at an ownership handover -- see section 3 -- and set at
 * half the pitch because that is the largest gap that can never delete a lamp
 * from a correctly-phased run and the smallest that reliably catches a seam.
 */
export const TUNNEL_LAMP_MIN_GAP = TUNNEL_LIGHT_PITCH / 2;

/**
 * ...and how far *across* the track two lamps may be and still be the same lamp.
 *
 * The number that tells a seam from the parallel bore. Lamps on one rail sit on
 * a line, so a genuine seam pair is offset along the track and by nothing at
 * all across it; the nearest lamp on the other road of a twin bore is offset by
 * the four-metre track spacing, or by the 5.3 m across the tube if it is the far
 * wall. Half a metre is comfortably clear of the first and nowhere near the
 * second, and there is no population in between.
 */
export const SEAM_ACROSS = 0.5;

/**
 * How far from the bore axis a fitting is mounted, and how far above the
 * horizontal.
 *
 * `TUNNEL_RADIUS` is 3.4 m, so 3.15 sets the fitting a quarter of a metre proud
 * of the lining: far enough that nothing z-fights and near enough that it reads
 * as bolted to the wall rather than floating in the four-foot. 32 degrees puts
 * it 1.67 m over the bore centre, which with `TUNNEL_RISE` is 3.57 m over the
 * rail head -- above the lower-deck window, level with the upper-deck one, and
 * 2.67 m out from the centreline against a carriage half-width of about 1.6, so
 * it clears the train by a metre.
 */
export const TUNNEL_LAMP_RADIUS = 3.15;
/** Radians. Written as a decimal because `Math.cos` at author time is fine and this file has no shared arithmetic. */
export const TUNNEL_LAMP_ANGLE = 0.5585; // 32 degrees

/** The batten: a 2.4 m strip along the wall, which is what makes a lamp a streak. */
const BATTEN_HALF_LENGTH = 1.2;
const BATTEN_HALF_HEIGHT = 0.11;
/** The fitting seen end-on from down the tunnel, which is what makes the chain. */
const HEAD_HALF_ACROSS = 0.19;
const HEAD_HALF_DEEP = 0.13;
/** How far the head stands off the wall, so it is a lamp and not a decal. */
const HEAD_STANDOFF = 0.07;

/**
 * Cool white, on the blue side of neutral.
 *
 * The same family as `nightlights.SALOON_COLOUR` and for the same reason: real
 * tunnel lighting and real saloon lighting are the same fluorescent-then-LED
 * lineage, and both read distinctly cold against the sodium and warm LED of the
 * street. Down here the contrast is with nothing at all, which makes the colour
 * the only thing saying what kind of light it is.
 */
export const TUNNEL_LAMP_COLOUR: Rgb = [0.80, 0.89, 1.0];
/** The strip. Additive, so this is scene-linear added on top of a black tube. */
const BATTEN_LEVEL = 1.6;
/** The fitting itself, on `nightlights.HEAD_LEVEL`'s scale of a small bright emitter. */
const HEAD_LEVEL = 2.6;

/**
 * How far lamps are drawn.
 *
 * Fifty lamps down a straight bore, which is more chain than any real sight-line
 * in the network offers: the lining is opaque, the City Circle is a circle, and
 * the longest genuinely straight tunnel run in the disc is under half of this.
 * So the radius never presents as a pop -- what ends the row is the tube.
 *
 * Deliberately shorter than `rail-solids.BUILD_RADIUS` (1100 m), which is sized
 * for a viaduct you can see across a suburb. Nobody sees a kilometre of tunnel.
 */
export const TUNNEL_LIGHT_RADIUS = 600;
/** How often the set is refilled, in metres of travel. `rail-geo`'s sleeper cell, doubled. */
export const TUNNEL_LIGHT_CELL_M = 128;

/**
 * The most lamps drawn at once.
 *
 * Measured over the shipped bake with every eighth lamp in turn as the camera:
 * the worst place in Sydney is the block between Town Hall, QVB and Gadigal,
 * where the City Circle, the ESR and both Metro bores are all inside 600 m of
 * each other, and it holds **976**. 1,600 is that with sixty per cent in hand,
 * and it is 19,200 vertices, which still indexes in a `Uint16Array` --
 * `verifyTunnelLights` asserts exactly that, because the failure mode of
 * outgrowing it is silent wraparound rather than an exception.
 */
export const TUNNEL_LAMP_CAPACITY = 1600;

/** Quads per lamp: two batten halves and one head. See `writeTemplate`. */
const QUADS_PER_LAMP = 3;
const VERTS_PER_LAMP = QUADS_PER_LAMP * 4;
/** Both windings per quad, `nightlights.Emissive.quad`'s measured trade. */
const INDICES_PER_LAMP = QUADS_PER_LAMP * 12;

/**
 * Lamps a second at a given speed, and the rate on either single wall is half
 * of it.
 *
 * Exported so that section 1's table is a function anybody can re-run against
 * the bake's own `physics.vExpress` rather than a row of numbers that were true
 * when they were typed. `verifyTunnelLights` holds it to the band.
 */
export function tunnelLightRate(speedMs: number): number {
  return speedMs / TUNNEL_LIGHT_PITCH;
}

// --- Placement, which is a pure function of arc length -----------------------------

/**
 * Exactly what the placement reads out of the bake, and nothing else.
 *
 * `RailBake` satisfies this structurally, so the game passes the real thing and
 * a check passes twenty vertices. Written as its own interface rather than taken
 * as a `RailBake` because the list *is* the contract: this file must never grow
 * a dependence on the timetable, the stations or the phases, and the way to make
 * that true is to be unable to see them.
 */
export interface TunnelLampSource {
  lines: ReadonlyArray<{ dirs: ReadonlyArray<{ vertexOff: number; vertexCount: number }> }>;
  /** `(x, y, z)` per polyline vertex. The y is the rail head. */
  vertices: Float32Array;
  /** Cumulative arc length per vertex, metres, per direction. */
  cum: Float64Array;
  /** `SPAN_*` per vertex. */
  vertexFlags: Uint8Array;
}

/**
 * Every tunnel lamp in Sydney, placed once at load and never moved.
 *
 * `at` is five floats a lamp -- `x, y, z` at the rail head under the fitting, and
 * the unit **plan** direction of the track there. Plan and not the 3D tangent
 * deliberately: `rail-geo.writeTunnel` sweeps the bore on the plan perpendicular
 * too, so a lamp built the same way sits on the lining by construction, and the
 * ruling gradient of 3.3% tilts a 2.4 m batten by 4 cm end to end, which is not
 * a thing anybody will see at 240 km/h.
 */
export interface TunnelLampField {
  readonly at: Float32Array;
  /** `-1` or `+1`: which wall. Alternates along the bore. */
  readonly side: Int8Array;
  readonly count: number;
  /** Lamp indices by `CHUNK_M` cell, so a refill visits nine buckets and not thirteen thousand lamps. */
  readonly cells: ReadonlyMap<string, number[]>;
  /** How many lamps an ownership handover put on top of another. See section 3. */
  readonly merged: number;
}

/** `buildNetwork`'s quantisation, restated so the two dedups cannot drift apart. */
const q = (v: number): number => Math.round(v * 4);

/** One integer for a `TUNNEL_LAMP_MIN_GAP` cell. See `near` in `buildTunnelLamps`. */
const gapKey = (cx: number, cz: number): number => cx * 0x100000 + cz;

/**
 * Place a lamp every `TUNNEL_LIGHT_PITCH` metres of every tunnelled rail.
 *
 * Pure, allocation-bounded and a function of the bake alone -- no player, no
 * clock, no random. Two calls on the same bytes produce identical arrays, which
 * is what makes the set stable enough to be a speedometer: a lamp that moved
 * would be a lamp that lied.
 *
 * The phase is the *owning direction's own* arc length, so `s` is a multiple of
 * the pitch and the side is the parity of `s / pitch`. That is what keeps the
 * spacing exact across a segment boundary -- the polyline is densified to about
 * 24 m in tunnels, so a lamp every 12 m crosses one constantly -- and it is why
 * the run is walked by arc length rather than per segment with a leftover.
 */
/**
 * `rooms` are the station chambers (`stationlamps.lampRooms`): their lamps hang
 * from the ceiling on `side = 0`, positioned by `stationLampPositions` so the
 * painted batten and the real light `main.ts` composes from the same function
 * are the same lamp. Stored `TUNNEL_RISE` low because `refill` adds it back.
 */
export function buildTunnelLamps(bake: TunnelLampSource, rooms: readonly LampRoom[] = []): TunnelLampField {
  const p = bake.vertices;
  const flags = bake.vertexFlags;
  const cum = bake.cum;

  const at: number[] = [];
  const side: number[] = [];
  /** The 25 mm segment key of every rail already lit. See section 3. */
  const owner = new Set<string>();
  /**
   * Placed lamps by `TUNNEL_LAMP_MIN_GAP` cell, for the handover rejection.
   *
   * Keyed on one integer rather than a string, because this is the hot loop of
   * the whole build -- nine probes a lamp over twelve thousand lamps. The disc
   * is 60 km, so a cell ordinate is inside +/- 10,000 and the pair packs into a
   * double with room to spare.
   */
  const near = new Map<number, number[]>();
  let merged = 0;

  for (const line of bake.lines) {
    for (const dir of line.dirs) {
      const start = dir.vertexOff;
      const end = dir.vertexOff + dir.vertexCount - 1;
      for (let i = start; i < end; i++) {
        // The union of both ends, exactly as `buildNetwork` takes it: the last
        // few metres before a portal are inside the hill whichever vertex
        // carries the flag.
        if (!drawnAsTunnel(flags[i] | flags[i + 1])) continue;
        const ax = p[i * 3];
        const ay = p[i * 3 + 1];
        const az = p[i * 3 + 2];
        const bx = p[(i + 1) * 3];
        const by = p[(i + 1) * 3 + 1];
        const bz = p[(i + 1) * 3 + 2];
        const dx = bx - ax;
        const dz = bz - az;
        const len = Math.sqrt(dx * dx + dz * dz);
        // Before the claim, not after, which is `buildNetwork`'s own order: a
        // degenerate segment must not be able to own a rail it draws nothing on.
        if (len < 0.05) continue;
        const forward = ax < bx || (ax === bx && az <= bz);
        const key = forward
          ? `${q(ax)},${q(ay)},${q(az)},${q(bx)},${q(by)},${q(bz)}`
          : `${q(bx)},${q(by)},${q(bz)},${q(ax)},${q(ay)},${q(az)}`;
        if (owner.has(key)) continue;
        owner.add(key);

        const ux = dx / len;
        const uz = dz / len;

        const c0 = cum[i];
        const c1 = cum[i + 1];
        const span = c1 - c0;
        if (!(span > 0)) continue;
        for (let k = Math.ceil(c0 / TUNNEL_LIGHT_PITCH); k * TUNNEL_LIGHT_PITCH < c1; k++) {
          const u = (k * TUNNEL_LIGHT_PITCH - c0) / span;
          const x = ax + dx * u;
          const y = ay + (by - ay) * u;
          const z = az + dz * u;
          const wall = (k & 1) === 0 ? -1 : 1;
          // Not in a station chamber: the tube is not drawn there, so a batten
          // on its wall would hang in the air over the platform.
          if (insideLampRoom(rooms, x, z)) continue;
          // The handover rejection. Nine cells because a lamp near a cell corner
          // is within `MIN_GAP` of the eight around it, and a test that only
          // looked in its own cell would let a pair through whenever the seam
          // happened to straddle a boundary.
          let clash = false;
          const cx = Math.floor(x / TUNNEL_LAMP_MIN_GAP);
          const cz = Math.floor(z / TUNNEL_LAMP_MIN_GAP);
          for (let ox = -1; ox <= 1 && !clash; ox++) {
            for (let oz = -1; oz <= 1 && !clash; oz++) {
              const bucket = near.get(gapKey(cx + ox, cz + oz));
              if (bucket === undefined) continue;
              for (const j of bucket) {
                if (side[j] !== wall) continue;
                const ex = at[j * 5] - x;
                const ey = at[j * 5 + 1] - y;
                const ez = at[j * 5 + 2] - z;
                if (ex * ex + ey * ey + ez * ez >= TUNNEL_LAMP_MIN_GAP * TUNNEL_LAMP_MIN_GAP) continue;
                // ...and on **this** rail, not the one beside it. See section 3:
                // an offset that is mostly across the track is the other road of
                // a twin bore, four metres away and entitled to its own lamps.
                if (Math.abs(ex * -uz + ez * ux) > SEAM_ACROSS) continue;
                if (Math.abs(ey) > SEAM_ACROSS) continue;
                clash = true;
                break;
              }
            }
          }
          if (clash) {
            merged++;
            continue;
          }
          const index = side.length;
          at.push(x, y, z, ux, uz);
          // The parity of the arc index, so the two walls alternate along a run
          // rather than along a segment. `k` is the lamp's ordinal on this
          // direction's polyline and nothing resets it.
          side.push(wall);
          const cell = gapKey(cx, cz);
          const bucket = near.get(cell);
          if (bucket === undefined) near.set(cell, [index]);
          else bucket.push(index);
        }
      }
    }
  }

  for (const room of rooms) {
    const p = stationLampPositions(room);
    for (let i = 0; i < p.length; i += STATION_LAMP_FLOATS) {
      at.push(p[i], p[i + 1] - TUNNEL_RISE, p[i + 2], p[i + 3], p[i + 4]);
      side.push(0);
    }
  }

  const cells = new Map<string, number[]>();
  for (let i = 0; i < side.length; i++) {
    const key = chunkKey(Math.floor(at[i * 5] / CHUNK_M), Math.floor(at[i * 5 + 2] / CHUNK_M));
    const bucket = cells.get(key);
    if (bucket === undefined) cells.set(key, [i]);
    else bucket.push(i);
  }

  return {
    at: new Float32Array(at),
    side: new Int8Array(side),
    count: side.length,
    cells,
    merged,
  };
}

// --- The fitting, as twelve vertices in the bore's own frame -----------------------

/**
 * One lamp's vertices in `(along, across, up)` metres from the **bore axis** at
 * the polyline point, and the vertex colours that go with them.
 *
 * Two templates, one per wall, mirrored across the bore's vertical axis. Built
 * once at module scope because a fitting is the same shape everywhere in Sydney
 * and the refill's inner loop should be three multiplies and an add.
 *
 * The frame at the mount point: `i` is the unit vector into the bore and `t` is
 * the unit vector down the wall, the two of them perpendicular and both in the
 * cross-section plane. The batten lies in `(along, t)` -- flat on the lining --
 * and the head stands in `(t, i)`, facing along the tunnel. Each is emitted
 * because the other is invisible from somewhere the player really goes: a batten
 * flat on the wall is edge-on to a passenger looking down the bore, which is
 * exactly where the receding chain lives, and a head facing along the tunnel is
 * edge-on the instant it whips past the window.
 */
function writeTemplate(wall: number): { offset: Float32Array; colour: Float32Array } {
  const offset = new Float32Array(VERTS_PER_LAMP * 3);
  const colour = new Float32Array(VERTS_PER_LAMP * 3);
  const cos = Math.cos(TUNNEL_LAMP_ANGLE);
  const sin = Math.sin(TUNNEL_LAMP_ANGLE);
  // The mount point, from the bore axis.
  const mountAcross = wall * TUNNEL_LAMP_RADIUS * cos;
  const mountUp = TUNNEL_LAMP_RADIUS * sin;
  // Into the bore...
  const inAcross = -wall * cos;
  const inUp = -sin;
  // ...and down the wall, mirrored so both walls read the same way up.
  const tanAcross = wall * sin;
  const tanUp = -cos;

  let v = 0;
  const put = (along: number, tan: number, into: number, level: number): void => {
    offset[v * 3] = along;
    offset[v * 3 + 1] = mountAcross + tan * tanAcross + into * inAcross;
    offset[v * 3 + 2] = mountUp + tan * tanUp + into * inUp;
    colour[v * 3] = TUNNEL_LAMP_COLOUR[0] * level;
    colour[v * 3 + 1] = TUNNEL_LAMP_COLOUR[1] * level;
    colour[v * 3 + 2] = TUNNEL_LAMP_COLOUR[2] * level;
    v++;
  };

  // The batten, in two halves so the length carries a ramp: black at the ends,
  // full in the middle. `world/bike.ts`' rule -- black is invisible under an
  // additive blend, so a colour ramp to black *is* the soft edge, and it costs a
  // vertex instead of a texture.
  put(-BATTEN_HALF_LENGTH, -BATTEN_HALF_HEIGHT, 0, 0);
  put(0, -BATTEN_HALF_HEIGHT, 0, BATTEN_LEVEL);
  put(0, BATTEN_HALF_HEIGHT, 0, BATTEN_LEVEL);
  put(-BATTEN_HALF_LENGTH, BATTEN_HALF_HEIGHT, 0, 0);

  put(0, -BATTEN_HALF_HEIGHT, 0, BATTEN_LEVEL);
  put(BATTEN_HALF_LENGTH, -BATTEN_HALF_HEIGHT, 0, 0);
  put(BATTEN_HALF_LENGTH, BATTEN_HALF_HEIGHT, 0, 0);
  put(0, BATTEN_HALF_HEIGHT, 0, BATTEN_LEVEL);

  // The head, standing off the wall and facing along the bore.
  put(0, -HEAD_HALF_ACROSS, HEAD_STANDOFF - HEAD_HALF_DEEP, HEAD_LEVEL);
  put(0, HEAD_HALF_ACROSS, HEAD_STANDOFF - HEAD_HALF_DEEP, HEAD_LEVEL);
  put(0, HEAD_HALF_ACROSS, HEAD_STANDOFF + HEAD_HALF_DEEP, HEAD_LEVEL);
  put(0, -HEAD_HALF_ACROSS, HEAD_STANDOFF + HEAD_HALF_DEEP, HEAD_LEVEL);

  return { offset, colour };
}

const TEMPLATE_LEFT = /*#__PURE__*/ writeTemplate(-1);
const TEMPLATE_RIGHT = /*#__PURE__*/ writeTemplate(1);

/**
 * The station lamp: the same batten and head, hung from a ceiling. The mount is
 * the record itself (a room lamp is stored at its own height), `i` is straight
 * down and `t` is across the room, so the batten lies flat under the ceiling
 * and the head hangs beneath it facing along the platform -- which is where a
 * body on the platform looks from.
 */
function writeCeilingTemplate(): { offset: Float32Array; colour: Float32Array } {
  const offset = new Float32Array(VERTS_PER_LAMP * 3);
  const colour = new Float32Array(VERTS_PER_LAMP * 3);
  let v = 0;
  const put = (along: number, tan: number, into: number, level: number): void => {
    offset[v * 3] = along;
    offset[v * 3 + 1] = tan;
    offset[v * 3 + 2] = -into;
    colour[v * 3] = TUNNEL_LAMP_COLOUR[0] * level;
    colour[v * 3 + 1] = TUNNEL_LAMP_COLOUR[1] * level;
    colour[v * 3 + 2] = TUNNEL_LAMP_COLOUR[2] * level;
    v++;
  };
  put(-BATTEN_HALF_LENGTH, -BATTEN_HALF_HEIGHT, 0, 0);
  put(0, -BATTEN_HALF_HEIGHT, 0, BATTEN_LEVEL);
  put(0, BATTEN_HALF_HEIGHT, 0, BATTEN_LEVEL);
  put(-BATTEN_HALF_LENGTH, BATTEN_HALF_HEIGHT, 0, 0);
  put(0, -BATTEN_HALF_HEIGHT, 0, BATTEN_LEVEL);
  put(BATTEN_HALF_LENGTH, -BATTEN_HALF_HEIGHT, 0, 0);
  put(BATTEN_HALF_LENGTH, BATTEN_HALF_HEIGHT, 0, 0);
  put(0, BATTEN_HALF_HEIGHT, 0, BATTEN_LEVEL);
  // The wall lamp's head straddles its standoff, 6 cm of it behind the lining
  // where nobody is. A ceiling has a slab behind it and a platform in front,
  // so this head hangs wholly below the batten.
  put(0, -HEAD_HALF_ACROSS, HEAD_STANDOFF, HEAD_LEVEL);
  put(0, HEAD_HALF_ACROSS, HEAD_STANDOFF, HEAD_LEVEL);
  put(0, HEAD_HALF_ACROSS, HEAD_STANDOFF + 2 * HEAD_HALF_DEEP, HEAD_LEVEL);
  put(0, -HEAD_HALF_ACROSS, HEAD_STANDOFF + 2 * HEAD_HALF_DEEP, HEAD_LEVEL);
  return { offset, colour };
}

const TEMPLATE_DOWN = /*#__PURE__*/ writeCeilingTemplate();

// --- The renderer ------------------------------------------------------------------

/**
 * The one material and the one thing it is worn by.
 *
 * Constructed once, before the boot warm-up, on `rail-geo.RailAssets`' terms:
 * nothing here is created per refill and nothing is created per lamp.
 */
export class TunnelLightAssets {
  readonly lamp: MeshBasicNodeMaterial;

  constructor() {
    const m = new MeshBasicNodeMaterial();
    m.name = 'tunnel_lamp';
    m.vertexColors = true;
    m.color = new Color(1, 1, 1);
    m.transparent = true;
    m.blending = AdditiveBlending;
    // Depth-tested and never depth-written, `nightlights.nightMaterial`'s pair of
    // reasons: the test is what keeps a lamp on the far side of the lining
    // behind it and what keeps the whole row under the terrain over the top,
    // and not writing is what stops fifty additive sprites occluding each other.
    m.depthWrite = false;
    m.depthTest = true;
    m.side = FrontSide;
    // No `opacityNode`, and no fog. Section 5.
    m.fog = false;
    this.lamp = m;
  }
}

/**
 * What the boot pass has to compile so that entering a tunnel compiles nothing.
 *
 * `{ position, color }` and no normal and no uv, because that is what the real
 * geometry carries -- see the constructor -- and `getGeometryCacheKey` reads the
 * attribute layout as part of the key. `casts` and `receives` are both false and
 * both pinned: an additive emitter neither throws a shadow nor takes one, this
 * file never changes either flag after construction, and pinning them means a
 * future change that does is a coverage failure rather than a silent second
 * pipeline. Workstream AE's row, written the way that round asked for it.
 */
export function tunnelLightWarmupParts(assets: TunnelLightAssets): WarmupPart[] {
  return [
    {
      geometry: warmupGeometry({ color3: true }),
      material: assets.lamp,
      owned: true,
      casts: false,
      receives: [false],
    },
  ];
}

/**
 * The lamps near the player, in the scene.
 *
 * One mesh for the whole world and a residency ring over `CHUNK_M` cells --
 * `rail-geo.ts` section 3's shape for its sleepers and its masts, for its
 * reasons, with the instancing swapped out for a draw range for section 4's.
 */
export class TunnelLights {
  readonly group = new Group();
  /** Lamps in the current draw range. On the debug overlay. */
  lampCount = 0;
  /** What the last refill cost, milliseconds. */
  refillMs = 0;
  /** Lamps dropped because the set was full. Should be zero forever; see the capacity. */
  overflows = 0;
  /** Cells inside the radius on the last refill. The residency, such as it is. */
  residentCells = 0;

  private readonly mesh: Mesh;
  private readonly geometry: BufferGeometry;
  private readonly position: Float32Array;
  private readonly positionAttribute: BufferAttribute;
  private lastCell = '';

  constructor(
    private field: TunnelLampField,
    assets: TunnelLightAssets,
    private readonly capacity: number = TUNNEL_LAMP_CAPACITY,
  ) {
    this.group.name = 'tunnel_lights';

    this.position = new Float32Array(capacity * VERTS_PER_LAMP * 3);
    const colour = new Float32Array(capacity * VERTS_PER_LAMP * 3);
    const index = new Uint16Array(capacity * INDICES_PER_LAMP);

    // Colour and index to capacity, once. Neither is ever written again: every
    // lamp is the same fitting, so the only thing a refill has to say is where.
    // Which wall a lamp is on changes its *shape* and not its colours, so one
    // pattern serves both templates.
    for (let n = 0; n < capacity; n++) {
      colour.set(TEMPLATE_LEFT.colour, n * VERTS_PER_LAMP * 3);
      const base = n * VERTS_PER_LAMP;
      let w = n * INDICES_PER_LAMP;
      for (let quad = 0; quad < QUADS_PER_LAMP; quad++) {
        const a = base + quad * 4;
        // Both windings, so one draw covers a sprite seen from either side and
        // the rasteriser discards exactly half. `nightlights.Emissive.quad`.
        index[w++] = a; index[w++] = a + 1; index[w++] = a + 2;
        index[w++] = a; index[w++] = a + 2; index[w++] = a + 3;
        index[w++] = a; index[w++] = a + 2; index[w++] = a + 1;
        index[w++] = a; index[w++] = a + 3; index[w++] = a + 2;
      }
    }

    const geometry = new BufferGeometry();
    geometry.name = 'tunnel_lamps';
    this.positionAttribute = new BufferAttribute(this.position, 3);
    this.positionAttribute.setUsage(DynamicDrawUsage);
    geometry.setAttribute('position', this.positionAttribute);
    geometry.setAttribute('color', new BufferAttribute(colour, 3));
    geometry.setIndex(new BufferAttribute(index, 1));
    geometry.setDrawRange(0, 0);
    this.geometry = geometry;

    const mesh = new Mesh(geometry, assets.lamp);
    mesh.name = 'tunnel_lamps';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.userData.noShadow = true;
    // Culled by radius rather than by frustum, `rail-geo.makeInstanced`'s
    // argument: the bounding sphere of a set that is rebuilt around the player
    // would have to be recomputed on every refill, and the radius test has
    // already been done.
    mesh.frustumCulled = false;
    this.mesh = mesh;
    this.group.add(mesh);
  }

  /** The real mesh, for `verifyTunnelLights` to key against its own warm-up part. */
  get drawn(): Mesh {
    return this.mesh;
  }

  /**
   * Bring the set up to date for a player at `(x, z)`.
   *
   * Free on every frame but the one that crosses a `TUNNEL_LIGHT_CELL_M`
   * boundary, which at line speed is a little under two seconds apart.
   */
  update(x: number, z: number): void {
    const cell = `${Math.floor(x / TUNNEL_LIGHT_CELL_M)},${Math.floor(z / TUNNEL_LIGHT_CELL_M)}`;
    if (cell === this.lastCell) return;
    this.lastCell = cell;
    this.refill(x, z);
  }

  /**
   * A new table, and a refill on the next `update`. `main.ts` calls this when
   * the station field is rebuilt with the terrain known: a room's ceiling is
   * read off the ground, so its lamps can move a little once the tiles are in.
   */
  setField(field: TunnelLampField): void {
    this.field = field;
    this.lastCell = '';
  }

  dispose(): void {
    this.group.remove(this.mesh);
    this.geometry.dispose();
  }

  private refill(x: number, z: number): void {
    const started = performance.now();
    const at = this.field.at;
    const side = this.field.side;
    const pos = this.position;
    const r2 = TUNNEL_LIGHT_RADIUS * TUNNEL_LIGHT_RADIUS;
    const span = Math.ceil(TUNNEL_LIGHT_RADIUS / CHUNK_M);
    const cx = Math.floor(x / CHUNK_M);
    const cz = Math.floor(z / CHUNK_M);
    let n = 0;
    let cells = 0;

    for (let ox = -span; ox <= span; ox++) {
      for (let oz = -span; oz <= span; oz++) {
        const bucket = this.field.cells.get(chunkKey(cx + ox, cz + oz));
        if (bucket === undefined) continue;
        if (cellDistance(cx + ox, cz + oz, x, z) > TUNNEL_LIGHT_RADIUS) continue;
        cells++;
        for (const i of bucket) {
          const lx = at[i * 5];
          const lz = at[i * 5 + 2];
          const dx = lx - x;
          const dz = lz - z;
          if (dx * dx + dz * dz > r2) continue;
          if (n >= this.capacity) {
            this.overflows++;
            break;
          }
          const ly = at[i * 5 + 1] + TUNNEL_RISE;
          const ux = at[i * 5 + 3];
          const uz = at[i * 5 + 4];
          // The bore's plan frame: along the track, and across it. `writeTunnel`
          // sweeps the lining on the same pair, so a fitting built from them is
          // on the wall and not near it.
          const px = -uz;
          const pz = ux;
          const template = side[i] === 0 ? TEMPLATE_DOWN.offset : side[i] < 0 ? TEMPLATE_LEFT.offset : TEMPLATE_RIGHT.offset;
          let w = n * VERTS_PER_LAMP * 3;
          for (let v = 0; v < VERTS_PER_LAMP * 3; v += 3) {
            const along = template[v];
            const across = template[v + 1];
            pos[w++] = lx + ux * along + px * across;
            pos[w++] = ly + template[v + 2];
            pos[w++] = lz + uz * along + pz * across;
          }
          n++;
        }
      }
    }

    this.lampCount = n;
    this.residentCells = cells;
    this.geometry.setDrawRange(0, n * INDICES_PER_LAMP);
    // Only the prefix that was written, through the one helper that owns the
    // element arithmetic. `world/instupload.ts`' two conditions both hold here:
    // the draw range stops at `n`, so the tail is never rasterised, and the
    // buffer was created from the full array, so the GPU copy started complete.
    uploadAttribute(this.positionAttribute, n, VERTS_PER_LAMP * 3);
    this.refillMs = performance.now() - started;
  }
}

/** Distance from a point to a `CHUNK_M` cell's box, in metres. Zero inside. */
function cellDistance(cx: number, cz: number, x: number, z: number): number {
  const x0 = cx * CHUNK_M;
  const z0 = cz * CHUNK_M;
  const dx = Math.max(x0 - x, 0, x - (x0 + CHUNK_M));
  const dz = Math.max(z0 - z, 0, z - (z0 + CHUNK_M));
  return Math.sqrt(dx * dx + dz * dz);
}

// --- The self-check ------------------------------------------------------------------

/**
 * A bake with one direction: `count` vertices on a straight line at 24 m
 * spacing, tunnelled between `tunnelFrom` and `tunnelTo` inclusive.
 *
 * 24 m because that is the shipped bake's median tunnel segment and it is longer
 * than the pitch, so the lamps really do cross segment boundaries and the check
 * exercises the thing that is easy to get wrong.
 */
function straightBake(
  count: number,
  tunnelFrom: number,
  tunnelTo: number,
  x0 = 0,
  copies = 1,
): TunnelLampSource {
  const step = 24;
  const vertices = new Float32Array(count * 3);
  const cum = new Float64Array(count);
  const flags = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    vertices[i * 3] = x0 + i * step;
    vertices[i * 3 + 1] = 10;
    vertices[i * 3 + 2] = 0;
    cum[i] = i * step;
    if (i >= tunnelFrom && i <= tunnelTo) flags[i] = SPAN_TUNNEL;
  }
  const dirs = [];
  for (let c = 0; c < copies; c++) dirs.push({ vertexOff: 0, vertexCount: count });
  return { lines: [{ dirs }], vertices, cum, vertexFlags: flags };
}

/**
 * Everything about this feature a machine can decide, which is everything except
 * whether it works. See section 6.
 */
export function verifyTunnelLights(): string[] {
  const out: string[] = [];

  // --- The pitch is the constant, and the rate it implies is the one designed for.
  if (TUNNEL_LIGHT_PITCH !== 12) {
    out.push(`tunnel lamp pitch is ${TUNNEL_LIGHT_PITCH} m; section 1's whole table is written for 12`);
  }
  // The bake's own express speed, restated here because this check runs before
  // the bake is fetched. `pipeline/sydney/rail.V_EXPRESS`.
  const express = 66.6;
  const local = 54.15;
  const rate = tunnelLightRate(express);
  if (!(rate >= 3.5 && rate <= 8)) {
    out.push(`${rate.toFixed(2)} lamps/s at express speed is outside the 3.5-8 band section 1 argues for`);
  }
  // ...and no single wall may pulse faster than three times a second.
  if (rate / 2 > 3) {
    out.push(`${(rate / 2).toFixed(2)} Hz on one wall at express speed; alternating is meant to keep it under 3`);
  }
  if (tunnelLightRate(local) < 3.5) {
    out.push(`${tunnelLightRate(local).toFixed(2)} lamps/s at stopping-pattern speed reads as slow`);
  }

  // --- Capacity still indexes in a `Uint16Array`.
  if (TUNNEL_LAMP_CAPACITY * VERTS_PER_LAMP > 65536) {
    out.push(
      `capacity ${TUNNEL_LAMP_CAPACITY} is ${TUNNEL_LAMP_CAPACITY * VERTS_PER_LAMP} vertices, ` +
        'past what a Uint16 index can address -- the failure is silent wraparound',
    );
  }

  // --- Placement: deterministic, tunnel-only, on the pitch, alternating.
  //
  // Vertices 0..19 at 24 m, tunnelled from 5 to 14. A segment counts as tunnel
  // if *either* end does, so the bore runs from vertex 4 to vertex 15: arc 96 m
  // to 360 m.
  const source = straightBake(20, 5, 14);
  const a = buildTunnelLamps(source);
  const b = buildTunnelLamps(source);
  if (a.count !== b.count) {
    out.push(`buildTunnelLamps is not deterministic: ${a.count} lamps then ${b.count}`);
  } else {
    for (let i = 0; i < a.at.length; i++) {
      if (a.at[i] !== b.at[i]) {
        out.push(`buildTunnelLamps is not deterministic: at[${i}] is ${a.at[i]} then ${b.at[i]}`);
        break;
      }
    }
  }
  if (a.merged !== 0) out.push(`a single straight run merged ${a.merged} lamps; nothing should have collided`);

  const boreFrom = 4 * 24;
  const boreTo = 15 * 24;
  let offTrack = 0;
  const arcs: number[] = [];
  for (let i = 0; i < a.count; i++) {
    const s = a.at[i * 5];
    arcs.push(s);
    if (s < boreFrom - 1e-6 || s > boreTo + 1e-6) offTrack++;
  }
  if (offTrack > 0) out.push(`${offTrack} of ${a.count} lamps landed on open track outside the bore`);
  const expected = Math.floor((boreTo - 1e-9) / TUNNEL_LIGHT_PITCH) - Math.ceil(boreFrom / TUNNEL_LIGHT_PITCH) + 1;
  if (a.count !== expected) {
    out.push(`${a.count} lamps over ${boreTo - boreFrom} m of bore; a ${TUNNEL_LIGHT_PITCH} m pitch wants ${expected}`);
  }
  arcs.sort((m, n) => m - n);
  for (let i = 1; i < arcs.length; i++) {
    const gap = arcs[i] - arcs[i - 1];
    if (Math.abs(gap - TUNNEL_LIGHT_PITCH) > 1e-3) {
      out.push(`lamps ${i - 1} and ${i} are ${gap.toFixed(3)} m apart, not ${TUNNEL_LIGHT_PITCH}`);
      break;
    }
  }
  for (let i = 0; i < a.count; i++) {
    const k = Math.round(a.at[i * 5] / TUNNEL_LIGHT_PITCH);
    const want = (k & 1) === 0 ? -1 : 1;
    if (a.side[i] !== want) {
      out.push(`lamp at s=${a.at[i * 5]} is on wall ${a.side[i]}; alternating wants ${want}`);
      break;
    }
  }

  // --- The 25 mm dedup: two services over the same rails are one lit bore.
  const shared = buildTunnelLamps(straightBake(20, 5, 14, 0, 3));
  if (shared.count !== a.count) {
    out.push(`three services over one tunnel light it ${shared.count} times over, not ${a.count}`);
  }

  // --- An open railway is dark.
  const open = buildTunnelLamps(straightBake(20, 1, 0));
  if (open.count !== 0) out.push(`${open.count} lamps on a railway with no tunnel in it`);

  // --- The fitting clears the lining and sits over the rail head.
  {
    const assets = new TunnelLightAssets();
    const lights = new TunnelLights(a, assets, 64);
    lights.update(boreFrom + 40, 0);
    const drawn = lights.lampCount;
    if (drawn === 0) out.push('no lamps drawn standing in the middle of a lit bore');
    const pos = (lights.drawn.geometry.getAttribute('position') as BufferAttribute).array as Float32Array;
    let outside = 0;
    let underRail = 0;
    for (let v = 0; v < drawn * VERTS_PER_LAMP; v++) {
      // The synthetic bore runs along +X at y = 10, z = 0, so the offset from the
      // axis is (z, y - 10 - TUNNEL_RISE) and the rail head is y = 10.
      const dz = pos[v * 3 + 2];
      const dy = pos[v * 3 + 1] - 10 - TUNNEL_RISE;
      if (Math.sqrt(dz * dz + dy * dy) > TUNNEL_RADIUS) outside++;
      if (pos[v * 3 + 1] < 10) underRail++;
    }
    if (outside > 0) out.push(`${outside} lamp vertices are outside the ${TUNNEL_RADIUS} m lining`);
    if (underRail > 0) out.push(`${underRail} lamp vertices are below the rail head`);

    // --- The residency ring adds and disposes symmetrically.
    lights.update(1e6, 1e6);
    if (lights.lampCount !== 0) {
      out.push(`${lights.lampCount} lamps still drawn a thousand kilometres from any tunnel`);
    }
    if (lights.residentCells !== 0) out.push(`${lights.residentCells} cells resident with no railway in range`);
    lights.update(boreFrom + 40, 0);
    if (lights.lampCount !== drawn) {
      out.push(`the ring came back with ${lights.lampCount} lamps where it left with ${drawn}`);
    }
    if (lights.overflows !== 0) out.push(`${lights.overflows} lamps overflowed a 64-lamp set over 264 m of bore`);
    // Nothing beyond the radius, which is the other half of "the ring is a ring".
    const far = new TunnelLights(buildTunnelLamps(straightBake(400, 0, 399)), assets, TUNNEL_LAMP_CAPACITY);
    far.update(0, 0);
    const farPos = (far.drawn.geometry.getAttribute('position') as BufferAttribute).array as Float32Array;
    let beyond = 0;
    for (let v = 0; v < far.lampCount * VERTS_PER_LAMP; v++) {
      if (farPos[v * 3] > TUNNEL_LIGHT_RADIUS + BATTEN_HALF_LENGTH + 1e-3) beyond++;
    }
    if (beyond > 0) out.push(`${beyond} lamp vertices drawn past the ${TUNNEL_LIGHT_RADIUS} m radius`);
    if (far.lampCount === 0) out.push('a 9.6 km bore through the origin drew no lamps at all');

    // --- WORKSTREAM AE's rule, checked from this side as well as by the coverage
    // audit: the stand-in must key identically to the thing it stands in for.
    const part = tunnelLightWarmupParts(assets)[0];
    const realLayout = geometryLayout(lights.drawn.geometry);
    const partLayout = geometryLayout(part.geometry);
    if (realLayout !== partLayout) {
      out.push(`the warm-up part is {${partLayout}} and the real lamp mesh is {${realLayout}}`);
    }
    if ((part.casts ?? true) !== lights.drawn.castShadow) {
      out.push(`the warm-up part casts ${part.casts} and the real mesh casts ${lights.drawn.castShadow}`);
    }
    const receives = part.receives ?? [false, true];
    if (receives.length !== 1 || receives[0] !== lights.drawn.receiveShadow) {
      out.push(
        `the warm-up part receives [${receives.join(', ')}] and the real mesh receives ` +
          `${lights.drawn.receiveShadow}`,
      );
    }
    if ((part.material as Material) !== (lights.drawn.material as Material)) {
      out.push('the warm-up part wears a different material instance from the mesh it stands in for');
    }
    far.dispose();
    lights.dispose();
  }

  // --- The station rooms. `stationlamps` promises `nightlights` a record
  //     stride it cannot import; this file imports both.
  if (STATION_LAMP_RECORD_STRIDE !== LAMP_RECORD_STRIDE) {
    out.push(`stationlamps writes ${STATION_LAMP_RECORD_STRIDE}-float records and nightlights reads ${LAMP_RECORD_STRIDE}`);
  }
  {
    const source = straightBake(20, 5, 14);
    const bare = buildTunnelLamps(source);
    const room: LampRoom = {
      name: 'Wynyard', x: 5000, z: -5000, ux: 0.6, uz: 0.8,
      halfLength: 80, halfWidth: 16, floorY: -20, ceilY: -14,
    };
    const lit = buildTunnelLamps(source, [room]);
    const expected = stationLampPositions(room).length / STATION_LAMP_FLOATS;
    // ...and a room laid over the straight bake takes the tube's lamps out of it.
    {
      // `straightBake` runs along +x at 24 m a vertex, tunnel from vertex 5 to 14: x 120-336.
      const over: LampRoom = { ...room, x: 228, z: 0, ux: 1, uz: 0, halfLength: 30, halfWidth: 16 };
      const cut = buildTunnelLamps(source, [over]);
      let wallInside = 0;
      for (let i = 0; i < cut.count; i++) {
        if (cut.side[i] !== 0 && insideLampRoom([over], cut.at[i * 5], cut.at[i * 5 + 2])) wallInside++;
      }
      if (wallInside > 0) out.push(`${wallInside} tunnel wall lamps still hang inside a room laid over the bore`);
      let wallBefore = 0;
      for (let i = 0; i < bare.count; i++) if (insideLampRoom([over], bare.at[i * 5], bare.at[i * 5 + 2])) wallBefore++;
      if (wallBefore === 0) out.push('the room check proves nothing: the straight bake put no wall lamps where the room is');
    }
    if (lit.count !== bare.count + expected) {
      out.push(`a room added ${lit.count - bare.count} lamps to the table; stationLampPositions gives ${expected}`);
    }
    let down = 0;
    for (let i = 0; i < lit.count; i++) if (lit.side[i] === 0) down++;
    if (down !== expected) out.push(`${down} lamps hang from a ceiling; the room's ${expected} should and no tunnel lamp should`);
    for (let i = bare.count; i < lit.count; i++) {
      const y = lit.at[i * 5 + 1] + TUNNEL_RISE;
      if (!(y < room.ceilY && y > room.floorY)) {
        out.push(`room lamp ${i - bare.count} refills to ${y.toFixed(2)}; the room runs ${room.floorY} to ${room.ceilY}`);
        break;
      }
    }
    // The ceiling template hangs down: nothing above the mount, the head under the batten.
    const t = TEMPLATE_DOWN.offset;
    let highest = -Infinity;
    let battenLow = Infinity;
    let headHigh = -Infinity;
    for (let v = 0; v < VERTS_PER_LAMP; v++) {
      const up = t[v * 3 + 2];
      highest = Math.max(highest, up);
      if (v < 8) battenLow = Math.min(battenLow, up);
      else headHigh = Math.max(headHigh, up);
    }
    if (highest > 1e-6) out.push(`the ceiling lamp reaches ${highest.toFixed(2)} m above its mount, into the slab`);
    if (!(headHigh < battenLow + 1e-6)) out.push('the ceiling lamp\'s head is not under its batten');
    const lights = new TunnelLights(lit, new TunnelLightAssets(), 64);
    lights.update(room.x, room.z);
    if (lights.lampCount !== Math.min(64, expected)) {
      out.push(`standing in the room draws ${lights.lampCount} lamps; ${Math.min(64, expected)} hang there`);
    }
    lights.setField(bare);
    lights.update(room.x, room.z);
    if (lights.lampCount !== 0) out.push(`after setField to a table with no rooms, the room still draws ${lights.lampCount} lamps`);
    lights.dispose();
  }

  return out;
}
