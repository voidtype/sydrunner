# RAIL-CORRIDOR.md — one answer to what the railway may build, and where

## The failure this document exists to end

The owner, riding Hornsby → Penrith on the live build, filed five complaints in
one sitting:

> *"the platforms are so badly aligned at curved places like woolstronecraft ...
> im passing thru platform all the time"*
> *"passing through a lot of rail assets, but the platforms are the worst"*
> *"i think part of it is that adjascent tracks' assets overlay other tracks"*
> *"half of your stations are underground and shit"*
> *"complex ones like central are convoluted garbage"*

The third quote is the diagnosis, and he made it from a moving train. Every one
of these is the same defect wearing different clothes: **every track believes
it owns the whole corridor.** Each direction polyline writes its ballast, cess,
platform, fence, masts and furniture at fixed lateral offsets from its own
centreline, with no knowledge that another running line is four metres away.
The writers are per-track; the railway is not.

## The measurement that convicts it

Sampled from the shipped bake (`scripts` live in the session scratchpad; the
permanent versions belong in `server/rail-clearance-check.ts`'s family):

**Different lines share corridors at adjacent-track spacing.** Nearest-approach
between direction polylines of *different* lines, over stretches within 20 m:

    Inner West & Leppington ~ Liverpool & Inner West   median 4.3 m  (106 samples in 3–5 m)
    North Shore & Western   ~ Central Coast & Newcastle median 4.4 m  (83 in 3–5 m)
    Inner West & Leppington ~ Cumberland               median 4.2 m  (78 in 3–5 m)

**A line's own two directions are trimodal**: coincident (<0.5 m — 137 samples
on Central Coast & Newcastle, where OSM mapped one way for both directions),
paired running at 3–5 m, and 12–50+ m through the four-track sections where the
up and down services take different physical paths. So "a line" is a *service
pattern*, not a pair of rails, and any model built on "a line's own pair" is
wrong three ways at once.

**The arithmetic of the foul.** A car body is ~3.1 m wide, so a neighbouring
track at 4 m spacing sweeps the band **2.4–5.6 m** from our centreline. Against
the writers' extents (`world/rail-solids.ts`):

    platform      1.62 – 7.12 m   ← the neighbour's whole train is inside it
    fence                6.4  m   ← clears a 4.0 m neighbour by 0.8 m; fouls a 3.7 m one
    carve slot           5.4  m   (9.4 at stations)

The platform fouls **everywhere** spacing is under 8.7 m. This is why the owner
said "the platforms are the worst": they are the widest thing any track writes.

**Corrected by the P0 audit (`server/rail-gauge-check.ts`), which outranks the
paragraph above.** Swept against the car body, the shipped build fouls 190.3 of
778.2 km (24.4%), and the split says there are **two mechanisms, not one**:
neighbour overlap dominates the ballast, fences and masts (208.8 km of
asset-metres), but the platform's own fouling is dominated by **its own curve**
— a straight 160 m deck against a bowing running line. Median bow 2.25 m
against a total platform margin of 70 mm; 323 of 361 sites exceed it on bow
alone; the worst is Wollstonecraft at 17.60 m on a 182 m radius, which is the
station the owner named from the train. So the budget (idea 2) fixes the
neighbour half and the sweep (idea 3) fixes the curve half, and neither is
sufficient alone.

## The model

Three ideas, in dependency order. Everything else in this document is detail.

### 1. The track atlas

Computed **once, globally, at bake decode** — not per chunk, because a track's
nearest neighbour is routinely in the next chunk and two chunks computing
adjacency locally will disagree at their seam.

- Sample every direction polyline of every line.
- **Dedup coincident runs into physical tracks**: two polylines within ~1.5 m
  and roughly parallel are the *same* rails, shared by services. One owner —
  lowest `(line, dir)` index, which is deterministic — writes the shared
  geometry; the others write nothing. (Today both write, coincident: doubled
  draws and z-fighting nobody has looked closely enough to report.)
- **Group physical tracks into corridors** — corrected by implementation: a
  corridor *partition* of Sydney does not exist. Adjacency is transitive and
  the network is connected, so the closure is one corridor spanning the basin.
  What a slot actually needs is **local**: the gap to the nearest parallel
  track on each side, the count of parallel tracks here, and this track's
  ordinal among them. `world/track-atlas.ts` stores exactly that and nothing
  global. The parallelism test still matters — two directions 15 m apart on
  diverging service paths are not neighbours and must not budget against each
  other.
- Per direction vertex, store **distance to the nearest other physical track,
  each side**. Two floats per vertex; the bake has 27,645 vertices; the memory
  is nothing and the build is one spatial-hash pass.

### 2. The lateral budget, and the gauge that enforces it

One function, beside `cutAt` in spirit and possibly in file:

    corridorBudget(dir, vertexIndex, side): metres this track may build here

The answer is half the stored neighbour distance minus a margin on an interior
side, and a corridor-edge allowance on an outside edge. **Every writer clips to
it** — ballast shoulder, cess, platform, fence, masts, furniture, the trench
walls, and any writer added later (the tunnel lights now in flight included).

The budget is the rule; the **structure gauge is the proof**. A permanent check
sweeps the car-body envelope along every physical track and asserts that
*nothing the rail builder emits* intersects it. The budget makes the foul
unlikely; the gauge check makes it a red build. A writer that forgets to ask
the budget is caught by the gauge, which is why both exist.

### 3. Slots, not offsets

A platform stops being "a box at offset 1.62–7.12 from track T" and becomes an
occupant of a **slot**: the outside edge of an edge track (a side platform), or
an interior gap wide enough to hold one (an island, shared by the two flanking
tracks, owned by one of them deterministically). Slots fall out of the atlas —
a gap either has ≥ platform-width of budget or it does not.

Two consequences that are the point:

- **Swept, not placed.** A slot occupant is extruded along its owning track's
  polyline at a constant offset, exactly the way ballast and cess already are,
  so it follows the curve *by construction*. The clipping the owner rode
  through becomes inexpressible rather than merely tested-for.
- **Where no slot fits, no platform is built.** A missing platform is honest;
  a platform inside a train is not. The bake's spacing decides.

And the hand-authored layouts (Central, Town Hall, Wynyard, Redfern,
Strathfield, Parramatta, Chatswood, Bondi Junction, Hornsby — sourced from real
schematics, facts only, provenance in comments) stop being a bolt-on: **a
schematic is precisely a slot assignment**. The table overrides which slots
carry platforms and which are islands; the procedural rule is the fallback for
the other 258 stations.

## Stations, boxes and bores

Unchanged from the station-box design, now grounded in the atlas: at a station
the carve widens from the corridor slot to the **union of the station's slotted
footprint** (platforms + access + margin), still answered by `cutAt` so the
hole and the trench cannot disagree. At an underground station the bore opens
*into* the box within the station footprint and reseals outside it, with the
transition landing on a boundary both callers evaluate identically — a bore
that stops being a bore mid-sub-quad is the daylight-slot failure `rail-cut.ts`
already documents. Whether the box is capped (an interior room, the likely
right answer 24 m under North Sydney) or open to the sky is argued per the
implementation, not assumed here.

## What this relaxes

The at-grade identity guarantee ("St Leonards and Artarmon must come out
bit-identical") becomes **geometric equivalence**: a swept ribbon on straight
track produces the same surfaces as the old box but not the same buffers.
The test compares sampled surfaces within epsilon, and the owner's eyes remain
the last word on the two stations he named as already right.

## Phasing — each stage shippable, each with its own gate

    P0  atlas + budgets + gauge audit, REPORT ONLY   → the offender table, by asset kind
    P1  clip existing writers to the budget; dedup shared-alignment owners
        → ends "passing through assets" everywhere, at the cost of some assets
          shrinking or vanishing where they never fit
    P2  swept platforms in slots                     → ends the Wollstonecraft clip
    P3  station box + opened bores                   → ends buried and sealed stations
    P4  schematic overrides for the nine interchanges
    P5  (optional, same atlas) synthetically offset the coincident direction
        pairs by ±2 m so trains stop sharing rails head-on — the atlas already
        knows exactly where those 137+ samples are

The gauge audit is the acceptance for all of it, and it had to be red at P0:
if it did not convict the current build of exactly what the owner rode through,
it was measuring the wrong thing. It convicted (24.4%). **From the first merge
on, it ratchets like every other check in this repo** — the budget sits just
above the current measurement and descends with each phase, so the tree never
carries an unexplained red and a regression fails the day it lands. The target
(10 km total, 0 m platform) lives in the header as where the ratchet is going,
not as today's gate.

## Costs, stated

Atlas build: one pass over 27,645 vertices at decode — measure it, budget it
(tens of milliseconds is the expectation; it can be folded into the existing
decode-time work). Memory: two floats per vertex. Frame cost: budgets are
lookups; nothing per-frame changes. The risk is not performance, it is
behavioural: P1 *removes* geometry that never fit, and some of it will be
missed — that is the honest trade and the owner has already voted for it from
inside a train.
