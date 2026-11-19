#!/usr/bin/env bash
# Benchmarks detection on a folder of single-tune recordings.
#
#   scripts/bench_tune_clips.sh <folder> [dataset ...] [-- scorer options]
#
# The folder holds the recordings (anything ffmpeg reads) and a tunes.json
# naming the tune in each — see app/test/bench/scoreTuneClips.mjs for the
# format, including how to list a tune that is in no dataset (those clips
# measure false positives). The datasets searched default to all four the
# data repo builds: thesession folkwiki norbeck spillefolk. Each is read from
# app/public/res/<id>.json, else ../folkfriend-app-data/build/data/<id>.json;
# a missing one is skipped with a warning, so the result says what was
# searched. Every tune id in tunes.json should come from one of them.
#
# Each clip is converted to mono 16-bit WAV and its trailing 10 s window is
# transcribed every 2 s with the real DSP transcriber
# (rust/examples/transcribe_windows); all windows are then searched in one pass
# with the library's own query over the merged datasets (rust/examples/requery
# with RQ_LIB=1), and each clip is scored on its own, through the live view's
# rules (scoreTaggedSession.mjs --json). Derived files go in <folder>/bench/
# and transcriptions are reused while a recording is unchanged. ~1 minute for
# 50 clips of 1–3 minutes on an M-series Mac, most of it the search.
#
# Recordings are private: keep the folder OUT of git (.git/info/exclude, or
# outside the repo). Only the numbers belong in commits. See "Private
# recordings" in CLAUDE.md.
#
# Needs: ffmpeg, node, and a Rust toolchain.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
folder="${1:?usage: bench_tune_clips.sh <folder> [dataset ...] [-- scorer options]}"
shift
datasets=()
while [[ $# -gt 0 && "$1" != "--" ]]; do datasets+=("$1"); shift; done
[[ "${1:-}" == "--" ]] && shift
[[ ${#datasets[@]} -gt 0 ]] || datasets=(thesession folkwiki norbeck spillefolk)
[[ -f "$folder/tunes.json" ]] || { echo "Missing $folder/tunes.json (see app/test/bench/scoreTuneClips.mjs)" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is required (brew install ffmpeg)" >&2; exit 1; }

files=()
for id in "${datasets[@]}"; do
    f=""
    for dir in "$repo/app/public/res" "$repo/../folkfriend-app-data/build/data"; do
        [[ -f "$dir/$id.json" ]] && { f="$dir/$id.json"; break; }
    done
    if [[ -z "$f" ]]; then echo "!! dataset '$id' not found — not searched" >&2; else files+=("$id=$f"); fi
done
[[ ${#files[@]} -gt 0 ]] || { echo "No datasets found" >&2; exit 1; }

(cd "$repo/rust" && { cargo build --release --example transcribe_windows --example requery -q 2>/dev/null \
    || cargo build --release --example transcribe_windows --example requery; })
bin="$repo/rust/target/release/examples"

bench="$folder/bench"
mkdir -p "$bench"
shopt -s nullglob nocaseglob
all="$bench/windows.jsonl"
: > "$all.part"
for audio in "$folder"/*.{mp3,m4a,wav,flac,ogg,aac,opus,webm}; do
    name="$(basename "$audio")"
    base="$bench/${name%.*}"
    wav="$base.wav"
    windows="$base.w10.jsonl"
    if [[ ! -f "$wav" || "$audio" -nt "$wav" ]]; then
        echo "-- converting $name" >&2
        ffmpeg -hide_banner -loglevel error -y -i "$audio" -ac 1 -c:a pcm_s16le "$wav"
    fi
    if [[ ! -s "$windows" || "$wav" -nt "$windows" ]]; then
        "$bin/transcribe_windows" "$wav" 2 10 > "$windows.part"
        mv "$windows.part" "$windows"
    fi
    FILE="$name" node -e '
        const lines = require("fs").readFileSync(0, "utf8").trim().split("\n").filter(Boolean);
        for (const l of lines) console.log(JSON.stringify({ ...JSON.parse(l), file: process.env.FILE }));
    ' < "$windows" >> "$all.part"
done
# Replaced only when it changed, so an unchanged folder is not searched again.
if cmp -s "$all.part" "$all"; then rm "$all.part"; else mv "$all.part" "$all"; fi

# One index holding every dataset, as the app merges them, plus which dataset
# each tune came from (an extra key the library ignores).
tag="$(IFS=+; echo "${datasets[*]}")"
merged="$bench/index.$tag.json"
OUT="$merged.part" node -e '
    const fs = require("fs");
    const out = { settings: {}, aliases: {}, dataset_by_tune: {} };
    for (const arg of process.argv.slice(1)) {
        const [id, file] = arg.split(/=(.*)/s);
        const d = JSON.parse(fs.readFileSync(file, "utf8"));
        let clash = 0;
        for (const [k, v] of Object.entries(d.settings)) { if (k in out.settings) clash++; out.settings[k] = v; }
        for (const [k, v] of Object.entries(d.aliases)) { out.aliases[k] = v; out.dataset_by_tune[k] = id; }
        console.error(`-- ${id}: ${Object.keys(d.settings).length} settings${clash ? `, ${clash} setting ids CLASH` : ""}`);
    }
    fs.writeFileSync(process.env.OUT, JSON.stringify(out));
' "${files[@]}"
if cmp -s "$merged.part" "$merged"; then rm "$merged.part"; else mv "$merged.part" "$merged"; fi

results="$bench/results.$tag.jsonl"
if [[ ! -s "$results" || "$all" -nt "$results" || "$merged" -nt "$results" ]]; then
    echo "-- searching $(wc -l < "$all" | tr -d ' ') windows" >&2
    RQ_LIB=1 "$bin/requery" "$merged" "$all" > "$results.part"
    mv "$results.part" "$results"
fi
echo
node "$repo/app/test/bench/scoreTuneClips.mjs" "$results" "$folder/tunes.json" --index "$merged" "$@"
