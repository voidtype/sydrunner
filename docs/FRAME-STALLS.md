# Why SYDNEY Stutters

**An outside read of the frame path, for the gods of the server**
Sebastian — first pass over the codebase, 2026-08-29

---

## Preface: this is not the usual patient

I was told the game freezes for fractions of a second, roughly every ten
seconds, and that it breaks immersion. I expected to find the usual causes and
I did not find them.

This client already does most of what I would normally have to recommend. Tile
payloads decode on a **worker pool**. Construction is **budgeted** at
`BUILD_BUDGET_MS = 2.5` with a separate `GROUND_BUDGET_MS = 1.0` for terrain.
Ambient traffic, crowds and trains are **pure functions of a clock**, so six
thousand cars cost nothing on the wire and nothing in GC. Hot paths are pooled
and say so. There is a real **frame profiler** that tiles the RAF callback into
nineteen named sections and keeps a two-second ring. Snapshots run at 20 Hz
behind a *measured* interpolation delay with a floor.

That is a better starting position than most shipped browser games. It also
means the easy wins are gone, and what is left is the residual class of stall —
the kind that is invisible to the instruments currently in the build. So this
paper is mostly about **what the game cannot currently see about itself.**

One caveat I want on the record before the findings. I have read the code; I
have not profiled a running session. Several findings below are structural
certainties (the code either clamps the accumulator or it does not). A few are
*hypotheses ranked by how well they explain "every ten seconds, briefly"*, and I
have marked them as such. Recommendation 2 exists precisely because the
difference between those two categories is currently unresolvable from inside
the game, and I would rather hand you an instrument than a guess.

---

## The ten findings

### 1. The frame has exactly one unbudgeted phase, and it is the one that can block for a second

Every other expensive thing in this client has a ceiling. Tile builds have
2.5 ms. Ground has 1.0 ms. Decoding is on workers. Sweeps run at fixed rates.

`renderer.render(scene, camera)` has no ceiling at all — and under WebGPU it is
the place where pipelines, bind groups, vertex buffers and texture uploads are
created **on first use, synchronously, inside the draw**. A material variant
this scene has never drawn before is a shader compile in the middle of your
frame.

The strongest evidence for this is not my reading of three.js — it is that this
codebase already contains **three separate subsystems that exist only to
pre-empt it**: `world/trippass.ts` binds the post-pass target so warm-ups
compile for the right render context, `world/shadowwarm.ts` learns what the
shadow pass binds by watching the first one go past, and `world/asyncpipes.ts`
wraps the pipeline getter to push compilation onto the async path. Nobody builds
three of those for a theoretical problem.

### 2. You cannot currently tell a stall you *caused* from a stall you *suffered*

There is no `PerformanceObserver` anywhere in `client/src`. No long-task
observer. No GC signal. No `requestIdleCallback`. I searched; the count is zero.

This matters more than it sounds. `FrameProfile` works by *tiling* the callback:
`at(FSEC.foo)` closes the previous section and charges it the elapsed time, so
between `begin()` and `stop()` every nanosecond is charged to somebody. That is
an excellent design for finding out which of your systems is slow. It is
structurally incapable of telling you that **the browser stopped you** — a 40 ms
major GC, a compositor stall, a driver hiccup, a texture upload — because that
time is silently charged to whichever section happened to be open when it
landed.

So every conclusion drawn from that instrument about a *stall* is an
attribution, not a measurement. It will always name one of your systems, whether
or not one of your systems is responsible.

### 3. The accumulator amplifies stalls instead of absorbing them

```
accumulator += frameDt;
let steps = 0;
while (accumulator >= FIXED_DT && steps < 8) {
  simulate(FIXED_DT);
  accumulator -= FIXED_DT;
  steps++;
}
```

The step cap is correct and prevents a death spiral. But **the leftover is never
clamped.** After a 150 ms stall the accumulator holds 150 ms; this frame runs 8
steps and consumes 133 ms of it; the remainder carries into the next frame,
which runs several more on top of its own.

One stall therefore becomes a two-or-three frame stutter, at up to 8× the normal
simulation cost per frame while it drains. This is worth dwelling on because it
changes what the symptom should *feel* like: a single 60 ms hitch presents as a
brief judder rather than a clean skip, which is a better match for "fractions of
a second breaking immersion" than one long frame would be.

This is a structural certainty, not a hypothesis. It is also a four-line fix.

### 4. A dozen independent periodic sweeps, none of them phase-aware

Counted across the client: quest markers at 4 Hz, the waypoint at 4 Hz, the new
quest tracker at 4 Hz, car model assignment at 5 Hz, invisible walls at 10 Hz,
wall ghosts at 10 Hz, the minimap at 15 Hz, the sun button at 15 Hz, the big map
at 30 Hz, the quest-hub sweep at 0.5 Hz, the dialog tick on a 250 ms
`setInterval`, plus per-system self-timed passes in traffic, crowd, police,
wildlife and the rave.

Each is individually cheap and individually justified. None of them knows the
others exist, and none staggers its phase. **Periodic tasks on independent
wall-clock cadences coincide periodically by construction** — that is a beat
frequency, and a beat frequency is precisely what "every ten seconds or so"
feels like from the inside.

I want to be careful here: I have not proven this is *the* ten-second cause, and
several sweeps only bite when the player is moving. But it is free to fix and it
removes a whole class of coincidence from the search space.

### 5. The one frame-slack test in the codebase serves exactly one consumer

`SWEEP_FRAME_BUDGET_S = 0.025` gates the shadow warm-up sweep: do the optional
work only on a frame that has room for it.

That is the right idea, and it is applied once, to one system, by the person who
happened to need it. Nothing else in the frame asks whether this frame has room.
A quest-marker rescan on a frame that is already 40 ms deep runs anyway.

### 6. A 4096² soft-shadow pass, re-rendered unconditionally, every frame

`shadowMap.type = PCFSoftShadowMap`, `mapSize 4096×4096` over a 440 m volume.
The header in `sky/sky.ts` is admirably honest that this is the first number to
drop if the GPU cannot hold frame, and exposes `sydney.setShadowMapSize()` to
change it live.

Two observations. First, it is unconditional: there is no "skip the shadow
update on a frame that is already late", and no cascade split that would let
near and far shadows update on different cadences. Second — and this is the
subtler cost — the shadow pass is a *second render with a different material
set*, which is exactly why `shadowwarm.ts` had to be written. Every material in
the game has two pipeline variants, not one.

### 7. 6.4 MB of JSON is parsed on the drawing thread, twice

The `/content` bundle is now 6,386,149 bytes. The client does
`await res.json()` and then re-validates the whole thing through
`parseQuestPack` and `parseDialogPack` over 1,989 quests and 1,295 NPCs.

All of that is on the main thread. This is a single multi-hundred-millisecond
stall rather than a periodic one, so it is not your ten-second symptom — but it
lands during load, which is the worst moment to spend the thread, and it will
grow with the content. The re-validation is a good decision (a client on an
older build must not draw a step kind it cannot describe); doing it on the
thread that draws is not.

*Disclosure: this bundle tripled in size earlier today. The parse was always on
the main thread; the size that makes it matter is new.*

### 8. There is no scheduler, only Hz counters

No `scheduler.postTask`, no priorities, no yielding. Deferral throughout the
client is hand-rolled: accumulate a delta, compare against `1/HZ`, do the work.

The consequence is that **all deferred work is equal**. A tile build that will
cause a visible pop if it is late and a quest-marker rescan that nobody would
notice being 200 ms stale compete on identical terms, and neither can be told to
wait because the frame is in trouble.

### 9. The netcode is not your problem, and someone should say so out loud

20 Hz snapshots. A measured interpolation delay with `INTERP_DELAY_MS` as a
floor rather than a constant. Area-of-interest culling. Ambient life derived
from a shared clock at zero wire cost. Rewind on the server for hit
registration.

This is a well-built network layer, and a freeze on this stack is a main-thread
problem. I raise it because "multiplayer game stutters" sends most teams to the
netcode first, and here that would be weeks spent in the one place the bug is
not.

### 10. The instrument that reports stalls cannot see the ones being complained about

```
const LONG_FRAME_MS = 66;
...
if (frameMs > LONG_FRAME_MS && now - lastLongFrameAt > 5000) { ... }
```

Two problems, and they compound.

**The threshold is too high.** At 66 ms, a frame has to be four times its budget
before it is reported. A cluster of 25-40 ms frames — which is exactly what
"fractions of a second" and a judder feel like, and exactly what finding 3
predicts a stall decays into — is entirely invisible to this reporter.

**The cooldown is longer than the symptom's period.** One report per 5 seconds
against a complaint of "about every 10 seconds" means you are sampling, at best,
every other occurrence, and you are sampling the *first* frame of a cluster
rather than the worst one.

The reporter is good — it prints the worst sections and the pipeline count,
which is the single number that separates "this frame did too much work" from
"this frame waited for a driver". It is aimed at the wrong magnitude.

---

## Three recommendations

### R1 — Instrument the stall before optimising it (do this first)

Findings 2 and 10 together mean that **nobody currently knows what is causing
the freeze, and the game cannot be asked.** Every fix shipped before this one is
a guess, and this codebase has already paid for a run of confident guesses about
frame cost.

Three parts, all small:

1. **A `PerformanceObserver` on `longtask`.** This is the browser telling you it
   blocked, and how long for, regardless of whose fault it was.
2. **A stolen-time signal per frame.** Compare the RAF timestamp delta against
   the sum of the profiler's own sections. If the gap exceeds the sum, something
   outside your code ate the difference: GC, compositor, driver, upload. If it
   does not, one of your systems is genuinely slow. **This single subtraction
   converts every future stall report from an attribution into a measurement.**
3. **Retune the reporter** to fire at ~25 ms with a ~1 s cooldown, into a ring
   buffer rather than the console, with a `sydney.stalls()` handle to dump it.
   The console line was rate-limited because a bad minute must not become the
   problem; a ring has no such constraint.

The output of this is a sentence of the form *"in the last minute there were
seven stalls; five were long-tasks outside our sections averaging 38 ms; two
were the render section with pipelines compiling"*. That sentence is the whole
job. You cannot fix this class of bug without it, and with it the fix is usually
obvious.

### R2 — Give the frame a budget object, and make every optional system ask it

Replace a dozen independent Hz counters with one `FrameBudget` that knows how
much of this frame is spent and how much is left. Systems stop asking *"has
250 ms elapsed?"* and start asking *"can I afford a marker rescan right now?"*

This generalises `SWEEP_FRAME_BUDGET_S` (finding 5) from one consumer to all of
them, and it gives you a place to express priority (finding 8): a tile build
outranks a minimap redraw outranks a quest-hub sweep. Under load the game
degrades in an order you chose instead of an order the modulo arithmetic chose.

Fold two smaller things into the same change, because they belong to the same
idea:

- **Clamp the accumulator** (finding 3). After the step loop, discard the
  remainder above one frame's worth. You lose a few milliseconds of simulated
  time on a stall — which nobody can perceive — and you stop one hitch becoming
  three.
- **Stagger the sweep phases** (finding 4). Give each periodic system a fixed
  offset derived from its own identity so that 4 Hz, 5 Hz, 10 Hz and 15 Hz stop
  landing on the same frame. This is a one-line change per system and it removes
  a beat frequency from the build.

### R3 — Nothing that is not drawing belongs on the drawing thread

Two moves, one immediate and one structural.

**Immediate:** the content bundle (finding 7) parses and validates in a worker.
The decode worker pool already exists and this is the same shape of work. The
main thread should receive a finished, validated object.

**Structural, and this is the real one:** finding 1 says a WebGPU application
that creates pipelines lazily inside `render()` will always hitch, because the
first frame that draws a new material variant pays for it at exactly the moment
the player is looking at something new. The three warm-up subsystems are
excellent engineering aimed at a problem that should not exist.

The end state is that **the set of pipeline variants is a build-time artefact,
not a runtime discovery**: enumerate every material × pass × geometry-layout
combination the game can produce, warm all of them at load against the real
render targets, and make it a gate that a new variant appearing at runtime is a
*reported fault*. That is a larger piece of work than the other two put
together, and it is the one that ends this category of bug rather than managing
it.

---

## Closing note

If I could only have one of the three: **R1**. This build is disciplined enough
that its remaining stalls are the kind you cannot reason your way to, and the
game is currently unable to tell you which of two very different problems it
has. Two days of instrumentation will save two weeks of confident optimisation
in the wrong place.

The good news is the shape of the answer. Nothing here suggests a rewrite.
Findings 3, 4, 7 and 10 are each a few lines. Finding 1 is real work, but it is
work with a known end state, and the three subsystems already fighting it mean
somebody on this team has already understood the problem correctly — they have
just been fixing it one symptom at a time.
