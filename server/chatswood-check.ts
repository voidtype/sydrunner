/**
 * Chatswood came up off the floor, and nowhere else in Sydney moved.
 *
 *     bun run server/chatswood-check.ts
 *
 * ---------------------------------------------------------------------------
 * ## What was reported and what was wrong
 *
 * *"chatswood station is still half underground - it should actually be up a
 * little off the ground"*. The bake had the platforms 10.54 m under the terrain
 * with `structure: 'bridge'` and `bridgeShare: 1.00` -- four platform ways, all
 * `bridge=yes`, `layer=1` -- which is RAIL-VERTICAL.md's rule 2 firing exactly
 * as designed and reporting a conflict nobody could act on.
 *
 * Nothing at Chatswood was capped. What sank it was 291 m away: the Metro and
 * the North Shore pair enter tunnel 229 m north of the platform, and the
 * *second vertex inside the portal* -- 62 m past the headwall -- was asked for
 * the full 7.5 m of earth cover under a DEM that reads twelve metres lower
 * there than at the station. `apply_cover`'s cone is grade-legal, so it reaches
 * `d / 0.033` metres, and it took the station deck down the ramp with it.
 * 7.5 m of cover 62 m past a headwall is a 12% descent: not a strict demand, an
 * impossible one, and an impossible demand gets paid for somewhere else.
 *
 * The fix is RAIL-VERTICAL.md section 3a -- `pipeline/sydney/rail.portal_ceiling`
 * and `bore_cover_cap`: **a bore is only ever as deep as a train can have dug on
 * the way in from daylight.** Full cover past `TUNNEL_COVER_M / MAX_GRADIENT`
 * (227 m), the surface itself as the demand inside that window, and the player's
 * absolute rule -- never above the surface -- binding at every capped node
 * rather than being quietly infeasible near a portal.
 *
 * ---------------------------------------------------------------------------
 * ## Why the numbers below are what they are and not the ones asked for
 *
 * The brief wanted +5 to +8 m of clearance. It is not reachable, and the reason
 * is the ground rather than the solve. Two measurements on the same extract,
 * each made by weakening one rule at a time:
 *
 *   * cover requirement set to **zero** -- Chatswood comes out at **-3.58 m**,
 *     the same to the centimetre as what ships. The cover rule now costs the
 *     station nothing at all.
 *   * **every tunnel tag in Sydney deleted** -- it reaches **-0.24 m**. That is
 *     the ceiling the DEM and the 3.3% ruling gradient impose between a station
 *     node the DEM puts at 42.99 m and ground 291 m north it puts at 30.53 m.
 *
 * So this file asserts the achievable thing and fences it: the clearance is
 * better than -4.5 m and the deck no longer needs a shaft, and if a future
 * round finds the last three metres -- which is a terrain question, since the
 * DEM is a *surface* model and the 43 m plateau over the platform is the
 * interchange development sitting on it -- this check names the day it did.
 *
 * ---------------------------------------------------------------------------
 * ## And the second half, which is the one that matters more
 *
 * A rule that fixes one station by moving fifty is not a fix. `BEFORE` below is
 * every station's `siteY` from the bake immediately before the change, and this
 * walks all of them: anything that moved more than a metre is printed with its
 * delta and must be on `EXPECTED`, which has two names on it and a reason for
 * each. Measured over the shipped bake, four stations moved at all and two by
 * more than a metre.
 *
 * Loads the real bake through `server/world.ts`'s `loadWorld`, which is the
 * same `decodeRail` the browser runs over the same bytes. ~90 s. Exit 1 on any
 * failure.
 */
import { loadWorld } from './world.ts';

const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;

/**
 * How far a station's rail level may move before this file wants a reason.
 * A metre is a step up onto a platform; below that is the height solve
 * breathing and above it is a station somewhere else.
 */
const MOVE_TOLERANCE_M = 1.0;

/**
 * The stations allowed to move, and why each one is allowed to.
 *
 * Both are in life a deck beside a bore -- which is the whole class of station
 * the old bound was overcharging, so it is the whole class that comes up when
 * the overcharge stops. Chatswood's platforms are on the viaduct over the
 * interchange with the Metro portal 229 m north; Circular Quay stands on the
 * Cahill Expressway viaduct with the City Circle in tunnel at both ends of it,
 * and it was already classed `elevated` -- this makes it more so.
 */
const EXPECTED = new Map<string, string>([
  ['Chatswood', 'the report: a deck 229 m from the Metro portal, overcharged for its cover'],
  ['Circular Quay', 'the Cahill viaduct, City Circle bores at both ends -- the same overcharge, smaller'],
]);

/** `siteY` per station from the bake before RAIL-VERTICAL.md section 3a landed. */
const BEFORE: Array<[string, number]> = [
  ['Allawah',-19.11],['Arlington',0.0],['Arncliffe',-51.37],['Artarmon',20.25],
  ['Ashfield',-38.23],['Asquith',113.54],['Auburn',-47.56],['Austinmer',-44.12],
  ['Bank Street',0.0],['Banksia',-51.8],['Bankstown',-44.03],['Barangaroo',-67.32],
  ['Bardwell Park',-63.46],['Beecroft',67.17],['Bella Vista',-1.37],['Belmore',-44.15],
  ['Benaud Oval',0.0],['Berala',-45.9],['Berowra',134.12],['Beverly Hills',-43.31],
  ['Bexley North',-61.45],['Birrong',-32.26],['Blacktown',-9.6],['Blaxland',164.01],
  ['Bondi Junction',-4.01],['Bridge Street',0.0],['Bulli',-55.19],['Burwood',-40.54],
  ['Cabramatta',-56.58],['Campbelltown',-2.18],['Campsie',-52.96],['Canley Vale',-59.69],
  ['Canterbury',-62.07],['Capitol Square',-55.41],['Caringbah',-38.54],['Carlingford',0.0],
  ['Carlton',-33.63],['Carramar',-59.45],['Castle Hill',60.48],['Casula',-47.3],
  ['Central',-45.17],['Central Chalmers Street',-40.78],['Central Grand Concourse',-45.83],
  ['Chatswood',32.27],['Cheltenham',38.17],['Cherrybrook',97.5],['Chester Hill',-36.25],
  ['Childrens Hospital',0.0],['Chinatown',-55.18],['Church Street',0.0],
  ['Circular Quay',-43.92],['Clarendon',-55.2],['Clyde',-60.35],['Coalcliff',80.17],
  ['Coledale',1.26],['Como',-36.83],['Concord West',-57.27],['Convention',0.0],
  ['Cowan',118.79],['Cronulla',-56.48],['Crows Nest',9.99],['Croydon',-50.97],
  ['Denistone',-26.15],['Domestic Airport',-79.03],['Doonside',-25.08],['Douglas Park',53.04],
  ['Dulwich Grove',0.0],['Dulwich Hill',-53.22],['Dundas',0.0],['ES Marks',0.0],
  ['East Hills',-51.03],['East Richmond',-44.71],['Eastwood',-0.77],['Edgecliff',-41.72],
  ['Edmondson Park',-12.94],['Emu Plains',-36.89],['Engadine',115.02],['Epping',28.39],
  ['Erskineville',-54.13],['Exhibition Centre',0.0],['Fairfield',-57.8],
  ['Fennell Street',0.0],['Flemington',-52.88],['Gadigal',-30.51],['Glebe',0.0],
  ['Glenbrook',101.33],['Glenfield',-45.34],['Gordon',52.37],['Gosford',-55.49],
  ['Granville',-59.15],['Green Square',-71.87],['Guildford',-36.97],['Gymea',-7.98],
  ['Harris Park',-51.82],['Hawkesbury River',-57.89],['Hawthorne',0.0],['Haymarket',0.0],
  ['Heathcote',124.02],['Helensburgh',87.74],['Hills Showground',11.59],['Holsworthy',-59.61],
  ['Homebush',-55.92],['Hornsby',113.82],['Hurlstone Park',-50.98],['Hurstville',-2.23],
  ['Ingleburn',-38.63],['International Airport',-80.97],['Jannali',-1.35],
  ['John Street Square',0.0],['Jubilee Park',0.0],['Juniors Kingsford',0.0],
  ['Kellyville',-9.64],['Kensington',0.0],['Killara',48.05],['Kings Cross',-45.21],
  ['Kingsford',0.0],['Kingsgrove',-55.27],['Kingswood',-18.48],['Kirrawee',21.97],
  ['Kogarah',-53.41],['Koolewong',-59.77],['Lakemba',-35.27],['Lapstone',42.04],
  ['Leichhardt North',0.0],['Leightonfield',-52.4],['Leppington',16.33],['Leumeah',-16.08],
  ['Lewisham',-45.21],['Lewisham West',0.0],['Lidcombe',-49.02],['Lilyfield',0.0],
  ['Lindfield',32.54],['Lisarow',-38.95],['Liverpool',-54.77],['Loftus',38.08],
  ['Macarthur',3.21],['Macdonaldtown',-38.57],['Macquarie Fields',-46.32],
  ['Macquarie Park',-23.03],['Macquarie University',-26.74],['Marayong',-23.75],
  ['Marion',0.0],['Marrickville',-61.59],['Martin Place',-31.07],['Mascot',-77.99],
  ['Meadowbank',-52.44],['Menangle',13.45],['Menangle Park',7.82],['Merrylands',-48.83],
  ['Milsons Point',-29.72],['Minto',-25.45],['Miranda',-25.49],['Moore Park',0.0],
  ['Mortdale',-23.41],['Mount Colah',136.36],['Mount Druitt',-21.57],
  ['Mount Kuring-gai',139.9],['Mulgrave',-56.64],['Museum',-38.59],['Narara',-56.49],
  ['Narwee',-29.42],['Newtown',-40.59],['Ngara',0.0],['Niagara Park',-52.71],
  ['Normanhurst',91.41],['North Ryde',-20.23],['North Strathfield',-51.88],
  ['North Sydney',-26.96],['Norwest',1.73],['Oatley',-31.43],['Olympic Park',-62.39],
  ['Otford',56.41],['Ourimbah',-48.62],["Paddy's Markets",0.0],['Padstow',-54.68],
  ['Panania',-47.02],['Parramatta',-45.34],['Parramatta Square',0.0],['Pendle Hill',-24.03],
  ['Pennant Hills',99.34],['Penrith',-40.78],['Penshurst',-14.95],['Petersham',-34.87],
  ['Point Clare',-62.42],['Prince Alfred Square',0.0],['Punchbowl',-36.25],['Pymble',66.6],
  ['Pyrmont Bay',0.0],['QVB',-30.22],['Quakers Hill',-36.5],['Randwick',0.0],
  ['Redfern',-46.48],['Regents Park',-39.41],['Revesby',-55.46],['Rhodes',-55.08],
  ['Richmond',-46.9],['Riverstone',-53.84],['Riverwood',-51.98],['Robin Thomas',0.0],
  ['Rockdale',-51.64],['Rooty Hill',-31.03],['Rosehill Gardens',0.0],['Roseville',43.78],
  ['Rouse Hill',-11.52],['Royal Randwick',0.0],['Rozelle Bay',0.0],['Scarborough',84.24],
  ['Schofields',-37.27],['Sefton',-39.08],['Seven Hills',-35.72],['St James',-40.81],
  ['St Leonards',9.27],['St Marys',-33.75],['St Peters',-58.29],['Stanmore',-37.04],
  ['Stanwell Park',37.27],['Strathfield',-50.43],['Summer Hill',-43.19],['Surry Hills',0.0],
  ['Sutherland',34.14],['Sydenham',-69.18],['Tallawong',-12.98],['Tascott',-62.05],
  ['Taverners Hill',0.0],['Telopea',0.0],['Tempe',-63.36],['The Star',0.0],
  ['Thirroul',-55.27],['Thornleigh',98.77],['Toongabbie',-40.02],['Town Hall',-37.64],
  ['Tramway Avenue',0.0],['Turramurra',105.48],['Turrella',-67.03],['UNSW Anzac Parade',0.0],
  ['UNSW High Street',0.0],['Victoria Cross',-22.43],['Villawood',-55.13],['Vineyard',-33.88],
  ['Wahroonga',123.89],['Waitara',115.57],['Wansey Road',0.0],['Waratah Mills',0.0],
  ['Warrawee',117.59],['Warrimoo',204.94],['Warwick Farm',-64.08],['Waterfall',154.05],
  ['Waterloo',-65.96],['Waverton',-27.39],['Wentworth Park',0.0],['Wentworthville',-43.34],
  ['Werrington',-45.73],['West Ryde',-39.02],['Westmead',-38.5],['Westmead Hospital',0.0],
  ['Wiley Park',-31.78],['Windsor',-51.6],['Wolli Creek',-70.95],['Wollstonecraft',-16.26],
  ['Wombarra',49.13],['Woolooware',-39.58],['Woonona',-59.9],['Woy Woy',-68.11],
  ['Wynyard',-29.99],['Yagoona',-30.27],['Yallamundi',0.0],['Yennora',-50.61],
];

const world = await loadWorld(root);
const bake = world.rail;
if (!bake) {
  console.log('no rail bake beside the world; nothing to check');
  process.exit(1);
}

const bad: string[] = [];
const say = (ok: boolean, msg: string) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) bad.push(msg);
};

console.log('--- 1. Chatswood is on its deck, or as near to it as the ground allows');
const st = bake.stations.find((s) => s.name === 'Chatswood');
if (!st) {
  console.log('  FAIL  no station named Chatswood in the bake');
  process.exit(1);
}
console.log(
  `  clearance ${st.clearance.toFixed(2)} m (lo ${st.clearanceLo.toFixed(2)}, hi ${st.clearanceHi.toFixed(2)}), ` +
    `trackY ${st.trackY.toFixed(2)}, groundY ${st.groundY.toFixed(2)}, siteY ${st.siteY.toFixed(2)}, ` +
    `structure ${st.structure}, vertical ${st.vertical}`,
);
// The measured improvement, fenced. -10.54 was the report; -3.58 is what the
// portal ceiling leaves, and -0.24 is the ceiling with every tunnel deleted.
say(st.clearance > -4.5, `the platform sits ${st.clearance.toFixed(2)} m against the terrain, up from -10.54 m before the portal ceiling; the fence is -4.5 m`);
say(st.clearanceLo > -7.0, `the deep end of the platform is ${st.clearanceLo.toFixed(2)} m, up from -13.27 m; the fence is -7.0 m`);
say(st.siteY > 38.0, `the trains stand at ${st.siteY.toFixed(2)} m, up from 32.27 m`);
say(st.structure === 'bridge', `OSM still says the structure is a deck (${st.structure}, ${(st.bridgeShare * 100).toFixed(0)}% of the track over 85 m)`);
say(st.shaftDepth < 4.0, `access is ${st.shaftDepth.toFixed(2)} m of stair rather than the 9.76 m shaft a buried station needed`);
const lines = [...st.lines].sort().join(',');
say(lines === 'M1,T1', `both services still call at the one place: ${lines}, ${st.servedDirs.length} direction(s), ${st.siteFaces} platform face(s) over ${st.siteSpread.toFixed(0)} m`);
say(
  st.vertical === 'surface' || st.vertical === 'elevated',
  `the label follows the measurement (${st.vertical}) -- RAIL-VERTICAL.md section 2, and section 3a for why it is not 'elevated' yet`,
);

console.log('');
console.log(`--- 2. Nothing else in Sydney moved (tolerance ${MOVE_TOLERANCE_M.toFixed(1)} m of siteY)`);
const now = new Map(bake.stations.map((s) => [s.name, s.siteY]));
const movers: Array<[string, number, number, number]> = [];
let missing = 0;
for (const [name, was] of BEFORE) {
  const isNow = now.get(name);
  if (isNow === undefined) {
    missing++;
    bad.push(`${name} is in the baseline and not in the bake`);
    continue;
  }
  const d = isNow - was;
  if (Math.abs(d) > MOVE_TOLERANCE_M) movers.push([name, was, isNow, d]);
}
movers.sort((a, b) => Math.abs(b[3]) - Math.abs(a[3]));
say(missing === 0, `all ${BEFORE.length} stations in the baseline are still in the bake`);
say(bake.stations.length === BEFORE.length, `the bake still has ${BEFORE.length} stations (${bake.stations.length})`);
console.log(`  ${movers.length} station(s) moved more than ${MOVE_TOLERANCE_M.toFixed(1)} m:`);
for (const [name, was, isNow, d] of movers) {
  const why = EXPECTED.get(name);
  console.log(
    `    ${name.padEnd(24)} ${was.toFixed(2).padStart(9)} -> ${isNow.toFixed(2).padStart(9)}  ${(d >= 0 ? '+' : '') + d.toFixed(2)} m` +
      (why ? `   ${why}` : '   *** NOT EXPECTED ***'),
  );
}
const unexpected = movers.filter(([name]) => !EXPECTED.has(name)).map(([name]) => name);
say(unexpected.length === 0, `every station that moved is one this file names a reason for${unexpected.length ? `: ${unexpected.join(', ')} are not` : ''}`);
for (const name of EXPECTED.keys()) {
  say(movers.some(([n]) => n === name), `${name} did move -- an expectation nothing satisfies is a check that has stopped testing anything`);
}

console.log('');
if (bad.length > 0) {
  console.log(`${bad.length} failure(s)`);
  process.exit(1);
}
console.log('CHATSWOOD CHECKS PASSED');
