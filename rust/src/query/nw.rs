/// Semi-global Needleman-Wunsch sequence alignment.
///
/// This is the second-pass scorer.  It runs on the ~2000 candidates shortlisted
/// by the heuristic and produces an accurate similarity score for each.
///
/// **Semi-global, not global.**  The shorter string (always `a` after the swap
/// below) is aligned against the *best matching substring* of the longer string
/// `b`.  Free gaps at the start and end of `b` mean the audio query does not
/// need to cover the whole stored contour — it finds the best-matching segment.
/// This is essential because the user hums a fragment; the stored contour covers
/// an entire tune (possibly with repeats).
///
/// **Scoring:** match +4, mismatch -4, gap -3 — i.e. +1 / -1 / -0.75 per
/// character after normalisation. Doubled to stay in integers; the ratio is what
/// matters. The gap was -1 against +2/-2 (-0.5 per character) until 1.5.0:
/// gaps that cheap let a chance alignment skip its way to matches, so wrong
/// tunes scored too close to the right one and break chatter scored too much
/// like music. Measured on two hand-tagged real sessions, gap -1.5 (on the old
/// scale) was the optimum: -1 / -1.5 / -2 / -2.5 gave 94.2 / 95.2 / 94.6 /
/// 93.5 % of windows with the right tune first. Not semitone-tolerant on
/// purpose: real audio has only ~1 % semitone slips, and tolerance did not help.
///
/// **Normalisation:** `raw_score / (MATCH_SCORE × len(a))`.  Maximum 1.0
/// (perfect match of every character in the shorter string).
///
/// Callers pass the stored contour with its opening appended
/// (`with_repeat_opening`), so a window that runs from the end of one time
/// through into the start of the next can be aligned as one stretch.
///
/// **Raw contours only** — `dedup_runs` must NOT be applied before calling this
/// function.  Deduplication inflates scores by shortening both strings, causing
/// too many unrelated tunes to exceed the "Very Close" display threshold.
use std::cmp;

const MATCH_SCORE: i32 = 4;
const MISMATCH_SCORE: i32 = -4;
const GAP_SCORE: i32 = -3;

/// The stored contour followed by its own opening: enough of it for a query of
/// `query_len` characters, plus half again for the gaps such an alignment may
/// take, and never more than the whole contour. Tunes are played round and
/// round, so the last bars of one time through are followed by the first bars
/// of the next — but a stored contour ends at the end, and a 10 s window
/// straddling the join could only be matched by half. Costs nothing measurable:
/// the n-gram shortlist dominates search time.
pub fn with_repeat_opening(stored: &str, query_len: usize) -> String {
    let extra = (query_len * 3 / 2).min(stored.len());
    // Contours are ASCII; should one ever not be, skip the wrap rather than
    // slice through a character.
    match stored.get(..extra) {
        Some(opening) => {
            let mut looped = String::with_capacity(stored.len() + extra);
            looped.push_str(stored);
            looped.push_str(opening);
            looped
        }
        None => stored.to_string(),
    }
}

pub fn needleman_wunsch(a: &String, b: &String) -> f32 {

    //  Memory-efficient version of Needleman-Wunsch written for Rust.
    //    ~ Tom Wyllie 2021

    if a.len() == 0 || b.len() == 0 {
        return 0.0;
    }

    // Swap so that b is always the longer string; a is aligned against a
    // substring of b.
    let (a, b) = if a.len() > b.len() { (&b, &a) } else { (&a, &b) };

    let mut last_row: Vec<i32> = vec![0; a.len() + 1];
    let last_col_index: usize = a.len();

    //       a1 a2 a3 .. aN
    //    b1
    //    b2
    //    b3
    //    ..
    //    bN

    let mut prev_diag: i32;
    let mut curr_diag: i32;

    //  Populate dynamic programming lattice
    for row in 0..b.len() {
        prev_diag = 0;
        for col in 1..last_row.len() {
            curr_diag = prev_diag;
            prev_diag = last_row[col];
    
            //  We store the previous row in this buffer and work along it,
            //    updating it to "this" row. This is for efficiency.
            last_row[col] = cmp::max(
                    curr_diag + (if a[col-1..col] == b[row..row+1] { MATCH_SCORE } else { MISMATCH_SCORE }),
                    cmp::max(
                        last_row[col - 1] + GAP_SCORE, 
                        last_row[col] + GAP_SCORE
                    ));
        
            last_row[last_col_index] = cmp::max(last_row[last_col_index], prev_diag);
        }
    }

    //  Normalised [0, 1]: matched-character equivalents over the length of a.
    let highscore: f32 = *last_row.iter().max().unwrap_or(&0) as f32;
    let norm_const: f32 = a.len() as f32;
    return highscore / MATCH_SCORE as f32 / norm_const;
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_match_scores_one() {
        let q = "abcdefgh".to_string();
        assert_eq!(needleman_wunsch(&q, &"xxabcdefghyy".to_string()), 1.0);
    }

    #[test]
    fn a_window_across_the_repeat_matches_once_the_opening_is_appended() {
        // The window holds the last five notes and then the first five again.
        let stored = "abcdefghijklmnop";
        let window = "lmnopabcde".to_string();
        let plain = needleman_wunsch(&window, &stored.to_string());
        let looped = needleman_wunsch(&window, &with_repeat_opening(stored, window.len()));
        assert_eq!(looped, 1.0);
        assert!(plain < 0.6, "without the opening only half the window can match ({})", plain);
    }

    #[test]
    fn the_opening_is_bounded_by_the_query_and_by_the_contour() {
        assert_eq!(with_repeat_opening("abcdefghijklmnopqrst", 4), "abcdefghijklmnopqrstabcdef");
        assert_eq!(with_repeat_opening("abcd", 40), "abcdabcd");
    }

    #[test]
    fn a_gap_costs_three_quarters_of_a_match() {
        // One extra note in the window: 8 matches and a gap = (32 - 3) / (4 * 9).
        let s = needleman_wunsch(&"abcdXefgh".to_string(), &"zzabcdefghzz".to_string());
        assert!((s - 29.0 / 36.0).abs() < 1e-6, "{}", s);
    }
}
