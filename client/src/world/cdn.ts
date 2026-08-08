/**
 * Where a world asset actually comes from: jsDelivr, or the origin.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM is bandwidth, not latency. `oxford-tractor` is a 1 GB Binary Lane
 * box with a **20 GB/month transfer cap**, and a first visit streams ~175 MB of
 * city as the player walks. That is a hundred first visits a month before the
 * host starts shaping or charging -- the site is broken by being played, which
 * is the worst way for a thing to be broken.
 *
 * Nothing about the world *needs* to come from the origin. It is 3,928 immutable
 * files, identical for every player, already versioned by `?v=<built>` and
 * already safe to cache for a year (`world/version.ts` has that argument). It is
 * a static asset problem wearing a game's clothes.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT GITHUB RELEASES, which is where this started and what the first
 * version of this file did. **Release assets carry no CORS header.** A download
 * redirects from `github.com` to `release-assets.githubusercontent.com`, an
 * Azure Blob backend whose 200 has no `access-control-allow-origin` at all.
 * Measured 2026-08-04:
 *
 *     fetch(asset)                    -> TypeError: Failed to fetch
 *     fetch(asset, {mode:'no-cors'})  -> opaque, status 0  (it reaches the
 *                                        server, so this is CORS, not network)
 *
 * An opaque response cannot be read, and this is GitHub infrastructure rather
 * than anything configurable from a repo. Releases are also capped at 1000
 * assets, which a 3,928-file world does not fit in.
 *
 * ---------------------------------------------------------------------------
 * SO: jsDelivr, over a dedicated data repo. `voidtype/sydrunner-world` holds the
 * world as a normal git tree -- real paths, one commit, rebuilt every publish --
 * and jsDelivr serves any git ref with:
 *
 *     access-control-allow-origin: *
 *     cache-control: public, max-age=31536000, s-maxage=31536000, immutable
 *
 * The URL is a concatenation, because a git tree keeps the paths the world
 * already has:
 *
 *     https://cdn.jsdelivr.net/gh/<repo>@<ref>/tiles/-5_9.glb
 *
 * `<ref>` is a **commit SHA**, not a tag: jsDelivr treats `@<sha>` as immutable
 * and caches it forever, where a tag is a moving target it must revalidate.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FILES ARE NOT GZIPPED, which is the one counter-intuitive part.
 * jsDelivr brotli-compresses on the fly, and measured against a real tile it
 * beats a pre-gzipped copy -- a `.gz` can only be served as opaque bytes, where
 * a raw file gets content negotiation:
 *
 *     tiles/-10_-1.glb   raw 1,921,940   br 540,716   .gz 597,683
 *
 * GLB is 97% of the world by bytes, so raw saves ~17 MB of a ~192 MB first
 * visit. It also deletes a layer of this file that used to exist: there is no
 * `DecompressionStream` here, no feature detection, and no engine that cannot
 * inflate, because `Content-Encoding` is the browser's job and is transparent to
 * `fetch`. The bytes that come out of `arrayBuffer()` are the bytes the pipeline
 * wrote.
 *
 * ---------------------------------------------------------------------------
 * HOW THE CLIENT LEARNS THE REF. `scripts/publish-world.sh` stamps it into the
 * **origin's** `index.json` after pushing:
 *
 *     "cdn": { "ref": "<sha>", "repo": "voidtype/sydrunner-world" }
 *
 * which rides the normal `dist/` rsync and needs no pipeline change and no
 * rebuild of the client. `armCdn` is handed that block by `streamer.loadIndex`,
 * which is also the moment the version suffix is computed -- so one mutable file
 * on the origin points at an immutable tree on a CDN, and a world with no `cdn`
 * block simply has no CDN and loads exactly as it always did.
 *
 * `index.json` itself is never fetched from here. It is the pivot that names the
 * version everything else is cached under, and reading it from an immutable ref
 * would be using the answer to find the question.
 *
 * ---------------------------------------------------------------------------
 * FAILURE IS ROUTINE AND COSTS ONE REQUEST. The origin still serves the whole
 * world at `?v=<built>` and always will -- this module is a bandwidth
 * optimisation over a path that already worked, and every way it can go wrong
 * lands back on that path:
 *
 *   - no `cdn` block in the index              -> origin, decided once
 *   - the boot probe fails (offline, cold ref) -> origin, decided once
 *   - one asset 404s or fails                  -> origin, that asset only
 *   - five consecutive CDN failures            -> origin for the session
 *
 * The five-strike rule exists because the per-file fallback is not free: a dead
 * CDN would otherwise cost every tile a doomed round-trip forever. One flaky
 * asset should not disable the CDN; a flaky network should.
 *
 * An aborted request is the one failure that does **not** fall back. When the
 * streamer evicts a tile mid-flight it aborts the fetch, and retrying that on
 * the origin would defeat the cancellation it just asked for.
 *
 * ---------------------------------------------------------------------------
 * DEV TOGGLES, all query parameters:
 *
 *     ?nocdn      pin every asset to the origin, whatever the index says
 *     ?cdnbogus   point the ref at a SHA that cannot exist, to watch the
 *                 fallback carry the whole world without the player noticing
 */

/** jsDelivr's GitHub endpoint. `/gh/<owner>/<repo>@<ref>/<path>`. */
const JSDELIVR = 'https://cdn.jsdelivr.net/gh';

/** Consecutive CDN failures that disable it for the session. See the header. */
const STRIKES = 5;

/** How long the boot probe gets before the CDN is written off. */
const PROBE_TIMEOUT_MS = 4000;

/**
 * The probe asset: the smallest thing in the world that is always present.
 * `suburbs.json` is ~6 kB, so the probe costs less than one tile's params
 * sidecar and proves the whole chain at once -- CORS, the ref, and that
 * jsDelivr has the tree warm.
 */
const PROBE_PATH = 'suburbs.json';

/**
 * The index block that turns this on. Structural, like `VersionedIndex` in
 * `version.ts`, so nothing here imports the streamer.
 */
export interface CdnContract {
  /** The commit SHA in the data repo. Immutable, so jsDelivr caches it forever. */
  ref?: string;
  /** `owner/name` of the data repo. */
  repo?: string;
  /**
   * A plain origin the world sits directly under, with no ref in the path:
   * `https://world.example.com` or an R2 `*.r2.dev` development URL, and the
   * asset is `<base>/<path>`.
   *
   * **The R2 target**, and it takes precedence over `ref`/`repo` when both are
   * present, so a publish to either host is a one-key change in `index.json`
   * and `root.json` rather than a client deploy. `scripts/publish-world-r2.sh`
   * stamps this; `scripts/publish-world.sh` stamps the other two. Both scripts
   * still work and both worlds still load, which is the point: R2 is a second
   * target until it is proven, not a replacement.
   *
   * There is **no ref in an R2 URL and there does not need to be one.** The
   * immutability comes from the same place it has always come from -- the
   * `?v=<built>` suffix in `world/version.ts`, which every asset but the two
   * pivots carries -- and R2 is configured to serve objects with a long
   * `cache-control`. jsDelivr needed a ref because it caches a *path* forever
   * and the paths repeat across builds; an origin that honours a query string
   * does not.
   */
  base?: string;
}

/** The index fields this reads. */
export interface CdnIndex {
  cdn?: CdnContract;
}

/** Counters for the debug overlay. Cheap enough to keep unconditionally. */
export interface CdnStats {
  /** Assets served from the CDN. */
  hits: number;
  /** Assets that fell back to the origin after a CDN attempt failed. */
  fallbacks: number;
  /** Assets fetched from the origin without trying the CDN. */
  origin: number;
  /**
   * Assets served out of a region bundle already in memory, costing no request
   * at all. The number this whole pass exists to move -- see `world/regions.ts`.
   */
  bundled: number;
  /** Whether the CDN is currently believed usable. */
  enabled: boolean;
  /** Why not, when `enabled` is false and something decided that. */
  reason: string;
}

const stats: CdnStats = {
  hits: 0,
  fallbacks: 0,
  origin: 0,
  bundled: 0,
  enabled: false,
  reason: 'not armed',
};
let consecutiveFailures = 0;
let probe: Promise<boolean> | null = null;
let ref = '';
let repo = '';
/** The `cdn.base` origin, when the world is on one. See `CdnContract.base`. */
let base = '';

/** A snapshot for the HUD. Copied, so a caller cannot edit the counters. */
export function cdnStats(): CdnStats {
  return { ...stats };
}

/**
 * The counters, on `globalThis`, because the question this module exists to
 * answer -- "is the city actually coming from the CDN?" -- is otherwise only
 * answerable from the network panel, and the network panel throttles when the
 * tab is not on screen. `__cdn()` in the console reads the truth at any moment:
 *
 *     > __cdn()
 *     { hits: 812, fallbacks: 0, origin: 0, enabled: true, reason: '' }
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
 * The query parameters, read once. Guarded because this module is compiled into
 * the Bun server, where `location` does not exist.
 */
const params =
  typeof location === 'object' && typeof location.search === 'string'
    ? new URLSearchParams(location.search)
    : new URLSearchParams();

/** `?nocdn` -- the pre-CDN behaviour, one reload away, for comparing the two. */
const PINNED_TO_ORIGIN = params.has('nocdn');

/** `?cdnbogus` -- a ref that cannot resolve, to exercise the fallback for real. */
const BOGUS = params.has('cdnbogus');

/**
 * Point this module at the world the index describes. Called by
 * `streamer.loadIndex` the moment `index.json` lands, which is before any other
 * world asset is fetched -- so every fetch after it sees a decided CDN, and the
 * `origin` counter on a healthy boot is 0 rather than "however many raced the
 * probe".
 *
 * An index with no `cdn` block leaves the CDN off, which is what every world
 * built before this existed does, and what `?nocdn` forces.
 */
export function armCdn(index: CdnIndex | null | undefined): void {
  const contract = index?.cdn;
  if (PINNED_TO_ORIGIN) {
    stats.reason = 'pinned to origin';
    return;
  }
  ref = '';
  repo = '';
  base = '';
  if (contract?.base) {
    // A plain origin, checked rather than concatenated blind: an empty or
    // relative `base` would build URLs that resolve against the game's own
    // host, which is the bandwidth bill this module exists to remove wearing a
    // CDN's clothes. `?cdnbogus` points it at a host that cannot answer, which
    // exercises the per-asset fallback for real.
    if (!/^https?:\/\/[^/]/.test(contract.base)) {
      stats.reason = 'cdn.base is not an absolute http(s) origin';
      return;
    }
    base = BOGUS
      ? 'https://cdn-bogus.invalid'
      : contract.base.replace(/\/+$/, '');
  } else if (contract?.ref && contract.repo) {
    ref = BOGUS ? '0000000000000000000000000000000000000000' : contract.ref;
    repo = contract.repo;
  } else {
    stats.reason = 'no cdn block in index';
    return;
  }
  stats.enabled = true;
  stats.reason = '';
  probe = null;
  consecutiveFailures = 0;
}

/**
 * The CDN URL for one asset, or null when there is no CDN to speak of. A plain
 * concatenation, because the data repo is a git tree that kept the world's own
 * paths -- no flattening, no name mangling, no second encoding to keep in sync.
 */
export function cdnAssetUrl(path: string): string | null {
  const clean = path.replace(/^\/+/, '');
  if (base) return `${base}/${clean}`;
  if (!ref || !repo) return null;
  return `${JSDELIVR}/${repo}@${ref}/${clean}`;
}

/** The origin URL: exactly what every call site built before this module. */
export function originAssetUrl(baseUrl: string, path: string, version: string): string {
  return `${baseUrl}/${path}${version}`;
}

/**
 * One GET of the probe asset, read to completion. Reading rather than a bare
 * `HEAD` is deliberate: a `HEAD` proves the object exists, and what this needs
 * to know is that the whole chain works in this browser, on this network, behind
 * whatever corporate middlebox is between them.
 *
 * It also covers a cold edge. jsDelivr fetches a ref it has never seen on first
 * request, so the very first hit after a publish can be slow or briefly 404 --
 * hence a timeout with room in it, and a failure that costs only the CDN.
 */
async function runProbe(): Promise<boolean> {
  const url = cdnAssetUrl(PROBE_PATH);
  if (!url) return false;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!resp.ok) {
      disable(`probe ${resp.status}`);
      return false;
    }
    const buf = await resp.arrayBuffer();
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
 * every later call reads a resolved promise. The first asset pays the probe;
 * nothing else does.
 */
function ensureProbe(): Promise<boolean> {
  probe ??= runProbe();
  return probe;
}

function strike(): void {
  consecutiveFailures += 1;
  if (consecutiveFailures >= STRIKES) disable(`${STRIKES} consecutive failures`);
}

/**
 * Try the CDN. Returns the bytes, or null to mean "use the origin" -- null is
 * the entire error channel, because every distinguishable failure has the same
 * remedy.
 */
async function tryCdn(path: string, init?: RequestInit): Promise<ArrayBuffer | null> {
  const url = cdnAssetUrl(path);
  if (!url) return null;
  try {
    const resp = await fetch(url, init);
    if (!resp.ok) {
      strike();
      return null;
    }
    const buf = await resp.arrayBuffer();
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
 * A source of world assets that is already in memory, consulted before the
 * network. `world/regions.ts` is the only thing that ever registers one.
 *
 * **A hook rather than an import**, and that is the whole reason this is three
 * lines in this file instead of thirty in the streamer. Every world asset in
 * the client -- tile GLBs, params, terrain grids, the six sidecars, collision --
 * already funnels through `fetchWorldAsset`, so a region cache that hangs off
 * this point serves all of them with no call site changed and no second place
 * that knows what a tile's URL looks like. Registering rather than importing
 * keeps the dependency pointing the right way: `regions.ts` needs *this* module
 * to fetch the bundles, and this module is also compiled into the Bun server
 * (see `__cdn` above), where regions do not exist and must not be dragged in.
 *
 * Returning `null` means "not in memory, go to the network", which is the
 * ordinary case for a world with no regions and for any asset a region miss
 * left behind.
 */
export type LocalAssetSource = (path: string) => Promise<ArrayBuffer | null>;

let localSource: LocalAssetSource | null = null;

/** Install the in-memory source. Pass `null` to remove it. */
export function setLocalAssetSource(source: LocalAssetSource | null): void {
  localSource = source;
}

/**
 * **The one entry point.** A world asset, from memory when a region bundle
 * already holds it, from the CDN when that is working and from the origin when
 * it is not, as a `Response` in every case so that call sites keep their
 * existing `.ok` / `.arrayBuffer()` / `.json()` handling unchanged.
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
  if (localSource !== null) {
    // Never allowed to fail the fetch. A region that 404s, a bundle with a
    // member missing, a decode that threw -- all of them mean "the network
    // still has it", which is the path the next line takes. Degrading to the
    // world loading slowly is the entire point of keeping the per-tile files
    // published beside the bundles.
    let bytes: ArrayBuffer | null = null;
    try {
      bytes = await localSource(path);
    } catch {
      bytes = null;
    }
    if (bytes !== null) {
      stats.bundled += 1;
      return new Response(bytes, { status: 200 });
    }
  }
  if (stats.enabled && (await ensureProbe()) && stats.enabled) {
    const buf = await tryCdn(path, init);
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
 * What is worth checking is the URL construction and the arming rules, because
 * those are the half of a two-repo contract this file cannot see the other side
 * of. If `publish-world.sh` and this module disagree about what a URL looks
 * like, every fetch 404s and every one of them silently falls back -- the world
 * still loads, the game still plays, and the only symptom is the bandwidth bill
 * this module exists to remove. That is precisely the failure a boot check is
 * for.
 *
 * `armCdn` is re-run at the end with whatever the caller had, so a boot check
 * never changes what the session does.
 */
export function verifyCdn(): string[] {
  const failures: string[] = [];
  const savedRef = ref;
  const savedRepo = repo;
  const savedBase = base;
  base = '';

  // --- 1. The URL, against what publish-world.sh prints and jsDelivr answers.
  ref = 'a'.repeat(40);
  repo = 'voidtype/sydrunner-world';
  const cases: [string, string][] = [
    ['tiles/-5_9.glb', `${JSDELIVR}/voidtype/sydrunner-world@${ref}/tiles/-5_9.glb`],
    ['collision/-5_9.bin', `${JSDELIVR}/voidtype/sydrunner-world@${ref}/collision/-5_9.bin`],
    ['suburbs.json', `${JSDELIVR}/voidtype/sydrunner-world@${ref}/suburbs.json`],
  ];
  for (const [path, want] of cases) {
    const got = cdnAssetUrl(path);
    if (got !== want) failures.push(`cdnAssetUrl(${path}): expected ${want}, got ${got}`);
  }

  // --- 2. A leading slash must not produce a double slash in the path.
  if (cdnAssetUrl('/tiles/1_1.glb') !== `${JSDELIVR}/${repo}@${ref}/tiles/1_1.glb`) {
    failures.push('cdnAssetUrl kept a leading slash');
  }

  // --- 3. No ref means no CDN, rather than a URL with `undefined` in it. This
  // is the pre-CDN world, which `version.ts` promises still loads.
  ref = '';
  repo = '';
  if (cdnAssetUrl('tiles/1_1.glb') !== null) failures.push('cdnAssetUrl invented a URL with no ref');

  // --- 4. The origin URL is still exactly what it was before this file
  // existed. It is the fallback, so a regression here breaks everything.
  const origin = originAssetUrl('/world', 'tiles/5_-1.glb', '?v=1785761486');
  if (origin !== '/world/tiles/5_-1.glb?v=1785761486') failures.push(`originAssetUrl: got ${origin}`);

  // --- 5. Arming rules. A half-written or absent contract must leave the CDN
  // off rather than half-on, because half-on is 3,928 failed requests.
  const enabledBefore = stats.enabled;
  for (const [label, index] of [
    ['null index', null],
    ['no cdn block', {}],
    ['ref without repo', { cdn: { ref: 'abc' } }],
    ['repo without ref', { cdn: { repo: 'voidtype/sydrunner-world' } }],
    ['empty ref', { cdn: { ref: '', repo: 'voidtype/sydrunner-world' } }],
  ] as [string, CdnIndex | null][]) {
    stats.enabled = false;
    armCdn(index);
    if (stats.enabled) failures.push(`armCdn enabled the CDN on ${label}`);
  }
  stats.enabled = enabledBefore;

  // --- 6. The R2 target. `cdn.base` is the second half of a contract whose
  // other half is a shell script, exactly as `ref`/`repo` is -- and it is the
  // half that has no ref in it, so a mistake here is not a 404 but a *wrong
  // build's* bytes under the right name. The `?v=` suffix is what stops that
  // and it is only on the origin URL, so the check below is that the R2 URL is
  // a plain concatenation and that a relative or empty base arms nothing.
  //
  // The URL cases set the module's state **directly**, exactly as cases 1 to 4
  // do and for a reason a browser found before this shipped: `armCdn` honours
  // `?nocdn` and returns before it reads the contract, so a check that armed
  // its way to a URL would fail every time a developer loaded the page with the
  // CDN pinned off. Only the *arming rules* need `armCdn`, and those are
  // skipped under `?nocdn` because there is nothing left for them to assert.
  {
    const cases: Array<[string, string, string | null]> = [
      ['https://world.3rp.uk', 'tiles/-5_9.glb', 'https://world.3rp.uk/tiles/-5_9.glb'],
      ['https://world.3rp.uk/', '/tiles/-5_9.glb', 'https://world.3rp.uk/tiles/-5_9.glb'],
      ['https://pub-abc.r2.dev', 'hexes/h-01+01.json', 'https://pub-abc.r2.dev/hexes/h-01+01.json'],
    ];
    for (const [origin, path, want] of cases) {
      ref = '';
      repo = '';
      base = origin.replace(/\/+$/, '');
      const got = cdnAssetUrl(path);
      if (got !== want) failures.push(`cdn.base ${origin} + ${path}: expected ${want}, got ${got}`);
    }

    // `base` wins over `ref`/`repo`, so a world republished to R2 does not need
    // its jsDelivr block removed first -- whichever script ran last decides.
    ref = 'a'.repeat(40);
    repo = 'voidtype/sydrunner-world';
    base = 'https://world.3rp.uk';
    if (cdnAssetUrl('far.bin') !== 'https://world.3rp.uk/far.bin') {
      failures.push('cdn.base did not take precedence over ref/repo');
    }
    base = '';

    if (!PINNED_TO_ORIGIN) {
      for (const bad of ['', '/world', 'world.3rp.uk', 'ftp://world.3rp.uk']) {
        stats.enabled = false;
        armCdn({ cdn: { base: bad } });
        if (stats.enabled) failures.push(`armCdn armed on cdn.base ${JSON.stringify(bad)}`);
      }
      stats.enabled = false;
      armCdn({ cdn: { base: 'https://world.3rp.uk' } });
      if (!stats.enabled) failures.push('armCdn refused a well-formed cdn.base');
    }
    stats.enabled = enabledBefore;
  }

  ref = savedRef;
  repo = savedRepo;
  base = savedBase;
  return failures;
}
