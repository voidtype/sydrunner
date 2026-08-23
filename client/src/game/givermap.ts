/**
 * Who has a job for you, on the map, out to five hundred metres.
 *
 * The owner, standing in Sydney Park, unable to find the man with the `!` over
 * his head: *"im in syd park, cant see quest giver, show a minimap as i run
 * around and put him on the minimap with a yellow !"*, and then *"show all
 * quests within 500m on minimap"*. Three things had to change for that sentence
 * to be true and this file is the middle one.
 *
 * The first is `game/phone.minimapScale`, which used to answer 0 unless the
 * phone was in a hand -- a map you must swap a weapon to read is a map you do
 * not read, and the register is unusable without one. The third is
 * `minimap.ts`, which draws the thing. This is the part in between: **which
 * givers, and how far**, as a pure function of the same content and the same
 * player facts the street mark and the dialog panel are drawn from.
 *
 * ---------------------------------------------------------------------------
 * IT ASKS THE REGISTER RATHER THAN THE BUNDLE, AND THAT IS THE WHOLE SAFETY
 * PROPERTY
 *
 * The tempting version of this feature walks the quest list, keeps the ones
 * whose `level` matches the player's rung, and draws a dot at each giver. It is
 * three lines shorter and it is wrong in a way that only shows up after a
 * player has crossed the city: the rung is not the only gate. A quest has a
 * faction, a `requires` chain, `needFlags`, `denyFlags`, a weekly cooldown and
 * -- since the tutorial pass -- an `anyRung` exemption, and any one of them can
 * refuse a job the rung would allow.
 *
 * So this file does not have an opinion. It asks `questmodel.markerFor` with
 * the live facts, which is the *same* function `world/questmarkers.ts` hangs
 * the street mark off and which reaches through the *same* `choiceRefusal` the
 * dialog panel greys its buttons with. Three readers, one rule. The map can
 * therefore never point at a job that would be refused when you got there, and
 * `anyRung` -- which is brand new and which nothing here mentions by name --
 * falls out for free, because the exemption lives in `questRefusal` where it
 * belongs and every reader of that function inherited it on the day it landed.
 *
 * It also means the `?` costs nothing. `markerFor` already answers `'turnin'`
 * for a giver holding a finished job, having ordered it ahead of `'offer'` on
 * WoW's own reasoning, so the pair of glyphs on the map is the pair of glyphs
 * in the street with no second decision behind it.
 *
 * ---------------------------------------------------------------------------
 * FIVE HUNDRED METRES, AGAINST THE STREET MARK'S HUNDRED AND FIFTY
 *
 * `world/questmarkers.MARKER_RANGE_M` is 150 because past two blocks a floating
 * glyph in the world is a picket fence over a skyline. That argument is about
 * *the street*, and it does not transfer: a map is read for what is around you
 * and 500 m is the walk you would actually make on being told there is
 * something there. It is also, deliberately, **not the whole city**. A map that
 * listed every giver in Greater Sydney would be a quest log with a picture
 * behind it, which is the same refusal `main.ts` writes out for the ambient
 * events and the raves -- a map that shows you what is out there is a quest
 * list, and one that shows you what you are near is a map.
 *
 * The number is therefore this file's and not the sink's: the source culls at
 * `GIVER_RANGE_M` whatever radius it is handed, so the big map at its nine
 * kilometre zoom shows the same dozen givers the compass does rather than the
 * content pool.
 *
 * ---------------------------------------------------------------------------
 * TWELVE, NEAREST FIRST, AND THE HERO IS NEVER THE ONE THAT GOES
 *
 * `world/questmarkers.MAX_MARKERS`'s number and its eviction rule, for
 * different reasons that arrive at the same place. There it is a buffer size --
 * twenty-two quads a marker, rewritten per frame. Here it is legibility: a
 * 210 px disc with thirty gold glyphs on it is a disc with no city visible
 * under it, and the figure-ground plan `minimap.ts` spends four paragraphs
 * defending is the thing being spent.
 *
 * At the cap the **furthest** candidates are dropped, which is the ordering the
 * street mark does not have (it takes bundle order) and which a map has to,
 * because a map is a picture of where you are. `dropped` counts them, so a
 * player standing in a CBD block full of givers can see on the console that the
 * map is showing twelve of nineteen rather than wondering why one is missing.
 *
 * The one exception is the same one the street mark makes: a `'hero'` giver --
 * `questmodel.NPC_MARKER.HERO`, which today is the Ladmaster and nothing else
 * -- is never evicted by an ordinary one, however much nearer the ordinary one
 * is. A tutorial that loses a coin toss with the twelfth pool giver is a
 * tutorial that sometimes does not happen, and the player it fails is by
 * definition the one who does not know anything is missing.
 *
 * ---------------------------------------------------------------------------
 * THE GOLD LIVES HERE, WHICH IS NOT WHERE IT WAS ARGUED
 *
 * `world/questmarkers.ts` chose it and its header still carries the argument --
 * the owner asked for yellow, WoW's pair is yellow twice over, and the glyph
 * rather than the hue is what separates the `!` from the `?`. What could not
 * stay there is the **literal**, because that module imports `three/webgpu` and
 * two of the three things that now need the number cannot: `minimap.ts` is a
 * 2D canvas overlay, and `verifyGiverMap` runs in the Bun server's boot list
 * where there is no renderer at all.
 *
 * So the triple moved to the one file all three can import and the argument
 * stayed where it was made. The alternative -- a hex typed into `minimap.ts`
 * beside the other eleven -- is exactly the failure `markerInk`'s own header
 * describes: two owners of one colour, drifting apart the first time either is
 * retuned, and the symptom is a mark over a giver's head that is not the colour
 * of the dot pointing at him.
 *
 * ---------------------------------------------------------------------------
 * FOUR HERTZ, ON SOMEBODY ELSE'S CLOCK
 *
 * `markerFor` walks an NPC's whole dialog tree, and the compass redraws fifteen
 * times a second. Running the decision on the redraw would be the cost
 * `world/questmarkers.ts` already refuses at 120 Hz, arrived at from a
 * different direction.
 *
 * So `GiverDots.refresh` recomputes only when the beat it is handed changes,
 * and the beat it is handed is `QuestMarkerField.beats` -- literally the same
 * counter, so the marks in the street and the dots on the map are one sweep's
 * two outputs and cannot be a beat apart. What is left at 15 Hz is a loop over
 * at most twelve records with two subtractions in it.
 *
 * The staleness that buys is bounded and boring: at a sprint (8.2 m/s) a beat
 * is 2 m, against a 500 m cut and a cap that orders by distance. What is *not*
 * stale is the direction a clamped marker points, because the rim clamp is
 * `minimap.ts`'s and runs against the live centre on every redraw. See
 * `rimFraction`.
 */

import {
  NPC_MARKER,
  STEP_KIND,
  markerFor,
  questView,
  type DialogChoice,
  type DialogNpc,
  type PlayerFacts,
  type Quest,
  type QuestStep,
  type QuestView,
} from './questmodel.ts';

// `STEP_KIND` and `questView` are `verifyGiverMap`'s alone: the running feature
// never builds a quest, it only ever reads one somebody else parsed. They are up
// here with everything else rather than in a second import beside the check,
// because an import is hoisted wherever it is written and a reader looking for
// what this module depends on should find all of it in one place.

// --- The numbers ----------------------------------------------------------------

/**
 * How far a giver is worth putting on a map, in metres. The owner's number.
 *
 * Read by the source (which culls to it) *and* by the compass's sink (which
 * refuses to clamp anything beyond it to its rim), so the two halves of "within
 * 500 m" cannot disagree. See the header for why it is not the sink's radius.
 */
export const GIVER_RANGE_M = 500;

/**
 * How many may be on the map at once. `world/questmarkers.MAX_MARKERS`'s twelve.
 *
 * Not imported from there, because that module is a renderer and this one is
 * compiled into a server with no `three` in it; the two are one number for two
 * reasons and the header says which. Twelve is the legibility ceiling of a
 * 210 px disc, and it is the buffer size of a mesh -- if either moves, the
 * other should be looked at rather than followed.
 */
export const MAX_GIVER_DOTS = 12;

/**
 * The gold, as the renderer wants it and as a canvas wants it.
 *
 * One triple, two spellings, and the second is derived from the first at module
 * load so there is nothing to keep in step by hand. `world/questmarkers.ts`
 * reads the triple for its `MeshBasicNodeMaterial`; `minimap.ts` reads the
 * string for `markerInk`. See the header for why the literal is in this file
 * and the argument for it is in that one.
 */
export const GIVER_GOLD = { r: 1, g: 0.82, b: 0.16 } as const;

/** `GIVER_GOLD` as CSS, rounded the way a canvas would round it anyway. */
export const GIVER_GOLD_CSS = `rgb(${Math.round(GIVER_GOLD.r * 255)},${Math.round(
  GIVER_GOLD.g * 255,
)},${Math.round(GIVER_GOLD.b * 255)})`;

/**
 * Where a clamped marker sits, as a fraction of the disc's radius.
 *
 * Not 1. A glyph centred exactly on the rim is a glyph half of which is outside
 * the element's `border-radius` clip, so the `!` loses its dot and the `?`
 * loses its tail -- and the two glyphs are told apart by precisely those
 * features. At 0.92 of a 103 px radius the mark sits 8 px in, which clears a
 * 9 px glyph and still reads as belonging to the edge rather than to the city.
 */
export const RIM_SEAT = 0.92;

// --- The rim clamp ----------------------------------------------------------------

/**
 * How far along the offset to a marker it is actually drawn: 1 inside the disc,
 * less than 1 for one clamped to the rim.
 *
 * A **fraction rather than a point**, which is what makes the whole clamp one
 * multiply per axis in the caller and testable here with no canvas: the caller
 * has `(dx, dz)` in hand already, and scaling both by the same number is by
 * construction a move along the line to the target. So the bearing of a clamped
 * marker is the true bearing, exactly, at every distance -- there is no
 * arithmetic in which it could stop being, which matters because a rim marker
 * pointing five degrees wrong looks precisely like one pointing correctly and
 * is a walk down the wrong street.
 *
 * `d2` is squared metres, on this repo's determinism rule and because every
 * caller already has it from the cull it just did. The square root is paid only
 * on the markers that are actually beyond the rim, which is usually none.
 */
export function rimFraction(d2: number, radius: number, seat = RIM_SEAT): number {
  const r2 = radius * radius;
  if (d2 <= r2 || d2 <= 0) return 1;
  return (seat * radius) / Math.sqrt(d2);
}

// --- What the map is given ----------------------------------------------------------

/**
 * One giver on the map.
 *
 * `d2` is kept rather than recomputed because the selection sorts on it and the
 * caller wants it again for nothing; `hero` is kept because the cap's one
 * exception reads it and the caller should not have to ask the npc a second
 * time what its `marker` field said.
 */
export interface GiverDot {
  /** The npc id, so a caller can tie a dot to the body and the conversation. */
  id: string;
  /** Their name, for the big map's label. The compass drops it; see `Marker.label`. */
  name: string;
  x: number;
  z: number;
  /** `true` for a `?` -- a job to hand in -- and `false` for a `!`. */
  turnin: boolean;
  /** `questmodel.NPC_MARKER.HERO`. The cap will not drop this one. */
  hero: boolean;
  /** Squared metres from where the player was standing on the beat. */
  d2: number;
}

/**
 * The three closures this needs, which are three `main.ts` already has.
 *
 * Structural, and deliberately a **subset** of `world/questmarkers.QuestMarkerSource`
 * -- the same object satisfies both, and that is the arrangement rather than an
 * accident: the street marks and the map dots must be handed the same bundle
 * and the same player or they are two copies of the register. `main.ts` builds
 * one object and passes it to both.
 */
export interface GiverMapSource {
  npcs(): readonly DialogNpc[];
  facts(): PlayerFacts;
  view(): QuestView;
}

/**
 * The dozen givers the map is currently drawing, recomputed on a beat.
 *
 * A class holding a pooled array rather than a function returning one, on
 * `minimap.MarkerSource`'s own argument: this is read at 15 Hz forever and
 * nothing in a redraw path may allocate. The array grows to its high-water mark
 * -- twelve -- and stays there.
 */
export class GiverDots {
  /** The selection, best first. Only the first `count` are live. */
  private readonly pool: GiverDot[] = [];
  private live = 0;
  /** The beat the selection was made on. `-1` is "never". */
  private beat = -1;
  /** How many candidates the cap turned away on the last sweep. */
  private cut = 0;
  /** How many givers were inside `GIVER_RANGE_M` and had a mark, before the cap. */
  private found = 0;

  /** How many dots are live. Loop `for (let i = 0; i < count; i++)`. */
  get count(): number {
    return this.live;
  }

  /** The `i`th dot, best first. Undefined past `count`. */
  at(i: number): GiverDot {
    return this.pool[i];
  }

  /**
   * What the cap turned away, and what it had to choose from.
   *
   * On the console handle rather than merely counted, because this is the one
   * thing about the feature a player can be wrong about in a way nothing on the
   * screen says: a map showing twelve of nineteen looks exactly like a map
   * showing all of them.
   */
  stats(): { shown: number; found: number; dropped: number; rangeM: number; cap: number } {
    return { shown: this.live, found: this.found, dropped: this.cut, rangeM: GIVER_RANGE_M, cap: MAX_GIVER_DOTS };
  }

  /**
   * Recompute, but only when the beat has moved. Returns whether it did.
   *
   * The beat is `QuestMarkerField.beats`; see the header. The cheap distance
   * test comes **before** `markerFor` for the reason that file gives -- two
   * subtractions and a compare in front of a walk of a dialog tree -- and the
   * `view()` and `facts()` builds happen once per sweep rather than once per
   * npc, for the same reason they do there.
   */
  refresh(beat: number, x: number, z: number, source: GiverMapSource): boolean {
    if (beat === this.beat) return false;
    this.beat = beat;
    this.live = 0;
    this.cut = 0;
    this.found = 0;
    const npcs = source.npcs();
    if (npcs.length === 0) return true;
    const view = source.view();
    const facts = source.facts();
    const range2 = GIVER_RANGE_M * GIVER_RANGE_M;
    for (const npc of npcs) {
      const dx = npc.x - x;
      const dz = npc.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > range2) continue;
      const kind = markerFor(npc, facts, view);
      if (kind === 'none') continue;
      this.found++;
      this.insert(npc, d2, kind === 'turnin');
    }
    return true;
  }

  /**
   * Put one candidate in its place, evicting the worst if the list is full.
   *
   * An insertion into a twelve-slot array kept sorted rather than a sort of the
   * whole candidate list, because the candidate list is unbounded (a content
   * pool is hundreds of givers and a dense block could put dozens in range) and
   * the output never is. The worst case is twelve shifts per candidate; the
   * common case is a single compare against the last slot and a `continue`.
   *
   * The order is **hero first, then nearest**, and it is total: two ordinary
   * givers at the same distance keep bundle order, which is arbitrary and
   * stable, which is the only property that matters -- an unstable order would
   * make the twelfth dot flicker between two givers on every beat.
   */
  private insert(npc: DialogNpc, d2: number, turnin: boolean): void {
    const hero = npc.marker === NPC_MARKER.HERO;
    if (this.live >= MAX_GIVER_DOTS) {
      // The cap is reached. Does this one beat the worst thing already in?
      const worst = this.pool[MAX_GIVER_DOTS - 1];
      if (!GiverDots.better(hero, d2, worst.hero, worst.d2)) {
        this.cut++;
        return;
      }
      this.cut++;
      this.live = MAX_GIVER_DOTS - 1;
    }
    let slot = this.pool[this.live];
    if (slot === undefined) {
      slot = { id: '', name: '', x: 0, z: 0, turnin: false, hero: false, d2: 0 };
      this.pool.push(slot);
    }
    slot.id = npc.id;
    slot.name = npc.name;
    slot.x = npc.x;
    slot.z = npc.z;
    slot.turnin = turnin;
    slot.hero = hero;
    slot.d2 = d2;
    this.live++;
    // Bubble it up to where it belongs. The records are swapped rather than
    // copied, so the pool's objects are never reallocated and the identities
    // simply move around inside it.
    for (let i = this.live - 1; i > 0; i--) {
      const above = this.pool[i - 1];
      const here = this.pool[i];
      if (!GiverDots.better(here.hero, here.d2, above.hero, above.d2)) break;
      this.pool[i - 1] = here;
      this.pool[i] = above;
    }
  }

  /** Hero beats ordinary; otherwise nearer beats further. See `insert`. */
  private static better(heroA: boolean, d2A: number, heroB: boolean, d2B: number): boolean {
    if (heroA !== heroB) return heroA;
    return d2A < d2B;
  }
}

// --- The self-check ------------------------------------------------------------------

/**
 * Everything here fails silently, which is why it is checked on both runtimes.
 *
 *   - **A giver the register would refuse** is the failure this feature was
 *     designed around: a gold `!` on the map, a walk across Redfern, and a
 *     conversation with every button greyed out. The rung, the exemption and
 *     the faction are all driven through real quests below rather than mocked,
 *     because the whole safety property is that this file asks `markerFor`
 *     rather than having an opinion.
 *   - **A rim marker with the wrong bearing** looks exactly like one with the
 *     right bearing. It is the same class of bug as `game/waypoint`'s needle
 *     sign, and it is pinned the same way: all four compass points.
 *   - **The 500 m cut being off by one metre** is invisible; being off by a
 *     factor of ten is a quest log. Both edges are asserted.
 *   - **The cap dropping the hero** is the tutorial not happening, for the one
 *     player who cannot tell that it should have.
 *   - **The gold drifting** is a mark over a head and a dot on a map in two
 *     different yellows, which nobody would report as a bug.
 */
export function verifyGiverMap(): string[] {
  const failures: string[] = [];

  // --- The gold, both spellings of it.
  {
    if (GIVER_GOLD_CSS !== 'rgb(255,209,41)') {
      failures.push(`The giver gold reads as ${GIVER_GOLD_CSS}, not the rgb(255,209,41) the glyph is drawn in.`);
    }
    const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(GIVER_GOLD_CSS);
    if (m === null) {
      failures.push(`The giver gold is ${GIVER_GOLD_CSS}, which no canvas will parse.`);
    } else {
      const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
      // A yellow, checked as a shape rather than as a string, so the colour can
      // be retuned and cannot be retuned into something that is not gold.
      if (!(r >= g && g > b * 2)) {
        failures.push(`The giver gold is rgb(${r}, ${g}, ${b}), which is not a yellow. The owner asked for yellow.`);
      }
      if (Math.round(GIVER_GOLD.g * 255) !== g) failures.push('The css gold and the triple disagree.');
    }
  }

  // --- The rim clamp: inside is untouched, outside is on the rim, and the
  // bearing survives at every compass point.
  {
    const radius = 160;
    if (rimFraction(0, radius) !== 1) failures.push('A marker underfoot was clamped.');
    if (rimFraction(159 * 159, radius) !== 1) failures.push('A marker inside the disc was clamped to the rim.');
    const f = rimFraction(400 * 400, radius);
    if (!(f > 0 && f < 1)) failures.push(`A marker at 400 m clamped by ${f}, which is not a clamp.`);
    // Due north at 400 m: the drawn point is on the rim seat, straight up.
    const cases: Array<[string, number, number]> = [
      ['north', 0, -400],
      ['east', 400, 0],
      ['south', 0, 400],
      ['west', -400, 0],
      ['north-east', 283, -283],
    ];
    for (const [where, dx, dz] of cases) {
      const d2 = dx * dx + dz * dz;
      const k = rimFraction(d2, radius);
      const sx = dx * k;
      const sz = dz * k;
      const drawn = Math.sqrt(sx * sx + sz * sz);
      if (Math.abs(drawn - radius * RIM_SEAT) > 1e-6) {
        failures.push(`A giver due ${where} at 400 m was drawn ${drawn.toFixed(2)} m out, not on the ${(radius * RIM_SEAT).toFixed(2)} m rim seat.`);
      }
      // The bearing, as the cross product with the true offset: zero means the
      // drawn point is on the line to the target, which is the whole claim.
      const cross = dx * sz - dz * sx;
      if (Math.abs(cross) > 1e-6) failures.push(`A giver due ${where} was clamped off its own bearing.`);
      if (sx * dx + sz * dz <= 0) failures.push(`A giver due ${where} was clamped to the opposite side of the disc.`);
    }
    // The seat is inside the rim, or the glyph is clipped in half. See `RIM_SEAT`.
    if (!(RIM_SEAT > 0.7 && RIM_SEAT < 1)) failures.push(`The rim seat is ${RIM_SEAT}; a glyph on the rim itself is cut in half.`);
  }

  // --- The source, driven through the real register.
  {
    const npc = (id: string, x: number, z: number, accept: string, hero = false): DialogNpc => ({
      id,
      name: id,
      x,
      z,
      radius: 4,
      root: 'a',
      marker: hero ? NPC_MARKER.HERO : NPC_MARKER.NONE,
      nodes: [
        {
          id: 'a',
          line: 'g\'day',
          improv: null,
          choices: [choice({ text: 'go on then', accept })],
        },
      ],
    });
    const quest = (id: string, level: number, anyRung: boolean): Quest => ({
      id,
      act: 0,
      title: id,
      blurb: '',
      giver: id,
      level,
      faction: '',
      requires: [],
      needFlags: [],
      denyFlags: [],
      repeatable: false,
      anyRung,
      grantsBike: false,
      steps: [{ ...BLANK_STEP, kind: STEP_KIND.EARN, dollars: 5, label: 'earn a fiver' }],
      reward: { cash: 0, xp: 0, unlock: [] },
    });
    const facts = (level: number): PlayerFacts => ({ level, faction: '', story: new Set<string>(), cash: 0 });

    // A rung-1 job and a rung-1 job that is exempt, both 50 m away.
    const quests = [quest('pool', 1, false), quest('signpost', 1, true)];
    const npcs = [npc('pool', 50, 0, 'pool'), npc('signpost', 0, 50, 'signpost')];
    const source = (level: number): GiverMapSource => ({
      npcs: () => npcs,
      facts: () => facts(level),
      view: () => questView(quests, {}),
    });

    const dots = new GiverDots();
    dots.refresh(1, 0, 0, source(1));
    const atOne = new Set<string>();
    for (let i = 0; i < dots.count; i++) atOne.add(dots.at(i).id);
    if (!atOne.has('pool')) failures.push('A level-1 player was not shown a rung-1 giver.');
    if (!atOne.has('signpost')) failures.push('A level-1 player was not shown the exempt giver.');

    // And at level 2 the pool quest is off the register -- `level 1 only` -- and
    // the exempt one is not. This is the whole of `Quest.anyRung`, seen from the
    // map, and it is not a rule this file knows: it is `questRefusal`'s.
    dots.refresh(2, 0, 0, source(12));
    const atTwelve = new Set<string>();
    for (let i = 0; i < dots.count; i++) atTwelve.add(dots.at(i).id);
    if (atTwelve.has('pool')) failures.push('A rung-2 player was shown a rung-1 giver; the register refuses that job.');
    if (!atTwelve.has('signpost')) failures.push('An anyRung giver vanished for a player past the rung. A signpost that disappears once you are lost is not a signpost.');

    // The beat is what gates the sweep: the same beat twice is one sweep.
    if (dots.refresh(2, 9999, 9999, source(12))) failures.push('A repeated beat recomputed the selection.');
    if (dots.count === 0) failures.push('A repeated beat cleared the selection it should have kept.');

    // --- The 500 m cut, at both edges.
    {
      const far = [npc('near', 0, -499, 'pool'), npc('gone', 0, -501, 'pool')];
      const d = new GiverDots();
      d.refresh(1, 0, 0, { npcs: () => far, facts: () => facts(1), view: () => questView(quests, {}) });
      const ids = new Set<string>();
      for (let i = 0; i < d.count; i++) ids.add(d.at(i).id);
      if (!ids.has('near')) failures.push('A giver 499 m away was cut by the 500 m rule.');
      if (ids.has('gone')) failures.push('A giver 501 m away was drawn; the cut is 500.');
    }

    // --- The cap: nearest first, and the hero survives it.
    {
      const crowd: DialogNpc[] = [];
      // Twenty ordinary givers at 100, 110, 120 ... metres, plus a hero at 480.
      for (let i = 0; i < 20; i++) crowd.push(npc(`g${i}`, 0, -(100 + i * 10), 'pool'));
      crowd.push(npc('lad', 0, -480, 'pool', true));
      const d = new GiverDots();
      d.refresh(1, 0, 0, { npcs: () => crowd, facts: () => facts(1), view: () => questView(quests, {}) });
      if (d.count !== MAX_GIVER_DOTS) failures.push(`The cap let ${d.count} markers through, not ${MAX_GIVER_DOTS}.`);
      const ids: string[] = [];
      for (let i = 0; i < d.count; i++) ids.push(d.at(i).id);
      if (ids[0] !== 'lad') failures.push(`The hero is at position ${ids.indexOf('lad')}, not first; the cap must never drop him.`);
      if (!ids.includes('g0')) failures.push('The nearest giver did not make the cap.');
      if (ids.includes('g19')) failures.push('The furthest giver made the cap ahead of a nearer one.');
      // Nearest first, after the hero.
      for (let i = 2; i < d.count; i++) {
        if (d.at(i).d2 < d.at(i - 1).d2) failures.push('The selection is not in nearest-first order.');
      }
      const s = d.stats();
      if (s.found !== 21 || s.shown !== MAX_GIVER_DOTS || s.dropped !== 21 - MAX_GIVER_DOTS) {
        failures.push(`The cap reported ${s.shown} of ${s.found} with ${s.dropped} dropped; 21 candidates and a cap of ${MAX_GIVER_DOTS} is ${21 - MAX_GIVER_DOTS}.`);
      }
    }

    // --- A turn-in is a `?`, and it is the register that says so rather than
    // this file. The cursor is finished (`d: true`), so `choiceRefusal` lets the
    // turn-in button through and `markerFor` prefers it over any offer.
    {
      const handback: DialogNpc = {
        ...npc('clerk', 20, 0, ''),
        nodes: [
          {
            id: 'a',
            line: 'that\'ll do',
            improv: null,
            choices: [choice({ text: 'here you go', turnin: 'pool' })],
          },
        ],
      };
      const d = new GiverDots();
      d.refresh(1, 0, 0, {
        npcs: () => [handback],
        facts: () => facts(1),
        view: () => questView(quests, { pool: { s: 1, c: [5], d: true } }),
      });
      if (d.count !== 1) failures.push('A giver holding a finished job got no mark on the map.');
      else if (!d.at(0).turnin) failures.push('A finished job drew a `!` rather than a `?`.');
      // And with the job unfinished, the same npc is not a `?` -- the button is
      // greyed out in the panel and the map must say the same thing.
      d.refresh(2, 0, 0, {
        npcs: () => [handback],
        facts: () => facts(1),
        view: () => questView(quests, { pool: { s: 0, c: [0], d: false } }),
      });
      if (d.count !== 0) failures.push('A job the player has not finished put a `?` on the map.');
    }
  }

  return failures;
}

/** A dialog choice with every gate open, for the check's fixtures to override. */
function choice(over: Partial<DialogChoice>): DialogChoice {
  return {
    text: '',
    goto: '',
    accept: '',
    turnin: '',
    needLevel: 0,
    needFaction: '',
    needFlag: '',
    denyFlag: '',
    needCash: 0,
    cost: 0,
    ...over,
  };
}

/** A step with every field at its zero, for the check's fixtures to spread over. */
const BLANK_STEP: QuestStep = {
  kind: STEP_KIND.EARN,
  label: '',
  objective: '',
  count: 1,
  x: 0,
  z: 0,
  radius: 30,
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
