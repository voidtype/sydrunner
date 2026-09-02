/**
 * What people have put in the buildings, and the only part of an interior that
 * is stored.
 *
 * A room is a pure function of its footprint -- `world/interior.ts` generates
 * the same walls on every machine, in every session, forever, with nothing on
 * disk and nothing on the wire. That is the whole design and it is why sixty
 * kilometres of city can have an inside. **Furniture is the exception**: a
 * couch somebody put in a corner cannot be recomputed from anything, so it is
 * the first thing here that has to be written down.
 *
 * `server/wallets.ts`' shape, deliberately, down to the debounce and the
 * write-to-temp-and-rename: it is the same problem -- a small JSON file holding
 * something players accumulated, written from a 1 vCPU box that must not stall
 * a tick to do it.
 *
 * ## What it is not
 *
 * Not a general object database and not per-player. A space id maps to a list
 * of placements, that is the whole schema, and both ends of it are bounded:
 * `MAX_PER_SPACE` things in a building and `MAX_SPACES` buildings on the box.
 * The bounds are not tuning -- they are what stands between this file and a
 * player who decides to fill Sydney with couches, which is a thing an open
 * sandbox invites. The owner's decision is *"for now just make it anyone can
 * customise it"*, with a $20,000 claim to come; when that lands, the owner is a
 * field on the record here and nothing else about this file changes.
 */
import {
  MAX_PER_SPACE,
  sanitisePlacement,
  type Placement,
} from '../client/src/world/placeables.ts';
import { CITY_SPACE, sanitiseSpace } from '../client/src/net/spaces.ts';

/** Where the file lives. `SYDNEY_STATE_DIR` moves the whole directory. */
export function defaultInteriorPath(): string {
  const dir = process.env.SYDNEY_STATE_DIR ?? './data/state';
  return `${dir}/interiors.json`;
}

/**
 * How long a write waits, milliseconds.
 *
 * `wallets.SAVE_DEBOUNCE_MS`, and on the cheap side of its argument rather than
 * the careful one: losing five seconds of furniture costs somebody the couch
 * they just put down, where losing five seconds of *money* costs them a fare.
 */
export const SAVE_DEBOUNCE_MS = 5000;

/**
 * How many buildings the box remembers.
 *
 * Sixty thousand buildings can be walked into and this holds the ones somebody
 * has actually furnished. At 64 placements of about 40 bytes of JSON each, ten
 * thousand of them is a 25 MB file on a 20 GB disk and about the same resident,
 * which is the number that matters on a 1 GB box. Past it, new buildings are
 * refused rather than old ones evicted -- a room that quietly forgot its
 * furniture would be indistinguishable from griefing, and there is no
 * least-recently-used order here that means anything to a player.
 */
export const MAX_SPACES = 10_000;

interface InteriorFile {
  version: number;
  /** Space id, as a decimal string, to what is in it. */
  spaces: Record<string, Placement[]>;
}

export class InteriorStore {
  readonly path: string;
  private file: InteriorFile = { version: 1, spaces: {} };
  private readonly rooms = new Map<number, Placement[]>();
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * `persist` is false only for the self-check.
   *
   * Without it, `verifyInteriorStore` schedules a real write five seconds after
   * boot and then prints a filesystem error into the server's log for a store
   * that never existed -- a check that leaves litter in the output of the thing
   * it is checking. A store built this way still behaves identically in every
   * respect a caller can observe; it simply never arms the timer.
   */
  constructor(path: string = defaultInteriorPath(), private readonly persist = true) {
    this.path = path;
  }

  /**
   * Read the file, or start empty. A file that will not parse is **moved aside**.
   *
   * `WalletStore.load`'s call and its reasoning, one notch weaker because the
   * stakes are: a server that refuses to boot on a truncated JSON is a server
   * that is down until somebody notices, and one that deletes the file has
   * taken everybody's furniture.
   *
   * Every row goes back through `sanitisePlacement`, so the one parser that has
   * ever produced a `Placement` is the one that produced these -- a hand-edited
   * file with a NaN in it cannot reach a room.
   */
  async load(): Promise<void> {
    try {
      const text = await Bun.file(this.path).text();
      const raw = JSON.parse(text) as Partial<InteriorFile>;
      const spaces = raw.spaces;
      if (typeof spaces === 'object' && spaces !== null) {
        for (const [key, list] of Object.entries(spaces)) {
          const space = sanitiseSpace(Number(key));
          // The city has no inside, so a row about it is a row about nothing --
          // and is what a corrupt or hand-written key decodes to.
          if (space === CITY_SPACE) continue;
          if (!Array.isArray(list)) continue;
          const kept: Placement[] = [];
          for (const item of list) {
            const p = sanitisePlacement(item);
            if (p !== null && kept.length < MAX_PER_SPACE) kept.push(p);
          }
          if (kept.length > 0 && this.rooms.size < MAX_SPACES) this.rooms.set(space, kept);
        }
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'ENOENT') {
        const aside = `${this.path}.bad-${Date.now()}`;
        console.error(`[sydney] interiors: ${this.path} would not parse; moved to ${aside}`);
        await Bun.$`mv -f ${this.path} ${aside}`.quiet().nothrow();
      }
    }
  }

  /** What is in this building. The array is **shared, not copied**; do not edit it. */
  for(space: number): readonly Placement[] {
    return this.rooms.get(space) ?? EMPTY;
  }

  /** How many buildings anybody has furnished. For `/health` and the boot line. */
  get size(): number {
    return this.rooms.size;
  }

  /** Every placement on the box, for the boot line. */
  get items(): number {
    let n = 0;
    for (const list of this.rooms.values()) n += list.length;
    return n;
  }

  /**
   * Replace what is in a building.
   *
   * Returns false when the box is full of buildings, which is the one refusal a
   * caller has to pass on: the player pressed a key and nothing happened, and
   * they are entitled to be told why.
   */
  set(space: number, list: readonly Placement[]): boolean {
    const id = sanitiseSpace(space);
    if (id === CITY_SPACE) return false;
    if (list.length === 0) {
      // An emptied room stops being a row. A building with nothing in it is
      // indistinguishable from one nobody has touched, and keeping the key
      // would leak a row per building anybody ever put one couch in.
      if (this.rooms.delete(id)) this.touch();
      return true;
    }
    if (!this.rooms.has(id) && this.rooms.size >= MAX_SPACES) return false;
    this.rooms.set(id, list.slice(0, MAX_PER_SPACE));
    this.touch();
    return true;
  }

  /** Flush. Called on the same shutdown path the wallets are. */
  async save(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.file = { version: 1, spaces: {} };
    for (const [space, list] of this.rooms) this.file.spaces[String(space)] = list;
    const tmp = `${this.path}.tmp-${process.pid}`;
    try {
      await Bun.write(tmp, JSON.stringify(this.file));
      await Bun.$`mv -f ${tmp} ${this.path}`.quiet();
    } catch (err) {
      this.dirty = true;
      console.error(`[sydney] interiors: could not write ${this.path}: ${String(err)}`);
    }
  }

  /** Mark dirty and schedule a write. Debounced; see `SAVE_DEBOUNCE_MS`. */
  private touch(): void {
    this.dirty = true;
    if (!this.persist || this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, SAVE_DEBOUNCE_MS);
  }
}

const EMPTY: readonly Placement[] = [];

/** Self-check. Server-side only: it is the only end with a disk. */
export function verifyInteriorStore(): string[] {
  const failures: string[] = [];
  const store = new InteriorStore('/dev/null/never-written', false);
  const couch = (x: number): Placement => ({ kind: 0, x, z: 0, turn: 0 });

  // --- A room holds what it was given, and the city holds nothing.
  {
    if (store.for(4242).length !== 0) failures.push('a building nobody has furnished came back with something in it.');
    if (!store.set(4242, [couch(1), couch(4)])) failures.push('a room refused two couches.');
    if (store.for(4242).length !== 2) failures.push(`the room came back with ${store.for(4242).length} of 2.`);
    if (store.set(CITY_SPACE, [couch(1)])) failures.push('the street accepted furniture; the city has no inside.');
    if (store.for(CITY_SPACE).length !== 0) failures.push('the street came back furnished.');
  }

  // --- The per-building cap is a cap.
  {
    const many: Placement[] = [];
    for (let i = 0; i < MAX_PER_SPACE * 3; i++) many.push(couch(i));
    store.set(99, many);
    if (store.for(99).length !== MAX_PER_SPACE) {
      failures.push(`a room took ${store.for(99).length} things against a cap of ${MAX_PER_SPACE}.`);
    }
  }

  // --- An emptied room stops being a row, so the file cannot grow one key per
  //     building anybody ever put a single couch in and took it away again.
  {
    const before = store.size;
    store.set(4242, []);
    if (store.size !== before - 1) failures.push('emptying a room left its row behind.');
    if (store.for(4242).length !== 0) failures.push('an emptied room still has something in it.');
  }

  // --- And the counters are the counters, because a boot line that lies about
  //     how much is on disk is how a cap goes unnoticed.
  {
    const fresh = new InteriorStore('/dev/null/never-written', false);
    fresh.set(1, [couch(0), couch(3)]);
    fresh.set(2, [couch(0)]);
    if (fresh.size !== 2) failures.push(`${fresh.size} buildings against 2.`);
    if (fresh.items !== 3) failures.push(`${fresh.items} placements against 3.`);
  }

  return failures;
}
