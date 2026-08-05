/**
 * A uniform grid over the ground plane, rebuilt every tick, so the queries that
 * used to walk every player walk a handful instead.
 *
 * PERFORMANCE.md phase 1. Four things in the 60 Hz tick were linear or worse in
 * the player count and every one of them is a *proximity* question:
 *
 *     game/powerups.tickPowerups   884 points x N players, every tick
 *     game/combat.hitTest          N targets per swing, after N rewound proxies
 *     game/footy.stepFooty         N targets per ball per tick
 *     server/sim.resolveLive       N to map a hit back to a live combatant
 *
 * At sixteen players none of that is measurable. At five hundred the powerups
 * pass alone is 442,000 distance tests a tick -- 26 million a second -- which is
 * the single largest thing in the profile and is entirely answered by asking
 * "who is within 1.6 m of this cafe" instead of "where is everybody".
 *
 * ---------------------------------------------------------------------------
 * ## The contract, and the one thing callers must not forget
 *
 * **`forEachWithin` and `collectWithin` return a conservative superset.** They
 * answer "who *might* be within r", by testing the query's bounding square
 * against each item's coverage box, and they do not do the circle test. The
 * caller does its own exact test, exactly as it did before, over a shorter list.
 *
 * That is not a compromise, it is the property that makes this safe to drop into
 * four pieces of adjudication without changing any of them: a superset plus an
 * unchanged exact test is *identical output*, not an approximation of it. The
 * integration check proves it by running every wired call site both ways over
 * randomised configurations -- see `checkSpatialHash`.
 *
 * `nearest` and `nearestK` are the exception and do test the circle, against the
 * item's representative point, because "nearest" has no meaning otherwise.
 *
 * ---------------------------------------------------------------------------
 * ## Coverage boxes, and why the melee needs them
 *
 * `insert` files an item at a point. `insertBox` files it under a rectangle it
 * is somewhere inside, and that exists for one caller: **lag compensation**.
 *
 * `server/rewind.ts` evaluates a punch against where the victim was up to 250 ms
 * ago, so a hash built from live positions would answer the wrong question --
 * the candidate set has to cover every position the rewind could resolve to. A
 * rewound position is either one of the samples in the ring or a lerp between
 * two of them, and both are inside the axis-aligned bounding box of the ring. So
 * the server files each player under that box and the candidate set is exact in
 * the only sense that matters: nobody the old code could have hit is missing.
 *
 * ---------------------------------------------------------------------------
 * ## Determinism
 *
 * Integer cell arithmetic and an integer bucket hash. No `Math.hypot`, no
 * transcendentals, nothing whose last bit is allowed to differ between JSC and
 * V8 -- this file is imported by both ends and the whole project's rule is that
 * a shared simulation path computes the same bits in both runtimes.
 *
 * `collectWithin` returns items in **ascending insertion order**, which is the
 * one guarantee that lets a hashed call site be byte-identical to the linear one
 * it replaced rather than merely equivalent-in-spirit. Every wired call site
 * resolves ties by "first in the list wins" -- the nearest-wins tests in
 * `hitTest` and `stepFooty` use a strict `<`, and `tickPowerups` breaks on the
 * first body it finds -- so the order has to be the order the linear scan saw.
 * The server inserts in ascending combatant id, which is exactly the order of
 * `Simulation.combatants`, so it is.
 *
 * ---------------------------------------------------------------------------
 * ## What phase 2 will do with this (AOI), stated here so it is not re-derived
 *
 * Interest management needs, per client, the set of players within ~180 m with a
 * 180/220 m hysteresis band, capped at the ~40 nearest. That is
 * `forEachWithin(x, z, 220, cb)` for the candidate sweep and
 * `nearestK(x, z, 180, 40, out)` for the cap, both against the same per-tick
 * build the melee already pays for. **Nothing about AOI needs a second
 * structure and nothing about it needs this file to change**; the only thing to
 * watch is that a 220 m query at cell 8 m walks 55x55 = 3,025 cells, so an AOI
 * build should either use a coarser second hash (`new SpatialHash(64)`) or
 * accept the empty-cell walk. Measure before choosing -- an empty cell is one
 * array read.
 *
 * ---------------------------------------------------------------------------
 * ## Allocation
 *
 * Zero, after warm-up. Buckets are a flat `Int32Array` of chain heads and the
 * entries are two more flat arrays that double when outgrown; `clear` refills
 * the heads and resets a cursor. `collectWithin` writes into the caller's array.
 * A 60 Hz rebuild of five hundred players allocates nothing at all.
 */

/**
 * The cell edge, metres. PERFORMANCE.md's number.
 *
 * The whole argument for 8 is that it is the smallest cell that still makes the
 * *biggest* phase-1 query cheap. The queries wired today are 1.55 m (the bat),
 * about 2 m (a ball's tick-long sweep plus both radii) and 1.6 m (a pickup), so
 * any cell at or above ~4 m keeps every one of them inside a 2x2 walk; below
 * that they start spanning nine cells and the walk costs more than it saves. The
 * other end is set by density: a Sydney street crowd is a few players per 8 m
 * square, so a chain is a handful of entries rather than a re-implementation of
 * the linear scan this replaces.
 */
export const CELL_SIZE = 8;

/**
 * Buckets in the hash table, a power of two so the mask is an `&`.
 *
 * 4,096 against a working set of a few hundred occupied cells: collisions are
 * rare, and a collision costs nothing but a few extra candidates that the
 * caller's exact test discards. `clear` refills this array every tick, so it is
 * also 4,096 stores a tick -- 245,000 a second, which is noise against the
 * 26 million distance tests it removes.
 */
const BUCKETS = 4096;
const BUCKET_MASK = BUCKETS - 1;

/** Two odd 32-bit constants; the standard spatial-hash pair. */
const HASH_X = 0x8da6b343 | 0;
const HASH_Z = 0xd8163841 | 0;

function bucketOf(cx: number, cz: number): number {
  return (((Math.imul(cx, HASH_X) ^ Math.imul(cz, HASH_Z)) >>> 0) & BUCKET_MASK) | 0;
}

export class SpatialHash<T> {
  /** Cell edge in metres. Per-instance so phase 2 can build a coarse one for AOI. */
  readonly cell: number;

  /** Items in insertion order. The index into this is an item's slot. */
  private readonly items: T[] = [];
  private count = 0;

  /** The representative point of each slot, for `nearest`. */
  private px: Float64Array<ArrayBuffer> = new Float64Array(64);
  private pz: Float64Array<ArrayBuffer> = new Float64Array(64);

  /** Chain heads, one per bucket; -1 is empty. */
  private readonly head = new Int32Array(BUCKETS).fill(-1);
  /** One entry per (slot, cell) pair. Parallel arrays, doubled when outgrown. */
  private entrySlot: Int32Array<ArrayBuffer> = new Int32Array(256);
  private entryNext: Int32Array<ArrayBuffer> = new Int32Array(256);
  private entries = 0;

  /** Query de-duplication: a slot is emitted once even when several cells hold it. */
  private stamp: Int32Array<ArrayBuffer> = new Int32Array(64);
  private query = 0;

  /** Slot indices gathered by `collectWithin`, before they are ordered. */
  private gathered: Int32Array<ArrayBuffer> = new Int32Array(64);

  constructor(cell: number = CELL_SIZE) {
    this.cell = cell;
  }

  /** How many items are filed. */
  get size(): number {
    return this.count;
  }

  /**
   * Empty it, keeping every buffer. Called once per rebuild.
   *
   * `items.length = 0` rather than a fresh array, on this codebase's usual
   * terms: the entries above it are typed arrays that are never reallocated
   * once they have reached their high-water mark, and an object array that was
   * replaced each tick would put the one allocation back that all of this
   * exists to remove.
   */
  clear(): void {
    this.items.length = 0;
    this.count = 0;
    this.entries = 0;
    this.head.fill(-1);
  }

  /** File an item at a point. */
  insert(item: T, x: number, z: number): void {
    const slot = this.slotFor(item, x, z);
    this.file(slot, cellOf(x, this.cell), cellOf(z, this.cell));
  }

  /**
   * File an item under every cell its coverage box touches, with `(x, z)` as the
   * point `nearest` measures against.
   *
   * The box is given as absolute bounds rather than a half-extent because the
   * one caller has them that way -- a rewind ring's min and max are not
   * symmetric about the current position and pretending they are would inflate
   * the box for no reason. See the header.
   */
  insertBox(item: T, x: number, z: number, minX: number, minZ: number, maxX: number, maxZ: number): void {
    const slot = this.slotFor(item, x, z);
    const cx0 = cellOf(minX, this.cell);
    const cx1 = cellOf(maxX, this.cell);
    const cz0 = cellOf(minZ, this.cell);
    const cz1 = cellOf(maxZ, this.cell);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) this.file(slot, cx, cz);
    }
  }

  /**
   * Every item that **might** be within `r` of `(x, z)`. A superset; see the
   * header, and do your own exact test.
   *
   * `cb` may return `true` to stop the walk, which is `forEachPoliceNear`'s
   * convention in `game/pedestrians.ts` and is here so the two read the same.
   */
  forEachWithin(x: number, z: number, r: number, cb: (item: T) => boolean | void): void {
    const q = ++this.query;
    const cx0 = cellOf(x - r, this.cell);
    const cx1 = cellOf(x + r, this.cell);
    const cz0 = cellOf(z - r, this.cell);
    const cz1 = cellOf(z + r, this.cell);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let e = this.head[bucketOf(cx, cz)]; e !== -1; e = this.entryNext[e]) {
          const slot = this.entrySlot[e];
          if (this.stamp[slot] === q) continue;
          this.stamp[slot] = q;
          if (cb(this.items[slot]) === true) return;
        }
      }
    }
  }

  /**
   * The same superset, into `out`, **in ascending insertion order**.
   *
   * The order is the whole reason this exists beside `forEachWithin`: see the
   * header on determinism. It is an insertion sort over the gathered slot
   * indices, which is the right sort for the sizes this is called at -- a
   * 1.55 m query in a crowded street returns single digits -- and would be the
   * wrong one for an AOI-sized sweep, which should use `forEachWithin` and
   * order the result itself if it needs to.
   */
  collectWithin(x: number, z: number, r: number, out: T[]): T[] {
    out.length = 0;
    const q = ++this.query;
    let n = 0;
    const cx0 = cellOf(x - r, this.cell);
    const cx1 = cellOf(x + r, this.cell);
    const cz0 = cellOf(z - r, this.cell);
    const cz1 = cellOf(z + r, this.cell);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let e = this.head[bucketOf(cx, cz)]; e !== -1; e = this.entryNext[e]) {
          const slot = this.entrySlot[e];
          if (this.stamp[slot] === q) continue;
          this.stamp[slot] = q;
          if (n >= this.gathered.length) this.gathered = grow32(this.gathered, n + 1);
          // Insertion sort as we go: the gathered list is kept ascending, so
          // the caller's array comes out in the order a linear scan would have
          // produced without a second pass.
          let i = n++;
          while (i > 0 && this.gathered[i - 1] > slot) {
            this.gathered[i] = this.gathered[i - 1];
            i--;
          }
          this.gathered[i] = slot;
        }
      }
    }
    for (let i = 0; i < n; i++) out.push(this.items[this.gathered[i]]);
    return out;
  }

  /**
   * The single nearest item to `(x, z)` within `r`, by representative point, or
   * null. Ties go to the earlier insertion, so this is deterministic too.
   */
  nearest(x: number, z: number, r: number): T | null {
    let best: T | null = null;
    let best2 = r * r;
    let bestSlot = -1;
    const q = ++this.query;
    const cx0 = cellOf(x - r, this.cell);
    const cx1 = cellOf(x + r, this.cell);
    const cz0 = cellOf(z - r, this.cell);
    const cz1 = cellOf(z + r, this.cell);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let e = this.head[bucketOf(cx, cz)]; e !== -1; e = this.entryNext[e]) {
          const slot = this.entrySlot[e];
          if (this.stamp[slot] === q) continue;
          this.stamp[slot] = q;
          const dx = this.px[slot] - x;
          const dz = this.pz[slot] - z;
          const d2 = dx * dx + dz * dz;
          if (d2 > best2) continue;
          if (d2 === best2 && bestSlot !== -1 && slot > bestSlot) continue;
          best2 = d2;
          bestSlot = slot;
          best = this.items[slot];
        }
      }
    }
    return best;
  }

  /**
   * The `k` nearest items within `r`, nearest first, into `out`.
   *
   * Phase 2's AOI cap, and it is here rather than in the AOI pass because it is
   * the same walk `nearest` already does and a second copy of that walk is a
   * second thing to keep right. Selection is an insertion into a `k`-long list,
   * which beats a sort of the whole candidate set at every `k` this is called
   * with (~40) and every candidate count a 180 m disc holds.
   *
   * Ties go to the earlier insertion, for `nearest`'s reason.
   */
  nearestK(x: number, z: number, r: number, k: number, out: T[]): T[] {
    out.length = 0;
    if (k <= 0) return out;
    const d2s: number[] = this.nearScratch;
    d2s.length = 0;
    const q = ++this.query;
    const cx0 = cellOf(x - r, this.cell);
    const cx1 = cellOf(x + r, this.cell);
    const cz0 = cellOf(z - r, this.cell);
    const cz1 = cellOf(z + r, this.cell);
    const r2 = r * r;
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        for (let e = this.head[bucketOf(cx, cz)]; e !== -1; e = this.entryNext[e]) {
          const slot = this.entrySlot[e];
          if (this.stamp[slot] === q) continue;
          this.stamp[slot] = q;
          const dx = this.px[slot] - x;
          const dz = this.pz[slot] - z;
          const d2 = dx * dx + dz * dz;
          if (d2 > r2) continue;
          if (out.length === k && d2 >= d2s[k - 1]) continue;
          let i = out.length < k ? out.length : k - 1;
          if (out.length < k) {
            out.push(this.items[slot]);
            d2s.push(d2);
          }
          while (i > 0 && d2s[i - 1] > d2) {
            out[i] = out[i - 1];
            d2s[i] = d2s[i - 1];
            i--;
          }
          out[i] = this.items[slot];
          d2s[i] = d2;
        }
      }
    }
    return out;
  }

  private readonly nearScratch: number[] = [];

  private slotFor(item: T, x: number, z: number): number {
    const slot = this.count++;
    this.items.push(item);
    if (slot >= this.px.length) {
      this.px = grow64(this.px, slot + 1);
      this.pz = grow64(this.pz, slot + 1);
      this.stamp = grow32(this.stamp, slot + 1);
    }
    this.px[slot] = x;
    this.pz[slot] = z;
    return slot;
  }

  private file(slot: number, cx: number, cz: number): void {
    if (this.entries >= this.entrySlot.length) {
      this.entrySlot = grow32(this.entrySlot, this.entries + 1);
      this.entryNext = grow32(this.entryNext, this.entries + 1);
    }
    const e = this.entries++;
    const b = bucketOf(cx, cz);
    this.entrySlot[e] = slot;
    this.entryNext[e] = this.head[b];
    this.head[b] = e;
  }
}

/**
 * Floor-divide a metre coordinate into a cell index.
 *
 * `Math.floor`, not `| 0`: truncation rounds toward zero, which maps -0.5 and
 * +0.5 onto the same cell and loses the whole western half of Sydney -- the
 * world's origin is in the middle of it. `verifySpatialHash` asserts this.
 */
function cellOf(v: number, cell: number): number {
  return Math.floor(v / cell) | 0;
}

function grow32(a: Int32Array<ArrayBuffer>, need: number): Int32Array<ArrayBuffer> {
  let n = a.length;
  while (n < need) n *= 2;
  const next = new Int32Array(n);
  next.set(a);
  return next;
}

function grow64(a: Float64Array<ArrayBuffer>, need: number): Float64Array<ArrayBuffer> {
  let n = a.length;
  while (n < need) n *= 2;
  const next = new Float64Array(n);
  next.set(a);
  return next;
}

// --- The self-check -----------------------------------------------------------

/**
 * That the grid is a superset of the brute-force answer, in the two ways it can
 * fail to be.
 *
 * Both failures are silent in this project's sense, which is why this runs at
 * boot beside `verifyCombat` rather than only in the integration check. A cell
 * arithmetic that truncates instead of flooring loses everybody at negative x --
 * which is half of Sydney, since the world's origin is in the middle of it --
 * and presents as punches that pass through people on one side of the CBD and
 * connect on the other. A de-duplication stamp that is not reset per query drops
 * a player from the *second* query of a tick, which presents as a ball that
 * knocks somebody over only when it is the first ball in the air.
 */
export function verifySpatialHash(): string[] {
  const failures: string[] = [];

  // --- A grid of points across the origin, so both signs of both axes are in
  // play, queried at every radius the wired call sites use.
  {
    const hash = new SpatialHash<number>();
    const xs: number[] = [];
    const zs: number[] = [];
    let seed = 12345;
    const rand = (): number => {
      // The integer hash this project uses everywhere rather than Math.random,
      // so a failure below is reproducible from the line number alone.
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      return ((seed >>> 8) & 0xffffff) / 0x1000000;
    };
    for (let i = 0; i < 400; i++) {
      const x = (rand() - 0.5) * 400;
      const z = (rand() - 0.5) * 400;
      xs.push(x);
      zs.push(z);
      hash.insert(i, x, z);
    }
    const out: number[] = [];
    for (const r of [0.5, 1.55, 1.6, 2.1, 8, 40]) {
      for (let t = 0; t < 60; t++) {
        const qx = (rand() - 0.5) * 420;
        const qz = (rand() - 0.5) * 420;
        hash.collectWithin(qx, qz, r, out);
        const got = new Set(out);
        for (let i = 0; i < xs.length; i++) {
          const dx = xs[i] - qx;
          const dz = zs[i] - qz;
          if (dx * dx + dz * dz <= r * r && !got.has(i)) {
            failures.push(
              `A point ${Math.sqrt(dx * dx + dz * dz).toFixed(3)} m from a query of radius ${r} ` +
                `was not in the candidate set. The grid is not a superset and every hit test on it is wrong.`,
            );
            break;
          }
        }
        // Ascending insertion order, which is what makes a hashed call site
        // byte-identical to the linear scan it replaced rather than merely
        // similar. See the header.
        for (let i = 1; i < out.length; i++) {
          if (out[i - 1] >= out[i]) {
            failures.push(`collectWithin returned ${out[i - 1]} before ${out[i]}; the order must ascend.`);
            break;
          }
        }
      }
    }

    // Two queries in a row must give the same answer -- the de-duplication
    // stamp is per query and a stamp that is not advanced silently empties the
    // second one.
    hash.collectWithin(0, 0, 40, out);
    const first = out.length;
    hash.collectWithin(0, 0, 40, out);
    if (out.length !== first) {
      failures.push(`The same query answered ${first} then ${out.length}. The de-duplication stamp is not per query.`);
    }
  }

  // --- Coverage boxes: an item filed under a rectangle is found from anywhere
  // the rectangle reaches, which is the whole of what lag compensation needs.
  {
    const hash = new SpatialHash<string>();
    hash.insertBox('runner', 0, 0, -30, -30, 30, 30);
    const out: string[] = [];
    for (const [qx, qz] of [[29, 29], [-29, -29], [0, 30], [-30, 0]] as Array<[number, number]>) {
      hash.collectWithin(qx, qz, 0.5, out);
      if (!out.includes('runner')) {
        failures.push(`A box spanning +/-30 m was not found from (${qx}, ${qz}). A rewound punch would miss.`);
      }
    }
    hash.collectWithin(200, 200, 0.5, out);
    if (out.includes('runner')) failures.push('A box was found 200 m outside itself; the cell range is unbounded.');
  }

  // --- Negative coordinates. Truncation instead of flooring loses the whole
  // western half of the city and there is no frame in which that looks wrong.
  {
    const hash = new SpatialHash<number>();
    hash.insert(1, -0.5, -0.5);
    hash.insert(2, 0.5, 0.5);
    const out: number[] = [];
    hash.collectWithin(-0.4, -0.4, 0.5, out);
    if (!out.includes(1)) failures.push('A point at (-0.5, -0.5) was not found from 0.14 m away. The cell index truncates rather than floors.');
    hash.collectWithin(0, 0, 1, out);
    if (out.length !== 2) failures.push(`A 1 m query straddling the origin found ${out.length} of 2 points.`);
  }

  // --- nearest / nearestK, which do test the circle.
  {
    const hash = new SpatialHash<number>();
    hash.insert(0, 0, 0);
    hash.insert(1, 3, 0);
    hash.insert(2, 0, 5);
    hash.insert(3, 100, 100);
    if (hash.nearest(3.1, 0, 2) !== 1) failures.push('nearest did not return the point 0.1 m away.');
    if (hash.nearest(50, 50, 10) !== null) failures.push('nearest returned something outside its radius.');
    const out: number[] = [];
    hash.nearestK(0, 0, 10, 2, out);
    if (out.length !== 2 || out[0] !== 0 || out[1] !== 1) {
      failures.push(`nearestK(2) gave [${out.join(', ')}]; it must be [0, 1] nearest first.`);
    }
    hash.nearestK(0, 0, 10, 40, out);
    if (out.length !== 3) failures.push(`nearestK asked for 40 within 10 m returned ${out.length}, not the 3 that qualify.`);
  }

  // --- Reuse across rebuilds. The whole structure is rebuilt sixty times a
  // second and a `clear` that left an entry behind would be a ghost target.
  {
    const hash = new SpatialHash<number>();
    const out: number[] = [];
    for (let t = 0; t < 5; t++) {
      hash.clear();
      for (let i = 0; i < 10; i++) hash.insert(i, t * 100 + i, 0);
      hash.collectWithin(t * 100 + 5, 0, 6, out);
      if (out.length !== 10) failures.push(`Rebuild ${t} found ${out.length} of 10 points; clear() leaks entries.`);
      hash.collectWithin((t - 1) * 100 + 5, 0, 6, out);
      if (t > 0 && out.length !== 0) failures.push(`Rebuild ${t} still found ${out.length} points from rebuild ${t - 1}.`);
    }
  }

  return failures;
}
