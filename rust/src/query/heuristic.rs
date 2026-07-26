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
use aho_corasick::AhoCorasick;
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

/// `deduped_contours` is a precomputed run-length-deduplicated copy of every
/// stored contour (built once at index load in `QueryEngine::use_tune_index`),
/// keyed by setting ID. Deduplicating here on every query would re-allocate all
/// ~60k contour strings per search.
pub fn run_transcription_query(
    query: &String,
    deduped_contours: &HashMap<SettingID, String>,
    repass: usize,
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

    let mut sorted_rankings: Vec<(SettingID, usize)> = Vec::new();
    let ac = AhoCorasick::new_auto_configured(&ngrams);

    for (setting_id, contour) in deduped_contours {
        // Count how many DISTINCT query patterns appear in this candidate.
        // Using raw overlapping match counts rewarded long/repetitive contours
        // disproportionately, causing exact self-matches to rank below #90.
        let mut matched: std::collections::HashSet<usize> =
            std::collections::HashSet::new();
        for m in ac.find_overlapping_iter(contour) {
            matched.insert(m.pattern());
        }
        // Most of the index matches nothing — skip those rather than ranking
        // and sorting ~60k zero-score entries.
        if !matched.is_empty() {
            sorted_rankings.push((setting_id.clone(), matched.len()));
        }
    }

    // Sort by distinct-ngram count (descending). Only the top candidates go to
    // the slower Needleman-Wunsch re-scoring pass.
    sorted_rankings.sort_by(|x, y| y.1.cmp(&x.1));

    // Keep the top `repass` candidates — but NEVER split a tie group at the
    // cutoff. Truncating mid-tie made shortlist membership depend on HashMap
    // iteration order, so a borderline-correct tune (typical of weak/poor-audio
    // contours, where many tunes tie at a low count near the boundary) was
    // randomly included or dropped from one run to the next — the same audio
    // could find the tune or not. Including the whole boundary tie group makes
    // membership deterministic; a hard cap bounds the NW pass when a very low
    // count ties thousands of tunes (a contour too weak to resolve anyway).
    if sorted_rankings.len() > repass {
        let cutoff = sorted_rankings[repass - 1].1;
        let max_end = sorted_rankings.len().min(ff_config::QUERY_REPASS_MAX);
        let mut end = repass;
        while end < max_end && sorted_rankings[end].1 >= cutoff {
            end += 1;
        }
        sorted_rankings.truncate(end);
    }
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
            let score = ac.find_overlapping_iter(&alias).count();
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
