# Content tooling

Ten scripts for writing and shipping a `content/` drop. Every command is
repo-relative; run them from anywhere with `bun run`.

**Two gates, and they ask different questions.** `content-check.ts` asks
whether a pack is *well-formed* -- it parses, nobody stands on the tracks or
inside a wall, the register adds up. `quest-quality.ts` asks whether a job is
*worth doing*, which is a question a pack of four hundred identical errands
passes the first gate without ever being asked. Both have to pass.

- `entry-validate.ts <entry.json>` -- checks one `{nonce, level, theme,
  quest, npc}` entry against the real parser before it is anywhere near
  `content/`.
- `place-nudge.ts <entry.json>` -- moves any point within 12 m of a track
  22 m clear, perpendicular, in place.
- `place-check.ts <entry.json>` -- reports every point's distance to the
  nearest track and station; also takes raw `<x> <z>` pairs.
- `place-clear.ts (--all | <pack> <npc-id>) [--apply]` -- the building half of
  `place-nudge`: walks a giver out of the wall they were written into, to the
  nearest point clear of every solid, 22 m off the rails, 25 m off every other
  giver and still in reach of their station, and drags any quest step pinned to
  their feet along with them. `--all` takes the givers `content-check` convicts.
- `entry-add.ts <entry.json>` -- merges the entry into
  `content/{quests,dialog}/pool-l<N>.json`, refusing a duplicate id, a
  reused giver first name, or a giver within 25 m of an existing one.
- `content-check.ts` -- the well-formedness gate: every quest and npc in
  `content/` validates, no position collisions, no two givers within 2.5 km
  sharing a first name, nothing on the tracks, the Act 2 register carries ten
  jobs a rung on schedule, no giver inside a building.
- `quest-quality.ts [--report]` -- the *fun* gate, and the eight rules are in
  its header. The one that matters most is the owner's: a go-and-talk job is
  refused unless it is a **breadcrumb** -- at least 600 m away, landing where
  two more givers are standing. `--report` surveys instead of refusing, which
  is how you find out that four hundred and twenty-one of five hundred quests
  share half a sentence with a sibling.
- `voice.ts` -- not a command. The three sentence pools (opening, aside, ask)
  that both generators wrap their cores in, and the reason they are three
  pools of 24, 23 and 25.
- `field-gen.ts [count]` -- the five hundred field jobs: twenty archetypes
  crossed with the railway. One giver, one job, everywhere.
- `hub-gen.ts [hubs]` -- the hub jobs: twelve **situations**, each a premise
  with three people and six beats, instantiated at a station. Two of the six
  chain, one is the breadcrumb out to the next hub, and the six have six
  different shapes so no hub is one archetype repeated. It refuses to write
  anything if its own situations fail an authoring gate -- a core that names
  no place, a title two hubs would collide on, or an errand-shaped beat that
  is not the breadcrumb.

A drop runs them in that order, per entry, then the gate once at the end:
`entry-validate` → `place-nudge` → `place-check` → `place-clear` →
`entry-add` → `content-check`. `place-clear` is the odd one out and sits
there because it is the building half of `place-nudge`'s track correction: it
reads the merged packs rather than a loose entry, so a brand new giver reaches
it through `entry-add` and it is run as `--all --apply` just before the gate.
A pack is refused **whole** on one error -- see
`server/quests.ts`'s header -- so `content-check.ts` is what has to pass
before anything is pushed, not a thing to fix up after.

## Regenerating the generated packs

Order matters, and it is not obvious: **`field-gen` first, then `hub-gen`.**
Each reads every giver already in `content/dialog/` so it can keep 30 m clear
of them, so whichever runs second is the one that sees the truth. Run them the
other way round and the field givers are placed against the *previous* hub
positions, which produces a couple of dozen pairs standing two metres apart --
and `content-check` is what tells you, which is the point of it.

```
bun run scripts/content/field-gen.ts
rm -f content/{quests,dialog}/hub-*.json && bun run scripts/content/hub-gen.ts
bun run scripts/content/place-clear.ts --all --apply
bun run scripts/content/content-check.ts && bun run scripts/content/quest-quality.ts
```

`place-clear --all --apply` in the middle is not optional: both generators
place givers against the rails and each other but neither knows where the
buildings are, so a hundred-odd of them land indoors every time and this is the
step that walks them out.
