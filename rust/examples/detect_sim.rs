//! Synthetic live-session benchmark (not shipped; used to compare live-loop
//! cadences). Synthesises sessions of three real tunes played back to back
//! from stored contours — a DIFFERENT setting of each tune from the one most
//! likely to rank first, with wrong notes, tempo drift and noise — then runs
//! the real DSP transcriber and the real query on the trailing window ending at
//! every whole second, exactly as the app's ring buffer would hold it.
//!
//! Output: JSON lines on stdout, one per session, consumed by the JS side,
//! which replays the live loop's decisions under each cadence.
//!
//! cargo run --release --example detect_sim -- <index.json> <sessions> <seed>

use folkfriend::FolkFriend;
use serde_json::json;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

const SR: u32 = 44_100;
const WINDOW_SECONDS: usize = 10;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn f(&mut self) -> f32 { (self.next() % 1_000_000) as f32 / 1_000_000.0 }
    fn range(&mut self, lo: f32, hi: f32) -> f32 { lo + (hi - lo) * self.f() }
    fn below(&mut self, n: usize) -> usize { (self.next() % n as u64) as usize }
    fn gauss(&mut self) -> f32 {
        let u = self.f().max(1e-6);
        let v = self.f();
        (-2.0 * u.ln()).sqrt() * (2.0 * std::f32::consts::PI * v).cos()
    }
}

fn char_to_midi(c: char) -> Option<f32> {
    let idx = if c.is_ascii_lowercase() { c as u32 - 'a' as u32 }
        else if c.is_ascii_uppercase() { 26 + c as u32 - 'A' as u32 }
        else { return None };
    if idx >= 48 { return None; }
    Some(48.0 + idx as f32)
}

/// One tune played for `seconds`, looping its contour: per-quaver onsets,
/// harmonic tone with vibrato, occasional wrong notes, slow tempo drift.
fn render_tune(contour: &str, seconds: f32, rng: &mut Rng, out: &mut Vec<f32>) {
    let notes: Vec<f32> = contour.chars().filter_map(char_to_midi).collect();
    if notes.is_empty() { return; }
    let base_q = rng.range(0.17, 0.24);
    let total = (seconds * SR as f32) as usize;
    let start = out.len();
    let mut i = 0usize;
    let mut phase = 0.0f32;
    let vib_rate = rng.range(4.5, 6.0);
    while out.len() - start < total {
        let progress = (out.len() - start) as f32 / total as f32;
        let q = base_q * (1.0 + 0.04 * (progress * 6.28).sin()) * (1.0 + 0.03 * rng.gauss());
        let mut midi = notes[i % notes.len()];
        if rng.f() < wrong_note_rate() {
            // A wrong or varied note.
            midi += [-2.0, -1.0, 1.0, 2.0][rng.below(4)];
        }
        let n = (q * SR as f32) as usize;
        let freq = 440.0 * 2f32.powf((midi - 69.0) / 12.0);
        for k in 0..n {
            let t = k as f32 / SR as f32;
            let env = (t / 0.012).min(1.0) * (1.0 - 0.35 * (k as f32 / n as f32))
                * if k + (0.012 * SR as f32) as usize > n { 0.4 } else { 1.0 };
            let vib = 1.0 + 0.004 * (2.0 * std::f32::consts::PI * vib_rate * (out.len() as f32 / SR as f32)).sin();
            phase += 2.0 * std::f32::consts::PI * freq * vib / SR as f32;
            let mut s = 0.0;
            for h in 1..=6 {
                s += (phase * h as f32).sin() / h as f32;
            }
            out.push(0.25 * env * s);
        }
        i += 1;
    }
    out.truncate(start + total);
}

// DETECT_SIM_HARD=1: a noisier room and more wrong notes.
fn hard() -> bool { std::env::var("DETECT_SIM_HARD").map(|v| v == "1").unwrap_or(false) }
fn wrong_note_rate() -> f32 { if hard() { 0.12 } else { 0.05 } }

fn add_noise(signal: &mut [f32], snr_db: f32, rng: &mut Rng) {
    let power: f32 = signal.iter().map(|x| x * x).sum::<f32>() / signal.len() as f32;
    let noise_power = power / 10f32.powf(snr_db / 10.0);
    let sd = noise_power.sqrt();
    // Brown-ish room noise: low-passed white noise, rescaled.
    let mut lp = 0.0f32;
    let mut raw: Vec<f32> = Vec::with_capacity(signal.len());
    for _ in 0..signal.len() {
        lp = 0.9 * lp + 0.1 * rng.gauss();
        raw.push(lp + 0.3 * rng.gauss());
    }
    let rp: f32 = raw.iter().map(|x| x * x).sum::<f32>() / raw.len() as f32;
    let scale = sd / rp.sqrt().max(1e-9);
    for (s, n) in signal.iter_mut().zip(raw) {
        *s += n * scale;
    }
}

fn transcribe_and_query(ff: &mut FolkFriend, pcm: &[f32]) -> serde_json::Value {
    ff.flush_pcm_buffer();
    // The app feeds whole 1024-sample windows and drops the trailing partial one.
    for chunk in pcm.chunks_exact(1024) {
        let mut w = [0f32; 1024];
        w.copy_from_slice(chunk);
        ff.feed_single_pcm_window(w);
    }
    let contour = match ff.transcribe_pcm_buffer() {
        Ok(c) => c,
        Err(_) => return json!({ "contour": "", "results": [] }),
    };
    let results = ff.run_transcription_query(&contour).unwrap_or_default();
    let top: Vec<serde_json::Value> = results.iter().take(20).map(|r| json!({
        "setting_id": r.setting_id.parse::<i64>().unwrap_or(0),
        "setting": { "tune_id": r.setting.tune_id },
        "display_name": r.display_name,
        "score": r.score,
    })).collect();
    json!({ "contourLength": contour.len(), "results": top })
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let index_path = &args[1];
    let sessions: usize = args[2].parse().unwrap();
    let seed: u64 = args[3].parse().unwrap();
    let json = std::fs::read_to_string(index_path).unwrap();

    // Candidate tunes: several settings, a common dance, a contour long enough.
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    let mut by_tune: HashMap<String, Vec<String>> = HashMap::new();
    let settings = parsed["settings"].as_object().unwrap();
    for (sid, s) in settings {
        let dance = s["dance"].as_str().unwrap_or("");
        let len = s["contour"].as_str().unwrap_or("").len();
        if !["reel", "jig", "hornpipe", "polka", "slip jig"].contains(&dance) { continue; }
        if len < 80 || len > 600 { continue; }
        by_tune.entry(s["tune_id"].as_str().unwrap().to_string()).or_default().push(sid.clone());
    }
    let mut tunes: Vec<(String, Vec<String>)> = by_tune.into_iter().filter(|(_, v)| v.len() >= 2).collect();
    tunes.sort();
    for (_, v) in tunes.iter_mut() { v.sort(); }
    eprintln!("{} candidate tunes", tunes.len());

    // Plan every session up front so the result is independent of threading.
    let mut rng = Rng(seed.max(1));
    let mut plans = Vec::new();
    for s in 0..sessions {
        let mut parts = Vec::new();
        for _ in 0..3 {
            let (tid, sids) = &tunes[rng.below(tunes.len())];
            let sid = sids[rng.below(sids.len())].clone();
            let secs = rng.range(45.0, 65.0);
            parts.push((tid.clone(), sid, secs));
        }
        let snr = if hard() { rng.range(0.0, 6.0) } else { rng.range(6.0, 14.0) };
        plans.push((s, parts, snr, rng.next()));
    }
    drop(parsed);

    let queue = Arc::new(Mutex::new(plans));
    let out = Arc::new(Mutex::new(()));
    let threads: Vec<_> = (0..4).map(|_| {
        let queue = queue.clone();
        let out = out.clone();
        let json = json.clone();
        std::thread::spawn(move || {
            let mut ff = FolkFriend::new();
            ff.load_index_from_json_string(json.clone());
            ff.set_sample_rate(SR).unwrap();
            let settings: serde_json::Value = serde_json::from_str(&json).unwrap();
            loop {
                let job = queue.lock().unwrap().pop();
                let (s, parts, snr, seed) = match job { Some(j) => j, None => break };
                let mut rng = Rng(seed.max(1));
                let mut pcm = Vec::new();
                let mut truth = Vec::new();
                for (tid, sid, secs) in &parts {
                    let contour = settings["settings"][sid]["contour"].as_str().unwrap().to_string();
                    let start = pcm.len() as f32 / SR as f32;
                    render_tune(&contour, *secs, &mut rng, &mut pcm);
                    truth.push(json!({ "tuneId": tid, "settingId": sid, "start": start, "end": pcm.len() as f32 / SR as f32 }));
                }
                add_noise(&mut pcm, snr, &mut rng);
                let total = pcm.len() / SR as usize;
                let mut windows = Vec::new();
                for t in 1..=total {
                    let from = t.saturating_sub(WINDOW_SECONDS) * SR as usize;
                    let to = t * SR as usize;
                    let mut w = transcribe_and_query(&mut ff, &pcm[from..to]);
                    w["t"] = json!(t);
                    w["windowSeconds"] = json!((to - from) as f32 / SR as f32);
                    windows.push(w);
                }
                let line = json!({ "session": s, "snr": snr, "truth": truth, "windows": windows });
                let _g = out.lock().unwrap();
                println!("{}", line);
                eprintln!("session {} done", s);
            }
        })
    }).collect();
    for t in threads { t.join().unwrap(); }
}
