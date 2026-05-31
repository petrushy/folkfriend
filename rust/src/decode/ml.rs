//! basic-pitch ONNX inference via tract (Phase 2 of v2.0 detection).
//!
//! Loads the embedded ICASSP-2022 model and runs one ~2 s audio window to
//! produce note / onset / contour posteriorgrams. Compiles to native (CLI +
//! tests) and wasm32 (browser worker). See `docs/v2-detection/PROGRESS.md`.
use tract_onnx::prelude::*;

/// The official basic-pitch model (~225 KB), embedded so native + wasm share a
/// single asset and there is no runtime file/network dependency.
const MODEL_BYTES: &[u8] = include_bytes!("../../models/nmp.onnx");

pub const SAMPLE_RATE: u32 = 22050;
pub const WINDOW_SAMPLES: usize = 43844; // AUDIO_N_SAMPLES (~2 s @ 22050)
pub const N_FRAMES: usize = 172; // ANNOT_N_FRAMES per window
pub const N_NOTE_BINS: usize = 88; // 1 bin/semitone; bin i -> MIDI i + MIDI_OFFSET
pub const N_CONTOUR_BINS: usize = 264; // 3 bins/semitone
pub const MIDI_OFFSET: u32 = 21; // bin 0 = A0
const FFT_HOP: usize = 256;
const ANNOTATIONS_FPS: usize = SAMPLE_RATE as usize / FFT_HOP; // 86
const OVERLAP_FRAMES: usize = 30; // basic-pitch default n_overlapping_frames
const OVERLAP_SAMPLES: usize = OVERLAP_FRAMES * FFT_HOP; // 7680
const HOP_SAMPLES: usize = WINDOW_SAMPLES - OVERLAP_SAMPLES; // 36164

/// Linear-interpolation resampler. Good enough for melody pitch detection (the
/// fundamentals sit well below the 11 kHz Nyquist); could be upgraded to a sinc
/// resampler later if accuracy demands.
pub fn resample_linear(pcm: &[f32], src_rate: u32, dst_rate: u32) -> Vec<f32> {
    if src_rate == dst_rate || pcm.is_empty() {
        return pcm.to_vec();
    }
    let ratio = dst_rate as f64 / src_rate as f64;
    let out_len = (pcm.len() as f64 * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = i as f64 / ratio;
        let i0 = src_pos.floor() as usize;
        let frac = (src_pos - i0 as f64) as f32;
        let a = pcm.get(i0).copied().unwrap_or(0.0);
        let b = pcm.get(i0 + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    out
}

/// Stitched posteriorgrams for a whole recording, row-major `[frame][bin]`.
pub struct Posteriorgrams {
    pub note: Vec<f32>,    // n_frames * N_NOTE_BINS
    pub onset: Vec<f32>,   // n_frames * N_NOTE_BINS
    pub contour: Vec<f32>, // n_frames * N_CONTOUR_BINS
    pub n_frames: usize,
}

type Plan = TypedRunnableModel<TypedModel>;

pub struct BasicPitch {
    plan: Plan,
}

/// One window's posteriorgrams, each stored row-major as `[frame][bin]`.
pub struct WindowOutput {
    pub note: Vec<f32>,    // N_FRAMES * N_NOTE_BINS
    pub onset: Vec<f32>,   // N_FRAMES * N_NOTE_BINS
    pub contour: Vec<f32>, // N_FRAMES * N_CONTOUR_BINS
}

impl BasicPitch {
    pub fn new() -> TractResult<Self> {
        let plan = tract_onnx::onnx()
            .model_for_read(&mut std::io::Cursor::new(MODEL_BYTES))?
            .with_input_fact(0, f32::fact([1, WINDOW_SAMPLES, 1]).into())?
            .into_optimized()?
            .into_runnable()?;
        Ok(Self { plan })
    }

    /// Run one window of exactly `WINDOW_SAMPLES` audio samples @ 22050 Hz mono.
    pub fn run_window(&self, audio: &[f32]) -> TractResult<WindowOutput> {
        assert_eq!(
            audio.len(),
            WINDOW_SAMPLES,
            "basic-pitch expects exactly {WINDOW_SAMPLES} samples per window"
        );
        let input =
            tract_ndarray::Array3::from_shape_vec((1, WINDOW_SAMPLES, 1), audio.to_vec())?;
        let input: Tensor = input.into();
        let result = self.plan.run(tvec!(input.into()))?;

        // Graph output order is [0]=StatefulPartitionedCall:2 (onset),
        // [1]=:1 (note), [2]=:0 (contour) — basic_pitch maps names
        // :1=note, :2=onset, :0=contour. (Cross-checked vs python in increment 2C.)
        let onset = result[0].to_array_view::<f32>()?.iter().cloned().collect();
        let note = result[1].to_array_view::<f32>()?.iter().cloned().collect();
        let contour = result[2].to_array_view::<f32>()?.iter().cloned().collect();
        Ok(WindowOutput { note, onset, contour })
    }

    /// Resample arbitrary-rate mono PCM to 22050 Hz, run it through the model in
    /// overlapping ~2 s windows, and stitch the per-window posteriorgrams into
    /// one matrix (mirrors basic-pitch's front-pad + `unwrap_output` trim).
    pub fn transcribe(&self, pcm: &[f32], src_rate: u32) -> TractResult<Posteriorgrams> {
        let audio = resample_linear(pcm, src_rate, SAMPLE_RATE);
        let orig_len = audio.len();

        // Front-pad by half the overlap so the first window's trimmed-away
        // leading frames correspond to padding, not real audio.
        let pad = OVERLAP_SAMPLES / 2;
        let mut padded = vec![0.0f32; pad];
        padded.extend_from_slice(&audio);

        let n_olap = OVERLAP_FRAMES / 2; // 15 frames trimmed each side per window
        let mut note = Vec::new();
        let mut onset = Vec::new();
        let mut contour = Vec::new();

        let mut start = 0usize;
        loop {
            let mut win = vec![0.0f32; WINDOW_SAMPLES];
            let end = (start + WINDOW_SAMPLES).min(padded.len());
            win[..end - start].copy_from_slice(&padded[start..end]);
            let out = self.run_window(&win)?;
            append_trimmed(&mut note, &out.note, N_NOTE_BINS, n_olap);
            append_trimmed(&mut onset, &out.onset, N_NOTE_BINS, n_olap);
            append_trimmed(&mut contour, &out.contour, N_CONTOUR_BINS, n_olap);
            if end >= padded.len() {
                break;
            }
            start += HOP_SAMPLES;
        }

        // Trim to the number of frames the original audio actually spans.
        let n_out = (orig_len as f64 * ANNOTATIONS_FPS as f64 / SAMPLE_RATE as f64).floor() as usize;
        let n_out = n_out.min(note.len() / N_NOTE_BINS);
        note.truncate(n_out * N_NOTE_BINS);
        onset.truncate(n_out * N_NOTE_BINS);
        contour.truncate(n_out * N_CONTOUR_BINS);

        Ok(Posteriorgrams { note, onset, contour, n_frames: n_out })
    }
}

/// Append all but the first/last `n_olap` frames of a window's output.
fn append_trimmed(dst: &mut Vec<f32>, src: &[f32], bins: usize, n_olap: usize) {
    let start = n_olap * bins;
    let end = (N_FRAMES - n_olap) * bins;
    dst.extend_from_slice(&src[start..end]);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_and_runs_on_silence() {
        let bp = BasicPitch::new().expect("model should load");
        let out = bp
            .run_window(&vec![0.0f32; WINDOW_SAMPLES])
            .expect("inference should run");
        assert_eq!(out.note.len(), N_FRAMES * N_NOTE_BINS);
        assert_eq!(out.onset.len(), N_FRAMES * N_NOTE_BINS);
        assert_eq!(out.contour.len(), N_FRAMES * N_CONTOUR_BINS);
        // Posteriorgrams are sigmoid outputs in [0, 1].
        assert!(out.note.iter().all(|&v| (0.0..=1.0).contains(&v)));
    }

    #[test]
    fn detects_a4_tone() {
        // Synthesize ~2.5 s of an A4 (440 Hz) tone with a couple of harmonics
        // (a pure sine barely activates a harmonic model) at 48 kHz, then check
        // the note posteriorgram peaks at A4 = MIDI 69 = bin 48.
        let src_rate = 48_000u32;
        let n = (src_rate as f32 * 2.5) as usize;
        let f0 = 440.0f32;
        let pcm: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f32 / src_rate as f32;
                let w = 2.0 * std::f32::consts::PI * t;
                0.6 * (w * f0).sin() + 0.3 * (w * 2.0 * f0).sin() + 0.15 * (w * 3.0 * f0).sin()
            })
            .collect();

        let bp = BasicPitch::new().unwrap();
        let p = bp.transcribe(&pcm, src_rate).unwrap();
        assert!(p.n_frames > 100, "expected ~200 frames, got {}", p.n_frames);

        // Average each note bin across frames; the argmax bin is the detected pitch.
        let mut bin_energy = vec![0.0f32; N_NOTE_BINS];
        for f in 0..p.n_frames {
            for b in 0..N_NOTE_BINS {
                bin_energy[b] += p.note[f * N_NOTE_BINS + b];
            }
        }
        let best = (0..N_NOTE_BINS).max_by(|&a, &b| bin_energy[a].total_cmp(&bin_energy[b])).unwrap();
        let best_midi = best as u32 + MIDI_OFFSET;
        eprintln!("A4 tone: strongest note bin {best} = MIDI {best_midi}");
        assert_eq!(best_midi, 69, "expected A4 (MIDI 69), got MIDI {best_midi}");
    }
}
