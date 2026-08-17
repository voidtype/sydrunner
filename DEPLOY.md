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
  dist/            client/dist — index.html, assets/, cars/, and the world
                   files the SERVER reads (no .glb; players use R2)  (488 MB)
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

> ### One-off before the next deploy: proxy `/auth/*`
>
> The accounts pass (workstream G) puts four HTTP routes on the game server —
> `POST /auth/signup`, `POST /auth/login`, `POST /auth/logout` and
> `GET /auth/check?handle=`, plus `GET /auth/me` — and Caddy does not forward
> them today. It proxies `/ws` (and `/ws/<n>` via `rooms.Caddyfile`) and nothing
> else, so **without this line every one of those requests is answered by the
> static file server with a 404, the landing page's live handle check silently
> fails, and every handle reads as available until the join is refused with a
> `BYE`.** That is the worst shape of failure this feature has: the game works,
> the page looks right, and accounts quietly do not exist.
>
> Add to the site block in `/etc/caddy/Caddyfile`, beside the `handle /ws`
> block (or beside the `import /etc/caddy/rooms.Caddyfile` line that replaced
> it):
>
> ```caddyfile
> handle /auth/* {
> 	reverse_proxy 127.0.0.1:8787
> }
> ```
>
> Same port as `/ws` because it is the same process — there is one account store
> per host and it is the one the socket authenticates against. Then, as with
> every Caddy change on this box:
>
> ```bash
> ssh -i ~/.ssh/sydney_deploy root@oxford-tractor.bnr.la \
>   'caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy'
> ```
>
> Verify from the Mac — a JSON body rather than the app's HTML is the whole test:
>
> ```bash
> curl -s 'https://oxford-tractor.bnr.la/auth/check?handle=bazza'
> # {"available":true,"reason":"","handle":"bazza"}
> ```
>
> Or run the whole feature against the box, which takes about a second and
> covers the routes, the socket join, the handle refusal and the feedback gate:
>
> ```bash
> SYDNEY_CHECK_URL=https://oxford-tractor.bnr.la bun run server/accounts-check.ts
> ```
>
> It registers one throwaway handle per run (`Chk#####`) and leaves it behind;
> that is deliberate, so a second run proves the *first* run's account persisted.
>
> **`accounts.json` lives beside `wallets.json`** in `SYDNEY_STATE_DIR`
> (`/opt/sydney/state` on the box) and is written atomically on the same
> pattern. It is the only file on the box that must not be lost: it holds every
> registered handle. It contains argon2id password hashes and no email
> addresses, so it is not personal data — but it is credentials, and it must not
> be committed, rsynced into `dist/`, or copied anywhere public.

After that one-off, the site block carries a `handle /auth/* { reverse_proxy
127.0.0.1:8787 }` block for the accounts routes, beside `/ws`, `/rooms` and
`/health`.

From the repo root on the Mac, after `npm run build` **and the precompress step**:

```bash
scripts/precompress-dist.sh   # writes .zst/.br sidecars beside every asset
```

The client build must be done with `client/public/world` absent — in a worktree,
remove the symlink — or `vite build` copies the 12 GB world into `dist/`. The
world is deliberately excluded from the rsync anyway (see *What the box actually
needs*), so a build that pulls it in only bloats a tree that is never shipped.

The full runbook is **build → precompress → rsync → restart**. When the pipeline
has rebuilt the world, `scripts/publish-world.sh` goes **first** — it stamps the
new CDN ref into `client/public/world/index.json`, and that stamp has to be in
the tree before `vite build` copies `public/` into `dist/`:

```
publish-world.sh  →  npm run build  →  precompress-dist.sh  →  rsync  →  restart
```

Publishing an unchanged world is a no-op worth skipping, but never harmful: the
ref only moves when the bytes do. See [The world is a jsDelivr
CDN](#the-world-is-a-jsdelivr-cdn).

Caddy's `file_server { precompressed zstd br }` (in the site block since
2026-08-04) serves those sidecars to any client that accepts them — tile GLBs
compress ~4.5x, so this took ~650 MB of first-visit streaming to ~200 MB and
cut origin egress by the same factor. The sidecars ride the same rsync as
everything else; `vite build` clears dist, so a full build implies a full
re-compress (~2 min on the Mac). Verify after a deploy:

```bash
curl -sI -H 'Accept-Encoding: zstd' 'https://oxford-tractor.bnr.la/world/landmarks.glb?v=1' | grep -i content-encoding
```

> **Since the 60 km world, `dist/` no longer fits on the box and must never be
> rsynced whole.** It is 20 GB against a 20 GB disk. The command that used to be
> here would fill the filesystem. See *What the box actually needs* below.

```bash
SSHOPT="ssh -i ~/.ssh/sydney_deploy -o BatchMode=yes -o ServerAliveInterval=30"
BOX=root@oxford-tractor.bnr.la

# 1. The app bundle -- everything in dist EXCEPT the world. A few tens of MB.
rsync -a --partial --delete --exclude 'world/' -e "$SSHOPT" client/dist/ $BOX:/opt/sydney/dist/

# 2. The world files the SERVER reads. It never opens a .glb: players get
#    geometry from R2. Collision, the hex manifests, the pivots and the far
#    layer, then the per-tile sidecars by pattern -- the include/exclude order
#    matters, `*/` first or rsync never descends.
rsync -a --partial --delete -e "$SSHOPT" client/dist/world/collision/ $BOX:/opt/sydney/dist/world/collision/
rsync -a --partial --delete -e "$SSHOPT" client/dist/world/hexes/      $BOX:/opt/sydney/dist/world/hexes/
rsync -a --partial -e "$SSHOPT" \
  client/dist/world/index.json client/dist/world/index.json.zst client/dist/world/index.json.br \
  client/dist/world/root.json  client/dist/world/root.json.zst  client/dist/world/root.json.br \
  client/dist/world/suburbs.json client/dist/world/far.bin client/dist/world/far-terrain.bin \
  client/dist/world/far-water.bin client/dist/world/street-names.bin client/dist/world/landmarks.glb \
  $BOX:/opt/sydney/dist/world/
rsync -a --partial -e "$SSHOPT" \
  --include='*/' --include='*.lanes.bin' --include='*.terr.bin' --include='*.pow.bin' --exclude='*' \
  client/dist/world/tiles/ $BOX:/opt/sydney/dist/world/tiles/

# 3. The shared simulation modules, and the server itself. NOT OPTIONAL when the
#    world's radius changes: the box booting last release's whole-world lane
#    loader against a 60 km world wants ~850 MB and stalls against MemoryMax.
rsync -az --partial --delete -e "$SSHOPT" client/src/ $BOX:/opt/sydney/client/src/
rsync -az --partial --delete --exclude node_modules -e "$SSHOPT" server/ $BOX:/opt/sydney/server/

ssh -i ~/.ssh/sydney_deploy $BOX 'chown -R root:root /opt/sydney && systemctl restart sydney'
```

Note `$SSHOPT` is only ever passed to `rsync -e`, which splits it itself. A bare
`$SSHOPT root@host …` does **not** word-split under zsh and fails with `no such
file or directory` — it bit twice during the 60 km ship.

The SSH host key is only known as `oxford-tractor.bnr.la`, so rsync and ssh go to
that name; `sydrunner.3rp.uk` is the site, not the box, and the box does not
answer to it.

### What the box actually needs

| | size | who reads it |
|---|---|---|
| `tiles/*.glb`, `regions/` | **11 GB** | the browser, **from R2 only** |
| `collision/` | 333 MB | the server |
| `tiles/*.{lanes,terr,pow}.bin` | 155 MB | the server |
| `hexes/`, pivots, far layer | ~70 MB | both |

488 MB on the box against 12 GB of world. **The consequence is that the CDN is
now load-bearing rather than an optimisation**: if `world.3rp.uk` were down the
page would load and the server would simulate, but no geometry would stream and
the origin has none to fall back on. That is a deliberate trade — a 20 GB disk
cannot hold a 20 GB `dist` and leave room to write one.

After a pipeline rebuild, delete the box's stale `tiles/` and `regions/` **before**
copying, or the old build's files linger and the disk fills:

```bash
ssh -i ~/.ssh/sydney_deploy $BOX 'rm -rf /opt/sydney/dist/world/tiles /opt/sydney/dist/world/regions'
```

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

The systemd drop-in `/etc/systemd/system/sydney.service.d/state.conf` sets
`Environment=SYDNEY_STATE_DIR=/var/lib/sydney`, which holds `wallets.json` and
`accounts.json`. It must survive a redeploy: the rsync targets `/opt/sydney`, so
the state dir sits outside it, and a `--delete` that ever reached it would erase
every registered handle — never rsync over it.

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

## The world is a jsDelivr CDN

**Status: live in the client, off in production until the next deploy.**

> **There is now a second target: Cloudflare R2.** `scripts/publish-world-r2.sh`
> uploads the same tree to the `sydrunner-world` bucket, served publicly from
> **`https://world.3rp.uk`**, and stamps `"cdn": { "base": "https://world.3rp.uk" }`
> into both pivots. It is a *second* target rather than a replacement: this
> script still works, and whichever of the two ran last is where players go.
> R2 is where the world has to end up — the data repo is at 4.1 GB against
> GitHub's 5 GB ceiling and `EXPANSION.md` measures the 60 km world at ~20 GB —
> and its decisive property is **zero egress fees**. It also takes `--hex
> h-01+01` to republish one hexagonal segment on its own; see
> [Hexagonal segments](#hexagonal-segments) and `pipeline/sydney/hexes.py`.
>
> Credentials come from `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` in
> `/etc/sydney/secrets.env`, never from the script. It prefers **rclone**
> (`brew install rclone`) and falls back to the `aws` CLI. It never uses
> `wrangler r2 object`, which defaults to a *local simulated bucket* and reports
> success having sent nothing — the `--remote` flag is the fix if you ever do,
> and `wrangler r2 bucket info`'s object count lags a real upload, so the
> script's success check is a `GET` of the public URL.

## Hexagonal segments

The world is cut into **6 km hexagons** by `uv run python -m sydney hex-pack` —
a repack of the emitted world, no retile, about a second — which writes
`world/root.json` and `world/hexes/<id>.{json,names.bin,far.bin}`.
`scripts/expand-world.sh` runs it on every build.

`root.json` is the new boot pivot: **8.4 kB against `index.json`'s 851 kB**,
carrying everything except the tile list and the region list, which arrive one
hexagon at a time as the player approaches (`client/src/world/hexes.ts`).
`index.json` is unchanged, still published, still what `server/world.ts` reads
off the disk and what a client from before this pass boots from.

**Both are cache pivots** and both are excluded from the immutable rule in
`caddy/world-cache.Caddyfile`. Everything under `world/hexes/` is an ordinary
versioned asset.

The box has a **20 GB/month transfer cap** and a first visit streams ~175 MB of
city, so the site is roughly a hundred first visits from being shaped or billed —
it breaks by being played. The world is 3,928 immutable files, identical for
every player, so it is a static-asset problem and it now lives somewhere else:

```bash
scripts/publish-world.sh            # --dry-run to see what it would do
```

That pushes `client/public/world` to the data repo
**[voidtype/sydrunner-world](https://github.com/voidtype/sydrunner-world)** and
prints a commit SHA. Players fetch from
`https://cdn.jsdelivr.net/gh/voidtype/sydrunner-world@<sha>/<path>`.

Four things about that are deliberate.

**It is a separate repo, holding exactly one commit.** The branch is rebuilt from
scratch each publish (a fresh `git init`, so "one commit" is true by construction
rather than by discipline) and force-pushed. A world rebuild would otherwise add
~600 MB to a repo's history *forever*. Old builds survive as tags and the script
prunes all but the newest two — a client holding an older index lives for one
session, and two builds is ~400 MB of repo.

**The ref is a commit SHA, not a tag.** jsDelivr treats `@<sha>` as immutable and
caches it forever; a tag is a moving target it has to revalidate.

**The files are NOT gzipped**, which is the one counter-intuitive part. jsDelivr
brotli-compresses on the fly and beats a pre-gzipped copy, because a `.gz` can
only be served as opaque bytes where a raw file gets content negotiation.
Measured on a real tile:

```
tiles/-10_-1.glb    raw 1,921,940    br 540,716    .gz 597,683
```

GLB is 97% of the world by bytes, so storing raw saves ~17 MB of a ~192 MB first
visit (9%). It also deletes a whole layer of client code — no
`DecompressionStream`, no feature detection, no engine that cannot inflate —
because `Content-Encoding` is the browser's job and is transparent to `fetch`.

**The client is told the ref by the origin's `index.json`**, which the publish
script stamps after pushing:

```json
"cdn": { "ref": "<sha>", "repo": "voidtype/sydrunner-world" }
```

No pipeline change and no client rebuild: `index.json` is the one world file that
is deliberately never cached (see `client/src/world/version.ts`), which makes it
exactly the right place to put a pointer at immutable data. It cannot be stamped
into the *published* copy, because the ref is the hash of the commit that would
contain it. `vite build` copies `public/` into `dist/`, so stamping `public/` is
enough for any future build; `dist/` is stamped too when it exists, so an
already-built tree does not need rebuilding before the next rsync.

#### Deploy the sidecars with the pivot, always

Caddy serves `precompressed zstd br`, so a browser advertising `accept-encoding:
zstd` — every current Chromium and Firefox — is answered from `root.json.zst`
and **never reads `root.json` at all**. Stamping rewrites the plain file, so the
sidecars must be regenerated and shipped in the same breath:

```bash
rsync -a client/dist/world/index.json client/dist/world/index.json.zst client/dist/world/index.json.br \
         client/dist/world/root.json  client/dist/world/root.json.zst  client/dist/world/root.json.br \
         root@oxford-tractor.bnr.la:/opt/sydney/dist/world/
```

Both publish scripts now recompress on stamp (`scripts/lib-sidecars.sh`), and
`checkPivotSidecars` in the suite fails if a sidecar's cdn block ever drifts from
its source. Both exist because this shipped once: `curl` was told the world lived
on R2 while every real browser was told jsDelivr, off the same URL with different
etags, because only the plain file had been copied. jsDelivr has no hexagon
manifests at all, so players fell back to the entire 851 kB `index.json` and
nothing looked broken.

Verify by encoding, not just by `curl` — plain `curl` does not ask for zstd and
so reads the one copy that is guaranteed to be fresh:

```bash
for enc in identity zstd br; do
  printf '%-9s ' "$enc"
  curl -s -H "Accept-Encoding: $enc" https://oxford-tractor.bnr.la/world/root.json |
    case $enc in identity) cat ;; zstd) zstd -dc ;; br) brotli -dc ;; esac |
    jq -c .cdn
done
```

### Why not GitHub releases

The first version of this shipped to releases and had to be abandoned:
**release assets carry no CORS header.** A download redirects to
`release-assets.githubusercontent.com`, whose 200 has no
`access-control-allow-origin` at all, so a browser `fetch` throws and
`{mode:'no-cors'}` returns an unreadable opaque response. Releases are also
capped at **1000 assets** (this world is 3,928) and rate-limit hard on bulk
upload. jsDelivr answers all three: CORS `*`, no asset cap, and `git push` is not
subject to the REST API rate limit.

### Verifying a publish

```bash
SHA=$(jq -r .cdn.ref client/public/world/index.json)
curl -sIL -H 'Origin: https://oxford-tractor.bnr.la' \
  "https://cdn.jsdelivr.net/gh/voidtype/sydrunner-world@$SHA/tiles/-10_-1.glb" |
  grep -iE 'HTTP/|access-control-allow-origin|cache-control|content-encoding'
```

Expect `200`, `access-control-allow-origin: *`, `cache-control: public,
max-age=31536000, s-maxage=31536000, immutable`, and `content-encoding: br`.
Measured 2026-08-04, a fresh SHA resolved within seconds of the push with no
warm-up wait; a cold edge can still make the *first* hit slow, which is what the
client's probe timeout is sized for.

In the browser, `__cdn()` in the console is the truth at any moment. A healthy
boot reads:

```
{ hits: 17, fallbacks: 0, origin: 0, enabled: true, reason: '' }
```

`origin: 0` is the whole point — the only world request left on the box is
`index.json`. Fallback semantics, all of which land back on the origin's
untouched `?v=<built>` path: no `cdn` block, or a failed one-time boot probe,
disables the CDN for the session; a single asset failing falls back alone; five
consecutive failures disable it. `?nocdn` pins to the origin and `?cdnbogus`
points the ref at a SHA that cannot exist — that costs exactly one probe request
and then serves the entire world from the origin, which is what a jsDelivr
outage would look like.

## Rooms, and scaling past one process

PERFORMANCE.md phase 3. The server is now a **host of R rooms** rather than one
game. Nothing about the current box changes — the default is one room and
`systemctl restart sydney` after a redeploy is still the whole operation — but
the knobs are here and the multi-process shape is config, not code.

### The environment variables

| Variable | Default | What it does |
|---|---|---|
| `SYDNEY_ROOMS` | `1` | How many rooms this process runs |
| `SYDNEY_ROOM_CAP` | `128` | Players per room. `SYDNEY_MAX_PLAYERS` is an accepted alias |
| `SYDNEY_ROOM_BASE` | `0` | The id of this host's first room; rooms are `BASE .. BASE+ROOMS-1` |
| `SYDNEY_BOTS` | `2` | Bots **per room**, so 8 rooms at the default is 16 |
| `SYDNEY_COLLISION_CAP_MB` | `450` | Collision prisms held, in **estimated resident megabytes**. The 1 GB box wants 150–250 |
| `SYDNEY_LANES_CAP_MB` | `300` | The lane graph — cars and footpaths — on the same terms. The 1 GB box wants 100–150 |

**The two caps are counted in estimated resident bytes, not file bytes**, and
that is what makes them real controls: the 19.3 km world is 25.4 MB of collision
files against 193 MB of heap, and 13.9 MB of lane files against 132 MB. A cap in
file bytes would never bind at any radius this project will build. Both are held
**per hexagon and near a player** — a hexagon is loaded when anybody is inside it
or within 500 m (collision) or 2,000 m (lanes) of its boundary, and evicted
least-recently-needed when over cap.

**Neither cap will evict a hexagon somebody is standing in.** It goes over
budget and logs a warning instead, once every ten seconds. `[sydney] collision
over cap` or `[sydney] lanes over cap` in the journal means this many players are
this far apart, not that anything is broken; it is a capacity signal. Raise the
cap or accept the spread.

They are separate rather than one number because the failure modes are: missing
prisms is a player briefly walking through a wall, and missing lanes is a street
with no traffic on it. `/stats` reports both layers separately.

**One room is the default on purpose.** A default of eight would mean two
browsers opened on one desk landing in different cities, which is the exact
failure the gateway's least-full rule exists to prevent, caused by the gateway
itself. Turn rooms on when there are enough players to fill more than one.

The current 1 GB box should stay at `SYDNEY_ROOMS=1`: a room's fixed floor is
about 0.35 ms of tick regardless of occupancy (the powerup sweep, the faction
scan and the bike sweep all run whether or not anybody is in there), so eight
empty rooms cost 2.8 ms a tick to serve nobody. Rooms are worth their floor
once they hold players.

### Adding rooms to the existing unit

```bash
ssh -i ~/.ssh/sydney_deploy root@oxford-tractor.bnr.la \
  'systemctl edit sydney'      # drop-in, so the packaged unit stays clean
```

```ini
[Service]
Environment=SYDNEY_ROOMS=4
Environment=SYDNEY_ROOM_CAP=128
```

`systemctl daemon-reload && systemctl restart sydney`, then
`curl -s localhost:8787/rooms` — four objects, all `open`.

### Several host processes on one box

Rooms share a Bun thread, so one host process uses **one core** however many
rooms it has. On an 8-core box the way to the other seven is more processes, and
the whole of the configuration is a port and a room base:

| Host | Port | Environment | Rooms |
|---|---|---|---|
| 0 | 8787 | `SYDNEY_ROOMS=8 SYDNEY_ROOM_BASE=0` | 0–7 |
| 1 | 8788 | `SYDNEY_ROOMS=8 SYDNEY_ROOM_BASE=8` | 8–15 |
| 2 | 8789 | `SYDNEY_ROOMS=8 SYDNEY_ROOM_BASE=16` | 16–23 |
| 3 | 8790 | `SYDNEY_ROOMS=8 SYDNEY_ROOM_BASE=24` | 24–31 |

A templated unit is the tidy way to run them. `sydney@.service`:

```ini
[Unit]
Description=SYDNEY room host %i
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/sydney/server
Environment=SYDNEY_WORLD=/opt/sydney/dist/world
Environment=SYDNEY_ROOMS=8
Environment=SYDNEY_ROOM_CAP=128
# The port and the room base are the only per-host values, and they are derived
# from the instance name so a fifth host is one `systemctl enable sydney@4`.
ExecStart=/bin/sh -c 'SYDNEY_PORT=$((8787 + %i)) SYDNEY_ROOM_BASE=$((8 * %i)) /root/.bun/bin/bun run index.ts'
Restart=on-failure
RestartSec=2
MemoryMax=1500M

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now sydney@0 sydney@1 sydney@2 sydney@3
```

Each host loads its own copy of the city (about 190 MB resident at load, and
250 MB under a full 1,000-player swarm — see PERFORMANCE.md phase 4), so budget
memory per host rather than per box.

**Caddy.** `caddy/rooms.Caddyfile` in this repo is the snippet; it fans `/ws/<n>`
out to `127.0.0.1:878n` and keeps the existing bare `/ws` pointed at host 0 so
every current bookmark still works. Install it the way `world-cache.Caddyfile`
is installed and **remove the inline `handle /ws` block it replaces**:

```bash
scp -i ~/.ssh/sydney_deploy caddy/rooms.Caddyfile \
  root@oxford-tractor.bnr.la:/etc/caddy/rooms.Caddyfile
ssh -i ~/.ssh/sydney_deploy root@oxford-tractor.bnr.la \
  'caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy'
```

The site block then reads:

```caddyfile
oxford-tractor.bnr.la {
	root * /opt/sydney/dist
	encode zstd gzip

	import /etc/caddy/world-cache.Caddyfile
	import /etc/caddy/rooms.Caddyfile          # <- replaces `handle /ws { ... }`

	handle {
		try_files {path} /index.html
		file_server
	}
}
```

**The client's host list.** With one host, the client's gateway step fetches
`/rooms` from the page's own origin and needs no configuration at all. With
several, drop a `rooms.json` beside `index.json` in `dist/` naming them:

```json
{
  "hosts": [
    { "path": "/ws/0", "rooms": "/rooms/0" },
    { "path": "/ws/1", "rooms": "/rooms/1" },
    { "path": "/ws/2", "rooms": "/rooms/2" },
    { "path": "/ws/3", "rooms": "/rooms/3" }
  ]
}
```

A client with no `rooms.json` falls back to the origin's `/rooms` and lands on
host 0, which is why the bare `/ws` rule is kept first in the snippet: **every
step of this degrades to the single-host behaviour** rather than failing.

### Verifying a fanned-out box

```bash
for n in 0 1 2 3; do curl -s localhost:$((8787+n))/rooms | head -c 80; echo; done
curl -s https://oxford-tractor.bnr.la/rooms/2 | head -c 80   # through Caddy
```

Then two browsers with `?room=` naming rooms on *different* hosts: each should
see only itself plus its room's bots, and the two leaderboards should be
disjoint. That is the same claim `checkRooms` asserts over loopback, made
against the public edge.

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
curl -s  https://oxford-tractor.bnr.la/health            # {"ok":true,"rooms":[...],...}
curl -s  https://oxford-tractor.bnr.la/rooms             # [{"id":0,"players":0,...}]
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

- **Memory.** `MemoryMax=820M` on a 1 GB box (600M until the 60 km world:
  boot peaked at exactly 600M and stalled, though steady state is 434 MB).
  `SYDNEY_COLLISION_CAP_MB=64` and `SYDNEY_LANES_CAP_MB=90` make the hex
  residency actually bind — at their 450/300 defaults the whole 19.3 km
  world fit under the cap, the residency never evicted, and RSS pinned to
  the cgroup ceiling: the kernel then reclaimed *inside* the cgroup, so bun
  re-faulted its own pages off disk 825 times a second and a 60 Hz tick
  degraded to 28 ms with two players. Leaving room for Caddy and the
  OS. Measured steady state is 81 MB with a 134 MB peak, so the cap is ~4.5x
  headroom and exists to make a leak restart the service rather than the box.
  **A room host needs more**: PERFORMANCE.md phase 4 measured 202 MB mean and
  252 MB peak for eight rooms holding 1,000 players, so anything running rooms
  wants `MemoryMax=1500M` and a box with the RAM to back it. The floor is the
  city itself (about 190 MB), which is loaded once per *process* — so four host
  processes on one box is 760 MB before a single player joins, and that is the
  number to size against rather than the per-room one.
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
