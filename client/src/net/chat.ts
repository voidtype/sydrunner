/**
 * In-game chat: the two frames, the sanitiser, and the gate that decides whether
 * a line is allowed to exist.
 *
 * A module of its own rather than three more sections of `net/protocol.ts`, and
 * the reason is the same one that file gives for having a `NetTransport` seam:
 * everything here is a *string* problem, and `protocol.ts` is a quantisation
 * file. What lives there is the pair of message ids -- `MSG.CHAT_SAY` and
 * `MSG.CHAT_LINE` -- because the id space is one space and a second file with
 * its own opinion about which byte is free is the one way two features collide.
 * Everything downstream of those two bytes is here.
 *
 * Imported by `client/src/net/client.ts`, by `client/src/chat.ts` and by
 * `server/chat.ts` from the same path, on `protocol.ts`'s founding argument: an
 * encoder and a decoder that are two files are two files that disagree, and a
 * sanitiser that is two functions is a message that says one thing in the box
 * you typed it into and another over everybody else's screen.
 *
 * ---------------------------------------------------------------------------
 * ## GLOBAL MEANS GLOBAL: chat crosses rooms, and it is the only thing that does
 *
 * Every other channel in this protocol is a room's. The roster is room-global
 * and is careful to say so; the snapshot is narrower still, filtered to the
 * forty players you can see. Chat is **host-global**: a line typed in room 0
 * reaches every socket on the process, in every room.
 *
 * That is a deliberate inversion of the architecture and it is affordable for
 * one reason -- the volume. A room's snapshot stream is 20 frames a second per
 * client forever; chat is a few hundred bytes when somebody types a sentence,
 * rate-limited below one message per 1.5 s per player. At the 1,000-player
 * deployment PERFORMANCE.md measures, a chatty ten players is 10 x 1,000 sends
 * of ~60 B every 1.5 s -- 3.2 kbit/s per client, or about a tenth of what one
 * client's snapshots cost. See `server/chat.ts` for the fan-out and for the one
 * limitation this does *not* cross.
 *
 * ---------------------------------------------------------------------------
 * ## THE CAPS ARE TWO CAPS, exactly as a name's are
 *
 * `MAX_CHAT_CHARS` is what a person may type and is measured in **code points**,
 * so a message is clipped where a reader would say it ends. `MAX_CHAT_BYTES` is
 * what the wire will carry, and it is the one that has to be enforced in bytes:
 * the length prefix is a `u8`, and 120 astral-plane code points is 480 bytes,
 * which a byte cannot describe. A cap applied only in characters would encode a
 * length that wrapped and hand the decoder a frame that ends mid-sequence --
 * which is a chat line rendered as replacement characters at best and a
 * `TextDecoder` throw inside a socket callback at worst, and a throw there takes
 * the whole client's message pump with it.
 *
 * `MAX_CHAT_BYTES` is 240 rather than 255 so the number is 2 x `MAX_CHAT_CHARS`
 * and obviously under the prefix's range rather than merely at it.
 */

import { MSG } from './protocol.ts';

// --- The caps -----------------------------------------------------------------

/** What a person may type, in code points. */
export const MAX_CHAT_CHARS = 120;
/**
 * What the wire will carry, in bytes, and the cap that is actually load-bearing.
 *
 * 240 = 2 x `MAX_CHAT_CHARS`, which covers the whole of Latin, Greek and
 * Cyrillic at the character cap and clips a message of CJK or emoji earlier --
 * at 80 and 60 code points respectively. That is the honest trade for a `u8`
 * prefix and it is the same one `protocol.MAX_NAME_BYTES` makes.
 */
export const MAX_CHAT_BYTES = 240;

const ENC = new TextEncoder();
const DEC = new TextDecoder();

// --- Sanitisation -------------------------------------------------------------

/**
 * The invisible ones, dropped rather than replaced. `protocol.invisible`'s list,
 * restated here because that one is not exported and duplicating six ranges is
 * cheaper than widening another module's surface for a private predicate.
 *
 * The bidirectional overrides are the reason this exists at all and they matter
 * *more* in a chat line than in a name: an unterminated U+202E reverses every
 * character after it in the element it lands in, and a chat log is a column of
 * lines in one element. One message could turn the whole scrollback backwards.
 */
function invisible(code: number): boolean {
  return (
    (code >= 0x200b && code <= 0x200f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/** Clip to whole code points at both caps, then re-trim. `protocol.clipName`'s shape. */
function clipChat(chars: readonly string[]): string {
  const out = chars.slice(0, MAX_CHAT_CHARS);
  // Pop whole code points, never bytes. Truncating the byte array directly is
  // what puts half a character on the end of a message.
  while (out.length > 0 && ENC.encode(out.join('')).length > MAX_CHAT_BYTES) out.pop();
  return out.join('').trim();
}

/**
 * What somebody typed, reduced to one line that can be drawn in a log without
 * lying about its own height or its own direction.
 *
 * Returns the **empty string** for anything that does not survive -- all
 * whitespace, all control characters, all zero-width spaces -- and the caller
 * drops those rather than sending them. There is no minimum length: "k" is a
 * sentence in a brawler, where a two-character floor makes sense for a name
 * because a name is a leaderboard row.
 *
 * Idempotent by construction, which `verifyChat` asserts over the awkward cases.
 * The client runs this so the box shows what will be sent; the server runs it
 * again on arrival and does not trust the first run, which is the only rule
 * about a client-supplied string worth stating twice.
 */
export function sanitiseChat(raw: string): string {
  let cleaned = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    // C0, DEL and C1 become spaces rather than vanishing, so a pasted newline is
    // a word break and not a join: "oi\nmate" is "oi mate", never "oimate".
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      cleaned += ' ';
      continue;
    }
    if (invisible(code)) continue;
    cleaned += ch;
  }
  // Every kind of space collapsed to one, which is what stops a message being
  // drawn three lines tall by somebody who found the ideographic space.
  cleaned = cleaned.replace(/\s+/gu, ' ').trim();
  if (cleaned.length === 0) return '';
  return clipChat([...cleaned]);
}

// --- The abuse floor ----------------------------------------------------------

/**
 * One message per this long, sustained.
 *
 * 1.5 s is slow enough that nobody can scroll the log off the screen and fast
 * enough that a two-line exchange is not a conversation with a metronome. It is
 * a *sustained* rate rather than a hard interval, because the burst below is
 * what makes typing feel unmetered.
 */
export const CHAT_INTERVAL_MS = 1500;
/**
 * How many messages may be sent back to back before the interval starts biting.
 *
 * A token bucket rather than a fixed window, and the burst is why: a real person
 * types three short lines in a row ("oi", "behind you", "run") and then says
 * nothing for a minute. A fixed 1.5 s window refuses the second and third of
 * those, which is a chat that punishes exactly the moment it is most useful. A
 * flooder is bounded by the *refill* rate regardless, which is the number that
 * actually decides how much text can reach a screen.
 */
export const CHAT_BURST = 3;
/**
 * The same text this many times consecutively is where the repeat stops.
 *
 * Two identical lines in a row is somebody who thinks the first did not send.
 * Three is somebody holding a key, and the third and every one after it is
 * dropped. Compared **after** sanitisation and case-insensitively, because
 * "OI", "oi" and "oi   " are one message to whoever has to read them.
 */
export const CHAT_REPEAT_LIMIT = 3;
/**
 * How often the sender may be *told* they are being throttled.
 *
 * Without this the notice is the flood: a client hammering the socket would be
 * answered with one private line per attempt, which is the server generating
 * more chat than the flooder. One explanation per three seconds is enough for a
 * person and nothing at all for a script.
 */
export const CHAT_NOTICE_MS = 3000;

/** Why a message was refused, or the empty string if it was not. */
export type ChatRefusal = '' | 'rate' | 'repeat';

/**
 * One sender's chat budget. Held per socket on the server; see `server/chat.ts`.
 *
 * A plain record with a pure transition function rather than a class with a
 * clock in it, so `verifyChat` and `server/integration-check.ts` can drive the
 * window's arithmetic at whatever times they like without waiting for real
 * seconds to pass. Every rate limiter that could only be tested by sleeping is a
 * rate limiter that is tested once.
 */
export interface ChatGate {
  /** Fractional tokens, 0..`CHAT_BURST`. */
  tokens: number;
  /** When `tokens` was last brought up to date. */
  refilledAt: number;
  /** The last accepted text, folded for comparison. */
  lastText: string;
  /** How many times in a row that text has been accepted. */
  repeats: number;
  /** When this sender was last told they were being throttled. */
  noticedAt: number;
}

export function newChatGate(now: number): ChatGate {
  return { tokens: CHAT_BURST, refilledAt: now, lastText: '', repeats: 0, noticedAt: -Infinity };
}

/**
 * May this sender say this, now? Mutates the gate iff the answer is yes.
 *
 * The order is deliberate: the **repeat** check runs before the token is spent,
 * so somebody hammering one word is refused without also being rate-limited into
 * silence for the next four seconds. A refusal costs nothing, which is the
 * property that keeps a flooder's own budget intact for the moment they type
 * something else.
 *
 * `text` must already be `sanitiseChat`'d and non-empty; an empty message is the
 * caller's to drop and is not a refusal worth telling anybody about.
 */
export function chatAdmit(gate: ChatGate, text: string, now: number): ChatRefusal {
  // Refill first, so a gate that has been idle for a minute is full rather than
  // however full it was when it was last touched.
  const elapsed = Math.max(0, now - gate.refilledAt);
  gate.tokens = Math.min(CHAT_BURST, gate.tokens + elapsed / CHAT_INTERVAL_MS);
  gate.refilledAt = now;

  const folded = text.toLowerCase();
  if (folded === gate.lastText && gate.repeats >= CHAT_REPEAT_LIMIT - 1) return 'repeat';
  if (gate.tokens < 1) return 'rate';

  gate.tokens -= 1;
  if (folded === gate.lastText) gate.repeats++;
  else {
    gate.lastText = folded;
    gate.repeats = 1;
  }
  return '';
}

/**
 * Should the sender be told about this refusal, or has one just been sent?
 *
 * Mutates the gate iff the answer is yes, so a caller that asks is a caller that
 * has committed to sending. See `CHAT_NOTICE_MS`.
 */
export function chatShouldNotify(gate: ChatGate, now: number): boolean {
  if (now - gate.noticedAt < CHAT_NOTICE_MS) return false;
  gate.noticedAt = now;
  return true;
}

// --- Client -> server: CHAT_SAY -----------------------------------------------

/** type + length. The text follows. */
export const CHAT_SAY_HEADER_BYTES = 2;

/**
 * Say something. 2 bytes and a message:
 *
 *     u8   type = MSG.CHAT_SAY
 *     u8   text length **in bytes**
 *     ...  the text, UTF-8, at most `MAX_CHAT_BYTES`
 *
 * No sender field, no room field and no sequence number, and each omission is
 * the same decision made three times: **the server already knows.** A client
 * that named itself is a client that could name somebody else, which is the one
 * thing a chat protocol must make unrepresentable rather than merely refuse --
 * see `encodeChatLine`, whose sender and name are read off the room's roster and
 * never off this frame.
 */
export function encodeChatSay(text: string): ArrayBuffer {
  const bytes = ENC.encode(text);
  const n = Math.min(bytes.length, MAX_CHAT_BYTES);
  const buffer = new ArrayBuffer(CHAT_SAY_HEADER_BYTES + n);
  const v = new DataView(buffer);
  v.setUint8(0, MSG.CHAT_SAY);
  v.setUint8(1, n);
  new Uint8Array(buffer, CHAT_SAY_HEADER_BYTES).set(bytes.subarray(0, n));
  return buffer;
}

/**
 * Returns the raw text, **unsanitised**, or null for anything that is not a
 * well-formed CHAT_SAY.
 *
 * Unsanitised on purpose: sanitising inside the decoder would make it impossible
 * for the server to tell "they sent nothing" from "they sent something that
 * survived to nothing", and the two want different answers -- the first is a bug
 * or a probe and the second is somebody who typed three spaces. `server/chat.ts`
 * runs `sanitiseChat` immediately and drops the empty result.
 *
 * The length is bounded by **what actually arrived** rather than by what the
 * prefix claims, which is the one thing a hostile frame can cheaply lie about:
 * a `TextDecoder` on an out-of-range view throws, and a throw in the server's
 * message handler is a socket that dies mid-session.
 */
export function decodeChatSay(buffer: ArrayBuffer): string | null {
  if (buffer.byteLength < CHAT_SAY_HEADER_BYTES) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== MSG.CHAT_SAY) return null;
  const n = Math.min(v.getUint8(1), MAX_CHAT_BYTES, buffer.byteLength - CHAT_SAY_HEADER_BYTES);
  if (n <= 0) return '';
  return DEC.decode(new Uint8Array(buffer, CHAT_SAY_HEADER_BYTES, n));
}

// --- Server -> client: CHAT_LINE ----------------------------------------------

/** `ChatLine.flags`. */
export const CHAT_FLAG = {
  /** Sent to one socket only. A throttle notice, or the offline explanation. */
  PRIVATE: 1 << 0,
  /** From the server rather than from a player. `sender` is 0 and `name` is empty. */
  SYSTEM: 1 << 1,
} as const;

/** `ChatLine.room` when the line did not come out of a room. */
export const CHAT_ROOM_NONE = 0xffff;

export interface ChatLine {
  /** The server's id for the speaker, or 0 for a system line. */
  sender: number;
  /** Which room the speaker is standing in, or `CHAT_ROOM_NONE`. */
  room: number;
  /** `CHAT_FLAG.*` */
  flags: number;
  /** The speaker's name **as the server has it**, never as the client claimed it. */
  name: string;
  text: string;
}

/**
 * One line of chat, 8 bytes and two strings:
 *
 *     u8   type = MSG.CHAT_LINE
 *     u16  sender id            0 for a system line
 *     u16  room                 the sender's room; 0xffff for a system line
 *     u8   flags                CHAT_FLAG.*
 *     u8   name length in bytes
 *     u8   text length in bytes
 *     ...  the name, UTF-8
 *     ...  the text, UTF-8
 *
 * **The name is a snapshot rather than a reference**, and that is the one
 * decision in this record. The obvious encoding is the sender id alone, on the
 * kill feed's own argument -- `net/client.nameOf` already turns an id into a
 * name, and 25 bytes a line is not free. It is wrong here for a reason specific
 * to chat being host-global: the roster a client holds is **its own room's**, so
 * a line from room 3 would arrive with an id that room 0's client has never
 * heard of and would render as "player 41 says". Sending the name is what makes
 * "global" mean anything at all.
 *
 * **The room is on the wire** at two bytes because it is the cheapest possible
 * answer to "why is a stranger talking to me": the client marks a line whose
 * room differs from its own and leaves its own room's lines unmarked. See
 * `client/src/chat.ts`.
 *
 * Both lengths sit **ahead of both strings** rather than each ahead of its own,
 * so the header is a fixed 8 bytes and a truncated frame is detected before
 * either decode rather than between them.
 */
export const CHAT_LINE_HEADER_BYTES = 8;

export function chatLineBytes(line: ChatLine): number {
  return (
    CHAT_LINE_HEADER_BYTES +
    Math.min(ENC.encode(line.name).length, 255) +
    Math.min(ENC.encode(line.text).length, MAX_CHAT_BYTES)
  );
}

export function encodeChatLine(line: ChatLine): ArrayBuffer {
  const name = ENC.encode(line.name).subarray(0, 255);
  const text = ENC.encode(line.text).subarray(0, MAX_CHAT_BYTES);
  const buffer = new ArrayBuffer(CHAT_LINE_HEADER_BYTES + name.length + text.length);
  const v = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  v.setUint8(0, MSG.CHAT_LINE);
  v.setUint16(1, line.sender & 0xffff, true);
  v.setUint16(3, line.room & 0xffff, true);
  v.setUint8(5, line.flags & 0xff);
  v.setUint8(6, name.length);
  v.setUint8(7, text.length);
  bytes.set(name, CHAT_LINE_HEADER_BYTES);
  bytes.set(text, CHAT_LINE_HEADER_BYTES + name.length);
  return buffer;
}

export function decodeChatLine(buffer: ArrayBuffer): ChatLine | null {
  if (buffer.byteLength < CHAT_LINE_HEADER_BYTES) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== MSG.CHAT_LINE) return null;
  const nameLen = v.getUint8(6);
  const textLen = v.getUint8(7);
  // Refused rather than truncated. `decodeRoster` breaks out of its loop on a
  // short tail because it has already decoded entries worth keeping; this frame
  // is one record, and half of one is not a chat line -- it is a sentence with
  // the end cut off, attributed to somebody.
  if (CHAT_LINE_HEADER_BYTES + nameLen + textLen > buffer.byteLength) return null;
  return {
    sender: v.getUint16(1, true),
    room: v.getUint16(3, true),
    flags: v.getUint8(5),
    name: nameLen > 0 ? DEC.decode(new Uint8Array(buffer, CHAT_LINE_HEADER_BYTES, nameLen)) : '',
    text: textLen > 0 ? DEC.decode(new Uint8Array(buffer, CHAT_LINE_HEADER_BYTES + nameLen, textLen)) : '',
  };
}

// --- The self-check -----------------------------------------------------------

/**
 * Everything above, asserted. Run by `main.ts` before it builds a renderer and
 * by `server/index.ts` before it opens a socket.
 *
 * Every failure this catches is silent in this repo's sense -- the game runs and
 * the chat box works, and something else is wrong:
 *
 *   - A **byte cap applied in characters** encodes a length that a `u8` cannot
 *     hold, so a long message arrives with its prefix wrapped and its tail read
 *     as the next field. The symptom is one player whose messages are garbage.
 *   - A **sanitiser that is not idempotent** shows one sentence in the box and
 *     posts another, because the server runs it a second time.
 *   - A **truncation at a byte boundary** puts half a code point on the end of
 *     a message. `TextDecoder` renders it as U+FFFD rather than throwing, which
 *     is the worst of both: it looks like the sender's keyboard.
 *   - A **rate limit whose window is wrong by a factor** either lets a flood
 *     through or throttles a conversation, and neither has a frame that says so.
 *   - A **header width that disagrees between the two ends** shifts the name
 *     into the text, so every line reads as its own author.
 *
 * Run standalone:
 *
 *     bun -e "import {verifyChat} from './client/src/net/chat.ts';
 *             console.log(verifyChat())"
 */
export function verifyChat(): string[] {
  const failures: string[] = [];

  // --- 1. The ids are in the halves `protocol.MSG` says they are in, and do not
  // collide with anything already there. A client message at or over 0x80 is a
  // frame the *client's* dispatch would try to parse; the range test in that
  // switch is the whole reason the two halves exist.
  if (MSG.CHAT_SAY >= 0x80) failures.push(`CHAT_SAY is 0x${MSG.CHAT_SAY.toString(16)}; client messages are under 0x80.`);
  if (MSG.CHAT_LINE < 0x80) failures.push(`CHAT_LINE is 0x${MSG.CHAT_LINE.toString(16)}; server messages are at or over 0x80.`);
  {
    const ids = Object.entries(MSG);
    const seen = new Map<number, string>();
    for (const [name, id] of ids) {
      const prior = seen.get(id);
      if (prior !== undefined) failures.push(`MSG.${name} and MSG.${prior} are both 0x${id.toString(16)}.`);
      seen.set(id, name);
    }
  }

  // --- 2. Sanitisation, including the second pass the server makes.
  const cases: Array<[string, string]> = [
    ['oi mate', 'oi mate'],
    ['  padded  ', 'padded'],
    ['oi\nmate', 'oi mate'],
    ['oi\t\tmate', 'oi mate'],
    ['a b', 'a b'],
    ['​​​', ''],
    ['   ', ''],
    ['', ''],
    // The bidi override, which is the one that would turn a whole scrollback
    // backwards if it survived.
    ['run‮away', 'runaway'],
    // The ideographic space and the non-breaking one, both collapsed.
    ['a　 b', 'a b'],
  ];
  for (const [raw, want] of cases) {
    const got = sanitiseChat(raw);
    if (got !== want) failures.push(`sanitiseChat(${JSON.stringify(raw)}) gave ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}.`);
    // Idempotence. The server runs this over a string the client already ran it
    // over, and a second pass that differs is a message that changes on the wire.
    const twice = sanitiseChat(got);
    if (twice !== got) failures.push(`sanitiseChat is not idempotent on ${JSON.stringify(raw)}: ${JSON.stringify(got)} -> ${JSON.stringify(twice)}.`);
  }

  // --- 3. The byte cap, on multi-byte input, which is where a character-only
  // cap fails and an ASCII test never notices.
  {
    // 200 ASCII characters: over the character cap, under the byte cap.
    const ascii = sanitiseChat('a'.repeat(200));
    if ([...ascii].length !== MAX_CHAT_CHARS) {
      failures.push(`200 ASCII characters clipped to ${[...ascii].length}, wanted ${MAX_CHAT_CHARS}.`);
    }

    // 200 three-byte characters: 600 bytes, so the *byte* cap is what has to
    // bite -- at 80 characters, not at 120.
    const cjk = sanitiseChat('水'.repeat(200));
    const cjkBytes = ENC.encode(cjk).length;
    if (cjkBytes > MAX_CHAT_BYTES) failures.push(`200 CJK characters encoded to ${cjkBytes} bytes, over the ${MAX_CHAT_BYTES} cap.`);
    if ([...cjk].length !== Math.floor(MAX_CHAT_BYTES / 3)) {
      failures.push(`200 CJK characters clipped to ${[...cjk].length} code points; 3 bytes each should give ${Math.floor(MAX_CHAT_BYTES / 3)}.`);
    }

    // 200 astral code points: 4 bytes each, and the one case where clipping to
    // bytes rather than to code points would leave half a surrogate pair.
    const astral = sanitiseChat('\u{1f9e8}'.repeat(200));
    const astralBytes = ENC.encode(astral).length;
    if (astralBytes > MAX_CHAT_BYTES) failures.push(`200 astral code points encoded to ${astralBytes} bytes, over the ${MAX_CHAT_BYTES} cap.`);
    if (astral.includes('�')) failures.push('an astral message was clipped mid-sequence: a replacement character survived sanitisation.');
    // Every code point that survived is whole: re-encoding and re-decoding is a
    // fixed point iff nothing was cut in half.
    if (DEC.decode(ENC.encode(astral)) !== astral) failures.push('an astral message did not survive a UTF-8 round trip whole.');
    if ([...astral].length !== Math.floor(MAX_CHAT_BYTES / 4)) {
      failures.push(`200 astral code points clipped to ${[...astral].length}; 4 bytes each should give ${Math.floor(MAX_CHAT_BYTES / 4)}.`);
    }
  }

  // --- 4. CHAT_SAY round-trips, including the two hostile shapes.
  {
    for (const text of ['oi', 'a'.repeat(MAX_CHAT_CHARS), '水水 mate', '']) {
      const back = decodeChatSay(encodeChatSay(text));
      if (back !== text) failures.push(`CHAT_SAY round-tripped ${JSON.stringify(text)} to ${JSON.stringify(back)}.`);
    }
    // A length prefix that overruns the frame. The decoder must clamp to what
    // arrived rather than construct a view past the end, which throws.
    const lying = new ArrayBuffer(6);
    const lv = new DataView(lying);
    lv.setUint8(0, MSG.CHAT_SAY);
    lv.setUint8(1, 200);
    new Uint8Array(lying, 2).set(ENC.encode('oi m'));
    let overran: string | null = null;
    try {
      overran = decodeChatSay(lying);
    } catch (err) {
      failures.push(`a CHAT_SAY whose length prefix overran its frame threw: ${String(err)}.`);
    }
    if (overran !== 'oi m') failures.push(`an over-long length prefix decoded to ${JSON.stringify(overran)}, wanted "oi m".`);
    // And a frame of the wrong type, which is what a stray server message read
    // by the server's own dispatch would be.
    if (decodeChatSay(new ArrayBuffer(0)) !== null) failures.push('an empty frame decoded as a CHAT_SAY.');
    const wrongType = new ArrayBuffer(2);
    new DataView(wrongType).setUint8(0, MSG.SNAPSHOT);
    if (decodeChatSay(wrongType) !== null) failures.push('a SNAPSHOT decoded as a CHAT_SAY.');
  }

  // --- 5. CHAT_LINE round-trips, with the widths asserted rather than assumed.
  {
    const line: ChatLine = {
      sender: 41000,
      room: 7,
      flags: CHAT_FLAG.PRIVATE,
      name: 'Bazza 水',
      text: 'get off the 水 bike',
    };
    const frame = encodeChatLine(line);
    if (frame.byteLength !== chatLineBytes(line)) {
      failures.push(`chatLineBytes said ${chatLineBytes(line)} and the encoder produced ${frame.byteLength}.`);
    }
    const back = decodeChatLine(frame);
    if (!back) failures.push('a CHAT_LINE did not decode at all.');
    else if (
      back.sender !== line.sender ||
      back.room !== line.room ||
      back.flags !== line.flags ||
      back.name !== line.name ||
      back.text !== line.text
    ) {
      failures.push(`a CHAT_LINE round-tripped to ${JSON.stringify(back)}.`);
    }
    // The id widths: a `u8` sender would alias above 255 players and put one
    // person's words under another's name, which is the worst failure this
    // feature has.
    const wide = decodeChatLine(encodeChatLine({ ...line, sender: 65535, room: 65535 }));
    if (!wide || wide.sender !== 65535 || wide.room !== 65535) {
      failures.push(`a CHAT_LINE with the widest possible ids came back as ${JSON.stringify(wide)}.`);
    }
    // A truncated frame is refused rather than decoded into a lie.
    const cut = frame.slice(0, frame.byteLength - 3);
    if (decodeChatLine(cut) !== null) failures.push('a truncated CHAT_LINE decoded rather than being refused.');
    if (decodeChatLine(new ArrayBuffer(4)) !== null) failures.push('a runt CHAT_LINE decoded rather than being refused.');
  }

  // --- 6. The gate's arithmetic, driven on a synthetic clock.
  {
    // The burst: three back to back at t=0, the fourth refused.
    const g = newChatGate(0);
    for (let i = 0; i < CHAT_BURST; i++) {
      const r = chatAdmit(g, `line ${i}`, 0);
      if (r !== '') failures.push(`message ${i + 1} of the burst was refused ("${r}"); the burst is ${CHAT_BURST}.`);
    }
    if (chatAdmit(g, 'one too many', 0) !== 'rate') failures.push(`message ${CHAT_BURST + 1} at t=0 was not rate-limited.`);
    // A refusal must not consume a token, or a flooder would be silenced for
    // longer than the rule says.
    if (chatAdmit(g, 'still too many', 0) !== 'rate') failures.push('a second attempt at t=0 was admitted.');
    // One interval later, exactly one more gets through.
    if (chatAdmit(g, 'later', CHAT_INTERVAL_MS) !== '') failures.push(`nothing was admitted after one full ${CHAT_INTERVAL_MS} ms interval.`);
    if (chatAdmit(g, 'later still', CHAT_INTERVAL_MS) !== 'rate') failures.push('two messages got through on one interval of refill.');
    // And an idle minute refills to the burst and no further.
    const idle = newChatGate(0);
    chatAdmit(idle, 'a', 0);
    chatAdmit(idle, 'b', 0);
    chatAdmit(idle, 'c', 0);
    for (let i = 0; i < CHAT_BURST; i++) {
      if (chatAdmit(idle, `after idle ${i}`, 60000) !== '') failures.push(`only ${i} messages were available after a minute idle; the bucket holds ${CHAT_BURST}.`);
    }
    if (chatAdmit(idle, 'over the brim', 60000) !== 'rate') failures.push('the bucket refilled past its own capacity over a minute idle.');
  }

  // --- 7. The repeat guard, and the thing it must not do: cost a token.
  {
    // Far enough apart that the rate limit can never be what refuses.
    const g = newChatGate(0);
    let t = 0;
    const step = (): number => (t += CHAT_INTERVAL_MS * 2);
    for (let i = 1; i < CHAT_REPEAT_LIMIT; i++) {
      if (chatAdmit(g, 'oi', step()) !== '') failures.push(`repeat ${i} of "oi" was refused; ${CHAT_REPEAT_LIMIT} in a row is the limit.`);
    }
    if (chatAdmit(g, 'oi', step()) !== 'repeat') failures.push(`repeat ${CHAT_REPEAT_LIMIT} of "oi" was admitted.`);
    if (chatAdmit(g, 'OI', step()) !== 'repeat') failures.push('the repeat guard is case-sensitive; "OI" and "oi" are one message to a reader.');
    // Saying something else resets it, and the something else is not itself
    // charged for the refusals.
    if (chatAdmit(g, 'different', step()) !== '') failures.push('a different message after a repeat refusal was refused.');
    if (chatAdmit(g, 'oi', step()) !== '') failures.push('the repeat counter did not reset when the sender said something else.');
  }

  // --- 8. The notice throttle: one explanation per window, not one per attempt.
  {
    const g = newChatGate(0);
    if (!chatShouldNotify(g, 0)) failures.push('the first throttle notice was suppressed.');
    if (chatShouldNotify(g, CHAT_NOTICE_MS - 1)) failures.push('a second throttle notice went out inside the same window.');
    if (!chatShouldNotify(g, CHAT_NOTICE_MS)) failures.push('no notice went out after a full window.');
  }

  return failures;
}
