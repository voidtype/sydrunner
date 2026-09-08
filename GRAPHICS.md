# GRAPHICS.md — what the renderer is, and the order to change it in

The owner's brief, verbatim: *"the game should get toward GTA 7 graphic"* and
*"revise all graphics from ground up"*.

This document is the honest answer to that. Part one is an audit of the render
pipeline exactly as it stands, surface by surface, with the budgets that bind and
the things three r0.185's WebGPU path can and cannot do here. Part two is the
ordered plan, each item with what it changes, what it costs in draw calls,
pipelines, memory and frame milliseconds, what its offline proof is, and what
only eyes can judge. Part three is what shipped on the night this was written and
part four is what shipped the night after -- items 2 and 4, and the follow-up
part three created. **Two of part four's three findings contradict the audit
above them**, and both are left standing with the correction beside them rather
than quietly edited, because how a wrong reading of this renderer looks is worth
as much to the next reader as the right one.

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
| 2 | ~~Sky reflection on building glazing~~ **shipped** | high | ~14 ALU on glazed pixels, 0 pipelines | low |
| 3 | ~~Clearcoat sky reflection on cars~~ **shipped** | high | ~20 ALU on car pixels, 0 pipelines | low |
| 4 | ~~Aerial perspective on the far city~~ **shipped** | high | 1 uniform, ~18 ALU (not the 6 guessed) | low |
| 5 | **Baked contact/ambient occlusion in the prism bake** — **the highest-payoff item left** | high | pipeline work, 0 runtime | medium (world rebuild) |
| 6 | **Bloom on emissives** | medium-high | a real post chain: 2–3 passes, ~1.5 ms, MSAA rework | medium |
| 7 | **A tight near shadow cascade** | medium-high | +1 depth pass over ~60 m, +0.8–1.5 ms | medium |
| 8 | **Road decals: lane markings, stop bars** | medium-high | pipeline + geometry work | medium |
| 9 | **Far-city impostors / merged silhouettes** | medium | pipeline work; *saves* runtime | medium |
| 10 | **Screen-space ambient occlusion** | medium | depth+normal prepass or MRT, ~2–3 ms | high |
| 11 | **Water reflections** | medium | a planar reflection pass = a second scene render | high |
| 12 | **Real atmospheric scattering** | low-medium | replaces a dome that is already calibrated | high |
| 13 | **Tree LOD / impostors** | (perf, not looks) | pipeline work; *saves* 483 k triangles | medium |
| 14 | **Motion blur / DoF** | low | a post chain plus velocity buffers | high — and off by default anyway |

### 2 — Sky reflection on building glazing — **shipped 2026-09-09**

Shipped, and the paragraph that used to stand here was **half wrong**, which is
worth keeping on the record because it is the kind of wrong an audit written off
a material table will be. It said:

> *"`curtain_wall` carries `roughness 0.10, metalness 0.28` and the facade shader
> gives every window a glazing-keyed reflectivity — against an environment that
> does not exist. A metallic workflow with no environment is a black object, so
> every window in the CBD is a hole."*

`world/facade.ts` has carried a hand-authored window reflection for a long time —
`GLASS_SKY`, a two-anchor dome with a fitted falloff, a sun-half gradient, an
aureole and a full Schlick, put through `emissiveNode` so that reflected radiance
does not scale with the irradiance landing on the wall. **By day a Sydney window
was never a hole.** What was actually wrong with it was three things, and they
were one thing:

1. it is frozen at 3 pm — `GLASS_SKY` is a pair of literals off the dome at the
   reference instant, so at golden hour the CBD reflects a blue afternoon over a
   burning sky, which is the fault `sky/dusk.ts` fixed for `scene.fog`;
2. it is switched off after dark by `nightFactor`, and `facade.ts`'s own night
   table says what is left: *unlit glass rgb(0, 0, 0)*. That is the hole, and it
   is a hole for half of every day;
3. `curtain_wall`'s metalness 0.28 hands 28% of its diffuse to an indirect
   specular `EnvironmentNode` feeds and this build never set — and the emissive
   is masked to the *glass*, so the mullion and spandrel grid, which is most of
   a tower's area at any distance where the panes have gone sub-pixel, got none
   of it back.

All three are the term `sky/reflection.skyEnvFor` computes off the rig. See part
four.

### 4 — Aerial perspective on the far city — **shipped 2026-09-09**

Shipped, and the reason it was needed turned out to be sharper than "the fog does
all the depth work". **The fog cannot reach the sky, and it is a type that stops
it.** `Fog.color` is a `THREE.Color`, a `Color` holds three channels in [0, 1],
and the low sky at 3 pm is 2.49 of linear luminance. `main.ts` wrote the
limitation down when it chose the value — *"a `Fog` colour is capped at 1.0
linear so it cannot reach the horizon band's brightness; this gets as close as the
cap allows"* — so distance has been fading the far city toward a value two and a
half times **darker** than the sky behind it. Distance that darkens is murk. See
part four.

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

### The follow-up this pass created — **closed 2026-09-09, see part four**

`cars.ts`'s eight paint albedos are still lifted above measured reflectance to
fake a reflection that now exists. The coat is a convex mix, so nothing is
double-counted at the sky's own level and no anchor moved — but the dark end of
the palette is now a compensation for a term that is no longer missing.
Re-deriving all eight against a renderer that finally has the environment is a
real piece of work and is now *possible offline for the first time*, because
`grade.neutralToneMap` puts the whole chain in the repository. It should be done
before item 2 makes glass do the same thing.

---

## Part four: what shipped, 2026-09-09

Items 2 and 4, and the follow-up part three created — three commits on
`graphics-2026-09-glazing`. Every existing check stays green, `npm run typecheck`
is clean, and the server boots with **three more** checks in the passing list:
`verifyGlazing`, `verifyAerial`, `verifyCarPaint`.

**Zero new pipelines, and here is how that is known rather than hoped.**
`warmup.ts`' own key is `` `${part.material.uuid}|${geometryLayout}|${casts}|${receive}` `` —
the material *object*, not its class. Nothing in this pass constructs a material
that was not constructed before it: one per facade slot, one for the landmark
glazing band, one for the whole far city, and the car fleet's untouched. All
three terms are `setupOutput` subclasses folded into a graph that already
existed, so every cache key in the build is the same string it was yesterday.

### The glazing coat — `sky/reflection.ts`, `world/facade.ts`, `world/landmarks.ts`

The same convex mix as the car coat at glass's own two constants:

    out = lit * (1 - F * mask) + env(reflect(V, N)) * F * mask

`GLAZING_F0` is **0.04**, which is float glass and carries none of `COAT_F0`'s
apology for a lifted palette underneath. `GLAZING_MAX` is **0.85** rather than
the 1.0 real glass reaches at grazing, and the reason is the one `facade.ts`
already gives for its own dome: *"the glass sees an unobstructed dome, so inside
a narrow canyon it reflects haze band where a real window would reflect the
building across the street."* At `F = 1` every tower's silhouette becomes a
perfect mirror of a sky with no city in it, which is a brighter and flatter error
than the one being fixed, and spec 7.3's **never shiny** is aimed at that frame.

**Which slots, which is the question the item asked to have answered.** One
material slot in this city is glazing — `curtain_wall` — and it takes the coat
over its whole surface, mullions and spandrels included. **A window in a brick
terrace is not a slot**: it is a rectangle inside `brick_red` computed per pixel
by the window grammar, and there never will be a slot for it. So the eight other
wall slots (`brick_red`, `brick_cream`, `brick_brown`, `sandstone`,
`concrete_precast`, `corrugated_steel`, `render_painted`, `fibro`) take the coat
through the glass mask and are bit-identical everywhere else. `landmark_glass` is
not a facade slot at all — `world/landmarks.ts`, roughness 0.14, metalness 0.28,
the Sydney Tower turret's observation band and the glazed mouths under the Opera
House shells — and has precisely the same defect, so it is in the same table. The
two roof slots, the awning fascia, the three fences and the seven ground surfaces
carry a zero row, checked by name.

`GLAZING_COAT` lives in `sky/reflection.ts` (three-free, so the server checks it)
and `facade.ts` assigns it to a `Record<MaterialName, number>` — so **a new
material slot with no row is a compile error**, the same guarantee
`MATERIAL_LOOK` gives.

**The one thing to be honest about.** On a window pane the facade's own `glazing`
emissive has already taken its Fresnel share of the outgoing radiance, so the two
coats compose in series and the total reflective share is `f + F − f·F` where the
correct answer is `f`. Head-on that is an over-reflection of `F0·(1 − f)` — about
four points — of an environment that is *dimmer* than the one the emissive uses,
because this one is a twenty-degree cone average and that one is the raw
ten-degree haze peak. At grazing `f` runs to 1 and it vanishes, which is the end
where a mistake would have shown. Feeding the live environment *into* `GLASS_SKY`
instead was the first design and it is wrong: it would darken every window in the
city threefold and move sixteen published display values. The two lobes are both
real and they belong to different roughnesses.

At 3 pm on 15 February, for a shaded curtain wall (first column is what shipped):

    spandrel, near head-on      rgb( 21,  44,  44) -> rgb( 48,  68,  76)
    the same at 60 deg off      rgb( 21,  44,  44) -> rgb(105, 124, 139)
    the same at grazing         rgb( 21,  44,  44) -> rgb(162, 183, 207)
    unlit pane, at night        rgb(  0,   0,   0) -> rgb(  1,   7,  17)
    unlit pane, night, grazing  rgb(  0,   0,   0) -> rgb( 51,  63,  80)

Switch: **`GLAZING_SKY_REFLECT`** in `sky/calibration.ts`, separate from the
car's because spec 7.3's *never shiny* is the standing instruction this term
argues with and two mistakes want two knobs.

### The offline proof — `scripts/render-landmark-sheet.mjs --pbr --mat`

**The landmark sheet does rasterise a glazing material**, and it is the better
subject of the two: `landmark_glass` is real triangles in `landmarks.glb`, and
the turret is a *ring*, so one cell carries the Fresnel from head-on round to
grazing in a single band of pixels.

It needed a second flag to be worth anything. Almost every one of those 8,285
triangles is *behind* something — the mouths are under the shells, the
observation band inside a ring of gold cladding — and a plain sheet of the whole
landmark moves 510 subpixels out of two million with the coat on and off, which
is a picture of nothing. `--mat landmark_glass` drops the other materials from
the *drawing* while keeping the whole landmark's bounding box, fit and scale bar,
so a glass-only cell registers with a full one. With it, 1.21% of the sheet moves
— which is all of the glass — by a mean of 7.6 code values.

The arithmetic is the third copy of `sky/reflection.ts` and is fenced from both
ends like the car sheet's: `SHEET_ENV` and the new `SHEET_GLAZING` are asserted
by `verifyGlazing` on both boot lists, the sheet asserts the same probes at
startup, and it refuses to draw if they have drifted.

### The haze — `sky/reflection.ts`, `world/skyreflect.ts`, `world/far.ts`

    weight = smoothstep(1800, 4500, distance) * exp(-y / 220) * day * 0.36

`AERIAL_MAX` 0.36 is Koschmieder rather than taste: `β = 3.912 / V` at 40 km of
clear-air visibility is 0.098 per km, and `1 − exp(−0.44)` over 4.5 km of air is
0.36. Zero at the near edge is a requirement and not a taper — a slab and the
tile that replaces it stand in the same place until the GLB lands, and a hazier
slab makes that swap a flash — which is why it is a `smoothstep` and not a ramp:
a ramp leaves a first derivative at the streaming radius, and that is a crease
along a seam that is already a seam.

The height term is the half of aerial perspective usually left out and it is
what stops the skyline fading as one card. At 4.5 km a concrete slab at sea level
goes rgb(129,127,125) → rgb(207,216,227) and the same slab 260 m up goes to
rgb(158,161,165) — fifty code values of separation between a tower's base and its
top at identical range, which no single fog factor can produce.

**And it is exactly zero at night, asserted by identity.** `skyEnvFor`'s night
value is a *lighting* floor — the rig holds `HEMISPHERE_NIGHT` up so a player can
see — so at midnight the environment's horizon is nine times brighter than the
far city under `NIGHT_SLAB`, and a haze toward it would turn a silhouette skyline
into a grey one. In-scattering is what aerial perspective is and at night there
is none, which is why `sky/dusk.ts` already takes the fog to 0.016.
`aerialDayFraction` inverts `slabLight` rather than using it, because the number
needed is zero and `slabLight` is 0.14 all night.

Cost, counted rather than guessed: a subtract and a length, a `smoothstep`, a
`max` and an `exp`, two multiplies and a three-channel `mix` — **eighteen ALU,
not the six this document estimated**, because the estimate did not price the
height term. One new scalar uniform; the horizon colour is the coats'.

Switch: **`FAR_AERIAL`** in `sky/calibration.ts`.

### The follow-up, closed — `sky/carpaint.ts`

Part three's follow-up asked for the eight car albedos to be re-derived now that
the environment exists, on the ground that *"the dark end of the palette is now a
compensation for a term that is no longer missing"*. It is done, and **the
premise is half wrong**, which changes what the answer means.

The lift is worth **2.2x** on black — 0.11 against the ~0.05 a real black paint
reflects. The coat is worth **three per cent**: `COAT_F0` is 0.03, and the
cosine-weighted mean of `coatFresnel` over a whole convex body is 0.052. The coat
is a *rim* — half the sky at the silhouette, three points across the panel you
are looking at — and it cannot be what a 2.2x lift was standing in for. Unwinding
the lift on the strength of it would have taken every dark car straight back to
the hole `cars.ts` describes.

So the residual lift stays and is now attributable to what it actually is: **the
analytic dome has no city in it.** No sunlit wall opposite, no footpath, no
awning, no roof of the car in front — which is most of a car's ambient specular
in a street canyon, and which needs the reflection probes listed at the bottom of
part two.

What *was* re-derived is exactly the three per cent, and the reason to bother is
not the level but the **hue**. The coat adds blue-white sky, so it lifts the
channel a paint has least of, which desaturates — `cars.ts`' own warning that
*"the temptation to lift the other two channels for realism is what turns a red
car pink under this tone curve"* describes what the coat had quietly been doing
to the red row since the night it shipped. Red rendered rgb(225, 68, 68) where
the palette intends rgb(227, 58, 52).

    a' = ( a  -  pi * env * F / E ) / ( 1 - F )

A closed form, per channel, no iteration and no fitting. **Done in linear
radiance, which is what makes it exact**: it restores the radiance each paint was
tuned to produce, whatever tone curve, exposure or grade runs afterwards. So
every rgb triple published in `world/cars.ts` is *more* true after this change
than before it, and not one of them needed editing. The reference view is the one
`verifyReflection` already walks — a roof in sun, square to the eye, reflecting
the zenith — because that is the anchor the whole palette is spaced against and
its irradiance has no free parameters.

    white   +2.6%   goes up: white is brighter than the zenith, so the coat was
                    taking light off the anchor
    silver  +2.0%
    grey     0.0%   sits within a tenth of a per cent of the zenith's own level
    black   -0.9%   and twice as far in blue as in red — a black car had been
                    going faintly navy
    blue    -9.0% R
    red     -20% G, -34% B — the largest move, and the one that matters
    green   -7.8%
    beige   +1.7%

The palette moved out of `world/cars.ts` and into `sky/carpaint.ts` with the
derivation above it and `verifyCarPaint` beside it. `cars.ts` keeps the essay;
`LIVERY_WHITE` is now `PAINT[0]` by reference rather than by transcription, which
is what stops the fleet acquiring a second white the moment the palette moves
again.

### The offline proof — `scripts/render-car-sheet.mjs --palette`

The default sheet paints every body one blue on purpose: it is a *geometry*
check. `--palette` draws one model in all eight paints in palette order, and
`--intent` draws the pre-coat table beside it, so two runs and a diff are the
before and after with nothing checked out. Both tables are fenced by
`verifyCarPaint`.

Measured, a Camry in both views: **6.15% of the sheet moves — all of the painted
body — by a mean of 1.62 code values**, white and silver up, grey, black, blue
and red down, and the ordering intact: white is still the brightest paint and
black still the darkest of the four neutrals.

### What only eyes can judge

Four more, on top of part three's four:

1. **Whether a CBD tower now reads as glass or as a disco ball.** This is the
   item that argues with spec 7.3's *never shiny* and `GLAZING_MAX` (0.85) is
   the knob. The numbers say a shaded spandrel goes from rgb(21,44,44) to
   rgb(162,183,207) at grazing; whether that is a glass building or a mirrored
   one is a frame.
2. **Whether the rim the coat leaves on a night skyline is right.** It comes off
   the rig's *lighting* floor rather than the night sky's own radiance — the same
   floor the car coat uses — so it is physically several times too bright. A
   grazing pane at night sits at rgb(51,63,80) against a sky that is nearly
   black. If it reads as rimmed rather than as silhouetted, the fix is a night
   scale on the environment shared by both arms.
3. **Whether the horizon now reads as depth or as murk**, and whether 0.36 is the
   right amount of air over a city that still has `scene.fog` on it as well. The
   two compose and only a frame can say what they compose to.
4. **Whether a street of forty parked cars still reads as a palette.** The
   `--palette` sheet answers it for one model on a turntable under one light; it
   cannot answer it for a kerb in low sun, which is the case that matters.

### The follow-up this pass creates

`GLASS_SKY` in `world/facade.ts` is still frozen at 3 pm. The coat now supplies a
live sky *alongside* it rather than *instead of* it, and the reason is stated
above — the two are different lobes of the same dome and substituting one for the
other would move sixteen calibrated values. The right end state is a second
analytic environment at glass's own roughness, `skyEnvFor` with a
`HORIZON_GAIN` near the raw dome's eight rather than the cone-averaged 2.6,
driven off the rig; then `GLASS_SKY` retires, its display table is re-derived
once, and the CBD's windows turn orange at sunset instead of only getting a warm
rim. Three more uniforms and a page of re-derivation, and it should be done
before anything else touches that shader.
