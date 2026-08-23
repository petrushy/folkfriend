import assert from 'node:assert/strict';

import {
    resolveFollowTarget,
    applyOverride,
    targetScoreKey,
    needsScoreLoad,
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
    assert.deepEqual(getLastShown(), { target: null, abcSetting: null, abcTargetKey: null, favourited: false });

    const target = resolveFollowTarget([det(1, 10, 'The Kesh', 0.71)], null).target;
    const abcSetting = { tune_id: 1, setting_id: 10, abc: 'X:1\n' };
    setLastShown({ target, abcSetting, abcTargetKey: targetScoreKey(target), favourited: true });

    const reopened = getLastShown();
    assert.equal(reopened.target.tuneId, 1);
    assert.equal(reopened.abcSetting, abcSetting);
    assert.equal(reopened.favourited, true);

    // Same tune still playing after reopen → no reload needed
    const { target: resolvedTarget, changed } = resolveFollowTarget([det(1, 10, 'The Kesh', 0.73)], reopened.target);
    assert.equal(changed, false);
    assert.equal(needsScoreLoad(resolvedTarget, reopened.abcTargetKey, null), false);

    clearLastShown();
}

// targetScoreKey(): identifies a (tune, setting) pair, null for no target
{
    assert.equal(targetScoreKey(null), null);
    assert.equal(targetScoreKey({ tuneId: 1, settingId: '10' }), '1::10');
    assert.equal(targetScoreKey({ tuneId: 1, settingId: '11' }), '1::11', 'different setting, different key');
    assert.equal(targetScoreKey({ tuneId: 2, settingId: '10' }), '2::10', 'different tune, different key');
}

// needsScoreLoad(): the basics
{
    const target = { tuneId: 1, settingId: '10' };
    const key = targetScoreKey(target);
    assert.equal(needsScoreLoad(null, null, null), false, 'nothing to load');
    assert.equal(needsScoreLoad(target, null, null), true, 'no cached and no in-flight score');
    assert.equal(needsScoreLoad(target, key, null), false, 'already have the score for this exact target');
    assert.equal(needsScoreLoad(target, key, key), false, 'already have it, even if (redundantly) also "loading" it');
    assert.equal(needsScoreLoad(target, null, key), false, 'already loading this exact target — do not restart it');
    assert.equal(needsScoreLoad(target, 'other::key', null), true);
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
    const abcTargetKeyA = targetScoreKey(targetA);

    // Detection moves to tune B; target updates immediately but the load for
    // B's score hasn't resolved yet, so abcSetting/abcTargetKey are still A's
    // (loadScore's documented behaviour). The user closes the overlay here.
    const { target: targetB, changed } = resolveFollowTarget([det(2, 20, 'Tune B', 0.66)], targetA);
    assert.equal(changed, true);
    setLastShown({ target: targetB, abcSetting: abcSettingA, abcTargetKey: abcTargetKeyA, favourited: false });

    // Reopen while B is still the current detection.
    const reopened = getLastShown();
    const resolved = resolveFollowTarget([det(2, 20, 'Tune B', 0.68)], reopened.target);
    assert.equal(resolved.changed, false, 'tune has not changed again since the cached target');
    assert.equal(
        needsScoreLoad(resolved.target, reopened.abcTargetKey, null),
        true,
        'cached abc is still Tune A — a reload must be forced even though changed is false',
    );

    clearLastShown();
}

// Regression (same-tune, different setting): a manual override to a
// different setting of the SAME tune must not be masked by a tune_id-only
// check. This is exactly the scenario a tune_id-only comparison would miss.
{
    clearLastShown();

    const detection = det(1, 10, 'The Kesh', 0.71, [opt(1, 11, 'The Kesh (alt)', 0.68)]);
    const shown10 = resolveFollowTarget([detection], null).target;
    const abcSetting10 = { tune_id: 1, setting_id: 10, abc: 'X:1\nsetting 10\n' };
    const abcTargetKey10 = targetScoreKey(shown10);

    // User overrides to setting 11 of the same tune; its load hasn't resolved
    // (abcSetting/abcTargetKey are still setting 10's) when the overlay closes.
    const overridden = applyOverride(shown10, detection.tuneOptions[1]).target;
    assert.equal(overridden.tuneId, 1);
    assert.equal(overridden.settingId, '11');
    setLastShown({ target: overridden, abcSetting: abcSetting10, abcTargetKey: abcTargetKey10, favourited: false });

    // Reopen: same tune is still playing, so resolveFollowTarget alone says
    // "unchanged" — but the cached score is for the wrong setting.
    const reopened = getLastShown();
    const resolved = resolveFollowTarget([det(1, 10, 'The Kesh', 0.74)], reopened.target);
    assert.equal(resolved.changed, false);
    assert.equal(resolved.target.settingId, '11', 'the override is still what should be on screen');
    assert.equal(
        needsScoreLoad(resolved.target, reopened.abcTargetKey, null),
        true,
        'cached abc is setting 10, target is setting 11 of the same tune — must reload',
    );

    clearLastShown();
}

// --- Freeze -----------------------------------------------------------------

// Frozen: a different tune being detected must not move the display, and the
// readouts (score, options) must not move either.
{
    const shown = resolveFollowTarget([det(1, 10, 'The Kesh', 0.71)], null).target;
    const { target, changed } = resolveFollowTarget(
        [det(2, 20, 'The Butterfly', 0.88, [opt(2, 21, 'The Butterfly (alt)', 0.8)])],
        shown,
        true,
    );
    assert.equal(changed, false);
    assert.equal(target, shown, 'frozen target is returned untouched, not rebuilt');
    assert.equal(target.tuneId, 1);
    assert.equal(target.score, 0.71, 'the match readout is frozen too');
    assert.equal(target.tuneOptions.length, 1, 'the override options do not re-populate while frozen');
}

// Frozen: the same tune continuing must not refresh the score readout either.
{
    const shown = resolveFollowTarget([det(1, 10, 'The Kesh', 0.71)], null).target;
    const { target } = resolveFollowTarget([det(1, 10, 'The Kesh', 0.93)], shown, true);
    assert.equal(target.score, 0.71);
}

// Frozen: detections clearing (the room goes quiet) must not blank the view.
{
    const shown = resolveFollowTarget([det(1, 10, 'The Kesh', 0.71)], null).target;
    const { target, changed } = resolveFollowTarget([], shown, true);
    assert.equal(changed, false);
    assert.equal(target, shown);
}

// Frozen never asks for a reload — the on-screen score is already the right one.
{
    const shown = resolveFollowTarget([det(1, 10, 'The Kesh', 0.71)], null).target;
    const key = targetScoreKey(shown);
    const { target } = resolveFollowTarget([det(2, 20, 'The Butterfly', 0.88)], shown, true);
    assert.equal(needsScoreLoad(target, key, null), false);
}

// Unfreezing rejoins whatever is being played now, and that is a real change
// needing a reload.
{
    const shown = resolveFollowTarget([det(1, 10, 'The Kesh', 0.71)], null).target;
    const key = targetScoreKey(shown);
    const frozen = resolveFollowTarget([det(2, 20, 'The Butterfly', 0.88)], shown, true).target;
    const { target, changed } = resolveFollowTarget([det(2, 20, 'The Butterfly', 0.88)], frozen, false);
    assert.equal(changed, true);
    assert.equal(target.tuneId, 2);
    assert.equal(target.detectedTuneId, 2);
    assert.equal(needsScoreLoad(target, key, null), true);
}

// Omitting the flag entirely keeps the old following behaviour.
{
    const shown = resolveFollowTarget([det(1, 10, 'The Kesh', 0.71)], null).target;
    const { target, changed } = resolveFollowTarget([det(2, 20, 'The Butterfly', 0.88)], shown);
    assert.equal(changed, true);
    assert.equal(target.tuneId, 2);
}

console.log('liveScoreFollow.test.mjs passed');
