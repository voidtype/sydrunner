# Content tooling

Five scripts for writing and shipping a `content/` drop. Every command is
repo-relative; run them from anywhere with `bun run`.

- `entry-validate.ts <entry.json>` -- checks one `{nonce, level, theme,
  quest, npc}` entry against the real parser before it is anywhere near
  `content/`.
- `place-nudge.ts <entry.json>` -- moves any point within 12 m of a track
  22 m clear, perpendicular, in place.
- `place-check.ts <entry.json>` -- reports every point's distance to the
  nearest track and station; also takes raw `<x> <z>` pairs.
- `entry-add.ts <entry.json>` -- merges the entry into
  `content/{quests,dialog}/pool-l<N>.json`, refusing a duplicate id, a
  reused giver first name, or a giver within 25 m of an existing one.
- `content-check.ts` -- the gate: every quest and npc in `content/`
  validates, no name or position collisions, nothing on the tracks, the
  Act 2 register carries ten jobs a rung on schedule, no giver inside a
  building.

A drop runs them in that order, per entry, then the gate once at the end:
`entry-validate` → `place-nudge` → `place-check` → `entry-add` →
`content-check`. A pack is refused **whole** on one error -- see
`server/quests.ts`'s header -- so `content-check.ts` is what has to pass
before anything is pushed, not a thing to fix up after.
