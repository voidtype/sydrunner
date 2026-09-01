# INTERIORS — the inside of every building

Working document. Read this before touching anything under "the remaining
work"; it is the handover for a feature that is about a third built.

## The concept, and the owner's decisions

Every building in the city has a door. Opening it lazily generates an inside.
The inside is **its own world instance**, WoW-style — not a hollowed-out
building in the street.

The owner settled three things, and they are not open questions:

- **Global and shared.** One building, one inside, for everybody who walks
  through that door. Not per-party, not per-player. A pub with one drinker in
  it is a worse pub.
- **Persistent.** Log out inside and you log in inside.
- **One door.** You leave by the one you came in.

A loading screen on first entry is acceptable *if it interestingly describes
the phases* — the owner said so explicitly, and WoW's works for that reason.

### Refused, with the reason

**Real-estate photos and floor plans.** Listing photos belong to the agency or
the photographer; shipping them is straightforward infringement. Practically it
is also weak — most buildings were never listed, listings vanish, address→OSM
matching is miserable, and a photo does not become a room. The generator uses
the building's own geometry instead, which is data we already have and which
covers every building rather than a handful.

## Why this is cheap: the data is already on the client

`client/src/player/collision.ts`'s `Prism`, streamed for every building inside
the load radius:

```ts
/** World-space polygon, flattened x,z pairs. */
points: Float32Array;
height: number;
/** Ground height of the building's pad, metres. */
base: number;
```

Plus `prismsWithin(x, z, radius, out)` to find which building you are at. So an
interior needs **no new asset, no bake, no egress** — which matters against the
20 GB/month cap (see `DEPLOY.md`).

The prisms are **convex hulls** (see `world/far.ts` for why the plan stopped
being a rotated rectangle). That is load-bearing twice: the minimum-area
enclosing rectangle is exact over the polygon's own edges, and "closest point on
the perimeter" is exact rather than sampled.

## What is built

All three are pure, import nothing, and run on **both** boot lists
(`client/src/main.ts` and `server/index.ts`).

| file | what it settles |
|---|---|
| `client/src/world/floorplan.ts` | rooms from any footprint. Binary subdivision of the oriented box, keeping cells whose centre is inside the polygon — that one clause is what makes L-shapes, courtyards and horseshoes work with no special case. Depth and per-floor caps make termination a guarantee. `STOREY_M = 3.1`. |
| `client/src/world/doorway.ts` | `doorAt(prisms, px, pz, gazeX, gazeZ)` → the door on the building you are facing, within `DOOR_REACH_M = 2.6`. `buildingSeed(prism)` names a building by its own geometry, rounded to a centimetre before hashing so a float's last bit cannot rename it. |
| `client/src/net/spaces.ts` | `CITY_SPACE = 0`, `spaceForBuilding(seed)` (never zero), `sanitiseSpace`, `sameSpace`. |

And in `main.ts`: the door prompt, wired **last** in the `E` chain —

```ts
takePrompt(...) || (doorSite !== null ? 'E — go inside' : '')
```

`E` already means take a car, board a train, get off a bike, talk to a giver.
Each is a better answer than a door when both are in reach, and the `||` chain
already ranks them, so the door simply asks last. Scratch (`doorPrisms`,
`doorGaze`, `doorSite`, `DOOR_SCAN_M = 12`) is held outside the frame loop.

### Properties the checks defend

- **Total.** No curated building list exists or will: any wall can be walked up
  to, so a footprint the generator cannot read is a crash found by a player.
  Sixteen footprints are asserted, including a 214 m tower, a 400 × 260 m
  warehouse, a 40 cm sliver, three collinear points, one point repeated, an
  empty polygon and a NaN height.
- **Deterministic** (DESIGN.md rule 5). Integer hash, never `Math.sin`. Two
  players open one door onto the same rooms with nothing on the wire, and the
  rooms survive a reload unstored.
- **A building is never `CITY_SPACE`.** A footprint hashing to zero would put a
  pub's inside on the street and have two players in different worlds swinging
  at each other through a wall.
- **The facing test is not politeness.** Without it a door offers itself as you
  sprint along a terrace row and the prompt flickers between six houses.

## What is NOT built

- **Pressing `E` does nothing.** No entry, no transition, no exit.
- **No interior geometry.** The plan is data; nothing renders walls or floors.
- **Nothing on the server.** No space on the wire, no AOI filtered by space, no
  space stored beside `lastPos` — so "log out inside, log in inside" is not real.

## The architecture decision, and why

An earlier plan was to hollow the building in place and let the player walk in.
The owner overrode it: **separate instance per interior**. That is better on
every axis raised —

- There is no facade to open and no collision to swap, so the owner's objection
  ("carving requires a manifold solid") disappears rather than being sidestepped.
  Nothing here is ever a boolean subtraction.
- The streamer can drop to zero radius inside, so the city costs nothing.
- It earns the loading screen.

**The hard part is that the server owns your position.** `net.reconcile` runs
every tick against a server-simulated world, so an instance is not a client
trick — the server must know which space you are in and simulate you there.

## The remaining work, in order

1. **Server first**, because until it exists any interior is a room only one
   player can see.
   - a space field on the wire (`net/protocol.ts` — one file both ends import;
     new messages get a round trip in `verifyNet`, and `PROTOCOL_VERSION` is
     bumped once per shipped batch together with the assertion in
     `server/integration-check.ts`)
   - per-participant space in the sim
   - **AOI filtered by space, asked before distance** — two interiors are
     generated wherever they like and *will* overlap in metres, so distance is
     meaningless across spaces
   - space persisted beside `lastPos` in `AccountRecord` (`net/accounts.ts`);
     absent means `CITY_SPACE`, which is why the city is zero
2. **Client** — walls and floors from the plan under **one shared material**
   (per-building materials would rebuild the pipeline explosion fixed in
   `world/instancepool.ts` / `world/rangealloc.ts`); the transition and its
   phases; exit through the door you entered.

## State at handover

- **Not deployed.** Live is `index-B0H5ERGZ.js` (the onboarding batch). Every
  interiors commit is local only.
- **Not pushed.** ~46 commits ahead of `origin/main`. The owner was asked
  `main` or a branch and has not answered; `CLAUDE.md` says branch first when on
  the default branch.
- Deploy runbook is `DEPLOY.md` §A. Build only from a pinned worktree with
  `client/public/world` absent, boot-gate the server locally before shipping
  (`SYDNEY_PORT=8799 SYDNEY_STATE_DIR=... bun run server/index.ts`, then kill by
  port), and gate on `/health`.
