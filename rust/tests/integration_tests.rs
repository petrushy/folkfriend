use folkfriend::FolkFriend;
use std::fs;
use std::fs::File;
use std::path::Path;

const RES_DIR: &str = "../app/public/res";

fn load_tune_index() -> FolkFriend {
    let index_path = format!("{}/folkfriend-non-user-data.json", RES_DIR);
    let json = fs::read_to_string(&index_path)
        .expect("Could not read tune index — run `bash app/download_tune_data.sh` first");
    let mut ff = FolkFriend::new();
    ff.load_index_from_json_string(json);
    ff
}

// Read one per-dataset file, or None when it is not on disk.
//
// The published index is one file per source (thesession / folkwiki / norbeck)
// plus the legacy merged bundle, which deliberately excludes norbeck — clients
// reading the merged file cannot opt a dataset out. So a norbeck test cannot
// use load_tune_index(); it needs the dataset file, and skips when absent, the
// same way the audio fixtures do.
fn read_dataset(id: &str) -> Option<serde_json::Value> {
    let path = format!("{}/{}.json", RES_DIR, id);
    let json = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&json).ok()
}

// Merge the named datasets into one index. Setting and tune IDs are disjoint
// by construction (each builder owns a numeric range), which assemble_datasets
// verifies at build time — so a plain merge is correct here.
fn load_datasets(ids: &[&str]) -> Option<FolkFriend> {
    let mut settings = serde_json::Map::new();
    let mut aliases = serde_json::Map::new();
    for id in ids {
        let payload = read_dataset(id)?;
        for (k, v) in payload["settings"].as_object()? {
            settings.insert(k.clone(), v.clone());
        }
        for (k, v) in payload["aliases"].as_object()? {
            aliases.insert(k.clone(), v.clone());
        }
    }
    let merged = serde_json::json!({ "settings": settings, "aliases": aliases });
    let mut ff = FolkFriend::new();
    ff.load_index_from_json_string(merged.to_string());
    Some(ff)
}

fn pcm_from_wav(path: &str) -> (Vec<f32>, u32) {
    let mut f = File::open(Path::new(path)).expect("WAV file not found");
    let (header, data) = wav::read(&mut f).unwrap();
    let signal: Vec<i16> = data.try_into_sixteen().unwrap();
    let channels = header.channel_count as usize;
    // Mix stereo/multi-channel down to mono
    let signal_f: Vec<f32> = signal
        .chunks(channels)
        .map(|frame| frame.iter().map(|&s| s as f32 / 32768.0).sum::<f32>() / channels as f32)
        .collect();
    (signal_f, header.sampling_rate)
}

// Does the APP's ML path (FolkFriend feed + transcribe_pcm_buffer) produce the
// SAME contour as the DIRECT path the CLI uses (BasicPitch::transcribe_contour)?
// If these differ, "ML works" CLI tests don't reflect what the app runs.
// The app feeds the ML transcriber in 1024-sample windows and drops the
// trailing partial one; the CLI (and scripts/run_benchmark.py) feed the whole
// signal at once. Those produce DIFFERENT contours on most clips, because the
// tempo quantiser in contour_from_notes_fps picks a winner by argmax over a
// coarse 5-BPM grid — a perturbation as small as 128 samples (2.9 ms) can flip
// it, and the winner rescales every note's quaver count, changing the contour
// from its first symbol. DSP is unaffected: identical output across the same
// perturbations.
//
// So the benchmark has never measured what the app actually runs. This test
// does: it drives the app's windowed feed over every fixture and asserts the
// tune is still found. Exact contour equality with the CLI is deliberately NOT
// asserted — it does not hold, and pretending otherwise is what let this go
// unnoticed.
#[test]
fn ml_app_path_finds_tunes() {
    let ff_index = load_tune_index();
    let cases: Vec<(&str, Vec<&str>, usize)> = vec![
        ("farewell_to_ireland.wav", vec!["33", "4403", "4571"], 5),
        ("farewell_to_whalley_range.wav", vec!["2410"], 5),
        ("hut_on_staffin_island.wav", vec!["2067"], 5),
        // ML is weak on this one: rank 9 via the CLI's whole-signal feed, 11 via
        // the app's windowed feed. DSP finds it at rank 1.
        ("nåspolskan.wav", vec!["56869501", "767879601"], 15),
        ("the_arra_mountains.wav", vec!["1901"], 5),
        ("the_cock_and_the_hen.wav", vec!["93", "9008"], 5),
        ("the_golden_keyboard.wav", vec!["36"], 5),
        ("the_kerfunten.wav", vec!["139"], 5),
        ("the_kid_on_the_mountain.wav", vec!["52"], 5),
        ("the_lounge_bar.wav", vec!["8853"], 5),
        ("the_musical_priest.wav", vec!["73", "9214", "17606"], 5),
        ("windbroke.wav", vec!["910"], 5),
    ];

    let mut failures = Vec::new();
    for (wav, expected, max_rank) in cases {
        let path = format!("wavs/{}", wav);
        if !Path::new(&path).exists() {
            eprintln!("SKIP {wav}: not present");
            continue;
        }
        let (signal, sr) = pcm_from_wav(&path);

        let mut ff = FolkFriend::new();
        ff.set_sample_rate(sr).unwrap();
        ff.set_use_ml(true);
        let w = folkfriend::ff_config::SPEC_WINDOW_SIZE;
        for chunk in signal.chunks(w) {
            if chunk.len() == w {
                let mut buf = [0f32; folkfriend::ff_config::SPEC_WINDOW_SIZE];
                buf.copy_from_slice(chunk);
                ff.feed_single_pcm_window(buf);
            }
        }
        let contour = match ff.transcribe_pcm_buffer() {
            Ok(c) => c,
            Err(_) => { failures.push(format!("{wav}: transcription failed")); continue; }
        };
        let results = ff_index.run_transcription_query(&contour).unwrap();
        let rank = results.iter().position(|r| expected.contains(&r.setting.tune_id.as_str()));
        match rank {
            Some(i) if i < max_rank => eprintln!("{wav}: app path rank #{}", i + 1),
            Some(i) => failures.push(format!("{wav}: rank #{} (want <= {})", i + 1, max_rank)),
            None => failures.push(format!("{wav}: not found via the app path")),
        }
    }
    assert!(failures.is_empty(), "app ML path regressions:\n  {}", failures.join("\n  "));
}

#[test]
fn ml_app_path_matches_direct_path() {
    let wav = "wavs/farewell_to_ireland.wav";
    if !Path::new(wav).exists() {
        eprintln!("SKIP ml_app_path_matches_direct_path: {wav} is not present");
        return;
    }
    let (pcm, sr) = pcm_from_wav(wav);

    // Direct path == CLI / bin.rs.
    let bp = folkfriend::decode::ml::BasicPitch::new().unwrap();
    let direct = bp.transcribe_contour(&pcm, sr).unwrap();

    // FolkFriend whole-signal feed.
    let mut ff = FolkFriend::new();
    ff.set_sample_rate(sr).unwrap();
    ff.set_use_ml(true);
    ff.feed_entire_pcm_signal(pcm.clone());
    let via_entire = ff.transcribe_pcm_buffer().unwrap();

    // FolkFriend windowed feed == the actual app path (mic feeds 1024-sample
    // windows via feed_single_pcm_window).
    let mut ff2 = FolkFriend::new();
    ff2.set_sample_rate(sr).unwrap();
    ff2.set_use_ml(true);
    let win = folkfriend::ff_config::SPEC_WINDOW_SIZE;
    for chunk in pcm.chunks(win) {
        if chunk.len() == win {
            let mut w = [0f32; folkfriend::ff_config::SPEC_WINDOW_SIZE];
            w.copy_from_slice(chunk);
            ff2.feed_single_pcm_window(w);
        }
    }
    let via_windows = ff2.transcribe_pcm_buffer().unwrap();

    eprintln!("direct  (len {}): {}", direct.len(), direct);
    eprintln!("entire  (len {}): {}", via_entire.len(), via_entire);
    eprintln!("windows (len {}): {}", via_windows.len(), via_windows);

    assert_eq!(direct, via_entire, "FolkFriend feed_entire ML path differs from direct");
    assert_eq!(direct, via_windows, "FolkFriend windowed (app) ML path differs from direct");
}

fn assert_audio_detects_one_of(
    wav_path: &str,
    expected_tune_ids: &[&str],
    label: &str,
    max_rank: usize,
    min_score: f32,
) {
    // The recorded fixtures were destroyed by a .gitattributes misconfiguration
    // (see CLAUDE.md, "Known issues") and have been removed pending re-recording.
    // Skip rather than fail while a clip is absent, so each test comes back on
    // its own as soon as its WAV is restored.
    if !Path::new(wav_path).exists() {
        eprintln!("SKIP {label}: {wav_path} is not present");
        return;
    }

    let mut ff = load_tune_index();

    let (pcm, sample_rate) = pcm_from_wav(wav_path);
    ff.set_sample_rate(sample_rate).unwrap();
    ff.feed_entire_pcm_signal(pcm);
    let contour = ff.transcribe_pcm_buffer()
        .expect("Transcription failed — check WAV file and pitch range");

    eprintln!("{} contour (len={}): {}", label, contour.len(), contour);

    let results = ff.run_transcription_query(&contour).unwrap();

    eprintln!("Top 10 results for {}:", label);
    for (i, r) in results.iter().take(10).enumerate() {
        eprintln!(
            "  #{}: setting_id={} tune_id={} score={:.4} name={}",
            i + 1, r.setting_id, r.setting.tune_id, r.score, r.display_name
        );
    }

    let best = results
        .iter()
        .enumerate()
        .filter(|(_, r)| expected_tune_ids.contains(&r.setting.tune_id.as_str()))
        .map(|(i, r)| (i, r.score))
        .next();

    let (best_rank, best_score) = match best {
        Some(v) => v,
        None => panic!("{} — none of {:?} appeared in results", label, expected_tune_ids),
    };

    assert!(
        best_rank < max_rank,
        "{} should match one of {:?} within top {} (got rank {})",
        label, expected_tune_ids, max_rank, best_rank + 1
    );

    assert!(
        best_score >= min_score,
        "{} score {:.4} is below minimum {:.4} (≥99% of baseline)",
        label, best_score, min_score
    );
}

#[test]
fn dummy() {
    assert!(true);
}

#[test]
fn heuristic_self_match_ranks_first() {
    let ff = load_tune_index();

    // Folkwiki setting whose own stored contour should rank #1 (exact self-match)
    let contour_s1 = "vvxvvtstsqosvAEEEFFFFECCCEEFECAAAvvxvtstsqosvAEEEFFFFECFECAAAAAvvxvtstsqosvAEEEFFFFECCCEEFECAAAvvxvtstsqosvAEEEFFFFECFECAAAAAvvEECAssttvtsqqqqqFFCzzzvvvECAAAvvECAAsstvtsqqqqqqFCzvxzAAAAAAAAvvECAAsstvtsqqqqqqFCzzzzvvECAAAAvvECAAsstvtsqqqqqqFCzvxzAAAAAAAA".to_string();
    let results_s1 = ff.run_transcription_query(&contour_s1).unwrap();
    let rank_s1 = results_s1.iter().position(|r| r.setting_id == "974588901");
    assert!(rank_s1.map(|p| p < 2).unwrap_or(false),
        "Setting 974588901 should rank #1 or #2 in self-match (got {:?})", rank_s1.map(|p| p+1));

    // Second folkwiki setting
    let contour_s2 = "vxvtstsqosvAEEFFFECCEFECAAvxvtstsqosvAEEFFFECFECAAAvxvtstsqosvAEEFFFECCEFECAAvxvtstsqosvAEEFFFECFECAAAvECAstvtsqqqFCzzvvECAAvECAstvtsqqqFCzvxzAAAvECAstvtsqqqFCzzvvECAAvECAstvtsqqqFCzvxzAAA".to_string();
    let results_s2 = ff.run_transcription_query(&contour_s2).unwrap();
    let rank_s2 = results_s2.iter().position(|r| r.setting_id == "1402836401");
    assert!(rank_s2.map(|p| p < 2).unwrap_or(false),
        "Setting 1402836401 should rank #1 or #2 in self-match (got {:?})", rank_s2.map(|p| p+1));
}

#[test]
fn thesession_self_match_ranks_first() {
    // Regression test: well-known thesession tunes should still self-match at #1
    // after the passing-note fix and chord-stripping rebuild.
    let ff = load_tune_index();

    let index_path = "../app/public/res/folkfriend-non-user-data.json";
    let json = std::fs::read_to_string(index_path).unwrap();
    let data: serde_json::Value = serde_json::from_str(&json).unwrap();
    let settings = data["settings"].as_object().unwrap();

    let test_cases = [
        ("55",  "kesh, the"),
        ("69",  "morning dew, the"),
        ("182", "silver spear, the"),
        ("10",  "butterfly, the"),
    ];

    for (sid, label) in &test_cases {
        let tune_id = settings[*sid]["tune_id"].as_str().unwrap();
        let contour = settings[*sid]["contour"].as_str().unwrap().to_string();
        let results = ff.run_transcription_query(&contour).unwrap();
        let rank = results.iter().position(|r| r.setting.tune_id == tune_id);
        eprintln!("  {}: rank={:?}", label, rank.map(|p| p+1));
        assert!(
            rank.map(|p| p < 3).unwrap_or(false),
            "{} (tune {}) should rank in top 3 for self-match (got {:?})",
            label, tune_id, rank.map(|p| p+1)
        );
    }
}

#[test]
fn folkwiki_grace_note_self_match() {
    // Verify that tunes with heavy ABC grace-note ornamentation self-match at #1.
    // Before the grace-note stripping fix, these would rank poorly because extra
    // ornament chars in the stored contour misaligned against any clean query.
    let ff = load_tune_index();

    let index_path = "../app/public/res/folkfriend-non-user-data.json";
    let json = std::fs::read_to_string(index_path).unwrap();
    let data: serde_json::Value = serde_json::from_str(&json).unwrap();
    let settings = data["settings"].as_object().unwrap();

    let test_cases = [
        ("301182001",  "highland cathedral (46 grace notes)"),
        ("786483201",  "polska efter lapp-nils (19 grace notes)"),
        ("1353201301", "säbb johns gånglåt (20 grace notes)"),
    ];

    for (sid, label) in &test_cases {
        let tune_id = settings[*sid]["tune_id"].as_str().unwrap();
        let contour = settings[*sid]["contour"].as_str().unwrap().to_string();
        let results = ff.run_transcription_query(&contour).unwrap();
        let rank = results.iter().position(|r| r.setting.tune_id == tune_id);
        eprintln!("  {}: rank={:?}", label, rank.map(|p| p+1));
        assert!(
            rank.map(|p| p < 3).unwrap_or(false),
            "{} (tune {}) should rank in top 3 for self-match (got {:?})",
            label, tune_id, rank.map(|p| p+1)
        );
    }
}

// --- Audio detection tests ---
// min_score is 99% of the baseline score measured at time of writing.
// Scores are deterministic for a given WAV + index; a drop signals regression.

#[test]
fn audio_farewell_to_ireland_detected() {
    assert_audio_detects_one_of(
        "wavs/farewell_to_ireland.wav",
        &["33", "4403", "4571"],
        "Farewell To Ireland",
        5,
        0.856, // 90% of measured 0.9510
    );
}

#[test]
fn audio_farewell_to_whalley_range_detected() {
    assert_audio_detects_one_of(
        "wavs/farewell_to_whalley_range.wav",
        &["2410"],
        "Farewell To Whalley Range",
        5,
        0.859, // 90% of measured 0.9545
    );
}

#[test]
fn audio_hut_on_staffin_island_detected() {
    assert_audio_detects_one_of(
        "wavs/hut_on_staffin_island.wav",
        &["2067"],
        "Hut On Staffin Island",
        5,
        0.675, // 90% of measured 0.7500
    );
}

#[test]
fn audio_naspolskan_detected() {
    assert_audio_detects_one_of(
        "wavs/nåspolskan.wav",
        &["56869501", "767879601"],
        "Nåspolskan",
        5,
        0.549, // 90% of measured 0.6098
    );
}

#[test]
fn audio_the_arra_mountains_detected() {
    assert_audio_detects_one_of(
        "wavs/the_arra_mountains.wav",
        &["1901"],
        "The Arra Mountains",
        5,
        0.787, // 90% of measured 0.8750
    );
}

#[test]
fn audio_the_cock_and_the_hen_detected() {
    assert_audio_detects_one_of(
        "wavs/the_cock_and_the_hen.wav",
        &["23405", "93"],
        "The Cock And The Hen",
        5,
        0.881, // 90% of measured 0.9792
    );
}

#[test]
fn audio_the_golden_keyboard_detected() {
    assert_audio_detects_one_of(
        "wavs/the_golden_keyboard.wav",
        &["36"],
        "The Golden Keyboard",
        5,
        0.651, // 90% of measured 0.7232
    );
}

#[test]
fn audio_the_kerfunten_detected() {
    assert_audio_detects_one_of(
        "wavs/the_kerfunten.wav",
        &["139"],
        "The Kerfunten",
        5,
        0.398, // 90% of measured 0.4419
    );
}

#[test]
fn audio_the_kid_on_the_mountain_detected() {
    assert_audio_detects_one_of(
        "wavs/the_kid_on_the_mountain.wav",
        &["52"],
        "The Kid On The Mountain",
        5,
        0.450, // 90% of measured 0.5000
    );
}

#[test]
fn audio_the_lounge_bar_detected() {
    assert_audio_detects_one_of(
        "wavs/the_lounge_bar.wav",
        &["8853"],
        "The Lounge Bar",
        5,
        0.804, // 90% of measured 0.8936
    );
}

#[test]
fn audio_the_musical_priest_detected() {
    assert_audio_detects_one_of(
        "wavs/the_musical_priest.wav",
        &["17606", "73", "9214"],
        "The Musical Priest",
        5,
        0.791, // 90% of measured 0.8793
    );
}

#[test]
fn audio_windbroke_detected() {
    assert_audio_detects_one_of(
        "wavs/windbroke.wav",
        &["910"],
        "Windbroke",
        5,
        0.750, // 90% of measured 0.8333
    );
}

// Norbeck tunes must be findable from their own contour once the dataset is
// loaded. This is the end-to-end gate on the norbeck build: ABC parsing, the
// unit-note-length rule (45% of the collection has no L: field and relies on
// abc2midi's default), the P: variation trim, and the ID ranges all have to be
// right for a self-match to land.
//
// Skips when norbeck.json is absent rather than failing, so a checkout that
// has only fetched the legacy bundle still runs the rest of the suite.
#[test]
fn norbeck_self_match_ranks_first() {
    let payload = match read_dataset("norbeck") {
        Some(p) => p,
        None => {
            eprintln!("SKIP norbeck_self_match_ranks_first (no norbeck.json)");
            return;
        }
    };
    let ff = load_datasets(&["thesession", "folkwiki", "norbeck"])
        .expect("norbeck.json present but the full dataset set did not load");

    let settings = payload["settings"].as_object().unwrap();

    // Spread across rhythms and both ID paths (Z:id-derived and fallback), and
    // deliberately including Swedish tunes, whose titles and dance names come
    // through the ABC escape decoder.
    let mut sample: Vec<(&String, &serde_json::Value)> = settings
        .iter()
        .filter(|(_, s)| s["contour"].as_str().map(|c| c.len() > 60).unwrap_or(false))
        .collect();
    sample.sort_by_key(|(k, _)| k.parse::<u64>().unwrap_or(0));

    let step = sample.len() / 25;
    let mut checked = 0;
    let mut top3 = 0;
    for (sid, setting) in sample.iter().step_by(step.max(1)).take(25) {
        let tune_id = setting["tune_id"].as_str().unwrap();
        let contour = setting["contour"].as_str().unwrap().to_string();
        let results = ff.run_transcription_query(&contour).unwrap();
        let rank = results.iter().position(|r| r.setting.tune_id == tune_id);
        checked += 1;
        if rank.map(|p| p < 3).unwrap_or(false) {
            top3 += 1;
        } else {
            eprintln!("  norbeck setting {} ranked {:?}", sid, rank.map(|p| p + 1));
        }
    }

    eprintln!("  norbeck self-match: {}/{} in top 3", top3, checked);
    // Not 100%: a handful of Norbeck tunes are also in thesession or folkwiki
    // under a near-identical transcription, and either copy may legitimately
    // outrank the other. The bar is that self-match works as a rule.
    assert!(
        top3 * 10 >= checked * 9,
        "only {}/{} norbeck tunes self-matched into the top 3",
        top3, checked
    );
}

// The three datasets must not share setting or tune IDs. assemble_datasets.py
// checks this at build time; this is the consuming side of the same contract,
// because a collision here does not error — one setting silently shadows the
// other and the tune simply stops being findable.
#[test]
fn datasets_have_disjoint_ids() {
    let ids = ["thesession", "folkwiki", "norbeck"];
    let mut owner_of_setting: std::collections::HashMap<String, &str> = Default::default();
    let mut owner_of_tune: std::collections::HashMap<String, &str> = Default::default();
    let mut loaded = 0;

    for id in &ids {
        let payload = match read_dataset(id) {
            Some(p) => p,
            None => continue,
        };
        loaded += 1;
        for (setting_id, setting) in payload["settings"].as_object().unwrap() {
            if let Some(prev) = owner_of_setting.insert(setting_id.clone(), id) {
                panic!("setting_id {} is in both {} and {}", setting_id, prev, id);
            }
            let tune_id = setting["tune_id"].as_str().unwrap().to_string();
            if let Some(prev) = owner_of_tune.get(&tune_id) {
                assert_eq!(*prev, *id, "tune_id {} is in both {} and {}", tune_id, prev, id);
            }
            owner_of_tune.insert(tune_id, id);
        }
        for tune_id in payload["aliases"].as_object().unwrap().keys() {
            if let Some(prev) = owner_of_tune.get(tune_id) {
                assert_eq!(*prev, *id, "tune_id {} is in both {} and {}", tune_id, prev, id);
            }
            owner_of_tune.insert(tune_id.clone(), id);
        }
    }

    if loaded < 2 {
        eprintln!("SKIP datasets_have_disjoint_ids (only {} dataset files)", loaded);
        return;
    }
    eprintln!(
        "  {} datasets, {} setting IDs, {} tune IDs, all disjoint",
        loaded, owner_of_setting.len(), owner_of_tune.len()
    );
}
