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
    const { buildSessionDetections, buildLiveDetections, getAnalysisOptions, SESSION_ANALYSIS_DEFAULTS,
        STRONG_SINGLE_DETECTION_SCORE, CONFIRM_RELEASE_SCORE, closeRivalOf, CLOSE_RIVAL_GAP, CLOSE_RIVAL_SHARE } =
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

    // A close rival: another tune within CLOSE_RIVAL_GAP of the top in at
    // least CLOSE_RIVAL_SHARE of a tune's windows.
    {
        const hit = (t, score, alts) => ({ tuneId: 1, displayName: 'Jimmy O\'Brien\'s', startSeconds: t, score,
            alternatives: [{ tuneId: 1, settingId: '10', title: 'Jimmy O\'Brien\'s', score }, ...alts] });
        const twin = s => ({ tuneId: 2, settingId: '20', title: 'The Maid in the Meadow', score: s });
        const far = s => ({ tuneId: 3, settingId: '30', title: 'Some Other Reel', score: s });
        const close = [hit(0, 0.7, [twin(0.68)]), hit(2, 0.72, [twin(0.70)]), hit(4, 0.7, [far(0.4)]), hit(6, 0.7, [far(0.4)])];
        const rival = closeRivalOf(close);
        assert.equal(rival && rival.tuneId, 2, 'a twin close in half the windows is a rival');
        assert.equal(rival.windows, 2);
        assert.equal(rival.score, 0.70, 'carrying its best score');
        assert.equal(closeRivalOf([hit(0, 0.7, [twin(0.6)]), hit(2, 0.7, [twin(0.6)]), hit(4, 0.7, [twin(0.6)])]), null,
            'a runner-up 0.1 behind is an ordinary runner-up');
        assert.equal(closeRivalOf([hit(0, 0.7, [twin(0.7)]), hit(2, 0.7, [far(0.4)]), hit(4, 0.7, [far(0.4)]),
            hit(6, 0.7, [far(0.4)]), hit(8, 0.7, [far(0.4)])]), null, 'close in one window of five is not enough');
        assert.equal(closeRivalOf(close.slice(0, 2)), null, 'two windows are too few to judge');
        const sameName = { tuneId: 4, settingId: '40', title: 'Jimmy O\'Brien\'s', score: 0.7 };
        assert.equal(closeRivalOf([hit(0, 0.7, [sameName]), hit(2, 0.7, [sameName]), hit(4, 0.7, [sameName])]), null,
            'a different tune with the same name is not offered — "or:" the same title says nothing');
        assert.ok(CLOSE_RIVAL_GAP === 0.08 && CLOSE_RIVAL_SHARE === 0.25,
            'measured on two tagged sessions: flags only near-twins (scoreTaggedSession.mjs --review)');

        // Through the pipeline, and across a same-tune merge: the tallies add.
        const m2 = (t, score, alts) => ({ ...hit(t, score, alts), settingId: '10', sourceUrl: '', dataset: '' });
        const rows = buildSessionDetections([
            m2(0, 0.7, [twin(0.69)]), m2(5, 0.7, [far(0.3)]), m2(10, 0.7, [twin(0.69)]),
            m2(40, 0.7, [twin(0.69)]), m2(45, 0.7, [twin(0.69)]), m2(50, 0.7, [far(0.3)]),
        ], options);
        assert.equal(rows.length, 1, 'one tune, two clusters merged into one row');
        assert.equal(rows[0].closeRival && rows[0].closeRival.windows, 4, 'the rival windows of both clusters add up');
    }

    // Confirmation of a new tune at the tail (live listening faster than the
    // configured step). Tune 1 established; tune 2 starts matching at 2 s
    // spacing, as a fast device queries.
    // New-tune windows score 0.5 here: below the release score, so the hold
    // is what decides.
    const established = [m(1, 0), m(1, 5), m(1, 10), m(1, 15)];
    const weakNew = 0.5;
    assert.ok(weakNew < CONFIRM_RELEASE_SCORE);
    const run = (extra, confirm) => buildSessionDetections([...established, ...extra], options,
        { confirmSpanSeconds: confirm }).map(x => x.tuneId);
    assert.deepEqual(run([m(2, 20, weakNew)], 0), [1, 2], 'no confirmation asked: as before');
    assert.deepEqual(run([m(2, 20, weakNew)], 3), [1], 'one window of a new tune: the previous stays current');
    assert.deepEqual(run([m(2, 20, weakNew), m(2, 22, weakNew)], 3), [1],
        'two windows 2 s apart share most of their audio: still not enough');
    assert.deepEqual(run([m(2, 20, weakNew), m(2, 22, weakNew), m(2, 24, weakNew)], 3), [1, 2], 'spanning 4 s: confirmed');
    assert.deepEqual(run([m(2, 20, CONFIRM_RELEASE_SCORE)], 3), [1, 2],
        'a window at the release score needs no confirmation');
    assert.deepEqual(run([m(2, 20, CONFIRM_RELEASE_SCORE - 0.01)], 3), [1], 'just below it: held');
    assert.equal(CONFIRM_RELEASE_SCORE, 0.6,
        'measured on two tagged sessions: 0.55 let chance matches into breaks (11 % vs 5 %), 0.7 delayed every tune — '
        + 're-measure with scripts/bench_tagged_sessions.sh before changing it');
    assert.ok(CONFIRM_RELEASE_SCORE < strong,
        'released below the strong-single score: at 0.7 the hold delayed nearly every real tune by ~4 s');

    // While a new tune is held back, the tune HEARD is the new one, even
    // though the screen still shows the old: the live loop biases toward the
    // heard tune, or the old tune is promoted again and the new one is never
    // released.
    const held = buildLiveDetections([...established, m(2, 20, weakNew)], options, { confirmSpanSeconds: 3 });
    assert.deepEqual(held.detections.map(x => x.tuneId), [1]);
    assert.equal(held.heardTuneId, 2);
    assert.equal(buildLiveDetections([], options, { confirmSpanSeconds: 3 }).heardTuneId, null);
    assert.deepEqual(buildSessionDetections([m(2, 20)], options, { confirmSpanSeconds: 3 }).map(x => x.tuneId), [2],
        'the first tune of a session is not held back — there is nothing to fall back to');
    assert.deepEqual(buildSessionDetections([...established, m(2, 20)], options,
        { confirmSpanSeconds: 3, final: true }).map(x => x.tuneId), [1],
        'final: the ordinary short-detection rule applies, not this one');
}

// --- wall-clock span (startedAtMs / endedAtMs) ---------------------------------
//
// The listening clock stops while paused; the wall clock is what shows a break
// the user paused through, and so what splits a session into its sets. Both
// merge paths must combine it, or a merged row loses the stretch it came from.
{
    const { buildSessionDetections, getAnalysisOptions } = await loadSessionAnalysisModule();
    const options = getAnalysisOptions(120);
    const m = (tuneId, startSeconds, atMs, score = 0.6) => ({
        tuneId, startSeconds, atMs, settingId: String(tuneId * 10), displayName: `tune-${tuneId}`, score, alternatives: [],
    });
    const T = 1_700_000_000_000;
    const matches = [
        m(1, 0, T), m(1, 5, T + 5000), m(1, 10, T + 10000),
        // The same tune again after a gap (mergeConsecutiveSameTune).
        m(1, 60, T + 600000), m(1, 65, T + 605000),
        m(2, 80, T + 620000), m(2, 85, T + 625000),
    ];
    for (const opts of [options, { ...options, mergeGapSeconds: 120 }]) {
        const rows = buildSessionDetections(matches, opts, { final: true });
        assert.deepEqual(rows.map(r => r.tuneId), [1, 2]);
        assert.equal(rows[0].startedAtMs, T, 'a merged row keeps the earliest wall-clock start');
        assert.equal(rows[0].endedAtMs, T + 605000, 'and the latest wall-clock end');
        assert.equal(rows[1].startedAtMs, T + 620000);
    }
    // A session resumed from an older build: its earlier windows carry no
    // stamp, the later ones do. The merged row must take the later stamp
    // rather than keep the earlier cluster's null.
    const mixed = matches.map((x, i) => (i < 3 ? (({ atMs, ...rest }) => rest)(x) : x));
    for (const opts of [options, { ...options, mergeGapSeconds: 120 }]) {
        const rows = buildSessionDetections(mixed, opts, { final: true });
        assert.equal(rows[0].startedAtMs, T + 600000, 'an unstamped cluster does not wipe a stamped one');
        assert.equal(rows[0].endedAtMs, T + 605000);
    }
    // Matches without a stamp (file analysis, older sessions) give null, not NaN.
    const unstamped = buildSessionDetections(matches.map(({ atMs, ...rest }) => rest), options, { final: true });
    assert.equal(unstamped[0].startedAtMs, null);
    assert.equal(unstamped[0].endedAtMs, null);
}

await rm(sessionAnalysisTmpDir, { recursive: true, force: true });

console.log('sessionAnalysis.test.mjs passed');
