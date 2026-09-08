# GRAPHICS.md — what the renderer is, and the order to change it in

The owner's brief, verbatim: *"the game should get toward GTA 7 graphic"* and
*"revise all graphics from ground up"*.

This document is the honest answer to that. Part one is an audit of the render
pipeline exactly as it stands, surface by surface, with the budgets that bind and
the things three r0.185's WebGPU path can and cannot do here. Part two is the
ordered plan, each item with what it changes, what it costs in draw calls,
pipelines, memory and frame milliseconds, what its offline proof is, and what
only eyes can judge. Part three is what shipped on the night this was written.

Two rules run through the whole thing, and they are why the ranking looks the way
it does rather than like a feature list:

- **A pipeline compiled inside a frame is a stall the player felt.**
  `world/warmup.ts` exists because one 360-degree turn with 56 tiles resident
  once compiled 589 pipelines and put a 1,492 ms frame in the middle of it.
  Anything on this list that multiplies materials is priced against that before
  it is priced against anything else.
- **The palette is measured, and the measurements are load-bearing.**
  `sky/calibration.ts`, `world/cars.ts`, `world/street.ts` and `world/facade.ts`
  publish hundreds of rgb triples produced by a documented chain, and
  `verifyLightRig` bounds the ratios between them. A graphics change that moves
  those silently is not an improvement, it is a regression nobody can name. Every
  item below states whether it can move them and how that is bounded.

---

## Part one: the audit

### 1.1 The renderer

| | |
|---|---|
| backend | `WebGPURenderer({ canvas, antialias: true })`, three r0.185.1. No WebGL2 fallback (`main.ts` puts a fatal on the HUD instead) |
| resolution | `renderScale` 0.75 against `min(devicePixelRatio, 2)`; `+`/`-` move it in 0.05 steps, clamped to 0.5–1.0 |
| tone mapping | Khronos PBR Neutral at `EXPOSURE` 0.62, chosen against ACES and AgX by evaluating all three offline through this exact rig — see the fifty-line block at `main.ts:2043` |
| colour | linear working space, sRGB out; lights and fog written with `LinearSRGBColorSpace` |
| shadows | `PCFSoftShadowMap`, one directional caster, one 4096 map |
| post | **none**, before tonight. No `PostProcessing`, no render target, no resolve. The swap chain is MSAA-resolved by the browser |
| pipeline hygiene | `AsyncPipelines` routes compiles to `createRenderPipelineAsync` and skips an object for a frame or two rather than drawing with an undefined pipeline; `PipelineWatch` subtracts `renderer._pipelines.caches.size` across each render call and reports any frame that paid for a compile |

### 1.2 Every surface, and what shades it

| surface | material | approach | draws |
|---|---|---|---|
| buildings (11 slots: `brick_red`, `brick_cream`, `brick_brown`, `sandstone`, `concrete_precast`, `curtain_wall`, `corrugated_steel`, `render_painted`, `fibro`, `roof_terracotta`, `roof_steel`) | `MeshStandardNodeMaterial` per slot | **already fully PBR**: `MATERIAL_LOOK` in `world/facade.ts` carries a `{ colour, roughness, metalness }` row for every slot, and the shader on top is a large TSL graph — brick courses, corrugation crests, rust that drives roughness *and* metalness, per-window glazing, blinds, doors, posters, a per-building age factor read from a parameter atlas | merged per tile per slot |
| awnings | `world/awning.ts` | own material for the `awning_fascia` slot | per tile |
| fences (3 slots) | `MeshStandardNodeMaterial` | `MATERIAL_LOOK` rows as above | per tile |
| roads / footpaths / kerbs | 3 × `MeshStandardNodeMaterial` | TSL: slab joints, gutter grime, oil, gum, blotch noise; world-metre planar UVs; `polygonOffset -2` | 3 pipelines compiled at startup, never after |
| ground | one shared `MeshStandardNodeMaterial` (`world/ground.ts`, `roughnessNode 0.96`) | TSL | one per tile sheet |
| trees (8 species) | **one** shared `MeshStandardNodeMaterial` (`roughness 0.92`, `flatShading`, `vertexColors`, no `colorNode` at all) | colour arrives through the built-in vertex-colour × instance-colour multiplies; **sway is a `positionNode`** — a height-squared gate, a per-instance golden-ratio phase, a 10 s swell with a 2.6 s gust | one `InstancedMesh` per species present in a tile; ~4 draws for a typical tile's 157 trees |
| water | one `MeshStandardNodeMaterial` for the entire world (`roughness 0.09`) | TSL: two octaves of three directional sines with a closed-form gradient, Schlick at `F0 0.0201`, depth-driven shallows, two analytic sun-glitter terms. **No reflection, no refraction, no render target** | 451 triangles for a full water tile |
| cars | one `car_paint` material for the box fleet (`roughness 0.35`, `metalness 0.4`, `flatShading`, `vertexColors`) + one per glTF model | paint via `instanceColor`, glass/tyre/sill as *multiplying* vertex colours so the fleet stays in one draw | 5 draws at worst per tile; measured worst heading 3,759 cars in 140 instanced draws |
| people | `MeshStandardNodeMaterial` (`roughness 0.6` props, `0.78` body), `SkinnedMesh` + 17 bones | no TSL at all; **not instanced** — a skinned mesh's bones are per-object | one draw per rig from a pool of 12–14 |
| night lights | `MeshBasicNodeMaterial`, additive sprites | seven real lights in the entire scene (see 1.4) | 2 draws for the whole car fleet's lights; one instanced set per tile for lamps |
| far city (beyond 1,800 m) | **one** `MeshBasicNodeMaterial` for the whole world | unlit, so the colours *are* display values; one `SLAB_LIGHT` uniform, written once a frame from the sky phase, is the entire day/night response | 187,981 triangles across 192 per-tile meshes, frustum-culled per tile |
| sky | three's `SkyMesh` — Preetham, turbidity 2.2, rayleigh 1.35, mie 0.004/0.82. No HDRI, deliberately: *"Almost every HDRI on the market is a northern-hemisphere capture"* | plus stars, moon, clouds, dusk limb, night glow | |

Two things are worth saying plainly because they were on the brief as things to
add and are already there:

- **Buildings are already physically based**, with per-material roughness and
  metalness and a great deal of procedural micro-detail. There is no atlas to
  grow and nothing to add a parameter row to. `MATERIAL_LOOK` is typed
  `Record<MaterialName, …>`, so a slot without a row is a **compile error**,
  which is stronger than the check the brief asked for. (`verifyBuildBudget`,
  which the brief named, is unrelated: it is the streamer's *build-time* taper —
  how many milliseconds a frame may spend constructing tiles — and has nothing
  to do with textures.)
- **Trees already sway**, in the vertex shader, phase-stable per instance, and
  the shadow map samples the identical value because it is a nested
  `renderer.render()` inside the same frame.

### 1.3 Lights

Four light objects, total, in a 60 km city, plus seven "real" ones after dark.

| light | type | shadows |
|---|---|---|
| sun | `DirectionalLight` | **the only shadow caster in the build** |
| ambient | `HemisphereLight` | — |
| bounce | `DirectionalLight` aimed opposite the sun at 16° altitude | no |
| moon | `DirectionalLight` | no |

The night rig's seven — torch, train saloon, nearest open train doorway, two
nearest street lamps, two nearest burning cars — are a hard count, not a budget.
`LightsNode.customCacheKey` hashes every light's id and `castShadow`, so
**adding or removing one light rebuilds every pipeline in the scene,
synchronously, inside the frame it happened**. All seven are constructed before
the warm-up, added to the scene, and never hidden; by day their intensity is
exactly zero. The police light bar within 40 m *borrows* the two street-lamp
lights and turns them red and blue rather than adding an eighth.

Everything else at night is additive geometry. **None of the seven casts a
shadow**, and that is a measured decision: a spot shadow is a full depth pass
from a direction that changes every time the player turns their head, so nothing
in it can ever be cached.

### 1.4 Shadows

One directional map, 4096², over a 440 m volume centred on the camera:
**10.7 cm a texel**. `castRange` is a flat 440 m (2 × the 220 m radius, which
covers every caster the pipeline emits up to about 275 m tall; Salesforce Tower
at 263 m is cut early by five metres at the very corner). `receiveRange` is
*computed* rather than constant — the volume is a box in the light's frame, so
its ground footprint reaches `R·hypot(1, 1/sin(alt))`, which is 342 m at 3 pm
against the 220 it used to be set to; that discrepancy was the "flickery"
mid-field a player reported.

The centre is snapped to the texel grid **in the light's frame**, not world XZ —
snapping to world axes snaps to a lattice rotated 57° away from the one that
matters and the edges keep crawling. `PCFSoftShadowMap` was chosen over
`PCFShadowMap` because the latter rotates its Vogel disk by screen-space noise
with no temporal component: still frames were fine and walking produced crawl on
every shadow edge in the frame.

**There are no cascades.** A single map cannot cover 30 km, so it follows the
camera and covers the near field; everything beyond 440 m relies on the sky's
gradient and the fog.

### 1.5 LOD

| band | what draws |
|---|---|
| 0–1,800 m | streamed tiles: real prisms, full facade shader, real trees, real cars, collision inside 420 m |
| beyond 1,800 m | `far.ts` — one convex prism per building over 10 m or 400 m², unlit, one flat colour with a height ramp |

Spec 3.2 asks for four bands with hysteresis on the transitions and impostors
past 2,000 m. What exists is two bands with a hard switch: a slab draws exactly
when its tile is not resident. `far.ts` says so itself — *"no per-building
texture, no block merging, no crossfade"*. Cars have a real LOD (`carlod.ts`
swaps boxes for glTF models with a paint that cannot change across the swap);
trees have **none** — *"the same stem draws cheap at four metres and at four
hundred"*.

### 1.6 What three r0.185's WebGPU path can and cannot do here

**Can, and is not being used:**

- Register a custom tone mapping function through
  `renderer.library.addToneMapping(fn, CustomToneMapping)` — the one constant
  three defines and does not fill. Used tonight; see part three.
- `NodeMaterial.setupOutput(builder, outputNode)`, a documented subclass hook
  receiving the lit `vec4` before fog. Used tonight.
- `material.envNode` / `scene.environment` → `EnvironmentNode`, the real IBL
  path. **Unused, and this is the single largest gap in the renderer**: with no
  environment, the indirect specular term of every `MeshStandardNodeMaterial` in
  the game is fed by nothing. `cars.ts` and `nightlights.ts` both say so in
  their headers.
- `PostProcessing` with `PassNode` chains — bloom, SSAO, DoF, motion blur, TRAA
  all exist in three's addons for WebGPU.
- Compute shaders (`three/tsl` `computeFn`), which is what a GPU-driven cull or
  a particle system would want.

**Cannot, or cannot afford:**

- **More lights, cheaply.** The pipeline-rebuild-on-light-count rule above is
  absolute, so any "more real lights at night" item is really a clustered-forward
  item and that is a renderer rewrite.
- **Instanced warm-up.** `RenderObject.getMaterialCacheKey` appends
  `object.uuid` unconditionally for anything instanced (three.js#29066), so a
  stand-in mesh warms nothing for the instanced populations, which is most of the
  city. Worked around by `TileStreamer.setPrecompiler`.
- **A null-image texture is a crash**, not a warning: `Textures.updateTexture`
  guards `undefined` and `complete === false` but not `null`, and three's shared
  `EmptyTexture` singleton has `image === null`. `world/texture-audit.ts` is a
  guard around that defect, and it is *not* a memory budget — there is no texture
  memory cap anywhere in this codebase.
- **Depth precision at range.** 0.1 m near against a 24 km far gives 1.9 m of
  depth resolution at the streaming radius and 12 m at the 4.5 km edge. Anything
  that wants to sort transparent geometry out there cannot.

### 1.7 The budgets that actually bind

The 1 vCPU box does not render anything and is irrelevant here. What binds:

| budget | value | source |
|---|---|---|
| frame | 16.7 ms at 60 Hz | everywhere |
| render section | **6–9 ms on the machines that struggle** — the only published GPU-side number in the repo | `streamer.ts:608` |
| tile build | 2.5 ms a frame, tapering to a 0.8 ms floor as the frame runs long | `world/buildbudget.ts` |
| ground build | 1.0 ms a frame | `streamer.ts` |
| resident tiles | 220 | `streamer.ts` |
| distinct materials | ~33, each in ≥2 colour pipelines (receiving shadow / not) plus depth pipelines per geometry layout | `warmup.ts` |
| pipelines compiled after boot | **target zero**, watched every frame | `PipelineWatch` |
| world on disk | 16 GB; a tile fetch is ~1.6 MB, four concurrent | `DEPLOY.md`, `streamer.ts` |
| GPU memory | **no stated cap and no instrumentation.** The only VRAM figures in the client are two one-liners: a 512 police atlas and a 111 kB cash-note sheet | — |

There is **no published per-section frame breakdown**. `frameprofile.ts` has
twenty sections and `perf-harness.ts` covers fourteen of them under Bun, but
`render` is explicitly not covered — *"needs a device. That is the point of the
split."* Every millisecond estimate in part two is therefore an *estimate from
draw and pipeline counts*, stated as such, and none of them is a measurement.
**No item below should be believed to within better than a factor of two until
somebody profiles it on a real device.**

---

## Part two: the plan, ranked by visible payoff per cost

Ranked, not sequenced by difficulty. Items 1 and 3 shipped tonight and are struck
through in the table but described in full in part three.

| # | item | payoff | cost | risk |
|---|---|---|---|---|
| 1 | ~~Colour grade (day/dusk/night split-tone)~~ **shipped** | high | ~0 | none — luminance-preserving by construction |
| 2 | **Sky reflection on building glazing** | **highest remaining** | ~15 ALU on facade pixels, 0 pipelines | low |
| 3 | ~~Clearcoat sky reflection on cars~~ **shipped** | high | ~20 ALU on car pixels, 0 pipelines | low |
| 4 | **Aerial perspective on the far city** | high | 1 uniform, ~6 ALU | low |
| 5 | **Baked contact/ambient occlusion in the prism bake** | high | pipeline work, 0 runtime | medium (world rebuild) |
| 6 | **Bloom on emissives** | medium-high | a real post chain: 2–3 passes, ~1.5 ms, MSAA rework | medium |
| 7 | **A tight near shadow cascade** | medium-high | +1 depth pass over ~60 m, +0.8–1.5 ms | medium |
| 8 | **Road decals: lane markings, stop bars** | medium-high | pipeline + geometry work | medium |
| 9 | **Far-city impostors / merged silhouettes** | medium | pipeline work; *saves* runtime | medium |
| 10 | **Screen-space ambient occlusion** | medium | depth+normal prepass or MRT, ~2–3 ms | high |
| 11 | **Water reflections** | medium | a planar reflection pass = a second scene render | high |
| 12 | **Real atmospheric scattering** | low-medium | replaces a dome that is already calibrated | high |
| 13 | **Tree LOD / impostors** | (perf, not looks) | pipeline work; *saves* 483 k triangles | medium |
| 14 | **Motion blur / DoF** | low | a post chain plus velocity buffers | high — and off by default anyway |

### 2 — Sky reflection on building glazing

**The highest-payoff item left, and it is the same twelve lines that shipped for
cars tonight.** `curtain_wall` carries `roughness 0.10, metalness 0.28` and the
facade shader gives every window a glazing-keyed reflectivity — against an
environment that does not exist. A metallic workflow with no environment is a
black object, so **every window in the CBD is a hole**. A tower is the one thing
in this city that is *made of* reflected sky.

- **What changes.** `world/facade.ts` grows a coat term inside its existing TSL
  graph, weighted by the `inWindow` mask it already computes and by the same
  Schlick used in `sky/reflection.ts`. Glass gets a much higher `F0` than paint
  (0.04 flat, and the roughness is already 0.10 so the lobe is tight enough that
  the horizon band reads as a band).
- **Cost.** Zero new materials, zero new pipelines, zero draws, zero memory.
  About 15 ALU on facade fragments, gated to nonzero only where the window mask
  is on. Call it under 0.1 ms; the facade shader is already far heavier than
  this.
- **Offline proof.** `verifyReflection` extended with a glazing case: the
  composite is still convex, so no calibrated brick value can move (the mask is
  zero on brick); and the published `curtain_wall` display values move only
  inside the window rectangle, which the mask makes assertable.
- **Only eyes can judge.** Whether a CBD tower now reads as glass or as a
  disco ball. Spec 7.3 says **never shiny**, and this is the item that argues
  with it — which is why the switch for it should be separate from the cars'.

### 4 — Aerial perspective on the far city

`far.ts` draws 12,778 unlit prisms with one global `SLAB_LIGHT` multiply. They
therefore sit at a uniform pastel from 1.8 km to 4.5 km, with the fog
(`smoothstep(500, 9000, viewZ)`) doing all the depth work. Real distance
haze is not a grey wash, it is *the sky colour, mixed in by distance, with the
low end warmer than the high end*. The single most recognisable "open world"
cue after the grade.

- **What changes.** One extra term in `createSlabMaterial`'s existing TSL: mix
  the slab colour toward the horizon radiance that `sky/reflection.ts` already
  publishes as a uniform, by a smoothstep on view distance and a second one on
  height.
- **Cost.** Reuses the reflection's three uniforms. ~6 ALU on 187 k triangles'
  worth of fragments. Under 0.2 ms. Zero pipelines.
- **Offline proof.** Pure: the mix weight is a function of distance and height,
  so `verifyFar`-style monotonicity and clamps, plus the assertion that at zero
  distance the slab colour is unchanged (so `far.ts`'s published palette still
  means what it says).
- **Only eyes can judge.** Whether the horizon reads as depth or as murk.

### 5 — Baked ambient occlusion per prism

The city has one `contact_ao` slot and no other occlusion anywhere: a doorway
recess, an awning underside, the inside corner of a courtyard and the gap between
two terraces are all lit exactly as brightly as an open wall. This is the largest
*remaining* lighting error in the build and the cheapest place to fix it is the
bake, not the frame.

- **What changes.** `pipeline/` writes a per-vertex AO scalar into the prism
  attribute stream during the mesh stage, from a hemisphere ray cast against the
  tile's own prisms. `facade.ts` multiplies it into `aoNode`, which three's
  standard material already has a slot for.
- **Cost at runtime: one attribute and one multiply.** No pass, no pipeline, no
  memory beyond a byte per vertex. The cost is all in the pipeline, and in the
  retile it forces.
- **Offline proof.** Excellent — this is a pipeline artefact, so the audit is a
  histogram: every tile's AO distribution, the fraction of vertices at 1.0, and a
  render of one tile's AO channel as a PNG.
- **Only eyes can judge.** Whether it reads as grounding or as dirt.
- **Note.** This forces a world rebuild. **Do not schedule it against a retile
  that is already running.**

### 6 — Bloom on emissives

Night lights, the police light bar, lit windows and the sun's specular are all
clamped at 1.0 with nothing to say they were ever brighter. A bloom is what makes
a sodium lamp read as a lamp.

- **What changes.** A `PostProcessing` chain with an MRT emissive target and a
  down/up-sampled blur.
- **Cost, and this is why it is at 6 rather than 2.** It is the first item that
  needs the frame routed through a render target, which means: a target plus its
  depth at the canvas size; the MSAA the browser is currently resolving for free
  has to be done by hand or given up; and the grade shipped tonight would move
  from a free function call into that chain. Two to three passes at `renderScale`
  0.75. **Estimate 1.2–2.0 ms**, on a render section already at 6–9 ms on weak
  machines. That is 15–25% of the remaining frame for one effect.
- **Offline proof.** Weak. The threshold curve and the emissive tagging are
  assertable; the result is not.
- **Only eyes can judge.** Almost all of it.

### 7 — A tight near cascade

10.7 cm a texel over 440 m is good, but the player's own 60 m — the fence post,
the kerb, the wheel arch, their own hands — is where a shadow is read closely. A
second 2048 map over 60 m would be 2.9 cm a texel.

- **Cost.** A second depth render of everything within 60 m. The existing pass
  already draws nine tiles and 2,230 trees inside 440 m; a 60 m pass is perhaps a
  tenth of that geometry but is a whole extra pass with its own state.
  **Estimate +0.8–1.5 ms.** Also **+1 pipeline variant per material** if the
  cascade select is a material-side branch, which would be the expensive way to
  do it and must not be.
- **Offline proof.** The split distance, the texel densities and the blend band
  are pure arithmetic and assertable. The acne and peter-panning are not.
- **Only eyes can judge.** Whether the seam between cascades is visible when
  walking across it.

### 8 — Road decals

`street.ts` refuses these deliberately and says why: *"lane lines, stop bars and
give-way triangles are a project of their own and a half-hearted pass at them
would look worse than clean asphalt"*, and the shader genuinely cannot know which
way a road runs — the carriageway is one unioned polygon per tile with planar
world UVs, *"no edge distance, no per-vertex attribute, no lane centreline"*.

That refusal is correct **for a shader**. It is not correct for the pipeline:
`lanes.bin` already carries every lane centreline in the city, and `chain-lanes.py`
already walks them. Markings belong there, as geometry or as a per-vertex
distance-to-centreline attribute, not as a guess in a fragment shader. High
payoff — an unmarked road is the single most obvious "this is a prototype" cue
left in a street view — at pipeline cost and a retile.

### 9 — Far-city impostors

Spec 3.2's 2,000 m+ band. `far.ts` calls this out as its own named seam. This
one *saves* frame time (187 k triangles across 192 draws becomes a fraction of
that) as well as looking better, and like 5 and 8 it is a pipeline pass.

### 10 — SSAO

Ranked below baked AO because it costs a depth-and-normal prepass or MRT, ~2–3
ms, and buys the same cue that item 5 buys for one multiply. Worth revisiting
only if the bake cannot be re-run.

### 11 — Water reflections

The harbour is the single best view in the game and its water has no reflection
at all — it is a Fresnel blend between a deep colour and the fog colour, plus two
analytic glitter terms. A planar reflection is a second render of the scene with
a mirrored camera: at the harbour that is most of the city twice.
**Estimate +3–6 ms at the one place in the world where the view is already the
most expensive.** Screen-space reflection is cheaper and fails exactly where a
harbour needs it most (off-screen geometry). Real, and expensive, and not next.

### 12 — Atmospheric scattering

The dome is Preetham and it is **calibrated** — turbidity and rayleigh were swept
and move the zenith by under six code values, and the whole light rig is anchored
to its measured radiance. Replacing it with Bruneton or Hillaire means
re-deriving `sky/calibration.ts` end to end. The payoff is aerial perspective
(which item 4 buys for six ALU) and a better twilight (which `dusk.ts` already
draws by hand). **Low payoff, very high cost. Refuse for now.**

### 14 — Motion blur and DoF

Off by default in the brief and they should be off by default in the plan too.
Both need the post chain from item 6, and per-object motion blur additionally
needs velocity buffers, which means a second matrix per instanced object across
a fleet of 3,759 cars. The payoff in a first-person melee game at 60 Hz is
approximately zero.

### What is deliberately not on this list

- **Physically based building materials** — already there (1.2).
- **A micro-detail texture atlas** — the facade shader is procedural and needs no
  texture; adding one would be memory and a texture fetch to replace arithmetic
  that already runs.
- **Foliage sway** — already there.
- **Reflection probes per district.** The right long answer for glass and cars
  both, and a big one: a probe grid, a capture schedule, a memory budget, and a
  per-object probe selection that is a pipeline key if done carelessly. After
  items 2 and 4 have shown what the analytic version is missing.

---

## Part three: what shipped, 2026-09-08

Three commits on `graphics-2026-09`, plus this document. Every existing check
stays green, `npm run typecheck` is clean, and the server boots with the two new
checks in the passing list.

### The grade — `sky/grade.ts`, `sky/gradenode.ts`

A day/dusk/night split-tone: cool shadows, warm highlights, and a night that
loses some chroma the way night vision does. Driven entirely off curves that
already exist in `calibration.ts` — `warmthAt` for the golden hour and
`nightLevel` for the photocell — so there is one clock after sunset and the grade
crosses with the lights rather than at an hour of its own.

**It is built so it cannot move a calibrated value.** Every tint is normalised to
Rec. 709 luminance 1, and saturation is a mix toward the pixel's own luma, so
*the luminance of any neutral surface is preserved exactly* — as an algebraic
identity, at every altitude, for every parameter value, asserted to 1e-12 across
a sweep of the whole day. A sunlit footpath goes from rgb(226,229,231) to
rgb(228,229,228): it stops being faintly blue and becomes faintly warm, and its
level does not move. The dusk and night terms are exactly zero at the reference
instant the palette was measured at, which `verifyGrade` asserts directly.

Integration: `renderer.library.addToneMapping(fn, CustomToneMapping)`. **No
post-processing pass, no render target, no MSAA rework** — six ALU inside a
function that was already being called once per pixel, and three uniforms so the
curve moves all day without recompiling anything. **Frame cost: zero measurable.
Pipeline cost: zero.**

`grade.ts` also carries a port of three's `neutralToneMapping` in plain numbers,
which is the first time the chain documented at the top of `calibration.ts` can
be evaluated inside this repository at all — every published rgb triple in the
codebase was produced by an evaluator that lived somewhere else. `verifyGrade`
pins the port against three fixed points computable by hand, so a three upgrade
that rewrites the curve is a failure rather than a fiction.

Switch: **`GRADE_ENABLED`** in `sky/calibration.ts`.

### The clearcoat — `sky/reflection.ts`, `world/skyreflect.ts`

The environment term the renderer never had. `cars.ts` has said for a long time
that its whole paint palette is lifted above measured reflectance because *"this
renderer has no environment map and no ambient specular"*; this is that term.

The environment is a three-point analytic gradient — ground, horizon band,
zenith — evaluated from the light rig the sky already publishes, rather than a
PMREM. The argument is in the file header and the short version is that at
roughness 0.35 the GGX lobe is about twenty degrees across, and **a
twenty-degree cone average of a cloudless Preetham sky is that gradient**. So
there is no texture, no VRAM, no convolution pass and — the question the brief
asked to have justified — **no refresh cadence at all**: three uniforms, written
once a frame, exact all day, for free. The dome deliberately carries no sun
disc; the `DirectionalLight` already delivers that lobe and a second copy would
double every highlight in the game.

It is applied as a clearcoat, `lit·(1−F) + env·F`, which is what a car has and
is also the formulation that makes it safe over a hand-calibrated palette: a
convex combination cannot exceed `max(lit, env)`, so a surface already sitting at
the sky's own level does not move. `verifyReflection` walks that property over
five lit values, every angle and five directions, and separately asserts through
the real chain that the white-roof anchor holds within two code values while a
black car in shade *gains* — which is the point, and a term that leaves it alone
has not been applied.

The shader hangs off `NodeMaterial.setupOutput`, three's own documented subclass
hook. **Zero new pipelines** (one material each, as before), zero new draws, zero
memory, three uniform writes a frame, and about twenty ALU on a car fragment that
is already doing a full standard BRDF with a shadow gather in it. Both fleets —
the box fleet in `cars.ts` and the glTF fleet in `carlod.ts` — take it through
one factory, because a car that changed its shading as the player walked toward
it is precisely the artefact `carlod.ts` exists to avoid.

**Frame cost, estimated:** a car covers a small fraction of a street view and the
term is ~20 ALU on an already-heavy fragment. Under 0.1 ms of the render section
at any realistic car count. Not measured — see 1.7 on why nothing here is.

Switch: **`CAR_SKY_REFLECT`** in `sky/calibration.ts`.

### The offline proof — `scripts/render-car-sheet.mjs --pbr`

The sheet's scanline rasteriser can carry the coat, so it does. Same Fresnel,
same gradient, per face rather than per pixel because the fleet is flat-shaded
anyway, with an orthographic view ray — which is the one simplification it makes
and it costs nothing at a 320-pixel cell.

The arithmetic exists twice (the sheet is `.mjs` under a bare `node`; the module
is TypeScript) and is fenced from both ends: `SHEET_REFERENCE` and `SHEET_ENV` in
`sky/reflection.ts` are asserted by `verifyReflection` in both boot lists, and
the sheet asserts the same three probes at startup and **refuses to draw** if
they have drifted. Neither copy can be edited alone and get away with it.

Measured over four models in both views: **13.4% of the sheet's pixels move —
which is about all of the car pixels — by a mean of 5.7 code values**, with the
top of the range on the near-black glass and the grazing facets. That is where
the missing term was.

### What only eyes can judge

Four things, and the owner should look at them:

1. **Whether the grade reads as photographed or as filtered.** The numbers say
   three code values of separation in red and five in blue between the dark and
   bright ends of the frame. Whether that is right is taste, and `SPLIT_DAY` in
   `sky/grade.ts` is the one knob.
2. **Whether the night's lost chroma reads as night or as a broken white
   balance.** `SATURATION_NIGHT` is 0.86.
3. **Whether the cars read as painted or as chrome at grazing angles.** The
   `--pbr` sheet answers this for a model on a turntable; it cannot answer it for
   a street of forty parked cars in low sun, which is the case that matters.
   `COAT_MAX` (0.5) is the knob and the header explains why it is capped at all.
4. **Whether a black car in shade is still the darkest thing on the street.**
   The check bounds it against a white roof in sun, but the comparison
   `cars.ts` actually cares about is against *shaded asphalt* two metres away,
   and that is a frame, not a number.

### The follow-up this pass created

`cars.ts`'s eight paint albedos are still lifted above measured reflectance to
fake a reflection that now exists. The coat is a convex mix, so nothing is
double-counted at the sky's own level and no anchor moved — but the dark end of
the palette is now a compensation for a term that is no longer missing.
Re-deriving all eight against a renderer that finally has the environment is a
real piece of work and is now *possible offline for the first time*, because
`grade.neutralToneMap` puts the whole chain in the repository. It should be done
before item 2 makes glass do the same thing.
