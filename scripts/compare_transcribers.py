#!/usr/bin/env python3
"""Compare the DSP and ML transcribers on the audio corpus, and test whether a
score calibration would be worth applying.

ML scores run systematically lower than DSP for the same clip, which makes the
app's confidence labels ("Very Close", "Close", …) read pessimistically when the
ML transcriber is enabled. The obvious fix is to scale ML scores up. This
script exists to check whether that is actually a good idea, because the answer
depends on data that changes as the corpus grows.

It reports, per clip and for both transcribers:
  - the score of the CORRECT tune
  - the score of the best WRONG tune (the false-confidence risk)

then sweeps a scale factor and shows what each one buys and costs.

    cargo build --release --manifest-path rust/Cargo.toml
    python3 scripts/compare_transcribers.py

Read the sweep table, not just the ratio. A factor that improves label agreement
also lifts wrong matches over the "Very Close" threshold — ML's scores are lower
partly because its right/wrong SEPARATION is narrower, and no uniform rescale
can manufacture separation that isn't there.
"""

import json
import os
import re
import statistics as st
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
RUST = REPO / "rust"
BINARY = RUST / "target" / "release" / "folkfriend"
INDEX = REPO / "app" / "public" / "res" / "folkfriend-non-user-data.json"
BENCH = RUST / "bench" / "tunes.json"

# Mirrors app/src/components/ResultRow.vue::scoreLabel — keep in step with it.
THRESHOLDS = [(0.65, "Very Close"), (0.5, "Close"), (0.2, "Possible"), (0.0, "Unlikely")]
SWEEP = [1.0, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.35, 1.4, 1.5]


def label(score):
    if score is None:
        return "none"
    for cutoff, name in THRESHOLDS:
        if score > cutoff:
            return name
    return "No Match"


def query(wav, use_ml):
    env = dict(os.environ, FF_TRANSCRIBER="ml" if use_ml else "dsp")
    out = subprocess.run(
        [str(BINARY), "--index", str(INDEX), "query", f"wavs/{wav}"],
        capture_output=True, text=True, cwd=RUST, env=env,
    ).stdout
    rows = []
    for line in out.splitlines():
        if not line.startswith('"'):
            continue
        ids = re.findall(r'"([^"]*)"', line)
        try:
            rows.append((ids[0], float(line.rsplit("\t", 1)[-1])))
        except (ValueError, IndexError):
            pass
    return rows


def main():
    if not BINARY.exists():
        sys.exit("build the CLI first: cargo build --release --manifest-path rust/Cargo.toml")
    if not INDEX.exists():
        sys.exit("tune index missing: bash app/download_tune_data.sh")

    cases = json.load(open(BENCH))
    data = []
    for case in cases:
        expected = set(case["expected_tune_ids"])
        row = {}
        for use_ml in (False, True):
            results = query(case["wav"], use_ml)
            row["ml" if use_ml else "dsp"] = (
                next((s for t, s in results if t in expected), None),      # correct
                next((s for t, s in results if t not in expected), None),  # best wrong
            )
        data.append((case["wav"], row))

    print(f"{'recording':<32} {'DSP hit':>8} {'DSP wrong':>10} {'ML hit':>8} {'ML wrong':>9}")
    print("-" * 72)
    for wav, r in data:
        f = lambda v: f"{v:.3f}" if v is not None else "  —  "
        print(f'{wav[:32]:<32} {f(r["dsp"][0]):>8} {f(r["dsp"][1]):>10} '
              f'{f(r["ml"][0]):>8} {f(r["ml"][1]):>9}')

    pairs = [(r["dsp"][0], r["ml"][0]) for _, r in data if r["dsp"][0] and r["ml"][0]]
    if not pairs:
        sys.exit("\nno clip found its tune under both transcribers")

    dsp_hit = [d for d, _ in pairs]
    ml_hit = [m for _, m in pairs]
    dsp_wrong = [r["dsp"][1] for _, r in data if r["dsp"][1]]
    ml_wrong = [r["ml"][1] for _, r in data if r["ml"][1]]

    print(f"\ncorrect match   DSP median {st.median(dsp_hit):.3f}   ML median {st.median(ml_hit):.3f}")
    print(f"best wrong      DSP median {st.median(dsp_wrong):.3f}   ML median {st.median(ml_wrong):.3f}")
    print(f"separation      DSP {st.median(dsp_hit) - st.median(dsp_wrong):.3f}"
          f"        ML {st.median(ml_hit) - st.median(ml_wrong):.3f}"
          "   <- a uniform rescale cannot widen this")

    baseline_false = sum(1 for s in dsp_wrong if s > THRESHOLDS[0][0])
    print(f"\nscale sweep (DSP shows {baseline_false} clip(s) with a wrong tune above "
          f'"{THRESHOLDS[0][1]}")')
    print(f"{'k':>6} {'labels agreeing':>17} {'false Very Close':>18}")
    for k in SWEEP:
        agree = sum(1 for _, r in data
                    if r["dsp"][0] and r["ml"][0]
                    and label(r["dsp"][0]) == label(min(1.0, r["ml"][0] * k)))
        false_vc = sum(1 for s in ml_wrong if min(1.0, s * k) > THRESHOLDS[0][0])
        note = "  <- current" if k == 1.0 else ""
        print(f"{k:>6.2f} {agree:>10}/{len(pairs):<6} {false_vc:>13}{note}")

    print("\nNo scaling is applied in the app. As of July 2026 every factor that "
          "improved label\nagreement also multiplied false 'Very Close' results; "
          "re-run this as the corpus grows.")


if __name__ == "__main__":
    main()
