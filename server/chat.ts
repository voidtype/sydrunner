/**
 * The chat hub: who may say what, and everybody who hears it.
 *
 * The wire is `client/src/net/chat.ts` and the rules of admission are there too,
 * as pure functions on a synthetic clock, so this file is only the two things
 * that need a server: the **fan-out**, and the **attribution**.
 *
 * ---------------------------------------------------------------------------
 * ## THE FAN-OUT: every room, which is the whole feature
 *
 * `server/room.ts` is built on a rule this deliberately breaks. A `Room` is one
 * `Simulation` and the sockets watching it, and every send in that file walks
 * `this.conns` -- the roster, the bikes, the events, the snapshots. Nothing
 * crosses, and `checkRooms` asserts it over real sockets because "one simulation
 * per room" is only half of isolation.
 *
 * Chat crosses. The user asked for chat "global to the server", and a chat that
 * stopped at the room boundary would be indistinguishable from one that worked
 * right up until the gateway put two friends in different rooms -- which is the
 * *normal* case under the least-full rule, and the exact failure that rule's own
 * `?room=` invite link exists to work around. So this walks the `RoomHost`:
 * every room, every socket with a participant behind it, one encode and N sends.
 *
 * What that costs, against the arithmetic in `net/chat.ts`'s header: a line is
 * about 60 bytes and a sender is capped below one message per 1.5 s. Ten chatty
 * players on a 1,000-player host is 3.2 kbit/s per client -- a tenth of one
 * client's own snapshot stream, and a fifth of what the roster refresh already
 * costs a full room. It is bounded by *talkers* rather than by population, which
 * is why it can be global at all when nothing else here is.
 *
 * The frame is encoded **once per line** and the same `ArrayBuffer` is handed to
 * every socket, on `Room.sendRoster`'s own pattern. Bun copies into the socket's
 * buffer synchronously, so there is no aliasing hazard and no reason to slice.
 *
 * ---------------------------------------------------------------------------
 * ## THE LIMITATION, stated where the seam is
 *
 * **Chat crosses rooms. It does not cross processes.**
 *
 * `SYDNEY_ROOM_BASE` in `server/index.ts` is the multi-process seam: four hosts
 * on four ports with bases 0, 8, 16 and 24 present 32 globally-unique rooms, and
 * "nothing in this process knows the other hosts exist" is that design's stated
 * property. It is also exactly what bounds this: `broadcast` reaches every room
 * on *this* `RoomHost`, so a 32-room deployment has four chat worlds of eight
 * rooms each, and a player in room 3 cannot hear one in room 19.
 *
 * That is a real limitation and it is not papered over. Closing it needs a
 * message bus between the hosts -- Redis pub/sub, or one host nominated as the
 * relay -- which is a piece of deployment infrastructure this build does not
 * have and which would be the first thing in the repo that could not be run by
 * typing `bun run server/index.ts`. The seam it would attach to is
 * `ChatHub.broadcast` below, and the change is one call: publish the encoded
 * frame, and deliver locally on receipt. Single-process global chat is the
 * honest scope, and the one deployment that exists today (one host, N rooms) is
 * entirely covered by it.
 *
 * ---------------------------------------------------------------------------
 * ## THE ATTRIBUTION: never the client's word
 *
 * `CHAT_SAY` carries a string and nothing else -- no sender field, no name, no
 * room. The sender is the socket the frame arrived on, the name is read off that
 * socket's `Participant` (which is what the *roster* is built from, so the name
 * over a message is the name on the leaderboard by construction), and the room
 * is `Conn.room`. A client cannot claim to be anybody, because there is no field
 * in which to claim it.
 *
 * Bots never reach this file at all: a bot is a `Participant` with no socket, so
 * there is nothing to receive a `CHAT_SAY` from. Stated because it is a design
 * property rather than a check -- `server/bots.ts` has no chat in it and cannot
 * grow one without a socket.
 *
 * **No profanity filter**, deliberately and out of scope. Word lists are a
 * cross-cultural taste problem with a false-positive rate that hits place names
 * ("Scunthorpe" is the canonical one and this is a game set in a real city), and
 * a filter nobody can tune is worse than none. The floor here is *volume* --
 * length, rate, repetition -- which is what stops a chat being unusable. What is
 * said in it is a moderation problem and moderation needs identity, which spec 12
 * explicitly does not have.
 */

import {
  CHAT_FLAG,
  CHAT_ROOM_NONE,
  chatAdmit,
  chatShouldNotify,
  decodeChatSay,
  encodeChatLine,
  newChatGate,
  sanitiseChat,
  type ChatGate,
  type ChatLine,
} from '../client/src/net/chat.ts';
import {
  UNSTUCK_COOLDOWN_MS,
  UNSTUCK_KO_NOTICE,
  unstuckCommand,
  unstuckReply,
  unstuckWaitNotice,
} from '../client/src/game/unstuck.ts';
import {
  PLATFORM_NO_QUERY,
  TELEPORT_NO_QUERY,
  findPlace,
  parsePlatform,
  parseTeleport,
  parseMessage,
  urlSafeName,
  MESSAGE_NO_TARGET,
  messageNotFound,
  platformNotFound,
  platformReply,
  splitPlatformQuery,
  teleportNotFound,
  teleportReply,
} from '../client/src/game/teleport.ts';
import { railSeconds } from '../client/src/game/rail.ts';
import { dwellStand, nextDwell, type Stand } from '../client/src/game/riding.ts';
import type { RoomHost, Socket } from './room.ts';

/** What the sender is told when the bucket is empty. */
const RATE_NOTICE = 'you are talking too fast — wait a moment';
/** And when they have said the same thing three times running. */
const REPEAT_NOTICE = 'you have said that three times — say something else';

/**
 * Every sender's budget, keyed by the socket it arrived on.
 *
 * A `WeakMap` rather than a field on `Conn`, and that is the one storage
 * decision here. `Conn` lives in `server/room.ts`, which every check in the
 * repo constructs by hand; adding a chat field to it would put this feature's
 * state in the room's constructor, in `newConn`, and in every fake socket in
 * `server/integration-check.ts`. A weak map keyed by the socket costs one hash
 * per message, is emptied by the garbage collector when the socket is dropped --
 * so a disconnect needs no cleanup path that could be forgotten -- and keeps the
 * whole feature to two files plus the wire.
 */
export class ChatHub {
  private readonly gates = new WeakMap<Socket, ChatGate>();

  /**
   * When each socket last used `/unstuck`.
   *
   * A second `WeakMap` beside `gates` rather than a field on `ChatGate`, and the
   * split is the point: the chat gate is the *abuse floor for speech* -- a
   * budget of sentences, a repeat guard, a notice throttle -- and a command is
   * not speech. Folding the cooldown into it would mean a player who had been
   * chatting could not get unstuck, and a player who got unstuck had spent a
   * sentence. They are two rules about two things and they are kept apart.
   *
   * Weak and keyed by the socket for `gates`' own reasons: the garbage collector
   * empties it on disconnect, so there is no cleanup path to forget, and nothing
   * is added to `Conn` or to every fake socket in `server/integration-check.ts`.
   */
  private readonly unstuckAt = new WeakMap<Socket, number>();

  /** How many lines this hub has fanned out, and to how many sockets. Read by `/stats`. */
  lines = 0;
  sends = 0;
  bytes = 0;
  /** How many arrivals were refused, by reason. */
  refusedRate = 0;
  refusedRepeat = 0;
  refusedEmpty = 0;
  /** How many `/unstuck` commands were served, and how many refused. */
  unstuckServed = 0;
  unstuckRefused = 0;

  /**
   * A `CHAT_SAY` arrived on `ws`. Sanitise it, admit it or refuse it, and if it
   * lives, put it in front of everybody on the host.
   *
   * Returns what happened, for the caller's log and for the checks. `now` is
   * injected rather than read here so the integration check can drive a rate
   * limit's window without sleeping through it.
   */
  say(
    host: RoomHost,
    ws: Socket,
    frame: ArrayBuffer,
    now = Date.now(),
  ): 'sent' | 'empty' | 'rate' | 'repeat' | 'bad' | 'command' {
    const conn = ws.data;
    const p = conn.participant;
    // No participant means a socket that has not said hello. Silently ignored
    // rather than refused, on `server/index.ts`'s rule for every other message
    // type: a frame before the handshake is a client bug or a probe, and
    // answering either is telling a stranger the server is listening.
    if (!p) return 'bad';

    const raw = decodeChatSay(frame);
    if (raw === null) return 'bad';

    // The second pass. The client ran this before it sent, so in the ordinary
    // case it changes nothing -- which is precisely why `verifyChat` asserts the
    // function is idempotent, and precisely why this run happens anyway: the
    // first one happened inside something the player controls.
    const text = sanitiseChat(raw);
    if (text.length === 0) {
      // An empty message is dropped with no notice at all. Somebody who pressed
      // Enter on an empty box does not need to be told, and a probe sending
      // three thousand of them should not be answered three thousand times.
      this.refusedEmpty++;
      return 'empty';
    }

    /*
     * The one thing in this file that is not chat.
     *
     * `/unstuck` is intercepted **here** -- after sanitisation, before the token
     * bucket, and before the fan-out -- and each of those three positions is a
     * decision:
     *
     *   - **After sanitisation**, so the command is matched against the same
     *     string everybody else would have seen. A client that padded it with
     *     zero-width spaces gets the same answer as one that typed it.
     *   - **Before `chatAdmit`**, because a command is not speech and must not
     *     spend a sentence. The repeat guard is the concrete reason: `/unstuck`
     *     is by definition typed identically every time, so the third one in a
     *     row would be refused as a repeat -- and the third one is exactly the
     *     one somebody genuinely wedged in a wall is typing.
     *   - **Before `broadcast`**, which is the rule this feature lives or dies
     *     on: a command must never reach anybody else's chat log. There is one
     *     `return` between here and the fan-out and it is unconditional.
     *
     * See `client/src/game/unstuck.ts` for why this is a chat command at all,
     * and for the rest of the rule.
     */
    if (unstuckCommand(text)) return this.unstuck(host, ws, now);
    const destination = parseTeleport(text);
    if (destination !== null) return this.teleport(host, ws, now, destination);
    const dm = parseMessage(text);
    if (dm !== null) return this.whisper(host, ws, dm);
    const station = parsePlatform(text);
    if (station !== null) return this.platform(host, ws, now, station);

    let gate = this.gates.get(ws);
    if (!gate) {
      gate = newChatGate(now);
      this.gates.set(ws, gate);
    }

    const refusal = chatAdmit(gate, text, now);
    if (refusal !== '') {
      if (refusal === 'rate') this.refusedRate++;
      else this.refusedRepeat++;
      // Told **once per window**, not once per attempt -- see `CHAT_NOTICE_MS`.
      // Without the throttle the server's own explanation is the flood.
      if (chatShouldNotify(gate, now)) {
        this.notify(ws, refusal === 'rate' ? RATE_NOTICE : REPEAT_NOTICE);
      }
      return refusal;
    }

    this.broadcast(host, {
      sender: p.id,
      room: conn.room,
      flags: 0,
      // The server's name for this player, which is the roster's name for them.
      // `Simulation.join` sanitised and deduped it at the handshake -- see
      // `Simulation.pickName` -- so what goes out here is what the leaderboard
      // says and what a nameplate says, and there is no path by which a client
      // can make it be anything else.
      name: p.name,
      text,
    });
    return 'sent';
  }

  /**
   * Serve `/unstuck` for the player on `ws`, and answer them privately.
   *
   * Every path here ends in exactly one `notify` and no broadcast. The
   * conditions, in the order that refuses most cheaply first:
   *
   *   1. **Knocked out.** Refused rather than served, because the respawn is
   *      already about to move them and `pickRespawn` does the same job over a
   *      shorter distance -- and because a player who can teleport out of a
   *      knockout can teleport out of a fight. `combat.advance` clears the phase
   *      on its own three seconds later; they lose nothing by waiting.
   *   2. **The cooldown**, told with the time remaining, because a refusal that
   *      does not say how long is a refusal somebody retries immediately.
   *   3. **The search**, which is the only expensive branch and is therefore
   *      last. The clock is only stamped once a move has actually happened, so a
   *      player who asked from somewhere with no answer may ask again from two
   *      steps away rather than being locked out for ten seconds by a failure.
   *
   * The relocation itself is `Simulation.unstuck` -- the room's, so a room this
   * socket is not in cannot be moved -- and it credits nobody a knockout.
   */
  /**
   * `/tp <suburb>` — go to a named place.
   *
   * Shares `/unstuck`'s cooldown deliberately: both are teleports, and a player
   * who could alternate them would have a 5-second escape from any fight rather
   * than a 10-second one. The refusals, the no-death rule and the road search
   * are all `/unstuck`'s too — the only new thing here is resolving a name to a
   * point, which is `game/teleport.ts`.
   */
  private teleport(host: RoomHost, ws: Socket, now: number, query: string): 'command' {
    const conn = ws.data;
    const p = conn.participant;
    if (!p) return 'command';

    if (!query) {
      this.notify(ws, TELEPORT_NO_QUERY);
      return 'command';
    }
    if (p.combat.phase === 'ko') {
      this.unstuckRefused++;
      this.notify(ws, UNSTUCK_KO_NOTICE);
      return 'command';
    }
    const last = this.unstuckAt.get(ws);
    if (last !== undefined && now - last < UNSTUCK_COOLDOWN_MS) {
      this.unstuckRefused++;
      this.notify(ws, unstuckWaitNotice(UNSTUCK_COOLDOWN_MS - (now - last)));
      return 'command';
    }

    const room = host.get(conn.room);
    if (!room) {
      this.unstuckRefused++;
      this.notify(ws, unstuckReply(null));
      return 'command';
    }

    // A suburb first, then a player by name: `/tp bazza` puts you on a road
    // within reach of wherever Bazza is standing, if Bazza is in this room.
    // Another room is another simulation and a body cannot be handed across;
    // the notice says which room, so the two of them can meet in one.
    let place = findPlace(query, room.sim.world.places);
    if (!place) {
      const found = this.findPlayer(host, query);
      if (found !== null && found.room !== conn.room) {
        this.unstuckRefused++;
        this.notify(ws, `${found.name} is in another room — you would need to join room ${found.room}`);
        return 'command';
      }
      if (found !== null && found.id === p.id) {
        this.notify(ws, 'you are already there');
        return 'command';
      }
      if (found !== null) place = { name: found.name, x: found.x, z: found.z };
    }
    if (!place) {
      this.unstuckRefused++;
      // The radius the build actually covers, not a constant: this message is
      // the one that has to be true after the map grows.
      this.notify(ws, teleportNotFound(query, room.sim.world.index.radius_m));
      return 'command';
    }

    const fromX = p.combat.body.position.x;
    const fromZ = p.combat.body.position.z;
    const spot = room.sim.unstuck(p, Math.random, place);
    if (!spot) {
      this.unstuckRefused++;
      this.notify(ws, unstuckReply(null));
      return 'command';
    }
    this.unstuckAt.set(ws, now);
    this.unstuckServed++;
    // How far *they* travelled, which is not the search's own distance -- that
    // one is measured from the suburb node the search started at.
    const travelled = Math.hypot(spot.x - fromX, spot.z - fromZ);
    this.notify(ws, teleportReply(place, travelled));
    return 'command';
  }

  /**
   * `/platform <station>` — stand in the doorway of the next train to call here.
   *
   * `/tp`'s twin, and everything about the *refusals* is shared with it by
   * calling the same guards in the same order: not while knocked out, not inside
   * the ten-second cooldown, and the same accounting. What differs is the
   * resolver and the arrival.
   *
   * **The resolver is the timetable, read here.** `nextDwell` solves which
   * service is next to open its doors at that station and `dwellStand` composes
   * the point a boarder stands at through the carriage's own frame -- both out of
   * `world.rail`, which is *this process's* bake, at *this process's* clock. A
   * client asking for this is asking a question; the answer is the server's, and
   * a modified client that lied about a station name gets a station name it did
   * not ask for or nothing at all.
   *
   * **The arrival is the platform**, not `unstuckDestination`'s road. A boarder
   * put on the nearest carriageway is a boarder standing in traffic on the wrong
   * side of a fence, which is what made the previous round's harness unusable
   * online. The body is placed, its velocity cleared and its rewind ring seeded,
   * exactly as `sim.placeRider` does when somebody steps off a train -- and for
   * the same reason: for the next 250 ms an unseeded history would adjudicate
   * punches against wherever this player used to be.
   */
  /** A player on any room of this host, by URL-safe name. */
  private findPlayer(host: RoomHost, query: string): { id: number; name: string; room: number; x: number; z: number; ws: Socket } | null {
    const want = urlSafeName(query);
    if (want === '') return null;
    for (const room of host.rooms) {
      for (const other of room.conns) {
        const q = other.data.participant;
        if (!q || q.gone || q.bot !== null) continue;
        if (urlSafeName(q.name) !== want) continue;
        return { id: q.id, name: q.name, room: other.data.room, x: q.combat.body.position.x, z: q.combat.body.position.z, ws: other };
      }
    }
    return null;
  }

  /**
   * `/msg name line`: one line to one player, on any room. Both ends see it
   * as a private line carrying the sender's name, so the receiver can answer
   * with `/msg` back. The sender's copy says who it went to. Not rate-gated
   * separately from chat: it goes through the same gate as a said line.
   */
  private whisper(host: RoomHost, ws: Socket, dm: { to: string; text: string }): 'command' {
    const p = ws.data.participant;
    if (!p) return 'command';
    if (dm.to === '' || dm.text === '') {
      this.notify(ws, MESSAGE_NO_TARGET);
      return 'command';
    }
    const found = this.findPlayer(host, dm.to);
    if (found === null) {
      this.notify(ws, messageNotFound(dm.to));
      return 'command';
    }
    const line = (text: string): ArrayBuffer =>
      encodeChatLine({ sender: p.id, room: CHAT_ROOM_NONE, flags: CHAT_FLAG.PRIVATE, name: p.name, text });
    found.ws.send(line(`(to you) ${dm.text}`));
    ws.send(line(`(to ${found.name}) ${dm.text}`));
    this.sends += 2;
    this.lines++;
    return 'command';
  }

  private platform(host: RoomHost, ws: Socket, now: number, query: string): 'command' {
    const conn = ws.data;
    const p = conn.participant;
    if (!p) return 'command';

    if (!query) {
      this.notify(ws, PLATFORM_NO_QUERY);
      return 'command';
    }
    if (p.combat.phase === 'ko') {
      this.unstuckRefused++;
      this.notify(ws, UNSTUCK_KO_NOTICE);
      return 'command';
    }
    const last = this.unstuckAt.get(ws);
    if (last !== undefined && now - last < UNSTUCK_COOLDOWN_MS) {
      this.unstuckRefused++;
      this.notify(ws, unstuckWaitNotice(UNSTUCK_COOLDOWN_MS - (now - last)));
      return 'command';
    }

    const room = host.get(conn.room);
    const bake = room?.sim.world.rail ?? null;
    if (!room || !bake) {
      this.unstuckRefused++;
      this.notify(ws, unstuckReply(null));
      return 'command';
    }

    const t = railSeconds(room.sim.railNowMs());
    const { station, then } = splitPlatformQuery(query);
    const dwell = nextDwell(bake, station, t, { then });
    if (dwell === null) {
      this.unstuckRefused++;
      this.notify(ws, platformNotFound(then ? `${station} > ${then}` : station));
      return 'command';
    }
    // Placed for the instant the doors *will* open rather than for now: a train
    // still four hundred metres out has a different frame, and standing where
    // its doorway is going to be is the whole job.
    const stand: Stand = { x: 0, y: 0, z: 0, yaw: 0 };
    if (!dwellStand(bake, dwell, Math.max(dwell.opensAt + 1, t), stand)) {
      this.unstuckRefused++;
      this.notify(ws, unstuckReply(null));
      return 'command';
    }

    this.unstuckAt.set(ws, now);
    this.unstuckServed++;
    room.sim.placeAt(p, stand.x, stand.y, stand.z, stand.yaw);
    this.notify(ws, platformReply(station, dwell.lineId, dwell.towards, dwell.opensAt - t));
    return 'command';
  }

  private unstuck(host: RoomHost, ws: Socket, now: number): 'command' {
    const conn = ws.data;
    const p = conn.participant;
    // Unreachable: `say` returns 'bad' on a socket with no participant before
    // this is called. Restated rather than asserted because it is what makes the
    // rest of this method total, and the cost is one comparison.
    if (!p) return 'command';

    if (p.combat.phase === 'ko') {
      this.unstuckRefused++;
      this.notify(ws, UNSTUCK_KO_NOTICE);
      return 'command';
    }

    const last = this.unstuckAt.get(ws);
    if (last !== undefined && now - last < UNSTUCK_COOLDOWN_MS) {
      this.unstuckRefused++;
      this.notify(ws, unstuckWaitNotice(UNSTUCK_COOLDOWN_MS - (now - last)));
      return 'command';
    }

    const room = host.get(conn.room);
    if (!room) {
      this.unstuckRefused++;
      this.notify(ws, unstuckReply(null));
      return 'command';
    }

    const spot = room.sim.unstuck(p);
    if (spot) {
      this.unstuckAt.set(ws, now);
      this.unstuckServed++;
    } else {
      this.unstuckRefused++;
    }
    this.notify(ws, unstuckReply(spot));
    return 'command';
  }

  /**
   * One line to every socket on this host, in every room.
   *
   * Encoded once. The iteration is rooms-then-sockets rather than a flat socket
   * set because the host has no flat socket set -- `server/index.ts` keeps one
   * for the idle sweep, but it includes sockets that never said hello, and a
   * chat line must only reach a client that has been welcomed and therefore has
   * a roster to draw a name against.
   */
  broadcast(host: RoomHost, line: ChatLine): void {
    const frame = encodeChatLine(line);
    this.lines++;
    for (const room of host.rooms) {
      for (const ws of room.conns) {
        if (!ws.data.participant) continue;
        ws.send(frame);
        this.sends++;
        this.bytes += frame.byteLength;
      }
    }
  }

  /**
   * A private system line to one socket: a throttle explanation, or `/unstuck`'s
   * answer.
   *
   * `PRIVATE` and `SYSTEM` are two flags rather than one because they are two
   * different facts and a later line may want either alone -- a server-wide
   * announcement is `SYSTEM` and not private, and a whisper would be private and
   * not system. The client draws them differently: see `client/src/chat.ts`.
   */
  notify(ws: Socket, text: string): void {
    if (!ws.data.participant) return;
    const frame = encodeChatLine({
      sender: 0,
      room: CHAT_ROOM_NONE,
      flags: CHAT_FLAG.PRIVATE | CHAT_FLAG.SYSTEM,
      name: '',
      text,
    });
    ws.send(frame);
    this.sends++;
    this.bytes += frame.byteLength;
  }
}
