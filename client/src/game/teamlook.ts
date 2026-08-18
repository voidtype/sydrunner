/**
 * How a team looks, as arithmetic: the tint, the budgets, the ring, the tent.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS SEPARATELY FROM `world/teamlook.ts`.
 *
 * The renderer half of this workstream builds horns, a cactus, a gazebo and a
 * pulsing ground ring, and none of that can run outside a browser -- it is
 * three geometry and it needs a GPU eventually. But **every decision inside it
 * is a number**: which colour a Marita singlet is, how far apart that colour has
 * to be from the shorts under it before the figure stops reading as two tones,
 * how many triangles a horn may cost, how big the slam ring is at 0.2 s. Those
 * are exactly the things this project's PREAMBLE says to test, and exactly the
 * things that cannot be tested through a picture.
 *
 * So the numbers live here, three-free, in both boot lists (`main.ts` and
 * `server/index.ts`), and `world/teamlook.ts` is a builder that reads them. It
 * is the same split `game/bikes.ts` (pure) and `world/bike.ts` (renderer) make,
 * and the same one `game/traffic.ts`'s header argues for at length.
 *
 * ---------------------------------------------------------------------------
 * THE TINT, and the one measurement that decides it.
 *
 * `player/character.ts`'s header spends two pages on a single criterion: **a
 * player is identified at fifty metres by a two-tone silhouette**, so what
 * matters is the singlet against its *own shorts*, not either against the city.
 * Seven colourways were re-picked until the worst pair was 62 code values apart
 * in sun and 53 in shade.
 *
 * A team tint puts a fixed colour on the top half of all seven of them, which is
 * precisely the thing that can destroy that property -- and it does, twice per
 * team, and neither case is visible in a screenshot of the other five. DeFAULT's
 * yellow against `green/cream`'s cream shorts is **four** code values on the
 * measure below; Marita's teal against `cobalt/gold`'s gold is 34. Those two
 * figures would be a solid-colour blob at any distance where chroma has gone,
 * which is the failure the character palette was tuned to avoid.
 *
 * The fix is the field `TEAM_COLOUR` already carries for a different purpose:
 * **the ink that reads on the team colour**. Where the base shorts fall inside
 * `MIN_KIT_GAP` of the team singlet, the shorts are re-inked to the team's ink
 * -- white under Marita's teal, near-black under DeFAULT's yellow. Two of the
 * seven for Marita (`cobalt/gold`, `teal/pink`) and three for DeFAULT
 * (`green/cream`, `purple/white`, `charcoal/yellow`), chosen by measurement
 * rather than by taste; the rest keep the shorts the character palette picked
 * for them. `verifyTeamLook` asserts the result: **after tinting, every one of
 * the fourteen kits still clears the bar**, and no more than three per team were
 * touched to get there.
 *
 * A rejected alternative, stated because it is the obvious one: shade the team
 * hue per colourway so the *value* relationship of the original kit survives.
 * That keeps fourteen legible figures and loses the thing the tint is for --
 * "Marita are teal" stops being true the moment there are seven teals, and a
 * player scanning a street is reading hue, not a value ramp.
 *
 * ---------------------------------------------------------------------------
 * THE MEASURE. `lumaCode` is the raw **albedo** turned into a display code
 * value: relative luminance of the linear colour, sRGB-encoded, x255. It is
 * deliberately *not* the full chain `sky/calibration.ts` documents (irradiance,
 * Lambert, exposure, Neutral tone mapping) that produced the character header's
 * "sun / shade" pairs -- that chain needs a sun position and a surface
 * orientation, and this file has neither and must run in Bun.
 *
 * What it is instead is a monotone proxy for it: two albedos an equal number of
 * code values apart here stay ordered under any of those chains, because every
 * stage of them is monotone in luminance. So the *threshold* is not comparable
 * to the header's 62 -- it is its own bar, set at `MIN_KIT_GAP` -- but the
 * ranking is, and the ranking is what a check needs.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM. Nothing here is evaluated on both ends for agreement: an aura's
 * brightness is not a fact two clients have to share, and a tint is a constant.
 * The pulse is still written without `Math.sin` -- a folded smoothstep instead --
 * because it costs nothing to write it that way and it keeps the file honest
 * against `game/footy.ts`'s rule rather than inviting a reader to work out
 * whether the exemption applies. `srgbToLinear` is the one place `Math.pow`
 * appears, in a colour conversion that runs at module load and never in a tick.
 */

import { AURA_M, GROUP_M, TEAM, TEAM_COLOUR, TEAM_NAME, type Team } from './teams.ts';

// --- Colour ---------------------------------------------------------------------------

/** Linear RGB, the space every albedo in `player/character.ts` is written in. */
export type Rgb = readonly [number, number, number];

/**
 * A colourway's four albedos plus the two a team adds.
 *
 * Structural rather than imported from `player/character.ts`, and that is not
 * fastidiousness: that module imports three, and this one is in the server's
 * boot list. A structural type costs one interface and means the server never
 * touches a module that would pull WebGPU into Bun. `Colourway` in
 * `character.ts` is declared to extend this shape, so the two cannot drift.
 */
export interface KitColours {
  readonly singlet: Rgb;
  readonly shorts: Rgb;
  readonly skin: Rgb;
  readonly shoe: Rgb;
  /**
   * The forearm band, or absent for "the same as skin", which is what every
   * untinted kit gets and is what makes the band invisible on a guest.
   */
  readonly band?: Rgb;
  /**
   * The singlet's trim -- the collar disc at the top of the chest. Absent means
   * "the same as the singlet", which is the untinted figure exactly as it was.
   */
  readonly trim?: Rgb;
}

/** sRGB 0..1 to linear. The exact piecewise transfer function, not the 2.2 approximation. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
/** Linear 0..1 to sRGB. The inverse of the above, used only by `lumaCode`. */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** A `0xRRGGBB` sRGB hex -- the form `TEAM_COLOUR` carries -- as a linear albedo. */
export function hexToLinear(hex: number): Rgb {
  return [
    srgbToLinear(((hex >> 16) & 0xff) / 255),
    srgbToLinear(((hex >> 8) & 0xff) / 255),
    srgbToLinear((hex & 0xff) / 255),
  ];
}

/**
 * A linear albedo as a display code value, 0..255. See the header on what this
 * is a proxy for and what it deliberately is not.
 */
export function lumaCode(c: Rgb): number {
  const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return Math.round(255 * linearToSrgb(Math.max(0, Math.min(1, y))));
}

/**
 * How far apart the singlet and the shorts must stay, in code values, for the
 * figure to read as two tones.
 *
 * 40 on the proxy above. Picked as the largest round number that leaves the
 * *majority* of each team's seven kits untouched -- at 40 it is two of seven for
 * Marita and three for DeFAULT, at 50 it is four apiece, and re-inking four of
 * seven would mean most of a team wore one pair of shorts and the wardrobe had
 * collapsed into a uniform. The cases it catches are the ones that genuinely
 * fail: Marita's teal over gold at 35, and DeFAULT's yellow over cream at **4**.
 */
export const MIN_KIT_GAP = 40;

/**
 * The same bar for the forearm band against the skin under it, and it is lower
 * on purpose: 25.
 *
 * A band is 4 cm of a 0.09 m forearm rather than half a body, so it is read at
 * arm's length and in a fight rather than at fifty metres, and holding it to the
 * silhouette bar would put a white cuff on most of the Marita wardrobe for no
 * gain. At 25 it catches the three kits where the team colour lands *on* the
 * skin tone -- `cobalt/gold`'s mid skin is two code values off Marita's teal,
 * which is a band nobody would ever see and which looks exactly like a band that
 * failed to be applied.
 */
export const MIN_BAND_GAP = 25;

/**
 * A base colourway wearing a team's colours.
 *
 * Pure, total, and the single place the tint is decided -- `world/teamlook.ts`
 * builds geometry from whatever comes back and makes no colour decisions of its
 * own. `TEAM.NONE` returns the base unchanged and **not a copy**, which is what
 * keeps a guest's figure byte-identical to the one this feature never touched.
 */
export function teamKit(base: KitColours, team: Team): KitColours {
  if (team === TEAM.NONE) return base;
  const singlet = hexToLinear(TEAM_COLOUR[team].hex);
  const ink = hexToLinear(inkHex(team));
  const singletY = lumaCode(singlet);
  // The shorts: kept unless they have stopped clearing the singlet, in which
  // case the team's own ink is the replacement. See the header.
  const shorts = Math.abs(lumaCode(base.shorts) - singletY) < MIN_KIT_GAP ? ink : base.shorts;
  // The band: the team colour where it reads against this kit's skin, the ink
  // where it does not.
  const band = Math.abs(lumaCode(base.skin) - singletY) < MIN_BAND_GAP ? ink : singlet;
  return { singlet, shorts, skin: base.skin, shoe: base.shoe, band, trim: ink };
}

/** `TEAM_COLOUR[team].ink` as a hex number. The CSS string is the stored form. */
export function inkHex(team: Team): number {
  const css = TEAM_COLOUR[team].ink;
  return Number.parseInt(css.slice(1), 16) | 0;
}

// --- Budgets --------------------------------------------------------------------------

/**
 * Triangle ceilings, from the brief, and the reason they are constants rather
 * than comments.
 *
 * Sixteen players is the cap (spec 2), everybody takes Big Night (it is the
 * WoW-style tax `game/teams.ts` builds the whole tree around), so **every one of
 * these budgets is paid sixteen times in a full lobby** -- and the cactus budget
 * is paid *instead of* the 440-triangle figure rather than on top of it, which
 * is the only reason 900 is affordable at all. `verifyBigNightKit` measures the
 * built geometry against these; a horn that quietly became a subdivided cone
 * would render beautifully and cost 3,000 triangles a lobby.
 */
export const TRI_BUDGET = {
  /** Two curved horns on the head bone. */
  horns: 300,
  /** The whole cactus figure, head and shoes included -- it replaces the body. */
  cactus: 900,
  /** One sausage-sizzle gazebo. */
  tent: 500,
} as const;

/**
 * Ground rings drawn at once, across auras and megas.
 *
 * Forty rather than sixteen because a ring is drawn per *aura node* a visible
 * player has, not per player: `game/teams.ts` has four aura nodes a Marita and
 * three a DeFAULT can hold at once, and a mega adds a group ring over the top.
 * One `InstancedMesh` either way; the cap exists so the instance buffer is
 * allocated once at construction and `add` past it drops rather than writing off
 * the end -- `world/nameplates.ts`'s `MAX_PLATES` bargain exactly.
 */
export const MAX_RINGS = 40;

// --- The rings ------------------------------------------------------------------------

/** An aura's radius. `game/teams.ts` owns the number; this is the alias the renderer draws. */
export const AURA_RING_M = AURA_M;
/** A mega's group radius, same arrangement. */
export const GROUP_RING_M = GROUP_M;

/** The aura ring pulses at this rate. The brief's 0.5 Hz: one full breath every two seconds. */
export const PULSE_HZ = 0.5;

/**
 * The pulse, 0..1, as a function of seconds. A folded smoothstep rather than a
 * cosine -- see the header's note on determinism.
 *
 * Smoothstep rather than a raw triangle because a linear ramp reversing at the
 * top reads as a flicker: the eye finds the corner. This is C1 at both ends of
 * the fold and therefore breathes.
 */
export function auraPulse(seconds: number): number {
  const phase = (seconds * PULSE_HZ) % 1;
  const t = phase < 0 ? phase + 1 : phase;
  // Fold 0..1 to 0..1..0, then smooth it.
  const f = t < 0.5 ? t * 2 : (1 - t) * 2;
  return f * f * (3 - 2 * f);
}

/**
 * How bright a ring is: the faint aura ring and the stronger mega one.
 *
 * Two numbers rather than one with a multiplier at the call site, because the
 * brief distinguishes them ("a faint ground ring" / "a slightly stronger ring")
 * and a magic 1.6 in the renderer would be a decision with no name. The aura
 * ring is also **only drawn while a teammate is inside it**, which is what stops
 * a full lobby painting the street with circles -- so the faint one is the one a
 * player sees during a fight and the strong one only while a mega is up.
 */
export const RING_ALPHA = { aura: 0.16, group: 0.28 } as const;
/** How much the pulse moves the alpha. At 0.55 the ring never goes out entirely. */
export const RING_PULSE_DEPTH = 0.55;

/** A ring's alpha this instant. Pure, monotone in `base`, and never outside 0..1. */
export function ringAlpha(base: number, seconds: number): number {
  const a = base * (1 - RING_PULSE_DEPTH + RING_PULSE_DEPTH * auraPulse(seconds));
  return Math.max(0, Math.min(1, a));
}

/** The ring's rim, as a fraction of its radius. Thin: it is a boundary, not a disc. */
export const RING_THICKNESS = 0.12;

// --- The slam shockwave ----------------------------------------------------------------

/** `FX.MEGA_SLAM` knocks down everything within this. The ring has to say so exactly. */
export const SLAM_RADIUS_M = 8;
/** And it gets there in this long. The brief's 0.4 s. */
export const SLAM_SECONDS = 0.4;

/**
 * The shockwave at age `seconds`: how wide, and how bright.
 *
 * `radius` is eased *out* -- fast at the start, slowing into the edge -- because
 * the thing being drawn is the arrival of a hit that has already been
 * adjudicated: the knockdown lands on the frame the mega fires, and a ring that
 * accelerated outward would be a wave that looks like it is still deciding. The
 * alpha falls linearly from the start so the ring is brightest at the player's
 * feet, which is where the eye already is.
 *
 * Past `SLAM_SECONDS` it returns alpha 0 and the caller drops the instance.
 * Before 0 -- a clock that arrived out of order -- it returns the first frame
 * rather than a negative radius.
 */
export function slamRing(seconds: number): { radius: number; alpha: number } {
  if (!(seconds > 0)) return { radius: 0, alpha: 1 };
  if (seconds >= SLAM_SECONDS) return { radius: SLAM_RADIUS_M, alpha: 0 };
  const t = seconds / SLAM_SECONDS;
  const eased = 1 - (1 - t) * (1 - t);
  return { radius: SLAM_RADIUS_M * eased, alpha: 1 - t };
}

// --- The Sunday Rush tent ---------------------------------------------------------------

/**
 * The gazebo, in metres. A 3 x 3 m Bunnings pop-up is the real thing and this is
 * it: `world/teamlook.ts` builds to these and `verifyTeamLook` checks they stay
 * a shape a player can walk under rather than a shape that clips their head.
 */
export const TENT = {
  /** Half the footprint. 1.5 m each way is the 3 x 3 m pop-up. */
  half: 1.5,
  /** Underside of the valance. The controller's eye is at 1.68 m; this clears it. */
  eaves: 2.05,
  /** The peak of the canopy. */
  peak: 2.6,
  /** How deep the valance hangs below the eaves. */
  valance: 0.22,
  /** Gores round the canopy. Eight makes four red and four white, which is the awning. */
  gores: 8,
} as const;

/** The tent's two colours, linear. Bunnings red and the white between the stripes. */
export const TENT_RED: Rgb = [0.42, 0.02, 0.02];
export const TENT_WHITE: Rgb = [0.74, 0.74, 0.72];

// --- The map ---------------------------------------------------------------------------

/**
 * Which minimap/big-map marker kind a player takes.
 *
 * A kind per team rather than a colour argument threaded through `minimap.ts`,
 * because that file's `MarkerKind` union is deliberately closed -- its header
 * says a typo in a provider should be a compile error rather than an invisible
 * dot -- and `markerInk` is the one shared switch both maps read. Two kinds is
 * two branches there and nothing else anywhere.
 */
export function teamMarkerKind(team: Team): 'combatant' | 'team-marita' | 'team-default' {
  if (team === TEAM.MARITA) return 'team-marita';
  if (team === TEAM.DEFAULT) return 'team-default';
  return 'combatant';
}

// --- The self-check ----------------------------------------------------------------------

/**
 * Everything above, in both boot lists.
 *
 * On this repo's criterion throughout: **every failure here renders.** A tint
 * that collapsed a kit into one tone draws a perfectly good character who cannot
 * be told from the wall behind them; a pulse that left 0..1 drives an alpha the
 * renderer clamps silently; a slam ring whose radius did not reach 8 m is a
 * shockwave that lies about a knockdown that already landed, and it lies for
 * 0.4 s in a fight where nobody is reading it carefully. None of them throw.
 */
export function verifyTeamLook(): string[] {
  const bad: string[] = [];

  // --- The two names, and the rule that there is one place they are spelt.
  // `verifyTeams` greps the contract's own strings; this asserts the thing *this*
  // workstream could get wrong, which is drawing a literal instead of the table.
  if (TEAM_NAME[TEAM.MARITA] !== 'Marita' || TEAM_NAME[TEAM.DEFAULT] !== 'DeFAULT') {
    bad.push('TEAM_NAME is not the owner\'s spelling; every plate and pill in the renderer draws from it.');
  }

  // --- The colour round trip. A hex that did not survive sRGB -> linear -> code
  // value would put both teams at a plausible wrong brightness and every
  // threshold below would be measuring the wrong thing.
  for (const team of [TEAM.MARITA, TEAM.DEFAULT] as const) {
    const lin = hexToLinear(TEAM_COLOUR[team].hex);
    for (const c of lin) {
      if (!(c >= 0 && c <= 1)) bad.push(`${TEAM_NAME[team]}'s colour converted to a linear channel of ${c}.`);
    }
    const back = Math.round(255 * linearToSrgb(lin[0]));
    if (Math.abs(back - ((TEAM_COLOUR[team].hex >> 16) & 0xff)) > 1) {
      bad.push(`${TEAM_NAME[team]}'s red channel did not survive the sRGB round trip: ${back}.`);
    }
  }
  // The two teams must not be the same brightness *and* the same hue family --
  // the whole point of a tint is that a street can be read at a glance.
  const maritaY = lumaCode(hexToLinear(TEAM_COLOUR[TEAM.MARITA].hex));
  const defaultY = lumaCode(hexToLinear(TEAM_COLOUR[TEAM.DEFAULT].hex));
  if (Math.abs(maritaY - defaultY) < MIN_KIT_GAP) {
    bad.push(
      `${TEAM_NAME[TEAM.MARITA]} (Y' ${maritaY}) and ${TEAM_NAME[TEAM.DEFAULT]} (Y' ${defaultY}) are ` +
        `${Math.abs(maritaY - defaultY)} code values apart. Two teams at one value is one team at fifty metres.`,
    );
  }

  // --- The tint, over the whole wardrobe. This is the check the file exists for.
  //
  // `PALETTE_PROBE` restates `character.COLOURWAYS` rather than importing it,
  // for the reason the whole file is structural: `character.ts` imports three and
  // this runs in Bun. The restatement is guarded from the other side --
  // `verifyCharacterKit` in `world/teamlook.ts` compares the two arrays against
  // each other in the browser, where both are reachable -- which is the same
  // arrangement `world/nameplates.ts` uses for `MAX_PIPS` and
  // `game/dummies.ts` for `server/bots.ts`' ranges.
  for (const kit of PALETTE_PROBE) {
    for (const team of [TEAM.MARITA, TEAM.DEFAULT] as const) {
      const tinted = teamKit(kit, team);
      const gap = Math.abs(lumaCode(tinted.singlet) - lumaCode(tinted.shorts));
      if (gap < MIN_KIT_GAP) {
        bad.push(
          `A ${TEAM_NAME[team]} in "${kit.name}" has a singlet ${gap} code values from its shorts ` +
            `(bar is ${MIN_KIT_GAP}). character.ts's palette is tuned so a player is a two-tone ` +
            `silhouette at fifty metres, and the tint has flattened this one.`,
        );
      }
      const bandGap = Math.abs(lumaCode(tinted.band ?? tinted.skin) - lumaCode(tinted.skin));
      if (bandGap < MIN_BAND_GAP) {
        bad.push(`A ${TEAM_NAME[team]} in "${kit.name}" has a forearm band ${bandGap} code values from the arm it is on.`);
      }
      if (tinted.trim === undefined) bad.push(`A ${TEAM_NAME[team]} kit has no trim; the collar would stay the team colour on the team colour.`);
      // And the tint must actually be the team colour rather than something
      // shaded toward the kit -- see the header's rejected alternative.
      if (lumaCode(tinted.singlet) !== (team === TEAM.MARITA ? maritaY : defaultY)) {
        bad.push(`A ${TEAM_NAME[team]} singlet is not ${TEAM_COLOUR[team].css}; the team colour has been shaded per kit.`);
      }
    }
    // A guest is untouched, and identically so -- `teamKit` returns the argument.
    if (teamKit(kit, TEAM.NONE) !== kit) {
      bad.push('A guest\'s kit was rebuilt rather than passed through; guests are meant to be unchanged.');
    }
  }
  // The re-inking must be the exception rather than the wardrobe. Two of seven
  // per team is what the thresholds were set to produce; if a palette change
  // ever pushed it to four, most of a team would be wearing the same shorts and
  // the tint would have eaten the colourways it is drawn over.
  for (const team of [TEAM.MARITA, TEAM.DEFAULT] as const) {
    const reinked = PALETTE_PROBE.filter((k) => teamKit(k, team).shorts !== k.shorts).length;
    if (reinked > 3) {
      bad.push(
        `${reinked} of ${PALETTE_PROBE.length} ${TEAM_NAME[team]} kits had their shorts re-inked. ` +
          `Past three the wardrobe has collapsed into a uniform and the seven colourways stop meaning anything.`,
      );
    }
  }

  // --- The pulse. In range, periodic, and it must actually move -- a constant
  // pulse is a ring that renders perfectly and says nothing.
  {
    let lo = Infinity;
    let hi = -Infinity;
    for (let s = 0; s <= 8; s += 1 / 60) {
      const p = auraPulse(s);
      if (!(p >= 0 && p <= 1)) {
        bad.push(`auraPulse(${s.toFixed(3)}) is ${p}, which is not a 0..1 pulse.`);
        break;
      }
      lo = Math.min(lo, p);
      hi = Math.max(hi, p);
    }
    if (hi - lo < 0.8) bad.push(`The aura pulse only spans ${(hi - lo).toFixed(2)} of its range; the ring barely breathes.`);
    const period = 1 / PULSE_HZ;
    if (Math.abs(auraPulse(0.37) - auraPulse(0.37 + period)) > 1e-9) {
      bad.push('The aura pulse is not periodic at 1/PULSE_HZ; two players\' rings would drift apart.');
    }
    if (auraPulse(-0.3) < 0 || auraPulse(-0.3) > 1) bad.push('A negative clock produced a pulse outside 0..1.');
  }
  // And the alphas it drives: in range, ordered, and never fully out.
  for (const s of [0, 0.25, 0.5, 1, 1.7, 3.3]) {
    const a = ringAlpha(RING_ALPHA.aura, s);
    const g = ringAlpha(RING_ALPHA.group, s);
    if (!(a > 0 && a <= 1) || !(g > 0 && g <= 1)) bad.push(`Ring alphas at ${s}s are ${a}/${g}, outside (0, 1].`);
    if (g <= a) bad.push(`A mega's ring (${g}) is not stronger than an aura's (${a}) at ${s}s; the brief distinguishes them.`);
  }
  if (!(RING_THICKNESS > 0.02 && RING_THICKNESS < 0.3)) {
    bad.push(`The ring rim is ${RING_THICKNESS} of its radius; under 0.02 it aliases away and over 0.3 it is a disc.`);
  }
  if (MAX_RINGS < 16) bad.push(`${MAX_RINGS} ring instances cannot cover a sixteen-player lobby.`);

  // --- The rings' radii come from the contract rather than from here.
  if (AURA_RING_M !== AURA_M || GROUP_RING_M !== GROUP_M) {
    bad.push('The drawn aura/group radii have drifted from game/teams.ts. The ring would lie about where the buff reaches.');
  }

  // --- The slam. It has to reach exactly the radius the mega knocks down at,
  // arrive in the time the brief gives it, and be monotone the whole way -- a
  // ring that overshot 8 m is a promise the hit test did not make.
  {
    let previous = -1;
    for (let s = 0; s <= SLAM_SECONDS + 0.2; s += 0.01) {
      const { radius, alpha } = slamRing(s);
      if (radius < previous - 1e-9) {
        bad.push(`The slam ring shrank at ${s.toFixed(2)}s: ${radius} after ${previous}.`);
        break;
      }
      if (radius > SLAM_RADIUS_M + 1e-9) {
        bad.push(`The slam ring reached ${radius} m against a mega that knocks down at ${SLAM_RADIUS_M} m.`);
        break;
      }
      if (!(alpha >= 0 && alpha <= 1)) {
        bad.push(`The slam ring's alpha at ${s.toFixed(2)}s is ${alpha}.`);
        break;
      }
      previous = radius;
    }
    if (Math.abs(slamRing(SLAM_SECONDS).radius - SLAM_RADIUS_M) > 1e-9) {
      bad.push(`The slam ring ends at ${slamRing(SLAM_SECONDS).radius} m rather than at the mega's ${SLAM_RADIUS_M} m.`);
    }
    if (slamRing(SLAM_SECONDS).alpha !== 0) bad.push('The slam ring never fades out; the instance would be held forever.');
    if (slamRing(0.001).radius >= SLAM_RADIUS_M / 2) bad.push('The slam ring is already half-grown on its first frame.');
  }

  // --- The tent, as a thing a player walks under rather than into.
  if (TENT.eaves < 1.9) bad.push(`The tent's eaves are at ${TENT.eaves} m and the controller's eye is at 1.68 m; a player would walk into the valance.`);
  if (TENT.eaves - TENT.valance < 1.75) bad.push(`The valance hangs to ${(TENT.eaves - TENT.valance).toFixed(2)} m, which is inside a standing player's head.`);
  if (TENT.peak <= TENT.eaves) bad.push('The tent\'s peak is not above its eaves; the canopy would be inside out.');
  if (TENT.half < 1 || TENT.half > 2.5) bad.push(`The tent is ${TENT.half * 2} m across; a Bunnings pop-up is 3 m.`);
  if (TENT.gores % 2 !== 0) bad.push(`${TENT.gores} gores cannot alternate red and white.`);
  if (Math.abs(lumaCode(TENT_RED) - lumaCode(TENT_WHITE)) < 60) {
    bad.push('The tent\'s stripes are the same value; a striped awning that does not stripe is a grey box.');
  }

  // --- The budgets are numbers a builder can read, and they are in the right order.
  if (TRI_BUDGET.horns >= TRI_BUDGET.cactus) bad.push('Two horns are budgeted at or above a whole cactus body.');
  for (const [name, n] of Object.entries(TRI_BUDGET)) {
    if (!Number.isInteger(n) || n <= 0) bad.push(`The ${name} budget is ${n}.`);
  }

  // --- The map kinds. Distinct, and a guest is still a combatant.
  if (teamMarkerKind(TEAM.NONE) !== 'combatant') bad.push('A player with no team lost their combatant dot.');
  if (teamMarkerKind(TEAM.MARITA) === teamMarkerKind(TEAM.DEFAULT)) bad.push('Both teams take one marker kind; the map would draw them alike.');

  return bad;
}

/**
 * The seven player colourways, restated for the check above.
 *
 * A restatement and not an import, for the reason the whole file gives: this
 * runs in Bun and `player/character.ts` imports three. `verifyCharacterKit` in
 * `world/teamlook.ts` is the other half -- it runs in the browser, where both
 * this array and the real `COLOURWAYS` are reachable, and asserts they are the
 * same numbers. Neither half is enough alone and together they are the same
 * arrangement `world/nameplates.MAX_PIPS` uses against `combat.MAX_HEALTH`.
 */
export const PALETTE_PROBE: ReadonlyArray<KitColours & { name: string }> = [
  { name: 'cobalt/gold', singlet: [0.045, 0.115, 0.44], shorts: [0.55, 0.34, 0.045], skin: [0.3, 0.19, 0.13], shoe: [0.72, 0.72, 0.7] },
  { name: 'red/black', singlet: [0.62, 0.07, 0.05], shorts: [0.035, 0.033, 0.036], skin: [0.52, 0.36, 0.29], shoe: [0.04, 0.04, 0.042] },
  { name: 'green/cream', singlet: [0.03, 0.15, 0.052], shorts: [0.7, 0.66, 0.5], skin: [0.13, 0.075, 0.05], shoe: [0.72, 0.72, 0.7] },
  { name: 'purple/white', singlet: [0.17, 0.055, 0.34], shorts: [0.78, 0.78, 0.79], skin: [0.46, 0.31, 0.24], shoe: [0.04, 0.04, 0.042] },
  { name: 'orange/navy', singlet: [0.62, 0.19, 0.03], shorts: [0.035, 0.05, 0.16], skin: [0.21, 0.13, 0.085], shoe: [0.72, 0.72, 0.7] },
  { name: 'teal/pink', singlet: [0.02, 0.105, 0.11], shorts: [0.7, 0.24, 0.34], skin: [0.38, 0.25, 0.18], shoe: [0.04, 0.04, 0.042] },
  { name: 'charcoal/yellow', singlet: [0.055, 0.055, 0.06], shorts: [0.72, 0.55, 0.055], skin: [0.075, 0.043, 0.03], shoe: [0.72, 0.72, 0.7] },
];
