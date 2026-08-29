/**
 * Where the work is, with a name on it.
 *
 * ---------------------------------------------------------------------------
 * ## The complaint this exists to answer
 *
 * The owner, twice, months apart, and the second time after the map already
 * drew every giver in reach: *"the quest system still seems to be hard to
 * discover"*, and then *"it should also be super clear guiding to new quest
 * areas, im not happy with how hard to discover the quest ux is"*.
 *
 * Both of those are true of a build that has, on paper, four separate quest
 * finders: a `!` over the giver's head, a gold dot on the compass, a circle on
 * the big map and a register in the phone. What none of them says is a
 * **sentence**. A player who cannot see a `!` from where they are standing has
 * to open something, read a picture, and infer. `game/questareas.ts` got half
 * way there by clustering the dots into circles you could decide to walk to;
 * this is the other half, which is that a circle at the city zoom is a grey ring
 * over an unlabelled suburb and *Redfern, four jobs, 2.1 km* is a plan.
 *
 * ## A hub is a place, and the place is a railway station
 *
 * The names are not in the content and deliberately are not going into it. A
 * quest pack is written by a person into a textarea and every field on it is one
 * more thing that can be wrong, stale, or disagree with where the giver actually
 * ended up after `place-nudge` moved him eleven metres. The city already has a
 * canonical list of three hundred and sixty-one named places with coordinates,
 * loaded before any of this runs, that Sydneysiders use for exactly this purpose
 * in exactly this way: `rail.bin`'s stations. Nobody in this city says "the
 * northern part of the Redfern-Alexandria border". They say Redfern.
 *
 * So a hub borrows the name of the nearest station, and the whole naming rule is
 * two lines. It costs the content nothing, it cannot go stale, and it is right
 * about a city where a suburb boundary is a council fact and a station is a
 * place you can be.
 *
 * ## The names are assigned station-first, not player-first
 *
 * Two clusters can sit near one station, and only one of them may be called
 * Redfern. The tempting tie-break is "the hub nearest the player wins", and it
 * is wrong in the way that is hardest to see in a screenshot and most obvious in
 * play: walk past both and the names **swap**, so the job you were told was at
 * Redfern is now at Erskineville and the one you ignored is at Redfern.
 *
 * The tie-break here is therefore the hub's own distance to the station, which
 * no amount of walking changes. A hub forty metres from the platform is Redfern
 * and the one nine hundred metres away takes its second choice. Sorting for the
 * *caller* by distance happens after, on a list whose names are already fixed.
 *
 * ## Every giver is a destination, which is the one place this differs from the map
 *
 * `questAreas` will not make an area out of a lone giver -- correctly, because
 * the map already draws him as a mark and a circle around one mark says nothing.
 * This asks the same clusterer with `minMembers` of 1, because the question here
 * is not "what is worth drawing a ring around" but "where is the nearest work",
 * and one bloke outside Kogarah station is a perfectly good answer to that.
 */

import { questAreas } from './questareas.ts';

/** How far apart two givers may be and still be one hub, metres. */
export const HUB_LINK_M = 380;

/**
 * How far a hub may be from a station and still borrow its name, metres.
 *
 * Generous, because the alternative to a slightly-wrong name is no name, and
 * *"Macquarie Park, 3 jobs"* is useful even standing a kilometre up the road
 * from the platform. Past this a hub is unnamed and the callers fall back to a
 * bearing and a distance, which is what a compass has always given.
 */
export const HUB_NAME_REACH_M = 1800;

/** One giver, as this file needs him. `game/givermap.GiverDot` satisfies it. */
export interface HubGiver {
  x: number;
  z: number;
  /** `true` for a `?` -- a job of yours to hand in -- and `false` for a `!`. */
  turnin: boolean;
}

/** Somewhere with a name. `rail.bin`'s stations satisfy it. */
export interface NamedPlace {
  name: string;
  x: number;
  z: number;
}

/** A place worth walking to, and why. */
export interface QuestHub {
  x: number;
  z: number;
  radiusM: number;
  /** Givers here with a job to give. */
  offers: number;
  /** Givers here holding a job of yours that is finished. */
  turnins: number;
  /** The station this borrows, or `''` if there is none within reach. */
  name: string;
  /** Metres from where the player was standing when this was built. */
  distanceM: number;
  /**
   * Which of the givers handed in fell here, as indices into that array.
   *
   * `game/questlog.ts` groups the job list by hub and needs to get from a hub
   * back to the people in it. Carried rather than recovered by a second
   * distance test next door, on the rule the naming is already under: two
   * answers to "who is at Redfern" is one answer too many.
   */
  members: number[];
}

/**
 * Cluster givers into named hubs, nearest first.
 *
 * Pure and allocation-heavy, which is fine and is the reason `main.ts` runs it
 * on a slow beat rather than a frame: the input is at most a few hundred givers
 * and the output is read by a tracker that redraws when its text changes.
 */
export function questHubs(
  givers: readonly HubGiver[],
  places: readonly NamedPlace[],
  px: number,
  pz: number,
  linkM: number = HUB_LINK_M,
): QuestHub[] {
  const areas = questAreas(givers, linkM, 1);
  if (areas.length === 0) return [];

  // --- Name them, station-first. See the header.
  //
  // For each hub, every station inside reach, nearest first. Then hubs are
  // served in order of how good their best claim is, so the cluster on the
  // platform gets the platform's name and the one up the road does not take it
  // from underneath them.
  type Claim = { hub: number; ranked: number[]; best: number };
  const claims: Claim[] = [];
  for (let h = 0; h < areas.length; h++) {
    const a = areas[h];
    const within: Array<{ i: number; d: number }> = [];
    for (let i = 0; i < places.length; i++) {
      const dx = places[i].x - a.x;
      const dz = places[i].z - a.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d <= HUB_NAME_REACH_M) within.push({ i, d });
    }
    // Ties broken on the name so two stations at the same distance -- which
    // happens on an interchange -- resolve the same way in every process.
    within.sort((u, v) => u.d - v.d || (places[u.i].name < places[v.i].name ? -1 : 1));
    claims.push({
      hub: h,
      ranked: within.map((w) => w.i),
      best: within.length > 0 ? within[0].d : Infinity,
    });
  }
  claims.sort((u, v) => u.best - v.best || u.hub - v.hub);

  const taken = new Set<number>();
  const names = new Array<string>(areas.length).fill('');
  for (const claim of claims) {
    for (const i of claim.ranked) {
      if (taken.has(i)) continue;
      taken.add(i);
      names[claim.hub] = places[i].name;
      break;
    }
  }

  // --- And out, with the counts the name is worth having next to.
  const out: QuestHub[] = [];
  for (let h = 0; h < areas.length; h++) {
    const a = areas[h];
    let offers = 0;
    let turnins = 0;
    for (const i of a.members) {
      if (givers[i].turnin) turnins++;
      else offers++;
    }
    const dx = a.x - px;
    const dz = a.z - pz;
    out.push({
      x: a.x,
      z: a.z,
      radiusM: a.radiusM,
      offers,
      turnins,
      name: names[h],
      distanceM: Math.sqrt(dx * dx + dz * dz),
      members: a.members,
    });
  }
  // Nearest first: every caller wants "where should I go" and none of them want
  // "which is biggest". Ties on position, so the order is stable.
  out.sort((a, b) => a.distanceM - b.distanceM || a.x - b.x || a.z - b.z);
  return out;
}

/**
 * The hub the player should be sent to, or null.
 *
 * **A hand-in outranks a nearer offer**, which is WoW's own ordering and is
 * `questmodel.markerFor`'s: a `?` is a reward already earned and a `!` is work
 * not yet started, and a player holding a finished job wants to be paid before
 * they are sold anything. Beyond that it is simply the nearest.
 */
export function nearestHub(hubs: readonly QuestHub[]): QuestHub | null {
  let best: QuestHub | null = null;
  for (const h of hubs) {
    if (h.offers === 0 && h.turnins === 0) continue;
    if (best === null) {
      best = h;
      continue;
    }
    const bestPays = best.turnins > 0;
    const hPays = h.turnins > 0;
    if (hPays !== bestPays) {
      if (hPays) best = h;
      continue;
    }
    if (h.distanceM < best.distanceM) best = h;
  }
  return best;
}

/**
 * What a hub is called on screen when it has no station: a bearing, not a blank.
 *
 * Eight points rather than sixteen, because this is read at a glance off a strip
 * of HUD and *north-east* is a direction a player can act on where *east
 * north-east* is a number they have to think about.
 */
export function hubBearingWord(dx: number, dz: number): string {
  // Screen-space north is -z, this world's convention everywhere else.
  const words = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  const angle = Math.atan2(dx, -dz);
  const turn = angle / (Math.PI * 2);
  const wrapped = turn - Math.floor(turn);
  return words[Math.round(wrapped * 8) % 8];
}

/** `4 jobs`, `1 job`, `2 to hand in`. One place, so every screen agrees. */
export function hubCountText(hub: QuestHub): string {
  const parts: string[] = [];
  if (hub.turnins > 0) parts.push(`${hub.turnins} to hand in`);
  if (hub.offers > 0) parts.push(`${hub.offers} job${hub.offers === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/** Metres to something a player can read. Shared by the tracker and the log. */
export function hubRangeText(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(metres < 10000 ? 1 : 0)} km`;
}

export function verifyQuestHubs(): string[] {
  const failures: string[] = [];
  const places: NamedPlace[] = [
    { name: 'Redfern', x: 0, z: 0 },
    { name: 'Erskineville', x: 1200, z: 0 },
    { name: 'Kogarah', x: 20000, z: 0 },
  ];

  // --- The counts split, and the name comes off the station.
  {
    const hubs = questHubs(
      [
        { x: 10, z: 0, turnin: false },
        { x: 40, z: 0, turnin: false },
        { x: 70, z: 0, turnin: true },
      ],
      places,
      0,
      0,
    );
    if (hubs.length !== 1) failures.push(`Three givers together made ${hubs.length} hubs.`);
    else {
      if (hubs[0].name !== 'Redfern') failures.push(`The hub by Redfern station is called "${hubs[0].name}".`);
      if (hubs[0].offers !== 2) failures.push(`The hub counted ${hubs[0].offers} offers, not 2.`);
      if (hubs[0].turnins !== 1) failures.push(`The hub counted ${hubs[0].turnins} hand-ins, not 1.`);
      if (hubCountText(hubs[0]) !== '1 to hand in, 2 jobs') {
        failures.push(`The hub reads "${hubCountText(hubs[0])}"; the hand-in leads.`);
      }
    }
  }

  // --- THE ONE THAT MATTERS. Names do not move when the player does.
  {
    const givers: HubGiver[] = [
      { x: 20, z: 0, turnin: false },
      { x: 60, z: 0, turnin: false },
      { x: 800, z: 0, turnin: false },
      { x: 840, z: 0, turnin: false },
    ];
    const near = questHubs(givers, places, 0, 0);
    const far = questHubs(givers, places, 5000, 0);
    const nameAt = (hs: QuestHub[], x: number): string => {
      for (const h of hs) if (Math.abs(h.x - x) < 60) return h.name;
      return '(none)';
    };
    if (nameAt(near, 40) !== nameAt(far, 40) || nameAt(near, 820) !== nameAt(far, 820)) {
      failures.push(
        'Walking past two hubs renamed them: ' +
          `${nameAt(near, 40)}/${nameAt(near, 820)} became ${nameAt(far, 40)}/${nameAt(far, 820)}.`,
      );
    }
    if (nameAt(near, 40) !== 'Redfern') {
      failures.push(`The hub on the platform is called "${nameAt(near, 40)}"; the one up the road took the name.`);
    }
    if (nameAt(near, 820) === 'Redfern') failures.push('Two hubs are both called Redfern.');
  }

  // --- Out of reach of everything is unnamed rather than wrongly named.
  {
    const hubs = questHubs([{ x: 50000, z: 50000, turnin: false }], places, 0, 0);
    if (hubs.length !== 1 || hubs[0].name !== '') {
      failures.push(`A giver forty kilometres from any station was called "${hubs[0]?.name}".`);
    }
  }

  // --- A lone giver is a hub here, unlike on the map.
  {
    if (questHubs([{ x: 10, z: 10, turnin: false }], places, 0, 0).length !== 1) {
      failures.push('A lone giver produced no hub; he is still somewhere to walk to.');
    }
  }

  // --- Nearest first, and a hand-in outranks a nearer offer.
  {
    const hubs = questHubs(
      [
        { x: 100, z: 0, turnin: false },
        { x: 3000, z: 0, turnin: true },
      ],
      places,
      0,
      0,
    );
    if (hubs.length !== 2 || hubs[0].distanceM > hubs[1].distanceM) {
      failures.push('The hubs are not sorted nearest first.');
    }
    const pick = nearestHub(hubs);
    if (pick === null || pick.turnins === 0) {
      failures.push('The player was sent to a new job while holding a finished one three kilometres away.');
    }
  }

  // --- The members come back and point at the givers that were handed in.
  {
    const givers: HubGiver[] = [
      { x: 10, z: 0, turnin: false },
      { x: 40, z: 0, turnin: true },
      { x: 9000, z: 0, turnin: false },
    ];
    const hubs = questHubs(givers, places, 0, 0);
    let seen = 0;
    for (const h of hubs) {
      seen += h.members.length;
      for (const i of h.members) {
        if (givers[i] === undefined) failures.push(`A hub named giver ${i}, who is not in the list.`);
      }
      const turnins = h.members.filter((i) => givers[i].turnin).length;
      if (turnins !== h.turnins) failures.push(`A hub counted ${h.turnins} hand-ins but its members hold ${turnins}.`);
    }
    if (seen !== givers.length) failures.push(`${givers.length} givers, ${seen} of them reachable through a hub.`);
  }

  // --- Nothing to do is null rather than a hub with nothing in it.
  if (nearestHub([]) !== null) failures.push('An empty city produced somewhere to go.');

  // --- The bearing words, at the four corners.
  {
    const cases: Array<[number, number, string]> = [
      [0, -100, 'north'],
      [100, 0, 'east'],
      [0, 100, 'south'],
      [-100, 0, 'west'],
      [100, -100, 'north-east'],
    ];
    for (const [dx, dz, want] of cases) {
      const got = hubBearingWord(dx, dz);
      if (got !== want) failures.push(`A bearing of (${dx}, ${dz}) reads "${got}", not "${want}".`);
    }
  }

  // --- The range text, at the two seams.
  {
    const cases: Array<[number, string]> = [[0, '0 m'], [999, '999 m'], [1000, '1.0 km'], [12345, '12 km']];
    for (const [m, want] of cases) {
      const got = hubRangeText(m);
      if (got !== want) failures.push(`${m} m reads "${got}", not "${want}".`);
    }
  }

  return failures;
}
