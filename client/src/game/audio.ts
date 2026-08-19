/**
 * The impact. Synthesised, because there is nothing else in this repository that
 * could load a sample.
 *
 * Spec 8.2 asks for a "loud unrealistic impact" and says to "sell it through
 * audio and camera, not gore". This is the first audio in the project at all --
 * `world/birds.ts` records the absence in as many words: *"no calls or
 * wingbeats, because there is no audio in the project at all"* -- so the
 * question of where a sound comes from had to be answered before the punch could
 * make one.
 *
 * It is generated, for the reason every other asset here is generated. A `.wav`
 * would be the only binary asset in the repository, the only thing a contributor
 * could not change by editing a number, and the only thing whose sample rate,
 * length and loudness were decided somewhere else. A punch is two oscillators
 * and an envelope. `world/power.ts` builds a catenary out of arithmetic; this is
 * the same argument in a different medium.
 *
 * ---------------------------------------------------------------------------
 * What a hit is made of, and why it is three layers rather than one.
 *
 * The melee weapon is a **cricket bat** (see `player/bat.ts`), and the impact
 * sound was rewritten with it: a fist is a soft broad thump and a bat is a crack.
 * A hit has to read at two different distances in the same 60 ms:
 *
 *   - the **crack** says *contact*, and says *wood*. A bandpassed noise burst at
 *     2.6 kHz with a 2.5 ms attack, and the attack is the entire thing -- what
 *     the ear identifies as an impact is the rise time, not the spectrum, and
 *     what it identifies as timber rather than flesh is how fast the top end
 *     arrives. Anything over about 15 ms stops being a hit and becomes a whoosh.
 *   - the **knock** says *what was swung*. Two inharmonic partials at 390 and
 *     1,150 Hz -- a ratio of 2.95 rather than a musical 3 -- which is how a
 *     struck bar of willow rings and is the one layer that could not be borrowed
 *     from the punch.
 *   - the **body** says *weight*. A sine falling from 175 Hz to 55 Hz over 85 ms.
 *     A falling pitch is the cheapest "something heavy happened" cue there is,
 *     and it is what stops the crack reading as a snare.
 *
 * The knockout is the same three layers pitched down and stretched -- the noise
 * played at 0.7 of its rate, the partials down a fifth, the body from 120 Hz to
 * 30 Hz over 220 ms -- which is the comic-book convention (a bigger thing makes a
 * lower, longer noise) and is one multiply rather than a second sound to design.
 *
 * `whiff` is the other half of the pair and the design brief for it is one
 * sentence: **a player must know whether they connected without looking.** So it
 * is a broad low whoosh that swells and passes, where the hit is a narrow high
 * crack that arrives and stops, and the two share no layer at all.
 *
 * A compressor sits on the master because sixteen players at spec 2's cap means
 * simultaneous hits, and two of these summing without one would clip the output
 * bus into a click that sounds like a bug rather than like a fight.
 *
 * ---------------------------------------------------------------------------
 * Autoplay. An `AudioContext` constructed outside a user gesture starts
 * `suspended` on every current browser and stays that way, silently, forever --
 * which presents as "the punch has no sound" with nothing in the console. So the
 * context is not constructed until `enable()` is called, and `main.ts` calls it
 * from the pointer-lock click and from the drag fallback's mousedown, both of
 * which are gestures. `enable()` is idempotent and also resumes a context the
 * browser suspended on a tab switch.
 */

import type { RailAnnounceMix, RailVoice } from './rail-audio.ts';
import { screamGap } from './sunbutton.ts';

/**
 * How hard a crash has to be before glass breaks. `CombatAudio.carCrunch`'s
 * `strength`, so a fraction of the top speed.
 *
 * A sixth, which on `driving.DRIVE_TOP_SPEED`'s 44 m/s is a 7.3 m/s impact --
 * about the speed at which `driving.crashDamage` first takes more than twenty
 * health, and comfortably past anything that could be called parking.
 *
 * **0.16, halved from 0.33 when the top speed doubled.** The number that has to
 * stay put is the *impact* -- glass breaks at about seven metres a second and
 * always has -- and this constant is a fraction of the top speed rather than an
 * absolute, so it had to move to keep it there. Left at a third it would have
 * taken a 14.5 m/s hit to break a window, which is a crash that already costs
 * most of the car's health in silence.
 */
const SHATTER_STRENGTH = 0.16;

/**
 * --- WORKSTREAM Y: how fast a car explosion's sound travels, m/s, and how long
 * it may be in the air.
 *
 * 343 is `polair.POLAIR_SOUND_SPEED`'s number and is restated rather than
 * imported for the reason `driving.SPRINT_SPEED` is restated: this file must not
 * import a gameplay module, the dependency runs the other way, and the speed of
 * sound is not a constant either of them can get wrong.
 *
 * The cap is the interesting one. At 343 m/s a bang at the far edge of the
 * `MSG.TEAM_EVENT` fan-out -- which is room-global and therefore up to sixty
 * kilometres -- would arrive nearly three minutes later, by which time it is not
 * a sound, it is a mystery. Two and a half seconds is a bang you can still
 * connect to a flash you saw on the horizon, and past that the gain has taken it
 * under the floor anyway.
 */
const BOOM_SOUND_SPEED = 343;
const BOOM_DELAY_MAX_S = 2.5;

/**
 * The two diaphragms of a car horn, hertz. See `CombatAudio.carHorn`.
 *
 * 405 and 500 is a shade over a major third, which is what the pair in a
 * mid-market sedan actually is -- close enough to beat audibly and far enough
 * apart not to read as one note gone sour.
 */
const HORN_PARTIALS = [405, 500];

/** How long one parp lasts, seconds. `main.ts`' `HONK_SECONDS` less its cooldown gap. */
const HORN_SECONDS = 0.3;

export class CombatAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;

  /**
   * Decoded voice clips, by URL. See `loadClip`.
   *
   * The one place this file departs from its own founding argument -- *"a `.wav`
   * would be the only binary asset in the repository"* -- and it is worth saying
   * exactly how far the departure goes, because the argument is still right about
   * everything it was made about.
   *
   * Every **impact** in this file is still synthesised: the bat, the football,
   * the splash, the pickups, and the gunshot added below. Those are physical
   * events, they are two oscillators and an envelope, and a sample of one would
   * be a file whose loudness and length were decided somewhere else.
   *
   * A **voice** is not that. "Oi! Stop right there" is not two oscillators and an
   * envelope and cannot be made into them; `oof` is the closest this file gets to
   * a person and it is a sawtooth under a closing filter, which reads as a grunt
   * and could never read as a sentence. The user supplied the lines, so the
   * question was never whether to synthesise speech -- it was whether to play the
   * files that exist, and the answer to that is obviously yes.
   *
   * The screaming sun's four clips are the second user of this path, and they
   * settle the same question the same way: a recorded scream is not two
   * oscillators and an envelope, so it is played rather than synthesised. The
   * officers' barks play at a distance gain with a cooldown; the sun's clips play
   * at a level gain with no distance and no cooldown, because the sun is
   * everywhere and a scream that faded with distance would be a scream that was
   * not a scream. No streaming, no sprite sheet, no loader class, and no way to
   * reach it for a sound that could have been arithmetic.
   */
  private readonly clips = new Map<string, AudioBuffer>();
  /** URLs currently being fetched, so a bark on two ticks does not fetch twice. */
  private readonly loading = new Set<string>();
  /**
   * `ctx.currentTime` a clip may next be played at, by URL.
   *
   * Per *clip* rather than per source, and the difference is the whole reason it
   * is here: four officers promoting on one tick is the common case, and four
   * copies of one 1.5-second line starting in the same millisecond is not four
   * voices -- it is one voice at four times the level, with comb filtering. The
   * cooldown makes the second, third and fourth simply not play, which sounds
   * like the pair who spoke being the pair who spoke.
   */
  private readonly clipCooldown = new Map<string, number>();

  get enabled(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  /** How many voice clips are decoded and ready. The boot self-check reports it. */
  get clipsLoaded(): number {
    return this.clips.size;
  }

  /**
   * Build or resume the context. **Must be called from a user gesture.**
   *
   * Failure is swallowed rather than thrown: a browser with audio disabled is a
   * playable game with no punch sound, and an exception here would take the
   * animation loop down with it.
   */
  enable(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const ctx = new AudioContext();
      const master = ctx.createGain();
      master.gain.value = 0.55;
      // Limits rather than shapes: a 20:1 ratio at -8 dB with a 3 ms attack is
      // there to stop two simultaneous impacts clipping, not to make anything
      // sound compressed.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -8;
      limiter.knee.value = 6;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.12;
      master.connect(limiter).connect(ctx.destination);

      // Half a second of white noise, generated once and re-triggered. An
      // `AudioBufferSourceNode` is single-use and disposable, so every burst is a
      // new node over the same buffer -- which is how the Web Audio API is meant
      // to be used and costs nothing measurable at a few nodes a second.
      const frames = Math.floor(ctx.sampleRate * 0.5);
      const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

      this.ctx = ctx;
      this.master = master;
      this.noise = buffer;
      if (ctx.state === 'suspended') void ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  // --- Voice clips ------------------------------------------------------------

  /**
   * Fetch and decode a clip, once. Safe to call every time you want to play one.
   *
   * Fire-and-forget by design: it returns nothing and swallows every failure,
   * because a missing or undecodable `.wav` is a police force that shouts
   * nothing and is otherwise a working game. The alternative -- a promise the
   * caller has to await before an officer can aggro -- would put a network
   * round trip inside a 60 Hz frame the first time anybody committed a crime.
   *
   * `decodeAudioData` needs a live context, so this is a no-op before `enable()`
   * and callers do not have to check: the first bark of a session arrives after
   * the pointer-lock gesture by construction, since committing a crime requires
   * playing the game.
   */
  loadClip(url: string): void {
    const ctx = this.ctx;
    if (!ctx || this.clips.has(url) || this.loading.has(url)) return;
    this.loading.add(url);
    void fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((bytes) => ctx.decodeAudioData(bytes))
      .then((buffer) => {
        this.clips.set(url, buffer);
      })
      .catch(() => {
        // Left out of `clips` and out of `loading`, so a transient failure is
        // retried the next time somebody aggros rather than being permanent.
      })
      .finally(() => {
        this.loading.delete(url);
      });
  }

  /**
   * Play a voice clip at a distance, subject to its own cooldown.
   *
   * Returns whether anything was actually played, which the caller uses for
   * nothing and a check uses for everything.
   *
   * The falloff is `1 / (1 + d/22)`, which is gentler than any impact in this
   * file -- a third of the level at 44 m against `footyThrow`'s third at 28 --
   * and the reason is what the sound is *for*. An impact tells you something
   * happened; a police officer shouting tells you something is **about to**, and
   * a warning you cannot hear until it is too late to act on is not a warning.
   * Cut off entirely past about 70 m, where it would be inaudible anyway and is
   * only costing a node.
   */
  bark(url: string, distance = 0, cooldownSeconds = 0): boolean {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return false;
    const buffer = this.clips.get(url);
    if (!buffer) {
      // Not loaded yet: start it, so the *next* one lands. Deliberately not
      // queued to play on arrival -- a line that arrives two seconds after the
      // thing it was about is worse than silence.
      this.loadClip(url);
      return false;
    }
    const t = ctx.currentTime;
    const until = this.clipCooldown.get(url) ?? 0;
    if (t < until) return false;
    const gain = 1 / (1 + Math.max(0, distance) / 22);
    if (gain < 0.05) return false;
    this.clipCooldown.set(url, t + Math.max(cooldownSeconds, buffer.duration));

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const g = ctx.createGain();
    // A plain value rather than a ramp: this is a recording with its own attack
    // and an envelope over the top of it would be a fade, which is the one thing
    // that makes a voice line sound like a game asset.
    g.gain.value = 0.85 * gain;
    source.connect(g).connect(master);
    source.start(t);
    return true;
  }

  /**
   * A pistol shot. **Synthesised**, unlike the voice above it and like every
   * other impact in this file.
   *
   * A gunshot is the one sound here with a genuinely well-known anatomy, and it
   * is three layers on `thwack`'s pattern with the proportions moved a long way:
   *
   *   - the **crack**, and it is nearly the whole sound. A 1.5 ms noise burst --
   *     the fastest attack anywhere in this file, against the bat's 2.5 ms --
   *     highpassed rather than bandpassed, because what makes a report read as a
   *     *supersonic* event and not as a slam is that there is no bottom to it at
   *     all for the first few milliseconds.
   *   - the **body**, a fast sine from 220 Hz down to 60 over 70 ms. Shorter than
   *     the bat's and lower, which is the muzzle blast rather than the round.
   *   - the **tail**, and it is what makes it a shot *in a city*: 260 ms of
   *     lowpassed noise at a tenth of the level, swept down, standing in for the
   *     slapback off the buildings on the other side of the street. Without it
   *     the sound is a firecracker in a field.
   *
   * `distance` attenuates on a much gentler curve than any impact -- `1/(1+d/30)`
   * against the punch's implicit zero -- because a gunshot two streets away is
   * the loudest thing in a real city and a player has to be able to tell that
   * they are being shot at from outside the range they can see the officer at.
   */
  gunshot(distance = 0): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise) return;
    const t = ctx.currentTime;
    const gain = 1 / (1 + Math.max(0, distance) / 30);
    if (gain < 0.02) return;

    // --- The crack.
    const crack = ctx.createBufferSource();
    crack.buffer = noise;
    crack.playbackRate.value = 1.6;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1400;
    hp.Q.value = 0.7;
    const crackGain = ctx.createGain();
    crackGain.gain.setValueAtTime(0.0001, t);
    crackGain.gain.exponentialRampToValueAtTime(0.85 * gain, t + 0.0015);
    crackGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    crack.connect(hp).connect(crackGain).connect(master);
    crack.start(t);
    crack.stop(t + 0.08);

    // --- The muzzle blast.
    const body = ctx.createOscillator();
    body.type = 'sine';
    body.frequency.setValueAtTime(220, t);
    body.frequency.exponentialRampToValueAtTime(60, t + 0.06);
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.5 * gain, t + 0.004);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    body.connect(bodyGain).connect(master);
    body.start(t);
    body.stop(t + 0.1);

    // --- The street.
    const tail = ctx.createBufferSource();
    tail.buffer = noise;
    tail.playbackRate.value = 0.75;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.6;
    lp.frequency.setValueAtTime(2400, t);
    lp.frequency.exponentialRampToValueAtTime(420, t + 0.24);
    const tailGain = ctx.createGain();
    // A 25 ms attack: the slapback arrives after the shot, not with it. At
    // 340 m/s that is the far side of a 4 m-wide street and back, which is about
    // right for a lane and much too fast for George Street -- and the version
    // that got it geometrically right sounded like a delay pedal.
    tailGain.gain.setValueAtTime(0.0001, t);
    tailGain.gain.exponentialRampToValueAtTime(0.09 * gain, t + 0.025);
    tailGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    tail.connect(lp).connect(tailGain).connect(master);
    tail.start(t);
    tail.stop(t + 0.3);
  }

  /**
   * A landed hit: **willow on somebody**. `ko` is the last pip: louder, lower
   * and longer.
   *
   * This was a punch and is now a bat, and the two do not sound alike. A fist is
   * a soft, broad thump; a cricket bat is the loudest 30 ms in Australian sport
   * and every one of its three layers is doing something the punch's two were
   * not:
   *
   *   - the **crack**, a 2.5 ms noise burst bandpassed at 2.6 kHz. Twice as fast
   *     an attack as the punch's and an octave and a half higher, because what
   *     the ear identifies as *wood* rather than as *flesh* is entirely the rise
   *     time and the top end. Anything slower than about 4 ms stops being a crack
   *     and becomes a slap.
   *   - the **knock**, and this is the layer that makes it a bat. Willow rung by
   *     a hard impact is a bar with **inharmonic** partials -- 390 Hz and
   *     1,150 Hz, a ratio of 2.95 rather than 3 -- and it is that
   *     near-but-not-quite that says "solid piece of wood" instead of "note". Two
   *     triangle oscillators, decaying in 60 and 35 ms, and they are the
   *     difference between this sound and a snare.
   *   - the **body**, kept from the punch, because a bat still moves a person
   *     six metres and a falling sine is the cheapest "something heavy happened"
   *     there is.
   *
   * A knockout is the same three pitched down and stretched -- the noise at 0.7
   * of its rate, the partials down a fifth, the body from 120 Hz to 30 over
   * 220 ms -- which is the comic-book convention and is a multiply rather than a
   * second sound to design.
   */
  thwack(ko: boolean): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise) return;
    const t = ctx.currentTime;

    // --- The crack.
    const burst = ctx.createBufferSource();
    burst.buffer = noise;
    burst.playbackRate.value = ko ? 0.7 : 1.25;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = ko ? 900 : 2600;
    // Tighter than the punch's 0.7: a wide band is a splash and a narrow one is
    // a strike on something solid.
    band.Q.value = 1.5;
    const burstGain = ctx.createGain();
    const burstFall = ko ? 0.13 : 0.055;
    // `exponentialRampToValueAtTime` cannot touch zero, so every envelope here
    // starts and ends at 1e-4 -- which is -80 dB and inaudible, and is the
    // standard way round the API's one sharp edge.
    burstGain.gain.setValueAtTime(0.0001, t);
    burstGain.gain.exponentialRampToValueAtTime(ko ? 0.95 : 0.72, t + 0.0025);
    burstGain.gain.exponentialRampToValueAtTime(0.0001, t + burstFall);
    burst.connect(band).connect(burstGain).connect(master);
    burst.start(t);
    burst.stop(t + burstFall + 0.05);

    // --- The knock: the blade's own two partials. See the header for the ratio.
    for (const [hz, level, fall] of [
      [ko ? 260 : 390, 0.34, ko ? 0.11 : 0.06],
      [ko ? 767 : 1150, 0.19, ko ? 0.065 : 0.035],
    ] as Array<[number, number, number]>) {
      const partial = ctx.createOscillator();
      // Triangle rather than sine: a struck bar has odd harmonics above its
      // fundamental and a pure sine reads as a tuned bell.
      partial.type = 'triangle';
      partial.frequency.setValueAtTime(hz, t);
      // A small downward glide. Wood loses pitch as the strike energy leaves it,
      // and a partial held dead flat for 60 ms is a synthesiser.
      partial.frequency.exponentialRampToValueAtTime(hz * 0.88, t + fall);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(level, t + 0.003);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + fall);
      partial.connect(gain).connect(master);
      partial.start(t);
      partial.stop(t + fall + 0.05);
    }

    // --- Body.
    const body = ctx.createOscillator();
    body.type = 'sine';
    const bodyFall = ko ? 0.22 : 0.09;
    body.frequency.setValueAtTime(ko ? 120 : 175, t);
    body.frequency.exponentialRampToValueAtTime(ko ? 30 : 55, t + bodyFall * 0.86);
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(ko ? 1 : 0.62, t + 0.006);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + bodyFall);
    body.connect(bodyGain).connect(master);
    body.start(t);
    body.stop(t + bodyFall + 0.05);
  }

  /**
   * A swing that hit nothing: the bat going past.
   *
   * Louder, lower and half again as long as the punch's whiff, because that is
   * what the object changed to. A fist displaces a fist's worth of air and a
   * 0.83 m blade sweeping through a 200-degree arc displaces a great deal more,
   * and the two things that carry that are both here:
   *
   *   - the **band sweeps up and then down**, 260 -> 1,500 -> 480 Hz, rather
   *     than only falling. A whoosh is a Doppler pass: the blade comes toward the
   *     ear and goes away again inside 180 ms, and a monotonic sweep reads as a
   *     thing receding rather than as a thing going past. The punch's sweep only
   *     fell, which was right for a jab that never crosses the head.
   *   - the **envelope peaks in the middle**, at the same instant the sweep does,
   *     for the same reason. A whoosh that is loudest at its own start is a
   *     release of steam.
   *
   * Still quiet in absolute terms. It is not a reward, it is the feedback that
   * makes spending a quarter of the stamina bar on air feel like it cost
   * something -- and it has to sit well under `thwack`, because the whole job of
   * the pair is that a player knows which one happened without looking.
   */
  whiff(): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise) return;
    const t = ctx.currentTime;

    const air = ctx.createBufferSource();
    air.buffer = noise;
    air.playbackRate.value = 1.15;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    // Broader than the punch's 1.2. A blade is a wide object and a high-Q sweep
    // over noise turns into a whistle, which is a sword.
    band.Q.value = 0.9;
    band.frequency.setValueAtTime(260, t);
    band.frequency.exponentialRampToValueAtTime(1500, t + 0.085);
    band.frequency.exponentialRampToValueAtTime(480, t + 0.19);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.06, t + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.2, t + 0.085);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    air.connect(band).connect(gain).connect(master);
    air.start(t);
    air.stop(t + 0.26);
  }

  /**
   * A football leaving a hand. A leathery grunt-and-whoosh, 180 ms.
   *
   * This replaced a raygun's descending square wave, and the two are opposites
   * by design rather than by accident. A laser is a *synthetic* sound -- odd
   * harmonics falling three octaves, the one thing in this file that was not a
   * physical event -- and everything about a thrown ball is physical. So it is
   * back in this file's ordinary vocabulary: noise bursts and envelopes.
   *
   * Two layers, on `thwack`'s argument that a sound has to read at two ranges:
   *
   *   - the **slap** is the ball coming off the hand: 6 ms of bandpassed noise
   *     around 900 Hz, which is the frequency a palm on leather actually lives
   *     at. Short and dry, because the hand is not resonant.
   *   - the **whoosh** is the ball going away, and it is what carries the sound
   *     at distance: broadband noise swept 700 Hz down to 240 over 150 ms. The
   *     *downward* sweep is the whole cue -- a rising one reads as an object
   *     approaching, which is precisely the wrong information to give somebody
   *     about a ball that has just left.
   *
   * `distance` attenuates it, because unlike a swing a throw is heard across a
   * street: `1 / (1 + d/14)` is down to a third at 28 m and a fifth at 56, which
   * covers the range a ball can actually reach. Not a real inverse square --
   * that is inaudible at 40 m, and a throw you cannot hear is a throw that did
   * not warn you.
   */
  footyThrow(distance = 0): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise) return;
    const t = ctx.currentTime;
    const gain = 1 / (1 + Math.max(0, distance) / 14);
    if (gain < 0.02) return;

    const slap = ctx.createBufferSource();
    slap.buffer = noise;
    slap.playbackRate.value = 1.4;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 1.6;
    band.frequency.value = 900;
    const slapGain = ctx.createGain();
    slapGain.gain.setValueAtTime(0.0001, t);
    slapGain.gain.exponentialRampToValueAtTime(0.22 * gain, t + 0.005);
    slapGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    slap.connect(band).connect(slapGain).connect(master);
    slap.start(t);
    slap.stop(t + 0.1);

    const air = ctx.createBufferSource();
    air.buffer = noise;
    air.playbackRate.value = 0.85;
    const sweep = ctx.createBiquadFilter();
    sweep.type = 'bandpass';
    // Broad, for `whiff`'s reason: a high-Q sweep over noise turns into a
    // whistle, and a whistling football is a firework.
    sweep.Q.value = 0.8;
    sweep.frequency.setValueAtTime(700, t);
    sweep.frequency.exponentialRampToValueAtTime(240, t + 0.15);
    const airGain = ctx.createGain();
    airGain.gain.setValueAtTime(0.0001, t);
    airGain.gain.exponentialRampToValueAtTime(0.1 * gain, t + 0.03);
    airGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    air.connect(sweep).connect(airGain).connect(master);
    air.start(t);
    air.stop(t + 0.22);
  }

  /**
   * A football bouncing off the pavement. A short leather thud, 120 ms.
   *
   * `bounce` is which bounce this is, 1-based, and it **pitches the thud down
   * and quietens it** with each one. That is one multiply and it is the single
   * most useful thing this sound does: a player who cannot see the ball can hear
   * whether it is still lively or has spent itself, which is the information
   * that decides whether to chase it or ignore it.
   *
   * Two layers again, both short:
   *
   *   - the **knock** is the leather: a bandpassed noise burst at 420 Hz with a
   *     3 ms attack. Lower and much shorter than the bat's 2.6 kHz crack,
   *     because leather on asphalt is a dead sound where willow on bone is not.
   *   - the **body** is a sine falling from 150 Hz to 60 over 90 ms, which is
   *     the same "something heavy happened" cue `thwack` uses and is what stops
   *     the knock reading as a stick being tapped.
   */
  footyBounce(distance = 0, bounce = 1): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise) return;
    const t = ctx.currentTime;
    const gain = 1 / (1 + Math.max(0, distance) / 10);
    // Each bounce is a fifth quieter and a fifth lower. Clamped rather than
    // open-ended because the bounce budget is three and a fourth would be
    // inaudible anyway.
    const spend = Math.pow(0.78, Math.max(0, bounce - 1));
    const level = gain * spend;
    if (level < 0.02) return;

    const knock = ctx.createBufferSource();
    knock.buffer = noise;
    knock.playbackRate.value = 0.9 * spend + 0.2;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 1.1;
    band.frequency.value = 420 * spend + 90;
    const knockGain = ctx.createGain();
    knockGain.gain.setValueAtTime(0.0001, t);
    knockGain.gain.exponentialRampToValueAtTime(0.2 * level, t + 0.003);
    knockGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    knock.connect(band).connect(knockGain).connect(master);
    knock.start(t);
    knock.stop(t + 0.12);

    const body = ctx.createOscillator();
    body.type = 'sine';
    body.frequency.setValueAtTime(150 * spend + 30, t);
    body.frequency.exponentialRampToValueAtTime(60 * spend + 20, t + 0.09);
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.16 * level, t + 0.006);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    body.connect(bodyGain).connect(master);
    body.start(t);
    body.stop(t + 0.14);
  }

  /**
   * A football landing in the harbour. 220 ms of filtered noise, and then it is
   * gone -- which is the point: the ball is dead and the sound has to say so.
   *
   * A rising, closing band rather than a falling one, which is the opposite of
   * every other impact in this file and is what a splash is: the initial
   * displacement is broadband, and what follows it is the water closing over,
   * which is energy *leaving* the top end.
   */
  footySplash(distance = 0): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise) return;
    const t = ctx.currentTime;
    const gain = 1 / (1 + Math.max(0, distance) / 10);
    if (gain < 0.02) return;

    const water = ctx.createBufferSource();
    water.buffer = noise;
    water.playbackRate.value = 1.1;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    lp.frequency.setValueAtTime(5200, t);
    lp.frequency.exponentialRampToValueAtTime(420, t + 0.2);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18 * gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    water.connect(lp).connect(g).connect(master);
    water.start(t);
    water.stop(t + 0.26);
  }

  /**
   * A football landing on a person. `thwack`'s three layers, re-voiced.
   *
   * Deliberately **not** `thwack` itself, and the difference is one the ear
   * makes instantly: a bat is a *crack* -- a narrow 2.6 kHz burst with a 2.5 ms
   * attack, which is timber -- and a ball is a *slap*, broader and 900 Hz lower,
   * with the same weight under it. A player has to be able to tell without
   * looking whether they were hit at range or in the face, because the two ask
   * for opposite responses: one means close the distance and the other means
   * get out of it.
   *
   * The knockout variant is the same trick `thwack` uses -- everything pitched
   * down and stretched -- because a bigger thing making a lower, longer noise is
   * the comic-book convention and is one multiply rather than a second sound.
   */
  footyHit(knockout = false): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise) return;
    const t = ctx.currentTime;
    const k = knockout ? 0.62 : 1;

    const slap = ctx.createBufferSource();
    slap.buffer = noise;
    slap.playbackRate.value = 0.95 * k;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    // Broader than the bat's, which is most of what makes it leather rather
    // than willow: a wide burst reads as a soft wide object.
    band.Q.value = 0.85;
    band.frequency.value = 1700 * k;
    const slapGain = ctx.createGain();
    slapGain.gain.setValueAtTime(0.0001, t);
    slapGain.gain.exponentialRampToValueAtTime(knockout ? 0.34 : 0.26, t + 0.004);
    slapGain.gain.exponentialRampToValueAtTime(0.0001, t + (knockout ? 0.16 : 0.09));
    slap.connect(band).connect(slapGain).connect(master);
    slap.start(t);
    slap.stop(t + 0.2);

    const body = ctx.createOscillator();
    body.type = 'sine';
    body.frequency.setValueAtTime(165 * k, t);
    body.frequency.exponentialRampToValueAtTime(52 * k, t + (knockout ? 0.2 : 0.085));
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(knockout ? 0.3 : 0.22, t + 0.007);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + (knockout ? 0.24 : 0.11));
    body.connect(bodyGain).connect(master);
    body.start(t);
    body.stop(t + 0.28);
  }

  /**
   * The bat middling a football: the thock. See `game/swat.ts`.
   *
   * **`thwack`'s three layers at a different pitch**, which is what the change
   * that added this asked for and is also the right answer on its own terms: the
   * object making the noise is the same 0.83 m of willow, and what changed is
   * only what it hit. So the recipe is the bat's and the numbers are moved by one
   * ratio each, in the direction leather-on-willow moves them from bone-on-willow:
   *
   *   - the **crack** goes *up*, 2.6 kHz to 3.4, and gets shorter. A ball is
   *     harder and lighter than a person and the contact is over in a third of
   *     the time, and the top end is the whole of what the ear identifies as
   *     "middled" rather than "edged".
   *   - the **knock** -- the blade's own two inharmonic partials -- goes up a
   *     tone and decays faster. A bat rung by a ball rings; a bat rung by a
   *     torso is damped by the torso.
   *   - the **body** all but disappears: 0.18 against `thwack`'s 0.62, because
   *     nothing heavy moved. That single ratio is most of what separates the two
   *     sounds at range, and it is deliberate that the swat is the *quieter*
   *     event -- it is a save rather than a score.
   *
   * `distance` attenuates on `footyBounce`'s curve, because unlike `thwack` this
   * can happen to somebody else 40 m away: a swat is announced to every client in
   * interest of the ball, not only to the two players in the exchange.
   */
  swat(distance = 0): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise) return;
    const t = ctx.currentTime;
    const gain = 1 / (1 + Math.max(0, distance) / 10);
    if (gain < 0.02) return;

    // --- The crack, higher and shorter than the bat's own.
    const burst = ctx.createBufferSource();
    burst.buffer = noise;
    burst.playbackRate.value = 1.7;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 3400;
    // Tighter still than `thwack`'s 1.5. Two hard objects meeting is the
    // narrowest impact in this file.
    band.Q.value = 1.9;
    const burstGain = ctx.createGain();
    burstGain.gain.setValueAtTime(0.0001, t);
    burstGain.gain.exponentialRampToValueAtTime(0.62 * gain, t + 0.002);
    burstGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
    burst.connect(band).connect(burstGain).connect(master);
    burst.start(t);
    burst.stop(t + 0.09);

    // --- The blade's two partials, a tone up on `thwack`'s and shorter. The
    // 2.95 ratio is kept: it is what says "solid piece of wood" instead of
    // "note", and it is a property of the bat rather than of what it hit.
    for (const [hz, level, fall] of [
      [440, 0.3, 0.05],
      [1298, 0.17, 0.028],
    ] as Array<[number, number, number]>) {
      const partial = ctx.createOscillator();
      partial.type = 'triangle';
      partial.frequency.setValueAtTime(hz, t);
      partial.frequency.exponentialRampToValueAtTime(hz * 0.9, t + fall);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(level * gain, t + 0.0025);
      g.gain.exponentialRampToValueAtTime(0.0001, t + fall);
      partial.connect(g).connect(master);
      partial.start(t);
      partial.stop(t + fall + 0.05);
    }

    // --- And almost no body. See the header: nothing heavy moved.
    const body = ctx.createOscillator();
    body.type = 'sine';
    body.frequency.setValueAtTime(210, t);
    body.frequency.exponentialRampToValueAtTime(90, t + 0.05);
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.18 * gain, t + 0.005);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    body.connect(bodyGain).connect(master);
    body.start(t);
    body.stop(t + 0.11);
  }

  /**
   * A pedestrian being clobbered: the oof.
   *
   * The only sound in this file made by a *person* rather than by an object, and
   * that is the whole design brief for it. Everything else here is an impact --
   * willow, leather, water, porcelain -- and a bystander going over has to be
   * instantly separable from all of it, because the player needs to know they hit
   * a passer-by and not another player without looking at what fell over.
   *
   * Two layers, and both of them are voice rather than percussion:
   *
   *   - the **grunt**: a sawtooth falling from 170 Hz to 105 over 190 ms,
   *     through a lowpass that closes from 1.1 kHz to 380. A sawtooth under a
   *     closing filter is the crudest possible vocal-tract model and it is
   *     enough -- what makes a noise read as a voice is a *harmonic* source with
   *     a formant sliding down it, and nothing else in this file has either.
   *     The pitch drop is the "oo" to "f".
   *   - the **thump**: the body reaching the footpath, 90 ms behind the grunt.
   *     A short sine at 90 Hz, far quieter than `thwack`'s body layer, because
   *     the point of the pair is that hitting a pedestrian sounds *smaller* than
   *     hitting a player. This is a cosmetic event, and a sound that competed
   *     with the bat would make it feel like a scoring one.
   *
   * `distance` attenuates on `footyBounce`'s curve. There can be twenty people
   * inside 120 m and a bat swing can only ever reach one of them, so this is
   * always close -- the falloff is here so a football thrown down the street and
   * connecting at 30 m does not sound like it happened at the player's feet.
   *
   * A pitch offset per hit rather than one fixed voice: `seed` is the walker's
   * own hash, so the same person always sounds the same and two different people
   * do not. It is a semitone and a half either way, which is enough to read as
   * different people and not enough to read as a pitch-shifted sample.
   */
  oof(distance = 0, seed = 0): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    const gain = 1 / (1 + Math.max(0, distance) / 12);
    if (gain < 0.02) return;
    // A stable per-person pitch in [0.92, 1.09]. Integer hash, so the same
    // pedestrian is the same voice every time they are knocked over.
    const h = ((Math.imul(seed | 0, 0x27d4eb2d) >>> 0) ^ 0x9e3779b9) >>> 0;
    const voice = 0.92 + (h % 1000) / 5882;

    const grunt = ctx.createOscillator();
    grunt.type = 'sawtooth';
    grunt.frequency.setValueAtTime(170 * voice, t);
    grunt.frequency.exponentialRampToValueAtTime(105 * voice, t + 0.19);
    const throat = ctx.createBiquadFilter();
    throat.type = 'lowpass';
    // Low Q. A resonant sweep here is a wah pedal, which is a very different
    // kind of comedy from the one this is going for.
    throat.Q.value = 0.8;
    throat.frequency.setValueAtTime(1100 * voice, t);
    throat.frequency.exponentialRampToValueAtTime(380 * voice, t + 0.17);
    const gruntGain = ctx.createGain();
    // A 12 ms attack rather than an impact's 4: a voice starts, it does not
    // strike.
    gruntGain.gain.setValueAtTime(0.0001, t);
    gruntGain.gain.exponentialRampToValueAtTime(0.16 * gain, t + 0.012);
    gruntGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.21);
    grunt.connect(throat).connect(gruntGain).connect(master);
    grunt.start(t);
    grunt.stop(t + 0.26);

    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(90, t + 0.09);
    thump.frequency.exponentialRampToValueAtTime(48, t + 0.19);
    const thumpGain = ctx.createGain();
    thumpGain.gain.setValueAtTime(0.0001, t + 0.09);
    thumpGain.gain.exponentialRampToValueAtTime(0.12 * gain, t + 0.098);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.21);
    thump.connect(thumpGain).connect(master);
    thump.start(t + 0.09);
    thump.stop(t + 0.26);
  }

  /**
   * A level: four notes up, and a low swell underneath them.
   *
   * `pickupTraining`'s argument, one step further. A pickup is good news that
   * happens twenty times a session, so it is 400 ms and gone; a level happens
   * ten times a *week* and is the only moment the game stops to tell you
   * something about you rather than about the street. So it is the same major
   * shape -- nothing else in the mix is tonal -- but a fourth note, a longer
   * ring, and a sine an octave and a half below that swells under the arpeggio
   * and outlasts it, which is what makes it read as an arrival rather than as a
   * bigger pickup.
   *
   * D-F#-A-D (587.33, 739.99, 880, 1174.66) at 95 ms, against a 146.83 Hz sine.
   * Deliberately a different root from the pickup's A so the two are not the
   * same gesture at different lengths.
   */
  levelUp(): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const t = ctx.currentTime;

    const notes = [587.33, 739.99, 880, 1174.66];
    for (let i = 0; i < notes.length; i++) {
      const start = t + i * 0.095;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(notes[i], start);
      const gain = ctx.createGain();
      const fall = i === notes.length - 1 ? 0.85 : 0.19;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(i === notes.length - 1 ? 0.34 : 0.26, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + fall);
      osc.connect(gain).connect(master);
      osc.start(start);
      osc.stop(start + fall + 0.05);
    }

    // The swell. It starts with the first note and is still going when the last
    // one has died, so the beat has a floor under it rather than four pings.
    const bed = ctx.createOscillator();
    bed.type = 'sine';
    bed.frequency.setValueAtTime(146.83, t);
    const bedGain = ctx.createGain();
    bedGain.gain.setValueAtTime(0.0001, t);
    bedGain.gain.exponentialRampToValueAtTime(0.18, t + 0.18);
    bedGain.gain.exponentialRampToValueAtTime(0.0001, t + 1.25);
    bed.connect(bedGain).connect(master);
    bed.start(t);
    bed.stop(t + 1.3);
  }

  /**
   * Spec 8.3's Training pickup: a rising three-note chime.
   *
   * The one sound in this file that is *pitched*, and that is the whole design.
   * Everything else here is an impact -- noise and a falling sine, which is the
   * vocabulary of things going wrong. A powerup is the only good news the game
   * has, and the cheapest way to say so in 400 ms is a major arpeggio going
   * *up*: nothing else in the mix is tonal, so it cannot be mistaken for a
   * punch even at the far end of a street.
   *
   * A-C#-E over two octaves (440, 554.4, 880 Hz), triangle waves for a little
   * more harmonic content than a sine without the buzz of a saw, 110 ms apart
   * so the three read as one gesture rather than as three events. The last note
   * is the octave rather than the fifth because an arpeggio that lands on its
   * own root is *finished*, and a pickup should not sound like it is waiting
   * for something.
   */
  pickupTraining(): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const t = ctx.currentTime;

    const notes = [440, 554.37, 880];
    for (let i = 0; i < notes.length; i++) {
      const start = t + i * 0.11;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(notes[i], start);
      const gain = ctx.createGain();
      // The last note rings longer than the two under it, which is what makes
      // the pair of grace notes read as an approach to it.
      const fall = i === notes.length - 1 ? 0.42 : 0.17;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.3, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + fall);
      osc.connect(gain).connect(master);
      osc.start(start);
      osc.stop(start + fall + 0.05);
    }
  }

  // --- The car ----------------------------------------------------------------

  /**
   * Metal meeting something that is not going to move: the crunch.
   *
   * `strength` is 0 to 1, and it is the crash's own delta-v scaled by the top
   * speed -- so a kerb at 4 m/s and a wall at 22 arrive here as 0.05 and 1, and
   * the sound is the *same recipe* at two intensities rather than two sounds
   * with a threshold between them. That continuity is the audio half of
   * `driving.CRASH_FREE_SPEED`'s argument: a step in the damage curve would be
   * unfair and a step in the sound would be worse, because a player learns how
   * hard they hit something by ear long before they look at the bar.
   *
   * Three layers, on `thwack`'s structure and re-voiced for sheet steel:
   *
   *   - the **crunch** says *panel*. A bandpassed noise burst, but wide (Q 0.6
   *     against the bat's 1.5) and low (900 Hz), with a 4 ms attack. A bat is a
   *     narrow crack because willow is one dense object; a wing is a broad
   *     scrape because it is a large thin thing that goes on failing for a few
   *     milliseconds after it starts.
   *   - the **crack** says *glass and trim*, and it is the layer that separates
   *     a real crash from a scrape: a short high burst at 4.2 kHz that only
   *     appears past `SHATTER_STRENGTH`. Nothing on a car makes that noise until
   *     something breaks.
   *   - the **thud** says *two tonnes stopped*. A sine from 130 Hz to 38 over
   *     `0.1 + 0.2 x strength` seconds -- the one layer that gets *longer* with
   *     the impact rather than merely louder, which is the whole of why a big
   *     crash reads as big.
   *
   * Driver-local and unattenuated: this is a thing that happened to the car you
   * are sitting in. A crash somebody else had thirty metres away is *their*
   * client's business, which is the same call `thwack` makes about being hit.
   */
  carCrunch(strength: number): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise) return;
    const k = strength < 0 ? 0 : strength > 1 ? 1 : strength;
    if (k < 0.02) return;
    const t = ctx.currentTime;
    // A floor under the level as well as a scale, because the quietest crash
    // that reaches here is still a crash and has to be audible over a running
    // engine and a city: 0.25 at nothing, 1 at a write-off.
    const level = 0.25 + 0.75 * k;

    // --- The panel.
    const panel = ctx.createBufferSource();
    panel.buffer = noise;
    // Lower playback for a bigger impact: a heavier crash is a slower failure,
    // which is `thwack`'s knockout trick and is one multiply rather than a
    // second sound to design.
    panel.playbackRate.value = 1.15 - 0.35 * k;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 900;
    // Wide. See the header: sheet steel is not willow.
    band.Q.value = 0.6;
    const panelGain = ctx.createGain();
    panelGain.gain.setValueAtTime(0.0001, t);
    panelGain.gain.exponentialRampToValueAtTime(0.5 * level, t + 0.004);
    panelGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1 + 0.14 * k);
    panel.connect(band).connect(panelGain).connect(master);
    panel.start(t);
    panel.stop(t + 0.32);

    // --- The glass, only past the point where something actually breaks.
    if (k > SHATTER_STRENGTH) {
      const shard = ctx.createBufferSource();
      shard.buffer = noise;
      shard.playbackRate.value = 2.1;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 4200;
      const shardGain = ctx.createGain();
      // Starting 12 ms in, not at zero: glass breaks *after* the panel folds,
      // and the twelve milliseconds are the whole difference between one event
      // and two.
      const at = t + 0.012;
      shardGain.gain.setValueAtTime(0.0001, at);
      shardGain.gain.exponentialRampToValueAtTime(0.3 * (k - SHATTER_STRENGTH) / (1 - SHATTER_STRENGTH), at + 0.004);
      shardGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      shard.connect(hp).connect(shardGain).connect(master);
      shard.start(at);
      shard.stop(at + 0.2);
    }

    // --- The weight.
    const body = ctx.createOscillator();
    body.type = 'sine';
    const fall = 0.1 + 0.2 * k;
    body.frequency.setValueAtTime(130, t);
    body.frequency.exponentialRampToValueAtTime(38, t + fall);
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.34 * level, t + 0.008);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + fall);
    body.connect(bodyGain).connect(master);
    body.start(t);
    body.stop(t + fall + 0.06);
  }

  /**
   * A kerb, a bollard, a wing along a wall: the thump.
   *
   * `carCrunch`'s panel layer alone, quieter and shorter, with no glass and
   * almost no weight under it. It exists as a separate call rather than as
   * `carCrunch(0.05)` because the two mean different things to a player and the
   * difference has to be audible without looking: a crunch is *damage* and a
   * thump is *you touched something*, and the crash cooldown means a thump often
   * costs nothing at all. A sound that scaled continuously all the way down to
   * silence would leave the player unable to tell "that was free" from "that was
   * one hit point".
   */
  carScrape(): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise) return;
    const t = ctx.currentTime;

    const rub = ctx.createBufferSource();
    rub.buffer = noise;
    rub.playbackRate.value = 0.8;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 620;
    band.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.14, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    rub.connect(band).connect(gain).connect(master);
    rub.start(t);
    rub.stop(t + 0.14);
  }

  /**
   * --- WORKSTREAM Y: one crackle of a bonnet fire, at `level` of full roar.
   *
   * **Retriggered rather than looped**, which is the one structural decision in
   * it. This file builds looping chains for the two things that run for minutes
   * -- `heatUpdate`'s siren and `raveUpdate`'s music -- and each costs a graph
   * that has to be faded out and torn down on a timer. A car fire lasts six
   * seconds and then there is no car, so the caller fires one of these four
   * times a second at the level `carfire.fireGrade` reports, and the *ramp* --
   * the thing the brief asked for, a crackle that gets louder toward the fuse --
   * falls out of the level rising rather than out of a gain automation.
   *
   * Two layers, and they are the two halves of what burning petrol sounds like:
   * a **roar**, which is lowpassed noise with no attack to speak of, and a
   * **spit**, a short bandpassed tick on top of it. The spit is the layer that
   * makes it a fire rather than a distant motorway; it appears only past half
   * strength, so a fire that has just caught whooshes and one that is about to
   * go off snaps.
   *
   * Driver-local and unattenuated, on `carCrunch`'s rule: this is the car you
   * are sitting in, and somebody else's fire thirty metres away is their
   * client's business. What is *not* driver-local is the bang -- see `carBoom`.
   */
  carCrackle(level: number): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise) return;
    const k = level < 0 ? 0 : level > 1 ? 1 : level;
    if (k < 0.02) return;
    const t = ctx.currentTime;

    const roar = ctx.createBufferSource();
    roar.buffer = noise;
    roar.playbackRate.value = 0.45;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    lp.Q.value = 0.5;
    const roarGain = ctx.createGain();
    roarGain.gain.setValueAtTime(0.0001, t);
    roarGain.gain.exponentialRampToValueAtTime(0.11 * k, t + 0.05);
    // Held for the whole retrigger interval and then faded, so consecutive
    // bursts overlap into something continuous rather than pulsing at 4 Hz.
    roarGain.gain.setValueAtTime(0.11 * k, t + 0.2);
    roarGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    roar.connect(lp).connect(roarGain).connect(master);
    roar.start(t);
    roar.stop(t + 0.38);

    if (k > 0.5) {
      const spit = ctx.createBufferSource();
      spit.buffer = noise;
      spit.playbackRate.value = 1.7;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 2600;
      band.Q.value = 1.2;
      const spitGain = ctx.createGain();
      const at = t + 0.06;
      spitGain.gain.setValueAtTime(0.0001, at);
      spitGain.gain.exponentialRampToValueAtTime(0.09 * (k - 0.5) * 2, at + 0.004);
      spitGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
      spit.connect(band).connect(spitGain).connect(master);
      spit.start(at);
      spit.stop(at + 0.09);
    }
  }

  /**
   * --- WORKSTREAM Y: **a car exploding**, heard from `distance` metres.
   *
   * Three layers and a delay, and the delay is the most important of the four.
   *
   * `polairReport` next door already established the shape this borrows: a sound
   * that has travelled a long way is not the near sound turned down, it is a
   * *different* sound -- the top is absorbed by the air, the tail becomes most of
   * what reaches you, and the whole thing arrives late. A rifle at 250 m is that
   * file's example; a car going off at 200 m across Redfern is this one's, and
   * the read is the same: **you see the flash and then you hear it**, which is
   * the single cheapest way to make a world feel large.
   *
   * The difference from the rifle is the bottom end. A report is a crack with its
   * top taken off and nothing underneath; a car is a fuel tank, so:
   *
   *   - the **blast** is a noise burst with a lowpass that closes as it goes,
   *     which is the air absorption written as an envelope rather than as a
   *     fixed filter -- the near part of the sound is bright and the part that
   *     arrives a moment later is not;
   *   - the **thump** is a sine falling from 90 Hz to 22 over most of a second.
   *     Lower and much longer than `carCrunch`'s 130-to-38, because that layer
   *     says "two tonnes stopped" and this one says "the tank went up". It is
   *     also the only layer that survives a long trip, which is why a distant
   *     explosion is mostly this;
   *   - the **debris**, a short crackle of highpassed noise a fifth of a second
   *     in, which is the part that tells you it was a *car* rather than a bomb:
   *     glass and panels landing.
   *
   * `distance` attenuates on a gentler curve even than `polairReport`'s, and the
   * `setTimeout` is the sound taking `distance / SOUND_SPEED` to arrive. The
   * caller owns neither -- unlike Polair, where the helicopter counts its own
   * delay down, because there the *emitter* knows where it is and here the event
   * is a twenty-byte frame that arrived from a server.
   */
  carBoom(distance = 0): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise) return;
    const far = Math.max(0, distance);
    // Audible a long way, which is the point of an explosion: 0.5 at 250 m and
    // still 0.25 at 750. Under about 2% it is not worth the four nodes.
    const gain = 1 / (1 + far / 250);
    if (gain < 0.02) return;
    // How far away a bang stops being an *event* and becomes weather. Past this
    // the sound is scheduled but the ear will not connect it to anything, and
    // the delay is capped so a boom on the far side of the city does not arrive
    // ten seconds later as a mystery.
    const delay = Math.min(BOOM_DELAY_MAX_S, far / BOOM_SOUND_SPEED);

    const fire = (): void => {
      // Re-read: the context can have gone away while the sound was in the air.
      const now = this.ctx;
      const out = this.master;
      const source = this.noise;
      if (!now || !out || !source) return;
      const t = now.currentTime;

      // --- The blast.
      const blast = now.createBufferSource();
      blast.buffer = source;
      blast.playbackRate.value = 0.7;
      const lp = now.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.4;
      // Closing rather than fixed: the air absorption, as an envelope. A distant
      // bang starts duller, which is the `far` term in the opening frequency.
      lp.frequency.setValueAtTime(far > 60 ? 1800 : 5200, t);
      lp.frequency.exponentialRampToValueAtTime(180, t + 0.7);
      const blastGain = now.createGain();
      blastGain.gain.setValueAtTime(0.0001, t);
      blastGain.gain.exponentialRampToValueAtTime(0.75 * gain, t + 0.008);
      blastGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
      blast.connect(lp).connect(blastGain).connect(out);
      blast.start(t);
      blast.stop(t + 0.8);

      // --- The tank.
      const body = now.createOscillator();
      body.type = 'sine';
      body.frequency.setValueAtTime(90, t);
      body.frequency.exponentialRampToValueAtTime(22, t + 0.85);
      const bodyGain = now.createGain();
      bodyGain.gain.setValueAtTime(0.0001, t);
      bodyGain.gain.exponentialRampToValueAtTime(0.5 * gain, t + 0.012);
      bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      body.connect(bodyGain).connect(out);
      body.start(t);
      body.stop(t + 0.95);

      // --- The debris, and only close enough for the top end to survive the
      //     trip. Past a couple of hundred metres there is no glass in a bang.
      if (far < 220) {
        const bits = now.createBufferSource();
        bits.buffer = source;
        bits.playbackRate.value = 1.9;
        const hp = now.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 3200;
        const bitsGain = now.createGain();
        const at = t + 0.2;
        bitsGain.gain.setValueAtTime(0.0001, at);
        bitsGain.gain.exponentialRampToValueAtTime(0.22 * gain, at + 0.03);
        bitsGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
        bits.connect(hp).connect(bitsGain).connect(out);
        bits.start(at);
        bits.stop(at + 0.55);
      }
    };

    // A boom you are standing next to is not scheduled at all, because a
    // `setTimeout(0)` is still a frame of latency on the one sound that must
    // land with the flash.
    if (delay < 0.02) fire();
    else setTimeout(fire, delay * 1000);
  }

  /**
   * A car horn. Two detuned squares and a filter, which is what a horn is.
   *
   * A real car horn is a pair of electromagnetic diaphragms tuned about a
   * semitone apart -- typically near 400 and 500 Hz -- and the beating between
   * them is the whole character of the sound. Two oscillators is therefore not a
   * simplification here; it is the mechanism. Square waves rather than sines
   * because a diaphragm clatters rather than sings, and a lowpass at 2.4 kHz to
   * take the top off the square so it reads as brass rather than as a chiptune.
   *
   * `distance` attenuates on `footyBounce`'s curve, because unlike the crunch
   * this is a sound *other* cars make: the horn a player leans on is at zero and
   * an ambient car honking at somebody standing in Pitt Street is at whatever
   * the range is.
   *
   * This replaces the `thwack(false)` that stood in for a horn when the driving
   * landed -- a stand-in the driving workstream flagged in `main.ts` and did not
   * have the budget to fix.
   */
  carHorn(distance = 0): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    const gain = 1 / (1 + Math.max(0, distance) / 10);
    if (gain < 0.02) return;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2400;
    lp.Q.value = 0.7;
    const out = ctx.createGain();
    // A fast attack and a fast release, both a few milliseconds: a horn is a
    // switch, and anything slower reads as a synthesiser pad.
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(0.13 * gain, t + 0.008);
    out.gain.setValueAtTime(0.13 * gain, t + HORN_SECONDS - 0.03);
    out.gain.exponentialRampToValueAtTime(0.0001, t + HORN_SECONDS);
    lp.connect(out).connect(master);

    for (const hz of HORN_PARTIALS) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(hz, t);
      osc.connect(lp);
      osc.start(t);
      osc.stop(t + HORN_SECONDS + 0.02);
    }
  }

  /**
   * Spec 8.3's Flat White pickup: the hiss of a steam wand and two cups.
   *
   * Deliberately *not* tonal, and deliberately shorter than the Training
   * chime -- the two have to be told apart with no visual, and pitch versus
   * texture separates them far better than two different melodies would. It is
   * also the quieter of the two, because there are 800 cafes in the inner ring
   * and one of these every twenty seconds at full volume would be the loudest
   * thing in the game.
   *
   * The hiss is a highpassed noise burst with a slow attack, which is what a
   * steam wand is; the two pings are short sines a fifth apart at porcelain
   * frequencies, 60 ms in, landing while the hiss is still going.
   */
  pickupFlatWhite(): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise) return;
    const t = ctx.currentTime;

    const steam = ctx.createBufferSource();
    steam.buffer = noise;
    steam.playbackRate.value = 1.35;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 2600;
    const steamGain = ctx.createGain();
    // A 40 ms attack rather than the impact's 4 ms: what makes a hiss a hiss
    // instead of a snare is that it has no transient at all.
    steamGain.gain.setValueAtTime(0.0001, t);
    steamGain.gain.exponentialRampToValueAtTime(0.13, t + 0.04);
    steamGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    steam.connect(hp).connect(steamGain).connect(master);
    steam.start(t);
    steam.stop(t + 0.36);

    for (const [delay, hz] of [
      [0.06, 1860],
      [0.115, 2790],
    ] as Array<[number, number]>) {
      const ping = ctx.createOscillator();
      ping.type = 'sine';
      ping.frequency.setValueAtTime(hz, t + delay);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.17, t + delay + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.13);
      ping.connect(gain).connect(master);
      ping.start(t + delay);
      ping.stop(t + delay + 0.18);
    }
  }
  // --- The phone's camera -------------------------------------------------------

  /**
   * The shutter: the phone's camera taking a photograph.
   *
   * Synthesised, obviously -- but the interesting part is *what is being
   * synthesised*, because a smartphone has no shutter and the noise it makes is
   * itself a synthesised imitation of a mechanical one. So this is a recording
   * of a fake of a real thing, which means the target is not physics, it is the
   * **convention**: two hard clicks about 45 ms apart, high, short and dry.
   * Nobody has heard a real focal-plane shutter in twenty years and everybody
   * knows exactly what that pair of clicks means.
   *
   * Two layers, on `thwack`'s structure at a twentieth of its size:
   *
   *   - each **click** is a noise burst through a tight bandpass at 3.4 kHz with
   *     a 1 ms attack and a 22 ms decay. The attack is the whole thing, as it is
   *     for the bat: what the ear reads as a mechanism is the rise time. A
   *     bandpass rather than a highpass because an unfiltered burst reads as a
   *     hi-hat, which is a cymbal and not a machine.
   *   - a **tick** of body under the first one only: a 900 Hz sine for 18 ms at
   *     a third of the level, which is the mirror going up. It is under the
   *     first click and not the second because that is the asymmetry a real
   *     mechanism has, and it is what stops the pair reading as a stutter.
   *
   * Unattenuated and not distance-scaled: the phone is in your hand. There is
   * no remote version of this and there should not be -- a photograph is not an
   * event in the world, and a city where you could hear other people taking
   * pictures would be a city full of clicking.
   */
  shutter(): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise) return;
    const t = ctx.currentTime;

    for (const [delay, level] of [
      [0, 0.2],
      [0.045, 0.16],
    ] as Array<[number, number]>) {
      const start = t + delay;
      const burst = ctx.createBufferSource();
      burst.buffer = noise;
      // The second click is played a shade faster, which pitches it up: on a
      // real mechanism the two halves are different masses moving at different
      // speeds, and two identical clicks read as an echo rather than as a pair.
      burst.playbackRate.value = delay === 0 ? 1 : 1.12;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 3400;
      band.Q.value = 2.2;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(level, start + 0.001);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.022);
      burst.connect(band).connect(gain).connect(master);
      burst.start(start);
      burst.stop(start + 0.05);
    }

    const body = ctx.createOscillator();
    body.type = 'sine';
    body.frequency.setValueAtTime(900, t);
    const bodyGain = ctx.createGain();
    bodyGain.gain.setValueAtTime(0.0001, t);
    bodyGain.gain.exponentialRampToValueAtTime(0.07, t + 0.002);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.018);
    body.connect(bodyGain).connect(master);
    body.start(t);
    body.stop(t + 0.04);
  }

  /**
   * A bush turkey. **Synthesised**, like every impact in this file and unlike
   * the four voice clips: there are no wildlife WAVs in this build and there
   * should not be -- a bird call is a synthesiser's natural subject, and three
   * species out of one file is a dozen oscillators against three downloads.
   *
   * A brush turkey's call is the least musical noise in an Australian park: a
   * series of low, rough clucks with a *descending* boom under them, produced
   * by an inflated neck sac, and what identifies it is that it is **pitched
   * absurdly low for the size of the bird**. So:
   *
   *   - three or four **clucks**, each a 30 ms sawtooth around 150 Hz through a
   *     lowpass, spaced 90 ms apart. Sawtooth rather than sine because the call
   *     is buzzy and a sine reads as a woodwind.
   *   - a **boom** under them, 110 Hz falling to 62 over 400 ms, at half the
   *     level. This is the sac, and it is what makes the whole thing sound like
   *     it is coming out of something much larger than a chicken.
   *
   * `angry` is the territorial version -- faster, a tone higher and with one
   * more cluck -- and it is what plays when a bird decides to charge. Hearing
   * that behind you is the entire warning system this feature has.
   */
  turkeyCall(distance = 0, angry = false): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    // The gentler of the two curves in this file -- `gunshot`'s, not the
    // punch's -- because a call across a park is meant to be audible from
    // across the park.
    const gain = 1 / (1 + Math.max(0, distance) / 22);
    if (gain < 0.02) return;

    const clucks = angry ? 5 : 3;
    const spacing = angry ? 0.075 : 0.1;
    const base = angry ? 172 : 148;
    for (let i = 0; i < clucks; i++) {
      const start = t + i * spacing;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      // Each cluck falls a little through its own 30 ms, which is what makes it
      // a cluck rather than a beep.
      osc.frequency.setValueAtTime(base * (1 + 0.05 * (i % 2)), start);
      osc.frequency.exponentialRampToValueAtTime(base * 0.72, start + 0.03);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      lp.Q.value = 1.4;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.exponentialRampToValueAtTime(0.24 * gain, start + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 0.055);
      osc.connect(lp).connect(g).connect(master);
      osc.start(start);
      osc.stop(start + 0.09);
    }

    const boom = ctx.createOscillator();
    boom.type = 'sine';
    boom.frequency.setValueAtTime(angry ? 124 : 110, t);
    boom.frequency.exponentialRampToValueAtTime(62, t + 0.4);
    const boomGain = ctx.createGain();
    boomGain.gain.setValueAtTime(0.0001, t);
    boomGain.gain.exponentialRampToValueAtTime(0.13 * gain, t + 0.05);
    boomGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.44);
    boom.connect(boomGain).connect(master);
    boom.start(t);
    boom.stop(t + 0.5);
  }

  /**
   * An ibis. One rough, nasal, thoroughly unpleasant honk.
   *
   * A white ibis is close to voiceless and what it does have is a grunt -- a
   * short croak with no pitch centre to speak of, which is why this is the only
   * call in the file built on a **square wave through a bandpass** rather than
   * on a tone: the odd harmonics and the narrow filter give the buzzing,
   * nasal quality, and the pitch drop over 90 ms is what makes it read as an
   * animal being put out rather than as a horn.
   */
  ibisHonk(distance = 0): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    const gain = 1 / (1 + Math.max(0, distance) / 16);
    if (gain < 0.02) return;

    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(196, t);
    osc.frequency.exponentialRampToValueAtTime(128, t + 0.09);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(760, t);
    bp.frequency.exponentialRampToValueAtTime(430, t + 0.12);
    bp.Q.value = 2.6;
    const g = ctx.createGain();
    // A slowish 12 ms attack: a grunt has no transient, which is most of what
    // separates it from a duck call.
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2 * gain, t + 0.012);
    g.gain.setValueAtTime(0.2 * gain, t + 0.055);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    osc.connect(bp).connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.2);
  }

  /**
   * A magpie carolling. The best sound in this country and the hardest one here
   * to fake.
   *
   * A real carol is two birds' worth of overlapping fluting glissandi with a
   * pitch range of about an octave and a half, and no synthesiser this small is
   * going to be mistaken for one. What it can capture is the **shape**: four or
   * five short notes, each *gliding* rather than stepping, alternating up and
   * down around a centre, on a nearly pure tone with a touch of second
   * harmonic. That shape is what the ear identifies, which is why the notes
   * ramp between frequencies instead of being set at them.
   *
   * `alarm` is the swoop version: shorter, higher, faster and repeated, which
   * is what a defending bird actually does and is the sound you get about a
   * third of a second before it hits you.
   */
  magpieWarble(distance = 0, alarm = false): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    const gain = 1 / (1 + Math.max(0, distance) / 26);
    if (gain < 0.02) return;

    // Frequency pairs: each note glides from the first to the second. The carol
    // wanders around 620 Hz; the alarm sits a fourth above it and stops moving,
    // which is the difference between singing and shouting.
    const carol: Array<[number, number, number]> = [
      [560, 690, 0.13],
      [740, 660, 0.1],
      [610, 800, 0.15],
      [780, 700, 0.12],
      [660, 620, 0.2],
    ];
    const alarmed: Array<[number, number, number]> = [
      [880, 940, 0.07],
      [910, 860, 0.06],
      [890, 950, 0.07],
      [920, 880, 0.06],
    ];
    const notes = alarm ? alarmed : carol;
    let at = t;
    for (const [from, to, length] of notes) {
      for (const [mult, level] of [[1, 0.16], [2, 0.045]] as Array<[number, number]>) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(from * mult, at);
        osc.frequency.exponentialRampToValueAtTime(to * mult, at + length);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(level * gain, at + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, at + length);
        osc.connect(g).connect(master);
        osc.start(at);
        osc.stop(at + length + 0.03);
      }
      at += length * (alarm ? 0.85 : 1.05);
    }
  }

  /**
   * The wings. What you actually hear in a swoop, and it arrives before the
   * bird does.
   *
   * Two layers and both of them are noise, because a wingbeat has no pitch at
   * all:
   *
   *   - the **whoosh**: 320 ms of noise through a bandpass swept from 1.9 kHz
   *     down to 380, which is a Doppler shape without any actual Doppler in it
   *     -- an object passing your ear loses its top end as it goes, and the
   *     sweep is what the ear reads as "past me" rather than "at me".
   *   - the **beats**: three short bursts inside the whoosh at 90 ms spacing,
   *     which is a magpie's 11 Hz stoop. Without them it is wind; with them it
   *     is something alive.
   *
   * Deliberately loud and close-ranged: at 30 m this is inaudible, and at 3 m
   * it is the loudest thing in the frame, which is exactly the distribution a
   * swoop has.
   */
  magpieSwoop(distance = 0): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise) return;
    const t = ctx.currentTime;
    const gain = 1 / (1 + Math.max(0, distance) / 9);
    if (gain < 0.02) return;

    const air = ctx.createBufferSource();
    air.buffer = noise;
    air.playbackRate.value = 1.1;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1900, t);
    bp.frequency.exponentialRampToValueAtTime(380, t + 0.3);
    bp.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22 * gain, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    air.connect(bp).connect(g).connect(master);
    air.start(t);
    air.stop(t + 0.36);

    for (let i = 0; i < 3; i++) {
      const start = t + 0.03 + i * 0.09;
      const beat = ctx.createBufferSource();
      beat.buffer = noise;
      beat.playbackRate.value = 0.8;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      const bg = ctx.createGain();
      bg.gain.setValueAtTime(0.0001, start);
      bg.gain.exponentialRampToValueAtTime(0.16 * gain, start + 0.01);
      bg.gain.exponentialRampToValueAtTime(0.0001, start + 0.07);
      beat.connect(lp).connect(bg).connect(master);
      beat.start(start);
      beat.stop(start + 0.09);
    }
  }

  /**
   * A beak connecting: a turkey's peck or a magpie's pass.
   *
   * `thwack`'s three-layer anatomy at a twentieth of the size. A quarter of a
   * pip is a very small event and it has to *read* as one -- what it must not
   * do is sound like the bat, because a player who cannot tell the difference
   * between being pecked and being hit has no idea why their health is going
   * down. So: a 1 ms tick of highpassed noise for the keratin, one 40 ms
   * inharmonic partial for the impact, and nothing at all underneath it. It is
   * the shortest sound in this file.
   */
  birdStrike(distance = 0): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise) return;
    const t = ctx.currentTime;
    const gain = 1 / (1 + Math.max(0, distance) / 7);
    if (gain < 0.02) return;

    const tick = ctx.createBufferSource();
    tick.buffer = noise;
    tick.playbackRate.value = 2.2;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3 * gain, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.028);
    tick.connect(hp).connect(g).connect(master);
    tick.start(t);
    tick.stop(t + 0.05);

    const knock = ctx.createOscillator();
    knock.type = 'triangle';
    knock.frequency.setValueAtTime(720, t);
    knock.frequency.exponentialRampToValueAtTime(430, t + 0.04);
    const kg = ctx.createGain();
    kg.gain.setValueAtTime(0.0001, t);
    kg.gain.exponentialRampToValueAtTime(0.16 * gain, t + 0.003);
    kg.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    knock.connect(kg).connect(master);
    knock.start(t);
    knock.stop(t + 0.06);
  }

  // --- The sound system -----------------------------------------------------------
  //
  // Everything below this line is one feature: the rig at an illegal rave, which
  // is the only thing in this file that is *music* rather than an event. It is
  // appended rather than woven in, and it reuses `master` and `noise` and
  // nothing else, so every sound above it is untouched.
  //
  // ---------------------------------------------------------------------------
  // 1. THE LOW-PASS THAT OPENS AS YOU WALK IN, WHICH IS THE WHOLE POINT.
  //
  // Air absorbs high frequencies and does almost nothing to low ones, and a
  // brick wall is worse: what reaches you from a warehouse three streets away is
  // the kick drum and nothing else. So the chain is
  //
  //     source -> lowpass -> [dry + convolved wet] -> distance gain -> master
  //
  // and `RAVE_CUTOFF_AT` metres decides the corner frequency. Measured against
  // the four tracks in the folder, which are level-matched at -14 LUFS:
  //
  //     175 m   367 Hz   a thump you feel in a street with nothing else on it
  //     100 m  1125 Hz   unmistakably music, no idea what music
  //      50 m  4500 Hz   the hats arrive; you can hear the track
  //      25 m    18 kHz  full mix
  //
  // **Those four distances used to be 400, 150, 60 and 25**, over a range of
  // 520 m, and the four *descriptions* are the thing that was kept when a
  // player asked for a third of the range. The progression is the feature; the
  // metres it is spread over are a tuning number. Only the last row is
  // unchanged, and it is unchanged on purpose: the full mix still starts at
  // 25 m, so a rave sounds exactly as it did once you are at one.
  //
  // Turning a corner at forty metres therefore opens the mix over about three
  // seconds of walking, and that transition is the single best trick available
  // to this feature. It is the reason the audio range (175 m) is *shorter* than
  // the beam range (900 m) and longer than everything else: you see it, then you
  // hear it, then you arrive.
  //
  // ---------------------------------------------------------------------------
  // 2. `<audio>` RATHER THAN `decodeAudioData`, AND IT IS NOT A STYLE CHOICE.
  //
  // The voice-clip path above decodes a whole file into an `AudioBuffer`, which
  // is right for a 1.5-second bark and catastrophic for a record: 344 seconds of
  // 48 kHz stereo float is **132 MB decoded**, and the folder holds four of them.
  // So a rave streams through a `MediaElementAudioSourceNode` instead, which
  // holds a rolling buffer, seeks with `currentTime`, and starts playing before
  // the file has finished arriving.
  //
  // Two elements, not one, because a set has mixes in it: the idle deck loads
  // the next record while the live one is still playing, and the swap is a
  // gain crossfade rather than a stall. That is also the whole of the prefetch
  // policy — nothing is fetched until a player is inside `RAVE_FETCH_RANGE` of a
  // rave that is actually playing, so **a player who never finds a rave never
  // downloads a track**.
  //
  // ---------------------------------------------------------------------------
  // 3. LEVELS ARE THE TRACKS'. NOTHING HERE NORMALISES ANYTHING.
  //
  // The records are mastered to -14 LUFS with a -1 dBTP ceiling, so they peak at
  // about 0.89 linear. At the closest range the deck runs at `RAVE_GAIN` = 0.62,
  // and `master` is 0.55, so a peak reaches the limiter at 0.55 * 0.62 * 0.89 =
  // **0.303** against its -8 dB threshold of 0.398. The music therefore never
  // touches the compressor; the only thing that ever pushes it over is a gunshot
  // landing on top of the music, which is exactly what that limiter is for.
  // Checked by arithmetic rather than by ear because the failure — a mix that
  // ducks every time somebody swings a bat — sounds like a mastering problem
  // rather than like a bug.
  //
  // ---------------------------------------------------------------------------
  // 4. WITH AN EMPTY FOLDER THERE IS STILL A RAVE.
  //
  // `raveSynth` is a four-on-the-floor generated from the *same shared beat
  // clock* the lights run on, so with no files at all every player at a rave is
  // on the same bar of the same pattern, the crowd is in time with it, and the
  // low-pass trick above works exactly as it does with a record on. It is a
  // scheduler with a 0.3 s lookahead over `game/rave.beatAt`, which means it
  // costs nothing when nobody is near a rave and needs no clock of its own.

  // --- The heat ladder's two loops: a siren and a rotor -----------------------
  //
  // **Synthesised, and this is the file's founding argument holding rather than
  // bending.** The one departure from it -- see `clips` at the top -- is for
  // *voice*, on the grounds that "Oi! Stop right there" is not two oscillators
  // and an envelope. A siren is *exactly* two oscillators and an envelope: it is
  // a swept tone, it has been a swept tone since 1965, and a sampled one would
  // be a file whose loop point, pitch and loudness were decided somewhere else
  // and would have to be crossfaded to move with the car. A rotor is filtered
  // noise chopped at blade-passing frequency, which is the physical description
  // and the synthesis recipe in the same sentence.
  //
  // Both are **loops rather than one-shots**, which is why they are here beside
  // the rave's chain rather than up with `gunshot` and `thwack`. A loop that is
  // built and torn down has a lifecycle, and the pattern for that in this file
  // is `raveUpdate`: one call a frame with a mix or `null`, the chain built on
  // the first frame it is wanted and faded out and dropped when it is not. See
  // `heatUpdate`.

  /** The live siren and rotor chain, or null when nothing is wanted. */
  private heat: HeatChain | null = null;

  /** The live chain, built on the first frame a rave is audible and torn down after. */
  private rave: RaveChain | null = null;
  /** Which venue the chain belongs to. A change tears the decks down. */
  private raveKey = -1;
  /** The next beat the synthesised set has already scheduled. */
  private raveBeat = 0;
  /** `ctx.currentTime` that beat index maps to. Re-anchored on drift. */
  private raveAnchor = 0;

  // --- The screaming sun's clip schedule. See `sunScreamUpdate`.
  /** Whether a scream is currently being scheduled. */
  private sunScreamActive = false;
  /** `ctx.currentTime` at which the next clip starts. */
  private sunScreamNextAt = 0;
  /** The index of the last clip played, so the next is never the same. */
  private sunScreamLastClip = -1;
  /**
   * When the clip now playing started and ends, in `ctx.currentTime` seconds --
   * the window the sun's mouth is open for. See `sunScreamLevel`.
   */
  private sunScreamClipStart = 0;
  private sunScreamClipEnd = 0;

  /**
   * Drive the sound system for this frame, or pass `null` for silence.
   *
   * Called unconditionally from the frame loop with whatever
   * `world/rave.ts` found to be nearest, so there is exactly one place that
   * decides what is audible and no state anywhere else. Returns nothing and
   * throws nothing: a browser with no audio is a rave with lights.
   */
  /**
   * The siren and the rotor, for this frame. `null` for silence.
   *
   * One call from the frame loop with whatever the heat ladder currently has in
   * the world, which is `raveUpdate`'s arrangement exactly: there is one place
   * that decides what is audible and no state anywhere else.
   *
   * `sirenDistance` is the metres to the nearest patrol car with its lights on,
   * or `Infinity` for none. `rotor` is 0..1, Polair's beam level -- not a
   * distance, because the helicopter is *overhead* by construction and the thing
   * that varies is whether it is there at all. The distinction is why these are
   * two numbers in one call rather than two calls: they are the same chain, they
   * fade together when the pursuit ends, and a player at 5 stars hears both.
   */
  heatUpdate(mix: HeatMix | null): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    const sirenWanted = mix !== null && mix.sirenDistance < SIREN_RANGE;
    const rotorWanted = mix !== null && mix.rotor > 0.01;
    if (!sirenWanted && !rotorWanted) {
      this.heatSilence();
      return;
    }

    const chain = this.heat ?? this.heatBuild(ctx, master);
    if (!chain) return;
    this.heat = chain;
    const t = ctx.currentTime;

    // --- The siren's distance model. `bark`'s falloff rather than an impact's,
    // and for `bark`'s stated reason: a siren tells you something is *about to*
    // happen, and a warning you cannot hear until it is too late to act on is
    // not a warning. Cut to nothing at the range rather than tapering forever,
    // so a car three suburbs away is not a node running for the session.
    const d = sirenWanted ? Math.max(0, mix.sirenDistance) : SIREN_RANGE;
    const sirenGain = sirenWanted ? SIREN_GAIN / (1 + d / SIREN_HALF_DISTANCE) : 0;
    chain.sirenOut.gain.setTargetAtTime(sirenGain, t, 0.12);
    // The wail widens as it closes, which is the Doppler-adjacent cue that
    // actually reads: near, the sweep is the whole octave; far, it is a warble.
    const sweep = SIREN_SWEEP_HZ * (sirenWanted ? Math.max(0.35, 1 - d / SIREN_RANGE) : 0.35);
    chain.sirenSweep.gain.setTargetAtTime(sweep, t, 0.2);

    // --- The rotor. A level **and** a distance now; see `HeatMix.rotorDistance`
    // for the paragraph that used to argue there was no distance to have.
    const rotor = rotorWanted ? mix.rotor : 0;
    // The three optional members, defaulted to what the positionless version did:
    // the reference range (so the gain is unchanged), no closing rate (so no
    // pitch shift) and the old free-running pan clock. A caller that has not been
    // updated therefore sounds exactly as it did, which is what makes this
    // interface safe to widen in a batch five agents are editing at once.
    const slant = mix?.rotorDistance ?? ROTOR_REFERENCE_M;
    const closing = mix?.rotorClosing ?? 0;
    const ratio = ROTOR_REFERENCE_M / Math.max(40, slant);
    // Inverse square about the reference, clamped. See `ROTOR_REFERENCE_M`.
    const near = Math.min(ROTOR_GAIN_CEILING, ratio * ratio);
    chain.rotorOut.gain.setTargetAtTime(ROTOR_GAIN * rotor * near, t, 0.25);

    // The Doppler, on the blade chop and the airframe thump together -- they are
    // one machine and shifting only one of them would separate the thump you feel
    // from the chop you hear. `setTargetAtTime` rather than `value` because at 60
    // fps a stepped frequency on a running oscillator is a zipper, which is the
    // same lesson `raveUpdate` learned about its lowpass corner.
    const shift = Math.min(
      ROTOR_PITCH_MAX,
      Math.max(ROTOR_PITCH_MIN, 1 + (ROTOR_DOPPLER * closing) / 343),
    );
    chain.rotorBlade.frequency.setTargetAtTime(ROTOR_BLADE_HZ * shift, t, 0.15);
    chain.rotorThump.frequency.setTargetAtTime(ROTOR_THUMP_HZ * shift, t, 0.15);

    // The pan crosses the head **with the orbit** rather than on a clock of its
    // own, so the sound goes past your left ear when the machine goes past your
    // left shoulder. Still a triangle over the phase, on
    // `game/streetlife.triangle`'s argument: a sine spends most of its time at the
    // ends of the stroke and a helicopter does not.
    if (chain.rotorPan) {
      const f = mix?.rotorOrbit ?? ((t * ROTOR_ORBIT_HZ) % 1);
      const u = f - Math.floor(f);
      chain.rotorPan.pan.setTargetAtTime(u < 0.5 ? u * 4 - 1 : 3 - u * 4, t, 0.3);
    }
  }

  /**
   * The **report** of a rifle fired from a helicopter a quarter of a kilometre
   * away, arriving three quarters of a second after the muzzle flash.
   *
   * A separate method from `gunshot` rather than a parameter on it, and the split
   * is about what the two sounds *are*. `gunshot` is a pistol at conversational
   * range: a 1.5 ms crack with no bottom to it, a short muzzle blast, and 260 ms
   * of street. This is the same event heard from 250 m through a quarter of a
   * kilometre of air, which does three things to it that no distance parameter on
   * the other curve would:
   *
   *   - **the crack loses its top.** Air absorbs high frequencies with distance
   *     -- that is why thunder near you snaps and thunder far away rumbles -- so
   *     the highpass comes down from 1400 Hz to 600 and a lowpass goes over it at
   *     3 kHz. What is left is a flat *whump* rather than a snap;
   *   - **the tail becomes the sound.** At 250 m across a city the direct path is
   *     a fraction of what reaches you; the rest is a second of slapback off
   *     everything between. So the tail is 0.9 s at a third of the level rather
   *     than 0.26 s at a tenth;
   *   - **it has no muzzle blast at all**, because a 60 Hz thump does not survive
   *     the trip and putting one in made it sound like a door closing.
   *
   * The **caller owns the delay.** `world/highway-patrol.Polair` counts down
   * `slant / POLAIR_SOUND_SPEED` and then calls this, because the delay is a fact
   * about where the helicopter is and this file has no idea where anything is --
   * which is the same division of labour `heatUpdate` has with the siren.
   */
  polairReport(distance = 250): void {
    const ctx = this.ctx;
    const master = this.master;
    const noise = this.noise;
    if (!ctx || !master || !noise) return;
    const t = ctx.currentTime;
    // A gentler curve even than `gunshot`'s, because a rifle in the open at 250 m
    // is genuinely loud and the whole point of the sound is that you hear it after
    // the round has already landed near you.
    const gain = 1 / (1 + Math.max(0, distance) / 240);
    if (gain < 0.02) return;

    // --- The body of the report: a band of noise with its top taken off.
    const crack = ctx.createBufferSource();
    crack.buffer = noise;
    crack.playbackRate.value = 1.1;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 600;
    hp.Q.value = 0.6;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3000;
    lp.Q.value = 0.5;
    const crackGain = ctx.createGain();
    // A 6 ms attack rather than 1.5: the wavefront has been smeared by the trip,
    // and the version with the pistol's attack read as somebody firing next to you.
    crackGain.gain.setValueAtTime(0.0001, t);
    crackGain.gain.exponentialRampToValueAtTime(0.55 * gain, t + 0.006);
    crackGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    crack.connect(hp).connect(lp).connect(crackGain).connect(master);
    crack.start(t);
    crack.stop(t + 0.14);

    // --- And the city answering, which at this range is most of what you hear.
    const tail = ctx.createBufferSource();
    tail.buffer = noise;
    tail.playbackRate.value = 0.55;
    const roll = ctx.createBiquadFilter();
    roll.type = 'lowpass';
    roll.Q.value = 0.5;
    roll.frequency.setValueAtTime(1600, t);
    roll.frequency.exponentialRampToValueAtTime(240, t + 0.85);
    const tailGain = ctx.createGain();
    tailGain.gain.setValueAtTime(0.0001, t);
    tailGain.gain.exponentialRampToValueAtTime(0.3 * gain, t + 0.04);
    tailGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
    tail.connect(roll).connect(tailGain).connect(master);
    tail.start(t);
    tail.stop(t + 0.95);
  }

  /** Fade out, stop the elements and drop the graph. Idempotent. */
  private heatSilence(): void {
    const chain = this.heat;
    if (!chain) return;
    this.heat = null;
    const ctx = this.ctx;
    if (ctx) {
      // A ramp rather than a disconnect. `raveSilence`' rule: a loop cut dead is
      // a click, and 200 ms is under the time it takes to walk out of range.
      chain.sirenOut.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.07);
      chain.rotorOut.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.07);
    }
    // Stopped and disconnected on a timer, so the fade above is heard. The
    // oscillators are single-use nodes and the chain is rebuilt from scratch the
    // next time anything is wanted, which is how the Web Audio API is meant to
    // be used and costs nothing at one pursuit a minute.
    setTimeout(() => {
      try {
        for (const node of chain.sources) node.stop();
      } catch {
        // Already stopped by a context teardown. Nothing to do.
      }
      try {
        chain.sirenOut.disconnect();
        chain.rotorOut.disconnect();
        chain.rotorPan?.disconnect();
      } catch {
        // Likewise.
      }
    }, 500);
  }

  /**
   * Build the siren and the rotor. Both at once, because they share a lifecycle.
   *
   * **The siren** is the Australian wail: a triangle carrier swept up and down
   * about 0.4 times a second by a second, much slower triangle. Two oscillators
   * an octave apart rather than one, because a single tone reads as a test tone
   * and the octave is what gives it the hard electronic edge a modern box has.
   * Through a bandpass at the carrier's own centre, which takes the corners off
   * the triangle without making it a sine.
   *
   * **The rotor** is the blade-passing chop: white noise through a low-pass at
   * 400 Hz -- which is what a rotor's broadband hiss is, once the air has taken
   * everything above it -- multiplied by a fast triangle at 13 Hz, which is four
   * blades at about 200 rpm. Under it, a 27 Hz sine for the thump you feel
   * rather than hear, at a level that does nothing on a laptop speaker and is
   * the whole effect on anything with a woofer.
   */
  private heatBuild(ctx: AudioContext, master: GainNode): HeatChain | null {
    const noise = this.noise;
    if (!noise) return null;
    const sources: AudioScheduledSourceNode[] = [];

    // --- The siren.
    const sirenOut = ctx.createGain();
    sirenOut.gain.value = 0.0001;
    const sirenBand = ctx.createBiquadFilter();
    sirenBand.type = 'bandpass';
    sirenBand.frequency.value = SIREN_CENTRE_HZ;
    sirenBand.Q.value = 1.1;
    sirenBand.connect(sirenOut).connect(master);

    const carrier = ctx.createOscillator();
    carrier.type = 'triangle';
    carrier.frequency.value = SIREN_CENTRE_HZ;
    const carrierGain = ctx.createGain();
    carrierGain.gain.value = 0.7;
    carrier.connect(carrierGain).connect(sirenBand);

    const octave = ctx.createOscillator();
    octave.type = 'square';
    octave.frequency.value = SIREN_CENTRE_HZ * 2;
    const octaveGain = ctx.createGain();
    octaveGain.gain.value = 0.12;
    octave.connect(octaveGain).connect(sirenBand);

    // The wail itself: one slow triangle driving both carriers' frequency
    // through a gain that is the sweep depth in hertz. Modulating the
    // *frequency* rather than retriggering an envelope is what makes it a
    // continuous wail rather than a sequence of chirps.
    const wail = ctx.createOscillator();
    wail.type = 'triangle';
    wail.frequency.value = SIREN_WAIL_HZ;
    const sirenSweep = ctx.createGain();
    sirenSweep.gain.value = SIREN_SWEEP_HZ;
    wail.connect(sirenSweep);
    sirenSweep.connect(carrier.frequency);
    // Half again into the octave, so the two do not sweep in lockstep and the
    // pair beats slightly -- which is most of what makes a real box sound busy.
    const sweepUp = ctx.createGain();
    sweepUp.gain.value = 1.9;
    sirenSweep.connect(sweepUp).connect(octave.frequency);

    // --- The rotor.
    const rotorOut = ctx.createGain();
    rotorOut.gain.value = 0.0001;
    let rotorPan: StereoPannerNode | null = null;
    try {
      rotorPan = ctx.createStereoPanner();
      rotorOut.connect(rotorPan).connect(master);
    } catch {
      // No panner on this engine. The rotor is mono and still overhead; the
      // orbit is a nicety and its absence is not worth a branch anywhere else.
      rotorPan = null;
      rotorOut.connect(master);
    }

    const hiss = ctx.createBufferSource();
    hiss.buffer = noise;
    hiss.loop = true;
    const air = ctx.createBiquadFilter();
    air.type = 'lowpass';
    air.frequency.value = ROTOR_AIR_HZ;
    const chop = ctx.createGain();
    // The chop's *depth*: the noise is multiplied by (0.35 + blade), so the
    // hiss never goes fully silent between blades. A rotor that did would read
    // as a stutter rather than as a thump.
    chop.gain.value = 0.35;
    hiss.connect(air).connect(chop).connect(rotorOut);

    const blade = ctx.createOscillator();
    blade.type = 'triangle';
    blade.frequency.value = ROTOR_BLADE_HZ;
    const bladeDepth = ctx.createGain();
    bladeDepth.gain.value = 0.55;
    blade.connect(bladeDepth).connect(chop.gain);

    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.value = ROTOR_THUMP_HZ;
    const thumpGain = ctx.createGain();
    thumpGain.gain.value = 0.22;
    thump.connect(thumpGain).connect(rotorOut);

    const now = ctx.currentTime;
    for (const node of [carrier, octave, wail, hiss, blade, thump]) {
      node.start(now);
      sources.push(node);
    }
    return { sirenOut, sirenSweep, rotorOut, rotorPan, rotorBlade: blade, rotorThump: thump, sources };
  }

  raveUpdate(mix: RaveMix | null): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    if (mix === null || !mix.playing || mix.distance > RAVE_AUDIBLE_RANGE) {
      this.raveSilence();
      return;
    }

    if (this.raveKey !== mix.key) {
      // A different rave, or the same one on a different night. Everything about
      // the chain -- the reverb, the decks, the beat anchor -- belongs to one
      // venue, so it is rebuilt rather than reconfigured.
      this.raveSilence();
      this.raveKey = mix.key;
    }

    const chain = this.rave ?? this.raveBuild(ctx, master, mix.reverb);
    if (!chain) return;
    this.rave = chain;

    const t = ctx.currentTime;

    // --- The distance model. One gain and one corner frequency, both ramped
    // rather than set: at 60 fps a stepped `frequency.value` on a biquad is a
    // zipper, and it is audible on a sustained pad in a way it never is on a
    // one-shot.
    const d = Math.max(0, mix.distance);
    const gain = RAVE_GAIN / (1 + d / RAVE_HALF_DISTANCE);
    const near = Math.max(RAVE_CUTOFF_AT, d) / RAVE_CUTOFF_AT;
    // `near * near` and it was `near * Math.sqrt(near)`: the corner frequency
    // now falls as the square of the distance rather than as its 1.5 power.
    //
    // The exponent is where the range cut is paid for spectrally. `near` is
    // measured in `RAVE_CUTOFF_AT` units, which did *not* shrink, so at the
    // venue this expression is unchanged -- inside 25 m `near` is 1 and 1 to
    // any power is 1. Outside it, the steeper exponent compresses the whole
    // "thump, then music, then the track" progression into the new 175 m
    // instead of leaving it stretched over a range that no longer exists.
    // Squaring is also cheaper than the square root it replaces, which is the
    // only free thing in this change.
    const cutoff = Math.min(20000, Math.max(120, RAVE_CUTOFF_MAX / (near * near)));
    chain.out.gain.setTargetAtTime(gain, t, 0.08);
    chain.lowpass.frequency.setTargetAtTime(cutoff, t, 0.08);
    if (chain.wet) {
      // More of the room and less of the source as you back away, which is what
      // reverberation *is* and which under a viaduct is most of the sound. The
      // 233 was 700 and is the third distance constant this change divides by
      // three: leaving it would have meant the wet mix never reached its
      // ceiling inside the range, so a bridge rave would have lost the concrete
      // it is made of at exactly the distance you first hear it.
      chain.wet.gain.setTargetAtTime(Math.min(0.55, 0.22 + d / 233), t, 0.2);
    }

    const url = mix.url;
    if (url === null) {
      this.raveSynth(ctx, chain, mix);
      return;
    }
    this.raveDecks(ctx, chain, mix, url);
  }

  /** Fade out, stop the elements and drop the graph. Idempotent. */
  private raveSilence(): void {
    const chain = this.rave;
    this.raveKey = -1;
    if (!chain) return;
    this.rave = null;
    const ctx = this.ctx;
    if (ctx) {
      // A ramp rather than a disconnect: a mix cut dead mid-bar is a click, and
      // 180 ms is under the time it takes to walk out of range.
      chain.out.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.06);
    }
    for (const deck of chain.decks) {
      deck.element.pause();
      // The `src` is cleared so the browser stops streaming a file nobody is
      // listening to. Without this a player who walks away from a rave keeps
      // downloading it for the rest of the session.
      deck.element.removeAttribute('src');
      deck.element.load();
      deck.url = null;
    }
    // Disconnected on a timer rather than now, so the fade above is heard.
    setTimeout(() => {
      try {
        chain.out.disconnect();
        chain.lowpass.disconnect();
        chain.dry?.disconnect();
        chain.wet?.disconnect();
        chain.convolver?.disconnect();
        for (const deck of chain.decks) deck.gain.disconnect();
      } catch {
        // A node already disconnected by a context teardown. Nothing to do.
      }
    }, 400);
  }

  /**
   * Build the graph for one venue.
   *
   * `reverb` is the site being under a viaduct, and it is the one place the
   * *kind* of place changes the sound rather than the level. A concrete soffit
   * over a hard apron is a 1.9 second decay with no early absorption at all, and
   * it is the single most recognisable thing about standing under a bridge —
   * more than the light, more than the echo of your own footsteps. It costs one
   * `ConvolverNode` and an impulse response generated from the noise buffer this
   * file already has.
   */
  private raveBuild(ctx: AudioContext, master: GainNode, reverb: boolean): RaveChain | null {
    if (typeof Audio === 'undefined') return null;
    const out = ctx.createGain();
    out.gain.value = 0.0001;
    out.connect(master);

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    // 0.707 is Butterworth: maximally flat, no resonant peak. A default Q of 1
    // puts a 1.2 dB bump on the corner, and a corner that is sweeping from
    // 280 Hz to 18 kHz as you walk would sweep that bump with it -- a filter
    // sound rather than a distance.
    lowpass.Q.value = 0.707;
    lowpass.frequency.value = 300;

    let dry: GainNode | null = null;
    let wet: GainNode | null = null;
    let convolver: ConvolverNode | null = null;
    if (reverb) {
      convolver = ctx.createConvolver();
      convolver.buffer = this.raveImpulse(ctx);
      dry = ctx.createGain();
      dry.gain.value = 0.72;
      wet = ctx.createGain();
      wet.gain.value = 0.3;
      lowpass.connect(dry).connect(out);
      lowpass.connect(convolver).connect(wet).connect(out);
    } else {
      lowpass.connect(out);
    }

    const decks: RaveDeck[] = [];
    for (let i = 0; i < 2; i++) {
      const element = new Audio();
      // Same origin, but stated: without it a browser marks the element
      // cross-origin-tainted and `createMediaElementSource` yields silence with
      // no error anywhere, which is the single most confusing failure this whole
      // path has.
      element.crossOrigin = 'anonymous';
      element.preload = 'auto';
      element.loop = true;
      const source = ctx.createMediaElementSource(element);
      const gain = ctx.createGain();
      gain.gain.value = i === 0 ? 1 : 0;
      source.connect(gain).connect(lowpass);
      decks.push({ element, source, gain, url: null });
    }

    return { out, lowpass, dry, wet, convolver, decks, live: 0 };
  }

  /**
   * The concrete under a bridge: 1.9 s of exponentially decaying noise.
   *
   * Generated rather than downloaded, for this file's founding reason — an
   * impulse response is a `.wav` whose length and character were decided
   * somewhere else. A real hall's IR has structure in the first 80 ms (the
   * discrete early reflections off the near walls) and noise after that; under a
   * road deck there are no near walls, only the soffit and the ground, so it is
   * almost pure late field with two early slaps in it. That is four lines of
   * arithmetic and it is *more* right than a cathedral IR would be.
   */
  private raveImpulse(ctx: AudioContext): AudioBuffer {
    const seconds = 1.9;
    const frames = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(2, frames, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < frames; i++) {
        const t = i / frames;
        // A power law rather than an exponential: concrete's decay is close to
        // linear in dB, and `(1-t)^2.6` at this length lands on an RT60 of about
        // 1.4 s, which is what a two-lane road deck over a hardstand measures.
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.6);
      }
      // The soffit and the ground: two discrete slaps, decorrelated between the
      // channels so the room has a width. Without these the tail is a wash and
      // reads as a plate rather than as a bridge.
      const slap = Math.floor(ctx.sampleRate * (c === 0 ? 0.021 : 0.026));
      const slap2 = Math.floor(ctx.sampleRate * (c === 0 ? 0.048 : 0.043));
      if (slap < frames) data[slap] += 0.55;
      if (slap2 < frames) data[slap2] += 0.32;
    }
    return buffer;
  }

  /**
   * Put the right record on, at the right second, and mix into the next one.
   *
   * The offset is `game/rave.setPosition`'s and is a pure function of the wall
   * clock, so a player arriving forty minutes into a set lands in the same bar as
   * everybody already standing there. That is the claim the whole feature is
   * built on and this is the one line that makes it true:
   *
   *     element.currentTime = mix.offset
   *
   * It is re-asserted whenever the element has drifted more than
   * `RAVE_RESYNC_SECONDS`, which happens after a backgrounded tab (a paused
   * media element does not advance) and after a seek the browser rounded to a
   * frame boundary. Below that threshold it is left alone: nudging
   * `currentTime` every frame would be a stutter, and 350 ms of drift is
   * inaudible against a five-minute record.
   */
  private raveDecks(ctx: AudioContext, chain: RaveChain, mix: RaveMix, url: string): void {
    const t = ctx.currentTime;
    const live = chain.decks[chain.live];
    const idle = chain.decks[1 - chain.live];

    if (live.url !== url) {
      // Either the first record of the session, or the idle deck has already
      // loaded this one and the mix is due. Prefer the swap: it is instant and
      // does not re-fetch.
      if (idle.url === url) {
        chain.live = 1 - chain.live;
        idle.gain.gain.setTargetAtTime(1, t, RAVE_MIX_SECONDS / 3);
        live.gain.gain.setTargetAtTime(0, t, RAVE_MIX_SECONDS / 3);
        // The record that just came off is stopped, not left running silently:
        // a paused element stops streaming.
        setTimeout(() => {
          if (chain.decks[chain.live] !== live) live.element.pause();
        }, RAVE_MIX_SECONDS * 1000);
        this.raveSeek(idle, mix.offset, true);
        return;
      }
      this.raveLoad(live, url, mix.offset);
      live.gain.gain.setValueAtTime(1, t);
      idle.gain.gain.setValueAtTime(0, t);
      return;
    }

    this.raveSeek(live, mix.offset, false);
    if (live.element.paused) void live.element.play().catch(() => undefined);

    // The prefetch: load the next record onto the idle deck a little before the
    // mix, and only then. Twenty seconds is comfortably more than a 6 MB file
    // needs on any connection that can already stream the one that is playing,
    // and it is short enough that a player who walks away in the meantime never
    // pays for it.
    if (mix.nextUrl && mix.remaining < RAVE_PREFETCH_SECONDS && idle.url !== mix.nextUrl) {
      this.raveLoad(idle, mix.nextUrl, 0);
      idle.element.pause();
    }
  }

  private raveLoad(deck: RaveDeck, url: string, offset: number): void {
    deck.url = url;
    deck.element.src = url;
    // `loadedmetadata` rather than `canplay`: the duration is known at metadata
    // and a seek before that is silently discarded, which presents as every
    // record starting from the top -- the exact bug that would break the one
    // property this feature is about.
    const seek = (): void => {
      deck.element.removeEventListener('loadedmetadata', seek);
      this.raveSeek(deck, offset, true);
      void deck.element.play().catch(() => undefined);
    };
    deck.element.addEventListener('loadedmetadata', seek);
    deck.element.load();
  }

  private raveSeek(deck: RaveDeck, offset: number, force: boolean): void {
    const duration = deck.element.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    // The set position may exceed the real duration when the manifest carried no
    // `seconds` and the slot fallback is running; `game/rave.ts` says so in as
    // many words and this is the modulo it relies on.
    const want = offset % duration;
    if (force || Math.abs(deck.element.currentTime - want) > RAVE_RESYNC_SECONDS) {
      deck.element.currentTime = want;
    }
  }

  /**
   * The set, with an empty record bag: a four-on-the-floor built out of
   * oscillators and the noise buffer, on the shared beat.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS IS NOT A FALLBACK.
   *
   * It is the version of this feature a fresh clone of the repository boots
   * with, and the brief was explicit that the whole thing must be *complete and
   * beautiful* with zero tracks. So it is not four bars of a click track. It is
   * a kick, a sub, a clap, two hats and a bassline, with an eight-bar structure
   * that drops out and comes back, and it is scheduled from
   * `game/rave.beatAt` — which means **every player at that rave is on the same
   * bar of the same pattern**, the crowd is dancing in time with it, and the
   * low-pass approach works exactly as it does with a record on.
   *
   * A 0.3 s lookahead is the standard WebAudio scheduler shape and is what keeps
   * it sample-accurate on a 60 Hz frame loop: notes are placed at absolute
   * `ctx.currentTime` values, so a dropped frame moves nothing. The anchor
   * mapping beat index to context time is re-taken whenever it has drifted more
   * than a beat, which is what a backgrounded tab does to `currentTime`.
   */
  private raveSynth(ctx: AudioContext, chain: RaveChain, mix: RaveMix): void {
    const spb = 60 / mix.bpm;
    const now = ctx.currentTime;
    // Re-anchor on the first pass and whenever the wall clock and the audio
    // clock have parted by more than a beat.
    const predicted = this.raveAnchor + (mix.beat - this.raveBeat) * spb;
    if (this.raveAnchor === 0 || Math.abs(predicted - now) > spb) {
      this.raveBeat = Math.ceil(mix.beat);
      this.raveAnchor = now + (this.raveBeat - mix.beat) * spb;
    }

    const horizon = now + RAVE_LOOKAHEAD;
    let guard = 0;
    while (this.raveAnchor < horizon && guard++ < 32) {
      this.raveNote(ctx, chain, this.raveBeat, this.raveAnchor, spb);
      this.raveBeat += 0.5;
      this.raveAnchor += spb * 0.5;
    }
  }

  /** One half-beat of the pattern, at an absolute context time. */
  private raveNote(ctx: AudioContext, chain: RaveChain, beat: number, at: number, spb: number): void {
    const noise = this.noise;
    if (!noise) return;
    const bar = Math.floor(beat / 4);
    const inBar = beat - bar * 4;
    const onBeat = Number.isInteger(inBar);
    // The structure: fifteen bars on, one bar with no kick under it. That single
    // absence is what makes the sixteenth bar read as a break and the first bar
    // of the next sixteen read as a drop, and it is one modulo.
    const dropped = bar % 16 === 15;

    const bus = chain.lowpass;

    // --- The kick. A sine falling 132 -> 46 Hz in 90 ms, which is the whole of
    // what a kick drum is: the click is the *attack*, not a separate layer.
    if (onBeat && !dropped) {
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(132, at);
      osc.frequency.exponentialRampToValueAtTime(46, at + 0.09);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.95, at + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.24);
      osc.connect(g).connect(bus);
      osc.start(at);
      osc.stop(at + 0.3);
    }

    // --- The sub, on the one and the three. This is the part that carries a
    // kilometre and is the thing you hear first from a street away.
    if (onBeat && (inBar === 0 || inBar === 2)) {
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(dropped ? 41 : 48.999, at);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.42, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + spb * 0.8);
      osc.connect(g).connect(bus);
      osc.start(at);
      osc.stop(at + spb);
    }

    // --- The clap, on two and four. Three noise bursts 11 ms apart, which is
    // what makes a clap a room full of hands rather than one pair.
    if (onBeat && (inBar === 1 || inBar === 3)) {
      for (let k = 0; k < 3; k++) {
        const src = ctx.createBufferSource();
        src.buffer = noise;
        src.playbackRate.value = 1.6;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1750;
        bp.Q.value = 1.1;
        const g = ctx.createGain();
        const t0 = at + k * 0.011;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(k === 2 ? 0.34 : 0.16, t0 + 0.002);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + (k === 2 ? 0.14 : 0.03));
        src.connect(bp).connect(g).connect(bus);
        src.start(t0);
        src.stop(t0 + 0.2);
      }
    }

    // --- The hats, on the off-beats, with every fourth one left open. An
    // entirely closed hat pattern is a metronome.
    if (!onBeat) {
      const open = bar % 2 === 1 && inBar > 3;
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.playbackRate.value = 2.6;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 7200;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(open ? 0.14 : 0.085, at + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, at + (open ? 0.22 : 0.035));
      src.connect(hp).connect(g).connect(bus);
      src.start(at);
      src.stop(at + 0.3);
    }

    // --- The bassline. A sawtooth through a resonant lowpass, one note per half
    // beat, stepping round a fixed eight-note figure in A minor. Fixed rather
    // than hashed because a bassline that changes every bar is not a bassline;
    // what makes this read as *a track* rather than as a drum machine is that
    // the same eight notes come round again.
    if (!dropped) {
      const step = ((beat * 2) | 0) % 8;
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(BASS_FIGURE[step], at);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 7;
      // The filter envelope, which is the entire character of the sound: open to
      // 1.4 kHz in 20 ms and close again over the note. This is an acid line
      // with the resonance turned most of the way down, which is what fits under
      // a kick without fighting it.
      lp.frequency.setValueAtTime(320, at);
      lp.frequency.exponentialRampToValueAtTime(1400, at + 0.02);
      lp.frequency.exponentialRampToValueAtTime(300, at + spb * 0.45);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.2, at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, at + spb * 0.42);
      osc.connect(lp).connect(g).connect(bus);
      osc.start(at);
      osc.stop(at + spb * 0.5);
    }
  }

  // --- The train PA ---------------------------------------------------------------
  //
  // `game/rail-audio.ts` decides *what* is being announced and from how far
  // away; this decides what that is made of. The split is `world/rave.ts`'s and
  // for the same reason -- that file computes a `RaveMix` and has never heard of
  // a convolver -- with the consequence that the whole schedule can be
  // re-derived on the Bun server by a process with no `AudioContext` in it.
  //
  // -------------------------------------------------------------------------
  // 1. A DECODED BUFFER, WHERE THE RAVE STREAMS.
  //
  // The rave's own comment says why it streams: 344 seconds of 48 kHz stereo is
  // 132 MB decoded, four times over. An announcement is 27 or 65 seconds and
  // **mono** -- see the folder's README, and see the loudness pass that made it
  // so -- which is 12.5 MB decoded for the pair and buys the one thing a
  // `MediaElementAudioSourceNode` cannot give: `start(when, offset)` is
  // sample-accurate, so a player who walks onto a platform 31.4 seconds into a
  // sentence hears the syllable that is 31.4 seconds in. Seeking a media element
  // to that is a `currentTime` write, a rebuffer and an audible gap.
  //
  // That accuracy is the feature. It is what makes two players in one carriage
  // hear one voice rather than two out-of-phase copies of it, and it is free
  // because the schedule is closed form.
  //
  // -------------------------------------------------------------------------
  // 2. TWO CHANNELS, EACH source -> gate -> lowpass -> out -> master.
  //
  // `out` carries the distance, `lowpass` carries the shell, and `gate` exists
  // only so a source can be replaced without a click: a buffer entered at 31.4
  // seconds starts on whatever sample is there, and a buffer cut mid-word ends
  // on one, so both ends get a 15 ms ramp. That is short enough not to be a fade
  // -- `bark`'s comment is right that an envelope over a recording is what makes
  // a voice line sound like a game asset -- and long enough that the
  // discontinuity is gone.
  //
  // The gate is per *source* rather than per channel, which is the only reason
  // pre-emption sounds like a PA interrupting itself rather than like a bug: the
  // outgoing sentence rings out over 40 ms while the incoming one is already
  // playing through the same filter.
  //
  // -------------------------------------------------------------------------
  // 3. THE LEVEL, AND WHY THERE ARE TWO NUMBERS RATHER THAN ONE.
  //
  // Inside the carriage there is nothing between the speaker and the ear, so a
  // rider gets `ANNOUNCE_GAIN` flat and the filter wide open. Outside there is a
  // steel box, so the level is cut by `ANNOUNCE_SHELL` **and** the top end comes
  // off with distance. Distance alone would have given a player standing three
  // metres from an open door the same thing the driver hears, which is wrong in
  // a way that is hard to place: it sounds like the announcement is being made
  // at you rather than in the train.
  //
  //      metres   gain    corner     what it is
  //     inside    0.62    20 kHz     the carriage you are standing in
  //          3    0.30    5.2 kHz    beside the doors, unmistakably from inside
  //         12    0.22    5.2 kHz    across the platform, every word
  //         25    0.16    2.5 kHz    the far platform, still every word
  //         50    0.11    1.2 kHz    a voice with the shape of words in it
  //        110    0.06    567 Hz     the gate. Gone.
  //
  // The corner is held flat inside 12 m -- the far edge of a platform -- for
  // `RAVE_CUTOFF_AT`'s reason: what should change as you back away is the
  // distance, not what the thing sounds like, so everywhere a passenger
  // actually stands gets one timbre.
  //
  // **Outside it the corner falls with the first power of the distance, and
  // `raveUpdate` uses the square.** That difference is deliberate and is worth
  // the two lines. The rave squared its exponent when its range was cut to a
  // third, precisely to keep the whole "thump, then music, then the track"
  // progression inside the shorter range. This range is short to begin with, so
  // squaring here does the opposite of that: it reaches the 520 Hz floor at
  // 44 m and leaves the outer 60 % of the range at one uniform mumble. Linear
  // spreads the progression over the whole 110 m and never touches the floor,
  // which is left in as a clamp rather than as a destination -- below about
  // 500 Hz speech stops being speech and becomes a hum, and a hum fading out is
  // worse than a muffled voice fading out.
  //
  // Against the limiter, on `raveUpdate`'s arithmetic: the clips are normalised
  // to about -14 LUFS with a measured -0.37 dBTP, so 0.958 linear, and
  // `master` is 0.55. The loudest an announcement can be is inside a carriage at
  // 0.55 * 0.62 * 0.958 = **0.327** against the compressor's -8 dB threshold of
  // 0.398. It never touches it on its own, which is what that limiter is for.

  /** The two channels, built on the first announcement and then kept. */
  private announce: AnnounceChannel[] | null = null;

  /**
   * Drive the train PA for this frame, or pass `null` for silence.
   *
   * Called unconditionally from the frame loop with whatever
   * `rail-audio.railAnnounceMix` found, so there is exactly one place that
   * decides what is audible and no audio state anywhere else. Returns nothing
   * and throws nothing.
   */
  railAnnounce(mix: RailAnnounceMix | null): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    if (mix === null) {
      this.announceRelease(ctx, 0);
      this.announceRelease(ctx, 1);
      return;
    }
    // The prefetch, and the whole of the policy: nothing is fetched until a
    // train that is actually announcing is within `ANNOUNCE_FETCH_RANGE`, so a
    // player who never goes near a railway never downloads either clip.
    //
    // Read off the mix's own voices, which carry their URL whether they are
    // playing or not. That is what keeps this file's dependency on
    // `game/rail-audio.ts` a **type-only** one: nothing in the schedule module
    // is evaluated here, so the sound system still imports nothing at runtime.
    if (mix.wanted) {
      this.loadClip(mix.arrive.url);
      this.loadClip(mix.depart.url);
    }

    const chans = this.announce ?? this.announceBuild(ctx, master);
    this.announce = chans;
    this.announceVoice(ctx, 0, mix.arrive);
    this.announceVoice(ctx, 1, mix.depart);
  }

  private announceBuild(ctx: AudioContext, master: GainNode): AnnounceChannel[] {
    const chans: AnnounceChannel[] = [];
    for (let i = 0; i < 2; i++) {
      const out = ctx.createGain();
      out.gain.value = 0.0001;
      out.connect(master);
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      // Butterworth, `raveBuild`'s reason: a default Q of 1 puts a 1.2 dB bump
      // on the corner, and a corner sweeping from 520 Hz to 5 kHz as a train
      // pulls in would sweep that bump with it -- a filter sound rather than a
      // distance.
      lowpass.Q.value = 0.707;
      lowpass.frequency.value = 20000;
      lowpass.connect(out);
      chans.push({ key: 0, out, lowpass, source: null, gate: null });
    }
    return chans;
  }

  private announceVoice(ctx: AudioContext, index: number, voice: RailVoice): void {
    const chans = this.announce;
    if (!chans) return;
    const ch = chans[index];
    if (!voice.active) {
      this.announceRelease(ctx, index);
      return;
    }
    const buffer = this.clips.get(voice.url);
    if (!buffer) {
      // Not decoded yet. Deliberately not queued to start on arrival: a sentence
      // that begins four seconds after the schedule says it did would be four
      // seconds out for the rest of its minute, and every other client would be
      // right.
      this.loadClip(voice.url);
      this.announceRelease(ctx, index);
      return;
    }

    const t = ctx.currentTime;
    const d = voice.distance > 0 ? voice.distance : 0;
    const gain = voice.inside
      ? ANNOUNCE_GAIN
      : (ANNOUNCE_GAIN * ANNOUNCE_SHELL) / (1 + d / ANNOUNCE_HALF_DISTANCE);
    let cutoff = 20000;
    if (!voice.inside) {
      const near = Math.max(ANNOUNCE_CUTOFF_AT, d) / ANNOUNCE_CUTOFF_AT;
      cutoff = Math.min(20000, Math.max(ANNOUNCE_CUTOFF_MIN, ANNOUNCE_CUTOFF_MAX / near));
    }

    if (ch.key !== voice.key) {
      this.announceRelease(ctx, index);
      ch.key = voice.key;
      // Past the end of what was decoded -- a clip shorter than the schedule
      // believes, or the last frame of one. Nothing to play, and the key is
      // recorded anyway so this is not retried sixty times a second.
      if (voice.offset < buffer.duration - 0.05) {
        const gate = ctx.createGain();
        gate.gain.setValueAtTime(0.0001, t);
        gate.gain.linearRampToValueAtTime(1, t + ANNOUNCE_EDGE_S);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(gate).connect(ch.lowpass);
        source.start(t, voice.offset > 0 ? voice.offset : 0);
        ch.source = source;
        ch.gate = gate;
      }
      // Set rather than ramped, and only on the frame a sentence begins: the
      // channel may have been left at the level of a train that has since gone,
      // and a quarter-second slide up to the right one is the fade `bark`
      // refuses to put on a recording.
      ch.out.gain.cancelScheduledValues(t);
      ch.out.gain.setValueAtTime(gain, t);
      ch.lowpass.frequency.cancelScheduledValues(t);
      ch.lowpass.frequency.setValueAtTime(cutoff, t);
      return;
    }

    // And thereafter ramped, `raveUpdate`'s reason: at 60 fps a stepped
    // `frequency.value` on a biquad is a zipper, and a train pulling in moves
    // this the full width of its range in eight seconds.
    ch.out.gain.setTargetAtTime(gain, t, 0.08);
    ch.lowpass.frequency.setTargetAtTime(cutoff, t, 0.08);
  }

  /** Ring the current sentence out over 40 ms and forget it. Idempotent. */
  private announceRelease(ctx: AudioContext, index: number): void {
    const chans = this.announce;
    if (!chans) return;
    const ch = chans[index];
    ch.key = 0;
    const source = ch.source;
    const gate = ch.gate;
    ch.source = null;
    ch.gate = null;
    if (!source || !gate) return;
    const t = ctx.currentTime;
    gate.gain.cancelScheduledValues(t);
    gate.gain.setValueAtTime(gate.gain.value, t);
    gate.gain.linearRampToValueAtTime(0.0001, t + ANNOUNCE_EDGE_S);
    try {
      source.stop(t + ANNOUNCE_EDGE_S * 2);
    } catch {
      // Already stopped by an earlier release. Nothing to do.
    }
    // Disconnected on a timer rather than now, so the ramp above is heard.
    setTimeout(() => {
      try {
        gate.disconnect();
      } catch {
        // A node already disconnected by a context teardown.
      }
    }, 400);
  }

  // --- The screaming sun -------------------------------------------------------
  //
  // `game/sunbutton.ts` decides *whether* the sun is screaming and from how high
  // it is; this decides what that is made of. The split is `heatUpdate`'s and for
  // the same reason -- a module the server cannot load is a rule the server cannot
  // enforce -- with the consequence that the whole schedule can be re-derived on
  // the Bun server by a process with no `AudioContext` in it.
  //
  // Four recorded screams, played one-shot and at random. A clip is not two
  // oscillators and an envelope, so it is played rather than synthesised, on
  // `clips`' argument; the four are fetched and decoded lazily on the first frame
  // a scream is wanted, through the very `loadClip` the officers' barks use, and
  // nothing is fetched until the sun is screaming. One-shot rather than looping,
  // because a loop a player can hear is a loop a player can recognise, and four
  // clips at a random gap is a scream that does not settle into a hum.
  //
  // The gap between the end of one clip and the start of the next is drawn from
  // `game/sunbutton.screamGap`, a Beta(3, 1) over 1-10 s biased to the long end,
  // so the sun screams, rests, and screams again rather than holding a tone.

  /**
   * Drive the screaming sun for this frame, or pass `null` for silence.
   *
   * Called unconditionally from the frame loop with whatever
   * `game/sunbutton.sunScreamMix` found, so there is exactly one place that
   * decides what is audible and no state anywhere else. Returns nothing and
   * throws nothing: a browser with no audio is a sun that screams in silence.
   *
   * The level is **not distance-attenuated**: the sun is everywhere, so a scream
   * that faded with distance would be a scream that was not a scream. See
   * `SUN_SCREAM_GAIN`.
   *
   * While `mix` is non-null the first clip is scheduled at once and each
   * subsequent one after a gap drawn from `screamGap`, never the same clip twice
   * in a row. When `mix` goes `null` the schedule stops and the clip already
   * playing is left to finish -- a scream cut dead is a click, and the gap is the
   * rest, not a fade.
   */
  sunScreamUpdate(mix: { level: number } | null): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;

    if (mix === null || mix.level <= 0.01) {
      // Silence: stop scheduling. A clip already playing finishes on its own, and
      // there is no pending schedule to cancel because the schedule is per-frame.
      // The mouth closes now rather than at the clip's end -- the face is what
      // went away, so the level goes with it.
      this.sunScreamActive = false;
      this.sunScreamClipEnd = 0;
      return;
    }

    if (!this.sunScreamActive) {
      this.sunScreamActive = true;
      this.sunScreamNextAt = ctx.currentTime;
      for (const url of SUN_SCREAM_CLIPS) this.loadClip(url);
    }

    const t = ctx.currentTime;
    if (t < this.sunScreamNextAt) return;

    const idx = this.sunScreamPick();
    const buffer = this.clips.get(SUN_SCREAM_CLIPS[idx]);
    if (!buffer) {
      // Not decoded yet: start it and try again a little later. Deliberately not
      // queued to play on arrival -- a scream that lands two seconds after the
      // thing it was about is worse than a rest.
      this.loadClip(SUN_SCREAM_CLIPS[idx]);
      this.sunScreamNextAt = t + 0.1;
      return;
    }

    this.sunScreamPlay(buffer, t, mix.level);
    this.sunScreamLastClip = idx;
    this.sunScreamClipStart = t;
    this.sunScreamClipEnd = t + buffer.duration;
    // The next one starts after this clip's end plus the drawn gap.
    this.sunScreamNextAt = t + buffer.duration + screamGap(Math.random(), Math.random(), Math.random());
  }

  /**
   * How open the sun's mouth is right now, 0..1: the envelope of the clip that
   * is playing, or 0 between clips and whenever nothing is scheduled.
   *
   * Not an `AnalyserNode`. The clips are one-shot buffers whose start and length
   * this class chose, so the honest envelope is the *window*: a 60 ms attack
   * from the scheduled start, 1 while the clip runs, and a 120 ms release after
   * its end -- and 0 the instant `sunScreamUpdate(null)` was called. An analyser
   * would give a real RMS for the same shape at the cost of a tap on the graph
   * and a render-thread read every frame, for a mouth that is 30 pixels wide.
   * `world/sunbutton.drawScreamFace` reads this and opens the jaw by it, so the
   * mouth moves only while there is a scream to move it (the owner's ask).
   */
  sunScreamLevel(): number {
    const ctx = this.ctx;
    if (!ctx || this.sunScreamClipEnd <= 0) return 0;
    const t = ctx.currentTime;
    const start = this.sunScreamClipStart;
    const end = this.sunScreamClipEnd;
    if (t < start || t > end + SUN_SCREAM_RELEASE_S) return 0;
    if (t < start + SUN_SCREAM_ATTACK_S) return (t - start) / SUN_SCREAM_ATTACK_S;
    if (t > end) return 1 - (t - end) / SUN_SCREAM_RELEASE_S;
    return 1;
  }

  /** A random clip index, uniform over the four and never the one just played. */
  private sunScreamPick(): number {
    const n = SUN_SCREAM_CLIPS.length;
    let pick = Math.floor(Math.random() * n);
    while (pick === this.sunScreamLastClip) pick = Math.floor(Math.random() * n);
    return pick;
  }

  /**
   * Play one scream clip at `at`, at `SUN_SCREAM_GAIN × level`.
   *
   * A plain value rather than a ramp, on `bark`'s argument: a recording has its
   * own attack, and an envelope over the top of it would be a fade, which is the
   * one thing that makes a scream sound like a game asset. Not distance-attenuated
   * and not on a cooldown, because the sun is everywhere and the gap is the rest.
   */
  private sunScreamPlay(buffer: AudioBuffer, at: number, level: number): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = SUN_SCREAM_GAIN * level;
    source.connect(g).connect(master);
    source.start(at);
  }
}

// --- The sound system's own types and numbers ---------------------------------------

/** What `world/rave.ts` hands the mixer each frame. */
export interface RaveMix {
  /** The venue's identity. A change rebuilds the chain. */
  key: number;
  /** Metres to the booth. Drives the gain and the low-pass. */
  distance: number;
  /** The record to play, or **null** for the synthesised set. */
  url: string | null;
  /** Seconds into it, from the shared clock. See `raveDecks`. */
  offset: number;
  /** The record after it, for the prefetch, or null. */
  nextUrl: string | null;
  /** Seconds until the mix. */
  remaining: number;
  /** For the synthesised set only. */
  bpm: number;
  beat: number;
  /** Under a viaduct: a 1.9 s concrete tail. See `raveImpulse`. */
  reverb: boolean;
  /** The sound system is on. False during load-in, pack-up and a bust. */
  playing: boolean;
}

interface RaveDeck {
  element: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  gain: GainNode;
  url: string | null;
}

interface RaveChain {
  out: GainNode;
  lowpass: BiquadFilterNode;
  dry: GainNode | null;
  wet: GainNode | null;
  convolver: ConvolverNode | null;
  decks: RaveDeck[];
  /** Which deck is up. See `raveDecks`. */
  live: number;
}

/**
 * How far a rave can be heard, metres.
 *
 * Deliberately shorter than `world/rave.BEAM_RANGE`'s 900 and longer than
 * everything else, which is the order the whole approach depends on: **you see
 * it, then you hear it, then you arrive.**
 *
 * ---------------------------------------------------------------------------
 * **This was 520 and a player asked for a third of it.** *"audio from raves
 * should not travel so far. maybe one third"*.
 *
 * The old number came with an argument — "520 m is about four blocks of
 * Alexandria, which is honestly how far a rig like this carries at 2 am with
 * nothing else running" — and the argument is not wrong about *sound*. It is
 * wrong about *a game*. Four blocks of carry means that on a five-rave night in
 * a 19.3 km city, a player crossing the inner west is inside somebody's rave
 * for a large fraction of the walk, and a cue that is on most of the time is
 * not a cue. The thing being modelled is not really how far a sub carries; it
 * is how far away you should be when you start to suspect.
 *
 * 175 m is one third of it, and one third **of every distance in the model at
 * once** — see `RAVE_HALF_DISTANCE`. That is what makes this a range cut rather
 * than a volume cut: the ratio `range / half-distance` is held at 4.73, so the
 * level the gate cuts at is 0.108 of the deck's own gain, exactly what it was
 * before. Nothing pops off; the same near-inaudible level is reached three
 * times sooner.
 */
export const RAVE_AUDIBLE_RANGE = 175;

/** How close a player has to be before a single byte is fetched. See section 2. */
export const RAVE_FETCH_RANGE = RAVE_AUDIBLE_RANGE;

/**
 * The deck's gain at zero distance. See section 3 for the arithmetic that says
 * this number never reaches the limiter.
 */
const RAVE_GAIN = 0.62;

/**
 * Where the level has halved, metres.
 *
 * **37, and it was 110.** Still gentler than anything else in this file --
 * `bark`'s is 22 and `footyThrow`'s 14 -- and for the reason that has not
 * changed: an impact tells you something happened, **this tells you where to
 * walk**, and a cue you cannot hear until you are already there is not a cue.
 *
 * It moved with `RAVE_AUDIBLE_RANGE` and had to, because the two are one model.
 * Cutting the gate alone would have left the level at the gate three times
 * higher than it was -- 0.24 of the deck's gain instead of 0.11 -- and a mix
 * that is still clearly audible when it is switched off is a click every time
 * you walk out of one. Dividing both by three moves the whole curve inward
 * without changing its shape:
 *
 * ```
 *              gain at   0 m    25 m    50 m   100 m   at the gate
 *   before               0.62    0.50    0.43    0.32    0.108 (520 m)
 *   after                0.62    0.37    0.26    0.17    0.108 (175 m)
 * ```
 *
 * At the rig it is the same number it always was. Across the dance floor it is
 * about 2 to 4 dB down, which is not nothing and is the honest cost of a
 * steeper curve -- and is also what a smaller rig sounds like from the back of
 * a crowd, which is what this now is.
 */
const RAVE_HALF_DISTANCE = 37;

/**
 * Inside this the mix is fully open, metres, and the corner frequency there.
 *
 * **`RAVE_CUTOFF_AT` deliberately did not move with the two distances above**,
 * and that is the one asymmetry in this change. It is what keeps the sound
 * *at* a rave bit-identical: everything inside 25 m of the booth runs at the
 * full 18 kHz exactly as it did, so the thing the player asked to change --
 * how far the music travels -- changes, and the thing they did not ask about
 * -- what it sounds like when you are standing in it -- does not.
 *
 * What moved instead is the *exponent*, in `raveUpdate`. See it.
 */
const RAVE_CUTOFF_AT = 25;
const RAVE_CUTOFF_MAX = 18000;

/** How long a mix takes, seconds. A DJ's crossfade, not a hard cut. */
const RAVE_MIX_SECONDS = 2.4;
/** How far ahead of a mix the next record starts loading. See `raveDecks`. */
const RAVE_PREFETCH_SECONDS = 20;
/** How far a deck may drift from the shared clock before it is nudged, seconds. */
const RAVE_RESYNC_SECONDS = 0.35;
/** The synthesised set's scheduling horizon, seconds. */
const RAVE_LOOKAHEAD = 0.3;

/**
 * The bassline, in hertz: A1, A1, C2, A1, D2, A1, C2, E2.
 *
 * A minor, which is the key three quarters of all techno is in, and the figure
 * is the oldest one there is -- root, root, minor third, root, fourth, root,
 * minor third, fifth. Written as frequencies rather than as note names because
 * nothing else in this file knows what a note name is, and because an
 * oscillator takes hertz.
 */
const BASS_FIGURE: readonly number[] = [55, 55, 65.41, 55, 73.42, 55, 65.41, 82.41];

// --- The train PA's own numbers ------------------------------------------------------

/** One channel of it. See section 2 of the PA's comment. */
interface AnnounceChannel {
  /** Which announcement is on this channel, or 0 for none. `announceKey`'s. */
  key: number;
  out: GainNode;
  lowpass: BiquadFilterNode;
  source: AudioBufferSourceNode | null;
  /** The current source's own edge ramp, so it can be replaced without a click. */
  gate: GainNode | null;
}

/**
 * The announcement's gain in the carriage it is being made in.
 *
 * `RAVE_GAIN` exactly, and that is not laziness: the two are the loudest
 * sustained things in the mix and they were both checked against the same
 * limiter. Section 3 has the arithmetic -- 0.327 peak against a 0.398 threshold.
 * A rave and an announcement together would engage the compressor, which is a
 * rave beside a station, which is a thing the limiter exists for.
 */
const ANNOUNCE_GAIN = 0.62;

/**
 * What is left of it through a carriage shell, on the platform side.
 *
 * -5.2 dB. Aluminium and laminated glass would take far more than that off a
 * speaker two metres inside, and the number is deliberately generous, because a
 * train that has announced something on a platform is a thing a player should
 * hear. What it has to buy is the *difference*: standing beside the doors must
 * not sound like standing under the speaker, or the announcement reads as being
 * made at you rather than in the train.
 */
const ANNOUNCE_SHELL = 0.55;

/**
 * Where the level has halved, metres.
 *
 * 23, against `RAVE_HALF_DISTANCE`'s 37 and `bark`'s 22. Almost exactly a bark's
 * and for almost the opposite reason: a police officer's shout is gentle because
 * a warning you cannot hear is not a warning, and this is steep because there is
 * an announcement at every station every two minutes and a cue that is always on
 * is not a cue. The two arrive at the same number from opposite ends, which is a
 * coincidence worth writing down rather than one worth hiding.
 *
 * It holds `ANNOUNCE_RANGE / this` at 4.78, matching the rave model's 4.73, so
 * the level at the gate is `1 / (1 + 4.78)` = 0.173 of what the same curve gives
 * at the carriage side -- the identical near-inaudible fraction the music is cut
 * at, and the reason nothing pops off when you walk away from a platform.
 * Against the level *inside* the carriage it is 0.095, because the shell is
 * between you and it either way.
 */
const ANNOUNCE_HALF_DISTANCE = 23;

/**
 * Inside this the shell filter is flat, metres, and the corner frequency there.
 *
 * 12 m is the far edge of a platform. `RAVE_CUTOFF_AT`'s argument, one scale
 * down: what should change as you back away is the distance, not what the thing
 * sounds like, so everywhere a passenger actually waits gets the identical
 * timbre and only leaving the platform opens the filter's own progression.
 *
 * 5.2 kHz rather than 20 is the shell itself. Speech intelligibility lives
 * between 1 and 4 kHz, so a corner just above it is a tannoy heard through a
 * door -- every word, no sibilance -- which is what a train announcement on a
 * platform is. The floor is 520 Hz because below that speech stops being speech
 * and becomes a hum, and a hum fading out is worse than a muffled voice fading
 * out.
 */
const ANNOUNCE_CUTOFF_AT = 12;
const ANNOUNCE_CUTOFF_MAX = 5200;
const ANNOUNCE_CUTOFF_MIN = 520;

/**
 * The ramp on both ends of a source, seconds.
 *
 * 15 ms. A buffer entered 31.4 seconds in starts on whatever sample is there and
 * a buffer cut by a pre-emption ends on one; both are clicks. Short enough that
 * it is not a fade -- see `bark` on what an envelope does to a recording -- and
 * long enough to remove the step.
 */
const ANNOUNCE_EDGE_S = 0.015;

// --- The heat ladder's loops ---------------------------------------------------

/**
 * What the frame loop tells `heatUpdate`.
 *
 * Two numbers with deliberately different units, and the asymmetry is the
 * design rather than an oversight. A **patrol car** is somewhere -- it comes
 * down a street, it passes you, it goes away -- so it is a distance. **Polair**
 * is overhead by construction: the whole point of the fifth rung is that it is
 * above you and will not go away, so what varies is not where it is but whether
 * it is there, which is the beam level `world/highway-patrol.Polair` is already
 * ramping. Making the rotor a distance would have meant inventing a helicopter
 * position for a helicopter that does not exist.
 */
export interface HeatMix {
  /** Metres to the nearest patrol car with its lights on, or `Infinity`. */
  sirenDistance: number;
  /** Polair's beam, 0..1. `Polair.intensity`. */
  rotor: number;
  /**
   * Slant metres to the airframe, or absent.
   *
   * **This is the paragraph above being revised.** It used to say that making the
   * rotor a distance would mean inventing a helicopter position for a helicopter
   * that does not exist -- and that was true right up until `game/polair.ts` gave
   * it one. The machine now flies a 90-160 m orbit at 180-260 m of altitude, so
   * the slant range genuinely varies from about 200 m on the near side to 305 on
   * the far, and refusing to model that would be throwing away the one cue that
   * tells a player, without looking up, that it is coming back round.
   *
   * The three new members are **optional** rather than required, and that is
   * merge discipline rather than indecision: this interface is constructed in
   * exactly one place in `main.ts`, five agents are editing that file at once,
   * and a caller that has not been updated should keep sounding exactly as it did
   * -- see the defaults in `heatUpdate`.
   */
  rotorDistance?: number;
  /**
   * Metres a second the airframe is closing at, positive inbound. `Polair.closing`.
   *
   * Drives a real Doppler shift on the blade and thump frequencies. At the 40 m/s
   * an orbit reaches that is about twelve per cent, which is a semitone and is
   * comfortably audible -- and it is the difference between a helicopter and a fan.
   */
  rotorClosing?: number;
  /**
   * 0..1 round the lap. `Polair.orbitPhase`.
   *
   * Replaces the free-running triangle the pan used to wander on. Same shape, but
   * tied to the actual orbit, so the sound crosses the head when the machine
   * crosses in front of you rather than on a clock of its own.
   */
  rotorOrbit?: number;
}

/** The live siren and rotor graph. Built by `heatBuild`, dropped by `heatSilence`. */
interface HeatChain {
  sirenOut: GainNode;
  /** The wail's depth in hertz, widened as a car closes. See `heatUpdate`. */
  sirenSweep: GainNode;
  rotorOut: GainNode;
  /** Null on an engine with no `StereoPannerNode`. The orbit is a nicety. */
  rotorPan: StereoPannerNode | null;
  /**
   * The blade chop and the airframe thump, held so their frequencies can be
   * Doppler-shifted as the orbit closes and opens.
   *
   * Held on the chain rather than rebuilt, because these are the *same*
   * oscillators for the life of the pursuit and retriggering them to change a
   * pitch would be a click every frame. `setTargetAtTime` on a running
   * oscillator's frequency is what a real pitch bend is.
   */
  rotorBlade: OscillatorNode;
  rotorThump: OscillatorNode;
  /** Every node that has to be stopped on teardown. */
  sources: AudioScheduledSourceNode[];
}

/**
 * How far a siren carries, metres, and where it is half as loud.
 *
 * **Further than anything else in this file**, and further than a rave: 300 m
 * against `RAVE_AUDIBLE_RANGE`'s 175, because a siren is the only sound in this
 * build whose entire job is to be heard **before** you can see the thing making
 * it. A player at 3 stars who hears the highway patrol two blocks away has been
 * given a decision -- get off the road, get inside, get on a train -- and that
 * decision is the whole of what the rung is for. One that first hears it at
 * 60 m has been given a jump scare.
 *
 * The half-distance is `bark`'s 22 scaled to the range, so the curve has the
 * same *shape* as the officers' shouting and simply reaches further.
 */
const SIREN_RANGE = 300;
const SIREN_HALF_DISTANCE = 55;
/** Level at the car. Under a gunshot and over a bark: it is loud, not startling. */
const SIREN_GAIN = 0.30;

/**
 * The wail: where the tone sits, how far it sweeps, and how fast.
 *
 * 660 Hz with a 420 Hz sweep at 0.42 Hz is the Australian "wail" setting --
 * a slow rise and fall through most of an octave, about two and a half seconds
 * a cycle. The alternative box setting is the "yelp", which is the same sweep
 * at four times the rate; it is not used here because a yelp is what a car uses
 * *at* an intersection and a wail is what it uses coming down a road, and this
 * one is always coming down a road.
 */
const SIREN_CENTRE_HZ = 660;
const SIREN_SWEEP_HZ = 420;
const SIREN_WAIL_HZ = 0.42;

/**
 * The rotor: the air, the blades and the thump.
 *
 * 13 Hz is four blades at about 195 rpm, which is a light twin-engine police
 * helicopter and is the frequency the human ear reads as *helicopter* rather
 * than as *fan*. The air is low-passed at 400 Hz because that is what a
 * kilometre of atmosphere does to broadband noise, and 27 Hz is the airframe
 * fundamental -- inaudible on a laptop, and the whole effect on a subwoofer.
 */
const ROTOR_BLADE_HZ = 13;
const ROTOR_AIR_HZ = 400;
const ROTOR_THUMP_HZ = 27;
/** Level at full beam. Under the siren: it is a presence, not an event. */
const ROTOR_GAIN = 0.22;
/** How fast the pan wanders across the head, cycles a second. Slow: it is circling. */
const ROTOR_ORBIT_HZ = 0.055;

/**
 * The rotor's distance model: the slant range `ROTOR_GAIN` was tuned at, and the
 * clamp on how much louder it may get.
 *
 * **Inverse square about a reference range**, so 250 m sounds exactly as loud as
 * the old positionless version did and everything else is relative to it. Two
 * reasons for that shape rather than the `1/(1 + d/half)` curve the siren and the
 * rave use:
 *
 *   - the *band* is narrow. The orbit only produces 200-305 m, and a hyperbolic
 *     falloff over that span moves the level by a fifth -- barely audible, so the
 *     whole point of adding a distance would be lost. Inverse square over the same
 *     span is a factor of two and a half, which you can hear from inside a
 *     pursuit without looking up;
 *   - there is no range at which it cuts out. The siren cuts at 300 m because a
 *     car three suburbs away should not be a running node; the helicopter is
 *     *yours* and is always inside 320 m by construction, so there is nothing to
 *     cut and the clamp is only there to stop a future close pass from
 *     overdriving the master.
 */
const ROTOR_REFERENCE_M = 250;
const ROTOR_GAIN_CEILING = 2.4;
/**
 * How much of a Doppler shift the closing rate is worth.
 *
 * One, meaning the physical amount: `f * (1 + closing / c)`. It is written as a
 * constant anyway so that the two people who will inevitably want it exaggerated
 * have somewhere to do it, and clamped either side because a closing rate that
 * ever went stupid would otherwise put the blade chop into the audible-tone range
 * and turn the rotor into a siren.
 */
const ROTOR_DOPPLER = 1;
const ROTOR_PITCH_MIN = 0.82;
const ROTOR_PITCH_MAX = 1.22;

// --- The screaming sun's own numbers ----------------------------------------

/**
 * The scream's gain at full level.
 *
 * **Not distance-attenuated**: the sun is everywhere, so a scream that faded with
 * distance would be a scream that was not a scream. About 0.12 is audible over
 * street ambience and not painful, and it never touches the limiter on its own --
 * 0.55 * 0.12 = 0.066 against the compressor's -8 dB threshold of 0.398.
 */
const SUN_SCREAM_GAIN = 0.12;
/** The mouth's attack and release around a clip's window, seconds. See `sunScreamLevel`. */
const SUN_SCREAM_ATTACK_S = 0.06;
const SUN_SCREAM_RELEASE_S = 0.12;

/**
 * The four scream clips, by URL. Loaded lazily on the first frame a scream is
 * wanted, through `loadClip`, and nothing is fetched until the sun is screaming.
 */
const SUN_SCREAM_CLIPS: readonly string[] = [
  '/audio/sun/scream_1.mp3',
  '/audio/sun/scream_2.mp3',
  '/audio/sun/scream_3.mp3',
  '/audio/sun/scream_4.mp3',
];
