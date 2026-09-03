# TERRITORY — the turf war over Sydney's hexagons

The owner's brief, 2026-09-04: *"Introduce capture the flag where sydney
regions get taken over by Marita or DeFAULT and make that visible as the
default map view, with a circle drawn on the edge. derive the circle if u
can."*

## What it is

- **The regions are the streaming hexagons.** `world/hexes.ts` already cuts
  the 60 km disc into 86 hexagons of 6 km circumradius, keyed by axial
  `(q, r)`, with their centres in world metres on both ends. A hexagon is a
  few suburbs, which is the size a side can hold between Mondays; suburbs
  (870) would be unreadable and unwinnable. Each is named, where the map or
  the feed needs a word, for the suburb nearest its centre (`nearestName`).
- **The rule is a margin.** A KO of somebody not on your side is one point for
  your side in the hexagon the victim fell in. The side with a lead of two
  holds it; inside the margin the holder keeps it (`captureOwner`). No decay,
  no presence scoring, and the whole ledger clears with the ISO week
  (`net/accounts.weekOf`), the same Monday that resets levels and sides.
- **It changes nothing a player can do.** No buffs in held ground, no locked
  doors, no spawn changes. It is a scoreboard with a shape.

## The files

- `client/src/game/territory.ts` — the rule, `hexAt` (nearest centre), the
  client's copy of the table (`Territory.apply` reports which hexagons changed
  hands), `verifyTerritory`. Three-free, imported by both ends.
- `server/territory.ts` — `TerritoryStore`: the ledger for the week, on disk at
  `$SYDNEY_STATE_DIR/territory.json` on `interiors.ts`' terms (five-second
  debounce, atomic replace, a file from another week is not loaded, the holder
  is recomputed from the scores rather than trusted). One per process, shared
  by every room. `verifyTerritoryStore`.
- `server/sim.ts` — one call at the KO funnel, beside `creditLadder`.
- `server/room.ts` — `sendTerritory`, on `sendTalents`' shape: the whole table
  on welcome and again whenever the store's `version` moves, which is only on a
  change of hands or a Monday.
- `client/src/net/protocol.ts` — `MSG.TERRITORY` (0x99, server → client): u8
  count, then seven bytes a hexagon (i8 q, i8 r, u8 owner, u16 marita, u16
  dflt). At most 604 bytes. Protocol v30.
- `client/src/bigmap.ts` — the fifth rung, `sydney`, 124 km across, anchored on
  the world's origin: the harbour, every hexagon washed in its holder's colour
  with the tally in the chrome, the suburb names the greedy cull keeps, and
  the edge of the world. It is the rung the map opens on. The closer rungs
  keep a faint tint of the holder under the streets, so the compass says whose
  ground you are on without a word.
- `client/src/main.ts` — the feed line, `Marita took Parramatta`, on each
  change of hands (`pushKill`), and the suburb names fetched at boot rather
  than on the first `M` so the line has a word to say.

## The circle

The brief asked for it derived. `BigMap.setWorldRadius` takes the index's own
`radius_m` (60,000 on the shipped world) and, on a world without one, the
farthest hexagon centre plus a circumradius. It is drawn at every rung about
the origin — off screen it costs nothing — dashed, in the chrome's cream, so
it reads as a boundary and not a road.

## What is deliberately not here

- A reward for holding ground. Rule 7: cash is grounded and XP is the race;
  turf is the picture of the race, not a second currency. The owner dislikes
  buffs, so held ground grants none.
- Presence. Standing in a hexagon is not a contribution; only the fight is.
- Per-room turf. A hexagon held in room 0 is held in room 3, because the
  ledger is the host's, as a wallet is.
