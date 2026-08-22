/**
 * Moves every NPC / `goto` / `photo` point in a pool entry that stands within
 * `NEAR_M` of a track centreline out to `CLEAR_M`, perpendicular to that
 * track, on the side it already leans. Rewrites the file in place and prints
 * what moved.
 *
 *     bun run scripts/content/place-nudge.ts <pool-entry.json>
 *
 * A writer working from the gazetteer cannot see the tracks -- see
 * `place-check.ts`'s header for why that is a giver a train drives through
 * rather than a cosmetic complaint. This is the one correction in the pool
 * pipeline that needs no taste: there is exactly one direction that clears the
 * nearest rail without guessing which side of the street the writer meant, and
 * it is perpendicular to the track on the side the point is already standing.
 * The step loop tries six multiples of `CLEAR_M` outward because a second
 * track five metres over the first is the usual neighbour at a junction or a
 * dual-track corridor, and a single hop can land back inside another line's
 * clearance.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeRail } from '../../client/src/game/rail.ts';

const NEAR_M = 12, CLEAR_M = 22;

const REPO = join(import.meta.dir, '..', '..');
const buf = readFileSync(join(REPO, 'client/public/rail/rail.bin'));
const V = decodeRail(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer).vertices;

function nearest(x: number, z: number) {
  let best = { d: Infinity, px: 0, pz: 0, nx: 0, nz: 0 };
  for (let i = 0; i + 5 < V.length; i += 3) {
    const ax = V[i], az = V[i + 2], dx = V[i + 3] - ax, dz = V[i + 5] - az, l2 = dx * dx + dz * dz;
    if (l2 > 200 * 200 || l2 === 0) continue;
    let t = ((x - ax) * dx + (z - az) * dz) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + t * dx, pz = az + t * dz, d = Math.hypot(px - x, pz - z);
    if (d < best.d) { const l = Math.sqrt(l2); best = { d, px, pz, nx: -dz / l, nz: dx / l }; }
  }
  return best;
}

function nudge(p: { x: number; z: number }, tag: string): boolean {
  let n = nearest(p.x, p.z);
  if (n.d >= NEAR_M) return false;
  const side = (p.x - n.px) * n.nx + (p.z - n.pz) * n.nz >= 0 ? 1 : -1;
  // Step out until clear of *every* track -- a second track 5 m over is the usual neighbour.
  for (let k = 1; k <= 6; k++) {
    const x = Math.round(n.px + side * n.nx * CLEAR_M * k), z = Math.round(n.pz + side * n.nz * CLEAR_M * k);
    if (nearest(x, z).d >= NEAR_M) {
      console.log(`${tag}: (${p.x}, ${p.z}) was ${n.d.toFixed(1)} m from a track -> (${x}, ${z})`);
      p.x = x; p.z = z;
      return true;
    }
  }
  console.log(`${tag}: could not clear the tracks from (${p.x}, ${p.z}); fix by hand`);
  return false;
}

const path = process.argv[2];
const e = JSON.parse(readFileSync(path, 'utf8'));
let moved = nudge(e.npc, 'npc ' + e.npc.id) ? 1 : 0;
e.quest.steps.forEach((s: any, i: number) => {
  if (typeof s.x === 'number' && nudge(s, `step ${i} ${s.kind}`)) moved++;
});
if (moved) writeFileSync(path, JSON.stringify(e, null, 2) + '\n');
console.log(moved ? `${moved} point(s) moved` : 'nothing to move');
