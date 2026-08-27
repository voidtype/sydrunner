/*
 * field-gen.ts -- the field quests: five hundred jobs that are found rather
 * than listed.
 *
 * The owner, unable to find work: *"the quest system still seems to be hard to
 * discover - i was hoping opening the map etc would help me find quests"*. Two
 * separate things make that true and this file is the content half.
 *
 * The arithmetic is the whole argument. Act 2's register is a hundred jobs, ten
 * to a rung, and `content-check.ts` asserts that exactly -- it is a *menu*, and
 * a menu is read at a desk. Everything else in the city was 109 quests spread
 * over sixty kilometres, which is one giver per thirty-five square kilometres.
 * The compass draws givers inside five hundred metres, so it is looking at
 * 0.8 km^2: the expected number of quest givers on screen is **two in a
 * hundred**. The feature was not hard to find. It was, to three significant
 * figures, absent.
 *
 * So this writes `act: 3` -- outside the register's ten-a-rung rule, which is
 * about the menu and should stay about the menu -- and hangs every job off a
 * real railway station, because `rail.bin` is the one list of three hundred and
 * sixty-one places in this city that a player already has a reason to stand in.
 * A job you find while waiting for a train is the discoverable kind.
 *
 * **What this is honest about.** These are composed, not hand-authored: two
 * dozen archetypes, each hand-written, crossed with a real station, real
 * neighbouring stations for the ride legs, and figures that vary per job. The
 * Act 0/1/2 quests are hand-written stories and read like it; these read like
 * good radio work, and the thing that makes them worth having is that they are
 * *specific* -- Doug's turnback is at Emu Plains because Emu Plains is the end
 * of the wire, and every one of these is somewhere for a reason too.
 *
 * Deterministic on purpose: a fixed seed, so a rerun produces the same city and
 * a diff is a real diff. Placement obeys the gate's own rules -- unique first
 * name, twenty-five metres between givers, off the tracks -- because a pack is
 * refused whole on one error.
 *
 *     bun run scripts/content/field-gen.ts [count]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeRail } from '../../client/src/game/rail.ts';

const REPO = join(import.meta.dir, '..', '..');
const CONTENT = join(REPO, 'content');
const WANT = Number(process.argv[2] ?? 500);

// --- the city -----------------------------------------------------------------------

const buf = readFileSync(join(REPO, 'client/public/rail/rail.bin'));
const bake = decodeRail(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
type Stn = { name: string; x: number; z: number };
const stations: Stn[] = bake.stations.map((s: Stn) => ({ name: s.name, x: s.x, z: s.z }));

/** Track vertices, for the "not on the rails" rule the gate enforces at 6 m. */
const V: Float32Array = bake.vertices as Float32Array;
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

/** The nearest other station: the ride legs are real one-stop hops. */
function neighbour(s: Stn): Stn {
  let best = s, bd = Infinity;
  for (const o of stations) {
    if (o.name === s.name) continue;
    const d = (o.x - s.x) ** 2 + (o.z - s.z) ** 2;
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

// --- what is already there ------------------------------------------------------------

interface Npc { id: string; name: string; x: number; z: number }
const existing: Npc[] = [];
const usedFirst = new Set<string>();
const usedQuestId = new Set<string>();
for (const lvl of ['act0', 'act1', ...Array.from({ length: 10 }, (_, i) => `pool-l${i + 1}`)]) {
  try {
    const d = JSON.parse(readFileSync(join(CONTENT, 'dialog', `${lvl}.json`), 'utf8')) as { npcs: Npc[] };
    for (const n of d.npcs) { existing.push(n); usedFirst.add(n.name.split(',')[0].trim().toLowerCase()); }
  } catch { /* pack may not exist */ }
  try {
    const q = JSON.parse(readFileSync(join(CONTENT, 'quests', `${lvl}.json`), 'utf8')) as { quests: { id: string }[] };
    for (const e of q.quests) usedQuestId.add(e.id);
  } catch { /* ditto */ }
}

// --- names --------------------------------------------------------------------------
// Six hundred givers need six hundred distinct first names, and the gate means
// it. Sydney is the most multicultural city in the country and a name list that
// is four hundred Anglo diminutives would be a worse lie than a repeated name.

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
  .split(/\s+/).filter(Boolean);

// --- a seeded shuffle, so a rerun is the same city --------------------------------------

function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(0x59d2e7);
function pick<T>(a: readonly T[]): T { return a[Math.floor(rnd() * a.length)]; }
function between(lo: number, hi: number): number { return Math.round(lo + rnd() * (hi - lo)); }

export {};
// --- the archetypes -------------------------------------------------------------------
// Each is hand-written once and crossed with a real station. The station is not
// decoration: the ride legs are the actual next stop, the walks are real
// distances, and the job reads as being *here* rather than anywhere.

type Step = Record<string, unknown>;
interface Ctx {
  st: Stn; nb: Stn; gx: number; gz: number; lvl: number;
  n1: number; n2: number; cash: number; ko: string; pw: string;
  at: (r: number, b: number) => { x: number; z: number };
  /*
   * **The detail slots, and they are the difference between 500 quests and 20
   * quests printed 25 times each.** The first cut of this file gave every
   * archetype one blurb, so half the corpus shared its paragraph with another
   * job and the worst line appeared verbatim 27 times. The titles were unique
   * because they carried the station name; the text a player actually reads was
   * wallpaper. Every line now draws a variant *and* interpolates facts that
   * differ per job, so two coffee runs are two different mornings.
   */
  hour: string; day: string; yrs: number; thing: string; grumble: string; who: string;
}
/**
 * A line is an array of phrasings; the composer picks one per job on the seeded
 * stream. Combined with the detail slots this turns 20 archetypes into a corpus
 * where a repeated *sentence* is rare and a repeated *paragraph* does not
 * happen: `field-gen` refuses to write the pack if it does. See `dupes` below.
 */
type Line = ((c: Ctx) => string)[];
interface Arch {
  key: string; role: string;
  title: (c: Ctx) => string;
  blurb: Line;
  steps: (c: Ctx) => Step[];
  hello: Line;
  offer: Line;
  colour: Line;
  done: Line;
}

const KO = ['karen', 'tradie', 'drunk', 'eshay', 'rbt', 'police'];
const PW = ['FLAT WHITE', 'TRAINING'];

// The slot vocabularies. Small, concrete, and Sydney: a detail is only worth
// interpolating if it could not have come from anywhere else.
const HOURS = ['ten past five', 'quarter to six', 'twenty past four', 'half six', 'the back of seven',
  'five in the morning', 'just gone midnight', 'two in the afternoon', 'knock-off', 'the second express'];
const DAYS = ['a Tuesday', 'Thursdays', 'the long weekend', 'a wet Monday', 'every second Friday',
  'school holidays', 'the week of the show', 'grand final week', 'the first of the month'];
const THINGS = ['a docket book', 'a hi-vis with somebody else s name in it', 'a esky with no lid',
  'a milk crate', 'a Bunnings receipt', 'a set of keys with no fob', 'a laminated sign',
  'a folder of printouts', 'a tallboy of something warm', 'a clipboard nobody signed'];
// Kept general on purpose: a grumble is appended after somebody else's clause,
// so anything that names a specific object reads as a non-sequitur half the
// time it lands. "and the sign has been wrong for a year" was one of those.
const GRUMBLES = ['and nobody upstairs wants to hear it', 'and I have stopped filling in the form',
  'and I am the only one who seems to have noticed', 'and nobody will put it in writing',
  'and it has been like that since the merge', 'and they keep sending a different bloke',
  'and I have run out of ways to say it politely', 'and I am past being reasonable about it'];
const WHO = ['a bloke in a council polo', 'the woman who runs the newsagent', 'someone off the 8:02',
  'a kid who should be at school', 'the relief driver', 'a fella with a rescue greyhound',
  'the cleaner who does the whole line', 'somebody s mum', 'a bloke everyone calls Macca'];

const ARCH: Arch[] = [
  {
    key: 'last-service', role: 'night guard',
    title: (c) => `Last Service out of ${c.st.name}`,
    blurb: [
      (c) => `The last one through ${c.st.name} carries four people and one of them is always asleep. Ride it to ${c.nb.name}, photograph the platform with nobody on it, and come back and tell me the place still exists when there is no one in it.`,
      (c) => `Nothing runs out of ${c.st.name} after ${c.hour}. I lock this end and ${c.who} locks the other and in between there is a kilometre of lit platform for nobody. Ride the last one to ${c.nb.name} and bring me a photograph of that.`,
    ],
    steps: (c) => [
      { kind: 'ride', line: -1, from: c.st.name, to: c.nb.name, label: `ride the late one to ${c.nb.name}` },
      { kind: 'photo', ...c.at(40, 1.1), radius: 30, label: 'the empty platform, lit and pointless' },
      { kind: 'dialog', npc: '', node: 'ledger', label: 'tell them what you saw' },
    ],
    hello: [
      (c) => `You get to know the last service. Four out of ${c.st.name} and one of them asleep every night, ${c.yrs} years of it, and it is never the same one.`,
      (c) => `Last one is ${c.hour}. After that it is me, the lights, and ${c.thing} somebody left on the bench in 2019.`,
    ],
    offer: [
      (c) => `Ride it to ${c.nb.name}. Photograph the platform with nobody on it. I want to know the place is there when I am not standing in it.`,
      (c) => `Take the last one out to ${c.nb.name}. Look back down the platform before the lights go. That is the bit I never get to see.`,
    ],
    colour: [
      (c) => `${c.yrs} years watching this place empty out and I still do not like the sound it makes.`,
      (c) => `On ${c.day} it is worse. You can hear the escalator from the far end.`,
    ],
    done: [
      () => `There it is. Still there. Good. Some nights I am not sure.`,
      (c) => `That is exactly it. ${c.yrs} years and somebody finally looked at it properly.`,
    ],
  },
  {
    key: 'opal-ghost', role: 'ticket inspector',
    title: (c) => `The ${c.st.name} Tap-Off`,
    blurb: [
      (c) => `Somebody taps on at ${c.st.name} at ${c.hour} and never taps off. Same card, ${c.yrs} months running. Ride the run they ride and find where a person gets off this network without a gate seeing them.`,
      (c) => `A card ending ${c.n1} boards at ${c.st.name} on ${c.day} and vanishes. Not a fare thing — ninety cents. I want to know *how*, ${c.grumble}.`,
    ],
    steps: (c) => [
      { kind: 'ride', line: -1, from: c.st.name, to: c.nb.name, label: 'ride the run the card rides' },
      { kind: 'goto', ...c.at(70, 2.4), radius: 20, label: 'the gap in the fence everyone knows about' },
      { kind: 'photo', ...c.at(70, 2.4), radius: 25, label: 'photograph it before somebody welds it' },
    ],
    hello: [
      (c) => `Card ending ${c.n1}. On at ${c.st.name}, ${c.hour}, every weekday. Never off. Not once.`,
      (c) => `I read the gate logs for ${c.st.name} the way other people read the form guide.`,
    ],
    offer: [
      () => `I am not allowed to follow it and you are not employed, which makes you better at this than me. Find where they get off.`,
      (c) => `Ride it to ${c.nb.name} and watch who does not go through the gates.`,
    ],
    colour: [
      () => `It is not the money. It is ninety cents. It is that I cannot work out how.`,
      (c) => `I have had ${c.thing} on my desk for a month with the printouts in it.`,
    ],
    done: [
      () => `A hole in a fence. Months of this. I want to be angry and mostly I am impressed.`,
      (c) => `Right there past ${c.nb.name}. Of course. Nothing on this network is ever clever, it is just old.`,
    ],
  },
  {
    key: 'coffee-run', role: 'kiosk operator',
    title: (c) => `The ${c.st.name} Order`,
    blurb: [
      (c) => `Two hundred coffees out of ${c.st.name} before ${c.hour} and I know every one of them by the walk. ${c.who} stopped coming three weeks back. Take one over to where they work and find out whether I lost them to the chain up the road.`,
      (c) => `I have made the same order for the same person every morning since I opened at ${c.st.name}. Since ${c.day} they have not turned up, ${c.grumble}. Go and knock.`,
    ],
    steps: (c) => [
      { kind: 'buy', powerup: c.pw, count: 1, label: `order one at the ${c.st.name} kiosk` },
      { kind: 'goto', ...c.at(120, 0.6), radius: 25, label: 'the office they walk to, or used to' },
      { kind: 'earn', dollars: c.n2, label: `come back with $${c.n2} — I am not running a charity` },
    ],
    hello: [
      (c) => `Two hundred a morning through ${c.st.name}. I know them by the walk before I know them by the face.`,
      (c) => `${c.yrs} years in this box. I have watched an entire suburb change its coffee order.`,
    ],
    offer: [
      (c) => `One of them stopped. Take one over there and find out if it was the chain, or ${c.who} finally retiring.`,
      () => `Take one with you. Nobody tells you anything if your hands are empty.`,
    ],
    colour: [
      () => `If it is the chain I would rather they were dead. I am joking. Mostly.`,
      (c) => `I keep ${c.thing} under the counter with their names in it. Do not tell them that.`,
    ],
    done: [
      () => `The chain. Of course it was the chain. Thank you. I hate it.`,
      (c) => `Moved to ${c.nb.name}. Well. That I can forgive.`,
    ],
  },
  {
    key: 'timetable-lie', role: 'relief signaller',
    title: (c) => `Four Minutes at ${c.st.name}`,
    blurb: [
      (c) => `The board at ${c.st.name} says four minutes. It has said four minutes since before the merge and it is a lie about a third of the time. Stand under it, time it, and bring me numbers instead of feelings.`,
      (c) => `Nobody upstairs believes me about ${c.st.name} because I have ${c.yrs} years and no data. Go and stand on that platform on ${c.day} and get me the data, ${c.grumble}.`,
    ],
    steps: (c) => [
      { kind: 'goto', ...c.at(30, 3.0), radius: 18, label: 'stand under the board and wait like everyone else' },
      { kind: 'photo', ...c.at(30, 3.0), radius: 25, label: 'photograph the board saying four minutes' },
      { kind: 'ride', line: -1, from: c.st.name, to: c.nb.name, label: 'ride the one that finally comes' },
      { kind: 'dialog', npc: '', node: 'ledger', label: 'give me the number' },
    ],
    hello: [
      () => `Four minutes. That board has said four minutes for longer than I have worked here. Sometimes it means it.`,
      (c) => `Every relief who comes through ${c.st.name} asks about that board within a fortnight.`,
    ],
    offer: [
      () => `Go and get me a number. A number is a thing they have to answer.`,
      (c) => `Time it at ${c.hour}, when it matters. Anyone can time it at lunch.`,
    ],
    colour: [
      () => `A minute of a stranger's life, three hundred times a day. Somebody should write it down.`,
      (c) => `I have ${c.thing} full of times I took myself. It is not evidence, apparently.`,
    ],
    done: [
      () => `Right. Now I have a number, and a number is a thing they have to answer.`,
      (c) => `That is worse than I said it was. ${c.grumble.replace(/^and /, 'And ')}.`,
    ],
  },
  {
    key: 'lost-property', role: 'lost property clerk',
    title: (c) => `Unclaimed at ${c.st.name}`,
    blurb: [
      (c) => `Everything anyone leaves on the ${c.st.name} line ends up in a room and the room is full. Nine hundred umbrellas and one ${c.thing} with a name on it and a number that rings out. Go to the address on the tag.`,
      (c) => `Somebody lost something off the ${c.st.name} line on ${c.day} and has not come for it, which never happens. Find out why not.`,
    ],
    steps: (c) => [
      { kind: 'goto', ...c.at(55, 4.2), radius: 20, label: 'the address on the tag' },
      { kind: 'ko', npc: c.ko, count: 2, label: 'the two who got there before you' },
      { kind: 'earn', dollars: c.n2, label: `$${c.n2} — whatever it is, it is worth that to somebody` },
    ],
    hello: [
      (c) => `Umbrellas. Nine hundred of them. And one thing off the ${c.st.name} line with a name in it.`,
      (c) => `${c.yrs} years behind this counter. People come back for the strangest things and never for the useful ones.`,
    ],
    offer: [
      () => `I cannot leave the counter. You can. Go to the address on the tag and see who is not answering.`,
      (c) => `${c.who} handed it in and would not leave a name, which is its own kind of information.`,
    ],
    colour: [
      () => `Nobody ever comes back for an umbrella. Not once.`,
      (c) => `The room smells like ${c.day} in a wet school bag and always has.`,
    ],
    done: [
      () => `That explains the phone. Poor sod. Put it back in the room, would you.`,
      (c) => `Right. Then it stays in the room, ${c.grumble}.`,
    ],
  },
  {
    key: 'quiet-carriage', role: 'commuter of long standing',
    title: (c) => `The Quiet Carriage, ${c.st.name}`,
    blurb: [
      (c) => `The quiet carriage runs on shame and somebody on the ${c.hour} out of ${c.st.name} has stopped feeling it. Ride it, see the crime, and apply the shame manually.`,
      (c) => `Speakerphone. ${c.day}, ${c.st.name} to town, speakerphone. I have made eye contact eleven times and it has achieved nothing.`,
    ],
    steps: (c) => [
      { kind: 'ride', line: -1, from: c.st.name, to: c.nb.name, label: 'ride the quiet carriage and observe the crime' },
      { kind: 'ko', npc: c.ko, count: 1, label: 'apply the shame manually' },
      { kind: 'photo', ...c.at(45, 5.1), radius: 30, label: 'photograph the sign, for the record' },
    ],
    hello: [
      () => `The quiet carriage works because everyone agrees it works. That is the entire mechanism.`,
      (c) => `${c.yrs} years on this line and it has been quiet for most of them.`,
    ],
    offer: [
      (c) => `The ${c.hour}. You will know them inside a stop.`,
      () => `I could move carriages. Then they have won something. So: no.`,
    ],
    colour: [
      (c) => `It is not the noise. It is that ${c.who} looks at me like I am the problem.`,
      () => `There is a sign. There has always been a sign. The sign does nothing on its own.`,
    ],
    done: [
      () => `Quiet. Genuinely quiet. I had forgotten what it sounded like.`,
      (c) => `All the way to ${c.nb.name} without a word. Thank you.`,
    ],
  },
  {
    key: 'the-shortcut', role: 'courier',
    title: (c) => `The ${c.st.name} Shortcut`,
    blurb: [
      (c) => `Every courier has a route that is not on a map and mine goes through ${c.st.name}. They have started locking one end. Go and find out whether it is locked forever or just locked today.`,
      (c) => `Nine minutes between the shortcut at ${c.st.name} and the long way, and nine minutes is four drops. Since ${c.day} there has been a padlock on it, ${c.grumble}.`,
    ],
    steps: (c) => [
      { kind: 'goto', ...c.at(90, 1.7), radius: 22, label: 'the end they lock' },
      { kind: 'goto', ...c.at(150, 3.6), radius: 25, label: 'the long way round, so you understand what it costs' },
      { kind: 'earn', dollars: c.n2, label: `$${c.n2}, which is what the long way costs me a week` },
    ],
    hello: [
      (c) => `Forty drops a day. ${c.st.name} is the hinge the whole run turns on.`,
      (c) => `I have been doing this since I was ${c.yrs}. I know which gates are decorative.`,
    ],
    offer: [
      () => `Go and look at the lock. Tell me if it is a padlock or a decision.`,
      (c) => `If ${c.who} put it there I can talk to them. If it is council, I cannot.`,
    ],
    colour: [
      () => `A padlock I can live with. A decision I have to reroute around for the rest of my life.`,
      (c) => `I carry ${c.thing} for exactly this. Has not helped yet.`,
    ],
    done: [
      () => `A decision. Right. Nine minutes, forever. That is what that is.`,
      () => `Temporary. Thank God. I can wait out temporary.`,
    ],
  },
  {
    key: 'night-works', role: 'trackwork foreman',
    title: (c) => `Possession at ${c.st.name}`,
    blurb: [
      (c) => `We own the track between midnight and four and in that window we are the only people in this city doing anything real. Somebody keeps walking through my possession at ${c.st.name}. Find them before a grinder does.`,
      (c) => `Third time at ${c.st.name} on ${c.day}. Not kids — kids run. This one walks, ${c.grumble}. I need it stopped before somebody writes a very long report about me.`,
    ],
    steps: (c) => [
      { kind: 'goto', ...c.at(65, 2.9), radius: 20, label: 'where they come through the fence' },
      { kind: 'ko', npc: c.ko, count: c.n1 % 3 + 1, label: 'the ones who think a hard hat is a costume' },
      { kind: 'photo', ...c.at(65, 2.9), radius: 30, label: 'photograph the gap so I can put a number on the form' },
    ],
    hello: [
      (c) => `Midnight to four, ${c.st.name} is mine. By six it looks like nothing happened, which is the job.`,
      (c) => `${c.yrs} years of nights. You stop being able to tell tired from awake at the wrong hour.`,
    ],
    offer: [
      () => `Somebody is walking through. Find the gap and photograph it.`,
      (c) => `${c.who}, I reckon. But reckoning is not a form.`,
    ],
    colour: [
      () => `You do not get a second warning out here. You get a grinder.`,
      (c) => `We had ${c.thing} out there as a barrier for a month. Somebody took it.`,
    ],
    done: [
      () => `Good. Now I can fill in a form and somebody else can ignore it.`,
      (c) => `That gap has been there since before ${c.nb.name} was rebuilt. Nobody looked.`,
    ],
  },
  {
    key: 'the-regular', role: 'publican',
    title: (c) => `The ${c.st.name} Regular`,
    blurb: [
      (c) => `A man drank in my front bar by ${c.st.name} for ${c.yrs} years and then stopped, and every regular in here has gone vague on me at once, which means they know. You are not from here. Go and knock.`,
      (c) => `Same stool since before I bought the place off ${c.st.name} road. Gone since ${c.day}, ${c.grumble}. I would like to know whether to keep the stool.`,
    ],
    steps: (c) => [
      { kind: 'goto', ...c.at(110, 0.3), radius: 25, label: 'the house they say he moved to' },
      { kind: 'buy', powerup: c.pw, count: 1, label: 'you cannot ask a favour empty-handed' },
      { kind: 'dialog', npc: '', node: 'ledger', label: 'come back and tell me straight' },
    ],
    hello: [
      (c) => `${c.yrs} years. Same stool. Then nothing, and the whole bar has gone quiet about it.`,
      (c) => `You are not from ${c.st.name}. Good. Everyone who is has decided not to tell me.`,
    ],
    offer: [
      () => `Go and knock. You have got a face nobody here owes anything to.`,
      (c) => `${c.who} will tell you where. They will not tell me.`,
    ],
    colour: [
      () => `I have kept the stool. That is either respect or superstition and I cannot tell any more.`,
      (c) => `He left ${c.thing} behind the bar. Still there.`,
    ],
    done: [
      () => `Ah. Well. I will keep the stool anyway.`,
      (c) => `${c.nb.name}. Of all places. I will drive over on ${c.day}.`,
    ],
  },
  {
    key: 'car-park', role: 'commuter car park attendant',
    title: (c) => `Bay 14, ${c.st.name}`,
    blurb: [
      (c) => `Two hundred bays at ${c.st.name} and I have counted two hundred and forty cars in here on ${c.day}. One of them has not moved since March and it has a ticket on it from March.`,
      (c) => `People have started parking on the grass at ${c.st.name} because of one abandoned car, ${c.grumble}. Photograph it, and the date on the ticket, so somebody can be embarrassed by it.`,
    ],
    steps: (c) => [
      { kind: 'photo', ...c.at(50, 4.7), radius: 25, label: 'the car, and the ticket, and the date on it' },
      { kind: 'ko', npc: c.ko, count: 2, label: 'the two arguing over the grass' },
      { kind: 'earn', dollars: c.n2, label: `$${c.n2} in fines nobody is going to collect` },
    ],
    hello: [
      (c) => `Two hundred bays. Two hundred and forty cars on ${c.day}. Do that arithmetic for me.`,
      (c) => `${c.yrs} years of watching people fight over concrete rectangles.`,
    ],
    offer: [
      () => `Bay 14 has not moved since March. Photograph it. I want a date in writing.`,
      (c) => `${c.who} has taken to parking on the verge and I cannot argue with them while that thing sits there.`,
    ],
    colour: [
      () => `You cannot tow it without an owner and you cannot find an owner without towing it. That is the whole job.`,
      (c) => `There is ${c.thing} on the dash. Been there the entire time.`,
    ],
    done: [
      () => `March. In writing. Now it is somebody else's March.`,
      (c) => `Good. I will put it in on ${c.day} when the good one is on the desk.`,
    ],
  },
  {
    key: 'the-mural', role: 'council contractor',
    title: (c) => `Whatever Is Under the Grey at ${c.st.name}`,
    blurb: [
      (c) => `Council pays me to paint over things and last week I painted over something good. There is another one near ${c.st.name} that I am scheduled to kill on ${c.day}. Photograph it first.`,
      (c) => `One colour, grey, the same grey in ${c.st.name} as in every other suburb. I would like something of this one to exist afterwards, ${c.grumble}.`,
    ],
    steps: (c) => [
      { kind: 'goto', ...c.at(130, 2.1), radius: 25, label: 'the wall, before they get to it' },
      { kind: 'photo', ...c.at(130, 2.1), radius: 30, label: 'photograph it properly, not a phone-in-a-hurry job' },
      { kind: 'dialog', npc: '', node: 'ledger', label: 'show me' },
    ],
    hello: [
      () => `Grey. I have one colour and it is grey.`,
      (c) => `${c.yrs} years of undoing other people's afternoons.`,
    ],
    offer: [
      (c) => `The one near ${c.st.name}. It goes on ${c.day}. Go now.`,
      (c) => `${c.who} did it, I think. I am not going to ask, because then I would know.`,
    ],
    colour: [
      () => `I keep the photos. Two hundred and eleven of them. Worst gallery in Australia.`,
      (c) => `I have ${c.thing} in the van with every one of them logged.`,
    ],
    done: [
      () => `Two hundred and twelve. Right. Thursday can have the wall.`,
      (c) => `That is a good one. That is a genuinely good one, ${c.grumble}.`,
    ],
  },
  {
    key: 'the-hill', role: 'bus driver on a break',
    title: (c) => `The Hill Above ${c.st.name}`,
    blurb: [
      (c) => `I drive past the same view above ${c.st.name} eleven times a shift and I have never once stopped at it. You have got legs and no timetable. Go up and photograph what I have been driving past for ${c.yrs} years.`,
      (c) => `There is a bench on the hill above ${c.st.name} I have watched from a moving bus about fourteen thousand times. I am not going to stop — that is not the kind of person I turned out to be. So you go, at ${c.hour}, when the light is worth it.`,
    ],
    steps: (c) => [
      { kind: 'goto', ...c.at(180, 5.5), radius: 30, label: 'up the hill, the way the road does not go' },
      { kind: 'photo', ...c.at(180, 5.5), radius: 40, label: 'the view I have never stopped for' },
      { kind: 'earn', dollars: c.n2, label: `$${c.n2}, because I am paying you for it` },
    ],
    hello: [
      (c) => `Eleven times a shift past ${c.st.name} and up over that hill. ${c.yrs} years. Never stopped.`,
      (c) => `Twenty minutes here, then back out to ${c.nb.name}. That is the whole of my day.`,
    ],
    offer: [
      (c) => `Go up at ${c.hour}. That is when it is worth it, I can tell from the road.`,
      () => `I am not going to stop. So you go, and then one of us has been.`,
    ],
    colour: [
      (c) => `On ${c.day} you can see all the way down the line from up there. Apparently.`,
      (c) => `${c.who} told me about the bench. Never been either.`,
    ],
    done: [
      () => `That is what it looks like. Right. That is what it looks like.`,
      (c) => `${c.yrs} years. Thank you. I mean that.`,
    ],
  },
  {
    key: 'the-fine', role: 'someone with a grievance',
    title: (c) => `Contesting It at ${c.st.name}`,
    blurb: [
      (c) => `Two hundred and eighty-five dollars at ${c.st.name} for a thing the sign did not say, because the sign is not there. The form wants evidence. Go and photograph the absence.`,
      (c) => `Done at ${c.st.name} on ${c.day} for something that is only an offence if a sign says so, ${c.grumble}. How do you photograph a thing not being somewhere? That is your problem now.`,
    ],
    steps: (c) => [
      { kind: 'goto', ...c.at(60, 3.8), radius: 20, label: 'where the sign is supposed to be' },
      { kind: 'photo', ...c.at(60, 3.8), radius: 25, label: 'photograph the absence, which is harder than it sounds' },
      { kind: 'ko', npc: c.ko, count: 1, label: 'the one who tells you photography is not allowed here' },
    ],
    hello: [
      (c) => `Two hundred and eighty-five dollars. ${c.st.name}. For a sign that is not there.`,
      (c) => `I have read the regulation ${c.yrs} times. It hinges entirely on the sign.`,
    ],
    offer: [
      () => `Go and photograph where it should be. The form has a box for evidence and the box assumes I am lying.`,
      (c) => `${c.who} says it came down years ago. Saying is not evidence.`,
    ],
    colour: [
      () => `It is not the money. It is the box.`,
      (c) => `I have got ${c.thing} of correspondence about this. All of it polite.`,
    ],
    done: [
      () => `Perfect. Absence, photographed. Let them argue with that.`,
      (c) => `That will do it. That will absolutely do it, ${c.grumble}.`,
    ],
  },
  {
    key: 'the-garden', role: 'guerrilla gardener',
    title: (c) => `The Strip Outside ${c.st.name}`,
    blurb: [
      (c) => `A metre of dirt between the fence and the footpath at ${c.st.name}, dead for ${c.yrs} years and not dead now. Council mows on the fifteenth and does not know what is in it. Stand near it and stop the man with the whipper snipper.`,
      (c) => `Nobody planted the strip at ${c.st.name}. I did, on ${c.day}, at ${c.hour}, so nobody would ask. I would like the fifteenth to go badly for council.`,
    ],
    steps: (c) => [
      { kind: 'goto', ...c.at(45, 1.4), radius: 18, label: 'the strip, which is a garden now' },
      { kind: 'ko', npc: 'tradie', count: 1, label: 'the man with the whipper snipper' },
      { kind: 'photo', ...c.at(45, 1.4), radius: 25, label: 'photograph it while it still exists' },
    ],
    hello: [
      (c) => `A metre of dirt at ${c.st.name}. ${c.yrs} years of nothing and cigarette ends.`,
      (c) => `Everything in there came out of a milk crate on my balcony at ${c.nb.name}.`,
    ],
    offer: [
      () => `The fifteenth. Be there. Be boring about it and he will go somewhere else.`,
      (c) => `${c.who} waters it now, which was not part of the plan and is the best thing about it.`,
    ],
    colour: [
      () => `Nobody is going to know I did it and that is the point of it.`,
      (c) => `I keep ${c.thing} by the door for exactly this.`,
    ],
    done: [
      () => `It survived. Next year it will be twice that and they will assume it was always there.`,
      (c) => `Good. Now do not tell ${c.who}. They will put in a form.`,
    ],
  },
  {
    key: 'the-shift', role: 'night-fill supervisor',
    title: (c) => `Night Fill, ${c.st.name}`,
    blurb: [
      (c) => `Ten to six, nobody in the building but us and a radio that gets one station. Somebody has been taking things and they know our roster, which means they come in off the late train at ${c.st.name}.`,
      (c) => `Started on ${c.day}. In off the ${c.st.name} late train, gone before the first delivery, every time, ${c.grumble}. Come in on the late one and watch the loading door.`,
    ],
    steps: (c) => [
      { kind: 'ride', line: -1, from: c.nb.name, to: c.st.name, label: 'come in on the late one like they do' },
      { kind: 'goto', ...c.at(75, 4.9), radius: 20, label: 'the loading door nobody watches' },
      { kind: 'ko', npc: c.ko, count: 2, label: 'whoever is standing in it at two in the morning' },
      { kind: 'earn', dollars: c.n2, label: `$${c.n2} of what they took, back` },
    ],
    hello: [
      () => `Ten to six. Six of us, forty aisles, one radio.`,
      (c) => `${c.yrs} years of nights. My body thinks ${c.hour} is lunchtime.`,
    ],
    offer: [
      (c) => `They come in off the late train at ${c.st.name}. Ride it in and see who else does.`,
      (c) => `${c.who}, possibly. I would rather be wrong about that.`,
    ],
    colour: [
      () => `You stop being able to tell whether you are tired or just awake at the wrong time.`,
      (c) => `They left ${c.thing} by the bins. That is how I know it is somebody who knows the place.`,
    ],
    done: [
      () => `Knew our roster. Of course they did. Nothing in this job is ever a stranger.`,
      (c) => `Right. I will sort it quietly, ${c.grumble}.`,
    ],
  },
  {
    key: 'the-window', role: 'first-floor tenant',
    title: (c) => `The Window Above ${c.st.name}`,
    blurb: [
      (c) => `I live above the platform at ${c.st.name} and I know this line by sound. Something in the rhythm changed about a month ago and everyone I tell thinks I am mad. Ride it and tell me whether I am mad.`,
      (c) => `${c.yrs} years above ${c.st.name}. I do not hear the trains any more, which means I hear it instantly when one of them is wrong. Since ${c.day} the joins sound different.`,
    ],
    steps: (c) => [
      { kind: 'ride', line: -1, from: c.st.name, to: c.nb.name, label: 'ride it and listen to the joins' },
      { kind: 'photo', ...c.at(35, 2.2), radius: 25, label: 'photograph the stretch that sounds wrong' },
      { kind: 'dialog', npc: '', node: 'ledger', label: 'tell me I am not mad' },
    ],
    hello: [
      (c) => `${c.yrs} years above ${c.st.name}. The trains stopped being noise about year two.`,
      (c) => `At ${c.hour} it is one train every four minutes and I could tell you which one from bed.`,
    ],
    offer: [
      (c) => `Ride to ${c.nb.name} and listen. You will hear it about halfway.`,
      (c) => `${c.who} says I am imagining it. ${c.who} sleeps at the back of the building.`,
    ],
    colour: [
      () => `Everyone says you get used to it. You do. That is the frightening part.`,
      (c) => `On ${c.day} they run the long ones and the whole flat moves.`,
    ],
    done: [
      () => `Thank you. Years of this and the first person who went and listened.`,
      () => `Then they did do something. I knew they had done something.`,
    ],
  },
  {
    key: 'the-market', role: 'stallholder',
    title: (c) => `Setting Up at ${c.st.name}`,
    blurb: [
      (c) => `Five in the morning at ${c.st.name}, in the dark, unloading a van by feel. The bloke in the next bay has started arriving at four to take half my frontage. I need a witness and I need them at four.`,
      (c) => `${c.yrs} years in the ${c.st.name} market. The bays are not allocated, they are *known*, and since ${c.day} somebody has decided that knowing does not count, ${c.grumble}.`,
    ],
    steps: (c) => [
      { kind: 'goto', ...c.at(85, 0.9), radius: 22, label: 'the bays, at the hour it happens' },
      { kind: 'ko', npc: c.ko, count: 1, label: 'the bloke with the extra trestle' },
      { kind: 'buy', powerup: c.pw, count: 1, label: 'you will want one at that hour' },
      { kind: 'earn', dollars: c.n2, label: `$${c.n2} of frontage, recovered` },
    ],
    hello: [
      (c) => `Five in the morning at ${c.st.name}, in the dark, unloading by feel.`,
      (c) => `${c.yrs} years. I have outlasted four councils and a fire.`,
    ],
    offer: [
      () => `He is coming at four now. There is no rule about four because nobody thought a person would do that.`,
      (c) => `${c.who} saw it and will not say so, because they have to stand next to him every ${c.day}.`,
    ],
    colour: [
      () => `You cannot write it down. That is the trouble with a thing everybody knows.`,
      (c) => `I have ${c.thing} that my father used on this same bay.`,
    ],
    done: [
      () => `Known again. Good.`,
      (c) => `He has moved down the end by ${c.nb.name}. Suits me.`,
    ],
  },
  {
    key: 'the-clock', role: 'station master',
    title: (c) => `The Clock at ${c.st.name}`,
    blurb: [
      (c) => `The clock on the ${c.st.name} platform has been four minutes fast since I got here and every relief who comes through wants to fix it. Do not fix it. Find out who set it that way, before they retire.`,
      (c) => `Somebody set the ${c.st.name} clock that way on purpose and everyone who knows why is nearly gone. The old crew drink near ${c.nb.name} on ${c.day}. Go and ask, ${c.grumble}.`,
    ],
    steps: (c) => [
      { kind: 'photo', ...c.at(25, 3.3), radius: 20, label: 'the clock, four minutes fast, for the file' },
      { kind: 'ride', line: -1, from: c.st.name, to: c.nb.name, label: `to ${c.nb.name}, where the old crew drink` },
      { kind: 'dialog', npc: '', node: 'ledger', label: 'bring the name back' },
    ],
    hello: [
      (c) => `Four minutes fast. Every relief through ${c.st.name} wants to be the one who fixes it.`,
      (c) => `${c.yrs} years on this platform and that clock has been wrong for all of them, deliberately.`,
    ],
    offer: [
      (c) => `Ask at ${c.nb.name}. They will be there on ${c.day}.`,
      (c) => `${c.who} will know. Buy them something first.`,
    ],
    colour: [
      () => `Half this network runs on things somebody decided in 1974 and never wrote down.`,
      (c) => `There is ${c.thing} in the office with half of it in pencil.`,
    ],
    done: [
      () => `Right. Then it stays four minutes fast, and now two of us know why.`,
      (c) => `Because of the ${c.hour} connection. Of course. That is beautiful.`,
    ],
  },
  {
    key: 'the-dog', role: 'someone at the end of their patience',
    title: (c) => `The Dog at ${c.st.name}`,
    blurb: [
      (c) => `A dog meets the 5:40 at ${c.st.name} every weekday and nobody gets off for it. Four months of this. I have decided it is not going to be a sad story. Find out whose it is.`,
      (c) => `Sits at the yellow line at ${c.st.name} at ${c.hour}, waits, then walks off on its own. Half the platform knows and nobody has done anything, including me, ${c.grumble}.`,
    ],
    steps: (c) => [
      { kind: 'goto', ...c.at(40, 4.4), radius: 20, label: 'the end of the platform, at twenty to six' },
      { kind: 'goto', ...c.at(140, 1.9), radius: 25, label: 'the street it walks home to' },
      { kind: 'dialog', npc: '', node: 'ledger', label: 'tell me it is not a sad story' },
    ],
    hello: [
      (c) => `Every weekday. The 5:40 into ${c.st.name}. Sits at the yellow line and waits.`,
      (c) => `Started around ${c.day}. Nobody can tell me when exactly, which bothers me.`,
    ],
    offer: [
      () => `Find out where it goes and who it belongs to. I am not doing another winter of watching that.`,
      (c) => `${c.who} feeds it, which is kind and is also why it keeps coming.`,
    ],
    colour: [
      () => `Half the platform knows. Nobody has done anything, including me.`,
      (c) => `Somebody left ${c.thing} out for it once. It has been there since.`,
    ],
    done: [
      () => `Not a sad story. I will take it. I badly needed one that was not.`,
      (c) => `${c.nb.name}? It walks to ${c.nb.name}? Every day?`,
    ],
  },
  {
    key: 'the-numbers', role: 'bookmaker of the informal kind',
    title: (c) => `The Book at ${c.st.name}`,
    blurb: [
      (c) => `I run a small book on things that are not races — weather, delays, whether the ${c.hour} out of ${c.st.name} runs on time. Somebody is beating it by information, not luck. Ride the run they ride.`,
      (c) => `Up four hundred over eleven weeks on the ${c.st.name} delay market. You cannot beat a delay book unless you can see the roster, ${c.grumble}. Think about who can see the roster.`,
    ],
    steps: (c) => [
      { kind: 'ride', line: -1, from: c.st.name, to: c.nb.name, label: 'ride the run they ride' },
      { kind: 'ko', npc: c.ko, count: 2, label: 'the two who follow you off it' },
      { kind: 'earn', dollars: c.n2, label: `$${c.n2} back off the book` },
    ],
    hello: [
      (c) => `Nothing illegal. A book on small things. Whether the ${c.hour} is on time, mostly.`,
      (c) => `${c.yrs} years of this and I have never been beaten by somebody lucky.`,
    ],
    offer: [
      (c) => `Ride to ${c.nb.name} on ${c.day} and watch what they watch.`,
      (c) => `${c.who} takes the same run. That may be nothing.`,
    ],
    colour: [
      () => `You cannot beat a delay book unless you can see the roster.`,
      (c) => `They pay in cash out of ${c.thing}. Every time.`,
    ],
    done: [
      () => `The roster. I am not even angry. I am going to hire them.`,
      (c) => `Knew it. Right, the delay market is closed as of ${c.day}.`,
    ],
  },
];

// --- placement ------------------------------------------------------------------------

const placed: { x: number; z: number }[] = existing.map((n) => ({ x: n.x, z: n.z }));
function clearSpot(st: Stn): { x: number; z: number } | null {
  for (let attempt = 0; attempt < 220; attempt++) {
    const r = 70 + rnd() * 130;
    const b = rnd() * Math.PI * 2;
    const x = Math.round(st.x + Math.cos(b) * r);
    const z = Math.round(st.z + Math.sin(b) * r);
    if (trackDist(x, z) < 24) continue;
    let clash = false;
    for (const p of placed) {
      if ((p.x - x) ** 2 + (p.z - z) ** 2 < 30 * 30) { clash = true; break; }
    }
    if (clash) continue;
    placed.push({ x, z });
    return { x, z };
  }
  return null;
}

/** A step target that is off the rails, or the giver's own feet if we cannot find one. */
function safePoint(gx: number, gz: number, r: number, b: number): { x: number; z: number } {
  for (let i = 0; i < 24; i++) {
    const x = Math.round(gx + Math.cos(b + i * 0.7) * (r + i * 6));
    const z = Math.round(gz + Math.sin(b + i * 0.7) * (r + i * 6));
    if (trackDist(x, z) >= 14) return { x, z };
  }
  return { x: gx, z: gz };
}

// --- compose --------------------------------------------------------------------------

const LEVELS = [80, 75, 70, 60, 55, 45, 40, 30, 25, 20]; // front-loaded: discovery is a rung-1 problem
const free = NAMES.filter((n) => !usedFirst.has(n.toLowerCase()));
let nameAt = 0;
const usedPair = new Set<string>();
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

interface Out { quests: unknown[]; npcs: unknown[] }
const byLevel = new Map<number, Out>();
let made = 0, skipped = 0;
const vagueBlurbs: string[] = [];

// Stations, shuffled once, then walked in order per level so the levels interleave
// across the city rather than each one clumping in the same suburbs.
const order = stations.slice();
for (let i = order.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [order[i], order[j]] = [order[j], order[i]];
}

let cursor = 0;
for (let lvl = 1; lvl <= 10 && made < WANT; lvl++) {
  const want = Math.min(LEVELS[lvl - 1], WANT - made);
  const out: Out = { quests: [], npcs: [] };
  byLevel.set(lvl, out);
  for (let k = 0; k < want; ) {
    const st = order[cursor % order.length]; cursor++;
    const arch = ARCH[(cursor + lvl * 7) % ARCH.length];
    const pairKey = `${arch.key}@${st.name}`;
    if (usedPair.has(pairKey)) { skipped++; if (skipped > WANT * 12) break; continue; }
    const spot = clearSpot(st);
    if (spot === null) { skipped++; continue; }
    usedPair.add(pairKey);
    if (nameAt >= free.length) break;
    const first = free[nameAt++];

    const nb = neighbour(st);
    const c: Ctx = {
      st, nb, gx: spot.x, gz: spot.z, lvl,
      n1: between(11, 98), n2: between(15, 25) + lvl * between(4, 9),
      cash: 30 + lvl * 14 + between(0, 25), ko: pick(KO), pw: pick(PW),
      at: (r, b) => safePoint(spot.x, spot.z, r, b),
      hour: pick(HOURS), day: pick(DAYS), yrs: between(4, 31), thing: pick(THINGS),
      grumble: pick(GRUMBLES), who: pick(WHO),
    };
    /**
     * One phrasing off the seeded stream, sentence-cased.
     *
     * The slots are written lowercase because most of them land mid-sentence
     * ("...tell ${c.who} I sent you"), but some templates open with one, and
     * "a kid who should be at school stopped coming" is the kind of thing that
     * makes a whole corpus read as machine output. Capitalising after a full
     * stop is unconditionally correct in prose, so it is done to the finished
     * line rather than guessed at per slot.
     */
    const say = (l: Line): string => {
      const raw = l[Math.floor(rnd() * l.length)](c);
      return raw.charAt(0).toUpperCase() + raw.slice(1).replace(/([.!?] )([a-z])/g, (_m, p, ch) => p + ch.toUpperCase());
    };
    const giverId = `field-${slug(st.name)}-${slug(first)}`;
    const questId = `f${lvl}-${arch.key}-${slug(st.name)}`;
    if (usedQuestId.has(questId)) { skipped++; continue; }
    usedQuestId.add(questId);

    // **Every blurb names its station.** That is the uniqueness argument --
    // archetype x station is unique by construction -- and the writing one: a
    // job that could be anywhere is a job that is nowhere. Checked here, where
    // the station is actually in scope, rather than reconstructed from the id
    // afterwards, which is how the first version of this check managed to be
    // wrong about 370 of them.
    const blurb = say(arch.blurb);
    if (!blurb.includes(st.name)) vagueBlurbs.push(questId);
    const steps = arch.steps(c).map((s) => (s.kind === 'dialog' ? { ...s, npc: giverId } : s));
    out.quests.push({
      id: questId, act: 3, title: arch.title(c), blurb, giver: giverId,
      level: lvl, requires: [], repeatable: false, steps,
      reward: { cash: c.cash, xp: 60 + lvl * 44 + between(0, 30), unlock: [`field:${questId}`] },
      needFlags: [lvl === 1 ? 'act0:trained' : 'act1:open'],
    });
    out.npcs.push({
      id: giverId, name: `${first}, ${arch.role} at ${st.name}`,
      x: spot.x, z: spot.z, radius: 5, root: 'hello',
      nodes: [
        { id: 'hello', line: say(arch.hello), choices: [
          { text: 'You after something?', goto: 'offer' },
          { text: 'How long have you been at this?', goto: 'colour' },
          { text: "I've done it.", goto: 'ledger' },
          { text: 'Not today.', goto: '' },
        ] },
        { id: 'offer', line: say(arch.offer), choices: [
          { text: "Alright. I'll do it.", accept: questId, denyFlag: `field:${questId}` },
          { text: 'Why me?', goto: 'colour' },
          { text: 'Find someone else.', goto: '' },
        ] },
        { id: 'colour', line: say(arch.colour), choices: [
          { text: 'Fine. Give it here.', goto: 'offer' },
          { text: 'Right.', goto: '' },
        ] },
        // The turn-in. Without a choice carrying `turnin` a job can be accepted
        // and never finished, which the gate calls out one line per quest and
        // is right to: an unfinishable quest is worse than no quest.
        { id: 'ledger', line: say(arch.done), choices: [
          { text: "That's it done.", turnin: questId },
          { text: 'Still on it.', goto: '' },
        ] },
      ],
    });
    made++; k++;
  }
}

// **Thirty to a pack, because the parser caps a pack at 32 npcs and 64 quests**
// and every field job carries its own giver, which makes 32 the binding one. A
// pack over the cap is refused *whole*, and a refused dialog pack takes all its
// givers with it -- which reads downstream as forty separate "quest is given by
// somebody who is not a dialog npc" errors and sends you looking in the wrong
// place entirely. Thirty leaves room to hand-add one later without resharding.
const PER_PACK = 30;
let packs = 0;
// **The repetition gate, and it is the reason this file was rewritten once.**
// The first cut gave every archetype a single blurb, so half the corpus shared
// its paragraph with another job and one line appeared verbatim 27 times. The
// titles were all unique, which made it look fine from a distance. A player who
// does three coffee runs reads the same paragraph three times and correctly
// concludes there is one quest here, not three. So: measured, and refused.
{
  const seen = new Map<string, number>();
  let worst = 0;
  for (const [, out] of byLevel) {
    for (const q of out.quests as { blurb: string }[]) {
      const n = (seen.get(q.blurb) ?? 0) + 1;
      seen.set(q.blurb, n);
      if (n > worst) worst = n;
    }
  }
  const shared = [...seen.values()].filter((n) => n > 1).reduce((a, b) => a + b, 0);
  console.log(`blurbs: ${seen.size} distinct across ${made}; worst repeat x${worst}; ${shared} share a paragraph`);
  if (vagueBlurbs.length > 0) {
    console.error(`REFUSED: ${vagueBlurbs.length} blurb(s) never name their station, e.g. ${vagueBlurbs[0]}.`);
    process.exit(1);
  }
  if (worst > 3) {
    console.error(`REFUSED: a blurb appears ${worst} times. Add phrasings or slots to that archetype.`);
    process.exit(1);
  }
}

for (const [lvl, out] of byLevel) {
  for (let i = 0; i < out.quests.length; i += PER_PACK) {
    const part = String.fromCharCode(97 + Math.floor(i / PER_PACK));
    const name = `field-l${lvl}${out.quests.length > PER_PACK ? part : ''}`;
    writeFileSync(join(CONTENT, 'quests', `${name}.json`),
      JSON.stringify({ pack: name, quests: out.quests.slice(i, i + PER_PACK) }, null, 1) + '\n');
    writeFileSync(join(CONTENT, 'dialog', `${name}.json`),
      JSON.stringify({ pack: name, npcs: out.npcs.slice(i, i + PER_PACK) }, null, 1) + '\n');
    packs++;
  }
  console.log(`level ${lvl}: ${out.quests.length} quests`);
}
console.log(`${packs} packs written, <= ${PER_PACK} givers each`);
console.log(`\ntotal ${made} field quests, ${skipped} placements retried, ${free.length - nameAt} names spare`);
