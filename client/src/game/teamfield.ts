/**
 * `TeamLookup`, implemented: your own talents, plus your teammates' auras, plus
 * the group clauses on a mega -- resolved once per tick against a spatial hash.
 *
 * `game/teams.ts` is the contract and this is the only thing that answers it.
 * The gameplay hooks call `scalar(playerId, FX.SWING_DAMAGE)` and never learn
 * that some of that 0.2 came from a person standing eleven metres away; the
 * renderer calls `teamOf` and never learns what a mask is. One class, run in
 * both runtimes -- `Simulation.teams` on the server, and the client's own copy
 * fed from the `MSG.TALENTS` mirror so a prediction and an adjudication agree.
 *
 * ---------------------------------------------------------------------------
 * ## The three layers, and why they are three
 *
 * 1. **Own.** Every node in your mask, folded by `ownScalar`'s rule: additive
 *    keys sum, `MAX_WINS` keys take the largest, `MIN_WINS` keys the smallest.
 *    This layer is exactly `ownScalar` and is asserted against it -- see
 *    `verifyTeamField`, which drives randomised masks through both.
 * 2. **Auras.** For every **teammate** within `AURA_M` who has taken a node
 *    marked `aura`, that node's effects are added to you as well. Not to
 *    enemies, not to the unaligned, and not to you from your own aura node --
 *    you already have that one from layer 1, and adding it twice would make
 *    Glassing +40% swing damage for its owner and +20% for everybody else.
 * 3. **Groups.** A mega with a `group` count contributes its `GROUP_*` effects
 *    only while that many teammates are within `GROUP_M`. The mega's *other*
 *    effects (the once-a-day ability, usually) are layer 1 and are always on.
 *
 * ### Stacking, and where the cap comes from
 *
 * Two people with Tip Jar standing beside you is a real situation and the node
 * text says what happens: *"Stacks across Tip Jars, capped at 3."* Sizzle Aura
 * says *"Stack cap 2."* Nothing else says anything, and the default for an
 * additive aura key is therefore **one stack** -- Glassing's own text describes
 * two players sharing it as *"a wall"*, not as +40%, and an uncapped additive
 * aura is a mechanic that rewards standing in a pile rather than playing.
 *
 * The caps live in `AURA_STACKS` below, keyed by node id, with the sentence
 * they came from quoted beside each. `verifyTeamField` greps every aura node's
 * effect text for the word "cap" and fails if the table disagrees, so a new aura
 * node whose text promises a stack cap cannot ship without one.
 *
 * ### One wrinkle, stated rather than silently fixed
 *
 * `FX.REGEN_PIP_S` is *seconds per pip*, so "two stacks" adding to 40 is
 * arithmetically backwards -- two sizzles should regenerate faster, not slower.
 * The contract does not list the key in `MIN_WINS` and its own `ownScalar` adds
 * it, and this file's whole correctness argument is that it agrees with
 * `ownScalar`; making the aura path disagree with the own path for one key would
 * be worse than the wrinkle. So it adds, capped at two stacks as the node says,
 * and the fix -- when the hook that consumes it is written -- is to make the key
 * a *rate* (`regenPipsPerMin`) in the contract, at which point adding is right
 * everywhere and nothing here changes. Flagged for workstream W.
 *
 * ---------------------------------------------------------------------------
 * ## Cost, and why it is lazy
 *
 * PERFORMANCE.md's budget is O(players) per tick on one vCPU. The hash is
 * refilled every tick -- one `insert` per player, which is what `buildLiveIndex`
 * already pays for the melee -- and **nothing else happens until somebody
 * asks**. A room where nobody has reached level 2 does one `clear` and N
 * `insert`s a tick and no folding at all; a room where everybody has a build
 * pays, per player who is actually queried, one walk of their own ≤10 taken
 * nodes plus one `collectWithin` at 12 m.
 *
 * The fold is cached per player per tick in a `Map<FxKey, number>` that is
 * **cleared and refilled rather than reallocated**, so a steady state allocates
 * nothing. The taken-node list behind it is rebuilt only when the mask actually
 * changes, which is a handful of times a week per player -- so the ordinary
 * tick's own-layer walk is over an array that already exists.
 *
 * ---------------------------------------------------------------------------
 * ## Determinism
 *
 * `game/traffic.ts`'s rule: no `Math.hypot`, no transcendentals. Distances are
 * compared squared, in metres, and the spatial hash is integer arithmetic by
 * construction (see `game/spatialhash.ts`). Two runtimes handed the same members
 * produce the same numbers, which is the property that lets the client predict a
 * swing the server is about to adjudicate.
 */

import {
  AURA_M,
  FX,
  GROUP_M,
  NODES,
  TEAM,
  hasNode,
  type FxKey,
  type TalentMask,
  type TalentNode,
  type Team,
  type TeamLookup,
  ownScalar,
} from './teams.ts';
import { SpatialHash } from './spatialhash.ts';

/**
 * The keys that take the largest value rather than the sum, and the ones that
 * take the smallest.
 *
 * **These are `game/teams.ts`'s own two sets, which are module-private there.**
 * They are re-stated rather than exported because the contract is not mine to
 * edit, and the risk that creates -- two tables drifting apart -- is closed by
 * `verifyTeamField`, which drives randomised masks through this file's fold and
 * through the contract's `ownScalar` and requires the two to agree exactly on
 * every key. A key added to one set and not the other fails the boot.
 */
const MAX_WINS = new Set<string>([
  FX.TAKE_RADIUS_M,
  FX.TAKEABLE_SPEED,
  FX.TRAFFIC_HOLD_GAP_M,
  FX.RBT_STAND_S,
  FX.FARE_RADIUS_M,
  FX.CENTRELINK_AMOUNT,
  FX.PARK_SNAP_M,
  FX.POLAIR_LOCK_SLOW,
]);
const MIN_WINS = new Set<string>([
  FX.BALL_RECHARGE_S,
  FX.CRASH_COOLDOWN_S,
  FX.PATROL_RANGE_M,
  FX.CENTRELINK_DAYS,
  FX.DEATH_DROP,
  FX.DASH_CD_S,
]);

/**
 * The four keys that a mega only grants while the group is standing with you.
 *
 * A set rather than a `startsWith('group')` test, because a key named
 * `groupwareDiscount` would silently join it and because the four are a closed
 * list the contract names in one place.
 */
const GROUP_KEYS = new Set<string>([FX.GROUP_PIPS, FX.GROUP_REGEN_X, FX.GROUP_NO_KNOCKDOWN, FX.GROUP_KNOCKBACK_M]);

/**
 * How many teammates' copies of one aura node can stack on you, by node id.
 *
 * Quoted from the node text, which is where the numbers actually come from:
 *
 *   - **12, Tip Jar** -- *"Stacks across Tip Jars, capped at 3."*
 *   - **33, Sizzle Aura** -- *"Stack cap 2."*
 *
 * Everything not listed is one. See the header for why one is the right default
 * and not an oversight.
 */
const AURA_STACKS = new Map<number, number>([
  [12, 3],
  [33, 2],
]);

/** Squared, so nothing here takes a square root. See the header's determinism note. */
const AURA_M2 = AURA_M * AURA_M;
const GROUP_M2 = GROUP_M * GROUP_M;

/**
 * What the field is told about one player each tick.
 *
 * A flat record rather than a `Participant` or a `RosterEntry`, because the two
 * runtimes have neither type in common -- the server has bodies and the client
 * has interpolated remotes -- and the five numbers below are the whole of what
 * this file needs from either.
 */
export interface TeamMember {
  id: number;
  x: number;
  z: number;
  team: Team;
  mask: Readonly<TalentMask>;
}

/** The live record, reused across ticks so a steady state allocates nothing. */
interface MemberState {
  id: number;
  x: number;
  z: number;
  team: Team;
  lo: number;
  hi: number;
  /** The tick this record was last `place`d on. Older than the current one means gone. */
  seen: number;
  /**
   * The tick this record was last put in the hash.
   *
   * Separate from `seen` so that a second `place` inside one tick -- which is
   * what applying a `TAKE` mid-tick looks like -- refreshes the mask without
   * filing the same body twice. Two entries for one player would count their
   * aura twice, which is the one bug in this file that would look like a
   * balance decision.
   */
  filed: number;
  /** The nodes this mask contains, rebuilt only when the mask changes. */
  taken: TalentNode[];
  /** The subset of `taken` marked `aura`, so the neighbour walk is over two entries and not ten. */
  auras: TalentNode[];
  /** The subset of `taken` that is a mega with a `group` clause. Almost always empty. */
  groups: TalentNode[];
  /** The folded effects, and the tick they were folded on. */
  fx: Map<string, number>;
  fxTick: number;
}

export class TeamField implements TeamLookup {
  private readonly members = new Map<number, MemberState>();
  /**
   * The proximity index. Its own hash rather than a borrowed one, because the
   * server's `liveIndex` is keyed by `CombatantState` and this needs the team
   * record beside the position -- and because the client has no `liveIndex` at
   * all. It costs one `clear` and N `insert`s a tick; see `game/spatialhash.ts`,
   * whose header does the arithmetic on why that is free.
   */
  private readonly hash = new SpatialHash<MemberState>();
  private tick = -1;
  /** Nobody on a side means every query is a constant. See `begin`. */
  private live = false;
  private readonly neighbours: MemberState[] = [];

  /**
   * Start a tick: drop anybody who was not `place`d on the last one, and empty
   * the index.
   *
   * The prune is here rather than in a `leave(id)` the caller has to remember,
   * on `Simulation.step`'s own argument about departures: a caller that forgets
   * is a record that lives forever, and the thing it would grant is an aura from
   * a player who has left the game. One tick of grace, because `place` is called
   * *after* this and a member placed every tick is never a tick behind.
   */
  begin(tick: number): void {
    this.tick = tick;
    this.hash.clear();
    this.live = false;
    if (this.members.size === 0) return;
    for (const [id, m] of this.members) {
      if (m.seen < tick - 1) this.members.delete(id);
    }
  }

  /** File one player at the position they are standing at this tick. */
  place(member: TeamMember): void {
    let m = this.members.get(member.id);
    if (m === undefined) {
      m = {
        id: member.id, x: 0, z: 0, team: TEAM.NONE, lo: -1, hi: -1, seen: this.tick, filed: -1,
        taken: [], auras: [], groups: [], fx: new Map(), fxTick: -1,
      };
      this.members.set(member.id, m);
    }
    m.x = member.x;
    m.z = member.z;
    m.seen = this.tick;
    const lo = member.mask.lo >>> 0;
    const hi = member.mask.hi >>> 0;
    // Rebuilt only when something actually moved. A mask changes when a point is
    // spent, which is a handful of times a week; a team changes once ever. The
    // `lo: -1` a fresh record starts at is deliberately not a reachable mask, so
    // the first `place` always builds.
    if (m.lo !== lo || m.hi !== hi || m.team !== member.team) {
      m.lo = lo;
      m.hi = hi;
      m.team = member.team;
      rebuildNodes(m);
      // The fold is stale by construction, and saying so here rather than
      // relying on the tick compare covers the one case the tick cannot: two
      // `place` calls for the same player inside one tick, which is what a
      // `TAKE` applied mid-tick looks like.
      m.fxTick = -1;
    }
    if (member.team !== TEAM.NONE) this.live = true;
    if (m.filed === this.tick) return;
    m.filed = this.tick;
    this.hash.insert(m, member.x, member.z);
  }

  // --- The lookup ---------------------------------------------------------------

  teamOf(playerId: number): Team {
    return this.members.get(playerId)?.team ?? TEAM.NONE;
  }

  scalar(playerId: number, key: FxKey): number {
    if (!this.live) return 0;
    const m = this.members.get(playerId);
    if (m === undefined || m.team === TEAM.NONE) return 0;
    if (m.fxTick !== this.tick) this.fold(m);
    return m.fx.get(key) ?? 0;
  }

  flag(playerId: number, key: FxKey): boolean {
    return this.scalar(playerId, key) > 0;
  }

  /** Everybody the field currently knows about. For checks and for the panel. */
  get size(): number {
    return this.members.size;
  }

  // --- The fold -----------------------------------------------------------------

  private fold(m: MemberState): void {
    m.fxTick = this.tick;
    const fx = m.fx;
    fx.clear();

    // --- Layer 3's precondition, computed before layer 1 because a mega's group
    // keys are part of its own node. Almost always skipped: `groups` is empty
    // for everybody without a group mega, which at ten points is everybody
    // except a DeFAULT who committed a whole tree.
    const groupOk = m.groups.length === 0 ? false : this.groupHolds(m);

    // --- Layer 1: your own nodes.
    for (const nd of m.taken) {
      const skipGroup = nd.group !== undefined && !groupOk;
      apply(fx, nd, skipGroup);
    }

    // --- Layer 2: your teammates' auras.
    //
    // `collectWithin` answers a conservative superset -- see the spatial hash's
    // contract -- so the circle test is done here, squared. Stacks are counted
    // per node id against `AURA_STACKS`, in the hash's ascending insertion
    // order, which is the same order on both ends: two runtimes that admitted a
    // *different* three of five Tip Jars would disagree about a number the
    // server is about to adjudicate a payout with.
    this.forEachAura(m, (nd) => {
      // A teammate's aura never brings its group clause with it: a group is
      // a fact about who is standing around *you*, and `nd.group` is only
      // ever set on a mega, which is never `aura`. Passed anyway so the one
      // rule lives in one place.
      apply(fx, nd, nd.group !== undefined);
    });
  }

  /**
   * The teammates' aura nodes that apply to `m`, admitted once each under
   * `AURA_STACKS` and in the hash's ascending insertion order.
   *
   * **Extracted so that the fold and the payout cannot disagree.** The comment
   * above says two runtimes admitting a different three of five Tip Jars would
   * disagree about a number the server is about to adjudicate a payout with --
   * and the same is true of two *call sites* in one runtime. `TEAM_TITHE` pays
   * the holders of the very nodes this walk admits, so it has to be the same
   * walk, in the same order, under the same caps, and not a second copy of the
   * rule that starts out identical and drifts.
   *
   * The visitor gets the node and the member it came from, because the fold
   * only needs the node and the payout only needs the member.
   */
  private forEachAura(m: MemberState, visit: (nd: TalentNode, from: MemberState) => void): void {
    const near = this.hash.collectWithin(m.x, m.z, AURA_M, this.neighbours);
    if (near.length > 1) {
      const stacks = STACK_SCRATCH;
      stacks.clear();
      for (const o of near) {
        if (o === m || o.team !== m.team) continue;
        if (o.auras.length === 0) continue;
        const dx = o.x - m.x;
        const dz = o.z - m.z;
        if (dx * dx + dz * dz > AURA_M2) continue;
        for (const nd of o.auras) {
          const cap = AURA_STACKS.get(nd.id) ?? 1;
          const used = stacks.get(nd.id) ?? 0;
          if (used >= cap) continue;
          stacks.set(nd.id, used + 1);
          visit(nd, o);
        }
      }
    }
    near.length = 0;
  }

  /**
   * Who is owed a cut of what `earnerId` just made, and how much of it.
   *
   * `Tip Jar` is the only node with a `TEAM_TITHE` effect today: *"you get $2 of
   * every $20 they make"*. The money is **minted, not deducted** -- the earner
   * keeps every dollar of their own -- which is the same shape as `TEAM_EARN`
   * sitting beside it in the same node, and is what the node's text says: the
   * jar holder gets a cut, the worker is not taxed.
   *
   * Visits each holder once with the fraction their node carries, in the fold's
   * order and under the fold's caps, so a fourth Tip Jar standing in a huddle
   * of three is paid nothing rather than paid a fourth share -- the same
   * sentence the earner's own +10% obeys.
   *
   * Silent for an earner with no side, nobody near, or nothing on this key,
   * which is very nearly always: the walk is the fold's walk and it is already
   * paid for once a tick.
   */
  forEachTithe(earnerId: number, visit: (holderId: number, fraction: number) => void): void {
    if (!this.live) return;
    const m = this.members.get(earnerId);
    if (m === undefined || m.team === TEAM.NONE) return;
    this.forEachAura(m, (nd, from) => {
      for (const [key, value] of nd.effects) {
        if (key === FX.TEAM_TITHE && value > 0) visit(from.id, value);
      }
    });
  }

  /**
   * Are there enough teammates within `GROUP_M`?
   *
   * The count is of **other** members on your side, which is the reading the
   * node text forces: *"While 3+ DeFAULT are within 20 m of you"* describes a
   * car park with three other people in it, and counting yourself would make a
   * mega that needs three fire with two.
   *
   * One walk for the whole record rather than one per group mega, because both
   * megas that have a clause need the same number (3) and a second walk to ask
   * the same question twice would be the only wasteful thing in this file.
   */
  private groupHolds(m: MemberState): boolean {
    let need = Infinity;
    for (const nd of m.groups) need = Math.min(need, nd.group ?? Infinity);
    if (!Number.isFinite(need)) return false;
    const near = this.hash.collectWithin(m.x, m.z, GROUP_M, this.neighbours);
    let n = 0;
    for (const o of near) {
      if (o === m || o.team !== m.team) continue;
      const dx = o.x - m.x;
      const dz = o.z - m.z;
      if (dx * dx + dz * dz > GROUP_M2) continue;
      n++;
      if (n >= need) break;
    }
    near.length = 0;
    return n >= need;
  }
}

/**
 * One scratch map for the stack counter, shared by every fold.
 *
 * Safe because `fold` is not re-entrant -- it calls nothing that can call back
 * into the field -- and it is the difference between an allocation per queried
 * player per tick and none. `server/sim.ts` is full of this pattern and states
 * the same caveat each time.
 */
const STACK_SCRATCH = new Map<number, number>();

/** Fold one node's effects in, skipping its group-only keys when asked. */
function apply(fx: Map<string, number>, nd: TalentNode, skipGroup: boolean): void {
  for (const [k, v] of nd.effects) {
    if (skipGroup && GROUP_KEYS.has(k)) continue;
    const held = fx.get(k);
    if (held === undefined) fx.set(k, v);
    else if (MAX_WINS.has(k)) fx.set(k, Math.max(held, v));
    else if (MIN_WINS.has(k)) fx.set(k, Math.min(held, v));
    else fx.set(k, held + v);
  }
}

/** The three node lists behind a mask. Called only when the mask moves. */
function rebuildNodes(m: MemberState): void {
  m.taken.length = 0;
  m.auras.length = 0;
  m.groups.length = 0;
  if (m.team === TEAM.NONE) return;
  const mask: TalentMask = { lo: m.lo, hi: m.hi };
  for (const nd of NODES) {
    // The team test is not redundant with the mask: a bit for the other side's
    // node cannot be set by any path in `Simulation.teamOp`, but a mask off the
    // wire is a claim -- and a Marita wearing DeFAULT's Blue Line because a
    // frame said so is the one thing this file must not allow.
    if (nd.team !== m.team || !hasNode(mask, nd.id)) continue;
    m.taken.push(nd);
    if (nd.aura) m.auras.push(nd);
    if (nd.group !== undefined) m.groups.push(nd);
  }
}

// --- The self-check ---------------------------------------------------------------

/**
 * What can be wrong here without anything throwing.
 *
 * Every failure in this file is a *number*, and a number that is quietly 0.2 too
 * big is a fight that goes the wrong way with nothing on screen to explain it.
 * The three that matter:
 *
 *   - **The fold disagreeing with `ownScalar`.** The two tables above are the
 *     contract's, restated; if either drifts, every additive key that should
 *     have been a max silently doubles. Driven here over randomised masks, on
 *     every key any of them touches.
 *   - **An aura reaching the wrong people.** An enemy inside 12 m getting
 *     Glassing is the mechanic inverted; you getting your own aura twice is
 *     +40% for its owner. Both are one `continue` away.
 *   - **A stack cap that does not exist.** A node whose text promises a cap and
 *     whose id is not in `AURA_STACKS` stacks without bound, which is a pile of
 *     players earning +80% on every fare.
 */
export function verifyTeamField(): string[] {
  const failures: string[] = [];
  const M = TEAM.MARITA;
  const D = TEAM.DEFAULT;

  // --- The fold is `ownScalar`, on masks that are not hand-picked.
  //
  // A deterministic pseudo-random walk rather than `Math.random`, so a failure
  // is the same failure on the next boot -- `game/traffic.ts`'s rule about
  // ambient things being a pure function of an index, applied to a check.
  {
    const keys = new Set<string>();
    for (const nd of NODES) for (const [k] of nd.effects) keys.add(k);
    let seed = 0x2f6e2b1;
    const next = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) | 0;
      return (seed >>> 16) & 0x7fff;
    };
    for (let trial = 0; trial < 40; trial++) {
      const team = trial % 2 === 0 ? M : D;
      let mask: TalentMask = { lo: 0, hi: 0 };
      // Ten bits at random out of that team's 21 nodes, tier gates ignored: this
      // is a test of the *fold*, and a mask no player could hold is exactly the
      // input a fold must not disagree about.
      const mine = NODES.filter((n) => n.team === team);
      for (let i = 0; i < 10; i++) {
        const nd = mine[next() % mine.length];
        mask = nd.id < 32
          ? { lo: (mask.lo | (1 << nd.id)) >>> 0, hi: mask.hi }
          : { lo: mask.lo, hi: (mask.hi | (1 << (nd.id - 32))) >>> 0 };
      }
      // One player, alone in the world, so there is no aura layer to confuse it.
      const field = new TeamField();
      field.begin(trial);
      field.place({ id: 1, x: 0, z: 0, team, mask });
      for (const key of keys) {
        const want = ownScalar(mask, key as FxKey);
        const got = field.scalar(1, key as FxKey);
        // A group mega's group keys are the one legitimate disagreement: alone,
        // the group does not hold, so they are 0 here and non-zero in
        // `ownScalar`, which knows nothing about who is standing nearby.
        if (GROUP_KEYS.has(key)) {
          if (got !== 0) failures.push(`A group key (${key}) was granted to somebody standing alone: ${got}.`);
          continue;
        }
        if (Math.abs(got - want) > 1e-9) {
          failures.push(`The fold gave ${got} for ${key} where ownScalar gives ${want}; the MAX/MIN tables have drifted from the contract's.`);
        }
      }
    }
  }

  // --- An aura reaches a teammate inside the radius and nobody else.
  //
  // Tip Jar (node 12) is the brief's own example and the one with a stack cap,
  // so it is the node this section is built on.
  {
    const tipJar: TalentMask = { lo: (1 << 12) >>> 0, hi: 0 };
    const bare: TalentMask = { lo: 0, hi: 0 };

    const near = new TeamField();
    near.begin(1);
    near.place({ id: 1, x: 0, z: 0, team: M, mask: tipJar });
    near.place({ id: 2, x: 5, z: 0, team: M, mask: bare });
    near.place({ id: 3, x: 5, z: 0, team: D, mask: bare });
    near.place({ id: 4, x: 40, z: 0, team: M, mask: bare });
    if (Math.abs(near.scalar(2, FX.TEAM_EARN) - 0.1) > 1e-9) {
      failures.push(`A teammate 5 m from a Tip Jar got ${near.scalar(2, FX.TEAM_EARN)} rather than 0.1.`);
    }
    if (near.scalar(3, FX.TEAM_EARN) !== 0) {
      failures.push(`A ${'DeFAULT'} standing in a Marita aura got ${near.scalar(3, FX.TEAM_EARN)}; auras are for your own side.`);
    }
    if (near.scalar(4, FX.TEAM_EARN) !== 0) {
      failures.push(`A teammate 40 m away got ${near.scalar(4, FX.TEAM_EARN)}; ${AURA_M} m is the radius.`);
    }
    // The owner has it once, from their own node, and not twice.
    if (Math.abs(near.scalar(1, FX.TEAM_EARN) - 0.1) > 1e-9) {
      failures.push(`The Tip Jar's owner got ${near.scalar(1, FX.TEAM_EARN)} rather than 0.1; an aura must not apply to itself.`);
    }
    // And exactly at the edge it is in, one metre past it is out. The band is
    // where an off-by-one in a squared compare shows up.
    const edge = new TeamField();
    edge.begin(2);
    edge.place({ id: 1, x: 0, z: 0, team: M, mask: tipJar });
    edge.place({ id: 2, x: AURA_M, z: 0, team: M, mask: bare });
    edge.place({ id: 3, x: AURA_M + 1, z: 0, team: M, mask: bare });
    if (edge.scalar(2, FX.TEAM_EARN) === 0) failures.push(`A teammate at exactly ${AURA_M} m was outside the aura.`);
    if (edge.scalar(3, FX.TEAM_EARN) !== 0) failures.push(`A teammate at ${AURA_M + 1} m was inside the aura.`);
  }

  // --- Stacks, and the cap the node text promises.
  {
    const tipJar: TalentMask = { lo: (1 << 12) >>> 0, hi: 0 };
    const bare: TalentMask = { lo: 0, hi: 0 };
    const field = new TeamField();
    field.begin(1);
    field.place({ id: 99, x: 0, z: 0, team: TEAM.MARITA, mask: bare });
    for (let i = 0; i < 5; i++) field.place({ id: i + 1, x: 1 + i, z: 0, team: TEAM.MARITA, mask: tipJar });
    const got = field.scalar(99, FX.TEAM_EARN);
    if (Math.abs(got - 0.3) > 1e-9) {
      failures.push(`Five Tip Jars gave ${got}; the node says "capped at 3", which is 0.3.`);
    }
    // Glassing (19) has no cap in its text and therefore stacks once.
    const glassing: TalentMask = { lo: (1 << 19) >>> 0, hi: 0 };
    const wall = new TeamField();
    wall.begin(1);
    wall.place({ id: 99, x: 0, z: 0, team: TEAM.MARITA, mask: bare });
    for (let i = 0; i < 3; i++) wall.place({ id: i + 1, x: 1 + i, z: 0, team: TEAM.MARITA, mask: glassing });
    if (Math.abs(wall.scalar(99, FX.SWING_DAMAGE) - 0.2) > 1e-9) {
      failures.push(`Three Glassings gave ${wall.scalar(99, FX.SWING_DAMAGE)} swing damage; an uncapped aura defaults to one stack.`);
    }
  }

  // --- Every aura node whose text promises a cap has one in the table.
  {
    for (const nd of NODES) {
      if (!nd.aura) continue;
      const promises = /cap/i.test(nd.effect);
      const capped = (AURA_STACKS.get(nd.id) ?? 1) > 1;
      if (promises && !capped) {
        failures.push(`${nd.name} (node ${nd.id}) promises a stack cap in its text and is not in AURA_STACKS; it would stack without bound.`);
      }
      if (!promises && capped) {
        failures.push(`${nd.name} (node ${nd.id}) is capped at ${AURA_STACKS.get(nd.id)} in AURA_STACKS and says nothing about stacking in its text.`);
      }
    }
    for (const id of AURA_STACKS.keys()) {
      if (!NODES[id]?.aura) failures.push(`AURA_STACKS has a cap for node ${id}, which is not an aura node.`);
    }
  }

  // --- The group clause: the mega's own effects are always on, its GROUP_ ones
  // are not, and the count is of *other* people.
  {
    // Sunday Rush is node 34 (DeFAULT, Bunnings, mega, group 3).
    const sunday: TalentMask = { lo: 0, hi: (1 << (34 - 32)) >>> 0 };
    const bare: TalentMask = { lo: 0, hi: 0 };
    const alone = new TeamField();
    alone.begin(1);
    alone.place({ id: 1, x: 0, z: 0, team: D, mask: sunday });
    if (alone.scalar(1, FX.GROUP_PIPS) !== 0) failures.push('Sunday Rush granted its group pip to somebody standing alone.');
    if (!alone.flag(1, FX.MEGA_SIZZLE_TENT)) failures.push('Sunday Rush lost its once-a-day ability when the group was not there; only the GROUP_ keys are conditional.');

    // Two others is not three others, which is the off-by-one this counts for:
    // `group: 3` is three teammates **beside** you. See `groupHolds`.
    const two = new TeamField();
    two.begin(1);
    two.place({ id: 1, x: 0, z: 0, team: D, mask: sunday });
    two.place({ id: 2, x: 2, z: 0, team: D, mask: bare });
    two.place({ id: 3, x: 3, z: 0, team: D, mask: bare });
    if (two.scalar(1, FX.GROUP_PIPS) !== 0) failures.push('A group of 3 was satisfied by two teammates and the holder counting themselves.');

    const three = new TeamField();
    three.begin(1);
    three.place({ id: 1, x: 0, z: 0, team: D, mask: sunday });
    for (let i = 0; i < 3; i++) three.place({ id: i + 2, x: 2 + i, z: 0, team: D, mask: bare });
    if (three.scalar(1, FX.GROUP_PIPS) !== 1) failures.push('Three DeFAULT within 20 m did not satisfy a group of 3.');
    if (three.scalar(1, FX.GROUP_REGEN_X) !== 2) failures.push('A satisfied group granted one of its keys and not the other.');
    // And the teammates standing in it get nothing from it, because the mega is
    // the holder's node and only `aura` nodes reach other people.
    if (three.scalar(2, FX.GROUP_PIPS) !== 0) failures.push("A mega's group effect leaked onto the teammates who satisfied it; it is not an aura.");

    const wrongSide = new TeamField();
    wrongSide.begin(1);
    wrongSide.place({ id: 1, x: 0, z: 0, team: D, mask: sunday });
    for (let i = 0; i < 3; i++) wrongSide.place({ id: i + 2, x: 2 + i, z: 0, team: M, mask: bare });
    if (wrongSide.scalar(1, FX.GROUP_PIPS) !== 0) failures.push('A group of 3 was satisfied by players on the other side.');

    const spread = new TeamField();
    spread.begin(1);
    spread.place({ id: 1, x: 0, z: 0, team: D, mask: sunday });
    for (let i = 0; i < 3; i++) spread.place({ id: i + 2, x: GROUP_M + 5 + i, z: 0, team: D, mask: bare });
    if (spread.scalar(1, FX.GROUP_PIPS) !== 0) failures.push(`A group was satisfied by teammates beyond ${GROUP_M} m.`);
  }

  // --- A player with no side gets nothing, whatever their mask claims.
  {
    const field = new TeamField();
    field.begin(1);
    field.place({ id: 1, x: 0, z: 0, team: TEAM.NONE, mask: { lo: 0xffffffff, hi: 0x3ff } });
    if (field.scalar(1, FX.SWING_DAMAGE) !== 0) failures.push('A player with no team was granted talents by a mask.');
    if (field.teamOf(1) !== TEAM.NONE) failures.push('teamOf disagreed with the record it was given.');
    if (field.teamOf(404) !== TEAM.NONE) failures.push('teamOf on an unknown id was not "no team".');
    // And a mask carrying the *other* side's bits grants nothing either, which
    // is the case a hand-built client produces.
    const crossed = new TeamField();
    crossed.begin(1);
    crossed.place({ id: 1, x: 0, z: 0, team: M, mask: { lo: 0, hi: 0x3ff } }); // all DeFAULT bits
    if (crossed.scalar(1, FX.RBT_IMMUNE) !== 0) failures.push('A Marita wearing DeFAULT bits was granted a DeFAULT talent.');
  }

  // --- A player who stops being placed stops existing, so an aura does not
  // outlive the person casting it.
  {
    const field = new TeamField();
    const tipJar: TalentMask = { lo: (1 << 12) >>> 0, hi: 0 };
    field.begin(1);
    field.place({ id: 1, x: 0, z: 0, team: M, mask: tipJar });
    field.place({ id: 2, x: 3, z: 0, team: M, mask: { lo: 0, hi: 0 } });
    if (field.scalar(2, FX.TEAM_EARN) === 0) failures.push('The aura fixture did not apply before the departure.');
    field.begin(2);
    field.place({ id: 2, x: 3, z: 0, team: M, mask: { lo: 0, hi: 0 } });
    field.begin(3);
    field.place({ id: 2, x: 3, z: 0, team: M, mask: { lo: 0, hi: 0 } });
    if (field.scalar(2, FX.TEAM_EARN) !== 0) failures.push('A departed player was still casting their aura two ticks later.');
    if (field.size !== 1) failures.push(`${field.size} members survived a departure; the prune keeps only who is placed.`);
  }

  return failures;
}
