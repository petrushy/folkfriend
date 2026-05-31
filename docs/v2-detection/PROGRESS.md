# Tune Detection v2.0 — Progress Log

Living scratchpad so work can resume after an interruption. Newest findings at
the top of each section. Full design: `~/.claude/plans/how-can-tune-detection-whimsical-cascade.md`.

## Goal (recap)

Replace the hand-tuned DSP transcription front-end (audio → contour) with a
small, bundled, **offline** ML model that is robust to polyphony, percussive
attacks, and fast/repeated notes (the banjo-session failure). Keep the existing
contour representation + tune index + query backend (heuristic + Needleman-
Wunsch) unchanged. Model runs in **one Rust codebase** compiling to native (for
the `scripts/run_benchmark.py` CLI harness + `cargo test`) and `wasm32` (browser
worker).

## Status

- **Phase 0 (decoder bug fixes):** attempted, REVERTED. The Viterbi-backtrace and
  pitch-model fixes are correct but expose harmonic leakage in the monophonic
  decoder (high-pitch octave artifacts), redistributing match scores (17/30 up,
  11/30 down) with no detection regression. Folded into v2.0. See plan file.
- **Phase 1 (model + runtime feasibility spike):** ✅ DONE — verdict **GO** on the
  tract single-codebase approach. All gates passed (see verdict below).
- **Phase 2 (MlTranscriber):** NOT STARTED ← next. Blocked on obtaining the real
  basic-pitch model in ONNX (needs a TF env — see "Model acquisition friction").

## Phase 1 verdict: GO (tract, single codebase)

| Gate | Result |
|------|--------|
| 1. tract → wasm32 compiles | ✅ (needs `getrandom`/`js` feature) |
| 2. model size | ✅ representative 227 KB; real basic-pitch TBD (likely a few MB) |
| 3. op coverage (Conv2D/BN/ReLU/Sigmoid/multi-head) | ✅ matches onnxruntime to 1e-7 |
| 4. latency native / wasm | ✅ 59 ms / 328 ms per inference (budget <~2 s) |

Extra data: wasm binary (tract + a main) = **12.7 MB raw, 2.5 MB gzipped**. The
real integration adds tract to the existing ~446 KB folkfriend wasm, so expect a
multi-MB bundle growth → enable `wasm-opt` (currently off in `rust/Cargo.toml`)
and budget for it. Model loads + optimizes in ~6–7 ms.

### Next steps (Phase 2 entry)

1. **Get the real basic-pitch model as ONNX** — pick one:
   - (a) make a py3.11 conda env, `pip install basic-pitch tf2onnx`, convert the
     bundled TF SavedModel once, commit the ONNX under `rust/models/`;
   - (b) source a pre-converted ONNX from a reputable repo;
   - (c) dual-runtime pivot (drop tract) — only if (a)/(b) fail.
2. **Validate tract op coverage on the REAL model** (harmonic stacking, any
   CQT-in-graph ops) — re-run the `spikes/tract-wasm` runner against it.
3. **Port the HCQT front-end to Rust** (reuse `rust/src/feature/` FFT + window;
   `interpolate.rs` for log-freq bins) OR confirm the model ingests raw audio.
4. Then build `MlTranscriber` behind the `Transcriber` trait (plan Phase 2).

## Phase 2 reference — basic-pitch note-creation (to port to Rust)

Constants (`basic_pitch/constants.py`): `AUDIO_SAMPLE_RATE=22050`, `FFT_HOP=256`,
`ANNOTATIONS_FPS=86`, window `AUDIO_N_SAMPLES=43844` (~2 s) → `ANNOT_N_FRAMES=172`.
Note bins: 88 @ 1/semitone, bin i → MIDI `i + 21` (A0). Contour bins: 264 @
3/semitone. `MIDI_OFFSET=21`, `MAX_FREQ_IDX=87`.

Decode defaults (`inference.py`): `onset_thresh=0.5`, `frame_thresh=0.3`,
`min_note_len=11` frames (=round(127.7ms·86/1000)), `infer_onsets=True`,
`melodia_trick=True`, `energy_tol=11`.

`output_to_notes_polyphonic(frames[T,88], onsets[T,88])` →
list of `(start_frame, end_frame, pitch_midi, amplitude)`:
1. `constrain_frequency`: zero bins outside [min,max] freq (we can skip / set to
   folkfriend's MIDI 48–95 range).
2. `infer_onsets`: `frame_diff = min over n∈{1,2} of (frames[t]-frames[t-n])`,
   clamp≥0, rescale to onsets' max, `onsets = max(onsets, frame_diff)`.
3. onset peaks = local maxima in time (`argrelmax`) ≥ `onset_thresh`.
4. iterate onsets backwards in time; from each, walk forward while
   `remaining_energy[i,f] ≥ frame_thresh` (allow `energy_tol` dips); emit note if
   length > `min_note_len`; zero used energy at f and f±1.
5. melodia_trick: while `max(remaining_energy) > frame_thresh`, pick argmax,
   expand fwd+back the same way, emit note.

For FolkFriend we then need MONOPHONIC melody: per frame pick the dominant
sounding note (highest amplitude active note), build a pitch-per-frame sequence,
then feed the existing tempo quantiser. Longer audio: window into 43844-sample
chunks (basic-pitch overlaps by 30 frames, trims 15 each side via
`unwrap_output`) and concat frames; first cut can use simple non-overlap windows.

## Phase 2 increments (keep build green + benchmarkable at each)

- **A. tract into main crate** — ✅ DONE. Added `tract-onnx` + the wasm
  `getrandom` `js` feature to `rust/Cargo.toml`; had to `cargo update -p
  num-traits` (0.2.15→0.2.19) — tract's `half` needs `FromBytes`/`ToBytes`.
  New `rust/src/decode/ml.rs`: embeds `models/nmp.onnx` via `include_bytes!`,
  `BasicPitch::new()` + `run_window(&[f32;43844]) -> {note,onset,contour}`.
  Unit test on silence passes; full suite still 19+1 green; wasm32 cdylib builds.
  NOTE: current folkfriend.wasm is only 0.7 MB because tract is dead-code-
  eliminated (not yet called from an exported fn) — real size impact comes in 2E.
  Output order pinned as [0]=onset, [1]=note, [2]=contour (verify in 2C).
- **B. audio prep** — ✅ DONE. `resample_linear` (linear interp; fundamentals ≪
  11 kHz Nyquist so fine for now) + `BasicPitch::transcribe(pcm, src_rate)` which
  front-pads, runs overlapping 43844-windows (hop 36164, 30-frame overlap),
  trims 15 frames/side and stitches → `Posteriorgrams{note,onset,contour,
  n_frames}`. Test `detects_a4_tone`: a synthesized 440 Hz tone @ 48 kHz peaks at
  the A4 note bin (MIDI 69) — validates resample+window+model+bin-mapping E2E.
- **C. note-creation port** — ✅ DONE. `rust/src/decode/note_events.rs`:
  `output_to_notes` ports `output_to_notes_polyphonic` + `get_infered_onsets` +
  the melodia trick (defaults onset 0.5 / frame 0.3 / min_note_len 11 /
  energy_tol 11). Tests: single-note, two-sequential-notes, short-note-drop, and
  an end-to-end `a4_tone_yields_a4_notes` (real model → 1 A4 note).
  Python spot-check on the A4 tone: python found 2 notes [69, 88], rust found 1
  [69]. MIDI 88 = the synth's 3rd harmonic (1320 Hz E6); the diff is resampling
  (linear vs soxr) on a weak harmonic, not a port bug — and monophonic melody
  selection (2D) discards it anyway. NOTE: python needs `setuptools<81` in the
  conda env (resampy uses pkg_resources, removed in setuptools 81). Decisive
  validation of the port is the 2E benchmark, not the synthetic tone.
- **D. melody select + contour** — ✅ DONE. `note_events::notes_to_melody`:
  per-frame loudest active note → monophonic line, onset-preserving segmentation
  (repeated picked notes stay split), octave-folded into MIDI 48–95. Refactored
  `contour.rs` to expose `contour_from_notes_fps(notes, frames_per_sec)` +
  `Note::new` (pub(crate)) so the ML path (≈86 fps) reuses the SAME tuned tempo
  quantiser as the DSP path (≈46 fps). `BasicPitch::transcribe_contour(pcm,
  src_rate)` ties it together → octave-correct → `ContourString`.
  Test `ascending_melody_contour`: synth G4-A4-B4-C5-D5 → contour `tvxyA` =
  pitches [67,69,71,72,74] EXACTLY. DSP path unchanged (19 integration tests
  green). NOTE: a single sustained note returns Err (quantiser needs >3 notes,
  same as DSP) — fine for real tunes.
- **E. Transcriber trait + wiring** — ✅ DONE (opt-in setting). CLI A/B +
  app wiring complete.
  - `bin.rs`: `FF_TRANSCRIBER=ml` env switch (built once, shared across rayon
    workers — `BasicPitch` is Sync).
  - `lib.rs`: `FolkFriend` gains an ML mode — `set_use_ml(bool)` (lazy model
    build, DSP fallback), raw-PCM accumulation, and `transcribe_pcm_buffer`
    routes to the ML pipeline when enabled. Exposed on WASM as `set_use_ml`.
    (No separate `Transcriber` trait — the in-struct branch was simpler and the
    DSP path is fully preserved.)
  - App: `worker.setUseMlTranscriber` → `backend.setUseMlTranscriber` (pushed on
    startup in `setupTuneIndex` + on toggle), `store` default
    `useMlTranscriber:false`, Settings.vue toggle ("Experimental: ML
    transcription"). Mode is set before any PCM feed (event-driven, not
    per-recording) because the feed path branches on it.
  - WASM rebuilt with tract reachable: **11.3 MB raw / 2.4 MB gzip** (model
    embedded via `include_bytes!`, so Workbox precaches it with the wasm → works
    offline). App production build passes.
  - **How to try it:** Settings → enable "Experimental: ML transcription", then
    record. DSP remains the default.

## A/B benchmark result (2026-05-31) — ML not yet a clean-audio win

`python3 scripts/run_benchmark.py` (DSP) vs `FF_TRANSCRIBER=ml … run_benchmark.py`:

- **DSP 30/30 detected. ML 25/30** (lost: wise_maid, gazaremsan, äppelbo,
  calums_road rank 7, sally_garden).
- **Expected**: the benchmark is all clean *solo* recordings — exactly where the
  hand-tuned DSP path is strong and where ML's polyphony/percussion advantage is
  invisible. The banjo/session case (the actual goal) is NOT in this benchmark.
- **Diagnosis** (wise_maid): ML contour `AEEFChhz...` vs DSP `vAEHEFECAxAz...` —
  ML **jumps octaves** (loud harmonics briefly win a frame). `notes_to_melody`
  uses loudest-active-note; needs **melody continuity** (prefer the note nearest
  the running pitch / penalize octave jumps) + better octave handling. Concrete
  tuning lever, not a structural flaw. Pipeline is functional end-to-end.

### Octave fixes (2026-05-31) — ML 27 → 28/30 ✅
- **Fold-bounds bug:** `fold_into_range` now folds at `<=48`/`>=95` (open
  interval, → [49,94]) to match the dataset's `rel_pitch` exactly — the ML path
  no longer emits boundary chars ('a'/'V') that no stored contour contains.
  (Correctness; no benchmark change — boundary pitches are rare.)
- **Octave-stable melody selection:** seed the running pitch from the
  amplitude-weighted mean of the *loudest note per frame* (not all candidates,
  which low-octave artifacts dragged down) + slow the EMA to 0.92/0.08 so brief
  low excursions are penalised instead of pulling the reference down. Recovered
  calums_road → **28/30** (remaining misses: gazaremsan, äppelbo — weak for DSP
  too). Sustained low runs persist only in melody *gaps* (low note is the sole
  candidate); doesn't affect ranking. WASM rebuilt + copied to app.

### Diagnosis: is the dataset filtering a factor? (answered 2026-05-31)
The stored contours are processed (chord/grace strip, 1 char/quaver via
`to_midi_contour`, octave-fold) and calibrated for the DSP path. But a length
diagnostic (Cooley's: DSP-audio 70, ML-audio 62, stored 256) shows it's NOT a
gross density mismatch — NW is semi-global, aligning the short audio fragment to
the best window of the full stored tune. The residual ML gap is transcription-
side (octave excursions), not dataset-side. Only real dataset-alignment issue
was the fold-bounds bug above (now fixed).

### Tuning (option 1, 2026-05-31) — melody continuity ✅
`notes_to_melody` now seeds a running pitch (amplitude-weighted mean) and selects
per frame by `amplitude - JUMP_PENALTY·octaves_from_running` with an EMA update,
suppressing brief loud harmonics. Penalty sweep: 0.4 → 26/30, **0.25 → 27/30**
(kept 0.25). Remaining misses: gazaremsan, äppelbo, calums_road (all weak for DSP
too). Not chasing the last 3 on clean audio (overfit risk; real goal is banjo).

### Decision point / next options
1. **Tune ML melody selection** (continuity/octave smoothing, thresholds) to
   recover clean-audio parity, re-A/B.
2. **Wire ML as opt-in** in the app (keep DSP default) so the real banjo/session
   case can finally be tested — the only way to validate the actual goal.
3. **Capture a banjo/session test WAV** + add to `rust/bench/tunes.json` so "more
   robust" becomes measurable. (Still the highest-leverage missing piece.)

## Reproduce the spike

```sh
cd spikes
.venv/bin/python gen_model.py            # regenerate model.onnx + ref data
cd tract-wasm
cargo run --release --bin spike          # native latency + correctness
# wasm latency:
cargo build --release --bin spike --target wasm32-wasip1
wasmtime run --dir=. target/wasm32-wasip1/release/spike.wasm
```

`spikes/` is throwaway (gitignored). `.venv` is large (torch); safe to delete.

## Environment (verified 2026-05-31)

- rustc 1.95.0 (Homebrew). `wasm32-unknown-unknown` target installed.
- crates.io + general network reachable.
- Main crate `rust/Cargo.toml` has NO `[workspace]`, so a sibling spike crate is
  isolated and won't perturb the main build.

## Decisions / open questions

- **Runtime:** primary = `tract` (pure-Rust ONNX, native + wasm one codebase).
  Fallbacks if tract-wasm is infeasible: CREPE-tiny (simpler model) or dual
  runtime (onnxruntime-web in browser + `ort` in CLI).
- **Model:** primary = Spotify **basic-pitch** (polyphonic, onset-aware note
  events). Fallback = CREPE-tiny (monophonic f0, raw-audio input, trivial
  front-end).

## Phase 1 plan (spike — answer these gates in order)

1. **Does `tract-onnx` compile to `wasm32-unknown-unknown` at all?** Make-or-break
   for the single-codebase approach. Test in an isolated spike crate.
2. **Model acquisition + size:** get basic-pitch ONNX, measure size (budget: a
   few MB, likely needs int8 quantisation).
3. **Op coverage:** can tract load + run the model natively?
4. **Latency:** native + rough wasm estimate. Live mode needs < ~2 s/window.

## Findings log

- (2026-05-31) **REAL-MODEL RUNTIME GATE PASSED ✅✅ — tract runs the actual
  basic-pitch `nmp.onnx`, native AND wasm, matching onnxruntime.** This closes
  the dominant project risk.
  - Native: load+optimize 44 ms; **49 ms/inference**; all 3 heads match
    onnxruntime to **7.7e-7**.
  - Wasm (wasm32-wasip1 / wasmtime): **152 ms/inference**; match **7.9e-6**.
    (Faster than the synthetic spike — the real model is leaner.)
  - tract handles every op incl. the in-graph CQT, harmonic stacking, and the
    log-mag normalization (Where/Equal/ReduceMin/Max). No unsupported ops.
  - Model copied to `rust/models/nmp.onnx` (225 KB) and `spikes/tract-wasm/`.
    Needed `with_input_fact(0, f32::fact([1,43844,1]))` to pin the symbolic batch
    dim before `into_optimized()`. Reference gen: `spikes/gen_ref_real.py`.
  - **Verdict: GO. Phase 1 + the Phase-2 real-model op-coverage gate are DONE.**
    Remaining Phase 2 = pure engineering (no more runtime unknowns): integrate
    tract into the main crate, audio resample→22050, port basic-pitch
    `note_creation`, melody-select → reuse tempo quantisation → contour.
- (2026-05-31) **REAL MODEL IS ALREADY ONNX — no TF conversion needed. 🎉**
  The official ICASSP-2022 model ships as `nmp.onnx` inside the `basic-pitch`
  pip package (`.../basic_pitch/saved_models/icassp_2022/nmp.onnx`), **225 KB,
  opset 15**. (The py3.11 conda env `ff-basicpitch` was created to convert via
  TF, but the ONNX was bundled all along — env still useful as a reference
  runtime + for `note_creation` porting.)
  - **Input:** `serving_default_input_2:0` `[batch, 43844, 1]` — **raw audio**
    @ 22050 Hz (~2 s). CQT + harmonic stacking are **in-graph** ⇒ **NO Rust HCQT
    front-end to port.** Front-end = just resample to 22050 mono + 43844 window.
  - **Outputs:** note `[b,172,88]`, onset `[b,172,88]`, contour `[b,172,264]`.
  - **Ops (248 nodes):** Conv×32, Reshape×67, Unsqueeze×37, Pad×24, Transpose×21,
    Concat×20, Slice×11, Neg×9, Mul×6, Cast×3, Relu×3, Sigmoid×3, Add×2,
    ReduceSum/Min/Max, Sqrt, Log, Div, Sub, Equal, Where, Shape — all standard
    ONNX. High confidence tract loads it (to be validated next).
  - Impact: Phase 2 front-end work collapses to audio resampling. int8
    quantisation unnecessary (already 225 KB).
- (2026-05-31) **GATE 3 PASSED ✅ + GATE 4 native PASSED ✅ — tract runs a
  basic-pitch-class CNN, correctly and fast.**
  - Built a representative model (NOT real basic-pitch): harmonic-CQT input
    `[1, 8, 172, 264]`, Conv2D + BatchNorm + ReLU stack, 3 sigmoid heads
    (contour/note/onset). 57k params, **227 KB** ONNX (opset 13). Generator:
    `spikes/gen_model.py`; tract runner: `spikes/tract-wasm/src/main.rs`.
  - tract output matches onnxruntime to **max_abs_diff 1.8e-7** — op coverage
    for Conv2D/BatchNorm/ReLU/Sigmoid/multi-head is solid.
  - **Native latency: tract 58.9 ms/inference** (onnxruntime 16.6 ms). tract is
    ~3.5× slower than ORT but 59 ms is far under the live budget (<~2 s/window).
    Model load+optimize: 7.2 ms.
  - Caveat: this validates the op *families* + scale, NOT basic-pitch's exact
    ops (esp. harmonic stacking / any CQT-in-graph). Real-model op coverage is a
    separate task gated on obtaining the converted ONNX.
- (2026-05-31) **Model acquisition friction (important).** Local Python is 3.14;
  TensorFlow (needed to convert the official basic-pitch TF model → ONNX) has no
  3.14 wheel, so the real model can't be converted here without a py3.10/3.11
  env + heavy TF install. `onnx`/`onnxruntime`/`torch` DO have 3.14 wheels
  (installed in throwaway `spikes/.venv`). Options for the real model: (a) make a
  py3.11 conda env, `pip install basic-pitch tf2onnx`, convert once; (b) find a
  pre-converted ONNX from a reputable source; (c) dual-runtime pivot
  (basic-pitch TF.js in browser + Python basic-pitch in CLI) — avoids tract.
- (2026-05-31) **GATE 1 PASSED ✅ — tract compiles to wasm32.** `tract-onnx`
  0.21.15 builds for both native and `wasm32-unknown-unknown`. The single-
  codebase (native + wasm) approach is viable.
  - One required workaround: tract pulls `getrandom 0.2` transitively, which
    needs its `js` feature on wasm. Fixed via a `[target.'cfg(target_arch =
    "wasm32")'.dependencies]` entry: `getrandom = { version = "0.2", features =
    ["js"] }`. Carry this into the main `rust/Cargo.toml` when integrating.
  - Dep tree is sizeable (tract-linalg/core/nnef/hir/onnx-opl/onnx + rand,
    liquid templating). Native cold build ~35 s. Need to measure final wasm
    binary size impact during integration.
- (2026-05-31) Phase 1 started. Spike crate location: `spikes/tract-wasm/`.
