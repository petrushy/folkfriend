// Continuing a closed session: rebuilding the window matches its stored tune
// list came from (windowMatchesFromTunes, src/js/sessionAnalysis.js).
//
// Run with:  node app/test/sessionContinue.test.mjs

import assert from 'node:assert/strict';
import { loadSessionAnalysisModule } from './helpers/loadSessionAnalysis.mjs';

const { windowMatchesFromTunes, buildSessionDetections, SESSION_ANALYSIS_DEFAULTS } = await loadSessionAnalysisModule();

let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }

const options = { ...SESSION_ANALYSIS_DEFAULTS, windowSeconds: 10, stepSeconds: 5 };
const T = 1_764_000_000_000;
const tune = (tuneId, start, end, extra = {}) => ({
    tuneId, settingId: tuneId * 10, title: `Tune ${tuneId}`, dataset: 'thesession', sourceUrl: '',
    startSeconds: start, endSeconds: end, bestScore: 0.62, alternatives: [],
    audioStartSeconds: null, audioEndSeconds: null, startedAtMs: null, endedAtMs: null, ...extra,
});

console.log('\ncontinuing a closed session');

test('the stored list is rebuilt row for row', () => {
    const stored = [tune(1, 0, 130), tune(2, 131, 260), tune(3, 400, 520), tune(1, 600, 700)];
    const rebuilt = buildSessionDetections(windowMatchesFromTunes(stored, options), options);
    assert.deepEqual(rebuilt.map(d => [d.tuneId, d.settingId, d.startSeconds, d.endSeconds]),
        stored.map(t => [t.tuneId, t.settingId, t.startSeconds, t.endSeconds]));
});

test('audio and wall-clock spans survive, so playback and set splitting still work', () => {
    const stored = [tune(1, 0, 130, { audioStartSeconds: 10, audioEndSeconds: 130, startedAtMs: T, endedAtMs: T + 120000 })];
    const [row] = buildSessionDetections(windowMatchesFromTunes(stored, options), options);
    assert.equal(row.audioStartSeconds, 10);
    assert.equal(row.audioEndSeconds, 130);
    assert.equal(row.startedAtMs, T);
    assert.equal(row.endedAtMs, T + 120000);
});

test('a weak or short row the list kept is not dropped', () => {
    const stored = [tune(1, 0, 100, { bestScore: 0.2 }), tune(2, 101, 118, { bestScore: 0.3 }), tune(3, 120, 240)];
    const rebuilt = buildSessionDetections(windowMatchesFromTunes(stored, options), options);
    assert.deepEqual(rebuilt.map(d => d.tuneId), [1, 2, 3]);
});

test('an empty list rebuilds to nothing', () => {
    assert.deepEqual(windowMatchesFromTunes([], options), []);
    assert.deepEqual(windowMatchesFromTunes(null, options), []);
});

console.log(`\n${passed} passed`);
