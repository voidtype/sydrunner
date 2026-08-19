/**
 * The build sheet: hold `B` and read what you have spent, without stopping.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS BESIDE THE TALENTS PANEL.
 *
 * The owner: *"need a way to view points in talents in normal play so i can see
 * what ive spent an think about later"*. `client/src/teams.ts` already draws
 * every node — but it is a **modal**: it takes the cursor, sets `hud.typing` so
 * no game key fires under it, and is the screen you go to in order to *change*
 * something. Opening that to answer "what did I take again" costs you the
 * street: you unlock the pointer, you stop walking, and somebody kills you
 * while you read.
 *
 * So this is the other half, and the split is the whole design:
 *
 *   - **The panel is for spending.** Cursor, clicks, refusal strings, tooltips.
 *   - **The sheet is for remembering.** No cursor, no clicks, no modal flag; it
 *     appears while a key is held and vanishes when it is let go, like a
 *     scoreboard. WASD keeps walking underneath it, and a car keeps driving.
 *
 * `B` for build. It is the last unclaimed letter near the movement hand that
 * means anything (`C` went to the camera when `V` became the dash), and holding
 * rather than toggling is deliberate: a sheet you can leave up is a sheet that
 * is up when the fight starts.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DRAWS, AND WHY IT DRAWS THE EMPTY TREES TOO.
 *
 * Everything comes from `game/teams.buildSummary`, which is pure and checked by
 * `verifyTeams` — this file is the DOM around it and nothing else, so a bug in
 * "which talents do I have" cannot live here. Three columns, one per tree, each
 * showing what is in it and, when you have a point spare, **what that point
 * could buy right now** (the rule's own answer, not a guess: `takeRefusal` is
 * what decides the list). A tree you have never touched still gets a column,
 * because the sentence the owner actually asked for is "what have I spent and
 * what should I do later", and half of that answer is in the trees you skipped.
 *
 * Nothing here is interactive. The footer says which key opens the panel that
 * is, so the sheet is never a dead end.
 */

import {
  TEAM,
  TEAM_COLOUR,
  buildSummary,
  type BuildSummary,
  type Team,
  type TalentMask,
} from './game/teams.ts';

/** What the sheet needs to know. `client/src/teams.TalentsSource`'s read half. */
export interface BuildSheetSource {
  team(): Team;
  mask(): Readonly<TalentMask>;
  level(): number;
  /** No ladder offline, so no sheet. */
  online(): boolean;
}

export class BuildSheet {
  private readonly source: BuildSheetSource;
  private root: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private shown = false;
  /**
   * The last summary painted, as a string. The sheet is redrawn only when the
   * build actually changes, which for most of the time it is up is never --
   * a held key would otherwise rebuild a dozen elements sixty times a second
   * for a picture that has not moved.
   */
  private drawn = '';

  constructor(source: BuildSheetSource) {
    this.source = source;
  }

  /** Held down. Ignored offline and before a side is picked -- there is nothing to read. */
  show(): void {
    if (this.shown) return;
    if (!this.source.online() || this.source.team() === TEAM.NONE) return;
    this.shown = true;
    this.drawn = '';
    this.paint();
    this.mount()?.classList.add('shown');
  }

  /** Let go. */
  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.root?.classList.remove('shown');
  }

  /** Called once a frame by `main.ts`; repaints only when the build changed. */
  frame(): void {
    if (this.shown) this.paint();
  }

  private mount(): HTMLElement | null {
    if (this.root) return this.root;
    const root = document.getElementById('buildsheet');
    if (!root) return null;
    this.root = root;
    this.body = document.getElementById('buildsheet-body');
    return root;
  }

  private paint(): void {
    const root = this.mount();
    const body = this.body;
    if (!root || !body) return;
    const summary = buildSummary(this.source.team(), this.source.mask(), this.source.level());
    // The signature is everything the sheet shows: the side, the level, and
    // which bits are set. Cheaper than a deep compare and exact.
    const mask = this.source.mask();
    const signature = `${summary.team}:${summary.level}:${mask.lo}:${mask.hi}`;
    if (signature === this.drawn) return;
    this.drawn = signature;
    body.replaceChildren(...this.render(summary));

    const head = document.getElementById('buildsheet-head');
    if (head) {
      head.replaceChildren();
      const side = document.createElement('b');
      side.textContent = summary.teamName;
      side.style.background = TEAM_COLOUR[summary.team].css;
      side.style.color = TEAM_COLOUR[summary.team].ink;
      const rest = document.createElement('span');
      rest.textContent =
        summary.unspent > 0
          ? `level ${summary.level} · ${summary.spent} spent · ${summary.unspent} to spend`
          : `level ${summary.level} · ${summary.spent} spent`;
      head.append(side, rest);
    }
  }

  private render(summary: BuildSummary): HTMLElement[] {
    return summary.rows.map((row) => {
      const col = document.createElement('div');
      col.className = 'bcol';

      const title = document.createElement('h4');
      title.textContent = row.tree;
      const count = document.createElement('span');
      count.textContent = `${row.spent}`;
      title.appendChild(count);
      col.appendChild(title);

      if (row.taken.length === 0) {
        const none = document.createElement('p');
        none.className = 'bnone';
        none.textContent = 'nothing here yet';
        col.appendChild(none);
      }
      for (const node of row.taken) {
        const line = document.createElement('div');
        line.className = 'btaken';
        const name = document.createElement('b');
        name.textContent = node.name;
        const kind = document.createElement('span');
        kind.className = 'bkind';
        kind.textContent = node.kind;
        const effect = document.createElement('p');
        // The first sentence only. The tooltip in the panel is the full text;
        // a sheet you read at a glance while somebody is shooting at you is not
        // the place for four lines of it.
        effect.textContent = firstSentence(node.effect);
        line.append(name, kind, effect);
        col.appendChild(line);
      }

      if (summary.unspent > 0 && row.next.length > 0) {
        const next = document.createElement('div');
        next.className = 'bnext';
        next.textContent = `could take: ${row.next.join(', ')}`;
        col.appendChild(next);
      }
      return col;
    });
  }
}

/**
 * The first sentence of a node's effect, for the one line the sheet shows.
 *
 * Naive on purpose -- the effect strings are hand-written prose in this repo,
 * every one of them opens with a complete sentence, and a full parser would be
 * more code than the feature. A string with no full stop is returned whole.
 */
function firstSentence(text: string): string {
  const stop = text.indexOf('. ');
  return stop < 0 ? text : text.slice(0, stop + 1);
}

export function verifyBuildSheet(): string[] {
  const failures: string[] = [];
  if (firstSentence('One. Two. Three.') !== 'One.') {
    failures.push(`firstSentence cut "One. Two. Three." to ${JSON.stringify(firstSentence('One. Two. Three.'))}.`);
  }
  if (firstSentence('No full stop here') !== 'No full stop here') {
    failures.push('firstSentence dropped a string that has no sentence break.');
  }
  // The decimal in a number must not read as the end of a sentence: "2.2 m" is
  // mid-sentence, and `'. '` rather than `'.'` is what keeps it that way.
  const decimals = 'Take radius 2.2 to 3.2 m. And more.';
  if (firstSentence(decimals) !== 'Take radius 2.2 to 3.2 m.') {
    failures.push(`firstSentence broke a decimal: ${JSON.stringify(firstSentence(decimals))}.`);
  }
  return failures;
}
