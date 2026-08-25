/**
 * The seventh mushroom: a conversation, and a verdict the model actually makes.
 *
 * ---------------------------------------------------------------------------
 * ## The model decides, and the owner asked for that on purpose
 *
 * Every other model call in this project paints and never decides --
 * `server/quests.ts`'s header sets that rule out at length, and it is the right
 * rule for a line of NPC dialogue that arrives from a third party. This is the
 * one deliberate exception. The owner was told plainly that a model which can
 * grant a permanent 2x health buff is a model that can be *talked into* it, and
 * his answer was "yea i want the model to be convincable". So it is: God listens,
 * God is argued with, and God's verdict is the decision.
 *
 * What is *not* the model's is the bookkeeping, and none of that is
 * second-guessing the verdict:
 *
 *   - **The server writes the flag.** A client cannot claim a blessing it was
 *     not given, because the client is never the thing that records it.
 *   - **Once per week.** That is the owner's own rule -- the buff "lasts till
 *     weekly reset" -- so a granted week is a spent week, and a player cannot
 *     re-roll God until he says yes.
 *   - **A bounded conversation.** `MAX_TURNS` exists because an unbounded chat
 *     against a paid endpoint is a bill, not because a long argument is
 *     illegitimate.
 *
 * ## The verdict is a token, not a vibe
 *
 * The model is asked to end its reply with a bare marker when it has made up its
 * mind, and the server reads only that. A reply that merely *sounds* approving
 * grants nothing. This is not a check on God's judgement -- God may say the word
 * on the first turn if the player deserves it -- it is the difference between a
 * decision and a coincidence of adjectives.
 */

import { fxSetDoubleHealth } from '../client/src/game/teamfx.ts';

/** The most exchanges before God has heard enough. */
export const MAX_TURNS = 12;

/** What a player may type at once. Longer is trimmed, not refused. */
export const MAX_UTTERANCE = 400;

/** The marker God ends on when the mind is made up. */
export const GRANT_TOKEN = '[[BLESSED]]';
export const REFUSE_TOKEN = '[[NOT YET]]';

export type GodVerdict = 'open' | 'blessed' | 'refused';

export interface GodTurn {
  who: 'player' | 'god';
  text: string;
}

/**
 * The brief.
 *
 * Written so the model has a *position* to be argued out of rather than a
 * disposition to agree: a God who blesses whoever turns up is not a
 * conversation, and the buff would be a formality with extra steps. The player
 * has to say something.
 */
export function godPrompt(): string {
  return [
    'You are God, met by somebody who has eaten seven mushrooms in a Sydney national park.',
    'You are vast, calm, amused, and completely uninterested in flattery.',
    'Speak in two or three sentences at a time. Never use lists. Never break character.',
    '',
    'You are deciding one thing: whether this person is good.',
    'You are genuinely persuadable, and you start unconvinced. Ask them things.',
    'Being told you are great is not evidence. What they have done, and what they',
    'regret, and what they would do for somebody who could not repay them, is.',
    '',
    `When you are convinced they are good, end your reply with ${GRANT_TOKEN} on its own.`,
    `If you become certain they are not, end your reply with ${REFUSE_TOKEN} on its own.`,
    'Until you are sure, end with neither and keep talking.',
  ].join('\n');
}

/** What the model said, split into what the player reads and what it decided. */
export function readVerdict(reply: string): { text: string; verdict: GodVerdict } {
  const blessed = reply.includes(GRANT_TOKEN);
  const refused = reply.includes(REFUSE_TOKEN);
  const text = reply.split(GRANT_TOKEN).join('').split(REFUSE_TOKEN).join('').trim();
  // Both tokens is a confused reply and is not a grant: the burden is on the
  // model to be clear, and the safe reading of "maybe" is "not yet".
  if (blessed && !refused) return { text, verdict: 'blessed' };
  if (refused) return { text, verdict: 'refused' };
  return { text, verdict: 'open' };
}

/** One player's audience with God. */
export class Audience {
  readonly turns: GodTurn[] = [];
  verdict: GodVerdict = 'open';

  /** True once there is nothing left to say. */
  get closed(): boolean {
    return this.verdict !== 'open' || this.turns.filter((t) => t.who === 'player').length >= MAX_TURNS;
  }

  say(who: 'player' | 'god', text: string): void {
    this.turns.push({ who, text: text.slice(0, MAX_UTTERANCE) });
  }

  /** The messages for the endpoint: the brief, then the exchange. */
  messages(): Array<{ role: string; content: string }> {
    return [
      { role: 'system', content: godPrompt() },
      ...this.turns.map((t) => ({ role: t.who === 'player' ? 'user' : 'assistant', content: t.text })),
    ];
  }
}

/**
 * Grant the blessing, if this week has not already had one.
 *
 * The record is the authority and the caller is not: this returns whether the
 * grant actually happened, so a caller cannot report a blessing the week had
 * already spent.
 */
export interface BlessRecord {
  /** ISO week the last blessing was granted in, or ''. */
  blessedWeek: string;
}

export function weekKey(nowMs: number): string {
  // Monday-based, matching the ladder's reset. A blessing is a week's blessing.
  const d = new Date(nowMs);
  const day = (d.getUTCDay() + 6) % 7;
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
  return new Date(monday).toISOString().slice(0, 10);
}

export function bless(record: BlessRecord, playerId: number, nowMs: number): boolean {
  const week = weekKey(nowMs);
  if (record.blessedWeek === week) return false;
  record.blessedWeek = week;
  fxSetDoubleHealth(playerId, true);
  return true;
}

/** Monday swept the ladder; it sweeps this too. */
export function unbless(record: BlessRecord, playerId: number, nowMs: number): void {
  if (record.blessedWeek !== weekKey(nowMs)) {
    record.blessedWeek = '';
    fxSetDoubleHealth(playerId, false);
  }
}

/**
 * Ask God, over the same endpoint the improv lines use.
 *
 * Returns the reply and the verdict. A `null` reply is "the endpoint did not
 * answer" -- which the caller shows as silence rather than as an error, because
 * God being briefly unreachable is in character and a stack trace is not.
 */
export async function askGod(
  audience: Audience,
  cfg: { url: string; key: string; model: string; fetchImpl?: typeof fetch },
): Promise<{ text: string; verdict: GodVerdict } | null> {
  if (cfg.url === '' || cfg.key === '') return null;
  const f = cfg.fetchImpl ?? fetch;
  try {
    const res = await f(`${cfg.url.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: audience.messages(),
        max_tokens: 180,
        temperature: 0.85,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = body.choices?.[0]?.message?.content ?? '';
    if (raw === '') return null;
    return readVerdict(raw);
  } catch {
    return null;
  }
}

export function verifyGod(): string[] {
  const failures: string[] = [];

  // --- The verdict is a token and nothing else.
  {
    const warm = readVerdict('You have a kind face and I like you very much.');
    if (warm.verdict !== 'open') failures.push('An approving sentence granted a blessing; the verdict is a token, not a mood.');
    const yes = readVerdict(`Then go, and be what you said you were.\n${GRANT_TOKEN}`);
    if (yes.verdict !== 'blessed') failures.push('God said the word and was not heard.');
    if (yes.text.includes('[[')) failures.push('The marker was shown to the player.');
    if (!yes.text.startsWith('Then go')) failures.push('Stripping the marker damaged the line.');
    const no = readVerdict(`I have heard enough.\n${REFUSE_TOKEN}`);
    if (no.verdict !== 'refused') failures.push('A refusal did not read as one.');
    const both = readVerdict(`${GRANT_TOKEN} ${REFUSE_TOKEN}`);
    if (both.verdict === 'blessed') failures.push('A confused reply granted the buff; "maybe" reads as "not yet".');
  }

  // --- The brief starts God unconvinced and persuadable, which is the ask.
  {
    const p = godPrompt();
    if (!/persuadable|convinced/i.test(p)) failures.push('The brief does not tell God to be persuadable; the owner asked for convincible.');
    if (!/start(s)? unconvinced/i.test(p)) failures.push('The brief does not start God unconvinced, so the buff is a formality.');
    if (!p.includes(GRANT_TOKEN) || !p.includes(REFUSE_TOKEN)) failures.push('The brief does not tell God how to decide.');
  }

  // --- The conversation is bounded, and closes on a verdict.
  {
    const a = new Audience();
    for (let i = 0; i < MAX_TURNS - 1; i++) a.say('player', 'hello');
    if (a.closed) failures.push('The audience closed early.');
    a.say('player', 'hello');
    if (!a.closed) failures.push(`The audience ran past ${MAX_TURNS} turns.`);
    const b = new Audience();
    b.verdict = 'blessed';
    if (!b.closed) failures.push('A decided audience stayed open.');
    // A long speech is trimmed rather than refused: a player mid-argument should
    // not lose their turn to a character count.
    const c = new Audience();
    c.say('player', 'x'.repeat(MAX_UTTERANCE * 3));
    if (c.turns[0].text.length !== MAX_UTTERANCE) failures.push('A long utterance was not trimmed to the cap.');
  }

  // --- The messages carry the brief first and the exchange in order.
  {
    const a = new Audience();
    a.say('player', 'am i good');
    a.say('god', 'you tell me');
    const m = a.messages();
    if (m[0].role !== 'system') failures.push('The brief is not the first message.');
    if (m[1].content !== 'am i good' || m[2].role !== 'assistant') failures.push('The exchange is out of order or misattributed.');
  }

  // --- One blessing a week, and Monday takes it back.
  {
    const rec: BlessRecord = { blessedWeek: '' };
    const monday = Date.parse('2026-08-24T10:00:00Z');
    if (!bless(rec, 4242, monday)) failures.push('The first blessing of the week was refused.');
    if (bless(rec, 4242, monday + 3_600_000)) failures.push('A second blessing was granted in the same week.');
    const nextWeek = monday + 7 * 86_400_000;
    unbless(rec, 4242, nextWeek);
    if (rec.blessedWeek !== '') failures.push('Monday did not sweep the blessing.');
    if (!bless(rec, 4242, nextWeek)) failures.push('A new week refused a new blessing.');
  }

  // --- The week key is Monday-based, so a Sunday and its Monday differ.
  {
    const sun = weekKey(Date.parse('2026-08-23T23:00:00Z'));
    const mon = weekKey(Date.parse('2026-08-24T01:00:00Z'));
    if (sun === mon) failures.push('Sunday and Monday fell in the same week; the reset would not land.');
    const monLate = weekKey(Date.parse('2026-08-30T23:00:00Z'));
    if (mon !== monLate) failures.push('A Monday and the Sunday after it are not one week.');
  }

  return failures;
}
