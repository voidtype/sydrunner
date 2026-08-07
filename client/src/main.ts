/**
 * Client entry point.
 *
 * Milestone 1 and 7 of the spec, plus the parts of 4 and 5 that the material
 * carries: streamed world tiles rendered with the parallax facade shader, under a
 * correctly-positioned Sydney sun, walkable in first person with collision
 * against the pipeline's prisms.
 */

import {
  Fog,
  NeutralToneMapping,
  Object3D,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGPURenderer,
} from 'three/webgpu';

import { EXPOSURE } from './sky/calibration.ts';
import { SydneySky } from './sky/sky.ts';
import { sydneyTime, verifySouthernHemisphere } from './sky/solar.ts';
import { fetchWorldAsset, verifyCdn } from './world/cdn.ts';
import { createFacadeGlobals } from './world/facade.ts';
import { loadFarLayer } from './world/far.ts';
import { loadLandmarks, verifyLandmarks } from './world/landmarks.ts';
import { createFarGround } from './world/ground.ts';
import { NO_GROUND } from './world/terrain.ts';
import { WaterLevels, verifyWading } from './world/wading.ts';
import { loadFarWater, verifyWater } from './world/water.ts';
import { atlasTextureSize } from './world/params-atlas.ts';
import { TileStreamer, type WorldIndex } from './world/streamer.ts';
import { TrafficMovers, carBodySizes } from './world/cars.ts';
import {
  CAR_STAGE_PARKED_IN,
  CAR_STAGE_PARKED_OUT,
  TrafficField,
  applyCarHit,
  carHitStrength,
  carHitting,
  createCarPose,
  forEachCarNear,
  trafficTick,
  verifyTraffic,
  type CarPose,
  type LaneRoute,
} from './game/traffic.ts';
import {
  IMPOSTOR_CAPACITY,
  PedestrianAssets,
  PedestrianCrowd,
  RIG_CAPACITY,
  verifyPedestrianModel,
} from './world/people.ts';
import {
  PedestrianField,
  createPedPose,
  forEachPedestrianNear,
  onPedestrianStruck,
  strikePedestrian,
  strikePedestrianWithBall,
  verifyPedestrians,
  type PedBand,
  type PedPose,
} from './game/pedestrians.ts';
import { warmUpPipelines } from './world/warmup.ts';
import { NIGHT_VISIBLE_LEVEL, NightLights, verifyNightLights } from './world/nightlights.ts';
import { CollisionWorld } from './player/collision.ts';
import {
  EYE_HEIGHT,
  PLAYER_RADIUS,
  applyToCamera,
  verifyMovementBasis,
} from './player/controller.ts';
import {
  COLOURWAYS,
  CharacterActor,
  CharacterAssets,
  castShadowOnly,
  setVisibleToCamera,
  verifyCharacterRig,
  type ActionName,
} from './player/character.ts';
import { verifyAnimation } from './player/animation.ts';
import { BatAssets, BatProp, BatViewmodel, MAX_VIEW_REACH, verifyBat } from './player/bat.ts';
import {
  CAST_RADIUS,
  MAX_HEALTH,
  MAX_STAMINA,
  REACH,
  STAMINA_RECOVERY,
  advance,
  applyHit,
  createCombatant,
  hitTest,
  pickRespawn,
  planSpeed,
  respawnAt,
  verifyCombat,
  type CombatInput,
  type CombatWorld,
  type CombatantState,
  type HitReport,
} from './game/combat.ts';
import { ActorDriver, Dummy, type DummyKind } from './game/dummies.ts';
import { SPAWN_DITHER_RADIUS, pickSpawnPoint, spawnCentre, verifySpawn } from './game/spawn.ts';
// The knockout clock, for the one place the police are the cause of one. See
// `offlineFactionCtx`'s `damagePlayer`, which is `combat.applyHit` without a
// puncher.
import { KO_SECONDS } from './game/combat.ts';
import {
  BALL_CHARGES,
  BALL_RECHARGE,
  createHitReport,
} from './game/combat.ts';
import { BALL_RADIUS, FootyField, applyFootyHit, verifyFooty, type FootyEvent } from './game/footy.ts';
import { NetClient, chooseRoom, fetchRooms, verifyNetClient, type RemotePlayer } from './net/client.ts';
import { verifyChat } from './net/chat.ts';
import { ChatBox, verifyChatBox } from './chat.ts';
// `/unstuck`. The rule is shared with `server/sim.ts` verbatim, which is what
// makes the offline relocation below the same feature rather than a lookalike.
// See `game/unstuck.ts` for why it is a chat command and not a message id.
import {
  UNSTUCK_CAR_CLEAR_M,
  UNSTUCK_COOLDOWN_MS,
  UNSTUCK_KO_NOTICE,
  unstuckCommand,
  unstuckDestination,
  unstuckReply,
  unstuckWaitNotice,
  verifyUnstuck,
} from './game/unstuck.ts';
import { verifySuggestions } from './net/suggestions.ts';
import { SuggestionsPanel, clientId } from './suggestions.ts';
import { ANIM, SNAPSHOT_INTERVAL, sanitiseName, suggestName, verifyNames, verifyNet } from './net/protocol.ts';
import {
  FootyAssets,
  FootyPool,
  FootyProp,
  FootyViewmodel,
  THROW_SECONDS,
  footyWarmupParts,
  verifyFootyBall,
} from './world/footyball.ts';
import { NameplateField, verifyNameplates, type PlateInput } from './world/nameplates.ts';
import {
  RenderGuard,
  auditSceneTextures,
  installTextureShim,
  quarantine,
  registeredCount,
  shimCatchLines,
  verifyTextureAudit,
} from './world/texture-audit.ts';
import {
  FLAT_WHITE,
  KIND_NAME as POWERUP_NAME,
  TRAINING,
  PowerupField,
  damageScale,
  speedScale,
  respawnSeconds,
  tickPowerups,
  verifyPowerups,
  type PickupEvent,
} from './game/powerups.ts';
import {
  BikeField,
  TUNING_X,
  TUNING_Z,
  BIKE_TUNED_COFFEES,
  RIDE_PROMPT,
  RIDE_TURN_RATE,
  bikePlan,
  bikeSpeedScale,
  inTuningZone,
  placeBike,
  ridePrompt,
  shapeRideSteering,
  verifyBikes,
  type BikeGround,
  type BikePlanEntry,
  type RideSteering,
  type RiderView,
} from './game/bikes.ts';
import {
  BIKE_LEAN,
  BikeAssets,
  BikeMeshes,
  RiddenBike,
  buildTuningStall,
  verifyBikeGlow,
  verifyBikeMesh,
} from './world/bike.ts';
import { CombatAudio } from './game/audio.ts';
import { FOV_BASE, Feedback } from './game/feedback.ts';
import { Locator, verifyLocator } from './game/locator.ts';
// The police, and the faction framework they are the first user of. `factions.ts`
// is the shared simulation half -- the server runs the identical file -- and
// `world/police.ts` is the renderer. See either header.
import {
  COUNTDOWN_TICKS,
  FactionField,
  NPC_KIND,
  NPC_STATE,
  REASON,
  POLICE_CLIPS,
  POLICE_STATIONS,
  createBeatPose,
  createWitness,
  feedLine,
  forEachPoliceNear,
  nearestStation,
  npcHitTest,
  npcKind,
  policeWitness,
  reasonText,
  strikeNpc,
  verifyPolice,
  type FactionCtx,
  type NpcActor,
} from './game/factions.ts';
import { PoliceAssets, PoliceSquad, Tracers, verifyPoliceKit } from './world/police.ts';
// The street factions -- meth heads and drunks -- on the same split again:
// `game/streetlife.ts` is the shared simulation the server runs and
// `world/streetlife.ts` is the renderer. See either header.
import {
  DRUNK_CLIPS,
  METHHEAD_CLIPS,
  SUBURBS,
  createStreetPose,
  forEachDrunkNear,
  forEachMethheadNear,
  isStreetKind,
  nearestSuburbName,
  stepStreetlife,
  strikeCrime,
  verifyStreetlife,
} from './game/streetlife.ts';
import { StreetCrowd, StreetlifeAssets, verifyStreetlifeKit } from './world/streetlife.ts';
// The wildlife -- bush turkeys, ibises and magpies -- on the same split once
// more: `game/wildlife.ts` is the shared simulation the server runs and
// `world/wildlife.ts` is the renderer. See either header.
import {
  createWildPose,
  createWildScratch,
  isProtected,
  stepWildlife,
  verifyWildlife,
} from './game/wildlife.ts';
import { WildlifeAssets, WildlifeFlock, verifyWildlifeKit } from './world/wildlife.ts';
import { Hud, verifyHud } from './hud.ts';
import { Minimap } from './minimap.ts';
import { MapAtlas } from './mapatlas.ts';
import { BigMap, verifyBigMap } from './bigmap.ts';
import { InvisibleWalls, verifyInvisibleWalls } from './world/invisible-walls.ts';
import { verifyTileLifecycle } from './world/tile-lifecycle.ts';

const SIMULATION_HZ = 60;
const FIXED_DT = 1 / SIMULATION_HZ;
/** Collision is only needed where the player can reach, not to the draw distance. */
const COLLISION_RADIUS = 420;
/** How long one prism payload is given before it is abandoned. See `ensureGround`. */
const COLLISION_FETCH_TIMEOUT_MS = 8000;
/**
 * How long the shader warm-up is given before the boot proceeds without it.
 *
 * Generous, because unlike every other deadline on this path it is not waiting
 * on a network and the thing it is protecting against is a driver, not a link:
 * it is far longer than the measured pass and short enough that a GPU which has
 * decided to compile one shader forever cannot hold the game hostage. Losing the
 * race costs the first walk its hitches and nothing else -- the compiles simply
 * happen where they used to.
 *
 * **Raised from 8,000 with the night lighting, and the ratio is the point rather
 * than the number.** Every light in the scene appears in every material's
 * generated WGSL, so the three the night rig adds make all 83 pipelines bigger:
 * the pass measured 4,765 ms with no night lights, 6,708 ms with them, and about
 * 0.6 s per light in between (see `calibration.LAMP_REAL_COUNT`, which was sized
 * on that curve). 8,000 over the old 4,765 was 68% of headroom; 11,000 over the
 * new 6,708 is 64% of the same, which is what this restores. Leaving it at 8,000
 * would have meant a machine 20% slower than this one silently losing the
 * warm-up and getting the compile hitches back -- which is the failure the whole
 * pass exists to prevent, arrived at by not moving a number.
 *
 * It is shared with the landmark and far-layer compiles below, and that is
 * correct rather than incidental: those are the same kind of work paying the
 * same tax for the same reason, so one number is what keeps them consistent.
 */
const WARMUP_DEADLINE_MS = 11000;

async function main(): Promise<void> {
  const hud = new Hud();

  // --- Self-checks, before anything expensive.
  //
  // All six guard bugs that are silent in this project's sense of the word:
  // they render, they do not throw, and they read as taste decisions. A
  // northern-hemisphere sun; a movement basis that ignores where the camera is
  // looking; a character wound inside out or weighted so it shrinks; a clip
  // that writes nothing at all, which presents as "the animation is subtle";
  // a swing whose cycle is 517 ms, whose reach is 2.4 m, or whose knockback
  // is a stagger; and a powerup whose speed modifier never reaches the
  // integrator, which chimes and counts down and does nothing -- none of which
  // has a picture, and all of which read as "it feels off".
  //
  // Timed, individually and in total, and the reason is that this block is
  // **synchronous and ahead of the renderer**: every millisecond it spends is a
  // millisecond of black screen before anything can even be attempted, and a
  // check is exactly the kind of code that grows an order of magnitude without
  // anyone noticing -- `verifyCharacterRig` skins every vertex of the figure
  // through every clip on the CPU, and `verifyCombat` runs the phase machine to
  // completion. Nothing here is removed on a bad number; the number is simply
  // reported, once, so that "the game takes a while to start" has somewhere to
  // be looked up rather than being guessed at.
  const checkMs: Array<[string, number]> = [];
  const checkStart = performance.now();
  const timed = (name: string, run: () => string[]): string[] => {
    const at = performance.now();
    const failures = run();
    checkMs.push([name, performance.now() - at]);
    return failures;
  };
  const sunFailures = timed('sun', () => verifySouthernHemisphere(-33.87, 151.21));
  const moveFailures = timed('movement', verifyMovementBasis);
  const animFailures = timed('animation', verifyAnimation);
  const rigFailures = timed('rig', verifyCharacterRig);
  // The bat, on the same criterion and with the same three-word test: does the
  // failure render, not throw, and read as a taste decision? All six of its
  // checks do. A blade lofted inside out is invisible from outside; a prop
  // parented to the wrong bone floats beside the character instead of swinging;
  // a mounting angle a few tenths out drags the toe through the footpath at
  // every step, which the first-person camera the developer is sitting in cannot
  // see; a swing that reaches somewhere other than where `combat.REACH` stops
  // reads as lag; and a viewmodel over the crosshair is a complaint rather than
  // a bug. See `player/bat.ts`.
  const batFailures = timed('bat', verifyBat);
  const combatFailures = timed('combat', verifyCombat);
  const powerupFailures = timed('powerups', verifyPowerups);
  // The four this pass adds, on the same criterion.
  //
  // A **ball trajectory that is not deterministic** is the worst of them and has
  // no picture at all: the client and the server fly the same throw to two
  // different places, so a player watches their own ball sail past somebody and
  // is told they hit them. It reads exactly like lag and it is not lag. The
  // **model** check covers what the ball looks like and, specifically, the
  // layering bug the raygun this replaced shipped with for the life of that
  // feature -- every player could see their own weapon floating at their hip,
  // which is invisible to anyone testing in third person. And a quantiser off by
  // a factor puts every remote somewhere slightly wrong, and a reconciliation
  // that does not converge reads as -- lag. None of the four has a frame that
  // says otherwise, which is exactly this project's bar.
  const footyFailures = timed('footy', verifyFooty);
  const footyBallFailures = timed('footy model', verifyFootyBall);
  const netFailures = timed('net', verifyNet);
  const clientFailures = timed('net client', verifyNetClient);
  // And the names, on the same criterion as everything above it: every way this
  // breaks produces a *name*, which renders perfectly. A sanitiser that is not
  // idempotent gives a player one name in the prompt and another over their
  // head; a dedupe that is case-sensitive puts two rows called Bazza on the
  // board; a roster whose name length is read before the fields it follows
  // decodes every entry after the first as garbage at plausible values, which
  // draws a leaderboard of players nobody has ever met. None of them throws.
  // The server runs this same function before it opens its socket, which is the
  // half that makes it worth having -- the two ends have to agree about what a
  // name is or the one the player typed is not the one anybody sees.
  const nameFailures = timed('names', verifyNames);
  // And the chat, on the names' criterion exactly: every way it breaks produces
  // *text*, which renders perfectly. A sanitiser that is not idempotent posts a
  // different sentence from the one in the box; a byte cap enforced in
  // characters encodes a length a `u8` cannot hold and turns one player's
  // messages into garbage; a truncation on a byte boundary puts half a code
  // point on the end and reads as the sender's keyboard; a rate window wrong by
  // a factor either lets a flood through or throttles a conversation. None of
  // them throws. The server runs this same function before it opens its socket,
  // which is the half that makes it worth having. See `net/chat.ts`.
  const chatFailures = timed('chat', verifyChat);
  const chatBoxFailures = timed('chat box', verifyChatBox);
  // And `/unstuck`, which arrives over that same chat wire and fails silently in
  // its own way: a prefix match instead of an exact one turns "/kill bazza" into
  // a teleport and swallows the sentence, and a destination that is not validated
  // moves somebody out of one piece of stuck geometry into another. Both leave a
  // game that runs. See `game/unstuck.ts`; the server runs this function too.
  const unstuckFailures = timed('unstuck', verifyUnstuck);
  // And the suggestions box, on the same criterion a third time, with one class
  // of failure the other two do not have: a **week boundary computed by epoch
  // arithmetic** is an hour out for half the year, and the symptom is a quota
  // that resets at the wrong moment twice a year -- which is invisible, because
  // nobody is counting their votes against a clock. The rest is the familiar
  // shape: a sanitiser that misses the tally marker lets a suggestion overwrite
  // a score, and a length prefix out of step draws a list nobody wrote. The
  // server runs this same function before it opens its socket, which is what
  // makes it worth having: it keeps the ledger. See `net/suggestions.ts`.
  const suggestionFailures = timed('suggestions', verifySuggestions);
  // And the map readout, on the same criterion again. Every way this breaks
  // leaves a plausible street name under the map: the street behind you, the
  // street a hundred metres past the end of a way, a corner claimed halfway
  // down a block, or "cnr Crown St & Crown St". None of them throws and none of
  // them has a frame that says otherwise -- see `verifyLocator`.
  const locatorFailures = timed('locator', verifyLocator);
  // And the water, in two halves that fail in two different silent ways. A
  // sidecar decoded a word out of step is triangles at plausible coordinates and
  // impossible depths; a wading rule whose tile keying disagrees with the
  // terrain's puts the water level one tile from the water, so the player wades
  // across a car park in Pyrmont and runs across Darling Harbour. Neither throws
  // and neither has a frame that says so -- see `world/water.ts` and
  // `world/wading.ts`.
  // And the traffic, on the same criterion and with the worst symptom of the
  // lot: **none of the ways this breaks has a picture that says so.** A schedule
  // that is not deterministic puts one player's cars somewhere else and then
  // tells them they were run over by nothing. A left-hand offset with the sign
  // flipped is a Sydney that drives on the right, which is instantly obvious to
  // anyone who lives here and invisible to every check that only asks whether
  // cars are on roads. A hit box that has drifted from the drawn body knocks you
  // over from a metre away. A red light that interpolates instead of holding is
  // a city where nothing ever stops. See `game/traffic.ts`.
  //
  // `carBodySizes()` is handed in rather than imported by that module, because
  // it compiles into the Bun server and must not pull three in behind it.
  const trafficFailures = timed('traffic', () => verifyTraffic(carBodySizes()));
  const wadingFailures = timed('wading', verifyWading);
  const waterFailures = timed('water', verifyWater);
  // The release CDN's half of a two-repo contract. If this file and
  // `scripts/publish-world-release.sh` disagree about how a world path becomes
  // an asset name, every CDN fetch 404s, every one silently falls back to the
  // origin, and the *only* symptom is the bandwidth bill the CDN exists to
  // prevent. Nothing on screen looks wrong. See `world/cdn.ts`.
  const cdnFailures = timed('cdn', verifyCdn);
  // And where the session starts, which fails in the same shape: a sign error on
  // the spawn's z is a world that boots in Chatswood, and a dither that never
  // rejects is a boot inside a warehouse or under a pond in Sydney Park. Both
  // render perfectly -- see `game/spawn.ts`.
  const spawnFailures = timed('spawn', verifySpawn);
  // And the lime e-bikes, in the same two halves the football has and failing in
  // the same two silent ways. The **rules** half: a multiplier that stopped
  // being twice a coffee run, a spawn plan that is not the same plan twice, or a
  // claim two riders both win -- which is two players moving at 26 m/s with one
  // mesh between them and no frame that says so. The **model** half: a frame
  // wound inside out is see-through from one side only, and a bike drawn to
  // different numbers from the ones the rider is posed to puts a figure
  // pedalling in mid-air beside its own saddle, which reads as a rigging bug and
  // is really two files disagreeing. See `game/bikes.ts` and `world/bike.ts`.
  const bikeFailures = timed('bikes', verifyBikes);
  const bikeMeshFailures = timed('bike model', verifyBikeMesh);
  // And the light a parked one gives off -- the marker under it and the beam
  // over it -- which fails in a third silent way: a flat horizontal surface
  // wound the intuitive way faces the ground, so the glow would be drawn
  // perfectly for anybody standing under the road and be invisible to every
  // player. The beam adds its own: a gradient that does not reach zero is a
  // green line ruled across the sky with a visible end, a beam and a bike
  // filled from different gates is a 72 m column left standing over an empty
  // parking spot, and `depthTest` turned off trades the whole over-the-rooftops
  // effect for a green haze drawn through the terrain. See
  // `world/bike.verifyBikeGlow`.
  const bikeGlowFailures = timed('bike glow', verifyBikeGlow);
  // And the pedestrians, in the same two halves and failing in the same two
  // silent ways.
  //
  // The **rules** half is where the interesting failure is: a footpath band
  // derived on the wrong side of the kerb is a crowd walking up the middle of
  // Cleveland Street, which looks like a deliberate stylistic choice from every
  // camera angle and is invisible to any check that only asks whether people are
  // near streets -- exactly the shape of `verifyTraffic`'s left-hand-drive
  // assertion, and derived from the same sidecar. A schedule that is not
  // deterministic matters here for a reason the traffic's does not: the police
  // pass that follows this one turns hitting somebody into a crime, and two ends
  // that disagree about where a pedestrian was standing would fine you for
  // hitting nobody. And a density that has drifted is either a ghost town or
  // Pitt Street Mall on a Saturday, both of which read as taste.
  //
  // The **model** half is `world/bike.ts`'s: a figure wound inside out is
  // see-through from one side only, and an impostor built to different
  // proportions from the rig is somebody who changes height at 55 m -- which is
  // the one thing that would give the LOD handoff away and the one thing no
  // single frame can show. See `game/pedestrians.ts` and `world/people.ts`.
  const pedFailures = timed('pedestrians', () =>
    verifyPedestrians(COLOURWAYS.length, null, { rigs: RIG_CAPACITY, impostors: IMPOSTOR_CAPACITY }),
  );
  const pedModelFailures = timed('pedestrian model', verifyPedestrianModel);
  // And the police, in the same two halves and failing in the same two silent
  // ways.
  //
  // The **rules** half is where the interesting failures are, and there are four
  // of them. A station table with a coordinate outside the built extent puts a
  // beat over the harbour where there are no footpath bands at all, so that
  // command silently contributes nobody -- and the symptom is "the police feel
  // thin in the north", which reads as tuning. A reason code with no string
  // draws `Under Investigation! undefined`, and the one code nothing in this
  // build exercises is the one reserved for the wildlife faction, which is
  // therefore the one that would ship broken. A line-of-sight ray that answers
  // backwards is police who see through terraces and cannot see across a car
  // park, which reads as the witness range being wrong. And a miss model off by
  // a factor is either police who never hit or police who cannot be outrun.
  //
  // The **model** half is `world/bike.ts`'s: a chest band wound inside out is
  // invisible from outside the officer and solid from inside them, which from
  // any single frame reads as z-fighting; and a chequer with an odd number of
  // facets stops being a chequer at exactly the seam nobody photographs.
  //
  // `SNAPSHOT_INTERVAL` is handed in rather than imported by that module,
  // because it compiles into the Bun server and the fire window has to survive
  // the snapshot rate -- see `factions.FIRE_STATE_TICKS`.
  // The kit's own half runs later, where the assets exist -- see the
  // `verifyPoliceKit` call beside `PoliceAssets`. This is everything that needs
  // nothing but arithmetic, which is most of it.
  const policeFailures = timed('police', () => verifyPolice(undefined, SNAPSHOT_INTERVAL));
  // And the street factions, on the same two halves again.
  //
  // The **rules** half has its own four: an anchor outside the built extent puts
  // a loiterer over the harbour where there are no bands, so that suburb
  // silently contributes nobody; aggro radii in the wrong order invert the whole
  // feature, because a drunk who turns on you before they are promoted is a
  // drunk who was never strikeable while passive and the "hitting a bystander is
  // a crime" rule could then never fire at all; a swig cycle that is not a cycle
  // leaves a bottle permanently at somebody's mouth; and a pacing wave that is
  // not periodic walks a meth head out of their suburb over the following ten
  // minutes. See `verifyStreetlife`.
  //
  // The **model** half runs later beside the assets -- see `verifyStreetlifeKit`
  // by `StreetlifeAssets` -- and is the one that would otherwise ship a beanie
  // inside somebody's skull.
  const streetFailures = timed('streetlife', verifyStreetlife);
  // And the wildlife, in the same two halves once more.
  //
  // The **rules** half is where this feature's silent failures live and there
  // are five. A park outside the built extent puts turkeys on tiles that do not
  // exist, where the ground query has nothing to answer with and they stand at
  // the height of whoever asked last. A turkey grid finer than twice the leash
  // lets a chasing bird end up nearer its neighbour's anchor than its own, and
  // the renderer -- which matches live birds back to anchors by distance,
  // because the wire carries no anchor -- then draws the ambient twin as well:
  // two turkeys, one a ghost. An anchor scheme keyed off the *query* rather
  // than off the world is perfectly repeatable and completely wrong, so it is
  // checked from two different query centres. A swoop arc that misses head
  // height is a magpie that dives at everybody forever and connects with
  // nobody -- which the first cut of it genuinely did, by 3.26 m, while looking
  // entirely convincing. And an unregistered kind is a bird on the wire that
  // nothing can see or hit.
  //
  // The **model** half runs later beside the assets -- see `verifyWildlifeKit`
  // by `WildlifeAssets`.
  const wildlifeFailures = timed('wildlife', () => verifyWildlife());
  // And the nameplates, on the same criterion once more. Every way this breaks
  // renders: a text cache that misses re-uploads two megabytes of atlas twenty
  // times a second and reads as a streaming stall; a fade that is not monotonic
  // makes the far plates the bright ones; a plate for your own id is your own
  // name floating in front of your face for the whole session. See
  // `world/nameplates.ts`. `MAX_HEALTH` is handed in so the bar's pip ticks
  // cannot drift from the number of pips there actually are.
  const nameplateFailures = timed('nameplates', () => verifyNameplates(MAX_HEALTH));
  // And the render guard, which is the only check here about the *loop* rather
  // than about the world. It earns its place the way the HUD's does: it covers
  // something that already shipped broken. A render exception used to abort the
  // frame and every frame after it in silence -- the 3D world stopped dead while
  // the big map, which is 2D and on its own rAF, went on animating, so it read
  // as a stutter rather than as the crash it was. See `world/texture-audit.ts`.
  const guardFailures = timed('render-guard', () => verifyTextureAudit());
  // And the HUD's supply bar, which is here for a reason the rest of this list is
  // not: it is the only one of them that shipped broken. Every number about the
  // footy was right -- the trickle, the wire, the reconciler -- and the third
  // block of the bar stayed dark anyway, because an inline width the paint loop
  // could no longer reach outranked the CSS class that says "full". `BALL_CHARGES`
  // is handed in so the check cannot drift from the bar's actual length. See
  // `hud.verifyHud`.
  const hudFailures = timed('hud', () => verifyHud(BALL_CHARGES));
  // And the invisible-wall overlay, which earns a check on the same criterion
  // the HUD's does: every way it breaks draws something plausible. The cell
  // arithmetic is floored off a tile's minimum corner and the whole build is
  // south and west of the origin, so a scheme only ever tried at (0, 0) is off
  // by one over the entire map and marks the tile next door. The structural
  // split is *positional* -- the first `total - b` records of a collision
  // payload -- so an off-by-one calls a terrace a viaduct and an inverted
  // comparison marks every building in the city. The residency test has to
  // require collision as well as missing geometry, or the overlay lights up
  // every tile the streamer has not reached, which is most of the visible city
  // at all times. And it has to *clear* when a build lands, because an overlay
  // that never goes out trains the player to ignore it. See
  // `world/invisible-walls.ts`.
  const wallFailures = timed('invisible-walls', () => verifyInvisibleWalls());
  // And the two rules that decide when a tile is *allowed* to be one of those
  // walls, which is the same criterion again: both of them fail by looking
  // healthy. A transient failure misfiled as permanent is a tile that is never
  // requested again and nothing anywhere says so -- it reads as a slow network
  // forever. A collision keep radius that slipped under the ring `ensureGround`
  // fetches on is prisms vanishing from under a player's feet, with no error and
  // no frame that shows it. See `world/tile-lifecycle.ts`.
  const lifecycleFailures = timed('tile-lifecycle', () => verifyTileLifecycle());
  // And the night rig, which earns its place on this list twice over.
  //
  // Every other check here guards something that *renders wrongly*. This one
  // also guards something that renders correctly and **stutters**: the set of
  // lights in the scene is part of every WebGPU material's cache key, so a light
  // that gets hidden rather than dimmed, or added rather than pre-created,
  // recompiles every pipeline in the scene in the middle of play -- which
  // presents as "the game hitches sometimes" and would never be traced to a
  // lighting file. `verifyNightLights` builds a throwaway rig and asserts the
  // count, the never-hidden flag and the no-shadow flag on the real objects.
  //
  // The rest of it is the usual criterion. A dusk ramp that snaps, a torch that
  // shakes like a fault rather than like a hand, a ground pool wound face-down
  // and therefore invisible, a lamp hash that clumps every luminaire in the city
  // onto one street -- all of them draw something plausible and none of them
  // throws. See `world/nightlights.ts`.
  const nightFailures = timed('night-lights', () => verifyNightLights());
  // Once, at `debug` so it is out of the way, and slowest-first because the only
  // question anyone asks of this line is which one it was.
  checkMs.sort((a, b) => b[1] - a[1]);
  console.debug(
    `[boot] self-checks ${(performance.now() - checkStart).toFixed(1)} ms  ` +
      checkMs.map(([name, ms]) => `${name} ${ms.toFixed(1)}`).join(', '),
  );
  if (
    sunFailures.length ||
    moveFailures.length ||
    animFailures.length ||
    rigFailures.length ||
    batFailures.length ||
    combatFailures.length ||
    powerupFailures.length ||
    footyFailures.length ||
    footyBallFailures.length ||
    netFailures.length ||
    clientFailures.length ||
    nameFailures.length ||
    locatorFailures.length ||
    trafficFailures.length ||
    wadingFailures.length ||
    waterFailures.length ||
    cdnFailures.length ||
    spawnFailures.length ||
    bikeFailures.length ||
    bikeMeshFailures.length ||
    bikeGlowFailures.length ||
    pedFailures.length ||
    pedModelFailures.length ||
    policeFailures.length ||
    streetFailures.length ||
    wildlifeFailures.length ||
    nameplateFailures.length ||
    guardFailures.length ||
    hudFailures.length ||
    wallFailures.length ||
    lifecycleFailures.length ||
    nightFailures.length ||
    chatFailures.length ||
    chatBoxFailures.length ||
    unstuckFailures.length ||
    suggestionFailures.length
  ) {
    hud.fatal(
      'Self-checks failed:\n' +
        [
          ...sunFailures,
          ...moveFailures,
          ...animFailures,
          ...rigFailures,
          ...batFailures,
          ...combatFailures,
          ...powerupFailures,
          ...footyFailures,
          ...footyBallFailures,
          ...netFailures,
          ...clientFailures,
          ...nameFailures,
          ...locatorFailures,
          ...trafficFailures,
          ...wadingFailures,
          ...waterFailures,
          ...cdnFailures,
          ...spawnFailures,
          ...bikeFailures,
          ...bikeMeshFailures,
          ...bikeGlowFailures,
          ...pedFailures,
          ...pedModelFailures,
          ...policeFailures,
          ...streetFailures,
          ...wildlifeFailures,
          ...nameplateFailures,
          ...guardFailures,
          ...hudFailures,
          ...wallFailures,
          ...lifecycleFailures,
          ...nightFailures,
          ...chatFailures,
          ...chatBoxFailures,
          ...unstuckFailures,
          ...suggestionFailures,
        ]
          .map((f) => '  - ' + f)
          .join('\n'),
    );
    return;
  }

  if (!navigator.gpu) {
    hud.fatal(
      'WebGPU is not available in this browser.\n' +
        'Safari 26 on Tahoe and current Chrome both support it; a WebGL2 fallback is possible but untested.',
    );
    return;
  }

  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ canvas, antialias: true });
  // Spec section 1: 2560x1440 is 3.7 M pixels and a real fill-rate load. Degrade
  // resolution before draw distance or facade quality, so this starts at 0.75.
  let renderScale = 0.75;
  renderer.shadowMap.enabled = true;
  // Stated rather than left to the default, because the choice is load-bearing
  // and the default is not obviously the right one.
  //
  // Three's WebGPU path offers four filters. `BasicShadowMap` is one unfiltered
  // compare and gives a hard stair-stepped edge. `VSMShadowMap` blurs a variance
  // map, which costs two extra full-resolution passes and leaks a bright halo
  // out of every corner -- exactly the look spec 7.1 rules out. `PCFSoftShadowMap`
  // gathers 4x4 and is a genuinely soft edge, which is a European overcast cue.
  // `PCFShadowMap` takes five Vogel-disk taps rotated per pixel by interleaved
  // gradient noise, each with hardware 2x2 PCF under it: a crisp edge with about
  // a texel of penumbra and no banding. That is a Sydney 3 pm shadow.
  //
  // THE PER-PIXEL ROTATION DID READ AS GRAIN, and this is the one-line swap the
  // paragraph above promised. It is worth writing down why, because "crisp edge,
  // no banding" was a fair description of a *still frame* and the complaint that
  // produced this was about walking.
  //
  // `ShadowFilterNode.PCFShadowFilter` rotates its Vogel disk by
  // `interleavedGradientNoise(screenCoordinate.xy)` -- noise in **screen space**,
  // with no temporal component and no world-space anchor. Stand still and it is
  // a fixed dither along the edge, which is exactly the intended trade. Walk,
  // and every world point slides across screen pixels, so the phase it is
  // filtered with is fresh every frame: the five taps land somewhere new, the
  // estimate moves a few percent, and a few percent of a Sydney sun-to-shade
  // step is several code values crawling along every shadow edge in the frame.
  // That is a temporal artefact the shadow-volume texel snap in `sky.ts` cannot
  // touch -- the snap makes the map itself world-stable, and this noise is
  // downstream of it, in the sampling.
  //
  // `PCFSoftShadowFilter` has no noise in it at all: four `textureGather`s on a
  // fixed 3x3 footprint, bilinearly weighted by the sub-texel position. Same
  // pixel, same answer, every frame, from every camera position -- temporally
  // stable by construction. And the "genuinely soft edge" it was rejected for is
  // not actually softer here: the gather footprint is about two texels, which is
  // 21 cm over this 4096 map on a 440 m volume and the same width the five-tap
  // disc at `radius = 1` was already producing. The sun's own penumbra is 19 cm
  // at 20 m of throw, so both are within a texel of physical.
  //
  // The cost is the knob: `sun.shadow.radius` is inert under this filter,
  // because the spread is locked to the texel grid. If the map size is ever
  // dropped for frame rate the penumbra widens with it rather than staying put,
  // which is the wrong direction but a small one. `PCFShadowMap` is the one-line
  // revert if the grain turns out to have been the lesser evil.
  renderer.shadowMap.type = PCFSoftShadowMap;
  // Khronos PBR Neutral, and the choice was measured rather than argued.
  //
  // All three candidates were evaluated by running this exact light rig, the
  // Preetham dome and each of three's tone curves through the same arithmetic
  // offline at 3 pm on 15 February, and reading off the sRGB values:
  //
  //                    zenith sky      sunlit sandstone   red brick    asphalt/shade
  //   ACESFilmic    rgb(168,207,239)   rgb(222,212,190)  rgb(184,115,96)  rgb(29,43,61)
  //   AgX           rgb(152,189,225)   rgb(197,186,168)  rgb(167,120,107) rgb(48,65,83)
  //   Neutral       rgb(114,166,249)   rgb(232,208,163)  rgb(161, 91,72)  rgb(15,38,59)
  //
  // All three rows are against the rig as it stood *before* the bounce light in
  // `calibration.ts`, and they are left that way on purpose: this is a comparison
  // between tone curves, so it is only meaningful with everything else held. The
  // shade column has since moved -- Neutral now puts shaded asphalt at
  // rgb(24, 40, 59) and shaded red brick at rgb(95, 40, 17) -- and the conclusion
  // is unchanged, because what decides it is hue retention and the absence of a
  // toe, neither of which is a function of the rig.
  //
  // Two spec requirements decide it, and they point the same way. 7.1 wants a
  // hard blue sky: ACES and AgX both desaturate saturated brights toward white
  // on the way up, so the zenith goes pale exactly as the exposure rises far
  // enough to blow out a footpath. 7.3 says Hawkesbury sandstone is warm
  // buff-honey and **not grey**: ACES renders it with 32 code values between
  // red and blue, Neutral with 69 -- the same albedo, and only one of them is
  // honey. Neutral holds hue because it compresses a single peak and rescales
  // the triple, rather than passing the colour through a desaturating matrix.
  //
  // The shadow end agrees. Neutral has no toe, so darks pass through linearly
  // and stay deep; AgX deliberately lifts them, which is the exact opposite of
  // "deep shadows"; ACES sits between. Neutral's cost is that it will not clip
  // hard -- it asymptotes to white -- so the genuinely blown parts of the frame
  // are the specular sheen on galvanised steel and glass, and the sky beside
  // the sun, rather than flat diffuse walls. That is the right set of things.
  //
  // For the record on what was replaced: under ACES at 0.86 the six surfaces
  // that should have spanned the top two stops -- cream brick, sandstone,
  // painted render, fibro, galvanised roof and concrete footpath, reflectances
  // from 0.41 to 0.81 -- all tone mapped into the band 162 to 177. That is what
  // "murky" was, and it was as much the tone curve as the exposure.
  renderer.toneMapping = NeutralToneMapping;
  // Lower than the old 0.86 and yet twice as bright, because three divides by
  // 0.6 inside ACES and does not inside Neutral. Pinned by the sky: see the
  // reasoning where it is defined.
  renderer.toneMappingExposure = EXPOSURE;
  await renderer.init();

  /**
   * Intercept the one call in three that has crashed this client three times.
   *
   * Installed here and not earlier because `renderer._textures` does not exist
   * until `init()` has resolved -- it is built inside that promise. See
   * `world/texture-audit.ts` for why this is an interception rather than a
   * fourth widening of the search: the scene audit is comprehensive over
   * everything reachable from `scene` and came back empty while the renderer
   * went on throwing, which puts the offender somewhere no traversal reaches.
   * Every texture three uploads goes through `Textures.updateTexture`, whatever
   * its origin, so wrapping it catches the fault for all of them and -- the
   * part three rounds of searching could not deliver -- names the object.
   *
   * It cannot stop the game: a three that renamed the internals makes this a
   * logged no-op and leaves `renderGuard` as the net it already was.
   */
  const shimStatus = installTextureShim(renderer, hud);
  console.debug(`[boot] texture uploader shim: ${shimStatus}`);

  const scene = new Scene();
  // The field of view is `game/feedback.ts`'s to move, not this file's: spec
  // 8.3's Flat White raises it to 80 for the duration and eases it back, so the
  // base lives beside the boosted value and the ease that connects them rather
  // than as a literal here that the two would have to agree with.
  const camera = new PerspectiveCamera(FOV_BASE, 16 / 9, 0.1, 24000);

  const sky = new SydneySky(scene, { latitude: -33.87, longitude: 151.21 });
  // Aerial perspective. Sydney's air is clear, so this is a weak fog whose only
  // job is to keep the far suburbs from reading as cut-outs.
  //
  // Two changes from the previous values. The colour is much paler: fog stands
  // in for the sky behind the thing it is fading, and the low sky at 3 pm tone
  // maps to around rgb(200, 233, 254), where the old 0x9fbcd6 came out at
  // rgb(116, 142, 165) under the new exposure -- a mid blue-grey that would have
  // *darkened* the mid-distance instead of hazing it. A `Fog` colour is capped
  // at 1.0 linear so it cannot reach the horizon band's brightness; this gets as
  // close as the cap allows while keeping a blue bias.
  //
  // The distances are pulled in because WebGPU's range fog is
  // `smoothstep(near, far, viewZ)`, not the linear ramp `Fog` implies, and the
  // old 900/14000 produced 1.4% at the streaming radius -- no aerial perspective
  // at all. 500/9000 gives 1.4% at 1 km and 7% at 1.8 km where the last
  // buildings are, which is subtle at 1-2 km as clear air should be, then closes
  // over the ground plane by 9 km so it does not end in a hard edge.
  scene.fog = new Fog(0xd8e8fa, 500, 9000);

  // Surface GPU validation failures on screen. An invalid texture or bind group
  // makes the renderer submit no command buffers at all, which looks exactly like
  // "the world did not load" -- a black screen with the HUD still updating, and
  // nothing but validation spam in a console the player will never open.
  const device = (renderer.backend as unknown as { device?: GPUDevice }).device;
  if (device) {
    device.addEventListener('uncapturederror', (event) => {
      hud.gpuError((event as GPUUncapturedErrorEvent).error.message);
    });
    // Guard the one limit this project is likely to exceed. The facade parameter
    // atlas is sized against it, so a mismatch should say so plainly.
    const atlasSize = atlasTextureSize();
    const maxDim = device.limits.maxTextureDimension2D;
    if (atlasSize.width > maxDim || atlasSize.height > maxDim) {
      hud.fatal(
        `Facade parameter atlas is ${atlasSize.width} x ${atlasSize.height}, but this ` +
          `GPU allows at most ${maxDim} in either dimension.\n` +
          `Reduce CAPACITY or raise ROW_TEXELS in src/world/params-atlas.ts.`,
      );
      return;
    }
  }

  /**
   * The night: the player's torch, the four real street-lamp lights, and the
   * traffic's headlights.
   *
   * Constructed **here**, immediately after the sky and a long way above
   * anything that uses it, and that position is load-bearing rather than
   * tidiness. Three's WebGPU backend folds the set of lights on the render list
   * into every material's cache key, so a light that appears after
   * `warmUpPipelines` has run recompiles every pipeline in the scene on the
   * frame it appears. All five of these are in the scene before the streamer
   * builds a single material, which is what makes the warm-up's compile count
   * the *whole* compile count for the session -- day and night.
   *
   * `world/nightlights.ts` carries the full argument, including why the lamps
   * are moved and faded rather than added and removed, and why nothing here
   * casts a shadow.
   */
  const nightLights = new NightLights(scene);

  const globals = createFacadeGlobals();
  // The streamer needs the shadow volume's size to decide which tiles cast into
  // it and which can catch anything, so it is taken from the sky rather than
  // written down twice.
  const streamer = new TileStreamer(scene, globals, {
    loadRadius: 1800,
    shadowRadius: sky.shadowRadius,
  });

  let index: WorldIndex;
  try {
    index = await streamer.loadIndex();
  } catch (err) {
    hud.fatal(String(err instanceof Error ? err.message : err));
    return;
  }

  // The one self-check that cannot run with the twelve above it, because it is a
  // check on the *world* rather than on this client's own arithmetic and the
  // world has only just arrived. It guards the same class of failure they do:
  // a material list that has drifted paints the Opera House's shells in bridge
  // steel, a lost dimension turns a 309 m tower into a 30 m one, and a sea level
  // the manifest disagrees with puts the bridge deck 70 m over the harbour --
  // where it still looks like a bridge. See `world/landmarks.ts`.
  // The traffic clock, against the world that was actually served. The synthetic
  // half of `verifyTraffic` already ran at boot; this is the half that needs a
  // file, and it is the one with no picture at all -- a build whose epoch or
  // tick rate disagrees with the baked timetables puts every car in Sydney
  // somewhere perfectly plausible and completely wrong.
  const trafficContractFailures = verifyTraffic(undefined, index.lanes ?? null);
  if (trafficContractFailures.length) {
    hud.fatal(
      'Traffic self-checks failed:\n' + trafficContractFailures.map((f) => '  - ' + f).join('\n'),
    );
    return;
  }

  // And the footpath widths, out of the same block and for the identical reason.
  // The ways block is a centreline and two widths; a build whose kerb differs
  // from this client's puts every pedestrian in the city a few centimetres into
  // the traffic, which renders exactly as well as the correct version.
  const pedContractFailures = verifyPedestrians(undefined, index.lanes ?? null);
  if (pedContractFailures.length) {
    hud.fatal(
      'Pedestrian self-checks failed:\n' + pedContractFailures.map((f) => '  - ' + f).join('\n'),
    );
    return;
  }

  const landmarkFailures = verifyLandmarks(index.landmarks, index.terrain?.sea_level_y);
  if (landmarkFailures.length) {
    hud.fatal(
      'Landmark self-checks failed:\n' + landmarkFailures.map((f) => '  - ' + f).join('\n'),
    );
    return;
  }

  /**
   * The development handle, published **here** rather than at the end of `main`.
   *
   * Everything below this line waits on the network — the far layer, the ground
   * under the spawn, and now a WebSocket handshake — and every one of those
   * waits used to sit between "the renderer works" and "the page admits it
   * does". A single stalled fetch therefore presented as a permanently black
   * loading screen with no console, no `window.sydney` and nothing to ask, which
   * is the least diagnosable failure this client can produce and is exactly the
   * one that turned up in a real browser tab.
   *
   * So the object is created empty-ish and `Object.assign`ed at the end. What it
   * buys is that from the moment the index parses there is always something to
   * type into a console: the renderer, the scene, the streamer, and `boot`,
   * which says which stage is outstanding. The alternative — a `sydney` that
   * only exists once everything succeeded — is a handle that is present exactly
   * when it is not needed.
   */
  const dev: Record<string, unknown> = {
    renderer,
    scene,
    camera,
    sky,
    streamer,
    index,
    /** Which boot stage is outstanding. `'ready'` once the loop is running. */
    boot: 'warming shaders',
  };
  (window as unknown as { sydney: unknown }).sydney = dev;

  // The streaming decode check, in dev only and deliberately not awaited.
  //
  // It reads one real tile and proves two things that cannot be read off the
  // source: that the purpose-built GLB reader on the decode thread agrees with
  // `GLTFLoader` attribute for attribute, and that a tile survives the worker
  // boundary unchanged. See `TileStreamer.verifyStreaming`.
  //
  // Not fatal, and not in the boot path. Every other check here guards something
  // that would render wrongly; this one guards something that renders *fine* and
  // costs a frame -- and holding up the loading screen for a tile fetch to find
  // that out would be the wrong trade even in dev.
  if (import.meta.env.DEV) {
    void streamer.verifyStreaming().then((failures) => {
      if (failures.length) {
        console.warn('[streaming] decode self-check failed:\n  - ' + failures.join('\n  - '));
      }
    });
  }

  // --- The three asset sets that are built here rather than where they are
  // used, and the reason is one line further down.
  //
  // `CharacterAssets`, `BatAssets` and `FootyAssets` are pure geometry: they
  // touch no network, read no index and depend on nothing above them, so *where*
  // they are constructed is free. What is not free is compiling their shaders
  // during the first fight, so they are built before the warm-up and the warm-up
  // takes their materials. Everything that actually uses them is still where it
  // was -- see the character and connection sections below.
  //
  // One geometry in seven kits and one material for the whole game; see
  // `player/character.ts` for why seven kits are seven vertex-colour buffers
  // rather than seven materials, and why nothing here is instanced.
  const characters = new CharacterAssets();
  /**
   * The crowd's far tier: three tiny box geometries and one material for every
   * pedestrian in the city.
   *
   * Built **here**, next to the characters and a long way above the field that
   * uses it, for the one reason everything else in this block is: the warm-up
   * below has to see its material, or the first person to walk into view
   * compiles a pipeline inside the frame they appear in. See `world/people.ts`.
   */
  const pedAssets = new PedestrianAssets();
  /**
   * The melee weapon, on exactly `CharacterAssets`'s terms: one geometry and one
   * material for every bat in the game, built here so its pipeline is compiled
   * by the warm-up below rather than on the frame the first fight starts.
   *
   * It is the one asset in this list that appears in **two** places at once --
   * in every character's right hand and, at 0.58 scale, in front of the local
   * player's own eye. Both are the same geometry and the same material, so the
   * second costs one more draw and no compiles at all.
   */
  const bats = new BatAssets();
  /**
   * The ranged weapon, on exactly the same terms as the bat: one geometry and
   * one material for every football in the game.
   *
   * It appears in **three** places at once -- in every character's off hand, in
   * front of the local player's own eye, and in the air -- and all three are the
   * same geometry and the same material, so the second and third cost one draw
   * each and no compiles at all.
   */
  const footies = new FootyAssets();
  /** Presentation for the balls in the air. One group for every throw in the world. */
  const footyPool = new FootyPool(footies);
  scene.add(footyPool.group);
  /**
   * The lime e-bikes, on exactly the same terms as the three above: one geometry
   * and one material for every bike in the city, built here so the warm-up gets
   * it rather than the frame somebody first rounds a corner and finds one.
   *
   * It appears in three places, all instanced and all the same pipeline: the
   * parked set, the one under the local rider, and one per riding remote.
   */
  const bikes = new BikeAssets();

  // --- Shader warm-up, and this is the one thing on the boot path that exists
  // purely because of how a real player described the game.
  //
  // "It ran buggy for the first couple of minutes and is now stable" is the
  // signature of lazy pipeline compilation: WebGPU compiles a pipeline the first
  // frame a given material, geometry layout and depth state is *drawn*, and this
  // world has thirty-odd materials that first appear over the first few minutes
  // of walking -- the first roof, the first awning, the first tree, the first
  // parked car, the first ibis, the first bin, the first shot fired. Each is one
  // synchronous compile on the main thread.
  //
  // So every one of them is compiled here instead, off the hot path, while the
  // loading screen is still up. `world/warmup.ts` carries the whole argument,
  // including the two non-obvious parts: that both `receiveShadow` variants are
  // separate pipelines, and that the depth-pass ones are only reachable through
  // the shadow render nested inside `compileAsync`.
  //
  // Bounded and allowed to fail, on the far layer's argument. A warm-up that
  // does not finish costs the first walk its hitches, which is what the player
  // already had; a warm-up that wedges the boot costs the whole game.
  //
  // Two throwaway characters, and that is not redundancy. `CharacterActor` builds every body
  // with `receiveShadow = true`, and `castShadowOnly` turns it off again for the
  // player's own -- which `character.ts` already notes is a second pipeline. So
  // a warm-up with one actor in it leaves the other variant to compile on the
  // frame the first other player walks into view, which is the worst frame in
  // the game to lose. Both are the same seven-kit geometry and the same
  // material; the cache key reads attribute layouts rather than contents, so one
  // colourway covers all of them.
  const warmupActors = [new CharacterActor(characters, 0), new CharacterActor(characters, 0)];
  warmupActors[0].mesh.receiveShadow = true;
  warmupActors[1].mesh.receiveShadow = false;
  const warmup = await withDeadline(
    warmUpPipelines(
      renderer,
      scene,
      camera,
      [
        ...streamer.warmupParts(),
        // The football, in the one material every one of them is drawn with.
        // `FootyPool` keeps its balls `visible = false` until somebody throws,
        // and `_projectObject` returns early on an invisible object -- so
        // without this the first throw of the session compiles a pipeline inside
        // the frame it is supposed to be the game's fastest feedback.
        ...footyWarmupParts(footies),
        // The bat, in both of the configurations it is ever drawn in: casting
        // into the sun's depth pass from a character's hand, and not casting as
        // the first-person viewmodel. `receives` is left at its default of both
        // ways for the reason `warmup.ts` gives about the streamer's tiles --
        // the viewmodel receives and the local player's own bat, which is on the
        // shadow layer, does not.
        { geometry: bats.geometry, material: bats.material, casts: true },
        // The bike. Instanced, casting, and the same material for the parked set
        // and the ridden one -- so this one entry covers every bike in the game.
        { geometry: bikes.geometry, material: bikes.material, casts: true },
        // The bike's glow disc and sky beam. Additive, never casting, both
        // instanced -- without these the first bike a player walks toward
        // compiles two pipelines in the frame the beacon exists to make them
        // look at.
        { geometry: bikes.glowGeometry, material: bikes.glowMaterial, casts: false, instanced: true },
        { geometry: bikes.beamGeometry, material: bikes.beamMaterial, casts: false, instanced: true },
        // The far tier of the crowd, which is instanced, per-instance coloured
        // and casting. One entry covers all six of its sets: they share the one
        // material, and `warmup.ts`'s cache key reads attribute *layouts* rather
        // than contents, so the torso's box stands in for the shorts' and the
        // shin's. Without it the first pedestrian to come into view compiles a
        // pipeline mid-frame -- and unlike the football's, that frame is not one
        // the player chose, it is whichever one they happen to walk into.
        { geometry: pedAssets.torso, material: pedAssets.material, casts: true, instanced: true },
        // The traffic's headlights and tail lights: two geometries over one
        // additive material, instanced, never in the depth pass in either
        // direction, and **never per-instance coloured** -- both sets have to
        // agree about that or they would be two pipelines rather than two draws
        // of one, because the presence of `instanceColor` is in the shader.
        //
        // Both are warmed for the reason the street lamps are warmed in
        // `streamer.warmupParts`: they are hidden every daylight hour, and a
        // hidden mesh is never drawn, so without these the pipeline would be
        // compiled on the single frame the sun goes down with a hundred and
        // eighty cars' worth of it arriving at once.
        ...nightLights.carLights.meshes.map((mesh) => ({
          geometry: mesh.geometry,
          material: nightLights.carLights.material,
          instanced: true,
          instanceColor: false,
          casts: false,
          receives: [false],
        })),
      ],
      // The characters, handed over whole because a skinned mesh cannot be
      // reduced to a geometry and a material: `RenderObject.getCacheKey` folds
      // the skeleton's bone count in, and the vertex path is the skinning one.
      warmupActors.map((a) => a.mesh),
    ),
    WARMUP_DEADLINE_MS,
    'the shader warm-up',
  );
  if (warmup) {
    console.debug(
      `[warmup] ${warmup.draws} draws in ${warmup.ms.toFixed(0)} ms  ` +
        `shaders ${warmup.programsBefore} -> ${warmup.programsAfter}, ` +
        `pipelines ${warmup.pipelinesBefore} -> ${warmup.pipelinesAfter}`,
    );
  }
  dev.warmup = warmup;
  dev.boot = 'far layer';

  // And the loading overlay goes now, on the same argument. It exists to cover
  // the gap before the renderer can draw, and the renderer can draw: the world
  // arrives tile by tile afterwards, which is what streaming *is*. Holding it up
  // until every await below has returned makes a slow network indistinguishable
  // from a broken build.
  //
  // The warm-up above is the one thing it *does* wait for, and that is the whole
  // point of it: a compile paid before the first frame is a compile not paid
  // during the first walk. It is bounded so this can never be the thing that
  // never returns.
  hud.ready(index, firstVisit());

  // --- Who is playing.
  //
  // Asked **here** and collected eight hundred lines below, which is the whole
  // shape of this: the prompt goes up on the frame the world becomes drawable
  // and the answer is not wanted until there is a socket to send it on, so the
  // typing happens over a city that is streaming in behind it rather than in
  // front of a black screen. `askName` is deliberately not awaited on this line.
  //
  // Online only. `?offline` is spec 9's local stub -- there is nobody to be
  // called anything *by*, the kill feed never runs, and a modal between a
  // developer and the punch they are working on would be the most annoying
  // thing in this file. The stored name is still read, so a session that starts
  // offline and is reloaded online does not ask twice for the same answer.
  const netUrl = resolveServerUrl();
  const storedName = loadName();
  const namePromise =
    netUrl === null ? Promise.resolve(storedName || sanitiseName(suggestName())) : hud.askName(storedName || sanitiseName(suggestName()));

  /**
   * Wait for something, but never for longer than `ms`.
   *
   * Every boot-time `await` on the network goes through this, and the reason is
   * a bug rather than a principle: `ensureGround` walks its tiles **in
   * sequence**, so one request that never answers stops the entire remainder of
   * `main` — the fighters are never built, the animation loop is never started,
   * and the page sits on the loading overlay indefinitely. Observed in a real
   * tab, stuck for over four minutes, while the tab was backgrounded and the
   * browser's six connections to the dev server were saturated.
   *
   * The important half is what happens when it loses. Nothing is retried here
   * and nothing is reported as an error, because the ground is **already
   * optional**: `groundHeightAt` answers an unloaded tile with the last height
   * it knew (see `lastGround`), and the render loop re-runs `ensureGround` every
   * half second forever. So the correct response to a slow fetch is to carry on
   * and let the world catch up, which is what streaming does everywhere else in
   * this client.
   */
  function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T | null> {
    return Promise.race([
      work.catch(() => null),
      new Promise<null>((resolve) =>
        setTimeout(() => {
          console.warn(`[sydney] ${what} did not finish in ${ms} ms; carrying on without it.`);
          resolve(null);
        }, ms),
      ),
    ]);
  }

  /** How long boot gives the ground before it proceeds anyway. See `withDeadline`. */
  const GROUND_DEADLINE_MS = 5000;
  /**
   * And the far layer, which is longer because it is 759 kB against a sidecar's
   * 1,156 bytes — on a cold cache over a slow link that is genuinely seconds,
   * where a `.terr.bin` that has not answered in five is not going to.
   */
  const FAR_LAYER_DEADLINE_MS = 15000;

  // The far layer: every significant building in the extent as one low-detail
  // convex prism, and the whole extent's ground as one coarse heightfield. This
  // is what puts the CBD on the horizon from Alexandria and what stops the world
  // ending in a hard edge at the streaming radius. It is fetched once, here,
  // rather than per tile -- it belongs to no tile, even though it arrives
  // grouped by them so the streamer can hide a tile's slabs when the tile lands.
  //
  // Awaited before the first frame deliberately. It is 759 kB against the
  // index's own request, and a city that fades in a second after the ground
  // does is worse than a slightly later first frame.
  //
  // Bounded, and allowed to fail. The far layer is 759 kB of horizon: losing it
  // costs the CBD skyline from Alexandria and a hard edge at the streaming
  // radius, where *waiting forever* for it costs the whole game. It could both
  // reject and hang, so it gets the deadline and a catch.
  const far =
    (await withDeadline(
      loadFarLayer(
        '/world',
        index.far,
        index.archetypes ?? [],
        streamer.terrain.sea_level_y,
        streamer.groundMaterial,
        streamer.assetVersion,
      ),
      FAR_LAYER_DEADLINE_MS,
      'the far layer',
    )) ?? ({ slabs: null, ground: null, count: 0 } as Awaited<ReturnType<typeof loadFarLayer>>);
  if (far.slabs) {
    scene.add(far.slabs);
    // And the streamer takes it from here. This is the whole of the far layer's
    // visibility rule: a tile's slabs draw exactly while the tile itself does
    // not, switched on the same event that adds and removes the real buildings.
    // See `world/far.ts`'s header and `TileStreamer.setFarCity`.
    streamer.setFarCity(far.slabs);
  }
  // The far ground *replaces* the flat far plane rather than joining it -- two
  // ground surfaces a metre apart at four kilometres is a depth fight across the
  // whole harbour, and `world/far.ts` carries that arithmetic. The plane is
  // still what a world built before the far layer existed gets, because an
  // index and a tile directory outlive any one pipeline run.
  scene.add(far.ground ?? createFarGround(streamer.terrain.sea_level_y, streamer.groundMaterial));

  // The harbour, at the scale the horizon needs it. It belongs to no tile for
  // the same reason the far ground does not -- most of Port Jackson earns no
  // tile at all, because a tile is emitted only where there is something to
  // stand on -- so this one file is what fills it, and it is what carries the
  // water past the streaming radius so the harbour reads from a lookout.
  //
  // It wears the streamer's own water material: one instance for every sheet in
  // the world, near and far, which is one pipeline and -- since the waves are a
  // function of world position and one clock -- one clock. Two would tear along
  // every tile boundary in the harbour.
  //
  // Bounded and allowed to fail like the far layer above it, on the same terms:
  // losing it costs the harbour beyond the streamed tiles, where waiting forever
  // for it costs the game.
  const farWater =
    (await withDeadline(
      loadFarWater('/world', index.water, streamer.waterMaterial, streamer.assetVersion),
      FAR_LAYER_DEADLINE_MS,
      'the far water',
    )) ?? [];
  for (const mesh of farWater) scene.add(mesh);

  // The three hero landmarks, on the far layer's terms and for a stronger
  // version of its reason. The far layer is a *stand-in* the streamer takes away
  // when the real building lands; these have no real building behind them and no
  // distance at which they should stop drawing, because they are the skyline --
  // the bridge from Alexandria, the tower from every ridge in the extent, the
  // Opera House from the whole harbour. So they are loaded once here, added to
  // the scene, and never touched again.
  //
  // Bounded and allowed to fail like everything else on this path: losing them
  // costs three landmarks, where waiting forever for them costs the game.
  const landmarks =
    (await withDeadline(
      loadLandmarks('/world', index.landmarks, streamer.assetVersion),
      FAR_LAYER_DEADLINE_MS,
      'the landmarks',
    )) ?? { group: null, triangles: 0, names: [] };
  if (landmarks.group) {
    scene.add(landmarks.group);
    // Their shaders, warmed here for the same reason the far city's are: they do
    // not exist until this fetch has landed, and the warm-up pass ran long
    // before it. Six pipelines, and two of them (the shells and the gold) are
    // the only place in the world with a low-roughness lit surface at scale --
    // exactly the compile a player would otherwise pay for on their first look
    // at the harbour.
    await withDeadline(
      renderer.compileAsync(landmarks.group, camera, scene),
      WARMUP_DEADLINE_MS,
      'the landmark shaders',
    );
    console.debug(
      `[landmarks] ${landmarks.names.join(', ')} -- ${landmarks.triangles.toLocaleString()} triangles`,
    );
  }

  // The far city's own shader, warmed here and not with the rest of them for one
  // reason: it does not exist until this fetch has landed, and the pass above
  // runs before any of it. It is one pipeline -- the slabs are unlit and are in
  // neither half of the shadow pass -- and the far ground beside it wears the
  // streamer's ground material, which was warmed with the terrain.
  //
  // The three-argument form is exactly what it is for: the object is already in
  // the scene, and naming the scene as the target is what makes the cache key
  // the one `render` will look up, without re-walking the city to find it.
  if (far.slabs) {
    // Culling is cleared across every tile mesh rather than on the group, and
    // that is a real difference now the far city is 192 meshes instead of one:
    // `compileAsync` runs the same per-object frustum test `render` does, so a
    // culled mesh compiles nothing and the group's own flag is never consulted.
    // One material and one attribute layout across all of them, so this is still
    // a single pipeline -- the walk is what has to reach it.
    far.slabs.setFrustumCulled(false);
    await withDeadline(
      renderer.compileAsync(far.slabs, camera, scene),
      WARMUP_DEADLINE_MS,
      'the far-layer shader',
    );
    far.slabs.setFrustumCulled(true);
  }

  // --- Collision and ground
  //
  // Both on the same radius and in the same pass. Collision prisms and terrain
  // grids answer the two halves of one question -- how high is the world under
  // the player -- and the player reaches further than the renderer does: the
  // streamer loads and evicts on the camera's frustum, and ground you have
  // turned your back on is still ground you are standing on.
  const collision = new CollisionWorld();
  const collisionPending = new Set<string>();

  // What an ibis spawn is checked against, expressed as two predicates so that
  // `world/birds.ts` never has to import the collision format -- see
  // `SpawnGuard`. "Solid" is `roofHeight` asking a slightly different question
  // than usual: it returns the top of any prism whose footprint contains the
  // point, so a roof more than a bird's height above the bird's feet means the
  // bird is standing inside the building rather than beside it.
  streamer.setSpawnGuard({
    ready: (key) => collision.hasTile(key),
    solid: (x, y, z) => collision.roofHeight(x, z, y) > y + 0.4,
  });

  // And the same world again, as the streamer's collision *lifetime* handle.
  //
  // Two facts and no questions -- whether a tile's prisms are resident, and the
  // ability to take them away -- which is exactly what pairs the two halves of
  // a tile that this file and the streamer load on two different radii. Without
  // it collision accumulated for the session while geometry was evicted past
  // 1,800 m, so every return trip found tiles that stop the player and draw
  // nothing: 676 walls across 6 tiles, measured, every lap, with no network
  // fault in it. See `TileStreamer.setCollisionSink`, which also explains why
  // the streamer refuses to drop prisms anywhere near the player whatever the
  // renderer is doing.
  streamer.setCollisionSink(collision);

  // Spec 8.3's powerups. The field owns every point the client has ever seen and
  // outlives the tiles they arrived on, which is what makes a 90 s station
  // respawn survive walking around the block -- see `game/powerups.ts`. The
  // streamer only ever hands it coordinates; every gameplay decision about them
  // is made in `simulate` below, on the fixed step, with the punch.
  const powerups = new PowerupField();
  streamer.setPowerupSink(powerups);

  // The traffic. Two objects and no lifecycle: the field is told about a tile's
  // routes as it streams in and forgets them as it leaves, and the movers are
  // one instanced set for the whole visible world that is refilled every frame.
  //
  // Neither holds any *state*. A car's position is a pure function of wall-clock
  // time evaluated against baked timetables (see `game/traffic.ts`), so there is
  // nothing here that can drift, nothing to synchronise across an eviction, and
  // nothing on the wire -- every player in the session is watching the same six
  // thousand cars because they are all reading the same clock and the same
  // bytes, not because anybody is telling anybody anything.
  //
  // The movers are added to the **scene**, not to a tile group, and are the only
  // instanced set in this project that is: a car crosses a tile boundary every
  // few seconds. See `TrafficMovers` for the float32 argument that allows it.
  const traffic = new TrafficField();
  streamer.setTrafficField(traffic);
  const trafficMovers = new TrafficMovers(streamer.cars);
  for (const mesh of trafficMovers.meshes) scene.add(mesh);
  // Where the headlights go. The traffic already computes a pose for every car
  // in view every frame and the night rig has to draw its lights at exactly
  // those poses, so the sink is fed from inside that one loop rather than from a
  // second pass that would have to agree with it. By day `begin()` returns false
  // and the whole thing is one comparison per frame. See `world/cars.ts`.
  trafficMovers.lights = nightLights.carLights;
  /** Scratch for the per-tick hit query, so a fixed step allocates nothing. */
  const carRoutes: LaneRoute[] = [];
  const carPose: CarPose = createCarPose();
  /**
   * How many times a car has knocked somebody over this session, and when the
   * last one was. Diagnostics only, and the only observable this feature has:
   * a car is a lookup rather than an object, so there is nothing in the scene
   * graph and nothing in a snapshot to inspect when someone reports that the
   * traffic "does not do anything". See `sydney.trafficReport`.
   */
  const carHits = { count: 0, lastTick: -1 };

  // The pedestrians, on exactly the traffic's terms and out of exactly the same
  // sidecar -- the routes block drives the cars and the ways block is where the
  // footpaths come from. Two objects and no lifecycle, no state that survives a
  // frame, and not one byte on the wire; `game/pedestrians.ts` argues the whole
  // of that and `tiles.write_lanes` is where the data contract is written down.
  //
  // The crowd is added to the **scene** for `TrafficMovers`' reason, and it is
  // two things rather than one: six instanced sets for the far tier, and
  // fourteen real `CharacterActor` bodies for the near one. The rigs are the
  // same class, the same geometry and the same clips as the player and the
  // dummies -- there is no second character system here, which is the whole
  // reason a pedestrian can be batted through the code path a player is.
  const pedestrians = new PedestrianField();
  streamer.setPedestrianField(pedestrians);
  const crowd = new PedestrianCrowd(pedAssets, characters);
  for (const mesh of crowd.meshes) scene.add(mesh);
  for (const rig of crowd.rigs) scene.add(rig.mesh);
  /** Scratch for the per-tick strike queries, so a fixed step allocates nothing. */
  const pedBands: PedBand[] = [];
  const pedPose: PedPose = createPedPose();

  // --- The police.
  //
  // Two objects and no third: `factions.FactionField` is the *simulation*, and
  // offline it is the authority -- `simulate` steps it exactly as `server/sim.ts`
  // does, through the same file. Online it stays empty and the squad below draws
  // out of `net.actors` instead, which is a mirror the server fills. The renderer
  // cannot tell which, and that is the whole point of the arrangement: `?offline`
  // is a real test of this feature rather than a stub of it.
  //
  // Officers on a *beat* are not in either -- they are a deterministic function
  // of the tick evaluated identically on both ends, so they cost no bytes and
  // exist in both modes without anybody sending anything. See
  // `factions.POLICE_SLOT_BASE`, which is the trick that makes it free.
  const policeAssets = new PoliceAssets(characters);
  const policeKitFailures = verifyPoliceKit(policeAssets);
  if (policeKitFailures.length) {
    hud.fatal('Police kit self-checks failed:\n' + policeKitFailures.map((f) => '  - ' + f).join('\n'));
    return;
  }
  const squad = new PoliceSquad(policeAssets, characters);
  for (const rig of squad.rigs) scene.add(rig.mesh);

  // --- And the street factions, on exactly the same two tiers.
  //
  // The ambient tier here is not the pedestrian schedule -- a loiterer is not
  // going anywhere, so `game/streetlife.ts` places its own people *on* the bands
  // instead of *through* them -- but it is the same bargain: a pure function of
  // the anchor and the tick, evaluated identically by this browser and the
  // server, costing nothing on the wire and existing in both modes.
  const streetAssets = new StreetlifeAssets(characters);
  const streetKitFailures = verifyStreetlifeKit(streetAssets);
  if (streetKitFailures.length) {
    hud.fatal('Street kit self-checks failed:\n' + streetKitFailures.map((f) => '  - ' + f).join('\n'));
    return;
  }
  const streetCrowd = new StreetCrowd(streetAssets, characters);
  for (const rig of streetCrowd.rigs) scene.add(rig.mesh);

  // --- And the wildlife, which is the same two tiers with no rig at all.
  //
  // A bird is 30 cm across and is never close enough for a skeleton to be worth
  // anything, so the whole flock is five `InstancedMesh`es driven off one matrix
  // each -- the finding `world/birds.ts` already made about its own ibises. The
  // ambient tier is a hash over the baked park discs and the footpath bands, so
  // like the beats and the loiterers it costs nothing on the wire and exists
  // identically in both modes.
  const wildlifeAssets = new WildlifeAssets();
  const wildlifeKitFailures = verifyWildlifeKit(wildlifeAssets);
  if (wildlifeKitFailures.length) {
    hud.fatal('Wildlife kit self-checks failed:\n' + wildlifeKitFailures.map((f) => '  - ' + f).join('\n'));
    return;
  }
  const flock = new WildlifeFlock(wildlifeAssets);
  for (const mesh of flock.meshes) scene.add(mesh);
  /** Scratch for the wildlife queries, so a fixed step and a frame both allocate nothing. */
  const wildScratch = createWildScratch();
  const wildPose = createWildPose();

  const tracers = new Tracers();
  for (const mesh of tracers.meshes) scene.add(mesh);
  /** The offline authority. Empty and unstepped while a server is answering. */
  const factions = new FactionField();
  /** Scratch for the witness queries, so a fixed step allocates nothing. */
  const witnessCtx = {
    peds: pedestrians,
    collision,
    field: factions,
    bands: [] as PedBand[],
    ped: createPedPose(),
    beat: createBeatPose(),
  };
  const witness = createWitness();
  /**
   * What the banner is currently saying, offline and online alike.
   *
   * A single record read by the frame loop rather than two branches, so the HUD
   * call site has no idea whether the truth came off a socket or out of the
   * local field. Filled from `net.investigation` online and from `factions`
   * offline; see `investigationNow`.
   */
  const investigationView = { reason: 0, seconds: 0 };
  /**
   * Which promoted officers were firing last frame, so a shot is heard once.
   *
   * `NPC_STATE.FIRE` is held for exactly one snapshot period -- see
   * `factions.FIRE_STATE_TICKS` -- so every shot is carried by exactly one
   * snapshot and this is the rising edge of it. A client that played the crack
   * on the *level* would fire three times a shot offline, where the state is
   * read every frame at 60 Hz rather than sampled at 20.
   */
  const firing = new Set<number>();
  /**
   * What state every live bird was in last frame, so a call is heard once.
   *
   * A map rather than the `firing` set above it because wildlife has four
   * audible transitions rather than one, and because a bird's voice is tied to
   * *entering* a state -- the gobble is the decision to charge, not the charge.
   * Pruned against `wildSeen` every frame so a resolved bird does not sit in it
   * for the session; both are reused, so the whole arrangement allocates
   * nothing after the first bird.
   */
  const wildStates = new Map<number, number>();
  const wildSeen = new Set<number>();
  /** Shots heard and officers drawn this session. Diagnostics; see the HUD's `police` line. */
  const policeStats = { shots: 0 };
  /** Whether the player was riding tuned in front of police last tick. The ride-by's edge. */
  let seenRiding = false;
  /**
   * Officers currently drawn aiming at this player, so the bark is heard once.
   *
   * The online counterpart of the offline `aggro` event, and the reason there is
   * no aggro event on the wire: an officer who has just entered `NPC_STATE.AIM`
   * is an officer who has just shouted, which an idempotent state byte already
   * says. A reliable message for it would be a second way to say the same thing.
   */
  const aiming = new Set<number>();
  /**
   * And the street factions' equivalent: who is currently drawn charging, so an
   * aggro line is heard once. `NPC_STATE.CHASE` is their `AIM`.
   */
  const charging = new Set<number>();

  /**
   * Where the promoted officers are: the server's list online, this process's
   * own offline.
   *
   * One function rather than a branch at four call sites, and the shape is the
   * same either way -- `net.actors` is a `Map` of `factions.NpcActor` and
   * `FactionField.actors` is an array of them, so both satisfy the
   * `{ actors: Iterable<NpcActor> }` every consumer here wants. There is no
   * adapter and no second record type, which is what lets the witness query, the
   * hit test and the renderer all be written once.
   */
  function policeField(): { actors: Iterable<NpcActor> } {
    return net ? { actors: net.actors.values() } : factions;
  }

  /**
   * Open the banner for a crime this client believes it just committed.
   *
   * Online it is a *prediction* and the server's next `MSG.INVESTIGATION`
   * replaces it. Offline this client is the authority and the same call opens
   * the real thing, through `FactionField.accuse` -- the same function
   * `server/sim.ts` calls, so the countdown, the stacking and the cap are one
   * implementation rather than two that agree by inspection.
   */
  function accuse(x: number, z: number, reason: number, tick: number, alreadyWitnessed = false): void {
    if (!alreadyWitnessed) {
      const w = policeWitness(x, z, tick, witnessCtx, witness);
      if (!w.seen) return;
    }
    if (net) net.predictInvestigation(reason, COUNTDOWN_TICKS);
    else factions.accuse(playerCombat.id, reason, tick);
  }

  /** A crime that needs no witness -- assaulting police. See `accuse`. */
  function predictInvestigation(reason: number): void {
    if (net) net.predictInvestigation(reason, COUNTDOWN_TICKS);
    else factions.accuse(playerCombat.id, reason, trafficTick(Date.now()));
  }

  /**
   * The context an offline `think` is handed. Rebuilt per tick for the two
   * members that genuinely change -- the tick and the combatant list.
   *
   * `damagePlayer` is the interesting member and it is why the context exists at
   * all: the server's implementation emits a `HIT`, credits a down and clears
   * the investigation, and this one plays the feedback and lowers the same
   * `health` field. Two authorities, one `think`, and nothing in
   * `game/factions.ts` knows which it is running under.
   */
  function offlineFactionCtx(tick: number, dt: number): FactionCtx {
    return {
      tick,
      dt,
      collision,
      groundHeight: groundHeightAt,
      peds: pedestrians,
      combatants,
      field: factions,
      investigationOf: (id) => factions.investigationOf(id),
      damagePlayer: (id, pips, actor) => {
        if (id !== playerCombat.id) return;
        if (playerCombat.phase === 'ko' || playerCombat.health <= 0) return;
        playerCombat.health = Math.max(0, playerCombat.health - pips);
        if (playerCombat.health <= 0) {
          // The knockout, on `combat.applyHit`'s own terms but with no puncher:
          // the phase, the clock and the respawn are the shared machine's, so
          // the animation byte, the movement lock and the respawn sweep all keep
          // working with no change. `server/sim.shoot` does the identical thing.
          playerCombat.phase = 'ko';
          playerCombat.phaseT = 0;
          playerCombat.koT = 0;
          playerCombat.respawnT = KO_SECONDS;
          playerCombat.ridingBike = 0;
          factions.clearInvestigation(playerCombat.id);
          seenRiding = false;
          feedback.knockedOut();
          // The line comes from the faction that did it rather than from here,
          // through `NpcKindDef.feedKo` -- "you got done by the cops", "you got
          // rolled by a meth head". One template per kind, declared beside the
          // kind, so a faction that lands after this one reads correctly on the
          // day it lands and nothing in this file has to know it exists.
          //
          // Online the same knockout arrives as an `EVENT.HIT` whose attacker is
          // its own victim, which is the "the world did this" sentinel a car
          // already uses, and the feed says "got run down" for all of them. That
          // is a property of the wire carrying no cause and is left alone here:
          // inventing a cause byte for a kill feed would be a protocol change
          // for a line of text.
          const def = actor ? npcKind(actor.kind) : undefined;
          pushKill(def ? feedLine(def.feedKo, 'you') : 'you got done by the cops');
        } else {
          feedback.hitTaken();
        }
      },
      emit: (e) => factions.events.push(e),
    };
  }
  /**
   * How many bystanders have been knocked over this session. Diagnostics only,
   * and the same argument `carHits` makes: a pedestrian is a lookup rather than
   * an object, so there is nothing in the scene graph and nothing in a snapshot
   * to inspect when somebody reports that the crowd "does not react".
   */
  const pedHits = { count: 0, lastTick: -1 };

  async function ensureGround(px: number, pz: number): Promise<void> {
    const terrain = streamer.ground;
    for (const entry of index.tiles) {
      const dx = Math.max(entry.bounds[0] - px, 0, px - entry.bounds[2]);
      const dz = Math.max(entry.bounds[1] - pz, 0, pz - entry.bounds[3]);
      if (Math.hypot(dx, dz) > COLLISION_RADIUS) continue;

      // Terrain first, and awaited: it is the floor, where the prisms are only
      // the things standing on it. `TerrainField` holds grids for the whole
      // session and de-duplicates in-flight requests, so calling this for a tile
      // the streamer already fetched costs nothing.
      if (terrain) await terrain.ensure(entry.key);

      if (collision.hasTile(entry.key) || collisionPending.has(entry.key)) continue;
      collisionPending.add(entry.key);
      try {
        // Abandoned after eight seconds, on `TerrainField.ensure`'s argument and
        // for the same reason: this loop is sequential, so one request that
        // never answers is every tile after it never loading. `AbortSignal`
        // rather than a racing timer, so the connection is released for the next
        // one instead of being held by a request nobody is waiting on.
        // Versioned like every other world asset -- see `world/version.ts`. The
        // suffix is the streamer's, because the index it came from is the
        // streamer's, and two sources for one build stamp is one too many.
        const resp = await fetchWorldAsset(
          '/world',
          `collision/${entry.key}.bin`,
          streamer.assetVersion,
          { signal: AbortSignal.timeout(COLLISION_FETCH_TIMEOUT_MS) },
        );
        if (resp.ok) {
          collision.addTile(
            entry.key,
            await resp.arrayBuffer(),
            entry.bounds[0],
            entry.bounds[1] + index.tile_size,
            // The index's own building count, which is what separates the
            // buildings in this payload from the deck, viaduct and landmark
            // volumes written ahead of them. Nothing in the collision answers
            // reads the distinction; `world/invisible-walls.ts` does. See
            // `CollisionWorld.addTile`.
            entry.b,
          );
        }
      } catch {
        // A tile without collision is walkable-through, which is survivable;
        // a thrown error here would stop the whole loop, which is not.
      } finally {
        collisionPending.delete(entry.key);
      }
    }
  }

  /**
   * How high the world is under a point, which is the higher of the ground and
   * whatever the player is standing on top of.
   *
   * `lastGround` is the answer to the one case neither source can cover: a tile
   * whose terrain has not arrived. Returning zero there would be a claim that
   * the ground is at the datum, which over most of the city is thirty or forty
   * metres up, and the player would be fired into the air the moment they
   * stepped across the boundary. Holding the last height they had walks them
   * across the gap instead, on ground that is at worst a few metres stale. It is
   * also what carries them over the harbour, where there is no tile at all and
   * never will be until something renders water.
   */
  let lastGround = 0;
  const groundHeightAt = (x: number, z: number, feetY: number): number => {
    const sampled = streamer.ground?.height(x, z) ?? NO_GROUND;
    if (Number.isFinite(sampled)) lastGround = sampled;
    // `roofHeight` returns -Infinity when the player is not standing on
    // anything, so the max falls through to the ground on its own.
    return Math.max(lastGround, collision.roofHeight(x, z, feetY));
  };

  /**
   * The ground a bird stands on. Terrain only, never a roof.
   *
   * `-Infinity` for the feet is `collision.roofHeight`'s "how high is the asker"
   * and it is the whole of the difference: a turkey is not standing on anything
   * but the park, and a query that folded in a roof would put one on top of the
   * pavilion the moment its cell overlapped the footprint. Hoisted to a `const`
   * rather than written at the call site because both callers are per frame or
   * per tick, and a fresh closure on either would be an allocation forever.
   */
  const wildGround = (x: number, z: number): number => groundHeightAt(x, z, -Infinity);

  // --- Player. Spawn in Sydney Park, dithered about 100 m -- `game/spawn.ts`
  // holds the pin, the rule that keeps the disc on built ground, and the reason
  // the centre is a search over `index.json` rather than a second coordinate.
  // The server computes the identical centre from the identical file, so an
  // offline boot and an online one start in the same field.
  const spawnDisc = spawnCentre(index);
  // Loaded before the player is placed, so the spawn lands on the ground rather
  // than on the datum and then falls to it -- but bounded, because "lands on the
  // datum and falls" is a second of comedy and "never boots" is not.
  //
  // Loaded around the **centre** rather than the drawn point, and before the
  // draw rather than after it, because the rejection test asks the questions the
  // player is about to ask -- is there terrain here, is a warehouse standing on
  // it, is it a pond -- and every one of those is answered "no" by a tile that
  // has not arrived. `ensureGround` reaches `COLLISION_RADIUS` = 420 m, which
  // covers the whole 100 m disc with room to spare.
  dev.boot = 'ground at spawn';
  await withDeadline(ensureGround(spawnDisc.x, spawnDisc.z), GROUND_DEADLINE_MS, 'the ground under the spawn');
  // The same table `waterLevels` below is built from, built early because the
  // spawn is chosen before that block runs and a spawn in a Sydney Park pond is
  // a session that starts at 45% speed. One float per wet tile; building it
  // twice costs nothing and reordering shared code costs more.
  const spawnWater = WaterLevels.fromIndex(index.tiles, index.tile_size);
  const drawn = pickSpawnPoint(spawnDisc, {
    collision,
    groundHeight: groundHeightAt,
    waterSurface: (x, z) => spawnWater.surfaceAt(x, z),
  });
  const spawn = new Vector3(drawn.x, drawn.y, drawn.z);
  console.debug(
    `[boot] spawn (${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)}), ` +
      `${Math.hypot(spawn.x - spawnDisc.x, spawn.z - spawnDisc.z).toFixed(1)} m from the ` +
      `${SPAWN_DITHER_RADIUS} m disc centre at (${spawnDisc.x}, ${spawnDisc.z})`,
  );
  // The player is a combatant like every other. `player` is an alias for the
  // movement half -- the same `PlayerState` object `controller.step` advances --
  // rather than a copy, because two records of where the player is have exactly
  // one behaviour, which is to disagree. See `game/combat.ts`'s header.
  const playerCombat = createCombatant(0, spawn.x, spawn.z);
  const player = playerCombat.body;
  // `Infinity` for the feet height so a roof under the spawn point counts. The
  // dither has already refused every point inside a prism, so on a good draw
  // this is the terrain and nothing else; it stays `Infinity` for the draw that
  // gave up and took the disc centre, where standing on the building has always
  // been a better answer than starting the game inside it.
  // That call is also what seeds `lastGround`, which is why it comes before the
  // first simulation step rather than being folded into it.
  player.position.y = groundHeightAt(spawn.x, spawn.z, Infinity) + EYE_HEIGHT;
  player.yaw = Math.PI * 0.25;

  // --- Characters. Spec milestone 7's second half.
  //
  // `characters` itself is built near the top of `main`, with the two other pure
  // geometry sets, so the shader warm-up can reach its material -- see there.
  // Everything that *uses* it is here.

  /**
   * The ground under a character, which is the same question the player asks and
   * therefore the same function. A character carries its own last height for the
   * roof test for the reason `lastGround` exists: the answer to "how high is the
   * world here" depends on how high you already are, and a dummy that queried
   * with the *player's* height would climb onto a roof the player walked past.
   */
  let dummyFeet = player.position.y - EYE_HEIGHT;
  const characterGround = (x: number, z: number): number => {
    dummyFeet = groundHeightAt(x, z, dummyFeet);
    return dummyFeet;
  };

  // --- The world the fight happens in, as `game/combat.ts` wants it: the prisms
  // and the height query, and nothing else. Two members rather than a reference
  // to everything here, because the server implements this same interface
  // against the same prism payload and a different ground source.
  //
  // Three members rather than two since the harbour got water in it: the third
  // is where the surface is, which is a *lookup* rather than a query over the
  // sheets. The sheets are geometry and are loaded only for the tiles the
  // renderer wants; this is one float per wet tile out of `index.json`, which is
  // the same file the server reads and the same table it builds from it. That is
  // the whole of how the two ends agree about wading without a protocol change
  // -- see `world/wading.ts`.
  const waterLevels = WaterLevels.fromIndex(index.tiles, index.tile_size);
  const combatWorld: CombatWorld = {
    collision,
    groundHeight: groundHeightAt,
    waterSurface: (x, z) => waterLevels.surfaceAt(x, z),
  };

  /**
   * A spot near `(x, z)` that a character can stand in.
   *
   * Spawn points are tile centres and a tile centre lands inside a footprint
   * often enough to matter -- `main` already says so about the player's own
   * spawn. A dummy placed inside a terrace is a dummy that cannot be walked up
   * to and cannot be punched, so the ideal position is tried first and then a
   * widening ring of alternatives, and only the last resort is "wherever it
   * asked for".
   */
  const placeClear = (x: number, z: number): Vector3 => {
    const at = new Vector3(x, 0, z);
    for (let ring = 0; ring < 4; ring++) {
      const radius = ring * 1.6;
      const steps = ring === 0 ? 1 : 8;
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const cx = x + Math.cos(a) * radius;
        const cz = z + Math.sin(a) * radius;
        const y = characterGround(cx, cz);
        // A null move against the prisms: `resolve` pushes a circle out of
        // anything it overlaps and reports whether it had to. The 0.42 is the
        // controller's step height, so a kerb does not count as an obstacle --
        // the same query `combat.pickRespawn` makes, for the same reason.
        if (!collision.resolve(cx, cz, cx, cz, PLAYER_RADIUS, y + 0.42).hit) {
          return at.set(cx, y, cz);
        }
      }
    }
    return at.set(x, characterGround(x, z), z);
  };

  // --- The connection, before the dummies are decided, because whether there
  // are dummies is the first thing it decides.
  //
  // Milestone 9. `net/client.ts` carries the whole of prediction, reconciliation
  // and interpolation; what happens here is the wiring, and the one rule worth
  // stating is that **every line below this point works with `net` null**. Spec
  // 9's local stub is not a fallback that has been kept alive out of caution --
  // it is still the only way to work on the punch without a server running, and
  // a build where offline had quietly rotted is a build where nobody can.
  //
  // Where to connect, in precedence order: an explicit `?server=` (a host, or a
  // whole ws:// URL), a `sydney.server` in localStorage, or this page's own
  // host on port 8787. Same-host by default is what makes a second browser tab
  // on this machine work with no configuration at all, which is the deliverable.
  // `netUrl` itself is resolved much earlier -- the name prompt needs to know
  // whether there is anybody to be named to before it decides to appear.
  const kills: string[] = [];
  const remotes = new Map<number, RemoteActor>();
  let net: NetClient | null = null;

  /**
   * Global chat, opened with `I`. See `client/src/chat.ts`.
   *
   * Built **here**, before `net` exists and whether or not it ever will, and the
   * hooks read `net` through closures rather than holding it: the client is
   * constructed a second or two later on the online path and never at all on the
   * offline one, and a box that had to be rebuilt on connect would be a box whose
   * scrollback was thrown away by connecting.
   *
   * `onTypingChange` is the whole of the interlock with the rest of the input
   * layer: it sets `hud.chatTyping`, which makes `hud.typing` true, which makes
   * the keydown listener at the bottom of this file return at its first line --
   * so `wasd` does not walk, `f` and `l` do not swing, and Escape belongs to the
   * box rather than to the panels. The same guard the name prompt has used since
   * it existed, reused rather than reinvented.
   */
  const chat = new ChatBox({
    /*
     * `/unstuck` is intercepted here, on both paths, and the two halves are
     * genuinely different jobs rather than one with a branch in it.
     *
     * **Online** the command still goes to the server -- it is the authority,
     * and a client that moved itself 200 m would be rubber-banded back inside a
     * snapshot. All this end does is warn the reconciler that an unpredictable
     * jump is coming, so it is adopted the way a respawn is instead of being
     * differenced into a four-hundred-metre-a-second velocity. See
     * `NetClient.armTeleport`.
     *
     * **Offline** there is nobody to ask: `?offline` makes this client its own
     * authority, `simulate` steps the world exactly as `server/sim.ts` does, and
     * so the same relocation happens locally through the same shared rule. That
     * is what keeps `?offline` a real test of the feature rather than a build
     * where it quietly does not exist.
     *
     * The command is never handed to `sendChat` on the offline path, and the
     * non-empty return is what stops `ChatBox` drawing its "no server" line: a
     * player who typed `/unstuck` and got moved does not need to be told that
     * chat needs a connection.
     */
    send: (text) => {
      if (!unstuckCommand(text)) return net?.sendChat(text) ?? '';
      if (!net) {
        unstuckLocally();
        return text;
      }
      net.armTeleport();
      return net.sendChat(text);
    },
    onTypingChange: (typing) => {
      hud.chatTyping = typing;
    },
    selfId: () => net?.id ?? 0,
    selfRoom: () => net?.room ?? -1,
  });

  /**
   * The suggestions box, opened with Escape. See `client/src/suggestions.ts`.
   *
   * Built **here, before `net` exists and whether or not it ever will**, on the
   * chat box's argument exactly: the client is constructed a second or two later
   * on the online path and never at all offline, and the panel has to be
   * openable in both cases -- offline it says so, which is the whole of what
   * `?offline` needs from this feature.
   *
   * The handlers read `net` through closures rather than holding it, so a
   * connection that settles after this line is picked up without rebuilding
   * anything. `?? false` on each is what makes the offline path a returned
   * boolean rather than a thrown error: the panel asks, gets no, and says no.
   */
  const suggestions = new SuggestionsPanel({
    onRefresh: () => net?.requestSuggestions() ?? false,
    onSubmit: (title, body) => net?.submitSuggestion(title, body) ?? false,
    onVote: (localId, dir) => net?.voteSuggestion(localId, dir) ?? false,
  });

  // --- The nameplates: a name and a large health bar over every other player.
  //
  // A user-ordered feature that overrules spec 8.2's "no world-space health
  // bars" line, and the one file that decides *who is a player* is this one --
  // which is why the field is filled from here rather than from inside
  // `net/client.ts`. Online it is fed the remotes; offline it is fed the three
  // dummies, which stand in for players. The pedestrians, the faction NPCs, the
  // police and the ibises are never offered one: they are scenery, and a
  // labelled city is a diagram.
  //
  // One object for the whole feature -- one geometry, one material, one draw
  // call, and no per-player anything. See `world/nameplates.ts`.
  const nameplates = new NameplateField();
  scene.add(nameplates.mesh);
  /** Where a plate's owner's head is. Reused every frame; never escapes the loop. */
  const plateHead = new Vector3();
  /**
   * One record, refilled per player per frame.
   *
   * `NameplateField.add` copies every field and keeps no reference, which is
   * stated in `PlateInput` precisely so this can be a single object rather than
   * fifteen literals a frame.
   */
  const plate: PlateInput = {
    id: 0, name: '', health: 0, headX: 0, headY: 0, headZ: 0, down: false,
  };
  /**
   * What to write over a training dummy.
   *
   * They have no roster name -- there is no server offline and therefore no
   * roster -- so they carry their behaviour, which is the only thing that tells
   * the three of them apart and is exactly what somebody testing the plates
   * wants to read. The alternative, borrowing `server/bots.ts`'s Aussie names,
   * would put a name over a figure that is not a player and cannot be one, and
   * `game/dummies.ts` deliberately restates rather than imports across that
   * boundary.
   */
  const dummyLabel = (kind: DummyKind): string =>
    kind === 'aggressor' ? 'Aggro' : kind === 'pacer' ? 'Pacer' : 'Post';
  // `footies` and `footyPool` are built near the top of `main`, with the
  // character assets and for the same reason: their shaders are warmed before
  // the first frame rather than compiled during the first fight.


  // --- The three dummies: spec 9's local stub, and the thing that makes the
  // punch testable in both directions before a server exists. Placed in an arc
  // in front of the spawn so all three are in the first frame -- the demo dummy
  // this replaces was there for the same reason. Different colourways, because
  // telling them apart at fifteen metres is the whole argument for the seven
  // kits in `character.ts`.
  //
  // **Not spawned when a server is answering.** The server runs two bots of its
  // own (`server/bots.ts`) which are ordinary combatants in the snapshot, and
  // three local dummies beside them would be three figures nobody else can see
  // and nobody can hit -- furniture that looks like players, which is worse than
  // no dummies at all. The array is empty online and every loop over it is a
  // no-op, which is why there is no second branch anywhere below.
  const forwardX = -Math.sin(player.yaw);
  const forwardZ = -Math.cos(player.yaw);
  const rightX = Math.cos(player.yaw);
  const rightZ = -Math.sin(player.yaw);
  const layout: Array<{ kind: DummyKind; kit: number; ahead: number; side: number; face: number }> = [
    // The post: dead ahead and close, which is the clean read on reach.
    { kind: 'post', kit: 1, ahead: 4.5, side: -2.6, face: Math.PI },
    // The pacer: further out, walking across the view rather than toward it, so
    // the 6 m line is visible as a line.
    { kind: 'pacer', kit: 2, ahead: 8.5, side: 0.5, face: Math.PI / 2 },
    // The aggressor: off to the side, so walking into its 1.5 m is a decision.
    { kind: 'aggressor', kit: 5, ahead: 5.5, side: 3.4, face: Math.PI },
  ];

  // The local player's own body: at the player, invisible to the camera, and in
  // the sun's shadow map. `castShadowOnly` documents the mechanism and the three
  // alternatives it was chosen against -- the short version is that three's
  // shadow pass is a real `renderer.render(scene, shadow.camera)`, so a layer the
  // view camera excludes and the shadow camera includes is seen by the sun and
  // by nothing else.
  const self = new CharacterActor(characters, 3);
  self.mesh.name = 'character:self';
  castShadowOnly(self.mesh, sky.sun.shadow.camera);
  scene.add(self.mesh);
  // Driven from combat state like every other actor, which is what puts your own
  // swing, flinch and crumple into the shadow on the footpath in front of you.
  // There are still no first-person *arms* -- that is its own rig, its own clips
  // and its own field of view -- but there is now a first-person **bat**, which
  // is the object the fight is about and is a single prop rather than a body.
  const selfDriver = new ActorDriver(self);
  // Your own bat, in your own hand, on the layer the camera excludes -- so what
  // this contributes to a frame is the shadow of a raised bat on the footpath.
  // `castShadowOnly` has to be called on the prop as well as on the body,
  // because three does not inherit layers: a child of a bone on layer 1 is still
  // on layer 0 and is still drawn. See `BatProp.castShadowOnly`.
  const selfBat = new BatProp(bats, self);
  selfBat.castShadowOnly();
  /**
   * And the one the player actually looks at.
   *
   * Parented to the camera, which is why the camera has to be in the scene:
   * three walks `scene` and nothing else, so a child of a detached camera is
   * never drawn. The camera itself matches none of `_projectObject`'s branches,
   * so putting it there costs one recursion a frame and draws nothing extra.
   */
  const viewmodel = new BatViewmodel(bats);
  camera.add(viewmodel.group);
  scene.add(camera);
  /**
   * Your own football, in front of your own eye, and one on your own body.
   *
   * Two objects for the same reason the bat has two: the **viewmodel** is what
   * you look at, and the **prop** on the shadow-layer body is what puts a
   * football-shaped shadow on the footpath beside your bat's. `castShadowOnly`
   * has to be called on the prop as well as on the body, because three does not
   * inherit layers -- a child of a bone on layer 1 is still on layer 0 and is
   * still drawn. That is the exact bug the raygun this replaced shipped with,
   * and `verifyFootyBall` now asserts against it.
   */
  const selfFooty = new FootyProp(footies, self);
  selfFooty.castShadowOnly();
  const footyViewmodel = new FootyViewmodel(footies);
  camera.add(footyViewmodel.group);

  // --- The lime e-bikes.
  //
  // `game/bikes.ts` decides everything; this is the wiring and the geometry.
  //
  // The **plan** is computed here from the tile index, which is the file both
  // ends already have before anything streams, so bike 31 is the same bike in
  // every process. The **placement** goes two ways depending on who is the
  // authority: offline the client places bikes itself as tiles arrive, and
  // online the server's `MSG.BIKES` supplies them and `net.bikes` is the field
  // that holds them. `bikeWorld` below is whichever one is live.
  const bikeMeshes = new BikeMeshes(bikes);
  scene.add(bikeMeshes.mesh);
  // The lime marker on the road under every *parked* bike, in a second draw over
  // the same instance loop. See `world/bike.buildBikeGlow` -- it is additive, so
  // it is a tint at noon and a glow at dusk with no day/night term anywhere, and
  // it is filled from the same pass that fills the bikes so a ridden bike and
  // its marker can never disagree about who is on it.
  scene.add(bikeMeshes.glow);
  // And the beacon over it: a 72 m lime column, drawn to the bike's own 400 m
  // rather than the marker's 120, which is the long-range half of the same
  // signal. See `world/bike.buildBikeBeam` -- it depth *tests*, so a terrace
  // clips the bottom and the top stands clear over the roofline, which is the
  // whole "spottable from blocks away" read. Filled on the same row of the same
  // loop as the bike itself, so it goes out the frame somebody mounts.
  scene.add(bikeMeshes.beam);
  /** The one under the local rider, drawn at the predicted position. */
  const selfBike = new RiddenBike(bikes);
  scene.add(selfBike.mesh);
  /** The offline authority. Unused while a server is answering; see `bikeWorld`. */
  const localBikes = new BikeField();
  const bikePlanned = bikePlan(index.tiles);
  /** Which planned bikes have been placed offline, so a tile is not re-tried forever. */
  const bikePlaced = new Set<number>();
  /** Planned bikes still waiting on their tile's collision and terrain, by tile key. */
  const bikeWaiting = new Map<string, BikePlanEntry[]>();
  for (const plan of bikePlanned) {
    const list = bikeWaiting.get(plan.tileKey);
    if (list) list.push(plan);
    else bikeWaiting.set(plan.tileKey, [plan]);
  }
  /**
   * The ground a bike is placed against, offline.
   *
   * `clear` uses the **player's** radius and the controller's step height,
   * exactly as `server/sim.ts` does and for the same reason: any spot that
   * admits a bike has to admit the person walking over to fetch it, and a kerb
   * is not an obstacle.
   */
  /**
   * The **raw** terrain height, which is deliberately not `groundHeightAt`.
   *
   * Two reasons, and both of them were bugs before they were reasons.
   *
   *   1. `groundHeightAt` never returns a non-finite value: it falls back to
   *      `lastGround`, the last height the *player* stood on, which is exactly
   *      right for walking a player across a seam and exactly wrong here. A bike
   *      three tiles away whose terrain has not arrived would be placed at the
   *      player's own elevation -- buried in Redfern or hovering over
   *      Alexandria -- and, worse, `placeBike` would *succeed*, so the tile
   *      would be struck off and never retried.
   *   2. `groundHeightAt` **writes** `lastGround`. Querying it for a point 700 m
   *      away leaves the player's own fallback height set to somewhere they have
   *      never been, which is a real position bug in a function that only meant
   *      to ask a question.
   *
   * So this asks the streamer directly and answers `NO_GROUND` for a tile that
   * is not resident, which is what makes "wait until the terrain is here" a
   * thing `placeBike` and `maybeBuildStall` can both simply test for.
   */
  const rawGroundAt = (x: number, z: number): number => streamer.ground?.height(x, z) ?? NO_GROUND;
  const bikeGround: BikeGround = {
    groundHeight: (x, z) => rawGroundAt(x, z),
    clear: (x, z, y) => !collision.resolve(x, z, x, z, PLAYER_RADIUS, y + 0.42).hit,
    waterSurface: (x, z) => waterLevels.surfaceAt(x, z),
  };
  /** Whichever field is authoritative right now. See the block above. */
  const bikeWorld = (): BikeField => (net ? net.bikes : localBikes);
  /**
   * Is this bike the one the local player has *predicted* they are on?
   *
   * The parked set consults it so that a bike stops being drawn on the footpath
   * on the frame `E` is pressed rather than 30 ms later when the server agrees.
   * Without it a mounted bike is drawn twice for one round trip -- once under
   * the rider and once still standing where it was -- which is the most visible
   * artefact this feature can produce and is entirely a presentation problem.
   */
  const isRiddenLocally = (id: number): boolean => playerCombat.ridingBike === id;
  /**
   * Place any planned bike whose tile has arrived. Offline only.
   *
   * **Both** the prisms and the terrain have to be resident, and they arrive on
   * different schedules -- collision is fetched to `COLLISION_RADIUS` and the
   * terrain grids come with the tiles. Gating on the prisms alone was the first
   * version and it placed bikes at the player's own elevation, because the
   * ground query then had nothing better to say; gating on both means a tile is
   * simply left in the queue until it can be answered properly.
   *
   * Once it *can* be answered, a tile is tried exactly once and struck off
   * either way. A bike that could not be placed is a tile with nowhere to park
   * -- all building, all water, out over the harbour -- which is a permanent
   * fact about that tile and not a thing to re-test sixty times a second.
   */
  const placeResidentBikes = (): void => {
    if (net) return;
    for (const [key, plans] of bikeWaiting) {
      if (!collision.hasTile(key)) continue;
      // The terrain, asked at the planned point itself rather than by tile key,
      // because that is the query `placeBike` is about to make.
      if (!Number.isFinite(rawGroundAt(plans[0].x, plans[0].z))) continue;
      for (const plan of plans) {
        if (bikePlaced.has(plan.id)) continue;
        bikePlaced.add(plan.id);
        const spot = placeBike(plan, bikeGround);
        if (spot) localBikes.adopt(plan.id, spot);
      }
      bikeWaiting.delete(key);
    }
  };
  /**
   * The tuning stall in Redfern, built once the ground under it is known.
   *
   * Deferred rather than built at boot because only the streamer knows how high
   * Redfern is, and a stall placed at the ENU datum would be thirty metres in
   * the air over Redfern Street. Against `rawGroundAt` rather than
   * `groundHeightAt` for the reason that function states at length: the latter
   * *always* answers, with the player's own last height, so this would have
   * built the stall on the first frame at whatever elevation the spawn happens
   * to be -- 27 m out, in Alexandria -- and never corrected it, because it only
   * builds once.
   *
   * Null until Redfern's terrain is actually resident, which for a player who
   * never goes there is forever, and costs nothing.
   */
  let tuningStall: Object3D | null = null;
  const maybeBuildStall = (): void => {
    if (tuningStall) return;
    const y = rawGroundAt(TUNING_X, TUNING_Z);
    if (!Number.isFinite(y)) return;
    tuningStall = buildTuningStall(bikes, y);
    scene.add(tuningStall);
  };

  /** A combatant, its input packet, and the actor that shows what it is doing. */
  interface Fighter {
    combat: CombatantState;
    input: CombatInput;
    driver: ActorDriver;
    dummy: Dummy | null;
  }

  /**
   * One remote player's body: an actor, its two weapons, and the last state
   * bytes the reactions fire off.
   *
   * Not a `Fighter` and not a `Dummy`, because a remote has no `CombatantState`
   * on this machine at all -- the server owns it, and what arrives is 21 bytes
   * of interpolated snapshot. `ActorDriver` takes a `CombatantState`, so it is
   * deliberately not reused: half its job is reading phases and hitstop this
   * side has no access to, and a shim satisfying the interface would be a lie
   * about where the authority is. What is left is nine lines.
   */
  interface RemoteActor {
    actor: CharacterActor;
    /** In the off hand, hidden when their bar is empty or the ball is in the air. */
    footy: FootyProp;
    /** Everyone carries one. See `BatProp`: there is no stowed position. */
    bat: BatProp;
    /** The byte last seen, so a reaction fires on the *change*. See `ActorDriver`. */
    lastAnim: number;
    /** The throw flag last seen, so the overlay fires on its **rising edge** only. */
    lastThrowing: boolean;
    /**
     * The lime e-bike under them, made the first time they get on one.
     *
     * Lazily, and never disposed until they leave, because riding is a thing a
     * player does repeatedly in a session and building an `InstancedMesh` per
     * mount would allocate a buffer every time. Most remotes never have one at
     * all, which is why it is not built with the actor.
     */
    bike: RiddenBike | null;
    /** The riding flag last seen, so the seated pose is set on its edges only. */
    lastRiding: boolean;
  }

  function ensureRemoteActor(r: RemotePlayer): RemoteActor {
    let entry = remotes.get(r.id);
    if (!entry) {
      const actor = new CharacterActor(characters, r.colourway);
      actor.mesh.name = `character:remote:${r.id}`;
      scene.add(actor.mesh);
      entry = {
        actor,
        footy: new FootyProp(footies, actor),
        bat: new BatProp(bats, actor),
        lastAnim: -1,
        lastThrowing: false,
        bike: null,
        lastRiding: false,
      };
      remotes.set(r.id, entry);
    }
    return entry;
  }

  function dropRemoteActor(id: number): void {
    const entry = remotes.get(id);
    if (!entry) return;
    entry.footy.dispose();
    entry.bat.dispose();
    entry.bike?.dispose();
    entry.actor.mesh.removeFromParent();
    // The geometry and the material belong to `CharacterAssets` and are shared by
    // every actor in the game, so nothing here disposes either -- the same
    // contract `character.ts` states about its own assets.
    remotes.delete(id);
  }

  /**
   * Drive one remote's pose from its interpolated snapshot.
   *
   * The reaction clips fire on a *change* of the animation byte rather than
   * while it is current, which is `ActorDriver`'s rule and matters more here: a
   * remote's byte arrives twenty times a second, and `setAction` restarts a clip
   * every time it is called, so a flinch re-triggered on every snapshot is a
   * figure vibrating at its own attack envelope for as long as it lasts.
   */
  function poseRemote(entry: RemoteActor, r: RemotePlayer, dt: number): void {
    if (r.anim !== entry.lastAnim) {
      if (r.anim === ANIM.WINDUP) {
        entry.actor.setAction('punch');
        // Somebody else's bat going through the air, at the moment their swing
        // starts rather than when it lands. Range-gated on the same number a
        // local dummy's swing is: a whoosh from across a suburb is noise.
        const range = Math.hypot(r.position.x - player.position.x, r.position.z - player.position.z);
        if (range < WHIFF_AUDIBLE) audio.whiff();
      } else if (r.anim === ANIM.FLINCH) entry.actor.setAction('flinch');
      else if (r.anim === ANIM.KO) entry.actor.setAction('knockout');
      else if (entry.lastAnim === ANIM.KO) entry.actor.setAction(null);
      entry.lastAnim = r.anim;
    }
    // The throw, on the **rising edge** of the flag rather than while it is set,
    // for exactly `ActorDriver`'s reason about the reaction bytes: the flag
    // arrives twenty times a second and `setAction` restarts a clip every time
    // it is called, so an overlay re-triggered on every snapshot is a figure
    // vibrating at its own attack envelope for as long as the window lasts.
    if (r.throwing && !entry.lastThrowing) {
      entry.actor.setAction('throw');
      const range = Math.hypot(r.position.x - player.position.x, r.position.z - player.position.z);
      if (range < THROW_AUDIBLE) audio.footyThrow(range);
    }
    entry.lastThrowing = r.throwing;
    // The seated pose, on the **edges** of the riding flag for exactly the same
    // reason the throw is on a rising edge: the flag arrives twenty times a
    // second, and `setAction` restarts a clip every time it is called. (The ride
    // is additionally guarded inside `CharacterActor.setAction`, which ignores a
    // re-issue of the ride already playing -- belt and braces, because this is
    // the failure that would hold a rider permanently half-seated.)
    //
    // The dismount clears the action outright rather than setting a locomotion,
    // because `ride` is a held reaction and the actor's own derived locomotion is
    // the right thing underneath it. See `character.ReactionName`.
    if (r.riding !== entry.lastRiding) {
      entry.actor.setAction(r.riding ? 'ride' : null);
      entry.lastRiding = r.riding;
    }
    // A ball in the off hand while they have one and are not mid-throw. Being
    // able to see at fifteen metres whether somebody is carrying is a real read:
    // it is the difference between closing on them and staying out of range.
    entry.footy.set(r.ballCharges > 0 && !r.throwing);
    entry.actor.update(dt, {
      position: { x: r.position.x, y: r.position.y - EYE_HEIGHT, z: r.position.z },
      yaw: r.yaw,
      // A knocked-out body is travelling at 10 m/s and is not running -- the
      // reason `ActorDriver` zeroes it too. The crumple is a whole-body overlay,
      // but a sprint underneath still drives the stride phase and would leave
      // the legs mid-cycle on the frame it gets up.
      speed: r.anim === ANIM.KO ? 0 : r.speed,
      onGround: r.anim === ANIM.KO ? true : r.onGround,
    });
  }


  const input: CombatInput = {
    forward: 0,
    right: 0,
    jump: false,
    sprint: false,
    yaw: player.yaw,
    pitch: 0,
    punch: false,
    throwBall: false,
  };

  const audio = new CombatAudio();
  const feedback = new Feedback();

  /**
   * Bring the audio context up and warm the voice clips behind it.
   *
   * The clips cannot be fetched before there is a context to decode them into --
   * `decodeAudioData` is a method on one -- and the context cannot exist outside
   * a user gesture, which is what `CombatAudio.enable` documents. So the fetch
   * rides the same gesture, which means the first police line of a session is
   * decoded and ready long before anybody can reach a police station.
   *
   * Idempotent on both halves: `enable` already is, and `loadClip` returns
   * immediately for a URL it is holding or fetching.
   */
  function enableAudio(): void {
    audio.enable();
    for (const url of POLICE_CLIPS) audio.loadClip(url);
    // The street factions' lines ride the same gesture. Eleven files against the
    // police's two, and they are warmed for a harder reason: an officer barks
    // when the weapon comes up, which is at least half a second after they
    // started running at you, where a meth head's line *is* the moment they
    // start running. A clip fetched at that instant arrives after the swipe.
    for (const url of METHHEAD_CLIPS) audio.loadClip(url);
    for (const url of DRUNK_CLIPS) audio.loadClip(url);
  }

  // Somebody got clobbered. Subscribed through the module's own seam rather than
  // handled at the two call sites, and that is deliberate: the seam is what the
  // police pass will attach to, and a seam nothing uses is a seam nobody has
  // ever run. This is the *only* consumer this wave and everything it does is
  // cosmetic -- a grunt and a counter -- which is exactly what "client-local"
  // means here. See `game/pedestrians.onPedestrianStruck`.
  onPedestrianStruck((hit) => {
    pedHits.count++;
    pedHits.lastTick = hit.tick;
    audio.oof(
      Math.hypot(hit.x - player.position.x, hit.z - player.position.z),
      // The walker's key, so the same person always has the same voice. See
      // `CombatAudio.oof`.
      hit.key | 0,
    );
  });

  // What the player said to call them, collected from the prompt that went up
  // when the world became drawable. Usually already resolved by now; if the
  // player is still typing, this is where the boot waits for them, which is the
  // right place to wait -- everything behind them has loaded and the only thing
  // outstanding is the socket their name has to go out on.
  //
  // Stored **after** the await rather than inside `askName`, so the HUD stays a
  // thing that draws and this file keeps every decision about what persists.
  const playerName = await namePromise;
  saveName(playerName);
  dev.name = playerName;

  if (netUrl !== null) {
    dev.boot = 'connecting';
    /*
     * The gateway step. PERFORMANCE.md phase 3.
     *
     * One HTTP round trip before the socket: ask the host what rooms it has,
     * pick the emptiest open one (or the one a friend's link named), and put it
     * in the query. Every part of this degrades to the pre-phase-3 behaviour --
     * a host with no `/rooms`, a proxy that only forwards `/ws`, a fetch that
     * times out -- because `fetchRooms` answers with an empty list and
     * `chooseRoom` then says "you decide", which is a bare connection and is
     * exactly what a v7 client sent.
     *
     * It is awaited rather than raced with the socket because it is bounded at
     * two seconds against a route that answers in one millisecond, and because
     * connecting first would mean joining a room and then discovering there was
     * a better one -- which is a reconnect, and a reconnect is a new id.
     */
    const asked = requestedRoom();
    const rooms = await fetchRooms(httpBaseOf(netUrl));
    const room = chooseRoom(rooms, asked);
    const joinUrl = room === null ? netUrl : `${netUrl}${netUrl.includes('?') ? '&' : '?'}room=${room}`;
    hud.notice(`connecting to ${netUrl}${room === null ? '' : ` (room ${room})`}…`);
    // `clientId` is this browser's vote identity, minted once in
    // `localStorage` beside `sydney.name` and read here rather than inside the
    // net layer -- so it survives a reconnect, which rebuilds this object. See
    // `client/src/suggestions.ts`, which is honest about it being a claim rather
    // than proof of anything.
    const client = new NetClient(joinUrl, netHandlers(), { name: playerName, clientId: clientId() });
    // Awaited, and this is the one place the boot blocks on the network.
    //
    // The alternative -- connect in the background and spawn the dummies now,
    // deleting them if a server answers -- was tried on paper and is worse in
    // both directions: a player who *is* online sees three figures appear and
    // vanish in the first second, and one who is offline has a second of the
    // game with nothing in it. Neither is a second anybody notices here, because
    // the first tiles are still arriving; and knowing the answer before the
    // fighters are built means there is exactly one branch in this file rather
    // than a delete path that has to unpick a scene graph.
    //
    // 1.5 s is a WebSocket handshake to a host on this machine (about a
    // millisecond), to one on the LAN (a few), or to nothing at all -- where a
    // refused TCP connection on localhost fails immediately and one to a dead
    // LAN address is what the timeout is really for.
    const settled = await Promise.race([
      new Promise<boolean>((resolve) => {
        client.onSettled = () => resolve(client.status === 'online');
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500)),
    ]);
    if (settled) {
      net = client;
      // The server chose where this player stands, so the local prediction has
      // to start there rather than at the client's own draw. Both ends compute
      // the same disc centre from the same `index.json` (see `game/spawn.ts`),
      // but the dither inside it is drawn per join and the server's draw is the
      // one that counts -- a client that kept its own would spend its first
      // snapshot being corrected across a hundred metres of park.
      const w = client.welcome;
      if (w) {
        dev.boot = 'ground at server spawn';
        player.position.set(w.x, w.y, w.z);
        player.velocity.set(0, 0, 0);
        player.yaw = w.yaw;
        input.yaw = w.yaw;
        // Bounded, and this is the one that actually wedged a browser. The
        // server's spawn is at most 200 m from the client's own and inside the
        // same disc, so the tiles are almost always already in hand and this
        // returns instantly -- which is exactly what made it a plausible thing
        // to `await` unguarded, and exactly why the one time it did not return
        // there was nothing to see.
        await withDeadline(ensureGround(w.x, w.z), GROUND_DEADLINE_MS, 'the ground under the server spawn');
      }
    } else {
      client.close();
      hud.notice('no server answered — offline, with local dummies');
    }
  }
  const online = net !== null;
  // The suggestions box is server-backed: offline it opens and says so rather
  // than not opening, on the argument that a control which silently does nothing
  // is a control a player decides is broken. `?offline` is one of the two ways
  // to get here; a connection that never settled is the other, and they present
  // identically because they are the same thing to this panel.
  suggestions.setConnected(online);

  /**
   * The football in each dummy's off hand, so it can be hidden while in flight.
   *
   * A side table rather than a field on `Dummy`, because `game/dummies.ts` is
   * the *simulation* stub and holds no three objects at all -- it owns an input
   * packet and a combat state, and `ActorDriver` is the only rendering thing it
   * touches. Threading a `Mesh` through it to save a `Map` lookup on three
   * objects would put the renderer inside the one module that has been kept
   * clear of it.
   */
  const dummyFooties = new Map<Dummy, FootyProp>();

  const dummies: Dummy[] = (online ? [] : layout).map((spec, i) => {
    const home = placeClear(
      spawn.x + forwardX * spec.ahead + rightX * spec.side,
      spawn.z + forwardZ * spec.ahead + rightZ * spec.side,
    );
    const actor = new CharacterActor(characters, spec.kit);
    // A bat each, and nothing downstream has to know: `BatProp` parents itself
    // to the actor's right wrist bone, so the dummies swing one through the same
    // clip the player's own body does. Spec 9's stub is only worth having if it
    // is the same code path.
    new BatProp(bats, actor);
    // ...and a football in the other hand, on the same argument one weapon over.
    // The aggressor throws it (`dummies.ts`), which is the only way the
    // third-person throw clip, the ball leaving somebody else's hand and the
    // prop vanishing from their grip are reachable without a server and a second
    // browser -- and a path only reachable that way is a path that rots.
    const dummyFooty = new FootyProp(footies, actor);
    const dummy = new Dummy(spec.kind, i + 1, actor, home, player.yaw + spec.face);
    dummyFooties.set(dummy, dummyFooty);
    scene.add(actor.mesh);
    return dummy;
  });

  // Player first, then the dummies in id order. The order is the tick order and
  // it is fixed rather than incidental: two combatants who strike on the same
  // tick have to resolve in an order both ends of a future connection agree on,
  // and "ascending id" is the cheapest such rule.
  const fighters: Fighter[] = [
    { combat: playerCombat, input, driver: selfDriver, dummy: null },
    ...dummies.map((d) => ({ combat: d.combat, input: d.input, driver: d.driver, dummy: d })),
  ];
  const combatants = fighters.map((f) => f.combat);


  // --- The minimap.
  //
  // Built here because it needs the collision world and both marker sources,
  // and all three exist by now: the prisms are what it draws, the powerup field
  // is what it marks, and the dummies are the combatants on it. It reads all
  // three and writes none of them, which is why it can be the last thing wired
  // and the first thing deleted.
  const minimap = new Minimap(
    document.getElementById('minimap') as HTMLCanvasElement,
    collision,
    document.getElementById('locator'),
  );

  // And what goes in the strip under it: the street the player is standing on
  // and the suburb it is in, from the centreline sidecars the streamer loads
  // with each tile. The streamer satisfies `StreetSource` structurally, so
  // neither module imports the other's class -- see `game/locator.ts`.
  //
  // The suburb file is fetched and deliberately not awaited. It is 4.7 kB and
  // lands in the same round trip as a tile, and the readout is complete without
  // it: streets appear immediately and the ", Newtown" arrives a moment later,
  // which is a better boot than a loading screen held open for a lookup table.
  const locator = new Locator(streamer, '/world', streamer.assetVersion);
  void locator.loadSuburbs();

  // And where the water is, which is the one region on the map that gets a fill
  // of its own. The streamer already holds every resident tile's sheet in world
  // metres for the renderer, so this is a second reader of data the client is
  // carrying either way -- see `minimap.setWaterSource`.
  minimap.setWaterSource((x, z, radius, out) => streamer.waterPlansNear(x, z, radius, out));

  // --- The invisible walls, on both maps.
  //
  // The city arrives as two files per tile that are three orders of magnitude
  // apart: a 9 kB collision payload this file fetches on `COLLISION_RADIUS`, and
  // a 1.6 MB GLB that goes through the streamer's fetch, worker decode and
  // budgeted build. Between the two the prisms of a tile are solid and there is
  // nothing drawn where they are -- which at the tuned e-bike's 39 m/s is a
  // wall you ride into in a street that is not there yet. That gap is what this
  // overlay marks, and it is now all of what it marks.
  //
  // There was a second class, permanent: `tiles.write_collision` writes every
  // deck, viaduct and landmark volume with its `base` at the *soffit*, and
  // `CollisionWorld.resolve` tested only `top`, so the Cahill Expressway was
  // solid from the ground up. It is not any more -- `resolve` tests a body's
  // band against `[base, top)` -- so those 4,522 prisms are no longer walls at
  // all and no longer wear an ink. See `world/invisible-walls.ts`, which still
  // measures them for the counter that says the rule has something to act on.
  //
  // The ground sampler is `rawGroundAt` and deliberately **not**
  // `groundHeightAt`, for both of the reasons that function is written down
  // beside `bikeGround`. It folds in `collision.roofHeight`, so asking it under
  // a viaduct returns the viaduct's own deck and every structure in the city
  // would report a soffit clearance of zero -- and it *writes* `lastGround`, so
  // a query about a prism 400 m away would move the player's own fallback
  // height. `rawGroundAt` answers `NO_GROUND` for a tile whose terrain has not
  // arrived, which the detector treats as "do not decide yet".
  const invisibleWalls = new InvisibleWalls(index, collision, streamer, rawGroundAt);
  minimap.setHazardSource((prism) => invisibleWalls.prismHazard(prism));

  // Spec 8.3's live points. `active` only, which is the whole information the
  // map carries about them -- a cafe you have just taken should leave the map
  // the instant it leaves the world, or the player runs back to a dot that is
  // not there. The respawn is the field's own clock and the dot simply returns.
  minimap.addMarkerSource((sink) => {
    for (const p of powerups.resident()) {
      if (!p.active) continue;
      sink.mark(p.x, p.z, p.kind === TRAINING ? 'training' : 'flat-white');
    }
  });

  // Everyone who can hit you. The local player is excluded because they are the
  // wedge at the centre -- a second marker on top of it would be the map's only
  // redundant object. A knocked-out body still shows: it is a thing lying in the
  // street that is about to stand up again, which is worth knowing where.
  //
  // This is deliberately over `combatants` rather than over `dummies`: the day
  // the net layer adds remote players to that array they appear on the map with
  // no change here or in `minimap.ts`, which is the whole point of the source
  // being a function.
  minimap.addMarkerSource((sink) => {
    for (const c of combatants) {
      if (c === playerCombat) continue;
      sink.mark(c.body.position.x, c.body.position.z, 'combatant', c.body.yaw);
    }
  });

  // The unclaimed e-bikes, which is the map half of the beacon.
  //
  // **Unclaimed**, on exactly the test `BikeMeshes.update` uses: the wire's
  // `rider` plus the local prediction, so the dot goes out on the frame `E` is
  // pressed rather than 30 ms later when the server agrees, and comes back where
  // the bike is dropped. Sharing the predicate with the renderer is what keeps
  // the beam in the street and the dot on the map from ever disagreeing -- the
  // failure would be a lime dot standing over a spot where the bike left ten
  // seconds ago.
  //
  // No range test of its own. `mark` culls to the compass's 160 m and the big
  // map culls to its view box, which is the sink's job by design; at 115 bikes
  // this loop is a few microseconds at the minimap's 15 Hz and there is nothing
  // to cache. A bike that has not been placed yet is simply not in the field.
  minimap.addMarkerSource((sink) => {
    for (const b of bikeWorld().all()) {
      if (b.rider !== 0 || isRiddenLocally(b.id)) continue;
      sink.mark(b.x, b.z, 'bike');
    }
  });

  // And the remotes, as a second source rather than by pushing shims into
  // `combatants`.
  //
  // That array is `CombatantState[]` -- it is the hit test's target list and the
  // tick order -- and a remote has no `CombatantState` on this machine, because
  // the server owns it. Faking one would put an object in the punch's target
  // list whose position is 100 ms stale by design, which is the one array it
  // must never be in. `minimap.ts`'s header names `addMarkerSource` as the seam
  // the net layer plugs into, and this is one call and no change to that file,
  // which is exactly what it promised.
  minimap.addMarkerSource((sink) => {
    if (!net) return;
    for (const r of net.remotes.values()) {
      sink.mark(r.position.x, r.position.z, 'combatant', r.yaw);
    }
  });

  // --- The big map, on `M`.
  //
  // The city at up to nine kilometres, north-up, lettered with suburb and street
  // names -- the map you stop to read, as against the compass above that you
  // glance at while running. See `bigmap.ts` for why those are two objects.
  //
  // Three things are handed in and none of them are new: the atlas fetches the
  // street-name sidecars the client already ships and the harbour sheet the
  // renderer already draws (`mapatlas.ts`, and nothing at all until the first
  // press); the collision world is the same prisms the minimap fills its disc
  // with; and the markers come from the minimap's own registered sources via
  // `collect`, so the two maps cannot disagree about who is in the world.
  //
  // The landmark anchors are read straight out of the index -- they are already
  // in it for the hero meshes, and three labelled points are most of what makes
  // the city zoom legible.
  const mapAtlas = new MapAtlas(index, '/world', streamer.assetVersion);
  mapAtlas.readLandmarks();
  const bigmap = new BigMap(
    document.getElementById('bigmap') as HTMLElement,
    document.getElementById('bigmap-canvas') as HTMLCanvasElement,
    mapAtlas,
    collision,
    minimap,
  );
  // And the same two halves of the invisible-wall overlay the compass got, so
  // the two maps cannot disagree about which walls are real. The big map takes
  // the tile regions as well: at 3 km and 9 km a footprint is under a pixel and
  // the region is the only thing that can be drawn at all.
  bigmap.setHazards(invisibleWalls, (prism) => invisibleWalls.prismHazard(prism));

  const keys = new Set<string>();
  let locked = false;
  const MOUSE_SENSITIVITY = 0.0022;

  /**
   * Swing buffering, in seconds remaining.
   *
   * Edge-triggered from the mouse and consumed by the first fixed step that can
   * act on it, rather than passing the button's level straight through. Two
   * reasons: a click that lands between fixed steps would otherwise be dropped
   * entirely at high frame rates, and a *held* button would auto-fire four
   * swings and empty the bar, which is the click-spam spec 8.2's stamina exists
   * to prevent -- reintroduced by the input layer.
   *
   * 120 ms is a little under a quarter of the 500 ms cycle: long enough that a
   * click at the end of a recovery comes out, short enough that a click during a
   * wind-up does not queue a second swing you have forgotten about.
   *
   * The name is `punchBuffer` because the input bit it feeds is `punch`; see
   * `game/combat.ts`'s header for why the melee identifiers kept the spec's word
   * when the weapon became a bat.
   */
  const PUNCH_BUFFER = 0.12;
  let punchBuffer = 0;
  /**
   * The same buffer for the throw, and it is a separate one on purpose.
   *
   * Sharing a single "attack pressed" buffer between two weapons means a click
   * queued during a swing's recovery comes out as a throw if the player switched
   * hands in the meantime, which is the sort of input bug that reads as the game
   * being unresponsive. Two buffers, two consumers, no interaction.
   */
  let throwBuffer = 0;
  /**
   * Whether the player has asked for third person on foot, with `V`.
   *
   * A *preference*, not a state: riding forces third person regardless of it,
   * and dismounting returns to whatever this says. That is why it is a separate
   * boolean from `thirdPerson` below rather than the same one being toggled by
   * two things -- a bike that flipped this would leave the player in third
   * person after getting off, having never asked for it, and the only way back
   * would be to press a key they may not know exists.
   *
   * Defaults to false. Spec 1 is a first-person game and this is an addition to
   * it; a build that booted into third person would be a different game by
   * default.
   */
  let thirdPersonPreferred = false;
  /** What the camera is actually doing this frame. Riding forces it true. */
  let thirdPerson = false;
  /**
   * `E` last frame, for the mount toggle's rising edge.
   *
   * The client detects the edge for its own prediction and *also* sends the
   * level bit, which the server edges separately -- see `protocol.BTN.MOUNT`.
   * Two detectors rather than one because they are answering different
   * questions: this one decides what to predict, and the server's decides what
   * is true.
   */
  let mountHeld = false;
  /**
   * The ride pill: what it would say, and how long it has left to say it.
   *
   * **Neither of these is what puts the line on screen.** `bikes.ridePrompt`
   * does, from the riding state, every tick -- see its header, and see
   * `hud.derived`, which is the channel. These two are only the *content* and a
   * hold, so the pill is not rewritten sixty times a second while a player leans
   * on the mouse (invisible as flicker, expensive as DOM writes) and does not
   * blink out the instant they let go.
   *
   * They used to be a rate limit around a `hud.notice` call, and that shape is
   * the reported bug in one line: a message posted on an event and retracted on
   * a different event is a message that survives every path between the two.
   * Dying on the bike was such a path.
   */
  const RIDE_NUDGE_SECONDS = 1.5;
  let rideNudgeT = 0;
  let rideNudgeText = RIDE_PROMPT;
  /**
   * Where `bikes.shapeRideSteering` writes. One object, reused every frame.
   *
   * A record rather than two return values because the two halves are one
   * decision -- "the lateral input became a yaw" -- and a function that returned
   * only the yaw would leave the caller to remember to zero the strafe, which is
   * exactly the bug of a bike that turns and crabs at the same time.
   */
  const rideSteering: RideSteering = { right: 0, yawDelta: 0 };
  /**
   * How far the bike is leaned into the turn, radians. Cosmetic and eased.
   *
   * Not in the simulation and deliberately: nothing about the collision capsule,
   * the hit test or the trajectory knows this number exists, so it cannot
   * disagree with the server about anything. It is a roll applied to the bike's
   * instance matrix in `world/bike.RiddenBike.set` and to nothing else.
   */
  let rideLean = 0;

  canvas.addEventListener('click', () => {
    if (!locked) void canvas.requestPointerLock();
  });
  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    hud.setLocked(locked);
    // Pointer lock is a user gesture, and it is the earliest one that is
    // unambiguously "the player is playing". See `game/audio.ts`: a context
    // constructed anywhere else starts suspended and stays silent with nothing
    // in the console to say so.
    if (locked) enableAudio();
  });
  // Pointer lock can be refused -- an iframe without `allow="pointer-lock"`, a
  // browser that requires a fresh gesture, or a user who dismissed the prompt.
  // Without a fallback that presents as "I cannot turn", with nothing to explain
  // why, so drag-to-look below covers it and this says what happened.
  document.addEventListener('pointerlockerror', () => {
    hud.notice('Pointer lock was refused — hold the left mouse button and drag to look around.');
  });

  let dragging = false;
  canvas.addEventListener('mousedown', () => {
    if (!locked) dragging = true;
    enableAudio();
  });
  window.addEventListener('mouseup', () => {
    dragging = false;
  });

  /**
   * Left click swings the bat -- but never the click that captures the pointer.
   *
   * The guard is `locked`, read at mousedown, and it is exactly right by
   * sequence: the capturing click fires `mousedown` while `locked` is still
   * false, and `pointerlockchange` only arrives afterwards. So the click that
   * starts the game swings nothing, and the next one does. Pressing Escape and
   * clicking back in behaves the same way, which is the case that actually
   * recurs.
   *
   * The same guard is what stops the drag-to-look fallback from swinging on
   * every mouse-down used to turn the camera -- and it leaves a player whose
   * browser refuses pointer lock with no melee at all, which is why `F` throws
   * one too. The hint line says so.
   */
  window.addEventListener('mousedown', (e) => {
    if (!locked) return;
    if (e.button === 0) punchBuffer = PUNCH_BUFFER;
    // Right click throws a football. Under pointer lock the context menu does
    // not appear anyway, but the listener below covers the drag-to-look fallback
    // -- where a right click *would* open one over the game.
    if (e.button === 2) throwBuffer = PUNCH_BUFFER;
  });
  window.addEventListener('contextmenu', (e) => {
    if (locked || dragging) e.preventDefault();
  });

  /**
   * Ask for a camera, from `V` or from the wheel.
   *
   * One function because there is one preference, and the two bindings differ
   * only in how they arrive at a boolean. The nudge is the interesting half: a
   * rider is *forced* into third person, so a request made in the saddle changes
   * nothing anybody can see, and a control that silently does nothing is a
   * control a player decides is broken. It goes through the ride pill rather
   * than `hud.notice` for `simulate`'s reason -- the line says "when you get
   * off", so it is only true while you are on, and the pill is derived every
   * tick and comes down by itself the moment you are not.
   */
  const setCameraPreference = (third: boolean): void => {
    thirdPersonPreferred = third;
    if (playerCombat.ridingBike !== 0) {
      rideNudgeText = `camera: ${third ? 'third' : 'first'} person when you get off`;
      rideNudgeT = RIDE_NUDGE_SECONDS;
    }
  };

  /**
   * The wheel: down for third person, up for first.
   *
   * A player found third person by accident, liked it, and asked for the wheel
   * -- which is the right instinct, because it is the gesture every game with a
   * chase camera already uses and `V` is a key nobody finds without reading the
   * list. Both bindings stay, and both write the same `thirdPersonPreferred`.
   * There is no second flag: two toggles over one preference is how a camera ends
   * up in a state neither control can explain.
   *
   * **Accumulated to a threshold rather than acted on per event**, because the
   * two devices that produce this event are nothing alike. A mouse notch is one
   * event of about 100 px and should flip the camera on the spot. A trackpad
   * produces a stream of 2-10 px events for the same physical gesture, and a
   * handler that flipped on each of them would toggle the camera thirty times
   * during one two-finger swipe. `WHEEL_CAMERA_STEP` is a shade under a notch so
   * the mouse keeps its one-gesture-one-flip feel and the trackpad has to mean
   * it. Reversing direction clears the tally rather than unwinding it, so a
   * player who overshoots and comes back gets the flip on the gesture they make
   * next rather than one gesture later.
   *
   * `deltaMode` is normalised because Firefox reports lines and not pixels; an
   * unnormalised threshold is a control that needs a different flick per browser.
   *
   * Passive, and it is the guards below that make that safe. The **map owns the
   * wheel while it is open** -- `bigmap.ts` binds its own non-passive listener on
   * this same window and calls `preventDefault` there -- so this one returns
   * before it counts anything rather than zooming the map and flipping the camera
   * on one flick. The two listeners never fight, in either bind order, because
   * only one of them is ever interested in the event.
   */
  const WHEEL_CAMERA_STEP = 80;
  let wheelCamera = 0;
  window.addEventListener(
    'wheel',
    (e) => {
      // The name prompt is modal, and the three panels each own the screen while
      // they are up: the map is scrolling itself, and the help and the board are
      // being read. A camera that flipped underneath any of them would be a
      // change the player could not see happening.
      // The suggestions box joins the list for a reason of its own: it is the
      // one panel here that **scrolls**, so a wheel over it is a player reading
      // the list rather than asking for a camera.
      if (hud.typing || bigmap.visible || hud.helpVisible || hud.leaderboardVisible || suggestions.visible) {
        wheelCamera = 0;
        return;
      }
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
      const delta = e.deltaY * scale;
      if (delta === 0) return;
      if (delta > 0 !== wheelCamera > 0) wheelCamera = 0;
      wheelCamera += delta;
      if (Math.abs(wheelCamera) < WHEEL_CAMERA_STEP) return;
      // Down -- the direction that pushes the view away from you, which is the
      // one every chase camera in every game zooms out on.
      setCameraPreference(wheelCamera > 0);
      wheelCamera = 0;
    },
    { passive: true },
  );

  document.addEventListener('mousemove', (e) => {
    // Under pointer lock the cursor is captured and only movement deltas exist.
    // Dragging is the fallback, and uses the same deltas.
    if (!locked && !dragging) return;
    input.yaw -= e.movementX * MOUSE_SENSITIVITY;
    input.pitch -= e.movementY * MOUSE_SENSITIVITY;
  });

  // Arrow keys turn as well, so the game is playable even if the mouse path
  // fails entirely.
  const KEY_TURN_RATE = 2.2; // radians per second
  window.addEventListener('keydown', (e) => {
    // The name prompt is modal: while it is up, every binding below is dead and
    // the browser's own form behaviour (Tab between field and button, Enter to
    // join) is left alone. The prompt's field stops propagation of its own
    // keys, but that guard is the focus being *in* the field -- a player who
    // has Tabbed to the join button is past it, and an M pressed there was
    // toggling the map behind the modal. Before `keys.add`, so WASD from the
    // button cannot walk the player either.
    if (hud.typing) return;
    const held = keys.has(e.code);
    keys.add(e.code);
    // The keyboard swing, for the path where pointer lock was refused and the
    // left button is busy turning the camera. `held` makes it edge-triggered:
    // key repeat would otherwise empty the stamina bar on one press.
    if (e.code === 'KeyF' && !held) {
      punchBuffer = PUNCH_BUFFER;
      enableAudio();
    }
    // `L` for the throw, on exactly `F`'s argument: pointer lock can be refused,
    // and a weapon bound only to a mouse button is a weapon that does not exist
    // on that path. Edge-triggered, because key repeat would empty the bar on
    // one press.
    if (e.code === 'KeyL' && !held) {
      throwBuffer = PUNCH_BUFFER;
      enableAudio();
    }
    // `V`: the camera preference, toggled. Edge-triggered like every other toggle
    // here, or key repeat flips it thirty times a second.
    //
    // Through `setCameraPreference`, which the wheel goes through too -- see
    // there for the ride nudge and for why there is one preference and not two.
    // A toggle here and an absolute up/down on the wheel is the difference
    // between the two bindings and the whole of it: a key has no direction and a
    // wheel has nothing but one.
    if (e.code === 'KeyV' && !held) setCameraPreference(!thirdPersonPreferred);
    // `E`: get on the bike beside you, or off the one you are on.
    //
    // Edge-triggered here for the *prediction* and sent as a level bit for the
    // server to edge itself -- see `protocol.BTN.MOUNT`. `keys` carries the
    // level to `simulate`, and this only fires the audio unlock, because the
    // mount itself has to happen inside a fixed step to be predicted at all.
    if (e.code === 'KeyE' && !held) enableAudio();
    if (e.code === 'BracketLeft') sky.advance(-30);
    if (e.code === 'BracketRight') sky.advance(30);
    if (e.code === 'KeyT') sky.setTime(sydneyTime(2026, 2, 15, 15, 0));
    if (e.code === 'KeyN') sky.setTime(sydneyTime(2026, 2, 15, 21, 30));
    if (e.code === 'Minus' || e.code === 'Equal') {
      renderScale = Math.max(0.5, Math.min(1.0, renderScale + (e.code === 'Equal' ? 0.05 : -0.05)));
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * renderScale);
    }
    // `M` opens the city map, which is what this key is now for: the minimap it
    // used to hide is permanent, because it is the compass. See `bigmap.ts`.
    //
    // Edge-triggered on `held` like the swings and the control list, or key
    // repeat flickers a full-screen panel on and off at the repeat rate.
    //
    // Opening it closes the other two panels rather than drawing over them --
    // `hud.setLeaderboard`'s own rule, applied in the same direction: of two
    // panels wanting the screen, the one being asked for *now* wins. The board
    // is held on a key, so it can only be up here if the player is holding Tab
    // and pressing M, and the map is the deliberate act of the two.
    if (e.code === 'KeyM' && !held) {
      bigmap.toggle();
      if (bigmap.visible) {
        hud.setHelp(false);
        hud.setLeaderboard(false);
        suggestions.close();
      }
    }
    // The diagnostics, moved off `Tab` this pass to make room for the board.
    // The backquote is the console key in every game that has one and is not
    // bound to anything a player does.
    if (e.code === 'Backquote') {
      e.preventDefault();
      hud.toggleDebug();
    }
    // The full control list, toggled. The compact block in the bottom-right
    // corner is always on the screen and says which key this is.
    //
    // Edge-triggered on `held` like the two swings above, or holding the key
    // flickers the panel at the key-repeat rate. (The name-prompt case is the
    // modal return at the top of this listener.)
    // The map goes with it, on the same rule the map applies to the other two:
    // the panel being asked for now wins, and the control list is a thing you
    // open having stopped playing to look something up.
    if (e.code === 'KeyH' && !held) {
      hud.toggleHelp();
      if (hud.helpVisible) {
        bigmap.close();
        // The control list grows out of the same bottom-right corner the
        // suggestions box occupies, so of the two panels this is the one pair
        // that would genuinely overlap rather than merely coexist.
        suggestions.close();
      }
    }
    // `I` opens the chat box. See `client/src/chat.ts`.
    //
    // This branch only ever *opens*: closing is the box's own keydown listener,
    // because the moment it is open `hud.typing` is true and this listener has
    // already returned at its first line. That is not an accident of ordering,
    // it is the interlock -- the same one the name prompt has -- and it is what
    // gives the composer Escape ahead of the control list, the map and any other
    // panel bound in here. Nothing below can see a key while text is being
    // typed.
    //
    // Edge-triggered on `held` like every other toggle here, or key repeat would
    // fight the guard at the repeat rate. `preventDefault` because an `i` that
    // reached the field would open the box with an "i" already in it.
    if (e.code === 'KeyI' && !held) {
      e.preventDefault();
      chat.openBox();
      // The panels go, on the rule the map applies to the other two: the thing
      // being asked for now wins, and a text box under a full-screen map is a
      // text box nobody can see themselves typing into.
      bigmap.close();
      hud.setHelp(false);
      // And the suggestions box, which has text fields of its own -- two text
      // UIs open at once is two things with a claim on the next keystroke.
      suggestions.close();
    }
    // Escape: **close whatever is open, or -- if nothing is -- open the
    // suggestions box.** The user asked for that key; this is how it shares.
    //
    // The rule the old comment stated is preserved exactly: *this key never puts
    // something up while something is up*. The new behaviour lives entirely in
    // the branch where the key previously did nothing at all, so every existing
    // reflex -- Escape to get rid of the map, Escape to get rid of the control
    // list -- is unchanged, and no press that used to close something now opens
    // something instead.
    //
    // `anyOpen` is sampled **before** anything is closed, which is the whole of
    // the correctness here. Reading it afterwards would find nothing open (this
    // branch just closed it) and open the box on the same press that dismissed
    // the map -- a panel appearing in the corner as a direct result of asking for
    // one to go away.
    //
    // Under pointer lock the browser eats this keydown to release the pointer
    // and the page never sees it, so in practice the first Escape gives the
    // cursor back and the second reaches here. That is the same two-press shape
    // the control list has always had, it cannot be changed from script, and for
    // this panel it is the right sequence anyway: the box has buttons in it and
    // needs the cursor, so the press that frees the pointer is not a wasted one.
    // `index.html`'s `#help` block says "esc — suggestions" so the first press is
    // not a mystery.
    //
    // The chat composer and the name prompt never reach this line: while either
    // has the keyboard `hud.typing` is true and this listener returned at its
    // first statement. The suggestions panel's own compose fields do the same,
    // through `hud.suggestTyping`, which is why closing it *from the textarea* is
    // handled in `suggestions.ts` rather than here.
    if (e.code === 'Escape') {
      const anyOpen = hud.helpVisible || bigmap.visible || hud.leaderboardVisible || suggestions.visible;
      hud.setHelp(false);
      bigmap.close();
      if (suggestions.visible) suggestions.close();
      else if (!anyOpen) suggestions.open();
    }
    // The scoreboard, **held** rather than toggled. See `index.html`.
    //
    // `preventDefault` is not optional here and is the reason this is in a
    // keydown at all: `Tab` moves the focus, and in a page whose only focusable
    // element is the join button, one press takes the keyboard away from the
    // game and the next Enter presses a button that is no longer there. The
    // guard is on the keydown *and* the keyup, because a browser will act on
    // either.
    if (e.code === 'Tab') {
      e.preventDefault();
      // Not gated on `held`: key repeat while it is already shown is a no-op
      // inside `setLeaderboard`, which is a boolean compare.
      hud.setLeaderboard(true);
      // And the map, which the board would otherwise be read through -- both
      // are centred and the map is the larger of the two. Same no-op contract as
      // above, so a held key costs a boolean compare either way.
      bigmap.close();
      // And the suggestions box, on the same rule -- and with one extra reason
      // the others do not have: Tab is the key that moves focus *into* its
      // fields, so a board held on Tab over an open compose box would be a board
      // that types into it.
      suggestions.close();
    }
  });
  window.addEventListener('keyup', (e) => {
    keys.delete(e.code);
    if (e.code === 'Tab') {
      e.preventDefault();
      hud.setLeaderboard(false);
    }
  });
  // And on losing focus, which is the case a keyup never arrives for: alt-tabbing
  // out with the board up would otherwise leave it on screen for the rest of the
  // session, because the key it is held with is released in another window.
  window.addEventListener('blur', () => {
    keys.clear();
    hud.setLeaderboard(false);
  });
  // Resize handling has to tolerate a zero-sized window. A browser window that
  // is minimised or off-screen reports innerWidth 0, and setting a 0x0 drawing
  // buffer leaves the canvas permanently blank -- it does not recover on its own
  // when the window comes back, because no further resize event is guaranteed.
  const applySize = (): void => {
    // The floor is on the *drawing buffer*, not the CSS size. A 1 px canvas
    // multiplied by a render scale below 1 floors to a zero-sized drawing
    // buffer, which produces an invalid swapchain texture and an endless stream
    // of "invalid bind group" validation errors with nothing drawn.
    const minCss = Math.ceil(8 / Math.max(renderScale, 0.1));
    const w = Math.max(window.innerWidth, minCss);
    const h = Math.max(window.innerHeight, minCss);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * renderScale);
    renderer.setSize(w, h);
  };
  window.addEventListener('resize', applySize);
  // A ResizeObserver also fires when the element gains a size again after the
  // window was hidden, which a resize event alone may not.
  new ResizeObserver(applySize).observe(canvas);
  applySize();

  // --- The fight, one fixed step at a time.
  //
  // This is the loop a server runs, and it is written to be lifted: inputs are
  // collected, every combatant is advanced in id order, and a strike is resolved
  // against the state as it stands. Nothing inside it reads a frame delta, a
  // camera or the DOM. The three functions below it are the presentation side of
  // the seam -- they are handed a report and turn it into noise and shake, and a
  // server would simply not have them.
  const hitReport: HitReport = { attacker: 0, victim: 0, ko: false, health: 0, point: new Vector3() };
  /** Reused across ticks, so the common case -- nothing collected -- allocates nothing. */
  const pickups: PickupEvent[] = [];
  /** Beyond this, someone else's bat going through the air is not worth a sound. */
  const WHIFF_AUDIBLE = 7;
  /** Beyond this, somebody else's throw is not worth a sound. */
  const THROW_AUDIBLE = 60;
  /** Beyond this, a ball bouncing on the pavement is not worth a sound. */
  const BOUNCE_AUDIBLE = 40;

  /**
   * The local player's own footballs, simulated in this process.
   *
   * Online this holds **only your own throws**, and that is the whole of the
   * prediction story for this weapon: your ball leaves your hand on the frame
   * the button goes down, flies through the same `game/footy.ts` the server is
   * flying its copy through, and is never handed off to anything. The
   * authoritative copy of your own ball exists -- it is what actually decides
   * whether you hit somebody -- and `net/client.ts` deliberately does not draw
   * it, because it is 100 ms behind this one and drawing both would be two
   * balls. See `RemoteBall` there for the argument in full.
   *
   * Offline it holds **every** ball in the world, because offline the client is
   * the authority and runs exactly what the server would. That is the same class
   * doing the same job either way, which is what keeps the offline path a real
   * test of the online one rather than a parallel implementation.
   */
  const localBalls = new FootyField();
  /** Reused across ticks, so a tick with nothing happening allocates nothing. */
  const ballEvents: FootyEvent[] = [];
  /** `applyFootyHit` takes its report rather than allocating one. See `combat.createHitReport`. */
  const ballReport = createHitReport();

  function onHit(r: HitReport): void {
    audio.thwack(r.ko);
    if (r.attacker === playerCombat.id) {
      feedback.hitLanded(r.ko);
      // The bat is arrested and the hands ring on. 90 ms, which is exactly
      // `combat.HITSTOP`, so the shudder runs over the frames the simulation is
      // frozen for and the two read as one event -- see `BatViewmodel.connect`.
      viewmodel.connect();
    }
    if (r.victim === playerCombat.id) {
      if (r.ko) feedback.knockedOut();
      else feedback.hitTaken();
    }
  }

  /**
   * The same, for a ball landing on somebody. Offline only -- online the server
   * decides and `netHandlers().onHit` is the equivalent.
   *
   * Deliberately **not** `onHit`, and the difference is the one line: no
   * `viewmodel.connect()`. That shudder is a bat being arrested in your hands,
   * and the thing that was arrested here is a ball you let go of half a second
   * ago and thirty metres away. The sound is the caller's, because it has the
   * range and this does not.
   */
  function onFootyHit(r: HitReport): void {
    if (r.attacker === playerCombat.id) feedback.hitLanded(r.ko);
    if (r.victim === playerCombat.id) {
      if (r.ko) feedback.knockedOut();
      else feedback.hitTaken();
    }
  }

  /** Which fighter threw a given ball, for the offline adjudication. */
  function fighterOf(id: number): Fighter | undefined {
    return fighters.find((f) => f.combat.id === id);
  }

  /** How far away someone else's pickup is still worth a sound. */
  const PICKUP_AUDIBLE = 22;

  /**
   * Spec 8.3's pickup feedback, on the same terms as `onHit`: handed a report,
   * turns it into noise and animation, and a server would not have it.
   *
   * The Training gag plays on whoever took it, dummy or player -- the spec's
   * "sprinting on the spot with comically fast legs" is funnier on someone
   * else's body than on your own shadow, and the aggressor collecting a
   * Training and then hitting you for 1.4 is the emergent case this whole
   * arrangement exists to allow.
   */
  function onPickup(e: PickupEvent): void {
    const mine = e.combatant.id === playerCombat.id;
    const range = Math.hypot(
      e.point.x - player.position.x,
      e.point.z - player.position.z,
    );
    if (mine || range < PICKUP_AUDIBLE) {
      if (e.point.kind === TRAINING) audio.pickupTraining();
      else audio.pickupFlatWhite();
    }
    if (e.point.kind === TRAINING) {
      const fighter = fighters.find((f) => f.combat === e.combatant);
      fighter?.driver.celebrate();
    }
    // The Flat White has no gag of its own and needs none: the FOV kick and the
    // buzz start on the next frame and run for thirty seconds, which is a much
    // louder confirmation than a 1.2 s animation would be. Spec 8.3 asks for
    // the camera and gives the pickup animation only to Training.
  }

  /** Reused by `reconcile`: the eased camera offset it owes. */
  const netCorrection = new Vector3();
  /** Reused by the offline bike sweep, so a tick with nobody riding allocates nothing. */
  const riderViews: RiderView[] = [];
  const bikeSweep: ReturnType<BikeField['follow']> = [];

  /**
   * A name for the kill feed.
   *
   * `you` for yourself, because a feed that says "Bazza batted Shazza" when one
   * of them is the person reading it has buried the only line they care about in
   * a list of names. Everybody else comes off `net.nameOf`, which is fed by the
   * roster and deliberately keeps a name after its owner has left -- see
   * `net/client.ts`, where that is what makes "Shazza left" possible at all.
   *
   * The `player N` at the bottom is unreachable in practice and is kept as the
   * honest answer rather than a guess: it needs a HIT event naming somebody no
   * roster has ever mentioned, which is a lost frame at the exact moment a
   * stranger swung.
   */
  function who(id: number): string {
    if (net && id === net.id) return 'you';
    return net ? net.nameOf(id) : `player ${id}`;
  }

  function pushKill(line: string): void {
    kills.unshift(line);
    // Four lines. The debug overlay is already fourteen and a feed that grew
    // would push the frame cost off the top of the screen, which is the one line
    // on it that is read every session.
    if (kills.length > 4) kills.length = 4;
  }

  /**
   * Everything the net layer hands back, turned into noise, shake and geometry.
   *
   * The mirror image of `onHit`/`onPickup` below, and it has to be: online the
   * *server* decided, so this runs on a report rather than producing one. The
   * two paths converge on the same three presentation calls, which is what keeps
   * a landed hit feeling identical whether it was adjudicated 30 ms away or in
   * this process.
   */
  function netHandlers(): ConstructorParameters<typeof NetClient>[1] {
    return {
      onHit(attacker, victim, ko, footy, health) {
        // **An event whose attacker is its own victim is a car.**
        //
        // Nobody swung; the world did. There is no room in `net/protocol.ts`'s
        // HIT record for an attacker-less cause and there did not need to be:
        // a player cannot hit themselves by any other route in this game, so the
        // identity is a free sentinel and the traffic cost the protocol nothing
        // at all -- which is the whole design of `game/traffic.ts`.
        //
        // The local player has already felt this: the shove and the shake were
        // predicted in `simulate` on the frame the car arrived, from the same
        // pure function the server just used. So all that is wanted here is the
        // feed line. Somebody *else* being run down was not predicted at all --
        // this client only evaluates the traffic against its own body -- so that
        // one gets the sound as well, if it happened near enough to hear.
        if (attacker === victim) {
          const own = net !== null && victim === net.id;
          if (!own) {
            const them = net?.remotes.get(victim);
            const range = them
              ? Math.hypot(them.position.x - player.position.x, them.position.z - player.position.z)
              : Infinity;
            if (range < BOUNCE_AUDIBLE) audio.thwack(ko);
          }
          if (ko) pushKill(`${who(victim)} got run down`);
          return;
        }
        // A thrown ball landing on somebody is a different noise from a bat --
        // see `game/audio.ts`. The bat's connect kick on the viewmodel is not
        // fired for a ball, because the thing that was arrested was the ball and
        // your hands are nowhere near it.
        if (footy) audio.footyHit(ko);
        else audio.thwack(ko);
        const mine = net !== null && attacker === net.id;
        const theirs = net !== null && victim === net.id;
        if (mine) {
          feedback.hitLanded(ko);
          if (!footy) viewmodel.connect();
        }
        if (theirs) {
          if (ko) feedback.knockedOut();
          else feedback.hitTaken();
        }
        void health;
        if (ko) pushKill(`${who(attacker)} ${footy ? 'pegged' : 'batted'} ${who(victim)}`);
      },
      onBounce(x, y, z, bounces) {
        const range = Math.hypot(x - player.position.x, z - player.position.z);
        if (range < BOUNCE_AUDIBLE) audio.footyBounce(range, bounces);
        void y;
      },
      onPickup(combatant, kind, tileKey, index) {
        // Spec 8.3 is server-authoritative online, so the local field is a
        // mirror: the point is taken out of the world and its own respawn clock
        // -- which both ends compute from the same constants -- runs it back in.
        const point = powerups.find(`${tileKey}:${index}`);
        if (point) {
          point.active = false;
          point.respawnT = respawnSeconds(kind);
        }
        const mine = net !== null && combatant === net.id;
        const range = point
          ? Math.hypot(point.x - player.position.x, point.z - player.position.z)
          : Infinity;
        if (mine || range < PICKUP_AUDIBLE) {
          if (kind === TRAINING) audio.pickupTraining();
          else audio.pickupFlatWhite();
        }
        if (kind === TRAINING) {
          if (mine) selfDriver.celebrate();
          else remotes.get(combatant)?.actor.setAction('run');
        }
      },
      onJoin(id, colourway, bot) {
        if (net && id === net.id) return;
        // The name is already here: the server sends the roster ahead of the
        // join events on purpose, so this line can be written with a name in it
        // rather than with the id of somebody the feed will be calling Shazza a
        // frame later. See `server/index.ts`'s `runTick`.
        pushKill(`${who(id)} joined`);
        void colourway;
        void bot;
      },
      onLeave(id) {
        dropRemoteActor(id);
        pushKill(`${who(id)} left`);
      },
      /**
       * Somebody walked out of interest. PERFORMANCE.md phase 2.
       *
       * The **same disposal** as `onLeave` and deliberately not a line in the
       * feed: under interest management this fires every time anybody crosses
       * 220 m, which in a 128-player room is constantly. Releasing the rig is
       * the whole job, and it is the same call because the memory question is
       * identical -- the actor, its footy and bat props, and its bike all go
       * back, and `nameplates` drops the plate on its next `begin` because the
       * remote is no longer in `net.remotes`.
       */
      onDrop(id) {
        dropRemoteActor(id);
      },
      onStatus(status, detail) {
        if (status === 'online') hud.notice('');
        else if (status === 'refused') hud.notice(`server refused the connection: ${detail}`);
        else if (status === 'offline') hud.notice(`disconnected: ${detail}`);
      },
      /**
       * Somebody said something, anywhere on the server.
       *
       * Straight into the chat log and deliberately **not** into `kills`. The
       * two are adjacent and distinct: the feed is four lines of things that
       * happened to bodies, held by this file and drawn in the diagnostics
       * overlay; the chat is eight lines of things people said, held by
       * `ChatBox` with its own expiry. Sharing one list would mean a busy
       * conversation pushing out the line that says who knocked you down.
       */
      onChat(line) {
        chat.push(line);
      },
      /*
       * The suggestion list, straight into the panel and held nowhere else.
       *
       * It arrives on an open (the panel asked) and unasked whenever somebody
       * anywhere on the host votes -- which is what makes two people voting
       * beside each other one list rather than two. `show` is a no-op when the
       * panel is shut, so an arrival for a closed panel costs a field write.
       */
      onSuggestions(list) {
        suggestions.show(list);
      },
      onSuggestAck(result, issue, message) {
        suggestions.ack(result, issue, message);
      },
    };
  }

  function respawnPlayer(): void {
    const spot = pickRespawn(player.position.x, player.position.z, combatWorld);
    if (spot) {
      respawnAt(playerCombat, spot.x, spot.y, spot.z, input.yaw);
    } else {
      // Nothing qualified -- a tile whose terrain has not arrived, or a
      // courtyard with no 3 m of clear ground in it. Getting up where you fell
      // is worse than spec 8.2's clause and infinitely better than lying on the
      // pavement forever, which is what a silent failure here would be.
      const x = player.position.x;
      const z = player.position.z;
      respawnAt(playerCombat, x, groundHeightAt(x, z, -Infinity), z, input.yaw);
    }
    // The look is the player's, not the state's: `controller.step` writes
    // `input.yaw` into the body every tick, so a respawn that only set the body
    // would be overwritten on the next one. Pitch is levelled because you have
    // just got up off the ground.
    input.pitch = 0;
    punchBuffer = 0;
    throwBuffer = 0;
    void ensureGround(player.position.x, player.position.z);
  }

  /**
   * Scratch for the offline unstuck. Two route arrays and a pose, for the reason
   * `server/sim.ts` keeps two: the traffic test runs *inside* the road search's
   * own result, and one shared array would have the car query rewriting the list
   * the search is walking.
   */
  const unstuckRoutes: LaneRoute[] = [];
  const unstuckCarRoutes: LaneRoute[] = [];
  const unstuckCarPose = createCarPose();
  /** When `/unstuck` was last served offline, for the same cooldown the server keeps. */
  let unstuckAt = -Infinity;

  /**
   * `/unstuck`, offline: the server's rule, run by the only authority there is.
   *
   * `?offline` is spec 9's local stub and the client simulates the whole world
   * itself there, so this is the same `unstuckDestination` the server calls, over
   * the same `combatWorld` every other placement in this file uses and the same
   * `TrafficField` the cars are driven from. The refusals are the same two the
   * server applies for the same reasons -- see `ChatHub.unstuck`.
   *
   * The one honest difference is **coverage**, and it is a property of streaming
   * rather than a decision: the server holds every lane graph in the extent and
   * this holds the resident tiles, so the 800 m and 1.6 km rungs of the ladder
   * reach less far offline than they do online. It costs nothing at the radius
   * that was asked for -- 200 m is comfortably inside the streamer's ring -- and
   * `isSpawnable` refuses unbuilt ground anyway, so the failure mode is a
   * narrower search rather than a teleport into the dark.
   *
   * No death is recorded here either, which offline means the local `downs` is
   * untouched and nothing reaches the kill feed.
   */
  function unstuckLocally(): void {
    if (playerCombat.phase === 'ko') {
      chat.system(UNSTUCK_KO_NOTICE);
      return;
    }
    const now = performance.now();
    if (now - unstuckAt < UNSTUCK_COOLDOWN_MS) {
      chat.system(unstuckWaitNotice(UNSTUCK_COOLDOWN_MS - (now - unstuckAt)));
      return;
    }

    const fromX = player.position.x;
    const fromZ = player.position.z;
    const carTick = trafficTick(Date.now());
    const spot = unstuckDestination(
      fromX,
      fromZ,
      (radius) => traffic.near(fromX, fromZ, radius, unstuckRoutes),
      combatWorld,
      Math.random,
      // Not in front of a car, on exactly `Simulation.unstuck`'s terms and with
      // the same vertical test: the fleet is a pure function of the wall clock,
      // so this is the same set of cars that file would have seen.
      (x, z, y) => {
        let clear = true;
        forEachCarNear(traffic, x, z, UNSTUCK_CAR_CLEAR_M, carTick, unstuckCarRoutes, unstuckCarPose, (car) => {
          if (car.y > y + 4 || car.y + car.height < y - 4) return;
          clear = false;
          return true;
        });
        return clear;
      },
    );
    if (spot) {
      unstuckAt = now;
      player.position.set(spot.x, spot.y + EYE_HEIGHT, spot.z);
      player.velocity.set(0, 0, 0);
      player.onGround = true;
      // Not `respawnAt`: health, stamina, the coffees and the bat's clock are all
      // left exactly as they were. `server/sim.unstuck` says why at length -- a
      // free heal on a ten-second cooldown is the one way this could decide a
      // fight. The bike is the single exception, and it is dropped for the reason
      // a respawn drops it: it stays parked where it was, and riding one from
      // 200 m away would drag it across Redfern.
      playerCombat.ridingBike = 0;
      // The destination is almost always a tile away, so the terrain for it is
      // fetched on the same terms the respawn fetches its own.
      void ensureGround(spot.x, spot.z);
    }
    chat.system(unstuckReply(spot));
  }

  function simulate(dt: number): void {
    // Every input first, from the state as it stands at the top of the tick. A
    // dummy that thought *during* the loop would be reacting to a player who had
    // already moved this step -- half a tick of clairvoyance no remote player
    // will ever have, and the kind of asymmetry that only shows up as "the AI
    // feels unfair".
    for (const d of dummies) d.think(playerCombat, dt);

    // Both weapons are refused while riding, and refused rather than made to
    // dismount you.
    //
    // The other reading -- a click gets off the bike and swings -- was rejected
    // on one case: you are doing 26 m/s and you click. Dismounting there puts a
    // player on the pavement at a speed the controller's friction takes half a
    // second to shed, sliding past whatever they meant to hit, having pressed a
    // button that in every other frame of this game swings a bat. A no-op with a
    // nudge is legible; a no-op with no nudge is a bug. So the buffer is *held*
    // rather than dropped, and the swing comes out on the frame you get off,
    // which is what a player who pressed it a moment early actually wanted.
    const armed = playerCombat.ridingBike === 0;
    input.punch = armed && punchBuffer > 0;
    input.throwBall = armed && throwBuffer > 0;
    if (!armed && (punchBuffer > 0 || throwBuffer > 0) && rideNudgeT <= 0) {
      rideNudgeT = RIDE_NUDGE_SECONDS;
      rideNudgeText = RIDE_PROMPT;
    }
    if (armed) {
      punchBuffer = Math.max(0, punchBuffer - dt);
      throwBuffer = Math.max(0, throwBuffer - dt);
    }
    rideNudgeT = Math.max(0, rideNudgeT - dt);
    // The ride pill, **derived and re-derived every tick**, which is the whole
    // of the fix for "I died on bike and saw E to get off bike forever".
    //
    // Nothing above put a message on the screen and nothing below takes one off.
    // `bikes.ridePrompt` is asked what is true, `hud.derived` makes the pill
    // match, and a ride that ends by any route at all -- `E`, a bat, a football,
    // a Camry, a police round, a knockout, a server correction, a disconnect --
    // ends the line on the very next tick, because the answer to the question
    // changed. There is no path left that can strand it, which is the property
    // that was actually missing.
    hud.derived(ridePrompt(playerCombat, playerCombat.phase, rideNudgeT, rideNudgeText));

    // Reconciliation, at the top of the tick and before anything is advanced.
    //
    // Here rather than in the render loop so a correction is folded in and then
    // *predicted forward on the same tick*, which is what makes it invisible: a
    // correction applied after the step would be a position the renderer draws
    // for one frame and the simulation then moves away from, which is a
    // one-frame jitter at 20 Hz -- the exact artefact the 80 ms ease exists to
    // remove, reintroduced by ordering.
    if (net) net.reconcile(playerCombat, combatWorld, netCorrection);

    // --- The bike, after reconciliation and before the step.
    //
    // After, so a server correction that took the bike away this tick is
    // reflected before `E` is read; before, so the tick a player mounts on is
    // the tick they get the speed rather than the one after. `server/sim.ts`
    // resolves it in the same place in its own loop, which is what keeps the
    // prediction exact.
    //
    // The whole of what is predicted here is `ridingBike`. `combat.advance`
    // turns that into a speed through `bikes.shapeRideInput` -- the same
    // function the server calls -- so nothing about the *multiplier* is decided
    // on this side at all, and a client that edited these lines would move at
    // its own speed for exactly as long as it takes the next snapshot to arrive.
    input.mount = keys.has('KeyE');
    if (input.mount && !mountHeld && playerCombat.phase !== 'ko') {
      const field = bikeWorld();
      if (playerCombat.ridingBike !== 0) {
        // Off. Offline this parks the bike here and now; online the server does
        // it, and the sweep below is a no-op because `net.bikes` is a mirror.
        const wasRiding = playerCombat.ridingBike;
        playerCombat.ridingBike = 0;
        if (!net) {
          field.release(
            wasRiding,
            player.position.x,
            player.position.y - EYE_HEIGHT,
            player.position.z,
            player.yaw,
          );
        }
        net?.predictedBikeChange();
        // No `hud.notice('')` here any more, and its absence is the point. It
        // used to be the one line in the client that took the ride nudge down,
        // which made every other way to stop riding a way to strand it. The
        // pill is derived at the top of this function now, so getting off with
        // `E` clears it for the same reason getting knocked off does: the
        // question is asked again and the answer is different.
      } else {
        const bike = field.nearestFree(player.position.x, player.position.y - EYE_HEIGHT, player.position.z);
        if (bike && field.claim(bike.id, playerCombat.id)) {
          playerCombat.ridingBike = bike.id;
          net?.predictedBikeChange();
          audio.pickupFlatWhite();
        }
      }
    }
    mountHeld = input.mount;

    // --- Redfern, offline.
    //
    // Online this is the server's and arrives as `FLAG.TUNED` -- see
    // `server/sim.ts`, which is the only thing that may set it. Offline the
    // client *is* the server, so the same rule runs here against the same
    // function, which is what makes `?offline` a real test of the feature.
    if (!net && !playerCombat.bikeTuned) {
      const feet = player.position.y - EYE_HEIGHT;
      if (inTuningZone(player.position.x, feet, player.position.z, groundHeightAt(player.position.x, player.position.z, feet))) {
        playerCombat.bikeTuned = true;
      }
    }

    for (const f of fighters) {
      const events = advance(f.combat, f.input, dt, combatWorld);

      // A buffered click is spent the moment it produces a swing, so one press
      // is one swing even if the buffer has 100 ms left on it.
      if (events.punched && f.combat === playerCombat) punchBuffer = 0;
      if (events.ballThrown && f.combat === playerCombat) throwBuffer = 0;

      // The bat going through the air, on the tick the swing **starts** rather
      // than on the tick it misses.
      //
      // That is a change the weapon made. A fist that hit nothing was worth a
      // small apologetic hiss, and a bat displaces enough air that the whoosh is
      // the swing itself -- it happens whether or not anything is in the way, it
      // happens 150 ms before the hit test fires, and a connect then lands a
      // crack on top of it, which is the sequence a bat actually makes. It also
      // fixes a gap the miss-triggered version had: **online there is no miss
      // event**, because who was hit is the server's answer, so a swing that
      // connected with nothing used to be silent.
      if (events.punched) {
        const mine = f.combat === playerCombat;
        if (
          mine ||
          Math.hypot(
            f.combat.body.position.x - player.position.x,
            f.combat.body.position.z - player.position.z,
          ) < WHIFF_AUDIBLE
        ) {
          audio.whiff();
        }
      }

      // Online, **nothing below adjudicates anything**. The swing's phases and
      // the footy supply are still predicted locally -- that is what makes the
      // animation and the HUD respond on the next frame rather than the next
      // round trip -- but who was hit is the server's answer and arrives as an
      // event. Resolving it here as well would double every hit: once wrongly,
      // against remotes drawn 100 ms in the past, and once correctly 30 ms
      // later.
      if (events.strike && !online) {
        const target = hitTest(f.combat, combatants);
        if (target) {
          applyHit(f.combat, target, hitReport);
          onHit(hitReport);
        }
        // No `else`. The whoosh already played when the swing started, above,
        // and a miss is now the *absence* of the crack rather than a sound of
        // its own -- which is what makes offline and online feel identical.
      }

      // ...and the same swing, against the bystanders.
      //
      // **This runs online as well as off**, unlike the swing above it, and the
      // reason is the traffic's exactly: a pedestrian depends on nothing but the
      // clock and the world files. There is no remote to be 100 ms wrong about,
      // so nothing here is a guess that has to be corrected -- which is what
      // lets it happen on the frame the button goes down.
      //
      // It is a *separate* test rather than a bigger target list, because a
      // pedestrian is not a `CombatantState` and making them one would put
      // nineteen thousand extras in the tick order, the snapshot, the rewind
      // buffer and the roster. `strikePedestrian` borrows the swing's own cast,
      // reach and radii out of `combat.ts` and asks the identical question of a
      // different subject -- see its header.
      //
      // Only the local player's swings are tested. A remote's arrives as a
      // snapshot phase rather than as a `strike` event, and this wave is
      // deliberately client-local: the ped a remote knocks over is knocked over
      // on *their* screen and nowhere else. That stops being true the moment the
      // police pass subscribes to the seam and puts it on an authoritative
      // channel, which is what the seam is for.
      if (events.strike && f.combat === playerCombat) {
        const tick = trafficTick(Date.now());
        const struck = strikePedestrian(pedestrians, f.combat, tick, pedBands, pedPose);
        // ...and the police, if anybody was watching.
        //
        // **Predicted, not decided.** `server/sim.ts` re-runs the identical
        // `strikePedestrian` against its own bands at its own tick and opens the
        // investigation off *that* -- nothing here crosses the wire. What this
        // buys is the banner appearing on the frame the bat connects rather than
        // a third of a second later, which is the same trade the bike mount
        // already makes and costs the same thing when it is wrong: a banner that
        // clears itself on the next authoritative message.
        if (struck !== null) accuse(struck.x, struck.z, REASON.ASSAULT, tick);
        // And whatever faction actor the swing reached. An officer is a crime
        // that needs no witness -- the officer you just hit is the witness --
        // and everybody else asks their own faction what hitting them means:
        // `streetlife.strikeCrime` says a meth head is never a crime because
        // they came at you, and a drunk is one only while they are still calm.
        // Offline this is the whole adjudication; online the server has already
        // done it against its own actors and this is the prediction.
        const cp = Math.cos(f.combat.body.pitch);
        const ax = f.combat.body.position.x;
        const ay = f.combat.body.position.y;
        const az = f.combat.body.position.z;
        const hit = npcHitTest(
          policeField(),
          ax, ay, az,
          ax - Math.sin(f.combat.body.yaw) * cp * REACH,
          ay + Math.sin(f.combat.body.pitch) * REACH,
          az - Math.cos(f.combat.body.yaw) * cp * REACH,
          CAST_RADIUS,
        );
        if (hit !== null) {
          // Read before the strike, never after: `strikeNpc` may put them on the
          // ground, and whether this was a crime is a question about the person
          // who was standing there a moment ago. `server/sim.hitNpc` states the
          // same rule on its own side.
          // A protected native is the third case and it is the *unconditional*
          // one: a turkey, an ibis or a magpie is a crime whether or not
          // anybody saw it, because all three are protected under the NPW Act
          // and because the whole instruction was "u get police attack u if u
          // hurt one (u have to run)". A witness test would make that
          // "sometimes", which is a rule a player never learns. See
          // `game/wildlife.ts` section 3, and `server/sim.hitNpc`, which reaches
          // the identical answer through `reportWildlifeCrime`.
          const wild = isProtected(hit.kind);
          const crime = hit.kind === NPC_KIND.POLICE
            ? REASON.ASSAULT_POLICE
            : wild
              ? REASON.WILDLIFE
              : strikeCrime(hit);
          if (!online) {
            const strike = strikeNpc(factions, hit, 1, playerName, playerCombat.id, tick);
            if (strike.landed) audio.thwack(strike.down);
          }
          if (hit.kind === NPC_KIND.POLICE || wild) predictInvestigation(crime);
          else if (crime !== REASON.NONE) accuse(hit.x, hit.z, crime, tick);
        }
      }

      // The throw. Unlike every other weapon event in this loop, this one runs
      // **online as well as off**, and that is the prediction: a ball put in the
      // air here flies through the same shared simulation the server is flying
      // its own copy through, so it leaves the hand on this frame rather than on
      // the next round trip. What it deliberately does *not* do online is
      // adjudicate -- see the ball step below, which passes an empty target list
      // when a server is deciding.
      //
      // Offline every fighter throws into this field; online only the local
      // player does, because a remote's throws arrive already in flight in the
      // snapshot stream and simulating them here as well would draw two balls.
      if (events.ballThrown && (!online || f.combat === playerCombat)) {
        localBalls.add(f.combat);
        // The body throwing it. On the local player this is the shadow-layer
        // self, so what you see of your own is a throwing shadow on the footpath
        // beside your bat's; on a dummy it is the whole gesture. See
        // `ActorDriver.threw` for why this is a call rather than something
        // `update` could derive.
        f.driver.threw();
        audio.footyThrow(
          f.combat === playerCombat
            ? 0
            : Math.hypot(
                f.combat.body.position.x - player.position.x,
                f.combat.body.position.z - player.position.z,
              ),
        );
      }

      if (events.respawnDue && !online) {
        if (f.dummy) f.dummy.respawn(characterGround);
        else respawnPlayer();
      }
    }

    // --- The bikes, offline, after every combatant has moved.
    //
    // `server/sim.ts` runs the identical sweep in the identical place, and the
    // whole of what it does is carry a ridden bike to its rider and park any
    // whose rider has stopped riding. Offline that is what drops the bike when
    // the player is batted off it -- `combat.applyHit` cleared `ridingBike` and
    // knows nothing about bikes -- and what parks it on a knockout and a
    // respawn.
    //
    // Online this is skipped entirely: `net.bikes` is a mirror the server
    // corrects, and sweeping it here would be this client inventing state that
    // the next `MSG.BIKES` would contradict.
    if (!online) {
      riderViews.length = 0;
      for (const f of fighters) {
        riderViews.push({
          id: f.combat.id,
          ridingBike: f.combat.ridingBike,
          x: f.combat.body.position.x,
          feetY: f.combat.body.position.y - EYE_HEIGHT,
          z: f.combat.body.position.z,
          yaw: f.combat.body.yaw,
        });
      }
      localBikes.follow(riderViews, bikeSweep);
    }

    // --- Every football in the air, after every combatant has moved.
    //
    // The order is the one the server uses and it matters for the same reason
    // the pickups' does: a ball tested against last tick's positions would hit
    // people where they were rather than where they are, which at a sprint is
    // 14 cm and at a knockback is two metres.
    //
    // **The target list is empty online**, and that one substitution is the whole
    // of "server-authoritative projectile" on this side. The ball is still flown
    // here -- that is what makes it appear instantly and follow a believable arc
    // between snapshots -- but who it *hits* is the server's answer and arrives
    // as an event 30 ms later. Adjudicating here as well would double every hit:
    // once wrongly, against remotes drawn 100 ms in the past, and once correctly.
    // It is the identical argument the swing's `!online` guard makes above.
    for (const e of localBalls.step(dt, combatWorld, online ? EMPTY_COMBATANTS : combatants, ballEvents)) {
      const range = Math.hypot(e.ball.x - player.position.x, e.ball.z - player.position.z);
      if (e.kind === 'bounce') {
        if (range < BOUNCE_AUDIBLE) audio.footyBounce(range, e.ball.bounces);
      } else if (e.kind === 'splash') {
        if (range < BOUNCE_AUDIBLE) audio.footySplash(range);
      } else if (e.kind === 'hit' && e.victim) {
        // Offline only, by construction: `targets` is empty when a server is
        // deciding, so this branch cannot fire online.
        applyFootyHit(fighterOf(e.ball.thrower)?.combat ?? playerCombat, e.victim, e.ball, ballReport);
        audio.footyHit(ballReport.ko);
        onFootyHit(ballReport);
      }
    }

    // ...and every ball still in the air, against the bystanders.
    //
    // Swept rather than event-driven, because `stepFooty` decides who it hit out
    // of a target list this deliberately stays out of -- see `strikePedestrian`
    // above on why a pedestrian is not a `CombatantState`. So the balls are
    // re-tested here against the crowd, using the same `combat.segmentDistance`
    // over the same one-tick segment `stepFooty` uses, which is what makes a
    // ball that would have hit a player hit a pedestrian standing in the same
    // place.
    //
    // **The ball does not die on a pedestrian**, and that is a decision rather
    // than an omission. Online this loop is running beside a server flying its
    // own copy of the same ball through the same physics with no idea the crowd
    // exists, and a client that killed the ball early would draw it vanishing in
    // mid-air and then have it re-appear from the snapshot. So it clips through,
    // which is also what makes the ped-hit purely cosmetic this wave. When the
    // police pass moves this onto an authoritative channel, that is where the
    // ball's fate belongs too.
    for (const ball of localBalls.balls) {
      strikePedestrianWithBall(
        pedestrians,
        ball,
        BALL_RADIUS,
        dt,
        trafficTick(Date.now()),
        pedBands,
        pedPose,
      );
    }

    // --- The police, after everything that could have started an investigation.
    //
    // Offline this **is** the authority: the same `FactionField.step` the server
    // runs, over the same file, with the same context shape -- so a pursuit in
    // `?offline` is the pursuit, not a demo of one. Online it is skipped
    // entirely: `net.actors` is a mirror the server corrects, and stepping a
    // local copy beside it would be this client inventing officers the next
    // snapshot would contradict.
    //
    // Last in the tick, because it is the only step that reads the *finished*
    // positions of everybody. `server/sim.ts` puts it in the same place for the
    // same reason.
    {
      const tick = trafficTick(Date.now());
      // The tuned ride-by, on its rising edge, **online as well as off**.
      //
      // The edge is what makes it a crime rather than a state: a tuned rider in
      // view of the police is committing the offence on every one of the sixty
      // ticks they are there, and re-accusing on each would pin the countdown to
      // its cap for as long as they kept riding -- which is a countdown that
      // never runs out, and the whole instruction was that it does.
      // `server/sim.stepRideBy` keeps the identical edge on its own side.
      //
      // Predicted online for the same reason the swing is: the banner has to
      // appear as you go past, not a third of a second later. What the server
      // decides is whether it stays.
      const offending = playerCombat.ridingBike !== 0 && playerCombat.bikeTuned && playerCombat.phase !== 'ko';
      if (offending) {
        const w = policeWitness(player.position.x, player.position.z, tick, witnessCtx, witness);
        if (w.seen && !seenRiding) accuse(player.position.x, player.position.z, REASON.BIKE, tick, true);
        seenRiding = w.seen;
      } else {
        seenRiding = false;
      }
      // The step itself is offline-only: online `net.actors` is a mirror the
      // server corrects, and running a local copy beside it would be this client
      // inventing officers the next snapshot would contradict.
      if (!online) {
        const ctx = offlineFactionCtx(tick, dt);
        factions.step(ctx);
        // The street factions' promotion scan, **after** the step and before the
        // events are drained -- `server/sim.stepFactions` puts it in exactly the
        // same place. `step` clears the event list at the top of every call, so
        // an aggro bark queued before it would be wiped before anybody heard it.
        stepStreetlife(ctx);
        // And the wildlife's, in the same place and for the same reason. It
        // promotes the birds a player has walked up to and refuses when either
        // cap is reached -- see `WILDLIFE_BUDGET` -- so a park full of turkeys
        // can never be the reason an officer could not be dispatched.
        stepWildlife(ctx, wildScratch, wildPose);
        // Drained **here** rather than in the frame loop, because `step` clears
        // the list at the top of every call and `simulate` can run more than
        // once per frame when the accumulator has caught up on a stall. A bark
        // queued on the first of two sub-steps would be cleared by the second
        // and never heard, which presents as police who occasionally arrive in
        // silence.
        for (const e of factions.events) {
          if (e.kind !== 'aggro') continue;
          audio.bark(e.clip, Math.hypot(e.x - player.position.x, e.z - player.position.z), 4);
        }
      }
    }

    // --- The traffic, after every combatant has moved and before the pickups.
    //
    // `server/sim.ts` runs the identical query in the identical place in its own
    // loop, and "identical" is meant literally: `carHitting` is a pure function
    // of the lane data and the wall-clock tick, so this client and that server
    // are asking the same question of the same bytes at the same instant. That
    // is why the shove is applied here **online as well as off**, which no other
    // weapon in this loop does.
    //
    // The swing and the ball are adjudicated by the server alone because they
    // depend on where *other people* are, and this client's picture of that is
    // 100 ms old. A car depends on nothing but the clock. So predicting it is
    // not a guess that has to be corrected -- it is the same computation, and
    // the correction that follows 30 ms later agrees with it. What the server
    // still owns is the *damage*: `net.reconcile` overwrites `health` from the
    // snapshot every time one arrives, so a client that edited these lines would
    // have exactly one snapshot's worth of imaginary health.
    //
    // Offline every fighter is tested, so the dummies get run down too, which is
    // both correct and the funniest thing in the build.
    {
      const tick = trafficTick(Date.now());
      for (const f of fighters) {
        if (online && f.combat !== playerCombat) continue;
        const car = carHitting(traffic, f.combat, tick, carRoutes, carPose);
        if (car === null) continue;
        const ko = applyCarHit(f.combat, car);
        carHits.count++;
        carHits.lastTick = tick;
        audio.thwack(ko);
        if (f.combat === playerCombat) {
          if (ko) feedback.knockedOut();
          else feedback.hitTaken();
        }
        // Online the line comes off the server's own HIT event instead -- see
        // `netHandlers().onHit`, where an event whose attacker *is* its victim is
        // how "nobody did this, a car did" travels over a protocol that has no
        // room for an environmental cause and needed none.
        // `who` answers "you" off the roster, which offline does not exist -- so
        // the local player is named here rather than being called "player 0" in
        // the one mode where the feed's only line is about them.
        if (ko && !online) {
          pushKill(`${f.combat === playerCombat ? 'you' : who(f.combat.id)} got run down`);
        }
      }
    }

    // Spec 8.3, after every combatant has moved. The order matters exactly once
    // and it is worth stating: a player who walks into a cafe on the same tick
    // they are punched away from it should collect it, because they *were*
    // there -- and running the pickup test before the movement would evaluate
    // it against last tick's position, which is the same class of half-tick
    // disagreement `simulate`'s comment about the dummies' thinking describes.
    //
    // Dummies are in `combatants` too, so the aggressor picks things up. That is
    // emergent rather than designed and it is the good kind: a test dummy that
    // has found a Training and hits for 1.4 is a fight, where one that cannot is
    // furniture.
    //
    // **Online the combatant list is empty**, and that one substitution is the
    // whole of "server-authoritative pickup" on this side: the respawn clocks
    // still run locally -- they are deterministic given the pickup, so both ends
    // compute the same number from the same constants and the icons come back
    // together -- and the *collection* happens nowhere but on the server, whose
    // PICKUP event takes the point out of this field. See `onPickup` above.
    for (const e of tickPowerups(powerups.resident(), online ? EMPTY_COMBATANTS : combatants, dt, pickups)) {
      onPickup(e);
    }

    // The local player's inputs go out last, after the tick they belong to has
    // been predicted, so the seq the server acknowledges names a step this
    // client has already taken. Sending before the step would ack an input whose
    // predicted result did not exist yet, and the replay in `reconcile` would be
    // one tick short every time.
    if (net) net.sendInput(input);
  }

  /** Handed to `tickPowerups` online. A constant, so the online path allocates nothing. */
  const EMPTY_COMBATANTS: readonly CombatantState[] = [];

  // --- Loop
  let accumulator = 0;
  let last = performance.now();
  let collisionClock = 0;
  /** Seconds spent trying to place the server's already-taken powerups. See below. */
  let powerupDrainT = 0;
  /**
   * How far the view has fallen toward the pavement, 0..1.
   *
   * Presentation only, and deliberately not a field of `PlayerState`: that
   * record is what client prediction and server reconciliation compare, and an
   * eye height that moves for dramatic reasons in it would be a permanent
   * one-metre disagreement about where a knocked-out player is looking from.
   */
  let koCamera = 0;

  /**
   * The chase camera's numbers.
   *
   * `CHASE_MIN`..`CHASE_MAX` is the brief's 3.5-4.5 m, and it is a *range* rather
   * than a distance because the two ends do different jobs: 3.5 m is close
   * enough to walk a footpath in third person without the camera in the shop
   * window behind you, and 4.5 m at 26 m/s opens the frame up so the speed has
   * somewhere to read. `CHASE_LIFT` is the brief's 1.5 m over the *eye*, which
   * puts it about head height above a rider.
   *
   * `CHASE_RADIUS` is the sphere marched out for occlusion: a shade over the
   * camera's own 0.1 m near plane, so a wall the sphere clears is a wall the
   * frustum clears. `CHASE_NEAR` is how close it may be driven -- inside that
   * the player's own body fills the frame and first person is the better answer,
   * but snapping to first person on a wall would be a jump cut, so it stops
   * instead. `CHASE_FLOOR` keeps it off the pavement on a downhill.
   */
  const CHASE_MIN = 3.5;
  const CHASE_MAX = 4.5;
  const CHASE_LIFT = 1.5;
  const CHASE_RADIUS = 0.28;
  const CHASE_NEAR = 0.9;
  const CHASE_FLOOR = 0.4;
  const CHASE_STEPS = 8;
  /** Time constant for easing *outward* only. See the loop. */
  const CHASE_TAU = 0.14;
  let chaseDistance = CHASE_NEAR;
  /** So the Redfern notice fires once rather than every frame. See the loop. */
  let tunedAnnounced = false;

  // Frame cost is reported as the median of recent frame deltas rather than
  // frames-per-wall-second. Median is robust to two things that make the naive
  // count useless: a one-off hitch when a tile's geometry uploads, and any period
  // where the browser stops issuing animation frames (a backgrounded tab, or a
  // hidden window), which otherwise reads as 0 fps on a scene running fine.
  const frameTimes = new Float32Array(90);
  let frameCursor = 0;
  let frameCount = 0;
  const medianFrameMs = (): number => {
    const n = Math.min(frameCount, frameTimes.length);
    if (n === 0) return 0;
    const sorted = Array.from(frameTimes.subarray(0, n)).sort((a, b) => a - b);
    return sorted[n >> 1];
  };
  let hudClock = last;
  /** Reused: the HUD's chip list is rebuilt every frame and allocates nothing. */
  const powerupChips: Array<{ name: string; seconds: number }> = [];
  /**
   * Catches a throw out of the frame's render call so it cannot stop the world
   * in silence. Built here rather than at module scope so its failure count is
   * per-session, which is what `sydney.render.report()` is answering.
   */
  const renderGuard = new RenderGuard();

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    // Clamp the frame delta: a tab that was backgrounded must not run hundreds of
    // simulation steps on return.
    const frameDt = Math.min((now - last) / 1000, 0.25);
    last = now;

    input.forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    input.jump = keys.has('Space');
    input.sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');

    // `A`/`D`: a strafe on foot, and the **handlebars** on a bike.
    //
    // The remap is here, in the input builder, and that placement is the whole
    // design. `yaw` and `right` are both client-authoritative inputs already --
    // they go on the wire, they are what prediction replays, and they are what
    // the server steps -- so shaping them *before* the snapshot exists means the
    // server needs no idea this happened and `controller.step` is not forked.
    // See `bikes.shapeRideSteering`, which is also what `verifyBikes` asserts.
    //
    // The mouse still steers, untouched, because the mouse was always writing
    // `input.yaw` and this only adds to it.
    shapeRideSteering(
      playerCombat,
      (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0),
      // The body's real ground speed, so the rate falls off as the bike winds
      // up rather than on a nominal top speed the player may not have reached.
      planSpeed(playerCombat),
      frameDt,
      rideSteering,
    );
    input.right = rideSteering.right;
    input.yaw += rideSteering.yawDelta;

    const turn = (keys.has('ArrowRight') ? 1 : 0) - (keys.has('ArrowLeft') ? 1 : 0);
    const look = (keys.has('ArrowDown') ? 1 : 0) - (keys.has('ArrowUp') ? 1 : 0);
    if (turn) input.yaw -= turn * KEY_TURN_RATE * frameDt;
    if (look) input.pitch -= look * KEY_TURN_RATE * 0.6 * frameDt;

    // The lean, from the yaw rate that just came out of the steering.
    //
    // Eased rather than taken raw, because the raw signal is a key that is
    // either down or not and a bike that snapped 12 degrees on a keypress would
    // read as a glitch rather than as weight. 0.14 s is about the time a rider
    // takes to commit to a turn. `rideLean` is metres of nothing when the player
    // is on foot -- the target is zero and the ease runs it out.
    const leanTarget =
      playerCombat.ridingBike !== 0 && frameDt > 1e-5
        ? Math.max(-1, Math.min(1, rideSteering.yawDelta / frameDt / RIDE_TURN_RATE)) * -BIKE_LEAN
        : 0;
    rideLean += (leanTarget - rideLean) * Math.min(1, 1 - Math.exp(-frameDt / 0.14));

    accumulator += frameDt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < 8) {
      simulate(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }
    applyToCamera(player, camera);
    if (net) {
      net.update(frameDt);
      // The eased correction, on the **camera** and on nothing else.
      //
      // `game/feedback.ts` makes the same separation about shake and states the
      // rule: the simulation is corrected instantly and correctly, and the view
      // of it lags for 80 ms so a correction is not a jump cut. Writing this
      // back into `PlayerState` would be a permanent disagreement between where
      // the player is and where the server says they are, which is exactly what
      // reconciliation exists to end.
      camera.position.add(netCorrection);
    }

    // A knocked-out player's eye ends up on the pavement. Eased rather than
    // snapped, over about the time the body takes to land, so the drop reads as
    // going down rather than as a cut.
    const koTarget = playerCombat.phase === 'ko' ? 1 : 0;
    koCamera += (koTarget - koCamera) * Math.min(1, 1 - Math.exp(-frameDt / 0.18));
    if (koCamera > 0.001) camera.position.y -= koCamera * (EYE_HEIGHT - 0.45);

    // Shake, red pulse, reticle and spec 8.3's raised FOV, composed onto a
    // camera whose orientation is already final and never written back into
    // `PlayerState`. See `game/feedback.ts` -- that rule is the whole reason
    // this call is here and not inside `applyToCamera`, and it is why the Flat
    // White's 0.15-degree tremor is a camera term rather than a yaw term.
    //
    // Level-triggered rather than started on the pickup event: the effect can
    // end for reasons no event fires for -- it expires, or the player is knocked
    // out and `respawnAt` clears it -- and one assignment a frame is cheaper
    // than being right about all of them.
    // --- Third person, applied to the camera and to nothing else.
    //
    // After `applyToCamera` and the net correction, before `feedback`, which is
    // the same seam every other camera term in this loop sits in: the simulation
    // is finished and correct, and what is being changed is only where it is
    // *looked at from*. Nothing here is ever written back into `PlayerState` --
    // `game/feedback.ts` states that rule and the knockout drop above obeys it.
    //
    // **Riding forces it**, and a preference is remembered separately, so
    // getting off a bike returns you to whatever you had before rather than
    // leaving you in a camera you never asked for. See `thirdPersonPreferred`.
    const wantThird = playerCombat.ridingBike !== 0 || thirdPersonPreferred;
    if (wantThird !== thirdPerson) {
      thirdPerson = wantThird;
      // The body, the bat in its hand and the football in the other. Three calls
      // because **three does not inherit layers** -- a prop parented to a bone of
      // a mesh that just became visible is still on the shadow layer. See
      // `character.setVisibleToCamera`.
      setVisibleToCamera(self.mesh, thirdPerson);
      setVisibleToCamera(selfBat.mesh, thirdPerson);
      setVisibleToCamera(selfFooty.mesh, thirdPerson);
      // And the two viewmodels go the other way. A camera-attached bat 60 cm
      // from the eye is a bat inside the back of your own head in third person,
      // and the rig is already carrying a real one.
      //
      // **On the layer, not on `visible`**, and that is not a stylistic choice.
      // Both viewmodels write their own `group.visible` inside `update()` --
      // `BatViewmodel` drops the bat on a knockout and `FootyViewmodel` hides
      // the ball with an empty bar -- and `update()` runs after this every
      // frame. Setting `visible` here is therefore overwritten before the next
      // draw, which is exactly what it did: the bat stayed welded to the eye
      // through the entire ride. Layers are the one channel those two never
      // touch, so a toggle here composes with their own logic instead of
      // fighting it, and each keeps deciding its own case on dismount.
      //
      // On the **mesh** rather than the group, because three tests layers per
      // object and a `Group` is never itself drawn -- disabling a group's layer
      // hides nothing at all. Same fact as `castShadowOnly`'s, one container up.
      setVisibleToCamera(viewmodel.mesh, !thirdPerson);
      setVisibleToCamera(footyViewmodel.mesh, !thirdPerson);
    }
    if (thirdPerson) {
      // Chase: back along the view ray and up. The distance is eased so that
      // mounting does not snap the camera four metres backwards through a
      // terrace, and so the pull-in below reads as the camera ducking rather
      // than as a cut.
      const sinY = Math.sin(player.yaw);
      const cosY = Math.cos(player.yaw);
      const cosP = Math.cos(player.pitch);
      // The full view direction, pitch included, so looking down brings the
      // camera up and over the shoulder -- which is what makes a bike visible
      // when you look at the road in front of it.
      const dirX = -sinY * cosP;
      const dirY = Math.sin(player.pitch);
      const dirZ = -cosY * cosP;
      // How far back the camera *wants* to be, before anything is in the way.
      // Further at speed, which is the cheapest way to make 26 m/s read as fast:
      // the frame opens up as the bike winds on.
      const speed = Math.hypot(player.velocity.x, player.velocity.z);
      const want = CHASE_MIN + Math.min(1, speed / 26) * (CHASE_MAX - CHASE_MIN);
      // --- Occlusion, as a sphere march rather than a ray cast.
      //
      // `collision.resolve` answers "can a circle of radius r be here", which is
      // exactly the question, and marching it out from the head is what keeps
      // the camera out of the terrace behind you. A ray would pass through a
      // wall's corner and leave the camera inside it; a sphere of the camera's
      // own near-plane radius cannot.
      //
      // Eight steps over 4.5 m is 56 cm a step, which is under the sphere's own
      // diameter, so nothing thinner than a step can be tunnelled through. It
      // runs once a frame against a grid query that is already the cheapest
      // thing in `collision.ts`.
      const headX = player.position.x;
      const headY = player.position.y;
      const headZ = player.position.z;
      let reach = want;
      for (let s = 1; s <= CHASE_STEPS; s++) {
        const d = (want * s) / CHASE_STEPS;
        const px = headX - dirX * d;
        const pz = headZ - dirZ * d;
        const py = headY - dirY * d + CHASE_LIFT;
        // Against the roofs as well as the walls: a camera that swung up over a
        // warehouse would otherwise end up inside it. Head and feet both at the
        // boom's own height -- a camera is a point, and a 1.8 m head on it would
        // snap the chase in against a soffit the player is walking happily
        // under. See `CollisionWorld.resolve`.
        if (
          collision.resolve(px, pz, px, pz, CHASE_RADIUS, py, py).hit ||
          py < groundHeightAt(px, pz, py) + CHASE_FLOOR
        ) {
          reach = Math.max(CHASE_NEAR, ((want * (s - 1)) / CHASE_STEPS) - 0.05);
          break;
        }
      }
      // Eased outward and snapped inward. Coming *out* from a wall should be
      // gentle; going *in* must be immediate, or the camera spends a frame
      // inside the building it just found.
      chaseDistance = reach < chaseDistance
        ? reach
        : chaseDistance + (reach - chaseDistance) * Math.min(1, 1 - Math.exp(-frameDt / CHASE_TAU));
      // Added to the camera rather than assigned to it, which matters: by this
      // line `camera.position` is the eye **plus** the eased net correction and
      // **minus** the knockout drop, and both of those are terms this has no
      // business discarding. Assigning here -- which is what this did first --
      // silently turns reconciliation off in third person, and the symptom is
      // remote-looking rubber-banding that only happens on a bike.
      camera.position.x -= dirX * chaseDistance;
      camera.position.y += CHASE_LIFT - dirY * chaseDistance;
      camera.position.z -= dirZ * chaseDistance;
    } else {
      // Reset, so stepping back into third person starts at the near distance
      // and eases out rather than appearing at full extension.
      chaseDistance = CHASE_NEAR;
    }

    feedback.setCaffeinated(playerCombat.flatWhiteT > 0);
    feedback.update(frameDt);
    feedback.applyToCamera(camera);

    // Spec 8.3's chips, longest-lived first so the one about to expire is not
    // the one that moves. Built here rather than in `hud.ts` because which
    // powerups exist is gameplay and the HUD's job is to draw a list.
    powerupChips.length = 0;
    if (playerCombat.trainingT > 0) {
      powerupChips.push({ name: POWERUP_NAME[TRAINING], seconds: playerCombat.trainingT });
    }
    if (playerCombat.flatWhiteT > 0) {
      powerupChips.push({ name: POWERUP_NAME[FLAT_WHITE], seconds: playerCombat.flatWhiteT });
    }
    powerupChips.sort((a, b) => b.seconds - a.seconds);
    // The bike's chips go on the end rather than into the sort, because they have
    // no countdown to sort by: a ride lasts until you get off and the tuning
    // lasts the session. `hud.vitals` draws a chip with `seconds <= 0` as a bare
    // label, which is what these are.
    if (playerCombat.ridingBike !== 0) {
      powerupChips.push({
        name: `RIDING x${bikeSpeedScale(playerCombat.bikeTuned).toFixed(1)}`,
        seconds: 0,
      });
    } else if (playerCombat.bikeTuned) {
      // Only when *not* riding: while riding, the multiplier is already in the
      // chip above and two chips saying the same thing is one too many.
      powerupChips.push({ name: 'BIKE TUNING', seconds: 0 });
    }

    // The Redfern notice, on the rising edge of a flag that can be set by either
    // authority -- the server through `FLAG.TUNED`, or `simulate` offline. Edge
    // rather than level, because the flag never clears and a level test would
    // rewrite the pill every frame for the rest of the session.
    if (playerCombat.bikeTuned && !tunedAnnounced) {
      tunedAnnounced = true;
      hud.notice(`bike tuning unlocked -- rides are now ${BIKE_TUNED_COFFEES}x a coffee run`);
      audio.pickupTraining();
    }

    // The suggestions panel's claim on the keyboard, pushed every frame rather
    // than on a focus event.
    //
    // A focus listener would be cheaper and is wrong in one case that actually
    // happens: the focus can leave a field without a `blur` this file hears
    // about -- the panel being closed by another panel's key, the window losing
    // focus mid-sentence -- and a stale `true` here is *every game key dead for
    // the rest of the session*, which is the worst failure this feature could
    // have. Asking a getter that reads `document.activeElement` once a frame
    // cannot go stale, and costs a comparison. The chat box can afford the
    // event-driven version because its box has exactly one way to close.
    hud.suggestTyping = suggestions.typing;

    hud.vitals({
      health: playerCombat.health,
      maxHealth: MAX_HEALTH,
      stamina: playerCombat.stamina,
      maxStamina: MAX_STAMINA,
      recharge: Math.min(1, playerCombat.staminaT / STAMINA_RECOVERY),
      ballCharges: playerCombat.ballCharges,
      maxBallCharges: BALL_CHARGES,
      // How far along the **next ball** is, always -- never the 0.55 s throw
      // floor, even though `ballT` drives both clocks.
      //
      // The bar this replaced showed whichever clock was binding, which was
      // right for a weapon that refilled its whole bar at once: with charges in
      // hand the only question was "can I fire", so the cooldown was the honest
      // answer. It is wrong here and measurably so. The supply now returns one
      // ball every 4 s, so with charges left the cooldown reads 100% within half
      // a second and the empty block sits there looking full while the ball it
      // represents is still three and a half seconds away. A block that is
      // indistinguishable from full and is not full is the one thing a HUD made
      // of blocks must not draw.
      ballRecharge: Math.min(1, playerCombat.ballT / BALL_RECHARGE),
      respawnIn: playerCombat.phase === 'ko' ? playerCombat.respawnT : 0,
      effects: powerupChips,
    });

    // The scoreboard, while `Tab` is held.
    //
    // Every frame rather than on the keydown, because the numbers move while it
    // is up: somebody is knocked out with the board open two or three times a
    // session, and a panel that froze at the moment it was opened would be
    // wrong exactly when it was being read. It is cheap by the same construction
    // `vitals` uses -- the rows are folded into one string and compared, so a
    // held key with nothing happening is a string compare -- and it returns on
    // the first line when the board is down, which is almost always.
    //
    // Offline the board is empty rather than absent: `?offline` has no roster
    // and no scores, and drawing "you 0 0 —" would be inventing a match. The
    // panel appears with nothing in it, which is the truth.
    if (hud.leaderboardVisible) hud.leaderboard(net ? net.leaderboard() : [], net ? net.id : -1);

    // The map, on the frame delta and redrawing on its own 15 Hz clock inside.
    // `player.yaw` rather than `input.yaw`, and the difference is visible: the
    // mouse writes `input.yaw` continuously and `controller.step` copies it to
    // the body on the fixed step, which is also what `applyToCamera` above
    // reads -- so taking the body's is what keeps the map turning in lockstep
    // with the view instead of a fraction of a step ahead of it.
    // Which tiles are solid and undrawn, before either map is redrawn on this
    // frame -- so the wash a player is looking at is this frame's residency
    // rather than the previous one's. It runs on its own 10 Hz clock inside; the
    // frame delta is what drives it, like the maps below.
    invisibleWalls.update(frameDt, player.position.x, player.position.z);

    minimap.update(frameDt, player.position.x, player.position.z, player.yaw);

    // And the big map, which costs one comparison on every frame it is closed --
    // which is nearly all of them. Same position and yaw as the disc above, and
    // for the same reason: `player.yaw` is the body's, so the heading wedge and
    // the view agree exactly rather than to within a fixed step.
    bigmap.update(frameDt, player.position.x, player.position.z, player.yaw);

    // And the line under the disc. On the frame delta like the maps, with its
    // own two clocks inside -- 2 Hz for the street and 3 s for the suburb.
    // Pushed through the minimap rather than written to the DOM here, because
    // the strip belongs to it and `setReadout` skips the write when the text has
    // not changed -- which is all but one frame in a hundred.
    locator.update(frameDt, player.position.x, player.position.z);
    minimap.setReadout(locator.text);

    // Night factor drives the lit-window shader. Ramps across civil twilight.
    const alt = sky.solar.altitude;
    globals.nightFactor.value = 1 - Math.min(Math.max((alt + 5) / 11, 0), 1);
    const d = sky.solar.direction;
    globals.sunDirection.value.set(d.x, d.y, d.z);

    // The camera's world matrix has to be current before either of these: the
    // sky centres the shadow volume on it, and the streamer culls against its
    // frustum -- and since that cull now also decides which tiles reach the
    // depth pass, a frame of lag there is a frame of missing shadows on every
    // turn. `applyToCamera` sets position and rotation only; the renderer would
    // otherwise be the first thing to compose them, one call too late.
    camera.updateMatrixWorld();
    sky.update(camera);
    // The altitude goes with the frustum, and it is not a duplicate of it: the
    // frustum says where the shadow *volume* is, and the altitude is what turns
    // that box into the patch of ground it covers -- which stretches along the
    // sun's bearing by 1/sin(altitude) and is what decides which tiles are told
    // to receive. See `streamer.sunReceiveRange`.
    streamer.update(camera, sky.shadowVolume, alt);
    // Ambient life, after the streamer so a tile that arrived this frame has its
    // birds in it, and before the render so their matrices are current. It takes
    // `frameDt` rather than reading a clock of its own, which is what makes a
    // backgrounded tab free: no animation frames means no delta, and the clamp
    // above means the frame the tab comes back advances the birds by one step
    // rather than by however long the browser was not drawing.
    streamer.updateLife(frameDt, camera);

    // The night rig, after the streamer -- so a tile that arrived this frame
    // already has its luminaires in the set the four real lights are picked from
    // -- and before the traffic, so `carLights.begin()` answers for this frame
    // rather than the last one.
    //
    // `frameDt` unclamped by anything of its own: the only thing it integrates
    // is the torch's lag toward the view and its sway clock, and a backgrounded
    // tab coming back should find the beam where the view is rather than
    // sweeping a second of catch-up across the street. The exponential chase in
    // `NightLights.update` is written so a long delta simply lands on the
    // target.
    //
    // The streamer is handed over as the `LampSource` it implements, so the
    // lights follow the lamps of tiles that are actually resident and nothing
    // here has to keep a second copy of where they are.
    nightLights.update(
      frameDt,
      camera,
      alt,
      Math.hypot(player.velocity.x, player.velocity.z),
      streamer,
    );
    // And the sprites, which are hidden all day for the fill they would
    // otherwise cost. One comparison on every frame but the two a day where the
    // answer changes; see `TileStreamer.setNightLightsVisible` for why this is
    // a mesh flag and must never become a light one.
    streamer.setNightLightsVisible(nightLights.level > NIGHT_VISIBLE_LEVEL);

    // The traffic, after the streamer so a tile that arrived this frame already
    // has its routes in the field, and before the render so the matrices are
    // current.
    //
    // The tick is **fractional here and whole in `simulate`**, and that split is
    // the one place a non-integer tick is correct in this feature. The hit test
    // runs on whole ticks so that this client and the server ask the identical
    // question; the picture runs between them so a 144 Hz display does not watch
    // 60 Hz cars. Both are the same lookup -- see `game/traffic.ts` -- so the
    // car you are drawn being hit by is exactly the car that hit you.
    //
    // No frame delta and no clock of its own: `trafficTick` reads wall time, so
    // a backgrounded tab costs nothing and comes back with the whole city's
    // traffic where it would have been, with no catch-up step. That is what a
    // position-by-lookup buys that an integrated fleet could not.
    trafficMovers.update(
      traffic,
      trafficTick(Date.now()) + accumulator / FIXED_DT,
      player.position.x,
      player.position.z,
    );

    // And the crowd, on exactly the same terms and immediately after, because
    // they come out of the same file and the same clock: the fractional tick so
    // a 144 Hz display does not watch 60 Hz people, and no clock of its own so a
    // backgrounded tab costs nothing and comes back with everybody where they
    // would have been.
    //
    // The one thing it takes that the traffic does not is `frameDt`, and only
    // the near tier reads it: fourteen `CharacterActor`s are animated on the
    // frame delta for the reason every actor below is, and the far tier's gait
    // is derived from the distance walked and has no clock at all.
    crowd.update(
      pedestrians,
      trafficTick(Date.now()) + accumulator / FIXED_DT,
      frameDt,
      player.position.x,
      player.position.z,
    );

    // --- The police, both tiers, from whichever authority is running.
    //
    // The fractional tick is `TrafficMovers.update`'s split, for the same
    // reason: the witness test runs on whole ticks so this client and the server
    // ask the identical question, and the picture runs between them so a 144 Hz
    // display does not watch 60 Hz people.
    squad.update(
      pedestrians,
      policeField(),
      trafficTick(Date.now()) + accumulator / FIXED_DT,
      frameDt,
      player.position.x,
      player.position.z,
    );

    // --- And the street, both tiers, out of the same authority. Same fractional
    // tick, same reason, same `policeField()` -- which is not a police-only
    // accessor despite the name: it is "wherever the promoted actors are", and
    // `StreetCrowd.gather` filters the kinds it draws itself.
    streetCrowd.update(
      pedestrians,
      policeField(),
      trafficTick(Date.now()) + accumulator / FIXED_DT,
      frameDt,
      player.position.x,
      player.position.z,
    );

    // --- And the birds, on the same terms again. No frame delta: a bird has no
    // animation clock of its own, because every part of its pose is derived from
    // the fractional tick and the state byte -- which is what makes a
    // backgrounded tab cost nothing and come back with the whole park where it
    // would have been.
    flock.update(
      pedestrians,
      policeField(),
      trafficTick(Date.now()) + accumulator / FIXED_DT,
      player.position.x,
      player.position.z,
      wildGround,
    );

    // --- What a shot sounds and looks like.
    //
    // Read off the state byte rather than off an event, which is the whole
    // reason `NPC_STATE.FIRE` is held for one snapshot period rather than one
    // tick -- see `factions.FIRE_STATE_TICKS`. There is no shot message on the
    // wire and none is needed: the state arrives in a snapshot every client is
    // already decoding, exactly as a football's existence is its own
    // announcement.
    //
    // The **rising edge**, because offline the state is read at 60 Hz where
    // online it is sampled at 20 -- a level test would play three cracks a shot
    // in `?offline` and one online, which is precisely the sort of difference
    // that makes the offline path stop being a real test of the feature.
    //
    // `NPC_STATE.FIRE` is the framework's "an attack just left this actor" and
    // is **not police-only**: a meth head's swipe and a drunk's shove are
    // carried in the same byte, for the same reason and with the same one-
    // snapshot hold. So the kind decides what it sounds like -- a round and a
    // tracer for an officer, an impact for a fist -- and a loop that did not ask
    // would give a shirtless bloke in a beanie a service pistol.
    for (const actor of policeField().actors) {
      const wasFiring = firing.has(actor.id);
      if (actor.state === NPC_STATE.FIRE) {
        if (!wasFiring) {
          firing.add(actor.id);
          const range = Math.hypot(actor.x - player.position.x, actor.z - player.position.z);
          if (actor.kind === NPC_KIND.POLICE) {
            policeStats.shots++;
            audio.gunshot(range);
            tracers.fire(actor, player.position, range);
          } else if (isStreetKind(actor.kind) && range < 6) {
            // Close only. A swipe is a sound you hear because it happened to
            // you, and one audible from 40 m would be a city of invisible
            // punching. `thwack(false)` is the bat's own body layer, which is
            // the same class of event and already tuned against it.
            audio.thwack(false);
          }
        }
      } else if (wasFiring) {
        firing.delete(actor.id);
      }
    }
    tracers.update(frameDt);

    // --- And what the birds sound like, off the same state bytes.
    //
    // A whole transition table rather than the single `FIRE` edge above it,
    // because a bird's voice is not tied to its attack: a turkey gobbles when it
    // *decides* to come at you (the entry into CHASE, which is the thing you
    // need to hear behind you), a magpie announces the dive it has already
    // started, and an ibis grumbles at being moved on. All three are synthesised
    // -- see `game/audio.ts` -- because there are no wildlife WAVs in this build
    // and a bird call is what a synthesiser is *for*.
    //
    // Driven off the state byte rather than off a faction event for the reason
    // the police bark is: the wire deliberately carries no aggro event, so a
    // cue that needed one would exist offline and be silent online. This works
    // in both, and `NPC_STATE.FIRE`'s one-snapshot hold is what guarantees the
    // edge is never sampled away.
    wildSeen.clear();
    for (const actor of policeField().actors) {
      if (!isProtected(actor.kind)) continue;
      wildSeen.add(actor.id);
      const was = wildStates.get(actor.id);
      if (was === actor.state) continue;
      wildStates.set(actor.id, actor.state);
      // A newly promoted bird has no previous state and must not be treated as
      // having just changed into this one -- otherwise every turkey in the park
      // gobbles the instant it wakes up, which is the whole flock announcing
      // itself at once.
      if (was === undefined) continue;
      const range = Math.hypot(actor.x - player.position.x, actor.z - player.position.z);
      if (actor.state === NPC_STATE.FIRE) {
        audio.birdStrike(range);
      } else if (actor.state === NPC_STATE.AIM && actor.kind === NPC_KIND.MAGPIE) {
        // **The alarm leads the dive.** `NPC_STATE.AIM` on a magpie is
        // `wildlife.TELEGRAPH_TICKS` of it screaming from the branch *before*
        // it leaves -- so this warble arrives 0.83 s ahead of the swoop below,
        // which is the entire read-and-react window the feature has. The two
        // cues used to fire on the same edge, which is a warning that arrives
        // with the thing it is warning about.
        audio.magpieWarble(range, true);
      } else if (actor.state === NPC_STATE.CHASE) {
        if (actor.kind === NPC_KIND.TURKEY) audio.turkeyCall(range, true);
        else if (actor.kind === NPC_KIND.MAGPIE) audio.magpieSwoop(range);
      } else if (actor.state === NPC_STATE.RETURN && actor.kind === NPC_KIND.IBIS) {
        audio.ibisHonk(range);
      }
    }
    for (const id of wildStates.keys()) if (!wildSeen.has(id)) wildStates.delete(id);
    // The ambient half: an occasional call from a bird nobody is bothering, at a
    // rate the flock itself picks. Deliberately *very* sparse -- a park in which
    // every turkey called would be a soundboard, and the whole effect of one
    // gobble from somewhere behind a fig depends on it being rare.
    {
      const idle = flock.idleCall(frameDt);
      if (idle !== null) {
        if (idle.kind === NPC_KIND.TURKEY) audio.turkeyCall(idle.distance, false);
        else if (idle.kind === NPC_KIND.IBIS) audio.ibisHonk(idle.distance);
        else audio.magpieWarble(idle.distance, false);
      }
    }

    // --- And the bark, online.
    //
    // Offline it is drained inside `simulate`, off the faction field's own event
    // list, for the reason stated there. Online there is no such list -- the wire
    // deliberately carries no aggro event -- so the cue comes from the state
    // instead: an officer who has just entered `NPC_STATE.AIM` is an officer who
    // has just shouted at you. Adding a reliable message for it would be a second
    // way to say a thing an idempotent state byte already says, which is the
    // argument `protocol.EVENT` makes about the retired beam.
    if (net) {
      for (const actor of net.actors.values()) {
        if (actor.kind !== NPC_KIND.POLICE || actor.state !== NPC_STATE.AIM) continue;
        if (aiming.has(actor.id)) continue;
        aiming.add(actor.id);
        const range = Math.hypot(actor.x - player.position.x, actor.z - player.position.z);
        audio.bark(POLICE_CLIPS[actor.id % POLICE_CLIPS.length], range, 6);
      }
      for (const id of [...aiming]) {
        const a = net.actors.get(id);
        if (!a || a.state === NPC_STATE.CHASE || a.state === NPC_STATE.RETURN) aiming.delete(id);
      }
      // The street factions' own, off the same idea and a different state. An
      // officer shouts when the weapon comes up; a meth head shouts when they
      // start running, and `NPC_STATE.CHASE` is the byte that says so. The clip
      // is chosen off the actor id rather than off a hash of the tick, because
      // online the tick this client sees is a snapshot's rather than the
      // authority's -- an id is the one thing both ends agree about exactly.
      for (const actor of net.actors.values()) {
        if (!isStreetKind(actor.kind) || actor.state !== NPC_STATE.CHASE) continue;
        if (charging.has(actor.id)) continue;
        charging.add(actor.id);
        const clips = actor.kind === NPC_KIND.METHHEAD ? METHHEAD_CLIPS : DRUNK_CLIPS;
        const range = Math.hypot(actor.x - player.position.x, actor.z - player.position.z);
        audio.bark(clips[actor.id % clips.length], range, 5);
      }
      for (const id of [...charging]) {
        const a = net.actors.get(id);
        if (!a || a.state === NPC_STATE.RETURN || a.state === NPC_STATE.WALK) charging.delete(id);
      }
    }

    // --- The banner.
    //
    // One record, filled from whichever authority is running, so the HUD call
    // below has no idea which mode it is in. Offline the countdown is the
    // field's own ticks; online it is the investigation channel's, run down
    // locally between messages -- see `net/client.tickInvestigations`.
    {
      investigationView.reason = 0;
      investigationView.seconds = 0;
      if (net) {
        const it = net.investigation;
        if (it) {
          investigationView.reason = it.reason;
          investigationView.seconds = it.seconds;
        }
      } else {
        const it = factions.investigationOf(playerCombat.id);
        if (it) {
          investigationView.reason = it.reason;
          investigationView.seconds = it.ticks / 60;
        }
      }
      hud.investigation(
        investigationView.reason ? reasonText(investigationView.reason) : '',
        investigationView.seconds,
      );
    }

    // Every actor -- three dummies and the player's own body -- on the frame
    // delta rather than the fixed step. Deliberate, and the opposite of the
    // choice `simulate` makes above: the simulation is fixed so that prediction
    // and rewind produce the same trajectory, where animation is presentation
    // and has to be smooth at whatever rate the display runs. Stepping the poses
    // inside the accumulator loop would quantise a 100 ms swing to six positions
    // on a 144 Hz display for no benefit at all.
    //
    // The self body stands at the player's feet facing where they walk, with
    // pitch deliberately not applied, because a body does not lean back when you
    // look up. It is invisible to the camera, so what it contributes to a frame
    // is a shadow -- and that shadow is the whole of this pass's first-person
    // feedback: your own arm throwing on the footpath in front of you, and your
    // own crumple when you go down.
    for (const f of fighters) f.driver.update(f.combat, frameDt);
    // Your own body's football, which the camera excludes -- so what this
    // contributes to a frame is a ball-shaped shadow beside your bat's, and its
    // absence while one is in the air.
    selfFooty.set(playerCombat.ballCharges > 0 && playerCombat.ballT >= THROW_SECONDS);
    // And every dummy's, on exactly the rule `poseRemote` applies to a remote:
    // in hand while they have one and are not mid-throw. Offline this is the
    // only place the "somebody else is carrying" read can be seen at all.
    for (const [dummy, prop] of dummyFooties) {
      prop.set(dummy.combat.ballCharges > 0 && dummy.combat.ballT >= THROW_SECONDS);
    }
    // And the bat in front of the eye, on the frame delta for the same reason
    // every actor is: the simulation is fixed so prediction and rewind agree,
    // and a viewmodel is presentation and has to be smooth at whatever rate the
    // display runs.
    //
    // The phase comes off the **predicted** local combatant rather than off a
    // server event, which is what makes the swing start on the frame the button
    // goes down instead of on the next round trip -- the same argument
    // `simulate` makes about predicting the phase machine online. `player.yaw`
    // rather than `input.yaw` for the sway, because the body's is what
    // `applyToCamera` drew with and taking the other would sway the bat a
    // fraction of a step ahead of the view.
    viewmodel.update(frameDt, {
      phase: playerCombat.phase,
      phaseT: playerCombat.phaseT,
      speed: Math.hypot(player.velocity.x, player.velocity.z),
      yaw: player.yaw,
      pitch: player.pitch,
      hitstop: playerCombat.hitstopT > 0,
      // The bat dips out of the way while the other hand throws. See
      // `BatViewmodel.update`: it is one number, and without it the bat sits
      // rock-steady in the corner of the frame through a throw that is visibly
      // a whole-body action, which reads as two unrelated animations.
      throwT: playerCombat.ballT,
    });
    // And the ball in the other hand, on the same frame delta and off the same
    // predicted clock -- so the release starts on the frame the button goes down
    // rather than on the next round trip.
    footyViewmodel.update(frameDt, {
      sinceThrow: playerCombat.ballT,
      charges: playerCombat.ballCharges,
      speed: Math.hypot(player.velocity.x, player.velocity.z),
      down: playerCombat.phase === 'ko',
      hitstop: playerCombat.hitstopT > 0,
    });
    // Remotes, on the frame delta like every other actor and for the same
    // reason: the simulation is fixed so prediction and rewind agree, and
    // animation is presentation and has to be smooth at whatever rate the
    // display runs. Their *positions* come from the interpolation clock, which
    // `net.update` advanced above.
    if (net) {
      for (const r of net.remotes.values()) {
        const entry = ensureRemoteActor(r);
        // A remote is created by its JOIN event and placed by its first
        // snapshot, and between the two its position is the ENU origin -- which
        // is Circular Quay, and up to four kilometres from wherever the fight
        // is. Hidden rather than posed until it has been told where it stands.
        entry.actor.mesh.visible = !r.fresh;
        if (!r.fresh) poseRemote(entry, r, frameDt);
      }
    }

    // --- The lime e-bikes, after every actor is posed.
    //
    // Three sources, one geometry, three draws:
    //
    //   1. The **parked** set, instanced, culled by range. Ridden bikes are
    //      skipped here -- they are drawn at their riders below, from the
    //      interpolated positions this class does not have.
    //   2. The **local player's**, at the predicted feet position, so it moves
    //      on the frame the input does rather than on the next snapshot. Exactly
    //      the argument `main.ts` already makes about the local player's own
    //      footballs.
    //   3. **Each riding remote's**, at their interpolated feet, so the bike and
    //      the body drawn on it are on the same 100 ms clock. Drawing one of
    //      them at present time would slide the rider along a bike a third of a
    //      metre behind them.
    placeResidentBikes();
    maybeBuildStall();
    bikeMeshes.update(bikeWorld().all(), player.position.x, player.position.z, isRiddenLocally);
    if (playerCombat.ridingBike !== 0) {
      // With the lean, which only the local rider gets: the wire carries a yaw
      // and not a yaw *rate*, so a remote's steering is not knowable here and a
      // guessed lean would be a bike rocking on other people's screens for
      // reasons nobody could see. See `world/bike.RiddenBike.set`.
      selfBike.set(player.position.x, player.position.y - EYE_HEIGHT, player.position.z, player.yaw, rideLean);
    } else {
      selfBike.hide();
    }
    if (net) {
      for (const r of net.remotes.values()) {
        const entry = remotes.get(r.id);
        if (!entry) continue;
        if (r.riding && !r.fresh) {
          if (!entry.bike) {
            entry.bike = new RiddenBike(bikes);
            scene.add(entry.bike.mesh);
          }
          entry.bike.set(r.position.x, r.position.y - EYE_HEIGHT, r.position.z, r.yaw);
        } else if (entry.bike) {
          entry.bike.hide();
        }
      }
    }

    // --- Every football in the air, from both sources, into one pool.
    //
    // The pool is fed declaratively each frame rather than keyed by id, which is
    // what lets these two lists share it without agreeing about identity -- and
    // they deliberately do not. `localBalls` is this process's own simulation,
    // at present time; `net.balls` is everybody else's, interpolated 100 ms into
    // the past with their throwers. Offline the second is empty and the first
    // holds the lot. See `world/footyball.ts` and `net/client.ts`.
    footyPool.begin();
    for (const b of localBalls.balls) {
      footyPool.add(b.x, b.y, b.z, b.vx, b.vy, b.vz, b.age);
    }
    if (net) {
      for (const b of net.balls.values()) {
        footyPool.add(
          b.position.x, b.position.y, b.position.z,
          b.velocity.x, b.velocity.y, b.velocity.z,
          b.age,
        );
      }
    }
    footyPool.end();

    // Spec 8.3's already-taken points, from the server's join message.
    //
    // Drained here rather than on arrival because a point cannot be marked
    // before its tile has streamed in, and at join almost none of them have. It
    // retries every frame and gives up after thirty seconds -- by which time
    // anything still unresolved is a tile the player has not been near, whose
    // respawn will have elapsed long before they get there.
    if (net?.powerupsDown && powerupDrainT < 30) {
      powerupDrainT += frameDt;
      const remaining = net.powerupsDown.filter((d) => {
        const point = powerups.find(`${d.tileKey}:${d.index}`);
        if (!point) return true;
        point.active = false;
        point.respawnT = d.respawnT;
        return false;
      });
      net.powerupsDown = remaining.length > 0 ? remaining : null;
    }

    collisionClock += frameDt;
    if (collisionClock > 0.5) {
      collisionClock = 0;
      void ensureGround(player.position.x, player.position.z);
    }

    // --- The nameplates, last, because they are the only thing in the frame
    // that reads *other* objects' final world transforms.
    //
    // A plate hangs over the head **bone**, not over a fixed height above the
    // feet, and that is the whole reason this sits here and pays for two forced
    // matrix updates. A knocked-out body is face down in the street; a rider is
    // seated 20 cm lower than they stand; both are poses the bone knows about
    // and an offset from `RemotePlayer.position` does not. `CharacterActor.update`
    // sets bone rotations and the mesh transform but does not compose world
    // matrices -- the renderer does that, after this point -- so reading
    // `headPosition` without forcing the update would put every plate one frame
    // behind its owner, which at a sprint is 16 cm of visible lag.
    //
    // The cost is about twenty matrix composes per player, on at most fifteen
    // players, once a frame. The camera gets the same treatment for the same
    // reason: `begin` reads its world matrix for the billboard basis, and a
    // frame-old basis is a plate that lags a fast mouse turn.
    camera.updateMatrixWorld();
    nameplates.begin(camera);
    if (net) {
      // Online: the remotes, and only the remotes. `add` drops the local id
      // itself, so there is no condition here to get wrong.
      for (const r of net.remotes.values()) {
        if (r.fresh) continue;
        const entry = remotes.get(r.id);
        if (!entry) continue;
        entry.actor.mesh.updateMatrixWorld(true);
        entry.actor.headPosition(plateHead);
        plate.id = r.id;
        // The roster's name, which is also where the bots' Aussie names come
        // from -- `server/bots.ts` names them and the roster carries them, so a
        // bot's plate needs nothing special here.
        plate.name = net.nameOf(r.id);
        plate.health = r.health;
        plate.headX = plateHead.x;
        plate.headY = plateHead.y;
        plate.headZ = plateHead.z;
        plate.down = r.anim === ANIM.KO;
        nameplates.add(plate, net.id);
      }
    } else {
      // Offline: the dummies, which are spec 9's stand-in players and are given
      // plates for exactly that reason -- the feature has to be reachable
      // without a server and a second browser, or it rots. They have no roster
      // name, so they carry their kind, which is also the only thing that
      // distinguishes them.
      for (const f of fighters) {
        if (!f.dummy) continue;
        f.driver.actor.mesh.updateMatrixWorld(true);
        f.driver.actor.headPosition(plateHead);
        plate.id = f.combat.id;
        plate.name = dummyLabel(f.dummy.kind);
        plate.health = f.combat.health;
        plate.headX = plateHead.x;
        plate.headY = plateHead.y;
        plate.headZ = plateHead.z;
        plate.down = f.combat.phase === 'ko';
        nameplates.add(plate, playerCombat.id);
      }
    }
    nameplates.end();

    // **Guarded, and this is the one call in the client that has to be.**
    //
    // An exception out of `renderer.render` aborts this frame and, because
    // whatever caused it is still there next frame, every frame after it. The
    // reported symptom was "the map still animates but the 3D stops": the big
    // map is a 2D canvas on its own rAF, so it kept painting in front of a world
    // that had silently stopped being drawn, and the whole interface went on
    // responding. Nothing in the client noticed and nothing told the player.
    //
    // So the throw is caught, logged once with its stack, audited for the
    // null-image texture that caused the reported one, and put on the HUD. The
    // loop **keeps attempting** rather than halting -- the argument for that,
    // and for the frame count before the player is shown the error screen, is in
    // `world/texture-audit.ts` beside `TRANSIENT_FRAMES`. Everything below this
    // line -- the frame timing, the HUD, the network -- runs either way.
    renderGuard.run(() => renderer.render(scene, camera), scene, hud);

    // Cost of this frame, measured after the render call returns. Deltas above
    // 200 ms are dropped rather than recorded: they mean the browser stopped
    // issuing frames, not that the frame took that long to draw.
    const frameMs = performance.now() - now;
    if (frameDt < 0.2) {
      frameTimes[frameCursor] = frameMs;
      frameCursor = (frameCursor + 1) % frameTimes.length;
      frameCount++;
    }

    if (now - hudClock >= 400) {
      hudClock = now;
      const ms = medianFrameMs();
      const stats = streamer.stats;
      hud.update({
        frameMs: ms,
        renderScale,
        position: player.position,
        time: sky.time,
        solar: sky.solar,
        streamer: stats,
        // Constant for the session -- the far layer is never streamed and never
        // evicted -- and on the overlay anyway, because the number a reader
        // wants beside the streamed building count is what the *other*
        // representation is carrying in the same frame.
        farSlabs: far.count,
        // Constant for the session on the same terms, and reported for a reason
        // the far count does not have: the landmark set is the one part of the
        // world that is never streamed *and* never stood in for, so a zero here
        // is the only signal anywhere that the harbour has no bridge on it.
        landmarkTriangles: landmarks.triangles,
        // The moving cars. Not part of `streamer.stats` because they are not
        // part of a tile: the fleet is one instanced set for the whole visible
        // world and the lane graph behind it outlives the tiles it arrived on.
        traffic: {
          drawn: trafficMovers.drawn,
          parked: trafficMovers.parked,
          costMs: trafficMovers.costMs,
          liveried: trafficMovers.liveried,
          tiles: traffic.tileCount,
        },
        // The crowd, beside the traffic and for the same reason: neither is part
        // of a tile, and both are a per-frame CPU cost rather than a draw cost.
        pedestrians: {
          drawn: crowd.drawn,
          rigged: crowd.rigged,
          costMs: crowd.costMs,
          // People actually on the ground, not the size of the knockdown
          // registry -- see `PedestrianField.downCount`, where the difference
          // is written down and is the reason this line takes a clock.
          down: pedestrians.lyingCount(trafficTick(Date.now()) / 60),
          tiles: pedestrians.tileCount,
        },
        police: {
          beats: squad.beats,
          actors: squad.actors,
          shots: policeStats.shots,
          costMs: squad.costMs,
          investigations: net ? (net.investigation ? 1 : 0) : factions.liveInvestigations().length,
        },
        street: {
          ambient: streetCrowd.ambient,
          actors: streetCrowd.actors,
          costMs: streetCrowd.costMs,
        },
        wildlife: {
          ambient: flock.ambient,
          actors: flock.actors,
          costMs: flock.costMs,
        },
        collisionBuildings: collision.buildingCount,
        // The invisible walls. `tiles` returning to zero as the player stands
        // still is the streaming gap closing; a `tiles` that does not move is a
        // tile that will never build, and `worst` names it. See
        // `world/invisible-walls.ts`.
        phantom: {
          tiles: invisibleWalls.tileCount,
          walls: invisibleWalls.wallCount,
          structures: invisibleWalls.structureCount,
          worst: invisibleWalls.stats().worst,
        },
        ground: {
          height: lastGround,
          datumAhd: streamer.terrain.datum_ahd,
          tiles: streamer.ground?.loadedTiles ?? 0,
          missing: streamer.ground?.loadReport.missing ?? 0,
          retrying: streamer.ground?.loadReport.retrying ?? 0,
        },
        shadow: {
          map: sky.shadowMapReady,
          size: sky.sun.shadow.mapSize.x,
          casting: stats.casting,
          receiving: stats.receiving,
        },
        combat: {
          phase: playerCombat.phase,
          health: playerCombat.health,
          stamina: playerCombat.stamina,
          dummies: dummies
            .map(
              (d) =>
                `${d.kind} ${
                  d.combat.phase === 'idle' ? `${d.combat.health.toFixed(1)}p` : d.combat.phase
                }`,
            )
            .join('  '),
        },
        powerups: {
          ...powerups.report,
          speed: speedScale(playerCombat),
          damage: damageScale(playerCombat),
        },
        net: net
          ? {
              status: net.status,
              detail: net.statusDetail,
              ...net.report,
              lastCorrection: net.lastCorrection,
            }
          : null,
        feed: kills,
      });
    }
  });

  // Shadows fail silently, so say so once if they have not started.
  //
  // Three builds the shadow node lazily -- only while drawing a *visible* object
  // that has `receiveShadow` set, lit by a light that has `castShadow` set, with
  // `renderer.shadowMap.enabled` true. Miss any one and there is no error from
  // anywhere: the world renders, the sun shades faces by N.L, and nothing is
  // ever occluded, which reads as a lighting-taste problem rather than as a bug
  // and is exactly how a city with no shadows in it survived review. This is the
  // cheapest possible discriminator, and the two counters on the debug overlay
  // are the follow-up when the map exists but nothing is in it. Two seconds is
  // long enough for the first tiles to land.
  setTimeout(() => {
    if (!sky.shadowMapReady) {
      console.warn(
        '[sky] No shadow map has been rendered. Check renderer.shadowMap.enabled, ' +
          'sun.castShadow, and that something visible has receiveShadow set.',
      );
    }
  }, 2000);

  // Development handle, completed.
  //
  // The object itself was published near the top of `main`, the moment the index
  // parsed — see there for why. This fills in everything that did not exist
  // yet, which is everything below that depends on the fighters, the audio or
  // the connection. `Object.assign` rather than a second assignment to
  // `window.sydney`, so a console reference taken during the boot keeps working.
  Object.assign(dev, {
    boot: 'ready',
    collision,
    player,
    globals,
    frameMs: () => medianFrameMs(),

    /**
     * The night rig, for the console.
     *
     * `sydney.night.report()` answers the three questions this feature raises
     * from outside, and the first of them is the expensive one:
     *
     *   - `pipelines` is the renderer's live pipeline-cache size. It should be
     *     **identical at 3 pm and at 21:30**, because that is the whole
     *     architecture: five real lights created before the warm-up and never
     *     added, removed or hidden, and every additive sprite pre-compiled by
     *     `warmupParts`. Press `N`, read this, press `T`, read it again; if the
     *     two differ, something in this feature is compiling in the middle of
     *     play and `world/nightlights.ts`'s header says why that matters.
     *   - `lights` is what the scene is actually carrying, which is the same
     *     invariant from the other end.
     *   - `level`, `lampsLit` and `carsLit` are the "is it on" questions: a dark
     *     street with `level` at 1 and `lampsLit` at 0 is a client that has
     *     streamed no tiles with poles in them, which is a completely different
     *     problem from a lighting bug and looks identical from inside the game.
     */
    night: {
      rig: nightLights,
      report: () => ({
        level: nightLights.level,
        lampsLit: nightLights.lampsLit,
        carsLit: nightLights.carLights.drawn,
        torch: nightLights.torch.intensity,
        lights: nightLights.realLights.map((l) => ({
          name: l.name || l.type,
          visible: l.visible,
          intensity: (l as unknown as { intensity: number }).intensity,
        })),
        pipelines:
          (renderer as unknown as { _pipelines?: { caches?: Map<unknown, unknown> } })._pipelines
            ?.caches?.size ?? -1,
        shaders: renderer.info.memory.programs,
      }),
    },

    /**
     * The nameplates, for the console.
     *
     * `sydney.nameplates.report()` answers the only three questions this feature
     * raises from outside: how many plates are being drawn, whether the name
     * cache is doing its job, and whether anything is being dropped on the
     * floor. `redraws` is the one to watch -- it should settle at one per
     * distinct name that has ever been in the game and then stop moving
     * forever. A `redraws` that climbs with the frame counter means the cache is
     * missing and two megabytes of atlas are being re-uploaded every frame,
     * which presents as a frame-rate problem a long way from this file.
     *
     * `dropped` should be zero for the life of the process; it counts players
     * refused a plate because the buffers were full.
     */
    /**
     * The render guard, and the texture audit behind it.
     *
     * `sydney.render.report()` answers the question the reported crash left
     * nobody able to answer from the console: is the scene actually being
     * drawn? `failures` should be zero for the life of the process. Anything
     * else means a frame threw, and `messages` carries what it threw.
     *
     * `sydney.render.audit()` is the diagnostic itself -- every texture bound
     * anywhere in the scene whose image is null while its version has been
     * bumped, which is the exact condition three's `Textures.updateTexture`
     * dereferences null on. An empty array is the healthy answer and the normal
     * one; a non-empty one names the mesh, the material and the texture. Safe to
     * call at any time, but it walks every material's whole node graph, so it is
     * a console tool and never a per-frame one.
     */
    render: {
      guard: renderGuard,
      report: () => ({
        failures: renderGuard.failures,
        messages: [...renderGuard.messages],
        /** What the guard has repaired or benched. Empty is the healthy answer. */
        quarantined: [...renderGuard.quarantined],
        /**
         * Textures declared to the audit. Two once the world is up -- the plate
         * atlas and the facade parameter atlas. Anything else means a module
         * made a texture without calling `registerTexture`, and a texture the
         * audit cannot see is a crash it cannot name.
         */
        registered: registeredCount(),
        /** Whether the uploader interception is in. See `installTextureShim`. */
        shim: shimStatus,
        /**
         * What the uploader shim caught, which is the answer to the question
         * three occurrences of this crash could not answer: *which texture*.
         * Empty is the healthy answer. A non-empty one is the thing to paste.
         */
        shimCaught: shimCatchLines(),
      }),
      audit: () => auditSceneTextures(scene),
      /** Repair anything the audit finds, by hand. Returns what it did. */
      heal: () => quarantine(scene),
      /** Everything the uploader shim has intercepted and repaired. */
      shim: () => shimCatchLines(),
    },

    nameplates: {
      field: nameplates,
      report: () => ({
        drawn: nameplates.live,
        redraws: nameplates.redraws,
        dropped: nameplates.dropped,
        /** Who currently has one, and what their bar says. */
        plates: net
          ? [...net.remotes.values()]
              .filter((r) => !r.fresh)
              .map((r) => ({
                id: r.id,
                name: net?.nameOf(r.id) ?? '',
                health: r.health,
                down: r.anim === ANIM.KO,
                metres: Math.round(
                  Math.hypot(
                    r.position.x - player.position.x,
                    r.position.y - player.position.y,
                    r.position.z - player.position.z,
                  ),
                ),
              }))
          : fighters
              .filter((f) => f.dummy)
              .map((f) => ({
                id: f.combat.id,
                name: dummyLabel(f.dummy!.kind),
                health: f.combat.health,
                down: f.combat.phase === 'ko',
                metres: Math.round(
                  Math.hypot(
                    f.combat.body.position.x - player.position.x,
                    f.combat.body.position.y - player.position.y,
                    f.combat.body.position.z - player.position.z,
                  ),
                ),
              })),
      }),
    },

    /**
     * The lime e-bikes, for the console.
     *
     * `bikes.report()` is the one to reach for: it says how many of the planned
     * set have actually been *placed*, which is the number that answers the only
     * question this feature raises in practice -- "why can I not find one". A
     * plan of 79 against 4 placed is a client that has streamed four tiles;
     * against 79 placed and none within 400 m it is simply a rare pickup working
     * as designed, and those two look identical from inside the game.
     *
     * `bikes.nearest()` gives the distance and bearing to the closest one, which
     * is the other half of that question, and `bikes.summon()` puts one at your
     * feet -- for testing the ride without walking half of Alexandria.
     */
    bikes: {
      assets: bikes,
      field: () => bikeWorld(),
      planned: bikePlanned.length,
      report: () => ({
        planned: bikePlanned.length,
        placed: bikeWorld().size,
        drawn: bikeMeshes.drawn,
        // How many are wearing a marker, which is the shorter range and the
        // answer to "is the glow on" without going to look at one.
        glowing: bikeMeshes.glowDrawn,
        // And how many are lit up. Always equal to `drawn` -- they are filled
        // on the same row -- so this is the one number that says "the beacons
        // are on and they are on the right bikes" from the console.
        beaming: bikeMeshes.beamDrawn,
        riding: playerCombat.ridingBike,
        tuned: playerCombat.bikeTuned,
        multiplier: playerCombat.ridingBike !== 0 ? bikeSpeedScale(playerCombat.bikeTuned) : 1,
        speed: Math.hypot(player.velocity.x, player.velocity.z),
        // The ride pill as the derivation currently answers it, beside the state
        // it is derived from. Reported together on purpose: the reported bug was
        // these two disagreeing, so a diagnostic that showed only one of them
        // would have shown nothing wrong.
        prompt: ridePrompt(playerCombat, playerCombat.phase, rideNudgeT, rideNudgeText),
        phase: playerCombat.phase,
        lean: rideLean,
        triangles: bikes.triangles,
        glowTriangles: bikes.glowTriangles,
        beamTriangles: bikes.beamTriangles,
      }),
      nearest: () => {
        let best: { id: number; range: number; x: number; z: number } | null = null;
        for (const b of bikeWorld().all()) {
          const range = Math.hypot(b.x - player.position.x, b.z - player.position.z);
          if (!best || range < best.range) best = { id: b.id, range, x: b.x, z: b.z };
        }
        return best;
      },
      /** Park a fresh bike at the player's feet. Uses a high id, clear of the plan. */
      summon: () => {
        const id = 60000 + (bikeWorld().size % 1000);
        bikeWorld().adopt(id, {
          x: player.position.x + 1.2,
          y: player.position.y - EYE_HEIGHT,
          z: player.position.z,
          yaw: player.yaw,
        });
        return id;
      },
      /** Where the Redfern stall is, and how far away you are from it. */
      tuning: () => ({
        at: [TUNING_X, TUNING_Z],
        built: tuningStall !== null,
        range: Math.hypot(TUNING_X - player.position.x, TUNING_Z - player.position.z),
      }),
    },

    /**
     * The rotating minimap.
     *
     * `minimap.stats()` is the one to reach for: it reports the last redraw's
     * cost in milliseconds with the median and p95 over the last four seconds,
     * beside the prism and vertex counts that produced them. That pairing is
     * the point -- a cost with no polygon count beside it says nothing about
     * whether the spawn was a dense block or an empty one, and the CBD carries
     * five times the footprints Alexandria does inside the same 160 m.
     *
     * `addMarkerSource(fn)` is where a remote player list goes when there is
     * one; see `minimap.ts`. It has no `toggle` any more -- `M` opens the big
     * map below, and this one is permanent.
     */
    minimap,

    /**
     * The city map on `M`.
     *
     * `bigmap.stats()` reports what the last rebuild drew and what it cost, with
     * the atlas's own load nested under `atlas`. Two numbers there are the ones
     * worth knowing:
     *
     *   * `rebuilds` should be one per open, one per wheel click and one per
     *     175 m of running at the closest zoom -- the map re-anchors rather than
     *     scrolling, so a count climbing with the frame rate means the anchor
     *     test has come undone and the only symptom is that the game is slower.
     *   * `atlas.fetches` is the whole of what this feature ever downloads, and
     *     it must not move when the map is opened a second time: the 213 street
     *     sidecars, the harbour and the suburb file are fetched once per session
     *     and never again. `atlas.bytesApprox` is what they are costing in
     *     memory (about 340 kB for the entire street network of the inner ring).
     *
     * `selfChecks()` re-runs `verifyBigMap`, which is the projection's signs,
     * the label flip, the collision cull's determinism and the importance
     * measure -- every one of them a failure with no frame that says so. It is
     * here rather than in the boot block because none of it can fail *at* boot:
     * nothing in this feature runs until somebody presses the key.
     */
    bigmap,
    mapAtlas,
    bigmapSelfChecks: () => verifyBigMap(),

    /**
     * The invisible-wall overlay, on both maps.
     *
     * `stats()` is the one readout that says whether the streaming gap is open
     * right now and how wide; `selfChecks` re-runs the arithmetic a console
     * session can call after riding somewhere cold. See
     * `world/invisible-walls.ts`.
     */
    invisibleWalls,
    invisibleWallStats: () => invisibleWalls.stats(),
    invisibleWallSelfChecks: () => verifyInvisibleWalls(),

    /**
     * The streaming lifecycle, from the other end: what has failed, what is
     * being retried and when, what the build does not contain, and how many
     * tiles have had their prisms dropped with their geometry.
     *
     * The two console tools beside it are the only way to reproduce either half
     * of this on demand.
     *
     *   * `sydney.streaming.fail('5_-1')` faults that tile's next fetch with a
     *     503: watch it go amber on the map, count down on the HUD's tiles
     *     line, and draw itself five seconds later. `fail('5_-1', 404)` is the
     *     other branch -- suppressed for the session, counted as "not in
     *     build", logged once.
     *   * `sydney.streaming.retryNow()` forgets every verdict, which is what a
     *     developer wants after re-running the pipeline into a tab that is
     *     still open.
     *
     * `report().collisionEvicted` is the number that says the parity rule is
     * alive: it should climb as the player crosses the city. `report().holds`
     * is the one that should never move -- see `TileStreamer.dispose`.
     */
    streaming: {
      report: () => streamer.lifecycleReport,
      phase: (key: string) => streamer.tilePhase(key),
      fail: (key: string, status = 503, times = 1) => streamer.debugFailTile(key, status, times),
      retryNow: (key?: string) => streamer.retryNow(key),
      selfChecks: () => verifyTileLifecycle(),
      /** Which tiles' prisms are resident, for the parity probe. */
      collisionTiles: () => collision.residentTiles(),
    },

    /**
     * The street/suburb readout under the map.
     *
     * `locator.stats()` reports the composed line beside the parts it was made
     * of -- street, cross street, suburb, the metres to the street and whether
     * the corner rule is currently latched -- plus the four constants that
     * decided it. That pairing is the point: "cnr King St & Carillon Ave" with
     * `atCorner: true` and `distanceM: 3.6` is a readout you can check against
     * the window, where the line on its own is a claim.
     *
     * `segments` is how many centreline runs the last projection looked at, and
     * a zero there with tiles resident is the whole feature being silently off
     * -- an index with no `sn` counts in it, or a build with no `.names.bin`.
     * `streamer.stats().streetRuns` is the same fact one layer down.
     */
    locator,

    /**
     * The three combat dummies. `dummies[0]` is the post, `[1]` the pacer,
     * `[2]` the aggressor.
     *
     * `setAction` still pins a clip for inspection -- `sydney.dummies[0].setAction('punch')`
     * replays the bat swing (the clip kept the spec's name; see `game/combat.ts`), `setAction('knockout')` holds the crumple, and
     * `setAction(null)` returns the actor to whatever the simulation says it is
     * doing. It touches presentation only: a pinned clip does not change the
     * dummy's phase, its health or whether it can be hit, which is the right way
     * round now that the dummy is a real combatant rather than a scripted loop.
     */
    dummies: dummies.map((d) => ({
      kind: d.kind,
      combat: d.combat,
      actor: d.driver.actor,
      mesh: d.driver.actor.mesh,
      home: d.home,
      setAction: (name: ActionName | null) => d.driver.actor.setAction(name),
      get report() {
        return d.report;
      },
    })),

    /**
     * The old single-dummy handle, kept pointing at the post so the README's
     * recipes still work -- and **null online**, where there is no post.
     *
     * The guard is a bug fix rather than tidiness, and the bug it fixes is the
     * reason this pass could not read its own scoreboard from a console. Spec
     * 9's dummies are deliberately not spawned when a server is answering, so
     * `dummies` is empty online and `dummies[0].driver` threw a `TypeError`
     * **while this object literal was being built** -- which aborted the
     * `Object.assign` around it, so `boot` never reached `'ready'` and every
     * handle below this line never existed. The animation loop had already been
     * started by then, so nothing about it was visible: the game played
     * perfectly with a `window.sydney` frozen at its boot-time fields, on every
     * online session since the dummies stopped being spawned.
     */
    dummy:
      dummies.length === 0
        ? null
        : {
            actor: dummies[0].driver.actor,
            mesh: dummies[0].driver.actor.mesh,
            origin: dummies[0].home,
            setAction: (name: ActionName | null) => dummies[0].driver.actor.setAction(name),
            get state() {
              return dummies[0].report;
            },
          },

    /** The player's own combat state: pips, stamina, phase, knockout clock. */
    combat: playerCombat,

    /**
     * Everything about the fight in one object, on the terms `shadowReport` set.
     *
     * `flight` is the number spec 8.2 is actually specified in -- 6-8 m -- and it
     * is re-measured here rather than quoted, so a change to the impulse, to the
     * controller's friction or to the ragdoll's shows up as a number rather than
     * as a feeling.
     */
    combatReport() {
      return {
        player: {
          phase: playerCombat.phase,
          health: playerCombat.health,
          stamina: playerCombat.stamina,
          staminaT: playerCombat.staminaT,
          hitstopT: playerCombat.hitstopT,
          respawnT: playerCombat.respawnT,
        },
        dummies: dummies.map((d) => d.report),
        audio: audio.enabled,
        feedbackActive: feedback.active,
        selfChecks: verifyCombat(),
      };
    },

    /** Swing the bat from the console, for testing without a mouse. */
    punch() {
      punchBuffer = PUNCH_BUFFER;
    },
    /** The same thing under the name the weapon actually has. */
    swing() {
      punchBuffer = PUNCH_BUFFER;
    },

    /**
     * The cricket bat, in both of the places it exists.
     *
     * `viewmodel` is the one in front of your eye -- `sydney.bat.viewmodel.group`
     * takes a position and a rotation from the console, which is the only way to
     * re-pose it without a rebuild. `selfChecks` re-runs `verifyBat`, whose two
     * measured numbers are the interesting ones: how far the blade reaches
     * against what the hit test allows, and how close the resting bat comes to
     * the reticle.
     */
    bat: {
      assets: bats,
      viewmodel,
      self: selfBat,
      get reach() {
        return { hitTest: REACH, castRadius: CAST_RADIUS, viewmodelMax: MAX_VIEW_REACH };
      },
      selfChecks: () => verifyBat(),
    },

    /**
     * The connection, or null offline.
     *
     * `net.report` is the one to reach for: players, ping, how many snapshots
     * are buffered, and -- the two that actually diagnose anything --
     * `corrections` and `snaps`. A healthy session is a slow trickle of
     * sub-centimetre corrections and a snap only when somebody is batted. A
     * snap count climbing while nobody is fighting means the client and the
     * server are simulating differently, which has no other symptom than
     * rubber-banding.
     */
    get net() {
      return net;
    },

    /**
     * The scoreboard as a console table, which is the only way to read it
     * without holding a key.
     *
     * Worth its five lines for one reason: the embedded browser panes this
     * project is developed against **throttle a hidden tab**, so a screenshot of
     * a panel that only exists while `Tab` is down is not a reliable way to
     * check that any of this works. `sydney.scores()` is, and it reads exactly
     * what the panel draws -- the same `rankRoster` order over the same roster.
     *
     * Empty offline, where there is no roster and never was.
     */
    scores() {
      if (!net) return [];
      return net.leaderboard().map((r) => ({
        name: r.name,
        kos: r.kos,
        downs: r.downs,
        ping: r.bot ? '—' : `${r.ping} ms`,
        bot: r.bot,
        you: r.id === net.id,
      }));
    },

    /** Throw a football from the console, for testing without a mouse. */
    throwFooty() {
      throwBuffer = PUNCH_BUFFER;
    },

    /** Spec 8.3's field: every point the client has seen, and their state. */
    powerups,

    /**
     * Where the nearest live powerup of each kind is, and how far.
     *
     * The one thing a tester actually needs and cannot get by looking: an icon
     * is drawn through geometry to 60 m, so "I can see it" says nothing about
     * where it is. `walkTo` is the coordinate to hand `sydney.look`.
     */
    /**
     * What the traffic is doing, and where to stand to be hit by it.
     *
     * The one thing a tester cannot get by looking: a car is a lookup rather
     * than an object, so there is nothing in the scene graph to inspect and no
     * `nearestCar` anywhere in the codebase for anything but this. `standHere`
     * is the coordinate to assign to `sydney.player.position` to be run down on
     * the next tick, which is the whole of the manual test for this feature.
     */
    trafficReport() {
      const tick = trafficTick(Date.now());
      const found: Array<{
        metres: number; x: number; y: number; z: number; body: number;
        stage: number; speed: number; parked: boolean; knocksYouOver: boolean;
      }> = [];
      const probe = createCarPose();
      forEachCarNear(traffic, player.position.x, player.position.z, 120, tick, carRoutes, probe, (c) => {
        found.push({
          metres: Math.round(Math.hypot(c.x - player.position.x, c.z - player.position.z) * 10) / 10,
          x: Math.round(c.x * 10) / 10,
          y: Math.round(c.y * 10) / 10,
          z: Math.round(c.z * 10) / 10,
          body: c.body,
          stage: c.stage,
          speed: Math.round(c.speed * 10) / 10,
          // A car in a kerb bay between runs. It knocks nobody over, which is
          // why `standHere` below cannot be allowed to pick one.
          parked: c.stage === CAR_STAGE_PARKED_IN || c.stage === CAR_STAGE_PARKED_OUT,
          knocksYouOver: carHitStrength(c) > 0,
        });
      });
      found.sort((a, b) => a.metres - b.metres);
      const nearest = found[0];
      // The nearest car that will actually run you down. Since `game/traffic.ts`
      // gained its park stages, "nearest car" and "nearest hazard" are different
      // questions -- a parked one is furniture and a car easing out of a bay
      // shoves rather than launches -- and `standHere` is documented as the
      // coordinate that gets you hit, so it has to answer the second.
      const hazard = found.find((c) => c.knocksYouOver) ?? null;
      const parkedNear = found.find((c) => c.parked) ?? null;
      return {
        tick,
        drawn: trafficMovers.drawn,
        // Of `drawn`, the ones sitting in a kerb bay between runs. A schedule
        // car only ever appears or disappears while it is one of these, which is
        // what `game/traffic.ts`'s park stages bought.
        parked: trafficMovers.parked,
        costMs: Math.round(trafficMovers.costMs * 1000) / 1000,
        laneTiles: traffic.tileCount,
        routesResident: traffic.routes().length,
        liveNearby: found.length,
        hits: carHits.count,
        lastHitTick: carHits.lastTick,
        nearest: nearest ?? null,
        standHere: hazard ? { x: hazard.x, y: hazard.y + EYE_HEIGHT, z: hazard.z } : null,
        // The other half of the manual test: stand here and *nothing* should
        // happen, because the car you are standing against is parked.
        standBesideParked: parkedNear
          ? { x: parkedNear.x, y: parkedNear.y + EYE_HEIGHT, z: parkedNear.z }
          : null,
      };
    },

    /**
     * Get yourself wanted, without having to find a bystander first.
     *
     * `sydney.punch()`'s counterpart for this feature and it exists for the same
     * reason: the *interesting* part of the police is what happens in the forty-
     * five seconds after a crime, and reaching that state by hand means standing
     * behind the right pedestrian in front of the right pair of officers, which
     * takes longer than the thing being tested. This skips to it.
     *
     * **Offline it opens the real investigation**, through the same
     * `FactionField.accuse` the crime path uses, so everything downstream --
     * promotion, pursuit, the shooting, the countdown, the stand-down -- is the
     * real loop and not a mock of it. Online it is exactly the *prediction* a
     * crime would have made, which the server then overrules within 50 ms,
     * because there is no message a client can send that opens one for real. That
     * asymmetry is not a limitation of the helper; it is the feature working.
     *
     * `reason` is a `factions.REASON` byte, defaulting to the bystander one.
     */
    wanted(reason = REASON.ASSAULT) {
      predictInvestigation(reason);
      return {
        mode: net ? 'predicted (the server decides)' : 'opened (this client is the authority)',
        reason: reasonText(reason),
      };
    },

    /**
     * Where the police are, what they are doing, and how to get their attention.
     *
     * `pedestrianReport`'s argument verbatim and for the same reason: an officer
     * on a beat is a *lookup* -- there is no object in the scene graph for one
     * until a pooled rig picks them up, and a promoted one is a row in a map
     * rather than a node. There is nothing to inspect from the console without
     * this.
     *
     * `standHere` is a metre behind the nearest officer of the nearest pair, so
     * assigning it to `sydney.player.position` and swinging is the whole manual
     * test of the assault-police path. `nearestStation` is where to walk if
     * there are none in view, and `investigation` is the banner's own state --
     * which is the one thing here that is a fact about *you*.
     */
    policeReport() {
      const tick = trafficTick(Date.now());
      const beats: Array<{ metres: number; key: number; x: number; y: number; z: number; partner: number; station: string }> = [];
      const probe = createBeatPose();
      const scratch: PedBand[] = [];
      const ped = createPedPose();
      forEachPoliceNear(pedestrians, player.position.x, player.position.z, 200, tick, scratch, ped, probe, (p) => {
        beats.push({
          metres: Math.round(Math.hypot(p.x - player.position.x, p.z - player.position.z) * 10) / 10,
          key: p.key,
          x: Math.round(p.x * 10) / 10,
          y: Math.round(p.y * 10) / 10,
          z: Math.round(p.z * 10) / 10,
          partner: p.partner,
          station: POLICE_STATIONS[p.station]?.name ?? '?',
        });
      });
      beats.sort((a, b) => a.metres - b.metres);
      const promoted = [...policeField().actors].map((a) => ({
        id: a.id,
        state: Object.entries(NPC_STATE).find(([, v]) => v === a.state)?.[0] ?? String(a.state),
        metres: Math.round(Math.hypot(a.x - player.position.x, a.z - player.position.z) * 10) / 10,
        health: a.health,
        shotsFired: a.shotsFired,
      }));
      promoted.sort((a, b) => a.metres - b.metres);
      const near = beats[0];
      const station = nearestStation(player.position.x, player.position.z);
      const it = net ? net.investigation : (() => {
        const live = factions.investigationOf(playerCombat.id);
        return live ? { reason: live.reason, seconds: live.ticks / 60 } : null;
      })();
      return {
        tick,
        mode: net ? 'online (server authority)' : 'offline (client authority)',
        onTheBeat: beats.length,
        inPursuit: promoted.length,
        shotsHeard: policeStats.shots,
        rigsDrawn: squad.beats + squad.actors,
        costMs: Math.round(squad.costMs * 1000) / 1000,
        investigation: it ? { reason: reasonText(it.reason), seconds: Math.round(it.seconds * 10) / 10 } : null,
        beats: beats.slice(0, 8),
        pursuit: promoted.slice(0, 8),
        nearestStation: station
          ? {
              name: station.name,
              metres: Math.round(Math.hypot(station.x - player.position.x, station.z - player.position.z)),
              x: station.x,
              z: station.z,
              weight: station.weight,
            }
          : null,
        standHere: near ? { x: near.x, y: near.y + EYE_HEIGHT, z: near.z } : null,
      };
    },

    /**
     * The street, and where to stand to be rushed by somebody.
     *
     * `policeReport`'s argument verbatim, and it applies for the same reason: an
     * ambient meth head is a *function* rather than an object, so there is
     * nothing in the scene graph to inspect when somebody reports that Redfern
     * "feels empty" -- and the two possible causes, no anchors in range and
     * anchors whose bands have not streamed in, look identical from inside the
     * game.
     *
     * `standHere` is the useful field: a point inside sight range of the nearest
     * loiterer, so `sydney.player.position.set(...sydney.streetReport().standHere)`
     * is a one-liner that gets you charged at. `drunkHere` is its counterpart at
     * the edge of a drunk's personal space -- near enough that they are a real,
     * strikeable actor and far enough that they have not turned on you yet,
     * which is the window the crime rule lives in.
     */
    streetReport() {
      const tick = trafficTick(Date.now());
      const scratch: PedBand[] = [];
      const probe = createStreetPose();
      const here = player.position;
      const ambient: Array<{ kind: string; metres: number; x: number; y: number; z: number; anchor: string }> = [];
      forEachMethheadNear(pedestrians, here.x, here.z, 200, tick, scratch, probe, (p) => {
        ambient.push({
          kind: 'meth head',
          metres: Math.round(Math.hypot(p.x - here.x, p.z - here.z) * 10) / 10,
          x: Math.round(p.x * 10) / 10,
          y: Math.round(p.y * 10) / 10,
          z: Math.round(p.z * 10) / 10,
          anchor: SUBURBS[p.anchor]?.name ?? '?',
        });
      });
      const drunks: typeof ambient = [];
      forEachDrunkNear(pedestrians, here.x, here.z, 200, tick, scratch, probe, (p) => {
        drunks.push({
          kind: 'drunk',
          metres: Math.round(Math.hypot(p.x - here.x, p.z - here.z) * 10) / 10,
          x: Math.round(p.x * 10) / 10,
          y: Math.round(p.y * 10) / 10,
          z: Math.round(p.z * 10) / 10,
          anchor: `pub ${p.anchor}`,
        });
      });
      ambient.sort((a, b) => a.metres - b.metres);
      drunks.sort((a, b) => a.metres - b.metres);
      const promoted = [...policeField().actors]
        .filter((a) => isStreetKind(a.kind))
        .map((a) => ({
          id: a.id,
          kind: a.kind === NPC_KIND.METHHEAD ? 'meth head' : 'drunk',
          state: Object.entries(NPC_STATE).find(([, v]) => v === a.state)?.[0] ?? String(a.state),
          metres: Math.round(Math.hypot(a.x - here.x, a.z - here.z) * 10) / 10,
          health: a.health,
          // The passive/aggro flag the crime rule reads. See `streetlife.strikeCrime`.
          onYou: a.target >= 0,
        }));
      promoted.sort((a, b) => a.metres - b.metres);
      const m = ambient[0];
      const d = drunks[0];
      return {
        tick,
        mode: net ? 'online (server authority)' : 'offline (client authority)',
        suburb: nearestSuburbName(here.x, here.z),
        loitering: ambient.length,
        drinking: drunks.length,
        promoted: promoted.length,
        rigsDrawn: streetCrowd.ambient + streetCrowd.actors,
        costMs: Math.round(streetCrowd.costMs * 1000) / 1000,
        methHeads: ambient.slice(0, 6),
        drunks: drunks.slice(0, 6),
        onYou: promoted.slice(0, 8),
        // Inside `METH_SIGHT` with room to spare, so the sight test fires on the
        // next tick rather than on the edge of the radius.
        standHere: m ? { x: m.x + 14, y: m.y + EYE_HEIGHT, z: m.z } : null,
        // And just inside a drunk's personal space: promoted, noticed, and not
        // yet swinging.
        drunkHere: d ? { x: d.x + 3, y: d.y + EYE_HEIGHT, z: d.z } : null,
      };
    },

    /**
     * Who is on the footpath, and where to stand to bat one.
     *
     * `trafficReport`'s argument verbatim, and it applies more strongly: a
     * pedestrian is a lookup, there is no `Pedestrian` object anywhere in the
     * scene graph to inspect, and the far tier's figures are rows in an instance
     * buffer rather than nodes. `standHere` is a metre behind the nearest
     * walker's back, facing the way they are going, so assigning it to
     * `sydney.player.position` and swinging is the whole manual test.
     */
    pedestrianReport() {
      const tick = trafficTick(Date.now());
      const found: Array<{ metres: number; key: number; x: number; y: number; z: number; kit: number; down: boolean; dx: number; dz: number }> = [];
      const probe = createPedPose();
      forEachPedestrianNear(pedestrians, player.position.x, player.position.z, 120, tick, pedBands, probe, (p) => {
        found.push({
          metres: Math.round(Math.hypot(p.x - player.position.x, p.z - player.position.z) * 10) / 10,
          key: p.key,
          x: Math.round(p.x * 10) / 10,
          y: Math.round(p.y * 10) / 10,
          z: Math.round(p.z * 10) / 10,
          kit: p.kit,
          down: p.down,
          dx: p.dx,
          dz: p.dz,
        });
      });
      found.sort((a, b) => a.metres - b.metres);
      const nearest = found[0];
      return {
        tick,
        drawn: crowd.drawn,
        rigged: crowd.rigged,
        costMs: Math.round(crowd.costMs * 1000) / 1000,
        footpathTiles: pedestrians.tileCount,
        bandsResident: pedestrians.bands().length,
        slotsResident: pedestrians.slotCount,
        within120m: found.length,
        knockedOver: pedHits.count,
        lastHitTick: pedHits.lastTick,
        currentlyDown: pedestrians.lyingCount(tick / 60),
        /** Knockdowns still carrying a schedule offset. See `PedestrianField.downCount`. */
        remembered: pedestrians.downCount,
        nearest: nearest ?? null,
        standHere: nearest
          ? {
              // A metre behind them, so a swing from here lands. `combat.REACH`
              // is 1.55 m and the cast is 0.48 m wide, so one metre is
              // comfortably inside it from any approach angle.
              x: Math.round((nearest.x - nearest.dx) * 10) / 10,
              y: nearest.y + EYE_HEIGHT,
              z: Math.round((nearest.z - nearest.dz) * 10) / 10,
            }
          : null,
      };
    },

    powerupReport() {
      const at = (kind: 0 | 1 | undefined) => {
        const p = powerups.nearest(player.position.x, player.position.z, kind);
        if (!p) return null;
        return {
          kind: POWERUP_NAME[p.kind],
          x: Math.round(p.x * 10) / 10,
          y: Math.round(p.y * 10) / 10,
          z: Math.round(p.z * 10) / 10,
          metres: Math.round(Math.hypot(p.x - player.position.x, p.z - player.position.z) * 10) / 10,
          active: p.active,
          respawnIn: Math.round(p.respawnT),
          walkTo: { x: p.x, y: p.y + EYE_HEIGHT, z: p.z },
        };
      };
      return {
        ...powerups.report,
        nearestTraining: at(TRAINING),
        nearestFlatWhite: at(FLAT_WHITE),
        player: {
          trainingT: playerCombat.trainingT,
          flatWhiteT: playerCombat.flatWhiteT,
          speed: speedScale(playerCombat),
          damage: damageScale(playerCombat),
          fov: camera.fov,
        },
        selfChecks: verifyPowerups(),
      };
    },

    /** The local player's own body -- on the shadow layer, so it is only ever seen as a shadow. */
    self,

    /**
     * Everything about the character build in one object, on the terms
     * `shadowReport` sets: numbers to check a claim against rather than guess at.
     */
    characterReport() {
      return {
        triangles: characters.triangles,
        vertices: characters.vertices,
        bones: dummies[0].driver.actor.bones.length,
        colourways: COLOURWAYS.map((c) => c.name),
        materials: 1,
        geometries: characters.geometries.length,
        /** What the sun's shadow camera can see. Bit 0 is the world, bit 1 is the self body. */
        shadowLayerMask: sky.sun.shadow.camera.layers.mask,
        cameraLayerMask: camera.layers.mask,
        dummies: dummies.map((d) => d.report),
      };
    },

    /** Move the camera and the player to a viewpoint, for inspecting the world. */
    look(view: { x: number; y: number; z: number; yaw?: number; pitch?: number }) {
      player.position.set(view.x, view.y, view.z);
      player.velocity.set(0, 0, 0);
      input.yaw = view.yaw ?? input.yaw;
      input.pitch = view.pitch ?? input.pitch;
      applyToCamera(player, camera);
    },

    setRenderScale(v: number) {
      renderScale = v;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * v);
    },

    /**
     * Everything about the shadow rig in one object, for attributing a look or a
     * frame cost to a specific number rather than guessing at it.
     */
    shadowReport() {
      const shadow = sky.sun.shadow;
      const cam = shadow.camera;
      const s = streamer.stats;
      return {
        enabled: renderer.shadowMap.enabled,
        type: renderer.shadowMap.type,
        mapRendered: sky.shadowMapReady,
        mapSize: shadow.mapSize.x,
        metresPerTexel: (sky.shadowRadius * 2) / shadow.mapSize.x,
        radius: sky.shadowRadius,
        near: cam.near,
        far: cam.far,
        bias: shadow.bias,
        /** What `bias` actually costs on the ground, in metres. */
        biasMetres: shadow.bias * (cam.far - cam.near),
        normalBias: shadow.normalBias,
        pcfRadius: shadow.radius,
        sunAltitude: sky.solar.altitude,
        /** Shadow length as a multiple of caster height, at the current time. */
        shadowLengthPerMetre: 1 / Math.tan((sky.solar.altitude * Math.PI) / 180),
        tilesCasting: s.casting,
        tilesReceiving: s.receiving,
      };
    },

    /**
     * Re-size the shadow map live, for measuring what it costs.
     *
     * Setting `mapSize` is the whole of it: three re-reads it at the top of
     * every shadow render and resizes the target, and the PCF filter takes it as
     * a uniform rather than baking it into the shader, so nothing is recompiled.
     */
    setShadowMapSize(size: number) {
      sky.sun.shadow.mapSize.set(size, size);
    },
  });
}

/**
 * Whether this browser has been here before, and marking it as having been.
 *
 * One flag, set the first time the game boots far enough to reach `hud.ready`.
 * What it buys is the one sentence in `hud.ready` that explains the only part of
 * this game that behaves differently on a first visit: 350 MB of city arriving
 * while you walk through it, over a link that has none of it cached. Saying so
 * once turns "it was a bit rough at the start" into an expectation; saying it
 * every session would be the most annoying thing in the interface.
 *
 * Written *before* the note is shown rather than after, so a player who reloads
 * during the first minute is not told twice -- the second load is genuinely a
 * second visit, cache and all.
 *
 * Wrapped, because `localStorage` throws rather than degrades in a browser with
 * storage disabled or a page in a partitioned third-party context, and a
 * friendly note is not worth a boot failure. The failure mode of the catch is
 * that the note shows every time, which is the behaviour of the build before
 * this one.
 */
function firstVisit(): boolean {
  try {
    if (localStorage.getItem('sydney.visited')) return false;
    localStorage.setItem('sydney.visited', String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

/**
 * The name from last time, and this time's on the way out.
 *
 * Wrapped for `firstVisit`'s reason -- `localStorage` **throws** rather than
 * degrading in a browser with storage disabled or in a partitioned third-party
 * context, and a prefilled field is not worth a boot failure. The failure mode
 * of the catch is that the prompt suggests a fresh name every session, which is
 * the behaviour of a first visit and is entirely playable.
 *
 * Sanitised on the way **in** as well as on the way out, because what comes back
 * out of storage is a string a user can edit in a devtools panel and this is the
 * only path into the game that does not go past the prompt.
 */
function loadName(): string {
  try {
    return sanitiseName(localStorage.getItem('sydney.name') ?? '');
  } catch {
    return '';
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem('sydney.name', name);
  } catch {
    // See above. Not being remembered is not a failure worth reporting.
  }
}

/**
 * Where the game server is, or null for "do not even try".
 *
 * Three sources in precedence order, and the default is the one that matters:
 * **this page's own host on port 8787**, so opening a second tab on this machine
 * joins the same match with no configuration at all. That is the deliverable
 * this whole pass exists for, and any default that needed a query parameter
 * would have failed it.
 *
 *   `?server=localhost:8787`   an explicit host, or a whole ws:// URL
 *   `?server=none` / `?offline`  force spec 9's local stub
 *   `localStorage['sydney.server']`  the same, sticky across reloads
 *
 * A page served over `https:` gets `wss:`, because a browser refuses a plain
 * WebSocket from a secure origin -- and refuses it with a console error that
 * says nothing about mixed content, which is an hour nobody needs to spend.
 */
function resolveServerUrl(): string | null {
  const params = new URLSearchParams(location.search);
  const asked = params.get('server') ?? localStorage.getItem('sydney.server') ?? '';
  if (params.has('offline') || asked === 'none' || asked === 'off') return null;
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (asked) {
    if (asked.startsWith('ws://') || asked.startsWith('wss://')) return asked;
    return `${scheme}//${asked.includes(':') ? asked : `${asked}:8787`}`;
  }
  // Served over HTTPS means production behind Caddy, where the game socket is
  // proxied on the same origin at /ws -- one port, one certificate, and no
  // mixed-content block (an https page may not open a ws: socket at all).
  if (location.protocol === 'https:') {
    return `wss://${location.host}/ws`;
  }
  // `location.hostname` rather than `location.host`, because in dev the page is
  // on vite's 5173 and the server is on 8787 -- carrying the port over would
  // send every client to a WebSocket on the dev server.
  return `${scheme}//${location.hostname || 'localhost'}:8787`;
}

/**
 * The HTTP origin behind a `ws://` or `wss://` URL, for `/rooms` and `/health`.
 *
 * A textual swap rather than a `new URL(...)` round trip, and the reason is the
 * one case that matters: production is `wss://host/ws`, proxied by Caddy, and
 * the gateway route is `https://host/rooms` -- **not** `https://host/ws/rooms`.
 * So the path is dropped along with the scheme, which is what `URL.origin`
 * would have given anyway, without the parse that throws on a malformed
 * `?server=` a player typed.
 *
 * See DEPLOY.md: when a deployment fans out to several host processes, `/rooms`
 * stays on the primary and the per-host sockets are `/ws/<n>`, so this
 * deliberately points at the origin rather than at the socket's own path.
 */
function httpBaseOf(wsUrl: string): string {
  const noScheme = wsUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
  const slash = noScheme.indexOf('/', noScheme.indexOf('://') + 3);
  return slash < 0 ? noScheme : noScheme.slice(0, slash);
}

/**
 * The room this page was asked to join, or null.
 *
 *     ?room=3     join room 3 -- what an invite link is
 *
 * Null means "the gateway picks", which is what every ordinary visit is. A room
 * that is full is still *asked for* rather than swapped out; see
 * `net/client.chooseRoom` for why being told is better than being rehomed.
 */
function requestedRoom(): number | null {
  const raw = new URLSearchParams(location.search).get('room');
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

void main();
