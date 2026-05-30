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
/// **Scoring:** match +2, mismatch -2, gap -1.
///
/// **Normalisation:** `0.5 × raw_score / len(a)`.  Maximum 1.0 (perfect match
/// of every character in the shorter string).
///
/// **Raw contours only** — `dedup_runs` must NOT be applied before calling this
/// function.  Deduplication inflates scores by shortening both strings, causing
/// too many unrelated tunes to exceed the "Very Close" display threshold.
use std::cmp;

const MATCH_SCORE: i32 = 2;
const MISMATCH_SCORE: i32 = -2;
const GAP_SCORE: i32 = -1;

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

    //  Normalised [0, 1].
    let highscore: f32 = *last_row.iter().max().unwrap_or(&0) as f32;
    let norm_const: f32 = a.len() as f32;
    return 0.5 * highscore / norm_const;
}