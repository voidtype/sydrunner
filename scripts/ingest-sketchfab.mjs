#!/usr/bin/env node
/**
 * Turns a Sketchfab glTF archive into a source `.glb` the car pipeline reads.
 *
 * `data/vehicles/incoming/<name>/scene.gltf` (+ scene.bin + textures/), as
 * Sketchfab's "gltf" download unpacks, becomes `data/vehicles/models/<name>.glb`
 * with every texture shrunk to at most 512 px and re-encoded (JPEG where the
 * image has no alpha, PNG where it does), and a row merged into
 * `data/vehicles/models/manifest.json` from `data/vehicles/incoming/sources.json`
 * (licence, attribution, source URL, the target vehicle). Nothing about the
 * geometry changes here -- node names are what `prep-car-models.mjs` reads
 * to find the nose and the steering wheel, so they have to survive to it.
 *
 * Why the textures shrink here rather than in prep: the archives carry
 * 2-4K maps (the HiLux alone is 64 MB unpacked), and the whole shipped car set
 * has a byte budget. 512 px is what a parked car ten metres away resolves to.
 *
 * Run with the repo's node 22:
 *   node scripts/ingest-sketchfab.mjs            # every incoming dir
 *   node scripts/ingest-sketchfab.mjs toyota_prado_2013
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { textureCompress, dedup, prune } from '@gltf-transform/functions';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IN_DIR = path.join(ROOT, 'data/vehicles/incoming');
const OUT_DIR = path.join(ROOT, 'data/vehicles/models');
const OUT_MANIFEST = path.join(OUT_DIR, 'manifest.json');
const SOURCES = path.join(IN_DIR, 'sources.json');
const MAX_TEX = 512;

async function ingest(name, sources, manifest) {
  const dir = path.join(IN_DIR, name);
  const gltf = fs.readdirSync(dir).find((f) => f.endsWith('.gltf'));
  if (!gltf) throw new Error(`${name}: no .gltf in ${dir}`);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(path.join(dir, gltf));
  const before = doc.getRoot().listTextures().map((t) => t.getImage()?.byteLength ?? 0).reduce((a, b) => a + b, 0);
  // Alpha stays PNG; everything else is a JPEG. Decided per texture on the
  // decoded image, not the file name, because Sketchfab exports every map as
  // PNG whether it has an alpha channel or not.
  for (const tex of doc.getRoot().listTextures()) {
    const img = tex.getImage();
    if (!img) continue;
    const meta = await sharp(Buffer.from(img)).metadata();
    const hasAlpha = meta.hasAlpha === true;
    const out = await sharp(Buffer.from(img))
      .resize({ width: MAX_TEX, height: MAX_TEX, fit: 'inside', withoutEnlargement: true })
      [hasAlpha ? 'png' : 'jpeg'](hasAlpha ? { compressionLevel: 9 } : { quality: 82, mozjpeg: true })
      .toBuffer();
    tex.setImage(new Uint8Array(out));
    tex.setMimeType(hasAlpha ? 'image/png' : 'image/jpeg');
    if (tex.getURI()) tex.setURI(tex.getURI().replace(/\.[a-z]+$/i, hasAlpha ? '.png' : '.jpg'));
  }
  await doc.transform(dedup(), prune());
  const after = doc.getRoot().listTextures().map((t) => t.getImage()?.byteLength ?? 0).reduce((a, b) => a + b, 0);
  const outFile = `${name}.glb`;
  const glb = await io.writeBinary(doc);
  fs.writeFileSync(path.join(OUT_DIR, outFile), glb);
  const src = sources[name];
  if (!src) throw new Error(`${name}: no row in ${SOURCES}`);
  manifest[outFile] = {
    target_vehicle: src.target_vehicle,
    license: src.license,
    attribution: src.attribution,
    source_url: src.source_url,
    tri_count: null,
    tri_count_method: 'measured by prep-car-models.mjs after decimation',
    badging: src.badging ?? 'unknown',
    model_year: src.model_year,
    ingested_from: `sketchfab gltf archive, textures resized to ${MAX_TEX} px`,
  };
  console.log(`${outFile}: textures ${(before / 1048576).toFixed(1)} MB -> ${(after / 1048576).toFixed(2)} MB, glb ${(glb.byteLength / 1048576).toFixed(2)} MB`);
}

async function main() {
  const sources = JSON.parse(fs.readFileSync(SOURCES, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(OUT_MANIFEST, 'utf8'));
  const only = process.argv.slice(2);
  const names = fs.readdirSync(IN_DIR).filter((f) => fs.statSync(path.join(IN_DIR, f)).isDirectory() && (only.length === 0 || only.includes(f)));
  for (const name of names) {
    try {
      await ingest(name, sources, manifest);
    } catch (err) {
      console.error(`${name}: FAILED ${err.message}`);
      process.exitCode = 1;
    }
  }
  fs.writeFileSync(OUT_MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
}
main();
