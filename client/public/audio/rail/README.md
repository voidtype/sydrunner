# Rail audio

## What is wired, and to what

Two of the three files in this folder are played by the game. The schedule is in
`client/src/game/rail-audio.ts` and the sound is made in
`client/src/game/audio.ts`; neither has a timer or an event queue in it, because
the timetable already answers the question in closed form.

| file | when it plays |
|---|---|
| `25s_before_arrive.mp3` | starts 25 s before the doors open at the next calling station, runs 27.35 s, so it ends 2.35 s into the 15 s stand |
| `15s_before_leave.mp3` | starts 15 s before the doors close — with the bake's 15 s dwell, the instant they open — and runs 65.25 s, about fifty seconds into the journey |
| `announcement_beep.mp3` | **not played.** See below |

Both are positional, sourced from the nearest carriage of the train making them,
audible to 110 m and clear inside the carriage you are riding in. A player who
walks onto a platform halfway through a sentence hears the middle of it, and two
players in one carriage hear the same syllable, because the offset into the clip
is arithmetic on the shared clock rather than a thing anybody started.

The rest of the design is in the header of `game/rail-audio.ts`, and the level
and filter numbers are in the "train PA" section of `game/audio.ts`.

## What was done to the files on the way in

Normalised to about -14 LUFS with a -1 dBTP ceiling — the level the DJ tracks in
`audio/dj/` are mastered to, so nothing in the mix is louder than anything else
by accident — and **mono-ised**, because the engine places them in 3D itself and
a stereo source through a distance gain is wasted bytes twice over: on the wire
and again in the decoded buffer.

```
                          before                      after
25s_before_arrive.mp3     429 kB  stereo 44.1 kHz     214 kB  mono 32 kHz
15s_before_leave.mp3     1275 kB  stereo 24 kHz       510 kB  mono 24 kHz
announcement_beep.mp3      28 kB  stereo 22 kHz        12 kB  mono 32 kHz
                         1732 kB                      736 kB
```

The two that ship decode to 16.9 MB of `AudioBuffer` rather than 33.8 MB.

The command, for anything added later — measure first, then apply the measured
values, because one-pass `loudnorm` guesses:

```sh
ffmpeg -i in.mp3 -af "aformat=channel_layouts=mono,loudnorm=I=-14:TP=-1:LRA=11:print_format=json" -f null -
ffmpeg -i in.mp3 -af "aformat=channel_layouts=mono,loudnorm=I=-14:TP=-1:LRA=11:measured_I=…:measured_TP=…:measured_LRA=…:measured_thresh=…:offset=…:linear=true" \
  -ac 1 -ar 32000 -c:a libmp3lame -b:a 64k -map_metadata -1 out.mp3
```

## The beep is in the folder and is deliberately not played

Two independent reasons, either of which is enough.

**It has nothing to introduce.** Both recordings are complete announcements that
carry their own lead-in; putting a chime in front of one would be two chimes.
There is no third announcement in the game for it to open.

**It is the real chime, not something like it.** Its first 1.3 s is a three-note
motif — about 590 Hz, then 245 Hz, then 295 Hz, decaying to silence — which is a
composed identifier rather than a generic tone. That is exactly the question the
note below was written about, and exactly the question the roundels on the
Tangara lost. A close-but-distinct chime, synthesised or recorded, would sidestep
it entirely and would take about ten lines in `game/audio.ts`, which already
builds every impact in the game out of oscillators.

The same question is open about the announcement *voice* in the two clips that
do play. That is a call for whoever owns the project rather than something to
quietly reverse.

## Anything else dropped here

Nothing is wired for these yet, but they are the obvious next ones and the rail
layer already knows when each moment happens:

    door-chime-open.*      the moment the doors release
    door-chime-close.*     the closing warning
    doors-slide.*          the leaves themselves, open and shut
    traction-start.*       pulling away from rest, the motor whine
    traction-cruise.*      steady at line speed, loops
    wheels-rail.*          rumble, loops, pitched by speed
    brake-squeal.*         approach into a stop
    platform-ambience.*    the station itself, loops
    whistle.*              the guard

Mono is preferred for anything positional; the engine places it in 3D itself.

A note on what to record: a close-but-not-identical door chime is safer than
the real one. The Sydney Trains chime and the announcement voice are plausibly
a sound mark and a performance, which is the same question the roundels on the
Tangara were, and those came off.
