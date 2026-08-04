/**
 * Water as a *gameplay* surface: where it is, how deep it is, and what that does
 * to a player standing in it.
 *
 * The rendering half of the water lives in `world/water.ts` and imports three.
 * This file must not, and does not import anything at all -- it is loaded by the
 * client and by the Bun server through the same path `game/combat.ts` is, and it
 * is the whole of what the two of them have to agree about. See `game/combat.ts`
 * for the three rules a shared module keeps; this one keeps all three.
 *
 * ---------------------------------------------------------------------------
 * **Nothing new goes over the wire, and that is the design constraint the shape
 * of this file comes from.**
 *
 * A wading player moves at 45% of their speed, so the client predicts a position
 * the server must reproduce exactly or reconciliation fights it every tick --
 * which reads as rubber-banding at every shoreline in the city. The two could be
 * kept in step by sending the water level in the input snapshot, and that is
 * both a protocol change and a client telling a server about the world.
 *
 * They do not need to be. Both ends already load `index.json` -- the client to
 * stream tiles, the server to find its collision payloads -- and the pipeline
 * writes each tile's water level into it as `wy`. So both ends build the *same*
 * table from the *same* file and evaluate the *same* pure function on it, which
 * is the same arrangement `CollisionWorld` and `TerrainField` already have for
 * the two other questions about the ground.
 *
 * ---------------------------------------------------------------------------
 * **One level per tile, and the level is a lookup rather than a sample.**
 *
 * A tile is 500 m and water is flat, so a tile's water is one number over its
 * whole extent -- `wy` is the surface of the largest sheet on it. Two things
 * follow, and both are deliberate:
 *
 *   * **Standing on dry land in a tile that has water in it still reports a
 *     water level.** That is harmless and is what makes this cheap: the depth is
 *     `surface - feet`, so a player on the Rocks 40 m above the harbour is 40 m
 *     *above* the water and wades through nothing. The level is only ever used
 *     as a comparison against where the feet are.
 *   * **A tile with a pond and a bay on it would report one of them.** No tile
 *     in this extent has both -- Centennial Park is 2.5 km from the harbour --
 *     and the pipeline's `water-audit` is what would say so.
 *
 * ---------------------------------------------------------------------------
 * **The deep-entry rule is a *rejection*, not a force.**
 *
 * Past `WADE_MAX_DEPTH` the step that would take the player deeper is undone and
 * their horizontal velocity is damped, rather than a push-back impulse being
 * added. A force would have to be tuned against the controller's acceleration to
 * avoid either oscillating or being walked through, and it would put a second
 * integrator in the loop; undoing the step cannot do either, and it is exactly
 * what `controller.step` already does to a player who walks into a wall.
 *
 * It is a *directional* rejection: a move that leaves the water deeper is
 * refused and a move that does not is allowed, so a player who fell off a wharf
 * can always walk back out. Without that the harbour would be flypaper.
 */

/**
 * How deep the water has to be before it slows anybody down, metres.
 *
 * Ankle depth. It is not zero for a reason that is about the *terrain* rather
 * than about wading: the pipeline cuts the bed to `water.SHORE_CLEARANCE_M`
 * (0.4 m) at the mapped shoreline and the lattice interpolates from there, so
 * the ground crosses the waterline somewhere inside a 31.25 m cell and a player
 * walking a harbour-front footpath can clip a few centimetres of it. Slowing
 * them to 45% for that would read as the pavement being sticky.
 */
export const WADE_START_DEPTH = 0.15;

/**
 * What wading does to the target speed.
 *
 * Applied to `InputSnapshot.speedScale`, which multiplies the *target* rather
 * than the acceleration or the friction -- see `player/controller.ts`, which
 * argues that out for spec 8.3's powerups and gets the same answer here. So a
 * wading player still accelerates and stops as sharply as they ever did; they
 * simply top out at 2.0 m/s walking instead of 4.4.
 *
 * It multiplies the powerup scale rather than replacing it, so a Flat White in
 * the shallows is fast for a wading player and slow for a running one, which is
 * the only composition of the two that is not a special case.
 */
export const WADE_SPEED_SCALE = 0.45;

/**
 * How deep a player may get, metres.
 *
 * Just over waist height on the 1.68 m eye height this game uses, which is where
 * walking stops working in life and swimming starts -- and swimming is a whole
 * feature (a stroke animation, a buoyancy integrator, a drowning rule, a network
 * flag) rather than a number. Stopping here is honest about that: the player
 * wades in until the water is at their waist and then cannot make progress,
 * which is what a person who cannot swim does.
 */
export const WADE_MAX_DEPTH = 1.2;

/**
 * What is left of the horizontal velocity after a step into deep water is
 * refused, per tick.
 *
 * A quarter, so a sprint bleeds off over about four ticks (67 ms) rather than
 * stopping dead -- a hard zero at the waist reads as an invisible wall, and this
 * reads as water. It is a multiplier per fixed step rather than a deceleration
 * so that it cannot overshoot into a reversal at any timestep.
 */
export const WADE_BLOCK_DAMPING = 0.25;

/** Nothing is known about the water here. Distinguished from "no water". */
export const NO_WATER = Number.NaN;

/**
 * Where the water surface is over a world point, from the index.
 *
 * A table rather than a query over the sheets: the sheets are geometry, they are
 * loaded only for the tiles the renderer wants, and the physics has a longer
 * reach than the renderer does -- which is the same argument `world/terrain.ts`
 * makes for holding every grid it has ever loaded. This is one float per wet
 * tile for the whole world, built once from `index.json` and never touched
 * again.
 */
export class WaterLevels {
  private readonly levels = new Map<string, number>();

  constructor(readonly tileSize: number) {}

  /**
   * Build from `index.json`'s tile list.
   *
   * Tiles with no `wy` are simply absent, which is the difference between "this
   * tile has no water" and "this tile's water is at y = 0" -- and y = 0 is a
   * perfectly plausible water level, 71 m over the datum's own ground, so the
   * two must not collapse. The pipeline omits the field rather than writing a
   * zero for exactly this reason.
   */
  static fromIndex(
    tiles: ReadonlyArray<{ key: string; wy?: number }>,
    tileSize: number,
  ): WaterLevels {
    const out = new WaterLevels(tileSize);
    for (const t of tiles) {
      if (typeof t.wy === 'number' && Number.isFinite(t.wy)) out.levels.set(t.key, t.wy);
    }
    return out;
  }

  get wetTiles(): number {
    return this.levels.size;
  }

  /**
   * The water surface height over a world point, or `NO_WATER`.
   *
   * The tile arithmetic is `TerrainField.height`'s, written out again here
   * because that file imports three and this one must not. The duplication is
   * three lines and is guarded rather than trusted: `verifyWading` checks the
   * keys this produces against hand-worked cases in all four quadrants, and
   * `water.verifyWater` checks them against `TerrainField`'s own answer for the
   * same points. World z runs *south* while ENU north does not, so `-z` is the
   * whole of what a second copy of this could get wrong -- and getting it wrong
   * puts the harbour 500 m from where it is drawn.
   */
  surfaceAt(x: number, z: number): number {
    const tx = Math.floor(x / this.tileSize);
    const tz = Math.floor(-z / this.tileSize);
    const level = this.levels.get(`${tx}_${tz}`);
    return level === undefined ? NO_WATER : level;
  }
}

/**
 * How deep the water is over a pair of feet, metres. Zero on dry land.
 *
 * `surfaceY` is `WaterLevels.surfaceAt` and may be `NO_WATER`; `feetY` is the
 * player's position minus their eye height, which is what every other ground
 * query in this project is given.
 */
export function waterDepth(surfaceY: number, feetY: number): number {
  if (!Number.isFinite(surfaceY)) return 0;
  const depth = surfaceY - feetY;
  return depth > 0 ? depth : 0;
}

/** The multiplier wading puts on the target ground speed. 1 on dry land. */
export function wadeSpeedScale(depth: number): number {
  return depth > WADE_START_DEPTH ? WADE_SPEED_SCALE : 1;
}

/**
 * Whether a step has to be refused: it ends past the ceiling *and* it went
 * deeper than it started.
 *
 * The second half is what keeps the rule an entry limit rather than a trap. The
 * epsilon is there so a player wading along a contour -- where the two depths
 * differ by float noise -- is not stopped by rounding.
 */
export function wadeBlocked(depthBefore: number, depthAfter: number): boolean {
  return depthAfter > WADE_MAX_DEPTH && depthAfter > depthBefore + 1e-4;
}

/**
 * Self-check, in the same spirit as `verifyMovementBasis` and `verifyCombat`:
 * every way this breaks is silent.
 *
 * A tile lookup with the z sign the wrong way round puts the water on the tile
 * 500 m north of the one it is drawn on, and the symptom is a player wading
 * through a car park in Pyrmont and running across Darling Harbour. A depth that
 * counts downward slows the player everywhere *except* in the water. A block
 * rule without the direction test makes the harbour flypaper. None of the three
 * throws, and none of them has a frame that says so.
 */
export function verifyWading(): string[] {
  const failures: string[] = [];

  // --- The tile keying, in all four quadrants. World x runs east and world z
  // runs *south*, so a point at negative z is at positive tz.
  const levels = WaterLevels.fromIndex(
    [
      { key: '0_0', wy: -71 },
      { key: '1_1', wy: -70 },
      { key: '-1_-1', wy: -69 },
      { key: '-1_0', wy: -68 },
      { key: '3_2' },
    ],
    500,
  );
  const cases: Array<[number, number, number, string]> = [
    [10, -10, -71, 'just north-east of the origin is tile 0_0'],
    [510, -510, -70, 'half a kilometre north-east is tile 1_1'],
    [-10, 10, -69, 'just south-west of the origin is tile -1_-1'],
    [-10, -10, -68, 'north-west of the origin is tile -1_0'],
  ];
  for (const [x, z, want, label] of cases) {
    const got = levels.surfaceAt(x, z);
    if (got !== want) {
      failures.push(
        `WaterLevels.surfaceAt(${x}, ${z}) returned ${got}, expected ${want} -- ${label}. ` +
          `The tile keying disagrees with TerrainField's, which puts the water level ` +
          `one tile from the water.`,
      );
    }
  }
  if (Number.isFinite(levels.surfaceAt(1600, -1200))) {
    failures.push('A tile with no `wy` in the index reported a water level; it must report NO_WATER.');
  }
  if (Number.isFinite(levels.surfaceAt(9999, -9999))) {
    failures.push('A tile that is not in the index at all reported a water level.');
  }
  if (levels.wetTiles !== 4) {
    failures.push(`WaterLevels.fromIndex kept ${levels.wetTiles} tiles of the 4 that carry a level.`);
  }

  // --- Depth, which is measured from the *feet* and counts upward from them.
  if (waterDepth(NO_WATER, -5) !== 0) failures.push('Dry ground reported a depth.');
  if (waterDepth(0, 1) !== 0) failures.push('Feet above the surface reported a depth.');
  if (Math.abs(waterDepth(0, -0.8) - 0.8) > 1e-9) {
    failures.push(`Feet 0.8 m under the surface reported ${waterDepth(0, -0.8)} m of water.`);
  }

  // --- The speed rule.
  if (wadeSpeedScale(0) !== 1 || wadeSpeedScale(WADE_START_DEPTH) !== 1) {
    failures.push('Dry ground and ankle depth must not slow the player at all.');
  }
  if (wadeSpeedScale(0.5) !== WADE_SPEED_SCALE) {
    failures.push(`Knee-deep water scaled speed by ${wadeSpeedScale(0.5)}, not ${WADE_SPEED_SCALE}.`);
  }

  // --- The block rule, and the direction test that keeps it an entry limit.
  if (wadeBlocked(0.9, 1.1)) failures.push('A step that ends inside the wading limit was refused.');
  if (!wadeBlocked(1.1, 1.4)) {
    failures.push(`A step from ${1.1} m to ${1.4} m of water was allowed; the ceiling is ${WADE_MAX_DEPTH} m.`);
  }
  if (wadeBlocked(2.0, 1.5)) {
    failures.push(
      'A step *out* of deep water was refused. The rule has to be directional or a player ' +
        'who fell off a wharf can never leave the harbour.',
    );
  }
  if (wadeBlocked(2.0, 2.0)) {
    failures.push('A step along a constant depth was refused; only going deeper may be.');
  }

  return failures;
}
