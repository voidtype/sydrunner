/**
 * Turf: which side holds each hexagon of Sydney.
 *
 * The owner's brief: *"Introduce capture the flag where sydney regions get
 * taken over by Marita or DeFAULT and make that visible as the default map
 * view, with a circle drawn on the edge."* This is the model both ends run;
 * `server/territory.ts` is the ledger and the disk, `bigmap.ts` is the picture.
 *
 * ---------------------------------------------------------------------------
 * ## The regions are the hexagons, and the hexagons already exist
 *
 * `world/hexes.ts` cuts the 60 km disc into 86 hexagons of 6 km circumradius
 * so the world can stream in pieces. They are the right size for turf too: a
 * hexagon is a few suburbs -- Newtown with Enmore and Stanmore, the CBD with
 * Pyrmont and Darlinghurst -- which is the scale at which a side can *hold*
 * something between Monday and Monday (DESIGN.md rule 3). Suburbs themselves
 * (870 of them) would be a map nobody could read and a war nobody could win;
 * local government areas are not in the data. And the hexagons are already
 * on both ends, keyed by axial `(q, r)`, with their centres in world metres,
 * so a region needs no new file. Each is *named* for the map by the suburb
 * nearest its centre (`nearestName`), which is rule 1: the feed says "Marita
 * took Parramatta", never "hex 3,-2".
 *
 * ## The rule, which is a margin and nothing else
 *
 * A KO of somebody not on your side, credited to the hexagon it happened in,
 * is one point for your side there. A hexagon belongs to the side with a lead
 * of `CAPTURE_MARGIN` points; inside the margin it stays with whoever held it.
 * The hysteresis is the whole design: without it the two sides trade a
 * hexagon on every kill and the map flickers, and with a margin of two a
 * side has to *win* a fight, not land a punch. There is no decay and no
 * presence scoring -- standing around is not a contribution (rule 7: the
 * race is XP) -- and everything resets with the week (`weekOf`), because a
 * side that owned the city in March is not a reason to join it in June.
 *
 * Nothing about turf changes what a player can do: no buffs in held ground
 * (the owner dislikes buffs), no locked doors, no spawn changes. It is a
 * scoreboard with a shape, and the shape is the point -- rule 6, the city
 * reacts and the UI does not shout: a wash of colour on the map and one line
 * in the feed when a hexagon changes hands.
 *
 * ## The wire is tiny and rare
 *
 * `MSG.TERRITORY` carries every held hexagon at seven bytes each -- at most
 * 86 of them, 604 bytes -- on welcome and again only when one changes hands,
 * which is a handful of times an hour across the whole box (rule 8). Scores
 * ride along so the map can show how close a fight is, but a score alone
 * never sends a frame.
 *
 * Three-free and pure, imported by both ends: `hexAt` is the same nearest-
 * centre lookup on the server that decides the credit and on the client that
 * colours the ground under the compass.
 */

import { TEAM, type Team } from './teams.ts';
import type { TerritoryEntry } from '../net/protocol.ts';

/** The lead one side needs over the other to hold a hexagon. See the header. */
export const CAPTURE_MARGIN = 2;

/** The wire's `u16`, and the ledger's ceiling. */
export const SCORE_MAX = 65535;

/** The wire's `i8` on each axial coordinate; 86 hexagons use -6..6. */
export const HEX_COORD_MAX = 127;

/** The ledger's key for a hexagon. */
export function hexKey(q: number, r: number): string {
  return `${q},${r}`;
}

/**
 * Who holds a hexagon, given the two scores and who held it last.
 *
 * Pure, and the only place the margin is applied: the server runs it on every
 * point and the client asserts it in `verifyTerritory`.
 */
export function captureOwner(marita: number, dflt: number, owner: number): Team {
  if (marita >= dflt + CAPTURE_MARGIN) return TEAM.MARITA;
  if (dflt >= marita + CAPTURE_MARGIN) return TEAM.DEFAULT;
  return owner === TEAM.MARITA || owner === TEAM.DEFAULT ? owner : TEAM.NONE;
}

/** What `hexAt` needs of a hexagon: `world/hexes.HexEntry` has it. */
export interface HexSeat {
  q: number;
  r: number;
  c: readonly [number, number] | [number, number];
}

/**
 * The hexagon a point is in: the nearest centre, which for a regular grid is
 * the containing cell. A linear scan, because there are 86 of them and this
 * runs once per KO on the server and once per frame on the client.
 */
export function hexAt<T extends HexSeat>(hexes: readonly T[], x: number, z: number): T | null {
  let best: T | null = null;
  let bestD = Infinity;
  for (const h of hexes) {
    const dx = h.c[0] - x;
    const dz = h.c[1] - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return best;
}

/** A suburb node, as `world/suburbs.json` carries it. */
export interface NamedPoint {
  name: string;
  x: number;
  z: number;
}

/** The nearest named place to a point, for saying which hexagon changed hands. */
export function nearestName(points: readonly NamedPoint[], x: number, z: number): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const p of points) {
    const dx = p.x - x;
    const dz = p.z - z;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = p.name;
    }
  }
  return best;
}

/** One hexagon changing hands, as `Territory.apply` reports it. */
export interface TerritoryFlip {
  q: number;
  r: number;
  owner: Team;
  was: Team;
}

/** A team byte off the wire, made a `Team`. Anything else is nobody. */
export function teamByte(owner: number): Team {
  return owner === TEAM.MARITA || owner === TEAM.DEFAULT ? owner : TEAM.NONE;
}

/**
 * The client's copy of the ledger: the last `TERRITORY` frame, whole.
 *
 * Replaced wholesale by every frame, because the frame is the whole list; a
 * hexagon absent from it is held by nobody. `apply` says which hexagons
 * changed hands so the feed can say so, and bumps `version` so the map knows
 * to repaint.
 */
export class Territory {
  readonly entries = new Map<string, TerritoryEntry>();
  version = 0;

  apply(list: readonly TerritoryEntry[]): TerritoryFlip[] {
    const flips: TerritoryFlip[] = [];
    const seen = new Set<string>();
    for (const e of list) {
      const key = hexKey(e.q, e.r);
      seen.add(key);
      const owner = teamByte(e.owner);
      const was = teamByte(this.entries.get(key)?.owner ?? TEAM.NONE);
      if (was !== owner) flips.push({ q: e.q, r: e.r, owner, was });
      this.entries.set(key, { q: e.q, r: e.r, owner, marita: e.marita, dflt: e.dflt });
    }
    for (const [key, e] of [...this.entries]) {
      if (seen.has(key)) continue;
      this.entries.delete(key);
      const was = teamByte(e.owner);
      if (was !== TEAM.NONE) flips.push({ q: e.q, r: e.r, owner: TEAM.NONE, was });
    }
    this.version++;
    return flips;
  }

  ownerOf(q: number, r: number): Team {
    return teamByte(this.entries.get(hexKey(q, r))?.owner ?? TEAM.NONE);
  }

  /** The scores at a hexagon, or zeros where nobody has fought. */
  scoresOf(q: number, r: number): { marita: number; dflt: number } {
    const e = this.entries.get(hexKey(q, r));
    return { marita: e?.marita ?? 0, dflt: e?.dflt ?? 0 };
  }

  ownerAt<T extends HexSeat>(hexes: readonly T[], x: number, z: number): Team {
    const h = hexAt(hexes, x, z);
    return h === null ? TEAM.NONE : this.ownerOf(h.q, h.r);
  }

  /** How many hexagons each side holds, and how many nobody does, of `total`. */
  tally(total: number): { marita: number; dflt: number; none: number } {
    let marita = 0;
    let dflt = 0;
    for (const e of this.entries.values()) {
      if (e.owner === TEAM.MARITA) marita++;
      else if (e.owner === TEAM.DEFAULT) dflt++;
    }
    return { marita, dflt, none: Math.max(0, total - marita - dflt) };
  }
}

export function verifyTerritory(): string[] {
  const failures: string[] = [];

  // --- The margin: a side has to lead by two, and a tie keeps the holder.
  {
    const cases: Array<[number, number, Team, Team, string]> = [
      [0, 0, TEAM.NONE, TEAM.NONE, 'an unfought hexagon belongs to nobody'],
      [1, 0, TEAM.NONE, TEAM.NONE, 'one point is not a lead of two'],
      [2, 0, TEAM.NONE, TEAM.MARITA, 'two clear points take a hexagon'],
      [2, 1, TEAM.MARITA, TEAM.MARITA, 'a lead of one keeps a held hexagon'],
      [2, 2, TEAM.MARITA, TEAM.MARITA, 'a tie keeps a held hexagon'],
      [2, 4, TEAM.MARITA, TEAM.DEFAULT, 'a lead of two the other way takes it back'],
      [3, 3, TEAM.NONE, TEAM.NONE, 'a tie in an unheld hexagon stays unheld'],
      [7, 9, TEAM.DEFAULT, TEAM.DEFAULT, 'the holder with the lead keeps it'],
    ];
    for (const [m, d, was, want, why] of cases) {
      const got = captureOwner(m, d, was);
      if (got !== want) failures.push(`captureOwner(${m}, ${d}, ${was}) = ${got}, not ${want}: ${why}.`);
    }
    if (captureOwner(9, 0, 7 as Team) !== TEAM.MARITA) failures.push('a garbage holder byte did not yield to the lead.');
    if (captureOwner(1, 1, 7 as Team) !== TEAM.NONE) failures.push('a garbage holder byte was kept.');
  }

  // --- The hexagon under a point is the nearest centre.
  {
    const seats: HexSeat[] = [
      { q: 0, r: 0, c: [0, 0] },
      { q: 1, r: 0, c: [10392, 0] },
      { q: 0, r: 1, c: [5196, 9000] },
    ];
    if (hexAt(seats, 100, -50)?.q !== 0) failures.push('a point beside the origin is not in the origin hexagon.');
    if (hexAt(seats, 9000, 500)?.q !== 1) failures.push('a point near the east neighbour landed elsewhere.');
    const north = hexAt(seats, 5000, 8000);
    if (north === null || north.r !== 1) failures.push('a point near the north-east neighbour landed elsewhere.');
    if (hexAt([], 0, 0) !== null) failures.push('an empty grid found a hexagon.');
    if (nearestName([{ name: 'Newtown', x: 0, z: 0 }, { name: 'Enmore', x: 900, z: 0 }], 700, 0) !== 'Enmore') {
      failures.push('the nearest name is not the nearest.');
    }
    if (nearestName([], 0, 0) !== null) failures.push('no places produced a name.');
  }

  // --- The client copy reports exactly the hexagons that changed hands.
  {
    const t = new Territory();
    const first = t.apply([
      { q: 0, r: 0, owner: TEAM.MARITA, marita: 3, dflt: 1 },
      { q: 1, r: 0, owner: TEAM.NONE, marita: 1, dflt: 1 },
      { q: 0, r: 1, owner: TEAM.DEFAULT, marita: 0, dflt: 2 },
    ]);
    if (first.length !== 2) failures.push(`the first frame reported ${first.length} flips; two hexagons are held.`);
    if (t.ownerOf(0, 0) !== TEAM.MARITA || t.ownerOf(1, 0) !== TEAM.NONE || t.ownerOf(0, 1) !== TEAM.DEFAULT) {
      failures.push('the first frame did not land as sent.');
    }
    const tally = t.tally(86);
    if (tally.marita !== 1 || tally.dflt !== 1 || tally.none !== 84) failures.push(`the tally reads ${JSON.stringify(tally)}.`);
    const second = t.apply([
      { q: 0, r: 0, owner: TEAM.DEFAULT, marita: 3, dflt: 5 },
      { q: 0, r: 1, owner: TEAM.DEFAULT, marita: 0, dflt: 2 },
    ]);
    if (second.length !== 1 || second[0].owner !== TEAM.DEFAULT || second[0].was !== TEAM.MARITA) {
      failures.push(`the second frame reported ${JSON.stringify(second)}; one hexagon changed hands.`);
    }
    if (t.entries.has(hexKey(1, 0))) failures.push('a hexagon absent from a frame was kept.');
    const third = t.apply([]);
    if (third.length !== 2 || third.some((f) => f.owner !== TEAM.NONE || f.was !== TEAM.DEFAULT)) {
      failures.push('two held hexagons dropped from the frame did not both report going unheld.');
    }
    if (t.version !== 3) failures.push(`three frames left the version at ${t.version}.`);
    const seats: HexSeat[] = [{ q: 0, r: 0, c: [0, 0] }, { q: 1, r: 0, c: [10392, 0] }];
    t.apply([{ q: 1, r: 0, owner: TEAM.MARITA, marita: 2, dflt: 0 }]);
    if (t.ownerAt(seats, 9000, 0) !== TEAM.MARITA) failures.push('the owner under a point is not the hexagon\'s.');
    if (t.ownerAt(seats, 0, 0) !== TEAM.NONE) failures.push('an unheld hexagon has an owner under it.');
    if (t.scoresOf(1, 0).marita !== 2 || t.scoresOf(9, 9).dflt !== 0) failures.push('scores did not read back.');
    if (teamByte(3) !== TEAM.NONE || teamByte(TEAM.DEFAULT) !== TEAM.DEFAULT) failures.push('a team byte was misread.');
  }

  return failures;
}
