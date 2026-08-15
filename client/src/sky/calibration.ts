/**
 * The light rig itself, and the self-check that stops it silently regressing.
 *
 * Spec section 7.1 asks for one thing that no amount of shader work substitutes
 * for: **harsh, high contrast, deep shadows, blown highlights, hard blue sky.
 * Not soft, not grey, not European.** That is a statement about *ratios and
 * absolute levels*, so this file holds the numbers and the arithmetic that
 * justifies them, and `sky.ts` holds only the plumbing that applies them.
 *
 * Everything here is pure and framework-free on purpose: it can be run in Node
 * against the same `solar.ts` the renderer uses, which is how the values below
 * were measured rather than guessed. The previous set was tuned blind and was
 * wrong in three separate ways at once (see the table further down).
 *
 * ---------------------------------------------------------------------------
 * How a number here becomes a pixel, so the arithmetic can be checked:
 *
 *   irradiance E  =  sunIntensity    * max(0, N.Lsun)    * sunColour    (direct)
 *                 +  mix(groundColour, skyColour, 0.5*N.y + 0.5) * hemisphereIntensity
 *                 +  bounceIntensity * max(0, N.Lbounce) * bounceColour (bounce)
 *
 * three's `DirectionalLightNode` contributes `dot(N,L) * colour * intensity` and
 * `HemisphereLightNode` adds `mix(ground, sky, w) * intensity` straight into
 * `irradiance` with no pi anywhere; `BRDF_Lambert` then divides by pi. So a
 * matte surface of linear albedo `a` leaves the shader at `a/pi * E`, and the
 * output pass multiplies by `toneMappingExposure` and applies the tone curve.
 * Every predicted value in the comments below was produced by that chain.
 *
 * The third term is new, and the section on `BOUNCE_FRACTION` below explains
 * both why the first two were not enough and how its size was measured.
 * ---------------------------------------------------------------------------
 */

import { directionFrom, solarPosition, sydneyTime } from './solar.ts';

/** Sydney. Repeated from `main.ts` so this file can be run standalone. */
const LATITUDE = -33.87;
const LONGITUDE = 151.21;

/**
 * Direct-beam intensity with the sun at the zenith and no atmosphere in the way.
 *
 * The old value was 3.45 at the zenith, and it was not weak in isolation -- it
 * was weak *relative to the sky dome*. `SkyMesh` is a Preetham model with its
 * own absolute scale, and at 3 pm in February it puts about 0.96 of linear
 * radiance at the zenith and about 7.8 at the horizon haze band. Against that,
 * a sunlit concrete footpath under the old rig left the shader at 0.43 -- less
 * than half the brightness of the sky directly overhead. A photograph of a
 * Sydney street has sunlit concrete at roughly 2.4x the zenith luminance, not
 * 0.45x, and a scene where the sky is the brightest thing in frame is the
 * definition of "overcast". 17.0 puts the ground back on the right side of it.
 */
export const SUN_ZENITH_INTENSITY = 17.0;

/**
 * Broadband atmospheric extinction optical depth for a clean coastal sky.
 *
 * The old intensity curve was `0.35 + 3.1 * (alt/90)^0.42`: a shape chosen to
 * look plausible, with a 0.35 floor that kept the sun burning after it had set.
 * That was replaced with the physical thing -- Beer-Lambert against Kasten-Young
 * air mass -- which costs the same and gets the ends right for free. The sun
 * fades and reddens together as it drops, and reaches zero at the horizon
 * instead of a tenth of noon.
 *
 * **And then the day/night pass found that it was too aggressive at low sun,
 * which cost the game its golden hour.** Straight Beer-Lambert against air mass
 * assumes a uniform atmosphere, and the standard empirical correction for that
 * is Meinel's -- direct normal irradiance goes as `0.7^(AM^0.678)` rather than
 * `0.7^AM`, because the aerosol and water vapour that do most of the absorbing
 * live in the bottom kilometre and a slant path does *not* sample proportionally
 * more of them. The difference is everything at the end of the day:
 *
 *     solar altitude      10 deg   6 deg   4 deg   2 deg
 *     Meinel (real)        0.455   0.299   0.201   0.098
 *     exp(-k(AM-1))        0.231   0.081   0.027   0.003
 *     exp(-k(AM^0.678-1))  0.418   0.263   0.171   0.077
 *
 * The middle row is what shipped before this pass: at 6 degrees -- 139 real
 * seconds before sunset, the *middle of the golden hour* -- it put 8% of noon on
 * the beam where the real sky delivers 30%. So there was no golden light on
 * anything. The whole city was lit by skylight alone for the last four minutes
 * of every day, which is why the first screenshots of this cycle's golden hour
 * came back reading as overcast rather than as golden. The bottom row is what
 * ships now.
 *
 * **0.40 rather than the old 0.32, and the coefficient was re-solved rather than
 * kept**: the exponent changes the shape at *both* ends, and 0.40 is the value
 * that leaves the reference instant where the whole of this file was calibrated
 * against it. Sun intensity at 57.11 degrees goes from 16.00 to 16.16 -- **1.0%,
 * under half a code value on a sunlit footpath** -- and every ratio bounded at
 * the bottom of this file stays comfortably inside its window. `verifyLightRig`
 * checks both ends: the reference is still in band, and there is now a case that
 * fails if the golden hour ever goes dark again.
 */
export const SUN_EXTINCTION = 0.4;

/**
 * The Meinel exponent. See `SUN_EXTINCTION`; 0.678 is the published value and
 * there is no reason to treat it as a free parameter.
 */
export const AIR_MASS_POWER = 0.678;

/**
 * Degrees of altitude over which the beam fades out as the disc sets.
 *
 * Needed only because of the change above. Under straight Beer-Lambert the beam
 * was already down to 0.3% of noon at the horizon, so cutting it to zero there
 * was a step nobody could see; under Meinel it is at 2%, which on a sunlit wall
 * is a fifth of its irradiance disappearing between two frames.
 *
 * 0.9 degrees, and it is not a fudge: the solar disc is 0.53 degrees across, so
 * the beam genuinely does ramp out over about that much altitude as the disc
 * goes under -- and the last of it is crossing 35 air masses, where the same
 * refraction that keeps the disc visible after geometric sunset has also spread
 * and dimmed it. Smoothstepped, so there is no corner at either end. It costs
 * the last 20 real seconds of beam, which is time the limb in `dusk.ts` has
 * already taken over.
 */
export const HORIZON_FADE_DEGREES = 0.9;

/**
 * Hemisphere fill, full daylight.
 *
 * Deliberately still weak: this is the number that decides how deep shade is,
 * and a strong ambient is exactly what makes a render read as overcast Europe.
 * It is set by the ratio below, not by taste -- 3.4 against a sky colour of
 * luminance 0.68 gives 2.31 of diffuse irradiance on a horizontal surface
 * against 13.4 of direct, which is the measured Sydney clear-sky split.
 *
 * Note this is *sky* fill only. Real shade in a real street also gets bounce off
 * sunlit concrete and render, which is a large warm term. That term now exists
 * as its own light -- see `BOUNCE_FRACTION` -- and this number is still not the
 * place to spend on shade. Raising it lifts *every* surface at every orientation
 * including the sunlit ground, so it flattens the whole image rather than opening
 * up the shade, and it is bluer than shade actually is. The warning that used to
 * stand here stands unchanged; the difference is that there is now somewhere else
 * to put the light.
 */
export const HEMISPHERE_DAY = 3.4;

/**
 * Hemisphere fill after dark.
 *
 * It was 0.30, chosen to land night at the same luminance the rig before it
 * produced -- the old (0.08 intensity, 0.30/0.42/0.62 colour) under ACES at 0.86
 * exposure and the new (0.30, 0.185/0.259/0.382) under Neutral at 0.62 differ by
 * under a code value on a mid-grey surface -- so that the day/night pass changed
 * daylight only.
 *
 * It was 0.33 for one pass after that, because somebody who had played the night
 * asked for the ground and the building faces to come up "only like 10%". The
 * note is worth keeping because it says exactly which term is meant: not the
 * lamps, not the torch, not the rave -- the *floor*, the light on everything
 * that has no lamp near it, which is what decides whether an unlit back street
 * is a place or a wall. This is the only number in the file that sets it. Ten
 * per cent was a seventh of a stop: `nightAmbientOnWall` went from 0.0631 to
 * 0.0695 of luminance and a 0.25-albedo wall from a display value of 11 to 11.5.
 * The paragraph that used to stand here said "the *next* ten per cent will feel
 * just as small", and it was right.
 *
 * ---------------------------------------------------------------------------
 * **IT IS 1.155 NOW: THE SAME PLAYER, BACK, WITH "I CANT SEE SHIT AT NIGHT RN"
 * AND A NUMBER -- RAISE THE NIGHT AMBIENT BY 250 PER CENT.**
 *
 * 250% is 3.5x, taken literally, and the reason it survived being checked is
 * that it lands almost exactly on the limit this file had already written down
 * for itself. The floor goes 0.0695 -> 0.2431 of luminance on a shaded wall, and
 * what that is worth on screen, through Lambert and `EXPOSURE`:
 *
 * ```
 *                                  albedo 0.25 wall   asphalt 0.08   under a lamp
 *   before  (floor 0.0695)                11               4              32
 *   after   (floor 0.2431)                29              12              36
 * ```
 *
 * A wall at 11 is a silhouette and 4 on the road is black -- which is the report,
 * stated in display values. At 29 and 12 you can see a kerb, a parked car and a
 * front fence with no lamp anywhere near you, and the sky above them is still
 * black, which is what keeps it night. Nothing about the *sources* moved: the
 * lamp pool is still 36 against the 12 beside it, the torch still blows out a
 * wall at arm's length, and the lit windows and the rave are where they were.
 *
 * **Why 3.5x and not more, in this file's own terms.** Every night term below is
 * quoted as a ratio to this floor, and the tightest of them is the one
 * `verifyLightRig` actually asserts: the torch must put **4x the ambient on a
 * wall 10 m away**, which is what makes a dark street navigable by torch rather
 * than merely lighter. That ratio was 15.2x and is now **4.34x**. So the player's
 * number is, to within a few per cent, the exact distance the floor can travel
 * before the torch stops being the thing that lights a street -- and past it the
 * torch, the lamps and the headlights would all have to be re-derived rather
 * than nudged. `NIGHT_AMBIENT_FLOOR_MAX` has moved with the floor and is what
 * stops the *next* request being served the same way.
 *
 * The moon is still an event and that was checked rather than hoped: everything
 * in `skyglow.ts` is a multiple of this constant, so a full moon overhead still
 * lands at 2.2x the moonless floor -- a wall at 45 against 29 -- and a first
 * quarter still at 9% of that (see `MOON_PHASE_POWER`).
 *
 * **Daylight is untouched and provably so.** `solarRig` blends this to
 * `HEMISPHERE_DAY` on the civil-twilight ramp, which reaches exactly 1 at and
 * above 6 degrees of altitude, so the hemisphere at the 57.11-degree reference
 * instant is `HEMISPHERE_DAY` and nothing else. `verifyLightRig` asserts that
 * from the other end rather than trusting the arithmetic here. What *does* move
 * with this is the middle of civil twilight, where the ramp is half way: the
 * fill there goes from 1.87 to 2.28, a fifth of a stop on a sky that is already
 * changing faster than that. There is nothing calibrated at that altitude.
 */
export const HEMISPHERE_NIGHT = 1.155;

/**
 * The ceiling on the night ambient floor, as luminance on a shaded wall.
 *
 * A bound rather than a value, and it guards the one thing about the night that
 * cannot be seen going wrong: `HEMISPHERE_NIGHT` is a single number that lifts
 * *every* surface at *every* orientation at once, so raising it is always the
 * cheapest way to make a dark scene readable and always the wrong one past a
 * point. Past that point the city stops being lit by its lamps and starts being
 * lit by nothing at all -- a flat, sourceless grey that reads as a broken
 * exposure rather than as night, and which takes the street lamps, the torch and
 * the headlights down with it, because every one of them is quoted as a ratio to
 * this floor.
 *
 * **It was 0.09 and it is 0.25, and the move is the point rather than a
 * formality.** 0.09 was half a stop of headroom over a floor of 0.0695;
 * `HEMISPHERE_NIGHT` has since gone to 3.5x on a player's number and the floor
 * with it, to 0.2431, so a ceiling left at 0.09 would simply have failed the
 * build on the change it was meant to be judging. Moving it is therefore not the
 * guard being weakened -- it is the guard being **re-measured against the thing
 * it actually guards**, which is the ratio of the sources to the floor.
 *
 * The new number is derived from the tightest of those ratios rather than picked
 * as round headroom. `verifyLightRig` requires the torch to put 4x the ambient
 * on a wall at 10 m, and the torch puts 1.056 there; 1.056 / 4 = **0.264 of
 * floor is the arithmetic ceiling**, at which the torch is exactly as bright as
 * the night and does nothing. 0.25 sits just inside it, which leaves the current
 * 0.2431 with about 3% of room -- deliberately almost none. There is no further
 * increment of this constant available: the next request for a brighter night
 * has to raise the *sources* and re-derive the table under `TORCH_INTENSITY`,
 * which is the work that was avoided this time and cannot be avoided twice.
 *
 * What is on the other side of it is unchanged and is why the bound exists at
 * all: past this point the city stops being lit by its lamps and starts being
 * lit by nothing at all -- a flat, sourceless grey that reads as a broken
 * exposure rather than as night, taking the street lamps, the torch and the
 * headlights down with it, because every one of them is quoted as a ratio to
 * this floor.
 */
export const NIGHT_AMBIENT_FLOOR_MAX = 0.25;

/**
 * And the other end of the same bound, which used to be a bare `0.05` inside
 * `verifyLightRig` and is a named constant now because its job changed.
 *
 * 0.05 was the *absent* threshold: below it a street with no lamp on it has no
 * silhouette at all, because a silhouette needs the thing in front of the sky to
 * be lit by something. That sentence is still true and 0.05 is still where it
 * stops being true -- but with the floor at 0.2431 it is five times away, which
 * means it no longer guards anything anybody would actually do.
 *
 * What needs guarding now is the *player's request*. "i cant see shit at night"
 * was answered with one constant, and one constant is exactly as easy to halve
 * as it was to raise -- by somebody a year from now who thinks the night looks
 * washed out in the one screenshot they are judging, which it will, because a
 * night that is comfortable to play in always looks flat in a still. 0.2 is just
 * under the shipped 0.2431, so the answer cannot be quietly undone; anybody who
 * genuinely means to take the night back down has to move this line and read the
 * paragraph attached to it.
 */
export const NIGHT_AMBIENT_FLOOR_MIN = 0.2;

/**
 * Hemisphere sky colour, linear, day and night endpoints.
 *
 * Blue, and more so than the old (0.62, 0.77, 0.91), which was nearly neutral.
 * A cosine-weighted average of the Preetham dome at 3 pm is bluer still --
 * about (0.30, 0.60, 1.00) -- and the reason this sits between the sky and
 * neutral used to be that it was also standing in for what little bounce
 * existed. The bounce light below now carries that job properly, so the argument
 * for the compromise is gone and the honest move would be to go bluer.
 *
 * It is left where it is, and deliberately: this colour's luminance is pinned
 * from both ends by the two checks at the bottom of this file -- it sets the
 * shaded half of the horizontal sun:shade ratio and a sixth of the sunlit half
 * -- and going bluer at constant luminance takes green out and blue in, which
 * lands entirely on the shaded road. Shaded asphalt is already the bluest thing
 * in the frame and pushing it further is the opposite of this pass's brief.
 * The warmth in shade belongs in a term with the right *geometry*, which is what
 * the bounce is, not in the one that lights everything from straight up.
 */
export const SKY_FILL_DAY: Readonly<Rgb> = [0.48, 0.7, 1.0];
export const SKY_FILL_NIGHT: Readonly<Rgb> = [0.185, 0.259, 0.382];

/**
 * The third endpoint of the fill: the colour the sky half turns at dusk.
 *
 * Added by the day/night pass, and it is the term that makes the *city* catch
 * the sunset rather than just the sky. The two endpoints above are a day and a
 * night, and between them the fill only ever gets darker and slightly bluer --
 * which is a defensible model of a clear zenith and a completely wrong model of
 * the thing that is actually lighting a street at 7 pm. At sunset the sun's own
 * beam is down to 5% of noon by Beer-Lambert, so **the sky is the light source**,
 * and the sky is orange. A hemisphere that stays blue through that puts a
 * burning horizon behind a city lit as though it were an overcast afternoon,
 * which is the single most common way a game sunset fails to land.
 *
 * Blended in by `warmthAt(altitude) * day`, so:
 *
 *   - It is **exactly zero above `SUN_WARM_KNEE`** (42 degrees), which is what
 *     keeps every calibrated value in this file, in `clouds.ts` and in
 *     `facade.ts` untouched -- all of them were measured at 57.11 degrees.
 *   - The `day` factor is the civil-twilight ramp the fill already uses, so the
 *     warmth dies with the light rather than leaving an orange floor over a
 *     night scene. `verifyLightRig` asserts both ends.
 *
 * Not as saturated as `dusk.ts`'s `LIMB_COLOUR`, and deliberately: that is the
 * radiance of the burning band itself, and this is the *hemispherical average*
 * of a sky which is orange at the bottom, violet opposite and still deep blue
 * overhead. R/B 2.5 against the limb's 12.5. What it produces on the ground is
 * a shaded wall at R/B 1.68 against daylight's 1.13 -- warm-grey rather than
 * blue-grey, which is what a photograph of Crown Street at ten past seven shows.
 *
 * **There is no separate strength constant, and the reason is worth reading.**
 * The blend weight is `warmthAt(alt) * day`, and those two move in opposite
 * directions -- the warmth climbs as the sun drops, the civil-twilight ramp
 * falls. Their product peaks at **0.781, with the sun 6 degrees up**, and is back
 * to 0.5 by the moment of sunset and zero by the end of twilight. So the fill is
 * at its warmest during the golden hour and then *cools* into the blue hour
 * while the horizon behind it is still burning, which is exactly what happens
 * outside: the warm light on the buildings goes before the colour in the sky
 * does. It fell out of the gating rather than being designed, it is right, and a
 * strength constant on top of it would only be a way to break it.
 */
export const SKY_FILL_DUSK: Readonly<Rgb> = [1.0, 0.66, 0.4];

/**
 * Hemisphere ground colour, linear. Warm, because what bounces up off a Sydney
 * street is sandstone kerb, buff footpath and blue-metal road.
 *
 * It is no longer the only warmth in shade -- the bounce light below is now the
 * large term -- and it was measured as a lever for this pass and rejected as
 * one. The hemisphere weights it by `1 - (0.5*N.y + 0.5)`, so it reaches a
 * vertical wall at half strength and an up-facing surface not at all, which is
 * the right *shape* for bounce but the wrong *size*: at HEMISPHERE_DAY 3.4 it
 * takes a raise of 0.59 to put one unit of irradiance on a wall, and that same
 * raise lands on the *sunlit* wall too and moves red brick 12 code values. Sweeping
 * it from 0.20 to 0.32 buys two display values of shaded brick and costs two of
 * sunlit brick. It is kept as the soffit-and-underside term it is good at.
 */
export const GROUND_FILL: Readonly<Rgb> = [0.2, 0.165, 0.115];

/* ---------------------------------------------------------------------------
 * The bounce: light off the sunlit pavement and the sunlit facade opposite.
 *
 * Everything above models shade as skylight and nothing else, and skylight from
 * a HemisphereLight reaches a vertical wall as `mix(ground, sky, 0.5)` -- half
 * blue sky, half a token warm floor. At 3 pm that is (1.156, 1.470, 1.895) of
 * irradiance on the shaded side of a street, which is both too little and the
 * wrong colour: red brick came out at rgb(48, 14, 7) and asphalt at
 * rgb(15, 38, 59). Charcoal silhouettes with a blue cast, and a wall you cannot
 * count the windows on.
 *
 * How much is actually missing was measured rather than guessed, by integrating
 * the hemisphere of a real street canyon: two parallel walls of height H, a
 * street of width W, the sun at 57.1 degrees, radiosity iterated to convergence
 * so the walls and the ground light each other rather than each being a single
 * bounce. Sky radiance in that integration is taken from this rig's own
 * hemisphere (uniform, `skyColour * HEMISPHERE_DAY / pi`) so the answer is on
 * the same scale as the numbers above and can be subtracted from them.
 *
 * For a 16 m street with 8 m walls, irradiance on the shaded wall converges to:
 *
 *     h = 1.0 m   (2.112, 2.112, 2.217)   lum 2.12   R/B 0.95
 *     h = 2.5 m   (2.407, 2.414, 2.529)   lum 2.42   R/B 0.95
 *     h = 6.0 m   (2.739, 2.811, 3.012)   lum 2.81   R/B 0.91
 *
 * against this rig's (1.156, 1.470, 1.895), lum 1.43, R/B 0.61. Two things fall
 * out of that, and they are the whole design:
 *
 *   - the level is short by about 1.7x, and
 *   - the *hue* is wrong. Real shade in a street is close to neutral, warm-side;
 *     this rig's is 1.6 parts blue to one part red.
 *
 * It also reproduces the thing a photograph shows and the rig cannot: the shade
 * is warmest low down (R/B 0.95 at a metre, where the wall sees mostly sunlit
 * road) and cools going up (0.91 at six metres, where it sees more sky).
 *
 * Two other measurements ruled out the obvious alternatives:
 *
 *   - A dome with the real horizon-bright gradient rather than a uniform one
 *     was tried, on the theory that a wall in a canyon sees mostly the bright
 *     haze band and the uniform assumption understates it. Normalised to the
 *     same up-facing irradiance it is worth a factor of 1.02 to 1.21 depending
 *     on how open the street is, and it moves R/B from 0.52 to 0.58. Real, and
 *     nowhere near enough to explain the gap. Recorded so nobody re-derives it.
 *   - The same integration says the shaded *ground* is already over-lit here,
 *     not under-lit: it converges to lum 1.79-2.18 against the 2.30 this rig
 *     gives an up-facing surface, and puts the physical ground sun:shade at
 *     8.3:1 against the rig's 6.9:1. So the road is not where the missing light
 *     goes, which is exactly why the term below is aimed the way it is.
 * ------------------------------------------------------------------------- */

/**
 * Where the bounce comes from: degrees above the horizon, on the bearing
 * *opposite* the sun.
 *
 * Opposite the sun is what makes this affordable. A surface turned to the sun
 * has `N.Lbounce < 0` and takes nothing from this light at all, so the sunlit
 * half of the frame -- which is calibrated, and correct -- does not move by a
 * single code value. A surface turned away takes it in full. In between it
 * ramps with the cosine, so the shaded side of a street gets a *gradient* across
 * its orientations rather than a flat fill, which is the thing a constant
 * ambient can never do.
 *
 * That geometry is also honest rather than a trick: the bounce a shaded wall
 * receives comes from the sunlit road and the sunlit facade across the street,
 * and those are on the sun's side of it. Its one lie is that a sunlit wall in a
 * real street receives bounce too. That is a few per cent of a surface which is
 * 90% direct beam, and it is the price of pinning the sunlit calibration.
 *
 * 16 degrees is a compromise between two different jobs and the number is the
 * only place they can both be served. The luminance-weighted elevation of the
 * bounce arriving at a *wall* runs from -22 to +13 degrees across the street
 * sections integrated above -- near or below the horizon in the low-rise inner
 * suburbs, above it only in a CBD canyon -- because a wall sees mostly ground.
 * The bounce arriving at a *ground* point comes off the sunlit facade opposite,
 * which stands above it at 0-30 degrees. One directional light must pick one
 * elevation for both, and it trades along `tan`: every degree of altitude moves
 * energy off the walls and onto the road, where the sunlit road is what runs out
 * of budget first. 16 splits them, and lands both display targets at once.
 */
export const BOUNCE_ALTITUDE = 16;

/**
 * Bounce colour, linear, scaled so the largest channel is 1 like the sky fill.
 *
 * Derived, not chosen: it is the *residual* -- the converged canyon irradiance
 * on a shaded wall at mid height, (2.407, 2.414, 2.529), minus what the
 * hemisphere already delivers there, (1.156, 1.470, 1.895). That leaves
 * (1.251, 0.944, 0.634), which normalises to this.
 *
 * It is warmer than the street it comes off -- an area-weighted Sydney street is
 * about (0.312, 0.272, 0.231) of reflectance, R/B 1.35, and this is R/B 1.97 --
 * and the difference is not fudge. The hemisphere's contribution to a wall is
 * already too blue, so the term that corrects it has to be warm enough to fix
 * the total rather than merely warm in isolation. Sum the two and the shaded
 * wall lands at R/B 1.13 against the canyon's 0.95: warm-side of neutral, which
 * is where a measured street sits.
 *
 * Sanity check on the other end, which is what stops this reading as sunset:
 * shaded painted render comes out rgb(164, 156, 145) -- a warm grey, seven code
 * values of red over blue. Nothing neutral in the city turns orange.
 */
export const BOUNCE_COLOUR: Readonly<Rgb> = [1.0, 0.754, 0.507];

/**
 * Bounce strength, as a fraction of the direct beam landing on the pavement.
 *
 * Written this way rather than as a bare intensity because that is what it
 * physically is -- sunlight that hit the road and came back -- and because it
 * makes the day/night behaviour correct for free. `bounceIntensity` below is
 * `BOUNCE_FRACTION * sunIntensity * sin(altitude)`: it follows the sun's
 * Beer-Lambert falloff, it follows the cosine of the sun's height (a low sun
 * puts less on the ground to bounce), and it reaches exactly zero when the sun
 * does. Nothing has to switch it off at dusk and the night rig is untouched --
 * see the `bounceVanishesAtNight` case in the self-check.
 *
 * 0.177 puts 2.378 of intensity behind the light at 3 pm, which is 2.29 of
 * irradiance on a wall square-on to it and 0.66 on the road. Against the
 * measured residual, the wall term is a deliberate 1.4x over: the canyon
 * integration models one street and nothing else, where this light is standing
 * in for *every* indirect path in a renderer that has no ambient occlusion, no
 * global illumination, and no inter-reflection inside a window reveal. Graded
 * up, and named as graded rather than dressed up as physics.
 *
 * What it is not allowed to become is flat. The wall sun:shade illuminance ratio
 * goes from 7.06:1 to 3.13:1 against the canyon's measured 3.7:1, so the shade
 * opens up while staying on the deep side of a real street -- and the horizontal
 * ratio, which spec 7.1's "deep shadows" is really about, only moves 6.86:1 to
 * 5.78:1 because almost none of this lands on the road. Both are bounded by
 * `verifyLightRig` below.
 */
export const BOUNCE_FRACTION = 0.177;

/**
 * Tone-mapping exposure.
 *
 * Lower than the old 0.86 and yet the image is twice as bright, because three
 * divides by 0.6 inside `ACESFilmicToneMapping` and does not inside
 * `neutralToneMapping`: the old effective exposure was 1.43. Combined with the
 * 5.5x lift in irradiance above, a sunlit footpath moves from a pre-curve 0.62
 * to 1.38, which is what pushes it from mid-grey to near-clipping.
 *
 * It is pinned from both ends and there is no freedom left in it: the sky dome's
 * radiance is fixed by Preetham, so this alone decides how the ground sits
 * against the sky, and the light intensities above then decide the ratio.
 */
export const EXPOSURE = 0.62;

/**
 * Acceptable sun:shade window on the *horizontal*. Outside this, `verifyLightRig`
 * complains. Unchanged by the bounce pass, and that is the point: the bounce is
 * aimed near the horizon, so it lands on walls and barely on the road, and this
 * ratio only moves from 6.86:1 to 5.78:1.
 */
export const RATIO_MIN = 5;
export const RATIO_MAX = 10;

/**
 * The same thing for a *vertical* surface -- the two sides of a street -- which
 * is what this pass actually changed and therefore what has to be bounded.
 *
 * A wall reads harsher than the horizontal in any rig, because a vertical
 * surface sees only half the sky while still taking the full beam. Before the
 * bounce this rig put it at 7.06:1, which is where "shaded walls are black
 * silhouettes" came from. The converged canyon integration measures the real
 * thing at 3.7:1 and the rig now sits at 3.13:1.
 *
 * The floor matters more than the ceiling here. Spec 7.1 asks for deep shadows,
 * and the failure mode of a bounce term is that someone in a year decides shade
 * is still too dark and doubles it, at which point the shaded side of the street
 * is within a stop of the sunlit side and the whole image goes flat -- which is
 * the "overcast Europe" reading the spec rules out, arrived at from the opposite
 * direction to the one `HEMISPHERE_DAY` warns about.
 */
export const WALL_RATIO_MIN = 2.6;
export const WALL_RATIO_MAX = 4.6;

/**
 * Minimum red:blue in the irradiance falling on a shaded wall.
 *
 * This is the check that has teeth, because it is the one a deleted or
 * miscoloured bounce light cannot pass. Skylight alone puts the shaded side of a
 * street at 0.61 -- 1.6 parts blue to one red, which is the blue-grey-dead look.
 * The canyon measures the real value at 0.95, the rig now delivers 1.13, and
 * anything at or under 0.95 means the warm term has gone missing or gone cold.
 */
export const SHADE_WARMTH_MIN = 0.95;

/* ---------------------------------------------------------------------------
 * THE NIGHT HALF OF THE RIG.
 *
 * Everything above this line is the sun and what it bounced off, and every one
 * of those terms reaches exactly zero when the sun sets -- which was correct
 * right up until the point somebody scrubbed to midnight and found a city that
 * goes dark and stays dark. What is left after dark is `HEMISPHERE_NIGHT`
 * against `SKY_FILL_NIGHT`, which puts **0.243 of luminance** on a vertical wall
 * and 0.292 on a horizontal one. Through Lambert at a 0.25 albedo and `EXPOSURE`
 * that is a display value of about 29: a street you can walk down under a sky
 * that is still black.
 *
 * (Those two figures were 0.063 and 0.076 when this rig was written, 0.070 and
 * 0.083 after a player asked for ten per cent, and are 3.5x the latter after the
 * same player came back with "i cant see shit at night rn". **The ratios quoted
 * below have moved with it and every one of them has been restated**; they are
 * the calibration and a stale ratio here is a sentence that quietly stops being
 * about the game. `HEMISPHERE_NIGHT` carries the reasoning and
 * `NIGHT_AMBIENT_FLOOR_MAX` carries the bound, which is now within 3% of the
 * arithmetic limit.)
 *
 * So the city needs its own light after dark, and the numbers below are all
 * expressed against that floor rather than against taste. It is the *only*
 * reference a night term has -- there is no photograph to calibrate to, because
 * a photograph of a Sydney street at night is an exposure decision -- so what is
 * pinned here is a set of **ratios to the ambient floor** at named distances,
 * which is what decides whether the city is navigable.
 *
 * The three sources, and why they are these three:
 *
 *   - The **torch**, one real spot light, which is the player's own and is the
 *     thing that makes a dark street playable rather than a guess.
 *   - **Street lamps**, of which a small fixed number nearest the player are
 *     real point lights and the rest are additive geometry. The split is a
 *     recompile constraint rather than an aesthetic one -- see `LAMP_REAL_COUNT`.
 *   - **Car lights**, which are additive geometry only and light nothing.
 *
 * Everything here is a function of `nightLevel` and nothing else, so there is
 * exactly one clock in the night rig and `verifyLightRig` can assert that all of
 * it is off at the reference instant the daytime calibration was measured at.
 * ------------------------------------------------------------------------- */

/**
 * Solar altitude, degrees, at which the night rig starts to come up.
 *
 * +2 rather than 0, and it is a claim about switching gear rather than about
 * light: a street light is turned on by a photocell at somewhere around 55 lux
 * of horizontal illuminance, which on 15 February is a few minutes *before* the
 * sun touches the horizon (19:35 against a 19:46 sunset). Starting the ramp
 * above zero is what stops the lamps looking like they are waiting for
 * permission, and it costs nothing: at +2 degrees the sky is still 40 times
 * brighter than any of these terms, so the first third of the ramp is invisible
 * whatever it does.
 */
export const NIGHT_ON_ALTITUDE = 2;

/**
 * And where it is complete: the end of civil twilight, which is the standard
 * definition of "dark" and is 20:12 on the reference day.
 *
 * The span between the two is 8 degrees of altitude, which at Sydney's February
 * declination is 37 minutes of Sydney clock -- and, through the cycle, **187
 * real seconds**. This paragraph used to say the game had no running clock and
 * that the ramp was seen only by pressing a key; both halves stopped being true
 * when `sky/cycle.ts` landed and the last of it went when the scrub keys did.
 * Three minutes of real time is the whole of it now: long enough that a player
 * watching the sky sees the lamps *come up* rather than switch on, short enough
 * that "is it night yet" is never an interesting question for long. What this
 * span rules out is a *value* with a cliff in it, which is what
 * `verifyNightLights` bounds by sweeping the ramp at a twentieth of a degree.
 */
export const NIGHT_FULL_ALTITUDE = -6;

/**
 * Torch intensity, in the same units three's `PointLightNode` reads -- so
 * irradiance on a surface square-on to it is `intensity / distance^2`.
 *
 * Set by where a torch has to be *usable*, not by where it looks brightest.
 * Against the 0.243 ambient floor above, 110 puts:
 *
 *     2 m    27.5    113x ambient   blown, as a torch on a wall at arm's length is
 *     5 m     4.4     18x ambient   display ~115 on a 0.25 albedo: reading light
 *    10 m     1.1     4.3x ambient  display ~66 against 29: what you are walking into
 *    20 m     0.275   1.1x          the beam and the night are level here
 *    35 m     0.09    0.4x          under the ambient; the throw ends before the cone does
 *    60 m     0        -            `TORCH_DISTANCE` cuts it off entirely
 *
 * The 35 m line is the one that was originally chosen: a torch that ran out at
 * 15 m makes an intersection unreadable and a player walk into the middle of the
 * road to find the far kerb; one that reached 100 m is a searchlight and takes
 * the night away, which is the whole thing being built.
 *
 * **The bottom two rows are new and they are the cost of the 3.5x ambient**, not
 * a change to this constant -- the beam is exactly as bright as it was and the
 * night behind it is brighter. The torch is now a 15 m instrument rather than a
 * 35 m one, which is the correct thing to lose: what it was doing at 35 m was
 * telling you where the far kerb was, and the ambient now does that for free.
 * Inside 10 m -- doorways, a lane, the inside of a shed, which is what the key
 * is pressed for -- it is unchanged and still dominant. `verifyLightRig` asserts
 * the 10 m ratio at 4x and it lands at 4.34, so this is the row that decides how
 * much further `HEMISPHERE_NIGHT` can ever go: not much.
 */
export const TORCH_INTENSITY = 110;

/**
 * Cut-off distance, metres, and the decay exponent.
 *
 * `getDistanceAttenuation` multiplies `1/d^decay` by a window that reaches zero
 * at the cut-off, so this is not a hard edge -- it is already down to 1.4% of
 * the inverse-square value at 40 m and to nothing at 60. Decay 2 because it is
 * the physical one and because every other light in this rig is calibrated
 * against physical falloff.
 */
export const TORCH_DISTANCE = 60;
export const TORCH_DECAY = 2;

/**
 * Cone half-angle, radians, and the penumbra fraction.
 *
 * 0.42 rad is 24 degrees, so a 48-degree cone: wider than a real hand torch's
 * hotspot (a Maglite is about 10) and deliberately so. This one is attached to
 * the view and has to cover enough of the frame that a player is not aiming it
 * -- the order was "convenient" before it was "shaky", and a narrow cone in a
 * first-person view is a chore. At 10 m it lays a 9 m circle on the wall ahead,
 * which is a terrace and a half.
 *
 * The penumbra is high for the same reason: 0.55 puts the soft edge over more
 * than half the cone radius, so there is no ring anywhere in the frame. A hard
 * edge is what makes a spot light read as a projector.
 */
export const TORCH_ANGLE = 0.42;
export const TORCH_PENUMBRA = 0.55;

/**
 * Torch colour, linear, largest channel 1.
 *
 * A cheap white LED, which is what anybody in this city is actually carrying:
 * slightly cool, with the green-blue lift a phosphor-converted LED has, but not
 * the 6500 K blue-white of a phone torch -- that reads as a screen rather than
 * as a light. Warm enough at R/B 1.19 to sit beside the sodium lamps without
 * either of them looking broken.
 */
export const TORCH_COLOUR: Readonly<Rgb> = [1.0, 0.96, 0.84];

/**
 * How many street lamps are real lights at once.
 *
 * **This number is a shader constant, not a budget.** Three's WebGPU node
 * materials fold the *set of lights in the scene* into every material's cache
 * key -- `LightsNode.customCacheKey` hashes `light.id` and `castShadow` for each
 * -- so adding or removing one light, or hiding one (an invisible light is not
 * pushed onto the render list at all), rebuilds and recompiles **every pipeline
 * in the scene**. `world/warmup.ts` exists because this project has already been
 * burned by mid-play compiles; a lighting feature that added lights as you
 * walked toward lamps would be the worst possible version of that bug.
 *
 * So: four `PointLight`s are created at boot, added to the scene before the
 * warm-up runs, and never added, removed or hidden again for the life of the
 * process. What moves is their *position* and what fades is their *intensity*,
 * neither of which is in any cache key. `verifyNightLights` asserts the count
 * and the never-hidden invariant, and the boot log prints the pipeline count so
 * that day and night can be compared directly.
 *
 * **Two rather than the four or eight this was first sized at, and the number
 * came out of a measurement rather than a preference.** Every real light in the
 * scene is in every material's generated WGSL, so it makes every shader in the
 * build bigger -- and the warm-up, which compiles all 83 pipelines behind the
 * loading screen, scales with that. Measured on the same machine, same tiles,
 * same 86 warm-up draws, varying only the number of lights added before it:
 *
 *     0 extra lights   4,765 ms
 *     3 extra lights   6,708 ms      (+648 ms each)
 *     5 extra lights   7,776 ms      (+602 ms each)
 *
 * So a real light costs about **0.6 s of boot** before it has lit a single
 * pixel, on top of an unconditional per-fragment cost on every lit material in
 * the frame, day and night, whether or not it is contributing anything.
 *
 * Two is where the value stops being obvious. Sydney hangs street lights at
 * about 40 m, so two covers the lamp ahead of the player and the lamp behind --
 * which are the only two whose falloff (`LAMP_DISTANCE`, 32 m) puts anything on
 * the geometry the player is standing among. The third and fourth nearest are
 * routinely 45 m away and past their own cut-off, so they were paying 1.2 s of
 * boot to contribute nothing. Everything past the two is carried by the additive
 * pools, which are free and which is why the architecture is built round them.
 */
export const LAMP_REAL_COUNT = 2;

/**
 * Street-lamp intensity, in the torch's units.
 *
 * A luminaire hangs 8.6 m up (see `LAMP_HEIGHT_FRACTION` in
 * `world/nightlights.ts`), so 70 puts 0.95 of irradiance straight down on the
 * road under it -- 3.9x the ambient floor, which on asphalt at 0.08 albedo is a
 * display value of about 36 against the 12 the ambient alone gives. That is a
 * pool you can see the kerb line in and not a puddle of daylight.
 *
 * (That ratio was 15x against the old 0.0695 floor and the display values were
 * 35 against 4. The *pool* has not moved by a code value; what changed is the
 * road between two lamps, and the 3:1 contrast left is still an obvious pool
 * rather than a wash. See `HEMISPHERE_NIGHT` for why the road came up.)
 *
 * On the *facade* beside it the same lamp is much more visible, because a wall
 * 6 m away takes 1.94 and renders painted render at about 100 -- which is the
 * point. What says "street light" in a photograph is not the road, it is the
 * top-lit fence and the underside of the tree.
 */
export const LAMP_INTENSITY = 70;

/** Cut-off, metres. Past 30 m a lamp is worth under 2% of the ambient floor. */
export const LAMP_DISTANCE = 32;

/**
 * The two lamp colours, linear, largest channel 1 -- and the decision behind
 * having two of them.
 *
 * Sydney is **mid-conversion and has been for a decade**. Ausgrid has been
 * swapping the residential stock to 3000 K LED since 2017 and the arterials went
 * first, so the main roads and most of the inner west are warm white, while
 * plenty of back streets, laneways and the older industrial pockets are still on
 * high-pressure sodium. Picking one would be picking a year.
 *
 * So both exist, and which one a lamp wears is hashed on a **150 m cell** rather
 * than per pole -- because that is how the conversion actually happened, street
 * by street with a crew, rather than lamp by lamp. A run of poles down one road
 * is one colour and the next suburb over is the other, which is what it looks
 * like from a car. Two thirds LED, one third sodium; see `LAMP_SODIUM_SHARE`.
 *
 * 3000 K through the linear-sRGB primaries is (1.0, 0.70, 0.44) and high-pressure
 * sodium is far narrower than any blackbody -- a 589 nm doublet with a weak
 * continuum -- which lands near (1.0, 0.48, 0.11). Neither is fudged toward the
 * other: the whole reason for having two is that they are visibly different, and
 * a street of each is the single strongest tell that this is Sydney and not a
 * generic orange night.
 */
export const LAMP_LED_COLOUR: Readonly<Rgb> = [1.0, 0.7, 0.44];
export const LAMP_SODIUM_COLOUR: Readonly<Rgb> = [1.0, 0.48, 0.11];

/** What fraction of the city is still on sodium. See the colours above. */
export const LAMP_SODIUM_SHARE = 0.34;

export type Rgb = [number, number, number];

/* ---------------------------------------------------------------------------
 * THE GOLDEN HOUR.
 *
 * Three separate things in this project reddened together as the sun dropped --
 * the beam, the skylight and the cloud fill -- and each of them had its own copy
 * of the same expression, `(1 - alt/32)^1.6`. The day/night pass had to move that
 * curve, and moving it in three places is how two of them end up disagreeing, so
 * it is one function now and `clouds.ts` imports it.
 *
 * What moved, and why:
 *
 *   - **The knee went from 32 degrees to 42.** This is the "longer golden hour"
 *     the brief asks for and it is the cheapest possible way to buy one, because
 *     the alternative -- slowing the clock further -- costs the whole rest of the
 *     day. At 32 the beam is still 96% white at 20 degrees of altitude and only
 *     turns in the last eight minutes of a thirty-minute day. At 42 the turn
 *     begins around 25 degrees, which through this cycle is **six and a half
 *     real minutes before sunset**, and it arrives gradually enough that a
 *     player notices the light changing rather than noticing it having changed.
 *
 *   - **The coefficients deepened, 0.30/0.62 to 0.42/0.78.** The old curve
 *     bottomed out at (1, 0.70, 0.38) -- a warm yellow. A sun on the horizon has
 *     crossed 38 air masses; Rayleigh optical depth at 440 nm over that path is
 *     about 4.5, so roughly 1% of the blue survives, and the honest colour is far
 *     past yellow. (1, 0.58, 0.22) is where this lands, which is an orange you
 *     can name.
 *
 * Neither change touches anything calibrated. Every predicted display value in
 * this file, in `clouds.ts` and in `facade.ts` was measured at 57.11 degrees,
 * where this returns exactly zero -- and `verifyLightRig` asserts that as its
 * own case rather than leaving it to this paragraph.
 * ------------------------------------------------------------------------- */

/** Solar altitude above which the beam is pure white, degrees. */
export const SUN_WARM_KNEE = 42;
/** How much green the beam loses at the horizon, and how much blue. */
export const SUN_WARM_GREEN = 0.42;
export const SUN_WARM_BLUE = 0.78;
/** The shape of the run into it. Above 1 the turn stays late and then hurries. */
export const SUN_WARM_POWER = 1.6;

/**
 * How warm the light is: 0 above `SUN_WARM_KNEE`, 1 with the sun on the horizon.
 *
 * Clamped at zero altitude rather than continuing below it, which matters: below
 * the horizon there is no beam at all (`sunIntensity` is zero and so is the
 * bounce), and every consumer of this multiplies it by something that has
 * already gone out. What must not happen is this continuing to climb into the
 * night, because `clouds.ts` gates its warm fill on `warmth * day` and a warmth
 * that kept rising would fight that gate.
 */
/** `smoothstep(0, 1, x)`, clamped. The one easing shape this file uses. */
function smoothstep01(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

export function warmthAt(altitudeDeg: number): number {
  const above = Math.min(Math.max(altitudeDeg, 0) / SUN_WARM_KNEE, 1);
  return Math.pow(1 - above, SUN_WARM_POWER);
}

/**
 * How far into the night the rig is: 0 in daylight, 1 once it is dark.
 *
 * **The single clock for everything after sunset.** The torch's intensity, the
 * real lamps' intensity and the opacity of every additive sprite in
 * `world/nightlights.ts` are all this number times a constant, which is what
 * makes the whole night rig fade together instead of six things each crossing
 * their own threshold at their own hour.
 *
 * Smoothstep rather than linear, and it matters at the top end rather than the
 * bottom: the last few per cent of a linear ramp arrive as a visible "and now
 * the lights are fully on" step against a sky that is by then barely changing,
 * whereas the cubic's flat tail lands on nothing. The derivative is zero at both
 * ends, so nothing in this rig has a corner in it.
 *
 * Deliberately **not** `facade.ts`'s `nightFactor`, which ramps over
 * -5 to +6 degrees. That one decides when the *windows* light, and windows come
 * on while it is still light out because people turn lights on when the room
 * gets dim, not when the sun sets. This one is a photocell. They are two
 * different physical facts and giving them one number would mean getting one of
 * them wrong; that they overlap for most of the ramp is why the join reads.
 */
export function nightLevel(altitudeDeg: number): number {
  const t = Math.min(
    Math.max((NIGHT_ON_ALTITUDE - altitudeDeg) / (NIGHT_ON_ALTITUDE - NIGHT_FULL_ALTITUDE), 0),
    1,
  );
  return t * t * (3 - 2 * t);
}

/* ---------------------------------------------------------------------------
 * MOONLIGHT.
 *
 * The one term in this file that is a *light* rather than a floor, and the
 * reason the night stopped being a constant. Everything below is the shape of
 * it; `skyglow.ts` turns that shape into an ambient level and a colour.
 * ------------------------------------------------------------------------- */

/**
 * The exponent on the illuminated fraction, and the number that stops a half
 * moon looking like half a full moon.
 *
 * **A half moon is not half as bright; it is about a ninth.** This is measured,
 * long-standing and deeply counter-intuitive: full moon is visual magnitude
 * -12.7 and first quarter is -10.0, a factor of **12** in flux for a factor of 2
 * in lit area. Two things cause it, and both are about the lunar surface rather
 * than about geometry:
 *
 *   - **Opposition surge.** The regolith is a jumble of grains that hide their
 *     own shadows, so at zero phase angle -- sun exactly behind the observer --
 *     every shadow is behind its own grain and the surface brightens sharply.
 *     It is worth about 0.4 magnitudes in the last few degrees alone.
 *   - **Limb darkening the other way round.** Away from full, the lit crescent
 *     is the part of the disc where the sun is *grazing*, so the same area of
 *     ground returns far less light per square metre than the sub-solar point
 *     does.
 *
 * The empirical fit everybody uses is roughly `10^(-0.026|a| - 4e-9 a^4)` in
 * magnitudes of the phase angle `a`, which over 0-90 degrees is within a few per
 * cent of `k^3.4` in the illuminated fraction. 3.4 is used directly rather than
 * the magnitude fit because it costs one `pow`, it is exact at both ends, and
 * being a few per cent off a crescent that is already a hundredth of full is not
 * a difference anything downstream can express.
 *
 * What it buys, concretely: a first-quarter moon overhead lifts the ambient by
 * 9% rather than by 50%, so the *full* moon keeps its authority as the one night
 * you can walk around without the torch. Set this to 1 and every night in the
 * game becomes moonlit, which is the same failure as a flat ambient floor with
 * an astronomy paper attached.
 */
export const MOON_PHASE_POWER = 3.4;

/**
 * How much of the night the moon is lighting: 0 down or new, 1 full at the
 * zenith through a clear sky.
 *
 * The three terms, and each is the same physics the sun already goes through in
 * this file:
 *
 *   - `sin(altitude)`  -- Lambert's cosine law on a horizontal surface. Zero at
 *                         the horizon, so a moon that has just risen lights the
 *                         *sky* (which is what makes it beautiful) and not the
 *                         ground (which is what makes it accurate).
 *   - `phase^3.4`      -- see `MOON_PHASE_POWER`.
 *   - Beer-Lambert     -- against `opticalAirMass`, with `SUN_EXTINCTION`,
 *                         because it is the same atmosphere. A full moon two
 *                         degrees up delivers 4% of what it delivers overhead,
 *                         which is why a moonrise is orange and useless and a
 *                         moon overhead is neither.
 *
 * Normalised so the zenith full moon is exactly 1, which makes every constant
 * downstream a fraction of "the brightest natural night there is".
 */
export function moonlightLevel(altitudeDeg: number, phase: number): number {
  if (altitudeDeg <= 0) return 0;
  const lambert = Math.sin((altitudeDeg * Math.PI) / 180);
  const extinction = Math.exp(
    -SUN_EXTINCTION * (Math.pow(opticalAirMass(altitudeDeg), AIR_MASS_POWER) - 1),
  );
  return lambert * Math.pow(Math.max(phase, 0), MOON_PHASE_POWER) * extinction;
}

/** What the night rig is doing at one instant. Everything is `nightLevel` times a constant. */
export interface NightRig {
  /** 0 in daylight, 1 once dark. */
  level: number;
  /** `SpotLight.intensity` for the torch. */
  torchIntensity: number;
  /** `PointLight.intensity` for each of the `LAMP_REAL_COUNT` real lamps. */
  lampIntensity: number;
}

/** The night rig for a given solar altitude. Pure, for the same reason `solarRig` is. */
export function nightRig(altitudeDeg: number): NightRig {
  const level = nightLevel(altitudeDeg);
  return {
    level,
    torchIntensity: TORCH_INTENSITY * level,
    lampIntensity: LAMP_INTENSITY * level,
  };
}

/**
 * Irradiance on a vertical wall with nothing but the night sky on it.
 *
 * The floor every night term above is quoted against. It is `shadedWallIrradiance`
 * with the bounce already zero -- stated as its own function because the night
 * numbers are ratios to it and a reader checking them should not have to work
 * out which terms survive sunset.
 */
export function nightAmbientOnWall(altitudeDeg = -20): Rgb {
  return shadedWallIrradiance(solarRig(altitudeDeg));
}

/** What the rig is doing at one instant. Everything below is derived from this. */
export interface LightRig {
  /** Degrees above the horizon. */
  altitude: number;
  /** `DirectionalLight.intensity`. */
  sunIntensity: number;
  /** `DirectionalLight.color`, linear. */
  sunColour: Rgb;
  /** `HemisphereLight.intensity`. */
  hemisphereIntensity: number;
  /** `HemisphereLight.color` (the sky half), linear. */
  skyColour: Rgb;
  /** `HemisphereLight.groundColor`, linear. */
  groundColour: Rgb;
  /** Bounce `DirectionalLight.intensity`. Zero once the sun is down. */
  bounceIntensity: number;
  /** Bounce `DirectionalLight.color`, linear. */
  bounceColour: Rgb;
}

/** Rec. 709 luminance. Illuminance ratios are photometric, so weight properly. */
export function luminance(c: Readonly<Rgb>): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/**
 * Kasten-Young relative optical air mass: how much atmosphere the beam crosses
 * compared with straight down. 1.0 at the zenith, ~2 at 30 degrees, ~38 at the
 * horizon. The empirical tail is what keeps it finite at grazing altitudes,
 * where the naive `1/sin(alt)` diverges.
 */
export function opticalAirMass(altitudeDeg: number): number {
  const a = Math.max(altitudeDeg, 0);
  return 1 / (Math.sin((a * Math.PI) / 180) + 0.15 * Math.pow(a + 3.885, -1.253));
}

/**
 * The whole rig for a given solar altitude. Pure, so the self-check and the
 * renderer cannot drift apart -- they call this same function.
 */
export function solarRig(altitudeDeg: number): LightRig {
  // Beer-Lambert against the *Meinel* air mass, times the disc-set fade. See
  // `SUN_EXTINCTION` for why the exponent is there and what it bought, and
  // `HORIZON_FADE_DEGREES` for why the last degree needs a ramp now that it did
  // not need before.
  const disc = smoothstep01(altitudeDeg / HORIZON_FADE_DEGREES);
  const sunIntensity =
    altitudeDeg <= 0
      ? 0
      : SUN_ZENITH_INTENSITY *
        Math.exp(
          -SUN_EXTINCTION * (Math.pow(opticalAirMass(altitudeDeg), AIR_MASS_POWER) - 1),
        ) *
        disc;

  // The warm shift near the horizon. See `warmthAt` for the knee and the two
  // coefficients, which the day/night pass deepened and widened -- this is the
  // "longer golden hour" half of that brief, and it is exactly zero at the 57.11
  // degrees everything in this file is calibrated at.
  const warmth = warmthAt(altitudeDeg);
  const sunColour: Rgb = [1.0, 1.0 - SUN_WARM_GREEN * warmth, 1.0 - SUN_WARM_BLUE * warmth];

  // Civil-twilight ramp for the fill, so the sky half fades to a dim blue-grey
  // rather than switching off with the sun.
  const day = Math.min(Math.max((altitudeDeg + 6) / 12, 0), 1);
  // Written as `a(1-t) + bt` rather than the usual `a + (b - a)t`, and the
  // difference is one ULP that `verifyLightRig` checks for exactly.
  //
  // `a + (b - a) * t` is exact at `t = 0` and only *nearly* exact at `t = 1`:
  // the subtraction rounds, the multiply rounds, and the sum lands a bit off `b`.
  // With the old endpoints that happened to cancel (0.33 + 3.07 == 3.4); when
  // HEMISPHERE_NIGHT went to 1.155 it stopped cancelling and the day reference
  // came out 3.4000000000000004, which failed the "the night endpoint has leaked
  // into daylight" assertion below. That assertion is right to be exact -- it is
  // holding up a page of calibrated display values -- so the *arithmetic* is what
  // moved. This form is exact at both ends by construction: at `t = 1` the first
  // term is `a * 0` and the second is `b * 1`.
  const hemisphereIntensity = HEMISPHERE_NIGHT * (1 - day) + HEMISPHERE_DAY * day;
  // Three endpoints, not two: night, day, and the dusk warmth laid over the top
  // of the day value by the same `warmth` the beam uses. `warmth * day` is what
  // makes it both start at the golden hour and die with the light -- see
  // `SKY_FILL_DUSK`, and `verifyLightRig`'s two cases that pin the ends.
  const dusk = warmth * day;
  const skyColour = SKY_FILL_NIGHT.map((n, i) => {
    const clear = n + (SKY_FILL_DAY[i] - n) * day;
    return clear + (SKY_FILL_DUSK[i] - clear) * dusk;
  }) as Rgb;

  // Bounce off the pavement: the beam that landed on the horizontal, times the
  // fraction that comes back. `sunIntensity` is already zero below the horizon,
  // and `sin(altitude)` takes it to zero a second time, so nothing has to switch
  // this off for the night rig -- it switches itself off with the sun that feeds
  // it, which is the whole reason it is expressed as a fraction of the beam.
  const bounceIntensity =
    BOUNCE_FRACTION * sunIntensity * Math.max(0, Math.sin((altitudeDeg * Math.PI) / 180));

  return {
    altitude: altitudeDeg,
    sunIntensity,
    sunColour,
    hemisphereIntensity,
    skyColour,
    groundColour: [...GROUND_FILL] as Rgb,
    bounceIntensity,
    bounceColour: [...BOUNCE_COLOUR] as Rgb,
  };
}

/**
 * Unit vector pointing *at* the bounce, in renderer world axes, given where the
 * sun is. Same convention as `solar.direction`, so `sky.ts` can place the light
 * exactly the way it places the sun.
 *
 * The whole design rests on this being the sun's bearing plus 180: it is what
 * makes `N.Lbounce` negative on every surface the sun can see, and therefore
 * what keeps the calibrated sunlit values fixed. `verifyLightRig` asserts it
 * rather than trusting the arithmetic here to stay right.
 */
export function bounceDirection(solarAzimuthDeg: number): { x: number; y: number; z: number } {
  return directionFrom(BOUNCE_ALTITUDE, solarAzimuthDeg + 180);
}

/**
 * Irradiance on a vertical wall on the shaded side of a street: the half-sky the
 * hemisphere gives it, plus the bounce arriving square-on.
 *
 * This is the geometry the whole pass is about, and it is worth being explicit
 * that "square-on to the bounce" is the best case -- a wall turned 45 degrees
 * off it takes `cos(45)` of the bounce term, which is what produces the gradient
 * across a street corner instead of one flat value for everything in shadow.
 */
export function shadedWallIrradiance(rig: LightRig): Rgb {
  const bounce = rig.bounceIntensity * Math.cos((BOUNCE_ALTITUDE * Math.PI) / 180);
  return rig.groundColour.map((g, i) => {
    const hemisphere = (g + (rig.skyColour[i] - g) * 0.5) * rig.hemisphereIntensity;
    return hemisphere + bounce * rig.bounceColour[i];
  }) as Rgb;
}

/** The same wall with the sun on it. The bounce contributes nothing here -- by
 * construction it comes from behind, so `max(0, N.L)` clamps it away. That is
 * the invariant that lets this pass touch shade without touching the sunlit
 * calibration, and it is checked directly below. */
export function sunlitWallIrradiance(rig: LightRig): Rgb {
  const direct = rig.sunIntensity * Math.cos((rig.altitude * Math.PI) / 180);
  return rig.groundColour.map((g, i) => {
    const hemisphere = (g + (rig.skyColour[i] - g) * 0.5) * rig.hemisphereIntensity;
    return hemisphere + direct * rig.sunColour[i];
  }) as Rgb;
}

/** Sun:shade illuminance ratio across the two sides of a street. */
export function wallSunShadeRatio(rig: LightRig): number {
  const shade = luminance(shadedWallIrradiance(rig));
  if (shade <= 0) return Infinity;
  return luminance(sunlitWallIrradiance(rig)) / shade;
}

/**
 * Illuminance ratio between a sunlit and a shaded surface, on the horizontal.
 *
 * Horizontal is the standard definition -- global horizontal illuminance over
 * diffuse horizontal illuminance -- and it is the only one with an unambiguous
 * real-world number to check against: a clear Sydney summer day runs roughly
 * 95,000 lux global against 13,000 lux diffuse, so 6-8:1. It is also the
 * geometry of the road and the footpath, which is most of the frame.
 *
 * A wall is a different number and now has its own function: `wallSunShadeRatio`.
 * The two used to move together, and with the bounce in they no longer do --
 * which is the point of the pass. This one is the road and the footpath and it
 * stays harsh; that one is the two sides of a street and it opens up.
 */
export function sunShadeRatio(rig: LightRig): number {
  const sinAlt = Math.sin((rig.altitude * Math.PI) / 180);
  if (sinAlt <= 0) return 1;

  // Normal straight up, so the hemisphere weight is 1 and the fill is pure sky.
  // The bounce arrives at `BOUNCE_ALTITUDE` above the horizon, so a horizontal
  // surface takes only `sin` of it -- 0.28 of what the wall opposite gets. That
  // small share is deliberate and is why this ratio barely moved: a shaded road
  // is lit from the sky and should stay that way, and the canyon integration
  // says it is if anything already over-lit here.
  const bounceOnHorizontal =
    rig.bounceIntensity *
    Math.max(0, Math.sin((BOUNCE_ALTITUDE * Math.PI) / 180)) *
    luminance(rig.bounceColour);
  const diffuse = luminance(rig.skyColour) * rig.hemisphereIntensity + bounceOnHorizontal;
  const direct = luminance(rig.sunColour) * rig.sunIntensity * sinAlt;
  if (diffuse <= 0) return Infinity;
  return (direct + diffuse) / diffuse;
}

/**
 * The reference instant: 3 pm on 15 February, the spec's own definition of
 * "looks like Sydney" and milestone 5's definition of done. Hoisted out of the
 * self-check so the check can be handed a rig other than the current one.
 */
export const REFERENCE_SOLAR = /*#__PURE__*/ solarPosition(
  sydneyTime(2026, 2, 15, 15, 0),
  LATITUDE,
  LONGITUDE,
);

/**
 * Startup self-check, in the same spirit as `verifySouthernHemisphere()`: the
 * things this project gets wrong are the ones that fail silently.
 *
 * A sun:shade ratio that drifts out of band does not throw, does not glitch, and
 * does not show up in a frame-time graph. It just makes the city read as
 * somewhere other than Sydney, which is the one thing spec 7.1 says must not
 * happen. Returns a list of complaints, empty when correct.
 *
 * `rig` defaults to what the renderer will actually use and is a parameter only
 * so the check can be pointed at a hypothetical one. That is not a convenience:
 * a self-check nobody has ever seen fail is indistinguishable from a self-check
 * that cannot fail, and the bounce bounds below were confirmed by feeding this
 * the pre-bounce rig (`{...solarRig(alt), bounceIntensity: 0}`) and watching it
 * report the wall ratio at 7.06:1 and the shade at R/B 0.61. Keep it that way:
 * if you widen a bound, re-run that case and check it still complains.
 */
export function verifyLightRig(rig = solarRig(REFERENCE_SOLAR.altitude)): string[] {
  const failures: string[] = [];
  const solar = REFERENCE_SOLAR;
  const ratio = sunShadeRatio(rig);

  if (!(ratio >= RATIO_MIN && ratio <= RATIO_MAX)) {
    failures.push(
      `Sun:shade illuminance ratio is ${ratio.toFixed(2)}:1 at 3 pm on 15 February ` +
        `(solar altitude ${solar.altitude.toFixed(1)} deg), outside the ${RATIO_MIN}-${RATIO_MAX}:1 ` +
        `window a clear Sydney summer sky produces. Below it the image reads overcast; ` +
        `above it, shade goes to unlit black. Sun ${rig.sunIntensity.toFixed(2)}, ` +
        `hemisphere ${rig.hemisphereIntensity.toFixed(2)} at sky luminance ` +
        `${luminance(rig.skyColour).toFixed(3)}.`,
    );
  }

  // The absolute level matters as much as the ratio, and it is the half that was
  // wrong before: the old rig sat at 2.86 and every sunlit surface in the frame,
  // from asphalt to white render, tone mapped into a 9-code-value band around
  // 172. This guards the scale as well as the contrast. The window is generous
  // -- it is there to catch an order of magnitude, not to police taste.
  const horizontal =
    luminance(rig.sunColour) * rig.sunIntensity * Math.sin((rig.altitude * Math.PI) / 180) +
    luminance(rig.skyColour) * rig.hemisphereIntensity +
    rig.bounceIntensity *
      Math.max(0, Math.sin((BOUNCE_ALTITUDE * Math.PI) / 180)) *
      luminance(rig.bounceColour);
  if (horizontal < 9 || horizontal > 26) {
    failures.push(
      `Horizontal illuminance is ${horizontal.toFixed(2)} at 3 pm on 15 February; ` +
        `the calibrated value is 16.3, set so a sunlit concrete footpath lands just ` +
        `under clipping and about 2.4x the zenith sky, as it does in a photograph. ` +
        `Well outside that and the exposure in main.ts no longer matches the rig.`,
    );
  }

  // --- The bounce, in three parts, because it can fail in three ways ---------
  //
  // All three exist because deleting this light is *cheap and silent*. It casts
  // no shadow, costs one N.L, and nothing breaks without it -- the scene renders,
  // the sun is still right, the sky is still right, and the only symptom is that
  // the shaded side of every street goes back to being a charcoal silhouette,
  // which reads as a taste decision rather than as a missing light. The horizontal
  // ratio above cannot catch it: without the bounce that ratio is 6.86:1, which
  // is comfortably inside its window. These are the checks that see it.

  // 1. Level. The wall ratio is the number the whole pass moved.
  const wallRatio = wallSunShadeRatio(rig);
  if (!(wallRatio >= WALL_RATIO_MIN && wallRatio <= WALL_RATIO_MAX)) {
    failures.push(
      `Wall sun:shade illuminance ratio is ${wallRatio.toFixed(2)}:1 at 3 pm on 15 February, ` +
        `outside the ${WALL_RATIO_MIN}-${WALL_RATIO_MAX}:1 window (a converged street-canyon ` +
        `integration measures the real thing at 3.7:1). Above it the shaded side of a street ` +
        `goes to a black silhouette -- that is the 7.06:1 this rig had before the bounce light ` +
        `existed. Below it the two sides of the street are within a stop of each other and the ` +
        `image reads overcast, which spec 7.1 rules out. Bounce intensity ` +
        `${rig.bounceIntensity.toFixed(2)} at ${BOUNCE_ALTITUDE} deg; shaded wall ` +
        `${luminance(shadedWallIrradiance(rig)).toFixed(2)} against sunlit ` +
        `${luminance(sunlitWallIrradiance(rig)).toFixed(2)}.`,
    );
  }

  // 2. Colour. A bounce that is present but cold fixes the level and leaves the
  //    look exactly as wrong, so the hue is bounded separately.
  const shadedWall = shadedWallIrradiance(rig);
  const warmth = shadedWall[2] > 0 ? shadedWall[0] / shadedWall[2] : Infinity;
  if (!(warmth > SHADE_WARMTH_MIN)) {
    failures.push(
      `Shaded walls are receiving R/B ${warmth.toFixed(2)}, at or under the ` +
        `${SHADE_WARMTH_MIN} floor. Shade in a Sydney street is warm-side of neutral because ` +
        `most of what reaches it bounced off sunlit road and sunlit render; skylight alone is ` +
        `0.61, which is the blue-grey-dead look this rig had before the bounce light. Check ` +
        `BOUNCE_COLOUR (${rig.bounceColour.map((c) => c.toFixed(2)).join(', ')}) and that the ` +
        `bounce light still exists.`,
    );
  }

  // 3. Geometry. The sunlit half of the frame is calibrated and this pass had no
  //    budget to touch it. The only reason it did not is that the bounce comes
  //    from behind the sun, so `max(0, N.L)` clamps it off every sunlit surface.
  //    Point it anywhere on the sun's side of the sky and every predicted value
  //    in facade.ts and street.ts is wrong at once -- silently, because a
  //    slightly brighter sunlit wall looks like nothing at all.
  const bounce = bounceDirection(solar.azimuth);
  const alignment =
    bounce.x * solar.direction.x + bounce.y * solar.direction.y + bounce.z * solar.direction.z;
  if (alignment >= 0) {
    failures.push(
      `The bounce light is on the sun's side of the sky (alignment ${alignment.toFixed(2)}, ` +
        `must be negative). It has to sit opposite the sun's azimuth so that every surface the ` +
        `sun can see clamps it away -- that is the only reason the sunlit calibration survived ` +
        `this term. Sun azimuth ${solar.azimuth.toFixed(1)} deg, bounce ` +
        `${((solar.azimuth + 180) % 360).toFixed(1)} deg at ${BOUNCE_ALTITUDE} deg altitude.`,
    );
  }
  if (BOUNCE_ALTITUDE <= 0 || BOUNCE_ALTITUDE >= 35) {
    failures.push(
      `BOUNCE_ALTITUDE is ${BOUNCE_ALTITUDE} deg. It has to stay low: it is light off the road ` +
        `and off the facade opposite, whose measured elevations run -22 to +30 deg. At or below ` +
        `zero nothing reaches a shaded road at all; far above it the term starts landing on the ` +
        `sunlit road, which is the one horizontal surface with no headroom left.`,
    );
  }

  // 4. Night. The bounce is sunlight that came back off the pavement, so it must
  //    vanish with the sun rather than lingering as a warm floor over a night
  //    scene -- spec 6.4's night is carried by the lit windows and the silhouette
  //    and nothing else, and the night fill above is luminance-matched to the old
  //    rig on the assumption that nothing else is on.
  const night = solarRig(-8);
  if (night.bounceIntensity !== 0) {
    failures.push(
      `Bounce intensity is ${night.bounceIntensity.toFixed(4)} with the sun 8 degrees below the ` +
        `horizon; it must be exactly zero. It is meant to be a fraction of the beam landing on ` +
        `the pavement, so it should switch itself off with the sun that feeds it rather than ` +
        `needing a separate night path.`,
    );
  }

  // --- The golden hour and the dusk, in four parts.
  //
  // Added by the day/night pass, and they are here rather than in `dusk.ts`
  // because they are about the *light on the city*, not about the sky: `dusk.ts`
  // draws the burning horizon, and these four say whether the street in front of
  // it is lit to match. The whole class of failure is one thing -- a spectacular
  // sky over a city still lit for three in the afternoon -- and it renders
  // perfectly, throws nothing, and reads as "the sunset looks a bit fake".

  // 5. The pass did not touch the calibration. First, because it is the case
  //    that invalidates every predicted display value above if it fails: the
  //    warmth curve and the dusk fill must both be *exactly* zero at the
  //    reference instant, so the sky fill there is `SKY_FILL_DAY` to the last
  //    bit and none of the arithmetic at the top of this file has moved.
  if (warmthAt(solar.altitude) !== 0) {
    failures.push(
      `warmthAt is ${warmthAt(solar.altitude)} at the reference altitude ` +
        `${solar.altitude.toFixed(2)} deg; it must be exactly zero. SUN_WARM_KNEE is ` +
        `${SUN_WARM_KNEE} degrees and has to stay below it, or the beam colour, the dusk fill and ` +
        `the cloud fill all move at 3 pm on 15 February and every display value in this file, in ` +
        `clouds.ts and in facade.ts is wrong at once -- silently, because a slightly warmer wall ` +
        `looks like nothing at all.`,
    );
  }
  const referenceSky = solarRig(solar.altitude).skyColour;
  if (SKY_FILL_DAY.some((c, i) => Math.abs(referenceSky[i] - c) > 1e-12)) {
    failures.push(
      `The hemisphere sky colour at the reference is ` +
        `(${referenceSky.map((c) => c.toFixed(4)).join(', ')}) rather than SKY_FILL_DAY ` +
        `(${SKY_FILL_DAY.join(', ')}). The dusk endpoint is blended by warmthAt * day and must ` +
        `reach zero weight in full daylight rather than merely approach it.`,
    );
  }

  // 6. The golden hour is long enough to be an hour. Stated as an altitude
  //    rather than as a duration, because this file has no clock in it -- the
  //    duration is `cycle.ts`'s to measure and it does. What is asserted here is
  //    that the beam has *visibly* turned by 25 degrees of altitude, which
  //    through the shipped cycle is six and a half real minutes before sunset.
  const turning = solarRig(25).sunColour;
  if (!(turning[2] < 0.9)) {
    failures.push(
      `At 25 degrees of solar altitude the beam is still (${turning.map((c) => c.toFixed(3)).join(', ')}) ` +
        `-- effectively white. The golden hour is supposed to have begun by there: SUN_WARM_KNEE is ` +
        `${SUN_WARM_KNEE} degrees and the brief asks for a longer golden hour than a literal ` +
        `simulation gives, which this curve is half of (the other half is HORIZON_DWELL in cycle.ts).`,
    );
  }

  // 6b. **And there is still a beam to be golden.** The case that guards the
  //     Meinel exponent, and the one the whole golden hour rests on: a warm sun
  //     colour is worth nothing multiplied by a sun intensity of 0.08.
  //
  //     Quoted as a fraction of the reference beam and bounded on both sides.
  //     Too low and there is no low-angle light on anything -- the city is lit by
  //     skylight alone for the last four minutes of the day, which is what
  //     shipped before this pass and what read as overcast. Too high and the sun
  //     is still blazing at a grazing angle, which reads as a rig with no
  //     atmosphere in it and throws shadows a hundred metres long off every kerb.
  const referenceBeam = solarRig(solar.altitude).sunIntensity;
  const goldenBeam = solarRig(6).sunIntensity / referenceBeam;
  if (!(goldenBeam > 0.18 && goldenBeam < 0.45)) {
    failures.push(
      `With the sun 6 degrees up the beam is ${(goldenBeam * 100).toFixed(1)}% of its reference ` +
        `strength, outside the 18-45% window. Meinel's empirical clear-sky model puts the real ` +
        `figure at 31% and this rig is calibrated to 27%. Straight Beer-Lambert against air mass ` +
        `-- which is what this was before the day/night pass -- gives 8%, and at 8% there is no ` +
        `golden light on anything: the whole city is lit by skylight for the last four minutes of ` +
        `every day and the golden hour reads as an overcast one. Check SUN_EXTINCTION ` +
        `(${SUN_EXTINCTION}) and AIR_MASS_POWER (${AIR_MASS_POWER}).`,
    );
  }

  // 6c. And it lands on the horizon rather than falling off it. The disc-set
  //     fade exists only because 6b made the beam strong enough at a grazing
  //     angle that switching it off at zero altitude became a visible step.
  const lastLight = solarRig(0.02).sunIntensity / referenceBeam;
  if (!(lastLight < 0.005)) {
    failures.push(
      `The beam is still at ${(lastLight * 100).toFixed(2)}% of reference with the sun 0.02 degrees ` +
        `above the horizon, and it is cut to exactly zero at 0 -- so a fifth of the irradiance on ` +
        `every west-facing wall vanishes between two frames. HORIZON_FADE_DEGREES ` +
        `(${HORIZON_FADE_DEGREES}) is what ramps it out over the width of the solar disc; check it ` +
        `is still applied.`,
    );
  }

  // 7. And it ends somewhere worth calling a sunset. A beam that bottoms out at
  //    a warm yellow is the difference between "the light goes a bit orange" and
  //    a sunset, and it is one coefficient.
  const setting = solarRig(0.001).sunColour;
  if (!(setting[2] < 0.3 && setting[1] > 0.45 && setting[1] < 0.7)) {
    failures.push(
      `The beam at the horizon is (${setting.map((c) => c.toFixed(3)).join(', ')}); it should be a ` +
        `nameable orange -- blue under 0.3, green between 0.45 and 0.7. A sun that has crossed 38 ` +
        `air masses has about 1% of its blue left, so anything paler than this is a yellow filter ` +
        `rather than a sunset. Check SUN_WARM_GREEN and SUN_WARM_BLUE.`,
    );
  }

  // 8. **The city catches it.** The one that matters, and the one nothing else
  //    here can see: through the golden hour the beam is already down to a tenth
  //    of noon by Beer-Lambert, so the hemisphere *is* the light, and if it is
  //    still blue then the frame is a burning sky over an afternoon street.
  //
  //    Measured on the same shaded wall as `SHADE_WARMTH_MIN` above, at **6
  //    degrees of altitude**, which is where `warmthAt * day` peaks and therefore
  //    where the claim is strongest -- see `SKY_FILL_DUSK`. Through the shipped
  //    cycle that is 139 real seconds before the sun touches the horizon.
  const duskShade = shadedWallIrradiance(solarRig(6));
  const duskWarmth = duskShade[2] > 0 ? duskShade[0] / duskShade[2] : Infinity;
  if (!(duskWarmth > 1.55)) {
    failures.push(
      `With the sun 6 degrees up -- the warmest moment of the golden hour -- a shaded wall is ` +
        `receiving R/B ${duskWarmth.toFixed(2)}, under the 1.55 that says the city has caught the ` +
        `sunset. Daylight's value is 1.13, so this has to be visibly past it. The beam is down to ` +
        `8% of noon by then and the hemisphere is doing nearly all the lighting; leave it blue and ` +
        `the result is a spectacular sky over a street lit for three in the afternoon, which is the ` +
        `single most common way a game sunset fails to land. Check SKY_FILL_DUSK.`,
    );
  }

  // 9. And it lets go. The warmth is gated on the civil-twilight ramp precisely
  //    so it cannot survive into the night as an orange floor under a city whose
  //    whole look after dark is silhouette and window light.
  const nightSky = solarRig(-8).skyColour;
  if (SKY_FILL_NIGHT.some((c, i) => Math.abs(nightSky[i] - c) > 1e-12)) {
    failures.push(
      `The hemisphere sky colour 8 degrees under the horizon is ` +
        `(${nightSky.map((c) => c.toFixed(4)).join(', ')}) rather than SKY_FILL_NIGHT ` +
        `(${SKY_FILL_NIGHT.join(', ')}). The dusk warmth is multiplied by the same civil-twilight ` +
        `ramp the rest of the fill uses so that it goes out with the light; anything left here is a ` +
        `warm cast over every night scene, which reads as a tone-mapping fault rather than as this.`,
    );
  }

  // --- The night rig, in two parts, and both of them are about *this file's own
  // arithmetic staying true* rather than about how the night looks.
  //
  // Every predicted display value above -- the sunlit footpath, the shaded
  // brick, the two sun:shade ratios -- was measured with three lights in the
  // scene. There are now nine, and the only reason those measurements are still
  // the whole story at 3 pm is that the six new ones are multiplied by
  // `nightLevel`, which is exactly zero above `NIGHT_ON_ALTITUDE`. That is a
  // one-line invariant holding up a page of calibration, so it is asserted
  // rather than trusted.
  const dayNight = nightRig(solar.altitude);
  if (dayNight.level !== 0 || dayNight.torchIntensity !== 0 || dayNight.lampIntensity !== 0) {
    failures.push(
      `The night rig is contributing at 3 pm on 15 February (level ${dayNight.level.toFixed(4)}, ` +
        `torch ${dayNight.torchIntensity.toFixed(2)}, lamps ${dayNight.lampIntensity.toFixed(2)}). ` +
        `It must be exactly zero above ${NIGHT_ON_ALTITUDE} degrees of solar altitude: every ` +
        `display value predicted in this file and in facade.ts was measured with the sun, the ` +
        `hemisphere and the bounce and nothing else, so a torch that is on at noon invalidates ` +
        `all of them at once -- silently, because a slightly brighter wall looks like nothing.`,
    );
  }

  // And the other end: something has to be on after dark, or this whole rig is
  // the one it replaced. Quoted as a ratio to the ambient floor at 10 m because
  // that is the number that decides whether a street is walkable -- see
  // `TORCH_INTENSITY`'s table.
  const dark = nightRig(-20);
  const floor = luminance(nightAmbientOnWall(-20));

  // And the ambient floor itself, bounded at both ends. This is the term a
  // player asks to have raised -- "make the ground a bit brighter at night" is
  // the most reasonable request in the game and the easiest one to over-serve,
  // because one constant lifts every surface at once and the result always
  // looks better in the frame it was judged in. It has now been asked for twice
  // and served twice, the second time at 3.5x, so **both** bounds are close: see
  // `NIGHT_AMBIENT_FLOOR_MAX` (3% of headroom, and the arithmetic limit behind
  // it) and `NIGHT_AMBIENT_FLOOR_MIN` (which is what stops the answer being
  // quietly reverted by somebody judging a still).
  if (floor > NIGHT_AMBIENT_FLOOR_MAX) {
    failures.push(
      `The night ambient puts ${floor.toFixed(4)} of luminance on a shaded wall, over the ` +
        `${NIGHT_AMBIENT_FLOOR_MAX} ceiling -- and that ceiling is 3% under the arithmetic limit ` +
        `(0.264), which is where the torch's 4x at 10 m becomes 1x and the beam stops being ` +
        `brighter than the night it is pointed into. Every night term in this file is quoted as a ` +
        `ratio to this floor, so past here those sentences are no longer describing what is on ` +
        `screen. Raising HEMISPHERE_NIGHT (${HEMISPHERE_NIGHT}) is always the cheapest way to make ` +
        `a dark scene readable and it has already been spent: a further lift needs the sources ` +
        `re-derived -- TORCH_INTENSITY's table and LAMP_INTENSITY -- rather than this constant ` +
        `nudged, or the city stops being lit by its lamps and starts being lit by nothing at all.`,
    );
  }
  if (floor < NIGHT_AMBIENT_FLOOR_MIN) {
    failures.push(
      `The night ambient is ${floor.toFixed(4)} of luminance on a shaded wall, under the ` +
        `${NIGHT_AMBIENT_FLOOR_MIN} floor. That bound is not the old "a street with no lamp is ` +
        `*absent*" threshold (0.05, and still true); it is the player's own answer to "i cant see ` +
        `shit at night rn", which was served by one constant and can be taken back by one. A night ` +
        `that is comfortable to play in looks flat in the still somebody will judge it by. Check ` +
        `HEMISPHERE_NIGHT (${HEMISPHERE_NIGHT}) and SKY_FILL_NIGHT, and read the paragraph on ` +
        `NIGHT_AMBIENT_FLOOR_MIN before moving this.`,
    );
  }
  // Daylight is untouched by any of that, and it is asserted from the other end
  // rather than argued: the civil-twilight ramp reaches exactly 1 at and above
  // 6 degrees, so the hemisphere at the reference instant must be
  // `HEMISPHERE_DAY` to the last bit whatever the night endpoint is doing. A
  // ramp that merely approached 1 would put a night constant into every
  // calibrated display value in this file.
  if (rig.hemisphereIntensity !== HEMISPHERE_DAY) {
    failures.push(
      `The hemisphere at the 3 pm reference is ${rig.hemisphereIntensity} rather than ` +
        `HEMISPHERE_DAY (${HEMISPHERE_DAY}). The night endpoint has leaked into daylight, which ` +
        `invalidates every predicted display value above at once -- silently, because a slightly ` +
        `brighter wall looks like nothing at all.`,
    );
  }

  const torchAt10 = (dark.torchIntensity / 100) * luminance(TORCH_COLOUR as Rgb);
  if (!(torchAt10 > floor * 4)) {
    failures.push(
      `The torch puts ${torchAt10.toFixed(3)} of irradiance on a wall 10 m away with the sun ` +
        `20 degrees down, against an ambient floor of ${floor.toFixed(3)} -- ` +
        `${(torchAt10 / floor).toFixed(2)}x, under the 4x that makes a dark street navigable rather ` +
        `than merely lighter. **The likely cause is the ambient rather than the torch**: this ratio ` +
        `sits at 4.34x as shipped, so HEMISPHERE_NIGHT (${HEMISPHERE_NIGHT}) is three per cent from ` +
        `breaking it and TORCH_INTENSITY (${TORCH_INTENSITY}) is untouched since it was derived. ` +
        `Also check that nightLevel still reaches 1.`,
    );
  }

  return failures;
}
