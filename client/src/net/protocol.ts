/**
 * The wire. Every byte that crosses between a browser and the authoritative
 * server, in one file that both of them import.
 *
 * Spec 10 in full, with one stated deviation and one measured shortfall. It is
 * imported by `client/src/net/client.ts` and by `server/index.ts` from the same
 * path, which is the entire reason spec 9's runtime question was answered with
 * Bun: an encoder and a decoder that are two files are two files that disagree,
 * and the disagreement is a field of garbage on one end with nothing thrown on
 * either.
 *
 * ---------------------------------------------------------------------------
 * TRANSPORT: WebSocket, not WebTransport. A deliberate deviation from spec 10.
 *
 * Spec 10's first line is *"Transport: WebTransport datagrams... Requires HTTP/3
 * and a valid TLS certificate -- not optional."* That is the right transport and
 * it is not the transport here, because the requirement it states is a
 * *deployment* problem rather than a networking one: HTTP/3 needs a real
 * certificate for a real hostname, which is the pending remote-deployment step,
 * and neither `localhost` nor a LAN address can have one. Blocking two browsers
 * on this machine seeing each other behind a certificate authority is the wrong
 * order to do the work in.
 *
 * So this is binary frames over a plain WebSocket, and what that costs is
 * precisely what spec 10 says it costs: TCP, so a lost packet holds up every
 * packet behind it. On a loopback and on a LAN that is unobservable. Over the
 * internet it is the difference between a 40 ms hiccup and a 200 ms one, and it
 * is the reason the substitution is temporary rather than a decision.
 *
 * What makes the swap cheap when the certificate exists is that nothing in this
 * file knows what carries it. `NetTransport` below is four members wide and
 * `client.ts` speaks only to that; a WebTransport implementation of it is one
 * new class, and every message here is already a self-contained frame with its
 * type in the first byte, which is the shape a datagram wants and a stream does
 * not care about.
 *
 * ---------------------------------------------------------------------------
 * BANDWIDTH: measured, and short of spec 10's budget at sixteen players.
 *
 * Spec 10 asks for *"< 30 kbit/s per player downstream at 16 players"*. What is
 * here is 21 bytes per player per snapshot plus a 10-byte header, at 20 Hz:
 *
 *     16 players -> 9 + 16 x 21 = 345 B/snapshot -> 6,900 B/s -> **55 kbit/s**
 *      6 players -> 9 +  6 x 21 = 135 B/snapshot -> 2,700 B/s -> **22 kbit/s**
 *      2 players ->              51 B/snapshot -> 1,020 B/s ->  **8 kbit/s**
 *
 * So the budget is met at six players and missed by 1.8x at sixteen, and it is
 * stated here rather than rounded away because the arithmetic is not close and
 * nothing about the game says so. The deliverable this pass exists for is two
 * browsers on one machine; sixteen is spec 2's cap and is not reachable from a
 * laptop on a desk.
 *
 * **Footballs are on top of that**, at 18 B each, and they are the one part of
 * this record not paid per player. A ball lives about 1.5 s in practice -- three
 * bounces goes quickly -- and the supply bar returns one every 4 s, so the
 * *sustained* count is roughly a quarter of a ball per player: about two in the
 * air at six players, 36 B, and the stream stays at 28 kbit/s. A **burst**, six
 * players emptying three-ball bars at once, is eighteen balls for a second and a
 * half and takes it to 74 kbit/s.
 *
 * That burst is over the budget and is stated rather than smoothed away. It is
 * accepted for two reasons: it is transient by construction -- the bar cannot
 * refill fast enough to sustain it -- and the same delta encoding in the note
 * below closes it more cheaply than it closes the players, because a ball's
 * position moves a predictable 1.4 m a snapshot along a known velocity, so the
 * residual against a *ballistic* prediction is centimetres. `verifyNet` asserts
 * the sustained case and that a ball never costs more than a person.
 *
 * **Faction actors are on top of that too**, at 18 B each -- see `NPC_BYTES` --
 * and they are the one section here that is neither per-player nor transient.
 * `game/factions.MAX_ACTORS` is what bounds it, at 24, and that number is a
 * *wire* budget rather than a simulation one for exactly this reason:
 *
 *     quiet city      -> 0 actors                          -> no change at all
 *     one pursuit     -> 4 actors,  72 B                   ->  +12 kbit/s
 *     the cap         -> 24 actors, 432 B                  ->  +69 kbit/s
 *
 * The realistic worst case anything in this build can reach -- sixteen players,
 * the two balls six of them sustain, and a pursuit at the cap -- is 814 B a
 * snapshot, or **131 kbit/s**. That is well over spec 10's budget in the same
 * direction and for the same reason the player section already is, and the two
 * remedies below close it identically: an officer walking is a near-zero delta
 * and an officer running is a predictable one.
 *
 * The cap is what makes the number bounded rather than a function of how much
 * trouble a player is in, which is the property that actually matters. Ambient
 * officers -- everybody on a beat who has not been promoted -- cost **nothing**,
 * because they are a deterministic function of the tick on both ends, exactly as
 * six thousand cars are.
 *
 * The gap is 12 bytes of position per player, and there are two known ways to
 * close it, neither of which belongs in a first server:
 *
 *   - **Pack the position instead of sending three i32.** The extent is 4 km
 *     now and 15 km at stage 2, and the terrain spans about -100 to +400 m, so
 *     21/17/21 bits at 1 cm covers the whole middle ring in 8 bytes and takes
 *     the record to 17. That is 45 kbit/s at sixteen -- an improvement and still
 *     not the budget.
 *   - **Delta-encode against the last acknowledged snapshot.** This is the one
 *     that actually gets there: a standing player is a zero delta and a running
 *     one moves under 15 cm a snapshot, so a field mask plus i16 centimetres is
 *     five or six bytes for almost everybody. It needs per-client baselines,
 *     acknowledgement of a *snapshot* rather than of an input, and a resend path
 *     for a baseline the client never got -- three mechanisms, all of which have
 *     failure modes that look like teleporting players.
 *
 * Upstream is not close to a constraint: 10 bytes at 60 Hz is 4.8 kbit/s.
 *
 * ---------------------------------------------------------------------------
 * QUANTISATION. Spec 10: *"Quantise hard -- the world is metric and 1 cm is
 * plenty."*
 *
 * Position is i32 **millimetres** of world coordinate, which is ten times finer
 * than the spec asks and is chosen for robustness rather than for precision:
 * i32 mm covers +/- 2,147 km, so no player at any stage of the extent can ever
 * wrap the field, and there is no origin, no scale factor and no envelope for
 * the two ends to disagree about. Every other quantity is packed to the coarsest
 * unit that is still invisible:
 *
 *   - **yaw** to u16 over a full turn: 0.0000959 rad, or 0.0055 degrees. A
 *     player turning at the mouse's fastest is 6 rad/s, which is 0.1 rad a tick,
 *     so the step is a thousandth of one tick's turn.
 *   - **pitch** to i16 over +/- pi/2: 0.0000479 rad. Half the yaw step, because
 *     the range is half as wide and the field is the same width.
 *   - **health** to u8 at 1/64 pip. Spec 8.3's smallest real health is 0.6 pips
 *     and the HUD draws a ceiling, so what has to survive is only "is this
 *     above zero", which 1/64 answers with six bits to spare.
 *   - **movement** to i8 at 1/100. The controller normalises the wish vector two
 *     lines in, so anything finer than a hundredth of an axis is discarded
 *     before it reaches the integrator.
 *   - **ball velocity** to i8 at 0.5 m/s, which is by far the coarsest field
 *     here and is argued out at `BALL_BYTES`. Nothing integrates it: it curves a
 *     50 ms interpolation and points a tumbling mesh, so its whole contribution
 *     is 2.5 cm of arc -- comparable to the rounding already on the two
 *     positions it sits between.
 *
 * `verifyNet` asserts every one of those round-trips inside its own step, and it
 * exists because a quantiser that is wrong by a factor of two produces a game
 * that works: everybody is simply somewhere slightly different, which reads as
 * lag.
 */

// --- The transport seam -------------------------------------------------------

/**
 * What `client.ts` and the server both talk to, and the whole of the surface a
 * WebTransport implementation has to satisfy later.
 *
 * Four members. Deliberately not an `EventTarget` and deliberately not a
 * `Promise`-shaped API: every message here is a frame that supersedes the last
 * one of its type, which is a callback per arrival and nothing else. A
 * `WebSocket` satisfies this in about fifteen lines (`WebSocketTransport`
 * below); a `WebTransport` datagram reader satisfies it in about twenty-five,
 * and the difference is entirely in the constructor.
 */
export interface NetTransport {
  readonly open: boolean;
  send(frame: ArrayBuffer): void;
  close(): void;
  /** Called with every arriving frame, in arrival order. */
  onframe: ((frame: ArrayBuffer) => void) | null;
  onopen: (() => void) | null;
  onclose: ((reason: string) => void) | null;
}

// --- Message types ------------------------------------------------------------

/**
 * The first byte of every frame.
 *
 * Client messages are under 0x80 and server messages are at or over it, which is
 * not decoration: it means a frame that somehow arrives at the wrong end is
 * rejected by a range test rather than misparsed as whatever type happens to
 * share its number, and during development that is the difference between an
 * error and a player at the antipodes.
 */
export const MSG = {
  HELLO: 0x01,
  INPUT: 0x02,
  PING: 0x03,

  WELCOME: 0x81,
  SNAPSHOT: 0x82,
  EVENTS: 0x83,
  PONG: 0x84,
  POWERUPS: 0x85,
  BYE: 0x86,
  ROSTER: 0x87,
  /**
   * Where the lime e-bikes are and who is on them. See `encodeBikes`.
   *
   * A message of its own rather than a section of the snapshot, on
   * `ROSTER`'s argument rather than `POWERUPS`': a bike changes when somebody
   * mounts, dismounts or is knocked off it, which is a few times a minute across
   * the whole world, against a position that is different every tick. Twenty
   * times a second it would be the largest thing on the wire; on change it is
   * fifteen bytes.
   */
  BIKES: 0x88,
  /**
   * Who is under investigation, and for how much longer. See `encodeInvestigations`.
   *
   * A message of its own rather than a section of the snapshot, on `ROSTER`'s
   * argument: an investigation opens a few times a minute across the whole
   * world and its countdown is *derivable* once you have been told it -- both
   * ends know the tick rate, so a client can run the clock down itself between
   * messages. Twenty times a second it would be a per-player field paid by
   * everybody to carry a number that is almost always zero; on change it is four
   * bytes.
   */
  INVESTIGATION: 0x89,
} as const;

/**
 * Bumped whenever any layout below changes.
 *
 * Checked in `HELLO`/`WELCOME` and refused rather than tolerated. `collision.ts`
 * argues the opposite case for the tile payload -- no version word, because a
 * stale file misparses on the first record and announces itself -- and the
 * reason this file goes the other way is that the two ends do **not** ship
 * together: a browser tab left open across a server restart is exactly the case
 * that produces a silently misparsed snapshot, and the failure there is a
 * player who moves in the wrong direction rather than a load that fails.
 */
export const PROTOCOL_VERSION = 7;

/** Spec 10: "60 Hz tick, snapshots at 20-30 Hz." */
export const TICK_HZ = 60;
export const SNAPSHOT_HZ = 20;
/** Every this many ticks, one snapshot. 60 / 20 = 3. */
export const SNAPSHOT_INTERVAL = TICK_HZ / SNAPSHOT_HZ;

/** Spec 2's cap, and the width of the `id` field's useful range. */
export const MAX_PLAYERS = 16;

/** Spec 10: "Server rewind for punch validation, capped at 250 ms." */
export const MAX_REWIND_MS = 250;

/** Spec 10: "snapshot interpolation for remotes (~100 ms buffer)". */
export const INTERP_DELAY_MS = 100;

// --- Quantisation -------------------------------------------------------------

const TAU = Math.PI * 2;
/** u16 over a full turn. See the header for the resulting step. */
const YAW_SCALE = 65536 / TAU;
/** i16 over +/- pi/2, which is `controller.step`'s clamp. */
const PITCH_SCALE = 32767 / (Math.PI / 2);
/** u8 at 1/64 of a pip. `combat.MAX_HEALTH` is 3, so the field tops out at 192. */
const HEALTH_SCALE = 64;

/** Radians to u16. Wraps rather than clamps: a yaw is an angle and has no ends. */
export function quantiseYaw(yaw: number): number {
  // `%` in JavaScript keeps the sign of the dividend, so a negative yaw needs
  // the extra turn before the truncation or it lands in the wrong half of the
  // field -- which is a player facing exactly backwards, half the time.
  const wrapped = ((yaw % TAU) + TAU) % TAU;
  return Math.round(wrapped * YAW_SCALE) & 0xffff;
}

export function dequantiseYaw(raw: number): number {
  return (raw & 0xffff) / YAW_SCALE;
}

/** Radians to i16, clamped to the controller's own pitch limit. */
export function quantisePitch(pitch: number): number {
  const clamped = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch));
  return Math.max(-32767, Math.min(32767, Math.round(clamped * PITCH_SCALE)));
}

export function dequantisePitch(raw: number): number {
  return raw / PITCH_SCALE;
}

/** Metres to i32 millimetres. */
export function quantisePos(metres: number): number {
  // `Math.round` on a non-finite value gives NaN, and `DataView.setInt32(NaN)`
  // writes zero -- a player teleported to the ENU origin with nothing thrown.
  // A position should never be NaN; if one ever is, being clamped to the edge of
  // the world is a visible failure rather than an invisible one.
  if (!Number.isFinite(metres)) return metres > 0 ? 0x7fffffff : -0x7fffffff;
  return Math.max(-0x7fffffff, Math.min(0x7fffffff, Math.round(metres * 1000)));
}

export function dequantisePos(raw: number): number {
  return raw / 1000;
}

/** Pips to u8 at 1/64. */
export function quantiseHealth(health: number): number {
  return Math.max(0, Math.min(255, Math.round(health * HEALTH_SCALE)));
}

export function dequantiseHealth(raw: number): number {
  return raw / HEALTH_SCALE;
}

/** A movement axis, -1..1, to i8 at 1/100. */
export function quantiseAxis(v: number): number {
  return Math.max(-100, Math.min(100, Math.round(v * 100)));
}

export function dequantiseAxis(raw: number): number {
  return raw / 100;
}

// --- Names --------------------------------------------------------------------

/**
 * A player's session name: what the kill feed says and what the leaderboard is
 * a list of.
 *
 * The rules live **here**, in the file both ends import, for the reason this
 * file's header gives about the encoder and the decoder: a sanitiser that is two
 * functions is two functions that disagree, and the disagreement is a client
 * that shows one name over a body and a scoreboard that shows another. The
 * client runs `sanitiseName` so what the player typed is what they see in the
 * prompt; the server runs it again on arrival and **does not trust the first
 * run**, which is the only rule about a client-supplied string worth stating.
 *
 * The cap is two caps, and both are load-bearing. `MAX_NAME_CHARS` is what a
 * player is allowed to type and is measured in *code points*, so a name is
 * clipped where a person would say it is. `MAX_NAME_BYTES` is what the wire is
 * allowed to carry: the length prefix is a `u8`, and a name of sixteen
 * astral-plane code points is 64 bytes, which would silently truncate a record
 * mid-sequence and desynchronise every entry after it in the roster. Clipping to
 * whole code points at both limits is what makes that unreachable rather than
 * unlikely.
 */
export const MIN_NAME_CHARS = 2;
export const MAX_NAME_CHARS = 16;
/** 48 = 16 x 3, which covers every character in the BMP at the char cap. */
export const MAX_NAME_BYTES = 48;

const NAME_ENCODER = new TextEncoder();
const NAME_DECODER = new TextDecoder();

/**
 * The invisible ones, dropped rather than replaced.
 *
 * Zero-width spaces and the bidirectional overrides, which are the two ways a
 * name can be a lie: a run of U+200B is a player with no name at all who still
 * occupies a leaderboard row, and an unterminated U+202E reverses the rest of
 * the line it is drawn in -- including everything the *interface* wrote after
 * it, which is a kill feed that can be made to read backwards by joining.
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

/** Clip to whole code points at both caps, then re-trim. */
function clipName(chars: readonly string[]): string {
  let out = chars.slice(0, MAX_NAME_CHARS);
  while (out.length > 0 && NAME_ENCODER.encode(out.join('')).length > MAX_NAME_BYTES) out.pop();
  return out.join('').trim();
}

/**
 * What the player typed, reduced to something that can be drawn in a row of a
 * table without lying about its width.
 *
 * Returns the **empty string** for anything that does not survive -- too short,
 * all whitespace, all controls -- rather than substituting a default, because
 * the two callers want different defaults (the prompt suggests one, the server
 * assigns one) and a function that picked would make one of them fight it.
 *
 * Idempotent by construction, which `verifyNames` asserts: the server runs this
 * over a string the client already ran it over, and a sanitiser whose second
 * pass differs from its first is a name that changes when it crosses the wire.
 */
export function sanitiseName(raw: string): string {
  let cleaned = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    // C0, DEL and C1 become spaces rather than vanishing, so "a\nb" is "a b"
    // and not "ab" -- a control character was a separator to whoever typed it.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      cleaned += ' ';
      continue;
    }
    if (invisible(code)) continue;
    cleaned += ch;
  }
  // Every kind of space, collapsed to one. `\s` in a Unicode-aware regex covers
  // the ideographic space and the non-breaking one, which are the two that get
  // used to draw a name wider than its character count.
  cleaned = cleaned.replace(/\s+/gu, ' ').trim();
  const chars = [...cleaned];
  if (chars.length < MIN_NAME_CHARS) return '';
  return clipName(chars);
}

/**
 * Something to be called when you have not said.
 *
 * Two callers and one list, which is the reason it is in this file rather than
 * in the HUD: the **prompt** offers one of these as a suggestion so nobody has
 * to invent a name to get into a game, and the **server** assigns one to a
 * client that sent nothing -- an old build, a blank field, a name that turned
 * out to be entirely zero-width spaces. Two lists would mean the game had two
 * opinions about what a Sydney name looks like, and the one nobody sees is the
 * one that would end up as "Player".
 *
 * The number is what makes it usable rather than decorative: "Roo" collides on
 * the second joiner and "Roo 47" does not, so `uniqueName` almost never has to
 * do anything and nobody arrives already called "Roo (3)".
 *
 * `seed` makes it deterministic, which is only for the server -- a nameless
 * client is given the same name every time it reconnects on the same id, so a
 * console line and a scoreboard row can be matched up by hand.
 */
const SUGGESTED = [
  'Roo', 'Cockie', 'Ibis', 'Magpie', 'Possum', 'Wombat', 'Galah', 'Bogan',
  'Larrikin', 'Drongo', 'Ratbag', 'Bunyip', 'Quokka', 'Currawong', 'Nipper', 'Cobber',
] as const;

export function suggestName(seed?: number): string {
  // A cheap integer hash, so consecutive ids do not give consecutive words --
  // `id % 16` would name the first four joiners Roo, Cockie, Ibis, Magpie in
  // order, which reads as a numbering scheme rather than as a name.
  const n = seed === undefined ? Math.floor(Math.random() * 0x7fffffff) : Math.abs(Math.floor(seed)) * 2654435761;
  const mixed = (n ^ (n >>> 13)) >>> 0;
  const word = SUGGESTED[mixed % SUGGESTED.length];
  // 2..99, so it is always two digits' worth of variety and never "Roo 0".
  return `${word} ${2 + ((mixed >>> 5) % 98)}`;
}

/**
 * `base`, or `base (2)`, or `base (3)` -- the first form nobody else is using.
 *
 * Case-insensitive, because two players called "bazza" and "Bazza" are the same
 * problem this exists to solve: telling them apart in a kill feed is the whole
 * job, and a comparison that says those two are different names has not done it.
 *
 * The **stem** is clipped to make room for the suffix rather than the suffix
 * being dropped, so a sixteen-character name that collides stays inside the cap
 * and stays distinguishable. Falls back to the id-shaped form after 99 tries,
 * which needs a hundred players in a sixteen-player game to reach.
 */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set<string>();
  for (const t of taken) used.add(t.toLowerCase());
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; n < 100; n++) {
    const suffix = ` (${n})`;
    const room = MAX_NAME_CHARS - [...suffix].length;
    const stem = [...base].slice(0, Math.max(1, room)).join('').trim();
    const candidate = clipName([...(stem + suffix)]);
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return clipName([...`${base} (?)`]);
}

// --- Client -> server ---------------------------------------------------------

/**
 * `INPUT`'s button field.
 *
 * `THROW` is bit 1, which is where the raygun's trigger used to be, and keeping
 * the bit rather than renumbering is deliberate: the ranged weapon changed from
 * a beam to a football and the *input* did not -- it is still "the player is
 * asking to use the ranged weapon this tick", still level-triggered, still right
 * click. A renumbering would have been churn in four files for a word.
 */
export const BTN = {
  PUNCH: 1 << 0,
  THROW: 1 << 1,
  JUMP: 1 << 2,
  SPRINT: 1 << 3,
  /**
   * `E`: get on the bike you are standing next to, or get off the one you are on.
   *
   * **Level-triggered on the wire and edge-triggered by the reader**, which is
   * the one thing about this bit worth stating. Every other button here is a
   * state the server can act on every tick -- holding punch is a punch as soon as
   * the phase allows one -- but mounting is a *toggle*, and a held E read once
   * per tick would mount and dismount thirty times a second. So the bit says
   * "the key is down" like all its neighbours, and both `server/sim.ts` and the
   * client's own prediction keep the previous tick's value and act on the rising
   * edge. Putting the edge detection on the sender instead was rejected for the
   * usual reason: a dropped packet would lose the whole press, where a level bit
   * survives a repeat of the last input, which is exactly what `Participant.input`
   * does with a dropped one.
   */
  MOUNT: 1 << 4,
} as const;

/**
 * One tick of a player's intent, 10 bytes.
 *
 *     u8   type = MSG.INPUT
 *     u16  seq          wraps at 65536, which is 18 minutes at 60 Hz
 *     u8   buttons      BTN.*
 *     i8   forward      -100..100
 *     i8   right
 *     u16  yaw
 *     i16  pitch
 *
 * What is **not** in it is the whole design: no position, no velocity, no
 * speedScale, no stamina, no health. The server owns every one of those and
 * derives the movement scales from the combatant's own powerup clocks -- see
 * `combat.advance`, which reads them off the state rather than off the input for
 * exactly this reason. A client that sends where it thinks it is is a client
 * that can send where it would like to be.
 */
export const INPUT_BYTES = 10;

export interface InputFrame {
  seq: number;
  buttons: number;
  forward: number;
  right: number;
  yaw: number;
  pitch: number;
}

export function encodeInput(frame: InputFrame, buffer = new ArrayBuffer(INPUT_BYTES)): ArrayBuffer {
  const v = new DataView(buffer);
  v.setUint8(0, MSG.INPUT);
  v.setUint16(1, frame.seq & 0xffff, true);
  v.setUint8(3, frame.buttons);
  v.setInt8(4, quantiseAxis(frame.forward));
  v.setInt8(5, quantiseAxis(frame.right));
  v.setUint16(6, quantiseYaw(frame.yaw), true);
  v.setInt16(8, quantisePitch(frame.pitch), true);
  return buffer;
}

export function decodeInput(buffer: ArrayBuffer, out: InputFrame): InputFrame | null {
  if (buffer.byteLength < INPUT_BYTES) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== MSG.INPUT) return null;
  out.seq = v.getUint16(1, true);
  out.buttons = v.getUint8(3);
  out.forward = dequantiseAxis(v.getInt8(4));
  out.right = dequantiseAxis(v.getInt8(5));
  out.yaw = dequantiseYaw(v.getUint16(6, true));
  out.pitch = dequantisePitch(v.getInt16(8, true));
  return out;
}

/**
 * Say hello. 5 bytes and a name:
 *
 *     u8   type = MSG.HELLO
 *     u16  protocol version
 *     u8   preferred colourway
 *     u8   name length **in bytes**
 *     ...  the name, UTF-8, at most `MAX_NAME_BYTES`
 *
 * The colourway is a *request* rather than a choice because two players who both
 * ask for red have to end up different -- telling combatants apart at fifteen
 * metres is the entire argument `player/character.ts` makes for having seven
 * kits at all, and a lobby where everyone picked the same one would throw that
 * away. 255 means "you decide", which is what the client actually sends.
 *
 * The **name is the same kind of request**, and for a stronger reason: the
 * server sanitises it again and may hand back something else entirely because
 * somebody is already called that. What a client learns its name actually is
 * from is the `ROSTER` that follows its `WELCOME`, never from what it sent.
 *
 * The version stays at a **fixed offset ahead of the variable part**, which is
 * the one layout decision in this record. A protocol-4 client sends a 4-byte
 * hello with no length prefix at all; this decoder still reads its version out
 * of bytes 1-2 and the server still refuses it by version with a `BYE` it can
 * print, rather than failing to parse and dropping it into a silent socket.
 */
export function encodeHello(colourway = 255, name = ''): ArrayBuffer {
  const bytes = NAME_ENCODER.encode(name);
  const n = Math.min(bytes.length, MAX_NAME_BYTES);
  const buffer = new ArrayBuffer(5 + n);
  const v = new DataView(buffer);
  v.setUint8(0, MSG.HELLO);
  v.setUint16(1, PROTOCOL_VERSION, true);
  v.setUint8(3, colourway);
  v.setUint8(4, n);
  new Uint8Array(buffer, 5).set(bytes.subarray(0, n));
  return buffer;
}

export function decodeHello(
  buffer: ArrayBuffer,
): { version: number; colourway: number; name: string } | null {
  if (buffer.byteLength < 4) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== MSG.HELLO) return null;
  let name = '';
  if (buffer.byteLength >= 5) {
    // Bounded by what actually arrived rather than by what the prefix claims: a
    // length byte that overruns the frame is the one thing a hostile hello can
    // cheaply say, and `TextDecoder` on an out-of-range view throws.
    const n = Math.min(v.getUint8(4), MAX_NAME_BYTES, buffer.byteLength - 5);
    if (n > 0) name = NAME_DECODER.decode(new Uint8Array(buffer, 5, n));
  }
  return { version: v.getUint16(1, true), colourway: v.getUint8(3), name };
}

/**
 * The clock sync. 15 bytes out, 21 back.
 *
 *     u8   type = MSG.PING
 *     u32  seq
 *     f64  clientTime, a `performance.now()` reading
 *     u16  the sender's own smoothed round trip, ms
 *
 * `clientTime` is echoed rather than remembered, so the client keeps no table of
 * outstanding pings and a reply that arrives after the client gave up costs
 * nothing. The f64 is a `performance.now()` reading and is the one place in this
 * protocol where a full double is worth its eight bytes: the whole point of the
 * exchange is to measure a few milliseconds, and quantising the measurement to
 * save six bytes twice a second would be measuring the quantiser.
 *
 * ---------------------------------------------------------------------------
 * `rttMs` is the **client's own measurement, reported**, and it is the one field
 * in this protocol that the server takes a client's word for. That is a choice
 * and it is bounded on purpose.
 *
 * The round trip is measured where it can be: the client sends `clientTime`, the
 * server echoes it, and the client subtracts. The server never sees both ends of
 * that -- it holds no outstanding-ping table (deliberately, see above) and the
 * client's ping timer is independent of the reply, so the arrival cadence tells
 * the server nothing about the trip. Adding a server-initiated round trip to
 * measure a number the client already has, twice a second per player, is a
 * message type and a timer for a **scoreboard column**.
 *
 * So the column is what the reporter measured, which is what a ping column is in
 * every game that has one. What matters is what it is *not* wired to: it does
 * **not** feed `Participant.viewTicks`. Spec 8.2's lag compensation rewinds by
 * half a round trip, so a client that could inflate this number would be buying
 * rewind -- claiming half a second to be granted spec 10's full 250 ms cap. The
 * server keeps its own `Conn.rtt` for that and this only ever reaches a `u16` in
 * the roster. Lying about it makes your own ping look bad.
 */
export const PING_BYTES = 15;

export function encodePing(seq: number, clientTime: number, rttMs = 0): ArrayBuffer {
  const buffer = new ArrayBuffer(PING_BYTES);
  const v = new DataView(buffer);
  v.setUint8(0, MSG.PING);
  v.setUint32(1, seq >>> 0, true);
  v.setFloat64(5, clientTime, true);
  v.setUint16(13, quantisePing(rttMs), true);
  return buffer;
}

export function decodePing(
  buffer: ArrayBuffer,
): { seq: number; clientTime: number; rttMs: number } | null {
  if (buffer.byteLength < 13) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== MSG.PING) return null;
  return {
    seq: v.getUint32(1, true),
    clientTime: v.getFloat64(5, true),
    rttMs: buffer.byteLength >= PING_BYTES ? v.getUint16(13, true) : 0,
  };
}

/**
 * Milliseconds to `u16`, clamped and rounded.
 *
 * Clamped rather than wrapped, on `quantiseVelocity`'s argument one field over: a
 * wrapped 66-second stall would be drawn as a 464 ms ping, which is a connection
 * that reads as playable in the one column that exists to say it is not. NaN --
 * which is what an `rtt` that has never had a sample would be if the exponential
 * average were seeded from one -- reads as zero rather than as 65535.
 */
export function quantisePing(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.min(65535, Math.round(ms)));
}

// --- Server -> client ---------------------------------------------------------

/**
 * The join reply, 24 bytes.
 *
 *     u8   type = MSG.WELCOME
 *     u16  protocol version
 *     u8   your id
 *     u8   your colourway
 *     u8   snapshot Hz
 *     u32  server tick
 *     i32  spawn x mm, y mm, z mm  (the eye, as `PlayerState.position` is)
 *     u16  spawn yaw
 *
 * The spawn is in here rather than left to the first snapshot because the client
 * has to place its own predicted body *before* it can predict anything, and a
 * player who spends the first 50 ms at the ENU origin is a player who spends it
 * falling through Alexandria.
 */
export const WELCOME_BYTES = 24;

export interface Welcome {
  version: number;
  id: number;
  colourway: number;
  snapshotHz: number;
  tick: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export function encodeWelcome(w: Welcome): ArrayBuffer {
  const buffer = new ArrayBuffer(WELCOME_BYTES);
  const v = new DataView(buffer);
  v.setUint8(0, MSG.WELCOME);
  v.setUint16(1, PROTOCOL_VERSION, true);
  v.setUint8(3, w.id);
  v.setUint8(4, w.colourway);
  v.setUint8(5, w.snapshotHz);
  v.setUint32(6, w.tick >>> 0, true);
  v.setInt32(10, quantisePos(w.x), true);
  v.setInt32(14, quantisePos(w.y), true);
  v.setInt32(18, quantisePos(w.z), true);
  v.setUint16(22, quantiseYaw(w.yaw), true);
  return buffer;
}

export function decodeWelcome(buffer: ArrayBuffer): Welcome | null {
  if (buffer.byteLength < WELCOME_BYTES) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== MSG.WELCOME) return null;
  return {
    version: v.getUint16(1, true),
    id: v.getUint8(3),
    colourway: v.getUint8(4),
    snapshotHz: v.getUint8(5),
    tick: v.getUint32(6, true),
    x: dequantisePos(v.getInt32(10, true)),
    y: dequantisePos(v.getInt32(14, true)),
    z: dequantisePos(v.getInt32(18, true)),
    yaw: dequantiseYaw(v.getUint16(22, true)),
  };
}

/**
 * What a snapshot says about one player, and what the animation byte is for.
 *
 * `anim` is not the combat phase. The phase machine has six states and the
 * character rig has nine things it can be doing, because the four locomotions --
 * idle, walk, run, jump -- are all `phase === 'idle'` and are distinguished by
 * speed and ground contact, which are two more floats than a snapshot wants to
 * carry per player. So the *server* resolves them once, into a byte, and every
 * client draws what it is told. That also settles a question the alternative
 * leaves open: whether a remote's gait comes from its own velocity or from a
 * difference of two interpolated positions, which are different answers at every
 * corner and at every knockback.
 */
export const ANIM = {
  IDLE: 0,
  WALK: 1,
  RUN: 2,
  JUMP: 3,
  WINDUP: 4,
  ACTIVE: 5,
  RECOVERY: 6,
  FLINCH: 7,
  KO: 8,
} as const;

/** `SnapshotPlayer.flags`. */
export const FLAG = {
  TRAINING: 1 << 0,
  FLAT_WHITE: 1 << 1,
  ON_GROUND: 1 << 2,
  /**
   * Inside the throw animation's window -- see `footyball.THROW_SECONDS`.
   *
   * A **flag** rather than a value of `anim`, and that is the one interesting
   * decision in this record. The obvious place for a throw is a tenth animation
   * byte, and it is wrong because `anim` is a single enum with a precedence
   * chain: a player who throws a ball while running or mid-swing would have to
   * lose one of the three, and the throw is a 340 ms overlay on the upper body
   * where the other two are the whole figure. A bit composes with every byte,
   * costs nothing -- it is in a field that had spare bits -- and lets the client
   * fire the throw as an overlay exactly as it fires a swing.
   *
   * It is sampled at the snapshot rate, so a client sees the rising edge within
   * 50 ms of the throw. That is comfortably inside the 340 ms window, and the
   * remotes it drives are drawn 100 ms in the past anyway, which is the same
   * clock the ball itself arrives on -- so the arm and the ball leaving it stay
   * in step.
   */
  THROWING: 1 << 3,
  /** Bits 4-5 hold the balls left in the bar, 0..3. */
  BALL_SHIFT: 4,
  /**
   * On a lime e-bike. Drives the remote's seated pose and its bike mesh.
   *
   * Bit **6**, over the ball charges rather than beside `THROWING`, because bits
   * 0-3 were full and 6-7 were the only two spare in the byte. That is the whole
   * cost of this feature on the snapshot: `PLAYER_BYTES` is still 21 and the
   * bandwidth arithmetic in this file's header is unchanged. A bike's *position*
   * is not here at all -- while it is being ridden it is exactly the rider's
   * position, which is already in this record, and while it is parked it does not
   * move and rides on `MSG.BIKES` instead.
   */
  RIDING: 1 << 6,
  /**
   * This player has found the tuning stall in Redfern, so their bike is 3x.
   *
   * On the wire mostly for **its owner**: it is what tells a reconnecting or
   * mid-session client that the unlock it thinks it has is real, and it is the
   * only path by which the flag can become true on the client at all -- the
   * client never sets it, the zone is evaluated on the server. Everyone else
   * decodes it and ignores it, which costs a bit that was already spare.
   */
  TUNED: 1 << 7,
  /**
   * Which bits of the packed byte are flags rather than ball charges.
   *
   * Stated once, because the encoder and the decoder both need it and a mask
   * that is right in one of them is a feature that half works: `0x0f` here --
   * which is what this was before bits 6 and 7 were used -- silently drops
   * `RIDING` on the wire, and the symptom is remote players pedalling along the
   * footpath in a running animation with no bike under them.
   */
  MASK: 0xcf,
} as const;

/** 21 bytes. See the header's bandwidth arithmetic. */
export const PLAYER_BYTES = 21;
/**
 * 18 bytes, against a player's 21.
 *
 *     u8   id                  wraps at 256; 0 is "no ball"
 *     u8   thrower             the combatant id, for "is this mine" and the audio
 *     i32  x, y, z             millimetres, as every position on this wire is
 *     i8   vx, vy, vz          half-metres a second
 *     u8   bounces             0..3
 *
 * **Why the velocity is on the wire at all**, when a player's is not: a ball
 * moves 1.4 m between snapshots where a sprinting player moves 0.4 m, so the two
 * ends of an interpolation are much further apart and the straight line between
 * them visibly cuts the corner of an arc. The velocity lets the renderer curve
 * it, lets a ball whose next snapshot is late be extrapolated rather than
 * frozen, and -- the one that is not about position at all -- gives the tumble
 * its axis, which is what makes a ball read as thrown rather than as sliding
 * sideways through the air.
 *
 * **And why it is only a byte an axis.** This is the coarsest field on the wire
 * by a long way and it is deliberate: unlike every other quantity here, the
 * ball's velocity is never integrated by anybody. The authoritative position
 * arrives 20 times a second and the receiver only ever uses the velocity to bend
 * a 50 ms interpolation and to point a mesh. A half-metre a second of error over
 * 50 ms is 2.5 cm -- under the 1 cm-per-axis the *positions* either side of it
 * are already rounded to, once you add the two. Spending an i16 to carry it to
 * the centimetre would be measuring the quantiser.
 *
 * The range is +/- 63.5 m/s, which no ball reaches: a launch is 28, and the
 * fastest a ball is ever moving is at the bottom of a long fall, where drag and
 * a three-bounce budget keep it under 45.
 *
 * **Why `bounces` is on the wire**, when it is not simulation state anybody
 * needs: it is how a client knows a bounce *happened*. The alternative is
 * watching for a sign change in the vertical velocity between two snapshots,
 * which at 20 Hz misses any bounce that starts and ends inside 50 ms -- which is
 * most of them. One byte buys the thud.
 */
export const BALL_BYTES = 18;
/**
 * One faction actor, 18 bytes -- the same as a football and three under a player.
 *
 *     u16  id            `factions.NpcActor.id`, 1..65535; 0 is "no actor"
 *     u8   kind          `factions.NPC_KIND`
 *     i32  x, y, z       millimetres, as every position on this wire is
 *     u16  yaw
 *     u8   state         `factions.NPC_STATE`
 *
 * **Everything about an actor that is not in this record is derived**, and that
 * is the whole design of the section. There is no health, no target, no
 * countdown and no speed: the client draws a body at a place in a state, and
 * every one of those four omissions is a decision.
 *
 *   - **Health** is not drawn. Spec 8.2 has no world-space health bars for
 *     players and an NPC does not get what a player does not.
 *   - **Target** would be the id an officer is chasing, and the only thing a
 *     renderer would do with it is aim the body -- which the yaw already does,
 *     authoritatively, and 0.0055 degrees more precisely than a target position
 *     re-derived on the far end.
 *   - **The countdown** is the investigation channel's, once, for the suspect,
 *     rather than repeated on every officer converging on them.
 *   - **Speed** is the client's own frame-to-frame difference of two
 *     interpolated positions, which is what `RemotePlayer.speed` already is.
 *
 * The `id` is a `u16` where a player's is a `u8`, and that is not symmetry for
 * its own sake: the roster is capped at sixteen and cannot wrap, where actors
 * are promoted and resolved continuously for the whole session -- a byte would
 * roll over every few minutes of a busy pursuit and put a fresh officer on the
 * interpolation history of one who despawned, which draws a body sliding across
 * the city.
 *
 * At `factions.MAX_ACTORS` the section is 432 B, which is 24 B over what the
 * sixteen players it sits beside cost. `verifyNet` asserts it against the 500 B
 * cap this feature was scoped with.
 */
export const NPC_BYTES = 18;
/** type + tick + ackSeq + player count + ball count + actor count. */
export const SNAPSHOT_HEADER_BYTES = 10;

/** i8 half-metres a second. See `BALL_BYTES` for why this is so coarse. */
const VELOCITY_SCALE = 2;

/** Metres a second to i8 half-metres a second, clamped rather than wrapped. */
export function quantiseVelocity(v: number): number {
  // A wrap here would reverse a ball's apparent direction of travel, which
  // points the tumble backwards and sends an extrapolation the wrong way. It is
  // unreachable at this range; clamping makes it unreachable by construction.
  if (!Number.isFinite(v)) return 0;
  return Math.max(-127, Math.min(127, Math.round(v * VELOCITY_SCALE)));
}

export function dequantiseVelocity(raw: number): number {
  return raw / VELOCITY_SCALE;
}

export interface SnapshotPlayer {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  anim: number;
  health: number;
  stamina: number;
  phase: number;
  flags: number;
  ballCharges: number;
}

/** One football in the air. See `BALL_BYTES` for the layout and the arguments. */
export interface SnapshotBall {
  id: number;
  thrower: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  bounces: number;
}

/** One faction actor in the world. See `NPC_BYTES` for the layout and the omissions. */
export interface SnapshotNpc {
  id: number;
  kind: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  state: number;
}

export interface Snapshot {
  tick: number;
  /** The last input seq the server applied **for the client this went to**. */
  ackSeq: number;
  players: SnapshotPlayer[];
  /**
   * Every ball in the air, everywhere, with no relevance culling -- on exactly
   * the argument `server/sim.ts` makes about players. A ball is in the air for
   * at most five seconds and the realistic count in a busy fight is a handful;
   * culling one that is about to arc into view is the pop the interpolation
   * buffer exists to prevent.
   */
  balls: SnapshotBall[];
  /**
   * Every promoted faction actor in the world -- police now, and whatever the
   * two factions behind them promote later.
   *
   * No relevance culling, on exactly the argument the players and the balls are
   * carried under, plus one that is specific to a pursuer: the actor a player
   * most needs to see is the one that has not arrived yet. Culling by distance
   * would hide precisely the officer rounding the corner. `factions.MAX_ACTORS`
   * is what bounds it instead, and it is a wire budget rather than a simulation
   * one for that reason.
   */
  npcs: SnapshotNpc[];
}

export function snapshotBytes(playerCount: number, ballCount = 0, npcCount = 0): number {
  return SNAPSHOT_HEADER_BYTES + playerCount * PLAYER_BYTES + ballCount * BALL_BYTES + npcCount * NPC_BYTES;
}

export function encodeSnapshot(
  tick: number,
  ackSeq: number,
  players: readonly SnapshotPlayer[],
  balls: readonly SnapshotBall[] = EMPTY_BALLS,
  npcs: readonly SnapshotNpc[] = EMPTY_NPCS,
): ArrayBuffer {
  const buffer = new ArrayBuffer(snapshotBytes(players.length, balls.length, npcs.length));
  const v = new DataView(buffer);
  v.setUint8(0, MSG.SNAPSHOT);
  v.setUint32(1, tick >>> 0, true);
  v.setUint16(5, ackSeq & 0xffff, true);
  v.setUint8(7, players.length);
  v.setUint8(8, balls.length);
  v.setUint8(9, npcs.length);
  let p = SNAPSHOT_HEADER_BYTES;
  for (const s of players) {
    v.setUint8(p, s.id);
    v.setInt32(p + 1, quantisePos(s.x), true);
    v.setInt32(p + 5, quantisePos(s.y), true);
    v.setInt32(p + 9, quantisePos(s.z), true);
    v.setUint16(p + 13, quantiseYaw(s.yaw), true);
    v.setInt16(p + 15, quantisePitch(s.pitch), true);
    v.setUint8(p + 17, s.anim);
    v.setUint8(p + 18, quantiseHealth(s.health));
    // Stamina is 0..4 and the phase is 0..5, so both fit in one byte with two
    // bits spare. Packed rather than given a byte each because at sixteen
    // players a byte is 160 bit/s of nothing.
    v.setUint8(p + 19, (s.stamina & 0x0f) | ((s.phase & 0x0f) << 4));
    v.setUint8(p + 20, (s.flags & FLAG.MASK) | ((s.ballCharges & 0x03) << FLAG.BALL_SHIFT));
    p += PLAYER_BYTES;
  }
  // The projectile section, after every player. Its own loop and its own record
  // rather than a variable-length tail on a player's, because a ball outlives
  // the tick its thrower left the game on -- a thrown ball is an object in the
  // world and not a property of a person.
  for (const b of balls) {
    v.setUint8(p, b.id);
    v.setUint8(p + 1, b.thrower);
    v.setInt32(p + 2, quantisePos(b.x), true);
    v.setInt32(p + 6, quantisePos(b.y), true);
    v.setInt32(p + 10, quantisePos(b.z), true);
    v.setInt8(p + 14, quantiseVelocity(b.vx));
    v.setInt8(p + 15, quantiseVelocity(b.vy));
    v.setInt8(p + 16, quantiseVelocity(b.vz));
    v.setUint8(p + 17, b.bounces & 0xff);
    p += BALL_BYTES;
  }
  // The faction section, after the projectiles, on the same argument the balls
  // sit after the players: an actor outlives the tick anybody in particular was
  // interested in it, and it is an object in the world rather than a property of
  // a person. Its own loop and its own record for the identical reason.
  for (const n of npcs) {
    v.setUint16(p, n.id & 0xffff, true);
    v.setUint8(p + 2, n.kind & 0xff);
    v.setInt32(p + 3, quantisePos(n.x), true);
    v.setInt32(p + 7, quantisePos(n.y), true);
    v.setInt32(p + 11, quantisePos(n.z), true);
    v.setUint16(p + 15, quantiseYaw(n.yaw), true);
    v.setUint8(p + 17, n.state & 0xff);
    p += NPC_BYTES;
  }
  return buffer;
}

const EMPTY_BALLS: readonly SnapshotBall[] = [];
const EMPTY_NPCS: readonly SnapshotNpc[] = [];

export function decodeSnapshot(buffer: ArrayBuffer, out: Snapshot): Snapshot | null {
  if (buffer.byteLength < SNAPSHOT_HEADER_BYTES) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== MSG.SNAPSHOT) return null;
  out.tick = v.getUint32(1, true);
  out.ackSeq = v.getUint16(5, true);
  const count = v.getUint8(7);
  const ballCount = v.getUint8(8);
  const npcCount = v.getUint8(9);
  if (buffer.byteLength < snapshotBytes(count, ballCount, npcCount)) return null;
  // The arrays are reused across snapshots and grown to their high-water mark,
  // on the terms `minimap.ts`'s marker pool is: a snapshot arrives twenty times
  // a second forever and a fresh array of fresh records each time is the most
  // allocated-per-second object in the client.
  out.players.length = count;
  let p = SNAPSHOT_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    let s = out.players[i];
    if (s === undefined) {
      s = { id: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, anim: 0, health: 0, stamina: 0, phase: 0, flags: 0, ballCharges: 0 };
      out.players[i] = s;
    }
    s.id = v.getUint8(p);
    s.x = dequantisePos(v.getInt32(p + 1, true));
    s.y = dequantisePos(v.getInt32(p + 5, true));
    s.z = dequantisePos(v.getInt32(p + 9, true));
    s.yaw = dequantiseYaw(v.getUint16(p + 13, true));
    s.pitch = dequantisePitch(v.getInt16(p + 15, true));
    s.anim = v.getUint8(p + 17);
    s.health = dequantiseHealth(v.getUint8(p + 18));
    const sp = v.getUint8(p + 19);
    s.stamina = sp & 0x0f;
    s.phase = (sp >> 4) & 0x0f;
    const fl = v.getUint8(p + 20);
    s.flags = fl & FLAG.MASK;
    s.ballCharges = (fl >> FLAG.BALL_SHIFT) & 0x03;
    p += PLAYER_BYTES;
  }
  out.balls.length = ballCount;
  for (let i = 0; i < ballCount; i++) {
    let b = out.balls[i];
    if (b === undefined) {
      b = { id: 0, thrower: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, bounces: 0 };
      out.balls[i] = b;
    }
    b.id = v.getUint8(p);
    b.thrower = v.getUint8(p + 1);
    b.x = dequantisePos(v.getInt32(p + 2, true));
    b.y = dequantisePos(v.getInt32(p + 6, true));
    b.z = dequantisePos(v.getInt32(p + 10, true));
    b.vx = dequantiseVelocity(v.getInt8(p + 14));
    b.vy = dequantiseVelocity(v.getInt8(p + 15));
    b.vz = dequantiseVelocity(v.getInt8(p + 16));
    b.bounces = v.getUint8(p + 17);
    p += BALL_BYTES;
  }
  out.npcs.length = npcCount;
  for (let i = 0; i < npcCount; i++) {
    let n = out.npcs[i];
    if (n === undefined) {
      n = { id: 0, kind: 0, x: 0, y: 0, z: 0, yaw: 0, state: 0 };
      out.npcs[i] = n;
    }
    n.id = v.getUint16(p, true);
    n.kind = v.getUint8(p + 2);
    n.x = dequantisePos(v.getInt32(p + 3, true));
    n.y = dequantisePos(v.getInt32(p + 7, true));
    n.z = dequantisePos(v.getInt32(p + 11, true));
    n.yaw = dequantiseYaw(v.getUint16(p + 15, true));
    n.state = v.getUint8(p + 17);
    p += NPC_BYTES;
  }
  return out;
}

export function createSnapshot(): Snapshot {
  return { tick: 0, ackSeq: 0, players: [], balls: [], npcs: [] };
}

// --- Events -------------------------------------------------------------------

/**
 * Things that happened, as opposed to things that are true.
 *
 * Separate from the snapshot rather than folded into it, and the separation is
 * the one spec 10 implies by listing snapshots and rewind as different concerns.
 * A snapshot is *state* and is idempotent -- miss one and the next is just as
 * good. An event is a *transition* and missing it means a punch with no sound
 * and a kill feed with a gap in it. So events are sent on the tick they happen
 * rather than at the snapshot rate, which also means a hit is heard 0 to 16 ms
 * after the server saw it instead of 0 to 50.
 *
 * The list got *shorter* when the ranged weapon became a football, and the
 * reason is worth keeping: a thrown ball is state, not a transition. It is in
 * every snapshot for its whole flight, so it needs no event to announce it --
 * see `EVENT` below, where 2 is a hole.
 *
 * They are unreliable in the sense that matters: nothing here is retransmitted,
 * because a punch sound 300 ms late is worse than no punch sound. The state they
 * imply arrives in the next snapshot regardless, which is what makes losing one
 * cosmetic.
 */
/**
 * **2 is retired and is deliberately not reused.**
 *
 * It was `LASER`, and it carried the two world points a beam was drawn between,
 * because a hitscan leaves nothing behind: if the event was lost, the shot never
 * happened on that client. A football does not need one. The ball is an object
 * in the snapshot stream for its whole flight, so the *thing itself* is the
 * message -- it arrives twenty times a second, a dropped snapshot is covered by
 * the next, and a client that joined mid-flight sees the ball already in the
 * air. Deleting the event took 27 bytes a throw off the wire and a whole class
 * of "the beam did not appear" with it.
 *
 * The number is left as a hole rather than closed up because `decodeEvents` is
 * driven by a length table and steps past kinds it does not know: renumbering
 * would have been churn in five files to save a gap nobody can see.
 */
export const EVENT = {
  HIT: 1,
  PICKUP: 3,
  JOIN: 4,
  LEAVE: 5,
} as const;

export const EVENT_FLAG = {
  KO: 1 << 0,
  /** The hit came from a thrown ball rather than the bat. Decides the sound and the feed verb. */
  FOOTY: 1 << 1,
};

export interface HitEvent {
  kind: 1;
  attacker: number;
  victim: number;
  flags: number;
  health: number;
}

export interface PickupEventFrame {
  kind: 3;
  combatant: number;
  /** Spec 8.3's kind byte: 0 Training, 1 Flat White. */
  powerup: number;
  /** The tile the point came in on, and its index in that tile's sidecar. */
  tileX: number;
  tileZ: number;
  index: number;
}

export interface JoinEvent {
  kind: 4 | 5;
  id: number;
  colourway: number;
  /** Non-zero for a server bot. The kill feed says so. */
  bot: number;
}

export type NetEvent = HitEvent | PickupEventFrame | JoinEvent;

/**
 * A batch of events, `u8 type`, `u8 count`, then each event's own bytes.
 *
 * Every record starts with its kind so the decoder can step past one it does not
 * know -- which is what lets a new event type be added without a protocol bump
 * for clients that do not care about it. That is why each kind's length is a
 * constant here rather than implied by the parse.
 */
const EVENT_BYTES: Record<number, number> = {
  [EVENT.HIT]: 5,
  [EVENT.PICKUP]: 9,
  [EVENT.JOIN]: 4,
  [EVENT.LEAVE]: 4,
};

export function encodeEvents(events: readonly NetEvent[]): ArrayBuffer {
  let total = 2;
  for (const e of events) total += EVENT_BYTES[e.kind] ?? 0;
  const buffer = new ArrayBuffer(total);
  const v = new DataView(buffer);
  v.setUint8(0, MSG.EVENTS);
  v.setUint8(1, events.length);
  let p = 2;
  for (const e of events) {
    v.setUint8(p, e.kind);
    if (e.kind === EVENT.HIT) {
      v.setUint8(p + 1, e.attacker);
      v.setUint8(p + 2, e.victim);
      v.setUint8(p + 3, e.flags);
      v.setUint8(p + 4, quantiseHealth(e.health));
    } else if (e.kind === EVENT.PICKUP) {
      v.setUint8(p + 1, e.combatant);
      v.setUint8(p + 2, e.powerup);
      v.setInt16(p + 3, e.tileX, true);
      v.setInt16(p + 5, e.tileZ, true);
      v.setUint16(p + 7, e.index, true);
    } else {
      v.setUint8(p + 1, e.id);
      v.setUint8(p + 2, e.colourway);
      v.setUint8(p + 3, e.bot);
    }
    p += EVENT_BYTES[e.kind];
  }
  return buffer;
}

export function decodeEvents(buffer: ArrayBuffer): NetEvent[] | null {
  if (buffer.byteLength < 2) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== MSG.EVENTS) return null;
  const count = v.getUint8(1);
  const out: NetEvent[] = [];
  let p = 2;
  for (let i = 0; i < count; i++) {
    if (p >= buffer.byteLength) break;
    const kind = v.getUint8(p);
    const size = EVENT_BYTES[kind];
    // An unknown kind has no length, so the batch cannot be stepped past it and
    // the rest is dropped. That is the correct failure: a decoder that guessed
    // would resynchronise on the middle of a record.
    if (size === undefined || p + size > buffer.byteLength) break;
    if (kind === EVENT.HIT) {
      out.push({
        kind: EVENT.HIT,
        attacker: v.getUint8(p + 1),
        victim: v.getUint8(p + 2),
        flags: v.getUint8(p + 3),
        health: dequantiseHealth(v.getUint8(p + 4)),
      });
    } else if (kind === EVENT.PICKUP) {
      out.push({
        kind: EVENT.PICKUP,
        combatant: v.getUint8(p + 1),
        powerup: v.getUint8(p + 2),
        tileX: v.getInt16(p + 3, true),
        tileZ: v.getInt16(p + 5, true),
        index: v.getUint16(p + 7, true),
      });
    } else {
      out.push({
        kind: kind as 4 | 5,
        id: v.getUint8(p + 1),
        colourway: v.getUint8(p + 2),
        bot: v.getUint8(p + 3),
      });
    }
    p += size;
  }
  return out;
}

// --- Powerup state ------------------------------------------------------------

/**
 * Which of spec 8.3's points are down and for how long, sent once at join.
 *
 * A joiner needs it and nobody else does: from then on a `PICKUP` event is
 * enough, because the client knows `powerups.respawnSeconds` and can run the
 * same clock the server is running. That is the whole reason this message is not
 * periodic -- the respawn is *deterministic* given the pickup, so re-sending it
 * would be re-sending something both ends already computed.
 *
 * Points are addressed by tile and sidecar index rather than by a server-side
 * id, because that pair is what `PowerupField` already keys on: the id string
 * `"<tx>_<tz>:<i>"` is built the same way in the same order on both ends from
 * the same file, so no roster has to be exchanged and no mapping can drift.
 *
 *     u8   type = MSG.POWERUPS
 *     u16  count
 *     per point: i16 tileX, i16 tileZ, u16 index, u16 respawn in tenths of a second
 */
export interface PowerupDown {
  tileX: number;
  tileZ: number;
  index: number;
  /** Seconds until it comes back. */
  respawnT: number;
}

export function encodePowerups(down: readonly PowerupDown[]): ArrayBuffer {
  const buffer = new ArrayBuffer(3 + down.length * 8);
  const v = new DataView(buffer);
  v.setUint8(0, MSG.POWERUPS);
  v.setUint16(1, down.length, true);
  let p = 3;
  for (const d of down) {
    v.setInt16(p, d.tileX, true);
    v.setInt16(p + 2, d.tileZ, true);
    v.setUint16(p + 4, d.index, true);
    // Tenths of a second: the longest respawn is 90 s, so a u16 of tenths has
    // three orders of magnitude of headroom and the resolution is six frames --
    // which for a clock a player reads as "about a minute" is exact enough.
    v.setUint16(p + 6, Math.max(0, Math.min(65535, Math.round(d.respawnT * 10))), true);
    p += 8;
  }
  return buffer;
}

export function decodePowerups(buffer: ArrayBuffer): PowerupDown[] | null {
  if (buffer.byteLength < 3) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== MSG.POWERUPS) return null;
  const count = v.getUint16(1, true);
  const out: PowerupDown[] = [];
  let p = 3;
  for (let i = 0; i < count && p + 8 <= buffer.byteLength; i++) {
    out.push({
      tileX: v.getInt16(p, true),
      tileZ: v.getInt16(p + 2, true),
      index: v.getUint16(p + 4, true),
      respawnT: v.getUint16(p + 6, true) / 10,
    });
    p += 8;
  }
  return out;
}

// --- Bike state ---------------------------------------------------------------

/**
 * Where the lime e-bikes are and who is on them.
 *
 *     u8   type = MSG.BIKES
 *     u16  count
 *     per bike:
 *       u16  id            `game/bikes.bikePlan`'s, 1..n; 0 is "no bike"
 *       u8   rider         the combatant id, or 0 for one on its kickstand
 *       i32  x, y, z       millimetres, as every position on this wire is
 *       u16  yaw
 *
 * **Upsert semantics, not a replacement.** The receiver merges by id and leaves
 * everything it is not told about alone, which is what lets one message shape
 * serve both jobs: the full set at join, and a single 15-byte record when
 * somebody mounts. There is no "delete" because a bike is never removed -- the
 * set is fixed by `bikePlan` for the life of a build.
 *
 * **Why the positions are on the wire at all** when the plan is deterministic.
 * `bikePlan` fixes the *set* and the *ids* from `index.json` alone, and both ends
 * really do agree on those. What it does not fix is the placement: snapping a
 * planned point to the ground and out of a building consults the collision
 * prisms, and a browser holding 420 m of city has fewer of them than a server
 * holding all of it, so a building straddling a tile seam can nudge the two ends
 * to different spots. The failure that produces is the worst kind available
 * here -- a bike you can see and cannot mount, because the server does not think
 * it is there -- and it costs about a kilobyte once per join to make it
 * unreachable. A dropped bike needs the position on the wire regardless: where a
 * rider was batted off is not derivable from anything.
 *
 * At the inner ring's ~74 bikes the join message is 1,261 B, which is smaller
 * than four snapshots and is paid once.
 */
export interface BikeRecord {
  id: number;
  /** The combatant riding it, or 0. */
  rider: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export const BIKE_HEADER_BYTES = 3;
/** 2 + 1 + 4 + 4 + 4 + 2. Asserted in `verifyNet`, which is how it got right. */
export const BIKE_RECORD_BYTES = 17;

export function bikesBytes(count: number): number {
  return BIKE_HEADER_BYTES + count * BIKE_RECORD_BYTES;
}

export function encodeBikes(bikes: readonly BikeRecord[]): ArrayBuffer {
  const buffer = new ArrayBuffer(bikesBytes(bikes.length));
  const v = new DataView(buffer);
  v.setUint8(0, MSG.BIKES);
  v.setUint16(1, bikes.length, true);
  let p = BIKE_HEADER_BYTES;
  for (const b of bikes) {
    v.setUint16(p, b.id & 0xffff, true);
    v.setUint8(p + 2, b.rider & 0xff);
    v.setInt32(p + 3, quantisePos(b.x), true);
    v.setInt32(p + 7, quantisePos(b.y), true);
    v.setInt32(p + 11, quantisePos(b.z), true);
    v.setUint16(p + 15, quantiseYaw(b.yaw), true);
    p += BIKE_RECORD_BYTES;
  }
  return buffer;
}

export function decodeBikes(buffer: ArrayBuffer): BikeRecord[] | null {
  if (buffer.byteLength < BIKE_HEADER_BYTES) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== MSG.BIKES) return null;
  const count = v.getUint16(1, true);
  const out: BikeRecord[] = [];
  let p = BIKE_HEADER_BYTES;
  // Bounded by what arrived rather than by what the count claims, on
  // `decodeRoster`'s argument: a `DataView` read past the end throws, and a throw
  // inside a socket callback takes the client's whole message pump with it.
  for (let i = 0; i < count && p + BIKE_RECORD_BYTES <= buffer.byteLength; i++) {
    out.push({
      id: v.getUint16(p, true),
      rider: v.getUint8(p + 2),
      x: dequantisePos(v.getInt32(p + 3, true)),
      y: dequantisePos(v.getInt32(p + 7, true)),
      z: dequantisePos(v.getInt32(p + 11, true)),
      yaw: dequantiseYaw(v.getUint16(p + 15, true)),
    });
    p += BIKE_RECORD_BYTES;
  }
  return out;
}

// --- Investigations -------------------------------------------------------------

/**
 * Who the police are after, and for how much longer.
 *
 *     u8   type = MSG.INVESTIGATION
 *     u8   count
 *     per entry:
 *       u8   player id
 *       u8   reason code       `factions.REASON`
 *       u16  remaining ticks   60 Hz, so 65535 is 18 minutes
 *
 * **A replacement, not an upsert**, which is the opposite of `MSG.BIKES` one
 * section up and is the right call for the opposite reason. A bike is one of
 * seventy-four things that mostly do not change, so telling a client about the
 * one that did is cheap and complete. An investigation is one of *at most
 * sixteen* things that all end -- and the end is the interesting event. Upsert
 * semantics would need a delete record for it, and a delete that went missing is
 * a banner that never comes down, on a player who is no longer being shot at.
 * Four bytes an entry means the full set at sixteen players is 34 bytes; sending
 * it whole makes "nobody is wanted" an empty message rather than a thing that
 * has to be inferred.
 *
 * **The countdown is sent, not counted.** A client could run its own clock down
 * from one message -- both ends know the tick rate -- and it deliberately does
 * *both*: `net/client.ts` decrements between messages so the banner's seconds
 * move every frame, and takes the server's number whenever one arrives. That is
 * the same arrangement the powerup respawns already have, and it is what lets
 * this message ride the roster's slow refresh instead of the snapshot rate.
 *
 * The reason is a **byte, not a string**. The strings live in
 * `game/factions.REASON_TEXT` in the file both ends import, on this file's own
 * founding argument about encoders and decoders: a banner whose wording arrived
 * over the wire would be a banner that a server could write anything into, and
 * `verifyPolice` could not assert that every reason has one.
 */
export interface InvestigationRecord {
  playerId: number;
  reason: number;
  ticks: number;
}

export const INVESTIGATION_HEADER_BYTES = 2;
export const INVESTIGATION_ENTRY_BYTES = 4;

export function investigationBytes(count: number): number {
  return INVESTIGATION_HEADER_BYTES + count * INVESTIGATION_ENTRY_BYTES;
}

export function encodeInvestigations(records: readonly InvestigationRecord[]): ArrayBuffer {
  const buffer = new ArrayBuffer(investigationBytes(records.length));
  const v = new DataView(buffer);
  v.setUint8(0, MSG.INVESTIGATION);
  v.setUint8(1, Math.min(records.length, 255));
  let p = INVESTIGATION_HEADER_BYTES;
  for (const r of records) {
    v.setUint8(p, r.playerId & 0xff);
    v.setUint8(p + 1, r.reason & 0xff);
    // Clamped rather than wrapped, on `quantisePing`'s argument: a wrapped
    // countdown would draw eighteen minutes of pursuit as one second left, which
    // is the one number in this message a player is actually reading.
    v.setUint16(p + 2, Math.max(0, Math.min(65535, Math.round(r.ticks))), true);
    p += INVESTIGATION_ENTRY_BYTES;
  }
  return buffer;
}

export function decodeInvestigations(buffer: ArrayBuffer): InvestigationRecord[] | null {
  if (buffer.byteLength < INVESTIGATION_HEADER_BYTES) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== MSG.INVESTIGATION) return null;
  const count = v.getUint8(1);
  const out: InvestigationRecord[] = [];
  let p = INVESTIGATION_HEADER_BYTES;
  // Bounded by what arrived rather than by what the count claims, which is
  // `decodeBikes`' rule and the reason it exists: a `DataView` read past the end
  // throws, and a throw inside a socket callback takes the client's whole
  // message pump with it.
  for (let i = 0; i < count && p + INVESTIGATION_ENTRY_BYTES <= buffer.byteLength; i++) {
    out.push({
      playerId: v.getUint8(p),
      reason: v.getUint8(p + 1),
      ticks: v.getUint16(p + 2, true),
    });
    p += INVESTIGATION_ENTRY_BYTES;
  }
  return out;
}

// --- The roster ---------------------------------------------------------------

/**
 * Who is here, what they are called, and how they are doing.
 *
 *     u8   type = MSG.ROSTER
 *     u8   count
 *     per entry:
 *       u8   id
 *       u8   colourway
 *       u8   flags            bit 0: a server bot
 *       u16  KOs
 *       u16  downs
 *       u16  ping, ms         0 for a bot, which has no socket
 *       u8   name length in bytes
 *       ...  the name, UTF-8
 *
 * **A reliable event rather than a section of the snapshot**, and that is the
 * whole design of this message. A name is 25 bytes at the cap, so carrying the
 * roster on every snapshot would be 400 B twenty times a second at sixteen
 * players -- 64 kbit/s, more than the entire rest of the stream -- to re-send a
 * string that changes when somebody joins. The scores are the same shape of
 * fact: a KO is a few times a minute, against a position that is different every
 * tick. So this goes out **on change** (a join, a departure, a knockout) and on
 * a slow refresh for the ping column alone, which is the one field here that
 * moves continuously and the one nobody reads to the millisecond.
 *
 * At sixteen players a refresh is 402 B; at the two-second cadence the server
 * uses that is 1.6 kbit/s, or about 3% of what the snapshots cost at the same
 * count. At the six players this build is actually played at it is 0.6.
 *
 * The scoreboard is **per session and is not persisted** -- spec 10 has no
 * storage in it and this adds none. A player who reconnects is a new id with a
 * fresh row, which is the honest behaviour for a game with no accounts.
 */
export interface RosterEntry {
  id: number;
  colourway: number;
  bot: boolean;
  name: string;
  /** Knockouts credited to this player. */
  kos: number;
  /** Times this player was knocked out. */
  downs: number;
  /** Round trip in ms, as reported by that client. 0 for a bot. See `encodePing`. */
  ping: number;
}

export const ROSTER_HEADER_BYTES = 2;
/** Everything in an entry except the name itself. */
export const ROSTER_ENTRY_BYTES = 10;

export function rosterBytes(entries: readonly RosterEntry[]): number {
  let total = ROSTER_HEADER_BYTES;
  for (const e of entries) {
    total += ROSTER_ENTRY_BYTES + Math.min(NAME_ENCODER.encode(e.name).length, MAX_NAME_BYTES);
  }
  return total;
}

export function encodeRoster(entries: readonly RosterEntry[]): ArrayBuffer {
  const buffer = new ArrayBuffer(rosterBytes(entries));
  const v = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  v.setUint8(0, MSG.ROSTER);
  v.setUint8(1, Math.min(entries.length, 255));
  let p = ROSTER_HEADER_BYTES;
  for (const e of entries) {
    const name = NAME_ENCODER.encode(e.name).subarray(0, MAX_NAME_BYTES);
    v.setUint8(p, e.id);
    v.setUint8(p + 1, e.colourway);
    v.setUint8(p + 2, e.bot ? 1 : 0);
    v.setUint16(p + 3, Math.max(0, Math.min(65535, e.kos)), true);
    v.setUint16(p + 5, Math.max(0, Math.min(65535, e.downs)), true);
    v.setUint16(p + 7, quantisePing(e.ping), true);
    v.setUint8(p + 9, name.length);
    bytes.set(name, p + ROSTER_ENTRY_BYTES);
    p += ROSTER_ENTRY_BYTES + name.length;
  }
  return buffer;
}

export function decodeRoster(buffer: ArrayBuffer): RosterEntry[] | null {
  if (buffer.byteLength < ROSTER_HEADER_BYTES) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== MSG.ROSTER) return null;
  const count = v.getUint8(1);
  const out: RosterEntry[] = [];
  let p = ROSTER_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    // A truncated tail drops the rest rather than reading past the end, which
    // `DataView` throws on -- and a throw inside a socket callback takes the
    // whole client's message pump with it. `decodeEvents` refuses the same way.
    if (p + ROSTER_ENTRY_BYTES > buffer.byteLength) break;
    const nameLen = v.getUint8(p + 9);
    if (p + ROSTER_ENTRY_BYTES + nameLen > buffer.byteLength) break;
    out.push({
      id: v.getUint8(p),
      colourway: v.getUint8(p + 1),
      bot: (v.getUint8(p + 2) & 1) !== 0,
      kos: v.getUint16(p + 3, true),
      downs: v.getUint16(p + 5, true),
      ping: v.getUint16(p + 7, true),
      name: nameLen > 0 ? NAME_DECODER.decode(new Uint8Array(buffer, p + ROSTER_ENTRY_BYTES, nameLen)) : '',
    });
    p += ROSTER_ENTRY_BYTES + nameLen;
  }
  return out;
}

/**
 * The leaderboard's order: knockouts down, then downs up, then name.
 *
 * Here rather than in the HUD because the integration check has to assert it and
 * `hud.ts` cannot be imported outside a browser -- and because an order is a
 * property of the record, not of the panel that happens to draw it.
 *
 * The third key is what makes it an *order* rather than a suggestion. Two
 * players who have not done anything yet are 0/0, and `Array.prototype.sort` is
 * only stable with respect to the array it was handed -- which here is a `Map`'s
 * iteration order on one end and a decode order on the other. Without a
 * tiebreak the rows would swap places between refreshes while the player was
 * reading them, which is the sort of thing that looks like a rendering bug.
 * Sorts a copy, because the caller's array is usually the live roster.
 */
export function rankRoster(entries: readonly RosterEntry[]): RosterEntry[] {
  return [...entries].sort(
    (a, b) => b.kos - a.kos || a.downs - b.downs || a.name.localeCompare(b.name) || a.id - b.id,
  );
}

// --- Pong and bye -------------------------------------------------------------

export function encodePong(seq: number, clientTime: number, serverTime: number): ArrayBuffer {
  const buffer = new ArrayBuffer(21);
  const v = new DataView(buffer);
  v.setUint8(0, MSG.PONG);
  v.setUint32(1, seq >>> 0, true);
  v.setFloat64(5, clientTime, true);
  v.setFloat64(13, serverTime, true);
  return buffer;
}

export function decodePong(
  buffer: ArrayBuffer,
): { seq: number; clientTime: number; serverTime: number } | null {
  if (buffer.byteLength < 21) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== MSG.PONG) return null;
  return {
    seq: v.getUint32(1, true),
    clientTime: v.getFloat64(5, true),
    serverTime: v.getFloat64(13, true),
  };
}

/** A refusal the client can print. Version mismatch, or a full server. */
export function encodeBye(reason: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(reason.slice(0, 200));
  const buffer = new ArrayBuffer(2 + bytes.length);
  const v = new DataView(buffer);
  v.setUint8(0, MSG.BYE);
  v.setUint8(1, bytes.length);
  new Uint8Array(buffer, 2).set(bytes);
  return buffer;
}

export function decodeBye(buffer: ArrayBuffer): string | null {
  if (buffer.byteLength < 2) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== MSG.BYE) return null;
  const n = v.getUint8(1);
  return new TextDecoder().decode(new Uint8Array(buffer, 2, Math.min(n, buffer.byteLength - 2)));
}

/** The first byte of a frame, or -1 if there is no frame. */
export function frameType(buffer: ArrayBuffer): number {
  return buffer.byteLength > 0 ? new DataView(buffer).getUint8(0) : -1;
}

// --- A WebSocket that satisfies `NetTransport` --------------------------------

/**
 * The transport this build actually uses. See the header for why it is not
 * WebTransport and what swapping it costs.
 *
 * `binaryType = 'arraybuffer'` is the whole of the browser-side configuration
 * and it is not optional: the default is `Blob`, which delivers every frame as
 * an object that has to be read back asynchronously, so a snapshot would arrive
 * a microtask after it was received and in an order the socket does not
 * guarantee. That failure looks like jitter.
 */
export class WebSocketTransport implements NetTransport {
  private socket: WebSocket | null = null;
  onframe: ((frame: ArrayBuffer) => void) | null = null;
  onopen: (() => void) | null = null;
  onclose: ((reason: string) => void) | null = null;

  constructor(url: string) {
    try {
      const socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => this.onopen?.();
      socket.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) this.onframe?.(e.data);
      };
      socket.onclose = (e) => this.onclose?.(e.reason || `closed (${e.code})`);
      // `onerror` carries no detail by design -- the spec hides it to avoid
      // leaking whether a host exists. `onclose` always follows, so the reason
      // the player sees comes from there and this only records that it was not a
      // clean shutdown.
      socket.onerror = () => {};
      this.socket = socket;
    } catch (err) {
      // A malformed URL throws synchronously from the constructor, which would
      // otherwise take the whole client boot with it.
      queueMicrotask(() => this.onclose?.(String(err)));
    }
  }

  get open(): boolean {
    return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
  }

  send(frame: ArrayBuffer): void {
    if (this.open) this.socket!.send(frame);
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
  }
}

// --- The self-check -----------------------------------------------------------

/**
 * Spec 10's quantisation and this file's layouts, asserted.
 *
 * Every failure this catches is silent in the repo's sense: the game runs, the
 * players move, and everybody is simply somewhere slightly wrong -- which is
 * indistinguishable from lag and is therefore the most expensive class of bug in
 * a netcode to find by playing. Specifically:
 *
 *   - A **quantiser off by a factor** puts remote players at a fraction of their
 *     real distance from the origin. At 1/10 scale a fight in Alexandria is
 *     drawn in the harbour and nothing throws.
 *   - A **yaw that does not wrap** puts a player facing backwards for half of
 *     every turn, which reads as the animation being wrong.
 *   - An **encode/decode mismatch of one byte** shifts every field after it, so
 *     health becomes a phase and a phase becomes flags. The symptom is players
 *     who occasionally play a knockout animation while walking.
 *   - A **sequence wrap** at 65536 is 18 minutes into a session, at which point
 *     reconciliation would either replay eighteen minutes of input or none.
 *
 * Run standalone:
 *
 *     bun -e "import {verifyNet} from './client/src/net/protocol.ts';
 *             console.log(verifyNet())"
 */
export function verifyNet(): string[] {
  const failures: string[] = [];

  // --- Position: 1 cm, spec 10's own tolerance, over the whole extent and past
  // it. 20,000 m is well outside the 15 km middle ring and must still be exact.
  for (const m of [0, 0.01, -0.01, 1.234, -1.234, 4000, -4000, 20000.005, -20000.005]) {
    const back = dequantisePos(quantisePos(m));
    if (Math.abs(back - m) > 0.001) {
      failures.push(`Position ${m} m round-tripped to ${back} m; the wire is millimetres.`);
    }
  }

  // --- Yaw: 0.006 rad, and it must wrap rather than clamp.
  for (const yaw of [0, 0.5, Math.PI, -Math.PI, TAU - 0.001, -7.3, 12.9]) {
    const back = dequantiseYaw(quantiseYaw(yaw));
    const wrapped = ((yaw % TAU) + TAU) % TAU;
    // The seam at 0/2pi rounds to the far end of the field, which is the same
    // angle. Compare as angles rather than as numbers.
    const err = Math.abs(Math.atan2(Math.sin(back - wrapped), Math.cos(back - wrapped)));
    if (err > 0.006) {
      failures.push(`Yaw ${yaw.toFixed(3)} round-tripped to ${back.toFixed(4)} (${err.toFixed(5)} rad out).`);
    }
  }

  // --- Pitch: the same tolerance, over the controller's clamp.
  for (const pitch of [0, 0.5, -0.5, 1.55, -1.55]) {
    const back = dequantisePitch(quantisePitch(pitch));
    if (Math.abs(back - pitch) > 0.006) {
      failures.push(`Pitch ${pitch} round-tripped to ${back.toFixed(4)}.`);
    }
  }

  // --- Health: 1/64 of a pip, over spec 8.3's real values.
  for (const h of [0, 0.6, 1, 1.6, 2.8, 3]) {
    const back = dequantiseHealth(quantiseHealth(h));
    if (Math.abs(back - h) > 1 / 64) failures.push(`Health ${h} round-tripped to ${back}.`);
  }

  // --- Velocity: half a metre a second, over the whole range a thrown ball
  // reaches, and clamped rather than wrapped past it.
  //
  // The extremes matter more here than the middle. A launch is 28 m/s and the
  // fastest a ball ever moves is about 45, so the tested band is inside the
  // field -- what a failure at 500 would mean is a quantiser that *wraps*, and a
  // wrapped velocity is a ball whose tumble spins backwards and whose
  // extrapolation flies off in the opposite direction to its travel.
  for (const mps of [0, 0.5, -0.5, 28, -28, 45, -45, 63.5, -63.5, 500, -500]) {
    const back = dequantiseVelocity(quantiseVelocity(mps));
    const want = Math.max(-63.5, Math.min(63.5, mps));
    if (Math.abs(back - want) > 0.25) {
      failures.push(
        `Velocity ${mps} m/s round-tripped to ${back} m/s; the wire is half-metres a second, ` +
          `clamped to +/- 63.5.`,
      );
    }
  }
  if (dequantiseVelocity(quantiseVelocity(NaN)) !== 0) {
    failures.push('A NaN velocity did not quantise to zero. A NaN on this field is a ball that never dies.');
  }

  // --- Input: encode, decode, and the seq wrap at 65536.
  {
    const scratch: InputFrame = { seq: 0, buttons: 0, forward: 0, right: 0, yaw: 0, pitch: 0 };
    const cases: InputFrame[] = [
      { seq: 0, buttons: 0, forward: 0, right: 0, yaw: 0, pitch: 0 },
      { seq: 65535, buttons: BTN.PUNCH | BTN.SPRINT, forward: 1, right: -1, yaw: 3.1, pitch: -1.2 },
      { seq: 65536, buttons: BTN.THROW | BTN.JUMP, forward: -1, right: 1, yaw: 6.2, pitch: 1.4 },
      { seq: 70000, buttons: 0x0f, forward: 0.5, right: -0.5, yaw: 0.001, pitch: 0 },
      // v6's mount bit, alongside every other button. It is bit 4, so a decoder
      // still masking the byte to `0x0f` -- which is what the set was before
      // this -- drops it and `E` silently does nothing online while working
      // perfectly offline, which is the most annoying shape a netcode bug has.
      { seq: 1, buttons: BTN.MOUNT, forward: 0, right: 0, yaw: 1, pitch: 0 },
      { seq: 2, buttons: BTN.PUNCH | BTN.THROW | BTN.JUMP | BTN.SPRINT | BTN.MOUNT, forward: 1, right: 1, yaw: 2, pitch: 0.5 },
    ];
    for (const c of cases) {
      const got = decodeInput(encodeInput(c), scratch);
      if (!got) {
        failures.push(`An input frame with seq ${c.seq} would not decode.`);
        continue;
      }
      if (got.seq !== (c.seq & 0xffff)) {
        failures.push(`Input seq ${c.seq} came back as ${got.seq}; it must wrap at 65536.`);
      }
      if (got.buttons !== c.buttons) failures.push(`Input buttons ${c.buttons} came back as ${got.buttons}.`);
      if (Math.abs(got.forward - c.forward) > 0.01 || Math.abs(got.right - c.right) > 0.01) {
        failures.push(`Input movement (${c.forward}, ${c.right}) came back as (${got.forward}, ${got.right}).`);
      }
    }
    if (encodeInput(cases[0]).byteLength !== INPUT_BYTES) {
      failures.push(`An input frame is ${encodeInput(cases[0]).byteLength} bytes, not ${INPUT_BYTES}.`);
    }
  }

  // --- A four-player snapshot: encode -> decode is the identity, field for
  // field, at the tolerances above. This is the one that catches a layout that
  // is one byte out.
  {
    const players: SnapshotPlayer[] = [
      { id: 0, x: -1234.56, y: 42.5, z: 987.65, yaw: 2.5, pitch: -0.4, anim: ANIM.RUN, health: 3, stamina: 4, phase: 0, flags: FLAG.ON_GROUND, ballCharges: 3 },
      { id: 7, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, anim: ANIM.IDLE, health: 0.6, stamina: 0, phase: 5, flags: FLAG.TRAINING | FLAG.FLAT_WHITE, ballCharges: 0 },
      { id: 15, x: 3999.99, y: -70.125, z: -3999.99, yaw: 6.28, pitch: 1.5, anim: ANIM.KO, health: 0, stamina: 2, phase: 4, flags: FLAG.THROWING, ballCharges: 2 },
      // A rider, tuned, with a ball still in the bar. This one is here for the
      // packed byte's sake: `RIDING` and `TUNED` are bits 6 and 7 of the same
      // byte the ball charges sit in the middle of, so a mask that is still
      // `0x0f` drops both of them here and nowhere else in this array.
      { id: 200, x: 12.3, y: 4.5, z: -67.8, yaw: 1, pitch: -1, anim: ANIM.WINDUP, health: 1.6, stamina: 3, phase: 1, flags: FLAG.ON_GROUND | FLAG.RIDING | FLAG.TUNED, ballCharges: 1 },
    ];
    // Three balls with the section's own extremes in them: a fast one climbing,
    // one that has bounced its whole budget, and one at the origin with a zero
    // velocity -- which is the record a settling ball produces and the one a
    // sign error in the velocity field shows up on.
    const balls: SnapshotBall[] = [
      { id: 1, thrower: 7, x: -1234.56, y: 43.25, z: 987.65, vx: 18.5, vy: 9, vz: -12.5, bounces: 0 },
      { id: 255, thrower: 200, x: 3999.99, y: -70.125, z: -3999.99, vx: -4.5, vy: -0.5, vz: 3, bounces: 3 },
      { id: 42, thrower: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, bounces: 1 },
    ];
    // Two faction actors with the section's own extremes: a `u16` id at the top
    // of its range, which is the field a byte-wide id would have wrapped, and a
    // kind byte from a faction that does not exist yet -- because a client has
    // to carry an actor whose kind it cannot draw rather than desynchronising
    // the record after it.
    const npcs: SnapshotNpc[] = [
      { id: 1, kind: 1, x: -1234.56, y: 42.5, z: 987.65, yaw: 2.5, state: 3 },
      { id: 65535, kind: 4, x: 3999.99, y: -70.125, z: -3999.99, yaw: 6.28, state: 6 },
    ];
    const bytes = encodeSnapshot(123456, 65530, players, balls, npcs);
    if (bytes.byteLength !== snapshotBytes(4, 3, 2)) {
      failures.push(
        `A 4-player 3-ball 2-actor snapshot is ${bytes.byteLength} bytes; the layout says ${snapshotBytes(4, 3, 2)}.`,
      );
    }
    const got = decodeSnapshot(bytes, createSnapshot());
    if (!got) {
      failures.push('A 4-player 3-ball 2-actor snapshot would not decode.');
    } else {
      if (got.tick !== 123456) failures.push(`Snapshot tick came back as ${got.tick}.`);
      if (got.ackSeq !== 65530) failures.push(`Snapshot ackSeq came back as ${got.ackSeq}.`);
      if (got.players.length !== 4) failures.push(`Snapshot carried ${got.players.length} players, not 4.`);
      for (let i = 0; i < Math.min(4, got.players.length); i++) {
        const a = players[i];
        const b = got.players[i];
        if (b.id !== a.id) failures.push(`Player ${i}: id ${a.id} came back as ${b.id}.`);
        for (const [axis, want, back] of [['x', a.x, b.x], ['y', a.y, b.y], ['z', a.z, b.z]] as Array<[string, number, number]>) {
          if (Math.abs(back - want) > 0.01) {
            failures.push(`Player ${a.id}: ${axis} ${want} came back as ${back}; spec 10's tolerance is 1 cm.`);
          }
        }
        if (b.anim !== a.anim) failures.push(`Player ${a.id}: anim ${a.anim} came back as ${b.anim}.`);
        if (b.stamina !== a.stamina) failures.push(`Player ${a.id}: stamina ${a.stamina} came back as ${b.stamina}.`);
        if (b.phase !== a.phase) failures.push(`Player ${a.id}: phase ${a.phase} came back as ${b.phase}.`);
        if (b.flags !== a.flags) failures.push(`Player ${a.id}: flags ${a.flags} came back as ${b.flags}.`);
        if (b.ballCharges !== a.ballCharges) {
          failures.push(`Player ${a.id}: ball charges ${a.ballCharges} came back as ${b.ballCharges}.`);
        }
        if (Math.abs(b.health - a.health) > 1 / 64) {
          failures.push(`Player ${a.id}: health ${a.health} came back as ${b.health}.`);
        }
      }

      // --- The projectile section. This is the one that catches a header that
      // grew by a byte without the ball offsets moving with it: the players
      // would decode perfectly and the balls would be garbage at plausible
      // coordinates, which draws footballs scattered across the harbour.
      if (got.balls.length !== 3) {
        failures.push(`Snapshot carried ${got.balls.length} balls, not 3. The ball count byte is not being read.`);
      }
      for (let i = 0; i < Math.min(3, got.balls.length); i++) {
        const a = balls[i];
        const b = got.balls[i];
        if (b.id !== a.id) failures.push(`Ball ${i}: id ${a.id} came back as ${b.id}.`);
        if (b.thrower !== a.thrower) failures.push(`Ball ${a.id}: thrower ${a.thrower} came back as ${b.thrower}.`);
        if (b.bounces !== a.bounces) failures.push(`Ball ${a.id}: bounces ${a.bounces} came back as ${b.bounces}.`);
        for (const [axis, want, back] of [['x', a.x, b.x], ['y', a.y, b.y], ['z', a.z, b.z]] as Array<[string, number, number]>) {
          if (Math.abs(back - want) > 0.01) {
            failures.push(`Ball ${a.id}: ${axis} ${want} came back as ${back}.`);
          }
        }
        for (const [axis, want, back] of [['vx', a.vx, b.vx], ['vy', a.vy, b.vy], ['vz', a.vz, b.vz]] as Array<[string, number, number]>) {
          if (Math.abs(back - want) > 0.25) {
            failures.push(`Ball ${a.id}: ${axis} ${want} m/s came back as ${back} m/s.`);
          }
        }
      }

      // --- v7's faction section. This is the one that catches a ball record
      // that grew or a header that did not: the players and the balls would
      // decode perfectly and the actors would be police at plausible
      // coordinates in impossible states, which draws officers standing in the
      // harbour aiming at nothing.
      if (got.npcs.length !== 2) {
        failures.push(`Snapshot carried ${got.npcs.length} faction actors, not 2. The actor count byte is not being read.`);
      }
      for (let i = 0; i < Math.min(2, got.npcs.length); i++) {
        const a = npcs[i];
        const b = got.npcs[i];
        if (b.id !== a.id) failures.push(`Actor ${i}: id ${a.id} came back as ${b.id}; the field is a u16.`);
        if (b.kind !== a.kind) failures.push(`Actor ${a.id}: kind ${a.kind} came back as ${b.kind}.`);
        if (b.state !== a.state) failures.push(`Actor ${a.id}: state ${a.state} came back as ${b.state}.`);
        for (const [axis, want, back] of [['x', a.x, b.x], ['y', a.y, b.y], ['z', a.z, b.z]] as Array<[string, number, number]>) {
          if (Math.abs(back - want) > 0.01) {
            failures.push(`Actor ${a.id}: ${axis} ${want} came back as ${back}.`);
          }
        }
        const yawErr = Math.abs(
          Math.atan2(Math.sin(b.yaw - (a.yaw % (Math.PI * 2))), Math.cos(b.yaw - (a.yaw % (Math.PI * 2)))),
        );
        if (yawErr > 0.006) failures.push(`Actor ${a.id}: yaw ${a.yaw} came back as ${b.yaw}.`);
      }
    }

    // A snapshot with no balls and no actors in it -- every snapshot in a quiet
    // city -- still has to decode.
    const empty = decodeSnapshot(encodeSnapshot(1, 2, players), createSnapshot());
    if (!empty || empty.balls.length !== 0 || empty.npcs.length !== 0 || empty.players.length !== 4) {
      failures.push('A snapshot with no balls and no faction actors in it did not decode cleanly.');
    }
    // And the decoder must refuse a truncated tail rather than reading past the
    // end of the buffer, which `DataView` throws on -- taking the whole client
    // down on one short frame. Trimmed by four bytes, which lands inside the
    // last actor now that the faction section is the tail.
    if (decodeSnapshot(bytes.slice(0, bytes.byteLength - 4), createSnapshot()) !== null) {
      failures.push('A snapshot truncated mid-actor decoded anyway. The length guard is not covering the faction section.');
    }
    // And one trimmed into the ball section, which is no longer the tail and
    // would otherwise stop being covered by the test above.
    const intoBalls = encodeSnapshot(1, 2, players, balls);
    if (decodeSnapshot(intoBalls.slice(0, intoBalls.byteLength - 4), createSnapshot()) !== null) {
      failures.push('A snapshot truncated mid-ball decoded anyway.');
    }
  }

  // --- Investigations, v7's other new record.
  //
  // What this catches: a countdown that does not round-trip is a banner that
  // says a different number from the one the server is counting down, and the
  // player reads the wrong one. A reason byte that does not survive is
  // "Under Investigation! undefined" on a screen that is otherwise correct.
  {
    const records: InvestigationRecord[] = [
      { playerId: 1, reason: 1, ticks: 2700 },
      { playerId: 255, reason: 4, ticks: 1 },
      { playerId: 7, reason: 3, ticks: 65535 },
    ];
    const frame = encodeInvestigations(records);
    if (frame.byteLength !== investigationBytes(3)) {
      failures.push(`A 3-entry investigation message is ${frame.byteLength} bytes; the layout says ${investigationBytes(3)}.`);
    }
    const got = decodeInvestigations(frame);
    if (!got || got.length !== 3) {
      failures.push(`A 3-entry investigation message decoded to ${got?.length ?? 'null'} records.`);
    } else {
      for (let i = 0; i < 3; i++) {
        const a = records[i];
        const b = got[i];
        if (b.playerId !== a.playerId || b.reason !== a.reason || b.ticks !== a.ticks) {
          failures.push(
            `Investigation ${a.playerId}: ${a.reason}/${a.ticks} came back as ${b.reason}/${b.ticks}.`,
          );
        }
      }
    }
    // The empty message is the interesting one: it is how "nobody is wanted"
    // travels, and a decoder that returned null for it would leave every banner
    // in the world up forever. See `encodeInvestigations`.
    const none = decodeInvestigations(encodeInvestigations([]));
    if (none === null || none.length !== 0) {
      failures.push('An empty INVESTIGATION message did not decode to an empty list; that is how a banner comes down.');
    }
    // A countdown past the u16 is clamped rather than wrapped.
    const huge = decodeInvestigations(encodeInvestigations([{ playerId: 2, reason: 1, ticks: 999999 }]));
    if (!huge || huge[0].ticks !== 65535) {
      failures.push('An over-long countdown wrapped instead of clamping; 18 minutes would draw as one second.');
    }
    // And a truncated tail drops the rest rather than throwing.
    const short = decodeInvestigations(frame.slice(0, INVESTIGATION_HEADER_BYTES + 6));
    if (short === null || short.length !== 1) {
      failures.push(`An investigation message truncated mid-record decoded ${short?.length ?? 'null'} entries, not 1.`);
    }
  }

  // --- Events: a batch of all four kinds, out and back.
  {
    const events: NetEvent[] = [
      { kind: EVENT.HIT, attacker: 1, victim: 2, flags: EVENT_FLAG.KO | EVENT_FLAG.FOOTY, health: 0 },
      { kind: EVENT.PICKUP, combatant: 4, powerup: 1, tileX: -3, tileZ: 5, index: 17 },
      { kind: EVENT.JOIN, id: 9, colourway: 2, bot: 1 },
    ];
    const got = decodeEvents(encodeEvents(events));
    if (!got || got.length !== events.length) {
      failures.push(`An event batch of ${events.length} came back as ${got ? got.length : 'null'}.`);
    } else {
      const hit = got[0] as HitEvent;
      if (hit.attacker !== 1 || hit.victim !== 2 || hit.flags !== (EVENT_FLAG.KO | EVENT_FLAG.FOOTY)) {
        failures.push('A HIT event did not round-trip.');
      }
      const pick = got[1] as PickupEventFrame;
      if (pick.tileX !== -3 || pick.tileZ !== 5 || pick.index !== 17 || pick.powerup !== 1) {
        failures.push('A PICKUP event did not round-trip. Negative tile indices are the usual cause.');
      }
      const join = got[2] as JoinEvent;
      if (join.id !== 9 || join.bot !== 1) failures.push('A JOIN event did not round-trip.');
    }
    // The retired kind. A batch carrying an event this build does not know must
    // drop the rest rather than resynchronise on the middle of a record -- which
    // is the whole reason `EVENT_BYTES` is a table. 2 was `LASER`; a server left
    // running across this protocol bump is exactly what produces one.
    {
      const stale = new ArrayBuffer(4);
      const v = new DataView(stale);
      v.setUint8(0, MSG.EVENTS);
      v.setUint8(1, 1);
      v.setUint8(2, 2);
      const back = decodeEvents(stale);
      if (back === null || back.length !== 0) {
        failures.push('A batch carrying the retired LASER event kind was not dropped cleanly.');
      }
    }
  }

  // --- The bikes, v6's new message.
  //
  // What this catches: a dropped bike whose position does not survive the wire
  // is a bike that goes back to where it was parked the moment anybody else's
  // client hears about it, which reads as the bike teleporting rather than as an
  // encoder bug. And a `rider` that does not round-trip is two players who both
  // believe they are on bike 3.
  {
    const bikes: BikeRecord[] = [
      { id: 1, rider: 0, x: -364.25, y: -31.75, z: 2682.5, yaw: 0.75 },
      { id: 65535, rider: 16, x: 3999.99, y: -70.125, z: -3999.99, yaw: 6.28 },
      { id: 74, rider: 0, x: 0, y: 0, z: 0, yaw: 0 },
    ];
    const frame = encodeBikes(bikes);
    if (frame.byteLength !== bikesBytes(3)) {
      failures.push(`A 3-bike message is ${frame.byteLength} bytes; the layout says ${bikesBytes(3)}.`);
    }
    const got = decodeBikes(frame);
    if (!got || got.length !== 3) {
      failures.push(`A 3-bike message decoded to ${got?.length ?? 'null'} records.`);
    } else {
      for (let i = 0; i < 3; i++) {
        const a = bikes[i];
        const b = got[i];
        if (b.id !== a.id) failures.push(`Bike ${a.id}: id came back as ${b.id}.`);
        if (b.rider !== a.rider) failures.push(`Bike ${a.id}: rider ${a.rider} came back as ${b.rider}.`);
        for (const [axis, want, back] of [['x', a.x, b.x], ['y', a.y, b.y], ['z', a.z, b.z]] as Array<[string, number, number]>) {
          if (Math.abs(back - want) > 0.01) {
            failures.push(`Bike ${a.id}: ${axis} ${want} came back as ${back}; the tolerance is 1 cm.`);
          }
        }
      }
    }
    // An empty message is legal and means "nothing changed" -- the server sends
    // one on a tick where a claim was refused, and a decoder that returned null
    // for it would log an error twenty times a second.
    const none = decodeBikes(encodeBikes([]));
    if (none === null || none.length !== 0) failures.push('An empty BIKES message did not decode to an empty list.');
    // A truncated tail drops the rest rather than throwing inside the socket
    // callback, which is `decodeRoster`'s rule and the reason it exists.
    const short = frame.slice(0, BIKE_HEADER_BYTES + BIKE_RECORD_BYTES + 4);
    const partial = decodeBikes(short);
    if (partial === null || partial.length !== 1) {
      failures.push(`A BIKES message truncated mid-record decoded ${partial?.length ?? 'null'} bikes, not 1.`);
    }
  }

  // --- Welcome, pong and bye.
  {
    const w: Welcome = { version: PROTOCOL_VERSION, id: 3, colourway: 5, snapshotHz: SNAPSHOT_HZ, tick: 4000000000, x: -812.34, y: 15.5, z: 1420.99, yaw: 4.2 };
    const got = decodeWelcome(encodeWelcome(w));
    if (!got || got.id !== 3 || got.tick !== 4000000000 || Math.abs(got.x - w.x) > 0.01 || Math.abs(got.z - w.z) > 0.01) {
      failures.push('A WELCOME did not round-trip. A tick over 2^31 is the usual cause -- it is a u32.');
    }
    const pong = decodePong(encodePong(9, 1234.5, 6789.25));
    if (!pong || pong.seq !== 9 || pong.clientTime !== 1234.5 || pong.serverTime !== 6789.25) {
      failures.push('A PONG did not round-trip; the clock sync cannot work.');
    }
    if (decodeBye(encodeBye('protocol 2, server speaks 3')) !== 'protocol 2, server speaks 3') {
      failures.push('A BYE reason did not round-trip.');
    }

    // --- HELLO, with the name on it, and the one case that is not a round trip.
    {
      const hello = decodeHello(encodeHello(3, 'Bazza'));
      if (!hello || hello.version !== PROTOCOL_VERSION || hello.colourway !== 3 || hello.name !== 'Bazza') {
        failures.push('A HELLO carrying a name did not round-trip.');
      }
      // A **protocol-4 hello**: four bytes, no length prefix. It must still
      // yield its version, because that is what the server refuses it by -- a
      // decode that returned null here would drop a stale client into a socket
      // that never answers instead of into a BYE it can print. This is the one
      // case in this file that is deliberately not symmetric.
      const legacy = new ArrayBuffer(4);
      const lv = new DataView(legacy);
      lv.setUint8(0, MSG.HELLO);
      lv.setUint16(1, 4, true);
      lv.setUint8(3, 255);
      const old = decodeHello(legacy);
      if (!old || old.version !== 4 || old.name !== '') {
        failures.push(
          'A protocol-4 HELLO (4 bytes, no name) did not decode to version 4 with an empty name. ' +
            'A stale client has to be refusable by version rather than unparseable.',
        );
      }
      // And a length byte that overruns the frame, which is the cheapest thing a
      // hostile hello can say. Reading it would throw inside the socket callback.
      const liar = new ArrayBuffer(8);
      const lv2 = new DataView(liar);
      lv2.setUint8(0, MSG.HELLO);
      lv2.setUint16(1, PROTOCOL_VERSION, true);
      lv2.setUint8(3, 255);
      lv2.setUint8(4, 200);
      let threw = false;
      try {
        decodeHello(liar);
      } catch {
        threw = true;
      }
      if (threw) failures.push('A HELLO whose name length overran the frame threw rather than being clipped.');
    }

    // --- PING, and the round trip it now carries for the scoreboard.
    {
      const ping = decodePing(encodePing(7, 99.5, 143.4));
      if (!ping || ping.seq !== 7 || ping.clientTime !== 99.5 || ping.rttMs !== 143) {
        failures.push('A PING did not round-trip with its reported round trip.');
      }
      // Clamped rather than wrapped: a 66-second stall must not be drawn as a
      // 464 ms ping. See `quantisePing`.
      if (quantisePing(70000) !== 65535 || quantisePing(-5) !== 0 || quantisePing(NaN) !== 0) {
        failures.push('A ping outside the u16 was not clamped; a wrap draws a stall as a good connection.');
      }
    }
  }

  // --- The bandwidth claim in the header, asserted rather than asserted-in-prose.
  {
    const at16 = snapshotBytes(16) * SNAPSHOT_HZ * 8;
    if (at16 > 60000) {
      failures.push(
        `A 16-player snapshot stream is ${(at16 / 1000).toFixed(1)} kbit/s. The header ` +
          `documents 55; anything above 60 means the record grew and the note is stale.`,
      );
    }
    const at6 = snapshotBytes(6) * SNAPSHOT_HZ * 8;
    if (at6 > 30000) {
      failures.push(
        `A 6-player snapshot stream is ${(at6 / 1000).toFixed(1)} kbit/s, which breaks spec 10's ` +
          `30 kbit/s budget at the player count this build is actually played at.`,
      );
    }
    // And the projectile section, at the count six players can actually sustain.
    //
    // Two balls, and the number is derived rather than guessed: a ball lives
    // about 1.5 s and the bar returns one every 4 s, so each player contributes
    // 1.5/4 of a ball to the air and six of them contribute 2.25. The header's
    // budget has to survive the *steady state*; the burst it does not survive is
    // documented there rather than asserted here, because a check that failed on
    // a transient nobody can sustain would be a check nobody could keep green.
    const sustained = snapshotBytes(6, 2) * SNAPSHOT_HZ * 8;
    if (sustained > 30000) {
      failures.push(
        `Six players with the two balls they can sustain in the air is ` +
          `${(sustained / 1000).toFixed(1)} kbit/s, which breaks spec 10's budget at the count ` +
          `this build is actually played at. The projectile section is ${BALL_BYTES} B a ball.`,
      );
    }
    // And the invariant behind it: a football must never cost more to describe
    // than a person. Sixteen players is a bounded roster and the balls are not,
    // so the moment a ball is the more expensive record the section is the thing
    // that will break the stream first.
    if (BALL_BYTES > PLAYER_BYTES) {
      failures.push(
        `A ball is ${BALL_BYTES} B against a player's ${PLAYER_BYTES}. The ball count is unbounded ` +
          `where the roster is capped at ${MAX_PLAYERS}, so the cheaper record has to be the ball.`,
      );
    }
    // --- And v7's faction section, against the cap it was scoped with.
    //
    // 24 actors is `factions.MAX_ACTORS`, restated as a number rather than
    // imported because this file must not depend on a gameplay module -- the
    // dependency runs the other way and `game/factions.ts` asserts the same
    // arithmetic from its own end. What both are protecting is a section that
    // is *unbounded by the roster*: sixteen players cannot become thirty-two,
    // and a pursuit with reinforcements trickling in can, which is exactly the
    // shape of thing that quietly becomes the largest item on the wire.
    const npcSection = 24 * NPC_BYTES;
    if (npcSection > 500) {
      failures.push(
        `24 faction actors is ${npcSection} B a snapshot, over the 500 B this section was scoped at. ` +
          `An actor is ${NPC_BYTES} B.`,
      );
    }
    // The whole stream at the worst case anything can reach: spec 2's player
    // cap, the balls six players can sustain, and a pursuit at the actor cap.
    // 131 kbit/s, which is documented in the header and is over spec 10's
    // budget in the same direction and for the same reason the player section
    // already is -- what this asserts is that it has not *moved*, because the
    // faction section is the one part of this record that is not bounded by the
    // roster and is therefore the one that will grow without anybody noticing.
    const fullHouse = snapshotBytes(16, 2, 24) * SNAPSHOT_HZ * 8;
    if (fullHouse > 140000) {
      failures.push(
        `Sixteen players, two balls and a full pursuit is ${(fullHouse / 1000).toFixed(1)} kbit/s. ` +
          'The header documents 131; anything above 140 means a record grew and the note is stale.',
      );
    }
    // And the one that actually matters at the count this build is played at.
    const six = snapshotBytes(6, 2, 8) * SNAPSHOT_HZ * 8;
    if (six > 60000) {
      failures.push(
        `Six players with two balls and eight officers on them is ${(six / 1000).toFixed(1)} kbit/s.`,
      );
    }
  }

  return failures;
}

/**
 * Names and the roster: the sanitiser, the dedupe, the record and its order.
 *
 * A separate function from `verifyNet` rather than another block inside it,
 * because it is the same *kind* of check about a different *kind* of failure.
 * Everything in `verifyNet` is arithmetic that goes wrong by a factor and reads
 * as lag; everything here goes wrong by producing a name, which reads as
 * nothing at all until two players are called the same thing and a kill feed
 * stops being readable. Both ends run it -- `main.ts` before the renderer and
 * `server/index.ts` before the socket -- because the whole premise is that the
 * two run one sanitiser.
 *
 *     bun -e "import {verifyNames} from './client/src/net/protocol.ts';
 *             console.log(verifyNames())"
 */
export function verifyNames(): string[] {
  const failures: string[] = [];

  // --- The sanitiser, case by case, with what each one is actually about.
  const cases: Array<[string, string, string]> = [
    ['Bazza', 'Bazza', 'an ordinary name survives untouched'],
    ['  Shazza  ', 'Shazza', 'surrounding whitespace is trimmed'],
    ['Da    vo', 'Da vo', 'runs of whitespace collapse to one'],
    ['Mac\tca', 'Mac ca', 'a tab is a separator, not a deletion'],
    ['Jo\u0000hnno', 'Jo hnno', 'a NUL becomes a space rather than joining the halves'],
    ['Rusty\u200b\u200b\u200b', 'Rusty', 'zero-width padding is dropped'],
    ['\u202eBluey', 'Bluey', 'a bidi override is dropped, not drawn'],
    ['\u200b\u200b\u200b\u200b', '', 'a name made only of invisibles is no name'],
    ['Kev\u00a0\u00a0\u3000Jr', 'Kev Jr', 'non-breaking and ideographic spaces collapse like any other'],
    ['a', '', `under ${MIN_NAME_CHARS} characters is refused`],
    ['   ', '', 'whitespace alone is refused'],
    ['', '', 'nothing in, nothing out'],
    ['Bazza the absolute legend', 'Bazza the absolu', `clipped to ${MAX_NAME_CHARS} characters`],
  ];
  for (const [raw, want, why] of cases) {
    const got = sanitiseName(raw);
    if (got !== want) {
      failures.push(`sanitiseName(${JSON.stringify(raw)}) is ${JSON.stringify(got)}, not ${JSON.stringify(want)} -- ${why}.`);
    }
    // Idempotence, on every case. The server runs this over a string the client
    // already ran it over, and a second pass that differs is a name that changes
    // as it crosses the wire -- so the prompt and the scoreboard disagree.
    if (sanitiseName(got) !== got) {
      failures.push(`sanitiseName is not idempotent on ${JSON.stringify(raw)}: a second pass gave ${JSON.stringify(sanitiseName(got))}.`);
    }
  }

  // --- The two caps, and the one that only bites on astral-plane code points.
  {
    const wide = sanitiseName('🦘'.repeat(30));
    const chars = [...wide].length;
    const bytes = NAME_ENCODER.encode(wide).length;
    if (chars > MAX_NAME_CHARS || bytes > MAX_NAME_BYTES) {
      failures.push(
        `A name of 30 emoji sanitised to ${chars} characters / ${bytes} bytes, over the ` +
          `${MAX_NAME_CHARS} / ${MAX_NAME_BYTES} caps. The length prefix is a u8 and the roster ` +
          `desynchronises on the entry after an overrun.`,
      );
    }
    // And it is clipped at a code point rather than inside one. A lone surrogate
    // survives `TextEncoder` as U+FFFD, so the test is that nothing came back
    // replaced.
    if (wide.includes('�')) {
      failures.push('A name of emoji was clipped inside a surrogate pair.');
    }
  }

  // --- The dedupe. Two Bazzas have to end up different, or the kill feed is
  // unreadable in exactly the case somebody is trying to make it unreadable.
  {
    const taken: string[] = ['Bazza'];
    const second = uniqueName('Bazza', taken);
    if (second !== 'Bazza (2)') failures.push(`A second Bazza became ${JSON.stringify(second)}, not "Bazza (2)".`);
    taken.push(second);
    const third = uniqueName('Bazza', taken);
    if (third !== 'Bazza (3)') failures.push(`A third Bazza became ${JSON.stringify(third)}, not "Bazza (3)".`);
    // Case-insensitively, because "bazza" and "Bazza" are the same problem.
    if (uniqueName('BAZZA', taken) === 'BAZZA') {
      failures.push('"BAZZA" was allowed alongside "Bazza"; the dedupe has to be case-insensitive.');
    }
    // An unused name is handed back untouched, suffix-free.
    if (uniqueName('Davo', taken) !== 'Davo') failures.push('An unused name was suffixed anyway.');
    // A name already at the cap has to make room for the suffix rather than
    // overflowing it -- 16 characters plus " (2)" is 20.
    const long = sanitiseName('Shazza the great');
    const collided = uniqueName(long, [long]);
    if ([...collided].length > MAX_NAME_CHARS) {
      failures.push(`Deduping a full-length name gave ${[...collided].length} characters, over the ${MAX_NAME_CHARS} cap.`);
    }
    if (collided.toLowerCase() === long.toLowerCase()) {
      failures.push('Deduping a full-length name produced the name it collided with.');
    }
  }

  // --- The record, through the real encoder and decoder. This is the one that
  // catches an entry whose name length is written before the fields it follows:
  // every entry after it decodes as garbage at plausible values, which draws a
  // leaderboard of players nobody has ever seen.
  {
    const entries: RosterEntry[] = [
      { id: 1, colourway: 0, bot: false, name: 'Bazza', kos: 7, downs: 2, ping: 34 },
      { id: 2, colourway: 3, bot: true, name: 'Shazza', kos: 0, downs: 11, ping: 0 },
      { id: 200, colourway: 6, bot: false, name: 'Bazza (2)', kos: 65535, downs: 3, ping: 65535 },
      // The empty name is reachable: a client that sends nothing is given one by
      // the server, but the *record* has to survive a zero-length string or the
      // decoder walks off the end of the entry before it.
      { id: 15, colourway: 1, bot: false, name: '', kos: 1, downs: 1, ping: 999 },
      { id: 9, colourway: 2, bot: false, name: 'Kev 🦘', kos: 2, downs: 0, ping: 12 },
    ];
    const frame = encodeRoster(entries);
    if (frame.byteLength !== rosterBytes(entries)) {
      failures.push(`A ${entries.length}-entry roster is ${frame.byteLength} bytes; the layout says ${rosterBytes(entries)}.`);
    }
    const got = decodeRoster(frame);
    if (!got || got.length !== entries.length) {
      failures.push(`A ${entries.length}-entry roster came back as ${got ? got.length : 'null'}.`);
    } else {
      for (let i = 0; i < entries.length; i++) {
        const a = entries[i];
        const b = got[i];
        if (b.id !== a.id || b.colourway !== a.colourway || b.bot !== a.bot) {
          failures.push(`Roster entry ${a.id}: identity came back as ${b.id}/${b.colourway}/${b.bot}.`);
        }
        if (b.name !== a.name) failures.push(`Roster entry ${a.id}: name ${JSON.stringify(a.name)} came back as ${JSON.stringify(b.name)}.`);
        if (b.kos !== a.kos || b.downs !== a.downs || b.ping !== a.ping) {
          failures.push(`Roster entry ${a.id}: ${a.kos}/${a.downs}/${a.ping} came back as ${b.kos}/${b.downs}/${b.ping}.`);
        }
      }
    }
    // A truncated frame drops the tail rather than throwing. A throw here is
    // inside a socket callback and takes the client's whole message pump.
    let threw = false;
    try {
      const short = decodeRoster(frame.slice(0, frame.byteLength - 3));
      if (short === null || short.length >= entries.length) {
        failures.push('A truncated roster did not drop its incomplete tail.');
      }
    } catch {
      threw = true;
    }
    if (threw) failures.push('A truncated roster threw rather than dropping its tail.');
  }

  // --- The order the leaderboard is drawn in.
  {
    const rows: RosterEntry[] = [
      { id: 1, colourway: 0, bot: false, name: 'Davo', kos: 2, downs: 1, ping: 0 },
      { id: 2, colourway: 0, bot: false, name: 'Bazza', kos: 5, downs: 9, ping: 0 },
      { id: 3, colourway: 0, bot: false, name: 'Macca', kos: 2, downs: 0, ping: 0 },
      { id: 4, colourway: 0, bot: false, name: 'Shazza', kos: 0, downs: 0, ping: 0 },
    ];
    const order = rankRoster(rows).map((r) => r.name).join(',');
    // Bazza leads on kills despite being knocked down nine times -- the board is
    // ranked by what you did, and the downs column is the tiebreak rather than a
    // penalty. Macca is above Davo on two apiece because he has not been downed.
    if (order !== 'Bazza,Macca,Davo,Shazza') {
      failures.push(`rankRoster gave ${order}; it must be KOs descending, then downs ascending.`);
    }
    // Stable and deterministic for a board where nothing has happened yet, which
    // is every board for the first minute. Two 0/0 rows that swap places between
    // refreshes read as a rendering bug.
    const flat: RosterEntry[] = rows.map((r) => ({ ...r, kos: 0, downs: 0 }));
    const once = rankRoster(flat).map((r) => r.id).join(',');
    const twice = rankRoster([...flat].reverse()).map((r) => r.id).join(',');
    if (once !== twice) {
      failures.push(`An all-zero board ranked as ${once} one way and ${twice} the other; the order is not total.`);
    }
    // And it does not disturb the caller's array, which is the live roster.
    rankRoster(rows);
    if (rows[0].name !== 'Davo') failures.push('rankRoster sorted its argument in place.');
  }

  return failures;
}
