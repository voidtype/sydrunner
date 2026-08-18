/**
 * The one seam between "who is on which team, with which talents" and every
 * renderer that has to draw it.
 *
 * ---------------------------------------------------------------------------
 * WHY AN ADAPTER RATHER THAN AN IMPORT.
 *
 * Teams landed as three workstreams built at once against one contract
 * (`game/teams.ts`): a framework that puts the team byte on the roster and
 * mirrors the talent masks on `net/client.ts`, a gameplay pass that reads
 * `TeamLookup` for its hooks, and this one, which draws the result. The three
 * branches were written in parallel in separate worktrees, so the renderer could
 * not import the mirror -- it did not exist yet on this branch, and guessing at
 * its shape would have produced a merge where the guess was wrong in fifteen
 * call sites at once.
 *
 * So the renderer reads **two functions**, set once at boot, defaulting to "no
 * teams at all". `main.ts` points them at the framework's mirror in one line at
 * merge; every drawing call site above is written against this file and does not
 * change. It is also what makes the whole feature testable in Bun and in a
 * `verify*`: a check hands in a fixture source, draws, and hands in `null` to
 * put it back -- see `verifyTeamView`.
 *
 * **Null is a working configuration and is the offline one.** Spec 9's local
 * stub has no server, therefore no accounts, therefore no teams, and every
 * player in it is `TEAM.NONE` wearing the colourway they were built with. That
 * is not a degraded mode to be tolerated; it is the mode the punch is developed
 * in, and `main.ts`'s connection header makes the same point about `net` being
 * null.
 *
 * ---------------------------------------------------------------------------
 * WHY MODULE STATE RATHER THAN AN OBJECT THREADED THROUGH.
 *
 * Six unrelated drawing paths need this -- the body tint, the Big Night kits,
 * the nameplate pill, the two maps, the aura rings and the viewmodel hands --
 * and they are reached from six different places in a 9,000-line `main.ts`.
 * Threading a `TeamSource` through all six would be six parameters added to six
 * signatures for a value that is a singleton by construction: there is one
 * connection, one roster, one truth about who is on which side. The cost of
 * module state is that it is global and can be set twice; `setTeamSource` is
 * therefore idempotent-by-replacement and takes `null` to clear, so a check can
 * always put it back and a second connection cannot leave a stale mirror behind.
 *
 * Three-free on purpose, despite living in `world/`: nothing here draws, and
 * keeping it importable from Bun is what lets `verifyTeamView` run in both boot
 * lists through `verifyBigNightKit`'s caller.
 */

import {
  EMPTY_MASK,
  NODES,
  TEAM,
  hasNode,
  type FxKey,
  type TalentMask,
  type Team,
} from '../game/teams.ts';

/**
 * What the framework provides. Named for the two functions the framework
 * workstream exposes on `net/client.ts` (`teamOf`, `talentsOf`) so that pointing
 * this at the real mirror is a one-line object literal and not a shim.
 */
export interface TeamSource {
  /** `TEAM.NONE` for a guest, a bot, a dummy, or anybody not on the roster. */
  teamOf(playerId: number): Team;
  /** Which talent nodes they have spent points on. `EMPTY_MASK` for nobody. */
  talentsOf(playerId: number): Readonly<TalentMask>;
}

let source: TeamSource | null = null;

/**
 * Point the renderer at the framework's mirror, or at `null` for no teams.
 *
 * The whole contract of this file, and the export the sibling workstreams call.
 * Returns nothing and can be called at any time: every reader below asks on the
 * frame it draws, so a source set after the first frame simply starts working.
 */
export function setTeamSource(next: TeamSource | null): void {
  source = next;
}

/** Whether anybody has wired a source at all. For the console readout, and for checks. */
export function hasTeamSource(): boolean {
  return source !== null;
}

/** Which side somebody is on. `TEAM.NONE` when there is no source, which is offline. */
export function teamOf(playerId: number): Team {
  return source === null ? TEAM.NONE : source.teamOf(playerId);
}

/** What they have spent. `EMPTY_MASK` when there is no source. */
export function talentsOf(playerId: number): Readonly<TalentMask> {
  return source === null ? EMPTY_MASK : source.talentsOf(playerId);
}

/**
 * Everybody takes Big Night, and that is the point -- `game/teams.ts` calls it
 * the WoW-style tax that makes the rest of the choice real. So this is very
 * nearly "is this player level 2", and it is still asked per player per frame
 * rather than cached, because a talent can be refunded mid-session and a cached
 * horn would outlive it.
 *
 * The node id is looked up from the contract rather than written here: there is
 * exactly one `bigNight` node per team and `verifyTeams` enforces it, so keying
 * on the flag means a renumbering of the tree cannot leave the renderer growing
 * horns off the wrong bit.
 */
export function hasBigNight(playerId: number): boolean {
  const team = teamOf(playerId);
  if (team === TEAM.NONE) return false;
  const mask = talentsOf(playerId);
  for (const node of NODES) {
    if (node.team === team && node.bigNight) return hasNode(mask, node.id);
  }
  return false;
}

/**
 * Whether they hold any node whose effects reach teammates -- the `aura` flag on
 * the contract -- which is what earns the faint ground ring.
 *
 * A boolean rather than a count, and the ring is one ring rather than one per
 * aura node. Two Marita standing together with four auras between them would
 * otherwise be eight concentric circles at the same radius, which is one circle
 * drawn eight times and `MAX_RINGS` spent on nothing.
 */
export function hasAura(playerId: number): boolean {
  const team = teamOf(playerId);
  if (team === TEAM.NONE) return false;
  const mask = talentsOf(playerId);
  for (const node of NODES) {
    if (node.team === team && node.aura === true && hasNode(mask, node.id)) return true;
  }
  return false;
}

/**
 * How many teammates a mega they hold needs inside `GROUP_M`, or 0 for no mega.
 *
 * The *smallest* requirement across the megas they hold, because the ring is
 * drawn while the group condition holds and the condition that holds first is
 * the one the player can see coming. Only `Sunday Rush` and `Cronulla Line`
 * carry `group` today and both ask for 3, so this is a distinction with no
 * difference right now -- written as a minimum anyway because the alternative
 * (assume 3) is a number copied out of the contract into a renderer, which is
 * the failure `game/teams.ts`'s header opens by forbidding.
 */
export function groupSizeFor(playerId: number): number {
  const team = teamOf(playerId);
  if (team === TEAM.NONE) return 0;
  const mask = talentsOf(playerId);
  let need = 0;
  for (const node of NODES) {
    if (node.team !== team || node.group === undefined || !hasNode(mask, node.id)) continue;
    need = need === 0 ? node.group : Math.min(need, node.group);
  }
  return need;
}

/**
 * Whether they hold a node carrying a given effect key.
 *
 * The renderer's version of `ownFlag`, and the reason it is here rather than a
 * call to that function is `teamOf`: a talent mask means nothing without the
 * side it was spent on, and reading a bit for a node belonging to the other team
 * would draw a DeFAULT's RBT markers off a Marita's mask. Used for
 * `FX.RBT_MINIMAP` and for anything else that is purely a drawing decision.
 */
export function hasEffect(playerId: number, key: FxKey): boolean {
  const team = teamOf(playerId);
  if (team === TEAM.NONE) return false;
  const mask = talentsOf(playerId);
  for (const node of NODES) {
    if (node.team !== team || !hasNode(mask, node.id)) continue;
    for (const [k, v] of node.effects) if (k === key && v > 0) return true;
  }
  return false;
}

/**
 * The adapter, checked with a fixture and put back.
 *
 * Run from `verifyBigNightKit` rather than from a boot list of its own, because
 * every failure here is a failure of *that* feature: a source that is not
 * cleared leaves a check's fixture answering for the real roster, and a
 * `hasBigNight` that reads the wrong team's bit puts horns on a DeFAULT --
 * which renders, and which is precisely the kind of wrong this repo calls
 * silent. The source is restored in a `finally` so a throw mid-check cannot
 * leave the whole client believing a fixture.
 */
export function verifyTeamView(): string[] {
  const bad: string[] = [];
  const saved = source;
  try {
    setTeamSource(null);
    if (teamOf(1) !== TEAM.NONE) bad.push('With no source wired, somebody has a team. Offline has no accounts and therefore no sides.');
    if (hasBigNight(1) || hasAura(1) || groupSizeFor(1) !== 0) bad.push('With no source wired, a player has talents.');

    // A fixture: one Marita with Big Night and Tip Jar (an aura), one DeFAULT
    // with Sunday Rush (a mega with `group: 3`) and nothing else, and a guest.
    const marita = { lo: (1 << 7) | (1 << 12), hi: 0 };
    const deft = { lo: 0, hi: 1 << (34 - 32) };
    setTeamSource({
      teamOf: (id) => (id === 1 ? TEAM.MARITA : id === 2 ? TEAM.DEFAULT : TEAM.NONE),
      talentsOf: (id) => (id === 1 ? marita : id === 2 ? deft : EMPTY_MASK),
    });
    if (!hasBigNight(1)) bad.push('A Marita holding node 7 (Big Night) did not read as having it; they would not grow horns.');
    if (hasBigNight(2)) bad.push('A DeFAULT holding only Sunday Rush read as having Big Night; they would turn into a cactus for free.');
    if (hasBigNight(3)) bad.push('A guest read as having Big Night.');
    if (!hasAura(1)) bad.push('Tip Jar is an aura node and did not earn a ring.');
    if (hasAura(2)) bad.push('A DeFAULT with no aura node was given a ring.');
    if (groupSizeFor(2) !== 3) bad.push(`Sunday Rush asked for a group of ${groupSizeFor(2)} rather than the contract's 3.`);
    if (groupSizeFor(1) !== 0) bad.push('A player with no mega was given a group ring.');
    // The bit-vs-team trap, stated as a check: the *same* mask on the other side
    // must not light anything up, because the ids are team-specific.
    setTeamSource({ teamOf: () => TEAM.DEFAULT, talentsOf: () => marita });
    if (hasBigNight(1)) bad.push("A Marita's mask read as Big Night on a DeFAULT; the renderer is keying on the bit and ignoring the side.");
  } finally {
    setTeamSource(saved);
  }
  return bad;
}
