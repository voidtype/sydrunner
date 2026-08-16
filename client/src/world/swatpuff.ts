/**
 * The puff of contact where a bat middles a football.
 *
 * The picture half of `game/swat.ts`. A swat is over in one tick: the ball's
 * velocity turns round, the crack plays, and the only thing on screen that says
 * anything happened is that the ball is now going the other way. That is not
 * enough. At 42 m/s the ball crosses the whole 0.585 m sweep volume inside two
 * frames, so a player watching a returned serve sees a ball apparently change
 * its mind in mid-air -- and the difference between "I hit that" and "that
 * bounced off something" is a mark at the point of contact.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS TWELVE TRIANGLES AND NOT A PARTICLE SYSTEM
 *
 * There is no particle system in this renderer and this is not the feature that
 * should introduce one. A general emitter means a per-frame CPU update over a
 * pool of quads, a billboard matrix each, a sorted transparent draw and a
 * lifetime allocator -- and the first thing to use it would be an effect that
 * happens a few times a minute and is over in a quarter of a second.
 *
 * So it is a **spike burst**: one static geometry of twelve thin triangles, each
 * pointing outward from the origin along a direction off a Fibonacci sphere, and
 * the whole mesh is scaled up and faded out over `PUFF_SECONDS`. The animation is
 * two scalars a frame. Three of them exist, pooled, because two swats inside a
 * quarter of a second is a rally and a third overlapping one is not something
 * this game can produce.
 *
 * **Three-dimensional rather than billboarded**, which is the one decision here
 * that could have gone the other way. A billboard always faces the camera and
 * always reads, and it also needs the camera every frame and looks identical
 * from every angle -- which for a burst that marks a *point in space* is the
 * wrong property: the swinger and the thrower are looking at the same puff from
 * opposite sides and it should tell them the same thing about where it is. A
 * spike sphere has no bad angle because it has no plane, and it costs the same.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS UNLIT AND ADDITIVE
 *
 * `world/contact.ts` states the general rule -- an overlay is not a surface --
 * and this is the loudest case of it: a puff is a *flash*, which is light rather
 * than an object with light falling on it. Additive over whatever is behind it,
 * no depth write so two spikes do not occlude each other, and `toneMapped` off
 * so it stays the same brightness against a sunlit footpath (Y' 247) and against
 * a terrace's shadow, which is the whole reason it is legible at all. It is the
 * same set of five flags `world/bike.ts` sets on its glow and `doormarker.ts` on
 * its ring; nothing here is novel except the geometry.
 *
 * Depth **testing** is kept, unlike a HUD overlay: a puff behind a wall must be
 * behind the wall. It is 25 cm across at its largest and the ball it marks is
 * already depth-tested, so the two agree.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Mesh,
  MeshBasicNodeMaterial,
} from 'three/webgpu';

/** How long one puff lives, seconds. */
export const PUFF_SECONDS = 0.26;

/**
 * How many puffs can be alive at once.
 *
 * Three. A swat is one event per swing per tick and a swing is 500 ms, so three
 * overlapping puffs needs three players middling three different balls inside a
 * quarter of a second within sight of each other. When it does happen the oldest
 * is stolen, which is the right failure: the newest event is the one the player
 * is looking for.
 */
const POOL = 3;

/** How many spikes in the burst, and how long each is at unit scale. */
const SPIKES = 12;
const SPIKE_INNER = 0.05;
const SPIKE_OUTER = 0.22;
/** Half the angular width of a spike at its base, as a fraction of its length. */
const SPIKE_WIDTH = 0.05;

/** The scale the burst runs between over its life. */
const SCALE_FROM = 0.55;
const SCALE_TO = 1.5;

/**
 * Pale willow-white with a warm cast, and brighter than any albedo in the world.
 *
 * A contact flash is not a colour anything in Sydney is; what it has to be is
 * *lighter than the pavement*, which `world/contact.ts` measures at Y' 247 in
 * sun. Additive blending on top of that needs real headroom, so this sits well
 * over 1 and the tone mapper is switched off rather than asked to cope.
 */
const FLASH: [number, number, number] = [1.9, 1.75, 1.35];

/**
 * A sphere of `n` roughly even directions, without a `Math.random` anywhere.
 *
 * The Fibonacci spiral, which `world/vegetation.ts` uses for the same reason one
 * object up: it is a closed form, it is the same twelve directions in every
 * process and every session, and the alternative -- a random draw at
 * construction -- would make a puff that is a different shape on two machines
 * looking at the same swat. Nothing here is on the wire, so that is a
 * consistency of *look* rather than of simulation, and it is free.
 */
function directions(n: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    // y walks evenly from +1 to -1 and the radius follows the circle, which is
    // what makes the points equal-area rather than bunched at the poles.
    const y = 1 - (2 * i) / (n - 1);
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = golden * i;
    out.push([Math.cos(a) * r, y, Math.sin(a) * r]);
  }
  return out;
}

/**
 * The burst geometry: one thin triangle per direction, tip outward.
 *
 * Built once and shared by every puff in the pool, on `player/bat.ts`'s contract
 * -- a pooled instance never disposes it, because the other two are drawing it.
 *
 * Each spike's base is two points either side of its direction, taken across an
 * axis that is guaranteed not to be parallel to it: the cross with world up,
 * falling back to world forward for the two spikes that *are* vertical. Without
 * the fallback those two collapse to zero-area triangles and the burst has a
 * visible hole at the top and the bottom, which is the kind of thing that only
 * shows up in one screenshot out of ten.
 */
function burstGeometry(): BufferGeometry {
  const position: number[] = [];
  const normal: number[] = [];
  const colour: number[] = [];
  for (const [dx, dy, dz] of directions(SPIKES)) {
    // An axis across the spike. `up x d` is zero when d is vertical.
    let ax = -dz;
    let ay = 0;
    let az = dx;
    const alen = Math.sqrt(ax * ax + ay * ay + az * az);
    if (alen < 1e-4) {
      ax = 1;
      ay = 0;
      az = 0;
    } else {
      ax /= alen;
      ay /= alen;
      az /= alen;
    }
    const w = SPIKE_OUTER * SPIKE_WIDTH;
    // Tip, then the two base corners. Wound so the front face points along the
    // spike's own cross product; the material is `DoubleSide` regardless,
    // because a burst is seen from inside as well as outside and a culled spike
    // is a hole.
    const tri: Array<[number, number, number]> = [
      [dx * SPIKE_OUTER, dy * SPIKE_OUTER, dz * SPIKE_OUTER],
      [dx * SPIKE_INNER + ax * w, dy * SPIKE_INNER + ay * w, dz * SPIKE_INNER + az * w],
      [dx * SPIKE_INNER - ax * w, dy * SPIKE_INNER - ay * w, dz * SPIKE_INNER - az * w],
    ];
    for (const [x, y, z] of tri) {
      position.push(x, y, z);
      // Unlit, so the attribute is never read for shading -- it is here because
      // three warns on a geometry without one and because the shadow pass's
      // `normalBias` would read it if this ever cast, which it never will.
      normal.push(dx, dy, dz);
      colour.push(FLASH[0], FLASH[1], FLASH[2]);
    }
  }
  const g = new BufferGeometry();
  g.name = 'swat_puff';
  g.setAttribute('position', new BufferAttribute(new Float32Array(position), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(normal), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(colour), 3));
  g.computeBoundingSphere();
  return g;
}

/** One live puff: a mesh, how long it has left, and whether it has been drawn. */
interface Live {
  mesh: Mesh;
  t: number;
  /**
   * False until this puff has survived one `update` without ageing. See there.
   *
   * The whole of a fix for a bug that is invisible until it is looked for:
   * `main.ts` clamps its frame delta at **0.25 s** and `PUFF_SECONDS` is 0.26,
   * so a puff born on a slow frame is retired by that same frame's own `update`
   * and is never drawn at all. A slow frame is not exotic here -- it is a shader
   * compile, a tile decode or a GC pause, and the *first* swat of a session is
   * the frame that compiles this material's pipeline. The symptom would be that
   * the effect works every time except the first, which is the time anybody
   * would be looking.
   */
  drawn: boolean;
}

/**
 * Every contact puff in the world, which is at most three.
 *
 * One of these, owned by `main.ts`, added to the scene once. `fire` puts one at a
 * point and `update` ages them; there is no disposal path per puff because there
 * is nothing to dispose -- the meshes are made in the constructor and reused for
 * the life of the session, which is the same arrangement `world/nameplates.ts`
 * makes for the same reason.
 */
export class SwatPuffs {
  readonly meshes: readonly Mesh[];
  private readonly live: Live[] = [];
  private readonly geometry: BufferGeometry;
  private readonly material: MeshBasicNodeMaterial;

  constructor() {
    this.geometry = burstGeometry();

    // One material for all three, which means one opacity for all three -- see
    // `update`, where the fade is driven off the *oldest* live puff. Three
    // materials would be three WebGPU pipelines compiled the first time anybody
    // swats anything, which is a hitch on the most satisfying frame in the game.
    const material = new MeshBasicNodeMaterial();
    material.name = 'swat_puff';
    material.vertexColors = true;
    material.transparent = true;
    material.depthWrite = false;
    material.blending = AdditiveBlending;
    material.side = DoubleSide;
    material.fog = false;
    material.toneMapped = false;
    material.opacity = 0;
    this.material = material;

    const meshes: Mesh[] = [];
    for (let i = 0; i < POOL; i++) {
      const mesh = new Mesh(this.geometry, material);
      mesh.name = `swat_puff_${i}`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // Not frustum-culled, on `doormarker.ts`'s argument exactly: the bounding
      // sphere is the geometry's own and is centred on the origin, so three
      // would test a sphere that is always at (0, 0, 0) rather than where the
      // mesh has been moved to. Twelve triangles, three of them.
      mesh.frustumCulled = false;
      mesh.visible = false;
      meshes.push(mesh);
    }
    this.meshes = meshes;
  }

  /** Put a puff at a world point. Steals the oldest when all three are alive. */
  fire(x: number, y: number, z: number): void {
    let mesh: Mesh | undefined;
    if (this.live.length < POOL) {
      mesh = this.meshes[this.live.length];
    } else {
      // The oldest -- largest `t` -- because the newest event is the one the
      // player is trying to see.
      let oldest = 0;
      for (let i = 1; i < this.live.length; i++) {
        if (this.live[i].t > this.live[oldest].t) oldest = i;
      }
      mesh = this.live[oldest].mesh;
      this.live.splice(oldest, 1);
    }
    mesh.position.set(x, y, z);
    mesh.scale.setScalar(SCALE_FROM);
    mesh.visible = true;
    this.live.push({ mesh, t: 0, drawn: false });
  }

  /**
   * Age every live puff. Frame delta, not the fixed step.
   *
   * `main.ts`'s rule about presentation: the simulation is fixed so prediction
   * and rewind agree, and a fade has to be smooth at whatever rate the display
   * runs.
   *
   * The opacity is the **shortest-lived** puff's, because one material serves all
   * three -- see the constructor. That is visibly wrong only in the case where
   * two puffs are alive at different ages, where the older one holds its
   * brightness a few frames longer than it should. Three pipelines to fix a
   * quarter-second discrepancy in a case that needs two swats inside 260 ms was
   * not the trade.
   */
  update(dt: number): void {
    if (this.live.length === 0) return;
    let youngest = 1;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      // **A puff does not age on the frame it was fired.** See `Live.drawn`: the
      // frame delta is clamped at 0.25 s and this lives for 0.26, so ageing a
      // brand-new puff by the frame it was born on can retire it before the
      // render at the end of that same frame ever draws it. One frame at full
      // brightness is guaranteed instead, which costs at most one extra frame of
      // puff on a display running normally -- 16 ms of a 260 ms effect.
      if (!p.drawn) {
        p.drawn = true;
      } else {
        p.t += dt;
      }
      if (p.t >= PUFF_SECONDS) {
        p.mesh.visible = false;
        this.live.splice(i, 1);
        continue;
      }
      const k = p.t / PUFF_SECONDS;
      p.mesh.scale.setScalar(SCALE_FROM + (SCALE_TO - SCALE_FROM) * k);
      if (k < youngest) youngest = k;
    }
    // Quadratic rather than linear: a flash is bright for an instant and then is
    // essentially gone, and a linear fade over a quarter of a second reads as a
    // sprite dissolving rather than as an impact.
    this.material.opacity = this.live.length === 0 ? 0 : (1 - youngest) * (1 - youngest);
  }

  /** How many are alive. For the console handle and for `verifySwatPuff`. */
  get count(): number {
    return this.live.length;
  }
}

/**
 * The three ways this fails while rendering a perfectly good frame.
 *
 *   - **A spike with no area.** The two vertical directions on the Fibonacci
 *     sphere have a zero cross product with world up, and without the fallback in
 *     `burstGeometry` they collapse -- so the burst has a hole at the top and the
 *     bottom that is invisible from most angles and obvious from one.
 *   - **A pool that leaks.** A puff that is never retired leaves a mesh visible
 *     at the point of an impact that happened a minute ago, and after three of
 *     them nothing new is ever drawn. The symptom is that the effect works
 *     exactly three times a session.
 *   - **An opacity that never returns to zero.** Additive and never fully faded
 *     is a permanent bright smudge hanging in a street, which nothing else in
 *     the frame explains.
 *
 *     bun -e "import {verifySwatPuff} from './client/src/world/swatpuff.ts';
 *             console.log(verifySwatPuff())"
 */
export function verifySwatPuff(): string[] {
  const failures: string[] = [];
  const puffs = new SwatPuffs();

  // --- Every spike has area. Measured off the buffer rather than off
  // `directions`, so it tests the geometry that is drawn.
  {
    const mesh = puffs.meshes[0];
    const position = mesh.geometry.getAttribute('position');
    let degenerate = 0;
    for (let i = 0; i + 2 < position.count; i += 3) {
      const ax = position.getX(i + 1) - position.getX(i);
      const ay = position.getY(i + 1) - position.getY(i);
      const az = position.getZ(i + 1) - position.getZ(i);
      const bx = position.getX(i + 2) - position.getX(i);
      const by = position.getY(i + 2) - position.getY(i);
      const bz = position.getZ(i + 2) - position.getZ(i);
      const cx = ay * bz - az * by;
      const cy = az * bx - ax * bz;
      const cz = ax * by - ay * bx;
      if (Math.sqrt(cx * cx + cy * cy + cz * cz) < 1e-9) degenerate++;
    }
    if (degenerate > 0) {
      failures.push(
        `${degenerate} of ${position.count / 3} puff spikes have no area. The two directions that ` +
          `point straight up and straight down have a zero cross product with world up, and the ` +
          `burst is left with a hole at each pole.`,
      );
    }
  }

  // --- A puff survives the frame it was born on, however slow that frame was.
  //
  // `main.ts` clamps its frame delta at 0.25 s against this effect's 0.26 s
  // life, so without the `drawn` flag a puff fired during a shader compile, a
  // tile decode or a GC pause is retired by that frame's own `update` and is
  // never drawn. The first swat of a session is exactly that frame -- it is the
  // one that compiles this material's pipeline -- so the symptom is an effect
  // that works every time except the first.
  {
    puffs.fire(0, 0, 0);
    puffs.update(0.25);
    const material = puffs.meshes[0].material as MeshBasicNodeMaterial;
    if (puffs.count !== 1 || material.opacity < 0.9) {
      failures.push(
        `A puff fired on a 0.25 s frame was left at opacity ${material.opacity.toFixed(2)} with ` +
          `${puffs.count} alive. It has to survive the frame it was born on at full brightness, ` +
          `or the first swat of a session -- the frame that compiles this pipeline -- shows nothing.`,
      );
    }
    for (let i = 0; i < 20; i++) puffs.update(PUFF_SECONDS / 8);
  }

  // --- The pool retires. Fire five, run past the lifetime, and nothing is left
  // alive or visible.
  {
    for (let i = 0; i < 5; i++) puffs.fire(i, 0, 0);
    if (puffs.count > 3) failures.push(`${puffs.count} puffs are alive against a pool of 3.`);
    for (let i = 0; i < 40; i++) puffs.update(PUFF_SECONDS / 8);
    if (puffs.count !== 0) failures.push(`${puffs.count} puffs never retired; the pool leaks.`);
    const shown = puffs.meshes.filter((m) => m.visible).length;
    if (shown !== 0) failures.push(`${shown} retired puffs are still visible.`);
  }

  // --- ...and it goes out. Additive and never faded is a smudge hanging in a
  // street forever.
  {
    const mesh = puffs.meshes[0];
    const material = mesh.material as MeshBasicNodeMaterial;
    puffs.fire(0, 0, 0);
    puffs.update(PUFF_SECONDS * 0.1);
    const lit = material.opacity;
    if (!(lit > 0.3)) failures.push(`A fresh puff is at opacity ${lit.toFixed(2)}; it is not visible.`);
    for (let i = 0; i < 20; i++) puffs.update(PUFF_SECONDS / 8);
    if (material.opacity > 1e-6) {
      failures.push(`A spent puff left the material at opacity ${material.opacity.toFixed(3)}.`);
    }
  }

  return failures;
}
