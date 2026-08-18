/**
 * The teams feature on the wire: one client message with four sub-ops, and one
 * server message that says who is on which side and what they have spent.
 *
 * `client/src/net/cash.ts` is the file this one is shaped after, and the split
 * is the same one that file makes: `game/teams.ts` holds the **rules** -- the
 * 42 nodes, the tier gates, `takeRefusal` -- and this holds the **bytes**. Both
 * ends import both. Nothing here knows what a talent does; nothing there knows
 * what a frame looks like.
 *
 * ---------------------------------------------------------------------------
 * WHY FOUR OPERATIONS ARE ONE MESSAGE ID
 *
 * `net/suggestions.SUGGEST_OP` argued this first and `net/cash.PHONE_OP`
 * repeated it: choosing a side, spending a point, taking one back and starting
 * again are one conversation, held from one screen, a handful of times a week.
 * Four message ids would be four cases in `server/index.ts`'s switch for one
 * feature, and the flood budget -- which is per socket and counts this
 * feature's traffic -- would have had to be summed across all four.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MASK IS TWO `u32`s AND NOT A `BigInt64`
 *
 * `game/teams.TalentMask` is already `{lo, hi}` for a reason its own comment
 * gives, and this is the other half of it: `DataView` has `getBigUint64`, and a
 * `BigInt` on the hot path of a decoder is an allocation per player per frame in
 * a language where the cheap integer is 32 bits. Two `u32`s are two loads and
 * two stores, the mask arithmetic in the contract is `>>>` and `|` throughout,
 * and 42 nodes fit in 64 bits with 22 to spare.
 *
 * ---------------------------------------------------------------------------
 * WHY A REFUSAL IS NOT ON THIS MESSAGE
 *
 * The obvious design is a `TALENT_ACK` carrying "needs 2 in Servo" -- which is
 * what `SUGGEST_ACK` does one file over. It is not done here, and the reason is
 * `Simulation.note`'s header: this process already has exactly one per-player
 * text channel to a client (`WalletFrame.note`, drawn by `hud.notice`), it was
 * built for precisely this shape of sentence, and a second one would be a
 * second decoder and a second cadence to get right in `Room.step` to say a
 * sentence a handful of times a week. The client also composes the *same*
 * refusal locally for the tooltip, off `takeRefusal` in the shared contract, so
 * the panel is never waiting on a round trip to grey a node out. The server's
 * sentence exists for the case the two disagree -- a stale client, a hand-built
 * one -- and that case wants the pill, not a tooltip.
 */

import {
  EMPTY_MASK,
  NODE_COUNT,
  TEAM,
  type TalentMask,
  type Team,
} from '../game/teams.ts';
import { MSG, teamByte } from './protocol.ts';

// --- Going up: what a player asks for -----------------------------------------------

/**
 * The four things a player can do to their own build.
 *
 * `CHOOSE` carries a team and the rest carry a node id, which is why the frame
 * is three bytes for all of them rather than two shapes: one byte of payload
 * covers a team (0..2) and a node id (0..41) alike, and a fixed stride means
 * the decoder has no length arithmetic in it at all.
 *
 * **`RESET_ALL` is one operation rather than 41 `REFUND`s**, and that is the
 * only interesting one in the list. Refunding a full build a node at a time is
 * not merely tedious: `refundRefusal` refuses any node a higher tier stands on,
 * so a player unwinding a finished tree has to work out the topological order
 * themselves, from the bottom, and a mistake is a refusal they have to read.
 * The server can drop the whole mask at once because there is nothing to
 * order -- and it is rate-limited to once per in-game day for the reason any
 * free respec is: a build you can change in front of the thing you are fighting
 * is not a build, it is a menu.
 */
export const TEAM_OP = {
  /** Payload is a `TEAM.*`. Allowed once per account, ever. */
  CHOOSE: 0,
  /** Payload is a node id, 0..41. */
  TAKE: 1,
  /** Payload is a node id, 0..41. */
  REFUND: 2,
  /** Payload ignored. Once per in-game day. */
  RESET_ALL: 3,
} as const;

export interface TeamRequest {
  op: number;
  /** A `TEAM.*` for `CHOOSE`, a node id for `TAKE`/`REFUND`, 0 for `RESET_ALL`. */
  value: number;
}

/** Three bytes, always: type, op, payload. */
export const TEAM_REQUEST_BYTES = 3;

/**
 * Client to server, `MSG.TEAM`:
 *
 *     u8   type = MSG.TEAM
 *     u8   op        TEAM_OP.*
 *     u8   value     a team, a node id, or nothing
 *
 * `type` is a parameter rather than a constant for `encodePhone`'s reason: the
 * check that a decoder refuses a frame addressed to a different message is only
 * a real check if the encoder can be asked to produce one.
 */
export function encodeTeamOp(type: number, op: number, value = 0): ArrayBuffer {
  const buffer = new ArrayBuffer(TEAM_REQUEST_BYTES);
  const v = new DataView(buffer);
  v.setUint8(0, type);
  v.setUint8(1, op);
  v.setUint8(2, Math.max(0, Math.min(255, Math.trunc(value) || 0)));
  return buffer;
}

/**
 * The server's decoder. Returns null rather than throwing, and refuses an op it
 * does not know -- `decodePhone`'s rule, for `decodeSuggest`'s reason: the
 * cheapest thing a hostile client can send is a byte nobody wrote a case for,
 * and this runs inside the socket callback that serves every player on the host.
 *
 * The *value* is deliberately **not** validated here. A node id of 200 and a
 * team of 7 are both refused by `game/teams.takeRefusal` and by
 * `Simulation.teamOp`'s `CHOOSE` branch, in the one place the rules live, and a
 * second range test in the decoder would be a second opinion about the same
 * question that goes stale the day a 43rd node is added.
 */
export function decodeTeamOp(buffer: ArrayBuffer, type: number): TeamRequest | null {
  if (buffer.byteLength < TEAM_REQUEST_BYTES) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== type) return null;
  const op = v.getUint8(1);
  if (op !== TEAM_OP.CHOOSE && op !== TEAM_OP.TAKE && op !== TEAM_OP.REFUND && op !== TEAM_OP.RESET_ALL) {
    return null;
  }
  return { op, value: v.getUint8(2) };
}

// --- Coming down: who is on which side, and what they spent -------------------------

/**
 * One player's whole build, as the room publishes it.
 *
 * `level` rides here as well as on the roster; `MSG.TALENTS`' own note says why
 * (the panel's "points left" and its spent set have to come out of one frame or
 * they disagree for a frame). `team` rides here as well for the same reason and
 * one more: the two messages have different cadences, and a panel that read the
 * side off the roster would draw the wrong colour for up to two seconds after a
 * choice.
 */
export interface TalentsRecord {
  playerId: number;
  team: Team;
  level: number;
  lo: number;
  hi: number;
}

export const TALENTS_HEADER_BYTES = 3;
/** id `u16`, team `u8`, level `u8`, mask `u32` + `u32`. */
export const TALENTS_ENTRY_BYTES = 12;

export function talentsBytes(count: number): number {
  return TALENTS_HEADER_BYTES + count * TALENTS_ENTRY_BYTES;
}

/**
 * Server to client, `MSG.TALENTS`:
 *
 *     u8   type = MSG.TALENTS
 *     u16  count
 *     per entry:
 *       u16  player id
 *       u8   team          0 none, 1 Marita, 2 DeFAULT
 *       u8   level         1..255
 *       u32  mask lo       node ids 0..31
 *       u32  mask hi       node ids 32..63
 *
 * **A replacement, not an upsert**, which is `MSG.HEAT`'s call for `MSG.HEAT`'s
 * reason: a player who leaves is a record that must stop existing, and a delete
 * that went missing would leave horns on an empty id -- which the renderer would
 * happily keep drawing over whoever inherits it. There is no delete record here
 * and none is wanted; the set is the set.
 *
 * At twelve bytes an entry a full 128-player room is 1.5 kB. It is sent on
 * change only -- see `Room.sendTalents`, which explains why "change" already
 * includes a join and therefore why there is no refresh timer.
 */
export function encodeTalents(records: readonly TalentsRecord[]): ArrayBuffer {
  const buffer = new ArrayBuffer(talentsBytes(records.length));
  encodeTalentsInto(new DataView(buffer), records);
  return buffer;
}

/** The same bytes into a caller-owned buffer, returning the length written. */
export function encodeTalentsInto(v: DataView, records: readonly TalentsRecord[]): number {
  v.setUint8(0, MSG.TALENTS);
  v.setUint16(1, Math.min(records.length, 65535), true);
  let p = TALENTS_HEADER_BYTES;
  for (const r of records) {
    v.setUint16(p, r.playerId & 0xffff, true);
    // Folded rather than masked, exactly as the roster's team byte is: the
    // renderer indexes a colour table with this.
    v.setUint8(p + 2, teamByte(r.team));
    // Clamped, on `encodeRoster`'s argument: a level of 256 masked to 0 is a
    // player with no points at all, which is a panel that refuses every node.
    v.setUint8(p + 3, Math.max(1, Math.min(255, Math.round(r.level || 1))));
    // `>>> 0` because the contract's own mask arithmetic produces signed
    // integers -- `1 << 31` is negative in JavaScript -- and `setUint32` of a
    // negative number is a wrap that the decoder cannot undo.
    v.setUint32(p + 4, r.lo >>> 0, true);
    v.setUint32(p + 8, r.hi >>> 0, true);
    p += TALENTS_ENTRY_BYTES;
  }
  return p;
}

/**
 * Bounded by what **arrived** rather than by what the count claims, on
 * `decodeHeat`'s rule: a `DataView` read past the end throws, and a throw inside
 * a socket callback takes the client's whole message pump with it.
 */
export function decodeTalents(buffer: ArrayBuffer): TalentsRecord[] | null {
  if (buffer.byteLength < TALENTS_HEADER_BYTES) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== MSG.TALENTS) return null;
  const count = v.getUint16(1, true);
  const out: TalentsRecord[] = [];
  let p = TALENTS_HEADER_BYTES;
  for (let i = 0; i < count && p + TALENTS_ENTRY_BYTES <= buffer.byteLength; i++) {
    out.push({
      playerId: v.getUint16(p, true),
      team: teamByte(v.getUint8(p + 2)) as Team,
      level: v.getUint8(p + 3) || 1,
      // Bits past `NODE_COUNT` are dropped here rather than tolerated. They
      // cannot come from this server, and if they ever did they would be
      // talents that do not exist: `hasNode` would answer true for a node id
      // `nodeById` answers `undefined` for, and every consumer in the contract
      // walks `NODES` rather than the mask -- so the bit would be invisible
      // everywhere except `countBits`, which is what decides how many points
      // you have left. A panel that says "no points left" with nothing spent is
      // the exact silent failure this repo writes decoders against.
      lo: v.getUint32(p + 4, true) >>> 0,
      hi: (v.getUint32(p + 8, true) & HI_NODE_MASK) >>> 0,
    });
    p += TALENTS_ENTRY_BYTES;
  }
  return out;
}

/**
 * The bits of the high word that are real nodes. 42 nodes means ids 32..41 are
 * the low ten bits of `hi`; everything above is nothing.
 *
 * Derived rather than written as `0x3ff`, so that adding a 43rd node to the
 * contract widens this automatically instead of silently discarding it.
 */
const HI_NODE_MASK = NODE_COUNT <= 32 ? 0 : (0xffffffff >>> (64 - NODE_COUNT)) | 0;

/** The mask off a record, as the contract's own type. */
export function maskOf(record: Pick<TalentsRecord, 'lo' | 'hi'>): TalentMask {
  return { lo: record.lo >>> 0, hi: record.hi >>> 0 };
}

// --- The self-check ------------------------------------------------------------------

/**
 * The round trips, run at boot in **both** runtimes.
 *
 * `verifyTeams` in the contract covers the rules; this covers the bytes, and the
 * two failures it exists for are the ones that render:
 *
 *   - **A mask that loses its top bit.** `1 << 31` is negative in JavaScript, so
 *     an encoder that forgot `>>> 0` writes a wrapped `u32` and the player comes
 *     back with a different build -- specifically, one node missing, which reads
 *     as "the game took my talent away" rather than as a wire bug.
 *   - **A team byte that is not folded.** The renderer indexes `TEAM_COLOUR`
 *     with it and an undefined lookup inside the nameplate loop takes the frame.
 *
 * And it re-asserts that the three numbers in `teamByte` are still the enum's,
 * which is the seam `net/protocol.ts` deliberately does not import across.
 */
export function verifyTeamsWire(): string[] {
  const failures: string[] = [];

  // --- The numbers `protocol.teamByte` hard-codes are the contract's.
  {
    if (TEAM.NONE !== 0 || TEAM.MARITA !== 1 || TEAM.DEFAULT !== 2) {
      failures.push('TEAM moved off 0/1/2; protocol.teamByte writes those numbers out and would now fold a real team away.');
    }
    for (const raw of [0, 1, 2]) {
      if (teamByte(raw) !== raw) failures.push(`teamByte refused ${raw}, which is a real team.`);
    }
    for (const raw of [3, 9, 255, -1]) {
      if (teamByte(raw) !== 0) failures.push(`teamByte let ${raw} through as ${teamByte(raw)}; it must fold to none.`);
    }
  }

  // --- The request, all four ops, through the real encoder and decoder.
  {
    const cases: Array<[number, number]> = [
      [TEAM_OP.CHOOSE, TEAM.MARITA],
      [TEAM_OP.CHOOSE, TEAM.DEFAULT],
      [TEAM_OP.TAKE, 0],
      [TEAM_OP.TAKE, NODE_COUNT - 1],
      [TEAM_OP.REFUND, 7],
      [TEAM_OP.RESET_ALL, 0],
    ];
    for (const [op, value] of cases) {
      const got = decodeTeamOp(encodeTeamOp(MSG.TEAM, op, value), MSG.TEAM);
      if (!got || got.op !== op || got.value !== value) {
        failures.push(`A ${op}/${value} team op came back as ${JSON.stringify(got)}.`);
      }
    }
    // Addressed to somebody else. This is the halves rule's whole payoff and it
    // is one comparison; see `MSG`'s header.
    if (decodeTeamOp(encodeTeamOp(MSG.TEAM, TEAM_OP.TAKE, 3), MSG.PHONE) !== null) {
      failures.push('A TEAM frame was decoded as a PHONE frame.');
    }
    // An op nobody wrote a case for.
    const bogus = new DataView(new ArrayBuffer(TEAM_REQUEST_BYTES));
    bogus.setUint8(0, MSG.TEAM);
    bogus.setUint8(1, 99);
    if (decodeTeamOp(bogus.buffer, MSG.TEAM) !== null) failures.push('An unknown team op was decoded anyway.');
    // And every truncation of a real frame, which must be null rather than a
    // throw: this decoder runs inside `server/index.ts`'s message switch.
    const frame = encodeTeamOp(MSG.TEAM, TEAM_OP.TAKE, 12);
    try {
      for (let n = 0; n < frame.byteLength; n++) decodeTeamOp(frame.slice(0, n), MSG.TEAM);
    } catch {
      failures.push('A truncated team op threw rather than returning null.');
    }
  }

  // --- The broadcast, including the two masks that are easy to get wrong.
  {
    const records: TalentsRecord[] = [
      { playerId: 1, team: TEAM.MARITA, level: 10, lo: 0b1010_0001, hi: 0 },
      { playerId: 2, team: TEAM.DEFAULT, level: 8, lo: 0, hi: 0x3ff },
      { playerId: 65535, team: TEAM.NONE, level: 1, lo: 0, hi: 0 },
      // The top bit of the low word: node 31 exists (`Sizzle Aura` is 33, but
      // 31 is `Click & Collect`), and `1 << 31` is -2147483648.
      { playerId: 7, team: TEAM.DEFAULT, level: 9, lo: (1 << 31) >>> 0, hi: 0 },
      // Every real node at once, which is not a build a player can have and is
      // exactly the frame a wire bug survives.
      { playerId: 8, team: TEAM.MARITA, level: 10, lo: 0xffffffff, hi: HI_NODE_MASK >>> 0 },
    ];
    const frame = encodeTalents(records);
    if (frame.byteLength !== talentsBytes(records.length)) {
      failures.push(`A ${records.length}-entry TALENTS frame is ${frame.byteLength} bytes; the layout says ${talentsBytes(records.length)}.`);
    }
    const got = decodeTalents(frame);
    if (!got || got.length !== records.length) {
      failures.push(`A ${records.length}-entry TALENTS frame came back as ${got ? got.length : 'null'}.`);
    } else {
      for (let i = 0; i < records.length; i++) {
        const a = records[i];
        const b = got[i];
        if (b.playerId !== a.playerId || b.team !== a.team || b.level !== a.level) {
          failures.push(`TALENTS entry ${a.playerId}: identity came back as ${b.playerId}/${b.team}/${b.level}.`);
        }
        if ((b.lo >>> 0) !== (a.lo >>> 0) || (b.hi >>> 0) !== (a.hi >>> 0)) {
          failures.push(
            `TALENTS entry ${a.playerId}: mask ${(a.lo >>> 0).toString(16)}/${(a.hi >>> 0).toString(16)} ` +
              `came back as ${(b.lo >>> 0).toString(16)}/${(b.hi >>> 0).toString(16)}.`,
          );
        }
      }
    }
    // Bits above the last real node are dropped, not carried. See the decoder.
    const alien = decodeTalents(encodeTalents([{ playerId: 3, team: TEAM.MARITA, level: 2, lo: 0xffffffff, hi: 0xffffffff }]));
    if (!alien || alien[0].hi !== (HI_NODE_MASK >>> 0)) {
      failures.push(`A mask with bits past node ${NODE_COUNT - 1} came back as ${alien?.[0].hi.toString(16)}; they must be dropped.`);
    }
    // An empty set is a real frame -- it is every room before anybody reaches
    // level 2 -- and must not decode as null.
    const none = decodeTalents(encodeTalents([]));
    if (!none || none.length !== 0) failures.push('An empty TALENTS frame did not decode as an empty list.');
    // A truncated tail is dropped rather than thrown on.
    try {
      const short = decodeTalents(frame.slice(0, TALENTS_HEADER_BYTES + TALENTS_ENTRY_BYTES + 5));
      if (short === null || short.length !== 1) {
        failures.push(`A truncated TALENTS frame gave ${short === null ? 'null' : short.length} entries rather than 1.`);
      }
    } catch {
      failures.push('A truncated TALENTS frame threw rather than dropping its tail.');
    }
    if (decodeTalents(encodeTeamOp(MSG.TEAM, TEAM_OP.TAKE, 1)) !== null) {
      failures.push('A TEAM frame was decoded as a TALENTS frame.');
    }
  }

  // --- And the empty mask the contract exports is the empty mask on the wire,
  // which is the case every guest and every fresh account is in.
  {
    const back = decodeTalents(encodeTalents([{ playerId: 4, team: TEAM.NONE, level: 1, lo: EMPTY_MASK.lo, hi: EMPTY_MASK.hi }]));
    const mask = back === null ? null : maskOf(back[0]);
    if (!mask || mask.lo !== 0 || mask.hi !== 0) failures.push(`An empty mask came back as ${JSON.stringify(mask)}.`);
  }

  return failures;
}
