# CLAUDE.md — read before doing anything in this repo

SYDNEY is a browser multiplayer melee FPS in a geometrically accurate 60 km
Greater Sydney: a Python pipeline (`pipeline/`) bakes the world, a Vite/three
WebGPU client (`client/`) streams it, and a Bun server (`server/`) is the
authority. The server imports shared modules from `client/src` — anything it
imports must be three-free. Every file opens with a header essay saying *why*;
match that voice, and read the header of any file before changing it.

## The three documents that matter

- **[DEPLOY.md](DEPLOY.md)** — how anything gets to players. Read **"The
  runbook, end to end"** first. It covers the code deploy (build without the
  world symlink, precompress, rsync, restart, gate on `/health`), the world
  publish after a retile (snapshot → audits + terrain byte-diff → restore
  region mtimes → R2 upload → server sidecars), and every trap already hit:
  the box is `oxford-tractor.bnr.la` for ssh (`sydrunner.3rp.uk` is the site),
  the R2 S3 credentials live in `~/.config/sydney/r2.env` (never print them;
  if they ever 403, probe before blaming the script), `wrangler r2 object`
  without `--remote` silently writes to a local bucket, `SYDNEY_STATE_DIR` on
  the box holds accounts/wallets and must never be rsynced over, and the
  Caddy `/auth/*` handle.
- **[STATIONS.md](STATIONS.md)** / **[RAIL-VERTICAL.md](RAIL-VERTICAL.md)** /
  **[TRAINS.md](TRAINS.md)** / **[RAIL-CORRIDOR.md](RAIL-CORRIDOR.md)** — the
  railway's architecture and invariants. RAIL-CORRIDOR is the newest and binds
  every writer of lineside geometry: the corridor is shared, the lateral budget
  is the one answer to how far a track may build, and the structure gauge is
  the check that convicts anything that forgets to ask.
- **[PERFORMANCE.md](PERFORMANCE.md)** / **[EXPANSION.md](EXPANSION.md)** —
  the budgets (1 vCPU / 1 GB box, wire per player, memory caps).
- **[DESIGN.md](DESIGN.md)** — the taste ledger: the eight rules every
  mechanic must pass, and the researched verdicts (adopt / later / refuse)
  from WoW, Skyrim, GTA and the player suggestion board. A brief that
  contradicts it is wrong until it is changed.
- **[scripts/content/README.md](scripts/content/README.md)** — content packs
  (quests, dialog) go live from GitHub without a deploy; the five scripts
  there are the only placement/register gate, and a pack is refused whole on
  one error.

## Rules that are not negotiable

- **No browser-driven testing by agents.** Acceptance is a repeatable, cheap
  test: a `verifyX(): string[]` self-check wired into *both* boot lists
  (`client/src/main.ts` and `server/index.ts`), or a scripted driver over the
  real server (`server/accounts-check.ts`, `server/cardamage-check.ts`,
  `server/ride-acceptance.ts`, `server/underground-check.ts` are the pattern). Test rendering by its pure
  parts. If only eyes can judge something, say so in one sentence and let the
  owner look. Do not start vite, drive the browser pane, or build screenshot
  sinks. An **offline** render of pure data is fine and encouraged:
  `scripts/render-car-sheet.mjs` rasterises every car glb into one PNG with
  no browser, and reading that PNG is how a wrong nose or a missing body
  panel gets caught before a deploy.
- **`integration-check` runs against the live tree.** It takes ~25 minutes and
  spawns real servers along the way, each reading the working tree *at spawn
  time* — so a merge or an edit landed mid-run gives a parent on the old code
  talking to children on the new, and every failure it prints is suspect (a v20
  merge mid-run once produced eighteen, all phantom). Run it on a tree you will
  not touch, or in a worktree pinned to the commit under test. Four more traps
  from the same hour: `SYDNEY_CHECK_ONLY=<section>` runs one section in a
  minute instead of twenty-five (the list is at the bottom of the file;
  `SYDNEY_CHECK_ONLY=police` now exists), and `pkill -f "SYDNEY_PORT=8791"`
  matches **nothing** — env vars are not in a process's command line, so servers
  you think you cleaned up keep listening on the check's ports and the next run
  silently talks to them. Kill by pid. The main checkout's `client/public/world`
  is the real 16 GB world, not a symlink — `vite build` there copies it into
  `dist`, so build only from a pinned worktree with the symlink removed; and
  `pkill -f <fragment>` also kills any sub-agent whose prompt text contains the
  fragment (the handoff runner passes the whole task on its command line) — stop
  servers by port (`lsof -tiTCP:<port> -sTCP:LISTEN | xargs kill`) and handoffs
  by their pid file.
- **Determinism**: anything evaluated on both ends avoids `Math.sin/cos/pow/
  hypot`; ambient things are pure functions of `(anchor, index, tick)`. See
  `game/footy.ts` and `game/traffic.ts` headers.
- **The wire** (`client/src/net/protocol.ts`) is one file both ends import.
  New messages get a round-trip in `verifyNet`; `PROTOCOL_VERSION` is bumped
  once per shipped batch by the lead, together with the assertion in
  `server/integration-check.ts`.
- **Parallel workstreams**: pre-assign message ids, `NPC_KIND` bytes and
  `REASON` codes in the briefs before spawning; keep `main.ts` edits to small
  contiguous blocks; put logic in new modules. Merge smallest-first; typecheck
  and boot the server after each merge.
- **Toolchain**: `export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"`
  before any node/npm (the bare PATH has node v4); pipeline is
  `cd pipeline && uv run python -m sydney <cmd>`; a fresh worktree needs
  `node_modules`, `client/public/world` and `data` symlinked from the main
  checkout — and the world symlink *removed* again before `vite build`.
- Never print credentials (`~/.config/sydney/r2.env`, `/etc/sydney/secrets.env`,
  `~/.ssh/sydney_deploy`). Never `git reset --hard` or `git checkout` in the
  main checkout; work in a worktree.

## Delegation

Design and gating in the lead session; mechanical legs (audits, byte-diffs,
uploads, rsyncs, docs) through the `agent-handoff` skill; design-heavy code
through Opus subagents with a written brief. `DEPLOY.md` §C says the same with
the reasons.
