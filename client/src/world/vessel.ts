/**
 * The railway as a solid inserted into the ground, not as a hole cut out of it.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS FILE EXISTS FOR.
 *
 * `STATIONS.md` writes it out at length; the short version is that every rail
 * defect reported in the week before this file was written is one defect. The
 * world is built by **subtraction and patch**: `terrain.buildTerrainMesh` drops
 * the sub-quads the corridor crosses, and then `rail-geo.writeTrench`,
 * `writeVerge`, `writePlatforms`, `road-deck` and the stairs each try to put
 * something back, each governed by its own constant, each ignorant of the
 * others. A gap between any two of them is a hole the player falls through.
 *
 * Six reports, six patches, three rounds of sampling checks that passed. The
 * checks passed because a sampling check can only find the holes it happens to
 * land on, and there is no object anywhere in the build that owns the sentence
 * *"this is the boundary of the walkable world here"* -- so nothing can assert
 * that the boundary is closed.
 *
 * A **vessel** is that object. One closed 2-manifold surface bounding the
 * volume the railway occupies. Not "no holes we sampled": no holes, by
 * arithmetic over every edge in the mesh. See `checkManifold`, which is the
 * point of the whole file.
 *
 * ---------------------------------------------------------------------------
 * READ "SOLID" CAREFULLY: IT IS A BATHTUB, NOT A BLOCK.
 *
 * The intuition that sinks people here is that a closed solid must be a lump
 * you cannot get inside. It is not. A trench vessel is a **shell**: the player
 * walks on its inside -- the floor, the platform decks -- and on its outside --
 * the coping, the surrounding ground. What is true of it is only that the
 * bounding surface is closed and has no holes, so there is no path *through* it
 * and no back face anywhere to reach. The interior of the shell is solid
 * concrete and earth; the trough it forms is occupiable.
 *
 * In cross-section that shell is a `U`. Sweep a `U` along the track, cap the
 * two ends, and the result is topologically a sphere. Sweep a rectangle and you
 * have an embankment or a viaduct deck. Sweep an annulus -- a box with the
 * tunnel void punched through it -- and you have a bore, which is a torus. All
 * four are one code path in `buildVessel`, differing only in the profile handed
 * to it, and that is the design claim this file has to make good on: **four
 * dispositions, not four subsystems.**
 *
 *   - `trench`      floor, two battered walls, open to the sky, rim at ground
 *   - `embankment`  walkable top, batters down to the ground either side
 *   - `viaduct`     deck with parapets and a soffit underneath, on piers
 *   - `bore`        as trench but with a lid, so the profile has a hole in it
 *
 * ---------------------------------------------------------------------------
 * THE CRUX, WHICH IS WHERE THIS DESIGN LIVES OR DIES: THE SEAM RULE.
 *
 * **Every boundary has exactly one owner.**
 *
 * A vessel emits its **rim** as an explicit polygon -- an ordered ring of
 * vertices, in world coordinates, which are *the vessel's own mesh vertices,
 * named by index*. The terrain is then triangulated **to that ring**, using
 * those exact vertices. The terrain does not independently approximate the same
 * curve and meet the vessel at a tolerance; it consumes the ring the vessel
 * produced.
 *
 * That distinction is the entire redesign, restated at the vertex level. The
 * bug this file exists to kill is *two independent approximations of the same
 * curve, meeting at a tolerance* -- `CUT_HALF_WIDTH` 5.4 m against a platform
 * deck edge at 7.12 m, a carve rim sampled per 4 m sub-quad against a trench
 * wall sampled per 8 m rib. If anywhere in Phase 2 you find yourself writing an
 * epsilon to decide whether a terrain vertex and a vessel vertex are *the same
 * vertex*, the design has gone wrong and it is worth stopping to say so. There
 * is no epsilon in this file. `checkManifold` compares vertex positions for
 * **exact** bit equality, and identity is by index, never by distance.
 *
 * One consequence worth noticing, because it deletes a hack: `writeTrench` laps
 * its coping `TRENCH_COPING` (0.5 m) *outward* past the rim and onto ground the
 * carve left standing, purely so that a floating-point disagreement about where
 * the rim is shows half a metre of stone instead of a hairline of void. A
 * vessel needs no lap. Its coping runs **inward** from the rim, because the rim
 * is not an estimate of a boundary -- it is the boundary, and the terrain has
 * the same vertices.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS APPROACH AND NOT THE THREE CONVENTIONAL ONES.
 *
 *  - **Mesh CSG / boolean subtraction.** Manifold in principle; robust boolean
 *    on large meshes is a numerical minefield we would own forever. Avoided
 *    entirely, because we never boolean -- we **partition**. Terrain owns
 *    outside the footprint, the vessel owns inside it, and they share one ring.
 *  - **Voxels or an SDF with marching cubes.** Manifold by construction and
 *    good at arbitrary topology. Rejected for crispness and cost: platform
 *    copings, deck soffits and parapets go blobby, and at 60 km the memory is
 *    not free.
 *  - **Hand-authored prefabs.** Watertight by authorship, infeasible at 267
 *    stations, and it cannot be geometrically true to real Sydney, which is the
 *    point of the project.
 *
 * The known failure mode of the chosen approach is **sweep self-intersection**
 * on tight curves: offset a profile 9 m from a centreline whose radius of
 * curvature is 6 m and the inner wall turns itself inside out. That is detected
 * here and reported (`FOLD` in `VesselBuild.faults`), never silently emitted.
 * The mitigations are structural: vessels stay per-segment with explicit joins,
 * and junction footprints are unioned rather than two sweeps overlapped.
 *
 * ---------------------------------------------------------------------------
 * **This file imports nothing.** Not three.js, not `rail-cut.ts`, not the bake.
 * On `rail-cut.ts`' own terms: `server/integration-check.ts` builds vessels out
 * of the real bake in a process with no renderer and no DOM, and a `Vector3`
 * reaching in here would make that impossible. Everything it needs about the
 * corridor arrives as plain numbers in a `SpinePoint`, and everything it hands
 * back is a `Float64Array`. `Float64` and not `Float32` deliberately: the
 * vertices of the ring are shared with the terrain by *exact* value, and
 * rounding them to single precision in one consumer and not the other would
 * reintroduce the tolerance this design exists to delete.
 */

// --- The flag ---------------------------------------------------------------------

/**
 * Whether anything in the build may *use* a vessel. Default off, and Phase 1
 * ships with nothing reading it.
 *
 * `RailCut`, `PlatformField`, `RoadDeck`, `writeTrench` and `writeVerge` are
 * unchanged and stay in charge of the world. This phase proves the primitive
 * and the invariant; conversion is Phase 2. The flag exists now rather than
 * later so that the conversion is a change of one constant plus the call sites,
 * and so that the thing being switched on has a name before there is anything
 * to switch.
 *
 * Read through the function rather than the constant so a console can flip it
 * at runtime without a rebuild, exactly as `?vessels=1` will once Phase 2 has
 * something to draw.
 */
export const VESSELS_DEFAULT_ON = false;

let vesselsOn = VESSELS_DEFAULT_ON;

/** Is the vessel path live? Phase 1: never, unless a console says otherwise. */
export function vesselsEnabled(): boolean {
  return vesselsOn;
}

/** Turn the vessel path on or off. For a console and for Phase 2's flag wiring. */
export function setVesselsEnabled(on: boolean): void {
  vesselsOn = on;
}

// --- The cross-section ------------------------------------------------------------

/** Which of the four a vessel is. Not a subsystem: a choice of profile. */
export type Disposition = 'trench' | 'embankment' | 'viaduct' | 'bore';

/**
 * One closed loop of a cross-section, as interleaved `o, y` pairs: metres
 * **across** the run from the centreline, and metres **up** in world Y.
 *
 * Counter-clockwise in the `(o, y)` plane for the outer loop, and counter-
 * clockwise as well for a hole -- the winding reversal a hole needs is applied
 * by `buildVessel` from the loop's *role*, not from its stored order, because a
 * loop whose meaning depends on which way somebody happened to write it down is
 * the bug `writeTrench`'s `face` helper spends a paragraph on.
 */
export type Loop = Float64Array;

/**
 * A cross-section at one point along the run.
 *
 * ---------------------------------------------------------------------------
 * **THE TRANSITION RIB, WHICH IS PHASE 3'S ENABLING CHANGE.**
 *
 * Phase 1 required every rib of one vessel to carry the same loops with the same
 * point counts, because the sweep pairs them index to index, and recorded the
 * limitation as the thing Phase 3 would have to lift:
 *
 * > A profile cannot change topology mid-sweep. Collapsing profile points
 * > produces two vertices at one position, which the weld check correctly calls
 * > a seam. Phase 3 needs a *transition rib* -- a stitch between two different
 * > polygons at one station, in the same mesh so they share vertices by index.
 *
 * It is lifted. Two consecutive ribs may now carry **different numbers of points
 * in their outer loop**, and the strip between them is a **zip** rather than a
 * quad run: the two polygons' arcs are merged on their own normalised profile
 * arc length, anchored at the seam points so the rim stays a single polyline
 * through the change. It is one mesh -- the two polygons share the anchor
 * vertices *by index* -- so there is no weld and nothing for `checkManifold` to
 * find. See `buildVessel`.
 *
 * What has **not** been lifted, because nothing in this phase needs it and
 * pretending otherwise would be worse than saying so: the number of *loops*
 * cannot change. A trench becoming a bore is a disk becoming an annulus, and a
 * zip between two closed polylines cannot do that; nor can it split one polygon
 * into two, which is what a formation dividing at a junction is. Both are named
 * in `STATIONS.md` with what they would cost.
 */
export interface Rib {
  /** The centreline point, in world metres. */
  cx: number;
  cz: number;
  /**
   * The unit plan direction **along** the run at this rib.
   *
   * The cross direction is `(px, pz) = (-uz, ux)`, which is the frame every
   * writer in `rail-geo.ts` uses, so a vessel and a `writeTrench` wall built
   * from the same segment put their offsets in the same place. See
   * `buildVessel` for the one thing that frame costs: it is **left-handed**.
   */
  ux: number;
  uz: number;
  /** `[outer, ...holes]`. A hole is a void carried through the vessel: a bore. */
  loops: Loop[];
  /**
   * Outer-loop indices of the terrain seam at **this** rib, `[left, right]`, or
   * null for a disposition with no surface expression.
   *
   * Per rib rather than per vessel, and that is not bureaucracy: with the
   * profile free to change point count along the run, "which point is the left
   * rim" is a different integer before and after a transition. It is also the
   * pair the transition zip anchors on, which is what keeps the rim one
   * continuous polyline across the change instead of two that meet somewhere.
   */
  seam: readonly [number, number] | null;
}

/**
 * A point inserted into one edge of the rim, so the terrain can meet it there.
 *
 * ---------------------------------------------------------------------------
 * **Phase 2a, and the thing that keeps the seam rule true at the second seam.**
 *
 * The terrain is a lattice. A rim edge 8 m long crosses that lattice two or
 * three times, and the terrain has to put a vertex at each crossing or it cannot
 * be a lattice any more. A vertex the terrain owns sitting on the *interior* of
 * an edge the vessel owns is a **T-junction**: not a hole, but two descriptions
 * of one edge again, which is the failure this file exists to end, half a level
 * further down than the last time it was found.
 *
 * So the crossing is not the terrain's to invent. It is computed once, by
 * `world/seam.ts`, and handed **to the vessel**, which splits its own edge
 * there. The terrain then names that vertex the way it names every other rim
 * vertex: by index into `Vessel.position`. There is one point, one owner and no
 * comparison of two numbers anywhere.
 *
 * Splitting is cheap and structural rather than a repair: the quad either side
 * of a rim edge becomes a pentagon, fanned from its own first corner, which is
 * the same fan the quad already was. `checkManifold` re-proves closure
 * afterwards, so the split is not trusted either.
 */
export interface RimCut {
  /** The rib the edge starts at: the edge runs from rib `rib` to rib `rib + 1`. */
  rib: number;
  /**
   * Which of the two seams, `0` left and `1` right.
   *
   * A side and not a loop-point index, since Phase 3: the loop point the left
   * rim sits at is a property of one rib's profile and a transition changes it,
   * where "the left rim" is the same edge of the same walkable world all the way
   * along. Naming the side also deletes the check that the point named really
   * was a seam, because there is nothing else it can be.
   */
  side: 0 | 1;
  /** Where along that edge, strictly between 0 and 1. Orders the cuts; nothing else. */
  t: number;
  /** The point itself, in world metres. **Not** recomputed here: this is the value. */
  x: number;
  y: number;
  z: number;
}

/**
 * The finished thing: a closed surface, and the ring the terrain must consume.
 *
 * `position` is world metres, three per vertex; `index` is triangles wound
 * counter-clockwise seen from **outside** the solid. `rim` names vertices of
 * this same `position` array by index -- it is not a copy of their coordinates,
 * and that is the seam rule made concrete. A terrain triangulator handed a
 * `Vessel` cannot accidentally re-approximate the boundary, because there are
 * no boundary coordinates to re-approximate: there are vertex indices.
 */
export interface Vessel {
  disposition: Disposition;
  /** World metres, `x, y, z` per vertex. */
  position: Float64Array;
  /** Triangles, counter-clockwise from outside. */
  index: Uint32Array;
  /**
   * The terrain seam, as an ordered closed ring of indices into `position`.
   *
   * Counter-clockwise in the `(x, z)` plane by the ordinary shoelace
   * convention, so the terrain always knows which side of the ring it owns:
   * outside. Empty for a disposition with no surface expression -- a `viaduct`
   * meets the ground only at its piers and a `bore` only at its portals, and a
   * ring emitted for either would be a claim on ground the vessel does not
   * touch.
   */
  rim: Uint32Array;
  /**
   * The two seam vertices at each rib, `[left, right]` per rib, as indices into
   * `position`. Null for a disposition with no surface expression.
   *
   * Carried on the finished thing rather than left with the caller because
   * `world/seam.ts` has to walk the two seam polylines to find where they cross
   * the terrain lattice, and a module that had to be *told* which vertices those
   * were would be a module that could be told wrong.
   *
   * **Vertex indices and not loop-point indices, since Phase 3.** With the
   * profile free to change point count at a transition rib there is no single
   * loop index that names the left rim over a whole run, and a consumer that
   * multiplied a rib number by a constant stride would be reading the wall.
   */
  ribSeam: Int32Array | null;
  /**
   * How many ribs the sweep had, and where each one's vertices begin.
   *
   * These two are the vertex layout, stated: rib `i`'s loop-0 point `j` is
   * vertex `ribOffset[i] + j`, rib `i` ends at `ribOffset[i + 1]`, and
   * everything from `ribOffset[ribCount]` on is a rim cut. It is published for
   * the same reason `rim` is: a consumer that wants a particular vertex of this
   * surface should be able to *name* it, not go looking for the nearest one.
   *
   * A prefix sum rather than a stride because a transition rib makes the stride
   * a lie. See `Rib`.
   */
  ribCount: number;
  ribOffset: Uint32Array;
  /**
   * Where each rib segment's side faces are in `index`, in triangles.
   *
   * `[sideFace[i], sideFace[i + 1])` are the faces swept between rib `i` and rib
   * `i + 1`, and `sideFace[ribCount - 1]` is where the side ends and the two end
   * caps begin. The caps are excluded from it deliberately: a cap lies in the
   * rib's own cross-plane, which contains the Y axis, so its normal has **zero**
   * Y exactly and it can never be a surface anything stands on.
   *
   * This exists so `world/vessel-field.ts` can index the sweep's own faces off
   * the centreline. It is the ranges, not a copy of the faces -- there is one
   * array of triangles in this design and the field points into it. See that
   * file for why an analytic profile evaluation is *not* the same answer.
   */
  sideFace: Uint32Array;
  /** Triangle count, for the budget line. `index.length / 3`. */
  triangles: number;
}

/** A vessel that was built, or the reasons it was not. */
export interface VesselBuild {
  /** Null if any fault is fatal. A vessel is never emitted unchecked. */
  vessel: Vessel | null;
  /**
   * Everything wrong with the input, in the order found.
   *
   * Prefixed by kind so a caller can filter: `FOLD` is a sweep that turned
   * itself inside out, `PROFILE` a cross-section that self-intersects, `SHAPE`
   * a rib that disagrees with its neighbours about how many points it has.
   * Every one of them is fatal -- there is no such thing as a nearly closed
   * surface -- and the list is returned rather than thrown so that a chunk
   * build can report all of a corridor's faults in one pass instead of the
   * first.
   */
  faults: string[];
  /**
   * The ribs the sweep was built from, when it was built from ribs.
   *
   * **The authority, handed back.** `STATIONS.md`'s resolution of the collision
   * question is that the sweep is the definition and the mesh is one rendering
   * of it, so the thing that answers a point query has to be given the sweep and
   * not the mesh. See `world/vessel-field.ts`, which takes exactly this.
   */
  ribs?: readonly Rib[];
}

// --- What a corridor looks like, in the only terms this file accepts -------------

/**
 * One measured point along a rail corridor: everything a rib needs, and nothing
 * about how it was measured.
 *
 * The deliberate poverty of this type is the interface boundary. `rail-cut.ts`,
 * the DEM, `RoadDeck` and the bake are all upstream of it; this file cannot
 * import any of them and does not want to. What arrives is: where the track is,
 * how high the rail head is, how high the ground is at the rim, and how wide
 * the corridor is here.
 *
 * `span` comes from `RailCut.halfWidthAt` at the **centreline** point of every
 * track the formation carries, which is what makes it well defined -- see that
 * function -- and it is the pair that becomes the rim, which is what the terrain
 * will be triangulated to. One measurement, one owner, three consumers.
 */
export interface SpinePoint {
  x: number;
  z: number;
  /** Rail head height in world Y, as the bake interpolates it. */
  railY: number;
  /**
   * Terrain height at the **rim**, per side: `[left, right]` in the
   * `(px, pz) = (-uz, ux)` frame, where left is the `-1` side.
   *
   * Two numbers and not one, because a cutting in a side slope has a rim two
   * metres higher on the uphill side and a vessel built to a single ground
   * height would bury one rim and leave the other standing in the air. That is
   * the `writeTrench` behaviour already -- it samples the ground at
   * `rim * side` -- and it is preserved here rather than simplified away.
   */
  groundY: readonly [number, number];
  /**
   * How far the corridor reaches across, `[left, right]` metres from the
   * centreline in the `(px, pz) = (-uz, ux)` frame. `left` is negative.
   *
   * ---------------------------------------------------------------------------
   * **A pair and not a half-width, and that is Phase 3's whole change.**
   *
   * Phase 2a swept one vessel per *track*, so the corridor was symmetric about
   * the thing that defined it and one number said everything. A formation is one
   * cutting carrying four tracks; its centreline is one of them, chosen because
   * it is the longest; and the ground it takes runs 5.4 m out on that side and
   * twenty-five metres out on the other. There is no half-width that says that,
   * and the attempt to make one say it is what drew a coping across an open
   * trench.
   */
  span: readonly [number, number];
}

// --- Constants of the trench cross-section ----------------------------------------
//
// These are the vessel's own and are deliberately *not* imported from
// `rail-geo.ts`, which is a renderer module the server cannot load. Where a
// number has a counterpart there it is named in the comment, and Phase 2 is
// where the two are reconciled -- by `rail-geo` reading these, not the reverse,
// because the vessel is the thing that will own the boundary.

/**
 * How far under the rail head the trench floor sits, metres.
 *
 * `rail-geo.BALLAST_TOP_DROP` (0.2) plus `BALLAST_DEPTH` (0.55): the cess, which
 * is the strip a track worker walks along and the surface a cutting is
 * recognised by from a train. The vessel floor is the cess continued right
 * across under the ballast, because a floor with the ballast's own footprint
 * cut out of it would be exactly the kind of second boundary this file exists
 * to abolish. The ballast is then drawn *on* the floor by whoever draws ballast.
 */
export const VESSEL_FLOOR_DROP = 0.75;

/**
 * How thick the floor slab is, metres.
 *
 * Structural rather than visible: nobody ever sees the underside of a trench
 * floor. It exists because a surface with no thickness is not a solid, and a
 * shell whose floor is a single sheet would have the player standing on a face
 * whose back is the outside world. Half a metre is a real invert slab and costs
 * two triangles per rib pair.
 */
export const VESSEL_FLOOR_THICKNESS = 0.5;

/**
 * The batter of the retaining wall: metres out per metre up.
 *
 * `rail-geo.TRENCH_BATTER`, 1/6, which is what the retaining walls on the
 * Illawarra cuttings measure. The wall foot is therefore
 * `rim - VESSEL_COPING_W - batter * height`, floored by `VESSEL_FOOT_MIN` so a
 * deep cutting does not batter its own walls into the ballast.
 */
export const VESSEL_BATTER = 1 / 6;

/**
 * How close to the centreline the inner foot of a wall may come, metres.
 *
 * `rail-geo.TRENCH_FOOT_MIN`, which is `BALLAST_BASE_HALF + 0.3` = 3.6: the
 * ballast's own base half-width plus the width of a boot. A wall foot inside
 * this is a wall standing in the ballast.
 */
export const VESSEL_FOOT_MIN = 3.6;

/**
 * The width of the coping strip on top of each wall, metres, measured
 * **inward** from the rim.
 *
 * Inward, and the direction is the seam rule's most visible consequence.
 * `rail-geo.TRENCH_COPING` is the same 0.5 m laid *outward*, over ground the
 * carve left standing, to hide the disagreement between two modules about where
 * the rim is. There is no disagreement to hide here: the terrain will be
 * triangulated to this vessel's own rim vertices, so the coping can sit where a
 * coping actually sits, and the ground meets its outer edge flush.
 */
export const VESSEL_COPING_W = 0.5;

/**
 * How far below the rim the vessel's outer skin runs before it turns under,
 * metres.
 *
 * The outer faces and the underside are the buried half of the shell: nobody
 * sees them, and they exist only so the surface closes. The depth is taken from
 * the floor rather than fixed, so this constant is only the *minimum* -- what it
 * guards is the degenerate case of a cutting so shallow that the rim and the
 * floor coincide, where the outer face would collapse to nothing and the sweep
 * would emit zero-area quads. `checkManifold` would catch those; better not to
 * make them.
 */
export const VESSEL_MIN_SKIN = 0.05;

// --- The four profiles -------------------------------------------------------------

/**
 * Where in the outer loop the two terrain seam vertices are, per disposition.
 *
 * A pair `[left, right]` of indices into the outer loop, or null for a
 * disposition whose surface has no expression on the ground. Kept beside the
 * profile builders rather than derived, because "which vertex is the boundary
 * of the walkable world" is a statement about meaning and not about geometry,
 * and it is the single most load-bearing statement in the file.
 */
export interface Profile {
  /** The loops, `[outer, ...holes]`, as interleaved `o, y`. */
  loops: Loop[];
  /** Outer-loop indices of the terrain seam, `[left, right]`, or null. */
  seam: readonly [number, number] | null;
}

/**
 * A cutting, in cross-section: the `U`.
 *
 * Eight points, counter-clockwise in `(o, y)`, starting at the buried
 * bottom-left corner and running:
 *
 *     0  (left,        base)      bottom outer left
 *     1  (right,       base)      ... along the underside
 *     2  (right,       rimR)      up the right outer face      <- SEAM, right
 *     3  (right - cop, rimR)      inward across the coping
 *     4  (footR,       floor)     down the battered inner face
 *     5  (footL,       floor)     across the floor
 *     6  (left + cop,  rimL)      up the left inner face
 *     7  (left,        rimL)      outward across the coping    <- SEAM, left
 *
 * and closing down the left outer face to 0. Indices 2 and 7 are the rim: the
 * outer top corners, where the ground begins and the vessel ends.
 *
 * ---------------------------------------------------------------------------
 * **`left` and `right` are independent, and that is what makes a formation
 * possible.** Phase 2a took one `half` and put the rim symmetrically about the
 * centreline, because a vessel was one *track*. A formation is one **cutting**
 * carrying several tracks, and its centreline is one of them -- so the rim is
 * 5.4 m out on one side and thirty metres out on the other, and there is no
 * half-width that describes it. `left` is negative, `right` positive, both in
 * the `(px, pz) = (-uz, ux)` frame `Rib` documents.
 *
 * The two rim heights are independent for the same kind of reason -- see
 * `SpinePoint.groundY` -- so nothing about this profile can be built by
 * mirroring one side.
 */
export function trenchProfile(
  left: number,
  right: number,
  railY: number,
  groundLeft: number,
  groundRight: number,
): Profile {
  const floor = railY - VESSEL_FLOOR_DROP;
  const base = floor - VESSEL_FLOOR_THICKNESS;
  // Never below the floor: where a cutting runs out to grade the wall goes to
  // nothing rather than turning inside out. `writeTrench` clamps the same way
  // and for the same reason, and the clamp is what keeps a taper from emitting
  // an inverted quad the manifold check would then have to reject.
  const rimL = Math.max(groundLeft, floor + VESSEL_MIN_SKIN);
  const rimR = Math.max(groundRight, floor + VESSEL_MIN_SKIN);
  // The coping cannot be wider than the corridor: at a hypothetical 0.6 m
  // half-width the inner and outer top corners would cross and the profile
  // would self-intersect. Clamped rather than reported, because the caller has
  // no better answer and `checkProfile` would only tell it the same thing.
  // Per side, because the two sides are no longer the same number.
  const copR = Math.min(VESSEL_COPING_W, right * 0.5);
  const copL = Math.min(VESSEL_COPING_W, -left * 0.5);
  /**
   * The inner foot of one wall, as a distance from the centreline on its own
   * side. The batter is a property of the wall's height, not of the corridor's
   * width, so a thirty-metre formation gets the same half-metre of batter a
   * five-metre cutting does -- which is what a retaining wall actually is.
   */
  const footOf = (reach: number, cop: number, rim: number): number =>
    Math.min(
      Math.max(VESSEL_FOOT_MIN, reach - cop - VESSEL_BATTER * (rim - floor)),
      reach - cop,
    );
  const footR = footOf(right, copR, rimR);
  const footL = footOf(-left, copL, rimL);
  return {
    loops: [
      new Float64Array([
        left, base,
        right, base,
        right, rimR,
        right - copR, rimR,
        footR, floor,
        -footL, floor,
        left + copL, rimL,
        left, rimL,
      ]),
    ],
    seam: [7, 2],
  };
}

/**
 * A bank, in cross-section: a trapezoid standing on the ground.
 *
 *     0  (-toe,   base)     the left toe, on the ground        <- SEAM, left
 *     1  (+toe,   base)     the right toe                      <- SEAM, right
 *     2  (+crest, top)      up the right batter
 *     3  (-crest, top)      across the walkable top
 *
 * The seam is at the **toe**, not at the crest, which is the whole difference
 * between an embankment and a cutting as far as the terrain is concerned: the
 * ground stops where the bank starts rising, and everything above that is the
 * vessel's. The base edge `0 -> 1` is the buried underside, and it exists for
 * the same reason the trench's does -- a surface with no thickness is not a
 * solid.
 */
export function embankmentProfile(
  crestLeft: number,
  crestRight: number,
  crestY: number,
  groundLeft: number,
  groundRight: number,
  batter = 2,
): Profile {
  const base = Math.min(groundLeft, groundRight);
  const height = Math.max(VESSEL_MIN_SKIN, crestY - base);
  const toeR = crestRight + batter * height;
  const toeL = crestLeft - batter * height;
  return {
    loops: [
      new Float64Array([
        toeL, base - VESSEL_FLOOR_THICKNESS,
        toeR, base - VESSEL_FLOOR_THICKNESS,
        crestRight, crestY,
        crestLeft, crestY,
      ]),
    ],
    // The toe corners are at `base - VESSEL_FLOOR_THICKNESS`, below the ground,
    // so the ring the terrain consumes is the pair at index 0 and 1 -- which is
    // the bank's plan outline at its own buried lip. Phase 2 will want that lip
    // raised to exactly the DEM value at the toe; it is left here because a
    // Phase 1 embankment has nothing consuming its ring.
    seam: [0, 1],
  };
}

/**
 * A deck on piers, in cross-section: the trench, lifted into the air.
 *
 * Literally the same eight-point `U`, which is the clearest evidence available
 * that these are dispositions of one object rather than four subsystems -- a
 * viaduct is a cutting whose rim happens to be six metres above the ground, and
 * the only thing that changes is that the seam is null, because the ground is
 * not there to meet it. The piers are separate vessels and Phase 2's problem.
 */
export function viaductProfile(
  left: number,
  right: number,
  railY: number,
  deckDepth = 1.15,
  parapet = 1.1,
): Profile {
  const deck = railY - VESSEL_FLOOR_DROP;
  const soffit = deck - deckDepth;
  const top = deck + parapet;
  const pw = 0.35;
  return {
    loops: [
      new Float64Array([
        left, soffit,
        right, soffit,
        right, top,
        right - pw, top,
        right - pw, deck,
        left + pw, deck,
        left + pw, top,
        left, top,
      ]),
    ],
    // No surface expression. A viaduct that emitted a rim ring would be
    // claiming the ground under it, and the ground under a viaduct is ordinary
    // terrain that must keep running.
    seam: null,
  };
}

/**
 * A bore, in cross-section: a box of ground with the tunnel void through it.
 *
 * **The one profile with two loops**, and the reason the sweep is written to
 * take a list. The outer loop is the rock the bore is driven through -- a
 * rectangle, sampled at the same angles the void is, so the two loops pair
 * index to index and the end cap can be a strip between them rather than a
 * triangulation with a hole in it. The inner loop is the void.
 *
 * Swept and capped, that is a **torus**: Euler characteristic 0, genus 1.
 * `checkManifold` reports it as such and does not complain, which is the point
 * of computing the characteristic rather than asserting it equals 2 -- a check
 * that only knew about spheres would reject every tunnel in the city.
 */
export function boreProfile(
  radius: number,
  railY: number,
  rise = 1.9,
  sides = 10,
  cover = 2.0,
  /** Where the axis sits across the run, for a bore whose centreline is a member. */
  centre = 0,
): Profile {
  const axis = railY - VESSEL_FLOOR_DROP + rise;
  const outerHalf = radius + cover;
  const outerTop = axis + radius + cover;
  const outerBottom = axis - radius - cover;
  const inner = new Float64Array(sides * 2);
  const outer = new Float64Array(sides * 2);
  for (let i = 0; i < sides; i++) {
    // Counter-clockwise in `(o, y)` for both, which the winding rule then
    // reverses for the hole. Starting at +o so the two loops' index 0 is on the
    // same ray from the axis, which is what the cap strip pairs on.
    const a = (i / sides) * Math.PI * 2;
    const co = Math.cos(a);
    const si = Math.sin(a);
    inner[i * 2] = centre + co * radius;
    inner[i * 2 + 1] = axis + si * radius;
    // The same ray, intersected with the outer rectangle: a box sampled at the
    // void's own angles. Collinear neighbours on a flat side are harmless --
    // they are distinct points and the strip triangles between the loops have
    // area because the loops are `cover` apart.
    const halfY = (outerTop - outerBottom) / 2;
    const midY = (outerTop + outerBottom) / 2;
    const tx = Math.abs(co) < 1e-12 ? Infinity : outerHalf / Math.abs(co);
    const ty = Math.abs(si) < 1e-12 ? Infinity : halfY / Math.abs(si);
    const t = Math.min(tx, ty);
    outer[i * 2] = centre + co * t;
    outer[i * 2 + 1] = midY + si * t;
  }
  return { loops: [outer, inner], seam: null };
}

// --- The sweep ----------------------------------------------------------------------

/**
 * A closed surface from a run of ribs. **The one code path.**
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS CLOSED, WHICH IS THE ONLY INTERESTING THING ABOUT IT.
 *
 * Take one loop of `m` points swept over `n` ribs. The sides are a quad strip:
 * quad `(i, j)` joins rib `i` to rib `i+1` across profile edge `j -> j+1`. Every
 * edge in the finished surface is then one of three kinds, and each is shared by
 * exactly two faces for a structural reason rather than by luck:
 *
 *   - an **along** edge, `(i,j) -> (i+1,j)`, is shared by quads `j-1` and `j`,
 *     which are neighbours around the loop. The loop is closed, so `j = 0` has
 *     `j = m-1` on its other side and there is no first or last;
 *   - an **around** edge, `(i,j) -> (i,j+1)`, is shared by strips `i-1` and `i`
 *     for an interior rib, and by the strip and the **end cap** at `i = 0` and
 *     `i = n-1`. That is what the caps are for and it is the only thing they are
 *     for;
 *   - a **diagonal**, interior to a quad or to a cap triangulation, is shared by
 *     the two triangles either side of it by construction.
 *
 * No case is left over, so there is no boundary edge, so the surface is closed.
 * `checkManifold` then proves that rather than trusting it, because a proof by
 * paragraph is what the last three rounds shipped.
 *
 * ---------------------------------------------------------------------------
 * THE HANDEDNESS TRAP, WHICH THIS PROJECT HAS ALREADY SHIPPED ONCE AS A BUG.
 *
 * The frame is `(o, y, t) -> (px, Y, u)` with `(px, pz) = (-uz, ux)`, which is
 * `rail-geo`'s frame and therefore the one to keep. Work out `px x Y`:
 *
 *     px x Y  =  (-uz, 0, ux) x (0, 1, 0)  =  (-ux, 0, -uz)  =  -u
 *
 * so the frame is **left-handed**: it is the mirror of the right-handed one, and
 * a mirror reverses orientation. Every winding derived in a right-handed frame
 * comes out inside-out here, which on a `FrontSide` material means the whole
 * vessel is culled and the player sees through it -- exactly the failure
 * `writeTrench`'s `face` helper exists to prevent, one level down.
 *
 * So the windings below are the right-handed ones **reversed**, once, here, and
 * `checkManifold` asserts the consequence rather than the cause: the signed
 * volume of the closed surface must come out **positive**, which it does only if
 * every face points out. A vessel with the winding backwards fails to build.
 */
export function buildVessel(
  disposition: Disposition,
  ribs: readonly Rib[],
  cuts: readonly RimCut[] = [],
): VesselBuild {
  const faults: string[] = [];
  if (ribs.length < 2) {
    return { vessel: null, faults: [`SHAPE: a sweep needs at least two ribs, got ${ribs.length}`], ribs };
  }

  // --- The shape contract, which is now per rib rather than against rib 0.
  //
  // What every rib must still agree about: how many **loops** it has, and
  // whether it has a seam. What it may now differ about is how many points are
  // in its outer loop -- see `Rib`, and `transitionAt` below for what the sweep
  // does about it.
  const loopCount = ribs[0].loops.length;
  const counts: number[][] = [];
  for (let i = 0; i < ribs.length; i++) {
    const r = ribs[i];
    if (r.loops.length !== loopCount) {
      faults.push(`SHAPE: rib ${i} has ${r.loops.length} loops, rib 0 has ${loopCount}`);
      counts.push([]);
      continue;
    }
    const c: number[] = [];
    for (let k = 0; k < loopCount; k++) {
      if (r.loops[k].length % 2 !== 0) {
        faults.push(`SHAPE: rib ${i} loop ${k} has an odd number of coordinates`);
      }
      c.push(r.loops[k].length >> 1);
    }
    if (c.some((n) => n < 3)) faults.push(`SHAPE: rib ${i} has a loop of fewer than three points (${c.join(', ')})`);
    counts.push(c);
  }
  if (loopCount > 2) faults.push(`SHAPE: at most one hole is supported, got ${loopCount - 1}`);
  if (loopCount === 2) {
    // See `boreProfile`: the annular cap is a strip that pairs the two loops
    // index to index, which is what keeps it free of ear clipping and free of
    // the bridge vertices that would duplicate positions. The price is this
    // constraint, and it is cheap to satisfy because both loops are generated.
    for (let i = 0; i < ribs.length && counts[i].length === 2; i++) {
      if (counts[i][0] !== counts[i][1]) {
        faults.push(`SHAPE: rib ${i}'s holed profile has ${counts[i][0]} and ${counts[i][1]} points`);
      }
      // And a **holed** profile may not transition. A zip between two closed
      // polylines turns one polygon into another polygon; it cannot turn a disk
      // into an annulus, and it cannot pair a hole that has to be paired with
      // the cap as well. Refused by name rather than half-supported.
      if (counts[i][0] !== counts[0][0]) {
        faults.push(
          `SHAPE: rib ${i} changes a holed profile from ${counts[0][0]} to ${counts[i][0]} points. ` +
            `A transition rib is only defined on a single loop`,
        );
      }
    }
  }
  const hasSeam = ribs[0].seam != null;
  for (let i = 0; i < ribs.length; i++) {
    const s = ribs[i].seam;
    if ((s != null) !== hasSeam) {
      faults.push(`SHAPE: rib ${i} ${s == null ? 'has no seam' : 'has a seam'} and rib 0 does not agree`);
      continue;
    }
    if (s != null && counts[i].length > 0) {
      if (s[0] < 0 || s[1] < 0 || s[0] >= counts[i][0] || s[1] >= counts[i][0] || s[0] === s[1]) {
        faults.push(`SHAPE: rib ${i} names seam points ${s[0]}, ${s[1]} of an outer loop of ${counts[i][0]}`);
      }
    }
  }
  if (faults.length) return { vessel: null, faults, ribs };

  // --- The profile must be a simple polygon, at every rib.
  for (let i = 0; i < ribs.length; i++) {
    for (let k = 0; k < loopCount; k++) {
      const why = loopFault(ribs[i].loops[k]);
      if (why) faults.push(`PROFILE: rib ${i} loop ${k}: ${why}`);
    }
  }

  // --- The vertex layout. Rib-major, loop-major within a rib, then the cuts.
  //
  // A prefix sum and not a stride: with a transition rib the ribs are different
  // sizes, and a consumer multiplying by a constant would be reading the wall.
  const ribOffset = new Uint32Array(ribs.length + 1);
  {
    let at = 0;
    for (let i = 0; i < ribs.length; i++) {
      ribOffset[i] = at;
      for (let k = 0; k < loopCount; k++) at += counts[i][k];
    }
    ribOffset[ribs.length] = at;
  }
  const base = ribOffset[ribs.length];
  const vertexOf = (i: number, k: number, j: number): number => {
    let at = ribOffset[i];
    for (let q = 0; q < k; q++) at += counts[i][q];
    return at + j;
  };

  // --- The rim cuts, accepted or refused before a single vertex is allocated.
  //
  // A cut is a point somebody else computed on a seam edge of *this* sweep, and
  // the only thing done to it here is filing: its coordinates are stored
  // verbatim, because the whole value of the arrangement is that one number
  // exists rather than two that have to be compared. See `RimCut`.
  //
  // Three refusals, and each is an exact test rather than a tolerance:
  //
  //   - a cut on a segment this vessel does not have, or on a vessel with no
  //     seam at all -- a caller confusion, and emitting it would put a vertex in
  //     the middle of a wall;
  //   - `t` outside the open interval, which would land the point on an existing
  //     rib vertex and duplicate it;
  //   - a position bit-identical to either endpoint or to another cut on the
  //     same edge, which is the same duplication arriving by a different route.
  //     `checkManifold` would find it, and the message would be about a weld
  //     rather than about the caller who asked for it twice.
  /** Accepted cuts, keyed `rib * 2 + side`, each sorted by `t`. */
  const cutsOn = new Map<number, RimCut[]>();
  let cutCount = 0;
  if (cuts.length) {
    /** Where rib `i`'s outer-loop point `j` is, without needing `position` yet. */
    const ribPoint = (i: number, j: number): [number, number, number] => {
      const r = ribs[i];
      const o = r.loops[0][j * 2];
      return [r.cx + -r.uz * o, r.loops[0][j * 2 + 1], r.cz + r.ux * o];
    };
    for (const c of cuts) {
      if (!hasSeam) {
        faults.push('SHAPE: a rim cut was given to a vessel with no surface expression');
        continue;
      }
      if (!Number.isInteger(c.rib) || c.rib < 0 || c.rib >= ribs.length - 1) {
        faults.push(`SHAPE: a rim cut names rib ${c.rib} of ${ribs.length}`);
        continue;
      }
      if (c.side !== 0 && c.side !== 1) {
        faults.push(`SHAPE: a rim cut names side ${c.side}, which is neither 0 nor 1`);
        continue;
      }
      if (!(c.t > 0 && c.t < 1) || !Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.z)) {
        faults.push(`SHAPE: a rim cut at rib ${c.rib} has t ${c.t} at ${c.x}, ${c.y}, ${c.z}`);
        continue;
      }
      const a = ribPoint(c.rib, ribs[c.rib].seam![c.side]);
      const b = ribPoint(c.rib + 1, ribs[c.rib + 1].seam![c.side]);
      const same = (p: readonly number[]): boolean => p[0] === c.x && p[1] === c.y && p[2] === c.z;
      if (same(a) || same(b)) continue;
      const key = c.rib * 2 + c.side;
      const list = cutsOn.get(key);
      if (list === undefined) {
        cutsOn.set(key, [c]);
        cutCount++;
      } else if (!list.some((o) => o.x === c.x && o.y === c.y && o.z === c.z)) {
        list.push(c);
        cutCount++;
      }
    }
    for (const list of cutsOn.values()) list.sort((p, q) => p.t - q.t);
  }
  if (faults.length) return { vessel: null, faults, ribs };

  // --- The vertices.
  const total = base + cutCount;
  const position = new Float64Array(total * 3);
  for (let i = 0; i < ribs.length; i++) {
    const r = ribs[i];
    const px = -r.uz;
    const pz = r.ux;
    for (let k = 0; k < loopCount; k++) {
      const loop = r.loops[k];
      for (let j = 0; j < counts[i][k]; j++) {
        const o = loop[j * 2];
        const y = loop[j * 2 + 1];
        const v = vertexOf(i, k, j);
        position[v * 3] = r.cx + px * o;
        position[v * 3 + 1] = y;
        position[v * 3 + 2] = r.cz + pz * o;
      }
    }
  }
  /** The two seam vertices of each rib, `[left, right]`, as vertex indices. */
  const ribSeam = hasSeam ? new Int32Array(ribs.length * 2) : null;
  if (ribSeam) {
    for (let i = 0; i < ribs.length; i++) {
      ribSeam[i * 2] = vertexOf(i, 0, ribs[i].seam![0]);
      ribSeam[i * 2 + 1] = vertexOf(i, 0, ribs[i].seam![1]);
    }
  }
  /** Vertex indices of the cuts on seam edge `rib -> rib+1`, side, in `t` order. */
  const cutVerts = new Map<number, number[]>();
  /** Their `t`s, in the same order. The zip in `sideQuad` merges on them. */
  const cutTs = new Map<number, number[]>();
  {
    let at = base;
    for (const [key, list] of cutsOn) {
      const ids: number[] = [];
      for (const c of list) {
        position[at * 3] = c.x;
        position[at * 3 + 1] = c.y;
        position[at * 3 + 2] = c.z;
        ids.push(at);
        at++;
      }
      cutVerts.set(key, ids);
      cutTs.set(key, list.map((c) => c.t));
    }
  }

  // --- Which segments are transitions, and what their zip pairs up.
  //
  // A segment is **uniform** when its two ribs agree about every loop's point
  // count and about which points the seam is at, and a **transition** otherwise.
  // The distinction is made once, here, because both the fold test and the face
  // builder need it and deciding it twice is how two descriptions start.
  const uniform: boolean[] = [];
  for (let i = 0; i < ribs.length - 1; i++) {
    let same = true;
    for (let k = 0; k < loopCount; k++) if (counts[i][k] !== counts[i + 1][k]) same = false;
    const sa = ribs[i].seam;
    const sb = ribs[i + 1].seam;
    if (sa != null && sb != null && (sa[0] !== sb[0] || sa[1] !== sb[1])) same = false;
    uniform.push(same);
  }

  /**
   * One arc of a transition strip: the merge of two polylines of unequal length.
   *
   * ---------------------------------------------------------------------------
   * **THE TRANSITION RIB, IN ELEVEN LINES OF ARITHMETIC.**
   *
   * Two profiles with different point counts still have the same *shape roles* in
   * the same order round the loop -- coping, batter, floor, batter, coping -- so
   * the honest correspondence between them is by **normalised arc length round
   * the profile**, not by index. Walk both, always advancing whichever is behind,
   * and emit a triangle at each step. That is a triangulated strip between two
   * closed polylines: every edge of either loop is used exactly once by it, and
   * every cross edge exactly twice, which is the same structural argument the
   * uniform quad strip makes and the reason `checkManifold` finds nothing.
   *
   * The windings are the uniform case's, and derived from it rather than guessed:
   * `sideQuad` emits `(a, b, c)` and `(a, c, d)`, which read as "advance the far
   * rib" then "advance the near rib" from the state `(near j, far j)`. Those two
   * rules are exactly the two branches below, so with equal counts this function
   * reproduces the quad strip triangle for triangle.
   */
  const zipArc = (
    i: number,
    a0: number, a1: number,
    b0: number, b1: number,
    into: number[],
    pairs: Array<[number, number]>,
  ): boolean => {
    const m = counts[i][0];
    const n = counts[i + 1][0];
    /** Loop indices from `from` to `to` inclusive, ascending and wrapping. A full turn when equal. */
    const arc = (from: number, to: number, size: number): number[] => {
      const out = [from];
      for (let j = (from + 1) % size; out.length <= size; j = (j + 1) % size) {
        out.push(j);
        if (j === to) break;
      }
      return out;
    };
    const ja = arc(a0, a1, m);
    const jb = arc(b0, b1, n);
    /** Cumulative chord length along an arc **in the profile plane**, normalised. */
    const param = (loop: Loop, js: readonly number[]): number[] | null => {
      const out = [0];
      let s = 0;
      for (let k = 1; k < js.length; k++) {
        const p = js[k - 1] * 2;
        const q = js[k] * 2;
        s += Math.hypot(loop[q] - loop[p], loop[q + 1] - loop[p + 1]);
        out.push(s);
      }
      if (!(s > 0)) return null;
      for (let k = 0; k < out.length; k++) out[k] /= s;
      return out;
    };
    const at = param(ribs[i].loops[0], ja);
    const bt = param(ribs[i + 1].loops[0], jb);
    if (at === null || bt === null) {
      faults.push(`PROFILE: rib ${at === null ? i : i + 1} has an arc of zero length, so a transition cannot be stitched`);
      return false;
    }
    const av = ja.map((j) => vertexOf(i, 0, j));
    const bv = jb.map((j) => vertexOf(i + 1, 0, j));
    let p = 0;
    let q = 0;
    pairs.push([av[0], bv[0]]);
    while (p < av.length - 1 || q < bv.length - 1) {
      if (q < bv.length - 1 && (p >= av.length - 1 || bt[q + 1] <= at[p + 1])) {
        into.push(av[p], bv[q], bv[q + 1]);
        q++;
      } else {
        into.push(av[p], bv[q], av[p + 1]);
        p++;
      }
      pairs.push([av[p], bv[q]]);
    }
    return true;
  };

  /** The whole strip between two ribs of different shape, as triangles and cross pairs. */
  const transitionStrip = (i: number): { tris: number[]; pairs: Array<[number, number]> } | null => {
    const tris: number[] = [];
    const pairs: Array<[number, number]> = [];
    const sa = ribs[i].seam;
    const sb = ribs[i + 1].seam;
    // Anchored at the seam, so the rim stays one polyline through the change and
    // the two arcs are the trench's inside and its buried underside -- the two
    // pieces a cutting is actually made of. With no seam there is nothing to
    // anchor on and one full turn from point 0 is as good as any other choice.
    const anchors: Array<[number, number]> =
      sa != null && sb != null ? [[sa[1], sb[1]], [sa[0], sb[0]]] : [[0, 0]];
    for (let k = 0; k < anchors.length; k++) {
      const [a0, b0] = anchors[k];
      const [a1, b1] = anchors[(k + 1) % anchors.length];
      if (!zipArc(i, a0, a1, b0, b1, tris, pairs)) return null;
    }
    return { tris, pairs };
  };

  const zips: Array<{ tris: number[]; pairs: Array<[number, number]> } | null> = [];
  for (let i = 0; i < ribs.length - 1; i++) zips.push(uniform[i] ? null : transitionStrip(i));
  if (faults.length) return { vessel: null, faults, ribs };

  // --- The fold test: does the sweep turn itself inside out?
  //
  // The known failure mode, and the one that has to be caught rather than
  // drawn. Offset a profile 9 m from a centreline whose radius of curvature is
  // 6 m and the inner side's vertices travel *backwards* along the run between
  // one rib and the next -- the wall crosses itself and the "solid" contains a
  // pocket with its faces inverted. Locally that is exactly detectable: every
  // vertex of every profile must advance along the run, so
  //
  //     dot(P[i+1][j] - P[i][j], u_i)  >  0
  //
  // at every point of every rib pair. Cheap -- one dot product per vertex per
  // pair -- and it is the *local* form of the global self-intersection test,
  // which is the expensive one and lives in `ringSelfIntersects` for the ring.
  //
  // At a **transition rib** there is no `j` shared by the two profiles, so the
  // pairing the test walks is the zip's own correspondence rather than the
  // identity. Same condition, same meaning: the strip between the two ribs must
  // lean forwards everywhere.
  //
  // It is also, for free, the NaN gate. A spine point with an unloaded DEM
  // height or a rail head off the end of a polyline produces `NaN` positions,
  // `advance` comes out `NaN`, and `!(NaN > 0)` is true -- so a vessel built on
  // a missing measurement is refused here rather than emitted with a hole in it
  // that no later check could attribute to anything.
  for (let i = 0; i < ribs.length - 1 && faults.length < 24; i++) {
    const r = ribs[i];
    const advance = (a: number, b: number, what: string): void => {
      const dx = position[b * 3] - position[a * 3];
      const dz = position[b * 3 + 2] - position[a * 3 + 2];
      const d = dx * r.ux + dz * r.uz;
      if (!(d > 0)) {
        faults.push(
          `FOLD: the sweep reverses at rib ${i}->${i + 1}, ${what} ` +
            `(advance ${d.toFixed(3)} m at ${position[a * 3].toFixed(1)}, ` +
            `${position[a * 3 + 2].toFixed(1)}). The corridor turns tighter than it is wide`,
        );
      }
    };
    const zip = zips[i];
    if (zip === null) {
      for (let k = 0; k < loopCount; k++) {
        for (let j = 0; j < counts[i][k]; j++) {
          advance(vertexOf(i, k, j), vertexOf(i + 1, k, j), `loop ${k} point ${j}`);
        }
      }
    } else {
      for (const [a, b] of zip.pairs) advance(a, b, 'a transition pair');
    }
  }
  if (faults.length) return { vessel: null, faults, ribs };

  // --- The faces.
  const index: number[] = [];
  /** Which seam a rib's outer-loop point is, or `-1`. */
  const sideOf = (i: number, j: number): number => {
    const s = ribs[i].seam;
    if (s == null) return -1;
    return j === s[0] ? 0 : j === s[1] ? 1 : -1;
  };
  /**
   * One quad of the side, `(i,j) -> (i+1,j) -> (i+1,j+1) -> (i,j+1)`.
   *
   * That order is the right-handed derivation reversed -- see the header -- and
   * it is reversed a *second* time for a hole loop, whose outward direction is
   * into the void rather than out of the rock. Two reversals compose, so a hole
   * ends up with the naive order, which is exactly the sort of coincidence that
   * looks like a bug six months from now: hence the flag rather than a
   * different literal.
   */
  const sideQuad = (i: number, k: number, j: number, hole: boolean): void => {
    const m = counts[i][k];
    const j2 = (j + 1) % m;
    const a = vertexOf(i, k, j);
    const b = vertexOf(i + 1, k, j);
    const c = vertexOf(i + 1, k, j2);
    const d = vertexOf(i, k, j2);
    // The ordinary case, and the only one before Phase 2a: four corners, two
    // triangles, `a` the hinge of both.
    if (k > 0 || cutVerts.size === 0) {
      if (hole) index.push(a, d, c, a, c, b);
      else index.push(a, b, c, a, c, d);
      return;
    }
    // A quad with rim cuts on one or both of its **along** edges is a strip
    // between two polylines rather than a quad, and it is **zipped** rather than
    // fanned. The distinction is not cosmetic: fanning from `a` over a boundary
    // that contains points *on the edge `a -> b`* emits triangles whose three
    // vertices are collinear, which `checkManifold` counts as degenerate and
    // which then drops their edges and opens the surface either side. That is
    // exactly what the first draft of this did, and the check said so.
    //
    // So: chain `A` runs along loop point `j` from rib `i` to rib `i+1` with its
    // cuts in ascending `t`, chain `B` does the same along loop point `j2`, and
    // the strip advances whichever chain is behind. With no cuts at all it
    // reduces to `(a, b, d), (b, c, d)` -- the same two triangles the plain case
    // draws, hinged on the other diagonal, which is why the plain case is kept
    // literally above rather than left to fall out of here.
    //
    // The neighbouring quad across a cut edge walks the same points in the
    // opposite direction, so every sub-edge is still traversed exactly twice and
    // exactly once each way. That is the whole of why the surface stays closed,
    // and `checkManifold` proves it rather than taking this paragraph's word.
    const sj = sideOf(i, j);
    const sj2 = sideOf(i, j2);
    const ab = sj >= 0 ? cutVerts.get(i * 2 + sj) : undefined;
    const cd = sj2 >= 0 ? cutVerts.get(i * 2 + sj2) : undefined;
    if (ab === undefined && cd === undefined) {
      if (hole) index.push(a, d, c, a, c, b);
      else index.push(a, b, c, a, c, d);
      return;
    }
    const av = [a, ...(ab ?? []), b];
    const at = [0, ...(sj >= 0 ? cutTs.get(i * 2 + sj) ?? [] : []), 1];
    const bv = [d, ...(cd ?? []), c];
    const bt = [0, ...(sj2 >= 0 ? cutTs.get(i * 2 + sj2) ?? [] : []), 1];
    let p = 0;
    let q = 0;
    const tri = (u: number, v: number, w: number): void => {
      if (hole) index.push(u, w, v);
      else index.push(u, v, w);
    };
    while (p < av.length - 1 || q < bv.length - 1) {
      if (q >= bv.length - 1 || (p < av.length - 1 && at[p + 1] <= bt[q + 1])) {
        tri(av[p], av[p + 1], bv[q]);
        p++;
      } else {
        tri(av[p], bv[q + 1], bv[q]);
        q++;
      }
    }
  };
  /**
   * Insert a chain of points into one edge of the faces already emitted.
   *
   * The transition strip's own seam edges are **cross** edges of the zip, so the
   * rim cuts on them cannot be merged into the walk the way `sideQuad` merges
   * them into an along edge. They are put in afterwards instead, by the only
   * operation that can add a vertex to a closed surface without opening it:
   * find the two faces that share the edge and replace each with the fan through
   * the chain. Every sub-edge is then traversed exactly once each way, which is
   * the same argument as everywhere else in this file, and `checkManifold`
   * re-proves it rather than taking it.
   *
   * `false` if the edge was not shared by exactly two faces, which would mean
   * the strip above is already wrong and the cut would be papering over it.
   */
  const splitEdge = (fromFace: number, a: number, b: number, chain: readonly number[]): boolean => {
    if (chain.length === 0) return true;
    const tail: number[] = [];
    let hits = 0;
    for (let f = fromFace; f < index.length / 3; f++) {
      const t0 = index[f * 3];
      const t1 = index[f * 3 + 1];
      const t2 = index[f * 3 + 2];
      const tri = [t0, t1, t2];
      let rot = -1;
      let forward = false;
      for (let r = 0; r < 3; r++) {
        if (tri[r] === a && tri[(r + 1) % 3] === b) { rot = r; forward = true; break; }
        if (tri[r] === b && tri[(r + 1) % 3] === a) { rot = r; forward = false; break; }
      }
      if (rot < 0) {
        tail.push(t0, t1, t2);
        continue;
      }
      hits++;
      const apex = tri[(rot + 2) % 3];
      const seq = forward ? [a, ...chain, b] : [b, ...[...chain].reverse(), a];
      for (let s = 0; s < seq.length - 1; s++) tail.push(seq[s], seq[s + 1], apex);
    }
    index.length = fromFace * 3;
    for (const v of tail) index.push(v);
    return hits === 2;
  };

  const sideFace = new Uint32Array(ribs.length);
  for (let i = 0; i < ribs.length - 1; i++) {
    sideFace[i] = index.length / 3;
    const zip = zips[i];
    if (zip === null) {
      for (let k = 0; k < loopCount; k++) {
        for (let j = 0; j < counts[i][k]; j++) sideQuad(i, k, j, k > 0);
      }
      continue;
    }
    for (const v of zip.tris) index.push(v);
    for (const side of [0, 1] as const) {
      const chain = cutVerts.get(i * 2 + side);
      if (chain === undefined || ribSeam === null) continue;
      if (!splitEdge(sideFace[i], ribSeam[i * 2 + side], ribSeam[(i + 1) * 2 + side], chain)) {
        faults.push(
          `SHAPE: the transition at rib ${i}->${i + 1} does not share its ${side ? 'right' : 'left'} ` +
            `seam edge between exactly two faces, so a rim cut cannot be put into it`,
        );
      }
    }
  }
  sideFace[ribs.length - 1] = index.length / 3;
  if (faults.length) return { vessel: null, faults, ribs };

  // --- The caps. Two of them, and they are the reason the surface closes.
  const capAt = (i: number, forward: boolean): boolean => {
    if (loopCount === 1) {
      // A simple polygon: ear clipping, on the profile's own `(o, y)`, which is
      // where the polygon is actually simple. Doing it on the world-space
      // projection would be the same answer for a straight rib and a subtly
      // different one for a skewed one, and "subtly different" is how a cap
      // ends up with a sliver in it.
      const tri = earClip(ribs[i].loops[0]);
      if (tri === null) return false;
      for (let t = 0; t < tri.length; t += 3) {
        const a = vertexOf(i, 0, tri[t]);
        const b = vertexOf(i, 0, tri[t + 1]);
        const c = vertexOf(i, 0, tri[t + 2]);
        // The `t = 0` cap faces backwards along the run, the far one forwards,
        // and in a left-handed frame that is the opposite of the right-handed
        // intuition. See the header.
        if (forward) index.push(a, c, b);
        else index.push(a, b, c);
      }
      return true;
    }
    // An annulus: a strip between the two loops, pairing index to index. No
    // ear clipping, no bridge vertices, and therefore no duplicated positions
    // for `checkManifold` to find.
    const m = counts[i][0];
    for (let j = 0; j < m; j++) {
      const j2 = (j + 1) % m;
      const o0 = vertexOf(i, 0, j);
      const o1 = vertexOf(i, 0, j2);
      const i0 = vertexOf(i, 1, j);
      const i1 = vertexOf(i, 1, j2);
      // Which way round is decided by what the *side* strip already presents at
      // this rib, not by intuition about which way the cap faces: the strip's
      // around-edges run `j+1 -> j` at rib 0 for the outer loop and `j -> j+1`
      // at the far rib, and a cap has to be the opposite of its neighbour or
      // the shared edge is traversed twice the same way. It is off by one
      // reversal from the ear-clipped case because a hole reverses too, and
      // getting it backwards is a mesh that looks right and has eighty
      // boundary edges in it.
      if (forward) index.push(o0, i0, i1, o0, i1, o1);
      else index.push(o0, o1, i1, o0, i1, i0);
    }
    return true;
  };
  if (!capAt(0, false)) faults.push('PROFILE: the start cap could not be triangulated');
  if (!capAt(ribs.length - 1, true)) faults.push('PROFILE: the end cap could not be triangulated');
  if (faults.length) return { vessel: null, faults, ribs };

  // --- The rim, which is the whole point.
  //
  // Down one seam and back the other: the outline of the footprint in plan,
  // named by index into this vessel's own vertices. Normalised to
  // counter-clockwise in `(x, z)` so a terrain triangulator handed any vessel
  // knows without asking which side of the ring it owns.
  //
  // A transition rib contributes exactly two vertices to this walk like every
  // other rib, which is the point of anchoring the zip on the seam: the rim does
  // not know a transition happened.
  let rim: Uint32Array;
  if (ribSeam === null) {
    rim = new Uint32Array(0);
  } else {
    // Down one seam and back the other, with each edge's cuts inserted in the
    // order that edge is being walked in. The right side runs with the sweep, so
    // its cuts come in ascending `t`; the left side runs against it, so they
    // come back in descending `t`. Getting that backwards would produce a ring
    // that zig-zags, which `ringSelfIntersects` would then report -- but only
    // for the cut vertices, which is a confusing place to learn about it.
    const list: number[] = [];
    for (let i = 0; i < ribs.length; i++) {
      list.push(ribSeam[i * 2 + 1]);
      const c = i < ribs.length - 1 ? cutVerts.get(i * 2 + 1) : undefined;
      if (c) for (const v of c) list.push(v);
    }
    for (let i = ribs.length - 1; i >= 0; i--) {
      list.push(ribSeam[i * 2]);
      const c = i > 0 ? cutVerts.get((i - 1) * 2) : undefined;
      if (c) for (let n = c.length - 1; n >= 0; n--) list.push(c[n]);
    }
    const ring = new Uint32Array(list);
    if (ringArea(position, ring) < 0) ring.reverse();
    rim = ring;
  }

  const vessel: Vessel = {
    disposition,
    position,
    index: new Uint32Array(index),
    rim,
    ribSeam,
    ribCount: ribs.length,
    ribOffset,
    sideFace,
    triangles: index.length / 3,
  };
  return { vessel, faults, ribs };
}

/**
 * A corridor vessel from a measured spine. The convenience wrapper, and the
 * only function in the file that knows a railway from a drainpipe.
 *
 * The spine arrives already sampled: `rail-cut.ts` and the DEM upstream, plain
 * numbers here. The direction at each point is the chord to its neighbour,
 * averaged at interior points so the frame turns smoothly rather than in steps
 * -- a stepped frame puts a wedge of daylight on the outside of every bend,
 * which is `writeBallast`'s reason for overlapping its segments and would be
 * this function's reason for a fault it does not have to raise.
 */
export function buildCorridorVessel(
  disposition: Disposition,
  spine: readonly SpinePoint[],
  cuts: readonly RimCut[] = [],
): VesselBuild {
  if (spine.length < 2) {
    return { vessel: null, faults: [`SHAPE: a corridor needs at least two spine points, got ${spine.length}`] };
  }
  const ribs: Rib[] = [];
  for (let i = 0; i < spine.length; i++) {
    const p = spine[i];
    const prev = spine[Math.max(0, i - 1)];
    const next = spine[Math.min(spine.length - 1, i + 1)];
    let ux = next.x - prev.x;
    let uz = next.z - prev.z;
    const len = Math.hypot(ux, uz);
    if (!(len > 1e-9)) {
      return {
        vessel: null,
        faults: [`SHAPE: spine point ${i} coincides with its neighbours at ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`],
      };
    }
    ux /= len;
    uz /= len;
    const [oL, oR] = p.span;
    const profile =
      disposition === 'trench'
        ? trenchProfile(oL, oR, p.railY, p.groundY[0], p.groundY[1])
        : disposition === 'embankment'
          ? embankmentProfile(oL, oR, p.railY - VESSEL_FLOOR_DROP, p.groundY[0], p.groundY[1])
          : disposition === 'viaduct'
            ? viaductProfile(oL, oR, p.railY)
            : boreProfile(Math.max(2.4, ((oR - oL) / 2) * 0.62), p.railY, undefined, undefined, undefined, (oL + oR) / 2);
    ribs.push({ cx: p.x, cz: p.z, ux, uz, loops: profile.loops, seam: profile.seam });
  }
  return buildVessel(disposition, ribs, cuts);
}

// --- The manifold check --------------------------------------------------------------

/** What `checkManifold` found. Every count is over the whole mesh. */
export interface ManifoldReport {
  vertices: number;
  /** Undirected edges. */
  edges: number;
  faces: number;
  /** Connected components of the surface. */
  components: number;
  /** `V - E + F`. `2C` for a sphere-per-component, `0` for a torus. */
  euler: number;
  /** `C - euler/2`, meaningful only when the surface is closed and orientable. */
  genus: number;
  /**
   * Signed volume in cubic metres, by the divergence theorem. Positive means
   * every face points out of the solid; negative means the whole thing is
   * inside out; near zero on a closed surface means it has collapsed.
   */
  volume: number;
  /** Directed edges with no opposite: the surface is open here. */
  boundaryEdges: number;
  /** Directed edges appearing twice: two faces the same way round. */
  nonManifoldEdges: number;
  /** Faces with a repeated index, or with exactly zero area. */
  degenerateFaces: number;
  /** Faces below `SLIVER_AREA` but not zero. Reported, not failed. */
  sliverFaces: number;
  /** Distinct indices holding bit-identical positions. */
  duplicateVertices: number;
  /** Everything wrong, in words. Empty means the surface is closed. */
  faults: string[];
}

/**
 * How small a triangle has to be before it is called a sliver, square metres.
 *
 * **This is not a tolerance and nothing depends on it.** Vertex identity in this
 * file is exact and index-based; a face is degenerate if it repeats an index or
 * has *exactly* zero area, both of which are decidable without a threshold. A
 * sliver is a rendering and shading nuisance, not a hole, so it is counted and
 * printed and never failed on. If it were a fault the number would be a
 * tolerance, and the design would have grown the thing it exists to delete.
 */
export const SLIVER_AREA = 1e-9;

/**
 * Is this mesh a closed, consistently wound, non-degenerate 2-manifold?
 *
 * ---------------------------------------------------------------------------
 * **This is the first check in the project that cannot pass while the world has
 * a hole in it**, and that sentence is the reason the file exists. Every other
 * rail check written so far -- walk a body here, probe a point there, count the
 * buried samples -- can be true of a world with a slot of daylight in it,
 * because it only ever asked about the places it happened to look. Three rounds
 * passed their checks and shipped holes.
 *
 * Manifoldness is not a sample. It is arithmetic over every edge:
 *
 *   1. **Every directed edge appears exactly once.** Two faces sharing an edge
 *      the same way round is a fold; a third face on an edge is a non-manifold
 *      seam; and both are caught by counting rather than by looking.
 *   2. **Every directed edge has its opposite.** An edge with no opposite is a
 *      boundary -- a *hole* -- and this is the condition that made the check
 *      worth writing. It subsumes "closed" and "consistently wound" at once:
 *      a mesh whose winding is inconsistent has some edge traversed twice the
 *      same way, which is (1); a mesh with a hole has some edge traversed once,
 *      which is (2). There is nothing else to test.
 *   3. **No face is degenerate.** A repeated index, or exactly zero area. Both
 *      are exact tests.
 *   4. **No two distinct indices hold the same position.** Two vertices at one
 *      point are two vertices the surface can be torn apart at: the edges
 *      through them do not match up, so (2) usually catches it too -- but not
 *      always, and when it does the message is about an edge rather than about
 *      the weld that was missed. Compared **bit-exactly**, with no epsilon,
 *      because the moment a distance decides vertex identity this design has
 *      reintroduced the tolerance it was built to remove.
 *   5. **The signed volume is positive**, which is orientation: a closed
 *      surface passing (1) and (2) is consistently wound either outward or
 *      inward, and only one of those is a solid.
 *
 * The Euler characteristic is *reported*, not asserted. A trench is a sphere
 * and a bore is a torus; a check that demanded `V - E + F = 2` would reject
 * every tunnel in Sydney, which is the sort of over-tight invariant that gets
 * deleted the first time it fires and then never comes back.
 *
 * ---------------------------------------------------------------------------
 * **Fast enough to run over every vessel in a build.** One pass over the faces
 * building a `Map` of `3F` directed edges keyed as a single number, one sort of
 * `V` indices for the weld test, one union-find for the components. No strings,
 * no allocation per edge.
 *
 * Measured warm on this machine, straight trench vessels:
 *
 *     ribs   run     triangles   buildVessel   checkManifold
 *        6    40 m          92         8 us          35 us
 *       11    80 m         172        14 us          62 us
 *       65   512 m       1,036        48 us         250 us
 *
 * -- about a quarter of a microsecond a triangle, so checking every vessel in a
 * 512 m chunk costs well under a millisecond against a 150 ms budget. That is
 * the number that decides whether the invariant is an *invariant* or a thing
 * somebody remembers to invoke: it is cheap enough to run on every build, so it
 * will be.
 */
export function checkManifold(mesh: { position: Float64Array; index: Uint32Array }): ManifoldReport {
  const { position, index } = mesh;
  const V = position.length / 3;
  const F = index.length / 3;
  const faults: string[] = [];

  if (index.length % 3 !== 0) faults.push(`the index is ${index.length} long, which is not a whole number of triangles`);
  if (position.length % 3 !== 0) faults.push(`the position array is ${position.length} long, which is not a whole number of vertices`);
  if (V >= 1 << 26) faults.push(`${V} vertices exceeds the 2^26 the edge key packs into`);
  if (F === 0) faults.push('the mesh has no faces at all');
  if (faults.length) {
    return {
      vertices: V, edges: 0, faces: F, components: 0, euler: 0, genus: 0, volume: 0,
      boundaryEdges: 0, nonManifoldEdges: 0, degenerateFaces: 0, sliverFaces: 0,
      duplicateVertices: 0, faults,
    };
  }

  // --- (3) and (5), and the edge tally, in one pass over the faces.
  //
  // The key packs two 26-bit vertex indices into one double, which holds
  // integers exactly to 2^53. A `Map<number, number>` on that is a great deal
  // cheaper than a string key and is the difference between this running per
  // build and running in a check.
  const KEY = 1 << 26;
  const edges = new Map<number, number>();
  let degenerate = 0;
  let slivers = 0;
  let volume = 0;
  let firstDegenerate = -1;
  for (let f = 0; f < F; f++) {
    const a = index[f * 3];
    const b = index[f * 3 + 1];
    const c = index[f * 3 + 2];
    if (a === b || b === c || a === c) {
      degenerate++;
      if (firstDegenerate < 0) firstDegenerate = f;
      continue;
    }
    if (a >= V || b >= V || c >= V) {
      faults.push(`face ${f} names vertex ${Math.max(a, b, c)} of ${V}`);
      continue;
    }
    const ax = position[a * 3], ay = position[a * 3 + 1], az = position[a * 3 + 2];
    const bx = position[b * 3], by = position[b * 3 + 1], bz = position[b * 3 + 2];
    const cx = position[c * 3], cy = position[c * 3 + 1], cz = position[c * 3 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const twice = Math.hypot(nx, ny, nz);
    if (twice === 0) {
      degenerate++;
      if (firstDegenerate < 0) firstDegenerate = f;
      continue;
    }
    if (twice * 0.5 < SLIVER_AREA) slivers++;
    // Divergence theorem: six times the signed volume is the sum of
    // `a . (b x c)` over the faces.
    volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
    const put = (p: number, q: number): void => {
      const k = p * KEY + q;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    };
    put(a, b);
    put(b, c);
    put(c, a);
  }

  // --- (1) and (2). The whole invariant, in one walk of the edge table.
  let boundary = 0;
  let nonManifold = 0;
  let firstBoundary = -1;
  let firstNonManifold = -1;
  let undirected = 0;
  for (const [k, n] of edges) {
    const a = Math.floor(k / KEY);
    const b = k - a * KEY;
    if (n > 1) {
      nonManifold += n - 1;
      if (firstNonManifold < 0) firstNonManifold = a;
    }
    const back = edges.get(b * KEY + a) ?? 0;
    if (back === 0) {
      boundary++;
      if (firstBoundary < 0) firstBoundary = a;
    }
    if (a < b) undirected++;
    else if (back === 0) undirected++; // a boundary edge counted from its only side
  }

  // --- (4). Two indices, one position, bit for bit.
  //
  // Sorted rather than hashed: `V log V` comparisons against `V` string
  // allocations, and the sort also makes the *first* offending pair cheap to
  // name, which is what a fault message needs.
  const order: number[] = new Array(V);
  for (let i = 0; i < V; i++) order[i] = i;
  const sorted = order.sort((p, q) => {
    const d0 = position[p * 3] - position[q * 3];
    if (d0 !== 0) return d0;
    const d1 = position[p * 3 + 1] - position[q * 3 + 1];
    if (d1 !== 0) return d1;
    return position[p * 3 + 2] - position[q * 3 + 2];
  });
  let duplicates = 0;
  let firstDuplicate = -1;
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i - 1];
    const q = sorted[i];
    if (
      position[p * 3] === position[q * 3] &&
      position[p * 3 + 1] === position[q * 3 + 1] &&
      position[p * 3 + 2] === position[q * 3 + 2]
    ) {
      duplicates++;
      if (firstDuplicate < 0) firstDuplicate = q;
    }
  }

  // --- Components, for the Euler characteristic to mean anything.
  const parent = new Int32Array(V);
  for (let i = 0; i < V; i++) parent[i] = i;
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) {
      const next = parent[i];
      parent[i] = r;
      i = next;
    }
    return r;
  };
  const union = (p: number, q: number): void => {
    const rp = find(p);
    const rq = find(q);
    if (rp !== rq) parent[rp] = rq;
  };
  const used = new Uint8Array(V);
  for (let f = 0; f < F; f++) {
    const a = index[f * 3];
    const b = index[f * 3 + 1];
    const c = index[f * 3 + 2];
    if (a >= V || b >= V || c >= V) continue;
    used[a] = 1; used[b] = 1; used[c] = 1;
    union(a, b);
    union(b, c);
  }
  const roots = new Set<number>();
  let orphans = 0;
  for (let i = 0; i < V; i++) {
    if (used[i]) roots.add(find(i));
    else orphans++;
  }
  const components = roots.size;
  const euler = V - orphans - undirected + (F - degenerate);
  const genus = components - euler / 2;

  // --- The verdict.
  if (boundary > 0) {
    faults.push(
      `${boundary} boundary edge${boundary === 1 ? '' : 's'}: the surface is open, ` +
        `first at vertex ${firstBoundary} (${position[firstBoundary * 3].toFixed(2)}, ` +
        `${position[firstBoundary * 3 + 1].toFixed(2)}, ${position[firstBoundary * 3 + 2].toFixed(2)}). ` +
        `A player can pass through it`,
    );
  }
  if (nonManifold > 0) {
    faults.push(
      `${nonManifold} directed edge${nonManifold === 1 ? '' : 's'} used more than once: two faces ` +
        `the same way round, first at vertex ${firstNonManifold}. The winding is inconsistent or ` +
        `a face is duplicated`,
    );
  }
  if (degenerate > 0) {
    faults.push(
      `${degenerate} degenerate face${degenerate === 1 ? '' : 's'} (repeated index or exactly zero ` +
        `area), first at face ${firstDegenerate}`,
    );
  }
  if (duplicates > 0) {
    faults.push(
      `${duplicates} vertex pair${duplicates === 1 ? '' : 's'} at bit-identical positions on distinct ` +
        `indices, first at index ${firstDuplicate}. Two vertices at one point are a seam waiting ` +
        `to open; weld them or find out why the sweep emitted the same point twice`,
    );
  }
  if (boundary === 0 && nonManifold === 0 && !(volume > 0)) {
    faults.push(
      `the closed surface has signed volume ${volume.toFixed(3)} m3, which is not positive: every ` +
        `face points inward, so the solid is inside out and a FrontSide material culls all of it`,
    );
  }

  return {
    vertices: V,
    edges: undirected,
    faces: F,
    components,
    euler,
    genus,
    volume,
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    degenerateFaces: degenerate,
    sliverFaces: slivers,
    duplicateVertices: duplicates,
    faults,
  };
}

/** One line describing a report, for a log or a check transcript. */
export function describeManifold(r: ManifoldReport): string {
  return (
    `V ${r.vertices} E ${r.edges} F ${r.faces}, ${r.components} component` +
    `${r.components === 1 ? '' : 's'}, chi ${r.euler}, genus ${r.genus}, ` +
    `volume ${r.volume.toFixed(1)} m3` +
    (r.sliverFaces ? `, ${r.sliverFaces} slivers` : '') +
    (r.faults.length ? `, ${r.faults.length} FAULT` : ', closed')
  );
}

// --- Negative controls ---------------------------------------------------------------
//
// A check nobody has ever seen fail is indistinguishable from a check that does
// not work. Each of these breaks a manifold in exactly one way, and each is
// asserted to make `checkManifold` scream -- at boot, and in
// `server/integration-check.ts` against the real corridor.

/** A mesh with one triangle removed. The hole the player falls through. */
export function punchHole(mesh: { position: Float64Array; index: Uint32Array }, face = 0): {
  position: Float64Array;
  index: Uint32Array;
} {
  const F = mesh.index.length / 3;
  const drop = ((face % F) + F) % F;
  const out = new Uint32Array(mesh.index.length - 3);
  out.set(mesh.index.subarray(0, drop * 3), 0);
  out.set(mesh.index.subarray(drop * 3 + 3), drop * 3);
  return { position: mesh.position, index: out };
}

/** A mesh with one triangle wound backwards. Culled, and a window into the void. */
export function flipFace(mesh: { position: Float64Array; index: Uint32Array }, face = 0): {
  position: Float64Array;
  index: Uint32Array;
} {
  const F = mesh.index.length / 3;
  const at = (((face % F) + F) % F) * 3;
  const out = new Uint32Array(mesh.index);
  const b = out[at + 1];
  out[at + 1] = out[at + 2];
  out[at + 2] = b;
  return { position: mesh.position, index: out };
}

/**
 * A mesh with one vertex split into two at the same point: the unwelded seam.
 *
 * The failure this models is the one the whole redesign is about -- two modules
 * each emitting their own copy of a shared boundary vertex -- so it is the most
 * important of the four controls even though it is the least dramatic. It opens
 * boundary edges as well, which is the point: an unwelded seam *is* a hole.
 */
export function splitVertex(mesh: { position: Float64Array; index: Uint32Array }, face = 0): {
  position: Float64Array;
  index: Uint32Array;
} {
  const F = mesh.index.length / 3;
  const at = (((face % F) + F) % F) * 3;
  const v = mesh.index[at];
  const V = mesh.position.length / 3;
  const position = new Float64Array(mesh.position.length + 3);
  position.set(mesh.position, 0);
  position[V * 3] = mesh.position[v * 3];
  position[V * 3 + 1] = mesh.position[v * 3 + 1];
  position[V * 3 + 2] = mesh.position[v * 3 + 2];
  const index = new Uint32Array(mesh.index);
  index[at] = V;
  return { position, index };
}

/** A mesh with one triangle collapsed onto a repeated index. */
export function collapseFace(mesh: { position: Float64Array; index: Uint32Array }, face = 0): {
  position: Float64Array;
  index: Uint32Array;
} {
  const F = mesh.index.length / 3;
  const at = (((face % F) + F) % F) * 3;
  const index = new Uint32Array(mesh.index);
  index[at + 1] = index[at];
  return { position: mesh.position, index };
}

// --- Geometry helpers ------------------------------------------------------------------

/**
 * Why this loop is not a simple polygon, or the empty string if it is.
 *
 * Three things, in the order they are cheap: a repeated point, a segment pair
 * that crosses, and a winding that comes out clockwise. The last is not a
 * defect of the polygon -- a clockwise ring is a perfectly good ring -- but it
 * *is* a defect of a profile, because `buildVessel` derives every face's
 * orientation from the assumption that the loop is counter-clockwise in
 * `(o, y)`, and a reversed one produces a vessel that is inside out. Caught
 * here, where the message can say which loop; the signed-volume test in
 * `checkManifold` is the backstop.
 */
function loopFault(loop: Loop): string {
  const m = loop.length / 2;
  if (m < 3) return `only ${m} points`;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    if (loop[i * 2] === loop[j * 2] && loop[i * 2 + 1] === loop[j * 2 + 1]) {
      return `points ${i} and ${j} are the same point (${loop[i * 2]}, ${loop[i * 2 + 1]})`;
    }
  }
  let area = 0;
  for (let i = 0; i < m; i++) {
    const j = (i + 1) % m;
    area += loop[i * 2] * loop[j * 2 + 1] - loop[j * 2] * loop[i * 2 + 1];
  }
  if (area <= 0) return `winds clockwise (signed area ${(area / 2).toFixed(3)}), which builds it inside out`;
  for (let i = 0; i < m; i++) {
    const i2 = (i + 1) % m;
    for (let j = i + 1; j < m; j++) {
      const j2 = (j + 1) % m;
      if (i === j || i2 === j || j2 === i) continue;
      if (
        segmentsCross(
          loop[i * 2], loop[i * 2 + 1], loop[i2 * 2], loop[i2 * 2 + 1],
          loop[j * 2], loop[j * 2 + 1], loop[j2 * 2], loop[j2 * 2 + 1],
        )
      ) {
        return `edges ${i}-${i2} and ${j}-${j2} cross, so the cross-section is not a simple polygon`;
      }
    }
  }
  return '';
}

/** Do two open segments properly cross? Strict, so touching endpoints do not count. */
function segmentsCross(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const d1 = cross(cx, cy, dx, dy, ax, ay);
  const d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy);
  const d4 = cross(ax, ay, bx, by, dx, dy);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

function cross(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

/**
 * Ear clipping on a simple counter-clockwise polygon, returning triangle
 * indices into the loop.
 *
 * The textbook `O(n^2)`, and it is the right one here: a profile is eight
 * points, or ten for a bore, and the fastest correct triangulator is the one
 * whose failure modes fit on a screen. Returns null rather than a partial fan
 * if it stalls -- a cap with a missing triangle is a hole, and a hole silently
 * emitted is the entire thing this file exists to prevent.
 */
export function earClip(loop: Loop): number[] | null {
  const m = loop.length / 2;
  const live: number[] = [];
  for (let i = 0; i < m; i++) live.push(i);
  const out: number[] = [];
  let guard = m * m + 8;
  while (live.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < live.length; k++) {
      const a = live[(k + live.length - 1) % live.length];
      const b = live[k];
      const c = live[(k + 1) % live.length];
      const ax = loop[a * 2], ay = loop[a * 2 + 1];
      const bx = loop[b * 2], by = loop[b * 2 + 1];
      const cx = loop[c * 2], cy = loop[c * 2 + 1];
      // Convex in a counter-clockwise polygon, and strictly so: a collinear
      // "ear" is a zero-area triangle, which `checkManifold` would count as
      // degenerate.
      if (cross(ax, ay, bx, by, cx, cy) <= 0) continue;
      let contains = false;
      for (const o of live) {
        if (o === a || o === b || o === c) continue;
        if (pointInTriangle(loop[o * 2], loop[o * 2 + 1], ax, ay, bx, by, cx, cy)) {
          contains = true;
          break;
        }
      }
      if (contains) continue;
      out.push(a, b, c);
      live.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) return null;
  }
  if (live.length !== 3) return null;
  out.push(live[0], live[1], live[2]);
  return out;
}

function pointInTriangle(
  px: number, py: number,
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
): boolean {
  const d1 = cross(ax, ay, bx, by, px, py);
  const d2 = cross(bx, by, cx, cy, px, py);
  const d3 = cross(cx, cy, ax, ay, px, py);
  return d1 >= 0 && d2 >= 0 && d3 >= 0;
}

/** Twice the signed plan area of a ring of vertex indices, in `(x, z)`. */
export function ringArea(position: Float64Array, ring: Uint32Array): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i];
    const q = ring[(i + 1) % ring.length];
    a += position[p * 3] * position[q * 3 + 2] - position[q * 3] * position[p * 3 + 2];
  }
  return a / 2;
}

/**
 * Does the rim ring cross itself in plan?
 *
 * The **global** form of the fold test, and the expensive one: `O(k^2)` over the
 * ring, where the fold test in `buildVessel` is `O(k)` and local. A sweep can be
 * locally forward everywhere and still close a loop that overlaps itself half a
 * kilometre later -- a balloon loop, or two vessels of a junction that were
 * meant to be unioned and were not. Not run per build; run by the checks, and
 * by whatever in Phase 2 unions a junction footprint.
 */
export function ringSelfIntersects(position: Float64Array, ring: Uint32Array): boolean {
  const k = ring.length;
  for (let i = 0; i < k; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % k];
    for (let j = i + 1; j < k; j++) {
      const c = ring[j];
      const d = ring[(j + 1) % k];
      if (a === c || a === d || b === c || b === d) continue;
      if (
        segmentsCross(
          position[a * 3], position[a * 3 + 2], position[b * 3], position[b * 3 + 2],
          position[c * 3], position[c * 3 + 2], position[d * 3], position[d * 3 + 2],
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

// --- The boot self-check ----------------------------------------------------------------

/**
 * Everything this file claims, asserted at boot against synthetic vessels.
 *
 * On this project's usual criterion for what earns a self-check: **every way
 * this file fails is silent.** A winding reversed by the left-handed frame is a
 * vessel that renders as nothing; a cap that fails to triangulate is a hole at
 * the end of a segment nobody walks to for a week; a manifold check that has
 * quietly stopped detecting anything passes every build forever. The negative
 * controls are half the value here -- a checker that cannot fail is not a
 * checker -- and they are run in the browser as well as in CI because a check
 * nothing runs is a check that rots.
 *
 * Straight, curved and tapering corridors, all four dispositions, a fold, a
 * mis-classified embankment, the rim ring, and four ways of breaking a sound
 * mesh. 6.5 ms on the first call and 1.6 ms warm -- the difference is the JIT
 * seeing `buildVessel` for the first time, which is a cost boot pays anyway the
 * moment the first chunk is built.
 */
export function verifyVessels(): string[] {
  const bad: string[] = [];

  /**
   * A short spine, optionally curving, optionally opening out at a platform.
   *
   * `above` is the rail head's height over the ground and it is a parameter
   * rather than a constant because the sign of it is what chooses the
   * disposition in the first place -- `RAIL-VERTICAL.md` §1, `clearance(s) =
   * trackY(s) - groundY(s)`, measured and never labelled. An embankment built
   * on a spine whose rail is *under* the ground is exactly the Chatswood
   * failure (tagged `elevated`, measured 6.90 m below the grid) and this file
   * refuses it rather than emitting an inverted trapezoid; see
   * `embankmentProfile`.
   */
  const spine = (n: number, curve: number, flare: boolean, above = -3.2): SpinePoint[] => {
    const out: SpinePoint[] = [];
    for (let i = 0; i < n; i++) {
      const t = i * 8;
      const a = curve * t;
      const railY = -50 - t * 0.01;
      // Asymmetric on purpose, and asymmetric *differently* at each end when the
      // flare is on. A formation's centreline is one of its tracks, so the
      // ordinary case is a rim 5.4 m out on one side and further on the other,
      // and a self-check built on a symmetric corridor would be checking the one
      // shape Phase 3 no longer produces.
      const grow = flare ? 4 * Math.min(1, i / (n - 1)) : 0;
      out.push({
        x: Math.sin(a) * (curve === 0 ? 0 : 1 / curve) + (curve === 0 ? t : 0),
        z: curve === 0 ? 0 : (1 - Math.cos(a)) / curve,
        railY,
        groundY: [railY - above, railY - above + 0.8],
        span: [-5.4 - grow * 0.5, 5.4 + grow],
      });
    }
    return out;
  };

  const cases: Array<[string, VesselBuild]> = [
    ['a straight trench', buildCorridorVessel('trench', spine(9, 0, false))],
    ['a trench opening out at a platform', buildCorridorVessel('trench', spine(9, 0, true))],
    ['a trench on a 400 m radius curve', buildCorridorVessel('trench', spine(9, 1 / 400, false))],
    ['an embankment', buildCorridorVessel('embankment', spine(7, 0, false, 4.5))],
    ['a viaduct', buildCorridorVessel('viaduct', spine(7, 0, false, 7.0))],
    ['a bore', buildCorridorVessel('bore', spine(7, 0, false, -14))],
  ];

  for (const [name, build] of cases) {
    if (build.vessel === null) {
      bad.push(`${name} did not build: ${build.faults.join('; ')}`);
      continue;
    }
    if (build.faults.length) bad.push(`${name} built with faults: ${build.faults.join('; ')}`);
    const report = checkManifold(build.vessel);
    if (report.faults.length) bad.push(`${name} is not a closed manifold: ${report.faults.join('; ')}`);
    if (!(report.volume > 0)) bad.push(`${name} has signed volume ${report.volume.toFixed(2)} m3`);
  }

  // The topology each disposition is supposed to have. A trench, an embankment
  // and a viaduct are spheres; a bore is a torus, and if it ever comes out a
  // sphere the lid has been lost.
  const genusOf = (d: Disposition, n: number, above: number): number => {
    const v = buildCorridorVessel(d, spine(n, 0, false, above)).vessel;
    return v === null ? -99 : checkManifold(v).genus;
  };
  if (genusOf('trench', 9, -3.2) !== 0) bad.push('a trench is not topologically a sphere');
  if (genusOf('bore', 7, -14) !== 1) bad.push('a bore is not topologically a torus, so it has no void through it');

  // The mis-classification refusal, which is `RAIL-VERTICAL.md` §2 turned into
  // geometry: a disposition that contradicts the measured clearance must not
  // build. An embankment whose rail head is three metres *under* the ground is
  // Chatswood, and what it would emit is a trapezoid inside out.
  const buried = buildCorridorVessel('embankment', spine(5, 0, false, -3.2));
  if (buried.vessel !== null || !buried.faults.some((f) => f.startsWith('PROFILE'))) {
    bad.push('an embankment whose crest is below the ground was not refused');
  }

  // The rim, which is the seam rule. It must be a closed simple ring of the
  // vessel's **own** vertices, wound counter-clockwise in plan.
  const trench = buildCorridorVessel('trench', spine(9, 0, true)).vessel;
  if (trench === null) {
    bad.push('the flared trench did not build, so the rim could not be checked');
  } else {
    // Two seam vertices per rib, nine ribs.
    if (trench.rim.length !== 18) {
      bad.push(`the rim ring has ${trench.rim.length} vertices, expected 18`);
    }
    const V = trench.position.length / 3;
    if (![...trench.rim].every((i) => i < V)) bad.push('the rim names a vertex outside the vessel');
    if (new Set(trench.rim).size !== trench.rim.length) bad.push('the rim names the same vertex twice');
    if (!(ringArea(trench.position, trench.rim) > 0)) {
      bad.push('the rim ring is not counter-clockwise in plan, so the terrain cannot tell which side it owns');
    }
    if (ringSelfIntersects(trench.position, trench.rim)) bad.push('the rim ring crosses itself in plan');
    // And the claim that makes it a *seam* rather than a copy: every rim vertex
    // is a vertex the mesh's own faces use. If the ring were an independent
    // approximation this would be the assertion that failed.
    const used = new Set<number>(trench.index);
    if (![...trench.rim].every((i) => used.has(i))) {
      bad.push('a rim vertex is not used by any face, so the ring is not the surface');
    }
  }

  // The rim cuts, which are the terrain's half of the seam rule. A vessel whose
  // rim edges have been split at points somebody else computed must still be a
  // closed manifold, must carry those exact points in its ring, and must not
  // have moved anything else.
  {
    const plain = buildCorridorVessel('trench', spine(9, 0, false));
    if (plain.vessel === null) {
      bad.push('the reference trench did not build, so the rim cuts could not be checked');
    } else {
      const [left, right] = [0, 1] as const;
      const at = (rib: number, side: 0 | 1, t: number): RimCut => {
        // The midpoint of the edge, composed the way `world/seam.ts` composes a
        // lattice crossing: interpolate, and hand the vessel the number rather
        // than a rule for finding it again.
        const v = plain.vessel!.position;
        const seam = plain.vessel!.ribSeam!;
        const ai = seam[rib * 2 + side];
        const bi = seam[(rib + 1) * 2 + side];
        return {
          rib, side, t,
          x: v[ai * 3] + (v[bi * 3] - v[ai * 3]) * t,
          y: v[ai * 3 + 1] + (v[bi * 3 + 1] - v[ai * 3 + 1]) * t,
          z: v[ai * 3 + 2] + (v[bi * 3 + 2] - v[ai * 3 + 2]) * t,
        };
      };
      const cuts = [at(0, right, 0.25), at(0, right, 0.75), at(3, left, 0.5), at(7, left, 0.5)];
      const split = buildCorridorVessel('trench', spine(9, 0, false), cuts);
      if (split.vessel === null) {
        bad.push(`a trench with four rim cuts did not build: ${split.faults.join('; ')}`);
      } else {
        const r = checkManifold(split.vessel);
        if (r.faults.length) bad.push(`a trench with four rim cuts is not closed: ${r.faults.join('; ')}`);
        if (r.genus !== 0) bad.push('a trench with four rim cuts is no longer a sphere');
        if (split.vessel.rim.length !== plain.vessel.rim.length + 4) {
          bad.push(
            `the cut rim has ${split.vessel.rim.length} vertices, expected ` +
              `${plain.vessel.rim.length + 4}`,
          );
        }
        // The cuts are in the ring, at the coordinates that were handed in --
        // bit for bit, because a value that arrives and is then recomputed is
        // two values.
        const inRing = new Set<string>();
        for (const i of split.vessel.rim) {
          const p = split.vessel.position;
          inRing.add(`${p[i * 3]},${p[i * 3 + 1]},${p[i * 3 + 2]}`);
        }
        for (const c of cuts) {
          if (!inRing.has(`${c.x},${c.y},${c.z}`)) {
            bad.push(`a rim cut at ${c.x.toFixed(3)}, ${c.z.toFixed(3)} is not in the ring it was cut into`);
          }
        }
        if (ringSelfIntersects(split.vessel.position, split.vessel.rim)) {
          bad.push('the cut rim ring crosses itself, so the cuts went in out of order');
        }
        if (!(ringArea(split.vessel.position, split.vessel.rim) > 0)) {
          bad.push('the cut rim ring is not counter-clockwise in plan');
        }
      }
      // A cut that lands exactly on an existing vertex is dropped rather than
      // welded later: `t` at the ends is the caller asking for a vertex that is
      // already there.
      const degenerate = buildCorridorVessel('trench', spine(9, 0, false), [at(0, right, 1e-7)]);
      if (degenerate.vessel === null || checkManifold(degenerate.vessel).faults.length) {
        bad.push('a rim cut very close to an end broke the vessel');
      }
    }
  }

  // --- The transition rib, which is Phase 3's enabling change.
  //
  // Phase 1 wrote this down as the thing that could not be done and would have
  // to be: *"a profile cannot change topology mid-sweep... Phase 3 needs a
  // transition rib, a stitch between two different polygons at one station,
  // emitted into the same mesh so the two share vertices by index."* The polygon
  // used here is the one Phase 1 named -- a cutting that grows a platform deck
  // for part of its length and loses it again -- because a case invented to suit
  // the mechanism would prove nothing about the case that motivated it.
  //
  // Four claims, and the fourth is the one that matters: the alternative
  // (two meshes meeting at coincident coordinates) is **caught**, so "they share
  // vertices by index" is a property this check can tell apart from its
  // counterfeit rather than a sentence in a comment.
  {
    /** The eight-point `U`, and the ten-point `U` with a platform shelf in it. */
    const ribAt = (i: number, deck: boolean): Rib => {
      const railY = -50 - i * 0.08;
      const g = railY + 3.2;
      const p = trenchProfile(-7.4, 9.4, railY, g, g + 0.8);
      if (!deck) return { cx: i * 8, cz: 0, ux: 1, uz: 0, loops: p.loops, seam: p.seam };
      const u = p.loops[0];
      const floor = u[5 * 2 + 1];
      const deckY = floor + 1.05;
      const backO = u[3 * 2] - 0.2;
      const edgeO = backO - 3.0;
      const loop = new Float64Array([
        u[0], u[1], u[2], u[3], u[4], u[5], u[6], u[7],
        backO, deckY,
        edgeO, deckY,
        edgeO, floor,
        u[5 * 2], u[5 * 2 + 1],
        u[6 * 2], u[6 * 2 + 1],
        u[7 * 2], u[7 * 2 + 1],
      ]);
      return { cx: i * 8, cz: 0, ux: 1, uz: 0, loops: [loop], seam: [9, 2] };
    };
    const ribs: Rib[] = [];
    for (let i = 0; i < 10; i++) ribs.push(ribAt(i, i >= 3 && i <= 6));
    const build = buildVessel('trench', ribs);
    if (build.vessel === null) {
      bad.push(`a cutting that grows a platform deck did not build: ${build.faults.join('; ')}`);
    } else {
      const v = build.vessel;
      const r = checkManifold(v);
      // 1. It is one closed solid, and one *component*: a stitch, not two meshes
      //    that happen to be in the same arrays.
      if (r.faults.length) bad.push(`a sweep across two transition ribs is not closed: ${r.faults.join('; ')}`);
      if (r.components !== 1) bad.push(`a sweep across two transition ribs has ${r.components} components, so it is not stitched`);
      if (r.genus !== 0) bad.push('a sweep across two transition ribs is not topologically a sphere');
      // 2. The profile really did change, so the check is not vacuous.
      const strides = new Set<number>();
      for (let i = 0; i < v.ribCount; i++) strides.add(v.ribOffset[i + 1] - v.ribOffset[i]);
      if (strides.size !== 2) bad.push(`the transition test has ${strides.size} distinct rib sizes, so nothing transitioned`);
      // 3. The rim does not know it happened: two vertices per rib, simple,
      //    counter-clockwise, and every one of them a vertex the faces use.
      if (v.rim.length !== 20) bad.push(`the rim across a transition has ${v.rim.length} vertices, expected 20`);
      if (!(ringArea(v.position, v.rim) > 0)) bad.push('the rim across a transition is not counter-clockwise in plan');
      if (ringSelfIntersects(v.position, v.rim)) bad.push('the rim across a transition crosses itself');
      const used = new Set<number>(v.index);
      if (![...v.rim].every((i) => used.has(i))) bad.push('a rim vertex across a transition is used by no face');
      // ...and a rim cut lands on a transition segment's own seam edge, which is
      // a cross edge of the zip and cannot be merged into the walk the way an
      // along edge can. It goes in by splitting the two faces that share it.
      const seam = v.ribSeam!;
      const cutAt = (rib: number, side: 0 | 1, t: number): RimCut => {
        const a = seam[rib * 2 + side];
        const b = seam[(rib + 1) * 2 + side];
        return {
          rib, side, t,
          x: v.position[a * 3] + (v.position[b * 3] - v.position[a * 3]) * t,
          y: v.position[a * 3 + 1] + (v.position[b * 3 + 1] - v.position[a * 3 + 1]) * t,
          z: v.position[a * 3 + 2] + (v.position[b * 3 + 2] - v.position[a * 3 + 2]) * t,
        };
      };
      const withCuts = buildVessel('trench', ribs, [cutAt(2, 1, 0.4), cutAt(2, 0, 0.6), cutAt(6, 1, 0.5)]);
      if (withCuts.vessel === null) {
        bad.push(`three rim cuts on transition segments did not build: ${withCuts.faults.join('; ')}`);
      } else {
        const rc = checkManifold(withCuts.vessel);
        if (rc.faults.length) bad.push(`a transition with rim cuts in its seam edges is not closed: ${rc.faults.join('; ')}`);
        if (withCuts.vessel.rim.length !== 23) {
          bad.push(`the cut rim across a transition has ${withCuts.vessel.rim.length} vertices, expected 23`);
        }
        if (ringSelfIntersects(withCuts.vessel.position, withCuts.vessel.rim)) {
          bad.push('the cut rim across a transition crosses itself, so the cuts went in out of order');
        }
      }
      // 4. **The counterfeit, refused.** The obvious alternative to a transition
      //    rib is two vessels butted together at one station, which look
      //    identical from outside and are two surfaces meeting at coincident
      //    coordinates -- exactly the unwelded seam this whole design exists to
      //    abolish. Built here and asserted to fail, so the claim above is a
      //    distinction the check can actually draw.
      const first = buildVessel('trench', ribs.slice(0, 4));
      const second = buildVessel('trench', ribs.slice(3));
      if (first.vessel === null || second.vessel === null) {
        bad.push('the two halves of the transition control did not build');
      } else {
        const a = first.vessel;
        const b = second.vessel;
        const position = new Float64Array(a.position.length + b.position.length);
        position.set(a.position, 0);
        position.set(b.position, a.position.length);
        const index = new Uint32Array(a.index.length + b.index.length);
        index.set(a.index, 0);
        for (let i = 0; i < b.index.length; i++) index[a.index.length + i] = b.index[i] + a.position.length / 3;
        const control = checkManifold({ position, index });
        if (control.duplicateVertices === 0) {
          bad.push('two vessels butted at one rib left no duplicated positions, so the control is not a control');
        }
        if (control.faults.length === 0) {
          bad.push('two vessels butted at one rib passed checkManifold, so a transition rib buys nothing');
        }
      }
    }
  }

  // The fold, detected. A 5.4 m half-width on a 4 m radius curve must be
  // refused, or Phase 2 will draw a wall through itself at every tight junction.
  const tight = buildCorridorVessel('trench', spine(6, 1 / 4, false));
  if (tight.vessel !== null || !tight.faults.some((f) => f.startsWith('FOLD'))) {
    bad.push('a corridor turning tighter than it is wide was not reported as a fold');
  }

  // The negative controls. Each breaks one thing; each must be caught.
  const sound = buildCorridorVessel('trench', spine(9, 0, false)).vessel;
  if (sound === null) {
    bad.push('the reference trench did not build, so the negative controls could not run');
  } else {
    const controls: Array<[string, { position: Float64Array; index: Uint32Array }]> = [
      ['a punched hole', punchHole(sound, 5)],
      ['a flipped face', flipFace(sound, 5)],
      ['an unwelded vertex', splitVertex(sound, 5)],
      ['a collapsed face', collapseFace(sound, 5)],
    ];
    for (const [name, broken] of controls) {
      const r = checkManifold(broken);
      if (r.faults.length === 0) bad.push(`checkManifold passed ${name}, so it is not checking anything`);
    }
    // ...and specifically the right thing, so a control cannot pass by
    // accidentally tripping a different fault.
    if (checkManifold(punchHole(sound, 5)).boundaryEdges !== 3) {
      bad.push('punching one triangle out did not leave exactly three boundary edges');
    }
    if (checkManifold(flipFace(sound, 5)).nonManifoldEdges !== 3) {
      bad.push('flipping one face did not leave exactly three doubled directed edges');
    }
    if (checkManifold(splitVertex(sound, 5)).duplicateVertices !== 1) {
      bad.push('splitting one vertex did not leave exactly one duplicated position');
    }
    if (checkManifold(collapseFace(sound, 5)).degenerateFaces !== 1) {
      bad.push('collapsing one face did not leave exactly one degenerate face');
    }
    // And the check does not cry wolf: the sound vessel passes.
    if (checkManifold(sound).faults.length !== 0) bad.push('the reference trench failed its own check');
  }

  return bad;
}
