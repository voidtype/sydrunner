# Review: "Why SYDNEY Stutters"

**George — engineering review of Sebastian's frame path paper**
2026-08-29 · Sent back with changes

---

## Verdict

Good instincts, real findings, and a conclusion I do not believe.

Three of the ten are excellent and I would ship them as-is. Three are padding.
One is wrong on its own arithmetic. And the cause is, I think, in none of them —
it is sitting one step past where Sebastian stopped looking, and his own finding
1 is the mechanism for it.

I am sending this back, but not far. The paper needs a shorter list, honest
magnitudes, and one experiment run **before** anybody writes a line of
instrumentation code.

---

## What is right, and I want it on the record first

**Finding 1** — `renderer.render()` as the only unbudgeted phase, and the
three existing warm-up subsystems as the evidence for it. That is a genuinely
good piece of reading. Inferring the disease from the shape of the immune
response is the right instinct and most reviewers would have missed it.

**Finding 2** — that `FrameProfile` *tiles* the callback and is therefore
structurally incapable of reporting time it did not spend. This is the sharpest
observation in the paper. It reframes every prior investigation on this codebase
as attribution rather than measurement, and it is correct.

**Finding 10** — the reporter's threshold and cooldown are both wrong for the
symptom being reported. Obvious once said, unsaid for months.

**R1's second bullet**, the stolen-time subtraction, is the single best idea in
the document. I will come back to it because it needs a caveat Sebastian did not
give it.

---

## Now the problems

### 1. Finding 4 is wrong, and its own mechanism disproves it

Sebastian proposes that a dozen periodic sweeps on independent cadences coincide
periodically, and offers that as a candidate for "every ten seconds".

I did the arithmetic he did not. The sweep periods are 250 ms, 200 ms, 100 ms,
66.7 ms, 33.3 ms and 2,000 ms. **Their least common multiple is 2 seconds.**

If sweep coincidence were the cause, the complaint would be "it stutters every
two seconds", and it is not. The mechanism he proposes predicts a period five
times faster than the one being reported. He filed it under "hypotheses ranked
by how well they explain *every ten seconds, briefly*" — it explains it badly,
and one line of arithmetic would have told him so before it reached a numbered
finding.

Staggering the sweeps is still fine hygiene. It is not a finding about this bug.
**Cut it, or re-file it as maintenance.**

### 2. The count is padded, and the recommendations give it away

- **Findings 5 and 8 are one finding.** "The only frame-slack test serves one
  consumer" and "there is no scheduler, only Hz counters" are two sentences
  about the same missing abstraction. The tell is that R2 addresses them as a
  single change. If your recommendation cannot distinguish two findings, they
  were one finding.
- **Finding 9 is not a finding.** "The netcode is fine" is a negative result. It
  is *useful* — I agree it stops a fortnight being spent in the wrong place —
  but it belongs in the preface as scope, not in a numbered list of defects.
- **Finding 7 is off-topic and self-inflicted.** A 6.4 MB main-thread JSON parse
  is real and should be fixed. But Sebastian says himself, in the finding, that
  it is a load-time stall and not the ten-second symptom. It is in the list to
  reach ten. It is also, per his own disclosure, a regression introduced the
  same day by the same organisation — which is worth saying plainly rather than
  in italics at the bottom.

Ten findings made of seven. Say seven.

### 3. Nothing in this paper is measured

This is the one that actually bothers me.

Sebastian writes that a stall costs "up to 8× normal simulation cost per frame
while it drains". He does not know what `simulate()` costs. If it is 0.4 ms,
eight steps is 3.2 ms and finding 3 is noise dressed as a defect. If it is 3 ms,
it is a 24 ms secondary stall and it is the most actionable thing in the
document. **The finding cannot be ranked without the number, and the number was
not taken.**

The same applies to the shadow pass in finding 6 and to the render section
generally.

And there is a worse version of this. He recommends **building a new instrument**
without reading the three that already exist: `frameProfile.report()`,
`sydney.warmupAudit()`, and the `[frame]` console line — which the owner has
been pasting into chat for a week, and which already prints the worst sections
and the pipeline count for stalled frames. Those logs are the cheapest data in
this building and the paper does not cite one of them.

Read the instrument you have before you cost a new one.

### 4. The confidence chips encode the wrong axis

Finding 6 is marked *Hypothesis*. But 4096², `PCFSoftShadowMap`, every frame, no
cascades — every one of those is certain; what is uncertain is whether it is the
*cause*. Finding 4 is marked the same way and is closer to disproven.

Two different questions have been collapsed into one chip: **is this claim
true**, and **does this explain the symptom**. Split them. A paper that ranks its
own confidence badly teaches its readers to ignore the ranking.

---

## What he missed, and I think it is the answer

Sebastian went looking for a ten-second **timer**, found nothing on that cadence,
and reached for a beat frequency to fill the gap.

He should have looked at the two reports again. Both of them are at constant
speed: *"been on a longer train ride"*, and driving a car in the screenshot.

**At constant speed, distance is time.** And this game streams on distance.

| | |
|---|---|
| Tile size | **500 m** (`index.json: tile_size`) |
| Car and train top speed | **44 m/s** (`DRIVE_TOP_SPEED`) |
| Load radius | **1,800 m** |
| Tiles resident | **44** |
| New tiles per boundary crossing | **8** |
| **Seconds per crossing at top speed** | **11.4** |

Eight new tiles, every eleven and a bit seconds, at speed. Each of them fetched,
decoded on a worker, built under a 2.5 ms budget — and then **drawn for the first
time**, which is Sebastian's own finding 1: the one unbudgeted phase, where a
never-before-drawn tile pays for its GPU resources synchronously inside the
frame.

He identified the mechanism in finding 1 and separately failed to find the period
in finding 4, and never joined them. The period was never going to be a timer. It
is a **tile ring crossing a 500 m grid at 44 metres per second.**

There is a second, faster cadence underneath it: `RING_CACHE_STEP_M = 125`
recomputes the wanted-tile ring over 18,113 index entries every 125 m — every
**2.8 s** at speed. That one is a main-thread pass, not a GPU stall, and it is a
better fit for a smaller, more frequent judder.

### The test, and it costs nothing

If this is right, **the interval scales with speed** — and that is falsifiable in
five minutes without writing any code:

| Speed | Predicted interval between freezes |
|---|---|
| Standing still | none at all |
| Walking (~5 m/s) | ~100 s |
| Half throttle (22 m/s) | ~23 s |
| Flat out (44 m/s) | ~11 s |

If the freezes track that table, the cause is distance-driven streaming and
findings 3, 4, 6 and 7 are all secondary. If the interval stays at ten seconds
while the player stands still in an empty street, then it *is* a timer or a GC
cadence, and Sebastian's R1 is the only way forward.

**One experiment discriminates between the entire paper and one line of it.** It
should have been the first page.

---

## Revised recommendations

**R0 — Run the speed test. Today. Before anything is built.**
Stand still for two minutes. Walk for two. Drive at half throttle for two. Drive
flat out for two. Note the interval each time. This is free and it decides what
the other three are worth.

**R1 — Keep, scoped down.** The stolen-time subtraction is the valuable half and
I want it. One caveat Sebastian omitted: the gap between the animation-frame
delta and the sum of the sections includes the browser's own compositing and the
*previous* frame's GPU work, so it will read non-zero constantly. It needs a
calibrated baseline before it means anything, or the first person to look at it
will conclude the browser is stealing 4 ms a frame forever and stop trusting it.

Add one thing: **a marker in the frame profiler for "a tile became visible this
frame"**. If R0 comes back positive, that single correlation is the whole
investigation.

**R2 — Keep the accumulator clamp. Drop the sweep stagger for now.**
The clamp is right whatever the cause; it is four lines and it removes an
amplifier. The stagger is now unjustified spending — do not build it until R0
says the period is a timer.

**R3 — Promote the pipeline manifest; demote the worker.**
The build-time pipeline manifest is the correct end state and I endorse it
without reservation. The content-parse worker is a load-time fix for a load-time
problem; it is worth doing and it is not part of this investigation. Say so.

---

## To Sebastian

The reading is strong and findings 1, 2 and 10 justify the engagement on their
own. Two things to take away.

You wrote a paper about an instrumentation gap and then did not use the
instruments that exist. The owner has been pasting stall logs into chat for a
week; not one is cited.

And you found a mechanism with no period, and a period with no mechanism, in the
same document, and did not put them together. When the timer search comes up
empty, the next question is not "which timers might coincide" — it is **"what if
it is not a timer"**. In a game that streams on distance and a player who was
moving in a straight line at a constant speed both times he complained, that
question answers itself.

Shorten it to seven findings, take the four measurements, run R0, and bring it
back.
