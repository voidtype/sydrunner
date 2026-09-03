#!/usr/bin/env bun
/**
 * Put world keys to R2, brotli-compressed, over the REST API with the wrangler
 * OAuth grant.
 *
 *     bun run scripts/world-round/r2-upload.ts <world dir> <key list> <results> [threads] [quality]
 *
 * ---------------------------------------------------------------------------
 * WHY THIS REPLACES `r2-upload.py`.
 *
 * The python uploader put the world up as the pipeline wrote it, and the
 * measurement that retired it is one line: a tile is 565 kB raw and 174 kB
 * under brotli, and Cloudflare will not compress `model/gltf-binary` or
 * `application/octet-stream` on the way out the way it does JSON. So every
 * tile a player streamed cost three times the bytes it needed to. R2 stores
 * whatever `Content-Encoding` an object was put with and serves it verbatim,
 * `fetch` decodes it transparently, and every engine that has WebGPU has
 * brotli -- so the fix is to compress **here**, once, and store the encoding
 * as object metadata. The bytes that come out of `arrayBuffer()` on the client
 * are still exactly what the pipeline wrote; `scripts/world-round/r2-upload.ts`
 * is the only place that knows they travelled smaller.
 *
 * The same put carries `Cache-Control: public, max-age=31536000, immutable`,
 * which the world's `?v=<built>` addressing licenses (`world/version.ts`): a
 * browser that has a tile keeps it across sessions, and a retile changes the
 * query string rather than the object. The two pivots (`index.json`,
 * `root.json`) are the exception and go up `no-cache` and identity, because
 * they are the thing the version is read *from*.
 *
 * Bun rather than python because the pipeline's venv has no brotli module and
 * `node:zlib` has had one for years; and because the encode is a third of the
 * wall-clock, so it runs in the same worker that does the put.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT KEEPS FROM THE PYTHON ONE, which was written after `upload-changed.sh`
 * silently lost 13,000 of 15,000 objects: every non-200 status is logged, the
 * bearer is re-read from wrangler's config on every request and refreshed
 * through `wrangler whoami` on a 401/403 (never printed, never on a command
 * line), `Retry-After` is honoured on a 429, and the results file is a journal
 * -- a key marked OK is skipped on the next run, so the same list can be
 * resumed after a kill.
 *
 * ---------------------------------------------------------------------------
 * THE REFRESH IS ASYNCHRONOUS AND CHECKED, which it was not, and the failure
 * that taught us is worth writing down: the grant expires after a few hours,
 * the first run hit that at 27,000 of 195,000 objects, and every worker then
 * spent eight retries per key failing 401 while the *refresh itself* --
 * `spawnSync`, on Bun's one thread, with its exit status never read -- froze
 * the whole process for a minute at a time. Throughput fell from 4/s to 1.3/s
 * to nothing, and it ground on like that for two hours without saying a word.
 *
 * So: `Bun.spawn` rather than `spawnSync`, so a refresh does not stop the other
 * eleven workers; the token is read before and after and the refresh is only
 * believed if it **changed**; and a grant that cannot be refreshed stops the
 * run with a message that names the one command a human has to type. The same
 * argument gives the circuit breaker below -- `MAX_CONSECUTIVE_FAILS` in a row
 * means something is wrong with the world and not with a key, and grinding
 * through 160,000 doomed objects is not resilience.
 */
import { brotliCompressSync, constants } from 'node:zlib';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CFG = `${process.env.HOME}/Library/Preferences/.wrangler/config/default.toml`;
const ACCOUNT = 'b7f27f4a44cf2aea00155a84949b3879';
const BUCKET = 'sydrunner-world';
const [WORLD, LIST, RESULTS] = process.argv.slice(2);
const THREADS = Number(process.argv[5] ?? 12);
const QUALITY = Number(process.argv[6] ?? 6);
if (!WORLD || !LIST || !RESULTS) {
  console.error('usage: r2-upload.ts <world dir> <key list> <results> [threads] [quality]');
  process.exit(2);
}

/** The pivots: identity, no-cache. Everything else is immutable under its `?v=`. */
const PIVOTS = new Set(['index.json', 'root.json']);

function readToken(): string {
  const m = readFileSync(CFG, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/);
  return m ? m[1] : '';
}

let tokenEpoch = 0;
let refreshing: Promise<void> | null = null;

/** Set when the grant is gone for good. Every worker stops; see the header. */
let dead = '';

/** Consecutive failures across all workers before the run gives up. */
const MAX_CONSECUTIVE_FAILS = 40;
let consecutiveFails = 0;

async function refresh(seen: number): Promise<void> {
  if (tokenEpoch !== seen) return;
  if (refreshing === null) {
    refreshing = (async () => {
      const before = readToken();
      const env = { ...process.env, PATH: `${process.env.HOME}/.nvm/versions/node/v22.12.0/bin:${process.env.PATH}` };
      try {
        const proc = Bun.spawn(['npx', '--yes', 'wrangler@latest', 'whoami'], { env, stdout: 'ignore', stderr: 'ignore' });
        await Promise.race([proc.exited, Bun.sleep(180_000).then(() => proc.kill())]);
      } catch {
        // Fall through to the token comparison, which is the only thing that
        // actually answers whether the grant came back.
      }
      // Believe the refresh only if the bearer moved. `whoami` exits 0 on a
      // grant it could not renew, so its status is not the answer.
      if (readToken() === before) {
        dead =
          'the R2 grant has expired and `wrangler whoami` did not renew it. ' +
          'Run `npx wrangler login` in a terminal, then start this again -- ' +
          'the results journal means it picks up where it stopped.';
      }
      tokenEpoch++;
      refreshing = null;
    })();
  }
  await refreshing;
}

function contentType(key: string): string {
  if (key.endsWith('.glb')) return 'model/gltf-binary';
  if (key.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

async function put(key: string): Promise<[string, string | number, number]> {
  const raw = readFileSync(join(WORLD, key));
  const pivot = PIVOTS.has(key);
  const body = pivot ? raw : brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: QUALITY } });
  const headers: Record<string, string> = {
    'Content-Type': contentType(key),
    'Cache-Control': pivot ? 'no-cache' : 'public, max-age=31536000, immutable',
  };
  if (!pivot) headers['Content-Encoding'] = 'br';
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/r2/buckets/${BUCKET}/objects/${encodeURIComponent(key)}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (dead) return ['FAIL', 'grant', raw.length];
    const epoch = tokenEpoch;
    let r: Response;
    try {
      r = await fetch(url, { method: 'PUT', body, headers: { ...headers, Authorization: `Bearer ${readToken()}` } });
    } catch {
      await Bun.sleep(3000 * (attempt + 1));
      continue;
    }
    if (r.status === 401 || r.status === 403) {
      await refresh(epoch);
      await Bun.sleep(1000);
      continue;
    }
    if (r.status === 429 || r.status >= 500) {
      const wait = Number(r.headers.get('retry-after'));
      await Bun.sleep(Number.isFinite(wait) && wait > 0 ? wait * 1000 : 5000 * (attempt + 1));
      continue;
    }
    let ok = false;
    try {
      ok = ((await r.json()) as { success?: boolean }).success === true;
    } catch {
      ok = false;
    }
    if (r.status === 200 && ok) return ['OK', body.length, raw.length];
    return ['FAIL', r.status, raw.length];
  }
  return ['FAIL', 'retries', raw.length];
}

const keys = readFileSync(LIST, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
const done = new Set<string>();
if (existsSync(RESULTS)) {
  for (const l of readFileSync(RESULTS, 'utf8').split('\n')) {
    const p = l.split(' ');
    if (p[0] === 'OK' && p[1]) done.add(p[1]);
  }
}
const todo = keys.filter((k) => !done.has(k));
console.log(`${keys.length} keys, ${done.size} already ok, ${todo.length} to do`);
let next = 0;
const counts = { OK: 0, FAIL: 0 };
const codes = new Map<string, number>();
let sentBytes = 0;
let rawBytes = 0;
const t0 = Date.now();
async function worker(): Promise<void> {
  for (;;) {
    const i = next++;
    if (i >= todo.length) return;
    const key = todo[i];
    if (dead) return;
    const [status, code, raw] = await put(key);
    counts[status as 'OK' | 'FAIL']++;
    if (status === 'OK') consecutiveFails = 0;
    else if (++consecutiveFails >= MAX_CONSECUTIVE_FAILS && !dead) {
      dead = `${MAX_CONSECUTIVE_FAILS} keys in a row failed (last ${code}); stopping rather than grinding through the rest.`;
    }
    if (status !== 'OK') codes.set(String(code), (codes.get(String(code)) ?? 0) + 1);
    if (status === 'OK') {
      sentBytes += code as number;
      rawBytes += raw;
    }
    appendFileSync(RESULTS, `${status} ${key} ${code}\n`);
    const n = counts.OK + counts.FAIL;
    if (n % 500 === 0) {
      const s = (Date.now() - t0) / 1000;
      console.log(
        `  ${n}/${todo.length} ok ${counts.OK} fail ${counts.FAIL} ` +
          `${(rawBytes / 1e6).toFixed(0)} MB raw -> ${(sentBytes / 1e6).toFixed(0)} MB sent, ` +
          `${(n / s).toFixed(1)}/s, fails ${JSON.stringify([...codes])}`,
      );
    }
  }
}
await Promise.all(Array.from({ length: THREADS }, () => worker()));
console.log(`done: ok ${counts.OK} fail ${counts.FAIL} raw ${(rawBytes / 1e6).toFixed(0)} MB sent ${(sentBytes / 1e6).toFixed(0)} MB in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
if (dead) console.error(`STOPPED: ${dead}`);
process.exit(counts.FAIL === 0 && !dead ? 0 : 1);
