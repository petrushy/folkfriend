#!/usr/bin/env bash
# Benchmarks live detection on every hand-tagged session recording in a folder.
#
#   scripts/bench_tagged_sessions.sh <folder> [window-seconds] [-- scorer options]
#
# The folder holds Transcribe! .xsc files and the recordings they name (the
# SoundFileName line), side by side — e.g. session.m4a + session.xsc. Mark the
# start of every tune, and every break with a marker named "break".
#
# For each session this converts the audio to mono 16-bit WAV, transcribes and
# searches the trailing window every 2 s with the real DSP transcriber and
# query (rust/examples/detect_sim.rs --wav), and scores the result against the
# tags (app/test/bench/scoreTaggedSession.mjs). Derived files go in
# <folder>/bench/ and are reused while the recording is unchanged, so
# re-scoring after a rule change takes seconds; transcription takes ~8 minutes
# per 90 minutes of audio on an M-series Mac.
#
# Recordings are private: keep the folder OUT of git (.git/info/exclude, or
# outside the repo). Only the numbers belong in commits. See "Private
# recordings" in CLAUDE.md.
#
# Needs: ffmpeg, the rustup toolchain, and the thesession dataset in
# app/public/res/ (cd app && bash download_tune_data.sh).
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
folder="${1:?usage: bench_tagged_sessions.sh <folder> [window-seconds] [-- scorer options]}"
shift
window=10
if [[ $# -gt 0 && "$1" != "--" ]]; then window="$1"; shift; fi
[[ "${1:-}" == "--" ]] && shift
index="$repo/app/public/res/thesession.json"
[[ -f "$index" ]] || { echo "Missing $index — run: cd app && bash download_tune_data.sh" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is required (brew install ffmpeg)" >&2; exit 1; }

# Homebrew rustc may shadow rustup's; either builds the native example.
(cd "$repo/rust" && { cargo build --release --example detect_sim -q 2>/dev/null || cargo build --release --example detect_sim; })
sim="$repo/rust/target/release/examples/detect_sim"

mkdir -p "$folder/bench"
shopt -s nullglob
found=0
for tags in "$folder"/*.xsc "$folder"/*.tags.json; do
    if [[ "$tags" == *.xsc ]]; then
        audio_name="$(grep -m1 '^SoundFileName,' "$tags" | cut -d, -f2)"
    else
        audio_name="$(basename "$tags" .tags.json)"
        audio_name="$(cd "$folder" && ls "$audio_name".* 2>/dev/null | grep -v '\.tags\.json$' | head -1)"
    fi
    audio="$folder/$audio_name"
    if [[ -z "$audio_name" || ! -f "$audio" ]]; then
        echo "!! $(basename "$tags"): recording '$audio_name' not found beside it — skipped" >&2
        continue
    fi
    found=$((found + 1))
    base="$folder/bench/$(basename "${audio%.*}")"
    wav="$base.wav"
    windows="$base.w$window.jsonl"
    if [[ ! -f "$wav" || "$audio" -nt "$wav" ]]; then
        echo "-- converting $(basename "$audio")" >&2
        ffmpeg -hide_banner -loglevel error -y -i "$audio" -ac 1 -ar 44100 -c:a pcm_s16le "$wav"
    fi
    if [[ ! -s "$windows" || "$wav" -nt "$windows" ]]; then
        echo "-- transcribing and searching $(basename "$audio") (${window} s window)" >&2
        "$sim" --wav "$wav" 2 "$index" "$window" > "$windows.part" 2>/dev/null
        mv "$windows.part" "$windows"
    fi
    echo
    echo "=== $(basename "$audio") ==="
    node "$repo/app/test/bench/scoreTaggedSession.mjs" "$windows" "$tags" --index "$index" "$@"
done
[[ $found -gt 0 ]] || { echo "No tagged sessions (.xsc or .tags.json) in $folder" >&2; exit 1; }
