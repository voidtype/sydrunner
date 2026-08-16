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
 * BANDWIDTH: v8 is the version where this stopped being O(players).
 *
 * Spec 10 asks for *"< 30 kbit/s per player downstream at 16 players"*. Through
 * v7 the stream carried **every player to every client**, at 21 bytes each, so
 * the answer was a function of how many people were in the game:
 *
 *     16 players -> 10 + 16 x 21 = 346 B/snapshot -> **55 kbit/s**   (1.8x over)
 *    128 players -> 10 + 128 x 21 = 2,698 B      -> **432 kbit/s**  (14x over)
 *    500 players -> measured at 1.92 Mbit/s per client, 958 Mbit/s out of one
 *                   process. See PERFORMANCE.md's phase 1 curve, which is what
 *                   this section is a response to.
 *
 * **v8 carries the players a client can see**, which is a function of local
 * density and not of the room. A working set is everybody within
 * `AOI_ENTER_RADIUS` (180 m), held until `AOI_LEAVE_RADIUS` (220 m), capped at
 * the `AOI_MAX_PLAYERS` (40) nearest, and the record grew a byte to 22:
 *
 *     alone in a street ->  12 +  1 x 22 =   34 B/snapshot ->  **5 kbit/s**
 *     a fight (6 in view) ->  12 +  6 x 22 =  144 B         -> **23 kbit/s**
 *     a busy block (18)   ->  12 + 18 x 22 =  408 B         -> **65 kbit/s**
 *     the cap (40)        ->  12 + 40 x 22 =  892 B         -> **143 kbit/s**
 *
 * So spec 10's budget is now met at the counts the game is *played* at rather
 * than at the count it happens to hold, and -- the part that matters more --
 * **the worst case is bounded by a constant instead of by the room**. A 128
 * player room and a 1,000 player deployment cost a client the same 143 kbit/s
 * ceiling, because you cannot stand next to more than forty people.
 *
 * The measured typical is in PERFORMANCE.md phase 4, and the honest headline is
 * that the mean is far under the cap: people spread out, and the mean working
 * set in a 128-player room is single digits.
 *
 * **Footballs are on top of that**, at 18 B each, and they are the one part of
 * this record not paid per player. **The two numbers behind the sum below both
 * moved** when the player asked for a ball that lasts ten times as long and a
 * supply that returns two and a half times faster, and the arithmetic is
 * restated rather than left as it was.
 *
 * It used to read: a ball lives about 1.5 s in practice -- three bounces goes
 * quickly -- and the supply returns one every 4 s, so the sustained count is
 * roughly a quarter of a ball per player, about two in the air at six players.
 *
 * A ball now lives about 11 s -- it settles and rolls rather than being deleted
 * mid-bounce; see `footy.ROLL_DECEL` -- and `combat.BALL_RECHARGE` is 1.6 s. So
 * the sustained count is nearer *seven* balls per player, and six players in one
 * street is forty balls, 800 B, rather than two and 36 B.
 *
 * Three things keep that from being forty balls in everyone's stream. The
 * `InterestIndex` filters balls **by the ball's own position** against
 * `AOI_LEAVE_RADIUS`, and a ball that has rolled two streets away is out of it.
 * The delta encoding in the note below closes a ball more cheaply than it
 * closes a player, because a ball's position moves a predictable distance along
 * a known velocity and the residual against a *ballistic* prediction is
 * centimetres -- and a *rolling* ball is the easiest case that encoding has,
 * since it is travelling in nearly a straight line at nearly constant speed.
 * And the tail of a ball's life is the cheap part by construction: it is slow,
 * it is predictable, and `footy.ARM_SPEED_SQ` means it is not even a hit test
 * any more.
 *
 * What is left is real and is stated rather than smoothed away: a sixteen-player
 * brawl in one street costs more than it did. It is the thing that was asked for
 * -- the balls stay in play -- and it is the one situation where a player wants
 * every one of them drawn. `verifyNet` asserts the sustained case and that a
 * ball never costs more than a person.
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
  /**
   * Say something to everybody on the host. See `net/chat.ts`.
   *
   * **0x0b rather than 0x04**, which is the next free number, and the reason is
   * this file's own halves rule one paragraph up: `0x0b` is `0x8b & 0x7f`, so the
   * request and the reply it produces are one number in two halves and reading
   * either off a hex dump gives you the other. It also keeps the low end of the
   * client range free for whatever the next feature wants, which matters when
   * two features are being built at once against the same table.
   */
  CHAT_SAY: 0x0b,
  /**
   * The suggestions box, in one client message. See `net/suggestions.ts`.
   *
   * **0x0c on `CHAT_SAY`'s convention** -- `0x8c & 0x7f`, so the request and the
   * list it asks for are one number in two halves.
   *
   * *One* id for three operations (ask for the list, file a suggestion, vote),
   * discriminated by a sub-op byte, which is the only place in this table a
   * message is not one shape. The argument is that they are one conversation
   * held a handful of times a session: three ids would be three cases in
   * `server/index.ts` for one feature, and its flood guard -- which is
   * per-socket and counts this feature's traffic -- would have had to be summed
   * across all three. See `suggestions.SUGGEST_OP`.
   */
  SUGGEST: 0x0c,
  /**
   * "I am standing at the button in Sydney Park and I have pressed it."
   * See `game/sunbutton.ts`.
   *
   * **0x0d on `CHAT_SAY`'s convention** -- `0x8d`... except `0x8d` is already
   * `SUGGEST_ACK`, so this one pair breaks the halves rule and it is worth
   * saying why rather than leaving a reader to wonder. The rule pairs a request
   * with *the reply it produces*, and this request produces `MSG.SUN` (0x8e),
   * which is not a reply -- it is a broadcast that every client in the room
   * gets, including ones that pressed nothing. There is no pairing to preserve,
   * so the id is simply the next free number in the client range.
   *
   * **A message of its own rather than a bit on `INPUT`**, which is the obvious
   * alternative given `BTN.MOUNT` is right there and the key is the same `E`.
   * Rejected on two counts. `resolveMount` is already a four-way priority chain
   * -- off a train, off a bike, onto a train, onto a bike -- whose whole
   * correctness argument is that the client and `server/sim.ts` run it in the
   * same order; wedging a fifth case into it makes both ends' chain longer to
   * buy nothing, because a press on the button is not a mount and cannot be
   * confused with one at the distances involved. And `INPUT` runs at 60 Hz
   * through a ring buffer that deliberately drops frames under starvation (see
   * `Conn.inbox`), which is exactly right for a level-triggered movement bit and
   * exactly wrong for an event that happens once every three in-game days.
   *
   * **One byte, and it carries no position**, which is `INPUT_BYTES`' own rule
   * stated again: a client that sends where it thinks it is is a client that can
   * send where it would like to be. The server already owns the presser's body
   * and checks the reach against that. The half-metre between the client's
   * prompt radius (`SUN_PROMPT_M`, 2.5 m) and the server's (`SUN_REACH_M`, 3 m)
   * is what absorbs the tick of walking the two ends can disagree about, and it
   * is a much better place to spend the slack than a field the sender controls.
   */
  SUN_PRESS: 0x0d,
  /**
   * The phone, in one client message with a sub-op byte. See `net/cash.ts`.
   *
   * `SUGGEST`'s arrangement for `SUGGEST`'s two reasons: claiming a Centrelink
   * payment and going on or off the rideshare shift are one conversation held
   * from one screen a handful of times a session, three ids would be three
   * cases in `server/index.ts` for one feature, and the per-socket flood guard
   * that counts this feature's traffic would have to be summed across them.
   *
   * **0x0e rather than 0x0d**, which is free: the two server messages this
   * feature answers with are `WALLET` at 0x8f and `FARE` at 0x90, so there is
   * no low/high pairing to preserve here and 0x0d is left for whichever of the
   * five branches landing beside this one wants a low id. See `net/cash.ts`.
   */
  PHONE: 0x0e,

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
  /**
   * Who just entered this client's working set, and who just left it. See
   * `encodeInterest`, and PERFORMANCE.md phase 2.
   *
   * v8's one new message, and the whole of what interest management costs on the
   * wire. A snapshot used to be the world; now it is *your* world -- the players
   * within 180 m, capped at the 40 nearest -- so the client needs to be told when
   * that membership changes rather than inferring it from a list that shrank.
   *
   * Inferring it was the alternative and it is wrong for one reason: a snapshot
   * carries a position and says nothing about *who* somebody is. A player who
   * walked into view would arrive as an id with no colourway and no bot flag, and
   * the client would draw them in kit 0 until the next roster refresh two seconds
   * later -- which is `net/client.ts`'s `identity` table's whole argument, made
   * again at twenty times the rate. So an entrance carries the identity with it
   * and an exit carries nothing but the id.
   *
   * A **message of its own rather than a section of the snapshot**, and that is
   * the decision this record exists to state. The snapshot body is deduplicated
   * across every client whose working set is the same set -- see
   * `server/room.ts` -- and that only works because the body is a function of the
   * *set* and of nothing else. Enter/leave are a function of the set **and of
   * that client's previous set**, so two clients standing beside each other, one
   * of whom arrived this tick, would have identical bodies and different deltas.
   * Folding the deltas in would have made every frame per-client again, which is
   * exactly the cost phase 1 removed and phase 2 is trying not to put back.
   *
   * Sent immediately **before** the snapshot on the tick it changes, so a body in
   * the snapshot always has an identity behind it, and never otherwise: a client
   * standing still in an empty street is sent nothing at all.
   */
  INTEREST: 0x8a,
  /**
   * One line of chat, from anybody on the host. See `net/chat.ts`.
   *
   * The **only message in this table that is not a room's.** Everything else
   * here is scoped to one `Simulation` and its sockets -- the roster is
   * room-global and says so, the snapshot is narrower still -- and this crosses
   * every room in the process, because "global chat" that stopped at the room
   * boundary would be a lobby chat that called itself global. The fan-out is
   * `server/chat.ts`, which also states the one boundary it does *not* cross.
   *
   * A message of its own rather than an `EVENT`, on `BIKES`' argument and one
   * more: an event carries fixed-width ids and this carries two strings, so
   * folding it into `encodeEvents` would put a variable-length record in the one
   * message whose reader walks a fixed stride.
   */
  CHAT_LINE: 0x8b,
  /**
   * The ranked suggestion list, plus what this client has left to spend on it.
   * See `net/suggestions.encodeSuggestionList`.
   *
   * **Not on the snapshot path and never sent unasked**, with one exception: it
   * is pushed to every client whose panel is open when a score changes, so two
   * people voting beside each other are looking at one list rather than two. On
   * `BIKES`' argument -- that is a message a few times a minute across a whole
   * host, against a snapshot twenty times a second per player.
   *
   * The list is **per client**, which is the one way it differs from every other
   * server message here: it carries `myVote` and `votesLeft`, which are facts
   * about the *recipient*. So it is deliberately never deduplicated across
   * sockets the way a snapshot body is -- see `server/room.ts`'s `FrameGroups`
   * for the machinery this is staying out of.
   */
  SUGGEST_LIST: 0x8c,
  /**
   * Yes / no / not this week, and a sentence saying which. See
   * `net/suggestions.encodeSuggestAck`.
   *
   * The sentence is composed by the **server** rather than looked up from the
   * result code on the client, because the rules it describes live on the server
   * and a client-side table is two builds disagreeing about what "quota" means
   * the day the quota moves. The code is still carried so the panel can colour
   * the line and know whether to empty the compose box.
   */
  SUGGEST_ACK: 0x8d,
  /**
   * Whether the sun is a screaming face, and when the button comes back. See
   * `encodeSun` and `game/sunbutton.ts`.
   *
   * A message of its own rather than a section of the snapshot, on `BIKES`'
   * argument taken to its limit: this changes **once every three in-game days**
   * -- three real hours -- and is otherwise two constants. On the snapshot path
   * it would be sixteen bytes per client twenty times a second, forever, to
   * carry a number nobody has changed since before the room started.
   *
   * Room-global and deliberately not interest-filtered, on `sendBikes`'
   * argument: the sun is over everybody's head at once. A client 40 km away in
   * Palm Beach is looking at the same sky as the one standing on the mound, so
   * "who can see the button" is not the question -- there is no version of this
   * feature where two players in one room see different suns.
   *
   * Sent on change to everybody, to every joiner beside `BIKES`, **and to the
   * presser whether or not the press was accepted**. That last one is not
   * symmetry for its own sake: `world/sunbutton.ts` writes the state
   * optimistically on the frame the key goes down, so a refused press needs a
   * frame to be corrected by. Without it, a client that guessed wrong would draw
   * a face nobody else could see until the next real press three hours later.
   */
  SUN: 0x8e,
  /**
   * How wanted everybody is, in stars. See `encodeHeat` and `game/heat.ts`.
   *
   * **0x92 rather than 0x8e**, and the gap is deliberate: this feature landed in
   * a batch of six built in parallel against one table, and 0x8e..0x91 are
   * pre-assigned to the siblings so that two branches cannot both take "the next
   * free number" and both be right. A hole in a table of bytes costs nothing;
   * two features that decode each other's frames cost a session.
   *
   * A message of its own rather than a widening of `INVESTIGATION`, which was
   * genuinely the tempting option -- the two are the same shape, they change at
   * the same moments and they are about the same players. Two reasons not to.
   * The first is that they have different *lifetimes*: an investigation is a
   * countdown that the client runs down itself between messages, and a star
   * count is a level that must never move on its own, so folding them would put
   * a field that must not be extrapolated inside a message that exists to be
   * extrapolated. The second is that a star count is drawn on **other people's
   * nameplates** -- a 4-star player is a visible target -- so this one is
   * room-global where the investigation channel is filtered to what you can see.
   */
  HEAT: 0x92,
  /**
   * Which cars somebody has taken, and who is in them. See `encodeCars`.
   *
   * A message of its own on `BIKES`' argument exactly -- a car record changes
   * when somebody steals one, leaves one, or an abandoned one expires, which is
   * a few times a minute across a whole room, against a position that is
   * different every tick. The **pose of an occupied car is not on this message
   * at all**: it is derived from its driver's own snapshot record, because a car
   * follows its driver and the driver is already there at 20 Hz. See
   * `game/driving.CarField.follow`.
   *
   * 0x91 rather than 0x8e because this workstream was one of six landing in
   * parallel and the ids were handed out in advance so the branches could not
   * collide. The gap at 0x8e..0x90 is other people's.
   */
  CARS: 0x91,
  /**
   * How much money this player has, and every cash bundle on the ground in the
   * room. See `net/cash.encodeWallet`.
   *
   * A message of its own rather than a field on the snapshot, on `BIKES`'
   * argument: a balance changes when somebody is paid, robbed or knocked
   * over -- a few times a minute across a whole room -- against a position that
   * is different every tick. Twenty times a second it would be four bytes per
   * player per snapshot to carry a number that is almost always the same one.
   *
   * **Per client and therefore never deduplicated** across sockets the way a
   * snapshot body is (see `server/room.ts`'s `FrameGroups`), because the
   * balance is a fact about the recipient. `net/cash.ts`'s header does the
   * arithmetic on what that costs and why the bundles ride here anyway.
   */
  WALLET: 0x8f,
  /**
   * The rideshare fare this driver is on, if any. See `net/cash.encodeFare`.
   *
   * Sent on change, only to the driver it belongs to, and never to anybody
   * else -- a fare is not a thing other players can see. Twenty-four bytes on
   * each of about six state changes a trip.
   */
  FARE: 0x90,
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
/*
 * v9 is a **shared** bump: two features landed in the same pass -- global chat
 * (`MSG.CHAT_SAY`/`MSG.CHAT_LINE`, `net/chat.ts`) and the suggestions box -- and
 * both add message types to the table above without changing any existing
 * layout. One version covers both, because the version's job is "these two ends
 * do not agree about what a frame is" and a client missing either message type
 * is a client that would silently ignore frames it should be showing a player.
 * Whichever feature is edited next: check this number before bumping it.
 */
/*
 * v10 adds the **aboard section**: who is standing inside which carriage of
 * which train, and where in it.
 *
 * A section of its own after the actors rather than a widening of the player
 * record, on the argument the projectiles are filed under: this is a property of
 * a *relationship* and not of a person, it is empty in the overwhelming majority
 * of snapshots, and thirteen bytes of zeros per player per snapshot is 104 kbit/s
 * of nothing at a full working set. Membership of the section is itself the
 * "is aboard" bit, so no flag byte was widened either -- and `FLAG` had no spare
 * bits left to widen with, which is the other half of why.
 *
 * A player in that section is **still a completely ordinary player** in the
 * record above it: their `x, y, z` is the derived world position, so the roster,
 * the leaderboard, the kill feed, the minimap, the nameplates and every client
 * that never learned what a train is keep working unchanged. What the section
 * buys is exactness -- see `ABOARD_BYTES`.
 */
/*
 * v11 adds **the server's wall clock** to `WELCOME`, and it is the smallest
 * possible field for the largest possible reason.
 *
 * The day/night cycle has always been a pure function of `Date.now()`, and
 * `sky/cycle.ts` spent a paragraph arguing that this was better than a protocol
 * field: two machines whose clocks agree to a second agree about the sky to
 * within a fortieth of a game-minute, with nothing on the wire and a sky that is
 * already right before the socket opens. Both halves of that are still true and
 * neither was the problem. **The problem is the word "agree".** Nothing anywhere
 * made two clients agree -- a laptop whose clock is four minutes fast has been
 * playing a different time of day from everybody else in the room, and the
 * client could additionally scrub its own by pressing `T` or `N`. Street lights
 * on for one player and off for the next is not a cosmetic disagreement in a
 * game where the police, the raves and the traffic all behave differently after
 * dark, and it is the same disease as the `?vessels=1` link that outlived its
 * server flag: a fact with two owners and no way to notice they had diverged.
 *
 * So the server publishes its clock -- here, once, at join, and on `/health`
 * beside `vessels` for the same reason `vessels` is there -- and the client
 * renders it. What crosses the wire is one `f64` of epoch milliseconds and
 * nothing else: no phase, no time of day, no night level. The *cycle* is still
 * exactly the pure function it was, still evaluated on the client, still
 * identical arithmetic on both ends; all that has changed is which wall clock it
 * is handed. A field that carried the phase instead would have to be re-sent
 * forever and would put the sky on the snapshot path, which is the design this
 * one is specifically avoiding.
 *
 * The field is 8 bytes because a clock is not a `u32` of anything: epoch
 * milliseconds passed 2^32 in 1970 and a `f64` holds them exactly (integers to
 * 2^53), so there is no quantisation and no epoch to agree on separately.
 */
export const PROTOCOL_VERSION = 11;

/** Spec 10: "60 Hz tick, snapshots at 20-30 Hz." */
export const TICK_HZ = 60;
export const SNAPSHOT_HZ = 20;
/** Every this many ticks, one snapshot. 60 / 20 = 3. */
export const SNAPSHOT_INTERVAL = TICK_HZ / SNAPSHOT_HZ;

/**
 * The advertised cap: how many players this game says it is for.
 *
 * Spec 2 said 16 and the user raised it to **100** on 2026-08-05. It is
 * **not the width of anything** -- see `MAX_ROOM_PLAYERS`, which is 128 and is
 * what every v8 field is sized against, so this number can move between 2 and
 * 128 without touching a byte on the wire. It is the default a room fills to
 * (`SYDNEY_ROOM_CAP` overrides) and the number the boot line quotes.
 */
export const MAX_PLAYERS = 100;

/**
 * How big a room is allowed to get, and the number every width in v8 is sized
 * against.
 *
 * PERFORMANCE.md's architecture is "rooms of ~128, many rooms". 128 is the
 * measured shape (0.52 ms of tick, 3.1% of a core) and this is the ceiling the
 * *protocol* will carry rather than the default a host runs at -- see
 * `server/room.ts`, which takes its cap from config and defaults to 128.
 *
 * Nothing on the wire is 150 wide. What this number does is make the widths
 * below obviously sufficient rather than merely untested: an id is a `u16`
 * because ids must survive churn without reuse (see `AOI_ID_LIFECYCLE` below),
 * and a count is a `u16` because 150 does not fit in a byte with the AOI cap
 * beside it.
 */
export const MAX_ROOM_PLAYERS = 150;

/**
 * ## The id lifecycle, stated once, because two ends have to agree about it
 *
 * A player id is **allocated per room, from 1, monotonically, and is never
 * reused while its previous owner is still on anybody's screen.** Specifically:
 *
 *   - **0 is nobody.** `SnapshotBall.thrower` uses it for "the thrower has left",
 *     `BikeRecord.rider` uses it for "on its kickstand", and `NpcActor.id` uses
 *     it for "no actor". A live player is never 0.
 *   - **Ids ascend and wrap at 65535 back to 1**, skipping anything currently
 *     live. At the 20 joins a minute a busy room sees, the counter takes
 *     **two days** to wrap; a room that has been up that long has nobody left in
 *     it who remembers id 4,001.
 *   - **An id is a room's, not a host's.** Two rooms in one process both have a
 *     player 7 and they never meet, because a room is a separate `Simulation`
 *     with a separate socket set. The room a client is in arrives in its
 *     `WELCOME` and is fixed for the session.
 *   - **Nothing is persisted.** A reconnecting player is a new id, which is spec
 *     12's call (no accounts, no storage) and is unchanged by any of this.
 *
 * The reuse hazard this is written to close is specific and is an AOI hazard
 * rather than a roster one: a client holds an interpolation history keyed by id,
 * so an id recycled onto a *different body* inside the 100 ms buffer draws one
 * person sliding into another. Monotonic allocation makes that unreachable
 * rather than unlikely, which is the same argument `protocol.NPC_BYTES` already
 * makes about why an actor's id is a `u16` where a player's used to be a byte.
 */
export const AOI_ID_LIFECYCLE = 'per-room, from 1, monotonic, wraps at 65535 skipping live ids';

/**
 * Interest management, PERFORMANCE.md phase 2. The three numbers the whole of
 * v8's bandwidth story rests on.
 *
 * A player **enters** another client's working set at `AOI_ENTER_RADIUS` and
 * **leaves** it at `AOI_LEAVE_RADIUS`, and the gap between the two is the whole
 * point: a single radius means two players standing 180.0 m apart enter and
 * leave on alternate snapshots forever, which is 40 bytes a snapshot of
 * enter/leave churn and a remote actor being built and disposed twenty times a
 * second. The band is 40 m, which at a sprint (8.2 m/s) is five seconds of
 * walking -- so a flap needs somebody to run back and forth across the same
 * 40 m, and even then it costs one transition per crossing.
 *
 * `AOI_MAX_PLAYERS` is the hard cap, and it is what makes the *worst* case
 * bounded rather than a function of how many people decided to stand in Martin
 * Place. 40 players is 880 B of player section, 141 kbit/s at 20 Hz -- which is
 * the number the CBD-pileup measurement in PERFORMANCE.md is against.
 *
 * These live here, in the file both ends import, on this file's founding
 * argument: the client does not compute interest (the server does, and a client
 * that computed its own would be a client that could ask for the whole world),
 * but `verifyNet` asserts the arithmetic they imply and `server/aoi.ts` asserts
 * the selection against a brute-force scan. Two copies of 180 would be two
 * copies that drifted.
 */
export const AOI_ENTER_RADIUS = 180;
export const AOI_LEAVE_RADIUS = 220;
export const AOI_MAX_PLAYERS = 40;

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
 * This exchange is measured where it can be: the client sends `clientTime`, the
 * server echoes it, and the client subtracts. The server never sees both ends of
 * *this* one -- it keeps no table of outstanding `MSG.PING`s (deliberately, see
 * above) and the client's ping timer is independent of the reply, so the arrival
 * cadence tells the server nothing about the trip. Adding a second application
 * message type to re-measure a number the client already has, twice a second per
 * player, would be a protocol change for a **scoreboard column**.
 *
 * So the column is what the reporter measured, which is what a ping column is in
 * every game that has one. What matters is what it is *not* wired to: it does
 * **not** feed `Participant.viewTicks`. Spec 8.2's lag compensation rewinds by
 * half a round trip, so a client that could inflate this number would be buying
 * rewind -- claiming half a second to be granted spec 10's full 250 ms cap.
 * Lying about it makes your own ping look bad and does nothing else.
 *
 * The server keeps its own `Conn.rtt` for the rewind, and -- this is the part
 * that went missing for a while -- it now actually *measures* it. Not with a
 * message: with a WebSocket **protocol** ping, one layer below this file, where
 * the peer's network stack answers and the page has no say. That costs no
 * message type and no wire format, which is why the objection above still holds
 * for `MSG.PING` and does not apply to the thing that replaced the constant it
 * was standing in for. See `server/room.ts`'s `HEARTBEAT_MS`.
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
 * The join reply, 35 bytes.
 *
 *     u8   type = MSG.WELCOME
 *     u16  protocol version
 *     u16  your id                 v8: was a u8
 *     u8   your colourway
 *     u8   snapshot Hz
 *     u16  the room you are in     v8: new
 *     u32  server tick
 *     i32  spawn x mm, y mm, z mm  (the eye, as `PlayerState.position` is)
 *     u16  spawn yaw
 *     f64  the server's wall clock v11: new
 *
 * **The clock is the sky's, and it is not the tick.** `tick` is the simulation's
 * count of 60 Hz steps since this *room* started and says nothing about what
 * time of day it is; the clock is epoch milliseconds, on the server's own
 * `Date.now()`, and it is what `sky/cycle.skyClock` is evaluated against so that
 * every client in a room has the street lights on together. See
 * `PROTOCOL_VERSION`'s v11 note for why a raw clock rather than a phase.
 *
 * It is written as late as possible -- in `encodeWelcome` itself would be later
 * still, and is not done, because a message you cannot construct twice and
 * compare is a message with no round-trip test. `server/room.welcome` reads the
 * clock on the line above the call.
 *
 * **One-way latency is the whole of the error and it does not matter.** The
 * client stamps its own `Date.now()` when the frame arrives, so the offset it
 * derives is out by however long the packet took -- call it 10 to 100 ms. A
 * cycle is 3,600,000 ms, so 100 ms is 0.003% of a day: a fortieth of a game
 * second. There is deliberately no clock-sync loop, no round-trip correction and
 * no drift tracking, because the thing being fixed was clients disagreeing by
 * *minutes* and anything that measures in milliseconds is already exact enough.
 *
 * The spawn is in here rather than left to the first snapshot because the client
 * has to place its own predicted body *before* it can predict anything, and a
 * player who spends the first 50 ms at the ENU origin is a player who spends it
 * falling through Alexandria.
 *
 * **The room is here rather than left to the join URL**, and that is v8's one
 * addition to this record. A client may arrive with no `?room=` at all -- which
 * is what a bare `wss://host/ws` is, and what every existing bookmark is -- and
 * the gateway then picks the least-full open room on its behalf. So the room a
 * client is *in* is not always the room it asked for, exactly as the name and the
 * colourway are not always what it asked for, and it is told here for the same
 * reason: so the "invite a friend" link it builds names the room it is actually
 * standing in. See `server/index.ts`'s `/rooms`.
 */
export const WELCOME_BYTES = 35;

export interface Welcome {
  version: number;
  id: number;
  colourway: number;
  snapshotHz: number;
  /** Which room of this host. See `server/room.ts`. */
  room: number;
  tick: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /**
   * The server's `Date.now()` when this was written, epoch ms. v11.
   *
   * **The one clock the day/night cycle is allowed to run on.** See the layout
   * note above and `PROTOCOL_VERSION`'s v11 paragraph.
   */
  clockMs: number;
}

export function encodeWelcome(w: Welcome): ArrayBuffer {
  const buffer = new ArrayBuffer(WELCOME_BYTES);
  const v = new DataView(buffer);
  v.setUint8(0, MSG.WELCOME);
  v.setUint16(1, PROTOCOL_VERSION, true);
  v.setUint16(3, w.id & 0xffff, true);
  v.setUint8(5, w.colourway);
  v.setUint8(6, w.snapshotHz);
  v.setUint16(7, w.room & 0xffff, true);
  v.setUint32(9, w.tick >>> 0, true);
  v.setInt32(13, quantisePos(w.x), true);
  v.setInt32(17, quantisePos(w.y), true);
  v.setInt32(21, quantisePos(w.z), true);
  v.setUint16(25, quantiseYaw(w.yaw), true);
  // Not quantised and not offset from an epoch. A `f64` holds every integer
  // millisecond exactly out to 2^53, which is the year 287396, so the honest
  // encoding is also the cheapest one -- and any narrower field would need an
  // epoch constant that both ends have to keep agreeing about, which is the
  // class of bug this field exists to remove rather than to add.
  v.setFloat64(27, w.clockMs, true);
  return buffer;
}

export function decodeWelcome(buffer: ArrayBuffer): Welcome | null {
  if (buffer.byteLength < WELCOME_BYTES) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== MSG.WELCOME) return null;
  return {
    version: v.getUint16(1, true),
    id: v.getUint16(3, true),
    colourway: v.getUint8(5),
    snapshotHz: v.getUint8(6),
    room: v.getUint16(7, true),
    tick: v.getUint32(9, true),
    x: dequantisePos(v.getInt32(13, true)),
    y: dequantisePos(v.getInt32(17, true)),
    z: dequantisePos(v.getInt32(21, true)),
    yaw: dequantiseYaw(v.getUint16(25, true)),
    clockMs: v.getFloat64(27, true),
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

/**
 * 22 bytes. See the header's bandwidth arithmetic.
 *
 *     u16  id            v8: was a u8, which aliased above 255 players
 *     i32  x, y, z
 *     u16  yaw
 *     i16  pitch
 *     u8   anim
 *     u8   health
 *     u8   stamina | phase << 4
 *     u8   flags | ballCharges << 4
 *
 * **The id is the one field v8 widened here, and PERFORMANCE.md phase 1 is the
 * measurement that says why.** A 500-player load run put two players on id 244
 * and told every client the roster was 244 long; the simulation was honest
 * throughout (its ids are 32-bit and every body was stepped) and the *wire* was
 * not. The byte cost is one per player per snapshot -- 20 B/s per player in view
 * -- against a field that could silently put two people on one interpolation
 * history, which draws one player sliding into another.
 *
 * Interest management (v8's other half) means this record is now paid **per
 * player in view** rather than per player in the room, so the extra byte is
 * charged against 40 records at the very worst and against a handful in an
 * ordinary street. That is the trade the widening was cheap under: 21 B x 128
 * was never going to be sent, and 22 B x 40 is.
 */
export const PLAYER_BYTES = 22;
/**
 * 20 bytes, against a player's 22.
 *
 *     u16  id                  v8: was a u8; 0 is "no ball"
 *     u16  thrower             the combatant id, for "is this mine" and the audio
 *     i32  x, y, z             millimetres, as every position on this wire is
 *     i8   vx, vy, vz          half-metres a second
 *     u8   bounces             0..`footy.MAX_BOUNCES`, which is 30 and still a byte
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
 *
 * **v8 widened both ids and it had to widen `thrower` for a reason the `id`
 * alone would not have forced.** `thrower` is a *player* id, and it is what
 * `net/client.ownBall` compares against to decide not to draw your own throws;
 * at 256 players it aliased onto somebody else, and the symptom is your own ball
 * invisible to you while a stranger's is drawn twice. Widening `id` beside it is
 * the cheaper half of the same argument: ball ids are handed out continuously
 * for the life of a room -- far faster than player ids -- so a byte rolls over
 * every few minutes of a busy game and puts a fresh ball on the interpolation
 * history of one that just died, which draws a football teleporting across the
 * street.
 */
export const BALL_BYTES = 20;
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
 * The `id` was a `u16` here while a player's was a `u8`, and v8 has made the two
 * agree by widening the player rather than narrowing this: actors are promoted
 * and resolved continuously for the whole session, so a byte would roll over
 * every few minutes of a busy pursuit and put a fresh officer on the
 * interpolation history of one who despawned, which draws a body sliding across
 * the city. That argument turned out to be the *player* id's argument too, once
 * a room was 128 people with churn -- see `AOI_ID_LIFECYCLE`.
 *
 * At `factions.MAX_ACTORS` the section is 432 B, which is 8 B under what the
 * twenty-odd players a full working set holds beside it cost. `verifyNet`
 * asserts it against the 500 B cap this feature was scoped with.
 *
 * **v8 filters this section by interest**, on exactly the terms the players are
 * filtered: an officer is in your snapshot when they are inside your working
 * set's radius. The counter-argument in the old text -- *"the actor a player
 * most needs to see is the one that has not arrived yet"* -- survives at the
 * radius that is actually used: 180 m is four city blocks, and an officer four
 * blocks away is not "rounding the corner", they are out of earshot. What that
 * argument was really protecting against is culling at *engagement* range, and
 * `factions.ENGAGE_RANGE` is 45 m.
 */
export const NPC_BYTES = 18;
/**
 * type + tick + ackSeq + player count + ball count + actor count.
 *
 *     u8   type      (0)
 *     u32  tick      (1)
 *     u16  ackSeq    (5)  -- the one per-client field; see `patchSnapshotAck`
 *     u16  players   (7)  -- v8: was a u8, which aliased above 255
 *     u16  balls     (9)  -- v8: was a u8
 *     u8   actors    (11) -- still a byte; `factions.MAX_ACTORS` is 24 per room
 *     u8   aboard    (12) -- v10; bounded by `AOI_MAX_PLAYERS`, which is 40
 *
 * The actor count stayed a byte deliberately rather than by omission. It is the
 * one count in this header that is bounded by a *constant* rather than by a
 * population: `MAX_ACTORS` is 24 and `Simulation.npcSnapshot` clamps to it, so
 * the field cannot alias without that constant moving past 255 first -- at which
 * point the section would be 4.6 kB a snapshot and the count byte would be the
 * least of it.
 */
export const SNAPSHOT_HEADER_BYTES = 13;

/**
 * One rider, 8 bytes, in the carriage's own coordinates.
 *
 *     u16  id            the player, as everywhere else on this wire
 *     u8   line << 4 | dir << 3 | car
 *     u8   tripLow       `trip & 0xff`; see below
 *     i16  lx            along the carriage, 2.5 cm
 *     u8   ly            above rail level, 2.5 cm
 *     i8   lz            across the carriage, 2.5 cm
 *
 * **Why any of this is on the wire at all**, when the player record above
 * already carries a perfectly good world position: because that position is
 * 100 ms old by the time it is drawn. `net/client.ts` renders remotes at
 * `now - INTERP_DELAY_MS`, which is the right rule for a body walking at
 * 4.4 m/s -- it is 44 cm -- and the wrong one for a body standing on a floor
 * doing 44 m/s, where it is **4.4 metres**, or a fifth of a carriage. Two
 * players riding the same train would each see the other sliding along the
 * aisle, permanently one interpolation behind, and a player on the platform
 * would watch them stream past the windows in the wrong seats.
 *
 * Composed instead -- `poseTrain(trip, renderTime)` applied to the local offset
 * -- the answer is exact, because the train's own motion is a closed-form
 * function of the clock that both ends evaluate identically (`checkRail`
 * asserts it bit-for-bit over ten thousand samples). Only the *walking* is
 * interpolated, and only in the carriage's frame, where it is 44 cm again.
 *
 * **2.5 cm, and not the millimetre every other position on this wire uses.**
 * The other fields have to span a 60 km disc and this one spans a carriage, so
 * the argument that fixed their unit does not reach here -- what fixes this one
 * is that it is a *correction to an already-exact composition*. The train's pose
 * is bit-exact; the only thing being quantised is how far along the aisle
 * somebody has walked, against a remote body that is drawn as a 0.34 m capsule
 * and is being interpolated anyway. At the millimetre this record was 13 bytes;
 * at 2.5 cm it is 8, and the difference is a byte-and-a-half per rider per
 * snapshot that nobody can see. `verifyNet` asserts the tolerance rather than
 * trusting the prose.
 *
 * **There is no yaw field, and that is not an omission.** A rider's *world*
 * yaw is already in their ordinary player record two sections up, at the same
 * 1/65,536 of a turn everybody else gets, and world yaw is the only one a
 * receiver draws with. The carriage-local yaw exists on both simulations --
 * `riding.AboardSlot.yaw` -- but the local player's own copy is just their input
 * yaw, which they already have, and nobody else needs it. Sending it would be
 * sending a number that can be derived on one end and is unused on the other.
 *
 * **`trip` is a low byte and it is resolved rather than read.** A trip index is
 * the unbounded departure counter `rail.tripIndexAt` hands out -- it grows
 * forever and is an identity, never an array index -- so it does not fit in a
 * byte and does not need to: the receiver knows `t`, so it knows the handful of
 * departures of that direction that can possibly be running (the longest line in
 * the bake has 27), and exactly one of them ends in the byte that arrived. The
 * alternative, "how many departures back from the newest", is the one that
 * looks cheaper and is wrong: the newest departure changes at the period
 * boundary, so the answer would be off by one for every client whose clock is on
 * the other side of it from the server's.
 *
 * Four bits of line (the bake has ten), one of direction and three of carriage
 * (a consist is eight cars, six on the Metro). `verifyNet` asserts all three.
 *
 * **What the section costs when nobody is riding is one byte** -- the count in
 * the header -- and that is the number this design was chosen for. A snapshot in
 * an ordinary street is v9's snapshot plus 160 bit/s.
 */
export const ABOARD_BYTES = 8;

/** The wire unit of a carriage-local offset, metres. See `ABOARD_BYTES`. */
export const ABOARD_STEP_M = 0.025;

/** Along the carriage: `i16` steps, which reaches far past any carriage. */
export function quantiseAlong(metres: number): number {
  if (!Number.isFinite(metres)) return 0;
  const n = Math.round(metres / ABOARD_STEP_M);
  return n < -32768 ? -32768 : n > 32767 ? 32767 : n;
}

/** Above rail level: `u8` steps, 0 to 6.375 m. An upper-deck eye mid-jump is 5.3. */
export function quantiseRise(metres: number): number {
  if (!Number.isFinite(metres)) return 0;
  const n = Math.round(metres / ABOARD_STEP_M);
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

/** Across the carriage: `i8` steps, +/- 3.175 m against a 1.42 m half-width. */
export function quantiseAcross(metres: number): number {
  if (!Number.isFinite(metres)) return 0;
  const n = Math.round(metres / ABOARD_STEP_M);
  return n < -128 ? -128 : n > 127 ? 127 : n;
}

export function dequantiseLocal(raw: number): number {
  return raw * ABOARD_STEP_M;
}

/** What each of the three fields can hold, metres. Asserted by `verifyNet`. */
export const ABOARD_ALONG_LIMIT_M = 32767 * ABOARD_STEP_M;
export const ABOARD_RISE_LIMIT_M = 255 * ABOARD_STEP_M;
export const ABOARD_ACROSS_LIMIT_M = 127 * ABOARD_STEP_M;

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

/**
 * One rider, decoded. See `ABOARD_BYTES` for the layout and the arguments.
 *
 * `trip` here is the **low byte as it arrived**, not the resolved trip index:
 * this decoder has no bake and no clock, and resolving it needs both. The one
 * caller that can -- `net/client.ts`, which holds the bake the renderer holds --
 * does it against the live set. Decoding it into something that looked like a
 * trip index would be inventing a number.
 */
export interface SnapshotAboard {
  id: number;
  line: number;
  dir: number;
  /** `trip & 0xff`. Resolve against the live departures at the receiver's `t`. */
  tripLow: number;
  car: number;
  /** Carriage-local metres. The rider's eye. Quantised to 2.5 cm on the wire. */
  x: number;
  y: number;
  z: number;
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
  /**
   * Everybody in this snapshot's working set who is on a train, and where in it.
   *
   * Filtered by interest exactly as the players are, because it *is* the
   * players: an entry here is always accompanied by that id's ordinary record
   * above, and a receiver that ignored this section entirely would still draw
   * everybody in the right place to within one interpolation delay. See
   * `ABOARD_BYTES` for what the fifth of a carriage that buys is worth.
   */
  aboard: SnapshotAboard[];
}

export function snapshotBytes(
  playerCount: number, ballCount = 0, npcCount = 0, aboardCount = 0,
): number {
  return (
    SNAPSHOT_HEADER_BYTES +
    playerCount * PLAYER_BYTES +
    ballCount * BALL_BYTES +
    npcCount * NPC_BYTES +
    aboardCount * ABOARD_BYTES
  );
}

export function encodeSnapshot(
  tick: number,
  ackSeq: number,
  players: readonly SnapshotPlayer[],
  balls: readonly SnapshotBall[] = EMPTY_BALLS,
  npcs: readonly SnapshotNpc[] = EMPTY_NPCS,
  aboard: readonly SnapshotAboard[] = EMPTY_ABOARD,
): ArrayBuffer {
  const buffer = new ArrayBuffer(
    snapshotBytes(players.length, balls.length, npcs.length, aboard.length),
  );
  encodeSnapshotInto(new DataView(buffer), tick, ackSeq, players, balls, npcs, aboard);
  return buffer;
}

/**
 * The same bytes, into a buffer the caller owns. Returns the length written.
 *
 * PERFORMANCE.md phase 1. `encodeSnapshot` above allocates its buffer, which is
 * the right shape for the client (which never encodes one) and for a check
 * (which wants a value it can hold) -- and is the **largest allocation site in
 * the server process** by an order of magnitude, because the transport encoded
 * one *per client*. At five hundred players that is 10.5 kB x 500 x 20 Hz, or
 * 105 MB a second of garbage, for a payload whose every byte except a two-byte
 * ack is identical across all five hundred of them.
 *
 * So the server encodes once into a pooled buffer, patches the ack per client
 * with `patchSnapshotAck`, and sends a view. Byte-for-byte the same frame:
 * `encodeSnapshot` is now literally this function with an allocation in front
 * of it, which is what makes "the pooled path and the allocating path produce
 * identical bytes" a fact about the code rather than a check that could drift.
 *
 * The caller must have sized the buffer with `snapshotBytes`. Nothing here
 * grows it, because a snapshot encoder that could reallocate is a snapshot
 * encoder that allocates.
 */
export function encodeSnapshotInto(
  v: DataView,
  tick: number,
  ackSeq: number,
  players: readonly SnapshotPlayer[],
  balls: readonly SnapshotBall[] = EMPTY_BALLS,
  npcs: readonly SnapshotNpc[] = EMPTY_NPCS,
  aboard: readonly SnapshotAboard[] = EMPTY_ABOARD,
): number {
  v.setUint8(0, MSG.SNAPSHOT);
  v.setUint32(1, tick >>> 0, true);
  v.setUint16(5, ackSeq & 0xffff, true);
  v.setUint16(7, players.length & 0xffff, true);
  v.setUint16(9, balls.length & 0xffff, true);
  v.setUint8(11, npcs.length);
  v.setUint8(12, aboard.length & 0xff);
  let p = SNAPSHOT_HEADER_BYTES;
  for (const s of players) {
    v.setUint16(p, s.id & 0xffff, true);
    v.setInt32(p + 2, quantisePos(s.x), true);
    v.setInt32(p + 6, quantisePos(s.y), true);
    v.setInt32(p + 10, quantisePos(s.z), true);
    v.setUint16(p + 14, quantiseYaw(s.yaw), true);
    v.setInt16(p + 16, quantisePitch(s.pitch), true);
    v.setUint8(p + 18, s.anim);
    v.setUint8(p + 19, quantiseHealth(s.health));
    // Stamina is 0..4 and the phase is 0..5, so both fit in one byte with two
    // bits spare. Packed rather than given a byte each because at the counts a
    // working set holds a byte is 6.4 kbit/s of nothing.
    v.setUint8(p + 20, (s.stamina & 0x0f) | ((s.phase & 0x0f) << 4));
    v.setUint8(p + 21, (s.flags & FLAG.MASK) | ((s.ballCharges & 0x03) << FLAG.BALL_SHIFT));
    p += PLAYER_BYTES;
  }
  // The projectile section, after every player. Its own loop and its own record
  // rather than a variable-length tail on a player's, because a ball outlives
  // the tick its thrower left the game on -- a thrown ball is an object in the
  // world and not a property of a person.
  for (const b of balls) {
    v.setUint16(p, b.id & 0xffff, true);
    v.setUint16(p + 2, b.thrower & 0xffff, true);
    v.setInt32(p + 4, quantisePos(b.x), true);
    v.setInt32(p + 8, quantisePos(b.y), true);
    v.setInt32(p + 12, quantisePos(b.z), true);
    v.setInt8(p + 16, quantiseVelocity(b.vx));
    v.setInt8(p + 17, quantiseVelocity(b.vy));
    v.setInt8(p + 18, quantiseVelocity(b.vz));
    v.setUint8(p + 19, b.bounces & 0xff);
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
  // The riders, last, and after the actors on the same argument they sit after
  // the balls: this is a relationship rather than a person, it is usually empty,
  // and a section appended at the end is the one shape a v9 reader would have
  // ignored harmlessly if the version had not been bumped -- which it was, since
  // a v9 reader would also have misread the header byte above.
  for (const a of aboard) {
    v.setUint16(p, a.id & 0xffff, true);
    v.setUint8(p + 2, ((a.line & 0x0f) << 4) | ((a.dir & 1) << 3) | (a.car & 0x07));
    v.setUint8(p + 3, a.tripLow & 0xff);
    v.setInt16(p + 4, quantiseAlong(a.x), true);
    v.setUint8(p + 6, quantiseRise(a.y));
    v.setInt8(p + 7, quantiseAcross(a.z));
    p += ABOARD_BYTES;
  }
  return p;
}

/**
 * Rewrite the two ack bytes of an already-encoded snapshot, in place.
 *
 * The one field that differs between clients. See `encodeSnapshotInto`, and
 * `server/index.ts` for the send loop that uses it.
 */
export function patchSnapshotAck(v: DataView, ackSeq: number): void {
  v.setUint16(5, ackSeq & 0xffff, true);
}

const EMPTY_BALLS: readonly SnapshotBall[] = [];
const EMPTY_NPCS: readonly SnapshotNpc[] = [];
const EMPTY_ABOARD: readonly SnapshotAboard[] = [];

export function decodeSnapshot(buffer: ArrayBuffer, out: Snapshot): Snapshot | null {
  if (buffer.byteLength < SNAPSHOT_HEADER_BYTES) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== MSG.SNAPSHOT) return null;
  out.tick = v.getUint32(1, true);
  out.ackSeq = v.getUint16(5, true);
  const count = v.getUint16(7, true);
  const ballCount = v.getUint16(9, true);
  const npcCount = v.getUint8(11);
  const aboardCount = v.getUint8(12);
  if (buffer.byteLength < snapshotBytes(count, ballCount, npcCount, aboardCount)) return null;
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
    s.id = v.getUint16(p, true);
    s.x = dequantisePos(v.getInt32(p + 2, true));
    s.y = dequantisePos(v.getInt32(p + 6, true));
    s.z = dequantisePos(v.getInt32(p + 10, true));
    s.yaw = dequantiseYaw(v.getUint16(p + 14, true));
    s.pitch = dequantisePitch(v.getInt16(p + 16, true));
    s.anim = v.getUint8(p + 18);
    s.health = dequantiseHealth(v.getUint8(p + 19));
    const sp = v.getUint8(p + 20);
    s.stamina = sp & 0x0f;
    s.phase = (sp >> 4) & 0x0f;
    const fl = v.getUint8(p + 21);
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
    b.id = v.getUint16(p, true);
    b.thrower = v.getUint16(p + 2, true);
    b.x = dequantisePos(v.getInt32(p + 4, true));
    b.y = dequantisePos(v.getInt32(p + 8, true));
    b.z = dequantisePos(v.getInt32(p + 12, true));
    b.vx = dequantiseVelocity(v.getInt8(p + 16));
    b.vy = dequantiseVelocity(v.getInt8(p + 17));
    b.vz = dequantiseVelocity(v.getInt8(p + 18));
    b.bounces = v.getUint8(p + 19);
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
  out.aboard.length = aboardCount;
  for (let i = 0; i < aboardCount; i++) {
    let a = out.aboard[i];
    if (a === undefined) {
      a = { id: 0, line: 0, dir: 0, tripLow: 0, car: 0, x: 0, y: 0, z: 0 };
      out.aboard[i] = a;
    }
    a.id = v.getUint16(p, true);
    const ldc = v.getUint8(p + 2);
    a.line = (ldc >> 4) & 0x0f;
    a.dir = (ldc >> 3) & 1;
    a.car = ldc & 0x07;
    a.tripLow = v.getUint8(p + 3);
    a.x = dequantiseLocal(v.getInt16(p + 4, true));
    a.y = dequantiseLocal(v.getUint8(p + 6));
    a.z = dequantiseLocal(v.getInt8(p + 7));
    p += ABOARD_BYTES;
  }
  return out;
}

export function createSnapshot(): Snapshot {
  return { tick: 0, ackSeq: 0, players: [], balls: [], npcs: [], aboard: [] };
}

// --- Interest: who came into view, and who went out of it -----------------------

/**
 * `InterestEnter.flags`.
 *
 * Two bits, and the second one is the interesting one. `BOT` is what the roster
 * would have said anyway and is here so an entrant is complete without waiting
 * for a refresh. `RIDING` is here because a player who walks into view **on a
 * bike** needs the bike built on the frame they appear: the flag is also in the
 * very next snapshot 0-50 ms later, so this bit is not carrying information the
 * client would never otherwise get -- it is carrying it early enough that the
 * first pose is the right pose rather than a figure running along the footpath
 * in a seated animation for one frame.
 */
export const ENTER_FLAG = {
  BOT: 1 << 0,
  RIDING: 1 << 1,
  /**
   * ...and a third, for `RIDING`'s reason one step on.
   *
   * A player who walks into view **at the wheel of a car** needs the car built
   * on the frame they appear. `MSG.CARS` will tell the client about the record
   * too, but only when the record *changes* -- so a driver who has been circling
   * Redfern for two minutes and finally drives into your interest radius is
   * carried by no `CARS` message at all, and without this bit the first thing
   * you see is a figure in a seated pose sliding down George Street at 22 m/s
   * with no car under them until the next roster refresh.
   *
   * `RIDING` is set as well for a driver -- being in a car is `FLAG.RIDING` plus
   * a `CARS` entry, which is the bike convention verbatim so that every
   * nameplate and animation path keying on `RIDING` keeps working -- and this
   * bit is what tells the two apart.
   */
  DRIVING: 1 << 2,
} as const;

/** Somebody who just came into a client's working set, with everything to draw them. */
export interface InterestEnter {
  id: number;
  colourway: number;
  flags: number;
}

/**
 * What changed about a client's working set this snapshot.
 *
 *     u8   type = MSG.INTEREST
 *     u8   enter count      -- bounded by AOI_MAX_PLAYERS
 *     u8   leave count      -- likewise
 *     per entrant: u16 id, u8 colourway, u8 flags
 *     per leaver:  u16 id
 *
 * Both counts are bytes because both are bounded by `AOI_MAX_PLAYERS`: a working
 * set holds at most 40 members, so at most 40 can join it and at most 40 can
 * leave it in one snapshot. The worst frame this message can be is 3 + 160 + 80 =
 * 243 B, which is one player teleporting into a full pileup and out of another,
 * and is unreachable in practice because a respawn moves you at most a few
 * hundred metres.
 *
 * **Enters are listed before leaves**, and the order is load-bearing when an id
 * appears in both -- which it can, on the tick a player leaves the game and a new
 * joiner is handed... no, it cannot, because `AOI_ID_LIFECYCLE` forbids reuse.
 * The order is fixed anyway so that a decoder never has to think about it.
 */
export const INTEREST_HEADER_BYTES = 3;
export const INTEREST_ENTER_BYTES = 4;
export const INTEREST_LEAVE_BYTES = 2;

export function interestBytes(enters: number, leaves: number): number {
  return INTEREST_HEADER_BYTES + enters * INTEREST_ENTER_BYTES + leaves * INTEREST_LEAVE_BYTES;
}

export function encodeInterest(
  enters: readonly InterestEnter[],
  leaves: readonly number[],
  buffer = new ArrayBuffer(interestBytes(enters.length, leaves.length)),
): ArrayBuffer {
  const v = new DataView(buffer);
  encodeInterestInto(v, enters, leaves);
  return buffer;
}

/**
 * The same bytes into a caller-owned buffer, returning the length written.
 *
 * `encodeSnapshotInto`'s shape and for its reason one message over: this fires
 * per client per snapshot tick on which anything moved in or out of view, which
 * in a busy room is most clients most ticks. A fresh `ArrayBuffer` and a fresh
 * `DataView` for each of them is the allocation site phase 1 spent its whole
 * budget removing from the snapshot, put back on a smaller message.
 *
 * Unlike the snapshot, this is **not** deduplicated across clients -- see
 * `MSG.INTEREST` for why it cannot be -- so the pooling is the whole of the
 * saving here, and the buffer is one per room rather than one per set.
 */
export function encodeInterestInto(
  v: DataView,
  enters: readonly InterestEnter[],
  leaves: readonly number[],
): number {
  v.setUint8(0, MSG.INTEREST);
  v.setUint8(1, Math.min(enters.length, 255));
  v.setUint8(2, Math.min(leaves.length, 255));
  let p = INTEREST_HEADER_BYTES;
  for (const e of enters) {
    v.setUint16(p, e.id & 0xffff, true);
    v.setUint8(p + 2, e.colourway & 0xff);
    v.setUint8(p + 3, e.flags & 0xff);
    p += INTEREST_ENTER_BYTES;
  }
  for (const id of leaves) {
    v.setUint16(p, id & 0xffff, true);
    p += INTEREST_LEAVE_BYTES;
  }
  return p;
}

export function decodeInterest(
  buffer: ArrayBuffer,
): { enters: InterestEnter[]; leaves: number[] } | null {
  if (buffer.byteLength < INTEREST_HEADER_BYTES) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== MSG.INTEREST) return null;
  const enterCount = v.getUint8(1);
  const leaveCount = v.getUint8(2);
  const enters: InterestEnter[] = [];
  const leaves: number[] = [];
  let p = INTEREST_HEADER_BYTES;
  // Bounded by what arrived rather than by what the counts claim, which is
  // `decodeBikes`' rule and the reason it exists: a `DataView` read past the end
  // throws, and a throw inside a socket callback takes the client's whole
  // message pump with it.
  for (let i = 0; i < enterCount && p + INTEREST_ENTER_BYTES <= buffer.byteLength; i++) {
    enters.push({
      id: v.getUint16(p, true),
      colourway: v.getUint8(p + 2),
      flags: v.getUint8(p + 3),
    });
    p += INTEREST_ENTER_BYTES;
  }
  // The leaves start where the **declared** enter section ends, not where the
  // readable one did, and that difference is the whole of this message's
  // truncation rule. Continuing from `p` after a short read would parse the
  // second half of an entrant's record as a leaver's id -- which is a two-byte
  // slice of a colourway and a flags byte, a plausible id, and a remote actor
  // disposed for a player standing right in front of you.
  const leavesAt = INTEREST_HEADER_BYTES + enterCount * INTEREST_ENTER_BYTES;
  if (enters.length === enterCount) {
    p = leavesAt;
    for (let i = 0; i < leaveCount && p + INTEREST_LEAVE_BYTES <= buffer.byteLength; i++) {
      leaves.push(v.getUint16(p, true));
      p += INTEREST_LEAVE_BYTES;
    }
  }
  return { enters, leaves };
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
  /**
   * A bat sent a football back. See `game/swat.ts`.
   *
   * **The one thing in this weapon pair that genuinely is a transition**, which
   * is why it is an event at the same time as the note above is arguing that a
   * thrown ball is not. A ball in flight is state: it is in every snapshot for
   * its whole life, so a client that missed one is corrected by the next. A ball
   * *changing direction because somebody hit it* is a 30 ms crack, a puff of
   * contact and a shudder in the swinger's hands, and none of the three can be
   * recovered from a position twenty times a second -- at 42 m/s the deflection
   * is over inside one snapshot interval, exactly like the bounce that
   * `BALL_BYTES` spends a whole byte on a counter to announce.
   *
   * It carries the ball's post-swat state as well as the two ids, and that is
   * not redundant with the snapshot: the ball's *thrower* is unchanged by a swat
   * -- see `footy.Footy.owner` -- so the player who threw it is still flying
   * their own predicted copy of it and has no other way to be told that the copy
   * is now wrong. The position and velocity here are what corrects it.
   */
  SWAT: 6,
} as const;

export const EVENT_FLAG = {
  KO: 1 << 0,
  /** The hit came from a thrown ball rather than the bat. Decides the sound and the feed verb. */
  FOOTY: 1 << 1,
  /**
   * The ball that landed had been batted back by somebody. Only ever set with
   * `FOOTY`.
   *
   * A bit rather than a field, and a bit rather than nothing, for the same
   * reason `FOOTY` is one: the *consequence* already rides on `attacker`, which
   * the server sets to the ball's owner, so the scoreboard and the knockback are
   * right without this. What is missing without it is the **feed line** -- "%s
   * returned serve on %s" rather than "%s pegged %s" -- and a returned serve is
   * the most interesting thing that can happen in a fight in this game. Losing
   * it to a spare bit in a byte already on the wire would be a strange economy.
   */
  RETURNED: 1 << 2,
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

/**
 * A bat sent a football back. 20 bytes, which is `BALL_BYTES` by coincidence and
 * for the same reasons.
 *
 *     u16  swinger             who swung. The ball's owner from here on.
 *     u16  ball                the ball's own id, unchanged by the swat
 *     i32  x, y, z             millimetres, as every position on this wire is
 *     i8   vx, vy, vz          half-metres a second, as `BALL_BYTES` carries them
 *
 * Three jobs, and the third is the one that makes it carry a position at all:
 *
 *   - **the noise and the puff**, which every client near enough plays at
 *     `(x, y, z)`. A client that has the ball in interest could read the point
 *     off its own copy, but a client 40 m away that is only just inside earshot
 *     may not have it at all -- `aoi.selectBalls` filters by the *ball's*
 *     position -- and a crack with no location cannot be attenuated;
 *   - **the swinger's own feedback**: the connect kick on the viewmodel, which
 *     is keyed on the id rather than on the point;
 *   - **the correction**. The ball's `thrower` is deliberately unchanged by a
 *     swat -- see `footy.Footy.owner` -- so the player who threw it is still
 *     flying a local predicted copy that now disagrees with the server about
 *     which way the ball is going. These six numbers are what puts it right, and
 *     they are the whole reason this is not a four-byte event.
 *
 * The velocity is an i8 of half-metres a second on `BALL_BYTES`' argument
 * exactly, and it survives the same test: a swat leaves the ball at
 * `swat.SWAT_SPEED_SCALE` of the speed it arrived at, so the fastest thing this
 * field can ever carry is 0.85 of the fastest thing the snapshot already does.
 */
export interface SwatEvent {
  kind: 6;
  swinger: number;
  ball: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export type NetEvent = HitEvent | PickupEventFrame | JoinEvent | SwatEvent;

/**
 * A batch of events, `u8 type`, `u8 count`, then each event's own bytes.
 *
 * Every record starts with its kind so the decoder can step past one it does not
 * know -- which is what lets a new event type be added without a protocol bump
 * for clients that do not care about it. That is why each kind's length is a
 * constant here rather than implied by the parse.
 */
const EVENT_BYTES: Record<number, number> = {
  [EVENT.HIT]: 7,
  [EVENT.PICKUP]: 10,
  [EVENT.JOIN]: 5,
  [EVENT.LEAVE]: 5,
  [EVENT.SWAT]: 20,
};

/**
 * type + count. v8 made the count a `u16`.
 *
 * A byte was right at sixteen players and is not at a hundred and twenty-eight:
 * events fire on transitions, but a tick in which the traffic runs over a dozen
 * people while a pileup lands twenty punches is a real tick, and a count that
 * wrapped would not truncate the batch -- it would tell the decoder to read
 * *fewer* records than were written and leave the rest as a well-formed frame
 * nobody parses. That is the quietest possible failure: a kill feed that
 * occasionally misses lines, under load only.
 */
export const EVENTS_HEADER_BYTES = 3;

export function encodeEvents(events: readonly NetEvent[]): ArrayBuffer {
  let total = EVENTS_HEADER_BYTES;
  for (const e of events) total += EVENT_BYTES[e.kind] ?? 0;
  const buffer = new ArrayBuffer(total);
  const v = new DataView(buffer);
  v.setUint8(0, MSG.EVENTS);
  v.setUint16(1, Math.min(events.length, 65535), true);
  let p = EVENTS_HEADER_BYTES;
  for (const e of events) {
    v.setUint8(p, e.kind);
    if (e.kind === EVENT.HIT) {
      v.setUint16(p + 1, e.attacker & 0xffff, true);
      v.setUint16(p + 3, e.victim & 0xffff, true);
      v.setUint8(p + 5, e.flags);
      v.setUint8(p + 6, quantiseHealth(e.health));
    } else if (e.kind === EVENT.PICKUP) {
      v.setUint16(p + 1, e.combatant & 0xffff, true);
      v.setUint8(p + 3, e.powerup);
      v.setInt16(p + 4, e.tileX, true);
      v.setInt16(p + 6, e.tileZ, true);
      v.setUint16(p + 8, e.index, true);
    } else if (e.kind === EVENT.SWAT) {
      // The snapshot's own quantisers, deliberately: the receiver's correction
      // has to land on the same millimetre the next snapshot will, or a ball is
      // put right by this event and then jumped by the one after it.
      v.setUint16(p + 1, e.swinger & 0xffff, true);
      v.setUint16(p + 3, e.ball & 0xffff, true);
      v.setInt32(p + 5, quantisePos(e.x), true);
      v.setInt32(p + 9, quantisePos(e.y), true);
      v.setInt32(p + 13, quantisePos(e.z), true);
      v.setInt8(p + 17, quantiseVelocity(e.vx));
      v.setInt8(p + 18, quantiseVelocity(e.vy));
      v.setInt8(p + 19, quantiseVelocity(e.vz));
    } else {
      v.setUint16(p + 1, e.id & 0xffff, true);
      v.setUint8(p + 3, e.colourway);
      v.setUint8(p + 4, e.bot);
    }
    p += EVENT_BYTES[e.kind];
  }
  return buffer;
}

export function decodeEvents(buffer: ArrayBuffer): NetEvent[] | null {
  if (buffer.byteLength < EVENTS_HEADER_BYTES) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== MSG.EVENTS) return null;
  const count = v.getUint16(1, true);
  const out: NetEvent[] = [];
  let p = EVENTS_HEADER_BYTES;
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
        attacker: v.getUint16(p + 1, true),
        victim: v.getUint16(p + 3, true),
        flags: v.getUint8(p + 5),
        health: dequantiseHealth(v.getUint8(p + 6)),
      });
    } else if (kind === EVENT.PICKUP) {
      out.push({
        kind: EVENT.PICKUP,
        combatant: v.getUint16(p + 1, true),
        powerup: v.getUint8(p + 3),
        tileX: v.getInt16(p + 4, true),
        tileZ: v.getInt16(p + 6, true),
        index: v.getUint16(p + 8, true),
      });
    } else if (kind === EVENT.SWAT) {
      out.push({
        kind: EVENT.SWAT,
        swinger: v.getUint16(p + 1, true),
        ball: v.getUint16(p + 3, true),
        x: dequantisePos(v.getInt32(p + 5, true)),
        y: dequantisePos(v.getInt32(p + 9, true)),
        z: dequantisePos(v.getInt32(p + 13, true)),
        vx: dequantiseVelocity(v.getInt8(p + 17)),
        vy: dequantiseVelocity(v.getInt8(p + 18)),
        vz: dequantiseVelocity(v.getInt8(p + 19)),
      });
    } else {
      out.push({
        kind: kind as 4 | 5,
        id: v.getUint16(p + 1, true),
        colourway: v.getUint8(p + 3),
        bot: v.getUint8(p + 4),
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
/**
 * 2 + 2 + 4 + 4 + 4 + 2. Asserted in `verifyNet`, which is how it got right.
 *
 * v8 widened `rider` from a byte to a `u16` because it is a *player* id, and an
 * aliased rider is the worst-behaved of all the widenings in this pass: the
 * client derives "which bike am I on" by scanning this list for its own id (see
 * `net/client.ts`'s BIKES case), so at 256 players two people would each be
 * told they are riding the same bike, and both would get the chase camera.
 */
export const BIKE_RECORD_BYTES = 18;

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
    v.setUint16(p + 2, b.rider & 0xffff, true);
    v.setInt32(p + 4, quantisePos(b.x), true);
    v.setInt32(p + 8, quantisePos(b.y), true);
    v.setInt32(p + 12, quantisePos(b.z), true);
    v.setUint16(p + 16, quantiseYaw(b.yaw), true);
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
      rider: v.getUint16(p + 2, true),
      x: dequantisePos(v.getInt32(p + 4, true)),
      y: dequantisePos(v.getInt32(p + 8, true)),
      z: dequantisePos(v.getInt32(p + 12, true)),
      yaw: dequantiseYaw(v.getUint16(p + 16, true)),
    });
    p += BIKE_RECORD_BYTES;
  }
  return out;
}

// --- Driven cars ----------------------------------------------------------------

/**
 * Which cars have been taken, who is in them, and which ones are gone.
 *
 *     u8   type = MSG.CARS
 *     u16  count
 *     u8   flags        CARS_FULL on the set a joiner is sent
 *     per car:
 *       u16  id         `CarField`'s allocation id, 1..n; 0 is "no car"
 *       u32  carId      `traffic.identityOf(route, slot)`: which ambient car this was
 *       u16  driver     the combatant id, or 0 for one standing in the street
 *       u8   model      body << 4 | colour
 *       u8   flags      CAR_REMOVED
 *       i32  x, y, z    millimetres, as every position on this wire is
 *       u16  yaw
 *       i16  speed      centimetres per second, signed
 *
 * **Upsert semantics with an explicit delete**, which is the one place this
 * diverges from `MSG.BIKES` one section up, and the divergence is forced. A bike
 * is *planned*: the set is fixed by `bikes.bikePlan` for the life of a build, so
 * a receiver that merges by id and never removes anything is complete. A car is
 * *allocated*: the set is however many cars have been stolen and not yet
 * expired, and it shrinks. Inferring a removal from absence would mean every
 * message had to be the whole set, which is exactly the cost the upsert exists
 * to avoid -- so a removal is a record with `CAR_REMOVED` set, and everything
 * else about that record is ignored.
 *
 * `CARS_FULL` on the header is the joiner's set, and it means "replace, do not
 * merge". Without it a client that reconnected to a restarted server would carry
 * its old records forever, suppressing ambient cars nobody is driving.
 *
 * **The pose of an occupied car is here and is also stale, on purpose.** While
 * somebody is driving, the car's real position is derived from that driver's
 * snapshot record 20 times a second (`driving.CarField.follow`), and this
 * message's copy is only as fresh as the last change. It matters for exactly two
 * cases and both are worth the twelve bytes: an **empty** car, whose pose is
 * derived from nothing at all, and the frame a car is **taken**, where the
 * record arrives before the driver's next snapshot does.
 *
 * At a plausible worst case -- a dozen cars taken in a busy room -- the join
 * message is 316 B, and a single theft is 30 B.
 */
export interface CarRecord {
  id: number;
  carId: number;
  driver: number;
  /** `world/cars.CAR_BODY_SIZE` index, 0..4. */
  body: number;
  /** `world/cars.CAR_PAINT` index, 0..7. */
  colour: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Signed, m/s. */
  speed: number;
  /** True for "this record is gone", and then every field but `id` is meaningless. */
  removed?: boolean;
}

/** Header flag: this message is the whole set and replaces whatever the client had. */
export const CARS_FULL = 1 << 0;
/** Record flag: forget this id. */
export const CAR_REMOVED = 1 << 0;

export const CARS_HEADER_BYTES = 4;
/** 2 + 4 + 2 + 1 + 1 + 4 + 4 + 4 + 2 + 2. Asserted in `verifyNet`, which is how it got right. */
export const CAR_RECORD_BYTES = 26;

export function carsBytes(count: number): number {
  return CARS_HEADER_BYTES + count * CAR_RECORD_BYTES;
}

/**
 * A speed as centimetres per second in an `i16`.
 *
 * Range +/- 327 m/s against a top speed of 22, so the clamp is unreachable in
 * play and is here for the same reason every other clamp on this wire is: a
 * `setInt16` given 40,000 wraps silently and the car goes backwards.
 */
function quantiseCarSpeed(v: number): number {
  const cm = Math.round(v * 100);
  return cm < -32768 ? -32768 : cm > 32767 ? 32767 : cm;
}

export function encodeCars(cars: readonly CarRecord[], full = false): ArrayBuffer {
  const buffer = new ArrayBuffer(carsBytes(cars.length));
  const v = new DataView(buffer);
  v.setUint8(0, MSG.CARS);
  v.setUint16(1, cars.length, true);
  v.setUint8(3, full ? CARS_FULL : 0);
  let p = CARS_HEADER_BYTES;
  for (const c of cars) {
    v.setUint16(p, c.id & 0xffff, true);
    v.setUint32(p + 2, c.carId >>> 0, true);
    v.setUint16(p + 6, c.driver & 0xffff, true);
    // Both indices are small and fixed -- five bodies, eight paints -- so they
    // share a byte rather than costing two. Masked rather than trusted: a body
    // index that overflowed into the colour nibble would repaint the fleet.
    v.setUint8(p + 8, ((c.body & 0x0f) << 4) | (c.colour & 0x0f));
    v.setUint8(p + 9, c.removed ? CAR_REMOVED : 0);
    v.setInt32(p + 10, quantisePos(c.x), true);
    v.setInt32(p + 14, quantisePos(c.y), true);
    v.setInt32(p + 18, quantisePos(c.z), true);
    v.setUint16(p + 22, quantiseYaw(c.yaw), true);
    v.setInt16(p + 24, quantiseCarSpeed(c.speed), true);
    p += CAR_RECORD_BYTES;
  }
  return buffer;
}

export function decodeCars(buffer: ArrayBuffer): { cars: CarRecord[]; full: boolean } | null {
  if (buffer.byteLength < CARS_HEADER_BYTES) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== MSG.CARS) return null;
  const count = v.getUint16(1, true);
  const full = (v.getUint8(3) & CARS_FULL) !== 0;
  const cars: CarRecord[] = [];
  let p = CARS_HEADER_BYTES;
  // Bounded by what arrived rather than by what the count claims, on
  // `decodeBikes`' rule and for its reason: a `DataView` read past the end
  // throws, and a throw inside a socket callback takes the client's whole
  // message pump with it.
  for (let i = 0; i < count && p + CAR_RECORD_BYTES <= buffer.byteLength; i++) {
    const model = v.getUint8(p + 8);
    cars.push({
      id: v.getUint16(p, true),
      carId: v.getUint32(p + 2, true),
      driver: v.getUint16(p + 6, true),
      body: (model >> 4) & 0x0f,
      colour: model & 0x0f,
      removed: (v.getUint8(p + 9) & CAR_REMOVED) !== 0,
      x: dequantisePos(v.getInt32(p + 10, true)),
      y: dequantisePos(v.getInt32(p + 14, true)),
      z: dequantisePos(v.getInt32(p + 18, true)),
      yaw: dequantiseYaw(v.getUint16(p + 22, true)),
      speed: v.getInt16(p + 24, true) / 100,
    });
    p += CAR_RECORD_BYTES;
  }
  return { cars, full };
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

export const INVESTIGATION_HEADER_BYTES = 3;
export const INVESTIGATION_ENTRY_BYTES = 5;

export function investigationBytes(count: number): number {
  return INVESTIGATION_HEADER_BYTES + count * INVESTIGATION_ENTRY_BYTES;
}

export function encodeInvestigations(
  records: readonly InvestigationRecord[],
  buffer = new ArrayBuffer(investigationBytes(records.length)),
): ArrayBuffer {
  const v = new DataView(buffer);
  encodeInvestigationsInto(v, records);
  return buffer;
}

/**
 * The same bytes into a caller-owned buffer, returning the length written.
 *
 * v8 needs this because the message became **per client**: an investigation is
 * carried for a player you can see, plus always your own -- see
 * `server/room.ts`. At the two-second refresh a room of 128 would otherwise
 * allocate 128 small buffers every two seconds forever, to say "nobody is
 * wanted" a hundred and twenty-eight times.
 *
 * The room dedupes on top of this (most clients are sent the identical empty
 * frame), so in the ordinary case the pool is written once and sent many times,
 * which is `encodeSnapshotInto`'s arrangement at a hundredth of the rate.
 */
export function encodeInvestigationsInto(v: DataView, records: readonly InvestigationRecord[]): number {
  v.setUint8(0, MSG.INVESTIGATION);
  v.setUint16(1, Math.min(records.length, 65535), true);
  let p = INVESTIGATION_HEADER_BYTES;
  for (const r of records) {
    v.setUint16(p, r.playerId & 0xffff, true);
    v.setUint8(p + 2, r.reason & 0xff);
    // Clamped rather than wrapped, on `quantisePing`'s argument: a wrapped
    // countdown would draw eighteen minutes of pursuit as one second left, which
    // is the one number in this message a player is actually reading.
    v.setUint16(p + 3, Math.max(0, Math.min(65535, Math.round(r.ticks))), true);
    p += INVESTIGATION_ENTRY_BYTES;
  }
  return p;
}

export function decodeInvestigations(buffer: ArrayBuffer): InvestigationRecord[] | null {
  if (buffer.byteLength < INVESTIGATION_HEADER_BYTES) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== MSG.INVESTIGATION) return null;
  const count = v.getUint16(1, true);
  const out: InvestigationRecord[] = [];
  let p = INVESTIGATION_HEADER_BYTES;
  // Bounded by what arrived rather than by what the count claims, which is
  // `decodeBikes`' rule and the reason it exists: a `DataView` read past the end
  // throws, and a throw inside a socket callback takes the client's whole
  // message pump with it.
  for (let i = 0; i < count && p + INVESTIGATION_ENTRY_BYTES <= buffer.byteLength; i++) {
    out.push({
      playerId: v.getUint16(p, true),
      reason: v.getUint8(p + 2),
      ticks: v.getUint16(p + 3, true),
    });
    p += INVESTIGATION_ENTRY_BYTES;
  }
  return out;
}

// --- The screaming sun ---------------------------------------------------------

/**
 * `MSG.SUN_PRESS`, one byte.
 *
 * An encoder for a message with no fields looks like ceremony and is not. It is
 * the same ceremony `encodeInput` is: this file is the only place in the repo
 * that writes a message id, so a caller that hand-rolled `new Uint8Array([0x0d])`
 * would be a second place the wire is defined and the one place a renumbering
 * would not reach.
 */
export function encodeSunPress(buffer = new ArrayBuffer(1)): ArrayBuffer {
  new DataView(buffer).setUint8(0, MSG.SUN_PRESS);
  return buffer;
}

/** True if this frame is a well-formed `SUN_PRESS`. There is nothing else to say. */
export function decodeSunPress(buffer: ArrayBuffer): boolean {
  return buffer.byteLength >= 1 && new DataView(buffer).getUint8(0) === MSG.SUN_PRESS;
}

/**
 * `MSG.SUN`, seventeen bytes:
 *
 *     u8   type = MSG.SUN
 *     f64  screamUntilMs
 *     f64  cooldownUntilMs
 *
 * **Two `f64`s, for `Welcome.clockMs`' reason, stated once more because it is
 * the only interesting thing about this layout.** These are absolute epoch
 * milliseconds on the server's clock, and epoch milliseconds passed 2^32 in
 * 1970 -- a `u32` of them is not a clock, it is a clock modulo 49 days. An `f64`
 * holds every integer to 2^53, so there is no quantisation, no separate epoch to
 * agree about, and no arithmetic on the receiving end beyond a comparison.
 *
 * The **alternative was two `u16`s of remaining seconds**, which is four bytes
 * instead of sixteen and is wrong for the reason `game/sunbutton.ts`'s header
 * gives at length: a remaining time has to be counted down by somebody, and the
 * somebody would be a client whose tab was backgrounded for four minutes.
 * `INVESTIGATION` sends a countdown and gets away with it because it is
 * re-sent every two seconds; this is sent once and must still be right an hour
 * later.
 *
 * There is **no "screaming" boolean** on the wire, and there must not be: it is
 * `now < screamUntilMs`, derivable by both ends from the same two numbers, and a
 * flag beside the instant it is derived from is a second owner of one fact --
 * which is the disease `/health`'s `vessels` field exists to catch.
 */
export const SUN_BYTES = 17;

export function encodeSun(
  screamUntilMs: number,
  cooldownUntilMs: number,
  buffer = new ArrayBuffer(SUN_BYTES),
): ArrayBuffer {
  const v = new DataView(buffer);
  v.setUint8(0, MSG.SUN);
  v.setFloat64(1, screamUntilMs, true);
  v.setFloat64(9, cooldownUntilMs, true);
  return buffer;
}

export function decodeSun(
  buffer: ArrayBuffer,
): { screamUntilMs: number; cooldownUntilMs: number } | null {
  if (buffer.byteLength < SUN_BYTES) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== MSG.SUN) return null;
  return {
    screamUntilMs: v.getFloat64(1, true),
    cooldownUntilMs: v.getFloat64(9, true),
  };
}

// --- Heat ------------------------------------------------------------------------

/**
 * How wanted everybody is, in stars.
 *
 *     u8   type = MSG.HEAT
 *     u16  count
 *     per entry:
 *       u16  player id
 *       u8   stars              0..`heat.HEAT_MAX`
 *       u16  decay ticks left   0 while the police can still see them
 *
 * **A replacement, not an upsert**, which is `MSG.INVESTIGATION`'s call one
 * section up and is right here for the identical reason: heat all ends, the end
 * is the interesting event, and a delete record that went missing would be four
 * stars painted on a player who is no longer wanted -- which on a nameplate is a
 * target somebody else will act on.
 *
 * **Room-global, not interest-filtered**, which is where it *differs* from the
 * investigation channel. That one is filtered because a banner over somebody you
 * cannot see is a fact about nobody; this one is drawn on nameplates, and a
 * nameplate is only drawn for a player you can already see -- so the filter
 * would be recomputing on the server a thing the renderer decides anyway. At
 * five bytes an entry the full set for a room of sixteen is 83 bytes, a few
 * times a minute.
 *
 * **The decay clock is sent as a countdown and read as a deadline.** The record
 * this file hands out carries `decayEndsTick`, an absolute tick on
 * `traffic.trafficTick`'s shared wall clock -- which is what every consumer
 * actually wants, because it can be compared against `trafficTick(Date.now())`
 * on any frame with no clock of its own. What crosses the wire is the
 * *remainder*, a `u16`, for the reason `quantisePing` gives about wrapping: an
 * absolute tick is about 1.9 billion a year off the traffic epoch, so it does
 * not fit a `u32` for the life of the build and a `f64` would be eight bytes to
 * say "twenty seconds". The decoder adds the receiver's own tick back, which is
 * exact to the tick that the two machines' clocks agree -- and `protocol` v11
 * already publishes the server's clock at join precisely so that they do.
 *
 * Zero is **not** a deadline. It means "the police still have eyes on them", and
 * it is a distinct state rather than a very small number: what the HUD wants to
 * draw is whether you are getting away, and a client deriving that from a
 * countdown near zero would show the star about to fall at the exact moment an
 * officer walked round the corner.
 */
export interface HeatRecord {
  playerId: number;
  stars: number;
  /** Absolute tick, on the shared wall clock, or 0 while they are still seen. */
  decayEndsTick: number;
}

export const HEAT_HEADER_BYTES = 3;
export const HEAT_ENTRY_BYTES = 5;

export function heatBytes(count: number): number {
  return HEAT_HEADER_BYTES + count * HEAT_ENTRY_BYTES;
}

/**
 * `records` into a fresh buffer. `now` is the sender's tick, which is what the
 * absolute deadlines are made relative to.
 */
export function encodeHeat(
  records: readonly HeatRecord[],
  now: number,
  buffer = new ArrayBuffer(heatBytes(records.length)),
): ArrayBuffer {
  const v = new DataView(buffer);
  encodeHeatInto(v, records, now);
  return buffer;
}

/** The same bytes into a caller-owned buffer, returning the length written. */
export function encodeHeatInto(v: DataView, records: readonly HeatRecord[], now: number): number {
  v.setUint8(0, MSG.HEAT);
  v.setUint16(1, Math.min(records.length, 65535), true);
  let p = HEAT_HEADER_BYTES;
  for (const r of records) {
    v.setUint16(p, r.playerId & 0xffff, true);
    v.setUint8(p + 2, Math.max(0, Math.min(255, Math.round(r.stars))));
    // Clamped, never wrapped -- `encodeInvestigations` states the argument and
    // it is the same one: a wrapped countdown would draw two minutes of hiding
    // as one second left, which is the only number in this message a player
    // reads as a promise.
    const left = r.decayEndsTick > 0 ? Math.round(r.decayEndsTick - now) : 0;
    v.setUint16(p + 3, Math.max(0, Math.min(65535, left)), true);
    p += HEAT_ENTRY_BYTES;
  }
  return p;
}

/** `now` is the *receiver's* tick. See the layout note on the deadline. */
export function decodeHeat(buffer: ArrayBuffer, now: number): HeatRecord[] | null {
  if (buffer.byteLength < HEAT_HEADER_BYTES) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== MSG.HEAT) return null;
  const count = v.getUint16(1, true);
  const out: HeatRecord[] = [];
  let p = HEAT_HEADER_BYTES;
  // Bounded by what arrived rather than by what the count claims. See
  // `decodeBikes`: a `DataView` read past the end throws, and a throw inside a
  // socket callback takes the client's whole message pump with it.
  for (let i = 0; i < count && p + HEAT_ENTRY_BYTES <= buffer.byteLength; i++) {
    const left = v.getUint16(p + 3, true);
    out.push({
      playerId: v.getUint16(p, true),
      stars: v.getUint8(p + 2),
      decayEndsTick: left > 0 ? now + left : 0,
    });
    p += HEAT_ENTRY_BYTES;
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

/**
 * type + count. v8 made the count a `u16` and the id inside an entry a `u16`.
 *
 * **The roster stays room-global under interest management**, and that is the
 * decision worth stating beside the widening. Everything else in v8 is filtered
 * by what a client can see; this is not, because a name and a score are *social*
 * rather than spatial -- a leaderboard that only listed the people within 180 m
 * would be a leaderboard that reordered itself as you walked, and the player at
 * the top of it would be invisible to whoever is second. It is also the channel
 * that makes an out-of-interest knockout printable: the kill feed names an id
 * off this table (see `net/client.nameOf`), so a cross-town KO still reads as
 * "Bazza batted Shazza" rather than as two numbers.
 *
 * What that costs at a full room, measured against the message's own arithmetic:
 * 128 entries at 11 + name is about 2.4 kB, on change plus a two-second refresh
 * -- 9.6 kbit/s, against the ~30 kbit/s a client's snapshots now cost. That is a
 * third of the stream to carry the thing AOI cannot filter, and it is why the
 * refresh is two seconds rather than one.
 */
export const ROSTER_HEADER_BYTES = 3;
/** Everything in an entry except the name itself. */
export const ROSTER_ENTRY_BYTES = 11;

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
  v.setUint16(1, Math.min(entries.length, 65535), true);
  let p = ROSTER_HEADER_BYTES;
  for (const e of entries) {
    const name = NAME_ENCODER.encode(e.name).subarray(0, MAX_NAME_BYTES);
    v.setUint16(p, e.id & 0xffff, true);
    v.setUint8(p + 2, e.colourway);
    v.setUint8(p + 3, e.bot ? 1 : 0);
    v.setUint16(p + 4, Math.max(0, Math.min(65535, e.kos)), true);
    v.setUint16(p + 6, Math.max(0, Math.min(65535, e.downs)), true);
    v.setUint16(p + 8, quantisePing(e.ping), true);
    v.setUint8(p + 10, name.length);
    bytes.set(name, p + ROSTER_ENTRY_BYTES);
    p += ROSTER_ENTRY_BYTES + name.length;
  }
  return buffer;
}

export function decodeRoster(buffer: ArrayBuffer): RosterEntry[] | null {
  if (buffer.byteLength < ROSTER_HEADER_BYTES) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== MSG.ROSTER) return null;
  const count = v.getUint16(1, true);
  const out: RosterEntry[] = [];
  let p = ROSTER_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    // A truncated tail drops the rest rather than reading past the end, which
    // `DataView` throws on -- and a throw inside a socket callback takes the
    // whole client's message pump with it. `decodeEvents` refuses the same way.
    if (p + ROSTER_ENTRY_BYTES > buffer.byteLength) break;
    const nameLen = v.getUint8(p + 10);
    if (p + ROSTER_ENTRY_BYTES + nameLen > buffer.byteLength) break;
    out.push({
      id: v.getUint16(p, true),
      colourway: v.getUint8(p + 2),
      bot: (v.getUint8(p + 3) & 1) !== 0,
      kos: v.getUint16(p + 4, true),
      downs: v.getUint16(p + 6, true),
      ping: v.getUint16(p + 8, true),
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

// --- The gateway --------------------------------------------------------------

/**
 * One room, as `GET /rooms` describes it.
 *
 * The only thing in this file that is **not binary**, and it is here anyway. The
 * join flow is a protocol -- the client asks a host what rooms it has and then
 * connects to one -- and a protocol that lived only in the client would be a
 * protocol the server's own checks could not assert. It is JSON rather than a
 * frame because it is fetched over HTTP before any socket exists, and because it
 * is 45 bytes a room fetched once per session: a binary encoding of four numbers
 * would save nothing and would need a decoder in a place that has none.
 *
 *     [{ "id": 0, "players": 41, "cap": 128, "open": true }, ...]
 *
 * `open` is a field rather than `players < cap` derived, because "open" is the
 * server's answer and may one day mean more than occupancy -- a room draining
 * for a restart, a private room. A client that derived it would be a client that
 * ignored the difference.
 */
export interface RoomInfo {
  id: number;
  players: number;
  cap: number;
  open: boolean;
}

/**
 * Which room to join: the one asked for if it exists, else the emptiest open one.
 *
 * Returns **null for "let the server decide"**, which is what an empty listing,
 * an unreachable gateway or a full house all produce -- and which the server
 * handles identically to a bare connection with no `?room=` at all. That is the
 * property which keeps every pre-phase-3 bookmark working.
 *
 * **Emptiest rather than fullest**, which is the opposite of a matchmaker that
 * wants full games and is right here for a reason specific to this architecture:
 * a room holds 128 and interest management means you only ever see forty of
 * them, so packing a room to its cap buys nobody a better game and costs
 * everybody in it the CBD-pileup bandwidth. Ties break on the id so two friends
 * who click at the same moment land together rather than being split by
 * whichever listing each of them happened to read.
 *
 * A named room that is **full** is still returned, rather than silently swapped
 * for an open one. The server refuses it with a `BYE` naming the room and its
 * cap, and the player reads that -- which is a better answer than being dropped
 * into a different city with no explanation and no friend in it.
 *
 * Here rather than in `net/client.ts` for `rankRoster`'s reason one section up:
 * the integration check has to assert it, and that file imports `three`.
 */
export function chooseRoom(rooms: readonly RoomInfo[], asked: number | null): number | null {
  if (asked !== null && rooms.some((r) => r.id === asked)) return asked;
  if (asked !== null && rooms.length === 0) return asked;
  let best: RoomInfo | null = null;
  for (const r of rooms) {
    if (!r.open) continue;
    if (best === null || r.players < best.players || (r.players === best.players && r.id < best.id)) best = r;
  }
  return best === null ? null : best.id;
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

  // --- v10's carriage-local 2.5 cm steps, over the box a carriage actually is
  // and past all three ends of the field. See `ABOARD_BYTES`.
  //
  // The extremes are the point, again: an `lz` that *wrapped* would put a rider
  // through the far bodyside of a train doing 130 km/h, and the platform
  // observer would watch them ride the outside of the carriage all the way to
  // Central. Clamped, the worst a broken table can do is stick somebody to a
  // wall. The three fields have three different widths because they measure
  // three different things -- 20 m of carriage, 6 m of double deck, 3 m of
  // width -- so each is tested against its own limit.
  for (const m of [0, 0.025, -0.025, 1.42, -1.42, 11.6, -11.6, 900, -900]) {
    const back = dequantiseLocal(quantiseAlong(m));
    const want = Math.max(-ABOARD_ALONG_LIMIT_M - ABOARD_STEP_M, Math.min(ABOARD_ALONG_LIMIT_M, m));
    if (Math.abs(back - want) > ABOARD_STEP_M / 2 + 1e-9) {
      failures.push(`A carriage-local along-offset of ${m} m round-tripped to ${back} m.`);
    }
  }
  for (const m of [0, -3, 0.39, 1.16, 2.07, 4.19, 5.32, 6.375, 90]) {
    const back = dequantiseLocal(quantiseRise(m));
    const want = Math.max(0, Math.min(ABOARD_RISE_LIMIT_M, m));
    if (Math.abs(back - want) > ABOARD_STEP_M / 2 + 1e-9) {
      failures.push(`A carriage-local rise of ${m} m round-tripped to ${back} m.`);
    }
  }
  for (const m of [0, 1.084, -1.084, 1.42, -1.42, 3.175, -3.175, 90, -90]) {
    const back = dequantiseLocal(quantiseAcross(m));
    const want = Math.max(-ABOARD_ACROSS_LIMIT_M - ABOARD_STEP_M, Math.min(ABOARD_ACROSS_LIMIT_M, m));
    if (Math.abs(back - want) > ABOARD_STEP_M / 2 + 1e-9) {
      failures.push(`A carriage-local across-offset of ${m} m round-tripped to ${back} m.`);
    }
  }
  // The widest carriage in `game/riding.INTERIORS` is 20.3 m of interior and the
  // tallest place to stand in one is the upper deck of a Tangara. Both have to
  // be inside their own field with room for a jump, or the clamp above becomes
  // a rider stuck to a bulkhead rather than a guard that never fires.
  if (ABOARD_ALONG_LIMIT_M < 12 || ABOARD_RISE_LIMIT_M < 5.5 || ABOARD_ACROSS_LIMIT_M < 1.8) {
    failures.push(
      `The aboard record reaches ${ABOARD_ALONG_LIMIT_M.toFixed(2)} m along, ` +
        `${ABOARD_RISE_LIMIT_M.toFixed(2)} m up and ${ABOARD_ACROSS_LIMIT_M.toFixed(2)} m across; ` +
        `a carriage needs 12, 5.5 and 1.8.`,
    );
  }
  if (dequantiseLocal(quantiseAlong(NaN)) !== 0 || dequantiseLocal(quantiseRise(NaN)) !== 0) {
    failures.push('A NaN carriage offset did not quantise to zero.');
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
      //
      // **And its id is 40,000**, which is v8's whole point in one field. A `u8`
      // -- which this was through v7 -- writes 40000 & 0xff = 64, so this player
      // silently becomes player 64 and shares an interpolation history with
      // whoever that is. PERFORMANCE.md phase 1 measured exactly this above 255
      // players and said the protocol had to widen; this is the assertion that
      // it did.
      { id: 40000, x: 12.3, y: 4.5, z: -67.8, yaw: 1, pitch: -1, anim: ANIM.WINDUP, health: 1.6, stamina: 3, phase: 1, flags: FLAG.ON_GROUND | FLAG.RIDING | FLAG.TUNED, ballCharges: 1 },
    ];
    // Three balls with the section's own extremes in them: a fast one climbing,
    // one that has bounced its whole budget, and one at the origin with a zero
    // velocity -- which is the record a settling ball produces and the one a
    // sign error in the velocity field shows up on.
    const balls: SnapshotBall[] = [
      { id: 1, thrower: 7, x: -1234.56, y: 43.25, z: 987.65, vx: 18.5, vy: 9, vz: -12.5, bounces: 0 },
      // A ball id and a thrower id that both need the v8 width. The thrower is
      // the player four rows up, which is what `net/client.ownBall` compares
      // against to decide not to draw your own throws -- so an aliased thrower
      // is your own ball invisible to you and a stranger's drawn twice.
      { id: 60000, thrower: 40000, x: 3999.99, y: -70.125, z: -3999.99, vx: -4.5, vy: -0.5, vz: 3, bounces: 3 },
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
    // Two riders, and they are the two the section has to get right: the same
    // 40,000-id player from the array above -- so a rider is provably a normal
    // player as well -- standing at the far end of the eighth carriage of a
    // suburban set, and one on the upper deck of the second carriage of the
    // other direction of the same line. Between them they exercise the
    // direction bit, the three-bit carriage index, the trip low byte at the
    // wrap, and all three local axes at the extremes a carriage reaches.
    const aboard: SnapshotAboard[] = [
      { id: 40000, line: 9, dir: 1, tripLow: 255, car: 7, x: -9.875, y: 2.825, z: 1.075 },
      { id: 7, line: 0, dir: 0, tripLow: 0, car: 1, x: 4.8, y: 4.2, z: -1.075 },
    ];
    const bytes = encodeSnapshot(123456, 65530, players, balls, npcs, aboard);
    if (bytes.byteLength !== snapshotBytes(4, 3, 2, 2)) {
      failures.push(
        `A 4-player 3-ball 2-actor 2-rider snapshot is ${bytes.byteLength} bytes; the layout says ` +
          `${snapshotBytes(4, 3, 2, 2)}.`,
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

      // --- v10's aboard section, which is now the tail. The failure this one
      // catches is the quiet one: every section before it decodes perfectly,
      // and the riders come back in plausible carriages at plausible offsets --
      // so two people on the same train stand in each other, or in the wrong
      // car, and nothing anywhere reports an error.
      if (got.aboard.length !== 2) {
        failures.push(
          `Snapshot carried ${got.aboard.length} riders, not 2. The aboard count byte is not being read.`,
        );
      }
      for (let i = 0; i < Math.min(2, got.aboard.length); i++) {
        const a = aboard[i];
        const b = got.aboard[i];
        if (b.id !== a.id) failures.push(`Rider ${i}: id ${a.id} came back as ${b.id}.`);
        if (b.line !== a.line) failures.push(`Rider ${a.id}: line ${a.line} came back as ${b.line}.`);
        if (b.dir !== a.dir) {
          failures.push(
            `Rider ${a.id}: direction ${a.dir} came back as ${b.dir}. That bit shares a byte with ` +
              `the carriage index, and getting it wrong puts a passenger on the train going the ` +
              `other way.`,
          );
        }
        if (b.car !== a.car) failures.push(`Rider ${a.id}: carriage ${a.car} came back as ${b.car}.`);
        if (b.tripLow !== a.tripLow) failures.push(`Rider ${a.id}: trip byte ${a.tripLow} came back as ${b.tripLow}.`);
        for (const [axis, want, back] of [['x', a.x, b.x], ['y', a.y, b.y], ['z', a.z, b.z]] as Array<[string, number, number]>) {
          if (Math.abs(back - want) > ABOARD_STEP_M / 2 + 1e-9) {
            failures.push(
              `Rider ${a.id}: carriage-local ${axis} ${want} m came back as ${back} m; the field ` +
                `is ${ABOARD_STEP_M * 100} cm steps.`,
            );
          }
        }
      }
    }

    // A snapshot with no balls, no actors and nobody aboard -- every snapshot in
    // a quiet city -- still has to decode.
    const empty = decodeSnapshot(encodeSnapshot(1, 2, players), createSnapshot());
    if (!empty || empty.balls.length !== 0 || empty.npcs.length !== 0 || empty.players.length !== 4) {
      failures.push('A snapshot with no balls and no faction actors in it did not decode cleanly.');
    }
    if (empty && empty.aboard.length !== 0) {
      failures.push(`A snapshot with nobody aboard carried ${empty.aboard.length} riders.`);
    }
    // And the decoder must refuse a truncated tail rather than reading past the
    // end of the buffer, which `DataView` throws on -- taking the whole client
    // down on one short frame. Trimmed by four bytes, which lands inside the
    // last rider now that the aboard section is the tail.
    if (decodeSnapshot(bytes.slice(0, bytes.byteLength - 4), createSnapshot()) !== null) {
      failures.push('A snapshot truncated mid-rider decoded anyway. The length guard is not covering the aboard section.');
    }
    // And one trimmed into the faction section, which is no longer the tail.
    const intoNpcs = encodeSnapshot(1, 2, players, balls, npcs);
    if (decodeSnapshot(intoNpcs.slice(0, intoNpcs.byteLength - 4), createSnapshot()) !== null) {
      failures.push('A snapshot truncated mid-actor decoded anyway.');
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

  // --- Heat, the graded ladder's channel. `MSG.HEAT`; see `encodeHeat`.
  //
  // What this catches: a star count that does not round-trip is a HUD and a
  // nameplate claiming a different tier from the one the server is dispatching
  // helicopters about. A deadline that does not survive the relative encoding is
  // a decay clock counting toward a moment in 1970 -- which draws as "getting
  // away" forever, on a player the police are standing next to.
  {
    const sent = 5_000_000;
    const records: HeatRecord[] = [
      { playerId: 1, stars: 5, decayEndsTick: sent + 900 },
      { playerId: 300, stars: 0, decayEndsTick: 0 },
      { playerId: 42, stars: 2, decayEndsTick: sent + 1 },
    ];
    const frame = encodeHeat(records, sent);
    if (frame.byteLength !== heatBytes(3)) {
      failures.push(`A 3-entry heat message is ${frame.byteLength} bytes; the layout says ${heatBytes(3)}.`);
    }
    // Decoded against the *receiver's* clock, which in the ordinary case is the
    // sender's -- both ends run `traffic.trafficTick(Date.now())`.
    const got = decodeHeat(frame, sent);
    if (!got || got.length !== 3) {
      failures.push(`A 3-entry heat message decoded to ${got?.length ?? 'null'} records.`);
    } else {
      for (let i = 0; i < 3; i++) {
        const a = records[i];
        const b = got[i];
        if (b.playerId !== a.playerId || b.stars !== a.stars || b.decayEndsTick !== a.decayEndsTick) {
          failures.push(
            `Heat for ${a.playerId}: ${a.stars} stars ending ${a.decayEndsTick} came back as ` +
              `${b.stars}/${b.decayEndsTick}.`,
          );
        }
      }
    }
    // Zero is a state, not a small number. A record with the police still on it
    // must not come back as a deadline a fraction of a second away.
    const still = decodeHeat(encodeHeat([{ playerId: 3, stars: 3, decayEndsTick: 0 }], sent), sent + 10);
    if (!still || still[0].decayEndsTick !== 0) {
      failures.push(
        `"The police can still see you" came back as a deadline of ${still?.[0].decayEndsTick}. ` +
          'The HUD would draw a star about to fall on a player who is being shot at.',
      );
    }
    // The empty message is how the last star comes off every HUD in the room.
    const none = decodeHeat(encodeHeat([], sent), sent);
    if (none === null || none.length !== 0) {
      failures.push('An empty HEAT message did not decode to an empty list; that is how the stars come down.');
    }
    // Clamped rather than wrapped, like the investigation countdown.
    const huge = decodeHeat(encodeHeat([{ playerId: 2, stars: 1, decayEndsTick: sent + 999999 }], sent), sent);
    if (!huge || huge[0].decayEndsTick !== sent + 65535) {
      failures.push('An over-long decay deadline wrapped instead of clamping.');
    }
    // And a truncated tail drops the rest rather than throwing.
    const short = decodeHeat(frame.slice(0, HEAT_HEADER_BYTES + 6), sent);
    if (short === null || short.length !== 1) {
      failures.push(`A heat message truncated mid-record decoded ${short?.length ?? 'null'} entries, not 1.`);
    }
    // The two channels must not share an id -- they are the same shape and a
    // collision would decode one as the other with no frame that says so.
    // Asserted over the whole table rather than as a pair, because the batch
    // this landed in had six branches taking bytes out of `MSG` at once and the
    // failure mode of two of them agreeing is a client acting on a frame it
    // was never sent. Read through `Object.values` so the compiler cannot
    // constant-fold the comparison away -- which it does for a literal pair,
    // and which is exactly how this check would have gone quietly true.
    {
      const bytes = Object.values(MSG) as number[];
      if (new Set(bytes).size !== bytes.length) {
        failures.push('Two entries of MSG share a byte. One message would be decoded as another.');
      }
    }
  }

  // --- Events: a batch of every kind, out and back.
  {
    const events: NetEvent[] = [
      { kind: EVENT.HIT, attacker: 1, victim: 2, flags: EVENT_FLAG.KO | EVENT_FLAG.FOOTY, health: 0 },
      { kind: EVENT.PICKUP, combatant: 4, powerup: 1, tileX: -3, tileZ: 5, index: 17 },
      { kind: EVENT.JOIN, id: 9, colourway: 2, bot: 1 },
      // A swat, with a negative coordinate and a negative velocity on every
      // axis it has one -- which is the case a sign error in the i32 or the i8
      // survives, since Sydney's origin is Town Hall and half the city is west
      // and north of it.
      {
        kind: EVENT.SWAT, swinger: 3, ball: 4242,
        x: -812.345, y: 15.5, z: 1420.99,
        vx: -21.5, vy: 8, vz: -35.5,
      },
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
      // The swat. The position is millimetres and has to come back to one; the
      // velocity is half-metres a second and is the coarsest field on this wire,
      // so it is checked against its own quantum rather than against the value.
      // A swat whose position does not survive puts the puff and the crack in
      // the wrong street, and one whose velocity does not survive corrects the
      // thrower's own predicted ball onto a heading the server never chose --
      // which reads as the ball being swatted twice.
      const swat = got[3] as SwatEvent;
      const wanted = events[3] as SwatEvent;
      if (
        swat.swinger !== wanted.swinger ||
        swat.ball !== wanted.ball ||
        Math.abs(swat.x - wanted.x) > 0.001 ||
        Math.abs(swat.y - wanted.y) > 0.001 ||
        Math.abs(swat.z - wanted.z) > 0.001
      ) {
        failures.push(
          `A SWAT event did not round-trip: ${wanted.swinger}/${wanted.ball} at ` +
            `(${wanted.x}, ${wanted.y}, ${wanted.z}) came back as ${swat.swinger}/${swat.ball} at ` +
            `(${swat.x}, ${swat.y}, ${swat.z}).`,
        );
      }
      if (
        Math.abs(swat.vx - wanted.vx) > 0.25 ||
        Math.abs(swat.vy - wanted.vy) > 0.25 ||
        Math.abs(swat.vz - wanted.vz) > 0.25
      ) {
        failures.push(
          `A SWAT event's velocity came back as (${swat.vx}, ${swat.vy}, ${swat.vz}) against ` +
            `(${wanted.vx}, ${wanted.vy}, ${wanted.vz}). Half a metre a second is the quantum.`,
        );
      }
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

  /* --- The screaming sun's two instants.
   *
   * What this catches is the one failure this message can have and the one it
   * would be hardest to find: a clock that does not survive the round trip. The
   * face is drawn until `screamUntilMs` and nothing anywhere re-sends it, so a
   * field that lost its low bits would produce a sun that stopped screaming at a
   * plausible-looking wrong time, three hours after anybody was looking at the
   * code. Both values are tested at a real epoch instant -- 1.8e12, which needs
   * 41 bits and is where a `f32` or a `u32` would fail -- and at an instant past
   * the year 2100, on `Welcome.clockMs`' own reasoning. */
  {
    const scream = 1_800_000_123_456;
    const cool = 1_800_010_800_001;
    const got = decodeSun(encodeSun(scream, cool));
    if (encodeSun(scream, cool).byteLength !== SUN_BYTES) {
      failures.push(`A SUN message is not ${SUN_BYTES} bytes.`);
    }
    if (!got || got.screamUntilMs !== scream || got.cooldownUntilMs !== cool) {
      failures.push(
        `A SUN message came back as ${JSON.stringify(got)} rather than ${scream}/${cool}. Both ` +
          `fields are absolute epoch milliseconds and must be exact: they are sent once and are ` +
          `still being compared against an hour later.`,
      );
    }
    const late = decodeSun(encodeSun(4_102_444_800_000, 4_102_455_600_000));
    if (!late || late.screamUntilMs !== 4_102_444_800_000) {
      failures.push(
        `A SUN instant in the year 2100 came back as ${late?.screamUntilMs}. The fields are f64 ` +
          `and must hold every integer to 2^53.`,
      );
    }
    // A fresh room's zeros are a legal message and mean "never". A decoder that
    // treated them as absent would leave a joiner unable to be told the button
    // is charged.
    const never = decodeSun(encodeSun(0, 0));
    if (!never || never.screamUntilMs !== 0 || never.cooldownUntilMs !== 0) {
      failures.push('A SUN message of zeros -- a room nobody has pressed -- did not decode.');
    }
    // Truncation drops the frame rather than throwing inside the socket
    // callback, which is `decodeRoster`'s rule for every decoder in this file.
    if (decodeSun(encodeSun(scream, cool).slice(0, SUN_BYTES - 1)) !== null) {
      failures.push('A truncated SUN message decoded rather than being refused.');
    }
    // And the press, which is one byte and still has to be told apart from
    // every other one-byte thing that could arrive on that socket.
    if (!decodeSunPress(encodeSunPress())) failures.push('A SUN_PRESS did not decode as one.');
    if (decodeSunPress(encodeInput({ seq: 0, buttons: 0, forward: 0, right: 0, yaw: 0, pitch: 0 }))) {
      failures.push('An INPUT frame decoded as a SUN_PRESS. The type byte is not being read.');
    }
    if (decodeSunPress(new ArrayBuffer(0))) failures.push('An empty frame decoded as a SUN_PRESS.');
  }

  // --- The driven cars, this pass's new message.
  //
  // What this catches, and every one of them renders rather than throws:
  //
  //   - **A `carId` that does not survive.** It is the *suppression key* -- see
  //     `game/driving.ts` section 3 -- so a truncated or sign-mangled one means
  //     the client suppresses the wrong ambient car, or none, and the street has
  //     two of your car in it.
  //   - **A `model` nibble that overflows.** Body and colour share a byte, so a
  //     body index that leaked into the colour half repaints the fleet.
  //   - **A removal that reads as an upsert.** The one thing `MSG.BIKES` never
  //     had to encode. A dropped delete is a permanently suppressed ambient car:
  //     a hole in the traffic that nothing will ever fill.
  //   - **A speed that wraps.** `i16` centimetres, and a wrapped one is a car
  //     the HUD says is doing -1,100 km/h.
  {
    const cars: CarRecord[] = [
      { id: 1, carId: 0xdeadbeef, driver: 0, body: 4, colour: 7, x: -364.25, y: -31.75, z: 2682.5, yaw: 0.75, speed: -6.6 },
      { id: 65535, carId: 1, driver: 65535, body: 0, colour: 0, x: 3999.99, y: -70.125, z: -3999.99, yaw: 6.28, speed: 22 },
      { id: 74, carId: 0x80000000, driver: 12, body: 2, colour: 3, x: 0, y: 0, z: 0, yaw: 0, speed: 0, removed: true },
    ];
    const frame = encodeCars(cars, true);
    if (frame.byteLength !== carsBytes(3)) {
      failures.push(`A 3-car message is ${frame.byteLength} bytes; the layout says ${carsBytes(3)}.`);
    }
    const got = decodeCars(frame);
    if (!got || got.cars.length !== 3) {
      failures.push(`A 3-car message decoded to ${got?.cars.length ?? 'null'} records.`);
    } else {
      if (!got.full) failures.push('The CARS_FULL header flag did not survive the wire.');
      for (let i = 0; i < 3; i++) {
        const a = cars[i];
        const b = got.cars[i];
        if (b.id !== a.id) failures.push(`Car ${a.id}: id came back as ${b.id}.`);
        // `>>> 0` on both sides: 0x80000000 is negative as a signed int and the
        // whole point of this row is that the top bit of an identity survives.
        if ((b.carId >>> 0) !== (a.carId >>> 0)) {
          failures.push(`Car ${a.id}: carId 0x${(a.carId >>> 0).toString(16)} came back as 0x${(b.carId >>> 0).toString(16)}.`);
        }
        if (b.driver !== a.driver) failures.push(`Car ${a.id}: driver ${a.driver} came back as ${b.driver}.`);
        if (b.body !== a.body || b.colour !== a.colour) {
          failures.push(`Car ${a.id}: model ${a.body}/${a.colour} came back as ${b.body}/${b.colour}.`);
        }
        if ((b.removed ?? false) !== (a.removed ?? false)) {
          failures.push(`Car ${a.id}: removed=${a.removed ?? false} came back as ${b.removed}.`);
        }
        if (Math.abs(b.speed - a.speed) > 0.02) {
          failures.push(`Car ${a.id}: speed ${a.speed} came back as ${b.speed}; the tolerance is 2 cm/s.`);
        }
        for (const [axis, want, back] of [['x', a.x, b.x], ['y', a.y, b.y], ['z', a.z, b.z]] as Array<[string, number, number]>) {
          if (Math.abs(back - want) > 0.01) {
            failures.push(`Car ${a.id}: ${axis} ${want} came back as ${back}; the tolerance is 1 cm.`);
          }
        }
      }
    }
    // An empty delta is legal and is what a tick with no change would send if
    // anybody were foolish enough to send one; and the default is *not* full, or
    // every delta would wipe the client's set.
    const none = decodeCars(encodeCars([]));
    if (none === null || none.cars.length !== 0) failures.push('An empty CARS message did not decode to an empty list.');
    if (none !== null && none.full) failures.push('A CARS message defaulted to CARS_FULL; a delta must merge.');
    // A truncated tail drops the rest rather than throwing inside the socket
    // callback. `decodeBikes`' rule.
    const short = frame.slice(0, CARS_HEADER_BYTES + CAR_RECORD_BYTES + 5);
    const partial = decodeCars(short);
    if (partial === null || partial.cars.length !== 1) {
      failures.push(`A CARS message truncated mid-record decoded ${partial?.cars.length ?? 'null'} cars, not 1.`);
    }
  }

  // --- v8's interest message: who came into view and who went out of it.
  //
  // What this catches is the shape of failure the whole of AOI has: an entrant
  // whose identity does not survive is a player drawn in kit 0 -- the same
  // "everybody in the same singlet" that `net/client.ts`'s identity table exists
  // to prevent, now happening every time somebody walks round a corner. And a
  // leaver whose id does not survive is a remote actor never disposed, which is
  // a statue in the street and a rig held out of the pool forever.
  {
    const enters: InterestEnter[] = [
      { id: 1, colourway: 0, flags: 0 },
      // The id a byte would have aliased, with both flag bits set.
      { id: 40000, colourway: 6, flags: ENTER_FLAG.BOT | ENTER_FLAG.RIDING },
      // A driver: `RIDING` *and* `DRIVING`, which is the combination this pass
      // added and the one a client has to be able to tell from a cyclist.
      { id: 65535, colourway: 3, flags: ENTER_FLAG.RIDING | ENTER_FLAG.DRIVING },
    ];
    const leaves = [2, 300, 65534];
    const frame = encodeInterest(enters, leaves);
    if (frame.byteLength !== interestBytes(3, 3)) {
      failures.push(`A 3-in 3-out INTEREST is ${frame.byteLength} bytes; the layout says ${interestBytes(3, 3)}.`);
    }
    const got = decodeInterest(frame);
    if (!got || got.enters.length !== 3 || got.leaves.length !== 3) {
      failures.push(`A 3-in 3-out INTEREST decoded to ${got?.enters.length ?? 'null'} in and ${got?.leaves.length ?? 'null'} out.`);
    } else {
      for (let i = 0; i < 3; i++) {
        const a = enters[i];
        const b = got.enters[i];
        if (b.id !== a.id || b.colourway !== a.colourway || b.flags !== a.flags) {
          failures.push(`Entrant ${a.id}: ${a.colourway}/${a.flags} came back as ${b.id}: ${b.colourway}/${b.flags}.`);
        }
        if (got.leaves[i] !== leaves[i]) failures.push(`Leaver ${leaves[i]} came back as ${got.leaves[i]}.`);
      }
    }
    // The empty message is the one that must never be *sent*, and must still
    // decode: a client standing alone in an empty street has nothing entering
    // and nothing leaving, and `server/room.ts` skips the frame entirely. A
    // decoder that returned null for one would log an error if that ever changed.
    const none = decodeInterest(encodeInterest([], []));
    if (!none || none.enters.length !== 0 || none.leaves.length !== 0) {
      failures.push('An empty INTEREST message did not decode to two empty lists.');
    }
    // Leaves-only, which is what walking away from everybody looks like.
    const out = decodeInterest(encodeInterest([], [9]));
    if (!out || out.enters.length !== 0 || out.leaves.length !== 1 || out.leaves[0] !== 9) {
      failures.push('A leave-only INTEREST did not round-trip.');
    }
    // And a truncated tail drops the rest rather than throwing inside the socket
    // callback, which is `decodeRoster`'s rule and the reason it exists. **The
    // leaves must be empty**, not resynchronised out of the middle of an
    // entrant's record: half of a colourway and a flags byte is a plausible id,
    // and disposing a remote for a player standing in front of you is the one
    // way this message can be worse than not arriving.
    const short = decodeInterest(frame.slice(0, INTEREST_HEADER_BYTES + INTEREST_ENTER_BYTES + 2));
    if (short === null || short.enters.length !== 1 || short.leaves.length !== 0) {
      failures.push(
        `An INTEREST truncated mid-record decoded ${short?.enters.length ?? 'null'} entrants and ` +
          `${short?.leaves.length ?? 'null'} leavers; it must be 1 and 0.`,
      );
    }
    // The worst frame the caps allow, against what the message claims to cost.
    const worst = interestBytes(AOI_MAX_PLAYERS, AOI_MAX_PLAYERS);
    if (worst > 250) {
      failures.push(`A full-turnover INTEREST is ${worst} B; the record documents 243 at the ${AOI_MAX_PLAYERS} cap.`);
    }
  }

  // --- Welcome, pong and bye.
  {
    const w: Welcome = { version: PROTOCOL_VERSION, id: 3, colourway: 5, snapshotHz: SNAPSHOT_HZ, room: 7, tick: 4000000000, x: -812.34, y: 15.5, z: 1420.99, yaw: 4.2, clockMs: 1_800_000_123_456 };
    const got = decodeWelcome(encodeWelcome(w));
    if (!got || got.id !== 3 || got.tick !== 4000000000 || Math.abs(got.x - w.x) > 0.01 || Math.abs(got.z - w.z) > 0.01) {
      failures.push('A WELCOME did not round-trip. A tick over 2^31 is the usual cause -- it is a u32.');
    }
    /* v11's clock, and it is checked for **exactness** rather than for a
     * tolerance, which is the whole reason it is an `f64`.
     *
     * A clock that came back a millisecond out would still produce a perfectly
     * plausible sky -- 1 ms of a 3,600,000 ms cycle is nothing anybody could see
     * -- so a tolerant check here would pass on a field that had been quietly
     * narrowed to a `u32` and was wrapping every 49.7 days. The failure that
     * causes is a room where the sun is in the wrong place for six weeks and
     * then correct again, which nobody would ever trace to this line. Epoch
     * milliseconds are integers well inside 2^53, so exact is the correct test.
     */
    if (!got || got.clockMs !== w.clockMs) {
      failures.push(
        `A WELCOME's clock came back as ${got?.clockMs} rather than ${w.clockMs}. It must be exact: ` +
          `it is the wall clock the whole day/night cycle is evaluated against, and every narrower ` +
          `encoding of an epoch millisecond either wraps or needs a second epoch constant both ends ` +
          `have to agree about -- which is the disagreement this field exists to remove.`,
      );
    }
    const late = decodeWelcome(encodeWelcome({ ...w, clockMs: 4_102_444_800_000 }));
    if (!late || late.clockMs !== 4_102_444_800_000) {
      failures.push(
        `A WELCOME clock in the year 2100 came back as ${late?.clockMs}. The field is an f64 and must ` +
          `stay one; a u32 of milliseconds ran out in 1970.`,
      );
    }
    if (got && got.room !== 7) {
      failures.push(`A WELCOME's room came back as ${got.room}, not 7. A client would build the wrong invite link.`);
    }
    // v8's widened id, at a value a byte could not hold. This is the field the
    // phase 1 capacity curve found aliasing above 255 players.
    const wide = decodeWelcome(encodeWelcome({ ...w, id: 41234, room: 65535 }));
    if (!wide || wide.id !== 41234 || wide.room !== 65535) {
      failures.push(`A WELCOME with id 41234 came back as ${wide?.id}. The id field must be a u16.`);
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
    // v8's headline, and the one assertion in this file that is about the
    // *architecture* rather than about a layout: a client's downstream is
    // bounded by the interest cap and not by the room. If this ever fails,
    // somebody has widened a record without re-reading what it is now multiplied
    // by -- 40 rather than 16 -- and the ceiling has moved with it.
    const atCap = snapshotBytes(AOI_MAX_PLAYERS) * SNAPSHOT_HZ * 8;
    if (atCap > 150000) {
      failures.push(
        `A full working set of ${AOI_MAX_PLAYERS} is ${(atCap / 1000).toFixed(1)} kbit/s. The header ` +
          `documents 143; anything above 150 means the player record grew and the CBD-pileup ` +
          `budget in PERFORMANCE.md is stale.`,
      );
    }
    // And the same arithmetic at the counts the game is actually played at,
    // which is where spec 10's budget has to be met rather than merely bounded.
    const at6 = snapshotBytes(6) * SNAPSHOT_HZ * 8;
    if (at6 > 30000) {
      failures.push(
        `A 6-player working set is ${(at6 / 1000).toFixed(1)} kbit/s, which breaks spec 10's ` +
          `30 kbit/s budget at the player count this build is actually played at.`,
      );
    }
    // The property that makes the cap a cap. A room of 128 and a deployment of
    // 1,000 must cost a client the same, because you cannot stand next to more
    // than `AOI_MAX_PLAYERS` people -- so the snapshot size must not be a
    // function of `MAX_ROOM_PLAYERS` anywhere.
    if (snapshotBytes(Math.min(MAX_ROOM_PLAYERS, AOI_MAX_PLAYERS)) !== snapshotBytes(AOI_MAX_PLAYERS)) {
      failures.push('The interest cap is not the binding one; a full room would be sent whole.');
    }
    // The hysteresis band, which is the other half of the cost story: a single
    // radius is an enter/leave pair every snapshot for anybody standing on the
    // line, and 40 m at a sprint is five seconds of walking.
    if (AOI_LEAVE_RADIUS <= AOI_ENTER_RADIUS) {
      failures.push(
        `The AOI band is ${AOI_ENTER_RADIUS}/${AOI_LEAVE_RADIUS} m, which is not a band. ` +
          `Entering and leaving at one radius flaps forever.`,
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
    // --- v10's aboard section, at the three counts that say what it costs.
    //
    // **The first one is the headline and the design was chosen for it**: a
    // snapshot with nobody on a train is v9's snapshot plus the one count byte
    // in the header. Riding is free in every street in Sydney, which is where
    // this game is played, and that is the property a widened *player* record
    // would have thrown away for the sake of thirteen bytes of zeros each.
    const idle = snapshotBytes(6, 2, 0, 0) - snapshotBytes(6, 2, 0, 0) + ABOARD_BYTES * 0;
    if (idle !== 0 || snapshotBytes(6, 2) !== SNAPSHOT_HEADER_BYTES + 6 * PLAYER_BYTES + 2 * BALL_BYTES) {
      failures.push('A snapshot with nobody aboard is not the plain snapshot plus a header byte.');
    }
    // Then a train with two of the six players on it and no footballs in the
    // air, which is what the count this build is actually played at looks like
    // on a commute. Spec 10's budget, unchanged.
    const commute = snapshotBytes(6, 0, 0, 2) * SNAPSHOT_HZ * 8;
    if (commute > 30000) {
      failures.push(
        `Six players with two of them aboard is ${(commute / 1000).toFixed(1)} kbit/s, which breaks ` +
          `spec 10's budget. The aboard section is ${ABOARD_BYTES} B a rider.`,
      );
    }
    // And the pathological one: a whole working set in one carriage, which is
    // the most this section can ever be because it is filtered by the same
    // interest cap the players are. It moves the documented ceiling from 143 to
    // 194 kbit/s, and that is the number to re-read before widening anything.
    const ridingCap = snapshotBytes(AOI_MAX_PLAYERS, 0, 0, AOI_MAX_PLAYERS) * SNAPSHOT_HZ * 8;
    if (ridingCap > 200000) {
      failures.push(
        `A full working set of ${AOI_MAX_PLAYERS}, all of them on one train, is ` +
          `${(ridingCap / 1000).toFixed(1)} kbit/s against the 194 the record documents.`,
      );
    }
    // A rider must never cost half of what a person costs. It is the invariant
    // behind the two numbers above and the one that will actually be violated
    // first, because a carriage-local offset is the cheapest thing to describe
    // on this whole wire and any growth in it means somebody has put a *world*
    // quantity in the wrong section.
    if (ABOARD_BYTES * 2 > PLAYER_BYTES) {
      failures.push(
        `A rider is ${ABOARD_BYTES} B against a player's ${PLAYER_BYTES}. A position inside a ` +
          `3 x 20 m box must not cost half of a position in a 60 km disc.`,
      );
    }
    // The packed byte, at every field's top value: ten lines in four bits,
    // direction 1, carriage 7. Getting the shifts wrong here puts a passenger on
    // the train going the other way, which renders perfectly.
    {
      const round: SnapshotAboard = { id: 1, line: 15, dir: 1, tripLow: 200, car: 7, x: 0, y: 0, z: 0 };
      const back = decodeSnapshot(encodeSnapshot(0, 0, [], [], [], [round]), createSnapshot());
      const got = back?.aboard[0];
      if (!got || got.car !== 7 || got.dir !== 1 || got.line !== 15 || got.tripLow !== 200) {
        failures.push(
          'The aboard record cannot carry carriage 7 of line 15 on direction 1. Four bits of line, ' +
            'one of direction and three of carriage is the documented layout.',
        );
      }
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
    // The whole stream at the worst case anything can reach under v8: a working
    // set at the interest cap, the balls that many players can sustain, and a
    // pursuit at the actor cap. This is the CBD-pileup number PERFORMANCE.md
    // phase 4 measures against, and what this asserts is that it has not
    // *moved* -- the faction section is the one part of this record not bounded
    // by the interest cap, so it is the one that will grow unnoticed.
    const fullHouse = snapshotBytes(AOI_MAX_PLAYERS, 10, 24) * SNAPSHOT_HZ * 8;
    if (fullHouse > 250000) {
      failures.push(
        `A full working set with ten balls and a full pursuit is ${(fullHouse / 1000).toFixed(1)} kbit/s. ` +
          'The CBD-pileup budget in PERFORMANCE.md is 244; anything above 250 means a record grew.',
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

  // --- The message table itself: unique, and on the right side of 0x80.
  //
  // Added at v9, which is the version two features were built into at once
  // (global chat and the suggestions box) against this one table. That is
  // exactly the circumstance the rule at the top of `MSG` exists for and exactly
  // the circumstance nobody re-reads it in: a duplicate id is not a parse error,
  // it is one feature's frame being handed to the other's decoder, which reads a
  // plausible wrong record out of it and returns. There is no throw and no log.
  //
  // The halves are asserted rather than assumed for the same reason. A
  // client-to-server message numbered over 0x80 is one that a client can send to
  // *itself* through a compromised server and that `client.ts`'s switch will
  // dispatch, and the range test in both directions is what makes that a
  // non-event.
  {
    const seen = new Map<number, string>();
    for (const [name, id] of Object.entries(MSG)) {
      const prior = seen.get(id);
      if (prior !== undefined) {
        failures.push(
          `MSG.${name} and MSG.${prior} are both 0x${id.toString(16)}. One feature's frames will be ` +
            "decoded as the other's, silently.",
        );
      }
      seen.set(id, name);
      if (id < 0 || id > 0xff) failures.push(`MSG.${name} is 0x${id.toString(16)}, which is not a byte.`);
    }
    // Which half each one belongs in, named here rather than inferred from a
    // prefix: a list is checkable and a naming convention is not.
    const clientToServer = ['HELLO', 'INPUT', 'PING', 'CHAT_SAY', 'SUGGEST', 'SUN_PRESS', 'PHONE'];
    for (const [name, id] of Object.entries(MSG)) {
      const wantsLow = clientToServer.includes(name);
      if (wantsLow && id >= 0x80) {
        failures.push(`MSG.${name} is a client message at 0x${id.toString(16)}; the client half is under 0x80.`);
      }
      if (!wantsLow && id < 0x80) {
        failures.push(`MSG.${name} is a server message at 0x${id.toString(16)}; the server half is 0x80 and over.`);
      }
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
