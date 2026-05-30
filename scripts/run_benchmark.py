#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
INDEX_RELATIVE = Path("app/public/res/folkfriend-non-user-data.json")
TUNE_REGISTRY_RELATIVE = Path("rust/bench/tunes.json")
WAVS_RELATIVE = Path("rust/wavs")
RESULTS_DIR_RELATIVE = Path("docs/benchmarks/results")
REPORT_RELATIVE = Path("docs/benchmarks.md")
CLI_RELATIVE = Path("rust/target/release/folkfriend")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Benchmark FolkFriend audio detection across git commits.",
    )
    parser.add_argument(
        "--commit",
        default="HEAD",
        help="Git revision to benchmark. Defaults to HEAD.",
    )
    parser.add_argument(
        "--report-only",
        action="store_true",
        help="Regenerate docs/benchmarks.md from existing JSON results.",
    )
    args = parser.parse_args()

    ensure_results_dir()

    if args.report_only:
        generate_report()
        return 0

    run_benchmark(args.commit)
    return 0


def run_benchmark(commit_ref: str) -> None:
    metadata = get_commit_metadata(commit_ref)
    dataset_path = REPO_ROOT / INDEX_RELATIVE
    dataset_sha256 = sha256_file(dataset_path)
    dataset_bytes = dataset_path.stat().st_size

    benchmark_root = REPO_ROOT
    binary_path = REPO_ROOT / CLI_RELATIVE
    worktree_root: Path | None = None

    try:
        if metadata["is_head"]:
            build_binary(REPO_ROOT)
        else:
            worktree_root = prepare_worktree(metadata["full_commit"], metadata["commit"])
            benchmark_root = worktree_root
            binary_path = worktree_root / CLI_RELATIVE

        tunes = load_json(benchmark_root / TUNE_REGISTRY_RELATIVE)
        results = benchmark_tunes(benchmark_root, binary_path, tunes)

        payload = {
            "commit": metadata["commit"],
            "commit_message": metadata["commit_message"],
            "date": metadata["date"],
            "dataset_sha256": dataset_sha256,
            "dataset_bytes": dataset_bytes,
            "results": results,
        }
        write_result_json(payload)
    finally:
        if worktree_root is not None:
            cleanup_worktree(worktree_root)

    generate_report()


def get_commit_metadata(commit_ref: str) -> dict[str, Any]:
    show = run_command(
        ["git", "show", "-s", "--format=%H%n%h%n%s%n%cs", commit_ref],
        cwd=REPO_ROOT,
        capture_output=True,
    )
    lines = show.stdout.strip().splitlines()
    if len(lines) != 4:
        fatal(f"Could not parse git metadata for commit {commit_ref!r}.")

    head = run_command(
        ["git", "rev-parse", "HEAD"],
        cwd=REPO_ROOT,
        capture_output=True,
    ).stdout.strip()

    return {
        "full_commit": lines[0],
        "commit": lines[1],
        "commit_message": lines[2],
        "date": lines[3],
        "is_head": lines[0] == head,
    }


def prepare_worktree(full_commit: str, short_commit: str) -> Path:
    worktree_root = Path(tempfile.gettempdir()) / f"ff_bench_{short_commit}"
    cleanup_worktree(worktree_root, missing_ok=True)

    run_command(
        ["git", "worktree", "add", str(worktree_root), full_commit],
        cwd=REPO_ROOT,
    )

    source_index = REPO_ROOT / INDEX_RELATIVE
    target_index = worktree_root / INDEX_RELATIVE
    target_index.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_index, target_index)

    source_tunes = REPO_ROOT / TUNE_REGISTRY_RELATIVE
    target_tunes = worktree_root / TUNE_REGISTRY_RELATIVE
    target_tunes.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_tunes, target_tunes)

    source_wavs = REPO_ROOT / WAVS_RELATIVE
    target_wavs = worktree_root / WAVS_RELATIVE
    if source_wavs.exists():
        shutil.copytree(source_wavs, target_wavs, dirs_exist_ok=True)

    build_binary(worktree_root)

    # Pre-populate ~/.folkfriend/ so old binaries (pre --index flag) can find
    # the index without a network download.
    import pathlib
    home_ff = pathlib.Path.home() / ".folkfriend"
    home_ff.mkdir(exist_ok=True)
    shutil.copy2(source_index, home_ff / "folkfriend-non-user-data.json")

    return worktree_root


def build_binary(repo_root: Path) -> None:
    print(f"Building FolkFriend in {repo_root}", file=sys.stderr)
    result = subprocess.run(
        ["cargo", "build", "--release", "--bin", "folkfriend"],
        cwd=repo_root / "rust",
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip() or "cargo build failed"
        fatal(f"cargo build failed in {repo_root / 'rust'}\n{message}")

    binary_path = repo_root / CLI_RELATIVE
    if not binary_path.exists():
        fatal(f"Expected binary was not produced at {binary_path}")


def benchmark_tunes(
    benchmark_root: Path,
    binary_path: Path,
    tunes: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []

    for index, tune in enumerate(tunes, start=1):
        wav_name = tune["wav"]
        print(f"[{index}/{len(tunes)}] {wav_name}", file=sys.stderr)

        wav_path = benchmark_root / WAVS_RELATIVE / wav_name
        rank: int | None = None
        score: float | None = None

        if not wav_path.exists():
            print(f"Missing WAV file: {wav_path}", file=sys.stderr)
        else:
            rank, score = run_single_query(
                benchmark_root=benchmark_root,
                binary_path=binary_path,
                wav_relative_path=WAVS_RELATIVE / wav_name,
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

    return results


def run_single_query(
    benchmark_root: Path,
    binary_path: Path,
    wav_relative_path: Path,
    expected_tune_ids: set[str],
) -> tuple[int | None, float | None]:
    # Try with --index flag first; fall back for old binaries that lack it.
    for cmd in (
        [str(binary_path), "--index", INDEX_RELATIVE.as_posix(), "query", wav_relative_path.as_posix()],
        [str(binary_path), "query", wav_relative_path.as_posix()],
    ):
        try:
            result = subprocess.run(
                cmd,
                cwd=benchmark_root,
                capture_output=True,
                text=True,
                check=False,
            )
        except OSError as exc:
            print(f"Failed to execute {binary_path}: {exc}", file=sys.stderr)
            return None, None

        if result.returncode != 0 and "--index" in result.stderr:
            # Old binary doesn't understand --index — retry without it.
            continue

        if result.returncode != 0:
            error_output = result.stderr.strip() or result.stdout.strip() or "unknown error"
            print(
                f"Query failed for {wav_relative_path.as_posix()}: {error_output}",
                file=sys.stderr,
            )
            return None, None

        break  # success

    parsed_rows = parse_query_output(result.stdout)
    for row_index, row in enumerate(parsed_rows, start=1):
        if row["tune_id"] in expected_tune_ids:
            return row_index, row["score"]

    return None, None


def parse_query_output(stdout: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []

    for line in stdout.splitlines():
        line = line.strip()
        if not line or "\t" not in line:
            continue

        parts = line.split("\t")
        if len(parts) != 4:
            continue

        score_text = parts[3].strip()
        try:
            score = float(score_text)
        except ValueError:
            continue

        rows.append(
            {
                "tune_id": strip_debug_quotes(parts[0].strip()),
                "score": score,
            }
        )

    return rows


def strip_debug_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == '"' and value[-1] == '"':
        return value[1:-1]
    return value


def write_result_json(payload: dict[str, Any]) -> Path:
    filename = f"{payload['commit']}_{payload['date'].replace('-', '')}.json"
    output_path = REPO_ROOT / RESULTS_DIR_RELATIVE / filename
    output_path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote benchmark results to {output_path}", file=sys.stderr)
    return output_path


def generate_report() -> None:
    ensure_results_dir()
    runs = load_all_result_runs()
    tune_registry = load_tune_registry_for_report(runs)

    lines = [
        "# Benchmarks",
        "",
        "## Summary Table",
        "",
    ]

    if runs:
        lines.extend(
            [
                "| Version | Date | Dataset (SHA prefix) | Detected | Avg score |",
                "| --- | --- | --- | --- | --- |",
            ]
        )
        for run in runs:
            detected_count = sum(1 for result in run["results"] if result.get("detected"))
            total_count = len(run["results"])
            scores = [
                result["score"]
                for result in run["results"]
                if result.get("score") is not None
            ]
            avg_score = f"{sum(scores) / len(scores):.3f}" if scores else "—"
            version = f"`{run['commit']}` {truncate_commit_message(run['commit_message'])}"
            lines.append(
                "| {version} | {date} | `{dataset}` | {detected} | {avg_score} |".format(
                    version=escape_markdown_cell(version),
                    date=run["date"],
                    dataset=run["dataset_sha256"][:12],
                    detected=f"{detected_count}/{total_count}",
                    avg_score=avg_score,
                )
            )
    else:
        lines.append("No benchmark results found.")

    lines.extend(
        [
            "",
            "## Per-Tune Scores",
            "",
        ]
    )

    if runs and tune_registry:
        header = ["Tune", "Expected tune IDs", *[f"`{run['commit']}`" for run in runs]]
        lines.append("| " + " | ".join(header) + " |")
        lines.append("| " + " | ".join(["---"] * len(header)) + " |")

        for tune in tune_registry:
            row = [
                escape_markdown_cell(tune["label"]),
                escape_markdown_cell(", ".join(tune["expected_tune_ids"])),
            ]
            for run in runs:
                result = find_tune_result(run["results"], tune["wav"])
                row.append(format_score_cell(result))
            lines.append("| " + " | ".join(row) + " |")
    elif not runs:
        lines.append("No benchmark results found.")
    else:
        lines.append("No tune registry found for report generation.")

    report_path = REPO_ROOT / REPORT_RELATIVE
    report_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote benchmark report to {report_path}", file=sys.stderr)


def load_all_result_runs() -> list[dict[str, Any]]:
    runs: list[dict[str, Any]] = []
    for path in sorted((REPO_ROOT / RESULTS_DIR_RELATIVE).glob("*.json")):
        payload = load_json(path)
        payload["_path"] = path.name
        runs.append(payload)

    runs.sort(key=lambda item: (item["date"], item["commit"], item["_path"]))
    return runs


def load_tune_registry_for_report(runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    registry_path = REPO_ROOT / TUNE_REGISTRY_RELATIVE
    if registry_path.exists():
        return load_json(registry_path)

    seen: set[str] = set()
    tunes: list[dict[str, Any]] = []
    for run in runs:
        for result in run["results"]:
            if result["wav"] in seen:
                continue
            seen.add(result["wav"])
            tunes.append(
                {
                    "wav": result["wav"],
                    "label": result["label"],
                    "expected_tune_ids": result["expected_tune_ids"],
                }
            )
    return tunes


def find_tune_result(results: list[dict[str, Any]], wav_name: str) -> dict[str, Any] | None:
    for result in results:
        if result.get("wav") == wav_name:
            return result
    return None


def format_score_cell(result: dict[str, Any] | None) -> str:
    if not result or not result.get("detected"):
        return "—"

    score = result.get("score")
    rank = result.get("rank")
    if score is None or rank is None:
        return "—"
    return f"{score:.3f} #{rank}"


def truncate_commit_message(message: str, limit: int = 40) -> str:
    message = " ".join(message.split())
    if len(message) <= limit:
        return message
    return message[: limit - 3].rstrip() + "..."


def escape_markdown_cell(value: str) -> str:
    return value.replace("\\", "\\\\").replace("|", "\\|").replace("\n", " ")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ensure_results_dir() -> None:
    (REPO_ROOT / RESULTS_DIR_RELATIVE).mkdir(parents=True, exist_ok=True)


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def cleanup_worktree(worktree_root: Path, missing_ok: bool = False) -> None:
    if missing_ok and not worktree_root.exists():
        return

    subprocess.run(
        ["git", "worktree", "remove", "--force", str(worktree_root)],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )

    if worktree_root.exists():
        shutil.rmtree(worktree_root, ignore_errors=True)


def run_command(
    command: list[str],
    cwd: Path,
    capture_output: bool = False,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        command,
        cwd=cwd,
        capture_output=capture_output,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip() or "command failed"
        fatal(f"Command failed in {cwd}: {' '.join(command)}\n{message}")
    return result


def fatal(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


if __name__ == "__main__":
    raise SystemExit(main())
