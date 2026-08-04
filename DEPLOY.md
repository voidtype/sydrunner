# Deploying SYDNEY

Live at <https://oxford-tractor.bnr.la>. Static world from Caddy, game socket
proxied same-origin at `/ws`, TLS from Let's Encrypt on renewal autopilot.

| | |
|---|---|
| Host | `oxford-tractor.bnr.la` (103.1.187.69), Binary Lane Sydney |
| Box | Ubuntu 26.04 LTS, 1 vCPU, 1 GB RAM, 20 GB disk |
| Access | `ssh -i ~/.ssh/sydney_deploy root@oxford-tractor.bnr.la` — key only |
| Runtime | Bun 1.3.14 at `/root/.bun/bin/bun` |
| Web | Caddy 2.6.2 (Ubuntu universe), `/etc/caddy/Caddyfile` |
| Game | `sydney.service`, `127.0.0.1:8787` |

## Layout on the box

```
/opt/sydney/
  dist/            client/dist — index.html, assets/, world/   (330 MB)
  client/
    src/           the shared modules the server imports        (1.4 MB)
    package.json   + package-lock.json
    node_modules/  three@0.185.1 only                            (26 MB)
  server/          server/*.ts                                  (120 kB)
```

`client/src` is present because `server/index.ts` imports seven modules across
the directory boundary (`game/combat.ts`, `player/controller.ts`,
`net/protocol.ts` and friends). The layout is repo-faithful so those relative
imports resolve unchanged, and `three` is installed in `client/` — not
`server/` — because [the README's own rule](README.md) is that no file under
`server/` may resolve its own copy of three.

## Two decisions worth knowing

**The world path is an environment variable, not a symlink.** `server/index.ts`
reads

```ts
const WORLD_ROOT = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
```

The fallback is relative to `import.meta.url`, so on this box it would resolve
to `/opt/sydney/client/public/world` — which does not exist, because the world
ships inside `dist/world/` where Caddy can also serve it to browsers. Rather
than duplicating 330 MB or symlinking `client/public/world`, the unit sets
`Environment=SYDNEY_WORLD=/opt/sydney/dist/world`. One line, one copy of the
world, and the server reads exactly the bytes the browser downloads.

**No code change was needed for `/ws`.** `index.ts`'s `fetch` handler
special-cases `/health` and passes *everything else* to `srv.upgrade(req)`, so
it upgrades on any path. Caddy's `handle /ws { reverse_proxy 127.0.0.1:8787 }`
satisfies `main.ts`'s production contract —

```ts
if (location.protocol === 'https:') return `wss://${location.host}/ws`;
```

— with no rewrite, and `ws://localhost:8787` still works directly in dev.

## Redeploy

From the repo root on the Mac, after `npm run build` **and the precompress step**:

```bash
scripts/precompress-dist.sh   # writes .zst/.br sidecars beside every asset
```

The full runbook is **build → precompress → rsync → restart**, plus
`scripts/publish-world-release.sh` whenever the pipeline has rebuilt the world.
That last step is currently independent of the deploy — the client does not read
from the releases yet, for the reason in [The world as a GitHub
release](#the-world-as-a-github-release).

Caddy's `file_server { precompressed zstd br }` (in the site block since
2026-08-04) serves those sidecars to any client that accepts them — tile GLBs
compress ~4.5x, so this took ~650 MB of first-visit streaming to ~200 MB and
cut origin egress by the same factor. The sidecars ride the same rsync as
everything else; `vite build` clears dist, so a full build implies a full
re-compress (~2 min on the Mac). Verify after a deploy:

```bash
curl -sI -H 'Accept-Encoding: zstd' 'https://oxford-tractor.bnr.la/world/landmarks.glb?v=1' | grep -i content-encoding
```

```bash
SSHOPT="ssh -i ~/.ssh/sydney_deploy -o BatchMode=yes -o ServerAliveInterval=30"

# The world + client bundle. ~113 MB on the wire (-z gets ~3x), about 20 s.
rsync -az --partial --stats -e "$SSHOPT" \
  client/dist/ root@oxford-tractor.bnr.la:/opt/sydney/dist/

# The shared simulation modules, and the server itself.
rsync -az --partial -e "$SSHOPT" \
  client/src/ root@oxford-tractor.bnr.la:/opt/sydney/client/src/
rsync -az --partial -e "$SSHOPT" \
  client/package.json client/package-lock.json root@oxford-tractor.bnr.la:/opt/sydney/client/
rsync -az --partial --exclude node_modules -e "$SSHOPT" \
  server/ root@oxford-tractor.bnr.la:/opt/sydney/server/

ssh -i ~/.ssh/sydney_deploy root@oxford-tractor.bnr.la \
  'chown -R root:root /opt/sydney && systemctl restart sydney'
```

Add `--delete` to the `dist/` line when a pipeline rebuild has removed tiles;
without it, stale tiles linger but are never referenced by `world/index.json`.

Two notes on rsync. macOS ships **openrsync**, which does not support
`--info=progress2` — use `--stats` (and `--progress` if you want per-file
output). And `-a` preserves the Mac's uid/gid onto the box, hence the `chown`;
Caddy reads as the `caddy` user and only needs the 755/644 the files already
carry, so this is tidiness rather than a fix.

If `client/package.json` changed, refresh the one dependency:

```bash
ssh -i ~/.ssh/sydney_deploy root@oxford-tractor.bnr.la \
  'cd /opt/sydney/client && /root/.bun/bin/bun install --production'
```

## Caching the world

A first visit pulls about 350 MB of city as the player walks, and until this
change every one of those requests came back with no `Cache-Control` at all —
so a second visit re-downloaded the lot. The fix is a long cache with the build
version in the URL, and it is two parts: a stamp the pipeline writes, and a
header Caddy sends.

**The stamp.** `tiles.write_index` now puts `"built": <epoch seconds>` in
`world/index.json` on every run, and the client appends it to every world asset
it fetches as `?v=<built>` — tiles, params, terrain, collision, the sidecars,
the far layer and `suburbs.json`. `index.json` itself carries no parameter,
because it is what names the version. See `client/src/world/version.ts` for the
full argument; the short form is that tiles are **not** content-addressed —
`5_-1.glb` is a grid coordinate — so `immutable` on the path alone would leave
anyone who visited before a retile stuck on a mixture of two builds for a year.

**The header.** `caddy/world-cache.Caddyfile` in this repo is the snippet.
Install it and add one `import` line to the site block:

```bash
scp -i ~/.ssh/sydney_deploy caddy/world-cache.Caddyfile \
  root@oxford-tractor.bnr.la:/etc/caddy/world-cache.Caddyfile
```

The site block then reads as below. This is the shape the rest of this document
implies rather than a copy of the file on the box, so **read
`/etc/caddy/Caddyfile` before editing it** — the only change that matters is the
one marked line:

```caddyfile
oxford-tractor.bnr.la {
	root * /opt/sydney/dist
	encode zstd gzip

	import /etc/caddy/world-cache.Caddyfile    # <- the only new line

	handle /ws {
		reverse_proxy 127.0.0.1:8787
	}

	handle {
		try_files {path} /index.html
		file_server
	}
}
```

If the site block on the box differs from the above, keep what is there and add
only the `import`: the snippet is self-contained and touches nothing but
response headers.

```bash
ssh -i ~/.ssh/sydney_deploy root@oxford-tractor.bnr.la \
  'caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy'
```

Verify — the first must be `immutable`, the second must not be:

```bash
curl -sI 'https://oxford-tractor.bnr.la/world/tiles/5_-1.glb?v=1' | grep -i cache-control
curl -sI  https://oxford-tractor.bnr.la/world/index.json          | grep -i cache-control
```

**Order of operations matters exactly once.** Ship a `dist/` whose
`world/index.json` has a `built` stamp *before* reloading Caddy with the long
cache. A stamped world under a short cache is merely the old behaviour; an
unstamped world under `immutable` is the seam this whole scheme exists to
prevent. Since the world and the header are shipped by two different commands,
the safe order is: rsync `dist/`, then reload Caddy.

## The world as a GitHub release

**Status: published, and not yet used by the client.** Read the blocker below
before wiring anything to it.

The box has a **20 GB/month transfer cap** and a first visit streams ~200 MB of
precompressed city, so the site is roughly a hundred first visits from being
shaped or billed — it breaks by being played. The world is 3,928 immutable
files that are identical for every player and already versioned by `?v=<built>`,
which makes it a static-asset problem, so it was published to GitHub releases:

```bash
scripts/publish-world-release.sh            # --dry-run to compress and stop
```

That gzips every file under `client/public/world` (originals kept), flattens the
path — `tiles/-5_9.glb` becomes `tiles__-5_9.glb.gz`, since release assets have
no folders — and uploads to `world-<built>-s0` .. `world-<built>-s7`. Two limits
shaped that:

- **1000 assets per release.** GitHub refuses the 1001st (`file_count limited to
  1000 assets per release`), so the world is sharded eight ways by
  `FNV-1a(name) mod 8` — 485–496 files each. The client computes the same hash
  in `client/src/world/cdn.ts` and needs no manifest.
- **API rate limits.** ~3,900 uploads in a row trips the secondary limit and the
  run stops partway. Re-runs are safe and resume (`--clobber`), but a full
  publish needs to be spread out or retried.

`index.json` is uploaded for completeness but the client **always** reads it from
the origin: it is the mutable pivot that names the version everything else is
cached under (`client/src/world/version.ts`).

### The blocker: no CORS on release assets

**A browser cannot fetch a GitHub release asset cross-origin.** A download
redirects from `github.com` to `release-assets.githubusercontent.com`, an Azure
Blob backend whose 200 carries `content-disposition: attachment` and **no
`access-control-allow-origin` header at all**. Measured 2026-08-04:

```bash
curl -sL -o /dev/null -D - -H 'Origin: https://oxford-tractor.bnr.la' \
  'https://github.com/voidtype/sydrunner/releases/download/world-1785761486-s0/collision__-11_-4.bin.gz' \
  | grep -i access-control    # -> nothing
```

In a browser: `fetch(asset)` throws `TypeError: Failed to fetch`; the same fetch
with `{mode:'no-cors'}` returns an **opaque** response (so the request reaches
the server — this is CORS, not the network); and a control fetch of
`raw.githubusercontent.com` from the same page returns 200. An opaque response
cannot be read, so no client code recovers it. This is GitHub infrastructure and
is not configurable from a repo.

So `client/src/world/cdn.ts` ships with `CDN_ENABLED` false and every asset takes
the origin path. The layer itself is complete and verified — sharding, a one-time
boot probe, gzip inflate via `DecompressionStream`, per-file fallback, and a
five-strike session cutout — and `?cdn` turns it on to watch it degrade:

```
http://localhost:5173/?offline&cdn
> __cdn()
{ hits: 0, fallbacks: 0, origin: 17, enabled: false, reason: 'probe failed' }
```

One request to GitHub (the probe), which fails, disables the CDN for the session,
and every asset then goes straight to the origin with no per-file retry. The
world loads normally and the player sees nothing.

**If you want this to actually cut egress**, the options are: a host that sends
CORS (Cloudflare R2, Backblaze B2 + Cloudflare, jsDelivr); or
`raw.githubusercontent.com`, which *does* send `access-control-allow-origin: *`
but serves out of the git tree — that means ~195 MB of world binaries in git
history, permanently and for every rebuild, which is exactly what `.gitignore`
and this scheme were built to avoid. Flipping `CDN_ENABLED` and changing
`RELEASE_BASE` is the whole client-side change either way.

## Rollback

```bash
systemctl stop sydney       # game server down; the city still serves, client
                            # falls back to its local stub with three dummies
systemctl start sydney      # back up in ~1 s (world loads in 190 ms)
systemctl disable sydney    # and stop it coming back after a reboot
```

Caddy is independent: `systemctl reload caddy` after a `Caddyfile` edit,
`caddy validate --config /etc/caddy/Caddyfile` first. Stopping Caddy takes the
site down but leaves the game server reachable on `localhost:8787`.

## Verify

```bash
curl -sI https://oxford-tractor.bnr.la/                  # 200, HTTP/2
curl -s  https://oxford-tractor.bnr.la/health            # {"ok":true,...}
curl -sI https://oxford-tractor.bnr.la/world/index.json  # 200
ssh -i ~/.ssh/sydney_deploy root@oxford-tractor.bnr.la 'journalctl -u sydney -n 20 --no-pager'
```

For a full gameplay check without a browser, run the repo's own integration
check **on the box**. It spawns its own server on port 8799 and drives two
synthetic clients against it — so it exercises the deployed source and the
deployed world, though not Caddy or TLS (it is loopback-only by construction;
`SERVER_URL` is hard-coded to `ws://127.0.0.1:$SYDNEY_CHECK_PORT`). Note that
`SYDNEY_WORLD` has to be passed, exactly as the unit passes it:

```bash
ssh -i ~/.ssh/sydney_deploy root@oxford-tractor.bnr.la \
  'cd /opt/sydney/server && SYDNEY_WORLD=/opt/sydney/dist/world /root/.bun/bin/bun run integration-check.ts'
```

That covers everything except the public edge. To prove the `wss://` path
itself — TLS, Caddy's `/ws` upgrade, and a real join — the quickest check is a
browser: open <https://oxford-tractor.bnr.la> in two tabs and confirm the debug
overlay's `net` line (`Tab`) shows both players plus the two bots. Failing
that, a throwaway Bun script importing `encodeHello`/`decodeWelcome`/
`decodeSnapshot` from `client/src/net/protocol.ts` and opening a `WebSocket` to
`wss://oxford-tractor.bnr.la/ws` reproduces it in about sixty lines; assert
welcome, ≥20 snapshots, a rising `ackSeq`, and a close code of 1000.

## Operational notes

- **Memory.** `MemoryMax=600M` on a 1 GB box, leaving room for Caddy and the
  OS. Measured steady state is 81 MB with a 134 MB peak, so the cap is ~4.5x
  headroom and exists to make a leak restart the service rather than the box.
- **Restart policy** is `on-failure` with `RestartSec=2`. A clean exit is
  treated as intentional.
- **Ports.** 80 and 443 only, plus the pre-existing 22. `ufw` is inactive on
  this box and was left that way; 8787 binds `0.0.0.0` in the server but is
  only ever reached through Caddy on loopback.
- **TLS renewal** is automatic. The cert was issued via `tls-alpn-01`, which
  needs 443 reachable — so do not put anything in front of Caddy on 443.
  The `no OCSP server specified` warning in the log is expected: Let's Encrypt
  no longer publishes OCSP URLs.
- **Transport.** Still a WebSocket, not spec 10's WebTransport. The certificate
  that blocked the swap now exists — see the README's transport note for the
  seam (`NetTransport` in `net/protocol.ts`).
