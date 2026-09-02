/**
 * The geometry of the seventh mushroom: a mandala, laid out rather than scattered.
 *
 * ---------------------------------------------------------------------------
 * ## Why this is arithmetic and not art
 *
 * The reference the owner gave -- Alex Grey's, and everything downstream of it --
 * is not psychedelic *noise*. It is aggressively ordered: bilateral symmetry
 * about a vertical axis, concentric rings that count outward, a hexagonal
 * lattice of repeated eyes, petals radiating on exact angles, and one face in
 * the middle looking straight out. The trip is in the colour and the motion; the
 * *structure* is a cathedral rose window.
 *
 * That is a gift, because a rose window is a function. This file is that
 * function -- where every eye sits, how the rings counter-rotate, how the whole
 * thing breathes -- and it can be checked. What cannot be checked is whether the
 * result is beautiful, and `world/godroom.ts` says so.
 *
 * ## The rules the references actually obey
 *
 *   - **Six-fold symmetry.** Every ring's count is a multiple of six, so the
 *     lattice lines up radially and the whole field reads as one object rather
 *     than as rings that happen to be concentric.
 *   - **Counts grow, spacing does not.** A ring twice as far out holds twice as
 *     many, so the angular gap between neighbours is near-constant and the eyes
 *     tile the dome instead of thinning toward the rim.
 *   - **Alternate rings counter-rotate.** Adjacent rings turning opposite ways is
 *     what makes a mandala *breathe* rather than spin; two rings turning together
 *     read as one disc.
 *   - **Nothing sits on the axis but the face.** The centre is reserved, because
 *     the thing you are meant to look at is there.
 */

/** How many concentric rings of eyes. Five reads as deep without tiling flat. */
export const RINGS = 5;

/** The innermost ring's angular radius from the axis, radians. */
export const INNER_ANGLE = 0.34;

/** The outermost. Past this the dome curves away behind you. */
export const OUTER_ANGLE = 1.32;

/** Eyes on the innermost ring. Every ring is a multiple of this. */
export const BASE_COUNT = 6;

/** How fast the whole field breathes, cycles a second. */
export const BREATH_HZ = 0.11;

/** How far a breath moves a ring, as a fraction of its radius. */
export const BREATH_DEPTH = 0.06;

/** Radians a second the first ring turns. Alternate rings negate it. */
export const SPIN_RATE = 0.045;

export interface MandalaEye {
  /** Angle from the vertical axis, radians. */
  polar: number;
  /** Angle around it, radians. */
  azimuth: number;
  /** Which ring, outward from 0. */
  ring: number;
  /** Relative size; the outer rings are smaller, as in the references. */
  scale: number;
}

/** How many eyes ring `i` carries. Six-fold, growing with the radius. */
export function ringCount(i: number): number {
  return BASE_COUNT * (i + 1);
}

/** The angle from the axis of ring `i`, before it breathes. */
export function ringAngle(i: number): number {
  if (RINGS <= 1) return INNER_ANGLE;
  return INNER_ANGLE + ((OUTER_ANGLE - INNER_ANGLE) * i) / (RINGS - 1);
}

/** Every eye, at rest. The renderer breathes and spins them per frame. */
export function mandalaEyes(): MandalaEye[] {
  const out: MandalaEye[] = [];
  for (let ring = 0; ring < RINGS; ring++) {
    const n = ringCount(ring);
    const polar = ringAngle(ring);
    // Half a step of offset on alternate rings, so neighbours interlock rather
    // than lining up into radial spokes -- which is what makes a lattice read as
    // a lattice and not as a set of rays.
    const offset = ring % 2 === 0 ? 0 : Math.PI / n;
    for (let k = 0; k < n; k++) {
      out.push({
        polar,
        azimuth: offset + (k * Math.PI * 2) / n,
        ring,
        scale: 1 - (ring / RINGS) * 0.45,
      });
    }
  }
  return out;
}

/** How much ring `i` has turned at `tSeconds`. Alternate rings counter-rotate. */
export function ringSpin(i: number, tSeconds: number): number {
  const dir = i % 2 === 0 ? 1 : -1;
  // The rate falls with the radius so the outer rings do not outrun the eye.
  return dir * SPIN_RATE * tSeconds * (1 - i / (RINGS * 2));
}

/** The breath, as a multiplier on a ring's radius. One is at rest. */
export function breath(tSeconds: number): number {
  return 1 + Math.sin(tSeconds * Math.PI * 2 * BREATH_HZ) * BREATH_DEPTH;
}

/**
 * The palette, as hue turns in [0, 1).
 *
 * Taken off the references rather than invented: a hot centre -- gold into
 * orange into red -- against a cold field of blue eyes, which is the contrast
 * every one of those paintings is built on. Returned as hue turns so the
 * renderer can push saturation and value without the palette having an opinion
 * about either.
 */
export const HUE_CORE = 0.11;
export const HUE_RIM = 0.94;
export const HUE_EYE = 0.58;

/** The hue for ring `i`, walked from the hot centre to the cool rim. */
export function ringHue(i: number): number {
  const t = RINGS <= 1 ? 0 : i / (RINGS - 1);
  // Through red rather than through green: the short way round the wheel is
  // what keeps it a fire and not a rainbow.
  const a = HUE_CORE;
  const b = HUE_RIM - 1; // -0.06, so the walk is 0.11 -> -0.06 and never green
  return (a + (b - a) * t + 1) % 1;
}

export function verifyMandala(): string[] {
  const failures: string[] = [];
  const eyes = mandalaEyes();

  if (eyes.length === 0) failures.push('The mandala is empty.');

  // --- Six-fold, every ring, or the lattice does not line up radially.
  for (let i = 0; i < RINGS; i++) {
    if (ringCount(i) % 6 !== 0) failures.push(`Ring ${i} holds ${ringCount(i)}, which is not six-fold.`);
    if (i > 0 && ringCount(i) <= ringCount(i - 1)) failures.push(`Ring ${i} holds no more than ring ${i - 1}.`);
  }

  // --- Rings march outward and never overlap.
  for (let i = 1; i < RINGS; i++) {
    if (ringAngle(i) <= ringAngle(i - 1)) failures.push(`Ring ${i} is not outside ring ${i - 1}.`);
  }
  if (ringAngle(0) < 0.15) failures.push('The innermost ring crowds the face on the axis.');
  if (ringAngle(RINGS - 1) > Math.PI / 2) failures.push('The outermost ring has gone behind the viewer.');

  // --- Angular spacing stays roughly even, which is the whole point of growing
  //     the counts: a ring that thinned toward the rim would look like a target.
  {
    const gaps: number[] = [];
    for (let i = 0; i < RINGS; i++) gaps.push(((Math.PI * 2) / ringCount(i)) * Math.sin(ringAngle(i)));
    const min = Math.min(...gaps);
    const max = Math.max(...gaps);
    if (max / min > 1.8) failures.push(`Neighbour spacing varies ${(max / min).toFixed(2)}x across the rings; the lattice thins.`);
  }

  // --- Nothing sits on the axis. The face is there.
  for (const e of eyes) if (e.polar < 0.1) failures.push('An eye sits on the axis, where the face is.');

  // --- Alternate rings interlock rather than forming spokes.
  {
    const r0 = eyes.filter((e) => e.ring === 0).map((e) => e.azimuth);
    const r1 = eyes.filter((e) => e.ring === 1).map((e) => e.azimuth);
    const aligned = r1.filter((a) => r0.some((b) => Math.abs(((a - b + Math.PI) % (Math.PI * 2)) - Math.PI) < 1e-6));
    if (aligned.length === r1.length && r1.length > 0) {
      failures.push('Every eye on ring 1 lines up with one on ring 0; the lattice reads as spokes.');
    }
  }

  // --- Bilateral symmetry about the vertical axis, which every reference has.
  {
    const ring = eyes.filter((e) => e.ring === 0);
    for (const e of ring) {
      const mirrored = (Math.PI * 2 - e.azimuth) % (Math.PI * 2);
      const has = ring.some((o) => Math.abs(((o.azimuth - mirrored + Math.PI) % (Math.PI * 2)) - Math.PI) < 1e-6);
      if (!has) {
        failures.push('A ring is not symmetric about the vertical axis; the mandala has a handedness.');
        break;
      }
    }
  }

  // --- Adjacent rings counter-rotate, and nothing outruns the eye.
  {
    for (let i = 1; i < RINGS; i++) {
      const a = ringSpin(i - 1, 10);
      const b = ringSpin(i, 10);
      if (a === 0 || b === 0) failures.push(`Ring ${i} or ${i - 1} does not turn.`);
      if (Math.sign(a) === Math.sign(b)) failures.push(`Rings ${i - 1} and ${i} turn the same way; they read as one disc.`);
    }
    if (Math.abs(ringSpin(0, 1)) > 0.2) failures.push('The mandala spins fast enough to read as machinery.');
  }

  // --- The breath is a breath: slow, gentle, and centred on rest.
  {
    let lo = Infinity;
    let hi = -Infinity;
    for (let t = 0; t < 40; t += 0.05) {
      const b = breath(t);
      lo = Math.min(lo, b);
      hi = Math.max(hi, b);
    }
    if (Math.abs(1 - (lo + hi) / 2) > 1e-6) failures.push('The breath is not centred on rest.');
    if (hi - 1 > 0.15) failures.push(`The breath swells ${((hi - 1) * 100).toFixed(0)}%, which is a pulse rather than a breath.`);
    if (hi - 1 < 0.01) failures.push('The breath is imperceptible.');
    if (BREATH_HZ > 0.4) failures.push('The mandala breathes faster than a person does.');
  }

  // --- The palette runs hot to cool the short way, never through green.
  {
    for (let i = 0; i < RINGS; i++) {
      const h = ringHue(i);
      if (h > 0.25 && h < 0.85) failures.push(`Ring ${i} is hue ${h.toFixed(2)}, which is green; the fire goes the other way.`);
    }
    if (HUE_EYE < 0.45 || HUE_EYE > 0.72) failures.push('The eyes are not blue; the cold field against the hot centre is the contrast the references are built on.');
  }

  return failures;
}
