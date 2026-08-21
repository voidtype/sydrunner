# DESIGN.md — the taste ledger

The game grew mechanic by mechanic across parallel batches, and the owner has
asked for the thing a pile of good mechanics does not automatically have:
*"make sure design is consistent and beautiful in our game."* This document is
where consistency lives. It states the rules every mechanic must pass, and it
keeps the ledger of what was researched — from WoW, Skyrim, GTA, and the
players' own suggestion board — with a verdict and a reason for each, so the
next idea is judged against the same taste as the last one. A brief that
contradicts this document is wrong until this document is changed.

## The eight rules

1. **Sydney is the content.** Every mechanic names a real thing — a suburb, an
   archetype, a train line, an OSM anchor. Powerups spawn at real cafés and
   bottle-Os; quests send you to Marrickville, not to "District 4". If a
   mechanic would work unchanged in a generic city, it is not finished.
2. **No guns, and the violence is comedy.** The weapon test: would a bouncer
   laugh. Bats, footies, schooner glasses, meat pies, beach umbrellas — things
   a Sydneysider has actually thrown. Nothing that would read as a news story.
3. **The week is the epic.** Levels, teams and the ladder reset every Monday;
   the story is the one thing that persists. Design seven-day arcs — a fresh
   Monday, a peak weekend — rather than infinite ladders. The reset is not a
   technical event; Act 2 makes it diegetic, and mechanics should treat it as
   a feature of the world.
4. **The phone is the interface.** Maps, quests, dialog, the camera, the app —
   meta-UI lives on the phone, and time never stops while you look at it.
5. **Determinism is the aesthetic.** Ambient life is a pure function of
   `(anchor, index, tick)` — that is why six thousand cars and every pedestrian
   cost zero wire, and why two players always see the same street. A proposal
   that needs per-entity wire for ambience is fighting the house style.
6. **The city reacts; the UI does not shout.** Karens witness, the killfeed
   reports, the radio ticker mentions. Prefer the world noticing the player
   over a toast congratulating them.
7. **Cash is grounded, XP is the race.** Cash persists, buys things, and is the
   monetisation bridge. XP resets weekly and ranks the ladder. The two never
   convert into each other in-game.
8. **Budgets are design constraints.** 20 GB/month of egress, one vCPU, a
   16.7 ms frame. Every proposal states its cost, and a beautiful mechanic that
   breaks the tick is ugly.

## The research ledger

Verdicts: **adopt** (briefed or in flight), **later** (wanted, sequenced),
**refuse** (with the reason on record — a refusal is a design decision too).

### From WoW

| mechanic | SYDNEY translation | verdict |
|---|---|---|
| Rested XP | **"Slept in"** — an XP bonus pool that accrues while logged off, so returners can still race the week | adopt with the XP batch; a timestamp on the account, zero wire |
| Rare named elites | **Street legends** — named rare NPCs ("Big Kez") on deterministic rare beats, killfeed-announced, real drops | adopt with rich mobs; the announcement is rule 6 |
| Reputation ladders | Sub-faction rep (eshays, tradies, the bowlo) gating dialog choices and prices | later, after quests land; counters on the account |
| Weekly vault | **Long Service** — a Monday payout scaled by last week's deeds, so the reset is a payoff rather than a loss | later; leans directly into rule 3 |
| World bosses | A converging mass event | **refuse for now**: a deliberate pileup is our measured worst egress case, and the cap is the binding budget. Revisit after delta encoding. |
| Talent trees / mounts / instanced dungeons | Have them / cars-bikes-trains are the mounts / rooms are capacity, not content | n/a |

### From Skyrim

| mechanic | SYDNEY translation | verdict |
|---|---|---|
| Radiant quests | The quest DSL's weekly rotation | in flight (AK) |
| Standing stones | **Landmark blessings** — pick one weekly buff at a hero landmark; changes only at another landmark | later; cheap, makes the Opera House a destination |
| Bounty per hold | Per-LAC heat | **refuse**: the heat ladder's legibility is worth more than jurisdictional realism |
| Stealth / trespass | **The backyard loop** — fenced yards as escape routes; Karens report what they see, heat follows | adopt; it composes three systems that already exist (fences, Karens, heat) and invents none |
| Books and lore | **Zines** — collectible posters and flyers feeding an Act 2 codex | adopt with the story arc |
| Followers | Hire-a-tradie bodyguard, by the hour, in cash | later; a cash sink with a face |

### From GTA

| mechanic | SYDNEY translation | verdict |
|---|---|---|
| Wanted stars | The heat ladder, Highway Patrol, Polair | have |
| Respray | A workshop that clears a stolen car's reported flag, for cash | adopt; cash sink, uses the theft system as-is |
| Radio | **The ticker** — a car-radio text ticker mixing authored satirical headlines with live events (a big KO *makes the news*), weekly headlines rendered through the improv cache | adopt; near-zero cost, and it is rule 6 made audible. No licensed music, ever — text first, satire always |
| Minigames | Kick-to-kick at ovals (the footy already flies); lawn bowls at the bowlo | later, in that order |
| Stunt jumps | E-bike airtime XP | adopt with the XP batch |
| Heists | Group quest steps — a `group` flag reserved in the DSL now, built later | later |
| Properties | The owner's monetisation plan | separate track, already specced |

### From the suggestion board

The board's record so far is four shipped out of six filed — the sun (#5), the
crazy taxi (#4), the trains (#3), the bat swat (#1) — which is a hit rate worth
respecting. The two open:

- **#2 Boats — ferries, jetskis.** Adopt-later as **timetabled ferries** on the
  railway's own philosophy: deterministic timetable, boardable at wharves, the
  Manly run as the harbour's Hornsby→Penrith. A dormant `vessels` flag already
  sits in the code waiting for exactly this. Jetskis after there is water
  physics worth the name.
- **#6 Creeks.** A pipeline item — real creek lines carved at the next retile,
  paired with the water system that ferries will need anyway.

## The near-term set

In flight now: quests + dialog + hot content (AK), the corridor rework (AG),
e2e journeys (AH), tunnel lights (AI), ground-first loading (AJ). Next up, in
order: rich mobs + street legends + roaming faction residents; the XP batch
(sources + rested + airtime); weapons (glass, pie, umbrella, golf-club drop);
powerup anchors; then the later column above as the weeks allow.
