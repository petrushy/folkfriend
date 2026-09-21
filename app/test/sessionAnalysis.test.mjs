import assert from 'node:assert/strict';

import { biasResultsTowardPrevious } from '../src/js/biasResults.mjs';
import { rm } from 'node:fs/promises';
import { loadSessionAnalysisModule, sessionAnalysisTmpDir } from './helpers/loadSessionAnalysis.mjs';

function r(tuneId, score) {
    return { setting: { tune_id: tuneId }, setting_id: tuneId * 10, score, display_name: `tune-${tuneId}` };
}

// previousTuneId null → input returned unchanged (identity)
{
    const input = [r(1, 0.8), r(2, 0.7)];
    assert.equal(biasResultsTowardPrevious(input, null, 0.15), input);
}

// previousTuneId not in results → input returned unchanged
{
    const input = [r(1, 0.8), r(2, 0.7)];
    assert.equal(biasResultsTowardPrevious(input, 999, 0.15), input);
}

// previousTuneId already at index 0 → input returned unchanged
{
    const input = [r(1, 0.8), r(2, 0.7)];
    assert.equal(biasResultsTowardPrevious(input, 1, 0.15), input);
}

// previousTuneId at index 2, score within delta → promoted to index 0
{
    const input = [r(1, 0.80), r(2, 0.75), r(3, 0.70), r(4, 0.65)];
    const out = biasResultsTowardPrevious(input, 3, 0.15);
    assert.equal(out[0].setting.tune_id, 3);
    assert.equal(out[0].score, 0.70);
    // The rest should preserve original relative order minus the promoted item
    assert.deepEqual(out.slice(1).map(x => x.setting.tune_id), [1, 2, 4]);
    // Input not mutated
    assert.equal(input[0].setting.tune_id, 1);
    assert.equal(input[2].setting.tune_id, 3);
}

// previousTuneId at index 1, exactly at the delta boundary → promoted
{
    const input = [r(1, 0.80), r(2, 0.65)];
    const out = biasResultsTowardPrevious(input, 2, 0.15);
    assert.equal(out[0].setting.tune_id, 2);
}

// previousTuneId at index 2, score gap > delta → input returned unchanged
{
    const input = [r(1, 0.90), r(2, 0.80), r(3, 0.50), r(4, 0.45)];
    const out = biasResultsTowardPrevious(input, 3, 0.15);
    assert.equal(out, input);
    assert.equal(out[0].setting.tune_id, 1);
}

// empty results → returns input safely
{
    const input = [];
    assert.equal(biasResultsTowardPrevious(input, 1, 0.15), input);
}

// null results → returns input safely
{
    assert.equal(biasResultsTowardPrevious(null, 1, 0.15), null);
}

// malformed entries (missing setting) tolerated
{
    const input = [r(1, 0.8), { score: 0.7 }, r(2, 0.6)];
    const out = biasResultsTowardPrevious(input, 2, 0.30);
    assert.equal(out[0].setting.tune_id, 2);
}

// --- filterShortPastDetections -------------------------------------------
//
// The rule: a detection that was only ever heard briefly is dropped once it is
// no longer the tune being played. The last entry is exempt, because it is the
// tune playing right now and every tune starts short.

const { filterShortPastDetections, MIN_PAST_DETECTION_SECONDS } =
    await loadSessionAnalysisModule();

function d(tuneId, startSeconds, endSeconds) {
    return { id: `d${tuneId}-${startSeconds}`, tuneId, startSeconds, endSeconds };
}

// A short PAST detection is dropped; the long ones stay.
{
    const out = filterShortPastDetections([
        d(1, 0, 40),
        d(2, 40, 50),      // 10s blip
        d(3, 50, 120),
    ], 15);
    assert.deepEqual(out.map(x => x.tuneId), [1, 3]);
}

// The last entry is kept however short — it is the tune being played now, and
// dropping it would hide a newly started tune (and blank the follow overlay).
{
    const out = filterShortPastDetections([
        d(1, 0, 40),
        d(2, 40, 45),
    ], 15);
    assert.deepEqual(out.map(x => x.tuneId), [1, 2]);
}

// Exactly at the threshold survives: two consecutive windows at the live
// defaults span exactly 15s, and those are the ones worth keeping.
{
    const out = filterShortPastDetections([d(1, 0, 15), d(2, 20, 60)], 15);
    assert.deepEqual(out.map(x => x.tuneId), [1, 2]);
    const under = filterShortPastDetections([d(1, 0, 14.9), d(2, 20, 60)], 15);
    assert.deepEqual(under.map(x => x.tuneId), [2]);
}

// A single detection is never filtered, and neither empty nor null throws.
{
    assert.deepEqual(filterShortPastDetections([d(1, 0, 1)], 15).map(x => x.tuneId), [1]);
    assert.deepEqual(filterShortPastDetections([], 15), []);
    assert.deepEqual(filterShortPastDetections(null, 15), []);
}

// The default threshold is used when none is given.
{
    assert.equal(MIN_PAST_DETECTION_SECONDS, 15);
    const out = filterShortPastDetections([d(1, 0, 10), d(2, 10, 20), d(3, 20, 90)]);
    assert.deepEqual(out.map(x => x.tuneId), [3]);
}

// The input array is not mutated.
{
    const input = [d(1, 0, 5), d(2, 5, 60)];
    filterShortPastDetections(input, 15);
    assert.equal(input.length, 2);
}

// keepLast: false filters the last entry too (a finished file analysis).
{
    const out = filterShortPastDetections([d(1, 0, 40), d(2, 40, 45)], 15, { keepLast: false });
    assert.deepEqual(out.map(x => x.tuneId), [1]);
    assert.deepEqual(filterShortPastDetections([d(1, 0, 5)], 15, { keepLast: false }), []);
}

// --- buildSessionDetections --------------------------------------------------
//
// The one pipeline live listening and file analysis share.
{
    const { buildSessionDetections, getAnalysisOptions, SESSION_ANALYSIS_DEFAULTS, STRONG_SINGLE_DETECTION_SCORE } =
        await loadSessionAnalysisModule();
    const options = getAnalysisOptions(120); // 10s window, 5s step
    const m = (tuneId, startSeconds, score = 0.6) => ({
        tuneId, startSeconds, settingId: String(tuneId * 10), displayName: `tune-${tuneId}`, score, alternatives: [],
    });

    assert.equal(SESSION_ANALYSIS_DEFAULTS.minTopScore, 0.45);
    assert.equal(options.minTopScore, 0.45);
    assert.equal(options.previousTuneBiasDelta, 0.15);
    assert.equal('minRms' in options, false, 'no silence gate: live has none');

    // A single window between two stretches of tune 1 is dropped, and tune 1's
    // halves merge into ONE row that keeps the earliest start.
    const matches = [
        m(1, 0), m(1, 5), m(1, 10), m(1, 15),
        m(2, 20),
        m(1, 25), m(1, 30), m(1, 35),
        m(3, 45), m(3, 50), m(3, 55),
    ];
    const running = buildSessionDetections(matches, options);
    assert.deepEqual(running.map(x => x.tuneId), [1, 3]);
    assert.equal(running[0].startSeconds, 0);
    assert.equal(running[0].endSeconds, 45);

    // While running, a short final entry is kept (it is the tune playing now)...
    const tail = [...matches, m(4, 70)];
    assert.deepEqual(buildSessionDetections(tail, options).map(x => x.tuneId), [1, 3, 4]);
    // ...and dropped once the analysis has ended.
    assert.deepEqual(buildSessionDetections(tail, options, { final: true }).map(x => x.tuneId), [1, 3]);

    // A tune that returns after a gap with nothing else in between is one row,
    // keeping the start of its first stretch and the best-scoring setting.
    const gap = buildSessionDetections([
        m(1, 0), m(1, 5), m(1, 10),
        { ...m(1, 60, 0.9), settingId: 'best' }, m(1, 65), m(1, 70),
        m(2, 80), m(2, 85), m(2, 90),
    ], options, { final: true });
    assert.deepEqual(gap.map(x => x.tuneId), [1, 2]);
    assert.equal(gap[0].startSeconds, 0);
    assert.equal(gap[0].endSeconds, 80);
    assert.equal(gap[0].settingId, 'best');
    assert.equal(gap[0].hits, 6);

    // Strong single window: kept only when windows do not overlap.
    const strong = STRONG_SINGLE_DETECTION_SCORE;
    const sparse = { ...options, stepSeconds: 10 };
    const single = (opts) => buildSessionDetections([
        m(1, 0, 0.6), m(1, 10, 0.6),
        m(2, 20, strong),
        m(3, 30, 0.6), m(3, 40, 0.6),
    ], opts, { final: true }).map(x => x.tuneId);
    assert.deepEqual(single(sparse), [1, 2, 3], 'step >= window: a strong single window counts');
    assert.deepEqual(single(options), [1, 3], 'overlapping windows: a real tune hits two, so a single is a fluke');
    const weak = buildSessionDetections([
        m(1, 0), m(1, 10), m(2, 20, strong - 0.01), m(3, 30), m(3, 40),
    ], sparse, { final: true }).map(x => x.tuneId);
    assert.deepEqual(weak, [1, 3], 'a single window below the strong score is still dropped');
}

await rm(sessionAnalysisTmpDir, { recursive: true, force: true });

console.log('sessionAnalysis.test.mjs passed');
