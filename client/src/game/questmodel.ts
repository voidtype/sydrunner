/**
 * Quests and dialog as **data**: the schema, the parser that distrusts it, and
 * the arithmetic both ends agree about.
 *
 * The owner's words: *"make it so you can dynamically add quests over time
 * without a deploy, and add a dialog system too kinda like wow or skyrim; we
 * can plug it into a shit ai if needed"*. Every word of that is a constraint on
 * this file rather than on the server:
 *
 *   - **"without a deploy"** means the content cannot be TypeScript. A quest
 *     that is a function is a quest that ships with a build, and a build is
 *     forty minutes and a restart. So a quest is a JSON record, `server/
 *     quests.ts` polls GitHub for the file the way `server/suggestions.ts`
 *     polls it for issues, and editing that file on github.com is the whole of
 *     the publish.
 *   - **"dynamically"** means the file is written by a person, at speed, into
 *     a web textarea, with no compiler between them and a running game. That
 *     is the entire justification for how paranoid the parser below is: every
 *     field is re-derived rather than trusted, a pack that fails is **refused
 *     whole**, and the last good pack keeps serving. A half-applied pack is the
 *     one outcome that must not be reachable -- it is a player halfway through
 *     a quest whose fourth step no longer exists.
 *   - **"kinda like wow or skyrim"** means a tree of nodes with choices, where
 *     a choice can be gated on who you are. Not a state machine per NPC written
 *     in code; a table.
 *   - **"a shit ai if needed"** is the `improv` field, and the rule that makes
 *     it safe is in this file rather than in the server: **an improv node
 *     cannot decide anything.** It carries no `accept`, no `turnin`, no reward
 *     and no flag. The model paints; the data decides. `verifyQuests` refuses a
 *     pack that breaks that, so the guarantee is structural rather than a note
 *     in a README.
 *
 * ---------------------------------------------------------------------------
 * THREE-FREE, AND WHY IT MATTERS MORE HERE THAN USUALLY
 *
 * `server/quests.ts` imports this, so it cannot touch three, the DOM or `Bun`
 * -- the standing rule for anything under `client/src` that the server reads.
 * The reason it matters more than usual is that the **validator is the deploy
 * gate**: the same `parseQuestPack` runs in the browser (so the panel never
 * draws a node that is not there), on the server (so the authority never
 * adjudicates a step it cannot see), and in `server/quests-check.ts` (so a
 * content edit can be checked before it is pushed). Three runs, one function,
 * no second opinion.
 *
 * ---------------------------------------------------------------------------
 * THE STEP KINDS ARE EVENTS THE SIMULATION ALREADY EMITS
 *
 * There is no new event bus. Every one of the seven step kinds is something
 * `server/sim.ts` already knows on a tick it already runs:
 *
 *     goto    a distance test against the body it is already integrating
 *     ko      the one funnel every knockout in the game passes through
 *     buy     a powerup pickup, which is already an `EVENT.PICKUP`
 *     photo   the client asserts, the server checks the range it asserted
 *     ride    the aboard record the snapshot already carries
 *     earn    the wallet credit that already composes "+$34 fare"
 *     dialog  a node the client walked to and the server re-walked
 *
 * The three that need a *message* rather than a tick (`photo`, `dialog`, and
 * the accept/turn-in either side of all of them) are the three that ride
 * `MSG.QUEST`. Everything else is observed, because a step a client can claim
 * is a step a client can forge -- and `photo` is the one exception, checked by
 * range on arrival, because there is no other way for this process to know a
 * shutter was pressed.
 *
 * ---------------------------------------------------------------------------
 * WHAT SURVIVES MONDAY, STATED ONCE
 *
 * `net/accounts.resetIfNewWeek` is the only Monday in this game and it zeroes
 * everything: kills, xp, level, talents, side, the saved spot. **Story flags
 * are the one exception**, and they are an exception because an act is a story
 * and a story that resets weekly is not one -- a player who finished the Mutual
 * Obligations arc in March must not be handed the first job again in April.
 *
 * So the split is:
 *
 *   - `AccountRecord.story` -- a set of strings. It holds the authored
 *     `unlock` flags **and** the implicit completion mark this file writes when
 *     a quest is turned in. One mechanism, so "have I done this" and "did the
 *     story branch" are the same question against the same set.
 *   - `AccountRecord.quests` -- in-progress cursors, cleared on Monday with the
 *     xp. A half-finished job does not survive the week, which is correct: the
 *     obligations are weekly and so is the paperwork.
 *
 * ---------------------------------------------------------------------------
 * TWO COMPLETION MARKS, AND `repeatable` IS THE SWITCH. Workstream AN.
 *
 * A turn-in used to write `q:<id>` for a story quest and **nothing at all** for
 * a repeatable, which meant a "weekly" job could be handed in and taken again
 * in the same breath -- `content/quests/act1.json` called its two jobs weekly
 * and they were not. Now every turn-in writes a mark and the prefix says which
 * kind it is:
 *
 *   - `q:<id>` -- a story completion. Permanent. Survives Monday, because an
 *     act is a story and a story that resets weekly is not one: a player who
 *     finished Mutual Obligations in March must not be handed the first job
 *     again in April.
 *   - `w:<id>` -- done **this week**. Dropped by `net/accounts.resetIfNewWeek`
 *     with the xp and the cursors, so the job comes round on Monday with
 *     everything else that is weekly.
 *
 * Both live in `story` rather than in a field of their own, and that is the
 * decision worth naming: the client already receives the story flags on
 * `MSG.QUEST_STATE` and the register and the world markers are both drawn from
 * them, so a second list would have been a wire change to say something the
 * wire already carries. `doneFlag` is the one place that picks between the two.
 *
 * ---------------------------------------------------------------------------
 * THE LEVEL IS A RUNG, NOT A FLOOR. Workstream AN.
 *
 * The owner's words: *"all quests should be on a strict per level register"*.
 * `quest.level` used to be a minimum -- level 2 meant "level 2 or better" --
 * and a minimum is not a register, it is a pile that only ever grows. It is now
 * **exact**: a quest sits on exactly one of ten rungs and is offered while the
 * player is standing on that rung and at no other time.
 *
 * Three consequences, all of them deliberate:
 *
 *   - **A rung can be missed.** Reach level 3 without taking the level-2 job
 *     and it is gone -- until next Monday, when the level resets to 1 and the
 *     climb comes back through 2. That is rule 3 of `DESIGN.md` doing real work
 *     rather than being a technicality: the week is the epic, and the register
 *     is what makes a level feel like a place you were rather than a number you
 *     passed.
 *   - **A quest already accepted is unaffected.** The rung gates the *offer*,
 *     not the walking or the turn-in, so levelling up mid-job never strands
 *     anybody: `questRefusal` is asked before a cursor exists and never after.
 *   - **The tenth rung is a landing.** The ladder runs to `MAX_LEVEL`, the
 *     register runs to ten, and a player at level 14 with nothing to do would
 *     be a dead end rather than a design. `rungOf` clamps the player to the top
 *     rung, so level 10 content stays offered above it.
 */

// --- The bounds ---------------------------------------------------------------

/**
 * What a content file may pay, and the reason there is a ceiling at all.
 *
 * A quest pack is a JSON file in a public repository that a running server
 * fetches and applies without a human in the loop. The failure that ceiling
 * exists for is not malice -- it is a typo. `"cash": 50000` is four keystrokes
 * from `"cash": 50`, it validates as a number, and by the time anybody notices
 * the economy every wallet on the box is wrong and there is no un-doing it.
 *
 * $500 is comfortably above the largest thing this game pays for a single act
 * (a long fare is about $40) and comfortably below "you never need money
 * again". 2000 xp is two levels, which is the most a single quest should ever
 * be worth when ten knockouts is one.
 */
export const MAX_CASH_REWARD = 500;
export const MAX_XP_REWARD = 2000;
/** How many story flags one quest may set. Four is three more than any of them uses. */
export const MAX_UNLOCKS = 4;

/**
 * How many rungs the register has. Workstream AN.
 *
 * Ten, because the owner asked for ten and because it is the number that makes
 * the phone's register a screen rather than a scroll. It is deliberately **not**
 * `net/accounts.MAX_LEVEL`, which is 255 and is a bound on what a `u8` can carry
 * rather than a statement about content: nobody is going to author two hundred
 * and fifty-five rungs of Sydney, and a register with that many rows would be a
 * spreadsheet.
 *
 * A quest whose `level` is past this is clamped onto the top rung rather than
 * refused, on `parseStep`'s standing radius argument: a content file with a typo
 * in one number should lose the number, not the pack.
 */
export const REGISTER_LEVELS = 10;

/** How many quests one pack may carry, and how many steps one quest may have. */
export const MAX_QUESTS_PER_PACK = 64;
export const MAX_STEPS = 8;
/** How many times a counted step may ask for the same thing. */
export const MAX_STEP_COUNT = 50;

/** How many NPCs one dialog pack may carry, nodes per NPC, choices per node. */
export const MAX_NPCS_PER_PACK = 32;
export const MAX_NODES_PER_NPC = 48;
export const MAX_CHOICES = 6;

/** Text caps. Generous for a line, tight for an id. */
export const MAX_ID_CHARS = 48;
export const MAX_TITLE_CHARS = 60;
export const MAX_LINE_CHARS = 240;
export const MAX_CHOICE_CHARS = 90;
export const MAX_FLAG_CHARS = 48;

/**
 * How far a `goto` may ask a player to stand from a point, and how close.
 *
 * A floor because a radius of zero is a step nobody can ever satisfy -- the
 * body's position is a float and standing *exactly* on a coordinate is not a
 * thing a person can do -- and a ceiling because a 5 km radius is a step that
 * is already complete when it is accepted, which reads as the quest being
 * broken.
 */
export const MIN_GOTO_RADIUS_M = 3;
export const MAX_GOTO_RADIUS_M = 250;

/**
 * How far from the world's centre a content file may place anything.
 *
 * `net/accounts.LAST_POS_LIMIT_M`'s argument, one file over: Greater Sydney as
 * this game builds it is a 60 km square, so a coordinate past 200 km is a typo,
 * a paste of a latitude, or a unit that arrived in feet. Refused here so it
 * cannot reach a ground query.
 */
export const CONTENT_LIMIT_M = 200_000;

// --- The step kinds ------------------------------------------------------------

/**
 * The seven, named once.
 *
 * Strings rather than numbers, deliberately and against this repo's habit
 * everywhere else: these are read and written **by a person in a text editor**,
 * and `"kind": 3` in a file somebody is editing on a phone is a lookup table
 * they do not have. Nothing here is on the wire -- the client fetches the pack
 * over HTTP as JSON (see `/content`) -- so the byte argument that makes
 * `NPC_KIND` a number does not apply.
 */
export const STEP_KIND = {
  GOTO: 'goto',
  KO: 'ko',
  BUY: 'buy',
  PHOTO: 'photo',
  RIDE: 'ride',
  EARN: 'earn',
  DIALOG: 'dialog',
} as const;
export type StepKind = (typeof STEP_KIND)[keyof typeof STEP_KIND];

const STEP_KINDS: readonly string[] = Object.values(STEP_KIND);

/**
 * One step, after parsing. A union in shape, one interface in practice.
 *
 * Flat rather than a discriminated union of seven interfaces, and that is a
 * deliberate trade against the type system. The parser produces exactly one of
 * these per record and fills only the fields the kind uses; every consumer
 * switches on `kind` first. A seven-arm union would be tidier to read and would
 * make `parseStep` a function that cannot be written without a cast at every
 * arm, because the thing it is parsing is `unknown` off a JSON file. One shape
 * with documented occupancy is the honest version of what this actually is.
 */
export interface QuestStep {
  kind: StepKind;
  /** A short line for the tracker: "get to the Marrickville office". Always set. */
  label: string;
  /** How many times. 1 for everything except `ko`, `buy` and `earn`. */
  count: number;
  /** GOTO / PHOTO: where, in world metres. */
  x: number;
  z: number;
  /** GOTO / PHOTO: how close. Metres. */
  radius: number;
  /**
   * KO: which kind of body. A `game/factions.NPC_KIND` name, or `'player'`, or
   * `'any'`. Kept as a **string** and resolved by the server against the live
   * table rather than baked to a byte here, so a pack written before a new NPC
   * kind existed is a pack that refuses that name rather than one that silently
   * matches the wrong body.
   */
  npc: string;
  /** BUY: the powerup kind's name, or `'any'`. */
  powerup: string;
  /** PHOTO: which landmark, by the bake's own id. Empty means "anywhere near (x, z)". */
  landmark: string;
  /** RIDE: the line index, or -1 for any line. */
  line: number;
  /** RIDE: station names, as the bake spells them. Empty means "anywhere". */
  from: string;
  to: string;
  /** EARN: dollars, cumulative from the moment the step opens. */
  dollars: number;
  /** DIALOG: which NPC and which node must be reached. */
  npcId: string;
  node: string;
}

function blankStep(): QuestStep {
  return {
    kind: STEP_KIND.GOTO,
    label: '',
    count: 1,
    x: 0,
    z: 0,
    radius: MIN_GOTO_RADIUS_M,
    npc: 'any',
    powerup: 'any',
    landmark: '',
    line: -1,
    from: '',
    to: '',
    dollars: 0,
    npcId: '',
    node: '',
  };
}

/** What a quest pays. Every field bounded; see `MAX_CASH_REWARD`. */
export interface QuestReward {
  cash: number;
  xp: number;
  /** Story flags to set. Permanent; they survive Monday. See the header. */
  unlock: string[];
}

/** One quest. */
export interface Quest {
  id: string;
  /** 0 for Mutual Obligations, 1 for faction work, 2 for the mystery. */
  act: number;
  title: string;
  /** One sentence, in the giver's voice, for the obligations app. */
  blurb: string;
  /** The dialog NPC who hands it out and takes it back. */
  giver: string;
  /**
   * **The rung.** Exact, 1 to `REGISTER_LEVELS`, and not a minimum -- see the
   * header. A quest is offered while `rungOf(player.level) === level` and at no
   * other time.
   */
  level: number;
  /** `''`, `'Marita'` or `'DeFAULT'`. The spellings are law; see `game/teams.ts`. */
  faction: string;
  /** Quest ids that must be finished first. Checked against the `q:` marks. */
  requires: string[];
  /** Story flags that must already be set. */
  needFlags: string[];
  /** Story flags that must **not** be set. How an act closes itself off. */
  denyFlags: string[];
  /** Weekly rather than once. A repeatable never writes its `q:` mark. */
  repeatable: boolean;
  steps: QuestStep[];
  reward: QuestReward;
}

export interface QuestPack {
  pack: string;
  quests: Quest[];
}

// --- Dialog --------------------------------------------------------------------

/** What a choice may ask of the player before it is offered. */
export interface DialogChoice {
  text: string;
  /** The node to walk to, or `''` to end the conversation. */
  goto: string;
  /** A quest id to accept, or `''`. */
  accept: string;
  /** A quest id to turn in, or `''`. */
  turnin: string;
  /** Gates. Zero / empty means "no gate". */
  needLevel: number;
  needFaction: string;
  needFlag: string;
  denyFlag: string;
  /** Dollars the player must have, and dollars this choice **spends**. A bribe. */
  needCash: number;
  cost: number;
}

/**
 * What the model may be asked to say on this node, and what it may not decide.
 *
 * Present only on nodes the author marked. `persona` is who is talking and
 * `context` is what they know; neither is ever composed from anything a player
 * typed -- see `server/quests.ts`, which builds the prompt from these two
 * fields and the authored line and nothing else.
 */
export interface DialogImprov {
  persona: string;
  context: string;
}

export interface DialogNode {
  id: string;
  /**
   * What the NPC says. **Always authored**, even on an improv node: this is
   * what serves when there is no key, when the model is down, and when the
   * answer comes back empty. An improv node with no line is refused by the
   * parser for that reason -- it would be a node that is blank on the default
   * configuration.
   */
  line: string;
  improv: DialogImprov | null;
  choices: DialogChoice[];
}

export interface DialogNpc {
  id: string;
  /** What is drawn over them and at the top of the panel. */
  name: string;
  /** Where they stand, world metres. */
  x: number;
  z: number;
  /** How close you must be for `E` to open them. */
  radius: number;
  /** The node the conversation starts at. */
  root: string;
  nodes: DialogNode[];
}

export interface DialogPack {
  pack: string;
  npcs: DialogNpc[];
}

/** Everything the server holds and the client fetches: both halves, merged. */
export interface ContentBundle {
  quests: Quest[];
  npcs: DialogNpc[];
  /** A stamp that changes when anything above does. The `/content` ETag. */
  revision: string;
}

export const EMPTY_BUNDLE: ContentBundle = { quests: [], npcs: [], revision: '0' };

// --- The parser ----------------------------------------------------------------

/**
 * What a parse produced, and everything wrong with what it was given.
 *
 * Both halves always, rather than one or the other, because the caller needs
 * them at once: `server/quests.ts` logs every error and then **discards the
 * pack entirely** if there is one, and a parser that threw on the first problem
 * would report a content file one mistake per push.
 */
export interface ParseResult<T> {
  value: T;
  errors: string[];
}

function str(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  // Collapsed and clipped rather than refused: a trailing space in a title is
  // not a reason to refuse a pack, and an author pasting from a document brings
  // non-breaking spaces with them.
  const text = raw.replace(/\s+/gu, ' ').trim();
  return [...text].slice(0, max).join('');
}

/**
 * An id: lower case, alphanumeric, `-`, `_` and `:`.
 *
 * Narrow because ids are compared, stored in an account record, and used as
 * object keys. A space in an id is a quest that can be required by two
 * different spellings; a `/` is an id that looks like a path to whatever reads
 * the file next. The `:` is allowed because story flags are namespaced
 * (`act0:reported`) and the completion marks this file writes are `q:<id>`.
 */
function id(raw: unknown): string {
  const text = str(raw, MAX_ID_CHARS).toLowerCase().replace(/\s+/gu, '');
  return /^[a-z0-9][a-z0-9:_-]*$/.test(text) ? text : '';
}

function num(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.trunc(value)));
}

function strList(raw: unknown, max: number, chars: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const text = typeof item === 'string' ? str(item, chars).toLowerCase() : '';
    if (text !== '' && !out.includes(text)) out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * A faction name as a content file may spell it, or `''`.
 *
 * **The capitalisation is checked rather than folded**, which is the one place
 * in this parser that is deliberately strict about something cosmetic. The
 * owner's instruction is *"always follow the capitalisation Marita and DeFAULT
 * -- in absolutely any case"*, this string is drawn in a panel, and a pack that
 * says `"faction": "default"` would render the wrong name at every player who
 * reads it. Refusing it here means the author is told, once, at publish, rather
 * than never.
 */
function faction(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return '';
  if (raw === 'Marita' || raw === 'DeFAULT') return raw;
  return null;
}

function parseStep(raw: unknown, where: string, errors: string[]): QuestStep | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push(`${where}: a step must be an object.`);
    return null;
  }
  const row = raw as Record<string, unknown>;
  const kind = typeof row.kind === 'string' ? row.kind.trim().toLowerCase() : '';
  if (!STEP_KINDS.includes(kind)) {
    errors.push(`${where}: "${kind}" is not a step kind. The seven are ${STEP_KINDS.join(', ')}.`);
    return null;
  }
  const step = blankStep();
  step.kind = kind as StepKind;
  step.label = str(row.label, MAX_TITLE_CHARS);
  step.count = clampInt(num(row.count, 1), 1, MAX_STEP_COUNT);

  if (kind === STEP_KIND.GOTO || kind === STEP_KIND.PHOTO) {
    step.x = num(row.x, Number.NaN);
    step.z = num(row.z, Number.NaN);
    if (!Number.isFinite(step.x) || !Number.isFinite(step.z)) {
      errors.push(`${where}: a ${kind} step needs a numeric x and z.`);
      return null;
    }
    if (Math.abs(step.x) > CONTENT_LIMIT_M || Math.abs(step.z) > CONTENT_LIMIT_M) {
      errors.push(`${where}: (${step.x}, ${step.z}) is past the end of the world.`);
      return null;
    }
    step.radius = Math.max(MIN_GOTO_RADIUS_M, Math.min(MAX_GOTO_RADIUS_M, num(row.radius, 25)));
    step.count = 1;
    if (kind === STEP_KIND.PHOTO) step.landmark = str(row.landmark, MAX_ID_CHARS);
  } else if (kind === STEP_KIND.KO) {
    step.npc = str(row.npc, MAX_ID_CHARS).toLowerCase() || 'any';
  } else if (kind === STEP_KIND.BUY) {
    step.powerup = str(row.powerup, MAX_ID_CHARS).toLowerCase() || 'any';
  } else if (kind === STEP_KIND.RIDE) {
    step.line = clampInt(num(row.line, -1), -1, 15);
    step.from = str(row.from, MAX_TITLE_CHARS);
    step.to = str(row.to, MAX_TITLE_CHARS);
    step.count = 1;
  } else if (kind === STEP_KIND.EARN) {
    step.dollars = clampInt(num(row.dollars, 0), 1, MAX_CASH_REWARD * 4);
    step.count = 1;
  } else if (kind === STEP_KIND.DIALOG) {
    step.npcId = id(row.npc);
    step.node = id(row.node);
    step.count = 1;
    if (step.npcId === '' || step.node === '') {
      errors.push(`${where}: a dialog step needs an npc id and a node id.`);
      return null;
    }
  }
  if (step.label === '') step.label = defaultLabel(step);
  return step;
}

/**
 * A tracker line for a step whose author did not write one.
 *
 * Composed rather than refused, because a missing label is the most forgivable
 * omission a content file can have and refusing a whole pack over one is the
 * kind of strictness that makes people stop editing the file. What it must not
 * do is say nothing: an empty line in the tracker is a quest that appears to
 * have no next step.
 */
export function defaultLabel(step: QuestStep): string {
  switch (step.kind) {
    case STEP_KIND.GOTO:
      return 'get there';
    case STEP_KIND.KO:
      return step.npc === 'any' ? `knock over ${step.count}` : `knock over ${step.count} ${step.npc}`;
    case STEP_KIND.BUY:
      return step.powerup === 'any' ? 'pick something up' : `pick up ${step.powerup}`;
    case STEP_KIND.PHOTO:
      return step.landmark === '' ? 'take a photo of it' : `photograph ${step.landmark}`;
    case STEP_KIND.RIDE:
      return step.to === '' ? 'catch a train' : `catch a train to ${step.to}`;
    case STEP_KIND.EARN:
      return `earn $${step.dollars}`;
    default:
      return 'talk to them';
  }
}

/**
 * One quest pack off a JSON file. Errors are the caller's to act on.
 *
 * Nothing here refers to another pack: referential integrity across packs
 * (does this prereq exist, does this dialog node exist) is `validateBundle`'s,
 * because it is a property of the **set** of packs the server is holding and a
 * single file cannot know it.
 */
export function parseQuestPack(raw: unknown, name: string): ParseResult<QuestPack> {
  const errors: string[] = [];
  const out: QuestPack = { pack: name, quests: [] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push(`${name}: the file is not a JSON object.`);
    return { value: out, errors };
  }
  const file = raw as Record<string, unknown>;
  out.pack = id(file.pack) || name;
  const rows = file.quests;
  if (!Array.isArray(rows)) {
    errors.push(`${name}: "quests" must be an array.`);
    return { value: out, errors };
  }
  if (rows.length > MAX_QUESTS_PER_PACK) {
    errors.push(`${name}: ${rows.length} quests, over the ${MAX_QUESTS_PER_PACK} cap.`);
    return { value: out, errors };
  }
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const where = `${name}[${i}]`;
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      errors.push(`${where}: a quest must be an object.`);
      continue;
    }
    const q = row as Record<string, unknown>;
    const questId = id(q.id);
    if (questId === '') {
      errors.push(`${where}: no usable id. Ids are lower case, alphanumeric, "-", "_" and ":".`);
      continue;
    }
    if (seen.has(questId)) {
      errors.push(`${where}: "${questId}" appears twice in one pack.`);
      continue;
    }
    seen.add(questId);
    const side = faction(q.faction);
    if (side === null) {
      errors.push(`${where}: "faction" must be "", "Marita" or "DeFAULT" -- the capitalisation is the owner's.`);
      continue;
    }
    const rawSteps = Array.isArray(q.steps) ? q.steps : [];
    if (rawSteps.length === 0) {
      errors.push(`${where}: a quest with no steps can never be finished.`);
      continue;
    }
    if (rawSteps.length > MAX_STEPS) {
      errors.push(`${where}: ${rawSteps.length} steps, over the ${MAX_STEPS} cap.`);
      continue;
    }
    const steps: QuestStep[] = [];
    let stepsOk = true;
    for (let s = 0; s < rawSteps.length; s++) {
      const step = parseStep(rawSteps[s], `${where}.steps[${s}]`, errors);
      if (step === null) stepsOk = false;
      else steps.push(step);
    }
    if (!stepsOk) continue;

    const rewardRaw =
      typeof q.reward === 'object' && q.reward !== null && !Array.isArray(q.reward)
        ? (q.reward as Record<string, unknown>)
        : {};
    const cash = clampInt(num(rewardRaw.cash, 0), 0, MAX_CASH_REWARD + 1);
    const xp = clampInt(num(rewardRaw.xp, 0), 0, MAX_XP_REWARD + 1);
    if (cash > MAX_CASH_REWARD) {
      errors.push(`${where}: pays $${cash}, over the $${MAX_CASH_REWARD} ceiling. A content file must not be able to mint.`);
      continue;
    }
    if (xp > MAX_XP_REWARD) {
      errors.push(`${where}: pays ${xp} xp, over the ${MAX_XP_REWARD} ceiling.`);
      continue;
    }
    const unlock = strList(rewardRaw.unlock, MAX_UNLOCKS + 1, MAX_FLAG_CHARS);
    if (unlock.length > MAX_UNLOCKS) {
      errors.push(`${where}: sets ${unlock.length} story flags, over the ${MAX_UNLOCKS} cap.`);
      continue;
    }

    out.quests.push({
      id: questId,
      act: clampInt(num(q.act, 0), 0, 9),
      title: str(q.title, MAX_TITLE_CHARS) || questId,
      blurb: str(q.blurb, MAX_LINE_CHARS),
      giver: id(q.giver),
      // Onto the register rather than onto the ladder: the rung is exact, so a
      // quest that landed above the top rung would be a quest nobody is ever
      // standing level with. See `REGISTER_LEVELS`.
      level: clampInt(num(q.level, 1), 1, REGISTER_LEVELS),
      faction: side,
      requires: strList(q.requires, 8, MAX_ID_CHARS),
      needFlags: strList(q.needFlags, 8, MAX_FLAG_CHARS),
      denyFlags: strList(q.denyFlags, 8, MAX_FLAG_CHARS),
      repeatable: q.repeatable === true,
      steps,
      reward: { cash, xp, unlock },
    });
  }
  return { value: out, errors };
}

function parseChoice(raw: unknown, where: string, errors: string[]): DialogChoice | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push(`${where}: a choice must be an object.`);
    return null;
  }
  const row = raw as Record<string, unknown>;
  const text = str(row.text, MAX_CHOICE_CHARS);
  if (text === '') {
    errors.push(`${where}: a choice with no text is a button nobody can read.`);
    return null;
  }
  const side = faction(row.needFaction);
  if (side === null) {
    errors.push(`${where}: "needFaction" must be "", "Marita" or "DeFAULT".`);
    return null;
  }
  return {
    text,
    goto: id(row.goto),
    accept: id(row.accept),
    turnin: id(row.turnin),
    needLevel: clampInt(num(row.needLevel, 0), 0, 255),
    needFaction: side,
    needFlag: str(row.needFlag, MAX_FLAG_CHARS).toLowerCase(),
    denyFlag: str(row.denyFlag, MAX_FLAG_CHARS).toLowerCase(),
    needCash: clampInt(num(row.needCash, 0), 0, 100000),
    cost: clampInt(num(row.cost, 0), 0, 100000),
  };
}

export function parseDialogPack(raw: unknown, name: string): ParseResult<DialogPack> {
  const errors: string[] = [];
  const out: DialogPack = { pack: name, npcs: [] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    errors.push(`${name}: the file is not a JSON object.`);
    return { value: out, errors };
  }
  const file = raw as Record<string, unknown>;
  out.pack = id(file.pack) || name;
  const rows = file.npcs;
  if (!Array.isArray(rows)) {
    errors.push(`${name}: "npcs" must be an array.`);
    return { value: out, errors };
  }
  if (rows.length > MAX_NPCS_PER_PACK) {
    errors.push(`${name}: ${rows.length} npcs, over the ${MAX_NPCS_PER_PACK} cap.`);
    return { value: out, errors };
  }
  const seenNpc = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const where = `${name}[${i}]`;
    const row = rows[i];
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      errors.push(`${where}: an npc must be an object.`);
      continue;
    }
    const n = row as Record<string, unknown>;
    const npcId = id(n.id);
    if (npcId === '') {
      errors.push(`${where}: no usable id.`);
      continue;
    }
    if (seenNpc.has(npcId)) {
      errors.push(`${where}: "${npcId}" appears twice in one pack.`);
      continue;
    }
    seenNpc.add(npcId);
    const x = num(n.x, Number.NaN);
    const z = num(n.z, Number.NaN);
    if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > CONTENT_LIMIT_M || Math.abs(z) > CONTENT_LIMIT_M) {
      errors.push(`${where}: "${npcId}" stands at (${n.x}, ${n.z}), which is not a place in this world.`);
      continue;
    }
    const rawNodes = Array.isArray(n.nodes) ? n.nodes : [];
    if (rawNodes.length === 0) {
      errors.push(`${where}: "${npcId}" has no nodes; there would be nothing to say.`);
      continue;
    }
    if (rawNodes.length > MAX_NODES_PER_NPC) {
      errors.push(`${where}: "${npcId}" has ${rawNodes.length} nodes, over the ${MAX_NODES_PER_NPC} cap.`);
      continue;
    }
    const nodes: DialogNode[] = [];
    const seenNode = new Set<string>();
    let nodesOk = true;
    for (let j = 0; j < rawNodes.length; j++) {
      const nodeWhere = `${where}.nodes[${j}]`;
      const nr = rawNodes[j];
      if (typeof nr !== 'object' || nr === null || Array.isArray(nr)) {
        errors.push(`${nodeWhere}: a node must be an object.`);
        nodesOk = false;
        continue;
      }
      const nd = nr as Record<string, unknown>;
      const nodeId = id(nd.id);
      if (nodeId === '') {
        errors.push(`${nodeWhere}: no usable id.`);
        nodesOk = false;
        continue;
      }
      if (seenNode.has(nodeId)) {
        errors.push(`${nodeWhere}: "${nodeId}" appears twice on "${npcId}".`);
        nodesOk = false;
        continue;
      }
      seenNode.add(nodeId);
      const line = str(nd.line, MAX_LINE_CHARS);
      if (line === '') {
        errors.push(`${nodeWhere}: a node with no line is a blank panel.`);
        nodesOk = false;
        continue;
      }
      let improv: DialogImprov | null = null;
      if (typeof nd.improv === 'object' && nd.improv !== null && !Array.isArray(nd.improv)) {
        const ir = nd.improv as Record<string, unknown>;
        improv = {
          persona: str(ir.persona, MAX_LINE_CHARS),
          context: str(ir.context, MAX_LINE_CHARS),
        };
        if (improv.persona === '') {
          errors.push(`${nodeWhere}: an improv block needs a persona -- it is the whole of the prompt.`);
          nodesOk = false;
          continue;
        }
      }
      const rawChoices = Array.isArray(nd.choices) ? nd.choices : [];
      if (rawChoices.length > MAX_CHOICES) {
        errors.push(`${nodeWhere}: ${rawChoices.length} choices, over the ${MAX_CHOICES} cap.`);
        nodesOk = false;
        continue;
      }
      const choices: DialogChoice[] = [];
      for (let c = 0; c < rawChoices.length; c++) {
        const choice = parseChoice(rawChoices[c], `${nodeWhere}.choices[${c}]`, errors);
        if (choice === null) nodesOk = false;
        else choices.push(choice);
      }
      /*
       * **The improv rule, enforced at the parse rather than at the render.**
       *
       * An improv node may not accept a quest, turn one in, or spend money.
       * The reason is the one the header gives: the model paints and the data
       * decides, and a node whose *text came from a model* that also carried a
       * turn-in would be a model with a hand on the wallet. Refusing it here
       * means the guarantee holds for every consumer at once -- the panel, the
       * server's validator and the check -- rather than being a rule each of
       * them has to remember.
       */
      if (improv !== null) {
        const decides = choices.find((c) => c.accept !== '' || c.turnin !== '' || c.cost > 0);
        if (decides) {
          errors.push(
            `${nodeWhere}: an improv node carries a choice that ${
              decides.accept !== '' ? 'accepts a quest' : decides.turnin !== '' ? 'turns one in' : 'spends money'
            }. Improv is cosmetic; the AI paints, the data decides.`,
          );
          nodesOk = false;
          continue;
        }
      }
      nodes.push({ id: nodeId, line, improv, choices });
    }
    if (!nodesOk) continue;
    const root = id(n.root) || nodes[0].id;
    if (!nodes.some((nd) => nd.id === root)) {
      errors.push(`${where}: "${npcId}" starts at "${root}", which is not one of its nodes.`);
      continue;
    }
    out.npcs.push({
      id: npcId,
      name: str(n.name, MAX_TITLE_CHARS) || npcId,
      x,
      z,
      radius: Math.max(MIN_GOTO_RADIUS_M, Math.min(MAX_GOTO_RADIUS_M, num(n.radius, 4))),
      root,
      nodes,
    });
  }
  return { value: out, errors };
}

// --- Referential integrity, across the whole set --------------------------------

/**
 * Everything that can only be wrong once the packs are looked at together.
 *
 * Four questions, and every one of them produces a *playable* game when the
 * answer is wrong, which is why they are a boot gate rather than a warning:
 *
 *   - **Does every prereq exist?** A `requires` naming a quest nobody wrote is
 *     a quest that is never offered, to anybody, ever. Nothing throws; the
 *     obligations app is simply one item shorter than the author expected.
 *   - **Is the graph acyclic?** Two quests requiring each other are two quests
 *     that can never start. Same silence.
 *   - **Does every dialog reference land?** A `goto` to a node that is not
 *     there is a button that closes the panel, and an `accept` naming a quest
 *     that is not there is a button that does nothing at all.
 *   - **Does every quest have a giver who can give it?** A quest whose `giver`
 *     is not a dialog NPC, or whose giver has no choice that accepts it, is a
 *     quest with no door into it.
 */
export function validateBundle(quests: readonly Quest[], npcs: readonly DialogNpc[]): string[] {
  const errors: string[] = [];
  const byId = new Map<string, Quest>();
  for (const q of quests) {
    if (byId.has(q.id)) {
      errors.push(`Two quests share the id "${q.id}"; one of them would be unreachable.`);
      continue;
    }
    byId.set(q.id, q);
  }
  const npcById = new Map<string, DialogNpc>();
  for (const n of npcs) {
    if (npcById.has(n.id)) {
      errors.push(`Two dialog npcs share the id "${n.id}".`);
      continue;
    }
    npcById.set(n.id, n);
  }

  // --- Prereqs exist, and the graph does not eat its own tail.
  for (const q of quests) {
    for (const need of q.requires) {
      if (!byId.has(need)) errors.push(`Quest "${q.id}" requires "${need}", which does not exist.`);
    }
  }
  for (const q of quests) {
    const cycle = findCycle(q.id, byId);
    if (cycle !== null) {
      errors.push(`Quest prereqs form a cycle: ${cycle.join(' -> ')}. None of them can ever start.`);
      break; // one report; the whole loop is the same fault
    }
  }

  // --- Dialog references.
  const accepted = new Set<string>();
  const turnedIn = new Set<string>();
  for (const n of npcById.values()) {
    const nodeIds = new Set(n.nodes.map((nd) => nd.id));
    for (const nd of n.nodes) {
      for (const c of nd.choices) {
        if (c.goto !== '' && !nodeIds.has(c.goto)) {
          errors.push(`Dialog "${n.id}.${nd.id}" offers a choice going to "${c.goto}", which is not one of its nodes.`);
        }
        if (c.accept !== '') {
          if (!byId.has(c.accept)) errors.push(`Dialog "${n.id}.${nd.id}" accepts "${c.accept}", which is not a quest.`);
          else accepted.add(c.accept);
        }
        if (c.turnin !== '') {
          if (!byId.has(c.turnin)) errors.push(`Dialog "${n.id}.${nd.id}" turns in "${c.turnin}", which is not a quest.`);
          else turnedIn.add(c.turnin);
        }
        if (c.cost > 0 && c.needCash < c.cost) {
          errors.push(
            `Dialog "${n.id}.${nd.id}" offers a choice costing $${c.cost} behind a $${c.needCash} gate; ` +
              'the gate must be at least the price or the wallet refuses the click.',
          );
        }
      }
    }
  }

  // --- Every quest has a door in and a door out.
  for (const q of quests) {
    if (q.giver === '') {
      errors.push(`Quest "${q.id}" has no giver; nothing in the world would offer it.`);
    } else if (!npcById.has(q.giver)) {
      errors.push(`Quest "${q.id}" is given by "${q.giver}", who is not a dialog npc.`);
    }
    if (!accepted.has(q.id)) errors.push(`Quest "${q.id}" is not accepted by any dialog choice; there is no way to start it.`);
    if (!turnedIn.has(q.id)) errors.push(`Quest "${q.id}" is not turned in by any dialog choice; there is no way to finish it.`);
    for (const step of q.steps) {
      if (step.kind !== STEP_KIND.DIALOG) continue;
      const npc = npcById.get(step.npcId);
      if (!npc) {
        errors.push(`Quest "${q.id}" has a dialog step at npc "${step.npcId}", who does not exist.`);
      } else if (!npc.nodes.some((nd) => nd.id === step.node)) {
        errors.push(`Quest "${q.id}" has a dialog step at "${step.npcId}.${step.node}", which is not a node.`);
      }
    }
  }
  return errors;
}

/** A prereq cycle reachable from `start`, or null. Depth-first, iterative. */
function findCycle(start: string, byId: ReadonlyMap<string, Quest>): string[] | null {
  const path: string[] = [];
  const onPath = new Set<string>();
  const done = new Set<string>();
  const stack: Array<{ id: string; enter: boolean }> = [{ id: start, enter: true }];
  while (stack.length > 0) {
    const frame = stack.pop() as { id: string; enter: boolean };
    if (!frame.enter) {
      onPath.delete(frame.id);
      path.pop();
      done.add(frame.id);
      continue;
    }
    if (done.has(frame.id)) continue;
    if (onPath.has(frame.id)) return [...path.slice(path.indexOf(frame.id)), frame.id];
    onPath.add(frame.id);
    path.push(frame.id);
    stack.push({ id: frame.id, enter: false });
    const q = byId.get(frame.id);
    if (!q) continue;
    for (const need of q.requires) if (byId.has(need)) stack.push({ id: need, enter: true });
  }
  return null;
}

// --- Cursors -------------------------------------------------------------------

/**
 * Where one player is in one quest.
 *
 * Two numbers and an array, and the array is the only interesting part: a step
 * that asks for three knockouts needs somewhere to put "two so far", and a
 * cursor that kept only the step index would lose that progress on every
 * reconnect. It is per **step** rather than a single counter so that a quest's
 * fourth step does not inherit its second step's tally.
 *
 * The field names are one character because this is written into an account
 * record as JSON, once per progress event, for every player on the box. `step`
 * / `counts` / `done` would be about 40% more bytes in a file that is rewritten
 * on a debounce -- see `AccountStore.save`.
 */
export interface QuestCursor {
  /** Which step is open. Equals `steps.length` on a quest that is ready to turn in. */
  s: number;
  /** Progress against each step, same length as `steps`. */
  c: number[];
  /** Set when every step is satisfied. The turn-in is still a dialog choice. */
  d: boolean;
}

/** All of one player's live cursors, keyed by quest id. */
export type QuestCursors = Record<string, QuestCursor>;

export function blankCursor(quest: Quest): QuestCursor {
  return { s: 0, c: quest.steps.map(() => 0), d: false };
}

/**
 * The mark a finished non-repeatable quest leaves in the story flags.
 *
 * Namespaced with `q:` so it cannot collide with an authored `unlock`, and so
 * that a reader of the account file can tell the two apart at a glance: `q:`
 * is "the engine wrote this", anything else is "an author wrote this".
 */
export function completionFlag(questId: string): string {
  return `q:${questId}`;
}

/**
 * The prefix on a mark that only means "this week", and the mark itself.
 *
 * `net/accounts.resetIfNewWeek` drops every flag that starts with this and
 * keeps everything else, which is the whole of how a repeatable comes round on
 * Monday. Exported as a constant rather than written out at the reset, because
 * a Monday that swept the wrong prefix would erase the story and nothing
 * anywhere would say so.
 */
export const WEEKLY_FLAG_PREFIX = 'w:';

export function weeklyFlag(questId: string): string {
  return `${WEEKLY_FLAG_PREFIX}${questId}`;
}

/**
 * Which mark this quest leaves when it is handed in. `repeatable` is the switch.
 *
 * One function so the engine that writes the mark, the refusal that reads it and
 * the register that draws it cannot disagree about which prefix a given quest
 * uses -- which would be a job that reads as done and is offered anyway, or the
 * reverse. See the header's "two completion marks".
 */
export function doneFlag(quest: Quest): string {
  return quest.repeatable ? weeklyFlag(quest.id) : completionFlag(quest.id);
}

/**
 * Which rung of the register a player is standing on.
 *
 * The clamp is the tenth rung's landing; see the header. Floored at 1 because a
 * level of 0 is a number the ladder cannot produce and a rung of 0 would be a
 * register with nothing on it.
 */
export function rungOf(level: number): number {
  if (!Number.isFinite(level)) return 1;
  return Math.max(1, Math.min(REGISTER_LEVELS, Math.floor(level)));
}

/**
 * One cursor off disk, or null. `sanitiseAccount`'s discipline; see that file.
 *
 * `steps` is **optional**, and that is the whole reason this function is
 * shaped the way it is: `net/accounts.sanitiseAccount` parses the record before
 * any content pack has been loaded and has no way to know how many steps
 * "act0-doorknock" has -- it may not even be a quest any more. So the loader
 * keeps what is on disk, bounded, and `reconcileCursor` below trims or pads it
 * against the real quest at the moment the engine first looks at it.
 *
 * The two-stage arrangement is not an accident of ordering. It is what lets a
 * player's progress survive an author **adding a step to a quest they are
 * halfway through**, which is a thing that will happen the first week this
 * ships: the counters they have earned are kept, the new step arrives at the
 * end, and nobody is thrown back to the start.
 */
export function sanitiseCursor(raw: unknown, steps?: number): QuestCursor | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const row = raw as Partial<QuestCursor>;
  const s = Number(row.s);
  if (!Number.isFinite(s) || s < 0 || s > MAX_STEPS) return null;
  const from = Array.isArray(row.c) ? row.c : [];
  const width = steps === undefined ? Math.min(from.length, MAX_STEPS) : steps;
  const counts: number[] = [];
  for (let i = 0; i < width; i++) {
    const n = Number(from[i]);
    counts.push(Number.isFinite(n) ? clampInt(n, 0, MAX_STEP_COUNT * 1000) : 0);
  }
  return { s: clampInt(s, 0, steps === undefined ? MAX_STEPS : steps), c: counts, d: row.d === true };
}

/**
 * Make a cursor off disk agree with the quest it names. Returns whether it moved.
 *
 * The other half of `sanitiseCursor`'s two-stage parse, and the case it exists
 * for is the one this whole feature is built around: **the content changes
 * underneath live players.** An author adds a fourth step to a three-step quest
 * on a Tuesday, and everybody halfway through it is holding a cursor with three
 * counters and possibly a `done` that is no longer true.
 *
 * The rule is *keep what was earned, re-open what was added*: counters are
 * padded with zeroes and truncated to the quest's length, the step index is
 * clamped, and `done` is recomputed rather than believed -- so a shortened
 * quest completes and a lengthened one asks for the new step. Nobody loses
 * progress and nobody keeps a completion they no longer have.
 */
export function reconcileCursor(cursor: QuestCursor, quest: Quest): boolean {
  const want = quest.steps.length;
  let moved = false;
  while (cursor.c.length < want) {
    cursor.c.push(0);
    moved = true;
  }
  if (cursor.c.length > want) {
    cursor.c.length = want;
    moved = true;
  }
  let s = 0;
  while (s < want && (cursor.c[s] ?? 0) >= stepTarget(quest.steps[s])) s++;
  const done = s >= want;
  if (cursor.s !== s || cursor.d !== done) {
    cursor.s = s;
    cursor.d = done;
    moved = true;
  }
  return moved;
}

// --- Who may take what ---------------------------------------------------------

/** What the engine knows about a player when it decides whether to offer a quest. */
export interface PlayerFacts {
  level: number;
  /** `''`, `'Marita'` or `'DeFAULT'`. */
  faction: string;
  /** The story flags, as a set for the O(1) test. */
  story: ReadonlySet<string>;
  /** Dollars, for the bribe gate on a dialog choice. */
  cash: number;
}

/**
 * Why this player cannot take this quest, or `''`.
 *
 * A **sentence rather than a boolean**, on `game/teams.takeRefusal`'s argument
 * exactly: the client greys the choice out with this function and the server
 * refuses with the same one, so when the two disagree -- a stale tab, an old
 * pack -- what the player reads is the *server's* reason rather than a second
 * copy of the rule that happens to be nearby.
 */
export function questRefusal(quest: Quest, facts: PlayerFacts, cursors: QuestCursors): string {
  if (facts.story.has(doneFlag(quest))) {
    return quest.repeatable ? 'done for the week' : 'you have done that one';
  }
  if (cursors[quest.id] !== undefined) return 'you are already on that';
  // **The rung, exact.** Two sentences rather than one, because "level 3 first"
  // read by somebody who is level 5 is a lie about which direction they are
  // wrong in -- and the whole point of a register is that a player can tell
  // which rung a job belongs to. See the header.
  const rung = rungOf(facts.level);
  if (rung < quest.level) return `level ${quest.level} first`;
  if (rung > quest.level) return `level ${quest.level} only`;
  if (quest.faction !== '' && facts.faction !== quest.faction) return `that is ${quest.faction} work`;
  for (const need of quest.requires) {
    if (!facts.story.has(completionFlag(need))) return 'not yet';
  }
  for (const flag of quest.needFlags) if (!facts.story.has(flag)) return 'not yet';
  for (const flag of quest.denyFlags) if (facts.story.has(flag)) return 'that ship has sailed';
  return '';
}

/**
 * What the live bundle looks like to somebody asking about one player.
 *
 * A lookup **function** rather than a map, because the two callers hold the
 * quests in different shapes for good reasons of their own: the server walks
 * `ContentStore.bundle.quests` on an op, and the browser keeps an index it
 * rebuilds when `/content` changes revision. Neither should have to build the
 * other's structure to ask a question.
 */
export interface QuestView {
  /** The quest with this id in the live bundle, or null. */
  quest(id: string): Quest | null;
  /** This player's open cursors. */
  cursors: QuestCursors;
}

/** The obvious `QuestView` over an array. For the checks and small bundles. */
export function questView(quests: readonly Quest[], cursors: QuestCursors): QuestView {
  const byId = new Map(quests.map((q) => [q.id, q]));
  return { quest: (id) => byId.get(id) ?? null, cursors };
}

/**
 * Whether a dialog choice is offered at all, and why not. Same shape, same
 * argument.
 *
 * ---------------------------------------------------------------------------
 * **ONE RULE, THREE READERS.** Workstream AN.
 *
 * `view` is optional and everything changes when it is supplied. Without it
 * this answers the *choice's own* gates -- level, side, flags, the price of a
 * bribe -- which is all a plain `goto` has. With it, a choice that **accepts**
 * or **turns in** a quest is also asked about the quest, so the one function
 * answers the whole question a button has to answer before it is drawn.
 *
 * That matters because two readers ask the whole question and they must not
 * drift: `client/src/dialog.ts` greys the button out and prints the sentence,
 * and `client/src/world/questmarkers.ts` decides whether the NPC gets a `!`.
 * Before this, the panel had a private copy of the quest half and the world had
 * none -- which is exactly how a marker ends up floating over an NPC with
 * nothing to give.
 *
 * **`server/quests.ts` deliberately calls this without a view**, and that is
 * not an oversight. Its `node` handler decides where a conversation *walks*;
 * the decisions are `accept` and `turnin`, and each of those already asks
 * `questRefusal` -- the same gate this reaches through -- with the authority's
 * own facts. Handing `node` the quest half as well would refuse the navigation
 * that arrives immediately **after** an accept it just granted, and the player
 * would read "you are already on that" for the click that started the job.
 */
export function choiceRefusal(choice: DialogChoice, facts: PlayerFacts, view?: QuestView): string {
  if (choice.needLevel > 0 && facts.level < choice.needLevel) return `level ${choice.needLevel} first`;
  if (choice.needFaction !== '' && facts.faction !== choice.needFaction) return `${choice.needFaction} only`;
  if (choice.needFlag !== '' && !facts.story.has(choice.needFlag)) return 'not yet';
  if (choice.denyFlag !== '' && facts.story.has(choice.denyFlag)) return 'too late for that';
  if (choice.needCash > 0 && facts.cash < choice.needCash) return `$${choice.needCash}`;
  if (view === undefined) return '';
  // The quest half. Ordered the way `SuggestionStore.vote` orders its own
  // refusals: the most specific true thing first. A button that turns in a job
  // you have not finished should name **the step you are on**, which is the
  // single most useful sentence a conversation can produce.
  if (choice.accept !== '') {
    const quest = view.quest(choice.accept);
    if (!quest) return 'not available';
    return questRefusal(quest, facts, view.cursors);
  }
  if (choice.turnin !== '') {
    const quest = view.quest(choice.turnin);
    const cursor = view.cursors[choice.turnin];
    if (!quest || !cursor) return 'you are not on that';
    if (!cursor.d) {
      const step = quest.steps[cursor.s];
      return step ? stepLabel(step) : 'not yet';
    }
  }
  return '';
}

/** A step's tracker line, clipped to a row. One place, so the panel and the
 * refusal say the same words about the same step. */
export function stepLabel(step: QuestStep, max = 52): string {
  const text = step.label === '' ? defaultLabel(step) : step.label;
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
}

// --- The register, and the marks over the giver's head --------------------------

/**
 * Where one quest sits for one player, in one word.
 *
 * The register's vocabulary and the marker's, and they are the same five words
 * on purpose: a job the phone calls `ready` is a job the world puts a `?` over,
 * and a player who has read one has read the other.
 */
export type QuestStanding = 'on' | 'ready' | 'available' | 'done' | 'locked';

export function questStanding(quest: Quest, facts: PlayerFacts, cursors: QuestCursors): QuestStanding {
  const cursor = cursors[quest.id];
  if (cursor !== undefined) return cursor.d ? 'ready' : 'on';
  if (facts.story.has(doneFlag(quest))) return 'done';
  return questRefusal(quest, facts, cursors) === '' ? 'available' : 'locked';
}

/** What floats over a quest giver's head. WoW's pair, and nothing else. */
export type QuestMarker = 'none' | 'offer' | 'turnin';

/**
 * The `!` and the `?`, decided once and read by the renderer.
 *
 * Pure and three-free so it can be checked in `verifyQuests` rather than by
 * looking at Sydney, and it takes a **`QuestView`** rather than a bare cursor
 * map for the reason `choiceRefusal` gives: the answer depends on the quests
 * behind this NPC's buttons, and an NPC alone cannot know them.
 *
 * The rule is deliberately *not* "does this NPC give a quest at your rung". It
 * is **"is there a button on their tree you could press right now"**, evaluated
 * through the same `choiceRefusal` the panel greys with -- so the mark and the
 * conversation can never disagree, which is the failure a second copy of the
 * rule would produce and nothing would report.
 *
 * `turnin` wins over `offer` when both are true, on WoW's own ordering: a
 * player who can hand something in is finishing a loop, and the reward is the
 * more urgent of the two invitations.
 */
export function markerFor(npc: DialogNpc, facts: PlayerFacts, view: QuestView): QuestMarker {
  let offer = false;
  for (const node of npc.nodes) {
    for (const choice of node.choices) {
      if (choice.accept === '' && choice.turnin === '') continue;
      if (choiceRefusal(choice, facts, view) !== '') continue;
      if (choice.turnin !== '') return 'turnin';
      offer = true;
    }
  }
  return offer ? 'offer' : 'none';
}

// --- Progress ------------------------------------------------------------------

/**
 * How much of a step is needed. One place, so the tracker and the adjudicator
 * cannot disagree about whether "3 eshays" means three.
 */
export function stepTarget(step: QuestStep): number {
  if (step.kind === STEP_KIND.EARN) return step.dollars;
  if (step.kind === STEP_KIND.KO || step.kind === STEP_KIND.BUY) return step.count;
  return 1;
}

/**
 * Add progress to the open step and advance past it if it is now satisfied.
 *
 * Returns whether anything moved, which is what decides a write to disk and a
 * frame to the client. **Advances over any number of steps in one call**,
 * deliberately: a `goto` whose target is where the player already stands would
 * otherwise take a second event to clear, and the event that would clear it may
 * never come.
 *
 * Pure over `(cursor, quest, amount)` and mutating on the cursor -- it is
 * called from the tick.
 */
export function addProgress(cursor: QuestCursor, quest: Quest, amount: number): boolean {
  if (cursor.d || cursor.s >= quest.steps.length || amount <= 0) return false;
  const before = cursor.s;
  const beforeCount = cursor.c[cursor.s] ?? 0;
  cursor.c[cursor.s] = beforeCount + amount;
  while (cursor.s < quest.steps.length && (cursor.c[cursor.s] ?? 0) >= stepTarget(quest.steps[cursor.s])) {
    cursor.s++;
  }
  if (cursor.s >= quest.steps.length) cursor.d = true;
  return cursor.s !== before || (cursor.c[before] ?? 0) !== beforeCount;
}

/** The step a player is being asked for right now, or null when it is ready to hand in. */
export function openStep(cursor: QuestCursor, quest: Quest): QuestStep | null {
  if (cursor.d || cursor.s >= quest.steps.length) return null;
  return quest.steps[cursor.s] ?? null;
}

/**
 * Is this position inside a step's circle?
 *
 * Squared metres and no `Math.hypot`, on this repo's determinism rule: this is
 * evaluated on the server's tick and predicted in the browser's tracker, and
 * the two must agree about the boundary or a player watches a step tick over on
 * one screen and not the other.
 */
export function withinStep(step: QuestStep, x: number, z: number): boolean {
  const dx = x - step.x;
  const dz = z - step.z;
  return dx * dx + dz * dz <= step.radius * step.radius;
}

// --- The AI's output, on the way back in ----------------------------------------

/**
 * How long a model may make an NPC talk.
 *
 * The panel is a fixed-height box and a paragraph in it is a scrollbar in a
 * conversation. It is also the cheapest denial of service in the feature: an
 * endpoint that answered with a megabyte would put a megabyte in the ledger,
 * in every `/content` response, forever.
 */
export const MAX_IMPROV_CHARS = 200;

/**
 * A model's answer, made safe to draw.
 *
 * **Display text only**, and the four things stripped here are the four things
 * that make it more than that: markup (the panel sets `textContent`, so a tag
 * would render as literal angle brackets and look like a bug), newlines (a
 * one-line box), control characters, and length. It is deliberately *not* a
 * moderation pass and does not pretend to be one -- what it is is the guarantee
 * that whatever comes back is a string of at most 200 printable characters that
 * cannot become anything else.
 *
 * An answer that is empty after all that returns `''`, and the caller serves
 * the authored line -- which is the same path a missing key takes, so the
 * degraded case has exactly one implementation.
 */
export function clampImprov(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const flat = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return [...flat].slice(0, MAX_IMPROV_CHARS).join('').trim();
}

// --- The self-checks -------------------------------------------------------------

/**
 * Everything about the quest schema that can be wrong without throwing.
 *
 * Run at boot in **both** runtimes, on `verifyAccounts`' arrangement, and the
 * failures are asymmetric in the way that list describes:
 *
 *   - A **parser that accepts a bad pack** is the whole feature's safety
 *     property gone. The pack is applied, half its quests are missing, and the
 *     game runs perfectly with an obligations app that is one item short.
 *   - A **reward ceiling that does not hold** is a typo in a text file paying
 *     every player on the box $50,000, permanently, with no un-do.
 *   - An **improv node that can accept a quest** is a language model with a
 *     hand on the wallet. There is no frame in which that looks wrong.
 *   - A **cycle detector that does not detect** is two quests nobody can start
 *     and nothing anywhere that says so.
 *   - **Progress arithmetic off by one** is a step that needs four knockouts
 *     where the tracker says three, which reads as the game cheating.
 *   - The **capitalisation of Marita and DeFAULT**, which renders perfectly
 *     when it is wrong and is read by every player who takes faction work.
 */
export function verifyQuests(): string[] {
  const failures: string[] = [];

  // --- The parser refuses the rows a hand-edited file really contains.
  {
    const bad: Array<[unknown, string]> = [
      [null, 'null'],
      ['quests', 'a string'],
      [[], 'an array'],
      [{}, 'no quests array'],
      [{ quests: {} }, 'a quests field that is not an array'],
    ];
    for (const [raw, why] of bad) {
      const { errors } = parseQuestPack(raw, 'test');
      if (errors.length === 0) failures.push(`A pack with ${why} produced no errors.`);
    }
  }

  // --- A good pack survives, with everything derived rather than believed.
  {
    const { value, errors } = parseQuestPack(
      {
        pack: 'Test Pack',
        quests: [
          {
            id: '  Act0-Report  ',
            act: 0,
            title: 'Report to the office',
            giver: 'clerk',
            faction: '',
            steps: [
              { kind: 'goto', x: 100, z: -200, radius: 20, label: 'get to Marrickville' },
              { kind: 'ko', npc: 'eshay', count: 3 },
              { kind: 'dialog', npc: 'clerk', node: 'done' },
            ],
            reward: { cash: 40, xp: 250, unlock: ['act0:reported'] },
          },
        ],
      },
      'fixture',
    );
    if (errors.length > 0) failures.push(`A well-formed pack produced errors: ${errors.join('; ')}`);
    const q = value.quests[0];
    if (!q) {
      failures.push('A well-formed pack produced no quests.');
    } else {
      if (q.id !== 'act0-report') failures.push(`An id came back as ${JSON.stringify(q.id)}; ids are folded and trimmed.`);
      // Whitespace is **removed** from an id rather than replaced with a
      // hyphen. A silent hyphen would be an id that does not match the one the
      // author typed into a `requires` list one file over.
      if (value.pack !== 'testpack') failures.push(`A pack name came back as ${JSON.stringify(value.pack)}.`);
      if (q.steps.length !== 3) failures.push(`${q.steps.length} steps survived, not 3.`);
      if (q.steps[1].count !== 3) failures.push('A ko step lost its count.');
      if (q.steps[2].label === '') failures.push('A step with no label came back with no label; the tracker would be blank.');
      if (q.reward.unlock[0] !== 'act0:reported') failures.push('An unlock flag was dropped.');
      if (q.level !== 1) failures.push(`A quest with no level gate came back at level ${q.level}.`);
    }
  }

  // --- The ceilings hold. This is the one that costs money when it does not.
  {
    const rich = parseQuestPack(
      {
        quests: [{ id: 'rich', giver: 'clerk', steps: [{ kind: 'earn', dollars: 10 }], reward: { cash: 1_000_000 } }],
      },
      'fixture',
    );
    if (rich.value.quests.length !== 0) failures.push('A quest paying $1,000,000 was accepted. A content file can mint.');
    if (!rich.errors.some((e) => e.includes('ceiling'))) failures.push('The cash ceiling did not say what it was.');
    const clever = parseQuestPack(
      { quests: [{ id: 'xp', giver: 'clerk', steps: [{ kind: 'earn', dollars: 10 }], reward: { xp: 999999 } }] },
      'fixture',
    );
    if (clever.value.quests.length !== 0) failures.push('A quest paying 999,999 xp was accepted.');
    const flags = parseQuestPack(
      {
        quests: [
          {
            id: 'flags',
            giver: 'clerk',
            steps: [{ kind: 'earn', dollars: 10 }],
            reward: { unlock: ['a', 'b', 'c', 'd', 'e', 'f'] },
          },
        ],
      },
      'fixture',
    );
    if (flags.value.quests.length !== 0) failures.push(`A quest setting six story flags was accepted, over the ${MAX_UNLOCKS} cap.`);
  }

  // --- The two spellings, which render perfectly when they are wrong.
  {
    for (const side of ['Marita', 'DeFAULT']) {
      const ok = parseQuestPack(
        { quests: [{ id: 'q', giver: 'clerk', faction: side, steps: [{ kind: 'earn', dollars: 5 }] }] },
        'fixture',
      );
      if (ok.value.quests.length !== 1) failures.push(`A quest gated on ${side} was refused.`);
    }
    for (const wrong of ['marita', 'MARITA', 'Default', 'default', 'DEFAULT']) {
      const no = parseQuestPack(
        { quests: [{ id: 'q', giver: 'clerk', faction: wrong, steps: [{ kind: 'earn', dollars: 5 }] }] },
        'fixture',
      );
      if (no.value.quests.length !== 0) {
        failures.push(`A quest spelt its side "${wrong}" and was accepted; the capitalisation is the owner's.`);
      }
    }
  }

  // --- Steps: the kinds, the bounds, and the coordinates a paste produces.
  {
    const junk = parseQuestPack(
      { quests: [{ id: 'q', giver: 'clerk', steps: [{ kind: 'befriend', who: 'a dog' }] }] },
      'fixture',
    );
    if (junk.value.quests.length !== 0) failures.push('A quest with an unknown step kind was accepted whole.');
    const far = parseQuestPack(
      { quests: [{ id: 'q', giver: 'clerk', steps: [{ kind: 'goto', x: -33.87, z: 151.2 }, { kind: 'goto', x: 1e9, z: 0 }] }] },
      'fixture',
    );
    if (far.value.quests.length !== 0) failures.push('A goto step a thousand kilometres away was accepted.');
    const tiny = parseQuestPack(
      { quests: [{ id: 'q', giver: 'clerk', steps: [{ kind: 'goto', x: 0, z: 0, radius: 0 }] }] },
      'fixture',
    );
    const radius = tiny.value.quests[0]?.steps[0].radius ?? 0;
    if (radius < MIN_GOTO_RADIUS_M) failures.push(`A goto radius of 0 survived as ${radius} m; nobody can stand on a point.`);
    const huge = parseQuestPack(
      { quests: [{ id: 'q', giver: 'clerk', steps: [{ kind: 'goto', x: 0, z: 0, radius: 99999 }] }] },
      'fixture',
    );
    if ((huge.value.quests[0]?.steps[0].radius ?? 0) > MAX_GOTO_RADIUS_M) {
      failures.push('A goto radius of 99,999 m survived; the step would be complete on accept.');
    }
    const many = parseQuestPack(
      {
        quests: [
          { id: 'q', giver: 'clerk', steps: Array.from({ length: MAX_STEPS + 1 }, () => ({ kind: 'earn', dollars: 1 })) },
        ],
      },
      'fixture',
    );
    if (many.value.quests.length !== 0) failures.push(`A quest with ${MAX_STEPS + 1} steps was accepted.`);
    const none = parseQuestPack({ quests: [{ id: 'q', giver: 'clerk', steps: [] }] }, 'fixture');
    if (none.value.quests.length !== 0) failures.push('A quest with no steps was accepted; it could never be finished.');
  }

  // --- Referential integrity and the cycle.
  {
    const npcs = parseDialogPack(
      {
        npcs: [
          {
            id: 'clerk',
            name: 'A clerk',
            x: 0,
            z: 0,
            root: 'hello',
            nodes: [
              {
                id: 'hello',
                line: 'take a seat',
                choices: [
                  { text: 'take it', accept: 'a' },
                  { text: 'done', turnin: 'a' },
                ],
              },
            ],
          },
        ],
      },
      'fixture',
    ).value.npcs;
    const one = parseQuestPack(
      { quests: [{ id: 'a', giver: 'clerk', steps: [{ kind: 'earn', dollars: 5 }] }] },
      'fixture',
    ).value.quests;
    const clean = validateBundle(one, npcs);
    if (clean.length > 0) failures.push(`A complete bundle reported ${clean.join('; ')}`);

    const dangling = validateBundle(
      parseQuestPack(
        { quests: [{ id: 'a', giver: 'clerk', requires: ['nobody'], steps: [{ kind: 'earn', dollars: 5 }] }] },
        'fixture',
      ).value.quests,
      npcs,
    );
    if (!dangling.some((e) => e.includes('nobody'))) failures.push('A prereq naming a quest that does not exist was not reported.');

    const loop = parseQuestPack(
      {
        quests: [
          { id: 'a', giver: 'clerk', requires: ['b'], steps: [{ kind: 'earn', dollars: 5 }] },
          { id: 'b', giver: 'clerk', requires: ['a'], steps: [{ kind: 'earn', dollars: 5 }] },
        ],
      },
      'fixture',
    ).value.quests;
    if (!validateBundle(loop, npcs).some((e) => e.includes('cycle'))) {
      failures.push('Two quests requiring each other were not reported as a cycle; neither could ever start.');
    }
    // And a long one, because a two-cycle can be caught by a comparison that a
    // three-cycle walks straight past.
    const long = parseQuestPack(
      {
        quests: [
          { id: 'a', giver: 'clerk', requires: ['b'], steps: [{ kind: 'earn', dollars: 5 }] },
          { id: 'b', giver: 'clerk', requires: ['c'], steps: [{ kind: 'earn', dollars: 5 }] },
          { id: 'c', giver: 'clerk', requires: ['a'], steps: [{ kind: 'earn', dollars: 5 }] },
        ],
      },
      'fixture',
    ).value.quests;
    if (!validateBundle(long, npcs).some((e) => e.includes('cycle'))) failures.push('A three-quest prereq cycle was not detected.');
    // A diamond is not a cycle and must not be reported as one.
    const diamond = parseQuestPack(
      {
        quests: [
          { id: 'a', giver: 'clerk', steps: [{ kind: 'earn', dollars: 5 }] },
          { id: 'b', giver: 'clerk', requires: ['a'], steps: [{ kind: 'earn', dollars: 5 }] },
          { id: 'c', giver: 'clerk', requires: ['a'], steps: [{ kind: 'earn', dollars: 5 }] },
          { id: 'd', giver: 'clerk', requires: ['b', 'c'], steps: [{ kind: 'earn', dollars: 5 }] },
        ],
      },
      'fixture',
    ).value.quests;
    if (validateBundle(diamond, npcs).some((e) => e.includes('cycle'))) failures.push('A diamond of prereqs was reported as a cycle.');
    // A quest nobody can start or finish.
    const orphan = validateBundle(
      parseQuestPack({ quests: [{ id: 'z', giver: 'clerk', steps: [{ kind: 'earn', dollars: 5 }] }] }, 'fixture').value.quests,
      npcs,
    );
    if (!orphan.some((e) => e.includes('no way to start'))) failures.push('A quest no dialog choice accepts was not reported.');
  }

  // --- Progress arithmetic.
  {
    const quest = parseQuestPack(
      {
        quests: [
          {
            id: 'q',
            giver: 'clerk',
            steps: [{ kind: 'ko', npc: 'eshay', count: 3 }, { kind: 'earn', dollars: 50 }],
          },
        ],
      },
      'fixture',
    ).value.quests[0];
    if (!quest) {
      failures.push('The progress fixture did not parse.');
    } else {
      const cursor = blankCursor(quest);
      if (cursor.c.length !== 2) failures.push(`A blank cursor has ${cursor.c.length} counters for 2 steps.`);
      if (openStep(cursor, quest)?.kind !== STEP_KIND.KO) failures.push('A fresh cursor is not on its first step.');
      addProgress(cursor, quest, 1);
      if (cursor.s !== 0) failures.push('One of three knockouts advanced the step.');
      addProgress(cursor, quest, 2);
      if (cursor.s !== 1) failures.push(`Three of three knockouts left the cursor on step ${cursor.s}.`);
      if (cursor.d) failures.push('A quest with a step left was marked done.');
      addProgress(cursor, quest, 49);
      if (cursor.d) failures.push('$49 of $50 completed the quest.');
      addProgress(cursor, quest, 1);
      if (!cursor.d) failures.push('$50 of $50 did not complete the quest.');
      if (addProgress(cursor, quest, 10)) failures.push('A finished quest accepted more progress.');
      if (openStep(cursor, quest) !== null) failures.push('A finished quest still names an open step.');
    }
    // A quest whose only step is a goto the player is already standing in must
    // complete on the first evaluation rather than waiting for a second event.
    const here = parseQuestPack(
      { quests: [{ id: 'q', giver: 'clerk', steps: [{ kind: 'goto', x: 0, z: 0, radius: 10 }] }] },
      'fixture',
    ).value.quests[0];
    if (here) {
      const cursor = blankCursor(here);
      addProgress(cursor, here, 1);
      if (!cursor.d) failures.push('A single-goto quest did not complete on one satisfied evaluation.');
      if (!withinStep(here.steps[0], 3, 4)) failures.push('A point 5 m from a 10 m circle read as outside it.');
      if (withinStep(here.steps[0], 11, 0)) failures.push('A point 11 m from a 10 m circle read as inside it.');
    }
  }

  // --- Who may take what.
  {
    const quests = parseQuestPack(
      {
        quests: [
          { id: 'first', giver: 'clerk', steps: [{ kind: 'earn', dollars: 5 }], reward: { unlock: ['act0:in'] } },
          { id: 'second', giver: 'clerk', level: 3, requires: ['first'], steps: [{ kind: 'earn', dollars: 5 }] },
          { id: 'side', giver: 'clerk', level: 9, faction: 'DeFAULT', steps: [{ kind: 'earn', dollars: 5 }] },
        ],
      },
      'fixture',
    ).value.quests;
    const facts = (level: number, side: string, story: string[]): PlayerFacts => ({
      level,
      faction: side,
      story: new Set(story),
      cash: 0,
    });
    if (questRefusal(quests[0], facts(1, '', []), {}) !== '') failures.push('An ungated quest was refused to a level-1 guest.');
    if (questRefusal(quests[1], facts(1, '', []), {}) === '') failures.push('A level-3 quest was offered at level 1.');
    if (questRefusal(quests[1], facts(3, '', []), {}) === '') failures.push('A quest with an unmet prereq was offered.');
    if (questRefusal(quests[1], facts(3, '', [completionFlag('first')]), {}) !== '') {
      failures.push('A quest whose prereq is finished and whose level is met was still refused.');
    }
    if (questRefusal(quests[2], facts(9, 'Marita', []), {}) === '') failures.push('DeFAULT work was offered to Marita.');
    if (questRefusal(quests[2], facts(9, 'DeFAULT', []), {}) !== '') failures.push('DeFAULT work was refused to DeFAULT.');
    if (questRefusal(quests[0], facts(1, '', [completionFlag('first')]), {}) === '') {
      failures.push('A quest already finished was offered again; a story quest must not repeat.');
    }
    if (questRefusal(quests[0], facts(1, '', []), { first: blankCursor(quests[0]) }) === '') {
      failures.push('A quest already in progress was offered again.');
    }
  }

  /*
   * --- WORKSTREAM AN. **The rung is exact**, which is the whole of the
   * register, and every one of these fails silently in this repo's sense: the
   * game plays perfectly and the job is simply never on the phone.
   *
   * The one that a minimum could never have caught is `offered at 3, refused at
   * 4`. A gate that is only ever tested from below reads as correct for as long
   * as nobody levels up, which is one evening.
   */
  {
    const quests = parseQuestPack(
      {
        quests: [
          { id: 'three', giver: 'clerk', level: 3, steps: [{ kind: 'earn', dollars: 5 }] },
          { id: 'top', giver: 'clerk', level: 99, steps: [{ kind: 'earn', dollars: 5 }] },
          { id: 'weekly', giver: 'clerk', level: 2, repeatable: true, steps: [{ kind: 'earn', dollars: 5 }] },
        ],
      },
      'fixture',
    ).value.quests;
    const [three, top, weekly] = quests;
    const facts = (level: number, story: string[] = []): PlayerFacts => ({
      level,
      faction: '',
      story: new Set(story),
      cash: 0,
    });
    if (!three) {
      failures.push('The register fixture did not parse.');
    } else {
      if (questRefusal(three, facts(3), {}) !== '') failures.push('A level-3 quest was refused at level 3.');
      if (questRefusal(three, facts(2), {}) === '') failures.push('A level-3 quest was offered at level 2.');
      if (questRefusal(three, facts(4), {}) === '') {
        failures.push('A level-3 quest was still offered at level 4; the rung is exact, not a minimum.');
      }
      // And the sentence points the right way, because "level 3 first" read at
      // level 5 is the game lying about which direction you are wrong in.
      if (questRefusal(three, facts(2), {}) !== 'level 3 first') {
        failures.push(`Below the rung the refusal reads ${JSON.stringify(questRefusal(three, facts(2), {}))}.`);
      }
      if (questRefusal(three, facts(4), {}) !== 'level 3 only') {
        failures.push(`Above the rung the refusal reads ${JSON.stringify(questRefusal(three, facts(4), {}))}.`);
      }
    }
    // The top rung is a landing: a quest authored past the register is clamped
    // onto it, and a player past the register still stands on it.
    if (top?.level !== REGISTER_LEVELS) failures.push(`A level-99 quest came back on rung ${top?.level}.`);
    if (top && questRefusal(top, facts(REGISTER_LEVELS + 5), {}) !== '') {
      failures.push('A player past the top rung was offered nothing at all; the tenth rung is a landing.');
    }
    if (rungOf(0) !== 1 || rungOf(1) !== 1 || rungOf(7) !== 7 || rungOf(400) !== REGISTER_LEVELS) {
      failures.push(`rungOf clamps wrongly: ${[rungOf(0), rungOf(1), rungOf(7), rungOf(400)].join(', ')}.`);
    }

    // --- The two completion marks, and which one Monday takes.
    if (!weekly) {
      failures.push('The weekly fixture did not parse.');
    } else {
      if (doneFlag(weekly) !== weeklyFlag('weekly')) failures.push('A repeatable does not mark itself weekly.');
      if (three && doneFlag(three) !== completionFlag('three')) failures.push('A story quest does not mark itself permanently.');
      if (!weeklyFlag('x').startsWith(WEEKLY_FLAG_PREFIX)) failures.push('A weekly mark does not carry the prefix Monday sweeps.');
      if (completionFlag('x').startsWith(WEEKLY_FLAG_PREFIX)) {
        failures.push('A story mark carries the weekly prefix; Monday would erase the story.');
      }
      if (questRefusal(weekly, facts(2, [weeklyFlag('weekly')]), {}) === '') {
        failures.push('A repeatable already done this week was offered again.');
      }
      if (questRefusal(weekly, facts(2, [completionFlag('weekly')]), {}) !== '') {
        failures.push('A repeatable was refused by a story mark it never writes.');
      }
      // And the standing the register draws, for each of the five words.
      const cursor = blankCursor(weekly);
      if (questStanding(weekly, facts(2), {}) !== 'available') failures.push('A takeable job did not read as available.');
      if (questStanding(weekly, facts(3), {}) !== 'locked') failures.push('A job on another rung did not read as locked.');
      if (questStanding(weekly, facts(2, [weeklyFlag('weekly')]), {}) !== 'done') failures.push('A finished job did not read as done.');
      if (questStanding(weekly, facts(2), { weekly: cursor }) !== 'on') failures.push('A job in progress did not read as on.');
      if (questStanding(weekly, facts(2), { weekly: { ...cursor, d: true } }) !== 'ready') {
        failures.push('A job ready to hand in did not read as ready.');
      }
    }
  }

  /*
   * --- WORKSTREAM AN. **The `!` and the `?`**, which are the only thing in the
   * world that says an NPC is worth walking up to.
   *
   * Every failure here is silent and expensive in the same way: a mark that is
   * absent is content nobody finds, and a mark that is present over an NPC with
   * nothing to give is a player crossing Sydney for a greyed-out button. The
   * decision is pure so it can be checked here rather than by looking.
   */
  {
    const npc = parseDialogPack(
      {
        npcs: [
          {
            id: 'clerk',
            x: 0,
            z: 0,
            nodes: [
              {
                id: 'hello',
                line: 'take a number',
                choices: [
                  { text: 'the level three job', accept: 'three' },
                  { text: 'done the level three job', turnin: 'three' },
                  { text: 'nothing', goto: '' },
                ],
              },
            ],
          },
        ],
      },
      'fixture',
    ).value.npcs[0];
    const quests = parseQuestPack(
      { quests: [{ id: 'three', giver: 'clerk', level: 3, steps: [{ kind: 'ko', count: 2 }] }] },
      'fixture',
    ).value.quests;
    const facts = (level: number, story: string[] = []): PlayerFacts => ({
      level,
      faction: '',
      story: new Set(story),
      cash: 0,
    });
    if (!npc || quests.length !== 1) {
      failures.push('The marker fixture did not parse.');
    } else {
      const view = (cursors: QuestCursors): QuestView => questView(quests, cursors);
      if (markerFor(npc, facts(3), view({})) !== 'offer') failures.push('An NPC with a takeable job got no "!".');
      if (markerFor(npc, facts(2), view({})) !== 'none') failures.push('An NPC got a "!" for a job one rung up.');
      if (markerFor(npc, facts(4), view({})) !== 'none') failures.push('An NPC got a "!" for a job one rung down.');
      if (markerFor(npc, facts(3, [completionFlag('three')]), view({})) !== 'none') {
        failures.push('An NPC got a "!" for a job already done.');
      }
      const open = blankCursor(quests[0]);
      if (markerFor(npc, facts(3), view({ three: open })) !== 'none') {
        failures.push('An NPC got a mark while the job is still being walked; there is nothing to say to them.');
      }
      if (markerFor(npc, facts(3), view({ three: { ...open, d: true } })) !== 'turnin') {
        failures.push('An NPC holding a finished job got no "?".');
      }
      // The turn-in wins. Both are true the moment a repeatable is finished and
      // the reward is the more urgent invitation -- WoW's own ordering.
      const both = parseDialogPack(
        {
          npcs: [
            {
              id: 'clerk',
              x: 0,
              z: 0,
              nodes: [
                {
                  id: 'hello',
                  line: 'again',
                  choices: [
                    { text: 'another', accept: 'other' },
                    { text: 'done', turnin: 'three' },
                  ],
                },
              ],
            },
          ],
        },
        'fixture',
      ).value.npcs[0];
      const pair = parseQuestPack(
        {
          quests: [
            { id: 'three', giver: 'clerk', level: 3, steps: [{ kind: 'ko', count: 2 }] },
            { id: 'other', giver: 'clerk', level: 3, steps: [{ kind: 'ko', count: 1 }] },
          ],
        },
        'fixture',
      ).value.quests;
      if (both && markerFor(both, facts(3), questView(pair, { three: { ...open, d: true } })) !== 'turnin') {
        failures.push('An NPC with both a job to give and one to take back drew the "!" rather than the "?".');
      }
      // A choice whose own gate refuses it is not an invitation either, which is
      // what makes the mark and the greyed button the same rule.
      const gated = parseDialogPack(
        {
          npcs: [
            {
              id: 'clerk',
              x: 0,
              z: 0,
              nodes: [{ id: 'hello', line: 'no', choices: [{ text: 'job', accept: 'three', needFaction: 'Marita' }] }],
            },
          ],
        },
        'fixture',
      ).value.npcs[0];
      if (gated && markerFor(gated, facts(3), view({})) !== 'none') {
        failures.push('An NPC drew a "!" over a choice the panel would grey out.');
      }
      // And an NPC with no quest buttons at all never draws anything, which is
      // most of the city once the pool lands.
      const idle = parseDialogPack(
        { npcs: [{ id: 'x', x: 0, z: 0, nodes: [{ id: 'hello', line: 'hi', choices: [{ text: 'bye', goto: '' }] }] }] },
        'fixture',
      ).value.npcs[0];
      if (idle && markerFor(idle, facts(3), view({})) !== 'none') failures.push('An NPC with nothing to give drew a mark.');
    }
  }

  // --- The refusal a button carries, which is the panel's copy of all of the
  // above and must not be a second opinion. See `choiceRefusal`'s `view`.
  {
    const quests = parseQuestPack(
      { quests: [{ id: 'job', giver: 'clerk', level: 2, steps: [{ kind: 'ko', count: 3, label: 'drop three' }] }] },
      'fixture',
    ).value.quests;
    const npc = parseDialogPack(
      {
        npcs: [
          {
            id: 'clerk',
            x: 0,
            z: 0,
            nodes: [
              {
                id: 'hello',
                line: 'hi',
                choices: [
                  { text: 'take it', accept: 'job' },
                  { text: 'done it', turnin: 'job' },
                  { text: 'take the ghost', accept: 'ghost' },
                ],
              },
            ],
          },
        ],
      },
      'fixture',
    ).value.npcs[0];
    const facts: PlayerFacts = { level: 2, faction: '', story: new Set(), cash: 0 };
    if (!npc || quests.length !== 1) {
      failures.push('The choice-view fixture did not parse.');
    } else {
      const [take, hand, ghost] = npc.nodes[0].choices;
      if (choiceRefusal(take, facts) !== '') failures.push('A choice with no gates of its own was refused without a view.');
      if (choiceRefusal(take, facts, questView(quests, {})) !== '') failures.push('A takeable job was refused through the view.');
      if (choiceRefusal(take, { ...facts, level: 3 }, questView(quests, {})) === '') {
        failures.push('A job one rung down was still offered by its button; the panel would not grey it.');
      }
      if (choiceRefusal(ghost, facts, questView(quests, {})) !== 'not available') {
        failures.push('A choice accepting a quest that does not exist did not say so.');
      }
      if (choiceRefusal(hand, facts, questView(quests, {})) !== 'you are not on that') {
        failures.push('A turn-in for a job never taken did not say so.');
      }
      const cursor = blankCursor(quests[0]);
      if (choiceRefusal(hand, facts, questView(quests, { job: cursor })) !== 'drop three') {
        failures.push('A turn-in for an unfinished job did not name the step you are on.');
      }
      if (choiceRefusal(hand, facts, questView(quests, { job: { ...cursor, d: true } })) !== '') {
        failures.push('A turn-in for a finished job was refused.');
      }
      const clipped = stepLabel(quests[0].steps[0], 6);
      if ([...clipped].length !== 6 || !clipped.endsWith('\u2026')) {
        failures.push(`A long step label was not clipped to a row: ${JSON.stringify(clipped)}.`);
      }
      if (stepLabel(quests[0].steps[0]) !== 'drop three') failures.push('A short step label was clipped anyway.');
    }
  }

  // --- The cursor parser, on the rows an account file can really contain.
  {
    const quest = parseQuestPack(
      { quests: [{ id: 'q', giver: 'clerk', steps: [{ kind: 'earn', dollars: 5 }, { kind: 'earn', dollars: 5 }] }] },
      'fixture',
    ).value.quests[0];
    const steps = quest?.steps.length ?? 0;
    for (const raw of [null, 'x', [], { s: -1 }, { s: 99 }, { s: Number.NaN }]) {
      if (sanitiseCursor(raw, steps) !== null) failures.push(`A cursor of ${JSON.stringify(raw)} was accepted off disk.`);
    }
    const cursor = sanitiseCursor({ s: 1, c: [5, 'x', 9, 9, 9], d: false }, steps);
    if (!cursor) failures.push('A well-formed cursor was refused off disk.');
    else {
      if (cursor.c.length !== steps) failures.push(`A cursor came back with ${cursor.c.length} counters for ${steps} steps.`);
      if (cursor.c[1] !== 0) failures.push('A non-numeric counter did not come back as zero.');
    }
    // And the content-free parse the account loader does, which cannot know
    // how long the quest is because no pack has loaded yet.
    const loose = sanitiseCursor({ s: 1, c: [4, 0], d: false });
    if (loose?.c.length !== 2) failures.push(`A cursor parsed without a step count came back ${loose?.c.length} wide.`);
  }

  // --- The content changing underneath a live cursor, which is the case this
  // whole feature is built around and the one nothing else can catch.
  {
    const three = parseQuestPack(
      {
        quests: [
          {
            id: 'q',
            giver: 'clerk',
            steps: [{ kind: 'ko', count: 1 }, { kind: 'ko', count: 1 }, { kind: 'ko', count: 1 }],
          },
        ],
      },
      'fixture',
    ).value.quests[0];
    const four = parseQuestPack(
      {
        quests: [
          {
            id: 'q',
            giver: 'clerk',
            steps: [
              { kind: 'ko', count: 1 },
              { kind: 'ko', count: 1 },
              { kind: 'ko', count: 1 },
              { kind: 'ko', count: 1 },
            ],
          },
        ],
      },
      'fixture',
    ).value.quests[0];
    const two = parseQuestPack(
      { quests: [{ id: 'q', giver: 'clerk', steps: [{ kind: 'ko', count: 1 }, { kind: 'ko', count: 1 }] }] },
      'fixture',
    ).value.quests[0];
    if (!three || !four || !two) {
      failures.push('The reconcile fixtures did not parse.');
    } else {
      // Halfway through three steps, and the author adds a fourth.
      const grown: QuestCursor = { s: 2, c: [1, 1, 0], d: false };
      reconcileCursor(grown, four);
      if (grown.c.length !== 4) failures.push(`A cursor did not grow to the quest's new length (${grown.c.length}).`);
      if (grown.s !== 2) failures.push(`A grown cursor jumped to step ${grown.s}; earned progress must be kept.`);
      if (grown.d) failures.push('A grown cursor was marked done.');
      // Finished three steps, and the author adds a fourth. The completion is
      // withdrawn rather than left standing on a quest that is no longer done.
      const wasDone: QuestCursor = { s: 3, c: [1, 1, 1], d: true };
      reconcileCursor(wasDone, four);
      if (wasDone.d) failures.push('A finished cursor stayed finished after a fourth step was added.');
      if (wasDone.s !== 3) failures.push(`A finished cursor re-opened at step ${wasDone.s} rather than 3.`);
      // Halfway through three, and the author *removes* the third.
      const shrunk: QuestCursor = { s: 2, c: [1, 1, 0], d: false };
      reconcileCursor(shrunk, two);
      if (shrunk.c.length !== 2) failures.push(`A cursor did not shrink to the quest's new length (${shrunk.c.length}).`);
      if (!shrunk.d) failures.push('A cursor whose remaining steps are all satisfied was not completed.');
      // A cursor already agreeing with its quest must not report a change, or
      // the engine writes the account file on every join.
      const settled: QuestCursor = { s: 1, c: [1, 0, 0], d: false };
      if (reconcileCursor(settled, three)) failures.push('Reconciling an already-correct cursor reported a change.');
    }
  }

  return failures;
}

/**
 * The dialog half, and the one rule in it that is a safety property.
 *
 * Split from `verifyQuests` on `verifyTeamsWire`'s argument -- the same feature,
 * a different kind of failure -- and because the two are wired into the boot
 * lists as two names, so a failure says which half of the content system is
 * broken rather than "quests".
 *
 * The failures:
 *
 *   - A **node with no line** is a blank panel with buttons under it.
 *   - A **choice going nowhere** is a button that closes the conversation, and
 *     it is indistinguishable from a deliberate goodbye.
 *   - A **root that is not a node** is an NPC who cannot be talked to at all,
 *     silently, for one NPC out of thirty.
 *   - An **improv node that decides something** is the one failure here that is
 *     not merely cosmetic: it is a language model with a hand on the wallet.
 *   - A **bribe gated below its price** is a button the player can click and
 *     the wallet then refuses, which reads as the game taking the money.
 */
export function verifyDialog(): string[] {
  const failures: string[] = [];

  {
    const bad: Array<[unknown, string]> = [
      [null, 'null'],
      [[], 'an array'],
      [{}, 'no npcs array'],
      [{ npcs: 'clerk' }, 'an npcs field that is not an array'],
    ];
    for (const [raw, why] of bad) {
      if (parseDialogPack(raw, 'test').errors.length === 0) failures.push(`A dialog pack with ${why} produced no errors.`);
    }
  }

  // --- A good pack, with the gates on it.
  {
    const { value, errors } = parseDialogPack(
      {
        npcs: [
          {
            id: 'handler',
            name: 'A handler',
            x: -100,
            z: 250,
            radius: 5,
            root: 'hello',
            nodes: [
              {
                id: 'hello',
                line: 'you again',
                choices: [
                  { text: 'what have you got', goto: 'work' },
                  { text: 'slip them fifty', goto: 'work', needCash: 50, cost: 50 },
                  { text: 'nothing', goto: '' },
                ],
              },
              { id: 'work', line: 'here', choices: [{ text: 'fine', accept: 'job' }] },
            ],
          },
        ],
      },
      'fixture',
    );
    if (errors.length > 0) failures.push(`A well-formed dialog pack produced errors: ${errors.join('; ')}`);
    const npc = value.npcs[0];
    if (!npc) {
      failures.push('A well-formed dialog pack produced no npcs.');
    } else {
      if (npc.nodes.length !== 2) failures.push(`${npc.nodes.length} nodes survived, not 2.`);
      if (npc.root !== 'hello') failures.push(`The root came back as ${JSON.stringify(npc.root)}.`);
      const bribe = npc.nodes[0].choices[1];
      if (bribe.cost !== 50 || bribe.needCash !== 50) failures.push('A bribe choice lost its price or its gate.');
    }
  }

  // --- The four refusals.
  {
    const blank = parseDialogPack(
      { npcs: [{ id: 'n', x: 0, z: 0, nodes: [{ id: 'a', line: '' }] }] },
      'fixture',
    );
    if (blank.value.npcs.length !== 0) failures.push('A node with no line was accepted; the panel would be blank.');
    const nowhere = parseDialogPack(
      { npcs: [{ id: 'n', x: 0, z: 0, root: 'a', nodes: [{ id: 'a', line: 'hi', choices: [{ text: 'go', goto: 'b' }] }] }] },
      'fixture',
    );
    if (!validateBundle([], nowhere.value.npcs).some((e) => e.includes('"b"'))) {
      failures.push('A choice going to a node that does not exist was not reported.');
    }
    const rootless = parseDialogPack(
      { npcs: [{ id: 'n', x: 0, z: 0, root: 'missing', nodes: [{ id: 'a', line: 'hi' }] }] },
      'fixture',
    );
    if (rootless.value.npcs.length !== 0) failures.push('An npc whose root is not one of its nodes was accepted.');
    const nowhereReal = parseDialogPack({ npcs: [{ id: 'n', x: 1e9, z: 0, nodes: [{ id: 'a', line: 'hi' }] }] }, 'fixture');
    if (nowhereReal.value.npcs.length !== 0) failures.push('An npc standing a thousand kilometres away was accepted.');
    const cheap = parseDialogPack(
      {
        npcs: [
          { id: 'n', x: 0, z: 0, nodes: [{ id: 'a', line: 'hi', choices: [{ text: 'bribe', needCash: 10, cost: 50 }] }] },
        ],
      },
      'fixture',
    );
    if (!validateBundle([], cheap.value.npcs).some((e) => e.includes('gate'))) {
      failures.push('A $50 bribe behind a $10 gate was not reported; the wallet would refuse the click.');
    }
  }

  // --- **The improv rule.** The one failure here that is not cosmetic.
  {
    const paint = parseDialogPack(
      {
        npcs: [
          {
            id: 'n',
            x: 0,
            z: 0,
            nodes: [
              {
                id: 'a',
                line: 'nice weather',
                improv: { persona: 'a bored clerk', context: 'the queue is long' },
                choices: [{ text: 'mm', goto: 'a' }],
              },
            ],
          },
        ],
      },
      'fixture',
    );
    if (paint.value.npcs.length !== 1) failures.push(`A cosmetic improv node was refused: ${paint.errors.join('; ')}`);
    if (paint.value.npcs[0]?.nodes[0].improv?.persona !== 'a bored clerk') failures.push('An improv persona was dropped.');

    for (const [field, value] of [['accept', 'q'], ['turnin', 'q'], ['cost', 25]] as Array<[string, unknown]>) {
      const decides = parseDialogPack(
        {
          npcs: [
            {
              id: 'n',
              x: 0,
              z: 0,
              nodes: [
                {
                  id: 'a',
                  line: 'nice weather',
                  improv: { persona: 'a clerk', context: '' },
                  choices: [{ text: 'go on then', needCash: 1000, [field]: value }],
                },
              ],
            },
          ],
        },
        'fixture',
      );
      if (decides.value.npcs.length !== 0) {
        failures.push(`An improv node carrying "${field}" was accepted. The AI paints; the data decides.`);
      }
    }
    // An improv block with no persona is a prompt with nothing in it.
    const empty = parseDialogPack(
      { npcs: [{ id: 'n', x: 0, z: 0, nodes: [{ id: 'a', line: 'hi', improv: { context: 'x' } }] }] },
      'fixture',
    );
    if (empty.value.npcs.length !== 0) failures.push('An improv block with no persona was accepted.');
    // And a node marked improv must still carry an authored line, because that
    // is what serves with no key set -- the ordinary configuration.
    const noLine = parseDialogPack(
      { npcs: [{ id: 'n', x: 0, z: 0, nodes: [{ id: 'a', line: '', improv: { persona: 'a clerk' } }] }] },
      'fixture',
    );
    if (noLine.value.npcs.length !== 0) failures.push('An improv node with no authored fallback line was accepted.');
  }

  // --- What comes back from the model, made safe to draw.
  {
    const cases: Array<[unknown, string]> = [
      [null, ''],
      [42, ''],
      ['  hello  ', 'hello'],
      ['a\nb\nc', 'a b c'],
      ['<b>bold</b>', 'bold'],
      ['<script>alert(1)</script>', 'alert(1)'],
      ['a\x00b', 'a b'],
    ];
    for (const [raw, want] of cases) {
      const got = clampImprov(raw);
      if (got !== want) failures.push(`clampImprov(${JSON.stringify(raw)}) is ${JSON.stringify(got)}, not ${JSON.stringify(want)}.`);
    }
    const long = clampImprov('x'.repeat(5000));
    if ([...long].length > MAX_IMPROV_CHARS) failures.push(`A ${long.length}-character improv line survived the clamp.`);
  }

  // --- The gates on a choice, which are the same shape as the quest's.
  {
    const npc = parseDialogPack(
      {
        npcs: [
          {
            id: 'n',
            x: 0,
            z: 0,
            nodes: [
              {
                id: 'a',
                line: 'hi',
                choices: [
                  { text: 'plain' },
                  { text: 'gated', needLevel: 5 },
                  { text: 'sided', needFaction: 'Marita' },
                  { text: 'flagged', needFlag: 'act0:in' },
                  { text: 'closed', denyFlag: 'act0:out' },
                  { text: 'bribe', needCash: 50, cost: 50 },
                ],
              },
            ],
          },
        ],
      },
      'fixture',
    ).value.npcs[0];
    if (!npc) {
      failures.push('The choice-gate fixture did not parse.');
    } else {
      const [plain, gated, sided, flagged, closed, bribe] = npc.nodes[0].choices;
      const poor: PlayerFacts = { level: 1, faction: '', story: new Set(), cash: 0 };
      const rich: PlayerFacts = { level: 9, faction: 'Marita', story: new Set(['act0:in']), cash: 500 };
      if (choiceRefusal(plain, poor) !== '') failures.push('An ungated choice was refused.');
      if (choiceRefusal(gated, poor) === '') failures.push('A level-5 choice was offered at level 1.');
      if (choiceRefusal(gated, rich) !== '') failures.push('A level-5 choice was refused at level 9.');
      if (choiceRefusal(sided, poor) === '') failures.push('A Marita choice was offered to nobody.');
      if (choiceRefusal(sided, rich) !== '') failures.push('A Marita choice was refused to Marita.');
      if (choiceRefusal(flagged, poor) === '') failures.push('A flag-gated choice was offered without the flag.');
      if (choiceRefusal(flagged, rich) !== '') failures.push('A flag-gated choice was refused with the flag.');
      if (choiceRefusal(closed, rich) !== '') failures.push('A deny-flag choice was refused without the flag.');
      if (choiceRefusal(closed, { ...rich, story: new Set(['act0:out']) }) === '') {
        failures.push('A deny-flag choice was offered with the flag set.');
      }
      if (choiceRefusal(bribe, poor) === '') failures.push('A $50 bribe was offered to somebody with nothing.');
      if (choiceRefusal(bribe, rich) !== '') failures.push('A $50 bribe was refused to somebody with $500.');
    }
  }

  return failures;
}
