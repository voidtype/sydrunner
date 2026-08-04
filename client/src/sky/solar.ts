/**
 * Solar position for Sydney, computed rather than guessed.
 *
 * Spec section 7.1 is the highest-priority item in the document, and the reason is
 * a single fact: Sydney is at latitude -33.87, so **the midday sun is in the
 * NORTH and shadows fall SOUTH**. Every downloaded HDRI and every default
 * three-point lighting rig puts the sun in the south, and an Australian player
 * feels that as wrong within seconds without being able to name why.
 *
 * This is the NOAA solar position algorithm, accurate to well under a degree
 * over any date range this project cares about. No dependency, ~60 lines.
 */

/** Where the sun is, in the local ENU frame. */
export interface SolarPosition {
  /** Degrees above the horizon. Negative is below. */
  altitude: number;
  /** Degrees clockwise from true north. 0 = N, 90 = E, 180 = S, 270 = W. */
  azimuth: number;
  /**
   * Unit vector pointing *at* the sun, in renderer world axes
   * (x = east, y = up, z = south).
   */
  direction: { x: number; y: number; z: number };
}

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Julian day from a JS Date (UTC). */
function julianDay(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

/**
 * Sun altitude and azimuth for a geographic position and instant.
 *
 * `latitude` is negative in the southern hemisphere -- that sign is what puts the
 * sun in the northern half of the sky, and it must not be "corrected".
 */
export function solarPosition(date: Date, latitude: number, longitude: number): SolarPosition {
  const jd = julianDay(date);
  const n = jd - 2451545.0; // days from J2000.0
  const T = n / 36525.0; // Julian centuries

  // Geometric mean longitude and anomaly of the sun, degrees.
  const L0 = mod360(280.46646 + T * (36000.76983 + T * 0.0003032));
  const M = mod360(357.52911 + T * (35999.05029 - 0.0001537 * T));
  const Mrad = M * RAD;

  // Equation of the centre, then true longitude.
  const C =
    Math.sin(Mrad) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * Mrad) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * Mrad) * 0.000289;
  const trueLong = L0 + C;

  // Apparent longitude, corrected for nutation and aberration.
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);

  // Obliquity of the ecliptic.
  const seconds = 21.448 - T * (46.815 + T * (0.00059 - T * 0.001813));
  const eps0 = 23 + (26 + seconds / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);

  // Right ascension and declination.
  const lamRad = lambda * RAD;
  const epsRad = eps * RAD;
  const declination =
    Math.asin(Math.sin(epsRad) * Math.sin(lamRad)) * DEG;
  const rightAscension =
    Math.atan2(Math.cos(epsRad) * Math.sin(lamRad), Math.cos(lamRad)) * DEG;

  // Greenwich mean sidereal time -> local hour angle.
  const gmst = mod360(280.46061837 + 360.98564736629 * n);
  const hourAngle = mod180(gmst + longitude - rightAscension);

  const latRad = latitude * RAD;
  const decRad = declination * RAD;
  const haRad = hourAngle * RAD;

  const sinAlt =
    Math.sin(latRad) * Math.sin(decRad) +
    Math.cos(latRad) * Math.cos(decRad) * Math.cos(haRad);
  const altitude = Math.asin(clamp(sinAlt, -1, 1)) * DEG;

  // Azimuth, via Meeus: atan2 gives the angle from *south*, positive westward;
  // adding 180 puts it clockwise from north. The sign of the numerator is the
  // thing to get right -- flipping it mirrors the sky east-for-west, which reads
  // as the sun rising in the west and is otherwise easy to miss.
  const azimuth = mod360(
    Math.atan2(
      Math.sin(haRad),
      Math.cos(haRad) * Math.sin(latRad) - Math.tan(decRad) * Math.cos(latRad),
    ) *
      DEG +
      180,
  );

  return { altitude, azimuth, direction: directionFrom(altitude, azimuth) };
}

/**
 * Altitude/azimuth to a renderer-space unit vector.
 *
 * World axes here are x = east, y = up, z = south. Azimuth is clockwise from
 * north, so north (azimuth 0) must map to -z. Getting this mapping wrong is
 * exactly the bug the spec warns about, and it is invisible in code review --
 * `verifySouthernHemisphere()` below is the guard.
 */
export function directionFrom(altitudeDeg: number, azimuthDeg: number) {
  const alt = altitudeDeg * RAD;
  const az = azimuthDeg * RAD;
  const horizontal = Math.cos(alt);
  return {
    x: horizontal * Math.sin(az), // east component
    y: Math.sin(alt), // up
    z: -horizontal * Math.cos(az), // north is -z, so south is +z
  };
}

/**
 * Self-check: at Sydney's solar noon the sun must be north and high, and the
 * shadow direction must therefore point south.
 *
 * Returns a list of failures, empty when correct. Called on startup so a
 * regression here is loud rather than a vague feeling that the light is wrong.
 */
export function verifySouthernHemisphere(latitude: number, longitude: number): string[] {
  const failures: string[] = [];

  // Transit, not 12:00 wall-clock. Sydney sits near the eastern edge of its
  // time zone, so solar noon is around 12:55 AEDT -- testing at 12:00 would
  // understate the peak altitude by five degrees and make a correct
  // implementation look broken.
  const transit = (year: number, month: number, day: number) => {
    let best = solarPosition(sydneyTime(year, month, day, 0), latitude, longitude);
    for (let m = 0; m < 24 * 60; m += 2) {
      const p = solarPosition(
        sydneyTime(year, month, day, 0, m),
        latitude,
        longitude,
      );
      if (p.altitude > best.altitude) best = p;
    }
    return best;
  };

  const s = transit(2026, 12, 21); // southern summer solstice
  const w = transit(2026, 6, 21); // southern winter solstice

  // At transit the sun must be in the northern half of the sky.
  for (const [name, p] of [['December', s], ['June', w]] as const) {
    if (Math.cos(p.azimuth * RAD) < 0.5) {
      failures.push(
        `${name} transit azimuth is ${p.azimuth.toFixed(1)} deg -- the sun is not in the north. ` +
          `Southern-hemisphere sign error.`,
      );
    }
    if (p.direction.z > 0) {
      failures.push(`${name} sun direction has +z (south); it must be -z (north).`);
    }
  }

  // Spec section 7.1 quotes ~79 deg in December and ~33 deg in June.
  if (Math.abs(s.altitude - 79) > 2) {
    failures.push(`December transit altitude ${s.altitude.toFixed(1)} deg, expected ~79 deg.`);
  }
  if (Math.abs(w.altitude - 33) > 2) {
    failures.push(`June transit altitude ${w.altitude.toFixed(1)} deg, expected ~33 deg.`);
  }

  // The sun must rise in the east and set in the west. This is the check that
  // catches an azimuth mirrored about the meridian, which the northness test
  // above cannot see because it only samples transit.
  const morning = solarPosition(sydneyTime(2026, 2, 15, 7), latitude, longitude);
  const evening = solarPosition(sydneyTime(2026, 2, 15, 18), latitude, longitude);
  if (morning.direction.x <= 0) {
    failures.push(
      `Morning sun is to the west (x=${morning.direction.x.toFixed(2)}); it must rise in the east.`,
    );
  }
  if (evening.direction.x >= 0) {
    failures.push(
      `Evening sun is to the east (x=${evening.direction.x.toFixed(2)}); it must set in the west.`,
    );
  }

  return failures;
}

/** A Date for a local Sydney wall-clock time, handling AEST/AEDT. */
export function sydneyTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): Date {
  // Daylight saving in NSW: first Sunday in October to first Sunday in April.
  const offset = isDaylightSaving(year, month, day) ? 11 : 10;
  return new Date(Date.UTC(year, month - 1, day, hour - offset, minute, 0));
}

function isDaylightSaving(year: number, month: number, day: number): boolean {
  const firstSunday = (m: number) => {
    const d = new Date(Date.UTC(year, m - 1, 1));
    return 1 + ((7 - d.getUTCDay()) % 7);
  };
  if (month > 4 && month < 10) return false;
  if (month < 4 || month > 10) return true;
  if (month === 4) return day < firstSunday(4);
  return day >= firstSunday(10);
}

function mod360(v: number): number {
  return ((v % 360) + 360) % 360;
}

function mod180(v: number): number {
  const m = mod360(v);
  return m > 180 ? m - 360 : m;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
