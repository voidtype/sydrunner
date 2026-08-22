/**
 * The quest wire: two messages, and the smallest possible amount of it.
 *
 * `game/questmodel.ts` is the contract -- the schema, the parser, the cursor
 * arithmetic -- and this is the eight-hundred-byte conversation on top of it.
 * The split is `net/teams.ts` over `game/teams.ts` and is made for the same
 * reason: the rules are read by three runtimes and the bytes are read by two.
 *
 * ---------------------------------------------------------------------------
 * THE CONTENT DOES NOT TRAVEL ON THE SOCKET
 *
 * The single most important thing about this file is how little is in it. A
 * quest pack is tens of kilobytes of JSON with sentences in it; the socket is
 * configured `maxPayloadLength: 1024` because every frame it was designed for
 * is a few dozen bytes of quantised integers, and putting dialog trees on it
 * would raise that ceiling for every frame from every client on the host.
 *
 * So the **pack goes over HTTP** -- `GET /content`, ETag'd, beside `/health`,
 * fetched once per client per revision and cached by the browser -- and the
 * socket carries only *this player's cursors* and *this player's decisions*.
 * That is the `/rooms` gateway's arrangement (a small JSON fetch before the
 * socket rather than a first-frame negotiation) and it has the same three
 * benefits: it is cacheable, it is inspectable with `curl`, and it costs the
 * game loop nothing.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CLIENT SENDS SIX OPS AND NOT SIXTY
 *
 * A step is either **observed** by the server on a tick it already runs, or it
 * is **asserted** by the client and checked. Five of the seven step kinds are
 * observed -- position, knockouts, pickups, train arrivals and wallet credits
 * are all things `server/sim.ts` already knows -- and a client that could
 * *claim* them could claim anything. So they are not on this wire at all.
 *
 * The two that cannot be observed are on it, and both are checked on arrival:
 *
 *   - `NODE` is "I clicked choice *n* on node *x*", which the server re-walks
 *     against its own copy of the pack. That is what makes a bribe safe (the
 *     price and the gate are the server's, and the debit goes through the
 *     wallet door) and what makes a `dialog` step safe (the *destination* is
 *     the pack's `goto`, not a node id the client chose).
 *   - `PHOTO` is "I photographed *landmark*", and the server checks the
 *     player's body is inside the step's circle. There is no other way for this
 *     process to know a shutter was pressed -- the camera is a canvas grab in
 *     the browser -- so this is the one step whose *occurrence* is trusted and
 *     whose *place* is not.
 *
 * `ACCEPT` and `TURNIN` are their own ops rather than being inferred from a
 * clicked choice, because they are the two decisions the server has to be able
 * to refuse **with a sentence**: "level 2 first", "that is DeFAULT work", "you
 * are already on that". A refusal derived from a choice index would have to say
 * "no" about a button, which tells the player nothing.
 *
 * One message id with a sub-op byte, on `MSG.SUGGEST`'s and `MSG.PHONE`'s
 * argument exactly: six ids would be six cases in `server/index.ts` for one
 * feature and six things to rate-limit separately, for a conversation held from
 * one panel a handful of times a session.
 */

// --- The ops ------------------------------------------------------------------

export const QUEST_OP = {
  /** "Tell me where I am." Sent on join and when the obligations app opens. */
  LIST: 0,
  /** Take a quest. The server checks every gate in `questRefusal`. */
  ACCEPT: 1,
  /** Hand one in. The server checks the cursor is `done` and pays. */
  TURNIN: 2,
  /** Give one up. A repeatable's cursor is dropped; a story quest's mark is not written. */
  ABANDON: 3,
  /**
   * "I clicked choice *n* on node *x* of npc *y*", or opened the conversation.
   *
   * `choice` is `NODE_OPENED` for the latter. See the header for what the
   * server does with it and why the destination is the pack's rather than the
   * client's.
   */
  NODE: 4,
  /** "I photographed *landmark*." Checked against the body's position. */
  PHOTO: 5,
} as const;

/** `choice` on a `NODE` op that means "I have just opened this conversation". */
export const NODE_OPENED = 0xff;

/** How many story flags travel on one state frame. See `encodeQuestState`. */
export const MAX_WIRE_FLAGS = 48;
/** How many cursors. A player with more than this many quests open is not a case. */
export const MAX_WIRE_CURSORS = 24;

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/** Ids are short by `questmodel.MAX_ID_CHARS`; this is the byte bound on the wire. */
const MAX_ID_BYTES = 64;

// --- Client to server ----------------------------------------------------------

export interface QuestRequest {
  op: number;
  /** ACCEPT / TURNIN / ABANDON: the quest. NODE: the npc. PHOTO: the landmark. */
  id: string;
  /** NODE only: which node the click was made on. */
  node: string;
  /** NODE only: which choice, or `NODE_OPENED`. */
  choice: number;
}

/**
 * `MSG.QUEST`:
 *
 *     u8   type
 *     u8   op
 *     u8   choice        NODE only; NODE_OPENED elsewhere
 *     u8   id bytes,   then the id
 *     u8   node bytes, then the node
 *
 * Fixed-order, length-prefixed, and **both lengths are always present** even
 * when the op does not use them. Two spare bytes on a message sent a handful of
 * times a session buys a decoder with one shape instead of six, which is the
 * trade `decodeSuggest` makes the other way round (it branches, because its
 * SUBMIT body is six hundred bytes and its LIST body is none).
 */
export function encodeQuest(type: number, req: Partial<QuestRequest> & { op: number }): ArrayBuffer {
  const id = ENC.encode(req.id ?? '').subarray(0, MAX_ID_BYTES);
  const node = ENC.encode(req.node ?? '').subarray(0, MAX_ID_BYTES);
  const buffer = new ArrayBuffer(5 + id.length + node.length);
  const v = new DataView(buffer);
  v.setUint8(0, type);
  v.setUint8(1, req.op);
  v.setUint8(2, req.choice === undefined ? NODE_OPENED : req.choice & 0xff);
  v.setUint8(3, id.length);
  v.setUint8(4 + id.length, node.length);
  const bytes = new Uint8Array(buffer);
  bytes.set(id, 4);
  bytes.set(node, 5 + id.length);
  return buffer;
}

/**
 * The server's decoder. Every read bounded by what **arrived**.
 *
 * `decodeSuggest`'s rule, restated because it is the rule for every decoder on
 * this side of the wire: a length byte that overruns the frame is the cheapest
 * thing a hostile client can say, `TextDecoder` on an out-of-range view throws,
 * and a throw inside the socket callback takes the message pump down for every
 * player on the host. Returns null.
 */
export function decodeQuest(buffer: ArrayBuffer, type: number): QuestRequest | null {
  if (buffer.byteLength < 5) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== type) return null;
  const op = v.getUint8(1);
  const choice = v.getUint8(2);
  const idLen = Math.min(v.getUint8(3), MAX_ID_BYTES);
  if (buffer.byteLength < 5 + idLen) return null;
  const nodeLen = Math.min(v.getUint8(4 + idLen), MAX_ID_BYTES);
  if (buffer.byteLength < 5 + idLen + nodeLen) return null;
  return {
    op,
    id: idLen > 0 ? DEC.decode(new Uint8Array(buffer, 4, idLen)) : '',
    node: nodeLen > 0 ? DEC.decode(new Uint8Array(buffer, 5 + idLen, nodeLen)) : '',
    choice,
  };
}

// --- Server to client ------------------------------------------------------------

/** One cursor, as it crosses. `questmodel.QuestCursor` plus the id it belongs to. */
export interface WireCursor {
  id: string;
  step: number;
  done: boolean;
  counts: number[];
}

/**
 * Everything one player is told about their own progress.
 *
 * **Per client**, like `MSG.SUGGEST_LIST` and unlike every other server message
 * in the table: it carries this player's cursors, this player's flags and this
 * player's xp, so it is never deduplicated across sockets the way a snapshot
 * body is. See `server/room.ts`'s `FrameGroups` for the machinery this stays
 * out of.
 */
export interface QuestStateFrame {
  /** The ladder currency. See `net/accounts.XP_PER_LEVEL`. */
  xp: number;
  level: number;
  /** The story flags, including the `q:<id>` completion marks. */
  flags: string[];
  cursors: WireCursor[];
  /** A sentence for the pill, or `''`. Composed by the server; see `Simulation.note`. */
  note: string;
  /** An improv line for a node just arrived at, or `''` for "use the authored one". */
  lineNpc: string;
  lineNode: string;
  line: string;
}

export function blankQuestState(): QuestStateFrame {
  return { xp: 0, level: 1, flags: [], cursors: [], note: '', lineNpc: '', lineNode: '', line: '' };
}

/**
 * `MSG.QUEST_STATE`:
 *
 *     u8   type
 *     u32  xp
 *     u8   level
 *     u8   note bytes,     then the note
 *     u8   flag count,     then count x (u8 bytes, flag)
 *     u8   cursor count,   then count x:
 *            u8  id bytes, then the id
 *            u8  step
 *            u8  flags        bit 0: done
 *            u8  count of counters, then that many u16
 *     u8   lineNpc bytes,  then the npc id
 *     u8   lineNode bytes, then the node id
 *     u16  line bytes,     then the line
 *
 * **Sent on change rather than on the snapshot path**, on `MSG.BIKES`'
 * argument: a cursor moves a few times a minute for a player who is actively
 * questing and never for one who is not, against a snapshot twenty times a
 * second. A player standing in the street with no quests open is sent this
 * once, at join, and then never again.
 *
 * `xp` is a `u32` and the level a `u8`, which is the one place this frame is not
 * as tight as it could be: the level is derivable from the xp by
 * `accounts.levelFor`. It is carried anyway because the alternative is a client
 * that computes a level -- and the level is the number over a player's head, so
 * two derivations of it is exactly the disagreement `RosterEntry.level` exists
 * to prevent. One byte, once per change.
 */
export function encodeQuestState(type: number, frame: QuestStateFrame): ArrayBuffer {
  const note = ENC.encode(frame.note).subarray(0, 255);
  const flags = frame.flags.slice(0, MAX_WIRE_FLAGS).map((f) => ENC.encode(f).subarray(0, 64));
  const cursors = frame.cursors.slice(0, MAX_WIRE_CURSORS);
  const ids = cursors.map((c) => ENC.encode(c.id).subarray(0, MAX_ID_BYTES));
  const lineNpc = ENC.encode(frame.lineNpc).subarray(0, MAX_ID_BYTES);
  const lineNode = ENC.encode(frame.lineNode).subarray(0, MAX_ID_BYTES);
  const line = ENC.encode(frame.line).subarray(0, 2000);

  let n = 8 + note.length;
  n += 1;
  for (const f of flags) n += 1 + f.length;
  n += 1;
  for (let i = 0; i < cursors.length; i++) n += 4 + ids[i].length + 2 * Math.min(cursors[i].counts.length, 255);
  n += 1 + lineNpc.length + 1 + lineNode.length + 2 + line.length;

  const buffer = new ArrayBuffer(n);
  const v = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  v.setUint8(0, type);
  v.setUint32(1, Math.max(0, Math.min(0xffffffff, Math.trunc(frame.xp))), true);
  v.setUint8(5, Math.max(1, Math.min(255, Math.trunc(frame.level))));
  v.setUint8(6, note.length);
  bytes.set(note, 7);
  let p = 7 + note.length;
  v.setUint8(p++, flags.length);
  for (const f of flags) {
    v.setUint8(p++, f.length);
    bytes.set(f, p);
    p += f.length;
  }
  v.setUint8(p++, cursors.length);
  for (let i = 0; i < cursors.length; i++) {
    const c = cursors[i];
    const id = ids[i];
    v.setUint8(p++, id.length);
    bytes.set(id, p);
    p += id.length;
    v.setUint8(p++, Math.max(0, Math.min(255, c.step)));
    v.setUint8(p++, c.done ? 1 : 0);
    const counters = Math.min(c.counts.length, 255);
    v.setUint8(p++, counters);
    for (let k = 0; k < counters; k++) {
      v.setUint16(p, Math.max(0, Math.min(0xffff, Math.trunc(c.counts[k]))), true);
      p += 2;
    }
  }
  v.setUint8(p++, lineNpc.length);
  bytes.set(lineNpc, p);
  p += lineNpc.length;
  v.setUint8(p++, lineNode.length);
  bytes.set(lineNode, p);
  p += lineNode.length;
  v.setUint16(p, line.length, true);
  p += 2;
  bytes.set(line, p);
  return buffer;
}

/** The client's decoder. Bounded like the server's, and for a weaker reason: a
 * short read here is a stale build talking to a new server, which should draw
 * nothing rather than throw inside `NetClient`'s message switch. */
export function decodeQuestState(buffer: ArrayBuffer, type: number): QuestStateFrame | null {
  if (buffer.byteLength < 8) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== type) return null;
  const out = blankQuestState();
  out.xp = v.getUint32(1, true);
  out.level = v.getUint8(5);
  const noteLen = v.getUint8(6);
  if (buffer.byteLength < 7 + noteLen + 2) return null;
  out.note = noteLen > 0 ? DEC.decode(new Uint8Array(buffer, 7, noteLen)) : '';
  let p = 7 + noteLen;
  const flagCount = v.getUint8(p++);
  for (let i = 0; i < flagCount; i++) {
    if (p >= buffer.byteLength) return null;
    const len = v.getUint8(p++);
    if (p + len > buffer.byteLength) return null;
    out.flags.push(len > 0 ? DEC.decode(new Uint8Array(buffer, p, len)) : '');
    p += len;
  }
  if (p >= buffer.byteLength) return null;
  const cursorCount = v.getUint8(p++);
  for (let i = 0; i < cursorCount; i++) {
    if (p >= buffer.byteLength) return null;
    const idLen = v.getUint8(p++);
    if (p + idLen + 3 > buffer.byteLength) return null;
    const id = idLen > 0 ? DEC.decode(new Uint8Array(buffer, p, idLen)) : '';
    p += idLen;
    const step = v.getUint8(p++);
    const done = (v.getUint8(p++) & 1) !== 0;
    const counters = v.getUint8(p++);
    if (p + counters * 2 > buffer.byteLength) return null;
    const counts: number[] = [];
    for (let k = 0; k < counters; k++) {
      counts.push(v.getUint16(p, true));
      p += 2;
    }
    out.cursors.push({ id, step, done, counts });
  }
  // The improv tail. **Absent is legal**, not a short read: a server that has
  // nothing to say about a node sends nothing, and an older server does not
  // send these fields at all.
  if (p >= buffer.byteLength) return out;
  const npcLen = v.getUint8(p++);
  if (p + npcLen >= buffer.byteLength) return out;
  out.lineNpc = npcLen > 0 ? DEC.decode(new Uint8Array(buffer, p, npcLen)) : '';
  p += npcLen;
  const nodeLen = v.getUint8(p++);
  if (p + nodeLen + 2 > buffer.byteLength) return out;
  out.lineNode = nodeLen > 0 ? DEC.decode(new Uint8Array(buffer, p, nodeLen)) : '';
  p += nodeLen;
  const lineLen = v.getUint16(p, true);
  p += 2;
  if (p + lineLen > buffer.byteLength) return out;
  out.line = lineLen > 0 ? DEC.decode(new Uint8Array(buffer, p, lineLen)) : '';
  return out;
}

// --- The self-check ---------------------------------------------------------------

/**
 * The quest conversation's bytes, both directions.
 *
 * A function of its own rather than a section of `verifyNet`, and the reason is
 * structural rather than stylistic: `net/protocol.ts` has **no imports**. It is
 * the root of this tree -- every other module reads it and it reads nothing --
 * and a check inside it that needed these codecs would invert that. `net/teams.
 * verifyTeamsWire` is the precedent and was created for exactly this reason;
 * `verifyNet` still owns the half of the contract that lives in the table
 * itself, which is that `QUEST` and `QUEST_STATE` are unique and on the right
 * sides of 0x80.
 *
 * Wired into **both** boot lists. What it catches, and every one of them
 * renders a perfectly good frame:
 *
 *   - **A `NODE` op whose two length prefixes are read in the wrong order.**
 *     The ids are variable-length and adjacent, so a decoder off by one byte
 *     resolves a *different node of the same NPC* -- which is a real node, with
 *     real choices, which the server then adjudicates. There is no throw and no
 *     log; the player clicks "take the job" and is told about the weather.
 *   - **A truncated frame decoding anyway.** A length byte that overruns is the
 *     cheapest thing a hostile client can send, and a `TextDecoder` on an
 *     out-of-range view throws inside the socket callback -- which takes the
 *     message pump down for every player on the host.
 *   - **The xp field as anything narrower than a `u32`.** 255 levels is 255,000
 *     xp and a `u16` wraps at 65,535, so a player past level 66 would watch
 *     their xp bar reset while their level did not.
 *   - **A counter array whose length is not carried.** The per-step counters
 *     are what "two of three eshays" is, and a reader that assumed a fixed
 *     width would attribute one step's progress to another.
 *   - **The improv tail being read as mandatory.** A server with nothing to say
 *     sends no tail, and a decoder that required one would refuse every
 *     ordinary state frame -- which is the *common* case, not the edge.
 */
export function verifyQuestWire(): string[] {
  const failures: string[] = [];
  const MSG_QUEST = 0x15;
  const MSG_QUEST_STATE = 0x95;
  const MSG_OTHER = 0x0c;
  const req = decodeQuest(
    encodeQuest(MSG_QUEST, { op: QUEST_OP.NODE, id: 'centrelink-clerk', node: 'obligations', choice: 2 }),
    MSG_QUEST,
  );
  if (!req) {
    failures.push('A QUEST NODE op did not decode at all.');
  } else {
    if (req.op !== QUEST_OP.NODE) failures.push(`A NODE op came back as op ${req.op}.`);
    if (req.id !== 'centrelink-clerk') failures.push(`A QUEST npc id came back as ${JSON.stringify(req.id)}.`);
    if (req.node !== 'obligations') failures.push(`A QUEST node id came back as ${JSON.stringify(req.node)}.`);
    if (req.choice !== 2) failures.push(`A QUEST choice index came back as ${req.choice}.`);
  }
  // Every op round-trips, so adding one and forgetting the encoder is a boot
  // failure rather than a button that does nothing.
  for (const [name, op] of Object.entries(QUEST_OP)) {
    const back = decodeQuest(encodeQuest(MSG_QUEST, { op, id: 'a', node: 'b', choice: 0 }), MSG_QUEST);
    if (!back || back.op !== op) failures.push(`QUEST_OP.${name} does not round-trip.`);
  }
  // An empty-bodied op -- LIST sends no ids at all -- must still decode.
  const list = decodeQuest(encodeQuest(MSG_QUEST, { op: QUEST_OP.LIST }), MSG_QUEST);
  if (!list || list.op !== QUEST_OP.LIST || list.id !== '' || list.node !== '') {
    failures.push('A QUEST LIST op with no ids did not decode to an empty request.');
  }
  if (decodeQuest(new ArrayBuffer(3), MSG_QUEST) !== null) failures.push('A truncated QUEST frame decoded.');
  if (decodeQuest(encodeQuest(MSG_QUEST, { op: 0 }), MSG_OTHER) !== null) {
    failures.push("A QUEST frame decoded against another message's type byte.");
  }
  // A length prefix that overruns the frame, which is what a hostile client
  // sends. It must be refused rather than throw out of the socket callback.
  {
    const lying = new Uint8Array(encodeQuest(MSG_QUEST, { op: QUEST_OP.ACCEPT, id: 'x' }));
    lying[3] = 200;
    let threw = false;
    let decoded: unknown = null;
    try {
      decoded = decodeQuest(lying.buffer, MSG_QUEST);
    } catch {
      threw = true;
    }
    if (threw) failures.push('A QUEST frame with a lying length prefix threw rather than returning null.');
    if (decoded !== null) failures.push('A QUEST frame with a length prefix past the end of the buffer decoded.');
  }

  // --- And the state frame back.
  const state: QuestStateFrame = {
    xp: 254_900,
    level: 255,
    flags: ['act0:reported', 'q:act0-report', 'act0:handler-met'],
    cursors: [
      { id: 'act0-doorknock', step: 1, done: false, counts: [1, 2, 0] },
      { id: 'act0-mutual', step: 3, done: true, counts: [1, 1, 1] },
    ],
    note: 'level 3 — pick a side',
    lineNpc: 'centrelink-clerk',
    lineNode: 'smalltalk',
    line: 'the system is down. it is always down. take a seat.',
  };
  const back = decodeQuestState(encodeQuestState(MSG_QUEST_STATE, state), MSG_QUEST_STATE);
  if (!back) {
    failures.push('A QUEST_STATE frame did not decode at all.');
  } else {
    if (back.xp !== state.xp) failures.push(`${state.xp} xp came back as ${back.xp}; the field is a u32.`);
    if (back.level !== state.level) failures.push(`Level ${state.level} came back as ${back.level}.`);
    if (back.flags.join('|') !== state.flags.join('|')) failures.push(`The story flags came back as ${back.flags.join('|')}.`);
    if (back.cursors.length !== 2) failures.push(`${back.cursors.length} cursors survived, not 2.`);
    else {
      const [a, b] = back.cursors;
      if (a.id !== 'act0-doorknock' || a.step !== 1 || a.done) failures.push(`A cursor came back as ${JSON.stringify(a)}.`);
      if (a.counts.join(',') !== '1,2,0') failures.push(`A cursor's counters came back as ${a.counts.join(',')}.`);
      if (!b.done) failures.push('A finished cursor came back unfinished; the turn-in would never be offered.');
    }
    if (back.note !== state.note) failures.push(`The note came back as ${JSON.stringify(back.note)}.`);
    if (back.line !== state.line) failures.push(`The improv line came back as ${JSON.stringify(back.line)}.`);
    if (back.lineNpc !== state.lineNpc || back.lineNode !== state.lineNode) {
      failures.push('The improv line came back addressed to a different node.');
    }
  }
  // The ordinary frame: no quests, no flags, no line. This is what every
  // player who is not questing is sent, exactly once, at join.
  const empty = decodeQuestState(encodeQuestState(MSG_QUEST_STATE, blankQuestState()), MSG_QUEST_STATE);
  if (!empty) failures.push('An empty QUEST_STATE frame did not decode; that is the ordinary case.');
  else if (empty.cursors.length !== 0 || empty.flags.length !== 0 || empty.line !== '') {
    failures.push('An empty QUEST_STATE frame decoded to something.');
  }
  if (decodeQuestState(new ArrayBuffer(4), MSG_QUEST_STATE) !== null) failures.push('A truncated QUEST_STATE decoded.');
  // The wire caps hold, so a player who has somehow accumulated a hundred
  // flags is a large frame rather than a corrupt one.
  const flood = decodeQuestState(
    encodeQuestState(MSG_QUEST_STATE, {
      ...blankQuestState(),
      flags: Array.from({ length: 200 }, (_, i) => `flag:${i}`),
      cursors: Array.from({ length: 200 }, (_, i) => ({ id: `q${i}`, step: 0, done: false, counts: [0] })),
    }),
    MSG_QUEST_STATE,
  );
  if (!flood) failures.push('A QUEST_STATE frame at the caps did not decode.');
  else if (flood.flags.length > MAX_WIRE_FLAGS || flood.cursors.length > MAX_WIRE_CURSORS) {
    failures.push(`${flood.flags.length} flags and ${flood.cursors.length} cursors crossed, over the caps.`);
  }

  return failures;
}
