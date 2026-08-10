# Visual bug catalogue — a walk around Sydney

Captured 2026-08-10 against the live dev build on `main` (`localhost:5173`), with
two other agents editing `rail.py` / `rail-geo.ts` / `fences.ts` underneath me.
Everything here is **reconnaissance only** — no source file was touched.

Images are in `client/.shots/`, all named `rec-*.png`, all 1050×674, all taken at
the same forced time of day (`sydney.sky.scrubTo(0.42)` ≈ 10:18) so the frames
are comparable. The bat and football viewmodels are in most frames; ignore them.

**How the frames were taken**, because it is not obvious and the next person will
need it. The Browser pane throttles `requestAnimationFrame` to nothing when it is
not the frontmost thing, so the world never streams and the canvas never updates.
The fix is to replace `window.requestAnimationFrame` with a `MessageChannel`-paced
shim — message tasks are *not* throttled in a hidden page, unlike timers — and
then read the canvas back with `canvas.toDataURL()` inside the shimmed frame and
`POST` it to vite's `/__shot` sink. With that in place, captures work with the
pane hidden and at full render resolution. Note that any edit to `client/src`
triggers a vite full reload and destroys the injected harness, so this has to be
re-injected every few minutes while other agents are working.

**Numbers in this document** come from `sydney.rail.world` in the running client:
`net.stations` for the station records, `ground(x,z)` for terrain, and
`cut.cutAt(x,z,groundY)` for whether the corridor carve fires at a point. Where I
quote a cross-section I sampled perpendicular to the *nearest rail segment*, not
to the station's own axis — the two differ and sampling the wrong one is how you
conclude a cutting exists when it does not.

---

## 1. Lindfield — mostly fixed, and it shows

**Images:** `rec-lindfield-street.png`, `rec-lindfield-track.png`,
`rec-lindfield-corridor.png`, `rec-lindfield-down.png`
**Get back there:** `sydney.rail.go('Lindfield')`, or station at `(-3853.6, -10186.7)`,
trackY `32.06`.

This is the frame the user complained about and it is not that frame any more.
From the street (`rec-lindfield-street`) there is now a palisade boundary fence
along the whole corridor, a ballast shoulder, a defined cess and a platform with
a station name blade behind it — it reads as a railway, not as rails lying on
dirt. From 110 m up (`rec-lindfield-down`) the corridor is a clean, continuous
strip through the suburb with no building in it.

What is still true: the measurement is unchanged. Terrain at the corridor
centreline is `31.2`, the rail is at `32.1`, so the track sits 0.9 m **above** the
ground and is at grade, exactly as `RAIL-VERTICAL.md` §6 says it must be — the
DEM cannot see a 15 m cutting on a 31.25 m post grid. The mitigation was supposed
to be visual and the visual mitigation has landed. **Known issue, and it now
looks acceptable.** The only thing left in the frame that reads wrong is the
ground itself, which is bare tan mud right up to the fence line (see §9).

At track level (`rec-lindfield-track`) the two platform faces rise well above eye
height on both sides, which is a slightly odd read — from between the rails the
platforms look like retaining walls rather than platforms — but nothing a player
walking around will ever see.

## 2. Roseville — the wall is real and there is no way up

**Images:** `rec-roseville-wall.png` (the money shot), `rec-roseville-street.png`,
`rec-roseville-air.png`, `rec-roseville-track.png`
**Get back there:** `sydney.rail.go('Roseville')`, station at `(-3005.1, -9223.3)`,
trackY `40.88`, terrain at the corridor `38.2`.

`rec-roseville-wall` is taken from the road, 26 m out, and it is the complaint
verbatim: a continuous grey retaining wall roughly 2.5 m tall runs the full width
of frame, a palisade fence stands on top of it, the platform and its awning are
behind that, and there is **no gate, no stair, no ramp and no break anywhere in
the visible run**. A pedestrian is standing on the footpath outside the fence in
the frame, which is exactly where a player ends up: at the bottom of a wall,
looking at a station they cannot get onto. The station record backs it —
`depth: -2.50`, `clearance: 2.527` — so this is squarely in `RAIL-VERTICAL.md`'s
`> +2.0 m` bucket, which is the bucket whose stated access rule is "steps **up**
from the nearest footpath". §4's generated access has not shipped.

**Known issue** (`RAIL-VERTICAL.md` §4/§5 reachability). The wall itself is built
correctly and looks good; it is the access that is missing.

## 3. Chatswood — the data is still wrong, the picture is fine

**Images:** `rec-chatswood-across.png`, `rec-chatswood-street.png`,
`rec-chatswood-track.png`, `rec-chatswood-plaza.png`, `rec-chatswood-air.png`
**Get back there:** `sydney.rail.go('Chatswood')`, station at `(-2774.9, -7775.8)`,
trackY `37.83`.

The brief expected a Metro track 6.9 m under a plaza with the player on top and
the doors 23 m away. **That is not what is on screen now.** In
`rec-chatswood-across` (55 m from the corridor, ground level) the Metro is
standing at a platform at grade, level with the road and the surrounding ground,
with a red-brick building in front of it and the towers behind. Standing directly
on the corridor centreline (`rec-chatswood-plaza`) puts you nose-to-nose with the
front cab of a Metro set, not on a plaza above one. The terrain around the
corridor samples at `36.1`, which is a couple of metres under the rail, not six
metres over it.

What has *not* changed is the record: `depth: 6.90`, `clearance: -6.02`,
`structure: "bridge"`, and the conflict string is still sitting in the bake
verbatim ("OSM says bridge … and the DEM puts that deck -6.02 m against the ground
it is supposed to be over"). Also worth noting for whoever wrote the brief:
`vertical` now reads **`surface`**, not `elevated`. So the geometry has been
rescued but the label and the clearance number have not been reconciled with it —
`RAIL-VERTICAL.md` §2's "label agreement" assertion would still fail here.
**Known issue, no longer visible to a player.**

`rec-chatswood-air.png` is a failed capture — the aerial camera landed inside a
tower and half the frame is the inside of a wall. Ignore it.

## 4. Sydenham — the carve did **not** ship here, and this is the worst rail bug in the set

**Images:** `rec-sydenham-onrail.png`, `rec-sydenham-overrail.png`,
`rec-sydenham-down.png`, `rec-sydenham-street.png`, `rec-sydenham-lip.png`
**Get back there:** `sydney.rail.go('Sydenham')`, station at `(-3903.3, 5195.5)`,
trackY `-71.18`.

The brief said to verify that the deepest cutting in the network now reads as an
open cutting. It does not, and the numbers say why. Cross-section perpendicular to
the nearest rail segment, terrain height against distance from the centreline:

| offset (m) | −20 | −12 | −4 | **0** | +4 | +12 | +20 |
|---|---|---|---|---|---|---|---|
| terrain | −63.4 | −63.2 | −63.1 | **−63.1** | −63.0 | −62.9 | −62.9 |
| `cutAt` | – | – | – | **null** | – | – | – |

The rail at that point is at **−71.2**. That is **8.1 m of unbroken terrain
standing over the track**, the profile across the corridor is a smooth
1 %-gradient hillside with no trench in it at all, and `RailCut.cutAt` returns
`null` at *every* sample across ±20 m — the carve never fires here. For contrast,
the identical query at Newtown returns `−38.3` over ±8 m, so the carve mechanism
itself works; it just does not fire at Sydenham.

On screen this means there is no railway at Sydenham. `rec-sydenham-onrail` and
`rec-sydenham-overrail` were both aimed at rail level and both came back as an
ordinary street scene with cars and pedestrians, because the player body is
resolved up out of the terrain and stands on the ground above the buried track.
`rec-sydenham-street` is a normal suburban corner with a station name blade and
nothing behind it. From 110 m up (`rec-sydenham-down`) you can just make out
platform slabs and a couple of trench facets in the lower middle of the frame, but
from the footpath there is nothing.

**Known mechanism** (`RAIL-VERTICAL.md`'s whole thesis), **new instance** — the
document lists Sydenham as an already-diagnosed report and the write-up talks
about the carve as shipped, but at the bake currently in `client/public/rail/`
Sydenham is still buried. Worth checking whether `drawnAsTunnel` is swallowing the
segment: the nearest segment carries `flags: 17`, and Newtown's carries `flags: 17`
too, so flags alone do not explain the difference.

## 5. Erskineville — buildings standing in the corridor, quantified

**Images:** `rec-erskineville-overbuilt-air.png` (the money shot),
`rec-erskineville-track.png`, `rec-erskineville-street.png`
**Get back there:** `sydney.rail.go('Erskineville')`, station at `(-2166.2, 3692.9)`,
trackY `-55.09`. The worst prism is centred near `(-2152, 3574)`.

I walked the track centreline in the client rather than eyeballing it: sample
every 4 m along every rail segment within 350 m of the station, ask
`collision.prismsWithin` for prisms whose vertical span overlaps 1–3.5 m above the
rail, and point-in-polygon test the centreline against each. **117 sample points
are inside a grounded building prism.** Grouped by prism:

| prism (base/top) | points | run | clearance above rail |
|---|---:|---:|---:|
| −50.9 / −37.6 | 40 | **25 m** | +2.3 m (a 13 m building roofing the track) |
| −54.4 / −50.9 | 16 | 12 m | +0.5 m |
| −51.7 / −49.1 | 7 | 157 m | **−0.8 m** |
| −57.3 / −51.3 | 7 | 19 m | **−1.8 m** |
| −56.7 / −51.1 | 7 | 5 m | **−1.6 m** |

The negative ones are the serious ones: those prisms start *below* rail level and
extend up through it, so the track passes through solid collision. The 25 m one is
a whole building standing across the corridor with its floor slab 2.3 m over the
railhead. In `rec-erskineville-overbuilt-air` (60 m up, looking down the corridor)
you can see it: the tracks run left-to-right across the frame and a large blank
cream prism sits squarely on them in the centre, with the corridor emerging again
on the far side. At ground level the corridor is so tightly built-in that a camera
placed 34 m to the side ends up resolved onto somebody's roof
(`rec-erskineville-overbuilt.png` — that frame is a roof, and that is the finding).

**Known issue, now with a number**: `TREES.md` calls it "the building over the
railway at Erskineville and 344 other cells (`elevated.py`'s over-road rule has
never heard of a railway)", and `RAIL-VERTICAL.md` §5 lists "Nothing walled" as
still failing at 345 cells. 117 four-metre samples in one 350 m radius is what
that looks like from inside the game.

## 6. Newtown — the cutting works; use it as the reference

**Images:** `rec-newtown-lip.png`, `rec-newtown-overrail.png`,
`rec-newtown-track.png`, `rec-newtown-down.png`, `rec-newtown-air.png`
**Get back there:** `sydney.rail.go('Newtown')`, station at `(-2751.9, 3267)`,
trackY `-38.4`.

Terrain at the corridor is `−34.7`, rail is `−38.4`, and `cutAt` returns `−38.3`
across ±8 m — a 16 m wide trench, 3.7 m deep, carved to the railhead. It reads
correctly on screen. From the lip (`rec-newtown-lip`) you look down past the edge
of the ground onto the platform canopies and the station blade below you; standing
over the corridor (`rec-newtown-overrail`) the white curve filling the bottom of
frame is the *roof of a train* at your feet, which is precisely the read a shallow
cutting should give. From 110 m (`rec-newtown-down`) the corridor is a clean slot
between the terraces with the King Street bridge over it.

**This one looks fine.** It is the control that proves Sydenham is broken rather
than unimplemented. One nit: there is no fence, kerb or parapet along the lip, so
the tan ground simply stops and drops 3.7 m — a player can walk straight off it.

## 7. Circular Quay — the viaduct reads correctly from underneath

**Images:** `rec-cquay-under.png`, `rec-cquay-side.png`
**Get back there:** `sydney.rail.go('Circular Quay')`, station at `(-126.4, -848.7)`,
trackY `-45.78`, groundY `-52.9`, `clearance: 7.874`.

`rec-cquay-under` is taken standing on the ground under the structure looking
along it, and it works: a concrete deck overhead running away to the right on
piers, daylight and street beyond it, a walkable footpath and roadway underneath,
trees and towers past that. Walk-under reads exactly like walk-under. **Looks
fine — no action.** The only oddity in the pair is that the underside is a plain
untextured slab, so it is a bit flat compared with the rest of the CBD, which is a
polish note and not a bug.

## 8. Meadowbank — nothing wrong that I could see

**Images:** `rec-meadowbank-side.png`, `rec-meadowbank-air.png`,
`rec-meadowbank-onrail.png`, `rec-meadowbank-overrail.png`
**Get back there:** `sydney.rail.go('Meadowbank')`, station at `(-11133.9, -5914)`,
trackY `-57.07`.

Platform placement is right — the station, its awning and its blade are where the
tracks are, so the 225 m error is gone. `cutAt` returns `−57.0` over ±8 m, so this
corridor is carved. From the side (`rec-meadowbank-side`) the station reads as an
ordinary at-grade suburban station behind a car park and a fence. **Looks fine.**

Two capture notes rather than findings: `rec-meadowbank-onrail` is a close-up of a
Tangara bogie because a train happened to be standing exactly where I put the
camera (it is actually a decent look at the underframe detail, which is good), and
I never got a clean frame of the bridge approach itself — the river crossing is
north of where these cameras landed. **Bridge approach not inspected**; do not
read this section as clearing it.

## 9. Ku-ring-gai Chase — the worst-looking place in the game

**Images:** `rec-kuringgai-ground.png`, `rec-kuringgai-air.png`
**Get back there:** `sydney.look({x: -1206.2, z: -24219.3, y: 70.1, yaw: 2.7, pitch: 0})`,
or `/tp ku-ring-gai chase`.

There is nothing to describe because there is nothing there. `rec-kuringgai-ground`
is a horizon-to-horizon dune of flat tan mud with a strip of water in the middle
distance — no trees, no scrub, no heath, no grass, no rock, no colour variation of
any kind. `rec-kuringgai-air` from 240 m is the same thing at scale: tens of square
kilometres of desert with the Cowan Creek drowned-valley system cut through it in
flat dark teal. If you did not know, you would guess this was an unfinished
terrain test scene, not a national park.

**Known issue and it is `TREES.md`'s exact case** — 12,054 bushland polygons the
pipeline has never read, and §4's observation that "the bare hill reads wrong as
much because it is flat tan dirt as because it has no trees" is confirmed by these
two frames. I would go further than the document does: the ground colour is not
just *part* of the problem out here, it is most of it, and it is not confined to
the parks. Every single suburban frame in this catalogue — Lindfield, Roseville,
Newtown, Sydenham, Meadowbank, Hurstville — has the same tan mud between the
buildings where lawn, verge and backyard should be. Fixing the ground material
would visibly improve the entire 60 km world, not just the two national parks.

## 10. Penrith and the open west — no canyon, but nothing else either

**Images:** `rec-penrith-open.png`, `rec-penrith-air-west.png`,
`rec-penrith-west.png`
**Get back there:** `sydney.look({x: -49600, z: -12000, y: -72.9, yaw: 1.57, pitch: 0})`
for the open-country frame; Penrith station is at `(-47836.8, -12254.6)`.

The specific worry in the brief — that the 214 m far-terrain sink reads as a
canyon from open country — **I could not reproduce**. Standing 1.7 km west of
Penrith (`rec-penrith-open`), the ground runs to the horizon with no step, no
seam and no drop; the near terrain and the far terrain meet without a visible
join. Sampling agrees: at Penrith the ground sampler and the surface the player
actually lands on both read `−38.9`, exactly equal.

The problem out here is different and, walking around, worse. `rec-penrith-open`
is a **completely featureless tan plane in every direction** — not one tree, road,
fence, hill or building, just noise-textured mud and sky. And from 180 m up
(`rec-penrith-air-west`) you can see what the far tier actually looks like when
there is no city to hide behind: a small island of real world around Penrith
station (streets, trees, textured buildings, the river) sitting in an endless
field of blank untextured slab prisms standing on bare ground, running to the
horizon west, north and south. So the argument that "the far city masks it" is
half right — it masks the *terrain* seam, which genuinely is not visible; it does
not mask the fact that the far tier is a grid of grey and brick-red boxes on a
desert. **New**, in the sense that it is the untested case the accept-decision was
predicated on.

## 11. Westfield Hurstville and The Rocks — not found, and I am not going to pretend

**Images:** `rec-hurstville-air.png`, `rec-rocks-air.png`
**Get back there:** Hurstville station `(-9758, 11078)`; The Rocks `(-107.5, -975.2)`.

I could not find the four road-spanning prisms `clearance-audit` fails on. The
audit's test needs OSM carriageway centrelines, and the client only holds street
geometry for the tile ring it has streamed (`locator.segments` was empty at every
place I looked), so I had no way to run the audit's actual predicate in-game and
fell back to eyeballing aerials. Neither aerial shows an obvious building lying
across a road. **Not inspected properly — treat these two as unchecked.** If
somebody wants them found, run `uv run python -m sydney clearance-audit`, which
prints the coordinates, and then point a camera at them; that is a five-minute job
with the coordinates in hand and an hour of guessing without them.

The two aerials did each turn up something else, below.

## 12. (new) The far-city tier is a hard visible ring, and it is lit wrong

**Images:** `rec-hurstville-air.png`, `rec-penrith-air-west.png`,
`rec-newtown-air.png`

`rec-hurstville-air` is the clearest: the bottom-left quarter of the frame is the
real world — textured buildings, roads, trees, cars, the rail corridor — and the
rest of the frame, starting at a hard line a couple of hundred metres out, is
flat-shaded coloured slabs on bare ground with no roads and no detail at all. The
transition is not a fade, it is an edge, and it cuts diagonally across the middle
of the picture.

Separately, the far tier does not take the same light as the near world. By day it
sits noticeably *darker* than the near buildings and the horizon carries a bright
white speckled band (visible along the top of `rec-hurstville-air` and
`rec-newtown-air`). At night the polarity flips: an aerial I took at 03:50 before
forcing the clock had a near world correctly dark and lamp-lit while the far ring
at the horizon was still rendering at daylight brightness — a bright white and
red band across the top of an otherwise black city. I overwrote that frame on the
daylight re-shoot, so I cannot show it, but it is trivially reproducible: go up
150 m anywhere, `sydney.sky.scrubTo(0.9)`, and look at the horizon.

This costs a ground-level player almost nothing — you have to be up high or on a
ridge to see it — which is why it is ranked low, but it will be the first thing
anyone notices in a screenshot taken from a tower or a bridge.

## 13. (new) Harbour Bridge reads as a bare ramp

**Image:** `rec-rocks-air.png`
**Get back there:** `sydney.look({x: -357.5, z: -725.2, y: 147, yaw: -0.79, pitch: -0.35})`

From over The Rocks the Harbour Bridge is a plain grey deck sloping across the
water with a stub of structure at the south end and nothing else — no arch, no
pylons, no truss. Given it is the single most recognisable object in the city and
it is visible from most of the harbour foreshore, this is worth a line even though
it is scenery. The water in the same frame also shows concentric ripple banding
along the shoreline that looks like a shader artefact rather than waves.

---

# Ranking — worst first, by how much it hurts somebody just walking around

1. **Bare ground everywhere, national parks worst** (§9). Not one blade of grass
   in the entire 60 km world; Ku-ring-gai Chase is a desert. It is in every frame
   in this document, in every suburb, at every hour. `TREES.md` step 1 (ground
   materials for bushland / scrub / grassland) is cheap relative to two million
   trees and would lift the whole world at once. Do this first.
2. **Sydenham buried under 8.1 m of terrain, carve not firing** (§4). A major
   station simply is not there for a player on the footpath, and the carve that
   would fix it demonstrably works 2 km away at Newtown. Highest-value rail fix.
3. **Erskineville's corridor built over and walled in** (§5). 117 centreline
   samples inside grounded prisms, one 25 m building over the track, several
   prisms starting below railhead. This is the one that breaks riding as well as
   looking, and it is 345 cells network-wide, not one place.
4. **Roseville platform reachable only by pole-vault** (§2). A station you can see
   and cannot get onto is a worse experience than a station that is missing, and
   §4 of `RAIL-VERTICAL.md` already specifies the fix.
5. **The outer west is an empty plane of blank blocks** (§10). Nobody spends much
   time at Penrith, which is the only reason this is not higher. The terrain seam
   the accept-decision worried about is genuinely invisible; the untextured far
   tier over bare ground is not.
6. **Far-city LOD ring, and its lighting mismatch by day and by night** (§12).
   Only visible from height, but glaring when it is.
7. **Chatswood's label and clearance still contradict its geometry** (§3). Costs
   the player nothing today — it looks right — but it is exactly the silent
   disagreement `RAIL-VERTICAL.md` was written to make impossible, and it will
   bite again the next time anything reads `vertical` or `clearance`.
8. **Harbour Bridge with no arch** (§13). Cosmetic, iconic, cheap to notice.
9. **No parapet at the Newtown cutting lip** (§6). You can walk off a 3.7 m drop.
   Minor.

**Looks fine, leave alone:** Lindfield (§1 — the fence-and-ballast work landed and
it reads as a railway now), Newtown (§6), Circular Quay walk-under (§7),
Meadowbank platform placement (§8).

**Not actually inspected, do not treat as cleared:** Westfield Hurstville and The
Rocks road-spanning prisms (§11), and the Meadowbank *bridge approach* as distinct
from the station (§8).
