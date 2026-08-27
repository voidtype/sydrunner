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
}
interface Arch {
  key: string; role: string;
  title: (c: Ctx) => string;
  blurb: (c: Ctx) => string;
  steps: (c: Ctx) => Step[];
  hello: (c: Ctx) => string;
  offer: (c: Ctx) => string;
  colour: (c: Ctx) => string;
  done: (c: Ctx) => string;
}

const KO = ['karen', 'tradie', 'drunk', 'eshay', 'rbt', 'police'];
const PW = ['FLAT WHITE', 'TRAINING'];

const ARCH: Arch[] = [
  {
    key: 'last-service', role: 'night guard',
    title: (c) => `Last Service out of ${c.st.name}`,
    blurb: (c) => `The last one through ${c.st.name} carries four people and one of them is always asleep. Ride it to ${c.nb.name}, photograph what the platform looks like with nobody on it, and come back and tell me it is still there.`,
    steps: (c) => [
      { kind: 'ride', line: -1, from: c.st.name, to: c.nb.name, label: `ride the late one to ${c.nb.name}` },
      { kind: 'photo', ...c.at(40, 1.1), radius: 30, label: 'the empty platform, lit and pointless' },
      { kind: 'dialog', npc: '', node: 'ledger', label: 'tell them what you saw' },
    ],
    hello: (c) => `You get to know the last service. Four people out of ${c.st.name} and one of them is asleep every single night, and it is never the same one.`,
    offer: (c) => `Ride it to ${c.nb.name}. Photograph the platform with nobody on it. I want to know the place exists when I am not standing in it.`,
    colour: () => `Twenty-two years. I have watched this place empty out twenty-two years and I still do not like the sound it makes.`,
    done: () => `There it is. Still there. Good. Some nights I am not sure.`,
  },
  {
    key: 'opal-ghost', role: 'ticket inspector',
    title: (c) => `The ${c.st.name} Tap-Off`,
    blurb: (c) => `Somebody taps on at ${c.st.name} every morning and never taps off. Same card. I want you to ride the run they ride and find where a person can get off this network without a gate seeing them.`,
    steps: (c) => [
      { kind: 'ride', line: -1, from: c.st.name, to: c.nb.name, label: 'ride the run the card rides' },
      { kind: 'goto', ...c.at(70, 2.4), radius: 20, label: 'the gap in the fence everyone knows about' },
      { kind: 'photo', ...c.at(70, 2.4), radius: 25, label: 'photograph the gap before somebody welds it' },
    ],
    hello: (c) => `Card ending ${c.n1}. Taps on at ${c.st.name}, six-forty, every weekday. Never taps off. Not once in four months.`,
    offer: (c) => `I am not allowed to follow it and you are not employed, which makes you better at this than me. Find where they get off.`,
    colour: () => `It is not the money. It is ninety cents a day. It is that I cannot work out how.`,
    done: () => `A hole in a fence. Four months. I want to be angry and mostly I am impressed.`,
  },
  {
    key: 'coffee-run', role: 'kiosk operator',
    title: (c) => `The ${c.st.name} Order`,
    blurb: (c) => `I do two hundred coffees between six and nine and I know every one of them by the walk. One of my regulars stopped coming. Take a coffee to where they work and find out whether they are dead or just went to the other place.`,
    steps: (c) => [
      { kind: 'buy', powerup: c.pw, count: 1, label: `order one at the ${c.st.name} kiosk` },
      { kind: 'goto', ...c.at(120, 0.6), radius: 25, label: 'the office they walk to, or used to' },
      { kind: 'earn', dollars: c.n2, label: `come back with $${c.n2} — I am not running a charity` },
    ],
    hello: (c) => `Two hundred a morning through ${c.st.name}. I know them by the walk before I know them by the face.`,
    offer: () => `One of them stopped. Three weeks. Take one over there and find out if I lost them to the chain up the road.`,
    colour: () => `If it is the chain I would rather they were dead. I am joking. Mostly.`,
    done: () => `The chain. Of course it was the chain. Thank you for finding out. I hate it.`,
  },
  {
    key: 'timetable-lie', role: 'relief signaller',
    title: (c) => `Four Minutes at ${c.st.name}`,
    blurb: (c) => `The board at ${c.st.name} says four minutes. It has said four minutes for as long as anyone can remember and it is a lie about a third of the time. Stand there. Time it. Bring me numbers instead of feelings.`,
    steps: (c) => [
      { kind: 'goto', ...c.at(30, 3.0), radius: 18, label: 'stand under the board and wait like everyone else' },
      { kind: 'photo', ...c.at(30, 3.0), radius: 25, label: 'photograph the board saying four minutes' },
      { kind: 'ride', line: -1, from: c.st.name, to: c.nb.name, label: 'ride the one that finally comes' },
      { kind: 'dialog', npc: '', node: 'ledger', label: 'give me the number' },
    ],
    hello: (c) => `Four minutes. That board has said four minutes since before the merge. Sometimes it means four minutes.`,
    offer: () => `Nobody upstairs believes me because I have no data, only twelve years. Go and get me data.`,
    colour: () => `A minute of a stranger's life, three hundred times a day. Somebody should write it down.`,
    done: () => `Right. Now I have a number, and a number is a thing they have to answer.`,
  },
  {
    key: 'lost-property', role: 'lost property clerk',
    title: (c) => `Unclaimed at ${c.st.name}`,
    blurb: (c) => `Everything anyone has ever left on a train ends up in a room, and the room is full. Most of it nobody wants. One of them somebody wants very badly and has not come to ask. Find out why.`,
    steps: (c) => [
      { kind: 'goto', ...c.at(55, 4.2), radius: 20, label: 'the address on the tag' },
      { kind: 'ko', npc: c.ko, count: 2, label: 'the two who got there before you' },
      { kind: 'earn', dollars: c.n2, label: `$${c.n2} — whatever it is, it is worth that to somebody` },
    ],
    hello: (c) => `Umbrellas. Nine hundred umbrellas. And one thing off the ${c.st.name} line that has a name on it and a phone number that rings out.`,
    offer: () => `I cannot leave the counter. You can. Go to the address on the tag and see who is not answering.`,
    colour: () => `People come back for the strangest things. Nobody ever comes back for an umbrella.`,
    done: () => `That explains the phone. Poor sod. Put it back in the room, would you.`,
  },
  {
    key: 'quiet-carriage', role: 'commuter of long standing',
    title: (c) => `The Quiet Carriage, ${c.st.name}`,
    blurb: (c) => `There is a sign and the sign is not enforced by anybody, which makes it the only law in this city that runs on shame. Somebody has stopped feeling it. Ride the ${c.st.name} run and deal with it.`,
    steps: (c) => [
      { kind: 'ride', line: -1, from: c.st.name, to: c.nb.name, label: 'ride the quiet carriage and observe the crime' },
      { kind: 'ko', npc: c.ko, count: 1, label: 'apply the shame manually' },
      { kind: 'photo', ...c.at(45, 5.1), radius: 30, label: 'photograph the sign, for the record' },
    ],
    hello: () => `The quiet carriage works because everyone agrees it works. That is the whole mechanism. There is no other mechanism.`,
    offer: (c) => `Speakerphone. Every morning, ${c.st.name} to town, speakerphone. I have made eye contact eleven times and it has done nothing.`,
    colour: () => `I could move carriages. I have thought about it. But then they have won something.`,
    done: () => `Quiet. Genuinely quiet. I had forgotten what it sounded like.`,
  },
  {
    key: 'the-shortcut', role: 'courier',
    title: (c) => `The ${c.st.name} Shortcut`,
    blurb: (c) => `Every courier in this city has a route that is not on any map and mine goes through ${c.st.name}. They have started locking one end of it. Go and find out whether it is locked forever or just locked today.`,
    steps: (c) => [
      { kind: 'goto', ...c.at(90, 1.7), radius: 22, label: 'the end they lock' },
      { kind: 'goto', ...c.at(150, 3.6), radius: 25, label: 'the long way round, so you understand what it costs me' },
      { kind: 'earn', dollars: c.n2, label: `$${c.n2}, which is what the long way costs me a week` },
    ],
    hello: (c) => `Forty drops a day. The difference between the shortcut and the long way at ${c.st.name} is nine minutes, and nine minutes is four drops.`,
    offer: () => `Go and look at the lock. Tell me if it is a padlock or a decision.`,
    colour: () => `A padlock I can live with. A decision I have to reroute around for the rest of my life.`,
    done: () => `A decision. Right. Nine minutes, forever. That is what that is.`,
  },
  {
    key: 'night-works', role: 'trackwork foreman',
    title: (c) => `Possession at ${c.st.name}`,
    blurb: (c) => `We own the track between midnight and four and in that window we are the only people in this city doing anything real. Somebody keeps walking through my possession. Find them before a rail grinder does.`,
    steps: (c) => [
      { kind: 'goto', ...c.at(65, 2.9), radius: 20, label: 'where they come through the fence' },
      { kind: 'ko', npc: c.ko, count: c.n1 % 3 + 1, label: 'the ones who think a hard hat is a costume' },
      { kind: 'photo', ...c.at(65, 2.9), radius: 30, label: 'photograph the gap so I can put a number on the form' },
    ],
    hello: (c) => `Midnight to four, ${c.st.name} is mine. Nobody thanks you for it and nobody sees it and by six it looks like nothing happened.`,
    offer: () => `Somebody is walking through. Not kids. Kids run. This one walks.`,
    colour: () => `You do not get a second warning out here. You get a grinder and a very long report.`,
    done: () => `Good. Now I can fill in a form and somebody else can ignore it.`,
  },
  {
    key: 'the-regular', role: 'publican',
    title: (c) => `The ${c.st.name} Regular`,
    blurb: (c) => `A man drank in my front bar for nineteen years and then stopped, and nobody in this suburb will tell me why. You are not from here, which makes you the only person who can ask.`,
    steps: (c) => [
      { kind: 'goto', ...c.at(110, 0.3), radius: 25, label: 'the house they say he moved to' },
      { kind: 'buy', powerup: c.pw, count: 1, label: 'you cannot ask a favour empty-handed' },
      { kind: 'dialog', npc: '', node: 'ledger', label: 'come back and tell me straight' },
    ],
    hello: (c) => `Nineteen years. Same stool. Then nothing, and every regular in this bar has gone vague on me at once, which means they know.`,
    offer: () => `Go and knock. You have got a face nobody here owes anything to.`,
    colour: () => `I have kept the stool. That is either respect or superstition, I have stopped being able to tell.`,
    done: () => `Ah. Well. I will keep the stool anyway.`,
  },
  {
    key: 'car-park', role: 'commuter car park attendant',
    title: (c) => `Bay 14, ${c.st.name}`,
    blurb: (c) => `Two hundred bays, two hundred and forty cars, and one of them has not moved since March. It has a ticket on it from March. I have watched people give up and park on the grass because of it.`,
    steps: (c) => [
      { kind: 'photo', ...c.at(50, 4.7), radius: 25, label: 'the car, and the ticket, and the date on it' },
      { kind: 'ko', npc: c.ko, count: 2, label: 'the two arguing over the grass' },
      { kind: 'earn', dollars: c.n2, label: `$${c.n2} in fines nobody is going to collect` },
    ],
    hello: (c) => `Two hundred bays at ${c.st.name}. I have counted two hundred and forty cars in here on a Tuesday. Do that arithmetic.`,
    offer: () => `Bay 14 has not moved since March. Photograph it. I want a date somebody can be embarrassed by.`,
    colour: () => `You cannot tow it without an owner and you cannot find an owner without towing it. That is the whole job.`,
    done: () => `March. In writing. Now it is somebody else's March.`,
  },
  {
    key: 'the-mural', role: 'council contractor',
    title: (c) => `Whatever Is Under the Grey at ${c.st.name}`,
    blurb: (c) => `Council pays me to paint over things. Last week I painted over something good and I have been sick about it since. There is another one two streets from ${c.st.name}. Photograph it before Thursday.`,
    steps: (c) => [
      { kind: 'goto', ...c.at(130, 2.1), radius: 25, label: 'the wall, before Thursday' },
      { kind: 'photo', ...c.at(130, 2.1), radius: 30, label: 'photograph it properly, not a phone-in-a-hurry job' },
      { kind: 'dialog', npc: '', node: 'ledger', label: 'show me' },
    ],
    hello: () => `Grey. I have one colour and it is grey and it is the same grey in every suburb in this city.`,
    offer: (c) => `There is one near ${c.st.name} that I am scheduled to kill on Thursday. I would like something of it to exist afterwards.`,
    colour: () => `I keep the photos. Two hundred and eleven of them. It is the worst gallery in Australia.`,
    done: () => `Two hundred and twelve. Right. Thursday can have the wall.`,
  },
  {
    key: 'the-hill', role: 'bus driver on a break',
    title: (c) => `The Hill Above ${c.st.name}`,
    blurb: (c) => `I drive past the same view eleven times a shift and I have never once stopped at it. You have got legs and no timetable. Go up there and photograph what I have been driving past for six years.`,
    steps: (c) => [
      { kind: 'goto', ...c.at(180, 5.5), radius: 30, label: 'up the hill, the way the road does not go' },
      { kind: 'photo', ...c.at(180, 5.5), radius: 40, label: 'the view I have never stopped for' },
      { kind: 'earn', dollars: c.n2, label: `$${c.n2}, because I am paying you for it` },
    ],
    hello: (c) => `Eleven times a shift past ${c.st.name} and up over that hill. Six years. Never stopped.`,
    offer: () => `I am not going to stop. That is not the kind of person I turned out to be. So you go.`,
    colour: () => `There is a bench up there. I have watched it from a moving bus about fourteen thousand times.`,
    done: () => `That is what it looks like. Right. That is what it looks like.`,
  },
  {
    key: 'the-fine', role: 'someone with a grievance',
    title: (c) => `Contesting It at ${c.st.name}`,
    blurb: (c) => `I got done for something I did not do at ${c.st.name} and the form says I need evidence, and the evidence is a sign that is not where the sign is supposed to be. Go and photograph the sign not being there.`,
    steps: (c) => [
      { kind: 'goto', ...c.at(60, 3.8), radius: 20, label: 'where the sign is supposed to be' },
      { kind: 'photo', ...c.at(60, 3.8), radius: 25, label: 'photograph the absence, which is harder than it sounds' },
      { kind: 'ko', npc: c.ko, count: 1, label: 'the one who tells you photography is not allowed here' },
    ],
    hello: (c) => `Two hundred and eighty-five dollars. ${c.st.name}. For a thing the sign did not say, because the sign is not there.`,
    offer: () => `The form wants evidence. How do you photograph a thing not being somewhere? That is your problem now.`,
    colour: () => `It is not the money. It is that the form has a box for it and the box assumes I am lying.`,
    done: () => `Perfect. Absence, photographed. Let them argue with that.`,
  },
  {
    key: 'the-garden', role: 'guerrilla gardener',
    title: (c) => `The Strip Outside ${c.st.name}`,
    blurb: (c) => `There is a metre of dirt between the fence and the footpath at ${c.st.name} and it has been dead for eleven years. It is not dead now. I need someone to stand near it and stop a man with a whipper snipper.`,
    steps: (c) => [
      { kind: 'goto', ...c.at(45, 1.4), radius: 18, label: 'the strip, which is a garden now' },
      { kind: 'ko', npc: 'tradie', count: 1, label: 'the man with the whipper snipper' },
      { kind: 'photo', ...c.at(45, 1.4), radius: 25, label: 'photograph it while it still exists' },
    ],
    hello: (c) => `A metre of dirt at ${c.st.name}. Eleven years of nothing and cigarette ends.`,
    offer: () => `Council mows it on the fifteenth. Council does not know what is in it. I would like the fifteenth to go badly for council.`,
    colour: () => `Nobody planted it. I planted it. Nobody is going to know that and that is the point of it.`,
    done: () => `It survived. Good. Next year it will be twice that and they will assume it was always there.`,
  },
  {
    key: 'the-shift', role: 'night-fill supervisor',
    title: (c) => `Night Fill, ${c.st.name}`,
    blurb: (c) => `Ten to six, nobody in the building but us and a radio. Somebody has been taking things and it is not one of mine, which means it is somebody who knows our roster. Ride in on the late one and watch the door.`,
    steps: (c) => [
      { kind: 'ride', line: -1, from: c.nb.name, to: c.st.name, label: 'come in on the late one like they do' },
      { kind: 'goto', ...c.at(75, 4.9), radius: 20, label: 'the loading door nobody watches' },
      { kind: 'ko', npc: c.ko, count: 2, label: 'whoever is standing in it at two in the morning' },
      { kind: 'earn', dollars: c.n2, label: `$${c.n2} of what they took, back` },
    ],
    hello: () => `Ten to six. Six of us, forty aisles, one radio that only gets the one station.`,
    offer: (c) => `Somebody knows our roster. They come in off the late train at ${c.st.name} and they are gone before the first delivery.`,
    colour: () => `I have worked nights eight years. You stop being able to tell whether you are tired or just awake at the wrong time.`,
    done: () => `Knew our roster. Of course they did. Nothing in this job is ever a stranger.`,
  },
  {
    key: 'the-window', role: 'first-floor tenant',
    title: (c) => `The Window Above ${c.st.name}`,
    blurb: (c) => `I live above the platform at ${c.st.name} and I know this line by sound. Something in the rhythm changed about a month ago and everyone I tell thinks I am mad. Ride it and tell me whether I am mad.`,
    steps: (c) => [
      { kind: 'ride', line: -1, from: c.st.name, to: c.nb.name, label: 'ride it and listen to the joins' },
      { kind: 'photo', ...c.at(35, 2.2), radius: 25, label: 'photograph the stretch that sounds wrong' },
      { kind: 'dialog', npc: '', node: 'ledger', label: 'tell me I am not mad' },
    ],
    hello: (c) => `Nine years above ${c.st.name}. I do not hear the trains any more, which means I hear it instantly when one of them is wrong.`,
    offer: () => `A month ago the rhythm changed. Same trains, different sound. Go and find out what they did to my track.`,
    colour: () => `Everyone says you get used to it. You do. That is the frightening part.`,
    done: () => `Thank you. Nine years and the first person who went and listened.`,
  },
  {
    key: 'the-market', role: 'stallholder',
    title: (c) => `Setting Up at ${c.st.name}`,
    blurb: (c) => `Five in the morning, in the dark, and the bloke with the bay next to mine has started arriving at four to take half my frontage. I need a witness and I need them at four.`,
    steps: (c) => [
      { kind: 'goto', ...c.at(85, 0.9), radius: 22, label: 'the bays, at the hour it happens' },
      { kind: 'ko', npc: c.ko, count: 1, label: 'the bloke with the extra trestle' },
      { kind: 'buy', powerup: c.pw, count: 1, label: 'you will want one at that hour' },
      { kind: 'earn', dollars: c.n2, label: `$${c.n2} of frontage, recovered` },
    ],
    hello: (c) => `Five in the morning at ${c.st.name}, in the dark, unloading a van by feel.`,
    offer: () => `He is coming at four now. Four. There is no rule about four because nobody thought a person would do that.`,
    colour: () => `Twenty-six years in this market. The bays are not allocated. They are just known.`,
    done: () => `Known again. Good. You cannot write it down, that is the trouble with it.`,
  },
  {
    key: 'the-clock', role: 'station master',
    title: (c) => `The Clock at ${c.st.name}`,
    blurb: (c) => `The clock on this platform has been four minutes fast since I got here and every relief who comes through wants to fix it. Do not fix it. Go and find out who set it, before they retire.`,
    steps: (c) => [
      { kind: 'photo', ...c.at(25, 3.3), radius: 20, label: 'the clock, four minutes fast, for the file' },
      { kind: 'ride', line: -1, from: c.st.name, to: c.nb.name, label: `to ${c.nb.name}, where the old crew drink` },
      { kind: 'dialog', npc: '', node: 'ledger', label: 'bring the name back' },
    ],
    hello: (c) => `Four minutes fast. Every relief who comes through ${c.st.name} wants to be the one who fixes it.`,
    offer: () => `Somebody set it that way on purpose and everybody who knows why is nearly gone. Find out before they are.`,
    colour: () => `Half this network runs on things somebody decided in 1974 and never wrote down.`,
    done: () => `Right. Then it stays four minutes fast, and now two of us know why.`,
  },
  {
    key: 'the-dog', role: 'someone at the end of their patience',
    title: (c) => `The Dog at ${c.st.name}`,
    blurb: (c) => `There is a dog that meets the 5:40 at ${c.st.name} every weekday and has done for months, and nobody gets off for it. I have decided this is not going to be a sad story. Find out whose it is.`,
    steps: (c) => [
      { kind: 'goto', ...c.at(40, 4.4), radius: 20, label: 'the end of the platform, at twenty to six' },
      { kind: 'goto', ...c.at(140, 1.9), radius: 25, label: 'the street it walks home to' },
      { kind: 'dialog', npc: '', node: 'ledger', label: 'tell me it is not a sad story' },
    ],
    hello: (c) => `Every weekday. The 5:40 into ${c.st.name}. Sits at the yellow line and waits and then walks off on its own.`,
    offer: () => `I am not doing another winter of watching that. Find out where it goes and who it belongs to.`,
    colour: () => `Half the platform knows. Nobody has done anything, including me, for four months.`,
    done: () => `Not a sad story. I will take it. I badly needed one that was not.`,
  },
  {
    key: 'the-numbers', role: 'bookmaker of the informal kind',
    title: (c) => `The Book at ${c.st.name}`,
    blurb: (c) => `I run a small book on things that are not races and someone is beating it. Not by much and not by luck. Ride the run they ride, watch what they watch, and tell me what they know that I do not.`,
    steps: (c) => [
      { kind: 'ride', line: -1, from: c.st.name, to: c.nb.name, label: 'ride the run they ride' },
      { kind: 'ko', npc: c.ko, count: 2, label: 'the two who follow you off it' },
      { kind: 'earn', dollars: c.n2, label: `$${c.n2} back off the book` },
    ],
    hello: (c) => `Nothing illegal. A book on small things. Weather, delays, whether the 7:02 out of ${c.st.name} is on time.`,
    offer: () => `Somebody is up four hundred over eleven weeks on the delay market. That is not luck, that is information.`,
    colour: () => `You cannot beat a delay book unless you can see the roster. Think about who can see the roster.`,
    done: () => `The roster. I am not even angry. I am going to hire them.`,
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
    };
    const giverId = `field-${slug(st.name)}-${slug(first)}`;
    const questId = `f${lvl}-${arch.key}-${slug(st.name)}`;
    if (usedQuestId.has(questId)) { skipped++; continue; }
    usedQuestId.add(questId);

    const steps = arch.steps(c).map((s) => (s.kind === 'dialog' ? { ...s, npc: giverId } : s));
    out.quests.push({
      id: questId, act: 3, title: arch.title(c), blurb: arch.blurb(c), giver: giverId,
      level: lvl, requires: [], repeatable: false, steps,
      reward: { cash: c.cash, xp: 60 + lvl * 44 + between(0, 30), unlock: [`field:${questId}`] },
      needFlags: [lvl === 1 ? 'act0:trained' : 'act1:open'],
    });
    out.npcs.push({
      id: giverId, name: `${first}, ${arch.role} at ${st.name}`,
      x: spot.x, z: spot.z, radius: 5, root: 'hello',
      nodes: [
        { id: 'hello', line: arch.hello(c), choices: [
          { text: 'You after something?', goto: 'offer' },
          { text: 'How long have you been at this?', goto: 'colour' },
          { text: "I've done it.", goto: 'ledger' },
          { text: 'Not today.', goto: '' },
        ] },
        { id: 'offer', line: arch.offer(c), choices: [
          { text: "Alright. I'll do it.", accept: questId, denyFlag: `field:${questId}` },
          { text: 'Why me?', goto: 'colour' },
          { text: 'Find someone else.', goto: '' },
        ] },
        { id: 'colour', line: arch.colour(c), choices: [
          { text: 'Fine. Give it here.', goto: 'offer' },
          { text: 'Right.', goto: '' },
        ] },
        // The turn-in. Without a choice carrying `turnin` a job can be accepted
        // and never finished, which the gate calls out one line per quest and
        // is right to: an unfinishable quest is worse than no quest.
        { id: 'ledger', line: arch.done(c), choices: [
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
