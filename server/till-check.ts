/**
 * The till, through a real `Simulation` and a real `WalletStore`.
 *
 *     bun run server/till-check.ts
 *
 * **Why this exists as a file rather than as more of `verifyTill`.**
 *
 * `game/till.ts`'s self-check covers everything the shop can get wrong as
 * *arithmetic* -- the rate, the ladder, the whole dollars, the index bounds --
 * and it runs at boot in both runtimes, which is where a check of that kind
 * belongs. What it cannot cover is the part that only exists once the pieces
 * are wired together, and which is silent in this repo's sense: a purchase
 * that draws a button, sends a frame, and moves no money.
 *
 *   - a `PHONE_OP.TOPUP` frame decoding to the pack the phone drew;
 *   - `Simulation.topUp` crediting the wallet the store will write to disk;
 *   - the note the player reads afterwards naming the pack and saying `test`;
 *   - a pack index off the end being **refused rather than clamped**, because a
 *     clamp would sell the dearest pack to anybody who asked a bad question;
 *   - the cooldown refusing a held button, and letting go of it working again;
 *   - and the rule with the most money behind it: **a purchase is not
 *     earnings.** `game/till.ts` says money never buys progress, and the way
 *     that is enforced is `wallet.grant` not signalling an `earn` step. A
 *     regression there is invisible -- everything works, and a five dollar
 *     top-up quietly finishes a quest that asked you to earn five hundred.
 *
 * `server/accounts-check.ts`'s empty-city fixture, for its reasons: a city with
 * no prisms and no terrain is all a wallet needs, and this runs in about a
 * second rather than the twenty-five minutes `integration-check` takes.
 *
 * Exit code 1 on any failure.
 */

import { CollisionWorld } from '../client/src/player/collision.ts';
import { PedestrianField } from '../client/src/game/pedestrians.ts';
import { PowerupField } from '../client/src/game/powerups.ts';
import { SpatialHash } from '../client/src/game/spatialhash.ts';
import { TerrainField } from '../client/src/world/terrain.ts';
import { TrafficField } from '../client/src/game/traffic.ts';
import { WaterLevels } from '../client/src/world/wading.ts';
import { MSG } from '../client/src/net/protocol.ts';
import { PHONE_OP, decodePhone, encodePhone } from '../client/src/net/cash.ts';
import { PACKS, TILL_COOLDOWN_MS, packAt } from '../client/src/game/till.ts';
import { STARTING_BALANCE } from '../client/src/game/cash.ts';
import { WalletStore } from './wallets.ts';
import { Simulation } from './sim.ts';
import type { ServerWorld } from './world.ts';

const failures: string[] = [];
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

/** `server/accounts-check.ts`'s fixture, for its reasons. */
function emptyWorld(): ServerWorld {
  return {
    index: { stage: 'test', radius_m: 0, tile_size: 500, terrain: { grid: 16, datum_ahd: 0, sea_level_y: 0 }, tiles: [] },
    hexes: [],
    collision: new CollisionWorld(),
    terrain: new TerrainField(16, 500, ''),
    water: WaterLevels.fromIndex([], 500),
    powerups: new PowerupField(),
    traffic: new TrafficField(),
    peds: new PedestrianField(),
    points: [],
    pointIndex: new SpatialHash<number>(),
    tileOf: new Map(),
    bytes: { collision: 0, terrain: 0, powerups: 0, lanes: 0 },
    powerupSource: [],
    spawn: { x: 0, z: 0 },
    places: [],
  };
}

const wallets = new WalletStore('');
const sim = new Simulation(emptyWorld(), { wallets });
const buyer = sim.join(0, null, 'Bazza');
// The participant's own id, which is not the connection id it joined on.
const me = buyer.id;

// --- The frame the phone actually sends, decoded by the server's own decoder.
const wire = decodePhone(encodePhone(MSG.PHONE, PHONE_OP.TOPUP, '', 1), MSG.PHONE);
check(wire !== null && wire.op === PHONE_OP.TOPUP && wire.packIndex === 1, 'the phone\'s frame arrives as a top-up for pack 1');

// --- One purchase.
const slab = packAt(1);
const before = buyer.wallet?.balance ?? -1;
check(before === STARTING_BALANCE, 'a new player starts on the starting balance', `$${before}`);
const refusal = sim.topUp(me, 1);
check(refusal === '', 'the purchase was not refused', refusal);
check(buyer.wallet?.balance === before + (slab?.dollars ?? 0), 'the pack landed in the wallet', `$${buyer.wallet?.balance}`);
check(
  buyer.walletNote.includes('slab') && buyer.walletNote.includes('test'),
  'the receipt names the pack and says it is a test',
  buyer.walletNote,
);
check(buyer.walletVersion > 0, 'the wallet frame will be resent');

// --- A purchase is not earnings. The signal a quest step listens on must not
//     have fired; anything else makes five real dollars finish a quest.
let earned = 0;
const spy = { signal: (_id: number, kind: string): void => { if (kind === 'earn') earned++; } };
(sim as unknown as { quests: typeof spy | null }).quests = spy;
buyer.lastTillMs = 0;
sim.topUp(me, 0);
check(earned === 0, 'buying money did not signal an earn step', `${earned} signal(s)`);
// ...and the control: money that *was* earned still does, so the check above is
// proving a rule rather than a broken spy.
sim.wallet.credit(me, 25, 'fare');
check(earned === 1, 'a fare still signals an earn step', `${earned} signal(s)`);
(sim as unknown as { quests: typeof spy | null }).quests = null;

// --- The cooldown, both ways.
const held = sim.topUp(me, 0);
check(held !== '', 'a held button is refused', held || '(allowed)');
buyer.lastTillMs = Date.now() - TILL_COOLDOWN_MS - 1;
check(sim.topUp(me, 0) === '', 'letting go and asking again works');

// --- A bad index buys nothing at all, and does not clamp to a pack.
const rich = buyer.wallet?.balance ?? 0;
for (const bad of [-1, PACKS.length, 255, 1.5]) {
  buyer.lastTillMs = 0;
  const said = sim.topUp(me, bad);
  check(said !== '', `pack index ${bad} is refused`, said || '(allowed)');
}
check(buyer.wallet?.balance === rich, 'a refused purchase moved no money', `$${buyer.wallet?.balance}`);

// --- A player who is not here buys nothing.
buyer.lastTillMs = 0;
check(sim.topUp(999, 0) !== '', 'a top-up for an id that is not in the room is refused');

console.log(failures.length === 0 ? '\nTILL CHECK PASSED' : `\n${failures.length} CHECK(S) FAILED`);
process.exit(failures.length === 0 ? 0 : 1);
