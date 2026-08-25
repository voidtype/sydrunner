/**
 * Where the work is, drawn as a place rather than a pin.
 *
 * ---------------------------------------------------------------------------
 * ## Why the map needed this
 *
 * The big map already draws every giver in reach as a gold `!`, which answers
 * "is there a job *there*" for somewhere you are already looking at. It does not
 * answer the question a player actually has, which is **"where should I go"** --
 * and at the city zoom, where that question is asked, the individual marks are
 * three pixels of gold scattered over sixty kilometres.
 *
 * The owner put it plainly after an evening in the game he wrote: *"i saw Ray,
 * but now have nothing to do... unsure where im meant to go, and im the
 * developer."* A register that lists jobs and a map that dots givers are both
 * correct and neither of them says *go to Redfern*.
 *
 * So the marks are clustered into areas. An area is a place a player can decide
 * to walk to, it survives being drawn at any zoom -- a cluster is a circle in
 * world metres, so zooming out shrinks it on screen exactly as the city does --
 * and it is computed only from givers the map was already going to draw, so it
 * can never point at work the player cannot take.
 *
 * ## Single-link, and the link distance is a walk
 *
 * Two givers belong to the same area when a player would think of them as the
 * same errand, which is a distance rather than a density: `LINK_M` is 320 m,
 * about four blocks, and chains transitively so a strip of givers down a road is
 * one area rather than three. There are at most a hundred-odd givers in a room,
 * so the naive pass is a few thousand comparisons and needs no grid.
 *
 * `MIN_MEMBERS` is 2 because a lone giver is already drawn as a `!` and drawing
 * a circle round him says nothing the mark did not.
 */

/** How far apart two givers may be and still be the same errand, metres. */
export const LINK_M = 320;

/** Fewer than this is a giver, not an area. */
export const MIN_MEMBERS = 2;

/** A drawn area has at least this radius, so a tight pair is still a target. */
export const MIN_RADIUS_M = 90;

/** What the map draws. Centre and radius are world metres. */
export interface QuestArea {
  x: number;
  z: number;
  radiusM: number;
  count: number;
}

export interface AreaPoint {
  x: number;
  z: number;
}

/**
 * Cluster `points` into areas.
 *
 * Sorted by `count` descending so a caller drawing only the first few draws the
 * busiest, and ties broken on position so the order is stable frame to frame --
 * a label that swaps places with another label every time the map redraws is
 * worse than no label.
 */
export function questAreas(
  points: readonly AreaPoint[],
  linkM: number = LINK_M,
  minMembers: number = MIN_MEMBERS,
): QuestArea[] {
  const n = points.length;
  if (n === 0) return [];
  const owner = new Int32Array(n);
  for (let i = 0; i < n; i++) owner[i] = i;
  const find = (a: number): number => {
    let r = a;
    while (owner[r] !== r) r = owner[r];
    while (owner[a] !== r) {
      const next = owner[a];
      owner[a] = r;
      a = next;
    }
    return r;
  };
  const link2 = linkM * linkM;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = points[i].x - points[j].x;
      const dz = points[i].z - points[j].z;
      if (dx * dx + dz * dz > link2) continue;
      const a = find(i);
      const b = find(j);
      if (a !== b) owner[a] = b;
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const g = groups.get(root);
    if (g === undefined) groups.set(root, [i]);
    else g.push(i);
  }

  const out: QuestArea[] = [];
  for (const members of groups.values()) {
    if (members.length < minMembers) continue;
    let sx = 0;
    let sz = 0;
    for (const i of members) {
      sx += points[i].x;
      sz += points[i].z;
    }
    const cx = sx / members.length;
    const cz = sz / members.length;
    // The radius reaches the furthest member rather than a standard deviation:
    // the circle is a promise that the work is inside it, and a circle that
    // excludes a giver it counted is a lie a player walks into.
    let worst = 0;
    for (const i of members) {
      const dx = points[i].x - cx;
      const dz = points[i].z - cz;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > worst) worst = d;
    }
    out.push({ x: cx, z: cz, radiusM: Math.max(MIN_RADIUS_M, worst), count: members.length });
  }
  out.sort((a, b) => b.count - a.count || a.x - b.x || a.z - b.z);
  return out;
}

export function verifyQuestAreas(): string[] {
  const failures: string[] = [];

  if (questAreas([]).length !== 0) failures.push('An empty world produced an area.');
  if (questAreas([{ x: 0, z: 0 }]).length !== 0) {
    failures.push('A lone giver became an area; he is already drawn as a mark.');
  }

  // --- Two close givers are one area, and it covers both.
  {
    const areas = questAreas([
      { x: 0, z: 0 },
      { x: 100, z: 0 },
    ]);
    if (areas.length !== 1) failures.push(`Two givers 100 m apart made ${areas.length} areas.`);
    else {
      const a = areas[0];
      if (a.count !== 2) failures.push(`The area counted ${a.count} givers, not 2.`);
      if (Math.abs(a.x - 50) > 1e-9) failures.push(`The area centred on ${a.x}, not between them.`);
      for (const p of [{ x: 0, z: 0 }, { x: 100, z: 0 }]) {
        const d = Math.hypot(p.x - a.x, p.z - a.z);
        if (d > a.radiusM + 1e-9) failures.push('The area excluded a giver it counted; the circle is a promise.');
      }
    }
  }

  // --- Two distant groups stay two areas.
  {
    const areas = questAreas([
      { x: 0, z: 0 },
      { x: 120, z: 0 },
      { x: 9000, z: 0 },
      { x: 9120, z: 0 },
    ]);
    if (areas.length !== 2) failures.push(`Two groups nine kilometres apart made ${areas.length} areas.`);
  }

  // --- The chain: a strip down a road is one errand, not three.
  {
    const strip = [0, 300, 600, 900, 1200].map((x) => ({ x, z: 0 }));
    const areas = questAreas(strip);
    if (areas.length !== 1) failures.push(`A strip of givers 300 m apart made ${areas.length} areas rather than chaining into one.`);
    else if (areas[0].count !== 5) failures.push(`The chained area counted ${areas[0].count}, not 5.`);
  }

  // --- Busiest first, and stable.
  {
    const areas = questAreas([
      { x: 0, z: 0 },
      { x: 100, z: 0 },
      { x: 9000, z: 0 },
      { x: 9100, z: 0 },
      { x: 9200, z: 0 },
    ]);
    if (areas.length !== 2) failures.push(`Expected two areas, got ${areas.length}.`);
    else {
      if (areas[0].count < areas[1].count) failures.push('The areas are not sorted busiest first.');
      const again = questAreas([
        { x: 9200, z: 0 },
        { x: 100, z: 0 },
        { x: 9000, z: 0 },
        { x: 0, z: 0 },
        { x: 9100, z: 0 },
      ]);
      if (again.length !== areas.length || again[0].count !== areas[0].count || Math.abs(again[0].x - areas[0].x) > 1e-9) {
        failures.push('The same givers in a different order produced a different first area; the labels would swap on every redraw.');
      }
    }
  }

  // --- A tight pair still gets something worth aiming at.
  {
    const areas = questAreas([
      { x: 0, z: 0 },
      { x: 4, z: 0 },
    ]);
    if (areas.length !== 1 || areas[0].radiusM < MIN_RADIUS_M) {
      failures.push('Two givers standing together produced an area too small to see or aim at.');
    }
  }

  return failures;
}
