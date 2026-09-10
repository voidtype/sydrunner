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
 * ## Restated 2026-09-10: every fence in section 1 is a clearance
 *
 * One of them was not, and it was the one that would have gone off. `siteY >
 * 38.0` stood here, meaning *"the trains stand at 39.08 m, up from 32.27"* --
 * an **absolute height above the datum**, which is a fence on where the ground
 * happens to be and not on anything about the railway. RAIL-VERTICAL.md 3b took
 * 7.36 m of interchange roof off the ground under this station and
 * `rail.build_all` now reads the conformed lattice, so the trains correctly come
 * to stand at about 35.7 m -- and a check written to protect Chatswood would
 * have failed the round that fixed it.
 *
 * What the line was *for* is the two things a reader of the report cares about,
 * and both of them are differences:
 *
 *   * **the deck is not in a hole** -- where the trains actually stand, the
 *     ground over them is no further above them than the platform median is
 *     allowed to be. `siteY - siteGroundY`, fenced at the same -4.5 m, because
 *     the site and the platform are one measurement of one railway and there is
 *     no reading of "Chatswood is up off the floor" that lets them disagree.
 *   * **the platform is over the street** -- some of the deck stands above the
 *     ground beside it, which is what a viaduct over an interchange *is* and
 *     what "half underground" denied. `clearanceHi > 0`.
 *
 * Both survive a datum shift, a bare-earth pass, a road solve and a re-tile,
 * because a difference of two heights cannot be moved by moving both. The
 * negative control at the end of section 1 is the other half of that claim: the
 * same four fences are handed the same station buried ten metres, and every one
 * of them has to fire, or they are not fences.
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
  // Empty since the 2026-09-11 re-take: the baseline IS the conformed bake. A station that moves
  // from here is a regression until the pass that moved it is named on this list.
]);

/** `siteY` per station, re-taken 2026-09-11 from the first 60 km bake on the conformed lattice
 *  (RAIL-VERTICAL.md 3b/3e). The previous list was the raw-DEM bake; every station on conformed
 *  ground moved with the ground, which was that round's result and not a regression. */
const BEFORE: Array<[string, number]> = [
  ['Allawah',-19.71],['Arlington',0],['Arncliffe',-51.28],['Artarmon',20.77],
  ['Ashfield',-37.65],['Asquith',112.28],['Auburn',-47.37],['Austinmer',-41.42],
  ['Bank Street',0],['Banksia',-51.42],['Bankstown',-44.78],['Barangaroo',-64.73],
  ['Bardwell Park',-63.18],['Beecroft',66.49],['Bella Vista',-1.86],['Belmore',-45.33],
  ['Benaud Oval',0],['Berala',-45.45],['Berowra',132.35],['Beverly Hills',-43],
  ['Bexley North',-60.36],['Birrong',-32.85],['Blacktown',-9.71],['Blaxland',162.95],
  ['Bondi Junction',-6.12],['Bridge Street',0],['Bulli',-56.03],['Burwood',-40.75],
  ['Cabramatta',-56.71],['Campbelltown',-1.47],['Campsie',-53.15],['Canley Vale',-60],
  ['Canterbury',-61.42],['Capitol Square',-54.45],['Caringbah',-39.02],['Carlingford',0],
  ['Carlton',-34.95],['Carramar',-60.04],['Castle Hill',59.08],['Casula',-46.02],
  ['Central',-44.54],['Central Chalmers Street',-38.92],['Central Grand Concourse',-45.69],['Chatswood',35.68],
  ['Cheltenham',37.64],['Cherrybrook',96.2],['Chester Hill',-36.58],['Childrens Hospital',0],
  ['Chinatown',-52.33],['Church Street',0],['Circular Quay',-43.02],['Clarendon',-55.39],
  ['Clyde',-60.27],['Coalcliff',74.45],['Coledale',-8.97],['Como',-36.12],
  ['Concord West',-58.22],['Convention',0],['Cowan',118.47],['Cronulla',-57.31],
  ['Crows Nest',9.46],['Croydon',-51.06],['Denistone',-26.3],['Domestic Airport',-79.17],
  ['Doonside',-25.45],['Douglas Park',53.06],['Dulwich Grove',0],['Dulwich Hill',-53.69],
  ['Dundas',0],['East Hills',-52.15],['East Richmond',-45.37],['Eastwood',-0.41],
  ['Edgecliff',-44.19],['Edmondson Park',-14.14],['Emu Plains',-37.29],['Engadine',115.49],
  ['Epping',27.42],['Erskineville',-54.27],['ES Marks',0],['Exhibition Centre',0],
  ['Fairfield',-57.97],['Fennell Street',0],['Flemington',-52.38],['Gadigal',-31.94],
  ['Glebe',0],['Glenbrook',103.66],['Glenfield',-45.65],['Gordon',52.47],
  ['Gosford',-52.32],['Granville',-59.13],['Green Square',-71.62],['Guildford',-36.55],
  ['Gymea',-7.93],['Harris Park',-52.6],['Hawkesbury River',-59.72],['Hawthorne',0],
  ['Haymarket',0],['Heathcote',123.85],['Helensburgh',84.24],['Hills Showground',10.93],
  ['Holsworthy',-60.38],['Homebush',-56.33],['Hornsby',113.57],['Hurlstone Park',-51.38],
  ['Hurstville',-2.87],['Ingleburn',-38.97],['International Airport',-81.58],['Jannali',-1.38],
  ['John Street Square',0],['Jubilee Park',0],['Juniors Kingsford',0],['Kellyville',-11.22],
  ['Kensington',0],['Killara',47.11],['Kings Cross',-44.18],['Kingsford',0],
  ['Kingsgrove',-55.94],['Kingswood',-18.54],['Kirrawee',21.03],['Kogarah',-54.75],
  ['Koolewong',-56.15],['Lakemba',-35.95],['Lapstone',47.81],['Leichhardt North',0],
  ['Leightonfield',-52.07],['Leppington',15.83],['Leumeah',-15.79],['Lewisham',-46.4],
  ['Lewisham West',0],['Lidcombe',-49.86],['Lilyfield',0],['Lindfield',31.51],
  ['Lisarow',-38.57],['Liverpool',-53.43],['Loftus',37.76],['Macarthur',2.88],
  ['Macdonaldtown',-38.47],['Macquarie Fields',-46.68],['Macquarie Park',-23.49],['Macquarie University',-26.86],
  ['Marayong',-23.53],['Marion',0],['Marrickville',-61.01],['Martin Place',-29.69],
  ['Mascot',-77.8],['Meadowbank',-53.29],['Menangle',13.21],['Menangle Park',8.06],
  ['Merrylands',-48.66],['Milsons Point',-33.21],['Minto',-25.61],['Miranda',-25.16],
  ['Moore Park',0],['Mortdale',-24.52],['Mount Colah',135.19],['Mount Druitt',-21.6],
  ['Mount Kuring-gai',136.97],['Mulgrave',-57.15],['Museum',-37.23],['Narara',-56.27],
  ['Narwee',-29.22],['Newtown',-41.17],['Ngara',0],['Niagara Park',-52.53],
  ['Normanhurst',91.89],['North Ryde',-24.13],['North Strathfield',-52.54],['North Sydney',-26.96],
  ['Norwest',0.99],['Oatley',-30.87],['Olympic Park',-62.53],['Otford',57.45],
  ['Ourimbah',-36.83],['Paddy\'s Markets',0],['Padstow',-54.88],['Panania',-46.7],
  ['Parramatta',-47.34],['Parramatta Square',0],['Pendle Hill',-24.12],['Pennant Hills',98.91],
  ['Penrith',-41.38],['Penshurst',-15.46],['Petersham',-34.92],['Point Clare',-62.2],
  ['Prince Alfred Square',0],['Punchbowl',-36.91],['Pymble',66],['Pyrmont Bay',0],
  ['Quakers Hill',-36.18],['QVB',-28.93],['Randwick',0],['Redfern',-45.77],
  ['Regents Park',-39.2],['Revesby',-55.44],['Rhodes',-56.19],['Richmond',-47.31],
  ['Riverstone',-53.24],['Riverwood',-52.3],['Robin Thomas',0],['Rockdale',-51.4],
  ['Rooty Hill',-31.36],['Rosehill Gardens',0],['Roseville',41.98],['Rouse Hill',-12.62],
  ['Royal Randwick',0],['Rozelle Bay',0],['Scarborough',83.25],['Schofields',-37.79],
  ['Sefton',-39.09],['Seven Hills',-35.3],['St James',-40.96],['St Leonards',8.01],
  ['St Marys',-33.87],['St Peters',-58.15],['Stanmore',-36.65],['Stanwell Park',25.71],
  ['Strathfield',-49.97],['Summer Hill',-43.9],['Surry Hills',0],['Sutherland',33.82],
  ['Sydenham',-69.75],['Tallawong',-12.71],['Tascott',-58.36],['Taverners Hill',0],
  ['Telopea',0],['Tempe',-63.47],['The Star',0],['Thirroul',-55.32],
  ['Thornleigh',97.33],['Toongabbie',-40.26],['Town Hall',-37.16],['Tramway Avenue',0],
  ['Turramurra',105.02],['Turrella',-67.18],['UNSW Anzac Parade',0],['UNSW High Street',0],
  ['Victoria Cross',-23.42],['Villawood',-55.25],['Vineyard',-34.47],['Wahroonga',124.44],
  ['Waitara',115.33],['Wansey Road',0],['Waratah Mills',0],['Warrawee',117.38],
  ['Warrimoo',202.33],['Warwick Farm',-63.94],['Waterfall',153.29],['Waterloo',-65.69],
  ['Waverton',-28.26],['Wentworth Park',0],['Wentworthville',-44.13],['Werrington',-45.96],
  ['West Ryde',-40.42],['Westmead',-39.04],['Westmead Hospital',0],['Wiley Park',-32.48],
  ['Windsor',-51.63],['Wolli Creek',-71.1],['Wollstonecraft',-18.64],['Wombarra',49.13],
  ['Woolooware',-39.82],['Woonona',-59.9],['Woy Woy',-67.84],['Wynyard',-33.86],
  ['Yagoona',-29.66],['Yallamundi',0],['Yennora',-50.67]
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
/**
 * The four measurements section 1 fences, as one function over a station-shaped
 * record -- so the negative control below can be handed a broken one and watch
 * every fence fire. One expression, two readers: a control evaluating a
 * different rule from the check is a control that has stopped testing it.
 *
 * **Every one of them is a difference of two heights**, which is the whole of
 * the 2026-09-10 restatement in the header. Nothing here reads a height above
 * the datum, so nothing here moves when the ground does.
 */
interface Fenced {
  clearance: number;
  clearanceLo: number;
  clearanceHi: number;
  siteY: number;
  siteGroundY: number;
}
function fences(s: Fenced): Array<[boolean, string]> {
  const siteClear = s.siteY - s.siteGroundY;
  return [
    // The measured improvement, fenced. -10.54 was the report; -3.58 is what the
    // portal ceiling leaves, and -0.24 is the ceiling with every tunnel deleted.
    [above(s.clearance, -4.5), `the platform sits ${s.clearance.toFixed(2)} m against the terrain, up from -10.54 m before the portal ceiling; the fence is -4.5 m`],
    [above(s.clearanceLo, -7.0), `the deep end of the platform is ${s.clearanceLo.toFixed(2)} m, up from -13.27 m; the fence is -7.0 m`],
    // Where the trains actually stand, against the ground over them -- not the
    // absolute 38.0 m this used to be. See the header.
    [above(siteClear, -4.5), `where the trains stand the ground over them is ${siteClear.toFixed(2)} m away (siteY ${s.siteY.toFixed(2)} under siteGroundY ${s.siteGroundY.toFixed(2)}), up from -10.56 m; the fence is the platform's own -4.5 m`],
    // Platform over street: a deck over an interchange has some of itself above
    // the ground beside it, and "half underground" is exactly the denial of that.
    [above(s.clearanceHi, 0.0), `the high end of the platform stands ${s.clearanceHi.toFixed(2)} m over the ground -- the deck is over the street, not under it; the fence is 0 m`],
  ];
}
/** `a > b` with a NaN reading as a failure rather than as a pass. */
function above(a: number, b: number): boolean {
  return Number.isFinite(a) && a > b;
}

for (const [ok, msg] of fences(st)) say(ok, msg);
say(st.structure === 'bridge', `OSM still says the structure is a deck (${st.structure}, ${(st.bridgeShare * 100).toFixed(0)}% of the track over 85 m)`);
say(st.shaftDepth < 4.0, `access is ${st.shaftDepth.toFixed(2)} m of stair rather than the 9.76 m shaft a buried station needed`);
const lines = [...st.lines].sort().join(',');
say(lines === 'M1,T1', `both services still call at the one place: ${lines}, ${st.servedDirs.length} direction(s), ${st.siteFaces} platform face(s) over ${st.siteSpread.toFixed(0)} m`);
say(
  st.vertical === 'surface' || st.vertical === 'elevated',
  `the label follows the measurement (${st.vertical}) -- RAIL-VERTICAL.md section 2, and section 3a for why it is not 'elevated' yet`,
);

console.log('');
console.log('--- 1b. NEGATIVE CONTROL: the same four fences over the same station, buried');
// Ten metres of ground put back over the deck, and nothing else touched. A fence
// that a buried Chatswood still walks through is not a fence, and after the
// 2026-09-10 restatement this control is the only thing standing between "every
// assertion is a difference of two heights" and "every assertion is vacuous":
// a relative measure is *easier* to satisfy accidentally than an absolute one,
// because both halves of it move together. Burying the record moves one half.
const BURY_M = 10.0;
const buried = {
  clearance: st.clearance - BURY_M,
  clearanceLo: st.clearanceLo - BURY_M,
  clearanceHi: st.clearanceHi - BURY_M,
  siteY: st.siteY - BURY_M,
  siteGroundY: st.siteGroundY,
};
const survived = fences(buried).filter(([ok]) => ok);
for (const [ok, msg] of fences(buried)) {
  console.log(`    ${ok ? 'passed (BAD)' : 'fired  (good)'}  ${msg}`);
}
say(
  survived.length === 0,
  `all ${fences(buried).length} fences fire on a Chatswood ${BURY_M.toFixed(0)} m under the ground` +
    (survived.length ? ` -- ${survived.length} did not, and are therefore testing nothing` : ''),
);

console.log('');
console.log(`--- 2. Nothing else in Sydney moved (tolerance ${MOVE_TOLERANCE_M.toFixed(1)} m of siteY)`);
// **This section is a 60 km check and says so.** `BEFORE` is an absolute `siteY`
// per station, which is the one kind of number the header has just finished
// arguing a fence must not be -- but here it is a *baseline for a delta*, and a
// delta of two absolute heights is a difference like any other, so it is sound
// for as long as it is compared against a bake of the same shape. It is not
// sound against a scoped bake: a 20 km run has 156 stations against this list's
// 267, and the 111 absences are the extract's radius rather than anything the
// railway did. So a bake missing baseline stations reports and does not fail.
//
// TO WHOEVER RE-BAKES 60 km ON THE CONFORMED LATTICE FIRST: this list was taken
// on a bake that read the raw DEM, and `rail.build_all` no longer does. Every
// station whose ground the road, water, pad or bare-earth passes moved will move
// with it, and that is the round's result rather than a regression -- re-take
// the list from the new bake, and put the ones that moved past a metre on
// `EXPECTED` with the pass that moved them named.
const now = new Map(bake.stations.map((s) => [s.name, s.siteY]));
const movers: Array<[string, number, number, number]> = [];
let missing = 0;
for (const [name, was] of BEFORE) {
  const isNow = now.get(name);
  if (isNow === undefined) {
    missing++;
    continue;
  }
  const d = isNow - was;
  if (Math.abs(d) > MOVE_TOLERANCE_M) movers.push([name, was, isNow, d]);
}
movers.sort((a, b) => Math.abs(b[3]) - Math.abs(a[3]));
const scoped = missing > 0;
if (scoped) {
  console.log(
    `  SCOPED BAKE: ${bake.stations.length} stations against the baseline's ${BEFORE.length}, ` +
      `${missing} of the baseline absent. This section is the 60 km comparison and is reported, not asserted.`,
  );
} else {
  say(missing === 0, `all ${BEFORE.length} stations in the baseline are still in the bake`);
  say(bake.stations.length === BEFORE.length, `the bake still has ${BEFORE.length} stations (${bake.stations.length})`);
}
console.log(`  ${movers.length} station(s) moved more than ${MOVE_TOLERANCE_M.toFixed(1)} m:`);
for (const [name, was, isNow, d] of movers) {
  const why = EXPECTED.get(name);
  console.log(
    `    ${name.padEnd(24)} ${was.toFixed(2).padStart(9)} -> ${isNow.toFixed(2).padStart(9)}  ${(d >= 0 ? '+' : '') + d.toFixed(2)} m` +
      (why ? `   ${why}` : `   ${scoped ? '(not on EXPECTED)' : '*** NOT EXPECTED ***'}`),
  );
}
if (!scoped) {
  const unexpected = movers.filter(([name]) => !EXPECTED.has(name)).map(([name]) => name);
  say(unexpected.length === 0, `every station that moved is one this file names a reason for${unexpected.length ? `: ${unexpected.join(', ')} are not` : ''}`);
  for (const name of EXPECTED.keys()) {
    say(movers.some(([n]) => n === name), `${name} did move -- an expectation nothing satisfies is a check that has stopped testing anything`);
  }
}

console.log('');
if (bad.length > 0) {
  console.log(`${bad.length} failure(s)`);
  process.exit(1);
}
console.log('CHATSWOOD CHECKS PASSED');
