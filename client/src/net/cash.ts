/**
 * Three messages: the wallet down, the fare down, and the phone up.
 *
 * Imported by `client/src/phone.ts` (the overlay), by `client/src/main.ts` (the
 * HUD and the markers), by `server/sim.ts` (the adjudication) and by
 * `server/index.ts` (the socket), from the same path and for `net/protocol.ts`'s
 * founding reason: an encoder and a decoder that live in two files are two
 * files that disagree, and here the disagreement is a player paid twice.
 *
 * The codecs are **here rather than in `net/protocol.ts`** on
 * `net/suggestions.ts`'s precedent and for one additional reason of its own.
 * The precedent: a feature whose wire form is three variable-length records and
 * a sub-op byte is a feature that reads better next to the rules it serialises
 * than in the middle of the snapshot layout. The additional reason is that this
 * pass is one of six landing at once against one `net/protocol.ts`, and the
 * smallest thing this workstream can put in that file is three lines in `MSG`
 * -- which is what it puts there.
 *
 * ---------------------------------------------------------------------------
 * THE THREE IDS, AND WHY THE PHONE IS ONE MESSAGE WITH A SUB-OP
 *
 *     0x0e  PHONE      client -> server, sub-op byte. Claim, go online, go off.
 *     0x8f  WALLET     server -> client, on change and at join.
 *     0x90  FARE       server -> client, on change.
 *
 * `MSG.SUGGEST`'s argument, applied a second time and for the same two reasons:
 * three client ids would be three cases in `server/index.ts`'s switch for what
 * is one conversation with one screen, and the per-socket flood guard that
 * counts this feature's traffic would have to be summed across all three arms.
 * A player pressing "go online", driving four fares and claiming at two offices
 * sends eight of these in an hour.
 *
 * `0x0e` is under 0x80 and the other two are over it, which is `MSG`'s range
 * rule and is what makes a frame that arrives at the wrong end fail a range
 * test rather than misparse.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CASH BUNDLES RIDE THE WALLET MESSAGE
 *
 * A bundle is a thing in the world that everybody near it can see, and a
 * balance is a fact about one player. Those are two different scopes and the
 * tidy answer is two messages -- which is what `MSG.BIKES` and `MSG.WALLET`
 * would have been, if there had been a fourth id to spend.
 *
 * There was not: this workstream was allocated `0x8f` and `0x90` and the rest
 * of the range belongs to five branches landing in the same merge. So the
 * bundles ride here, and the cost of that is stated rather than hidden: **a
 * `WALLET` frame is per-client and is therefore never deduplicated** the way a
 * snapshot body is (see `server/room.ts`'s `FrameGroups`), so a bundle
 * appearing re-sends one small frame per player in the room.
 *
 * The numbers make that fine. A room drops a bundle on a knockout -- a few a
 * minute -- and each frame is `14 + 14n` bytes, so a hundred-player room with
 * ten bundles on the ground pays 15 kB on the tick one appears and nothing at
 * all in between. Against a snapshot stream measured in hundreds of kbit/s that
 * is not a line item. What it is *not* safe to do is put this on a timer: it is
 * sent on change, and `Room` compares an encoded-state key before it sends.
 */

import {
  MAX_BALANCE,
  MAX_BUNDLES,
  FARE_STATES,
  type CashBundle,
  type FareState,
} from '../game/cash.ts';
import { dequantisePos, quantisePos } from './protocol.ts';

const ENC = new TextEncoder();
const DEC = new TextDecoder();

// --- The phone, going up --------------------------------------------------------

/**
 * The client's half of this feature, in one message id with a sub-op byte.
 *
 * Three operations, and the split between them is *who owns the state*:
 *
 *   - `CLAIM` names an office and asks to be paid. The server checks where the
 *     player is standing and when they last claimed there, and answers with a
 *     `WALLET` (or with nothing, and a notice the client composed from the
 *     timer it already has).
 *   - `ONLINE` / `OFFLINE` toggle the rideshare job. Two ops rather than one op
 *     with a boolean, because a toggle sent as a toggle is a toggle that
 *     desynchronises the first time a frame is dropped -- the same reason
 *     `protocol.BTN.MOUNT` is a level bit the server edges rather than an edge
 *     the client sends. These are levels: sending `ONLINE` twice is idempotent.
 */
export const PHONE_OP = {
  CLAIM: 0,
  ONLINE: 1,
  OFFLINE: 2,
  /**
   * `TOPUP` names a row of `game/till.PACKS` by **index** and asks to be
   * credited. It is `CLAIM`'s shape exactly, and deliberately so: the client
   * names a thing in a table both ends compile in, and the server decides
   * whether it happens. What the client may not do is name an *amount* --
   * there is no dollar figure on this wire in either direction, because a
   * message that carried one would be a client telling the server how rich it
   * is, and no amount of validation downstream makes that a good sentence to
   * have in the protocol.
   *
   * The index rather than the id, on `TEAM_OP`'s argument: a byte against a
   * string, on a message a player can send by tapping a button. `PACKS` is
   * append-only for this reason and its header says so.
   */
  TOPUP: 3,
} as const;

/** An office id is `clNNN` today; the cap is generous and bounded. */
export const MAX_OFFICE_ID_BYTES = 24;

export interface PhoneRequest {
  op: number;
  /** `CLAIM` only. Empty for the others. */
  officeId: string;
  /** `TOPUP` only: an index into `game/till.PACKS`. 0 for the others. */
  packIndex: number;
}

/**
 * Client to server, `MSG.PHONE`:
 *
 *     u8   type = MSG.PHONE
 *     u8   op          PHONE_OP.*
 *     -- CLAIM: u8 office id length, then the id, ASCII
 *     -- TOPUP: u8 pack index
 *     -- ONLINE / OFFLINE: nothing more
 */
export function encodePhone(type: number, op: number, officeId = '', packIndex = 0): ArrayBuffer {
  const id = ENC.encode(officeId).subarray(0, MAX_OFFICE_ID_BYTES);
  const wantsId = op === PHONE_OP.CLAIM;
  const wantsPack = op === PHONE_OP.TOPUP;
  const buffer = new ArrayBuffer(2 + (wantsId ? 1 + id.length : 0) + (wantsPack ? 1 : 0));
  const v = new DataView(buffer);
  v.setUint8(0, type);
  v.setUint8(1, op);
  if (wantsId) {
    v.setUint8(2, id.length);
    new Uint8Array(buffer, 3).set(id);
  }
  // Clamped rather than trusted: an index is a byte and a byte is what fits.
  // The server resolves it against the table anyway and refuses what does not.
  if (wantsPack) v.setUint8(2, Math.max(0, Math.min(255, Math.trunc(packIndex))));
  return buffer;
}

/**
 * The server's decoder, bounded by what **arrived** rather than by what a
 * prefix claims, on `decodeSuggest`'s rule -- a length byte that overruns the
 * frame is the cheapest thing a hostile client can say, and a `TextDecoder`
 * throw here is inside the socket callback that serves every player on the
 * host. Returns null rather than throwing.
 */
export function decodePhone(buffer: ArrayBuffer, type: number): PhoneRequest | null {
  if (buffer.byteLength < 2) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== type) return null;
  const op = v.getUint8(1);
  if (op === PHONE_OP.ONLINE || op === PHONE_OP.OFFLINE) return { op, officeId: '', packIndex: 0 };
  if (op === PHONE_OP.TOPUP) {
    if (buffer.byteLength < 3) return null;
    return { op, officeId: '', packIndex: v.getUint8(2) };
  }
  if (op !== PHONE_OP.CLAIM) return null;
  if (buffer.byteLength < 3) return null;
  const n = Math.min(v.getUint8(2), MAX_OFFICE_ID_BYTES, buffer.byteLength - 3);
  return { op, officeId: n > 0 ? DEC.decode(new Uint8Array(buffer, 3, n)) : '', packIndex: 0 };
}

// --- The wallet, coming down ----------------------------------------------------

/** What one `WALLET` frame says. See the header for why the bundles are here. */
export interface WalletFrame {
  /** Whole dollars. */
  balance: number;
  /**
   * Milliseconds until the **nearest** office this player can claim at will pay
   * again, or 0 if one will pay now, or -1 for "no idea" (nowhere in range).
   *
   * A single number rather than the whole per-office table, and that is the one
   * interesting choice in this layout. The table is 31 rows of a timestamp and
   * would be 250 bytes on every wallet change; the *client already has the
   * office list* (`game/centrelink-data.ts` is compiled into both ends) and the
   * phone's Centrelink app only ever draws one countdown at a time -- the one
   * for the office you are looking at. So the server sends the answer to the
   * question the client is actually asking, and the client asks again by
   * walking somewhere else.
   */
  centrelinkNextMs: number;
  /**
   * Why the balance just moved -- "+$34 fare", "+$100 centrelink", "-$12
   * dropped" -- or empty, which is the ordinary case.
   *
   * **Composed by the server rather than derived on the client from the
   * delta**, on `SUGGEST_ACK`'s exact argument: the rules that move money live
   * on the server, and a client that turned "+34" into a sentence would be a
   * second table of reasons that goes stale the day a new one is added. It is
   * also the only way to say *why* at all -- a delta of +34 is a fare or a
   * bundle or a payment and the number cannot tell you which.
   *
   * Cleared by the server the moment it is sent, so it never repeats: this is a
   * moment, and the HUD pill it lands in is `hud.notice`'s.
   */
  note: string;
  /** Every live bundle in the room. Capped at `MAX_BUNDLES`. */
  bundles: CashBundle[];
}

/** 14 fixed bytes a bundle: id, x, z, y, amount. */
const BUNDLE_BYTES = 14;
/** Up to and including the note's length byte. The note and bundles follow. */
const WALLET_HEADER_BYTES = 11;
/** "+$1,234,567 centrelink" is 22. 48 is room for a sentence and a cap. */
export const MAX_NOTE_BYTES = 48;

/**
 * Server to client, `MSG.WALLET`:
 *
 *     u8   type
 *     i32  balance          whole dollars
 *     i32  centrelinkNextMs milliseconds, or -1 for "nothing in range"
 *     u8   bundle count
 *     u8   note length, then the note, UTF-8
 *     ...  count x record:
 *          u16  id
 *          i32  x            millimetres, `protocol.quantisePos`
 *          i32  z
 *          i16  y            decimetres, see below
 *          u16  amount       dollars, clamped
 *
 * **Who dropped it is not on the wire.** It is held on the server's own record
 * (`CashBundle.from`) so a future feed line could say "you took Bazza's $34",
 * and today nothing draws one -- the knockout that produced the bundle is
 * already a named line in the feed one second earlier, and a second attribution
 * on the pickup would be the same event reported twice. Two bytes a bundle, not
 * sent for a string nobody renders.
 *
 * The `y` is a `i16` of decimetres rather than a third `quantisePos`, and it is
 * the one field here that is not the obvious width. A bundle's height is the
 * *ground under it*, which both ends can already query to within a few
 * centimetres; what the wire has to carry is only enough to disambiguate a
 * bundle dropped on an overpass from one on the road beneath it. Decimetres
 * over a +/-3.2 km range does that with four bytes saved per bundle, and the
 * pickup gate it feeds is 2.5 m deep (`powerups.PICKUP_HEIGHT`) -- 25 times the
 * quantisation step.
 */
export function encodeWallet(type: number, w: WalletFrame): ArrayBuffer {
  const rows = w.bundles.slice(0, MAX_BUNDLES);
  // Clipped at a whole code point, on `suggestions.fitBytes`' argument: the
  // naive byte slice cuts a multi-byte sequence in half and the decoder turns
  // the remainder into a black diamond in the middle of the HUD pill.
  const note = fitNote(w.note ?? '');
  const buffer = new ArrayBuffer(WALLET_HEADER_BYTES + note.length + rows.length * BUNDLE_BYTES);
  const v = new DataView(buffer);
  v.setUint8(0, type);
  v.setInt32(1, clampBalance(w.balance), true);
  // -1 survives the clamp as -1, which is the sentinel; everything else is a
  // duration and cannot legitimately be negative.
  v.setInt32(5, w.centrelinkNextMs < 0 ? -1 : Math.min(0x7fffffff, Math.round(w.centrelinkNextMs)), true);
  v.setUint8(9, rows.length);
  v.setUint8(10, note.length);
  new Uint8Array(buffer, WALLET_HEADER_BYTES).set(note);
  let at = WALLET_HEADER_BYTES + note.length;
  for (const b of rows) {
    v.setUint16(at, b.id & 0xffff, true);
    v.setInt32(at + 2, quantisePos(b.x), true);
    v.setInt32(at + 6, quantisePos(b.z), true);
    v.setInt16(at + 10, clampDecimetres(b.y), true);
    v.setUint16(at + 12, Math.max(0, Math.min(65535, Math.round(b.amount))), true);
    at += BUNDLE_BYTES;
  }
  return buffer;
}

export function decodeWallet(buffer: ArrayBuffer, type: number): WalletFrame | null {
  if (buffer.byteLength < WALLET_HEADER_BYTES) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== type) return null;
  const count = v.getUint8(9);
  const noteLen = Math.min(v.getUint8(10), MAX_NOTE_BYTES, buffer.byteLength - WALLET_HEADER_BYTES);
  const out: WalletFrame = {
    balance: v.getInt32(1, true),
    centrelinkNextMs: v.getInt32(5, true),
    note: noteLen > 0 ? DEC.decode(new Uint8Array(buffer, WALLET_HEADER_BYTES, noteLen)) : '',
    bundles: [],
  };
  let at = WALLET_HEADER_BYTES + Math.max(0, noteLen);
  // Drops an incomplete tail rather than throwing, which is `decodeRoster`'s
  // rule and exists for the same reason: a throw here is inside the client's
  // message pump.
  for (let i = 0; i < count; i++) {
    if (at + BUNDLE_BYTES > buffer.byteLength) break;
    out.bundles.push({
      id: v.getUint16(at, true),
      x: dequantisePos(v.getInt32(at + 2, true)),
      z: dequantisePos(v.getInt32(at + 6, true)),
      y: v.getInt16(at + 10, true) / 10,
      amount: v.getUint16(at + 12, true),
      from: 0,
      ttl: 0,
    });
    at += BUNDLE_BYTES;
  }
  return out;
}

function clampBalance(n: number): number {
  return Math.max(-MAX_BALANCE, Math.min(MAX_BALANCE, Math.round(n)));
}

/** UTF-8, clipped to `MAX_NOTE_BYTES` at a code-point boundary. */
function fitNote(text: string): Uint8Array {
  let out = '';
  let used = 0;
  for (const ch of text) {
    const n = ENC.encode(ch).length;
    if (used + n > MAX_NOTE_BYTES) break;
    out += ch;
    used += n;
  }
  return ENC.encode(out);
}

function clampDecimetres(metres: number): number {
  if (!Number.isFinite(metres)) return 0;
  return Math.max(-32768, Math.min(32767, Math.round(metres * 10)));
}

// --- The fare, coming down ------------------------------------------------------

export interface FareFrame {
  state: FareState;
  /** The pickup, world metres. Meaningless while `state` is `none`. */
  px: number;
  pz: number;
  /** The dropoff. Meaningless before `toDropoff` is reachable. */
  dx: number;
  dz: number;
  /** `Date.now()` when this offer was made, for the client's own clock. */
  offeredMs: number;
  /** What the trip will pay if it is finished now, dollars. */
  payout: number;
}

const FARE_BYTES = 24;

/**
 * Server to client, `MSG.FARE`:
 *
 *     u8   type
 *     u8   state       index into `cash.FARE_STATES`
 *     i32  px, pz      pickup, millimetres
 *     i32  dx, dz      dropoff, millimetres
 *     f64  --          *not* present; see below
 *     u32  offeredMs   **milliseconds ago**, not an absolute instant
 *     u16  payout
 *
 * `offeredMs` crosses the wire as an **age** rather than as a wall-clock
 * instant, which is the opposite of what `WELCOME.clockMs` does and is right
 * for the opposite reason. `WELCOME` is establishing what time it is, once, and
 * has to be absolute to do that. This field is answering "how long have I been
 * looking at this offer", every client already has the server's clock offset
 * from that very `WELCOME`, and an age is four bytes where an instant is eight
 * -- on a message sent on every state change of every online driver.
 *
 * A fare is not sent to anybody but the driver it belongs to, so there is no
 * deduplication question here at all.
 */
export function encodeFare(type: number, f: FareFrame, nowMs: number): ArrayBuffer {
  const buffer = new ArrayBuffer(FARE_BYTES);
  const v = new DataView(buffer);
  v.setUint8(0, type);
  const index = FARE_STATES.indexOf(f.state);
  v.setUint8(1, index < 0 ? 0 : index);
  v.setInt32(2, quantisePos(f.px), true);
  v.setInt32(6, quantisePos(f.pz), true);
  v.setInt32(10, quantisePos(f.dx), true);
  v.setInt32(14, quantisePos(f.dz), true);
  const age = f.offeredMs > 0 ? Math.max(0, nowMs - f.offeredMs) : 0;
  v.setUint32(18, Math.min(0xffffffff, Math.round(age)), true);
  v.setUint16(22, Math.max(0, Math.min(65535, Math.round(f.payout))), true);
  return buffer;
}

/**
 * `nowMs` is the **receiving** end's clock, so the age is turned back into an
 * instant on the reader's own timeline. That is the only way a countdown drawn
 * on the client can be right without the two clocks agreeing.
 */
export function decodeFare(buffer: ArrayBuffer, type: number, nowMs: number): FareFrame | null {
  if (buffer.byteLength < FARE_BYTES) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== type) return null;
  const age = v.getUint32(18, true);
  return {
    state: FARE_STATES[Math.min(v.getUint8(1), FARE_STATES.length - 1)],
    px: dequantisePos(v.getInt32(2, true)),
    pz: dequantisePos(v.getInt32(6, true)),
    dx: dequantisePos(v.getInt32(10, true)),
    dz: dequantisePos(v.getInt32(14, true)),
    offeredMs: nowMs - age,
    payout: v.getUint16(22, true),
  };
}

// --- The self-check -------------------------------------------------------------

/**
 * The three codecs, round-tripped, and every truncation of each.
 *
 * Run at boot on both ends beside `verifyNet` and `verifySuggestions`, because
 * a codec failure here is silent in this repo's sense: the phone opens, the
 * claim is sent, and the office id it names is one byte short of the one the
 * player is standing at -- so the claim is refused with no message that says
 * why. A length prefix written before the field it precedes desynchronises
 * every bundle after it, which draws piles of money in the harbour.
 *
 *     bun -e "import {verifyCashWire} from './client/src/net/cash.ts';
 *             console.log(verifyCashWire())"
 */
export function verifyCashWire(): string[] {
  const failures: string[] = [];
  const PHONE = 0x0e;
  const WALLET = 0x8f;
  const FARE = 0x90;

  // --- The phone request, all three ops.
  {
    const claim = decodePhone(encodePhone(PHONE, PHONE_OP.CLAIM, 'cl017'), PHONE);
    if (!claim || claim.op !== PHONE_OP.CLAIM || claim.officeId !== 'cl017') {
      failures.push(`A CLAIM round-tripped to ${JSON.stringify(claim)}.`);
    }
    for (const index of [0, 5, 255]) {
      const top = decodePhone(encodePhone(PHONE, PHONE_OP.TOPUP, '', index), PHONE);
      if (!top || top.op !== PHONE_OP.TOPUP || top.packIndex !== index) {
        failures.push(`a top-up for pack ${index} did not survive the wire.`);
      }
    }
    // A `TOPUP` with the index byte missing is a short frame, not a purchase
    // of pack 0. The server would otherwise credit somebody for a truncation.
    if (decodePhone(new Uint8Array([PHONE, PHONE_OP.TOPUP]).buffer, PHONE) !== null) {
      failures.push('a top-up with no pack byte decoded; a short frame must not buy anything.');
    }
    for (const op of [PHONE_OP.ONLINE, PHONE_OP.OFFLINE]) {
      const got = decodePhone(encodePhone(PHONE, op), PHONE);
      if (!got || got.op !== op || got.officeId !== '') failures.push(`Phone op ${op} round-tripped to ${JSON.stringify(got)}.`);
    }
    // An unknown op is refused rather than treated as a claim for office "".
    const bogus = new Uint8Array([PHONE, 99]);
    if (decodePhone(bogus.buffer, PHONE) !== null) failures.push('An unknown phone op was decoded anyway.');
    // A frame of the wrong type is refused by the type test.
    if (decodePhone(encodePhone(PHONE, PHONE_OP.ONLINE), 0x0f) !== null) {
      failures.push('A mistyped phone frame was decoded anyway.');
    }
    // An over-long id is clipped rather than overflowing the length byte.
    const long = decodePhone(encodePhone(PHONE, PHONE_OP.CLAIM, 'x'.repeat(400)), PHONE);
    if (!long || long.officeId.length > MAX_OFFICE_ID_BYTES) {
      failures.push(`A 400-byte office id came back ${long?.officeId.length} bytes long.`);
    }
    // Truncation returns null rather than throwing, at every prefix.
    const frame = encodePhone(PHONE, PHONE_OP.CLAIM, 'cl017');
    let threw = false;
    try {
      for (let n = 0; n < frame.byteLength; n++) decodePhone(frame.slice(0, n), PHONE);
    } catch {
      threw = true;
    }
    if (threw) failures.push('A truncated phone frame threw rather than returning null.');
  }

  // --- The wallet, with the bundle list that is the part that can
  // desynchronise.
  {
    const bundles: CashBundle[] = [
      { id: 1, x: -925.2, y: 12.4, z: 2645.2, amount: 34, from: 7, ttl: 30 },
      { id: 65535, x: 0, y: -3.1, z: 0, amount: 0, from: 0, ttl: 1 },
      { id: 900, x: -47172.8, y: 41.9, z: 21744.8, amount: 65535, from: 3, ttl: 29 },
    ];
    const w = { balance: 1234, centrelinkNextMs: 25_200_000, note: '+$34 fare', bundles };
    const got = decodeWallet(encodeWallet(WALLET, w), WALLET);
    if (!got) {
      failures.push('A wallet frame did not decode at all.');
    } else {
      if (got.balance !== 1234) failures.push(`A balance of 1234 came back as ${got.balance}.`);
      if (got.note !== '+$34 fare') failures.push(`The note came back as ${JSON.stringify(got.note)}.`);
      if (got.centrelinkNextMs !== 25_200_000) failures.push(`The claim countdown came back as ${got.centrelinkNextMs}.`);
      if (got.bundles.length !== bundles.length) {
        failures.push(`${bundles.length} bundles came back as ${got.bundles.length}.`);
      }
      for (let i = 0; i < Math.min(got.bundles.length, bundles.length); i++) {
        const a = bundles[i];
        const b = got.bundles[i];
        if (b.id !== a.id || b.amount !== a.amount) {
          failures.push(`Bundle ${a.id}/$${a.amount} came back as ${b.id}/$${b.amount}.`);
        }
        // A millimetre either way on the plan, a decimetre on the height.
        if (Math.abs(b.x - a.x) > 0.002 || Math.abs(b.z - a.z) > 0.002) {
          failures.push(`Bundle ${a.id} moved from (${a.x}, ${a.z}) to (${b.x}, ${b.z}).`);
        }
        if (Math.abs(b.y - a.y) > 0.06) failures.push(`Bundle ${a.id}'s height went from ${a.y} to ${b.y}.`);
      }
    }
    // An empty wallet is a legal frame and is the common one.
    const empty = decodeWallet(
      encodeWallet(WALLET, { balance: 0, centrelinkNextMs: -1, note: '', bundles: [] }),
      WALLET,
    );
    if (!empty || empty.bundles.length !== 0 || empty.centrelinkNextMs !== -1 || empty.note !== '') {
      failures.push(`An empty wallet round-tripped to ${JSON.stringify(empty)}.`);
    }
    // A note of emoji is clipped at a code point rather than mid-sequence --
    // the same failure `suggestions.fitBytes` exists for, in the HUD pill.
    const wide = decodeWallet(
      encodeWallet(WALLET, { balance: 1, centrelinkNextMs: 0, note: '🦘'.repeat(60), bundles: [] }),
      WALLET,
    );
    if (!wide || wide.note.includes('�')) failures.push('A note of emoji was clipped inside a surrogate pair.');
    // A negative balance cannot be produced by the rules and must survive the
    // wire anyway, or a bug becomes a two-billion-dollar bug.
    const debt = decodeWallet(
      encodeWallet(WALLET, { balance: -40, centrelinkNextMs: 0, note: '', bundles: [] }),
      WALLET,
    );
    if (!debt || debt.balance !== -40) failures.push(`A negative balance came back as ${debt?.balance}.`);
    // Over the cap the list is clipped rather than overflowing the count byte.
    const many: CashBundle[] = [];
    for (let i = 0; i < MAX_BUNDLES + 40; i++) many.push({ id: i, x: i, y: 0, z: 0, amount: 5, from: 0, ttl: 30 });
    const clipped = decodeWallet(
      encodeWallet(WALLET, { balance: 0, centrelinkNextMs: 0, note: '', bundles: many }),
      WALLET,
    );
    if (!clipped || clipped.bundles.length !== MAX_BUNDLES) {
      failures.push(`${many.length} bundles encoded to ${clipped?.bundles.length}, not the ${MAX_BUNDLES} cap.`);
    }
    // Truncation drops the tail rather than throwing, at every prefix.
    const frame = encodeWallet(WALLET, w);
    let threw = false;
    try {
      for (let n = 0; n < frame.byteLength; n++) decodeWallet(frame.slice(0, n), WALLET);
    } catch {
      threw = true;
    }
    if (threw) failures.push('A truncated wallet frame threw rather than dropping its tail.');
  }

  // --- The fare, including the age arithmetic, which is the field with an
  // opinion about time and is therefore the one that can be wrong.
  {
    const sent = 1_800_000_000_000;
    const f: FareFrame = {
      state: 'toDropoff',
      px: -925.2, pz: 2645.2,
      dx: -4910.6, dz: 4812.6,
      offeredMs: sent - 42_000,
      payout: 27,
    };
    // Encoded on a server whose clock is `sent`, decoded on a client whose
    // clock is nine hours out -- which is the case the age exists for.
    const skewed = sent + 9 * 3_600_000;
    const got = decodeFare(encodeFare(FARE, f, sent), FARE, skewed);
    if (!got) {
      failures.push('A fare frame did not decode at all.');
    } else {
      if (got.state !== 'toDropoff') failures.push(`The fare state came back as ${got.state}.`);
      if (got.payout !== 27) failures.push(`A $27 fare came back as $${got.payout}.`);
      if (Math.abs(got.px - f.px) > 0.002 || Math.abs(got.dz - f.dz) > 0.002) {
        failures.push('A fare\'s pickup or dropoff moved on the wire.');
      }
      // 42 s ago, on the **reader's** clock, not the writer's.
      if (Math.abs(skewed - got.offeredMs - 42_000) > 1) {
        failures.push(`The offer read as ${((skewed - got.offeredMs) / 1000).toFixed(1)} s old, not 42.0.`);
      }
    }
    // Every state survives the byte.
    for (const state of FARE_STATES) {
      const back = decodeFare(encodeFare(FARE, { ...f, state }, sent), FARE, sent);
      if (back?.state !== state) failures.push(`Fare state ${state} came back as ${back?.state}.`);
    }
    // A state byte from the future clamps to a known state rather than
    // producing `undefined`, which would be a crash in a template string.
    const bad = new Uint8Array(encodeFare(FARE, f, sent));
    bad[1] = 200;
    if (!FARE_STATES.includes(decodeFare(bad.buffer, FARE, sent)?.state as FareState)) {
      failures.push('An out-of-range fare state decoded to something that is not a state.');
    }
    let threw = false;
    try {
      const frame = encodeFare(FARE, f, sent);
      for (let n = 0; n < frame.byteLength; n++) decodeFare(frame.slice(0, n), FARE, sent);
    } catch {
      threw = true;
    }
    if (threw) failures.push('A truncated fare frame threw rather than returning null.');
  }

  return failures;
}
