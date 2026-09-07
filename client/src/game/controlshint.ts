/**
 * The controls block, and the rule that lets it go away.
 *
 * A tester, relayed by the owner, in one sentence: *"a tutorial mission instead
 * of constant on screen instructions"*. The instructions in question are
 * `index.html`'s `#help` -- twenty-odd keycaps in the bottom-right corner, on
 * the screen from the first frame of the first session to the last frame of the
 * thousandth. They were put there for a good reason and the reason is written
 * in that file: *"this game keeps one on screen because its players arrive in a
 * browser with no manual"*. A player who has arrived and read it is not that
 * player any more, and the block has no way of noticing.
 *
 * DESIGN.md rule 6 is the one this was quietly failing: *"the city reacts; the
 * UI does not shout."* A permanent list of every binding is the UI shouting the
 * same sentence for ever, and the fact that it shouts it politely, in small
 * type, in a corner, is not a defence -- it is why nobody had noticed.
 *
 * ---------------------------------------------------------------------------
 * THE RULE, WHICH IS THE WHOLE MODULE
 *
 * **A row is on the screen until its control has been used, and then it is
 * not.** Not a timer, not a dismiss button, not a setting: the only thing that
 * takes a row away is the player doing the thing the row describes, which is
 * the one event that proves the row has done its job. Nine of them go in the
 * first two minutes of anybody's first session, and the corner is empty by the
 * time a player would have started resenting it.
 *
 * Three things fall out of that and all three are deliberate:
 *
 *   - **The eyebrow never goes.** `controls · h for all of them` stays whatever
 *     else has gone, because the moment the last row disappears is the moment
 *     the block stops being a reference, and a reference nobody can find is
 *     worse than one nobody reads. `H` is the permanent surface; this block is
 *     the transient one.
 *   - **`H` is unaffected.** `index.html`'s `#helpfull` lists every binding the
 *     game has, in ten sections, and nothing here touches it. `visibleRows`
 *     takes `showAll` for exactly that reason -- it is the answer to "the player
 *     asked for all of them", and it is the one input under which this function
 *     is not allowed to have an opinion.
 *   - **It is remembered.** A returning player has already learned WASD and
 *     should not be handed the wall again on Tuesday because Monday's tab was
 *     closed. `client/src/hud.ts` keeps the set in `localStorage`; this file
 *     owns the parse, because the parse is the part with a failure mode.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ROWS ARE HERE AND THE WORDS ARE IN `index.html`
 *
 * They are in both, and that is a duplication with a check under it rather than
 * an accident. The block is static markup and has to stay static markup: it is
 * on the screen before a single module has been imported, and a corner rendered
 * from JavaScript is a corner that is blank for the first second of a cold
 * boot -- which is the exact second the list exists for.
 *
 * So `index.html` carries the words and a `data-ctl` on every row, this file
 * carries the ids and the arithmetic, and `client/src/domcheck.ts` asserts the
 * two are the same set. A row added to the markup without an id here fails the
 * boot; an id here with no row in the markup fails it too. That is a cheaper
 * guarantee than a template, and it keeps the first paint.
 *
 * ---------------------------------------------------------------------------
 * THE SAME IDS ARE WHAT A QUEST STEP ASKS FOR
 *
 * `game/questmodel.ts`'s `use` step kind and its `control` field name a control
 * out of this table, which is why the table is a little wider than the block:
 * `car` and `train` are not rows -- both are `E`, and the block says `e doors,
 * cars, bikes` once -- but a quest step that puts you in a car wants to say so
 * with a keycap. `CONTROL_HINT` is therefore the superset and `CONTROL_ROWS` is
 * the part of it that is drawn in the corner.
 *
 * One table, so the tutorial and the legend can never disagree about which key
 * gets you into a car.
 *
 * ---------------------------------------------------------------------------
 * THREE-FREE
 *
 * `server/index.ts` runs `verifyControlsHint` on its boot list, and the server
 * imports `game/questmodel.ts`, which imports this for `controlId`. No DOM, no
 * three, no `localStorage` -- `hud.ts` holds the storage and hands the string
 * in, so the parse is checkable on a process with no browser in it.
 */

/**
 * Every control the game teaches, by id.
 *
 * Strings rather than numbers, for `questmodel.STEP_KIND`'s reason exactly:
 * these are written by a person into a JSON file on github.com, and `"control":
 * 7` in a file somebody is editing on a phone is a lookup table they do not
 * have. Nothing here is on the wire as an id -- `net/quests.ts` sends the string
 * -- so the byte argument does not apply.
 */
export const CONTROL = {
  MOVE: 'move',
  JUMP: 'jump',
  SPRINT: 'sprint',
  LOOK: 'look',
  BAT: 'bat',
  FOOTY: 'footy',
  ZOOM: 'zoom',
  THIRD: 'third',
  TORCH: 'torch',
  INTERACT: 'interact',
  PHONE: 'phone',
  SLOT_BAT: 'slot-bat',
  SLOT_FOOTY: 'slot-footy',
  SLOT_FISTS: 'slot-fists',
  OFFHAND: 'offhand',
  BUILD: 'build',
  FURNISH: 'furnish',
  JOBS: 'jobs',
  MAP: 'map',
  CHAT: 'chat',
  SCORES: 'scores',
  PANELS: 'panels',
  /** Not a row: `E` at a stopped car. The block says `e doors, cars, bikes`. */
  CAR: 'car',
  /** Not a row either, and the same key. Boarding and alighting are one verb. */
  TRAIN: 'train',
} as const;

export type ControlId = (typeof CONTROL)[keyof typeof CONTROL];

/** Which of the two lines of the block a row belongs to. `index.html`'s classes. */
export type ControlTier = 'keys' | 'more';

export interface ControlRow {
  id: string;
  /** What is drawn in the `<kbd>`. Lower case; the stylesheet does not fold it. */
  key: string;
  /** The verb beside it. */
  verb: string;
  tier: ControlTier;
}

/**
 * The rows of `#help`, in the order they are written there.
 *
 * The order is load-bearing in exactly one way: `domcheck.ts` compares this
 * list to the markup as a **sequence**, not a set, so a row moved in one place
 * and not the other is caught. Twenty-two of them, which is the number the
 * corner had before this pass plus `q`, which was missing: `Q` is the phone and
 * the phone is the interface (DESIGN.md rule 4), and the one binding that opens
 * it was the one binding the legend did not mention.
 */
export const CONTROL_ROWS: readonly ControlRow[] = [
  { id: CONTROL.MOVE, key: 'wasd', verb: 'move', tier: 'keys' },
  { id: CONTROL.JUMP, key: 'space', verb: 'jump', tier: 'keys' },
  { id: CONTROL.SPRINT, key: 'shift', verb: 'sprint', tier: 'keys' },
  { id: CONTROL.LOOK, key: 'mouse', verb: 'look', tier: 'keys' },
  { id: CONTROL.BAT, key: 'left click', verb: 'bat', tier: 'keys' },
  { id: CONTROL.FOOTY, key: 'right click', verb: 'footy', tier: 'keys' },
  { id: CONTROL.ZOOM, key: 'wheel', verb: 'zoom', tier: 'keys' },
  { id: CONTROL.THIRD, key: 'c', verb: 'third person', tier: 'keys' },
  { id: CONTROL.TORCH, key: 'f', verb: 'torch', tier: 'keys' },
  { id: CONTROL.INTERACT, key: 'e', verb: 'doors, cars, bikes', tier: 'keys' },
  { id: CONTROL.PHONE, key: 'q', verb: 'your phone', tier: 'keys' },
  { id: CONTROL.SLOT_BAT, key: '1', verb: 'bat', tier: 'more' },
  { id: CONTROL.SLOT_FOOTY, key: '2', verb: 'footy', tier: 'more' },
  { id: CONTROL.SLOT_FISTS, key: '4', verb: 'fists', tier: 'more' },
  { id: CONTROL.OFFHAND, key: 'shift+n', verb: 'off hand', tier: 'more' },
  { id: CONTROL.BUILD, key: 'b', verb: 'your build', tier: 'more' },
  { id: CONTROL.FURNISH, key: 'x', verb: 'furnish a room', tier: 'more' },
  { id: CONTROL.JOBS, key: 'j', verb: 'jobs', tier: 'more' },
  { id: CONTROL.MAP, key: 'm', verb: 'map', tier: 'more' },
  { id: CONTROL.CHAT, key: 'i', verb: 'chat', tier: 'more' },
  { id: CONTROL.SCORES, key: 'tab', verb: 'scores', tier: 'more' },
  { id: CONTROL.PANELS, key: 'esc', verb: "suggestions · what's new · report a bug · talents", tier: 'more' },
];

/**
 * The keycap and the verb for **any** control, row or not.
 *
 * Built from the rows so a row can never drift from its own hint, then widened
 * by the two that are not rows. `game/questtrack.ts` reads this to put a keycap
 * on the open step and nothing else does.
 */
export const CONTROL_HINT: Readonly<Record<string, { key: string; verb: string }>> = (() => {
  const out: Record<string, { key: string; verb: string }> = {};
  for (const row of CONTROL_ROWS) out[row.id] = { key: row.key, verb: row.verb };
  out[CONTROL.CAR] = { key: 'e', verb: 'get in a car' };
  out[CONTROL.TRAIN] = { key: 'e', verb: 'get on, and off' };
  return out;
})();

/**
 * A `control` field as a content file may spell it, folded to a known id or `''`.
 *
 * Folded rather than refused, on `questmodel.parseStep`'s standing radius
 * argument: a typo in a **hint** should cost the hint, not the pack. The one
 * place that is not true is a `use` step, whose control *is* the completion
 * condition -- a `use` step with no control is a step nobody can ever finish,
 * and `parseStep` refuses that one rather than shipping a dead end.
 */
export function controlId(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return Object.hasOwn(CONTROL_HINT, text) ? text : '';
}

/**
 * Which rows the corner still draws.
 *
 * `showAll` is `H`: every row, whatever has been used, because a player who
 * asks for the list is asking for the list. It is the only input this function
 * refuses to have an opinion about, and `verifyControlsHint` says so.
 *
 * Monotone in `used` by construction -- it is a filter -- and that is the
 * property worth stating, because the failure it rules out is a block that
 * grows a row back. A row that reappears reads as the game forgetting, and a
 * player who is told a thing twice stops believing the first time.
 */
export function visibleRows(used: ReadonlySet<string>, showAll = false): readonly ControlRow[] {
  if (showAll) return CONTROL_ROWS;
  return CONTROL_ROWS.filter((row) => !used.has(row.id));
}

/**
 * Which control a keydown is, or `''`.
 *
 * Here rather than as a `switch` in `main.ts`'s keydown listener, for the
 * reason every other table in this repo is somewhere a check can read it: the
 * failure mode is a row that never collapses because the key that dismisses it
 * is the wrong `code`, and that is invisible -- the block simply stays up, which
 * is what it used to do anyway. `verifyControlsHint` walks every row and
 * insists there is a way to dismiss it.
 *
 * `code` rather than `key`, like every binding in this project: on a French
 * keyboard the unshifted digits are letters, and a legend that could not be
 * dismissed on an AZERTY is a legend that is permanent for a whole country.
 *
 * Three rows are **not** here and cannot be: `move`, `sprint` and `look` are
 * not keydowns at all -- they are the assembled input and the mouse delta, so
 * `main.ts` marks them off the frame it is already building. Walking with the
 * arrow keys or the touch stick counts, which is the reason to read the input
 * rather than the keyboard.
 */
export function controlForKey(code: string, shift: boolean): string {
  // The number row, and the modifier that sends it to the other hand. `Digit3`
  // was the phone and is now nothing; it still counts as reaching for the off
  // hand, because that is what shift-3 does.
  if (code === 'Digit1' || code === 'Digit2' || code === 'Digit3' || code === 'Digit4') {
    if (shift) return CONTROL.OFFHAND;
    if (code === 'Digit1') return CONTROL.SLOT_BAT;
    if (code === 'Digit2') return CONTROL.SLOT_FOOTY;
    if (code === 'Digit4') return CONTROL.SLOT_FISTS;
    return '';
  }
  switch (code) {
    case 'Space':
      return CONTROL.JUMP;
    case 'KeyE':
      return CONTROL.INTERACT;
    case 'KeyQ':
      return CONTROL.PHONE;
    case 'KeyJ':
      return CONTROL.JOBS;
    case 'KeyM':
      return CONTROL.MAP;
    case 'KeyC':
      return CONTROL.THIRD;
    case 'KeyF':
      return CONTROL.TORCH;
    case 'KeyB':
      return CONTROL.BUILD;
    case 'KeyX':
      return CONTROL.FURNISH;
    case 'KeyI':
      return CONTROL.CHAT;
    case 'Tab':
      return CONTROL.SCORES;
    case 'Escape':
      return CONTROL.PANELS;
    // The two no-pointer-lock fallbacks. A player who can only swing with the
    // keyboard has still learned the swing, and the row should go.
    case 'KeyK':
      return CONTROL.BAT;
    case 'KeyL':
      return CONTROL.FOOTY;
    default:
      return '';
  }
}

/**
 * The three rows no keydown can dismiss, named so the check can exempt them.
 *
 * `main.ts` marks these off the assembled input and the mouse, which is the
 * only honest place: `move` has to count the arrow keys and the touch stick,
 * `sprint` is shift *while going somewhere* (shift on its own is a modifier,
 * and dismissing the sprint row when somebody pressed shift-2 would be a lie),
 * and `look` is a pointer delta.
 */
export const NOT_KEYBOARD: readonly string[] = [CONTROL.MOVE, CONTROL.SPRINT, CONTROL.LOOK, CONTROL.ZOOM];

/** The key `hud.ts` keeps the used set under. Namespaced; the origin is shared. */
export const CONTROLS_STORE_KEY = 'sydney.controls.used';

/**
 * What was stored, made safe.
 *
 * Everything that is not a JSON array of ids this file knows produces the empty
 * set, which is the full list -- **the wall, not the blank**. That direction is
 * the whole decision: a parse that failed open would hide the controls from a
 * player whose storage is corrupt, on their first session, with no way back
 * except a key they were never shown. Failing closed costs a returning player
 * one look at a block they have already read.
 *
 * Unknown ids are dropped rather than kept, so a row renamed in a later build
 * does not stay hidden for ever off a string nothing writes any more.
 */
export function readUsed(raw: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (typeof raw !== 'string' || raw === '') return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const folded = controlId(item);
    if (folded !== '') out.add(folded);
  }
  return out;
}

/** The set as a string to store. Sorted, so two sessions produce one value. */
export function writeUsed(used: ReadonlySet<string>): string {
  return JSON.stringify([...used].filter((id) => controlId(id) !== '').sort());
}

export function verifyControlsHint(): string[] {
  const failures: string[] = [];
  const ALL = CONTROL_ROWS.length;

  // --- The table is a table: unique ids, a hint each, nothing blank.
  {
    const seen = new Set<string>();
    for (const row of CONTROL_ROWS) {
      if (seen.has(row.id)) failures.push(`Two rows of the controls block are both "${row.id}".`);
      seen.add(row.id);
      if (row.key === '' || row.verb === '') failures.push(`The "${row.id}" row has no key or no verb.`);
      if (!Object.hasOwn(CONTROL_HINT, row.id)) failures.push(`The "${row.id}" row has no hint to draw on a quest step.`);
    }
    for (const id of Object.values(CONTROL)) {
      if (!Object.hasOwn(CONTROL_HINT, id)) failures.push(`CONTROL.${id} is not in CONTROL_HINT and cannot be drawn.`);
    }
  }

  // --- Nothing stored is the wall. The first session sees every row.
  {
    const none = visibleRows(readUsed(null));
    if (none.length !== ALL) failures.push(`A player with nothing stored saw ${none.length} rows, not ${ALL}.`);
  }

  // --- THE ONE THAT MATTERS. The set shrinks by one per control, and never grows.
  {
    const used = new Set<string>();
    let previous = visibleRows(used).length;
    if (previous !== ALL) failures.push('An empty used set did not produce the whole block.');
    for (const row of CONTROL_ROWS) {
      used.add(row.id);
      const now = visibleRows(used).length;
      if (now !== previous - 1) {
        failures.push(`Using "${row.id}" took the block from ${previous} rows to ${now}, not ${previous - 1}.`);
      }
      if (visibleRows(used).some((r) => r.id === row.id)) {
        failures.push(`The "${row.id}" row was still drawn after its control had been used.`);
      }
      previous = now;
    }
    if (previous !== 0) failures.push(`Every control used still left ${previous} rows in the corner.`);
  }

  // --- A used set that is already full leaves nothing but the eyebrow.
  {
    const everything = new Set(CONTROL_ROWS.map((r) => r.id));
    if (visibleRows(everything).length !== 0) failures.push('A returning player was shown the wall again.');
    // And `H` is still the whole list, which is the point of the eyebrow staying.
    if (visibleRows(everything, true).length !== ALL) {
      failures.push('H did not show every control to a player who had used every control.');
    }
    if (visibleRows(new Set(), true).length !== ALL) failures.push('H did not show every control to a new player.');
  }

  // --- Corrupt storage is the wall rather than a throw.
  {
    for (const bad of ['{', 'null', '"nope"', '[1,2,3]', 'undefined', '[', '{"used":["move"]}', '']) {
      let rows = -1;
      try {
        rows = visibleRows(readUsed(bad)).length;
      } catch (err) {
        failures.push(`A stored value of ${JSON.stringify(bad)} threw: ${String(err)}`);
        continue;
      }
      if (rows !== ALL) failures.push(`A stored value of ${JSON.stringify(bad)} hid ${ALL - rows} rows.`);
    }
    // A partly-good array keeps the good part and drops the rest.
    const mixed = readUsed('["move","not-a-control",7,"jump"]');
    if (mixed.size !== 2 || !mixed.has(CONTROL.MOVE) || !mixed.has(CONTROL.JUMP)) {
      failures.push(`A mixed stored array came back as ${JSON.stringify([...mixed])}.`);
    }
  }

  // --- What is written comes back.
  {
    const used = new Set<string>([CONTROL.MOVE, CONTROL.PHONE, CONTROL.JOBS]);
    const back = readUsed(writeUsed(used));
    if (back.size !== used.size || [...used].some((id) => !back.has(id))) {
      failures.push(`The used set did not survive a round trip: ${writeUsed(used)}.`);
    }
    if (writeUsed(new Set([CONTROL.PHONE, CONTROL.MOVE])) !== writeUsed(new Set([CONTROL.MOVE, CONTROL.PHONE]))) {
      failures.push('Two sessions with the same controls used wrote two different strings.');
    }
    if (writeUsed(new Set(['not-a-control'])) !== '[]') failures.push('An unknown id was written to storage.');
  }

  /*
   * --- Every row has a way to be dismissed, and it is the right one.
   *
   * The failure this rules out is the quiet one: a row bound to the wrong
   * `code` never collapses, and a legend that never collapses is exactly what
   * this pass was written to stop. `NOT_KEYBOARD` is the exemption list and it
   * is checked too -- an id on it that a keydown *does* answer would be a row
   * dismissed twice, from two files, which is how the two go out of step.
   */
  {
    const CODES = [
      'KeyA', 'KeyB', 'KeyC', 'KeyD', 'KeyE', 'KeyF', 'KeyG', 'KeyH', 'KeyI', 'KeyJ', 'KeyK', 'KeyL',
      'KeyM', 'KeyN', 'KeyO', 'KeyP', 'KeyQ', 'KeyR', 'KeyS', 'KeyT', 'KeyU', 'KeyV', 'KeyW', 'KeyX',
      'KeyY', 'KeyZ', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Space', 'Tab', 'Escape', 'ShiftLeft',
      'ShiftRight', 'Backquote', 'Enter',
    ];
    const reachable = new Set<string>();
    for (const code of CODES) {
      for (const shift of [false, true]) {
        const got = controlForKey(code, shift);
        if (got === '') continue;
        if (!Object.hasOwn(CONTROL_HINT, got)) failures.push(`${code} maps to "${got}", which is not a control.`);
        reachable.add(got);
      }
    }
    for (const row of CONTROL_ROWS) {
      const exempt = NOT_KEYBOARD.includes(row.id);
      if (!exempt && !reachable.has(row.id)) {
        failures.push(`Nothing on the keyboard dismisses the "${row.id}" row, and it is not on NOT_KEYBOARD.`);
      }
      if (exempt && reachable.has(row.id)) {
        failures.push(`The "${row.id}" row is on NOT_KEYBOARD and a keydown answers it too; two writers, one row.`);
      }
    }
    for (const id of NOT_KEYBOARD) {
      if (!CONTROL_ROWS.some((row) => row.id === id)) failures.push(`NOT_KEYBOARD names "${id}", which is not a row.`);
    }
    // The bindings the tutorial depends on, spelled out rather than inferred.
    if (controlForKey('KeyQ', false) !== CONTROL.PHONE) failures.push('Q is not the phone.');
    if (controlForKey('KeyJ', false) !== CONTROL.JOBS) failures.push('J is not the job list.');
    if (controlForKey('KeyE', false) !== CONTROL.INTERACT) failures.push('E is not the interact key.');
    // Shift is a modifier here, not the sprint row: shift-2 must not dismiss
    // "shift sprint", because the player has not sprinted.
    if (controlForKey('ShiftLeft', false) !== '') failures.push('Shift on its own claimed to be a sprint.');
    if (controlForKey('Digit2', true) !== CONTROL.OFFHAND) failures.push('Shift and a digit is not the off hand.');
    if (controlForKey('Digit2', false) !== CONTROL.SLOT_FOOTY) failures.push('2 is not the footy slot.');
    if (controlForKey('Digit3', false) !== '') failures.push('3 is nothing a hand can hold and should mark nothing.');
  }

  // --- The content field folds rather than throwing.
  {
    if (controlId('  PHONE  ') !== CONTROL.PHONE) failures.push('A control id was not trimmed and folded.');
    for (const bad of [undefined, null, 7, {}, 'phones', '']) {
      if (controlId(bad) !== '') failures.push(`controlId(${JSON.stringify(bad)}) invented a control.`);
    }
    if (controlId(CONTROL.CAR) !== CONTROL.CAR) failures.push('A quest may not name the car, which is a control it teaches.');
  }

  return failures;
}
