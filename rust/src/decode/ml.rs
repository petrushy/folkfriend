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
}
