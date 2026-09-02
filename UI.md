# UI.md — the interface, from the ground up

The owner: *"Recreate ALL UI and UX devices, including text, e2e in the app.
Needs a complete overhaul. Do some investigation into a sydney style and then
come up with a cohesive proposal, use GTA and skyrim as references for functions
and form ... And also, as a key device, just like in GTA and Skyrim i want hero
text when i enter a new area, that cleanly and smoothly fades in and out."*

This is the proposal and, once shipped, the record. DESIGN.md's eight rules
still bind everything here; rule 6 (*the city reacts; the UI does not shout*)
and rule 4 (*the phone is the interface*) are the two this document is most
often arguing with, and where it wins it says why.

## What was there

Two hundred `div`s, a 2,800-line stylesheet, and one typeface: 11 px lowercase
`ui-monospace`, everywhere, for everything. A previous polish pass had done the
right first thing — nine named greys, two accents (*sun* for you, *harbour* for
the world), four surfaces, a spacing scale — and that structure is kept. What it
could not do with one monospace face at one size is make a wordmark, a place
name, a control and a footnote read as four different kinds of thing. The four
corners were also spoken for by accident of history: diagnostics top-left, map
and tracker top-right, vitals bottom-left, controls bottom-right, and every new
device (heat, investigation, waypoint, level-up) went into the top-centre column
until it was five deep.

## The investigation: what "Sydney" looks like in type and colour

Sydney has a graphic vernacular and most of it is public infrastructure.

- **Transport for NSW** is the single largest piece of graphic design in the
  city. Its wayfinding face is *Frank New* (commissioned, not licensable); its
  signage uses Gotham; and every mode has a colour the whole city can read
  without a legend — train **orange** `#F6891F`, bus **blue** `#00B5EF`, ferry
  **green** `#5AB031`, light rail **red** `#EE343F`. The mode symbols are
  trademarked and are not used; the colours are colours.
- **The NSW Government's digital face is Public Sans** — the state's own design
  system sets it for every `.nsw.gov.au` screen. It is open source (OFL), a
  neutral grotesque with real italics and tabular figures, and it is what a
  Sydneysider reads on a Service NSW form. That makes it the honest choice for
  the interface voice: not "a font that feels Australian", the font the state
  actually uses.
- **The Opera House** rebranded on a bespoke bevelled geometric, *Utzon*
  (Interbrand with Laurenz Brunner). Not available; the lesson taken is the
  form — geometric capitals, wide tracking, one colour — which is also Skyrim's
  Futura Condensed. *Jost* is the open Futura on Google Fonts and carries the
  same 1930s–60s geometric modernism the Harbour Bridge's own signage has.
- **Street signs** in Greater Sydney are white type on green blades. Everybody
  who has ever looked for a house number knows the object. It is the one piece
  of Sydney typography that says *where you are*, which is exactly what the
  locator strip under the map says.
- **Materials**: Harbour Bridge steel (a warm dark grey, not black), the cream
  and green of the ferries, Hawkesbury sandstone (the gold of every colonial
  building in the CBD), the harbour's teal. The palette is those four things.

**Two typefaces, self-hosted** (`client/public/fonts/`, 69 KB of woff2 between
them, both OFL): **Public Sans** for everything you read, **Jost** for everything
that names something — the wordmark, a suburb, a panel's title, an eyebrow.
`ui-monospace` survives in exactly one place, the backquote diagnostics overlay,
because that is a developer's readout and should look like one.

## The references: GTA and Skyrim, by function

| function | GTA V | Skyrim | SYDNEY |
|---|---|---|---|
| where am I | radar bottom-left; street + area text **above** it, in SignPainter | compass strip top-centre | disc **bottom-left** with the **street blade** above it (green, white type); the day/night dial stays top-centre as the compass |
| entering an area | area name low-left, script, ~3 s | *LOCATION DISCOVERED* top-centre, Futura caps, rule, ~4 s | **hero line** top-centre under the compass: Jost caps, tracked, cream, a sandstone rule that draws out; 0.7 s in, 2.6 s hold, 1.3 s out |
| money | top-right, tabular | — | **top-right**, Jost tabular, sandstone |
| the law | wanted stars top-right under cash | bounty in the corner on a crime | heat stars **top-right** under cash; the investigation banner joins them (it was top-centre, in the hero's way) |
| health | thin bars under the radar | three bars low, only while changing | the counted pips, stamina and footy bars **to the right of the disc**, bottom-left, in the same cluster scale as before |
| objectives | bottom-centre, briefly, then the radar | top-right tracker, compass markers | tracker **top-right** under the law; the waypoint needle stays under the compass |
| prompts | bottom-centre, keycap + verb | bottom-centre, keycap + verb | **bottom-centre**, one element, keycap + verb, Public Sans |
| notices | top-left feed | top-left | bottom-centre, sharing the prompt's line, one at a time — rule 6; a feed is a shout |
| the pause / map | full-screen, world hidden | full-screen, world frozen | the world never stops (rule 4), so every panel is a **flat steel surface** over a running city: no blur, no scrim, a hairline and a sandstone top rule |

What is *not* taken: GTA's weapon wheel (one weapon), Skyrim's hidden-until-
changing bars (a melee game reads health constantly), either game's pause.

## The system

### Colour

Named by what it means, as the previous pass insisted. Single theme, dark,
deliberately: the game is night half of every hour and the interface sits over
a rendered sky, not over a page.

| token | value | meaning |
|---|---|---|
| `--steel` | `#14171b` | the ground: bridge steel, a warm grey |
| `--steel-2` / `--steel-3` | `#1c2026` / `#262b33` | a panel; a raised block or a chip |
| `--recess` | `#0e1013` | a field you type into, darker than its panel |
| `--cream` … `--cream-4` | `#f1e9d6` `#c9c2b2` `#8f8a7d` `#5f5c54` | the voice, four steps down |
| `--sandstone` / `--on-sandstone` | `#d9a441` / `#1a1408` | **you**: cash, level, the thing you press |
| `--harbour` | `#3fb4c4` | **the world**: places, distances, other people |
| `--rail` | `#f6891f` | anything on rails |
| `--go` | `#5ab031` | available, sent, ok |
| `--alert` | `#ee343f` | the law, the last pip, a write-off, cannot be undone |
| `--warn` | `#e8b04a` | wrong but fixable |
| `--blade` | `#1f6b3a` | the street sign |
| `--quest` | `#ffd129` | unchanged: `world/questmarkers.FACE_COLOUR` |
| team tokens | unchanged | `game/teams.TEAM_COLOUR` — identity, not styling |

### Type

| role | face | size | treatment |
|---|---|---|---|
| hero (a suburb) | Jost 500 | `clamp(30px, 4.6vw, 52px)` | uppercase, `.18em` tracking, cream |
| wordmark | Jost 700 | 64 / 40 px | `SYDNEY`, tight |
| a panel's title | Jost 500 | 20 px | sentence case |
| eyebrow / label | Jost 500 | 10 px | uppercase, `.22em` tracking, cream-3 |
| body / controls | Public Sans 400/600 | 12–14 px | sentence case |
| numbers that change | Public Sans | — | `tabular-nums`, always |
| diagnostics | ui-monospace | 11 px | the backquote overlay only |

Uppercase is a *transform on Jost labels and the hero*, and on nothing that
carries a name: team names (`Marita`, `DeFAULT`) and player names are never
transformed anywhere — the rule the talents panel already keeps.

### Surfaces and motion

A panel is `--steel-2` with a 1 px `--edge` hairline and a 2 px `--sandstone`
rule along its top; a field is `--recess` inside it; a chip is `--steel-3`. No
`backdrop-filter` anywhere: flat surfaces survive being composited over a
moving render and read as one program. Radii: 3 / 6 / 12 / pill. Motion:
`.14s` for state, `.24s` for a panel, and the hero's own three numbers; every
animation stops under `prefers-reduced-motion`.

### The screen

```
 ┌─ diagnostics (`) ──────── compass dial ─────────── $ cash ──────┐
 │                          waypoint needle            level · xp   │
 │                                                     ★★★☆☆        │
 │                    ┌──────────────────┐             investigation│
 │                    │   M A R R I C K  │  ← hero    tracker       │
 │                    │   ─────────      │                          │
 │                    └──────────────────┘                          │
 │                              ·  reticle                          │
 │ chat                                                             │
 │ ┌ King St · Newtown ┐                                            │
 │ │  ( minimap disc ) │ pips ■■■■□                                 │
 │ │                   │ stamina ▬▬▬▬  footy ▬▬▬       E — go inside│
 │ └───────────────────┘ car ▬▬▬▬▬▬            keys: wasd · e · x  │
 └──────────────────────────────────────────────────────────────────┘
```

### The hero line

`client/src/game/arealine.ts` (pure, both boot lists) decides *when*;
`client/src/arealine.ts` draws it; `#hero` is the element. Three rules that
GTA and Skyrim get from polygons and this game gets from arithmetic, because the
bake has 870 suburb label points and no boundaries:

- **dwell** 2.5 s as the nearest label before it counts as arriving;
- **no encores** for 90 s, so a road along a boundary says each side once;
- **one at a time** — an arrival during a fade waits for the fade-out, and only
  shows if it is still where you are.

The fade is computed, not a CSS transition, so `verifyAreaLine` can assert its
shape: rise to one, hold, fall to zero, never a step over 0.08 in a frame. The
ticker's *"entering Newtown"* notice is retired; this is that notice done
properly.

### Copy

One voice, plain and lowercase where the game talks to you in the moment
(*"E — go inside"*, *"you're in"*), sentence case where it explains
(*"Your level and your cash are on this account."*), Jost capitals where it
names (*NEWTOWN*, *SYDNEY*). No exclamation marks except the investigation
banner's, which is the law shouting, not the interface. Every string in
`index.html` was reread for this pass; the controls list keeps every binding it
had and loses the essays.

## Costs, per rule 8

Two woff2 files, 69 KB, cached forever; zero wire; the hero is one `opacity`
and one `width` write per frame while it is up. The stylesheet went from 2,800
lines to under 1,400 and from fifty-odd hex literals to the table above.

## Checks

- `verifyAreaLine` on both boot lists.
- `verifyIndexDom` gains the hero's ids and the blade's.
- `verifyTeams` is untouched and still greps for a name in the wrong case.
- Rendering is judged by its pure parts; what only eyes can judge — whether the
  cream reads over a noon sky — the owner looks at on the remote.
