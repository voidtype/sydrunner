/**
 * The level-2 takeover: pick a side, then spend the ten points.
 *
 * The screen at `scratchpad/factions-talents.html`, made real. Two cards, three
 * trees under them, a tooltip on every node, and a build summary at the bottom.
 * `client/src/suggestions.ts` is the file this one is shaped after -- a panel
 * that owns its own listeners, its own Escape discipline and its own DOM, handed
 * a small source object by `main.ts` and reaching into nothing else.
 *
 * ---------------------------------------------------------------------------
 * ## WHY IT TAKES THE SCREEN, AND WHY ESCAPE DOES NOT GET YOU OUT
 *
 * The brief calls it a "takeover" and the mock's eyebrow says *"the game is
 * paused for you, not for anyone else"*, which is the honest description: the
 * world keeps simulating -- your body is standing in a street where other people
 * can hit it -- and your *input* is captured. That is not a compromise, it is
 * the only version that is possible in a multiplayer game, and it is why the
 * panel opens the moment you reach level 2 rather than at a lull: there is no
 * lull to wait for.
 *
 * **Escape does not dismiss it before a side is chosen.** That is the "forced"
 * part of the brief and it is the one modal thing in this interface. The
 * argument for it is that the choice is *permanent for the week*, it is visible
 * to everybody from across the street, and half the talents key off it -- a
 * player who dismissed the panel by reflex would be a level-6 character with no
 * side, no points and no idea that either existed. Once a side is picked the key
 * behaves the way it does everywhere else in this game: it closes what is open.
 *
 * A **guest sees none of this**, and it costs no code to arrange: a guest cannot
 * reach level 2 (`server/sim.creditLadder` holds them at 1 and says why), so the
 * condition below is never true for them. The `signedIn` test beside it is belt
 * and braces for the one case the ladder cannot cover -- somebody who signs up
 * mid-session and whose roster row has not caught up yet.
 *
 * ---------------------------------------------------------------------------
 * ## WHY EVERY STRING COMES OUT OF `game/teams.ts`
 *
 * The owner: *"always follow the capitalisation Marita and DeFAULT -- in
 * absolutely any case."* `verifyTeams` greps that file for the wrong spellings
 * and fails the boot on one, which only works if that file is the only place
 * they are written. So this panel draws `TEAM_NAME[team]` everywhere a name
 * appears -- the cards, the chips, the summary, the refusals -- and
 * `verifyTalentsPanel` below greps **this** file's own copy for the same
 * mistakes, because the two team blurbs and the mock's headings are new
 * player-facing text that `verifyTeams` cannot see.
 *
 * ---------------------------------------------------------------------------
 * ## OPTIMISM, AND WHY THERE IS NONE
 *
 * A click sends `TAKE` and changes nothing locally. The node lights up when
 * `MSG.TALENTS` comes back, which at 60 Hz is the next frame or the one after.
 *
 * That is the opposite of what `main.ts` does with a mount or a car theft, and
 * the difference is what a wrong guess costs. A predicted mount that the server
 * refuses is a quarter-second of standing beside a bike; a predicted *talent*
 * that the server refuses is a tree that re-arranges itself under the cursor
 * while the player is reading it, and the tier gates mean one wrong node
 * silently changes what six others say. The panel is opened a handful of times a
 * week and a round trip is 30 ms, so there is nothing to buy.
 *
 * What *is* local is the **refusal**: `takeRefusal` and `refundRefusal` are the
 * same two functions the server adjudicates with, imported from the same file,
 * so a node is greyed out and its tooltip explains why without asking anybody.
 * That is a rule evaluated twice rather than a guess -- which is this repo's
 * whole prediction argument, applied to a menu.
 */

import {
  MEGA_LEVEL,
  NODES,
  TEAM,
  TEAM_CHOICE_LEVEL,
  TEAM_COLOUR,
  TEAM_NAME,
  TIER_REQ,
  TREES,
  countBits,
  hasNode,
  pointsFor,
  refundRefusal,
  spentInTree,
  takeRefusal,
  type TalentMask,
  type TalentNode,
  type Team,
} from './game/teams.ts';

/** Everything the panel reads and every way it talks back. Supplied by `main.ts`. */
export interface TalentsSource {
  /** Is there an account behind this session? `JoinGate.signedIn`. */
  signedIn(): boolean;
  /** This player's side, off the `MSG.TALENTS` mirror. */
  team(): Team;
  /** Their spent mask. */
  mask(): Readonly<TalentMask>;
  /** The level the points are budgeted against. See `NetClient.myTalentLevel`. */
  level(): number;
  /** Is there a server at all? `?offline` has no ladder and therefore no panel. */
  online(): boolean;
  choose(team: Team): void;
  take(nodeId: number): void;
  refund(nodeId: number): void;
  resetAll(): void;
  /** The typing interlock, so no game key fires while this is up. `hud.talentsOpen`. */
  setModal(open: boolean): void;
  /** The level-up chime. `game/audio.levelUp`; optional so a fixture needs nothing. */
  fanfare?(): void;
}

/**
 * The two blurbs, which are the only sentences in this feature that are not in
 * the contract.
 *
 * They are here rather than in `game/teams.ts` because they are *panel copy* --
 * they describe a screen rather than a rule, nothing else will ever read them,
 * and putting them in the contract would mean the server parsed and shipped two
 * paragraphs of prose it has no use for. Keyed by team so `TEAM_NAME` stays the
 * only place a name is spelt; `verifyTalentsPanel` greps them anyway.
 */
/** How long the level-up beat runs, ms. Matches `#levelup`'s keyframes exactly. */
const LEVELUP_MS = 1700;

const BLURB: Readonly<Record<Team, string>> = {
  [TEAM.NONE]: '',
  [TEAM.MARITA]:
    'The inner-west and the south. Terraces, servos, the T3 at 1am. Plays fast and mean: mobility, cash, and a bat you will hear coming.',
  [TEAM.DEFAULT]:
    'The north and the coast. Utes, car parks, RBTs you somehow pass. Plays wide and heavy: armour, engines, and the crowd on your side.',
};

/** The line under each card, which is the mock's and says what the colour is. */
const CARD_TAG: Readonly<Record<Team, string>> = {
  [TEAM.NONE]: '',
  [TEAM.MARITA]: 'teal · white text',
  [TEAM.DEFAULT]: 'yellow · black text',
};

export class TalentsPanel {
  private readonly root = document.getElementById('talents');
  private readonly tip = document.getElementById('talents-tip');
  private readonly source: TalentsSource;
  private open = false;
  /**
   * Has the panel been forced open once this session?
   *
   * Without it, a player who picked a side, closed the panel and then levelled
   * would have it thrown back in their face -- and, worse, somebody who is
   * already on a side and has spent nothing would be re-opened on every roster
   * refresh. The forcing condition is *"level 2 and no side"*, which stops being
   * true the moment they choose, so this flag only covers the window between the
   * two.
   */
  private forced = false;
  /**
   * The last level this panel saw, and when the beat it started ends.
   *
   * The owner's note: "the transition to the levelling screen should be more
   * clear, i expect a celebretory animation, sound, message that i hit lvl 2.
   * not ott but something before the ui". So a level-up is now its own moment --
   * `LEVELUP_MS` of a centre-screen line and a chime -- and the panel waits for
   * it rather than replacing the street with a modal on the frame the kill
   * landed. `-1` is "no level seen yet", which is what stops the beat firing on
   * the first frame of a session for a level the player earned last night.
   */
  private lastLevel = -1;
  private beatUntil = 0;
  /** What was last drawn, so the frame loop's refresh is a string compare. */
  private drawn = '';
  private readonly nodeEls = new Map<number, HTMLElement>();

  constructor(source: TalentsSource) {
    this.source = source;
    this.build();
    // Capture phase, so the panel sees Escape before `main.ts`'s window
    // listener does. `hud.talentsOpen` makes that listener return at its first
    // statement anyway -- two belts, because the one that matters is refusing to
    // close, and a key that reached the game *and* the panel would both walk the
    // player and dismiss the choice.
    window.addEventListener('keydown', (e) => this.keydown(e), true);
    document.getElementById('panel-talents')?.addEventListener('click', () => this.show());
    // The level line in the vitals cluster: the chip and the "2 to spend" nudge
    // are both ways back in. Bound here rather than in `hud.ts` because what a
    // click on them *means* is this panel's business and the HUD owns none of
    // it -- the same split `client/src/accounts.ts` makes with the sign-up
    // buttons it finds by id.
    for (const id of ['level-team', 'level-spend']) {
      const el = document.getElementById(id);
      el?.classList.add('clickable');
      el?.addEventListener('click', () => this.show());
    }
  }

  /** Is it up? `main.ts` samples this before its own Escape branch. */
  get visible(): boolean {
    return this.open;
  }

  /**
   * Open it, from the phone tile, the Escape strip or the level line.
   *
   * Refused offline and refused for a guest, which is the same refusal twice for
   * two different reasons: `?offline` has no server to send a `CHOOSE` to, and a
   * guest has nowhere to keep the answer. Both draw nothing rather than an empty
   * panel, on `hud.level`'s rule about a ladder that does not exist.
   */
  show(): void {
    if (!this.source.online() || !this.source.signedIn()) return;
    this.setOpen(true);
  }

  close(): void {
    this.setOpen(false);
  }

  /**
   * Called once a frame by `main.ts`. Two jobs and both are one comparison in
   * the ordinary case.
   *
   * The **forcing** test is here rather than on the `MSG.TALENTS` callback
   * because it depends on `signedIn`, which is the browser's own answer and can
   * become true after the frame that made the level 2 -- somebody who signs up
   * mid-session. A frame loop asks the question again on the next frame; a
   * callback would have asked it once, at the wrong moment, and never again.
   */
  frame(): void {
    const level = this.source.level();
    const now = performance.now();

    // --- The beat. Any level, not only the second: the same four notes and the
    //     same line, because "you went up" is the news either way. The first
    //     level this panel ever sees is adopted silently -- a page load is not
    //     an achievement.
    if (this.lastLevel < 0) {
      this.lastLevel = level;
    } else if (level > this.lastLevel) {
      this.lastLevel = level;
      const choosing = level >= TEAM_CHOICE_LEVEL && this.source.team() === TEAM.NONE && this.source.signedIn();
      this.beat(level, choosing);
    }

    if (!this.forced && this.source.online() && this.source.signedIn()) {
      if (level >= TEAM_CHOICE_LEVEL && this.source.team() === TEAM.NONE) {
        // Wait for the beat to finish. `beatUntil` is 0 for a player who was
        // already level 2 when they signed in, so that case opens immediately
        // -- there was no level-up to celebrate.
        if (now >= this.beatUntil) {
          this.forced = true;
          this.setOpen(true);
        }
      }
    }
    if (this.open) this.paint();
  }

  /**
   * Show the level-up line and play the chime. 1.7 s, matching the CSS.
   *
   * The DOM is two elements and a class; the animation is entirely in
   * `index.html` so the timing lives next to the keyframes rather than being
   * two numbers in two files that drift. Nothing here blocks: the world keeps
   * running under it, which is the difference between a beat and a cutscene.
   */
  private beat(level: number, choosing: boolean): void {
    const root = document.getElementById('levelup');
    const line = document.getElementById('levelup-line');
    const sub = document.getElementById('levelup-sub');
    this.beatUntil = performance.now() + LEVELUP_MS;
    this.source.fanfare?.();
    if (!root || !line || !sub) return;
    // Lower case, like every other sentence this game says to you.
    line.textContent = `level ${level}`;
    sub.textContent = choosing ? 'pick a side' : 'a talent point is yours';
    // Restart the animation on a second level-up inside the same session: a
    // class that is already on does not replay a keyframe.
    root.classList.remove('shown');
    void root.offsetWidth;
    root.classList.add('shown');
    window.setTimeout(() => root.classList.remove('shown'), LEVELUP_MS);
  }

  /** Redraw on the next `frame` -- what `NetClient.onTalents` calls. */
  invalidate(): void {
    this.drawn = '';
  }

  private setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.root?.classList.toggle('shown', open);
    this.source.setModal(open);
    if (open) {
      // The cursor, without which none of this is clickable. Re-locking is
      // deliberately not done on close, on `Phone.setCamera`'s argument: a
      // browser refuses `requestPointerLock` outside a user gesture, so the
      // click on the canvas afterwards is what re-locks, through `main.ts`'s
      // existing handler.
      if (document.pointerLockElement) document.exitPointerLock();
      this.drawn = '';
      this.paint();
    } else {
      this.hideTip();
    }
  }

  /**
   * Escape, and the one place this panel disobeys the rest of the interface.
   *
   * Before a side is chosen the key is swallowed -- not ignored, *swallowed*,
   * with `stopImmediatePropagation`, so it cannot reach the suggestions box
   * behind it either. See the header for why this is the one modal thing here.
   */
  private keydown(e: KeyboardEvent): void {
    if (!this.open) return;
    if (e.code !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (this.source.team() === TEAM.NONE) {
      const note = document.getElementById('talents-locknote');
      if (note) note.textContent = 'pick a side first. it lasts the week.';
      return;
    }
    this.setOpen(false);
  }

  // --- The DOM ------------------------------------------------------------------

  /**
   * The shell, built once at boot.
   *
   * Once rather than per open, on `SuggestionsPanel`'s terms: the tree grid is
   * 42 buttons with three listeners each, and rebuilding it every time somebody
   * looks at their build would be 126 listeners of churn to redraw text that
   * `paint` can simply overwrite. What `paint` changes is class names and
   * `textContent`; what `build` decides is the structure, which is a property of
   * the contract and never moves.
   */
  private build(): void {
    const root = this.root;
    if (!root) return;
    root.innerHTML = '';
    const inner = el('div', 'inner');
    inner.id = 'talents-inner';

    // --- The takeover.
    const choose = el('div');
    choose.id = 'talents-choose';
    choose.append(
      text('div', 'eyebrow', 'level 2 · the game is paused for you, not for anyone else'),
      text('p', 'big', 'You made level 2. Pick a side.'),
      text('p', 'sub', 'This lasts the week. Everyone can see which you picked from across the street.'),
    );
    const cards = el('div');
    cards.id = 'talents-cards';
    for (const team of [TEAM.MARITA, TEAM.DEFAULT] as const) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'tcard';
      card.style.background = TEAM_COLOUR[team].css;
      card.style.color = TEAM_COLOUR[team].ink;
      const pick = el('span', 'tpick');
      // `TEAM_NAME` in the button as well as in the heading. It reads as
      // repetition and it is the point: a player clicking a coloured rectangle
      // should be reading the name of the thing they are joining.
      pick.textContent = `choose ${TEAM_NAME[team]}`;
      card.append(
        text('div', 'tname', TEAM_NAME[team]),
        text('div', 'ttag', `${CARD_TAG[team]} · ${TEAM_COLOUR[team].css}`),
        text('p', '', BLURB[team]),
        pick,
      );
      card.addEventListener('click', () => this.source.choose(team));
      cards.appendChild(card);
    }
    choose.appendChild(cards);
    const lock = el('div');
    lock.id = 'talents-locknote';
    lock.textContent = 'the trees are below · hover to read them · you cannot spend a point until you choose';
    choose.appendChild(lock);
    inner.appendChild(choose);

    // --- The points bar.
    const bar = el('div');
    bar.id = 'talents-bar';
    const pts = el('div', 'pts');
    const left = el('span');
    left.id = 'talents-left';
    pts.append(left, text('small', '', 'points left'));
    const who = el('div', 'none');
    who.id = 'talents-who';
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.id = 'talents-reset';
    reset.textContent = 'reset points';
    reset.addEventListener('click', () => this.source.resetAll());
    const hint = el('div', 'hint');
    hint.id = 'talents-hint';
    const shut = document.createElement('button');
    shut.type = 'button';
    shut.id = 'talents-close';
    shut.textContent = 'close (esc)';
    shut.addEventListener('click', () => {
      if (this.source.team() !== TEAM.NONE) this.setOpen(false);
    });
    bar.append(pts, who, reset, hint, shut);
    inner.appendChild(bar);

    // --- The six trees, both teams. Only the chosen team's are shown once a
    // side is picked; before that, all six are drawn and locked, which is the
    // mock's whole argument for the screen -- you are choosing between two sets
    // of talents you can read rather than between two colours.
    const trees = el('div');
    trees.id = 'talents-trees';
    inner.appendChild(trees);
    for (const tree of TREES) {
      const box = el('div', 'ttree');
      box.dataset.team = String(tree.team);
      const head = document.createElement('h3');
      head.textContent = tree.name;
      const spent = el('div', 'tspent');
      spent.dataset.tree = `${tree.team}:${tree.index}`;
      box.append(head, text('div', 'tdesc', tree.desc), spent);
      const mine = NODES.filter((n) => n.team === tree.team && n.tree === tree.index);
      for (let tier = 0; tier <= 3; tier++) {
        const tierEl = el('div', 'ttier');
        tierEl.append(text('div', 'treq', tierLabel(tier)));
        const row = el('div', tier === 3 ? 'trow mega' : 'trow');
        for (const nd of mine.filter((n) => n.tier === tier)) {
          row.appendChild(this.buildNode(nd));
        }
        tierEl.appendChild(row);
        box.appendChild(tierEl);
      }
      trees.appendChild(box);
    }

    // --- The build summary.
    const summary = el('div');
    summary.id = 'talents-summary';
    const list = document.createElement('ul');
    list.id = 'talents-build';
    const look = el('div');
    look.id = 'talents-look';
    summary.append(text('h4', '', 'your build'), list, look);
    inner.appendChild(summary);

    root.appendChild(inner);
  }

  private buildNode(nd: TalentNode): HTMLElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = nd.tier === 3 ? 'tnode megan' : 'tnode';
    b.append(text('div', 'tn', nd.name), text('div', 'tk', nd.kind), text('div', 'tcost', '1'));
    if (nd.bigNight) b.append(text('div', 'tbest', 'everyone takes this'));
    b.addEventListener('mouseenter', (e) => this.showTip(e, nd));
    b.addEventListener('mousemove', (e) => this.moveTip(e));
    b.addEventListener('mouseleave', () => this.hideTip());
    b.addEventListener('focus', (e) => this.showTip(e as unknown as MouseEvent, nd));
    b.addEventListener('blur', () => this.hideTip());
    // Shift-click refunds, which is the mock's gesture and is deliberately not a
    // second button on every node: 42 nodes with two controls each is 84 things
    // to hit, and the refund is the rarer of the two by an order of magnitude.
    // The hint line in the bar says so, permanently.
    b.addEventListener('click', (e) => {
      if (e.shiftKey) this.source.refund(nd.id);
      else this.source.take(nd.id);
    });
    this.nodeEls.set(nd.id, b);
    return b;
  }

  // --- Painting -----------------------------------------------------------------

  /**
   * Redraw, if anything moved.
   *
   * The key is the four facts the whole screen is a function of, which is why a
   * frame with the panel open and nothing happening costs one string compare --
   * `hud.money`'s arrangement, and this screen is much the more expensive of the
   * two to rebuild.
   */
  private paint(): void {
    const team = this.source.team();
    const mask = this.source.mask();
    const level = this.source.level();
    const key = `${team}|${mask.lo}|${mask.hi}|${level}`;
    if (key === this.drawn) return;
    this.drawn = key;

    const budget = pointsFor(level);
    const spent = countBits(mask);
    const chosen = team !== TEAM.NONE;

    setDisplay('talents-choose', chosen ? 'none' : '');
    setDisplay('talents-close', chosen ? '' : 'none');
    setText('talents-left', String(Math.max(0, budget - spent)));
    const who = document.getElementById('talents-who');
    if (who) {
      who.textContent = chosen ? TEAM_NAME[team] : 'no side yet';
      who.className = chosen ? '' : 'none';
      who.style.background = chosen ? TEAM_COLOUR[team].css : '';
      who.style.color = chosen ? TEAM_COLOUR[team].ink : '';
    }
    setText(
      'talents-hint',
      chosen
        ? `click a talent to spend a point · shift-click to refund · you are level ${level} (a mega needs ${MEGA_LEVEL})`
        : 'the trees below are read-only until you choose',
    );
    setDisplay('talents-reset', chosen && spent > 0 ? '' : 'none');

    // The trees: the chosen side's only, once there is one.
    for (const box of document.querySelectorAll<HTMLElement>('.ttree')) {
      const mineTeam = Number(box.dataset.team);
      box.style.display = chosen && mineTeam !== team ? 'none' : '';
      box.classList.toggle('locked', !chosen);
    }
    for (const el2 of document.querySelectorAll<HTMLElement>('.tspent')) {
      const [t, i] = (el2.dataset.tree ?? '0:0').split(':').map(Number);
      el2.textContent = `${spentInTree(mask, t as Team, i)} in tree`;
    }

    for (const nd of NODES) {
      const b = this.nodeEls.get(nd.id);
      if (!b) continue;
      const taken = chosen && nd.team === team && hasNode(mask, nd.id);
      const avail = !taken && takeRefusal(mask, team, level, nd.id) === '';
      b.classList.toggle('taken', taken);
      b.classList.toggle('avail', avail);
      b.classList.toggle('dead', !taken && !avail);
      // The tint on a taken node is the team's, inline from the contract.
      b.style.borderColor = taken ? TEAM_COLOUR[nd.team].css : '';
      b.style.boxShadow = taken ? `inset 3px 0 0 ${TEAM_COLOUR[nd.team].css}` : '';
      const cost = b.querySelector('.tcost');
      if (cost) cost.textContent = taken ? '✓' : '1';
    }

    this.paintSummary(team, mask, budget, spent);
  }

  private paintSummary(team: Team, mask: Readonly<TalentMask>, budget: number, spent: number): void {
    const list = document.getElementById('talents-build');
    if (list) {
      list.innerHTML = '';
      const mine = NODES.filter((n) => n.team === team && hasNode(mask, n.id));
      if (mine.length === 0) {
        list.appendChild(text('li', 'tmuted', 'nothing yet'));
      } else {
        for (const nd of mine) {
          const li = document.createElement('li');
          const b = document.createElement('b');
          b.textContent = nd.name;
          li.append(b, text('span', 'tmuted', ` · ${treeName(nd)} · ${nd.kind}`));
          list.appendChild(li);
        }
      }
    }
    // The one line in the panel that describes what other people can *see*,
    // which is the mock's "look" note and is the reason Big Night is the tax it
    // is: the point buys a pip and a silhouette. The renderer draws both --
    // horns for one side, cactus for the other -- off `TalentNode.bigNight`.
    const bits: string[] = [];
    const bigNight = NODES.find((n) => n.team === team && n.bigNight);
    if (bigNight && hasNode(mask, bigNight.id)) {
      bits.push(team === TEAM.MARITA
        ? 'you have horns. everyone can see them from 40 m.'
        : 'your body is cactus parts. everyone can see it from 40 m.');
    }
    if (NODES.some((n) => n.team === team && n.tier === 3 && hasNode(mask, n.id))) {
      bits.push('you have a mega. that took commitment.');
    } else if (team !== TEAM.NONE && spent >= budget && budget > 0) {
      bits.push('no mega this week — you spread out instead. that is a legitimate build.');
    }
    setText('talents-look', bits.join(' '));
  }

  // --- The tooltip ---------------------------------------------------------------

  /**
   * The node's effect, its flavour, and **the server's own refusal**.
   *
   * The third line is the whole reason the tooltip is worth having: a greyed-out
   * node with no explanation is a menu you have to guess at, and `takeRefusal`
   * already composes the sentence -- *"needs 2 in Servo (you have 1)"* -- in the
   * file both ends adjudicate from. See the header on why that is a rule
   * evaluated twice rather than a prediction.
   */
  private showTip(e: MouseEvent, nd: TalentNode): void {
    const tip = this.tip;
    if (!tip) return;
    const team = this.source.team();
    const mask = this.source.mask();
    const level = this.source.level();
    tip.innerHTML = '';
    tip.append(text('div', 'th', nd.name));
    const chips = el('div', 'tchips');
    chips.append(text('span', '', nd.kind), text('span', '', treeName(nd)), text('span', '', TEAM_NAME[nd.team]));
    tip.append(chips, text('div', 'te', nd.effect), text('div', 'tf', nd.flavour));

    let line = '';
    let ok = false;
    if (team === TEAM.NONE) {
      line = 'locked — choose a side to spend';
    } else if (nd.team !== team) {
      line = `that is a ${TEAM_NAME[nd.team]} talent`;
    } else if (hasNode(mask, nd.id)) {
      const blocked = refundRefusal(mask, team, nd.id);
      line = blocked === '' ? 'taken · shift-click to refund' : `taken · cannot refund: ${blocked}`;
      ok = blocked === '';
    } else {
      const refusal = takeRefusal(mask, team, level, nd.id);
      line = refusal === '' ? 'available · 1 point' : refusal;
      ok = refusal === '';
    }
    tip.append(text('div', ok ? 'tr ok' : 'tr', line));
    tip.style.display = 'block';
    this.moveTip(e);
  }

  private moveTip(e: MouseEvent): void {
    const tip = this.tip;
    if (!tip || tip.style.display !== 'block') return;
    // Clamped to the viewport, because a tooltip that runs off the right edge
    // on the third column is a tooltip nobody can read for two of the six trees.
    const x = Math.min((e.clientX || 0) + 16, window.innerWidth - tip.offsetWidth - 8);
    const y = Math.min((e.clientY || 0) + 16, window.innerHeight - tip.offsetHeight - 8);
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }

  private hideTip(): void {
    if (this.tip) this.tip.style.display = 'none';
  }
}

// --- Small DOM helpers ---------------------------------------------------------

function el(tag: string, cls = ''): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

function text(tag: string, cls: string, body = ''): HTMLElement {
  const node = el(tag, cls);
  node.textContent = body;
  return node;
}

function setText(id: string, body: string): void {
  const node = document.getElementById(id);
  if (node) node.textContent = body;
}

function setDisplay(id: string, value: string): void {
  const node = document.getElementById(id);
  if (node) node.style.display = value;
}

function treeName(nd: TalentNode): string {
  return TREES.find((t) => t.team === nd.team && t.index === nd.tree)?.name ?? '';
}

/**
 * What the divider above each tier says.
 *
 * Composed from `TIER_REQ` and `MEGA_LEVEL` rather than written out, because the
 * mock's own numbers were wrong -- it said a mega needs 7 in the tree and the
 * contract's arithmetic makes it 6 (a tree has six non-mega nodes; see
 * `TIER_REQ`'s comment). A hard-coded label would have shipped the mock's
 * number over the contract's rule, which is a panel that refuses a click it
 * says is legal.
 */
function tierLabel(tier: number): string {
  if (tier === 3) return `mega · ${TIER_REQ[3]} in tree · level ${MEGA_LEVEL}`;
  if (tier === 0) return 'tier 1';
  return `tier ${tier + 1} · ${TIER_REQ[tier]} in tree`;
}

// --- The self-check --------------------------------------------------------------

/**
 * The spelling guard, and the two labels that can silently disagree with the
 * contract.
 *
 * Browser-only, and it is the one `verify*` in this feature that is: everything
 * else about teams is three-free and runs in both boot lists, but this file
 * reaches for `document` in its constructor. What it checks is nonetheless pure
 * -- a table of strings and a label function -- and it is here rather than in a
 * three-free module because moving two paragraphs of panel copy into the shared
 * contract to make a check convenient is the tail wagging the dog. See
 * `game/teams.verifyTeams`, whose spelling grep this deliberately mirrors.
 */
export function verifyTalentsPanel(): string[] {
  const failures: string[] = [];

  // --- The names are never uppercased by CSS. The owner shipped a screenshot of
  //     MARITA and DEFAULT on the very panel where a player learns the two
  //     spellings: `text-transform: uppercase` on the card heading. `textContent`
  //     cannot catch that -- the DOM still says "Marita" -- so this asks the
  //     browser what it would actually paint, on the elements that carry a name.
  if (typeof document !== 'undefined' && typeof getComputedStyle === 'function') {
    for (const [what, cls] of [['the card heading', 'tname'], ['the choose button', 'tpick']] as const) {
      const probe = document.createElement('div');
      probe.className = cls;
      const card = document.createElement('div');
      card.className = 'tcard';
      card.appendChild(probe);
      card.style.position = 'absolute';
      card.style.visibility = 'hidden';
      document.body.appendChild(card);
      const transform = getComputedStyle(probe).textTransform;
      card.remove();
      if (transform === 'uppercase' || transform === 'lowercase' || transform === 'capitalize') {
        failures.push(
          `${what} paints its text \`${transform}\`, so ${TEAM_NAME[TEAM.MARITA]} and ${TEAM_NAME[TEAM.DEFAULT]} ` +
            'reach the screen mis-spelt. The two names are drawn exactly as the contract spells them.',
        );
      }
    }
  }

  // The same regex `verifyTeams` uses, over the strings that file cannot see.
  const wrong = /\b(marita|MARITA|Default|default|DEFAULT|Defaut|DeFault|Marrita)\b/;
  const copy = [
    ...Object.values(BLURB),
    ...Object.values(CARD_TAG),
    'level 2 · the game is paused for you, not for anyone else',
    'You made level 2. Pick a side.',
    'This lasts the week. Everyone can see which you picked from across the street.',
    'the trees are below · hover to read them · you cannot spend a point until you choose',
    'pick a side first. it lasts the week.',
    'the trees below are read-only until you choose',
    'no side yet',
    'your build',
    'nothing yet',
    'you have horns. everyone can see them from 40 m.',
    'your body is cactus parts. everyone can see it from 40 m.',
    'you have a mega. that took commitment.',
    'no mega this week — you spread out instead. that is a legitimate build.',
  ];
  for (const line of copy) {
    if (wrong.test(line)) {
      failures.push(`The talents panel spells a team name wrongly: "${line.slice(0, 60)}". Only "Marita" and "DeFAULT".`);
    }
  }
  // And the names it *does* draw come from the contract rather than from here.
  for (const team of [TEAM.MARITA, TEAM.DEFAULT] as const) {
    if (BLURB[team].includes(TEAM_NAME[team])) {
      failures.push(`${TEAM_NAME[team]}'s blurb spells its own name; draw TEAM_NAME so there is one copy.`);
    }
  }

  // The tier labels are the contract's numbers, which is the failure the mock
  // would have shipped: it said a mega needs 7 in the tree and it needs 6.
  {
    const mega = tierLabel(3);
    if (!mega.includes(`${TIER_REQ[3]} in tree`)) {
      failures.push(`The mega's label says "${mega}" where the contract requires ${TIER_REQ[3]} in the tree.`);
    }
    if (!mega.includes(`level ${MEGA_LEVEL}`)) {
      failures.push(`The mega's label does not name level ${MEGA_LEVEL}.`);
    }
    for (const tier of [1, 2]) {
      if (!tierLabel(tier).includes(`${TIER_REQ[tier]} in tree`)) {
        failures.push(`Tier ${tier + 1}'s label disagrees with TIER_REQ[${tier}] = ${TIER_REQ[tier]}.`);
      }
    }
    if (tierLabel(0) !== 'tier 1') failures.push(`Tier 1's label is "${tierLabel(0)}"; it has no requirement to state.`);
  }

  // Every tree the panel builds a column for is a tree that exists, and every
  // node lands in one of them. A node with a `tree` index nothing draws would
  // simply not appear, which is a talent nobody can take and nothing reports.
  {
    for (const nd of NODES) {
      if (treeName(nd) === '') failures.push(`${nd.name} is in tree ${nd.tree} of ${TEAM_NAME[nd.team]}, which the panel has no column for.`);
      if (nd.tier < 0 || nd.tier > 3) failures.push(`${nd.name} is at tier ${nd.tier}; the panel draws four.`);
    }
    if (TREES.length !== 6) failures.push(`${TREES.length} trees, not 6; the grid is three columns of one team.`);
  }

  return failures;
}
