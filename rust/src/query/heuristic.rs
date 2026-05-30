/// Heuristic first-pass query.
///
/// Reduces ~60 k candidates to a shortlist of ~2000 using fast Aho-Corasick
/// n-gram matching.  The shortlist is then re-scored by the slower but accurate
/// Needleman-Wunsch aligner in `mod.rs`.
///
/// Key design choices:
/// - `dedup_runs` collapses consecutive identical characters before n-gram matching
///   to bridge the density mismatch between stored contours (where a long note may
///   be 4 chars) and audio queries (always 1 char per detected note).
/// - Query n-grams are deduplicated so a pattern repeated in the query counts once
///   per candidate, not once per repetition.
/// - Candidates are scored by the count of *distinct* query n-gram patterns found,
///   not by raw overlapping match count.  Raw counts reward long/repetitive stored
///   contours disproportionately — before this fix, an exact self-match ranked #94.
use crate::ff_config;
use crate::index::schema::*;
use crate::index::TuneIndex;
use aho_corasick::{AhoCorasick, Match};
use std::collections::HashMap;

pub struct ScoredName {
    pub tune_id: TuneID,
    pub alias_index: usize,
    pub ngram_score: f32,
}

/// Collapse consecutive identical characters: "vvvvssssoo" → "vsо".
/// Both folkwiki stored contours (L:1/16, 4 chars/note) and audio queries
/// (1 char/note) collapse to the same pitch sequence, fixing the mismatch.
pub fn dedup_runs(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut last = '\0';
    for c in s.chars() {
        if c != last {
            result.push(c);
            last = c;
        }
    }
    result
}

pub fn run_transcription_query(
    query: &String,
    tune_index: &TuneIndex,
) -> Vec<(SettingID, usize)> {
    // Collapse runs so folkwiki stored contours (4 chars/note due to L:1/16)
    // and audio query contours (1 char/note) use the same representation.
    let query = dedup_runs(query);

    // Deduplicate query n-grams: repeated patterns in the query (common in
    // repetitive tunes) must not be counted multiple times per candidate.
    let raw_ngrams = ngrams_str(&query, ff_config::QUERY_NGRAM_SIZE_CONTOUR);
    let mut seen = std::collections::HashSet::new();
    let ngrams: Vec<String> = raw_ngrams
        .into_iter()
        .filter(|g| seen.insert(g.clone()))
        .collect();

    let mut ranked_settings: HashMap<SettingID, usize> = HashMap::new();
    let ac = AhoCorasick::new_auto_configured(&ngrams);

    for (setting_id, setting) in &tune_index.settings {
        // Count how many DISTINCT query patterns appear in this candidate.
        // Using raw overlapping match counts rewarded long/repetitive contours
        // disproportionately, causing exact self-matches to rank below #90.
        let mut matched: std::collections::HashSet<usize> =
            std::collections::HashSet::new();
        for m in ac.find_overlapping_iter(&dedup_runs(&setting.contour)) {
            matched.insert(m.pattern());
        }
        ranked_settings.insert(setting_id.to_string(), matched.len());
    }

    let mut sorted_rankings: Vec<_> = ranked_settings.into_iter().collect();
    sorted_rankings.sort_by(|x, y| y.1.cmp(&x.1));
    sorted_rankings
}

pub fn run_name_query(query: &String, tune_index: &TuneIndex) -> Vec<ScoredName> {
    let query = query.to_lowercase();
    let query_len = query.len() as f32;
    let ngrams = ngrams_str(&query, ff_config::QUERY_NGRAM_SIZE_NAME);

    let mut scored_names: Vec<ScoredName> = Vec::new();
    let ac = AhoCorasick::new_auto_configured(&ngrams);
    for (tune_id, aliases) in &tune_index.aliases {
        for (alias_id, alias) in aliases.iter().enumerate() {
            let score = ac
                .find_overlapping_iter(&alias)
                .collect::<Vec<Match>>()
                .len();
            let score = score as f32 / f32::max((alias.len() as f32).sqrt(), query_len);
            scored_names.push(ScoredName {
                tune_id: tune_id.clone(),
                alias_index: alias_id,
                ngram_score: score,
            });
        }
    }

    return scored_names;
}

pub fn ngrams_str(query: &String, n: usize) -> Vec<String> {
    // n=2 -> 'bigram'
    // n=3 -> 'trigram'
    //  etc...
    let mut grams: Vec<String> = Vec::new();
    let chars: Vec<char> = query.chars().collect();
    if chars.len() < n {
        grams.push(chars.iter().collect());
        return grams;
    }

    for i in 0..chars.len() - (n - 1) {
        let ngram: String = chars[i..i + n].iter().collect();
        grams.push(ngram);
    }
    return grams;
}
