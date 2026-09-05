/**
 * Where the lights on the Harbour Bridge go, worked out from the bridge itself.
 *
 * The owner, in five words: *"bridge also needs to be illuminated at night"*.
 * He is right, and he is right about the one landmark in this world that is
 * *only* a silhouette after dark. Everything else on the skyline lights itself:
 * `facade.ts` brings up a hashed third of thirty thousand windows, the Opera
 * House catches the CBD's own glow off `landmark_shell`, and the tower's turret
 * is a lit band by construction. The bridge is fifty thousand tonnes of painted
 * steel with no windows in it. At `HEMISPHERE_NIGHT` it is a hole in the sky
 * exactly the shape of the thing a player crossed the harbour to look at.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE READS THE MODEL INSTEAD OF THE PIPELINE.
 *
 * The obvious way to hang a light on a bridge is to bake the positions: a
 * `bridge_lights` block in `index.json`, written by `pipeline/sydney/
 * landmarks.py` beside the geometry it already emits, fetched with the rest of
 * the world. That is one more sidecar, one more contract, one more thing a
 * world built yesterday does not have -- and `world/landmarks.ts`'s header is
 * explicit that the index and the world directory outlive any one pipeline run.
 * A night feature that needed a retile to appear would not appear.
 *
 * It is also unnecessary, because **the arch is already in the file**. The
 * `landmark_steel` primitive is 11,328 vertices of the real structure, built to
 * real dimensions and audited against them (`index.json`'s `harbour_bridge.
 * audit`: a 503 m span, a 134 m apex AHD, a deck at 49). The top chord of each
 * arch is not a number somebody has to publish; it is the highest steel there
 * is, and finding it is twenty lines of arithmetic over an array this client has
 * already downloaded. So the whole of this module is pure functions over the
 * three primitives' position attributes, and it is three-free so that both boot
 * lists can run `verifyBridgeLights` against a synthetic bridge with no GLB, no
 * renderer and no network anywhere near it.
 *
 * ---------------------------------------------------------------------------
 * HOW THE TOP CHORD IS FOUND, WHICH IS THE WHOLE TRICK.
 *
 * 1. **The axis, by principal component rather than by bounding box.** The
 *    bridge runs 26.6 degrees off north -- `audit.axis_east` 0.448,
 *    `axis_north` 0.894 -- so its axis-aligned bounding box is 715 m by 1361 m
 *    and its *long box side* is Z, which is a quarter turn away from the answer.
 *    Binning along Z would smear each 8 m bin across 4 m of the structure's
 *    width and would put the two arches in the same bin at the ends. The 2x2
 *    covariance of (x, z) has a closed-form dominant eigenvector, it costs one
 *    pass and one square root, and on the shipped GLB it recovers
 *    (-0.4482, 0.8940) -- the manifest's axis to four decimal places, from
 *    vertices alone. That agreement is what says the derivation is reading the
 *    bridge and not the bounding box, and `verifyBridgeLights` re-derives it
 *    from a synthetic bridge laid on a deliberately awkward bearing.
 *
 * 2. **Bin along the axis; the highest vertex in a bin is on the top chord.**
 *    An arch truss has two chords, upper and lower, and every diagonal and
 *    vertical between them. Taken over a bin 8 m wide, the highest vertex is on
 *    the upper one, always, because that is what "upper" means. No fitting, no
 *    parameters, no assumption about the arch being a parabola or a catenary --
 *    which matters, because it is neither.
 *
 * 3. **Two arches, so bin by the sign of the across coordinate as well.** The
 *    two trusses stand 30.5 m apart either side of the deck's centreline. One
 *    string of bins would zig-zag between them; two runs of the same loop, one
 *    per side, give two strings that each stay on their own arch. The across
 *    offset each string is finally drawn at is the *mean* of its own bins'
 *    across coordinates, not the per-bin value -- a chord is a smooth line and
 *    the truss is 4.3 m deep, so taking each bin's own t would wobble the string
 *    across the width of the box section.
 *
 * 4. **Reject the deck.** Outside the 503 m span there is no arch: the highest
 *    steel over the approaches is the deck parapet, at the deck's own level, and
 *    a naive highest-per-bin string runs 1.5 km along the parapet with a hump in
 *    the middle. The discriminator is the *median* of the per-bin heights --
 *    over a 1,499 m structure with a 503 m arch, the median bin is a deck bin by
 *    construction -- and a bin joins the chord only if it stands
 *    `ARCH_LIFT_M` above it. Nothing here is a world coordinate or an audited
 *    number; it is the model measured against itself, so it survives a retile
 *    that moves the datum.
 *
 * 5. **Then resample.** The kept bins are not evenly spaced along the chord --
 *    the steel is prisms, so a bin only has a vertex where a prism ends, and on
 *    the shipped model 33 bins of a possible 50 are occupied. Walking the kept
 *    bins as a polyline and stepping `ARCH_PITCH_M` of *arc length* along it
 *    fills the gaps and gives a string with even spacing up a chord that is
 *    nearly vertical at the springing and flat at the apex. Spacing by `s`
 *    instead would bunch the lamps at the crown and strand them at the ends.
 *
 * ---------------------------------------------------------------------------
 * THE DECK, AND THE ONE NUMBER THIS FILE CHECKS AGAINST THE MANIFEST.
 *
 * The roadway lamps are the same idea over `landmark_asphalt`: bin along the
 * axis at `DECK_PITCH_M`, take the highest asphalt in each bin, stand a
 * `LAMP_COLUMN_M` column on it, and put a lamp on each kerb at the bin's own
 * half width less `KERB_INSET_M`. Deriving the height per bin rather than
 * writing `sea_level_y + 49 + 9` once is what gets the **approaches** right:
 * the 1,499 m of roadway is 1,200 m of level deck with a ramp falling 1.66 m
 * per bin off each end, and a fixed height would leave the last lamp on the
 * southern ramp floating 13 m over the road at Millers Point.
 *
 * On the level deck the derivation lands at exactly `sea_level_y + 49 +
 * LAMP_COLUMN_M`, because the level deck *is* 49 m AHD -- and that identity is
 * the assertion in `verifyNightLights`. It is the useful direction to check in:
 * the audit number is the published fact and the derivation is the thing that
 * can silently drift, so the check is "does reading the model give the published
 * answer", not "did somebody type 49".
 *
 * ---------------------------------------------------------------------------
 * THE PYLONS.
 *
 * Four towers of Moruya trachyte, and in the `landmark_granite` primitive they
 * are the only stone above the roadway -- everything else in that slot is pier
 * and abutment, and all of it is under the deck. So: take the granite above the
 * deck, cluster it in plan, and four clusters fall out (27.5 m by 17.2 m each,
 * rising to 17.93 in world y, which is 89.0 AHD, which is `audit.pylon_top_ahd`
 * to two decimal places). Each cluster gives four faces and each face gets one
 * upward wash. Nothing here counts to four or asserts four; it reports what it
 * finds, and a model that changed how many pylons it draws would light however
 * many it now has.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS NOT.
 *
 * It draws nothing and it owns no light. Every number it returns is fed to
 * `world/nightlights.BridgeLights`, which turns it into one additive geometry
 * over one material in one static mesh, gated on the same `nightOpacity`
 * uniform as every other sprite in the city; and the deck lamps' positions go to
 * the night rig as `LampSource` records so that the **two real point lights that
 * already exist** walk onto the bridge when a player does. There is no eighth
 * light here. `world/nightlights.ts`'s header and `world/giverlamp.ts` carry
 * that argument in full, and this file is another reader of it.
 */

/** Bin width along the axis when hunting for the top chord, metres. */
export const ARCH_BIN_M = 8;
/** Sprite pitch along the chord itself, by arc length. */
export const ARCH_PITCH_M = 8;
/**
 * How far above the deck plateau a bin has to stand to count as arch.
 *
 * Six metres, and the number is a *clearance* rather than a threshold: the
 * parapet stands 1.25 m over the deck (`audit.parapet_height_m`) and the arch's
 * own springing rises out of the deck continuously, so anything smaller admits
 * the parapet and anything much larger clips the first two lamps off each end of
 * the string. On the shipped model the lowest bin it keeps is 6.1 m of steel
 * above the roadway, which is a lamp on the arch and not on the handrail.
 */
export const ARCH_LIFT_M = 6;
/** Bins shorter than this many kept in a row are not an arch; they are a crane. */
export const ARCH_MIN_BINS = 3;
/** A run may skip this many empty bins and still be one chord. */
export const ARCH_MAX_GAP_BINS = 3;
/** A hard ceiling on the string, so a pathological model cannot ask for a million sprites. */
export const ARCH_MAX_SPRITES = 400;

/** Lamp to lamp along the roadway. A motorway column pitch, and the brief's. */
export const DECK_PITCH_M = 30;
/** How tall the column is. The lamp head is this far over the road under it. */
export const LAMP_COLUMN_M = 9;
/** How far inside the deck's own edge a kerb lamp stands. */
export const KERB_INSET_M = 1.6;
/** x, y, z, kerb sign. */
export const DECK_LAMP_FLOATS = 4;

/** Plan radius within which two granite vertices are the same pylon. */
export const PYLON_CLUSTER_M = 40;
/** Fewer vertices than this above the deck is not a pylon. */
export const PYLON_MIN_VERTICES = 8;
/** How far above the deck a granite vertex has to be before it is pylon rather than pier. */
export const PYLON_LIFT_M = 1;

/**
 * Floats per `LampSource` record: x, y, z, sodium.
 *
 * Must equal `nightlights.LAMP_RECORD_STRIDE`, which this file cannot import --
 * that one is three-bound and this one is on the server's boot list.
 * `verifyNightLights` imports both and asserts they agree, exactly as
 * `verifyTunnelLights` does for `stationlamps.STATION_LAMP_RECORD_STRIDE`.
 */
export const BRIDGE_LAMP_RECORD_STRIDE = 4;

/**
 * The structure's own frame: a centroid in plan and a unit vector along it.
 *
 * `(ax, az)` is along the bridge and `(-az, ax)` is across it, so the two
 * conversions are
 *
 *     s = (x - cx) * ax + (z - cz) * az       t = -(x - cx) * az + (z - cz) * ax
 *     x = cx + s * ax - t * az                z = cz + s * az + t * ax
 *
 * and every function below works in `(s, t, y)` and converts back at the end.
 */
export interface PlanAxis {
  cx: number;
  cz: number;
  ax: number;
  az: number;
}

/** One arch's top chord: a polyline of world x, y, z triples. */
export interface ArchChord {
  /** +1 or -1: which side of the centreline this truss stands on. */
  side: number;
  /** The across offset the string was finally drawn at, signed. */
  across: number;
  /** Sprite positions, three floats each, from one springing to the other. */
  points: Float32Array<ArrayBuffer>;
}

/** One face of one pylon, as the wash quad that stands on it needs it. */
export interface PylonFace {
  /** The middle of the face at the deck, in world metres. */
  x: number;
  z: number;
  /** From the roadway to the top of the stone. */
  baseY: number;
  topY: number;
  /** Outward unit normal in plan. */
  nx: number;
  nz: number;
  /** Along the face in plan, unit, and how far the face runs each way from the centre. */
  fx: number;
  fz: number;
  half: number;
}

/** Everything `world/nightlights.BridgeLights` needs, and nothing it does not. */
export interface BridgeLightPlan {
  axis: PlanAxis;
  chords: ArchChord[];
  /** `DECK_LAMP_FLOATS` per lamp: x, y, z, kerb sign. */
  deck: Float32Array<ArrayBuffer>;
  /** World y of the highest roadway there is: the level deck. */
  deckTopY: number;
  pylons: PylonFace[];
}

/**
 * The dominant direction of a point cloud in plan, by closed-form eigenvector of
 * the 2x2 covariance.
 *
 * Returned with an arbitrary but *stable* sign -- the eigenvector of a line has
 * two of them and nothing here can prefer one, so every consumer below is
 * written to be indifferent to it. `archChords` is symmetric under a flip
 * because it bins both signs of `t`, and the deck's lamps come out in the other
 * order along the roadway, which no one can see.
 */
export function planAxis(positions: ArrayLike<number>): PlanAxis {
  const n = positions.length / 3;
  if (n < 2) return { cx: 0, cz: 0, ax: 1, az: 0 };
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += positions[i * 3];
    cz += positions[i * 3 + 2];
  }
  cx /= n;
  cz /= n;
  let sxx = 0;
  let sxz = 0;
  let szz = 0;
  for (let i = 0; i < n; i++) {
    const dx = positions[i * 3] - cx;
    const dz = positions[i * 3 + 2] - cz;
    sxx += dx * dx;
    sxz += dx * dz;
    szz += dz * dz;
  }
  sxx /= n;
  sxz /= n;
  szz /= n;
  // The larger root of the characteristic polynomial, then its eigenvector.
  // `(sxz, l1 - sxx)` is in the kernel of `(C - l1 I)` whenever `sxz` is not
  // zero; when it is, the covariance is already diagonal and the answer is
  // whichever axis carries more variance.
  const trace = sxx + szz;
  const detC = sxx * szz - sxz * sxz;
  const disc = Math.max(0, (trace * trace) / 4 - detC);
  const l1 = trace / 2 + Math.sqrt(disc);
  let ax = sxz;
  let az = l1 - sxx;
  if (Math.abs(sxz) < 1e-12) {
    ax = sxx >= szz ? 1 : 0;
    az = sxx >= szz ? 0 : 1;
  }
  const len = Math.sqrt(ax * ax + az * az);
  if (!(len > 1e-12)) return { cx, cz, ax: 1, az: 0 };
  return { cx, cz, ax: ax / len, az: az / len };
}

/** One vertex in the structure's frame. Allocated once per call site, not per vertex. */
interface Local {
  s: number;
  t: number;
  y: number;
}

function project(axis: PlanAxis, x: number, z: number, y: number, out: Local): Local {
  const dx = x - axis.cx;
  const dz = z - axis.cz;
  out.s = dx * axis.ax + dz * axis.az;
  out.t = -dx * axis.az + dz * axis.ax;
  out.y = y;
  return out;
}

/** The median of a numeric array. Sorts a copy; these are tens of entries. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[sorted.length >> 1];
}

/**
 * The two arches' top chords, as sprite positions in world metres.
 *
 * Empty when the steel has no arch in it -- a model with a flat deck and nothing
 * over it returns nothing rather than a string of lamps along its parapet, which
 * is the failure this whole function is arranged to avoid. See the header's
 * step 4.
 */
export function archChords(steel: ArrayLike<number>, axis: PlanAxis): ArchChord[] {
  const n = steel.length / 3;
  if (n < 4) return [];
  const p: Local = { s: 0, t: 0, y: 0 };

  let sMin = Infinity;
  let sMax = -Infinity;
  for (let i = 0; i < n; i++) {
    project(axis, steel[i * 3], steel[i * 3 + 2], steel[i * 3 + 1], p);
    if (p.s < sMin) sMin = p.s;
    if (p.s > sMax) sMax = p.s;
  }
  if (!(sMax > sMin)) return [];
  const bins = Math.max(1, Math.ceil((sMax - sMin) / ARCH_BIN_M));

  const out: ArchChord[] = [];
  for (const side of [-1, 1]) {
    // The highest vertex in each bin on this side of the centreline, with the
    // across coordinate it was found at. `topT` is only used for the mean; the
    // string itself is drawn at that mean. See the header's step 3.
    const topY = new Float64Array(bins).fill(-Infinity);
    const topS = new Float64Array(bins);
    const topT = new Float64Array(bins);
    for (let i = 0; i < n; i++) {
      project(axis, steel[i * 3], steel[i * 3 + 2], steel[i * 3 + 1], p);
      if (p.t * side <= 0) continue;
      const b = Math.min(bins - 1, Math.max(0, Math.floor((p.s - sMin) / ARCH_BIN_M)));
      if (p.y <= topY[b]) continue;
      topY[b] = p.y;
      topS[b] = p.s;
      topT[b] = p.t;
    }

    const filled: number[] = [];
    for (let b = 0; b < bins; b++) if (topY[b] > -Infinity) filled.push(b);
    if (filled.length < ARCH_MIN_BINS) continue;
    // The deck plateau, and therefore what counts as arch. Over a structure that
    // is mostly deck the median bin is a deck bin, which is exactly the property
    // being leaned on -- see the header's step 4.
    const plateau = median(filled.map((b) => topY[b]));
    const kept = filled.filter((b) => topY[b] > plateau + ARCH_LIFT_M);
    if (kept.length < ARCH_MIN_BINS) continue;

    // The longest run of kept bins that are actually adjacent, so a mast, a
    // crane or a second structure inside the same primitive cannot splice itself
    // onto the end of the arch.
    let bestStart = 0;
    let bestLength = 0;
    let runStart = 0;
    for (let i = 0; i < kept.length; i++) {
      if (i > 0 && kept[i] - kept[i - 1] > ARCH_MAX_GAP_BINS) runStart = i;
      const length = i - runStart + 1;
      if (length > bestLength) {
        bestLength = length;
        bestStart = runStart;
      }
    }
    const run = kept.slice(bestStart, bestStart + bestLength);
    if (run.length < ARCH_MIN_BINS) continue;

    let acrossSum = 0;
    for (const b of run) acrossSum += topT[b];
    const across = acrossSum / run.length;

    // Resample the (s, y) polyline by arc length. See the header's step 5.
    const cumulative = new Float64Array(run.length);
    for (let i = 1; i < run.length; i++) {
      const ds = topS[run[i]] - topS[run[i - 1]];
      const dy = topY[run[i]] - topY[run[i - 1]];
      cumulative[i] = cumulative[i - 1] + Math.sqrt(ds * ds + dy * dy);
    }
    const total = cumulative[run.length - 1];
    const steps = Math.min(ARCH_MAX_SPRITES - 1, Math.max(1, Math.round(total / ARCH_PITCH_M)));
    const points = new Float32Array((steps + 1) * 3);
    let seg = 1;
    for (let k = 0; k <= steps; k++) {
      const d = (total * k) / steps;
      while (seg < run.length - 1 && cumulative[seg] < d) seg++;
      const span = cumulative[seg] - cumulative[seg - 1];
      const f = span > 1e-9 ? Math.min(1, Math.max(0, (d - cumulative[seg - 1]) / span)) : 0;
      const s = topS[run[seg - 1]] + (topS[run[seg]] - topS[run[seg - 1]]) * f;
      const y = topY[run[seg - 1]] + (topY[run[seg]] - topY[run[seg - 1]]) * f;
      points[k * 3] = axis.cx + s * axis.ax - across * axis.az;
      points[k * 3 + 1] = y;
      points[k * 3 + 2] = axis.cz + s * axis.az + across * axis.ax;
    }
    out.push({ side, across, points });
  }
  return out;
}

/**
 * A lamp on each kerb every `DECK_PITCH_M` along the roadway, standing
 * `LAMP_COLUMN_M` over whatever the road does at that station.
 *
 * `DECK_LAMP_FLOATS` per lamp: world x, y, z and the kerb's sign, which is what
 * lets the geometry lean each lamp's pool inboard without re-deriving which side
 * it is on. Ordered along the axis, both kerbs of a station together, so a
 * reader that wants pairs gets them adjacent.
 */
export function deckLamps(asphalt: ArrayLike<number>, axis: PlanAxis): { lamps: Float32Array<ArrayBuffer>; deckTopY: number } {
  const n = asphalt.length / 3;
  const empty = { lamps: new Float32Array(0), deckTopY: -Infinity };
  if (n < 4) return empty;
  const p: Local = { s: 0, t: 0, y: 0 };

  let sMin = Infinity;
  let sMax = -Infinity;
  for (let i = 0; i < n; i++) {
    project(axis, asphalt[i * 3], asphalt[i * 3 + 2], asphalt[i * 3 + 1], p);
    if (p.s < sMin) sMin = p.s;
    if (p.s > sMax) sMax = p.s;
  }
  if (!(sMax > sMin)) return empty;
  // Rounded rather than floored, so the pitch stays within a few centimetres of
  // 30 m across the whole roadway instead of leaving a short bin at one end --
  // over 1,499 m that is 49.97 bins, and flooring would put the last lamp 29 m
  // from the abutment and 0.97 m of deck past it.
  const stations = Math.max(1, Math.round((sMax - sMin) / DECK_PITCH_M));
  const step = (sMax - sMin) / stations;

  const topY = new Float64Array(stations).fill(-Infinity);
  const half = new Float64Array(stations);
  for (let i = 0; i < n; i++) {
    project(axis, asphalt[i * 3], asphalt[i * 3 + 2], asphalt[i * 3 + 1], p);
    const b = Math.min(stations - 1, Math.max(0, Math.floor((p.s - sMin) / step)));
    if (p.y > topY[b]) topY[b] = p.y;
    const across = p.t < 0 ? -p.t : p.t;
    if (across > half[b]) half[b] = across;
  }

  let deckTopY = -Infinity;
  for (let b = 0; b < stations; b++) if (topY[b] > deckTopY) deckTopY = topY[b];

  const lamps: number[] = [];
  for (let b = 0; b < stations; b++) {
    if (topY[b] === -Infinity) continue;
    const kerb = half[b] - KERB_INSET_M;
    // A carriageway narrower than the inset has no kerb to stand a column on.
    // Nothing in this bake is, and a lamp inside the parapet is worse than none.
    if (!(kerb > 0)) continue;
    const s = sMin + (b + 0.5) * step;
    const y = topY[b] + LAMP_COLUMN_M;
    for (const side of [-1, 1]) {
      const t = kerb * side;
      lamps.push(
        axis.cx + s * axis.ax - t * axis.az,
        y,
        axis.cz + s * axis.az + t * axis.ax,
        side,
      );
    }
  }
  return { lamps: new Float32Array(lamps), deckTopY };
}

/**
 * The pylons' faces, from the only stone that stands above the roadway.
 *
 * The clustering is a running-mean single pass rather than anything cleverer,
 * because there are four towers 565 m apart and 49 m across the deck, and
 * `PYLON_CLUSTER_M` at 40 m is nowhere near either separation. It reports what
 * it finds; see the header.
 */
export function pylonFloods(granite: ArrayLike<number>, axis: PlanAxis, deckTopY: number): PylonFace[] {
  const n = granite.length / 3;
  if (n < 4 || !Number.isFinite(deckTopY)) return [];
  const p: Local = { s: 0, t: 0, y: 0 };
  interface Cluster {
    sSum: number;
    tSum: number;
    count: number;
    sMin: number;
    sMax: number;
    tMin: number;
    tMax: number;
    yMax: number;
  }
  const clusters: Cluster[] = [];
  for (let i = 0; i < n; i++) {
    project(axis, granite[i * 3], granite[i * 3 + 2], granite[i * 3 + 1], p);
    if (p.y <= deckTopY + PYLON_LIFT_M) continue;
    let hit: Cluster | null = null;
    for (const c of clusters) {
      if (Math.abs(c.sSum / c.count - p.s) > PYLON_CLUSTER_M) continue;
      if (Math.abs(c.tSum / c.count - p.t) > PYLON_CLUSTER_M) continue;
      hit = c;
      break;
    }
    if (hit === null) {
      clusters.push({ sSum: p.s, tSum: p.t, count: 1, sMin: p.s, sMax: p.s, tMin: p.t, tMax: p.t, yMax: p.y });
      continue;
    }
    hit.sSum += p.s;
    hit.tSum += p.t;
    hit.count++;
    if (p.s < hit.sMin) hit.sMin = p.s;
    if (p.s > hit.sMax) hit.sMax = p.s;
    if (p.t < hit.tMin) hit.tMin = p.t;
    if (p.t > hit.tMax) hit.tMax = p.t;
    if (p.y > hit.yMax) hit.yMax = p.y;
  }

  const faces: PylonFace[] = [];
  for (const c of clusters) {
    if (c.count < PYLON_MIN_VERTICES) continue;
    const s0 = (c.sMin + c.sMax) / 2;
    const t0 = (c.tMin + c.tMax) / 2;
    const halfS = (c.sMax - c.sMin) / 2;
    const halfT = (c.tMax - c.tMin) / 2;
    if (!(halfS > 0.5) || !(halfT > 0.5)) continue;
    // The two ends, normal along the axis; then the two flanks, normal across
    // it. Written as a table of (offset along, offset across, normal, face
    // direction, half length) so the four are one loop and cannot disagree.
    const sides: Array<[number, number, number, number, number, number, number]> = [
      [s0 + halfS, t0, 1, 0, 0, 1, halfT],
      [s0 - halfS, t0, -1, 0, 0, 1, halfT],
      [s0, t0 + halfT, 0, 1, 1, 0, halfS],
      [s0, t0 - halfT, 0, -1, 1, 0, halfS],
    ];
    for (const [s, t, ns, nt, fs, ft, half] of sides) {
      faces.push({
        x: axis.cx + s * axis.ax - t * axis.az,
        z: axis.cz + s * axis.az + t * axis.ax,
        baseY: deckTopY,
        topY: c.yMax,
        nx: ns * axis.ax - nt * axis.az,
        nz: ns * axis.az + nt * axis.ax,
        fx: fs * axis.ax - ft * axis.az,
        fz: fs * axis.az + ft * axis.ax,
        half,
      });
    }
  }
  return faces;
}

/**
 * The whole plan, from the three primitives the GLB already carries.
 *
 * Null when there is nothing to light -- a landmark set that failed to load, a
 * world built before the bridge had a steel primitive, or a model with no arch
 * in it. The caller's contract is `world/landmarks.ts`'s: losing this costs the
 * lights, never the frame.
 */
export function planBridgeLights(
  steel: ArrayLike<number> | null,
  granite: ArrayLike<number> | null,
  asphalt: ArrayLike<number> | null,
): BridgeLightPlan | null {
  if (steel === null || steel.length < 12) return null;
  const axis = planAxis(steel);
  const chords = archChords(steel, axis);
  const { lamps, deckTopY } = asphalt === null ? { lamps: new Float32Array(0), deckTopY: -Infinity } : deckLamps(asphalt, axis);
  const pylons = granite === null ? [] : pylonFloods(granite, axis, deckTopY);
  if (chords.length === 0 && lamps.length === 0 && pylons.length === 0) return null;
  return { axis, chords, deck: lamps, deckTopY, pylons };
}

/**
 * The deck lamps as the night rig's `LampSource` records: x, y, z and a sodium
 * flag of zero.
 *
 * **The deck lamps only**, which is the whole sizing decision. The arch string
 * is a hundred sprites of decoration seen from Balmain and the two real point
 * lights must never pick one of them: they are 60 m over the roadway and 15 m
 * outboard of it, so a real light on one would light the underside of nothing
 * while the player walks the deck in the dark. The kerb columns are the lamps a
 * body actually walks under, and there are about a hundred of them, which is a
 * 400-float array the rig walks six times a second.
 *
 * Zero rather than one on the last float: the Bradfield Highway is white light,
 * not the sodium the older suburbs still wear. See `LAMP_SODIUM_COLOUR`.
 */
export function bridgeLampRecords(lamps: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> {
  const count = Math.floor(lamps.length / DECK_LAMP_FLOATS);
  const out = new Float32Array(count * BRIDGE_LAMP_RECORD_STRIDE);
  for (let i = 0; i < count; i++) {
    const r = i * BRIDGE_LAMP_RECORD_STRIDE;
    const l = i * DECK_LAMP_FLOATS;
    out[r] = lamps[l];
    out[r + 1] = lamps[l + 1];
    out[r + 2] = lamps[l + 2];
    out[r + 3] = 0;
  }
  return out;
}

/* --------------------------------------------------------------------------
 * The self-check.
 * ------------------------------------------------------------------------ */

/** The synthetic bridge the check below is run against. See `verifyBridgeLights`. */
export interface FakeBridge {
  steel: Float32Array<ArrayBuffer>;
  granite: Float32Array<ArrayBuffer>;
  asphalt: Float32Array<ArrayBuffer>;
  /** What it was built from, so the check can compare rather than eyeball. */
  ax: number;
  az: number;
  cx: number;
  cz: number;
  span: number;
  rise: number;
  archAcross: number;
  deckLength: number;
  deckHalfWidth: number;
  deckY: number;
  archFootY: number;
  pylons: number;
  pylonTopY: number;
}

/**
 * A bridge with an arch, a deck and four pylons, on a deliberately awkward
 * bearing, with **two chords per truss**.
 *
 * The lower chord is the load-bearing part of this fixture. A "find the arch"
 * routine that fits the mean, the extremes or the nearest vertex would sail
 * through a fixture with one chord in it and would draw the string down the
 * middle of the truss on the real model. Both parabolas are here, 9 m apart, and
 * the check asserts every sprite is on the upper one.
 *
 * Parabolas rather than circles because nothing in this fixture may use
 * `Math.sin` or `Math.cos`: it runs on both boot lists, and a check that could
 * disagree between two engines' transcendentals is a check that fails on
 * somebody else's machine for no reason at all. See CLAUDE.md's determinism
 * rule.
 */
export function fakeBridge(): FakeBridge {
  const ax = 0.6;
  const az = -0.8;
  const cx = 1234.5;
  const cz = -678.25;
  const span = 400;
  const rise = 60;
  const archAcross = 15.25;
  const archDepth = 9;
  const deckLength = 1200;
  const deckHalfWidth = 24.4;
  const deckY = -22.075;
  const archFootY = deckY + 8;
  const pylonTopY = deckY + 40;

  const steel: number[] = [];
  const asphalt: number[] = [];
  const granite: number[] = [];
  const put = (into: number[], s: number, t: number, y: number): void => {
    into.push(cx + s * ax - t * az, y, cz + s * az + t * ax);
  };

  // --- The two trusses. Sampled at 5.5 m so the 8 m bins are unevenly filled,
  // which is the shipped model's own condition: 33 of 50 bins occupied.
  for (let s = -span / 2; s <= span / 2 + 1e-9; s += 5.5) {
    const f = (2 * s) / span;
    const y = archFootY + rise * (1 - f * f);
    for (const side of [-1, 1]) {
      put(steel, s, archAcross * side, y);
      put(steel, s, archAcross * side, y - archDepth);
      // And a vertical between them, so the primitive is not two clean lines.
      put(steel, s, archAcross * side, y - archDepth / 2);
    }
  }
  // --- The deck parapet, the full length, in steel, at the deck's own level.
  // This is what a naive highest-per-bin string would run along.
  for (let s = -deckLength / 2; s <= deckLength / 2 + 1e-9; s += 4) {
    for (const side of [-1, 1]) put(steel, s, deckHalfWidth * side, deckY + 1.25);
  }
  // --- The roadway, level, at 3 m so a 30 m bin holds ten of it.
  for (let s = -deckLength / 2; s <= deckLength / 2 + 1e-9; s += 3) {
    for (const side of [-1, 1]) put(asphalt, s, deckHalfWidth * side, deckY);
    put(asphalt, s, 0, deckY);
  }
  // --- Four pylons, and a pier under the deck at the centre that must not
  // become a fifth.
  const pylonS = 280;
  const pylonT = 24.7;
  let pylons = 0;
  for (const ss of [-pylonS, pylonS]) {
    for (const tt of [-pylonT, pylonT]) {
      pylons++;
      for (let ds = -13.75; ds <= 13.75 + 1e-9; ds += 13.75 / 2) {
        for (let dt = -8.6; dt <= 8.6 + 1e-9; dt += 8.6 / 2) {
          for (let y = deckY + 2; y <= pylonTopY + 1e-9; y += 6) put(granite, ss + ds, tt + dt, y);
          put(granite, ss + ds, tt + dt, pylonTopY);
        }
      }
    }
  }
  for (let y = deckY - 60; y < deckY; y += 5) {
    for (const dt of [-6, 6]) put(granite, 0, dt, y);
  }

  return {
    steel: new Float32Array(steel),
    granite: new Float32Array(granite),
    asphalt: new Float32Array(asphalt),
    ax, az, cx, cz, span, rise, archAcross, deckLength, deckHalfWidth, deckY, archFootY,
    pylons, pylonTopY,
  };
}

/**
 * Everything about the bridge derivation that fails silently.
 *
 * On **both** boot lists, which is why this file is three-free: the string is
 * drawn from a GLB nothing but a browser ever fetches, but the arithmetic that
 * decides where it goes is arithmetic, and a check the deploy gate cannot see is
 * a check that goes green on a broken build (`server/index.ts` makes the same
 * argument about `verifyDoorway`).
 *
 * Every failure below renders a perfectly plausible frame. A string that picked
 * the lower chord is a bridge lit along a line 9 m under the one in every
 * photograph, and it looks *fine* until you compare it. A string that kept the
 * parapet bins is 1.5 km of fairy lights along a motorway. A deck spacing that
 * silently doubled is half the lamps, evenly. None of them throws.
 */
export function verifyBridgeLights(): string[] {
  const failures: string[] = [];
  const fake = fakeBridge();

  // --- 1. The axis, recovered from vertices alone.
  const axis = planAxis(fake.steel);
  // Either sign of the eigenvector is correct; the check is on the line.
  const dot = Math.abs(axis.ax * fake.ax + axis.az * fake.az);
  if (dot < 0.9999) {
    failures.push(
      `planAxis recovered (${axis.ax.toFixed(4)}, ${axis.az.toFixed(4)}) from a bridge laid on ` +
        `(${fake.ax}, ${fake.az}) -- ${(Math.acos(Math.min(1, dot)) * (180 / Math.PI)).toFixed(2)} degrees off. ` +
        `Every bin below is taken along this vector; a degree of error smears each 8 m bin across ` +
        `the structure's width and puts both arches in one bin at the ends.`,
    );
  }
  // And the axis-aligned bounding box is *not* the answer, which is the whole
  // reason there is an eigenvector here. Asserted so that a future
  // simplification to "the long side of the box" is caught by this file rather
  // than by somebody looking at the bridge.
  {
    let xMin = Infinity, xMax = -Infinity, zMin = Infinity, zMax = -Infinity;
    for (let i = 0; i < fake.steel.length / 3; i++) {
      const x = fake.steel[i * 3], z = fake.steel[i * 3 + 2];
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
    }
    const boxAlongZ = zMax - zMin > xMax - xMin;
    const boxDot = Math.abs(boxAlongZ ? axis.az : axis.ax);
    if (boxDot > 0.99) {
      failures.push(
        `The fixture's bounding box long side and its principal axis agree to ${boxDot.toFixed(3)}, ` +
          `so this check cannot tell the two derivations apart. The fixture bearing needs to be ` +
          `further off the world axes.`,
      );
    }
  }

  // --- 2. Two chords, on the upper parabola, evenly spaced, 2 x archAcross apart.
  const chords = archChords(fake.steel, axis);
  if (chords.length !== 2) {
    failures.push(
      `archChords found ${chords.length} chords on a bridge with two arches. The split is on the ` +
        `sign of the across coordinate; one string would zig-zag between the two trusses.`,
    );
  }
  const upperAt = (s: number): number => {
    const f = (2 * s) / fake.span;
    return fake.archFootY + fake.rise * (1 - f * f);
  };
  const WANT_SPRITES = 40;
  for (const chord of chords) {
    const count = chord.points.length / 3;
    if (count < WANT_SPRITES) {
      failures.push(
        `A chord came out as ${count} sprites over a ${fake.span} m arch at a ${ARCH_PITCH_M} m pitch; ` +
          `at least ${WANT_SPRITES} were expected. Bins are only occupied where a prism ends, so a ` +
          `string that is not resampled is a string with holes in it.`,
      );
      continue;
    }
    let offChord = 0;
    let worst = 0;
    let biggestStep = 0;
    let smallestStep = Infinity;
    let previousX = NaN;
    let previousY = 0;
    let previousZ = 0;
    for (let i = 0; i < count; i++) {
      const x = chord.points[i * 3];
      const y = chord.points[i * 3 + 1];
      const z = chord.points[i * 3 + 2];
      const dx = x - axis.cx;
      const dz = z - axis.cz;
      const s = dx * axis.ax + dz * axis.az;
      const want = upperAt(s);
      const off = Math.abs(y - want);
      if (off > worst) worst = off;
      // Half the truss depth: anything further down is the lower chord, which is
      // the single failure this fixture exists to catch.
      if (off > 4.5) offChord++;
      if (Number.isFinite(previousX)) {
        const step = Math.sqrt((x - previousX) ** 2 + (y - previousY) ** 2 + (z - previousZ) ** 2);
        if (step > biggestStep) biggestStep = step;
        if (step < smallestStep) smallestStep = step;
      }
      previousX = x;
      previousY = y;
      previousZ = z;
    }
    if (offChord > 0) {
      failures.push(
        `${offChord} of ${count} sprites on the ${chord.side > 0 ? 'eastern' : 'western'} chord are ` +
          `more than 4.5 m off the upper parabola (worst ${worst.toFixed(1)} m). The truss is 9 m ` +
          `deep and the highest vertex in a bin is on its top chord by definition; a string down ` +
          `the middle means the bin maximum is not what is being taken.`,
      );
    }
    // The pitch is arc length along a chord that is nearly vertical at the
    // springing, so the tolerance is on evenness rather than on the number.
    if (biggestStep > ARCH_PITCH_M * 1.35 || smallestStep < ARCH_PITCH_M * 0.65) {
      failures.push(
        `Sprites on a chord are ${smallestStep.toFixed(2)}-${biggestStep.toFixed(2)} m apart against ` +
          `a ${ARCH_PITCH_M} m pitch. Spacing by the axis coordinate instead of by arc length bunches ` +
          `them at the crown and strands them at the springing.`,
      );
    }
    // Nothing at the deck: the parapet bins must have been rejected.
    for (let i = 0; i < count; i++) {
      if (chord.points[i * 3 + 1] < fake.deckY + ARCH_LIFT_M) {
        failures.push(
          `A chord sprite sits at y ${chord.points[i * 3 + 1].toFixed(1)}, under the ` +
            `${ARCH_LIFT_M} m clearance over a deck at ${fake.deckY}. The parapet is the highest ` +
            `steel over the approaches and it is 1.2 km of it.`,
        );
        break;
      }
    }
  }
  if (chords.length === 2) {
    const gap = Math.abs(chords[0].across - chords[1].across);
    if (Math.abs(gap - 2 * fake.archAcross) > 1.5) {
      failures.push(
        `The two chords came out ${gap.toFixed(1)} m apart on trusses ${(2 * fake.archAcross).toFixed(1)} m ` +
          `apart. The across offset is the mean of the bins' own, so this drifting means the sides ` +
          `are not being separated by the sign of t.`,
      );
    }
    if (chords[0].side === chords[1].side) failures.push('both chords report the same side.');
  }

  // --- 3. A model with no arch in it gets no string, rather than a parapet one.
  {
    const flat: number[] = [];
    for (let s = -600; s <= 600; s += 4) {
      for (const side of [-1, 1]) flat.push(fake.cx + s * fake.ax - fake.deckHalfWidth * side * fake.az, fake.deckY + 1.25, fake.cz + s * fake.az + fake.deckHalfWidth * side * fake.ax);
    }
    const deckOnly = new Float32Array(flat);
    const none = archChords(deckOnly, planAxis(deckOnly));
    if (none.length !== 0) {
      failures.push(
        `A deck with no arch over it produced ${none.length} chords. The median-plus-clearance rule ` +
          `is what stops a flat structure being lit along its parapet.`,
      );
    }
  }

  // --- 4. The deck lamps: both kerbs, 30 m apart within a metre, 9 m up.
  const { lamps, deckTopY } = deckLamps(fake.asphalt, axis);
  const lampCount = lamps.length / DECK_LAMP_FLOATS;
  if (Math.abs(deckTopY - fake.deckY) > 1e-3) {
    failures.push(`the deck top came out at ${deckTopY.toFixed(3)} on a deck built at ${fake.deckY}.`);
  }
  {
    const want = 2 * Math.round(fake.deckLength / DECK_PITCH_M);
    if (Math.abs(lampCount - want) > 2) {
      failures.push(
        `${lampCount} deck lamps over ${fake.deckLength} m of roadway; about ${want} were expected ` +
          `(two kerbs, ${DECK_PITCH_M} m apart).`,
      );
    }
  }
  {
    let previous = NaN;
    let worstPitch = 0;
    let kerbWrong = 0;
    let heightWrong = 0;
    for (let i = 0; i < lampCount; i++) {
      const o = i * DECK_LAMP_FLOATS;
      const x = lamps[o];
      const y = lamps[o + 1];
      const z = lamps[o + 2];
      const kerb = lamps[o + 3];
      const dx = x - axis.cx;
      const dz = z - axis.cz;
      const s = dx * axis.ax + dz * axis.az;
      const t = -dx * axis.az + dz * axis.ax;
      if (Math.abs(y - (fake.deckY + LAMP_COLUMN_M)) > 1e-3) heightWrong++;
      // Inside the parapet, outside the middle of the road, and on the side the
      // record says it is on.
      const wantT = (fake.deckHalfWidth - KERB_INSET_M) * kerb;
      if (Math.abs(t - wantT) > 1e-3) kerbWrong++;
      // Pairs are adjacent, so consecutive stations are two lamps apart.
      if (i % 2 === 1 && Number.isFinite(previous)) {
        const pitch = Math.abs(s - previous);
        if (Math.abs(pitch - DECK_PITCH_M) > worstPitch) worstPitch = Math.abs(pitch - DECK_PITCH_M);
      }
      if (i % 2 === 1) previous = s;
    }
    if (worstPitch > 1) {
      failures.push(
        `Deck lamp stations are up to ${worstPitch.toFixed(2)} m off the ${DECK_PITCH_M} m pitch. ` +
          `The pitch is the roadway's own length divided by a whole number of stations; anything ` +
          `bigger than a metre means the bins are being taken along the wrong vector.`,
      );
    }
    if (kerbWrong > 0) failures.push(`${kerbWrong} of ${lampCount} deck lamps are not on the kerb their record claims.`);
    if (heightWrong > 0) {
      failures.push(
        `${heightWrong} of ${lampCount} deck lamps are not ${LAMP_COLUMN_M} m over the road under them. ` +
          `The height is derived per station so the ramps carry their lamps down; a fixed y leaves the ` +
          `last one on the southern approach hanging over Millers Point.`,
      );
    }
  }
  // --- ...and the ramps: a road that falls away carries its lamps down with it.
  {
    const ramped: number[] = [];
    for (let s = -300; s <= 300 + 1e-9; s += 3) {
      const drop = s > 150 ? (s - 150) * 0.06 : 0;
      for (const side of [-1, 0, 1]) {
        ramped.push(
          fake.cx + s * fake.ax - fake.deckHalfWidth * side * fake.az,
          fake.deckY - drop,
          fake.cz + s * fake.az + fake.deckHalfWidth * side * fake.ax,
        );
      }
    }
    const slab = new Float32Array(ramped);
    const built = deckLamps(slab, planAxis(slab));
    let overRoad = 0;
    for (let i = 0; i < built.lamps.length / DECK_LAMP_FLOATS; i++) {
      if (built.lamps[i * DECK_LAMP_FLOATS + 1] < fake.deckY + LAMP_COLUMN_M - 1e-3) overRoad++;
    }
    if (overRoad === 0) {
      failures.push(
        'Every lamp over a ramped roadway came out at the level deck height, so the per-station ' +
          'derivation is not running and the approaches are lit from mid-air.',
      );
    }
  }

  // --- 5. Four pylons, four faces each, and the pier under the deck is not one.
  const faces = pylonFloods(fake.granite, axis, deckTopY);
  if (faces.length !== fake.pylons * 4) {
    failures.push(
      `${faces.length} pylon faces from ${fake.pylons} pylons; ${fake.pylons * 4} were expected. ` +
        `The pier under the deck is granite too and must not become a fifth tower.`,
    );
  }
  for (const face of faces) {
    if (Math.abs(face.nx * face.fx + face.nz * face.fz) > 1e-6) {
      failures.push('a pylon face normal is not perpendicular to the face direction.');
      break;
    }
    if (Math.abs(Math.sqrt(face.nx * face.nx + face.nz * face.nz) - 1) > 1e-6) {
      failures.push('a pylon face normal is not a unit vector.');
      break;
    }
    if (!(face.topY > face.baseY + 10)) {
      failures.push(`a pylon face runs from ${face.baseY.toFixed(1)} to ${face.topY.toFixed(1)}; a wash needs the tower.`);
      break;
    }
    if (Math.abs(face.topY - fake.pylonTopY) > 1e-3) {
      failures.push(`a pylon face tops out at ${face.topY.toFixed(2)} on a tower built to ${fake.pylonTopY}.`);
      break;
    }
    if (!(face.half > 1)) {
      failures.push('a pylon face has no width.');
      break;
    }
  }

  // --- 6. The records are the deck lamps, white, at the stride the rig reads.
  {
    const records = bridgeLampRecords(lamps);
    if (records.length !== lampCount * BRIDGE_LAMP_RECORD_STRIDE) {
      failures.push(`${records.length} floats of records for ${lampCount} lamps at a stride of ${BRIDGE_LAMP_RECORD_STRIDE}.`);
    } else {
      for (let i = 0; i < lampCount; i++) {
        const r = i * BRIDGE_LAMP_RECORD_STRIDE;
        const l = i * DECK_LAMP_FLOATS;
        if (records[r] !== lamps[l] || records[r + 1] !== lamps[l + 1] || records[r + 2] !== lamps[l + 2]) {
          failures.push(`bridge lamp record ${i} is not at its lamp.`);
          break;
        }
        if (records[r + 3] !== 0) {
          failures.push(`bridge lamp record ${i} is flagged sodium; the Bradfield Highway is white light.`);
          break;
        }
      }
    }
    if (bridgeLampRecords(new Float32Array(0)).length !== 0) failures.push('no lamps gave some records.');
  }

  // --- 7. The whole plan, and the two ways it is allowed to give up.
  {
    const plan = planBridgeLights(fake.steel, fake.granite, fake.asphalt);
    if (plan === null) failures.push('planBridgeLights found nothing on a bridge with an arch, a deck and four pylons.');
    else if (plan.chords.length !== 2 || plan.deck.length === 0 || plan.pylons.length !== fake.pylons * 4) {
      failures.push('planBridgeLights disagrees with the three functions it composes.');
    }
    if (planBridgeLights(null, null, null) !== null) failures.push('a world with no landmark steel still produced a plan.');
    if (planBridgeLights(new Float32Array(3), null, null) !== null) failures.push('a single vertex produced a plan.');
    // Determinism: the same bridge twice is the same plan. This runs on two
    // boot lists and the resample walks a polyline with a running accumulator.
    const again = planBridgeLights(fake.steel, fake.granite, fake.asphalt);
    if (plan !== null && again !== null) {
      const a = plan.chords[0]?.points;
      const b = again.chords[0]?.points;
      if (a !== undefined && b !== undefined && (a.length !== b.length || a.some((v, i) => v !== b[i]))) {
        failures.push('planBridgeLights is not a pure function of the geometry.');
      }
    }
  }

  return failures;
}
