import assert from 'node:assert/strict';

import { biasResultsTowardPrevious } from '../src/js/biasResults.mjs';

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

console.log('sessionAnalysis.test.mjs passed');
