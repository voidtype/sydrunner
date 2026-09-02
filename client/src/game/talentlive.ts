/**
 * The nine talents that had a query and no call site.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS.
 *
 * `game/teams.ts` sells forty-two talents, `game/teamfx.ts` turns each of them
 * into a number, and the workstream that wired them up left nine with a `fx*`
 * helper that **nothing in the game ever called**. A player spent a point, the
 * tooltip said what would happen, and nothing happened. That is worse than the
 * node not existing, because the node not existing is at least honest.
 *
 * The nine are `METHHEAD_ALLY`, `TRADIE_ALLY`, `AGENT_CHEER`, `POLICE_FOCUS`,
 * `KO_OFFICER_HEALS`, `RBT_MINIMAP`, `ENEMY_MINIMAP_M`, `EAT` and `SIZZLE`, and
 * most of them are one `if` in somebody else's `think`. Those went where they
 * belong -- a statement about what the police do is in `game/factions.ts`, a
 * statement about what a tradie does is in `game/characters.ts` -- on the rule
 * those files' own headers set out.
 *
 * What is left is the three things that are nobody else's:
 *
 *   1. **The ally register.** `Meth-adone` turns a meth head into a temporary
 *      ally for ten seconds, and somebody has to remember for how long and on
 *      whose behalf. That is state, it is read by three files, and it does not
 *      belong to the meth heads any more than it belongs to the player.
 *   2. **Where you may eat.** The `R` key's refusal is a question about a
 *      *place* -- a Flat White point within its pickup radius -- and both the
 *      authority and the browser's HUD hint ask it. One function, one sentence.
 *   3. **The two map layers.** `RBT_MINIMAP` and `ENEMY_MINIMAP_M` are marker
 *      sources gated on a talent, and the gate is the interesting part: a
 *      through-wall dot that showed up for somebody who had not bought it is an
 *      exploit rather than a bug.
 *
 * ---------------------------------------------------------------------------
 * THREE-FREE, AND WHY THE SINK IS STRUCTURAL.
 *
 * `server/sim.ts` imports this file, so it may not touch `three` and it may not
 * touch the DOM. That is why `MarkSink` below is declared here as a one-method
 * interface rather than imported from `minimap.ts`: `MarkerSink` is the right
 * type and `minimap.ts` is a file full of `CanvasRenderingContext2D`, and
 * dragging it into the Bun build's type graph for one method signature is the
 * same mistake `factions.verifyPolice` avoids by taking `kitTriangles` as a
 * parameter. TypeScript's method parameters are bivariant, so a real `Minimap`
 * satisfies this without a cast and without knowing this file exists.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM.
 *
 * Nothing here is evaluated on both ends for the same tick -- the ally register
 * is authority-only state whose *result* (`NpcActor.target`) crosses the wire,
 * and the two marker sources are drawn from what a client has already been sent.
 * The arithmetic is `+ - * /` and one squared-distance compare all the same, on
 * `game/footy.ts`'s standing rule, because the cheapest time to obey it is
 * before somebody moves one of these functions into a `think`.
 */

import { NPC_KIND, type NpcActor } from './factions.ts';
import { ABILITY, ABILITY_COST, type Ability } from './abilities.ts';
import { FLAT_WHITE, PICKUP_RADIUS, type PowerupPoint } from './powerups.ts';
import { TEAM, type Team } from './teams.ts';
import { fxEnemyMinimapM, fxMethheadAlly, fxRbtMinimap } from './teamfx.ts';

// --- 1. The ally register ----------------------------------------------------------------

/**
 * How near your swing has to land for a loiterer to join in, metres.
 *
 * The node's number. Eight metres is "the same footpath" rather than "the same
 * street": far enough that a fight spilling out of a doorway pulls in the bloke
 * sitting against the wall, close enough that it is never a surprise. It is
 * measured from the **swing**, not from the player, because that is what the
 * tooltip says -- *"fight for you if you swing near them"* -- and because a
 * radius around the player would recruit somebody standing behind you.
 */
export const ALLY_RECRUIT_M = 8;
const ALLY_RECRUIT_M2 = ALLY_RECRUIT_M * ALLY_RECRUIT_M;

/** How long they stay yours, seconds. The node's ten. */
export const ALLY_SECONDS = 10;

/**
 * Who each allied actor is fighting for, and until when.
 *
 * Keyed by **actor id** rather than by player, because the questions asked of it
 * are actor-shaped: "is this meth head somebody's, and whose" is asked once per
 * knockout and once per expiry sweep, and "which of my allies are still live" is
 * asked by nothing at all. Bounded by `factions.MAX_ACTORS` (24) by
 * construction -- an actor that is not promoted cannot be in here, because
 * `grantAllies` only ever walks the promoted list -- and swept every tick.
 *
 * A module global rather than a member of `FactionField`, on
 * `teamfx.setTeamLookup`'s precedent: the readers are `game/streetlife.ts` (the
 * expiry), `server/sim.ts` (the credit) and this file's own check, and threading
 * a register through `FactionCtx` would put a talent into the faction framework's
 * public contract for the sake of one talent.
 */
const allies = new Map<number, { ownerId: number; untilMs: number }>();

/** Everything back to boot. For the self-checks and for a room reset. */
/** How many actors are currently somebody's. Diagnostics and the check. */
export function trackedAllies(): number {
  return allies.size;
}
/** Drop one. Called when an actor despawns. */

/** Is this a kind `Meth-adone` speaks to? Meth heads and drunks; **not** eshays. */
export function alliableKind(kind: number): boolean {
  return kind === NPC_KIND.METHHEAD || kind === NPC_KIND.DRUNK;
}

/**
 * Does this player's presence go unnoticed by the street?
 *
 * The first half of `Meth-adone`: *"meth heads and drunks never aggro on you"*.
 * Read by `game/streetlife.ts` at the two places a target is chosen -- the meth
 * head's promotion scan and the drunk's snap -- rather than inside their
 * `think`s, because a target that was refused at the moment it was picked never
 * exists, and one refused later is an actor that promoted, walked over and then
 * changed its mind.
 *
 * "Eshays still roll you" needs no code: an eshay is `game/characters.ts`' and
 * has never consulted this.
 */
export function streetIgnores(playerId: number): boolean {
  return fxMethheadAlly(playerId);
}

/**
 * A `Meth-adone` swing landed at `(x, z)`. Recruit whoever was near it.
 *
 * Returns how many joined, which is what the check reads and what a caller
 * would use for a HUD line if anybody wanted one.
 *
 * **Retargeting rather than promoting.** This only ever speaks to actors that
 * are *already* promoted, and that is a deliberate limit rather than an
 * oversight: promoting one would be a claim on the shared 24-actor cap
 * (`factions.MAX_ACTORS`) made on behalf of a talent, and the cap is a wire
 * budget every faction is queuing for. In practice it costs nothing, because a
 * meth head within 8 m of a player is already promoted -- `stepStreetlife`
 * promotes them at `METH_SIGHT` and drunks at `DRUNK_NOTICE`, both of which are
 * further away than this.
 *
 * `victimId` may be -1, which is a swing that landed on scenery: the window
 * still opens and the actor keeps whatever it was doing, which is the right
 * behaviour for "you swung near them" with nobody to swing at.
 */
export function grantAllies(
  actors: Iterable<NpcActor>,
  ownerId: number,
  victimId: number,
  x: number,
  z: number,
  nowMs: number,
): number {
  if (!fxMethheadAlly(ownerId)) return 0;
  let joined = 0;
  for (const a of actors) {
    if (!alliableKind(a.kind)) continue;
    if (a.health <= 0) continue;
    const dx = a.x - x;
    const dz = a.z - z;
    if (dx * dx + dz * dz > ALLY_RECRUIT_M2) continue;
    allies.set(a.id, { ownerId, untilMs: nowMs + ALLY_SECONDS * 1000 });
    // "It attacks whoever the player last hit." A -1 victim leaves the actor
    // alone rather than clearing a target it already had -- see the header note.
    if (victimId >= 0 && victimId !== ownerId) a.target = victimId;
    joined++;
  }
  return joined;
}

/**
 * The player an actor is fighting for right now, or -1.
 *
 * Expired entries answer -1 and are **left in the map**, which the sweep below
 * removes. Reading and deleting in the same call was the first shape and it is
 * wrong for one caller: `server/sim.shoot` asks this question in the middle of
 * resolving a knockout and would delete an entry the expiry sweep is about to
 * act on, so the actor would keep chasing with nobody to credit.
 */
export function allyOwner(actorId: number, nowMs: number): number {
  const rec = allies.get(actorId);
  if (rec === undefined || nowMs >= rec.untilMs) return -1;
  return rec.ownerId;
}

/**
 * Expire the ten-second windows. Once a tick, from `stepStreetlife`.
 *
 * An actor whose window closed goes back to `target = -1`, which the street
 * factions' own `think`s read as "walk home" -- so a meth head who was fighting
 * for you simply loses interest, which is what a meth head who was fighting for
 * you would do. Actors that have stopped existing are dropped by the same pass:
 * the register must not outlive the list it is keyed against, and an id is
 * recycled (`FactionField.takeId` wraps at 65535).
 */
export function sweepAllies(actors: Iterable<NpcActor>, nowMs: number): void {
  if (allies.size === 0) return;
  for (const a of actors) {
    const rec = allies.get(a.id);
    if (rec === undefined) continue;
    if (nowMs < rec.untilMs) continue;
    allies.delete(a.id);
    if (a.target >= 0) a.target = -1;
  }
  // And anything whose actor is gone. Walked only when there is something to
  // walk -- the common case is an empty register and no allocation at all.
  if (allies.size === 0) return;
  live.clear();
  for (const a of actors) live.add(a.id);
  for (const id of allies.keys()) if (!live.has(id)) allies.delete(id);
}
/** Scratch for the sweep above. Allocated once; `PERFORMANCE.md` phase 1. */
const live = new Set<number>();

/**
 * The feed line an ally's knockout produces. Three slots, not the usual one.
 *
 * `factions.feedLine` fills a single `%s` with the victim's name, which is the
 * shape every `NpcKindDef.feedKo` has -- and it cannot express this line,
 * because this line is the only one in the game with *two* people in it: the
 * player who is being credited and the player who went down. So it is a template
 * of its own rather than a fourth argument to that function, which would have
 * changed a signature nine factions implement to serve one talent.
 *
 * The middle slot is the **ally's own kind name** (`NpcKindDef.name`) rather
 * than the literal "meth head" the node's tooltip uses, and the reason is one
 * paragraph up in `stepStreetlife`: a `Meth-adone` player promotes no meth heads
 * of their own, so the ally who actually lands the knockout beside them is very
 * often a drunk. Hard-coding the tooltip's noun would have produced "and a meth
 * head got Davo" over a bloke holding a schooner, which is the interface being
 * confidently wrong about the thing the player is looking at.
 */
export const ALLY_KO_LINE = '%s and a %s got %s';

/** Fill `ALLY_KO_LINE`. `who` is `NpcKindDef.name` -- "meth head" or "drunk". */
export function allyKoLine(playerName: string, who: string, victimName: string): string {
  return ALLY_KO_LINE.replace('%s', playerName).replace('%s', who).replace('%s', victimName);
}

/** The default noun, for a caller with nothing near enough to name. The node's own word. */
export const ALLY_NOUN_DEFAULT = 'meth head';

/**
 * Which noun the line should use, guessed from who is standing at `(x, z)`.
 *
 * **The client's problem, and this is the cheap answer to it.** `EVENT_FLAG.ALLY`
 * says a knockout was an ally's and deliberately does not say *whose kind* --
 * that would be a byte on the wire for one word, which is the trade
 * `EVENT_FLAG`'s own header refuses twice. So the browser looks at the actors it
 * has already been sent, around the body that just went down, and takes the
 * nearest alliable one.
 *
 * A meth head **wins ties and near-ties by construction**: they are scanned for
 * first and only beaten by a drunk that is strictly nearer. That is the right
 * bias rather than an arbitrary one -- a meth head is the aggressor of the two
 * and much the more likely to have landed the punch, and the node's tooltip
 * names them.
 *
 * Worst case it names the wrong one of two people standing on the same corner,
 * which is a word in a kill feed. A wrong *word* is a far better failure than a
 * protocol field, and it is why this is a guess with a name that says so.
 */
export function allyNounNear(
  actors: Iterable<PlacedActor>,
  x: number,
  z: number,
  nameOf: (kind: number) => string,
): string {
  let bestKind = -1;
  let best2 = ALLY_RECRUIT_M2;
  for (const a of actors) {
    if (!alliableKind(a.kind)) continue;
    const dx = a.x - x;
    const dz = a.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 > best2) continue;
    if (d2 === best2 && bestKind === NPC_KIND.METHHEAD) continue;
    best2 = d2;
    bestKind = a.kind;
  }
  if (bestKind < 0) return ALLY_NOUN_DEFAULT;
  return nameOf(bestKind) || ALLY_NOUN_DEFAULT;
}

// --- 2. Where you may eat ---------------------------------------------------------------

/**
 * The star count above which a servo pie is refused. The node: "Not while
 * wanted 4★+".
 *
 * Only the pie. A sausage sizzle has no such clause and gets none here, which
 * is the whole point of `Sausage Sizzle` being a tier-1 node and `Servo Pie` a
 * tier-2 one: the cheap one always works and the good one does not work when it
 * would matter most.
 */
export const EAT_STAR_LIMIT = 4;

/** No cafe here. */
export const REFUSE_NOWHERE = 'not at a flat white';
/** Four stars and up, pie only. */
export const REFUSE_WANTED = 'not while they are looking for you';

/**
 * The squared plan distance to the nearest Flat White point, or `Infinity`.
 *
 * Squared, and the caller compares against a squared radius, on the determinism
 * rule's second clause: `Math.hypot` is on the list of functions two runtimes
 * are not required to agree about, and this is compared against a constant on
 * the authority while the browser compares the same thing for its HUD hint.
 *
 * **Every** Flat White point counts, including one whose coffee has been picked
 * up and is respawning. A cafe is a place; the powerup on the counter is stock.
 * Refusing to sell a pie because somebody took the last coffee ninety seconds
 * ago would be a rule with no picture attached to it.
 */
export function nearestFlatWhite2(points: readonly PowerupPoint[], x: number, z: number): number {
  let best = Infinity;
  for (const p of points) {
    if (p.kind !== FLAT_WHITE) continue;
    const dx = p.x - x;
    const dz = p.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) best = d2;
  }
  return best;
}

/**
 * Why `R` does nothing here, or `''` if it works.
 *
 * The order is the order a player would want to be told about, which is not the
 * order the checks are cheapest in: **place first**, because standing in the
 * wrong spot is the overwhelmingly common refusal and "not at a flat white" is
 * the only one of these sentences that tells you what to do next. The wallet and
 * the cooldown are deliberately **not** here -- they are `abilities.tryAbility`'s
 * and are the same two gates every other ability goes through, and a second
 * implementation of "have you got $6" is a second answer.
 *
 * `nearest2` is `nearestFlatWhite2`'s squared metres, so the radius is squared
 * here rather than rooted there.
 */
export function foodPlaceRefusal(which: Ability, stars: number, nearest2: number): string {
  if (which !== ABILITY.EAT && which !== ABILITY.SIZZLE) return '';
  if (!(nearest2 <= PICKUP_RADIUS * PICKUP_RADIUS)) return REFUSE_NOWHERE;
  if (which === ABILITY.EAT && stars >= EAT_STAR_LIMIT) return REFUSE_WANTED;
  return '';
}

/** What this serving costs, in dollars. `abilities.ABILITY_COST`, for the HUD. */
export function foodCost(which: Ability): number {
  return ABILITY_COST[which] ?? 0;
}

// --- 3. The two map layers ---------------------------------------------------------------

/**
 * Somewhere a marker can be put, structurally. See the header for why this is
 * declared rather than imported. `minimap.MarkerSink` satisfies it.
 */
export interface MarkSink {
  mark(x: number, z: number, kind: 'rbt' | 'enemy-marita' | 'enemy-default'): void;
}

/** Anything with a position and a kind byte. `factions.NpcActor`, narrowed. */
export interface PlacedActor {
  kind: number;
  x: number;
  z: number;
}

/**
 * The RBTs, for a player with `Toll Dodger`. Returns how many were marked.
 *
 * **Read off the promoted-actor list rather than off the heat field**, and that
 * is a deviation from the brief worth stating. `HeatField` is where the RBTs are
 * *placed*, but it only exists on the authority: a connected browser has a star
 * count off `MSG.HEAT` and no ladder at all, so a marker source hanging off the
 * heat field would have drawn nothing for every online player and worked
 * perfectly offline -- which is the exact shape of bug this repo's checks exist
 * to catch. The promoted actors are the one list that exists on both ends
 * (`net.actors` online, `FactionField.actors` offline), they carry
 * `NPC_KIND.RBT`, and they are already on the wire because the roadblock has to
 * be drawn anyway. The other half of the node -- 300 m ahead instead of 150 --
 * is `heat.placeRbt`'s and was already wired.
 *
 * The `show` gate is the caller's answer from `rbtMarkersOn`, passed in rather
 * than read here so a caller with several players (there is only one: the
 * browser draws its own map) cannot accidentally leak somebody else's layer.
 */
export function markRbts(sink: MarkSink, actors: Iterable<PlacedActor>, show: boolean): number {
  if (!show) return 0;
  let n = 0;
  for (const a of actors) {
    if (a.kind !== NPC_KIND.RBT) continue;
    sink.mark(a.x, a.z, 'rbt');
    n++;
  }
  return n;
}

/** Should this player see the RBT layer at all? `Toll Dodger`'s flag. */
export function rbtMarkersOn(playerId: number): boolean {
  return fxRbtMinimap(playerId);
}

/**
 * Which hollow dot the other side is drawn as, or `''` for "do not draw".
 *
 * Two kinds rather than one, for `minimap.MarkerKind`'s own reason -- the union
 * is closed so a typo is a compile error and `markerInk` is one switch -- and
 * because the *colour* is the whole read: a DeFAULT seeing teal through a wall
 * and a Marita seeing yellow are the same feature and the opposite pixels.
 *
 * `TEAM.NONE` on either party is `''`. An unaligned player is not "the enemy"
 * of anybody, and a holder with no side means the framework has not landed --
 * in which case drawing the whole room through walls would be the worst
 * available failure.
 */
export function enemyMarkerKind(mine: Team, theirs: Team): '' | 'enemy-marita' | 'enemy-default' {
  if (mine === TEAM.NONE || theirs === TEAM.NONE || mine === theirs) return '';
  return theirs === TEAM.MARITA ? 'enemy-marita' : 'enemy-default';
}

/** How far this player sees the other side through walls, metres, or 0. */
export function enemyMarkerRangeM(playerId: number): number {
  return fxEnemyMinimapM(playerId);
}

// --- Self-check -------------------------------------------------------------------------

/**
 * Wired into both boot lists beside `verifyTeamFx` and `verifyAbilities`.
 *
 * It is a third entry in that expression rather than folded into `verifyTeamFx`
 * for one reason: this file imports `teamfx.ts`, so `teamfx.ts` cannot import
 * it back without a cycle, and a cycle between the two halves of the talent
 * system is a worse trade than one more term in an `if` the lead is merging
 * anyway. The failures are prefixed so a boot failure still names the file.
 *
 * `fakeTeamLookup` is not used here: every function above either takes its
 * talent answer as a parameter (`markRbts`'s `show`, `foodPlaceRefusal`'s
 * `stars`) or is a one-line pass-through to a `teamfx` helper that
 * `verifyTeamFx` already covers. What is left to check is the arithmetic and the
 * bookkeeping, which is what fails silently.
 */
export function verifyTalentLive(): string[] {
  const bad: string[] = [];
  const saved = new Map(allies);
  try {
    allies.clear();

    // --- The register: an actor is somebody's for ten seconds and then is not.
    const actor = (id: number, kind: number, x: number, z: number): NpcActor => ({
      id, kind, x, y: 0, z, dx: 0, dz: 1,
      state: 0, health: 1, downTicks: 0, stateTicks: 0,
      target: -1, homeX: x, homeZ: z,
      fireCooldown: 0, shotsFired: 0, barkedAt: 0, struckAt: 0, seen: 0,
    });
    // No lookup installed, so `fxMethheadAlly` is false and nobody is recruited.
    // That is the property every other self-check in this repo depends on.
    const crowd = [actor(1, NPC_KIND.METHHEAD, 0, 3), actor(2, NPC_KIND.DRUNK, 0, 20), actor(3, NPC_KIND.ESHAY, 0, 1)];
    if (grantAllies(crowd, 7, 8, 0, 0, 1_000) !== 0) {
      bad.push('verifyTalentLive: a player with no talents recruited an ally.');
    }

    // The register itself, driven directly -- the recruitment gate is
    // `fxMethheadAlly` and belongs to `verifyTeamFx`; what belongs here is what
    // the map does once something is in it.
    allies.set(1, { ownerId: 7, untilMs: 11_000 });
    if (allyOwner(1, 5_000) !== 7) bad.push('verifyTalentLive: an ally inside its window had no owner.');
    if (allyOwner(1, 11_001) !== -1) bad.push('verifyTalentLive: an ally outlived its ten seconds.');
    if (allyOwner(99, 5_000) !== -1) bad.push('verifyTalentLive: an actor nobody recruited had an owner.');
    crowd[0].target = 8;
    sweepAllies(crowd, 5_000);
    if (trackedAllies() !== 1) bad.push('verifyTalentLive: the sweep dropped a live ally.');
    if (crowd[0].target !== 8) bad.push('verifyTalentLive: the sweep cleared a live ally\'s target.');
    sweepAllies(crowd, 11_001);
    if (trackedAllies() !== 0) bad.push('verifyTalentLive: an expired ally stayed in the register.');
    if (crowd[0].target !== -1) bad.push('verifyTalentLive: an expired ally kept chasing.');
    // An actor that stopped existing takes its entry with it, or the register
    // grows for the life of the process and a recycled id inherits an owner.
    allies.set(4242, { ownerId: 7, untilMs: 1e12 });
    sweepAllies(crowd, 12_000);
    if (trackedAllies() !== 0) bad.push('verifyTalentLive: the register kept an actor that had despawned.');

    // The eshay is exempt, which is the node's own sentence.
    if (alliableKind(NPC_KIND.ESHAY)) bad.push('verifyTalentLive: an eshay counted as an ally; the node says they still roll you.');
    if (!alliableKind(NPC_KIND.METHHEAD) || !alliableKind(NPC_KIND.DRUNK)) {
      bad.push('verifyTalentLive: a meth head or a drunk is not an alliable kind.');
    }

    // The feed line fills both slots, in the order the sentence reads.
    const line = allyKoLine('Bazza', 'meth head', 'Davo');
    if (line !== 'Bazza and a meth head got Davo') bad.push(`verifyTalentLive: the assist line reads "${line}".`);
    if (allyKoLine('Bazza', 'drunk', 'Davo') !== 'Bazza and a drunk got Davo') {
      bad.push('verifyTalentLive: the assist line does not take the ally\'s own kind name.');
    }
    // And the noun the browser guesses, over a corner with both kinds on it.
    const noun = (k: number): string => (k === NPC_KIND.METHHEAD ? 'meth head' : k === NPC_KIND.DRUNK ? 'drunk' : '');
    const corner: PlacedActor[] = [
      { kind: NPC_KIND.DRUNK, x: 2, z: 0 },
      { kind: NPC_KIND.METHHEAD, x: 1, z: 0 },
      { kind: NPC_KIND.POLICE, x: 0.1, z: 0 },
    ];
    if (allyNounNear(corner, 0, 0, noun) !== 'meth head') {
      bad.push('verifyTalentLive: the nearer of two allies was not named, or an officer was.');
    }
    if (allyNounNear([corner[0]], 0, 0, noun) !== 'drunk') bad.push('verifyTalentLive: a lone drunk was not named.');
    if (allyNounNear([], 0, 0, noun) !== ALLY_NOUN_DEFAULT) {
      bad.push('verifyTalentLive: an empty street did not fall back to the node\'s own noun.');
    }
    if (allyNounNear([{ kind: NPC_KIND.DRUNK, x: ALLY_RECRUIT_M + 1, z: 0 }], 0, 0, noun) !== ALLY_NOUN_DEFAULT) {
      bad.push('verifyTalentLive: an ally outside the recruit radius was named.');
    }

    // --- Where you may eat. The radius is the powerup's own, so a player who can
    // pick the coffee up can buy the pie and a player who cannot, cannot.
    const inside = (PICKUP_RADIUS - 0.1) * (PICKUP_RADIUS - 0.1);
    const outside = (PICKUP_RADIUS + 0.1) * (PICKUP_RADIUS + 0.1);
    if (foodPlaceRefusal(ABILITY.EAT, 0, inside) !== '') bad.push('verifyTalentLive: a pie at a cafe was refused.');
    if (foodPlaceRefusal(ABILITY.EAT, 0, outside) !== REFUSE_NOWHERE) {
      bad.push('verifyTalentLive: a pie was sold outside the pickup radius.');
    }
    if (foodPlaceRefusal(ABILITY.SIZZLE, 0, 400) !== REFUSE_NOWHERE) {
      bad.push('verifyTalentLive: a sausage was sold twenty metres from any point.');
    }
    if (foodPlaceRefusal(ABILITY.EAT, EAT_STAR_LIMIT, inside) !== REFUSE_WANTED) {
      bad.push(`verifyTalentLive: a pie was sold at ${EAT_STAR_LIMIT} stars.`);
    }
    if (foodPlaceRefusal(ABILITY.EAT, EAT_STAR_LIMIT - 1, inside) !== '') {
      bad.push(`verifyTalentLive: a pie was refused at ${EAT_STAR_LIMIT - 1} stars; the gate is ${EAT_STAR_LIMIT}.`);
    }
    if (foodPlaceRefusal(ABILITY.SIZZLE, 5, inside) !== '') {
      bad.push('verifyTalentLive: a sausage was refused at 5 stars; only the pie has that clause.');
    }
    if (foodPlaceRefusal(ABILITY.NONE, 0, inside) !== '') {
      bad.push('verifyTalentLive: a place refusal was invented for an ability that is not food.');
    }
    if (foodCost(ABILITY.EAT) !== 6) bad.push(`verifyTalentLive: a servo pie is $${foodCost(ABILITY.EAT)}, not $6.`);
    if (foodCost(ABILITY.SIZZLE) !== 3) bad.push(`verifyTalentLive: a sausage is $${foodCost(ABILITY.SIZZLE)}, not $3.`);

    // --- The nearest point, over a table with both kinds in it.
    const points: PowerupPoint[] = [
      { id: 'a', kind: 0, x: 1, y: 0, z: 0, active: true, respawnT: 0 },
      { id: 'b', kind: FLAT_WHITE, x: 10, y: 0, z: 0, active: true, respawnT: 0 },
      { id: 'c', kind: FLAT_WHITE, x: 0, y: 0, z: 3, active: false, respawnT: 30 },
    ];
    if (nearestFlatWhite2(points, 0, 0) !== 9) {
      bad.push(`verifyTalentLive: the nearest Flat White is ${nearestFlatWhite2(points, 0, 0)} m^2 away, not 9.`);
    }
    if (nearestFlatWhite2([points[0]], 0, 0) !== Infinity) {
      bad.push('verifyTalentLive: a table with no Flat White in it found one.');
    }

    // --- The two map layers.
    const rbts: PlacedActor[] = [
      { kind: NPC_KIND.RBT, x: 5, z: 5 },
      { kind: NPC_KIND.POLICE, x: 6, z: 6 },
      { kind: NPC_KIND.RBT, x: 7, z: 7 },
    ];
    let marked = 0;
    const sink: MarkSink = { mark: () => { marked++; } };
    if (markRbts(sink, rbts, false) !== 0 || marked !== 0) {
      bad.push('verifyTalentLive: RBTs were drawn for a player without Toll Dodger.');
    }
    if (markRbts(sink, rbts, true) !== 2 || marked !== 2) {
      bad.push(`verifyTalentLive: ${marked} RBT markers off two roadblocks and an officer.`);
    }
    if (enemyMarkerKind(TEAM.MARITA, TEAM.DEFAULT) !== 'enemy-default') {
      bad.push('verifyTalentLive: a Marita does not see DeFAULT in the DeFAULT colour.');
    }
    if (enemyMarkerKind(TEAM.DEFAULT, TEAM.MARITA) !== 'enemy-marita') {
      bad.push('verifyTalentLive: a DeFAULT does not see Marita in the Marita colour.');
    }
    if (enemyMarkerKind(TEAM.MARITA, TEAM.MARITA) !== '') bad.push('verifyTalentLive: a teammate was drawn as an enemy.');
    if (enemyMarkerKind(TEAM.NONE, TEAM.MARITA) !== '' || enemyMarkerKind(TEAM.MARITA, TEAM.NONE) !== '') {
      bad.push('verifyTalentLive: a guest was on one side of the through-wall layer.');
    }
    // No lookup installed means no layer, which is what an offline browser and
    // every other self-check in this repo must see.
    if (enemyMarkerRangeM(1) !== 0) bad.push('verifyTalentLive: the enemy layer had a range with no talents installed.');
    if (rbtMarkersOn(1)) bad.push('verifyTalentLive: the RBT layer was on with no talents installed.');
  } finally {
    allies.clear();
    for (const [k, v] of saved) allies.set(k, v);
  }
  return bad;
}
