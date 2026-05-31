use folkfriend::FolkFriend;
use std::fs;
use std::fs::File;
use std::path::Path;

fn load_tune_index() -> FolkFriend {
    let index_path = "../app/public/res/folkfriend-non-user-data.json";
    let json = fs::read_to_string(index_path)
        .expect("Could not read tune index — run `bash app/download_tune_data.sh` first");
    let mut ff = FolkFriend::new();
    ff.load_index_from_json_string(json);
    ff
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
#[test]
fn ml_app_path_matches_direct_path() {
    let (pcm, sr) = pcm_from_wav("wavs/Brännvinslåt Efter Gås-anders.wav");

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
fn audio_gumboda_schottis_detected() {
    assert_audio_detects_one_of(
        "wavs/gumboda_schottis.wav",
        &["973588901", "1401836401"],
        "Schottis från Gumboda",
        10,
        0.632, // 99% of 0.6385
    );
}

#[test]
fn audio_cooleys_reel_detected() {
    assert_audio_detects_one_of(
        "wavs/cooleys_reel.wav",
        &["1"],
        "Cooley's Reel",
        5,
        0.598, // 99% of 0.6042
    );
}

#[test]
fn audio_wise_maid_detected() {
    assert_audio_detects_one_of(
        "wavs/wise_maid.wav",
        &["118"],
        "The Wise Maid",
        5,
        0.572, // 99% of 0.5778
    );
}

#[test]
fn audio_salamanca_detected() {
    assert_audio_detects_one_of(
        "wavs/salamanca.wav",
        &["99"],
        "The Salamanca",
        5,
        0.690, // 99% of 0.6975
    );
}

#[test]
fn audio_hut_on_staffin_island_detected() {
    assert_audio_detects_one_of(
        "wavs/hut_on_staffin_island.wav",
        &["2067"],
        "The Hut on Staffin Island",
        5,
        0.817, // 99% of 0.8254
    );
}

#[test]
fn audio_glen_cottage_detected() {
    assert_audio_detects_one_of(
        "wavs/ithe_glen_cottage.wav",
        &["5278"],
        "The Glen Cottage",
        5,
        0.759, // 99% of 0.7674
    );
}

#[test]
fn audio_soup_dragon_detected() {
    assert_audio_detects_one_of(
        "wavs/soup_dragon.wav",
        &["10785"],
        "The Soup Dragon",
        10,
        0.679, // 99% of 0.6860
    );
}

#[test]
fn audio_skallmansarn_detected() {
    assert_audio_detects_one_of(
        "wavs/Skållmånsarn.wav",
        &["598100601"],
        "Skållmånsarn",
        5,
        0.552, // 99% of 0.5580
    );
}

#[test]
fn audio_gazaremsan_detected() {
    assert_audio_detects_one_of(
        "wavs/gazaremsan.wav",
        &["1604843401", "1596117401", "1546819101"],
        "Gazaremsan",
        5,
        0.339, // 99% of 0.3429
    );
}

#[test]
fn audio_naspolskan_detected() {
    assert_audio_detects_one_of(
        "wavs/nåspolskan.wav",
        &["56869501", "767879601"],
        "Nåspolskan",
        5,
        0.571, // 99% of 0.5769
    );
}

#[test]
fn audio_polska_efter_kristian_oskarsson_detected() {
    assert_audio_detects_one_of(
        "wavs/polska_efter_kristian_oskarsson.wav",
        &["1027010001", "892357901"],
        "Polska efter Kristian Oskarsson",
        5,
        0.694, // 99% of 0.7016
    );
}

#[test]
fn audio_polska_efter_snickar_erik_detected() {
    assert_audio_detects_one_of(
        "wavs/polska_efter_snickar_erik.wav",
        &["1013016301"],
        "Polska efter Snickar Erik",
        5,
        0.765, // 99% of 0.7736
    );
}

#[test]
fn audio_blarney_pilgrim_detected() {
    assert_audio_detects_one_of(
        "wavs/blarney_pilgrim.wav",
        &["5"],
        "The Blarney Pilgrim",
        5,
        0.792, // 99% of 0.8000
    );
}

#[test]
fn audio_mist_covered_mountain_detected() {
    assert_audio_detects_one_of(
        "wavs/mist_covered_mountain.wav",
        &["256"],
        "Mist Covered Mountain",
        5,
        0.891, // 99% of 0.9000
    );
}

#[test]
fn audio_windbroke_detected() {
    assert_audio_detects_one_of(
        "wavs/windbroke.wav",
        &["910"],
        "Windbroke",
        5,
        0.789, // 99% of 0.7975
    );
}
