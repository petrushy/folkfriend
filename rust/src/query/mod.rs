/// Two-pass tune retrieval engine.
///
/// **Pass 1 — heuristic (`heuristic.rs`):** Aho-Corasick n-gram scan over all
/// ~60 k stored contours.  Fast O(n) scan; returns a ranked shortlist of up to
/// `QUERY_REPASS_SIZE` (2000) candidates scored by distinct matched query n-grams.
///
/// **Pass 2 — Needleman-Wunsch (`nw.rs`):** Semi-global sequence alignment on
/// the shortlist only.  Accurate but O(m×n) per candidate; feasible only because
/// pass 1 has already eliminated ~97% of the index.
///
/// Results are deduplicated by `tune_id` (highest-scoring setting wins) and
/// capped at 100 entries.
mod heuristic;
mod nw;

use crate::decode;
use crate::ff_config;
use crate::index::schema::*;
use crate::index::TuneIndex;
use fnv::FnvHashSet as HashSet;
use serde::Serialize;
use std::collections::HashMap;
use std::fmt;

pub struct QueryEngine {
    pub tune_index: Option<TuneIndex>,
    setting_ids_by_tune_id: HashMap<TuneID, Vec<SettingID>>,
    /// Run-length-deduplicated copy of every stored contour, precomputed once at
    /// index load. The heuristic matches against these, so we avoid re-running
    /// `dedup_runs` over all ~60k contours on every query (see heuristic.rs).
    deduped_contours: HashMap<SettingID, String>,
    num_repass: usize,
    num_output: usize,
}

#[derive(Debug, Serialize)]
pub struct TranscriptionQueryRecord {
    pub setting_id: SettingID,
    pub setting: Setting,
    pub display_name: String,
    pub score: f32,
}

#[derive(Debug, Serialize)]
pub struct NameQueryRecord {
    pub setting: Setting,
    pub display_name: String,
}

pub type TranscriptionQueryResults = Vec<TranscriptionQueryRecord>;
pub type NameQueryResults = Vec<NameQueryRecord>;

/// Look up a tune's alias name by index, returning `None` if either the tune
/// or the index is absent (rather than panicking on a malformed record).
fn alias_name<'a>(
    tune_index: &'a TuneIndex,
    tune_id: &TuneID,
    alias_index: usize,
) -> Option<&'a String> {
    tune_index
        .aliases
        .get(tune_id)
        .and_then(|aliases| aliases.get(alias_index))
}

impl QueryEngine {
    pub fn new() -> QueryEngine {
        QueryEngine {
            tune_index: None,
            setting_ids_by_tune_id: HashMap::new(),
            deduped_contours: HashMap::new(),
            num_repass: ff_config::QUERY_REPASS_SIZE,
            num_output: 100,
        }
    }

    pub fn use_tune_index(&mut self, tune_index: TuneIndex) {
        // Build tune-IDs to setting-IDs map
        let mut setting_ids_by_tune_id: HashMap<TuneID, Vec<SettingID>> = HashMap::new();
        for (setting_id, setting) in &tune_index.settings {
            setting_ids_by_tune_id
                .entry(setting.tune_id.clone())
                .or_insert(Vec::new())
                .push(setting_id.clone());
        }

        // Sort numerically. Setting IDs can exceed i32::MAX (folkwiki IDs are
        // already close to it), so parse as u64; fall back to 0 for any
        // non-numeric ID rather than panicking the whole module at load.
        for (_, setting_ids) in setting_ids_by_tune_id.iter_mut() {
            setting_ids.sort_by_key(|k| k.parse::<u64>().unwrap_or(0));
        }

        // Precompute run-length-deduplicated contours once, so the heuristic
        // doesn't re-dedup all ~60k contours on every query.
        let deduped_contours: HashMap<SettingID, String> = tune_index
            .settings
            .iter()
            .map(|(setting_id, setting)| {
                (setting_id.clone(), heuristic::dedup_runs(&setting.contour))
            })
            .collect();

        self.setting_ids_by_tune_id = setting_ids_by_tune_id;
        self.deduped_contours = deduped_contours;
        self.tune_index = Some(tune_index);
    }

    pub fn run_contour_query(
        self: &Self,
        contour: &decode::types::ContourString,
    ) -> Result<TranscriptionQueryResults, QueryError> {
        match &self.tune_index {
            None => Err(QueryError("query engine has not loaded index".into())),
            Some(tune_index) => {
                // === Heuristic search ===
                // First pass: fast, but inaccurate. Eliminates most candidates
                // and returns the top `num_repass` shortlist already truncated.
                let first_search = heuristic::run_transcription_query(
                    &contour,
                    &self.deduped_contours,
                    self.num_repass,
                );

                // === Full search ===
                // Second pass: slow, but accurate. Re-scores the shortlist.
                let mut second_search: Vec<(SettingID, f32)> = Vec::new();
                for (setting_id, _) in &first_search {
                    let score = nw::needleman_wunsch(
                        contour,
                        &tune_index.settings[setting_id].contour,
                    );
                    second_search.push((setting_id.clone(), score));
                }
                // total_cmp avoids a panic should a score ever be NaN.
                second_search.sort_by(|x, y| y.1.total_cmp(&x.1));
                let mut results: TranscriptionQueryResults = Vec::new();

                let mut tune_ids_in_results: HashSet<TuneID> = HashSet::default();

                for (setting_id, score) in second_search.iter() {
                    let setting = &tune_index.settings[setting_id];
                    if tune_ids_in_results.contains(&setting.tune_id) {
                        continue;
                    }

                    // Skip rather than panic if a tune somehow has no alias.
                    let display_name = match tune_index
                        .aliases
                        .get(&setting.tune_id)
                        .and_then(|aliases| aliases.first())
                    {
                        Some(name) => name.clone(),
                        None => continue,
                    };

                    tune_ids_in_results.insert(setting.tune_id.clone());
                    results.push(TranscriptionQueryRecord {
                        setting_id: setting_id.clone(),
                        setting: setting.clone(),
                        score: *score,
                        display_name,
                    });

                    if results.len() >= self.num_output {
                        break;
                    }
                }

                Ok(results)
            }
        }
    }

    pub fn run_name_query(self: &Self, query: &String) -> Result<NameQueryResults, QueryError> {
        match &self.tune_index {
            None => Err(QueryError("query engine has not loaded index".into())),
            Some(tune_index) => {
                let mut scored_names: Vec<heuristic::ScoredName> =
                    heuristic::run_name_query(query, &tune_index);

                // Sort by score (descending); break ties by shorter alias first.
                // total_cmp avoids a panic should a score ever be NaN.
                scored_names.sort_unstable_by(|a, b| {
                    match b.ngram_score.total_cmp(&a.ngram_score) {
                        std::cmp::Ordering::Equal => {
                            let a_alias_len = alias_name(tune_index, &a.tune_id, a.alias_index)
                                .map_or(0, |s| s.len());
                            let b_alias_len = alias_name(tune_index, &b.tune_id, b.alias_index)
                                .map_or(0, |s| s.len());
                            a_alias_len.cmp(&b_alias_len)
                        }
                        ordering => ordering,
                    }
                });

                let mut tune_ids_in_results: HashSet<TuneID> = HashSet::default();

                // filter_map drops any entry whose lookups fail rather than
                // panicking the whole module on a single inconsistent record.
                let top_scores: NameQueryResults = scored_names
                    .iter()
                    .filter(|t| tune_ids_in_results.insert(t.tune_id.clone()))
                    .filter_map(|t| {
                        let setting_id = self.setting_ids_by_tune_id.get(&t.tune_id)?.first()?;
                        let setting = tune_index.settings.get(setting_id)?;
                        let display_name = alias_name(tune_index, &t.tune_id, t.alias_index)?;
                        Some(NameQueryRecord {
                            setting: setting.clone(),
                            display_name: display_name.clone(),
                        })
                    })
                    .take(20)
                    .collect();

                return Ok(top_scores);
            }
        }
    }

    pub fn setting_ids_from_tune_id(&self, tune_id: TuneID) -> Result<&Vec<SettingID>, QueryError> {
        self.setting_ids_by_tune_id
            .get(&tune_id)
            .ok_or_else(|| QueryError(format!("missing tune ID {}", tune_id)))
    }

    pub fn settings_from_tune_id(
        &self,
        tune_id: TuneID,
    ) -> Result<Vec<(SettingID, Setting)>, QueryError> {
        let tune_index = self
            .tune_index
            .as_ref()
            .ok_or_else(|| QueryError("query engine has not loaded index".into()))?;
        Ok(self
            .setting_ids_from_tune_id(tune_id)?
            .iter()
            // Skip any setting ID with no corresponding setting rather than panic.
            .filter_map(|setting_id| {
                tune_index
                    .settings
                    .get(setting_id)
                    .map(|setting| (setting_id.clone(), setting.clone()))
            })
            .collect())
    }

    pub fn aliases_from_tune_id(&self, tune_id: TuneID) -> Result<Vec<String>, QueryError> {
        self.tune_index
            .as_ref()
            .ok_or_else(|| QueryError("query engine has not loaded index".into()))?
            .aliases
            .get(&tune_id)
            .ok_or_else(|| QueryError(format!("missing tune ID {}", tune_id)))
            .map(|aliases| aliases.to_vec())
    }
}

pub struct QueryError(pub String);

impl fmt::Debug for QueryError {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}
