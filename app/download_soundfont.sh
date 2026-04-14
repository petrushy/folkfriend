#!/usr/bin/env bash
# Downloads the acoustic_grand_piano FluidR3_GM soundfont files for the folk
# music pitch range (G2–C7, 54 notes). Files are fetched from the paulrosen
# midi-js-soundfonts CDN and stored in public/soundfont/ so they are
# precached by the service worker at build time, making playback fully offline.
#
# Run once after cloning, or whenever you want to refresh the files:
#   bash download_soundfont.sh

set -e

DEST="public/soundfont/acoustic_grand_piano-mp3"
BASE="https://paulrosen.github.io/midi-js-soundfonts/FluidR3_GM/acoustic_grand_piano-mp3"

mkdir -p "$DEST"

NOTES=(
  G2 Ab2 A2 Bb2 B2
  C3 Db3 D3 Eb3 E3 F3 Gb3 G3 Ab3 A3 Bb3 B3
  C4 Db4 D4 Eb4 E4 F4 Gb4 G4 Ab4 A4 Bb4 B4
  C5 Db5 D5 Eb5 E5 F5 Gb5 G5 Ab5 A5 Bb5 B5
  C6 Db6 D6 Eb6 E6 F6 Gb6 G6 Ab6 A6 Bb6 B6
  C7
)

echo "Downloading ${#NOTES[@]} soundfont note files to $DEST/ ..."
for note in "${NOTES[@]}"; do
  dest_file="$DEST/${note}.mp3"
  if [ -f "$dest_file" ]; then
    echo "  skip $note (already exists)"
  else
    echo "  $note"
    curl -sf "$BASE/${note}.mp3" -o "$dest_file"
  fi
done
echo "Done."
