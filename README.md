# SYDNEY

A browser-based multiplayer melee FPS set in a geometrically accurate Greater Sydney. The
city is not art: 29,790 buildings, the road network, the terrain and the water are built by
a Python pipeline out of open geodata, projected into EPSG:7856 and emitted as glTF tiles
that the client streams as you walk. Melee combat, vehicles and a football are simulated
identically on the client and on an authoritative Bun server.

Live at **<https://sydrunner.3rp.uk>**.

Built to [`sydney-fps-build-spec.md`](sydney-fps-build-spec.md). This file records what exists,
how to run it, and — importantly — what does not exist yet. Read [`CLAUDE.md`](CLAUDE.md) for the
rules agents must follow in this repo, and [`DEPLOY.md`](DEPLOY.md)'s runbook for how a build
reaches players.

The world itself is not in this repository. It is ~620 MB of generated geometry, published
to Cloudflare R2 and served to players from `https://world.3rp.uk`; the client reads the
`cdn` block in `world/index.json` to find it, and falls back to the origin if R2 is down.
That is what keeps a 20 GB/month box serving a city. See [Data and attribution](#data-and-attribution)
below, and [`DEPLOY.md`](DEPLOY.md) for how a build gets there.

---

## Running it

```bash
npm install
```

Build the world (downloads ~130 MB of source data on first run, then ~30 s):

```bash
npm run world
```

Run the client:

```bash
npm run dev
```

And, in another terminal, the game server — [Bun](https://bun.sh), which is what spec 9's
answered question chose:

```bash
npm run server
```

Then open <http://localhost:5173>, twice. Both tabs find the server on their own page's
host at port 8787 and join the same match; the debug overlay's `net` line says so. **No
server is also fine** — the client falls back to spec 9's local stub with three dummies,
and nothing else about the game changes.

Click to capture the mouse — or drag with the left button held, or use the arrow keys,
either of which works if pointer lock is refused. WASD to move, shift to sprint, space to
jump, **left click to punch**, **right click (or `L`) to fire the raygun**, `[` and `]` to
move the sun by half an hour, `N` for night, `T` back to 3 pm, `M` to toggle the minimap,
`Tab` to toggle the debug overlay.

| | |
|---|---|
| `?server=host:8787` | join a server somewhere else — a whole `ws://` URL also works |
| `?offline` or `?server=none` | force the local stub, with no connection attempted |
| `localStorage['sydney.server']` | the same as `?server=`, sticky across reloads |
| `?room=3` | join a particular room — what an invite link is. Without it the gateway picks the emptiest |
| `SYDNEY_PORT=9000 npm run server` | listen somewhere else |
| `SYDNEY_BOTS=0 npm run server` | no bots (they are **per room**) |
| `SYDNEY_ROOMS=8 npm run server` | run eight rooms in this process; the default is one |
| `SYDNEY_ROOM_CAP=128 npm run server` | players per room. `SYDNEY_MAX_PLAYERS` is an accepted alias |
| `npm run server:check` | two synthetic clients against a real server, no browser |
| <http://localhost:8787/health> | player count, per-room occupancy, protocol version |
| <http://localhost:8787/rooms> | the gateway: `[{ id, players, cap, open }, …]` |

To extend coverage from the 4 km inner ring to the 15 km middle ring:

```bash
npm run world:middle
```

Coverage extends in place — tiles already emitted are not rebuilt.

---

## What exists now

- **Accounts.** A native handle-and-password login, with a level that resets every Monday; each
  level is ten kills, and signing up carries your level and your spot.
- **Money.** Cash in your pocket, a Centrelink payment you claim once a week per office, and
  SydRide fares for the rideshare jobs.
- **Cars.** You can take a stopped car and drive it, with damage that accumulates and a condition
  that persists; a car left in the street is anybody's.
- **The heat ladder.** One to five stars — a highway patrol car at three, an RBT at four, Polair's
  spotlight at five.
- **Characters.** Five Sydney characters, each with its own verbs and idles, out of the same
  ambient tier.
- **Ambient events.** Fender-benders, standoffs, bin-night ibis riots, car-park burnouts and
  trackwork queues, scheduled on the density field as pure functions of the day and the tick — plus
  the street crowd, the wildlife and the illegal raves.
- **Trains.** You can ride the trains, and the Metro sets have open walk-through gangways between
  the carriages.
- **The phone.** Four hand slots — bat, footy, phone, fists — in either hand, with left and right
  click using each.
- **Maps and the camera.** `M` toggles the big map; the corner compass comes up while the phone is
  in a hand, and the phone's camera shoots photos into a twelve-photo gallery.
- **The button in Sydney Park.** A button on the second hill west of the kilns that makes the sun
  scream until sunset, for everyone on the server.
- **The fight.** A bat, a footy and fists — and the bat can swat a footy out of the air.
- **Night.** Street lights, car headlights, lit trains and a torch on `F`; the sky is on a real solar arc and the server owns the clock.

---

## Layout

```
pipeline/          Python, offline. Source data -> glTF world tiles.
  sydney/
    config.py      CRS, ENU origin, tile size, extent stages, disk budget
    geo.py         projection, the local ENU frame, tile and quadkey addressing
    ledger.py      SQLite job ledger -- makes every stage resumable
    sources/
      msbuildings.py   Microsoft ML footprints (quadkey-partitioned)
      osm.py           OSM extract: footprints, attributes, roads, POIs
    merge.py       unify the two footprint sources
    rows.py        cut terrace rows mapped as one polygon back into houses
    attributes.py  archetype classifier + height resolution  (spec 6.2)
    mesh.py        massing meshes + per-building facade parameters (spec 6.3)
    terrain.py     the DEM, the datum, and the ground surface everything drapes on
    streets.py     carriageway, kerb and footpath surfaces from OSM centrelines
    fences.py      front fences on the property line of every setback residential
                   frontage, with the gate gap aligned to the front door
    vegetation.py  park grass surfaces + tree instances (mapped, street, scattered)
    parking.py     parked cars along both kerbs, oriented for left-hand traffic
    power.py       timber poles down one side of a street, and the wires between
    furniture.py   wheelie bins, street-name blades, traffic signals  (spec 7.7)
    powerups.py    station entrances and cafes as pickup points, stood out of
                   the buildings OSM maps them inside  (spec 8.3)
    tiles.py       glTF emission, params buffer, instance sidecars, collision prisms
    cli.py         `python -m sydney build|status|reset|terrain-audit|winding-audit`

client/            TypeScript, Three.js WebGPU.
  src/
    sky/solar.ts   NOAA solar position + southern-hemisphere self-check (spec 7.1)
    sky/sky.ts     Preetham analytic sky, sun and shadow rig
    world/terrain.ts       the ground: sidecar, grid mesh, and the height query
    world/facade.ts        the facade material  (spec 6.4)
    world/awning.ts        the retail awning's signage fascia and its soffit
    world/fences.ts        front fences: rendered masonry, and two alpha-tested
                           picket styles whose gaps show the garden behind
    world/street.ts        asphalt, concrete and sandstone street materials
    world/vegetation.ts    six tree species, instanced per tile, and park grass
    world/cars.ts          five parked-car bodies, instanced per tile
    world/power.ts         power poles instanced, wires as merged catenary ribbons
    world/furniture.ts     wheelie bins, name blades and signal heads, instanced
    world/powerups.ts      the floating bolt and cup, and the three-pass trick
                           that shows them through a building  (spec 8.3)
    world/params-atlas.ts  one parameter texture for all resident tiles
    world/far.ts           the always-resident far layer: every significant
                           building as one box, and a coarse ground under it
    world/streamer.ts      tile streaming and runtime LOD  (spec 3.2)
    player/controller.ts   fixed-timestep FPS controller + self-check
    player/collision.ts    prism collision, decoded from the pipeline payload
    player/animation.ts    the 17-bone rig, the pose system, and every clip in 8.1
    player/character.ts    the procedural figure, seven kits, and the actor that
                           drives it -- plus the test dummy and the self shadow
    game/combat.ts         the punch, server-shaped: phases, hit test, knockback
    game/powerups.ts       spec 8.3's pickups, modifiers and respawns, on the
                           same terms -- pure, no three, no DOM
    game/dummies.ts        the local stub: three dummies and the pose driver
    game/audio.ts          every sound in the project, synthesised
    game/feedback.ts       shake, vignette, reticle, and the Flat White camera
    game/laser.ts          the raygun: hitscan, what stops it, what it does
    net/protocol.ts        every byte on the wire, both ends
    net/client.ts          prediction, reconciliation, snapshot interpolation
    world/laserbeam.ts     the held raygun prop and the world-space beam
    main.ts        wiring, render loop, dev handle on `window.sydney`

server/            TypeScript, Bun. The authority. Imports the six modules above.
  index.ts         the WebSocket server, the 60 Hz loop, snapshots and events
  sim.ts           the authoritative tick — `main.ts`'s own loop, three lines apart
  world.ts         collision prisms and terrain grids, read off the disk at boot
  rewind.ts        250 ms of position history and the interpolated lookup (spec 8.2)
  bots.ts          `game/dummies.ts`'s `think()`, which is all a bot needs to be
  integration-check.ts   two synthetic clients, one real server, no browser
```

---

## Decisions that departed from the spec, and why

**The transport is a WebSocket, not spec 10's WebTransport, and it is temporary.**
Spec 10's first line is *"Transport: WebTransport datagrams... **Requires HTTP/3 and a
valid TLS certificate — not optional**"*, and it is the right transport: TCP means a lost
packet holds up every packet behind it, which for a stream of snapshots that each
supersede the last is pure cost. What it also means is a **certificate for a real
hostname**, which is the pending remote-deployment step — neither `localhost` nor a LAN
address can have one. Blocking two browsers on this machine seeing each other behind a
certificate authority is the wrong order to do the work in.

So it is binary frames over a plain WebSocket, and the cost is exactly what spec 10 says
it is: on a loopback and on a LAN, unobservable; over the internet, the difference between
a 40 ms hiccup and a 200 ms one. What makes the swap cheap on the day the certificate
exists is that nothing above the socket knows what carries it. `NetTransport` in
`net/protocol.ts` is four members wide, `net/client.ts` speaks only to that, and every
message is already a self-contained frame with its type in the first byte — which is the
shape a datagram wants and a stream does not care about.

**Bandwidth stopped being a function of how many people are in the game, in protocol v8.**
Through v7 a snapshot carried every player to every client at 21 bytes each, which was
55 kbit/s at spec 2's sixteen (against spec 10's 30) and 432 kbit/s at a room of 128 —
measured at 1.92 Mbit/s per client with 500 players, and the wall the whole scaling pass
existed to remove. v8 sends each client only what it can see: everybody within 180 m (held
to 220 m so a boundary cannot flap), capped at the 40 nearest, at 22 bytes a player plus a
12-byte header. So the arithmetic is now about local density rather than population —
5 kbit/s alone in a street, 23 in a six-player fight, and a hard ceiling of 143 kbit/s
because nobody can stand next to more than forty people. Measured across a thousand
synthetic players: 133–199 kbit/s per client. Upstream is unchanged and was never close to
a constraint: 10 bytes at 60 Hz is 4.8 kbit/s. `verifyNet` asserts the ceiling so the note
above cannot go stale, and PERFORMANCE.md has the full measurement — including the part
where this page's own pre-measurement estimate of "~30 kbit/s typical" turned out to be
optimistic by four to six times.

**There is a laser, and spec 12 excludes guns by name.** *"Guns, gore, progression,
matchmaking, anti-cheat. Out of scope. It's a punching game for friends."* The raygun is
here **by direct user instruction**, and the exclusion is worth restating rather than
quietly dropping, because the reason behind it is a design argument — a melee game about
closing distance stops being one when range is free — and that argument does not go away
just because the weapon was asked for.

What is in `game/laser.ts` is shaped so the fists still decide fights, and every number is
that shaping rather than a taste: **one pip**, the same as a punch, so it cannot out-damage
the fist; **half the punch's knockback**, derived from `KNOCKBACK_HORIZONTAL` rather than
written down, so it pushes but does not throw and spec 8.2's 6–8 m stays the one spatial
constant a player learns; **three shots on a bar of its own** with a 1.5 s floor between
them and a 4 s refill, so spending them never costs you the punch you need when somebody
closes; and **90 m, blocked by buildings**, which in the inner suburbs means it works down
a street and nowhere else. The city is the balance.

The one place it departs from a literal reading of the spec in the *other* direction is
that spec 8.3's multipliers apply to it. 8.3 says "+40% **punch** damage" and a beam is not
a punch, so the literal reading exempts it — which would make a Flat White strictly better
than no powerup at all (all of the speed, none of the −20% where it counts) and give a
Training player a reason to switch weapons to dodge their own penalty. One rule for all
damage has no such seam.

**The server is the client's own simulation, running in a second process.**
`game/combat.ts` opened with three rules and a promise — *"a module that is going to be
lifted wholesale should be in its own directory from the first day"* — and this is the pass
that collected on it. `server/` imports `game/combat.ts`, `game/laser.ts`,
`game/powerups.ts`, `player/controller.ts`, `player/collision.ts`, `world/terrain.ts` and
`net/protocol.ts` **directly across the directory boundary**, and not one line of any of
them changed to make that work. What the server adds is a socket, a 60 Hz clock, a rewind
buffer and two bots; every gameplay decision it makes is made by a file the browser is also
running.

Two things make that claim checkable rather than aspirational. `verifyCombat`,
`verifyPowerups`, `verifyLaser` and `verifyNet` **run at server boot**, in Bun, off the same
source — so a shared module that acquired a browser dependency fails on startup rather than
three hours into a match. And `server/tsconfig.json` compiles the same ten files a second
time with **no `DOM` lib at all**, which turns "these modules are DOM-free" from a
convention into a compile error.

**`three/webgpu` imports cleanly under Bun with no DOM, so nothing was refactored.** This
was the one portability risk worth checking before designing anything, because the shared
modules import `Vector3` from `three/webgpu` and that bundle is 2.17 MB of node system and
TSL. Measured: it imports in 122 ms under Bun and 48 ms under Node 22, with `window` and
`document` both `undefined` and nothing touching `navigator` at module scope. It is also
worth recording *why* it could not have been a problem in the way it looked: `three/webgpu`
and `three` are two bundles that both re-export from `three.core.js`, so
`(await import('three/webgpu')).Vector3 === (await import('three')).Vector3` is **true** —
they are the same class object, not two compatible ones. Nothing needed to change, so
nothing did.

The one thing that *is* enforced is that **no file under `server/` imports three at all**.
Module resolution from `server/` would find a different copy than the shared modules find
from `client/src/`, which is a second `Vector3` class and two answers to every `instanceof`
in the shared code — a bug that appears only under one bundler. `server/sim.ts` takes a
freshly-allocated `HitReport` per hit rather than reusing one, which is a handful of
objects a second, to avoid needing the import.

**OSM is a footprint source, not just an attribute source.** The spec assigns footprints to
Microsoft and attributes to OSM. Measured against the real data that split fails exactly
where the game will be played: within 500 m of the CBD origin Microsoft's ML segmentation
finds **71** buildings, OSM finds **393**, with real surveyed heights on the towers
(Salesforce Tower at 263 m, 55 levels). Microsoft's advantage is the opposite end of the
extent — suburban sprawl nobody has hand-mapped. So OSM wins wherever it has a polygon and
Microsoft fills the gaps, resolved geometrically in `merge.py`. Result for the inner ring:
21,800 OSM + 7,990 Microsoft = 29,790 buildings, with 9,431 Microsoft duplicates dropped.

**Microsoft's ML `height` field is nearly useless and is treated as such.** The 2026 release
carries a per-polygon height. Across all of Greater Sydney it has a median of 4.5 m and a
maximum of 31 m — it is an eave height for low-rise and simply absent for anything tall. It
is used only for buildings under 24 m in archetypes that live in that range, and never for
anything the classifier thinks is mid-rise or above.

**The city stands on a DEM, and every surface is cut against it rather than
draped on it.** Elevation comes from AWS Terrain Tiles (Mapzen terrarium) at zoom
13 — free, no key, ~16 m a pixel, sixty PNGs for the whole extent. That is a
*surface* model over a city, not a bare-earth one, so raw it reports the tops of
buildings: the inner ring's road gradient comes out at 1:5.8 at p90, which is not
a city, it is the edges of buildings. A 60 m Gaussian is what separates the two
signals, and the width was chosen from a table measured along all 89,049 sample
points of the road network rather than by eye (`terrain.py`). The relief the whole
feature exists to produce is untouched by it — Crown Street stands 40 m over
Alexandria at every sigma from raw to 95 m.

The part worth copying is how the roads are put on it. A road draped by sampling
its existing vertices sinks 1.5 m into the ground at p99 and 17 m at worst,
because a 2D triangulation of a block of Botany Road is two triangles. Splitting
every triangle to 32 m costs 4.8x the geometry and still buries it by a metre;
splitting adaptively wherever the ground deviates by more than 2 cm costs 22x and
still misses by 32 cm. Cutting each surface against the terrain's own facets —
the ground is piecewise planar, so a piece inside one facet is exactly parallel
to it — costs 2.0x and the measured error is 0.03 mm, which is float32
quantisation and not error at all.

**Buildings sit on pads, not on the drape.** A real building is on levelled
ground, so a footprint gets one elevation at its centroid and the slope is
answered by cutting into the hill on the high side and by a buried skirt on the
low one. The skirt follows the footprint rather than being a constant: the ground
falls 0.49 m below the pad under the median building but 3.75 m at p99, so a fixed
1.5 m skirt would leave a hole under one building in eleven, where a
footprint-following one capped at 8 m closes 99.9%.

**PDAL and GDAL are not installed via Homebrew.** Homebrew's PDAL pulls a ~4 GB
LLVM/GCC/Boost build chain. The pipeline uses `laspy[lazrs]` for LAZ and `pyogrio` (which
bundles GDAL) for vector I/O — all pure wheels, all native arm64, no CUDA anywhere.

**Storey count substitutes for the missing `start_date` tag.** Only 138 buildings in the
15 km extent state a construction date, so the spec's era inference has almost nothing to
work from. Sydney's interwar flats and post-war walk-ups stop at four or five storeys
because neither had lifts, so a residential building of five storeys or more is post-1990
stock almost without exception. That rule is what populates the `modern_infill` archetype.

**The facade parameter atlas is a wide texture, not one building per row.** The natural
layout — 4 texels wide, one row per building — needs 65,536 rows, and WebGPU guarantees
`maxTextureDimension2D` of only 8192. The texture silently fails to create, every bind
group referencing it becomes invalid, and the renderer submits **no command buffers at
all**: a completely black scene, with validation errors that only ever name the downstream
bind group and never the cause. Buildings are packed linearly into a 2048-texel-wide
texture instead, and a startup check now compares the atlas against the device limit and
says so plainly if it is ever exceeded.

**The facade parallax is a single-step offset, not an occlusion march.** A multi-step march
was implemented and measured first. A `Loop` with a nested `If`, inlined across four
material outputs and nine material slots, produced shaders large enough that WebGPU
pipeline compilation blocked the main thread outright. One step is the right cost for
reveals of 3–35 cm; the reveal shading is what actually sells the depth.

---

## What is built

| Spec milestone | State |
|---|---|
| 1 · Footprints → massing tiles, inner ring | **Done.** 29,790 buildings, 221 tiles, 2.3 M triangles, on real terrain |
| 2 · LiDAR height + roof extraction | **Not started.** See below |
| 3 · Archetype classifier + facade grammar | **Classifier done**, ten archetypes; the grammar's last clause, spec 6.3's front door, is now in. Validation view not built (Mapillary skipped by request) |
| 4 · Facade shader, parallax windows, lit interiors | **Done.** Of spec 6.4's inside-80 m geometry the awnings are now real triangles at *every* distance; window reveals, balconies and sills are still shader-only |
| 5 · Sun, sky, materials, decals | **Sun and sky done and verified.** Materials are procedural, not yet trim sheets. Decals not started |
| 6 · Full extent, streaming, runtime LOD | **Streaming and LOD bands done.** Extent is stage 1; stage 2 is one command away |
| 7 · Player controller, character, animation | **Done.** Controller, plus a 440-triangle 17-bone procedural figure in seven kits, with every clip 8.1 asks for. No hit detection or ragdoll — those are 11 |
| 8 · **STOP — ask §9** | **Answered.** Bun, static tiles, no persistence — spec 9's own default |
| 9 · Server, transport, replication | **Done.** Two browsers see each other move. WebSocket rather than WebTransport — see below |
| 10 · Punch, knockback, ragdoll | **Done and now server-authoritative**, with spec 8.2's lag compensation against a 250 ms rewind |
| 11 · Powerups from OSM | **Done and now server-authoritative.** The client's field is a mirror online |
| 12 · Hero landmarks, audio, ibises, power lines, props | Audio, ibises, power lines and props are in. Hero landmarks are not |

Self-checks run before the renderer starts and refuse to boot on failure. All of them guard
bugs that are silent and expensive, and several caught real errors during development:

- `verifySouthernHemisphere()` — the sun must transit in the **north**, shadows must fall
  **south**, and it must rise in the east. It caught an inverted azimuth that had the sun
  rising in the west.
- `verifyMovementBasis()` — forward must move where the camera looks, at every yaw, and
  pitch must not affect it. It caught a friction term that annihilated all movement, and it
  exists because the previous attempt shipped with W always moving north.
- `verifyCombat()` — the 500 ms cycle, the 1.2 m reach, and 6–8 m of flight measured by
  integrating a real punch through the controller's own friction rather than a formula.
- `verifyNet()` — spec 10's quantisation and every layout in `net/protocol.ts`, round
  tripped. A quantiser off by a factor puts remote players at a fraction of their real
  distance from the origin, which draws a fight in Alexandria out in the harbour and
  throws nothing; a yaw that clamps instead of wrapping puts a player facing backwards for
  half of every turn; a layout one byte out turns health into a phase; and a sequence
  comparison that ignores the 16-bit wrap works perfectly for eighteen minutes. It also
  asserts the bandwidth figure above, so the README cannot go stale.
- `verifyLaser()` — that a beam is stopped by a building, reaches 60 m in the open, misses
  4 degrees off at 40 m, that the bar locks after three shots and refills in four seconds,
  and that the knockback really is half the punch's. The blocking test is the one that
  matters: `rayHit`'s wall solve has two divisions in it that return a plausible number for
  every input including the wrong ones, and a beam that goes through terraces reads as lag.
- `verifyNetClient()` — that replaying inputs from an acknowledged state lands exactly
  where a straight simulation does (which is the purity `controller.step` has been claiming
  since the day it was written), that a half-metre correction is taken by the simulation
  immediately and eased out of the camera over 80 ms, and that a knockback-sized one snaps
  *and takes the server's velocity* rather than being dragged across six metres at 20 Hz.
- `verifyRewind()` and `verifySim()`, on the server — that the ring returns interpolated
  historical positions, that both its clamps hold, and that a punch which misses with no
  rewind lands with one. The last is the whole of spec 8.2's lag compensation, asserted end
  to end through a real two-player fight.
- `verifyPowerups()` — spec 8.3's numbers, and above all that the speed modifier *reaches
  the integrator*. A powerup that chimes, lights a HUD chip, counts down for 45 s and does
  nothing has no failing frame; the check walks a combatant for a second and asserts the
  distance ratio. It also asserts the jump apex against 2×, because the square root that
  turns "+100% height" into a velocity multiplier is exactly the sort of thing that gets
  dropped and presents as a collision bug.

---

## What is not built, and what it needs

**LiDAR heights and roof forms (milestone 2) are the largest gap.** Every height in the
world right now comes from an OSM tag (29,224 buildings), Microsoft's ML estimate, or
inference from footprint area and distance from the CBD. Roof forms come from OSM
`roof:shape` where stated and the archetype default otherwise. The pipeline is built to
accept the real thing: `height_source` is recorded per building so a LiDAR pass overwrites
only the guesses, and `laspy` is already installed.

The blocker is acquisition. ELVIS (<https://elevation.fsdf.org.au/>) has no public API —
it is a draw-a-box web order that emails a download link, capped at 15 GB per order, and
Greater Sydney is many orders. Reverse-engineering its private API is the next thing to
try; if that needs a login, the fallback is generating the bbox list for manual ordering.

**Streets are geometry, and unmarked.** Every tile now carries a unioned
carriageway 0.02 m over the ground, a sandstone kerb stepping up to 0.15, and a footpath
band with the buildings subtracted out of it — 5.6 km² of road and 3.9 km² of footpath over
the inner ring, from OSM centrelines, all of it following the terrain to within float32.
What is not there yet: lane markings, stop bars and give-way triangles; crossings as
anything but plain concrete; and any notion of a *structure*, so a bridge deck still lies
on the ground it crosses rather than over it — OSM tags the layer, and nothing reads it.
Roads carry no collision of their own and need none — the kerb is 0.13 m against a 0.42 m
step height.

**Buildings now stand on the ground rather than resting against it.** Every footprint over
20 m² carries a baked contact-occlusion skirt: a flat black ribbon 0.9 m wide around the
outside of its walls, draped on the terrain 0.17 m up, with the wall's occlusion of the sky
baked into vertex alpha — 0.55 at the wall, nothing at the far edge. It is the only
translucent material in the world and the only geometry carrying `COLOR_0`, and it is drawn
unlit, because occlusion is the absence of light and a lit shadow is a contradiction. The
wall's half of the same gradient is a short deep toe inside the existing plinth curve in
`facade.ts`. What it costs is 816,352 triangles and 22.9 MB over the inner ring — a third
of the ring's triangles, though only ~78k of them in a dense nine-tile view, drawn by the
cheapest shader in the project and never entering the shadow pass. What it is not: a
contact shadow for trees, parked cars or anything else that touches the ground. Those are
the same idea and none of them is in yet.

**Rooflines are trimmed, and it is the most expensive small thing in the build.** Every
roofline used to terminate in a razor edge — no eave, no gutter line, no chimneys on a city
of pre-war housing, and a parapet that stopped in a bare top edge. All five elements are now
geometry in `mesh.build_roof`, deterministic per building from its id: pitched roofs
oversail their walls by 0.45 m with a 0.18 m painted fascia and a soffit closing the
underside (a gable takes barge boards on the rake instead, because a closed verge *is* the
closure); hips and gables carry a 120 mm capping roll along the ridge and, on a hip, along
all four hip lines; flat and parapet forms carry a 0.25 × 0.09 m capping band along the
footprint ring, painted render on the brick stock and precast on the concrete archetypes;
and 21,102 brick chimneys stand on the terrace, Federation and 30% of the interwar stock —
one per house on a terrace row slice, on the party wall, at a depth drawn from the row's
*parent* id so a street of them lines up rather than wandering.

It costs 1,394,538 triangles and 118 MB, which takes the inner ring from 3.11 M to 4.51 M
and from 174 MB to 292 MB. The parapet capping is 43% of that on its own, at four triangles
across 149,845 ring segments; the two mitigations already taken are that the capping's top
*falls* to the deck instead of running flat with a separate return down to it (one quad a
segment, 306k triangles), and that nothing above 60 m gets any of it. Hard-edged trim runs
at 85 bytes a triangle against the build's average of 56, because no two faces of a fascia,
a capping or a chimney share a normal and so none of them can share a vertex; this is the
strongest argument yet for the Draco pass the download section below already names.

What is not there: no aircon, plant or lift overruns on the flat commercial roofs (spec 6.3
asks for them and they are their own pass), no dormers, no vents, and nothing on a sawtooth.
The sawtooth was skipped deliberately — its teeth are emitted as coplanar strips of a single
skillion plane, because the vertical riser that makes a sawtooth a sawtooth has never been
emitted, so there is one eave in that geometry rather than one per tooth and any trim hung
on it would be built against a shape that is going to change.

**Half the city's walls were wound inside out, and nothing in the picture said so.**
`build_walls` emitted each quad with a winding of `(-dz, 0, dx)` and a stored normal of
`(dz, 0, -dx)` — exact negatives — so on every building one of the two was wrong, and which
one depended on the winding of the footprint the ring arrived with. Measured off the emitted
GLBs before the fix: **61% of buildings had every wall triangle facing inward**, and the
`brick_brown` slot, which is nothing but `brick_veneer` walls, had **zero** of its 58,172
triangles agreeing with its own normals. The pitched roof planes had it from a second cause —
`_plane_normal` forces the normal upward rather than following the winding, and the oriented
rectangle's corner order is inherited from wherever shapely started, so the two were
independent coin flips. Whole polygons of footpath were triangulated upside down for a third
reason again: `_conform` cuts each paved surface against the terrain facets and GEOS makes no
promise about which way an overlay result goes round.

**Nothing was reconciling it, and that is the part worth reading.** The expectation going in
was a `DoubleSide` somewhere, or three quietly ignoring the normals. Neither: `facade.ts`
never sets `side`, three's default is `FrontSide`, and `WebGPUPipelineUtils` compiles that
straight to `cullMode: 'back'`. Back-face culling has been on the whole time and doing exactly
what it says. What hid the damage is that a building's walls are a **closed prism**, and a
closed prism turned inside out does not leave a hole — the near walls cull and the far walls,
whose front faces now point back at you, are drawn in their place. The silhouette stays
filled, the roof cap is unaffected (its normal is forced up and its winding is independent of
the ring), and on the 12,946 buildings big enough to carry one, `far.ts`'s always-resident
slab is sitting inside the shell as well. So the city looked like a city. What you were
actually looking at on 61% of it was the inside of the back wall, at the back wall's depth,
and on the other 39% the correct wall lit by an inward normal.

The fix is one invariant and one derivation. `merge.orient_footprint` puts every footprint
counter-clockwise in ENU with its holes clockwise, at `Building` construction, on both source
paths, on `rows.py`'s slices and on the round trip back out of the `buildings` table — so
"outward is the right of travel" is true by construction rather than measured in five places,
which is what `contact._outward_ring`, `mesh._ccw_ring` and `DoorNetwork._prepare` were each
doing separately. `build_walls` then derives the outward normal instead of asserting one, and
the derivation is worth stating because the obvious version of it gives the opposite sign.
ENU-to-renderer is `(e, n, u) -> (e, u, -n)`, which on the **plan** is a mirror — plot x right
and z up and every footprint comes out reversed — but in **3-space** is a −90° rotation about
x with determinant +1, so it preserves handedness and a cross product passes through it
untouched. Outward `(dn, -de)` in ENU is therefore `(-dz, dx)` in the renderer, and the quad
order `build_walls` already used winds to exactly that vector. The whole change is one sign.

Everything else was swept the same way. `_triangulate` orients its rings before ear-clipping,
which fixes flat roof caps, carriageways, footpaths and park lawns in one place; the roof
planes and the hip ends go through `_add_face`/`_add_tri` like the roofline trim already did;
a gable end takes `±axis_long` as its normal, because `_plane_normal` forces `y >= 0` and a
vertical face has `y = 0`, so that helper was picking nothing for them. `_add_face` now tests
**both** of the triangles a quad splits into rather than the first — a parapet capping's
mitred inner edge ties itself in a bow at a spike corner, and 44 faces in the ring were
inverted inside an emitter whose whole job is to prevent that.

`sydney winding-audit` is what keeps it fixed. It reads the shipped GLBs and nothing else,
counts agreement per material slot, and reports **two** columns, because a smooth-shaded face
and an inverted one are different objects: *agreeing* is the face against the mean of its
three vertex normals, *inside out* is a face that disagrees with all three and therefore has
no point on it shaded front-side. It also drops any triangle thinner than one float32 ulp of
its own coordinates, which is not a tuned threshold but the precision the positions ship at —
the ear clipper leaves slivers along every terrain-facet cut, and a triangle four microns wide
at 250 m from the tile origin has a cross product made entirely of its own rounding. The
separation is three orders of magnitude wide: every ground-surface disagreement measured under
0.77 ulp and every genuinely inverted trim face over 290.

| slot | triangles | before | after |
|---|---:|---:|---:|
| `brick_red` | 427,278 | 63.3% | **100%** |
| `brick_cream` | 181,728 | 66.3% | **100%** |
| `brick_brown` | 58,172 | 0.0% | **100%** |
| `sandstone` | 13,188 | 0.0% | **100%** |
| `concrete_precast` | 178,424 | 71.5% | **100%** |
| `curtain_wall` | 6,840 | 0.0% | **100%** |
| `corrugated_steel` | 9,338 | 0.0% | **100%** |
| `render_painted` | 778,129 | 86.2% | **100%** |
| `fibro` | 23,572 | 0.0% | **100%** |
| `roof_terracotta` | 306,821 | 81.3% | **100%** |
| `roof_steel` | 112,995 | 84.4% | **100%** |
| `road_asphalt` | 205,185 | 99.89% | **100%** |
| `footpath_concrete` | 559,128 | 99.83% | **100%** |
| `kerb_sandstone` | 783,373 | 99.94% | **100%** |
| `park_grass` | 55,338 | 100% | **100%** |
| `awning_fascia`, three fence slots | 428,600 | 100% | **100%** |
| **all** | **4,128,109** | **86.4%** | **100.00%**, 0 inside out |

(The before column is over a 40-tile sample and the after over all 221; the wall slots' before
figures are diluted by the roofline trim sharing their buckets, which is why none of them
reads 0% except the four that are nothing but wall.) Verified a second way, independent of the
audit: 12,128 of 12,128 wall quads on eight tiles have their stored normal pointing out of
their own footprint, by point-in-polygon against the source ring. The whole pass is
triangle-neutral — 4,962,353 to 4,950,709, and 327.2 MB to 326.3 MB.

**The side flip was on the contact skirt, and it was worth more than the walls.** The walls
needed no client change at all: they were already `FrontSide` and already culled, they were
simply culling the wrong half. The skirt was the opposite — `contact.ts` set `DoubleSide` on a
material that is also `transparent`, and three renders `transparent && DoubleSide &&
!forceSinglePass` in **two passes**, `BackSide` then `FrontSide` (`Renderer.js`). The largest
slot in the build, 816,352 triangles over the inner ring, was being rasterised twice and
compiling two pipelines to do it. It is `FrontSide` now, which is safe because the ribbon's
winding is guaranteed rather than hoped for: 99.29% of it is up-facing, and the 0.71% that is
not is the bow-tie `contact._outer` documents at reflex corners, where the outer rail crosses
itself and lays the same patch of ground down twice with opposite winding. Culling one half of
that is the doubled alpha going away, not a hole.

Two things are knowingly left. `kerb_sandstone` has **2** faces in 4.13 M whose interpolated
normal crosses behind their own plane, at carriageway rings that double back on themselves;
the strip is wound correctly, so nothing is missing, and the real fix is a split vertex — a
hard edge — which is a different pass. Widening the existing spike test instead was tried and
is much worse: a vertex serves the segment arriving at it as well as the one leaving, so
handing it the outgoing normal fixes one side by breaking the other, and at a 120° threshold
the audit went from 2 bad faces to 4,690. And `power.ts`'s `PoleBuilder.box` is still wound
inside out, as noted below — it is client-side geometry that this pipeline audit cannot see.

**The retail strips have awnings, and they are the cheapest recognition in the build
after the power lines.** Spec 6.3's ground-floor override asks for a "continuous awning
at 3.2 m" and 7.7 for "continuous cantilevered awnings over the footpath on every retail
strip". Until now the only thing standing in for either was a painted band on the wall,
which is a *picture* of an awning: it throws no shadow, it has no underside, and the
footpath under it was lit exactly like the middle of the road.

6,331 runs now hang off 3,613 buildings — 78,433 m of continuous canopy over the inner
ring, at 10 triangles a run for 63,310 triangles and 4.8 MB, which is 1.4% of the build.
A run is a 450 mm slab cantilevered 2.6 m off one street-facing wall edge: top face,
soffit, a 450 mm signage fascia on the outer edge and a cap at each end, closed, with no
interior face because the fascia's depth *is* the slab's thickness. No posts and no tie
rods — a Sydney awning is cantilevered, and the rods that really do brace it back to the
facade would cost more than the awning.

Nothing joins them and nothing needs to: each building emits the full length of its own
frontage and adjacency does the rest, which is exactly how a shopping strip is built.
They enter **no collision** — the payload is still the building prisms — so a player can
jump through one today, and whether an awning should be standable is a gameplay decision
nobody has made.

Three things are worth stating because each was arrived at against an obvious alternative:

- **A distance test alone puts awnings on party walls, and it is not close.** The street
  in front of a 12 m deep terrace is nearer to the middle of its *side* wall than the 9 m
  qualifying radius, so proximity passes every internal wall in a row. What separates them
  is that the road lies at 90 degrees to a party wall's outward normal and dead ahead of
  the front wall's, so an edge also has to find the carriageway inside a 50 degree cone of
  its own outward normal. With both tests, 6,331 of 28,886 edges qualify — 22%, or about
  1.8 frontages per shop, which is what a corner-heavy retail strip has.
- **Laneways are carriageways and are not streets.** Measured over the four densest retail
  tiles before the exclusion went in, OSM's `service` class — laneways and driveways — was
  qualifying a fifth of all runs, on the *back* walls of shops. A Sydney shop's rear wall on
  a lane has a loading hood at most, and two 2.6 m canopies across a 3 m lane very nearly
  touch. `parking.py` and `power.py` already make the same call from their own directions.
- **The soffit could not go on `render_painted`, and finding out why is the reason this
  pass took as long as it did.** The wall pipelines read UV `v` as height above the pad,
  and a soffit at v = 3.2 on a retail building — ground storey 4.2 m, shopfront sill 0.35,
  head 3.45 — is *inside the shopfront opening*. Every awning in the city would have grown
  plate glass on its underside. World-XZ UVs close the window field the way the flat roof
  caps already do, but then the plinth, the contact toe and the soiling ramp all bottom out
  together and multiply to 0.503, so the soffit arrives at half the albedo of the wall
  beside it because three unrelated gradients ran off their bottom ends at once; and
  `concrete_precast`, which does have a normal-gated flat path, gates it on
  `smoothstep(0.55, 0.80, normalWorld.y)` and a soffit's normal is (0, −1, 0). So the
  soffit went on the fascia's own new slot, where a normal tells the two apart exactly.

The top face went on `roof_steel` rather than the `corrugated_steel` *wall* slot it was
specified against, and that is the same investigation from the other end: the ribs, the
762 mm per-sheet variation, the fixing rows and the gutter line all live in
`finishSteelRoof`, which serves `roof_steel` alone. The awning's UV `v` is measured from
its **outer** edge inward, which is backwards from everything else here and deliberate —
that shader puts its gutter line at v in [0.06, 0.30] and its rain-wash gradient over
[0.15, 2.6], both from the eave, and an awning's eave is its outer edge and its projection
is 2.6 m exactly. The sheets come out running from the wall to the fascia, which is how an
awning is sheeted.

`awning_fascia` is the seventeenth material slot and the only one whose colour is per
**shop** rather than per building: canopies on adjacent titles merge into one run, and the
paint on the front of that run changes at shopfront widths that have nothing to do with
where one building ends. So it reads no parameter atlas and carries no `_BLDIDX` at all —
the ground colour is a hash of world position on an 8 m lattice, drawn from six muted
signage tones, with a lettering band across half of them and **no text**, because what
survives at 450 mm across a street is a band of lettering and not letters. The spread is
the point: in shade the six run from Y' 8 on black to Y' 141 on cream, against the walls'
34 code values of compression in full sun, and that contrast is most of why a shopping
street reads as shops.

What is not there: no per-shop text or logos, no barber poles or projecting blade signs,
no roller shutters, and no under-awning lighting, which is what a retail strip actually
looks like after dark. The soffit renders at rgb(67, 55, 31), Y' 56 — identical to the
eave soffits the roofline pass already emits, and for the same reason: the light rig gives
a down-facing surface only `GROUND_FILL`, because `BOUNCE_ALTITUDE` puts the bounce light
16 degrees *above* the horizon where a soffit can never see it. A real awning's dominant
illuminant is the sunlit footpath a metre below it. A ground-bounce term aimed up would
lift every soffit, balcony underside and eave in the world together, which is a light-rig
change and belongs in `sky/calibration.ts`, not in one material.

**Every house and every shop now has a front door, and it is one float.** Spec 6.3's last
line — *"Openings. Front door placed on the street-facing edge, at the bay nearest the
footprint centroid"* — was the only clause of the grammar with nothing behind it. The city
had windows everywhere and no way into any of it, which is the kind of absence nobody names
and everybody feels: a terrace row reads as a row of *houses* because of the repeating
door-window rhythm at street level, and without the door it is a wall with holes in it. The
pipeline cut terrace rows into individual houses two passes ago; this is what makes that
visible from the footpath.

29,901 of the inner ring's 33,844 buildings carry one. **No geometry was emitted for any of
them.** The whole feature is a single number in the facade parameter record — where the door
stands, as metres along the perimeter in the same `u` the wall UVs already carry — and the
shader builds the rest out of parameters it already had: the leaf width and head height from
the retail flag, the fanlight from the archetype index, the paint from the seed.

Four things are worth stating, because each was arrived at against an obvious alternative.

- **The `u` has to come out of `build_walls`' own walk, and that is now enforced rather than
  hoped for.** `build_walls` skips segments under 50 mm and accumulates `u` only over the
  ones it emits, so a footprint carrying a 30 mm noise vertex — which is most hand-mapped
  OSM terraces — accumulates a *shorter* perimeter than its coordinates suggest, and every
  edge after the noise sits at a different `u` than a naive re-walk would put it at. A door
  placed by a second walk lands metres from where it was aimed on exactly those footprints.
  The wall quads and the door placement now come out of one generator, `mesh._wall_runs`, so
  the two cannot disagree.
- **A laneway is not an address for an awning and *is* one for a door.** The first version
  borrowed `AWNING_EXCLUDE_CLASSES` wholesale, and it was wrong at scale: 2,504 terraces —
  23% of them — came back with no street-facing edge at all, and the footprints say plainly
  why. Their front elevations stand two to four metres off a way OSM tags `service`, dead
  ahead at a cosine over 0.97. The Rocks, Millers Point, the small courts off Paddington and
  Surry Hills. So the search is two-tier rather than one filtered pass: a proper street wins
  if the building fronts one, and only a building that fronts no street at all takes its
  lane. That ordering is what stops a terrace with a 6 m frontage and a 3 m rear lane getting
  its front door out the back, which is what simply deleting the exclusion would have done.
  85% of doors land on a street, 8% on a lane, 7% rear-lot.
- **Nearest street wins, not longest frontage** — and that choice is what makes the 20 m kerb
  limit safe. A corner terrace's 12 m side wall qualifies off the cross street and its 5 m
  front wall off the street it is addressed on, so "longest" would put the door round the
  side of every corner house in the inner west. Because the pick is the *nearest* qualifying
  street, widening the reach can only admit buildings that had no answer; it can never
  re-decide one that did. Measured directly: zero of 24,574 buildings changed edge between a
  15 m limit and a 40 m one, while the share left with no street-facing edge ran 14.8% at
  12 m, 10.4% at 15 and 7.0% at 20.
- **It took the last genuinely spare float in the parameter record, and "spare" here is
  structural rather than "nothing reads it yet".** Texel 2 slot 3 held the building's
  material index, which the shader could never use: a fragment's material *is the pipeline it
  is compiled into*, with the slot's albedo, roughness and branch set baked in at graph-build
  time. The two places the build really does need a material index — the glTF primitive's own
  `material` field and the far layer's per-slab byte — both carry their own. The alternative
  was extending `PARAMS_STRIDE`, and that is worse than it looks: four texels divides 2048,
  which is what keeps a building's texels off a row boundary and the shader's index
  arithmetic down to a mask and a shift, where five texels divides no power of two and eight
  would double both the atlas and every `.params.bin` in the build to carry one number.

What the shader draws is a 1.0 m opening with a 90 mm architrave inside it, which leaves a
leaf 820 mm wide — the Australian standard door leaf exactly, and not aimed at: it is what a
metre of opening with a lambs-tongue moulding leaves — standing 1.95 m from its threshold to
the underside of the head architrave. Four sunk panels, a
recessed leaf shaded rather than parallaxed (it is joinery, and joinery stands at the wall
plane), a 60 mm threshold step, and on terraces and Federation houses a 340 mm fanlight over
a 70 mm transom bar. Paint is one of six heritage tones — greens, blacks, oxide reds, navy,
cream, stained cedar — off a fourth per-building roll whose independence was measured over
all 65,536 seeds the way the existing three were.

The two failure directions are both covered and they are opposite. A dark door on brick is
carried by *value*: heritage green at Y′ 65 against red brick at Y′ 105 in sun, 28 against 50
in shade, which clears this project's "dozen code values a viewer stops resolving at
distance" bar three times over. A cream door on painted render is not — 10 code values in sun,
because the tone curve compresses everything over rho 0.42 — and what carries that one is
*structure*: the reveal shading at the leaf edge (Y′ 180 against the architrave's 244), the
panel grooves (190) and the threshold (183). Which is how a white door on a white wall reads
in a photograph. At night the leaf emits nothing and is a silhouette at rgb(1, 1, 2) against
brick at rgb(5, 1, 0), while the fanlight joins the lit-window lottery on literally the same
roll of the same cell — a lit one lands at rgb(179, 152, 111) against the lit window above it
at rgb(192, 164, 121).

What is not there: no door geometry, no porches, steps or verandah posts, no house numbers,
no letterboxes, and no roller doors — a warehouse's opening is a different object with a
different module and it is skipped deliberately, along with the towers and brutalist offices
whose glazed lobbies the shopfront override already draws better. 2,075 doors are placed
rear-lot on the longest edge, and on a terrace slice the longest edge is a party wall, so
those are doors between houses; fixing it properly needs a party-wall test, which is a
neighbour query per edge and its own pass. 848 sit off the bay grid on an edge too short to
hold a bay centre, which leaves a narrow sidelight of glazing beside the architrave.

**This pass changed the parameter record, so it needs `--retile`.** A tile emitted before it
carries a material index where the door position now goes, and material index 7 is a door
seven metres along the wall.

**Vegetation is in, without its far LOD.** 33,467 trees over the inner ring in six species
— Moreton Bay fig, plane, jacaranda, paperbark, brush box, eucalypt — plus 585 ha of park
grass as its own material slot at y=0.01. About 12,000 of the trees are surveyed OSM
`natural=tree` nodes at their real positions; the rest are placed along the verge of
streets OSM has *not* mapped, at 12–18 m with a third of the positions dropped, and
scattered thinly through park interiors. They stream and dispose with their tile as
instanced meshes, four or so draw calls per tile, and cast into the sun's shadow volume on
the same distances the buildings use.

What is not there: the billboard impostor spec 7.5 asks for beyond 150 m. At 64–162
triangles a tree that was not needed to ship this, but the spawn view carries 5,519 trees
in 483k triangles against the buildings' 232k, so it is the next thing this feature needs
and the seam for it is documented in `vegetation.ts`. Also absent: `natural=tree_row` ways
(169 of them) and a palm species — 184 palms are tagged in the inner ring and currently
render as paperbarks, which is the closest of the six silhouettes.

**The canopies now move**, which the vegetation pass had ruled out on the grounds that a
vertex offset applied only in the main pass detaches every shadow in the city from the tree
casting it. That is true of a hand-written depth material and it is **not** true of three
r185's WebGPU path, which was read rather than assumed: the shadow pass sets
`scene.overrideMaterial` to a shared bare `NodeMaterial`, and `Renderer.renderObject` copies
the source material's `positionNode` onto it before every draw — and `_getShadowNodes`
states the contract outright by taking `castShadowPositionNode` *if it exists and falling
back to `positionNode` if it does not*. A dedicated override for the shadow pass only makes
sense if the ordinary node is what that pass uses by default. Two things that would have
produced the same detached-shadow symptom by another route were checked as well: the render
object's cache key does fold `positionNode` in, so trees and buildings cannot share a shadow
shader, and `time` updates exactly once per animation frame, so a leaf and its shadow cannot
be a frame out of phase.

What it is, is 6.2 cm of travel at the crown of an 18 m fig — a 10-second swell with a
2.6-second gust over it and a slower cross-axis term, so the crown traces a figure rather
than sliding along a line. The gate is `smoothstep(4, 10, y)` **squared** on the *geometry*
attribute rather than on `positionLocal`, and that distinction is the one trap in the whole
thing: three applies the instance matrix to `positionLocal` before a `positionNode` runs, so
by then its y is height above the tile origin with the terrain in it, not height above the
trunk. Squaring is the cantilever, and it leaves every trunk under a centimetre except a
gum's leader at 9 m, which gets 5 cm and should.

**Parked cars line the kerbs, and they face the right way.** 23,020 of them over the
inner ring in five bodies — sedan, hatch, SUV, ute, van, weighted the way a 2026
Australian kerb actually is at 35% SUV — parked in bays every 6 m against both kerbs of
the classes people park on, and never on a motorway, trunk, primary or laneway. Spec 7.7
asks for "left-hand traffic with parked cars facing accordingly", so cars on the left
kerb face with the way and cars on the right kerb face back down it, with 4% parked the
wrong way as in life. That is a *sign*, and a sign is exactly the kind of thing that
stays wrong for months because a right-hand-traffic city has the same car count, spacing
and colours — so it is counted rather than asserted, at build time and again by an
audit that reads only the emitted sidecars: 96.1% have the kerb on their left and the
remaining 3.9% are precisely the deliberate wrong-way ones.

Occupancy is generated as *runs* — two to five occupied bays, then a gap — rather than
as an independent roll per bay, because independent rolls at any rate produce an even
stipple that reads as noise from any distance where runs read as a street. They stream
and dispose with their tile as five instanced meshes at 102–110 triangles each — the
spawn view carries 3,759 cars in 398k triangles and 140 instanced draws, against the
5,914 trees and 520k triangles already in the same frame — cast into the sun's shadow
volume on the same distances the buildings use, and carry **no collision**: the payload
is still exactly the building prisms, and whether a parked car is solid is a gameplay
decision nobody has made yet.

What is not there: any moving traffic, number plates or badges, and — the one that
shows — driveways. Nothing in OSM maps them at the completeness this would need, so
every metre of kerb counts as a bay. The nominal fill rates are set low (32% on
residential, 19% on tertiary and secondary) to absorb that, which is also what holds
the per-tile median at 110 cars and keeps the busiest tile off the 300 ceiling.

**Power lines run down the inner suburbs, and the wires are the point.** 7,330
timber poles and 4,909 wire spans over the inner ring, on one side of every
residential, unclassified, living-street and tertiary way — the side chosen by
way-id hash, because a real Australian LV run is single-sided and always-left
reads as a rule rather than as a network. Poles stand at 35–45 m on the footpath
0.4 m behind the kerb face, which is `half_width + KERB_WIDTH + 0.4` taken from
`streets.py` rather than re-derived, and they are 9.5–11.5 m with a 1.8 m
crossarm and a pole-mount transformer on 6.6% of them.

Spec 7.2 calls this the highest recognition-per-triangle feature in the project
and the measurement agrees: a median tile carries 37 poles and 25 spans for
3,400 triangles of pole and 1,800 of wire, in two or three draw calls, against
the 40,000 triangles of trees already in the same tile. The whole ring's power
sidecars are 260 kB.

Four things about it are worth stating because each was arrived at against an
obvious alternative that does not work:

- **A tree moves a pole; it does not delete one.** A street tree stands at
  `half_width + KERB_WIDTH + 1.0` and a pole at `+ 0.4`, so the two are 0.6 m
  apart across the footpath *by construction* and a 2 m keep-out is really a test
  of how close they are along the street — which fires on about one candidate in
  six. Deleting those opens 80 m gaps, and an 80 m gap breaks the chain and
  leaves a hole in the line. So `_place` shifts the pole up to 4 m along the
  street first and only gives up if the whole window is blocked: 1,383 poles
  shifted, and **4** in the entire ring were lost to a tree.
- **The parked-car keep-out is a no-op and is kept anyway.** A pole is at
  `half_width + 0.55` and a car's centreline at `half_width − 1.05`, so a pole is
  always at least 1.60 m from any car on its own kerb: no radius under 1.6 can
  fire and any radius over it deletes every pole on every parked street. The test
  is the oriented box against the car's *body* instead, which measured zero drops
  over the ring — which is the correct answer, and it is now the thing that
  catches a future change to either offset.
- **A wire span belongs to the tile containing its midpoint**, with absolute
  endpoints, one of which is routinely up to 30 m into the tile next door. 4.8%
  of endpoints are cross-seam. Filing by endpoint instead emits a span twice or
  not at all depending on which way the test rounds, and clipping at the boundary
  would make the client stitch two half-catenaries back into one curve.
- **The CBD gets none of it.** Sydney's tower district was undergrounded before
  the war, and OSM tags most of the CBD grid `unclassified` and `tertiary` — left
  alone, this module put 46 poles down Hunter, Bligh, Castlereagh and Phillip
  Streets. A 1,300 m circle on Town Hall stands in for Ausgrid's undergrounding
  footprint: it reaches Circular Quay and Central and stops short of Surry Hills,
  Darlinghurst, Chippendale and Redfern, which are the suburbs the feature exists
  for. It costs the northern tip of Surry Hills and Woolloomooloo, which do have
  overhead in life.

Client-side the wires are **not** `LineSegments`, and not for taste: WebGPU line
primitives are one pixel wide and this renders at 0.75 scale, so a wire would
shimmer and vanish. Each catenary is a *cross* of two 35 mm ribbons at right
angles — a single flat ribbon is invisible edge-on, and which edge-on depends on
whether you are in the street or above it — sampled at 9 segments with sag
scaling as the square of the span. 36 triangles a catenary, 72 a span. The
material is unlit near-black, rgb(7,11,18) against a 3 pm sky at rgb(196,221,245),
because a *lit* horizontal ribbon catches 0.84 of the direct beam and every wire
in the city renders as a bright white line.

What is not there: **no cross-junction continuity.** OSM splits a way at almost
every junction, so a chain is one block long and averages 2.6 spans; the line
stops at the corner and starts again on the other side. Joining them needs ways
matched end to end by name and class *and* a side choice that is consistent along
a named street rather than per way, and the two have to land together or a joined
chain crosses the road diagonally at every corner. Also absent: service drops to
houses, stay wires at terminations, street lights (different furniture), tram
wires, and any collision — a pole is a 0.32 m cylinder in the middle of a
footpath and is a good candidate for the collision payload, but that payload is
the building prisms and changing it is a server change.

**And ibises.** Spec 7.7 ends on the only sentence in the document marked non-negotiable —
*"And ibises. Non-negotiable. Idle animation, scatter near bins and parks, flee on
approach"* — and the city until now was perfectly still, which reads as a render rather than
a place. 693 ibises stand over the inner ring on 180 of its 221 tiles, plus four flocks of
five to nine gulls wheeling overhead at any moment. All of it is **client-side**: not one
byte of pipeline output changed, because the tile already knew everything needed to place a
bird.

Where they stand is the part worth stating. The pipeline scatters Moreton Bay figs and
eucalypts through park interiors and every other species along a street verge, so *a tile
with figs in it is a tile with parkland in it* without anything having to say so — and it is
ecologically exact rather than merely convenient, because Sydney's white ibis colonised the
fig parks. Positions are a hash-derived 3–12 m off a fig or a gum in the tile's own
already-decoded `.veg.bin`. The "near bins" half of the clause resolves to the
`awning_fascia` primitive in the tile's GLB, since bins are street furniture and street
furniture is a different project, but an awning marks the retail strip the bins would be on
exactly — 400 triangles is 40 runs, which admits 41 tiles. A spawn is checked against the
collision prisms the first time it comes close enough to be simulated, and pulled onto free
ground or hidden; over a synthetic terrace row 35 of 37 birds that landed in a wall were
rescued and 2 hidden, with none left inside.

Behaviour is four states and no bones: stalk at 0.15–0.4 m/s inside a 2.6 m patch, pause,
peck — the whole bird pitches nose-down 31 degrees, dropping the bill from 0.54 m to 0.26 —
and flee at 3 m/s for 8–15 m when the player comes within 4 m, re-homing where it stops so a
chased ibis does not walk back. The waddle is 7 degrees of yaw and 4 of roll a quarter cycle
apart, on a phase that advances with *distance walked* rather than time, so it stays in step
at any speed and stops dead when the bird does. 146 triangles each, one draw call a tile,
one shared material with the gulls. Only the birds inside 150 m are simulated — at that
range an ibis is under two pixels, so the rest freeze invisibly: 150 birds all inside the
radius cost **0.024 ms** a frame, against a 0.5 ms budget, and the frame that actually
happens is a tenth of that.

The gulls are one draw call for the whole sky and the animation is a **bank, not a flap**,
which is a measurement rather than a shortcut. A gull on a 25 m orbit is six pixels across at
200 m; a wing morph is a change of a pixel or two *inside* that silhouette, where a roll
changes the whole silhouette and swaps which face you see — the top at rgb(243, 246, 251) or
the underside at rgb(73, 62, 40), because a down-facing surface in this rig sees only
`GROUND_FILL`. That is a 180-code-value flash on a six-pixel object, twice a circuit, and it
costs nothing: the roll goes into an instance matrix being composed for the orbit anyway. The
bank angle is `atan(v²/rg)`, the turn the orbit implies. Flocks respawn on a ring 240–400 m
out and fade in over two seconds by *scale*, so what appears is a sub-pixel dot swelling to
four.

The white is the number the whole thing rests on. An ibis is a white bird on a grey city and
the failure mode is grey plastic, so at rho 0.74 its back in sun lands at rgb(250, 251, 250)
against the sunlit footpath's rgb(247, 248, 246) — brighter than the brightest surface in the
street, which is correct — and the flank at N·L 0.45 is still rgb(242, 246, 248), so the
whole sunlit side sits inside nine code values of white and the *shape* is carried by the
black bill at rgb(89, 88, 93). In the shade of a fig the body holds rgb(148, 164, 181)
against shaded asphalt's rgb(24, 40, 59).

What is not there: no flight, no landing, no take-off — an ibis that flees runs, which is
what they mostly do; no calls or wingbeats, because there is no audio in the project at all;
and no roosting, so they stalk a park at 3 pm and would still be stalking it at midnight.
There are bins for them to be at now — see below — but nothing connects the two: an ibis is
placed off a fig or an awning and has never heard of `.furn.bin`.

**The bins are out, the corners are named, and the lights are on.** Spec 7.7's street
furniture list had three items in it that nothing had touched: "red/yellow/green wheelie
bins on kerbs", "AS 1742 signage with white-on-green street name blades", and — implied by
every intersection in the city — traffic signals. All three are now in `furniture.py` and
`furniture.ts`, at **6,863 bins in 3,624 clusters, 2,406 name posts carrying 4,812 blades,
and 1,305 signal heads at 352 signalised intersections**. The whole ring's furniture
sidecars are 218 kB and a median tile carries 35 bins, 13 posts and 9 heads for about 2,600
triangles, against the 40,000 of trees already in the same tile. Two draw calls on a
residential street; six on the rare tile that has bins, a named corner and a signalised
crossing at once.

Architecturally it is `power.py` again — kerb-line placement, shift-don't-drop keep-outs, a
per-tile sidecar, deterministic hashing — and the five things worth stating are the ones
where it is not.

- **Bin day is a property of the street, not of the house.** The obvious rule, a die per
  candidate position, produces an even stipple of bins over a whole suburb, which is the
  failure `parking.py` measures at length for parked cars and it is worse here, because bin
  collection genuinely is correlated: a council runs one zone a weekday, so a street either
  has bins out or it does not. The roll is therefore per *way* — 35% of the bin-class ways
  have collection today — and the positions on a bin-day street are then filled at 80%.
  The net rate is 0.28, close to the third a per-position roll would have given, and what
  it buys is that the third is clustered by street. So is the *stream*: yellow and green
  alternate fortnightly across a whole zone, so a street on its yellow week has yellow bins
  out and no green ones, and what you walk past is a run of red-and-yellow pairs with the
  occasional three where a household missed a fortnight. 3,624 clusters average **1.89
  bins**.
- **A bin stands exactly where a pole does, and that is why the keep-out shifts.**
  `BIN_KERB_SETBACK` puts a bin's centre 0.55 m behind the kerb face and `power.KERB_SETBACK`
  puts a pole's at 0.55 m too, so the two are on one line *by construction* and the 1.2 m
  clearance is a pure test of how close they are along the street. Measured: 633 clusters
  shifted along the kerb to clear something and **6 in the whole ring were lost** to a pole
  or a tree. The test that actually deletes things is the frontage one — 1,554 candidates
  had no terrace, Federation, walk-up or brick-veneer house within 25 m, which is a tertiary
  road through an industrial block and is the right answer.
- **OSM gives centrelines, not intersections, and deriving them takes three rules.** A way
  *end* is not a junction — OSM splits a way wherever the name or the speed limit changes,
  so a third of ends are mid-block continuations, and what separates them is the number of
  directions a street leaves in: two for a continuation or a bend, three for a T, four for a
  cross. A junction is not always a way end either — a street OSM did not split at a side
  road contributes no endpoint there at all, so the legs are counted from every centreline
  passing within 2.5 m, with a way passing *through* contributing two. And a divided road is
  one intersection across several way ends: 12,766 candidate points become 3,358 with three
  or more legs, and merging within 12 m takes 551 more off that.
- **The blade post goes on the north-east corner, and the reason is the sun.** "The corner
  with the widest footpath" is the intuitive rule and it is worse: it needs a footpath width
  per leg, it ties on two legs of the same class, and the tie-break is then arbitrary. The
  corners are ranked by `east + north` and the first one clear of a building wins. It is a
  pure function of the geometry, so it cannot disagree with itself between runs — but the
  real argument is that Sydney is at −33.9 degrees and the sun transits *north* of the
  zenith every day of the year, so the north-east corner is the one lit from mid-morning to
  mid-afternoon. This whole feature is colour and proportion at fifty metres, and the same
  blade on the shaded south-west corner is a dark rectangle.
- **The signals come from OSM's own nodes, and a rule based on road class would have missed
  two thirds of them.** `highway=traffic_signals` turns out to be mapped thoroughly — 1,547
  nodes in the inner ring — but mapped **per approach**, at the stop line 10–20 m back from
  the middle, so the nodes are clustered at 35 m into 445 intersections and each cluster
  attached to the nearest derived junction. 352 junctions come out signalised, of which only
  **130** would have qualified under "both ways tertiary or larger": Sydney signalises
  plenty of residential crossings and leaves plenty of tertiary ones on give-way. The 91
  clusters with no three-leg junction near them are mid-block pedestrian signals, which are
  different furniture and are counted rather than forced onto a corner. `read_pois` had
  never parsed the tag; it does now, and it is the only change this pass made outside its
  own two files.

Two of the three depart from what a static approximation would have done, and both
departures are free.

**Which lamp is lit is not a per-head coin toss.** A hash per head shows green on all four
corners of the same intersection about one time in six, and an intersection green on every
approach is not an approximation of a signal, it is a signal that is visibly wrong. The real
constraint costs nothing: opposite approaches share a phase. So the junction takes its
highest-class leg as a reference axis, each head works out which approach it serves — the
leg most nearly opposite the corner it stands on, since the head faces *inward* and is
therefore the far-side display — and shows green if that leg lies on the axis and red if it
crosses it. A four-way gets two of each; a T gets two green along the through street and one
red on the stem. Measured over the ring: **52% green, 44% red, 4% amber**, the amber being
8% of junctions caught in the change interval. There is still no *cycling* — the aspect is
baked at build time — and making them run needs a shared clock and a per-junction phase
offset in the sidecar.

**And there is no text on the blades, which is the point rather than a shortfall.** At any
distance from which you can see a whole intersection a 900 mm blade is under twenty pixels
wide and the legend on it is two. What survives is a green horizontal sliver with a white
line round it, at right angles to another one, on a thin post — so the border is `step()` on
UV, the blade is one 12-triangle box, and the white is drawn *wider* than AS 1742's 10 mm
for the same reason the awning fascia's lettering is a band rather than letters. In sun the
border sits 136 code values over the green field and **in shade still 106**, which is the
number that matters, because half the blades in the city are on the shaded side of a street
at any moment. Real text needs a glyph atlas, a per-post string in the sidecar and an SDF or
a bake per name; `furniture.NamePost` already carries the names through the pipeline for
that day and nothing downstream reads them.

The bin colour is the one place this could have failed quietly, because it is a *green* lid
on a *green* body. Quoted on the up-facing lid, which is the face a footpath actually
presents: body rgb(102,136,119) Y′ 128, green lid rgb(144,241,123) Y′ 212, yellow
rgb(250,228,111) Y′ 224, red rgb(222,66,51) Y′ 98. The green pair lands 84 code values apart
in sun and 47 in shade because the lid is a saturated lime and the body a desaturated bottle
green; the red lid is the opposite failure — no brighter than the body at all — and what
carries it is chroma, since it is the only strongly red object on the street. The lit signal
lamp is **unlit** in the renderer's sense for the reason the power lines' conductors are: a
lamp is an emitter, and a lit material would make its brightness depend on which way the
head is turned. Green leaves at rgb(65,223,115) against its own housing at rgb(28,30,37) in
sun and rgb(8,4,6) in shade.

What is not there: no bus stops, which need route data; no benches, bollards, Ausgrid
kiosks, post boxes or parking signs; no trade bins, so a shop and an apartment block put
nothing on the kerb — the frontage test is houses and walk-ups only, and a 660 L bin on four
castors is a different object; no collision, on exactly the terms the poles and the parked
cars are already waiting on, which is a pity because a wheelie bin is the one prop in this
world a melee player would expect to knock over. Bins are placed against every metre of
qualifying kerb because nothing in OSM maps driveways at the completeness that would need,
which is the same admission `parking.py` makes about bays.

One thing found on the way and still not fixed: **`power.ts`'s `PoleBuilder.box`
is wound inside out** — all twelve triangles, confirmed by building a unit cube with its
exact quad order and measuring a signed volume of −1.0. It is invisible on a pole, where the
only boxes are a 90 mm crossarm and two transformer brackets seen against a shaft, so a
back-facing quad shows the inside of a small dark object and reads as a small dark object.
`furniture.ts` carries the corrected winding rather than the inherited one, because a bin lid
is a box you look straight down on. The winding pass above did not reach it: `sydney
winding-audit` reads the pipeline's GLBs, and a pole is geometry the client builds from a
sidecar, so nothing in the audit can see it.

**Every setback house now has a front fence, and the setback is what decides it.**
Detached houses and terraces with gardens rose straight out of bare dirt: footpath,
then wall, and nothing in between. That gap is the entire character of an Australian
residential street — the low fence and the gate line between the public footpath and
the private garden — and it was the last of the audit's thirty items.

**10,554 fences over the inner ring, 103,829 m of frontage**, on 41% of the 25,968
residential candidates, at 35.8 triangles and 2.78 kB each: 378k triangles and 28.0 MB,
which takes the ring from 4.57 M to 4.95 M and from 297 MB to 326 MB. Each is a strip
on the property line across the building's own street frontage, with a 900 mm gap in it,
and two posts framing the gap.

Five things are worth stating, because each was arrived at against an obvious
alternative.

- **Setback is the test, and it is a measurement rather than a list of archetypes.**
  A zero-lot Surry Hills terrace's front wall *is* the property line: it has no garden,
  and a fence in front of it stands in the middle of the footpath. That is not a class
  of building to be enumerated — 7,297 candidates are simply on the line and get
  nothing — and the same rule admits the Paddington and Glebe terraces that do have a
  3 m front garden and a palisade fence, which any archetype rule would have got wrong
  in both directions. Where the line goes is derived rather than guessed: `streets.py`
  builds its footpath as a band `half_width + footpath_width` off the centreline, so
  the far side of the paving is exactly `footpath_width` beyond the carriageway edge,
  and `mesh._street_ahead_way` now returns *which way* it found so that width can be
  asked for rather than assumed. Setbacks come out at **1.7 / 3.9 / 7.1 m** at p10,
  median and p90, which is a distribution of front gardens.
- **The measurement is taken at three points, not one, and 688 fences were withheld
  because of it.** `_street_ahead` measures from the middle of a wall, and on a corner
  splay or a street that bends past a house the two ends of that wall are metres nearer
  the kerb than its middle. A fence at one constant offset from a skewed frontage runs
  diagonally across the footpath, which is the one failure here that would be visible
  from a hundred metres. So the subtraction is done at both ends against the same way's
  own centreline and the smallest wins: 2,314 fences are pulled in over half a metre by
  it, and 688 are pulled inside the 1.2 m floor and dropped rather than squeezed against
  the house.
- **The gate is aligned to the front door because one object decides both.**
  `DoorNetwork` already resolved which wall a building is addressed on and where along
  it the door stands; `front_edge` is now public and the fences take the same answer, so
  the two cannot pick different walls on a corner block. **10,553 of 10,554** gates sit
  on the door's own `u` projected out to the fence line; one falls back to the centroid.
  Read back from the emitted GLBs on the six densest residential tiles, all 923 fences
  located have both gate posts standing at the station the parameter buffer's door
  position implies. No gate leaf is emitted: a suburban front gate stands open, and the
  gap between two posts is what reads.
- **Style is per building and that is why there are three slots.** A street where every
  house has the same fence has the failure `attributes.MATERIAL_MIX` exists to prevent,
  in a different material. But a fence is a *continuous run* of 6 to 20 m, so the
  variation cannot come from a world-position hash the way `awning_fascia`'s signage
  colour does — that lattice would turn a masonry wall into pickets halfway along a
  garden. The pipeline is the only thing that knows where a frontage ends, so it
  chooses, and a material slot is how it says so without a parameter fetch. The split
  comes out **masonry 4,239 (40%), iron palisade 4,348 (41%), timber picket 1,967
  (19%)**, weighted per archetype in opposite directions on the two that carry it: a
  Federation house's original boundary is wrought iron on a low plinth, a 1960s
  brick-veneer's is a rendered planter wall.
- **The masonry fence is not on a wall slot, and the front door is why.**
  `facade.doorNode` draws a 1.0 m opening to a 2.1 m head at whatever `u` the parameter
  record names, on 29,901 of 33,844 buildings. A fence carries its own `u` — metres
  along the fence — with no relationship to the wall's, so wherever the two coincided
  the shader would paint a slice of that house's front door across its own front fence,
  and no parameter setting turns that off. Under it, the plinth's 0.65 m and the contact
  toe's 0.4 m between them cover the whole height of a 0.75 m fence, so the object would
  render as one continuous darkening ramp. The window band is the *only* one of the
  three that is safe — ground-storey sills are 0.9 m on terrace and walk-up and 1.0 m on
  Federation, interwar and brick veneer, clearing a 0.75 m fence by 150 mm — and it is
  safe only while `b.retail` is false, since a corner-shop terrace swaps the whole
  ground floor for the shopfront override at sill 0.35. Retail never gets a fence, so
  nothing draws glazing on one today; a coupling that survives only because of an
  unrelated exclusion elsewhere is exactly the kind that breaks in a year with no error
  message.

**The pickets are alpha-tested, and the garden shows through.** A palisade drawn as a
solid strip with dark stripes painted on it is a *picture* of a fence — the same failure
the awning pass names about a painted-on canopy — and it would put a continuous 0.9 m
dado rail down both sides of every residential street and hide every front garden in the
city. Three things had to be true and all three were read out of three r185 rather than
assumed: `NodeMaterial.setupDiffuseColor` discards on `alphaTest` from the ordinary
opaque path, so the strip still writes depth; `alphaToCoverage` is wired into the WebGPU
pipeline descriptor whenever `sampleCount > 1`, which `antialias: true` gives, and
`NodeBuilder.isOpaque()` returns false while it is set so the coverage is not thrown
away; and **the mask reaches the depth pass by exactly one route**. The shadow pass runs
with a shared override material; `Renderer.renderObject` copies `alphaTest` onto it
verbatim, and `_getShadowNodes` builds the override's colour as `vec4(vec3(0), 1.0 *
material.colorNode.a)` — the source material's colour node, **alpha channel only**.
Putting the mask in `opacityNode` compiles, looks identical, and throws a solid shadow.
Generating the WGSL for that reconstructed shadow node confirms the 110 mm pitch and its
`fract` are in the depth shader.

What it actually throws is **not** a stripe pattern, and that is arithmetic rather than a
limitation. The shadow map is 4096 over 440 m, so 10.7 cm a texel, against a bar pitch of
11 cm. The mask is faded on `resolves(pitch, fwidth(u))` for the ordinary reason — an
alpha test on a sub-pixel period is the worst aliasing available — and in the depth pass
`fwidth` is measured in shadow-map texels, so the fade evaluates at a footprint of 0.107
against a period of 0.11 and returns zero: the mask goes solid and a palisade casts a
continuous bar. A bar is denser than the fence's 35% duty and there is no way to be
otherwise at this resolution; what bounds it is that the object is 0.9 m tall and throws
0.58 m at the 3 pm sun, which is five texels of soft dark band at the back of a footpath.

Two more things fell out of building it. **A post is narrower than one picket pitch**, so
run through the bar mask a gate post comes out as a shredded sliver — and there is no
other discriminator: a post's four side faces carry exactly the normals a panel's two
faces carry, its cap's normal is up and so is a masonry coping's, and its `v` is the
panel's `v`. Posts therefore carry a `u` in a band starting at −1.0, which no panel can
reach. And **the fence follows the terrain only where the terrain bends**: the ground is
piecewise planar over a 31.25 m lattice, so `terrain.densify` is the whole subdivision
and the median fence gets no interior station at all. Measured back out of the GLBs, no
fence vertex sits more than **32 mm** outside its style's nominal range above the ground
directly under it, and the excursion is entirely post *corners* on a slope — a pier takes
its height from the terrain at its centre and its corners are 277 mm out from there.
100% of fence triangles wind in agreement with their own normals, which at the time
the walls famously did not — see the winding pass above, which is where the rest of
the city caught up.

What is not there: **no collision**, on the same terms as the parked cars, the poles and
the bins — the payload is the building prisms and adding to it is a server change. Here
it is also a gameplay argument: 0.75 to 1.0 m is vaultable, a melee game wants a player
to cut through a front garden, and a city of waist-high fences you cannot cross is a city
of corridors. Also absent: no gate leaves, no hedges, no letterboxes, no side or rear
boundaries — every fence is a frontage and stops at the property corners — and no garden
behind them, so what a palisade lets you see through to is bare dirt until vegetation
learns about private gardens. 2,587 candidates set back more than 9 m get nothing, which
is the conservative direction on footprints whose matched street may not be the one they
are addressed on.

**The powerups are where Sydney's stations and cafés are, and getting them *out of the
buildings* was the whole job.** Spec 8.3 opens on the sentence the feature exists for —
*"Both from live OSM data — the point is that they exist where the real thing exists"* —
and closes on two: **884 pickups over the inner ring, 80 Training and 804 Flat White**, in
14.3 kB of sidecar across 118 of 221 tiles. A median tile carries 4 and the densest, the
CBD block west of Town Hall, carries 64.

Four things about it are decisions rather than mechanics, and the first two are the reason
the naive version of this does not work at all.

- **The obvious reader finds no Central and no Redfern.** Filtering `read_pois` for
  `railway=station` returns 22 nodes over the inner ring, and every heavy-rail station spec
  8.3 name-checks is missing from them: Central, Redfern, Museum and St James are closed
  *ways* tagged `railway=station`, and GDAL's OSM driver leaves those in the `lines` layer
  because `railway` is not one of the keys its `osmconf.ini` treats as area-forming. So they
  are never multipolygons and a reader that looks at `points` and `multipolygons` sees
  neither a ring nor a node. The 22 it does find are the light rail, the Metro and the North
  Shore; a suburban station's platforms are `railway=stop` nodes, one per platform, which is
  a third object again and is not an entrance. `osm.read_station_areas` is the second reader
  that fixes it, and it takes the ring from 22 stations to 42. Of the six the spec names,
  three are inside the 4 km radius — **Central 9 points, Town Hall 6, Redfern 4** — and
  Newtown (4.24 km), Erskineville (4.20) and Green Square (4.20) are 200–240 m outside it
  and arrive with `--stage middle`.
- **86% of café nodes are inside a building, and so are 65% of station entrances.**
  Measured against the footprints: 696 of 811 cafés, 65 of 100 entrances, 8 of 22 station
  nodes. That is not bad mapping — a café *is* inside a building and a subway entrance
  genuinely is inside the lobby it opens off — but the collision payload is the building
  prisms, so a pickup at the mapped coordinate is a pickup behind a wall, and the abundant
  half of spec 8.3 would have been unreachable almost everywhere. `_free_point` subtracts
  every nearby footprint (buffered by 0.6 m) from a disc around the point and asks shapely
  for the nearest point of what is left, which is the *exact* nearest standable position
  rather than the nearest of some lattice. It prefers the street network's own footpath band
  where the free region touches one, because a corner café's nearest open ground is the back
  lane and its door is on the street. Result: 93 points already clear and never moved, 756
  snapped to paving, 35 to open ground, **4.5 m at the median and 57.5 m at the worst**.
  The worst is Gong Cha in the QVB, which really is 57 m from a footpath, because the QVB is
  a city block — 61 points needed the second, wider disc for that reason and it is a
  two-stage search precisely so an ordinary corner café can never snap two streets away.
- **Entrances win where they are mapped; the station stands in where they are not.** 8.3
  says *"touch a station entrance"*, and an entrance is the better objective — it is a
  doorway on a footpath that several players converge on. But only the CBD's underground
  stations have theirs mapped, so each entrance is attached to its nearest station within
  250 m and a station that attracted none emits one point at itself: 25 stations with
  entrances, 17 standing in for themselves. Wynyard has **ten** mapped entrance nodes and
  Town Hall six, which as objectives is not a contested point but a carpet, so a group keeps
  the four *furthest apart* by farthest-point sampling from its own centroid — the four that
  surround the block rather than four at one end of it — and nothing lands within 40 m of
  something already taken.
- **Nothing about the gameplay is in the sidecar.** 16 bytes a point: a position, a ground
  height and a kind byte. Every number in 8.3 — the 45 s, the ×1.4, the 90 s respawn — lives
  in `client/src/game/powerups.ts` beside the combat constants, on the same argument
  `write_furniture` makes about the bin palette. A byte here that repeated one of them would
  be a byte that could disagree.

**Client-side it is two floats on the combatant and one field on the input snapshot.** The
modifier state is `trainingT` and `flatWhiteT`, seconds remaining, rather than a list of
active effects — there are exactly two, the spec defines both completely, and those are the
fields a 60 Hz snapshot has to carry per player. Stacking then falls out of arithmetic
instead of a resolution pass: damage ×1.4 × ×0.8 = **×1.12** with both running, which is the
coexistence 8.3 implies by giving Flat White a damage *penalty* at all.

Three consequences of that are worth stating because each was arrived at against an obvious
alternative.

- **Health is a float and the pips are its ceiling.** +40% of a 1-pip punch is 1.4 pips,
  which is not a number of pips, and both integer readings are wrong gameplay: rounding up
  makes a trained punch a two-hit kill and rounding down makes the powerup do nothing.
  `MAX_HEALTH` is 3.0, an ordinary punch is 1.0 and a trained one 1.4, and the HUD draws
  `ceil(health)` — so three trained punches kill (4.2) and two do not (2.8), and what the
  +40% actually buys is finishing a victim who has taken one ordinary hit. With no modifier
  anywhere the arithmetic is exactly integral, which is why `verifyCombat` needed no change.
  `applyHit` snaps anything under 1e-9 to zero, because 3 − 1.4 − 1.4 − 0.2 lands at 4.4e-16
  and a victim alive by half a femto-pip cannot be knocked out by any finite number of
  further punches.
- **The speed modifier is a field of `InputSnapshot`, and that was the one controller change
  this pass made.** Three alternatives were tried on paper first and each fails somewhere
  structural. Scaling the wish vector cannot express +60%, because `step` normalises it two
  lines later. Scaling the velocity after `step` returns multiplies the acceleration ramp and
  the friction decay along with the top speed — the player skates — and it means the caller
  edits state the server also owns, outside the function both ends run. Making `WALK_SPEED`
  mutable is a global, and the wrong shape the moment a second combatant has a different one.
  A field of the input snapshot is exactly what a snapshot is *for*: everything that decides
  a tick, in one record, sent over the wire. `step` stays a pure function of state plus
  input, the constants are untouched, `speedScale` and `jumpScale` are optional so every
  existing caller means 1, and `verifyMovementBasis` is unchanged and still passes.
- **The jump multiplier is √2, not 2.** Apex is `h = v²/2g`, so 8.3's "+100% jump height" is
  a velocity multiplier of 1.4142; passing 2 straight through quadruples the height and puts
  a player on a second-storey balcony, which reads as a collision bug rather than as a
  gameplay one. The conversion lives beside the spec number in `game/powerups.ts` and
  `verifyPowerups` measures the resulting *apex* against 2× rather than trusting either end.

**Seeing an icon through a building is three passes, and one of them exists only because
the other two cannot be masked.** 8.3 asks for icons *"visible through geometry to 60 m
with a soft outline"*, and the obvious implementation — one mesh with `depthTest: false` —
fails on the first street: with no depth test at any distance, a café icon in Alexandria
paints itself on the CBD skyline from two kilometres away. The 60 m is not a nicety, it is
the clause that makes the feature usable, and it has to be per fragment. So each icon is
drawn as a **solid** (ordinary depth), a **ghost** (`depthTest: false`, transparent, with a
TSL `opacityNode` fading 45→60 m off `positionWorld.distance(cameraPosition)`), and a
**shell** — the same geometry at ×1.15 with `side: BackSide` and a squared rim term
(`1 − |normalView.z|`), which is the outline. The rim term is the part that is not obvious:
a depth-free pass cannot be masked by the solid in front of it, so without it the shell
washes its full opacity across the whole silhouette instead of only around it.

Three facts about three r185 were read rather than assumed. A `transparent` material is
always drawn after every opaque one, so the ghost cannot be painted over by the building it
is meant to show through regardless of tile load order. `renderOrder` beats depth in the
transparent sort, which is what pins the shell behind the ghost — without it the two sort by
camera distance and the shell, genuinely nearer on its front half, wins about half the time
and the icon reads as a blob. And `positionWorld` includes the instance matrix, the same
fact `vegetation.ts` documents about its sway, which is what lets one shared material fade
800 icons at 800 different distances. The two depth-free meshes are switched off entirely
for any tile whose *near edge* is beyond 60 m — exact rather than heuristic, since every
icon in such a tile is past the fade — so the cost is typically one to four tiles rather
than the sixty a 1,800 m load radius holds.

The two shapes are **24 triangles for the bolt and 68 for the cup**, unlit, with a two-term
hemisphere baked into the vertex colours. Unlit is the same call `furniture.ts` makes about
a signal lamp: a marker is not standing on the footpath, and its readability must not depend
on whether the terrace beside it is between it and the sun — a `MeshStandardNodeMaterial`
would put the Training bolt at a quarter brightness on the shaded side of every street,
which is exactly where a player most needs to see it. The baked shade is the shape
information that an unlit material otherwise throws away, and it cannot go black. Colour is
per instance through `instanceColor`, so the whole feature is **three materials for the
world**, and the two tints were chosen for separation rather than for prettiness: gold at
Y′ 187 and cream at Y′ 233 differ by 46 code values *and* by hue, so the distinction
survives a player who cannot separate the two brightnesses at 60 m through a wall.

**What is not there:** no pub/"Schooner" variant (8.3 says implement the café by default).
Networking *is* there now and the pickup is server-authoritative, which is 8.3's closing
sentence — what is still absent is any notion of who took what beyond the current match,
which spec 12's "no persistence" makes deliberate. Minimap markers are
in — every live point inside 160 m is a gold or cream dot on `client/src/minimap.ts`, which
takes them from this same field and disappears them the instant one is collected.
Respawn clocks pause on a tile the streamer has evicted, which is unobservable at a 1,800 m
load radius — leaving and returning is 3.6 km, 450 s at a sprint, against a 90 s worst-case
respawn — and would be a bug the moment the radius shrank. The cafés' 45 s respawn is this
build's number and not the spec's: 8.3 states 90 s for the station and is silent about the
café, and half of it is what the spec's own characterisation implies, since "the abundant
low-stakes pickup that keeps traversal interesting" has to be back before you have finished
traversing.

**Two browsers see each other move, and the whole server is the client's own code.**
Milestone 9, and what is worth reading about it is how little was written. `server/` is
five files and about 1,100 lines, of which the simulation is `sim.ts`'s 200 — because
`game/combat.ts`, `game/laser.ts`, `game/powerups.ts`, `player/controller.ts`,
`player/collision.ts` and `world/terrain.ts` are **imported across the directory boundary
and run unchanged**. The server loads the same `collision/*.bin` a browser downloads (2.0
MB, 33,844 prisms), the same `*.terr.bin` (255 kB, 221 grids) and the same `*.pow.bin` (884
points), all of it at boot in **35 ms**, and then runs `main.ts`'s own `simulate()` at a
fixed 60 Hz.

Reading `sim.step` and `main.ts`'s `simulate` side by side is the point: both collect every
input first, both advance every combatant in ascending id, both resolve a strike against the
state as it stands, both tick spec 8.3's powerups after everyone has moved. There are
exactly three differences and each is a thing a server has that a client does not — strikes
are evaluated against a **rewound** target list, pickups are decided once for everybody, and
there is no frame delta anywhere.

Five things about the netcode are decisions rather than mechanics.

- **Position is historical; everything else is current.** `server/rewind.ts` keeps 250 ms
  of positions and yaws per player — spec 10's cap, fifteen ticks, five numbers each, 4.8 kB
  for the whole lag-compensation system — and nothing else. Rewinding *health* would let a
  player be killed twice by two attackers looking at two different pasts; rewinding *phase*
  would let a body already on the pavement be hit by a punch thrown before it fell. Both are
  real bugs in real games and both come from the same over-generalisation, that "rewind the
  world" sounds more correct than "rewind where people were". A punch is validated against
  where the victim *was* and applied to who the victim *is*, and `resolveLive` is the
  three-line function that keeps those apart — without it a punch connects, plays its sound,
  shakes the camera and does nothing at all, because the damage went into a proxy object
  discarded at the end of the tick.
- **The rewind is interpolated, and the reason is bias rather than accuracy.** One sample
  per tick makes a nearest-tick lookup accurate to 8.3 ms, which at a sprint is 7 cm against
  a 1.2 m reach — survivable on its own. What is not survivable is that a client's view time
  never lands on a tick boundary, so the rounding always resolves the same direction for a
  given latency, and a player at a particular ping would find their punches consistently
  landing early or late. Lerping between the two bracketing samples costs four multiplies.
- **Reconciliation is a three-way split, not a copy of the server's state.** The snapshot
  carries 22 bytes a player and deliberately no velocity, phase timers or powerup clocks, so
  "adopt the server's answer" is not available. *Predicted and reconciled*: position,
  velocity, look, ground contact, the punch phase machine — all functions of the player's own
  input. *Told outright*: health, stamina, laser charges, which powerups are running — all
  consequences of what other people did, none of them smoothable, since there is no half a
  pip. *Told on the transition only*: flinch and knockout — because `phaseT` is not on the
  wire, so re-adopting a flinch every snapshot would extend a 300 ms lockout to as long as
  the server kept reporting it.
- **A knockback cannot be smoothed, and the fix is one divide.** Ordinary corrections are
  centimetres and are eased out of the *camera* over 80 ms while the simulation takes them
  immediately — `game/feedback.ts`'s separation, one layer down. A knockback is not
  ordinary: the server throws a victim at 11 m/s and the client, which did not see the punch
  coming, predicted a stationary body, so the error is metres within two snapshots. Easing
  that drags the camera through a six-metre arc at 20 Hz. Snapping fixes the position and
  not the *motion*, so the next frame the prediction is standing still at the new spot and
  the snap repeats. What works is taking the velocity from the server's own two most recent
  positions — `(p1 − p0) / dt`, which *is* the flight velocity — and handing it to the local
  integrator, which flies the rest of the arc itself through the same gravity and friction
  the server is using.
- **Remotes are interpolated and never extrapolated.** Spec 10's 100 ms buffer, against a
  clock that runs continuously at 60 ticks a second and is nudged 10% of the error per
  snapshot rather than assigned — a phase-locked loop in four lines, and without it remotes
  advance in 50 ms hops because the snapshot tick steps by three twenty times a second. A
  remote whose newest snapshot is older than the render time holds its last position: a
  player who ran into a wall during a stall would otherwise be drawn walking through it, and
  the correction when snapshots resume is a teleport backwards.

The animation byte is the small decision that saved the most. A snapshot could carry speed
and ground contact and let each client derive the gait, and then a remote's walk-versus-run
would come from a difference of two interpolated positions — a different answer at every
corner and every knockback, on every screen. Instead the **server** resolves the nine states
once, into one byte, and everybody draws what they are told.

Bots are the last piece and they are three dozen lines. `game/dummies.ts` predicted that
*"the only thing here that a server would delete is the `think()` method"*; the correct
action turned out to be the opposite — `think()` is the only part that **moves**, and the
`ActorDriver`, the `CharacterActor` and the pose all stay in the browser. Server-side a bot
is a `CombatantState` in the same array, advanced by the same `advance`, hit by the same
`hitTest`, rewound by the same buffer and serialised into the same record. There is no bot
branch anywhere in `sim.ts` except the one line that calls `bots.ts` instead of reading a
socket, and no client has any way to tell one from a person. The post is gone — it stood
still, which was what made it the clean read on reach in a build where you could walk up and
stare, and online it is a coat stand — and the aggressor now **chases**, because a bot in a
city that will not walk is a bot nobody ever meets.

`npm run server:check` is what proves the whole path rather than its parts: it starts a real
server on a spare port, connects two synthetic clients, drives them apart and back together
over eight seconds of 60 Hz input, and asserts nineteen things — distinct ids and
colourways, both clients seeing all four combatants, 28.9 m and 28.3 m of measured walking
(path length, not net displacement, because they end up where they started), a closest
approach of 0.44 m, three landed punches seen by *both* clients, and three laser shots with
real beam lengths of 1.9, 32.1 and 0.9 m. Measured downstream at four combatants: 15.4
kbit/s including events, against a 14.7 kbit/s snapshot stream.

**The boot no longer waits on the network to admit it works, and finding out why
took a real browser.** Live verification turned up a tab that had a working renderer
streaming tiles, a socket the server said had joined, and a page that sat on the loading
overlay for four minutes with `window.sydney` never assigned. It was intermittent — one
earlier boot of the same path finished — which is the signature of a race rather than a
fault.

The defect is structural and it predates the server; adding the server is what made it
show. `main()` had **four unbounded network `await`s between "the renderer works" and "the
page says so"** — the far layer, the ground under the client's spawn, the WebSocket
handshake, and (new this pass) the ground under the *server's* spawn. `ensureGround` walks
its tiles **in sequence** with no timeout on any request, so a single fetch that never
answers stops the entire remainder of `main`: no fighters, no animation loop, no
`hud.ready`, no dev handle. And `fetch` has no timeout, while a browser gives one origin
six connections and the streamer runs four tiles of seven files each — so a 1,156-byte
sidecar can queue behind four 1.7 MB tile payloads indefinitely. The symptom of that is
indistinguishable from a broken build, which is the worst property a failure can have.

Three changes, and the third is the one that matters most:

- **Every boot `await` is bounded** — `withDeadline` at 5 s for ground, 15 s for the far
  layer — and losing is not an error. The ground is already optional: `groundHeightAt`
  answers an unloaded tile with the last height it knew, and the render loop re-runs
  `ensureGround` every half second forever. Every individual fetch also carries an
  `AbortSignal.timeout`, so an abandoned request releases its connection instead of holding
  one of the six that the next request is queued behind.
- **`TerrainField.ensure` had two real bugs**, both confirmed by running the old code
  rather than by reading it. Its `inFlight.set` ran *after* the request body started, which
  is correct only because `fetch` happens to suspend on its first await — a synchronous
  throw (a malformed base URL is enough) ran the whole body, let its `finally` delete a key
  that had not been added, and then stored the **already-settled** promise under that key
  for the life of the page. And every failure went into `missing`, which is permanent: one
  network hiccup meant that tile's ground was never fetched again for the session. Now the
  dedup entry is registered before anything can run, a 404 or a wrong-sized payload stays
  permanent (it is a fact about the build), and a thrown or abandoned fetch is retried after
  five seconds (it is a fact about one moment). `phys` on the debug overlay reports both
  counts, because a tile whose ground never arrived is otherwise invisible — the player
  walks across it on a stale height, which looks exactly like ground.
- **`window.sydney` and `hud.ready()` now happen before any of it**, the moment the index
  parses. The handle is created there and `Object.assign`ed at the end, so a console
  reference taken during boot keeps working, and `sydney.boot` names whichever stage is
  outstanding. A handle that only exists once everything succeeded is a handle that is
  present exactly when it is not needed.

One limit is worth stating rather than papering over: all three mitigations are
timer-based, and a tab that has been hidden for more than five minutes gets Chrome's
intensive throttling, which clamps timers to roughly once a minute. A 5 s deadline in that
state can take up to 60 s to fire. What is guaranteed is that it *fires* — the boot always
terminates — not that it terminates promptly in a tab nobody is looking at.

**And the console flood is gone.** `world/facade.ts` was importing TSL's
`transformedNormalWorld`, which three r185 defines as `Fn(() => { warn(...); return
normalWorld; })` — deprecated since r178, and re-evaluated on every graph build, which
across nine material slots and four material outputs is hundreds of identical warnings per
boot. It is a pure rename with no behavioural difference (the deprecated node's entire body
is a `return`), and `normalWorld` was already imported in the same file for the concrete
slot's flat-surface gate.

**The raygun is 118 triangles and the beam is 96.** Spec 12 excludes guns and this is here
by instruction — see the deviations above for what was done to keep the fists deciding
fights. What is worth stating here is the two rendering decisions.

The **beam is a mesh in the world**, not a screen effect, and the reason is that you are not
the only person shooting: a post pass or a camera-facing quad belongs to a viewer, and this
game's whole subject is watching somebody else do something across a street. A world-space
beam is seen by everyone at their own angle, is occluded by the terrace it passes behind,
and lands on the wall it hit at the point it hit. It is two cylinders — a 0.03 m near-white
core and a 0.10 m additive magenta sleeve drawn `BackSide` so the sleeve's far wall shows
through the near one, which without it washes the white middle out entirely. Both are
additive and neither writes depth, which is the whole configuration: getting the second half
wrong makes an additive effect show black seams where its own geometry overlaps.

**Magenta rather than cyan, and the sky decides it.** This project's own measurements put
the zenith at rgb(114, 166, 249) and the horizon band near rgb(200, 233, 254) — the entire
upper half of every frame is blue, and a cyan beam fired across it is a slightly different
blue. Magenta at rgb(255, 40, 190) is the complement of that field and is the one hue in the
palette no surface in the city carries: the brick is red-orange, the roofs terracotta, the
render cream, the grass green. The bolt fades on a *square* rather than linearly, so it
holds full brightness for 40 ms and then goes — a linear fade over 140 ms reads as a rod
dissolving where this reads as a discharge — and the shell collapses while the core keeps
its radius, so the beam appears to retract into itself rather than shrink.

The gun goes **on your back when it has not been fired recently**, which is the whole of the
"weapon switch" feel and costs one `add()` call every few seconds: parented to the right
wrist bone drawn and to the chest bone stowed, so three's own skeleton pass transforms it for
free. Raising the arm to aim is four lines in `CharacterActor.applyAim` and is **added** to
the composed pose rather than blended toward one — `blendPose` was the obvious tool and is
the wrong one, because aiming while punching would fight the punch for the same three
channels and the strike would come out at 60% of its throw.

What is not there: no decals, so a beam that hits a wall leaves nothing; no light, because a
dynamic light in this renderer is a shadow-map decision and a per-material recompile for
140 ms of a small object — the impact flash is the honest substitute, since it says
*something happened here* without claiming the wall got brighter; and no first-person arms
or muzzle, on exactly the argument the punch already makes. What you see of your own raygun
is its shadow on the footpath in front of you.

**The terrain is a DSM, and in the CBD that shows.** Terrarium is looking at the
tops of Sydney's towers, so the square kilometre and a half between Circular Quay
and Central reads about 40 m high — which puts the *datum* at 71 m AHD where the
ground at Town Hall is nearer 28. That is an offset and it costs nothing: every
relative height in the world is right, `index.json` carries the number, and the
debug overlay prints both. Outside the CBD the sampler is within a few metres of
reality (the Domain +2, Alexandria +2, Newtown +2, Erskineville +4), and the two
places it is not are Surry Hills at +10, where the terraces are as tall as the
relief, and the shoreline at +9, which is the smoothing averaging in the hill
behind the water.

Neither is fixable with a wider kernel — a morphological opening at radii from 32
to 160 m takes the CBD from 64 m to 53 and Observatory Hill, which is a real hill,
from 34 to 24. What fixes it is bare-earth LiDAR (ELVIS, above), or, without a new
source at all, subtracting the building heights the pipeline already knows from the
DSM and hole-filling from the unbuilt ground around each block. Both are their own
pass and neither changes anything below `terrain._load_dem`.

**Also missing:** water surfaces (the harbour is the far plane at sea level and
reads as flats), the rest of the street furniture (bus stops, benches, bollards,
kiosks, post boxes — see above for the three that are in), decals, hero
landmarks, and everything from the server onward. Characters are in — see
milestone 7 above and the headers of `player/character.ts` and
`player/animation.ts`, which carry the reasoning the way every other module
here does.

**Geometry LOD chains.** The streamer's LOD bands are currently tracked and reported but
drive nothing: the pipeline emits one mesh per building at every distance, and the facade
is a single shared pipeline whose parallax cannot be switched off per tile without
compiling a second variant of all nine slots. Since facade detail lives in the material
rather than the mesh this is much less costly than it sounds, but band 3 should eventually
be a merged silhouette. Shadow casting and receiving used to hang off the bands and no
longer does — 80/400/2000 m are shading-cost thresholds and have nothing to do with where
the sun's 220 m shadow volume reaches, and conflating the two is what left the city with
no cast shadows at all.

**Tiles are uncompressed.** 326 MB for the inner ring, of which the paved surfaces and the
park grass are 91 MB — 28% of every byte, and the kerb alone is 13% — plus 23 MB of contact
skirt, 118 MB of roofline trim, which is the largest single item, 28 MB of front fence and
4.8 MB of awning. The paved layers
doubled when they were cut against the terrain facets, which is the price of the road lying
exactly on the ground and is the best trade in the pipeline; the trim is expensive for the
opposite reason, that hard edges cannot share vertices. Either way this is the most
worthwhile thing left to do about download size.
Draco plus quantisation via `gltf-transform` should take the total to roughly an eighth,
and the spec's 2.5 GB budget for the full extent assumes it. Street geometry is still the
place to start: it is axis-aligned, its heights are a smooth function of position, and it
quantises better than anything else in the build. The terrain sidecars themselves are
nothing — 1,156 bytes a tile, 249 kB for the whole inner ring.

One cheap win is untaken and worth naming because it needs no new dependency: every index
buffer is `uint32`, and **no** slot in **any** inner-ring tile reaches 65,536 vertices —
the largest is now `render_painted` at 29,004, which the roofline trim more than doubled and
which is still less than half the ceiling. Emitting `uint16` throughout would save over
30 MB of download, though not a byte of VRAM: three's WebGPU backend widens a `Uint16Array`
index buffer back to 32 bits on upload, so this is a download optimisation and a small
per-tile CPU cost, not a memory one.

---

## Working on it

`window.sydney` is exposed in dev: `renderer`, `scene`, `camera`, `sky`, `streamer`,
`collision`, `player`, `minimap`, `net`, plus `look({x, y, z, yaw, pitch})` to teleport,
`punch()` and `laser()` to fire without a mouse, and `frameMs()` for the median frame time.

`sydney.net` is null offline and otherwise carries the connection. `sydney.net.report` is
the one to reach for: players, ping, how many snapshots are buffered, and — the two that
actually diagnose anything — `corrections` and `snaps`. A healthy session is a slow trickle
of sub-centimetre corrections and a snap only when somebody is punched. A snap count
climbing while nobody is fighting means the client and the server are simulating
differently, which has no symptom other than rubber-banding. The same numbers are on the
debug overlay's `net` line, with the kill feed under it.

`minimap.stats()` reports what the rotating map cost and what it drew — the last redraw in
milliseconds with the median and p95 over the last four seconds, beside the prism and vertex
counts that produced them. The pairing is the point: a cost with no polygon count beside it
says nothing, because a 160 m disc holds 83 footprints on one corner of the spawn tile and
230 on another. The map redraws at 15 Hz rather than per frame and reads the collision
prisms rather than any render mesh, so the whole feature is one `fill` of about 1,100 points;
`client/src/minimap.ts` carries the measurements and the reasoning.

`powerupReport()` is the one to reach for on spec 8.3, because an icon is drawn *through*
geometry to 60 m and so "I can see it" says nothing about where it is. It gives the nearest
live station and café with their world coordinates, their distance, whether they are up and
how long until they are, a `walkTo` you can hand straight to `look()`, and the player's own
current multipliers and field of view — which is the difference between "the powerup did
not apply" and "the powerup applied and I cannot feel it".

The character build adds `dummy`, `self` and `characterReport()`. The test dummy
stands four metres in front of the spawn and cycles every clip on a 9.5-second
loop; `sydney.dummy.setAction('punch')` holds one clip instead, which is the only
way to look at a 100-millisecond strike or at a knockout that otherwise gets up
after 1.7 s, and `setAction(null)` restarts the loop. `self` is the local
player's own body — on a layer the camera excludes and the sun's shadow camera
includes, so the only thing it contributes to a frame is the shadow you can see
on the footpath in front of you.

Frame cost is reported as median milliseconds rather than a frame count, because a
frame-per-wall-second figure reads as 0 fps whenever the browser stops issuing animation
frames — which happens whenever the window is not on screen, and is not a rendering
problem.

Pipeline state:

```bash
npm run world:status
```

The terrain has its own audit, which reads back only the emitted files — the index, the
GLBs, the `.terr.bin` sidecars and the collision payload — and checks that every subsystem
agrees about height. It is where the numbers in this file come from:

```bash
cd pipeline && ./.venv/bin/python -m sydney terrain-audit
```

The geometry has a second one, on the same terms — it opens the GLBs and nothing else — and
it answers the one question glTF, three and this pipeline all decline to ask: does each
triangle's vertex order point the same way as the normal it carries? A build can fail that on
two thirds of its walls and still render a plausible city, which is exactly what this one did
for months. It exits non-zero on any face that is inside out:

```bash
cd pipeline && ./.venv/bin/python -m sydney winding-audit --tiles 0
```

Every stage is a row in `data/ledger.sqlite`, so an interrupted build resumes where it
stopped rather than starting over.

---

## Data and attribution

Every source the game is built from, in one table, so the next person can find
it. The world data under `client/public/world/` and in
[voidtype/sydrunner-world](https://github.com/voidtype/sydrunner-world) is a
**processed derivative** of the geodata rows (reprojected to EPSG:7856, merged,
simplified and tiled) and is redistributed under **ODbL**; carry the same
attribution and share alike if you redistribute it.

| source | what SYDNEY takes from it | where to get it, and the licence |
|---|---|---|
| **OpenStreetMap** | Building footprints and tags (the primary footprint source, see *Decisions that departed from the spec*), roads and street names, the railway and its stations, water, parks and green, power poles, points of interest, and the suburb label nodes that become `world/suburbs.json` and the hero line | [openstreetmap.org/copyright](https://www.openstreetmap.org/copyright) — extracts via the Overpass API and Geofabrik; © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/) |
| **Microsoft Building Footprints** | ML-segmented footprints that fill the suburbs OSM has not hand-mapped (7,990 of the inner ring's 29,790 buildings); `pipeline/sydney/merge.py` resolves them against OSM | [github.com/microsoft/GlobalMLBuildingFootprints](https://github.com/microsoft/GlobalMLBuildingFootprints) — ODbL |
| **AWS Terrain Tiles** (Mapzen `terrarium`) | The digital elevation model everything drapes on; `pipeline/sydney/terrain.py` | [registry.opendata.aws/terrain-tiles](https://registry.opendata.aws/terrain-tiles/) at `s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`; per-source attribution in [tilezen/joerd](https://github.com/tilezen/joerd/blob/master/docs/attribution.md) |
| **Transport for NSW Open Data — level crossings** | Where the railway crosses a public road at grade, so the corridor is fenced everywhere else; `pipeline/sydney/rail.py` | [opendata.transport.nsw.gov.au](https://opendata.transport.nsw.gov.au/data/dataset/nsw-level-crossings-on-public-roads) — CC BY 4.0 |
| **nswrail.net — tunnels** | The list of rail tunnels and their portals, which decides where the line goes underground | [nswrail.net/infrastructure/tunnel.php](https://www.nswrail.net/infrastructure/tunnel.php) — reference site, read by hand into `pipeline/sydney/rail.py` |
| **Published landmark dimensions** | The truth figures the three parametric landmarks are checked against — the Harbour Bridge's arch and pylons, the Opera House's shells, Sydney Tower's 309 m — `LANDMARK_TRUTH` in `pipeline/sydney/cli.py` | Public engineering figures (Wikipedia and the operators' own sites); the meshes are built by `pipeline/sydney/landmarks.py`, not downloaded |
| **Transport for NSW mode colours** | The interface's semantic colours: train orange, bus blue, ferry green, light-rail red (`UI.md`) | [transportnsw.info key to icons](https://transportnsw.info/plan/instructions-planning-guides/key-to-icons-line-codes); the colours are used, the trademarked symbols are not |
| **Public Sans** | The interface typeface, the NSW Government's own digital face | [github.com/uswds/public-sans](https://github.com/uswds/public-sans) via Google Fonts — SIL OFL 1.1; self-hosted in `client/public/fonts/` |
| **Jost** | The display typeface: the hero line, the wordmark, every label | [indestructibletype.com/Jost](https://indestructibletype.com/Jost.html) via Google Fonts — SIL OFL 1.1; self-hosted |
| **Kenney Car Kit** | 17 of the 29 car models | [kenney.nl/assets/car-kit](https://kenney.nl/assets/car-kit) — CC0 1.0 |
| **Poly Pizza models** | 12 car and bus models, each credited by author in `client/public/credits.html` (generated by `scripts/prep-car-models.mjs` from `client/public/cars/manifest.json`) | [poly.pizza](https://poly.pizza) — CC BY 3.0, attribution shipped in-game at `/credits.html` |
| **Sketchfab car models (the Sydney mix)** | 11 real cars, one model year each — Ford Ranger 2023, Toyota HiLux 2021, Mitsubishi L200, Mazda CX-5, Nissan X-Trail 2023, Hyundai Tucson 2015, Toyota Prado 2013, Toyota Corolla 2020, Toyota Camry 2020, Tesla Model 3, Toyota HiAce 2020 — decimated to ≤12k triangles and mirrored to right-hand drive where the wheel was on the left (`scripts/ingest-sketchfab.mjs`, `scripts/prep-car-models.mjs`); each credited by author in `client/public/credits.html`; the shortlist with provenance notes is `data/vehicles/sourcing-2026-09-sydney-mix.csv` | [sketchfab.com](https://sketchfab.com) — CC BY 4.0 per model, attribution shipped in-game at `/credits.html` |
| **Pixabay — door** | The door sound, `client/public/audio/door/open.mp3` | [pixabay.com](https://pixabay.com) ("Opening door", Dragon Studio) — Pixabay Content Licence |
| **In-house audio** | The police, drunk and methhead barks (`client/public/audio/*.wav`), the sun's screams (`audio/sun/`), the station departure chime (`audio/rail/`), and the rave tracks in `audio/dj/` (see that folder's README for how to add your own) | Recorded and produced for the game; ship with the repository |
| **Sydney Ferries network** | The nine ferry routes and their wharves (`client/src/game/boatroutes.ts`, generated): real wharf positions snapped to the bake's water, routes as water-only paths over the bake's own terrain | Route and wharf names from [transportnsw.info](https://transportnsw.info) (public timetable information); the geometry is this repository's own |
| **The players' suggestion board** | Half the design ledger in `DESIGN.md`; the board itself is a GitHub issue label on this repository | [github.com/voidtype/sydrunner/issues](https://github.com/voidtype/sydrunner/issues) |

**The code** in this repository has **no licence granted yet** — it is published to be read
and to serve the world assets, not (for now) to be reused. Ask if you want it under
something.
