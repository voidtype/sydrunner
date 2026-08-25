/**
 * The mushrooms themselves: three instanced meshes, one sink, no records.
 *
 * ---------------------------------------------------------------------------
 * ## Where they come from
 *
 * `game/mushrooms.mushroomFor` decides, from `(tile, tree index, epoch)`, which
 * trees carry one and what colour it is. This file is the half that draws the
 * answer and notices you walking onto it. It owns no list of mushrooms that
 * outlives a tile: a tile arrives, its trees are put through the hash, whatever
 * comes out is written into the instance buffers, and when the tile leaves the
 * instances go with it. That is the same lifecycle the trees themselves have and
 * it is why this cannot leak a mushroom across a stream-out.
 *
 * ## Why the caps are three meshes and the stems are one
 *
 * A pipeline is keyed on the material, so three cap colours are three materials
 * and therefore three draws -- and the stems are all the same white, so they are
 * one draw whatever is on top of them. Four instanced meshes for the whole
 * feature, sized once at `CAPACITY` and never reallocated, because a growing
 * `InstancedMesh` is a new pipeline every time it grows (see
 * `streamer.LoadedTile.warm`, which is the same trap costing 200 ms a frame).
 *
 * ## Eating
 *
 * The field does not eat anything. It reports the nearest mushroom inside
 * `EAT_RADIUS_M` and lets `main.ts` decide, for the reason every other
 * interaction in this project is arranged that way: the sim owns what a pickup
 * *means*, and a renderer that applied buffs would be a second opinion about the
 * player's health. An eaten one is hidden here and refused by the server on the
 * hash, so a client that lies about it poisons nobody.
 */

import { InstancedMesh, Matrix4, Mesh, MeshBasicNodeMaterial, type Group } from 'three/webgpu';
import { CylinderGeometry, SphereGeometry } from 'three';
import {
  EAT_RADIUS_M,
  insideRegion,
  mushroomFor,
  type CapKind,
} from '../game/mushrooms.ts';

/**
 * The most that may be resident at once.
 *
 * At 0.05% of trees, a full ring of bushland tiles is a few hundred; this is
 * four times that so the buffers never resize, and an `InstancedMesh` that never
 * resizes is one pipeline for the life of the session.
 */
export const CAPACITY = 2048;

/** How tall the whole thing stands, metres. Small enough to be a find. */
export const STEM_HEIGHT_M = 0.17;
export const CAP_RADIUS_M = 0.11;

const CAP_COLOURS: readonly number[] = [0x6b4a2f, 0xd2691e, 0xf2efe6];
const STEM_COLOUR = 0xf3f1ea;

interface Resident {
  /** World metres. */
  x: number;
  y: number;
  z: number;
  cap: CapKind;
  /** Which slot of `cap`'s mesh it is drawn in, so eating can hide exactly it. */
  slot: number;
  /** Stable across a session: the tile and tree it grew from. */
  tileKey: string;
  treeIndex: number;
  eaten: boolean;
}

const _m = /*#__PURE__*/ new Matrix4();
const _hide = /*#__PURE__*/ new Matrix4().makeScale(0, 0, 0);

export class MushroomField {
  private readonly stems: InstancedMesh;
  private readonly caps: InstancedMesh[] = [];
  /** Every resident, by tile, so a stream-out drops exactly its own. */
  private readonly byTile = new Map<string, Resident[]>();
  private readonly counts = [0, 0, 0];
  private stemCount = 0;
  /** Rolled once per session. See `game/mushrooms.ts`: temp, not perma. */
  readonly epoch: number;

  constructor(parent: Group, epoch: number) {
    this.epoch = epoch;
    const stemGeo = new CylinderGeometry(0.022, 0.03, STEM_HEIGHT_M, 5, 1);
    stemGeo.translate(0, STEM_HEIGHT_M / 2, 0);
    const stemMat = new MeshBasicNodeMaterial({ color: STEM_COLOUR });
    this.stems = new InstancedMesh(stemGeo, stemMat, CAPACITY);
    this.stems.frustumCulled = false;
    this.stems.count = 0;
    this.stems.name = 'mushroom_stems';
    parent.add(this.stems);

    // A squashed sphere is a cap at this size and costs 80 triangles.
    const capGeo = new SphereGeometry(CAP_RADIUS_M, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2);
    capGeo.translate(0, STEM_HEIGHT_M, 0);
    capGeo.scale(1, 0.62, 1);
    for (let c = 0; c < CAP_COLOURS.length; c++) {
      const mat = new MeshBasicNodeMaterial({ color: CAP_COLOURS[c] });
      const mesh = new InstancedMesh(capGeo, mat, CAPACITY);
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.name = `mushroom_cap_${c}`;
      parent.add(mesh);
      this.caps.push(mesh);
    }
  }

  /** The meshes, for the precompiler. See `streamer.setPrecompiler`. */
  get meshes(): readonly Mesh[] {
    return [this.stems, ...this.caps];
  }

  /** How many are standing, for the overlay. */
  get resident(): number {
    return this.stemCount;
  }

  /**
   * A tile arrived with trees. Put them through the hash and keep what grows.
   *
   * `originX`/`originZ` are the tile's world origin, because `TileVegetation` is
   * tile-local and everything downstream of here is world metres.
   */
  adopt(
    tileKey: string,
    veg: { count: number; x: Float32Array; z: Float32Array },
    originX: number,
    originZ: number,
    groundAt: (x: number, z: number) => number,
  ): void {
    if (this.byTile.has(tileKey)) return;
    // The tile's own integers, off its key, so the hash is the same pair the
    // server would use. A key is `<x>_<z>`; anything else is not a tile.
    const parts = tileKey.split('_');
    const tileX = Number(parts[0]);
    const tileZ = Number(parts[1]);
    if (!Number.isFinite(tileX) || !Number.isFinite(tileZ)) return;
    const { count, x: localX, z: localZ } = veg;
    const grown: Resident[] = [];
    for (let i = 0; i < count; i++) {
      const wx = originX + localX[i];
      const wz = originZ + localZ[i];
      // The region gate first: it is two multiplies and it rejects the entire
      // city, which is most of the tiles this will ever be handed.
      if (!insideRegion(wx, wz)) continue;
      const m = mushroomFor(tileX, tileZ, i, this.epoch, localX[i], localZ[i]);
      if (m === null) continue;
      const mx = originX + m.x;
      const mz = originZ + m.z;
      grown.push({ x: mx, y: groundAt(mx, mz), z: mz, cap: m.cap, slot: -1, tileKey, treeIndex: i, eaten: false });
    }
    if (grown.length === 0) return;
    this.byTile.set(tileKey, grown);
    this.rebuild();
  }

  /** The tile's geometry has gone, and so have its mushrooms. */
  release(tileKey: string): void {
    if (this.byTile.delete(tileKey)) this.rebuild();
  }

  /**
   * The nearest uneaten mushroom within `EAT_RADIUS_M`, or null.
   *
   * Linear over the residents, which is a few hundred at the very most and only
   * inside the one region in Sydney where any of them exist -- everywhere else
   * this is a loop over nothing.
   */
  nearest(x: number, z: number): Resident | null {
    let best: Resident | null = null;
    let bestD2 = EAT_RADIUS_M * EAT_RADIUS_M;
    for (const list of this.byTile.values()) {
      for (const r of list) {
        if (r.eaten) continue;
        const dx = r.x - x;
        const dz = r.z - z;
        const d2 = dx * dx + dz * dz;
        if (d2 > bestD2) continue;
        bestD2 = d2;
        best = r;
      }
    }
    return best;
  }

  /** It has been eaten. Hidden here; what it *did* is the sim's. */
  eat(r: Resident): void {
    if (r.eaten) return;
    r.eaten = true;
    const mesh = this.caps[r.cap];
    mesh.setMatrixAt(r.slot, _hide);
    mesh.instanceMatrix.needsUpdate = true;
    this.stems.setMatrixAt(r.slot, _hide);
    this.stems.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.geometry.dispose();
      (m.material as { dispose(): void }).dispose();
    }
  }

  /**
   * Repack every instance buffer.
   *
   * Whole-rebuild rather than a free list, because a tile arrives or leaves a
   * few times a second at a walk and the resident set is in the hundreds: the
   * repack is tens of microseconds and a free list is a lifetime of off-by-one
   * bugs about a slot that was reused while somebody was standing on it.
   */
  private rebuild(): void {
    this.counts[0] = 0;
    this.counts[1] = 0;
    this.counts[2] = 0;
    let n = 0;
    for (const list of this.byTile.values()) {
      for (const r of list) {
        if (n >= CAPACITY) break;
        r.slot = n;
        _m.makeTranslation(r.x, r.y, r.z);
        this.stems.setMatrixAt(n, r.eaten ? _hide : _m);
        const cap = this.caps[r.cap];
        // Every cap mesh is written at the same slot so one index addresses the
        // stem and its own cap; the other two are collapsed there.
        cap.setMatrixAt(n, r.eaten ? _hide : _m);
        for (let c = 0; c < this.caps.length; c++) if (c !== r.cap) this.caps[c].setMatrixAt(n, _hide);
        this.counts[r.cap]++;
        n++;
      }
    }
    this.stemCount = n;
    this.stems.count = n;
    this.stems.instanceMatrix.needsUpdate = true;
    for (const cap of this.caps) {
      cap.count = n;
      cap.instanceMatrix.needsUpdate = true;
    }
  }
}

export type { Resident as MushroomResident };
