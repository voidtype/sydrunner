/**
 * A street light over the Ladmaster, which is the first light in this game that
 * a content file asks for -- and it costs nothing, which took some arranging.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO LAMP THERE ALREADY, WHICH IS THE WHOLE REASON THIS EXISTS
 *
 * The bake *does* carry lamp positions, and the brief's first question was
 * whether it does. It carries them twice over: `world/nightlights.
 * buildTileStreetLamps` hangs a luminaire on a hashed 42% of the surveyed
 * `power=pole` set out of each tile's `.power.bin`, and `deriveColumnLamps`
 * stands a column on the streets of any tile with fewer than twelve poles. So
 * the honest answer to "is there a street light near the spawn" is a number, and
 * the number was measured against the shipped `middle` index rather than
 * guessed:
 *
 *     nearest lit pole lamp     283.5 m   (-2514.7, 4597.2), Princes Highway
 *     nearest derived column    256.6 m   (-2209.2, 4288.1), Sydney Park Road
 *
 * Sydney Park is parkland. It has no power poles and no streets in it, so it has
 * no lights in it, and the bake is telling the truth. The spawn dither disc is
 * 100 m (`game/spawn.SPAWN_DITHER_RADIUS`), which puts the nearest light in the
 * world a good 150 m beyond the far rim of the place every player in this game
 * starts. There is nowhere in sight of the spawn to stand a man under a lamp.
 *
 * So he gets one.
 *
 * ---------------------------------------------------------------------------
 * AND IT IS NOT AN EIGHTH REAL LIGHT, WHICH IS THE PART WORTH READING
 *
 * The obvious implementation is a small warm `PointLight` parented to the giver,
 * off during the day. `world/nightlights.ts`'s header and
 * `sky/calibration.LAMP_REAL_COUNT` are both written specifically to refuse
 * that, and the refusal is measured rather than stylistic: three's WebGPU
 * `LightsNode.customCacheKey` hashes every light in the scene into **every
 * material's** cache key, so the *set* of lights is part of every pipeline in
 * the build. On the same machine, same tiles, same 86 warm-up draws, an extra
 * light costs about **0.6 s of boot** and an unconditional per-fragment term on
 * every lit material in the frame, at noon and at midnight, whether or not it is
 * contributing anything. There are seven, each argued for in writing, and
 * `verifyNightLights` asserts the count so that an eighth cannot arrive without
 * somebody having read all of them.
 *
 * This is somebody having read all of them, and the answer is that a hero giver
 * does not need a light of his own -- he needs to be **standing under one of the
 * two that already exist**. `NightLights` picks its two real `PointLight`s six
 * times a second out of whatever `LampSource.nearestLamps` hands it, which until
 * now was the tile streamer and only the tile streamer. So this field:
 *
 *   1. builds the lamp itself out of **`StreetLampAssets`** -- the city's own
 *      column geometry, the city's own column material, the city's own additive
 *      luminaire glow -- through `buildTileColumnLamps`, the same function every
 *      poleless tile in Sydney already calls. No new geometry, no new material,
 *      therefore **no new pipeline** and nothing new for `perf-harness
 *      --coverage` to audit: the two pipelines this draws with are compiled
 *      behind the loading screen by the first tile that has a column in it, and
 *      by `world/warmup.ts` regardless;
 *   2. publishes its lamp record through `lampsOver`, a two-line composite
 *      `LampSource` that answers the streamer's lamps **and** these. When the
 *      player is in Sydney Park the nearest lamp in the world is the
 *      Ladmaster's, so one of the two real lights that were already in the scene
 *      walks over and lights him. Nothing was added, nothing was hidden, and no
 *      pipeline was rebuilt.
 *
 * The one thing that *is* switched is the additive glow mesh, and switching a
 * **mesh** is free -- it is the same `visible` flag `TileStreamer.
 * setNightLightsVisible` already flips on every tile's lamps at dusk, and the
 * comment there about why it must never become a light flag is the comment
 * above. The post itself stays visible by day, because a street light is a pole
 * in the daytime and a pole that vanished at dawn would be the bug.
 *
 * ---------------------------------------------------------------------------
 * WHO GETS ONE
 *
 * A giver whose content record says `"marker": "hero"`. One field, two
 * consequences -- a `!` you can see from four hundred metres and a light you can
 * see him under at three in the morning -- and they are one idea rather than
 * two: *hero* means findable, and a marker over an unlit silhouette in a park at
 * midnight is only half of findable. Capping it at
 * `game/giverbodies.MAX_GIVER_LAMPS` is a cap on the **content**: there is
 * exactly one hero in `content/` and there is meant to be.
 *
 * Rebuilt only when the bundle's revision changes, which is at most once every
 * `server/quests.CONTENT_POLL_MS` and in practice once per session. Everything
 * else it does per frame is one boolean write.
 */

import type { Object3D } from 'three/webgpu';

import { MAX_GIVER_LAMPS, giverLampSpot } from '../game/giverbodies.ts';
import { NPC_MARKER, type DialogNpc } from '../game/questmodel.ts';
import {
  LAMP_RECORD_STRIDE,
  buildTileColumnLamps,
  type ColumnSite,
  type LampSource,
  type StreetLampAssets,
} from './nightlights.ts';

/**
 * The lamps a bundle asks for, in world metres.
 *
 * Pure over `(npcs, groundAt)` and split out from the field so
 * `verifyGiverLamps` can drive it with a flat ground and no renderer. The
 * `scale` is 1 -- `nightlights.COLUMN_TALL_SCALE` -- because a hero stands on a
 * footpath in a park rather than beside a laneway, and the short column is for
 * streets too narrow for a tall one.
 */
export function heroLampSites(npcs: readonly DialogNpc[], groundAt: (x: number, z: number) => number): ColumnSite[] {
  const out: ColumnSite[] = [];
  for (const npc of npcs) {
    if (npc.marker !== NPC_MARKER.HERO) continue;
    if (out.length >= MAX_GIVER_LAMPS) break;
    const ground = groundAt(npc.x, npc.z);
    // A giver over a tile that has not decoded yet has no ground to stand a pole
    // on. Skipped rather than placed at zero -- a column at y=0 in a suburb 50 m
    // below the origin is a pole in the sky -- and the next rebuild picks it up,
    // which is what `revision` being the trigger and `groundAt` being live buys.
    if (!Number.isFinite(ground)) continue;
    out.push({ ...giverLampSpot(npc.id, npc.x, npc.z, ground), scale: 1 });
  }
  return out;
}

/**
 * A `LampSource` that answers two. See the header's point 2.
 *
 * Deliberately not a method on either half: `TileStreamer` has no business
 * knowing that quest givers exist, and this file has no business knowing how a
 * tile is loaded. `NightLights` asked for an interface and this is a second
 * implementation of it that happens to delegate.
 *
 * The merge is "ask the streamer, then top up", which is not a sort and does not
 * need to be: `nearestLamps` inserts into a sorted list of at most `max` and
 * drops the furthest, so handing it the giver lamps **after** the city's is the
 * same answer as handing it all of them at once. `found` is threaded through as
 * the running count exactly as the streamer's own loop threads it.
 */
export function lampsOver(city: LampSource, extra: () => Float32Array<ArrayBuffer>): LampSource {
  return {
    nearestLamps(x, y, z, radius, out, max) {
      let found = city.nearestLamps(x, y, z, radius, out, max);
      const mine = extra();
      if (mine.length === 0) return found;
      if (max <= 0) return found;
      const r2 = radius * radius;
      /** Squared distance to the record already sitting in slot `n` of `out`. */
      const held = (n: number): number => {
        const o = n * LAMP_RECORD_STRIDE;
        const ex = out[o] - x;
        const ey = out[o + 1] - y;
        const ez = out[o + 2] - z;
        return ex * ex + ey * ey + ez * ez;
      };
      for (let i = 0; i < mine.length; i += LAMP_RECORD_STRIDE) {
        const dx = mine[i] - x;
        const dy = mine[i + 1] - y;
        const dz = mine[i + 2] - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d > r2) continue;
        /*
         * **The full list keeps what it has unless this actually beats it.**
         *
         * Without this test a giver lamp 80 m off would evict the city lamp the
         * player is standing under, which is a strictly worse night for the sake
         * of a park two blocks away -- and it is the failure an "append mine"
         * merge produces every single time the list is full, which at
         * `LAMP_REAL_COUNT` of two is most of Sydney.
         */
        if (found >= max && d >= held(max - 1)) continue;
        // Otherwise, insertion into the sorted prefix, exactly as the streamer's
        // own loop does it. The comparison is recomputed rather than kept in a
        // parallel array, because there are at most four of these against the
        // streamer's thousands.
        let slot = Math.min(found, max - 1);
        while (slot > 0 && held(slot - 1) > d) {
          const from = (slot - 1) * LAMP_RECORD_STRIDE;
          const to = slot * LAMP_RECORD_STRIDE;
          for (let k = 0; k < LAMP_RECORD_STRIDE; k++) out[to + k] = out[from + k];
          slot--;
        }
        const at = slot * LAMP_RECORD_STRIDE;
        out[at] = mine[i];
        out[at + 1] = mine[i + 1];
        out[at + 2] = mine[i + 2];
        out[at + 3] = mine[i + 3];
        if (found < max) found++;
      }
      return found;
    },
  };
}

/**
 * The lamps over this bundle's hero givers: two instanced meshes and a record
 * array.
 *
 * Owns nothing else. `main.ts` adds `objects` to the scene once, calls
 * `rebuild` when the content revision moves, and `setNightVisible` from the same
 * boolean it already hands `TileStreamer.setNightLightsVisible`.
 */
export class GiverLampField {
  /** Add these to the scene. Empty until the first `rebuild` with a hero in it. */
  readonly objects: Object3D[] = [];

  /** How many lamps are standing. For the check and a console poke. */
  live = 0;

  private readonly assets: StreetLampAssets;
  /**
   * The lamp records in world metres, for `lampsOver`.
   *
   * `Float32Array<ArrayBuffer>` rather than the bare alias, because
   * `LampSource.nearestLamps` takes the same and `buildTileColumnLamps` hands
   * back one built over a plain buffer. TypeScript 5.7 made the backing store a
   * type parameter and a bare `Float32Array` widens to `ArrayBufferLike`, which
   * includes `SharedArrayBuffer` and does not assign.
   */
  private records: Float32Array<ArrayBuffer> = new Float32Array(0);
  private glow: Object3D | null = null;
  private built = '';
  private nightVisible = false;

  constructor(assets: StreetLampAssets) {
    this.assets = assets;
  }

  /** The world-metre lamp records, for `lampsOver`. Owned here; do not retain. */
  lampRecords(): Float32Array<ArrayBuffer> {
    return this.records;
  }

  /**
   * Stand the lamps this bundle wants, if the bundle has changed.
   *
   * `revision` rather than the array identity, because `main.ts` re-parses the
   * pack on every `/content` and would otherwise hand a new array with the same
   * contents. Rebuilding is two `InstancedMesh` allocations over shared
   * geometry, so the guard is politeness rather than necessity -- but it is also
   * what stops the lamp *flickering* through a frame of removal and re-add on a
   * poll that changed a line of Denise's dialogue.
   *
   * **Returns whether it rebuilt**, and the caller must add `objects` to the
   * scene when it did. A `boolean` rather than letting the caller compare
   * `objects.length` before and after, because a rebuild that replaces one hero
   * with another leaves the count at two and a length compare would silently
   * never parent the new meshes -- a lamp that exists, is lit, is in the lamp
   * source, and is not in the scene.
   */
  rebuild(revision: string, npcs: readonly DialogNpc[], groundAt: (x: number, z: number) => number): boolean {
    if (revision === this.built) return false;
    this.built = revision;
    this.clear();
    const sites = heroLampSites(npcs, groundAt);
    this.live = sites.length;
    if (sites.length === 0) return true;
    // Origin zero, so the instance matrices are world metres. That is the one
    // place this diverges from `buildTileColumnLamps`' ordinary caller, and it
    // is safe for the reason the tile version is not: there are at most four of
    // these and they are not inside a group with a translation. Float32 at
    // Sydney's 60 km extent still resolves under a centimetre.
    const built = buildTileColumnLamps(sites, this.assets, 0, 0);
    this.records = built.lamps as Float32Array<ArrayBuffer>;
    if (built.post) this.objects.push(built.post);
    if (built.glow) {
      this.glow = built.glow;
      // The glow is night-only and starts off, so a lamp built at noon does not
      // flash a luminaire for one frame before the first `setNightVisible`.
      built.glow.visible = this.nightVisible;
      this.objects.push(built.glow);
    }
    return true;
  }

  /**
   * Off during the day. A **mesh** flag, never a light one -- see the header.
   *
   * The post is deliberately untouched: a street light is a pole by day, and one
   * that disappeared at dawn would leave a man standing in a park under nothing
   * with a floating luminaire's worth of nothing over him.
   */
  setNightVisible(on: boolean): void {
    if (this.nightVisible === on) return;
    this.nightVisible = on;
    if (this.glow) this.glow.visible = on;
  }

  /** Drop the instance buffers. The geometry and material are the city's; see `clear`. */
  dispose(): void {
    this.clear();
  }

  /**
   * Remove and release, without touching the shared assets.
   *
   * `buildTileColumnLamps` hands back meshes over `StreetLampAssets`' *one*
   * column geometry and *one* material, shared with every lit street in Sydney.
   * Disposing either here would put out every light in the city -- which is
   * `releaseGroupGeometry`'s own warning, restated because this is the one
   * caller that is not a tile and does not go through it.
   */
  private clear(): void {
    for (const object of this.objects) object.removeFromParent();
    this.objects.length = 0;
    this.glow = null;
    this.records = new Float32Array(0);
    this.live = 0;
  }
}

// --- The self-check ------------------------------------------------------------------

/**
 * What can be wrong here without anything throwing.
 *
 *   - **Every giver getting a lamp** would be a hundred and three poles in
 *     Sydney and a hundred and three luminaires competing for the two real
 *     lights, which on a laptop is a night that flickers.
 *   - **The lamp record not reaching `nearestLamps`** is the whole feature doing
 *     nothing: the pole and its glow stand there and the man under them stays a
 *     silhouette, which reads as a design decision rather than as a bug.
 *   - **The composite dropping a nearer city lamp** is the opposite failure and
 *     is worse, because it takes a light off a street to put it on a park.
 *   - **A rebuild that leaks** would add two meshes per `/content` poll,
 *     forever, at twelve polls an hour.
 *
 * Everything below runs with no renderer: `buildTileColumnLamps` builds
 * `InstancedMesh`es, which need no device until they are drawn, and the field is
 * never added to a scene.
 */
export function verifyGiverLamps(assets: StreetLampAssets): string[] {
  const failures: string[] = [];
  const npc = (id: string, x: number, z: number, marker: string): DialogNpc => ({
    id,
    name: id,
    x,
    z,
    radius: 4,
    root: 'hello',
    marker,
    nodes: [{ id: 'hello', line: 'oi', improv: null, choices: [] }],
  });
  const flat = (): number => 0;

  // --- Only a hero, and only up to the cap.
  {
    if (heroLampSites([npc('denise', 0, 0, NPC_MARKER.NONE)], flat).length !== 0) {
      failures.push('An ordinary giver was given a street light.');
    }
    const one = heroLampSites([npc('denise', 0, 0, ''), npc('lad', 10, 10, NPC_MARKER.HERO)], flat);
    if (one.length !== 1) failures.push(`One hero among two givers produced ${one.length} lamps.`);
    else if (Math.hypot(one[0].x - 10, one[0].z - 10) > 3) failures.push('A hero’s lamp does not stand beside the hero.');
    const many: DialogNpc[] = [];
    for (let i = 0; i < MAX_GIVER_LAMPS + 3; i++) many.push(npc(`h${i}`, i * 50, 0, NPC_MARKER.HERO));
    if (heroLampSites(many, flat).length !== MAX_GIVER_LAMPS) {
      failures.push(`${MAX_GIVER_LAMPS + 3} heroes produced ${heroLampSites(many, flat).length} lamps, over the cap.`);
    }
    // A giver over an undecoded tile is skipped rather than planted at y=0.
    if (heroLampSites([npc('lad', 10, 10, NPC_MARKER.HERO)], () => Number.NaN).length !== 0) {
      failures.push('A lamp was stood on ground that has not decoded.');
    }
  }

  // --- The field: one build, one rebuild, no leak, and a record to publish.
  {
    const field = new GiverLampField(assets);
    if (!field.rebuild('r1', [npc('denise', 0, 0, '')], flat)) failures.push('The first rebuild reported no work.');
    if (field.objects.length !== 0) failures.push('A bundle with no hero in it still built meshes.');
    if (field.lampRecords().length !== 0) failures.push('A bundle with no hero published a lamp record.');

    field.rebuild('r2', [npc('lad', -2210.8, 4506.3, NPC_MARKER.HERO)], () => -57.48);
    if (field.live !== 1) failures.push(`One hero stood ${field.live} lamps.`);
    // A post and a glow: two objects, and the second one is the night-only half.
    if (field.objects.length !== 2) failures.push(`One lamp produced ${field.objects.length} objects, not a post and a glow.`);
    if (field.lampRecords().length !== LAMP_RECORD_STRIDE) {
      failures.push(`One lamp published ${field.lampRecords().length} floats, not ${LAMP_RECORD_STRIDE}.`);
    }
    const rec = field.lampRecords();
    // The luminaire is over the giver's head, not over the foot of its own pole:
    // the arm reaches back at him. Within a metre horizontally and well above.
    if (Math.hypot(rec[0] + 2210.8, rec[2] - 4506.3) > 2) {
      failures.push(`The luminaire is ${Math.hypot(rec[0] + 2210.8, rec[2] - 4506.3).toFixed(2)} m from the giver it lights.`);
    }
    if (rec[1] - -57.48 < 5) failures.push(`The luminaire hangs ${(rec[1] + 57.48).toFixed(1)} m up; a street light is about nine.`);

    // The same revision is a no-op, and says so.
    if (field.rebuild('r2', [npc('lad', 0, 0, NPC_MARKER.HERO)], flat)) {
      failures.push('A rebuild on an unchanged revision reported work and would re-parent the scene.');
    }
    if (field.objects.length !== 2) failures.push('A rebuild on an unchanged revision changed the scene.');
    /*
     * A new revision replaces rather than accumulates -- **and reports it even
     * though the count did not move**, which is the caller contract. One hero
     * swapped for two here so both halves are visible at once: a length compare
     * in `main.ts` would have caught the second, and the previous case, where
     * one hero moves and the count stays at two, is the one it would not.
     */
    const moved = field.rebuild('r3', [npc('lad', 40, 0, NPC_MARKER.HERO)], flat);
    if (!moved) failures.push('A hero who moved rebuilt silently; the new meshes would never be parented.');
    if (field.objects.length !== 2) failures.push(`A rebuild left ${field.objects.length} objects; it must replace, not accumulate.`);
    field.rebuild('r3b', [npc('lad', 0, 0, NPC_MARKER.HERO), npc('two', 80, 0, NPC_MARKER.HERO)], flat);
    if (field.objects.length !== 2) failures.push(`Two heroes left ${field.objects.length} objects, not one post and one glow.`);
    if (field.live !== 2) failures.push(`Two heroes stood ${field.live} lamps.`);

    // The night flag is the glow's and never the post's.
    field.setNightVisible(true);
    const [post, glow] = field.objects;
    if (glow?.visible !== true) failures.push('The luminaire glow did not come on at night.');
    field.setNightVisible(false);
    if (glow?.visible !== false) failures.push('The luminaire glow stayed on through the day.');
    if (post?.visible !== true) failures.push('The pole itself vanished at dawn.');

    // --- The composite, which is the whole of how this lights anybody.
    {
      const empty: LampSource = { nearestLamps: () => 0 };
      const out = new Float32Array(2 * LAMP_RECORD_STRIDE);
      const source = lampsOver(empty, () => field.lampRecords());
      const n = source.nearestLamps(0, 0, 0, 44, out, 2);
      if (n !== 1) failures.push(`A giver lamp beside the player was found ${n} times, not once.`);
      // Out of reach is not offered, or the two real lights would be assigned to
      // a lamp in a park while the player is in the CBD.
      if (source.nearestLamps(5000, 0, 5000, 44, out, 2) !== 0) failures.push('A giver lamp 7 km away was offered to the real lights.');

      /*
       * **The city keeps its nearer lamp.** A real light taken off the street the
       * player is standing in and put on a park two blocks away is a strictly
       * worse night, and it is the failure a naive "append mine" would produce.
       */
      const city: LampSource = {
        nearestLamps: (_x, _y, _z, _r, o, max) => {
          if (max < 1) return 0;
          o[0] = 1;
          o[1] = 8;
          o[2] = 0;
          o[3] = 0;
          return 1;
        },
      };
      const one = new Float32Array(1 * LAMP_RECORD_STRIDE);
      const merged = lampsOver(city, () => field.lampRecords());
      // One slot, a city lamp 1 m away and a giver lamp 80 m away: the city wins.
      field.rebuild('r4', [npc('far', 80, 0, NPC_MARKER.HERO)], flat);
      if (merged.nearestLamps(0, 0, 0, 200, one, 1) !== 1 || Math.abs(one[0] - 1) > 1e-6) {
        failures.push('A distant giver lamp displaced the city lamp the player is standing under.');
      }
      // And the other way round: a giver lamp underfoot beats a city lamp 90 m off.
      field.rebuild('r5', [npc('near', 2, 0, NPC_MARKER.HERO)], flat);
      const farCity: LampSource = {
        nearestLamps: (_x, _y, _z, _r, o, max) => {
          if (max < 1) return 0;
          o[0] = 90;
          o[1] = 8;
          o[2] = 0;
          o[3] = 0;
          return 1;
        },
      };
      const two = new Float32Array(2 * LAMP_RECORD_STRIDE);
      const near = lampsOver(farCity, () => field.lampRecords());
      const count = near.nearestLamps(0, 0, 0, 200, two, 2);
      if (count !== 2) failures.push(`A city lamp and a giver lamp both in reach were counted ${count} times, not twice.`);
      if (Math.abs(two[0] - 90) < 1) failures.push('The nearer giver lamp was sorted behind the further city one.');
    }

    field.dispose();
    if (field.objects.length !== 0) failures.push('Disposing the field left objects behind.');
    // The shared assets survive, which is the one thing disposing must not do.
    if (assets.columnGeometry.getAttribute('position') === undefined) {
      failures.push('Disposing a giver lamp disposed the city’s column geometry with it.');
    }
  }

  return failures;
}
