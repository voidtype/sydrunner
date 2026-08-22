# Content tooling

Six scripts for writing and shipping a `content/` drop. Every command is
repo-relative; run them from anywhere with `bun run`.

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
- `content-check.ts` -- the gate: every quest and npc in `content/`
  validates, no name or position collisions, nothing on the tracks, the
  Act 2 register carries ten jobs a rung on schedule, no giver inside a
  building.

A drop runs them in that order, per entry, then the gate once at the end:
`entry-validate` → `place-nudge` → `place-check` → `place-clear` →
`entry-add` → `content-check`. `place-clear` is the odd one out and sits
there because it is the building half of `place-nudge`'s track correction: it
reads the merged packs rather than a loose entry, so a brand new giver reaches
it through `entry-add` and it is run as `--all --apply` just before the gate.
A pack is refused **whole** on one error -- see
`server/quests.ts`'s header -- so `content-check.ts` is what has to pass
before anything is pushed, not a thing to fix up after.
