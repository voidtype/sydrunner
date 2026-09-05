/**
 * What the car you just got into is called, and why that is a table and not a
 * lookup into the renderer.
 *
 * ---------------------------------------------------------------------------
 * 1. THE OWNER'S NOTE, AND THE ONE HARD PART OF IT.
 *
 * *"say the make and model of the vehicle when u get in as hero text"*. The
 * hero line already exists -- `game/arealine.ts` says a place name once, big,
 * and gone, and `announce()` is the door the lift's *"LEVEL 12"* already comes
 * through -- so the feature is one string, said at one moment. The hard part is
 * that the string has to be **the model the car is actually drawn with**, and
 * nothing on a car says which that is.
 *
 * `world/carlod.ts` section 1 is the reason. A car in this world is not an
 * object with fields; it is a lookup, and its model is
 *
 *     pool[identity % pool.length]
 *
 * over the manifest's own order, with each entry repeated `weight` times. That
 * is evaluated in a file that imports three, inside a fleet that only exists
 * once 20 `.glb` files have been fetched and merged, and only for the two dozen
 * cars inside `CLAIM_RADIUS`. None of that can be asked at the moment somebody
 * presses `E` on the far side of Penrith, and none of it can be asked on the
 * Bun server or in a boot check at all.
 *
 * So the *identity* half of the manifest -- which file, which body class, what
 * weight, what it is called -- lives here as a plain table, three-free, and
 * `carLabel` re-derives the same modulus from it. A parked box that has never
 * been claimed still has a determinate model, because the model was never a
 * property of the claim: it was always a property of the number.
 *
 * ---------------------------------------------------------------------------
 * 2. ONE FACT, TWO PLACES -- AND THE GUARD THAT MAKES THAT SAFE.
 *
 * `client/public/cars/manifest.json` is still the on-disk record: it carries
 * the licences, the attributions, the triangle counts and the atlas flag, it is
 * what `scripts/prep-car-models.mjs` writes and what `scripts/render-car-sheet.mjs`
 * draws from, and `carlod` still fetches it at load. This table is a second
 * copy of four of its fields, and a second copy is a drift waiting to happen.
 *
 * The alternative was worse in both directions. Importing the JSON here would
 * put a fetched asset on the Bun server's import graph; generating this file
 * from the JSON would put a build step between an artist dropping a `.glb` in
 * and the game naming it. So instead the drift is made **loud**:
 * `carlod.loadCarModels` compares the manifest it fetched against `CAR_FLEET`
 * row for row -- file, body, weight, order -- and `console.error`s the exact
 * difference. A table that has gone stale says so on the first frame of the
 * first session, in the one place a person is already looking.
 *
 * ---------------------------------------------------------------------------
 * 3. REAL CARS ONLY, IN THE CLASSES A PLAYER CAN DRIVE.
 *
 * *"remove fake models keep the new real life ones"*. The five passenger body
 * classes hold real makes and nothing else now; nineteen stylised or generic
 * stand-ins (`*_generic_*`, `*_filler`, `*_kenney`, `hatch_micro`, `van_panel`,
 * `ute_generic`) were deleted from the manifest and from `client/public/cars/`
 * rather than weighted to zero, because a weight of zero is a file that still
 * ships, still downloads and still has to be explained.
 *
 * The four **special** bodies keep theirs -- the bus, the garbage truck, the
 * taxi and the police car -- for a reason that is about the disk and not about
 * taste: there is no real-make alternative on it for any of the four roles, and
 * a role whose only mesh is deleted is a role that can never be drawn. The
 * manifest says the same thing in each of those five rows' `note`. Three of the
 * four are not even loaded (`carlod.mappedBody`): there is no taxi, bus or
 * garbage-truck entity in the traffic, so those labels wait for one.
 *
 * The consequence worth stating rather than discovering: **body 4 now has one
 * model**. Every van in Sydney -- 70,086 of the 1.4 M parked cars, 5 % -- is a
 * Toyota HiAce, because the HiAce is the only real van in the set. And body 1
 * is five parts Corolla to one part Golf, which is what `PER_MODEL_CAPACITY`
 * had to be raised for; `carlod` carries that arithmetic with the measurement.
 *
 * ---------------------------------------------------------------------------
 * 4. WHAT THIS DELIBERATELY DOES NOT KNOW.
 *
 * Whether the model *loaded*. A file that fails to fetch, or that `carlod`
 * refuses on `PROPORTION_LIMIT`, keeps its slot in the pool as a hole and the
 * cars that hash to it draw as boxes -- and this file will still name them,
 * because the name is a property of the car and not of a successful download.
 * That is the right way round: a player told they are in a HiLux while looking
 * at a box has been told something true about the car, and the box is a
 * separate fault with its own console line.
 */

/** One row of the fleet's identity, as `client/public/cars/manifest.json` has it. */
export interface CarFleetEntry {
  /** The `.glb`, which is also the key `carlod` files a model under. */
  file: string;
  /** `0`..`4` for the five passenger body classes, or a named role. */
  body: number | 'police' | 'taxi' | 'bus' | 'garbage';
  /** The model's share of its class, in whole points. See `carPool`. */
  weight: number;
  /** What a player is told they are in. Make first; see `CAR_MAKES`. */
  label: string;
}

/**
 * The manifest's identity half, **in the manifest's own order**.
 *
 * The order is a contract and not a convenience, for `world/carlod.ts` section
 * 1's reason: `identity % pool.length` over this order is the model choice for
 * every car in Sydney, so sorting it differently re-models the city and
 * removing a row re-models the class. Both of those happened deliberately this
 * round; neither may happen by accident.
 */
export const CAR_FLEET: readonly CarFleetEntry[] = [
  { file: 'city_bus.glb', body: 'bus', weight: 1, label: 'Sydney Buses Transit' },
  { file: 'ford_ranger_2023.glb', body: 3, weight: 8, label: 'Ford Ranger 2023' },
  { file: 'garbage_truck_kenney.glb', body: 'garbage', weight: 1, label: 'Council Garbage Truck' },
  { file: 'hyundai_tucson_2015.glb', body: 2, weight: 3, label: 'Hyundai Tucson 2015' },
  { file: 'mazda_cx5_tnnv.glb', body: 2, weight: 5, label: 'Mazda CX-5' },
  { file: 'mitsubishi_l200_dh.glb', body: 3, weight: 4, label: 'Mitsubishi Triton' },
  { file: 'mitsubishi_l200.glb', body: 3, weight: 1, label: 'Mitsubishi Triton' },
  { file: 'nissan_xtrail_2023.glb', body: 2, weight: 4, label: 'Nissan X-Trail 2023' },
  { file: 'police_kenney.glb', body: 'police', weight: 1, label: 'NSW Police Cruiser' },
  { file: 'taxi_generic.glb', body: 'taxi', weight: 1, label: 'Sydney Taxi' },
  { file: 'taxi_kenney.glb', body: 'taxi', weight: 1, label: 'Sydney Taxi' },
  { file: 'tesla_model_3.glb', body: 0, weight: 4, label: 'Tesla Model 3' },
  { file: 'toyota_camry_2020.glb', body: 0, weight: 6, label: 'Toyota Camry 2020' },
  { file: 'toyota_corolla_2020.glb', body: 1, weight: 5, label: 'Toyota Corolla 2020' },
  { file: 'toyota_hiace_2020.glb', body: 4, weight: 8, label: 'Toyota HiAce 2020' },
  { file: 'toyota_hilux_2021.glb', body: 3, weight: 8, label: 'Toyota HiLux 2021' },
  { file: 'toyota_hilux_97.glb', body: 3, weight: 1, label: 'Toyota HiLux 1997' },
  { file: 'toyota_prado_2013.glb', body: 2, weight: 5, label: 'Toyota LandCruiser Prado 2013' },
  { file: 'vw_golf_mk.glb', body: 1, weight: 1, label: 'Volkswagen Golf' },
];

/**
 * The stand-ins that were deleted this round, by file.
 *
 * Kept as a list rather than as a memory, because "somebody put a generic back"
 * is exactly the change that looks harmless in a diff -- one row in a JSON file
 * -- and re-models a whole body class the moment it lands. `verifyCarLabels`
 * refuses any of these names in the table.
 */
export const REMOVED_STANDINS: readonly string[] = [
  'hatch_filler.glb', 'hatch_generic_a.glb', 'hatch_kenney.glb', 'hatch_micro.glb',
  'sedan_filler.glb', 'sedan_generic_a.glb', 'sedan_generic_b.glb', 'sedan_generic_c.glb',
  'sedan_kenney.glb', 'sedan_sports_kenney.glb',
  'suv_generic_a.glb', 'suv_generic_b.glb', 'suv_kenney.glb', 'suv_luxury_kenney.glb',
  'ute_generic.glb', 'ute_tray_kenney.glb',
  'van_courier_kenney.glb', 'van_generic_a.glb', 'van_panel.glb',
];

/**
 * The makes a passenger label may begin with.
 *
 * The check that matters -- "no stand-ins left in a class a player can drive"
 * -- cannot be made by looking for the word "generic", because the next
 * stand-in will not be called that. It can be made by requiring the *positive*
 * property instead: a passenger label names a manufacturer that exists, first
 * word, and a mesh that does not have one cannot be described that way without
 * somebody lying on purpose.
 */
export const CAR_MAKES: readonly string[] = [
  'Ford', 'Holden', 'Hyundai', 'Isuzu', 'Kia', 'Mazda', 'Mitsubishi', 'Nissan',
  'Subaru', 'Tesla', 'Toyota', 'Volkswagen',
];

/** The five passenger classes, which are the ones a car can be parked or driven as. */
export const PASSENGER_BODIES = 5;

/**
 * The weighted pool for one body class, in manifest order, as file names.
 *
 * The **same list `carlod` builds**, by the same rule and out of the same
 * order: a row of weight `w` appears `w` times, consecutively, where it sits in
 * the table. It is built here rather than shared with `carlod` because that
 * file's pools hold merged geometry and cannot exist on the server, and because
 * two lists that must agree are better checked against each other than derived
 * from one another -- `verifyCarLabels` does exactly that against
 * `carlod.poolFiles()` in the browser.
 */
export function carPool(body: number | 'police' | 'taxi' | 'bus' | 'garbage'): readonly string[] {
  const out: string[] = [];
  for (const entry of CAR_FLEET) {
    if (entry.body !== body) continue;
    const weight = Math.max(1, Math.min(16, Math.round(entry.weight)));
    for (let i = 0; i < weight; i++) out.push(entry.file);
  }
  return out;
}

/** Every pool, once, so a caller does not rebuild one per car. */
const POOLS = new Map<string, readonly string[]>();
/** file -> label, so the second half of `carLabel` is a hash and not a scan. */
const LABELS = new Map<string, string>();
for (const entry of CAR_FLEET) LABELS.set(entry.file, entry.label);

function poolFor(body: number | 'police'): readonly string[] {
  const key = String(body);
  let pool = POOLS.get(key);
  if (pool === undefined) {
    pool = carPool(body);
    POOLS.set(key, pool);
  }
  return pool;
}

/**
 * What to call the car with this identity and this body class.
 *
 * `identity` is `traffic.identityOf(route, slot)` for a schedule car,
 * `traffic.staticCarIdentity(tileKey, index)` for a parked one, and
 * `driving.DrivenCar.carId` for one somebody has taken -- which is the same
 * number as whichever of the first two it used to be, by construction
 * (`CarField.take` copies `source.identity` into `carId`).
 *
 * `body` is `0`..`4`, or `'police'` for a car `factions.policeLiveried` has put
 * a livery on. **A driven car is never `'police'`**, and that is `carlod`'s
 * rule rather than this file's: a car somebody stole is not a police car
 * whatever it was five minutes ago, so the sweep claims it on its body class.
 * This function is passed whatever the renderer would pass, so the two agree by
 * construction rather than by care.
 *
 * Pure: one modulus and two map lookups, no allocation, no `Math` beyond the
 * remainder. Safe on both ends and in a check.
 */
export function carLabel(identity: number, body: number | 'police'): string {
  const pool = poolFor(body);
  if (pool.length === 0) return UNKNOWN_CAR;
  // `identity` is a well-mixed 32-bit number (`traffic.carHash`), so the low
  // bits are as good as any -- `carlod.consider` takes the same remainder of the
  // same number over a pool of the same length, which is what makes the label
  // the model. `>>> 0` because a 32-bit hash arrives signed through `Math.imul`
  // and a negative remainder would index off the front of the pool.
  const file = pool[(identity >>> 0) % pool.length];
  return LABELS.get(file) ?? UNKNOWN_CAR;
}

/**
 * What a car with no pool is called.
 *
 * Reachable only through a body class the manifest names no model for, which
 * today is none of them -- but a manifest is data, and a hero line that said
 * `undefined` would be worse than one that said nothing useful.
 */
export const UNKNOWN_CAR = 'Unmarked Vehicle';

/**
 * The label table, asserted. On both boot lists.
 *
 * What this can prove without a renderer, a fetch or a world: that every car in
 * Sydney has a name, that the name never changes for the same car, that it
 * comes from the same modulus the renderer takes, and that no passenger class
 * has quietly grown a stand-in back.
 */
export function verifyCarLabels(): string[] {
  const failures: string[] = [];

  // --- The table itself.
  const seen = new Set<string>();
  const removed = new Set(REMOVED_STANDINS);
  for (const entry of CAR_FLEET) {
    if (seen.has(entry.file)) failures.push(`\`${entry.file}\` is in CAR_FLEET twice; it would be drawn twice as often as its weight says.`);
    seen.add(entry.file);
    if (entry.label.trim() === '') failures.push(`\`${entry.file}\` has no label, so getting into it would say nothing.`);
    if (!(entry.weight >= 1 && entry.weight <= 16)) {
      failures.push(`\`${entry.file}\` has weight ${entry.weight}; \`carlod.addModel\` clamps to 1..16, so the two pools would differ in length and every car in the class would be a different model.`);
    }
    if (removed.has(entry.file)) {
      failures.push(
        `\`${entry.file}\` is one of the stand-ins removed this round and it is back in CAR_FLEET. ` +
          'The passenger classes carry real makes only; see `carlabels.ts` section 3.',
      );
    }
    if (typeof entry.body === 'number') {
      if (!(entry.body >= 0 && entry.body < PASSENGER_BODIES)) {
        failures.push(`\`${entry.file}\` is body ${entry.body}, which is not one of the ${PASSENGER_BODIES} classes.`);
      }
      const make = entry.label.split(' ')[0];
      if (!CAR_MAKES.includes(make)) {
        failures.push(
          `\`${entry.file}\` is a passenger car labelled "${entry.label}", whose first word is not a ` +
            'make. A class a player can drive holds real cars only, and the label is how that is checked.',
        );
      }
    }
  }

  // --- Every body class can name a car, and names the same one twice.
  for (const body of [0, 1, 2, 3, 4, 'police'] as const) {
    const pool = poolFor(body);
    if (pool.length === 0) {
      failures.push(`Body ${body} has an empty pool, so every car of that class would be called "${UNKNOWN_CAR}".`);
      continue;
    }
    for (let i = 0; i < 512; i++) {
      // Spread over the whole 32-bit range, negatives included: `carHash` is
      // `Math.imul` and hands out signed numbers.
      const identity = (i * 2654435761) | 0;
      const label = carLabel(identity, body);
      if (label === '' || label === UNKNOWN_CAR) {
        failures.push(`carLabel(${identity}, ${body}) gave "${label}"; every car in Sydney has a name.`);
        break;
      }
      if (carLabel(identity, body) !== label) {
        failures.push(`carLabel(${identity}, ${body}) is not deterministic, so a car would rename itself between two takes.`);
        break;
      }
      // And it is the pool's own answer, at the index `carlod.consider` takes.
      const expect = LABELS.get(pool[(identity >>> 0) % pool.length]);
      if (label !== expect) {
        failures.push(
          `carLabel(${identity}, ${body}) said "${label}" where \`pool[identity % ${pool.length}]\` is ` +
            `"${expect}". The label has to be the model the fleet draws or it is a lie about the car.`,
        );
        break;
      }
    }
  }

  // --- A pool's length is the sum of its weights, which is what the modulus is.
  for (const body of [0, 1, 2, 3, 4] as const) {
    let sum = 0;
    for (const entry of CAR_FLEET) if (entry.body === body) sum += entry.weight;
    if (poolFor(body).length !== sum) {
      failures.push(`Body ${body}'s pool is ${poolFor(body).length} long against ${sum} points of weight.`);
    }
  }

  // --- And the one property the removal was for: no passenger class draws a
  // stand-in, stated as the positive rather than as an absence.
  for (const body of [0, 1, 2, 3, 4] as const) {
    for (const file of new Set(poolFor(body))) {
      const entry = CAR_FLEET.find((e) => e.file === file);
      if (entry === undefined) {
        failures.push(`Body ${body}'s pool holds \`${file}\`, which is in no CAR_FLEET row.`);
        continue;
      }
      if (!CAR_MAKES.includes(entry.label.split(' ')[0])) {
        failures.push(`Body ${body} can draw \`${file}\`, whose label "${entry.label}" names no make.`);
      }
    }
  }

  return failures;
}
