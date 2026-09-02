# INTERIORS — the inside of every building

Every building in the city has a door. Opening it generates an inside, and the
inside is **its own world instance**, WoW-style — not a hollowed-out building in
the street.

This document is the design and the state of it. Read it before touching
anything under "What is not built".

## The owner's decisions, which are not open questions

- **Any door.** No curated list of buildings exists or ever will. *"i want ANY
  door in the game to let me in — the point of a runtime pipeline that lazily
  loads means i dont need to choose a specfic building."*
- **Global and shared.** One building, one inside, for everybody who walks
  through that door. Not per-party, not per-player. A pub with one drinker in it
  is a worse pub.
- **Persistent.** Log out inside and you log in inside.
- **One door.** You leave by the one you came in.

### Refused, with the reason

**Real-estate photos and floor plans.** Listing photos belong to the agency or
the photographer; shipping them is straightforward infringement. It is also weak
on its own terms — most buildings were never listed, listings vanish,
address→OSM matching is miserable, and a photo does not become a room. The
generator uses the building's own geometry instead, which is data both ends
already have and which covers every building rather than a handful.

**A loading screen.** The owner allowed one *"as long as it interestingly
describes the phases"*. There are no phases: generating an interior is a few
hundred microseconds of integer arithmetic over a footprint the browser already
holds, so a progress bar would be a fabricated wait — and the reason WoW's works
is that something is genuinely happening behind it. What the permission was for
is the moment landing, and that is `interiorLine`: one sentence naming the room
you are standing in, including the floors above that are shut.

## Why it costs nothing to stream

`client/src/player/collision.ts`'s `Prism`, streamed for every building inside
the load radius:

```ts
points: Float32Array;  // world-space polygon, flattened x,z pairs
height: number;
base: number;          // ground height of the building's pad, metres
structural: boolean;   // TRUE for viaduct decks, FALSE for buildings
```

Plus `prismsWithin(x, z, radius, out)`. So an interior needs **no new asset, no
bake and no egress**, which matters against the 20 GB/month cap (DEPLOY.md).

The prisms are **not** convex, whatever an earlier version of this file said:
of the 1,182 enterable buildings within 800 m of the spawn, 441 are concave.
So the room is built on the footprint's **convex hull** (`interior.convexHull`,
monotone chain, no trig), which is what makes the half-plane shell, the fan floor
and the door on the longest edge exact. The plan's rooms are still culled
against the real outline, so a notch is open floor rather than a room somebody
could be put in. Before this, a concave outline's own half-planes intersected in
nothing and a player restored into one could not take a step -- 107 of those
buildings did that.

`Prism.structural` reads the opposite way to its name and cost an hour: it is
**true** for the deck, viaduct and bridge volumes whose `base` is a soffit, and
**false** for buildings, which are solid from their pad down to the terrain.
`doorAt` refuses structural prisms, so there is no door under the Cahill.

## The architecture

An interior lives **at the building's own coordinates**. Not in a far-off
instance region, which is how most engines do it, because at the building's own
coordinates:

- Nothing is teleported anywhere. Entering moves you a metre; leaving moves you
  back. There is no arrival corridor and no way to lose somebody's outside spot.
- The city's collision is simply not consulted. A participant inside is stepped
  against `Interior.resolver` through `CombatWorld.mover` — which is exactly
  what a train carriage already does — so the building's own prism never pushes
  back. **Nothing is ever a boolean subtraction**, which is why the owner's
  objection ("carving requires a manifold solid") is not a question anybody has
  to answer.
- Two spaces never occupy the same metres, because two buildings do not.

**The server owns your position.** `net.reconcile` runs every tick against a
server-simulated body, so an instance is not a client trick: this process has to
know which space you are in and simulate you there. Everything else hangs off
that one field.

## The files

| file | what it settles |
|---|---|
| `client/src/world/floorplan.ts` | rooms from any footprint. Binary subdivision of the oriented box **in the building's own frame**, keeping cells whose centre is inside the polygon — that one clause is what makes L-shapes, courtyards and horseshoes work with no special case. The room cap stops the *splitting*, not the walk, so a storey is always a complete tiling. `STOREY_M = 3.1`. |
| `client/src/world/doorway.ts` | `doorAt(prisms, px, pz, gazeX, gazeZ, reach?, facingMin?)` → the door on the building you are facing. `buildingSeed(prism)` names a building by its own geometry, rounded to a centimetre before hashing so a float's last bit cannot rename it. |
| `client/src/world/interior.ts` | walls with doorways cut in them, a convex shell you cannot walk out of, `InteriorResolver` (the `MoveResolver` both ends step against), `arrivalAt` (per entrant, because the door is), `interiorMesh` (triangles), `interiorLine` (the sentence). |
| `client/src/world/interiorview.ts` | the twenty three-aware lines: one `BufferGeometry`, one material, one layer. |
| `client/src/net/spaces.ts` | `CITY_SPACE = 0`, `spaceForBuilding(seed)` (never zero), `sanitiseSpace`, `sameSpace`. |

Every one of those but `interiorview.ts` is three-free and runs on **both** boot
lists (`client/src/main.ts` and `server/index.ts`), because a check that only
runs in the browser is a check the deploy gate cannot see.

## The wire — protocol v25

Two messages, a matched pair under the halves convention:

- **`MSG.DOOR` (0x16, client → server), one byte.** No building, no position, no
  enter/leave bit. The server holds the same prisms and runs the same pure
  `doorAt`, so it answers *which building* from the body it is already
  simulating — and a client cannot ask to be let into a building it is nowhere
  near. It knows which space you are in, so an inside press can only mean out.
  The reach and the facing are slacker on the server than in the browser's
  prompt, which is `MSG.SUN_PRESS`' arrangement: the slack has to live
  somewhere, and a field the sender controls is the one place it must not.
- **`MSG.SPACE` (0x96, server → client), 41 bytes.** Space, building seed,
  position, yaw, and the building's door with its outward normal (the door is
  the building's, derived from the footprint; the frame carries it so a client
  can draw the exit before it has generated the rooms). Sent as the reply to a
  door press and **unconditionally after every welcome** — forty-one bytes to
  say "you are outside" is worth it against a reconnect whose saved spot has
  expired leaving a browser drawing a pub the server has no record of. Absence
  is not a message.

**The space is deliberately not in the snapshot.** Four bytes per player per
snapshot — 25 kbit/s at a full working set — to send a number already known to
be equal: interest filters by space before it measures a distance, so everybody
in a snapshot is by construction in the sender's own space.

## Properties the checks defend

- **Total.** Any wall in sixty kilometres can be walked up to, so a footprint
  the generator cannot read is a crash found by a player. Sixteen footprints are
  asserted through the plan and fourteen through the interior, including a 214 m
  tower, a 400 × 260 m warehouse, a 40 cm sliver, a convex forty-gon, three
  collinear points, one point repeated, an empty polygon and a NaN height.
- **Connected.** Every contact between two rooms becomes a doorway, so the room
  graph *is* the contact graph. `verifyInterior` drives a body through every
  opening in a generated house: a wall that meets in the middle of a doorway is
  a player who walks into a house and can never leave the first room, and
  nothing about that is visible in a screenshot.
- **Closed.** Eight seconds of sprinting at the walls from the middle leaves the
  body inside, in the check and over the real bake.
- **Deterministic** (DESIGN.md rule 5). Integer hashes, never `Math.sin`. Two
  players open one door onto the same rooms with nothing on the wire.
- **A building is never `CITY_SPACE`.** A footprint hashing to zero would put a
  pub's inside on the street and have two players in different worlds swinging
  at each other through a wall.
- **The wall is opaque.** Interest asks about the space before any distance —
  somebody inside a terrace and somebody on the pavement are a metre and a half
  apart in two different worlds, and no radius could ever separate them. The
  same question is asked of the melee candidates one layer down.

`SYDNEY_CHECK_ONLY=interiors` runs the whole round trip over the shipped bake in
a real `Simulation`: a real building found near the spawn, a body let in, the
sprint, out at the door it used, two people handed one inside, a bystander two
metres away who cannot see them, and a log-off/log-in that lands back in the
same room.

## What is not built

- **One walkable storey**, the one you come in at. `floorPlan` generates every
  storey of a 214 m tower and this uses the ground one. The next storey needs a
  stair, a ramp in `groundHeight`, and walls selected by the body's own height —
  all of which the design admits (`InteriorResolver.resolve` is handed `feetY`
  already) and none of which is written. `interiorLine` says so to the player.
- **Almost nothing in the rooms.** One couch, placed by anyone, and no givers,
  quests or loot. See "Furnishing" below.
- **No footballs indoors.** A ball is an object with its own physics against the
  *city's* collision, so one thrown in a pub would sail through the wall.
  `server/sim.ts` clears the throw button for a body inside. Punching works
  normally, which is the half that matters.
- **No pedestrians or police indoors**, for the same reason, and no mounting:
  without that a player at a front window would ride the e-bike on the pavement
  through the wall.
- **The city is neither drawn nor simulated while you are indoors**, which is
  the whole value of an instance and was only half true for a while. The camera
  sits on the interior's own layer, so the city costs zero draw calls; and nine
  of the frame loop's nineteen sections — the streamer, the trains, the street
  lights, the traffic, the crowd, the police, the barks, the faction actors and
  the bikes — are skipped outright. That gate is free rather than a trade
  because those systems are pure functions of `(anchor, index, tick)` and say so
  in their own headers: skipping frames is exact, and walking back out resumes
  with everything where it would have been, with no catch-up.

  What still runs indoors is you and the room: input, the simulation, the
  camera, the HUD, the sky (it drives the four lights the room is lit by), the
  heat (it writes the wanted stars, which must not freeze while you are inside),
  the nameplates and the team rings (indoors those are the people in the room
  with you), and the render. `checkInteriors` asserts the gate **against the
  source**, because a client that simulates a city it cannot see looks perfectly
  correct and merely costs more.

## Furnishing

The rooms are derived and cost nothing to store. **Furniture is the exception**
and is the first thing about an interior that cannot be recomputed from a
footprint, so it is the first thing that is written down and sent:

- `client/src/world/placeables.ts` — the catalogue (one row: a couch), oriented
  boxes, quarter turns in the building's own frame, and the arithmetic both ends
  run. Named `placeables` because `world/furniture.ts` is the *street's*.
- `server/interiors.ts` — space id to placements, on disk, `server/wallets.ts`'
  shape down to the debounce. 64 things a building, 10,000 buildings a box.
- Protocol v25: `FURNISH` (0x17) up, `PLACED` (0x97) down — the whole list every
  time, because a room is not a tick.

`X` opens the customiser indoors; the wheel or `R` turns the couch; left click
places, right click removes the nearest. Both mouse buttons belong to the mode
while it is open, which is why it is a mode: in a game whose only verb is
hitting people, a click that sometimes puts a couch down instead is the worst
ambiguity available.

`Simulation.furnish` decides everything and the browser runs the same
`placementFits` only so the ghost is red on the frames the server would refuse.
Nothing outside the walls, inside a partition, on top of a person, or **across a
doorway** — that last is the one piece of griefing a room has no answer to,
because unlike a couch on a floor it cannot be walked around.

**Anyone can furnish anything**, by the owner's decision, with a $20,000 claim
to come. When it lands it is one test on one line in `Simulation.furnish` and a
field on the store's record; nothing else about that code changes.

## Deploy notes

`DEPLOY.md` §A is the runbook. Build only from a pinned worktree with
`client/public/world` **absent**, boot-gate the server locally before shipping,
and gate on `/health`.

`PROTOCOL_VERSION` moved 22 → 23, so **every tab open across this deploy is
refused and must reload**. That is the version's whole job; it is not a
regression.
