# Taking SYDNEY to 60 km

Written 2026-08-08, with the world at a **19.3 km** radius: 3,187 tiles,
470,448 buildings, 3.9 GB published, served from jsDelivr against a one-commit
GitHub data repo. This is the plan for the next order of magnitude, and it is
the plan of record — every number marked *measured* comes from the shipped
build; everything else is extrapolation and says so.

The user's instruction, verbatim: *"i think we need a better cdn. like out to
nepean river like 60km or more from town hall … yes i want the 10s of gbs. but
chunked in segments so its not all at once."*

That last clause is the whole design. **Nothing about this expansion should
ever happen all at once** — not the build, not the publish, not the player's
download, not the server's memory.

## What 60 km is

| radius | area | tiles in the disc | vs today |
|---|---|---|---|
| 19.3 km (today) | 1,170 km² | 4,832 | 1.0× |
| 30 km | 2,827 km² | 11,528 | 2.4× |
| 40 km | 5,027 km² | 20,400 | 4.3× |
| 52 km (M4 over the Nepean) | 8,495 km² | 34,364 | 7.3× |
| **60 km** | **11,310 km²** | **45,704** | **9.7×** |

The M4's Nepean crossing is **52.0 km** from Town Hall (measured). 60 km reaches
past Penrith to the foot of the Blue Mountains, north past Berowra, south past
Waterfall.

**About 39% of the 60 km disc is Pacific Ocean** — a 4,460 km² circular segment
east of the coast — and the pipeline already skips pure-water tiles entirely,
covering them with one far-water sheet. Another large slice is national park:
Royal, Ku-ring-gai Chase, Blue Mountains fringe, Georges River. Those are real
terrain and real roads with almost no buildings, so they cost terrain sidecars
and lane graphs but very little geometry. Emitted tiles will land far below the
45,704 in the disc — the 19.3 km build emitted 3,187 of 4,832 (66%), and that
fraction falls as the ring goes out to sea and into bush. **Expect roughly
20,000–24,000 emitted tiles.**

### Extrapolated size, at today's fidelity

Measured today: 3.9 GB published for 3,187 tiles — 2.0 GB of per-tile files and
1.9 GB of region bundles, which **duplicate** the tiles (that is what buys the
25-requests-per-kilometre win). Per emitted tile: ~630 kB of tile files, ~600 kB
of region share.

At ~22,000 emitted tiles, weighted down for the sparser outer ring (fewer
buildings per tile in bushland and on the fringe):

- **tile files: 9–11 GB**
- **region bundles: 9–10 GB**
- **published total: 18–21 GB**, call it **20 GB**

The user has accepted this. It is worth stating plainly what it buys and costs:
a continuous, real Sydney from the Nepean to the Pacific, and a data set no
free host will carry.

## The CDN: Cloudflare R2

GitHub is out. Its repo ceiling is 5 GB (we are at 4.1 GB and already slicing
pushes to dodge the 2 GB-per-push limit), and jsDelivr is a courtesy service on
top of it, not a contract.

**Cloudflare R2**, because the decisive property is not price but **zero egress
fees**. A world that players stream is an egress problem, and R2 is the only
mainstream object store that does not bill for it.

| | R2 | Backblaze B2 | S3 / CloudFront |
|---|---|---|---|
| storage, 20 GB | ~$0.30/mo | ~$0.12/mo | ~$0.46/mo |
| egress | **free** | free via Cloudflare | ~$0.085/GB |
| 1,000 first visits × 400 MB | **$0** | $0 | **~$34** |
| operations | $4.50/M writes, $0.36/M reads | similar | similar |
| CORS, range requests, custom domain | yes | yes | yes |

At 20 GB stored and, say, two million object reads a month, R2 is **well under
a dollar a month**. Publishing 300,000 objects costs about $1.35 in write
operations, once per full rebuild.

**What only the user can do** (three steps, ~10 minutes):
1. Create a Cloudflare account and an **R2 bucket** (suggest `sydrunner-world`).
2. Create an **R2 API token** with Object Read & Write on that bucket only.
3. Optionally attach a **custom domain** (e.g. `world.bnr.la` on a zone in that
   Cloudflare account) so the client fetches from a stable hostname rather than
   the rate-limited `r2.dev` development URL. Recommended, not required.

The credentials go on the box the way the GitHub token already does —
`/etc/sydney/secrets.env`, mode 0600, outside `/opt/sydney` so no deploy rsync
can put them in the public repo — and into the local publish script's
environment. **They must never be pasted into chat.** The client only ever sees
a public base URL.

The client is already built for this: `client/src/world/cdn.ts` resolves every
world asset through one function, with per-file origin fallback and a five-strike
disable. Swapping jsDelivr for R2 is a base-URL change plus a publish script,
not a rewrite.

## Segmentation — the part the user asked for

Today the world is one atomic thing: one build, one publish, one `index.json`.
At 20 GB every one of those is intolerable. The world becomes **segments**, and
the same segment boundary is used by all four systems below, so there is exactly
one concept to understand.

**A segment is a hexagon** (user's call, 2026-08-08, and the right one).

Concentric rings were the obvious first answer and they are wrong for the stated
goal. A ring's area grows as r², so a 42–60 km ring is ~8,000 tiles against the
core's 3,187 — the units get *bigger* the further out you go, which is the exact
opposite of "not all at once". Hexagons are equal-area by construction, so every
build, every upload and every player download is the same size no matter where
it is, and the last segment is no harder than the first.

Three more properties earn their place:

- **Six equidistant neighbours.** A square grid has neighbours at 1 and at √2,
  so a prefetch radius either over-fetches the diagonals or under-fetches them.
  A hex has one neighbour distance, which makes "load the ring around me" a
  single rule rather than a tuned constant — and the region-bundle prefetch
  (2,200 m trigger today) already wants exactly that shape.
- **No corner convergence.** Rings all meet at the origin, so the busiest part
  of the map is where the boundaries are thinnest. Hexes tile uniformly and put
  no seam anywhere in particular.
- **Boundaries that are not circles.** A ring boundary is a curve every tile
  near it straddles; a hex boundary is six straight lines, and a 500 m tile is
  assigned to a hex by its centre with no ambiguity.

**Geometry.** An axial hex grid in ENU metres — no H3, no dependency; the world
already has a Cartesian origin and this is thirty lines of arithmetic. At a
**6 km circumradius** each hex is 93.5 km² ≈ 374 tiles ≈ 400–500 MB, and the
60 km disc needs ~121 of them of which perhaps 60–70 contain any land. That is
the unit size the whole plan is built around: **small enough to build in under
an hour and upload in minutes, big enough that there are dozens rather than
thousands of them.**

**Detail tiering still works**, it is just no longer intrinsic to the segment: a
hex takes its tier from its centroid's distance from Town Hall, which is one
comparison at build time.

| band | hexes (est.) | est. tiles | est. size | what is in it |
|---|---|---|---|---|
| 0–19.3 km | ~13 | 3,187 | 3.9 GB | today's world, re-cut into hexes |
| 19.3–30 km | ~15 | ~4,500 | ~4 GB | Parramatta, Hornsby, Sutherland, Manly |
| 30–42 km | ~18 | ~6,000 | ~5 GB | Blacktown, Liverpool, Campbelltown fringe |
| 42–60 km | ~22 | ~8,000 | ~7 GB | Penrith, the Nepean, Blue Mountains foot |

The bands are now just a build *order* and a detail tier, not a unit of work.
The unit of work is one hexagon.

Four things then become incremental:

1. **The build.** `scripts/expand-world.sh` already does radius → pre-flight →
   build → audits → publish, and the ledger already makes tile emission
   resumable. It gains a segment argument so a ring can be built, audited and
   published on its own — a 3–5 hour job rather than a 20-hour one, and a failed
   ring costs one ring.
2. **The publish.** One R2 prefix per segment, uploaded independently and
   idempotently (checksum-compared, so a re-publish moves only what changed).
   No single upload is more than a few GB.
3. **The client's index.** `index.json` is **0.8 MB today** and is fetched
   uncached every session; at 22,000 tiles it would be ~5 MB before a player
   sees anything. It splits: a small root index listing the segments and their
   bounds, and a per-segment tile index fetched only when the player comes
   within range of that ring. A player who never leaves the inner city downloads
   the core index and nothing else. The same applies to `street-names.bin`
   (2.4 MB today → ~15 MB) and `far.bin` (3.1 MB → ~20 MB), which both become
   per-segment; the far skyline additionally wants a distance cut, since nobody
   needs Penrith's rooflines from Bondi.
4. **The server's memory.** `server/world.ts` loads all collision and terrain at
   boot: **25.4 MB measured today**, ~180–220 MB at 60 km, against an RSS
   already at 480 MB and a 600 MB cap on a 1 GB box. Either the box grows, or
   the server loads segments on demand — and since a room's players are almost
   always in one part of the map, on-demand is both cheaper and more honest.
   This is the only item on the list that touches the authoritative simulation,
   so it gets its own round and its own checks.

## Detail: my recommendation, and the user's call

The user asked for full fidelity and can have it. But the honest trade deserves
one paragraph, because it is the difference between 20 GB and about 8 GB:

Beyond roughly 25–30 km, players arrive by bike at 39 m/s or not at all. Facade
parameters, street furniture, fences, parked cars and vegetation are ~40% of a
tile's bytes and are authored for someone standing on the footpath. A **detail
tier** on the outer two segments — simplified building volumes, no facade
params, no furniture, no fences — would cut those rings by about half and cost
nothing a player at speed can see. It is one new pipeline concept (a per-tile
tier flag) and it is reversible: the tier is a build-time argument, so a ring
can be re-emitted at full detail later without touching the client.

**Recommendation: full detail to 30 km, reduced beyond.** If the user wants
full detail everywhere, the plan works unchanged at roughly 2.5× the bytes.

## Order of work

1. **R2 + segmented publish** on the *existing* 19.3 km world. Nothing new is
   built; the world moves hosts and gains segment structure, and the client
   learns to read a segmented index. This is the round that de-risks everything
   else, and it is independently useful — it takes us off a 5 GB ceiling we are
   already touching.
2. **Server segment loading**, so the 1 GB box is not the constraint that
   decides the map's size.
3. **`ring1` (19.3 → 30 km)**: prove the segmented build end to end on real
   data, including the anchor re-bake and the seven audits.
4. **`ring2`, `ring3`** on the same machinery, one at a time.
5. **A bigger OSM extract is a prerequisite for all of it** — measured: the
   current `sydney.osm.pbf` covers lon 150.83–151.33, lat −34.06 to −33.68, and
   stops **35 km west**. Penrith is at 150.66. Geofabrik's
   `australia-oceania-latest.osm.pbf` (~1.2 GB) clipped to a 62 km box is the
   fetch, and `expand-world.sh`'s pre-flight already refuses a build whose
   extract does not reach — it caught exactly this on the 52 km scoping pass.

## What does not change

Frame rate. Streaming is player-relative: the renderer sees the same 1,800 m
radius whether the world is 19 km or 60 km across. This is a storage,
distribution and build-time problem from end to end, and the only thing a player
should notice is that the map keeps going.
