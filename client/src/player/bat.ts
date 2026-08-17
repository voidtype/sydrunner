/**
 * The cricket bat: one geometry, a prop in every right hand, and a first-person
 * viewmodel.
 *
 * The melee weapon in this game was a bare fist until this pass and is now a bat,
 * on a direct instruction. Three things had to exist for that to be true rather
 * than merely asserted: an object you can see in somebody else's hands, an object
 * *you* can see in your own, and a reach that matches the thing being swung.
 * The first two are here; the third is `game/combat.ts`'s `REACH`, and the check
 * at the bottom of this file is what ties the two together -- it swings the real
 * rig, reads where the toe of the real bat ends up, and asserts that the number
 * the hit test uses is the number the picture shows.
 *
 * ---------------------------------------------------------------------------
 * Why the bat is generated, like everything else here.
 *
 * `player/character.ts` argues this at length about the figure and
 * `world/footyball.ts` repeats it about the ball: there is no asset pipeline for
 * a downloaded mesh to enter, and a `.glb` would be the only thing in the
 * repository whose triangle budget, pivot and up-axis were decided somewhere
 * else. A cricket bat is a box with square shoulders on a thin stick. It is 188
 * triangles of loft.
 *
 * ---------------------------------------------------------------------------
 * The shape, and the five details that make it a *cricket* bat rather than a
 * paddle.
 *
 * The first version of this model was reported as *"the cricket bat looks like a
 * paddle"*, and the report was right. Nothing was wrong with the cross-section;
 * everything was wrong with the outline. A table-tennis bat and a cricket bat
 * have the same *parts* -- a handle, a join, a flat face -- and are told apart
 * entirely by how those parts meet. What was drawn was a blade that flared
 * smoothly out of a thick handle over 70 mm and narrowed again at the end, which
 * is a paddle's profile exactly, wearing a cricket bat's cross-section.
 *
 * That pass fixed the *corners* and left the *lengths* alone, and the report came
 * back a second time -- **"it still looks like a paddle; make the rubber bit of
 * the handle shorter"**. It was right again, and for a reason worth stating
 * because it is not the same reason: the handle was 41% of the bat. A paddle is
 * a short face on a long stick. Every corner on the model was in the right place
 * and the *ratio* between the two halves was a paddle's, so at a glance -- which
 * is all a weapon in a brawler ever gets -- the silhouette was still wrong.
 *
 * And it came back a **third** time, about the same half of the object and from
 * the only instrument that can judge it:
 *
 *   > *"the bat still has way too long a handle, it's like 2x too long and 85%
 *   > the thickness it should be"*
 *
 * Which is a measurement, so it is taken as one. The handle was 0.278 m and is
 * now **0.140 m** -- half, to the millimetre -- and every radius on it is
 * **1.18x** what it was, which is 1 / 0.85. Nothing at the toe moved again, so
 * `BAT_LENGTH`, `TOE_Y`, `combat.REACH` and the viewmodel's reach budget are the
 * numbers they have always been; the 0.138 m the handle gave up went into the
 * blade, exactly as the 0.065 m of the previous pass did.
 *
 * **This makes the blade longer than Law 5 allows, proportionally, and that is
 * the intended answer rather than an accident.** A real bat is 66% blade; this one
 * is 83% measured shoulder-to-toe. The earlier version of this essay argued the
 * 66% at length and it was arguing for the wrong thing -- the model is looked at
 * from 45 cm away, over the bottom-right corner of the frame, where the grip is
 * *off the bottom of the screen* and the only part of the handle a player ever
 * sees is the few centimetres between their hand and the shoulder. At the real
 * proportion that visible stub is a third of a metre of black rubber pointing at
 * the corner, and the owner read it -- correctly, from where they are sitting --
 * as a paddle's stick. The number that matters is what the object reads as in
 * first person, and the owner's eye is the only measurement of that there is.
 *
 * So, in the order the eye uses them:
 *
 *   - **Five sixths of the bat is blade.** 0.688 m of a 0.828 m bat, against
 *     0.550 m before and 0.485 m before that. The handle came down from 0.278 m
 *     to 0.140 m to pay for it and nothing at the toe moved, so the swing's reach
 *     is the number it always was.
 *   - **A rubber grip that covers the handle and nothing else.** 0.120 m of
 *     rubber over a 0.140 m handle -- 86% of it, which is what a real sleeve
 *     covers -- against 0.203 m over 0.278 m before. The grip still stops above
 *     the shoulder with the binding collar and bare cane below it, and the pale
 *     step that shows the join is now 20 mm rather than 75. See `GRIP_END_Y`.
 *   - **A handle 1.18x thicker.** 46 mm across the collar against 108 mm of
 *     blade, a ratio of 2.3 where a real bat is 3.4 and the version before this
 *     was 2.8. The same instrument asked for it and the same argument applies:
 *     at the distance a viewmodel is seen from, a 39 mm handle under a 108 mm
 *     blade reads as wire.
 *   - **Square shoulders.** The blade is at full width 25 mm below the shoulder,
 *     not 70, and it starts that ramp at 40% width rather than 55. What a viewer
 *     sees is a pair of corners where the handle meets the blade. The ramp came in
 *     from 30 mm with the handle: it is the *corner* that reads, and a corner
 *     18% of a 140 mm handle deep is the same corner 11% of a 278 mm one was.
 *     See `SHOULDER_FULL_Y`.
 *   - **A squared toe.** Full width to the very end, losing only its depth over
 *     the last 45 mm, so the blade ends in a flat rectangle. It used to narrow to
 *     90% of its width, and a blade that narrows at the tip is a paddle.
 *   - **A flat face and a spine that swells.** The blade's hitting face is a
 *     plane; the back is a shallow roof rising from two thin edges to a central
 *     ridge, and that ridge is 6% deeper over the middle of the blade than at
 *     either end -- the bulge of wood you see side-on. Seen end-on the profile
 *     is seven-sided, and the edges are chamfered into the face rather than
 *     meeting it square, because a square corner under `flatShading` reads as a
 *     dead black line.
 *   - **A bound handle.** A dark rubber grip that *stops* above the shoulder, a
 *     pale binding collar proud of the cane at the bottom of it, and bare splice
 *     below that. Three materials' worth of contrast in one vertex-colour
 *     buffer, and their job is to show the viewer the join: a join you cannot
 *     see is read as one tapered object, which is the paddle again.
 *
 * The *overall* proportions are still a real bat's and the two the third report
 * moved are deliberately not. A Law 5 bat is 0.855 m overall with a 0.565 m blade
 * and a 0.108 m face, on a person of about 1.80 m. This one is 0.828 m on a 1.70 m
 * figure with the same 0.108 m face -- so length and width against the figure are
 * the real object's to within half a percent, and the bat is 97% of full size on a
 * figure that is 94% of a person. What is *not* the real object's is the split
 * between blade and handle (0.688 / 0.140 against 0.565 / 0.290) and the handle's
 * thickness (46 mm against 32). Both were moved on the owner's eye, both are
 * written down as such above, and both are pinned by `verifyBat` so the next
 * person to "correct" them back to Law 5 gets a failing boot rather than a silent
 * regression of a reported bug. It reads *larger* than any of this arithmetic
 * suggests, because spec 8.1's figure has noodle arms and a 0.19 m mitt, and a bat
 * is judged against the hand holding it.
 *
 * The blade narrowed from 125 mm to 108 mm in the same pass, which is the Law 5
 * maximum and the number this file's own check has always been written against
 * -- the header claimed 0.108 m while `BLADE_PROFILE` drew 0.125, and only the
 * constant was ever true. A blade 16% wider than a real one is the other half of
 * "paddle": width is what a table-tennis bat has and length is what a cricket
 * bat has, and the model had them the wrong way round in both directions.
 *
 * ---------------------------------------------------------------------------
 * One geometry and one material for every bat in the game.
 *
 * The same contract `CharacterAssets` has, for the same reason: a material is a
 * WebGPU pipeline, and sixteen players each with their own bat material is
 * sixteen compiles in the frame a match starts. So the wood, the grip and the
 * splice are **vertex colours** on one flat-shaded `MeshStandardNodeMaterial`,
 * and an actor never disposes the geometry it was handed.
 *
 * ---------------------------------------------------------------------------
 * Where the bat is attached, and the one thing that decides the whole pose.
 *
 * A `BatProp` is parented to the character's **right wrist bone**, exactly as
 * `world/footyball.ts`'s ball is parented to the left one, which costs one
 * `add()` and no per-frame matrix work: three composes the skeleton anyway, so a
 * child of a bone is transformed for free.
 *
 * The bat is built with its **grip top at the origin and its shaft running along
 * -Y**, which is the rig's own convention -- every bone in `animation.ts` hangs
 * along its own -Y -- so the bat reads as one more segment of the arm and the
 * only interesting number in the attachment is a single rotation about X.
 *
 * That number is `HOLD_PITCH`, and it is **-2.72 rad**, which is the decision
 * this file is most likely to be asked about. The chain from the shoulder to the
 * blade is a sum of rotations about the same axis, so the direction the bat
 * points is
 *
 *     theta = shoulder.x + elbow.x + wrist.x + HOLD_PITCH
 *     direction = (0, -cos theta, -sin theta)
 *
 * and the pose has to be believable at *both* ends of that sum:
 *
 *   - **At idle** the arm hangs (shoulder 0, elbow 0.14), so theta is -2.58 and
 *     the bat points up and back at 58 degrees -- shouldered, toe up past the
 *     right ear at 1.14 m and 0.36 m behind. That is a brawler carrying a bat,
 *     and it is the only family of poses that works: this figure's mitt sits
 *     0.435 m off the ground, so a 0.83 m bat hanging *down* from it is a third
 *     of a metre through the footpath, whatever angle it is given. Measured over
 *     a full run cycle the lowest point of the bat is 0.40 m up.
 *   - **At the strike** the arm is thrown forward and the wrist snaps through, so
 *     theta comes round to about +1.1 and the blade arrives out in front and to
 *     the left at chest height, 1.40 m from the body axis in plan. See
 *     `animation.clipPunchActive`, which was rewritten in this pass from a jab
 *     into a swing for exactly this reason: a bat held as an extension of a
 *     *punching* arm points backwards at the moment of impact, which is the
 *     failure that made the arithmetic above worth writing down.
 *
 * Between the two the blade scythes down past the player's own feet -- at its
 * lowest it clears the pavement by 6 cm -- which is what a swing does and is the
 * one place in the arc where the clearance is worth watching.
 *
 * `HOLD_ROLL` is a rotation about the bat's own shaft and changes nothing about
 * where the bat points -- a roll about -Y commutes with the shaft direction --
 * so it is free to use for the one thing it does control, which is which way the
 * flat face is turned as the blade comes through.
 *
 * ---------------------------------------------------------------------------
 * The viewmodel, and what it deliberately is not.
 *
 * `BatViewmodel` is a bat parented to the camera. It is the first first-person
 * geometry this project has had -- `main.ts` recorded the absence and the reason
 * ("there are no first-person arms, deliberately") -- and it is here now because
 * a melee weapon you cannot see is a melee weapon the player has to take on
 * trust.
 *
 * What it is not is a second render pass. The usual arrangement is to draw a
 * viewmodel with its own near plane into a cleared depth buffer so it can never
 * intersect the world; that is a whole pass, a second camera and a depth clear
 * per frame, and it was explicitly not wanted this round. So the bat is an
 * ordinary lit object in the ordinary depth buffer, and the thing that keeps it
 * out of walls is **that it is small and close**: `verifyBat` asserts that no
 * vertex of it, at any point in the swing, is more than `MAX_VIEW_REACH` from the
 * eye. At 0.90 m -- measured at 0.75 -- that is well inside the 1.55 m the hit
 * test reaches, so any wall the bat could clip into is a wall the player is
 * already standing against.
 *
 * The second thing the check guards is the reticle. A viewmodel that covers the
 * crosshair is a viewmodel that has to be moved after somebody complains, so the
 * rest pose's vertices are projected into camera space and asserted to clear a
 * cone around the view axis; measured, the nearest the resting blade comes is
 * 16.5 degrees against a 5.7-degree floor. The swing is exempt -- it sweeps
 * right to left across the lower half of the frame and crosses the centre line
 * under the crosshair, which is the gesture -- and only the pose the player
 * looks at for 95% of the session is held to the cone.
 *
 * ---------------------------------------------------------------------------
 * Cost. 188 triangles and 357 vertices, one geometry and one material for the
 * entire game, against `CharacterAssets`'s 440 triangles a figure. Sixteen
 * players with bats is 3,008 triangles in sixteen draws, which is a rounding
 * error beside the 483 k of trees in the spawn frame. The viewmodel is one draw
 * more.
 *
 * The 60 triangles the shoulder, the spine swell and the squared toe cost over
 * the paddle they replaced are two extra rings on the blade and one on the
 * handle. The answer to "it looks like a paddle" was proportion, not detail:
 * there is no new *feature* on this bat, only the same features in the places a
 * cricket bat has them.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardNodeMaterial,
  Vector3,
} from 'three/webgpu';

import { BONE, PUNCH_ACTIVE, PUNCH_RECOVERY, PUNCH_TOTAL, PUNCH_WIND_UP } from './animation.ts';
import { CharacterActor, CharacterAssets, SELF_SHADOW_LAYER } from './character.ts';
// The breath, which this file used to own four lines of and now shares with the
// football in the other hand. See `player/viewmodel-idle.ts`: the two copies had
// already drifted to different frequencies, and two nearly-equal periods on two
// objects that are on screen together beat against each other.
import { type IdleSway, verifyViewmodelIdle, viewmodelIdle } from './viewmodel-idle.ts';

// --- Proportions --------------------------------------------------------------

/*
 * Every dimension of the bat, in metres, in one place. `y = 0` is the top of the
 * grip -- the point the hand closes around and the point the prop is attached by
 * -- and the shaft runs down -Y from there.
 */

/** Top of the rubber grip cap, above the attachment point. */
const GRIP_CAP_Y = 0.028;
/**
 * Where the rubber grip stops and the bare cane of the splice shows.
 *
 * **-0.092, up from -0.175.** The rubber runs 0.120 m from the cap, against
 * 0.203 m, and it moved because the handle under it did: the third report --
 * *"the bat still has way too long a handle, it's like 2x too long"* -- halved
 * the handle, and a sleeve is a fraction of the thing it is pulled over rather
 * than a length of its own. 0.120 of 0.140 is 86%, which is what a real grip
 * covers; the 73% of the previous pass was itself a compromise with a handle
 * that was too long to cover.
 *
 * The rule it is set by is the real object's: **the grip covers the handle and
 * nothing else.** A cricket bat's rubber is a sleeve pulled over the cane down
 * to somewhere above the splice, and the bare cane and the binding below it are
 * visible on every bat ever made. A grip that ran on into the shoulder would
 * hide the join, and a join you cannot see is read as one tapered object -- the
 * paddle, again, from the direction the colour buffer rather than the outline
 * gives it away.
 *
 * There is 20 mm of splice below it now rather than 75, and that is the one thing
 * this pass genuinely gave up. What has to survive is the *step*, not the span: a
 * 4 mm-proud pale collar directly under the rubber, and 43 mm from the end of the
 * rubber to where the blade is at full width. `verifyBat` measures that gap off
 * the colour buffer and is written against 30 mm, down from 40, which is the
 * honest consequence of a handle half as long.
 */
const GRIP_END_Y = -0.092;
/**
 * Where the handle ends and the blade begins. The shoulder.
 *
 * **-0.112, up from -0.25**, which puts the handle at 0.140 m of a 0.828 m bat --
 * 16.9%, against 33.6% before. It is the third paddle report's own arithmetic:
 * *"like 2x too long"* against a 0.278 m handle is 0.139 m, and this is that to
 * the millimetre.
 *
 * Everything below this line is unchanged: the toe is still at `TOE_Y` and the bat
 * is still `BAT_LENGTH` long, so the 138 mm the handle gave up went straight into
 * the blade and **not one number the hit test or the clearance checks measure has
 * moved.** That is the same discipline the previous pass kept and it matters more
 * here, because the change is bigger: `combat.REACH` and `CAST_RADIUS` are
 * compiled into the server, `MAX_VIEW_REACH` is the claim that lets the viewmodel
 * skip a second render pass, and the whole point of a proportion fix is that it is
 * only a proportion fix. `verifyBat` re-measures all three off the real rig.
 */
const SHOULDER_Y = -0.112;
/**
 * Where the blade is at full width, and the single most important number in
 * this file for whether the *join* reads as a bat.
 *
 * 25 mm below the shoulder. A cricket bat's blade does not *grow* out of its
 * handle -- the splice is let into a blade that is already 108 mm across, so the
 * transition is a pair of near-square corners with about a 50-degree ramp under
 * them, and the eye reads that corner as "cricket" before it reads anything
 * else. This used to be 70 mm of smooth flare from 55% width, which is the same
 * curve a table-tennis bat has between its handle and its face, and it is why
 * the model first came back as *"the cricket bat looks like a paddle"*.
 *
 * It tracks `SHOULDER_Y` rather than standing on its own, because the thing that
 * has to stay true is the *ramp* and not the height it happens at. The ramp itself
 * came in from 30 mm to 25 with the handle: a corner is read against the parts
 * either side of it, and 30 mm under a 140 mm handle is a chamfer where 30 mm
 * under a 278 mm one was a corner.
 */
const SHOULDER_FULL_Y = SHOULDER_Y - 0.025;
/** Where the toe's back bevel starts. The last 45 mm lose depth, not width. */
const TOE_BEVEL_Y = -0.755;
/** The toe. Overall length is `GRIP_CAP_Y - TOE_Y`. */
const TOE_Y = -0.8;

/** Overall length, grip cap to toe, metres. 0.83 m on a 1.70 m figure. */
export const BAT_LENGTH = GRIP_CAP_Y - TOE_Y;
/**
 * Blade length, shoulder to toe. **83% of the bat**, where a real one is 66%.
 *
 * The header carries the argument; in one line, it is what the owner's third
 * report asked for and it is a first-person read rather than a Law 5 measurement.
 * `verifyBat` pins it so nobody restores the 66% by tidying.
 */
export const BLADE_LENGTH = SHOULDER_Y - TOE_Y;
/**
 * Blade half-width at the edges, metres. **0.054, so the blade is 108 mm across.**
 *
 * Law 5's maximum, and the number the header and `verifyBat`'s message have both
 * claimed since the first version of this file while `BLADE_PROFILE` quietly drew
 * 125 mm -- the check compared the geometry against *this constant* and passed,
 * because the constant was 0.0625 and the essay was the only thing telling the
 * truth. Both are now 108.
 *
 * A blade 16% over the legal width is the width half of "paddle": what tells a
 * table-tennis bat from a cricket bat, once the corners are right, is that one is
 * about as wide as it is long and the other is five times longer than it is
 * wide. This blade is 0.550 m over 0.108 m -- 5.1 -- where it used to be 0.485
 * over 0.125, which is 3.9 and is a *ping-pong* proportion wearing willow.
 */
const BLADE_HALF_WIDTH = 0.054;

/**
 * Handle radii: the grip cap, the shaft, and the collar at the bottom of the
 * rubber.
 *
 * **Every one of them is 1.18x what it was**, which is 1 / 0.85 and is the second
 * half of the third report: *"85% the thickness it should be"*. A measurement
 * given as a ratio is applied as a ratio -- the taper's *shape* is what makes the
 * object read as cane rather than as dowel, and scaling the four rings together is
 * the only change that leaves the shape alone.
 *
 * That takes the rubber from 36 mm across to 42 and the collar under it to 46,
 * against a 108 mm blade: a ratio of 2.3 where a real cricket bat is 3.4 and where
 * the two previous versions of this file were 2.8 and 3.0. **The real ratio is
 * knowingly abandoned here.** It was arrived at from photographs of bats held in
 * hands, and this object is seen from 45 cm with its grip off the bottom of the
 * frame, where a 3.4 handle under a wide blade reads as the blade being *stuck on
 * a wire*. The header states the same thing at length. `verifyBat` pins all four
 * to within 5%, because the failure mode is somebody reading the paragraph above
 * this one, looking up a real bat, and helpfully undoing a reported fix.
 */
const GRIP_CAP_R = 0.021;
const GRIP_TOP_R = 0.0177;
const GRIP_WAIST_R = 0.016;
const GRIP_END_R = 0.0184;

/**
 * The splice: bare cane between the rubber and the shoulder, with a proud
 * binding collar at the top of it.
 *
 * Pale against a near-black grip and a mid-tone blade, so the eye is given the
 * *join* -- which is where a cricket bat's handle visibly stops and a paddle's
 * never does. The collar is 4 mm proud of the cane under it, which at this scale
 * is one clear step in the silhouette rather than a stripe that only exists in
 * the colour buffer.
 *
 * The collar is the **widest thing on the handle** at 46 mm, which is what
 * `verifyBat`'s handle-to-blade check measures -- 0.43 of the blade, against the
 * 0.48 it now fails at. It used to be 39 mm and 0.36 against a 0.45 limit; both
 * moved by the 1.18 the grip radii did, and the limit moved with them because the
 * owner asked for a thicker handle and a check that forbade one would be the check
 * arguing with the report.
 *
 * The three heights are squeezed into the 20 mm between the rubber and the
 * shoulder (`GRIP_END_Y`, which explains the squeeze), and the collar sits
 * directly under the rubber where it always did: what it is for is a *step* in the
 * silhouette at the moment the black stops, and a step does not need span.
 *
 * `SPLICE_BASE_R` is the one radius that is **not** 1.18x its old self. It is
 * capped just under the blade's own neck -- `BLADE_PROFILE` scaled by the
 * shoulder ring's 0.4, which is 21.6 mm -- because the cane has to meet the neck
 * from *inside* it. At 1.18x it would be 24.2 mm, and the splice would flare wider
 * than the blade it is let into: a bulge above the shoulder, which is the one
 * silhouette feature no bat has and every hammer does.
 */
const COLLAR_Y = -0.0985;
const COLLAR_R = 0.0231;
const SPLICE_R = 0.0224;
const SPLICE_BASE_R = 0.0212;

/** Sides on the handle. Eight, which is `character.ts`'s `LIMB_SIDES` and reads round enough at arm's length. */
const HANDLE_SIDES = 8;

// --- Colour -------------------------------------------------------------------

type Rgb = readonly [number, number, number];

/*
 * Four linear albedos, on `character.ts`'s terms: every value below was picked
 * against the surfaces the bat is seen over rather than in isolation, because a
 * bat is a moving object at head height in front of a street.
 *
 * The blade is the only one that had to be measured. Willow is *pale* -- a new
 * bat is close to unfinished pine -- and the reference this project publishes for
 * a sunlit footpath is Y' 247, which is nearly white. A blade at the reflectance
 * of real willow disappears against it. So the face sits a little under: warm,
 * clearly wood, and about a fifth darker than the pavement it is swung over,
 * which is what keeps the silhouette when a fight moves onto a sunlit path.
 *
 * The two-tone split between face and back is not decoration either. Under
 * `flatShading` the V spine's two slopes differ from the face by only the cosine
 * of a shallow angle, so on a dull day the ridge vanishes and the blade reads as
 * a plank. Half a stop of albedo between them draws the spine at every light
 * angle for the cost of a different triple in a buffer.
 */
/** The hitting face and the chamfers: pale willow. */
const WILLOW_FACE: Rgb = [0.66, 0.58, 0.42];
/** The back slopes and the edges: the same wood, deeper, so the spine reads. */
const WILLOW_BACK: Rgb = [0.5, 0.42, 0.29];
/** The rubber grip. Near-black, the same family as the figure's charcoal kit. */
const GRIP: Rgb = [0.045, 0.045, 0.05];
/** The splice and the twine binding over it: bare cane, lighter than the blade. */
const SPLICE: Rgb = [0.78, 0.71, 0.53];

// --- The builder --------------------------------------------------------------

/** A point on a cross-section, in the bat's own X (across) and Z (front-to-back). */
type Profile = readonly (readonly [number, number])[];

/** One cross-section placed along the shaft: a height and the scale of the profile there. */
interface Ring {
  readonly y: number;
  readonly sx: number;
  readonly sz: number;
}

/**
 * Accumulates a lofted solid with a colour per profile edge.
 *
 * One primitive rather than the four `character.ts`'s `Parts` needs, because a
 * bat genuinely is one shape swept along one axis -- the handle is a lofted
 * circle, the blade is a lofted heptagon, and the twine is a lofted circle two
 * rings long. Everything below is one call to `loft`.
 *
 * **Winding, stated once.** A profile is ordered counter-clockwise in the (x, z)
 * plane read the usual way -- x to the right, z up the page -- so the outward
 * normal of the edge `p -> q` is `(dz, 0, -dx)`. That normal is *derived from the
 * profile* rather than from the triangles, which is what makes the winding check
 * in `verifyBat` a real test rather than a tautology: it compares the triangles'
 * own cross products against normals that were computed a different way. The
 * README's winding pass records 61% of the city's walls inside out for months
 * while looking like a city, and a closed loft has exactly that property.
 *
 * Indexed, with the faceting coming from `material.flatShading`, for the reason
 * `vegetation.ts` measured and `character.ts` repeats: a non-indexed build with
 * baked face normals triples the vertex count for the same triangles and the
 * same look. Each quad still gets its own four vertices, because two adjacent
 * faces of a bat share an edge and not a normal.
 */
class BatParts {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly colour: number[] = [];
  readonly index: number[] = [];

  private vertex(x: number, y: number, z: number, n: readonly [number, number, number], c: Rgb): void {
    this.position.push(x, y, z);
    this.normal.push(n[0], n[1], n[2]);
    this.colour.push(c[0], c[1], c[2]);
  }

  /**
   * Sweep `profile` through `rings` and close the ends that are asked for.
   *
   * `edgeColours` is one colour per profile *edge*, so a blade can carry a pale
   * face and deeper back slopes out of one call. `capColour` is used for both
   * end caps when they are built.
   *
   * The side normal is the profile edge's, taken at the mean of the two rings'
   * scales and **not tilted for the taper**. That is wrong by up to six degrees
   * on the blade's toe, and it costs nothing for the reason `character.lobe`
   * gives about its sphere normals: `flatShading` derives the shading normal
   * from screen-space derivatives and never reads this attribute. What the
   * attribute does feed is the shadow pass's `normalBias`, where six degrees on
   * a 3 cm offset is 3 mm.
   */
  loft(
    profile: Profile,
    rings: readonly Ring[],
    edgeColours: readonly Rgb[],
    capColour: Rgb,
    caps: { bottom: boolean; top: boolean },
  ): void {
    const n = profile.length;

    for (let r = 0; r + 1 < rings.length; r++) {
      const lower = rings[r + 1].y < rings[r].y ? rings[r + 1] : rings[r];
      const upper = rings[r + 1].y < rings[r].y ? rings[r] : rings[r + 1];
      const mx = (lower.sx + upper.sx) / 2;
      const mz = (lower.sz + upper.sz) / 2;

      for (let i = 0; i < n; i++) {
        const p = profile[i];
        const q = profile[(i + 1) % n];
        const du = (q[0] - p[0]) * mx;
        const dv = (q[1] - p[1]) * mz;
        const len = Math.hypot(du, dv) || 1;
        const normal: [number, number, number] = [dv / len, 0, -du / len];
        // Which edge's colour this is has to follow the *profile* index rather
        // than the loop's, so a blade's face keeps its colour whichever ring
        // pair is being emitted.
        const c = edgeColours[i % edgeColours.length];

        const base = this.position.length / 3;
        this.vertex(p[0] * lower.sx, lower.y, p[1] * lower.sz, normal, c);
        this.vertex(p[0] * upper.sx, upper.y, p[1] * upper.sz, normal, c);
        this.vertex(q[0] * upper.sx, upper.y, q[1] * upper.sz, normal, c);
        this.vertex(q[0] * lower.sx, lower.y, q[1] * lower.sz, normal, c);
        // (lowerP, upperP, upperQ) and (lowerP, upperQ, lowerQ). Both wind
        // counter-clockwise seen from the outward normal; the derivation is in
        // the class header and the check at the bottom of the file re-runs it.
        this.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }

    if (caps.bottom) this.cap(profile, rings[rings.length - 1], false, capColour);
    if (caps.top) this.cap(profile, rings[0], true, capColour);
  }

  /**
   * Close one end of a loft with a fan from the profile's centroid.
   *
   * The winding flips with the facing for the reason `character.disc` states:
   * seen from +Y with x to the right, increasing angle runs *clockwise* on
   * screen because z runs down it, so an up-facing fan has to be wound backwards
   * and a down-facing one forwards.
   */
  private cap(profile: Profile, ring: Ring, up: boolean, colour: Rgb): void {
    const n = profile.length;
    let cx = 0;
    let cz = 0;
    for (const [x, z] of profile) {
      cx += x;
      cz += z;
    }
    cx /= n;
    cz /= n;

    const normal: [number, number, number] = [0, up ? 1 : -1, 0];
    const base = this.position.length / 3;
    this.vertex(cx * ring.sx, ring.y, cz * ring.sz, normal, colour);
    for (const [x, z] of profile) this.vertex(x * ring.sx, ring.y, z * ring.sz, normal, colour);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (up) this.index.push(base, base + 1 + j, base + 1 + i);
      else this.index.push(base, base + 1 + i, base + 1 + j);
    }
  }

  get triangles(): number {
    return this.index.length / 3;
  }
}

/** A circle, counter-clockwise in (x, z), which is what `BatParts.loft` wants. */
function circle(sides: number): Profile {
  const points: Array<readonly [number, number]> = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    points.push([Math.cos(a), Math.sin(a)]);
  }
  return points;
}

/**
 * The blade's cross-section: a flat face at -Z, two chamfers, two edges, and a
 * ridge. Seven points, counter-clockwise in (x, z), in metres.
 *
 * The numbers are a Law 5 bat's, and they are now the ones the header claims:
 * **0.108 m across the edges, 0.022 m thick at the edge itself and 0.040 m at
 * the spine.** They used to be 0.125 / 0.020 / 0.070, which was 16% too wide and
 * three quarters too deep -- a section that reads as a *plank* side-on, and the
 * one dimension a paddle and a bat genuinely share is that neither of them is a
 * plank. The 40 mm spine is the brief's number and it is a shade under a modern
 * bat's 55-65; what it buys is a blade whose side-on silhouette is a thin blade
 * with a spine on it rather than a slab, which at this triangle count is the
 * whole of the read.
 *
 * What the chamfer buys is worth naming, since it is two of the seven points and
 * would be the obvious thing to drop: without it the face meets the edge at a
 * right angle, and a right angle on a flat-shaded object turns into a hard black
 * line down both sides of the blade at every light angle -- which reads as a
 * modelling seam rather than as a bat.
 */
const BLADE_PROFILE: Profile = [
  [-0.0475, -0.012], // face, left
  [0.0475, -0.012], // face, right
  [0.054, -0.0035], // right chamfer
  [0.054, 0.01], // right edge, back
  [0.0, 0.028], // the spine
  [-0.054, 0.01], // left edge, back
  [-0.054, -0.0035], // left chamfer
];

/** One colour per blade edge, in profile order. Face and chamfers pale, back deep. */
const BLADE_COLOURS: readonly Rgb[] = [
  WILLOW_FACE, // the hitting face
  WILLOW_FACE, // right chamfer
  WILLOW_BACK, // right edge
  WILLOW_BACK, // back slope, right
  WILLOW_BACK, // back slope, left
  WILLOW_BACK, // left edge
  WILLOW_FACE, // left chamfer
];

// --- The shared asset ---------------------------------------------------------

/**
 * One bat geometry and one material, for every bat in the game.
 *
 * Built once and shared, on `CharacterAssets`'s contract and with the same
 * consequence for teardown: a prop must never dispose this geometry, because
 * every other bat in the world is drawing it.
 */
export class BatAssets {
  readonly geometry: BufferGeometry;
  readonly material: MeshStandardNodeMaterial;
  readonly triangles: number;
  readonly vertices: number;

  constructor() {
    const p = new BatParts();
    const round = circle(HANDLE_SIDES);
    const roundColours = [GRIP];
    const spliceColours = [SPLICE];

    // --- The handle: a rubber grip, capped at the top so the bat is not a pipe
    // seen end-on when it is shouldered and the toe is pointing at the sky. It
    // stops **well** above the shoulder -- see `GRIP_END_Y`, which is the
    // constant the second paddle report asked for -- because a grip that ran all
    // the way into the blade is a paddle's handle, and one that ran most of the
    // way is a paddle's proportions.
    //
    // The waist ring sits at 0.6 of the rubber's length rather than at a fixed
    // depth, so the taper keeps its shape now that the sleeve is 60 mm shorter:
    // a waist pinned at -0.14 on a grip ending at -0.175 would put the narrowest
    // point 35 mm from the bottom and read as a bulge rather than as a taper.
    // **Derived rather than written out** since the third report halved the
    // handle: the same 0.6 on a 0.120 m sleeve is -0.044, and a literal here is
    // exactly the kind of number that survives a length change and turns a taper
    // into a bulge. The waist is now the one ring in the file computed from two
    // others, which is what stops it happening a fourth time.
    p.loft(
      round,
      [
        { y: GRIP_CAP_Y, sx: GRIP_CAP_R, sz: GRIP_CAP_R },
        { y: 0, sx: GRIP_TOP_R, sz: GRIP_TOP_R },
        { y: GRIP_CAP_Y - (GRIP_CAP_Y - GRIP_END_Y) * 0.6, sx: GRIP_WAIST_R, sz: GRIP_WAIST_R },
        { y: GRIP_END_Y, sx: GRIP_END_R, sz: GRIP_END_R },
      ],
      roundColours,
      GRIP,
      { bottom: false, top: true },
    );

    // --- The splice: the bound collar at the bottom of the rubber and the bare
    // cane below it, down to the shoulder. Pure signal, on the same argument the
    // twine ring this replaces made and one step further: a pale *step* at the
    // join tells a viewer where the handle stops, which on a dark grip against a
    // dark blade back is otherwise a guess -- and the guess a viewer makes when
    // they cannot see the join is "one tapered object", which is a paddle.
    p.loft(
      round,
      // The middle ring is placed at the midpoint of what is left below the
      // collar rather than at a height, for the reason the grip's waist is: this
      // span is 20 mm now and was 75, and a literal -0.228 in a table whose ends
      // are at -0.092 and -0.112 is a ring *below the blade*.
      [
        { y: GRIP_END_Y, sx: GRIP_END_R, sz: GRIP_END_R },
        { y: COLLAR_Y, sx: COLLAR_R, sz: COLLAR_R },
        { y: (COLLAR_Y + SHOULDER_Y) / 2, sx: SPLICE_R, sz: SPLICE_R },
        { y: SHOULDER_Y, sx: SPLICE_BASE_R, sz: SPLICE_BASE_R },
      ],
      spliceColours,
      SPLICE,
      { bottom: false, top: false },
    );

    // --- The blade. Square shoulders, a spine that swells low, and a toe that
    // is cut off square.
    //
    // Six rings, and every one of them is a silhouette decision:
    //
    //   `SHOULDER_Y`      40% wide -- the neck the splice is let into, barely
    //                     wider than the cane above it. **138 mm higher again**,
    //                     which is the whole of the third paddle fix: the blade
    //                     is 0.688 m of a 0.828 m bat, where the second fix left
    //                     it at 0.550 and the first at 0.485.
    //   `SHOULDER_FULL_Y` 100% wide, 25 mm later. **The corner.** See the
    //                     constant; this is the line between a bat and a paddle.
    //   a third down      full section, and *computed* as a third of the blade
    //                     rather than written as a height, which is the third
    //                     time this ring has had to move: -0.50 was a third of
    //                     the 0.485 blade, -0.46 a third of the 0.550 one, and
    //                     -0.341 is a third of this one. Left at -0.46 the
    //                     section would have been ramping over the top half of
    //                     the blade and flat over the bottom.
    //   -0.62             106% deep -- the spine swells over the middle of the
    //                     blade, which is where a real bat carries its wood and
    //                     is the bulge you see side-on. Width is untouched: the
    //                     back is a roof, and a roof gets taller, not wider.
    //   `TOE_BEVEL_Y`     the depth starts to go.
    //   `TOE_Y`           98.5% wide and 42% deep. **A squared toe.** The blade
    //                     keeps its width to the very end and loses only its
    //                     back, so the end cap is a flat rectangle. It used to
    //                     narrow to 90% and that is a rounded paddle tip -- the
    //                     one place a viewer looks to decide what shape a thing
    //                     on the end of a stick is.
    p.loft(
      BLADE_PROFILE,
      [
        { y: SHOULDER_Y, sx: 0.4, sz: 0.5 },
        { y: SHOULDER_FULL_Y, sx: 1, sz: 0.88 },
        { y: SHOULDER_Y - (SHOULDER_Y - TOE_Y) / 3, sx: 1, sz: 1 },
        { y: -0.62, sx: 1, sz: 1.06 },
        { y: TOE_BEVEL_Y, sx: 1, sz: 0.86 },
        { y: TOE_Y, sx: 0.985, sz: 0.42 },
      ],
      BLADE_COLOURS,
      WILLOW_FACE,
      { bottom: true, top: true },
    );

    const geometry = new BufferGeometry();
    geometry.name = 'cricket-bat';
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(p.position), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array(p.normal), 3));
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(p.colour), 3));
    geometry.setIndex(new BufferAttribute(new Uint16Array(p.index), 1));
    geometry.computeBoundingSphere();
    this.geometry = geometry;
    this.triangles = p.triangles;
    this.vertices = p.position.length / 3;

    // Lit, like the football in the other hand and unlike the beam weapon this
    // game used to carry, and that is the difference between an object and an
    // emitter: a bat has no output of its own, so the thing that has to be true
    // of it is that it goes dark when the player walks into a building's
    // shadow.
    const material = new MeshStandardNodeMaterial();
    material.name = 'cricket-bat';
    material.vertexColors = true;
    material.color = new Color(1, 1, 1);
    // A shade glossier than the figure's 0.78. A bat is oiled willow over a
    // varnished splice, which carries a sheen the cotton singlet next to it does
    // not; at the character's own roughness the blade goes to felt and stops
    // reading as wood.
    material.roughness = 0.62;
    material.metalness = 0;
    material.flatShading = true;
    this.material = material;
  }
}

// --- The third-person prop ----------------------------------------------------

/**
 * How the bat sits in the hand. See the file header for the derivation of the
 * pitch, which is the only one of the three that is load-bearing.
 */
const HOLD_PITCH = -2.72;
/**
 * A roll about the bat's own shaft. Free of the pose -- a roll about -Y cannot
 * change where -Y points -- so it only decides which way the flat face is
 * turned, and it is set so the face leads through the strike rather than the
 * edge.
 */
const HOLD_ROLL = 0.38;
/** Where in the wrist's frame the grip sits. The mitt's centre is 65 mm below the joint. */
const HOLD_OFFSET: readonly [number, number, number] = [0.012, -0.078, -0.012];

/**
 * One character's bat.
 *
 * Parented to a **bone** rather than positioned each frame from a bone's world
 * matrix -- one line, and it saves a matrix decompose per character per frame,
 * because three composes the skeleton for the skinning anyway.
 *
 * Unlike the football in the other hand this has no `set()` and no way to be
 * hidden. A bat is not a weapon you put away: spec 8.2's melee is always
 * available, and a bat that vanished between swings would be the only object in
 * the game that appeared out of nowhere on a mouse click. A ball, by contrast,
 * is genuinely gone once you have thrown it.
 */
export class BatProp {
  readonly mesh: Mesh;

  constructor(assets: BatAssets, actor: CharacterActor) {
    const mesh = new Mesh(assets.geometry, assets.material);
    mesh.name = 'cricket-bat';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Culled with its character. A 0.83 m object on a figure that is already
    // frustum-tested has nothing to gain from a test of its own, and would need
    // its own animated bounds to survive a swing -- which is the trap
    // `CharacterAssets` documents about `SkinnedMesh.boundingSphere`.
    mesh.frustumCulled = false;
    mesh.position.set(HOLD_OFFSET[0], HOLD_OFFSET[1], HOLD_OFFSET[2]);
    mesh.rotation.set(HOLD_PITCH, HOLD_ROLL, 0);
    actor.bones[BONE.WRIST_R].add(mesh);
    this.mesh = mesh;
  }

  /**
   * Put this bat on the local player's own body: seen by the sun, not by the eye.
   *
   * The counterpart of `character.castShadowOnly`, and it has to be called
   * separately because **three does not inherit layers**. `Renderer._projectObject`
   * tests every object's own mask and recurses into its children either way, so a
   * prop parented to a bone of a mesh that was moved to `SELF_SHADOW_LAYER` is
   * still on layer 0 and is still drawn -- which in first person is a bat
   * hanging at your own hip, in frame, every time you look down. The shadow
   * camera already has the layer enabled by `castShadowOnly`; this is the other
   * half of that arrangement.
   */
  castShadowOnly(): void {
    this.mesh.layers.set(SELF_SHADOW_LAYER);
    this.mesh.castShadow = true;
    // Pointless on an object the camera never draws, and it would compile a
    // second pipeline variant: three keys the render pipeline on `receiveShadow`.
    this.mesh.receiveShadow = false;
  }

  dispose(): void {
    this.mesh.removeFromParent();
  }
}

// --- The swing curve ----------------------------------------------------------

/**
 * The phases the viewmodel reads. A subset of `combat.CombatPhase`, restated as
 * a parameter rather than imported as a type, so this module can be swung by a
 * check with no combatant in hand.
 */
export type SwingPhase = 'idle' | 'windup' | 'active' | 'recovery' | 'flinch' | 'ko';

/**
 * Where the swing is, as one number: **-1 fully coiled, 0 at rest, +1 at the end
 * of the follow-through.**
 *
 * One scalar rather than a pose per phase, and that is the whole reason the
 * viewmodel is checkable. Three independently authored poses meet at two
 * boundaries, and the failure at a boundary is a bat that jumps a hand's width
 * in one frame -- which at 150 ms into a 500 ms cycle reads as a dropped frame
 * rather than as a bug. A single monotone parameter cannot do that, and
 * `verifyBat` asserts both halves of it: that the curve is continuous across
 * both boundaries, and that it moves one way through the wind-up and the other
 * way through the strike.
 *
 * The easings are `animation.punchPose`'s, for the same reasons stated there:
 * `t^0.6` on the wind-up puts most of the coil in the first half of the window
 * so the bat is *waiting* at the top of the backlift, and `t^0.45` on the strike
 * gets the blade most of the way through in the first 30 of its 100 ms. The
 * recovery is a damped oscillator that crosses rest once and settles behind it
 * by 8% -- one visible wobble, which is a bat's own mass carrying the swing
 * past its stopping point, and not a shiver.
 */
export function swingDrive(phase: SwingPhase, phaseT: number): number {
  if (phase === 'windup') {
    return -Math.pow(clamp01(phaseT / PUNCH_WIND_UP), 0.6);
  }
  if (phase === 'active') {
    return -1 + 1.85 * Math.pow(clamp01(phaseT / PUNCH_ACTIVE), 0.45);
  }
  if (phase === 'recovery') {
    const t = clamp01(phaseT / PUNCH_RECOVERY);
    return 0.85 * Math.exp(-4.2 * t) * Math.cos(5.0 * t);
  }
  return 0;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

// --- The first-person viewmodel -----------------------------------------------

/**
 * The three key poses, as a hand position and an orientation of the bat about it.
 *
 * A pivot-and-rotation rather than three baked transforms, because a bat swings
 * about the hand and interpolating the *rotation* is what produces an arc. Three
 * lerped positions produce a chord, and a blade that travels in a straight line
 * across the screen is the tell that a viewmodel was keyframed by somebody who
 * did not want to think about it.
 */
interface ViewKey {
  /** The grip, in camera space. -Z is forward, +X right, +Y up. */
  readonly at: readonly [number, number, number];
  /**
   * Euler XYZ applied to the bat about the grip, and the one thing about it that
   * has to be understood before the numbers mean anything.
   *
   * Three composes an XYZ Euler as `Rx * Ry * Rz`, so a vector is rotated by Z
   * first and by X last. The bat's shaft is its local **-Y**, and `Ry` cannot
   * move the Y axis at all -- so with these keys:
   *
   *   **X is the pitch** of the shaft, up and over or down and through.
   *   **Z is the sideways sweep**, right at the coil and left at the follow-through.
   *   **Y is a roll about the shaft**, which turns the flat face and moves the
   *   blade nowhere.
   *
   * That is the opposite of the reading a viewmodel usually invites, which is
   * that Y is the yaw, and getting it that way round produces a swing that
   * pitches correctly and never leaves the sagittal plane -- a chop, with a
   * lateral component that turns out to be entirely the grip's own offset.
   */
  readonly rot: readonly [number, number, number];
}

/**
 * Rest: low and right, blade forward and a little down, well clear of the middle
 * of the screen.
 *
 * The pitch is 1.19 rad, which takes the shaft's -Y round to 21 degrees below the
 * view axis, and the yaw of -0.19 pushes the toe out to the right so the blade
 * lies along the bottom-right corner rather than across the lower third. The
 * grip itself is *off the bottom of the screen* at this project's 72-degree
 * field -- 42 degrees below the axis against a 36-degree half-field -- so what
 * the player sees is a blade rising into frame from the corner and not a hand
 * holding a stick, which is the read a viewmodel wants when there are no arms
 * modelled to go with it.
 *
 * Both angles are asserted rather than admired: `verifyBat` projects every
 * vertex of this pose and requires the whole bat to clear a cone around the
 * crosshair.
 */
const REST_KEY: ViewKey = { at: [0.319, -0.217, -0.26], rot: [1.7335, 0, -0.3152] };

/**
 * Coil: up and back over the right shoulder, most of the blade out of frame.
 *
 * The pitch swings through 3.7 rad between here and rest, which is what takes the
 * toe from in front of the player to behind their ear, and the hand rises 0.15 m
 * with it. The anticipation is deliberately large -- most of the bat leaves the
 * screen -- for spec 8.2's own reason about the wind-up: 150 ms is a long time
 * to look at nothing, and what makes a swing read as committed is how far back
 * it started.
 */
const COIL_KEY: ViewKey = { at: [0.34, -0.02, -0.2], rot: [2.4, -0.35, 0.1506] };

/**
 * Strike: swept down and across to the left, blade past the centre line.
 *
 * The sideways sweep is the **Z** of the Euler and not the Y -- see `ViewKey`,
 * where the reason is that three's XYZ order applies Z first and Y cannot move
 * the shaft at all. It runs +0.15 at the coil to -0.52 here, which carries the
 * blade from the top-right corner to the lower left.
 *
 * Measured in normalised device coordinates at a 72-degree field: the tip goes
 * from (0.62, 0.86) at the top of the backlift, through (0.20, -0.24) at the
 * midpoint, to (-0.36, -0.43). So the whole blade is on screen for the second
 * half of the strike and it crosses the centre line just under the crosshair --
 * a swing the player watches rather than one that blanks their aim.
 */
const STRIKE_KEY: ViewKey = { at: [-0.13, -0.1, -0.24], rot: [1.4318, 0.45, -0.5236] };

/**
 * How far a vertex of the viewmodel may ever be from the eye. See the header.
 *
 * 0.90 m, and the number is a wall-clipping budget rather than a taste. A player
 * standing square against a terrace has their eye `PLAYER_RADIUS` -- 0.34 m --
 * from it, so *any* viewmodel intersects a wall the player is touching; what the
 * budget buys is that it stops happening a metre out. Together with the scale
 * below it also keeps the whole bat inside the 1.55 m the hit test reaches, so
 * the blade can never be drawn through something it could not have hit.
 */
export const MAX_VIEW_REACH = 0.9;
/**
 * How much of the bat's own length the viewmodel is drawn at.
 *
 * Viewmodels are always smaller than the object they represent -- a full-size
 * 0.83 m bat held where a hand really is fills a third of the screen and clips
 * every doorway -- and 0.58 puts the blade at 0.48 m, which at half a metre from
 * the eye still subtends about a fifth of the frame's height. Large enough to
 * be the thing you are holding; small enough for the budget above.
 */
const VIEW_SCALE = 0.58;
/** A constant roll about the shaft, so the blade shows its face and not its edge. */
const VIEW_ROLL = 0.25;

/**
 * The half-angle around the view axis the *rest* pose must clear, radians.
 *
 * 0.10 rad is 5.7 degrees, which at this project's 72-degree vertical field is
 * about 8% of the screen height -- comfortably more than the reticle, which is a
 * few pixels, and enough that the bat is not crowding it either.
 */
export const RETICLE_CLEARANCE = 0.1;

/** How hard the bat lags a mouse turn, and how fast that lag decays. */
const SWAY_GAIN = 0.055;
const SWAY_TAU = 0.09;
/** How far the bat bobs with a stride, metres at a sprint. */
const BOB_AMOUNT = 0.026;

/**
 * The connect kick: a bat that has hit something stops, and the hands do not.
 *
 * Started by `connect()` from `main.ts`'s hit report and decayed here, which is
 * the same arrangement `game/feedback.ts` uses for the shake and for the same
 * reason -- one clock, one place to change the timing. 90 ms matches
 * `combat.HITSTOP` exactly, so the bat's shudder runs over precisely the frames
 * the simulation is frozen for, and the two read as one event.
 */
const CONNECT_SECONDS = 0.09;

/**
 * The bat you are holding.
 *
 * A `Group` at the grip with the mesh inside it, so the bat rotates about the
 * hand and the group carries the sway and the bob. Added to the **camera**,
 * which means `main.ts` has to put the camera in the scene -- three only walks
 * `scene`, so a child of a detached camera is never drawn. That is one line
 * there and is the whole cost of this being camera-attached rather than
 * re-positioned from the camera's world matrix every frame.
 */
export class BatViewmodel {
  readonly group: Group;
  readonly mesh: Mesh;

  /** Wall-clock seconds. The idle bob and the sway phase run on it. */
  private clock = 0;
  /** Eased yaw and pitch lag, radians of camera turn not yet caught up with. */
  private swayYaw = 0;
  private swayPitch = 0;
  private lastYaw = 0;
  private lastPitch = 0;
  private seeded = false;
  /** Seconds left of the connect kick. */
  private connectT = 0;
  /** Stride phase, advanced by distance, exactly as `CharacterActor` does it. */
  private stride = 0;
  /** Where `viewmodelIdle` writes. Owned rather than allocated per frame. */
  private readonly idle: IdleSway = { x: 0, y: 0 };

  constructor(assets: BatAssets) {
    const mesh = new Mesh(assets.geometry, assets.material);
    mesh.name = 'cricket-bat:viewmodel';
    // Never in the depth pass. A bat welded to the eye would cast a shadow from
    // head height that follows the player around the footpath, which is both
    // wrong and the single most distracting thing a viewmodel can do.
    mesh.castShadow = false;
    // Receiving is kept, and it is the thing that stops the bat looking pasted
    // on: walk into a terrace's shadow and the bat goes with you. It is the same
    // argument `character.ts` makes about a figure standing in shade.
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.scale.setScalar(VIEW_SCALE);
    // A fixed roll about the shaft, applied **inside** the group so it is a true
    // roll: the group's own rotation multiplies this one, so `Ry` here acts on
    // the bat's local axes and turns the blade about its length without moving
    // the shaft a millimetre. It exists so the player sees the flat face rather
    // than the edge, which is the difference between a cricket bat and a stick.
    mesh.rotation.set(0, VIEW_ROLL, 0);

    const group = new Group();
    group.name = 'viewmodel';
    group.frustumCulled = false;
    group.add(mesh);

    this.mesh = mesh;
    this.group = group;
  }

  /** The blade landed on somebody. Adds the shudder; see `CONNECT_SECONDS`. */
  connect(): void {
    this.connectT = CONNECT_SECONDS;
  }

  /**
   * Pose the bat for this frame.
   *
   * Frame delta rather than the fixed step, on `main.ts`'s own rule about the
   * actors: the simulation is fixed so prediction and rewind agree, and a
   * viewmodel is presentation and has to be smooth at whatever rate the display
   * runs. `phase` and `phaseT` come straight off the local player's predicted
   * `CombatantState`, so the swing starts on the frame the button goes down
   * rather than on the next round trip.
   */
  update(
    dt: number,
    state: {
      phase: SwingPhase;
      phaseT: number;
      /** Horizontal speed, m/s. Drives the bob. */
      speed: number;
      /** The camera's yaw and pitch, radians. The sway is their derivative. */
      yaw: number;
      pitch: number;
      /** Frozen animation, not slowed: the pose holds on the frame the hit landed. */
      hitstop: boolean;
      /**
       * Seconds since the player's last throw -- `combat.ballT`. Absent means
       * never, which is what every caller written before the ranged weapon
       * existed means and what `verifyBat` passes.
       *
       * The bat **dips out of the way** while the other hand throws, and it is
       * one number rather than a pose because that is all it needs to be: the
       * throw is a 340 ms overlay on a weapon held in the other hand, and what
       * the bat has to do is stop competing for the frame. Without it the blade
       * sits rock-steady in the corner through an action that is visibly
       * whole-body, which reads as two animations that have not been introduced.
       *
       * `world/footyball.ts` owns the throw's own timing; this only has to be
       * over by the time that is. See `THROW_DIP_SECONDS`.
       */
      throwT?: number;
    },
  ): void {
    // A knocked-out player is not holding the bat up, and a bat left in frame
    // over a camera lying on the pavement is the loudest possible way of saying
    // the viewmodel does not know what the game is doing.
    const down = state.phase === 'ko';
    this.group.visible = !down;
    if (down) {
      this.seeded = false;
      return;
    }

    const step = state.hitstop ? 0 : dt;
    this.clock += step;
    if (this.connectT > 0) this.connectT = Math.max(0, this.connectT - step);

    // The sway is the *derivative* of the look, low-passed. Seeded on the first
    // frame rather than started at zero, because the difference between an
    // uninitialised yaw and the player's actual one is a whole turn, and the
    // bat would swing through a full arc on the frame the game starts.
    if (!this.seeded) {
      this.lastYaw = state.yaw;
      this.lastPitch = state.pitch;
      this.seeded = true;
    }
    const dYaw = wrapPi(state.yaw - this.lastYaw);
    const dPitch = state.pitch - this.lastPitch;
    this.lastYaw = state.yaw;
    this.lastPitch = state.pitch;
    const k = Math.min(1, 1 - Math.exp(-Math.max(step, 1e-6) / SWAY_TAU));
    this.swayYaw += (dYaw * SWAY_GAIN * 12 - this.swayYaw) * k;
    this.swayPitch += (dPitch * SWAY_GAIN * 12 - this.swayPitch) * k;

    // The stride, advanced by distance walked rather than by a clock, which is
    // `animation.ClipContext`'s rule and is what keeps the bob in step with the
    // feet at every speed and through every acceleration.
    this.stride = (this.stride + state.speed * step * 3.6) % (Math.PI * 2);
    const gait = Math.min(1, state.speed / 8.2);
    const bob = Math.sin(this.stride * 2) * BOB_AMOUNT * gait;
    const roll = Math.sin(this.stride) * 0.05 * gait;
    // A slow figure-eight when standing still, on two periods that do not divide
    // each other -- `animation.clipIdle`'s trick, one object down. **The four
    // lines this was are now `player/viewmodel-idle.ts`**, shared with the
    // football's viewmodel: they were the same idea written twice and had drifted
    // to different frequencies, which is visible when both are on screen.
    const idle = viewmodelIdle(this.clock, gait, this.idle);
    const idleX = idle.x;
    const idleY = idle.y;

    const drive = swingDrive(state.phase, state.phaseT);
    const key = blendKeys(drive);

    // The connect kick: the bat is arrested and the hands ring on. Applied on
    // top of the swing rather than blended into it, so a hit at any point in the
    // active window shudders from wherever the blade actually was.
    const shock = this.connectT / CONNECT_SECONDS;
    const jolt = shock > 0 ? shock * shock * Math.sin(shock * 34) : 0;

    // The throw dip. A half-sine over its window, so the bat drops away and
    // comes back with no discontinuity at either end -- the same property
    // `swingDrive` is checked for, arrived at by using a curve that is zero at
    // both limits rather than by asserting it.
    const dip =
      state.throwT !== undefined && state.throwT < THROW_DIP_SECONDS
        ? Math.sin((state.throwT / THROW_DIP_SECONDS) * Math.PI)
        : 0;

    this.group.position.set(
      key.at[0] + idleX + this.swayYaw * 0.6 + jolt * 0.02 + dip * 0.09,
      key.at[1] + bob + idleY + this.swayPitch * 0.5 - jolt * 0.014 - dip * 0.16,
      key.at[2] + Math.abs(bob) * 0.4 + jolt * 0.03 + dip * 0.05,
    );
    this.group.rotation.set(
      key.rot[0] + this.swayPitch * 0.9 - jolt * 0.10 + dip * 0.34,
      key.rot[1] + this.swayYaw * 1.1,
      key.rot[2] + roll + jolt * 0.16 + dip * 0.22,
    );
  }
}

/**
 * How long the bat is dipped by a throw, seconds.
 *
 * A shade under `footyball.THROW_SECONDS` (0.34), so the bat is back at rest
 * fractionally before the ball is, and the eye reads the ball returning to the
 * hand as the end of the action rather than the bat settling. Restated here
 * rather than imported for `MEASURED_REACH_TARGET`'s reason: importing it would
 * couple the melee viewmodel to the ranged weapon's module for one number, and
 * the two are allowed to be retimed independently.
 */
const THROW_DIP_SECONDS = 0.3;

/**
 * Rest to coil for a negative drive, rest to strike for a positive one.
 *
 * Linear in the drive, because the drive is where every easing already lives:
 * putting a second curve here would mean two places to look when the timing of a
 * swing is wrong, and the shape of the arc comes from interpolating the
 * *rotation* rather than from the shape of the interpolation.
 */
function blendKeys(drive: number): ViewKey {
  const to = drive < 0 ? COIL_KEY : STRIKE_KEY;
  const w = Math.min(1, Math.abs(drive));
  const at: [number, number, number] = [0, 0, 0];
  const rot: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    at[i] = REST_KEY.at[i] + (to.at[i] - REST_KEY.at[i]) * w;
    rot[i] = REST_KEY.rot[i] + (to.rot[i] - REST_KEY.rot[i]) * w;
  }
  return { at, rot };
}

/** Shortest signed angle. A mouse that crosses the yaw wrap must not sway a full turn. */
function wrapPi(a: number): number {
  return a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
}

// --- The self-check -----------------------------------------------------------

/**
 * The bat, in the hand and in the eye, asserted.
 *
 * The repo's rule -- `verifyAnimation`, `verifyCharacterRig`, `verifyCombat` --
 * is that a check exists where the failure is **silent**: it renders, it does not
 * throw, and it reads as a taste decision. A weapon has an unusual number of
 * those, and each of the ones below is one that was actually hit while this was
 * being built:
 *
 *   - **Winding.** A lofted solid inside out is a bat you can see the inside of
 *     from outside and nothing else. This is the failure the README's winding
 *     pass documents on the city's walls.
 *   - **The blade is two thirds of the bat, and the rubber is a quarter of it.**
 *     The two the *second* paddle report was about, and the pair of them is the
 *     reason this list grew: the first four silhouette checks are all local to
 *     the join, so a model can pass every one of them and still be a short face
 *     on a long stick. Both are measured off the buffer -- the blade by walking
 *     up from the toe to the last full-width band, the rubber off the colour
 *     attribute -- so neither is a constant compared with itself.
 *   - **The bat is on the right wrist.** Parenting to the wrong bone -- or to the
 *     mesh, which also "works" -- produces a bat that floats near the character
 *     and does not swing. It looks like an animation problem.
 *   - **The toe is off the ground at idle and at a walk.** The one number this
 *     file's `HOLD_PITCH` exists to get right, and the failure is a blade
 *     scraping through the footpath at every step, which nobody sees from the
 *     first-person camera the developer is sitting in.
 *   - **The blade arrives where the hit test says it does.** `combat.REACH` was
 *     moved from 1.2 m to 1.65 m in this pass *because* the weapon changed, and a
 *     reach that no longer matches the picture is precisely the thing that reads
 *     as lag rather than as a number.
 *   - **The swing curve is continuous and monotone.** See `swingDrive`.
 *   - **The viewmodel stays close and clears the reticle.** Both are stated in
 *     the header as the reasons this can be a single-pass viewmodel at all, so
 *     both are measured rather than trusted.
 *
 * Pure and framework-free apart from three itself, so it runs outside a browser:
 *
 *     bun -e "import {verifyBat} from './src/player/bat.ts'; console.log(verifyBat())"
 */
export function verifyBat(): string[] {
  // The shared breath first, and from here rather than from `main.ts`'s boot list,
  // which is a 60-line chain five workstreams are editing at once. It is the same
  // arrangement `verifySunButton`'s renderer half has: the check belongs to
  // whoever depends on it, and this file and `world/footyball.ts` are the two
  // callers. `server/index.ts` runs it directly, because that process cannot
  // import this file at all -- three.
  const failures: string[] = [...verifyViewmodelIdle()];
  const assets = new BatAssets();

  // --- Budget. Not a spec number -- there is no bat in the spec -- but the
  // figure holding it is 440 triangles, and a prop that outweighs the character
  // is a prop that was modelled rather than built.
  if (assets.triangles > 260) {
    failures.push(`The bat is ${assets.triangles} triangles; the figure holding it is 440.`);
  }

  const position = assets.geometry.getAttribute('position');
  const normal = assets.geometry.getAttribute('normal');
  const index = assets.geometry.getIndex();
  if (index === null) {
    failures.push('The bat geometry is not indexed.');
    return failures;
  }

  // --- Winding. Every triangle's cross product has to agree with the mean of
  // the three vertex normals it was built from -- and those normals came from
  // the *profile*, not from the triangles, so this is a real test.
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const n = new Vector3();
  const face = new Vector3();
  let disagreeing = 0;
  for (let t = 0; t < index.count; t += 3) {
    const i0 = index.getX(t);
    const i1 = index.getX(t + 1);
    const i2 = index.getX(t + 2);
    a.fromBufferAttribute(position, i0);
    b.fromBufferAttribute(position, i1);
    c.fromBufferAttribute(position, i2);
    face.copy(b).sub(a).cross(n.copy(c).sub(a));
    if (face.lengthSq() < 1e-16) continue;
    face.normalize();
    n.set(0, 0, 0);
    for (const i of [i0, i1, i2]) {
      n.x += normal.getX(i);
      n.y += normal.getY(i);
      n.z += normal.getZ(i);
    }
    if (n.lengthSq() < 1e-12) continue;
    if (face.dot(n.normalize()) < 0) disagreeing++;
  }
  if (disagreeing > 0) {
    failures.push(
      `${disagreeing} of ${index.count / 3} bat triangles are wound against their own normals -- ` +
        `they will be back-face culled and the bat will be see-through from outside.`,
    );
  }

  // --- Proportion. A bat that has drifted to the length of a broom handle is
  // still a bat in a screenshot and is a different weapon in the hand.
  const bounds = extents(position);
  const length = bounds.max[1] - bounds.min[1];
  if (Math.abs(length - BAT_LENGTH) > 0.01) {
    failures.push(`The bat is ${length.toFixed(3)} m long; it should be ${BAT_LENGTH.toFixed(3)} m.`);
  }
  const width = bounds.max[0] - bounds.min[0];
  if (Math.abs(width - BLADE_HALF_WIDTH * 2) > 0.01) {
    failures.push(
      `The blade is ${(width * 1000).toFixed(0)} mm across; a Law 5 bat is 108 mm and this one is ` +
        `meant to be ${(BLADE_HALF_WIDTH * 2000).toFixed(0)}.`,
    );
  }

  // --- Silhouette: the three measurements that separate a bat from a paddle.
  //
  // Every one of these was *false* in the model that shipped and was reported as
  // "the cricket bat looks like a paddle", and none of them shows in any check
  // that already existed: the length was right, the width was right, the
  // cross-section was right, the winding was right, the reach was right. What
  // was wrong was the outline, which is the one property of a low-poly prop that
  // decides what a player thinks they are holding.
  //
  // Measured off the vertex buffer in horizontal bands rather than read off the
  // constants above, on `BatParts`'s own argument about the winding test: a check
  // that compares a constant with itself through two lines of the same file is
  // not a check.
  {
    const spanAt = (y0: number, y1: number): number => {
      let widest = 0;
      for (let i = 0; i < position.count; i++) {
        const y = position.getY(i);
        if (y < y0 || y > y1) continue;
        const x = Math.abs(position.getX(i));
        if (x > widest) widest = x;
      }
      return widest * 2;
    };
    const full = BLADE_HALF_WIDTH * 2;

    // 1. Square shoulders. Full width within 30 mm of where the blade starts --
    //    the corner a viewer reads as "cricket" before anything else. The limit
    //    came in from 40 mm with the handle: on a 140 mm handle a 40 mm flare is
    //    over a quarter of the stick, which is a taper rather than a corner.
    const atShoulderFull = spanAt(SHOULDER_FULL_Y - 0.002, SHOULDER_FULL_Y + 0.002);
    if (SHOULDER_Y - SHOULDER_FULL_Y > 0.03 + 1e-9 || atShoulderFull < full * 0.95) {
      failures.push(
        `The blade takes ${((SHOULDER_Y - SHOULDER_FULL_Y) * 1000).toFixed(0)} mm to reach ` +
          `${(atShoulderFull * 1000).toFixed(0)} mm of its ${(full * 1000).toFixed(0)} mm width. ` +
          `Square shoulders are full width inside 30 mm; a longer flare than that is the taper a ` +
          `table-tennis bat has between its handle and its face.`,
      );
    }

    // 2. A handle under half the blade. Measured over the whole grip and splice,
    //    so a fat collar counts against it too.
    //
    //    **The limit moved out from 0.45 to 0.48 on the owner's instruction**
    //    -- *"85% the thickness it should be"* -- and the direction it moved in is
    //    the awkward part: this check exists to catch a handle *too thick*, and it
    //    has just been told the handle was too thin. So it is kept, loosened by
    //    less than the change it is permitting (the collar went from 0.36 to 0.43
    //    of the blade), and the thing it now guards is the next step: a handle at
    //    half the blade's width has a shoulder that is not a corner, and at that
    //    point the whole join stops reading and we are back to the first report.
    const handle = spanAt(SHOULDER_Y + 0.001, GRIP_CAP_Y);
    if (handle > full * 0.48) {
      failures.push(
        `The handle is ${(handle * 1000).toFixed(0)} mm across against a ${(full * 1000).toFixed(0)} mm ` +
          `blade -- ${(handle / full).toFixed(2)} of it, where a real cricket bat is 0.30, this model ` +
          `is deliberately 0.43 on the owner's eye, and a paddle is about a half. Past 0.48 the ` +
          `shoulder has nothing left to be a corner of.`,
      );
    }
    // 2b. And the four grip radii themselves, pinned to within 5%. The silhouette
    //     checks around this one are all *ratios*, and a handle scaled to 85% of
    //     these numbers passes every one of them -- which is precisely the state
    //     the third report was made about. See `GRIP_CAP_R`.
    for (const [name, got, want] of [
      ['GRIP_CAP_R', GRIP_CAP_R, 0.021],
      ['GRIP_TOP_R', GRIP_TOP_R, 0.0177],
      ['GRIP_WAIST_R', GRIP_WAIST_R, 0.016],
      ['GRIP_END_R', GRIP_END_R, 0.0184],
    ] as ReadonlyArray<readonly [string, number, number]>) {
      if (Math.abs(got - want) > want * 0.05) {
        failures.push(
          `${name} is ${(got * 1000).toFixed(1)} mm against the ${(want * 1000).toFixed(1)} mm the ` +
            `owner's "85% the thickness it should be" asks for. These four are 1.18x an earlier ` +
            `model's and are a reported fix, not a derivation from a real bat.`,
        );
      }
    }
    // 2c. The splice can never be wider than the blade neck it is let into. A
    //     flare above the shoulder is the silhouette of a hammer.
    if (SPLICE_BASE_R > BLADE_HALF_WIDTH * 0.4 + 1e-9) {
      failures.push(
        `The splice base is ${(SPLICE_BASE_R * 1000).toFixed(1)} mm against a blade neck of ` +
          `${(BLADE_HALF_WIDTH * 0.4 * 1000).toFixed(1)} mm. The cane meets the neck from inside it; ` +
          `wider than the neck is a bulge above the shoulder, which no bat has.`,
      );
    }

    // 3. A squared toe. The last 5 mm of the blade keep their width; a blade that
    //    narrows at the tip is the shape of a paddle's face.
    const toe = spanAt(TOE_Y - 0.001, TOE_Y + 0.005);
    if (toe < full * 0.95) {
      failures.push(
        `The toe is ${(toe * 1000).toFixed(0)} mm across against a ${(full * 1000).toFixed(0)} mm ` +
          `blade. A cricket bat's toe is cut off square and loses its depth, not its width.`,
      );
    }

    // 4. And the spine swells. The back is deepest over the middle of the blade
    //    rather than being a constant-section plank, which is the bulge the eye
    //    reads side-on and the only part of the cross-section that varies.
    const depthAt = (y0: number, y1: number): number => {
      let back = -Infinity;
      for (let i = 0; i < position.count; i++) {
        const y = position.getY(i);
        if (y < y0 || y > y1) continue;
        const z = position.getZ(i);
        if (z > back) back = z;
      }
      return back;
    };
    const middle = depthAt(-0.63, -0.61);
    const nearToe = depthAt(TOE_BEVEL_Y - 0.002, TOE_BEVEL_Y + 0.002);
    if (!(middle > nearToe * 1.05)) {
      failures.push(
        `The spine stands ${(middle * 1000).toFixed(1)} mm proud over the middle of the blade ` +
          `against ${(nearToe * 1000).toFixed(1)} mm near the toe. A blade of constant section is ` +
          `a plank, and a plank on a stick is a paddle.`,
      );
    }

    // 5. **Five sixths of the bat is blade**, which is what the *second* and
    //    *third* paddle reports were both about and is the one property none of
    //    the four above can see: every corner on this model can be in exactly the
    //    right place and the object still read as a paddle, because a paddle is a
    //    short face on a long stick and all four checks above are local to the
    //    join.
    //
    //    Measured by walking up from the toe to the last band that is still
    //    within 95% of full width, so it finds the shoulder from the *geometry*
    //    rather than from `SHOULDER_Y`. **The band moved from 0.60..0.72 to
    //    0.80..0.88 on the third report** -- *"way too long a handle, it's like 2x
    //    too long"* -- and it is worth being clear that this is no longer a real
    //    bat's proportion: Law 5 is 66% and this is 80% of full width, 83% counted
    //    shoulder to toe. The file header carries the argument. What the band
    //    still catches is the two ways this can go wrong from here: a handle
    //    creeping back toward the third of the bat the owner rejected, and a bat
    //    with no visible handle at all, which is a plank.
    let bladeTop = TOE_Y;
    for (let y = TOE_Y; y <= GRIP_CAP_Y; y += 0.005) {
      if (spanAt(y - 0.0026, y + 0.0026) >= full * 0.95) bladeTop = y;
    }
    const bladeFraction = (bladeTop - TOE_Y) / (GRIP_CAP_Y - TOE_Y);
    if (bladeFraction < 0.8 || bladeFraction > 0.88) {
      failures.push(
        `The blade is ${(bladeFraction * 100).toFixed(0)}% of the bat's length at full width. The ` +
          `owner asked for a handle half as long as the 34% one this model used to have, which puts ` +
          `this between 80 and 88%; under that the handle is back to the length that was reported ` +
          `twice, and over it there is no handle to see.`,
      );
    }
    //    And the same proportion off the constants, shoulder to toe, which is the
    //    number the header and the owner's instruction are stated in. Two
    //    measurements of one property, 25 mm of ramp apart -- kept separate because
    //    the geometric one can be defeated by a ring that moved and this one
    //    cannot, and because `BLADE_LENGTH` is an export somebody might tidy.
    if (BLADE_LENGTH / BAT_LENGTH < 0.8) {
      failures.push(
        `BLADE_LENGTH is ${(BLADE_LENGTH / BAT_LENGTH * 100).toFixed(0)}% of BAT_LENGTH. The handle ` +
          `is meant to be 0.140 m of a 0.828 m bat -- half what it was -- which is 83% blade.`,
      );
    }
    //    ...and the handle itself, in metres, because "half as long" is the whole
    //    instruction and a fraction can be satisfied by a longer bat.
    if (Math.abs(GRIP_CAP_Y - SHOULDER_Y - 0.14) > 0.006) {
      failures.push(
        `The handle is ${((GRIP_CAP_Y - SHOULDER_Y) * 1000).toFixed(0)} mm from the grip cap to the ` +
          `shoulder. It is meant to be 140 -- the 278 it was, halved, which is what "2x too long" ` +
          `means measured.`,
      );
    }

    // 6. **The rubber grip covers the handle and stops above the shoulder.**
    //
    //    Read off the *colour* buffer rather than off `GRIP_END_Y`, which makes
    //    it a second opinion in the same way the winding check is: the colour
    //    was written by `loft` from the caller's `edgeColours` and the height by
    //    the ring table, so a grip lofted past the splice fails here even though
    //    both constants are individually fine.
    //
    //    Two claims. The rubber must **end above the blade** with bare cane
    //    showing -- a grip that runs into the shoulder hides the join, and a join
    //    a viewer cannot see is read as one tapered object. And it must be short in
    //    metres as well as in proportion: 0.120 m now, where the second report left
    //    0.203 and the model before that had 0.263. Both thresholds came down with
    //    the third report's halved handle, and the *span* of bare cane it asks for
    //    came down with them -- 20 mm of splice is what fits under a 140 mm handle,
    //    and what has to survive is the pale step at the join rather than a
    //    thumb's width of it.
    const colour = assets.geometry.getAttribute('color');
    let rubberLowest = Infinity;
    let rubberHighest = -Infinity;
    for (let i = 0; i < position.count; i++) {
      // The grip is the only near-black triple in the buffer; the willow and the
      // cane are all above 0.28 on every channel.
      if (colour.getX(i) > 0.1 || colour.getY(i) > 0.1) continue;
      const y = position.getY(i);
      if (y < rubberLowest) rubberLowest = y;
      if (y > rubberHighest) rubberHighest = y;
    }
    if (!Number.isFinite(rubberLowest)) {
      failures.push('No part of the bat is grip-coloured; the handle has lost its rubber.');
    } else {
      const bare = rubberLowest - bladeTop;
      if (bare < 0.03) {
        failures.push(
          `The rubber grip ends ${(bare * 1000).toFixed(0)} mm above the blade's full width. It has ` +
            `to leave at least 30 mm of collar, bare cane and shoulder ramp showing, or the join ` +
            `between the handle and the blade is invisible and the whole thing reads as one tapered ` +
            `object.`,
        );
      }
      const rubberLength = rubberHighest - rubberLowest;
      if (rubberLength > 0.13) {
        failures.push(
          `The rubber grip is ${(rubberLength * 1000).toFixed(0)} mm long. It covers a 140 mm handle ` +
            `and the instruction twice over has been to make the rubber bit shorter; past 130 it is ` +
            `either over the shoulder or on a handle that grew again.`,
        );
      }
      const rubber = rubberLength / (GRIP_CAP_Y - TOE_Y);
      if (rubber > 0.17) {
        failures.push(
          `The rubber grip is ${(rubber * 100).toFixed(0)}% of the bat's length. A sixth is what fits ` +
            `over this handle -- a quarter was the previous model's and a third was the one that came ` +
            `back as a paddle.`,
        );
      }
    }
  }

  // --- In the hand, and on the right bone.
  const characters = new CharacterAssets();
  const actor = new CharacterActor(characters, 0);
  const prop = new BatProp(assets, actor);
  if (prop.mesh.parent !== actor.bones[BONE.WRIST_R]) {
    failures.push(
      `The bat is parented to "${prop.mesh.parent?.name ?? 'nothing'}" rather than to the right ` +
        `wrist bone, so it will not swing with the arm.`,
    );
  }

  // --- The toe clears the footpath at idle and through a walk cycle.
  //
  // Stepped through the real actor and read off the real bone matrices, because
  // the whole question is what the *chain* does -- the sum of the shoulder, the
  // elbow, the wrist and `HOLD_PITCH`, which is the arithmetic in the header and
  // is exactly the kind of thing that is right on paper and 20 cm wrong in a
  // skeleton.
  const at = { x: 0, y: 0, z: 0 };
  let furthest = 0;
  for (const [name, speed, seconds, swing] of [
    ['idle', 0, 1.4, false],
    ['walk', 4.4, 1.4, false],
    ['run', 8.2, 1.0, false],
    ['the swing', 0, PUNCH_TOTAL, true],
  ] as Array<[string, number, number, boolean]>) {
    actor.setAction(null);
    if (swing) actor.setAction('punch');
    let lowest = Infinity;
    const steps = Math.round(seconds * 60);
    for (let s = 0; s < steps; s++) {
      actor.update(1 / 60, { position: at, yaw: 0, speed, onGround: true });
      lowest = Math.min(lowest, lowestBatVertex(actor, prop, position));
      // The reach, measured on the same pass as the clearance -- see below.
      if (swing) furthest = Math.max(furthest, toePlanReach(actor, prop));
    }
    // Five centimetres, and it is not zero on purpose: a bat carried at a run
    // swings with the arm, and a swing genuinely scythes the blade past the
    // player's own feet on its way through. Demanding daylight at every phase
    // would mean pinning the arm rather than letting the clip run. Measured
    // clearances at the time of writing: 0.38 m carried, 0.06 m at the bottom of
    // the swing arc.
    if (lowest < -0.05) {
      failures.push(
        `Through "${name}" the bat's toe goes ${(-lowest * 100).toFixed(1)} cm under the ` +
          `pavement. HOLD_PITCH decides the carry and the swing clip in player/animation.ts ` +
          `decides the rest; see the header.`,
      );
    }
  }

  // --- The blade arrives where the hit test claims it does.
  //
  // The toe's *plan* distance from the eye at its furthest, because plan distance
  // is the quantity `hitTest` gates on -- see its header, where the plan gate is
  // what makes the reach a weapon's length rather than the 2.37 m a naive
  // sphere-cast reaches.
  //
  // A band rather than a target, and the two edges of it say different things.
  // Reaching **past** the hit test is the one that must never happen: a blade
  // that visibly sweeps through somebody who takes no damage is the failure
  // players report as lag. Falling a long way **short** is the milder one, and
  // some shortfall is correct -- the fist this replaced landed 0.3 m beyond
  // where the mitt got, on exactly this measurement, and the game shipped that
  // way. So: most of the way there, and never beyond.
  if (furthest > MEASURED_REACH_TARGET) {
    failures.push(
      `The bat's toe reaches ${furthest.toFixed(2)} m from the eye, past the ` +
        `${MEASURED_REACH_TARGET.toFixed(2)} m the hit test stops at. A weapon that visibly sweeps ` +
        `through someone it does not damage reads as lag rather than as a number.`,
    );
  }
  if (furthest < MEASURED_REACH_TARGET - 0.45) {
    failures.push(
      `The bat's toe only reaches ${furthest.toFixed(2)} m from the eye against a hit test that ` +
        `reaches ${MEASURED_REACH_TARGET.toFixed(2)} m. That gap is a hit landing on nobody the ` +
        `player can see the blade touching.`,
    );
  }

  // --- The swing curve: continuous across both boundaries, and monotone through
  // the two windows that have to be.
  {
    const boundaries: Array<[string, number, number, SwingPhase, SwingPhase]> = [
      ['wind-up to active', PUNCH_WIND_UP, 0, 'windup', 'active'],
      ['active to recovery', PUNCH_ACTIVE, 0, 'active', 'recovery'],
    ];
    for (const [label, endT, startT, from, to] of boundaries) {
      const before = swingDrive(from, endT);
      const after = swingDrive(to, startT);
      if (Math.abs(before - after) > 1e-6) {
        failures.push(
          `The swing jumps ${(after - before).toFixed(3)} at the ${label} boundary. A discontinuity ` +
            `there is a bat that moves a hand's width in one frame and reads as a dropped frame.`,
        );
      }
    }
    let worstUp = 0;
    let worstDown = 0;
    let previousCoil = swingDrive('windup', 0);
    let previousStrike = swingDrive('active', 0);
    for (let i = 1; i <= 64; i++) {
      const coil = swingDrive('windup', (i / 64) * PUNCH_WIND_UP);
      if (coil > previousCoil) worstDown = Math.max(worstDown, coil - previousCoil);
      previousCoil = coil;
      const strike = swingDrive('active', (i / 64) * PUNCH_ACTIVE);
      if (strike < previousStrike) worstUp = Math.max(worstUp, previousStrike - strike);
      previousStrike = strike;
    }
    if (worstDown > 1e-9) {
      failures.push(`The wind-up un-coils by ${worstDown.toFixed(4)} partway through. It must only pull back.`);
    }
    if (worstUp > 1e-9) {
      failures.push(`The strike moves backwards by ${worstUp.toFixed(4)} partway through. It must only sweep forward.`);
    }
    if (Math.abs(swingDrive('idle', 0)) > 1e-9 || Math.abs(swingDrive('flinch', 0.2)) > 1e-9) {
      failures.push('The bat is not at rest in a phase that is not a swing.');
    }
  }

  // --- The viewmodel: close enough not to need a second pass, and clear of the
  // reticle in the pose the player looks at all session.
  {
    const view = new BatViewmodel(assets);
    let furthestVertex = 0;
    const vertex = new Vector3();
    // Every phase of the swing, plus the rest pose, with the sway and bob at
    // zero -- they add under 4 cm and would only blur the number this is for.
    const samples: Array<[SwingPhase, number]> = [['idle', 0]];
    for (let i = 0; i <= 12; i++) samples.push(['windup', (i / 12) * PUNCH_WIND_UP]);
    for (let i = 0; i <= 12; i++) samples.push(['active', (i / 12) * PUNCH_ACTIVE]);
    for (let i = 0; i <= 12; i++) samples.push(['recovery', (i / 12) * PUNCH_RECOVERY]);
    let worstAngle = Infinity;
    for (const [phase, phaseT] of samples) {
      view.update(1 / 60, { phase, phaseT, speed: 0, yaw: 0, pitch: 0, hitstop: false });
      view.group.updateMatrixWorld(true);
      for (let i = 0; i < position.count; i++) {
        vertex.fromBufferAttribute(position, i).applyMatrix4(view.mesh.matrixWorld);
        furthestVertex = Math.max(furthestVertex, vertex.length());
        // The rest pose only, and only the reticle question. The swing is
        // *meant* to cross the centre of the screen.
        if (phase === 'idle') {
          const forward = -vertex.z;
          const off = Math.hypot(vertex.x, vertex.y);
          // Anything level with or behind the eye cannot be over the reticle.
          if (forward > 1e-3) worstAngle = Math.min(worstAngle, Math.atan2(off, forward));
        }
      }
    }
    if (furthestVertex > MAX_VIEW_REACH) {
      failures.push(
        `The viewmodel reaches ${furthestVertex.toFixed(2)} m from the eye, past the ` +
          `${MAX_VIEW_REACH.toFixed(2)} m this file's header claims. That claim is the whole reason ` +
          `it can be drawn in the ordinary depth buffer instead of a second pass.`,
      );
    }
    if (worstAngle < RETICLE_CLEARANCE) {
      failures.push(
        `At rest the bat comes within ${(worstAngle * (180 / Math.PI)).toFixed(1)} degrees of the ` +
          `view axis; it must clear ${(RETICLE_CLEARANCE * (180 / Math.PI)).toFixed(1)}. It is ` +
          `sitting on the reticle.`,
      );
    }

    // --- The breath, and that it is *this file* applying the shared one.
    //
    // `verifyViewmodelIdle` (run at the top) says the function is sane;
    // `verifyFootyBall` says the football applies it. Neither says the bat does,
    // and the failure that leaves open is the one the shared module was written
    // for: a copy of the four lines left behind here, drifting from the ball's by
    // 0.03 Hz, which nothing catches and which reads as the two hands breathing in
    // and out of phase over half a minute.
    //
    // Measured as the offset from the rest key with everything else at zero:
    // standing still, no swing, no throw, and the yaw and pitch unchanged so the
    // sway stays exactly zero after its first seeded frame. Stepped at 50 ms and
    // sampled against the same clock the viewmodel accumulated.
    {
      const idleView = new BatViewmodel(assets);
      const want: IdleSway = { x: 0, y: 0 };
      let clock = 0;
      let worst = 0;
      for (let i = 0; i < 20; i++) {
        idleView.update(0.05, { phase: 'idle', phaseT: 0, speed: 0, yaw: 0, pitch: 0, hitstop: false });
        clock += 0.05;
        viewmodelIdle(clock, 0, want);
        worst = Math.max(
          worst,
          Math.abs(idleView.group.position.x - REST_KEY.at[0] - want.x),
          Math.abs(idleView.group.position.y - REST_KEY.at[1] - want.y),
        );
      }
      if (worst > 1e-9) {
        failures.push(
          `At rest the bat's idle offset differs from viewmodelIdle by ${(worst * 1000).toFixed(2)} mm. ` +
            `Both viewmodels have to apply the shared breath rather than a copy of it -- see ` +
            `player/viewmodel-idle.ts, which exists because the copies had already drifted.`,
        );
      }
    }

    // --- And the throw dip, which is the ranged weapon reaching into this one.
    //
    // Two claims, both silent. The dip must not push the bat past the budget the
    // header's whole single-pass argument rests on -- it moves the blade *down
    // and out*, which is toward the far corner of the frame and is exactly the
    // direction that could. And it has to be **zero at both ends of its window**,
    // or the bat jumps a hand's width on the frame a throw starts and again on
    // the frame it ends, which at 340 ms apart reads as two dropped frames
    // rather than as one bug.
    {
      let dipFurthest = 0;
      for (let i = 0; i <= 16; i++) {
        view.update(1 / 60, {
          phase: 'idle', phaseT: 0, speed: 0, yaw: 0, pitch: 0, hitstop: false,
          throwT: (i / 16) * THROW_DIP_SECONDS,
        });
        view.group.updateMatrixWorld(true);
        for (let v = 0; v < position.count; v++) {
          vertex.fromBufferAttribute(position, v).applyMatrix4(view.mesh.matrixWorld);
          dipFurthest = Math.max(dipFurthest, vertex.length());
        }
      }
      if (dipFurthest > MAX_VIEW_REACH) {
        failures.push(
          `Dipped for a throw the bat reaches ${dipFurthest.toFixed(2)} m from the eye, past the ` +
            `${MAX_VIEW_REACH.toFixed(2)} m budget. The dip has to stay inside the same claim the ` +
            `swing does.`,
        );
      }
      // The two ends of the window, against the same pose with no throw at all.
      //
      // Stepped with **dt = 0**, which makes the comparison exact rather than
      // approximate: `update` advances its own clock for the idle drift and the
      // stride, so two calls a frame apart differ by a tenth of a millimetre of
      // breathing even when the pose is identical. A zero step freezes both and
      // leaves only the thing being measured.
      const at = (throwT: number | undefined): [number, number, number] => {
        view.update(0, { phase: 'idle', phaseT: 0, speed: 0, yaw: 0, pitch: 0, hitstop: false, throwT });
        return [view.group.position.x, view.group.position.y, view.group.position.z];
      };
      const none = at(undefined);
      for (const [label, t] of [['start', 0], ['end', THROW_DIP_SECONDS]] as Array<[string, number]>) {
        const edge = at(t);
        const jump = Math.hypot(edge[0] - none[0], edge[1] - none[1], edge[2] - none[2]);
        if (jump > 1e-6) {
          failures.push(
            `The throw dip is ${(jump * 100).toFixed(1)} cm from rest at its ${label}. It has to be ` +
              `zero at both ends of its window or the bat jumps on the frame a throw begins.`,
          );
        }
      }
      // ...and it has to actually move, or the integration is a no-op nobody
      // would notice was missing.
      const middle = at(THROW_DIP_SECONDS / 2);
      if (Math.hypot(middle[0] - none[0], middle[1] - none[1], middle[2] - none[2]) < 0.05) {
        failures.push('The throw dip moves the bat less than 5 cm. It is not getting out of the way.');
      }
    }
  }

  prop.dispose();
  return failures;
}

/**
 * What the reach check is measured against.
 *
 * Stated here rather than imported from `game/combat.ts`, and that is deliberate
 * rather than lazy: importing `REACH` would make this check assert that a number
 * equals itself through two files. Written down separately, it is a second
 * opinion -- if somebody changes the hit test's reach without touching the bat,
 * the two disagree and this says so, which is the entire point of the check.
 */
const MEASURED_REACH_TARGET = 1.55;

/** The lowest point of the bat in world space, with the actor posed as it stands. */
function lowestBatVertex(
  actor: CharacterActor,
  prop: BatProp,
  position: { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number },
): number {
  actor.mesh.updateMatrixWorld(true);
  const v = new Vector3();
  let lowest = Infinity;
  for (let i = 0; i < position.count; i++) {
    v.set(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(prop.mesh.matrixWorld);
    lowest = Math.min(lowest, v.y);
  }
  return lowest;
}

const TOE_LOCAL = /*#__PURE__*/ new Vector3(0, TOE_Y, 0);
const toeWorld = /*#__PURE__*/ new Vector3();

/**
 * How far the toe is from the eye, in plan.
 *
 * The eye is the actor's own origin plus `EYE_HEIGHT` -- restated as a plan
 * distance because that is what `combat.hitTest` gates on, and the height falls
 * out of the comparison entirely.
 */
function toePlanReach(actor: CharacterActor, prop: BatProp): number {
  actor.mesh.updateMatrixWorld(true);
  toeWorld.copy(TOE_LOCAL).applyMatrix4(prop.mesh.matrixWorld);
  return Math.hypot(toeWorld.x - actor.mesh.position.x, toeWorld.z - actor.mesh.position.z);
}

function extents(position: {
  count: number;
  getX(i: number): number;
  getY(i: number): number;
  getZ(i: number): number;
}): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < position.count; i++) {
    const p: [number, number, number] = [position.getX(i), position.getY(i), position.getZ(i)];
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  }
  return { min, max };
}
