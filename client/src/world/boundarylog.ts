/**
 * Which distance boundary the player just crossed, so a stall can be blamed on
 * one instead of on a hypothesis.
 *
 * ---------------------------------------------------------------------------
 * ## The question this exists to settle
 *
 * The freeze is reported as "about every ten seconds", and both reports were at
 * constant speed -- a long train ride and driving. **At constant speed distance
 * is time**, and this game streams on distance, so the period is very likely a
 * threshold in metres rather than a timer in milliseconds. Six of them fit:
 *
 *     RING_CACHE_STEP_M       125 m    2.8 s at 44 m/s
 *     COLLISION_LOAD_RADIUS_M 420 m    9.5 s
 *     TRAFFIC_DRAW_RADIUS     420 m    9.5 s
 *     tile grid               500 m   11.4 s
 *     shadow role hysteresis  580 m   13.2 s
 *     GROUND_REVEAL_RADIUS_M  600 m   13.6 s
 *
 * Anything from 350 m to 600 m produces "about ten seconds" at driving speed.
 * Reading cannot choose between them. Counting can, and this is the counter.
 *
 * ## IT ONLY TRACKS THE TWO THAT ARE FUNCTIONS OF POSITION, AND THAT IS A
 * DEVIATION FROM THE BRIEF WORTH EXPLAINING
 *
 * The instruction said to count all six. Four of them cannot be counted here and
 * should not be faked: a *radius* is not something the player crosses, it is
 * something **tiles** cross, and whether a tile passed 420 m of the camera this
 * frame is a fact the streamer already holds. Re-deriving it from the player's
 * position would mean reimplementing the resident set in this file and then
 * having two answers to one question -- which is the failure mode this codebase
 * names in six different headers.
 *
 * So this file counts the two boundaries that genuinely are pure functions of
 * where the player is standing, and the streamer's own monotonic counters --
 * tiles built, sheets placed -- carry the other four into the same stall record.
 * Between them every candidate in the table above is covered, and nothing is
 * counted twice.
 *
 * ## Straight-line from the anchor, not path length
 *
 * The ring test mirrors `streamer.RING_CACHE_STEP_M` exactly: the distance from
 * the point the ring was last recomputed at, not the distance walked. A player
 * pacing a five-metre circle for a minute has walked three hundred metres and
 * has not moved, and the streamer knows that. If this file used path length it
 * would report ring crossings the streamer never made, and the correlation --
 * the entire point -- would be noise.
 *
 * Pure, three-free and allocation-free on the hot path, so both boot lists read
 * `verifyBoundaryLog` and the frame loop pays a subtraction.
 */

/** `streamer.RING_CACHE_STEP_M`. Mirrored, not imported: that constant is private. */
export const RING_STEP_M = 125;

/** What `note` gives back. Reused, so a frame allocates nothing. */
export interface Crossing {
  /** `''`, `'grid'`, `'ring'`, or `'grid ring'`. Straight onto the stall record. */
  crossed: string;
  /** Metres per second over the last frame, or 0 on the first. */
  speed: number;
  /** Metres since the ring anchor, for a console handle. */
  sinceRingM: number;
}

export class BoundaryLog {
  private readonly gridM: number;
  private readonly ringM: number;
  private cellX = 0;
  private cellZ = 0;
  private anchorX = 0;
  private anchorZ = 0;
  private lastX = 0;
  private lastZ = 0;
  private started = false;
  private readonly out: Crossing = { crossed: '', speed: 0, sinceRingM: 0 };

  /** How many of each this session. Read by the console handle, not the ring. */
  gridCrossings = 0;
  ringCrossings = 0;

  /**
   * `gridM` is the world index's `tile_size`, handed in rather than assumed:
   * a build with a different tile size would otherwise silently count the wrong
   * boundary and the answer would be wrong in a way nothing could catch.
   */
  constructor(gridM: number, ringM: number = RING_STEP_M) {
    this.gridM = gridM > 0 ? gridM : 500;
    this.ringM = ringM > 0 ? ringM : RING_STEP_M;
  }

  note(x: number, z: number, dt: number): Crossing {
    const out = this.out;
    out.crossed = '';
    out.speed = 0;
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      out.sinceRingM = 0;
      return out;
    }
    if (!this.started) {
      this.started = true;
      this.cellX = Math.floor(x / this.gridM);
      this.cellZ = Math.floor(z / this.gridM);
      this.anchorX = x;
      this.anchorZ = z;
      this.lastX = x;
      this.lastZ = z;
      out.sinceRingM = 0;
      return out;
    }

    const dx = x - this.lastX;
    const dz = z - this.lastZ;
    this.lastX = x;
    this.lastZ = z;
    out.speed = dt > 1e-6 ? Math.sqrt(dx * dx + dz * dz) / dt : 0;

    // The grid. A move that changes both axes at once is **one** crossing, not
    // two: what is being counted is "the player entered a new tile", and a
    // diagonal entry is one entry.
    const cx = Math.floor(x / this.gridM);
    const cz = Math.floor(z / this.gridM);
    let crossed = '';
    if (cx !== this.cellX || cz !== this.cellZ) {
      this.cellX = cx;
      this.cellZ = cz;
      this.gridCrossings++;
      crossed = 'grid';
    }

    // The ring, from the anchor. See the header on why not path length.
    const ax = x - this.anchorX;
    const az = z - this.anchorZ;
    const since = Math.sqrt(ax * ax + az * az);
    out.sinceRingM = since;
    if (since >= this.ringM) {
      this.anchorX = x;
      this.anchorZ = z;
      this.ringCrossings++;
      out.sinceRingM = 0;
      crossed = crossed === '' ? 'ring' : `${crossed} ring`;
    }
    out.crossed = crossed;
    return out;
  }
}

export function verifyBoundaryLog(): string[] {
  const failures: string[] = [];
  const GRID = 500;

  // --- A straight kilometre across a 500 m grid crosses it exactly twice.
  {
    const log = new BoundaryLog(GRID);
    let grid = 0;
    for (let i = 0; i <= 1000; i++) {
      if (log.note(i, 0, 1 / 60).crossed.includes('grid')) grid++;
    }
    if (grid !== 2) failures.push(`A straight 1,000 m walk reported ${grid} grid crossings, not 2.`);
    if (log.gridCrossings !== 2) failures.push(`The session counter says ${log.gridCrossings} grid crossings.`);
  }

  // --- The ring: 124 m is not a crossing and 126 m is.
  {
    const under = new BoundaryLog(GRID);
    under.note(0, 0, 1 / 60);
    if (under.note(124, 0, 1 / 60).crossed.includes('ring')) failures.push('A 124 m step reported a ring crossing.');
    const over = new BoundaryLog(GRID);
    over.note(0, 0, 1 / 60);
    if (!over.note(126, 0, 1 / 60).crossed.includes('ring')) failures.push('A 126 m step reported no ring crossing.');
  }

  // --- Standing still reports nothing, forever.
  {
    const log = new BoundaryLog(GRID);
    for (let i = 0; i < 5000; i++) {
      if (log.note(250, 250, 1 / 60).crossed !== '') {
        failures.push('A player standing still crossed a boundary.');
        break;
      }
    }
    if (log.gridCrossings !== 0 || log.ringCrossings !== 0) {
      failures.push(`Standing still counted ${log.gridCrossings} grid and ${log.ringCrossings} ring crossings.`);
    }
  }

  // --- A diagonal that changes both tile axes is one crossing, not two.
  {
    const log = new BoundaryLog(GRID);
    log.note(499, 499, 1 / 60);
    const c = log.note(501, 501, 1 / 60);
    if (log.gridCrossings !== 1) failures.push(`A diagonal tile entry counted ${log.gridCrossings} crossings, not 1.`);
    if (c.crossed.split(' ').filter((s) => s === 'grid').length !== 1) {
      failures.push(`A diagonal entry reported "${c.crossed}"; grid must appear once.`);
    }
  }

  // --- Pacing a small circle walks a long way and never moves.
  {
    // 5 m radius, 400 laps: about 12.5 km of path length and 0 m of displacement.
    const log = new BoundaryLog(GRID);
    for (let i = 0; i <= 400 * 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      log.note(250 + Math.cos(a) * 5, 250 + Math.sin(a) * 5, 1 / 60);
    }
    if (log.ringCrossings !== 0) {
      failures.push(
        `Pacing a 5 m circle reported ${log.ringCrossings} ring crossings. ` +
          'The test is displacement from the anchor, not path length.',
      );
    }
  }

  // --- The speed is right, which is the number the whole question turns on.
  {
    const log = new BoundaryLog(GRID);
    log.note(0, 0, 1 / 60);
    const c = log.note(44 / 60, 0, 1 / 60);
    if (Math.abs(c.speed - 44) > 0.01) failures.push(`44 m/s read as ${c.speed.toFixed(2)} m/s.`);
    const still = log.note(44 / 60, 0, 1 / 60);
    if (still.speed !== 0) failures.push(`A stationary frame read ${still.speed} m/s.`);
  }

  // --- The first call establishes the anchor and reports nothing.
  {
    const log = new BoundaryLog(GRID);
    const first = log.note(99999, -99999, 1 / 60);
    if (first.crossed !== '') failures.push('The first frame of a session reported a crossing.');
  }

  // --- A non-finite position is survived rather than latched into the state.
  {
    const log = new BoundaryLog(GRID);
    log.note(0, 0, 1 / 60);
    log.note(NaN, 0, 1 / 60);
    const back = log.note(600, 0, 1 / 60);
    if (!back.crossed.includes('grid')) failures.push('A NaN position broke the grid tracking that followed it.');
  }

  // --- A different tile size is honoured rather than assumed.
  {
    const log = new BoundaryLog(250);
    let grid = 0;
    for (let i = 0; i <= 1000; i++) if (log.note(i, 0, 1 / 60).crossed.includes('grid')) grid++;
    if (grid !== 4) failures.push(`On a 250 m grid a 1,000 m walk reported ${grid} crossings, not 4.`);
  }

  return failures;
}
