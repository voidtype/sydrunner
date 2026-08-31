import {
  Color,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three/webgpu';
import { NO_SPACE, RangeAllocator } from './rangealloc.ts';

/**
 * One `InstancedMesh` per species for the whole world.
 *
 * `world/rangealloc.ts` carries the argument for why this exists; the short of
 * it is that three puts `object.uuid` into the material cache key of every
 * instanced mesh, `NodeManager.nodeBuilderCache` is keyed on that, and so a
 * tile's gum trees and the next tile's gum trees compile as two different
 * shaders despite generating byte-identical WGSL. Fifty-six tiles was 3,260
 * node builder states and a compile queue the frame budget could not drain,
 * which is why riding into new ground showed nothing standing on it.
 *
 * This file is the half that owns meshes. A caller asks for room for `n`
 * instances of a (geometry, material) pair, writes matrices and colours into
 * the span it gets back, and gives the span up when its tile streams out. The
 * mesh, its buffers and its one pipeline outlive every tile that ever used it.
 *
 * ## What the caller has to know
 *
 * **Matrices are world-space.** The per-tile meshes this replaces were added to
 * the tile's own group and inherited its translation, so their matrices were
 * tile-local. A pooled mesh sits at the origin and is shared by tiles in
 * different suburbs, so the tile's world offset has to be in the matrix. Every
 * caller has to be converted deliberately; a forgotten offset puts a suburb's
 * trees at Circular Quay, which is obvious the moment it happens.
 *
 * **A claim is not permanent.** `grow` reallocates the instance attribute,
 * which is a new node attribute and therefore one recompile for that species.
 * It is a doubling, so it happens a handful of times in a session rather than
 * per tile, and it is the only compile this whole arrangement still pays.
 *
 * **A refused claim is normal.** Capacity is bounded so a runaway cannot eat
 * the GPU; when a claim cannot be met the caller draws nothing for that bucket,
 * which is exactly what it did when a tile failed to build before. It is
 * counted and put on the frame line rather than thrown.
 */

/** The initial room per species. A suburb of trees fits without growing. */
const INITIAL_CAPACITY = 4096;

/**
 * The ceiling per species.
 *
 * 262,144 four-by-four matrices is 16 MB of instance matrix for one species,
 * which is already more than the streaming radius can hold; past this something
 * is wrong and growing further would turn a bug into an out-of-memory. See
 * `PERFORMANCE.md` for the box's budgets.
 */
const MAX_CAPACITY = 262_144;

/** A span of a pooled mesh, held by whoever asked for it. */
export interface InstanceClaim {
  readonly key: string;
  readonly start: number;
  readonly count: number;
  /**
   * The tile origin these instances are written relative to.
   *
   * **Applied here rather than by every caller**, and that is a deliberate
   * choice about where a mistake can happen. Each builder in this project
   * composes matrices in tile-local metres because that is what the sidecars
   * hold, and a pooled mesh sits at the world origin -- so somebody has to add
   * the tile's offset. Doing it in `setMatrixAt` means the builders keep the
   * arithmetic they already had and the conversion cannot be got wrong one
   * file at a time.
   */
  readonly originX: number;
  readonly originZ: number;
}

/**
 * A claim wearing the two methods every builder in this project already calls.
 *
 * `buildTileBins`, `buildTilePoles`, `buildTileCars` and the rest were written
 * against `InstancedMesh`, and their matrix arithmetic is the part worth *not*
 * touching -- it is where the yaw, the lean, the kerb heights and the tonal
 * jitter live. So the shim carries the same two methods and each conversion is
 * a change of constructor rather than a rewrite of a loop.
 */
export class PooledSet {
  constructor(
    private readonly pool: InstancePool,
    readonly claim: InstanceClaim,
  ) {}

  setMatrixAt(index: number, matrix: Matrix4): void {
    this.pool.setMatrixAt(this.claim, index, matrix);
  }

  setColorAt(index: number, colour: Color): void {
    this.pool.setColorAt(this.claim, index, colour);
  }
}

interface Slot {
  mesh: InstancedMesh;
  alloc: RangeAllocator;
  /** True once anything has been written since the last upload. */
  dirty: boolean;
}

const _identity = /*#__PURE__*/ new Matrix4();
const _zero = /*#__PURE__*/ new Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);

export class InstancePool {
  private readonly slots = new Map<string, Slot>();
  private readonly root: Object3D;

  /** Claims refused because a species hit `MAX_CAPACITY`. */
  refused = 0;
  /** Times an instance buffer was reallocated. Each one is a recompile. */
  grows = 0;

  constructor(root: Object3D) {
    this.root = root;
  }

  /**
   * Room for `count` instances, or `null`.
   *
   * `key` names the species and must be stable for the life of the session:
   * it is what decides which mesh -- and therefore which pipeline -- the
   * instances land in. `geometry` and `material` are used only when the mesh is
   * first made, and must be the shared assets rather than per-tile clones, or
   * this file would be creating exactly the objects it exists to avoid.
   */
  claim(
    key: string,
    geometry: BufferGeometry,
    material: Material,
    count: number,
    configure?: (mesh: InstancedMesh) => void,
    originX = 0,
    originZ = 0,
  ): InstanceClaim | null {
    if (!Number.isFinite(count) || count <= 0) return null;
    const want = Math.floor(count);
    let slot = this.slots.get(key);
    if (slot === undefined) {
      slot = this.make(key, geometry, material, configure);
      this.slots.set(key, slot);
    }
    let start = slot.alloc.alloc(want);
    while (start === NO_SPACE) {
      // Grow on the largest *run*, not the total free: a buffer with room in
      // fifty holes still cannot seat one tile's six hundred trees.
      const next = Math.max(slot.alloc.capacity * 2, slot.alloc.capacity + want);
      if (next > MAX_CAPACITY) {
        this.refused++;
        return null;
      }
      this.resize(slot, next);
      start = slot.alloc.alloc(want);
    }
    slot.mesh.count = slot.alloc.highWater;
    return { key, start, count: want, originX, originZ };
  }

  /**
   * The same claim, wearing `setMatrixAt` and `setColorAt`.
   *
   * What every converted builder calls in place of `new InstancedMesh(...)`.
   */
  set(
    key: string,
    geometry: BufferGeometry,
    material: Material,
    count: number,
    originX: number,
    originZ: number,
    configure?: (mesh: InstancedMesh) => void,
  ): PooledSet | null {
    const claim = this.claim(key, geometry, material, count, configure, originX, originZ);
    return claim === null ? null : new PooledSet(this, claim);
  }

  /**
   * Give a claim back, and stop its instances drawing.
   *
   * **The zeroing is not tidiness.** A released span keeps whatever matrices it
   * held until somebody overwrites it, and every slot under `count` is drawn --
   * so without this, a tile that streamed out would leave its trees standing in
   * the air until another tile happened to claim the same slots.
   */
  release(claim: InstanceClaim | null): void {
    if (claim === null) return;
    const slot = this.slots.get(claim.key);
    if (slot === undefined) return;
    const matrices = slot.mesh.instanceMatrix.array as Float32Array;
    const end = Math.min(claim.start + claim.count, slot.alloc.capacity);
    for (let i = claim.start; i < end; i++) _zero.toArray(matrices, i * 16);
    if (!slot.alloc.free_(claim.start, claim.count)) return;
    slot.mesh.instanceMatrix.needsUpdate = true;
    slot.mesh.count = slot.alloc.highWater;
  }

  /**
   * Write one instance's matrix, in the tile-local metres the builders use.
   *
   * The claim's origin is added to the translation here. Elements 12 and 14 of
   * a column-major `Matrix4` are the x and z of the translation, so this is two
   * additions after the copy rather than a matrix multiply per instance -- which
   * matters at nine thousand trees a tile ring.
   */
  setMatrixAt(claim: InstanceClaim, index: number, matrix: Matrix4): void {
    const slot = this.slots.get(claim.key);
    if (slot === undefined || index < 0 || index >= claim.count) return;
    const array = slot.mesh.instanceMatrix.array as Float32Array;
    const at = (claim.start + index) * 16;
    matrix.toArray(array, at);
    array[at + 12] += claim.originX;
    array[at + 14] += claim.originZ;
    slot.dirty = true;
  }

  /** Write one instance's tint. */
  setColorAt(claim: InstanceClaim, index: number, colour: Color): void {
    const slot = this.slots.get(claim.key);
    if (slot === undefined || index < 0 || index >= claim.count) return;
    const attr = slot.mesh.instanceColor;
    if (attr === null) return;
    colour.toArray(attr.array as Float32Array, (claim.start + index) * 3);
    slot.dirty = true;
  }

  /** Push everything written since the last call up to the GPU. */
  flush(): void {
    for (const slot of this.slots.values()) {
      if (!slot.dirty) continue;
      slot.dirty = false;
      slot.mesh.instanceMatrix.needsUpdate = true;
      if (slot.mesh.instanceColor !== null) slot.mesh.instanceColor.needsUpdate = true;
    }
  }

  /** One clause for the frame line. */
  state(): string {
    let live = 0;
    let cap = 0;
    for (const slot of this.slots.values()) {
      live += slot.alloc.used;
      cap += slot.alloc.capacity;
    }
    return (
      `pool ${this.slots.size} meshes, ${live}/${cap} instances, ${this.grows} grows` +
      (this.refused > 0 ? `, ${this.refused} REFUSED` : '')
    );
  }

  /** How many pooled meshes exist. One per species; never per tile. */
  get meshes(): number {
    return this.slots.size;
  }

  private make(
    key: string,
    geometry: BufferGeometry,
    material: Material,
    configure?: (mesh: InstancedMesh) => void,
  ): Slot {
    const mesh = new InstancedMesh(geometry, material, INITIAL_CAPACITY);
    mesh.name = `pool_${key}`;
    mesh.count = 0;
    // The whole buffer is rewritten as tiles come and go, so tell the driver.
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(INITIAL_CAPACITY * 3), 3);
    mesh.instanceColor.setUsage(DynamicDrawUsage);
    // **Never culled, exactly as the per-tile meshes were not.** Their comment
    // said "culled with its tile"; in fact `frustumCulled` was already false on
    // every one of them, so consolidating costs no culling that was happening.
    // A pooled mesh spans the streaming radius and its bounding sphere would be
    // useless anyway.
    mesh.frustumCulled = false;
    // Zeroed rather than left as identity: an untouched slot must draw nothing,
    // and identity draws a full-size instance at the world origin.
    const matrices = mesh.instanceMatrix.array as Float32Array;
    matrices.fill(0);
    if (configure !== undefined) configure(mesh);
    this.root.add(mesh);
    return { mesh, alloc: new RangeAllocator(INITIAL_CAPACITY), dirty: false };
  }

  /**
   * Reallocate a species' buffers, preserving what is in them.
   *
   * The one expensive moment in this file: a new `InstancedBufferAttribute` is
   * a new node attribute, so three rebuilds this species' node graph once. That
   * is a single compile against the thousands this arrangement removes, and it
   * doubles, so it happens a few times a session and then never again.
   */
  private resize(slot: Slot, capacity: number): void {
    const next = Math.min(capacity, MAX_CAPACITY);
    const mesh = slot.mesh;
    const oldMatrices = mesh.instanceMatrix.array as Float32Array;
    const matrices = new Float32Array(next * 16);
    matrices.set(oldMatrices.subarray(0, Math.min(oldMatrices.length, matrices.length)));
    mesh.instanceMatrix = new InstancedBufferAttribute(matrices, 16);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    const oldColours = mesh.instanceColor === null ? null : (mesh.instanceColor.array as Float32Array);
    const colours = new Float32Array(next * 3);
    if (oldColours !== null) colours.set(oldColours.subarray(0, Math.min(oldColours.length, colours.length)));
    mesh.instanceColor = new InstancedBufferAttribute(colours, 3);
    mesh.instanceColor.setUsage(DynamicDrawUsage);
    slot.alloc.grow(next);
    slot.dirty = true;
    this.grows++;
    void _identity;
  }
}
