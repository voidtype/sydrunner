#!/bin/sh
# Write client/public/audio/dj/tracks.json from whatever is in that folder.
#
# A browser cannot list a directory, so the rave's record bag has to be written
# down at build time. Run this after adding or removing tracks; `npm run build`
# does not do it for you, deliberately — the manifest is checked in, so a clone
# without the audio still builds and simply has no music.
#
# ---------------------------------------------------------------------------
# `seconds` IS THE FIELD THAT MAKES A RAVE SHARED, AND IT IS WHY THIS SCRIPT
# LOOKS AT THE AUDIO RATHER THAN JUST AT THE DIRECTORY LISTING.
#
# A rave runs for a whole 30-minute night and the tracks are five to six minutes
# long, so a set is five or six records deep. Every player at that rave has to be
# on the *same record at the same second*, and they have to agree about it
# without asking each other and without downloading the whole bag to find out how
# long everything is — 28 MB to learn four numbers.
#
# So the four numbers are written down here. With `seconds` on every row the
# client can compute, from the wall clock alone and before it has fetched a
# single byte, exactly which track is playing and how far in; see
# `setPosition` in `client/src/game/rave.ts`. Without it the client falls back to
# fixed nominal slots, which still works and is still shared but mixes at times
# that have nothing to do with where the tracks actually end.
#
# `afinfo` ships with macOS and `ffprobe` with ffmpeg; if neither is present the
# field is simply omitted and the fallback takes over.
#
# ---------------------------------------------------------------------------
# `bpm` IS OPTIONAL AND IS TAKEN FROM THE FILENAME.
#
# Name a file `Karmel [128].mp3` or `Karmel 128bpm.mp3` and the lights, the
# lasers, the strobe and the whole crowd's bounce lock to 128 instead of to the
# venue's own hashed guess. Nothing in this repository does beat detection —
# that would be a dependency — so this is the one place the information can come
# from, and it costs the person who made the track nothing, because they already
# know the number.
set -eu
DIR=$(cd "$(dirname "$0")/../client/public/audio/dj" && pwd)
cd "$DIR"

duration_of() {
  # Seconds, to three decimals, or empty. `afinfo` first because it is on every
  # Mac and needs no install; `ffprobe` is the portable fallback.
  if command -v afinfo >/dev/null 2>&1; then
    d=$(afinfo "$1" 2>/dev/null | sed -n 's/.*estimated duration: *\([0-9.]*\).*/\1/p' | head -1)
    if [ -n "${d:-}" ]; then printf '%.3f' "$d"; return; fi
  fi
  if command -v ffprobe >/dev/null 2>&1; then
    d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$1" 2>/dev/null | head -1)
    if [ -n "${d:-}" ]; then printf '%.3f' "$d"; return; fi
  fi
  printf ''
}

bpm_of() {
  # `[128]`, `(128)` or `128bpm` anywhere in the name. Bounded to 60-200 so a
  # year in a title is not mistaken for a tempo.
  b=$(printf '%s' "$1" | sed -n 's/.*[[(]\([0-9]\{2,3\}\)[])].*/\1/p' | head -1)
  [ -n "${b:-}" ] || b=$(printf '%s' "$1" | sed -n 's/.*[^0-9]\([0-9]\{2,3\}\) *[bB][pP][mM].*/\1/p' | head -1)
  [ -n "${b:-}" ] || { printf ''; return; }
  [ "$b" -ge 60 ] 2>/dev/null && [ "$b" -le 200 ] 2>/dev/null && printf '%s' "$b" || printf ''
}

printf '[\n' > tracks.json.tmp
first=1
for f in *.mp3 *.ogg *.m4a *.wav *.opus *.flac; do
  [ -e "$f" ] || continue
  bytes=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f")
  secs=$(duration_of "$f")
  bpm=$(bpm_of "${f%.*}")
  [ $first -eq 1 ] || printf ',\n' >> tracks.json.tmp
  first=0
  # `title` is the filename with the extension and any bracketed BPM removed;
  # the client splits "Artist - Title" if there is one and otherwise shows it as
  # written.
  title=$(printf '%s' "${f%.*}" | sed 's/ *[[(][0-9]\{2,3\}[])]//; s/ *[0-9]\{2,3\} *[bB][pP][mM]//; s/ *$//; s/"/\\"/g')
  printf '  {"file": "%s", "title": "%s", "bytes": %s' "$f" "$title" "$bytes" >> tracks.json.tmp
  [ -n "$secs" ] && printf ', "seconds": %s' "$secs" >> tracks.json.tmp
  [ -n "$bpm" ] && printf ', "bpm": %s' "$bpm" >> tracks.json.tmp
  printf '}' >> tracks.json.tmp
done
printf '\n]\n' >> tracks.json.tmp
mv tracks.json.tmp tracks.json
n=$(grep -c '"file"' tracks.json || true)
nd=$(grep -c '"seconds"' tracks.json || true)
echo "tracks.json: $n track(s) in $DIR ($nd with a measured duration)"
