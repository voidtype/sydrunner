/**
 * Teams and talents: Marita, DeFAULT, and the trees you spend a level on.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT. This file is data plus a small pure query surface. It is
 * three-free and imported by both ends; the framework (wire, persistence, the
 * level-2 interstitial), the gameplay hooks and the renderer are three separate
 * workstreams that all read from here and never redefine any of it.
 *
 * Two names, spelt exactly **Marita** and **DeFAULT** in every string a player
 * can read -- HUD, nameplates, feed lines, the join panel, the phone. The
 * owner: "Make sure you always follow the capitalisation Marita and DeFAULT --
 * in absolutely any case." `verifyTeams` greps every user-facing string in this
 * file for the wrong casings and fails the boot on one; the renderer and HUD
 * are asked to draw `TEAM_NAME[team]` rather than a literal so there is one
 * place the spelling lives.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE, and why.
 *
 * - **A team is a per-account choice made at level 2, and it goes with the
 *   week.** Level, talent points and the side all reset on Monday
 *   (`net/accounts.resetIfNewWeek`), so the interstitial comes back every week
 *   and the rivalry is re-rolled -- the owner's call on 2026-08-19. Guests have
 *   no team, because guests cannot reach level 2 (`net/accounts.ts`).
 * - **One talent point per level, levels 1..10**, granted retroactively when the
 *   team is chosen (so a fresh level 2 has 2 to spend). Ten is the cap because
 *   ten is where the ladder's numbers stop meaning anything at "10 kills a
 *   level" inside a week.
 * - **Three trees per team, mirrored in structure**: 3 tiers x 2 nodes + 1
 *   mega. **One node opens the tier above it** -- tier 2 needs 1 in the tree,
 *   tier 3 needs 2 -- so a tree has eight paths through it and two players in
 *   the same tree can have met different halves. The mega is the exception and
 *   is meant to be: 5 of the 6 *and* level 8, so it still costs most of a tree.
 *   Every team has one tier-1 node (Big Night) everybody takes, which is the
 *   WoW-style tax that makes the rest of the choice real: Big Night plus a
 *   mega's five plus the mega is 7 of 10, leaving three to spend elsewhere --
 *   or three separate paths and no mega at all. See `TIER_REQ`, which carries
 *   the reversal and the reason for it.
 * - **No speed buffs.** The owner dislikes them. Where a mock had "+% sprint"
 *   the node became something else; two *dashes* survive as abilities (a burst,
 *   not a stat), and are flagged so they can be removed in one place.
 * - **Effects are data.** Every node carries a small `effects` list of typed
 *   keys with a number, and the gameplay hooks read `talentScalar(player, key)`
 *   / `hasTalentFlag(player, key)`. Adding a hook is reading a key; nobody
 *   pattern-matches on talent names outside this file.
 *
 * ---------------------------------------------------------------------------
 * WIRE. `TEAM` is a u8 on the roster entry (0 none, 1 Marita, 2 DeFAULT); the
 * spent-talent set is a u64 bitmask (42 nodes, one bit each) on a `TALENTS`
 * message the framework workstream defines. Both are per-account, persisted
 * beside kills in `server/accounts.ts`.
 */

// --- Teams --------------------------------------------------------------------------

export const TEAM = { NONE: 0, MARITA: 1, DEFAULT: 2 } as const;
export type Team = (typeof TEAM)[keyof typeof TEAM];

/** The only place the two names are spelt. Draw these; never a literal. */
export const TEAM_NAME: Readonly<Record<Team, string>> = {
  [TEAM.NONE]: '',
  [TEAM.MARITA]: 'Marita',
  [TEAM.DEFAULT]: 'DeFAULT',
};

/** The two colours, and the ink that reads on each. Marita is teal with white text; DeFAULT is yellow with black text. */
export const TEAM_COLOUR: Readonly<Record<Team, { hex: number; css: string; ink: string }>> = {
  [TEAM.NONE]: { hex: 0x888888, css: '#888888', ink: '#ffffff' },
  [TEAM.MARITA]: { hex: 0x018d96, css: '#018D96', ink: '#ffffff' },
  [TEAM.DEFAULT]: { hex: 0xfeca12, css: '#FECA12', ink: '#111111' },
};

/** The level at which the choice is forced. It is asked again after every weekly reset. */
export const TEAM_CHOICE_LEVEL = 2;
/** One point per level, up to this many. */
export const TALENT_MAX_POINTS = 10;
/**
 * Points-in-tree needed to open each tier: t1, t2, t3, mega.
 *
 * **A TIER OPENS ON ONE NODE, NOT ON THE WHOLE ROW, AND THAT IS THE DIFFERENCE
 * BETWEEN A TREE AND A LADDER.**
 *
 * It was `[0, 2, 4, 6]`, and a tier holds exactly two nodes -- so tier 2 needed
 * *both* of tier 1, and the mega needed all six. Every gate demanded the
 * complete row beneath it, which means there was never a fork: the only build
 * was "take everything in order". The owner called it after playing to level 2
 * -- "i dont have any choice but to skill out entire tiers, its more like
 * straight up levels" -- and he was describing the arithmetic exactly.
 *
 * One per tier opens the next, so a tree now has **eight distinct paths**
 * through it (2 x 2 x 2) instead of one, and two players in the same tree can
 * have met different halves of it. The mega is left as a capstone rather than a
 * fork: five of the six, so it still costs most of a tree -- Big Night plus five
 * plus the mega is 7 of 10 points -- and it is still the thing you give a week
 * up for.
 */
export const TIER_REQ = [0, 1, 2, 5] as const;
/** The mega also needs this level. */
export const MEGA_LEVEL = 8;

// --- Talent effects: the keys the hooks read ----------------------------------------

/**
 * Every effect a node can carry. Scalars add across taken nodes (and auras from
 * teammates where the node says so); flags are booleans. Units in the comment.
 * Hooks read these; nothing else in the codebase names a talent.
 */
export const FX = {
  // health / damage
  MAX_PIPS: 'maxPips', // +N max health pips
  SWING_DAMAGE: 'swingDamage', // +fraction
  SWING_WINDOW_MS: 'swingWindowMs', // +ms on the ACTIVE window
  FISTS_KNOCKDOWN: 'fistsKnockdown', // flag: punches knock down
  DAMAGE_TAKEN: 'damageTaken', // -fraction (armour)
  FIRST_KNOCKDOWN_IMMUNE_S: 'firstKnockdownImmuneS', // seconds: the first knockdown each N s only staggers
  SWING_UNINTERRUPTIBLE: 'swingUninterruptible', // flag
  RESPAWN_PIPS: 'respawnPips', // respawn with N pips instead of 1
  RESPAWN_IN_PLACE_CD_S: 'respawnInPlaceCdS', // seconds: respawn where you fell, once per N s
  REGEN_PIP_S: 'regenPipS', // seconds per pip regenerated out of combat (aura-capable)
  // footy
  THROW_SPEED: 'throwSpeed', // +fraction
  THROW_RANGE: 'throwRange', // +fraction, flatter arc
  BALL_RECHARGE_S: 'ballRechargeS', // absolute seconds (min wins)
  RETURN_SERVE_DOUBLE: 'returnServeDouble', // flag: returned-serve KO counts double kills
  FAR_HIT_KNOCKDOWN_M: 'farHitKnockdownM', // a footy hit from > N m knocks down
  // cars
  TAKE_RADIUS_M: 'takeRadiusM', // absolute (max wins)
  TAKEABLE_SPEED: 'takeableSpeed', // absolute m/s (max wins)
  CAR_HEALTH: 'carHealth', // +fraction max
  CRASH_DAMAGE_TAKEN: 'crashDamageTaken', // -fraction
  CRASH_COOLDOWN_S: 'crashCooldownS', // absolute (min wins)
  WRECK_LIMP_MS: 'wreckLimpMs', // a written-off car still moves at N m/s
  TRAFFIC_HOLD_GAP_M: 'trafficHoldGapM', // absolute (max wins): ambient traffic holds this far behind you
  CAR_NEVER_RECYCLES: 'carNeverRecycles', // flag while online
  CAR_TEAM_LOCK: 'carTeamLock', // flag: your left car is not takeable by the other team
  PARK_SNAP_M: 'parkSnapM', // absolute
  PATROL_CANNOT_RAM: 'patrolCannotRam', // flag
  PASSENGERS_SAFE: 'passengersSafe', // flag (aura-capable): passengers take no crash damage
  RAM: 'ram', // flag (mega): crashes knock down enemies within 3 m and are free under 20 m/s
  // heat / police
  HEAT_ON_STEAL_S: 'heatOnStealS', // seconds: a stolen car reports no CAR_THEFT for N s
  PATROL_RANGE_M: 'patrolRangeM', // absolute (min wins) against you
  BOARD_SHEDS_STAR: 'boardShedsStar', // flag: boarding a train sheds one star instantly
  POLAIR_LOCK_SLOW: 'polairLockSlow', // multiplier on lock acquire time (max wins)
  POLICE_MISS: 'policeMiss', // fraction: police shots miss this much more often
  STAR_DAMAGE: 'starDamage', // +fraction damage per heat star
  RBT_STAND_S: 'rbtStandS', // absolute seconds to be arrested (max wins)
  RBT_IMMUNE: 'rbtImmune', // flag: drive through for 1 pip, never arrested
  RBT_MINIMAP: 'rbtMinimap', // flag: RBTs 300 m ahead + on the minimap
  HEAT_TREAT_LOWER: 'heatTreatLower', // stars: patrol treats you as N lower
  KAREN_IMMUNE: 'karenImmune', // flag: Karens never report you; they report who hits you
  KAREN_UNWITNESSED_STEAL: 'karenUnwitnessedSteal', // flag: Karens don't report steals unless they see your face (<8 m)
  METHHEAD_ALLY: 'methheadAlly', // flag
  TRADIE_ALLY: 'tradieAlly', // flag: tradies never deck you
  AGENT_CHEER: 'agentCheer', // flag: +1 pip when an agent is within 10 m of your KO
  POLICE_FOCUS: 'policeFocus', // flag (mega): officers within 40 m only target you
  KO_OFFICER_HEALS: 'koOfficerHeals', // flag: KO on an officer → full health
  // cash
  CENTRELINK_AMOUNT: 'centrelinkAmount', // absolute $ (max wins)
  CENTRELINK_DAYS: 'centrelinkDays', // absolute in-game days (min wins)
  DROP_BONUS: 'dropBonus', // +fraction on NPC drops
  DEATH_DROP: 'deathDrop', // absolute fraction dropped on death (min wins; 0 = nothing)
  FARE_NIGHT: 'fareNight', // +fraction on fares sunset→sunrise
  FARE_DAY: 'fareDay', // +fraction on fares sunrise→15:00
  FARE_RADIUS_M: 'fareRadiusM', // absolute (max wins)
  FARE_TIP: 'fareTip', // $ tip when fast
  FARE_UTE_LIFE_S: 'fareUteLifeS', // seconds of Ute Life after a fare
  DROP_TRAP: 'dropTrap', // flag: enemies who pick up your drop lose $20 to you and 1 pip
  TEAM_EARN: 'teamEarn', // +fraction earned by teammates near you (aura), stack cap 3
  TEAM_TITHE: 'teamTithe', // fraction of teammates' earnings paid to you (aura)
  CENTRELINK_NEARBY: 'centrelinkNearby', // $ paid to you when a teammate claims within 200 m
  CASH_IS_STATS: 'cashIsStats', // flag (mega): every $50 = +1% damage, +1% armour, cap 20
  // abilities (keys)
  DASH: 'dash', // metres, V: a burst dash (mobility ability, not a stat) — REMOVABLE if the owner dislikes it
  DASH_CD_S: 'dashCdS', // absolute (min wins)
  BOARD_MOVING: 'boardMoving', // flag: E boards a moving train door within 4 m
  EAT: 'eat', // flag: R at a Flat White point: heal 2 pips over 4 s + a temp pip for 30 s; $6
  SIZZLE: 'sizzle', // flag: R at a Flat White point: heal 1 now + 1 over 6 s; bystanders heal; $3
  BERSERK: 'berserk', // flag: G: 5 s knockdown-immune, +30% swing dmg, then 3 s -1 pip; 45 s cd
  BRACE: 'brace', // flag: G: 6 s knockdown/stagger immune, +25% swing dmg, then -1 pip; 45 s cd
  CAR_BURST: 'carBurst', // flag: V in a car: 0.8 s full grip + crash-immune; on foot a 5 m slide under swings
  MEGA_TELEPORT: 'megaTeleport', // flag: once per in-game day, T → nearest station forecourt / car park, heat halved
  MEGA_SUMMON_RIDE: 'megaSummonRide', // flag: once per day, $200 → a SydRide anywhere, heat frozen
  MEGA_SIZZLE_TENT: 'megaSizzleTent', // flag: once per day, $200 → 60 s heal tent
  MEGA_SLAM: 'megaSlam', // flag: once per day, hold G 2 s → knock down all enemies within 8 m, -1 pip each; you show on enemy minimaps
  ENEMY_MINIMAP_M: 'enemyMinimapM', // enemies within N m show on your minimap through walls (aura)
  // auras (the node's own effects are granted to teammates within AURA_M when `aura` is set)
  // groups (megas): effects apply only while N teammates are within GROUP_M
  GROUP_PIPS: 'groupPips',
  GROUP_REGEN_X: 'groupRegenX',
  GROUP_NO_KNOCKDOWN: 'groupNoKnockdown',
  GROUP_KNOCKBACK_M: 'groupKnockbackM',
} as const;
export type FxKey = (typeof FX)[keyof typeof FX];

export const AURA_M = 12;
export const GROUP_M = 20;

// --- Nodes ----------------------------------------------------------------------------

export const NODE_KIND = { ABILITY: 'ability', BUFF: 'buff', AURA: 'aura', PASSIVE: 'passive', MEGA: 'mega' } as const;
export type NodeKind = (typeof NODE_KIND)[keyof typeof NODE_KIND];

export interface TalentNode {
  /** Stable id, also the bit index 0..41 in the talent mask. Never renumber. */
  id: number;
  team: Team;
  /** 0..2 within the team, mirrored across teams. */
  tree: number;
  /** 0..2 tiers, 3 = mega. */
  tier: number;
  /** 0..1 within the tier; megas are 0. */
  slot: number;
  name: string;
  kind: NodeKind;
  /** The tooltip. Lower case, deadpan, the game's HUD voice. */
  effect: string;
  flavour: string;
  /** Effect keys and values. Flags carry 1. */
  effects: ReadonlyArray<readonly [FxKey, number]>;
  /** When true, the node's effects are also granted to teammates within `AURA_M`. */
  aura?: boolean;
  /** For megas: effects marked group-only need this many teammates within `GROUP_M`. */
  group?: number;
  /** The tier-1 node everyone takes: horns (Marita) / cactus (DeFAULT). The renderer keys on this. */
  bigNight?: boolean;
}

export interface TalentTree { team: Team; index: number; name: string; desc: string }

export const TREES: readonly TalentTree[] = [
  { team: TEAM.MARITA, index: 0, name: 'Streets', desc: 'mobility and taking things that are not yours. the getaway tree.' },
  { team: TEAM.MARITA, index: 1, name: 'Servo', desc: 'cash, fares, and the things cash buys. the economy tree.' },
  { team: TEAM.MARITA, index: 2, name: 'Bloodhouse', desc: 'the bat, the footy, the fight. the melee and heat tree.' },
  { team: TEAM.DEFAULT, index: 0, name: 'Concourse', desc: 'engines, roads and the north shore commute. the mobility tree.' },
  { team: TEAM.DEFAULT, index: 1, name: 'Bunnings', desc: 'the sausage, the sizzle, and the crowd behind you. the economy tree.' },
  { team: TEAM.DEFAULT, index: 2, name: 'Rort', desc: 'the fight, and getting away with it. the melee and heat tree.' },
];

const M = TEAM.MARITA;
const D = TEAM.DEFAULT;

/**
 * The 42 nodes. Ids are assigned in order and are the bit index on the wire.
 * Speed buffs deliberately absent; two dashes remain as abilities (`FX.DASH`,
 * `FX.CAR_BURST`) and are the first thing to cut if the owner wants them gone.
 */
export const NODES: readonly TalentNode[] = [
  // ---- Marita · Streets
  { id: 0, team: M, tree: 0, tier: 0, slot: 0, name: 'Bolt', kind: 'ability', effect: 'V: a 6 m dash in your move direction, 4 s cooldown. Works mid-air and off a bike. Cancels a knockdown wind-up if timed inside the first 100 ms.', flavour: 'the light on King St just went orange.', effects: [[FX.DASH, 6], [FX.DASH_CD_S, 4]] },
  { id: 1, team: M, tree: 0, tier: 0, slot: 1, name: 'Sticky Fingers', kind: 'passive', effect: 'Take radius 2.2 → 3.2 m and takeable speed 3 → 6 m/s: you can pull people out of a car that is still rolling. Karens only report your steals if they saw your face (within 8 m).', flavour: 'it was unlocked, officer.', effects: [[FX.TAKE_RADIUS_M, 3.2], [FX.TAKEABLE_SPEED, 6], [FX.KAREN_UNWITNESSED_STEAL, 1]] },
  { id: 2, team: M, tree: 0, tier: 1, slot: 0, name: 'Opal Hop', kind: 'ability', effect: 'E on a moving train door within 4 m boards it — you no longer need it stopped. Boarding sheds one heat star instantly. 20 s cooldown.', flavour: 'doors closing, please stand clear.', effects: [[FX.BOARD_MOVING, 1], [FX.BOARD_SHEDS_STAR, 1]] },
  { id: 3, team: M, tree: 0, tier: 1, slot: 1, name: 'Lane Ways', kind: 'passive', effect: 'Traffic cannot knock you down while you are on a footpath or in a laneway, and ambient cars stop honking at you. Carriageways are still carriageways.', flavour: 'you know a way.', effects: [[FX.TRAFFIC_HOLD_GAP_M, 9]] },
  { id: 4, team: M, tree: 0, tier: 2, slot: 0, name: 'Ghost Plates', kind: 'passive', effect: 'A car you steal reports no CAR_THEFT for the first 60 s unless you hit somebody. Highway patrol pursuit range 300 → 200 m against you.', flavour: 'they were on it when i got it.', effects: [[FX.HEAT_ON_STEAL_S, 60], [FX.PATROL_RANGE_M, 200]] },
  { id: 5, team: M, tree: 0, tier: 2, slot: 1, name: 'Rat Run', kind: 'aura', effect: 'Marita within 12 m of you get Bolt\'s cooldown halved and take no crash damage as your passengers. You get it too if any of them has Rat Run.', flavour: 'follow me, i know a shortcut through Newtown.', effects: [[FX.DASH_CD_S, 2], [FX.PASSENGERS_SAFE, 1]], aura: true },
  { id: 6, team: M, tree: 0, tier: 3, slot: 0, name: 'Kings Cross Getaway', kind: 'mega', effect: 'While you are 3★ or higher, every driven car within 30 m of you gets your Ghost Plates and Polair loses lock 2× slower on all of you. Once per in-game day: T teleports you and your car to the nearest station forecourt with all heat halved.', flavour: 'the whole convoy is yours.', effects: [[FX.POLAIR_LOCK_SLOW, 2], [FX.MEGA_TELEPORT, 1]] },
  // ---- Marita · Servo
  { id: 7, team: M, tree: 1, tier: 0, slot: 0, name: 'Big Night', kind: 'buff', effect: 'HORNS. Permanent +1 max health pip, and the first knockdown against you every 30 s does nothing but stagger you 0.3 s. You grow horns everyone can see. Yes, everyone takes this — that is the point: it costs the point that would have been your spare.', flavour: 'went out on a school night. came back different.', effects: [[FX.MAX_PIPS, 1], [FX.FIRST_KNOCKDOWN_IMMUNE_S, 30]], bigNight: true },
  { id: 8, team: M, tree: 1, tier: 0, slot: 1, name: 'Tap On', kind: 'passive', effect: 'Centrelink pays $150 instead of $100 and comes round every 6 in-game days instead of 7. NPC cash drops +25%. Death drops 5% of your cash instead of 10%.', flavour: 'concession, mate.', effects: [[FX.CENTRELINK_AMOUNT, 150], [FX.CENTRELINK_DAYS, 6], [FX.DROP_BONUS, 0.25], [FX.DEATH_DROP, 0.05]] },
  { id: 9, team: M, tree: 1, tier: 1, slot: 0, name: 'Surge', kind: 'buff', effect: 'SydRide fares pay +40% between sunset and sunrise, the pickup radius is 900 → 1400 m, and passengers tip $10 if you got there quickly.', flavour: '1.8x. get in.', effects: [[FX.FARE_NIGHT, 0.4], [FX.FARE_RADIUS_M, 1400], [FX.FARE_TIP, 10]] },
  { id: 10, team: M, tree: 1, tier: 1, slot: 1, name: 'Servo Pie', kind: 'ability', effect: 'Hold R at any Flat White point: a $6 servo pie — heal 2 pips over 4 s and carry one extra pip for 30 s. Not while wanted 4★+.', flavour: 'the good one, not the mince one.', effects: [[FX.EAT, 1]] },
  { id: 11, team: M, tree: 1, tier: 2, slot: 0, name: 'Loan Shark', kind: 'passive', effect: 'Your death-drop bundles are booby-trapped: a non-Marita who picks one up loses $20 to you and takes 1 pip. Marita who pick it up hand it straight back.', flavour: 'you knew the terms.', effects: [[FX.DROP_TRAP, 1]] },
  { id: 12, team: M, tree: 1, tier: 2, slot: 1, name: 'Tip Jar', kind: 'aura', effect: 'Marita within 12 m earn +10% on every fare, drop and Centrelink claim, and you get $2 of every $20 they make. Stacks across Tip Jars, capped at 3.', flavour: 'we\'re a collective now.', effects: [[FX.TEAM_EARN, 0.1], [FX.TEAM_TITHE, 0.1]], aura: true },
  { id: 13, team: M, tree: 1, tier: 3, slot: 0, name: 'Cash Rules', kind: 'mega', effect: 'Your cash is a resource: every $50 in your wallet is +1% swing damage and +1% armour, capped at $1,000 (+20/+20). Being KO\'d drops nothing. Once per in-game day: 4 spends $200 to summon a SydRide that drives you anywhere on the map with heat frozen.', flavour: 'everything else is just tap and go.', effects: [[FX.CASH_IS_STATS, 1], [FX.DEATH_DROP, 0], [FX.MEGA_SUMMON_RIDE, 1]] },
  // ---- Marita · Bloodhouse
  { id: 14, team: M, tree: 2, tier: 0, slot: 0, name: 'Front Bar', kind: 'buff', effect: '+20% swing damage and the swing\'s active window 100 → 130 ms. Punches with fists knock down instead of stagger.', flavour: 'no shoes, no service, no worries.', effects: [[FX.SWING_DAMAGE, 0.2], [FX.SWING_WINDOW_MS, 30], [FX.FISTS_KNOCKDOWN, 1]] },
  { id: 15, team: M, tree: 2, tier: 0, slot: 1, name: 'Long Bomb', kind: 'buff', effect: 'Footy throw speed +25%, recharge 1.6 → 1.1 s, and a returned-serve KO scores double kills toward your level.', flavour: 'from the centre square.', effects: [[FX.THROW_SPEED, 0.25], [FX.BALL_RECHARGE_S, 1.1], [FX.RETURN_SERVE_DOUBLE, 1]] },
  { id: 16, team: M, tree: 2, tier: 1, slot: 0, name: 'Meth-adone', kind: 'passive', effect: 'Meth heads and drunks never aggro on you and fight for you if you swing near them (they count as your assist for kills). Eshays still roll you.', flavour: 'they know you.', effects: [[FX.METHHEAD_ALLY, 1]] },
  { id: 17, team: M, tree: 2, tier: 1, slot: 1, name: 'Off Your Face', kind: 'ability', effect: 'G: 5 s of +30% swing damage and you cannot be knocked down; then 3 s where you lose a pip and cannot swing. 45 s cooldown.', flavour: 'it\'s 3am and you feel great.', effects: [[FX.BERSERK, 1]] },
  { id: 18, team: M, tree: 2, tier: 2, slot: 0, name: 'Sirens Are Music', kind: 'passive', effect: 'Each heat star gives +6% swing damage (5★ = +30%). Highway patrol knockdowns against you stagger instead. RBT arrests take 8 s of standing still instead of 5.', flavour: 'that\'s our song.', effects: [[FX.STAR_DAMAGE, 0.06], [FX.PATROL_CANNOT_RAM, 1], [FX.RBT_STAND_S, 8]] },
  { id: 19, team: M, tree: 2, tier: 2, slot: 1, name: 'Glassing', kind: 'aura', effect: 'Marita within 12 m of you get Front Bar; enemies within 12 m of you get their swing window −20 ms. Two Marita with Glassing standing together is a wall.', flavour: 'the front bar of the Marlborough at kick-out.', effects: [[FX.SWING_DAMAGE, 0.2], [FX.SWING_WINDOW_MS, 30], [FX.FISTS_KNOCKDOWN, 1]], aura: true },
  { id: 20, team: M, tree: 2, tier: 3, slot: 0, name: 'Newtown Standoff', kind: 'mega', effect: 'While 3★+, every police officer within 40 m has to choose you: they stop shooting anyone else. Your KOs on officers reset your health to full. Once per in-game day: hold G for 2 s to knock down every non-Marita within 8 m and take one pip from each; you show on every enemy minimap while it is active.', flavour: 'come on then.', effects: [[FX.POLICE_FOCUS, 1], [FX.KO_OFFICER_HEALS, 1], [FX.MEGA_SLAM, 1]] },
  // ---- DeFAULT · Concourse
  { id: 21, team: D, tree: 0, tier: 0, slot: 0, name: 'Merge Late', kind: 'ability', effect: 'V: in a car, 0.8 s of full grip and no crash damage; on foot, a 5 m slide under swings. 5 s cooldown.', flavour: 'the M2 taught you this.', effects: [[FX.CAR_BURST, 1]] },
  { id: 22, team: D, tree: 0, tier: 0, slot: 1, name: 'Ute Life', kind: 'passive', effect: 'Cars you drive have +25% health, take −30% crash damage, and the crash cooldown is 0.5 → 0.3 s. Written-off cars can still limp at 6 m/s.', flavour: 'she\'ll be right.', effects: [[FX.CAR_HEALTH, 0.25], [FX.CRASH_DAMAGE_TAKEN, 0.3], [FX.CRASH_COOLDOWN_S, 0.3], [FX.WRECK_LIMP_MS, 6]] },
  { id: 23, team: D, tree: 0, tier: 1, slot: 0, name: 'Right of Way', kind: 'passive', effect: 'Ambient traffic holds 9 m behind your car instead of 6 and gets out of your lane where it can; highway patrol cannot ram you.', flavour: 'weekdays 6–10, 3–7. you\'re always in it.', effects: [[FX.TRAFFIC_HOLD_GAP_M, 9], [FX.PATROL_CANNOT_RAM, 1]] },
  { id: 24, team: D, tree: 0, tier: 1, slot: 1, name: 'Park Anywhere', kind: 'passive', effect: 'A car you leave never recycles while you are online, is never takeable by Marita, and snaps into any bay within 6 m.', flavour: 'residents permit, apparently.', effects: [[FX.CAR_NEVER_RECYCLES, 1], [FX.CAR_TEAM_LOCK, 1], [FX.PARK_SNAP_M, 6]] },
  { id: 25, team: D, tree: 0, tier: 2, slot: 0, name: 'Toll Dodger', kind: 'passive', effect: 'RBTs are set 300 m ahead instead of 150 and show on your minimap; Polair takes 2× longer to lock you in a car.', flavour: 'you have never once paid the harbour tunnel.', effects: [[FX.RBT_MINIMAP, 1], [FX.POLAIR_LOCK_SLOW, 2]] },
  { id: 26, team: D, tree: 0, tier: 2, slot: 1, name: 'Convoy', kind: 'aura', effect: 'DeFAULT driving within 12 m of you share Ute Life. Passengers in your car (any team) take no crash damage.', flavour: 'three utes, one lane.', effects: [[FX.CAR_HEALTH, 0.25], [FX.CRASH_DAMAGE_TAKEN, 0.3], [FX.PASSENGERS_SAFE, 1]], aura: true },
  { id: 27, team: D, tree: 0, tier: 3, slot: 0, name: 'Northern Beaches Tunnel', kind: 'mega', effect: 'Your car is a battering ram: crashes at 10 m/s+ knock down every non-DeFAULT within 3 m of the impact and cost you nothing under 20 m/s. Once per in-game day: T teleports your car to the nearest station car park with heat halved.', flavour: 'it was promised in 2007.', effects: [[FX.RAM, 1], [FX.MEGA_TELEPORT, 1]] },
  // ---- DeFAULT · Bunnings
  { id: 28, team: D, tree: 1, tier: 0, slot: 0, name: 'Big Night', kind: 'buff', effect: 'CACTUS. Permanent +1 max health pip, and the first knockdown against you every 30 s does nothing but stagger you 0.3 s. Your body is replaced with cactus parts everyone can see. Yes, everyone takes this — that is the point: it costs the point that would have been your spare.', flavour: 'the sizzle went long. you woke up like this.', effects: [[FX.MAX_PIPS, 1], [FX.FIRST_KNOCKDOWN_IMMUNE_S, 30]], bigNight: true },
  { id: 29, team: D, tree: 1, tier: 0, slot: 1, name: 'Sausage Sizzle', kind: 'ability', effect: 'Hold R at any Flat White point: a $3 sausage — heal 1 pip now and 1 over 6 s. Bystanders within 6 m heal 1 pip too and forget your last crime (witnessed reports drop one tier).', flavour: 'onions on top. don\'t start.', effects: [[FX.SIZZLE, 1]] },
  { id: 30, team: D, tree: 1, tier: 1, slot: 0, name: 'Tradie Rates', kind: 'buff', effect: 'SydRide fares +25% between sunrise and 15:00 game time; every fare completed grants 30 s of Ute Life if you don\'t have it. Tradies never deck you.', flavour: 'cash job, mate.', effects: [[FX.FARE_DAY, 0.25], [FX.FARE_UTE_LIFE_S, 30], [FX.TRADIE_ALLY, 1]] },
  { id: 31, team: D, tree: 1, tier: 1, slot: 1, name: 'Click & Collect', kind: 'passive', effect: 'Centrelink gives $100 every 5 in-game days for you, and any DeFAULT claim within 200 m of you also pays you $20. NPC drops +20%.', flavour: 'order\'s ready.', effects: [[FX.CENTRELINK_DAYS, 5], [FX.CENTRELINK_NEARBY, 20], [FX.DROP_BONUS, 0.2]] },
  { id: 32, team: D, tree: 1, tier: 2, slot: 0, name: 'Warranty', kind: 'passive', effect: 'On KO you drop nothing and respawn with 2 pips instead of 1; once per 5 minutes you respawn where you fell instead of at spawn.', flavour: 'took it back to the counter.', effects: [[FX.DEATH_DROP, 0], [FX.RESPAWN_PIPS, 2], [FX.RESPAWN_IN_PLACE_CD_S, 300]] },
  { id: 33, team: D, tree: 1, tier: 2, slot: 1, name: 'Sizzle Aura', kind: 'aura', effect: 'DeFAULT within 12 m regenerate 1 pip per 20 s while not in combat and earn +10% on drops. Stack cap 2.', flavour: 'the smell carries.', effects: [[FX.REGEN_PIP_S, 20], [FX.DROP_BONUS, 0.1]], aura: true },
  { id: 34, team: D, tree: 1, tier: 3, slot: 0, name: 'Sunday Rush', kind: 'mega', effect: 'While 3+ DeFAULT are within 20 m of you, everyone in the group gets +1 max pip and regenerates 2× faster. Once per in-game day: 4 spends $200 to drop a Bunnings sausage sizzle tent at your feet for 60 s: any DeFAULT who touches it is healed to full and cleared of heat under 3★.', flavour: 'car park\'s full. good.', effects: [[FX.GROUP_PIPS, 1], [FX.GROUP_REGEN_X, 2], [FX.MEGA_SIZZLE_TENT, 1]], group: 3 },
  // ---- DeFAULT · Rort
  { id: 35, team: D, tree: 2, tier: 0, slot: 0, name: 'Bouncer', kind: 'buff', effect: '+20% swing damage; being hit while swinging does not cancel your swing. Fists knock down instead of stagger.', flavour: 'ID.', effects: [[FX.SWING_DAMAGE, 0.2], [FX.SWING_UNINTERRUPTIBLE, 1], [FX.FISTS_KNOCKDOWN, 1]] },
  { id: 36, team: D, tree: 2, tier: 0, slot: 1, name: 'Set Shot', kind: 'buff', effect: 'Footy throws travel 25% further and flatter, recharge 1.6 → 1.1 s; a footy hit from more than 20 m knocks down instead of staggering.', flavour: 'from the pocket.', effects: [[FX.THROW_RANGE, 0.25], [FX.BALL_RECHARGE_S, 1.1], [FX.FAR_HIT_KNOCKDOWN_M, 20]] },
  { id: 37, team: D, tree: 2, tier: 1, slot: 0, name: 'Karen Rapport', kind: 'passive', effect: 'Karens never report you and will report anyone who hits you. Real-estate agents cheer for you (+1 pip when one is within 10 m of your KO).', flavour: 'she has your back. terrifying.', effects: [[FX.KAREN_IMMUNE, 1], [FX.AGENT_CHEER, 1]] },
  { id: 38, team: D, tree: 2, tier: 1, slot: 1, name: 'Sober Up', kind: 'ability', effect: 'G: 6 s of immunity to knockdown and stagger and +25% swing damage; then you drop one pip. 45 s cooldown. Cannot be used at 5★.', flavour: 'you blew 0.00. no one believes it.', effects: [[FX.BRACE, 1]] },
  { id: 39, team: D, tree: 2, tier: 2, slot: 0, name: 'Blue Line', kind: 'passive', effect: 'Police shots against you miss 2× as often and highway patrol treats you as 1★ lower. Each star still gives +5% swing damage. RBTs never arrest you: you drive through for 1 pip.', flavour: 'nothing to see here.', effects: [[FX.POLICE_MISS, 0.5], [FX.HEAT_TREAT_LOWER, 1], [FX.STAR_DAMAGE, 0.05], [FX.RBT_IMMUNE, 1]] },
  { id: 40, team: D, tree: 2, tier: 2, slot: 1, name: 'Neighbourhood Watch', kind: 'aura', effect: 'DeFAULT within 12 m get Bouncer and Blue Line\'s miss chance; enemies within 12 m of you show on your minimap through walls.', flavour: 'we all know each other here.', effects: [[FX.SWING_DAMAGE, 0.2], [FX.SWING_UNINTERRUPTIBLE, 1], [FX.POLICE_MISS, 0.5], [FX.ENEMY_MINIMAP_M, 12]], aura: true },
  { id: 41, team: D, tree: 2, tier: 3, slot: 0, name: 'Cronulla Line', kind: 'mega', effect: 'While 3+ DeFAULT are within 20 m of you, none of you can be knocked down by cars or footys, and your swings knock enemies back 4 m. Once per in-game day: hold G for 2 s to knock down every non-DeFAULT within 8 m and take one pip from each; you show on every enemy minimap while it is active.', flavour: 'we grew here.', effects: [[FX.GROUP_NO_KNOCKDOWN, 1], [FX.GROUP_KNOCKBACK_M, 4], [FX.MEGA_SLAM, 1]], group: 3 },
];

export const NODE_COUNT = 42;

// --- Pure queries -----------------------------------------------------------------------

export function nodeById(id: number): TalentNode | undefined {
  return NODES[id];
}
export function nodesFor(team: Team, tree: number): TalentNode[] {
  return NODES.filter((n) => n.team === team && n.tree === tree);
}
export function bigNightOf(team: Team): TalentNode | undefined {
  return NODES.find((n) => n.team === team && n.bigNight);
}

/** A talent set is a bitmask over node ids; two u32 halves so it survives the wire without BigInt. */
export interface TalentMask { lo: number; hi: number }
export const EMPTY_MASK: Readonly<TalentMask> = Object.freeze({ lo: 0, hi: 0 });
export function hasNode(m: Readonly<TalentMask>, id: number): boolean {
  return id < 32 ? ((m.lo >>> id) & 1) === 1 : ((m.hi >>> (id - 32)) & 1) === 1;
}
export function withNode(m: Readonly<TalentMask>, id: number): TalentMask {
  return id < 32 ? { lo: (m.lo | (1 << id)) >>> 0, hi: m.hi } : { lo: m.lo, hi: (m.hi | (1 << (id - 32))) >>> 0 };
}
export function withoutNode(m: Readonly<TalentMask>, id: number): TalentMask {
  return id < 32 ? { lo: (m.lo & ~(1 << id)) >>> 0, hi: m.hi } : { lo: m.lo, hi: (m.hi & ~(1 << (id - 32))) >>> 0 };
}
export function countBits(m: Readonly<TalentMask>): number {
  let n = 0;
  for (let i = 0; i < NODE_COUNT; i++) if (hasNode(m, i)) n++;
  return n;
}
/**
 * Points spent in a tree **below the mega**. The mega does not count toward its
 * own tier gate -- otherwise taking it would let you refund a tier-1 node
 * underneath and keep the mega standing on five.
 */
export function spentInTree(m: Readonly<TalentMask>, team: Team, tree: number): number {
  let n = 0;
  for (const nd of NODES) if (nd.team === team && nd.tree === tree && nd.tier < 3 && hasNode(m, nd.id)) n++;
  return n;
}
/** Points available at a level: one per level, capped. */
export function pointsFor(level: number): number {
  return Math.max(0, Math.min(TALENT_MAX_POINTS, Math.floor(level)));
}

/** Why a node cannot be taken right now, or '' if it can. The single rule both ends enforce. */
export function takeRefusal(m: Readonly<TalentMask>, team: Team, level: number, id: number): string {
  const nd = NODES[id];
  if (!nd) return 'no such talent';
  if (team === TEAM.NONE) return 'choose a side first';
  if (nd.team !== team) return `that is a ${TEAM_NAME[nd.team]} talent`;
  if (hasNode(m, id)) return 'already taken';
  if (countBits(m) >= pointsFor(level)) return 'no points left';
  const s = spentInTree(m, team, nd.tree);
  const need = TIER_REQ[nd.tier] ?? 0;
  if (s < need) return `needs ${need} in ${TREES.find((t) => t.team === team && t.index === nd.tree)!.name} (you have ${s})`;
  if (nd.tier === 3 && level < MEGA_LEVEL) return `needs level ${MEGA_LEVEL}`;
  return '';
}
/** Refunding `id` must not orphan a higher tier in the same tree. */
export function refundRefusal(m: Readonly<TalentMask>, team: Team, id: number): string {
  const nd = NODES[id];
  if (!nd) return 'no such talent';
  if (!hasNode(m, id)) return 'not taken';
  const after = withoutNode(m, id);
  const s = spentInTree(after, team, nd.tree);
  for (const o of NODES) {
    if (o.team !== team || o.tree !== nd.tree || !hasNode(after, o.id)) continue;
    if (o.tier > nd.tier && s < (TIER_REQ[o.tier] ?? 0)) return `${o.name} depends on it`;
  }
  return '';
}

/**
 * The scalar a player has for an effect key from their own talents (no auras):
 * summed for additive keys, max/min where the key's comment says so.
 */
const MAX_WINS = new Set<string>([FX.TAKE_RADIUS_M, FX.TAKEABLE_SPEED, FX.TRAFFIC_HOLD_GAP_M, FX.RBT_STAND_S, FX.FARE_RADIUS_M, FX.CENTRELINK_AMOUNT, FX.PARK_SNAP_M, FX.POLAIR_LOCK_SLOW]);
const MIN_WINS = new Set<string>([FX.BALL_RECHARGE_S, FX.CRASH_COOLDOWN_S, FX.PATROL_RANGE_M, FX.CENTRELINK_DAYS, FX.DEATH_DROP, FX.DASH_CD_S]);
export function ownScalar(m: Readonly<TalentMask>, key: FxKey): number {
  let acc = 0;
  let seen = false;
  for (const nd of NODES) {
    if (!hasNode(m, nd.id)) continue;
    for (const [k, v] of nd.effects) {
      if (k !== key) continue;
      if (!seen) { acc = v; seen = true; continue; }
      if (MAX_WINS.has(key)) acc = Math.max(acc, v);
      else if (MIN_WINS.has(key)) acc = Math.min(acc, v);
      else acc += v;
    }
  }
  return acc;
}
export function ownFlag(m: Readonly<TalentMask>, key: FxKey): boolean {
  return ownScalar(m, key) > 0;
}

/**
 * The lookup the gameplay hooks use. The framework implements it (auras and
 * groups folded in from teammates within `AURA_M`/`GROUP_M`); `NO_TEAMS` is the
 * no-op every fixture and the offline stub can use.
 */
export interface TeamLookup {
  teamOf(playerId: number): Team;
  scalar(playerId: number, key: FxKey): number;
  flag(playerId: number, key: FxKey): boolean;
}
export const NO_TEAMS: TeamLookup = Object.freeze({
  teamOf: () => TEAM.NONE as Team,
  scalar: () => 0,
  flag: () => false,
});

/**
 * Your build as rows, for the sheet you can read without stopping the game.
 *
 * The owner: *"need a way to view points in talents in normal play so i can see
 * what ive spent an think about later"*. The talents panel is a modal with a
 * cursor -- it is where you *spend*, and it stops you playing. This is the other
 * half: a pure summary the HUD can draw behind a held key, with no DOM, no
 * three and no `document` in sight, so `verifyTeams` can assert every line of
 * it and the server could render the same thing into a log if it ever wanted to.
 *
 * Ordered the way the trees are drawn, so what you read here sits where you
 * remember clicking it. A tree with nothing in it is still listed: the empty
 * ones are the interesting half of "what could I do with the two points I have
 * left", which is the sentence the owner actually asked for.
 */
export interface BuildRow {
  tree: string;
  spent: number;
  /** Taken nodes, tier order: `{ name, kind, tier, effect }`. */
  taken: Array<{ name: string; kind: NodeKind; tier: number; effect: string }>;
  /** What a spare point could buy in this tree right now, by name. */
  next: string[];
}
export interface BuildSummary {
  team: Team;
  teamName: string;
  level: number;
  spent: number;
  unspent: number;
  rows: BuildRow[];
}
export function buildSummary(team: Team, mask: Readonly<TalentMask>, level: number): BuildSummary {
  const spent = countBits(mask);
  const rows: BuildRow[] = [];
  for (const tree of TREES) {
    if (tree.team !== team) continue;
    const taken: BuildRow['taken'] = [];
    const next: string[] = [];
    for (const nd of nodesFor(team, tree.index)) {
      if (hasNode(mask, nd.id)) taken.push({ name: nd.name, kind: nd.kind, tier: nd.tier, effect: nd.effect });
      else if (takeRefusal(mask, team, level, nd.id) === '') next.push(nd.name);
    }
    taken.sort((a, b) => a.tier - b.tier);
    rows.push({ tree: tree.name, spent: spentInTree(mask, team, tree.index), taken, next });
  }
  return {
    team,
    teamName: TEAM_NAME[team],
    level,
    spent,
    unspent: Math.max(0, pointsFor(level) - spent),
    rows,
  };
}

// --- Self-check --------------------------------------------------------------------------

export function verifyTeams(): string[] {
  const bad: string[] = [];
  // Casing: the two names, exactly, everywhere a player reads them.
  const wrong = /\b(marita|MARITA|Default|default|DEFAULT|Defaut|DeFault|Marrita)\b/;
  const texts = [TEAM_NAME[TEAM.MARITA], TEAM_NAME[TEAM.DEFAULT], ...TREES.map((t) => t.name + ' ' + t.desc), ...NODES.flatMap((n) => [n.name, n.effect, n.flavour])];
  for (const t of texts) {
    // 'default' as an ordinary word does not occur in these strings; the regex is a spelling guard, not a grammar one.
    if (wrong.test(t)) bad.push(`A team name is spelt wrongly in a player-facing string: "${t.slice(0, 60)}". Only "Marita" and "DeFAULT".`);
  }
  if (TEAM_NAME[TEAM.MARITA] !== 'Marita' || TEAM_NAME[TEAM.DEFAULT] !== 'DeFAULT') bad.push('TEAM_NAME is not the owner\'s spelling.');
  if (TEAM_COLOUR[TEAM.MARITA].css !== '#018D96' || TEAM_COLOUR[TEAM.DEFAULT].css !== '#FECA12') bad.push('The team colours moved.');
  // Structure: 42 nodes, ids = index, 2 teams x 3 trees x (6 + 1), exactly one Big Night per team, no speed buff keys.
  if (NODES.length !== NODE_COUNT) bad.push(`${NODES.length} nodes, not ${NODE_COUNT}.`);
  NODES.forEach((n, i) => { if (n.id !== i) bad.push(`Node ${n.name} has id ${n.id} at index ${i}; ids are bit indices and must equal their index.`); });
  for (const team of [TEAM.MARITA, TEAM.DEFAULT] as const) {
    if (NODES.filter((n) => n.team === team && n.bigNight).length !== 1) bad.push(`${TEAM_NAME[team]} does not have exactly one Big Night.`);
    for (let tree = 0; tree < 3; tree++) {
      const ns = nodesFor(team, tree);
      if (ns.length !== 7) bad.push(`${TEAM_NAME[team]} tree ${tree} has ${ns.length} nodes, not 7.`);
      if (ns.filter((n) => n.tier === 3).length !== 1) bad.push(`${TEAM_NAME[team]} tree ${tree} does not have exactly one mega.`);
      for (let tier = 0; tier < 3; tier++) if (ns.filter((n) => n.tier === tier).length !== 2) bad.push(`${TEAM_NAME[team]} tree ${tree} tier ${tier} is not two nodes.`);
    }
  }
  const speedKeys = ['sprint', 'speed', 'topSpeed'];
  for (const n of NODES) for (const [k] of n.effects) if (speedKeys.some((s) => k.toLowerCase().includes(s.toLowerCase()) && k !== FX.THROW_SPEED && k !== FX.TAKEABLE_SPEED)) bad.push(`${n.name} carries a speed buff (${k}); the owner dislikes them.`);
  // The rule: with 10 points, Big Night + a mega leaves exactly one spare; two half-trees leave no mega.
  let m: TalentMask = { lo: 0, hi: 0 };
  const bn = bigNightOf(TEAM.MARITA)!;
  if (takeRefusal(m, TEAM.MARITA, 10, bn.id) !== '') bad.push('Big Night is not takeable at tier 1 with points.');
  m = withNode(m, bn.id);
  const streets = nodesFor(TEAM.MARITA, 0);
  const mega = streets.find((n) => n.tier === 3)!;
  if (takeRefusal(m, TEAM.MARITA, 10, mega.id) === '') bad.push('A mega was takeable with 0 in its tree.');
  const nonMega = streets.filter((x) => x.tier < 3);
  /*
   * **The fork, which is the whole of `TIER_REQ`'s reversal.** A tier holds two
   * nodes and one of them opens the next tier, so a player may walk a single
   * side of a tree all the way down. Asserted from a mask carrying exactly one
   * tier-0 node: if this ever needs two again, the tree is a ladder and the
   * owner's complaint is back.
   */
  {
    const one = withNode({ lo: 0, hi: 0 }, nonMega[0].id);
    const tier1 = nonMega.find((n) => n.tier === 1)!;
    if (takeRefusal(one, TEAM.MARITA, 10, tier1.id) !== '') {
      bad.push(`One tier-0 node did not open tier 2: ${takeRefusal(one, TEAM.MARITA, 10, tier1.id)}`);
    }
    const two = withNode(one, tier1.id);
    const tier2 = nonMega.find((n) => n.tier === 2)!;
    if (takeRefusal(two, TEAM.MARITA, 10, tier2.id) !== '') {
      bad.push(`One node a tier did not open tier 3: ${takeRefusal(two, TEAM.MARITA, 10, tier2.id)}`);
    }
    // ...and a path of three is still short of the mega, which is a capstone.
    const three = withNode(two, tier2.id);
    if (takeRefusal(three, TEAM.MARITA, 10, mega.id) === '') {
      bad.push('A three-node path opened the mega; the mega is meant to cost most of a tree.');
    }
  }
  for (const n of nonMega.slice(0, TIER_REQ[3] - 1)) m = withNode(m, n.id);
  if (takeRefusal(m, TEAM.MARITA, 10, mega.id) === '') {
    bad.push(`A mega was takeable with ${TIER_REQ[3] - 1} in its tree; it needs ${TIER_REQ[3]}.`);
  }
  m = withNode(m, nonMega[TIER_REQ[3] - 1].id);
  if (takeRefusal(m, TEAM.MARITA, 10, mega.id) !== '') bad.push(`${TIER_REQ[3]} in the tree at level 10 did not open the mega: ${takeRefusal(m, TEAM.MARITA, 10, mega.id)}`);
  if (takeRefusal(m, TEAM.MARITA, 7, mega.id) === '') bad.push('A mega was takeable below level 8.');
  if (TIER_REQ[3] > 6) bad.push(`TIER_REQ[3] is ${TIER_REQ[3]} but a tree only has 6 non-mega nodes; the mega could never open.`);
  // Refund rule
  const full = withNode(m, mega.id);
  if (refundRefusal(full, TEAM.MARITA, streets[0].id) === '') {
    bad.push('Refunding a node under a mega standing on the minimum was allowed; the mega depends on it.');
  }
  // Scalars
  const one = withNode({ lo: 0, hi: 0 }, 14); // Front Bar
  if (ownScalar(one, FX.SWING_DAMAGE) !== 0.2) bad.push('ownScalar did not read Front Bar\'s swing damage.');
  const two = withNode(one, 19); // + Glassing (own effects, not aura here)
  if (Math.abs(ownScalar(two, FX.SWING_DAMAGE) - 0.4) > 1e-9) bad.push('ownScalar did not sum two swing-damage nodes.');
  const rech = withNode(withNode({ lo: 0, hi: 0 }, 15), 36);
  if (ownScalar(rech, FX.BALL_RECHARGE_S) !== 1.1) bad.push('min-wins key did not take the minimum.');
  if (hasNode(withNode({ lo: 0, hi: 0 }, 41), 41) !== true || hasNode(withNode({ lo: 0, hi: 0 }, 41), 40)) bad.push('The high half of the mask is wrong.');

  // --- The build sheet. What this catches: a summary that lied about how many
  //     points are left, or that offered a node the rule would refuse, is a
  //     sheet a player plans against and then cannot spend.
  {
    const none = buildSummary(TEAM.NONE, { lo: 0, hi: 0 }, 5);
    if (none.rows.length !== 0) bad.push('A player with no side was given trees to read.');
    let m2: TalentMask = withNode({ lo: 0, hi: 0 }, bn.id); // Big Night, in Servo
    const sheet = buildSummary(TEAM.MARITA, m2, 4);
    if (sheet.rows.length !== 3) bad.push(`${TEAM_NAME[TEAM.MARITA]}'s sheet has ${sheet.rows.length} trees, not 3.`);
    if (sheet.spent !== 1 || sheet.unspent !== 3) bad.push(`A level-4 with one point spent reads ${sheet.spent}/${sheet.unspent}; it should be 1 spent, 3 left.`);
    const servo = sheet.rows.find((r) => r.spent === 1);
    if (!servo || servo.taken.length !== 1 || servo.taken[0].name !== bigNightOf(TEAM.MARITA)!.name) {
      bad.push('The sheet did not put Big Night in the tree it was spent in.');
    }
    for (const row of sheet.rows) {
      for (const name of row.next) {
        const nd = NODES.find((n) => n.name === name && n.team === TEAM.MARITA);
        if (!nd || takeRefusal(m2, TEAM.MARITA, 4, nd.id) !== '') {
          bad.push(`The sheet offered ${name} as a next pick, but the rule refuses it.`);
        }
      }
    }
    // Nothing is offered when there is nothing to spend.
    const broke = buildSummary(TEAM.MARITA, m2, 1);
    if (broke.unspent !== 0 || broke.rows.some((r) => r.next.length > 0)) {
      bad.push('A player with no points left was still offered picks.');
    }
    // Taken nodes come back in tier order, so the sheet reads down the tree.
    for (let i = 0; i < 5; i++) m2 = withNode(m2, nodesFor(TEAM.MARITA, 0)[i].id);
    const ordered = buildSummary(TEAM.MARITA, m2, 10).rows.find((r) => r.tree === 'Streets');
    if (!ordered || ordered.taken.some((t, i, all) => i > 0 && t.tier < all[i - 1].tier)) {
      bad.push('The sheet listed a tier-3 talent above a tier-1 one.');
    }
  }
  return bad;
}
