# Where the railway sits: one rule instead of six

Written 2026-08-10, after fixing the same bug four times in different clothes.
**Strategy, to be adopted by the rail rounds in flight.**

## The pattern behind every failure so far

| what the player saw | what the data said |
|---|---|
| Sydenham buried | `surface`, depth **+8.28 m** below the grid |
| Chatswood buried | **`elevated`**, depth **+6.90 m** below the grid |
| Roseville unreachable | `surface`, depth **−2.50 m** — on an embankment |
| Lindfield reads as rails on dirt | depth **0.06 m**; really a cutting, tagged by nobody |
| Central Chalmers St 15 m under the footpath | light-rail stop snapped to the Metro bore below it |
| Cherrybrook buried | `surface`, genuinely underground |

Six reports, one mechanism: **we collapse a noisy, contradictory measurement
into a discrete label, and then let the label decide what to build.** When the
label is wrong the geometry is wrong, and — this is the part that hurt — it is
wrong *silently*, because nothing ever compares the label against the ground it
is a claim about. `elevated` with the track seven metres under the terrain is
not a near miss. It is two systems that have never been introduced.

## The rule

### 1. Measure the relationship, do not classify it

The only quantity geometry needs is a signed number, sampled **per point along
the corridor** rather than per station:

```
clearance(s) = trackY(s) − groundY(s)
```

Everything falls out of it, with no labels in the decision at all:

| clearance | what exists there | access implied |
|---|---|---|
| `> +2.0 m` | viaduct or embankment: structure below the track | steps **up** from the nearest footpath |
| `−1.0 … +2.0 m` | at grade: ballast on the ground | a **gap in the boundary fence** |
| `< −1.0 m` | cutting: carve the terrain, trench walls | steps **down**, cut into the trench wall |
| `tunnel` tag | bore: no surface expression, portals at transitions | a station box and a shaft |

**Per point, not per station**, because a 200 m platform routinely changes
category along its own length — Chatswood is exactly that, and so is every
station on the approach to a viaduct.

### 2. The label becomes an output

`vertical` stays, because the map, `/tp` and the station board all want a word.
But it is **derived from the measured profile** and can therefore never
contradict it. An assertion, not a comment:

> a station's `vertical` must agree with the sign of the median clearance over
> its platform length, or the build fails and names the station.

Chatswood at `elevated` / +6.90 m would never have shipped.

### 3. When sources disagree, precedence is stated, not improvised

The conflicts are real and will keep happening, so write the tie-break down:

1. **`tunnel=yes` wins outright.** A DEM cannot see a bore. Nothing carves, no
   surface expression, portals where the flag changes.
2. **`bridge=yes` decides the *structure*** — a deck with piers — but it does
   **not** get to claim the ground is lower than the DEM says. If a bridge span
   measures below the terrain, that is a **conflict to report**, not to obey.
   This is precisely the Chatswood failure: the classifier believed a bridge
   tag from the viaduct north of the station and stopped looking at the ground.
3. **Otherwise the DEM wins**, because the DEM *is* the ground we render and
   the player's feet stand on it. If the heightfield says the track is under
   the surface, then on screen it is under the surface, whatever OSM believes.

The one-line version: **OSM is the authority on what the structure is; the DEM
is the authority on where the ground is.** They answer different questions, and
neither may answer the other's.

### 4. Access is generated, never looked up

Every failure of reachability came from treating access as *content* — build it
where OSM maps a footbridge. Access is not content. It is a **function of the
clearance profile**, generated for every station by construction:

```
access(station) = steps(sign(clearance)) + footbridge(platforms ≥ 2 across track)
```

A station cannot lack access, because the same number that made it need access
generates it. Where OSM maps a real entrance or overbridge, use its position;
where it does not, put one at the nearest footpath. Registered for collision,
so it is walkable and not scenery.

### 5. The invariants, because every one of these failed silently

Each maps to a report above. None of them existed.

- **Reachability.** From the street outside every station, a walk exists to a
  doorway the boarding prompt accepts. Pathfound, not eyeballed.
- **Label agreement.** `vertical` matches the measured median clearance (§2).
- **Nothing buried.** No drawn non-tunnel track sits more than ~1 m below the
  *visible* surface without a trench around it. *(shipped, 5,577 → 1)*
- **Nothing walled.** No grounded prism inside the loading gauge. *(still
  failing at 345 cells — `elevated.py` has never heard of a railway)*
- **Every platform has a service.** A station you cannot catch a train from is
  a bug, with deliberate exceptions named. *(Roseville: 7 North Shore stations
  had platforms and no calls)*
- **Sanity.** Track never above its own catenary, never below its own tunnel
  floor, gradients inside the ruling grade.

### 6. What this deliberately does not fix, and why

**Lindfield.** The terrain grid is one post per 31.25 m and a cutting is 15–20 m
wide, so a cutting narrower than a post is *invisible to the data*. No rule can
recover it: the DEM says flat and OSM tags nothing. The mitigation is not
geometric but visual — a corridor with boundary fencing, a ballast shoulder and
a defined cess reads as a railway even when it is flat, which is exactly the
work already in flight. Accept the resolution limit, say so, and move on.

If it ever matters enough, the inference is available: a corridor whose
*adjacent road* heights sit consistently above the track is in a cutting the DEM
smoothed over. That is a real signal and a later round.

## How this is being applied

- The bake gains `clearance(s)` per corridor point and derives `vertical` from
  it (§1, §2), with the precedence rule replacing the current tag-first
  classifier (§3).
- `rail-geo` chooses trench / grade / viaduct off the profile rather than the
  label, which it half does already since the carve shipped.
- Access is generated for every station from the same profile (§4).
- The six invariants in §5 go into the suite, each with a negative control, so
  the next one of these fails loudly in CI instead of quietly in Chatswood.
