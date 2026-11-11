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
/// Where in the stored contour a query matched.
///
/// `start` and `end` are character offsets into the STORED contour (the longer
/// string), `end` exclusive. Because a stored contour holds one character per
/// quaver with repeats played out, `start / quavers_per_bar` is a bar in the
/// played-out tune — which is what lets the live view follow the music.
///
/// `score` uses exactly the normalisation of `needleman_wunsch`, so the best
/// span's score equals that function's result.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct MatchSpan {
    pub start: usize,
    pub end: usize,
    pub score: f32,
}

/// The best few NON-OVERLAPPING places the query aligns within `stored`, best
/// first, at most `max_spans` of them.
///
/// More than one is returned on purpose. A tune played AABB is stored with its
/// repeats played out, so the two A parts are an exact tie — but they are the
/// same written bars, so the tie is harmless. Two DIFFERENT parts sharing a
/// phrase are also a tie, and are not. Only the caller can tell those apart,
/// because only the caller knows where each span lands in the written score;
/// so the runners-up are reported rather than judged here.
///
/// Uses the same recurrence and boundaries as `needleman_wunsch` (zero top and
/// left boundary, best cell anywhere), plus a start pointer per cell. It is
/// O(len(query)) memory like that function: only the previous row is kept.
/// Returns an empty list when either string is empty, or when the query is
/// LONGER than the stored contour — the roles would swap and a position "in
/// the tune" would mean nothing.
pub fn match_spans(query: &str, stored: &str, max_spans: usize) -> Vec<MatchSpan> {
    let a = query.as_bytes();
    let b = stored.as_bytes();
    if a.is_empty() || b.is_empty() || a.len() > b.len() || max_spans == 0 {
        return Vec::new();
    }
    let n = a.len();

    // H[r][c] and the row of b where that cell's alignment began.
    let mut prev_h: Vec<i32> = vec![0; n + 1];
    let mut prev_s: Vec<usize> = vec![0; n + 1];
    let mut cur_h: Vec<i32> = vec![0; n + 1];
    let mut cur_s: Vec<usize> = vec![0; n + 1];

    // Best cell per ending row of b: (raw score, start row).
    let mut row_best: Vec<(i32, usize)> = Vec::with_capacity(b.len());

    for row in 0..b.len() {
        cur_h[0] = 0;
        cur_s[0] = row;
        let mut best: (i32, usize) = (i32::MIN, row);
        for col in 1..=n {
            // A predecessor on the boundary means the alignment starts at
            // this row; anything else carries its own start forward.
            let diag_start = if row == 0 || col == 1 { row } else { prev_s[col - 1] };
            let up_start = if row == 0 { row } else { prev_s[col] };
            let left_start = cur_s[col - 1];

            let diag = prev_h[col - 1]
                + if a[col - 1] == b[row] { MATCH_SCORE } else { MISMATCH_SCORE };
            let left = cur_h[col - 1] + GAP_SCORE;
            let up = prev_h[col] + GAP_SCORE;

            // Same preference order as max(diag, max(left, up)) resolves
            // nothing about ties, so prefer the diagonal, then left, then up.
            let (h, s) = if diag >= left && diag >= up {
                (diag, diag_start)
            } else if left >= up {
                (left, left_start)
            } else {
                (up, up_start)
            };
            cur_h[col] = h;
            cur_s[col] = s;
            if h > best.0 {
                best = (h, s);
            }
        }
        row_best.push(best);
        std::mem::swap(&mut prev_h, &mut cur_h);
        std::mem::swap(&mut prev_s, &mut cur_s);
    }

    // Greedy: highest-scoring ending row first, earliest row on a tie (so the
    // first of two identical repeats wins, deterministically), skipping any
    // span that overlaps one already taken.
    let mut order: Vec<usize> = (0..row_best.len()).collect();
    order.sort_by(|&x, &y| row_best[y].0.cmp(&row_best[x].0).then(x.cmp(&y)));

    let norm = 0.5 / n as f32;
    let mut spans: Vec<MatchSpan> = Vec::new();
    for row in order {
        let (raw, start) = row_best[row];
        if raw <= 0 {
            break;
        }
        let end = row + 1;
        if spans.iter().any(|s| start < s.end && s.start < end) {
            continue;
        }
        spans.push(MatchSpan { start, end, score: raw as f32 * norm });
        if spans.len() >= max_spans {
            break;
        }
    }
    spans
}

#[cfg(test)]
mod tests {
    use super::*;

    // A small deterministic generator, so the tests need no extra crate.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            self.0 >> 33
        }
        fn contour(&mut self, len: usize, alphabet: &[u8]) -> String {
            (0..len)
                .map(|_| alphabet[(self.next() as usize) % alphabet.len()] as char)
                .collect()
        }
    }

    #[test]
    fn best_span_score_equals_needleman_wunsch() {
        // The span is only worth trusting if it is the alignment that produced
        // the ranking score — not a different one that happens to be nearby.
        let mut rng = Lcg(7);
        for _ in 0..500 {
            let qlen = 1 + (rng.next() as usize) % 40;
            let slen = qlen + (rng.next() as usize) % 200;
            let q = rng.contour(qlen, b"stuvwx");
            let s = rng.contour(slen, b"stuvwx");
            let spans = match_spans(&q, &s, 3);
            let nw = needleman_wunsch(&q, &s);
            let best = spans.first().map(|x| x.score).unwrap_or(0.0);
            assert!(
                (best - nw).abs() < 1e-6,
                "q={} s={} span={} nw={}", q, s, best, nw
            );
        }
    }

    #[test]
    fn a_slice_is_found_where_it_was_cut() {
        let mut rng = Lcg(42);
        for _ in 0..200 {
            let stored = rng.contour(400, b"opqrstuvwxyz");
            let start = (rng.next() as usize) % 340;
            let len = 20 + (rng.next() as usize) % 40;
            let end = (start + len).min(stored.len());
            let query = &stored[start..end];
            let spans = match_spans(query, &stored, 1);
            assert_eq!(spans[0].start, start, "stored={} query={}", stored, query);
            assert_eq!(spans[0].end, end);
            assert!((spans[0].score - 1.0).abs() < 1e-6);
        }
    }

    #[test]
    fn a_repeated_part_reports_both_occurrences_earliest_first() {
        let a_part = "stuvwxwvutsrstuvwxyx";
        let b_part = "xyzyxwvwxyzyxwvutsrq";
        let stored = format!("{a}{a}{b}{b}", a = a_part, b = b_part);
        let spans = match_spans(a_part, &stored, 4);
        assert_eq!(spans[0].start, 0);
        assert_eq!(spans[1].start, a_part.len());
        assert!((spans[0].score - spans[1].score).abs() < 1e-6);
        // The B part shares nothing, so it trails well behind.
        assert!(spans.len() < 3 || spans[2].score < 0.5);
    }

    #[test]
    fn spans_never_overlap() {
        let mut rng = Lcg(3);
        for _ in 0..200 {
            let q = rng.contour(15, b"tuvw");
            let s = rng.contour(300, b"tuvw");
            let spans = match_spans(&q, &s, 6);
            for (i, x) in spans.iter().enumerate() {
                assert!(x.start < x.end && x.end <= s.len());
                for y in &spans[i + 1..] {
                    assert!(x.end <= y.start || y.end <= x.start, "{:?} {:?}", x, y);
                    assert!(x.score >= y.score);
                }
            }
        }
    }

    #[test]
    fn no_position_for_a_query_longer_than_the_tune() {
        assert!(match_spans("stuvwxyz", "stu", 3).is_empty());
        assert!(match_spans("", "stu", 3).is_empty());
    }
}
