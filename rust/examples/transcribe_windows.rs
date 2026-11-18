//! Transcribes the trailing window of a recording every `step` seconds, in
//! parallel, and prints `{t, contour, windowSeconds}` JSON lines — the input
//! `requery` searches. The same windows `detect_sim --wav` produces, without
//! the (slow) search, so transcriber changes can be benchmarked in seconds.
//!
//!   cargo run --release --example transcribe_windows -- session.wav [step] [window] > windows.jsonl

use folkfriend::FolkFriend;
use rayon::prelude::*;
use serde_json::json;
use std::convert::TryInto;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let step: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(2);
    let window: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(10);
    let bytes = std::fs::read(&args[1]).expect("read wav");
    assert!(&bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE", "not a WAV file");
    let (mut rate, mut channels, mut bits, mut data) = (0u32, 1u16, 16u16, &bytes[0..0]);
    let mut at = 12;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
        let body = &bytes[at + 8..(at + 8 + size).min(bytes.len())];
        if id == b"fmt " {
            channels = u16::from_le_bytes([body[2], body[3]]);
            rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
            bits = u16::from_le_bytes([body[14], body[15]]);
        } else if id == b"data" {
            data = body;
        }
        at += 8 + size + (size & 1);
    }
    assert!(bits == 16 && rate > 0, "only 16-bit PCM WAV is supported");
    let frame = 2 * channels as usize;
    let pcm: Vec<f32> = data
        .chunks_exact(frame)
        .map(|f| i16::from_le_bytes([f[0], f[1]]) as f32 / 32768.0)
        .collect();
    let seconds = pcm.len() / rate as usize;
    let ts: Vec<usize> = (step..=seconds).step_by(step).collect();
    let lines: Vec<String> = ts
        .par_iter()
        .map_init(
            || {
                let mut ff = FolkFriend::new();
                ff.set_sample_rate(rate).unwrap();
                // TW_ML=1: the opt-in ML (basic-pitch) transcriber instead of DSP.
                ff.set_use_ml(std::env::var("TW_ML").map(|v| v == "1").unwrap_or(false));
                ff
            },
            |ff, &t| {
                let from = t.saturating_sub(window) * rate as usize;
                let to = t * rate as usize;
                ff.flush_pcm_buffer();
                for chunk in pcm[from..to].chunks_exact(1024) {
                    ff.feed_single_pcm_window(chunk.try_into().unwrap());
                }
                let contour = ff.transcribe_pcm_buffer().unwrap_or_default();
                json!({ "t": t, "contour": contour, "windowSeconds": (to - from) as f32 / rate as f32 }).to_string()
            },
        )
        .collect();
    for l in lines {
        println!("{}", l);
    }
}
