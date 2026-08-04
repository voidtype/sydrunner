# SYDNEY — Build Specification

**A browser-based multiplayer melee FPS set in a geometrically accurate Greater Sydney.**

Version 2.0 · Written for an implementing AI agent · Personal/private project, no public distribution

---

## 0. Instructions for the implementing agent

Read this document in full before writing code.

Four rules that override your defaults:

1. **Every building in the world gets identical authoring quality.** Real footprint, real height, real roof form, procedurally generated facade. There are no "good areas" and "cheap areas." See §3.
2. **Do not choose the backend infrastructure.** Build the client and the data pipeline first. When you reach the point defined in §9, **stop and ask the user** the question written there. Do not guess, do not pick a "sensible default", do not scaffold a server before asking.
3. **Do not use Gaussian splatting or photogrammetry mesh as shipped world geometry.** §11 explains why.
4. **The target machine has no NVIDIA GPU.** Any tool requiring CUDA is off the table. Verify Apple Silicon support before adding a dependency.

Ask clarifying questions early and in batches. Do not silently make architectural decisions that are expensive to reverse.

---

## 1. Target hardware

The user's machine, verified:

| | |
|---|---|
| Machine | Mac mini (2023) |
| Chip | Apple M2 Pro |
| Memory | 16 GB unified |
| OS | macOS Tahoe 26.4.1 |
| Display | DELL P3221D, 2560 × 1440 |
| Free disk | 74.29 GB of 494.38 GB |

### What this forces

- **No CUDA.** No `gsplat`, no CUDA COLMAP, no NVIDIA-dependent reconstruction. Everything in the asset pipeline runs on Apple Silicon (Metal, CPU, or WebGPU).
- **16 GB is shared between CPU and GPU.** Never load a whole-city dataset into memory. The pipeline is out-of-core and tile-streaming throughout.
- **74 GB free is a throughput constraint, not a coverage constraint.** Raw LiDAR for the full urban footprint is roughly 48 GB, but it is *streamed*: download a tile, extract, write a few KB of result, delete the source. Working set must never exceed ~15 GB. Enforce this in code, not by convention.
- **2560 × 1440 is 3.7 M pixels** — a real fill-rate load for an integrated GPU in a browser. Default to 0.75 render scale with upscaling; expose a resolution slider. **Degrade resolution before you degrade draw distance or facade quality.**
- **Browser:** Safari 26 (Tahoe) or Chrome, both with WebGPU. Prefer WebGPU; WebGL2 fallback only if cheap.

---

## 2. Product definition

A first-person melee brawler where a handful of friends fight in a recognisable Sydney. Runs in a browser. The user hosts the server himself.

- **Players:** 2–16. Not designed to scale further.
- **Distribution:** none. Private link, friends only. Not a commercial product, will not be published.
- **Combat:** punching only. No firearms, no projectiles.
- **Tone:** the world is straight and accurate; the characters and combat are broad and silly. That contrast is the point — do not stylise the city to match the characters.

### Licensing consequence of "no distribution"

ODbL and CC BY-SA share-alike obligations attach to *distribution*, not use. Because this build is never distributed, OpenStreetMap data, Microsoft building footprints, and Mapillary imagery can all be used freely, including baking Mapillary pixels into textures.

Two things remain off-limits regardless (§11): caching or deriving geometry from Google Maps Platform tiles, and anything requiring the user to fly a drone.

---

## 3. Extent and quality

**Requirement: full Greater Sydney, extending as far from the CBD as achievable, with every building realistic.**

### 3.1 Uniform authoring — non-negotiable

Every building in the dataset, from Circular Quay to Penrith, gets the same treatment:

- real footprint polygon (Microsoft / OSM)
- real height, from LiDAR P99 of returns inside the polygon
- real roof form, from RANSAC plane fitting against the point cloud
- procedurally generated facade derived from that building's actual attributes (§6)
- correct material for its era and type

There is no tiering of authoring quality by distance from the CBD. If a building exists, it is built properly. The user will walk to Marrickville and Ashfield and Hurstville, and those need to hold up exactly as well as Pitt Street does.

### 3.2 Runtime LOD — retained, and it is not the same thing

Runtime LOD is a *rendering* optimisation: the identical asset drawn with fewer triangles and a cheaper shader when it's far from the camera. This is mandatory — no engine can draw a million buildings without it, and it is invisible to the player by construction.

| Distance | Geometry | Facade |
|---|---|---|
| 0–80 m | Full mesh, geometric window reveals, balconies, awnings, sills | Full material + parallax + decals |
| 80–400 m | Simplified mesh, flat facade plane | Parallax-mapped windows, full material |
| 400–2,000 m | Roof form + massing | Baked facade albedo, no parallax |
| 2,000 m+ | Impostor / merged block silhouette | Single averaged colour |

Transitions are distance-hysteresis with a short dither cross-fade. If a pop is visible, the bands are wrong — widen them, don't remove the system.

**The critical design point:** facade detail lives in the *material*, not the *mesh*. Window grids at correct floor heights, correct rhythm, correct reveal depth are achieved with parallax occlusion mapping against a per-building UV parameterisation. That costs zero extra triangles, which is precisely what makes uniform quality across a million buildings affordable. Geometric insets are added only inside 80 m.

### 3.3 Extent target

Build outward from the CBD until the machine complains, in this order:

1. Sydney LGA + inner ring (Alexandria, Redfern, Surry Hills, Newtown, Pyrmont, Glebe, Darlinghurst, Ultimo, Chippendale, Waterloo, Zetland)
2. Out to ~15 km: Marrickville, Bondi, Balmain, Leichhardt, Randwick, North Sydney, Chatswood, Rockdale
3. Out to ~35 km: Parramatta, Bankstown, Hornsby, Sutherland, Manly
4. Terrain and coastline to the horizon beyond that, buildings optional

Ship at stage 2, extend in place. The tile format and streaming must support adding coverage later without rebuilding.

### 3.4 Output budget

| Asset | Size |
|---|---|
| Building geometry, full extent, Draco + quantised | ~2.5 GB |
| Terrain | ~300 MB |
| Facade trim sheets + decals, KTX2 (BasisU) | ~800 MB |
| Props, vegetation, characters, audio | ~400 MB |
| **Total** | **~4 GB** |

Comfortable. Disk was never the real limit — download time is.

---

## 4. Data sources

| Source | What | Licence | Notes |
|---|---|---|---|
| **ELVIS** (`elevation.fsdf.org.au`) | LiDAR point cloud (LAZ) + 1 m DEM | CC BY 4.0, commercial use permitted | 15 GB per request cap. Script sequential orders across the full extent. **Delete each LAZ after extraction** |
| **Microsoft Australia Building Footprints** | 11.3 M footprint polygons, GeoJSON | ODbL | Primary footprint source, national coverage |
| **OpenStreetMap** (Geofabrik NSW extract) | Roads, footpaths, `building:levels`, `building:material`, `roof:shape`, `start_date`, shops, stations, cafés | ODbL | Attribute source for the facade grammar. Not the live API |
| **Mapillary** | Street-level reference + CV detections (signs, poles, markings) | CC BY-SA 4.0 | Free API. Image Radius Search against building centroids builds an automatic reference library. bbox queries < 0.01° square; use the Python SDK above that |
| **Poly Haven / ambientCG** | PBR materials, HDRIs | CC0 | No attribution required |
| **Fab Megascans starter pack** | 1,500+ surfaces, decals, scans | Free tier, any engine | The decals matter — see §7.6 |
| **Kenney / Quaternius** | Low-poly rigged characters | CC0 | Character bases — see §8.1 |

---

## 5. Asset pipeline

Runs offline on the Mac, outputs static files. Python. **Must be resumable** — if it dies on tile 4,000 of 12,000 it resumes at 4,000. Keep a SQLite job ledger of tile state.

```
Footprints (GeoJSON) ──┐
OSM attributes ────────┼──► spatial join ──► per-building attribute record
LiDAR tile (LAZ) ──────┘                              │
      │                                                │
      └─ delete after extraction                       ▼
                                    height  = P99 of returns in polygon
                                    roof    = RANSAC plane fit + form classify
                                    floors  = height / era-typical floor height
                                    era     = start_date | inferred (§6.2)
                                                       │
                                                       ▼
                                          FACADE GRAMMAR (§6)
                                     → mesh + per-building UV params
                                                       │
                                                       ▼
                                 tile → merge by material → LOD chain
                                                       │
                                                       ▼
                                 Draco + meshopt + KTX2 → glTF tiles
                                                       │
                                                       ▼
                                        spatial index (JSON quadtree)
```

**Tools:** PDAL (point cloud, Apple Silicon native), Shapely/GeoPandas, trimesh or Blender headless, `gltf-transform`.

**Collision is always the simplified prism**, regardless of what's rendered. Convex, cheap, 16 players on one server core. Emit as a separate lightweight payload the server loads directly. Never derive collision from render meshes at runtime.

**Coordinates:** work in MGA2020 Zone 56 (EPSG:7856), origin-shift to a local ENU frame centred on the CBD for runtime. Never use raw lat/lng in the engine — float precision will fail.

---

## 6. Procedural facade generation

This is the core of the "realistic buildings" requirement and the single largest piece of work in the project. Treat it as such.

### 6.1 What is and isn't achievable — read this before promising anything

No dataset on earth contains true facades for a million buildings, for any city. What is achievable, and what this system must deliver, is **facades that are correct in every measurable respect**: right floor count, right floor heights, right window rhythm and proportion for the building's era and type, right material, right ground-floor treatment, right roof.

The result is a building that is *right* rather than *photographed*. Standing in front of your own street, you will recognise the massing, the material, the storey count, the shopfront line and the roof. You will not recognise the individual window mullions. That is the ceiling of what physically exists as data, and it is far above flat boxes.

The ~40 structurally unique landmarks (Opera House, Harbour Bridge, Sydney Tower, ANZAC Bridge, the QVB, Central's clock tower) get hand-modelled. Not because they're in a better tier — because shape grammar cannot produce sculpture.

### 6.2 Archetype classification

Every building is classified into one archetype before facade generation. Use OSM tags where present, infer where absent from footprint area, footprint shape regularity, height, storey count, and neighbourhood context.

| Archetype | Signals | Facade character |
|---|---|---|
| Victorian/Federation terrace | 1–2 storeys, narrow deep footprint, row-adjacent, inner suburb | Parapet, iron lace balcony, tall narrow sash windows, 3.2 m floors |
| Federation freestanding | 1–2 storeys, detached, red brick era | Gable/hip roof, bay window, verandah |
| Interwar apartment | 3–4 storeys, rectangular, cream/brown brick | Regular punched windows, brick banding, flat parapet |
| Mid-century walk-up | 3–5 storeys, cream brick, 1950s–70s | Horizontal balcony bands, aluminium sliders |
| Brutalist / 60s–70s office | 6–20 storeys, concrete | Deep reveals, precast panel grid, vertical fins |
| Contemporary tower | 20+ storeys, glass | Curtain wall, spandrel bands, no reveal |
| Warehouse / industrial | Large footprint, low, irregular | Corrugated cladding, sawtooth roof, high strip windows |
| Suburban brick-veneer house | Detached, 1 storey, outer suburb | Tile roof, garage, aluminium windows |
| Retail strip shopfront | Ground floor on a retail-tagged street | Full-width glazing, continuous awning, signage band above |
| Modern infill apartment | 4–8 storeys, post-2000 | Mixed render/glass, projecting balconies |

Ten archetypes covers well over 90% of Sydney. Add more only where a visible gap appears.

### 6.3 The grammar

Per building, generate:

- **Floor division.** `floors = round(height / floor_height[archetype])`, then redistribute so floors divide the height exactly. Ground floor is taller than upper floors in every commercial archetype.
- **Bay division.** Divide each facade edge into bays of archetype-typical width (2.4 m terrace, 1.5 m curtain wall, 6 m warehouse). Terminate with a partial bay at corners, never stretch.
- **Window placement.** Per bay per floor, with archetype-specific sill height, head height, width ratio and reveal depth. Deterministic seed from the building ID so it never changes between builds.
- **Ground floor override.** If the building fronts a street with OSM retail tagging, replace ground floor with a shopfront: full-width glazing, continuous awning at 3.2 m, signage band. This one rule does an enormous amount of work — it's what makes King Street and Redfern Street read correctly.
- **Roof.** From the RANSAC fit: flat, skillion, gable, hip, sawtooth, or parapet-hidden. Add plant, aircon units, and lift overruns on flat commercial roofs; chimneys and vents on residential.
- **Openings.** Front door placed on the street-facing edge, at the bay nearest the footprint centroid.

### 6.4 Facade rendering

The generated grammar becomes **per-building UV parameters plus an archetype trim sheet**, not per-window geometry. The shader does:

- window grid from the UV params (floor lines, bay lines)
- parallax occlusion for reveal depth — this is what sells it, and costs nothing
- per-window randomised interior: lit/unlit, blind up/down/half, curtain colour. Deterministic per window ID. **At night this is the single most alive-looking thing in the game**
- reflection intensity keyed to glazing type

Geometric window reveals, balconies, sills and awnings are added as real geometry only inside 80 m, swapped in by the runtime LOD system.

### 6.5 Validation

Build a debug view that drops the camera at a random street address and renders the building alongside the Mapillary image for the same coordinate, side by side. Spot-check 50 buildings per archetype. If the storey count or the shopfront line is wrong, the classifier is wrong — fix the classifier, don't hand-patch buildings.

---

## 7. Environment realism

Not suggestions. This is where "feels like Sydney" comes from and it is cheaper than geometry.

### 7.1 The sun — highest priority item in this document

Sydney is at **−33.87° latitude, 151.21° longitude.**

**The midday sun is in the NORTH. Shadows fall SOUTH.** Solar noon altitude ~79° at the December solstice, ~33° at the June solstice.

Implement an analytic sky (Hosek-Wilkie or Preetham) driven by a real solar position calculation. **Do not use a downloaded HDRI** — almost all are northern-hemisphere captures and will put the sun in the wrong half of the dome. An Australian player feels this within seconds without being able to name it.

Light character: harsh, high contrast, deep shadows, blown highlights, hard blue sky. Not soft, not grey, not European.

### 7.2 Overhead power lines

Timber poles with strung catenaries along every inner-suburban street. **Highest recognition-per-triangle feature in the project.** Instance poles, render lines as camera-facing quads. Positions from OSM `power=pole` where tagged, otherwise procedural at ~40 m on the kerb line of residential streets.

### 7.3 Materials

Ten materials on trim sheets, selected by archetype and OSM `building:material`:

Hawkesbury sandstone (warm buff-honey with iron banding, **not grey**) · Federation red brick (dark red-brown, **not orange**) · mid-century cream brick · weathered galvanised corrugated steel (dull zinc-grey, **never shiny**) · muted terracotta roof tile · board-formed and precast concrete · fibro sheet with cover strips · painted render in inner-west pastels · blue-metal road with sandstone kerbing · blue-green highly reflective curtain wall.

### 7.4 Roofs

Enormous screen area in any game with verticality. Corrugated steel and terracotta dominate the inner suburbs; plant rooms, lift overruns and aircon arrays in the CBD. Get roof material right before spending effort anywhere else.

### 7.5 Vegetation

Species matter more than quality. **Moreton Bay figs** (massive, buttressed — parks), **plane trees** (CBD street tree), **jacarandas** (purple; bloom Oct–Nov if seasons are implemented), **paperbarks**, **brush box**. No oaks, no maples, no conifers — they read American instantly. 6–8 species, 3 LODs each, billboard beyond 150 m.

### 7.6 Decals

Cheapest large win available. Scatter procedurally, weighted by surface normal and height:

water staining below sills and aircon units · rust runs from fixings · poster residue on poles and blank walls · tag-level graffiti at reachable height · oil staining on driveways and laneways.

Budget real effort here — more than on facade geometry.

### 7.7 Street furniture

Continuous cantilevered **awnings** over the footpath on every retail strip · red/yellow/green wheelie bins on kerbs · Ausgrid substation kiosks · AS 1742 signage with white-on-green street name blades · **left-hand traffic** with parked cars facing accordingly · sandstone kerbing.

And ibises. Non-negotiable. Idle animation, scatter near bins and parks, flee on approach.

---

## 8. Gameplay

### 8.1 Characters

Low-poly, exaggerated, comical. Big heads, noodle arms, oversized hands. Deliberately at odds with the accurate city.

- **Budget:** < 2,000 triangles, one 512×512 atlas, < 20 bones
- **Base meshes:** Kenney or Quaternius CC0 packs, modified
- **Animations:** idle, walk, run, jump, punch wind-up, punch, flinch, knockout
- **Variants:** 6–8 colourways, player picks one. No customisation system

### 8.2 Punch

- **Input:** left click. Wind-up ~150 ms, active window ~100 ms, recovery ~250 ms
- **Detection:** sphere-cast from camera, ~1.2 m reach, ~0.4 m radius
- **Server-authoritative** with lag compensation — rewind remote positions to the attacker's view time before evaluating
- **Effect:** damage plus comically excessive knockback. 6–8 m of flight, not 1 m of stagger
- **Ragdoll** on knockout, 3 s, respawn at a nearby street corner
- **Stamina:** 4 punches then 2 s recovery. Prevents click-spam, creates rhythm
- **Feedback:** screen shake, loud unrealistic impact, brief hitstop on the attacker. Sell it through audio and camera, not gore

No world-space health bars. Health pips in the corner.

### 8.3 Powerups from real map features

Both from live OSM data — the point is that they exist where the real thing exists.

**"Training" — train stations.** Touch a station entrance (`railway=station` / `railway=subway_entrance`) for **+40% punch damage and +25% movement speed, 45 s.** Pickup animation: sprinting on the spot with comically fast legs. Sydney's station network makes these natural contested objectives — Central, Redfern, Town Hall, Newtown, Erskineville, Green Square. Respawns 90 s after pickup.

**"Flat White" — cafés.** Touch an `amenity=cafe` node for **+60% movement speed, +100% jump height, −20% punch damage, 30 s.** Fast and twitchy but you hit like a wet paper bag. Mild screen shake and raised FOV for the duration. Hundreds of these in the inner suburbs — the abundant low-stakes pickup that keeps traversal interesting between station runs.

*(Alternative if preferred: `amenity=pub` → "Schooner", damage up with camera drift. Implement the café version by default.)*

Both spawn as floating rotating icons at the mapped coordinate, visible through geometry to 60 m with a soft outline. Server-authoritative pickup.

---

## 9. ⚠️ DEFERRED DECISION — ASK THE USER

**Do not decide any of this yourself.**

Build in this order: asset pipeline → client renderer → walkable single-player → punch and powerups against a local stub.

**When the single-player build is walkable and you are about to write the server, STOP and ask:**

> I'm ready to build the backend. Four decisions are yours:
>
> 1. **Runtime** — Node/Bun (fastest to write, shares types with the client), Go (best concurrency-per-watt, easy static binary), or Rust (best performance, slowest to iterate)?
> 2. **Hosting** — the Mac mini itself, a separate box on your LAN, or a VPS? This determines NAT traversal and how we get a public TLS cert for HTTP/3.
> 3. **Tile serving** — static files behind nginx/Caddy, or a tile server with range requests and cache headers?
> 4. **Persistence** — none (ephemeral matches), SQLite (stats, names), or heavier?
>
> Default recommendation if you'd rather not decide: **Bun + Caddy on the Mac mini, static tiles, no persistence.** But tell me what you'd prefer.

Wait for the answer. Do not proceed past this point without it.

---

## 10. Networking

- **Transport: WebTransport datagrams.** Baseline since March 2026 — unreliable, unordered, each message supersedes the last, over HTTP/3 and QUIC. No head-of-line blocking, unlike WebSockets over TCP. **Requires HTTP/3 and a valid TLS certificate — not optional.**
- **Fallback:** WebRTC DataChannel unreliable mode (`geckos.io` / `node-datachannel`)
- **Model:** authoritative server, 60 Hz tick, snapshots at 20–30 Hz
- **Client:** prediction for local player, snapshot interpolation for remotes (~100 ms buffer), reconciliation on correction
- **Server rewind** for punch validation, capped at 250 ms
- **Bandwidth:** < 30 kbit/s per player downstream at 16 players. Quantise hard — the world is metric and 1 cm is plenty

---

## 11. Milestones

| # | Deliverable | Done when |
|---|---|---|
| 1 | Footprints → massing tiles, inner ring | ~10 km² loads in a browser at 60 fps |
| 2 | LiDAR height + roof extraction, streaming with deletion | Buildings have correct heights and roof forms; disk never exceeds 15 GB working |
| 3 | **Archetype classifier + facade grammar** | Debug view shows generated facades beside Mapillary images and they match on storey count, material and shopfront line |
| 4 | Facade shader — parallax windows, lit interiors | It looks right at night |
| 5 | Sun, sky, materials, decals | It looks like Sydney at 3 pm in February |
| 6 | Full extent, streaming, runtime LOD | You can walk from Alexandria to Marrickville without a quality change |
| 7 | Player controller, character, animation | Walkable single-player build |
| 8 | **STOP — ask §9** | User has answered |
| 9 | Server, transport, replication | Two browsers see each other move |
| 10 | Punch, knockback, ragdoll | Two players can fight |
| 11 | Powerups from OSM | Stations and cafés work |
| 12 | Hero landmarks, audio, ibises, power lines, props | It's fun |

Milestones 3 and 4 are the project. Everything else is comparatively routine. Do not under-resource them.

---

## 12. Explicitly out of scope

**Gaussian splatting.** A rendering primitive, not a game world. No collision, no dynamic lighting response, can't be animated, sorts badly against translucency, bypasses engine GI. One million gaussians costs 180–220 MB of GPU memory and an entire 60 fps frame budget on hardware stronger than the target. One city block is 5–10 M gaussians. Cannot work here, and the target machine can't train them anyway without CUDA.

**Google Photorealistic 3D Tiles as world geometry.** The Maps Platform terms prohibit caching and prohibit creating content derived from Google Maps Content, with tracing building outlines and deriving 3D building models called out by name. This applies regardless of distribution — it is a contract term, not a copyright question. Streaming P3DT live in a separate throwaway viewer is fine and effectively free (1,000 root-tile requests/month, each ~3 hours) but that's a sightseeing toy, not this project.

**Photogrammetry mesh as shipped geometry.** Continuous mesh draped over everything including trees and power lines. No per-building separation, melted geometry exactly at eye level, unusable collision, enormous atlases. If the user later buys an Aerometrex/MetroMap clip it is **modelling reference only** — load in Blender, model clean geometry against it, ship the clean geometry.

**Drone capture.** The target area is inside Sydney Airport's Class C control zone, covering the CBD, harbour and most inner suburbs from the surface up. Recreational flight there is effectively prohibited. Design nothing that assumes new aerial capture.

**Guns, gore, progression, matchmaking, anti-cheat.** Out of scope. It's a punching game for friends.

---

## 13. Definition of done

The user sends a link to five friends. They open it in a browser and within ten seconds they're standing on a street in Alexandria they recognise — right terrace parapets, right shopfront line, right corrugated roofs, shadows falling south — punching each other into the middle of Botany Road while a train station glows two blocks away. Then they run to Marrickville and it's just as good there.
