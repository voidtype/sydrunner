/**
 * Who owns which slots of a shared instance buffer.
 *
 * ## Why this exists
 *
 * The client compiles the same handful of shaders thousands of times a session,
 * and the reason is one line in three:
 *
 * ```js
 * if ( object.isInstancedMesh || object.count > 1 ) {
 *   // TODO: https://github.com/mrdoob/three.js/pull/29066#issuecomment-2269400850
 *   cacheKey += object.uuid + ',';
 * }
 * ```
 *
 * `NodeManager.nodeBuilderCache` is keyed on that cache key, so **every
 * `InstancedMesh` builds its own node graph and generates its own WGSL from
 * scratch**. One tile's gum trees and the next tile's gum trees are the same
 * geometry drawn with the same material, and three treats them as two different
 * shaders. A session that had loaded fifty-six tiles was holding 3,260 node
 * builder states. The compile gate defers what it cannot afford, a deferred
 * draw is an object with no pipeline, and an object with no pipeline is not
 * drawn -- which is what "I rode into an area and nothing was there" is.
 *
 * It is provably waste rather than necessary work: with three's count-dependent
 * uniform path disabled, forty to fifty-six meshes per species, with instance
 * counts from one to seventy-eight, generate **byte-identical** vertex and
 * fragment WGSL. Measured, not assumed.
 *
 * The tempting shortcut -- collapse `object.uuid` so the cache keys match --
 * is unsafe, and `RenderObject.getAttributes` is where you can see why:
 *
 * ```js
 * if ( nodeAttribute.node && nodeAttribute.node.attribute ) attribute = nodeAttribute.node.attribute;
 * ```
 *
 * The node carries *its own* instance buffer, and the node builder state is
 * what would be shared. Every tree in the city would draw at the first tile's
 * positions.
 *
 * So the fix is to stop making a mesh per tile at all: **one `InstancedMesh`
 * per species for the whole world**, and tiles write into ranges of its one
 * instance buffer. One object, one uuid, one node state, one pipeline -- and a
 * newly streamed tile compiles nothing whatsoever.
 *
 * This file is the bookkeeping half of that, split out because it is the half
 * with a rule in it. It knows nothing about three, geometry or matrices; it
 * hands out spans of a fixed-length array and takes them back, which makes
 * every property below checkable on the server's boot list with plain numbers.
 * `world/instancepool.ts` is the half that owns the meshes.
 *
 * ## The shape of the problem
 *
 * Tiles arrive and leave in no particular order, so the spans they hold end up
 * scattered: this is a first-fit allocator over a free list, coalescing on
 * release so that a street's worth of tiles streaming out leaves one big hole
 * rather than forty small ones. Two properties matter more than speed, and both
 * are asserted below:
 *
 * - **A freed span must be reusable.** Anything else is a leak with extra
 *   steps, and the buffer would grow until a `RangeError` for a world the
 *   player has already walked out of.
 * - **`highWater` must fall when the tail is freed.** It is what the pool sets
 *   `InstancedMesh.count` to, and every slot below it is drawn whether or not
 *   anybody owns it. A high-water mark that only ever rose would quietly draw
 *   tens of thousands of degenerate instances for the rest of the session.
 */

/** A half-open span `[start, start + len)` of the buffer. */
interface Span {
  start: number;
  len: number;
}

/** What `alloc` returns when the request cannot be met. */
export const NO_SPACE = -1;

export class RangeAllocator {
  /** Free spans, sorted by `start` and never adjacent to one another. */
  private free: Span[];
  private cap: number;
  /** One past the highest slot anybody owns. */
  private water = 0;
  /** Slots currently owned. */
  private live = 0;

  constructor(capacity: number) {
    this.cap = Math.max(0, Math.floor(capacity));
    this.free = this.cap > 0 ? [{ start: 0, len: this.cap }] : [];
  }

  get capacity(): number {
    return this.cap;
  }

  /**
   * One past the last owned slot: what the mesh's `count` should be.
   *
   * Recomputed from the free list rather than tracked incrementally, because
   * the incremental version has to answer "was that the last one?" on every
   * release and gets it wrong the first time two spans are freed out of order.
   * The list is short -- one entry per hole, and holes coalesce -- so this is a
   * walk of a handful of items.
   */
  get highWater(): number {
    const last = this.free.length === 0 ? null : this.free[this.free.length - 1];
    if (last !== null && last.start + last.len === this.cap) return last.start;
    return this.cap;
  }

  /** Slots owned right now. */
  get used(): number {
    return this.live;
  }

  /** Free slots, wherever they are. Not necessarily contiguous. */
  get available(): number {
    let n = 0;
    for (const s of this.free) n += s.len;
    return n;
  }

  /** The largest single span available, which is what `alloc` can actually meet. */
  get largestFree(): number {
    let n = 0;
    for (const s of this.free) if (s.len > n) n = s.len;
    return n;
  }

  /**
   * Take `n` contiguous slots, or `NO_SPACE`.
   *
   * First fit rather than best fit: the caller's spans are all "one tile's
   * worth of one species", so they cluster tightly around a few sizes and best
   * fit buys nothing but a longer walk.
   */
  alloc(n: number): number {
    if (!Number.isFinite(n) || n <= 0) return NO_SPACE;
    const want = Math.floor(n);
    for (let i = 0; i < this.free.length; i++) {
      const span = this.free[i];
      if (span.len < want) continue;
      const start = span.start;
      if (span.len === want) this.free.splice(i, 1);
      else {
        span.start += want;
        span.len -= want;
      }
      this.live += want;
      if (start + want > this.water) this.water = start + want;
      return start;
    }
    return NO_SPACE;
  }

  /**
   * Give `n` slots back, coalescing with whatever they now touch.
   *
   * Out-of-range and overlapping releases are refused rather than trusted: a
   * double free would hand the same slots to two tiles and draw one tile's
   * trees at the other's coordinates, which is a bug that looks like a world
   * generation fault and would be chased in entirely the wrong file.
   */
  free_(start: number, n: number): boolean {
    if (!Number.isFinite(start) || !Number.isFinite(n)) return false;
    const s = Math.floor(start);
    const len = Math.floor(n);
    if (len <= 0 || s < 0 || s + len > this.cap) return false;
    // Refuse anything that overlaps a span already free.
    for (const span of this.free) {
      if (s < span.start + span.len && span.start < s + len) return false;
    }
    let i = 0;
    while (i < this.free.length && this.free[i].start < s) i++;
    this.free.splice(i, 0, { start: s, len });
    this.live -= len;
    // Coalesce with the neighbour after, then the neighbour before.
    const after = this.free[i + 1];
    if (after !== undefined && s + len === after.start) {
      this.free[i].len += after.len;
      this.free.splice(i + 1, 1);
    }
    const before = i > 0 ? this.free[i - 1] : undefined;
    if (before !== undefined && before.start + before.len === this.free[i].start) {
      before.len += this.free[i].len;
      this.free.splice(i, 1);
    }
    this.water = this.highWater;
    return true;
  }

  /**
   * Extend the buffer to `to` slots.
   *
   * The tail is either extended in place or becomes a new free span. Growth is
   * the expensive event for the caller -- a new `InstancedBufferAttribute` is a
   * new node attribute and therefore one recompile for that species -- so the
   * pool doubles rather than creeping, and this is called a handful of times a
   * session rather than per tile.
   */
  grow(to: number): void {
    const next = Math.floor(to);
    if (next <= this.cap) return;
    const added = next - this.cap;
    const last = this.free.length === 0 ? undefined : this.free[this.free.length - 1];
    if (last !== undefined && last.start + last.len === this.cap) last.len += added;
    else this.free.push({ start: this.cap, len: added });
    this.cap = next;
  }

  /** Holes, for a diagnostic line. One is healthy; two hundred is not. */
  get holes(): number {
    return this.free.length;
  }
}

/** Self-check. On both boot lists: it is arithmetic and imports nothing. */
export function verifyRangeAlloc(): string[] {
  const failures: string[] = [];

  // --- The ordinary life of a slot: taken, given back, taken again.
  {
    const a = new RangeAllocator(100);
    const x = a.alloc(10);
    const y = a.alloc(20);
    if (x !== 0 || y !== 10) failures.push(`first two allocations landed at ${x} and ${y}, not 0 and 10.`);
    if (a.used !== 30) failures.push(`used was ${a.used} after taking 30 slots.`);
    if (!a.free_(x, 10)) failures.push('a legitimate release was refused.');
    if (a.used !== 20) failures.push(`used was ${a.used} after giving 10 back.`);
    const z = a.alloc(10);
    if (z !== 0) failures.push(`a freed span was not reused (got ${z}); the buffer would grow for ever.`);
  }

  // --- **The high-water mark falls.** It is what the mesh's `count` becomes.
  {
    const a = new RangeAllocator(100);
    const x = a.alloc(40);
    const y = a.alloc(40);
    if (a.highWater !== 80) failures.push(`highWater was ${a.highWater} with 80 slots taken.`);
    a.free_(y, 40);
    if (a.highWater !== 40) {
      failures.push(`highWater stayed at ${a.highWater} after the tail was freed; every slot below it is drawn, so this is tens of thousands of degenerate instances.`);
    }
    a.free_(x, 40);
    if (a.highWater !== 0) failures.push(`highWater was ${a.highWater} with nothing allocated.`);
    void y;
  }

  // --- Holes coalesce, so a street streaming out leaves one hole and not forty.
  {
    const a = new RangeAllocator(100);
    const p = a.alloc(10);
    const q = a.alloc(10);
    const r = a.alloc(10);
    a.free_(q, 10);
    a.free_(p, 10);
    // p and q are now one 20-slot hole, plus the tail.
    if (a.holes !== 2) failures.push(`freeing two adjacent spans left ${a.holes} holes, not 2 (the merged one and the tail).`);
    if (a.alloc(20) !== 0) failures.push('two adjacent freed spans did not merge into one usable 20-slot span.');
    void r;
  }

  // --- Coalescing works in both directions and in the middle.
  {
    const a = new RangeAllocator(90);
    const p = a.alloc(30);
    const q = a.alloc(30);
    const r = a.alloc(30);
    a.free_(p, 30);
    a.free_(r, 30);
    if (a.holes !== 2) failures.push(`two non-adjacent holes reported as ${a.holes}.`);
    a.free_(q, 30); // fills the gap between them
    if (a.holes !== 1) failures.push(`freeing the span between two holes left ${a.holes} holes, not 1.`);
    if (a.largestFree !== 90) failures.push(`the whole buffer did not merge back into one span (largest ${a.largestFree}).`);
    if (a.highWater !== 0) failures.push(`highWater was ${a.highWater} on an empty allocator.`);
  }

  // --- A request that cannot be met says so rather than overlapping one that can.
  {
    const a = new RangeAllocator(50);
    a.alloc(30);
    if (a.alloc(30) !== NO_SPACE) failures.push('an oversized request was met anyway; two owners would share slots.');
    if (a.alloc(20) === NO_SPACE) failures.push('a request that exactly fits the remainder was refused.');
    if (a.alloc(1) !== NO_SPACE) failures.push('a full allocator handed out another slot.');
  }

  // --- Fragmentation is reported honestly.
  //
  // `available` counts every free slot and `largestFree` counts the biggest
  // run. The pool grows on the second, not the first: a buffer with a thousand
  // free slots in fifty holes cannot seat a tile of six hundred trees.
  {
    const a = new RangeAllocator(100);
    const p = a.alloc(10);
    a.alloc(10);
    const r = a.alloc(10);
    a.free_(p, 10);
    a.free_(r, 10);
    if (a.available !== 90) failures.push(`available was ${a.available}, not 90.`);
    // 80, not 70: freeing the span at 20 coalesces with the tail that starts at
    // 30, which is the whole point of coalescing and worth stating in a number.
    if (a.largestFree !== 80) failures.push(`largestFree was ${a.largestFree}; the freed span did not merge with the tail.`);
    if (a.holes !== 2) failures.push(`fragmented allocator had ${a.holes} holes, not 2.`);
  }

  // --- Nonsense is refused, not trusted.
  //
  // A double free is the one that matters: it would hand the same slots to two
  // tiles, and one tile's trees would stand at the other's coordinates -- which
  // reads as a world-generation fault and would be chased in the wrong file.
  {
    const a = new RangeAllocator(50);
    const x = a.alloc(10);
    if (!a.free_(x, 10)) failures.push('a first release was refused.');
    if (a.free_(x, 10)) failures.push('a double free was accepted; two tiles would own the same slots.');
    if (a.free_(-1, 5)) failures.push('a negative start was accepted.');
    if (a.free_(45, 10)) failures.push('a release running past the end of the buffer was accepted.');
    if (a.free_(0, 0)) failures.push('an empty release was accepted.');
    if (a.alloc(0) !== NO_SPACE) failures.push('a zero-length allocation returned a slot.');
    if (a.alloc(-5) !== NO_SPACE) failures.push('a negative allocation returned a slot.');
    if (a.alloc(NaN) !== NO_SPACE) failures.push('NaN returned a slot.');
  }

  // --- Growth extends the tail rather than adding a second hole beside it.
  {
    const a = new RangeAllocator(20);
    a.alloc(20);
    if (a.alloc(5) !== NO_SPACE) failures.push('a full allocator allocated.');
    a.grow(40);
    if (a.capacity !== 40) failures.push(`capacity was ${a.capacity} after growing to 40.`);
    const x = a.alloc(20);
    if (x !== 20) failures.push(`the grown region started at ${x}, not 20.`);
    a.free_(0, 20);
    a.grow(80);
    if (a.holes !== 2) failures.push(`growth beside a tail hole left ${a.holes} holes; it should extend the tail.`);
    if (a.largestFree !== 40) failures.push(`the extended tail was ${a.largestFree}, not 40.`);
    a.grow(10); // shrinking is a no-op, never a truncation
    if (a.capacity !== 80) failures.push(`grow() shrank the buffer to ${a.capacity}.`);
  }

  // --- A long random life stays consistent.
  //
  // The property that matters over a session: every slot is owned by at most
  // one holder, and everything given back can be taken again. Deterministic
  // pseudo-random, because a check that fails once a fortnight is not a check.
  {
    const a = new RangeAllocator(512);
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const held: Array<{ start: number; len: number }> = [];
    for (let step = 0; step < 4000; step++) {
      if (held.length > 0 && rnd(2) === 0) {
        const i = rnd(held.length);
        const h = held[i];
        held.splice(i, 1);
        if (!a.free_(h.start, h.len)) failures.push('a span this allocator handed out was refused on release.');
      } else {
        const len = 1 + rnd(24);
        const start = a.alloc(len);
        if (start !== NO_SPACE) held.push({ start, len });
      }
      // No two holders may overlap.
      if (step % 500 === 0) {
        const sorted = held.slice().sort((p, q) => p.start - q.start);
        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i].start < sorted[i - 1].start + sorted[i - 1].len) {
            failures.push('two holders overlapped after random churn; one tile would draw at another\'s coordinates.');
            break;
          }
        }
      }
    }
    let owned = 0;
    for (const h of held) owned += h.len;
    if (a.used !== owned) failures.push(`used said ${a.used} against ${owned} actually held.`);
    if (a.used + a.available !== a.capacity) {
      failures.push(`used (${a.used}) plus available (${a.available}) is not the capacity (${a.capacity}); slots have gone missing.`);
    }
    for (const h of held) a.free_(h.start, h.len);
    if (a.used !== 0) failures.push(`used was ${a.used} after everything was released.`);
    if (a.holes !== 1) failures.push(`a fully released allocator has ${a.holes} holes, not 1; coalescing is leaking fragments.`);
    if (a.highWater !== 0) failures.push(`highWater was ${a.highWater} after everything was released.`);
  }

  // --- **The high-water mark never passes the capacity.**
  //
  // This is the arithmetic half of the bug that blacked the screen out. The
  // pool writes `highWater` into `InstancedMesh.count`, and `count` is what the
  // draw call asks the GPU for: one past the instance buffer is not a glitch,
  // it is an invalid command buffer and every frame after it is black.
  //
  //     Instance range (first: 0, count: 4113) requires a larger buffer
  //     (263232) than the bound buffer size (262144)
  //
  // The failure there was the pool's -- it grew the allocator and left the
  // buffer behind -- but the invariant belongs here, where the number comes
  // from, and it must hold through every growth and release.
  {
    const a = new RangeAllocator(64);
    a.alloc(64);
    if (a.highWater > a.capacity) failures.push('highWater passed capacity on a full allocator.');
    a.grow(256);
    if (a.highWater > a.capacity) failures.push('highWater passed capacity after growth.');
    const x = a.alloc(190);
    if (a.highWater > a.capacity) failures.push(`highWater (${a.highWater}) passed capacity (${a.capacity}) after allocating into grown room.`);
    if (x + 190 > a.capacity) failures.push('an allocation ran past the end of the buffer.');
    a.free_(x, 190);
    if (a.highWater > a.capacity) failures.push('highWater passed capacity after a release.');
    // And through a lot of churn, since that is where an off-by-one hides.
    let seed = 99;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const held: Array<{ start: number; len: number }> = [];
    for (let i = 0; i < 1500; i++) {
      if (held.length > 0 && rnd(2) === 0) {
        const k = rnd(held.length);
        a.free_(held[k].start, held[k].len);
        held.splice(k, 1);
      } else {
        const len = 1 + rnd(40);
        const start = a.alloc(len);
        if (start === NO_SPACE) a.grow(a.capacity * 2);
        else held.push({ start, len });
      }
      if (a.highWater > a.capacity) {
        failures.push('highWater passed capacity during churn; the mesh count would run past its instance buffer.');
        break;
      }
      for (const h of held) {
        if (h.start + h.len > a.capacity) {
          failures.push('a live span ran past the capacity; its instances have no buffer behind them.');
          break;
        }
      }
    }
  }

  // --- A zero-capacity allocator is legal and simply never allocates.
  {
    const a = new RangeAllocator(0);
    if (a.alloc(1) !== NO_SPACE) failures.push('a zero-capacity allocator handed out a slot.');
    if (a.highWater !== 0) failures.push('an empty allocator had a high-water mark.');
    a.grow(16);
    if (a.alloc(16) !== 0) failures.push('a grown zero-capacity allocator did not allocate from 0.');
  }

  return failures;
}
