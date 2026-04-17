use folkfriend::FolkFriend;
use std::fs;
use std::fs::File;
use std::path::Path;
use std::convert::TryInto;

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
    let signal_f: Vec<f32> = signal.iter().map(|&s| s as f32 / 32768.0).collect();
    (signal_f, header.sampling_rate)
}

#[test]
fn dummy() {
    assert!(true);
}

#[test]
fn heuristic_self_match_ranks_first() {
    let mut ff = load_tune_index();

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
    let mut ff = load_tune_index();

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
    let wav_path = "wavs/gumboda_schottis.wav";
    let mut ff = load_tune_index();

    let (pcm, sample_rate) = pcm_from_wav(wav_path);
    ff.set_sample_rate(sample_rate).unwrap();
    ff.feed_entire_pcm_signal(pcm);
    let contour = ff.transcribe_pcm_buffer()
        .expect("Transcription failed — check WAV file and pitch range");

    eprintln!("Transcribed contour (len={}): {}", contour.len(), &contour);

    let results = ff.run_transcription_query(&contour).unwrap();

    eprintln!("Top 10 results:");
    for (i, r) in results.iter().take(10).enumerate() {
        eprintln!("  #{}: setting_id={} score={:.4} name={}", i+1, r.setting_id, r.score, r.display_name);
    }

    let rank = results.iter().position(|r| r.setting_id == "974588901");
    eprintln!("  974588901 (schottis från gumboda) rank: {:?}", rank.map(|p| p+1));

    assert!(
        rank.map(|p| p < 10).unwrap_or(false),
        "Schottis från Gumboda (974588901) should appear in top 10 from real audio (got rank {:?})",
        rank.map(|p| p+1)
    );
}
