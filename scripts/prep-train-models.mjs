#!/usr/bin/env node
/**
 * Prepares the two sourced Sydney train models for shipping.
 *
 * Reads `data/vehicles/trains/{tangara,metropolis}.glb` -- two 25 MB Sketchfab
 * exports at ~190k triangles each -- and writes normalised, de-badged, texture-
 * reduced copies to `client/public/trains/`, plus the `manifest.json` that
 * `client/src/world/trains.ts` reads to know where one carriage ends and the
 * next begins.
 *
 * Run with the repo's node 22:
 *   export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"
 *   node scripts/prep-train-models.mjs
 *
 * `--audit` writes before/after crops of every badge rectangle to
 * `client/public/trains/.audit/` instead of shipping anything, which is how the
 * rectangles below were placed and is the only honest way to check that a
 * removal removed the mark and not the panel it was painted on.
 *
 * ---------------------------------------------------------------------------
 * 1. WHAT THESE FILES ACTUALLY CONTAIN, which is not one train each.
 *
 * Measured, not assumed (`getBounds` on every mesh node in the scene):
 *
 *   tangara.glb    two complete 2-car sets side by side in Z: a standard-livery
 *                  set at z ~ 0 and a Pride-livery set at z ~ -11. Each set is a
 *                  driving car (x -10.1 .. 10.3, 20.4 m) and an intermediate car
 *                  (x -29.2 .. -10.0, 19.1 m). 191,537 tris, 17 textures, one
 *                  10.4 s door animation over 32 door leaves.
 *   metropolis.glb one 3-car set along X: a lead car (x -9.9 .. 13.3), a
 *                  pantograph car (-31.7 .. -9.8) and a trailer (-53.6 ..
 *                  -31.7), ~22 m each. 180,535 tris, 20 textures, no animation,
 *                  but 110 separately-named meshes including every door leaf
 *                  and every pantograph joint.
 *
 * Both are already **+X nose, +Y up, real metres** -- the Tangara driving car
 * measures 20.36 m against the real vehicle's 20.4 -- so unlike the cars there
 * is no rotation and no scale to apply, and that matters for more than tidiness:
 * scaling would have to scale the animation's translation keys too, and the
 * whole reason this file leaves the node hierarchy alone is that the two
 * Sketchfab wrapper rotations compose to the identity and the door nodes' local
 * translations are therefore already car-frame metres.
 *
 * So "normalising" here is **splitting**: the manifest names, per carriage, the
 * mesh nodes that belong to it and the X offset that puts its centre on the
 * origin. The client instantiates a carriage by cloning those nodes into a group
 * translated by `-centreX`. One GLB per model rather than one per carriage,
 * because the carriages of a set share every texture in the file and four copies
 * of an 11 MB atlas is the only way to make this feature expensive.
 *
 * ---------------------------------------------------------------------------
 * 2. TRADE DRESS. Same rule the cars follow and for the same reason: the game
 * satirises Sydney, it does not counterfeit a NSW Government livery. Every mark
 * removed is listed in the report and in `manifest.json`'s `removed` array, with
 * the pixel rectangle it occupied, so the claim is checkable rather than
 * asserted.
 *
 * What is removed is the *operator's marks*: the Sydney Trains swoosh, the
 * Transport for NSW waratah and wordmark, the green Metro nameplate, the
 * TANGARA fleet wordmark, and the "Ride with Pride" campaign wording. What is
 * **kept** is the shape, the warm grey and yellow, the blue and the rainbow --
 * a rainbow is not trade dress, and the Pride set with no operator on it is
 * still the recognisable thing.
 *
 * Removal is a per-row background fill rather than a blur or a clone stamp,
 * because every one of these marks sits on a locally flat field: white text on
 * the black glazing band, dark text on a cream cab fillet, orange on grey body.
 * For each row of the rectangle the fill colour is the median of that row's own
 * background pixels -- selected by luminance for text on a plain field and by
 * saturation for the orange logo, since the swoosh and the grey it sits on have
 * nearly the same luminance and differ only in chroma. That reproduces the
 * panel's own horizontal striping and leaves no rectangle edge.
 *
 * ---------------------------------------------------------------------------
 * 3. TEXTURES, which are the whole file size. 17 and 20 uncompressed PNGs at
 * 1024^2 is 23 MB across the two models, on a client bundle that is otherwise
 * a few hundred kB. They are re-encoded here: base colour for the exterior stays
 * at 1024 because these are hero assets the player stands next to, everything
 * else drops to 512, and anything with no meaningful alpha becomes JPEG. Normal
 * maps take a higher quality than albedo because a blocked normal map reads as
 * dents in flat steel.
 *
 * No Draco and no meshopt, on `prep-car-models.mjs`'s argument.
 */

import { NodeIO } from '@gltf-transform/core';
import { dedup, prune, quantize, weld } from '@gltf-transform/functions';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'data/vehicles/trains');
const OUT_DIR = path.join(ROOT, 'client/public/trains');
const AUDIT_DIR = path.join(OUT_DIR, '.audit');
const AUDIT = process.argv.includes('--audit');

// --- Texture policy -------------------------------------------------------------

/** Exterior base colour: the one the player's nose is against. */
const HERO_SIZE = 1024;
/** Everything else: interiors, roughness, occlusion, normals, glass. */
const PLAIN_SIZE = 512;
const ALBEDO_QUALITY = 84;
/** Normals block up badly at album quality; a blocked normal is dents in steel. */
const NORMAL_QUALITY = 92;
/** Alpha below this over the whole image counts as "no alpha" and takes JPEG. */
const ALPHA_OPAQUE_MIN = 250;

// --- The marks ------------------------------------------------------------------

/**
 * One trade-dress rectangle: `[x0, y0, x1, y1]` in texture pixels at the source
 * 1024^2, the background-selection rule, and what the mark is.
 *
 * `pick` decides which pixels of each row count as background:
 *   'dark'  keep the darkest 45% -- light text on the glazing band
 *   'light' keep the brightest 45% -- dark text on a cream fillet
 *   'desat' keep the least saturated 45% -- the orange swoosh on grey body
 */
const MARKS = {
  'tangara.glb': {
    // `exterior`: the standard-livery body atlas, both carriages.
    0: [
      [[136, 119, 179, 158], 'desat', 'Sydney Trains swoosh + wordmark, no. 1 side'],
      [[838, 327, 888, 366], 'desat', 'Sydney Trains swoosh + wordmark, no. 2 side'],
      [[456, 119, 624, 156], 'dark', 'TANGARA fleet wordmark, no. 1 side'],
      [[452, 327, 624, 366], 'dark', 'TANGARA fleet wordmark, no. 2 side'],
    ],
    // `exterior_pride`: the Pride-livery driving car.
    8: [
      [[493, 122, 792, 167], 'dark', '"Ride with Pride" campaign wordmark, no. 1 side'],
      [[251, 330, 534, 369], 'dark', '"Ride with Pride" campaign wordmark, no. 2 side'],
      [[888, 102, 1024, 124], 'dark', '"Proud supporter of your journey", no. 1 side'],
      [[0, 311, 139, 330], 'dark', '"Proud supporter of your journey", no. 2 side'],
      [[122, 117, 198, 159], 'desat', 'Sydney Trains swoosh, Pride variant, no. 1 side'],
      [[826, 326, 902, 366], 'desat', 'Sydney Trains swoosh, Pride variant, no. 2 side'],
    ],
    // `exterior_middle_pride`: the Pride-livery intermediate car.
    13: [
      [[403, 121, 682, 162], 'dark', '"Ride with Pride" campaign wordmark, no. 1 side'],
      [[342, 330, 622, 370], 'dark', '"Ride with Pride" campaign wordmark, no. 2 side'],
      [[888, 102, 1024, 124], 'dark', '"Proud supporter of your journey", no. 1 side'],
      [[0, 311, 139, 330], 'dark', '"Proud supporter of your journey", no. 2 side'],
      [[122, 117, 198, 159], 'desat', 'Sydney Trains swoosh, Pride variant, no. 1 side'],
      [[838, 326, 884, 366], 'desat', 'Sydney Trains swoosh, Pride variant, no. 2 side'],
    ],
  },
  'metropolis.glb': {
    // `exterior` / `exterior_panto`: the cab fillets carry both cab-end marks.
    0: [
      [
        [728, 102, 804, 139],
        'light',
        'NSW waratah crest + Transport for NSW wordmark + green Metro nameplate, no. 1 end',
      ],
      [
        [89, 493, 162, 531],
        'light',
        'NSW waratah crest + Transport for NSW wordmark + green Metro nameplate, no. 2 end',
      ],
    ],
  },
};

// --- Carriage splitting ----------------------------------------------------------

/**
 * How each file's mesh nodes are cut into carriages.
 *
 * `rows` splits on Z first (the Tangara's two liveries stand side by side);
 * `cuts` splits each row on X at the gaps between vehicles, measured from the
 * bounds printed by the audit pass. A node lands in the carriage its own bounding
 * box *centre* falls in, so a mesh that straddles a cut by a coupler's width
 * still belongs to exactly one vehicle.
 */
const SPLITS = {
  'tangara.glb': {
    rows: [
      { test: (z) => z > -5.5, tag: '' },
      { test: (z) => z <= -5.5, tag: '_pride' },
    ],
    cuts: [
      { from: -10.05, to: 10.5, key: 'cab' },
      { from: -29.5, to: -10.05, key: 'mid' },
    ],
    /** Nominal over-couplers length used for spacing carriages in a consist. */
    pitch: 20.4,
  },
  'metropolis.glb': {
    rows: [{ test: () => true, tag: '' }],
    cuts: [
      { from: -10.5, to: 13.5, key: 'lead' },
      { from: -32.6, to: -10.5, key: 'mid' },
      { from: -54.0, to: -32.6, key: 'trail' },
    ],
    pitch: 22.0,
  },
};

/** Node-name patterns that make a node a sliding door leaf. */
const DOOR_RE = /(^|[._])door|^Door/i;

/**
 * `PropertyBinding.sanitizeNodeName`, restated. Three's `GLTFLoader` runs every
 * node name through it -- `[ ] . : /` are reserved for animation track binding
 * syntax and whitespace becomes an underscore -- so the names the client sees
 * are not the names in the file, and anything this manifest keys by name has to
 * be keyed by the client's spelling.
 */
function sanitizeNodeName(name) {
  return name.replace(/\s/g, '_').replace(/[[\].:/]/g, '');
}

// --- World bounds, walked here rather than taken from `getBounds` -----------------
//
// `getBounds(node)` was measured against these files and does **not** carry the
// door leaves' own node rotation the way three's `Box3.setFromObject` will: every
// leaf on both models comes back as a horizontal plate 2.3 m wide, which put the
// Tangara driving car's reported width at 5.3 m against the 3.16 m its body
// actually is. The carriage *assignment* survives that (a leaf's centre is still
// inside its own vehicle), but the box is what the impostor is sized from, so it
// is composed here from the scene root down and nothing is taken on trust.

function mat4Multiply(a, b) {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

/** Column-major TRS, the same composition order glTF specifies (T * R * S). */
function trsMatrix(node) {
  const [x, y, z, w] = node.getRotation();
  const [sx, sy, sz] = node.getScale();
  const [tx, ty, tz] = node.getTranslation();
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return new Float64Array([
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ]);
}

const IDENTITY = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** The world AABB of one node's own meshes, given its composed world matrix. */
function meshWorldBounds(node, world) {
  const mesh = node.getMesh();
  if (!mesh) return null;
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    if (!pos) continue;
    const v = [0, 0, 0];
    for (let i = 0; i < pos.getCount(); i++) {
      pos.getElement(i, v);
      for (let axis = 0; axis < 3; axis++) {
        const p =
          world[axis] * v[0] + world[4 + axis] * v[1] + world[8 + axis] * v[2] + world[12 + axis];
        if (p < box.min[axis]) box.min[axis] = p;
        if (p > box.max[axis]) box.max[axis] = p;
      }
    }
  }
  return Number.isFinite(box.min[0]) ? box : null;
}

// --- Small helpers ---------------------------------------------------------------

function fmtBytes(n) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} kB`;
}

/** Luminance in the same weighting the badge detector used. */
function lum(r, g, b) {
  return (r * 3 + g * 6 + b) / 10;
}

/**
 * Fill one rectangle with its own rows' background, in place.
 *
 * Row by row rather than as one flat colour: the glazing band has horizontal
 * striping and the cab fillet has a vertical gradient, and a single fill over a
 * 40-row rectangle leaves a visible plate on both.
 */
function scrub(pixels, width, rect, pick) {
  const [x0, y0, x1, y1] = rect;
  const margin = 26;
  for (let y = y0; y < y1; y++) {
    // Sample the rectangle's own row plus a margin either side, so a rectangle
    // that is mostly mark still has enough clean pixels to take a median from.
    const sx0 = Math.max(0, x0 - margin);
    const sx1 = Math.min(width, x1 + margin);
    const rows = [];
    for (let x = sx0; x < sx1; x++) {
      const i = (y * width + x) * 4;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const score =
        pick === 'dark' ? lum(r, g, b) : pick === 'light' ? -lum(r, g, b) : mx === 0 ? 0 : (mx - mn) / mx;
      rows.push({ score, r, g, b });
    }
    rows.sort((a, b) => a.score - b.score);
    const keep = rows.slice(0, Math.max(1, Math.round(rows.length * 0.45)));
    const mid = keep[keep.length >> 1];
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      pixels[i] = mid.r;
      pixels[i + 1] = mid.g;
      pixels[i + 2] = mid.b;
    }
  }
}

/** True when the image's alpha channel says anything at all. */
function hasAlpha(pixels) {
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < ALPHA_OPAQUE_MIN) return true;
  return false;
}

/** Which slot(s) of which material a texture is used in -- decides its budget. */
function textureRoles(doc) {
  const roles = new Map();
  const add = (tex, role) => {
    if (!tex) return;
    if (!roles.has(tex)) roles.set(tex, new Set());
    roles.get(tex).add(role);
  };
  for (const m of doc.getRoot().listMaterials()) {
    add(m.getBaseColorTexture(), `base:${m.getName()}`);
    add(m.getMetallicRoughnessTexture(), 'mr');
    add(m.getNormalTexture(), 'normal');
    add(m.getOcclusionTexture(), 'occlusion');
    add(m.getEmissiveTexture(), 'emissive');
  }
  return roles;
}

// --- Per-file pipeline -------------------------------------------------------------

async function processFile(file) {
  const io = new NodeIO().setStrictResources(false);
  const doc = await io.read(path.join(SRC_DIR, file));
  const root = doc.getRoot();
  const scene = root.listScenes()[0];
  const report = { file, removed: [], textures: [], cars: [], doors: {}, warnings: [] };

  // --- Textures: de-badge, then re-encode. -------------------------------------
  const marks = MARKS[file] ?? {};
  const roles = textureRoles(doc);
  const textures = root.listTextures();

  for (let i = 0; i < textures.length; i++) {
    const tex = textures[i];
    const image = tex.getImage();
    if (!image) {
      report.warnings.push(`texture ${i} has no image`);
      continue;
    }
    const role = [...(roles.get(tex) ?? ['unused'])].join('+');
    const before = image.byteLength;

    let pipe = sharp(Buffer.from(image));
    const meta = await pipe.metadata();
    const rects = marks[i] ?? [];

    if (rects.length > 0) {
      const { data, info } = await pipe.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      // The rectangles were measured on the source 1024^2; scale if a source
      // image ever arrives at another size rather than silently mis-placing them.
      const sx = info.width / 1024;
      const sy = info.height / 1024;
      if (AUDIT) {
        fs.mkdirSync(AUDIT_DIR, { recursive: true });
        for (let k = 0; k < rects.length; k++) {
          const [r] = rects[k];
          await cropOut(data, info, r, sx, sy, `${file}.tex${i}.${k}.before.png`);
        }
      }
      for (const [rect, pick, what] of rects) {
        const scaled = [
          Math.round(rect[0] * sx),
          Math.round(rect[1] * sy),
          Math.round(rect[2] * sx),
          Math.round(rect[3] * sy),
        ];
        scrub(data, info.width, scaled, pick);
        report.removed.push({ texture: i, role, rect, what });
      }
      if (AUDIT) {
        for (let k = 0; k < rects.length; k++) {
          const [r] = rects[k];
          await cropOut(data, info, r, sx, sy, `${file}.tex${i}.${k}.after.png`);
        }
      }
      pipe = sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } });
    }

    // Budget: the exterior albedo is the only thing worth 1024.
    const hero = /base:exterior/.test(role);
    const target = Math.min(hero ? HERO_SIZE : PLAIN_SIZE, meta.width ?? HERO_SIZE);
    const raw = await pipe
      .resize(target, target, { fit: 'fill' })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const keepAlpha = hasAlpha(raw.data);
    const quality = role.includes('normal') ? NORMAL_QUALITY : ALBEDO_QUALITY;
    const out = keepAlpha
      ? await sharp(raw.data, { raw: { width: target, height: target, channels: 4 } })
          .png({ compressionLevel: 9, palette: false })
          .toBuffer()
      : await sharp(raw.data, { raw: { width: target, height: target, channels: 4 } })
          .removeAlpha()
          .jpeg({ quality, mozjpeg: true })
          .toBuffer();

    tex.setImage(out);
    tex.setMimeType(keepAlpha ? 'image/png' : 'image/jpeg');
    tex.setURI('');
    report.textures.push({
      index: i,
      role,
      size: target,
      mime: keepAlpha ? 'png' : 'jpeg',
      before,
      after: out.byteLength,
    });
  }

  // --- Doors: the open displacement, taken from the clip where there is one. ----
  //
  // The Tangara's 250-key, 10.4 s clip is one linear slide per leaf and nothing
  // else, so its extremes *are* the door travel; taking them here means the
  // client's procedural slide is the animator's number rather than a guess, and
  // costs no `AnimationMixer` per carriage at run time. Nodes the clip does not
  // mention -- which is every door on the Metropolis -- fall through to the
  // geometric derivation in `trains.ts`, which the two agree on to within 4 cm.
  for (const anim of root.listAnimations()) {
    for (const ch of anim.listChannels()) {
      if (ch.getTargetPath() !== 'translation') continue;
      const node = ch.getTargetNode();
      if (!node || !DOOR_RE.test(node.getName())) continue;
      const out = ch.getSampler().getOutput();
      const arr = out.getArray();
      const n = out.getCount();
      let best = 0;
      let bi = 0;
      for (let k = 0; k < n; k++) {
        const d = Math.hypot(arr[k * 3] - arr[0], arr[k * 3 + 1] - arr[1], arr[k * 3 + 2] - arr[2]);
        if (d > best) {
          best = d;
          bi = k;
        }
      }
      if (best < 0.05) continue;
      // Keyed by the name the *loader* will produce, not the name in the file.
      // See the `box` comment below on `sanitizeNodeName`.
      report.doors[sanitizeNodeName(node.getName())] = [
        +(arr[bi * 3] - arr[0]).toFixed(4),
        +(arr[bi * 3 + 1] - arr[1]).toFixed(4),
        +(arr[bi * 3 + 2] - arr[2]).toFixed(4),
      ];
    }
  }

  // --- Bake the clip's first frame into the rest pose, and this is not tidiness.
  //
  // Every one of the Tangara's 32 door leaves carries a **rotation channel with a
  // single identity key** and a node whose authored rotation is -90 degrees about
  // X. Composed down the hierarchy that leaves the leaf lying flat: measured, the
  // driving car's door panels come out as horizontal 1.1 x 2.27 m plates at sill
  // height, 2.3 m outboard of the body, which is why the standard set's bounding
  // box was 5.3 m wide against a 3.16 m car. The file only ever looks right
  // because the viewer autoplays the clip and frame one stands the doors up.
  //
  // So the clip's t=0 sample is the model's real rest pose, and it is written
  // into the nodes here. Deleting the animation without doing this would ship
  // thirty-two flat doors.
  for (const anim of root.listAnimations()) {
    for (const ch of anim.listChannels()) {
      const node = ch.getTargetNode();
      const path = ch.getTargetPath();
      if (!node) continue;
      const out = ch.getSampler().getOutput();
      const arr = out.getArray();
      const size = out.getElementSize();
      const first = Array.from(arr.slice(0, size), Number);
      if (path === 'translation') node.setTranslation(first);
      else if (path === 'rotation') node.setRotation(first);
      else if (path === 'scale') node.setScale(first);
    }
  }
  // And now the clip goes: it is 32 leaves x 250 keys of a slide the client holds
  // three numbers for, and an `AnimationMixer` per carriage of an eight-car train
  // is eight mixers a frame for a door that is either shut or 1 m open.
  for (const anim of [...root.listAnimations()]) anim.dispose();

  // --- Carriages: which mesh node belongs to which vehicle. ---------------------
  const split = SPLITS[file];
  const nodes = [];
  const walk = (n, parent) => {
    const world = mat4Multiply(parent, trsMatrix(n));
    const b = meshWorldBounds(n, world);
    if (b) {
      nodes.push({
        node: n,
        name: n.getName(),
        cx: (b.min[0] + b.max[0]) / 2,
        cz: (b.min[2] + b.max[2]) / 2,
        box: b,
      });
    }
    n.listChildren().forEach((c) => walk(c, world));
  };
  scene.listChildren().forEach((n) => walk(n, IDENTITY));

  const cars = new Map();
  for (const row of split.rows) {
    for (const cut of split.cuts) {
      cars.set(`${cut.key}${row.tag}`, { key: `${cut.key}${row.tag}`, nodes: [], box: null });
    }
  }
  for (const entry of nodes) {
    const row = split.rows.find((r) => r.test(entry.cz));
    const cut = split.cuts.find((c) => entry.cx >= c.from && entry.cx < c.to);
    if (!row || !cut) {
      report.warnings.push(
        `node ${entry.name} at x=${entry.cx.toFixed(2)} z=${entry.cz.toFixed(2)} is in no carriage`,
      );
      continue;
    }
    const car = cars.get(`${cut.key}${row.tag}`);
    car.nodes.push(entry.name);
    car.box = car.box
      ? {
          min: [
            Math.min(car.box.min[0], entry.box.min[0]),
            Math.min(car.box.min[1], entry.box.min[1]),
            Math.min(car.box.min[2], entry.box.min[2]),
          ],
          max: [
            Math.max(car.box.max[0], entry.box.max[0]),
            Math.max(car.box.max[1], entry.box.max[1]),
            Math.max(car.box.max[2], entry.box.max[2]),
          ],
        }
      : { min: [...entry.box.min], max: [...entry.box.max] };
  }

  // Geometry, which is the other twelve megabytes. `weld` first (these exports
  // carry unwelded triangle soup in places), then `dedup` over accessors and
  // textures only -- **not** materials, because `exterior` and `exterior_pride`
  // differ solely in which atlas they point at and a material merge would repaint
  // the Pride set in the standard livery. `quantize` last, on the four attributes
  // that have a natural fixed-point range; no Draco and no meshopt, on
  // `prep-car-models.mjs`'s argument.
  await doc.transform(
    weld(),
    prune(),
    quantize({ pattern: /^(POSITION|NORMAL|TEXCOORD_0|TANGENT)$/ }),
  );

  for (const car of cars.values()) {
    if (car.nodes.length === 0) {
      report.warnings.push(`carriage ${car.key} has no nodes`);
      continue;
    }
    report.cars.push({
      key: car.key,
      // The X that puts the carriage's own centre on the origin, so the client
      // clones the nodes into a group at -centreX and gets a vehicle whose
      // origin is its middle and whose nose is +X.
      centreX: +((car.box.min[0] + car.box.max[0]) / 2).toFixed(4),
      lengthM: +(car.box.max[0] - car.box.min[0]).toFixed(3),
      widthM: +(car.box.max[2] - car.box.min[2]).toFixed(3),
      heightM: +car.box.max[1].toFixed(3),
      railY: +car.box.min[1].toFixed(4),
      /**
       * The carriage's own world box in the file, and **this is what the client
       * splits on, not the node list.**
       *
       * `GLTFLoader.createUniqueName` runs every node name through
       * `PropertyBinding.sanitizeNodeName`, which strips `[ ] . : /` and then
       * appends `_N` on any collision the stripping caused -- so
       * `DoorLeftA.001` reaches the client as `DoorLeftA001` and a name the
       * manifest recorded from the glTF is not necessarily the name the loader
       * produced. Matching a mesh to its carriage by *where it is* cannot drift
       * that way, and it is the same rule this script used above.
       *
       * The node list stays in the manifest because it is the record of what
       * went where, and it is what a mismatch is diagnosed against.
       */
      box: {
        minX: +car.box.min[0].toFixed(4),
        maxX: +car.box.max[0].toFixed(4),
        minZ: +car.box.min[2].toFixed(4),
        maxZ: +car.box.max[2].toFixed(4),
      },
      nodes: car.nodes,
    });
  }

  if (AUDIT) return { report, bytes: 0 };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const glb = await new NodeIO().writeBinary(doc);
  fs.writeFileSync(path.join(OUT_DIR, file), glb);
  return { report, bytes: glb.byteLength };
}

/** Write one badge rectangle out at 6x for eyeballing. Audit mode only. */
async function cropOut(data, info, rect, sx, sy, name) {
  const left = Math.max(0, Math.round((rect[0] - 12) * sx));
  const top = Math.max(0, Math.round((rect[1] - 12) * sy));
  const width = Math.min(info.width - left, Math.round((rect[2] - rect[0] + 24) * sx));
  const height = Math.min(info.height - top, Math.round((rect[3] - rect[1] + 24) * sy));
  await sharp(Buffer.from(data), { raw: { width: info.width, height: info.height, channels: 4 } })
    .extract({ left, top, width, height })
    .resize(width * 6, height * 6, { kernel: 'nearest' })
    .png()
    .toFile(path.join(AUDIT_DIR, name));
}

// --- Main ----------------------------------------------------------------------

async function main() {
  if (!AUDIT) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    for (const f of fs.readdirSync(OUT_DIR)) {
      if (f.endsWith('.glb') || f === 'manifest.json') fs.unlinkSync(path.join(OUT_DIR, f));
    }
  }

  const manifest = { models: [], removed: [] };
  for (const file of ['tangara.glb', 'metropolis.glb']) {
    const src = path.join(SRC_DIR, file);
    if (!fs.existsSync(src)) {
      console.error(`${file}: not found in ${SRC_DIR}`);
      process.exitCode = 1;
      continue;
    }
    const srcBytes = fs.statSync(src).size;
    const { report, bytes } = await processFile(file);

    console.log(`\n=== ${file} ===`);
    console.log(`  source ${fmtBytes(srcBytes)} -> shipped ${fmtBytes(bytes)}`);
    console.log(`  carriages:`);
    for (const c of report.cars) {
      console.log(
        `    ${c.key.padEnd(12)} ${c.lengthM} x ${c.widthM} x ${c.heightM} m, ` +
          `centreX ${c.centreX}, railY ${c.railY}, ${c.nodes.length} nodes`,
      );
    }
    console.log(`  trade dress removed (${report.removed.length}):`);
    for (const r of report.removed) {
      console.log(`    tex${r.texture} [${r.rect.join(',')}] ${r.what}`);
    }
    const texBefore = report.textures.reduce((s, t) => s + t.before, 0);
    const texAfter = report.textures.reduce((s, t) => s + t.after, 0);
    console.log(
      `  textures: ${report.textures.length}, ${fmtBytes(texBefore)} -> ${fmtBytes(texAfter)}`,
    );
    console.log(`  door leaves with a clip displacement: ${Object.keys(report.doors).length}`);
    for (const w of report.warnings) console.log(`  WARNING: ${w}`);

    manifest.models.push({
      file,
      pitch: SPLITS[file].pitch,
      cars: report.cars,
      doors: report.doors,
    });
    manifest.removed.push(...report.removed.map((r) => ({ file, ...r })));
  }

  if (AUDIT) {
    console.log(`\nAudit crops in ${AUDIT_DIR}. Nothing was shipped.`);
    return;
  }

  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const dirBytes = fs
    .readdirSync(OUT_DIR)
    .filter((f) => !f.startsWith('.'))
    .reduce((s, f) => s + fs.statSync(path.join(OUT_DIR, f)).size, 0);
  console.log(`\nclient/public/trains/ total on disk: ${fmtBytes(dirBytes)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
