import assert from 'node:assert/strict';

import {
    resolveFollowTarget,
    applyOverride,
    cachedScoreMatchesTarget,
    getLastShown,
    setLastShown,
    clearLastShown,
} from '../src/js/liveScoreFollow.mjs';

function opt(tuneId, settingId, title, score) {
    return {
        value: `${settingId}::${tuneId}::${title}`,
        tuneId,
        settingId: String(settingId),
        sourceUrl: '',
        title,
        score,
    };
}

function det(tuneId, settingId, title, bestScore, alternatives = []) {
    return {
        tuneId,
        settingId: String(settingId),
        title,
        bestScore,
        tuneOptions: [opt(tuneId, settingId, title, bestScore), ...alternatives],
    };
}

// No detections yet, nothing showing → nothing to do
{
    const { target, changed } = resolveFollowTarget([], null);
    assert.equal(target, null);
    assert.equal(changed, false);
}

// null/undefined detections tolerated
{
    assert.deepEqual(resolveFollowTarget(null, null), { target: null, changed: false });
    assert.deepEqual(resolveFollowTarget(undefined, null), { target: null, changed: false });
}

// Detections cleared while a score was showing → clear the score
{
    const previous = { detectedTuneId: 1, tuneId: 1, settingId: '10', title: 'A', score: 0.7, tuneOptions: [], overridden: false };
    const { target, changed } = resolveFollowTarget([], previous);
    assert.equal(target, null);
    assert.equal(changed, true);
}

// First detection → becomes the target and needs loading
{
    const { target, changed } = resolveFollowTarget([det(1, 10, 'The Kesh', 0.71)], null);
    assert.equal(changed, true);
    assert.equal(target.tuneId, 1);
    assert.equal(target.detectedTuneId, 1);
    assert.equal(target.settingId, '10');
    assert.equal(target.title, 'The Kesh');
    assert.equal(target.score, 0.71);
    assert.equal(target.overridden, false);
}

// Only the LAST detection matters — earlier rows are history
{
    const detections = [det(1, 10, 'The Kesh', 0.71), det(2, 20, 'Morning Dew', 0.65)];
    const { target, changed } = resolveFollowTarget(detections, null);
    assert.equal(changed, true);
    assert.equal(target.tuneId, 2);
}

// Same tune continues, a better-scoring window upgraded settingId/title:
// score refreshes but the displayed setting is sticky (no mid-tune re-render)
{
    const first = resolveFollowTarget([det(1, 10, 'The Kesh', 0.61)], null).target;
    const upgraded = det(1, 11, 'The Kesh Jig', 0.78);
    const { target, changed } = resolveFollowTarget([upgraded], first);
    assert.equal(changed, false, 'same tune must not force a score reload');
    assert.equal(target.settingId, '10', 'setting is sticky for the duration of the tune');
    assert.equal(target.title, 'The Kesh');
    assert.equal(target.score, 0.78, 'score readout still tracks the best window');
    assert.equal(target.tuneOptions, upgraded.tuneOptions, 'options refresh from the latest row');
}

// A new tune → switch, and load the new score
{
    const first = resolveFollowTarget([det(1, 10, 'The Kesh', 0.71)], null).target;
    const { target, changed } = resolveFollowTarget(
        [det(1, 10, 'The Kesh', 0.71), det(2, 20, 'Morning Dew', 0.66)],
        first,
    );
    assert.equal(changed, true);
    assert.equal(target.tuneId, 2);
    assert.equal(target.settingId, '20');
}

// Manual override picks a different setting of the same tune
{
    const detection = det(1, 10, 'The Kesh', 0.71, [opt(1, 11, 'The Kesh (alt)', 0.68)]);
    const initial = resolveFollowTarget([detection], null).target;
    const { target, changed } = applyOverride(initial, detection.tuneOptions[1]);
    assert.equal(changed, true);
    assert.equal(target.settingId, '11');
    assert.equal(target.overridden, true);
    assert.equal(target.detectedTuneId, 1);
}

// Override to a DIFFERENT tune survives subsequent updates of the same detection.
// detectedTuneId (not tuneId) is what's compared, otherwise the very next
// update would see a mismatch and snap the override away.
{
    const detection = det(1, 10, 'The Kesh', 0.71, [opt(7, 70, 'Wrong-guess Reel', 0.64)]);
    const initial = resolveFollowTarget([detection], null).target;
    const overridden = applyOverride(initial, detection.tuneOptions[1]).target;
    assert.equal(overridden.tuneId, 7);
    assert.equal(overridden.detectedTuneId, 1);

    const { target, changed } = resolveFollowTarget([det(1, 10, 'The Kesh', 0.74)], overridden);
    assert.equal(changed, false, 'override must not be undone by same-tune updates');
    assert.equal(target.tuneId, 7);
    assert.equal(target.settingId, '70');
    assert.equal(target.overridden, true);
    assert.equal(target.score, 0.64, 'an overridden target keeps its own score');
}

// A real tune change clears the override
{
    const detection = det(1, 10, 'The Kesh', 0.71, [opt(7, 70, 'Wrong-guess Reel', 0.64)]);
    const initial = resolveFollowTarget([detection], null).target;
    const overridden = applyOverride(initial, detection.tuneOptions[1]).target;

    const { target, changed } = resolveFollowTarget(
        [detection, det(2, 20, 'Morning Dew', 0.66)],
        overridden,
    );
    assert.equal(changed, true);
    assert.equal(target.tuneId, 2);
    assert.equal(target.overridden, false);
}

// applyOverride is a no-op without an option or a previous target
{
    const previous = resolveFollowTarget([det(1, 10, 'The Kesh', 0.71)], null).target;
    assert.deepEqual(applyOverride(previous, null), { target: previous, changed: false });
    assert.deepEqual(applyOverride(null, opt(1, 10, 'A', 0.5)), { target: null, changed: false });
}

// Detections missing a tuneId are ignored rather than shown as a blank tune
{
    const { target, changed } = resolveFollowTarget([{ tuneId: null, title: '' }], null);
    assert.equal(target, null);
    assert.equal(changed, false);
}

// Missing tuneOptions tolerated
{
    const { target } = resolveFollowTarget([{ tuneId: 1, settingId: 10, title: 'A', bestScore: 0.5 }], null);
    assert.deepEqual(target.tuneOptions, []);
}

// getLastShown()/setLastShown() persist across the overlay's close/reopen
// cycle, so a reopen on an unchanged tune can resolve `changed: false`
// against a real previous target instead of null.
{
    clearLastShown();
    assert.deepEqual(getLastShown(), { target: null, abcSetting: null, favourited: false });

    const target = resolveFollowTarget([det(1, 10, 'The Kesh', 0.71)], null).target;
    const abcSetting = { tune_id: 1, setting_id: 10, abc: 'X:1\n' };
    setLastShown({ target, abcSetting, favourited: true });

    const reopened = getLastShown();
    assert.equal(reopened.target.tuneId, 1);
    assert.equal(reopened.abcSetting, abcSetting);
    assert.equal(reopened.favourited, true);

    // Same tune still playing after reopen → no reload needed
    const { changed } = resolveFollowTarget([det(1, 10, 'The Kesh', 0.73)], reopened.target);
    assert.equal(changed, false);

    clearLastShown();
}

// cachedScoreMatchesTarget(): the basics
{
    assert.equal(cachedScoreMatchesTarget(null, null), true, 'nothing to load');
    assert.equal(cachedScoreMatchesTarget({ tune_id: 1 }, null), true, 'no target means nothing to load, regardless of stale abc');
    assert.equal(cachedScoreMatchesTarget(null, { tuneId: 1 }), false, 'a target with no loaded abc must be loaded');
    assert.equal(cachedScoreMatchesTarget({ tune_id: 1 }, { tuneId: 1 }), true);
    assert.equal(cachedScoreMatchesTarget({ tune_id: 1 }, { tuneId: 2 }), false);
    // tune_id/tuneId types can differ (schema.rs stores TuneID as a string;
    // detection rows aren't guaranteed to match that exactly) — compared as strings.
    assert.equal(cachedScoreMatchesTarget({ tune_id: '1' }, { tuneId: 1 }), true);
}

// Regression: closing the overlay mid-load must not let a stale abcSetting
// masquerade as the new tune's score on reopen. loadScore() deliberately
// keeps the previous abcSetting on screen while a newer one loads (see its
// comment), so target and abcSetting can be genuinely out of sync — the
// overlay must reload rather than trust `changed: false` alone.
{
    clearLastShown();

    // Tune A was fully loaded and shown.
    const targetA = resolveFollowTarget([det(1, 10, 'Tune A', 0.71)], null).target;
    const abcSettingA = { tune_id: 1, setting_id: 10, abc: 'X:1\nTune A\n' };

    // Detection moves to tune B; target updates immediately but the load for
    // B's score hasn't resolved yet, so abcSetting is still A's (loadScore's
    // documented behaviour). The user closes the overlay in this window.
    const { target: targetB, changed } = resolveFollowTarget([det(2, 20, 'Tune B', 0.66)], targetA);
    assert.equal(changed, true);
    setLastShown({ target: targetB, abcSetting: abcSettingA, favourited: false });

    // Reopen while B is still the current detection.
    const reopened = getLastShown();
    const resolved = resolveFollowTarget([det(2, 20, 'Tune B', 0.68)], reopened.target);
    assert.equal(resolved.changed, false, 'tune has not changed again since the cached target');
    assert.equal(
        cachedScoreMatchesTarget(reopened.abcSetting, resolved.target),
        false,
        'cached abc is still Tune A — a reload must be forced even though changed is false',
    );

    clearLastShown();
}

console.log('liveScoreFollow.test.mjs passed');
