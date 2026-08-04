/**
 * One global facade-parameter texture for every resident tile.
 *
 * The reason this exists is performance, and it is structural rather than a
 * tweak. The obvious design gives each tile its own parameter texture, which
 * forces a fresh material per tile per material slot -- with 26 tiles resident
 * that is 234 distinct WGSL pipelines, each carrying the full facade graph.
 *
 * Instead: one texture, four texels per building, and a free-list allocator
 * handing out contiguous blocks to tiles. Every tile's geometry gets its block
 * offset folded into its `_BLDIDX` attribute at load time, which is a cheap pass
 * over a Float32Array. The eleven materials are then created once for the whole
 * game.
 *
 * ## Layout, and why it is not one building per row
 *
 * The natural layout is a texture 4 texels wide and one row per building. That
 * is wrong, and silently so: WebGPU guarantees `maxTextureDimension2D` of only
 * 8192, so a 4 x 65536 texture fails to create, every bind group referencing it
 * becomes invalid, and the renderer submits no command buffers at all. The
 * result is a completely black scene with nothing but validation errors in the
 * console -- no geometry error, no shader error, nothing pointing at the cause.
 *
 * So buildings are packed linearly into a wide texture instead. `ROW_TEXELS` is
 * a multiple of `TEXELS_PER_BUILDING`, which guarantees a building's four texels
 * never straddle a row boundary and keeps the shader's index arithmetic to a
 * mask and a shift.
 */

import { DataTexture, FloatType, NearestFilter, RGBAFormat } from 'three/webgpu';

/** Texels per building. Must match `mesh.PARAMS_STRIDE / 4` in the pipeline. */
export const TEXELS_PER_BUILDING = 4;

/**
 * Texels per texture row. A power of two so the shader can use a mask and shift
 * instead of an integer division, and a multiple of TEXELS_PER_BUILDING so no
 * building is split across two rows.
 */
export const ROW_TEXELS = 2048;
export const ROW_SHIFT = 11; // log2(ROW_TEXELS)
export const BUILDINGS_PER_ROW = ROW_TEXELS / TEXELS_PER_BUILDING;

/**
 * Maximum buildings resident at once. 65,536 needs a 2048 x 128 texture, which
 * is 4 MB of RGBA32F -- 262,144 texels at 16 bytes -- and comfortably inside
 * every WebGPU implementation's limits. A 1.8 km streaming radius over inner
 * Sydney peaks around 25,000.
 */
const CAPACITY = 65_536;
const ROWS = Math.ceil(CAPACITY / BUILDINGS_PER_ROW);

/** Texture dimensions the atlas will allocate, for a startup limits check. */
export function atlasTextureSize(): { width: number; height: number } {
  return { width: ROW_TEXELS, height: ROWS };
}

interface Block {
  start: number;
  count: number;
}

export class FacadeParamsAtlas {
  readonly texture: DataTexture;
  private readonly data: Float32Array;
  /** Free blocks, kept sorted by start so adjacent ones can be coalesced. */
  private free: Block[] = [{ start: 0, count: CAPACITY }];
  private readonly assigned = new Map<string, Block>();
  private used = 0;

  constructor() {
    this.data = new Float32Array(ROW_TEXELS * ROWS * 4);
    this.texture = new DataTexture(this.data, ROW_TEXELS, ROWS, RGBAFormat, FloatType);
    this.texture.magFilter = NearestFilter;
    this.texture.minFilter = NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
  }

  get usedRows(): number {
    return this.used;
  }

  get capacity(): number {
    return CAPACITY;
  }

  /** Texture dimensions, for the startup limits check. */
  get size(): { width: number; height: number } {
    return { width: ROW_TEXELS, height: ROWS };
  }

  /**
   * Copy a tile's parameters in and return the building index its block starts
   * at, or null if the atlas is full.
   *
   * First-fit over the free list. Blocks are contiguous per tile so a building's
   * global index is simply `offset + localIndex`.
   */
  allocate(tileKey: string, params: Float32Array): number | null {
    const existing = this.assigned.get(tileKey);
    if (existing) return existing.start;

    const floatsPerBuilding = TEXELS_PER_BUILDING * 4;
    const buildings = Math.floor(params.length / floatsPerBuilding);
    // A streets-only tile at the extent edge has an empty parameter buffer. It
    // needs no block, and the offset it gets back is never used because its
    // geometry carries no `_BLDIDX`. Returning null here instead would read as
    // "atlas full" to the caller, which retries forever and never draws the
    // roads on it.
    if (buildings === 0) return 0;

    const index = this.free.findIndex((b) => b.count >= buildings);
    if (index === -1) return null;

    const block = this.free[index];
    const start = block.start;
    if (block.count === buildings) this.free.splice(index, 1);
    else {
      block.start += buildings;
      block.count -= buildings;
    }

    this.data.set(params.subarray(0, buildings * floatsPerBuilding), start * floatsPerBuilding);
    this.assigned.set(tileKey, { start, count: buildings });
    this.used += buildings;
    // A sub-region upload would be better, but three's DataTexture has no such
    // path; a full re-upload on tile load is still far cheaper than compiling a
    // pipeline.
    //
    // WHAT THIS DOES AND DOES NOT DO, read out of three r185 rather than
    // guessed, because it has twice now been suspected of causing a one-frame
    // flash across every facade in the world and it cannot:
    //
    //   - It is a `writeTexture`, not a re-create. `Textures.updateTexture`
    //     only calls `backend.createTexture` again while
    //     `textureData.isDefaultTexture` is unset or true, which it stops being
    //     after the first real upload; every later version bump falls straight
    //     through to `backend.updateTexture`, and `WebGPUTextureUtils`' data
    //     path for that is `_copyBufferToTexture` -> `device.queue.writeTexture`.
    //     The GPUTexture object is never destroyed and never replaced, so there
    //     is no frame in which anything samples an invalid texture.
    //   - No bind group is rebuilt. `Bindings._updateBindings` re-uploads a
    //     bind group only when `binding.generation` disagrees with the
    //     texture's, and `Textures` bumps that generation only in the
    //     create-texture branches -- not here.
    //   - Uploads coalesce to one a frame. `updateTexture` returns early while
    //     `textureData.version === texture.version`, and the version is only
    //     read when the renderer next draws, so four tiles landing between two
    //     frames cost one 4 MB copy, not four.
    //
    // So the cost is bandwidth on the frames a tile lands, and nothing else.
    this.texture.needsUpdate = true;
    return start;
  }

  /** Return a tile's block to the free list, coalescing with neighbours. */
  release(tileKey: string): void {
    const block = this.assigned.get(tileKey);
    if (!block) return;
    this.assigned.delete(tileKey);
    this.used -= block.count;

    this.free.push(block);
    this.free.sort((a, b) => a.start - b.start);
    const merged: Block[] = [];
    for (const b of this.free) {
      const last = merged[merged.length - 1];
      if (last && last.start + last.count === b.start) last.count += b.count;
      else merged.push({ ...b });
    }
    this.free = merged;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

/**
 * Fold a tile's atlas offset into its `_BLDIDX` attribute.
 *
 * Done on the CPU at load time so the shader never needs a per-tile uniform,
 * which is precisely what would force per-tile materials again.
 */
export function offsetBuildingIndices(array: Float32Array, offset: number): void {
  for (let i = 0; i < array.length; i++) array[i] += offset;
}
