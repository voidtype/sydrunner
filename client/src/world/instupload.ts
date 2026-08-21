/**
 * Upload the instances that were written, and not the two hundred that were not.
 *
 * ---------------------------------------------------------------------------
 * ## The bug, which is one line long and is in nine files
 *
 * Every instanced population in this client is a fixed-capacity pool that is
 * refilled from index 0 every frame: the traffic writes `n` cars into a set
 * sized for 384, the crowd writes 52 pedestrians into six sets sized for 220,
 * the flock writes nine birds into sets sized for 24, and each of them then
 * says
 *
 *     mesh.instanceMatrix.needsUpdate = true;
 *
 * and sets `mesh.count = n`. The count is right, the picture is right, and the
 * upload is **the whole buffer**. Three's WebGPU backend, given an attribute
 * with no `updateRanges`, calls
 *
 *     device.queue.writeBuffer( buffer, 0, array )
 *
 * with no length -- the entire typed array, every frame, whether three
 * instances moved or none did (`WebGPUAttributeUtils.updateAttribute`, the
 * `updateRanges.length === 0` branch).
 *
 * Measured by `client/src/perf-harness.ts` on a CBD street with 118 cars and 52
 * pedestrians drawn, over the traffic, the crowd, the flock and the events
 * alone: **282.5 kB uploaded per frame against 27.2 kB of live instances.** A
 * factor of ten, sixty times a second, and none of it is on screen.
 *
 * Several of those call sites already carry a comment saying "only upload what
 * changed" -- `PedestrianCrowd.upload` and `TrafficMovers.update` both do -- and
 * neither could: the only lever they had was skipping the upload entirely when
 * the set was empty. `BufferAttribute.addUpdateRange` is the other half of that
 * intent and it has been in three the whole time. This module is that half,
 * written once so nine call sites cannot each get the element arithmetic wrong.
 *
 * ---------------------------------------------------------------------------
 * ## Why a range is safe here and would not be everywhere
 *
 * A partial upload is only correct if the GPU copy of the untouched region is
 * either already right or never read. Both hold, for two independent reasons:
 *
 *  1. **Nothing draws past `count`.** `InstancedMesh.count` is the draw's
 *     instance count, so instances `[count, capacity)` are not rasterised at
 *     all. Whatever stale matrix is up there is invisible by construction --
 *     which is exactly the argument the existing `if (n > 0 || mesh.count > 0)`
 *     guards already make in miniature.
 *  2. **The buffer is created from the full array.** Three writes the whole
 *     typed array into the mapped range at `createAttribute` time, so the very
 *     first frame's GPU copy is complete before any range is ever used.
 *
 * The one thing this must never be used for is a **sparse** writer -- a pool
 * that writes instance 7 and instance 300 and leaves the middle alone. There is
 * one of those in the client (`world/carlod.ts` claims model slots by index) and
 * it is deliberately not converted; `uploadInstances` takes a *prefix* length
 * and its name says so.
 *
 * ---------------------------------------------------------------------------
 * ## Ranges are consumed, and must be cleared anyway
 *
 * `WebGPUAttributeUtils.updateAttribute` calls `clearUpdateRanges()` after it
 * writes, so in the normal case the list is empty again next frame. It does
 * **not** in the case that matters: an attribute whose mesh was not rendered
 * that frame -- off screen, `count` zero, the tab in the background -- is never
 * uploaded, so its range survives. Pushing another one every frame would grow an
 * array forever and then hand the driver hundreds of overlapping writes on the
 * frame the object came back.
 *
 * So this clears before it adds, unconditionally. Two array operations against a
 * kilobyte of avoided copy.
 *
 * ---------------------------------------------------------------------------
 * ## It counts what it saved
 *
 * `uploadStats` accumulates the bytes that *would* have gone and the bytes that
 * did, because the whole reason this file exists is a number, and a number that
 * stops being measured is a number that regresses. `sydney.frame()` does not
 * print it (it is not a section of the frame) but `perf-harness.ts` does, and
 * the debug overlay can. Two adds and a multiply on a path that is already
 * touching a kilobyte.
 */

import { InstancedBufferAttribute } from 'three/webgpu';
import type { BufferAttribute, InstancedMesh } from 'three/webgpu';

/**
 * What the ranges have saved since the page loaded.
 *
 * Monotonic and never reset, on `server/profile.TickProfile`'s argument about
 * shared counters: two readers dividing one resettable counter is a bug this
 * project has already paid for once, so readers subtract from a remembered
 * value instead.
 */
export const uploadStats = {
  /** Calls to `uploadInstances`/`uploadAttribute` that actually uploaded. */
  uploads: 0,
  /** Bytes handed to `writeBuffer` with the range in place. */
  bytes: 0,
  /** Bytes that would have gone without it -- the whole array, every time. */
  fullBytes: 0,
};

/**
 * Mark the first `count` instances of `mesh` for upload and nothing else.
 *
 * Returns nothing and is safe to call with `count === 0`, which is the
 * "everything went away this frame" case: the caller still has to set
 * `mesh.count = 0`, and there is nothing to upload because nothing will be
 * drawn.
 *
 * `instanceColor` is handled here too rather than at the call sites, because
 * every one of them writes colours in lockstep with matrices and the pair of
 * `needsUpdate` lines was already copied nine times.
 */
export function uploadInstances(mesh: InstancedMesh, count: number): void {
  if (count <= 0) return;
  uploadAttribute(mesh.instanceMatrix, count, 16);
  if (mesh.instanceColor) uploadAttribute(mesh.instanceColor, count, 3);
}

/**
 * The same, for one attribute whose per-instance stride the caller knows.
 *
 * Split out for the two attributes in this client that ride beside an instance
 * matrix without being one: `CarSmoke.markFade` (one float of fade per scorch
 * mark) and the nameplate field's three vertex attributes, which are four
 * vertices per plate rather than one instance each.
 *
 * `start` is always zero because every writer in this client packs from zero.
 * A parameter for it would be an invitation to use this on a sparse pool, which
 * is exactly what the header says not to do.
 */
export function uploadAttribute(
  attribute: BufferAttribute,
  count: number,
  stride: number,
): void {
  const elements = count * stride;
  const array = attribute.array as ArrayLike<number> & { BYTES_PER_ELEMENT: number; byteLength: number };
  // Clamp rather than trust: a caller that passed a count past the pool's
  // capacity would otherwise hand the driver a write past the end of the
  // buffer, which is a validation error in the console and a black screen in
  // the worst case. The clamp costs a comparison and turns a class of bug into
  // a picture that is merely stale.
  const capped = elements > array.length ? array.length : elements;
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, capped);
  attribute.needsUpdate = true;
  uploadStats.uploads++;
  uploadStats.bytes += capped * array.BYTES_PER_ELEMENT;
  uploadStats.fullBytes += array.byteLength;
}

/**
 * What the ranges are saving, as a line. For the harness and the console.
 */
export function uploadReport(): string {
  const { uploads, bytes, fullBytes } = uploadStats;
  if (uploads === 0) return 'instance upload: nothing uploaded yet';
  const ratio = bytes > 0 ? fullBytes / bytes : 0;
  return (
    `instance upload: ${(bytes / 1024).toFixed(1)} kB over ${uploads} uploads, ` +
    `against ${(fullBytes / 1024).toFixed(1)} kB whole-buffer (${ratio.toFixed(1)}x saved)`
  );
}

// --- The self-check -------------------------------------------------------------

/**
 * What this catches that a typecheck cannot.
 *
 *   - **A range that does not cover what was written.** The one failure that
 *     shows on screen: instances drawn from a region the driver was never given,
 *     which is a car at the origin with a zero matrix -- the exact artefact
 *     `TrafficMovers`' missing `carModels.end()` shipped once already.
 *   - **Ranges that accumulate.** The list must be cleared before each add, or
 *     an object that goes off screen for a minute comes back with three and a
 *     half thousand queued writes.
 *   - **A count past the pool.** Clamped rather than trusted; a write past the
 *     end of a GPU buffer is a validation failure, not a wrong picture.
 *   - **The stats being nonsense**, which is the whole justification for the
 *     change: if `fullBytes` were not the whole array, the saving this file
 *     claims would be unfalsifiable.
 *
 * Three-free in spirit but not in fact -- it needs a real `BufferAttribute` to
 * assert against, so this runs in the client boot list only, like
 * `verifyBigNightKit`. It leaves `uploadStats` a few hundred bytes heavier than
 * a clean boot would, which is why the check subtracts a snapshot rather than
 * reading the totals.
 */
export function verifyInstanceUpload(): string[] {
  const failures: string[] = [];

  // A hundred instances of a matrix, which is the shape every pool in the
  // client has. Built here rather than handed in: the check is about the element
  // arithmetic, and the arithmetic is wrong or right against a real attribute.
  const attribute = new InstancedBufferAttribute(new Float32Array(100 * 16), 16);
  const before = { ...uploadStats };

  uploadAttribute(attribute, 7, 16);
  if (attribute.updateRanges.length !== 1) {
    failures.push(`One upload produced ${attribute.updateRanges.length} ranges; the driver is being handed the wrong number of writes.`);
  } else {
    const range = attribute.updateRanges[0];
    if (range.start !== 0 || range.count !== 7 * 16) {
      failures.push(
        `Seven instances of stride 16 produced range [${range.start}, ${range.count}); ` +
          `it must be [0, 112) or the instances past the range draw with whatever the GPU last held.`,
      );
    }
  }

  // Twice in a row without an upload in between: the list must not grow.
  uploadAttribute(attribute, 9, 16);
  if (attribute.updateRanges.length !== 1) {
    failures.push(
      `Two calls with no render between them left ${attribute.updateRanges.length} ranges queued. ` +
        `An object off screen for a minute would come back with thousands.`,
    );
  }
  if (attribute.updateRanges[0]?.count !== 9 * 16) {
    failures.push('The second call did not replace the first range; a shrinking set would over-write.');
  }

  // A count past the pool is clamped rather than passed through.
  uploadAttribute(attribute, 500, 16);
  if ((attribute.updateRanges[0]?.count ?? 0) > attribute.array.length) {
    failures.push(
      `A count past the pool produced a range of ${attribute.updateRanges[0].count} elements over an array of ` +
        `${attribute.array.length}; that is a write past the end of a GPU buffer.`,
    );
  }

  // And the accounting, which is the claim this file makes.
  const uploaded = uploadStats.bytes - before.bytes;
  const full = uploadStats.fullBytes - before.fullBytes;
  const expectedFull = attribute.array.byteLength * 3;
  if (full !== expectedFull) {
    failures.push(
      `Three uploads of a ${attribute.array.byteLength}-byte array charged ${full} bytes to the whole-buffer ` +
        `total instead of ${expectedFull}; the saving this module reports would be wrong.`,
    );
  }
  if (!(uploaded > 0 && uploaded < full)) {
    failures.push(`Ranged uploads charged ${uploaded} bytes against ${full} whole-buffer; the saving is not being measured.`);
  }

  return failures;
}
