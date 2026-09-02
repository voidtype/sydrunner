# AUDIT — dumb, dangerous and orphaned code

Found by mechanical scans over `client/src`, `server`, `scripts`, `pipeline`
and the repo itself, then read by hand. Every item has a place to go and one
or two plain sentences. Line numbers are as of `419705a`, the commit audited.

Where the repo already explains a thing well, it is not listed. Where I caused
it, it says so.

## Outcome

Everything below was fixed in the commit after `419705a`, except three things
left on purpose:

- **The sixteen FNV-1a copies were not consolidated.** Several of them feed
  ids that are persisted or shared -- `doorway.buildingSeed` is the space id
  every piece of furniture on the box is filed under -- and the copies do not
  mix identically. One shared function would change hashes, which would move
  every couch in Sydney to a room that no longer exists. Leave them until a
  retile is being done anyway.
- **The zero-index draw was not located.** Twelve places set an instanced
  count to 0; without a frame to inspect I cannot say which one is submitted
  while at zero. It is a warning, not an error.
- **The `Math.sin`/`cos` in the movement basis stays.** Yaw is a continuous
  float off a mouse; there is no integer form. `controller.ts` now says why it
  is safe and what number it depends on.

Two items turned out to be misread and were fixed differently: the station-box
check was wrong, not the data (a served bore legitimately gets three boxes --
station, access ramp, tunnel -- and the assertion said one); and the texture
shim was never broken -- its own self-check installs it against six deliberately
broken stubs and each one logged the warning.

## Start here — the five I would fix first

- **`server/index.ts:1501` — `/god` is an unauthenticated POST that calls a paid
  LLM with no per-IP guard.** The comment says it is "rate-limited by the turn
  cap inside `Audience`". That caps turns in one conversation, not requests per
  second. Anyone can loop it. The key's budget is capped, so the worst case is
  the improv going dark for everyone until the cap resets — but it is the
  only write route in the file with no `FloodGuard`, and `/bug` and `/suggest`
  both have one.
- **`client/src/main.ts:2439` and `:2646` — two self-checks fail on every boot for
  every player and are downgraded to `console.warn`.** `an underground station
  got 3 station boxes, expected 1` and `Denistone on CCN dir 1 stops 107 m from
  its own platform`. A check that always fails and never blocks is a check
  nobody reads. Either fix the data or delete the assertion.
- **`server/wallets.ts:213` and `server/accounts.ts:299` — a failed copy-aside is
  swallowed and then reported as a success.** On an unparseable file, the code
  tries to copy it to `*.broken-<ts>`, swallows any error, then logs "moved to
  aside" regardless. If that copy fails, the store starts empty and the next
  debounced save **overwrites the only copy of everybody's money or accounts**.
  The log would say it was saved.
- **`client/src/game/traffic.ts:5291` (`verifyLaneShare`) and `:5730`
  (`verifyResidency`) are real checks that nothing runs.** Neither is on either
  boot list nor in any `*-check.ts`. `verifyLaneShare` asserts the lane-share
  rule is a pure function of the tick — the property that lets both ends agree
  with nothing on the wire. It has been silently unenforced.
- **`client/src/world/texture-audit.ts:692` — the texture shim is dead against the
  installed three.** It warns on every boot: `renderer._textures.updateTexture
  was not found -- three has probably renamed it`. The null-image guard it
  installed no longer exists, so the crash it was written to name will hit
  the frame unnamed.

## Dangerous

- `server/index.ts:1501` — `/god` POST. See "Start here". No `FloodGuard`, no
  auth, no per-IP limit.
- `client/src/main.ts:1848`, `:1866`, `:1898`, `:1961`, `:11477`, `:14294`,
  `:14297` — reaches into three's private renderer internals through
  `as unknown as`. These are the hooks the pipeline budget, the reclaim and
  the texture shim depend on. One has already broken (see `texture-audit.ts:692`).
  Every three bump can silently disable another.
- `client/src/world/trippass.ts:149`, `:193` — calls `renderAsync()`, which three
  now logs as deprecated on every boot. `:390` — `new PostProcessing(renderer)`,
  which three says has been renamed to `RenderPipeline`. Both will stop working
  on the next major.
- `server/wallets.ts:213`, `server/accounts.ts:299` — swallowed copy-aside, then a
  log line that claims the copy happened. See "Start here".
- `server/sim.ts:5758` — `interiors` map is never pruned. Its comment says it is
  bounded by `MAX_PLAYERS`. It is not: it is bounded by the number of distinct
  buildings anyone has ever entered while the process lives, and a room lives
  for days. Small per entry, but the claim is wrong. **Mine.**
- `server/quests.ts:710` — `ImprovCache.cache` is keyed by node **and week** and
  never evicts. Every week adds a full set of lines and last week's are kept
  forever. Bounded by content size per week, unbounded across weeks.
- `client/src/world/placeables.ts:104` — `BODY_RADIUS_M = 0.35` restates
  `controller.ts:67`'s `PLAYER_RADIUS = 0.34` wrongly, and the comment says
  `verifyPlaceables` asserts the two agree. Nothing asserts it. Both ends use
  the same wrong number, so there is no desync — the comment is the lie.
  **Mine.** (`spawn.ts:141` restates it correctly and `checkSpawn` really does
  assert it, which is the pattern I should have copied.)
- `client/src/world/interior.ts` (19 sites) and `placeables.ts` (3 sites) use
  `Math.hypot` in code both ends run. DESIGN.md rule 5 names `hypot` as one of
  the four to avoid because engines differ in the last bit. The resolver's
  tolerances have absorbed it so far. **Mine.**
- `client/src/game/combat.ts` (11 sites) and `player/controller.ts` (5) use
  `Math.sin`/`cos` of yaw for the movement basis on both ends. Pre-existing and
  absorbed by the reconcile deadzone, but it is the same rule-5 tension and
  nothing in the repo says which side wins if Bun and V8 ever disagree.
- `server/index.ts:1273` — a send to a socket that closed is swallowed. Fine on
  its own; listed because it is the only swallowed send and the comment is
  the only place that says why.
- `client/.shots/` — 121 MB of screenshots on disk. Git-ignored, so invisible,
  but it is the "screenshot sink" `CLAUDE.md` forbids agents from building, and
  it is still there.
- WebGPU logs `Draw with an index count of 0 is unusual` on every boot. Something
  submits an empty draw. Harmless today; it is the kind of thing that becomes a
  validation error on a driver update. Not located.

## Dumb

- `client/src/main.ts:9124`, `:9182`, `:9212`, `:9243`, `:9244` and
  `client/src/net/client.ts:3220`, `:3221` — event callbacks accept wire fields
  (`health`, `ball`, `y`, `colourway`, `bot`, `px`, `pz`) and then `void` them
  to silence the linter. Either the callback should not take them or it should
  use them. Data decoded and thrown away.
- `server/sim.ts:5997` — `SAME_SPOT_M + 1.2` is a magic number pretending to be
  a named one. **Mine.**
- `client/src/main.ts:10267` — every frame indoors, `showIndoors` walks every
  remote rig and sets a layer bit on every node. Cheap, but it is a per-frame
  loop doing a one-time job because I did not want to track props. **Mine.**
- `client/src/world/interior.ts:1003` — `(it as { placedBoxes }).placedBoxes =
  boxes` casts away my own `readonly`. If the field must be written, it should
  not be `readonly`. **Mine.**
- After the door became the building's, three copies of it survive:
  `Participant.doorX/doorZ/doorNX/doorNZ` (`server/sim.ts:5831`, `:5915`),
  `interiorDoorX/Z/NX/NZ` in `client/src/main.ts:8029`, and the four `door*`
  fields on the `SPACE` wire frame. All are now derivable from `Interior.door`.
  **Mine.**
- `INTERIORS.md:98` — the heading says "protocol v23". It is v25.
- Sixteen files each carry their own FNV-1a hash (`0x811c9dc5`):
  `world/cars.ts`, `world/floorplan.ts`, `world/power.ts`, `world/doorway.ts`,
  `world/tile-decode.ts`, `world/far.ts`, `world/nightlights.ts`,
  `world/powerups.ts`, `world/birds.ts`, `game/traffic.ts`, `game/rave.ts`,
  `game/events.ts`, `game/bikes.ts`, `server/room.ts`, `server/aoi.ts`,
  `server/integration-check.ts`. One `hash.ts` would do, and a check could then
  assert the one thing that matters about it.
- `client/src/main.ts:2960` — the shader warm-up audit prints a wall of text on
  every boot (`8 hidden meshes have no warm-up entry`, then ~70 material names).
  It is a check whose output is too long to read, so nobody does.
- `client/src/main.ts:5465` — `window.setInterval(() => dialog.tick(0.25), 250)`
  is never cleared. Page-lifetime, so harmless; listed because it is the one
  interval in the client with no owner.
- About fifty exported symbols are used nowhere but their own declaration.
  Some are this repo's habit of exporting "against the interface" for a later
  workstream; the rest are dead. The ones worth a look:
  - `client/src/game/teamfx.ts:191`, `:471`, `:522`, `:665`, `:927`, `:1093`,
    `:1117`, `:1237` — eight `fx*` helpers, exported, never called.
  - `client/src/game/talentkeys.ts:95`, `:186`, `:191`, `:196`, `:201`.
  - `client/src/game/abilities.ts:120`, `:257`, `:406`.
  - `client/src/game/talentlive.ts:100`, `:108`.
  - `client/src/game/combat.ts:943` `refreshMaxHealth`.
  - `client/src/game/riding.ts:2122` `copyAboard`.
  - `client/src/game/powerups.ts:241` `effectSeconds`.
  - `server/sim.ts:7044` `phaseName`.
  - `client/src/world/cover.ts:79`–`:83` (five `COVER_*`), `world/furniture.ts:171`–`:173`
    (three `LAMP_*`), `world/rail-solids.ts:211`, `:1319`, `:1365`, `:1370`,
    `world/hexes.ts:247`, `world/envelope.ts:209`, `:336`, `game/driving.ts:1077`,
    `:1079`, `game/density-data.ts:734`, `:737`, `game/mandala.ts:121`,
    `game/mushrooms.ts:109`, `game/rail-audio.ts:188`, `game/wildlife.ts:3100`,
    `player/animation.ts:315`, `world/landmarks.ts:70`, `world/teamview.ts:172`,
    `world/wallghosts.ts:197`, `game/events.ts:192`, `game/characters.ts:3281`.

## Orphaned

- `client/src/game/traffic.ts:5291` `verifyLaneShare` and `:5730` `verifyResidency`
  — see "Start here". Real assertions, no caller.
- `client/src/world/collision-window-check.ts` — 1,100+ lines with its own CLI
  header (`bun run client/src/world/collision-window-check.ts`), imported by
  nothing, named in no `package.json` script and no `.md`. `verifyCollisionWindow`
  at `:1099` is unreachable.
- `client/src/perf-harness.ts` — 1,874 lines, imported by nothing. Its only
  documented runner (`bun run client/src/perf-harness.ts --coverage`) is in a
  comment that exists only in the dead handoff worktree, not in the current
  `main.ts`. `frameprofile.ts:98`, `:286`, `:558`, `:579` still describe it as if
  it were live.
- `.handoff-ao/` — 72 MB, containing a worktree on `merge/overpass-grade`, which is
  0 commits ahead of `main` and 180 behind. Dead. `.handoff/`, `.opencode_logs/`
  and `.opencode_receipt` beside it are tool droppings.
- `.claude/worktrees/cool-cannon-dcd07e` and `interesting-meninsky-7c9ade` — two
  worktrees on branches 0 ahead and 338 behind `main`. `git worktree remove`
  both, then delete the branches.
- `client/.shots/` — see "Dangerous". Delete.

## Things I checked and did not flag

- `verifyTextureAudit` fails under Bun with five "shim did not repair" lines.
  That is the environment, not the shim: it needs `document.createElement('canvas')`
  (`texture-audit.ts:455`), it is on the client list only, and the same five
  failures appear with every change in this pass stashed. In the browser it
  passes (`render-guard 37.2` in the boot timing line).

- Chat, suggestions and the phone render player text through `textContent` or an
  `escape()`; the three `innerHTML` writes (`phone.ts:654`, `sky/clock.ts:320`,
  `teams.ts:340`) take markup the client built itself.
- `/bug` has a `FloodGuard` and requires an account. `/suggest` has one.
- `pipeline/sydney/*.py` has no bare `except:`, no `shell=True`, no `os.system`.
- The empty-body `catch` blocks in `cdn.ts`, `suggestions.ts` and `quests.ts` each
  carry a comment that says what is being swallowed and why. That is the house
  style and it is fine.
- Every `setInterval` on the server is paired with a `clearInterval` on shutdown.
- `rsync --delete` in `DEPLOY.md` is scoped away from the world and the state dir,
  and the doc says why.
