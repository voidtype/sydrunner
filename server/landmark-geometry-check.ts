/**
 * No landmark may draw anything a kilometre and a half from its own anchor.
 *
 *     bun run server/landmark-geometry-check.ts
 *     bun run server/landmark-geometry-check.ts --glb /tmp/candidate/landmarks.glb
 *     SYDNEY_WORLD=/opt/sydney/dist/world bun run server/landmark-geometry-check.ts
 *
 * ---------------------------------------------------------------------------
 * ## The defect this exists for, because nothing else in the stack could see it
 *
 * `landmarks.glb` shipped with **190 of Luna Park's vertices sixty-four
 * kilometres outside the city** -- painted walls, a string course, a cornice, a
 * parapet, glazed bays and a steel hip roof, spread over four of the node's
 * eight primitives, all of them at node-local (-28,747, +57,090). That is the
 * park's Administration building, built at ENU (-28,665, -54,869) instead of at
 * Milsons Point, and the park on the foreshore simply did not have one.
 *
 * The cause is in `pipeline/sydney/landmarks.py` (`ANCHOR_REACH_M` carries the
 * write-up): the anchor for that hall selected on `name='Administration'` with
 * no distance term, over a read whose bounding box is the *caller's* radius --
 * 4 km when `pads.py` asks and 60 km when the world is baked -- so at bake time
 * a bigger building of the same name out past Wollondilly won it. That is fixed
 * at the source. This file is the fence that would have convicted it, and it is
 * here because **every other gate in the stack passed the broken file**:
 *
 *   - `verifyLandmarks` (both boot lists) checks the *contract* -- the material
 *     list, sea level, the published dimensions in the manifest. All four were
 *     right: the numbers describe the entrance towers, and the entrance towers
 *     were where they belong.
 *   - `landmark-audit`'s placement pass measures a *probe band* -- the gold
 *     finials for Luna Park -- and reported an error of 0.13 m.
 *   - `undrawn-solids-check` reads the tiles and does not open this file at all.
 *   - The renderer draws it without a murmur: a primitive 64 km away is outside
 *     every frustum the player will ever have, so the only symptom is a hall
 *     that is missing from a park nobody had counted the buildings in.
 *
 * So the test is the whole vertex cloud rather than a probe, and it is the
 * cheapest possible one: read the shipped positions, add the node translation,
 * and measure the plan distance to the anchor the manifest registers that
 * landmark to. `pipeline`'s `landmark-audit` runs the same test on the same
 * bytes -- deliberately, because the two are reached from different places. The
 * pipeline audit gates a *bake*; this gates a **deploy**, runs on the box's own
 * `SYDNEY_WORLD` with no Python and no OSM extract anywhere near it, and can be
 * pointed at a candidate GLB with `--glb` before it is uploaded.
 *
 * ---------------------------------------------------------------------------
 * ## Why a hand-written GLB reader and not `parseTileGlb`
 *
 * `parseTileGlb` is a reader of *tile* GLBs: it expects the twelve fields a
 * tile carries, the packed quantisation `meshpack` applies, and the material
 * slot names the city is drawn in. `landmarks.glb` is none of those -- it is
 * unpacked float32 (four hero models are 1.7 MB and the file is fetched once),
 * it names its materials out of `LANDMARK_MATERIALS`, and its geometry lives
 * under one node per landmark with the anchor on the node's translation.
 * Pointing the tile reader at it would either throw or, worse, succeed on a
 * misreading. What is needed here is the chunk header, the accessors' offsets
 * and POSITION -- forty lines, no dependency, and three-free by construction,
 * which is what `server/` requires of anything it imports.
 *
 * ---------------------------------------------------------------------------
 * ## The bar, and why it is loose
 *
 * `EXTENT_BUDGET_M` is 1.5 km, which is enormous next to the 10 m tolerance
 * `landmark-audit` holds placement to. That is on purpose and it is not a
 * ratchet: the bridge's approach viaducts genuinely reach 853 m from the deck
 * polygon's centroid, and a landmark is allowed to be big. What this convicts
 * is a *sub-feature built in the wrong frame* -- an un-anchored polygon, an ENU
 * ring where a local one was wanted, degrees where metres were wanted, or the
 * wrong OSM feature entirely -- and every one of those misses by kilometres or
 * by tens of them. Nothing built correctly comes within a factor of one and a
 * half of this line, so there is no honest reason to ever raise it.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** How far, in plan metres, any single vertex may sit from its landmark's anchor. */
export const EXTENT_BUDGET_M = 1500;

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const ROOT = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
const GLB = flag('glb', join(ROOT, 'landmarks.glb'));
const INDEX = flag('index', join(ROOT, 'index.json'));

const say = (s: string): void => console.log(s);
const padR = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const pad = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s);

// --- The GLB ---------------------------------------------------------------------

interface Primitive {
  material: string;
  /** Interleaved-free float32 positions, `[x, y, z, ...]`, node-local. */
  positions: Float32Array;
}
interface Node {
  name: string;
  /** `(east, 0, -north)` of the landmark's anchor, as the file carries it. */
  translation: [number, number, number];
  primitives: Primitive[];
}

/**
 * `landmarks.glb` as nodes of float32 positions.
 *
 * Only POSITION is read: normals are `landmark-audit`'s winding pass and the
 * UVs are nobody's. A non-float32 or sparse POSITION accessor is refused rather
 * than guessed at -- `write_landmarks` has never written one, and a reader that
 * silently coped with a format change is a reader that stops checking.
 */
function readLandmarkGlb(path: string): { nodes: Node[]; materials: string[] } {
  const file = readFileSync(path);
  const buf = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (buf.getUint32(0, true) !== 0x46546c67) throw new Error(`${path} is not a GLB (bad magic)`);
  const jsonLength = buf.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(file.subarray(20, 20 + jsonLength)));
  // The BIN chunk follows the JSON chunk's own 8-byte header.
  const binStart = 20 + jsonLength + 8;

  const materials: string[] = (json.materials ?? []).map((m: { name?: string }) => m.name ?? '');
  const nodes: Node[] = [];
  for (const node of json.nodes ?? []) {
    if (node.mesh === undefined) continue;
    const primitives: Primitive[] = [];
    for (const prim of json.meshes[node.mesh].primitives ?? []) {
      const acc = json.accessors[prim.attributes.POSITION];
      if (acc.componentType !== 5126 || acc.type !== 'VEC3' || acc.sparse) {
        throw new Error(
          `${path}: node ${node.name} has a POSITION accessor this reader does not ` +
            `understand (componentType ${acc.componentType}, type ${acc.type}). ` +
            `write_landmarks emits unpacked float32 VEC3; if that has changed, change this.`,
        );
      }
      const view = json.bufferViews[acc.bufferView];
      const start = binStart + (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
      // Copied rather than viewed: the accessor's start is only 4-byte aligned
      // within the file's own buffer, and a Float32Array view demands 4-byte
      // alignment against the *ArrayBuffer*, which readFileSync does not promise.
      const positions = new Float32Array(acc.count * 3);
      for (let i = 0; i < positions.length; i++) positions[i] = buf.getFloat32(start + i * 4, true);
      primitives.push({ material: materials[prim.material] ?? '?', positions });
    }
    const t = node.translation ?? [0, 0, 0];
    nodes.push({ name: node.name ?? '?', translation: [t[0], t[1], t[2]], primitives });
  }
  return { nodes, materials };
}

// --- The check -------------------------------------------------------------------

interface Manifest {
  materials?: string[];
  items?: Array<{ name: string; anchor_enu: [number, number] }>;
}

say('');
say('landmark geometry -- every shipped vertex against its own anchor');
say('');
if (!existsSync(GLB)) {
  say(`  no landmark file at ${GLB}.`);
  say('  This world was built before the landmark pass, or SYDNEY_WORLD is wrong. Nothing to check.');
  process.exit(0);
}

const { nodes, materials } = readLandmarkGlb(GLB);
const manifest: Manifest = existsSync(INDEX)
  ? (JSON.parse(readFileSync(INDEX, 'utf8')).landmarks ?? {})
  : {};
const anchors = new Map<string, [number, number]>(
  (manifest.items ?? []).map((i) => [i.name, i.anchor_enu]),
);

say(`  file      ${GLB}`);
say(`  materials ${materials.join(', ')}`);
say('');

const failures: string[] = [];

// The GLB's own material block against the manifest's. `verifyLandmarks` in
// both boot lists compares the *manifest* to the client's list and is fatal on
// a mismatch; nothing compared the manifest to the file the client actually
// resolves those names in, and a GLB whose block has drifted paints every
// primitive in whatever slot 0 happens to be.
if (manifest.materials && manifest.materials.join(',') !== materials.join(',')) {
  failures.push(
    `the GLB names materials [${materials.join(',')}] where index.json's landmark ` +
      `manifest carries [${manifest.materials.join(',')}]. The client resolves them by ` +
      `name out of the manifest's list, so the two must be one list.`,
  );
}

say(`  ${padR('node', 18)}${pad('vertices', 10)}${pad('beyond', 8)}${pad('worst m', 12)}  worst vertex (ENU)`);
for (const node of nodes) {
  // The anchor from the manifest where there is one, and from the node's own
  // translation where there is not -- `write_landmarks` puts the anchor there
  // and `landmark-audit` proves the two agree, so a missing index is a reason
  // to check less confidently, not a reason to skip the file.
  const anchor = anchors.get(node.name) ?? [node.translation[0], -node.translation[2]];
  let count = 0;
  let beyond = 0;
  let worst = 0;
  let at: [number, number] = [0, 0];
  for (const prim of node.primitives) {
    for (let i = 0; i < prim.positions.length; i += 3) {
      const east = prim.positions[i] + node.translation[0];
      const north = -(prim.positions[i + 2] + node.translation[2]);
      const d = Math.hypot(east - anchor[0], north - anchor[1]);
      count++;
      if (d > EXTENT_BUDGET_M) beyond++;
      if (d > worst) {
        worst = d;
        at = [east, north];
      }
    }
  }
  const flagged = beyond > 0 ? '   <-- OUT' : '';
  say(
    `  ${padR(node.name, 18)}${pad(count.toLocaleString(), 10)}${pad(String(beyond), 8)}` +
      `${pad(worst.toLocaleString(undefined, { maximumFractionDigits: 1 }), 12)}  ` +
      `(${at[0].toFixed(1)}, ${at[1].toFixed(1)})${flagged}`,
  );
  if (beyond > 0) {
    failures.push(
      `${node.name} draws ${beyond} vertices up to ${worst.toFixed(0)} m from its anchor, ` +
        `the worst at ENU (${at[0].toFixed(0)}, ${at[1].toFixed(0)}). A sub-feature is being ` +
        `built off the wrong anchor or in the wrong frame; see the header.`,
    );
  }
}

if (failures.length > 0) {
  say('');
  say('  FAIL');
  for (const f of failures) say(`    ${f}`);
  say('');
  say('  This is a bake defect, not a deploy one: fix it in pipeline/sydney/landmarks.py,');
  say('  rebuild landmarks.glb, and re-run against the candidate with --glb before publishing.');
  process.exit(1);
}

say('');
say(`  PASS -- ${nodes.length} landmarks, no vertex beyond ${EXTENT_BUDGET_M.toLocaleString()} m of its anchor`);
process.exit(0);
