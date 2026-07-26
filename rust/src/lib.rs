pub mod abc;
pub mod decode;
pub mod feature;
pub mod ff_config;
pub mod index;
pub mod query;

use console_error_panic_hook;
use js_sys;
use serde_json::json;
use std::convert::TryInto;
use std::panic;
use std::slice;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    // Use `js_namespace` here to bind `console.log(..)` instead of just
    // `log(..)`
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

pub struct FolkFriend {
    query_engine: query::QueryEngine,
    feature_extractor: feature::FeatureExtractor,
    feature_decoder: decode::FeatureDecoder,
    // ML (basic-pitch) transcriber path — opt-in. When `use_ml` is set, raw PCM
    // is accumulated in `raw_pcm` and transcription routes to the ML pipeline
    // instead of the DSP feature extractor + lattice decoder.
    basic_pitch: Option<decode::ml::BasicPitch>,
    use_ml: bool,
    raw_pcm: Vec<f32>,
}

impl FolkFriend {
    pub fn new() -> FolkFriend {
        FolkFriend {
            query_engine: query::QueryEngine::new(),
            feature_extractor: feature::FeatureExtractor::new(ff_config::SAMPLE_RATE_DEFAULT)
                .unwrap(),
            feature_decoder: decode::FeatureDecoder::new(ff_config::SAMPLE_RATE_DEFAULT).unwrap(),
            basic_pitch: None,
            use_ml: false,
            raw_pcm: Vec::new(),
        }
    }

    /// Select the ML (basic-pitch) transcriber. Lazily builds the model on first
    /// enable; falls back to the DSP path if the model fails to build.
    pub fn set_use_ml(&mut self, use_ml: bool) {
        if use_ml && self.basic_pitch.is_none() {
            match decode::ml::BasicPitch::new() {
                Ok(bp) => self.basic_pitch = Some(bp),
                Err(_) => {
                    self.use_ml = false;
                    return;
                }
            }
        }
        self.use_ml = use_ml;
    }

    pub fn version(&self) -> String {
        ff_config::VERSION.to_string()
    }

    pub fn load_index_from_json_string(&mut self, json_string: String) {
        let tune_index = index::tune_index_from_string(&json_string);
        self.query_engine.use_tune_index(tune_index);
    }

    pub fn set_sample_rate(
        &mut self,
        sample_rate: u32,
    ) -> Result<(), feature::signal::SampleRateError> {
        if self.feature_extractor.sample_rate != sample_rate {
            self.feature_extractor = feature::FeatureExtractor::new(sample_rate)?;
        }
        if self.feature_decoder.sample_rate != sample_rate {
            self.feature_decoder = decode::FeatureDecoder::new(sample_rate)?;
        }
        Ok(())
    }

    pub fn feed_entire_pcm_signal(&mut self, pcm_signal: Vec<f32>) {
        if self.use_ml {
            self.raw_pcm.extend_from_slice(&pcm_signal);
        } else {
            self.feature_extractor.feed_signal(pcm_signal);
        }
    }

    pub fn feed_single_pcm_window(&mut self, pcm_window: [f32; ff_config::SPEC_WINDOW_SIZE]) {
        if self.use_ml {
            self.raw_pcm.extend_from_slice(&pcm_window);
        } else {
            self.feature_extractor.feed_window(pcm_window);
        }
    }

    pub fn flush_pcm_buffer(&mut self) {
        self.feature_extractor.flush();
        self.raw_pcm.clear();
    }

    pub fn transcribe_pcm_buffer(
        &mut self,
    ) -> Result<decode::types::ContourString, decode::DecoderError> {
        if self.use_ml {
            let sample_rate = self.feature_extractor.sample_rate;
            let bp = self.basic_pitch.as_ref().ok_or(decode::DecoderError)?;
            let contour = bp.transcribe_contour(&self.raw_pcm, sample_rate);
            self.raw_pcm.clear();
            return contour;
        }
        let lattice_path = self
            .feature_decoder
            .decode_lattice_path(&mut self.feature_extractor.features)?;
        let contour = self
            .feature_decoder
            .decode_contour(&lattice_path, &self.feature_extractor.features);
        self.feature_extractor.flush();
        return contour;
    }

    pub fn run_transcription_query(
        &self,
        contour: &decode::types::ContourString,
    ) -> Result<query::TranscriptionQueryResults, query::QueryError> {
        self.query_engine.run_contour_query(contour)
    }

    pub fn run_name_query(
        &self,
        query: &String,
    ) -> Result<query::NameQueryResults, query::QueryError> {
        self.query_engine.run_name_query(query)
    }

    pub fn contour_to_abc(&self, contour_string: &decode::types::ContourString) -> String {
        let contour: decode::types::Contour =
            decode::types::contour_string_to_contour(contour_string);
        return abc::contour_to_abc(&contour);
    }

    pub fn settings_from_tune_id(
        &self,
        tune_id: index::schema::TuneID,
    ) -> Result<Vec<(index::schema::SettingID, index::schema::Setting)>, query::QueryError> {
        self.query_engine.settings_from_tune_id(tune_id)
    }

    pub fn aliases_from_tune_id(
        &self,
        tune_id: index::schema::TuneID,
    ) -> Result<Vec<String>, query::QueryError> {
        self.query_engine.aliases_from_tune_id(tune_id)
    }
}

// Define a WASM-safe version of this FolkFriend class. The key point is that
//  all function signatures will have simple types that can pass between WASM
//  and JS. e.g. search results are encoded as a JSON String rather than a
//  vector of structs. The latter would be better, but WASM/JS can't hadnle
//  this yet.

#[wasm_bindgen]
pub struct FolkFriendWASM {
    ff: FolkFriend,
    /// Reusable PCM window that JavaScript writes into (see
    /// alloc_single_pcm_window). Owned here so the pointer handed out stays
    /// valid for the lifetime of this struct.
    pcm_window: Option<Box<[f32]>>,
}

#[wasm_bindgen]
impl FolkFriendWASM {
    #[wasm_bindgen(constructor)]
    pub fn new() -> FolkFriendWASM {
        panic::set_hook(Box::new(console_error_panic_hook::hook));
        FolkFriendWASM {
            ff: FolkFriend::new(),
            pcm_window: None,
        }
    }

    pub fn version(&self) -> String {
        self.ff.version()
    }

    pub fn load_index_from_json_obj(&mut self, js_value: JsValue) {
        // This function doesn't call the underlying self.ff.load_index_from_string.
        let tune_index: index::TuneIndex = serde_wasm_bindgen::from_value(js_value).unwrap();
        self.ff.query_engine.use_tune_index(tune_index);
    }

    pub fn set_sample_rate(&mut self, sample_rate: u32) -> bool {
        match self.ff.set_sample_rate(sample_rate) {
            Ok(()) => true,
            Err(_) => false,
        }
    }

    pub fn set_use_ml(&mut self, use_ml: bool) {
        self.ff.set_use_ml(use_ml);
    }

    pub fn feed_entire_pcm_signal(&mut self) {
        panic!("Cannot feed entire PCM signal from WebAssembly!");
    }

    pub fn alloc_single_pcm_window(&mut self) -> *mut f32 {
        // Hands JavaScript a pointer it writes PCM directly into, avoiding a
        // copy per frame.
        //
        // This used to allocate the buffer on the stack and call
        // std::mem::forget to "keep" it. mem::forget is a no-op for Copy types
        // (the compiler warns: "calls to std::mem::forget with a value that
        // implements Copy does nothing"), so the array died with the stack
        // frame and JavaScript was handed a dangling pointer into reclaimed
        // stack space. It happened to work — later calls did not reuse those
        // bytes before the read — but it was undefined behaviour that any
        // change of compiler, optimisation level or call sequence could turn
        // into silently corrupted audio.
        //
        // The buffer is now owned by the struct, so it lives exactly as long
        // as FolkFriendWASM does. Repeated calls return the same pointer,
        // which is what the worker already assumes (it allocates once and
        // reuses the pointer forever).
        if self.pcm_window.is_none() {
            self.pcm_window = Some(vec![0f32; ff_config::SPEC_WINDOW_SIZE].into_boxed_slice());
        }
        return self.pcm_window.as_mut().unwrap().as_mut_ptr();
    }

    pub fn get_allocated_pcm_window(&mut self, ptr: *mut f32) -> js_sys::Float32Array {
        return unsafe {
            js_sys::Float32Array::view(slice::from_raw_parts(ptr, ff_config::SPEC_WINDOW_SIZE))
        };
    }

    pub fn feed_single_pcm_window(&mut self, ptr: *mut f32) {
        let pcm_window = unsafe { slice::from_raw_parts(ptr, ff_config::SPEC_WINDOW_SIZE) };
        self.ff
            .feed_single_pcm_window(pcm_window.try_into().unwrap());
    }

    pub fn flush_pcm_buffer(&mut self) {
        self.ff.flush_pcm_buffer();
    }

    pub fn transcribe_pcm_buffer(&mut self) -> String {
        match self.ff.transcribe_pcm_buffer() {
            Ok(transcription) => transcription,
            Err(_) => json!({
                "error": "Could not detect any notes".to_string()
            })
            .to_string(),
        }
    }

    pub fn run_transcription_query(&self, contour_string: &str) -> String {
        // TODO proper error propagation in JSON back to javascript
        let result = self.ff.run_transcription_query(&contour_string.to_string());
        if let Ok(mut query_result) = result {
            // Pass back fewer results to the App than the backend is
            //  configured to provide. Users don't have time to scroll
            //  through a hundred results, even if we do want this sort
            //  of granularity when assessing dataset performance.
            query_result.truncate(20);
            return json!(query_result).to_string();
        } else {
            return json!({
                "error": "Transcription query error".to_string()
            })
            .to_string();
        }
    }

    pub fn run_name_query(&self, query: &str) -> String {
        // TODO proper error propagation in JSON back to javascriptx
        let result = self.ff.run_name_query(&query.to_string());
        if let Ok(query_result) = result {
            return json!(query_result).to_string();
        } else {
            json!({
                "error": "Name query error".to_string()
            })
            .to_string()
        }
    }
    pub fn contour_to_abc(&self, contour_string: &str) -> String {
        self.ff.contour_to_abc(&contour_string.to_string())
    }

    pub fn settings_from_tune_id(&self, tune_id: index::schema::TuneID) -> String {
        // TODO proper error propagation in JSON back to javascript
        let result = self.ff.settings_from_tune_id(tune_id);
        if let Ok(settings) = result {
            return json!(settings).to_string();
        } else {
            json!({
                "error": "Setting ID query error".to_string()
            })
            .to_string()
        }
    }

    pub fn aliases_from_tune_id(&self, tune_id: index::schema::TuneID) -> String {
        // TODO proper error propagation in JSON back to javascript
        let result = self.ff.aliases_from_tune_id(tune_id);
        if let Ok(aliases) = result {
            return json!(aliases).to_string();
        } else {
            json!({
                "error": "Aliases from tune ID query error".to_string()
            })
            .to_string()
        }
    }
}
