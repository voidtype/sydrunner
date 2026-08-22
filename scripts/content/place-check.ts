/**
 * How far is (x, z) from the nearest track centreline, and the nearest
 * station?
 *
 *     bun run scripts/content/place-check.ts <x> <z> [<x> <z> ...]
 *     bun run scripts/content/place-check.ts <pool-entry.json>
 *
 * A content author places a giver or a `goto`/`photo` step by reading the
 * gazetteer -- a suburb name, a rough sense of where the shops are -- and the
 * gazetteer does not carry the railway. A giver standing on the rails is a
 * giver a train drives through every few minutes; a `goto` two kilometres from
 * any station is a `goto` the writer guessed rather than checked. Both are
 * silent until a player walks there, which is exactly the failure class this
 * repo writes standalone checks for rather than trusting to get caught in
 * review.
 *
 * The distance is read from `client/public/rail/rail.bin` through
 * `decodeRail`, the same decoder the client and `place-nudge.ts` use, so a
 * point this calls clear is clear by the one geometry the game itself
 * consults -- not a second, hand-rolled idea of where the tracks run.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeRail } from '../../client/src/game/rail.ts';

const REPO = join(import.meta.dir, '..', '..');
const buf = readFileSync(join(REPO, 'client/public/rail/rail.bin'));
const bake = decodeRail(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
const V = bake.vertices;

function trackDist(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i + 5 < V.length; i += 3) {
    const ax = V[i], az = V[i + 2], bx = V[i + 3], bz = V[i + 5];
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    if (l2 > 200 * 200) continue; // a direction boundary, not a segment
    let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + t * dx - x, pz = az + t * dz - z;
    const d = px * px + pz * pz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

function station(x: number, z: number): { name: string; d: number; v: string } {
  let best = { name: '?', d: Infinity, v: '?' };
  for (const s of bake.stations) {
    const d = Math.sqrt((s.x - x) ** 2 + (s.z - z) ** 2);
    if (d < best.d) best = { name: s.name, d, v: s.vertical };
  }
  return best;
}

function report(tag: string, x: number, z: number): string {
  const td = trackDist(x, z), st = station(x, z);
  const flags: string[] = [];
  if (td < 6) flags.push('ON THE TRACKS');
  else if (td < 12) flags.push('track-adjacent');
  if (st.d > 400) flags.push('FAR FROM ANY STATION');
  if (x < -60000 || x > 20000 || z < -60000 || z > 58000) flags.push('OUTSIDE THE WORLD');
  return `${tag.padEnd(14)} x=${x} z=${z}  track ${td.toFixed(1)} m  ${st.name} ${st.d.toFixed(0)} m (${st.v})  ${flags.join(', ')}`;
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0].endsWith('.json')) {
  const e = JSON.parse(readFileSync(args[0], 'utf8'));
  console.log(report('npc ' + e.npc.id.slice(0, 9), e.npc.x, e.npc.z));
  e.quest.steps.forEach((s: any, i: number) => {
    if (typeof s.x === 'number') console.log(report(`step${i} ${s.kind}`, s.x, s.z));
  });
} else {
  for (let i = 0; i + 1 < args.length; i += 2) console.log(report('point', Number(args[i]), Number(args[i + 1])));
}
