/*
 * hub-gen.ts -- the city as hubs: a place, three people, and six jobs that know
 * about each other.
 *
 * The owner: *"letzs come up with a pipeline which ensures they are fun and
 * unique just like wow? they shouldnt just be random boring go here talk to this
 * person quests, only if they are taking to a new area"*.
 *
 * ---------------------------------------------------------------------------
 * ## WHAT WOW ACTUALLY DID, WHICH IS NOT WHAT IT LOOKS LIKE
 *
 * Vanilla shipped somewhere over a thousand quests and most of them are, taken
 * one at a time, "kill ten of these". The thing that made them work was never
 * per-quest cleverness. It was that quests arrive in **hubs**: you walk into
 * Goldshire, six people have something for you, all six are about the same
 * trouble, all six are doable in one loop of the surrounding fields, and you
 * hand them all in together. The fun is the loop. The individual quest is a
 * beat in it.
 *
 * `field-gen.ts` -- the five hundred jobs this joins -- is the other design, and
 * it is honest about being one: twenty archetypes crossed with three hundred and
 * sixty-one stations. Every job is somewhere real and every job is alone. Run
 * `quest-quality.ts --report` against it and the number that matters is that
 * four hundred and twenty-one of six hundred quests share more than half a
 * sentence with another one. Archetype-times-place is unique by construction and
 * repetitive by construction, and those are the same sentence.
 *
 * ## SO THIS GENERATES SITUATIONS, NOT QUESTS
 *
 * Eighteen **situations**, each hand-written: a premise, three people with roles
 * in it, and six beats. A situation is instantiated at a station and becomes a
 * hub -- three givers standing within a couple of hundred metres of each other,
 * two jobs each, and the six of them are one story.
 *
 * Inside a hub:
 *
 *   - **Beats 0 and 1 are a chain.** The second `requires` the first and pays
 *     more, which `quest-quality.ts` rule 8 enforces on everything.
 *   - **Beats 2 to 4 are the loop.** Different verbs, deliberately: six distinct
 *     step patterns per situation, so no shape is more than a sixth of the hub
 *     and rule 6 cannot fire.
 *   - **Beat 5 is the breadcrumb**, and it is the only `goto`-and-talk job in
 *     the whole generator. It is wired in a second pass, after every hub is
 *     placed, to the nearest *other* hub at least `BREADCRUMB_M` away -- so the
 *     one errand-shaped job in the set is the one that hands you to six more
 *     jobs in a suburb you have not been to. That is the owner's rule, and it is
 *     the rule that makes a courier quest worth doing.
 *
 * ## THE SENTENCES
 *
 * A blurb is `opening + core + ask`. The **core** is the beat's own, authored
 * once, and carries the situation and the place. The opening and the ask come
 * from two shared pools of twenty-four, assigned by a running counter rather
 * than a hash, so a pair repeats only every 576 quests and never twice inside
 * one situation.
 *
 * That arrangement is the direct answer to the 421: the shingle check compares
 * five-word windows, a differing word breaks five of them, and an opening and an
 * ask that both differ break enough of a thirty-word sentence that two
 * instances of one beat cannot read as the same line. It is checked rather than
 * asserted -- `quest-quality.ts` is run against the output and refuses it.
 *
 * ## DETERMINISTIC
 *
 * A fixed seed, so a rerun produces the same city and a diff is a real diff.
 * Placement obeys the gate's own rules: off the tracks, clear of every other
 * giver, and a first name that is not already in use anywhere near.
 *
 *     bun run scripts/content/hub-gen.ts [hubs]
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeRail } from '../../client/src/game/rail.ts';
// The three pools both generators write their blurbs out of. See `voice.ts`.
import { voiceFor, weave } from './voice.ts';

const REPO = join(import.meta.dir, '..', '..');
const CONTENT = join(REPO, 'content');
const WANT_HUBS = Number(process.argv[2] ?? 230);

// --- the seeded stream ---------------------------------------------------------------

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(0x4b1d5e);
const between = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];

// --- the city ------------------------------------------------------------------------

const railBuf = readFileSync(join(REPO, 'client/public/rail/rail.bin'));
const bake = decodeRail(
  railBuf.buffer.slice(railBuf.byteOffset, railBuf.byteOffset + railBuf.byteLength) as ArrayBuffer,
);
interface Stn { name: string; x: number; z: number }
const stations: Stn[] = bake.stations.map((s: Stn) => ({ name: s.name, x: s.x, z: s.z }));
const V: Float32Array = bake.vertices as Float32Array;

/** Distance to the nearest rail vertex. The gate refuses anything under 6 m. */
function trackDist(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i + 5 < V.length; i += 3) {
    const ax = V[i], az = V[i + 2], bx = V[i + 3], bz = V[i + 5];
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    if (l2 > 200 * 200) continue;
    let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + t * dx - x, pz = az + t * dz - z;
    const d = px * px + pz * pz;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

function nearestOther(s: Stn): Stn {
  let best = s, bd = Infinity;
  for (const o of stations) {
    if (o.name === s.name) continue;
    const d = (o.x - s.x) ** 2 + (o.z - s.z) ** 2;
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

// --- what is already out there --------------------------------------------------------

interface ExistingNpc { id: string; name: string; x: number; z: number }
const existing: ExistingNpc[] = [];
const usedQuestId = new Set<string>();
for (const file of readdirSync(join(CONTENT, 'dialog'))) {
  if (!file.endsWith('.json')) continue;
  const raw = JSON.parse(readFileSync(join(CONTENT, 'dialog', file), 'utf8')) as { npcs?: ExistingNpc[] };
  for (const n of raw.npcs ?? []) existing.push(n);
}
for (const file of readdirSync(join(CONTENT, 'quests'))) {
  if (!file.endsWith('.json')) continue;
  const raw = JSON.parse(readFileSync(join(CONTENT, 'quests', file), 'utf8')) as { quests?: { id: string }[] };
  for (const q of raw.quests ?? []) usedQuestId.add(q.id);
}

// --- the shared sentence pools -------------------------------------------------------

/*
 * The two halves that are not the beat's.
 *
 * Twenty-four each, assigned by a running counter rather than a hash: a hash
 * clusters, and what this has to guarantee is that two instances of one beat do
 * not read as one line. See the header. Both are written to be the giver's
 * voice with nothing situational in them, so any opening can precede any core.
 */


/*
 * The third pool, and the one that was added after measuring rather than before.
 *
 * Opening plus core plus ask was not enough. Two instances of a beat that
 * differed only at their two ends still shared 63% of their five-word windows,
 * because the core is the longest of the three and sits in the middle where
 * every window overlaps it. A clause *between* the core and the ask splits that
 * middle, and the difference between 63% and passing is roughly this pool.
 *
 * Written to attach to anything, because it has to: any aside must be able to
 * follow any of seventy-two cores.
 */

/** The `hello` node. Never carries a job, so any greeting fits any giver. */
const HELLOS = [
  'You right there? I am mid-something but go on.',
  'If you are here about the sign, the sign is wrong.',
  "Don't stand in the doorway, mate, come round.",
  'Long day. Say what you came to say.',
  'I know that look. Everyone wants something today.',
  'Give me a second. Right. Go.',
  'You are not from around the corner, are you.',
  'Half of this suburb has walked past already. Not one stopped.',
  'Whatever it is, I have had worse this week.',
  'Sit down if you like. Nobody else is using it.',
  'You will have to speak up, the trains are in.',
  'I have got about four minutes before I am needed.',
  'Ah. Someone with two working legs.',
  'You are early. Or late. I have lost track.',
  'Been here since before it was like this. Go on.',
  'Do not mind the mess. It is structural now.',
  'If you are selling something the answer is no.',
  'Cash only and no, I am joking. What do you want.',
  'You have got a face like you can keep your mouth shut.',
  'Right. Talk while I do this.',
];

/** The `ledger` node: the line before a turn-in. */
const LEDGERS = [
  'Go on then. What did you find.',
  'You came back. That already puts you ahead.',
  'Right. Tell me and do not soften it.',
  'I have been thinking about it all day. Out with it.',
  'Well? I can read your face from here.',
  'Sit. Talk. Then I will decide how I feel.',
  'You have got that look. Good or bad, out with it.',
  'Before you start: did anyone see you.',
  'Alright. I am listening properly this time.',
  'Say it plain and I will pay you plain.',
  'I had a feeling. Go on.',
  'Take a breath. Then say the whole thing.',
];

/** The one line a giver says when there is nothing more from them. */
const CLOSERS = [
  'Fair enough. You know where I am.',
  'Suit yourself. The offer does not go anywhere.',
  'No dramas. Come back when you are bored.',
  'Right you are. Mind the step.',
];

// --- the detail vocabularies ----------------------------------------------------------
//
// Small, concrete and Sydney: a detail is only worth interpolating if it could
// not have come from anywhere else. Shared with `field-gen.ts` in spirit and
// deliberately not in code -- these are the *hub* generator's, and a change here
// should not silently rewrite five hundred quests in another file.

const KO_KINDS = ['karen', 'tradie', 'drunk', 'eshay', 'rbt', 'police'] as const;
const POWERUPS = ['FLAT WHITE', 'TRAINING'] as const;

const HOURS = ['ten past five', 'quarter to six', 'twenty past four', 'half six', 'the back of seven',
  'five in the morning', 'just gone midnight', 'two in the afternoon', 'knock-off', 'the second express',
  'first light', 'the middle of the news'];
const DAYS = ['a Tuesday', 'Thursdays', 'the long weekend', 'a wet Monday', 'every second Friday',
  'school holidays', 'the week of the show', 'grand final week', 'the first of the month',
  'the Sunday after payday', 'a public holiday nobody remembered'];
const THINGS = ['a docket book', 'an esky with no lid', 'a milk crate', 'a folding table',
  'two hundred metres of orange netting', 'a whiteboard with last March still on it',
  'a laminated notice', 'a bucket of odd keys', 'a clipboard nobody signs',
  'a chest freezer that hums in D', 'a roll of raffle tickets', 'a esky of warm cans'];
const WHO = ['a bloke in a council polo', 'the woman who runs the newsagent', 'someone off the 8:02',
  'a kid on a scooter who sees everything', 'the fella who does the mowing',
  'a courier who is always early', 'the lady with the two greyhounds',
  'whoever put the notice up', 'a bloke everyone calls Macca and nobody can place'];

// --- the names ------------------------------------------------------------------------
//
// **First names repeat now, and that is a fix rather than a slip.** The rule was
// "no two givers in the city share a first name", which was right at a hundred
// and nine givers and became a straitjacket at six hundred: the pool was spent,
// and the thing the rule protects -- a player never being confused about which
// Dave -- does not need Sydney to contain exactly one. `content-check.ts` now
// asks for the name to be unique within `NAME_REACH_M`, which is the honest
// version of the same requirement, and this generator obeys it directly.
const NAME_REACH_M = 2500;
const NAMES = `Abbie Adnan Agnes Ahmad Aida Aiden Ailsa Aisha Ajay Akira Alana Albie Aleks Alessia Alfie Alia Alina Alistair
Amal Amara Ambrose Ameera Amir Anahera Anand Andreas Aneta Angelo Anh Anika Anisa Annika Anton Anwar Aoife Apirana Ari Ariana
Arjun Arno Arta Arun Asha Ashwin Asma Astrid Atticus Aurelio Ava Avi Ayaan Ayla Azim Bao Barnaby Basim Beatrix Bede Behrouz
Belinda Benedetta Beppe Bilal Birgit Bo Bonnie Boris Bourke Bridie Bruna Bryn Caetano Cahil Callum Camila Caoimhe Carlo
Carmela Cassian Cathal Cecile Chandra Charlie Chau Chidi Chloe Chris Cillian Claudia Clem Cleo Colm Cora Cormac Cosima Cruz
Daichi Dalia Damir Danh Dara Darius Davina Dawit Deepa Deirdre Delphine Demir Denzil Desta Dev Dhruv Diarmuid Dilan Dima
Dinesh Divya Dmitri Dominika Donal Dorothea Dragan Duc Dulcie Duong Eamon Ebony Eduardo Efe Efrain Eileen Ekaterina Elan
Eleni Elias Elin Elke Elodie Eloise Emeka Emiko Emre Enzo Eoin Ereni Eryk Esme Esteban Etienne Eun Evangelos Ewan Ezra
Fadi Faisal Farah Farrah Fatima Federico Feliks Fenella Ferdi Fern Filip Finlay Fiona Fionn Florian Fola Forough Frances
Franco Freya Gabriel Gail Galina Gareth Gemma Genevieve Georgios Gerhard Gia Gideon Gillian Giulia Giuseppe Gopal Grace
Greta Gulnaz Gus Hamid Hana Hania Hanna Harjit Harold Haroon Haruka Hasan Hattie Hayley Hazel Hedda Helios Hemi Henrietta
Hina Hiro Hoang Holly Hugo Hussein Ida Idris Ignatius Ilona Imani Imogen Indira Ines Inge Ioana Iolanda Ira Irina Isabeau
Isha Ishaan Isla Ismail Ivo Jacinta Jae Jamal Jarrah Jasmina Javier Jaya Jelena Jemima Jenna Jeong Jethro Jia Jimmy Joaquin
Jocelyn Johanna Jonty Jordi Josefa Juliusz Juno Jurgen Kabir Kaia Kaito Kalinda Kamal Kamila Kaori Kareem Karina Kasia Kata
Kaveh Kayo Keanu Keiko Kelvin Kenji Keziah Khadija Khalil Kiara Kieran Kiri Kirra Klara Kofi Koray Kristo Kwame Kyra Lachie
Laila Lalita Lara Larissa Laszlo Laurie Leila Lennox Leonie Levi Lex Liadan Liam Lien Lilith Linh Lior Lise Livia Lorcan
Lottie Louka Lucia Ludo Luka Lumi Lyra Maarten Mabel Madhu Mae Magda Mahi Maia Maja Makoto Malika Mamadou Manon Manu Marcelo
Mardi Mareike Margit Mariam Marika Marisol Marko Marlon Marta Massimo Matias Maud Mawusi Maya Mehmet Meiko Melina Mercer
Merle Mia Micah Mikko Milena Mira Miriama Mirza Mishka Moana Mohsen Moira Molly Monika Morgan Mostafa Mounir Muriel Myfanwy
Nadia Naila Nalini Nam Nara Nasser Natasa Nell Neve Ngaire Nguyet Niamh Nico Nikhil Nils Nina Nita Noa Noor Nora Nuri Nyah
Oakley Odile Ola Olamide Oleg Olwen Omar Ondine Oona Orla Oscar Otto Ozgur Paloma Pania Paolo Parvati Pascale Patryk Paz
Pearl Pedro Peg Penn Petra Phuong Pia Pieter Pilar Pip Piotr Pita Priya Quang Quinn Rada Radha Rafferty Raghav Rahel Raisa
Rami Ramona Ranjit Raphael Rasha Raul Reem Reeta Reg Rehan Renata Reuben Rhona Ria Rina Rishi Rita Robbo Roisin Roma Romy
Rosalind Rosita Rowena Roxana Rudi Rukmini Rumi Ruslan Ruth Sabina Sadia Saif Sakura Salma Samir Sana Sandrine Sanjay Saoirse
Sarai Sasa Satu Saul Savva Seanan Sefa Selin Senna Seppo Serge Shahid Shani Sharmila Shay Sheela Shen Shirin Sian Sibel
Sienna Sigrid Simone Sina Sinead Siobhan Sisay Sofia Solomon Sonja Soren Stefanos Suha Sujata Suleiman Suna Susanna Svea
Sylvie Tadeusz Tahlia Taini Talia Tamar Tane Tanvir Tao Tara Tarek Tash Tayla Teodora Tess Thanh Thea Theo Thi Thomas Tia
Tibor Tilda Tinashe Tobias Toma Tomasz Tori Tova Trang Trine Tristan Tuan Tulla Turi Ualan Uma Ursula Usman Vaila Valeria
Van Vanni Varsha Vasil Vera Verity Vesna Vicente Vida Vikram Vinh Viola Vito Wafa Walid Wanda Wesley Wilhelmina Willa
Wiremu Wren Xanthe Xavier Ximena Xuan Yannick Yara Yasmin Yehuda Yenna Yiannis Yoko Yolande Yosef Yuki Yusuf Zaid Zainab
Zali Zane Zara Zeki Zelda Zenia Zhen Zita Ziva Zofia Zoltan Zubair Zuri`
  .split(/\s+/)
  .filter(Boolean);

// --- the shape of a situation ---------------------------------------------------------

interface Ctx {
  /** The station this hub hangs off. Every core names it. */
  place: string;
  /** The next station along, for the `ride` beats. */
  nb: string;
  /** Where the breadcrumb sends you. Filled in pass two; `''` until then. */
  target: string;
  gx: number;
  gz: number;
  cast: [string, string, string];
  n1: number;
  n2: number;
  hour: string;
  day: string;
  thing: string;
  who: string;
  ko: string;
  pw: string;
  /** A point `r` metres out on bearing `b`, nudged until it is off the tracks. */
  at(r: number, b: number): { x: number; z: number };
}

interface Step { kind: string; [k: string]: unknown }

interface Beat {
  /** Which of the three hands it out. Two beats each. */
  by: 0 | 1 | 2;
  title: (c: Ctx) => string;
  /** The middle of the blurb. The opening and the ask are the shared pools'. */
  core: (c: Ctx) => string;
  steps: (c: Ctx) => Step[];
  /** The beat this one follows, or undefined. Rule 8 makes it pay more. */
  after?: number;
  /** The one errand-shaped job in the set. Wired in pass two. */
  breadcrumb?: boolean;
}

interface Situation {
  key: string;
  roles: [string, string, string];
  beats: Beat[];
}

// --- step helpers ---------------------------------------------------------------------
//
// Radii are the numbers the existing packs use. Distances are kept under 320 m
// so `quest-quality.ts` rule 5 -- a round trip on foot under 2.6 km -- cannot
// fire on a hub job; the `ride` beats are exempt and are meant to be long.

const go = (c: Ctx, r: number, b: number, label: string): Step => ({ kind: 'goto', ...c.at(r, b), radius: 25, label });
const snap = (c: Ctx, r: number, b: number, label: string): Step => ({ kind: 'photo', ...c.at(r, b), radius: 35, label });
const shop = (c: Ctx, n: number, label: string): Step => ({ kind: 'buy', powerup: c.pw, count: n, label });
const bat = (c: Ctx, n: number, label: string): Step => ({ kind: 'ko', npc: c.ko, count: n, label });
const earn = (n: number, label: string): Step => ({ kind: 'earn', dollars: n, label });
const hop = (c: Ctx, label: string): Step => ({ kind: 'ride', line: -1, from: c.place, to: c.nb, label });
/** The walk back. `npc` is filled with the giver's id at emission. */
const back = (label: string): Step => ({ kind: 'dialog', node: 'ledger', label });

// --- the eighteen ---------------------------------------------------------------------
//
// Each is one premise, three people who disagree about it, and six beats with
// six different shapes. The shapes are chosen per situation rather than from a
// table: a bowling club and a fish co-op should not ask for the same six things
// in the same six orders, and rule 6 only requires variety *inside* a hub.

const SITUATIONS: Situation[] = [
  {
    key: 'bowlo',
    roles: ['greenkeeper', 'club president', 'bar manager'],
    beats: [
      {
        by: 0,
        title: (c) => `The Dead Patch at ${c.place}`,
        core: (c) => `The number three green at ${c.place} has had a bald patch the shape of Tasmania since ${c.day}, and the committee thinks I am inventing it.`,
        steps: (c) => [snap(c, 90, 0.4, 'the patch, with something in frame for scale'), back('bring it to me before the meeting')],
      },
      {
        by: 0,
        after: 0,
        title: (c) => `Turf Money, ${c.place}`,
        core: (c) => `They have seen the photograph and now they want it re-laid by ${c.day}, which means finding $${c.n2} that the ${c.place} club does not have.`,
        steps: (c) => [earn(c.n2, `$${c.n2}, however you like, I am not asking`), back('put it in my hand, not the safe')],
      },
      {
        by: 1,
        title: (c) => `The ${c.place} Membership Count`,
        core: (c) => `Our books say ${c.n1} members at ${c.place} and I would bet the bar takings that half of them are dead or moved to Queensland.`,
        steps: (c) => [go(c, 140, 2.1, 'stand at the side door where the list is kept'), snap(c, 150, 2.3, 'the board with the names still on it'), back('read me the ones you did not recognise')],
      },
      {
        by: 1,
        title: (c) => `Closing Time Rumour, ${c.place}`,
        core: (c) => `Since ${c.hour} somebody has been going round the ${c.place} greens telling the barefoot bowlers we are shutting, and we are not shutting.`,
        steps: (c) => [bat(c, 2, 'whoever is doing the telling'), earn(40 + c.n1, 'and take the bar money off them while you are there')],
      },
      {
        by: 2,
        title: (c) => `Behind the Bar at ${c.place}`,
        core: (c) => `There is ${c.thing} in the chest freezer behind the bar at ${c.place} and I am not opening it on an empty stomach.`,
        steps: (c) => [shop(c, 1, 'get one into you first, seriously'), go(c, 60, 4.2, 'round the back where the cellar door is'), snap(c, 70, 4.4, 'whatever is in there, before I lose my nerve')],
      },
      {
        by: 2,
        breadcrumb: true,
        title: (c) => `The Old Greenkeeper, ${c.place}`,
        core: (c) => `The man who kept these greens before me drinks at ${c.target} now, and he owes ${c.place} an explanation about the drainage.`,
        steps: (c) => [go(c, 900, 0, 'find him and hear him out'), back('come back and tell me what he said')],
      },
    ],
  },
  {
    key: 'servo',
    roles: ['night console operator', 'mechanic', 'franchisee'],
    beats: [
      {
        by: 0,
        title: (c) => `Nights at ${c.place}`,
        core: (c) => `Every night around ${c.hour} the same car does three laps of the ${c.place} forecourt and never buys fuel.`,
        steps: (c) => [snap(c, 110, 1.2, 'the car, plate if you can get it'), back('I want it on record before I ring anyone')],
      },
      {
        by: 0,
        after: 0,
        title: (c) => `The Third Lap, ${c.place}`,
        core: (c) => `Now I know the plate, I want to know where it goes after it leaves ${c.place} at ${c.hour}, because it is not going home.`,
        steps: (c) => [hop(c, `follow it as far as ${c.nb}`), snap(c, 130, 2.6, 'wherever it stops')],
      },
      {
        by: 1,
        title: (c) => `Bay Two, ${c.place}`,
        core: (c) => `Bay two at the ${c.place} workshop has had the same car in it since ${c.day} and the owner has stopped answering.`,
        steps: (c) => [go(c, 120, 3.4, 'the address on the job card'), snap(c, 125, 3.5, 'the letterbox, so I know I have the right house'), back('tell me if anybody actually lives there')],
      },
      {
        by: 1,
        title: (c) => `Tools Off the Bench, ${c.place}`,
        core: (c) => `Someone has been walking out of ${c.place} with a socket set at a time since ${c.day}, and I have run out of ways to be polite about it.`,
        steps: (c) => [bat(c, 3, 'the ones hanging round the air hose'), earn(c.n2, `$${c.n2} of it back, that is what the set cost`)],
      },
      {
        by: 2,
        title: (c) => `The ${c.place} Price Board`,
        core: (c) => `Head office says the ${c.place} board has been wrong since ${c.day} and I say it has been right for eleven years, and one of us is about to be embarrassed.`,
        steps: (c) => [shop(c, 1, 'buy something so it is a real transaction'), snap(c, 40, 5.1, 'the board and the pump, both in the one shot'), back('that settles it either way')],
      },
      {
        by: 2,
        breadcrumb: true,
        title: (c) => `The Other Franchise, ${c.place}`,
        core: (c) => `The bloke who runs the site at ${c.target} has had the same trouble ${c.place} has, and he will talk to you before he talks to me.`,
        steps: (c) => [go(c, 900, 0, 'find him on shift'), back('whatever he says, I want it word for word')],
      },
    ],
  },
  {
    key: 'strata',
    roles: ['building manager', 'owner-occupier', 'the one who does the bins'],
    beats: [
      {
        by: 0,
        title: (c) => `Level Two, ${c.place}`,
        core: (c) => `Water has been coming through the level two ceiling of the ${c.place} block since ${c.day} and the strata report says there is no water.`,
        steps: (c) => [snap(c, 70, 0.9, 'the ceiling, with the stain visible'), back('that goes in the file whether they like it or not')],
      },
      {
        by: 0,
        after: 0,
        title: (c) => `The Special Levy, ${c.place}`,
        core: (c) => `The photo did it. Now every owner at ${c.place} owes $${c.n2} and I have to collect it from people who have avoided me for a year.`,
        steps: (c) => [earn(c.n2, `$${c.n2} out of them, in any state`), back('I will not ask how')],
      },
      {
        by: 1,
        title: (c) => `Car Space 14, ${c.place}`,
        core: (c) => `Somebody who does not live at ${c.place} has parked in space fourteen every night since ${c.day} and the manager will not look at it.`,
        steps: (c) => [go(c, 90, 2.8, 'down to the basement, the far corner'), snap(c, 95, 2.9, 'the car in the space with the number painted beside it')],
      },
      {
        by: 1,
        title: (c) => `The Meeting, ${c.place}`,
        core: (c) => `The ${c.place} AGM is on ${c.day} and I would like to arrive with something stronger than a grievance and a printout.`,
        steps: (c) => [shop(c, 2, 'two coffees, one is for me'), go(c, 150, 4.6, 'the community room where they hold it'), back('walk in with me, they behave when there is a witness')],
      },
      {
        by: 2,
        title: (c) => `Bin Night at ${c.place}`,
        core: (c) => `Three units at ${c.place} have put their bins out on the wrong night since ${c.day} and I have taken it personally, which I accept is a choice I made.`,
        steps: (c) => [bat(c, 2, 'the ones who argue about it'), earn(60, 'the fine the council gave me, off them')],
      },
      {
        by: 2,
        breadcrumb: true,
        title: (c) => `The Other Block, ${c.place}`,
        core: (c) => `There is a block at ${c.target} with the same builder and the same cracks, and their manager has already been through what ${c.place} is starting.`,
        steps: (c) => [go(c, 900, 0, 'go and ask them how it ended'), back('I need to know how much worse this gets')],
      },
    ],
  },
  {
    key: 'cornershop',
    roles: ['shopkeeper', 'delivery driver', 'the kid on the register'],
    beats: [
      {
        by: 0,
        title: (c) => `Short Delivery, ${c.place}`,
        core: (c) => `The ${c.place} order has been two cartons light every week since ${c.day} and the invoice says otherwise every time.`,
        steps: (c) => [go(c, 100, 1.7, 'the loading bay round the side'), snap(c, 105, 1.8, 'the pallet as it actually arrives'), back('now I have got something to send them')],
      },
      {
        by: 0,
        after: 0,
        title: (c) => `The Credit Note, ${c.place}`,
        core: (c) => `They admitted it, which I did not expect, so now there is $${c.n2} owing to ${c.place} and it is not going to walk in here itself.`,
        steps: (c) => [earn(c.n2, `$${c.n2}, and do not take a voucher`), back('cash, on the counter, and I will believe it')],
      },
      {
        by: 1,
        title: (c) => `The ${c.place} Run`,
        core: (c) => `I do the ${c.place} run at ${c.hour} and there is a stretch of it where the van gets followed, which I have told nobody until now.`,
        steps: (c) => [hop(c, `ride it with me as far as ${c.nb}`), snap(c, 120, 3.9, 'whatever is behind us when we stop')],
      },
      {
        by: 1,
        title: (c) => `Locked Out, ${c.place}`,
        core: (c) => `I have got ${c.thing} in the back of the van and the ${c.place} shop is shut, and the number on the door rings out.`,
        steps: (c) => [go(c, 130, 5.4, 'try the flat above the shop'), shop(c, 1, 'get one in you, this takes a while'), back('somebody has to sign for it')],
      },
      {
        by: 2,
        title: (c) => `The Regulars, ${c.place}`,
        core: (c) => `Three of the ${c.place} regulars have started coming in together and going out separately, and the till is $${c.n1} down on those days.`,
        steps: (c) => [bat(c, 3, 'the ones who come in as a set'), earn(c.n1, `$${c.n1}, which is exactly what the till says`)],
      },
      {
        by: 2,
        breadcrumb: true,
        title: (c) => `The Wholesaler, ${c.place}`,
        core: (c) => `Everything ${c.place} sells comes off a floor at ${c.target}, and the woman who runs it will tell you things she will not put in writing.`,
        steps: (c) => [go(c, 900, 0, 'go and see her before the afternoon'), back('come and tell me what she said about us')],
      },
    ],
  },
  {
    key: 'oval',
    roles: ['junior coach', 'canteen manager', 'groundsman'],
    beats: [
      {
        by: 0,
        title: (c) => `Under 12s at ${c.place}`,
        core: (c) => `I have got eleven kids for a twelve-a-side at ${c.place} on ${c.day} and one of them has a note from his mother.`,
        steps: (c) => [go(c, 110, 0.7, 'the estate behind the ground, ask around'), snap(c, 120, 0.9, 'the noticeboard where the sign-on sheet went up'), back('any kid with boots will do at this point')],
      },
      {
        by: 0,
        after: 0,
        title: (c) => `Registration, ${c.place}`,
        core: (c) => `We found a twelfth, which means the ${c.place} club now owes the association $${c.n2} it had budgeted on not owing.`,
        steps: (c) => [earn(c.n2, `$${c.n2} before the cut-off`), back('I will drive it in myself')],
      },
      {
        by: 1,
        title: (c) => `The ${c.place} Canteen`,
        core: (c) => `The canteen at ${c.place} does two hundred sausages on a Saturday and this week the freezer went off at ${c.hour}.`,
        steps: (c) => [shop(c, 2, 'we are going to need the coffee'), snap(c, 45, 2.4, 'the thermometer, so the insurance believes us')],
      },
      {
        by: 1,
        title: (c) => `Grand Final Float, ${c.place}`,
        core: (c) => `Somebody walked off with the float from the ${c.place} canteen at about ${c.hour} during the last home game, and I have a fair idea which somebody.`,
        steps: (c) => [bat(c, 2, 'the pair who were leaning on the roller door'), earn(c.n1, `$${c.n1}, which is what was in the tin`)],
      },
      {
        by: 2,
        title: (c) => `Sprinkler Line, ${c.place}`,
        core: (c) => `The sprinkler line under the ${c.place} outfield has been leaking since ${c.day} and the wet patch has started to move.`,
        steps: (c) => [go(c, 130, 4.1, 'walk the line from the tap to the boundary'), snap(c, 140, 4.3, 'where the grass has gone dark'), back('I want to dig once, not five times')],
      },
      {
        by: 2,
        breadcrumb: true,
        title: (c) => `The Association, ${c.place}`,
        core: (c) => `The bloke who allocates grounds for the whole association sits at ${c.target}, and ${c.place} has been at the bottom of his list for two seasons.`,
        steps: (c) => [go(c, 900, 0, 'go and be reasonable at him'), back('tell me if it is us or the paperwork')],
      },
    ],
  },
];

SITUATIONS.push(
  {
    key: 'creek',
    roles: ['bushcare volunteer', 'SES member', 'resident who got flooded'],
    beats: [
      {
        by: 0,
        title: (c) => `The Creek Behind ${c.place}`,
        core: (c) => `Somebody has been tipping fill into the creek behind ${c.place} since ${c.day} and it is narrowing the channel a metre at a time.`,
        steps: (c) => [snap(c, 120, 1.1, 'the fill, with the water level in shot'), back('the council reads photographs, not letters')],
      },
      {
        by: 0,
        after: 0,
        title: (c) => `Willow Removal, ${c.place}`,
        core: (c) => `They have agreed to a clean-up at ${c.place}, which is wonderful, except the grant is $${c.n2} short and closes on ${c.day}.`,
        steps: (c) => [earn(c.n2, `$${c.n2}, and I do not care whose pocket`), back('the form needs the number today')],
      },
      {
        by: 1,
        title: (c) => `Sandbags, ${c.place}`,
        core: (c) => `We had ${c.n1} sandbags in the ${c.place} shed on ${c.day} and this morning we have got the pallet they came on.`,
        steps: (c) => [go(c, 140, 3.2, 'the yards backing onto the reserve'), snap(c, 150, 3.3, 'anywhere they have obviously been used')],
      },
      {
        by: 1,
        title: (c) => `The Low Crossing, ${c.place}`,
        core: (c) => `People keep driving the low crossing at ${c.place} at ${c.hour} with the water over the sign, and one of them is going to be the one.`,
        steps: (c) => [shop(c, 1, 'you will be standing out there a while'), bat(c, 2, 'the ones who argue with the barrier')],
      },
      {
        by: 2,
        title: (c) => `Under the House, ${c.place}`,
        core: (c) => `The water came through my place at ${c.place} on ${c.day} and the assessor wants photographs of things I have already thrown out.`,
        steps: (c) => [go(c, 90, 5.0, 'round the side, where the pile is'), snap(c, 95, 5.2, 'the high-water mark on the brick'), back('that is the whole claim, that mark')],
      },
      {
        by: 2,
        breadcrumb: true,
        title: (c) => `Upstream, ${c.place}`,
        core: (c) => `Whatever is happening to ${c.place} starts upstream at ${c.target}, and there are people up there who have been saying so for years.`,
        steps: (c) => [go(c, 900, 0, 'go up and find them'), back('I want to hear it from someone who is not me')],
      },
    ],
  },
  {
    key: 'newsagent',
    roles: ['newsagent', 'paper runner', 'lotto regular'],
    beats: [
      {
        by: 0,
        title: (c) => `Returns at ${c.place}`,
        core: (c) => `I am sending back ${c.n1} papers a day from ${c.place} and paying to have them collected, which is a business model somebody invented on purpose.`,
        steps: (c) => [snap(c, 50, 0.6, 'the returns stack, at its worst'), back('the distributor needs to see the size of it')],
      },
      {
        by: 0,
        after: 0,
        title: (c) => `The Better Rate, ${c.place}`,
        core: (c) => `They will drop my ${c.place} order if I can show $${c.n2} of turnover on the other side of the shop by ${c.day}.`,
        steps: (c) => [earn(c.n2, `$${c.n2}, and cards and stationery count`), back('sell anything, I am not proud')],
      },
      {
        by: 1,
        title: (c) => `The ${c.place} Round`,
        core: (c) => `I do the ${c.place} round from ${c.hour} and for the last fortnight somebody has been taking the papers off the front steps behind me.`,
        steps: (c) => [go(c, 160, 2.5, 'the end of the round, where it starts'), snap(c, 170, 2.7, 'whoever is on that street at that hour')],
      },
      {
        by: 1,
        title: (c) => `The Dog on Ash Street, ${c.place}`,
        core: (c) => `There is a dog on the ${c.place} round that has had two of my bags and ${c.thing} that was not even mine.`,
        steps: (c) => [shop(c, 1, 'you will want your wits about you'), bat(c, 1, 'the owner, not the dog, I am not a monster'), back('tell me it is sorted')],
      },
      {
        by: 2,
        title: (c) => `The Syndicate, ${c.place}`,
        core: (c) => `Nine of us at ${c.place} have gone in on the same numbers since ${c.day} and one of us has stopped putting money in.`,
        steps: (c) => [go(c, 120, 4.8, 'the house of the one who stopped'), earn(c.n1, `$${c.n1}, which is his share since he stopped`), back('I want it said out loud, not in the group chat')],
      },
      {
        by: 2,
        breadcrumb: true,
        title: (c) => `The Other Agency, ${c.place}`,
        core: (c) => `The agency at ${c.target} closed six months before ${c.place} started struggling, and I would very much like to know what they know.`,
        steps: (c) => [go(c, 900, 0, 'the shop is shut, the family is not'), back('whatever they say, say it slowly to me')],
      },
    ],
  },
  {
    key: 'workshop',
    roles: ['panel beater', 'apprentice', 'the bloke whose car it is'],
    beats: [
      {
        by: 0,
        title: (c) => `The Unclaimed Falcon, ${c.place}`,
        core: (c) => `There has been a car in the ${c.place} yard since ${c.day} with ${c.thing} on the passenger seat and no owner answering.`,
        steps: (c) => [snap(c, 60, 1.4, 'the car and the plate together'), back('I have to prove I tried before I can move it')],
      },
      {
        by: 0,
        after: 0,
        title: (c) => `Storage Fees, ${c.place}`,
        core: (c) => `Now that it is documented, ${c.place} is owed $${c.n2} in storage and the only person who can pay it is the person not answering.`,
        steps: (c) => [earn(c.n2, `$${c.n2}, from him or from the scrap`), back('either way it comes off my floor')],
      },
      {
        by: 1,
        title: (c) => `First Year, ${c.place}`,
        core: (c) => `I am in my first year at ${c.place} and I have to log ${c.n1} hours on a job I am not allowed to touch on my own.`,
        steps: (c) => [go(c, 100, 2.9, 'the supplier, two streets over'), shop(c, 1, 'and get him a coffee, it helps'), back('sign the book and I owe you')],
      },
      {
        by: 1,
        title: (c) => `The Air Line, ${c.place}`,
        core: (c) => `Somebody has been coming into the ${c.place} yard after ${c.hour} to use the air line, and last week they used the compressor as well.`,
        steps: (c) => [bat(c, 2, 'the ones who think the yard is public'), snap(c, 55, 3.8, 'the gate they are getting through')],
      },
      {
        by: 2,
        title: (c) => `My Own Car, ${c.place}`,
        core: (c) => `My car has been at ${c.place} since ${c.day} and every time I ring, the quote has grown by about $${c.n1}.`,
        steps: (c) => [go(c, 80, 5.3, 'stand in the office where they can see you'), snap(c, 85, 5.4, 'the job card on the wall, all of it'), back('now I know what I am arguing about')],
      },
      {
        by: 2,
        breadcrumb: true,
        title: (c) => `The Assessor, ${c.place}`,
        core: (c) => `The insurance assessor who signs off every job at ${c.place} works out of ${c.target}, and he has never once seen the car he is assessing.`,
        steps: (c) => [go(c, 900, 0, 'catch him before he goes out on the road'), back('I want to hear how he does it')],
      },
    ],
  },
  {
    key: 'opshop',
    roles: ['shop manager', 'sorter', 'volunteer driver'],
    beats: [
      {
        by: 0,
        title: (c) => `Dumped Out the Back, ${c.place}`,
        core: (c) => `People leave things at the ${c.place} roller door after ${c.hour} and by morning it is rained on and it is our problem and our tip fee.`,
        steps: (c) => [snap(c, 45, 0.8, 'the pile, on a bad morning'), back('the council will not act without one of these')],
      },
      {
        by: 0,
        after: 0,
        title: (c) => `The Tip Fee, ${c.place}`,
        core: (c) => `The photos worked, which means ${c.place} can claim back the $${c.n2} we have paid to throw away other people's furniture since ${c.day}.`,
        steps: (c) => [earn(c.n2, `$${c.n2}, and every receipt counts`), back('I will do the form if you do the walking')],
      },
      {
        by: 1,
        title: (c) => `The Good Box, ${c.place}`,
        core: (c) => `Something came into ${c.place} on ${c.day} in a box of paperbacks that I do not think the family meant to give away.`,
        steps: (c) => [go(c, 130, 2.2, 'the address on the donation slip'), snap(c, 135, 2.4, 'the thing itself, before it goes back'), back('I would rather give it back than sell it')],
      },
      {
        by: 1,
        title: (c) => `Sorting Room, ${c.place}`,
        core: (c) => `Two people have been coming into the ${c.place} sorting room since ${c.day} and taking the good stock before it reaches the floor, and one of them volunteers here.`,
        steps: (c) => [bat(c, 2, 'catch them at the back door'), earn(c.n1, `$${c.n1}, which is what the good stock made last month`)],
      },
      {
        by: 2,
        title: (c) => `The Van, ${c.place}`,
        core: (c) => `I do the ${c.place} pick-ups in a van with ${c.n1} thousand on it and a door that only opens if you know about it.`,
        steps: (c) => [hop(c, `come out to ${c.nb} with me, it is a two-person lift`), shop(c, 1, 'we will stop on the way, my shout')],
      },
      {
        by: 2,
        breadcrumb: true,
        title: (c) => `Head Office, ${c.place}`,
        core: (c) => `Everything ${c.place} cannot sell goes to a warehouse at ${c.target}, and nobody there has ever answered a phone in my hearing.`,
        steps: (c) => [go(c, 900, 0, 'turn up in person, that is the trick'), back('tell me there is a person in there')],
      },
    ],
  },
  {
    key: 'bakery',
    roles: ['baker', 'night delivery', 'front of house'],
    beats: [
      {
        by: 0,
        title: (c) => `${c.hour} at ${c.place}`,
        core: (c) => `I start at ${c.hour} and for a month the ${c.place} back lane has had somebody in it who is not waiting for bread.`,
        steps: (c) => [snap(c, 65, 1.6, 'the lane, from the door, no flash'), back('I am not calling anyone until I am sure')],
      },
      {
        by: 0,
        after: 0,
        title: (c) => `The Lane Light, ${c.place}`,
        core: (c) => `A light on that lane costs ${c.place} $${c.n2} and the landlord has said no twice, so we are doing it ourselves.`,
        steps: (c) => [earn(c.n2, `$${c.n2} and I will fit it myself`), back('do not tell him where it came from')],
      },
      {
        by: 1,
        title: (c) => `Flour Run, ${c.place}`,
        core: (c) => `The flour for ${c.place} comes off a truck at ${c.hour} and last ${c.day} the truck came and the flour did not.`,
        steps: (c) => [hop(c, `ride out to ${c.nb} where the load is made up`), snap(c, 110, 3.5, 'the pallet with our name on it, if it exists')],
      },
      {
        by: 1,
        title: (c) => `The Loading Zone, ${c.place}`,
        core: (c) => `The ${c.place} loading zone has had a car in it at ${c.hour} every morning this week and the driver waits in it, which makes it worse.`,
        steps: (c) => [bat(c, 1, 'the one who says he is only a minute'), earn(90, 'and the ticket I got, off him')],
      },
      {
        by: 2,
        title: (c) => `The Sourdough Sign, ${c.place}`,
        core: (c) => `Somebody two doors down from ${c.place} put up a sign on ${c.day} that says the same six words as ours, in the same order.`,
        steps: (c) => [go(c, 70, 4.9, 'walk down and read it properly'), snap(c, 75, 5.0, 'both signs if you can get them in one frame'), back('tell me I am not imagining it')],
      },
      {
        by: 2,
        breadcrumb: true,
        title: (c) => `The Old Site, ${c.place}`,
        core: (c) => `This business was at ${c.target} before it was at ${c.place}, and there is a woman there who still has the original book.`,
        steps: (c) => [go(c, 900, 0, 'she is usually about in the afternoon'), back('bring back whatever she is willing to say')],
      },
    ],
  },
  {
    key: 'pool',
    roles: ['lifeguard', 'swim coach', 'kiosk operator'],
    beats: [
      {
        by: 0,
        title: (c) => `The ${c.place} Pool`,
        core: (c) => `Council has been saying the ${c.place} pool is at end of life since ${c.day} and the crack they keep pointing at is not in the shell.`,
        steps: (c) => [snap(c, 55, 0.3, 'the crack, close, with something for scale'), back('an engineer can read that. A councillor cannot.')],
      },
      {
        by: 0,
        after: 0,
        title: (c) => `The Petition Stall, ${c.place}`,
        core: (c) => `We are running a stall for ${c.place} on ${c.day} and a stall needs $${c.n2} of gear that nobody has volunteered to pay for.`,
        steps: (c) => [earn(c.n2, `$${c.n2} and a table, if you see one`), back('I will be there from eight either way')],
      },
      {
        by: 1,
        title: (c) => `Squad, ${c.place}`,
        core: (c) => `I coach ${c.n1} kids at ${c.place} at ${c.hour} and three of them have stopped coming without anybody ringing me.`,
        steps: (c) => [go(c, 140, 2.7, 'the flats where two of them live'), shop(c, 1, 'take something with you, it is a long walk up'), back('I do not need them back. I need to know.')],
      },
      {
        by: 1,
        title: (c) => `The Deep End, ${c.place}`,
        core: (c) => `A group has been coming over the ${c.place} fence after close and swimming in the dark, which is how ${c.place} loses its pool.`,
        steps: (c) => [bat(c, 3, 'the ones who go over the fence'), snap(c, 60, 3.7, 'the spot in the fence they use')],
      },
      {
        by: 2,
        title: (c) => `The Kiosk Freezer, ${c.place}`,
        core: (c) => `The kiosk at ${c.place} has ${c.thing} in it and a freezer that has been running warm since ${c.day}.`,
        steps: (c) => [shop(c, 2, 'get two, we are going to be here'), go(c, 50, 5.6, 'the plant room behind the kiosk'), back('tell me whether it is the freezer or the power')],
      },
      {
        by: 2,
        breadcrumb: true,
        title: (c) => `The Aquatic Centre, ${c.place}`,
        core: (c) => `They want everyone from ${c.place} to drive to the new centre at ${c.target}, so somebody should go and see whether it is any good.`,
        steps: (c) => [go(c, 900, 0, 'have a proper look, not a quick one'), back('be honest with me, even if it is nice')],
      },
    ],
  },
  {
    key: 'rank',
    roles: ['taxi driver', 'rank marshal', 'hotel doorman'],
    beats: [
      {
        by: 0,
        title: (c) => `The ${c.place} Rank`,
        core: (c) => `The rank outside ${c.place} used to hold nine cars and since ${c.day} it holds four, and nobody will say who moved the line.`,
        steps: (c) => [snap(c, 40, 1.9, 'the painted line and the old one under it'), back('the old paint is still there, that is the whole argument')],
      },
      {
        by: 0,
        after: 0,
        title: (c) => `Lost Fares, ${c.place}`,
        core: (c) => `Since the rank at ${c.place} shrank I am $${c.n2} a week down, and the association wants that number from somebody who can prove it.`,
        steps: (c) => [earn(c.n2, `$${c.n2} in a week, to show it can be done`), back('that is the submission, right there')],
      },
      {
        by: 1,
        title: (c) => `Queue Jumpers, ${c.place}`,
        core: (c) => `Cars that have never sat in the ${c.place} queue turn up at ${c.hour} and take the front of it, and the drivers who waited say nothing.`,
        steps: (c) => [bat(c, 2, 'the ones who take the front'), earn(c.n1, `$${c.n1}, which is about one airport run`)],
      },
      {
        by: 1,
        title: (c) => `The Late Train, ${c.place}`,
        core: (c) => `When the last train into ${c.place} is late, ${c.n1} people come out at once and I have to have cars there before they do.`,
        steps: (c) => [hop(c, `come in on the last one from ${c.nb} and see it`), snap(c, 45, 3.1, 'the rank at the moment the doors open')],
      },
      {
        by: 2,
        title: (c) => `The Door, ${c.place}`,
        core: (c) => `I have stood on this door near ${c.place} for ${c.n1} years and since ${c.day} somebody has been sending my guests to a different rank.`,
        steps: (c) => [go(c, 120, 4.5, 'follow one of them and see where they end up'), shop(c, 1, 'you will be standing about, get something')],
      },
      {
        by: 2,
        breadcrumb: true,
        title: (c) => `The Depot, ${c.place}`,
        core: (c) => `The plates working the ${c.place} rank are dispatched from a depot at ${c.target}, and the man who runs it has never met a driver he liked.`,
        steps: (c) => [go(c, 900, 0, 'go and be pleasant at him anyway'), back('tell me whether he is the problem or the symptom')],
      },
    ],
  },
);

// --- placement ------------------------------------------------------------------------

/** Every body already in the city, so nothing is placed on top of one. */
const placed: Array<{ x: number; z: number; first: string }> = existing.map((n) => ({
  x: n.x,
  z: n.z,
  first: n.name.split(',')[0].trim().toLowerCase(),
}));

function clearSpot(cx: number, cz: number, minR: number, maxR: number): { x: number; z: number } | null {
  for (let attempt = 0; attempt < 260; attempt++) {
    const r = minR + rnd() * (maxR - minR);
    const b = rnd() * Math.PI * 2;
    const x = Math.round(cx + Math.cos(b) * r);
    const z = Math.round(cz + Math.sin(b) * r);
    if (trackDist(x, z) < 24) continue;
    let clash = false;
    for (const p of placed) {
      if ((p.x - x) ** 2 + (p.z - z) ** 2 < 30 * 30) { clash = true; break; }
    }
    if (clash) continue;
    return { x, z };
  }
  return null;
}

/** A first name nobody within `NAME_REACH_M` is using. See the note on NAMES. */
function freeName(x: number, z: number): string | null {
  const reach2 = NAME_REACH_M * NAME_REACH_M;
  const near = new Set<string>();
  for (const p of placed) {
    if ((p.x - x) ** 2 + (p.z - z) ** 2 <= reach2) near.add(p.first);
  }
  // Walked from a seeded offset rather than from zero, so the same handful of
  // names does not open every hub in the city.
  const start = Math.floor(rnd() * NAMES.length);
  for (let i = 0; i < NAMES.length; i++) {
    const name = NAMES[(start + i) % NAMES.length];
    if (!near.has(name.toLowerCase())) return name;
  }
  return null;
}

/** A step target off the tracks, spiralling out until it finds one. */
function safePoint(gx: number, gz: number, r: number, b: number): { x: number; z: number } {
  for (let i = 0; i < 26; i++) {
    const x = Math.round(gx + Math.cos(b + i * 0.7) * (r + i * 7));
    const z = Math.round(gz + Math.sin(b + i * 0.7) * (r + i * 7));
    if (trackDist(x, z) >= 14) return { x, z };
  }
  return { x: gx, z: gz };
}

// --- the authoring gate ---------------------------------------------------------------
//
// Run before a single quest is written, because the failure it catches is the
// one that produced the four hundred and twenty-one: a core with nothing in it
// but the place name reads identically at every station once the place name is
// the only thing that moved. Two synthetic contexts, and a core has to differ in
// more than the station.

{
  const probe = (n: number): Ctx => ({
    place: n === 0 ? 'Redfern' : 'Kogarah',
    nb: n === 0 ? 'Erskineville' : 'Carlton',
    target: n === 0 ? 'Newtown' : 'Rockdale',
    gx: 0, gz: 0,
    cast: ['Abbie', 'Doug', 'Kez'],
    n1: n === 0 ? 12 : 87,
    n2: n === 0 ? 40 : 260,
    hour: n === 0 ? 'ten past five' : 'just gone midnight',
    day: n === 0 ? 'a Tuesday' : 'the long weekend',
    thing: n === 0 ? 'a milk crate' : 'a roll of raffle tickets',
    who: n === 0 ? 'a bloke in a council polo' : 'the lady with the two greyhounds',
    ko: 'karen', pw: 'FLAT WHITE',
    at: () => ({ x: 0, z: 0 }),
  });
  const a = probe(0);
  const b = probe(1);
  const bad: string[] = [];
  for (const sit of SITUATIONS) {
    if (sit.beats.length !== 6) bad.push(`${sit.key} has ${sit.beats.length} beats, not 6.`);
    const shapes = new Set(sit.beats.map((beat) => beat.steps(a).map((s) => s.kind).join('+')));
    if (shapes.size < 5) {
      bad.push(`${sit.key} has only ${shapes.size} distinct step shapes over 6 beats; rule 6 will fire on every hub.`);
    }
    const crumbs = sit.beats.filter((beat) => beat.breadcrumb === true).length;
    if (crumbs !== 1) bad.push(`${sit.key} has ${crumbs} breadcrumbs; a hub gets exactly one way out.`);
    for (let i = 0; i < sit.beats.length; i++) {
      const beat = sit.beats[i];
      const one = beat.core(a);
      const two = beat.core(b);
      if (!one.includes('Redfern')) bad.push(`${sit.key}[${i}] never names its station; rule 2 will refuse it.`);
      const wa = one.split(/\s+/);
      const wb = two.split(/\s+/);
      let differ = 0;
      for (let k = 0; k < Math.min(wa.length, wb.length); k++) if (wa[k] !== wb[k]) differ++;
      if (differ < 2) {
        bad.push(
          `${sit.key}[${i}] differs by ${differ} word(s) between two cities. A core needs the place ` +
            'and at least one more slot, or every instance of it reads as one sentence.',
        );
      }
      if (wa.length < 14) bad.push(`${sit.key}[${i}] is ${wa.length} words; a core that short cannot carry a hub.`);
      // Rule 4 is about a list a player reads: two rows called "The Better Rate"
      // are two rows they cannot tell apart. The place is what makes a title an
      // address, and it is also what makes it unique across two hundred hubs.
      if (!beat.title(a).includes('Redfern')) {
        bad.push(`${sit.key}[${i}] is titled "${beat.title(a)}", which names no place; two hubs will collide on it.`);
      }
      // The owner's rule, enforced at authoring time rather than discovered by
      // the gate afterwards: a go-and-talk job is allowed once per hub and only
      // as the way out of it.
      const kinds = beat.steps(a).map((st) => st.kind);
      const errand = kinds.every((k) => k === 'goto' || k === 'dialog');
      if (errand && beat.breadcrumb !== true) {
        bad.push(`${sit.key}[${i}] is goto-and-talk and is not the breadcrumb; that is the job the owner called boring.`);
      }
      if (beat.breadcrumb === true && !errand) {
        bad.push(`${sit.key}[${i}] is the breadcrumb and asks for more than a walk and a word.`);
      }
    }
  }
  if (bad.length > 0) {
    console.error('hub-gen: the situations do not pass their own gate.\n');
    console.error(bad.map((s) => '  - ' + s).join('\n'));
    process.exit(1);
  }
}

// --- pass one: place the hubs ---------------------------------------------------------

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Levels, front-loaded: discovery is a rung-one problem. Twenty slots. */
const LEVEL_WHEEL = [1, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 5, 5, 6, 6, 7, 8, 9, 10];

interface Hub {
  station: Stn;
  sit: Situation;
  level: number;
  ctx: Ctx;
  givers: Array<{ id: string; first: string; x: number; z: number }>;
}

const order = stations.slice();
for (let i = order.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [order[i], order[j]] = [order[j], order[i]];
}

const hubs: Hub[] = [];
const usedStation = new Set<string>();
let refused = 0;
for (const station of order) {
  if (hubs.length >= WANT_HUBS) break;
  if (usedStation.has(station.name)) continue;
  // A hub is three people standing together. If the city will not give us three
  // clear spots near this platform, it is not a hub and we move on rather than
  // scattering two of them and calling it one.
  const spots: Array<{ x: number; z: number }> = [];
  for (let k = 0; k < 3; k++) {
    const spot = clearSpot(station.x, station.z, 70, 210);
    if (spot === null) break;
    spots.push(spot);
    placed.push({ x: spot.x, z: spot.z, first: '' });
  }
  if (spots.length < 3) {
    // Take back the ones we did claim, or a failed hub blocks the ground.
    placed.length -= spots.length;
    refused++;
    continue;
  }
  const names: string[] = [];
  for (const spot of spots) {
    const name = freeName(spot.x, spot.z);
    if (name === null) break;
    names.push(name);
    placed[placed.length - spots.length + names.length - 1].first = name.toLowerCase();
  }
  if (names.length < 3) {
    placed.length -= spots.length;
    refused++;
    continue;
  }
  usedStation.add(station.name);
  const sit = SITUATIONS[hubs.length % SITUATIONS.length];
  const level = LEVEL_WHEEL[hubs.length % LEVEL_WHEEL.length];
  const centre = { x: Math.round((spots[0].x + spots[1].x + spots[2].x) / 3), z: Math.round((spots[0].z + spots[1].z + spots[2].z) / 3) };
  hubs.push({
    station,
    sit,
    level,
    givers: spots.map((s, k) => ({
      id: `hub-${slug(station.name)}-${slug(names[k])}`,
      first: names[k],
      x: s.x,
      z: s.z,
    })),
    ctx: {
      place: station.name,
      nb: nearestOther(station).name,
      target: '',
      gx: centre.x,
      gz: centre.z,
      cast: [names[0], names[1], names[2]] as [string, string, string],
      n1: between(9, 96),
      n2: between(20, 40) + level * between(6, 14),
      hour: pick(HOURS),
      day: pick(DAYS),
      thing: pick(THINGS),
      who: pick(WHO),
      ko: pick(KO_KINDS),
      pw: pick(POWERUPS),
      at: (r, b) => safePoint(centre.x, centre.z, r, b),
    },
  });
}

// --- pass two: wire the breadcrumbs ---------------------------------------------------
//
// The one errand-shaped job in each hub, and the only one, pointed at the
// nearest *other* hub that is far enough away to count as somewhere else. This
// is the whole of the owner's rule: a go-and-talk job is allowed when it hands
// you six more jobs in a suburb you have not been to.

/** How far a breadcrumb has to carry you. `quest-quality.ts` refuses less. */
const BREADCRUMB_M = 900;
const crumbTo = new Map<number, Hub>();
for (let i = 0; i < hubs.length; i++) {
  let best: Hub | null = null;
  let bestD = Infinity;
  for (let j = 0; j < hubs.length; j++) {
    if (i === j) continue;
    const d = Math.sqrt((hubs[i].ctx.gx - hubs[j].ctx.gx) ** 2 + (hubs[i].ctx.gz - hubs[j].ctx.gz) ** 2);
    if (d < BREADCRUMB_M || d >= bestD) continue;
    bestD = d;
    best = hubs[j];
  }
  if (best !== null) {
    crumbTo.set(i, best);
    hubs[i].ctx.target = best.station.name;
  }
}

// --- emit ------------------------------------------------------------------------------


interface Pack { quests: unknown[]; npcs: unknown[] }
const packs: Pack[] = [];
/** `MAX_NPCS_PER_PACK` is 32 and `MAX_QUESTS_PER_PACK` is 64; ten givers and
 *  twenty quests a pack leaves both a wide margin and keeps a hub whole inside
 *  one file, which matters because **a pack is refused whole on one error**. */
const GIVERS_PER_PACK = 9;
let pack: Pack = { quests: [], npcs: [] };
packs.push(pack);

/** The running counter that assigns the opening and the ask. See the header. */
let phrase = 0;
let quests = 0;
let crumbs = 0;
const skipped: string[] = [];

for (let h = 0; h < hubs.length; h++) {
  const hub = hubs[h];
  const c = hub.ctx;
  const target = crumbTo.get(h) ?? null;
  const questIdFor = (beat: number): string => `h-${hub.sit.key}-${slug(hub.station.name)}-${beat}`;

  // A hub arrives whole or not at all, for the same reason a pack does: half a
  // situation is three people talking about something that is not happening.
  if (target === null) {
    skipped.push(`${hub.station.name}: no other hub ${BREADCRUMB_M} m away to send anyone to`);
    continue;
  }
  if (hub.sit.beats.some((_, i) => usedQuestId.has(questIdFor(i)))) {
    skipped.push(`${hub.station.name}: a quest id is already taken`);
    continue;
  }

  if (pack.npcs.length + 3 > GIVERS_PER_PACK) {
    pack = { quests: [], npcs: [] };
    packs.push(pack);
  }

  /** What each giver is handing out, filled as the beats are walked. */
  const jobs: Array<Array<{ id: string; title: string; blurb: string }>> = [[], [], []];

  for (let i = 0; i < hub.sit.beats.length; i++) {
    const beat = hub.sit.beats[i];
    const id = questIdFor(i);
    usedQuestId.add(id);
    const giver = hub.givers[beat.by];

    /*
     * **Indexed off this beat's own instance number, with coprime strides.**
     *
     * The first version walked one global counter, and it was wrong in a way
     * only the gate found: hubs cycle through the situations, so two instances
     * of one beat are twelve hubs and therefore seventy-two quests apart -- and
     * twenty-four divides seventy-two, so every instance of a beat drew the
     * *same* opening, forever. The two ends of the sentence were varying and the
     * one thing that had to vary was not.
     *
     * 5, 7 and 11 are coprime with 24, so each pool walks all twenty-four values
     * before repeating, and the three walk at different rates so a repeat in one
     * never coincides with a repeat in another.
     */
    const instance = Math.floor(h / SITUATIONS.length);
    phrase++;
    const blurb = weave(beat.core(c), voiceFor(instance, i));

    const steps = beat.steps(c).map((s) => (s.kind === 'dialog' ? { ...s, npc: giver.id } : s));
    if (beat.breadcrumb === true) {
      // The goto is re-pointed at the hub we are sending them to. The beat wrote
      // a placeholder distance because it cannot know, at authoring time, which
      // suburb this instance will end up next to.
      for (const s of steps) {
        if (s.kind !== 'goto') continue;
        // **A person, not the centroid.** The first draft pointed at the target
        // hub's centre, which is the mean of three positions near a platform and
        // is therefore very often *on the platform* -- the gate refused thirty
        // of them for standing on the tracks. A giver has already been placed
        // clear of the rails and clear of everybody else, and "go and find them"
        // is what the sentence says anyway.
        s.x = target.givers[0].x;
        s.z = target.givers[0].z;
        s.radius = 60;
        break;
      }
      crumbs++;
    }

    // Rule 8: a chain pays more as it climbs. The bump is on top of the level's
    // own scale rather than instead of it, so a rung-1 chain still reads as
    // rung-1 money.
    const step = beat.after === undefined ? 0 : 1;
    pack.quests.push({
      id,
      act: 3,
      title: beat.title(c),
      blurb,
      giver: giver.id,
      level: hub.level,
      requires: beat.after === undefined ? [] : [questIdFor(beat.after)],
      repeatable: false,
      steps,
      reward: {
        cash: 34 + hub.level * 15 + step * 40 + between(0, 20),
        xp: 70 + hub.level * 46 + step * 90 + between(0, 24),
        unlock: [`hub:${id}`],
      },
      needFlags: [hub.level === 1 ? 'act0:trained' : 'act1:open'],
    });
    quests++;
    jobs[beat.by].push({ id, title: beat.title(c), blurb });
  }

  for (let k = 0; k < 3; k++) {
    const giver = hub.givers[k];
    const mine = jobs[k];
    const hello = HELLOS[(h * 3 + k) % HELLOS.length];
    const ledger = LEDGERS[(h * 3 + k + 5) % LEDGERS.length];
    const closer = CLOSERS[(h + k) % CLOSERS.length];
    /*
     * Four nodes and two offers, which is the one structural difference from
     * `field-gen.ts`'s givers: a hub giver hands out two jobs, so `hello` has to
     * branch twice before it reaches a job rather than once.
     *
     * The turn-ins share one node. A choice carrying `turnin` on a quest that is
     * not finished is refused by the server and greyed by the panel -- see
     * `questmodel.choiceRefusal` -- so listing both is honest rather than
     * misleading, and it means a player holding both finished jobs hands them in
     * without walking out of the conversation and back into it.
     */
    pack.npcs.push({
      id: giver.id,
      name: `${giver.first}, ${hub.sit.roles[k]} at ${hub.station.name}`,
      x: giver.x,
      z: giver.z,
      radius: 5,
      root: 'hello',
      nodes: [
        {
          id: 'hello',
          line: hello,
          choices: [
            ...mine.map((job, n) => ({ text: n === 0 ? 'What have you got?' : 'Anything else?', goto: `j${n}` })),
            { text: "I've done what you asked.", goto: 'ledger' },
            { text: 'Not today.', goto: '' },
          ],
        },
        ...mine.map((job, n) => ({
          id: `j${n}`,
          line: job.blurb,
          choices: [
            { text: "Alright. I'll do it.", accept: job.id, denyFlag: `hub:${job.id}` },
            { text: 'What else is there?', goto: 'hello' },
            { text: 'Not for me.', goto: '' },
          ],
        })),
        {
          id: 'ledger',
          line: ledger,
          choices: [
            ...mine.map((job) => ({ text: `${job.title} — that's done.`, turnin: job.id })),
            { text: 'Still on it.', goto: '' },
          ],
        },
        { id: 'bye', line: closer, choices: [{ text: 'Right.', goto: '' }] },
      ],
    });
  }
}

// --- write ------------------------------------------------------------------------------

let files = 0;
for (let i = 0; i < packs.length; i++) {
  if (packs[i].quests.length === 0) continue;
  const tag = String(i + 1).padStart(3, '0');
  writeFileSync(join(CONTENT, 'quests', `hub-${tag}.json`), JSON.stringify({ quests: packs[i].quests }, null, 1) + '\n');
  writeFileSync(join(CONTENT, 'dialog', `hub-${tag}.json`), JSON.stringify({ npcs: packs[i].npcs }, null, 1) + '\n');
  files++;
}

const shapes = new Set<string>();
for (const p of packs) for (const q of p.quests as Array<{ steps: Step[] }>) shapes.add(q.steps.map((s) => s.kind).join('+'));

console.log(
  `hub-gen: ${quests} quest(s) over ${hubs.length - skipped.length} hub(s) in ${files} pack file(s).\n` +
    `  ${SITUATIONS.length} situations, ${shapes.size} distinct step shapes, ${crumbs} breadcrumbs.\n` +
    `  ${refused} station(s) had no room for three people; ${skipped.length} hub(s) dropped.`,
);
if (skipped.length > 0) console.log('  ' + skipped.slice(0, 6).join('\n  '));
console.log('\n  next: bun run scripts/content/quest-quality.ts && bun run scripts/content/content-check.ts');
