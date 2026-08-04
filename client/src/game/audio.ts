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
   * So this path exists for **voice only**, and it is deliberately narrow: fetch,
   * decode, cache, play at a distance gain with a cooldown. No streaming, no
   * sprite sheet, no loader class, and no way to reach it for a sound that could
   * have been arithmetic.
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
}
