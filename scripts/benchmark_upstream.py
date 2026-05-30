#!/usr/bin/env python3
"""Benchmark the upstream TomWyllie/folkfriend against Celtic (thesession) test WAVs.

The upstream binary:
  - has no --index flag (downloads to ~/.folkfriend/ on first run)
  - cannot handle stereo WAVs (only mono)
  - outputs 3 tab-separated columns: tune_id, display_name, score

Usage:
  python scripts/benchmark_upstream.py            # run and update docs/benchmarks.md
  python scripts/benchmark_upstream.py --setup    # clone + build + download dataset only
"""
from __future__ import annotations

import argparse
import array
import json
import os
import shutil
import subprocess
import sys
import tempfile
import wave
from pathlib import Path
from typing import Any

# Import helpers from the main benchmark runner
sys.path.insert(0, str(Path(__file__).resolve().parent))
from run_benchmark import (
    generate_report,
    load_json,
    sha256_file,
    write_result_json,
    fatal,
    REPO_ROOT,
    INDEX_RELATIVE,
    TUNE_REGISTRY_RELATIVE,
    WAVS_RELATIVE,
)

UPSTREAM_REPO_URL = "https://github.com/TomWyllie/folkfriend.git"
UPSTREAM_DIR = Path(tempfile.gettempdir()) / "ff_upstream"
UPSTREAM_HOME = Path(tempfile.gettempdir()) / "ff_upstream_home"
UPSTREAM_BINARY = UPSTREAM_DIR / "rust" / "target" / "release" / "folkfriend"
UPSTREAM_DATASET = UPSTREAM_HOME / ".folkfriend" / "folkfriend-non-user-data.json"
UPSTREAM_INDEX_URL = "https://folkfriend-app-data.web.app/folkfriend-non-user-data.json"
MONO_CACHE = Path(tempfile.gettempdir()) / "ff_upstream_mono"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Benchmark the upstream TomWyllie/folkfriend on Celtic test WAVs.",
    )
    parser.add_argument(
        "--setup",
        action="store_true",
        help="Clone, build, and download dataset only — do not run benchmark.",
    )
    args = parser.parse_args()

    ensure_upstream_ready()

    if args.setup:
        print("Upstream setup complete.", file=sys.stderr)
        return 0

    run_upstream_benchmark()
    return 0


def ensure_upstream_ready() -> None:
    """Clone repo, update wasm-bindgen, build binary, download dataset."""
    if not UPSTREAM_DIR.exists():
        print("Cloning upstream repo…", file=sys.stderr)
        subprocess.run(
            ["git", "clone", "--depth=1", UPSTREAM_REPO_URL, str(UPSTREAM_DIR)],
            check=True,
        )

    if not UPSTREAM_BINARY.exists():
        print("Building upstream binary…", file=sys.stderr)
        # wasm-bindgen in the upstream lock file is too old for current Rust;
        # update it in-place before building.
        subprocess.run(
            ["cargo", "update", "-p", "wasm-bindgen"],
            cwd=UPSTREAM_DIR / "rust",
            check=True,
            capture_output=True,
        )
        result = subprocess.run(
            ["cargo", "build", "--release", "--bin", "folkfriend"],
            cwd=UPSTREAM_DIR / "rust",
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            fatal(f"Upstream cargo build failed:\n{result.stderr.strip() or result.stdout.strip()}")
        if not UPSTREAM_BINARY.exists():
            fatal(f"Expected binary not found at {UPSTREAM_BINARY}")
        print("Upstream binary built.", file=sys.stderr)

    if not UPSTREAM_DATASET.exists():
        print(f"Downloading upstream dataset from {UPSTREAM_INDEX_URL}…", file=sys.stderr)
        UPSTREAM_DATASET.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            ["curl", "-fsSL", "-o", str(UPSTREAM_DATASET), UPSTREAM_INDEX_URL],
            check=False,
        )
        if result.returncode != 0 or not UPSTREAM_DATASET.exists():
            fatal(f"Failed to download upstream dataset from {UPSTREAM_INDEX_URL}")
        print(f"Downloaded {UPSTREAM_DATASET.stat().st_size:,} bytes.", file=sys.stderr)


def run_upstream_benchmark() -> None:
    upstream_commit = get_upstream_commit()
    upstream_date = get_upstream_date()

    dataset_sha256 = sha256_file(UPSTREAM_DATASET)
    dataset_bytes = UPSTREAM_DATASET.stat().st_size

    tunes = load_json(REPO_ROOT / TUNE_REGISTRY_RELATIVE)
    celtic_tunes = [t for t in tunes if t.get("source") == "thesession"]

    print(
        f"Running {len(celtic_tunes)} Celtic tunes against upstream {upstream_commit}",
        file=sys.stderr,
    )

    MONO_CACHE.mkdir(parents=True, exist_ok=True)
    results = []

    for index, tune in enumerate(celtic_tunes, start=1):
        wav_name = tune["wav"]
        print(f"[{index}/{len(celtic_tunes)}] {wav_name}", file=sys.stderr)

        src_wav = REPO_ROOT / WAVS_RELATIVE / wav_name
        rank: int | None = None
        score: float | None = None

        if not src_wav.exists():
            print(f"  Missing WAV: {src_wav}", file=sys.stderr)
        else:
            mono_wav = ensure_mono(src_wav)
            rank, score = run_upstream_query(
                wav_path=mono_wav,
                expected_tune_ids=set(tune["expected_tune_ids"]),
            )

        detected = rank is not None and rank <= tune["max_rank"]
        results.append(
            {
                "wav": wav_name,
                "label": tune["label"],
                "expected_tune_ids": tune["expected_tune_ids"],
                "max_rank": tune["max_rank"],
                "rank": rank,
                "score": score,
                "detected": detected,
            }
        )

    payload = {
        "commit": f"upstream_{upstream_commit}",
        "commit_message": f"TomWyllie/folkfriend @ {upstream_commit}",
        "date": upstream_date,
        "dataset_sha256": dataset_sha256,
        "dataset_bytes": dataset_bytes,
        "results": results,
    }
    write_result_json(payload)
    generate_report()


def run_upstream_query(
    wav_path: Path,
    expected_tune_ids: set[str],
) -> tuple[int | None, float | None]:
    env = {**os.environ, "HOME": str(UPSTREAM_HOME)}

    try:
        result = subprocess.run(
            [str(UPSTREAM_BINARY), "query", str(wav_path)],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError as exc:
        print(f"  Failed to run upstream binary: {exc}", file=sys.stderr)
        return None, None

    if result.returncode != 0:
        err = result.stderr.strip() or result.stdout.strip() or "unknown error"
        print(f"  Query failed: {err}", file=sys.stderr)
        return None, None

    rows = parse_upstream_output(result.stdout)
    for row_index, row in enumerate(rows, start=1):
        if row["tune_id"] in expected_tune_ids:
            return row_index, row["score"]

    return None, None


def parse_upstream_output(stdout: str) -> list[dict[str, Any]]:
    """Parse upstream 3-column output: tune_id\\tdisplay_name\\tscore"""
    rows = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line or "\t" not in line:
            continue
        parts = line.split("\t")
        if len(parts) != 3:
            continue
        try:
            score = float(parts[2].strip())
        except ValueError:
            continue
        rows.append({
            "tune_id": strip_debug_quotes(parts[0].strip()),
            "score": score,
        })
    return rows


def strip_debug_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        return value[1:-1]
    return value


def ensure_mono(src: Path) -> Path:
    """Return a mono version of the WAV, converting from stereo if needed."""
    with wave.open(str(src), "rb") as w:
        n_channels = w.getnchannels()

    if n_channels == 1:
        return src

    dst = MONO_CACHE / src.name
    if dst.exists():
        return dst

    with wave.open(str(src), "rb") as w:
        n_channels = w.getnchannels()
        sampwidth = w.getsampwidth()
        framerate = w.getframerate()
        n_frames = w.getnframes()
        raw = w.readframes(n_frames)

    if sampwidth == 2:
        samples = array.array("h", raw)
        mono = array.array(
            "h",
            (
                sum(samples[i : i + n_channels]) // n_channels
                for i in range(0, len(samples), n_channels)
            ),
        )
        mono_raw = mono.tobytes()
    elif sampwidth == 1:
        samples = array.array("B", raw)
        mono = array.array(
            "B",
            (
                sum(samples[i : i + n_channels]) // n_channels
                for i in range(0, len(samples), n_channels)
            ),
        )
        mono_raw = mono.tobytes()
    else:
        fatal(f"Unsupported sample width {sampwidth} in {src}")

    with wave.open(str(dst), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(sampwidth)
        w.setframerate(framerate)
        w.writeframes(mono_raw)

    return dst


def get_upstream_commit() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"],
        cwd=UPSTREAM_DIR,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.strip() or "unknown"


def get_upstream_date() -> str:
    result = subprocess.run(
        ["git", "show", "-s", "--format=%cs", "HEAD"],
        cwd=UPSTREAM_DIR,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.stdout.strip() or "unknown"


if __name__ == "__main__":
    raise SystemExit(main())
