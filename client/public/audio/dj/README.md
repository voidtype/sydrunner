# DJ tracks for the illegal raves

Drop audio files in this folder. Anything a browser can decode works — `.mp3`,
`.ogg`, `.m4a`, `.wav` — but **prefer `.ogg` or `.mp3`**: a rave track is played
positionally at a warehouse full of people, and a 40 MB WAV is 40 MB every
player streams before the music starts.

Then run:

    scripts/dj-manifest.sh

which writes `tracks.json` beside the files. The game reads that manifest — a
browser cannot list a directory, so the manifest is how the client learns what
you put here. Re-run it whenever you add or remove a track.

## Naming

Naming is free-form. If you name a file `Artist - Title.ogg` the game will show
"Artist — Title" on the decks; otherwise it shows the filename without its
extension.

If you put the **BPM** in the name — `Karmel [128].mp3`, `Karmel (128).mp3` or
`Karmel 128bpm.mp3` — the manifest picks it up and the whole light rig locks to
it: the moving heads sweep on the bar, the strobe fires on the beat, and forty
people bounce in time with what you are actually hearing. Without it the venue
uses its own hashed tempo, which looks right but is not *your* right. Nothing
here does beat detection; that would be a dependency. The bracketed number is
stripped from the title, so `Karmel [128].mp3` still shows as "Karmel".

## What the manifest carries, and why `seconds` matters

    {"file": "Aliens.mp3", "title": "Aliens", "bytes": 6572131, "seconds": 344.555}

`seconds` is measured by the script (`afinfo` on macOS, `ffprobe` otherwise) and
it is the field that makes a rave **shared**.

A night is thirty minutes and a track is five or six, so a set is five or six
records deep. Everybody standing in that crowd has to be on the same record at
the same second — and they have to agree about it without asking each other and
without downloading the whole bag to find out how long everything is. With
`seconds` written down, the client works out which track is playing and how far
into it from the wall clock alone, before it has fetched a single byte. A player
who walks in forty minutes late lands exactly where everyone else is.

If neither tool is installed the field is left out and the game falls back to
fixed six-minute slots — still shared, but the mixes happen at times that have
nothing to do with where your tracks actually end. It is worth having the field.

## What the game does with them

Each rave draws its own set list out of the night's seed, so two raves across
town on the same night are playing different records in a different order, and
the same rave on the same night is the same set for everybody who walks into it.
Nothing about this is on the wire — it is all arithmetic on the clock.

Tracks are fetched **lazily**: nothing is downloaded until a player is close
enough to a live rave to actually hear it, and only the record on the decks is
held in memory (plus the next one, for the twenty seconds before a mix). A
player who never finds a rave never downloads a track.

Levels are left alone. The game attenuates with distance and opens a low-pass
filter as you approach — the muffled thump from three streets away that turns
into a full mix when you round the corner — and does nothing else to the audio.
Master your tracks however you like; they will play at the level you made them.

## The empty case

The folder is allowed to be empty and the game is complete without it: the rig
still runs, the decks read "no record bag", and the crowd dances to a synthesised
four-on-the-floor generated from the same shared clock, so even with no files at
all every player at a rave is on the same beat of the same bar.
