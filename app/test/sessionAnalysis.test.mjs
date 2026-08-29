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

await rm(sessionAnalysisTmpDir, { recursive: true, force: true });

console.log('sessionAnalysis.test.mjs passed');
