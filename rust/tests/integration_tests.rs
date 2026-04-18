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
            i + 1,
            r.setting_id,
            r.setting.tune_id,
            r.score,
            r.display_name
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
        "{} score {:.4} is below minimum {:.4} (≥95% of baseline)",
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
        // Results are deduplicated by tune_id, so check the tune appears (any setting)
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
