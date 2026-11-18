//! Re-runs the contour query over windows already transcribed by
//! `detect_sim --wav` (their `contour` field), with experimental scoring knobs,
//! and writes the same JSON-lines format so scoreTaggedSession.mjs can score it.
//! Transcription is the slow half of a benchmark; this lets the query side be
//! varied in seconds.
//!
//!   cargo run --release --example requery -- index.json windows.jsonl > out.jsonl
//!
//! Knobs (environment variables; defaults reproduce the shipped query exactly,
//! which `RQ_LIB=1` checks by running the library's own query instead):
//!   RQ_MATCH, RQ_MISMATCH, RQ_GAP   NW scores (2, -2, -1.5; the library doubles them)
//!   RQ_SEMI      substitution score for a note one semitone off (= RQ_MISMATCH)
//!   RQ_OCT12     substitution score for a note an octave off (= RQ_MISMATCH)
//!   RQ_RUNGAP    gap score when the skipped note repeats its neighbour, i.e. a
//!                duration error rather than a missing note (= RQ_GAP)
//!   RQ_OCTAVE=1  also search the contour an octave up and down; keep the best
//!   RQ_REPASS    heuristic shortlist size (2000); 0 = score every setting
//!   RQ_NGRAM     heuristic n-gram size (4)
//!   RQ_NORM      `short` (shipped: by the shorter string), `query` (by the query)
//!   RQ_LOOP=0    align against the stored contour alone, not followed by its
//!                opening (the shipped query wraps a window across the repeat)
//!   RQ_LIB=1     run folkfriend's own query (QueryEngine), ignoring the knobs
//!
//! Before 1.5.0 the shipped query was RQ_GAP=-1 RQ_LOOP=0.

use rayon::prelude::*;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Write};

fn env_f(name: &str, default: f32) -> f32 {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}
fn env_u(name: &str, default: usize) -> usize {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}
fn env_b(name: &str) -> bool {
    std::env::var(name).map(|v| v == "1").unwrap_or(false)
}

#[derive(Clone, Copy)]
struct Knobs {
    m: f32,
    mm: f32,
    semi: f32,
    oct: f32,
    gap: f32,
    rungap: f32,
    norm_query: bool,
}

fn dedup_runs(s: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len());
    for &c in s {
        if out.last() != Some(&c) {
            out.push(c);
        }
    }
    out
}

fn pitch(c: u8) -> i32 {
    if c.is_ascii_lowercase() { (c - b'a') as i32 } else { 26 + (c - b'A') as i32 }
}
fn from_pitch(p: i32) -> Option<u8> {
    if p < 0 || p >= 48 { None } else if p < 26 { Some(b'a' + p as u8) } else { Some(b'A' + (p - 26) as u8) }
}

/// The shipped needleman_wunsch, recurrence and quirks included (free leading
/// gaps on both strings, a running max in the last column), generalised to
/// real-valued scores, a semitone substitution and a cheaper duration gap.
fn nw(q: &[u8], s: &[u8], k: &Knobs) -> f32 {
    if q.is_empty() || s.is_empty() {
        return 0.0;
    }
    let query_len = q.len() as f32;
    let (a, b) = if q.len() > s.len() { (s, q) } else { (q, s) };
    let mut last_row = vec![0f32; a.len() + 1];
    let last = a.len();
    for row in 0..b.len() {
        let mut prev_diag = 0f32;
        // Skipping b[row] is a duration error when it repeats b[row - 1].
        let gap_b = if row > 0 && b[row] == b[row - 1] { k.rungap } else { k.gap };
        for col in 1..last_row.len() {
            let curr_diag = prev_diag;
            prev_diag = last_row[col];
            let sub = if a[col - 1] == b[row] {
                k.m
            } else if (pitch(a[col - 1]) - pitch(b[row])).abs() == 1 {
                k.semi
            } else if (pitch(a[col - 1]) - pitch(b[row])).abs() == 12 {
                k.oct
            } else {
                k.mm
            };
            let gap_a = if col > 1 && a[col - 1] == a[col - 2] { k.rungap } else { k.gap };
            let v = (curr_diag + sub).max((last_row[col - 1] + gap_a).max(last_row[col] + gap_b));
            last_row[col] = v;
            if prev_diag > last_row[last] {
                last_row[last] = prev_diag;
            }
        }
    }
    let high = last_row.iter().cloned().fold(0f32, f32::max);
    let norm = if k.norm_query { query_len } else { a.len() as f32 };
    0.5 * (high * 2.0 / k.m) / norm
}

fn ngrams(q: &[u8], n: usize) -> Vec<Vec<u8>> {
    if q.len() < n {
        return vec![q.to_vec()];
    }
    let mut seen = HashSet::new();
    (0..=q.len() - n).map(|i| q[i..i + n].to_vec()).filter(|g| seen.insert(g.clone())).collect()
}

struct Index {
    ids: Vec<String>,
    tune: Vec<String>,
    contour: Vec<Vec<u8>>,
    looped: Vec<Vec<u8>>,
    deduped: Vec<Vec<u8>>,
    names: HashMap<String, String>,
}

fn heuristic(q: &[u8], idx: &Index, repass: usize, n: usize) -> Vec<usize> {
    if repass == 0 {
        return (0..idx.ids.len()).collect();
    }
    let qd = dedup_runs(q);
    let grams = ngrams(&qd, n);
    let ac = aho_corasick::AhoCorasick::new_auto_configured(&grams);
    let mut ranked: Vec<(usize, usize)> = Vec::new();
    for (i, c) in idx.deduped.iter().enumerate() {
        let mut m = HashSet::new();
        for hit in ac.find_overlapping_iter(c) {
            m.insert(hit.pattern());
        }
        if !m.is_empty() {
            ranked.push((i, m.len()));
        }
    }
    ranked.sort_by(|x, y| y.1.cmp(&x.1).then_with(|| idx.ids[x.0].cmp(&idx.ids[y.0])));
    if ranked.len() > repass {
        let cutoff = ranked[repass - 1].1;
        let max_end = ranked.len().min(6000);
        let mut end = repass;
        while end < max_end && ranked[end].1 >= cutoff {
            end += 1;
        }
        ranked.truncate(end);
    }
    ranked.into_iter().map(|(i, _)| i).collect()
}

fn query(q: &[u8], idx: &Index, k: &Knobs, repass: usize, n: usize, octave: bool, looped: bool) -> Vec<Value> {
    let mut variants: Vec<Vec<u8>> = vec![q.to_vec()];
    if octave {
        for shift in [-12, 12] {
            let v: Option<Vec<u8>> = q.iter().map(|&c| from_pitch(pitch(c) + shift)).collect();
            if let Some(v) = v {
                variants.push(v);
            }
        }
    }
    let mut best: HashMap<usize, f32> = HashMap::new();
    for v in &variants {
        for i in heuristic(v, idx, repass, n) {
            // Looped: the stored contour followed by its own opening, long enough
            // for a window that runs from the end of one time through into the
            // start of the next (1.5 x the query covers its gaps too).
            let len = idx.contour[i].len();
            let s = if looped {
                nw(v, &idx.looped[i][..len + (v.len() * 3 / 2).min(len)], k)
            } else {
                nw(v, &idx.contour[i], k)
            };
            let e = best.entry(i).or_insert(f32::NEG_INFINITY);
            if s > *e {
                *e = s;
            }
        }
    }
    let mut scored: Vec<(usize, f32)> = best.into_iter().collect();
    scored.sort_by(|x, y| y.1.total_cmp(&x.1).then_with(|| idx.ids[x.0].cmp(&idx.ids[y.0])));
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for (i, s) in scored {
        if !seen.insert(idx.tune[i].clone()) {
            continue;
        }
        let name = match idx.names.get(&idx.tune[i]) { Some(n) => n.clone(), None => continue };
        out.push(json!({
            "setting_id": idx.ids[i].parse::<i64>().unwrap_or(0),
            "tune_id": idx.tune[i],
            "display_name": name,
            "score": s,
        }));
        if out.len() >= 20 {
            break;
        }
    }
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let raw: Value = serde_json::from_str(&std::fs::read_to_string(&args[1]).unwrap()).unwrap();
    let mut idx = Index { ids: vec![], tune: vec![], contour: vec![], looped: vec![], deduped: vec![], names: HashMap::new() };
    for (sid, s) in raw["settings"].as_object().unwrap() {
        let c = s["contour"].as_str().unwrap_or("").as_bytes().to_vec();
        idx.ids.push(sid.clone());
        idx.tune.push(s["tune_id"].as_str().unwrap().to_string());
        idx.deduped.push(dedup_runs(&c));
        let mut l = c.clone();
        l.extend_from_slice(&c);
        idx.looped.push(l);
        idx.contour.push(c);
    }
    for (tid, names) in raw["aliases"].as_object().unwrap() {
        if let Some(n) = names.get(0).and_then(|n| n.as_str()) {
            idx.names.insert(tid.clone(), n.to_string());
        }
    }
    drop(raw);
    let mm = env_f("RQ_MISMATCH", -2.0);
    let gap = env_f("RQ_GAP", -1.5);
    let k = Knobs {
        m: env_f("RQ_MATCH", 2.0),
        mm,
        semi: env_f("RQ_SEMI", mm),
        oct: env_f("RQ_OCT12", mm),
        gap,
        rungap: env_f("RQ_RUNGAP", gap),
        norm_query: std::env::var("RQ_NORM").map(|v| v == "query").unwrap_or(false),
    };
    let repass = env_u("RQ_REPASS", 2000);
    let n = env_u("RQ_NGRAM", 4);
    let octave = env_b("RQ_OCTAVE");
    let looped = std::env::var("RQ_LOOP").map(|v| v != "0").unwrap_or(true);

    let lib = if env_b("RQ_LIB") {
        let mut ff = folkfriend::FolkFriend::new();
        ff.load_index_from_json_string(std::fs::read_to_string(&args[1]).unwrap());
        Some(ff)
    } else {
        None
    };

    let file = std::fs::File::open(&args[2]).unwrap();
    let lines: Vec<Value> = std::io::BufReader::new(file)
        .lines()
        .map(|l| serde_json::from_str(&l.unwrap()).unwrap())
        .collect();
    let out: Vec<Value> = lines
        .into_par_iter()
        .map(|mut w| {
            let c = w["contour"].as_str().unwrap_or("").to_string();
            if c.is_empty() {
                return w;
            }
            w["results"] = match &lib {
                Some(ff) => json!(ff.run_transcription_query(&c).unwrap_or_default().iter().take(20).map(|r| json!({
                    "setting_id": r.setting_id.parse::<i64>().unwrap_or(0),
                    "tune_id": r.setting.tune_id,
                    "display_name": r.display_name,
                    "score": r.score,
                })).collect::<Vec<_>>()),
                None => json!(query(c.as_bytes(), &idx, &k, repass, n, octave, looped)),
            };
            w
        })
        .collect();
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    for w in out {
        writeln!(lock, "{}", w).unwrap();
    }
}
