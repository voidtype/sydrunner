/**
 * Where a world asset actually comes from: a GitHub release, or the origin.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM is bandwidth, not latency. `oxford-tractor` is a 1 GB Binary Lane
 * box with a **20 GB/month transfer cap**, and a single first visit streams
 * ~200 MB of precompressed city as the player walks. That is a hundred first
 * visits a month before the host starts charging or shaping -- the site is
 * broken by being played, which is the worst way for a thing to be broken.
 *
 * Nothing about the world *needs* to come from the origin. It is 3,928 immutable
 * files, identical for every player, already versioned by `?v=<built>` and
 * already safe to cache for a year (`world/version.ts` has that argument). It is
 * a static asset problem wearing a game's clothes, and the cheapest CDN for a
 * static asset problem is a GitHub release: no bandwidth cap, a global edge, and
 * `access-control-allow-origin: *` on every object.
 *
 * ---------------------------------------------------------------------------
 * THE MAPPING. `scripts/publish-world-release.sh` uploads every file under
 * `client/public/world` gzipped, into releases tagged `world-<built>-s<shard>`
 * -- `<built>` being the same integer the client already puts in `?v=`. So the
 * release a client wants is a pure function of the index it has already read:
 * no lookup, no config, no second source of truth. Release assets are a flat
 * namespace, so the path separator is encoded as a double underscore:
 *
 *     tiles/-5_9.glb      ->  tiles__-5_9.glb.gz
 *     collision/-5_9.bin  ->  collision__-5_9.bin.gz
 *
 * That encoding is reversible here because no world filename contains `__` --
 * tile keys are `<x>_<z>` with single underscores. `verifyCdn` round-trips it,
 * and the shell script's `sed` is the other half; change one, change both.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE EIGHT RELEASES. **GitHub allows 1000 assets per release**, and
 * the inner ring alone is 3,928 files -- the first attempt at this uploaded
 * exactly 1000 and then started refusing, which is a limit worth knowing about
 * before it is discovered in production. So the world is sharded:
 *
 *     world-<built>-s0 .. world-<built>-s7
 *
 * An asset's shard is `FNV-1a(name) mod 8` -- 485 to 496 files each, no shard
 * near the cap, and room for a world twice this size before the count has to
 * change. Because the shard is a function of the *name*, the client needs no
 * manifest and no extra request: it hashes the asset it already wants and knows
 * which release to ask. `publish-world-release.sh` runs the identical arithmetic
 * in Python, and `verifyCdn` pins six known answers so the two implementations
 * cannot drift apart without a boot failure saying so.
 *
 * ---------------------------------------------------------------------------
 * THE BLOCKER, and why this module is switched off. **GitHub release assets do
 * not send `access-control-allow-origin`.** They never did on the host they are
 * served from now: a download redirects from `github.com` to
 * `release-assets.githubusercontent.com`, which is an Azure Blob backend, and
 * its 200 carries `content-disposition: attachment` and no CORS header at all.
 * Measured on a real asset from `world-1785761486-s0`, 2026-08-04:
 *
 *     fetch(asset)                    -> TypeError: Failed to fetch
 *     fetch(asset, {mode:'no-cors'})  -> opaque, status 0   (it *reaches* the
 *                                        server -- this is CORS, not a network
 *                                        or DNS failure)
 *     fetch(raw.githubusercontent...) -> 200 ok             (control: the same
 *                                        browser does cross-origin fine)
 *
 * An opaque response cannot be read, so `arrayBuffer()` is not available and no
 * amount of client code recovers it. This is GitHub infrastructure and is not
 * configurable from a repo. So `CDN_ENABLED` is false and every asset takes the
 * origin path -- see the constant for what would change that.
 *
 * The one GitHub surface that *does* send `access-control-allow-origin: *` is
 * `raw.githubusercontent.com`, which serves files out of the git tree rather
 * than out of releases. Using it would mean committing ~195 MB of world
 * binaries into git history, permanently and for every rebuild, which is the
 * thing `.gitignore` and this whole release scheme exist to avoid. That is a
 * trade worth making deliberately or not at all, so it is written down here
 * rather than taken.
 *
 * ---------------------------------------------------------------------------
 * `index.json` IS NOT FETCHED FROM HERE, ever. It is the mutable pivot that
 * names the version everything else is cached under, and a client that read its
 * index from `world-<built>` would be using the answer to find the question.
 * `streamer.loadIndex` calls plain `fetch` and is the one world fetch in the
 * client that does. The release contains a copy for completeness only.
 *
 * ---------------------------------------------------------------------------
 * FAILURE IS ROUTINE AND COSTS ONE REQUEST. The origin still serves the whole
 * world at `?v=<built>` and always will -- this module is a bandwidth
 * optimisation layered over a path that already worked, and every way it can go
 * wrong lands back on that path:
 *
 *   - no `DecompressionStream` in this engine   -> origin, decided once at boot
 *   - the boot probe fails (offline, CORS, 404) -> origin, decided once
 *   - one asset 404s or fails to decode         -> origin, that asset only
 *   - five consecutive CDN failures             -> origin for the rest of the
 *                                                  session, decided once
 *
 * The five-strike rule exists because the per-file fallback is *not* free: a
 * dead CDN would otherwise cost every tile a doomed round-trip forever. One
 * flaky asset should not disable the CDN; a flaky network should.
 *
 * An aborted request is the one failure that does **not** fall back. When the
 * streamer evicts a tile mid-flight it aborts the fetch, and retrying that on
 * the origin would defeat the cancellation it just asked for.
 *
 * ---------------------------------------------------------------------------
 * DEV TOGGLES, all query parameters:
 *
 *     ?cdn        try the release CDN at all. Off by default -- see THE BLOCKER.
 *     ?nocdn      pin every asset to the origin, once the default flips back
 *     ?cdnbogus   point the CDN at a tag that does not exist, to watch the
 *                 fallback carry the whole world without the player noticing
 */

/** The release download root. Baked, because it is where this repo publishes. */
const RELEASE_BASE = 'https://github.com/voidtype/sydrunner/releases/download';

/**
 * How many releases the world is spread over. Must equal `SHARDS` in
 * `scripts/publish-world-release.sh`; changing it moves every asset to a
 * different release, so it is a full re-upload rather than a tweak.
 */
const SHARDS = 8;

/** Consecutive CDN failures that disable it for the session. See the header. */
const STRIKES = 5;

/** How long the boot probe gets before the CDN is written off. */
const PROBE_TIMEOUT_MS = 3000;

/**
 * The probe asset: the smallest thing in the world that is always present.
 * `suburbs.json` is ~6 kB raw and about 2 kB gzipped, so the probe costs less
 * than a single tile's params sidecar and proves the whole chain at once --
 * CORS, the release tag, gzip, and `DecompressionStream`.
 */
const PROBE_PATH = 'suburbs.json';

/** Counters for the debug overlay. Cheap enough to keep unconditionally. */
export interface CdnStats {
  /** Assets served from the release CDN. */
  hits: number;
  /** Assets that fell back to the origin after a CDN attempt failed. */
  fallbacks: number;
  /** Assets fetched from the origin without trying the CDN. */
  origin: number;
  /** Whether the CDN is currently believed usable. */
  enabled: boolean;
  /** Why not, when `enabled` is false and something decided that. */
  reason: string;
}

const stats: CdnStats = { hits: 0, fallbacks: 0, origin: 0, enabled: true, reason: '' };
let consecutiveFailures = 0;
let probe: Promise<boolean> | null = null;

/** A snapshot for the HUD. Copied, so a caller cannot edit the counters. */
export function cdnStats(): CdnStats {
  return { ...stats };
}

/**
 * The counters, on `window`, because the question this module exists to answer
 * -- "is the city actually coming from GitHub?" -- is otherwise only answerable
 * from the network panel, and the network panel throttles when the tab is not
 * on screen. `__cdn()` in the console reads the truth at any moment:
 *
 *     > __cdn()
 *     { hits: 812, fallbacks: 0, origin: 1, enabled: true, reason: '' }
 *
 * One `origin` is expected and correct: it is the first asset, fetched while
 * the boot probe was still deciding.
 *
 * Reached through `globalThis` rather than by naming `window`, because this
 * module is imported by `world/terrain.ts` and therefore compiled a second time
 * by `server/tsconfig.json` **without the DOM lib** -- which is that file's
 * whole purpose, and it caught this line the first time it was written.
 */
const globalScope = globalThis as unknown as {
  window?: unknown;
  __cdn?: () => CdnStats;
};
if (typeof globalScope.window === 'object') {
  globalScope.__cdn = cdnStats;
}

function disable(reason: string): void {
  if (!stats.enabled) return;
  stats.enabled = false;
  stats.reason = reason;
}

/**
 * The query parameters, read once. Guarded because this module is imported by
 * `verifyCdn`'s callers in Bun, where `location` does not exist.
 */
const params =
  typeof location === 'object' && typeof location.search === 'string'
    ? new URLSearchParams(location.search)
    : new URLSearchParams();

/**
 * **Off by default, and the reason is not caution.** See `THE BLOCKER` at the
 * top of this file: GitHub release assets carry no CORS header, so a browser on
 * `oxford-tractor.bnr.la` cannot read one at all. Turning this on in production
 * would make every world fetch a failed cross-origin request followed by the
 * origin fetch it would have made anyway -- strictly slower, and no cheaper.
 *
 * `?cdn` turns it on for testing. The whole machinery below is finished and
 * verified against the real releases; it is one constant away from shipping if
 * GitHub ever sends `access-control-allow-origin`, or if the assets move to a
 * host that does.
 */
const CDN_ENABLED = params.has('cdn');

/** `?nocdn` -- kept so the flag still reads as an override once the default flips. */
const PINNED_TO_ORIGIN = params.has('nocdn') || !CDN_ENABLED;

/** `?cdnbogus` -- a tag that cannot exist, to exercise the fallback for real. */
const BOGUS = params.has('cdnbogus');

/**
 * Whether this engine can inflate a gzip stream. Every current browser can;
 * `DecompressionStream` is Baseline since 2023. An engine that cannot is not
 * broken, it just reads the world from the origin like it always did.
 */
export function canDecompress(): boolean {
  return typeof DecompressionStream === 'function';
}

/**
 * `tiles/-5_9.glb` -> `tiles__-5_9.glb`. The release asset name, minus the
 * `.gz`. Leading slashes are tolerated so callers can pass either shape.
 */
export function flattenWorldPath(path: string): string {
  return path.replace(/^\/+/, '').split('/').join('__');
}

/** The inverse, which exists so `verifyCdn` can prove the mapping is 1:1. */
export function unflattenWorldPath(flat: string): string {
  return flat.split('__').join('/');
}

/**
 * Which release holds this asset: FNV-1a 32-bit over the **full asset name,
 * `.gz` included**, mod `SHARDS`.
 *
 * FNV-1a because it is four lines in every language, has no dependencies, and
 * two implementations of it agree by inspection -- which matters more here than
 * distribution quality, since the other implementation is Python in a shell
 * script and any disagreement is 3,928 silent 404s. `Math.imul` is what keeps
 * the multiply in 32 bits; a plain `*` would go through a double at the fourth
 * character and diverge from the Python.
 *
 * @param name the asset name, e.g. `tiles__-5_9.glb.gz`
 */
export function shardOf(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i += 1) {
    h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h % SHARDS;
}

/**
 * The build stamp, recovered from the `?v=<built>` suffix the call sites
 * already carry. This is why wiring the CDN in did not need a new argument
 * threaded through eight modules: every world fetch already knew the version,
 * it just spent it on a query string.
 */
export function builtFromSuffix(version: string): number | null {
  const match = /^\?v=(\d+)$/.exec(version);
  if (!match) return null;
  const built = Number(match[1]);
  return Number.isSafeInteger(built) && built > 0 ? built : null;
}

/** The release URL for one asset, or null if this build cannot use the CDN. */
export function cdnAssetUrl(path: string, version: string): string | null {
  const built = builtFromSuffix(version);
  if (built === null) return null;
  const name = `${flattenWorldPath(path)}.gz`;
  const tag = BOGUS ? `world-${built}-bogus` : `world-${built}-s${shardOf(name)}`;
  return `${RELEASE_BASE}/${tag}/${name}`;
}

/** The origin URL: exactly what every call site built before this module. */
export function originAssetUrl(baseUrl: string, path: string, version: string): string {
  return `${baseUrl}/${path}${version}`;
}

/**
 * One GET of the probe asset, decoded end to end. Decoding rather than a bare
 * `HEAD` is deliberate: a `HEAD` proves the object exists, and what this needs
 * to know is that the *whole chain* works in this browser, on this network,
 * behind whatever corporate middlebox is between them.
 */
async function runProbe(version: string): Promise<boolean> {
  const url = cdnAssetUrl(PROBE_PATH, version);
  if (!url) return false;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!resp.ok || !resp.body) {
      disable(`probe ${resp.status}`);
      return false;
    }
    const buf = await new Response(
      resp.body.pipeThrough(new DecompressionStream('gzip')),
    ).arrayBuffer();
    if (buf.byteLength === 0) {
      disable('probe empty');
      return false;
    }
    return true;
  } catch {
    // Offline, CORS, DNS, timeout. All the same answer.
    disable('probe failed');
    return false;
  }
}

/**
 * The one-time health check. Bounded by `PROBE_TIMEOUT_MS` by construction, so
 * awaiting it cannot stall a fetch longer than that -- and after it settles
 * every later call reads a resolved promise. The first tile pays the probe;
 * nothing else does.
 */
function ensureProbe(version: string): Promise<boolean> {
  probe ??= runProbe(version);
  return probe;
}

/** Whether the CDN should even be attempted for this build. */
function cdnUsable(version: string): boolean {
  return (
    !PINNED_TO_ORIGIN && stats.enabled && canDecompress() && builtFromSuffix(version) !== null
  );
}

function strike(): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= STRIKES) disable(`${STRIKES} consecutive failures`);
}

/**
 * Try the CDN. Returns the decompressed bytes, or null to mean "use the
 * origin" -- null is the entire error channel, because every distinguishable
 * failure has the same remedy.
 */
async function tryCdn(path: string, version: string, init?: RequestInit): Promise<ArrayBuffer | null> {
  const url = cdnAssetUrl(path, version);
  if (!url) return null;
  try {
    const resp = await fetch(url, init);
    if (!resp.ok || !resp.body) {
      strike();
      return null;
    }
    const buf = await new Response(
      resp.body.pipeThrough(new DecompressionStream('gzip')),
    ).arrayBuffer();
    consecutiveFailures = 0;
    stats.hits += 1;
    return buf;
  } catch (err) {
    // The caller cancelled -- a tile went out of range mid-flight. Propagate,
    // because falling back to the origin here would re-fetch on the origin's
    // bandwidth something nobody is waiting for any more.
    if (init?.signal?.aborted) throw err;
    strike();
    return null;
  }
}

/**
 * **The one entry point.** A world asset, from the CDN when that is working and
 * from the origin when it is not, as a `Response` either way so that call sites
 * keep their existing `.ok` / `.arrayBuffer()` / `.json()` handling unchanged.
 *
 * @param baseUrl the world root, `/world` everywhere in this client
 * @param path    world-relative, no leading slash: `tiles/5_-1.glb`
 * @param version the `?v=<built>` suffix from `streamer.assetVersion`
 */
export async function fetchWorldAsset(
  baseUrl: string,
  path: string,
  version: string,
  init?: RequestInit,
): Promise<Response> {
  if (cdnUsable(version) && (await ensureProbe(version)) && cdnUsable(version)) {
    const buf = await tryCdn(path, version, init);
    if (buf) return new Response(buf, { status: 200 });
    stats.fallbacks += 1;
  } else {
    stats.origin += 1;
  }
  return fetch(originAssetUrl(baseUrl, path, version), init);
}

/**
 * The same thing for the two callers that hand bytes to a parser rather than
 * reading a `Response`: the tile GLBs and the landmark GLB, which go to
 * `GLTFLoader.parseAsync`. Throws on an origin failure, like `loadAsync` did.
 */
export async function fetchWorldBuffer(
  baseUrl: string,
  path: string,
  version: string,
  init?: RequestInit,
): Promise<ArrayBuffer> {
  const resp = await fetchWorldAsset(baseUrl, path, version, init);
  if (!resp.ok) throw new Error(`${path} ${resp.status}`);
  return resp.arrayBuffer();
}

/**
 * Boot check, in the shape every other subsystem here uses: a list of things
 * that are wrong, empty when nothing is.
 *
 * What is worth checking is the *mapping*, because it is the half of a
 * two-repo contract that this file cannot see the other side of. If
 * `publish-world-release.sh` and this module disagree about how a path becomes
 * an asset name, every fetch 404s and every one of them silently falls back --
 * the world still loads, the bandwidth bill does not change, and nothing in the
 * game looks wrong. That is precisely the failure a boot check is for.
 */
export function verifyCdn(): string[] {
  const failures: string[] = [];

  // --- 1. Flattening, against the names the publish script actually produced.
  const cases: [string, string][] = [
    ['tiles/-5_9.glb', 'tiles__-5_9.glb'],
    ['tiles/-10_-1.params.bin', 'tiles__-10_-1.params.bin'],
    ['collision/-5_9.bin', 'collision__-5_9.bin'],
    ['suburbs.json', 'suburbs.json'],
    ['far-water.bin', 'far-water.bin'],
    ['landmarks.glb', 'landmarks.glb'],
  ];
  for (const [path, flat] of cases) {
    const got = flattenWorldPath(path);
    if (got !== flat) failures.push(`flatten ${path}: expected ${flat}, got ${got}`);
    const back = unflattenWorldPath(got);
    if (back !== path) failures.push(`flatten round trip ${path}: got ${back}`);
  }

  // --- 2. A leading slash must not survive into an asset name.
  if (flattenWorldPath('/tiles/1_1.glb') !== 'tiles__1_1.glb') {
    failures.push('flatten kept a leading slash');
  }

  // --- 3. The stamp, recovered from the suffix the call sites carry.
  if (builtFromSuffix('?v=1785761486') !== 1785761486) failures.push('builtFromSuffix rejected a real stamp');
  for (const bad of ['', '?v=', '?v=abc', 'v=123', '?v=0', '?version=1']) {
    if (builtFromSuffix(bad) !== null) failures.push(`builtFromSuffix accepted ${JSON.stringify(bad)}`);
  }

  // --- 4. The shard, against answers computed by the *publish script's* Python.
  // This is the check that matters most in this file. The two hashes live in
  // different languages in different repos-worth of tooling, and if they drift
  // every asset 404s into a silent origin fallback -- the world still loads, the
  // game still plays, and the only symptom is the bandwidth bill this whole
  // module exists to remove. Regenerate these with:
  //
  //   python3 -c 'h=0x811c9dc5
  //   for b in b"suburbs.json.gz": h=((h^b)*0x01000193)&0xFFFFFFFF
  //   print(h%8)'
  const shards: [string, number][] = [
    ['suburbs.json.gz', 2],
    ['tiles__-5_9.glb.gz', 2],
    ['collision__-5_9.bin.gz', 3],
    ['landmarks.glb.gz', 2],
    ['far-water.bin.gz', 6],
    ['index.json.gz', 0],
    ['tiles__-10_-1.params.bin.gz', 7],
  ];
  for (const [name, want] of shards) {
    const got = shardOf(name);
    if (got !== want) failures.push(`shardOf(${name}): expected s${want}, got s${got}`);
  }
  if (shardOf('') !== 0x811c9dc5 % SHARDS) failures.push('shardOf lost its FNV offset basis');

  // --- 5. The full URL, which is the string the release has to answer to.
  const url = cdnAssetUrl('tiles/-5_9.glb', '?v=1785761486');
  const want = BOGUS
    ? `${RELEASE_BASE}/world-1785761486-bogus/tiles__-5_9.glb.gz`
    : `${RELEASE_BASE}/world-1785761486-s2/tiles__-5_9.glb.gz`;
  if (url !== want) failures.push(`cdnAssetUrl: expected ${want}, got ${url}`);

  // --- 6. An unstamped world has no release, and must say so rather than
  // inventing `world-NaN`. This is the pre-`built` pipeline output, which
  // `version.ts` promises still loads.
  if (cdnAssetUrl('tiles/1_1.glb', '') !== null) failures.push('cdnAssetUrl invented a tag for an unstamped world');

  // --- 7. The origin URL is still exactly what it was before this file
  // existed. It is the fallback, so a regression here breaks everything.
  const origin = originAssetUrl('/world', 'tiles/5_-1.glb', '?v=1785761486');
  if (origin !== '/world/tiles/5_-1.glb?v=1785761486') failures.push(`originAssetUrl: got ${origin}`);

  // --- 8. Feature detection has to be wired to the decision, in whichever
  // direction this engine happens to answer.
  if (!canDecompress() && cdnUsable('?v=1785761486')) {
    failures.push('CDN enabled without DecompressionStream');
  }

  return failures;
}
