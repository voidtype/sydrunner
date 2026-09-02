/**
 * Drawing the walls that are not drawn yet.
 *
 * ---------------------------------------------------------------------------
 * ## Why an overlay rather than a fix
 *
 * `world/invisible-walls.ts` has classified this state per tile since the round
 * that named it: a tile whose collision is resident and whose geometry is not is
 * a block of city that is *solid and invisible*, and both maps hatch it amber.
 * That is the right answer on a map and it is the wrong answer in the world. A
 * player who has just been stopped by nothing does not open the map; they push
 * against it, decide the game is broken, and write the bug report that says
 * "invisible wall" and nothing else. The hatch tells somebody who already knows
 * to look.
 *
 * `client/src/world/collision-window-check.ts` measures how much of this is
 * left, and the answer on the routes and links it runs is *a fraction of a
 * second a leg, with one real wall at a cold boot in Cammeray*. That number is
 * the argument for this file rather than against it. A residual measured in
 * tenths of a second is exactly the kind that cannot be caught by staring: it is
 * rare enough that nobody reproduces it on demand and frequent enough that
 * players hit it. Drawing it makes every occurrence self-evident at the moment
 * it happens, to the player and to whoever they send the screenshot to -- and it
 * turns "there is an invisible wall at Chatswood" into "there is a grey box
 * where the building goes, for half a second, at Chatswood", which is a bug
 * report with the cause in it.
 *
 * It is also the honest half of the trade the rest of the workstream refused to
 * make. The client *cannot* drop collision for a tile it has not drawn: the
 * server holds a whole hexagon of the same prisms and would refuse the move
 * anyway, so the wall would become a rubber-band. If the player must be stopped,
 * the least this client can do is show them what by.
 *
 * ---------------------------------------------------------------------------
 * ## What it draws, and why a box
 *
 * One translucent box per qualifying prism, spanning the prism's plan bounds and
 * its `[base, top]` band. Not the polygon: a prism is a simplified footprint of
 * four to sixteen vertices and extruding each one would mean a geometry per
 * prism, built on the frame the tile became a hazard -- which is a build queue,
 * on the frame the build queue is already behind. An `InstancedMesh` over one
 * unit box is a matrix write per prism and nothing else, and the shape is right
 * for what it has to say. This is not a *rendering* of the building; the real
 * one is a second away. It is a marker that reads, unmistakably, as *something
 * is here and it is not finished*, and a box reads that way where a plausible
 * extruded facade would read as a building with the textures missing.
 *
 * The material is flat, unlit, translucent, and does not write depth -- so the
 * boxes never occlude each other into a solid mass, never take part in the sun's
 * depth pass, and never make the street behind them darker. They are a wash, in
 * the same sense and for the same reason `HAZARD_FILL` is a wash on the map.
 *
 * The ink is `invisible-walls.HAZARD_INK.unbuilt`, imported and not chosen
 * again. The map already says amber for *this exact state* and a second colour
 * for the same fact on a different surface is the kind of drift that makes an
 * interface unlearnable.
 *
 * ---------------------------------------------------------------------------
 * ## Which prisms qualify, and when they retire
 *
 * Three conditions, and each of them is doing work:
 *
 *   1. **The prism is within `GHOST_RADIUS_M` of the camera.** The overlay is
 *      for the wall you are about to walk into, not for the four hundred
 *      buildings in the tile behind it. It is also what bounds the cost.
 *   2. **Its tile's collision is resident and its geometry is not** -- which is
 *      the definition of the state, asked through `InvisibleWalls.hazardAt` so
 *      that the box and the hatch cannot disagree about the same tile in the
 *      same frame.
 *   3. **It is not a soffit over the player's head.** A structural prism whose
 *      band is entirely above a standing body is one `CollisionWorld.resolve`
 *      walks *under*; drawing a grey box over the Western Distributor to warn
 *      about a wall that is not there is the lie `invisible-walls.ts` retired
 *      its magenta to stop telling.
 *
 * Retirement is condition 2 going false, and it happens on the frame the tile's
 * geometry commits, because that is the frame `TileStreamer.tilePhase` starts
 * answering `built`. There is no fade: a box that lingered over a building that
 * is now drawn would be an overlay lying in the other direction, and the whole
 * value of this thing is that it is never wrong about the present.
 *
 * ---------------------------------------------------------------------------
 * ## What it costs
 *
 * `refresh` runs at `REFRESH_HZ` and not per frame -- the state it draws changes
 * on the streamer's build queue, which turns over in tens of milliseconds at
 * best, so ten times a second is faster than the thing it is watching. One
 * refresh is a `prismsWithin` over the collision grid at `GHOST_RADIUS_M`, a
 * tile-cell lookup per prism, and a matrix write per survivor, capped at
 * `MAX_GHOSTS`. On a frame where nothing is a hazard -- which is almost all of
 * them -- the first `hazardAt` misses and the pass is over.
 *
 * The `InstancedMesh` is allocated once at `MAX_GHOSTS` and lives for the
 * session with only `count` moving. Re-allocating one on the frame a hazard
 * appeared would put a buffer upload on exactly the frame that is already late,
 * and hiding it between times would put it out of the boot's `compileAsync`
 * reach -- which for an instanced draw is the only warm-up there is. See the
 * constructor, which is where both halves of that are argued.
 */
import {
  BoxGeometry,
  Color,
  DoubleSide,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  type Object3D,
} from 'three/webgpu';

import type { Prism } from '../player/collision.ts';
import { HAZARD_INK } from './invisible-walls.ts';

/**
 * How far from the camera a wall is worth warning about, metres.
 *
 * Sixty. The overlay answers one question -- *what is stopping me* -- and it is
 * asked by somebody who has already stopped, so the useful range is the street
 * you are in and not the suburb. Sixty metres is about two blocks of terrace
 * frontage, so a player riding into an undrawn tile sees the boxes come up ahead
 * of them with time to steer rather than arriving inside a grey wall.
 *
 * It is deliberately far short of `invisible-walls.SCAN_RADIUS_M`, which is 920
 * and is right for a *map*: a map is a plan of the district and this is a thing
 * in the street. Widening this to match would put a few thousand boxes over a
 * cold CBD and turn the warning into the weather.
 */
const GHOST_RADIUS_M = 60;

/**
 * The most boxes drawn at once.
 *
 * Two hundred and fifty-six, and it is a cap rather than a budget: the count
 * inside 60 m of a body in the densest terrace in the build is a few dozen, so
 * this binds only in the one case it exists for -- a teleport into the middle of
 * the CBD with every tile in the ring unbuilt at once. There the honest
 * behaviour is to draw the nearest 256 and stop, because the two hundred and
 * fifty-seventh box is behind the two hundred and fifty-sixth and says nothing
 * a player can act on.
 *
 * Nearest-first, so the cap takes the ones furthest away. `prismsWithin` returns
 * in grid order and not in distance order, so the sort is real work -- over a
 * list this short it is microseconds, and without it the cap would drop
 * whichever prisms the broadphase happened to reach last, which could be the one
 * the player is pressed against.
 */
const MAX_GHOSTS = 256;

/** How often the set is recomputed. See the header on why this is not per frame. */
const REFRESH_HZ = 10;
const REFRESH_DT = 1 / REFRESH_HZ;

/**
 * How solid the wash is.
 *
 * The map's `HAZARD_FILL.unbuilt` is 0.30 and this is 0.28, which is the same
 * number rather than a coincidence: the two surfaces are saying the same thing
 * and a player who has seen one should recognise the other. It is low on
 * purpose. The box has to read as *a marker over a place* and not as a building
 * -- at 0.6 an undrawn terrace row is a grey city, which is a different and
 * more convincing lie than the one it is here to correct.
 */
const GHOST_OPACITY = 0.28;

/**
 * How much of a body has to be inside a prism's band before it is drawn, metres.
 *
 * A body is `[feetY, feetY + 1.8]` and a prism blocks it when the two intervals
 * overlap -- `player/collision.resolve`'s rule exactly. This overlay asks the
 * same question with a margin, because it is answering it about a body that is
 * *moving*: a prism whose soffit clears the head by five centimetres is one the
 * player walks under this frame and is stopped by on the next slope. Half a
 * metre of slack draws it in both cases, and drawing a box the player then walks
 * under is a much cheaper mistake than the reverse.
 */
const BAND_SLACK_M = 0.5;

/** A standing body, for the band test. `collision.BODY_HEIGHT_M`, not imported
 * separately so this file states the body it is drawing for. */
const BODY_M = 1.8;

/**
 * The map's ink as a three colour, with the alpha left behind.
 *
 * `HAZARD_INK` is written for a 2D canvas and is the single source for what this
 * state looks like on every surface -- see the header on why a second amber
 * would be worse than a parse. Non-rgba input falls through to `Color`'s own
 * parser, which handles hex and the CSS names, so this narrows the string it was
 * given rather than replacing the general case.
 */
function inkColour(css: string): Color {
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(css);
  if (m === null) return new Color(css);
  return new Color(Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255);
}

/** The slice of `TileStreamer` this needs, so a check can hand one in. */

/** The slice of `CollisionWorld` this needs. */
export interface GhostPrisms {
  prismsWithin(x: number, z: number, radius: number, out: Prism[]): Prism[];
}

/** The slice of `InvisibleWalls` this needs: is this point in an undrawn tile? */
export interface GhostTiles {
  hazardAt(x: number, z: number): string | null;
}

/**
 * Does this prism qualify as a wall nobody can see?
 *
 * Exported and pure, because it is the whole rule and the whole rule is what a
 * check can hold still. Every argument is a number or a record; nothing here
 * touches the scene, the clock, or three.
 *
 * `feetY` is the *body's* feet and not a probe height -- unlike
 * `CollisionWorld.resolve`'s caller, which lifts by the step it may climb. The
 * difference matters at a kerb: a 0.3 m kerb is inside the step and is not a
 * wall, so lifting the feet here as well would draw a box over every gutter in
 * an unbuilt tile. See `BAND_SLACK_M` for the other end.
 */
export function ghostQualifies(
  prism: Prism,
  feetY: number,
  hazard: string | null,
): boolean {
  if (hazard === null) return false;
  // The body's band against the prism's, `resolve`'s rule with slack on both
  // ends. A prism whose top is under the feet is something to stand on and a
  // prism whose base is over the head is something to walk under; neither is a
  // wall and neither gets a box.
  if (prism.top <= feetY + BAND_SLACK_M) return false;
  if (prism.base >= feetY + BODY_M + BAND_SLACK_M) return false;
  return true;
}

/**
 * The undrawn walls near the camera, as boxes.
 *
 * One of these lives for the session. `main.ts` builds it beside `InvisibleWalls`
 * -- they answer the same question on two surfaces and share the residency scan
 * through `hazardAt`.
 */
export class WallGhosts {
  readonly mesh: InstancedMesh;
  private readonly geometry: BoxGeometry;
  private readonly material: MeshBasicNodeMaterial;
  /** Scratch: the prisms in reach, and the matrix written into the instance. */
  private readonly near: Prism[] = [];
  private readonly order: Array<{ prism: Prism; d2: number }> = [];
  private readonly matrix = new Matrix4();
  private clock = REFRESH_DT;
  private drawn = 0;
  private capped = 0;

  constructor(
    scene: Object3D,
    private readonly collision: GhostPrisms,
    private readonly tiles: GhostTiles,
  ) {
    // A unit box centred on its own origin in x and z and sitting *on* zero in
    // y, so an instance matrix is one translate and one scale with no offset
    // arithmetic per prism. `translate` bakes the half-height in once, at
    // construction, rather than a thousand times a second.
    this.geometry = new BoxGeometry(1, 1, 1);
    this.geometry.translate(0, 0.5, 0);
    const material = new MeshBasicNodeMaterial();
    material.name = 'wall-ghost';
    // Unlit and amber, and the amber is the map's own -- see the header. The
    // alpha is dropped rather than carried: the map's 0.85 is a hatch stroke on
    // a flat panel and would be very nearly opaque as a volume in the street,
    // and `GHOST_OPACITY` is the number for this surface. Split here rather than
    // handed to `Color` as the whole `rgba(...)` string, which three parses
    // correctly and then warns about once per boot -- a console line every
    // session to say the file meant what it said.
    material.color = inkColour(HAZARD_INK.unbuilt);
    material.transparent = true;
    material.opacity = GHOST_OPACITY;
    // No depth write, so a stack of boxes reads as a stack rather than as one
    // solid, and so nothing drawn afterwards is occluded by a marker.
    material.depthWrite = false;
    // Both faces, because the player is very often *inside* one of these: a
    // prism you have been stopped by is one you are pressed against, and a
    // single-sided box would vanish the moment the near face went behind the
    // near plane -- which is the moment it is most wanted. `world/bike.ts`
    // refuses `DoubleSide` on a transparent material because it is two passes,
    // and that argument does not reach here: this is *one* `InstancedMesh`, so
    // two passes is two draw calls for the whole overlay, against 64 separate
    // materials there.
    material.side = DoubleSide;
    this.material = material;
    this.mesh = new InstancedMesh(this.geometry, this.material, MAX_GHOSTS);
    this.mesh.name = 'wall-ghosts';
    this.mesh.count = 0;
    // **Visible from construction, with nothing in it, and that is the warm-up.**
    //
    // `world/warmup.ts` states the rule this obeys: *no stand-in can warm an
    // instanced draw*, because three folds `object.uuid` into an instanced
    // render object's cache key -- so a stand-in `Mesh` over this geometry and
    // this material compiles a pipeline the real `InstancedMesh` will not use,
    // and the real one compiles its own on the frame it is first drawn. The
    // scene pass in `main.ts` is the only thing that can reach it, and
    // `_projectObject` returns early on `visible === false`. `DoorMarker` is the
    // cautionary case: constructed hidden, and both its pipelines compiled on
    // the frame a player first walked up to a train door.
    //
    // So the mesh is visible for the session and `count` is what moves. At zero
    // it is one render item that issues a draw of no instances, which is the
    // cheapest possible way to stay in the compile's reach -- and this overlay
    // is at zero for almost the whole of every session, which is exactly when a
    // freeze on first appearance would be least forgivable.
    this.mesh.visible = true;
    // Never in the sun's depth pass and never lit: it is a wash, and a marker
    // that cast a shadow would put a hole in the street under a building that
    // is not there.
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // The instance boxes are written per refresh and the mesh spans whatever the
    // player is standing in, so a bounding sphere computed once is wrong for
    // ever. Frustum culling off is the cheap correct answer for a mesh that is
    // empty almost always and never has more than 256 instances when it is not.
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  /**
   * Rescan. Called every frame from `main.ts`; runs on its own clock.
   *
   * The clock resets rather than subtracting the interval, on `Minimap.update`'s
   * argument: this is a picture of the present and a late frame has nothing to
   * catch up on.
   */
  update(dt: number, x: number, feetY: number, z: number): void {
    this.clock += dt;
    if (this.clock < REFRESH_DT) return;
    this.clock = 0;
    this.refresh(x, feetY, z);
  }

  /** The scan itself, exposed so a check can drive it without a clock. */
  refresh(x: number, feetY: number, z: number): void {
    this.order.length = 0;
    this.collision.prismsWithin(x, z, GHOST_RADIUS_M, this.near);
    for (const prism of this.near) {
      // The tile question first and the band question second, in that order: the
      // tile test is a `Map.has` on a string built from two floors and it
      // rejects every prism in the city on an ordinary frame, where the band
      // test is arithmetic that would run on all of them.
      const hazard = this.tiles.hazardAt(
        (prism.minX + prism.maxX) * 0.5,
        (prism.minZ + prism.maxZ) * 0.5,
      );
      if (!ghostQualifies(prism, feetY, hazard)) continue;
      const dx = Math.max(prism.minX - x, 0, x - prism.maxX);
      const dz = Math.max(prism.minZ - z, 0, z - prism.maxZ);
      this.order.push({ prism, d2: dx * dx + dz * dz });
    }

    this.capped = Math.max(0, this.order.length - MAX_GHOSTS);
    if (this.order.length > MAX_GHOSTS) {
      this.order.sort((a, b) => a.d2 - b.d2);
      this.order.length = MAX_GHOSTS;
    }

    for (let i = 0; i < this.order.length; i++) {
      const p = this.order[i].prism;
      const w = Math.max(0.2, p.maxX - p.minX);
      const d = Math.max(0.2, p.maxZ - p.minZ);
      const h = Math.max(0.2, p.top - p.base);
      this.matrix.makeScale(w, h, d);
      this.matrix.setPosition((p.minX + p.maxX) * 0.5, p.base, (p.minZ + p.maxZ) * 0.5);
      this.mesh.setMatrixAt(i, this.matrix);
    }
    this.drawn = this.order.length;
    // `count`, and never `visible` -- see the constructor. An instanced draw of
    // no instances is nothing; a hidden mesh is out of `compileAsync`'s reach.
    this.mesh.count = this.drawn;
    // Only when something is actually drawn: `needsUpdate` on an empty mesh
    // still costs a buffer upload, and this pass runs ten times a second for
    // the whole session with nothing in it.
    if (this.drawn > 0) this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** For `window.sydney.wallGhosts` and for the HUD. */
  stats(): { drawn: number; capped: number; radiusM: number; max: number; hz: number } {
    return { drawn: this.drawn, capped: this.capped, radiusM: GHOST_RADIUS_M, max: MAX_GHOSTS, hz: REFRESH_HZ };
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * Why there is no `wallGhostWarmupParts` here, when every other renderer in
 * `world/` has one.
 *
 * A stand-in cannot warm an instanced draw. `world/warmup.ts` states it and
 * `main.ts`'s parts list repeats it in the block that ends *"and **nothing
 * instanced**"*: three folds `object.uuid` into an instanced render object's
 * cache key, so a stand-in `Mesh` over this geometry and this material compiles
 * a pipeline the real `InstancedMesh` will never use, and the real one compiles
 * its own on the frame it is first drawn. Submitting one here would have made
 * this overlay *look* covered while leaving the freeze exactly where it was --
 * on the frame a player is first stopped by a wall that is not there, which is
 * the worst frame in the session to spend thirteen pipeline compiles on.
 *
 * The warm-up is the mesh being **visible from construction with `count = 0`**,
 * which puts it in the boot's `compileAsync` walk. See the constructor, where
 * that is argued at length. `perf-harness.ts --coverage` declares the group with
 * no parts and its draw lands in the "instanced draws skipped" count beside the
 * bikes, the crowd and the traffic -- named in the table, and honest about how
 * it is covered.
 */

/**
 * The self-check, in the client's boot list.
 *
 * Every failure here is silent in the game, which is the criterion this project
 * puts a `verify*` behind:
 *
 *   - A qualifier that never fires draws nothing, and an overlay that draws
 *     nothing is indistinguishable from an overlay with nothing to draw. That is
 *     this feature failing in exactly the state it exists for.
 *   - A qualifier that *always* fires draws a box over every building in the
 *     block for the second a tile takes to build, which is worse than the defect
 *     -- and it would only happen on the machines slow enough to have a window,
 *     which are the machines nobody develops on.
 *   - A band test that dropped the soffit rule puts a grey box over the Western
 *     Distributor and tells the player to go round a street they can walk down.
 *     `world/invisible-walls.ts` retired a whole colour to stop saying that.
 */
export function verifyWallGhosts(): string[] {
  const failures: string[] = [];
  const fail = (ok: boolean, msg: string): void => {
    if (!ok) failures.push(msg);
  };

  const prism = (base: number, height: number): Prism => ({
    points: new Float32Array([0, 0, 4, 0, 4, 4, 0, 4]),
    height,
    base,
    top: base + height,
    minX: 0,
    minZ: 0,
    maxX: 4,
    maxZ: 4,
    structural: false,
    seen: 0,
    carveStamp: 0,
  });

  // --- Condition 2: no hazard, no box, whatever the geometry says.
  fail(
    !ghostQualifies(prism(0, 20), 0, null),
    'A prism in a tile that is fully built was marked as an invisible wall. The overlay would ' +
      'draw a box over every building in the city.',
  );
  fail(
    ghostQualifies(prism(0, 20), 0, 'unbuilt'),
    'A twenty-metre building in an undrawn tile, with the body at its foot, did not qualify. ' +
      'This is the defect the overlay exists for and it would draw nothing.',
  );

  // --- Condition 3: the soffit. `decks.WALK_UNDER_M` is 2.6 m and a body is 1.8.
  fail(
    !ghostQualifies(prism(6.2, 1.15), 0, 'unbuilt'),
    'A viaduct deck with its soffit 6.2 m up was drawn as a wall over a body standing under it. ' +
      'CollisionWorld.resolve walks under that band and the overlay would be telling the player to ' +
      'go round a street they can walk down.',
  );
  fail(
    ghostQualifies(prism(2.0, 4), 0, 'unbuilt'),
    'A soffit two metres over the feet -- inside a 1.8 m body plus the slack -- was not drawn. ' +
      'That is a volume resolve blocks and the player would be stopped by nothing.',
  );

  // --- And the other end: a kerb is not a wall.
  fail(
    !ghostQualifies(prism(0, 0.3), 0, 'unbuilt'),
    'A 0.3 m kerb was drawn as an invisible wall. It is inside STEP_HEIGHT and is climbed, so the ' +
      'overlay would put a box along every gutter in an unbuilt tile.',
  );
  // A body standing on a roof is not inside the building it is standing on.
  fail(
    !ghostQualifies(prism(0, 10), 12, 'unbuilt'),
    'A body twelve metres up, standing over a ten-metre building, was told the roof under its feet ' +
      'is a wall in front of it.',
  );

  // --- The ink is the map's ink, and the drift this catches is a second amber.
  // The ink, through the same parse the material uses. A drift in `HAZARD_INK`'s
  // format is a silently black box rather than an amber one, and the failure has
  // no frame that says so.
  const ink = inkColour(HAZARD_INK.unbuilt);
  fail(
    ink.r > 0.5 && ink.g > 0.3 && ink.b < ink.r,
    `The hazard ink parsed to r=${ink.r.toFixed(2)} g=${ink.g.toFixed(2)} b=${ink.b.toFixed(2)}, which is ` +
      `not the warm amber "${HAZARD_INK.unbuilt}" the maps hatch with. The box and the hatch have drifted, ` +
      'or the parse has.',
  );

  fail(
    GHOST_RADIUS_M > 0 && GHOST_RADIUS_M <= 200 && MAX_GHOSTS >= 64,
    `The overlay draws ${MAX_GHOSTS} boxes within ${GHOST_RADIUS_M} m. Beyond a couple of hundred ` +
      'metres this is the weather rather than a warning; under 64 boxes a cold CBD caps immediately.',
  );

  return failures;
}
