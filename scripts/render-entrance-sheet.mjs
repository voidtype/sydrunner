#!/usr/bin/env node
/**
 * The station mouth in elevation, for eyes, with no browser in it.
 *
 * The owner's report was *"the stairs on a station entrance dont actually look
 * like stairs its just a ramp, and from the outside it has no roof"*, and both
 * halves of it are shape rather than arithmetic. `verifyStationAccess` can
 * assert that the risers add up to the drop and that the roof soffit clears a
 * head; it cannot say whether the result *reads* as a staircase under a
 * canopy. Somebody has to look, and `scripts/render-car-sheet.mjs` and
 * `scripts/render-landmark-sheet.mjs` already established what looking is
 * allowed to cost: a rasteriser over data the game itself uses, offline.
 *
 * **What this draws, and what it therefore cannot catch.** It draws the pure
 * profile -- `game/riding.stairTreads` and `game/riding.accessHeadhouse`, the
 * two functions `world/rail-geo.writeUndergroundStation` consumes and the ones
 * `StationBoxField.floorAt` stands a body on. So a riser too tall, a going too
 * short, a landing in the wrong place, a roof too low or too short, a lintel
 * hanging in the doorway: all visible here. What is *not* here is the winding
 * of the quads that geometry is turned into, because that lives in `rail-geo`
 * and needs three. A face drawn inside out is still a thing only the owner can
 * see, and this sheet does not claim otherwise.
 *
 * One row per flight shape, drawn to scale in section, with the street level,
 * the plane the passage was built round, and the headhouse over the top of it.
 * Writes `data/entrance-sheet.png`.
 *
 *   node scripts/render-entrance-sheet.mjs [--out path] [--px 1100]
 */
import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const OUT = arg('--out', path.join(ROOT, 'data/entrance-sheet.png'));
const W = Number(arg('--px', '1100'));

// `riding.ts` is TypeScript and three-free. Bun runs it directly; under node it
// needs the loader, which is what this line is for.
register('ts-node/esm', import.meta.url);
const riding = await import(path.join(ROOT, 'client/src/game/riding.ts'));
const { accessStair, stairTreads, accessHeadhouse, ACCESS_HALF_W, ACCESS_HEIGHT_M } = riding;

/** The flights worth looking at: the shallowest the bake holds, and the deepest. */
const CASES = [
  ['St Leonards, 7.5 m down a 12 m run', 7.5, 12],
  ['Cherrybrook, 8 m down a 12 m run', 8, 12],
  ['a typical CBD mouth, 15 m down 20 m', 15, 20],
  ['Museum, 19 m down a 25 m run', 19, 25],
  ['Victoria Cross, 33 m down a 44 m run', 33, 44],
];

const ROW = Math.round(W * 0.34);
const H = ROW * CASES.length;
const buf = Buffer.alloc(W * H * 3, 0x14);
const put = (x, y, r, g, b) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const o = (y * W + x) * 3;
  buf[o] = r; buf[o + 1] = g; buf[o + 2] = b;
};
const rect = (x0, y0, x1, y1, c) => {
  for (let y = Math.round(Math.min(y0, y1)); y <= Math.round(Math.max(y0, y1)); y++) {
    for (let x = Math.round(Math.min(x0, x1)); x <= Math.round(Math.max(x0, x1)); x++) put(x, y, ...c);
  }
};
const line = (x0, y0, x1, y1, c) => {
  const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))) + 1;
  for (let i = 0; i <= n; i++) put(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), ...c);
};

const GROUND = [58, 54, 48];
const PLANE = [70, 60, 40];
const TREAD = [186, 182, 172];
const LANDING = [232, 176, 96];
const HOUSE = [128, 132, 140];
const SOFFIT = [96, 150, 190];
const LAMP = [250, 230, 140];

CASES.forEach(([label, drop, run], row) => {
  const plan = {
    mouthX: 0, mouthZ: 0, mouthY: drop, dirX: 0, dirZ: 1, inclineM: run,
    footX: 0, footZ: run, floorY: 0, tunDirX: 1, tunDirZ: 0, tunnelM: 8,
  };
  const s = accessStair(plan);
  const house = accessHeadhouse(plan);
  const treads = stairTreads(s);
  // The frame: the whole run plus the headhouse's lap, the whole drop plus the
  // roof, with a margin. One scale for both axes, or a staircase is a lie.
  const dLo = house.front - 2;
  const dHi = run + 3;
  const yLo = -2;
  const yHi = house.roofY - drop + drop + 2 - drop; // roof over the mouth
  const yTop = drop + (house.roofY - plan.mouthY) + 2;
  const scale = Math.min((W - 90) / (dHi - dLo), (ROW - 40) / (yTop - yLo));
  const y0 = row * ROW + ROW - 20;
  const px = (d) => 60 + (d - dLo) * scale;
  const py = (y) => y0 - (y - yLo) * scale;
  void yHi;

  // The street, and the plane the passage was built round.
  line(px(dLo), py(drop), px(0), py(drop), GROUND);
  line(px(0), py(drop), px(run), py(0), PLANE);
  // The flight.
  for (let k = 0; k < treads.length; k++) {
    const t = treads[k];
    const yT = drop - t.drop;
    const yN = k + 1 < treads.length ? drop - treads[k + 1].drop : 0;
    rect(px(t.d0), py(yT), px(t.d1), py(yT) + 1, t.landing ? LANDING : TREAD);
    line(px(t.d1), py(yT), px(t.d1), py(yN), t.landing ? LANDING : TREAD);
  }
  // The flat at the foot, into the tunnel.
  rect(px(run), py(0), px(dHi), py(0) + 1, TREAD);
  // The headhouse. This is a section down the passage's centreline, so the
  // side walls are *parallel* to it and only their two end faces cross it --
  // drawn as the thin uprights at either end, which is why the front reads as
  // open. The roof slab and the lintel do cross, and so does the lamp.
  const hy = (y) => py(y);
  line(px(house.front), hy(house.soffitY), px(house.front), hy(house.baseY), HOUSE);
  rect(px(house.back) - 2, hy(house.soffitY), px(house.back), hy(house.baseY), HOUSE);
  rect(px(house.front), hy(house.roofY), px(house.back), hy(house.soffitY), HOUSE);
  rect(px(house.lintelD), hy(house.roofY), px(house.lintelD + house.lintelDepth), hy(house.lintelY), SOFFIT);
  rect(px(house.lampD) - 2, hy(house.lampY) - 2, px(house.lampD) + 2, hy(house.lampY) + 2, LAMP);
  // The passage lid, so the headhouse can be seen to cover the proud part of it.
  line(px(0), py(drop + ACCESS_HEIGHT_M), px(run), py(ACCESS_HEIGHT_M), PLANE);
  // A one-metre bar, because every row has its own scale.
  rect(px(dLo) + 4, y0 - 6, px(dLo) + 4 + scale, y0 - 4, [220, 220, 220]);

  console.log(
    `${label}: ${s.risers} risers of ${s.riser.toFixed(3)} m, going ${s.going.toFixed(3)} m, ` +
    `${s.landings} landing(s) of ${s.landing.toFixed(1)} m every ${s.perFlight} risers, ` +
    `dip ${s.dip.toFixed(2)} m, roof ${(house.soffitY - plan.mouthY).toFixed(2)} m clear over ` +
    `${(house.back - house.front).toFixed(1)} m, opening ${(2 * house.clearHalfW).toFixed(2)} m wide ` +
    `against a ${(2 * ACCESS_HALF_W).toFixed(2)} m passage`,
  );
});

await sharp(buf, { raw: { width: W, height: H, channels: 3 } }).png().toFile(OUT);
console.log(`wrote ${OUT} (${W}x${H}), one row per case, top to bottom in the order above`);
