/**
 * The authoritative server. Spec milestone 9: *"Two browsers see each other move."*
 *
 * Bun, because spec 9's default recommendation was *"Bun + Caddy on the Mac
 * mini, static tiles, no persistence"* and the user took it. The half of that
 * choice that actually shows up in the code is the first clause of its
 * justification -- *"fastest to write, **shares types with the client**"* -- and
 * it is not types it shares, it is the simulation itself. Every gameplay
 * decision this process makes is made by a file in `client/src/`:
 *
 *     game/combat.ts      the punch, the phases, the knockback, the respawn
 *     game/footy.ts       the ball's flight, its bounces and what it lands on
 *     game/powerups.ts    spec 8.3's pickups and modifiers
 *     player/controller.ts   movement, imported and stepped at a fixed 60 Hz
 *     player/collision.ts    the same prism payload the browser downloads
 *     world/terrain.ts       the same .terr.bin the browser downloads
 *     net/protocol.ts        every byte on the wire, encoded by one encoder
 *
 * Those files were written to be lifted -- `game/combat.ts`'s header spends
 * three rules on it and `game/powerups.ts` restates them -- and this pass lifted
 * them without changing a line of their behaviour. The check that it really is
 * one simulation rather than two is that `verifyCombat`, `verifyPowerups` and
 * `verifyFooty` are run **here at boot**, in this process, off the same source
 * the browser runs them from.
 *
 * ---------------------------------------------------------------------------
 * **This process is now a host of R rooms rather than one game.**
 * PERFORMANCE.md phase 3.
 *
 * What used to be module-level state here -- a `Simulation`, a socket set, a
 * roster cadence, a snapshot pool -- is a `Room` (see `server/room.ts`), and
 * this file is what is left when you take the game out of it: boot checks, one
 * loaded city, three HTTP routes and a 60 Hz pump that steps every room.
 *
 * The join flow is the only new protocol above the socket:
 *
 *     GET /rooms            -> [{ id, players, cap, open }, ...]
 *     ws://host/ws?room=3   -> that room, or a BYE if it is full
 *     ws://host/ws          -> the least-full open room
 *
 * The last line is what keeps every existing bookmark working, and it is why the
 * room a client ends up in is reported back in the `WELCOME` rather than assumed
 * from the URL.
 *
 * ---------------------------------------------------------------------------
 * WebSocket, not WebTransport. See `net/protocol.ts`'s header for the full
 * argument; the short version is that spec 10's transport requires HTTP/3 and a
 * real TLS certificate, which is the deployment step this pass is explicitly
 * not doing, and blocking two browsers on one desk behind a certificate
 * authority is the wrong order to do the work in. The seam is `NetTransport`.
 *
 * ---------------------------------------------------------------------------
 * This process serves the game and **not the world**. Spec 9's third question
 * was answered "static tiles", so 326 MB of GLB keeps coming from vite (in
 * development) or any static host (later), and this listens on one port and
 * speaks one binary protocol. It reads the collision and terrain sidecars off
 * the disk at boot because it needs to simulate against them; it has no route
 * that would hand one to a browser.
 *
 *     bun run server/index.ts               # from the repo root
 *     npm run server                        # the same thing
 *     SYDNEY_PORT=9000 npm run server       # a different port
 *     SYDNEY_BOTS=0 npm run server          # no bots
 *     SYDNEY_ROOMS=8 npm run server         # eight rooms in this process
 *     SYDNEY_ROOM_CAP=128 npm run server    # each of them 128 players
 *     SYDNEY_ROOM_BASE=8 npm run server     # rooms numbered 8..15 (second host)
 */

import { verifyCombat } from '../client/src/game/combat.ts';
import { verifyFooty } from '../client/src/game/footy.ts';
import { verifyPowerups } from '../client/src/game/powerups.ts';
import { verifySpatialHash } from '../client/src/game/spatialhash.ts';
import { verifyMovementBasis } from '../client/src/player/controller.ts';
import {
  MAX_PLAYERS,
  MAX_REWIND_MS,
  MSG,
  PROTOCOL_VERSION,
  SNAPSHOT_HZ,
  TICK_HZ,
  decodeHello,
  decodePing,
  encodeBye,
  encodePong,
  frameType,
  rankRoster,
  snapshotBytes,
} from '../client/src/net/protocol.ts';
import { verifyNames, verifyNet } from '../client/src/net/protocol.ts';
import { verifyChat } from '../client/src/net/chat.ts';
import { verifyUnstuck } from '../client/src/game/unstuck.ts';
import { verifyTeleport } from '../client/src/game/teleport.ts';
import { verifySuggestions } from '../client/src/net/suggestions.ts';
import { verifyAoi } from './aoi.ts';
import { ChatHub } from './chat.ts';
import {
  SuggestionHub,
  SuggestionStore,
  defaultLedgerPath,
  githubRepo,
  githubToken,
} from './suggestions.ts';
import { verifyRewind } from './rewind.ts';
import { verifySim } from './sim.ts';
import {
  HEARTBEAT_MS,
  RoomHost,
  heartbeat,
  newConn,
  receiveInput,
  receivePong,
  type Conn,
  type Socket,
} from './room.ts';
import { loadWorld } from './world.ts';

const PORT = Number(process.env.SYDNEY_PORT ?? 8787);
const WORLD_ROOT = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
const BOT_COUNT = Number(process.env.SYDNEY_BOTS ?? 2);

/**
 * How many rooms this process runs, and how big each is allowed to get.
 *
 * **One room by default**, which keeps `bun run server/index.ts` the thing it
 * has always been: start it, open two tabs, fight. Rooms are a deployment
 * decision and a default of eight would mean two browsers on one desk landing in
 * different cities -- the exact failure the gateway's least-full rule exists to
 * prevent, caused by the gateway itself.
 *
 * The cap is 128 because that is what PERFORMANCE.md measured a room at: 0.52 ms
 * of tick, 3.1% of a core. `SYDNEY_MAX_PLAYERS` is kept as an alias for it
 * because that is the name phase 1's harness invocation uses and is written into
 * PERFORMANCE.md's "running the harness" section -- a rename would have
 * invalidated a documented command for no reader's benefit.
 */
const ROOM_COUNT = Math.max(1, Number(process.env.SYDNEY_ROOMS ?? 1));
const ROOM_CAP = Number(
  process.env.SYDNEY_ROOM_CAP ?? process.env.SYDNEY_MAX_PLAYERS ?? MAX_PLAYERS,
);
/**
 * The id of this host's first room. Rooms are `BASE .. BASE + COUNT - 1`.
 *
 * The whole of the multi-process seam, and it is one number. Four hosts on ports
 * 8787-8790 with `SYDNEY_ROOM_BASE` 0, 8, 16 and 24 present 32 globally-unique
 * rooms; Caddy fans `/ws/<n>` out to the right port and the client's gateway
 * step reads a static host list. See DEPLOY.md and `caddy/rooms.Caddyfile`.
 * Nothing in this process knows the other hosts exist, which is the property
 * that makes another box just another line of config.
 */
const ROOM_BASE = Number(process.env.SYDNEY_ROOM_BASE ?? 0);

// --- Self-checks, before anything expensive -----------------------------------

/*
 * `main.ts` runs six of these before it constructs a renderer and refuses to
 * boot on any failure. This runs ten before it opens a socket, for the same
 * reason and with one addition: the four shared ones are being run **in a second
 * runtime**, and the whole premise of this architecture is that they behave
 * identically there. A shared module that silently depended on a browser global
 * would fail here rather than three hours into a match.
 */
{
  const checks: Array<[string, string[]]> = [
    ['verifyMovementBasis', verifyMovementBasis()],
    ['verifyCombat', verifyCombat()],
    ['verifyPowerups', verifyPowerups()],
    ['verifyFooty', verifyFooty()],
    ['verifyNet', verifyNet()],
    // The names, in the process that has the last word on them. This one is run
    // on both ends deliberately: the browser sanitises so the prompt shows the
    // player what they will be called, and this sanitises again because the
    // first run happened inside something the player controls -- and the whole
    // arrangement only works if the two runs agree, which is what an idempotent
    // sanitiser compiled from one file means.
    ['verifyNames', verifyNames()],
    // And the chat, in the process that has the last word on *that* too, and for
    // the same reason one line up: the browser sanitises so the box shows what
    // will be sent, this sanitises again because the first run happened inside
    // something the player controls, and the arrangement only works if the two
    // runs agree. The rate limiter's arithmetic goes with it -- a window wrong
    // by a factor either lets a flood through or throttles a conversation, and
    // neither has a frame that says so. See `client/src/net/chat.ts`.
    ['verifyChat', verifyChat()],
    // `/unstuck`, which arrives over that same wire and is intercepted before
    // the fan-out. Run here because this process is the one that actually moves
    // the player, and because both of its silent failures land on the server: a
    // prefix match instead of an exact one broadcasts nothing and teleports
    // somebody who meant to type a sentence, and a destination that skipped
    // `isSpawnable` puts them inside the next building along. See
    // `client/src/game/unstuck.ts`.
    ['verifyUnstuck', verifyUnstuck()],
    ['verifyTeleport', verifyTeleport()],
    // The suggestions box's week arithmetic, sanitiser, order and codecs.
    // Run **here** rather than only in the browser because the server is the
    // side that keeps the ledger, and every failure in that file is silent in
    // this repo's sense: the panel opens, the votes are accepted, and the count
    // is quietly against the wrong week -- which nobody reports, because nobody
    // was counting. See `client/src/net/suggestions.ts`.
    ['verifySuggestions', verifySuggestions()],
    ['verifyRewind', verifyRewind()],
    // PERFORMANCE.md phase 1's grid, which every hit test in the game now
    // takes its candidates from. A grid that is not a superset is a punch that
    // passes through somebody, and there is no frame in which that looks like
    // an index bug rather than a hit test one.
    ['verifySpatialHash', verifySpatialHash()],
    // And phase 2's selection on top of it. A working set that is missing
    // somebody nearby is a player invisible while punching you; see
    // `server/aoi.ts`, which asserts the rule against a brute-force scan.
    ['verifyAoi', verifyAoi()],
    ['verifySim', verifySim()],
  ];
  const failed = checks.filter(([, f]) => f.length > 0);
  if (failed.length > 0) {
    console.error('Self-checks failed; refusing to start.\n');
    for (const [name, f] of failed) for (const line of f) console.error(`  ${name}: ${line}`);
    process.exit(1);
  }
  console.log(`[sydney] self-checks pass: ${checks.map(([n]) => n).join(', ')}`);
}

// --- The world ----------------------------------------------------------------

const t0 = performance.now();
const world = await loadWorld(WORLD_ROOT);
console.log(
  `[sydney] world "${world.index.stage}": ${world.index.tiles.length} tiles, ` +
    `${world.collision.buildingCount.toLocaleString()} prisms (${(world.bytes.collision / 1e6).toFixed(1)} MB), ` +
    `${world.terrain.loadedTiles} terrain grids (${(world.bytes.terrain / 1e3).toFixed(0)} kB), ` +
    `${world.points.length} powerups, ${world.bikeSpots?.length ?? 0} bikes — ` +
    `${(performance.now() - t0).toFixed(0)} ms`,
);
// What the prisms are actually costing, and what would happen if they cost more.
// The second half of the line is the whole of the 60 km argument: the resident
// figure is what the box pays, the cap is where it stops, and the hexagon count
// is how much of the city is being held to serve nobody.
if (world.segments) {
  const s = world.segments.stats();
  console.log(
    `[sydney] collision per hexagon: ${s.resident}/${s.hexes} resident, ` +
      `${(s.bytes / 1e6).toFixed(0)} MB estimated against a ${(s.capBytes / 1e6).toFixed(0)} MB cap ` +
      `(SYDNEY_COLLISION_CAP_MB), ${s.tiles} tiles`,
  );
}

/**
 * The rooms, sharing that one city read-only.
 *
 * `roomWorld` is what makes "read-only" true rather than hoped: it hands every
 * room the same collision, terrain, water, lanes and footpaths, and gives each
 * its own `PowerupField` -- the one thing in a loaded world that a tick mutates.
 * See its header for the audit of everything else.
 */
const tRooms = performance.now();
const host = new RoomHost(world, ROOM_COUNT, ROOM_CAP, BOT_COUNT, ROOM_BASE);
console.log(
  `[sydney] ${ROOM_COUNT} room(s) ${ROOM_BASE}..${ROOM_BASE + ROOM_COUNT - 1}, cap ${ROOM_CAP} each ` +
    `(${ROOM_COUNT * ROOM_CAP} players this process), ${BOT_COUNT} bot(s) per room — ` +
    `${(performance.now() - tRooms).toFixed(0)} ms`,
);

/**
 * Global chat, which is the one channel that belongs to the **host** rather than
 * to a room.
 *
 * Constructed here beside the rooms rather than inside `RoomHost` for exactly
 * that reason: a `Room` owns a simulation and its sockets, and a hub that lived
 * on one would be a hub with an opinion about which room chat came from. See
 * `server/chat.ts`, including the multi-process limitation it states.
 */
const chat = new ChatHub();

/**
 * The suggestions box: a durable ledger and a one-way mirror into GitHub issues.
 *
 * Host-wide rather than per-room, on `chat`'s argument and one stronger: a
 * suggestion is about **the game**, not about the twelve people who happened to
 * be in room 3 when somebody thought of it. Two rooms with two lists would be
 * two lists to curate and a vote that meant a different amount depending on
 * where you spawned.
 *
 * Constructed before the socket opens and `load`ed before it accepts anybody,
 * so the first player to open the panel sees the real list rather than an empty
 * one that fills in a moment later.
 */
const suggestions = new SuggestionStore({
  path: defaultLedgerPath(WORLD_ROOT),
  repo: githubRepo(),
  // Read once, here, from the environment. Never from a client, never logged.
  // See `server/suggestions.ts`'s header for what is enforced structurally about
  // the credential rather than by care.
  token: githubToken(),
});
await suggestions.load();
const suggestionHub = new SuggestionHub(suggestions);
console.log(`[sydney] suggestions: ${suggestions.describe()}`);
// The first read, not awaited: it picks up anything filed on GitHub directly and
// anything the curator closed since the last run, and a boot that blocked on
// api.github.com would be a boot that fails when GitHub does.
void suggestions.refresh();

// --- Connections --------------------------------------------------------------

const conns = new Set<Socket>();

/**
 * The room a request is asking for, from `?room=<id>`, or -1 for "you choose".
 *
 * Parsed at the **upgrade** rather than out of the hello, and the choice is
 * worth a line. A query parameter is visible in a link -- which is what "join my
 * room" is -- survives a reconnect without the client having to remember
 * anything, and shows up in a proxy log when somebody asks why they landed in
 * room 3. A first-hello byte would have been two bytes cheaper and invisible in
 * every one of those places.
 *
 * An unparseable or unknown room is **not** refused here. It becomes -1 and the
 * gateway picks, because the alternative -- a 400 on the upgrade -- is a
 * WebSocket that closes with no reason a browser will surface, and the failure a
 * player actually hits is a stale link to a room that has since been renumbered.
 */
function askedRoom(url: URL): number {
  const raw = url.searchParams.get('room');
  if (raw === null) return -1;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : -1;
}

const server = Bun.serve<Conn>({
  port: PORT,
  hostname: '0.0.0.0',

  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      let bots = 0;
      for (const r of host.rooms) bots += r.sim.participants.size - r.humans();
      return json({
        ok: true,
        players: host.players(),
        // Every room's bots, summed. Kept as a top-level field across the phase 3
        // rewrite because `server/integration-check.ts` prints it in its
        // transcript header and a deployment probe should not have to sum an
        // array to answer "is anything alive in there".
        bots,
        rooms: host.listing(),
        stage: world.index.stage,
        protocol: PROTOCOL_VERSION,
        // The join disc's centre, which both ends already compute from the same
        // `index.json` (`game/spawn.spawnCentre`). Published because
        // `server/loadtest.ts`'s pileup scenario needs a world coordinate every
        // synthetic client can converge on, and the alternative -- baking one
        // into the harness -- would be a constant that silently stopped being a
        // street the day the extent moved.
        spawn: world.spawn,
      });
    }
    /*
     * `/rooms` -- the gateway, and the whole of the join protocol above the
     * socket.
     *
     * Its own route rather than a field on `/health`, on `/stats`' own argument:
     * `/health` is a liveness probe a deployment hits and this is a thing every
     * client fetches before every join. Kept deliberately tiny (a room is about
     * 45 bytes of JSON, so eight rooms is 360 B) and deliberately dumb -- the
     * client picks, because a server that picked would need a way to say "and
     * connect here", and that is a redirect protocol for a decision the client
     * can make from four numbers.
     */
    if (url.pathname === '/rooms') return json(host.listing());
    /*
     * `/stats` -- what `server/loadtest.ts` reads, and the only thing in this
     * process that knows where a tick went.
     *
     * **Reading it resets the window**, so successive polls report disjoint
     * intervals and a harness can integrate them. The tick-cost percentiles are
     * the exception: they come off a 20 s ring that is not cleared, because a
     * p99 that only ever saw one poll's worth of ticks is not a p99.
     *
     * Phase 3 added the per-room breakdown, and it is the point of the route
     * now: a host whose p99 is 9 ms because one room of 128 is doing all the
     * work is a completely different machine from one whose eight rooms are
     * evenly loaded, and the aggregate cannot tell them apart.
     */
    if (url.pathname === '/stats') {
      const now = performance.now();
      const window = Math.max(1e-6, now - statsReadAt);
      const ticksInWindow = Math.max(1, ticksRun - statsTicksAt);
      const rooms = host.rooms.map((r) => r.stats(ticksInWindow));
      const players = host.players();
      let bytesOut = 0;
      let snapshots = 0;
      let stalls = 0;
      let framesSent = 0;
      let framesEncoded = 0;
      let interestTotal = 0;
      let interestSamples = 0;
      let interestMax = 0;
      const phases: Record<string, number> = {};
      for (const r of host.rooms) {
        bytesOut += r.bytesSent;
        snapshots += r.snapshotsSent;
        stalls += r.stalls;
        framesSent += r.framesSent;
        framesEncoded += r.framesEncoded;
        interestTotal += r.interestTotal;
        interestSamples += r.interestSamples;
        if (r.interestMax > interestMax) interestMax = r.interestMax;
      }
      // The host's phase breakdown is the **sum** across rooms, because that is
      // what a tick of this process costs. A per-room average would answer a
      // question nobody is asking: the budget is one 16.67 ms tick for all of
      // them together.
      for (const s of rooms) {
        for (const [k, v] of Object.entries(s.phaseMs)) phases[k] = (phases[k] ?? 0) + v;
      }
      const sorted = Float64Array.prototype.slice.call(hostTickCost, 0, Math.min(ticksMeasured, hostTickCost.length)).sort();
      const at = (q: number): number => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]);
      const body = JSON.stringify({
        tick: host.rooms[0]?.sim.tick ?? 0,
        players,
        rooms: rooms.length,
        /** Ticks per second actually achieved. Below 60 means the loop is losing. */
        tickHz: (ticksInWindow / window) * 1000,
        /** The **host's** tick: every room, plus the pump. This is the budget. */
        tickMs: { p50: at(0.5), p90: at(0.9), p99: at(0.99), max: worstHostTick },
        stalls,
        phaseMs: phases,
        bytesOut,
        snapshots,
        /** Bytes per client per second, the number AOI exists to bring down. */
        bytesPerClientPerSec: players > 0 ? (bytesOut / players / window) * 1000 : 0,
        /** Frames sent per frame encoded. See `server/aoi.ts`'s `FrameGroups`. */
        dedup: framesEncoded === 0 ? 1 : framesSent / framesEncoded,
        interest: {
          mean: interestSamples === 0 ? 0 : interestTotal / interestSamples,
          max: interestMax,
        },
        rss: process.memoryUsage.rss(),
        heap: process.memoryUsage().heapUsed,
        /**
         * What the city is costing, and whether the cap is doing anything.
         *
         * Reported beside `rss` on purpose: `rss` says what the box is paying
         * and this says which part of it is prisms and how much of that is the
         * hexagons somebody is standing in. `null` on a world with no hex
         * contract, where the answer is "all of it, always". See
         * `world.HexResidency`.
         */
        segments: world.segments?.stats() ?? null,
        windowMs: window,
        ticksInWindow,
        room: rooms,
      });
      statsReadAt = now;
      statsTicksAt = ticksRun;
      for (const r of host.rooms) r.resetWindow();
      worstHostTick = 0;
      return new Response(body, {
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      });
    }
    // The upgrade accepts any path -- see DEPLOY.md, where Caddy proxies `/ws`
    // to this and phase 3 adds `/ws/<n>` for a fan-out across host processes.
    // The room, if one was asked for, rides the query.
    const ok = srv.upgrade(req, { data: newConn(askedRoom(url)) });
    if (ok) return undefined;
    return new Response('SYDNEY game server. Connect a WebSocket; tiles are served elsewhere.\n', {
      status: 426,
    });
  },

  websocket: {
    // Binary frames only, and `perMessageDeflate` off. Compressing a 50-byte
    // snapshot of already-quantised integers costs a compressor pass per client
    // per snapshot to save nothing: the payload is dense by construction, which
    // is the entire point of `net/protocol.ts`.
    perMessageDeflate: false,
    maxPayloadLength: 1024,

    open(ws: Socket) {
      conns.add(ws);
      // The first round-trip measurement, asked for immediately rather than on
      // the next timer tick. `Conn.rtt` steers spec 8.2's rewind and starts on a
      // seed; asking here means the seed is replaced one trip into the
      // connection, which is long before this socket has said hello, banked its
      // input reserve or swung anything. See `HEARTBEAT_MS`.
      heartbeat(ws);
    },

    /**
     * A WebSocket protocol pong -- the other half of the only round trip this
     * server measures itself. See `HEARTBEAT_MS` in `server/room.ts` for the
     * whole argument, including what a custom client can still do with it.
     *
     * Bun's own keep-alive pings produce pongs that land here too; they fail the
     * nonce match inside `receivePong` and are dropped, which is the same path
     * an unsolicited or replayed pong takes.
     */
    pong(ws: Socket, data: Buffer) {
      receivePong(ws.data, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    },

    message(ws: Socket, raw: string | Buffer) {
      if (typeof raw === 'string') return; // no text protocol exists
      const frame = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
      const conn = ws.data;
      conn.lastSeen = Date.now();

      switch (frameType(frame)) {
        case MSG.HELLO: {
          const hello = decodeHello(frame);
          if (!hello) return;
          if (hello.version !== PROTOCOL_VERSION) {
            // Refused rather than tolerated. See `PROTOCOL_VERSION`: the two
            // ends do not ship together, so a tab left open across a restart is
            // the normal case and a misparsed snapshot is the normal symptom.
            // v8 widened four id fields, so a v7 client reading a v8 snapshot
            // would put every player at a plausible wrong position -- which is
            // exactly the silent failure this refusal exists for.
            ws.send(encodeBye(`protocol ${hello.version}; this server speaks ${PROTOCOL_VERSION}. Reload the page.`));
            ws.close(1002, 'protocol');
            return;
          }
          if (conn.participant) return; // a second hello on one socket is ignored

          // --- The gateway, in four lines.
          //
          // A named room is honoured if it exists and has space; a named room
          // that is full is refused **by name** rather than silently rehomed,
          // because somebody who followed a friend's link would rather be told
          // than dropped into a different city. No room named means the
          // least-full open one, which is what a bare `wss://host/ws` gets and
          // is what keeps every existing bookmark working.
          const wanted = conn.room >= 0 ? host.get(conn.room) : host.leastFull();
          if (!wanted) {
            const detail = conn.room >= 0
              ? `no room ${conn.room} on this host`
              : `every room on this host is full (${host.rooms.length} x ${ROOM_CAP})`;
            ws.send(encodeBye(detail));
            ws.close(1013, 'full');
            return;
          }
          // The name is a request, exactly as the colourway is. `sim.join`
          // sanitises it again and dedupes it against the room -- see
          // `Simulation.pickName` -- so what comes back on `p.name` is what this
          // player is actually called, which is not always what they asked for.
          const p = wanted.join(conn, hello.colourway, hello.name);
          if (!p) {
            ws.send(encodeBye(`room ${wanted.id} is full (${wanted.cap} players)`));
            ws.close(1013, 'full');
            return;
          }
          conn.room = wanted.id;
          wanted.conns.add(ws);
          wanted.welcome(ws, p);
          console.log(
            `[sydney] room ${wanted.id}: player ${p.id} "${p.name}" joined (kit ${p.colourway}); ` +
              `${wanted.sim.participants.size} in the room`,
          );
          return;
        }

        case MSG.INPUT: {
          if (!conn.participant) return;
          // Filed on this socket's own ring, oldest first, and taken one per
          // tick. `receiveInput` decodes straight into the ring's record, so
          // there is no shared scratch to alias and no allocation -- see
          // `Conn.inbox`, which is also where the reason it is a ring and not
          // one slot is written down.
          receiveInput(conn, frame);
          return;
        }

        case MSG.PING: {
          const ping = decodePing(frame);
          if (!ping) return;
          // The reported round trip, for the scoreboard's ping column and for
          // nothing else. `conn.rtt` -- which decides how far a punch is rewound
          // -- is deliberately not written here: see `protocol.encodePing` for
          // why a client that could set its own rewind budget would.
          //
          // Unchanged by the pass that gave the server its own measurement, and
          // deliberately so. The rewind now reads a median of protocol pongs
          // (`HEARTBEAT_MS`), and this line still reads the client's own number:
          // two values, two purposes, and the client's still steers nothing. The
          // refusal here was never the bug -- the missing measurement was.
          if (conn.participant) conn.participant.ping = ping.rttMs;
          ws.send(encodePong(ping.seq, ping.clientTime, performance.now()));
          return;
        }

        /*
         * Global chat, and the one message here that leaves the room it arrived
         * in. See `server/chat.ts` for the fan-out, the abuse floor and the
         * multi-process limitation.
         *
         * `host` is handed in rather than the room, which is the whole point:
         * every other case in this switch resolves `conn.room` and stops there.
         */
        case MSG.CHAT_SAY: {
          chat.say(host, ws, frame);
          return;
        }

        /*
         * The suggestions box, and the second message here that is the host's
         * rather than a room's. See `server/suggestions.ts`.
         *
         * The only `await`-shaped case in this switch, and it is deliberately
         * **not awaited**: filing a suggestion posts to GitHub, and a message
         * handler that waited on api.github.com would stall this socket's reads
         * behind somebody else's network. `void` is the honest spelling of "this
         * finishes on its own and answers the client when it does" -- the
         * acknowledgement is a frame, not a return value, so nothing here needs
         * the result. Rejections cannot escape: every path inside `handle`
         * catches its own.
         */
        case MSG.SUGGEST: {
          void suggestionHub.handle(ws, frame);
          return;
        }

        default:
          return;
      }
    },

    close(ws: Socket) {
      conns.delete(ws);
      // The suggestions hub holds a set of sockets with a panel open, so it can
      // push the list when a score moves. Forgetting on close is what stops that
      // set being an unbounded leak of dead sockets on a long-running host.
      suggestionHub.forget(ws);
      const conn = ws.data;
      const room = conn.room >= 0 ? host.get(conn.room) : undefined;
      const p = conn.participant;
      if (room) room.leave(ws);
      if (p) {
        console.log(
          `[sydney] room ${conn.room}: player ${p.id} "${p.name}" left (${p.kos} KOs, ${p.downs} downs)`,
        );
      }
    },
  },
});

// --- The loop -----------------------------------------------------------------

/**
 * Spec 10's 60 Hz, drift-corrected, stepping every room.
 *
 * `setInterval(fn, 16.67)` is the obvious implementation and it is wrong in a
 * way that takes an hour to see: the interval is a *minimum*, so every tick that
 * runs long pushes the next one out and the error accumulates. Over ten minutes
 * a naive interval loses several seconds, and because the client is predicting
 * against its own accurate 60 Hz, the drift presents as reconciliation
 * corrections that grow steadily worse the longer a session runs.
 *
 * So the loop keeps an absolute schedule -- tick *n* is due at `start + n / 60`
 * -- and catches up when it falls behind, with a cap for the same reason
 * `main.ts` clamps its frame delta: a process suspended by a laptop lid must not
 * run four thousand ticks on resume.
 *
 * **Every room advances on the same schedule**, which is the one thing phase 3
 * did not change and could have: a room-per-timer would drift independently and
 * make "the host's tick" meaningless. One pump, R rooms, one number to budget.
 */
const MAX_CATCHUP_TICKS = 8;
const startedAt = performance.now();
let ticksRun = 0;

/** Rolling cost of a whole host tick -- every room plus the pump. See `/stats`. */
const hostTickCost = new Float64Array(TICK_HZ * 20);
let costCursor = 0;
let ticksMeasured = 0;
let worstHostTick = 0;

function runTick(): void {
  const began = performance.now();
  host.step();
  const cost = performance.now() - began;
  hostTickCost[costCursor] = cost;
  costCursor = (costCursor + 1) % hostTickCost.length;
  ticksMeasured++;
  if (cost > worstHostTick) worstHostTick = cost;
}

function pump(): void {
  const due = Math.floor(((performance.now() - startedAt) / 1000) * TICK_HZ);
  let behind = due - ticksRun;
  if (behind > MAX_CATCHUP_TICKS) {
    // Resumed from a suspend, or a very long GC. Skipping is the honest answer:
    // running the missed ticks would teleport everyone and running none would
    // freeze the world. `main.ts` makes the same call about its frame delta.
    ticksRun = due - 1;
    behind = 1;
  }
  for (let i = 0; i < behind; i++) {
    runTick();
    ticksRun++;
  }
  // The next tick's due time, less the time already spent. `setTimeout(0)` when
  // behind, which yields to the socket reads rather than spinning.
  const nextDue = startedAt + ((ticksRun + 1) / TICK_HZ) * 1000;
  setTimeout(pump, Math.max(0, nextDue - performance.now()));
}

pump();

// --- Housekeeping -------------------------------------------------------------

function json(body: unknown): Response {
  // The one class of route that is not the game, and the one that needs a CORS
  // header: a browser fetching it from the vite origin is a cross-origin
  // request, where the WebSocket upgrade is not subject to the same-origin
  // policy at all. `/rooms` needs it most -- it is fetched by every client
  // before every join.
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
}

/**
 * A stale socket is one that has sent nothing for half a minute.
 *
 * A client sends input at 60 Hz and pings twice a second, so a second of silence
 * is already a broken connection and thirty is enormously generous. The
 * generosity is aimed at exactly one case, and it is the case this whole pass
 * exists for: **two browser windows on one machine**, only one of which is
 * focused. A browser stops issuing animation frames to a window it considers
 * hidden, which stops that client's input entirely -- so the only thing holding
 * its socket open is `net/client.ts`'s ping, which is on a timer for this reason
 * and which a browser throttles to about 1 Hz rather than stopping.
 */
const STALE_MS = 30000;
setInterval(() => {
  const now = Date.now();
  for (const ws of conns) {
    if (now - ws.data.lastSeen > STALE_MS) ws.close(1001, 'silent');
  }
}, 5000);

/**
 * The round-trip heartbeat: one protocol ping per socket, twice a second.
 *
 * Host-wide rather than per room, because a round trip is a property of a
 * socket and `Room` is a thing that must be steppable with no network under it
 * at all -- which is what the check harness relies on.
 *
 * The cost is four bytes of payload in a ten-byte frame, twice a second: at a
 * full 128-player host that is 2.6 kB/s against a downlink already measured in
 * hundreds of kbit. It does **not** replace the stale sweep above. A pong comes
 * from the peer's network stack whether or not the page is alive, so a socket
 * answering pings is not evidence anybody is still playing; `lastSeen` is only
 * moved by a message the client's own code chose to send, and stays that way.
 */
setInterval(() => {
  const now = performance.now();
  for (const ws of conns) heartbeat(ws, now);
}, HEARTBEAT_MS);

/** When `/stats` last reported, so each poll covers a disjoint window. */
let statsReadAt = performance.now();
let statsTicksAt = 0;

/** One line every ten seconds, and only when somebody is connected. */
setInterval(() => {
  const players = host.players();
  if (players === 0) return;
  const sorted = Array.from(hostTickCost).filter((v) => v > 0).sort((a, b) => a - b);
  const median = sorted.length ? sorted[sorted.length >> 1] : 0;
  let bytes = 0;
  let snapshots = 0;
  let framesSent = 0;
  let framesEncoded = 0;
  let interestTotal = 0;
  let interestSamples = 0;
  for (const r of host.rooms) {
    // The log's own counters, not `/stats`'. Both readers reset what they read,
    // and a console line landing between two polls used to steal that window's
    // bytes -- which the harness reported as a downlink alternating between 47
    // and 186 kbit/s. See `Room.logBytes`.
    bytes += r.logBytes;
    snapshots += r.logSnapshots;
    framesSent += r.framesSent;
    framesEncoded += r.framesEncoded;
    interestTotal += r.interestTotal;
    interestSamples += r.interestSamples;
  }
  const rate = (bytes * 8) / 10 / 1000;
  const set = interestSamples === 0 ? 0 : interestTotal / interestSamples;
  console.log(
    `[sydney] ${players} player(s) across ${host.rooms.length} room(s)  ` +
      `${median.toFixed(2)} ms/host-tick median  ${snapshots} snapshots  ${rate.toFixed(1)} kbit/s out  ` +
      `working set ${set.toFixed(1)} avg (${snapshotBytes(Math.round(set))} B/snapshot)  ` +
      `dedup ${(framesEncoded === 0 ? 1 : framesSent / framesEncoded).toFixed(2)}x`,
  );
  // The board itself, per room, so a session leaves a record in the log it has
  // nowhere else to leave one -- there is no persistence and the scoreboard dies
  // with the process, which is spec 12's call and not this line's to change.
  for (const r of host.rooms) {
    const board = rankRoster(r.sim.roster());
    if (board.some((row) => row.kos > 0 || row.downs > 0)) {
      console.log(`[sydney]   room ${r.id}: ${board.slice(0, 8).map((row) => `${row.name} ${row.kos}/${row.downs}`).join('   ')}`);
    }
  }
  for (const r of host.rooms) {
    r.logBytes = 0;
    r.logSnapshots = 0;
    r.rostersSent = 0;
  }
}, 10000);

console.log(
  `[sydney] listening on ws://localhost:${server.port}  ` +
    `(${TICK_HZ} Hz tick, ${SNAPSHOT_HZ} Hz snapshots, ${MAX_REWIND_MS} ms rewind, protocol ${PROTOCOL_VERSION}, ` +
    `spec 2's cap is ${MAX_PLAYERS} and a room here holds ${ROOM_CAP})`,
);
console.log(`[sydney] health: http://localhost:${server.port}/health   rooms: http://localhost:${server.port}/rooms`);

/**
 * Get the suggestions ledger on disk and its tallies onto GitHub before dying.
 *
 * The **only** thing in this process with state worth flushing, which is why
 * this is the first shutdown hook the server has ever had: the game itself is
 * deliberately unpersisted (spec 12 -- no accounts, no storage, the scoreboard
 * dies with the process) and a room has nothing to save. The votes are the
 * exception, because they are the one thing here a player accumulates across
 * sessions.
 *
 * Both signals, because they arrive from different places and mean the same
 * thing: SIGINT is Ctrl-C in a terminal and SIGTERM is systemd stopping the
 * unit on a deploy, which is the case that would otherwise lose up to a minute
 * of tallies on every restart.
 *
 * The ledger writes are already debounced to 250 ms and would mostly have
 * landed; what this really buys is the **GitHub flush**, which is on a 60 s
 * timer by design (see `SuggestionStore`) and would otherwise leave the last
 * minute of voting out of the issue bodies until somebody voted again.
 *
 * `process.exit` at the end rather than falling through: the 60 Hz pump is a
 * `setTimeout` chain that will happily keep this process alive forever, and a
 * deploy that waited on it would wait for systemd's kill timer instead.
 */
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // Guarded, because a second Ctrl-C while the first flush is in flight would
    // otherwise start a concurrent one -- and `sync` posting the same queued
    // suggestion twice is a duplicate issue that cannot be un-filed.
    if (stopping) return;
    stopping = true;
    console.log(`[sydney] ${signal}: flushing suggestions…`);
    void suggestions
      .close()
      .catch((err) => console.error(`[sydney] suggestions: flush failed: ${String(err)}`))
      .finally(() => process.exit(0));
  });
}
