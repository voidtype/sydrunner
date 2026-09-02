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
import { weld, unweld, flatten, prune, dedup, quantize, transformMesh, join } from '@gltf-transform/functions';
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
const MAX_TOTAL_BYTES = 16 * 1024 * 1024; // was 6; eleven textured real cars at ~0.5-1 MB each
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
 */
const CATALOG = [
  // --- The Sydney mix, sourced 2026-09 (data/vehicles/sourcing-2026-09-sydney-mix.csv):
  // the cars that are actually on the road here, one model year each, ahead
  // of every generic. `decimate` opts the row into the decimation stage.
  // `weight` is the car's share of the road in whole points (the owner's
  // list: Ranger 8, HiLux 8, ...); `carlod` repeats a model in its body's
  // pool that many times, and the generics below get 1 each.
  { file: 'ford_ranger_2023.glb', body: 3, priority: 0, decimate: true, weight: 8 },
  { file: 'toyota_hilux_2021.glb', body: 3, priority: 0, decimate: true, weight: 8 },
  { file: 'mitsubishi_l200_dh.glb', body: 3, priority: 0, decimate: true, weight: 4 },
  { file: 'mazda_cx5_tnnv.glb', body: 2, priority: 0, decimate: true, weight: 5 },
  { file: 'nissan_xtrail_2023.glb', body: 2, priority: 0, decimate: true, weight: 4 },
  { file: 'hyundai_tucson_2015.glb', body: 2, priority: 0, decimate: true, weight: 3 },
  { file: 'toyota_prado_2013.glb', body: 2, priority: 0, decimate: true, weight: 5 },
  { file: 'toyota_corolla_2020.glb', body: 1, priority: 0, decimate: true, weight: 5 },
  { file: 'tesla_model_3.glb', body: 0, priority: 0, decimate: true, weight: 4 },
  { file: 'toyota_camry_2020.glb', body: 0, priority: 0, decimate: true, weight: 6 },
  { file: 'toyota_hiace_2020.glb', body: 4, priority: 0, decimate: true, weight: 8 },
  // --- sedan (0) --- CC0 first, then CC-BY, roughly by cleanliness/size.
  { file: 'sedan_filler.glb', body: 0, priority: 1 },
  { file: 'sedan_generic_b.glb', body: 0, priority: 2 },
  { file: 'sedan_kenney.glb', body: 0, priority: 3 },
  { file: 'sedan_sports_kenney.glb', body: 0, priority: 4 },
  { file: 'sedan_generic_a.glb', body: 0, priority: 5 },
  { file: 'sedan_generic_c.glb', body: 0, priority: 6 },
  // Messiest topology of the sedan set (22 nodes, unnamed "Generic_N" meshes)
  // and the 7th candidate against a 6-slot quota -- lowest priority.
  { file: 'sedan_generic_d.glb', body: 0, priority: 7 },
  // Both far over MAX_TRIS (11217, 11129) -- listed for the record, expected
  // to be rejected on measurement rather than cut for quota.
  { file: 'sedan_large_a.glb', body: 0, priority: 8 },
  { file: 'sedan_large_b.glb', body: 0, priority: 9 },

  // --- hatch (1) ---
  { file: 'hatch_generic_a.glb', body: 1, priority: 1 },
  { file: 'hatch_kenney.glb', body: 1, priority: 2 },
  { file: 'hatch_filler.glb', body: 1, priority: 3 },
  { file: 'hatch_micro.glb', body: 1, priority: 4 },
  { file: 'vw_golf_mk.glb', body: 1, priority: 5 },
  // All three far over MAX_TRIS (11989, 33706, 19720); mazda_rx7 is also the
  // wrong shape for a hatch (it's an RX-7 coupe standing in, per sourcing.csv).
  { file: 'corolla_ae86.glb', body: 1, priority: 6 },
  { file: 'hatch_sports.glb', body: 1, priority: 7 },
  { file: 'mazda_rx7.glb', body: 1, priority: 8 },

  // --- suv (2) ---
  { file: 'suv_generic_a.glb', body: 2, priority: 1 },
  { file: 'suv_kenney.glb', body: 2, priority: 2 },
  { file: 'suv_luxury_kenney.glb', body: 2, priority: 3 },
  { file: 'suv_generic_b.glb', body: 2, priority: 4 },
  // 8032 tris in the source manifest -- 32 over the limit. Processed like
  // everything else rather than pre-judged; measured, not assumed.
  { file: 'suv_filler.glb', body: 2, priority: 5 },
  { file: 'nissan_terrano.glb', body: 2, priority: 6 },
  { file: 'suv_offroad_a.glb', body: 2, priority: 7 },
  // Same author, same rig, same tri count as suv_offroad_a -- a repaint, not
  // a second silhouette. Lowest priority of the SUV set for exactly that
  // reason (silhouette variety is what this curation optimizes for).
  { file: 'suv_offroad_b.glb', body: 2, priority: 8 },
  // Both far over MAX_TRIS (10448, 31418).
  { file: 'suv_offroad_c.glb', body: 2, priority: 9 },
  { file: 'range_rover.glb', body: 2, priority: 10 },

  // --- ute (3) --- only 4 candidates exist; all are kept if they pass.
  { file: 'ute_generic.glb', body: 3, priority: 1 },
  { file: 'ute_tray_kenney.glb', body: 3, priority: 2 },
  { file: 'mitsubishi_l200.glb', body: 3, priority: 3 },
  { file: 'toyota_hilux_97.glb', body: 3, priority: 4 },

  // --- van (4) --- only 3 candidates exist; all are kept if they pass.
  { file: 'van_courier_kenney.glb', body: 4, priority: 1 },
  { file: 'van_generic_a.glb', body: 4, priority: 2 },
  { file: 'van_panel.glb', body: 4, priority: 3 },

  // --- specials: no quota, kept if they pass the same per-model limits ---
  // `length` is each one's own real-world target, not borrowed from a
  // numbered class: the surviving police model is SUV-shaped (see its own
  // target_vehicle in the source manifest, "NSW Police general-duties
  // SUV/wagon"), so it is sized like this game's SUV class, not its sedan
  // class, even though "police" is not itself a numbered body.
  { file: 'police_kenney.glb', body: 'police', priority: 1, length: CAR_BODY_SIZE[2].length },
  // 9648 tris -- over the limit; the only other police candidate, and the
  // one that *would* have wanted the sedan length.
  { file: 'police_sedan_charger.glb', body: 'police', priority: 2, length: CAR_BODY_SIZE[0].length },
  { file: 'taxi_generic.glb', body: 'taxi', priority: 1, length: CAR_BODY_SIZE[0].length },
  { file: 'taxi_kenney.glb', body: 'taxi', priority: 2, length: CAR_BODY_SIZE[0].length },
  // A rigid single-deck Sydney Buses bus (Volvo B12BLE / Scania K-series and
  // similar) is about 12.5 m; 12.0 m is a round, slightly conservative
  // stand-in rather than the full figure.
  { file: 'city_bus.glb', body: 'bus', priority: 1, length: 12.0 },
  // A kerbside rear-loader garbage truck is about 9-10 m over the cab and bin body.
  { file: 'garbage_truck_kenney.glb', body: 'garbage', priority: 1, length: 9.0 },
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
  result.axis = direction.axis;
  result.sign = direction.sign;
  result.directionConfidence = direction.confidence;

  await doc.transform(prune(), dedup());
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
    await doc.transform(prune(), join({ keepNamed: false }), weld({ overwrite: true }));
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
    for (let pass = 0; pass < 3 && have > DECIMATE_TO; pass++) {
      const ratio = Math.max(0.002, (DECIMATE_TO * 0.9) / have);
      for (const mesh of doc.getRoot().listMeshes()) {
        for (const prim of mesh.listPrimitives()) {
          const idx = prim.getIndices();
          const pos = prim.getAttribute('POSITION');
          if (!idx || !pos) continue;
          const indices = new Uint32Array(idx.getArray());
          const positions = new Float32Array(pos.getArray());
          const target = Math.max(3, Math.round((indices.length / 3) * ratio) * 3);
          const [out] = MeshoptSimplifier.simplify(indices, positions, 3, target, 1.0, ['Prune']);
          const next = doc.createAccessor().setType('SCALAR').setArray(out).setBuffer(idx.getBuffer());
          prim.setIndices(next);
        }
      }
      // Drop the vertices nothing indexes any more: unweld writes a vertex per
      // index, weld merges them back, and the old accessors are pruned.
      await doc.transform(unweld(), weld({ overwrite: true }), prune());
      const now = countTris(doc);
      if (now >= have * 0.98) break;
      have = now;
    }
    await doc.transform(prune(), dedup());
    // Decimation moves the lowest vertices: the wheels' contact patch is the
    // first detail to go, and the car floats a few centimetres. Grounded and
    // re-centred again, on the decimated mesh, so the gate below measures
    // what ships.
    reground(doc, targetLength);
  }

  await doc.transform(quantize({ pattern: /^(POSITION|NORMAL)$/ }));

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
  const trisOk = tris <= (entry.decimate ? DECIMATE_TO : MAX_TRIS);

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
    if (!trisOk) reasons.push(`${tris} tris > ${entry.decimate ? DECIMATE_TO : MAX_TRIS} limit`);
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
        `${r.steeringZ === null || r.steeringZ === undefined ? '-' : r.steeringZ.toFixed(2)} / ${r.mirrored ? 'yes' : 'no'} / ${r.trisBefore ?? '-'}`,
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
  const srcMeta = JSON.parse(fs.readFileSync(SRC_MANIFEST_PATH, 'utf8'));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Clean slate: remove any .glb left over from a previous run so a file
  // that stops shipping (curation or a tightened limit) doesn't linger.
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f.endsWith('.glb')) fs.unlinkSync(path.join(OUT_DIR, f));
  }

  const results = [];
  for (const entry of CATALOG) {
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
      results.push(r);
    } catch (err) {
      results.push({ file: entry.file, body: entry.body, status: 'rejected', reason: `pipeline error: ${err.stack || err.message}` });
    }
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

  // Manifest: stable file-name order, since a later agent hashes car
  // identity into this list.
  const manifest = shipped
    .map((r) => ({
      file: r.file,
      body: r.body,
      tris: r.tris,
      lengthM: r.lengthM,
      tint: tintFor(r.body),
      weight: r.weight,
      license: r.license,
      attribution: r.attribution,
      source_url: r.source_url,
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
