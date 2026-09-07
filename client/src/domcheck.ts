/**
 * The index, checked against what the code believes about it.
 *
 * `client/index.html` is three thousand lines of markup that no compiler reads.
 * TypeScript checks every line that *uses* it -- `document.getElementById('x')!`
 * is well typed however wrong it is -- and the failure it produces is silent in
 * this repo's particular sense: the panel simply does not appear, or appears
 * with a piece missing, and nothing anywhere says why.
 *
 * Two real bugs found in one evening are what this is for, and both had been
 * shipped for a long time.
 *
 * The first was a `<section>` in the controls panel that was never closed. HTML
 * does not auto-close a section when the next one opens -- sections nest -- so
 * every section after `the button in sydney park` was a *child* of it rather
 * than a sibling flex item, and the panel's column layout had been quietly
 * wrong from that point down for as long as the tag had been missing. The
 * browser recovers, renders something, and reports nothing.
 *
 * The second was `#account-confirm-field`: `JoinGate.paint` hides it by setting
 * the `hidden` attribute, and `[hidden] { display: none }` is the
 * lowest-specificity rule in the language, so a single `display: flex` in the
 * stylesheet had been showing everyone a `password again` box on the log-in
 * form since the pane was written. A hidden element that is not hidden is
 * exactly the kind of thing a person stops seeing after the second time they
 * look at it, and exactly the kind of thing a computed style can settle.
 *
 * So this asserts the handful of structural facts the TypeScript depends on and
 * cannot state: that the elements it reaches for by id are there, that the two
 * join tabs it drives are the two it thinks, that nothing in the controls panel
 * nests, and that an element marked `hidden` is actually not displayed.
 *
 * Browser-only, and therefore on the client's boot list alone -- it reads
 * `document`. Everything else added tonight is pure and runs on both.
 */

// The rows the compact controls block is meant to have, and their keycaps. The
// markup is the copy a player sees; this is the copy the code acts on, and the
// check below is what stops the two from drifting.
import { CONTROL_ROWS } from './game/controlshint.ts';

/**
 * Ids `client/src` reaches for with a non-null assertion.
 *
 * Gathered from the `getElementById(...)!` and `as HTML...Element` sites in
 * `accounts.ts` and `hud.ts`. Not exhaustive over the whole document on
 * purpose: a list of every id in a three-thousand-line file would be a second
 * copy of the file, and would fail on every deliberate rename. These are the
 * ones whose absence is a `null` dereference during boot.
 */
const REQUIRED_IDS: readonly string[] = [
  'lift',
  'lift-list',
  'loading',
  'loading-text',
  'nameprompt',
  'nameprompt-inner',
  'nameprompt-who',
  'nameprompt-tabs',
  'nameprompt-quick',
  'nameprompt-login',
  'nameprompt-signedin',
  'nameprompt-input',
  'nameprompt-join',
  'nameprompt-note',
  'account-play',
  'account-handle',
  'account-password',
  'account-confirm',
  'account-confirm-field',
  'account-submit',
  'account-switch',
  'account-note',
  'help',
  'helpfull',
  // The hero line and the `you` column, this pass. See UI.md.
  'hero',
  'hero-text',
  'hero-rule',
  'you',
  'money',
  'level',
  'heat',
  'investigation',
  'questtrack',
  'locator',
  'minimap',
  'touch',
  'touch-stick',
  'touch-knob',
  'touch-look',
  'touch-context',
  'touch-context-text',
  'touch-bat',
  'touch-footy',
  'touch-jump',
];

/** Self-check. Client boot list only: it reads the DOM. */
export function verifyIndexDom(): string[] {
  const failures: string[] = [];
  if (typeof document === 'undefined') return failures;

  // --- Everything the code dereferences without checking is there.
  for (const id of REQUIRED_IDS) {
    if (document.getElementById(id) === null) {
      failures.push(`index.html has no #${id}, and the code that reaches for it does not check.`);
    }
  }

  // --- Nothing in the controls panel nests.
  //
  // The bug this exists for. A missing `</section>` renders, and the only
  // symptom is a column layout that is subtly wrong a long way down the panel.
  const helpfull = document.getElementById('helpfull');
  if (helpfull !== null) {
    const nested = helpfull.querySelectorAll('section section').length;
    if (nested > 0) {
      failures.push(
        `${nested} section(s) inside another section in #helpfull -- a </section> is missing, ` +
          `and every section after it is a child rather than a column.`,
      );
    }
    if (helpfull.querySelectorAll(':scope > section').length < 10) {
      failures.push('#helpfull has fewer than ten top-level sections; the controls list has lost most of itself.');
    }
  }

  // --- The join tabs are the two the code drives.
  //
  // `JoinGate` reads `button.dataset.join` and compares it to `'account'`, so a
  // third tab, a renamed value or a missing attribute is a tab that silently
  // selects quick play for ever.
  const tabs = document.getElementById('nameprompt-tabs');
  if (tabs !== null) {
    const buttons = Array.from(tabs.querySelectorAll('button'));
    const values = buttons.map((b) => b.dataset.join ?? '');
    if (buttons.length !== 2) {
      failures.push(`#nameprompt-tabs has ${buttons.length} buttons; JoinGate drives exactly two.`);
    }
    for (const want of ['quick', 'account']) {
      if (!values.includes(want)) {
        failures.push(`no join tab carries data-join="${want}"; JoinGate can never select it.`);
      }
    }
  }

  /*
   * --- The collapsing controls block: the markup and the module are one list.
   *
   * `game/controlshint.ts` owns the ids and the arithmetic; `index.html` owns
   * the words and carries a `data-ctl` on every row. That duplication is
   * deliberate -- the corner has to paint before a module has loaded -- and this
   * is the check that makes it safe. The failure it convicts is silent in this
   * file's own sense: a row added to the markup with no id here never goes
   * away, and an id here with no row in the markup is a control the block can
   * never stop shouting about.
   *
   * As a **sequence**, not a set, so a row moved in one place and not the other
   * is caught too. The order is what a player reads down.
   */
  const help = document.getElementById('help');
  if (help !== null) {
    const marked = Array.from(help.querySelectorAll<HTMLElement>('[data-ctl]')).map((el) => el.dataset.ctl ?? '');
    const wanted = CONTROL_ROWS.map((row) => row.id);
    if (marked.join(',') !== wanted.join(',')) {
      failures.push(
        `#help carries [${marked.join(', ')}] and game/controlshint.ts carries [${wanted.join(', ')}]; ` +
          `a row in one and not the other is a row that never collapses or a control the block cannot name.`,
      );
    }
    // And the words match, so a keycap can be corrected in one file and stay
    // wrong in the other -- which is how a legend ends up teaching the wrong key.
    for (const row of CONTROL_ROWS) {
      const el = help.querySelector<HTMLElement>(`[data-ctl="${row.id}"]`);
      if (el === null) continue;
      const key = el.querySelector('kbd')?.textContent ?? '';
      if (key !== row.key) {
        failures.push(`#help draws "${key}" for the ${row.id} control where game/controlshint.ts says "${row.key}".`);
      }
    }
    // The eyebrow has no id and must not get one: it is what keeps `h`
    // findable once every row has gone.
    const eyebrow = help.querySelector('.eyebrow');
    if (eyebrow === null) failures.push('#help has no eyebrow, so a player whose block has collapsed can never find h.');
    else if ((eyebrow as HTMLElement).dataset.ctl !== undefined) {
      failures.push('the #help eyebrow carries a data-ctl and would collapse with the rows it labels.');
    }
    // And `hidden` hides, here as well. `hud.paintControls` sets the attribute
    // and `#help span { display: inline-flex }` is exactly the kind of rule that
    // outranks it -- which is the bug this whole file was written for.
    const probe = document.createElement('span');
    probe.hidden = true;
    probe.style.position = 'fixed';
    probe.style.left = '-9999px';
    const line = help.querySelector('div.keys') ?? help;
    line.appendChild(probe);
    const shown = getComputedStyle(probe).display !== 'none';
    probe.remove();
    if (shown) {
      failures.push(
        'a span marked hidden inside #help is still displayed -- a stylesheet rule is outranking ' +
          '[hidden], and the controls block will never collapse.',
      );
    }
  }

  // --- The three panes are panes.
  for (const id of ['nameprompt-quick', 'nameprompt-login', 'nameprompt-signedin']) {
    const pane = document.getElementById(id);
    if (pane !== null && !pane.classList.contains('joinpane')) {
      failures.push(`#${id} is missing the joinpane class, so .joinpane { display: none } never hides it.`);
    }
  }

  // --- `hidden` actually hides.
  //
  // Not a structural fact but a cascade one, and the only way to state it is to
  // ask the browser. A probe rather than the real element, because the real one
  // is inside a panel that is `display: none` at boot and would answer for its
  // parent instead of for itself.
  const login = document.getElementById('nameprompt-login');
  if (login !== null) {
    const probe = document.createElement('div');
    probe.className = 'field';
    probe.hidden = true;
    // Rendered somewhere the same rules apply, but off the screen and out of
    // the flow, so nothing flashes on the way past.
    probe.style.position = 'fixed';
    probe.style.left = '-9999px';
    const wasShown = login.classList.contains('on');
    if (!wasShown) login.classList.add('on');
    login.appendChild(probe);
    const shown = getComputedStyle(probe).display !== 'none';
    probe.remove();
    if (!wasShown) login.classList.remove('on');
    if (shown) {
      failures.push(
        'a .field marked hidden inside #nameprompt-login is still displayed -- a stylesheet rule is ' +
          'outranking [hidden], and the password-confirm box will show on the log-in form.',
      );
    }
  }

  return failures;
}
