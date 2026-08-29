# instructions.md — fixing the stutter

**For the engineer picking this up.**
Written by Sebastian after George's review. Supersedes both
`docs/FRAME-STALLS.md` and `docs/FRAME-STALLS-REVIEW.md` where they disagree
with it.

**The one rule: do the phases in order.** Phase 0 costs half a day and decides
whether Phase 3 is worth two weeks or worth nothing. Skipping it is how this
project has already spent four rounds of confident reasoning on four wrong
answers.

---

## What changed after review, briefly

George was right about the following, and I have taken all of it:

- **Finding 4 (sweep beat frequency) is dead.** The sweep periods are 250, 200,
  100, 66.7, 33.3 and 2,000 ms; their least common multiple is **two seconds**.
  A beat between them predicts a stutter five times more often than the one
  being reported. Do not build the sweep stagger.
- **Findings 5 and 8 were one finding** (no scheduler). **Finding 9** was scope,
  not a defect. **Finding 7** (6.4 MB main-thread JSON) is real but is a
  load-time stall, and is a separate ticket.
- **Nothing in the paper was measured.** That is the reason Phase 0 exists and
  the reason it comes first.
- **The period is distance, not time.** Both reports were at constant speed — a
  long train ride and driving. This game streams on distance, and at constant
  speed distance *is* time. That is the best idea in either document and it is
  George's.

### The one place I will refine him

George put the period at **11.4 s**, from 500 m tiles at 44 m/s. The mechanism
is right; the specific boundary is not established, and I do not think it can be
established by reading. There are **six distance thresholds within the window
that fits the complaint**:

| boundary | metres | at 44 m/s | at 22 m/s |
|---|---:|---:|---:|
| `RING_CACHE_STEP_M` (ring recompute) | 125 | 2.8 s | 5.7 s |
| `COLLISION_LOAD_RADIUS_M` | 420 | 9.5 s | 19.1 s |
| `TRAFFIC_DRAW_RADIUS` | 420 | 9.5 s | 19.1 s |
| tile grid (`tile_size`) | 500 | **11.4 s** | 22.7 s |
| shadow role hysteresis | 580 | 13.2 s | 26.4 s |
| `GROUND_REVEAL_RADIUS_M` | 600 | 13.6 s | 27.3 s |

Anything between roughly 350 m and 600 m produces "about ten seconds" at driving
speed. Five of those six fit as well as tiles do.

There is also a detail that weakens the tile reading specifically: **tile
arrivals are quantised by `RING_CACHE_STEP_M = 125`**, so new tiles do not
arrive in a batch of eight every 500 m — they arrive roughly two at a time every
125 m, which is every 2.8 s at speed. The tile *grid* has an 11.4 s period; tile
*arrival* does not.

So: George's class of cause, and a measurement to pick the member. That is
Phase 1.

---

## Phase 0 — Take the measurements. Ship nothing.

Half a day. Three tasks, none of which requires writing production code.

### 0.1 — The speed test

Drive and walk with the console open. Note the interval between freezes at each
speed.

| speed | if distance-driven | if timer- or GC-driven |
|---|---|---|
| standing still, empty street | **no freezes** | unchanged, ~10 s |
| walking (~5 m/s) | ~40–120 s | unchanged, ~10 s |
| half throttle (~22 m/s) | ~19–27 s | unchanged, ~10 s |
| flat out (44 m/s) | ~9–14 s | unchanged, ~10 s |

**This single test splits the whole investigation in two.** Standing still for
two minutes in a street you have already loaded is the most informative two
minutes available, because it removes every distance boundary at once.

Record the actual intervals. "It felt about the same" is not a result.

### 0.2 — Read the instrument we already have

The client already prints, on every frame over 66 ms:

```
[frame] 221 ms — worst sections: render 214.0ms, ...
  | pipelines compiled in stalled frames so far: N over K frame(s), worst M ms
  | compiles N over K keys, M objects
  | worst: ShadowMaterial{color,normal,position}[inst] 1151, ...
```

That last field is a **named tally of what is compiling**, added specifically to
stop this project guessing, and as far as I can tell nobody has read it since.
Capture ten of these lines during a bad minute and write down:

- the top three entries of `worst:` and their counts;
- whether `compiles` is climbing during the stall or flat;
- the `keys` and `objects` numbers — if `objects` climbs in step with
  `compiles`, we are missing the cache, not releasing it.

### 0.3 — Get the four numbers the paper asserted without

From `frameProfile.report()` on a console handle, in a normal minute and then
during a bad one:

1. `sim` — mean and worst. **This decides whether the accumulator clamp matters
   at all.** At 0.4 ms a step, eight steps is 3.2 ms and it is noise. At 3 ms it
   is a 24 ms secondary stall.
2. `render` — mean and worst.
3. `stream` — mean and worst.
4. The sum of all sections against the frame total, on the worst frame. The gap
   is time nobody in our code spent.

**Exit criterion for Phase 0:** a paragraph naming the speed–interval
relationship, the top three compiling materials, and the four numbers. Nothing
after this phase is worth starting without it.

---

## Phase 1 — The boundary log

One afternoon. This is the instrument that discriminates between the six
candidates in the table above, and it is deliberately tiny.

Add a counter that bumps whenever the player crosses each named boundary, and
print the counters on the existing `[frame]` line. If a stall lands on the same
frame as a `tile-grid` crossing, ten times running, the investigation is over.

- **New module:** `client/src/world/boundarylog.ts`
- **Shape:** pure. A `BoundaryLog` holding the last position and a count +
  last-crossed-frame per named boundary; `note(x, z, frame)` returns which
  boundaries were crossed this frame.
- **Wire:** one call in the frame loop beside `frameProfile.at(FSEC.stream)`,
  and one field appended to the `[frame]` line in `main.ts`.
- **Acceptance:** `verifyBoundaryLog(): string[]` wired into **both** boot lists
  (`client/src/main.ts` and `server/index.ts`) — the module must be three-free.
  Assert: a straight 1,000 m walk across a 500 m grid reports exactly two grid
  crossings; a 124 m step reports no ring crossing and a 126 m step reports one;
  standing still reports nothing forever; and a diagonal crossing that changes
  both tile axes at once counts as one crossing, not two.

**Exit criterion:** a line of the form
`boundaries: ring 41, collision 12, grid 5, ground 4` beside every stall report,
and a stated correlation.

---

## Phase 2 — The fixes that are right whatever Phase 0 says

Do these regardless. None depends on the outcome.

### 2.1 Clamp the accumulator — `client/src/main.ts:10487`

```ts
accumulator += frameDt;
let steps = 0;
while (accumulator >= FIXED_DT && steps < 8) {
  simulate(FIXED_DT);
  accumulator -= FIXED_DT;
  steps++;
}
// A stall must not be paid for twice. Whatever the step cap could not consume
// is time the simulation will never run, and that is the correct outcome: a
// player cannot perceive four lost milliseconds of simulated time and can
// certainly perceive the next two frames doing eight steps each to catch up.
if (accumulator > FIXED_DT) accumulator = FIXED_DT;
```

- **Acceptance:** `verifyFrameStep(): string[]`, pure, both boot lists. Feed a
  synthetic sequence of frame deltas including a 400 ms spike and assert: the
  step count never exceeds 8; total steps over a clean second is 60 ± 1; and
  **after a spike, the frame following it runs at most 2 steps** — which is the
  regression this exists to prevent.
- **Prioritise by 0.3.** If `sim` is under 1 ms, ship it as hygiene and stop
  claiming it as a fix.

### 2.2 Retune the stall reporter — `client/src/main.ts:12397`

- Threshold `LONG_FRAME_MS` 66 → **25**.
- Cooldown 5,000 ms → **1,000**.
- Report into a ring buffer of 64 entries, not the console. Console keeps one
  line per 5 s as it does now so a bad minute is still visible without being the
  problem.
- Expose `sydney.stalls()` to dump the ring as a table.

### 2.3 Stolen time, with the baseline George asked for

Per frame, compare the RAF timestamp delta against the sum of the profiler's own
sections. The difference is time nobody in our code spent.

**It will read non-zero constantly** — it includes the browser's compositing and
the previous frame's GPU work. So:

- Take a rolling 5th-percentile of the difference over the last 240 frames and
  treat *that* as the baseline.
- Report `stolen = gap - baseline`. Only that number means "something stopped
  us".
- **Acceptance:** `verifyStolenTime(): string[]`, pure, both boot lists. Feed a
  synthetic series with a constant 4 ms overhead and one 60 ms injection; assert
  the baseline converges to ~4 and the injection reports ~56, not ~60.

### 2.4 A `longtask` observer

Five lines. `PerformanceObserver` on `longtask`, entries into the same ring as
2.2. Guard it in a `try/catch` and treat absence as normal — Safari does not
implement it, and a client that throws on boot because a browser lacks an
observer is a worse bug than the one being chased.

---

## Phase 3 — Conditional. Read Phase 0 first.

**If the interval scaled with speed** (distance-driven), Phase 1 has already
named the boundary. Fix that boundary's first-draw cost, and only that one:

- The tile and ground **shadow-role** pipelines are already warmed at boot
  (`streamer.ts`, `receives: [true, false]`) — so if the boundary turns out to
  be the 580 m shadow hysteresis, the hole is somewhere else and the `worst:`
  tally from 0.2 says where.
- If it is the tile grid, the work is in the warm queue: a tile must be `warm`
  *before* it can be drawn, and the queue must not be able to fall behind the
  ring at 44 m/s. Measure the queue depth while driving before changing anything.

**If the interval did not change with speed**, it is a timer or GC. Then:

- The `worst:` tally from 0.2 says whether it is compilation.
- If it is not compilation, it is allocation. Profile with the browser's own
  allocation timeline, find the per-frame allocator, and pool it. The house style
  is already pooled almost everywhere, so there will be few candidates and they
  will be recent.

---

## Phase 4 — The structural one

Only after Phases 0–3. This is the fix that ends the category rather than
managing it.

**The set of pipeline variants becomes a build-time artefact, not a runtime
discovery.** Enumerate every material × pass × geometry-layout combination the
game can produce, warm all of them at load against the real render targets, and
make a variant appearing at runtime a **reported fault** rather than a silent
compile.

`world/warmup.ts` and the `receives: [true, false]` pattern are already this idea
applied by hand, one case at a time, by whoever hit each case. The work is to
make it exhaustive and to make the exhaustiveness checkable.

**Acceptance:** a `verifyPipelineManifest(): string[]` that walks the declared
manifest and fails if any material in the scene graph produces a cache key the
manifest does not contain.

---

## Explicitly not doing

- **The sweep stagger.** Disproven; see the top of this document.
- **The content-parse worker.** Real, and a separate ticket. It is a load stall,
  not this symptom, and it should not ride along and confuse the measurement.
- **Dropping the shadow map to 2048.** It is a real cost and `sydney.setShadowMapSize()`
  already exists to test it — but it is a *constant* cost, and constant costs do
  not produce periodic freezes. Do not spend this budget on frame *rate*.

---

## House rules for this work

From `CLAUDE.md`, and they are not optional:

- **No browser-driven testing.** Acceptance is a `verifyX(): string[]` wired into
  **both** boot lists, or a scripted driver over a real server. Every phase above
  names its check. If something can only be judged by eye, say so in one sentence
  and let the owner look.
- Anything under `client/src` that the server imports must be **three-free**.
  `boundarylog.ts` and the pure halves of 2.1 and 2.3 all qualify — keep them so.
- `integration-check` reads the working tree **at spawn time**. Do not edit
  during a run; use a worktree pinned to the commit under test, and
  `SYDNEY_CHECK_ONLY=<section>` for a single section in a minute.
- Build only from a pinned worktree with `client/public/world` removed.
- Kill test servers by port or pid, never `pkill -f` on a fragment.

---

## What "done" looks like

A player driving flat out across the city for five minutes sees no frame over
25 ms, and `sydney.stalls()` is empty. Not "feels smoother" — the ring is empty,
and there is a check that says so.
