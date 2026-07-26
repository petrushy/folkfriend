#!/usr/bin/env python3
"""Derive expected tune IDs and measure detection baselines for audio fixtures.

The audio integration tests each assert that a recording finds a specific tune
within a rank cutoff and above a score floor. Working those numbers out by hand
is tedious and error-prone, so this does it:

  1. Turn each `rust/wavs/*.wav` filename into a tune name
  2. Ask the index for that name (`folkfriend name`) to get candidate tune IDs
  3. Run the actual audio query (`folkfriend query`) and find where those IDs land
  4. Emit the `rust/bench/tunes.json` entries and Rust test functions

Run it after adding recordings:

    cargo build --release --manifest-path rust/Cargo.toml
    python3 scripts/make_audio_baselines.py            # report only
    python3 scripts/make_audio_baselines.py --emit     # + generated code

ALWAYS eyeball the "matched name" column. The name lookup is a search, not a
lookup table — a mis-titled file will happily match the wrong tune, and baking
that into a test bakes in a lie.
"""

import argparse
import json
import re
import unicodedata
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
WAVS = REPO / "rust" / "wavs"
BINARY = REPO / "rust" / "target" / "release" / "folkfriend"
INDEX = REPO / "app" / "public" / "res" / "folkfriend-non-user-data.json"

# Rank cutoff and score margin the generated tests will assert.
DEFAULT_MAX_RANK = 5
SCORE_MARGIN = 0.90   # floor at 90% of the measured score


def run(args):
    return subprocess.run(
        [str(BINARY), "--index", str(INDEX), *args],
        capture_output=True, text=True, cwd=REPO / "rust",
    ).stdout


def name_from_filename(path):
    """the_kid_on_the_mountain.wav -> 'the kid on the mountain'"""
    return path.stem.replace("_", " ").strip()


def name_lookup(query, limit=5):
    """[(display_name, tune_id)] best-first from the index's name search."""
    out = []
    for line in run(["name", query]).splitlines():
        found = re.findall(r'"([^"]*)"', line)
        if len(found) >= 2 and found[-1].isdigit():
            out.append((found[0], found[-1]))
    return out[:limit]


def audio_query(wav):
    """[(tune_id, setting_id, display_name, score)] ranked best-first."""
    out = []
    for line in run(["query", f"wavs/{wav.name}"]).splitlines():
        if not line.startswith('"'):
            continue
        found = re.findall(r'"([^"]*)"', line)
        score = line.rsplit("\t", 1)[-1].strip()
        if len(found) >= 3:
            try:
                out.append((found[0], found[1], found[2], float(score)))
            except ValueError:
                pass
    return out


# "da" is the Shetland/Scots definite article and appears in index titles
# ("da lounge bar"); treating it as an article is what lets that file match.
ARTICLES = {"the", "a", "an", "da"}


def norm(s):
    """Compare titles ignoring word order, punctuation and article placement.

    NFC-normalise first: macOS stores filenames decomposed (NFD), so "nåspolskan"
    from a filename is `a` + combining ring, while the index holds the composed
    `å`. Same text, different code points, and a naive comparison fails.
    """
    s = unicodedata.normalize("NFC", s)
    s = re.sub(r"[^a-z0-9\u00c0-\u024f ]", " ", s.lower())
    return " ".join(sorted(w for w in s.split() if w not in ARTICLES))


def analyse(wav):
    """Identify the expected tune by matching the filename against the titles in
    the audio results themselves.

    Matching against a separate name search is unreliable: a tune can hold
    several IDs (The Musical Priest is 73, 9214 and 17606), and the search may
    not surface the one the index actually stores the audio's match under. The
    audio results carry their own display names, so matching there both finds
    the right ID and proves the recording detects it.
    """
    query_name = name_from_filename(wav)
    target = norm(query_name)

    results = audio_query(wav)
    if not results:
        return {"wav": wav.name, "error": "audio query returned nothing"}

    hits = [(i + 1, r) for i, r in enumerate(results) if norm(r[2]) == target]

    # Pick up any further IDs the index files under the same title, so a test
    # does not fail merely because a different-but-equivalent setting won.
    alt_ids = {tid for name, tid in name_lookup(query_name, limit=8)
               if norm(name) == target}

    if not hits:
        return {
            "wav": wav.name, "query_name": query_name,
            "error": "no result title matches the filename",
            "top_result": results[0][2], "top_score": results[0][3],
            "alt_ids": sorted(alt_ids),
        }

    rank, best = hits[0]
    ids = sorted({h[1][0] for h in hits} | alt_ids)
    return {
        "wav": wav.name,
        "query_name": query_name,
        "matched_name": best[2],
        "tune_id": best[0],
        "tune_ids": ids,
        "rank": rank,
        "score": best[3],
        "top_result": results[0][2],
        "top_score": results[0][3],
    }


def rust_ident(wav):
    """nåspolskan.wav -> audio_naspolskan_detected

    Strip accents rather than dropping the characters, or "nåspolskan" becomes
    "na_spolskan".
    """
    stem = unicodedata.normalize("NFD", wav.stem.lower())
    stem = "".join(c for c in stem if not unicodedata.combining(c))
    stem = re.sub(r"[^a-z0-9]+", "_", stem).strip("_")
    return f"audio_{stem}_detected"


def title(name):
    return " ".join(w.capitalize() for w in name.split())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--emit", action="store_true",
                    help="print generated tunes.json entries and Rust tests")
    ap.add_argument("--max-rank", type=int, default=DEFAULT_MAX_RANK)
    args = ap.parse_args()

    if not BINARY.exists():
        sys.exit(f"build the CLI first: cargo build --release --manifest-path rust/Cargo.toml")
    if not INDEX.exists():
        sys.exit("tune index missing: bash app/download_tune_data.sh")

    wavs = sorted(WAVS.glob("*.wav"))
    if not wavs:
        sys.exit(f"no .wav files in {WAVS}")

    rows = [analyse(w) for w in wavs]

    print(f"{'file':<34} {'matched tune':<32} {'id':>10} {'rank':>5} {'score':>6}")
    print("-" * 92)
    for r in rows:
        if "error" in r:
            print(f'{r["wav"]:<34} !! {r["error"]}'
                  + (f' (top hit: "{r.get("top_result")}" {r.get("top_score", 0):.3f})'
                     if r.get("top_result") else ""))
            continue
        extra = f'  (+{len(r["tune_ids"]) - 1} more id)' if len(r["tune_ids"]) > 1 else ""
        print(f'{r["wav"]:<34} {r["matched_name"][:32]:<32} {r["tune_id"]:>10} '
              f'{r["rank"]:>5} {r["score"]:>6.4f}{extra}')

    usable = [r for r in rows if r.get("rank")]
    print(f"\n{len(usable)}/{len(rows)} recordings find their tune; "
          f"{sum(1 for r in usable if r['rank'] <= args.max_rank)} within top {args.max_rank}")

    if not args.emit:
        return

    print("\n" + "=" * 92 + "\n--- rust/bench/tunes.json ---\n")
    bench = [{
        "wav": r["wav"],
        "label": title(r["query_name"]),
        "expected_tune_ids": r["tune_ids"],
        "max_rank": max(args.max_rank, r["rank"]),
        "source": "thesession" if r["tune_id"].isdigit() and len(r["tune_id"]) < 7 else "folkwiki",
    } for r in usable]
    print(json.dumps(bench, indent=2, ensure_ascii=False))

    print("\n--- rust/tests/integration_tests.rs ---\n")
    for r in usable:
        floor = r["score"] * SCORE_MARGIN
        ids = ", ".join(f'"{i}"' for i in r["tune_ids"])
        print(f"""#[test]
fn {rust_ident(Path(r['wav']))}() {{
    assert_audio_detects_one_of(
        "wavs/{r['wav']}",
        &[{ids}],
        "{title(r['query_name'])}",
        {max(args.max_rank, r['rank'])},
        {floor:.3f}, // 90% of measured {r['score']:.4f}
    );
}}
""")


if __name__ == "__main__":
    main()
