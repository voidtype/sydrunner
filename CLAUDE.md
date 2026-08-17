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
  the R2 S3 token in `~/.config/sydney/r2.env` is dead (403) so uploads go
  through `wrangler … --remote` until a new token exists, `wrangler r2 object`
  without `--remote` silently writes to a local bucket, `SYDNEY_STATE_DIR` on
  the box holds accounts/wallets and must never be rsynced over, and the
  Caddy `/auth/*` handle.
- **[STATIONS.md](STATIONS.md)** / **[RAIL-VERTICAL.md](RAIL-VERTICAL.md)** /
  **[TRAINS.md](TRAINS.md)** — the railway's architecture and invariants.
- **[PERFORMANCE.md](PERFORMANCE.md)** / **[EXPANSION.md](EXPANSION.md)** —
  the budgets (1 vCPU / 1 GB box, wire per player, memory caps).

## Rules that are not negotiable

- **No browser-driven testing by agents.** Acceptance is a repeatable, cheap
  test: a `verifyX(): string[]` self-check wired into *both* boot lists
  (`client/src/main.ts` and `server/index.ts`), or a scripted driver over the
  real server (`server/accounts-check.ts`, `server/cardamage-check.ts`,
  `server/ride-acceptance.ts` are the pattern). Test rendering by its pure
  parts. If only eyes can judge something, say so in one sentence and let the
  owner look. Do not start vite, drive the browser pane, or build screenshot
  sinks.
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
