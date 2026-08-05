/**
 * Factions: the people in this city who are not players, and what they do about
 * you.
 *
 * ===========================================================================
 * THE CONTRACT. Read this section before writing a faction.
 * ===========================================================================
 *
 * This module is the police, and it is the **framework the police happen to be
 * the first user of**. Two more factions are queued behind it -- meth heads and
 * drunks, and wildlife -- and neither of them may edit this file. Everything
 * they need is a registration call, and everything they get in return is a
 * lifecycle they do not have to implement.
 *
 * ---------------------------------------------------------------------------
 * 1. REGISTER A KIND
 *
 *     import { registerNpcKind, NPC_STATE } from './factions.ts';
 *
 *     export const DRUNK_KIND = registerNpcKind({
 *       kind: 3,                       // the wire byte. See NPC_KIND below.
 *       name: 'drunk',
 *       radius: 0.32, height: 1.7,     // the capsule strikeNpc tests
 *       maxHealth: 1,                  // pips. bat = 1, footy = 1, car = 1.
 *       walkSpeed: 0.9, chaseSpeed: 3.2,
 *       downSeconds: 6,
 *       aggroClips: ['/audio/Drunk.wav', '/audio/Drunk_1.wav'],
 *       aggroCooldownSeconds: 9,
 *       feedKo: '%s got decked by a drunk',
 *       scoresKo: false,               // no leaderboard credit for an NPC KO
 *       think(actor, ctx) { ... },
 *     });
 *
 * `kind` is a byte and it is **claimed in `NPC_KIND` below** rather than picked
 * freely, for `traffic.LANE_CLASSES`' reason one layer up: the byte is on the
 * wire, a client and a server that disagree about what 3 means draw a police
 * officer as a seagull, and there is no frame that says so. Two bytes are
 * already reserved for the two factions that follow this one; take yours from
 * that table and leave the numbering alone.
 *
 * ---------------------------------------------------------------------------
 * 2. THE ACTOR LIFECYCLE, in three states and one rule
 *
 *     AMBIENT  ->  PROMOTED  ->  RESOLVED
 *
 *   - **Ambient** is a pure function of `(anchor, index, tick)` and costs
 *     **zero bytes of protocol**. Nobody sends an ambient actor anywhere: the
 *     client evaluates the same function the server does at the same tick and
 *     draws the same person in the same place, exactly as `game/traffic.ts` does
 *     for six thousand cars. A faction supplies its own placement function --
 *     the police walk the pedestrian band system out of reserved slots (see
 *     `POLICE_SLOT_BASE`), and a wildlife faction is free to place its actors
 *     against water, parks or rooflines instead. Ambient actors can still be
 *     *seen* (`policeWitness` walks them) and still be *hit* (`strikeNpc`), and
 *     being hit is one of the things that promotes them.
 *
 *   - **Promoted** is a live record in `FactionField.actors`. It has a position
 *     that is integrated rather than derived, an id, health, and a `think` that
 *     runs at 60 Hz on the authority (the server online, `main.ts` offline). It
 *     **is** on the wire -- see `protocol.encodeSnapshot`'s NPC section -- and
 *     it costs 18 bytes a snapshot.
 *
 *   - **Resolved** is a promoted actor that has finished: it walks back to where
 *     it came from and despawns, or it despawns where it stands. Nothing is
 *     retained.
 *
 * The rule is the cap. `MAX_ACTORS` promoted actors exist at once **across every
 * faction**, because the cap is a wire budget and the wire does not care whose
 * seagull it is. When a promotion would exceed it, `FactionField.promote` evicts
 * the lowest-priority actor first (`actorPriority`) and refuses only if nothing
 * scored lower than the newcomer. Design for being evicted: an actor that must
 * survive is an actor that has to be modelled some other way.
 *
 * ---------------------------------------------------------------------------
 * 3. CRIME AND THE POLICE, for a faction that wants to use them
 *
 *     reportCrime(playerId, REASON.WILDLIFE)   // "harming protected wildlife"
 *
 * One call. It opens an investigation on that player, or extends and re-labels
 * one already running. It is the whole of the wildlife faction's dependency on
 * this one: report the crime and the police arrive. `REASON.WILDLIFE` is
 * **already reserved and already has its string** -- see `REASON_TEXT` -- so the
 * banner reads correctly the day that faction lands and no protocol byte moves.
 *
 *     policeHostileTo(DRUNK_KIND)
 *
 * Also one call, and it is the drunks' half. It marks a kind as something the
 * police will engage on sight without any player being involved, so a drunk
 * fighting on the footpath in front of a pair of officers gets moved on. It
 * touches no file of yours and no file of mine.
 *
 *     policeWitness(x, z, tick, ctx)
 *
 * The query underneath both: the nearest officer, ambient or promoted, within
 * `WITNESS_RANGE` with a clear line of sight through `collision.blocked`.
 * Exported because a faction may want it for its own reasons -- a meth head who
 * behaves differently when watched, for instance -- and because a second
 * implementation of "can a cop see this" would be a second answer.
 *
 * ---------------------------------------------------------------------------
 * 4. DAMAGE GOES THROUGH ONE DOOR
 *
 *     strikeNpc(field, actorOrAmbient, pips, cause, attackerId, tick)
 *
 * Bat, football, car, and whatever a future weapon is. It owns the re-hit guard,
 * the promotion of an ambient actor that has just been hit, the down clock, the
 * feed line and the "was that a knockout" answer. A faction that adjudicated its
 * own damage would get the re-hit guard subtly wrong -- a bat swung through a
 * pile of bodies re-launching all of them every tick it overlaps them is the
 * exact bug `pedestrians.knockDown` already documents -- and would have to
 * duplicate `feedKo`.
 *
 * ---------------------------------------------------------------------------
 * 5. DETERMINISM. The house rules, restated because they are load-bearing here.
 *
 * This module is compiled by **Bun (JavaScriptCore) on the server and by the
 * browser (V8) offline and for prediction**, and both have to produce the same
 * numbers or a player is shot at by police who, on their own screen, are looking
 * the other way.
 *
 *   - `Math.sqrt` is exact in IEEE-754 and is used freely. `Math.hypot` is
 *     **implementation-defined** and appears nowhere on a shared path --
 *     `game/traffic.poseCar` states the same rule and this file keeps it.
 *   - No `sin`, `cos` or `atan2` anywhere a result is compared across the wire.
 *     Headings are carried as a unit `(dx, dz)` pair; the single `Math.atan2` in
 *     this feature is in the snapshot encoder, turning that pair into the yaw a
 *     renderer wants, and nothing downstream of it feeds a decision.
 *   - Every random choice is `traffic.carHash`, an integer hash of integers.
 *     There is no PRNG and no state behind one.
 *
 * ---------------------------------------------------------------------------
 * 6. WHAT IS AUTHORITATIVE, AND WHAT IS A GUESS
 *
 * `think`, `strikeNpc`'s damage, `reportCrime` and the countdown run on the
 * **authority only**: `server/sim.ts` online, `main.ts` offline. A connected
 * client runs none of them -- it draws the NPC section of the snapshot and the
 * investigation channel and believes both.
 *
 * The one thing a connected client *does* compute for itself is the **banner**,
 * optimistically, on the frame it commits a crime it can see the witness for.
 * That is prediction in the same sense the bike mount is prediction: it is right
 * almost always, the authoritative answer is at most 50 ms behind it, and being
 * wrong costs a banner that clears itself. It is the difference between
 * "Under Investigation!" appearing when you swing and appearing a third of a
 * second later, and there is no version of this feature where the second one
 * feels correct.
 */

import { MAX_HEALTH, type CombatantState } from './combat.ts';
import {
  MAX_SLOTS,
  createPedPose,
  pedKey,
  posePedestrian,
  type PedBand,
  type PedPose,
  type PedestrianField,
} from './pedestrians.ts';
import { carHash, trafficSeconds } from './traffic.ts';
// A value import, not a type one, and it is safe: `player/collision.ts` imports
// nothing at all -- it is the one true leaf in this project -- so there is no
// cycle to be had. The self-check at the foot of this file builds a synthetic
// world out of it; nothing on the hot path constructs one.
import { CollisionWorld } from '../player/collision.ts';
import { EYE_HEIGHT } from '../player/controller.ts';

// --- The stations ---------------------------------------------------------------

/**
 * Every `amenity=police` in the built extent, and how busy its beat is.
 *
 * **Baked, with provenance.** Extracted from `data/cache/sydney.osm.pbf` -- the
 * same file the world was built from, stamp 1785746290 -- by a read-only scratch
 * script that projected each feature's centroid through `sydney.geo.lonlat_to_enu`
 * and `enu_to_world`, which is the identical path every building in the city took
 * to reach its tile. Nineteen features inside 5,300 m, every one of them on a
 * built tile, verified by `verifyPolice`.
 *
 * It is a table here rather than a sidecar for the reason `game/bikes.TUNING_X`
 * is two numbers rather than a file: nineteen records is 800 bytes, the pipeline
 * is not to be rebuilt, and a sidecar would be a fetch, a decoder, a version
 * word and a failure mode -- all to avoid typing coordinates that cannot change
 * without the world changing.
 *
 * ---------------------------------------------------------------------------
 * `weight` is **stylised, not statistical**, and saying so is the point.
 *
 * The user asked for spawns "based on police statistics (maybe do it by LAC,
 * with the station as the centroid)", and the honest version of that is: NSW
 * publishes incident counts by Local Area Command, the LAC boundaries are not in
 * this build, and pretending a number scraped from a PDF is a simulation of
 * policing would be dressing a taste decision as data. So this is the taste
 * decision, written down: **the CBD and Kings Cross are heavy, the harbour-side
 * suburbs are light, and the inner west is in between**, which is the shape the
 * real figures have and is the shape a player would expect walking from Pitt
 * Street to Mosman.
 *
 * The weight drives two things and nothing else: how many pairs walk a beat
 * (`beatPairs`) and how far the beat reaches (`catchment`). A station at 1.0 is
 * three pairs over 900 m; one at 0.15 is one pair over 645 m.
 */
export interface PoliceStation {
  readonly name: string;
  /** World metres. The renderer's frame: +X east, +Z south. */
  readonly x: number;
  readonly z: number;
  /** 0..1. See the note above on what this is and is not. */
  readonly weight: number;
}

export const POLICE_STATIONS: readonly PoliceStation[] = [
  { name: 'Day Street', x: -486.8, z: 740.3, weight: 1.0 },
  { name: 'Kings Cross', x: 1512.7, z: 452.6, weight: 0.95 },
  { name: 'Surry Hills', x: 416.6, z: 1204.6, weight: 0.85 },
  { name: 'Sydney Police Centre', x: 369.3, z: 1228.6, weight: 0.8 },
  { name: 'The Rocks', x: -50.6, z: -1034.4, weight: 0.7 },
  { name: 'Redfern', x: -821.2, z: 2590.4, weight: 0.7 },
  { name: 'Newtown', x: -2784.7, z: 3133.7, weight: 0.6 },
  { name: 'Woolloomooloo', x: 887.4, z: 404.4, weight: 0.55 },
  { name: 'Police Headquarters', x: 469.5, z: -872.5, weight: 0.45 },
  { name: 'Glebe', x: -1903.0, z: 1301.7, weight: 0.45 },
  { name: 'North Sydney', x: -477.1, z: -3934.5, weight: 0.45 },
  { name: 'Paddington', x: 2188.0, z: 2097.8, weight: 0.4 },
  { name: 'Waverley', x: 3979.2, z: 3163.5, weight: 0.35 },
  { name: 'Federal Police', x: 117.8, z: 1041.5, weight: 0.35 },
  { name: 'Mounted Police', x: 371.8, z: 2643.0, weight: 0.3 },
  { name: 'Balmain', x: -2993.0, z: -1315.2, weight: 0.3 },
  { name: 'Water Police', x: -1647.8, z: -1054.5, weight: 0.25 },
  { name: 'Rose Bay', x: 4015.3, z: 44.4, weight: 0.2 },
  { name: 'Mosman', x: 3165.2, z: -4055.6, weight: 0.15 },
];

/** The extent the stations were extracted inside. `verifyPolice` asserts it. */
export const STATION_EXTENT_M = 5300;

/**
 * How far a station's beat reaches, metres, at weight 0 and at weight 1.
 *
 * **Tight, and deliberately tighter than it first was.** The user's instruction
 * was to place police *"by LAC, with the station as the centroid"*, and the
 * first cut of that read "centroid" as "spread the beat over the command" -- a
 * 600-900 m radius, which is roughly the right size for a command and is
 * completely wrong as a *density*. Three pairs over 900 m is two and a half
 * pairs a square kilometre, and a player standing in the middle of it sees
 * nobody: a 200 m draw radius holds a fifteenth of that area.
 *
 * The number that actually matters is how often you meet one, so the placement
 * is a **cluster around the station** rather than a sample over the command. At
 * these radii a busy station puts ten pairs inside 520 m, which is about two
 * pairs in view at any moment in the CBD -- and the CBD has seven stations whose
 * catchments overlap, which is why it feels policed and Mosman does not.
 */
export const CATCHMENT_MIN = 260;
export const CATCHMENT_MAX = 520;

/**
 * How far a beat may be pushed out when the streets at the station's own door
 * carry no footpath bands, metres.
 *
 * **The rescue, and it is a correctness fix rather than a tuning number.** A
 * beat is placed on the bands inside `catchment(station)`, and `field.near`
 * returning *nothing* there is a real state with no frame that says so: the
 * station poses no officers at all and reads as a command that was never
 * staffed. Two ways into it, and neither is hypothetical.
 *
 * The first is the data. A station whose immediate streets are mapped as
 * `highway=footway` -- which is most of a pedestrianised block, and is exactly
 * what surrounds Newtown station -- sits in a hole in the band system, because
 * `pedestrians.SLOT_DENSITY` gives a footway no walkers and therefore no band to
 * walk. Police Headquarters is this build's live case: its nearest band is 117 m
 * out, past the 0 m every other inner station manages.
 *
 * The second is the *client*. A browser holds a ring of tiles around the player
 * and the server holds the extent, so a station near the edge of what is
 * resident genuinely has no bands in this process and has plenty in the other
 * one. An officer who exists on the server and not in the browser is the same
 * class of miss `beatBand` already documents.
 *
 * So the search widens -- doubling until it has a pool worth picking from --
 * and the beat lands on the nearest *real* footpaths instead of on nothing.
 * Nine hundred metres is about where "the streets near the station" stops being
 * true; past it the honest answer is that this station contributes nobody, and
 * the lattice below is what covers the ground either way.
 */
export const CATCHMENT_RESCUE_MAX = 900;

/** Pairs on the beat at weight 1. A pair is two officers; see `POLICE_SLOT_BASE`. */
const PAIRS_AT_FULL_WEIGHT = 10;
/** And the floor. A station with nobody outside it is a building. */
const MIN_PAIRS = 2;

export function catchment(station: PoliceStation): number {
  return CATCHMENT_MIN + (CATCHMENT_MAX - CATCHMENT_MIN) * station.weight;
}

/** How many pairs this station puts on the footpath. Never zero: a station has police at it. */
export function beatPairs(station: PoliceStation): number {
  const n = Math.round(station.weight * PAIRS_AT_FULL_WEIGHT);
  return n < MIN_PAIRS ? MIN_PAIRS : n;
}

/**
 * A station's hash seed. Its rounded coordinates, not its index.
 *
 * The index would be stable only for as long as nobody re-sorts the table above,
 * and the first thing anybody does to a table sorted by weight is re-sort it by
 * name. Keying on the position means a station's beat is the same beat in every
 * process and across every edit that does not move the station.
 */
export function stationSeed(station: PoliceStation): number {
  return carHash(Math.round(station.x) | 0, Math.round(station.z) | 0);
}

// --- Kinds -----------------------------------------------------------------------

/**
 * The wire byte per faction kind. **Append only, and claim yours here.**
 *
 * `traffic.LANE_CLASSES`' rule, and it bites harder: a lane class that shifted
 * would rename streets, and a kind byte that shifted would have the client
 * looking up the wrong render hooks, the wrong capsule and the wrong feed line
 * for every actor on the wire. 0 is deliberately not a kind, so a zeroed record
 * is not a valid seagull.
 */
export const NPC_KIND = {
  /** This file. Navy, in pairs, armed. */
  POLICE: 1,
  /** Reserved for the meth-head/drunk faction. Not registered here. */
  METHHEAD: 2,
  /** Reserved for the meth-head/drunk faction. Not registered here. */
  DRUNK: 3,
  /**
   * The wildlife faction, registered in `game/wildlife.ts`. Three bytes rather
   * than the one this table originally reserved as `WILDLIFE`: the species do
   * not share a capsule, a speed, a feed line or a renderer, and a single byte
   * with a species field behind it would have put a discriminator on the far
   * side of the wire from the thing that discriminates. Taking 4, 5 and 6 costs
   * nothing -- the byte has 249 values left -- and leaves every consumer's
   * `switch` reading as the animal it draws.
   */
  TURKEY: 4,
  IBIS: 5,
  MAGPIE: 6,
} as const;

/**
 * What an actor is doing, as one byte on the wire.
 *
 * A byte rather than the six booleans it stands in for, on
 * `protocol.ANIM`'s argument: the authority resolves the state once and every
 * client draws what it is told, so two clients cannot disagree about whether an
 * officer is aiming at you.
 */
export const NPC_STATE = {
  IDLE: 0,
  WALK: 1,
  /** Running at the suspect. */
  CHASE: 2,
  /** Stopped, weapon up, inside `AIM_TICKS` of firing. */
  AIM: 3,
  /**
   * A shot has just left the barrel. Held for `FIRE_STATE_TICKS`.
   *
   * Held rather than instantaneous, and the length is not cosmetic -- it is the
   * snapshot interval. The authority runs at 60 Hz and snapshots go out at 20,
   * so a state that lasted a single tick would be *sampled* by two clients in
   * three and missed by the other one, and the symptom is police whose shots you
   * sometimes hear and sometimes do not. Three ticks is exactly one snapshot
   * period, so every shot is carried by exactly one snapshot: never dropped, and
   * never counted twice. `protocol.FLAG.THROWING` is the same arrangement for
   * the same reason, at a different window.
   */
  FIRE: 4,
  /** On the ground. Cops get back up; see `POLICE_DOWN_SECONDS`. */
  DOWN: 5,
  /** Walking back to the beat. Despawns on arrival. */
  RETURN: 6,
} as const;

/** One promoted actor, as the authority simulates it and the wire carries it. */
export interface NpcActor {
  /** 1..65535, unique among live actors. 0 is "no actor". */
  id: number;
  kind: number;
  x: number;
  /** **Feet**, not the eye. `EYE_HEIGHT` is added where a sight line needs it. */
  y: number;
  z: number;
  /** Unit heading. Never an angle on this record -- see the header's rule 5. */
  dx: number;
  dz: number;
  state: number;
  /** Pips. `strikeNpc` is the only thing that lowers it. */
  health: number;
  /** Ticks left on the ground, or 0. */
  downTicks: number;
  /** Ticks in the current state. Drives the aim window and the return timeout. */
  stateTicks: number;
  /**
   * The combatant this actor is engaged with, or **-1 for nobody**.
   *
   * Minus one rather than zero, and it is worth the sentence because zero is a
   * perfectly good player id: `main.ts` builds the offline local player as
   * `createCombatant(0)`, where the server's `nextId` starts at 1. An earlier
   * cut of this used 0 for "no target", which worked on the server and made
   * every promoted officer in `?offline` stand down on the tick they were
   * promoted -- they were chasing player 0, the test read that as chasing
   * nobody, and they walked home. Nothing threw, the countdown ran normally, and
   * the only symptom was that the police never arrived.
   *
   * Not on the wire. See `protocol.NPC_BYTES` for why a client is not told who
   * an officer is after.
   */
  target: number;
  /** Where this actor came from, and where a `RETURN` walks back to. */
  homeX: number;
  homeZ: number;
  /**
   * Ticks until this actor may fire again. Counted **down**, one per `think`.
   *
   * A countdown rather than "the tick of the last shot", and the difference is a
   * bug this feature actually shipped with for an afternoon. `ctx.tick` is the
   * shared **wall-clock** tick -- `traffic.trafficTick(Date.now())` -- because
   * that is what the pedestrian bands and therefore the beats are denominated
   * in, and it is the right clock for asking *where an officer on a beat is*. It
   * is the wrong clock for asking *how long since this officer fired*: an
   * authority stepping faster than real time (an integration check running 1,500
   * ticks in a few milliseconds, a server catching up after a stall) would see
   * wall time barely move and an officer would fire once and never again.
   *
   * Counting simulation ticks makes the cadence a property of the simulation,
   * which is what it is. The wall clock keeps the job it is actually good at.
   */
  fireCooldown: number;
  /**
   * Rounds this actor has fired. A hash input, and the only reason it is not
   * just a diagnostic.
   *
   * The miss roll is `carHash(actor.id, tick ^ shotsFired * k)` rather than
   * `carHash(actor.id, tick)`, for the same reason the cooldown is not a wall
   * clock: two shots from one officer inside the same millisecond of wall time
   * would otherwise roll the same number, and an authority running faster than
   * real time would produce an officer who either cannot miss or cannot hit.
   */
  shotsFired: number;
  /** The tick of the last aggro bark, for the audio cooldown. */
  barkedAt: number;
  /** The last tick `strikeNpc` landed on this actor. The re-hit guard. */
  struckAt: number;
  /**
   * The frame this actor was last present in a snapshot. **Client-side only.**
   *
   * `net/client.ts` rebuilds its actor set against each snapshot rather than
   * accumulating one, so an actor that resolved simply stops appearing and stops
   * being drawn -- which is `RemoteBall.seen`'s trick and `collision.Prism.seen`'s
   * before it: an integer compare on a field already in cache, against a `Set`
   * rebuilt every frame forever. The authority never reads it.
   */
  seen: number;
}

/**
 * Everything a faction has to say about a kind of person.
 *
 * Split deliberately down the middle: the top half is *simulation* and is read
 * by the server, the bottom half is *presentation* and is read only by the
 * browser. A server that imported a render hook would be a server that imported
 * three, which `server/sim.ts` documents at length as the thing that must not
 * happen -- so the hooks are plain data (URLs, strings, numbers) and the drawing
 * lives in the faction's own `world/*.ts`.
 */
export interface NpcKindDef {
  /** From `NPC_KIND`. */
  readonly kind: number;
  readonly name: string;
  /** The capsule `strikeNpc` and the shot test use, metres. */
  readonly radius: number;
  readonly height: number;
  /** Pips. A bat is 1, a football is 1, a car is 1 -- see `combat.MAX_HEALTH`. */
  readonly maxHealth: number;
  readonly walkSpeed: number;
  readonly chaseSpeed: number;
  /** How long a downed one stays down before getting back up. 0 never gets up. */
  readonly downSeconds: number;
  /**
   * Clips played when this actor aggros, chosen by hash so a pair does not speak
   * in unison. Fetched and decoded by `game/audio.CombatAudio.loadClip`.
   */
  readonly aggroClips: readonly string[];
  readonly aggroCooldownSeconds: number;
  /** `%s` is the victim's name. See `feedLine`. */
  readonly feedKo: string;
  /** Whether knocking one out credits a player's leaderboard row. Police: no. */
  readonly scoresKo: boolean;
  /**
   * One tick of this actor's behaviour, on the authority only.
   *
   * **Pure in the sense that matters**: deterministic given `(actor, ctx)`, with
   * every choice out of `carHash` and nothing read from a clock that is not
   * `ctx.tick`. It may mutate `actor` and it may call `ctx`'s methods; it may not
   * hold state between calls, because the server and an offline browser run it
   * over two different object graphs and a closure variable is a desync with no
   * frame that says so.
   */
  think(actor: NpcActor, ctx: FactionCtx): void;
}

const KINDS = new Map<number, NpcKindDef>();

/**
 * Claim a kind byte. Returns the byte, so a faction can `export const X =
 * registerNpcKind({...})` and have one name for it.
 *
 * Throws on a duplicate rather than overwriting, which is the one place in this
 * file an exception is the right answer: two factions registered on one byte is
 * not a state anything downstream can be correct in, it happens at module load
 * rather than in a frame, and the alternative -- last registration wins -- is a
 * bug whose symptom is a seagull with a gun.
 */
export function registerNpcKind(def: NpcKindDef): number {
  if (def.kind <= 0 || def.kind > 255 || (def.kind | 0) !== def.kind) {
    throw new Error(`factions: kind must be a byte in 1..255, got ${def.kind}`);
  }
  const already = KINDS.get(def.kind);
  if (already && already !== def) {
    throw new Error(`factions: kind ${def.kind} is already registered as "${already.name}"`);
  }
  KINDS.set(def.kind, def);
  return def.kind;
}

export function npcKind(kind: number): NpcKindDef | undefined {
  return KINDS.get(kind);
}

export function npcKinds(): readonly NpcKindDef[] {
  return [...KINDS.values()];
}

/** Substitute a name into a kind's feed template. One place, so the `%s` cannot drift. */
export function feedLine(template: string, name: string): string {
  return template.replace('%s', name);
}

// --- Crime and the investigation ------------------------------------------------

/**
 * Why the police are interested. **The byte is on the wire; append only.**
 *
 * `WILDLIFE` is reserved and complete before anything can commit it, which is
 * deliberate: the faction that will report it owns no protocol file, and a
 * reason code that arrived with that faction would be a protocol bump for a
 * string. It costs one row of a table to make that day a one-line change.
 */
export const REASON = {
  NONE: 0,
  ASSAULT: 1,
  BIKE: 2,
  WILDLIFE: 3,
  ASSAULT_POLICE: 4,
  AFFRAY: 5,
} as const;

/**
 * What the banner says. Rendered as `Under Investigation! {reason}`.
 *
 * Lower case and plain, which is `hud.ts`'s whole voice, and phrased as the
 * thing you *did* rather than as an offence class -- "assaulting a bystander"
 * rather than "common assault", because the player needs to know which of their
 * last four actions started this and not which schedule of the Crimes Act it
 * falls under.
 */
export const REASON_TEXT: Readonly<Record<number, string>> = {
  [REASON.ASSAULT]: 'assaulting a bystander',
  [REASON.BIKE]: 'riding a modified e-bike',
  [REASON.WILDLIFE]: 'harming protected wildlife',
  [REASON.ASSAULT_POLICE]: 'assaulting police',
  [REASON.AFFRAY]: 'affray',
};

export function reasonText(code: number): string {
  return REASON_TEXT[code] ?? 'suspicious behaviour';
}

/**
 * How long the countdown runs, in ticks, and what a fresh crime adds to it.
 *
 * 45 seconds is the user's number and the extension is a third of it. The cap
 * matters more than either: without one, a player who keeps offending is under
 * investigation for the rest of the session, and the instruction was that this
 * ends -- *"until the countdown gets to 0"*. Two minutes is long enough that
 * outrunning it is a real decision and short enough that it is survivable.
 */
export const COUNTDOWN_TICKS = 45 * 60;
export const EXTEND_TICKS = 15 * 60;
export const MAX_COUNTDOWN_TICKS = 120 * 60;

/** One player's standing with the police. */
export interface Investigation {
  playerId: number;
  reason: number;
  /** Ticks remaining. Counts down regardless of line of sight -- see `stepInvestigations`. */
  ticks: number;
  /** The tick it was opened on. A hash input for the shot model. */
  since: number;
}

/**
 * A crime nobody has adjudicated yet.
 *
 * Module-level, on exactly `pedestrians.onPedestrianStruck`'s argument: there is
 * one player, one city and one set of consequences in a session, and threading a
 * field through every future consumer so it could report a crime would mean the
 * wildlife faction had to be handed the police field to reach the police.
 *
 * Drained by `FactionField.step` on the next tick rather than applied on the
 * call, which is what keeps the authority's tick order the only order: a crime
 * reported from inside a ball's step and one reported from inside a swing
 * resolve in the same place, in the same order, on both ends.
 */
const pendingCrimes: Array<{ playerId: number; reason: number }> = [];

/**
 * Tell the police about something. **The whole of a consumer's dependency on
 * this module.**
 *
 * Safe to call from anywhere on the authority, including from inside another
 * faction's `think`. It is a no-op for a player id of 0, which is how the
 * environment says "nobody did this" -- see `server/sim.ts`'s car sentinel,
 * where an event whose attacker is its own victim carries exactly that meaning.
 */
export function reportCrime(playerId: number, reason: number): void {
  // **Negative is nobody**, not zero. Zero is a real player -- `main.ts` gives
  // the offline local player id 0 where the server's ids start at 1 -- so a
  // falsy test here would make every crime a consumer reported in `?offline`
  // silently vanish. `server/sim.ts`'s car sentinel says "nobody did this" by
  // making the victim their own attacker rather than by using an id of 0, so
  // nothing in this project actually needs 0 to mean absent.
  if (!Number.isFinite(playerId) || playerId < 0) return;
  pendingCrimes.push({ playerId, reason });
}

/** For a check that has to start from nothing, and for a respawn. Not called in play. */
export function clearPendingCrimes(): void {
  pendingCrimes.length = 0;
}

/**
 * Kinds the police will engage without a player being involved.
 *
 * The drunks' half of the contract, and it is a `Set` of bytes rather than a
 * flag on `NpcKindDef` for one reason: the faction that *is* hostile does not
 * own the definition of the faction that *reacts* to it. A drunk marking itself
 * `policeHostile: true` in its own registration would be a drunk asserting
 * something about the police; calling `policeHostileTo(DRUNK_KIND)` is the
 * drunks' author telling this module a fact and this module deciding what to do
 * with it. The distinction costs nothing and is the difference between a
 * framework and a pile of flags.
 */
const policeHostile = new Set<number>();

export function policeHostileTo(kind: number): void {
  policeHostile.add(kind);
}

export function isPoliceHostile(kind: number): boolean {
  return policeHostile.has(kind);
}

// --- The context a `think` is handed ---------------------------------------------

/** Something the presentation layer should react to. Never simulation state. */
export type FactionEvent =
  | {
      kind: 'shot';
      actorId: number;
      /** The muzzle, and where the round went. Draws the tracer. */
      x: number; y: number; z: number;
      tx: number; ty: number; tz: number;
      hit: boolean;
      victim: number;
    }
  | { kind: 'aggro'; actorId: number; npcKind: number; x: number; y: number; z: number; clip: string }
  | { kind: 'down'; actorId: number; npcKind: number; x: number; y: number; z: number; attacker: number };

export interface FactionCtx {
  /** The shared wall-clock tick. `traffic.trafficTick(Date.now())`. */
  tick: number;
  /** The fixed step, seconds. Always `1/60` on the authority. */
  dt: number;
  collision: CollisionWorld | null;
  groundHeight(x: number, z: number, feetY: number): number;
  /** The footpaths, for ambient placement and for a beat to walk back to. */
  peds: PedestrianField | null;
  /** Every combatant an actor may consider. Ascending id; the tick order. */
  combatants: readonly CombatantState[];
  field: FactionField;
  investigationOf(playerId: number): Investigation | undefined;
  /**
   * Hurt a player. **Authority only** -- the server, or `main.ts` offline.
   *
   * Routed through the context rather than called on the combatant directly so
   * that the two authorities can do different things with the same event: the
   * server has to emit a `HIT` and credit a down, and an offline browser has to
   * play the feedback. A `think` that reached into `CombatantState.health`
   * itself would work on one of them and be silent on the other.
   */
  damagePlayer(playerId: number, pips: number, actor: NpcActor): void;
  emit(event: FactionEvent): void;
}

// --- Police tuning ----------------------------------------------------------------

/**
 * How far an officer can witness a crime, metres, and it is the one number in
 * this file that is a *game* decision rather than a simulation one.
 *
 * 40 m is about the length of a city block's frontage. Shorter and the feature
 * never fires -- you can bat somebody senseless twenty metres from a squad car
 * and nothing happens, which reads as the police being broken. Longer and there
 * is nowhere in the CBD you can do anything at all, which reads as the police
 * being everywhere. It is tested against a line of sight rather than a radius,
 * so a corner is genuinely a corner: `collision.blocked` is what makes 40 m in
 * Martin Place a very different distance from 40 m in a Surry Hills lane.
 */
export const WITNESS_RANGE = 40;
const WITNESS_RANGE_2 = WITNESS_RANGE * WITNESS_RANGE;

/**
 * Eye height for a sight line, metres, for both ends of it.
 *
 * The *witness* end is an officer's eye at `EYE_HEIGHT` over their feet, which
 * is the same figure the player is. The *crime* end is chest height rather than
 * ground, because the thing being seen is a person doing something and a ray to
 * somebody's shoes is blocked by every parked car in the street.
 *
 * Exported because a check that stages a crime has to aim its own sight lines
 * at the same two heights this does. `checkPolice.findScene` tests whether the
 * officers it is about to hand a pursuit can actually see the spot, and a test
 * that used its own idea of chest height would be answering a slightly
 * different question from the one the sim asks -- which is the way a staged
 * scenario ends up asserting something the feature never promised.
 */
export const WITNESS_EYE = EYE_HEIGHT;
export const CRIME_HEIGHT = 1.1;

/** How fast a pursuing officer runs, m/s. Between a player's walk and their sprint. */
export const CHASE_SPEED = 6.4;
/** A beat is a stroll. The ambient pace comes from the band schedule; this is the return walk. */
export const POLICE_WALK_SPEED = 1.5;

/** Inside this, an officer stops and aims instead of closing, metres. */
export const ENGAGE_RANGE = 35;
const ENGAGE_RANGE_2 = ENGAGE_RANGE * ENGAGE_RANGE;

/** How long the weapon is up before the first shot, ticks. 0.6 s. */
export const AIM_TICKS = 36;
/** And between shots after that. 0.9 s -- a considered shot, not automatic fire. */
export const FIRE_INTERVAL_TICKS = 54;
/**
 * How long `NPC_STATE.FIRE` is held, ticks. **One snapshot interval.**
 *
 * `protocol.SNAPSHOT_INTERVAL` is 3 and this is 3, restated rather than imported
 * because that one is a *wire cadence* and this is a *simulation window*, and
 * the two are free to stop being equal: if snapshots ever went to 30 Hz, what
 * this should become is a question about this module rather than about that one.
 * What must stay true is that it is at least the snapshot interval, which
 * `verifyPolice` asserts against the number it is handed.
 */
export const FIRE_STATE_TICKS = 3;

/** Pips per hit. Six hits to drop a full-health player; four if they are already marked. */
export const SHOT_DAMAGE = 0.5;

/**
 * The miss model: hit probability at range, as a straight line.
 *
 * `0.85 - 0.02 * range`, clamped to [0.12, 0.85]. That is **55% at 15 m**, which
 * is the number this was specified with, 75% at 5 m and 15% at the 35 m engage
 * range. The linearity is not a claim about ballistics -- it is a claim about
 * *pacing*: a player who closes on an officer takes more fire and a player who
 * breaks line of sight and runs takes almost none, and both of those have to be
 * legible from inside the game within a couple of seconds.
 *
 * The roll is `carHash(actor.id, tick)`, so it is decided identically on the
 * server and in an offline browser and cannot be dodged by a client that stops
 * sending inputs -- which is the whole reason it is a hash of the tick rather
 * than a `Math.random()`.
 */
export function hitChance(range: number): number {
  const p = 0.85 - 0.02 * range;
  return p < 0.12 ? 0.12 : p > 0.85 ? 0.85 : p;
}

/** How long a batted officer stays down, seconds. They are hardy; they get up. */
export const POLICE_DOWN_SECONDS = 5;
/** Pips an officer carries. Three bat swings, and the third only knocks them over. */
export const POLICE_MAX_HEALTH = 3;

/** How far from the suspect an ambient officer will promote into a pursuit, metres. */
export const PROMOTE_RADIUS = 120;
/** How many pursuers one investigation tries to keep on a suspect. */
export const PURSUIT_TARGET = 4;
/** Ticks between reinforcements trickling out of the nearest station. 2 s. */
export const REINFORCE_INTERVAL_TICKS = 120;
/** How long a stood-down officer walks before giving up and despawning, ticks. */
const RETURN_TIMEOUT_TICKS = 12 * 60;

/**
 * Promoted actors alive at once, across **every** faction.
 *
 * A wire budget, not a simulation one: 24 actors at 18 bytes is 432 B on a
 * snapshot, against the 345 B sixteen players cost, and `protocol.ts`'s header
 * documents the whole stream against spec 10's 30 kbit/s. Anything past this and
 * the NPC section is the largest thing on the wire.
 */
export const MAX_ACTORS = 24;

// --- Where an ambient officer is --------------------------------------------------

/**
 * Slots 48 and up on a footpath band belong to the factions.
 *
 * `pedestrians.pedKey` packs the slot into six bits and `MAX_SLOTS` is 40, so
 * 48..63 is sixteen identities per band that no pedestrian can ever occupy. That
 * is the whole trick behind ambient placement costing nothing: an officer on a
 * beat **is** a walker on the band system, evaluated by the same
 * `posePedestrian` -- the same binary search, the same alternating traversal, the
 * same absence of a transcendental -- so their position is a pure function of
 * `(band, slot, tick)` in every process, and none of the machinery had to be
 * written twice.
 *
 * A faction that wants its own reserved range should take it from the same
 * sixteen and say so here. Sixteen is not a lot; a faction that needs more
 * should place its actors some other way rather than widening `pedKey`, which is
 * exact in a double precisely because it is 39 bits.
 */
export const POLICE_SLOT_BASE = 48;
export const POLICE_SLOT_SPAN = 8;

/**
 * How far the second officer of a pair walks from the first, metres, offset to
 * the left of their shared heading.
 *
 * A fixed offset rather than a second slot, and the difference is the whole
 * reason cops read as a *pair*. Two slots on one band have two hashed speeds and
 * two hashed phases, so they would drift apart within a block and meet again by
 * coincidence -- which is two officers who happen to be on the same street. An
 * offset partner is somebody walking *with* you.
 */
export const PAIR_OFFSET = 0.8;

/** One ambient officer, as `forEachPoliceNear` reports them. Reused; never allocated per visit. */
export interface BeatPose {
  /** `pedestrians.pedKey(band.osmId, band.side, slot)`, plus the partner bit. Stable. */
  key: number;
  station: number;
  x: number;
  y: number;
  z: number;
  dx: number;
  dz: number;
  /** 0 for the leader of a pair, 1 for their partner. */
  partner: number;
}

export function createBeatPose(): BeatPose {
  return { key: 0, station: 0, x: 0, y: 0, z: 0, dx: 0, dz: 1, partner: 0 };
}

/**
 * Which band a beat walks, chosen deterministically out of the resident set.
 *
 * The candidates are gathered by `PedestrianField.near` and then **sorted by
 * `(osmId, side)`** before one is picked, and the sort is the load-bearing line:
 * `near` returns bands in the order its grid buckets happen to hold them, which
 * depends on the order tiles were adopted, which on a browser is the order they
 * were streamed in and on the server is `Promise.all`'s completion order. Two
 * processes with the identical band set would otherwise pick different bands out
 * of it.
 *
 * What the sort cannot fix -- and what is stated here rather than papered over --
 * is that the two ends do not always *have* the same set. The server holds the
 * whole extent; a browser holds a ring around the player, and a station's
 * catchment can reach past it. So an ambient officer near the edge of what a
 * client has loaded may be somewhere else on the server, and the client's
 * *predicted* banner can be wrong for the 50 ms it takes the authoritative
 * investigation channel to arrive. That is the same class of miss the bike mount
 * already accepts and it costs the same thing: a banner that corrects itself.
 * Everything that matters -- who is actually under investigation, who is
 * actually being shot at -- is decided on the server against the whole city.
 */
function beatBand(field: PedestrianField, station: PoliceStation, beat: number, out: PedBand[]): PedBand | null {
  const bands = catchmentBands(field, station, out).bands;
  if (bands.length === 0) return null;
  const h = carHash(stationSeed(station), beat);
  return bands[h % bands.length];
}

/**
 * The sorted band set inside a station's catchment, **cached against the
 * resident set**.
 *
 * The cache is the difference between this feature costing nothing and costing a
 * millisecond. Without it, every officer pose re-runs `PedestrianField.near` --
 * a grid walk that rejects duplicates and allocates -- and then re-sorts its
 * answer, and that happens for every beat of every station in range, on every
 * frame, plus once more for every witness query. With ten pairs at a busy
 * station that is a hundred grid walks a frame to answer a question whose answer
 * changes only when a tile is streamed in or evicted.
 *
 * `PedestrianField.generation` is what makes the invalidation exact rather than
 * heuristic: it is bumped by `adopt` and `drop` and by nothing else, so a cached
 * set is stale precisely when the resident set has changed. Keyed on the field
 * itself so a process holding two -- the server's world and a check's rehearsal
 * -- does not serve one's bands for the other's.
 */
/**
 * A beat's band pool and **the radius it was actually found at**.
 *
 * The reach is carried beside the bands rather than recomputed, because
 * `forEachPoliceNear`'s gate has to match the search that placed the officers:
 * a rescued beat reaches past `catchment(station)`, and a gate that still used
 * the catchment would skip the very station whose officers had been pushed out
 * to find a footpath. See `CATCHMENT_RESCUE_MAX`.
 */
interface Beat {
  bands: PedBand[];
  reach: number;
}

const catchmentCache = new WeakMap<
  PedestrianField,
  { gen: number; byStation: Map<number, Beat>; byCell: Map<number, PedBand[]> }
>();

function catchmentBands(field: PedestrianField, station: PoliceStation, out: PedBand[]): Beat {
  let entry = catchmentCache.get(field);
  if (entry === undefined || entry.gen !== field.generation) {
    entry = { gen: field.generation, byStation: new Map(), byCell: new Map() };
    catchmentCache.set(field, entry);
  }
  const key = stationSeed(station);
  const cached = entry.byStation.get(key);
  if (cached !== undefined) return cached;
  // The catchment first, and then wider if the streets at this station's door
  // are not in the band system -- footway-mapped, or simply not resident in this
  // process yet. Doubling rather than stepping, so the common case costs one
  // grid walk and the starved case costs three. See `CATCHMENT_RESCUE_MAX`.
  let reach = catchment(station);
  field.near(station.x, station.z, reach, out);
  while (out.length < BEAT_BAND_POOL && reach < CATCHMENT_RESCUE_MAX) {
    reach = Math.min(reach * 2, CATCHMENT_RESCUE_MAX);
    field.near(station.x, station.z, reach, out);
  }
  // Sorted **by distance from the station**, and then clipped to the nearest
  // `BEAT_BAND_POOL`. Two separate jobs in one sort, and both are load-bearing.
  //
  // The *order* is what makes the pick deterministic: `near` returns bands in
  // whatever order its grid buckets happen to hold them, which depends on the
  // order tiles were adopted -- streaming order on a browser, `Promise.all`
  // completion order on the server -- so two processes with the identical band
  // set would otherwise choose different bands out of it. The trailing keys are
  // there to make the comparison total; distance alone ties constantly, because
  // the two sides of one street are the same distance from everything.
  //
  // The *clip* is what makes an officer findable. A catchment is a few hundred
  // metres and holds several hundred bands, and picking uniformly out of all of
  // them spreads ten pairs over the whole disc -- so a player standing at the
  // front door of a police station meets nobody, which is the first thing this
  // feature actually got wrong when it was played rather than checked. Confining
  // the pick to the nearest few dozen streets is what "the station as the
  // centroid" has to mean if it is to be visible: officers work outward from
  // their station, thinning with distance, exactly as the weights thin with
  // suburb.
  // The score is **roughly the expected squared distance of a walker on this
  // band from the station**, not the distance to the band, and the two are very
  // different for a long street.
  //
  // A walker's position along a band is uniform over its length -- that is what
  // `posePedestrian`'s schedule does -- so the length term is the variance of a
  // uniform distribution, `length^2 / 12`. Without it, King Street is the
  // closest street to Newtown station by any measure of the street itself, and
  // an officer assigned to it spends almost all of their time half a kilometre
  // away at the wrong end of it. With it, a 60 m side street around the corner
  // outranks a 900 m arterial that merely passes the door, which is what a beat
  // actually is.
  //
  // Measured, per station, over forty samples ten seconds apart against the
  // built world: Day Street holds a mean of 16.3 officers within 180 m, Kings
  // Cross 16.7, Newtown 9.8, Mosman 3.5. The one station that is genuinely
  // starved is **Police Headquarters**, whose nearest band is 117 m out because
  // the streets at its door are mapped as `highway=footway` and
  // `pedestrians.SLOT_DENSITY` gives a footway no walkers and therefore no band:
  // 2.7 officers within 180 m against 9.0 within 400. That is the class
  // `CATCHMENT_RESCUE_MAX` exists for -- the beat is pushed out to the nearest
  // *real* footpaths rather than thinning to nothing -- and it is why the pool
  // is filled by a widening search above rather than by one fixed radius.
  //
  // What the rescue cannot do is invent coverage where there is no station, and
  // nineteen discs of 300-520 m over a city of 5,300 m radius leaves most of it
  // outside every one of them. That is `forEachPatrolNear`'s job, not this one's.
  const score = (b: PedBand): number => {
    // Closest approach of the band's own bounds to the station, so a long street
    // that runs past the front door is not judged by where its far end is.
    const dx = Math.max(b.minX - station.x, 0, station.x - b.maxX);
    const dz = Math.max(b.minZ - station.z, 0, station.z - b.maxZ);
    return dx * dx + dz * dz + (b.length * b.length) / 12;
  };
  const bands = [...out]
    .sort((a, b) => score(a) - score(b) || a.osmId - b.osmId || a.side - b.side || a.minX - b.minX)
    .slice(0, BEAT_BAND_POOL);
  const beat: Beat = { bands, reach };
  entry.byStation.set(key, beat);
  return beat;
}

/**
 * How many of the streets nearest a station its officers actually walk.
 *
 * Twenty-four is about six blocks' worth of footpath in the inner city, and it
 * is chosen against the *pair count* rather than against a distance: ten pairs
 * over twenty-four bands means a busy station has an officer on roughly every
 * second street beside it, and a quiet one (two pairs) has a single pair
 * somewhere in the same six blocks. That ratio is what makes the weights read as
 * "how policed does this feel" rather than as "how far away are they".
 */
const BEAT_BAND_POOL = 12;

// --- The lattice between the stations ---------------------------------------------

/**
 * Foot patrols, on a grid, everywhere. **The answer to the dead corner.**
 *
 * ---------------------------------------------------------------------------
 * The problem this exists for, measured before it was written.
 *
 * A player spawns in Sydney Park, at (-2236, +4543) -- the St Peters corner of
 * Erskineville and Alexandria -- and walks up King Street for ten minutes. The
 * count of ambient officers within **600 m** of that spawn, sampled over forty
 * ticks: **zero**. Within 600 m of the first 600 m of that walk: **zero**. The
 * nearest station is Newtown, 1,513 m away, with a 416 m catchment; the next is
 * Redfern at 2,412 m. The spawn is 1,097 m outside the nearest beat and every
 * other beat in the city is further.
 *
 * That is not a tuning failure, it is a *shape* failure. Nineteen stations with
 * catchments of 300-520 m cover about 11 km^2 of a city that is 88 km^2, so
 * seven eighths of the map has no police in it at all -- and the eighth that
 * does is the eighth a player who spawned in the CBD would have walked anyway.
 * Widening the catchments does not fix it either: a beat spread over a kilometre
 * is a beat you never meet, which is the argument `CATCHMENT_MIN` already lost
 * once and should not lose twice.
 *
 * ---------------------------------------------------------------------------
 * So: a **lattice**, and the shape of it is the whole idea.
 *
 * The city is cut into `PATROL_CELL` squares. Every cell that **owns** a
 * footpath puts at least one pair on it, and cells near a station put up to
 * `PATROL_MAX_PAIRS`, while density still rises and falls with the same station
 * weights the beats use.
 *
 * The guarantee is deliberately about footpath rather than about area: a cell
 * of open parkland or water owns nothing and carries nobody, which is the
 * honest answer and the only one a player can check -- you cannot walk on the
 * middle of Sydney Park's grass and complain there is no beat on it. What that
 * costs is that the *pitch* has to be chosen against the worst real case rather
 * than against half a cell diagonal, which is what `PATROL_CELL`'s note is.
 *
 * It is deliberately **not** more stations. A station is a place officers come
 * *from* and its beat is a cluster around a front door, which is why
 * `catchmentBands` scores by expected distance and clips to the nearest dozen
 * streets. A patrol is the opposite claim: two officers walking a stretch of
 * arterial between commands, belonging to no door in particular. Modelling that
 * as a fake station would have meant inventing nineteen more `POLICE_STATIONS`
 * rows that no OSM feature backs, and `POLICE_STATIONS`' own header is explicit
 * that its coordinates are data and only its weights are taste.
 *
 * ---------------------------------------------------------------------------
 * What it costs: **nothing on the wire, and one grid walk per cell per resident
 * set.** A patrol is an ambient actor in exactly `POLICE_SLOT_BASE`'s sense -- a
 * reserved slot on a real band, posed by `posePedestrian`, a pure function of
 * (cell, index, tick) in every process. The band pool is cached against
 * `PedestrianField.generation` beside the stations', and `patrolPairs` is
 * memoised, so a warm query is a range of integers and a map lookup. Measured
 * against the built world: a 40 m witness query costs 3.3 us in the CBD and a
 * 180 m draw query 4.9 us for 20 officers.
 *
 * Kings Cross still is not Mosman. Measured within 180 m of each station over
 * forty ticks, before this lattice and after it: Kings Cross 16.7 -> 19.1,
 * Surry Hills 28.9 -> 29.1, Mosman 3.5 -> 6.8, and the spawn corner 0.0 -> 3.8.
 * The lattice raises the floor; it does not flatten the curve.
 */

/**
 * The lattice pitch, metres.
 *
 * **Measured against the guarantee, not chosen for a feeling.** One pair per
 * cell at 320 m is 9.8 pairs per square kilometre, and the thing that decides
 * the pitch is not that number -- it is the worst case at the spawn, because the
 * spawn is in the middle of Sydney Park and the cell containing it **owns no
 * footpath at all**. Coverage there comes entirely from the neighbours, and a
 * patrol spends part of its schedule in `posePedestrian`'s dwell, so a single
 * covering pair is regularly not standing anywhere.
 *
 * Sampled over 240 ticks at the disc centre and at four points on its rim, the
 * fewest officers within 400 m at any tick:
 *
 *     400 m cell   0    (nearest patrol reached 443 m)
 *     300 m cell   0    (one rim point still fell to nothing)
 *     320 m cell   2    (nearest patrol never past 327 m)
 *     250 m cell   6    (16 pairs per km^2 -- Erskineville is not that policed)
 *
 * So 320. It is not a smooth curve because band *ownership* shifts with the
 * pitch -- which cell holds which street changes as the grid moves -- and that
 * is exactly why this is a measurement rather than an argument.
 */
export const PATROL_CELL = 320;

/**
 * How far a cell searches for its footpaths, metres. **Half a cell's diagonal,
 * rounded up**, so the search covers the whole cell and no more.
 *
 * Derived rather than chosen: `320 * sqrt(2) / 2` is 226.3, and a search any
 * tighter than that would miss a band sitting in the cell's own corner, which
 * is a hole in a lattice whose entire job is not having holes. `verifyPolice`
 * asserts the relation rather than the number.
 */
export const PATROL_REACH = 230;

/**
 * The longest band a patrol will walk, metres.
 *
 * A cell **owns** the bands whose midpoints fall inside it -- see
 * `patrolBands`, where that ownership is what stops two cells putting two pairs
 * on the same footpath -- and an owned band can still run a long way outside the
 * cell that owns it. This bounds how far, which is what lets
 * `forEachPatrolNear`'s cell-index gate be an arithmetic range rather than a
 * search.
 *
 * Six hundred is measured, not guessed: of the 14,929 bands in the built extent,
 * the median is 103 m, the 99th percentile is 430 m, and **seven** are longer
 * than this. Excluding those seven costs a cell its longest street and never its
 * only one; keeping them would have widened every patrol query by 100 m to
 * accommodate 0.05% of the city.
 */
const PATROL_BAND_MAX = 600;

/**
 * The furthest a patrol can stand from its cell's centre, metres: a band
 * midpoint anywhere in the cell, plus half the longest band that midpoint could
 * belong to. The gate `forEachPatrolNear` widens its cell range by.
 */
const PATROL_SPAN = PATROL_REACH + PATROL_BAND_MAX / 2;

/**
 * How far a station's weight reaches into the lattice, metres, and how many
 * extra pairs it buys at full strength.
 *
 * The influence is deliberately much wider than any catchment: this is not the
 * beat, it is the *gradient* the beat sits in the middle of, and a gradient that
 * stopped at the catchment edge would draw a visible ring of extra officers
 * around every station. At 1,400 m the CBD's seven overlapping commands
 * saturate it, the inner west sits at a third of it, and the spawn corner --
 * 1,513 m from Newtown -- sits at exactly zero, which is the honest answer: the
 * police are there because police are everywhere, not because a command is.
 */
export const PATROL_INFLUENCE = 1400;

/** Pairs in a cell with no station near it. The floor, and the point of the lattice. */
export const PATROL_BASE_PAIRS = 1;
/** And in a cell the CBD's commands all overlap. */
export const PATROL_MAX_PAIRS = 3;

/**
 * Slots 56..63, above the beats' 48..55.
 *
 * A **disjoint** range rather than a shared one, and it is load-bearing: a
 * patrol that drew the same (band, slot) as a station beat would be two officers
 * standing inside each other with one `BeatPose.key` between them, which at a
 * glance is one officer and in the rig pool is a slot fighting itself. Sixteen
 * reserved identities per band, eight each, and `verifyPolice` asserts both
 * halves stay inside the six bits `pedestrians.pedKey` packs a slot into.
 */
export const PATROL_SLOT_BASE = 56;
export const PATROL_SLOT_SPAN = 8;

/**
 * How many nearby footpaths a patrol picks from.
 *
 * Smaller than `BEAT_BAND_POOL`, and for the opposite reason. A station spreads
 * ten pairs over a dozen streets so they do not walk in a column; a cell has one
 * to three pairs and wants them on the streets that actually carry people, so
 * the pool is short and the bias below does the choosing.
 */
const PATROL_BAND_POOL = 6;

/**
 * Metres of score subtracted per lane class, squared -- the score is a squared
 * distance, so a bias of 90 m is `90 * 90`. Negative pulls a class to the front
 * of the pool.
 *
 * `streetlife.BACKSTREET_BIAS` inverted, and the inversion is the character of
 * the thing: a loiterer holds up a service lane and a patrol walks the high
 * street. Index is `traffic.LANE_CLASSES`.
 *
 * Motorways are pushed away hard rather than excluded, because a class filter
 * would be a second answer to a question `pedestrians.SLOT_DENSITY` already
 * answers -- a motorway carries no walkers and usually has no band at all, and
 * on the rare stretch where one exists it should be the last street a patrol
 * takes rather than an impossible one.
 */
const ARTERIAL_BIAS: readonly number[] = [
  400 * 400, 400 * 400, // motorway, motorway_link -- nobody walks these
  120 * 120, 120 * 120, // trunk, trunk_link
  -90 * 90, -60 * 60,   // primary: the high street, and its ramps
  -70 * 70, -50 * 50,   // secondary
  -50 * 50, -35 * 35,   // tertiary
  0,                    // residential
  20 * 20,              // unclassified
  40 * 40,              // living_street
  70 * 70,              // service -- a laneway is not a beat
  0,                    // other
];

/** The cell an ordinate falls in. Negative-safe: `Math.floor`, never a truncation. */
export function patrolCell(v: number): number {
  return Math.floor(v / PATROL_CELL);
}

/** The centre of a cell index, in the same axis. */
export function patrolCentre(c: number): number {
  return (c + 0.5) * PATROL_CELL;
}

/**
 * How policed this point is, 0 to 1, as a smooth field over the station weights.
 *
 * A sum of linear falloffs rather than a nearest-station lookup, so overlapping
 * commands compound the way the CBD actually feels and a cell midway between two
 * quiet stations is not treated as empty. Clamped at 1: past that the lattice
 * would be arguing with the beats about who is heavy, and the beats win --
 * they are the ones with a door.
 *
 * No `Math.hypot`; see the header's rule 5.
 */
export function patrolWeight(x: number, z: number): number {
  let f = 0;
  for (const s of POLICE_STATIONS) {
    const dx = s.x - x;
    const dz = s.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= PATROL_INFLUENCE * PATROL_INFLUENCE) continue;
    f += s.weight * (1 - Math.sqrt(d2) / PATROL_INFLUENCE);
  }
  return f > 1 ? 1 : f;
}

/**
 * Pairs walking this cell. Zero outside the built extent, `PATROL_BASE_PAIRS`
 * everywhere inside it, more where the commands are.
 *
 * The extent gate is a cell *plus* a margin rather than the extent exactly,
 * because a cell whose centre is just outside can still hold the last built
 * street, and the alternative -- a ring of unpoliced blocks at the map edge --
 * is the dead corner this whole section exists to remove. Cells with nothing
 * under them cost one cached empty pool and pose nobody.
 *
 * **Memoised**, and it is not premature: this is a pure function of two integers
 * over a table frozen at module load, and `forEachPatrolNear` calls it for every
 * cell of every query -- twenty-five of them for a draw radius, nineteen square
 * roots each. Cached, a warm query does two integer hashes and a map lookup. The
 * map is bounded by the number of cells in the extent, which is 640.
 */
const patrolPairCache = new Map<number, number>();

export function patrolPairs(cx: number, cz: number): number {
  // The cells span about -14..+14 on each axis, so a 16-bit interleave is exact
  // in a double with room to spare and cannot alias.
  const memo = ((cx | 0) << 16) ^ (cz & 0xffff);
  const hit = patrolPairCache.get(memo);
  if (hit !== undefined) return hit;
  const x = patrolCentre(cx);
  const z = patrolCentre(cz);
  const gate = STATION_EXTENT_M + PATROL_CELL;
  let n = 0;
  if (x * x + z * z <= gate * gate) {
    const extra = Math.round(patrolWeight(x, z) * (PATROL_MAX_PAIRS - PATROL_BASE_PAIRS));
    n = PATROL_BASE_PAIRS + extra;
    if (n > PATROL_MAX_PAIRS) n = PATROL_MAX_PAIRS;
  }
  patrolPairCache.set(memo, n);
  return n;
}

/** A cell's hash seed, and its key in the band cache. Its indices, which are its identity. */
export function patrolSeed(cx: number, cz: number): number {
  return carHash(cx | 0, (cz | 0) ^ 0x7a51);
}

/**
 * The band pool a cell's patrols draw from, cached against the resident set.
 *
 * `catchmentBands` in miniature and sharing its cache entry, so one
 * `PedestrianField.generation` bump invalidates the beats and the lattice
 * together. The score is the beats' -- closest approach of the band's bounds
 * plus the uniform-walker variance term `length^2 / 12` -- with `ARTERIAL_BIAS`
 * added, and the same total ordering behind it: `near` returns bands in whatever
 * order its grid buckets hold them, which is streaming order on a browser and
 * `Promise.all` completion order on the server, so the trailing keys are what
 * make two processes pick the same street.
 *
 * ---------------------------------------------------------------------------
 * **A cell owns the bands whose midpoints fall inside it**, and that ownership
 * is the difference between this working and this being a bug.
 *
 * Cells overlap: a search radius of `PATROL_REACH` around two centres 400 m
 * apart shares a lot of ground, so a pool built from "the nearest bands" hands
 * the same footpath to two neighbouring cells -- and since the slot is drawn
 * from eight, two cells regularly drew the *same band and the same slot*.
 * `posePedestrian` is a pure function of (band, slot, now), so that is two pairs
 * standing in exactly the same place with exactly the same `BeatPose.key`:
 * four officers inside each other, one rig between them, and the witness query
 * counting a single pair twice. Measured at Day Street before the fix: **8 of 58
 * patrol keys were emitted more than once.**
 *
 * Ownership makes the collision impossible rather than unlikely. A band has one
 * midpoint, a midpoint is in one cell, and no two cells can pick it.
 *
 * The cost is that a cell whose ground holds no band midpoint contributes
 * nobody -- a park, a rail corridor, the water. That is the honest answer and a
 * better claim than the one it replaces: the guarantee is not "a pair in every
 * square of the map", it is **"a pair on every stretch of footpath"**, and a
 * player can only walk on the second one.
 */
function patrolBands(field: PedestrianField, cx: number, cz: number, out: PedBand[]): PedBand[] {
  let entry = catchmentCache.get(field);
  if (entry === undefined || entry.gen !== field.generation) {
    entry = { gen: field.generation, byStation: new Map(), byCell: new Map() };
    catchmentCache.set(field, entry);
  }
  const key = patrolSeed(cx, cz);
  const cached = entry.byCell.get(key);
  if (cached !== undefined) return cached;
  const x = patrolCentre(cx);
  const z = patrolCentre(cz);
  // `PATROL_REACH` is half a cell diagonal, so this is a superset of everything
  // the cell could own -- `near` answers on bounds, and a band whose midpoint is
  // in the cell has bounds that reach it.
  field.near(x, z, PATROL_REACH, out);
  const score = (b: PedBand): number => {
    const dx = Math.max(b.minX - x, 0, x - b.maxX);
    const dz = Math.max(b.minZ - z, 0, z - b.maxZ);
    return dx * dx + dz * dz + (b.length * b.length) / 12 + (ARTERIAL_BIAS[b.klass] ?? 0);
  };
  const owned: PedBand[] = [];
  for (const b of out) {
    if (b.length > PATROL_BAND_MAX) continue;
    if (patrolCell((b.minX + b.maxX) * 0.5) !== cx) continue;
    if (patrolCell((b.minZ + b.maxZ) * 0.5) !== cz) continue;
    owned.push(b);
  }
  const bands = owned
    .sort((a, b) => score(a) - score(b) || a.osmId - b.osmId || a.side - b.side || a.minX - b.minX)
    .slice(0, PATROL_BAND_POOL);
  entry.byCell.set(key, bands);
  return bands;
}

/**
 * Every patrol pair within `radius` of a point, at `tick`.
 *
 * Split out of `forEachPoliceNear` rather than inlined so a caller that wants
 * only the lattice -- a check counting coverage, a diagnostic overlay -- can ask
 * for it without filtering. The iteration order is cells in ascending
 * `(cx, cz)`, patrols ascending, leader before partner, which is
 * `forEachPoliceNear`'s own rule and for its reason.
 *
 * `station` on the emitted pose is **-1**: a patrol has no station, and every
 * consumer of that field already reads it as an index that may not resolve.
 */
export function forEachPatrolNear(
  peds: PedestrianField,
  x: number,
  z: number,
  radius: number,
  tick: number,
  bands: PedBand[],
  ped: PedPose,
  out: BeatPose,
  visit: (pose: BeatPose) => boolean | void,
): void {
  const now = trafficSeconds(tick);
  const r2 = radius * radius;
  // A patrol stands at most `PATROL_SPAN` from its cell's centre -- a band
  // midpoint anywhere in the cell, plus half the longest band it may walk -- so
  // the cells worth visiting are a **range of indices** rather than a search.
  // This is the whole reason the lattice costs what it costs.
  const gate = radius + PATROL_SPAN;
  const cx0 = patrolCell(x - gate);
  const cx1 = patrolCell(x + gate);
  const cz0 = patrolCell(z - gate);
  const cz1 = patrolCell(z + gate);
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      const pairs = patrolPairs(cx, cz);
      if (pairs <= 0) continue;
      const pool = patrolBands(peds, cx, cz, bands);
      if (pool.length === 0) continue;
      const seed = patrolSeed(cx, cz);
      // The slot is the cell's own offset **plus the pair index**, stepping by
      // one, rather than a hash of the pair.
      //
      // A hash was the obvious thing and it was wrong: two pairs of one cell
      // that hashed to the same band *and* the same slot are, since
      // `posePedestrian` is a pure function of (band, slot, now), two pairs
      // standing in exactly the same place under exactly the same key. With a
      // pool of six and eight slots that is about one collision in forty-eight
      // per pair of pairs, and measured at Day Street it was 8 of 58 patrol
      // keys emitted twice. Stepping makes it impossible instead of unlikely:
      // `PATROL_MAX_PAIRS` is 3 and `PATROL_SLOT_SPAN` is 8, so the slots of one
      // cell are always distinct, whatever bands they land on. `verifyPolice`
      // asserts that relation rather than trusting the two numbers to stay put.
      //
      // Across cells the bands themselves are disjoint -- see `patrolBands` --
      // so a key can only be claimed once in the whole city.
      const offset = carHash(seed, 0x31c7) % PATROL_SLOT_SPAN;
      for (let p = 0; p < pairs; p++) {
        const band = pool[carHash(seed, p) % pool.length];
        const slot = PATROL_SLOT_BASE + ((offset + p) % PATROL_SLOT_SPAN);
        if (!posePedestrian(band, slot, now, undefined, ped)) continue;
        const key = pedKey(band.osmId, band.side, slot);
        for (let partner = 0; partner < 2; partner++) {
          const off = partner === 0 ? 0 : PAIR_OFFSET;
          out.key = key * 2 + partner;
          out.station = -1;
          out.x = ped.x + ped.dz * off;
          out.y = ped.y;
          out.z = ped.z - ped.dx * off;
          out.dx = ped.dx;
          out.dz = ped.dz;
          out.partner = partner;
          const dx = out.x - x;
          const dz = out.z - z;
          if (dx * dx + dz * dz > r2) continue;
          if (visit(out) === true) return;
        }
      }
    }
  }
}

/**
 * Every officer on a beat within `radius` of a point, at `tick`.
 *
 * The iteration order is fixed rather than incidental -- stations in table
 * order, beats ascending, leader before partner, and then the patrol lattice in
 * ascending cell -- for `pedestrians.forEachPedestrianNear`'s reason: the
 * witness query takes the nearest and ties have to break the same way in every
 * process. Stations come first because a station's beat is the answer a player
 * standing outside a police station expects.
 *
 * Returns early if `visit` returns true, which is how the witness query stops
 * after finding somebody rather than posing the whole city.
 */
export function forEachPoliceNear(
  peds: PedestrianField,
  x: number,
  z: number,
  radius: number,
  tick: number,
  bands: PedBand[],
  ped: PedPose,
  out: BeatPose,
  visit: (pose: BeatPose) => boolean | void,
): void {
  const now = trafficSeconds(tick);
  const r2 = radius * radius;
  for (let s = 0; s < POLICE_STATIONS.length; s++) {
    const station = POLICE_STATIONS[s];
    const sdx = station.x - x;
    const sdz = station.z - z;
    const sd2 = sdx * sdx + sdz * sdz;
    // Two gates, and the outer one is the cheap one. A beat normally reaches
    // `catchment(station)`, but a starved one is pushed out as far as
    // `CATCHMENT_RESCUE_MAX` to find a footpath -- so the first test is against
    // the widest a beat could possibly be, and the second is against the width
    // this beat actually has in this process's band set. Gating on the catchment
    // alone would skip exactly the station whose officers had been rescued, and
    // the symptom would be a command that vanished the moment it was fixed.
    const outer = CATCHMENT_RESCUE_MAX + radius;
    if (sd2 > outer * outer) continue;
    const beatSet = catchmentBands(peds, station, bands);
    const gate = beatSet.reach + radius;
    if (sd2 > gate * gate) continue;

    const pairs = beatPairs(station);
    for (let beat = 0; beat < pairs; beat++) {
      const band = beatBand(peds, station, beat, bands);
      if (band === null) continue;
      const slot = POLICE_SLOT_BASE + (carHash(stationSeed(station), beat ^ 0x5f3a) % POLICE_SLOT_SPAN);
      // No down record: an officer's health is the faction's business and the
      // pedestrian registry must never put one of them on the ground.
      if (!posePedestrian(band, slot, now, undefined, ped)) continue;
      const key = pedKey(band.osmId, band.side, slot);
      for (let partner = 0; partner < 2; partner++) {
        // Left of the heading is `(dz, -dx)` in renderer axes -- the statement
        // `pedestrians.buildBand` makes about which side of a way is which, and
        // the same one `traffic.carOverlaps` makes.
        const off = partner === 0 ? 0 : PAIR_OFFSET;
        out.key = key * 2 + partner;
        out.station = s;
        out.x = ped.x + ped.dz * off;
        out.y = ped.y;
        out.z = ped.z - ped.dx * off;
        out.dx = ped.dx;
        out.dz = ped.dz;
        out.partner = partner;
        const dx = out.x - x;
        const dz = out.z - z;
        if (dx * dx + dz * dz > r2) continue;
        if (visit(out) === true) return;
      }
    }
  }

  // --- And the lattice, which is what covers the seven eighths of the city no
  // station's catchment reaches. See `forEachPatrolNear`.
  //
  // Last rather than first, and it is not arbitrary: `policeWitness` prefers the
  // *nearest* officer and breaks ties by iteration order, so a player standing
  // outside a station should be caught by that station's beat rather than by a
  // patrol who happens to be the same distance away. The one that costs nothing
  // to get right is the one a player has an opinion about.
  //
  // `visit` is passed straight through rather than wrapped, which is safe only
  // because this is the *last* statement: an early return out of the lattice is
  // an early return out of this function, which is what the contract promises.
  forEachPatrolNear(peds, x, z, radius, tick, bands, ped, out, visit);
}

// --- Marked cars ---------------------------------------------------------------------

/**
 * One car in this many wears a police livery **near a station**, and one in this
 * many **anywhere else in the city**.
 *
 * ---------------------------------------------------------------------------
 * The rule lives here rather than in `world/cars.ts`, where it started, for one
 * reason: it is a claim about where the police are, and `world/cars.ts` is a
 * renderer that imports `three`. A check that wanted to assert "a marked car
 * passes the spawn" could not load that module at all, so the claim was
 * untestable exactly where it was wrong. `POLICE_STATIONS` and `CATCHMENT_MAX`
 * are already here; the predicate belongs beside them.
 *
 * **Still visual only.** A liveried car is an ordinary car in every other
 * respect -- same baked timetable, same `traffic.applyCarHit`, nothing on the
 * wire, nothing in any hit test, no pursuit. A *behaving* police car needs a
 * route it chose rather than one it was baked onto, and that is a different
 * feature.
 *
 * ---------------------------------------------------------------------------
 * The floor is the new half, and it is the same shape complaint the lattice
 * answers on foot. The station gate alone meant the entire road network outside
 * nineteen 520 m discs carried no marked car at all: measured over the spawn's
 * first ten minutes of walking, **zero** marked cars within 600 m across forty
 * ticks, against thirty-three ordinary cars within 300 m. A city where the
 * police own no vehicles outside the CBD is a stranger claim than one where they
 * own a few everywhere.
 *
 * One in 36 anywhere is roughly a marked car per two kilometres of busy
 * arterial -- present, and still far short of the one in 12 in the CBD, so a
 * player crossing from Erskineville into town still watches the fleet thicken.
 * The choice is `carHash(route, slot)`, the same integer hash that already picks
 * a car's body and paint, so it is a pure function of the timetable and every
 * client draws the same car in the same livery with nothing sent.
 *
 * ---------------------------------------------------------------------------
 * The gradient between them is `patrolWeight`, **the same field the lattice
 * walks on**, and sharing it is the point rather than a saving. There is one
 * answer in this file to "how policed is this corner", and the foot patrols and
 * the marked cars are two readings of it: a suburb that gets three pairs on the
 * footpath gets the busy share on the road, and one that gets the floor gets the
 * floor. The alternative -- what this was before -- is a hard disc of
 * `CATCHMENT_MAX` around each station, which is a *step*: every marked car in
 * Mosman was at the same one-in-twelve density as the CBD right up to 520 m from
 * the door and then none at all at 521, and the boundary is visible from a
 * moving car.
 */
export const LIVERY_SHARE_NEAR = 12;
export const LIVERY_SHARE_CITY = 36;
/** How many of the city floor's slots the busiest ground opens up. 36 / 12. */
const LIVERY_STEPS = LIVERY_SHARE_CITY / LIVERY_SHARE_NEAR;

/**
 * Is this car one of the liveried ones? A pure function of (route, slot,
 * position), evaluated identically by every process that draws it.
 *
 * The shares are **nested by construction**: one roll in `0..35`, and the number
 * of values that pass rises from one to three with the policing field. Every car
 * the floor marks is also marked in the CBD, so the density is monotone in the
 * field and a car cannot be marked in Erskineville and unmarked on George
 * Street -- which is the one arrangement that would read as a bug rather than as
 * a gradient. Two independent rolls would have produced exactly that.
 *
 * The field is only evaluated for the one car in twelve that could possibly
 * qualify, which keeps nineteen square roots off the other eleven.
 */
export function policeLiveried(route: number, slot: number, x: number, z: number): boolean {
  const roll = carHash(route, slot ^ 0x9011ce) % LIVERY_SHARE_CITY;
  if (roll >= LIVERY_STEPS) return false;
  // The citywide floor. Always marked, wherever this car is.
  if (roll === 0) return true;
  return roll < 1 + Math.floor((LIVERY_STEPS - 1) * patrolWeight(x, z));
}

// --- The witness query -------------------------------------------------------------

/** What `policeWitness` found. Reused by the caller; never allocated per query. */
export interface Witness {
  /** True when anybody saw it. Every other field is meaningless when false. */
  seen: boolean;
  x: number;
  y: number;
  z: number;
  /** The promoted actor that saw it, or 0 for an officer still on their beat. */
  actorId: number;
  /** Plan distance, metres. */
  range: number;
}

export function createWitness(): Witness {
  return { seen: false, x: 0, y: 0, z: 0, actorId: 0, range: 0 };
}

/**
 * The nearest officer with a clear view of `(x, z)`, or nothing.
 *
 * **Both tiers are searched**, promoted actors first. That order is not
 * cosmetic: an officer already chasing you is by definition already looking at
 * you, and preferring them means a second crime committed mid-pursuit is
 * witnessed by the person pursuing rather than by somebody two streets away who
 * happened to be marginally closer -- which is what decides whether the
 * extension reads as "they saw that too" or as magic.
 *
 * The line of sight is `collision.blocked` from the officer's eye to chest
 * height at the crime, and a world with no collision loaded (the offline first
 * second, a self-check) counts as clear. That is the correct failure: a police
 * force that cannot see anything until the prisms arrive is a police force that
 * does not exist for the first second of a session, which is worse than one that
 * occasionally sees through a wall on a tile that has not loaded.
 */
export function policeWitness(
  x: number,
  z: number,
  tick: number,
  ctx: {
    peds: PedestrianField | null;
    collision: CollisionWorld | null;
    field: FactionField | null;
    bands: PedBand[];
    ped: PedPose;
    beat: BeatPose;
  },
  out: Witness,
): Witness {
  out.seen = false;
  out.actorId = 0;
  out.range = Infinity;
  let best2 = WITNESS_RANGE_2;

  // --- Promoted actors first. See the header.
  if (ctx.field) {
    for (const a of ctx.field.actors) {
      if (a.kind !== NPC_KIND.POLICE) continue;
      if (a.state === NPC_STATE.DOWN) continue;
      const dx = a.x - x;
      const dz = a.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > best2) continue;
      if (ctx.collision !== null && ctx.collision.blocked(a.x, a.y + WITNESS_EYE, a.z, x, a.y + CRIME_HEIGHT, z)) continue;
      best2 = d2;
      out.seen = true;
      out.x = a.x;
      out.y = a.y;
      out.z = a.z;
      out.actorId = a.id;
    }
  }

  // --- And the beats, which is where almost every first crime is caught.
  if (ctx.peds) {
    forEachPoliceNear(ctx.peds, x, z, WITNESS_RANGE, tick, ctx.bands, ctx.ped, ctx.beat, (p) => {
      const dx = p.x - x;
      const dz = p.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > best2) return;
      if (ctx.collision !== null && ctx.collision.blocked(p.x, p.y + WITNESS_EYE, p.z, x, p.y + CRIME_HEIGHT, z)) return;
      best2 = d2;
      out.seen = true;
      out.x = p.x;
      out.y = p.y;
      out.z = p.z;
      out.actorId = 0;
    });
  }
  if (out.seen) out.range = Math.sqrt(best2);
  return out;
}

// --- The field ---------------------------------------------------------------------

/**
 * Every promoted actor in the world, and every investigation running against a
 * player.
 *
 * One object on the authority. A connected client holds one too and puts nothing
 * in it -- `main.ts` fills `actors` from the snapshot's NPC section instead, so
 * the renderer reads one array either way and has no idea which mode it is in.
 */
export class FactionField {
  readonly actors: NpcActor[] = [];
  private nextId = 1;

  /** Keyed by player id. */
  private readonly investigations = new Map<number, Investigation>();

  /** The last tick a reinforcement left a station, so the trickle is a trickle. */
  private lastReinforce = 0;

  /** Events this tick, for the transport and the presentation. Reused; drain before the next step. */
  readonly events: FactionEvent[] = [];

  // Scratch, allocated once for the life of the process. `step` allocates nothing.
  private readonly bands: PedBand[] = [];
  private readonly ped: PedPose = createPedPose();
  private readonly beat: BeatPose = createBeatPose();

  /** Diagnostics for the overlay: promotions and shots this session. */
  promoted = 0;
  shots = 0;

  investigationOf(playerId: number): Investigation | undefined {
    return this.investigations.get(playerId);
  }

  /** Every player currently wanted. The transport encodes this. */
  liveInvestigations(): readonly Investigation[] {
    return [...this.investigations.values()];
  }

  /**
   * How many players are wanted, and each of them, without building an array.
   *
   * PERFORMANCE.md phase 1's GC discipline. `liveInvestigations` above spreads
   * a `Map` into a fresh array, which is the right shape for a caller that
   * wants a list and the wrong one for the three callers that ask this question
   * **every tick**: `server/sim.stepFactions` compares the count either side of
   * a step, and `server/index.ts` re-reads the set on its refresh cadence. Three
   * arrays a tick is 180 a second forever, for a number and a walk.
   *
   * Iteration order is the `Map`'s, which is insertion order, which is the
   * order crimes were reported -- the same order `liveInvestigations` gives and
   * the one `FactionField.step` already relies on.
   */
  get investigationCount(): number {
    return this.investigations.size;
  }

  forEachInvestigation(cb: (inv: Investigation) => void): void {
    for (const inv of this.investigations.values()) cb(inv);
  }

  /**
   * Open an investigation, or extend and re-label one already running.
   *
   * Re-labelling rather than keeping the first reason is deliberate and is the
   * one behaviour here a player will actually read: the banner has to answer
   * "why are they still shooting", and the honest answer to that is the *most
   * recent* thing you did. A banner still saying "riding a modified e-bike"
   * while you are batting an officer would be the interface lying about the
   * situation it exists to explain.
   *
   * Returns the investigation, whether it was new, and the reason it now
   * carries -- `server/sim.ts` needs all three to decide what to put on the wire.
   */
  accuse(playerId: number, reason: number, tick: number): { investigation: Investigation; opened: boolean } {
    const existing = this.investigations.get(playerId);
    if (existing === undefined) {
      const fresh: Investigation = { playerId, reason, ticks: COUNTDOWN_TICKS, since: tick };
      this.investigations.set(playerId, fresh);
      return { investigation: fresh, opened: true };
    }
    existing.reason = reason;
    existing.ticks = Math.min(MAX_COUNTDOWN_TICKS, existing.ticks + EXTEND_TICKS);
    return { investigation: existing, opened: false };
  }

  /** Drop an investigation outright. A respawn does not; see `stepInvestigations`. */
  clearInvestigation(playerId: number): void {
    this.investigations.delete(playerId);
  }

  clear(): void {
    this.actors.length = 0;
    this.investigations.clear();
    this.events.length = 0;
    clearPendingCrimes();
  }

  /**
   * Take an id. Wraps at 65535 and never returns 0, because 0 is "no actor" on
   * the wire and in `NpcActor.target`.
   */
  private takeId(): number {
    for (let attempt = 0; attempt < 65535; attempt++) {
      const id = this.nextId;
      this.nextId = this.nextId >= 65535 ? 1 : this.nextId + 1;
      if (!this.actors.some((a) => a.id === id)) return id;
    }
    return 1;
  }

  /**
   * How disposable an actor is, lowest first. See `MAX_ACTORS`.
   *
   * The order is: an actor already walking home, then a downed one, then one
   * with no target, then one by distance from its target. That last term is what
   * makes eviction feel right rather than arbitrary -- when the cap bites, the
   * officer who gets recalled is the one furthest from the thing everybody is
   * converging on, and the ones in the player's face stay.
   */
  private actorPriority(a: NpcActor): number {
    if (a.state === NPC_STATE.RETURN) return 0;
    if (a.state === NPC_STATE.DOWN) return 1;
    if (a.target < 0) return 2;
    const t = this.targetOf(a);
    if (!t) return 2;
    const dx = t.body.position.x - a.x;
    const dz = t.body.position.z - a.z;
    // 3 at 300 m out, rising as it closes. Bounded so it always beats the three
    // categorical tiers above it.
    return 3 + 1 / (1 + Math.sqrt(dx * dx + dz * dz) * 0.01);
  }

  private combatants: readonly CombatantState[] = [];

  private targetOf(a: NpcActor): CombatantState | undefined {
    if (a.target < 0) return undefined;
    for (const c of this.combatants) if (c.id === a.target) return c;
    return undefined;
  }

  /**
   * Put an actor into the world. Returns it, or null if the cap refused.
   *
   * The eviction is here rather than at the call sites because every faction has
   * to obey it and none of them should have to implement it. A caller that gets
   * null should do nothing -- an actor that could not be promoted stays ambient,
   * which is a perfectly good state for it to be in.
   */
  promote(kind: number, x: number, y: number, z: number, dx: number, dz: number, target: number): NpcActor | null {
    const def = KINDS.get(kind);
    if (!def) return null;
    if (this.actors.length >= MAX_ACTORS) {
      let worst = -1;
      let worstScore = Infinity;
      for (let i = 0; i < this.actors.length; i++) {
        const score = this.actorPriority(this.actors[i]);
        if (score < worstScore) {
          worstScore = score;
          worst = i;
        }
      }
      // The newcomer scores 3 -- a fresh pursuer with a target and no distance
      // measured yet. Nothing above that is evicted for it.
      if (worst < 0 || worstScore >= 3) return null;
      this.actors.splice(worst, 1);
    }
    const actor: NpcActor = {
      id: this.takeId(),
      kind,
      x, y, z,
      dx, dz,
      state: target >= 0 ? NPC_STATE.CHASE : NPC_STATE.WALK,
      health: def.maxHealth,
      downTicks: 0,
      stateTicks: 0,
      target,
      homeX: x,
      homeZ: z,
      fireCooldown: 0,
      shotsFired: 0,
      barkedAt: 0,
      struckAt: 0,
      seen: 0,
    };
    this.actors.push(actor);
    this.promoted++;
    return actor;
  }

  /**
   * One tick of every faction, and the whole of the authority's entry point.
   *
   * The order inside it is fixed and each step depends on the one before:
   *
   *   1. **Reported crimes**, drained from the module queue. A crime reported
   *      during last tick's ball step is applied here, in one place, in the
   *      order it was reported -- which is what makes two crimes on one tick
   *      resolve identically on both ends.
   *   2. **Countdowns**, which run *regardless of line of sight*. That is the
   *      user's instruction verbatim -- "until the countdown gets to 0" -- and
   *      it is also the only version that is playable: a countdown that paused
   *      when the police lost sight of you would never end.
   *   3. **Promotion and reinforcement**, so an investigation opened this tick
   *      has officers on it this tick rather than next.
   *   4. **`think`**, in ascending actor id, for `server/sim.ts`'s reason: two
   *      actors that act on the same tick have to resolve in an order both ends
   *      agree on.
   *   5. **Despawns**, after everything has read the list.
   */
  step(ctx: FactionCtx): void {
    this.events.length = 0;
    this.combatants = ctx.combatants;

    // --- 1. Reported crimes.
    for (const crime of pendingCrimes) this.accuse(crime.playerId, crime.reason, ctx.tick);
    pendingCrimes.length = 0;

    // --- 2. The countdowns.
    this.stepInvestigations();

    // --- 3. Officers, from the beat and then from the station.
    this.recruit(ctx);

    // --- 4. Think, in ascending id.
    this.actors.sort((a, b) => a.id - b.id);
    for (const actor of this.actors) {
      const def = KINDS.get(actor.kind);
      if (!def) continue;
      actor.stateTicks++;
      def.think(actor, ctx);
    }

    // --- 5. Despawns.
    for (let i = this.actors.length - 1; i >= 0; i--) {
      if (this.actors[i].health <= -1) this.actors.splice(i, 1);
    }
  }

  /** Tick every countdown down, and drop the ones that reached zero. */
  private stepInvestigations(): void {
    for (const [id, inv] of this.investigations) {
      inv.ticks--;
      if (inv.ticks <= 0) this.investigations.delete(id);
    }
  }

  /**
   * Get officers onto every suspect: the beat first, the station after.
   *
   * The beat is preferred and the station is the fallback, which is both the
   * cheaper order and the right one dramatically -- the pair who saw you are the
   * pair who come after you, and reinforcements are what happens when you have
   * outrun them.
   */
  private recruit(ctx: FactionCtx): void {
    if (this.investigations.size === 0) return;
    for (const inv of this.investigations.values()) {
      const suspect = ctx.combatants.find((c) => c.id === inv.playerId);
      if (!suspect) continue;
      const sx = suspect.body.position.x;
      const sz = suspect.body.position.z;

      let onIt = 0;
      for (const a of this.actors) {
        if (a.target === inv.playerId && a.state !== NPC_STATE.RETURN) onIt++;
      }
      if (onIt >= PURSUIT_TARGET) continue;

      // --- From the beat. Everybody inside `PROMOTE_RADIUS` comes, up to the
      // shortfall, nearest first by construction of the iteration order.
      if (ctx.peds) {
        let want = PURSUIT_TARGET - onIt;
        forEachPoliceNear(ctx.peds, sx, sz, PROMOTE_RADIUS, ctx.tick, this.bands, this.ped, this.beat, (p) => {
          if (want <= 0) return true;
          const actor = this.promote(NPC_KIND.POLICE, p.x, p.y, p.z, p.dx, p.dz, inv.playerId);
          if (actor === null) return true;
          want--;
          onIt++;
          this.bark(actor, ctx);
        });
      }
      if (onIt >= PURSUIT_TARGET) continue;

      // --- And from the nearest station, one every `REINFORCE_INTERVAL_TICKS`.
      //
      // A trickle rather than a van full, because a queue of four officers
      // arriving together from 600 m away reads as a spawn and four arriving
      // over eight seconds reads as a response. The interval is on the *field*
      // rather than per investigation, so two suspects do not double the rate --
      // there is one police force.
      if (ctx.tick - this.lastReinforce < REINFORCE_INTERVAL_TICKS) continue;
      const station = nearestStation(sx, sz);
      if (!station) continue;
      const dx = sx - station.x;
      const dz = sz - station.z;
      const d2 = dx * dx + dz * dz;
      const inv2 = d2 > 1e-6 ? 1 / Math.sqrt(d2) : 0;
      const ground = ctx.groundHeight(station.x, station.z, Infinity);
      const actor = this.promote(
        NPC_KIND.POLICE,
        station.x, ground, station.z,
        dx * inv2, dz * inv2,
        inv.playerId,
      );
      if (actor !== null) this.lastReinforce = ctx.tick;
    }
  }

  /**
   * Play a faction's aggro line, at most once per actor per cooldown.
   *
   * The clip is chosen by hash off the actor's id so a pair of officers who
   * promote on the same tick do not say the same thing at the same instant,
   * which is the single most obvious way a two-clip voice pack gives itself
   * away.
   */
  bark(actor: NpcActor, ctx: FactionCtx): void {
    const def = KINDS.get(actor.kind);
    if (!def || def.aggroClips.length === 0) return;
    const cooldown = def.aggroCooldownSeconds * 60;
    if (actor.barkedAt !== 0 && ctx.tick - actor.barkedAt < cooldown) return;
    actor.barkedAt = ctx.tick;
    const clip = def.aggroClips[carHash(actor.id, ctx.tick) % def.aggroClips.length];
    this.events.push({
      kind: 'aggro',
      actorId: actor.id,
      npcKind: actor.kind,
      x: actor.x,
      y: actor.y,
      z: actor.z,
      clip,
    });
  }
}

/**
 * The voice lines an officer has, as URLs.
 *
 * Exported beside the registration rather than only inside it because the client
 * has to *preload* them -- a clip fetched at the instant somebody aggros arrives
 * a second late, and a police line that arrives after the shooting starts is
 * worse than silence. `main.ts` warms these off the same gesture that brings the
 * audio context up. See `game/audio.CombatAudio.loadClip`.
 */
export const POLICE_CLIPS: readonly string[] = ['/audio/Police.wav', '/audio/Police_1.wav'];

/** The station nearest a point, or null if the table is empty. Plan distance. */
export function nearestStation(x: number, z: number): PoliceStation | null {
  let best: PoliceStation | null = null;
  let best2 = Infinity;
  for (const s of POLICE_STATIONS) {
    const dx = s.x - x;
    const dz = s.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < best2) {
      best2 = d2;
      best = s;
    }
  }
  return best;
}

// --- Taking damage -------------------------------------------------------------------

/** What one strike did to one actor. Returned rather than acted on. */
export interface NpcStrike {
  /** False when the strike was refused -- already down, or already hit this tick. */
  landed: boolean;
  /** The last pip went. For a kind with `downSeconds`, this is a knockdown rather than a death. */
  down: boolean;
  actorId: number;
  npcKind: number;
  x: number;
  y: number;
  z: number;
  /** The feed line, already substituted, or the empty string. */
  feed: string;
}

/**
 * Hurt an NPC. **The only door.** See the header's rule 4.
 *
 * `pips` is on `combat.MAX_HEALTH`'s scale, so a bat is 1 and a car is 1 -- the
 * shared paths hand their own damage straight through and nothing has to know
 * which weapon it was.
 *
 * The re-hit guard is one integer compare against `struckAt` and is the same
 * rule `traffic.canBeRunDown` and `pedestrians.knockDown` apply, restated here
 * because an actor is neither of those things: **one strike per actor per
 * tick**, and none at all while they are on the ground. Without it a bat swung
 * through a pair of officers takes both of them down twice.
 */
export function strikeNpc(
  field: FactionField,
  actor: NpcActor,
  pips: number,
  attackerName: string,
  attackerId: number,
  tick: number,
  ctx?: FactionCtx,
): NpcStrike {
  const out: NpcStrike = {
    landed: false, down: false, actorId: actor.id, npcKind: actor.kind,
    x: actor.x, y: actor.y, z: actor.z, feed: '',
  };
  const def = KINDS.get(actor.kind);
  if (!def) return out;
  if (actor.state === NPC_STATE.DOWN) return out;
  if (actor.struckAt === tick) return out;
  actor.struckAt = tick;
  actor.health -= pips;
  out.landed = true;

  if (actor.health > 0) return out;
  out.down = true;
  actor.state = NPC_STATE.DOWN;
  actor.stateTicks = 0;
  actor.downTicks = Math.round(def.downSeconds * 60);
  // Back on their feet with their health restored rather than at zero, which is
  // what makes an officer *hardy* rather than *immortal*: three more swings puts
  // them down again, and a player who wants to keep one out of the fight has to
  // keep hitting them.
  actor.health = def.maxHealth;
  // A kind with no downtime is simply gone. `health <= -1` is the despawn flag
  // `FactionField.step` sweeps on -- see there.
  if (def.downSeconds <= 0) actor.health = -2;
  out.feed = attackerName ? feedLine(def.feedKo, attackerName) : '';
  field.events.push({
    kind: 'down',
    actorId: actor.id,
    npcKind: actor.kind,
    x: actor.x,
    y: actor.y,
    z: actor.z,
    attacker: attackerId,
  });
  void ctx;
  return out;
}

/**
 * The nearest actor whose capsule the segment A-B passes within `pad` of.
 *
 * Takes `{ actors }` rather than a `FactionField`, which is the one structural
 * accommodation this module makes for the client: online the promoted actors
 * live in `net/client.NetClient.actors`, a `Map` filled from the snapshot, and
 * offline they live in a real field. Both are iterables of the same record, so
 * one signature serves the witness query, the hit test and the renderer -- and
 * there is no adapter type and no second record shape anywhere in the feature.
 *
 * The shared broadphase for every weapon in the game against every faction: the
 * bat hands it its own cast, a football hands it one tick of flight, and a
 * future weapon hands it whatever it has. It borrows nothing from `combat.ts`
 * except the arithmetic, exactly as `pedestrians.strikePedestrian` does, and for
 * the same reason -- an NPC is not a `CombatantState` and making one would put
 * it in the tick order, the snapshot's player section, the rewind buffer and the
 * roster.
 */
export function npcHitTest(
  field: { actors: Iterable<NpcActor> },
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  pad: number,
): NpcActor | null {
  let best: NpcActor | null = null;
  let bestD = Infinity;
  for (const actor of field.actors) {
    const def = KINDS.get(actor.kind);
    if (!def) continue;
    if (actor.state === NPC_STATE.DOWN) continue;
    const d = segmentToCapsule(
      ax, ay, az, bx, by, bz,
      actor.x, actor.y + def.radius, actor.z,
      actor.x, actor.y + def.height - def.radius, actor.z,
    );
    const reach = def.radius + pad;
    if (d > reach || d >= bestD) continue;
    bestD = d;
    best = actor;
  }
  return best;
}

/**
 * Closest distance between two segments.
 *
 * `combat.segmentDistance`'s arithmetic, restated rather than imported for the
 * reason `pedestrians.ts` restates the constants it borrows: this module is
 * compiled into the Bun server beside `combat.ts` and importing a function to
 * save fifteen lines would be fine -- what would not be fine is the *cycle*,
 * because `combat.ts` will eventually want to ask this module whether a target
 * is an NPC. Fifteen lines against a cycle is not a close call.
 *
 * No `Math.hypot`: see the header's rule 5.
 */
function segmentToCapsule(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  dx2: number, dy2: number, dz2: number,
): number {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = dx2 - cx, vy = dy2 - cy, vz = dz2 - cz;
  const wx = ax - cx, wy = ay - cy, wz = az - cz;
  const a = ux * ux + uy * uy + uz * uz;
  const b = ux * vx + uy * vy + uz * vz;
  const c = vx * vx + vy * vy + vz * vz;
  const d = ux * wx + uy * wy + uz * wz;
  const e = vx * wx + vy * wy + vz * wz;
  const denom = a * c - b * b;
  let s = 0;
  let t = 0;
  if (denom > 1e-9) {
    s = (b * e - c * d) / denom;
    s = s < 0 ? 0 : s > 1 ? 1 : s;
  }
  t = c > 1e-9 ? (b * s + e) / c : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  s = a > 1e-9 ? (b * t - d) / a : 0;
  s = s < 0 ? 0 : s > 1 ? 1 : s;
  const px = ax + ux * s - (cx + vx * t);
  const py = ay + uy * s - (cy + vy * t);
  const pz = az + uz * s - (cz + vz * t);
  return Math.sqrt(px * px + py * py + pz * pz);
}

// --- The police themselves --------------------------------------------------------

/**
 * How an officer moves: toward a point, at a speed, sliding off buildings.
 *
 * Resolved against the prisms with the player's own `CollisionWorld.resolve`,
 * so an officer takes the corner a player would take rather than walking through
 * a terrace -- and so a player who ducks into a lane is genuinely followed into
 * it. There is no pathfinding here and there is deliberately not going to be:
 * what a wall-sliding pursuer does when it loses you is stand at the wall, which
 * is exactly what the countdown is for.
 */
function walkToward(actor: NpcActor, tx: number, tz: number, speed: number, ctx: FactionCtx): number {
  const dx = tx - actor.x;
  const dz = tz - actor.z;
  const d2 = dx * dx + dz * dz;
  if (d2 < 1e-6) return 0;
  const d = Math.sqrt(d2);
  const inv = 1 / d;
  actor.dx = dx * inv;
  actor.dz = dz * inv;
  const step = speed * ctx.dt;
  let nx = actor.x + actor.dx * step;
  let nz = actor.z + actor.dz * step;
  if (ctx.collision) {
    const moved = ctx.collision.resolve(actor.x, actor.z, nx, nz, POLICE_RADIUS, actor.y + 0.42);
    nx = moved.x;
    nz = moved.z;
  }
  actor.x = nx;
  actor.z = nz;
  actor.y = ctx.groundHeight(nx, nz, actor.y);
  return d;
}

/**
 * How far an officer will go to move somebody on, and how close they get.
 *
 * The range is the witness range, and deliberately the same number: an officer
 * deals with what they can see, and a force that walked 80 m to a fight it had
 * no line on would be a force with a radio nobody wrote.
 */
const HOSTILE_RANGE = WITNESS_RANGE;
const HOSTILE_REACH = 1.8;

/**
 * The nearest actor of a police-hostile kind that is **engaged with somebody**,
 * or null. See `policeHostileTo`, and the branch in `POLICE.think` that uses it.
 *
 * "Engaged" is `target >= 0` or a chase state, which is the most a framework can
 * honestly know about a faction it did not write: it is the same pair of fields
 * every kind already maintains, and it means "this one is having a go at
 * somebody" without this file knowing what a drunk is.
 *
 * Line of sight is not tested. `policeWitness` tests it for a *crime*, which is
 * a claim about what an officer saw; this is an officer already in the street
 * dealing with a fight in it, and a scuffle is a thing you hear.
 */
function hostileNear(ctx: FactionCtx, officer: NpcActor): NpcActor | null {
  if (policeHostile.size === 0) return null;
  let best: NpcActor | null = null;
  let best2 = HOSTILE_RANGE * HOSTILE_RANGE;
  for (const a of ctx.field.actors) {
    if (!policeHostile.has(a.kind)) continue;
    if (a.state === NPC_STATE.DOWN || a.state === NPC_STATE.RETURN) continue;
    if (a.target < 0 && a.state !== NPC_STATE.CHASE && a.state !== NPC_STATE.FIRE) continue;
    const dx = a.x - officer.x;
    const dz = a.z - officer.z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= best2) continue;
    best2 = d2;
    best = a;
  }
  return best;
}

const POLICE_RADIUS = 0.35;
const POLICE_HEIGHT = 1.7;

/**
 * The police, registered.
 *
 * Everything about their behaviour is in `think` and everything about their
 * numbers is in the constants above it, which is the split every faction should
 * copy: a tuning pass should be a diff of numbers, not of control flow.
 */
export const POLICE = registerNpcKind({
  kind: NPC_KIND.POLICE,
  name: 'police',
  radius: POLICE_RADIUS,
  height: POLICE_HEIGHT,
  maxHealth: POLICE_MAX_HEALTH,
  walkSpeed: POLICE_WALK_SPEED,
  chaseSpeed: CHASE_SPEED,
  downSeconds: POLICE_DOWN_SECONDS,
  // The user's own two files, staged at `/audio/`. Played on aggro with a
  // cooldown, because two officers promoting on the same tick within earshot of
  // each other is the common case and not the exception.
  aggroClips: POLICE_CLIPS,
  aggroCooldownSeconds: 7,
  feedKo: '%s got done by the cops',
  // No leaderboard credit, in either direction. A player who batted an officer
  // has not scored and a player the police dropped was not knocked out *by*
  // anybody -- the same call `server/sim.ts` already makes about a car, and for
  // the same reason: a scoreboard is a record of what players did to each other.
  scoresKo: false,

  think(actor, ctx) {
    // The weapon's own clock, counted in simulation ticks and never in wall
    // time. See `NpcActor.fireCooldown`.
    if (actor.fireCooldown > 0) actor.fireCooldown--;

    // --- On the ground. Nothing else is true while this is.
    if (actor.state === NPC_STATE.DOWN) {
      actor.downTicks--;
      if (actor.downTicks <= 0) {
        actor.state = actor.target ? NPC_STATE.CHASE : NPC_STATE.RETURN;
        actor.stateTicks = 0;
      }
      return;
    }

    const inv = actor.target >= 0 ? ctx.investigationOf(actor.target) : undefined;
    const suspect = inv ? ctx.combatants.find((c) => c.id === inv.playerId) : undefined;

    // --- Stood down: the countdown ran out, or the suspect left the world.
    //
    // Walking back rather than vanishing, which costs a few seconds of wire per
    // officer and buys the only part of this loop a player sees the *end* of.
    // A pursuit that terminated by deleting four people would be the clearest
    // possible statement that they were never really there.
    if (!inv || !suspect) {
      actor.target = -1;
      // --- Before walking home: is there anything here this force has been told
      // to engage on sight?
      //
      // `policeHostileTo`'s other half, and the header above promises it in so
      // many words -- *"a drunk fighting on the footpath in front of a pair of
      // officers gets moved on"*. It is written here rather than in the faction
      // that registers the hostility because it is a statement about what the
      // **police** do, which is this file's business; the drunks' author says
      // one true thing about drunks and this decides what to do with it.
      //
      // Only an actor that is actually **engaged** -- swinging at somebody, or
      // running at them -- is moved on. A hostile kind standing quietly is a
      // person standing quietly, and a police force that promoted an officer for
      // every one of them would be a police force that never stopped.
      //
      // The baton rather than the weapon, which is why this is `AIM` and never
      // `FIRE`: the fire state is what a client draws a muzzle flash and a tracer
      // off, and a tracer drawn from an officer to a drunk they are arresting
      // would be a shooting nobody ordered. Officers close, stand over them, and
      // put them down over a couple of seconds.
      const quarry = hostileNear(ctx, actor);
      if (quarry) {
        const qx = quarry.x - actor.x;
        const qz = quarry.z - actor.z;
        const q2 = qx * qx + qz * qz;
        if (q2 > HOSTILE_REACH * HOSTILE_REACH) {
          if (actor.state !== NPC_STATE.CHASE) {
            actor.state = NPC_STATE.CHASE;
            actor.stateTicks = 0;
          }
          walkToward(actor, quarry.x, quarry.z, CHASE_SPEED, ctx);
          return;
        }
        const qd = Math.sqrt(q2);
        if (qd > 1e-6) {
          actor.dx = qx / qd;
          actor.dz = qz / qd;
        }
        if (actor.state !== NPC_STATE.AIM) {
          actor.state = NPC_STATE.AIM;
          actor.stateTicks = 0;
          ctx.field.bark(actor, ctx);
          return;
        }
        if (actor.fireCooldown > 0) return;
        actor.fireCooldown = FIRE_INTERVAL_TICKS;
        // Through the one door, so the re-hit guard, the down clock and the
        // despawn flag are the same ones a player's bat goes through. No
        // attacker name: a feed line reading "the police got done by the cops"
        // is what a name would produce, and nobody's leaderboard moves for an
        // arrest.
        strikeNpc(ctx.field, quarry, 1, '', -1, ctx.tick);
        return;
      }
      if (actor.state !== NPC_STATE.RETURN) {
        actor.state = NPC_STATE.RETURN;
        actor.stateTicks = 0;
      }
      const left = walkToward(actor, actor.homeX, actor.homeZ, ctx.dt > 0 ? POLICE_WALK_SPEED * 2 : 0, ctx);
      // Home, or long enough that nobody is watching. `health = -2` is the
      // despawn flag `FactionField.step` sweeps on.
      if (left < 2 || actor.stateTicks > RETURN_TIMEOUT_TICKS) actor.health = -2;
      return;
    }

    const tx = suspect.body.position.x;
    const tz = suspect.body.position.z;
    const ty = suspect.body.position.y;
    const dx = tx - actor.x;
    const dz = tz - actor.z;
    const range2 = dx * dx + dz * dz;

    // --- A knocked-out suspect is not shot at. They are already on the ground
    // and the countdown is still running, so the officers stand over them --
    // which is both the right picture and the thing that stops a respawn timer
    // being spent under fire.
    const shootable = suspect.phase !== 'ko' && suspect.health > 0;
    const clear =
      ctx.collision === null ||
      !ctx.collision.blocked(actor.x, actor.y + WITNESS_EYE, actor.z, tx, ty, tz);

    if (range2 > ENGAGE_RANGE_2 || !clear || !shootable) {
      if (actor.state !== NPC_STATE.CHASE) {
        actor.state = NPC_STATE.CHASE;
        actor.stateTicks = 0;
      }
      walkToward(actor, tx, tz, CHASE_SPEED, ctx);
      return;
    }

    // --- In range, in sight. Stop, face them, and put the weapon up.
    const d = Math.sqrt(range2);
    if (d > 1e-6) {
      const s = 1 / d;
      actor.dx = dx * s;
      actor.dz = dz * s;
    }
    if (actor.state !== NPC_STATE.AIM && actor.state !== NPC_STATE.FIRE) {
      actor.state = NPC_STATE.AIM;
      actor.stateTicks = 0;
      ctx.field.bark(actor, ctx);
      return;
    }
    // A shot is held for exactly one snapshot period and then the weapon comes
    // back down to aim, which is what lets a client fire a muzzle flash, a
    // tracer and a crack off the state byte alone -- no event, no extra message,
    // and nothing to lose. See `FIRE_STATE_TICKS`.
    if (actor.state === NPC_STATE.FIRE) {
      if (actor.stateTicks >= FIRE_STATE_TICKS) {
        actor.state = NPC_STATE.AIM;
        actor.stateTicks = 0;
      }
      return;
    }
    // The first shot waits out the aim; every one after it waits out the
    // cooldown, which the aim has usually already covered. Both are simulation
    // ticks.
    if (actor.stateTicks < AIM_TICKS || actor.fireCooldown > 0) return;

    // --- The shot.
    actor.state = NPC_STATE.FIRE;
    actor.stateTicks = 0;
    actor.fireCooldown = FIRE_INTERVAL_TICKS;
    actor.shotsFired++;
    // The roll: an integer hash of the actor and the tick. Not `Math.random`,
    // and the difference is the whole reason it is written down -- a client
    // predicting this offline and a server deciding it online have to agree, and
    // a client that stopped sending inputs must not be able to make the next
    // round miss.
    const roll = carHash(actor.id, (ctx.tick ^ Math.imul(actor.shotsFired, 0x9e3779b1)) | 0) / 4294967296;
    const hit = roll < hitChance(d);
    ctx.field.shots++;
    ctx.emit({
      kind: 'shot',
      actorId: actor.id,
      // The muzzle: chest height, a little in front of the officer.
      x: actor.x + actor.dx * 0.3,
      y: actor.y + 1.35,
      z: actor.z + actor.dz * 0.3,
      tx,
      ty: hit ? ty - 0.3 : ty + 0.4,
      tz,
      hit,
      victim: suspect.id,
    });
    if (hit) ctx.damagePlayer(suspect.id, SHOT_DAMAGE, actor);
  },
});

// --- The self-check -----------------------------------------------------------------

/**
 * Everything about this feature that fails by rendering a plausible city.
 *
 * None of it throws and none of it has a frame that says so, which is this
 * project's whole criterion:
 *
 *   - A **station whose coordinates are outside the built extent** puts a beat
 *     over the harbour, where there are no footpath bands, so that station
 *     silently contributes nothing. The symptom is "the police feel thin in the
 *     north", which reads as tuning.
 *   - A **reason code with no string** draws `Under Investigation! undefined`,
 *     which is the one failure here that a player *can* see -- and the reserved
 *     `WILDLIFE` code is precisely the one nothing in this build exercises, so
 *     it is the one that would ship broken.
 *   - An **LOS ray that answers backwards** is police who see through terraces
 *     and cannot see across a car park. Both read as the witness range being
 *     wrong rather than as the ray being wrong.
 *   - A **miss model off by a factor** is either police who never hit or police
 *     who cannot be outrun, and the specified 55% at 15 m is the anchor.
 *   - **Reserved slots colliding with pedestrians** is an officer and a
 *     bystander standing inside each other, which at a glance is one person.
 *
 * `kitTriangles` is `world/police.PoliceAssets`' count, handed in rather than
 * imported -- `carBodySizes()`'s precedent, and for the identical reason: this
 * module compiles into the Bun server and must not drag the renderer in behind
 * it. Optional, so the server can run this before anything has been built.
 */
export function verifyPolice(kitTriangles?: number, snapshotInterval?: number): string[] {
  const failures: string[] = [];

  // --- A shot has to survive the snapshot rate. See `FIRE_STATE_TICKS`.
  if (snapshotInterval !== undefined && FIRE_STATE_TICKS < snapshotInterval) {
    failures.push(
      `NPC_STATE.FIRE is held for ${FIRE_STATE_TICKS} ticks and a snapshot goes out every ` +
        `${snapshotInterval}. One shot in ${snapshotInterval} would never be sampled, so a client ` +
        'would hear some of the shots fired at it and not others -- with nothing that says which.',
    );
  }
  if (FIRE_STATE_TICKS >= FIRE_INTERVAL_TICKS) {
    failures.push('The fire state outlasts the interval between shots; an officer would never leave it.');
  }

  // --- The stations, against the extent they were extracted inside.
  if (POLICE_STATIONS.length < 10) {
    failures.push(`Only ${POLICE_STATIONS.length} police stations are baked; the extract found 19.`);
  }
  const seenNames = new Set<string>();
  for (const s of POLICE_STATIONS) {
    const d = Math.sqrt(s.x * s.x + s.z * s.z);
    if (d > STATION_EXTENT_M) {
      failures.push(
        `${s.name} is ${d.toFixed(0)} m from the origin, outside the ${STATION_EXTENT_M} m extent. ` +
          'Its beat would be placed on tiles that do not exist and it would contribute no officers at all.',
      );
    }
    if (!(s.weight > 0 && s.weight <= 1)) {
      failures.push(`${s.name} has a beat weight of ${s.weight}; it must be in (0, 1].`);
    }
    if (seenNames.has(s.name)) failures.push(`Two stations are both called "${s.name}".`);
    seenNames.add(s.name);
    if (beatPairs(s) < 1) failures.push(`${s.name} puts no pairs on the footpath.`);
  }
  // The CBD has to be the heaviest, or the whole "police statistics" premise is
  // inverted and Mosman is the busiest command in the state.
  {
    let heaviest = POLICE_STATIONS[0];
    for (const s of POLICE_STATIONS) if (s.weight > heaviest.weight) heaviest = s;
    const d = Math.sqrt(heaviest.x * heaviest.x + heaviest.z * heaviest.z);
    if (d > 2000) {
      failures.push(
        `The heaviest beat is ${heaviest.name}, ${d.toFixed(0)} m from the CBD origin. ` +
          'The weights are stylised on the CBD being busiest; this table says otherwise.',
      );
    }
  }

  // --- Every reason has a string, including the ones nothing here reports.
  for (const [name, code] of Object.entries(REASON)) {
    if (code === REASON.NONE) continue;
    const text = REASON_TEXT[code];
    if (!text) {
      failures.push(
        `REASON.${name} (${code}) has no banner string. The banner would read ` +
          '"Under Investigation! undefined", which is the one failure in this feature a player can see.',
      );
    } else if (text !== text.toLowerCase()) {
      failures.push(`REASON.${name}'s string "${text}" is not lower case; the HUD's voice is.`);
    }
  }
  if (reasonText(200) === '') failures.push('An unknown reason code produced an empty banner rather than a fallback.');

  // --- The reserved slots cannot collide with a pedestrian's.
  if (POLICE_SLOT_BASE < MAX_SLOTS) {
    failures.push(
      `Police walk slots from ${POLICE_SLOT_BASE} and pedestrians reach ${MAX_SLOTS}; ` +
        'an officer and a bystander would be scheduled onto the same identity.',
    );
  }
  if (POLICE_SLOT_BASE + POLICE_SLOT_SPAN > 64) {
    failures.push(
      `Police slots reach ${POLICE_SLOT_BASE + POLICE_SLOT_SPAN}, past the 6 bits pedKey packs a slot into. ` +
        'The key would collide with the next osmId and stand somebody up in another suburb.',
    );
  }

  // --- The lattice. Every one of these fails by rendering a plausible city.
  {
    // A patrol and a beat sharing an identity is four officers inside each
    // other with one rig between them. The two ranges must not meet, and both
    // must stay inside the six bits `pedestrians.pedKey` packs a slot into.
    if (PATROL_SLOT_BASE < POLICE_SLOT_BASE + POLICE_SLOT_SPAN) {
      failures.push(
        `Patrols walk slots from ${PATROL_SLOT_BASE} and station beats reach ` +
          `${POLICE_SLOT_BASE + POLICE_SLOT_SPAN - 1}. A patrol and a beat would be scheduled onto one ` +
          'identity, which is two pairs standing inside each other under one key.',
      );
    }
    if (PATROL_SLOT_BASE + PATROL_SLOT_SPAN > 64) {
      failures.push(
        `Patrol slots reach ${PATROL_SLOT_BASE + PATROL_SLOT_SPAN}, past the 6 bits pedKey packs a slot ` +
          'into. The key would collide with the next osmId and stand somebody up in another suburb.',
      );
    }
    // The relation `forEachPatrolNear` relies on to make a within-cell key
    // collision impossible rather than merely unlikely. See the slot stepping
    // there: it is only collision-free while a cell has no more pairs than there
    // are slots to step through.
    if (PATROL_MAX_PAIRS > PATROL_SLOT_SPAN) {
      failures.push(
        `A cell may hold ${PATROL_MAX_PAIRS} pairs and there are ${PATROL_SLOT_SPAN} patrol slots to step ` +
          'through, so two pairs of one cell would share a slot -- and on the same band that is two pairs ' +
          'in exactly the same place under exactly the same key.',
      );
    }
    // A search tighter than half a cell's diagonal cannot see the cell's own
    // corner, which is a hole in the one structure whose job is not having holes.
    const halfDiagonal = PATROL_CELL * Math.SQRT1_2;
    if (PATROL_REACH < halfDiagonal) {
      failures.push(
        `A cell is ${PATROL_CELL} m across and searches ${PATROL_REACH} m, short of the ` +
          `${halfDiagonal.toFixed(0)} m half-diagonal. Bands in the cell's own corners would be owned by ` +
          'nobody and that ground would carry no patrol.',
      );
    }
    if (PATROL_BASE_PAIRS < 1) {
      failures.push('The lattice puts no pairs in a cell with no station near it, which is the dead corner it exists to remove.');
    }
    if (PATROL_MAX_PAIRS < PATROL_BASE_PAIRS) {
      failures.push('The lattice caps below its own floor; a busy cell would carry fewer patrols than a quiet one.');
    }
    // The gradient, at the three places the brief names it by. Kings Cross is not
    // Mosman -- the user's own words -- and a lattice that flattened that would
    // have answered the complaint by deleting the thing that made the city
    // legible.
    const kx = patrolWeight(1512.7, 452.6);
    const mos = patrolWeight(3165.2, -4055.6);
    const spawn = patrolWeight(-2236.4, 4543.3);
    if (!(kx > mos)) {
      failures.push(`The policing field is ${kx.toFixed(2)} at Kings Cross and ${mos.toFixed(2)} at Mosman. It has to fall.`);
    }
    if (!(mos >= spawn)) {
      failures.push(
        `The policing field is ${mos.toFixed(2)} at Mosman station and ${spawn.toFixed(2)} at the spawn, ` +
          'which is 1.5 km from the nearest command. A station has to count for something.',
      );
    }
    if (patrolWeight(0, 0) < 0.9) {
      failures.push(`The policing field is ${patrolWeight(0, 0).toFixed(2)} at Town Hall; seven overlapping commands should saturate it.`);
    }
    if (patrolWeight(1e6, 1e6) !== 0) failures.push('The policing field does not fall to zero away from every station.');
    // The floor really is a floor: somewhere inside the extent with no station
    // within `PATROL_INFLUENCE` still gets a pair.
    if (patrolPairs(patrolCell(-2236.4), patrolCell(4543.3)) < PATROL_BASE_PAIRS) {
      failures.push('The spawn corner carries no patrol at all, which is the exact complaint this lattice answers.');
    }
    if (patrolPairs(patrolCell(0), patrolCell(0)) <= patrolPairs(patrolCell(-2236.4), patrolCell(4543.3))) {
      failures.push('Town Hall carries no more patrols than the spawn corner; the lattice has flattened the city.');
    }
  }

  // --- The marked cars, on the same gradient.
  {
    if (LIVERY_SHARE_CITY % LIVERY_SHARE_NEAR !== 0) {
      failures.push(
        `The livery shares are 1 in ${LIVERY_SHARE_NEAR} and 1 in ${LIVERY_SHARE_CITY}, which do not divide. ` +
          'The busy share would not be a superset of the floor, so a car could be marked in Erskineville ' +
          'and unmarked on George Street.',
      );
    }
    if (LIVERY_SHARE_CITY < LIVERY_SHARE_NEAR) {
      failures.push('The citywide livery share is denser than the one near a station, which inverts the gradient.');
    }
    // Monotone in the field, and actually discriminating: the same fleet counted
    // in the CBD and at the spawn has to come out heavier in the CBD and non-zero
    // at both. A predicate that answered the same everywhere is the bug this
    // replaced, in the other direction.
    let cbd = 0;
    let out = 0;
    let bad = 0;
    for (let i = 0; i < 20000; i++) {
      const near = policeLiveried(i, i ^ 0x5bd1, 0, 0);
      const far = policeLiveried(i, i ^ 0x5bd1, -2236.4, 4543.3);
      if (near) cbd++;
      if (far) out++;
      // Nested: anything marked out in the suburbs must be marked in town.
      if (far && !near) bad++;
    }
    if (bad > 0) failures.push(`${bad} cars are marked at the spawn and unmarked in the CBD; the shares are not nested.`);
    if (out === 0) failures.push('No car anywhere outside a station catchment wears a livery; the citywide floor is not wired.');
    if (cbd <= out) failures.push(`The CBD carries ${cbd} marked cars per 20,000 and the spawn ${out}. The gradient is flat.`);
  }

  // --- The miss model, at the three ranges it was specified by.
  {
    const at15 = hitChance(15);
    if (Math.abs(at15 - 0.55) > 0.001) {
      failures.push(`The shot model is ${(at15 * 100).toFixed(0)}% at 15 m; it was specified at 55%.`);
    }
    if (hitChance(ENGAGE_RANGE) >= hitChance(5)) {
      failures.push('The hit chance does not fall with range; a shot at 35 m is as good as one at 5.');
    }
    if (hitChance(1000) < 0.12 - 1e-9 || hitChance(-10) > 0.85 + 1e-9) {
      failures.push('The hit chance is not clamped; a long shot has a negative probability.');
    }
    // Six hits to drop a full-health player, which is what makes running a
    // viable answer to being shot at.
    const hits = Math.ceil(MAX_HEALTH / SHOT_DAMAGE);
    if (hits < 4 || hits > 8) {
      failures.push(`It takes ${hits} hits to drop a full-health player; the intended band is 4-8.`);
    }
  }

  // --- The countdown, and the extension.
  if (COUNTDOWN_TICKS !== 45 * 60) failures.push(`The countdown is ${COUNTDOWN_TICKS / 60} s, not the specified 45.`);
  if (EXTEND_TICKS !== 15 * 60) failures.push(`A fresh crime adds ${EXTEND_TICKS / 60} s, not the specified 15.`);
  if (MAX_COUNTDOWN_TICKS <= COUNTDOWN_TICKS) {
    failures.push('The countdown cap is not above one full countdown, so stacking a crime cannot extend anything.');
  }

  // --- The kinds, and the two bytes reserved for the factions that follow.
  if (npcKind(NPC_KIND.POLICE) === undefined) failures.push('The police kind is not registered.');
  for (const [name, byte] of Object.entries(NPC_KIND)) {
    if (byte <= 0 || byte > 255) failures.push(`NPC_KIND.${name} is ${byte}, which is not a byte.`);
  }
  {
    const bytes = Object.values(NPC_KIND);
    if (new Set(bytes).size !== bytes.length) {
      failures.push('Two entries of NPC_KIND share a byte. A client would draw one faction as another.');
    }
  }

  // --- The wire budget, which is what `MAX_ACTORS` actually is.
  if (MAX_ACTORS * 18 > 500) {
    failures.push(`${MAX_ACTORS} actors at 18 B is ${MAX_ACTORS * 18} B a snapshot, over the 500 B cap.`);
  }

  // --- The tuning that has a right answer.
  if (CHASE_SPEED <= 4.5 || CHASE_SPEED >= 10) {
    failures.push(
      `Officers pursue at ${CHASE_SPEED} m/s. It has to sit between a player's walk and their sprint, ` +
        'or the chase is either unloseable or pointless.',
    );
  }
  if (ENGAGE_RANGE > WITNESS_RANGE) {
    failures.push(
      `Officers open fire at ${ENGAGE_RANGE} m and can only witness at ${WITNESS_RANGE} m, so they would ` +
        'shoot at somebody they never saw commit anything.',
    );
  }

  // --- The kit, if the renderer built one.
  if (kitTriangles !== undefined && kitTriangles <= 0) {
    failures.push('The police kit has no triangles in it; officers would be invisible and still shoot.');
  }

  // --- The line of sight, on a synthetic world.
  //
  // A 20 m box wall between two points 40 m apart, which is the geometry the
  // witness query is actually made of. Four assertions and each one is a
  // different way the ray goes wrong: through a wall, blocked by nothing,
  // blocked by a building it passes over, and clear when it should not be.
  failures.push(...verifyLineOfSight());

  return failures;
}

/**
 * The LOS ray, against a hand-built prism. Split out so `checkPolice` can run it
 * on the server without a world file.
 */
function verifyLineOfSight(): string[] {
  const failures: string[] = [];
  // Built without importing `CollisionWorld`'s constructor arguments from a
  // file: a 10 m square building from (-5,-5) to (5,5), 12 m tall, on a pad at
  // 0. The payload is the real v2 format, so this exercises the real decoder.
  const buffer = new ArrayBuffer(4 + 4 + 4 + 2 + 4 * 8);
  const v = new DataView(buffer);
  v.setUint32(0, 1, true);
  v.setFloat32(4, 12, true); // height
  v.setFloat32(8, 0, true); // base
  v.setUint16(12, 4, true);
  const corners = [[-5, -5], [5, -5], [5, 5], [-5, 5]];
  for (let i = 0; i < 4; i++) {
    v.setFloat32(14 + i * 8, corners[i][0], true);
    v.setFloat32(18 + i * 8, corners[i][1], true);
  }

  const world = new CollisionWorld();
  world.addTile('check', buffer, 0, 0);

  // 1. Straight through the middle at head height: blocked.
  if (!world.blocked(-20, 1.6, 0, 20, 1.6, 0)) {
    failures.push('A sight line straight through a 12 m building was reported clear. Police would see through terraces.');
  }
  // 2. Twenty metres to the side: clear.
  if (world.blocked(-20, 1.6, 20, 20, 1.6, 20)) {
    failures.push('A sight line 20 m clear of the only building in the world was reported blocked.');
  }
  // 3. Over the roof: clear. This is the clause that makes the ray 3D, and a
  //    purely planar test fails exactly here.
  if (world.blocked(-20, 30, 0, 20, 30, 0)) {
    failures.push(
      'A sight line 30 m up, passing over a 12 m building, was reported blocked. ' +
        'The ray is testing the footprint in plan and ignoring the height band.',
    );
  }
  // 4. Diagonally down from above the roof into the far side at ground level:
  //    blocked, because it enters the volume on the way through.
  if (!world.blocked(-20, 20, 0, 20, 0.5, 0)) {
    failures.push('A sight line descending through a building was reported clear.');
  }
  // 5. Symmetry. A ray that answers differently in the two directions is a ray
  //    whose crossing parameter is not being clamped, and the symptom is police
  //    who can see you when you cannot see them.
  if (world.blocked(-20, 1.6, 0, 20, 1.6, 0) !== world.blocked(20, 1.6, 0, -20, 1.6, 0)) {
    failures.push('The line of sight is not symmetric; it answers differently in each direction.');
  }
  return failures;
}

