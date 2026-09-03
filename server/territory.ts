/**
 * The turf ledger: every hexagon's two scores and its holder, for the week,
 * on disk.
 *
 * `game/territory.ts` is the rule; this is the only thing that applies it.
 * One store per process, shared by every room the host runs, because a
 * hexagon held by Marita cannot depend on which room the gateway put you in
 * -- the same argument `server/wallets.ts` makes for a balance. `Simulation`
 * calls `record` at the KO funnel; `Room` sends the whole table on welcome
 * and again whenever `version` moves, which is only when a hexagon changes
 * hands or the week rolls.
 *
 * `server/interiors.ts`' shape down to the debounce: a JSON file under
 * `SYDNEY_STATE_DIR`, written five seconds after the last change, replaced
 * atomically. Losing five seconds of turf costs one side a point it will win
 * again in the next fight. The file carries the ISO week it belongs to and a
 * file from another week is simply not loaded: Monday is the reset (DESIGN.md
 * rule 3), and the reset is a comparison rather than a cron.
 */

import { TEAM, type Team } from '../client/src/game/teams.ts';
import { HEX_COORD_MAX, SCORE_MAX, captureOwner, hexKey } from '../client/src/game/territory.ts';
import { weekOf } from '../client/src/net/accounts.ts';
import type { TerritoryEntry } from '../client/src/net/protocol.ts';

export function defaultTerritoryPath(): string {
  const dir = process.env.SYDNEY_STATE_DIR ?? './data/state';
  return `${dir}/territory.json`;
}

/** How long a write waits, milliseconds. `interiors.SAVE_DEBOUNCE_MS`, for its reason. */
export const SAVE_DEBOUNCE_MS = 5000;

interface Held {
  q: number;
  r: number;
  owner: Team;
  marita: number;
  dflt: number;
}

interface TerritoryFile {
  version: 1;
  week: string;
  hexes: Record<string, { q: number; r: number; o: number; m: number; d: number }>;
}

function int(v: unknown, lo: number, hi: number): number | null {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) return null;
  return n;
}

export class TerritoryStore {
  /** Bumped when a hexagon changes hands or the week rolls; rooms send on it. */
  version = 0;
  week: string;
  private readonly hexes = new Map<string, Held>();
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly path: string,
    private readonly persist = true,
    now: number = Date.now(),
  ) {
    this.week = weekOf(now);
  }

  /** How many hexagons have been fought over this week. */
  get size(): number {
    return this.hexes.size;
  }

  async load(now: number = Date.now()): Promise<void> {
    try {
      const text = await Bun.file(this.path).text();
      const raw = JSON.parse(text) as Partial<TerritoryFile>;
      if (raw.week !== weekOf(now)) return;
      if (typeof raw.hexes !== 'object' || raw.hexes === null) return;
      for (const h of Object.values(raw.hexes)) {
        const q = int(h?.q, -HEX_COORD_MAX, HEX_COORD_MAX);
        const r = int(h?.r, -HEX_COORD_MAX, HEX_COORD_MAX);
        const m = int(h?.m, 0, SCORE_MAX);
        const d = int(h?.d, 0, SCORE_MAX);
        if (q === null || r === null || m === null || d === null) continue;
        // The holder is recomputed rather than trusted: the rule may have
        // changed since the file was written, and the scores are the facts.
        const owner = captureOwner(m, d, int(h?.o, 0, 2) ?? TEAM.NONE);
        this.hexes.set(hexKey(q, r), { q, r, owner, marita: m, dflt: d });
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'ENOENT') {
        const aside = `${this.path}.bad-${Date.now()}`;
        console.error(`[sydney] territory: ${this.path} would not parse; moved to ${aside}`);
        await Bun.$`mv -f ${this.path} ${aside}`.quiet().nothrow();
      }
    }
  }

  /**
   * One point for `team` in the hexagon at `(q, r)`. Says who holds it now and
   * whether that just changed.
   */
  record(q: number, r: number, team: Team, now: number = Date.now()): { owner: Team; flipped: boolean } {
    this.rollWeek(now);
    const key = hexKey(q, r);
    let h = this.hexes.get(key);
    if (team !== TEAM.MARITA && team !== TEAM.DEFAULT) return { owner: h?.owner ?? TEAM.NONE, flipped: false };
    if (h === undefined) {
      h = { q, r, owner: TEAM.NONE, marita: 0, dflt: 0 };
      this.hexes.set(key, h);
    }
    if (team === TEAM.MARITA) h.marita = Math.min(SCORE_MAX, h.marita + 1);
    else h.dflt = Math.min(SCORE_MAX, h.dflt + 1);
    const owner = captureOwner(h.marita, h.dflt, h.owner);
    const flipped = owner !== h.owner;
    h.owner = owner;
    if (flipped) this.version++;
    this.touch();
    return { owner, flipped };
  }

  /** Monday. Everything is forgotten, and everybody is told. */
  rollWeek(now: number = Date.now()): boolean {
    const week = weekOf(now);
    if (week === this.week) return false;
    this.week = week;
    this.hexes.clear();
    this.version++;
    this.touch();
    return true;
  }

  ownerOf(q: number, r: number): Team {
    return this.hexes.get(hexKey(q, r))?.owner ?? TEAM.NONE;
  }

  /** The wire's table, in a fixed order so two frames of the same state are equal. */
  entries(): TerritoryEntry[] {
    const out: TerritoryEntry[] = [];
    for (const h of this.hexes.values()) out.push({ q: h.q, r: h.r, owner: h.owner, marita: h.marita, dflt: h.dflt });
    out.sort((a, b) => a.q - b.q || a.r - b.r);
    return out;
  }

  async save(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const file: TerritoryFile = { version: 1, week: this.week, hexes: {} };
    for (const [key, h] of this.hexes) file.hexes[key] = { q: h.q, r: h.r, o: h.owner, m: h.marita, d: h.dflt };
    const tmp = `${this.path}.tmp-${process.pid}`;
    try {
      await Bun.write(tmp, JSON.stringify(file));
      await Bun.$`mv -f ${tmp} ${this.path}`.quiet();
    } catch (err) {
      this.dirty = true;
      console.error(`[sydney] territory: could not write ${this.path}: ${String(err)}`);
    }
  }

  private touch(): void {
    this.dirty = true;
    if (!this.persist || this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, SAVE_DEBOUNCE_MS);
  }
}

export function verifyTerritoryStore(): string[] {
  const failures: string[] = [];
  const monday = Date.UTC(2026, 8, 7, 12); // a Monday
  const store = new TerritoryStore('/dev/null/never-written', false, monday);

  // --- Points accrue, the margin decides, and only a change of hands moves the version.
  {
    const v0 = store.version;
    const one = store.record(0, 0, TEAM.MARITA, monday);
    if (one.flipped || one.owner !== TEAM.NONE) failures.push('one point took a hexagon.');
    if (store.version !== v0) failures.push('a point that changed nothing moved the version.');
    const two = store.record(0, 0, TEAM.MARITA, monday);
    if (!two.flipped || two.owner !== TEAM.MARITA) failures.push('two points did not take a hexagon.');
    if (store.version !== v0 + 1) failures.push('a change of hands did not move the version once.');
    const back = store.record(0, 0, TEAM.DEFAULT, monday);
    if (back.flipped) failures.push('one point against a lead of two changed hands.');
    store.record(0, 0, TEAM.DEFAULT, monday);
    store.record(0, 0, TEAM.DEFAULT, monday);
    const tied = store.record(0, 0, TEAM.DEFAULT, monday);
    if (!tied.flipped || tied.owner !== TEAM.DEFAULT) failures.push('a lead of two the other way did not take it back.');
    if (store.ownerOf(0, 0) !== TEAM.DEFAULT) failures.push('the ledger disagrees with its own answer.');
    const nobody = store.record(1, 1, TEAM.NONE, monday);
    if (nobody.flipped || store.size !== 1) failures.push('an unaligned KO wrote a row.');
    if (store.entries().length !== 1 || store.entries()[0].dflt !== 4 || store.entries()[0].marita !== 2) {
      failures.push(`the table reads ${JSON.stringify(store.entries())}.`);
    }
  }

  // --- The table is ordered, so equal states encode equal.
  {
    store.record(-3, 2, TEAM.MARITA, monday);
    store.record(-3, 2, TEAM.MARITA, monday);
    store.record(2, -1, TEAM.DEFAULT, monday);
    const keys = store.entries().map((e) => `${e.q},${e.r}`);
    if (keys.join(' ') !== '-3,2 0,0 2,-1') failures.push(`the table is in the order ${keys.join(' ')}.`);
  }

  // --- Monday. The week rolls on the next point, not on a timer.
  {
    const v = store.version;
    const nextMonday = monday + 7 * 86_400_000;
    if (store.rollWeek(monday)) failures.push('the same week rolled.');
    const first = store.record(5, 5, TEAM.MARITA, nextMonday);
    if (store.size !== 1 || store.ownerOf(0, 0) !== TEAM.NONE) failures.push('last week\'s turf survived Monday.');
    if (first.flipped) failures.push('the first point of a new week took a hexagon.');
    if (store.version !== v + 1) failures.push('the roll did not move the version exactly once.');
    if (store.week !== weekOf(nextMonday)) failures.push('the store does not know what week it is.');
  }

  return failures;
}
