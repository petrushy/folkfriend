# FolkFriend Contour Algorithm

This document describes end-to-end how a tune's ABC notation becomes a searchable
contour string in the index, and how a user's hummed/played audio is matched against
that index at query time.

---

## 1. The Contour Representation

A **contour** is a compact ASCII string representing the sequence of pitched notes in
a tune, quantised to eighth notes (quavers) and mapped to relative MIDI pitch values.

### Pitch encoding

The MIDI pitch range used is **48–95** (C3–B6).  Notes outside this range are
octave-shifted into it before encoding.  Each MIDI pitch offset from 48 maps to one
ASCII character using Python's `string.ascii_letters[:48]`:

```
MIDI 48 (C3) → 'a'
MIDI 49 (C#3) → 'b'
...
MIDI 73 (C#5) → 'z'
MIDI 74 (D5) → 'A'
...
MIDI 95 (B6) → 'X'
```

So `v` = MIDI 69 = A4 (concert A).  The encoding is relative to the chromatic scale;
key/mode are discarded.  This makes the search key-independent.

### Duration encoding

Each quaver (eighth note) of a note produces **one character**.  A dotted quarter
note (= 1.5 quavers) rounds to 2 characters; a sixteenth note rounds to 1.  The
contour of `|A2 B2 c2|` in 4/4 time would be something like `AABBcc` (each note 2
quavers).

This means the contour string length is roughly proportional to the total duration
of the tune in eighth notes.

---

## 2. Build-Time Pipeline: ABC → Contour

Runs in `folkfriend-app-data/build/src/`.

```
ABC text
   │
   ├─ Strip string chord symbols   "D", "Am", "A7", …
   │    abc2midi renders these as real MIDI on a second channel;
   │    reading all channels contaminates the melody.
   │
   ├─ Strip bracket chord notes    [CEG] → C  (keep first note only)
   │    31% of folkwiki settings use these; abc2midi plays all voices,
   │    inserting extra notes between main melody pitches.
   │
   ├─ abc2midi                      ABC text → MIDI file
   │    Uses the tune's M: (meter) and K: (key) from the ABC header.
   │    L: (default note length) affects duration calculation.
   │
   ├─ py-midicsv                    MIDI file → CSV event list
   │
   └─ CSVMidiNoteReader.to_midi_contour()
        Reads Note_on / Note_off pairs from MIDI channel 1,
        quantises each note to the nearest quaver multiple,
        maps each quaver unit to one contour character.
```

### Quantisation detail (`midi.py` `to_midi_contour`)

The function maintains two clocks:

- `music_time` — elapsed time of the actual note sequence
- `output_time` — elapsed time of the contour as written so far

For each note:
1. Advance `music_time` by the note's real duration.
2. Compute `rel_duration = note.duration / quaver_duration`.
3. If `music_time ≤ output_time` (output is ahead — the previous note was rounded up
   and "ate into" this note's slot): emit this note as **one quaver** regardless.
   This is critical for preserving **passing notes** in dotted-rhythm patterns like
   `A>B` where B is very short.  Dropping passing notes causes stored contours to
   diverge from audio-transcribed contours, which always retain them.
4. Otherwise: round to the nearest integer number of quavers (ceil if music is
   behind, floor if music is ahead) and emit that many copies of the character.

### Folkwiki-specific note

Folkwiki ABC files sometimes use `L:1/16` (default note = semiquaver) while TheSession
always uses `L:1/8`.  abc2midi respects the `L:` field, so the resulting MIDI note
durations are correct regardless.  The quantisation step is therefore
representation-independent — a quarter note is always 2 quaver characters whether it
was written `A2` with `L:1/8` or `A4` with `L:1/16`.

---

## 3. Query-Time Pipeline: Audio → Contour

Runs in the browser, inside the WASM module.

```
Microphone PCM (mono, 44.1 or 48 kHz)
   │
   ├─ Windowed autocorrelation FFT (frame by frame)
   │    Window size: ff_config::SPEC_WINDOW_SIZE samples
   │    Produces a "pseudo-spectrogram" of pitch-vs-time frames.
   │
   ├─ Viterbi lattice decode
   │    Finds the most likely pitch path through the frames,
   │    emitting silence tokens for frames with no clear pitch.
   │
   └─ Contour extraction
        Pitch tokens are mapped to contour characters using the same
        MIDI-to-char encoding as the build-time pipeline.
        Each non-silent frame produces one character (1 char ≈ 1 quaver).
```

The audio path always produces **one character per detected note** — it has no
concept of note duration, only pitch sequence.  This matches the stored contours
because the quantisation step also reduces everything to quaver-granularity.

---

## 4. Search Algorithm: Two-Pass Retrieval

Implemented in `folkfriend/rust/src/query/`.

### Pass 1 — Heuristic n-gram filter (`heuristic.rs`)

**Goal:** quickly reduce ~60 k settings to a shortlist of ~2000 candidates.

1. **Run-deduplication (`dedup_runs`):** collapse consecutive identical characters in
   both query and each stored contour before n-gram matching.
   `"vvvvsss" → "vs"`.
   This bridges a length-density mismatch: some folkwiki stored contours encode long
   notes as repeated characters (e.g. `vvvv` for a dotted quarter) while the audio
   query always emits one character per note.  Without deduplication, most folkwiki
   n-grams would simply not appear in the query, tanking their heuristic rank.

2. **Query n-gram deduplication:** extract overlapping 4-grams from the
   run-deduplicated query, then deduplicate them.  A pattern appearing 10 times in a
   repetitive query must not be counted 10× per candidate.

3. **Aho-Corasick scan:** build an automaton from the deduplicated query n-grams and
   scan every candidate contour.  For each candidate, count how many **distinct**
   query patterns appear (not raw overlapping match count).

   *Why distinct?*  Raw overlap counts reward long or repetitive stored contours
   disproportionately.  With distinct counts, the maximum score equals the total
   number of unique query patterns — achieved only by an exact match.  Before this
   fix, exact self-match ranked at #94; after, it ranks #1.

4. Sort candidates descending by distinct-pattern count; keep top 2000.

### Pass 2 — Needleman-Wunsch alignment (`nw.rs`, `mod.rs`)

**Goal:** accurately score and rank the 2000 heuristic candidates.

1. Score each candidate with Needleman-Wunsch (NW) global sequence alignment:
   - Match: +2
   - Mismatch: −2
   - Gap: −1

2. The implementation is **semi-global**: the shorter string (usually the audio
   query) is aligned against any substring of the longer string (stored contour).
   Free gaps at the start and end of the longer string mean the query does not need
   to cover the whole stored contour — it finds the best-matching segment.

3. Score is normalised by the shorter string's length:
   `score = 0.5 × raw_score / shorter_length`
   Maximum possible score is 1.0 (perfect match of the entire query).

4. **Raw contours are used** — `dedup_runs` is NOT applied here.  The heuristic
   uses deduplication purely as a discovery aid; the NW score should reflect actual
   note-by-note similarity.  Applying `dedup_runs` to both sides inflates all NW
   scores (shorter strings reach the ceiling more easily), which caused too many
   unrelated tunes to exceed the "Very Close" display threshold.

5. Sort by NW score descending.  Deduplicate by `tune_id` (keep highest-scoring
   setting per tune).  Return top 100.

### Score thresholds (app display)

The app maps NW scores to labels:

| Score | Label |
|---|---|
| ≥ 0.65 | Very Close |
| ≥ 0.45 | Close |
| < 0.45 | Partial |

---

## 5. Known Limitations

### Folkwiki scores tend to be lower than TheSession scores

For the same recording quality, folkwiki tunes typically score 0.35–0.78 vs 0.60–0.90
for TheSession tunes.  Causes:

- **Notation complexity:** folkwiki ABC uses ratio tuplets (`(3:2:4`), broken rhythm
  (`>`), and multi-voice chords that abc2midi may render differently from how a player
  performs the tune.
- **Heavy ornamentation:** Swedish folk style includes many grace notes and trills
  written explicitly in the ABC.  abc2midi renders them as brief MIDI notes that
  appear in the stored contour; the audio pitch detector does not resolve them as
  separate pitches, so the stored contour has extra notes that audio never produces.
- **ABC quality variance:** some folkwiki files have structural issues (e.g. bare
  `K:` lines mid-body) that cause abc2midi to mis-render sections.

### Bracket chord stripping (applied)

31% of folkwiki settings use ABC bracket chord notation `[CEG]`.  abc2midi plays all
voiced notes simultaneously on the same MIDI channel; `CSVMidiNoteReader` reads them
as sequential notes, inserting extra pitches into the stored contour.  The pipeline
now strips bracket chords to their first note before calling abc2midi.  This reduces
stored contour length for affected settings but does not always improve NW scores
because the NW semi-global aligner already finds the best window past scattered extra
notes.

---

## 6. Integration Tests

`folkfriend/rust/tests/integration_tests.rs` contains:

- **`heuristic_self_match_ranks_first`** — the stored contour of two known folkwiki
  settings must rank in the top 2 when used as a query.
- **`thesession_self_match_ranks_first`** — four well-known TheSession tunes must
  rank in the top 3 on self-query.
- **Audio detection tests** — real WAV recordings (in `rust/wavs/`) must detect the
  correct tune within a given rank threshold and must not drop below 99% of the
  baseline NW score.  WAV files must be mono or will be mixed down by the test helper.

Baseline scores are recorded in comments next to each `min_score` argument; update
them intentionally when the algorithm or dataset improves.
