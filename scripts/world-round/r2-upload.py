#!/usr/bin/env python3
"""Put a list of world keys to R2 over the REST API with the wrangler OAuth grant.

Why not upload-changed.sh: it records OK/FAIL and nothing else, and on
2026-09-03 two runs of it failed 13,000 of 15,000 objects with no status to
read. This logs every non-200 status, refreshes the token through `wrangler
whoami` on a 401/403 (wrangler rewrites its config with a fresh access token),
honours Retry-After on a 429, and re-reads the bearer from the config file
each time it is needed -- never printing it, never putting it on a command
line. Objects go up with the cache-control the world's `?v=` addressing wants.
"""
import json, os, subprocess, sys, threading, time, urllib.parse, urllib.request, urllib.error, tomllib
from pathlib import Path
CFG = Path.home() / 'Library/Preferences/.wrangler/config/default.toml'
ACCOUNT = 'b7f27f4a44cf2aea00155a84949b3879'
BUCKET = 'sydrunner-world'
WORLD = Path(sys.argv[1]); LIST = Path(sys.argv[2]); RESULTS = Path(sys.argv[3]); THREADS = int(sys.argv[4]) if len(sys.argv) > 4 else 8
lock = threading.Lock(); refreshing = threading.Lock(); token_epoch = 0
def read_token():
    return tomllib.loads(CFG.read_text())['oauth_token']
def refresh(seen_epoch):
    global token_epoch
    with refreshing:
        if token_epoch != seen_epoch: return token_epoch
        env = dict(os.environ); env['PATH'] = os.path.expanduser('~/.nvm/versions/node/v22.12.0/bin') + ':' + env['PATH']
        subprocess.run(['npx', '--yes', 'wrangler@latest', 'whoami'], capture_output=True, env=env, timeout=120)
        token_epoch += 1
        return token_epoch
def put(key):
    global token_epoch
    path = WORLD / key
    data = path.read_bytes()
    ct = 'model/gltf-binary' if key.endswith('.glb') else 'application/json' if key.endswith('.json') else 'application/octet-stream'
    cc = 'no-cache' if key in ('index.json', 'root.json') else 'public, max-age=31536000, immutable'
    url = f'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/r2/buckets/{BUCKET}/objects/{urllib.parse.quote(key, safe="")}'
    for attempt in range(8):
        epoch = token_epoch
        req = urllib.request.Request(url, data=data, method='PUT', headers={'Authorization': 'Bearer ' + read_token(), 'Content-Type': ct, 'Cache-Control': cc})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                body = json.loads(r.read().decode())
                if body.get('success'): return 'OK', 200
                return 'FAIL', 'body'
        except urllib.error.HTTPError as e:
            code = e.code
            if code in (401, 403): refresh(epoch); time.sleep(1); continue
            if code == 429 or code >= 500:
                wait = e.headers.get('Retry-After'); time.sleep(float(wait) if wait else 5 * (attempt + 1)); continue
            return 'FAIL', code
        except Exception as ex:
            time.sleep(3 * (attempt + 1)); last = repr(ex)[:60]
    return 'FAIL', 'retries'
keys = [l.strip() for l in LIST.read_text().splitlines() if l.strip()]
done = {}
if RESULTS.exists():
    for l in RESULTS.read_text().splitlines():
        p = l.split(' ', 2)
        if len(p) >= 2 and p[0] == 'OK': done[p[1]] = True
todo = [k for k in keys if k not in done]
print(f'{len(keys)} keys, {len(done)} already ok, {len(todo)} to do', flush=True)
it = iter(todo); counts = {'OK': 0, 'FAIL': 0}; codes = {}
out = open(RESULTS, 'a')
def worker():
    while True:
        with lock:
            try: key = next(it)
            except StopIteration: return
        status, code = put(key)
        with lock:
            counts[status] += 1; codes[str(code)] = codes.get(str(code), 0) + 1
            out.write(f'{status} {key} {code}\n'); out.flush()
            n = counts['OK'] + counts['FAIL']
            if n % 500 == 0: print(f'  {n}/{len(todo)} ok {counts["OK"]} fail {counts["FAIL"]} codes {codes}', flush=True)
ts = [threading.Thread(target=worker) for _ in range(THREADS)]
for t in ts: t.start()
for t in ts: t.join()
print(f'done: ok {counts["OK"]} fail {counts["FAIL"]} codes {codes}', flush=True)
sys.exit(0 if counts['FAIL'] == 0 else 1)
