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
  Group,
  NeutralToneMapping,
  Object3D,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  Vector2,
  Vector3,
  WebGPURenderer,
  type Material,
} from 'three/webgpu';

import { BOARD_HINT_M, DoorMarker, verifyDoorMarker } from './world/doormarker.ts';
// --- The screaming sun and the button in Sydney Park. One feature, two files:
//     the rules (shared with the server) and the renderer. See
//     `game/sunbutton.ts` for where the button is and why it is there.
import { sunScreaming, sunScreamMix, verifySunButton } from './game/sunbutton.ts';
import { SunFeature, verifySunButtonRenderer } from './world/sunbutton.ts';
import { EXPOSURE } from './sky/calibration.ts';
import { SydneySky } from './sky/sky.ts';
import { verifyCycle } from './sky/cycle.ts';
import { verifyDuskRig } from './sky/dusk.ts';
import { verifyLunar } from './sky/lunar.ts';
import { verifyMoonDisc } from './sky/moon.ts';
import { verifySkyglow } from './sky/skyglow.ts';
import { SkyClockHud, verifyClock } from './sky/clock.ts';
import { verifySouthernHemisphere } from './sky/solar.ts';
import { fetchWorldAsset, verifyCdn } from './world/cdn.ts';
// The world's segments. Everything positional in this file that used to make a
// single pass over `index.json` at boot now makes that same pass once per hex
// as the player approaches it -- see `world/hexes.ts`.
import { hexContract, hexesArmed, hexesNear, onHexTiles } from './world/hexes.ts';
import { createFacadeGlobals } from './world/facade.ts';
import { loadFarLayer } from './world/far.ts';
import { loadLandmarks, verifyLandmarks } from './world/landmarks.ts';
import { createFarGround } from './world/ground.ts';
import { CUT_SUBDIVISION, NO_GROUND } from './world/terrain.ts';
import { WaterLevels, verifyWading } from './world/wading.ts';
import { loadFarWater, verifyWater } from './world/water.ts';
import { atlasTextureSize } from './world/params-atlas.ts';
import { TileStreamer, type WorldIndex } from './world/streamer.ts';
import { BODY_COUNT, CAR_PAINT_COUNT, TrafficMovers, carBodySizes } from './world/cars.ts';
// --- Workstream Q: nothing appears or disappears while you are looking at it.
import { ViewLatch, verifyViewLatch } from './game/viewlatch.ts';
import { SWEEP_HZ, loadCarModels } from './world/carlod.ts';
import {
  CAR_BODY_SIZE,
  CAR_STAGE_PARKED_IN,
  CAR_STAGE_PARKED_OUT,
  TrafficField,
  applyCarHit,
  carHitStrength,
  carHitting,
  createBayPose,
  createCarPose,
  forEachCarNear,
  nearestBay,
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
import { PipelineWatch, auditWarmup, warmUpPipelines, type WarmupPart } from './world/warmup.ts';
// WORKSTREAM AB: where the browser frame goes. One import block and one
// `FrameProfile` in the loop's closure; every `frame.at(FSEC.x)` below is a
// single line at a boundary that already existed. See `client/src/frameprofile.ts`.
import { FSEC, FrameOverlay, FrameProfile, verifyFrameProfile } from './frameprofile.ts';
import { uploadReport, verifyInstanceUpload } from './world/instupload.ts';
import {
  NIGHT_VISIBLE_LEVEL,
  NightLights,
  createTorchMount,
  torchBikeMount,
  torchHandMount,
  verifyNightLights,
  verifyTrainLightKit,
} from './world/nightlights.ts';
import { CollisionWorld } from './player/collision.ts';
import {
  EYE_HEIGHT,
  PLAYER_RADIUS,
  STEP_HEIGHT,
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
import { BONE, PUNCH_ACTIVE, PUNCH_WIND_UP, verifyAnimation } from './player/animation.ts';
import { BatAssets, BatProp, BatViewmodel, MAX_VIEW_REACH, verifyBat } from './player/bat.ts';
// --- Workstream I: your own hands, for the slot that holds nothing.
//
// *"i cant see my hands while punching"*. Slot 4 is fists and had no
// viewmodel at all, so a punch was a hitstop and a sound. `player/hands.ts`
// is the bat viewmodel's shape twice over -- two mitts on the camera, posed
// from a pure function in `game/hands-pose.ts` -- and everything this file
// does about it is four short blocks marked "Workstream I".
import { HandsAssets, HandsViewmodel, verifyHands } from './player/hands.ts';
// --- Money, the phone and the weapon slots. See `client/src/money.ts`.
//
// One import and one `installMoney(...)` call, and everything else this feature
// does to this file is four one-line hooks inside handlers that already exist.
// `money.ts`'s header says why the hooks are called from here rather than
// listened for from there.
import { verifyCash } from './game/cash.ts';
// `SLOT` as well as the check, so `setWeaponVisible` below can tell "fists"
// from "phone" -- both of them say "no bat", and only one of them wants hands.
import { verifyPhone } from './phone.ts';
import { SLOT } from './game/phone.ts';
import { installMoney } from './money.ts';
import {
  applyWorldDamage,
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
import {
  SPAWN_DITHER_RADIUS,
  SPAWN_TARGET,
  pickSpawnPoint,
  spawnCentre,
  verifySpawn,
} from './game/spawn.ts';
// The knockout clock, for the one place the police are the cause of one. See
// `offlineFactionCtx`'s `damagePlayer`, which is `combat.applyHit` without a
// puncher.
import { KO_SECONDS } from './game/combat.ts';
import {
  BALL_CHARGES,
  BALL_RECHARGE,
  createHitReport,
} from './game/combat.ts';
import {
  BALL_RADIUS,
  FootyField,
  LAUNCH_SPEED,
  applyFootyHit,
  verifyFooty,
  type Footy,
  type FootyEvent,
} from './game/footy.ts';
// --- F: bat swats the footy. The shared adjudication, run here offline exactly
// as `server/sim.ts` runs it online, and the twelve-triangle contact puff that
// is the picture half of it. See `game/swat.ts` and `world/swatpuff.ts`.
import { SWAT_RADIUS, SWAT_SPEED_SCALE, createBallAt, swatBalls, verifySwat } from './game/swat.ts';
import { SwatPuffs, verifySwatPuff } from './world/swatpuff.ts';
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
import { verifyTeleport } from './game/teleport.ts';
// --- WORKSTREAM W: talent effects. One import block and three call sites (the
// self-check below, the tick clock in the frame loop, and `tickTalentKeys` in
// the fixed step); all of the logic is in the three modules named here. Every
// hook is the identity until something calls `setTeamLookup`, which is the
// framework workstream's job -- so this block changes nothing on its own.
import { verifyAbilities } from './game/abilities.ts';
import { AGENT_CHEER_M, fxSetNow, setTeamLookup, verifyTeamFx } from './game/teamfx.ts';
import { tickTalentKeys, LOCAL_ID } from './game/talentkeys.ts';
// --- WORKSTREAM Z: the nine talents that had no call site. One import block;
// two marker sources and two feed lines hang off it. See `game/talentlive.ts`.
import {
  allyKoLine,
  allyNounNear,
  enemyMarkerKind,
  enemyMarkerRangeM,
  markRbts,
  rbtMarkersOn,
  verifyTalentLive,
} from './game/talentlive.ts';
import { verifySuggestions } from './net/suggestions.ts';
import { SuggestionsPanel, clientId } from './suggestions.ts';
// --- WORKSTREAM V: teams and talents. The contract (the 42 nodes and the two
// names), the aura fold, the wire, and the panel. See `game/teams.ts`.
import { EMPTY_MASK, TEAM, TEAM_NAME, verifyTeams, type Team } from './game/teams.ts';
import { verifyTeamField } from './game/teamfield.ts';
import { verifyTeamsWire } from './net/teams.ts';
import { TalentsPanel, verifyTalentsPanel } from './teams.ts';
import { BuildSheet, verifyBuildSheet } from './buildsheet.ts';
import { ChangelogFeed, verifyChangelog, verifyChangeFeed } from './changelog.ts';
import { BugReportForm, FrameGrabber, verifyBugReport } from './bugreport.ts';
// --- Accounts, handles and the level ladder. Workstream G.
//
// `JoinGate` owns the landing panel (which used to be `hud.askName`), the
// session token, and the "sign up to send feedback" blocks in the Escape box.
// `verifyAccounts` is the shared rules module's check, run here as well as on
// the server for `verifyNames`' reason: both ends fold a handle and both ends
// compute a level, and the whole arrangement only works if the two runs agree.
import { JoinGate } from './accounts.ts';
import { verifyAccounts } from './net/accounts.ts';
import { ANIM, PROTOCOL_VERSION, SNAPSHOT_INTERVAL, TEAM_EVENT_KIND, sanitiseName, suggestName, verifyNames, verifyNet } from './net/protocol.ts';
import { verifySnapshotRate } from './net/snapshotrate.ts';
import {
  FootyAssets,
  FootyPool,
  FootyProp,
  FootyViewmodel,
  THROW_SECONDS,
  footyWarmupParts,
  verifyFootyBall,
} from './world/footyball.ts';
import { NameplateField, nameplateWarmupParts, verifyNameplates, type PlateInput } from './world/nameplates.ts';
// --- WORKSTREAM X: teams you can see. One import block; the wiring is one
// contiguous section beside the local player's body and two lines in the loop.
import { AURA_RING_M, GROUP_RING_M, MAX_RINGS, SLAM_SECONDS, teamMarkerKind, verifyTeamLook } from './game/teamlook.ts';
import { groupSizeFor, hasAura, hasBigNight, hasTeamSource, setTeamSource, teamOf } from './world/teamview.ts';
import {
  BigNightKit,
  HornProp,
  TeamRingField,
  TentSet,
  setHorns,
  setTeamBody,
  teamLookWarmupParts,
  verifyBigNightKit,
  type TentSpec,
} from './world/teamlook.ts';
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
// --- Workstream B: taking a car. One import block, one install call, and every
// line of logic in `game/driving.ts` (the rules, three-free, shared with the
// server) and `world/drivencars.ts` (the picture). See either header.
import {
  CarField,
  CAR_HEALTH_MAX,
  DRIVE_CAM_DISTANCE,
  DRIVE_CAM_LIFT,
  DRIVE_TOP_SPEED,
  MAX_DRIVEN_CARS,
  PARK_SNAP_RADIUS,
  createDrivingScratch,
  crashDamage,
  // WORKSTREAM T: driving into the ambient fleet is a crash, not an ejection.
  crashIntoTraffic,
  snapToBay,
  verifyDamageGrade,
  resolveTake,
  shapeDriveSteering,
  verifyDriving,
  TAKEABLE_SPEED,
  TAKE_HEIGHT,
  TAKE_RADIUS,
  type DriveSteering,
  type DriverView,
} from './game/driving.ts';
// --- WORKSTREAM S: the parked fleet, as something a player can steal. The field
// is fed by the streamer (`setStaticCarSink`) and asked by `resolveTake`; see
// `game/staticcars.ts` and `game/driving.ts` section 1, which this retires.
import { StaticCarField, verifyStaticCars } from './game/staticcars.ts';
import {
  DrivenCarView,
  HonkWatch,
  carHealthClass,
  carHealthWidth,
  speedText,
  takePrompt,
  verifyDrivenCars,
  type DriverPose,
} from './world/drivencars.ts';
// --- Workstream H: crash damage, cars that stay, and the queue behind them. The
// smoke rig is the only new mesh; everything else in the workstream reaches the
// screen through modules this file already wires. See `world/carsmoke.ts`.
import { CarSmoke, verifyCarSmoke } from './world/carsmoke.ts';
// --- WORKSTREAM Y: and the end of a car's life. The rules are three-free and
// live in `game/carfire.ts`; what this file wires is the notice, the countdown
// chip, the boom and the shockwave. See that module's header.
import {
  BOOM_RING_S,
  BURN_NOTICE,
  createFireGrade,
  fireChip,
  fireGrade,
  fuseExpired,
  isBurning,
  verifyCarFire,
} from './game/carfire.ts';
import {
  BIKE_LEAN,
  BikeAssets,
  BikeMeshes,
  RiddenBike,
  buildTuningStall,
  verifyBikeGlow,
  verifyBikeMesh,
} from './world/bike.ts';
import { CombatAudio, RAVE_AUDIBLE_RANGE } from './game/audio.ts';
// The camera distance, which is a *scalar* and not a mode -- see `game/camera.ts`
// for why the boolean this replaced was the reported bug rather than a feature.
import {
  CAMERA_MAX,
  CHASE_RADIUS,
  isThirdPerson,
  liveCameraDistance,
  loadCameraDistance,
  marchCameraBoom,
  saveCameraDistance,
  stepCameraDistance,
  toggleCameraDistance,
  verifyCamera,
} from './game/camera.ts';
import { FOV_BASE, Feedback } from './game/feedback.ts';
import { Locator, verifyLocator } from './game/locator.ts';
// WORKSTREAM N (carry): "back where you left off", the one sentence a restored
// session is visible as. See `game/carry.ts` for why the suburb is this end's.
import { installRestoredNotice, verifyCarry } from './game/carry.ts';
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
import { PoliceAssets, PoliceSquad, Tracers, policeWarmupParts, verifyPoliceKit } from './world/police.ts';
// --- The heat ladder (workstream D). Pure logic in `game/heat.ts`, which the
// server imports too; the patrol car, the RBT props and the Polair spotlight in
// `world/highway-patrol.ts`, which imports three and the server never sees.
import {
  HeatField,
  heatLine,
  installHeat,
  stepHeat,
  verifyHeat,
  HEAT_MAX,
  type HeatWorld,
} from './game/heat.ts';
import {
  HighwayPatrolAssets,
  HighwayPatrolFleet,
  Polair,
  createPolairView,
  highwayPatrolWarmupParts,
  verifyHighwayPatrol,
} from './world/highway-patrol.ts';
// Workstream R: the helicopter's orbit, its beam schedule and its marksman. Pure,
// three-free and shared with the authority, which is why nothing about Polair is
// on the wire -- see `game/polair.ts` section 3.
import { verifyPolair } from './game/polair.ts';
// The illegal raves, on the same two-file split as everything ambient in this
// build: `game/rave.ts` is the arithmetic every client agrees about -- which
// warehouse, viaduct or park is live tonight, what is on the decks, where forty
// people are standing -- and `world/rave.ts` is the rig, the lasers and the
// haze. Nothing about a rave crosses the wire; see either header.
import {
  EMPTY_BAG,
  RAVE_CYCLE_MS,
  SYDNEY_PARK_SITE,
  beatAt,
  deckTitle,
  drawRaves,
  liveRaves,
  nightStartMs,
  raveNight,
  raveState,
  recordBag,
  setPosition,
  verifyRaves,
  type RecordBag,
} from './game/rave.ts';
import { RaveAssets, RaveWorld, raveWarmupParts, verifyRaveKit } from './world/rave.ts';
import {
  RailAssets,
  RailWorld,
  buildNetwork,
  drawnTriangles,
  loadRailBake,
  railWarmupParts,
  verifyRailGeometry,
  type RailNetwork,
} from './world/rail-geo.ts';
// The arithmetic half of the railway, which the server evaluates too. See
// `world/rail-solids.ts` for why the definition lives outside the renderer.
import { RailSolidField } from './world/rail-solids.ts';
import { TrainFleet, verifyTrainLights } from './world/trains.ts';
import {
  aboardFrame,
  aboardPose,
  buildPlatforms,
  buildStationBoxes,
  callsAhead,
  dwellAt,
  dwellStand,
  nextDwell,
  alightPlatform,
  alightTrackside,
  bailoutDamage,
  boardHere,
  clearAboard,
  consistOf,
  createBoardOffer,
  createCarFrame,
  createCarriageStand,
  createRideBanner,
  dirOf,
  findBoarding,
  frameYaw,
  insideCarriage,
  interiorOfCar,
  isAboard,
  nearestDwell,
  nextCall,
  poseAheadOnLine,
  projectAboard,
  rideBanner,
  rideEnter,
  rideExit,
  // Workstream O: the train's slightly lower view, which is a camera term and
  // touches nothing the simulation reads. See `game/riding.RIDER_VIEW_DROP_M`.
  riderViewEye,
  RIDE_ON,
  spanFlagsAt,
  stopPlatform,
  verifyRiding,
  worldToLocal,
  type CarriageInterior,
  type PlatformField,
  type Stand,
  type StationBoxField,
} from './game/riding.ts';
import { SPAN_TUNNEL, railSeconds, verifyRail } from './game/rail.ts';
// What the train is saying, which is a lookup on the same timetable the train
// itself is a lookup on. See `game/rail-audio.ts`: no queue, no timers, and the
// sound system is handed a mix exactly as `world/rave.ts` hands it one.
import {
  createRailAnnounceMix,
  railAnnounceMix,
  verifyRailAudio,
} from './game/rail-audio.ts';
import { RailCut } from './world/rail-cut.ts';
import { RoadDeck, verifyRoadDeck } from './world/road-deck.ts';
import { ClearanceEnvelope, verifyEnvelope } from './world/envelope.ts';
import { verifyUndercroft } from './world/undercroft.ts';
// Phase 1 of `STATIONS.md`: the vessel primitive and its manifold invariant.
// Nothing in the build reads a vessel yet -- `vesselsEnabled()` is off and no
// call site consults it -- so this import brings in the self-check and nothing
// else. It is here because a self-check nothing runs is a self-check that rots,
// and the browser is not in CI.
import { setVesselsEnabled, verifyVessels, vesselsEnabled } from './world/vessel.ts';
import { verifySeam } from './world/seam.ts';
import { buildCorridor, corridorCut, type CorridorBuild } from './world/corridor.ts';
import type { VesselField } from './world/vessel-field.ts';
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
import { StreetCrowd, StreetlifeAssets, streetlifeWarmupParts, verifyStreetlifeKit } from './world/streetlife.ts';
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
// --- Workstream E: five more characters, and the ambient events they stand
// around in. Same split once more -- `game/characters.ts` and `game/events.ts`
// are the shared simulation the server runs, `world/characters.ts` and
// `world/events.ts` are the renderers. See any of the four headers.
import {
  createCharacterPose,
  dayAtTick,
  daylight,
  forEachCharacterNear,
  saturdayAt,
  AGENT_APPLAUSE_LINE,
  KAREN_REPORT_LINE,
  POSTED_LINE,
  POSTED_LINE_BYSTANDER,
  POSTED_RANGE,
  TRADIE_HELP_LINE,
  characterStruck,
  isCharacterKind,
  karenWitness,
  stepCharacters,
  verifyCharacters,
} from './game/characters.ts';
import { CharacterCrowd, CharacterKitAssets, characterWarmupParts, verifyCharacterKit } from './world/characters.ts';
import { EVENT_NAME, stepEvents, sweepEvents, verifyEvents } from './game/events.ts';
import { EventAssets, EventScene, eventWarmupParts, inTrackworkQueue, verifyEventKit } from './world/events.ts';
import { verifyWallet } from './game/wallet-contract.ts';
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

/**
 * WORKSTREAM AB: how long the **shader** passes get, which is no longer the same
 * number.
 *
 * The boot log said `the shader warm-up did not finish in 11000 ms`, and what
 * that message means is worth being precise about: `withDeadline` does not
 * cancel anything. The compile keeps running, yielding to the main thread
 * between render objects, and finishes whenever it finishes. What the deadline
 * decides is whether the player is *already playing* while it does -- and a
 * player who is already playing is drawing objects whose pipelines are not
 * compiled yet, which takes `Pipelines.getForRender`'s blocking branch inside
 * `render`. That is precisely the hitch this whole subject exists to remove,
 * and it is what `PipelineWatch` counts.
 *
 * So the deadline is not a safety net here in the way it is for a fetch. For an
 * asset, 11 s means "the harbour has no bridge on it but the game runs"; for
 * this, it means "the game runs and stutters for the next thirty seconds",
 * which is worse than eight more seconds of a loading screen that is telling
 * the truth.
 *
 * Twenty-five seconds, and it is still a bound rather than a wait: a driver that
 * has genuinely wedged must not brick a boot, which is the only thing the
 * original number was ever protecting against. It is a **separate constant**
 * from `WARMUP_DEADLINE_MS` because the eight other things sharing that number
 * -- the rail bake, the car models, the far layer, the ground -- are fetches
 * with a fallback, and giving those 25 s would be 14 s of a player staring at
 * nothing for an asset the game can do without.
 *
 * The other half of this pass is that the work itself got smaller: the boot
 * warm-up was submitting 42% duplicate draws, which `warmup.partSignature` now
 * drops. See its header for the count.
 */
const SHADER_WARMUP_DEADLINE_MS = 25000;

/**
 * How long the 1 MB rail bake gets before the railway is written off.
 *
 * At module scope rather than beside `FAR_LAYER_DEADLINE_MS` because it is
 * awaited **above** the shader warm-up -- the sign atlas has to exist before the
 * sign material is compiled -- and `FAR_LAYER_DEADLINE_MS` is a `const` four
 * hundred lines below that point. Same generous shape and the same rule: a bake
 * that does not arrive costs the city its railway and not its boot.
 */
const RAIL_BAKE_DEADLINE_MS = 12000;

async function main(): Promise<void> {
  const hud = new Hud();
  // The day/night clock, top centre. Constructed here beside the HUD rather than
  // inside it because it is fed the sky's own `SkyClock` rather than the
  // `HudState` the overlay takes, and because it draws whether or not the debug
  // overlay is showing -- it is a player-facing readout, not a diagnostic. It
  // writes its own SVG into `index.html`'s empty `#clock`; see `sky/clock.ts`.
  const clockHud = new SkyClockHud();

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
  // And the hands, on the same criterion. Four of this check's failures are
  // invisible from the seat of whoever built it: a mirrored hand drawn inside
  // out looks like a shading bug, a mitt a different size from the body's is
  // only visible if you press `V` mid-punch, a hand past the near budget clips
  // the wall you are already standing against, and a jab that does not travel
  // far enough down the view axis is *exactly* the report this file's newest
  // viewmodel exists to answer -- a punch you cannot see. See `player/hands.ts`.
  const handsFailures = timed('hands', verifyHands);
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
  // And the one interaction between the two weapons, on the same criterion and
  // with the same shape of failure: **every broken version of a swat renders a
  // perfectly good frame.** A window that is not the ACTIVE phase makes the
  // mechanic untimed, an owner that does not change hands sends a returned ball
  // straight through the person who threw it, and a deflection that adds speed
  // rather than steering it overflows the wire on the fourth exchange. None of
  // the three throws and none has a frame that says otherwise. The server runs
  // this same function before it opens its socket. See `game/swat.ts`.
  const swatFailures = timed('swat', verifySwat);
  const swatPuffFailures = timed('swat puff', verifySwatPuff);
  const footyBallFailures = timed('footy model', verifyFootyBall);
  const netFailures = timed('net', verifyNet);
  const clientFailures = timed('net client', verifyNetClient);
  // WORKSTREAM AD: and the snapshot rate's arithmetic, which is a statement
  // about *this* side -- whether the 100 ms interpolation buffer still covers
  // the interval the server is sending at. The server runs the same function
  // before it opens its socket; it is the one that reads the environment.
  const rateFailures = timed('snapshot rate', verifySnapshotRate);
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
  const teleportFailures = timed('teleport', verifyTeleport);
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
  // --- WORKSTREAM V. Four checks for one feature, and the split is by what
  // each one can see. `verifyTeams` is the contract's: the tier arithmetic the
  // whole ten-point economy rests on, and the **spelling** of the two names,
  // which renders perfectly when it is wrong and is seen by every player.
  // `verifyTeamField` is the aura fold, cross-checked against the contract's own
  // `ownScalar` over randomised masks -- it runs here as well as on the server
  // because this side *predicts* with it and a disagreement is a swing that
  // lands in one runtime and not the other. `verifyTeamsWire` is the bytes.
  // `verifyTalentsPanel` is the only one of the four that is browser-only, and
  // it exists for one reason: the panel has player-facing copy that
  // `verifyTeams` cannot grep. See `client/src/teams.ts`.
  const teamFailures = timed('teams', verifyTeams);
  const teamFieldFailures = timed('team auras', verifyTeamField);
  const teamWireFailures = timed('teams wire', verifyTeamsWire);
  const talentPanelFailures = timed('talents panel', verifyTalentsPanel);
  const buildSheetFailures = timed('build sheet', verifyBuildSheet);
  // And the two tabs beside it, on the same criterion a fourth and fifth time.
  // The change feed's failures are all *text*: a parser that trusts the shape
  // draws "undefined" three times on any host that answers a missing file with
  // `index.html`, and a date arithmetic in milliseconds mis-labels the newest
  // entry exactly when somebody is checking whether their fix shipped. The bug
  // box has one failure that is worse than text and is the reason this feature
  // was asked for at all: a **blank capture**, which is a valid PNG of nothing
  // that looks like the game rendering black, and which nothing downstream can
  // tell from a real frame. `verifyBugReport` carries the negative control that
  // keeps a legitimately dark screenshot attachable. See `changelog.ts` and
  // `bugreport.ts`; the server runs neither, because neither has a server half.
  const changelogFailures = timed('change feed', () => [...verifyChangelog(), ...verifyChangeFeed()]);
  const bugFailures = timed('bug box', verifyBugReport);
  // And the map readout, on the same criterion again. Every way this breaks
  // leaves a plausible street name under the map: the street behind you, the
  // street a hundred metres past the end of a way, a corner claimed halfway
  // down a block, or "cnr Crown St & Crown St". None of them throws and none of
  // them has a frame that says otherwise -- see `verifyLocator`.
  const locatorFailures = timed('locator', verifyLocator);
  // WORKSTREAM N (carry): the restore sentence, on the same criterion. A
  // dangling em dash in a pill and a suburb poll that never gives up are both
  // invisible to anything that only asks whether the player ended up in the
  // right place. See `verifyCarry`.
  const carryFailures = timed('carry', verifyCarry);
  // And the money, on the same criterion again, in two halves. The economy's
  // failures are arithmetic that renders perfectly: a drop rule that floors
  // before its minimum takes $5 off a player with $6 and nothing off one with
  // $49, a Centrelink period computed in *real* days is a payment nobody in
  // this game will ever collect, and a fare that rounds twice is a dollar
  // short a third of the time in the house's favour. The slots' failures are
  // worse in a different way: a swap that duplicates puts the bat in both
  // hands, so the off-hand throw does nothing and there is no frame in which
  // that reads as anything but a missing football. The server runs
  // `verifyCash` too -- it is the side that pays. See `game/cash.ts` and
  // `phone.ts`.
  const cashFailures = timed('cash', verifyCash);
  const phoneFailures = timed('phone', verifyPhone);
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
  // --- Workstream Q. The (dis)appearance latch is a four-state machine over a
  // bounded table, and every one of its failures is invisible in a screenshot: a
  // car hidden forever, a ghost that never retires, a car that flickers as you
  // turn your head. See `game/viewlatch.ts`.
  const viewLatchFailures = timed('view latch', verifyViewLatch);
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
  // And the cars, in the same two halves and failing in the same two silent
  // ways. The **rules** half: a handbrake that walks a stopped car backwards
  // reads as a physics quirk, and a suppression key that does not answer is the
  // car you just stole still driving to Ashfield beside you, running people down
  // on the way. The **picture** half: a prompt that survives a knockout is the
  // bikes' own reported bug one feature over, and a speed readout in the wrong
  // unit is a car that everybody reports as "feeling slow". See
  // `game/driving.ts` and `world/drivencars.ts`.
  const drivingFailures = timed('driving', verifyDriving);
  // --- WORKSTREAM S. The parked fleet's decoder, its yaw convention and the
  // residency's byte accounting. `BODY_COUNT`/`CAR_PAINT.length` are handed in
  // rather than imported by that module, on `verifyTraffic(carBodySizes())`'s
  // terms and for the identical reason: `game/staticcars.ts` compiles into the
  // Bun server and must not pull three in behind it, so the renderer's own table
  // sizes have to arrive from this side. A disagreement repaints the fleet or
  // kills a tile's draw call; see `verifyStaticCars`.
  const staticCarFailures = timed('static cars', () => verifyStaticCars(BODY_COUNT, CAR_PAINT_COUNT));
  const drivenCarFailures = timed('drivencars', verifyDrivenCars);
  // And the plume off a broken bonnet, which fails in the way every closed-form
  // effect in this renderer fails: a perfectly good frame with nothing in it.
  // A count left at zero is no smoke at all, a count left high is twelve stale
  // quads hanging over a street where a wreck used to be, and a phase that
  // stopped depending on the car is every wreck in the city puffing on the same
  // beat. See `world/carsmoke.ts`.
  const carSmokeFailures = timed('carsmoke', verifyCarSmoke);
  // --- WORKSTREAM Y: and what happens to a car after it is finished. Three-free,
  // so the server runs the identical check: the fuse, the ignition rules, the
  // blast falloff and the wire round trip. Every failure in that file renders a
  // perfectly good frame -- a fuse that never expires is a city full of burning
  // cars and no explosions at all. See `game/carfire.ts`.
  const carFireFailures = timed('carfire', verifyCarFire);
  // And the grading the four of them share -- the box fleet, the model fleet,
  // the headlights and the plume. Three-free, so the server runs it too, and it
  // is the whole of how the *visual* half of the crash damage is checked without
  // a renderer: a car that is never dented, or four systems with four opinions
  // about what dented means, are both perfectly good frames.
  const damageGradeFailures = timed('damagegrade', verifyDamageGrade);
  // And where the camera is looking from, which fails in this project's shape
  // exactly: every broken version of a zoom draws a perfectly good frame. A
  // ladder that cannot reach the far end is the reported bug -- *"cant zoom out
  // anymore by scrolling"* -- and a ladder that cannot get back to first person
  // is the same bug pointed the other way, with the player stuck behind their own
  // head. A stop between zero and the near boom puts the camera inside the
  // player's shoulders, which reads as a broken character model. And a ride floor
  // that *writes* the preference hands somebody a camera they never asked for on
  // dismount, which is the bug the boolean before it had. See `game/camera.ts`.
  const cameraFailures = timed('camera', verifyCamera);
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
  // And the graded response on top of them, in the same two halves.
  //
  // The **rules** half is where this feature's silent failures live and they all
  // render a plausible city: a threshold table out of order makes committing a
  // crime *lower* your star count, a tier that cannot be shed leaves a player
  // wanted forever with the stars simply never going down, and a crime priced
  // past the top of the ladder takes a bystander assault straight to Polair.
  // None of them throws and every one of them reads as tuning. See `verifyHeat`.
  //
  // The **model** half runs earlier, beside the assets -- `verifyHighwayPatrol`
  // by `HighwayPatrolAssets` -- and is the one that would otherwise ship a
  // patrol car with a hole in one flank.
  const heatFailures = timed('heat', verifyHeat);
  // Talents into numbers, and the four ability buttons. Run **here** as well as
  // on the server (`server/index.ts`) because every number in them is evaluated
  // on both ends and has to agree: the swing damage this process predicts and
  // that one adjudicates, the take radius both arbitrate, the crash multiplier
  // this side uses to move its own health bar on the frame you hit the wall.
  // Every failure is silent in this repo's sense -- a talent that composed wrong
  // renders a perfectly good frame and simply plays slightly differently on the
  // two machines. See `game/teamfx.ts`.
  // WORKSTREAM Z adds a third term rather than folding into `verifyTeamFx`:
  // `game/talentlive.ts` imports `teamfx.ts`, so `teamfx.ts` cannot import it
  // back. See that file's check for the argument.
  const teamFxFailures = timed('teamfx', () => [...verifyTeamFx(), ...verifyAbilities(), ...verifyTalentLive()]);
  // And the fifth rung's own geometry and schedule, which `verifyHeat` deliberately
  // does not own: it checks the *wiring* (a five-star player is shot at, a four-star
  // one is not), and this drives ten minutes of ticks over the orbit and asserts the
  // keep-out, the lock duty cycle, the shot cadence and the two-instance
  // determinism. Every failure in it renders a plausible night -- a beam that never
  // leaves the player is the old ceiling lamp, and a marksman at the ground
  // officers' 12% floor is free damage from something you cannot fight. See
  // `game/polair.verifyPolair`.
  const polairFailures = timed('polair', verifyPolair);
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
  // --- Workstream E's three, on the same criterion as everything above them:
  // every one of these ships as a tuning complaint rather than as a bug.
  //
  // `verifyCharacters` covers a bias table with a character in it who is
  // everywhere -- which from any one street corner looks exactly like a
  // character who is in the right place -- the two epochs drifting apart, which
  // puts tradies on site at midnight, and the cell-population rounding, which is
  // the one place two engines could place a different *number* of people and
  // this client would draw somebody the server does not have.
  //
  // `verifyEvents` covers a schedule that is not a pure function of the day (a
  // player describing a car crash nobody else can find), a start window that
  // wraps past midnight and is read naively (the burnout simply never happens),
  // and a trackwork queue in a paddock.
  //
  // `verifyWallet` covers the no-op default the eshays debit against until the
  // wallet lands. See `game/wallet-contract.ts`.
  //
  // The **model** halves run later beside the assets -- `verifyCharacterKit`
  // and `verifyEventKit` -- and they are the ones that would otherwise ship a
  // hard hat inside somebody's skull.
  const characterFailures = timed('characters', verifyCharacters);
  const eventFailures = timed('events', verifyEvents);
  const walletFailures = timed('wallet', verifyWallet);
  const accountFailures = timed('accounts', verifyAccounts);
  // And the nameplates, on the same criterion once more. Every way this breaks
  // renders: a text cache that misses re-uploads two megabytes of atlas twenty
  // times a second and reads as a streaming stall; a fade that is not monotonic
  // makes the far plates the bright ones; a plate for your own id is your own
  // name floating in front of your face for the whole session. See
  // `world/nameplates.ts`. `MAX_HEALTH` is handed in so the bar's pip ticks
  // cannot drift from the number of pips there actually are.
  const nameplateFailures = timed('nameplates', () => verifyNameplates(MAX_HEALTH));
  // WORKSTREAM AB: the frame profiler's own sections, checked before it is
  // believed. A profiler that under-reports is worse than none at all, because
  // the next person to look at a slow frame will believe it and optimise
  // something else -- which is the argument `verifyProfile` makes on the server
  // and the reason this is its sibling check for check.
  const frameProfileFailures = timed('frame profile', verifyFrameProfile);
  // And the prefix ranges every instanced pool in the client now uploads with.
  // A range that undershoots what was written is instances drawn from a region
  // the driver was never given -- a car collapsed to a point, which this
  // codebase has already shipped once from the other end of the same subject.
  // See `world/instupload.ts`.
  const uploadFailures = timed('instance upload', verifyInstanceUpload);
  // --- WORKSTREAM X: teams you can see.
  //
  // Two checks and they are deliberately in two files. `verifyTeamLook` is
  // three-free and runs in **both** boot lists -- it owns the numbers: the tint
  // measured against `character.COLOURWAYS`' two-tone rule, the ring's pulse,
  // the slam's radius over time and the tent's headroom. `verifyBigNightKit`
  // needs three, so it is here only, and it owns the *geometry*: the triangle
  // budgets, the winding of four hand-built solids, the cactus's bone bindings
  // and bounds, and the one thing measurement in the other file cannot prove --
  // that the tinted colours actually reach the buffer a player draws from.
  //
  // Every failure in both renders. See their headers.
  const teamLookFailures = timed('teamlook', verifyTeamLook);
  const bigNightFailures = timed('bignight', () => verifyBigNightKit());
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
  // The train lighting's own two, on the same criterion and for the same reason
  // the file above gives: a lit carriage that draws something plausible and
  // throws nothing is exactly the failure a boot check exists to catch. The kit
  // asserts the emissive window material and the real-light budget; the fleet
  // half asserts that a carriage lights by its own disposition -- night, or a
  // bore at any hour -- and that the day/night edge leaves nothing stuck on.
  //
  // Wired here rather than left exported and uncalled, which is this file's
  // standing rule: a self-check nothing runs is a self-check that rots, and
  // these two were written and then never reached because the round that wrote
  // them was interrupted.
  const trainLightFailures = timed('train-lights', () => [...verifyTrainLightKit(), ...verifyTrainLights()]);
  // And the day/night cycle, on exactly the night rig's criterion and with one
  // failure mode nothing else in this list has: **the cycle is the only thing
  // here that two players can disagree about.** It is a pure function of the
  // wall clock, deliberately, so that the sky needs no protocol field -- and if
  // that purity ever breaks, the symptom is two people in the same room looking
  // at two different skies, which neither of them can see. `verifyCycle` asserts
  // it directly, along with the halves being half an hour of real time, the
  // seams landing on the horizon, the wrap being taken in the dark, and the
  // debug scrub composing.
  //
  // `verifyDuskRig` is the same argument one file over: a twilight grade that
  // leaks into daylight lifts every horizon in the game by a few code values and
  // reads as a taste decision, and one that never switches off leaves an orange
  // stain over the western sky at two in the morning that reads as a bloom
  // artefact. `verifyClock` is the dial, where a quarter turn of rotation reads
  // as a clock running fast. See `sky/cycle.ts`, `sky/dusk.ts`, `sky/clock.ts`.
  const cycleFailures = timed('day-cycle', () => verifyCycle());
  const duskFailures = timed('dusk', () => verifyDuskRig());
  const clockFailures = timed('clock', () => verifyClock());
  // And the raves, which sit on the cycle above and inherit its one distinctive
  // failure mode with interest: **a rave is the most shared thing in the game
  // and it costs no bytes**, so every way it breaks is a thing two players
  // disagree about and neither can see. A site draw that is not a pure function
  // of the night gives everybody their own private rave, and from inside one
  // browser it looks exactly right. A beat clock that resets at dusk is a crowd
  // dancing to a bar nobody else is on. A set position that is not a modulo of
  // wall time is a player who walks in and hears the track start from the top.
  // A crowd layout that trusts the site's inscribed circle puts forty people
  // inside the shipping container standing in the middle of the yard.
  //
  // It also checks the thing no constant could: `verifyRaves` asks
  // `skyClock` how dark it actually is in the middle of a modelled night and in
  // the middle of the morning after, which is the only test that can catch the
  // quarter-turn rotation between the two clocks being applied the wrong way.
  // See `game/rave.ts` sections 1 and 6.
  //
  // The **kit** half runs later, beside the assets -- see `verifyRaveKit` by
  // `RaveAssets` -- and is the one that would otherwise ship a laser fan that is
  // invisible from half the angles it is seen from.
  const raveFailures = timed('raves', () => verifyRaves());
  // And the button in Sydney Park, in the same two halves the bikes have and
  // failing in the same two silent ways. The **rules** half runs on the server
  // too (`server/index.ts`) and is the one that matters: a scream that ends at
  // the wrong boundary or a cooldown that comes back on the wrong day is a
  // feature nobody can test without sitting through three real hours, and it
  // renders perfectly the whole time. The **renderer** half is the sizing and
  // the two-state legibility, on `verifyDoorMarker`'s criterion -- a face
  // clipped past the far plane is simply invisible with nothing in the console,
  // and a cooldown that looks like readiness is a player pressing a dead button
  // and concluding the key is broken. See `game/sunbutton.ts`.
  const sunButtonFailures = timed('sun button', () => [
    ...verifySunButton(),
    ...verifySunButtonRenderer(),
  ]);
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
    handsFailures.length ||
    combatFailures.length ||
    powerupFailures.length ||
    footyFailures.length ||
    swatFailures.length ||
    swatPuffFailures.length ||
    footyBallFailures.length ||
    netFailures.length ||
    clientFailures.length ||
    rateFailures.length ||
    nameFailures.length ||
    locatorFailures.length ||
    carryFailures.length ||
    trafficFailures.length ||
    viewLatchFailures.length ||
    wadingFailures.length ||
    waterFailures.length ||
    cdnFailures.length ||
    spawnFailures.length ||
    bikeFailures.length ||
    drivingFailures.length ||
    staticCarFailures.length ||
    drivenCarFailures.length ||
    carSmokeFailures.length ||
    carFireFailures.length ||
    damageGradeFailures.length ||
    cameraFailures.length ||
    bikeMeshFailures.length ||
    bikeGlowFailures.length ||
    pedFailures.length ||
    pedModelFailures.length ||
    policeFailures.length ||
    heatFailures.length ||
    teamFxFailures.length ||
    polairFailures.length ||
    streetFailures.length ||
    wildlifeFailures.length ||
    characterFailures.length ||
    eventFailures.length ||
    walletFailures.length ||
    accountFailures.length ||
    nameplateFailures.length ||
    frameProfileFailures.length ||
    uploadFailures.length ||
    teamLookFailures.length ||
    bigNightFailures.length ||
    guardFailures.length ||
    hudFailures.length ||
    wallFailures.length ||
    lifecycleFailures.length ||
    nightFailures.length ||
    trainLightFailures.length ||
    raveFailures.length ||
    sunButtonFailures.length ||
    cycleFailures.length ||
    duskFailures.length ||
    clockFailures.length ||
    chatFailures.length ||
    chatBoxFailures.length ||
    unstuckFailures.length ||
    teleportFailures.length ||
    suggestionFailures.length ||
    teamFailures.length ||
    teamFieldFailures.length ||
    teamWireFailures.length ||
    talentPanelFailures.length ||
    buildSheetFailures.length ||
    changelogFailures.length ||
    bugFailures.length ||
    cashFailures.length ||
    phoneFailures.length
  ) {
    hud.fatal(
      'Self-checks failed:\n' +
        [
          ...sunFailures,
          ...moveFailures,
          ...animFailures,
          ...rigFailures,
          ...batFailures,
          ...handsFailures,
          ...combatFailures,
          ...powerupFailures,
          ...footyFailures,
          ...swatFailures,
          ...swatPuffFailures,
          ...footyBallFailures,
          ...netFailures,
          ...clientFailures,
          ...rateFailures,
          ...nameFailures,
          ...locatorFailures,
          ...carryFailures,
          ...trafficFailures,
          ...viewLatchFailures,
          ...wadingFailures,
          ...waterFailures,
          ...cdnFailures,
          ...spawnFailures,
          ...bikeFailures,
          ...drivingFailures,
          ...staticCarFailures,
          ...drivenCarFailures,
          ...carSmokeFailures,
          ...carFireFailures,
          ...damageGradeFailures,
          ...cameraFailures,
          ...bikeMeshFailures,
          ...bikeGlowFailures,
          ...pedFailures,
          ...pedModelFailures,
          ...policeFailures,
          ...heatFailures,
          ...polairFailures,
          ...streetFailures,
          ...wildlifeFailures,
          ...characterFailures,
          ...eventFailures,
          ...walletFailures,
          ...accountFailures,
          ...nameplateFailures,
          ...frameProfileFailures,
          ...uploadFailures,
          ...teamLookFailures,
          ...bigNightFailures,
          ...guardFailures,
          ...hudFailures,
          ...wallFailures,
          ...lifecycleFailures,
          ...nightFailures,
          ...trainLightFailures,
          ...raveFailures,
          ...sunButtonFailures,
          ...cycleFailures,
          ...duskFailures,
          ...clockFailures,
          ...chatFailures,
          ...chatBoxFailures,
          ...unstuckFailures,
          ...teleportFailures,
          ...suggestionFailures,
          ...teamFailures,
          ...teamFieldFailures,
          ...teamWireFailures,
          ...talentPanelFailures,
          ...buildSheetFailures,
          ...cashFailures,
          ...phoneFailures,
          ...changelogFailures,
          ...bugFailures,
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
    // The spawn pin, so a segmented world arrives with the hexes the player is
    // about to stand in already loaded. `SPAWN_TARGET` is a constant rather than
    // a search -- it is the dropped pin, projected -- which is what lets it be
    // known before the index it would otherwise be looked up in. On an
    // unsegmented world this argument is ignored. See `world/hexes.ts`.
    index = await streamer.loadIndex(SPAWN_TARGET);
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
  // --- F: the contact puff where a bat middles a football. Twelve triangles,
  // three of them, one material -- see `world/swatpuff.ts`. Built here with the
  // other weapon assets so the warm-up compiles its pipeline rather than the
  // frame somebody first returns a serve.
  const swatPuffs = new SwatPuffs();
  for (const mesh of swatPuffs.meshes) scene.add(mesh);
  /** Scratch for the offline swat's ball rewind. See `game/swat.ts`. */
  const swatScratch = createBallAt();
  /**
   * A throw the console asked for, and how many simulated seconds until it goes.
   *
   * The one piece of state `sydney.serve()` needs and the only reason it is not
   * a pure function of its arguments -- see there for why the countdown is in
   * simulated seconds rather than on a `setTimeout`. Null in every session
   * nobody has typed `sydney.serve()` into, which is all of them.
   */
  let pendingServe: { combat: CombatantState; t: number } | null = null;
  /** How many swats this session has seen, and the last one. `sydney.bat.swats`. */
  let swatCount = 0;
  let lastSwat: { mine: boolean; x: number; y: number; z: number; at: number } | null = null;
  /**
   * The lime e-bikes, on exactly the same terms as the three above: one geometry
   * and one material for every bike in the city, built here so the warm-up gets
   * it rather than the frame somebody first rounds a corner and finds one.
   *
   * It appears in three places, all instanced and all the same pipeline: the
   * parked set, the one under the local rider, and one per riding remote.
   */
  const bikes = new BikeAssets();

  // --- And the five asset sets that used to be built *below* the warm-up, which
  // is the whole of why the police kit, the meth heads, the wildlife, the
  // nameplates and the tracers each compiled a pipeline on the frame they were
  // first looked at.
  //
  // Every one of them is pure geometry on the terms the four above are: no
  // network, no index, nothing that has to happen after the far layer. They were
  // constructed four hundred lines further down purely because that is where
  // their *renderers* are wired up, and the cost of that was invisible -- the
  // first officer, the first loiterer, the first bush turkey, the first remote
  // player's plate and the first shot fired were each a synchronous compile in
  // the middle of play. The squads, the crowd and the flock are still built
  // where they were; only the shared geometry and materials moved.
  //
  // The kit self-checks come with them, because a fatal check belongs beside the
  // thing it checks rather than beside the thing that happens to use it.
  const policeAssets = new PoliceAssets(characters);
  const policeKitFailures = verifyPoliceKit(policeAssets);
  if (policeKitFailures.length) {
    hud.fatal('Police kit self-checks failed:\n' + policeKitFailures.map((f) => '  - ' + f).join('\n'));
    return;
  }
  const tracers = new Tracers();
  // --- The heat ladder's furniture, on exactly the same terms: pure geometry,
  // built up here so the first patrol car of a session is not a synchronous
  // shader compile in the middle of a pursuit -- which is the one moment in a
  // session where a 200 ms hitch is unambiguously the game's fault.
  const patrolAssets = new HighwayPatrolAssets();
  const patrolKitFailures = verifyHighwayPatrol(patrolAssets);
  if (patrolKitFailures.length) {
    hud.fatal('Highway patrol kit self-checks failed:\n' + patrolKitFailures.map((f) => '  - ' + f).join('\n'));
    return;
  }
  const streetAssets = new StreetlifeAssets(characters);
  const streetKitFailures = verifyStreetlifeKit(streetAssets);
  if (streetKitFailures.length) {
    hud.fatal('Street kit self-checks failed:\n' + streetKitFailures.map((f) => '  - ' + f).join('\n'));
    return;
  }
  // --- Workstream E's two kits, on exactly the same terms: a fatal check beside
  // the thing it checks, because a hard hat inside a skull is invisible from
  // every angle and looks like the prop was never parented.
  const characterAssets = new CharacterKitAssets(characters);
  const characterKitFailures = verifyCharacterKit(characterAssets);
  if (characterKitFailures.length) {
    hud.fatal('Character kit self-checks failed:\n' + characterKitFailures.map((f) => '  - ' + f).join('\n'));
    return;
  }
  const eventAssets = new EventAssets();
  const eventKitFailures = verifyEventKit(eventAssets);
  if (eventKitFailures.length) {
    hud.fatal('Event kit self-checks failed:\n' + eventKitFailures.map((f) => '  - ' + f).join('\n'));
    return;
  }
  const wildlifeAssets = new WildlifeAssets();
  const wildlifeKitFailures = verifyWildlifeKit(wildlifeAssets);
  if (wildlifeKitFailures.length) {
    hud.fatal('Wildlife kit self-checks failed:\n' + wildlifeKitFailures.map((f) => '  - ' + f).join('\n'));
    return;
  }
  // The rave rig, up here with the other kits and for the same reason every one
  // of them moved up here: it has to exist *before* the warm-up runs or its
  // banner compiles a pipeline on the frame a player first walks within sight of
  // a rave, which is the frame it is least affordable. Everything else it draws
  // is instanced and can only be warmed by the scene pass at the bottom of this
  // function -- see `world/rave.ts` section 2.
  const raveAssets = new RaveAssets();
  const raveKitFailures = verifyRaveKit(raveAssets);
  if (raveKitFailures.length) {
    hud.fatal('Rave kit self-checks failed:\n' + raveKitFailures.map((f) => '  - ' + f).join('\n'));
    return;
  }
  /**
   * The railway's kit, and the bake it is derived from, both **above** the
   * warm-up and for two different reasons.
   *
   * The materials are here on exactly the argument every kit above is here on:
   * ten shared materials that a stand-in *can* warm, and a chunk of railway
   * arriving three minutes into a session must not compile one. The 1 MB bake is
   * here because the sign atlas is built from the station names and the sign
   * material's texture has to be on it before the pipeline is keyed -- assigning
   * a map to a material the warm-up has already compiled is a compile on the
   * frame the first station comes into view, which is the whole thing being
   * avoided.
   *
   * Bounded and optional on the far layer's terms. No bake is a city with no
   * railway drawn in it, which is the city that shipped last week.
   */
  const railAssets = new RailAssets();
  /** Station platforms as rectangles, for `groundHeightAt`. Null with no bake. */
  let platforms: PlatformField | null = null;
  /**
   * The underground stations, as the volumes a body may legitimately be inside.
   *
   * Beside `platforms` and asked in the same breath, because the two answer
   * halves of one question: `platforms` is "am I standing on the deck" and this
   * is "am I in the station at all". Without it the concourse is not a place --
   * see `game/riding.StationBoxField` for the whole of the report it fixes.
   */
  let stationBoxes: StationBoxField | null = null;
  /**
   * The volume nothing may stand in: the railway's loading gauge and every
   * carriageway's headroom, in one object.
   *
   * Declared here because it is filled from two places at two times -- the rail
   * corridors from the bake a few lines down, the roads from each tile's lane
   * sidecar as the streamer lands it -- and consumed by a third, `collision`,
   * which does not exist yet. See `world/envelope.ts`, and
   * `CollisionWorld.setEnvelope` for why arriving late is safe.
   */
  const envelope = new ClearanceEnvelope();
  /**
   * Every carriageway in the city, filling in as the tiles land.
   *
   * The other half of `envelope`, and not the same object: `ClearanceEnvelope`
   * says where a *solid* must not be, and this says where the *ground* must
   * stay. The railway needs both -- a building over a corridor gets an
   * undercroft, and a road over a corridor keeps its ground -- and they are
   * separate because they are consumed by different things at different times.
   *
   * Handed to the streamer immediately, before any tile can be built, and to
   * `RailCut` the moment there is one. Both are safe to fill late; nothing
   * caches a road decision. See `world/road-deck.ts`.
   */
  const roadDeck = new RoadDeck();
  /**
   * The chunk ring, once there is one, for the road sink below to invalidate.
   *
   * A forward `let` rather than a reference to `railWorld`, which is a `const`
   * two thousand lines down: tiles stream during boot, so this closure really
   * can run before that binding is initialised, and a `const` in its temporal
   * dead zone throws rather than reading `undefined`. Null until then, which
   * means "no chunks to invalidate yet", which is true.
   */
  let railChunks: RailWorld | null = null;
  /**
   * Where the deck is filled from, and the one thing that has to happen beside
   * filling it.
   *
   * `streamer.recutGround` already rebuilds a neighbouring tile's ground when a
   * street arrives after it. The rail chunk ring needs the same treatment for
   * the same reason and cannot get it from inside the streamer, which has no
   * `RailWorld`: a chunk decides once where its boundary fence and its retaining
   * walls go, and a chunk built before the street landed keeps a palisade
   * standing in the carriageway. That is the exact frame the player photographed.
   *
   * Gated on the road actually being near a corridor, because a chunk rebuild is
   * the same work as a first build and the city has three thousand tiles of
   * street against a few dozen that cross a railway. See `RoadDeck.anyStrip`.
   */
  streamer.setRoadSink({
    adopt: (key, ways, margin) => {
      const box = roadDeck.adopt(key, ways, margin);
      const chunks = railChunks;
      if (box === null || railCut === null || chunks === null) return box;
      const cut = railCut;
      if (roadDeck.anyStrip(key, (x, z, half) => cut.near(x, z, half))) chunks.invalidate(box);
      return box;
    },
    drop: (key) => roadDeck.drop(key),
  });
  {
    const deckFailures = verifyRoadDeck();
    if (deckFailures.length) {
      console.warn('[rail] road deck self-check:\n  - ' + deckFailures.join('\n  - '));
    }
  }
  const railBake = await withDeadline(loadRailBake(), RAIL_BAKE_DEADLINE_MS, 'the rail bake');
  let railNetwork: RailNetwork | null = null;
  /** The rail corridor, for the terrain carve and the trench. See below. */
  let railCut: RailCut | null = null;
  /**
   * The railway as closed solids, and the ground query over them. Phase 2a.
   *
   * Null unless `?vessels=1`. Rebuilt as terrain arrives, because the sweep
   * needs the DEM at the rim on both sides and a browser gets that a tile at a
   * time -- see `refreshVessels`. `server/world.ts` builds the identical thing
   * from the identical module in one go, because every grid is resident there.
   */
  let vesselField: VesselField | null = null;
  {
    // The riding module's own self-check, at boot, on `verifyRail`'s terms: a
    // self-check nothing runs is a self-check that rots, and the browser is not
    // in CI. It is also the only place the two constants `game/riding.ts` had to
    // restate -- the eye height and the body radius -- are compared against the
    // controller's real ones, because that file may not import the controller.
    const rideFailures = verifyRiding(EYE_HEIGHT, PLAYER_RADIUS);
    if (rideFailures.length) {
      console.warn('[rail] riding self-check:\n  - ' + rideFailures.join('\n  - '));
    }
    // And the boarding marker, whose whole job is that its two states look
    // different from each other. See `world/doormarker.verifyDoorMarker`.
    const markerFailures = verifyDoorMarker();
    if (markerFailures.length) {
      console.warn('[rail] door marker self-check:\n  - ' + markerFailures.join('\n  - '));
    }
  }
  if (railBake) {
    const bakeFailures = verifyRail(railBake);
    if (bakeFailures.length) {
      console.warn(
        '[rail] the bake failed its own self-check and is not drawn:\n  - ' +
          bakeFailures.join('\n  - '),
      );
    } else {
      // And the announcements, which are a second reading of the same
      // `dir.arrivals` the doors are driven from. `verifyRailAudio` proves the
      // two readings agree -- that every clip is anchored to a real dwell phase
      // and that no two of one kind overlap -- on `verifyRail`'s terms: the
      // browser is not in CI, and a self-check nothing runs is one that rots.
      const announceFailures = verifyRailAudio(railBake);
      if (announceFailures.length) {
        console.warn(
          '[rail] the announcement schedule failed its own self-check:\n  - ' +
            announceFailures.join('\n  - '),
        );
      }
      railNetwork = buildNetwork(railBake);
      // **The hole in the ground, before anything is drawn in it.**
      //
      // The DEM carries one post every 31 m and a rail cutting is fifteen metres
      // wide, so the heightfield cannot represent one and the terrain sheet was
      // drawn straight over the top of the railway -- 11.8% of every track sample
      // in the city, the worst by 13.5 m. `world/rail-cut.ts` is the corridor
      // that both halves of the fix read: the streamer stops drawing ground
      // inside it, and `RailWorld` builds the trench that stands in the hole.
      //
      // The platform sites are handed over separately because `bake.stations[].x,
      // z` is the OSM node, which at Meadowbank is 471 m from where a train
      // stops, and the corridor has to open out where the platforms actually are
      // or half of every cutting station is buried in its own retaining wall.
      //
      // **`riding.buildPlatforms` and not `railNetwork.stations`, which is a fix
      // shipping today.** `server/world.ts` says of its own `setStations` that
      // `buildPlatforms` resolves *"the same anchors from the same bake, which is
      // what makes the two answers the same number rather than two numbers that
      // agree today"*. They were not the same list. `buildNetwork.stations` adds
      // a fallback for stations *nothing calls at* -- a rail within 60 m of a
      // platform the modelled network never reaches -- so this end had 361 sites
      // against the server's 358, and sampled every 6 m along every platform in
      // the city **87 of 29,479 points got a different half-width, by up to the
      // full 4.00 m of the flare**. A carve on one end and a ground query on the
      // other, disagreeing about where the ground is by four metres.
      //
      // Phase 2a found this and fixed it for the vessel path only, in
      // `world/corridor.ts`, because the flag being off had to change nothing.
      // The flag is still off and this is the old path, so it is fixed here too:
      // one rule in three places instead of two. The three uncalled stations
      // stop flaring on the client, which is what the server has always done and
      // therefore what the ground under a player's feet has always said.
      //
      // The analytic platforms, built here rather than sixty lines down because
      // this is the first line that needs them. See `game/riding.PlatformField`:
      // built from the bake rather than from the network for the reason the
      // server needs them at all -- this is the copy that exists on both ends.
      platforms = buildPlatforms(railBake);
      railCut = new RailCut(railBake);
      railCut.setStations(platforms.sites);
      // **And the roads, which is where the carve stops.** The corridor is the
      // reason the ground comes away and a carriageway is the reason it stays;
      // one object answers both, so the terrain mesh, the trench, the ground
      // query in `groundHeightAt` and `server/world.groundFor` cannot hold four
      // opinions about it. `server/world.ts` does the identical two lines over a
      // deck built from the identical `.lanes.bin` bytes.
      //
      // **And the foot paving, which is the third report from King Street.**
      // `.lanes.bin` carries no footway -- `lanes.py` excludes the whole class --
      // so the deck could not know about the plaza, the bridge cycleway or the
      // crossings the player kept falling through. That footprint rides in the
      // rail bake and goes into the *same* deck, before the first terrain tile
      // can be carved and before the first rail chunk can decide where its fence
      // goes, so neither of the timing repairs below has anything to repair.
      // `server/world.ts` does the identical call over the identical bytes.
      roadDeck.adoptPaving(railBake.paving);
      railCut.setRoads(roadDeck);
      // **And which lattice the ground is drawn on.** `buildTerrainMesh` decides
      // cut-or-keep per sub-quad from that sub-quad's centre, and until this line
      // the ground query decided per point -- so a sub-quad drawn whole could have
      // two metres of it already taken away underneath. `server/world.ts` makes the
      // identical call from the identical two index fields. See
      // `RailCut.groundCutAt`. A world with no terrain block draws no terrain
      // mesh, so there is no lattice to agree with and `groundCutAt` stays
      // `cutAt`.
      railCut.setCarveLattice(
        index.terrain ? index.tile_size / index.terrain.grid : 0,
        CUT_SUBDIVISION,
      );
      streamer.setRailCut(railCut);
      // **And the volume nothing may stand in.** The same corridor read the
      // other way round: `RailCut` says where the *ground* must not be, and
      // `ClearanceEnvelope` says where a *solid* must not be. A building over
      // the railway is not deleted -- it is given the undercroft it has in real
      // life, which is `CollisionWorld.setEnvelope`'s whole job. The roads are
      // added to the same envelope as their lane sidecars land; see
      // `adoptRoadCorridors`.
      envelope.addRail(railBake, SPAN_TUNNEL);
      // **And the same envelope decides what is *drawn*, not only what is
      // solid.** The carve has cut a tunnel through 792 buildings since last
      // round and every one of them still drew a wall across it, which is the
      // report *"i still pass through solid buildings on the train"*. Handed to
      // the streamer here, one line after the corridors exist and long before
      // the first tile is built, so no tile is ever built without it. See
      // `world/undercroft.ts`.
      streamer.setUndercroftEnvelope(envelope);
      const envFailures = verifyEnvelope();
      if (envFailures.length) {
        console.warn('[rail] clearance envelope self-check:\n  - ' + envFailures.join('\n  - '));
      }
      // The same case seen from the other side: the envelope's check proves the
      // *collision* comes out as a tunnel, and this one proves the picture does.
      const drawnFailures = verifyUndercroft();
      if (drawnFailures.length) {
        console.warn('[rail] drawn undercroft self-check:\n  - ' + drawnFailures.join('\n  - '));
      }
      // And the primitive that will eventually replace all three of the above.
      // It builds nothing here and draws nothing: it asserts that a closed
      // vessel comes out closed, that the four dispositions are four profiles
      // through one code path, that a corridor turning tighter than it is wide
      // is refused rather than folded, and -- the half that matters -- that
      // `checkManifold` still screams at a punched hole, a flipped face, an
      // unwelded vertex and a collapsed triangle. See `world/vessel.ts`.
      const vesselFailures = verifyVessels();
      if (vesselFailures.length) {
        console.warn('[rail] vessel self-check:\n  - ' + vesselFailures.join('\n  - '));
      }
      // ...and the terrain's half of the seam, which is the other end of the
      // wire and where an epsilon would have crept back in. Asserted by area:
      // the ground the cells keep plus the ground the rim encloses must add up
      // to the ground there was, including where two corridors overlap -- which
      // at Erskineville is 61.5% of the cells the railway claims. See
      // `world/seam.ts`.
      const seamFailures = verifySeam();
      if (seamFailures.length) {
        console.warn('[rail] terrain seam self-check:\n  - ' + seamFailures.join('\n  - '));
      }
      // **`?vessels=1`, but only if the server is running them too.**
      //
      // The two ends have separate switches -- this query parameter and the
      // server's `SYDNEY_VESSELS` -- and a flag that can be half on is not a
      // flag, it is a trap. Half on, the browser draws the vessel corridor and
      // answers its own ground from the sweep while the server keeps answering
      // `groundFor` from the old path; the server wins every correction, and the
      // player falls through roads that are demonstrably solid in the bake. That
      // is not a hypothetical: a link handed out with `?vessels=1` outlived the
      // `SYDNEY_VESSELS` drop-in it came with, and the next report was that the
      // road fix had regressed. It had not. The link had.
      //
      // `/health` is same-origin in production, where this matters. A dev server
      // on another port answers nothing, and there the flag is honoured with a
      // warning -- somebody running two processes by hand is choosing this.
      if (new URLSearchParams(location.search).get('vessels') === '1') {
        let serverHas: boolean | null = null;
        try {
          const res = await fetch('/health', { cache: 'no-store' });
          if (res.ok) serverHas = ((await res.json()) as { vessels?: boolean }).vessels === true;
        } catch {
          serverHas = null;
        }
        if (serverHas === false) {
          console.warn(
            '[vessels] ?vessels=1 ignored: this server answers the ground from the shipping path, ' +
              'and half a flag makes a player fall through solid roads. Drop the parameter, or ' +
              'set SYDNEY_VESSELS=1 on the server.',
          );
        } else {
          if (serverHas === null) console.warn('[vessels] no /health to ask; honouring ?vessels=1 unchecked');
          setVesselsEnabled(true);
        }
      }
      const geometryFailures = verifyRailGeometry(railNetwork);
      if (geometryFailures.length) {
        console.warn('[rail] derived network self-check:\n  - ' + geometryFailures.join('\n  - '));
      }
      railAssets.prepareSigns(railNetwork.stations.map((s) => s.name));
      // ...and the volume a body may be *inside*. Third question, third field,
      // and the one that was missing: `PlatformField` answers within a step of
      // a 5.5 m deck and `RailCut.cutAt` declines on a bore by design, so one
      // pace off the platform at Town Hall the ground query fell through to the
      // DEM twenty metres overhead and put the player's feet on it. That is
      // *"moving anywhere on foot underground tps me to surface"*, and it is a
      // ground answer rather than a teleport. See `game/riding.StationBoxField`.
      stationBoxes = buildStationBoxes(railBake);
      console.debug(
        `[rail] ${railNetwork.segments.length} unique segments from ` +
          `${railNetwork.directedSegments} directed (${(
            100 - (railNetwork.segments.length / railNetwork.directedSegments) * 100
          ).toFixed(0)}% shared), ${railNetwork.portals.length} tunnel portals, ` +
          `${railNetwork.stations.length} stations on the network, ` +
          `${railNetwork.chunks.size} chunks`,
      );
    }
  }
  /**
   * The trains, constructed here and **loaded below**.
   *
   * The object exists this early only so its box-train material and its one
   * `InstancedMesh` are in the scene before either warm-up pass; the 10.5 MB of
   * hero models are fetched two hundred lines down beside the car models, which
   * is where an asset of that size belongs.
   */
  const trains = new TrainFleet();
  scene.add(trains.group);
  /**
   * And where to stand to get on one. See `world/doormarker.ts`, which is the
   * other half of the answer to "its not obvious where i board" -- the first
   * half is the street-level station board in `world/rail-geo.ts`.
   *
   * Driven from `simulate`, beside the pill, off the same `findBoarding` /
   * `nearestDwell` pair the key and the server ask: the marker and the prompt
   * are one answer shown twice, and neither can promise something `E` will not
   * deliver.
   */
  const doorMarker = new DoorMarker();
  scene.add(doorMarker.group);
  /**
   * The button on the hill in Sydney Park, and the face it puts in the sky.
   *
   * One object holding a prop 231 m from the spawn disc and a billboard 14 km up
   * `sunVector`; see `world/sunbutton.ts` for why those two live together and
   * `game/sunbutton.ts` for the rules the server shares.
   *
   * Constructed here rather than lazily, on `MoonDisc`'s reason: a material that
   * first appears the moment somebody presses the button is a pipeline compiled
   * in the middle of an afternoon, and this one is added to the scene before the
   * boot warm-up so `compileAsync` reaches it.
   *
   * `wildGround` rather than `groundHeightAt` for the plinth's feet, on that
   * function's own argument: the plinth is standing on the park and a query that
   * folded in a roof would put it on top of whatever the streamer thinks is
   * overhead -- and, worse, `groundHeightAt` *writes* the player's `lastGround`,
   * so asking it about a point 3 km away would move the player's own fallback
   * height to a mound they have never been on.
   */
  const sunButton = new SunFeature({
    groundAt: (x, z) => wildGround(x, z),
    // The **server's** clock, which is the client's own plus the skew `WELCOME`
    // established. `sky.now.nowMs` is that number and is the one the sky itself
    // is drawn from, so the face's deadline and the sunset it is measured
    // against can never be a frame apart. Offline the skew is zero, which is not
    // a fallback so much as the honest answer -- see `SydneySky.serverSkew`.
    clockMs: () => sky.now.nowMs,
    notice: (text) => hud.notice(text),
  });
  scene.add(sunButton);
  /**
   * The record bag, fetched once and never blocking anything.
   *
   * `client/public/audio/dj/tracks.json` is written by `scripts/dj-manifest.sh`
   * and is the whole of what a browser can know about that folder, because a
   * browser cannot list a directory. It is **28 MB of audio described by 300
   * bytes of JSON**, and the 300 bytes are all that is fetched here: the records
   * themselves are streamed by `game/audio.ts` only once a player is close
   * enough to a live rave to hear one, so somebody who plays for an hour and
   * never finds a rave downloads nothing.
   *
   * Fire-and-forget on `loadClip`'s own terms: a missing or malformed manifest is
   * a game whose raves run on the synthesised set, which is a complete feature.
   * A promise anything had to await would put a network round trip in front of
   * the first frame for a file that is optional by design.
   */
  let bag: RecordBag = EMPTY_BAG;
  void fetch('audio/dj/tracks.json')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((rows: unknown) => {
      if (!Array.isArray(rows)) return;
      bag = recordBag(rows);
      console.debug(
        `[rave] record bag: ${bag.tracks.length} track(s)` +
          (bag.totalSeconds > 0 ? `, ${(bag.totalSeconds / 60).toFixed(1)} min set` : ', no durations (slot fallback)'),
      );
    })
    .catch(() => {
      // Left empty, which is a working rave with a synthesised set on it.
    });
  /**
   * The plate field, built here and added to the scene where it always was.
   *
   * Its geometry is empty until somebody else is in the game, and an empty
   * geometry still has the attribute *layout* the pipeline is keyed on -- which
   * is the whole reason this can be warmed at all. See `world/nameplates.ts`.
   */
  const nameplates = new NameplateField();
  // WORKSTREAM X: the team look's shared geometry, built here for the same
  // reason the plate field is -- so the warm-up below can reach it. The horns
  // and the tent are the character material against a **non-skinned** attribute
  // layout, which nothing else in this client produces, and the ring is a new
  // material outright; without warming them, the first Marita to walk round a
  // corner and the first mega to fire each compile a pipeline on the frame they
  // land. The rest of the wiring is two thousand lines down, beside the local
  // player's own body, where the actors it dresses exist.
  const bigNight = new BigNightKit(characters);
  const teamRings = new TeamRingField();

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
  /**
   * Everything the warm-up compiles, kept rather than passed inline.
   *
   * `auditWarmup` takes the same list a few seconds into play and names anything
   * in the scene that is not in it -- which is the only thing that can catch the
   * recurring shape of this bug, a renderer shipped without an entry here. See
   * `world/warmup.ts`.
   */
  const warmupExtras = warmupActors.map((a) => a.mesh);
  const warmupParts: WarmupPart[] = [
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
        // --- F: the swat's contact puff, which is the loudest possible case of
        // what this pass exists for. It is additive, unlit, `DoubleSide` and
        // `toneMapped` off -- a pipeline nothing else in the frame shares -- and
        // its three meshes are `visible = false` until somebody returns a serve,
        // so `_projectObject` skips them and the compile lands on the exact
        // frame the effect is supposed to make instant. Neither casts nor
        // receives: see `world/swatpuff.ts`, where both are switched off.
        {
          geometry: swatPuffs.meshes[0].geometry,
          material: swatPuffs.meshes[0].material as Material,
          casts: false,
          receives: [false],
        },
        // The police kit's two props and the tracers, the street factions' four
        // props, the flock's five sets and the nameplate field. Every one of
        // these used to be built *below* this call and so could not be reached
        // by it at all; each was a compile on the frame it first appeared --
        // the first officer, the first meth head, the first bush turkey, the
        // first shot fired, the first other player's plate.
        ...policeWarmupParts(policeAssets, tracers),
        // And the heat ladder's: the patrol body, its light bar, one lens, the
        // RBT's cone line and the Polair disc. Five pipelines that would
        // otherwise each compile on the frame a 3-star pursuit arrived.
        ...highwayPatrolWarmupParts(patrolAssets),
        ...streetlifeWarmupParts(streetAssets),
        // Workstream E's props and its five instanced objects, compiled at boot
        // rather than on the frame somebody first turns a corner into a bin
        // night. WebGPU pipeline compilation is tens of milliseconds and it
        // lands as a stall on exactly the frame the thing appears.
        ...characterWarmupParts(characterAssets),
        ...eventWarmupParts(eventAssets),
        ...nameplateWarmupParts(nameplates),
        // WORKSTREAM X: the tinted body, the cactus, the horns, the tent and
        // the ground rings. See `teamLookWarmupParts`.
        ...teamLookWarmupParts(bigNight, characters, teamRings),
        // The rave's booth banner, which is the one thing in that whole feature
        // a stand-in can warm: everything else it draws is instanced, and
        // `world/rave.ts` section 2 sets out why that means twelve pipelines
        // that only the scene pass below can reach.
        ...raveWarmupParts(raveAssets),
        // The railway's ten shared materials -- ballast, rail steel, concrete,
        // canopy, tunnel lining, the far corridor, the overhead wire and the
        // station-name atlas. Every one of them is a plain `Mesh` over a shared
        // material, which is exactly the case a stand-in can warm, and without
        // this the first chunk of railway to come inside a kilometre compiles
        // eight pipelines on one frame. The sleepers and the masts are *not*
        // here and cannot be: they are instanced, and `world/warmup.ts` sets out
        // why no stand-in warms one. The scene pass below reaches those.
        ...railWarmupParts(railAssets),
        // And **nothing instanced**, which is the change this list most needs
        // explaining. The bikes, the crowd, the traffic, the flock and the
        // headlights were all warmed here and none of them was ever warmed at
        // all: three keys an instanced draw on `object.uuid`, so a stand-in
        // compiles a pipeline with a different uuid and the real mesh compiles
        // its own on the frame it is first drawn. `world/warmup.ts` sets that
        // out; the scene pass below is what covers them now.
  ];
  const warmup = await withDeadline(
    warmUpPipelines(
      renderer,
      scene,
      camera,
      warmupParts,
      // The characters, handed over whole because a skinned mesh cannot be
      // reduced to a geometry and a material: `RenderObject.getCacheKey` folds
      // the skeleton's bone count in, and the vertex path is the skinning one.
      warmupExtras,
    ),
    SHADER_WARMUP_DEADLINE_MS,
    'the shader warm-up',
  );
  if (warmup) {
    console.debug(
      `[warmup] ${warmup.draws} draws (${warmup.duplicates} duplicates dropped) in ${warmup.ms.toFixed(0)} ms  ` +
        `shaders ${warmup.programsBefore} -> ${warmup.programsAfter}, ` +
        `pipelines ${warmup.pipelinesBefore} -> ${warmup.pipelinesAfter}`,
    );
  }
  dev.warmup = warmup;
  dev.boot = 'far layer';

  /**
   * The coverage check, and it is aimed at the *next* feature rather than at
   * this one.
   *
   * Every omission this session closed -- the police kit, the meth heads, the
   * flock, the plates, the tracers, and then every instanced set in the world --
   * was the same mistake made independently: somebody added a renderer and
   * nobody added the matching warm-up, and the defect is invisible until a
   * player turns around fast. It cannot be caught by reading either file,
   * because the fault is that the two files do not mention each other.
   *
   * So the check is not a list of things to remember. It is the symptom itself:
   * `PipelineWatch` counts the frames in which the renderer's pipeline cache
   * grew **across the render call**, which is exactly and only a frame that
   * stalled on a shader compile -- see `world/warmup.ts`. Zero is the invariant;
   * anything else names how many frames and how bad the worst one was, and
   * `coldMaterials` is the place to start looking.
   *
   * Twenty seconds because that is comfortably past the streamer filling its
   * ring at the spawn and past everything ambient having posed at least once.
   * Reported rather than thrown, on the boot path's usual terms: a warm-up
   * problem is a stutter, and a false positive that stopped the boot would be
   * worse than the thing it is guarding. `sydney.warmupAudit()` runs it on
   * demand, which is what to type after adding a renderer.
   */
  const pipelineWatch = new PipelineWatch();
  const auditNow = (): ReturnType<typeof auditWarmup> =>
    auditWarmup(renderer, scene, warmupParts, warmupExtras, warmup?.pipelinesAfter ?? -1, pipelineWatch);
  setTimeout(() => {
    const audit = auditNow();
    if (audit.failures.length) {
      console.warn(
        '[warmup] frames stalled on shader compilation:\n  - ' +
          audit.failures.join('\n  - ') +
          '\n  materials with no boot-time stand-in: ' +
          (audit.coldMaterials.join(', ') || 'none'),
      );
    }
  }, 20000);

  // --- And the half of the warm-up that a boot pass can never do.
  //
  // Everything above compiles a *shared* pipeline: one per material, geometry
  // layout and shadow role, keyed on things that do not vary per object. That
  // covers every non-instanced surface in the world and it is why the first
  // terrace and the first roof no longer hitch.
  //
  // It cannot cover an `InstancedMesh`, and the reason is in three rather than
  // in this project. `RenderObject.getMaterialCacheKey` appends `object.uuid`
  // for anything instanced -- unconditionally, with a TODO pointing at
  // three.js#29066 -- because the instance matrix is baked into the node graph
  // as a uniform buffer over that mesh's own array. So the node-builder state,
  // the generated WGSL and the render pipeline are all per object: two tiles'
  // trees produce shaders that are not even textually equal, because the matrix
  // arrives as a struct named `NodeBuffer_<node id>` off a global counter.
  //
  // A tile has about thirteen instanced sets in it, the streamer keeps dozens of
  // tiles resident, and `TileStreamer.update` decides `group.visible` from a
  // **frustum test** -- so those compiles land on the frame a tile enters the
  // view. Turning on the spot moves nothing, loads nothing and streams nothing,
  // and brings twenty tiles into the frustum at once. Measured on the shipped
  // build at 180 deg/s with 56 tiles resident: one turn compiled 589 pipelines,
  // p95 242 ms, worst frame 1,492 ms, 23 frames of 120 over 100 ms. The same
  // turn repeated compiled nothing and peaked at 62 ms.
  //
  // So each tile is compiled once, off the main thread, when it is built, and is
  // not drawn until that lands. `compileAsync` is the same tool the boot pass
  // uses and for the same reason -- it passes a promise array to the backend,
  // which is what selects `device.createRenderPipelineAsync` over the blocking
  // call. See `TileStreamer.setPrecompiler` and `LoadedTile.warm`.
  //
  // Named rather than inline because the far layer needs the identical
  // function: `FarHexes` compiles a staged, detached group of slab meshes
  // before moving them into the scene, on exactly this argument. Two copies of
  // the visibility dance would be two chances to get it wrong.
  const precompileGroup = async (group: Group): Promise<void> => {
    // Visible for the walk and hidden again immediately, because the two
    // visibilities are the same flag: `_projectObject` skips an invisible object
    // in `compileAsync` exactly as it does in `render`. `compileAsync` does its
    // whole projection synchronously before its first await -- the render list
    // is built and the compilation work items are queued before it yields -- so
    // by the time this returns the walk has happened and the tile is hidden for
    // the entire asynchronous half.
    //
    // The three-argument form names the real scene as the target, which is what
    // makes the cache keys the ones `render` will look up: the lights node, the
    // clipping context and the render-target formats all come from there.
    group.visible = true;
    const compiled = renderer.compileAsync(group, camera, scene);
    group.visible = false;
    await compiled;
  };
  streamer.setPrecompiler(precompileGroup);

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
  // --- Workstream G: the landing panel, the token, and the feedback gates.
  //
  // One object and one block. `hud.askName` was a name box and a promise; this
  // is the same promise with two tabs behind it -- quick play (the name box, now
  // with a live `/auth/check` on it) and log in / sign up. It also owns the
  // "sign up to send feedback" blocks in the Escape panel, because they are the
  // same state and the same form. Everything about it is `client/src/accounts.ts`.
  //
  // `restore()` is awaited *before* the panel goes up, so a returning player is
  // shown "playing as Bazza · log out" rather than an empty field that is
  // corrected a moment later. It is bounded by the same `withDeadline` every
  // other boot fetch is, one screenful below.
  const joinGate = new JoinGate({
    endpoint: () => (netUrl === null ? '' : httpBaseOf(netUrl)),
    notice: (message) => hud.notice(message),
  });
  const joinPromise: Promise<{ name: string; token: string }> =
    netUrl === null
      ? Promise.resolve({ name: storedName || sanitiseName(suggestName()), token: '' })
      : joinGate
          .restore()
          .then(() => joinGate.landing(storedName || sanitiseName(suggestName())));

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
        // On a segmented world the skyline arrives one hexagon at a time out of
        // `hexes/<id>.far.bin` instead of one 3.08 MB `far.bin` held for the
        // session. Null on every other world, and nothing below changes.
        hexContract(),
      ),
      FAR_LAYER_DEADLINE_MS,
      'the far layer',
    )) ??
    ({ slabs: null, ground: null, count: 0, hexes: null } as Awaited<
      ReturnType<typeof loadFarLayer>
    >);
  if (far.hexes) {
    // The same compiler the streamer uses, so a hexagon's slabs are built off
    // the main thread before anything draws them -- see `FarHexes`.
    far.hexes.setPrecompiler(precompileGroup);
    // Awaited once, here, so the warm-up below has real slab meshes to compile
    // against. Everything after this is pumped from the frame loop.
    await withDeadline(
      far.hexes.ensure(hexesNear(SPAWN_TARGET.x, SPAWN_TARGET.z, far.hexes.cutM)),
      FAR_LAYER_DEADLINE_MS,
      'the spawn hexes of the far layer',
    );
  }
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

  // **The undercroft rule, adopted.** From here on every prism that arrives is
  // offered to the envelope first, and a building standing across the railway or
  // a carriageway goes into the grid as a tunnel through itself rather than as a
  // wall across a route. Nothing is resident yet, so this pass carves nothing;
  // it is the *adoption* that matters, and the count below is what the roads add
  // to it over the session.
  collision.setEnvelope(envelope);
  console.debug(`[envelope] ${envelope.count.toLocaleString()} rail corridors adopted before the first tile`);
  // **And the trains, which are the only solid thing in the world that moves.**
  // Reported as *"i also passed through another train at one point, not good"*.
  // The fleet rebuilds one key of prisms per frame from the same `poseTrain` the
  // server rides on, bounded to the carriages near enough to touch, and drops
  // the consist the player is standing inside so a rider is never in a wall.
  // See `world/trains.TrainFleet.setSolids`.
  trains.setSolids(collision);
  // **The carriageways are deliberately not added to it**, and the two ends have
  // to agree about that or a hole one of them has opened is a wall the other
  // pushes the player out of. `server/world.ts`'s `lanes` layer carries the
  // argument in full: a road corridor is only known when its tile's sidecar
  // lands, so honouring it means re-offering prisms that are already resident,
  // and on the server that turned a 34-second boot into one that never answered
  // `/health`. The railway has no such problem -- one file, read before the
  // first prism -- so the rail envelope ships and the road half waits for
  // `elevated.py`, which already does this cut where the whole road graph is in
  // hand at once.

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
  // --- Workstream Q. This process wants the obstacle roster: it is what stops the
  // moving fleet driving through the parked one, and it is the *client's* to build
  // -- the server deliberately does not, because every effect it has is a sideways
  // offset of at most 1.5 m and the roster is 35 MB on a 1 GB box. See
  // `traffic.LaneObstacles.wanted`. Set before the streamer adopts anything, or
  // the tiles that arrived first would have no bays in it.
  traffic.obstacles.wanted = true;
  streamer.setTrafficField(traffic);
  // --- WORKSTREAM S. The parked fleet, as cars a player can steal.
  //
  // The browser's half of the third residency layer: the streamer hands this the
  // same `.cars.bin` it hands the model fleet, in the same two places, and
  // `resolveTake` asks it beside the timetable. Set here rather than beside
  // `carModels` because that object is optional and this is not -- see
  // `staticcars.StaticCarSink` -- and before the streamer adopts anything, for the
  // reason the obstacle roster above is: tiles that arrived first would be missing.
  //
  // `groundAt` is attached a thousand lines down, where `groundHeightAt` exists.
  const staticCars = new StaticCarField();
  streamer.setStaticCarSink(staticCars);
  const trafficMovers = new TrafficMovers(streamer.cars);
  for (const mesh of trafficMovers.meshes) scene.add(mesh);
  // --- Workstream Q: the (dis)appearance latch, and the obstacle roster.
  //
  // The latch is per client by construction -- "in view" is not a fact the server
  // has -- and it is handed to the one loop that already poses every car in view.
  // See `game/viewlatch.ts`.
  trafficMovers.latch = new ViewLatch();
  // Where the headlights go. The traffic already computes a pose for every car
  // in view every frame and the night rig has to draw its lights at exactly
  // those poses, so the sink is fed from inside that one loop rather than from a
  // second pass that would have to agree with it. By day `begin()` returns false
  // and the whole thing is one comparison per frame. See `world/cars.ts`.
  trafficMovers.lights = nightLights.carLights;

  // And the near field, where a box stops being enough.
  //
  // Every car within 90 m of the camera -- moving or parked, from either fleet --
  // is drawn as one of 24 real models instead, chosen by the car's own stable
  // identity so it is the same car to everyone forever. `world/carlod.ts` carries
  // the whole argument; the three lines below are the whole of the wiring, and
  // each is a different half of it: the models have to be *in the scene* before
  // the boot scene pass compiles it, the moving fleet has to know which cars not
  // to draw as boxes, and the streamer has to hand over each tile's parked cars
  // as it arrives and take them back as it leaves.
  //
  // Awaited here, well above the scene pass, and bounded like every other asset
  // on this path. 2.4 MB of glTF, and losing it costs the near field its models
  // -- which is the picture this game had for its whole life -- where waiting
  // forever for it costs the game.
  const carModels = await withDeadline(
    loadCarModels(undefined, createCarPose()),
    FAR_LAYER_DEADLINE_MS,
    'the car models',
  );
  if (carModels) {
    for (const mesh of carModels.meshes) scene.add(mesh);
    trafficMovers.models = carModels;
    // --- Workstream Q. The parked fleet, as obstacles the moving fleet steers
    // round: `carlod` is the one place in the client that brackets a tile's
    // parked cars exactly, and the static half of the obstacle roster is the
    // client's alone. See `traffic.LaneObstacles.adoptStatics`.
    carModels.obstacles = traffic.obstacles;
    streamer.setParkedCarSink(carModels);
    console.debug(
      `[carlod] ${carModels.loadedFiles.length} car models over pools ` +
        `${JSON.stringify(carModels.poolSizes())}` +
        (carModels.skipped.length
          ? `; skipped ${carModels.skipped.map((s) => `${s.file} (${s.why})`).join(', ')}`
          : ''),
    );
  }
  /**
   * The two hero trains, on exactly the car models' terms and immediately after
   * them, because they are the same asset class one order of magnitude up:
   * 10.5 MB of glTF for a Tangara and a Metropolis, bounded, and optional.
   *
   * Two lines of wiring and each is a different half of it. `load` splits both
   * files into carriage templates -- see `world/trains.ts` -- and `warm` walks
   * one instance of every template through `precompileGroup`, which is the same
   * function `TileStreamer.setPrecompiler` was given and is here for the same
   * reason: these materials came out of a GLB with four textures on them, no
   * boot stand-in can stand in for one, and the scene pass below cannot reach
   * them because no train is in the scene until one comes within 260 m. Without
   * it the first train the player sees costs six pipelines in one frame.
   */
  await withDeadline(trains.load(), FAR_LAYER_DEADLINE_MS, 'the train models');
  // Unconditionally, models or not: the box train is an `InstancedMesh` whose
  // count is zero until a train is in range, and a draw with no instances is a
  // pipeline the scene pass never compiles.
  await withDeadline(trains.warm(precompileGroup), WARMUP_DEADLINE_MS, 'the train shader pass');
  if (trains.hasModels) {
    console.debug(
      `[trains] ${Object.keys(trains.templateTriangles()).length} carriage templates, ` +
        `triangles ${JSON.stringify(trains.templateTriangles())}`,
    );
  }
  for (const warning of trains.warnings) console.warn(`[trains] ${warning}`);

  /**
   * When the model fleet last decided who is near enough, milliseconds.
   *
   * The sweep runs at `SWEEP_HZ` rather than per frame, and the hysteresis band
   * between the claim and release radii is what pays for that -- see
   * `world/carlod.ts` section 4. Held here rather than inside the fleet because
   * it is a property of this loop's clock, not of the fleet.
   */
  let lastCarSweep = 0;
  /** Scratch for the per-tick hit query, so a fixed step allocates nothing. */
  const carRoutes: LaneRoute[] = [];
  const carPose: CarPose = createCarPose();
  /**
   * WORKSTREAM T: the driven car's own box, for `driving.crashIntoTraffic`.
   *
   * A second pose because a crash has two cars in it and the iterator owns
   * `carPose` for the ambient one. Here rather than in the block that uses it
   * for `carRoutes`' reason exactly -- that block runs every fixed step and a
   * `createCarPose()` inside it would be an allocation per tick.
   * `server/sim.drivenPose` is the same field on the other end.
   */
  const carCrashPose: CarPose = createCarPose();
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
  // The assets and their kit check are four hundred lines above, beside the
  // warm-up that compiles them. Only the squad is built here.
  const squad = new PoliceSquad(policeAssets, characters);
  for (const rig of squad.rigs) scene.add(rig.mesh);

  // --- The heat ladder (workstream D). One contiguous block; see `game/heat.ts`.
  //
  // The **field** is the offline authority's, exactly as `factions` above it is:
  // online it is never stepped and the star count arrives on `MSG.HEAT`, and
  // offline this process runs the same `stepHeat` the server runs, over the same
  // file. `installHeat` is the handle `factions.accuse`'s crime funnel reaches
  // it through -- one authority per process, and in a browser that is this one.
  const heat = new HeatField();
  installHeat(heat);
  /**
   * The two things the ladder needs beyond the faction context. Built once.
   *
   * `rideStop` is this process's answer to "what is the player's train doing",
   * and it is resolved from the ride the player is already on rather than from
   * anything new -- `aboardPose` against the same `railSeconds(Date.now())`
   * every other rail call site in this file reads. -2 is on foot, -1 is aboard
   * and moving, and anything else is the stop index the train is standing at.
   * See `heat.HeatWorld`.
   */
  const heatWorld: HeatWorld = {
    lanes: traffic,
    rideStop: (id) => {
      if (id !== playerCombat.id) return -2;
      const a = playerCombat.aboard;
      if (!railBake || !isAboard(a)) return -2;
      const pose = aboardPose(railBake, a, railSeconds(Date.now()));
      return pose === null ? -2 : pose.atStop;
    },
  };
  /** The patrol cars and the RBTs in view, from whichever authority is running. */
  const patrolFleet = new HighwayPatrolFleet(patrolAssets);
  scene.add(patrolFleet.group);
  /**
   * Polair: an airframe on a lagging orbit, a searchlight that hunts, three nav
   * lamps and a marksman who misses. See `game/polair.ts` and section 4 of
   * `world/highway-patrol.ts`, which is the argument that changed.
   *
   * `Polair` adds its own group to the scene, because a helicopter is not parented
   * to a tile and never was.
   */
  const polair = new Polair(scene, patrolAssets);
  /**
   * The record the frame loop hands it. Built **once**, with its three hooks bound,
   * and mutated below -- which is why the frame-loop block for this feature is six
   * field writes and one call however much the helicopter grows.
   *
   * `resolve` is the collision world's, used once per round to keep a missed shot's
   * puff of grit out of the inside of a terrace.
   */
  const polairView = createPolairView(
    (x, z) => groundHeightAt(x, z, player.position.y),
    (distance) => audio.gunshot(distance),
    (slant) => audio.polairReport(slant),
    collision ? (fx, fz, tx, tz, r, y) => collision.resolve(fx, fz, tx, tz, r, y) : undefined,
  );
  /** What the star row last read, so `hud.notice` fires on the edge and not the level. */
  let heatShown = 0;

  // --- And the street factions, on exactly the same two tiers.
  //
  // The ambient tier here is not the pedestrian schedule -- a loiterer is not
  // going anywhere, so `game/streetlife.ts` places its own people *on* the bands
  // instead of *through* them -- but it is the same bargain: a pure function of
  // the anchor and the tick, evaluated identically by this browser and the
  // server, costing nothing on the wire and existing in both modes.
  // Likewise: the kit and its check are above, beside the warm-up.
  const streetCrowd = new StreetCrowd(streetAssets, characters);
  for (const rig of streetCrowd.rigs) scene.add(rig.mesh);

  // --- And workstream E's five characters, on the same two tiers again. Twelve
  // pooled rigs, and an ambient tier that is a hash over a 420 m cell grid
  // weighted by the ABS census field -- so like the beats and the loiterers it
  // costs nothing on the wire and exists identically in both modes.
  const characterCrowd = new CharacterCrowd(characterAssets, characters);
  for (const rig of characterCrowd.rigs) scene.add(rig.mesh);

  // --- And the ambient events, which have **no rig at all**.
  //
  // Five instanced sets: bodies, cars, bins, signs and birds. A trackwork queue
  // is twenty-five figures and a bin night is a dozen ibises, and neither of
  // them moves -- see `world/events.ts` on why nothing in an event needs a
  // skeleton. The sites themselves are a pure function of the in-game day, so
  // every client sees the same crash on the same corner with nothing sent.
  const eventScene = new EventScene(eventAssets);
  for (const mesh of eventScene.meshes) scene.add(mesh);
  /** When the player entered a trackwork queue, in seconds, or -1. See below. */
  let queueSince = -1;
  let queueTold = false;

  // --- And the wildlife, which is the same two tiers with no rig at all.
  //
  // A bird is 30 cm across and is never close enough for a skeleton to be worth
  // anything, so the whole flock is five `InstancedMesh`es driven off one matrix
  // each -- the finding `world/birds.ts` already made about its own ibises. The
  // ambient tier is a hash over the baked park discs and the footpath bands, so
  // like the beats and the loiterers it costs nothing on the wire and exists
  // identically in both modes.
  // Likewise: the kit and its check are above, beside the warm-up.
  const flock = new WildlifeFlock(wildlifeAssets);
  for (const mesh of flock.meshes) scene.add(mesh);
  /** Scratch for the wildlife queries, so a fixed step and a frame both allocate nothing. */
  const wildScratch = createWildScratch();
  const wildPose = createWildPose();

  // --- And the raves, which are the same bargain a fourth time and the densest
  // instance of it. Six or so are live across the 19.3 km world on any given
  // night; which six, what is on the decks, how far into it, and where each of
  // forty people is standing are all pure functions of the wall clock and a site
  // index, so the whole feature costs **nothing on the wire** and two players
  // who walk into the same crowd from opposite directions are watching the same
  // beam sweep the same way to the same bar. `game/rave.ts` section 1 makes the
  // argument; `game/traffic.ts` and `game/pedestrians.ts` made it first.
  //
  // Added to the scene here, at boot, and never removed -- which is what puts
  // its twelve instanced sets in front of the scene pass at the bottom of this
  // function. An `InstancedMesh` created later, when a player first neared a
  // rave, would compile its pipeline inside that frame. See `world/rave.ts`
  // section 2 and `world/warmup.ts`.
  const raves = new RaveWorld(raveAssets, pedAssets, characters);
  for (const mesh of raves.meshes) scene.add(mesh);
  for (const rig of raves.rigs) scene.add(rig.mesh);
  scene.add(raves.banner);
  /**
   * Which rave the police were last seen arriving at, so the barks fire on the
   * **edge** rather than every frame of the bust.
   *
   * `game/dummies.ts`' rule and `PedestrianCrowd.poseRigs`' rule: a line
   * re-triggered sixty times a second is not a line, it is a texture. The bust
   * itself is entirely deterministic and shared -- see `game/rave.ts` section 5
   * -- and this is the *local presentation* of it, which is the only part a
   * client is allowed to own.
   */
  let bustedVenue = -1;

  /**
   * The raves this player has been within earshot of, tonight.
   *
   * The whole of the map marker's design; see the marker source below for why
   * one `Set` is the difference between a map and a quest log. Reset when the
   * night rolls over, in the frame loop, where the index is already in hand.
   */
  const heardRaves = new Set<number>();
  let heardNight = -1;

  /**
   * What is on, where, at an instant. `sydney.raves.tonight()`'s answer.
   *
   * Reads the same three pure functions the renderer and the mixer do, so a
   * listing can never disagree with what is actually in the world -- which is
   * the failure a second, console-only path would have had, and which would have
   * made this tool worse than useless the one time somebody needed it.
   */
  const raveListing = (
    atMs: number,
  ): Array<{ name: string; kind: string; metres: number; stage: string; deck: string; watched: boolean }> => {
    const { index } = raveNight(atMs);
    const out = [];
    for (const venue of liveRaves(index)) {
      const state = raveState(venue, atMs);
      out.push({
        name: venue.site.name,
        kind: ['warehouse yard', 'under a bridge', 'parkland'][venue.site.kind],
        metres: Math.round(Math.hypot(venue.site.x - player.position.x, venue.site.z - player.position.z)),
        stage: ['load-in', 'doors', 'peak', 'wind-down', 'pack-up', 'busted', 'over'][state.stage],
        deck: deckTitle(bag, setPosition(venue, bag, atMs)),
        watched: venue.site.watched,
      });
    }
    out.sort((a, b) => a.metres - b.metres);
    return out;
  };

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
   * Workstream E's edge set: influencers currently drawn on the ground, and
   * tradies who have already offered a hand.
   *
   * One `Set` for two kinds rather than two, because the actor id space is
   * shared and the two uses cannot collide -- an actor is one kind for its whole
   * life. `firing` and `charging` above are the same arrangement for the same
   * reason, and the alternative is two maps that are each mostly empty.
   */
  const posted = new Set<number>();

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
      // --- Workstream E: and if no officer saw it, a Karen might have.
      //
      // `karenWitness` rather than `karenReport`, and the difference is the
      // whole of what a predicting client is allowed to do. `karenReport` calls
      // `reportCrime`, which opens an investigation on the authority --
      // `server/sim.reportIfWitnessed` calls it for exactly that reason. This
      // client is not the authority when it is online, so it asks the query and
      // opens its own *optimistic* banner, which is the identical trade it
      // already makes off `policeWitness` one line up: right almost always, at
      // most 50 ms ahead of the truth, and wrong costs a banner that clears
      // itself on the next `MSG.INVESTIGATION`.
      //
      // Offline the branch below makes it real through the same
      // `FactionField.accuse` the server calls, so there is one implementation
      // rather than two that agree by inspection.
      if (!w.seen) {
        if (!karenWitness(x, z, tick, witnessCtx)) return;
        // She says so. The line is cosmetic and local -- see
        // `game/characters.ts` section 4 -- and it is posted here rather than
        // from the crowd's own speech clock because *this* is the moment it
        // means something.
        hud.notice(KAREN_REPORT_LINE);
      }
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
  /**
   * The railway's own solids, arithmetically. See `world/rail-solids.ts`.
   *
   * Assigned below, once `railNetwork` and `railCut` both exist, and read here
   * because it has to be in the ground query. **This is the same field
   * `server/world.groundFor` folds into the identical clause**, over the same
   * `buildNetwork`, the same `RailCut` and the same terrain -- which is what
   * makes a coping, a stair tread and a station roof the same height on both
   * ends of the wire instead of a surface on this one and thin air on that one.
   *
   * It is not a second opinion about the prisms `railWorld` puts in `collision`:
   * they are enumerated by the same call, so where a chunk is built the two
   * agree to the bit, and where it is not this one still answers.
   */
  let railSolidField: RailSolidField | null = null;
  /**
   * The ground, with the railway's own solids **as an argument** rather than as
   * a capture.
   *
   * ---------------------------------------------------------------------------
   * **THIS PARAMETER IS THE FIX FOR AN UNBOUNDED MUTUAL RECURSION**, and the
   * recursion was live in the shipped build at the default spawn:
   *
   *     groundHeightAt -> RailSolidField.roofHeight -> segmentSolidsFor
   *       -> viaductSolids -> wildGround -> groundHeightAt -> ...
   *
   * `RangeError: Maximum call stack size exceeded`, thrown inside the animation
   * callback, which aborts the remainder of that frame -- including the
   * controller's ground correction. It reads as sticking, or as being dragged,
   * and there is no frame that says why.
   *
   * **It is circular by definition, not by implementation, so no re-entrancy
   * guard resolves it.** `viaductSolids` sets a pier's foot from the ground; the
   * ground-parity round made `groundHeightAt` consult the railway's solids; so a
   * pier's foot became partly defined by a query that needs the pier. A guard
   * would return whichever half-built answer the stack happened to be holding,
   * which is the "two descriptions of one thing" this project keeps paying for.
   *
   * **A pier's foot is therefore defined as the composed ground *minus* the
   * rail-solid layer** -- this function with `rail` null -- and not as
   * `rawGroundAt`. The choice matters in exactly one place and it is a real one:
   * a pier standing inside a cutting must stand on the **cut floor**, which
   * `railCut.groundCutAt` below supplies and the raw DEM does not; the DEM there
   * is the sheet the corridor was carved out of, ten metres over the pier's
   * actual base. Everything else the composition adds -- platforms, station
   * boxes, vessels, roofs -- is `-Infinity` at the `-Infinity` feet a placement
   * query asks with, so dropping the rail layer is the whole of the change.
   *
   * **And that is why this is not a change to the world.** `pick` and
   * `CollisionWorld.roofHeight` both refuse a prism whose base is above the
   * asker, so at `-Infinity` feet the rail-solid term was already `-Infinity`
   * for every prism in the city: it contributed nothing and cost an infinite
   * recursion. `checkGroundLayering` asserts that emptiness over the suite's own
   * lattice rather than leaving it as this paragraph's assertion.
   *
   * `server/world.ts`'s own `wildGround` has never had the rail layer in it, so
   * this is the client being brought **onto** the server's definition rather
   * than away from it -- which is the direction that protects the 0-of-670,437
   * parity rather than risking it.
   */
  const groundOn = (
    x: number, z: number, feetY: number,
    rail: RailSolidField | null,
  ): number => {
    const sampled = streamer.ground?.height(x, z) ?? NO_GROUND;
    if (Number.isFinite(sampled)) lastGround = sampled;
    // `roofHeight` returns -Infinity when the player is not standing on
    // anything, so the max falls through to the ground on its own.
    //
    // And the station platforms, **analytically**, beside the prisms
    // `world/rail-geo.RailWorld` has already put in `collision` for the same
    // surfaces. Two answers for one thing looks like a mistake and is the fix
    // for one: the prisms are built per chunk as the player approaches and only
    // exist in a browser, and the *server* has never had them at all -- so a
    // platform was a surface on one end and thin air on the other, and standing
    // on one meant being corrected downwards forever. The arithmetic version is
    // the same 1.05 m over the same rail head from the same bake, so where both
    // exist they agree to the bit, and where the chunk has not been built yet
    // this one still answers. See `game/riding.PlatformField`.
    // **Replaces the terrain rather than competing with it** when it answers at
    // all, which `server/world.groundFor` does identically and for the reason it
    // states there: `PlatformField.heightAt` only answers within a step below
    // and a jump above a platform, so an answer means "standing on it", and at a
    // cutting station the terrain grid is metres above the surface the train's
    // doors open onto.
    const platform = platforms === null ? -Infinity : platforms.heightAt(x, z, feetY);
    // The pipeline's prisms, and the railway's own solids beside them. See
    // `railSolidField`: with a chunk built the second term repeats the first and
    // the max is free; outside `BUILD_RADIUS`, and in the window before two
    // chunks a frame have caught up, it is the only one that answers -- and it
    // is the term the server has.
    const roof = Math.max(
      collision.roofHeight(x, z, feetY),
      rail === null ? -Infinity : rail.roofHeight(x, z, feetY),
    );
    if (platform > -Infinity) return Math.max(platform, roof);
    // **And the rest of the station, which is most of it.**
    //
    // A platform is 5.5 m wide and a station box is thirty, so one pace off the
    // deck at Town Hall the line above stops answering -- and `cutAt` below
    // *declines by design* on a bore, because a tunnel has no surface
    // expression to carve. Between the two, the concourse fell through to the
    // DEM twenty metres overhead and the controller stood the player on it,
    // every frame: *"moving anywhere on foot underground tps me to surface"*.
    //
    // Replaces the terrain rather than competing with it, for the identical
    // reason the platform above does, and `StationBoxField.floorAt` is a band
    // for the identical reason too: an answer means "you are inside the
    // station", and George Street over the top of it is not inside anything.
    const boxFloor = stationBoxes === null ? -Infinity : stationBoxes.floorAt(x, z, feetY);
    if (boxFloor > -Infinity) return Math.max(boxFloor, roof);
    // **Inside a carved cutting the terrain is not there**, and until this line
    // nothing on either end of the wire knew it. `terrain.buildTerrainMesh`
    // drops the sub-quads the corridor crosses and `world/rail-geo.ts` builds a
    // trench in the hole, but `TerrainField.height` samples the **uncarved**
    // DEM, so a body over a cutting stood on an invisible sheet across a
    // visible railway. `PlatformField` covered it up wherever a platform
    // happened to be under the asker and nowhere else.
    //
    // It is also what made a station in a cutting unenterable, which is the
    // reason it is being fixed now: the access stairs
    // `rail-geo.writeStationAccess` cuts into the trench wall are *below* the
    // DEM by construction, so walking down them was walking along the top of
    // the hole. `server/world.groundFor` carries the identical clause over the
    // identical `RailCut`, because a client that walks down a staircase the
    // server thinks is solid ground is a client the server drags back up.
    // **And the vessel, which is the clause above said exactly.** `cutAt` below
    // answers with a rail head wherever a strip's disc of half-width reaches;
    // this answers with the surface of a solid whose footprint is the very rim
    // the terrain was triangulated to, so the ground and the answer about the
    // ground have one outline between them instead of two. Replaces the terrain
    // for a stronger reason than the platform does: inside the rim the terrain
    // is not lower, it **is not there**. `server/world.groundFor` carries the
    // identical clause in the identical position over a field built by the
    // identical module.
    //
    // Off unless `?vessels=1`, so with the flag down this is a null check.
    if (vesselField !== null) {
      const deck = vesselField.heightAt(x, z, feetY);
      if (deck > -Infinity) return Math.max(deck, roof);
    }
    const cutFloor = railCut === null ? Number.NaN : railCut.groundCutAt(x, z, sampled);
    if (Number.isFinite(cutFloor)) return Math.max(cutFloor, roof);
    return Math.max(lastGround, roof);
  };

  /**
   * The ground a **body** stands on: every layer, the railway's solids included.
   *
   * The whole composition, and the one every simulation call site wants.
   */
  const groundHeightAt = (x: number, z: number, feetY: number): number =>
    groundOn(x, z, feetY, railSolidField);
  // --- WORKSTREAM S: and the ground a parked car stands on.
  //
  // The full composition, which is the same call `server/world.loadWorld` gives
  // its own copy of this field (`groundFor(world).groundHeight`) -- so both ends
  // put a parked car at the same height by asking the same question of the same
  // terrain, rather than by agreeing. `game/staticcars.ts` section 3 argues why
  // the height is a query at take time rather than a seventh array.
  //
  // Only ever asked for cars already inside `driving.TAKE_RADIUS`, so the
  // `lastGround` this writes is the player's own patch of road -- which is the one
  // case where writing it is harmless. See `wildGround` for the callers where it
  // is not.
  staticCars.groundAt = groundHeightAt;

  /**
   * The ground a bird stands on, and the ground a **viaduct pier** stands on.
   * Terrain, cut floor and station, never a roof and never the railway's own
   * solids.
   *
   * `-Infinity` for the feet is `collision.roofHeight`'s "how high is the asker"
   * and it is the whole of the difference for a turkey: it is not standing on
   * anything but the park, and a query that folded in a roof would put one on
   * top of the pavilion the moment its cell overlapped the footprint.
   *
   * **`null` for the rail layer is the whole of the difference for a pier**, and
   * it is the line that ends the recursion `groundOn`'s header describes: this
   * is the function handed to `RailWorld` and to `RailSolidField`, so the thing
   * that sets a pier's foot cannot be a thing that needs the pier. It is also,
   * to the bit, what `server/world.ts` has always given its own field.
   *
   * Hoisted to a `const` rather than written at the call site because the
   * callers are per frame or per tick, and a fresh closure on either would be an
   * allocation forever.
   */
  const wildGround = (x: number, z: number): number => groundOn(x, z, -Infinity, null);

  /**
   * The **raw** terrain height, which is deliberately not `groundHeightAt`.
   *
   * Two reasons, and both of them were bugs before they were reasons.
   *
   *   1. `groundHeightAt` never returns a non-finite value: it falls back to
   *      `lastGround`, the last height the *player* stood on, which is exactly
   *      right for walking a player across a seam and exactly wrong for anything
   *      placing an object. A bike three tiles away whose terrain has not arrived
   *      would be placed at the player's own elevation -- buried in Redfern or
   *      hovering over Alexandria -- and, worse, `placeBike` would *succeed*, so
   *      the tile would be struck off and never retried.
   *   2. `groundHeightAt` **writes** `lastGround`. Querying it for a point 700 m
   *      away leaves the player's own fallback height set to somewhere they have
   *      never been, which is a real position bug in a function that only meant
   *      to ask a question.
   *
   * So this asks the streamer directly and answers `NO_GROUND` for a tile that
   * is not resident, which is what makes "wait until the terrain is here" a
   * thing `placeBike`, `maybeBuildStall` and `RailWorld` can all simply test for.
   *
   * **Declared here rather than beside the bikes**, which is where it used to
   * live and where its two callers still are: `RailWorld` is constructed twenty
   * lines below and needs it, and a rail chunk built against `wildGround` at the
   * edge of its 1100 m ring would compare a track height against ground from
   * seven hundred metres away and conclude the railway is underground. That is
   * the exact failure the paragraph above describes, in a third place.
   */
  const rawGroundAt = (x: number, z: number): number => streamer.ground?.height(x, z) ?? NO_GROUND;

  /**
   * Sweep the corridor near the player, and hand the rim to the ground.
   *
   * ---------------------------------------------------------------------------
   * **Why this is a rebuild and not a one-off, and why it is not free-running.**
   *
   * A vessel needs the DEM at its rim on *both* sides, and a browser has the DEM
   * a tile at a time. `spineForRun` refuses a run with an unresident post rather
   * than guessing a depth -- a vessel built on a guess is a hole with a
   * plausible shape -- so the corridor a client can build grows as tiles land,
   * where the server builds all of it at boot from grids it read off disk.
   *
   * So: rebuilt when the resident tile count changes, and only then. The count
   * is the cheapest signal that the *answer could differ*, and it is exactly
   * right rather than a heuristic -- `TerrainField` never evicts a grid, so the
   * set only grows and a new grid is the only thing that can turn a refused run
   * into a built one.
   *
   * Bounded to the tiles the player can reach, because the sweep is 5 s over the
   * whole 340 km network and this is a frame budget rather than a boot one.
   */
  /**
   * How far from the player the corridor is swept, metres.
   *
   * The collision radius (`tile-lifecycle.COLLISION_KEEP_RADIUS_M` is 420 m)
   * plus a tile, so the corridor is always built further out than the ground
   * query can reach and a body never walks off the end of the swept region into
   * a footprint that has not been built. Half a kilometre of railway is about
   * ten runs and a couple of milliseconds; the whole 340 km is five seconds, and
   * this runs on a frame.
   */
  const VESSEL_RADIUS_M = 900;
  let vesselTiles = -1;
  /** The last corridor swept, for `sydney.rail.vessels()`. Null with the flag down. */
  let vesselBuild: CorridorBuild | null = null;
  let vesselMs = 0;
  /**
   * How far the player may get from where the corridor was last swept, metres.
   *
   * **The tile count is not enough on its own, and a screenshot found it.** The
   * only trigger used to be "a grid has landed", on the argument that a new grid
   * is the only thing that can turn a refused run into a built one. True, and
   * incomplete: the sweep is centred on the *player*, so a player crossing a
   * suburb whose tiles are all resident -- which is every teleport, and every
   * long walk in a session that has been running a while -- walks straight off
   * the end of the swept region into a corridor that was never built. The ground
   * query then falls through to the DEM over an open cutting, which is the
   * original bug wearing the new architecture.
   *
   * 300 m against a 900 m radius, so the swept region always reaches at least
   * 600 m past the player -- comfortably outside `COLLISION_KEEP_RADIUS_M`, which
   * is the distance the ground query can actually be asked at.
   */
  const VESSEL_RECENTRE_M = 300;
  let vesselAt = { x: Infinity, z: Infinity };
  const refreshVessels = (): void => {
    if (!vesselsEnabled() || railBake === null || streamer.ground === null) return;
    const resident = streamer.ground.loadedTiles;
    const moved = Math.hypot(player.position.x - vesselAt.x, player.position.z - vesselAt.z);
    if (resident === vesselTiles && moved < VESSEL_RECENTRE_M) return;
    vesselTiles = resident;
    vesselAt = { x: player.position.x, z: player.position.z };
    const tileSize = streamer.tileSize;
    if (!(tileSize > 0)) return;
    const t0 = performance.now();
    const built = buildCorridor(
      railBake,
      vesselCut ?? (vesselCut = corridorCut(railBake)),
      rawGroundAt,
      { pitch: tileSize / streamer.terrain.grid / 8 },
      { at: { x: player.position.x, z: player.position.z }, radius: VESSEL_RADIUS_M },
    );
    vesselField = built.field;
    // The corridor moved, so every trench solid the arithmetic field cached is
    // a wall `writeTrench` may no longer draw. See `invalidateCorridor`.
    railSolidField?.invalidateCorridor();
    vesselBuild = built;
    vesselMs = performance.now() - t0;
    streamer.setSeam(built.seam, [
      player.position.x - VESSEL_RADIUS_M, player.position.z - VESSEL_RADIUS_M,
      player.position.x + VESSEL_RADIUS_M, player.position.z + VESSEL_RADIUS_M,
    ]);
    // **And the same build is what draws it.** Phase 3a of `STATIONS.md`: until
    // now the mesh was built, checked and thrown away, and the visible railway
    // was still `writeTrench`'s. `RailWorld` sorts the vessel's own faces into
    // its own materials, rides the boundary fence on the rim and takes the
    // ballast down to the drawn floor -- and stands the three old writers down
    // inside the footprint, so nothing is drawn twice. One build, one field, one
    // set of triangles: the ground query, the withheld terrain and the picture
    // are three consumers of one object rather than three opinions.
    railWorld?.setVessels(built);
    console.debug(
      `[vessels] ${built.tracks} tracks grouped into ${built.runs.length} formations, ` +
        `${built.triangles.toLocaleString()} triangles, ${built.refused.length} refused, ` +
        `${built.noTerrain} without terrain, ${built.doubleCells} of ` +
        `${built.claimedCells.toLocaleString()} claimed cells claimed twice, ` +
        `${(performance.now() - t0).toFixed(0)} ms`,
    );
  };
  let vesselCut: RailCut | null = null;

  /**
   * The railway in the scene, built here because this is the first line at which
   * both of the things it needs exist.
   *
   * `wildGround` rather than `groundHeightAt`, and it is the same argument the
   * raves make one paragraph down: a viaduct pier stands on the *ground*, and a
   * query that folded in a roof would stop the pier at the top of whatever
   * warehouse the viaduct happens to pass over. `collision` is handed over as
   * the `RailSolids` it implements, so a deck's soffit, a pier, a platform and
   * an underground station box are prisms with the same `base` semantics
   * `decks.py` writes -- which is the whole of what makes a player walk under a
   * viaduct instead of into it.
   */
  const railWorld =
    railNetwork === null
      ? null
      : new RailWorld(railNetwork, railAssets, wildGround, collision, railCut, rawGroundAt);
  if (railWorld) scene.add(railWorld.group);
  // The arithmetic half of the same railway, for the ground query. Built from
  // the identical network, the identical carve and the identical two ground
  // readings `railWorld` above is given, because a field seeded any other way
  // would be a second description of the thing this exists to stop being two
  // things. See `railSolidField`.
  if (railNetwork !== null) {
    railSolidField = new RailSolidField(
      railNetwork, railCut, rawGroundAt, wildGround,
      // `buildChunk`'s own `vesselled`, read at query time rather than captured,
      // because `vesselField` is reseated every time the corridor is re-swept.
      // Inside a formation `writeTrench` draws and registers nothing, so a field
      // that still answered with a wall there would put the flag's world and the
      // ground query back out of step. `server/world.ts` carries the same
      // closure over the same field.
      (x, z) => vesselField !== null && vesselField.surfaceAt(x, z) > -Infinity,
    );
  }
  // And the road sink's forward handle on it. See `railChunks`.
  railChunks = railWorld;

  /**
   * Is there a building standing here? The rave crowd's own rejection test.
   *
   * The same question `setSpawnGuard`'s `solid` asks an ibis and asked in the
   * same words, because it is the same question: `roofHeight` returns the top of
   * any prism whose footprint contains the point, so a roof above somebody's
   * chest means they are *inside* the building rather than beside it.
   *
   * A rave site is an inscribed circle -- of an industrial parcel, of a park, of
   * the void under a viaduct -- and an inscribed circle is guaranteed clear of
   * the *boundary* and says nothing at all about the shipping container in the
   * middle of it or the pavilion in the middle of the park. This is what stops
   * forty people standing in one. Hoisted to a `const` rather than written at
   * the call site because it is read up to `ATTENDEE_CAP` times a frame and a
   * fresh closure per frame would be an allocation forever.
   */
  const raveSolid = (x: number, y: number, z: number): boolean => collision.roofHeight(x, z, y) > y + 0.4;

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
  // And every tile that has not arrived yet, on a segmented world. `index.tiles`
  // grows one hexagon at a time as the player approaches, so a table built once
  // at boot would answer "dry land" for the whole harbour the moment somebody
  // rode north. See `world/hexes.ts`; on an unsegmented world this never fires.
  onHexTiles((manifest) => waterLevels.addTiles(manifest.tiles as Array<{ key: string; wy?: number }>));
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
  /**
   * The change feed, which is the one thing in this panel that needs no server
   * at all: `public/changelog.json` is a static file beside the world tiles,
   * written from `git log` at build time. Started fetching here rather than on
   * the first open, so the tab is drawn rather than loading when somebody
   * reaches it. See `client/src/changelog.ts`.
   */
  const changelog = new ChangelogFeed(
    document.getElementById('changelog-list')!,
    document.getElementById('changelog-foot')!,
  );
  changelog.load();

  /**
   * The frame grabber, and the one line of this feature that has to be in the
   * render loop rather than in a panel.
   *
   * `toDataURL` on a WebGPU canvas is blank unless it is read in the same frame
   * as a render -- silently blank, a valid PNG of nothing -- so the button
   * queues a request and `grabber.afterRender()`, called immediately after
   * `renderer.render` some four thousand lines below, is where the pixels are
   * actually taken. See `client/src/bugreport.ts`, which is written at length
   * about why that is the only arrangement that works.
   */
  const grabber = new FrameGrabber(canvas);

  /**
   * The bug box: the third tab, and the only thing in this client that sends
   * anything over HTTP rather than down the socket.
   *
   * Its metadata callback is where `main.ts` earns its place in this feature.
   * Everything in it lives somewhere different -- the locator under the map,
   * the sky's clock, the combat state's bike, the frame ring, the streamer's
   * asset version -- and this is already the one file that knows all of them.
   * A panel that reached into each would be a panel that breaks whenever any of
   * them moves.
   *
   * Every field is read defensively and the whole thing is inside the form's
   * own try: a bug report is filed *because* something is wrong, so the moment
   * this callback most needs to work is the moment the game is least healthy,
   * and a metadata collector that threw would take the report with it.
   */
  const bug = new BugReportForm({
    // '' offline, which the form turns into "no server — bug reports need one"
    // rather than a button that does nothing. `net` is consulted rather than a
    // captured boolean so a connection that settles later is picked up.
    endpoint: () => (net === null || netUrl === null ? '' : httpBaseOf(netUrl)),
    clientId,
    // Asked for at send time rather than captured, so a player who signs up from
    // the Escape panel can file a report without reloading. See workstream G.
    token: () => joinGate.sessionToken,
    capture: () => grabber.request(),
    meta: () => {
      const here = player.position;
      const where = locator.stats();
      return {
        'world x/z': `${here.x.toFixed(1)} / ${here.z.toFixed(1)}`,
        'world y': here.y.toFixed(1),
        // What the minimap is already showing, which is the one line somebody
        // can walk to: "cnr King St & Carillon Ave, Newtown" beats a pair of
        // floats every time. `street` is sent **only when there is one** --
        // `locator.text` falls back to the suburb where no centreline is near,
        // and the first cut of this sent both, so a player standing in a park
        // filed a report saying `street: Alexandria, suburb: Alexandria`. An
        // empty field is dropped rather than drawn; see `collectMeta`.
        // `where.text` is dropped when it is *only* the suburb, which is what
        // the locator composes when no centreline is close enough to name --
        // standing in Sydney Park, `text` and `suburb` are both "St Peters",
        // and two rows saying the same word read as a broken collector.
        where: where.text === (where.suburb ?? '') ? '' : where.text,
        street: where.street ?? '',
        suburb: where.suburb ?? '',
        clock: sky.time.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }),
        riding: playerCombat.ridingBike !== 0,
        room: net?.room ?? -1,
        build: changelog.build || 'unknown',
        // The world's own version, which is a different fact from the bundle's:
        // a client on today's code and last week's tiles is a real state and it
        // is one of the harder ones to diagnose without being told.
        world: streamer.assetVersion,
        protocol: PROTOCOL_VERSION,
        'frame ms': medianFrameMs(),
        'render scale': renderScale,
      };
    },
  });

  /**
   * The panel, and the three tabs it hosts.
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
  const suggestions = new SuggestionsPanel(
    {
      onRefresh: () => net?.requestSuggestions() ?? false,
      onSubmit: (title, body) => net?.submitSuggestion(title, body) ?? false,
      onVote: (localId, dir) => net?.voteSuggestion(localId, dir) ?? false,
    },
    { changelog, bug },
  );

  /*
   * --- WORKSTREAM V: teams and talents, the level-2 takeover.
   *
   * `SuggestionsPanel` above is the shape: a panel that owns its own DOM, its
   * own listeners and its own Escape discipline, handed closures rather than
   * objects so a connection that settles after this line is picked up without
   * rebuilding anything. Everything the panel does -- opening itself at level 2,
   * refusing to close before a side is picked, the trees, the tooltips -- is in
   * `client/src/teams.ts`; this is the wiring and nothing else.
   *
   * `?? ...` on every reader is the offline path, on the suggestions panel's own
   * argument: `?offline` has no ladder, so the panel asks, gets "no team, level
   * 1, not online", and never opens.
   */
  // The read half of the talent state, hoisted so the modal panel and the
  // hold-to-read build sheet cannot disagree about what you have spent.
  const talentRead = {
    online: () => net !== null,
    team: () => net?.myTeam ?? TEAM.NONE,
    mask: () => net?.myTalents ?? EMPTY_MASK,
    level: () => net?.myTalentLevel ?? 1,
  };
  const talents = new TalentsPanel({
    signedIn: () => joinGate.signedIn,
    ...talentRead,
    choose: (team) => net?.chooseTeam(team),
    take: (nodeId) => net?.takeTalent(nodeId),
    refund: (nodeId) => net?.refundTalent(nodeId),
    resetAll: () => net?.resetTalents(),
    // The typing interlock. While the panel is up, `hud.typing` is true and the
    // keydown listener below returns at its first statement -- so WASD does not
    // walk and `f` does not swing under a modal with a cursor on it.
    setModal: (open) => { hud.talentsOpen = open; },
    // The level-up chime, which is the audible half of the beat the panel plays
    // before it opens. See `client/src/teams.TalentsPanel.beat`.
    fanfare: () => audio.levelUp(),
  });

  /**
   * The build sheet: hold `b` and read what you spent, without stopping.
   *
   * A sibling of the panel above and deliberately not part of it -- see
   * `client/src/buildsheet.ts`'s header for why remembering and spending are
   * two screens. It takes no input and sets no modal flag, so the keydown
   * listener below does *not* gate on it: you can walk, drive and be shot at
   * while it is up, which is the point.
   */
  const buildSheet = new BuildSheet(talentRead);

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
  // The field itself is built beside the warm-up, four hundred lines above, so
  // its shader is compiled behind the loading screen rather than on the frame
  // the first other player appears. Only the scene wiring is here.
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
    id: 0, name: '', health: 0, headX: 0, headY: 0, headZ: 0, down: false, stars: 0,
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
  // --- Workstream I: and your own two hands, for the slot that holds nothing.
  //
  // Kit 3, which is `self`'s colourway two dozen lines up -- the local body is
  // hard-coded to that kit today, and taking the same literal is what keeps the
  // hands you look down at the same colour as the arms you see in third person.
  // If the local kit ever becomes a choice this is the second place to read it.
  //
  // Camera-parented like the bat, hidden from the start: `setWeaponVisible`
  // below turns them on when fists are the primary slot and `money.frame` calls
  // it every frame. Hidden rather than visible because the default slots are
  // bat/footy (`phone.defaultHands`), so no session begins with fists up.
  const handsViewmodel = new HandsViewmodel(new HandsAssets(3));
  camera.add(handsViewmodel.group);
  setVisibleToCamera(handsViewmodel.primary, false);
  setVisibleToCamera(handsViewmodel.off, false);
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

  // --- WORKSTREAM X: teams you can see. ------------------------------------
  //
  // Everything this block does lives in `world/teamlook.ts` and
  // `game/teamlook.ts`; what is here is the wiring, and it is deliberately one
  // contiguous piece plus two lines in the frame loop.
  //
  // Who is on which side is read through `world/teamview.ts` rather than off
  // `net`, because the roster's `team` byte and the talent mirror belong to the
  // framework workstream and land on their own branch. `setTeamSource` is the
  // seam: until somebody calls it, `teamOf` answers `TEAM.NONE` for everybody
  // and this whole feature draws exactly the game that was here before -- which
  // is also, permanently, what offline looks like, because there are no accounts
  // without a server.
  //
  // **The one line the framework workstream adds at merge** is here, and it is
  // written out rather than left to be worked out from `teamview.ts`'s header:
  //
  //     setTeamSource({ teamOf: (id) => net?.teamOf(id) ?? TEAM.NONE,
  //                     talentsOf: (id) => net?.talentsOf(id) ?? EMPTY_MASK });
  //
  // Until it lands, `hasTeamSource()` is false, every `teamOf` answers
  // `TEAM.NONE`, and this whole section draws the game that was here before --
  // which is also what offline looks like permanently, since there are no
  // accounts and therefore no sides without a server. `sydney.teamlook()`
  // reports which of the two states the client is in.
  setTeamSource({
    teamOf: (id) => net?.teamOf(id) ?? TEAM.NONE,
    talentsOf: (id) => net?.talentsOf(id) ?? EMPTY_MASK,
  });
  scene.add(teamRings.mesh);
  const tents = new TentSet(bigNight, characters);
  scene.add(tents.mesh);
  /** Tents standing, from `MSG.TEAM_EVENT`. At most a handful; swept by `untilMs`. */
  const liveTents: TentSpec[] = [];
  /** Slam shockwaves, as (x, y, z, team, when). Swept the same way. */
  const liveSlams: Array<{ x: number; y: number; z: number; team: Team; atMs: number; boom?: boolean }> = [];
  /** The local player's horns, and every remote's, made and unmade on the talent. */
  let selfHorns: HornProp | null = null;
  const remoteHorns = new Map<number, HornProp>();
  /** Reused per frame: everybody visible, so the aura rings can find a teammate. */
  const teamedBodies: Array<{ id: number; team: Team; x: number; y: number; z: number; aura: boolean; group: number }> = [];

  /**
   * One character's body and horns brought into line with their talents.
   *
   * Idempotent by construction -- it sets the geometry the three facts imply
   * rather than reacting to a change -- so a level-up, a refund, a reconnect and
   * a team choice all arrive here as the same assignment and there is no
   * transition to get wrong. See `teamlook.setTeamBody`.
   */
  function dressForTeam(actor: CharacterActor, id: number, horns: HornProp | null, isSelf: boolean): HornProp | null {
    const team = teamOf(id);
    const big = hasBigNight(id);
    setTeamBody(actor, bigNight, team, big);
    const next = setHorns(horns, big && team === TEAM.MARITA, bigNight, characters, actor);
    // The local player's own horns are on the shadow layer with the rest of
    // their body, or they hang in front of their own eyes. `BatProp` documents
    // why this is a separate call: three does not inherit layers.
    if (isSelf && next !== null && next !== horns) next.castShadowOnly();
    return next;
  }

  /**
   * The whole team look for one frame: bodies, horns, rings and tents.
   *
   * Called once from the loop, after the nameplates, because it reads the same
   * final world transforms they do and because the ring under somebody's feet
   * has to agree with the plate over their head about which side they are on.
   */
  function updateTeamLook(nowMs: number): void {
    const seconds = nowMs / 1000;
    selfHorns = dressForTeam(self, net?.id ?? 0, selfHorns, true);

    teamedBodies.length = 0;
    if (net) {
      for (const r of net.remotes.values()) {
        if (r.fresh) continue;
        const entry = remotes.get(r.id);
        if (!entry) continue;
        const horns = dressForTeam(entry.actor, r.id, remoteHorns.get(r.id) ?? null, false);
        if (horns) remoteHorns.set(r.id, horns);
        else remoteHorns.delete(r.id);
        const team = teamOf(r.id);
        if (team !== TEAM.NONE) {
          teamedBodies.push({ id: r.id, team, x: r.position.x, y: r.position.y, z: r.position.z, aura: hasAura(r.id), group: groupSizeFor(r.id) });
        }
      }
      const myTeam = teamOf(net.id);
      if (myTeam !== TEAM.NONE) {
        teamedBodies.push({
          id: net.id, team: myTeam, x: player.position.x, y: player.position.y, z: player.position.z,
          aura: hasAura(net.id), group: groupSizeFor(net.id),
        });
      }
    }

    // The rings. An aura ring is drawn **only while a teammate is inside it**
    // -- the brief's condition, and the thing that stops a brawl becoming a
    // field of overlapping circles: within twelve metres of a fight everybody
    // is in somebody's aura, so an unconditional ring would say nothing. The
    // neighbour test is O(n^2) over at most sixteen bodies, which is 256
    // distance checks a frame and is not worth a spatial hash.
    teamRings.begin();
    for (const b of teamedBodies) {
      if (!b.aura && b.group === 0) continue;
      let mates = 0;
      let close = 0;
      for (const o of teamedBodies) {
        if (o.id === b.id || o.team !== b.team) continue;
        const dx = o.x - b.x;
        const dz = o.z - b.z;
        const d2 = dx * dx + dz * dz;
        if (d2 <= AURA_RING_M * AURA_RING_M) close++;
        if (d2 <= GROUP_RING_M * GROUP_RING_M) mates++;
      }
      if (b.aura && close > 0) teamRings.addAura(b.x, characterGround(b.x, b.z), b.z, b.team, seconds);
      if (b.group > 0 && mates >= b.group) teamRings.addGroup(b.x, characterGround(b.x, b.z), b.z, b.team, seconds);
    }
    for (let i = liveSlams.length - 1; i >= 0; i--) {
      const s = liveSlams[i];
      const age = (nowMs - s.atMs) / 1000;
      // WORKSTREAM Y: a car bomb's ring is a shade slower than a mega's, so the
      // sweep asks the record which clock it is on. See `carfire.BOOM_RING_S`.
      if (age > (s.boom ? BOOM_RING_S : SLAM_SECONDS)) {
        liveSlams.splice(i, 1);
        continue;
      }
      if (s.boom) teamRings.addBoom(s.x, s.y, s.z, age);
      else teamRings.addSlam(s.x, s.y, s.z, s.team, age);
    }
    teamRings.end();

    // The tents. Swept here rather than in `TentSet`, which is deliberately
    // declarative -- it stands what it is given and takes down the rest, and
    // owning the list here is what makes a reconnect drop every tent rather
    // than leaving one standing in a car park forever.
    for (let i = liveTents.length - 1; i >= 0; i--) if (liveTents[i].untilMs <= nowMs) liveTents.splice(i, 1);
    tents.set(liveTents, nowMs, characterGround);
  }

  /**
   * `MSG.TEAM_EVENT` arrived: a tent went up, or somebody slammed.
   *
   * The gameplay workstream emits these and this end only draws them, which is
   * why nothing here decides anything -- an event is filed and swept by its own
   * `untilMs`. A tent at a place a tent is already standing replaces it rather
   * than stacking, because a mega is once per in-game day and two records for
   * one gazebo is a z-fight.
   */
  function dropRemoteHorns(id: number): void {
    remoteHorns.get(id)?.dispose();
    remoteHorns.delete(id);
  }

  function onTeamEvent(kind: number, x: number, y: number, z: number, untilMs: number): void {
    if (kind === TEAM_EVENT_KIND.TENT) {
      const near = liveTents.findIndex((t) => Math.abs(t.x - x) < 1 && Math.abs(t.z - z) < 1);
      if (near >= 0) liveTents[near] = { x, y, z, untilMs };
      else liveTents.push({ x, y, z, untilMs });
      return;
    }
    // --- WORKSTREAM Y: a car went off. The ring, and the boom.
    //
    // Filed on the slam list rather than on one of its own, which is the whole
    // reason the brief said to reuse `slamRing`: a shockwave is a shockwave, the
    // list is already swept by its own age, and `TeamRingField.addBoom` is the
    // one thing that differs -- a wider, slower, orange ring instead of a
    // team-coloured one. `boom: true` is how the sweep tells the two apart, and
    // it is a flag on the record rather than a second list because the sweeping,
    // the expiring and the drawing are otherwise identical.
    if (kind === TEAM_EVENT_KIND.CARBOOM) {
      liveSlams.push({ x, y, z, team: TEAM.NONE, atMs: untilMs - BOOM_RING_S * 1000, boom: true });
      // The sound, **here rather than in the sweep**, because it is an event and
      // the ring is a state: a boom re-triggered every frame the ring is up
      // would be half a second of continuous explosion. The distance and the
      // delayed report are `audio.carBoom`'s own -- see it, and `polairReport`
      // next door, for why a sound that arrives late from far away is the read.
      const dx = x - player.position.x;
      const dy = y - (player.position.y - EYE_HEIGHT);
      const dz = z - player.position.z;
      audio.carBoom(Math.sqrt(dx * dx + dy * dy + dz * dz));
      // WORKSTREAM fire-look: the mark on the road and the chunks off the car,
      // filed on the same event and for the same reason the sound is here rather
      // than in the sweep -- they are one thing that happened, and `CarSmoke`
      // ages them from there. The **client's own ground** rather than the wire's
      // decimetre `y`, on `TentSet.set`'s argument one branch up: a scorch 5 cm
      // under the road is a scorch nobody ever sees.
      carSmoke.boom(x, characterGround(x, z), z);
      return;
    }
    // A slam's `untilMs` is the instant the ring finishes, so the moment it
    // *started* is that less the ring's own duration -- which keeps the wire's
    // one time field meaning the same thing for both kinds.
    // **Neutral rather than the caster's colour**, and it is a wire decision
    // rather than a taste one: the twenty-byte record carries a place and an
    // expiry and no owner, so colouring the ring teal would be this end guessing
    // -- and guessing wrong half the time, because both teams have a mega that
    // slams (`Newtown Standoff` and `Cronulla Line`). A grey shockwave is also
    // the honest read: it is a hit landing, not a buff holding, and every other
    // team-coloured thing in this feature is the second sort.
    liveSlams.push({ x, y, z, team: TEAM.NONE, atMs: untilMs - SLAM_SECONDS * 1000 });
  }
  // --- end WORKSTREAM X ------------------------------------------------------

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
  /** Which planned bikes have been placed offline, so a tile is not re-tried forever. */
  const bikePlaced = new Set<number>();
  /** Planned bikes still waiting on their tile's collision and terrain, by tile key. */
  const bikeWaiting = new Map<string, BikePlanEntry[]>();
  /**
   * The next offline bike id. A running counter across hex manifests, because
   * `bikePlan` numbers from 1 within whatever list it is handed and a segmented
   * world hands it one hexagon at a time -- see `bikePlan`'s `firstId`.
   */
  let bikeNextId = 1;
  const planBikes = (tiles: typeof index.tiles): void => {
    for (const plan of bikePlan(tiles, bikeNextId)) {
      bikeNextId = plan.id + 1;
      const list = bikeWaiting.get(plan.tileKey);
      if (list) list.push(plan);
      else bikeWaiting.set(plan.tileKey, [plan]);
    }
  };
  // One source or the other, never both: `onHexTiles` replays the manifests
  // that have already landed, so a segmented world that also planned from
  // `index.tiles` here would plan the spawn's own hexes twice and stand two
  // bikes on every planned spot. `bikePlan` is a per-tile hash with no
  // cross-tile state -- see `game/bikes.ts` -- so planning one hexagon at a
  // time produces exactly the plan a whole-world pass would have, tile for tile.
  if (hexesArmed()) {
    onHexTiles((manifest) => planBikes(manifest.tiles as unknown as typeof index.tiles));
  } else {
    planBikes(index.tiles);
  }
  /**
   * How many bikes the offline plan holds. A function rather than a length,
   * because on a segmented world the plan grows as the map does and a number
   * read once at boot would say "115" for the rest of the session.
   */
  const bikePlannedCount = (): number => {
    let n = 0;
    for (const list of bikeWaiting.values()) n += list.length;
    return n + bikePlaced.size;
  };
  /**
   * The ground a bike is placed against, offline.
   *
   * `clear` uses the **player's** radius and the controller's step height,
   * exactly as `server/sim.ts` does and for the same reason: any spot that
   * admits a bike has to admit the person walking over to fetch it, and a kerb
   * is not an obstacle.
   */
  const bikeGround: BikeGround = {
    groundHeight: (x, z) => rawGroundAt(x, z),
    clear: (x, z, y) => !collision.resolve(x, z, x, z, PLAYER_RADIUS, y + 0.42).hit,
    waterSurface: (x, z) => waterLevels.surfaceAt(x, z),
  };
  /** Whichever field is authoritative right now. See the block above. */
  const bikeWorld = (): BikeField => (net ? net.bikes : localBikes);

  // --- Workstream B: the cars. `bikeWorld` above is the pattern for all of it.
  /** The offline authority. Unused while a server is answering; see `carWorld`. */
  const localCars = new CarField();
  const carWorld = (): CarField => (net ? net.cars : localCars);
  /** Where `driving.shapeDriveSteering` writes. One object, reused every frame. */
  const driveSteering: DriveSteering = { right: 0, yawDelta: 0 };
  /** Scratch for `resolveTake`, so a prompt asked sixty times a second allocates nothing. */
  const takeScratch = createDrivingScratch();
  /** Whether there is a car within reach this frame. Recomputed, never stored. */
  let takeableNear = false;
  /** `CarField.follow`'s input, offline only. `riderViews`' twin. */
  const driverViews: DriverView[] = [];
  /**
   * Where a driver's body is on screen, for `DrivenCarView`. See its header:
   * the local player from the *predicted* position so the car moves on the frame
   * the input does, and a remote from their *interpolated* one so the car and
   * the body in it are on the same 100 ms clock.
   */
  const drivenCars = new DrivenCarView(carWorld, (driverId: number, out: DriverPose): boolean => {
    // `-1` is the view's way of saying "this is the car *you* are in" without
    // going through an id -- see `DrivenCarView`'s `localCar`. Offline the local
    // combatant id is 0, which is also the field's empty sentinel, so an id
    // comparison alone cannot answer this.
    if (driverId === -1 || driverId === playerCombat.id) {
      out.x = player.position.x;
      out.y = player.position.y - EYE_HEIGHT;
      out.z = player.position.z;
      out.yaw = player.yaw;
      return true;
    }
    const remote = net?.remotes.get(driverId);
    if (!remote || remote.fresh) return false;
    out.x = remote.position.x;
    out.y = remote.position.y - EYE_HEIGHT;
    out.z = remote.position.z;
    out.yaw = remote.yaw;
    return true;
  }, () => playerCombat.drivingCar, (x, z) => {
    // --- Workstream H: the range gate. See `DrivenCarView`'s `near`.
    //
    // Cars stopped despawning, so the field now holds up to
    // `driving.MAX_DRIVEN_CARS` records spread over sixty kilometres of Sydney
    // rather than the two or three a five-minute clock allowed -- and this loop
    // runs twice a frame. The radius is `TRAFFIC_DRAW_RADIUS` with slack, so a
    // driven car is gated on exactly the terms the ambient fleet around it is.
    const dx = x - player.position.x;
    const dz = z - player.position.z;
    return dx * dx + dz * dz < DRIVEN_DRAW_RADIUS * DRIVEN_DRAW_RADIUS;
  });
  /** Is this remote at the wheel? The parked-bike draw consults it -- see below. */
  const isDriving = (id: number): boolean => carWorld().carOf(id) !== 0;
  // --- Workstream H: crash damage, cars that stay, and the traffic behind them.
  // One contiguous block, on the preamble's rule; every line of logic is in
  // `game/driving.ts`, `game/traffic.ts` (the hold) and `world/carsmoke.ts`.
  /**
   * How far a driven car is posed from, metres.
   *
   * `world/cars.TRAFFIC_DRAW_RADIUS` plus a margin, because the gate is applied
   * to the *record's* stored position and an occupied car's record is as stale
   * as the last `MSG.CARS` -- a driver doing 22 m/s covers 22 m in the second
   * between two broadcasts of a car nobody has touched.
   */
  const DRIVEN_DRAW_RADIUS = 460;
  /** The plume off every smoking bonnet in view. One draw call. */
  const carSmoke = new CarSmoke();
  scene.add(carSmoke.mesh);
  // WORKSTREAM Y: and the additive tongues off a burning bonnet, which are a
  // second set for the reason `world/carsmoke.ts`' header gives -- a flame is
  // light and smoke is the absence of it, and no one material is both.
  scene.add(carSmoke.flames);
  // WORKSTREAM fire-look: and the third set, which is what a car leaves behind
  // once it has gone off -- the scorch on the road and the chunks in the air,
  // one pool and one draw call for both. Swept by the same `begin`/`end` bracket
  // `drivenCars.update` already runs on this object every frame, so the only
  // other line this feature costs `main.ts` is the `boom` in `onTeamEvent`.
  scene.add(carSmoke.marks);
  /** Whether a car has honked at the player for standing in the road. */
  const honkWatch = new HonkWatch();
  /** Scratch for it, so a query asked sixty times a second allocates nothing. */
  const honkScratch = createDrivingScratch();
  /**
   * The blocker roster the ambient traffic yields to, rebuilt in place each
   * frame. `server/sim.publishBlockers` is the identical sweep -- see
   * `traffic.HoldLedger` for why both ends run it from the same `CarField`.
   */
  const carBlockers: Array<{ x: number; y: number; z: number; halfLength: number }> = [];
  /** Scratch for the bay snap when the offline player gets out. `sim.bayProbe`'s twin. */
  const carBayProbe = createBayPose();
  /**
   * The car health the last frame drew, so the write-off notice fires on the
   * *edge* rather than on the level.
   *
   * `world/drivencars.takePrompt`'s header is the argument for deriving state
   * rather than setting it, and this is the one case that genuinely is an event:
   * "you wrote it off" is a thing that happened once, not a thing that is true.
   * An edge on a number the server owns is the cheapest honest way to say so.
   */
  let lastCarHealth = CAR_HEALTH_MAX;
  /**
   * --- WORKSTREAM Y: whether the car the player is in was alight last frame.
   *
   * `lastCarHealth`'s twin and for its argument exactly: "it caught fire" is a
   * thing that happens once, so the notice fires on the edge. Read again by the
   * vitals block below, which is why it is a variable rather than a local.
   */
  let carWasBurning = false;
  /** Scratch for the fire's grading. Asked once a frame; never allocated. */
  const localFire = createFireGrade();
  /**
   * When the burning car last crackled, and how often it may.
   *
   * A quarter of a second, so a six-second fuse is about two dozen bursts --
   * dense enough to read as a continuous fire and sparse enough that each one is
   * audibly louder than the last, which is the whole point of ramping it. See
   * the call site, and `carfire.fireGrade`'s `crackle`.
   */
  let lastCrackleMs = 0;
  const CRACKLE_EVERY_MS = 250;
  // And the four properties that are the whole of drawing a driven car: through
  // the loop that already draws every other car in Sydney, at the same LOD, in
  // the same material, with the same headlights. `world/drivencars.ts`' header
  // is why this is four lines and not a renderer. Here rather than beside the
  // fleet's own `lights`/`models` because `drivenCars` is declared here, and it
  // is declared here because it needs `player` and `net`.
  trafficMovers.suppress = drivenCars.suppress;
  // --- Workstream Q: a car somebody has taken is not standing in the road, so
  // the traffic must not steer round where it used to be either.
  traffic.obstacles.suppress = drivenCars.suppress;
  trafficMovers.driven = drivenCars.source;
  if (carModels) {
    carModels.suppress = drivenCars.suppress;
    carModels.drivenClaims = drivenCars.claims;
    // --- WORKSTREAM S: every driven record, ungated, so the *box* of a stolen
    // parked car is folded flat wherever it is. `drivenClaims` above is range
    // gated and cannot serve; see `carlod.CarModelFleet.drivenIdentities`.
    carModels.drivenIdentities = (visit) => {
      for (const car of carWorld().all()) visit(car.carId);
    };
  }
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
    // WORKSTREAM X: and their horns, which are parented to a bone of a mesh that
    // is about to leave the scene. Removing the body would leave the prop
    // attached to an orphan rather than leaking it, but the `Map` entry would
    // outlive the player and be handed to whoever next took that id.
    dropRemoteHorns(id);
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
  const joinChoice = await joinPromise;
  const playerName = joinChoice.name;
  // Stored whether it was typed or came off an account, because it is what the
  // *next* boot prefills and what a sign-up offers as the guest name to migrate.
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
    // The token rides beside the name on the hello, and `markJoined` is what
    // tells the gates whether this *session* is bound to an account -- signing
    // up later does not rebind a live socket. See `client/src/accounts.ts`.
    const client = new NetClient(joinUrl, netHandlers(), {
      name: playerName,
      clientId: clientId(),
      token: joinChoice.token,
    });
    // WORKSTREAM N (carry): the second argument tells a mid-game sign-up which
    // body to carry the level and the location off. A closure rather than the
    // two numbers, because the `WELCOME` that assigns them has not arrived on
    // this line -- see `accounts.SessionSource`.
    joinGate.markJoined(joinChoice.token, () => ({ playerId: client.id, room: client.room }));
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
    // **This timeout is a backstop, not the common path.** `onSettled` fires as
    // soon as the socket resolves *either way* -- a refused connection errors in
    // milliseconds and resolves `false` -- so the only thing waiting here costs
    // is a server that accepts a TCP connection and then says nothing, which is
    // a black hole rather than an absent host.
    //
    // It was 1.5 s, sized against the comment above it: a host "on this machine
    // (about a millisecond), or on the LAN (a few)". That stopped being the
    // deployment the day this went to a VPS in Sydney behind TLS, and it broke
    // in production on 2026-08-08: measured from a Mac on a home connection,
    // the socket opens at 306 ms and the WELCOME lands at 699 ms, and the boot
    // pass that compiles the world's pipelines (see `world/warmup.ts`) puts
    // enough work on the main thread that the callback resolving this promise
    // can miss a 1.5 s window it used to clear. The server logged the player
    // joining and the *client* hanging up one second later, having already
    // decided nobody was home.
    //
    // 8 s is chosen against the failure it is actually for. It is never paid by
    // an online player (they settle at ~0.7 s) nor by an offline one (a refused
    // connection settles immediately); it is paid only by someone whose network
    // swallows packets silently, and for them a few seconds of loading beats
    // being told the game has no server when it has one.
    const CONNECT_DEADLINE_MS = 8000;
    const settled = await Promise.race([
      new Promise<boolean>((resolve) => {
        client.onSettled = () => resolve(client.status === 'online');
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), CONNECT_DEADLINE_MS)),
    ]);
    if (settled) {
      net = client;
      // The talent hooks predict off the same `TeamField` the server folds --
      // the client's copy is refilled from the TALENTS mirror once a frame.
      // Offline there is no team and the hooks keep reading `NO_TEAMS`.
      setTeamLookup(client.teams);
      // The timetable, so remote riders are composed rather than interpolated.
      // Handed over rather than fetched again: it is the same 1 MB the renderer
      // already holds, and two decodes would be two objects that could disagree
      // about which train is which. See `net/client.placeRiders`.
      client.setRail(railBake);
      // The server chose where this player stands, so the local prediction has
      // to start there rather than at the client's own draw. Both ends compute
      // the same disc centre from the same `index.json` (see `game/spawn.ts`),
      // but the dither inside it is drawn per join and the server's draw is the
      // one that counts -- a client that kept its own would spend its first
      // snapshot being corrected across a hundred metres of park.
      /* **The host's clock, adopted before anything is drawn.** Protocol v11.
       *
       * Outside the `if (w)` below because it is not about the spawn: a welcome
       * that somehow carried no position still carries a clock, and the sky is
       * on screen either way. `clockSkew` is `serverNow - localNow`, so a
       * machine whose own clock is right gets a number in the tens of
       * milliseconds and one that is four minutes fast gets -240,000 -- which
       * used to be four minutes of private evening nobody could see.
       *
       * Here rather than in the frame loop, and once rather than every frame:
       * the skew is a difference between two running clocks and stays correct
       * for the session. See `net/client.clockSkewMs`. */
      sky.setServerClock(client.clockSkew);
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

  // --- `?heat=N`: start offline at N stars. **Offline only, by construction.**
  //
  // The ladder is a five-rung feature whose top two rungs take ninety seconds
  // each to reach honestly, and every one of them puts something different in
  // the world -- a car, a roadblock, a helicopter. A screenshot of the 4-star
  // RBT that had to be earned by knocking out two officers and then surviving
  // ninety seconds is a screenshot nobody takes twice, which means the rung
  // stops being checked.
  //
  // The gate is `!online` and it is a gate rather than a warning: `HeatField` is
  // the same class the server runs, so a `debugSet` reachable in a session would
  // be a client setting its own star count -- and the answer to that in this
  // project is always the same, which is that the authority decides. Online the
  // param is read and ignored, and the notice says so rather than doing nothing
  // silently.
  {
    const asked = new URLSearchParams(location.search).get('heat');
    if (asked !== null) {
      const want = Math.max(0, Math.min(HEAT_MAX, Math.round(Number(asked) || 0)));
      if (online) hud.notice('?heat is offline-only — the server decides how wanted you are');
      else if (want > 0) {
        // **The banner first, then the stars.** A star count with no
        // investigation behind it would be half the interface: the 1-star rung
        // *is* the banner and every rung above it keeps it, so a debug aid that
        // set one without the other would be showing a state the game cannot
        // actually be in. `predictInvestigation` offline is `factions.accuse`,
        // which fires the crime funnel and banks its own points -- so the
        // `debugSet` has to come second, where it overwrites them.
        predictInvestigation(REASON.ASSAULT);
        heat.debugSet(playerCombat.id, want, trafficTick(Date.now()));
        hud.notice(`?heat=${want} — ${want} star${want === 1 ? '' : 's'}`);
      }
    }
  }

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

  // WORKSTREAM N (carry): *"logging off should save my location till next log
  // in"*, said out loud. Here rather than beside the welcome eight hundred lines
  // up, because the sentence wants the suburb and the suburb wants the atlas
  // that was fetched on the line above -- `installRestoredNotice` waits for it,
  // briefly, and says the sentence without it rather than not at all. It returns
  // immediately unless this join actually restored a spot, which is every guest
  // and every ordinary login. See `game/carry.ts`.
  installRestoredNotice({
    restored: () => net?.welcome?.restored === true,
    suburb: () => locator.stats().suburb ?? '',
    notice: (message) => hud.notice(message),
  });

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
      // WORKSTREAM X: in their team's colour where they have one, and in the
      // combatant red where they do not. `teamMarkerKind` is the whole of the
      // decision and both maps read one shared `markerInk` switch, so the dot on
      // the compass and the dot on the big map cannot disagree.
      sink.mark(r.position.x, r.position.z, teamMarkerKind(teamOf(r.id)), r.yaw);
    }
  });

  /**
   * The raves you have heard, as a third source.
   *
   * ---------------------------------------------------------------------------
   * **NOT A QUEST ARROW, AND THE DIFFERENCE IS ONE `Set`.**
   *
   * The brief was explicit -- *"maybe a marker on the big map once you have
   * heard it. Do not make it a quest arrow; make it findable the way a real one
   * is."* -- and there is exactly one line in this build that decides which of
   * those it is: `heardRaves` only ever gains a site when the player has been
   * inside `RAVE_AUDIBLE_RANGE` of it with the music on.
   *
   * So the map never tells you where a rave is. It remembers where one *was*,
   * which is the difference between a waypoint and knowing the city -- and it is
   * how you actually find out about one of these, which is that somebody who was
   * there tells you afterwards.
   *
   * The set is cleared when the night index changes, because a rave is one
   * night's event and a marker for last night's is a lie about tonight. That
   * clearing happens in the frame loop beside the rave update, where the night
   * index is already in hand.
   */
  minimap.addMarkerSource((sink) => {
    if (heardRaves.size === 0) return;
    for (const venue of liveRaves(raveNight(sky.now.nowMs).index)) {
      if (!heardRaves.has(venue.site.id)) continue;
      sink.mark(venue.site.x, venue.site.z, 'rave');
    }
  });

  /**
   * Workstream E: the ambient events, on both maps out of one source.
   *
   * `EventScene.live` rather than a fresh `liveEventsAt` call, and the reason is
   * the one `MarkerSource`'s own header gives about allocation: the scene
   * already resolves the live set once a frame against the draw radius, and a
   * second sweep here would be a second `eventsAt` over a 300 m box at 15 Hz
   * forever. The consequence is stated rather than hidden -- **the markers reach
   * exactly as far as the renderer does**, which is `EVENT_DRAW_RADIUS`, so the
   * minimap's 250 m brief is satisfied and the big map shows only what is within
   * 150 m rather than the whole city's schedule.
   *
   * That is a deliberate narrowing of the brief and it is the better behaviour:
   * a big map listing every event in Greater Sydney would be a quest log, and
   * `minimap.RAVE_DOT`'s header already argues that case for the raves -- a map
   * that shows you what is out there is a quest list, and one that shows you
   * what you are near is a map.
   *
   * The **label** is only read by the big map; the compass drops it. See
   * `minimap.Marker.label`.
   */
  minimap.addMarkerSource((sink) => {
    for (const site of eventScene.live) {
      sink.mark(site.x, site.z, 'event', undefined, EVENT_NAME[site.kind] ?? 'something');
    }
  });

  /**
   * --- WORKSTREAM Z: the two talent map layers, as one more source.
   *
   * `Toll Dodger`'s roadblocks and `Neighbourhood Watch`'s through-wall enemies.
   * Both are gated on a talent the *local* player has, which is why they are one
   * source and not two: the gate is the same question asked of the same id, and
   * a second registration would be a second place to get "whose map is this"
   * wrong. Both draw nothing at all -- one flag read and one scalar read -- for
   * everybody who has not bought them, which is everybody below level 6.
   *
   * The RBTs come off the promoted-actor list rather than the heat field; see
   * `game/talentlive.markRbts` for why that is the only source that exists on
   * both ends. The enemies come off `net.remotes`, which is the same list the
   * ordinary team dots two sources up are drawn from -- so a player who is
   * *already* on the map inside the compass's 160 m gets a solid dot from there
   * and a hollow one from here, and the hollow one under the solid one is
   * invisible. That overlap is deliberate: the layer's whole value is the
   * enemies you cannot see, and adding a "is this one visible" test would mean
   * asking the renderer a question the map has no business asking.
   */
  minimap.addMarkerSource((sink) => {
    const me = net ? net.id : LOCAL_ID;
    markRbts(sink, policeField().actors, rbtMarkersOn(me));
    const range = enemyMarkerRangeM(me);
    if (range <= 0 || !net) return;
    const mine = teamOf(me);
    const range2 = range * range;
    for (const r of net.remotes.values()) {
      const kind = enemyMarkerKind(mine, teamOf(r.id));
      if (kind === '') continue;
      const dx = r.position.x - player.position.x;
      const dz = r.position.z - player.position.z;
      if (dx * dx + dz * dz > range2) continue;
      sink.mark(r.position.x, r.position.z, kind);
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
   * How far back the player has asked the camera to sit, in metres. 0 is first
   * person.
   *
   * A *preference*, not a state: riding raises a floor under it and dismounting
   * returns to exactly this number, because nothing but the wheel and `V` ever
   * writes it. That is the property the boolean this replaced kept getting wrong
   * -- a bike that wrote the preference left the player in a camera they never
   * asked for -- and it is now `liveCameraDistance`'s single `Math.max` rather
   * than a rule anybody has to remember.
   *
   * It is also not `chaseDistance`, which is further down and is the *actual*
   * boom after the occlusion pull-in has had its say. That separation is what
   * lets a player back into a terrace, watch the camera duck in to 1 m, and step
   * out again to the 9.6 m they chose. See `game/camera.ts`.
   *
   * Restored from `localStorage`, so the camera you played in last night is the
   * camera you get tonight. Defaults to first person on a fresh browser: spec 1
   * is a first-person game and a build that booted into a chase camera would be
   * a different game by default.
   */
  let cameraDistance = loadCameraDistance();
  /**
   * The third-person distance `V` goes back to.
   *
   * Separate from `cameraDistance` because that one is zero in first person and
   * a toggle needs somewhere to have come *from*. Seeded from storage as well,
   * so the first `V` of a session returns to last night's boom rather than to
   * the default.
   */
  let lastThirdDistance = cameraDistance;
  /** What the camera is actually doing this frame. Riding floors it at `RIDE_MIN`. */
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

  // --- Money, the phone and the weapon slots. See `client/src/money.ts`.
  //
  // Here rather than earlier because every accessor below has to be in scope:
  // `self` is the shadow-layer body the handset parents to, `thirdPerson` is
  // what decides whether the viewmodel or the prop is the one you see, and
  // `minimap` is the seam both maps read their markers through.
  const money = installMoney({
    hud,
    camera,
    scene,
    selfActor: self,
    net: () => net,
    position: () => player.position,
    angles: () => ({ yaw: player.yaw, pitch: player.pitch }),
    speed: () => Math.sqrt(player.velocity.x * player.velocity.x + player.velocity.z * player.velocity.z),
    firstPerson: () => !thirdPerson,
    riding: () => playerCombat.ridingBike !== 0,
    // --- Both maps and the camera. See `client/src/game/phone.ts`.
    //
    // The `KeyM` block that used to sit in the keydown listener below is gone:
    // the key equips the phone and opens its Map app now, which is a decision
    // about the *hands* and therefore `money.ts`'s. What is left here is the
    // three lines that key needs -- open, close, and is it up -- plus the panel
    // housekeeping the old block did, which is unchanged and is still this
    // file's business because `hud` and `suggestions` are.
    openMap: () => {
      if (!bigmap.visible) bigmap.toggle();
      hud.setHelp(false);
      hud.setLeaderboard(false);
      suggestions.close();
    },
    // --- Workstream V. The phone's seventh tile, on the Map tile's terms
    // exactly: the panel is full-screen, so the handset goes away and the same
    // panel housekeeping runs. `TalentsPanel.show` is the one place that refuses
    // it for a guest and offline.
    openTalents: () => {
      hud.setHelp(false);
      hud.setLeaderboard(false);
      bigmap.close();
      suggestions.close();
      talents.show();
    },
    closeMap: () => bigmap.close(),
    mapVisible: () => bigmap.visible,
    setMinimapScale: (scale) => minimap.setScale(scale),
    minimapCanvas: () => minimap.canvas,
    // The bug box's frame grabber, which is the only thing in this client that
    // can read the WebGPU canvas -- see `client/src/photo.ts`.
    capture: () => grabber.request(),
    suburb: () => locator.stats().suburb ?? '',
    clockMs: () => sky.now.nowMs,
    shareToBugBox: (dataUrl, note) => {
      suggestions.open();
      suggestions.showTab('bug');
      bug.attachImage(dataUrl, note);
    },
    shutter: () => audio.shutter(),
    // Only the viewfinder asks, and only from the click on the Camera tile --
    // which is the user gesture a browser requires. See `Phone.setCamera`.
    lockPointer: () => {
      if (!locked) void canvas.requestPointerLock();
    },
    addMarkerSource: (source) => minimap.addMarkerSource(source),
    // Which weapon viewmodels the slots want drawn this frame.
    //
    // Handed in as a setter rather than read back out, because the block above
    // that owns `setVisibleToCamera` only runs on a **camera-mode change** --
    // so a predicate consulted there would follow the third-person toggle and
    // not the number row, and the bat would stay in frame beside a raised
    // phone until you pressed `V`. This runs every frame from `money.frame`,
    // after that block, and `thirdPerson` is still the outer authority.
    setWeaponVisible: (bat, footy) => {
      setVisibleToCamera(viewmodel.mesh, !thirdPerson && bat);
      setVisibleToCamera(footyViewmodel.mesh, !thirdPerson && footy);
      // --- Workstream I: the hands, and the bat on your own body.
      //
      // **Hands when the primary slot is fists**, which is not the same as "no
      // bat": the phone also says no bat, and a pair of fists floating beside a
      // raised handset is the failure `verifyHands` names. Read off
      // `money.hands` rather than derived from the two flags for exactly that
      // reason -- see `MoneyHooks.showsBat`, whose comment says the two
      // predicates deliberately do not enumerate the slots.
      //
      // The off hand goes with the primary one. A one-handed pose (phone up,
      // fist ready) would be a fifth key set and is not what was asked for.
      const fists = money.hands.primary === SLOT.FISTS;
      setVisibleToCamera(handsViewmodel.primary, !thirdPerson && fists);
      setVisibleToCamera(handsViewmodel.off, !thirdPerson && fists);
      // And in **third** person a fists player must not still be swinging a
      // bat. `selfBat` is a `BatProp` on your own body's wrist and there is no
      // stowed position for it -- see `BatProp`, which deliberately has no
      // `set()` because spec 8.2's melee was always the bat. It is now not, so
      // the prop is hidden on the same predicate the viewmodel uses.
      //
      // `visible` rather than the layer here, and the difference matters: the
      // camera-mode block below owns `selfBat`'s *layer* and would fight a
      // second writer, exactly as `BatViewmodel`'s own comment warns about. The
      // two compose -- the layer says "third person", this says "holding it".
      //
      // **Remote players are untouched and will still show a bat.** Slot state
      // is not on the wire (`protocol.RosterEntry` carries no hands), so this
      // client cannot know what anybody else has equipped; a remote on fists
      // draws a bat and will until a slot byte joins the roster. Stated rather
      // than hidden, on the brief's instruction.
      selfBat.mesh.visible = !fists;
    },
  });

  // --- Riding a train ----------------------------------------------------------
  //
  // The client's half of `game/riding.ts`: predict the boarding, step the body
  // inside the carriage, keep the camera in there with it, and say where you are
  // going. Everything authoritative is the server's -- see `sim.tryBoard` -- and
  // everything here is a prediction that the very next snapshot can overrule.

  /** The carriage the local body is stepped inside. Aimed once a tick, at most. */
  const carriageStand = createCarriageStand();
  /** The frame of that carriage this tick, and whether it is live. */
  const rideFrame = createCarFrame();
  let rideActive = false;
  const boardOffer = createBoardOffer();
  const rideLanding = { x: 0, y: 0, z: 0 };
  /** Carriage-local velocity, handed to `net.sendInput`. One vector, reused. */
  const rideVelocity = new Vector3();
  const rideLocal = { x: 0, y: 0, z: 0 };
  const rideText = createRideBanner();
  /**
   * What the trains are announcing this frame. One record, reused.
   *
   * Reused rather than returned for the reason every other per-frame struct in
   * this file is: `railAnnounceMix` runs at 60 Hz over the whole timetable and a
   * fresh object a frame is 3,600 allocations a minute for two booleans and a
   * float. It carries no state between frames -- every field is overwritten
   * before it is read -- which is what lets the schedule stay a pure function of
   * the clock while the buffer it is written into is not.
   */
  const railAnnounce = createRailAnnounceMix();
  /** Where `sydney.rail.goto` puts you. One record, reused. */
  const railStand: Stand = { x: 0, y: 0, z: 0, yaw: 0 };
  /**
   * Whether the body was on a train at the end of the last fixed step, and which
   * way the carriage was pointing.
   *
   * **`input.yaw` changes meaning when you step aboard**, and this pair is what
   * converts it at the seam. Off a train it is the world heading; on one it is
   * the heading *in the carriage's frame*, which is what makes the view turn with
   * the train through a curve instead of the player's shoulders swinging round
   * the vestibule. `controller.step` copies it straight into `body.yaw`, so the
   * conversion has to happen to `input.yaw` itself and it has to happen exactly
   * once per transition.
   *
   * Driven off the *state* rather than off the two places that change it, for
   * `bikes.ridePrompt`'s reason: the ride can also start or end because the
   * server said so (`net.adoptRide`), because the train reached its terminus, or
   * because a respawn moved the body -- and a conversion attached to the `E`
   * handler would miss all three and leave the view rotated by the bearing of a
   * train that is no longer there.
   */
  let wasAboard = false;
  let lastRideYaw = 0;

  /**
   * The nearest open doorway right now, or none. Recomputed per tick.
   *
   * Held rather than recomputed for the HUD, because `findBoarding` walks the
   * live trips of every direction whose bounding box the player is inside and
   * the prompt wants the same answer the `E` key would get. It is dead code
   * except within 100 m of a train that is standing at a platform.
   */
  let boardable = false;
  /**
   * The carriage the camera boom must stay inside this frame, or null.
   *
   * Set once a frame beside the composition that refreshes `rideFrame`, and read
   * by the chase camera's `blockedAt` a hundred lines down. A field rather than a
   * parameter because `blockedAt` is a closure the camera march owns and its
   * signature is `(d) => boolean` by contract -- see `game/camera.marchCameraBoom`.
   */
  let rideAboardForCamera: CarriageInterior | null = null;

  /**
   * Step aboard, if the client's own copy of the timetable says there is a door.
   *
   * The prediction half of `sim.tryBoard`, running the identical `findBoarding`
   * against the identical bake at the identical instant -- so it is right
   * essentially always, and when it is not the next snapshot puts the player back
   * on the platform. It is the bike's bargain: the ride starts on the frame the
   * key goes down rather than on the next round trip.
   */
  const predictBoard = (): boolean => {
    if (!railBake) return false;
    const t = railSeconds(Date.now());
    // The sequence itself is `riding.boardHere` -- the same function
    // `server/sim.tryBoard` runs against its own body and its own clock, and the
    // same one the online check drives. Everything left here is the notice and
    // the chime.
    if (!boardHere(railBake, playerCombat.aboard, player, t, rideFrame, boardOffer, EYE_HEIGHT)) {
      return false;
    }
    net?.predictedAboardChange();
    audio.pickupFlatWhite();
    hud.notice(
      boardOffer.station
        ? `aboard at ${boardOffer.station} — E to get off`
        : 'aboard — E to get off',
    );
    return true;
  };

  /**
   * Step off, by whichever of the three doors this is. `sim.alight`'s prediction.
   *
   * The same three branches in the same order and against the same helpers, so
   * that the position the client draws is the position the server is about to
   * send: at a dwell, onto the platform; in a tunnel, to the next station, framed
   * as being dragged out by staff; otherwise out the side at speed, which hurts.
   *
   * The damage is applied here **only offline**. Online it is the server's -- the
   * next snapshot overwrites `health` either way, and a client that took pips off
   * itself would flicker the bar for one round trip in the ordinary case and
   * double-count nothing in any case.
   */
  const predictAlight = (): void => {
    const a = playerCombat.aboard;
    net?.predictedAboardChange();
    if (!railBake) {
      clearAboard(a);
      return;
    }
    const t = railSeconds(Date.now());
    const dir = dirOf(railBake, a.line, a.dir);
    const pose = dir === null ? null : aboardPose(railBake, a, t);
    const it = dir === null ? null : interiorOfCar(consistOf(dir, a.trip), a.car);
    if (dir === null || pose === null || it === null || !aboardFrame(railBake, a, t, rideFrame)) {
      clearAboard(a);
      return;
    }
    const speed = pose.speed;
    const tunnel = (spanFlagsAt(railBake, dir, pose.s) & SPAN_TUNNEL) !== 0;
    let hurt = 0;
    if (pose.doorsOpen) {
      alightPlatform(rideFrame, it, a.x, a.z, platforms, rideLanding);
    } else if (tunnel) {
      const stop = nextCall(dir, pose.s);
      if (stop >= 0 && stopPlatform(railBake, dir, stop, a.z, rideLanding)) {
        hud.notice(`dragged out by staff at ${dir.stops[stop].name}`);
      } else {
        alightTrackside(rideFrame, it, a.x, a.z, rideLanding);
        hurt = bailoutDamage(speed);
      }
    } else {
      alightTrackside(rideFrame, it, a.x, a.z, rideLanding);
      hurt = bailoutDamage(speed);
      hud.notice(`out the side at ${Math.round(speed * 3.6)} km/h`);
    }
    player.position.set(rideLanding.x, rideLanding.y, rideLanding.z);
    if (hurt > 0) {
      // Thrown along the train's own heading rather than dropped -- the one
      // moment in this feature where the train's velocity *is* the player's is
      // the moment they stop being a passenger. `sim.alight` uses the same
      // damping for the same reason: the ragdoll's friction is written for a
      // body that was punched, and 36 m/s of tumble crosses two suburbs.
      player.velocity.set(pose.dx * speed * 0.22, 1.5, pose.dz * speed * 0.22);
      player.onGround = false;
      if (!online) applyWorldDamage(playerCombat, hurt);
    } else {
      player.velocity.set(0, 0, 0);
      player.onGround = true;
    }
    clearAboard(a);
    void ensureGround(rideLanding.x, rideLanding.z);
  };

  /**
   * Put the body into its carriage for one step, and say which world to step it
   * against. `sim.enterCarriage`, client side, argument for argument.
   */
  const enterCarriage = (): CombatWorld => {
    // `riding.rideEnter` is the sequence, shared with `server/sim.ts` and with
    // the online check. What is left here is this end's policy, and it is one
    // line: any ending at all puts the body back in the city. The trip running
    // out is a terminus offline; online the server has already put them on a
    // platform and the snapshot is on its way, so leaving the body where it is
    // for one round trip is the smaller lie.
    const a = playerCombat.aboard;
    if (!isAboard(a)) {
      rideActive = false;
      return combatWorld;
    }
    const got = rideEnter(
      railBake, a, player, railSeconds(Date.now()), rideFrame, carriageStand,
    );
    rideActive = got === RIDE_ON;
    if (rideActive) return carriageStand as unknown as CombatWorld;
    clearAboard(a);
    return combatWorld;
  };

  // --- WORKSTREAM L (trains): the gangway, at the one seam it can be at.
  //
  // `riding.rideExit` is `exitLocal` with the walk-through crossing between the
  // read and the composition -- see its header, and `sim.exitCarriage`, which is
  // this call statement for statement. What is this end's alone is the number it
  // returns: crossing the one reversed coupling in a Metro turns the carriage
  // frame through half a turn, and while aboard `input.yaw` *is* the rider's
  // carriage-local heading (see `wasAboard`), so the mouse accumulator has to
  // turn with it or a rider walking through the middle of the train comes out
  // facing the way they came.
  const exitCarriage = (): void => {
    if (!rideActive) return;
    rideActive = false;
    input.yaw += rideExit(railBake, playerCombat.aboard, player, railSeconds(Date.now()), rideFrame);
  };

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
   * Seconds until the horn can sound again.
   *
   * A cooldown rather than an edge, because `punch` is level-triggered on this
   * wire (see `protocol.BTN`) and a held left click would otherwise be sixty
   * honks a second. A third of a second is about the length of one, so leaning
   * on the button gives a repeating parp rather than a tone -- which is what a
   * horn does and is also the only thing that reads as deliberate.
   */
  let honkT = 0;
  const HONK_SECONDS = 0.34;
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
    // The phone answers whichever button its hand is on, and consumes it -- so
    // a click that opened the phone does not also arm a swing. Every other
    // slot arrangement returns false here and the two lines below are exactly
    // what they always were. See `client/src/money.ts`.
    if (money.mousedown(e.button)) return;
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
   * Ask for a camera distance, from `V` or from the wheel.
   *
   * One function because there is one preference and one place it is written,
   * which is what keeps the two bindings from disagreeing. It does three things
   * a caller must not be trusted to remember: it records the distance `V` comes
   * back to, it persists the choice, and it says something when the choice is
   * being overridden.
   *
   * The nudge is the interesting part, and it is now **conditional** where it
   * used to be unconditional. A rider has a floor under them (`RIDE_MIN`), so a
   * rider scrolling between 3.2 m and 12.8 m sees exactly what they asked for
   * and needs no explanation; only a rider asking for something *under* the
   * floor -- first person, on a bicycle -- gets a camera other than the one they
   * pressed for, and a control that silently does nothing is a control a player
   * decides is broken. It goes through the ride pill rather than `hud.notice`
   * for `simulate`'s reason: the line says "when you get off", so it is only
   * true while you are on, and the pill is derived every tick and comes down by
   * itself the moment you are not.
   */
  const setCameraDistance = (metres: number): void => {
    cameraDistance = metres;
    // Only a third-person distance is worth remembering: seeding this with zero
    // would make `V` a key that toggles first person with first person.
    if (isThirdPerson(cameraDistance)) lastThirdDistance = cameraDistance;
    saveCameraDistance(cameraDistance);
    const live = liveCameraDistance(cameraDistance, playerCombat.ridingBike !== 0);
    if (live !== cameraDistance) {
      rideNudgeText = `camera: first person when you get off — a bike needs ${live.toFixed(1)} m`;
      rideNudgeT = RIDE_NUDGE_SECONDS;
    }
  };

  /**
   * The wheel: **out for further back, in for closer**, all the way to first
   * person.
   *
   * This binding started as a two-state toggle -- down for third person, up for
   * first -- and the report that came back was *"cant zoom out anymore by
   * scrolling"*. That is the correct reading of it: every game with a chase
   * camera puts a distance on this wheel, so a wheel that stops at one fixed
   * boom is a zoom that has been taken away rather than a mode switch that has
   * been added. It now moves `cameraDistance` one notch of `game/camera.ts`'s
   * ladder per event, and `V` toggles the two ends of it. There is still only
   * one preference behind both bindings: two toggles over one camera is how it
   * ends up in a state neither control can explain.
   *
   * **Accumulated to a threshold rather than acted on per event**, because the
   * two devices that produce this event are nothing alike. A mouse notch is one
   * event of about 100 px and should move the camera one stop on the spot. A
   * trackpad produces a stream of 2-10 px events for the same physical gesture,
   * and a handler that stepped on each of them would run the boom from the eye
   * to 12.8 m during one two-finger swipe. `WHEEL_CAMERA_STEP` is a shade under
   * a notch so the mouse keeps its one-gesture-one-stop feel and the trackpad has
   * to mean it.
   *
   * Two things changed from the toggle's version of this accumulator, and both
   * are because the target is a scalar rather than a flag. A **single event
   * worth several notches steps several times**, which is what a flick of a
   * free-spinning wheel is. And **the remainder is kept when the event that
   * produced it was smaller than a step, and discarded when it was bigger**,
   * which is the one line here that had to be measured rather than reasoned:
   *
   *   - A mouse notch arrives as one event of 100-120 px against an 80 px step.
   *     Keeping the 20-40 px over would bank a whole extra step every three or
   *     four notches, so a steady scroll would go 1, 1, 1, **2**, 1, 1, 1, **2**
   *     -- which is not a rounding detail, it is a camera that lurches. Zeroing
   *     makes one notch exactly one stop for any mouse whose notch is at least
   *     the step, which is all of them.
   *   - A trackpad arrives as a stream of 2-10 px events, and zeroing *those*
   *     throws away up to a step of travel every step, which is a swipe that
   *     does about half of what the fingers did.
   *
   * The size of the event is the only thing here that tells the two devices
   * apart, and it tells them apart perfectly, because the gap between 10 px and
   * 100 px is an order of magnitude. Reversing direction still clears the tally
   * rather than unwinding it, so a player who overshoots and comes back gets the
   * stop on the gesture they make next rather than one gesture later.
   *
   * `deltaMode` is normalised because Firefox reports lines and not pixels; an
   * unnormalised threshold is a control that needs a different flick per browser.
   *
   * Passive, and it is the guards below that make that safe. The **map owns the
   * wheel while it is open** -- `bigmap.ts` binds its own non-passive listener on
   * this same window and calls `preventDefault` there -- so this one returns
   * before it counts anything rather than zooming the map and moving the camera
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
      // Down is positive `deltaY` and is the direction that pushes the view away
      // from you, which is the one every chase camera in every game zooms out on.
      // Whole notches only; what happens to the remainder is decided by the size
      // of the event that produced it -- see the header.
      const notches = Math.trunc(wheelCamera / WHEEL_CAMERA_STEP);
      wheelCamera = Math.abs(delta) >= WHEEL_CAMERA_STEP ? 0 : wheelCamera - notches * WHEEL_CAMERA_STEP;
      setCameraDistance(stepCameraDistance(cameraDistance, notches));
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
    // The number row, the phone's Escape and the Centrelink `E`. **After** the
    // `hud.typing` interlock, so none of them fires while somebody is typing,
    // and before every branch below, so the phone's Escape beats the
    // suggestions box's -- which is the ordering `money.ts`'s header is about.
    // Returns true only when it consumed the key. See `client/src/money.ts`.
    if (money.keydown(e.code, e.shiftKey, held)) return;
    /* **`F` is the torch, and what it displaced went one key along.**
     *
     * A player asked for the flashlight on `F`, which is where every game since
     * Half-Life has put it, and `F` was already the keyboard swing -- the
     * fallback for a browser that refuses pointer lock and leaves the left
     * button busy turning the camera. Of the two claims on the key the torch's
     * is much the stronger: the swing is a *fallback path* that most players
     * never take, and the torch is a control every player uses every night.
     *
     * The swing is now `K`, which is not an arbitrary free letter. Its partner
     * -- the footy throw -- has always been `L`, and the two have never been
     * near each other; `K` and `L` are adjacent under the right hand while WASD
     * is under the left, so the no-pointer-lock path finally has its two weapons
     * side by side instead of one at each end of the keyboard. `index.html`'s
     * `no pointer lock` section says so, and is the only place a player finds
     * out either of them exists.
     *
     * Edge-triggered on `held`, like every toggle in this listener: key repeat
     * would flip the torch at the repeat rate and would empty the stamina bar on
     * one press of the swing.
     */
    if (e.code === 'KeyF' && !held) {
      // No audio unlock here, deliberately: this is the one binding in this
      // block that makes no sound, and `enableAudio` on it would have the first
      // press of the session cost a context resume for nothing.
      const on = nightLights.toggleTorch();
      // Said out loud, because the answer is invisible in daylight -- the beam
      // is already at zero intensity above +2 degrees of solar altitude, so a
      // player who presses this at noon gets no feedback at all and concludes
      // the key is broken. See `nightLevel`.
      hud.notice(on ? 'torch on' : 'torch off');
    }
    // `K` for the swing and `L` for the throw: the fallback path for a browser
    // that refuses pointer lock, where a weapon bound only to a mouse button is
    // a weapon that does not exist. Edge-triggered, or key repeat empties the
    // stamina bar on one press.
    if (e.code === 'KeyK' && !held) {
      punchBuffer = PUNCH_BUFFER;
      enableAudio();
    }
    if (e.code === 'KeyL' && !held) {
      throwBuffer = PUNCH_BUFFER;
      enableAudio();
    }
    // `C`: first person, and back to the distance you were last at. Edge-triggered
    // like every other toggle here, or key repeat flips it thirty times a second.
    //
    // Through `setCameraDistance`, which the wheel goes through too -- see there
    // for the ride nudge and for why there is one preference and not two. A
    // toggle here and a relative step on the wheel is the difference between the
    // two bindings and the whole of it: a key has no direction and a wheel has
    // nothing but one. `lastThirdDistance` is what makes the key a *toggle* over
    // a continuous scalar rather than a jump to a fixed boom -- you get back the
    // camera you were zoomed to, not somebody's default.
    //
    // `B`: hold to read your build. Not a toggle and not a modal -- see
    // `client/src/buildsheet.ts`. It sits above the camera key because it is the
    // same kind of thing: something you do *while* playing rather than instead
    // of it. Edge-triggered like its neighbours; `keyup` and `blur` below put it
    // away, and `blur` matters because alt-tabbing with a key held never sends
    // the release.
    if (e.code === 'KeyB' && !held) buildSheet.show();
    // --- WORKSTREAM Z: **this was `V` until now, and the move is the point.**
    //
    // Workstream W put the talent dash on `V` and resolved the collision by
    // letting the ability win when the player had one -- so the camera key
    // worked for a guest, stopped working the moment they spent a point on Bolt,
    // and worked again for their teammate who had not. One key, two behaviours,
    // decided by a menu the player was not looking at. `C` is free, it is the
    // mnemonic, and it is now the camera for everybody regardless of build.
    // `game/talentkeys.ts`' header has the argument in full.
    if (e.code === 'KeyC' && !held) {
      setCameraDistance(toggleCameraDistance(cameraDistance, lastThirdDistance));
    }
    // `E`: get on the bike beside you, or off the one you are on.
    //
    // Edge-triggered here for the *prediction* and sent as a level bit for the
    // server to edge itself -- see `protocol.BTN.MOUNT`. `keys` carries the
    // level to `simulate`, and this only fires the audio unlock, because the
    // mount itself has to happen inside a fixed step to be predicted at all.
    if (e.code === 'KeyE' && !held) enableAudio();
    /* **There are no sky scrubs on this keyboard any more, and the absence is
     * the feature.**
     *
     * `[`, `]`, `T` and `N` used to move an offset on the time of day. Every one
     * of them is gone, and what replaced them is that the *server* now says what
     * time it is -- the `sky.setServerClock` call in the connect path above,
     * off protocol v11's `WELCOME`.
     *
     * The reason is not that the scrub was expensive; it is that the sky is a
     * **shared** fact and a client that can set its own is a client that
     * disagrees with every other client about whether the street lights are on.
     * The police and the raves both read `SkyClock.night`, so "it is only
     * appearance" was already stretching. And this project has paid for exactly
     * this shape of bug once: a `?vessels=1` link that outlived the server flag
     * it was handed out with, where each end was individually correct and the
     * player fell through solid roads. `/health` publishes `vessels` now so the
     * two cannot silently differ, and it publishes the clock beside it for the
     * same reason.
     *
     * The handles still exist for developers -- `sydney.sky.advance(30)`,
     * `sydney.sky.scrubTo(0.75)`, `sydney.nightsky.moon(1)` -- on a console,
     * which is a deliberate act rather than a letter next to WASD, and anybody
     * who uses one is announced: `sky.tick` warns to the console on every change
     * and `sydney.nightsky.now()` reports `desyncMinutes` until the page is
     * reloaded. Not the HUD -- that belongs to the player and a developer-only
     * state has no business on it. See `sky/sky.ts`'s `scrubMs`.
     */
    if (e.code === 'Minus' || e.code === 'Equal') {
      renderScale = Math.max(0.5, Math.min(1.0, renderScale + (e.code === 'Equal' ? 0.05 : -0.05)));
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2) * renderScale);
    }
    // `M` used to open the city map from here. **It is handled in
    // `money.keydown` now** -- called at the top of this listener, and consuming
    // the key -- because the map is the phone's and the key's first job is to
    // get the phone into a hand. The panel housekeeping that was in this block
    // moved with it, into the `openMap` dep beside `installMoney`. See
    // `client/src/game/phone.ts` and `client/src/money.ts`.

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
    // `index.html`'s `#help` block says "esc — suggestions · what's new · report
    // a bug" -- all three tabs, on its own line and on screen at all times -- so
    // the first press is not a mystery.
    //
    // The chat composer and the name prompt never reach this line: while either
    // has the keyboard `hud.typing` is true and this listener returned at its
    // first statement. The suggestions panel's own compose fields do the same,
    // through `hud.suggestTyping`, which is why closing it *from the textarea* is
    // handled in `suggestions.ts` rather than here.
    if (e.code === 'Escape') {
      // The talents panel is deliberately **not** in this list and never reaches
      // this line: while it is up `hud.talentsOpen` makes `hud.typing` true and
      // this listener returned at its first statement, and the panel's own
      // capture-phase listener has already decided what the key means. See
      // `client/src/teams.ts` -- before a side is picked, Escape does nothing at
      // all, which is the one modal thing in this interface.
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
    if (e.code === 'KeyB') buildSheet.hide();
  });
  // And on losing focus, which is the case a keyup never arrives for: alt-tabbing
  // out with the board up would otherwise leave it on screen for the rest of the
  // session, because the key it is held with is released in another window.
  window.addEventListener('blur', () => {
    buildSheet.hide();
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
    // The star field and the moon size themselves in *pixels* from an angular
    // size, so they are the only things in the renderer that need to be told how
    // big the frame is. Told the drawing-buffer size rather than the CSS size,
    // because that is what the shader's clip-space offset is measured in -- pass
    // the CSS size at a render scale of 0.7 and the moon comes out 40% too big.
    const buffer = renderer.getDrawingBufferSize(new Vector2());
    sky.setViewport(buffer.x, buffer.y, camera);
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
      // Workstream I: and the fist, on the same 90 ms. Both are kicked whichever
      // one is on screen -- the hidden one is being posed anyway (see the frame
      // loop) and a shudder nobody saw costs nothing. A knuckle that lands on
      // somebody stops harder than a bat does, which is what the shorter, tighter
      // decay in `HandsViewmodel` is for.
      handsViewmodel.connect();
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

  // --- F: bat swats the footy. The presentation, in one place. ---------------
  //
  // Called from two paths that decide the *same* thing in two different
  // processes -- the offline swat below in `simulate`, and `netHandlers().onSwat`
  // when the server has decided it -- which is the arrangement `onHit` and
  // `netHandlers().onHit` already have and is what keeps a returned serve feeling
  // identical whether it was adjudicated 30 ms away or in this process.
  //
  // Three things happen and each is aimed at a different person:
  //
  //   - the **thock**, for everybody in earshot, attenuated by range. `swat` is
  //     `thwack`'s three layers re-pitched -- see `game/audio.ts`.
  //   - the **puff** at the point of contact, for anybody who can see it: at
  //     42 m/s the ball crosses the whole swing volume inside two frames, and
  //     without a mark there a returned serve reads as a ball changing its mind.
  //   - the **connect kick** on the viewmodel, for the swinger alone. The same
  //     90 ms shudder a landed bat hit gives, and for the same reason: the blade
  //     was arrested and the hands were not. It is the one piece of feedback that
  //     says *you* did that.
  /**
   * How far a local predicted ball may be from a swat point and still be it.
   *
   * `netHandlers().onSwat` matches by proximity because local ball ids and
   * server ball ids come out of two unrelated counters -- see there. 4 m is what
   * half a round trip is worth: the event was sent when the server's copy was at
   * the swat point, and by the time it arrives this client's copy has flown on
   * for the downlink trip, which at 42 m/s and a bad 90 ms is 3.8 m. Wider than
   * that and a *different* ball of yours a few metres away could be claimed;
   * narrower and the correction is silently skipped on a slow connection, which
   * leaves a ghost ball flying the old trajectory until it dies.
   */
  const SWAT_MATCH_M = 4;

  // `mine` is resolved by the caller rather than compared here, because the two
  // paths identify the local player differently: offline it is `playerCombat.id`
  // and online it is `net.id`, which is what `netHandlers().onHit` already does
  // one function up.
  function swatFeedback(mine: boolean, x: number, y: number, z: number): void {
    const range = Math.hypot(x - player.position.x, z - player.position.z);
    if (range < BOUNCE_AUDIBLE) audio.swat(range);
    swatPuffs.fire(x, y, z);
    // Counted for `sydney.bat.swats`, on the terms `shadowReport` sets: a number
    // to check a claim against rather than guess at. A swat is over in 260 ms
    // and the tab this project is developed against is throttled -- see
    // `sydney.serve` -- so "did that work" is a question a screenshot cannot
    // always answer and this always can.
    swatCount++;
    lastSwat = { mine, x, y, z, at: performance.now() };
    if (mine) {
      viewmodel.connect();
      // `feedback.hitLanded(false)` is deliberately **not** called. That is the
      // screen shake for putting a pip on somebody, and a swat takes nobody's
      // health -- shaking the frame for it would tell the player they scored.
    }
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

  /**
   * --- WORKSTREAM Z: the real-estate agent's applause, if one saw it.
   *
   * `Karen Rapport` grants a pip on a knockout with an agent within ten metres,
   * and the pip is the server's -- this is only the sentence. The range test is
   * repeated on this side rather than the fact being sent, which is the
   * arrangement `TRADIE_HELP_LINE` and `POSTED_LINE_BYSTANDER` both already run
   * on: there is no state byte for "applauding", adding one would be a protocol
   * change for a line of text, and this client already has both its own position
   * and every promoted actor near it.
   *
   * The two ends can therefore disagree in one direction -- the agent is on the
   * server's promoted list and not yet on this client's, so the pip arrives and
   * the line does not. That is a dropped sentence rather than a wrong one, which
   * is the right way round for a cosmetic.
   */
  function noteAgentApplause(): void {
    for (const actor of policeField().actors) {
      if (actor.kind !== NPC_KIND.AGENT) continue;
      const dx = actor.x - player.position.x;
      const dz = actor.z - player.position.z;
      if (dx * dx + dz * dz > AGENT_CHEER_M * AGENT_CHEER_M) continue;
      hud.notice(AGENT_APPLAUSE_LINE);
      return;
    }
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
      onHit(attacker, victim, ko, footy, health, returned, ally) {
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
          // Workstream I: the fist takes the same kick as the bat on a melee
          // hit, and neither takes one for a football -- the thing that was
          // arrested there is a ball thirty metres away.
          if (!footy) handsViewmodel.connect();
        }
        if (theirs) {
          if (ko) feedback.knockedOut();
          else feedback.hitTaken();
        }
        void health;
        // Three verbs, and the third is the whole of the community suggestion
        // this pass implements: a ball that changed hands in the air and then
        // knocked somebody over is a *returned serve*, which is the most
        // interesting thing that can happen in a fight in this game and would
        // otherwise be indistinguishable from an ordinary peg. The flag is a
        // spare bit on a byte already on the wire -- see `EVENT_FLAG.RETURNED`.
        if (ko) {
          // --- WORKSTREAM Z: a fourth line, and the only one with two people in
          // it. `Meth-adone`'s assist is credited to the player -- the node says
          // it counts as their kill -- but they did not swing, so "batted" would
          // be the feed describing something that did not happen. The noun is
          // guessed from who is standing over the body, because the kind byte is
          // deliberately not on the wire; see `game/talentlive.allyNounNear`.
          if (ally) {
            const them = net?.remotes.get(victim);
            const vx = them ? them.position.x : player.position.x;
            const vz = them ? them.position.z : player.position.z;
            const noun = allyNounNear(policeField().actors, vx, vz, (k) => npcKind(k)?.name ?? '');
            pushKill(allyKoLine(who(attacker), noun, who(victim)));
            return;
          }
          const verb = footy ? (returned ? 'returned serve on' : 'pegged') : 'batted';
          pushKill(`${who(attacker)} ${verb} ${who(victim)}`);
          // --- WORKSTREAM Z: and the agent's applause, if you were the one who
          // landed it. The pip is the server's (`Simulation.cheerFor`); the line
          // is the client's, off a range test rather than a wire message, which
          // is exactly the arrangement `TRADIE_HELP_LINE` already runs on. See
          // `characters.AGENT_APPLAUSE_LINE`.
          if (mine) noteAgentApplause();
        }
      },
      /**
       * A bat sent a football back, decided by the server. See `game/swat.ts`.
       *
       * The presentation is `swatFeedback`'s, shared with the offline path as
       * `onHit` is. What is *not* shared is the second half of this handler, and
       * it exists for one listener only: the player who threw the ball.
       *
       * A swat leaves the ball's `thrower` alone -- deliberately, see
       * `footy.Footy.owner` -- so the thrower's own client is still flying a
       * local predicted copy on the pre-swat trajectory and there is nothing in
       * the snapshot stream that could tell it otherwise, because
       * `net/client.ownBall` filters its own throws out of that stream on
       * purpose. So the correction happens here, from the six numbers the event
       * carries.
       *
       * Matched by **proximity rather than by id**, and that is not laziness:
       * local ball ids come from this client's own `FootyField` counter and
       * server ball ids from the server's, so the two number spaces have never
       * had anything to do with each other. What they do share is a position --
       * both processes have been flying the same throw from the same spawn state
       * through the same arithmetic -- so the local copy nearest the swat point
       * is the swatted one, and `SWAT_MATCH_M` is the slack that allows for the
       * half a round trip this event spent in the air.
       */
      onSwat(swinger, ball, x, y, z, vx, vy, vz) {
        swatFeedback(net !== null && swinger === net.id, x, y, z);
        void ball;
        let nearest: Footy | null = null;
        let best = SWAT_MATCH_M * SWAT_MATCH_M;
        for (const b of localBalls.balls) {
          const d =
            (b.x - x) * (b.x - x) + (b.y - y) * (b.y - y) + (b.z - z) * (b.z - z);
          if (d >= best) continue;
          nearest = b;
          best = d;
        }
        // Nothing near enough is the ordinary case and not an error: almost
        // every swat in a room is two other people, and this client has no local
        // copy of a ball it did not throw.
        if (nearest === null) return;
        nearest.x = x;
        nearest.y = y;
        nearest.z = z;
        nearest.vx = vx;
        nearest.vy = vy;
        nearest.vz = vz;
        // And it is not yours any more. The local copy has to agree about that
        // or this client would predict its own ball passing harmlessly through
        // the person who swatted it and knocking over the player it is now
        // heading for -- neither of which it is allowed to decide online, but
        // both of which it draws.
        nearest.owner = swinger;
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
      /*
       * The sun's two instants, straight into the one object that owns them.
       *
       * Arrives at join, whenever anybody in the room presses the button, and as
       * the answer to this client's own press -- accepted or refused. `adopt`
       * replaces rather than merges and narrates only what is news; see
       * `world/sunbutton.SunFeature.adopt`. The position is passed so the notice
       * can say "somebody pressed the button" to people who can see the hill and
       * "the sun has started screaming" to everybody else.
       */
      onSun(state) {
        sunButton.adopt(state, player.position.x, player.position.z);
      },
      /** WORKSTREAM X: a Sunday Rush tent, or a mega's shockwave. */
      onTeamEvent(event) {
        onTeamEvent(event.kind, event.x, event.y, event.z, event.untilMs);
      },
      /** "+$34 fare". The pill, and the phone's wallet history. */
      onMoney(note, balance) {
        money.onMoney(note, balance);
      },
      /** Somebody's side or build moved. Workstream V; the panel redraws itself. */
      onTalents() {
        talents.invalidate();
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


  /**
   * What `E` does, in one function, so there is exactly one of it.
   *
   * Called by the key handler in `simulate` and by `sydney.rail.board()` /
   * `alight()` in the console. **The console must not have its own path**: a dev
   * helper that boarded by writing the aboard state directly would pass on every
   * build in which the real interaction was broken, which is the one thing a
   * harness must not do. So the harness presses the same button, and it fails
   * for the same reasons -- no train, doors shut, standing too far from the door.
   */
  const pressMount = (): void => {
    /* --- The button in Sydney Park, **ahead of everything**, and it is the one
     *     addition to this chain that does not need to be in `sim.resolveMount`.
     *
     *     First because it is the narrowest: `SunFeature.press` refuses -- and
     *     returns false, letting the rest of the chain run -- unless the player
     *     is inside three metres of one specific point in one park. Nothing else
     *     on this key can be true there at the same time, because a bike parked
     *     on top of the mound would be a bike the plinth is standing in.
     *
     *     It returns true when the press was *consumed* rather than accepted, so
     *     that pressing a recharging button puts up the refusal instead of
     *     silently mounting a bike two metres away -- which is the one way this
     *     could have made the `E` key worse.
     *
     *     `net?.pressSun()` rather than a bit on `INPUT`: see
     *     `protocol.MSG.SUN_PRESS` for why this is not folded into the mount
     *     chain on the wire either. Offline `net` is null, the send is skipped,
     *     and the state `press` wrote locally is the only state there is -- which
     *     is exactly the offline stub sim's contract everywhere else in this
     *     file. */
    if (
      sunButton.press(
        player.position.x,
        player.position.y - EYE_HEIGHT,
        player.position.z,
        net ? () => void net.pressSun() : null,
      )
    ) {
      return;
    }

    const field = bikeWorld();
    // --- The train, ahead of the bike, on one key. `sim.resolveMount` runs the
    //     identical chain in the identical order, which is what makes this a
    //     prediction rather than a second opinion: off a train, then off a
    //     bike, then onto a train, then onto a bike. The rule underneath it is
    //     *leaving beats arriving*, and it settles the only ambiguous case
    //     there is -- a rider standing at an open door does not re-board the
    //     carriage they are already in.
    if (isAboard(playerCombat.aboard)) {
      predictAlight();
    } else if (playerCombat.ridingBike !== 0) {
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
    } else if (playerCombat.drivingCar !== 0) {
      // Out of the car, and the record stays where the body is -- offline
      // `CarField.follow` does it at the end of this tick, online the server
      // does and the mirror is corrected. `sim.resolveMount` runs the identical
      // branch in the identical position, which is what makes this a prediction
      // rather than a second opinion.
      const wasDriving = playerCombat.drivingCar;
      playerCombat.drivingCar = 0;
      playerCombat.carSpeed = 0;
      // And the record stops being anybody's. Offline this is the whole of the
      // release -- see `CarField.leave` for why the sweep cannot do it there --
      // and online it is a prediction the next `MSG.CARS` confirms.
      carWorld().leave(wasDriving);
      net?.predictedCarChange();
    } else if (!predictBoard()) {
      const bike = field.nearestFree(player.position.x, player.position.y - EYE_HEIGHT, player.position.z);
      if (bike && field.claim(bike.id, playerCombat.id)) {
        playerCombat.ridingBike = bike.id;
        net?.predictedBikeChange();
        audio.pickupFlatWhite();
      } else {
        predictTakeCar();
      }
    }
  };

  /**
   * Predict getting into a car. The bottom of `E`'s priority chain.
   *
   * `sim.tryTakeCar` is the authority and runs the identical two steps in the
   * identical order -- an empty record standing in the street first, then a car
   * off the timetable -- against the identical `TrafficField` at the identical
   * whole tick. What this buys is the frame: the chase camera and the speed
   * change on the frame `E` goes down rather than a round trip later, and
   * `net.predictedCarChange` is what stops the snapshots already in flight from
   * undoing it.
   *
   * Offline this **is** the authority, which is what makes `?offline` a real
   * test of the feature rather than a second implementation of it.
   */
  const predictTakeCar = (): void => {
    const cars = carWorld();
    const feet = player.position.y - EYE_HEIGHT;
    // Somebody's abandoned getaway car, or the one you parked. No crime: the
    // theft happened when it came off the timetable and was reported then.
    let best: ReturnType<CarField['get']> | null = null;
    let bestD2 = TAKE_RADIUS * TAKE_RADIUS;
    for (const car of cars.all()) {
      if (car.driverId !== 0) continue;
      const dy = car.y - feet;
      if (dy > TAKE_HEIGHT || dy < -TAKE_HEIGHT) continue;
      const dx = car.x - player.position.x;
      const dz = car.z - player.position.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > bestD2 || (best !== null && d2 >= bestD2)) continue;
      best = car;
      bestD2 = d2;
    }
    if (best) {
      best.driverId = playerCombat.id;
      playerCombat.drivingCar = best.id;
      playerCombat.carSpeed = 0;
      player.yaw = best.yaw;
      net?.predictedCarChange();
      audio.pickupFlatWhite();
      return;
    }
    // Or one off the timetable, which is the theft. **No crime is predicted**:
    // unlike the tuned ride-by twenty screens down, whether anybody saw it
    // depends on the crowd's line of sight, and a banner that appeared and then
    // vanished when the server disagreed would be worse than one 50 ms late.
    if (
      !resolveTake(
        traffic,
        player.position.x,
        feet,
        player.position.z,
        trafficTick(Date.now()),
        takeScratch.routes,
        takeScratch.pose,
        (identity) => cars.suppressed(identity),
        takeScratch.take,
        // WORKSTREAM S: and the parked fleet, which is the twenty-three thousand
        // cars a player is actually standing next to. `sim.tryTakeCar` passes its
        // own copy of the same field, decoded from the same bytes, at the same
        // instant -- so this is a prediction rather than a second opinion.
        staticCars,
      )
    ) {
      return;
    }
    // --- Workstream H: make room, if the room is out of records.
    //
    // `sim.tryTakeCar` runs the identical two lines in the identical place. It
    // is a *prediction* here in both senses: online the next `MSG.CARS` will
    // carry the same removal and the same take, and offline this is the
    // authority. The player list is the local player alone, which offline is
    // every player there is and online is a client's honest best answer -- and a
    // client that recycles a record the server keeps is corrected by the very
    // next snapshot, which is a car re-appearing 250 m away that nobody is
    // looking at.
    if (cars.size >= MAX_DRIVEN_CARS) {
      if (cars.recycleFarthest([player.position.x, player.position.z]) === 0) return;
    }
    const taken = cars.take(takeScratch.take, playerCombat.id);
    if (taken === null) return;
    playerCombat.drivingCar = taken.id;
    playerCombat.carSpeed = 0;
    // Point the driver down the street rather than at whatever shopfront they
    // happened to be facing. A look direction is client-authoritative on this
    // wire, so this needs nobody's permission -- see `driving.headingYaw`.
    player.yaw = taken.yaw;
    net?.predictedCarChange();
    audio.pickupFlatWhite();
  };

  /**
   * The rail harness: `sydney.rail.goto`, `catch`, `board`, `alight`, `ride`.
   *
   * ---------------------------------------------------------------------------
   * SOLVE, DO NOT POLL. That is the whole design.
   *
   * A T4 has its doors open at St Peters for fifteen seconds every ninety, so
   * every way of testing riding by hand or in CI used to begin with waiting --
   * and waiting is how a test suite ends up taking four minutes to discover that
   * boarding is broken. It does not have to. The timetable is a pure function of
   * the clock, so:
   *
   *   - **when** the next train is standing at a station is a division and a
   *     ceiling, `riding.nextDwell`;
   *   - **where** a boarder stands for it is one composition through the
   *     carriage's own frame, `riding.dwellStand`.
   *
   * `server/integration-check.checkRiding` drives those same two functions,
   * which is why they live in `game/riding.ts` and not here. A harness with its
   * own idea of where a doorway is would be a harness that passed while the game
   * was broken.
   *
   * ---------------------------------------------------------------------------
   * AND IT PRESSES THE BUTTON.
   *
   * `board()` and `alight()` call `pressMount` -- the function the `E` key
   * calls, with the same priority chain and the same predicates. They fail for
   * exactly the reasons a real press fails: no train, doors shut, standing too
   * far from the door. Online, the server then re-runs `findBoarding` against
   * its own position and refuses whatever it does not believe, and nothing here
   * touches that. A helper that wrote the aboard state directly would be a
   * helper that hid the bug it exists to catch.
   *
   * ---------------------------------------------------------------------------
   * THE CLOCK IS NOT WARPED, and that is a decision. `railSeconds(Date.now())`
   * is the instant the traffic, the sky, the raves and -- online -- the server
   * are all reading. Moving it would move the whole world and desynchronise this
   * client from the one authority that matters. So a dwell is *solved* and the
   * wait is *reported*, which is all a caller needs to schedule a press instead
   * of hunting for one.
   */
  const railHarness = {
    /**
     * **Walk a body from A to B through the real collision world, and say what
     * happened to its feet.**
     *
     * ---------------------------------------------------------------------------
     * WHY THIS EXISTS RATHER THAN A LIST OF PRISMS.
     *
     * Every solidity bug the player reported is a claim about a *body*: "i can
     * pass through that right edge", "i cant actually go up these stairs", "i
     * fall through the platform". None of them is answerable by looking at the
     * prism list, because the prisms were all there and all correct-looking --
     * what was wrong was what a body meets when it tries to move through them.
     * A wall with a two-metre gap at a bend has a prism; a stair blocked by a
     * balustrade has a prism for the stair *and* one for the thing in the way.
     *
     * So this drives the identical `CollisionWorld.resolve` and the identical
     * `groundHeightAt` the player's own integrator uses, in a straight line, in
     * 0.2 m steps, and reports:
     *
     *   - `gotM`     how far it actually travelled before it stopped;
     *   - `blocked`  whether something refused the move;
     *   - `climbed`  the biggest single step up it took (a stair is a series of
     *                these; a wall is one it could not take);
     *   - `fell`     the biggest single drop, which is what a hole in a platform
     *                looks like from inside a walk;
     *   - `feet`     the height profile, so a flight reads as a ramp and a
     *                fall-through reads as a cliff.
     *
     * It steps rather than integrates deliberately: what is being tested is the
     * *world*, not the controller, and a body with momentum bounces off a
     * corner in ways that are about the integrator. `STEP_HEIGHT` is honoured
     * because that is the whole of what makes a stair a stair.
     */
    walk: (
      from: readonly [number, number],
      to: readonly [number, number],
      opts: { step?: number; radius?: number; feetY?: number } = {},
    ) => {
      const step = opts.step ?? 0.2;
      const radius = opts.radius ?? PLAYER_RADIUS;
      const dx = to[0] - from[0];
      const dz = to[1] - from[1];
      const total = Math.hypot(dx, dz);
      const n = Math.max(1, Math.ceil(total / step));
      let x = from[0];
      let z = from[1];
      let feet = opts.feetY ?? groundHeightAt(x, z, Infinity);
      const feetLog: number[] = [+feet.toFixed(2)];
      let blocked = false;
      let climbed = 0;
      let fell = 0;
      let travelled = 0;
      for (let i = 1; i <= n; i++) {
        const tx = from[0] + (dx * i) / n;
        const tz = from[1] + (dz * i) / n;
        // `feet + STEP_HEIGHT` is exactly what `controller.step` probes with, so
        // a kerb is climbed here for the same reason it is climbed in the game.
        const moved = collision.resolve(x, z, tx, tz, radius, feet + STEP_HEIGHT);
        const gained = Math.hypot(moved.x - x, moved.z - z);
        if (gained < step * 0.5) {
          blocked = true;
          break;
        }
        travelled += gained;
        x = moved.x;
        z = moved.z;
        const ground = groundHeightAt(x, z, feet);
        const delta = ground - feet;
        if (delta > climbed) climbed = delta;
        if (-delta > fell) fell = -delta;
        feet = ground;
        feetLog.push(+feet.toFixed(2));
      }
      return {
        gotM: +travelled.toFixed(2),
        ofM: +total.toFixed(2),
        blocked,
        arrived: !blocked && travelled > total - 0.5,
        climbed: +climbed.toFixed(2),
        fell: +fell.toFixed(2),
        at: [+x.toFixed(1), +feet.toFixed(2), +z.toFixed(1)],
        feet: feetLog,
      };
    },

    stations: (query = '') =>
      (railNetwork?.stations ?? [])
        .filter((s) => s.name.toLowerCase().includes(query.toLowerCase()))
        .map((s) => ({
          name: s.name,
          metres: Math.round(Math.hypot(s.x - player.position.x, s.z - player.position.z)),
          vertical: s.vertical,
          platforms: s.platforms,
        }))
        .sort((a, b) => a.metres - b.metres)
        .slice(0, 40),

    /** When the next train is standing at a station. Solved; moves nobody. */
    when: (station = 'Central', line?: string) => {
      if (railBake === null) return 'no bake';
      const t = railSeconds(Date.now());
      const d = nextDwell(railBake, station, t, { lineId: line });
      if (d === null) return `no service calls at "${station}"`;
      return {
        line: d.lineId,
        towards: d.towards,
        trip: d.trip,
        carriage: d.car,
        doorsOpenIn: +(d.opensAt - t).toFixed(1),
        dwellSeconds: +(d.closesAt - d.opensAt).toFixed(1),
      };
    },

    /**
     * Stand in the doorway the next train will open, facing the track.
     *
     * ---------------------------------------------------------------------------
     * ONLINE IT ASKS THE SERVER, and that is the fix for the hole this whole
     * round exists to close.
     *
     * The previous version moved the *client's* body and said so: "online the
     * server has not heard of it ... `board()` then correctly refuses". Which
     * was true, honest, and fatal -- because it meant `ride()` could only ever
     * run offline, so the one acceptance test the feature had ran against a
     * local `Simulation` and passed while the networked path was broken.
     *
     * So online this sends `/platform <station> > <destination>`, which the
     * server honours through `chat.platform`: it solves the dwell out of its own
     * bake at its own clock and moves the body itself. Nothing here relocates
     * anybody. `net.armTeleport` is the same courtesy `/unstuck` pays the
     * reconciler -- "a jump you cannot predict is coming, adopt it rather than
     * differencing it into a four-hundred-metre-a-second velocity".
     *
     * Offline the client *is* the authority, so it places itself, through the
     * same `nextDwell` and `dwellStand` the server would have used. Both paths
     * end with a body in a doorway; only the question of who put it there
     * differs, and that is exactly the difference that was never tested.
     */
    goto: (station = 'Central', line?: string, then?: string) => {
      if (railBake === null) return 'no bake';
      const t = railSeconds(Date.now());
      const d = nextDwell(railBake, station, t, { lineId: line, then });
      if (d === null) return `no service calls at "${station}"`;
      const summary = {
        at: station,
        line: d.lineId,
        towards: d.towards,
        carriage: d.car,
        doorsOpenIn: +(d.opensAt - t).toFixed(1),
        dwellSeconds: +(d.closesAt - d.opensAt).toFixed(1),
      };
      if (net !== null) {
        net.armTeleport();
        net.sendChat(`/platform ${station}${then ? ` > ${then}` : ''}`);
        return { ...summary, placedBy: 'the server, via /platform' };
      }
      if (!dwellStand(railBake, d, Math.max(d.opensAt + 1, t), railStand)) {
        return `could not place a stand at the ${d.lineId} dwell at ${station}`;
      }
      clearAboard(playerCombat.aboard);
      player.position.set(railStand.x, railStand.y, railStand.z);
      player.velocity.set(0, 0, 0);
      player.onGround = true;
      input.yaw = railStand.yaw;
      input.pitch = 0;
      void ensureGround(railStand.x, railStand.z);
      return {
        ...summary,
        standing: [+railStand.x.toFixed(1), +railStand.z.toFixed(1)],
        placedBy: 'this client (offline)',
      };
    },

    /** What riding thinks is going on: the ride, or why there is no offer. */
    state: () => {
      const a = playerCombat.aboard;
      if (railBake === null) return 'no bake';
      const t = railSeconds(Date.now());
      if (isAboard(a)) {
        const ok = rideBanner(railBake, a, t, rideText);
        return {
          aboard: { line: a.line, dir: a.dir, trip: a.trip, car: a.car },
          local: { x: +a.x.toFixed(2), y: +a.y.toFixed(2), z: +a.z.toFixed(2), yaw: +a.yaw.toFixed(2) },
          world: {
            x: +player.position.x.toFixed(1),
            y: +player.position.y.toFixed(1),
            z: +player.position.z.toFixed(1),
          },
          banner: ok ? `${rideText.line} → ${rideText.towards} · next: ${rideText.next}` : 'trip not running',
          speedKmh: ok ? Math.round(rideText.speed * 3.6) : 0,
          doorsOpen: rideText.doorsOpen,
          calls: callsAhead(railBake, a, aboardPose(railBake, a, t)?.s ?? 0).slice(0, 6),
        };
      }
      const feet = player.position.y - EYE_HEIGHT;
      if (findBoarding(railBake, player.position.x, feet, player.position.z, t, boardOffer)) {
        const dir = dirOf(railBake, boardOffer.line, boardOffer.dir);
        return {
          offer: `${dir?.line.id} carriage ${boardOffer.car} bay ${boardOffer.bay} at ${boardOffer.station}`,
          metres: +boardOffer.distance.toFixed(2),
        };
      }
      // Say *why*. The three reasons -- no train standing here, doors shut, not
      // beside a door -- are indistinguishable from outside, and the third one
      // is the only one anybody can do anything about.
      const near = nearestDwell(railBake, player.position.x, feet, player.position.z, t);
      return near === null
        ? 'no train is standing at a platform within 300 m'
        : `nearest open doors: ${near.line} at ${near.station}, ${near.metres.toFixed(1)} m away ` +
          `(carriage ${near.car}, ${near.alongBay.toFixed(1)} m along the bay, ` +
          `${near.outside.toFixed(2)} m off the bodyside, ${near.rise.toFixed(2)} m of rise)`;
    },

    /** Press `E` to board. The same press the key makes. */
    board: () => {
      const was = isAboard(playerCombat.aboard);
      pressMount();
      const now = isAboard(playerCombat.aboard);
      return was || !now
        ? { boarded: false, why: railHarness.state() }
        : { boarded: true, ...(railHarness.state() as object) };
    },

    /** Press `E` to get off. The same press, and the same three ways off. */
    alight: () => {
      if (!isAboard(playerCombat.aboard)) return { alighted: false, why: 'not aboard' };
      pressMount();
      const p = player.position;
      return {
        alighted: !isAboard(playerCombat.aboard),
        at: [+p.x.toFixed(1), +p.z.toFixed(1)],
        feet: +(p.y - EYE_HEIGHT).toFixed(2),
        onGround: player.onGround,
        health: +playerCombat.health.toFixed(1),
      };
    },

    /**
     * The whole journey in one call: place, board, ride, get off, report.
     *
     *     await sydney.rail.ride('St Peters', 'Central')
     *
     * Every wait is a `setTimeout` against a number the timetable gave us. The
     * only reason it takes as long as the journey is that the journey takes that
     * long -- there is no searching in it anywhere.
     */
    ride: async (from = 'St Peters', to = 'Central', line?: string) => {
      if (railBake === null) return { pass: false, why: 'no bake' };
      const log: string[] = [];
      const sleep = (sec: number): Promise<void> =>
        new Promise((r) => { setTimeout(r, Math.max(0, sec) * 1000); });

      // `then` is what makes this the train you want rather than the next one:
      // half the T4s at St Peters are going to Waterfall, which reaches Central
      // four minutes before you got on. See `riding.DwellWanted.then`.
      const wasAt = player.position.clone();
      const placed = railHarness.goto(from, line, to);
      if (typeof placed === 'string') return { pass: false, why: placed, log };
      log.push(
        `placed in the doorway on the ${from} platform for the ${placed.line} to ` +
          `${placed.towards} by ${placed.placedBy}; doors in ${placed.doorsOpenIn} s`,
      );

      // --- Online, wait for the authority to actually move us.
      //
      // `/platform` is a request over a chat channel and the move arrives in a
      // snapshot, so there is a round trip here that does not exist offline.
      // Waited on by watching the body rather than by sleeping a guessed
      // number: what this is really asserting is that the server honoured the
      // command at all, and a fixed sleep would turn a refusal -- the cooldown,
      // a knockout, a station nobody calls at -- into a mysterious failure to
      // board four seconds later.
      if (net !== null) {
        const deadline = Date.now() + 6000;
        while (Date.now() < deadline && player.position.distanceTo(wasAt) < 5) {
          await sleep(0.1);
        }
        if (player.position.distanceTo(wasAt) < 5) {
          return {
            pass: false,
            why: 'the server did not move us: /platform was refused. The usual reasons are the ' +
              "10 s teleport cooldown shared with /unstuck, being knocked out, or a station " +
              'name no service calls at. The chat panel has the refusal.',
            log,
          };
        }
        log.push(`the server placed us at (${player.position.x.toFixed(1)}, ${player.position.z.toFixed(1)})`);
      }

      // Two seconds into the dwell. The doors take 1.6 s to slide and stand open
      // for fifteen, so this is a passenger who was waiting rather than running.
      await sleep(placed.doorsOpenIn + 2);

      const got = railHarness.board();
      if (!got.boarded) return { pass: false, why: got.why, log };
      const a = playerCombat.aboard;
      log.push(`boarded carriage ${a.car} of ${placed.line} trip ${a.trip}`);

      // --- And online, wait for the server to agree, because a client's own
      //     `isAboard` is a prediction until it does.
      //
      // This is the assertion the rolled-back round did not have anywhere. A
      // boarding that the server refuses looks *identical* on this side for one
      // round trip -- the pill says aboard, the camera is in the carriage -- and
      // the difference only shows up as the ride quietly ending. Half a second
      // is five snapshots at a 100 ms round trip.
      if (net !== null) {
        await sleep(0.5);
        if (!isAboard(playerCombat.aboard)) {
          return {
            pass: false,
            why: 'the client boarded and the server did not agree: the ride was gone within half a ' +
              'second. That is `sim.tryBoard` refusing against its own body -- too far from the ' +
              'door by its reckoning, or the doors had shut.',
            log,
          };
        }
        const rode = playerCombat.aboard;
        log.push(
          `the server agrees: still aboard carriage ${rode.car} half a second later, ` +
            `${Math.round((rideBanner(railBake, rode, railSeconds(Date.now()), rideText) ? rideText.speed : 0) * 3.6)} km/h`,
        );
      }

      const off = dwellAt(railBake, a, to);
      if (off === null) {
        return {
          pass: false,
          why: `the ${placed.line} to ${placed.towards} does not call at ${to}`,
          calls: callsAhead(railBake, a, aboardPose(railBake, a, railSeconds(Date.now()))?.s ?? 0),
          log,
        };
      }
      const wait = off.opensAt - railSeconds(Date.now());
      log.push(`${to} is ${wait.toFixed(0)} s down the line`);
      if (wait > 900) return { pass: false, why: `${to} is ${Math.round(wait)} s away`, log };
      await sleep(wait + 3);

      const down = railHarness.alight();
      if (!down.alighted) return { pass: false, why: 'E did not get us off', log, down };
      // Half a second to settle: "on solid ground" is a claim about where a body
      // comes to rest, not about the frame it was put down on.
      await sleep(0.6);
      const p = player.position;
      const stn = (railNetwork?.stations ?? []).find((st) => st.name === to);
      const metres = stn ? Math.hypot(p.x - stn.x, p.z - stn.z) : NaN;
      const pass = player.onGround && metres < 140;
      log.push(`off at ${to}, ${metres.toFixed(0)} m from the station's own anchor`);
      return {
        pass,
        log,
        at: [+p.x.toFixed(1), +p.z.toFixed(1)],
        feet: +(p.y - EYE_HEIGHT).toFixed(2),
        onGround: player.onGround,
        health: +playerCombat.health.toFixed(1),
        metresFromStation: +metres.toFixed(1),
      };
    },
  };

  function simulate(dt: number): void {
    // WORKSTREAM W: the tick's wall clock, before anything reads a talent. The
    // browser's copy of the same line `Simulation.step` opens with -- see
    // `game/teamfx.fxSetNow` for why exactly one talent needs it.
    fxSetNow(Date.now());
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
    // ...and while driving, on the identical argument one paragraph up: you are
    // doing 22 m/s and you click. The horn is what a left click does instead --
    // see `honkT` -- so unlike the bike this is a click with an *answer*, and
    // the nudge is therefore skipped for a driver.
    const armed = playerCombat.ridingBike === 0 && playerCombat.drivingCar === 0;
    if (playerCombat.drivingCar !== 0 && punchBuffer > 0 && honkT <= 0) {
      honkT = HONK_SECONDS;
      // A real horn, at last. This was `audio.thwack(false)` -- the driving
      // workstream's stand-in, flagged as such -- and it is now two detuned
      // squares under a lowpass, which is what a car horn actually is. See
      // `audio.carHorn`.
      audio.carHorn();
    }
    honkT = Math.max(0, honkT - dt);
    // --- Workstream H: and the horn from the *other* side. A car stuck behind
    // somebody standing in its lane leans on it after a second. Client-side and
    // deliberately so -- see `world/drivencars.HonkWatch`: a horn is a sound and
    // nothing else, and the client is the only process that knows where the
    // player's ears are.
    if (
      honkWatch.update(
        traffic,
        player.position.x,
        player.position.z,
        trafficTick(Date.now()),
        dt,
        playerCombat.drivingCar === 0 && playerCombat.ridingBike === 0,
        honkScratch.routes,
        honkScratch.pose,
      )
    ) {
      // At a short distance rather than at zero: it is somebody else's horn, a
      // few metres behind you, and `carHorn`'s attenuation is what says so.
      audio.carHorn(4);
    }
    input.punch = armed && punchBuffer > 0;
    input.throwBall = armed && throwBuffer > 0;
    if (playerCombat.ridingBike !== 0 && (punchBuffer > 0 || throwBuffer > 0) && rideNudgeT <= 0) {
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
    //
    // The train's pill shares the channel and takes precedence, on the same
    // "asked what is true, every tick" contract: there is exactly one derived
    // line and the two states it can be about are mutually exclusive -- you
    // cannot be on a bike and on a train.
    let trainPill = '';
    boardable = false;
    if (railBake && playerCombat.phase !== 'ko') {
      if (isAboard(playerCombat.aboard)) {
        trainPill = rideBanner(railBake, playerCombat.aboard, railSeconds(Date.now()), rideText)
          ? (rideText.doorsOpen
            ? `${rideText.line} · ${rideText.next} — E to get off`
            : 'E to get off — at speed, it hurts')
          : '';
      } else {
        // The offer, from the same function `E` will ask and the server will
        // adjudicate, so what the pill promises is what the key delivers.
        const feet = player.position.y - EYE_HEIGHT;
        const t = railSeconds(Date.now());
        boardable = findBoarding(railBake, player.position.x, feet, player.position.z, t, boardOffer);
        if (boardable) {
          const dir = dirOf(railBake, boardOffer.line, boardOffer.dir);
          const towards = dir && dir.stops.length > 0 ? dir.stops[dir.stops.length - 1].name : '';
          // Which door, and not only that there is one. See `doorMarker`: the
          // pill and the marker are one answer shown twice, and the pill is the
          // half that survives a player who is looking the other way.
          trainPill =
            `E — board the ${dir?.line.id ?? ''} to ${towards} · carriage ${boardOffer.car + 1}`;
          doorMarker.aim(boardOffer.wx, boardOffer.wy, boardOffer.wz, true);
        } else {
          // --- Not in reach, but there may still be a train standing here with
          //     its doors open, and *that* is the reported complaint: "its not
          //     obvious where i board". `nearestDwell` asks the same three
          //     questions `findBoarding` asks and answers them from any
          //     distance, so this is the same doorway, named before it is
          //     reachable rather than only once the player has stumbled into it.
          const near = nearestDwell(railBake, player.position.x, feet, player.position.z, t);
          if (near !== null && near.metres < BOARD_HINT_M && Math.abs(near.rise) < 6) {
            trainPill =
              `${near.line} at ${near.station} — doors ${Math.round(near.metres)} m away, walk to them`;
            doorMarker.aim(near.wx, near.wy, near.wz, false);
          } else {
            doorMarker.hide();
          }
        }
      }
    }
    if (isAboard(playerCombat.aboard) || playerCombat.phase === 'ko' || !railBake) doorMarker.hide();
    // The sun button's line shares this one channel and takes precedence over
    // both, on the same "asked what is true, every tick" contract and for the
    // same reason `pressMount` puts it first: it is only ever non-empty inside
    // 2.5 m of one point in Sydney Park, where nothing else on this key can be
    // offering anything. See `world/sunbutton.SunFeature.prompt`.
    // --- Is there a car within reach? Asked every frame and stored nowhere,
    //     which is `bikes.ridePrompt`'s rule: a prompt that is *set* has to be
    //     *cleared*, and every state that ends without pressing a key strands
    //     it. `takePrompt` is a pure function of what is true now.
    //
    // The lookup runs only when the player is on foot and could actually take
    // something, so the cost outside that -- which is nearly all of the time --
    // is three comparisons.
    takeableNear = false;
    if (playerCombat.drivingCar === 0 && playerCombat.ridingBike === 0 && playerCombat.phase !== 'ko') {
      const cars = carWorld();
      const feet = player.position.y - EYE_HEIGHT;
      for (const car of cars.all()) {
        if (car.driverId !== 0) continue;
        const dy = car.y - feet;
        if (dy > TAKE_HEIGHT || dy < -TAKE_HEIGHT) continue;
        const dx = car.x - player.position.x;
        const dz = car.z - player.position.z;
        if (dx * dx + dz * dz <= TAKE_RADIUS * TAKE_RADIUS) {
          takeableNear = true;
          break;
        }
      }
      if (!takeableNear) {
        takeableNear = resolveTake(
          traffic,
          player.position.x,
          feet,
          player.position.z,
          trafficTick(Date.now()),
          takeScratch.routes,
          takeScratch.pose,
          (identity) => cars.suppressed(identity),
          takeScratch.take,
          // WORKSTREAM S. The prompt has to ask the identical question the take
          // will: a pill that says "E — take the car" over a parked car the
          // prediction would refuse is the reported bug's other half.
          staticCars,
        );
      }
    }
    hud.derived(
      sunButton.prompt(player.position.x, player.position.z) ||
        trainPill ||
        ridePrompt(playerCombat, playerCombat.phase, rideNudgeT, rideNudgeText) ||
        takePrompt(takeableNear, playerCombat.drivingCar !== 0, playerCombat.phase),
    );

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
    if (input.mount && !mountHeld && playerCombat.phase !== 'ko') pressMount();
    mountHeld = input.mount;

    // --- WORKSTREAM W: the three talent keys, in the same place and for the
    // same reasons as `E` above -- after reconciliation, before the step.
    //
    // The level bits go on the wire (`net/client.ts` packs them into `buttons`)
    // and the server does every decision. **The one thing predicted here is the
    // dash impulse**, which is `game/abilities.ts`' rule: a dash is 300 ms of
    // travel and the only ability whose whole point is that it is instant. The
    // impulse goes into `playerCombat.body.velocity`, which `combat.advance` is
    // about to integrate through the collision world on this same tick, and
    // `net.reconcile` corrects it from the next snapshot exactly as it corrects
    // a mount.
    //
    // `V` is shared with the third-person camera toggle, and the ability wins
    // when the player has one -- see the key handler for why that is a question
    // for the owner rather than a decision this workstream should be making.
    tickTalentKeys(playerCombat, input, keys);

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

    // --- `input.yaw` changes frame at the seam. See `wasAboard`.
    //
    // Done here, after everything that can start or end a ride this tick and
    // before the step that reads it, and driven off the *state* rather than off
    // the transitions -- so a ride that ended because the server said so, or
    // because the train reached its terminus, or because a respawn moved the
    // body, converts exactly as one that ended with `E`.
    {
      const nowAboard = isAboard(playerCombat.aboard);
      if (nowAboard !== wasAboard) {
        if (nowAboard) {
          // Into the carriage's frame. `predictBoard` has already put the same
          // subtraction on `playerCombat.aboard.yaw`; this is the copy the mouse
          // keeps writing to.
          if (railBake && aboardFrame(railBake, playerCombat.aboard, railSeconds(Date.now()), rideFrame)) {
            lastRideYaw = frameYaw(rideFrame);
            input.yaw -= lastRideYaw;
          }
        } else {
          // And back out, using the bearing the carriage had on the last tick it
          // existed -- which is the only one available once the ride is over, and
          // is within a degree of the one it had a sixtieth of a second ago.
          input.yaw += lastRideYaw;
          lastRideYaw = 0;
        }
        wasAboard = nowAboard;
      } else if (nowAboard && rideActive) {
        lastRideYaw = frameYaw(rideFrame);
      }
    }

    for (const f of fighters) {
      // The one seam trains put in this loop, and it is `sim.step`'s verbatim:
      // the local body is moved into its carriage's coordinates, stepped by the
      // same unchanged `advance` against a floor and four walls, and composed
      // back out. Everybody else is stepped against Sydney. See `game/riding.ts`.
      const self = f.combat === playerCombat;
      const events = advance(f.combat, f.input, dt, self ? enterCarriage() : combatWorld);
      if (self) exitCarriage();

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
          let crime = hit.kind === NPC_KIND.POLICE
            ? REASON.ASSAULT_POLICE
            : wild
              ? REASON.WILDLIFE
              : strikeCrime(hit);
          if (!online) {
            const strike = strikeNpc(factions, hit, 1, playerName, playerCombat.id, tick);
            if (strike.landed) audio.thwack(strike.down);
            // **The swing and the result are two different charges.** Hitting a
            // constable is a 2-star response and putting one on the ground is a
            // 3-star one, which is not a distinction one reason code can carry
            // -- see `game/heat.CRIME_POINTS`. Offline only, because online the
            // server has already re-run the strike against its own actors and
            // has already made this call in `sim.hitNpc`; this client's copy is
            // a *prediction* and it does not know whether its swing landed on
            // the authority's actor at all.
            if (hit.kind === NPC_KIND.POLICE && strike.down) crime = REASON.MURDER_POLICE;
          }
          if (hit.kind === NPC_KIND.POLICE || wild) predictInvestigation(crime);
          else if (crime !== REASON.NONE) accuse(hit.x, hit.z, crime, tick);
          // --- Workstream E's two consequences of a landed swing.
          //
          // **The tradie decks you back.** Offline this is the whole of it;
          // online `server/sim.hitNpc` has already made the same call against
          // its own actor and this one is a no-op on a mirror the next snapshot
          // overwrites. It is called unconditionally because it is a no-op for
          // every kind but one -- no `switch` at a call site.
          characterStruck(hit, playerCombat.id);
          // **And the influencer posts it.**
          //
          // A HUD notice rather than anything on the wire, and the reason is
          // `pushKill`'s a few hundred lines up, stated there in full: the
          // snapshot carries no cause for an NPC going down, and inventing a
          // cause byte for a line of text would be a protocol change for a
          // joke. So the line names *you* on your own screen -- you are the one
          // process that knows you did it -- and reads impersonally to anybody
          // else inside `POSTED_RANGE` who watched an influencer hit the
          // footpath. That is a real limitation against the brief, which asked
          // for a notice naming you to everybody within a hundred metres, and it
          // is the honest half of it rather than a protocol bump.
          if (hit.kind === NPC_KIND.INFLUENCER) {
            hud.notice(feedLine(POSTED_LINE, 'you'));
          }
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
    // --- The cars, offline, on the bikes' own terms one block down.
    //
    // `server/sim.stepCars` runs the identical sweep in the identical place. The
    // whole of what it does here is carry an occupied car to its driver and
    // leave any whose driver has stopped driving standing in the road -- which
    // offline is what drops the car when the player is batted out of it,
    // knocked out, or respawns. Online it is skipped: `net.cars` is a mirror the
    // server corrects, and sweeping it here would be this client inventing state
    // the next `MSG.CARS` would contradict.
    //
    // The knockdown and the recycling are deliberately *not* predicted. Both are
    // consequences with a name attached -- a crime reported, a record deleted --
    // and a client that guessed either would be a client that undid its guess
    // when the server disagreed. (The **crash damage** is the exception and is
    // predicted, one block down: it is a number the driver's own integrator
    // already produced, and 50 ms of the health bar not moving on the frame you
    // hit the wall is exactly the lag the prediction exists to remove.)
    if (!online && localCars.size > 0) {
      driverViews.length = 0;
      for (const f of fighters) {
        const c = f.combat;
        driverViews.push({
          id: c.id,
          drivingCar: c.drivingCar,
          carSpeed: c.carSpeed,
          x: c.body.position.x,
          feetY: c.body.position.y - EYE_HEIGHT,
          z: c.body.position.z,
          yaw: c.body.yaw,
        });
      }
      for (const car of localCars.follow(driverViews)) {
        // A car left within reach of a kerb bay is snapped into it, so it reads
        // as parked rather than as abandoned at an angle. `sim.parkOnLeave` runs
        // the identical two calls in the identical place; offline this *is* the
        // authority. See `traffic.nearestBay`.
        const bay = nearestBay(traffic, car.x, car.z, PARK_SNAP_RADIUS, takeScratch.routes, carBayProbe);
        snapToBay(car, bay ? carBayProbe : null);
      }
    }

    // --- Workstream H, on the shared path: the crash damage, the health mirror
    // and the roster the traffic yields to. All three run **online as well**,
    // which is the one thing that separates this block from the offline sweep
    // above it, and each has its own reason:
    //
    //   - the **health mirror** is read by `stepCarSpeed` inside
    //     `combat.advance`, so a damaged car has to be slow in the prediction or
    //     the driver rubber-bands every time they touch the throttle. The number
    //     comes from whichever field is authoritative -- `net.cars` online -- so
    //     this is a copy and never an opinion. See `driving.DriveState.carHealth`.
    //   - the **crash damage** is drained off the combatant that `advance` filled
    //     and applied to the local mirror through the same `CarField.damage` and
    //     the same `crashDamage` curve the server runs, so the bar moves on the
    //     frame of the impact and the next `MSG.CARS` confirms it. Online the
    //     server's answer wins unconditionally (`CarField.adopt`).
    //   - the **blockers** feed `traffic.HoldLedger`, and both ends must publish
    //     the same roster from the same records or the client draws a queue the
    //     server does not hit-test. `sim.publishBlockers` is the identical sweep.
    {
      const cars = carWorld();
      const c = playerCombat;
      c.carHealth = c.drivingCar === 0 ? CAR_HEALTH_MAX : cars.get(c.drivingCar)?.health ?? CAR_HEALTH_MAX;
      const dv = c.carCrashDv;
      // WORKSTREAM Y: the head-on-ness of that impact, drained with it. The
      // *damage* is scaled by it and the *sound* deliberately is not -- a
      // glancing hit at 40 m/s is still a loud noise even though it is a cheap
      // one. `sim.stepCars` drains the identical pair; see
      // `combat.CombatantState.carCrashHeadOn` and `driving.GLANCING_FLOOR`.
      const headOn = c.carCrashHeadOn;
      c.carCrashDv = 0;
      c.carCrashHeadOn = 1;
      if (dv > 0 && c.drivingCar !== 0) {
        const cost = crashDamage(dv, headOn);
        // The sound is on the **delta-v** and not on whether the damage landed,
        // which is deliberate: the cooldown swallows the four ticks of grinding
        // after a crash but the player still touched something, and silence
        // there would read as the collision not having happened. A hit inside
        // the cooldown gets the scrape; a hit that costs health gets the crunch.
        // See `audio.carCrunch`.
        if (cost > 0 && cars.damage(c.drivingCar, cost) !== null) {
          audio.carCrunch(Math.min(1, dv / DRIVE_TOP_SPEED));
        } else {
          audio.carScrape();
        }
      }
      // WORKSTREAM T: and the same again for the **ambient fleet**, which the
      // wall path above cannot see. A schedule car is a closed-form lookup and
      // not a collision prism, so `combat.crashFromClamp` never notices one --
      // driving into a bus used to be free, and the only thing that happened was
      // that `traffic.applyCarHit` threw you out of your own car, which is the
      // owner's report. `traffic.canBeRunDown` ended the second half; this is
      // the first. `server/sim.stepCars` runs the identical call with the
      // identical arguments, so this is a prediction and not a second opinion --
      // and the server's `MSG.CARS` corrects it either way (`CarField.adopt`).
      //
      // The local player's car only, exactly like the wall above it: another
      // player's crash is theirs to predict and arrives here as a health byte.
      if (c.drivingCar !== 0) {
        const mine = cars.get(c.drivingCar);
        if (mine !== undefined) {
          const into = crashIntoTraffic(
            traffic, mine, trafficTick(Date.now()), carRoutes, carCrashPose, carPose, drivenCars.suppress,
          );
          if (into > 0) {
            if (cars.damage(mine.id, crashDamage(into)) !== null) {
              audio.carCrunch(Math.min(1, into / DRIVE_TOP_SPEED));
            } else {
              audio.carScrape();
            }
          }
        }
      }
      // The clocks. `CarField.age` removes nothing -- see `game/driving.ts`
      // section 6 -- and online the cooldown it advances is the *prediction's*,
      // which is why it runs on the mirror as well as on the authority.
      cars.age(FIXED_DT * 1000);
      // --- WORKSTREAM Y: **offline, this client is the authority for the bang.**
      //
      // Online the server owns it (`sim.stepCarFires`) and this end is told by a
      // `CARS` removal plus a `CARBOOM`; offline there is no server, so the same
      // two things have to happen here or a wreck in `?offline` burns quietly
      // for the rest of the session and never goes off -- which would make the
      // offline build a *different game* rather than the same one without a
      // room, which is the property `game/driving.ts`' header calls out about
      // `CarField` being the authority offline.
      //
      // Deliberately **not** the whole of `explodeCar`: there is nobody else to
      // hurt in an offline session but the local player and the crowd, and the
      // chain, the crime and the credit are all things only a room has. What is
      // reproduced is the part a player can see -- the car ceases to exist, the
      // identity stays scorched, and the boom and the ring fire through the same
      // `onTeamEvent` the server would have driven.
      if (!online) {
        for (const car of cars.all()) {
          if (!fuseExpired(car.burningMs)) continue;
          cars.scorch(car.carId);
          cars.remove(car.id);
          if (playerCombat.drivingCar === car.id) {
            playerCombat.drivingCar = 0;
            playerCombat.carSpeed = 0;
            playerCombat.carHealth = CAR_HEALTH_MAX;
          }
          onTeamEvent(TEAM_EVENT_KIND.CARBOOM, car.x, car.y, car.z, Date.now() + BOOM_RING_S * 1000);
        }
      }
      // Rebuilt **in place**, on `sim.publishBlockers`' argument exactly: this
      // runs every tick over up to four hundred records and an array of four
      // hundred object literals a tick is the only thing in the block that could
      // allocate.
      let n = 0;
      for (const car of cars.all()) {
        const size = CAR_BODY_SIZE[car.body] ?? CAR_BODY_SIZE[0];
        const slot = carBlockers[n];
        if (slot === undefined) {
          carBlockers.push({ x: car.x, y: car.y, z: car.z, halfLength: size.length * 0.5 });
        } else {
          slot.x = car.x;
          slot.y = car.y;
          slot.z = car.z;
          slot.halfLength = size.length * 0.5;
        }
        n++;
      }
      carBlockers.length = n;
      traffic.held.setBlockers(carBlockers);
    }

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

    // --- The console's staged serve, if one was asked for. See `sydney.serve`.
    // Ahead of the swat sweep below, so a ball whose countdown expires on this
    // tick is in the air in time for the blade that was aimed at it.
    if (pendingServe !== null) {
      pendingServe.t -= dt;
      if (pendingServe.t <= 0) {
        const c = pendingServe.combat;
        // Aimed **here**, on the tick the ball actually leaves the hand, and not
        // when `serve()` was typed. A dummy's yaw is written by its own input
        // through `controller.step` on every one of the ticks in between, so a
        // heading set at request time is gone by the next one -- and the ball
        // sails off down the street at whatever the walk cycle was thinking
        // about. This block runs *after* the fighters' `advance` loop above, so
        // what it writes survives to `spawnFooty` and is overwritten again next
        // tick, which is exactly the window it needs.
        c.body.yaw = Math.atan2(
          -(player.position.x - c.body.position.x),
          -(player.position.z - c.body.position.z),
        );
        c.body.pitch = 0;
        localBalls.add(c);
        pendingServe = null;
      }
    }

    // --- F: every bat that is mid-swing, against every ball in the air.
    //
    // `server/sim.ts` runs the identical sweep in the identical place -- before
    // the ball step, so the deflected velocity is what the very next line
    // integrates and the ball turns round on the tick the blade reached it
    // rather than 16 ms and 0.7 m later.
    //
    // **Offline only**, on exactly the argument the swing's own `!online` guard
    // makes above: online the server decides who was hit and this client would
    // be adjudicating against remote balls it draws 100 ms in the past. What
    // arrives instead is `EVENT.SWAT`, which carries the corrected ball state --
    // see `netHandlers().onSwat`. Nothing about the *feel* is lost by that,
    // because the bat's own hit sound is already server-driven online for the
    // same reason.
    //
    // `back` is zero here: offline this client is the authority and its own
    // screen is the simulation, so there is no view lag to compensate for.
    if (!online) {
      for (const f of fighters) {
        // Spec 9's dummies do not swat, which is `server/sim.ts`'s rule about
        // its bots on this side of the wire: neither has any model of a ball in
        // the air, so every swat one landed would be a swing thrown for some
        // other reason that happened to catch -- a coin flip wearing a skill
        // mechanic, which is exactly what the suggestion this implements is
        // about. Keeping the two paths agreed also keeps the offline stub a
        // real test of the online one rather than a livelier version of it.
        if (f.dummy) continue;
        const ball = swatBalls(f.combat, localBalls.balls, dt, 0, swatScratch);
        if (ball === null) continue;
        swatFeedback(f.combat === playerCombat, ball.x, ball.y, ball.z);
      }
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
        //
        // The **owner**, not the thrower: a ball somebody batted back belongs to
        // whoever returned it, so it is their pip and their knockout. For every
        // ball nobody swatted the two are the same fighter. See
        // `footy.Footy.owner`; `server/sim.ts` reads the same field in the same
        // place.
        applyFootyHit(fighterOf(e.ball.owner)?.combat ?? playerCombat, e.victim, e.ball, ballReport);
        audio.footyHit(ballReport.ko);
        onFootyHit(ballReport);
        // "%s returned serve on %s" -- the line the whole feature is for.
        // Offline the feed is written here, where online `netHandlers().onHit`
        // writes it off `EVENT_FLAG.RETURNED`. `who` offline has no roster to
        // consult, so the local player is named directly, exactly as the
        // run-over line below this does it.
        if (ballReport.ko && e.ball.owner !== e.ball.thrower) {
          const name = (id: number): string => (id === playerCombat.id ? 'you' : who(id));
          pushKill(`${name(ballReport.attacker)} returned serve on ${name(ballReport.victim)}`);
        }
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
        // And the heat ladder, **after** the factions rather than before: the
        // crimes reported during the last tick are drained by
        // `FactionField.step`, which is what calls `accuse`, which is what feeds
        // the ladder. Running it first would put every crime a tick late and
        // would make a 3-star escalation arrive after the officers it brings.
        // `server/sim.stepFactions` puts it in exactly the same place.
        stepHeat(ctx, heat, heatWorld);
        // And workstream E's, in the same place and for the same reason.
        // `sweepEvents` runs first so that an event which ended this tick frees
        // its promoted slot before `stepEvents` tries to spend it; see
        // `server/sim.stepFactions`, which states the same ordering.
        sweepEvents(ctx);
        stepCharacters(ctx);
        stepEvents(ctx);
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
        // Nobody on a train is run over by a Camry. `server/sim.ts` makes the
        // identical check in the identical place, which is what keeps this a
        // prediction rather than a second opinion -- see its comment for the
        // argument.
        if (isAboard(f.combat.aboard)) continue;
        // The suppression predicate, and without it the first thing that happens
        // after you steal a car is that its ambient copy runs you over from
        // inside the seat you are sitting in. `server/sim.ts` passes the
        // identical one at the identical point, which is what keeps this a
        // prediction rather than a second opinion.
        const car = carHitting(traffic, f.combat, tick, carRoutes, carPose, drivenCars.suppress);
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
    //
    // **The velocity goes with it, and it is the post-step one because of where
    // this line is.** `net.sendInput`'s header states that contract in full; the
    // short version is that the reconciler replays from the acknowledged
    // position and needs the velocity the body had *there*, which is the one
    // this tick has just finished producing. Read after everything above that
    // can touch it -- the step, and the car shove, which both ends apply in the
    // same place in their own loop -- so it is the body as this tick leaves it,
    // which is the thing the server will acknowledge.
    // The velocity recorded against this seq is the one the reconciler's replay
    // will start from -- see `NetClient.sendInput`'s ordering contract and
    // `ackedVelocity`. For a rider that has to be the **carriage-local**
    // velocity, because the replay runs in the carriage's frame: seeding it with
    // the world velocity would start every replay with the train's own 44 m/s
    // rotated into the aisle, which is the acceleration-ramp bug at forty times
    // the scale.
    if (net) {
      if (isAboard(playerCombat.aboard)) {
        rideVelocity.set(playerCombat.aboard.vx, playerCombat.aboard.vy, playerCombat.aboard.vz);
        net.sendInput(input, rideVelocity);
      } else {
        net.sendInput(input, playerCombat.body.velocity);
      }
    }
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
   * The chase camera's numbers -- the *rendering* half. How far back the player
   * asked to be is `cameraDistance`, above, and none of these may write it.
   *
   * `CHASE_OPEN` is the only thing left of the old 3.5-4.5 m range: the boom
   * opens by up to a metre as the body winds up to 26 m/s, which is the cheapest
   * way to make a bike read as fast. It is scaled *down* as the chosen distance
   * grows -- a player already sitting at 11 m does not need another metre, and
   * would only get the far clamp -- so it is a metre of drama at the near stop
   * and nothing at the far one. `CHASE_LIFT` is the brief's 1.5 m over the
   * *eye*, which puts it about head height above a rider.
   *
   * How far back it can *get* is `camera.marchCameraBoom`, which owns the probe
   * length, the refinement and `CHASE_RADIUS` -- it is over there rather than
   * here because those three are the numbers a long boom broke, and
   * `verifyCamera` marches them against walls a millimetre apart to prove the
   * camera neither tunnels through one nor hops along it.
   *
   * `CHASE_NEAR` is how close the pull-in may drive it -- inside that the
   * player's own body fills the frame and first person is the better answer, but
   * snapping to first person on a wall would be a jump cut, so it stops instead.
   * `CHASE_FLOOR` keeps it off the pavement on a downhill.
   */
  const CHASE_OPEN = 1.0;
  const CHASE_LIFT = 1.5;
  /**
   * And the lift inside a carriage, which is a different number for a reason.
   *
   * 1.5 m over a body whose eye is already 1.68 m puts the boom at 3.2 m, and a
   * Tangara's lower saloon has 2.03 m of headroom. So the ordinary chase camera
   * aboard a train is a camera pressed against the air-conditioning grille --
   * which is exactly what it was, and which the `insideCarriage` clamp faithfully
   * kept it inside of while producing a picture of nothing.
   *
   * The fix is not to abandon third person in here, because the aisle is the one
   * place in this game with 9 m of clear room *behind* a player and it is worth
   * looking down. It is to take the lift out: at 15 cm the boom runs level down
   * the carriage, past the poles and the stairwell, and the clamp only ever bites
   * on the bulkhead at the end. `verifyCamera`'s march is untouched -- this is
   * the height it is asked about, not the rule it applies.
   */
  const RIDE_CHASE_LIFT = 0.15;
  const CHASE_NEAR = 0.9;
  const CHASE_FLOOR = 0.4;
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
   * Where the torch is held this frame, and the scratch its hand case needs.
   *
   * Both reused, because this is filled every frame of every night and a mount
   * allocated per frame is a garbage collection in the middle of a fight. See
   * `world/nightlights.TorchMount`.
   */
  const torchMount = createTorchMount();
  const _chest = new Vector3();
  /**
   * Catches a throw out of the frame's render call so it cannot stop the world
   * in silence. Built here rather than at module scope so its failure count is
   * per-session, which is what `sydney.render.report()` is answering.
   */
  const renderGuard = new RenderGuard();
  /**
   * WORKSTREAM AB: where this frame went, section by section.
   *
   * Built here, in the loop's closure, beside `frameTimes` -- which is the one
   * number this replaces nothing of and completes: `medianFrameMs` says a frame
   * cost 9 ms and this says which nine. Always measuring, on
   * `server/profile.ts`'s argument that a profile behind a flag is a profile
   * that is off the day something regresses; only the *strip* is behind
   * `?perf=1`, because a DOM write at 165 Hz is not free and the measurement is.
   *
   * `sydney.frame()` prints the same table from the console. See
   * `client/src/frameprofile.ts`.
   */
  const frameProfile = new FrameProfile();
  const frameOverlay = new FrameOverlay(new URLSearchParams(location.search).get('perf') === '1');

  // --- The scene pass: the half of the warm-up that has to happen down here.
  //
  // Everything above `hud.ready` compiled *stand-ins* -- a throwaway mesh with
  // the same material and the same attribute layout as the real thing, which is
  // all a pipeline is keyed on for an ordinary mesh. That is why it can run
  // before the far layer, the collision world and every renderer in this file
  // exist, and it is why the first terrace and the first shot no longer hitch.
  //
  // It cannot work for an `InstancedMesh`. Three appends `object.uuid` to the
  // node-builder cache key for anything instanced (`getMaterialCacheKey`,
  // unconditionally, with a TODO pointing at three.js#29066, because the
  // instance matrix is baked into the node graph as a uniform buffer over that
  // mesh's own array), so a stand-in's pipeline is never the pipeline the real
  // mesh draws with. The only way to warm an instanced set is to compile the set
  // itself -- and the world-wide ones do not exist until here: the traffic's six
  // movers, the crowd's six impostor sets, the flock's five, the bikes and their
  // beacon, the gulls, the headlights and tail lights.
  //
  // So one `compileAsync` over the real scene, immediately before the first
  // frame is issued. Nothing has been rendered yet -- `setAnimationLoop` below
  // is what starts that -- so this is the last moment at which a compile is
  // free, and every one of those sets is in the scene and `frustumCulled = false`
  // by now, which is what makes the walk reach them wherever the camera points.
  //
  // Streamed tiles are *not* covered here and do not need to be: they arrive
  // over the following minutes and each is compiled by `setPrecompiler` above,
  // on the same argument. See `world/warmup.ts`.
  // The star field and the moon hide themselves whenever they would draw
  // nothing, which is every daylight frame -- and `_projectObject` skips an
  // invisible object in the `compileAsync` walk exactly as it does in `render`.
  // So if the boot ever happens in daylight *and* anything has called
  // `sky.update()` before this line, their two pipelines would be compiled the
  // first time the sun went down: a dropped frame at dusk, which is the lesson
  // this file has already paid for twice.
  //
  // Nothing renders before `setAnimationLoop` below, so as the boot stands today
  // both are still at their constructor default of visible and this line is
  // redundant. It is here because "redundant today" is exactly the state the
  // previous two instances of this bug were in.
  sky.stars.visible = true;
  sky.moon.visible = true;
  const scenePass = await withDeadline(
    renderer.compileAsync(scene, camera),
    // WORKSTREAM AB: the shader budget, not the asset one. This pass reaches
    // every instanced set in the world and is the only thing that can -- see
    // the paragraph above -- so timing it out is not "we lose the skyline", it
    // is "every instanced draw in Sydney compiles inside the frame it first
    // appears". `SHADER_WARMUP_DEADLINE_MS` carries the argument.
    SHADER_WARMUP_DEADLINE_MS,
    'the scene shader pass',
  );
  console.debug(
    `[warmup] scene pass ${scenePass === null ? 'timed out' : 'done'}; ` +
      `pipelines ${(renderer as unknown as { _pipelines?: { caches?: Map<unknown, unknown> } })._pipelines?.caches?.size ?? -1}, ` +
      `shaders ${renderer.info.memory.programs}`,
  );

  renderer.setAnimationLoop(() => {
    const now = performance.now();
    // Clamp the frame delta: a tab that was backgrounded must not run hundreds of
    // simulation steps on return.
    const frameDt = Math.min((now - last) / 1000, 0.25);
    last = now;

    // WORKSTREAM AB: the frame opens here and closes at `frameProfile.stop()` at
    // the very bottom, and between the two every nanosecond is charged to a
    // section. `begin` is before the first line of real work rather than before
    // `performance.now()` above, so the clock read this loop already makes is
    // not charged twice.
    frameProfile.begin();
    frameProfile.at(FSEC.input);
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
    // And the wheel, on the bars' own terms exactly -- see the paragraph above,
    // which is the whole argument for why steering is an input remap and not a
    // second integrator. `shapeDriveSteering` leaves a walker and a cyclist
    // alone, so this composes rather than competing. The car's *signed* speed
    // is passed, not the body's ground speed, because reversing has to invert
    // the wheel and a plan speed has no sign.
    shapeDriveSteering(
      playerCombat,
      (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0),
      playerCombat.carSpeed,
      frameDt,
      driveSteering,
    );
    if (playerCombat.drivingCar !== 0) {
      input.right = driveSteering.right;
      input.yaw += driveSteering.yawDelta;
    }

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

    frameProfile.at(FSEC.sim);
    accumulator += frameDt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < 8) {
      simulate(FIXED_DT);
      accumulator -= FIXED_DT;
      steps++;
    }

    frameProfile.at(FSEC.camera);
    // --- The rail clock, once a frame, for everything that has to agree about
    //     where a train is on *this* frame.
    //
    // Read here and passed down rather than read again at each of the three
    // sites, because `Date.now()` is a millisecond and an express does 4.4 cm in
    // one: a passenger composed against 14:22:07.412 standing inside a carriage
    // drawn at 14:22:07.413 is a passenger 4 cm behind the floor, every frame,
    // for the whole journey.
    const railNow = railSeconds(Date.now());

    // --- A rider's world position is recomposed **every frame**, not every tick.
    //
    // This is the line that makes riding look right, and leaving it out is the
    // one mistake this architecture makes easy to make. The fixed step composes a
    // world position at the instant of that step; the renderer runs at up to
    // 165 Hz and the carriages are drawn at present time, because a train is a
    // pure function of the clock and there is nothing to interpolate. Between
    // the two there can be a whole frame of clock, which at 44 m/s is 70 cm --
    // so the body would slide backwards through the floor and snap forward on
    // each tick, sixty times a second, at a metre of amplitude.
    //
    // Composing here costs nine multiplies and fixes it exactly: the passenger
    // and the vehicle are evaluated at the same instant, so the floor is
    // stationary under them no matter what the frame rate is doing. It writes
    // `AboardSlot.w*` as it goes, which is what the next tick's `enterLocal`
    // compares against -- so this counts as "the ride moved the body" rather
    // than as a teleport, which is exactly what it is.
    rideAboardForCamera = null;
    if (railBake && isAboard(playerCombat.aboard)) {
      if (aboardFrame(railBake, playerCombat.aboard, railNow, rideFrame)) {
        projectAboard(playerCombat.aboard, player, rideFrame);
        const dir = dirOf(railBake, playerCombat.aboard.line, playerCombat.aboard.dir);
        rideAboardForCamera = dir === null
          ? null
          : interiorOfCar(consistOf(dir, playerCombat.aboard.trip), playerCombat.aboard.car);
      }
    }

    applyToCamera(player, camera);
    // --- Workstream O: aboard a train the **view** sits 0.12 m lower.
    //
    //   > *"make the camera slightly lower when on the train"*
    //
    // A camera term and nothing else, in the same seam as the knockout drop below
    // and the third-person boom further down: the simulation is finished and
    // correct by this line, and what is being changed is only where it is looked at
    // from. Nothing here is written back into `PlayerState` -- so the body, the
    // capsule, the gangway clearance, the boarding heights and the wire are all
    // untouched, which is `game/riding.RIDER_VIEW_DROP_M`'s whole argument. The
    // condition is the level test every other ride term in this loop uses rather
    // than an event, because a ride can end for reasons nothing fires for.
    const rideView = isAboard(playerCombat.aboard);
    camera.position.y = riderViewEye(camera.position.y, rideView);
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
    // **Riding puts a floor under the distance** rather than overwriting it, so
    // getting off a bike returns you to exactly what you had before rather than
    // leaving you in a camera you never asked for. `liveCameraDistance` is that
    // one `Math.max` and is called every frame rather than on the mount event,
    // because a ride can end for reasons no event fires for. See
    // `game/camera.ts`.
    let chosenDistance = liveCameraDistance(cameraDistance, playerCombat.ridingBike !== 0);
    // --- And a car, which is a bigger thing to look at than a bicycle.
    //
    // A **floor and never a ceiling**, exactly as `liveCameraDistance` treats the
    // ride: a driver who has asked for 12.8 m keeps 12.8, a driver in first
    // person gets 7 m for the duration, and their own choice comes back the
    // moment they get out. Nothing here writes the preference, which is the
    // property that makes "comes back" true for free -- see `game/camera.ts`.
    //
    // Applied here rather than by widening `liveCameraDistance` because
    // `game/camera.ts` is a file five other workstreams are also editing this
    // week, and a `Math.max` at the one call site says the same thing.
    if (playerCombat.drivingCar !== 0) chosenDistance = Math.max(chosenDistance, DRIVE_CAM_DISTANCE);
    // --- Aboard a train the view is **first person**, and this is the call the
    //     riding round makes after having looked at both alternatives on screen.
    //
    // The brief allowed either: clamp the boom inside the carriage, or fall back.
    // The clamp exists and works -- `blockedAt` below marches the boom against
    // `insideCarriage` in the carriage's own frame and it never leaves the shell
    // -- and the picture it produces is the problem. A Tangara's lower saloon is
    // 2.03 m from floor to ceiling and 2.8 m across, so:
    //
    //   - with the usual 1.5 m of `CHASE_LIFT` the boom is at 3.2 m and the
    //     clamp holds it against the air-conditioning grille. The screenshot is
    //     a close-up of a grille.
    //   - with the lift taken out (`RIDE_CHASE_LIFT`, kept below because it is
    //     the right number for the frames either side of this decision) the boom
    //     runs level down the aisle and ends up inside the back of a seat --
    //     because the interior collision is walls, floors and a staircase, and
    //     deliberately has no furniture in it (`game/riding.ts` section 3).
    //
    // There is no boom position in an eight-car double-decker that reads as a
    // third-person camera, and adding seat volumes to make one would be modelling
    // furniture for the sake of a view nobody wants: the inside of a train is the
    // one place in this game that is *better* in first person, because the thing
    // worth looking at is out of the window. So the ride forces it, the preference
    // is untouched, and stepping off puts the player back in whatever they chose.
    const wantThird = isThirdPerson(chosenDistance) && !isAboard(playerCombat.aboard);
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
      // --- Workstream I: and the hands, on the same channel and for the same
      // reason -- `HandsViewmodel.update` writes its own `group.visible` on a
      // knockout, so a `visible` toggle here would be overwritten before the
      // next draw. On the two **meshes** rather than the group, because three
      // tests layers per object and a `Group` is never itself drawn.
      //
      // Unconditionally off in third person and *provisionally* on in first --
      // `setWeaponVisible` runs later in the same frame from `money.frame` and
      // has the last word about whether fists are actually equipped.
      setVisibleToCamera(handsViewmodel.primary, !thirdPerson);
      setVisibleToCamera(handsViewmodel.off, !thirdPerson);
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
      // How far back the camera *wants* to be, before anything is in the way:
      // the distance the player asked for, opened up a little at speed. See
      // `CHASE_OPEN` -- the bonus fades out as the chosen boom grows, so it is a
      // metre of drama on a bike at the near stop and nothing at all at 12.8 m,
      // where it would only be eaten by the clamp anyway.
      //
      // Recomputed from `chosenDistance` every frame rather than accumulated,
      // which is the property that keeps the occlusion pull-in below temporary:
      // `chaseDistance` is where the camera *is* and this is what it is trying to
      // get back to, so backing into a terrace and stepping out again returns you
      // to the boom you chose rather than to wherever the wall left you.
      // How high over the eye the boom sits. Three cases now, and the third is
      // the car: 2.5 m rather than the walker's 1.5, because a car is 4.6 m long
      // and a boom at head height looks along its roof rather than down at it.
      // One `const` rather than the two copies of a ternary this was, because
      // the occlusion march and the placement below have to agree about where
      // the camera is going -- a march at one height and a placement at another
      // is a camera that ducks for walls it is nowhere near.
      const chaseLift =
        rideAboardForCamera !== null
          ? RIDE_CHASE_LIFT
          : playerCombat.drivingCar !== 0
            ? DRIVE_CAM_LIFT
            : CHASE_LIFT;
      const speed = Math.hypot(player.velocity.x, player.velocity.z);
      const want = Math.min(
        CAMERA_MAX,
        chosenDistance +
          Math.min(1, speed / 26) * CHASE_OPEN * Math.max(0, 1 - chosenDistance / CAMERA_MAX),
      );
      // --- Occlusion, as a sphere march rather than a ray cast.
      //
      // `collision.resolve` answers "can a circle of radius r be here", which is
      // exactly the question, and marching it out from the head is what keeps
      // the camera out of the terrace behind you. A ray would pass through a
      // wall's corner and leave the camera inside it; a sphere of the camera's
      // own near-plane radius cannot.
      //
      // The march itself is `camera.marchCameraBoom` -- a fixed step length and
      // therefore a variable number of probes, refined by bisection at the end.
      // Its header carries that argument and `verifyCamera` asserts it; what is
      // left here is the only part that needs the world, which is the question
      // it asks. It runs once a frame against a grid query that is already the
      // cheapest thing in `collision.ts`.
      const headX = player.position.x;
      // Workstream O: the boom pivots about the *camera's* eye, which aboard a
      // train is `RIDER_VIEW_DROP_M` under the body's -- see `riderViewEye` above.
      // The march and the placement have to agree about where the camera is going
      // or the boom ducks for walls it is nowhere near, which is the argument
      // `chaseLift` already makes one `const` up.
      const headY = riderViewEye(player.position.y, rideView);
      const headZ = player.position.z;
      /** Is the boom clear at `d` metres back? */
      const blockedAt = (d: number): boolean => {
        const px = headX - dirX * d;
        const pz = headZ - dirZ * d;
        const py = headY - dirY * d + chaseLift;
        // --- Aboard, the carriage is the only thing in the way, and it is the
        //     only thing that must be.
        //
        // **Clamped inside the vehicle rather than dropped to first person**,
        // and the argument is what the two failures look like. A camera allowed
        // out through the bodyside at 130 km/h does not merely clip -- it is
        // outside a box that is moving, so it spends every frame being left
        // behind and re-caught, and the picture is the carriage strobing across
        // the screen. A forced first person is legible but it takes the third-
        // person view away from the one place in the game with a *room* in it,
        // which is the place it is most worth having: an eight-car interior with
        // a staircase is the best thing this feature has to look at.
        //
        // So the boom marches against the shell in the carriage's own frame,
        // which is exactly the question `insideCarriage` answers, and the city
        // is not consulted at all. It must not be: the warehouse the train is
        // passing through is 4 m away and would pin the camera to the player's
        // ears on every gantry between here and Strathfield.
        if (rideAboardForCamera !== null) {
          worldToLocal(rideFrame, px, py, pz, rideLocal);
          return !insideCarriage(rideAboardForCamera, rideLocal.x, rideLocal.y, rideLocal.z);
        }
        // Against the roofs as well as the walls: a camera that swung up over a
        // warehouse would otherwise end up inside it. Head and feet both at the
        // boom's own height -- a camera is a point, and a 1.8 m head on it would
        // snap the chase in against a soffit the player is walking happily
        // under. See `CollisionWorld.resolve`.
        return (
          collision.resolve(px, pz, px, pz, CHASE_RADIUS, py, py).hit ||
          py < groundHeightAt(px, pz, py) + CHASE_FLOOR
        );
      };
      const reach = marchCameraBoom(want, CHASE_NEAR, blockedAt);
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
      camera.position.y += chaseLift - dirY * chaseDistance;
      camera.position.z -= dirZ * chaseDistance;
      // --- The lean, and it is on the **camera** rather than on the car's body.
      //
      // `world/drivencars.DRIVE_CAM_ROLL` carries the whole argument for why:
      // the box fleet composes every car's matrix from a two-component heading
      // with no third axis in it, deliberately, and adding one for the two cars
      // a room has stolen would fork the draw path for exactly the cars that
      // most need to look like traffic.
      //
      // Added to `rotation.z` after `applyToCamera` has set the yaw and pitch,
      // and taken back out again by the same line next frame because
      // `applyToCamera` assigns rather than accumulates. `feedback.applyToCamera`
      // below is the same seam and the same order.
      if (playerCombat.drivingCar !== 0) {
        camera.rotation.z += drivenCars.camRoll;
        camera.position.y -= drivenCars.camDip * chaseDistance;
      }
    } else {
      // Reset, so stepping back into third person starts at the near distance
      // and eases out rather than appearing at full extension.
      chaseDistance = CHASE_NEAR;
    }

    feedback.setCaffeinated(playerCombat.flatWhiteT > 0);
    feedback.update(frameDt);
    feedback.applyToCamera(camera);

    // --- F: the contact puffs, on the frame delta rather than the fixed step.
    // `main.ts`'s standing rule about presentation, and `swatpuff.ts` restates
    // it: the simulation is fixed so prediction and rewind agree, and a quarter
    // of a second of fade has to be smooth at whatever rate the display runs.
    // Costs a length check on an empty array in every frame but the few after a
    // swat.
    swatPuffs.update(frameDt);

    frameProfile.at(FSEC.hud);
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
    // The train's line goes first and on its own, because it is the one chip in
    // this list that is *navigation* rather than a buff: TRAINS.md's "T1 ->
    // Penrith . next: Blacktown", derived from the bake every frame by
    // `riding.rideBanner` so there is no state to strand. A chip with no
    // countdown draws as a bare label -- see `hud.vitals` -- which is what these
    // are.
    if (railBake && isAboard(playerCombat.aboard)) {
      if (rideBanner(railBake, playerCombat.aboard, railSeconds(Date.now()), rideText)) {
        powerupChips.unshift({
          name: `${rideText.line} → ${rideText.towards} · next: ${rideText.next}`,
          seconds: 0,
        });
      }
    }
    // The speedo, first in the list because while you are driving it is the one
    // number on the HUD that changes every frame. A chip with no countdown draws
    // as a bare label -- see `hud.vitals` -- which is what a speed readout is.
    if (playerCombat.drivingCar !== 0) {
      powerupChips.unshift({ name: `DRIVING · ${speedText(playerCombat.carSpeed)}`, seconds: 0 });
    }
    // --- Workstream H: "you wrote it off", on the **edge** of the health
    // reaching zero.
    //
    // The one thing in this feature that genuinely is an event rather than a
    // state, which is why it is not derived the way `takePrompt` is: a car being
    // written off happens once, and a level test would repost the pill every
    // frame for as long as you sat in the wreck. The health comes from whichever
    // field is authoritative, so this fires on the server's answer online and on
    // the prediction's offline, and never twice for one crash.
    {
      const mine = playerCombat.drivingCar === 0 ? undefined : carWorld().get(playerCombat.drivingCar);
      const health = mine?.health ?? CAR_HEALTH_MAX;
      if (health <= 0 && lastCarHealth > 0) hud.notice('you wrote it off');
      lastCarHealth = health;
      // --- WORKSTREAM Y: and the fire, which is the other genuine *event* on
      // this record and is fired on the same kind of edge and for the same
      // reason -- a level test would repost the pill sixty times a second for
      // the whole six seconds you are meant to be spending getting out.
      //
      // The countdown beside it is the opposite and is deliberately *not* an
      // edge: it is a chip rebuilt from the state every frame, on
      // `drivencars.takePrompt`'s rule, so there is no line anywhere that has to
      // remember to take it down when the car stops existing.
      const burning = mine !== undefined && isBurning(mine.burningMs);
      if (burning && !carWasBurning) hud.notice(BURN_NOTICE);
      carWasBurning = burning;
      if (burning && mine !== undefined) {
        fireGrade(mine.burningMs, localFire);
        powerupChips.unshift({ name: fireChip(localFire.fuseS), seconds: 0 });
        // --- The crackle, and it is a *retrigger* rather than a loop.
        //
        // `game/audio.ts` builds looping chains for the two things that run for
        // minutes -- the siren and the rave -- and each of them costs a graph
        // that has to be faded and torn down. A fire lasts six seconds and is
        // over, so a short burst every `CRACKLE_EVERY_MS`, at the level
        // `carfire.fireGrade` says the fire is at, gets the rising urgency for
        // four lines and nothing to dispose. `audio.carCrackle` is one filtered
        // noise burst; twenty-four of them over a fuse is the sound.
        const now = Date.now();
        if (now - lastCrackleMs > CRACKLE_EVERY_MS) {
          lastCrackleMs = now;
          audio.carCrackle(localFire.crackle);
        }
      }
    }
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
      // --- Workstream H: the car's condition, under the speed chip. Null on
      // foot, which collapses the row. `lastCarHealth` was written a few dozen
      // lines up from the same authoritative field, so this costs nothing and
      // cannot disagree with the notice that fired off it.
      carHealth: playerCombat.drivingCar === 0
        ? null
        // WORKSTREAM Y: the band is `burning` while the car is alight, whatever
        // the health says -- a wreck on fire and a wreck that is merely finished
        // are different situations and the bar is the only thing on screen that
        // can say so at a glance. `index.html` pulses that class.
        : {
          width: carHealthWidth(lastCarHealth),
          band: carHealthClass(lastCarHealth, carWasBurning),
        },
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
    // --- Workstream I: `LVL 1 · 3/10` and an XP bar, under the balance.
    //
    // Workstream G's `lvl 3` line, now carrying the progress under it -- the
    // report was *"i cant se my level or XP anywhere"*, and the level-1
    // suppression that hid it is gone from `hud.level`, `nameplates.levelRow`
    // and nowhere else. Both numbers are off the roster, which is where the
    // ladder lives (see `protocol.RosterEntry.level` and `.kills`), and null
    // offline -- there is no ladder without a server to keep one.
    //
    // `guest` is the browser's own answer rather than anything on the wire, and
    // it has to be: whether somebody has an account is not a fact this room
    // publishes about them (deliberately -- see `RosterEntry`), and the only
    // player whose account status this client is entitled to know is the one
    // sitting at it. `joinGate.signedIn` is true the moment a token exists.
    //
    // Cheap every frame on `hud.money`'s terms: the composed string and the bar
    // width are compared as one key before anything is written.
    //
    // --- Workstream V: the side, and the points that have not been spent.
    //
    // Both off `NetClient`'s `MSG.TALENTS` mirror rather than the roster, which
    // is the message they belong to -- see `MSG.TALENTS` on why the level rides
    // there as well. `hud.level` composes the whole line, chip included, from
    // one record, so the sentence and the chip can never disagree for a frame.
    hud.level(net
      ? {
        level: net.myLevel,
        kills: net.myKills,
        guest: !joinGate.signedIn,
        team: net.myTeam,
        unspent: net.myUnspent,
      }
      : null);
    // The talents panel: refill the aura lookup from where bodies are this
    // frame, then let it open itself at level 2 and redraw if anything moved.
    // Both are one comparison in the ordinary case; see `TalentsPanel.frame`.
    net?.updateTeams(player.position.x, player.position.z);
    talents.frame();
    buildSheet.frame();

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
    // The balance, the piles of cash, the handset and the two prompts. One
    // call, on `minimap.update`'s own terms: presentation, at the frame rate,
    // reading state nothing here owns. See `client/src/money.ts`.
    money.frame(frameDt);

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

    frameProfile.at(FSEC.sky);
    // Night factor drives the lit-window shader. Ramps across civil twilight.
    //
    // Read one line *before* `sky.update()`, which is where the shared day/night
    // clock now advances, so these two uniforms are a frame behind the sky they
    // belong to. Left that way deliberately rather than reordered: the ramp they
    // sit on takes 187 real seconds to cross, so a frame is 0.009% of it, and
    // the alternative is moving lines that the camera work in flight owns.
    const alt = sky.solar.altitude;
    globals.nightFactor.value = 1 - Math.min(Math.max((alt + 5) / 11, 0), 1);
    const d = sky.solar.direction;
    globals.sunDirection.value.set(d.x, d.y, d.z);

    // AB: `sky` closes and `stream` opens on the same line the camera matrix is
    // composed, because that compose exists for the streamer's frustum cull.
    frameProfile.at(FSEC.stream);
    // The camera's world matrix has to be current before either of these: the
    // sky centres the shadow volume on it, and the streamer culls against its
    // frustum -- and since that cull now also decides which tiles reach the
    // depth pass, a frame of lag there is a frame of missing shadows on every
    // turn. `applyToCamera` sets position and rotation only; the renderer would
    // otherwise be the first thing to compose them, one call too late.
    camera.updateMatrixWorld();
    sky.update(camera);
    // The clock, fed the sky's own instant rather than reading `Date.now()` for
    // itself -- which is what makes the HUD agree with the window while somebody
    // is scrubbing from a console. Cheap by construction: it compares four
    // numbers and touches the DOM only when the marker has moved a third of a
    // pixel or the game minute has rolled over. See `sky/clock.ts`.
    clockHud.update(sky.now);
    // The altitude goes with the frustum, and it is not a duplicate of it: the
    // frustum says where the shadow *volume* is, and the altitude is what turns
    // that box into the patch of ground it covers -- which stretches along the
    // sun's bearing by 1/sin(altitude) and is what decides which tiles are told
    // to receive. See `streamer.sunReceiveRange`.
    streamer.update(camera, sky.shadowVolume, alt);
    // --- And, for a rider, where they will be rather than where they are.
    //
    // TRAINS.md's deterministic prefetch. The radial guess `update` just made is
    // sized against a bike: 1,800 m of load radius at 39.4 m/s is 46 s of lead,
    // and the hex manifests reach 2,200 m past that. At 44.4 m/s on an express
    // those become 40 s and a shrinking margin -- but the margin is not the
    // point. The *route* is known, in closed form, so a guess of any radius is
    // strictly worse than the answer: a train on the Bankstown line is not going
    // to be 1,800 m north of here in forty seconds, it is going to be 1,780 m
    // west of here, and half of every disc fetched around a rider is bytes for a
    // suburb they will never enter.
    //
    // Sixty seconds ahead, sampled *along the arc* rather than extrapolated from
    // a heading -- so the lead follows the curve at Redfern and the line through
    // Sydenham instead of leaving the corridor at the first bend. Two samples,
    // at 30 s and 60 s, because one at the far end skips the hexagon in the
    // middle when the streamer's own cell test says nothing changed.
    //
    // Tunnels are the cheap case and get it for free: `poseTrain` puts the
    // sample under the hill, the hexagon there is fetched, and there is nothing
    // in it to build because the city above is untouched.
    if (railBake && isAboard(playerCombat.aboard)) {
      const dir = dirOf(railBake, playerCombat.aboard.line, playerCombat.aboard.dir);
      const pose = dir === null ? null : aboardPose(railBake, playerCombat.aboard, railNow);
      if (dir !== null && pose !== null) {
        for (const lead of [30, 60]) {
          const ahead = poseAheadOnLine(railBake, dir, playerCombat.aboard.trip, railNow + lead);
          if (ahead !== null) streamer.prefetchAt(ahead.x, ahead.z);
        }
      }
    }
    // The skyline, on its own much wider radius. `streamer.update` has just
    // moved the hex manifests along on `approach_m` = 4 km; this moves the far
    // slabs along on `far_cut_m` = 20 km, because a hexagon is visible from
    // five times further away than it is worth knowing the tile list of. Only
    // on a segmented world; `far.hexes` is null on every other. See `FarHexes`.
    if (far.hexes) far.hexes.update(hexesNear(camera.position.x, camera.position.z, far.hexes.cutM));
    // Ambient life, after the streamer so a tile that arrived this frame has its
    // birds in it, and before the render so their matrices are current. It takes
    // `frameDt` rather than reading a clock of its own, which is what makes a
    // backgrounded tab free: no animation frames means no delta, and the clamp
    // above means the frame the tab comes back advances the birds by one step
    // rather than by however long the browser was not drawing.
    streamer.updateLife(frameDt, camera);

    frameProfile.at(FSEC.rail);
    // --- The railway, after the streamer for the same reason everything else
    // is: a tile that arrived this frame has terrain under it, so a viaduct
    // pier built now stands on the ground rather than on the fallback depth.
    //
    // `update` is free on every frame but the two transitions -- crossing a
    // 512 m chunk boundary rebuilds the ring, crossing a 64 m one refills the
    // sleepers -- and there is no clock in it at all. See `world/rail-geo.ts`.
    railWorld?.update(player.position.x, player.position.z);
    // And the trains, on the traffic's own contract one line up from it: no
    // frame delta, no state, and the wall clock read through `railSeconds` so a
    // backgrounded tab costs nothing and comes back with every train in the
    // city exactly where it would have been. `poseTrain` is the same function
    // the server evaluates, so what is drawn here is what the server says.
    if (railBake) {
      trains.update(railBake, railNow, player.position.x, player.position.z);
      // And what those trains are saying, on the identical contract: one call,
      // the same `railNow` the carriages were placed from, and no state on
      // either side of it. `game/rail-audio.ts` turns the timetable into "which
      // sentence, how far in, and how far away"; `game/audio.railAnnounce`
      // turns that into sound. The split, and the single unconditional call
      // per frame, is `raveUpdate`'s two hundred lines down.
      //
      // Aboard, the mix collapses to the player's own train and comes through
      // at full clarity -- see section 6 of `game/rail-audio.ts` -- which is
      // also why the aboard slot is handed over rather than just a position.
      railAnnounceMix(
        railBake,
        railNow,
        player.position.x,
        player.position.z,
        isAboard(playerCombat.aboard) ? playerCombat.aboard : null,
        railAnnounce,
      );
      audio.railAnnounce(railAnnounce);
    } else {
      audio.railAnnounce(null);
    }
    // The boarding marker's own breathing. Aimed in `simulate` at the tick rate
    // and animated here at the frame rate, which is the split every other
    // overlay in this file makes.
    doorMarker.update(frameDt);
    // The button on the hill and the face in the sky, at the frame rate for the
    // same reason: the plinth's ring breathes and the sun's jaw moves, and both
    // are cosmetic. `sky.solar` is handed over rather than recomputed, on
    // `MoonDisc.update`'s argument -- a face built from a second reading of the
    // clock would sit beside the sun rather than on it.
    sunButton.update(
      frameDt,
      camera,
      sky.solar.direction,
      sky.solar.altitude,
      player.position.x,
      player.position.z,
      // The mouth follows the scream that is actually playing -- 0 between
      // clips -- so the face mouths nothing while the sun is quiet.
      audio.sunScreamLevel(),
    );

    frameProfile.at(FSEC.lights);
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
    //
    // --- And where the beam comes from, which is the only new thing here.
    //
    // Three cases, and `null` is the one that must not move: in first person the
    // torch is the eye plus `TORCH_OFFSET` exactly as it has always been, and
    // every display value in `sky/calibration.ts`'s torch table was measured
    // that way. The other two are `world/nightlights.TorchMount`, which carries
    // the whole argument for why one light does all three jobs.
    //
    // The **hand** mount is taken from the self body's own chest bone rather
    // than from a constant, so the beam carries the walk bob, the run lean and
    // the crumple of a knockout. Only the bone's *height above the actor's root*
    // is used: `driver.update` places that root three hundred lines below this
    // one, so the bone matrices here are last frame's, and taking x and z from
    // the live `player.position` instead means the origin is never behind the
    // body at speed. The pose is a frame old, which on a light that already lags
    // the view by 0.075 s is not a thing that exists.
    const torchMountNow =
      playerCombat.ridingBike !== 0
        ? torchBikeMount(
            torchMount,
            player.position.x,
            player.position.y - EYE_HEIGHT,
            player.position.z,
            player.yaw,
          )
        : thirdPerson
          ? (() => {
              _chest.setFromMatrixPosition(self.bones[BONE.CHEST].matrixWorld);
              return torchHandMount(
                torchMount,
                player.position.x,
                player.position.y - EYE_HEIGHT + (_chest.y - self.mesh.position.y),
                player.position.z,
                player.yaw,
              );
            })()
          : null;
    nightLights.update(
      frameDt,
      camera,
      alt,
      Math.hypot(player.velocity.x, player.velocity.z),
      streamer,
      torchMountNow,
      // WORKSTREAM fire-look: which cars are alight, for the two real lights a
      // burning car gets after dark. `CarSmoke` is the one thing in the client
      // that already knows -- it is handed every driven car in view with its
      // burn level once a frame -- and the answer it gives here is the previous
      // frame's, because the driven cars are posed a hundred lines below this.
      // See `nightlights.FireSource`; a frame of lag on a light being flickered
      // at 9 Hz is not a thing that exists.
      carSmoke,
    );
    // And the sprites, which are hidden all day for the fill they would
    // otherwise cost. One comparison on every frame but the two a day where the
    // answer changes; see `TileStreamer.setNightLightsVisible` for why this is
    // a mesh flag and must never become a light one.
    streamer.setNightLightsVisible(nightLights.level > NIGHT_VISIBLE_LEVEL);

    frameProfile.at(FSEC.traffic);
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
    // Who is close enough to be a real car, at 5 Hz.
    //
    // **Before** the movers, not after: a claim taken this frame has to be
    // visible to the box fleet on this frame, or the car is drawn twice -- once
    // as a model and once as the box that did not know. The other order is a
    // frame of double-draw every time a car crosses 90 m, which is exactly the
    // artefact this feature must not have.
    if (carModels && now - lastCarSweep >= 1000 / SWEEP_HZ) {
      lastCarSweep = now;
      carModels.sweep(
        traffic,
        trafficTick(Date.now()) + accumulator / FIXED_DT,
        player.position.x,
        player.position.z,
      );
    }

    // The brake lamps and the camera's lean, before the movers so the lamps are
    // filled in the same frame the bodies they hang off are placed. `steer` is
    // the wheel as a fraction of full lock, taken from the yaw the input builder
    // produced this frame -- `RIDE_TURN_RATE` is the bike's own normaliser and is
    // the right order of magnitude for a car's, which is all a cosmetic lean
    // needs. See `world/drivencars.DrivenCarView.update`.
    drivenCars.update(
      nightLights.carLights,
      playerCombat.drivingCar,
      playerCombat.carSpeed,
      frameDt > 1e-5 ? driveSteering.yawDelta / frameDt / RIDE_TURN_RATE : 0,
      frameDt,
      // --- Workstream H: the plume, fed from inside the walk that already poses
      // every driven car this frame. `TrafficMovers.lights` is handed over the
      // same way and for the same reason: the car you see smoking has to be the
      // car that is there, and a second pass that had to agree with this one is
      // how a plume ends up hanging over an empty parking space.
      carSmoke,
      camera.position.x,
      camera.position.y,
      camera.position.z,
    );

    trafficMovers.update(
      traffic,
      trafficTick(Date.now()) + accumulator / FIXED_DT,
      player.position.x,
      player.position.z,
      // --- Workstream Q: where the camera is and which way it points, which is
      // what the latch needs and what the draw radius above deliberately is not.
      // The forward is read out of the camera's own world matrix rather than
      // rebuilt from the yaw, so a cutscene, a vehicle camera or a shoulder cam
      // all answer correctly without this line knowing they exist.
      camera.position.x,
      camera.position.z,
      -camera.matrixWorld.elements[8],
      -camera.matrixWorld.elements[10],
    );
    // **After** the movers, and it is not optional: `claimed()` writes a claimed
    // car's matrix into the instance buffer from inside that loop, and `end()`
    // is the only thing in `carlod.ts` that raises `needsUpdate` on it. Without
    // this line every claimed car draws with the matrix the GPU was last given
    // -- which, for a mesh that has never uploaded one, is all zeroes, and a
    // zero matrix collapses the car to a point. The box fleet has meanwhile
    // suppressed it *because* it was claimed, so the car is not drawn at all.
    // That shipped: "moving cars appear to be invisible", and every near-field
    // car in the city was gone with them. The sibling per-frame fleets
    // (`bikeLights`, `footyPool`, `nameplates`) all end here for the same
    // reason; this one was simply missed.
    carModels?.end();

    frameProfile.at(FSEC.crowd);
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

    // --- And the raves, immediately after the crowd because they are the same
    // crowd: `world/rave.ts` draws its attendees out of `PedestrianAssets`'
    // geometry and its dancers out of the same `CharacterActor` pool the street
    // uses, so the two features share a budget as well as a rig.
    //
    // Fed `sky.now` rather than `Date.now()`, which is the one line that keeps
    // this feature honest about the clock. `SkyClock.nowMs` carries the debug
    // scrub, so pressing `[` back to two in the morning genuinely moves the
    // raves with the sky rather than leaving an empty warehouse under a night
    // sky; and `SkyClock.night` is the *same* darkness ramp the street lamps,
    // the lit windows and the torch already share, so nothing here can glow at
    // three in the afternoon even if the two clocks were ever rotated apart.
    // See `game/rave.ts` section 6 and `sky/cycle.ts`.
    //
    // `wildGround` rather than `groundHeightAt`: a rave stands on the ground,
    // and a query that folded in a roof would put a truss on top of the shed it
    // is parked beside the moment the two footprints overlapped. It is exactly
    // the argument that function's own comment makes for a bush turkey.
    raves.update({
      nowMs: sky.now.nowMs,
      dt: frameDt,
      x: player.position.x,
      z: player.position.z,
      night: sky.now.night,
      ground: wildGround,
      solid: raveSolid,
      bag,
    });

    // The sound system. One call, unconditionally, with whatever was nearest --
    // so there is exactly one place in the build that decides what a rave sounds
    // like and no audio state anywhere else. `game/audio.ts`'s own header sets
    // out the low-pass, the streaming decks and the synthesised set; what is
    // here is the translation from "the nearest rave" to "the mix".
    //
    // The record is chosen for the *nearest* venue only. A second rave inside
    // earshot would be a second `MediaElementAudioSourceNode` and a second
    // stream for something the first one is already drowning out; what a player
    // between two raves hears is the nearer one, which is what a player between
    // two raves hears.
    const near = raves.nearest;
    // What the map is allowed to remember. One test, in one place: you have to
    // have been close enough to hear it, with the music actually on. See the
    // marker source for why that single condition is the entire design of this
    // feature's UI.
    {
      const tonight = raveNight(sky.now.nowMs).index;
      if (tonight !== heardNight) {
        heardNight = tonight;
        heardRaves.clear();
      }
      if (near && near.playing && near.distance <= RAVE_AUDIBLE_RANGE) heardRaves.add(near.venue.site.id);
    }
    if (near && near.playing && near.distance <= RAVE_AUDIBLE_RANGE) {
      const track = near.position.track >= 0 ? bag.tracks[near.position.track] : undefined;
      const nextTrack = near.position.next >= 0 ? bag.tracks[near.position.next] : undefined;
      audio.raveUpdate({
        // The venue *and* the night, so a rave that runs over into a second
        // evening rebuilds rather than carrying yesterday's deck state.
        key: near.venue.site.id * 4096 + (near.venue.night & 0xfff),
        distance: near.distance,
        url: track ? `audio/dj/${encodeURIComponent(track.file)}` : null,
        offset: near.position.offset,
        nextUrl: nextTrack ? `audio/dj/${encodeURIComponent(nextTrack.file)}` : null,
        remaining: near.position.remaining,
        bpm: near.bpm,
        beat: beatAt(sky.now.nowMs, near.bpm),
        // Under a viaduct, and nowhere else. A concrete soffit over a hard apron
        // is the most recognisable acoustic in the city and it costs one
        // convolver; see `game/audio.ts`'s `raveImpulse`.
        reverb: near.venue.site.kind === 1,
        playing: true,
      });
    } else {
      audio.raveUpdate(null);
    }

    // And the police arriving, which is the *local* half of a shared event. The
    // bust itself is a pure function of the night and the site -- every client
    // agrees about it to the millisecond, and a player cannot cause it, for the
    // reason `game/rave.ts` section 5 gives at length. What a client owns is
    // what it feels like to be standing there when it happens: one bark from
    // whoever is nearest, on the edge rather than every frame.
    if (near && near.busted && near.distance < 90) {
      if (bustedVenue !== near.venue.site.id) {
        bustedVenue = near.venue.site.id;
        audio.bark(POLICE_CLIPS[near.venue.site.id % POLICE_CLIPS.length], near.distance, 8);
      }
    } else if (!near || !near.busted) {
      bustedVenue = -1;
    }

    frameProfile.at(FSEC.police);
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

    // --- Workstream E: the five characters, both tiers, out of the same
    // authority and on the same fractional tick as everybody above.
    characterCrowd.update(
      pedestrians,
      policeField(),
      trafficTick(Date.now()) + accumulator / FIXED_DT,
      frameDt,
      player.position.x,
      player.position.z,
    );
    // Whatever the nearest one of them is saying. `hud.notice` rather than
    // audio, because there is no audio for these five and handing an eshay the
    // drunk's recording would be worse than silence -- see `game/characters.ts`
    // section 4. The crowd clears its own queue at the top of every update, so a
    // frame that skipped this drops lines rather than accumulating them.
    for (const line of characterCrowd.lines) hud.notice(line.text);

    // --- And the ambient events. `wildGround` rather than `groundHeightAt`:
    // this wants the *raw* terrain height, because a queue of twenty-five
    // commuters placed against the player's last known ground would float
    // whenever the player was on a station platform. The wildlife's ground query
    // already makes exactly this distinction and its header argues it.
    eventScene.update(
      trafficTick(Date.now()) + accumulator / FIXED_DT,
      player.position.x,
      player.position.z,
      wildGround,
      // The footpaths, so a site is snapped onto a kerb rather than drawn where
      // the hash put it -- which the first cut of this feature demonstrated was
      // sometimes the roof of a terrace. See `events.SNAP_REACH`.
      pedestrians,
    );

    // --- Standing in a queue for a bus that is not coming.
    //
    // The clock is here rather than in `world/events.ts` because a clock is
    // state and that object is a renderer -- `inTrackworkQueue` is a predicate
    // and this is the twenty seconds. Reset on leaving, and told once: the line
    // lands the first time and never again for the same queue, because the
    // second time it is not deadpan, it is nagging.
    {
      const queue = inTrackworkQueue(eventScene.live, player.position.x, player.position.z);
      if (queue === null) {
        queueSince = -1;
        queueTold = false;
      } else {
        const nowS = performance.now() / 1000;
        if (queueSince < 0) queueSince = nowS;
        else if (!queueTold && nowS - queueSince >= 20) {
          queueTold = true;
          hud.notice('the bus is not coming');
        }
      }
    }

    frameProfile.at(FSEC.npcvoice);
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

    // --- Workstream E, off the same state bytes and the same rising-edge rule.
    //
    // Two lines, and both of them are things you find out by *watching* rather
    // than by doing:
    //
    //   - an **influencer going down** within `POSTED_RANGE`. The client that
    //     swung already said the version with your name in it, at the swing;
    //     this is what everybody else gets, and it is impersonal because the
    //     snapshot carries no attacker for an NPC knockdown. See the swing path.
    //   - a **tradie helping somebody up**, which he signals by entering
    //     `NPC_STATE.IDLE` beside a downed player -- there is no state byte for
    //     "helping" and adding one would be a protocol change for a line, so the
    //     range test is the signal. It fires at most once per tradie per session
    //     through the same `posted` set, which is what stops it repeating on
    //     every frame he stands there.
    for (const actor of policeField().actors) {
      if (!isCharacterKind(actor.kind)) continue;
      const range = Math.hypot(actor.x - player.position.x, actor.z - player.position.z);
      if (actor.kind === NPC_KIND.INFLUENCER) {
        const wasDown = posted.has(actor.id);
        if (actor.state === NPC_STATE.DOWN) {
          if (!wasDown) {
            posted.add(actor.id);
            if (range < POSTED_RANGE) hud.notice(POSTED_LINE_BYSTANDER);
          }
        } else if (wasDown) {
          posted.delete(actor.id);
        }
      } else if (actor.kind === NPC_KIND.TRADIE) {
        if (posted.has(actor.id)) continue;
        if (playerCombat.phase !== 'ko') continue;
        if (range > 5) continue;
        posted.add(actor.id);
        hud.notice(TRADIE_HELP_LINE);
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

    frameProfile.at(FSEC.heat);
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

    // --- The heat ladder: the star row, the line, and everything it put in the
    // world. One contiguous block; see `game/heat.ts` and `world/highway-patrol.ts`.
    {
      // One number from whichever authority is running, exactly as the banner
      // above takes one record: online it is `MSG.HEAT`, offline it is this
      // process's own field, and nothing below this line knows which.
      const stars = net ? net.heatStars : heat.starsOf(playerCombat.id);
      hud.heat(stars);
      // The voice, on the **edge** rather than the level. A `hud.notice` fired
      // off the star count itself would repeat sixty times a second for as long
      // as the rung lasted, which is `sim.stepRideBy`'s own lesson about a state
      // that has to be read as an event.
      if (stars !== heatShown) {
        const line = heatLine(heatShown, stars);
        if (line) hud.notice(line);
        heatShown = stars;
      }
      // The patrol cars and the RBTs, out of the same `policeField()` the squad
      // draws officers from -- which is not a police-only accessor despite the
      // name: it is "wherever the promoted actors are", and each renderer
      // filters the kinds it draws itself.
      patrolFleet.update(policeField(), frameDt, player.position.x, player.position.z);
      // And Polair, which still needs no actor and nothing on the wire: the orbit,
      // the beam schedule and the shot schedule are pure functions of the player's
      // id and the shared tick, so this browser draws the identical machine the
      // authority rolled the marksman's round against. Five is the top rung; see
      // `game/heat.ts` section 4 and `game/polair.ts` section 3.
      //
      // The id is **the authority's**, not this process's: `net.id` online, the
      // offline combatant's otherwise. A local id passed online would seed a
      // different orbit from the server's and the helicopter would be drawn flying
      // a circle nobody was shooting from.
      polairView.tick = trafficTick(Date.now());
      polairView.dt = frameDt;
      polairView.on = stars >= HEAT_MAX;
      polairView.playerId = net ? net.id : playerCombat.id;
      polairView.x = player.position.x;
      polairView.y = player.position.y;
      polairView.z = player.position.z;
      polairView.groundY = groundHeightAt(player.position.x, player.position.z, player.position.y);
      polairView.night = sky.now.night;
      polair.update(polairView);
      // The siren and the rotor. One call a frame with whatever is out there,
      // which is `audio.raveUpdate`'s arrangement: one place decides what is
      // audible and there is no state anywhere else. The siren's distance is to
      // the nearest patrol car that is actually chasing somebody -- a car parked
      // at an RBT has its bar on and its siren off, which is what one of those
      // looks like on a real arterial.
      let nearestSiren = Infinity;
      for (const a of policeField().actors) {
        if (a.kind !== NPC_KIND.HIGHWAY_PATROL || a.state === NPC_STATE.DOWN) continue;
        const dx = a.x - player.position.x;
        const dz = a.z - player.position.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < nearestSiren) nearestSiren = d;
      }
      // The rotor is a distance now as well as a level -- the machine flies a real
      // orbit, so the slant range, the closing rate and the lap phase are all
      // things it knows. See `audio.HeatMix.rotorDistance`, which is the paragraph
      // that used to argue there was no distance to have.
      audio.heatUpdate(
        nearestSiren === Infinity && polair.intensity <= 0.01
          ? null
          : {
              sirenDistance: nearestSiren,
              rotor: polair.intensity,
              rotorDistance: polair.slant,
              rotorClosing: polair.closing,
              rotorOrbit: polair.orbitPhase,
            },
      );
      // The screaming sun's own sound, beside the siren and the rotor: one call a
      // frame with whatever the sun is doing, which is `audio.heatUpdate`'s
      // arrangement. The clock and the altitude are the same the face is drawn
      // from, so the scream and the face can never be a frame apart.
      const clockMs = sky.now.nowMs;
      const sunAltDeg = sky.solar.altitude;
      const screaming = sunButton.state ? sunScreaming(sunButton.state, clockMs) : false;
      audio.sunScreamUpdate(sunScreamMix(screaming, sunAltDeg));
    }

    frameProfile.at(FSEC.actors);
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
    //
    // Workstream O: `throwT` rather than `ballT`, here and on the three lines
    // below. `ballT` is consumed by the refill, so it read as a fresh throw every
    // 1.6 s while the bar was filling -- and this line is one of the four that
    // believed it. The shadow of the ball blinked out of your own hand twice per
    // ball you threw. See `combat.throwT`.
    selfFooty.set(playerCombat.ballCharges > 0 && playerCombat.throwT >= THROW_SECONDS);
    // And every dummy's, on exactly the rule `poseRemote` applies to a remote:
    // in hand while they have one and are not mid-throw. Offline this is the
    // only place the "somebody else is carrying" read can be seen at all.
    for (const [dummy, prop] of dummyFooties) {
      prop.set(dummy.combat.ballCharges > 0 && dummy.combat.throwT >= THROW_SECONDS);
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
      // Workstream O: the animation clock, not the supply's. See `combat.throwT`
      // -- read off `ballT` this dipped the bat out of the way of a throw that was
      // not happening, every 1.6 s, for as long as the bag was refilling.
      throwT: playerCombat.throwT,
    });
    // --- Workstream I: and your hands, on the same frame delta and the same
    // predicted phase. Posed **unconditionally**, whether or not fists are
    // equipped: the pose is two vector writes and four Euler writes off a pure
    // function, and the alternative -- skipping the update while the bat is out
    // -- means the hands come back on screen holding whatever pose they were in
    // when you last switched away, which is a fist frozen mid-jab on the frame
    // you press 4. Visibility is `setWeaponVisible`'s, above.
    handsViewmodel.update(frameDt, {
      phase: playerCombat.phase,
      phaseT: playerCombat.phaseT,
      speed: Math.hypot(player.velocity.x, player.velocity.z),
      yaw: player.yaw,
      pitch: player.pitch,
      hitstop: playerCombat.hitstopT > 0,
    });
    // And the ball in the other hand, on the same frame delta and off the same
    // predicted clock -- so the release starts on the frame the button goes down
    // rather than on the next round trip.
    footyViewmodel.update(frameDt, {
      // Workstream O: `throwT`, which counts from a throw and is never consumed by
      // the refill. This one line is the "recharge animation" the owner asked to
      // have removed -- see `FootyViewmodel.update`.
      sinceThrow: playerCombat.throwT,
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

    frameProfile.at(FSEC.bikes);
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
    // And the headlight on every one of those, from the same three numbers and
    // in the same two places, so a bike that is drawn is a bike that is lit and
    // there is no fourth list to keep in step. `begin` is false all day, which
    // makes this two comparisons outside the night. See `world/nightlights.BikeLights`.
    const bikeLit = nightLights.bikeLights.begin();
    if (playerCombat.ridingBike !== 0) {
      // With the lean, which only the local rider gets: the wire carries a yaw
      // and not a yaw *rate*, so a remote's steering is not knowable here and a
      // guessed lean would be a bike rocking on other people's screens for
      // reasons nobody could see. See `world/bike.RiddenBike.set`.
      selfBike.set(player.position.x, player.position.y - EYE_HEIGHT, player.position.z, player.yaw, rideLean);
      if (bikeLit) {
        nightLights.bikeLights.add(
          player.position.x,
          player.position.y - EYE_HEIGHT,
          player.position.z,
          player.yaw,
        );
      }
    } else {
      selfBike.hide();
    }
    if (net) {
      for (const r of net.remotes.values()) {
        const entry = remotes.get(r.id);
        if (!entry) continue;
        // `FLAG.RIDING` is set for a driver too -- that is the contract, see
        // `protocol.ENTER_FLAG.DRIVING` -- so the bike is drawn only for the
        // remotes who are actually on one. Without this clause every driver in
        // the room has a lime bike welded under their car.
        if (r.riding && !r.fresh && !isDriving(r.id)) {
          if (!entry.bike) {
            entry.bike = new RiddenBike(bikes);
            scene.add(entry.bike.mesh);
          }
          entry.bike.set(r.position.x, r.position.y - EYE_HEIGHT, r.position.z, r.yaw);
          if (bikeLit) {
            nightLights.bikeLights.add(r.position.x, r.position.y - EYE_HEIGHT, r.position.z, r.yaw);
          }
        } else if (entry.bike) {
          entry.bike.hide();
        }
      }
    }
    nightLights.bikeLights.end();

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
      // On the same half-second and behind the same reasoning: the corridor can
      // only be swept where the DEM is, and the DEM arrives a tile at a time.
      // A no-op unless `?vessels=1`, and a no-op after that unless a grid has
      // landed since the last one. See `refreshVessels`.
      refreshVessels();
    }

    frameProfile.at(FSEC.plates);
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
    // WORKSTREAM AB: the cost *was* about twenty matrix composes per player, on
    // at most fifteen players, once a frame -- and eighteen of the twenty were
    // the rest of the skeleton, which `renderer.render` recomposes a few lines
    // below anyway. `refreshHeadMatrix` walks up to the head instead of down
    // through the body: six composes, the identical plate position, and 20.35
    // us a frame becomes 5.60 at fifteen remotes. The camera keeps its full
    // update for the same reason it always had one: `begin` reads its world
    // matrix for the billboard basis, and a frame-old basis is a plate that
    // lags a fast mouse turn.
    camera.updateMatrixWorld();
    nameplates.begin(camera);
    if (net) {
      // Online: the remotes, and only the remotes. `add` drops the local id
      // itself, so there is no condition here to get wrong.
      for (const r of net.remotes.values()) {
        if (r.fresh) continue;
        const entry = remotes.get(r.id);
        if (!entry) continue;
        // WORKSTREAM AB: the head's ancestor chain, not the whole eighteen-node
        // body. Same answer, six composes instead of eighteen, and the twelve
        // this stops touching were being composed a second time inside
        // `renderer.render` anyway. See `CharacterActor.refreshHeadMatrix`.
        entry.actor.refreshHeadMatrix();
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
        // How wanted they are, under the name. A 4-star player is a visible
        // target, which is the whole reason this is on other people's plates
        // and not only on your own HUD. See `nameplates.starRow`.
        plate.stars = net.heatOf(r.id);
        // And what level they are, beside the stars. Workstream G: a level is a
        // fact about the person the same way the star row is a fact about their
        // standing with the police, and both belong under the name rather than
        // only on a board you have to hold Tab to read.
        plate.level = net.levelOf(r.id);
        // WORKSTREAM X: and which side they are on, under the name once, on a
        // pill in the team's colour. `teamOf` answers TEAM.NONE until the
        // framework wires a source, which is also what offline is forever.
        plate.team = teamOf(r.id);
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
        f.driver.actor.refreshHeadMatrix();
        f.driver.actor.headPosition(plateHead);
        plate.id = f.combat.id;
        plate.name = dummyLabel(f.dummy.kind);
        plate.health = f.combat.health;
        plate.headX = plateHead.x;
        plate.headY = plateHead.y;
        plate.headZ = plateHead.z;
        plate.down = f.combat.phase === 'ko';
        // A training dummy has no standing with the police, and saying so
        // explicitly rather than leaving the field from the last plate is the
        // whole reason `PlateInput` is copied field by field -- see `add`.
        plate.stars = heat.starsOf(f.combat.id);
        nameplates.add(plate, playerCombat.id);
      }
    }
    nameplates.end();

    frameProfile.at(FSEC.teams);
    // WORKSTREAM X: the bodies, the horns, the ground rings and the tents, on
    // the same argument the plates are here for -- this reads other objects'
    // final transforms, and a ring under somebody's feet has to agree with the
    // plate over their head about which side they are on.
    updateTeamLook(Date.now());

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
    // Bracketed by the pipeline watch, which is two subtractions a frame and is
    // the whole future-proofing story for shader compilation in this client.
    // Three takes the *blocking* `device.createRenderPipeline` branch exactly
    // when a pipeline is first needed inside `render` rather than inside
    // `compileAsync`, so the cache growing across this one call is precisely
    // "this frame stalled on a compile" -- with no wrapper around three's
    // internals and nothing to keep in step. See `world/warmup.ts`.
    frameProfile.at(FSEC.render);
    pipelineWatch.begin(renderer);
    renderGuard.run(() => renderer.render(scene, camera), scene, hud);
    pipelineWatch.end(renderer, performance.now() - now);
    frameProfile.at(FSEC.present);

    // **The bug box's screenshot, and it has to be exactly here.**
    //
    // A WebGPU drawing buffer is presented and released, so `toDataURL` on this
    // canvas from a click handler returns a blank image -- with no throw and no
    // warning, which is the failure mode that matters. Inside this frame, one
    // line after the render, the buffer is still there. Costs an array length
    // check on every frame of every session and does real work on the one or
    // two frames somebody presses the button. See `client/src/bugreport.ts`.
    grabber.afterRender();

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
          // The near field. `modelled` is cars from *both* fleets drawn as real
          // models rather than boxes, and `sweepMs` is the 0.5 ms budget the
          // assignment pass was scoped against -- the one number that says
          // whether running it at 5 Hz was enough. See `world/carlod.ts`.
          modelled: carModels?.claimedCount ?? 0,
          sweepMs: carModels?.sweepMs ?? 0,
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
        /**
         * The raves. `costMs` is the number this feature is judged on and the
         * one to read after adding anything to `world/rave.ts`; the rest is
         * there because a rave is the one ambient system whose *absence* is
         * indistinguishable from it working -- five nights in eighty a given
         * site is dark on purpose, so "I cannot find one" needs an answer that
         * is not "walk around".
         *
         * `sydney.raves.tonight()` lists them; `sydney.raves.go()` goes.
         */
        raves: {
          drawn: raves.drawn,
          beams: raves.beamsDrawn,
          attendees: raves.attendeesDrawn,
          rigged: raves.rigged,
          costMs: raves.costMs,
          nearest: raves.nearest
            ? {
                name: raves.nearest.venue.site.name,
                metres: Math.round(raves.nearest.distance),
                stage: ['load-in', 'doors', 'peak', 'wind-down', 'pack-up', 'busted', 'over'][raves.nearest.stage],
                deck: raves.nearest.title,
                bpm: raves.nearest.bpm,
                into: Math.round(raves.nearest.position.offset),
              }
            : null,
          tracks: bag.tracks.length,
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

    // WORKSTREAM AB: the strip, then the frame closes.
    //
    // The overlay is painted *inside* `present` rather than after `stop`, so its
    // own cost is charged to a section rather than disappearing into the gap
    // between frames -- a profiler that does not measure itself is the one thing
    // this file could get wrong and never find out about. It returns on the
    // first line when `?perf=1` is absent, which is every real session.
    frameOverlay.update(frameProfile, now);
    // And nothing after this line, ever: `stop` charges the open section and
    // disarms the cursor, and work placed below it would be charged to the next
    // frame's `input`. See `frameprofile.FrameProfile.stop`.
    frameProfile.stop();
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
     * WORKSTREAM AB: where the frame went. `sydney.frame()`.
     *
     * Prints the table and returns the record, so it is readable by a person and
     * destructurable by a script. The window is the last 120 frames -- two
     * seconds at 60 Hz -- because "the mean since boot" is dominated forever by
     * the ten seconds after boot when the streamer is hammering, and the number
     * anybody asking this question wants is what the frame costs *now*.
     *
     * `worstMs` beside each mean is the point of the whole instrument: a hitch is
     * precisely the frame a mean is hiding, and the section that owns the worst
     * frame is frequently not the section that owns the mean. `?perf=1` puts the
     * same two columns on screen while you walk around.
     */
    frame: () => {
      const report = frameProfile.report();
      console.log(frameProfile.table('frame:'));
      // And what the instance pools handed the driver, which is not a section
      // of the frame -- it lands inside `renderer.render` where it cannot be
      // attributed -- but is the number the biggest cut in this pass was made
      // against, so it is printed where somebody would look for it. See
      // `world/instupload.ts`.
      console.log(`  ${uploadReport()}`);
      return report;
    },

    /**
     * The heat ladder, for the console. One contiguous block; see `game/heat.ts`.
     *
     * `sydney.heat.report()` answers the three questions this feature raises
     * from outside a session, and none of them can be answered by looking:
     *
     *   - `stars` and `points` are the ladder itself. The **points are hidden
     *     from the player on purpose** -- the whole design is that you read your
     *     standing off five glyphs -- so this is the only place the number a
     *     rung is actually made of can be seen, and it is the first thing to
     *     type when a tier arrives earlier or later than it should.
     *   - `cars` and `rbts` are what the ladder has actually put on the road,
     *     against what the star count says should be there. A 3-star player with
     *     `cars: 0` is the shared actor cap biting (`factions.MAX_ACTORS`) or a
     *     suspect off the lane graph -- two completely different problems that
     *     look identical from inside the game, which is no patrol car arriving.
     *   - `polair` is the beam's level, which by day is the only way to tell the
     *     fifth rung from the fourth without listening for the rotor.
     *
     * `set(n)` is `?heat=N` after the fact and carries the same offline gate,
     * for the same reason: `HeatField` is the class the server runs, and a
     * client setting its own star count is a client deciding how wanted it is.
     */
    heat: {
      report: () => ({
        stars: net ? net.heatStars : heat.starsOf(playerCombat.id),
        points: Math.round(heat.pointsOf(playerCombat.id)),
        wanted: heat.wantedCount,
        cars: patrolFleet.cars,
        rbts: patrolFleet.rbts,
        spawnedCars: heat.patrolCarsSpawned,
        placedRbts: heat.rbtsPlaced,
        // What the shared cap is currently holding, across every faction. The
        // number to read when a rung's furniture does not arrive: at
        // `factions.MAX_ACTORS` a promotion is refused unless it can evict
        // something, and "the field was full of seagulls" and "the ladder is
        // broken" look identical from inside the game.
        actors: factions.actors.length,
        polair: Math.round(polair.intensity * 100) / 100,
      }),
      set: (n: number) => {
        if (online) return 'offline only — the server decides how wanted you are';
        heat.debugSet(playerCombat.id, n, trafficTick(Date.now()));
        return heat.starsOf(playerCombat.id);
      },
    },
    /**
     * One presented frame as a PNG data URL. `await sydney.grab()`.
     *
     * The bug box's own grabber, exposed. `toDataURL` on a WebGPU canvas is
     * blank unless it is read in the same frame as a render -- *silently* blank,
     * a valid PNG of nothing -- so there is exactly one place in this client
     * that can take a picture, and it is already wired into the render loop.
     * A second one would be a second way to get an empty file. See
     * `bugreport.FrameGrabber`.
     */
    grab: (timeoutMs?: number) => grabber.request(timeoutMs),

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
    /**
     * The warm-up, for the console.
     *
     * `sydney.warmupAudit()` is the one to type after adding a renderer, and it
     * answers the question nothing else can: has any frame this session stalled
     * on a shader compile? `syncFrames` is the number that matters and it should
     * be **zero** once the ring has filled; `syncWorstMs` is what the player
     * felt. `pipelinesSinceWarmup` climbing is normal and expected -- every tile
     * brings its own, compiled off the main thread by
     * `TileStreamer.setPrecompiler` -- so it is `syncFrames` rather than that
     * count which says the bug is back. See `world/warmup.ts`.
     */
    warmupAudit: auditNow,

    /**
     * The raves, for the console.
     *
     * `sydney.raves.tonight()` is the one to type, and it exists because this is
     * the only ambient feature in the build whose *absence* is indistinguishable
     * from it working: a given site is dark seventy-nine nights in eighty by
     * design, so "there is no rave in Sydney Park" is almost always correct and
     * is occasionally a bug. This lists what the shared clock says is on, where,
     * how far through, and what is on the decks -- and because every one of
     * those is a pure function of the night index, **two people running it at
     * the same moment get the same list**, which is the whole claim the feature
     * makes and the only way to check it from outside.
     *
     * `sydney.raves.at(n)` does the same for any night, past or future, which is
     * how you find one to look at rather than waiting for one.
     */
    /**
     * The night sky, from a console.
     *
     * The four pictures this feature is about are a clear sky with a high moon,
     * a clear moonless sky showing the Southern Cross, an overcast night in the
     * CBD, and the same overcast night out where there is no city -- and three
     * of the four are otherwise reachable only by waiting up to twenty minutes
     * for the weather noise to come round to them.
     *
     *     sydney.nightsky.now()            what the sky is doing here, right now
     *     sydney.nightsky.moon(1)          scrub to a night with a full moon up
     *     sydney.nightsky.moon(0.15, 0.78) a thin crescent just after sunset
     *     sydney.nightsky.cover(1)         force overcast; null hands it back
     *     sydney.sky.scrubTo(0)            midnight -- what `N` used to be
     *     sydney.sky.advance(30)           half an hour on -- what `]` used to be
     *
     * **The last two are here because they are not keys anywhere else any
     * more.** The time of day is the server's as of protocol v11 and no
     * keystroke moves it; these are the developer path, reachable only by
     * opening a console, and anything that uses one puts a non-zero
     * `desyncMinutes` in `now()` and a warning in the console until the page is
     * reloaded. See `sky/sky.ts`'s `scrubMs` for the argument and `?vessels=1`
     * for the precedent.
     *
     * `moon` is a *search*, not an override: it walks the 2,160 moons the cycle
     * carries and scrubs to the one that matches, so what you end up looking at
     * is a sky the shipped game genuinely produces on some evening. It scrubs,
     * so it desyncs, and it says so in `now()` like everything else here.
     *
     * `nightsky` rather than `night`, which is already taken by the street-lamp
     * rig -- and the two are genuinely different things: that one is what the
     * city switches on after dark, this one is what the sky does about it.
     */
    nightsky: {
      now: () => ({
        time: sky.now.label,
        /* Whose clock this time is, and how far off it this client is.
         *
         * First two fields after the time on purpose: everything below is a
         * measurement of the sky, and these two say whether the sky being
         * measured is the one everybody else is looking at. `clockFromServer`
         * false is offline (or a welcome that never came) and is legitimate;
         * `desyncMinutes` non-zero means somebody in this tab scrubbed. */
        clockFromServer: net?.clockFromServer ?? false,
        desyncMinutes: Number((sky.desync / 60_000).toFixed(3)),
        cover: Number(sky.night.cover.toFixed(3)),
        urban: Number(sky.night.urban.toFixed(3)),
        skyglow: Number(sky.night.glow.toFixed(3)),
        moonAltitude: Number(sky.now.lunar.altitude.toFixed(2)),
        moonPhase: Number(sky.now.moonPhase.toFixed(3)),
        moonlight: Number(sky.night.moonlight.toFixed(4)),
        ambient: Number(sky.night.ambientIntensity.toFixed(4)),
        stars: Number(sky.night.starVisibility.toFixed(3)),
        starsLoaded: sky.starCount,
        moonDate: sky.now.moonDate.toISOString().slice(0, 10),
      }),
      moon: (illumination = 1, atPhase = 0) => sky.scrubToMoon(illumination, atPhase),
      cover: (value: number | null) => sky.setNightOverride(value),
      selfChecks: () => verifyLunar().concat(verifySkyglow(), verifyMoonDisc()),
    },
    raves: {
      world: raves,
      tonight: () => raveListing(sky.now.nowMs),
      at: (night: number) => raveListing(nightStartMs(night) + RAVE_CYCLE_MS * 0.25),
      /** Which nights, from here on, Sydney Park is on. The user asked for it by name. */
      sydneyPark: (within = 40) => {
        const from = raveNight(sky.now.nowMs).index;
        const out: number[] = [];
        for (let n = from; n < from + within; n++) {
          if (drawRaves(n).some((v) => v.site.id === SYDNEY_PARK_SITE)) out.push(n);
        }
        return out;
      },
      selfChecks: () => verifyRaves().concat(verifyRaveKit(raveAssets)),
      /**
       * Stand at the back of a live rave's crowd, facing the rig.
       *
       * `sydney.raves.go()` takes the nearest one on tonight; a name takes that
       * one. The viewpoint is deliberately *behind* the crowd rather than in it,
       * because that is where the layout is designed to be arrived at from --
       * see `boothPosition` in `game/rave.ts`.
       */
      go: (name?: string) => {
        const list = liveRaves(raveNight(sky.now.nowMs).index);
        const venue = name
          ? list.find((v) => v.site.name.toLowerCase().includes(name.toLowerCase()))
          : list
              .slice()
              .sort(
                (p, q) =>
                  Math.hypot(p.site.x - player.position.x, p.site.z - player.position.z) -
                  Math.hypot(q.site.x - player.position.x, q.site.z - player.position.z),
              )[0];
        if (!venue) return `nothing on tonight${name ? ` called "${name}"` : ''}`;
        // Behind the crowd on the bearing, looking down it at the booth -- but
        // *outdoors*. A warehouse yard's inscribed circle is clear of the fence
        // and says nothing about the shed the arrival point lands in, and being
        // teleported inside a wall is the one way this tool can waste somebody's
        // time. Six offers, the crowd's own rejection test, first one that is
        // standing in the open.
        const s = Math.sin(venue.bearing);
        const c = Math.cos(venue.bearing);
        let x = venue.site.x + s * venue.depth * 1.5;
        let z = venue.site.z + c * venue.depth * 1.5;
        for (const [back, side] of [[1.5, 0], [1.9, 0], [1.5, 0.5], [1.5, -0.5], [2.4, 0], [1.1, 0]] as const) {
          const px = venue.site.x + s * venue.depth * back + c * venue.depth * side;
          const pz = venue.site.z + c * venue.depth * back - s * venue.depth * side;
          const g = wildGround(px, pz);
          if (!raveSolid(px, g + 1.1, pz)) { x = px; z = pz; break; }
        }
        player.position.set(x, wildGround(x, z) + EYE_HEIGHT, z);
        player.velocity.set(0, 0, 0);
        // Looking *down* the bearing at the booth. `controller`'s convention is
        // that yaw 0 faces -Z and forward is `(-sin yaw, -cos yaw)`; the booth is
        // at `centre - (sin b, cos b) * depth` and the arrival point is on the
        // far side of it, so the direction to look is exactly `-(sin b, cos b)`
        // and the yaw that produces it is `atan2(sin b, cos b)`. Adding a half
        // turn -- which the first cut did -- points the camera at the suburb
        // behind you, which is a very quiet way for this tool to appear broken.
        input.yaw = Math.atan2(s, c);
        input.pitch = 0;
        applyToCamera(player, camera);
        return `${venue.site.name}, ${['warehouse yard', 'under a bridge', 'parkland'][venue.site.kind]}`;
      },
    },

    night: {
      rig: nightLights,
      report: () => ({
        level: nightLights.level,
        lampsLit: nightLights.lampsLit,
        carsLit: nightLights.carLights.drawn,
        bikesLit: nightLights.bikeLights.drawn,
        torch: nightLights.torch.intensity,
        // Which of the three jobs the one spot light is doing, so a report taken
        // on a bike is not mistaken for a torch that has gone the wrong colour.
        beam: {
          angle: nightLights.torch.angle,
          distance: nightLights.torch.distance,
          colour: nightLights.torch.color.getHex(),
        },
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
     * The railway, for the console -- and this is the only way to look at it.
     *
     * A railway is 300 km of thin thing spread over a 60 km disc, so "does it
     * work" cannot be answered from wherever a player happens to be standing.
     * Three questions and three answers:
     *
     *     sydney.rail.report()        what is built, what it costs, what is drawn
     *     sydney.rail.stations('red') which stations match, and their vertical class
     *     sydney.rail.go('Redfern')   stand on the platform at one
     *
     * `report().chunkDraws` and `trains.modelDraws` together are the budget line
     * this feature is written against; `overflows` on either should stay at zero
     * for the life of the process.
     */
    rail: {
      /** The chunk ring itself, for poking at from the console. */
      world: railWorld,
      fleet: trains,
      report: () => ({
        bake: railBake === null ? 'absent' : `${railBake.lines.length} lines`,
        segments: railNetwork?.segments.length ?? 0,
        portals: railNetwork?.portals.length ?? 0,
        stations: railNetwork?.stations.length ?? 0,
        residentChunks: railWorld?.residentChunks ?? 0,
        chunkDraws: railWorld?.chunkDraws ?? 0,
        sleepers: railWorld?.sleeperCount ?? 0,
        masts: railWorld?.mastCount ?? 0,
        rebuildMs: railWorld?.rebuildMs ?? 0,
        overflows: railWorld?.overflows ?? 0,
        trains: { ...trains.stats },
      }),
      // --- The rail harness. See `railHarness` for what these are and why the
      //     board/alight pair presses the same button the player does.
      stations: railHarness.stations,
      /** Drive a body through the collision world. See `railHarness.walk`. */
      walk: railHarness.walk,
      /**
       * What the envelope has taken out of the world, for the console.
       *
       * `cut` is the number of buildings given an undercroft where they cross
       * the railway; `emptied` is the number the rule declined to cut because
       * there would have been nothing left, which is the count to watch -- see
       * `world/envelope.carve`.
       */
      envelope: () => ({ corridors: envelope.count, ...collision.carved }),
      when: railHarness.when,
      goto: railHarness.goto,
      catch: railHarness.goto,
      board: railHarness.board,
      alight: railHarness.alight,
      ride: railHarness.ride,
      state: railHarness.state,
      keys: () => ({ down: [...keys], mountHeld }),
      /**
       * WORKSTREAM X: what the team look is drawing, and the seam it reads from.
       *
       * `sydney.teamlook()` answers the three questions this feature can be
       * wrong about from outside: whether anybody has wired a team source at all
       * (offline and pre-merge, nobody has, and everything below is meant to be
       * zero), how many rings and tents are up, and what the local player is
       * currently wearing. `source: false` with a teamed roster is the one
       * failure that has no picture -- the whole feature simply does not appear
       * and looks like it was never merged.
       */
      teamlook: () => ({
        source: hasTeamSource(),
        me: { team: TEAM_NAME[teamOf(net?.id ?? 0)], bigNight: hasBigNight(net?.id ?? 0), horns: selfHorns !== null },
        rings: { drawn: teamRings.live, dropped: teamRings.dropped, cap: MAX_RINGS },
        tents: { standing: tents.live, queued: liveTents.length },
        slams: liveSlams.length,
        triangles: { horns: bigNight.hornTriangles, cactus: bigNight.cactusTriangles, tent: bigNight.tentTriangles },
      }),
      /**
       * The corridor as closed solids: what was swept, and what is under a point.
       *
       * `STATIONS.md`'s Phase 3a. Off unless `?vessels=1`, and the one handle
       * from which the three consumers can be compared from outside: `surfaceAt`
       * is the number the ground query answers with, the same number the ballast
       * is bedded onto and the same faces that are drawn. A point where it says
       * `null` is a point no formation covers, which is a statement about the
       * footprint rather than about the ground.
       */
      vessels: (x = player.position.x, z = player.position.z) => {
        if (vesselBuild === null) return 'no vessels -- boot with ?vessels=1';
        const y = vesselBuild.field.surfaceAt(x, z);
        return {
          formations: vesselBuild.runs.length,
          fromTrackRuns: vesselBuild.tracks,
          triangles: vesselBuild.triangles,
          drawn: vesselBuild.runs.reduce((n, r) => n + drawnTriangles(r.vessel), 0),
          metres: Math.round(vesselBuild.runs.reduce((m, r) => m + r.metres, 0)),
          refused: vesselBuild.refused,
          noTerrain: vesselBuild.noTerrain,
          doubleCells: vesselBuild.doubleCells,
          claimedCells: vesselBuild.claimedCells,
          sweepMs: +vesselMs.toFixed(1),
          at: { x: +x.toFixed(1), z: +z.toFixed(1), surfaceY: y > -Infinity ? +y.toFixed(3) : null },
        };
      },
      /**
       * Stand on the platform at a station, facing across the track.
       *
       * The original tool, kept because it is the one that answers "let me look
       * at this station" rather than "let me catch a train from it": it takes an
       * offset along the platform and does not care whether a service is due.
       * `goto` is the one to use for boarding -- it stands you in a doorway.
       */
      go: (name = 'Central', along = -46) => {
        const station = (railNetwork?.stations ?? []).find((s) =>
          s.name.toLowerCase().includes(name.toLowerCase()),
        );
        if (!station) return `no station matching "${name}"`;
        const px = -station.uz;
        const pz = station.ux;
        const x = station.x + station.ux * along + px * 4.4;
        const z = station.z + station.uz * along + pz * 4.4;
        player.position.set(x, station.trackY + 1.05 + EYE_HEIGHT, z);
        player.velocity.set(0, 0, 0);
        player.yaw = Math.atan2(-(station.z - z), station.x - x);
        input.yaw = player.yaw;
        clearAboard(playerCombat.aboard);
        return `${station.name} (${station.vertical}, ${station.platforms} platforms) at ${x.toFixed(0)}, ${z.toFixed(0)}`;
      },
    },

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
      planned: bikePlannedCount(),
      report: () => ({
        planned: bikePlannedCount(),
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
     * Taking a car, from a console.
     *
     * `sydney.trafficReport().standBesideParked` is the precedent and this is
     * the same idea one step further on: that one hands back a coordinate beside
     * a parked schedule car, and `find` here searches a *wide* radius for one
     * that is actually **takeable** -- stopped or under `TAKEABLE_SPEED`, and not
     * already somebody's -- which is a different question and the one that
     * matters. The manual test for this whole feature is two lines:
     *
     *     sydney.cars.find()      the nearest car you could get into, and where
     *     sydney.cars.stand()     put yourself beside it, then press E
     *
     * `stand` teleports and is therefore **offline only** -- online the server
     * owns the position and would correct it inside a snapshot, which would look
     * like the harness being broken rather than like the rule it is. Use
     * `/tp <suburb>` and walk, which is what a player does.
     */
    cars: {
      field: () => carWorld(),
      report: () => ({
        records: carWorld().size,
        driving: playerCombat.drivingCar,
        speed: playerCombat.carSpeed,
        kmh: Math.round(Math.abs(playerCombat.carSpeed) * 3.6),
        drawn: drivenCars.drawn,
        camRoll: Number(drivenCars.camRoll.toFixed(4)),
        prompt: takePrompt(takeableNear, playerCombat.drivingCar !== 0, playerCombat.phase),
        // --- Workstream H. `budget` is the room's ceiling now that nothing
        // expires, `smoking` is how many plumes are drawn, and `queued` is how
        // many ambient cars are being held behind something somebody left in a
        // lane -- which is the one number in this feature with no visual tell of
        // its own when it is *wrong* (a queue that never clears looks exactly
        // like traffic that is stopped at a light you cannot see).
        budget: `${carWorld().size}/${MAX_DRIVEN_CARS}`,
        smoking: carSmoke.drawn,
        queued: traffic.held.size,
        blockedFor: Number(honkWatch.standing.toFixed(2)),
        all: carWorld().all().map((c) => ({
          id: c.id,
          carId: c.carId,
          driver: c.driverId,
          body: c.body,
          x: Math.round(c.x * 10) / 10,
          z: Math.round(c.z * 10) / 10,
          speed: Math.round(c.speed * 10) / 10,
          health: Math.round(c.health),
          emptyS: Math.round(c.emptyMs / 1000),
        })),
      }),
      /**
       * The nearest takeable car within `radius` metres, or null.
       *
       * Deliberately **not** `resolveTake`: that one is the reach test at 2.2 m
       * and this is a search. The filter is otherwise identical -- under
       * `TAKEABLE_SPEED` and not suppressed -- so a car this returns is a car
       * `resolveTake` will agree about once you are standing next to it.
       */
      find: (radius = 300) => {
        const cars = carWorld();
        const tick = trafficTick(Date.now());
        let best: { identity: number; x: number; y: number; z: number; range: number; speed: number; parked: boolean } | null = null;
        forEachCarNear(
          traffic, player.position.x, player.position.z, radius, tick, carRoutes, carPose, (c) => {
            if (c.speed > TAKEABLE_SPEED) return;
            if (cars.suppressed(c.identity)) return;
            const range = Math.hypot(c.x - player.position.x, c.z - player.position.z);
            if (best !== null && range >= best.range) return;
            best = {
              identity: c.identity, x: c.x, y: c.y, z: c.z, range,
              speed: Math.round(c.speed * 100) / 100,
              parked: c.stage === CAR_STAGE_PARKED_IN || c.stage === CAR_STAGE_PARKED_OUT,
            };
          },
        );
        return best;
      },
      /** Stand beside the nearest takeable car. Offline only -- see the block header. */
      stand: (radius = 300) => {
        if (net) return 'online: the server owns your position. /tp to a suburb and walk.';
        const handle = (dev as { cars: { find(r: number): { x: number; y: number; z: number } | null } }).cars;
        const found = handle.find(radius);
        if (found === null) return 'no takeable car within that radius.';
        player.position.set(found.x + 1.8, found.y + EYE_HEIGHT, found.z);
        player.velocity.set(0, 0, 0);
        return found;
      },
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
     * one; see `minimap.ts`. It has no `toggle`: what decides whether this disc
     * is on the screen is **whether the phone is in one of your hands**, which
     * is `setScale` and is pushed every frame from `money.frame`. So
     * `stats().visible` and `stats().scale` are the two fields to read when the
     * compass is not where it used to be -- and `sydney.money.equip(2)` is how
     * to put it back from a console.
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
    /**
     * The Escape panel, so its three tabs can be opened without a mouse.
     *
     * Exposed because two of them cannot be checked any other way. The change
     * feed depends on a static file that a fresh clone does not have, and the
     * bug box's screenshot button depends on a frame being read inside the
     * render loop -- both of which are things somebody wants to *look at*
     * rather than assert, and both of which need the panel on a particular tab
     * before there is anything to look at.
     *
     *     sydney.panel.tab('bug')      open the bug box
     *     sydney.panel.tab('new')      open the change feed
     *     sydney.panel.grab()          take a frame exactly as the button does,
     *                                  through the render loop, and answer
     *                                  whether it came back blank
     *
     * `grab()` is the one that matters: it is the same call the button makes,
     * so a blank capture in a browser is reproducible from a console instead of
     * being a thing one person saw once.
     */
    panel: {
      open: () => suggestions.open(),
      close: () => suggestions.close(),
      tab: (name: 'suggest' | 'new' | 'bug') => {
        suggestions.open();
        suggestions.showTab(name);
        return suggestions.tab;
      },
      grab: () => grabber.request(),
      get captures() {
        return { grabbed: grabber.grabbed, blank: grabber.blanks };
      },
      get changelog() {
        return { build: changelog.build, dirty: changelog.dirty };
      },
    },

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
      /**
       * Every football this bat -- or anybody else's -- has sent back, and where
       * the last one was. See `game/swat.ts`.
       *
       * `count` is the one that answers a question a screenshot cannot: a swat
       * is 260 ms of puff and a 30 ms crack, and the browser panes this project
       * is developed against throttle a hidden tab to nothing. Paired with
       * `sydney.serve()`, which stages one, it is how the mechanic is checked
       * without a mouse and without luck.
       */
      get swats() {
        return { count: swatCount, last: lastSwat, radius: SWAT_RADIUS, speedScale: SWAT_SPEED_SCALE };
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

    /**
     * Have somebody throw one **at you**, timed to arrive on the bat. Offline only.
     *
     * `swing()` and `throwFooty()` above exist because a weapon that can only be
     * fired with a mouse cannot be checked from a console. This exists for the
     * same reason one interaction further along, and it is the only practical
     * way to stage a swat: a returned serve needs a ball thrown by somebody else
     * arriving inside the 100 ms the blade is out, and hitting that by hand
     * against a dummy that throws when it feels like it is a matter of luck.
     *
     * The sequence, which is the whole of it:
     *
     *   1. the nearest dummy is turned to face the player and the swing starts
     *      **now**, through `punchBuffer` -- the same path the mouse takes;
     *   2. `PUNCH_WIND_UP` later the blade comes out and the ACTIVE window runs
     *      for `PUNCH_ACTIVE`, so the ball has to arrive at about
     *      `0.15 + 0.05 = 0.2 s`;
     *   3. a ball covers the gap in roughly `distance / LAUNCH_SPEED`, so the
     *      throw is delayed by the difference.
     *
     * Roughly, and it says so in what it returns: `LAUNCH_RISE` lofts the throw
     * a little and `DRAG` sheds 9% of the speed a second, so the arrival is a
     * few milliseconds late at the far end of the range. The ACTIVE window is
     * 100 ms wide and the error is under ten, so it lands inside it from about
     * two metres out to about twelve. Past that the timing has to be nudged with
     * `arrive`.
     *
     * **Nothing here is a mechanic.** It drives the same `advance`, the same
     * `FootyField.add` and the same `swatBalls` a player's mouse does, through
     * the same buffers -- which is why it cannot stage a swat the simulation
     * would not have allowed.
     */
    serve(arrive = PUNCH_WIND_UP + PUNCH_ACTIVE * 0.5) {
      const target = dummies[0];
      if (!target) return 'no dummy to serve (online, or none spawned)';
      const c = target.combat;
      const dx = player.position.x - c.body.position.x;
      const dz = player.position.z - c.body.position.z;
      // The aim is set on the tick the ball leaves the hand rather than here --
      // see the `pendingServe` branch in `simulate` -- because a dummy's yaw is
      // rewritten by its own input every tick in between. All this needs to do
      // is make sure it has a ball to throw.
      c.phase = 'idle';
      c.ballCharges = 3;
      c.ballT = 10;
      punchBuffer = PUNCH_BUFFER;
      const range = Math.hypot(dx, dz);
      const delay = Math.max(0, arrive - range / LAUNCH_SPEED);
      // Counted down in **simulated** seconds by `simulate`, not by a
      // `setTimeout`, and the difference is the whole reason this works. The
      // swing's clock is `CombatantState.phaseT`, which only advances inside a
      // fixed step; a browser that has backgrounded this tab stops calling
      // `requestAnimationFrame` and stops the fixed steps with it, while a wall
      // clock keeps running. A throw scheduled on the wall clock would arrive
      // hundreds of simulated milliseconds after the swing it was aimed at, and
      // the embedded browser panes this project is developed against throttle a
      // hidden tab exactly that way -- `scores()` above records the same trap
      // from the other side.
      pendingServe = { combat: c, t: delay };
      return (
        `${target.kind} is ${range.toFixed(1)} m away; swinging now and throwing in ` +
        `${(delay * 1000).toFixed(0)} ms so the ball arrives ${(arrive * 1000).toFixed(0)} ms in, ` +
        `inside the ${(PUNCH_WIND_UP * 1000).toFixed(0)}-${((PUNCH_WIND_UP + PUNCH_ACTIVE) * 1000).toFixed(0)} ms window`
      );
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
     * What the near-field model fleet is doing.
     *
     * `trafficReport`'s argument again and one of its own: a claim is not in the
     * scene graph in any legible form -- it is an index into one of 24 instanced
     * sets -- so there is no way to ask "which cars are models right now" except
     * to ask the fleet. `sweepMs` is the number this feature is judged on and
     * `overflows` is the one that should never move: it counts sweeps that found
     * a model at capacity, which is the only way a car near enough to be a model
     * ends up drawn as a box.
     */
    carModelReport() {
      if (!carModels) return { loaded: false };
      return {
        loaded: true,
        models: carModels.loadedFiles.length,
        pools: carModels.poolSizes(),
        skipped: carModels.skipped,
        // Which files had their tyres put back on the road at load, and by how
        // much. See `carlod.mergeModel`'s appearance fix 1.
        reseated: carModels.reseated,
        claimed: carModels.claimedCount,
        parked: carModels.parkedTiles,
        triangles: carModels.triangles,
        sweepMs: Math.round(carModels.sweepMs * 1000) / 1000,
        overflows: carModels.overflows,
      };
    },

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
        // --- Workstream Q. The three numbers that say the obstacle rule and the
        // (dis)appearance latch are doing anything, without anybody having to look
        // at the street: how many cars are being held out of the picture because
        // they came into existence in front of you, how many are being drawn after
        // their schedule ended because they stopped existing in front of you, and
        // how big the roster of things they steer round is. A zero in `obstacles`
        // is the whole feature switched off (a client whose car models never
        // loaded -- see `carlod.CarModelFleet.obstacles`).
        latched: trafficMovers.latched,
        ghosted: trafficMovers.ghosted,
        obstacles: { bays: traffic.obstacles.bays, statics: traffic.obstacles.statics },
        // --- WORKSTREAM S. How many parked cars this client could actually steal,
        // which is the one number that separates "the streamer never wired the
        // sink up" from "there is nothing parked near you" -- the same picture and
        // completely different bugs, exactly as `carlod.parkedTiles` says of its
        // own pair. A zero here with a non-zero `obstacles.statics` means the take
        // is offering nothing while the traffic steers round the same cars.
        takeableStatics: { tiles: staticCars.tileCount, cars: staticCars.carCount },
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
     * Workstream E: the five characters and the live events, and where to stand
     * to meet one.
     *
     * `streetReport`'s argument verbatim, and it applies with more force here
     * than anywhere else in the build: **both tiers of this feature are pure
     * functions rather than objects**. An ambient Karen is a hash over a census
     * cell and an event is a hash over the in-game day, so when somebody reports
     * that they "never see any of the new characters" there is nothing in the
     * scene graph to inspect and the three possible causes -- the wrong time of
     * day, a cell whose bias is zero, and bands that have not streamed in --
     * look identical from inside the game.
     *
     * `standHere` is the useful field on both halves: a point a couple of metres
     * from the nearest character, and a point at the edge of the nearest live
     * event, so `sydney.look(sydney.characters().standHere)` is a one-liner that
     * puts the thing in front of the camera.
     */
    characters(radius = 200) {
      const tick = trafficTick(Date.now());
      const day = dayAtTick(tick);
      const here = player.position;
      const scratch: PedBand[] = [];
      const probe = createCharacterPose();
      const seen: Array<{ kind: string; metres: number; x: number; y: number; z: number }> = [];
      if (pedestrians) {
        forEachCharacterNear(pedestrians, here.x, here.z, radius, tick, scratch, probe, (p) => {
          seen.push({
            kind: npcKind(p.kind)?.name ?? String(p.kind),
            metres: Math.round(Math.hypot(p.x - here.x, p.z - here.z) * 10) / 10,
            x: Math.round(p.x * 10) / 10,
            y: Math.round(p.y * 10) / 10,
            z: Math.round(p.z * 10) / 10,
          });
        });
      }
      seen.sort((a, b) => a.metres - b.metres);
      const promoted = [...policeField().actors]
        .filter((a) => isCharacterKind(a.kind))
        .map((a) => ({
          id: a.id,
          kind: npcKind(a.kind)?.name ?? String(a.kind),
          state: Object.entries(NPC_STATE).find(([, v]) => v === a.state)?.[0] ?? String(a.state),
          metres: Math.round(Math.hypot(a.x - here.x, a.z - here.z) * 10) / 10,
          onYou: a.target >= 0,
        }));
      promoted.sort((a, b) => a.metres - b.metres);
      const near = seen[0];
      // The live events the renderer is holding, which is the same list the map
      // markers come off -- see the marker source. Reading the scene's list
      // rather than re-deriving it is deliberate: if the two ever disagree, this
      // report shows what is actually being *drawn*.
      const events = eventScene.live
        .map((s) => ({
          name: EVENT_NAME[s.kind] ?? String(s.kind),
          metres: Math.round(Math.hypot(s.x - here.x, s.z - here.z)),
          x: Math.round(s.x),
          z: Math.round(s.z),
          endsInRealMinutes: Math.round((s.startPhase + s.spanPhase - day.phase) * 60 * 10) / 10,
        }))
        .sort((a, b) => a.metres - b.metres);
      const site = eventScene.live[0];
      return {
        tick,
        day: day.index,
        phase: Math.round(day.phase * 1000) / 1000,
        daylight: daylight(day.phase),
        saturday: saturdayAt(day.index),
        ambient: seen.length,
        promoted: promoted.length,
        rigsDrawn: characterCrowd.ambient + characterCrowd.actors,
        costMs: Math.round(characterCrowd.costMs * 1000) / 1000,
        nearest: seen.slice(0, 8),
        onYou: promoted.slice(0, 8),
        events,
        eventCostMs: Math.round(eventScene.costMs * 1000) / 1000,
        eventInstances: eventScene.drawn,
        // Two metres back from the nearest one, at eye height, looking at them.
        standHere: near
          ? {
              x: near.x + (here.x - near.x) * 0.0001 + 2.2,
              y: near.y + EYE_HEIGHT,
              z: near.z + 2.2,
              yaw: Math.atan2(-(near.x - (near.x + 2.2)), -(near.z - (near.z + 2.2))),
            }
          : null,
        // And a viewpoint on the nearest live event: eighteen metres out, looking in.
        watchEvent: site
          ? {
              x: site.x + 18,
              y: wildGround(site.x + 18, site.z + 18) + EYE_HEIGHT,
              z: site.z + 18,
              yaw: Math.atan2(-(site.x - (site.x + 18)), -(site.z - (site.z + 18))),
            }
          : null,
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

    /**
     * The wallet, the slots and the phone. See `client/src/money.ts`.
     *
     *     sydney.money.report()          what is in each hand, and the balance
     *     sydney.money.equip(2)          raise the phone (0 bat, 1 footy, 3 fists)
     *     sydney.money.open()            open the phone's overlay
     *     await sydney.money.photo()     take a photograph, no viewfinder
     *
     * `open()` is the one that earns its place: the phone needs a cursor, a
     * cursor needs pointer lock to have been released, and a browser that
     * refuses pointer lock outright has no click sequence that gets there.
     * `photo()` is the same argument one step further -- the camera needs a
     * raised phone, a released pointer *and* a left click -- and it resolves
     * with the full-size JPEG data URL, so a session can grab one and inspect
     * it without ever opening the gallery. It also files it, so
     * `report().photos` moves.
     */
    money: money.debug,

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
