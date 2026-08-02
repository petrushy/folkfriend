#!/usr/bin/env bash
# Downloads the acoustic_grand_piano FluidR3_GM soundfont files for the full
# playable piano range (A0–C8, 88 notes). Files are fetched from the
# paulrosen midi-js-soundfonts CDN and stored in public/soundfont/ so they are
# precached by the service worker at build time, making playback fully offline.
#
# Run once after cloning, or whenever you want to refresh the files:
#   bash download_soundfont.sh

set -e

DEST="public/soundfont/acoustic_grand_piano-mp3"
BASE="https://paulrosen.github.io/midi-js-soundfonts/FluidR3_GM/acoustic_grand_piano-mp3"

mkdir -p "$DEST"

NOTES=(
  A0 Bb0 B0
  C1 Db1 D1 Eb1 E1 F1 Gb1 G1 Ab1 A1 Bb1 B1
  C2 Db2 D2 Eb2 E2 F2 Gb2 G2 Ab2 A2 Bb2 B2
  C3 Db3 D3 Eb3 E3 F3 Gb3 G3 Ab3 A3 Bb3 B3
  C4 Db4 D4 Eb4 E4 F4 Gb4 G4 Ab4 A4 Bb4 B4
  C5 Db5 D5 Eb5 E5 F5 Gb5 G5 Ab5 A5 Bb5 B5
  C6 Db6 D6 Eb6 E6 F6 Gb6 G6 Ab6 A6 Bb6 B6
  C7 Db7 D7 Eb7 E7 F7 Gb7 G7 Ab7 A7 Bb7 B7
  C8
)

echo "Downloading ${#NOTES[@]} soundfont note files to $DEST/ ..."
for note in "${NOTES[@]}"; do
  dest_file="$DEST/${note}.mp3"
  # Only an existing file that is plausibly a whole note is worth keeping. The
  # smallest real note is ~14 kB; anything under 1 kB is a truncated transfer or
  # an error page, and skipping over one would leave playback broken in a way
  # that reads as an app bug rather than a bad download.
  if [ -f "$dest_file" ] && [ "$(wc -c < "$dest_file")" -ge 1024 ]; then
    echo "  skip $note (already exists)"
  else
    echo "  $note"
    # Download to a temporary name and move into place only on success, so an
    # interrupted run can never leave a half-written file that the check above
    # would then accept.
    curl -sf "$BASE/${note}.mp3" -o "$dest_file.part"
    mv "$dest_file.part" "$dest_file"
  fi
done
echo "Done."
