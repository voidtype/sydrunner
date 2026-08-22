/**
 * The conversation panel, and the obligations list behind it.
 *
 * `client/src/teams.ts` is the file this one is shaped after -- a panel that
 * owns its own listeners, its own Escape discipline and its own DOM, handed a
 * small source object by `main.ts` and reaching into nothing else. Everything
 * structural is that file's and is not re-argued.
 *
 * Two differences, and both are decisions rather than omissions.
 *
 * ---------------------------------------------------------------------------
 * ## TIME DOES NOT STOP. IT NEVER DOES, ANYWHERE, IN THIS GAME.
 *
 * The talents panel calls itself a takeover and even it does not pause the
 * world -- *"the game is paused for you, not for anyone else"* is its own
 * eyebrow, and what it means is that your **input** is captured while your body
 * goes on standing in a street where other people can hit it. This panel does
 * not even do that much. Cars keep driving, the crowd keeps walking, `wasd`
 * still walks, and you can be knocked over mid-sentence by somebody who has no
 * idea you are talking to anyone.
 *
 * That is a house rule rather than a limitation to be lifted later. There is no
 * version of a pause that works in a multiplayer game, and a dialog tree that
 * *felt* like it paused -- one that swallowed movement, say -- would be a
 * player standing motionless in traffic wondering why they cannot run.
 *
 * What it does do is **release pointer lock**, which is unavoidable for the
 * reason `client/src/phone.ts` gives about itself: the choices are buttons, and
 * a browser under pointer lock has no cursor to click them with.
 *
 * ---------------------------------------------------------------------------
 * ## THE CLIENT WALKS THE TREE; THE SERVER DECIDES EVERYTHING
 *
 * The pack arrives over HTTP once (`GET /content`, ETag'd) and this file walks
 * it locally -- so opening a conversation, reading a node and moving between
 * nodes are all instant and cost the wire nothing. That is the whole reason the
 * content is not on the socket.
 *
 * But **nothing here is authoritative**. Every click sends `MSG.QUEST` and the
 * server re-walks the same choice against its own copy: the gate is checked
 * again, a bribe is debited again through the wallet door, and the destination
 * is the *pack's* `goto` rather than a node id this file chose. A stale tab
 * with last week's pack cannot walk anywhere it was not offered.
 *
 * The one thing this file does optimistically is **move to the next node**,
 * which `teams.ts` explicitly refuses to do with a talent. The difference is
 * what a wrong guess costs: a predicted talent re-arranges a tree under the
 * cursor and silently changes what six other nodes say, where a predicted node
 * is a line of text that is right in every case except a client that is lying
 * to itself. Accept and turn-in are **not** predicted -- they change a cursor
 * and pay money, and those wait for `MSG.QUEST_STATE`.
 *
 * ---------------------------------------------------------------------------
 * ## IMPROV, FROM THIS SIDE
 *
 * A node may carry an `improv` block, which means the server *may* have had a
 * language model rewrite the line. This file does not know or care whether one
 * did: it draws `state.line` when the server sent one addressed to the node
 * currently on screen, and the authored `node.line` otherwise. The "otherwise"
 * is the ordinary path -- no key configured, a cache miss, a throttled fill --
 * and it is the same single branch for all three, which is what makes the
 * feature's absence untestable from in here and therefore safe.
 *
 * The line is written with `textContent`, never `innerHTML`. The server already
 * strips markup out of a model's answer (`questmodel.clampImprov`); this is the
 * second wall, and it is the one that would still hold if the first were
 * removed.
 */

import {
  STEP_KIND,
  choiceRefusal,
  defaultLabel,
  questRefusal,
  stepTarget,
  type ContentBundle,
  type DialogChoice,
  type DialogNode,
  type DialogNpc,
  type PlayerFacts,
  type Quest,
  type QuestCursor,
} from './game/questmodel.ts';
import { NODE_OPENED, QUEST_OP, blankQuestState, type QuestStateFrame } from './net/quests.ts';

/** Everything the panel reads and the one thing it does. Supplied by `main.ts`. */
export interface DialogSource {
  /** The pack, or an empty bundle before `/content` has answered. */
  content(): ContentBundle;
  /** This player's cursors, flags, xp and any improv line. Off `NetClient`. */
  state(): QuestStateFrame;
  /** Where the player is standing, world metres. For the prompt and the list. */
  position(): { x: number; z: number };
  level(): number;
  /** `''`, `'Marita'` or `'DeFAULT'`. */
  faction(): string;
  cash(): number;
  /** Send one `MSG.QUEST`. The only thing this panel can make happen. */
  send(op: number, id: string, node: string, choice: number): void;
  /** Take the pointer back when the panel closes on a click. */
  lockPointer(): void;
}

/**
 * How close you have to be for `E` to open a conversation.
 *
 * Read off the NPC's own `radius` out of the pack, minus a little, so the
 * prompt appears **inside** the range the server will accept rather than at its
 * edge. `MSG.SUN_PRESS` states the same arrangement from the other side and for
 * the same reason: the half-metre between the client's prompt radius and the
 * server's reach is what absorbs the tick of walking the two ends can disagree
 * about, and it is a much better place to spend the slack than a field the
 * sender controls.
 */
const PROMPT_MARGIN_M = 1;

export class DialogPanel {
  private readonly root = document.getElementById('dialog');
  private readonly who = document.getElementById('dialog-who');
  private readonly line = document.getElementById('dialog-line');
  private readonly choices = document.getElementById('dialog-choices');
  private readonly prompt = document.getElementById('dialog-prompt');
  private readonly promptName = document.getElementById('dialog-prompt-name');
  /** The obligations app's list, which lives in the phone's app body. */
  private readonly source: DialogSource;

  private open = false;
  private npcId = '';
  private nodeId = '';
  /** What was last drawn, so the 4 Hz refresh is a string compare. */
  private drawn = '';
  private sinceRedraw = 0;
  /** The nearest NPC within reach, recomputed on the prompt's own cadence. */
  private nearby: DialogNpc | null = null;

  constructor(source: DialogSource) {
    this.source = source;
  }

  /** Is the panel up? `main.ts` samples this before its Escape branch. */
  get visible(): boolean {
    return this.open;
  }

  /** Is there somebody in reach to talk to? Drives the `E` prompt. */
  get canTalk(): boolean {
    return this.nearby !== null;
  }

  /**
   * Open on whoever is in reach, or do nothing.
   *
   * Returns whether it opened, so `main.ts`'s `E` handler can fall through to
   * the mount chain when there is nobody to talk to. That ordering matters and
   * is the caller's: a quest NPC standing beside a lime bike must not make the
   * bike unmountable, so the dialog is tried **after** `resolveMount` finds
   * nothing, not before.
   */
  tryOpen(): boolean {
    if (this.nearby === null) return false;
    this.npcId = this.nearby.id;
    this.nodeId = this.nearby.root;
    this.setOpen(true);
    // The arrival is reported even though the client chose it, because the
    // server has to range-check it and because the root node may be an improv
    // node whose line is only fetched when somebody actually walks up.
    this.source.send(QUEST_OP.NODE, this.npcId, this.nodeId, NODE_OPENED);
    this.invalidate();
    this.draw();
    return true;
  }

  /** One step out. `false` means "nothing of mine was open"; see `Phone.goBack`. */
  goBack(): boolean {
    if (!this.open) return false;
    this.close();
    return true;
  }

  close(): void {
    this.setOpen(false);
  }

  private setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.root?.classList.toggle('shown', open);
    if (open && document.pointerLockElement) document.exitPointerLock();
  }

  /** Force a redraw on the next `tick`. For a state frame arriving. */
  invalidate(): void {
    this.drawn = '';
  }

  /**
   * The prompt sweep and the panel's redraw, both at 4 Hz.
   *
   * `Phone.tick`'s cadence and its argument: this shows distances and gate
   * states that genuinely move, so it cannot be drawn once on open, and it is a
   * DOM rebuild so it must not be drawn at 120 Hz. The **prompt** runs on the
   * same clock rather than a faster one because an `E` prompt that appears a
   * quarter-second late on a player walking at 4 m/s appears one metre late,
   * and the server's reach has two metres of slack in it for exactly that.
   */
  tick(dt: number): void {
    this.sinceRedraw += dt;
    if (this.sinceRedraw < 0.25) return;
    this.sinceRedraw = 0;
    this.findNearby();
    if (this.open) this.draw();
  }

  private findNearby(): void {
    const at = this.source.position();
    let best: DialogNpc | null = null;
    let bestD2 = Infinity;
    for (const npc of this.source.content().npcs) {
      const reach = Math.max(1, npc.radius - PROMPT_MARGIN_M);
      const dx = at.x - npc.x;
      const dz = at.z - npc.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > reach * reach || d2 >= bestD2) continue;
      best = npc;
      bestD2 = d2;
    }
    this.nearby = best;
    // The prompt is hidden while the panel is up: you are already talking to
    // them, and "press E to talk" over an open conversation reads as a bug.
    const show = best !== null && !this.open;
    this.prompt?.classList.toggle('shown', show);
    if (show && this.promptName) this.promptName.textContent = best?.name ?? '';
    // Somebody walked away mid-sentence. Closing is the honest answer: the
    // server will refuse every further click on the range test anyway, and a
    // panel that stayed up would be a conversation with an empty street.
    if (this.open && (best === null || best.id !== this.npcId)) this.close();
  }

  private facts(): PlayerFacts {
    return {
      level: this.source.level(),
      faction: this.source.faction(),
      story: new Set(this.source.state().flags),
      cash: this.source.cash(),
    };
  }

  private npc(): DialogNpc | null {
    return this.source.content().npcs.find((n) => n.id === this.npcId) ?? null;
  }

  private node(): DialogNode | null {
    return this.npc()?.nodes.find((n) => n.id === this.nodeId) ?? null;
  }

  /**
   * What this node says: the server's improv line if it sent one **for this
   * node**, otherwise the authored one.
   *
   * The address check is the whole of it. A state frame carries at most one
   * line and it names the node it belongs to, so a player who walks two nodes
   * in a quarter-second cannot be shown the previous node's rewrite -- which
   * would be a non-sequitur that reads as the model being broken rather than as
   * a race.
   */
  private lineFor(node: DialogNode): string {
    const state = this.source.state();
    if (state.line !== '' && state.lineNpc === this.npcId && state.lineNode === node.id) return state.line;
    return node.line;
  }

  private draw(): void {
    const npc = this.npc();
    const node = this.node();
    if (!npc || !node) {
      // The pack changed underneath an open conversation -- a content edit
      // landed while somebody was mid-sentence, which is a thing this feature
      // exists to allow. Closing is the only honest answer; there is nothing
      // to draw.
      this.close();
      return;
    }
    const facts = this.facts();
    const cursors = cursorMap(this.source.state());
    const rows: Array<{ text: string; refusal: string; choice: DialogChoice; index: number }> = [];
    node.choices.forEach((choice, index) => {
      rows.push({ text: choice.text, refusal: this.refusalFor(choice, facts, cursors), choice, index });
    });
    const key = `${npc.id}|${node.id}|${this.lineFor(node)}|${rows.map((r) => `${r.text}/${r.refusal}`).join('~')}`;
    if (key === this.drawn) return;
    this.drawn = key;

    if (this.who) this.who.textContent = npc.name;
    // `textContent`, never `innerHTML`. See the header: the server already
    // strips markup out of a model's answer and this is the wall that would
    // still hold if it did not.
    if (this.line) this.line.textContent = this.lineFor(node);
    if (!this.choices) return;
    this.choices.replaceChildren();
    for (const row of rows) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'dialog-choice';
      const label = document.createElement('span');
      label.textContent = row.text;
      el.appendChild(label);
      if (row.refusal !== '') {
        el.classList.add('locked');
        el.disabled = true;
        const why = document.createElement('em');
        why.textContent = row.refusal;
        el.appendChild(why);
      } else if (row.choice.cost > 0) {
        const price = document.createElement('em');
        price.textContent = `-$${row.choice.cost}`;
        el.appendChild(price);
      }
      el.addEventListener('click', () => this.pick(row.index));
      this.choices.appendChild(el);
    }
  }

  /**
   * Why a choice is greyed out, or `''`.
   *
   * Three questions in order, and the order is what makes the message useful --
   * `SuggestionStore.vote`'s rule about putting "already voted" before "out of
   * votes". A choice that accepts a quest you have already done should say so
   * rather than saying nothing, and a choice that turns in a quest you have not
   * finished should name **the step you are on**, which is the single most
   * useful sentence this panel can produce.
   */
  private refusalFor(choice: DialogChoice, facts: PlayerFacts, cursors: Map<string, QuestCursor>): string {
    const gate = choiceRefusal(choice, facts);
    if (gate !== '') return gate;
    if (choice.accept !== '') {
      const quest = this.questById(choice.accept);
      if (!quest) return 'not available';
      return questRefusal(quest, facts, Object.fromEntries(cursors));
    }
    if (choice.turnin !== '') {
      const quest = this.questById(choice.turnin);
      const cursor = cursors.get(choice.turnin);
      if (!quest || !cursor) return 'you are not on that';
      if (!cursor.d) {
        const step = quest.steps[cursor.s];
        return step ? shortLabel(step.label || defaultLabel(step)) : 'not yet';
      }
    }
    return '';
  }

  private questById(id: string): Quest | null {
    return this.source.content().quests.find((q) => q.id === id) ?? null;
  }

  /**
   * A click. Send it, then move optimistically -- except when it decides
   * something.
   *
   * See the header on which half is predicted and why. The accept and turn-in
   * ops go **before** the navigation op, so that when a choice does both (a
   * "take it" button that also walks to a thank-you node) the server sees the
   * decision first and the state frame it answers with is already the new one.
   */
  private pick(index: number): void {
    const node = this.node();
    const choice = node?.choices[index];
    if (!node || !choice) return;
    if (this.refusalFor(choice, this.facts(), cursorMap(this.source.state())) !== '') return;
    if (choice.accept !== '') this.source.send(QUEST_OP.ACCEPT, choice.accept, '', 0);
    if (choice.turnin !== '') this.source.send(QUEST_OP.TURNIN, choice.turnin, '', 0);
    this.source.send(QUEST_OP.NODE, this.npcId, node.id, index);
    if (choice.goto === '') {
      this.close();
      this.source.lockPointer();
      return;
    }
    this.nodeId = choice.goto;
    this.invalidate();
    this.draw();
  }

  // --- The obligations app ---------------------------------------------------------

  /**
   * The phone's Obligations screen, as HTML for `Phone`'s app body.
   *
   * A **string of markup handed to the phone** rather than a second panel, and
   * that is the phone's own arrangement for every app it has: `Phone.draw`
   * compares the whole body as a string before it writes it, so a screen that
   * has not changed costs one `join` and one compare four times a second. A
   * panel of my own would be a second element to show, hide, position and
   * Escape out of, for a list of at most eight rows.
   *
   * It is deliberately **only the jobs you are on**, plus what is available
   * from somebody you have already met. A full quest log listing everything in
   * the game would be a walkthrough, and the whole texture of Act 0 is that
   * Denise tells you what you owe her one item at a time.
   */
  obligationsHtml(): string {
    const state = this.source.state();
    const bundle = this.source.content();
    const rows: string[] = [];
    for (const cursor of state.cursors) {
      const quest = bundle.quests.find((q) => q.id === cursor.id);
      if (!quest) continue;
      const step = quest.steps[cursor.step];
      const detail = cursor.done
        ? 'ready to hand in'
        : step
          ? `${escapeHtml(shortLabel(step.label || defaultLabel(step)))}${counterFor(step, cursor.counts[cursor.step] ?? 0)}`
          : 'in progress';
      rows.push(
        `<div class="phone-row"><span>${escapeHtml(quest.title)}</span></div>` +
          `<div class="phone-note">${detail}</div>`,
      );
    }
    if (rows.length === 0) {
      rows.push(
        '<div class="phone-note">Nothing outstanding. Services Australia will be in touch.</div>',
      );
    }
    const xp = `<div class="phone-row"><span>experience</span><span>${state.xp}</span></div>`;
    const level = `<div class="phone-row"><span>level</span><span>${state.level}</span></div>`;
    return `${rows.join('')}<div class="phone-note">&nbsp;</div>${level}${xp}`;
  }
}

/** `x of y` for a counted step, or nothing. One place, so the two agree. */
function counterFor(step: { kind: string; count: number; dollars: number }, have: number): string {
  const target = stepTarget(step as Parameters<typeof stepTarget>[0]);
  if (target <= 1) return '';
  const prefix = step.kind === STEP_KIND.EARN ? '$' : '';
  return ` — ${prefix}${Math.min(have, target)} of ${prefix}${target}`;
}

function cursorMap(state: QuestStateFrame): Map<string, QuestCursor> {
  const out = new Map<string, QuestCursor>();
  for (const c of state.cursors) out.set(c.id, { s: c.step, c: [...c.counts], d: c.done });
  return out;
}

function shortLabel(text: string): string {
  return text.length <= 52 ? text : `${text.slice(0, 51)}…`;
}

/**
 * The obligations app is the one place in this feature that composes markup.
 *
 * Everything else sets `textContent`. This does not, because the phone's app
 * body takes a string -- so quest titles and step labels, which come out of a
 * **JSON file somebody edits on github.com**, are escaped here. The content is
 * not hostile and is not treated as trusted either: an author who writes an
 * ampersand into a job title should get an ampersand, and one who writes a
 * `<script>` should get the characters they typed.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- The self-check ----------------------------------------------------------------

/**
 * The panel's own two failures, which `verifyDialog` cannot see.
 *
 * Browser-only, on `verifyTalentsPanel`'s precedent and for its reason: this
 * file has player-facing behaviour that the shared module has no view of. Two
 * things are asserted and both of them are silent when wrong:
 *
 *   - **The escape.** The obligations app composes markup out of strings from a
 *     content file. An unescaped `<` is a job title that disappears and, at
 *     worst, a content file that can write elements into a phone screen. There
 *     is no frame in which either looks wrong -- the row is simply not there.
 *   - **The counter.** `2 of 3` under a step is the only feedback a player gets
 *     that a knockout counted, and a counter that showed the *target* on both
 *     sides, or that counted past it, reads as the game cheating.
 */
export function verifyDialogPanel(): string[] {
  const failures: string[] = [];

  {
    const cases: Array<[string, string]> = [
      ['Twenty Points', 'Twenty Points'],
      ['Fish & Chips', 'Fish &amp; Chips'],
      ['<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;'],
      ['a "quoted" job', 'a &quot;quoted&quot; job'],
    ];
    for (const [raw, want] of cases) {
      const got = escapeHtml(raw);
      if (got !== want) failures.push(`escapeHtml(${JSON.stringify(raw)}) is ${JSON.stringify(got)}, not ${JSON.stringify(want)}.`);
    }
    if (escapeHtml('&lt;').includes('<')) failures.push('escapeHtml is not idempotent-safe; an escaped string re-escaped produced a tag.');
  }

  {
    const ko = { kind: STEP_KIND.KO, count: 3, dollars: 0 };
    const earn = { kind: STEP_KIND.EARN, count: 1, dollars: 50 };
    const once = { kind: STEP_KIND.GOTO, count: 1, dollars: 0 };
    if (counterFor(once, 0) !== '') failures.push('A single-shot step drew a counter; "0 of 1" is noise.');
    if (counterFor(ko, 2) !== ' — 2 of 3') failures.push(`A ko counter reads "${counterFor(ko, 2)}".`);
    if (counterFor(ko, 9) !== ' — 3 of 3') failures.push(`An over-counted step reads "${counterFor(ko, 9)}"; it must clamp at the target.`);
    if (counterFor(earn, 20) !== ' — $20 of $50') failures.push(`An earn counter reads "${counterFor(earn, 20)}"; money needs its sign.`);
  }

  {
    const long = shortLabel('x'.repeat(200));
    if ([...long].length > 52) failures.push(`A ${long.length}-character step label was not clipped; it would break the row.`);
    if (shortLabel('short') !== 'short') failures.push('A short label was clipped anyway.');
  }

  // The two names, which render perfectly when they are wrong. `verifyTeams`
  // greps `game/teams.ts` and cannot see this file's own copy; `verifyDialog`
  // greps a content pack and cannot see it either.
  {
    const source = String(verifyDialogPanel) + String(DialogPanel);
    for (const wrong of ['DEFAULT"', 'Default ', '"marita', 'MARITA']) {
      if (source.includes(wrong)) failures.push(`The dialog panel spells a side "${wrong}"; it is Marita and DeFAULT.`);
    }
  }

  // And the frame this panel is drawn from has to have a safe empty value, or
  // the first quarter-second of every session throws inside `draw`.
  {
    const blank = blankQuestState();
    if (blank.cursors.length !== 0 || blank.flags.length !== 0 || blank.line !== '') {
      failures.push('The blank quest state is not blank; the panel draws it before the first frame arrives.');
    }
    if (cursorMap(blank).size !== 0) failures.push('An empty state produced cursors.');
  }

  return failures;
}
