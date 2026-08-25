/**
 * The drive, narrated -- sparingly.
 *
 * The owner, after the first end-to-end journey: *"on the ride from the park to
 * redfern, stuff should happen, its all just passive rn."* He is right, and the
 * reason is structural rather than missing content: a car crossing this world
 * passes eleven suburbs, four hundred named streets and a river, and the client
 * knows all of it -- `game/locator.ts` is computing the answer twice a second
 * for a strip under the minimap that a driver is not looking at.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT.
 *
 * `DESIGN.md` rule 6: "the city reacts; the UI does not shout ... prefer the
 * world noticing the player over a toast congratulating them." So this is not a
 * feed, it has no panel, and it adds no element -- it posts to `hud.notice`, the
 * same channel the Karens and the mushrooms already use, and a line that nobody
 * reads costs one fade.
 *
 * And it is not flavour text. Every line names something that is **true right
 * now** and that the player could verify by looking out of the window, which is
 * rule 1 ("Sydney is the content") doing the writing. "Now entering Newtown" is
 * a fact about a real suburb boundary; a generated quip about the weather would
 * be neither.
 *
 * ---------------------------------------------------------------------------
 * THE MODULE IS THE RATE LIMIT, NOT THE WORDS.
 *
 * This is the whole reason it is a module with a check rather than four lines in
 * `main.ts`. Sydney's suburbs are small: the drive the owner made crosses one
 * every twenty to forty seconds, and the M4 crosses one about every fifteen. A
 * naive "say it when it changes" is a line every few seconds forever, which is
 * exactly the shouting rule 6 refuses -- and worse, it drowns the notices that
 * matter, because `hud.notice` is one channel and the Karen report and the
 * knockout share it.
 *
 * So the interesting behaviour is all suppression:
 *
 *   - **A floor between lines.** Nothing within `MIN_GAP_S` of the last thing
 *     said, whatever it is.
 *   - **No repeats.** A key said inside `REPEAT_S` is dropped, so driving a lap
 *     of the same block does not narrate it four times, and a boundary the
 *     player is weaving across does not stutter.
 *   - **Weight pre-empts.** A queued line is replaced rather than queued behind
 *     when something more worth saying arrives, because by the time a backlog
 *     drains it is describing somewhere the player has left.
 *   - **Silence when stopped.** A ticker is a thing you read *while travelling*;
 *     parked, the locator strip is right there and better.
 *
 * Sources are one `post` each and deliberately live in `main.ts` -- this module
 * knows nothing about suburbs, police or the map, which is what lets the check
 * below run on made-up strings with no world behind it.
 */

/** The least time between two lines, seconds. See the header: suburbs are small. */
export const MIN_GAP_S = 12;

/** How long a key stays said, seconds. Long enough to survive a lap of a block. */
export const REPEAT_S = 150;

/**
 * How long a posted line waits for its turn before it is stale, seconds.
 *
 * **It has to exceed `MIN_GAP_S`, and that is an invariant rather than a
 * preference.** A line posted while the floor is still down waits for the floor;
 * if it goes stale first it can never be said at all, and the failure is silent
 * and total -- two boundaries close together and the second one is simply never
 * announced, forever, with nothing in the log. Found by a check that stepped the
 * clock past the floor and got nothing back.
 *
 * 20 over a 12 s floor leaves eight seconds of genuine staleness on top, which
 * is about two hundred metres at suburban speed: far enough that a line held
 * that long really is about somewhere you have left.
 */
export const STALE_S = 20;

/** Below this, the player is not travelling and the ticker is quiet. m/s. */
export const MOVING_MPS = 4;

interface Pending {
  key: string;
  text: string;
  weight: number;
  age: number;
}

export class Ticker {
  private sinceLast = MIN_GAP_S;
  private pending: Pending | null = null;
  private readonly said = new Map<string, number>();

  /**
   * Offer a line. Higher `weight` wins a tie and pre-empts a waiting one.
   *
   * `key` is what repeat-suppression is keyed on, so it should name the *thing*
   * rather than the sentence: `suburb:Newtown`, not the line about it.
   */
  post(key: string, text: string, weight = 1): void {
    if (text === '') return;
    const saidAt = this.said.get(key);
    if (saidAt !== undefined && saidAt < REPEAT_S) return;
    if (this.pending !== null && this.pending.weight >= weight) return;
    this.pending = { key, text, weight, age: 0 };
  }

  /**
   * Advance, and return the line to show this frame or `null`.
   *
   * `speedMps` is the player's own speed rather than the car's: a passenger on a
   * train is travelling, and a player standing beside an idling car is not.
   */
  update(dt: number, speedMps: number): string | null {
    const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
    this.sinceLast += step;
    for (const [key, t] of this.said) {
      const next = t + step;
      if (next >= REPEAT_S) this.said.delete(key);
      else this.said.set(key, next);
    }
    if (this.pending === null) return null;
    this.pending.age += step;
    if (this.pending.age > STALE_S) {
      this.pending = null;
      return null;
    }
    if (speedMps < MOVING_MPS) return null;
    if (this.sinceLast < MIN_GAP_S) return null;
    const { key, text } = this.pending;
    this.pending = null;
    this.sinceLast = 0;
    this.said.set(key, 0);
    return text;
  }

  /** Forget everything. A respawn or a teleport is a new journey. */
  reset(): void {
    this.pending = null;
    this.said.clear();
    this.sinceLast = MIN_GAP_S;
  }
}

/**
 * The suppression rules, which are the whole module.
 *
 * Every case here is one the owner would have hit on a single drive across the
 * city, and the failure mode of each is the same: `hud.notice` is one channel,
 * so a ticker that talks too much does not merely annoy, it hides the knockout
 * and the Karen report behind a boundary crossing.
 */
export function verifyTicker(): string[] {
  const failures: string[] = [];
  const fast = MOVING_MPS + 5;

  // A line waits for the floor and then goes exactly once.
  {
    const t = new Ticker();
    t.post('suburb:Newtown', 'Now entering Newtown');
    const first = t.update(0.1, fast);
    if (first !== 'Now entering Newtown') {
      failures.push(`The first line did not go out at the start of a drive: ${String(first)}.`);
    }
    if (t.update(0.1, fast) !== null) failures.push('A line went out twice.');
  }

  // Suburbs are small: the next boundary must be held to the floor.
  {
    const t = new Ticker();
    t.post('a', 'A');
    t.update(0.1, fast);
    t.post('b', 'B');
    let said: string | null = null;
    for (let i = 0; i < Math.floor((MIN_GAP_S - 1) / 0.5); i++) {
      said = t.update(0.5, fast) ?? said;
    }
    if (said !== null) {
      failures.push(`A second line went out ${MIN_GAP_S} s early; the channel is shared.`);
    }
  }

  // Weaving over one boundary must not stutter.
  {
    const t = new Ticker();
    t.post('suburb:Newtown', 'Now entering Newtown');
    t.update(0.1, fast);
    for (let i = 0; i < Math.ceil(MIN_GAP_S / 0.5) + 2; i++) t.update(0.5, fast);
    t.post('suburb:Newtown', 'Now entering Newtown');
    if (t.update(0.5, fast) !== null) {
      failures.push('The same suburb was announced twice inside the repeat window.');
    }
  }

  // Parked is silent, and the line is still there when you pull away -- within
  // the staleness window, because a line about where you *were* is worse than
  // none.
  {
    const t = new Ticker();
    t.post('x', 'X');
    if (t.update(0.5, 0) !== null) failures.push('The ticker talked while the player was stopped.');
    if (t.update(0.5, fast) !== 'X') {
      failures.push('A line posted while stopped was lost when the player moved off.');
    }
  }
  {
    const t = new Ticker();
    t.post('x', 'X');
    for (let i = 0; i < Math.ceil(STALE_S / 0.5) + 1; i++) t.update(0.5, 0);
    if (t.update(0.5, fast) !== null) {
      failures.push('A line the player had long since driven past was still said.');
    }
  }

  // Something more worth saying replaces a queued line rather than joining a
  // backlog that describes somewhere already behind you.
  {
    const t = new Ticker();
    t.update(MIN_GAP_S, fast);
    t.post('quiet', 'quiet', 1);
    t.post('loud', 'loud', 5);
    if (t.update(0.1, fast) !== 'loud') failures.push('A heavier line did not pre-empt a queued one.');
    const u = new Ticker();
    u.update(MIN_GAP_S, fast);
    u.post('loud', 'loud', 5);
    u.post('quiet', 'quiet', 1);
    if (u.update(0.1, fast) !== 'loud') failures.push('A lighter line displaced a heavier one.');
  }

  // A journey that ends forgets itself.
  {
    const t = new Ticker();
    t.post('k', 'K');
    t.update(0.1, fast);
    t.reset();
    t.post('k', 'K');
    if (t.update(0.1, fast) !== 'K') failures.push('reset did not clear the repeat window.');
  }

  // An empty line is not a line.
  {
    const t = new Ticker();
    t.post('k', '');
    if (t.update(0.1, fast) !== null) failures.push('An empty string was posted as a line.');
  }

  // `dt` goes strange across a tab switch, and the danger is not that a queued
  // line goes out -- it should -- but that a nonsense frame **advances the
  // floor**, which would let the next boundary talk over the one before it.
  {
    const t = new Ticker();
    t.post('a', 'A');
    t.update(0.1, fast);
    t.post('b', 'B');
    if (t.update(Number.NaN, fast) !== null || t.update(-5, fast) !== null) {
      failures.push('A nonsense frame time carried a line past the floor.');
    }
    let late: string | null = null;
    for (let i = 0; i < Math.ceil(MIN_GAP_S / 0.5) + 2 && late === null; i++) {
      late = t.update(0.5, fast);
    }
    if (late !== 'B') {
      failures.push('A nonsense frame time left the clock stuck; the ticker went silent.');
    }
  }

  // The relationship the line above depends on, stated once. A `STALE_S` under
  // the floor means a line posted during the floor is dropped every time, which
  // is a whole class of boundary that is never announced and never logged.
  if (STALE_S <= MIN_GAP_S) {
    failures.push(
      `STALE_S ${STALE_S} is not past the ${MIN_GAP_S} s floor, so a line posted while the` +
        ' floor is down can never be said',
    );
  }
  return failures;
}
