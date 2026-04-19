# Upstream comparison: score changes and their causes

## Summary

Comparing `TomWyllie/folkfriend @ d1faa84` (upstream) against this fork on 22
Celtic (thesession) test WAVs:

| Version | Detected | Avg score |
|---|---|---|
| Upstream `d1faa84` | 20 / 22 | 0.716 |
| This fork (current) | 22 / 22 | — |

Two tunes undetected in the upstream are now rank #1 here: **Calum's Road** and
**John Ryan's**. Several other tunes improved rank (#2 → #1) or score. A handful
of tunes show small score regressions (−0.007 to −0.041) while remaining at rank #1.

## Per-tune delta

| Tune | Upstream | Fork | Δ |
|---|---|---|---|
| Cooley's Reel | 0.632 #1 | 0.604 #1 | −0.028 |
| The Wise Maid | 0.578 #1 | 0.578 #1 | 0.000 |
| The Salamanca | 0.691 #1 | 0.698 #1 | +0.006 |
| The Salamanca (rec. 2) | 0.656 #1 | 0.621 #1 | −0.035 |
| The Hut on Staffin Island | 0.849 #1 | 0.825 #1 | −0.024 |
| I the Glen Cottage | 0.616 **#2** | 0.767 **#1** | +0.151 |
| Soup Dragon | 0.686 #1 | 0.686 #1 | 0.000 |
| The Blarney Pilgrim | 0.800 #1 | 0.800 #1 | 0.000 |
| The Mist Covered Mountain | 0.914 #1 | 0.900 #1 | −0.014 |
| The Windbroke | 0.797 #1 | 0.797 #1 | 0.000 |
| The Banks of Lough Gowna | 0.758 #1 | 0.750 #1 | −0.008 |
| Calum's Road | **not detected** | 0.875 #1 | +∞ |
| The Cup of Tea | 0.750 #1 | 0.750 #1 | 0.000 |
| John Brosnan's | 0.604 #1 | 0.604 #1 | 0.000 |
| John Ryan's | **not detected** | 0.830 #1 | +∞ |
| The Killavil Jig | 0.742 #1 | 0.735 #1 | −0.008 |
| Maggie in the Woods | 0.449 **#4** | 0.610 **#1** | +0.161 |
| Down by the Sally Gardens | 0.799 #1 | 0.815 #1 | +0.016 |
| The Banshee | 0.683 #1 | 0.683 #1 | 0.000 |
| The Galway Belle | 0.888 #1 | 0.847 #1 | −0.041 |
| The Glenside | 0.619 **#2** | 0.686 **#1** | +0.068 |
| The Lilting Banshee | 0.814 #1 | 0.814 #1 | 0.000 |

---

## Two roots of the changes

### 1. Heuristic: `dedup_runs` + distinct n-gram counting

**What changed** (`rust/src/query/heuristic.rs`):

The upstream heuristic does a raw overlapping n-gram count over each stored
contour as-is. This fork adds two things:

- **`dedup_runs`**: collapses consecutive identical characters (`vvvt` → `vt`)
  in both the query and every stored contour before n-gram matching. Required for
  folkwiki tunes, which use `L:1/16` (4 chars per note in stored contours) vs
  audio queries (always 1 char per detected note). Also applied to thesession
  tunes for consistency.

- **Distinct n-gram counting**: instead of counting raw overlapping match
  occurrences, counts the number of *unique query patterns* matched per
  candidate (via `HashSet<usize>` over `m.pattern()`). The raw count rewarded
  long or repetitive stored contours disproportionately — before this fix an
  exact self-match for some folkwiki tunes ranked as low as #94, well outside
  the 2000-candidate NW cutoff.

**Effect on scores**: these changes affect *which candidates reach the NW
second pass*, not the NW scores themselves. They are why **Calum's Road** and
**John Ryan's** went from undetected to rank #1 — they were previously filtered
out before NW ever ran. Similarly, **I the Glen Cottage** (#2 → #1) and
**Maggie in the Woods** (#4 → #1) moved up because competing candidates no
longer get inflated heuristic scores.

### 2. Data pipeline: three changes that altered stored contours

The NW score is `0.5 × raw_alignment / len(audio_query)`. The audio query
(the recording) is fixed. What changed is the **stored contours** in the
dataset, rebuilt with three pipeline fixes.

#### a) Passing note dropout fix — primary cause of regressions

**File**: `folkfriend-app-data/build/src/midi.py`, `to_midi_contour()`

Before:
```python
if music_time <= output_time:
    continue   # passing note silently dropped
```

After:
```python
if music_time <= output_time:
    output_time += quaver_duration
    midi_contour.append(note.rel_pitch())  # passing note always kept
```

In tunes with dotted-rhythm patterns (`A>B`, `A>G`) — extremely common in
Celtic music — the short note after the dot would sometimes be dropped when the
quantiser clock overshot (i.e. the preceding dotted note was rounded up, pushing
`output_time` past the short note's end). The fix always emits that note as one
quaver.

This makes stored contours **slightly longer** and shifts note positions for any
tune with dotted figures. For most tunes the alignment improves; for a few where
the specific recording does not cleanly reproduce those passing notes, the NW
alignment degrades slightly.

#### b) Chord symbol stripping — secondary cause

**Files**: `build_non_user_data.py`, `build_folkwiki_data.py`

```python
abc_body = re.sub(r'"[^"]*"', '', abc_body)  # strip "Am", "D" chord symbols
```

Upstream stored contours may include chord tones from inline ABC chord
annotations (`"D"`, `"Am"`), which abc2midi plays as real MIDI notes on a
second channel. After stripping, stored contours are melody-only. Where those
accidentally-included chord tones happened to improve alignment against a
particular recording, removing them lowers the score slightly.

#### c) Grace note stripping — minor

```python
abc_body = re.sub(r'\{[^}]*\}', '', abc_body)  # strip {g} grace notes
```

Additionally, a sub-quaver skip threshold (`rel_duration < 0.35`) in
`to_midi_contour` silently drops any ornament note that slips through. This
primarily affects folkwiki ABCs (18.7% contain `{...}` blocks); the effect on
thesession Celtic tunes is small.

---

## Why the largest regressions occur where they do

| Tune | Drop | Most likely cause |
|---|---|---|
| The Galway Belle | −0.041 | Many dotted-rhythm figures; stored contour shifted by passing note fix |
| The Salamanca (rec. 2) | −0.035 | Less clean recording; more sensitive to any stored-contour shift |
| Cooley's Reel | −0.028 | Classic reel with dense dotted figures throughout |
| The Hut on Staffin Island | −0.024 | Same mechanism |

All four are still detected at rank #1. The maximum regression is 0.041 (4%),
while the gains on previously-missed tunes are much larger.

---

## Net assessment

The regressions are a side-effect of making stored contours more accurate
(closer to what the audio transcriber actually produces). The passing note fix
in particular was motivated by folkwiki tunes where `L:1/16` notation caused
severe density mismatches; thesession tunes get the same treatment which mostly
helps but occasionally shifts a contour slightly away from a specific recording.

If the small regressions on the 5–7 Celtic tunes matter, the most targeted fix
would be to verify whether the **audio transcriber** (Rust feature decoder)
reliably detects the short notes in `A>B`-style figures. If it sometimes misses
them, the stored contour should optionally omit them too — but that trades one
dataset consistency issue for another.
