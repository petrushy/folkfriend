mod beam_search;
mod contour;
pub mod ml;
pub mod note_events;
mod octave;
mod pitch_model;
pub mod types;

use crate::feature::types::Features;
use crate::feature::signal;
use std::fmt;
use types::{Contour, ContourString, LatticePath};

pub struct FeatureDecoder {
    pub sample_rate: u32
}

#[derive(Debug, Clone)]
pub struct DecoderError;

impl fmt::Display for DecoderError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "Error decoding features")
    }
}

impl FeatureDecoder {
    pub fn new(sample_rate: u32) -> Result<FeatureDecoder, signal::SampleRateError> {
        if !signal::validate_sample_rate(&sample_rate) {
            return Err(signal::SampleRateError);
        }
        
        Ok(FeatureDecoder {
            sample_rate: sample_rate
        })
    }

    pub fn decode_lattice_path(
        &self,
        features: &mut Features,
    ) -> Result<LatticePath, DecoderError> {
        beam_search::decode(features)
    }

    pub fn decode_contour(
        &self,
        lattice_path: &LatticePath,
        features: &Features
    ) -> Result<ContourString, DecoderError> {
        let mut contour: Contour = contour::contour_from_lattice_path(lattice_path, features, self.sample_rate)?;
        octave::correct_contour_octave(&mut contour);
        return Ok(types::contour_to_contour_string(&contour));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ff_config;

    /// Six 3-frame blips and nothing longer: every one of them is shorter than
    /// 0.2 quaver at 60 BPM, which is also the tempo the quantiser scores best
    /// (a note given zero quavers scores the most "likely" length), so the
    /// contour comes out empty. That used to reach correct_contour_octave and
    /// panic on `pitches[0]` — in WASM a panic inside a `&mut self` method,
    /// which can leave the instance unusable until the page is reloaded.
    #[test]
    fn short_blips_are_no_notes_not_a_panic() {
        let decoder = FeatureDecoder::new(48_000).unwrap();
        let mut features: Features = Vec::new();
        let mut path: LatticePath = Vec::new();
        for blip in 0..6 {
            for _ in 0..ff_config::MIN_NOTE_DURATION {
                let mut frame = [0f32; ff_config::MIDI_NUM as usize];
                frame[20 + blip * 2] = 0.3;
                features.push(frame);
                path.push(20 + blip * 2);
            }
        }
        assert!(decoder.decode_contour(&path, &features).is_err());
    }

    #[test]
    fn octave_correction_accepts_an_empty_contour() {
        let mut contour: Contour = Vec::new();
        octave::correct_contour_octave(&mut contour);
        assert!(contour.is_empty());
    }
}
