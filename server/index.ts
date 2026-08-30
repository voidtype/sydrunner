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
// The bat against the ball, in the process that adjudicates it. See
// `client/src/game/swat.ts`.
import { verifySwat } from '../client/src/game/swat.ts';
import { verifyPowerups } from '../client/src/game/powerups.ts';
import { verifyDamageGrade, verifyDriving } from '../client/src/game/driving.ts';
// WORKSTREAM Y: a wrecked car catching fire and going off. Run **here** as well
// as in the browser because the fuse, the blast and the chain are all this
// side's authority and every failure in that file renders: a fuse that never
// expires is a city of burning cars and no explosions, and a blast falloff with
// a cliff in it is damage a player reads as random. See `game/carfire.ts`.
import { verifyCarFire } from '../client/src/game/carfire.ts';
// WORKSTREAM S: the parked fleet's decoder and residency accounting. Three-free
// by rule -- this process now streams `.cars.bin` per hexagon so that the 23,020
// cars at a kerb are takeable and not just the forty on the timetable. The body
// and paint counts are omitted here and passed by `main.ts`, which is the end
// that can load the palette; see `verifyStaticCars`.
import { verifyStaticCars } from '../client/src/game/staticcars.ts';
// And the *drawing* of a car somebody took, which is a browser rule checked here
// on `verifyViewLatch`'s argument two imports down: `world/drivencars.ts` owns no
// mesh and imports three only as types, so this process can run every line of it.
// It is in this list because of what the newest section catches -- the car you
// are driving leaving its own draw radius 460 m after you take it, because the
// gate was asked about the kerb rather than about you. See its `near` argument.
import { verifyDrivenCars } from '../client/src/world/drivencars.ts';
import { verifyTraffic } from '../client/src/game/traffic.ts';
// --- Workstream Q. A client presentation rule, checked here anyway: see the
// header of `game/viewlatch.ts` for why a rule about what the *browser* draws is
// tested in Bun, and `PREAMBLE`'s rule that a `verify*` runs in both boot lists.
import { verifyViewLatch } from '../client/src/game/viewlatch.ts';
// --- Workstream I. Three three-free modules, all run here as well as in the
// browser, and each for the reason given at its own entry in the table below.
import { verifyHandsPose } from '../client/src/game/hands-pose.ts';
import { verifyLevelHud } from '../client/src/game/levelhud.ts';
// WORKSTREAM X (teams you can see): the three-free half of the team look. The
// geometry half (`verifyBigNightKit`) imports three and runs in the browser only.
import { verifyTeamLook } from '../client/src/game/teamlook.ts';
// WORKSTREAM AJ: the ground gate's arithmetic, three-free, so it runs in both
// boot lists as this file's own premise requires.
import { verifyGroundFirst } from '../client/src/world/ground-first.ts';
import { verifyCanopy } from '../client/src/world/cover.ts';
import { verifyStemVariety } from '../client/src/world/tile-decode.ts';
// WORKSTREAM N (carry): the restore sentence, and the spawn rules this process
// has always run without checking. Both three-free, so this process runs the
// same checks the browser does. See `client/src/game/carry.ts`.
import { verifyCarry } from '../client/src/game/carry.ts';
import { verifySpawn } from '../client/src/game/spawn.ts';
import { verifyCashDrops } from '../client/src/game/cashnote.ts';
import { verifySpatialHash } from '../client/src/game/spatialhash.ts';
// WORKSTREAM AG: how much of a corridor a track may build in. Both boot lists,
// because `server/world.ts` builds the same atlas to answer where a platform is.
import { verifyTrackAtlas } from '../client/src/world/track-atlas.ts';
import { verifyStationLayouts } from '../client/src/world/station-layouts.ts';
import { verifyPlatformSpine } from '../client/src/world/platform-spine.ts';
import { verifyRailLateral } from './rail-lateral.ts';
import { verifyMovementBasis } from '../client/src/player/controller.ts';
// WORKSTREAM O (feel): the one breath both viewmodels apply. Three-free, which is
// why it can be run here at all -- `verifyBat` and `verifyFootyBall` cannot be,
// because they build geometry. See the entry in the list below.
import { verifyViewmodelIdle } from '../client/src/player/viewmodel-idle.ts';
import {
  MAX_PLAYERS,
  MAX_REWIND_MS,
  MSG,
  PROTOCOL_VERSION,
  TICK_HZ,
  decodeHello,
  decodePing,
  decodeSunPress,
  encodeBye,
  encodePong,
  frameType,
  rankRoster,
  snapshotBytes,
} from '../client/src/net/protocol.ts';
import { verifyNames, verifyNet } from '../client/src/net/protocol.ts';
import { verifyChat } from '../client/src/net/chat.ts';
import { verifyUnstuck } from '../client/src/game/unstuck.ts';
// The heat ladder. Run here because this process is the authority for it: the
// star count, the decay, the patrol cars and the RBTs are all decided in this
// process and *sent*, so every one of that file's silent failures -- a
// non-monotone threshold table, a tier that cannot be shed, a crime priced past
// the top of the ladder -- lands on players in a session and never in a
// browser's console. See `client/src/game/heat.ts`'s check for the list.
import { verifyHeat } from '../client/src/game/heat.ts';
// --- WORKSTREAM W: the talent hooks and the ability table. One entry in this
// list and one in `main.ts`, both running the same two functions, because every
// number in them is evaluated on **both** ends -- the swing damage the browser
// predicts and this process adjudicates, the take radius both arbitrate, the
// crash multiplier the driver's client uses to move its own health bar. See
// `client/src/game/teamfx.ts`.
import { verifyTeamFx } from '../client/src/game/teamfx.ts';
import { verifyAbilities } from '../client/src/game/abilities.ts';
// WORKSTREAM Z: a third term rather than a fold into `verifyTeamFx`, because
// `game/talentlive.ts` imports `teamfx.ts` and the reverse would be a cycle.
import { verifyTalentLive } from '../client/src/game/talentlive.ts';
// Polair's orbit, beam schedule and marksman. Run **here** as well as in the
// browser because this process is the one that rolls the shot: `stepHeat` calls
// `polairPose` for the slant range, and every failure in that file is silent in
// this repo's sense -- a beam that never leaves the player is the old ceiling
// lamp, and an accuracy curve at the ground officers' floor is free damage from
// something a player cannot fight. See `client/src/game/polair.ts`.
import { verifyPolair } from '../client/src/game/polair.ts';
// --- Workstream E. Three self-checks, all three of them shared modules being
// run in the second runtime -- which is the premise this whole block exists to
// test. See the comment above the list.
import { verifyCharacters } from '../client/src/game/characters.ts';
// WORKSTREAM AC: and the street factions', which this process runs every tick
// and never checked at boot. See the list below.
import { verifyStreetlife } from '../client/src/game/streetlife.ts';
// WORKSTREAM AP: and the police's own, which has run in `main.ts`'s boot list
// since the pursuit shipped and has never run here -- on this side of the wire,
// where the shot is actually adjudicated. See the list below.
import { verifyPolice } from '../client/src/game/factions.ts';
import { verifyEvents } from '../client/src/game/events.ts';
import { verifyWallet } from './wallet-contract.ts';
import { verifyTeleport } from '../client/src/game/teleport.ts';
// WORKSTREAM L (trains): the Metro's open gangways. See `verifyGangway`.
import { verifyGangway, verifyStationAccess } from '../client/src/game/riding.ts';
import { sunReady, sunScreaming, verifySunButton } from '../client/src/game/sunbutton.ts';
import { trafficTick } from '../client/src/game/traffic.ts';
import { verifySuggestions } from '../client/src/net/suggestions.ts';
import { verifyAoi } from './aoi.ts';
import { describeRate, verifySnapshotRate } from '../client/src/net/snapshotrate.ts';
import { BugGuards, BugStore, defaultBugDir, handleBugRequest, verifyBugs } from './bugs.ts';
import { ChatHub } from './chat.ts';
import {
  SuggestionHub,
  SuggestionStore,
  defaultLedgerPath,
  githubRepo,
  githubToken,
} from './suggestions.ts';
// --- Money. See `client/src/game/cash.ts`, `server/wallets.ts`, `server/fares.ts`.
//
// One block, and the only three things this file has to know about the
// feature: the checks it runs at boot, the store it constructs and hands to
// every room, and the fake-driving hatch that makes the fare loop exercisable
// before the driving workstream lands.
import { verifyCash } from '../client/src/game/cash.ts';
// The phone's model -- the slots, the two map rules and the photo album. None of
// it is the server's business at run time and all of it is checkable here; see
// `client/src/game/phone.ts`, which exists precisely so this import does not
// drag a `document` in behind it.
import { verifyPhoneModel } from '../client/src/game/phone.ts';
import { PHONE_OP, decodePhone, verifyCashWire } from '../client/src/net/cash.ts';
// --- WORKSTREAM V: teams and talents. Three files and three checks: the
// contract (the 42 nodes, the tier gates, the two names), the lookup that folds
// auras in, and the wire. All three are three-free and all three run in both
// boot lists -- see `client/src/game/teams.ts`, whose header is emphatic about
// the one thing a check can catch here that a person cannot: the spelling.
import { verifyTeams } from '../client/src/game/teams.ts';
import { verifyTeamField } from '../client/src/game/teamfield.ts';
import { decodeTeamOp, verifyTeamsWire } from '../client/src/net/teams.ts';
import { verifyDrivingContract } from '../client/src/game/driving-contract.ts';
// --- WORKSTREAM AL. The traffic's own sound, which this process cannot make and
// can entirely check: `game/carsound.ts` is three-free on `game/rail-audio.ts`'
// terms, so the whole schedule -- which cars are audible, how loud, at what pitch
// -- re-derives here with no `AudioContext` within a mile of it.
import { verifyCarSound } from '../client/src/game/carsound.ts';
// And the floor underneath it. `game/citybed.ts` is three-free for the same
// reason and checks the same way: the swell is a pure function of seconds and
// the pink buffer is a Float32Array, so the colour, the loop seam and the level
// all re-derive here with no `AudioContext` in the process.
import { verifyCityBed } from '../client/src/game/citybed.ts';
import { verifyFares } from './fares.ts';
import { WalletStore, defaultWalletPath, verifyWallets } from './wallets.ts';
// --- Accounts, unique handles and the level ladder. Workstream G.
//
// One block, and the same three things this file has to know about the feature
// that the money block above it lists: the check it runs at boot, the store it
// constructs and hands to every room, and the routes it puts in front of it.
// The rules are `client/src/net/accounts.ts` (shared with the browser, because
// a handle has to fold the same way in the field the player types it into) and
// the store is `server/accounts.ts`.
import {
  AccountStore,
  AuthGuards,
  bearerOf,
  defaultAccountPath,
  handleAuthRequest,
  verifyAccounts,
  // WORKSTREAM N (carry): the shape the auth routes ask this file for a body in.
  type LiveLookup,
} from './accounts.ts';
import { verifyRewind } from './rewind.ts';
import { verifySim } from './sim.ts';
/*
 * --- WORKSTREAM AK: quests and dialog as content, and the AI seam.
 *
 * One block, on the accounts block's arrangement above and for its reason: the
 * three things this file has to know about the feature are the checks it runs
 * at boot, the stores it constructs, and the route and the message it puts in
 * front of them. The **rules** are `client/src/game/questmodel.ts` (shared with
 * the browser, because a dialog gate has to be greyed out the same way it is
 * refused) and the **wire** is `client/src/net/quests.ts`.
 */
import { verifyMushrooms } from '../client/src/game/mushrooms.ts';
import { verifyTrips } from '../client/src/game/trips.ts';
import { verifyTripView } from '../client/src/world/tripview.ts';
import { Audience, BLESSED_FLAG, MAX_TURNS, askGod, verifyGod } from './god.ts';
import { verifyMandala } from '../client/src/game/mandala.ts';
import { verifyQuestAim } from '../client/src/game/questaim.ts';
import { verifyQuestAreas } from '../client/src/game/questareas.ts';
import { verifyBuildBudget } from '../client/src/world/buildbudget.ts';
import { verifyInterpDelay } from '../client/src/net/interpdelay.ts';
import { verifyDialog, verifyQuests } from '../client/src/game/questmodel.ts';
// WORKSTREAM AO: who the givers in that content *are* -- kit, heading, stance
// and the height the mark over them hangs at. Three-free by construction and
// checked here for `verifyPhoneModel`'s reason: this process serves the content
// these rules are read off, so it should refuse to start over a rule that is
// broken. Nothing here runs in the simulation -- a giver is not an actor.
import { verifyGiverBodies } from '../client/src/game/giverbodies.ts';
import { verifyWaypoint } from '../client/src/game/waypoint.ts';
import { verifyGiverMap } from '../client/src/game/givermap.ts';
// WORKSTREAM AS. The three pure halves of the tracker and the job list. Same
// arrangement as the two above and the same reason: what they catch -- a hub
// that renames itself when the player walks past it, a corner that goes blank
// exactly when a player has nothing to do, a job listed in two places at once --
// has no screenshot that says so, and the server can read all three.
import { verifyQuestHubs } from '../client/src/game/questhubs.ts';
import { verifyQuestTrack } from '../client/src/game/questtrack.ts';
import { verifyQuestLog } from '../client/src/game/questlog.ts';
// WORKSTREAM AT. The three pure halves of the stall instruments. Same
// arrangement and the same reason: a carry that spills a stall into the next
// two frames, a stolen-time floor that reports the browser's ordinary overhead
// as theft, and a boundary counter that mistakes pacing a circle for crossing a
// ring are all arithmetic, and none of them has a screenshot that says so.
import { verifyFrameStep } from '../client/src/game/framestep.ts';
import { verifyStallRing } from '../client/src/game/stallring.ts';
import { verifyTilePriority } from '../client/src/world/tilepriority.ts';
import { verifyBoundaryLog } from '../client/src/world/boundarylog.ts';
import { decodeQuest, verifyQuestWire } from '../client/src/net/quests.ts';
import { ContentStore, ImprovCache, QuestEngine, contentResponse, type QuestWorld } from './quests.ts';
import { TEAM } from '../client/src/game/teams.ts';
import type { Participant } from './sim.ts';
import type { Room } from './room.ts';
// WORKSTREAM AA: the per-section profiler, whose breakdown rides the ten-second
// line below. See `server/profile.ts` for why the ten `phaseMs` buckets it
// replaces were not enough to catch a tenfold regression.
import { topSections, verifyProfile } from './profile.ts';
import {
  HEARTBEAT_MS,
  // WORKSTREAM AD: the rate this host resolved `SYDNEY_SNAPSHOT_HZ` to, which
  // is what the boot line and `/health` must quote rather than the protocol
  // default -- a host saying 20 while sending 15 is worse than either.
  HOST_SNAPSHOT_HZ,
  RoomHost,
  heartbeat,
  newConn,
  receiveInput,
  receivePong,
  type Conn,
  type Socket,
} from './room.ts';
import { loadWorld } from './world.ts';
// Published on `/health` so the client's `?vessels=1` cannot disagree with it.
// See the field's comment there for the failure that made this necessary.
import { vesselsEnabled } from '../client/src/world/vessel.ts';
// And published beside it for the same reason: v11 made this process the one
// owner of the time of day, and a fact with one owner should be readable from
// outside without opening a socket. `cycle.ts` is pure arithmetic over `solar`
// and `lunar` and drags no renderer in with it, which is why the server can
// import it at all.
import { cyclePhase } from '../client/src/sky/cycle.ts';

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
    // And the one interaction between the two weapons, which fails in this
    // project's shape exactly: **every broken version of it renders a perfectly
    // good frame.** A timing window that is not the ACTIVE phase makes the
    // mechanic untimed and there is nothing on screen that says the window is
    // wrong; an owner that does not change hands makes a returned ball pass
    // through the person who threw it, which looks like a miss; and a deflection
    // that adds speed rather than steering it clips `protocol.BALL_BYTES`' i8 on
    // the fourth exchange of a rally and points the tumble sideways. This
    // process is the one that decides all three online. See `game/swat.ts`.
    ['verifySwat', verifySwat()],
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
    // Walking between the carriages of a Metropolis, which this process is the
    // authority for: `sim.exitCarriage` runs `riding.rideExit` on every rider on
    // every tick and the browser predicts the identical crossing. Run **here** as
    // well as in the browser because every failure in it is silent in this repo's
    // sense -- a gangway that stays shut looks like a feature nobody built, and a
    // sign wrong in the reframe puts a passenger 22 m from where the other end
    // has them, at 130 km/h, on somebody else's screen only. It cannot be folded
    // into `verifyRiding`, which needs the controller's eye height and body
    // radius and has no caller here that holds either. See `game/riding.ts`.
    ['verifyGangway', verifyGangway()],
    ['verifyStationAccess', verifyStationAccess()],
    // The button in Sydney Park and the sun it screams at. Run **here** rather
    // than only in the browser because this process is the one that keeps the
    // two instants: every failure in that file is silent in this repo's sense --
    // the button is pressed, the face goes up, and it goes away at the wrong
    // hour or comes back on the wrong day, three real hours after anybody was
    // looking. See `client/src/game/sunbutton.ts`.
    ['verifySunButton', verifySunButton()],
    ['verifyHeat', verifyHeat()],
    // Talents into numbers, and the four ability buttons. Every failure in these
    // two is silent in this repo's sense: a swing multiplier that composed wrong
    // is a fight that feels slightly off, a take radius that did not move is a
    // talent the player paid a point for and cannot tell is missing, and a
    // once-per-day stamp that compares timestamps instead of day indices comes
    // back at a different hour on every host. See `game/teamfx.ts`.
    ['verifyTeamFx', [...verifyTeamFx(), ...verifyAbilities(), ...verifyTalentLive()]],
    ['verifyPolair', verifyPolair()],
    // --- WORKSTREAM V. `verifyTeams` is the contract's own and is here for a
    // reason the rest of this list does not have: it is a **spelling** check.
    // The owner's instruction was *"always follow the capitalisation Marita and
    // DeFAULT -- in absolutely any case"*, and a name typed wrongly in a node's
    // effect text renders perfectly and is seen by every player. It also asserts
    // the shape of the trees, which is the thing the whole ten-point economy
    // rests on: a tier gate that opened one point early is a mega on a
    // half-tree, and nothing anywhere reports it.
    ['verifyTeams', verifyTeams()],
    // The aura fold, which is this side's authority: every number it produces is
    // adjudicated here and predicted in the browser off the same class, so a
    // disagreement is a swing that lands in one runtime and not the other. See
    // `game/teamfield.ts`, which cross-checks its own fold against the
    // contract's `ownScalar` over randomised masks.
    ['verifyTeamField', verifyTeamField()],
    // And the bytes. A talent mask is a `u32` pair and `1 << 31` is negative in
    // JavaScript: an encoder that forgot `>>> 0` hands a player back a build
    // with one node missing, which reads as the game taking a talent away.
    ['verifyTeamsWire', verifyTeamsWire()],
    // Taking a car and driving it. Run **here** as well as in the browser
    // because the integrator, the claim and the suppression key are all this
    // side's authority and every failure in that file renders: a handbrake that
    // walks the car backwards looks like a physics quirk, and a suppression key
    // that does not answer is your own car driving off to Ashfield beside you,
    // running people down on the way. See `client/src/game/driving.ts`.
    ['verifyDriving', verifyDriving()],
    ['verifyCarFire', verifyCarFire()],
    // And the fleet it can now steal from. See `game/staticcars.ts`: a decoder
    // that drifted from the pipeline's 16-byte stride puts every car in Sydney at
    // a plausible-looking wrong position, which renders perfectly and makes `E`
    // do nothing.
    ['verifyStaticCars', verifyStaticCars()],
    // And what the browser does with a car once somebody is in it. See the
    // import: three-free, so this end runs it too, and the property that matters
    // is that a driven car is drawn where its *driver* is rather than where its
    // record was parked -- which this process is the authority on, since it is
    // this process that decides never to re-broadcast the record.
    ['verifyDrivenCars', verifyDrivenCars()],
    // The first-person punch's pose curve. Run **here** as well as in the
    // browser because it is three-free and because it is timed off the same
    // `animation.PUNCH_*` envelope this process adjudicates a swing with: a
    // curve that stopped lining up with the phase machine is a fist that
    // arrives after the hit test did, which reads as lag rather than as a
    // timing bug. See `client/src/game/hands-pose.ts`.
    ['verifyHandsPose', verifyHandsPose()],
    // --- WORKSTREAM O: the shared viewmodel breath, which the browser runs inside
    // `verifyBat` and `verifyFootyBall` (both of which import three and cannot run
    // in this process). It is here for the reason every other shared arithmetic
    // check is: **it is a number two files agree about**, and the way this repo
    // keeps two files agreeing is to check them in both runtimes. The failure it
    // catches is silent and was live -- the bat breathed on 0.71/0.94 Hz and the
    // football on 0.67/0.91, which are close enough to beat against each other over
    // half a minute with both objects on screen. See
    // `client/src/player/viewmodel-idle.ts`.
    ['verifyViewmodelIdle', verifyViewmodelIdle()],
    // The level line and the XP bar. Run **here** because this process is the
    // one that owns the ladder -- it counts the kills, it decides the level,
    // and it puts both on the roster -- so an off-by-one between
    // `accounts.levelFor` and the fraction drawn under it is this side's fault
    // and is silent: the bar simply reads 10/10 on somebody who just levelled.
    // See `client/src/game/levelhud.ts`.
    ['verifyLevelHud', verifyLevelHud()],
    // --- WORKSTREAM X: how a team looks, as arithmetic.
    //
    // Run **here** as well as in the browser on this list's own premise -- a
    // shared module has to behave identically in both runtimes -- and because
    // the numbers it guards are the kind this process is the natural home for:
    // they are pure functions of the contract in `game/teams.ts`, which this
    // process also owns the persistence of. Every failure in it renders. A tint
    // that flattened a colourway into one tone is a player who cannot be told
    // from the wall behind them; a slam ring that stopped short of eight metres
    // is a shockwave lying about a knockdown this process already adjudicated.
    // See `client/src/game/teamlook.ts`.
    ['verifyTeamLook', verifyTeamLook()],
    // WORKSTREAM AJ: the rule that decides when the browser's loading screen
    // comes off, and the ring it waits for. Run **here** on this list's own
    // premise -- it is three-free and it is arithmetic, so it has to behave
    // identically in both runtimes -- and because the failure it guards is one
    // this process would never otherwise hear about: a client that reveals onto
    // ground it has not got joins, plays and reports nothing wrong. See
    // `client/src/world/ground-first.ts`.
    ['verifyGroundFirst', verifyGroundFirst()],
    // The bushland round's ground-cover table: the byte `far-cover.bin` packs a
    // class and a coverage fraction into, and the seven colours the horizon
    // wears. Here as well as in the browser on this list's own premise -- it is
    // three-free and it is a bit shift -- and because the two failures it
    // catches are both silent. A packing that stops round-tripping paints every
    // national park in the world as a golf course, and a cover tint lighter
    // than `ground.ts`'s own soil makes the hills *pale* rather than green,
    // which is a taste failure that renders a perfectly good frame. See
    // `client/src/world/cover.ts`.
    ['verifyCanopy', verifyCanopy()],
    // The bushland round's *other* half, added 2026-08-24 with the per-stem
    // variation. Every bushland stem gets a yaw, a lean, a plan aspect, a crown
    // archetype and a colour hashed out of its seed and its position, and the
    // dangerous failure in that is not that it looks wrong -- it is that a bound
    // slips and the lean reaches ninety degrees, which is a forest of fallen
    // trees that no table anywhere would have shown. Three-free on purpose so
    // it can be asserted here, where it costs nothing and runs every boot. Its
    // sibling `verifyVegetationCost` needs `three` to build a geometry and can
    // only run in the browser. See `client/src/world/tile-decode.ts`.
    ['verifyStemVariety', verifyStemVariety()],
    // What a knocked-over NPC is worth, how fast a player may be paid it, and
    // what the note looks like. Run **here** first and foremost because this
    // process *is* the mint: the drop table and the rate bank are enforced in
    // `Simulation.dropNpcCash` and nowhere else, and a bank that does not bank
    // has no picture at all -- the money simply arrives and whoever is testing
    // is delighted. See `client/src/game/cashnote.ts`.
    ['verifyCashDrops', verifyCashDrops()],
    // The crash damage's *visual* grading -- how far a car is folded, how dark
    // the paint goes, how fast the plume runs, whether a headlight is out. Run
    // here as well as in the browser because it is three-free and because the
    // four renderers that consume it must agree with the bands this process is
    // authoritative for. See `game/driving.damageGrade`.
    ['verifyDamageGrade', verifyDamageGrade()],
    // The ambient fleet, in the process that decides whether one of them ran
    // you over. Run here as well as in the browser -- `main.ts` has always run
    // it and this side never did, which is a gap: `sim.ts` evaluates `poseCar`
    // and `carHitting` at the same tick the browser does and the whole
    // zero-bandwidth argument is that the two agree, so the check belongs in
    // both runtimes or the claim is only half tested.
    //
    // Its v3 sections are the ones that would fail here first: a bay's occupant
    // is a `Math.ceil` of a division and a car's residency in it is measured in
    // minutes, and a JavaScriptCore that rounded either differently from V8
    // would park a car where the browser drew empty gutter. The body-table
    // argument is omitted because `world/cars.ts` imports three and can never
    // be loaded in this process -- see `verifyTraffic`'s own signature.
    ['verifyTraffic', verifyTraffic()],
    // The (dis)appearance latch. Nothing in this process draws a car, and the
    // reason it is here is that nothing in this process draws a car: the latch is
    // a four-state machine over a bounded table, its failures are a car hidden
    // forever or a ghost that never retires, and a state machine is exactly the
    // thing a headless check can prove.
    ['verifyViewLatch', verifyViewLatch()],
    // The suggestions box's week arithmetic, sanitiser, order and codecs.
    // Run **here** rather than only in the browser because the server is the
    // side that keeps the ledger, and every failure in that file is silent in
    // this repo's sense: the panel opens, the votes are accepted, and the count
    // is quietly against the wrong week -- which nobody reports, because nobody
    // was counting. See `client/src/net/suggestions.ts`.
    ['verifySuggestions', verifySuggestions()],
    // The bug box, which is the only public endpoint in this process that
    // **writes bytes into a public repository** -- so its failures are not
    // merely silent, they are permanent. A sniffer that trusts a content type
    // commits something that is not a picture; a rebuild that forwards the file
    // through leaves a phone photograph's EXIF GPS in a public repo; a size cap
    // enforced after buffering is not a cap and passes every test that sends a
    // small body. None of them throws and none of them can be un-done. See
    // `server/bugs.ts`, which is written against exactly that list.
    ['verifyBugs', verifyBugs()],
    ['verifyRewind', verifyRewind()],
    // PERFORMANCE.md phase 1's grid, which every hit test in the game now
    // takes its candidates from. A grid that is not a superset is a punch that
    // passes through somebody, and there is no frame in which that looks like
    // an index bug rather than a hit test one.
    ['verifySpatialHash', verifySpatialHash()],
    // Every track believes it owns the whole corridor, and this is the file that
    // ends that. Four synthetic railways with known answers, one of them a
    // crossing that must not read as a neighbour. See `RAIL-CORRIDOR.md`.
    ['verifyTrackAtlas', verifyTrackAtlas()],
    // The hand-authored layouts. Without the bake's names here -- this list runs
    // before the world loads -- so it checks the table's internal properties and
    // `main.ts` checks the keys against the real stations.
    ['verifyStationLayouts', verifyStationLayouts()],
    // The swept platform, by its pure parts. This process stands bodies on the
    // same sweep through `riding.PlatformField`, so it has to agree about where
    // the deck is down to the bit.
    ['verifyPlatformSpine', verifyPlatformSpine()],
    // WORKSTREAM AQ: the radius this process holds the railway's *walls* to, and
    // the key it files them under. This list only, and not the browser's --
    // `server/rail-lateral.ts` is a residency, and only a process with
    // participants in it has one. The failure it guards is the reason the file
    // exists said backwards: a server whose rail solids reach less far than the
    // browser's is one that walks a player through a trench wall they can see,
    // and neither end logs a word about it.
    ['verifyRailLateral', verifyRailLateral()],
    // And phase 2's selection on top of it. A working set that is missing
    // somebody nearby is a player invisible while punching you; see
    // `server/aoi.ts`, which asserts the rule against a brute-force scan.
    ['verifyAoi', verifyAoi()],
    // WORKSTREAM AD: and the snapshot rate, which is a knob now
    // (`SYDNEY_SNAPSHOT_HZ`) rather than a constant. What this asserts is the
    // arithmetic underneath -- that every rate it will accept divides the tick
    // and fits inside the client's 100 ms interpolation buffer -- because a
    // rate that does neither produces a game that runs and stutters.
    ['verifySnapshotRate', verifySnapshotRate()],
    ['verifyProfile', verifyProfile()],
    ['verifySim', verifySim()],
    // --- Workstream E's three, and every one of them is here rather than only
    // in the browser because every one of them fails *silently and identically*
    // in both runtimes.
    //
    // `verifyCharacters` covers the thing this process is uniquely placed to
    // catch: the traffic epoch and the sky's epoch drifting apart. This is the
    // authority for both clocks, so if they disagree here then every eshay in
    // the city is standing at a station at two in the afternoon and the only
    // symptom is the sun. It also walks the bias table for a character who
    // exists everywhere, and samples the rounding margin on the cell
    // populations -- the one determinism failure this feature can have, where
    // two engines place a different *number* of people in a cell and the client
    // draws somebody the server does not have.
    //
    // `verifyEvents` covers a schedule that is not a pure function of the day,
    // which presents as a player describing a car crash nobody else can find,
    // and a trackwork sign in the middle of a paddock.
    //
    // `verifyWallet` covers the no-op default. A `NO_WALLET.debit` that reported
    // taking the amount it was asked for would put a lie in the kill feed --
    // "they went through your pockets" for money that never moved -- in a build
    // that has no money in it at all. It is three lines of arithmetic and it is
    // the contract the branch that owns the money inherits.
    //
    // WORKSTREAM AC: `verifyStreetlife` joins them, and it should have been here
    // all along -- it has run in `main.ts`'s boot list since the loiterers
    // shipped and only ever ran on this side inside `integration-check`, which
    // takes 45 minutes and is therefore not a boot gate. What it now covers is
    // squarely the authority's: the two ambient sweeps read a precomputed anchor
    // cover instead of walking 837 suburbs and 875 venues per player, and an
    // anchor missing from that cover is a meth head who exists on the client and
    // not on the server -- one you can walk through, in one corner of the city,
    // silently.
    ['verifyCharacters', verifyCharacters()],
    ['verifyStreetlife', verifyStreetlife()],
    // WORKSTREAM AP: and the police, for `verifyStreetlife`'s reason exactly and
    // one sharper than it. This process is where a police round is decided --
    // `Simulation.shoot` is reachable by no message a client can send -- and the
    // check now covers a **deterministic dice roll**: the owner's one-in-ten,
    // hashed from (officer, target, tick, shot). A `Math.random` in that path
    // renders identically on both ends and desynchronises the browser's
    // prediction of a pursuit from this process's authority for as long as the
    // pursuit lasts. Only this side booting the check makes that a gate.
    ['verifyPolice', verifyPolice()],
    ['verifyEvents', verifyEvents()],
    ['verifyWallet', verifyWallet()],
    // The money. Four checks rather than one, because they are four different
    // kinds of failure and a merged list would say "cash" about all of them:
    // the rules (a fare that pays the wrong amount), the wire (a bundle list
    // that desynchronises), the file (a key that does not fold case, so a
    // player's balance resets), and the fare's state machine (a stop clock that
    // boards a passenger from a car that never stopped). Every one of them is
    // silent in this repo's sense -- it renders, it pays, and the number is
    // wrong. See each file's own check for the enumeration.
    ['verifyCash', verifyCash()],
    ['verifyCashWire', verifyCashWire()],
    ['verifyWallets', verifyWallets()],
    ['verifyFares', verifyFares()],
    ['verifyDrivingContract', verifyDrivingContract()],
    // Every failure in this one is silent in this list's sense and none of them
    // is visible anywhere: a pitch curve that is not monotonic is a car that
    // drops a gear as it accelerates, a Doppler clamp that does not hold turns a
    // head-on pass into a slide whistle, and a voice pool that hands a chain over
    // without taking the gain to zero first is a click nobody can reproduce. It
    // runs *here* as well as in the browser on `PREAMBLE`'s rule, and it can,
    // because there is no audio in the file -- only the arithmetic that decides
    // what the audio should be.
    ['verifyCarSound', verifyCarSound()],
    // The city bed, on the same terms. Every failure in it is silent even by the
    // standards of this list -- a bed is by construction the sound nobody
    // notices, so a swell that steps, a loop that clicks once every four seconds
    // or a buffer that came out white are all "the audio feels off" with no
    // repro. It runs here because it *can*: there is no audio in the file, only
    // the sample data and the arithmetic that decides what the graph does.
    ['verifyCityBed', verifyCityBed()],
    // The phone's model. Run **here** despite the server having no opinion
    // about which hand a bat is in, because the interesting half of that file
    // is the photo album and every one of its failures is silent: an album that
    // does not cap fills the origin's quota and the camera stops working after
    // twenty shots; a quota fallback that drops the newest deletes the
    // photograph the player just took; a caption on the real clock stamps the
    // wrong time of day on a picture whose whole content is the time of day.
    // This process is a second runtime with no browser in it, which is exactly
    // what the album's injected storage exists to be checkable in. See
    // `client/src/game/phone.ts`.
    ['verifyPhoneModel', verifyPhoneModel()],
    // The accounts, the handles and the ladder. Run **here** as well as in the
    // browser because this process is the authority for every one of them and
    // every failure in that file is silent in this repo's sense: a handle fold
    // that lets two accounts render identically is an impersonation nobody
    // reports, a level formula off by one puts the wrong number over every body
    // in the city, a week that is not the suggestions box's week resets the
    // ladder on the wrong day, and a token expiry that is not enforced makes
    // every session on the box permanent. See `client/src/net/accounts.ts`.
    ['verifyAccounts', verifyAccounts()],
    // --- WORKSTREAM AK: the content system, in three checks for three kinds of
    // failure, and every one of them is silent in this repo's sense.
    //
    // `verifyQuests` is the **parser and the ceilings**, and it is the one that
    // matters most: this process applies JSON that a person edits on github.com
    // with no compiler in the way, so a parser that accepts a bad pack is the
    // whole safety property gone -- the pack goes live, half its quests are
    // missing, and the obligations app is simply one item shorter than the
    // author expected. The reward ceiling is the other half of it: `"cash":
    // 50000` is four keystrokes from `"cash": 50`, it validates as a number,
    // and by the time anybody notices the economy every wallet on the box is
    // wrong with no un-doing it.
    //
    // `verifyDialog` carries the one rule here that is not merely cosmetic: an
    // improv node may not accept a quest, turn one in, or spend money. Break
    // that and there is a language model with a hand on the wallet, and no
    // frame anywhere looks wrong.
    //
    // `verifyQuestWire` is the bytes, in the process that adjudicates them. A
    // `NODE` op decoded one byte out resolves a *different node of the same
    // NPC* -- a real node, with real choices, which this side then acts on --
    // so the player clicks "take the job" and is told about the weather.
    ['verifyMushrooms', verifyMushrooms()],
    ['verifyTrips', verifyTrips()],
    ['verifyTripView', verifyTripView()],
    ['verifyGod', verifyGod()],
    ['verifyMandala', verifyMandala()],
    ['verifyQuestAim', verifyQuestAim()],
    ['verifyQuestAreas', verifyQuestAreas()],
    ['verifyBuildBudget', verifyBuildBudget()],
    ['verifyInterpDelay', verifyInterpDelay()],
    ['verifyQuests', verifyQuests()],
    ['verifyDialog', verifyDialog()],
    ['verifyQuestWire', verifyQuestWire()],
    // --- WORKSTREAM AO: the givers' bodies, or the pure half of them.
    //
    // This process draws nothing and never will, and the check runs here
    // anyway, on `verifySpawn`'s reasoning one block down: the rules are a pure
    // function of content **this** process serves, and every one of them fails
    // silently. A kit derived from something other than the id is a giver who
    // is a different person on every client; a facing sign inverted is a
    // hundred people standing with their backs to the street; a mark height
    // that stops agreeing with the ground fallback is every exclamation mark in
    // Sydney stepping half a metre on the beat a body appears under it. None of
    // those throws, and the browser is the only place that would have looked.
    ['verifyGiverBodies', verifyGiverBodies()],
    /*
     * --- WORKSTREAM AP: the waypoint, whose arrow this process never draws.
     *
     * Here for the same reason `verifyGiverBodies` is, and one more that is
     * specific to it: **this process owns the cursors the arrow reads.** The
     * whole safety property of the feature is that a waypoint comes off a
     * cursor rather than off an offer -- so it can never point at a step the
     * register would refuse -- and the cursors are `AccountRecord.quests`,
     * which is this file's. A `game/waypoint.activeWaypoint` that started
     * reading the bundle instead would be a client pointing at jobs the server
     * will not give it, and the server should refuse to start over it.
     *
     * The bearing maths is the other half: a sign error is a needle pointing at
     * the opposite side of Sydney, which looks exactly like a needle.
     */
    ['verifyWaypoint', verifyWaypoint()],
    /*
     * --- The same register, seen from the map, and this process owns the facts
     * it reads.
     *
     * `game/givermap.ts` decides which givers get a yellow `!` on the compass
     * and the big map, and it decides it by asking `questmodel.markerFor` with
     * the player's level, faction and story flags -- which are
     * `AccountRecord`'s, which are this file's. So the failure it guards is the
     * client advertising a job **this** process would refuse: a mark on the map,
     * a walk across Redfern, and a conversation with every button greyed out.
     * That is exactly the shape of bug the register's one-rule-three-readers
     * arrangement exists to prevent, and the process that would say no is the
     * right one to refuse to start over it.
     *
     * The rim clamp is the other half and is checked here for `verifyWaypoint`'s
     * reason one block up: a marker pushed onto the disc's edge five degrees off
     * its true bearing looks precisely like one that is right, and the only way
     * to find it by eye is to walk down the wrong street.
     */
    ['verifyGiverMap', verifyGiverMap()],
    ['verifyQuestHubs', verifyQuestHubs()],
    ['verifyQuestTrack', verifyQuestTrack()],
    ['verifyQuestLog', verifyQuestLog()],
    ['verifyFrameStep', verifyFrameStep()],
    ['verifyStallRing', verifyStallRing()],
    ['verifyTilePriority', verifyTilePriority()],
    ['verifyBoundaryLog', verifyBoundaryLog()],
    // WORKSTREAM N (carry): the sentence a restored session is visible as. Run
    // here as well as in the browser for `verifyLevelHud`'s reason one line up
    // -- this process decides *whether* a join was a restore and puts the bit on
    // the welcome, so a client that composed the sentence wrongly and a server
    // that set the bit wrongly are the same feature failing, and both ends
    // should refuse to start over it. See `client/src/game/carry.ts`.
    ['verifyCarry', verifyCarry()],
    // And the spawn rules, which this process has always *run* and never
    // checked -- `main.ts` has had `verifySpawn` in its boot list since the
    // feature landed and this side never did, which is backwards: the server
    // draws every join's spot (`Simulation.joinSpot`) and, since workstream N,
    // decides whether a remembered one is still standable
    // (`game/spawn.restoreSpawnPoint`). A validator that accepted a spot with a
    // building on it would put a returning player inside a warehouse, and the
    // only process that would have noticed is the one that was not looking.
    ['verifySpawn', verifySpawn()],
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
    `[sydney] collision per hexagon: ${s.collision.resident}/${s.hexes} resident, ` +
      `${(s.collision.bytes / 1e6).toFixed(0)} MB estimated against a ` +
      `${(s.collision.capBytes / 1e6).toFixed(0)} MB cap (SYDNEY_COLLISION_CAP_MB), ` +
      `${s.collision.tiles} tiles`,
  );
  console.log(
    `[sydney] lanes per hexagon: ${s.lanes.resident}/${s.hexes} resident, ` +
      `${(s.lanes.bytes / 1e6).toFixed(0)} MB estimated against a ` +
      `${(s.lanes.capBytes / 1e6).toFixed(0)} MB cap (SYDNEY_LANES_CAP_MB), ` +
      `${s.lanes.tiles} tiles, ${s.lanes.items.toLocaleString()} routes ` +
      `(${s.lanes.marginM} m margin against collision's ${s.collision.marginM} m)`,
  );
  // --- WORKSTREAM S. The car count is the number to read: it is how many of the
  // cars a player can walk up to this process can actually let them steal, and
  // **zero is a meaningful and silent failure mode** -- `.cars.bin` is a per-tile
  // sidecar that DEPLOY.md's rsync did not ship until this round, and a box
  // without it boots clean, plays fine and refuses every parked car. See the
  // third layer's `apply` in `server/world.ts` on why a missing file is not an
  // error, and DEPLOY.md §A step 2 for the include line that fixes it.
  console.log(
    `[sydney] parked cars per hexagon: ${s.staticCars.resident}/${s.hexes} resident, ` +
      `${(s.staticCars.bytes / 1e6).toFixed(1)} MB estimated against a ` +
      `${(s.staticCars.capBytes / 1e6).toFixed(0)} MB cap (SYDNEY_STATIC_CARS_CAP_MB), ` +
      `${s.staticCars.tiles} tiles, ${s.staticCars.items.toLocaleString()} cars` +
      (s.staticCars.items === 0
        ? ' — NONE. No parked car is takeable; the box is missing tiles/*.cars.bin (DEPLOY.md §A step 2).'
        : ''),
  );
}

/**
 * The wallets, host-wide, loaded before anybody can join.
 *
 * Host-wide rather than per-room on `suggestions`' argument and one stronger:
 * the key is a **name**, and two rooms with two files would be two balances for
 * one person depending on which room they landed in -- which is the gateway
 * deciding how much money you have. Constructed and `load`ed before the socket
 * opens, so the first joiner's first `WALLET` frame is their real balance
 * rather than a starting one that is corrected a moment later.
 *
 * `SYDNEY_STATE_DIR` moves the file; see `defaultWalletPath`.
 */
const wallets = new WalletStore(defaultWalletPath());
await wallets.load();
console.log(`[sydney] wallets: ${wallets.describe()}`);

/**
 * The accounts, host-wide, loaded before anybody can join.
 *
 * Host-wide for `wallets`' reason and one stronger: a handle is **globally
 * unique**, and two rooms with two files would be two people wearing one handle
 * depending on where the gateway put them -- which is the exact thing an account
 * exists to make impossible. Constructed and `load`ed before the socket opens,
 * so the first `HELLO` carrying a token can be resolved rather than being
 * treated as a guest for the first second of a session.
 *
 * `SYDNEY_STATE_DIR` moves the file, beside `wallets.json`; see
 * `defaultAccountPath`.
 */
const accounts = new AccountStore(defaultAccountPath());
await accounts.load();
const authGuards = new AuthGuards();
console.log(`[sydney] accounts: ${accounts.describe()}`);

/**
 * Who is driving what, for SydRide. See `client/src/game/driving-contract.ts`.
 *
 * `NO_DRIVING` unless `SYDNEY_FAKE_DRIVING=1`, because the driving workstream's
 * `game/driving.ts` does not exist yet -- this branch was written against the
 * interface rather than against the module, so that the day it lands the lead
 * changes this one expression and nothing else.
 *
 * The hatch treats anybody moving faster than 6 m/s as a driver, which is under
 * a sprint on purpose: it is the only way to exercise the fare loop end to end
 * on a branch with no cars in it. Announced in the boot line, because a server
 * where sprinting makes you a taxi should say so out loud.
 *
 * `poseOf` reads the **live** body out of whichever room the id is in. A player
 * id is a room's rather than a host's (see `protocol.AOI_ID_LIFECYCLE`), so two
 * rooms both have a player 7 -- and the lookup handed to a room must therefore
 * be that room's. `RoomHost` builds one per room from this factory rather than
 * sharing this object, which is the whole reason it is a factory.
 */
const FAKE_DRIVING = process.env.SYDNEY_FAKE_DRIVING === '1';

/**
 * The rooms, sharing that one city read-only.
 *
 * `roomWorld` is what makes "read-only" true rather than hoped: it hands every
 * room the same collision, terrain, water, lanes and footpaths, and gives each
 * its own `PowerupField` -- the one thing in a loaded world that a tick mutates.
 * See its header for the audit of everything else.
 */
const tRooms = performance.now();
const host = new RoomHost(world, ROOM_COUNT, ROOM_CAP, BOT_COUNT, ROOM_BASE, {
  wallets,
  accounts,
  fakeDriving: FAKE_DRIVING,
});
if (FAKE_DRIVING) {
  console.log('[sydney] SYDNEY_FAKE_DRIVING=1: anybody over 6 m/s counts as driving (SydRide debug hatch)');
}
console.log(
  `[sydney] ${ROOM_COUNT} room(s) ${ROOM_BASE}..${ROOM_BASE + ROOM_COUNT - 1}, cap ${ROOM_CAP} each ` +
    `(${ROOM_COUNT * ROOM_CAP} players this process), ${BOT_COUNT} bot(s) per room — ` +
    `${(performance.now() - tRooms).toFixed(0)} ms`,
);

/*
 * --- WORKSTREAM N (carry): how the HTTP routes find a body.
 *
 * `/auth/signup` has to carry a guest's level and location onto the new account,
 * and `/auth/logout` has to save the spot of whoever is logging out. Both are
 * HTTP requests arriving beside a socket that is already open, and both
 * therefore need to reach a live `Participant` from a route -- which
 * `server/accounts.ts` deliberately cannot do: it is an HTTP file with no world
 * in it, and an `AccountStore` that imported the simulation could not be
 * constructed without one (see `LiveLookup`'s header for the whole argument).
 *
 * So the lookup lives here, where both halves are already in scope, and the two
 * questions are the only two that file asks:
 *
 *   - `guest(room, playerId)` is the sign-up carry. It refuses a bot and refuses
 *     anybody who is **already logged in**, because "carry my guest progress" is
 *     not a thing an account can ask for and letting it would be a way to move
 *     one account's position onto another.
 *   - `ofAccount(id)` is the logout save. O(players) over the host rather than
 *     an index, because it is called on a route a person hits once and the
 *     alternative is a second map to keep in step on every join and leave -- see
 *     `AccountStore.tokenIndex`, which is an index for the opposite reason: that
 *     one is on the join path.
 */
const liveBodies: LiveLookup = {
  guest(room: number, playerId: number) {
    const found = host.get(room);
    if (!found) return null;
    const p = found.sim.participants.get(playerId);
    if (!p || p.bot !== null || p.account !== null) return null;
    return found.sim.carryOf(p);
  },
  ofAccount(accountId: string) {
    for (const r of host.rooms) {
      for (const p of r.sim.participants.values()) {
        if (p.accountId === accountId) return r.sim.carryOf(p);
      }
    }
    return null;
  },
};

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

/**
 * The bug box, which shares the suggestions box's credential and nothing else.
 *
 * Host-wide for `suggestions`' reason -- a bug is about the game, not about the
 * twelve people in room 3 -- and constructed here so it holds the same token
 * read once from the environment. It is a **separate store** rather than a
 * second method on `SuggestionStore` because the two have nothing in common
 * underneath: a suggestion is a row in a ledger with votes against it, and a
 * bug report is a file committed into a repository and never looked at again.
 *
 * `BugGuards` is deliberately *not* inside the store. It is per-request state
 * belonging to the route, on the same seam `SuggestionHub` sits on relative to
 * `SuggestionStore`, and keeping it out here is what lets the store be driven
 * by a check with no rate limiting in the way.
 */
const bugs = new BugStore({ dir: defaultBugDir(), repo: githubRepo(), token: githubToken() });
const bugGuards = new BugGuards();
console.log(`[sydney] bugs: ${bugs.describe()}`);
// Anything queued by a previous run with no token posts now, oldest first.
void bugs.drain();

// --- Connections --------------------------------------------------------------

const conns = new Set<Socket>();

/*
 * --- WORKSTREAM AK: quests and dialog, as content rather than as code.
 *
 * Three objects and one rule. `ContentStore` holds the packs -- read from the
 * repo's `content/` at boot, polled from GitHub every five minutes after that,
 * and refused whole if a fetch does not validate. `ImprovCache` is the AI seam
 * and is off unless `SYDNEY_DIALOG_AI_URL`/`_KEY` are set. `QuestEngine` is the
 * per-player cursors and the adjudication.
 *
 * **Host-wide, like the suggestions box and for its reason**: a quest is about
 * the game rather than about the twelve people in room 3, and two rooms with
 * two engines would be a player whose Act 0 progress depended on where they
 * spawned. The engine is then installed as the sink into every room's
 * simulation, which is the same shape `AccountStore` already has.
 *
 * `load()` **returns** its errors rather than throwing, so the bundled packs
 * join the self-check list below and the process refuses to start on a bad one
 * -- they are part of the build. A pack fetched at *runtime* can never do that:
 * it is refused and the last good one keeps serving, because a bad commit must
 * not be able to take the game down. See `server/quests.ts`' header.
 */
const content = new ContentStore();
{
  const errors = await content.load();
  if (errors.length > 0) {
    console.error('Bundled quest content failed validation; refusing to start.\n');
    for (const line of errors) console.error(`  ${line}`);
    process.exit(1);
  }
}
const improv = new ImprovCache();
console.log(`[sydney] quests: ${content.describe()}; ${improv.describe()}`);
// The model catalogue, once, not awaited and never fatal. A provider renaming
// an id must cost a log line rather than a mute NPC three weeks later.
void improv.probe().then((warning) => {
  if (warning !== '') console.warn(warning);
});

/**
 * The engine's window onto the simulation. Structural; see `QuestWorld`.
 *
 * `liveBodies` above is the same shape of thing for the same reason: this file
 * is where the host, the rooms and the stores are all in scope, so it is where
 * a feature that needs two of them gets wired together rather than growing an
 * import into a third.
 *
 * `find` is O(rooms x players) and is called on the ops path -- a click in a
 * dialog panel, a few times a session -- rather than on a tick. The tick path
 * (`eachPlayer`) hands the id and the room's own simulation over together, so
 * the sweep never pays for the search.
 */
function findPlayer(playerId: number): { room: Room; p: Participant } | null {
  for (const r of host.rooms) {
    const p = r.sim.participants.get(playerId);
    if (p) return { room: r, p };
  }
  return null;
}

const questWorld: QuestWorld = {
  eachPlayer(fn) {
    for (const r of host.rooms) {
      for (const p of r.sim.participants.values()) {
        if (p.bot === null) fn(p.id);
      }
    }
  },
  positionOf(playerId) {
    const found = findPlayer(playerId);
    if (!found) return null;
    const body = found.p.combat.body.position;
    return { x: body.x, z: body.z };
  },
  accountOf: (playerId) => findPlayer(playerId)?.p.account ?? null,
  isBot: (playerId) => (findPlayer(playerId)?.p.bot ?? null) !== null,
  levelOf: (playerId) => findPlayer(playerId)?.p.level ?? 1,
  teamOf: (playerId) => findPlayer(playerId)?.p.team ?? TEAM.NONE,
  cashOf: (playerId) => findPlayer(playerId)?.room.sim.wallet.balanceOf(playerId) ?? 0,
  credit(playerId, amount, why) {
    findPlayer(playerId)?.room.sim.wallet.credit(playerId, amount, why);
  },
  debit: (playerId, amount, why) => findPlayer(playerId)?.room.sim.wallet.debit(playerId, amount, why) ?? 0,
  note(playerId, text) {
    findPlayer(playerId)?.room.sim.note(playerId, text);
  },
  /**
   * WORKSTREAM AN. The body follows the record when quest xp levels somebody.
   *
   * `Simulation.creditLadder` does exactly this on a knockout and cannot be
   * reached from here -- it is private and it is about kills. The two lines are
   * its two lines: the participant's mirror of the level, which is what
   * `levelOf` above answers with and therefore what the whole register is gated
   * on, and the roster version, because the number over this player's head is
   * carried by the roster and would otherwise stay wrong until the next
   * two-second refresh.
   */
  levelled(playerId, level) {
    const found = findPlayer(playerId);
    if (!found) return;
    found.p.level = level;
    found.room.sim.rosterVersion++;
  },
  rideStation: (playerId) => findPlayer(playerId)?.room.sim.rideStation(playerId) ?? null,
  /**
   * WORKSTREAM AP. The Ladmaster's lime bike, into the room the player is in.
   *
   * One line, and it is one line because every decision is somewhere else:
   * `game/bikes.placeLoanBike` chooses the spot, `Simulation.loanBike` asks this
   * room's own prisms and terrain and queues the record for the next
   * `Room.sendBikes`, and `QuestEngine.accept` decides whether a quest asked for
   * one at all. This is the lookup, which is the only thing the host knows that
   * neither of the other two does.
   */
  loanBike: (playerId, seed) => findPlayer(playerId)?.room.sim.loanBike(playerId, seed) ?? null,
  /**
   * Put a frame on one player's socket.
   *
   * A walk of the host's connection set rather than a map, and rather than a
   * new method on `Room`. `LiveLookup.ofAccount` above makes the identical
   * call for the identical reason: this is on a path a person triggers a
   * handful of times a session, and the alternative is a second index to keep
   * in step on every join and every leave -- which is a standing correctness
   * cost paid to make a rare operation cheap.
   */
  send(playerId, frame) {
    for (const ws of conns) {
      if (ws.data.participant?.id !== playerId) continue;
      try {
        ws.send(frame);
      } catch {
        // Closed between the decision and the reply. The decision is already
        // on the record, which is the part that mattered.
      }
      return;
    }
  },
};

const questEngine = new QuestEngine(content, improv, questWorld, accounts);
for (const r of host.rooms) r.sim.setQuestSink(questEngine);

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

  // `async` since the seventh mushroom: `POST /god` awaits a third-party
  // endpoint. Every other route returns synchronously and is unaffected -- a
  // handler that returns a `Response` rather than a promise still works.
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      let bots = 0;
      for (const r of host.rooms) bots += r.sim.participants.size - r.humans();
      // One read, so the milliseconds and the phase below cannot straddle a
      // tick and describe two different instants.
      const clockMs = Date.now();
      return json({
        ok: true,
        players: host.players(),
        // Every room's bots, summed. Kept as a top-level field across the phase 3
        // rewrite because `server/integration-check.ts` prints it in its
        // transcript header and a deployment probe should not have to sum an
        // array to answer "is anything alive in there".
        bots,
        // **Whether this process answers the ground from vessels.** Published
        // because the client has its own `?vessels=1` and the two are separate
        // switches, so they can disagree -- and when they do the player falls
        // through the world. The client renders the vessel corridor, the server
        // keeps answering `groundFor` from the old path, the server wins every
        // correction, and the effect is indistinguishable from the geometry
        // being broken. It happened: a link with `?vessels=1` outlived the
        // `SYDNEY_VESSELS` drop-in it was handed out with, and the next report
        // was "the road fix regressed".
        //
        // A flag that can be half on is not a flag, it is a trap. `main.ts`
        // reads this before honouring its own.
        vessels: vesselsEnabled(),
        /*
         * **The clock the sky runs on, and the phase it is currently at.**
         *
         * Published for `vessels`' reason two fields up, arrived at from the
         * same accident. The day/night cycle used to be a pure function of each
         * client's own `Date.now()`, which is a fact with as many owners as
         * there are laptops in the room: a machine four minutes fast played four
         * minutes ahead of everybody else's street lights, and nothing anywhere
         * could notice. v11's `WELCOME` gives it one owner -- this process -- and
         * this is where a probe, a load test or a person with `curl` can read
         * what that owner thinks the time is without opening a socket.
         *
         * `phase` is derived here rather than left to the reader for exactly the
         * reason `spawn` is: both ends already compute it from the same pure
         * function, and a probe that had to re-implement `cyclePhase` against
         * `CYCLE_EPOCH_MS` would be a second derivation nobody keeps in step.
         * 0.25 is sunrise, 0.5 solar noon, 0.75 sunset, 0 the dead of night.
         */
        clockMs,
        cyclePhase: Number(cyclePhase(clockMs).toFixed(6)),
        /*
         * **The screaming sun, for `vessels`' and `clockMs`' reason.**
         *
         * This is a global, server-authoritative piece of *appearance*, which is
         * the exact category of state that has cost this project afternoons
         * before: a client showing a face nobody else can see is
         * indistinguishable, from the outside, from a client whose sky is
         * broken. So it is readable with `curl`, without a socket, beside the
         * clock the face's own deadline is measured against -- the two must be
         * read together to mean anything, which is why they are adjacent fields
         * rather than a nested block.
         *
         * The **first room's**, not a summary across rooms, and the field is
         * named for one room's state on purpose. `Room.sun` is per room (see
         * its comment), so a host running eight of them has eight answers and
         * any single boolean here would be a lie in seven of them; `rooms`
         * below is where a probe that cares goes. What this field is for is the
         * ordinary case -- one room, one host, somebody asking "is the sun
         * currently a face" -- and it says so by reporting `room`.
         *
         * `screaming` is published even though it is derivable from
         * `screamUntilMs` and `clockMs`, which is the one place this feature
         * breaks its own "no derived flags" rule. It is derived *here*, in the
         * process that owns both inputs, exactly as `cyclePhase` above is and
         * for the same stated reason: a probe that had to re-implement the
         * comparison would be a second derivation nobody keeps in step.
         */
        sun: (() => {
          const first = host.rooms[0];
          const s = first ? first.sunState() : { screamUntilMs: 0, cooldownUntilMs: 0 };
          return {
            room: first ? first.id : -1,
            screaming: sunScreaming(s, clockMs),
            ready: sunReady(s, clockMs),
            screamUntilMs: s.screamUntilMs,
            cooldownUntilMs: s.cooldownUntilMs,
          };
        })(),
        rooms: host.listing(),
        stage: world.index.stage,
        protocol: PROTOCOL_VERSION,
        // Whether the two GitHub-backed features have a credential. A boolean
        // and nothing else: a probe wants to know that the bug box will file
        // rather than queue, and nothing about the token itself belongs on a
        // route anybody can fetch.
        github: { suggestions: suggestions.linked, bugs: bugs.linked },
        /*
         * WORKSTREAM AK: which content is live, and whether any of it was
         * refused. Published for `vessels`' reason at the top of this object:
         * **a content edit that did not take is invisible from the inside.**
         * The author commits, five minutes pass, nothing changes in the game,
         * and there is no way to tell "the poll has not run yet" from "the
         * pack was refused" from "GitHub is down" without reading a server
         * log. `revision` is the answer to "is my commit live", `refused` is
         * the answer to "was it rejected", and `lastRefusal` is the first
         * reason -- which is very often the only one that matters.
         *
         * `improv` is a boolean and a count and nothing else. Whether a model
         * is configured is an operational fact; the key is not.
         */
        quests: {
          revision: content.revision,
          quests: content.bundle.quests.length,
          npcs: content.bundle.npcs.length,
          refused: content.refusals,
          lastRefusal: content.lastRefusal,
          lastFetchMs: content.lastFetchMs,
          improv: { on: improv.enabled, calls: improv.calls, errors: improv.errors },
        },
        // How many names have a balance on file, and whether the fare loop's
        // debug hatch is on. Published for `vessels`' reason two paragraphs up:
        // a flag that changes what the game does should be readable from
        // outside, or nobody can tell why sprinting is paying money.
        wallets: wallets.size,
        // How many handles are registered. Published for `wallets`' reason one
        // line up, and it is the one number that says whether the accounts file
        // actually loaded -- a store that moved a broken file aside boots
        // perfectly and answers zero here.
        accounts: accounts.size,
        fakeDriving: FAKE_DRIVING,
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
     * `/content` -- the quest packs and the dialog trees, whole, ETag'd.
     * Workstream AK; see `server/quests.contentResponse`.
     *
     * **HTTP rather than a message**, which is the same call `/bug` makes and
     * for a version of its reason: a dialog tree is tens of kilobytes and this
     * server's socket is `maxPayloadLength: 1024` because every frame it was
     * designed for is a few dozen bytes of quantised integers. Raising that
     * ceiling to carry content would raise it for every frame from every
     * client on the host, forever, to deliver something that changes a few
     * times a week and that the browser can cache.
     *
     * Its own route rather than a field on `/health`, on `/rooms`' argument:
     * `/health` is a liveness probe a deployment hits, and this is a thing
     * every client fetches once per revision and then 304s against.
     *
     * Public and unauthenticated, deliberately. The packs are already in a
     * public repository, and a client cannot walk a dialog tree it cannot
     * read -- every decision made inside one is re-walked on this side against
     * this same copy. See `QuestEngine.node`.
     */
    if (url.pathname === '/content') return contentResponse(content, req);

    /*
     * --- The seventh mushroom's conversation.
     *
     * POST the exchange so far, get God's next line and his verdict. Stateless
     * on purpose: the audience lives in the client's hand and comes back every
     * turn, so a server restart mid-conversation loses nothing and there is no
     * per-player session to leak. What the server keeps is the *grant*, which is
     * the only part a client must not be able to invent.
     *
     * Rate-limited by the turn cap inside `Audience`, which the server rebuilds
     * from the posted turns rather than trusting -- a client that posts fifty
     * turns gets an audience that closed at twelve.
     */
    if (url.pathname === '/god' && req.method === 'POST') {
      try {
        const body = (await req.json()) as { turns?: Array<{ who?: string; text?: string }> };
        const audience = new Audience();
        for (const t of (body.turns ?? []).slice(0, MAX_TURNS * 2)) {
          if (t.who !== 'player' && t.who !== 'god') continue;
          audience.say(t.who, String(t.text ?? ''));
        }
        if (audience.closed) {
          return Response.json({ text: '', verdict: 'refused', closed: true }, { headers: { 'access-control-allow-origin': '*' } });
        }
        const said = await askGod(audience, {
          url: process.env.SYDNEY_DIALOG_AI_URL ?? '',
          key: process.env.SYDNEY_DIALOG_AI_KEY ?? '',
          model: process.env.SYDNEY_DIALOG_AI_MODEL ?? 'qwen3-5-4b',
        });
        if (said === null) {
          return Response.json({ text: '', verdict: 'open', quiet: true }, { headers: { 'access-control-allow-origin': '*' } });
        }
        /*
         * **The grant is written here or it is not written.**
         *
         * The client relays the conversation; it never asserts the outcome. The
         * server made the call, read the verdict off the reply, and is the only
         * thing that touches the record -- so a client that posts a made-up
         * "blessed" back at us changes nothing, because nothing here reads what
         * the client thinks happened.
         *
         * A blessing needs an account, which is the honest cost of persisting
         * it: a guest can meet God and be told yes, and will keep the doubling
         * for the session, but there is nowhere to write it down.
         */
        if (said.verdict === 'blessed') {
          const account = accounts.byToken(bearerOf(req));
          if (account !== null && !account.story.includes(BLESSED_FLAG)) {
            account.story.push(BLESSED_FLAG);
            // `seen` is the public "this record changed, schedule a write";
            // `touch` is the store's own and is private, correctly.
            accounts.seen(account);
          }
        }
        return Response.json(
          { text: said.text, verdict: said.verdict },
          { headers: { 'access-control-allow-origin': '*' } },
        );
      } catch {
        return Response.json({ text: '', verdict: 'open', quiet: true }, { headers: { 'access-control-allow-origin': '*' } });
      }
    }
    /*
     * `/auth/*` -- sign up, log in, log out, and the landing page's live handle
     * check. Workstream G; see `server/accounts.ts` for all four and for why
     * they are HTTP rather than socket messages.
     *
     * A prefix rather than four `if`s here, on `/bug`'s argument: every line of
     * what this does lives in that file behind one call, and a feature that
     * needed four cases in this function would be a feature that had put itself
     * in the middle of the server.
     *
     * `srv.requestIP` rather than a header, verbatim for `/bug`'s reason:
     * `X-Forwarded-For` is a string a client can set, so trusting it would
     * replace a rate limit with a decorative one. Behind Caddy this address is
     * Caddy's -- the same honest limitation stated there and in
     * `server/suggestions.addressOf`.
     *
     * **DEPLOY.md's redeploy section has the Caddyfile line this needs.** Caddy
     * proxies `/ws` today and this path is new; without it the landing page's
     * check silently fails in production and every handle reads as available.
     */
    if (url.pathname.startsWith('/auth/')) {
      const ip = srv.requestIP(req)?.address ?? 'unknown';
      // WORKSTREAM N (carry): `liveBodies` is how sign-up finds the guest whose
      // level and location it is carrying, and how logout finds the body whose
      // spot it is saving. See its definition above.
      return handleAuthRequest(req, url, ip, accounts, authGuards, wallets, liveBodies);
    }
    /*
     * `/bug` -- a player's bug report, with the picture that makes it worth
     * having. The only route in this process that **accepts** anything, which
     * is why every line of what it does with what it accepts lives in
     * `server/bugs.ts` behind one call.
     *
     * Its own route rather than a message on the socket, and that is a
     * deliberate departure from how suggestions work. A screenshot is two to
     * four megabytes; this server's WebSocket is configured
     * `maxPayloadLength: 1024` because every frame it was designed for is a
     * few dozen bytes of quantised integers, and raising that ceiling to admit
     * an image would raise it for every frame from every client on the host.
     * An HTTP POST is the right shape for a large one-off body, it can be
     * capped and cancelled mid-flight (see `readCappedBody`), and it costs the
     * game loop nothing.
     *
     * `srv.requestIP` rather than a header: `X-Forwarded-For` is a string a
     * client can set, so trusting it would replace a weak cap with a decorative
     * one. Behind Caddy this address is Caddy's, which is the same honest
     * limitation `server/suggestions.addressOf` states -- and it is why
     * `BugGuards` has a global hourly ceiling that no identity can get around.
     */
    if (url.pathname === '/bug') {
      const ip = srv.requestIP(req)?.address ?? 'unknown';
      // The account, resolved **here** rather than inside the bug route, on the
      // seam `ip` already sits on: that file knows what a bug report is and
      // nothing about tokens. Null for a guest, which the route refuses with
      // "sign up to send feedback" -- see workstream G's gates.
      const author = accounts.byToken(bearerOf(req))?.handle ?? null;
      return handleBugRequest(req, ip, bugs, bugGuards, author);
    }
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
        /**
         * WORKSTREAM AQ: the railway's walls, held near whoever is near them.
         *
         * Beside `segments` because it is the fourth layer of the same idea and
         * fails the same silent way: `resident` at zero while somebody stands in
         * a cutting means this process is walking players through trench walls
         * their own browser stops them at, and nothing else anywhere says so.
         * `provisional` is the one to watch after a restart -- it counts
         * entities built against terrain that had not landed, which should
         * settle to zero within a sweep or two. See `server/rail-lateral.ts`.
         */
        railLateral: world.railLateral?.stats() ?? null,
        /**
         * Is there still traffic on the streets this process is holding?
         *
         * The one thing a lane cap can silently destroy. An eviction cycle that
         * dropped the wrong hexagons, a needed-set rule that never fired, or a
         * `TrafficField.drop` that took a route out and did not put it back
         * would all show up here as a fleet that thinned and stopped -- and
         * nowhere else, because a car costs no protocol and nothing on the wire
         * mentions one. `loadtest.ts` asserts it is nonzero.
         *
         * Computed **on the poll rather than on the tick**: `liveCars` walks
         * every resident route, which is 1-2 ms on a whole-world residency, and
         * this endpoint is read every few seconds by a human or a harness.
         */
        cars: {
          live: world.traffic.liveCars(trafficTick(Date.now())),
          routes: world.traffic.routes().length,
          laneTiles: world.traffic.tileCount,
          bands: world.peds.tileCount,
        },
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
          /*
           * --- Who this is. Workstream G.
           *
           * Two rules, and between them they are the whole of "a handle is
           * globally unique, checked at landing":
           *
           *  1. **A valid token wins and the name is ignored.** Not merged, not
           *     preferred, ignored. The name on a hello is a *request* (see
           *     `protocol.encodeHello`) and a handle is not, so reconciling the
           *     two would be inventing a rule for a case that has an answer: the
           *     account says who you are. `sim.join` still dedupes the handle
           *     against the room, because one person with two tabs open is real
           *     and two identical scoreboard rows is a scoreboard that has
           *     stopped working.
           *
           *  2. **A guest may not wear a registered handle.** Refused with a
           *     `BYE` that says what to do, rather than being silently renamed
           *     to "Bazza (2)" -- which is what `uniqueName` would otherwise do
           *     and which would put somebody one character away from a name they
           *     do not own, in a kill feed, permanently.
           *
           * The refusal is a `BYE` and not a rename because the client has
           * already had a chance to know: the landing page checks the handle
           * against `/auth/check` as it is typed. Reaching here with a taken
           * handle means a stale tab, a hand-built client, or somebody who
           * registered the handle in the last few seconds -- and all three want
           * to be told rather than quietly given a different name.
           *
           * An **expired or unknown token is a guest**, not an error. A player
           * whose thirty days ran out mid-session should land in the game and be
           * asked to log in again, not be refused at the door.
           */
          const account = hello.token === '' ? null : accounts.byToken(hello.token);
          if (account === null && accounts.registered(hello.name)) {
            ws.send(encodeBye('that handle belongs to an account — log in or pick another'));
            ws.close(1008, 'handle');
            return;
          }
          if (account !== null) accounts.seen(account);
          // The name is a request, exactly as the colourway is. `sim.join`
          // sanitises it again and dedupes it against the room -- see
          // `Simulation.pickName` -- so what comes back on `p.name` is what this
          // player is actually called, which is not always what they asked for.
          const p = wanted.join(conn, hello.colourway, account?.handle ?? hello.name, account);
          if (!p) {
            ws.send(encodeBye(`room ${wanted.id} is full (${wanted.cap} players)`));
            ws.close(1013, 'full');
            return;
          }
          conn.room = wanted.id;
          wanted.conns.add(ws);
          wanted.welcome(ws, p);
          console.log(
            // "as an account" and never the token, the id or anything else off
            // the record. A bearer credential in a log file is an account handed
            // to whoever reads the log; see `AccountStore`'s header.
            `[sydney] room ${wanted.id}: player ${p.id} "${p.name}" joined ` +
              `(kit ${p.colourway}${account ? `, lvl ${p.level}, account` : ', guest'}); ` +
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

        /*
         * The button on the hill in Sydney Park. See `server/room.sunPress`.
         *
         * Resolved against `conn.room` like every other case in this switch
         * except the two above it, because the sun is a fact about *a copy of
         * Sydney* rather than about the conversation -- `Room.sun` states that
         * split at length.
         *
         * No flood guard, and that is a decision rather than an omission. The
         * handler is idempotent by construction: a second press inside the
         * three-in-game-day cooldown is refused by `trySunPress` and answered
         * with sixteen bytes to the one socket that asked, so a client hammering
         * this key at 60 Hz costs one distance test and one small send per
         * frame and changes nothing. That is a smaller cost than
         * `MSG.INPUT` already pays on the same socket, and the flood guards in
         * this process exist for the messages that *write* something every time
         * (chat, suggestions).
         */
        case MSG.SUN_PRESS: {
          if (!decodeSunPress(frame)) return;
          const room = conn.room >= 0 ? host.get(conn.room) : undefined;
          room?.sunPress(ws);
          return;
        }
        /**
         * The phone: claim a Centrelink payment, or clock on and off the
         * rideshare shift. See `client/src/net/cash.ts` for why three
         * operations are one message id.
         *
         * Unlike `CHAT_SAY` and `SUGGEST` above, this one is emphatically the
         * **room's**: a claim is adjudicated against a body this room is
         * simulating and a shift belongs to a fare loop this room is stepping.
         * So it resolves `conn.room` and stops there, which is what every case
         * except those two does.
         *
         * There is no flood guard beyond the rules themselves, and that is a
         * decision rather than an omission: a claim is refused by a position
         * test and a timer, both of which are a map lookup, and going online
         * twice is idempotent by construction. The expensive thing in this
         * feature -- picking a kerb point -- happens on the *tick* when a fare
         * is offered and cannot be provoked from here at all.
         */
        case MSG.PHONE: {
          const p = conn.participant;
          if (!p) return;
          const req = decodePhone(frame, MSG.PHONE);
          if (!req) return;
          const room = host.get(conn.room);
          if (!room) return;
          if (req.op === PHONE_OP.CLAIM) {
            const refusal = room.sim.claim(p.id, req.officeId);
            // A refusal is a sentence and a success is silence, because the
            // success already has one: the `WALLET` frame the credit produces
            // carries "+$100 centrelink" and arrives on the next tick. Two
            // messages for one event would be the pill saying it twice.
            if (refusal !== '' && p.walletNote === '') p.walletNote = refusal;
            if (refusal !== '') p.walletVersion++;
            return;
          }
          room.sim.setOnline(p.id, req.op === PHONE_OP.ONLINE);
          return;
        }

        /**
         * Teams and talents: pick a side, spend a point, take one back, start
         * again. See `client/src/net/teams.ts` for why four operations are one
         * message id, and `Simulation.teamOp` for the rules.
         *
         * Emphatically the **room's**, like `PHONE` above it and unlike `CHAT`
         * and `SUGGEST`: the answer is a broadcast to everybody standing in this
         * copy of Sydney, because a team is a colour on a body and the bodies
         * are here.
         *
         * No flood guard, on `SUN_PRESS`' argument and `PHONE`'s: every branch
         * inside `teamOp` is idempotent or refused by a rule, the whole of what
         * a hammered key costs is a walk of 42 nodes and one string compare, and
         * the expensive thing in this feature -- folding auras across the room
         * -- happens on the tick and cannot be provoked from here at all.
         */
        case MSG.TEAM: {
          const p = conn.participant;
          if (!p) return;
          const req = decodeTeamOp(frame, MSG.TEAM);
          if (!req) return;
          const room = host.get(conn.room);
          if (!room) return;
          room.sim.teamOp(p.id, req.op, req.value);
          return;
        }

        /**
         * Quests and dialog: take a job, hand one in, give one up, walk a
         * dialog node, or say a photograph was taken. See
         * `client/src/net/quests.QUEST_OP` for why six operations are one
         * message id, and `QuestEngine.handle` for the rules.
         *
         * The **host's** rather than a room's, like `CHAT_SAY` and `SUGGEST`
         * and unlike `PHONE` and `TEAM`: a quest is about the game and the
         * story flags are on an account, so two rooms with two engines would
         * be a player whose Act 0 progress depended on where they spawned.
         * The engine resolves the body itself through `QuestWorld`.
         *
         * The flood guard is **inside** the engine rather than here, on
         * `SuggestionHub`'s seam exactly: it is per-player state belonging to
         * the feature, and a budget kept out here would be a budget the
         * checks have to get past to drive the ops. See `QUEST_BURST`.
         */
        case MSG.QUEST: {
          const p = conn.participant;
          if (!p) return;
          const req = decodeQuest(frame, MSG.QUEST);
          if (!req) return;
          questEngine.handle(p.id, req.op, req.id, req.node, req.choice);
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
      // WORKSTREAM AK, for `suggestionHub.forget`'s reason and one more: the
      // engine holds a **guest's whole progress** in a map keyed by player id,
      // so forgetting on close is both what stops that map being an unbounded
      // leak on a long-running host and what makes "a guest's quests do not
      // persist" true rather than merely undocumented.
      if (ws.data.participant) questEngine.forget(ws.data.participant.id);
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
  // WORKSTREAM AK. **After the rooms, once for the host**, which is the whole
  // of the quest engine's presence in the loop. Its own sweep is internally
  // throttled to `SWEEP_HZ` -- a `goto` radius is metres and a player moves at
  // most 8 m/s, so a quarter-second sample cannot miss a circle it walked
  // through, and a per-tick distance test per open quest per player is a cost
  // this box does not have to pay to notice something that happens once a
  // minute. `flush` is the batch: one knockout can advance three quests, pay
  // money and set a flag, which is one frame's worth of news.
  questEngine.tick(1 / TICK_HZ);
  questEngine.flush();
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
  // --- WORKSTREAM AA: and where that median went.
  //
  // On its own line rather than appended to the one above, because the line
  // above is already at the width of a terminal and a breakdown that wraps is a
  // breakdown nobody reads. Six sections is what fits and is also about the
  // point at which the tail stops being actionable; everything under them is in
  // `rest` with the pump, the timers and the socket reads.
  //
  // **This is the line the regression this workstream fixed would have been
  // caught by.** Nothing was wrong with the old measurement except that it was
  // only visible to somebody who thought to `curl /stats` and knew what the
  // numbers used to be. See `server/profile.ts`.
  {
    const phases: Record<string, number> = {};
    let overhead = 0;
    for (const r of host.rooms) {
      r.logProfile.take(r.sim.profile, phases);
      // Per tick, like everything else on this line: `lastOverheadMs` is the
      // whole window and a window is six hundred ticks.
      const t = r.logProfile.lastTicks;
      overhead += t > 0 ? r.logProfile.lastOverheadMs / t : 0;
    }
    let accounted = 0;
    for (const v of Object.values(phases)) accounted += v;
    console.log(
      `[sydney]   tick ${median.toFixed(2)} ms = ${topSections(phases, 6, median - accounted)}` +
        `   (profiler ${(overhead * 1000).toFixed(2)} us/tick)`,
    );
  }
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
    `(${TICK_HZ} Hz tick, ${HOST_SNAPSHOT_HZ} Hz snapshots, ${MAX_REWIND_MS} ms rewind, protocol ${PROTOCOL_VERSION}, ` +
    `spec 2's cap is ${MAX_PLAYERS} and a room here holds ${ROOM_CAP})`,
);
// WORKSTREAM AD: and, only if somebody has moved it off the default, exactly
// what a lower snapshot rate has given up. A knob like this is dangerous
// precisely because it is silent -- somebody sets it once, forgets, and spends
// a month looking for the cause of remote-player stutter -- so the host says so
// on every boot rather than once in a changelog. See `net/snapshotrate.ts`.
{
  const line = describeRate(
    process.env.SYDNEY_SNAPSHOT_HZ === undefined ? undefined : Number(process.env.SYDNEY_SNAPSHOT_HZ),
    HOST_SNAPSHOT_HZ,
  );
  if (line !== '') console.log(`[sydney] ${line}`);
}
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
    // The bug queue goes out on the same signal and for the same reason: a
    // report accepted twenty seconds before a deploy would otherwise sit on
    // disk until the next process's minute timer came round, and the player has
    // already been told it is queued.
    void Promise.all([
      suggestions.close().catch((err) => console.error(`[sydney] suggestions: flush failed: ${String(err)}`)),
      bugs.close().catch((err) => console.error(`[sydney] bugs: drain failed: ${String(err)}`)),
      // And the wallets, which are the second thing in this process worth
      // flushing. Their debounce is 5 s rather than the ledger's 250 ms (see
      // `server/wallets.ts`), so this is the difference between losing nothing
      // on a deploy and losing whatever the last five seconds paid.
      wallets.close().catch((err) => console.error(`[sydney] wallets: flush failed: ${String(err)}`)),
      // And the accounts, which are the third. Their debounce is two seconds
      // rather than the wallets' five (see `ACCOUNT_SAVE_DEBOUNCE_MS`) and the
      // sign-up path writes synchronously, so what this actually flushes is the
      // last few seconds of the level ladder -- a knockout that would otherwise
      // be lost on every deploy.
      accounts.close().catch((err) => console.error(`[sydney] accounts: flush failed: ${String(err)}`)),
    ]).finally(() => process.exit(0));
  });
}
