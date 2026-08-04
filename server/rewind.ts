/**
 * Lag compensation: 250 ms of where everybody was, and the lookup that reads it.
 *
 * Spec 8.2 asks for the punch to be *"server-authoritative with lag compensation
 * -- rewind remote positions to the attacker's view time before evaluating"*,
 * and spec 10 caps the rewind at 250 ms. `game/combat.ts` was written for this
 * from the first day: `hitTest(attacker, targets)` takes the target list as an
 * argument precisely so that a server can pass a rewound one, and its header
 * says so in as many words. This file is the thing that produces that list.
 *
 * ---------------------------------------------------------------------------
 * What is stored, and what deliberately is not.
 *
 * A ring of **positions and yaws only** -- five numbers per player per tick.
 * Not the whole `CombatantState`: rewinding health would let a player be killed
 * twice by two attackers looking at two different pasts, and rewinding phase
 * would let a body that has already been knocked out be hit again by a punch
 * thrown before it fell. Both are real bugs in real games and both come from the
 * same over-generalisation, which is that "rewind the world" sounds more correct
 * than "rewind where people were".
 *
 * The rule that falls out is worth stating because it decides the whole design:
 * **position is historical, everything else is current.** A punch is validated
 * against where the victim *was* and applied to who the victim *is*.
 *
 * ---------------------------------------------------------------------------
 * Interpolated rather than nearest-tick, and it is not a nicety.
 *
 * The buffer holds one sample per 60 Hz tick, so a nearest-tick lookup is
 * accurate to 8.3 ms -- which at a sprint of 8.2 m/s is **7 cm**, against spec
 * 8.2's 1.2 m reach and 0.4 m cast radius. That is 6% of the reach and would be
 * survivable on its own. What is not survivable is that the error is *biased*:
 * a client's view time never lands on a tick boundary, so rounding always
 * resolves the same direction for a given latency, and a player at a particular
 * ping would find their punches consistently landing early or late. Lerping
 * between the two bracketing samples costs four multiplies and removes the bias
 * entirely.
 *
 * ---------------------------------------------------------------------------
 * The cap is a clamp, not a rejection.
 *
 * A client claiming a 4-second-old view time is either lagging catastrophically
 * or lying, and both want the same answer: rewind as far as the cap allows and
 * evaluate there. Refusing the punch outright would make a bad connection feel
 * broken rather than merely unfair, and accepting the claim would let anyone
 * punch people where they stood four seconds ago. 250 ms is spec 10's number and
 * is 15 ticks.
 */

import type { CombatantState } from '../client/src/game/combat.ts';
import { MAX_REWIND_MS, TICK_HZ } from '../client/src/net/protocol.ts';

/** 250 ms at 60 Hz, rounded up so the cap is reachable rather than nearly so. */
export const HISTORY_TICKS = Math.ceil((MAX_REWIND_MS / 1000) * TICK_HZ);

/**
 * One player's recent positions.
 *
 * Flat typed arrays and a cursor rather than an array of records, on
 * `animation.Pose`'s argument: it is not really about speed at sixteen players,
 * it is that a ring buffer written as numbers has no allocation in it at all and
 * its cost is obvious from reading it. Sixteen players is 16 x 15 x 5 floats --
 * 4.8 kB for the entire lag compensation system.
 */
export class PositionHistory {
  private readonly x = new Float64Array(HISTORY_TICKS);
  private readonly y = new Float64Array(HISTORY_TICKS);
  private readonly z = new Float64Array(HISTORY_TICKS);
  private readonly yaw = new Float64Array(HISTORY_TICKS);
  /** The server tick each slot was written on. Absolute, so wrap is free. */
  private readonly tick = new Int32Array(HISTORY_TICKS);
  private cursor = -1;
  private written = 0;

  /** Record where this player is at the end of tick `tick`. Called once per tick. */
  record(tick: number, x: number, y: number, z: number, yaw: number): void {
    this.cursor = (this.cursor + 1) % HISTORY_TICKS;
    this.x[this.cursor] = x;
    this.y[this.cursor] = y;
    this.z[this.cursor] = z;
    this.yaw[this.cursor] = yaw;
    this.tick[this.cursor] = tick;
    this.written++;
  }

  /** Fill every slot with one position, so a fresh or respawned player has no gap. */
  seed(tick: number, x: number, y: number, z: number, yaw: number): void {
    for (let i = 0; i < HISTORY_TICKS; i++) {
      this.x[i] = x;
      this.y[i] = y;
      this.z[i] = z;
      this.yaw[i] = yaw;
      this.tick[i] = tick - (HISTORY_TICKS - 1 - i);
    }
    this.cursor = HISTORY_TICKS - 1;
    this.written = HISTORY_TICKS;
  }

  get samples(): number {
    return Math.min(this.written, HISTORY_TICKS);
  }

  /**
   * Where this player was at `at` ticks (fractional), interpolated.
   *
   * `at` is an absolute server tick with a fraction -- 3011.4 is four tenths of
   * the way through tick 3011 -- because the caller derives it from a
   * millisecond latency and quantising that to a tick before it gets here would
   * reintroduce exactly the bias the interpolation exists to remove.
   *
   * Returns false when there is no history at all, which is the first tick after
   * a join. The caller's answer to that is to use the current position, which is
   * correct: a player who has existed for one tick has not moved.
   */
  sampleAt(at: number, out: { x: number; y: number; z: number; yaw: number }): boolean {
    const n = this.samples;
    if (n === 0) return false;

    const newest = this.tick[this.cursor];
    const oldestIndex = (this.cursor - (n - 1) + HISTORY_TICKS * 2) % HISTORY_TICKS;
    const oldest = this.tick[oldestIndex];

    // Past the newest sample -- a client whose view time is *ahead* of the
    // server, which happens on every clock-sync overshoot -- is the current
    // position and not an extrapolation. Extrapolating a running player forward
    // is how a hit test starts landing on where somebody is about to be.
    if (at >= newest) {
      this.read(this.cursor, out);
      return true;
    }
    if (at <= oldest) {
      this.read(oldestIndex, out);
      return true;
    }

    // The ring is written one slot per tick in order, so the slot holding tick
    // `t` is `cursor - (newest - t)`. No search.
    const back = newest - at;
    const older = Math.floor(back);
    const frac = back - older;
    const iNewer = (this.cursor - older + HISTORY_TICKS * 2) % HISTORY_TICKS;
    const iOlder = (this.cursor - older - 1 + HISTORY_TICKS * 2) % HISTORY_TICKS;

    out.x = this.x[iNewer] + (this.x[iOlder] - this.x[iNewer]) * frac;
    out.y = this.y[iNewer] + (this.y[iOlder] - this.y[iNewer]) * frac;
    out.z = this.z[iNewer] + (this.z[iOlder] - this.z[iNewer]) * frac;
    // Yaw is an angle: lerping 6.2 and 0.1 the naive way sweeps the long way
    // round and puts a rewound player facing backwards for one tick. Nothing
    // reads a rewound yaw today -- the hit test uses the *attacker's* current
    // one -- and it is done correctly anyway, because the day something does
    // read it the failure would be a punch that lands in the wrong direction
    // with no way to see why.
    const a = this.yaw[iNewer];
    const b = this.yaw[iOlder];
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    out.yaw = a + d * frac;
    return true;
  }

  private read(i: number, out: { x: number; y: number; z: number; yaw: number }): void {
    out.x = this.x[i];
    out.y = this.y[i];
    out.z = this.z[i];
    out.yaw = this.yaw[i];
  }
}

/**
 * A stand-in combatant carrying a historical position and a live everything else.
 *
 * `hitTest` reads `id`, `body.position`, `phase` and `health`.
 *
 * It is the melee's mechanism and only the melee's. The ranged weapon is a
 * thrown ball that lives in the world for a second, and `server/sim.ts` tests it
 * against the **live** roster rather than a rewound one -- see the note there,
 * and `game/footy.ts`'s `stepFooty`, for why rewinding an object everybody can
 * already see would be the wrong question.
 * The rewound view has to satisfy all four, and the *split* between which come
 * from the past and which from the present is the whole of this file's design --
 * see the header. Rather than clone a `CombatantState` (which would copy fifteen
 * fields, twelve of which must not be historical, and would quietly become wrong
 * the day a sixteenth is added), each proxy holds a reference to the live state
 * and overrides exactly the two fields that are rewound.
 *
 * The proxies are pooled per attacker rather than allocated: this runs once per
 * strike, which at sixteen players trading punches is a few dozen times a
 * second, and every one of them would otherwise be sixteen objects.
 */
export interface RewoundView {
  readonly id: number;
  readonly body: { position: { x: number; y: number; z: number }; yaw: number };
  readonly phase: string;
  readonly health: number;
}

/**
 * Build the rewound target list for one attacker.
 *
 * `viewTick` is the absolute (fractional) server tick the attacker was looking
 * at, which the caller derives from that client's measured latency, clamped to
 * `HISTORY_TICKS`. Bots pass the current tick and are therefore not rewound at
 * all, which is correct: a bot's input arrives with no latency because it never
 * left the process.
 *
 * The attacker itself is passed through **unrewound**. Rewinding the attacker
 * would evaluate the punch from where they were rather than from where they are,
 * which is the opposite of lag compensation -- the whole point is that the
 * attacker's own view is authoritative and everyone else's position is the thing
 * being reconciled to it.
 */
export function rewind(
  attacker: CombatantState,
  live: readonly CombatantState[],
  histories: Map<number, PositionHistory>,
  viewTick: number,
  pool: CombatantState[],
): CombatantState[] {
  pool.length = 0;
  const at = { x: 0, y: 0, z: 0, yaw: 0 };
  for (const c of live) {
    if (c.id === attacker.id) {
      pool.push(c);
      continue;
    }
    const history = histories.get(c.id);
    if (!history || !history.sampleAt(viewTick, at)) {
      pool.push(c);
      continue;
    }
    // A shallow clone with a substituted body. `Object.create` keeps the
    // prototype-free plain-object shape the rest of the simulation expects while
    // making every field except the two below read straight through to the live
    // state -- so a health that changes between building this list and reading
    // it is seen, and a position that changes is not.
    const view = Object.create(c) as CombatantState;
    Object.defineProperty(view, 'body', {
      value: { ...c.body, position: { x: at.x, y: at.y, z: at.z }, yaw: at.yaw },
      enumerable: true,
    });
    pool.push(view);
  }
  return pool;
}

/**
 * Map a rewound view back to the live combatant it stands for.
 *
 * `hitTest` returns one of the objects it was given, which for a remote target
 * is a proxy. Applying damage to the proxy would write into an object that is
 * thrown away at the end of the tick -- a punch that connects, plays its sound,
 * shakes the camera and does nothing at all, which is the single most confusing
 * failure this whole file could produce.
 */
export function resolveLive(
  view: CombatantState | null,
  live: readonly CombatantState[],
): CombatantState | null {
  if (view === null) return null;
  for (const c of live) if (c.id === view.id) return c;
  return null;
}

// --- The self-check -----------------------------------------------------------

/**
 * That the ring returns interpolated historical positions, and that the two
 * clamps hold.
 *
 * All three failures are silent in this project's sense. A ring whose index
 * arithmetic is off by one rewinds to the wrong tick, which at 8.2 m/s is 14 cm
 * -- a punch that misses by a hand's width, at one particular latency, which
 * reads as the hit test being generous or mean rather than as an index. A lookup
 * that does not interpolate is the 7 cm bias the header describes. And a cap
 * that does not clamp lets a lagging client punch people where they were half a
 * second ago, which the victim experiences as being hit from behind by nothing.
 */
export function verifyRewind(): string[] {
  const failures: string[] = [];

  // A player running due east at exactly 1 m per tick, recorded over the full
  // window. The straight line is the point: the interpolated answer at any
  // fractional tick has a closed form, so the assertion is against arithmetic
  // rather than against another implementation of the same lerp.
  const h = new PositionHistory();
  for (let t = 0; t < HISTORY_TICKS; t++) h.record(1000 + t, t, 5, -t * 2, t * 0.1);
  const newest = 1000 + HISTORY_TICKS - 1;
  const at = { x: 0, y: 0, z: 0, yaw: 0 };

  for (const back of [0, 1, 2.5, 7.25, HISTORY_TICKS - 1]) {
    h.sampleAt(newest - back, at);
    const wantX = HISTORY_TICKS - 1 - back;
    if (Math.abs(at.x - wantX) > 1e-9) {
      failures.push(
        `Rewinding ${back} ticks gave x ${at.x.toFixed(4)}, not ${wantX.toFixed(4)}. ` +
          `The ring's index arithmetic is out.`,
      );
    }
    if (Math.abs(at.z - -wantX * 2) > 1e-9) {
      failures.push(`Rewinding ${back} ticks gave z ${at.z.toFixed(4)}, not ${(-wantX * 2).toFixed(4)}.`);
    }
    if (Math.abs(at.y - 5) > 1e-12) failures.push(`Rewinding moved a constant y to ${at.y}.`);
  }

  // Halfway between two ticks must be halfway between two positions -- which is
  // the whole claim about interpolation, and the one a nearest-tick lookup
  // fails.
  h.sampleAt(newest - 3.5, at);
  const midpoint = HISTORY_TICKS - 4.5;
  if (Math.abs(at.x - midpoint) > 1e-9) {
    failures.push(
      `A lookup half a tick between samples gave x ${at.x.toFixed(4)}, not ${midpoint.toFixed(4)}. ` +
        `A nearest-tick lookup is a biased 7 cm at a sprint -- see the header.`,
    );
  }

  // Both clamps. Beyond the window is the oldest sample; ahead of the newest is
  // the newest, never an extrapolation.
  h.sampleAt(newest - HISTORY_TICKS * 4, at);
  if (Math.abs(at.x - 0) > 1e-9) {
    failures.push(`A rewind past the ${HISTORY_TICKS}-tick window gave x ${at.x}, not the oldest sample's 0.`);
  }
  h.sampleAt(newest + 30, at);
  if (Math.abs(at.x - (HISTORY_TICKS - 1)) > 1e-9) {
    failures.push(`A rewind ahead of the newest sample extrapolated to x ${at.x}. It must clamp.`);
  }

  // The yaw seam. 6.2 to 0.1 is 0.18 rad the short way and 6.1 the long way; a
  // naive lerp halfway lands at 3.15, which is facing the other direction.
  {
    const g = new PositionHistory();
    g.record(0, 0, 0, 0, 6.2);
    g.record(1, 0, 0, 0, 0.1);
    g.sampleAt(0.5, at);
    const wrapped = ((at.yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    if (wrapped > 1 && wrapped < 5.28) {
      failures.push(
        `Interpolating yaw 6.2 to 0.1 gave ${wrapped.toFixed(3)}; the short way round is ` +
          `about 6.28 or 0.02, not the far side of the circle.`,
      );
    }
  }

  // An empty ring reports that it has nothing, rather than reporting the origin.
  {
    const empty = new PositionHistory();
    if (empty.sampleAt(0, at)) failures.push('An empty history claimed to have a sample. A join would rewind to (0,0,0).');
  }

  // And `seed` fills the whole window, so a respawned player is not briefly
  // rewindable to where they died.
  {
    const s = new PositionHistory();
    s.seed(500, 42, 7, -9, 1.5);
    if (s.samples !== HISTORY_TICKS) failures.push(`seed() left ${s.samples} samples, not ${HISTORY_TICKS}.`);
    s.sampleAt(500 - HISTORY_TICKS + 1, at);
    if (Math.abs(at.x - 42) > 1e-9) failures.push('A seeded history does not cover the whole rewind window.');
  }

  return failures;
}
