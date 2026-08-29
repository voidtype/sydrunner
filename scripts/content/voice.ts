/*
 * voice.ts -- the three pools that make two generators stop sounding like one.
 *
 * A generated blurb is `opening + core + aside + ask`. The **core** is the
 * generator's own -- `hub-gen.ts` writes one per beat, `field-gen.ts` one per
 * archetype -- and carries the situation and the place. These three carry the
 * variation, and they are here rather than in either file because both files
 * need them and two copies would drift into two voices.
 *
 * ## Why three pools and not one longer core
 *
 * `quest-quality.ts` rule 3 compares five-word windows. A differing word breaks
 * up to five of them, so what defeats repetition is not length -- it is
 * *differences spread through the sentence*. One pool at the front leaves the
 * whole middle and end matching; two leaves the middle. Three splits a thirty-
 * word blurb into four spans of which three vary independently.
 *
 * That is not a guess. `field-gen.ts` shipped with one pool's worth of variation
 * and 421 of its 500 quests shared more than half a sentence with another one.
 * The aside was added after measuring the two-pool version at 63%.
 *
 * ## They must attach to anything
 *
 * Any opening precedes any of a hundred and fifty cores; any aside follows one.
 * So nothing in here may name a place, a person, a trade or a number, and
 * nothing may assume what the sentence before it was about. They are all the
 * same voice: somebody in Sydney who wants a favour and is slightly embarrassed
 * about asking.
 *
 * ## Assigned, not sampled
 *
 * Callers index these with strides coprime to 24 off the *instance number* of
 * the thing being written, rather than sampling them at random or off a global
 * counter. Random gives collisions at the birthday rate; a global counter gives
 * the bug that produced this file's second paragraph, where two instances of one
 * beat sat exactly seventy-two quests apart and twenty-four divides seventy-two.
 */

export const OPENINGS = [
  'Not being dramatic about this.',
  'You look like you have twenty minutes.',
  "I'll be straight with you.",
  'Right. Since you asked.',
  'Nobody else has offered, so.',
  'This is going to sound small.',
  'I have been putting it off since Easter.',
  'Do not laugh.',
  'It is not a police matter and I have checked.',
  'Two people have already said no.',
  'I would do it myself if I could leave the counter.',
  'You are the first person to stop all morning.',
  'There is no clever way to say this.',
  'I am told you do odd jobs.',
  'Keep it between us for now.',
  'It has been three weeks.',
  'My knees are gone, so.',
  'The council knows and the council does not care.',
  'I have written it down twice and lost it twice.',
  'Before you say anything: yes, I know.',
  'It is the sort of thing you notice or you do not.',
  'Honestly, I am past caring how it looks.',
  'Someone has to, and it may as well be you.',
  'You will think I am making this up.',
];

export const ASIDES = [
  'I am aware how that sounds.',
  'It has been going on longer than I have admitted to anyone.',
  'Nobody else seems to have noticed, which is its own problem.',
  'I would have sorted it myself a year ago.',
  'There is probably a simple explanation and I would love to hear it.',
  'My wife says I should let it go. My wife is wrong.',
  'I have got no proof, which is exactly why I am asking.',
  'Everyone I have told has looked at me the way you are now.',
  'It is not the money. It has stopped being the money.',
  'You will see what I mean the second you get there.',
  'I have rung the number on the letter four times.',
  'It might be nothing. It has not felt like nothing.',
  'This is the third time I have had this conversation.',
  'I did try the official route, for what that was worth.',
  'There is a version of this where I am the unreasonable one.',
  'Half the street knows and half the street is pretending not to.',
  'I would not ask if there was anyone else about.',
  'It started small, the way these things do.',
  'I have got a photo on my phone but it is useless.',
  'The paperwork says one thing and my eyes say another.',
  'I am not after trouble. I am after an answer.',
  'You can tell me I am imagining it. Tell me after.',
  'It is the not knowing that has got me, honestly.',
];

export const ASKS = [
  'Come back and tell me straight.',
  "I'll see you right for it.",
  'Take your time. Do not take a week.',
  "There's cash in it. Not a lot.",
  'Say nothing to anyone on the way.',
  "If it's nothing, it's nothing. Tell me anyway.",
  'I would rather know than wonder.',
  "Do that and we're square.",
  "I'll put the kettle on for when you're back.",
  'Come and find me after, either way.',
  "You'll know it when you see it.",
  'Do not make a scene about it.',
  'If anyone asks, you were never here.',
  "That's the whole job. No catch.",
  'I will owe you one, and I pay those.',
  'Just do not come back empty-handed.',
  'Whatever you find, bring it to me first.',
  "Half now if you want it. Most people don't.",
  'Ask for me by name at the counter.',
  'There is no rush, but there is a Friday.',
  'Be polite about it. It costs nothing.',
  'Do not let them talk you into anything.',
  'I will know if you skipped a bit.',
  "That's it. That's the whole ask.",
  'Whatever it costs you, tell me and I will cover it.',
];

/**
 * The three, chosen for instance `n` of a template.
 *
 * `salt` separates two templates in the same generator, so beat 0 and beat 3 of
 * one situation -- written for the same hub and therefore the same instance
 * number -- do not open with the same words.
 *
 * **The three pools are 24, 23 and 25 long, and that is the whole mechanism.**
 * They were all 24 to begin with, and every stride coprime with 24 has period
 * exactly 24, so instance 3 and instance 27 of one archetype drew the identical
 * triple and read at 92% overlap. Three coprime lengths give the *combination* a
 * period of 24 x 23 x 25 = 13,800, which is seven times more quests than this
 * city holds, while consecutive instances still move all three.
 *
 * That is the second time this shape of bug has been found by the gate rather
 * than by reasoning, which is the argument for having the gate.
 */
export function voiceFor(n: number, salt: number): { opening: string; aside: string; ask: string } {
  return {
    opening: OPENINGS[(n * 5 + salt * 13) % OPENINGS.length],
    aside: ASIDES[(n * 7 + salt * 5) % ASIDES.length],
    ask: ASKS[(n * 11 + salt * 7) % ASKS.length],
  };
}

/** Sentence-cased, because a slot can open a sentence and `a bloke` cannot. */
export function cased(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1).replace(/([.!?] )([a-z])/g, (_m, p, ch) => p + ch.toUpperCase());
}

/**
 * The finished blurb: opening, core, aside, ask -- with the aside *inside* the
 * core where the core has room for it.
 *
 * This is the last thing measurement changed, and it changed the most for the
 * least. `field-gen.ts`'s cores are three and four sentences long, so the voice
 * around them is a quarter of the blurb and two instances sharing a core matched
 * on 52% of their five-word windows -- over the line, with nothing obviously
 * wrong with either sentence.
 *
 * Putting the aside after the core's **first sentence** rather than after all of
 * them splits one long matching run into two, and the four windows that spanned
 * the join stop matching. 52% becomes 45%. That is the entire fix: not more
 * words, the same words in a better order.
 *
 * It also reads better, which is the part that should have suggested it first.
 * An aside is a thing somebody says in the middle of explaining, not a sentence
 * they add once they have finished.
 *
 * A single-sentence core -- `hub-gen.ts`'s -- has nowhere to splice, and gets
 * the aside on the end, where a single sentence wants it anyway.
 */
export function weave(core: string, voice: { opening: string; aside: string; ask: string }): string {
  const cut = core.search(/[.!?] /);
  const body =
    cut < 0 || cut + 2 >= core.length
      ? `${core} ${voice.aside}`
      : `${core.slice(0, cut + 1)} ${voice.aside}${core.slice(cut + 1)}`;
  return cased(`${voice.opening} ${body} ${voice.ask}`);
}
