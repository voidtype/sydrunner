---
name: quest-generation
description: >
  Draft new SYDNEY quests as pool entries another agent can implement without
  talking to anyone: unique by area, level and goal against everything already
  shipped; led through the ten level areas of the city; every one of them
  unmistakably Sydney and written for Australians. Use whenever someone asks for
  new quests, a quest drop, "more jobs", a batch for a level or a suburb, or to
  fill a quest area. Runs `compose.ts` to draft, and tells the implementer the
  exact gate sequence to ship a draft.
---

# Quest generation

A quest in SYDNEY is a JSON record, not code (`client/src/game/questmodel.ts`).
It goes live by being merged into `content/` on GitHub; the server polls it and
refuses a pack **whole** on one error. So a draft is worth nothing until it
passes the two gates -- `scripts/content/content-check.ts` (well-formed) and
`scripts/content/quest-quality.ts` (worth doing) -- and this skill's whole job
is to produce drafts that pass them first time and are not the same quest
twice.

## The three laws, and the one above them

**Above them: Sydney is the content** (DESIGN.md rule 1). A quest that would
work unchanged in a generic city is not finished. Every draft names the real
suburb *and* one specific thing from that suburb's own list in `areas.json` --
a street, a pub, a park, a shop, a train line -- and its goal is a thing
somebody in that suburb would actually want. "Go and find the bloke" is
refused by the gate; "the Marrickville Metro carpark at 6 am" is not.

1. **Unique.** The fingerprint `area | level | goal | specific` must be unique
   across the draft and across every quest already in `content/`. Titles are
   unique across everything. No blurb shares more than half its five-word
   shingles with any other (the gate's rule 3). A giver's first name is not
   reused within 2.5 km of any giver, shipped or drafted. `compose.ts` loads
   the ledger from `content/` and refuses to write a collision.
2. **Aussies.** The people are Sydneysiders and the voice is dry, specific and
   understated. Vernacular is used the way locals use it -- servo, arvo,
   bottle-o, schooner, Opal, RBT, bin night, strata, the Shire, westie, nippers,
   the bowlo, the RSL, the M5 -- never as a costume. **Banned**: crikey, g'day
   mate as an opener, shrimp on the barbie, "Aussie" as an adjective, anything a
   tourist board would print. Sydney's people are also Lebanese, Vietnamese,
   Greek, Italian, Chinese, Indian, Korean, Turkish, Pacific Islander and
   Aboriginal, by suburb; the archetype bank says who lives where and the
   generator draws from it. No one is a joke for where they are from; the joke
   is always the situation.
3. **Quest areas, and the ladder.** The city is ten rungs of three areas each
   (`areas.json`), from the spawn at St Peters outward: L1 is walking distance,
   L10 is Penrith, Hornsby and the Shire. A level's quests concentrate in its
   three areas -- a player standing in Newtown sees twenty jobs, not one -- and
   **one job in six is a breadcrumb** that walks the player at least 600 m to
   the next rung's nearest area, landing where two or more givers stand (the
   gate's rule 1). That is how players are led: not by a marker, by a job that
   ends among six more.

## What a draft is

`scripts/content/drafts/<name>.json`, an array of **pool entries** -- exactly
what `entry-validate.ts` reads -- each wrapped with what an implementer needs:

```
{
  "nonce": "qg-l3-glebe-017",        the draft id, stable across reruns
  "level": 3,
  "theme": "glebe",                   the area id from areas.json
  "quest": { ...Quest },              act 3, level, giver, steps, reward, needFlags
  "npc":   { ...DialogNpc },          the giver: position, root, nodes, improv
  "draft": {
    "area": "glebe", "station": "Glebe",
    "fingerprint": "glebe|3|the-tab|Glebe Point Road",
    "sydney": ["Glebe", "Glebe Point Road", "the Toxteth"],
    "aussie": "the TAB regular",
    "breadcrumb": null | { "to": "central", "station": "Central" },
    "chain": null | { "after": "qg-l3-glebe-016" },
    "implement": "..."                 one paragraph: what to run, in order
  }
}
```

The `quest` and `npc` are complete and valid against `parseQuestPack`,
`parseDialogPack` and `validateBundle` -- `compose.ts` runs them on every
entry -- so an implementer's only work is placement and merging.

## Drafting

```
bun run .claude/skills/quest-generation/compose.ts --count 2000 --out scripts/content/drafts/quests-2000.json
bun run .claude/skills/quest-generation/compose.ts --count 60 --level 4 --area kings-cross --out scripts/content/drafts/kx.json
bun run .claude/skills/quest-generation/compose.ts --count 2000 --packs /tmp/packs   # also write packs of 64, for the gates
```

`compose.ts` is deterministic (`--seed`), so a rerun is a diff. It reports what
it drew -- quests per level and area, goal spread, breadcrumbs, chains -- and
refuses to write if any law is broken.

## Implementing a draft (the part the other agent does)

Per entry, from the repo root, in this order:

1. `bun run scripts/content/entry-validate.ts <entry.json>` -- must print `OK`.
2. `bun run scripts/content/place-nudge.ts <entry.json>` -- off the rails.
3. `bun run scripts/content/place-check.ts <entry.json>` -- read the distances.
4. `bun run scripts/content/entry-add.ts <entry.json>` -- but **not into
   `pool-l<N>.json`**: those are Act 2's register of exactly ten a rung and
   `content-check` refuses an eleventh. Drafts are Act 3 and go into packs named
   `content/{quests,dialog}/area-<area>-<n>.json`, at most 64 quests and 32
   npcs a pack (`MAX_QUESTS_PER_PACK`, `MAX_NPCS_PER_PACK`). `--packs` writes
   them in that shape already; merge those instead of running `entry-add`
   two thousand times.
5. `bun run scripts/content/place-clear.ts --all --apply` -- walks every giver
   out of the building it was written into.
6. `bun run scripts/content/content-check.ts && bun run scripts/content/quest-quality.ts`
   -- both must pass. A failure names the entry; fix or drop that entry, never
   the rule.
7. Commit `content/` and push. There is no deploy: the server polls GitHub.

## What the generator will not do, and why

- It will not write a `goto`-only errand that ends at nobody. Rule 1.
- It will not put two quests with one goal in one area at one level. Law 1.
- It will not spell a faction any way but `Marita` and `DeFAULT`.
- It will not exceed `MAX_TITLE_CHARS` (60), `MAX_LINE_CHARS` (240),
  `MAX_CHOICE_CHARS` (90), `MAX_STEPS` (8), `MAX_CHOICES` (6) or the reward
  caps; a chain never pays less on its second job (rule 8).
- It will not write a quest that names no real place. Rule 2, and the law above
  the laws.
