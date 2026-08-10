/**
 * `/tp <suburb>` — go to a named place.
 *
 * A chat command for the same reason `/unstuck` is one (see `game/unstuck.ts`'s
 * header): the chat wire already carries arbitrary text to the server, so a
 * command costs no message id, no protocol version and no key binding. This
 * module is the *rule* — parsing, matching and the sentences the player reads —
 * and nothing in it imports three or touches the world, so the server runs it
 * verbatim.
 *
 * The destination is a **suburb label node**, not a polygon: `world/suburbs.json`
 * is the same 316-name list the locator strip reads, one point each, straight
 * from OpenStreetMap's `place=suburb`. That point is the centre of the named
 * place in the only sense OSM records, which is what somebody typing "lane cove"
 * means. Arrival is then handed to `unstuckDestination`, so a teleport lands on
 * a real road out of traffic exactly as `/unstuck` does — a suburb centroid is
 * as likely to be inside a building as any other arbitrary point, and putting
 * somebody there would ship the bug the unstuck command exists to fix.
 */

/** The command and its alias. Matched case-folded; see `parseTeleport`. */
export const TELEPORT_COMMANDS: readonly string[] = ['/tp', '/goto'];

/**
 * What the world's coordinate origin is called.
 *
 * Every ENU coordinate in this project is metres from **Sydney Town Hall**
 * (-33.8688, 151.2093) — `pipeline/sydney/config.py`'s origin, the point the
 * whole city is generated around. The refusal message names it because "not
 * found within 15 km" is unanswerable without knowing 15 km of *what*, and
 * "the origin" is not a place anybody can picture.
 */
export const ORIGIN_NAME = 'Town Hall';

/** A suburb label node, as `world/suburbs.json` stores it. */
export interface Place {
  readonly name: string;
  readonly x: number;
  readonly z: number;
}

/**
 * The query, or null if this is not a teleport command.
 *
 * Returns the raw remainder so the refusal can quote what the player actually
 * typed. `/tp` with nothing after it is a command with an empty query rather
 * than a sentence — it gets the "name a suburb" reply instead of being
 * broadcast to everyone as the word "/tp".
 */
export function parseTeleport(text: string): string | null {
  const trimmed = text.trim();
  const space = trimmed.search(/\s/);
  const head = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  if (!TELEPORT_COMMANDS.includes(head)) return null;
  return space < 0 ? '' : trimmed.slice(space + 1).trim();
}

/**
 * `/platform <station>`: put me in the doorway of the next train to call here.
 *
 * ---------------------------------------------------------------------------
 * A SECOND COMMAND RATHER THAN A MODE OF `/tp`, and it is not tidiness.
 *
 * `/tp` resolves a *suburb label* out of `world/suburbs.json`. A station is not
 * in that table, the arrival rule is different (`unstuckDestination` finds a
 * road, and a road is the one place a boarder must not be), and the answer
 * depends on the timetable rather than only on the map. Overloading one command
 * with two resolvers and two arrival rules would make the refusals unreadable.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SERVER OWNS IT, WHICH IS THE WHOLE REASON IT EXISTS.
 *
 * The previous round's `sydney.rail.goto()` moved the *client's* body and said
 * so in its own docstring: "online the server has not heard of it ... `board()`
 * then correctly refuses". So the harness worked offline and could not be run
 * against a server at all -- and the feature shipped with its only acceptance
 * test running against a local `Simulation`. That is the hole. This command
 * closes it: the placement is solved and applied by the authority, out of the
 * authority's own bake at the authority's own `railT`, and the client learns
 * about it the way it learns about every other authoritative move -- through a
 * snapshot. A harness driving this is exercising the path a player uses.
 *
 * It is not a new power, either. `/tp` already relocates a player anywhere in
 * Greater Sydney on a ten-second cooldown; this lands them on a platform instead
 * of a street, and shares that cooldown, that knockout refusal and that
 * accounting.
 */
export const PLATFORM_COMMANDS: readonly string[] = ['/platform', '/plat'];

/** The query after `/platform`, or null if this is not that command. */
export function parsePlatform(text: string): string | null {
  const trimmed = text.trim();
  const space = trimmed.search(/\s/);
  const head = (space < 0 ? trimmed : trimmed.slice(0, space)).toLowerCase();
  if (!PLATFORM_COMMANDS.includes(head)) return null;
  return space < 0 ? '' : trimmed.slice(space + 1).trim();
}

export const PLATFORM_NO_QUERY = 'name a station — try /platform st peters';

/**
 * `st peters > central` -> the station and the service to wait for.
 *
 * The `>` is there so `sydney.rail.ride('St Peters', 'Central')` means the same
 * thing online as it does offline. Half the T4s at St Peters are going to
 * Waterfall, which reaches Central four minutes before you got on, so "the next
 * train" and "the next train I want" are different questions and a harness that
 * could only ask the first one would be a coin flip. See `riding.DwellWanted.then`.
 */
export function splitPlatformQuery(query: string): { station: string; then?: string } {
  const at = query.indexOf('>');
  if (at < 0) return { station: query.trim() };
  const station = query.slice(0, at).trim();
  const then = query.slice(at + 1).trim();
  return then ? { station, then } : { station };
}

export function platformNotFound(query: string): string {
  return `no service calls at "${query}" — try /platform central`;
}

export function platformReply(
  station: string, lineId: string, towards: string, opensIn: number,
): string {
  return opensIn <= 0.5
    ? `on the ${station} platform; the ${lineId} to ${towards} has its doors open now — E to board`
    : `on the ${station} platform; the ${lineId} to ${towards} is ${Math.round(opensIn)} s away — ` +
      `stand on the marker and press E when the doors open`;
}

/**
 * Find a place by name, case-insensitively.
 *
 * Three passes, each preferring the **shortest** name among its matches, which
 * is the whole of the disambiguation and the reason it is worth writing down:
 * "lane cove" is an exact name *and* a prefix of Lane Cove North and Lane Cove
 * West. Exact-first sends it to Lane Cove; shortest-first inside each pass sends
 * "lane cove n" to Lane Cove North rather than leaving it to table order.
 * Ties are broken by name so the answer is stable rather than dependent on how
 * the pipeline happened to sort its labels.
 */
export function findPlace(query: string, places: readonly Place[]): Place | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;

  const best = (test: (name: string) => boolean): Place | null => {
    let found: Place | null = null;
    for (const p of places) {
      if (!test(p.name.toLowerCase())) continue;
      if (
        !found ||
        p.name.length < found.name.length ||
        (p.name.length === found.name.length && p.name < found.name)
      ) {
        found = p;
      }
    }
    return found;
  };

  return (
    best((name) => name === q) ??
    best((name) => name.startsWith(q)) ??
    best((name) => name.includes(q))
  );
}

/** Kilometres, one decimal — the unit a player thinks in for a city. */
function km(metres: number): string {
  return `${(metres / 1000).toFixed(1)} km`;
}

/**
 * The refusal, in the shape the user asked for: what they typed, how far the
 * search reached, and from where.
 */
export function teleportNotFound(query: string, radiusM: number): string {
  return `${query} not found within ${km(radiusM)} of ${ORIGIN_NAME}`;
}

/** `/tp` with no argument. */
export const TELEPORT_NO_QUERY = 'name a suburb — try /tp lane cove';

/** Arrived. `distance` is how far they travelled, which is the fun part. */
export function teleportReply(place: Place, distanceM: number): string {
  return `moved you to ${place.name}, ${km(distanceM)} away — no death recorded`;
}

/**
 * Self-check. The matcher is the only arithmetic here and every one of these
 * cases is a real name in the shipped table.
 */
export function verifyTeleport(): string[] {
  const failures: string[] = [];
  const places: Place[] = [
    { name: 'Lane Cove', x: -3749.5, z: -5939.4 },
    { name: 'Lane Cove North', x: -4389.2, z: -6948.1 },
    { name: 'Lane Cove West', x: -5591.9, z: -6208.6 },
    { name: 'Newtown', x: -2639.3, z: 3076.3 },
    { name: 'North Bondi', x: 6275.0, z: 1395.9 },
    { name: 'Bondi', x: 5043.9, z: 2604.1 },
  ];

  const cases: Array<[string, string | null]> = [
    ['lane cove', 'Lane Cove'],
    ['LANE COVE', 'Lane Cove'],
    ['  Lane Cove  ', 'Lane Cove'],
    ['lane cove w', 'Lane Cove West'],
    ['bondi', 'Bondi'],
    ['north bondi', 'North Bondi'],
    ['newtown', 'Newtown'],
    ['cove', 'Lane Cove'],
    ['nowhere-at-all', null],
    ['', null],
  ];
  for (const [query, want] of cases) {
    const got = findPlace(query, places);
    if ((got?.name ?? null) !== want) {
      failures.push(`findPlace(${JSON.stringify(query)}) gave ${got?.name ?? 'null'}, wanted ${want}`);
    }
  }

  const parses: Array<[string, string | null]> = [
    ['/tp lane cove', 'lane cove'],
    ['/TP Lane Cove', 'Lane Cove'],
    ['/goto bondi', 'bondi'],
    ['/tp', ''],
    ['/tpsomething', null],
    ['tp lane cove', null],
    ['hello /tp bondi', null],
  ];
  for (const [text, want] of parses) {
    const got = parseTeleport(text);
    if (got !== want) {
      failures.push(`parseTeleport(${JSON.stringify(text)}) gave ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
    }
  }

  // --- `/platform`, on the same terms. See `parsePlatform`.
  //
  // The last two cases are the ones that matter: a command must not be matched
  // as a prefix of a word, and it must not be matched in the middle of a
  // sentence -- either would silently swallow somebody's chat message, and the
  // one rule this whole intercept lives on is that a command never reaches
  // anybody else's log while speech always does.
  const platforms: Array<[string, string | null]> = [
    ['/platform st peters', 'st peters'],
    ['/PLATFORM St Peters > Central', 'St Peters > Central'],
    ['/plat central', 'central'],
    ['/platform', ''],
    ['/platformer', null],
    ['platform central', null],
    ['meet me at /platform central', null],
  ];
  for (const [text, want] of platforms) {
    const got = parsePlatform(text);
    if (got !== want) {
      failures.push(`parsePlatform(${JSON.stringify(text)}) gave ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
    }
  }
  const splits: Array<[string, string, string | undefined]> = [
    ['st peters > central', 'st peters', 'central'],
    ['st peters', 'st peters', undefined],
    ['  st peters  >  central  ', 'st peters', 'central'],
    ['st peters >', 'st peters', undefined],
  ];
  for (const [q, station, then] of splits) {
    const got = splitPlatformQuery(q);
    if (got.station !== station || got.then !== then) {
      failures.push(
        `splitPlatformQuery(${JSON.stringify(q)}) gave ${JSON.stringify(got)}, wanted ` +
          `${JSON.stringify({ station, then })}`,
      );
    }
  }
  if (TELEPORT_COMMANDS.some((c) => PLATFORM_COMMANDS.includes(c))) {
    failures.push('a command name is claimed by both /tp and /platform');
  }

  if (!teleportNotFound('lane cove', 15300).includes('15.3 km of Town Hall')) {
    failures.push('teleportNotFound does not name the radius and the origin');
  }

  return failures;
}
