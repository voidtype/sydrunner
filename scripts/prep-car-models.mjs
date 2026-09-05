#!/usr/bin/env node
/**
 * Prepares the sourced 3D car models for shipping.
 *
 * Reads `data/vehicles/models/*.glb` (40 sourced free models, see
 * `data/vehicles/models/manifest.json` and `data/vehicles/sourcing.csv` for
 * provenance), optimizes and normalizes each one to the game's own car
 * convention, curates 3-6 per body class plus the specials, and writes the
 * result to `client/public/cars/` (tracked; `data/` is not). It also emits
 * the CC-BY attribution surface: `client/public/credits.html` and
 * `CREDITS.md`, both generated from the manifest this script writes.
 *
 * Run with the repo's node 22:
 *   export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"
 *   node scripts/prep-car-models.mjs
 *
 * ---------------------------------------------------------------------------
 * THE GAME'S CONVENTION, read from `client/src/world/cars.ts` and
 * `client/src/game/traffic.ts` rather than assumed:
 *
 *   - Local axes: **+X is the nose, +Y is up, +Z is the car's right**
 *     (`cars.ts`'s `Station` doc: "A rotation of `heading` about Y sends +X
 *     to world (cos h, 0, -sin h)").
 *   - Origin: footprint centre in X/Z, wheels at y=0. `buildTileCars` adds a
 *     2 cm carriageway clearance at *instancing* time, not baked into the
 *     model.
 *   - Length is `CAR_BODY_SIZE[body].length`, body 0-4 in the order sedan,
 *     hatch, SUV, ute, van (`traffic.ts`'s `CAR_BODY_SIZE`, matching
 *     `cars.ts`'s `BODY_SPEC`/`SEDAN..VAN` constants exactly).
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO MESH-SIMPLIFICATION STEP.
 *
 * The brief lists the cleanup pipeline explicitly -- weld, prune, dedup,
 * flatten -- and separately says "no Draco, no meshopt". `simplify()` is a
 * decimation function gltf-transform ships in the same `functions` package,
 * and it has a hard dependency on the `meshoptimizer` WASM simplifier -- the
 * same package that backs `meshopt()` compression. Reading "no meshopt" as
 * covering that dependency too (not just the `EXT_meshopt_compression`
 * transform) is the reading that keeps every processing step in this file
 * traceable to a named bullet in the brief, so triangle counts below are
 * exactly what each source file shipped, minus whatever separable interior
 * geometry got dropped. That is also *why* the 8,000-tri ceiling works as a
 * curation filter rather than a target to hit: the low-poly Kenney/Quaternius
 * end of the sourced set clears it standing still, and the handful of
 * detailed showcase models (a 33,706-tri Kia Rio, a 31,418-tri Range Rover)
 * do not, and are rejected rather than sanded down.
 */

import { NodeIO, getBounds } from '@gltf-transform/core';
import { weld, unweld, flatten, prune, dedup, quantize, transformMesh, join, normals } from '@gltf-transform/functions';
import sharp from 'sharp';
// The decimator. meshoptimizer is a dependency of three in the client tree
// rather than of this script, so it is reached by path; see the decimation
// stage in `processFile` for why it is here at all now.
import { MeshoptSimplifier } from '../client/node_modules/meshoptimizer/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'data/vehicles/models');
const SRC_MANIFEST_PATH = path.join(SRC_DIR, 'manifest.json');
const OUT_DIR = path.join(ROOT, 'client/public/cars');
const OUT_MANIFEST_PATH = path.join(OUT_DIR, 'manifest.json');
const CREDITS_HTML_PATH = path.join(ROOT, 'client/public/credits.html');
const CREDITS_MD_PATH = path.join(ROOT, 'CREDITS.md');

// --- Game conventions (see header) ---------------------------------------------

const CAR_BODY_SIZE = [
  { length: 4.6, width: 1.8, height: 1.45 }, // 0 sedan
  { length: 4.2, width: 1.75, height: 1.5 }, // 1 hatch
  { length: 4.7, width: 1.9, height: 1.7 },  // 2 SUV
  { length: 5.2, width: 1.85, height: 1.8 }, // 3 ute
  { length: 5.4, width: 1.9, height: 2.0 },  // 4 van
];
const BODY_NAMES = ['sedan', 'hatch', 'suv', 'ute', 'van'];

// --- Curation limits -------------------------------------------------------------

const MAX_TRIS = 8000;
/**
 * The sourced photoreal models (the Sydney mix of 2026-09: Ranger, HiLux,
 * Corolla and the rest) arrive at 180k-1.2M triangles and are decimated
 * to this before the gate runs. Higher than `MAX_TRIS` because a real car's
 * silhouette needs a few more triangles than a Kenney box does to stay a
 * Ranger, and lower than any of the "detailed showcase" rejects the header
 * talks about. A catalog row sets `decimate: true` to opt in.
 */
const DECIMATE_TO = 12000;
const DECIMATE_ERROR = 0.02;
/**
 * Islands under this fraction of the car's extent are dropped before the
 * collapse, unless a row says otherwise. 1.0 -- the whole car -- is what the
 * first round shipped with and what a one-shell body (the Ranger, the Camry)
 * wants: every bolt and badge goes and the shell stays. A body authored as
 * separate panels sets `pruneError: 0.02` in its CATALOG row, which is a
 * 10 cm bolt on a 5 m car and never a door. See the decimation stage.
 */
const PRUNE_ERROR = 1.0;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024; // was 6; eleven textured real cars at ~0.5-1 MB each
/**
 * Below this a class gets a warning, not a rejection.
 *
 * **Three classes are under it now and that is the shipped state**, not a
 * regression to fix by putting a generic back: the 2026-09 real-cars round cut
 * the passenger classes to real makes only, and body 4 has exactly one real van
 * on disk (the HiAce), body 0 two and body 1 two. The warning is still worth
 * printing -- it says how thin the mix has become, and one van for all of
 * Sydney is a fact somebody should keep meaning to fix -- but the answer is
 * sourcing a second real van, never re-admitting a stand-in.
 */
const MIN_PER_CLASS = 3;
const MAX_PER_CLASS = 8; // was 6; the real cars come first and the generics fill behind them
const LENGTH_TOLERANCE = 0.02; // 2%, per the verification brief
const Y_TOLERANCE = 0.02; // 2 cm, per the verification brief

/**
 * Curation table: one row per file in `data/vehicles/models/`. `body` is an
 * index into `CAR_BODY_SIZE`/`BODY_NAMES`, or one of the special strings.
 * `priority` orders preference *within* a body class, lowest first, used only
 * when a class has more technically-passing candidates than `MAX_PER_CLASS`
 * allows -- it is not a claim that a higher-priority file will necessarily
 * ship, since the tri/verification gate runs first and is measured, not
 * assumed. Every one of the 40 source files appears exactly once, including
 * the ones expected to fail the tri limit: silently omitting a file from this
 * table would be exactly the kind of silent rejection the brief says not to
 * do, so instead they are listed, attempted, and rejected on the record.
 *
 * ---------------------------------------------------------------------------
 * `standIn`, AND WHY IT IS A FLAG RATHER THAN A DELETED ROW.
 *
 * The owner, 2026-09: *"remove fake models keep the new real life ones"*. The
 * five passenger classes hold real makes only from that round on, so every
 * stylised or generic candidate for one of them carries `standIn: true` and is
 * refused before it is opened.
 *
 * A flag rather than a deletion for the reason the paragraph above already
 * gives about the tri limit: this table is the record of what was *considered*,
 * and a row quietly removed is a candidate that gets re-sourced in a year by
 * somebody who does not know it was looked at and turned down. It is also the
 * only way to be sure: `MAX_PER_CLASS` cuts on priority, so deleting six sedan
 * stand-ins would have promoted the seventh into the free slot.
 *
 * The **special** bodies -- bus, garbage, police, taxi -- keep their stand-ins,
 * and that is about the disk and not about taste: there is no real-make
 * alternative on it for any of the four roles, and a role whose only mesh is
 * refused is a role that can never be drawn. Their manifest rows say so.
 *
 * ---------------------------------------------------------------------------
 * `label`: WHAT THE PLAYER IS TOLD THEY ARE SITTING IN.
 *
 * Required on every row that can ship, and the run fails if one is missing --
 * because the alternative is a car that gets into the game and then has to be
 * named by somebody editing the generated manifest by hand, which is the one
 * file at the top of which it says not to. `client/src/game/carlabels.ts` holds
 * the same nineteen strings for the three-free side and states why there are
 * two copies; `carlod.loadCarModels` compares them at load.
 */
/** What the four special bodies' manifest rows say about their stand-in. */
const SPECIAL_NOTE =
  'No real-make alternative on disk for this role. The passenger classes (0-4) carry real makes ' +
  'only; the four special bodies keep a stylised stand-in because removing it would leave the ' +
  'role with no mesh at all.';

const CATALOG = [
  // --- The Sydney mix, sourced 2026-09 (data/vehicles/sourcing-2026-09-sydney-mix.csv):
  // the cars that are actually on the road here, one model year each, ahead
  // of every generic. `decimate` opts the row into the decimation stage.
  // `weight` is the car's share of the road in whole points (the owner's
  // list: Ranger 8, HiLux 8, ...); `carlod` repeats a model in its body's
  // pool that many times, and the generics below get 1 each.
  { file: 'ford_ranger_2023.glb', body: 3, priority: 0, decimate: true, weight: 8, label: 'Ford Ranger 2023' },
  // `pruneError`: bodies authored as separate panels lose them to the
  // island prune at the default; 2% keeps a door and drops a bolt. See the
  // decimation stage. The Ranger is one shell and takes the default.
  // `maxTris`: 345 meshes of panels that the 2% prune keeps and the collapse
  // then cannot fold below 38k. The most common ute in the country gets the
  // budget rather than the bin; 24 instances of it is under a million.
  { file: 'toyota_hilux_2021.glb', body: 3, priority: 0, decimate: true, weight: 8, pruneError: 0.02, positionsOnly: true, label: 'Toyota HiLux 2021' },
  // `paint`: the author's names are upside down -- "Interieur" is 45% of the
  // surface and is the body; the real cabin is "Siege". Pinned off the sheet.
  { file: 'mitsubishi_l200_dh.glb', body: 3, priority: 0, decimate: true, weight: 4, paint: ['Interieur', 'Body_gris'], pruneError: 0.02, label: 'Mitsubishi Triton' },
  { file: 'mazda_cx5_tnnv.glb', body: 2, priority: 0, decimate: true, weight: 5, label: 'Mazda CX-5' },
  // The body panels are the 37% material named `xtinner23`; `Car_Paint` is the
  // radar cover. Pinned off the sheet.
  { file: 'nissan_xtrail_2023.glb', body: 2, priority: 0, decimate: true, weight: 4, paint: ['xtinner23', 'Car_Paint'], pruneError: 0.02, maxTris: 40000, label: 'Nissan X-Trail 2023' },
  { file: 'hyundai_tucson_2015.glb', body: 2, priority: 0, decimate: true, weight: 3, label: 'Hyundai Tucson 2015' },
  // `positionsOnly`: every face its own island by UV, so nothing welds and
  // nothing collapses -- 89k triangles after the gentle prune. The maps go
  // (a light bar, a tyre) and the panels stay. See the decimation stage.
  { file: 'toyota_prado_2013.glb', body: 2, priority: 0, decimate: true, weight: 5, pruneError: 0.02, positionsOnly: true, label: 'Toyota LandCruiser Prado 2013' },
  { file: 'toyota_corolla_2020.glb', body: 1, priority: 0, decimate: true, weight: 5, label: 'Toyota Corolla 2020' },
  { file: 'tesla_model_3.glb', body: 0, priority: 0, decimate: true, weight: 4, label: 'Tesla Model 3' },
  { file: 'toyota_camry_2020.glb', body: 0, priority: 0, decimate: true, weight: 6, label: 'Toyota Camry 2020' },
  { file: 'toyota_hiace_2020.glb', body: 4, priority: 0, decimate: true, weight: 8, label: 'Toyota HiAce 2020' },
  // --- sedan (0) --- CC0 first, then CC-BY, roughly by cleanliness/size.
  { file: 'sedan_filler.glb', body: 0, priority: 1, standIn: true },
  { file: 'sedan_generic_b.glb', body: 0, priority: 2, standIn: true },
  { file: 'sedan_kenney.glb', body: 0, priority: 3, standIn: true },
  { file: 'sedan_sports_kenney.glb', body: 0, priority: 4, standIn: true },
  { file: 'sedan_generic_a.glb', body: 0, priority: 5, standIn: true },
  { file: 'sedan_generic_c.glb', body: 0, priority: 6, standIn: true },
  // Messiest topology of the sedan set (22 nodes, unnamed "Generic_N" meshes)
  // and the 7th candidate against a 6-slot quota -- lowest priority.
  { file: 'sedan_generic_d.glb', body: 0, priority: 7, standIn: true },
  // Both far over MAX_TRIS (11217, 11129) -- listed for the record, expected
  // to be rejected on measurement rather than cut for quota.
  { file: 'sedan_large_a.glb', body: 0, priority: 8, standIn: true },
  { file: 'sedan_large_b.glb', body: 0, priority: 9, standIn: true },

  // --- hatch (1) ---
  { file: 'hatch_generic_a.glb', body: 1, priority: 1, standIn: true },
  { file: 'hatch_kenney.glb', body: 1, priority: 2, standIn: true },
  // 72% of it is a material named `Black`, which is the body; `Main` is the trim.
  { file: 'hatch_filler.glb', body: 1, priority: 3, paint: ['Black', 'Main'], standIn: true },
  { file: 'hatch_micro.glb', body: 1, priority: 4, standIn: true },
  { file: 'vw_golf_mk.glb', body: 1, priority: 5, label: 'Volkswagen Golf' },
  // All three far over MAX_TRIS (11989, 33706, 19720); mazda_rx7 is also the
  // wrong shape for a hatch (it's an RX-7 coupe standing in, per sourcing.csv).
  { file: 'corolla_ae86.glb', body: 1, priority: 6, label: 'Toyota Corolla AE86' },
  { file: 'hatch_sports.glb', body: 1, priority: 7, standIn: true },
  { file: 'mazda_rx7.glb', body: 1, priority: 8, label: 'Mazda RX-7' },

  // --- suv (2) ---
  { file: 'suv_generic_a.glb', body: 2, priority: 1, standIn: true },
  { file: 'suv_kenney.glb', body: 2, priority: 2, standIn: true },
  { file: 'suv_luxury_kenney.glb', body: 2, priority: 3, standIn: true },
  { file: 'suv_generic_b.glb', body: 2, priority: 4, standIn: true },
  // 8032 tris in the source manifest -- 32 over the limit. Processed like
  // everything else rather than pre-judged; measured, not assumed.
  { file: 'suv_filler.glb', body: 2, priority: 5, standIn: true },
  { file: 'nissan_terrano.glb', body: 2, priority: 6, label: 'Nissan Terrano' },
  { file: 'suv_offroad_a.glb', body: 2, priority: 7, standIn: true },
  // Same author, same rig, same tri count as suv_offroad_a -- a repaint, not
  // a second silhouette. Lowest priority of the SUV set for exactly that
  // reason (silhouette variety is what this curation optimizes for).
  { file: 'suv_offroad_b.glb', body: 2, priority: 8, standIn: true },
  // Both far over MAX_TRIS (10448, 31418).
  { file: 'suv_offroad_c.glb', body: 2, priority: 9, standIn: true },
  { file: 'range_rover.glb', body: 2, priority: 10, label: 'Land Rover Range Rover' },

  // --- ute (3) --- only 4 candidates exist; all are kept if they pass.
  { file: 'ute_generic.glb', body: 3, priority: 1, standIn: true },
  { file: 'ute_tray_kenney.glb', body: 3, priority: 2, standIn: true },
  // `nose: 1`: **and it was `-1`, which turned a correct file backwards.**
  //
  // The reasoning that put `-1` here was sound and the sign was not: detection
  // has no signal on this file (the "FrontColor" material is a value-duplicate
  // of "Color_M00", so `dedup` folds the only directional name away), the
  // sheet showed a tray, and the conclusion drawn was that the source faced
  // `-X`. It does not. Rendering `data/vehicles/models/mitsubishi_l200.glb`
  // through `render-car-sheet.mjs` puts its grille at `+X` -- so the pin was
  // the *only* thing turning it, and what the sheet had been showing was this
  // line's own work. The 2026-09 real-cars round caught it on the sheet again
  // and turned the shipped asset back.
  //
  // The lesson, which is the reason this comment is six lines rather than one:
  // a hand pin is only ever justified against the **source**, never against the
  // output, because the output already has the pin in it.
  { file: 'mitsubishi_l200.glb', body: 3, priority: 3, nose: 1, paint: ['M_0136_Charcoal', 'Color_M08'], label: 'Mitsubishi Triton' },
  { file: 'toyota_hilux_97.glb', body: 3, priority: 4, label: 'Toyota HiLux 1997' },

  // --- van (4) --- only 3 candidates exist; all are kept if they pass.
  { file: 'van_courier_kenney.glb', body: 4, priority: 1, standIn: true },
  { file: 'van_generic_a.glb', body: 4, priority: 2, standIn: true },
  { file: 'van_panel.glb', body: 4, priority: 3, standIn: true },

  // --- specials: no quota, kept if they pass the same per-model limits ---
  // `length` is each one's own real-world target, not borrowed from a
  // numbered class: the surviving police model is SUV-shaped (see its own
  // target_vehicle in the source manifest, "NSW Police general-duties
  // SUV/wagon"), so it is sized like this game's SUV class, not its sedan
  // class, even though "police" is not itself a numbered body.
  { file: 'police_kenney.glb', body: 'police', priority: 1, length: CAR_BODY_SIZE[2].length, label: 'NSW Police Cruiser' },
  // 9648 tris -- over the limit; the only other police candidate, and the
  // one that *would* have wanted the sedan length.
  { file: 'police_sedan_charger.glb', body: 'police', priority: 2, length: CAR_BODY_SIZE[0].length, label: 'NSW Police Charger' },
  { file: 'taxi_generic.glb', body: 'taxi', priority: 1, length: CAR_BODY_SIZE[0].length, label: 'Sydney Taxi' },
  { file: 'taxi_kenney.glb', body: 'taxi', priority: 2, length: CAR_BODY_SIZE[0].length, label: 'Sydney Taxi' },
  // A rigid single-deck Sydney Buses bus (Volvo B12BLE / Scania K-series and
  // similar) is about 12.5 m; 12.0 m is a round, slightly conservative
  // stand-in rather than the full figure.
  { file: 'city_bus.glb', body: 'bus', priority: 1, length: 12.0, label: 'Sydney Buses Transit' },
  // A kerbside rear-loader garbage truck is about 9-10 m over the cab and bin body.
  { file: 'garbage_truck_kenney.glb', body: 'garbage', priority: 1, length: 9.0, label: 'Council Garbage Truck' },
];

const SPECIAL_BODIES = new Set(['police', 'taxi', 'bus', 'garbage']);

// --- Interior / direction name heuristics ----------------------------------------

/**
 * Word-boundary helper for the short 2-3 letter direction codes below.
 *
 * `\b` is not it: JS's `\w` class includes `_`, so `\bback\b` fails to match
 * "BackWheels" (no `\B` transition either side of "Back" -- the 'k'/'W'
 * boundary is a case change, not a `\w`/`\W` one) and fails on
 * "wheel_front_left" the same way. This instead treats any *letter or digit*
 * neighbour as "still part of the token" and anything else -- underscore,
 * hyphen, space, space, string edge -- as a real boundary, which is what
 * actually separates tokens in this corpus's naming.
 */
const short = (s) => `(?<![a-zA-Z0-9])${s}(?![a-zA-Z0-9])`;

/** Node/mesh/material name substrings that mark separable interior geometry. */
const INTERIOR_RE = /seat|interior|steering|dash(?:board)?|chair/i;

/**
 * Markers that put a part in the front half of the car. Long/specific words
 * are matched bare (safe against the `\b`-on-underscore trap above); the
 * short codes use the `short()` boundary so "fl" doesn't fire inside
 * "reflect" or "from".
 */
const FRONT_RE = new RegExp(
  ['front', 'bonnet', 'hood', 'headlight', 'head[_ -]?light', 'windshield', 'windscreen', 'wiper', 'grille?',
    short('fl'), short('fr'), short('fwd'), short('flw'), short('frw'), short('fli'), short('fri'),
    // French: phare = headlight. The L200's materials are French.
    'phare'].join('|'),
  'i',
);
/**
 * Markers that put a part in the rear half of the car. "back" is guarded
 * against "hatchback" specifically -- a real false positive found in this
 * corpus (`hatch_generic_a.glb`'s node names are all prefixed
 * "car_hatchback_..."), not a hypothetical one.
 */
const REAR_RE = new RegExp(
  ['rear', '(?<!hatch)back', 'boot', 'trunk', 'tail[_ -]?light', 'brake[_ -]?light', 'exhaust', 'spoiler',
    short('rl'), short('rr'), short('bk'), short('rlw'), short('rrw'), short('rli'), short('rri'),
    // French: feux (rouges) = tail lights.
    'feux'].join('|'),
  'i',
);

// --- Small mat4 helpers ------------------------------------------------------------

const IDENTITY_MAT4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * Column-major 4x4 for translate(T) * scale(s uniform) * rotateY(theta),
 * built from exact {cos,sin} pairs for the four axis-aligned cases this
 * script ever needs (0, 90, 180, -90 degrees) rather than from `Math.cos` /
 * `Math.sin`, which are not exactly 0/1 at those angles and would otherwise
 * leak a sub-epsilon shear into every vertex of every shipped car.
 */
function buildNormalizeMatrix(cos, sin, scale, t) {
  return [
    scale * cos, 0, -scale * sin, 0,
    0, scale, 0, 0,
    scale * sin, 0, scale * cos, 0,
    t[0], t[1], t[2], 1,
  ];
}

const ROTATIONS = {
  'x,1': { cos: 1, sin: 0 },
  'x,-1': { cos: -1, sin: 0 },
  'z,1': { cos: 0, sin: 1 },
  'z,-1': { cos: 0, sin: -1 },
};

// --- GLB loading, tolerant of the Kenney set's dangling texture reference --------

/**
 * All ten `*_kenney.glb` files reference an external `Textures/colormap.png`
 * that is not present anywhere in `data/` -- confirmed by hand (grepped the
 * whole `data/` tree) rather than assumed, and not something this script
 * fetches: downloading a replacement is out of scope and the sourcing
 * manifest gives no indication one was ever bundled alongside these files.
 * `setStrictResources(false)` is core's own documented mechanism for this
 * exact situation (missing image, geometry otherwise intact): the Document
 * loads with a `Texture` whose `getImage()` is null, and the caller is
 * expected to clear the dangling references before `prune()` removes them.
 * These are also the Kenney *Car Kit* CC0 models the brief explicitly
 * prefers, so repairing them (documented, below) ships more of the "matches
 * a stylised city" set than rejecting them outright would.
 */
async function readRepaired(filePath) {
  const io = new NodeIO().setStrictResources(false);
  const doc = await io.read(filePath);
  const missing = [];
  for (const tex of doc.getRoot().listTextures()) {
    if (tex.getImage() !== null) continue;
    missing.push(tex.getURI() || tex.getName() || '(unnamed texture)');
    for (const mat of doc.getRoot().listMaterials()) {
      if (mat.getBaseColorTexture() === tex) mat.setBaseColorTexture(null);
      if (mat.getEmissiveTexture() === tex) mat.setEmissiveTexture(null);
      if (mat.getNormalTexture() === tex) mat.setNormalTexture(null);
      if (mat.getOcclusionTexture() === tex) mat.setOcclusionTexture(null);
      if (mat.getMetallicRoughnessTexture() === tex) mat.setMetallicRoughnessTexture(null);
    }
  }
  return { doc, missingTextures: missing };
}

// --- Cleanup passes ---------------------------------------------------------------

/** Drop stray Camera/Light (or otherwise mesh-less) top-level nodes left over from the authoring scene. */
function dropNonGeometryNodes(doc) {
  const scene = doc.getRoot().listScenes()[0];
  for (const node of [...scene.listChildren()]) {
    if (!node.getMesh()) node.dispose();
  }
}

/** The steering wheel's centre across the car (+Z right), from node/mesh names, or null when no node is one. */
const STEERING_RE = /steer|driving[_ -]?wheel|volant|lenkrad/i;
function steeringWheelZ(doc) {
  const scene = doc.getRoot().listScenes()[0];
  let sum = 0;
  let count = 0;
  for (const node of scene.listChildren()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const blob = [node.getName(), mesh.getName()].filter(Boolean).join(' ');
    if (!STEERING_RE.test(blob)) continue;
    const b = getBounds(node);
    if (!Number.isFinite(b.min[2])) continue;
    sum += (b.min[2] + b.max[2]) / 2;
    count++;
  }
  return count === 0 ? null : sum / count;
}

/** Drop separable interior geometry (seats, dash, steering wheel); returns the names dropped. */
function dropInteriorNodes(doc) {
  const scene = doc.getRoot().listScenes()[0];
  const dropped = [];
  for (const node of [...scene.listChildren()]) {
    const mesh = node.getMesh();
    const blob = [node.getName(), mesh?.getName()].filter(Boolean).join(' ');
    if (INTERIOR_RE.test(blob)) {
      dropped.push(blob || '(unnamed node)');
      node.dispose();
    }
  }
  return dropped;
}

/**
 * Ensures every top-level node has a private Mesh (clones on repeat use).
 * Needed before per-node world-transform baking below: a handful of source
 * files (`van_panel.glb`'s two rear wheel nodes, notably) share one Mesh
 * between two differently-positioned nodes, and baking a world matrix into
 * shared geometry would apply the *second* node's transform to both.
 */
function deinstanceMeshes(doc) {
  const scene = doc.getRoot().listScenes()[0];
  const claimed = new Set();
  for (const node of scene.listChildren()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    if (claimed.has(mesh)) {
      node.setMesh(mesh.clone());
    } else {
      claimed.add(mesh);
    }
  }
}

/**
 * Bakes every top-level node's own local matrix into its mesh's vertex data
 * (via `transformMesh`, which handles POSITION/NORMAL/TANGENT correctly,
 * including the normal matrix and winding order) and resets the node to
 * identity. After `flatten()`, a top-level node's local matrix *is* its full
 * original-scene world matrix, so this is exact -- and it is done this way,
 * baking into vertex data, rather than by composing the normalization
 * transform into the node's TRS, because several source files carry
 * non-uniform per-axis scale on rotated nodes (e.g. `range_rover.glb`'s
 * spare-tyre node), and composing two such matrices does not always
 * decompose back into a valid TRS triple. Baking into vertex data sidesteps
 * that entirely: it is just arithmetic on numbers, never a decomposition.
 */
function bakeToIdentity(doc) {
  const scene = doc.getRoot().listScenes()[0];
  for (const node of scene.listChildren()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const local = node.getMatrix();
    if (!matEq(local, IDENTITY_MAT4)) transformMesh(mesh, local);
    node.setMatrix(IDENTITY_MAT4);
  }
}

function matEq(a, b, eps = 1e-9) {
  for (let i = 0; i < 16; i++) if (Math.abs(a[i] - b[i]) > eps) return false;
  return true;
}

// --- Direction detection -----------------------------------------------------------

/**
 * Determines which horizontal axis is the car's length axis, and which end
 * of it is the nose, from the (already baked-to-identity) scene.
 *
 * Axis: whichever of X/Z has the larger extent in the correctly-computed
 * world bounding box -- the same test the verification pass re-checks later,
 * so a file that fails this cannot pass that. Sign (which end is the nose):
 * scored from node/mesh/material name keywords (front/back, headlight/
 * taillight, windshield/boot, etc, see FRONT_RE/REAR_RE above), falling back
 * to "no flip" with low confidence when a file carries no such names at all
 * (the anonymized `groupNNNNNNN` mesh names some Poly Pizza uploads use).
 * That fallback is disclosed per file in the printed report rather than
 * silently guessed at -- getting the *axis* wrong is what "renders sideways"
 * means and is caught by verification; getting the *sign* wrong on a
 * silhouette-symmetric filler model is a much smaller, and undetectable by
 * bounding box, mistake.
 */
function detectDirection(doc) {
  const scene = doc.getRoot().listScenes()[0];
  const overall = getBounds(scene);
  const extentX = overall.max[0] - overall.min[0];
  const extentZ = overall.max[2] - overall.min[2];
  const axis = extentX >= extentZ ? 'x' : 'z';
  const axisIdx = axis === 'x' ? 0 : 2;
  const center = (overall.min[axisIdx] + overall.max[axisIdx]) / 2;

  let frontSum = 0, frontCount = 0, rearSum = 0, rearCount = 0;
  for (const node of scene.listChildren()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const matNames = mesh.listPrimitives().map((p) => p.getMaterial()?.getName() || '').join(' ');
    const blob = [node.getName(), mesh.getName(), matNames].filter(Boolean).join(' ');
    const b = getBounds(node);
    if (!Number.isFinite(b.min[axisIdx])) continue;
    const val = (b.min[axisIdx] + b.max[axisIdx]) / 2;
    if (FRONT_RE.test(blob)) { frontSum += val; frontCount++; }
    if (REAR_RE.test(blob)) { rearSum += val; rearCount++; }
  }

  let sign, confidence;
  if (frontCount > 0 && rearCount > 0) {
    sign = frontSum / frontCount > rearSum / rearCount ? 1 : -1;
    confidence = 'front+rear name markers';
  } else if (frontCount > 0) {
    sign = frontSum / frontCount > center ? 1 : -1;
    confidence = 'front name markers only';
  } else if (rearCount > 0) {
    sign = rearSum / rearCount > center ? -1 : 1;
    confidence = 'rear name markers only';
  } else {
    // No names. The shape, in order of trust: the glass (the windscreen is
    // the big pane facing along the car), then the roof rake (the climb to
    // the roof is longer at the windscreen), then the widest slice (the
    // mirrors sit forward of the middle). Every cue is reported, so a wrong
    // guess is a line in the log, not a mystery on the road.
    const glass = glassSign(doc, axisIdx);
    const rake = rakeSign(doc, axisIdx);
    const widest = widestSliceSign(doc, axisIdx);
    const cues = `glass ${glass.sign > 0 ? '+' : glass.sign < 0 ? '-' : '?'}x${glass.ratio.toFixed(1)}, rake ${rake.lo}/${rake.hi} at -/+, widest at ${(widest.along * 100).toFixed(0)}%`;
    if (glass.sign !== 0) {
      sign = glass.sign;
      confidence = `by the glass (${cues}), no directional names`;
    } else if (rake.sign !== 0) {
      sign = rake.sign;
      confidence = `by the roof rake (${cues}), no directional names`;
    } else {
      sign = widest.sign;
      confidence = `by the widest slice (${cues}), no directional names -- UNVERIFIED`;
    }
  }
  // The glass cue as a cross-check on the named ones, for the log.
  const check = glassSign(doc, axisIdx);
  if (check.sign !== 0 && check.sign !== sign) confidence += ` [glass disagrees: ${check.sign > 0 ? '+' : '-'} x${check.ratio.toFixed(1)}]`;
  else if (check.sign !== 0) confidence += ` [glass agrees x${check.ratio.toFixed(1)}]`;
  return { axis, sign, confidence, overall };
}

// --- Normalization ------------------------------------------------------------------

/** Rotates to the game's +X-nose convention, scales to target length, sits wheels on y=0 at the footprint centre. */
function normalize(doc, direction, targetLength) {
  const scene = doc.getRoot().listScenes()[0];
  const { axis, sign, overall } = direction;
  const { cos, sin } = ROTATIONS[`${axis},${sign}`];

  const sourceLength = axis === 'x' ? overall.max[0] - overall.min[0] : overall.max[2] - overall.min[2];
  const scale = targetLength / sourceLength;

  // Rotated-only (pre-scale) bbox, derived by permuting/negating the original
  // corners -- exact for these axis-aligned rotations, no re-scan needed.
  let rMinX, rMaxX, rMinZ, rMaxZ;
  if (axis === 'x' && sign === 1) {
    rMinX = overall.min[0]; rMaxX = overall.max[0]; rMinZ = overall.min[2]; rMaxZ = overall.max[2];
  } else if (axis === 'x' && sign === -1) {
    rMinX = -overall.max[0]; rMaxX = -overall.min[0]; rMinZ = -overall.max[2]; rMaxZ = -overall.min[2];
  } else if (axis === 'z' && sign === 1) {
    rMinX = overall.min[2]; rMaxX = overall.max[2]; rMinZ = -overall.max[0]; rMaxZ = -overall.min[0];
  } else {
    rMinX = -overall.max[2]; rMaxX = -overall.min[2]; rMinZ = overall.min[0]; rMaxZ = overall.max[0];
  }

  const t = [
    -scale * (rMinX + rMaxX) / 2,
    -scale * overall.min[1],
    -scale * (rMinZ + rMaxZ) / 2,
  ];
  const M = buildNormalizeMatrix(cos, sin, scale, t);

  for (const node of scene.listChildren()) {
    const mesh = node.getMesh();
    if (mesh) transformMesh(mesh, M);
  }
}

/** Sit the mesh on y=0 again, re-centre it in x/z and put its length back to the target, after anything that moved vertices. */
function reground(doc, targetLength) {
  const scene = doc.getRoot().listScenes()[0];
  const b = getBounds(scene);
  const k = targetLength / (b.max[0] - b.min[0]);
  const t = [-k * (b.min[0] + b.max[0]) / 2, -k * b.min[1], -k * (b.min[2] + b.max[2]) / 2];
  const M = [k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0, t[0], t[1], t[2], 1];
  for (const node of scene.listChildren()) {
    const mesh = node.getMesh();
    if (mesh) transformMesh(mesh, M);
  }
}

/**
 * Every vertex of the scene in world space, through each node's world
 * matrix -- the raw POSITION arrays are in node space, and a Sketchfab
 * export's root carries the author's rotation and a centimetre scale.
 */
function eachWorldVertex(scene, fn) {
  const v = [0, 0, 0];
  for (const node of scene.listChildren()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, v);
        const x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12];
        const y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13];
        const z = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14];
        fn(x, y, z);
      }
    }
  }
}


// --- What the game paints, and what it leaves alone -------------------------------
//
// `world/carlod.ts` collapses every model to one geometry and one material, and
// until this round every surface of a `multiply` model took the entity's paint:
// a white headlight came out the colour of the car and a red tail light the
// colour of the car. `_PAINT` is one float per vertex, 1 where the game's paint
// lands (the body panels, as value under the entity's hue) and 0 where the
// authored colour stays (glass, lights, tyres, chrome, plates). Decided per
// material here, where the names still exist -- `carlod` sees "Index_0_2" and
// nothing else.
const PAINT_RE = /paint|body|carros|varnish|karoser|lack\b|\bmain\b|exterior|vehicle|metal_white|bodywork|carbody|shell|lackierung/i;
const NEVER_PAINT_RE = /glass|tyre|tire|rubber|chrome|lights?\b|xlight|lamp|plate|plaque|interior|interieur|\bint\b|_int\b|mirror|miroir|wheel|rim\b|disc|disk|exhaust|grill|plastic|plastique|black|noir|dark|leather|seat|siege|logo|badge|decal|screen|window|fenetre|vitre|verre|phare|feux|pneu|jante|mecanique|protector|kidney|detail|pipe|luntai|lunzi|inner|steel|metal_dark|varnish_dark|dash|panel|console|carpet|floor|engine|moteur|spring|bolt|caliper|brake|tail|trunk|hood|bonnet|roof_int|velvet/i;

/** Mean value (max channel) of a material's base colour, texel-weighted when it has a map. */
async function materialValue(mat) {
  const f = mat.getBaseColorFactor();
  const tex = mat.getBaseColorTexture();
  if (!tex || !tex.getImage()) return Math.max(f[0], f[1], f[2]);
  try {
    const { data, info } = await sharp(Buffer.from(tex.getImage())).resize(32, 32, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
    const vals = [];
    for (let i = 0; i < info.width * info.height; i++) {
      const o = i * info.channels;
      vals.push(Math.max(data[o] * f[0], data[o + 1] * f[1], data[o + 2] * f[2]) / 255);
    }
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length * 0.95)] ?? 0;
  } catch {
    return Math.max(f[0], f[1], f[2]);
  }
}

/** Triangle area summed per material, in world metres, over the whole scene. */
function areaByMaterial(doc) {
  const out = new Map();
  const scene = doc.getRoot().listScenes()[0];
  for (const node of scene.listChildren()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      const pos = prim.getAttribute('POSITION');
      const idx = prim.getIndices();
      if (!mat || !pos) continue;
      const n = pos.getCount();
      const w = new Float64Array(n * 3);
      const v = [0, 0, 0];
      for (let i = 0; i < n; i++) {
        pos.getElement(i, v);
        w[i * 3] = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12];
        w[i * 3 + 1] = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13];
        w[i * 3 + 2] = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14];
      }
      const cnt = idx ? idx.getCount() : n;
      let area = 0;
      for (let t = 0; t < cnt; t += 3) {
        const a = idx ? idx.getScalar(t) : t, b = idx ? idx.getScalar(t + 1) : t + 1, c = idx ? idx.getScalar(t + 2) : t + 2;
        const e1x = w[b * 3] - w[a * 3], e1y = w[b * 3 + 1] - w[a * 3 + 1], e1z = w[b * 3 + 2] - w[a * 3 + 2];
        const e2x = w[c * 3] - w[a * 3], e2y = w[c * 3 + 1] - w[a * 3 + 1], e2z = w[c * 3 + 2] - w[a * 3 + 2];
        const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        area += Math.sqrt(nx * nx + ny * ny + nz * nz) * 0.5;
      }
      out.set(mat, (out.get(mat) ?? 0) + area);
    }
  }
  return out;
}

/**
 * Which materials take the paint. Named ones first; a corpus with no names
 * (Object_5 / Index_0_1) falls back to area: every non-excluded surface at
 * least a fifth the size of the largest one, bright enough to be a panel.
 * Blended materials are glass and never painted.
 */
async function paintedMaterials(doc, pinned = null) {
  const areas = areaByMaterial(doc);
  const mats = [...areas.keys()];
  const info = new Map();
  for (const mat of mats) {
    const name = mat.getName() || '';
    const blend = mat.getAlphaMode() === 'BLEND' && mat.getBaseColorFactor()[3] < 0.95;
    info.set(mat, { name, blend, area: areas.get(mat), value: await materialValue(mat) });
  }
  if (pinned !== null) return { painted: new Set(mats.filter((m) => pinned.includes(info.get(m).name))), info };
  const explicit = mats.filter((m) => { const i = info.get(m); return PAINT_RE.test(i.name) && !NEVER_PAINT_RE.test(i.name) && !i.blend; });
  if (explicit.length > 0) return { painted: new Set(explicit), info };
  const eligible = mats.filter((m) => { const i = info.get(m); return !NEVER_PAINT_RE.test(i.name) && !i.blend && i.value >= 0.15; });
  let largest = 0;
  for (const m of eligible) largest = Math.max(largest, info.get(m).area);
  return { painted: new Set(eligible.filter((m) => info.get(m).area >= largest * 0.2)), info };
}

/**
 * The value the body reads at, so the paint lands at full strength: the 95th
 * percentile of the painted surfaces' value, area-weighted by material. Baked
 * into the file (texels and base colours) rather than computed at load, so
 * `carlod` no longer reads a texture back to find it.
 */
function paintGain(painted, info) {
  let best = 0;
  let total = 0;
  const mapped = [...painted].filter((m) => m.getBaseColorTexture());
  for (const m of mapped) total += info.get(m).area;
  for (const m of mapped) {
    const i = info.get(m);
    if (i.area < total * 0.1) continue;
    best = Math.max(best, i.value);
  }
  if (best <= 0) for (const m of mapped) best = Math.max(best, info.get(m).value);
  return best > 1e-3 ? Math.min(6, 1 / best) : 1;
}

/**
 * The Kenney kit's colours, from geometry, because its palette is gone.
 *
 * Every `*_kenney.glb` maps its faces to cells of a `colormap.png` that is not
 * in `data/` (see `readRepaired`), so the ten arrive white. The cells are still
 * there in the UVs -- a hundred-odd distinct points -- and faces that share a
 * cell shared a colour, so the roles can be read back off where those clusters
 * sit on the car: the tall vertical faces above the beltline are glass, the
 * small clusters at the very ends are lights, the wheel nodes are tyres and
 * hubs, and everything else is the body the paint lands on. Written as
 * `COLOR_0` and `_PAINT`, so `carlod` needs no special case for the kit.
 */
function inferKenneyRoles(doc) {
  const scene = doc.getRoot().listScenes()[0];
  if (process.env.PREP_DEBUG) {
    let prims = 0, indexed = 0, withUv = 0;
    for (const node of scene.listChildren()) for (const p of node.getMesh()?.listPrimitives() ?? []) { prims++; if (p.getIndices()) indexed++; if (p.getAttribute('TEXCOORD_0')) withUv++; }
    console.log(`  kenney roles: ${scene.listChildren().length} nodes, ${prims} primitives, ${indexed} indexed, ${withUv} with uv`);
  }
  const b = getBounds(scene);
  const maxY = b.max[1];
  const halfLen = (b.max[0] - b.min[0]) / 2;
  const cx = (b.max[0] + b.min[0]) / 2;
  // First pass: cluster stats.
  const stats = new Map();
  const tri = [];
  for (const node of scene.listChildren()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const wheel = /wheel/i.test(node.getName() + ' ' + (mesh.getName() || ''));
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const uv = prim.getAttribute('TEXCOORD_0');
      const idx = prim.getIndices();
      if (!pos) continue;
      const n = pos.getCount();
      const w = new Float64Array(n * 3);
      const v = [0, 0, 0];
      for (let i = 0; i < n; i++) {
        pos.getElement(i, v);
        w[i * 3] = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12];
        w[i * 3 + 1] = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13];
        w[i * 3 + 2] = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14];
      }
      const t = [0, 0];
      // Indexed or not: the Kenney files arrive here unindexed.
      const cnt = idx ? idx.getCount() : n;
      for (let k = 0; k < cnt; k += 3) {
        const a = idx ? idx.getScalar(k) : k, bb = idx ? idx.getScalar(k + 1) : k + 1, c = idx ? idx.getScalar(k + 2) : k + 2;
        let key = 'w';
        // The exact UV, not a quantised one: the kit's palette rows are 0.007
        // apart and a 1/64 grid folded a door onto the window beside it.
        if (!wheel && uv) { uv.getElement(a, t); key = `${t[0].toFixed(4)},${t[1].toFixed(4)}`; }
        const e1x = w[bb * 3] - w[a * 3], e1y = w[bb * 3 + 1] - w[a * 3 + 1], e1z = w[bb * 3 + 2] - w[a * 3 + 2];
        const e2x = w[c * 3] - w[a * 3], e2y = w[c * 3 + 1] - w[a * 3 + 1], e2z = w[c * 3 + 2] - w[a * 3 + 2];
        const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1e-9;
        const area = len * 0.5;
        const cyv = (w[a * 3 + 1] + w[bb * 3 + 1] + w[c * 3 + 1]) / 3;
        const cxv = (w[a * 3] + w[bb * 3] + w[c * 3]) / 3;
        const s = stats.get(key) ?? { area: 0, y: 0, ay: 0, x: 0 };
        s.area += area; s.y += cyv * area; s.ay += Math.abs(ny / len) * area; s.x += cxv * area;
        stats.set(key, s);
        tri.push({ prim, k, key, wheel, nz: Math.abs(nz / len) });
      }
    }
  }
  let total = 0;
  for (const s of stats.values()) total += s.area;
  const roles = new Map();
  for (const [key, s] of stats) {
    const yf = s.y / s.area / Math.max(maxY, 1e-3);
    const ay = s.ay / s.area;
    const x = s.x / s.area - cx;
    const share = s.area / total;
    let colour, paint;
    if (process.env.PREP_DEBUG) console.log(`  cluster ${key.padEnd(8)} share ${(100 * share).toFixed(1).padStart(5)} yf ${yf.toFixed(2)} |ny| ${ay.toFixed(2)} x ${x.toFixed(2)}`);
    if (key === 'w') { colour = [0.06, 0.06, 0.065]; paint = 0; }
    else if (yf > 0.55 && ay < 0.6 && share < 0.12) { colour = [0.09, 0.10, 0.12]; paint = 0; }
    else if (Math.abs(x) > halfLen * 0.82 && yf > 0.2 && yf < 0.72 && share < 0.06) { colour = x > 0 ? [1.0, 0.95, 0.72] : [0.85, 0.06, 0.04]; paint = 0; }
    else if (yf < 0.22 && share < 0.25) { colour = [0.16, 0.16, 0.17]; paint = 0; }
    else { colour = [1, 1, 1]; paint = 1; }
    roles.set(key, { colour, paint });
  }
  // Second pass: write per-vertex colour and mask. Unwelded first so a vertex
  // belongs to one triangle and therefore one cluster.
  return { roles, tri, hub: [0.62, 0.62, 0.64] };
}

/**
 * Apply the roles after `unweld()`: every vertex is now private to its
 * triangle, so the triangle's cluster decides its colour.
 */
function writeKenneyColours(doc, inferred) {
  const scene = doc.getRoot().listScenes()[0];
  const b = getBounds(scene);
  const maxY = b.max[1];
  for (const node of scene.listChildren()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const wheel = /wheel/i.test(node.getName() + ' ' + (mesh.getName() || ''));
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const uv = prim.getAttribute('TEXCOORD_0');
      const idx = prim.getIndices();
      if (!pos) continue;
      const n = pos.getCount();
      const col = new Float32Array(n * 3).fill(1);
      const mask = new Float32Array(n).fill(1);
      const t = [0, 0];
      const v = [0, 0, 0];
      const cnt = idx ? idx.getCount() : n;
      for (let k = 0; k < cnt; k += 3) {
        const a = idx ? idx.getScalar(k) : k, bb = idx ? idx.getScalar(k + 1) : k + 1, c = idx ? idx.getScalar(k + 2) : k + 2;
        let colour, paint;
        if (wheel) {
          // The wheel face (normal along the car's z) is the hub, the rest is tread.
          const w = [a, bb, c].map((i) => { pos.getElement(i, v); return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]]; });
          const e1 = [w[1][0] - w[0][0], w[1][1] - w[0][1], w[1][2] - w[0][2]], e2 = [w[2][0] - w[0][0], w[2][1] - w[0][1], w[2][2] - w[0][2]];
          const nz = e1[0] * e2[1] - e1[1] * e2[0];
          const nl = Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], nz) || 1e-9;
          colour = Math.abs(nz / nl) > 0.8 ? inferred.hub : [0.06, 0.06, 0.065];
          paint = 0;
        } else {
          let key = 'w';
          if (uv) { uv.getElement(a, t); key = `${t[0].toFixed(4)},${t[1].toFixed(4)}`; }
          const r = inferred.roles.get(key) ?? { colour: [1, 1, 1], paint: 1 };
          colour = r.colour; paint = r.paint;
        }
        for (const i of [a, bb, c]) { col[i * 3] = colour[0]; col[i * 3 + 1] = colour[1]; col[i * 3 + 2] = colour[2]; mask[i] = paint; }
      }
      const buf = pos.getBuffer();
      prim.setAttribute('COLOR_0', doc.createAccessor().setType('VEC3').setArray(col).setBuffer(buf));
      prim.setAttribute('_PAINT', doc.createAccessor().setType('SCALAR').setArray(mask).setBuffer(buf));
    }
  }
  void maxY;
}

/** Give every primitive the same attribute set, so `join` and `carlod` see one shape. */
function completeAttributes(doc) {
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const n = pos.getCount();
      const buf = pos.getBuffer();
      if (!prim.getAttribute('TEXCOORD_0')) prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(n * 2)).setBuffer(buf));
      if (!prim.getAttribute('COLOR_0')) prim.setAttribute('COLOR_0', doc.createAccessor().setType('VEC3').setArray(new Float32Array(n * 3).fill(1)).setBuffer(buf));
      if (!prim.getAttribute('_PAINT')) prim.setAttribute('_PAINT', doc.createAccessor().setType('SCALAR').setArray(new Float32Array(n).fill(1)).setBuffer(buf));
    }
  }
}

// --- One texture per car ---------------------------------------------------------
//
// A Sketchfab car is a dozen materials over a dozen 2-4K maps, and the game
// draws it as one `InstancedMesh` with one material. Until this round the
// maps were read back at load and reduced to one texel per vertex, which is
// the whole of why the "textured" cars looked flat. Now the maps are packed
// into one 512 px atlas per file here, the UVs are rewritten onto it, and the
// base colour factors (and the paint gain) are multiplied into the texels --
// so `carlod` gets one map, one material and no read-back.
const ATLAS_PX = 512;
const SOLID_STRIP_PX = 64;
const SOLID_CELL_PX = 8;
const CELL_PAD_PX = 2;

async function bakeAtlas(doc, painted, info, gain) {
  const root = doc.getRoot();
  const textured = [];
  const solid = [];
  for (const mat of info.keys()) {
    const tex = mat.getBaseColorTexture();
    if (tex && tex.getImage()) textured.push(mat);
    else solid.push(mat);
  }
  if (textured.length === 0) return false;
  if (solid.length > (ATLAS_PX / SOLID_CELL_PX) * (SOLID_STRIP_PX / SOLID_CELL_PX)) throw new Error(`${solid.length} solid materials do not fit the atlas strip`);
  const perRow = Math.ceil(Math.sqrt(textured.length));
  const cell = Math.floor((ATLAS_PX - SOLID_STRIP_PX) / perRow);
  const layers = [];
  /** Where each material's cell is: [x, y, w, h] in atlas pixels. */
  const cells = new Map();
  const factorOf = (mat) => {
    const f = mat.getBaseColorFactor();
    const a = mat.getAlphaMode() === 'BLEND' ? f[3] : 1;
    // A painted surface with no map is *white*: the game supplies the colour,
    // and a Ranger authored in navy would otherwise take its paint at a
    // fifteenth of the brightness of the Camry beside it. A painted map keeps
    // its texels (the panel gaps, the badge) exposed by the gain.
    if (painted.has(mat)) return mat.getBaseColorTexture() ? [f[0] * gain, f[1] * gain, f[2] * gain] : [1, 1, 1];
    // Glass darkens by its own alpha: what a tinted window looks like from
    // outside, drawn opaque.
    return [f[0] * a, f[1] * a, f[2] * a];
  };
  for (let i = 0; i < textured.length; i++) {
    const mat = textured[i];
    const x = (i % perRow) * cell;
    const y = Math.floor(i / perRow) * cell;
    const inner = cell - 2 * CELL_PAD_PX;
    const f = factorOf(mat);
    const { data, info: meta } = await sharp(Buffer.from(mat.getBaseColorTexture().getImage()))
      .resize(inner, inner, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let p = 0; p < meta.width * meta.height; p++) {
      const o = p * 3;
      data[o] = Math.min(255, data[o] * f[0]);
      data[o + 1] = Math.min(255, data[o + 1] * f[1]);
      data[o + 2] = Math.min(255, data[o + 2] * f[2]);
    }
    const padded = await sharp(data, { raw: { width: inner, height: inner, channels: 3 } })
      .extend({ top: CELL_PAD_PX, bottom: CELL_PAD_PX, left: CELL_PAD_PX, right: CELL_PAD_PX, extendWith: 'copy' })
      .raw()
      .toBuffer();
    layers.push({ input: padded, raw: { width: cell, height: cell, channels: 3 }, left: x, top: y });
    cells.set(mat, [x + CELL_PAD_PX, y + CELL_PAD_PX, inner, inner]);
  }
  for (let i = 0; i < solid.length; i++) {
    const mat = solid[i];
    const perRowS = ATLAS_PX / SOLID_CELL_PX;
    const x = (i % perRowS) * SOLID_CELL_PX;
    const y = ATLAS_PX - SOLID_STRIP_PX + Math.floor(i / perRowS) * SOLID_CELL_PX;
    const f = factorOf(mat);
    const px = Buffer.alloc(SOLID_CELL_PX * SOLID_CELL_PX * 3);
    for (let p = 0; p < SOLID_CELL_PX * SOLID_CELL_PX; p++) {
      px[p * 3] = Math.min(255, Math.round(f[0] * 255));
      px[p * 3 + 1] = Math.min(255, Math.round(f[1] * 255));
      px[p * 3 + 2] = Math.min(255, Math.round(f[2] * 255));
    }
    layers.push({ input: px, raw: { width: SOLID_CELL_PX, height: SOLID_CELL_PX, channels: 3 }, left: x, top: y });
    cells.set(mat, [x + 2, y + 2, SOLID_CELL_PX - 4, SOLID_CELL_PX - 4]);
  }
  const atlasJpeg = await sharp({ create: { width: ATLAS_PX, height: ATLAS_PX, channels: 3, background: { r: 128, g: 128, b: 128 } } })
    .composite(layers)
    .jpeg({ quality: 88, chromaSubsampling: '4:4:4' })
    .toBuffer();
  const texture = doc.createTexture('car_atlas').setImage(atlasJpeg).setMimeType('image/jpeg');
  const material = doc.createMaterial('car_atlas')
    .setBaseColorTexture(texture)
    .setBaseColorFactor([1, 1, 1, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(0.6)
    .setAlphaMode('OPAQUE')
    .setDoubleSided(false);

  // The UVs, per triangle, onto the cell. Unwelded first so a vertex is one
  // triangle's; a triangle spanning more than one repeat of a tiling map is
  // clamped to the repeat it starts in. Any authored vertex colour goes with
  // the old materials: a baked occlusion under the atlas is a car in the dark.
  for (const mesh of root.listMeshes()) for (const prim of mesh.listPrimitives()) if (prim.getAttribute('COLOR_0')) prim.setAttribute('COLOR_0', null);
  await doc.transform(unweld());
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      const pos = prim.getAttribute('POSITION');
      if (!mat || !pos) continue;
      const n = pos.getCount();
      const idx = prim.getIndices();
      const box = cells.get(mat);
      const out = new Float32Array(n * 2);
      const mask = new Float32Array(n).fill(painted.has(mat) ? 1 : 0);
      const uv = prim.getAttribute('TEXCOORD_0');
      const t = [0, 0];
      if (!box) throw new Error(`material ${mat.getName()} has no atlas cell`);
      const [bx, by, bw, bh] = box;
      const isTex = textured.includes(mat);
      const cnt = idx ? idx.getCount() : n;
      for (let k = 0; k < cnt; k += 3) {
        const ids = [idx ? idx.getScalar(k) : k, idx ? idx.getScalar(k + 1) : k + 1, idx ? idx.getScalar(k + 2) : k + 2];
        if (!isTex || !uv) {
          for (const i of ids) { out[i * 2] = (bx + bw / 2) / ATLAS_PX; out[i * 2 + 1] = (by + bh / 2) / ATLAS_PX; }
          continue;
        }
        let minU = Infinity, minV = Infinity;
        for (const i of ids) { uv.getElement(i, t); minU = Math.min(minU, t[0]); minV = Math.min(minV, t[1]); }
        const offU = Math.floor(minU), offV = Math.floor(minV);
        for (const i of ids) {
          uv.getElement(i, t);
          const u = Math.min(1, Math.max(0, t[0] - offU));
          const vv = Math.min(1, Math.max(0, t[1] - offV));
          out[i * 2] = (bx + u * bw) / ATLAS_PX;
          out[i * 2 + 1] = (by + vv * bh) / ATLAS_PX;
        }
      }
      const buf = pos.getBuffer();
      prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(out).setBuffer(buf));
      prim.setAttribute('_PAINT', doc.createAccessor().setType('SCALAR').setArray(mask).setBuffer(buf));
      for (const sem of prim.listSemantics()) if (/^TEXCOORD_[1-9]/.test(sem)) prim.setAttribute(sem, null);
      prim.setMaterial(material);
    }
  }
  completeAttributes(doc);
  await doc.transform(prune({ keepAttributes: true }), join({ keepNamed: false }), weld({ overwrite: true }));
  return true;
}

/** `_PAINT` per material for a model that keeps its materials (no atlas). Painted ones go white; see `factorOf`. */
function writePaintMask(doc, painted) {
  for (const mat of painted) if (!mat.getBaseColorTexture()) mat.setBaseColorFactor([1, 1, 1, 1]);
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const mat = prim.getMaterial();
      if (!pos) continue;
      const n = pos.getCount();
      const on = mat && painted.has(mat) ? 1 : 0;
      prim.setAttribute('_PAINT', doc.createAccessor().setType('SCALAR').setArray(new Float32Array(n).fill(on)).setBuffer(pos.getBuffer()));
    }
  }
}

/**
 * The nose, from the glass: the windscreen is the largest pane facing along
 * the car, and the rear glass is smaller on a sedan, a hatch, an SUV and a
 * dual-cab alike. Glass is found by what a material *is* -- blended, or
 * transmissive, or a base colour with alpha under 0.9 -- not by its name,
 * because half the corpus names its materials "Index_0_2". Returns the sign
 * of the end with more along-facing glass area and the ratio, or 0 when
 * there is no glass or the two ends are within 25% of each other.
 */
function glassSign(doc, axisIdx) {
  const scene = doc.getRoot().listScenes()[0];
  const overall = getBounds(scene);
  const mid = (overall.min[axisIdx] + overall.max[axisIdx]) / 2;
  let plus = 0;
  let minus = 0;
  const isGlass = (mat) => {
    if (!mat) return false;
    if (mat.getAlphaMode() === 'BLEND') return true;
    const c = mat.getBaseColorFactor();
    if (c && c[3] < 0.9) return true;
    if (mat.getExtension('KHR_materials_transmission')) return true;
    return /glass|vitre|windshield|windscreen|window/i.test(mat.getName() || '');
  };
  const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];
  for (const node of scene.listChildren()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    const xf = (v, out) => {
      out[0] = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12];
      out[1] = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13];
      out[2] = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14];
    };
    for (const prim of mesh.listPrimitives()) {
      if (!isGlass(prim.getMaterial())) continue;
      const pos = prim.getAttribute('POSITION');
      const idx = prim.getIndices();
      if (!pos) continue;
      const n = idx ? idx.getCount() : pos.getCount();
      const get = (k) => (idx ? idx.getScalar(k) : k);
      const va = [0, 0, 0], vb = [0, 0, 0], vc = [0, 0, 0];
      for (let t = 0; t + 2 < n; t += 3) {
        pos.getElement(get(t), va); pos.getElement(get(t + 1), vb); pos.getElement(get(t + 2), vc);
        xf(va, a); xf(vb, b); xf(vc, c);
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const area2 = Math.sqrt(nx * nx + ny * ny + nz * nz);
        if (area2 < 1e-12) continue;
        const along = axisIdx === 0 ? nx : nz;
        const facing = Math.abs(along) / area2;
        if (facing < 0.4) continue;
        const centre = (a[axisIdx] + b[axisIdx] + c[axisIdx]) / 3;
        if (centre > mid) plus += area2 * facing;
        else minus += area2 * facing;
      }
    }
  }
  if (plus === 0 && minus === 0) return { sign: 0, ratio: 0 };
  const ratio = plus > minus ? plus / Math.max(minus, 1e-9) : minus / Math.max(plus, 1e-9);
  if (ratio < 1.25) return { sign: 0, ratio };
  return { sign: plus > minus ? 1 : -1, ratio };
}

/**
 * The nose, from the shape alone, for a file whose names say nothing: the
 * widest point of a car including its mirrors is at the A-pillar, well
 * forward of the middle, so the end the widest slice is nearer is the nose.
 * Returns +1 when the widest slice sits toward +axis, -1 toward -axis, and
 * how far along (0..1 from the -axis end) it was, for the report.
 */
function widestSliceSign(doc, axisIdx) {
  const scene = doc.getRoot().listScenes()[0];
  const overall = getBounds(scene);
  const lo = overall.min[axisIdx];
  const span = overall.max[axisIdx] - lo;
  const latIdx = axisIdx === 0 ? 2 : 0;
  const BINS = 20;
  const width = new Float64Array(BINS);
  const latMid = (overall.min[latIdx] + overall.max[latIdx]) / 2;
  eachWorldVertex(scene, (x, y, z) => {
    const p = [x, y, z];
    const bin = Math.min(BINS - 1, Math.max(0, Math.floor(((p[axisIdx] - lo) / span) * BINS)));
    const w = Math.abs(p[latIdx] - latMid);
    if (w > width[bin]) width[bin] = w;
  });
  let best = 0;
  for (let i = 1; i < BINS; i++) if (width[i] > width[best]) best = i;
  const along = (best + 0.5) / BINS;
  return { sign: along < 0.5 ? -1 : 1, along };
}

/**
 * The climb to the roof at each end, in slices: from the roof plateau's
 * edge outward until the profile drops under 70% of the car's height. The
 * longer climb is the windscreen. Returns +1 when the +axis end climbs
 * longer, -1 the other way, 0 when they are within a slice of each other.
 */
function rakeSign(doc, axisIdx) {
  const scene = doc.getRoot().listScenes()[0];
  const overall = getBounds(scene);
  const lo = overall.min[axisIdx];
  const span = overall.max[axisIdx] - lo;
  const BINS = 40;
  const top = new Float64Array(BINS).fill(-Infinity);
  eachWorldVertex(scene, (x, y, z) => {
    const p = [x, y, z];
    const bin = Math.min(BINS - 1, Math.max(0, Math.floor(((p[axisIdx] - lo) / span) * BINS)));
    if (y > top[bin]) top[bin] = y;
  });
  let peak = -Infinity;
  for (let i = 0; i < BINS; i++) if (top[i] > peak) peak = top[i];
  const base = overall.min[1];
  const height = peak - base;
  const roof = base + 0.94 * height;
  const low = base + 0.7 * height;
  let first = 0;
  while (first < BINS && top[first] < roof) first++;
  let last = BINS - 1;
  while (last >= 0 && top[last] < roof) last--;
  if (first >= last) return { sign: 0, lo: 0, hi: 0 };
  let loRun = 0;
  for (let i = first - 1; i >= 0 && top[i] >= low; i--) loRun++;
  let hiRun = 0;
  for (let i = last + 1; i < BINS && top[i] >= low; i++) hiRun++;
  if (Math.abs(loRun - hiRun) <= 1) return { sign: 0, lo: loRun, hi: hiRun };
  return { sign: loRun > hiRun ? -1 : 1, lo: loRun, hi: hiRun };
}

// --- Measurement ---------------------------------------------------------------------

function countTris(doc) {
  const scene = doc.getRoot().listScenes()[0];
  let tris = 0;
  for (const node of scene.listChildren()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      tris += idx ? idx.getCount() / 3 : (prim.getAttribute('POSITION')?.getCount() ?? 0) / 3;
    }
  }
  return Math.round(tris);
}

// --- Per-file pipeline -----------------------------------------------------------------

async function processFile(entry, srcMeta) {
  const srcPath = path.join(SRC_DIR, entry.file);
  const outPath = path.join(OUT_DIR, entry.file);
  const result = { file: entry.file, body: entry.body, priority: entry.priority, status: 'processing' };

  let doc, missingTextures;
  try {
    ({ doc, missingTextures } = await readRepaired(srcPath));
  } catch (err) {
    return { ...result, status: 'rejected', reason: `failed to read: ${err.message}` };
  }
  result.repairedTextures = missingTextures;

  await doc.transform(weld({ overwrite: true }), flatten());
  dropNonGeometryNodes(doc);
  // The interior nodes are dropped *after* normalisation now, because the
  // steering wheel among them is what decides the right-hand-drive mirror
  // below; see there.

  // Direction detection runs *before* prune/dedup, not after: `dedup()`
  // merges materials that are value-identical, keeping only one of their
  // names, and on at least one real file in this corpus
  // (`mitsubishi_l200.glb`, whose "FrontColor" material is a value-duplicate
  // of the generically-named "Color_M00") that merge silently deletes the
  // only directional naming signal the file has. `getBounds()` walks
  // whatever transforms are currently on the nodes correctly either way, so
  // detection does not need the cleanup pass to have already run.
  const direction = detectDirection(doc);
  if (entry.nose !== undefined) {
    // Pinned by hand, off the rendered sheet (`scripts/render-car-sheet.mjs`).
    direction.sign = entry.nose;
    direction.confidence = `pinned by CATALOG (detection said ${direction.sign === entry.nose ? 'the same' : 'the opposite'})`;
  }
  result.axis = direction.axis;
  result.sign = direction.sign;
  result.directionConfidence = direction.confidence;

  await doc.transform(prune({ keepAttributes: true }), dedup());
  deinstanceMeshes(doc);
  bakeToIdentity(doc);

  // Specials carry their own explicit `length` in CATALOG (see there for
  // why); numbered classes take theirs from CAR_BODY_SIZE.
  const targetLength = SPECIAL_BODIES.has(entry.body) ? entry.length : CAR_BODY_SIZE[entry.body].length;

  normalize(doc, direction, targetLength);

  // **Right-hand drive.** With the car in the game's frame (+Z is its right),
  // a steering wheel left of the centreline is a left-hand-drive model, and
  // the owner asked for the mirror: *"mirror the car to make RHD if needed"*.
  // Decided on the wheel while it is still in the file, applied to every
  // mesh (the winding flips with the determinant, in `transformMesh`), and
  // only then are the interior nodes dropped -- a car with no named wheel is
  // left alone, because a guess would mirror half the fleet the wrong way.
  const wheelZ = steeringWheelZ(doc);
  result.steeringZ = wheelZ;
  result.mirrored = false;
  if (wheelZ !== null && wheelZ < -0.15) {
    const MIRROR_Z = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
    for (const node of doc.getRoot().listScenes()[0].listChildren()) {
      const mesh = node.getMesh();
      if (mesh) transformMesh(mesh, MIRROR_Z);
    }
    result.mirrored = true;
  }
  const droppedInterior = dropInteriorNodes(doc);
  result.droppedInterior = droppedInterior;
  if (doc.getRoot().listScenes()[0].listChildren().length === 0) {
    return { ...result, status: 'rejected', reason: 'no geometry left after cleanup' };
  }

  // **The decimation stage**, for the rows that ask for it. Names are done
  // with (the nose and the wheel are decided above), so the primitives are
  // joined per material first -- the simplifier works per primitive and a
  // 345-mesh HiLux would otherwise keep a triangle per mesh and stall at
  // 3,000 -- then reduced toward `DECIMATE_TO`, in passes, because one pass
  // at a 0.7% ratio under an error bound rarely lands.
  if (entry.decimate) {
    if (entry.positionsOnly) {
      // **Positions only.** A body whose every face carries its own patch of
      // UV never welds -- each face is an island, the collapse cannot cross
      // it, and the file stalls at ten times the budget. So the maps are
      // given up before the weld: strip everything but POSITION, weld by
      // position alone, collapse, and recompute normals after. The atlas
      // stage then samples each map at its centre, which is the right price
      // for a Prado whose only map is a light bar.
      for (const mesh of doc.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          for (const sem of prim.listSemantics()) if (sem !== 'POSITION') prim.setAttribute(sem, null);
        }
      }
    }
    await doc.transform(prune({ keepAttributes: true }), join({ keepNamed: false }), weld({ overwrite: true }));
    await MeshoptSimplifier.ready;
    let have = countTris(doc);
    result.trisBefore = have;
    // The error bound loosens pass by pass: a Prado at 189k triangles does
    // not reach 12k inside 2% of its extent, and a parked car ten metres
    // away does not need it to.
    // Straight to meshoptimizer rather than through `simplify()`, for one
    // flag it does not pass: `Prune`. A real car is thousands of islands --
    // every bolt, badge letter and grille cell its own closed mesh -- and a
    // collapse that has to keep each island keeps 90,000 triangles of a
    // Ranger whatever the ratio. `Prune` lets an island go, which is the
    // whole of what a car ten metres away wants.
    // **Prune and collapse are two calls, and the order is the fix.** One
    // `simplify(..., 1.0, ['Prune'])` -- an unbounded error with the prune
    // flag -- let meshoptimizer drop every island whose radius was under the
    // *whole car*, which on a body authored as separate panels (the
    // David_Holiday L200: doors, bonnet and tray sides each their own shell)
    // deleted the body and kept the chassis. So each pass prunes first, at
    // the pass's own small error -- 2% of the extent is a bolt or a badge
    // letter, 10% is a mirror or a handle, never a door -- and only then
    // collapses, unbounded and without the flag. The prune needs a target
    // under the current count or meshoptimizer returns before it looks; the
    // 5% it is allowed to collapse at that error is invisible.
    const base = entry.pruneError ?? PRUNE_ERROR;
    const PRUNE_LADDER = [base, Math.min(1.0, base * 2.5), Math.min(1.0, base * 5)];
    for (let pass = 0; pass < PRUNE_LADDER.length && have > DECIMATE_TO; pass++) {
      const ratio = Math.max(0.002, (DECIMATE_TO * 0.9) / have);
      for (const mesh of doc.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          const idx = prim.getIndices();
          const pos = prim.getAttribute('POSITION');
          if (!idx || !pos) continue;
          let indices = new Uint32Array(idx.getArray());
          const positions = new Float32Array(pos.getArray());
          // A primitive the last pass emptied -- every island of it was a bolt.
          if (indices.length < 3) continue;
          let out;
          if (PRUNE_LADDER[pass] >= 1.0) {
            // The first round's one call: prune and collapse together, with the
            // error unbounded. Right for a one-shell body, and the two-step
            // below is not the same thing -- run separately, the collapse
            // without the flag folded the Ranger into a black crumple.
            const target = Math.max(3, Math.round((indices.length / 3) * ratio) * 3);
            [out] = MeshoptSimplifier.simplify(indices, positions, 3, target, 1.0, ['Prune']);
          } else {
            const pruneTarget = Math.max(3, Math.floor((indices.length / 3) * 0.95) * 3);
            [indices] = MeshoptSimplifier.simplify(indices, positions, 3, pruneTarget, PRUNE_LADDER[pass], ['Prune']);
            if (indices.length < 3) {
              // The prune took the whole primitive: nothing but bolts in it.
              prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(0)).setBuffer(idx.getBuffer()));
              continue;
            }
            const target = Math.max(3, Math.round((indices.length / 3) * ratio) * 3);
            [out] = MeshoptSimplifier.simplify(indices, positions, 3, target, 1.0, []);
          }
          const next = doc.createAccessor().setType('SCALAR').setArray(out).setBuffer(idx.getBuffer());
          prim.setIndices(next);
        }
      }
      // Drop the vertices nothing indexes any more: unweld writes a vertex per
      // index, weld merges them back, and the old accessors are pruned.
      await doc.transform(unweld(), weld({ overwrite: true }), prune({ keepAttributes: true }));
      have = countTris(doc);
    }
    if (process.env.PREP_DEBUG) { const bd = getBounds(doc.getRoot().listScenes()[0]); console.log(`  after decimation: ${countTris(doc)} tris, extent ${(bd.max[0]-bd.min[0]).toFixed(2)} x ${(bd.max[1]-bd.min[1]).toFixed(2)} x ${(bd.max[2]-bd.min[2]).toFixed(2)}`); }
    if (entry.positionsOnly) await doc.transform(normals({ overwrite: true }));
    await doc.transform(prune({ keepAttributes: true }), dedup());
    // Decimation moves the lowest vertices: the wheels' contact patch is the
    // first detail to go, and the car floats a few centimetres. Grounded and
    // re-centred again, on the decimated mesh, so the gate below measures
    // what ships.
    reground(doc, targetLength);
  }

  // --- What the paint lands on, and one map per car. See `PAINT_RE` and
  // `bakeAtlas`. The Kenney kit has no map and no names, so its roles come
  // off the geometry instead.
  await doc.transform(normals({ overwrite: false }));
  if (missingTextures.length > 0) {
    const inferred = inferKenneyRoles(doc);
    if (process.env.PREP_DEBUG) {
      for (const [key, r] of inferred.roles) console.log(`  role ${key.padEnd(8)} ${r.paint ? 'body ' : 'fixed'} ${r.colour.map((c) => c.toFixed(2)).join('/')}`);
    }
    await doc.transform(unweld());
    writeKenneyColours(doc, inferred);
    completeAttributes(doc);
    await doc.transform(weld({ overwrite: true }));
    result.atlas = false;
    result.roles = 'kenney';
  } else {
    const { painted, info } = await paintedMaterials(doc, entry.paint ?? null);
    const gain = paintGain(painted, info);
    result.painted = [...painted].map((m) => m.getName() || '?');
    let totalArea = 0;
    for (const i of info.values()) totalArea += i.area;
    result.materials = [...info.entries()].sort((a, b) => b[1].area - a[1].area).slice(0, 8).map(([, i]) => `${i.name || '?'}:${Math.round((100 * i.area) / totalArea)}%`);
    result.gain = Math.round(gain * 100) / 100;
    if (await bakeAtlas(doc, painted, info, gain)) {
      result.atlas = true;
    } else {
      writePaintMask(doc, painted);
      completeAttributes(doc);
      result.atlas = false;
    }
  }

  await doc.transform(quantize({ pattern: /^(POSITION|NORMAL|TEXCOORD_0|COLOR_0)$/, quantizeTexcoord: 14, quantizeColor: 8 }));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const io = new NodeIO();
  const glb = await io.writeBinary(doc);
  fs.writeFileSync(outPath, glb);

  // Verify from the file actually written, per the brief -- never trust the
  // in-memory Document, and never trust the source manifest's counts.
  const verifyIo = new NodeIO();
  const written = await verifyIo.read(outPath);
  const scene = written.getRoot().listScenes()[0];
  const bounds = getBounds(scene);
  const lengthAxisExtent = bounds.max[0] - bounds.min[0];
  const widthAxisExtent = bounds.max[2] - bounds.min[2];
  const tris = countTris(written);
  const minY = bounds.min[1];

  const axisOk = lengthAxisExtent > widthAxisExtent;
  const yOk = Math.abs(minY) <= Y_TOLERANCE;
  const lengthOk = Math.abs(lengthAxisExtent - targetLength) <= targetLength * LENGTH_TOLERANCE;
  const trisOk = tris <= (entry.maxTris ?? (entry.decimate ? DECIMATE_TO : MAX_TRIS));

  result.tris = tris;
  result.lengthM = Math.round(lengthAxisExtent * 1000) / 1000;
  result.minY = Math.round(minY * 10000) / 10000;
  result.bytes = glb.byteLength;
  result.verify = { axisOk, yOk, lengthOk, trisOk };

  if (!axisOk || !yOk || !lengthOk || !trisOk) {
    const reasons = [];
    if (!axisOk) reasons.push(`forward axis wrong (length ${lengthAxisExtent.toFixed(2)} <= width ${widthAxisExtent.toFixed(2)})`);
    if (!yOk) reasons.push(`min y = ${minY.toFixed(3)} (want ~0, tol ${Y_TOLERANCE})`);
    if (!lengthOk) reasons.push(`length ${lengthAxisExtent.toFixed(3)}m vs target ${targetLength}m (tol ${LENGTH_TOLERANCE * 100}%)`);
    if (!trisOk) reasons.push(`${tris} tris > ${entry.maxTris ?? (entry.decimate ? DECIMATE_TO : MAX_TRIS)} limit`);
    fs.unlinkSync(outPath);
    return { ...result, status: 'rejected', reason: reasons.join('; ') };
  }

  const meta = srcMeta[entry.file];
  result.status = 'passed';
  result.weight = entry.weight ?? 1;
  result.license = meta.license;
  result.attribution = meta.attribution;
  result.source_url = meta.source_url;
  return result;
}

// --- Curation: apply per-class quotas to the technically-passing set ---------------

function curate(results) {
  const byClass = new Map();
  for (const r of results) {
    if (r.status !== 'passed') continue;
    const key = String(r.body);
    if (!byClass.has(key)) byClass.set(key, []);
    byClass.get(key).push(r);
  }
  for (const [key, list] of byClass) {
    list.sort((a, b) => a.priority - b.priority);
    const cap = SPECIAL_BODIES.has(key) ? Infinity : MAX_PER_CLASS;
    list.forEach((r, i) => {
      if (i < cap) {
        r.status = 'shipped';
      } else {
        r.status = 'rejected';
        r.reason = `passed verification but cut for class quota (${cap} max, ${list.length} candidates passed; kept the ${cap} highest-priority)`;
        fs.unlinkSync(path.join(OUT_DIR, r.file));
      }
    });
    if (!SPECIAL_BODIES.has(key)) {
      const kept = list.filter((r) => r.status === 'shipped').length;
      if (kept < MIN_PER_CLASS) {
        console.warn(`WARNING: body class ${BODY_NAMES[key]} only has ${kept} shipped models (below the ${MIN_PER_CLASS} minimum).`);
      }
    }
  }
  return results;
}

// --- tint policy ---------------------------------------------------------------------

/**
 * "multiply" for the five numbered classes (untextured/palette models that
 * should take the game's per-instance paint colour, per the manifest spec);
 * "none" for the specials, whose whole visual identity *is* their livery --
 * literally the manifest field's own example of when to use it.
 */
function tintFor(body) {
  return SPECIAL_BODIES.has(body) ? 'none' : 'multiply';
}

// --- Credits generation ----------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildCreditsHtml(manifest) {
  const ccBy = manifest.filter((m) => /^CC-BY/.test(m.license));
  const cc0Count = manifest.filter((m) => m.license === 'CC0 1.0').length;
  const rows = ccBy
    .map(
      (m) => `        <li><span class="model">${escapeHtml(m.file)}</span> — ${escapeHtml(m.attribution)}
          <a href="${escapeHtml(m.source_url)}" target="_blank" rel="noopener">${escapeHtml(m.source_url)}</a></li>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>SYDNEY — third-party assets</title>
<style>
  html, body { margin: 0; padding: 0; }
  body {
    background: #0a0e14; color: #cfe2f2;
    font: 14px/1.6 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    padding: 32px 20px 64px; max-width: 720px; margin: 0 auto;
  }
  h1 { font-size: 15px; letter-spacing: .1em; text-transform: uppercase; color: #cfe2f2; font-weight: normal; margin: 0 0 24px; }
  h2 { font-size: 11px; letter-spacing: .16em; text-transform: uppercase; color: #7f95ab; font-weight: normal; margin: 32px 0 10px; }
  p { color: #93a8bc; margin: 0 0 10px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { margin: 0 0 14px; color: #cfe2f2; }
  li .model { color: #93a8bc; }
  li a { display: block; color: #6ea8e0; text-decoration: none; word-break: break-all; }
  li a:hover { text-decoration: underline; }
  a { color: #6ea8e0; }
  .note { color: #7f95ab; }
</style>
</head>
<body>
<h1>SYDNEY — third-party assets</h1>
<p class="note">Generated by <code>scripts/prep-car-models.mjs</code> from <code>client/public/cars/manifest.json</code>. Do not hand-edit.</p>

<h2>Vehicle models</h2>
<p>${manifest.length} car models ship in this build, sourced from Kenney's Car Kit, from Poly Pizza uploads and from Sketchfab (the Sydney mix of 2026-09). ${ccBy.length} are licensed CC-BY (3.0 or 4.0) and require the attribution below; the remaining ${cc0Count} are CC0 1.0 and are used without attribution requirement.</p>
<ul>
${rows}
</ul>

<h2>World data</h2>
<p>Streets, buildings, terrain and water are a processed derivative of OpenStreetMap contributors (<a href="https://opendatacommons.org/licenses/odbl/" target="_blank" rel="noopener">ODbL</a>), Microsoft Building Footprints (ODbL) and AWS Terrain Tiles (Mapzen <code>terrarium</code>). Full attribution ships with the world data itself — see that repository's README, published alongside each build (<code>scripts/publish-world.sh</code>).</p>
</body>
</html>
`;
}

function buildCreditsMd(manifest) {
  const ccBy = manifest.filter((m) => /^CC-BY/.test(m.license));
  const cc0Count = manifest.filter((m) => m.license === 'CC0 1.0').length;
  const rows = ccBy.map((m) => `- **${m.file}** — ${m.attribution}\n  ${m.source_url}`).join('\n');
  return `# SYDNEY — third-party assets

Generated by \`scripts/prep-car-models.mjs\` from \`client/public/cars/manifest.json\`. Do not hand-edit.

## Vehicle models

${manifest.length} car models ship in this build, sourced from Kenney's Car Kit, from Poly Pizza uploads and from Sketchfab (the Sydney mix of 2026-09). ${ccBy.length} are licensed CC-BY (3.0 or 4.0) and require the attribution below; the remaining ${cc0Count} are CC0 1.0 and are used without attribution requirement.

${rows}

## World data

Streets, buildings, terrain and water are a processed derivative of OpenStreetMap contributors ([ODbL](https://opendatacommons.org/licenses/odbl/)), Microsoft Building Footprints (ODbL) and AWS Terrain Tiles (Mapzen \`terrarium\`). Full attribution ships with the world data itself — see that repository's README, published alongside each build (\`scripts/publish-world.sh\`).
`;
}

// --- Report ------------------------------------------------------------------------

function printReport(results) {
  const shipped = results.filter((r) => r.status === 'shipped');
  const rejected = results.filter((r) => r.status === 'rejected');

  console.log('\n=== Verification table (shipped models) ===');
  console.log(
    ['file', 'body', 'tris', 'lengthM', 'minY', 'axis/sign', 'direction confidence', 'wheel z / mirrored / tris before'].join(' | '),
  );
  for (const r of shipped.sort((a, b) => a.file.localeCompare(b.file))) {
    console.log(
      [
        r.file,
        typeof r.body === 'number' ? BODY_NAMES[r.body] : r.body,
        r.tris,
        r.lengthM,
        r.minY,
        `${r.axis}${r.sign > 0 ? '+' : '-'}`,
        r.directionConfidence,
        `${r.steeringZ === null || r.steeringZ === undefined ? '-' : r.steeringZ.toFixed(2)} / ${r.mirrored ? 'yes' : 'no'} / ${r.trisBefore ?? '-'}` + (r.atlas ? ' / atlas' : '') + (r.painted ? ` / paint: ${r.painted.join(',')} x${r.gain} of ${(r.materials ?? []).join(' ')}` : r.roles ? ` / ${r.roles} roles` : ''),
      ].join(' | '),
    );
  }

  console.log('\n=== Rejected ===');
  for (const r of rejected.sort((a, b) => a.file.localeCompare(b.file))) {
    console.log(`${r.file} (${typeof r.body === 'number' ? BODY_NAMES[r.body] : r.body}): ${r.reason}`);
  }

  console.log('\n=== Per body class ===');
  const classes = [...BODY_NAMES, ...SPECIAL_BODIES];
  for (const cls of classes) {
    const key = BODY_NAMES.includes(cls) ? BODY_NAMES.indexOf(cls) : cls;
    const list = shipped.filter((r) => r.body === key);
    if (list.length === 0 && !BODY_NAMES.includes(cls)) continue;
    const totalTris = list.reduce((s, r) => s + r.tris, 0);
    const totalBytes = list.reduce((s, r) => s + r.bytes, 0);
    console.log(`${cls}: ${list.length} models, ${totalTris} tris total, ${(totalBytes / 1024).toFixed(1)} kB`);
  }

  const totalBytes = shipped.reduce((s, r) => s + r.bytes, 0);
  console.log(`\nTotal shipped: ${shipped.length} models`);
  console.log(`Licences: CC0 ${shipped.filter((r) => r.license === 'CC0 1.0').length}, CC-BY ${shipped.filter((r) => /^CC-BY/.test(r.license)).length}`);
  console.log(`Model bytes total: ${(totalBytes / 1024 / 1024).toFixed(3)} MB`);

  const interiorDrops = results.filter((r) => r.droppedInterior?.length);
  if (interiorDrops.length) {
    console.log('\n=== Interior meshes dropped ===');
    for (const r of interiorDrops) console.log(`${r.file}: ${r.droppedInterior.join(', ')}`);
  }
  const texRepairs = results.filter((r) => r.repairedTextures?.length);
  if (texRepairs.length) {
    console.log('\n=== Repaired (dropped a missing external texture reference) ===');
    for (const r of texRepairs) console.log(`${r.file}: ${r.repairedTextures.join(', ')}`);
  }
}

// --- Main --------------------------------------------------------------------------

async function main() {
  /*
   * `PREP_CREDITS_ONLY=1`: rebuild `CREDITS.md` and `credits.html` from the
   * manifest that is already on disk, and stop.
   *
   * The attribution surface is generated *from the manifest*, and the manifest
   * outlives any one run of this script: the 2026-09 real-cars round removed
   * nineteen rows from it without reprocessing a single `.glb`, and left the
   * credits naming six CC-BY models that no longer ship. Crediting an asset you
   * do not use is a small lie in the one document that exists to be exactly
   * true, and the alternative -- a full run, regenerating nineteen binaries to
   * fix a text file -- is a diff nobody can review.
   *
   * Both builders below are already pure functions of the manifest, so this is
   * three lines and cannot drift from what a full run would write.
   */
  if (process.env.PREP_CREDITS_ONLY) {
    const manifest = JSON.parse(fs.readFileSync(OUT_MANIFEST_PATH, 'utf8'));
    fs.writeFileSync(CREDITS_HTML_PATH, buildCreditsHtml(manifest));
    fs.writeFileSync(CREDITS_MD_PATH, buildCreditsMd(manifest));
    console.log(`Wrote ${CREDITS_HTML_PATH}`);
    console.log(`Wrote ${CREDITS_MD_PATH}`);
    return;
  }

  const srcMeta = JSON.parse(fs.readFileSync(SRC_MANIFEST_PATH, 'utf8'));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Clean slate: remove any .glb left over from a previous run so a file
  // that stops shipping (curation or a tightened limit) doesn't linger.
  if (!process.env.PREP_ONLY) {
    for (const f of fs.readdirSync(OUT_DIR)) {
      if (f.endsWith('.glb')) fs.unlinkSync(path.join(OUT_DIR, f));
    }
  }

  const results = [];
  // `PREP_ONLY=<substring>` processes the matching rows and writes their
  // .glb files only -- no manifest, no credits, no clean slate -- for looking
  // at one car; `PREP_DEBUG=1` prints the Kenney role table with it.
  const only = process.env.PREP_ONLY ?? '';
  for (const entry of CATALOG) {
    if (only && !entry.file.includes(only)) continue;
    // Refused on the record, before it is opened. See the CATALOG header on
    // `standIn`: a passenger class holds real makes only, and a row deleted
    // instead of flagged would promote the next generic into the free slot.
    if (entry.standIn) {
      results.push({
        file: entry.file,
        body: entry.body,
        status: 'rejected',
        reason: 'stylised or generic stand-in; the passenger classes carry real makes only',
      });
      continue;
    }
    if (!srcMeta[entry.file]) {
      results.push({ file: entry.file, body: entry.body, status: 'rejected', reason: 'not present in source manifest.json' });
      continue;
    }
    if (!fs.existsSync(path.join(SRC_DIR, entry.file))) {
      results.push({ file: entry.file, body: entry.body, status: 'rejected', reason: 'source .glb not found on disk' });
      continue;
    }
    try {
      const r = await processFile(entry, srcMeta);
      // Carried from the row rather than derived: what a car is called is a
      // human's judgement about a mesh and there is nothing in the file to
      // read it off. See the CATALOG header on `label`.
      r.label = entry.label;
      results.push(r);
    } catch (err) {
      results.push({ file: entry.file, body: entry.body, status: 'rejected', reason: `pipeline error: ${err.stack || err.message}` });
    }
  }

  if (process.env.PREP_ONLY) {
    printReport(results);
    return;
  }
  curate(results);

  // Total-budget guard: drop the largest lowest-priority shipped model(s)
  // until under MAX_TOTAL_BYTES. Not expected to trigger -- the tri-limit
  // rejections above already remove the large files -- but the brief's
  // budget is a hard limit, so it is enforced here rather than assumed.
  let shipped = results.filter((r) => r.status === 'shipped');
  let totalBytes = shipped.reduce((s, r) => s + r.bytes, 0);
  while (totalBytes > MAX_TOTAL_BYTES && shipped.length > 0) {
    shipped.sort((a, b) => b.priority - a.priority || b.bytes - a.bytes);
    const cut = shipped[0];
    cut.status = 'rejected';
    cut.reason = `passed verification but cut to stay under the ${MAX_TOTAL_BYTES / 1024 / 1024} MB total budget`;
    fs.unlinkSync(path.join(OUT_DIR, cut.file));
    shipped = results.filter((r) => r.status === 'shipped');
    totalBytes = shipped.reduce((s, r) => s + r.bytes, 0);
  }

  // A car that ships with no name is a hero line that says nothing, and it
  // would be found by a player rather than here. Fatal rather than defaulted:
  // "Unnamed Vehicle" in the middle of the screen is worse than a failed run.
  const unnamed = shipped.filter((r) => typeof r.label !== 'string' || r.label.trim() === '');
  if (unnamed.length > 0) {
    console.error(`ERROR: no CATALOG label for: ${unnamed.map((r) => r.file).join(', ')}`);
    console.error('Every shipping model needs one -- it is what the game says when a player gets in.');
    process.exitCode = 1;
    return;
  }

  // Manifest: stable file-name order, since a later agent hashes car
  // identity into this list.
  const manifest = shipped
    .map((r) => ({
      file: r.file,
      label: r.label,
      body: r.body,
      tris: r.tris,
      lengthM: r.lengthM,
      tint: tintFor(r.body),
      weight: r.weight,
      atlas: r.atlas === true,
      license: r.license,
      attribution: r.attribution,
      source_url: r.source_url,
      // Only the four special bodies, and only to say why they are the one
      // place a stand-in still ships. See the CATALOG header on `standIn`.
      ...(typeof r.body === 'number' ? {} : { note: SPECIAL_NOTE }),
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
  fs.writeFileSync(OUT_MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');

  fs.writeFileSync(CREDITS_HTML_PATH, buildCreditsHtml(manifest));
  fs.writeFileSync(CREDITS_MD_PATH, buildCreditsMd(manifest));

  // Total bytes actually on disk in client/public/cars/, manifest included.
  const dirBytes = fs.readdirSync(OUT_DIR).reduce((s, f) => s + fs.statSync(path.join(OUT_DIR, f)).size, 0);

  printReport(results);
  console.log(`\nclient/public/cars/ total on disk: ${(dirBytes / 1024 / 1024).toFixed(3)} MB (limit ${MAX_TOTAL_BYTES / 1024 / 1024} MB)`);
  console.log(`Wrote ${OUT_MANIFEST_PATH}`);
  console.log(`Wrote ${CREDITS_HTML_PATH}`);
  console.log(`Wrote ${CREDITS_MD_PATH}`);

  if (dirBytes > MAX_TOTAL_BYTES) {
    console.error(`ERROR: client/public/cars/ is over budget even after trimming.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
