//! Port of basic-pitch's `note_creation.output_to_notes_polyphonic` (+
//! `get_infered_onsets` and the melodia trick). Turns the model's note/onset
//! posteriorgrams into discrete note events. See `docs/v2-detection/PROGRESS.md`
//! for the algorithm spec and the original (`basic_pitch/note_creation.py`).
//!
//! Matrices are flat row-major `[frame * n_bins + bin]`.

use crate::decode::ml::MIDI_OFFSET;
use crate::ff_config;

#[derive(Debug, Clone, PartialEq)]
pub struct NoteEvent {
    pub start_frame: usize,
    pub end_frame: usize, // exclusive
    pub pitch_midi: u32,
    pub amplitude: f32,
}

pub struct NoteCreationParams {
    pub onset_thresh: f32,
    pub frame_thresh: f32,
    pub min_note_len: usize, // in frames
    pub energy_tol: usize,
    pub infer_onsets: bool,
    pub melodia_trick: bool,
}

impl Default for NoteCreationParams {
    fn default() -> Self {
        // basic-pitch predict() defaults.
        NoteCreationParams {
            onset_thresh: 0.5,
            frame_thresh: 0.3,
            min_note_len: 11,
            energy_tol: 11,
            infer_onsets: true,
            melodia_trick: true,
        }
    }
}

#[inline]
fn at(m: &[f32], t: usize, b: usize, n_bins: usize) -> f32 {
    m[t * n_bins + b]
}

/// Augment onsets with onsets inferred from large positive frame-amplitude
/// jumps (basic-pitch `get_infered_onsets`, n_diff=2).
fn infer_onsets(onsets: &[f32], frames: &[f32], t: usize, n_bins: usize) -> Vec<f32> {
    const N_DIFF: usize = 2;
    let mut frame_diff = vec![f32::INFINITY; t * n_bins];
    for n in 1..=N_DIFF {
        for ti in 0..t {
            for b in 0..n_bins {
                let prev = if ti >= n { at(frames, ti - n, b, n_bins) } else { 0.0 };
                let d = at(frames, ti, b, n_bins) - prev;
                let idx = ti * n_bins + b;
                frame_diff[idx] = frame_diff[idx].min(d);
            }
        }
    }
    // clamp negatives to 0, zero the first N_DIFF frames
    for v in frame_diff.iter_mut() {
        if *v < 0.0 {
            *v = 0.0;
        }
    }
    for ti in 0..N_DIFF.min(t) {
        for b in 0..n_bins {
            frame_diff[ti * n_bins + b] = 0.0;
        }
    }
    let onsets_max = onsets.iter().cloned().fold(0.0f32, f32::max);
    let diff_max = frame_diff.iter().cloned().fold(0.0f32, f32::max);
    let mut out = vec![0.0f32; t * n_bins];
    for i in 0..t * n_bins {
        // rescale frame_diff to share onsets' max, then take elementwise max
        let scaled = if diff_max > 0.0 { onsets_max * frame_diff[i] / diff_max } else { 0.0 };
        out[i] = onsets[i].max(scaled);
    }
    out
}

fn mean_amplitude(frames: &[f32], start: usize, end: usize, b: usize, n_bins: usize) -> f32 {
    if end <= start {
        return 0.0;
    }
    let mut s = 0.0;
    for t in start..end {
        s += at(frames, t, b, n_bins);
    }
    s / (end - start) as f32
}

/// Decode note/onset posteriorgrams into note events.
pub fn output_to_notes(
    frames: &[f32],
    onsets: &[f32],
    n_frames: usize,
    n_bins: usize,
    p: &NoteCreationParams,
) -> Vec<NoteEvent> {
    if n_frames < 3 {
        return Vec::new();
    }
    let max_freq_idx = n_bins - 1;

    let onsets = if p.infer_onsets {
        infer_onsets(onsets, frames, n_frames, n_bins)
    } else {
        onsets.to_vec()
    };

    // Peak-pick onsets along time (argrelmax) and keep those >= onset_thresh,
    // in row-major (t asc, b asc) order, then reverse to go backwards in time.
    let mut onset_list: Vec<(usize, usize)> = Vec::new();
    for t in 1..n_frames - 1 {
        for b in 0..n_bins {
            let v = at(&onsets, t, b, n_bins);
            if v > at(&onsets, t - 1, b, n_bins)
                && v > at(&onsets, t + 1, b, n_bins)
                && v >= p.onset_thresh
            {
                onset_list.push((t, b));
            }
        }
    }
    onset_list.reverse();

    let mut remaining = frames.to_vec();
    let mut notes: Vec<NoteEvent> = Vec::new();

    let mut zero_band = |rem: &mut [f32], t: usize, b: usize| {
        rem[t * n_bins + b] = 0.0;
        if b < max_freq_idx {
            rem[t * n_bins + b + 1] = 0.0;
        }
        if b > 0 {
            rem[t * n_bins + b - 1] = 0.0;
        }
    };

    // Pass 1: from each detected onset, walk forward while energy persists.
    for (note_start, b) in onset_list {
        if note_start >= n_frames - 1 {
            continue;
        }
        let mut i = note_start + 1;
        let mut k = 0;
        while i < n_frames - 1 && k < p.energy_tol {
            if at(&remaining, i, b, n_bins) < p.frame_thresh {
                k += 1;
            } else {
                k = 0;
            }
            i += 1;
        }
        i -= k;
        if i.saturating_sub(note_start) <= p.min_note_len {
            continue;
        }
        let amplitude = mean_amplitude(frames, note_start, i, b, n_bins);
        for t in note_start..i {
            remaining[t * n_bins + b] = 0.0;
            if b < max_freq_idx {
                remaining[t * n_bins + b + 1] = 0.0;
            }
            if b > 0 {
                remaining[t * n_bins + b - 1] = 0.0;
            }
        }
        notes.push(NoteEvent {
            start_frame: note_start,
            end_frame: i,
            pitch_midi: b as u32 + MIDI_OFFSET,
            amplitude,
        });
    }

    // Pass 2 (melodia trick): repeatedly grab the strongest remaining energy and
    // grow a note forward + backward from it.
    if p.melodia_trick {
        loop {
            // argmax over remaining (row-major / t-major, first occurrence).
            let mut best = p.frame_thresh;
            let mut best_idx: Option<usize> = None;
            for (idx, &v) in remaining.iter().enumerate() {
                if v > best {
                    best = v;
                    best_idx = Some(idx);
                }
            }
            let Some(idx) = best_idx else { break };
            let i_mid = idx / n_bins;
            let b = idx % n_bins;
            remaining[idx] = 0.0;

            // forward
            let mut i = i_mid + 1;
            let mut k = 0;
            while i < n_frames - 1 && k < p.energy_tol {
                if at(&remaining, i, b, n_bins) < p.frame_thresh {
                    k += 1;
                } else {
                    k = 0;
                }
                zero_band(&mut remaining, i, b);
                i += 1;
            }
            let i_end = i - 1 - k;

            // backward
            let mut i = i_mid as isize - 1;
            let mut k = 0;
            while i > 0 && k < p.energy_tol {
                let iu = i as usize;
                if at(&remaining, iu, b, n_bins) < p.frame_thresh {
                    k += 1;
                } else {
                    k = 0;
                }
                zero_band(&mut remaining, iu, b);
                i -= 1;
            }
            let i_start = (i + 1 + k as isize) as usize;

            if i_end.saturating_sub(i_start) <= p.min_note_len {
                continue;
            }
            let amplitude = mean_amplitude(frames, i_start, i_end, b, n_bins);
            notes.push(NoteEvent {
                start_frame: i_start,
                end_frame: i_end,
                pitch_midi: b as u32 + MIDI_OFFSET,
                amplitude,
            });
        }
    }

    notes
}

/// Fold a MIDI pitch into FolkFriend's representable range [MIDI_LOW, MIDI_HIGH]
/// by whole octaves (the contour alphabet only covers those 48 semitones).
fn fold_into_range(mut pitch: u32) -> u32 {
    while pitch < ff_config::MIDI_LOW {
        pitch += 12;
    }
    while pitch > ff_config::MIDI_HIGH {
        pitch -= 12;
    }
    pitch
}

/// Collapse polyphonic note events into a monophonic melody line: at each frame
/// the loudest active note wins; runs of equal pitch become one melody note, but
/// a note-event onset always starts a new melody note (so repeated picked notes
/// stay separated — the key win over the DSP path for banjo etc.).
///
/// Returns `(pitch_midi, duration_frames, power)` tuples, pitches octave-folded
/// into FolkFriend's range.
pub fn notes_to_melody(events: &[NoteEvent], n_frames: usize) -> Vec<(u32, usize, f32)> {
    if n_frames == 0 {
        return Vec::new();
    }
    // Per-frame candidate notes (pitch, amplitude) from all active events.
    let mut frame_cands: Vec<Vec<(u32, f32)>> = vec![Vec::new(); n_frames];
    for ev in events {
        for t in ev.start_frame..ev.end_frame.min(n_frames) {
            frame_cands[t].push((ev.pitch_midi, ev.amplitude));
        }
    }

    // Seed the running melody pitch with the amplitude-weighted mean pitch, so
    // greedy selection starts near the melodic centre rather than on a harmonic.
    let (mut wsum, mut asum) = (0.0f64, 0.0f64);
    for cands in &frame_cands {
        for &(p, a) in cands {
            wsum += p as f64 * a as f64;
            asum += a as f64;
        }
    }
    let mut running = if asum > 0.0 { (wsum / asum) as f32 } else { 0.0 };

    // Select the dominant note per frame by amplitude BUT penalised for jumping
    // away from the running melody pitch — suppresses brief loud harmonics
    // (which sit an octave or two up) that would otherwise fragment the line.
    const JUMP_PENALTY_PER_OCTAVE: f32 = 0.25;
    let mut frame_pitch: Vec<Option<u32>> = vec![None; n_frames];
    let mut frame_amp: Vec<f32> = vec![0.0; n_frames];
    for t in 0..n_frames {
        let mut best: Option<(u32, f32)> = None;
        let mut best_score = f32::NEG_INFINITY;
        for &(p, a) in &frame_cands[t] {
            let octaves_away = (p as f32 - running).abs() / 12.0;
            let score = a - JUMP_PENALTY_PER_OCTAVE * octaves_away;
            if score > best_score {
                best_score = score;
                best = Some((p, a));
            }
        }
        if let Some((p, a)) = best {
            frame_pitch[t] = Some(p);
            frame_amp[t] = a;
            running = 0.85 * running + 0.15 * p as f32; // EMA toward the chosen pitch
        }
    }
    // Onset boundaries: a frame where some event begins and wins the frame.
    let mut onset_at = vec![false; n_frames];
    for ev in events {
        let t = ev.start_frame;
        if t < n_frames && frame_pitch[t] == Some(ev.pitch_midi) {
            onset_at[t] = true;
        }
    }

    let mut melody = Vec::new();
    let mut i = 0;
    while i < n_frames {
        let Some(pitch) = frame_pitch[i] else {
            i += 1;
            continue;
        };
        let start = i;
        let mut amp_sum = frame_amp[i];
        i += 1;
        while i < n_frames && frame_pitch[i] == Some(pitch) && !onset_at[i] {
            amp_sum += frame_amp[i];
            i += 1;
        }
        let duration = i - start;
        melody.push((fold_into_range(pitch), duration, amp_sum / duration as f32));
    }
    melody
}

#[cfg(test)]
mod tests {
    use super::*;

    // Build a posteriorgram with one clear sustained note and an onset spike.
    fn one_note(t: usize, n_bins: usize, b: usize, start: usize, end: usize) -> (Vec<f32>, Vec<f32>) {
        let mut frames = vec![0.0f32; t * n_bins];
        let mut onsets = vec![0.0f32; t * n_bins];
        for f in start..end {
            frames[f * n_bins + b] = 0.9;
        }
        onsets[start * n_bins + b] = 0.9; // onset spike at the start
        (frames, onsets)
    }

    #[test]
    fn detects_single_note() {
        let (t, n_bins, b, start, end) = (100, 88, 40, 20, 60);
        let (frames, onsets) = one_note(t, n_bins, b, start, end);
        let p = NoteCreationParams { infer_onsets: false, melodia_trick: false, ..Default::default() };
        let notes = output_to_notes(&frames, &onsets, t, n_bins, &p);
        assert_eq!(notes.len(), 1, "expected exactly one note, got {notes:?}");
        let n = &notes[0];
        assert_eq!(n.pitch_midi, b as u32 + MIDI_OFFSET);
        assert_eq!(n.start_frame, start);
        // end walks until energy drops (plus the energy_tol slack handling).
        assert!(n.end_frame >= end - 1 && n.end_frame <= end + 1, "end={}", n.end_frame);
    }

    #[test]
    fn a4_tone_yields_a4_notes() {
        // End-to-end across 2B+2C: synth A4 tone -> model -> note events.
        use crate::decode::ml::BasicPitch;
        let src_rate = 48_000u32;
        let n = (src_rate as f32 * 2.5) as usize;
        let f0 = 440.0f32;
        let pcm: Vec<f32> = (0..n)
            .map(|i| {
                let w = 2.0 * std::f32::consts::PI * i as f32 / src_rate as f32;
                0.6 * (w * f0).sin() + 0.3 * (w * 2.0 * f0).sin() + 0.15 * (w * 3.0 * f0).sin()
            })
            .collect();
        let bp = BasicPitch::new().unwrap();
        let p = bp.transcribe(&pcm, src_rate).unwrap();
        let notes = output_to_notes(&p.note, &p.onset, p.n_frames, 88, &NoteCreationParams::default());
        eprintln!("A4 tone -> {} note events", notes.len());
        assert!(!notes.is_empty(), "expected note events for a sustained A4");
        // The longest note should be A4 (MIDI 69).
        let longest = notes.iter().max_by_key(|n| n.end_frame - n.start_frame).unwrap();
        assert_eq!(longest.pitch_midi, 69, "longest note should be A4, got {longest:?}");
    }

    #[test]
    fn detects_two_sequential_notes() {
        // Two distinct notes back-to-back; the port must return both (rules out
        // an over-conservative "misses notes" bug, independent of resampling).
        let (t, n_bins) = (120, 88);
        let mut frames = vec![0.0f32; t * n_bins];
        let mut onsets = vec![0.0f32; t * n_bins];
        for f in 20..50 {
            frames[f * n_bins + 40] = 0.9; // note A, bin 40
        }
        for f in 55..95 {
            frames[f * n_bins + 44] = 0.9; // note B, bin 44
        }
        onsets[20 * n_bins + 40] = 0.9;
        onsets[55 * n_bins + 44] = 0.9;
        let p = NoteCreationParams { infer_onsets: false, melodia_trick: false, ..Default::default() };
        let mut notes = output_to_notes(&frames, &onsets, t, n_bins, &p);
        notes.sort_by_key(|n| n.start_frame);
        assert_eq!(notes.len(), 2, "expected two notes, got {notes:?}");
        assert_eq!(notes[0].pitch_midi, 40 + MIDI_OFFSET);
        assert_eq!(notes[1].pitch_midi, 44 + MIDI_OFFSET);
    }

    #[test]
    fn drops_too_short_notes() {
        let (t, n_bins, b, start, end) = (100, 88, 40, 20, 25); // 5 frames < min_note_len 11
        let (frames, onsets) = one_note(t, n_bins, b, start, end);
        let p = NoteCreationParams { infer_onsets: false, melodia_trick: false, ..Default::default() };
        let notes = output_to_notes(&frames, &onsets, t, n_bins, &p);
        assert!(notes.is_empty(), "short note should be dropped, got {notes:?}");
    }
}
