// Replays synthetic sessions through the live loop's own decision code under
// different cadences. A benchmark, not a test (the runner only picks up
// *.test.mjs). See "Measuring live detection without recordings" in CLAUDE.md.
//
//   cd rust && cargo run --release --example detect_sim -- \
//       ../app/public/res/thesession.json 60 20261111 > /tmp/sim.jsonl
//   node app/test/bench/replayLiveCadence.mjs /tmp/sim.jsonl
//
// The per-window steps below mirror liveAnalysis._runLoop (partial-window
// gate, previous-tune bias, normaliseQueryResults, buildSessionDetections) and
// call the real functions for each; only the loop around them is restated.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSessionAnalysisModule } from '../helpers/loadSessionAnalysis.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', '..', 'src', 'js');
const { biasResultsTowardPrevious } = await import(path.join(src, 'biasResults.mjs'));
const { isPartialWindow, partialWindowUsable, confirmSpanSeconds } = await import(path.join(src, 'liveCadence.mjs'));
const SA = await loadSessionAnalysisModule();
const { normaliseQueryResults, buildSessionDetections, SESSION_ANALYSIS_DEFAULTS } = SA;

const SR = 44100;
const WINDOW = 10;
const STEP = 5;
const options = { ...SESSION_ANALYSIS_DEFAULTS, windowSeconds: WINDOW, stepSeconds: STEP, mergeGapSeconds: WINDOW };

const CADENCES = {
    'before #110 (first 10 s, step 5)': { first: 10, step: 5 },
    'after, slow device (first 5 s, step 5)': { first: 5, step: 5 },
    'after, mid device (first 5 s, step 3)': { first: 5, step: 3 },
    'after, fast device (first 5 s, step 2)': { first: 5, step: 2 },
};

function replay(session, { first, step }) {
    const total = session.windows.length;
    const matches = [];
    let detections = [];
    const shownAt = new Array(total + 1).fill(null); // tail tune on screen at second s
    let shown = null;
    let next = first;
    for (let s = 1; s <= total; s++) {
        if (s === next) {
            next += step;
            const w = session.windows[s - 1];
            const partial = isPartialWindow(Math.round(w.windowSeconds * SR), SR, WINDOW);
            const usable = !partial || partialWindowUsable({ contour: 'x'.repeat(w.contourLength || 0) }, options.minContourLength);
            const results = usable ? w.results : [];
            if (results.length) {
                const prev = detections.length ? detections[detections.length - 1].tuneId : null;
                const n = normaliseQueryResults(biasResultsTowardPrevious(results, prev, options.previousTuneBiasDelta), options);
                if (n) {
                    matches.push({ startSeconds: s, audioSeconds: null, ...n });
                    // Exactly as liveAnalysis._recluster: the step is known
                    // once the first analysis has been timed.
                    detections = buildSessionDetections(matches, options, {
                        confirmSpanSeconds: IMPLEMENTED ? confirmSpanSeconds(options.stepSeconds, step) : 0,
                    });
                    const tail = detections.length ? detections[detections.length - 1] : null;
                    if (!tail) shown = null;
                    else shown = tail.tuneId;
                }
            }
        }
        shownAt[s] = shown;
    }
    const final = buildSessionDetections(matches, options, { final: true });
    return { shownAt, final };
}

function truthAt(session, s) {
    // The tune being played during second s (s-1 .. s).
    const mid = s - 0.5;
    const part = session.truth.find(p => mid >= p.start && mid < p.end);
    return part ? part.tuneId : null;
}

let IMPLEMENTED = false;
const RULES = {
    'without tail confirmation (as first shipped in #110)': () => { IMPLEMENTED = false; },
    'with tail confirmation (current code)': () => { IMPLEMENTED = true; },
};
const sessions = readFileSync(process.argv[2], 'utf8').trim().split('\n').map(l => JSON.parse(l));
console.log(`${sessions.length} sessions, ${sessions.length * 3} tune performances\n`);

for (const [ruleName, rule] of Object.entries(RULES)) {
rule();
console.log(`=== ${ruleName} ===`);
for (const [name, cadence] of Object.entries(CADENCES)) {
    let latencies = [];
    let neverShown = 0;
    let wrongSeconds = 0;     // a tune that was not played at all on screen
    let staleSeconds = 0;     // the previous tune still on screen
    let blankSeconds = 0;     // nothing yet
    let totalSeconds = 0;
    let found = 0;
    let spurious = 0;
    let wrongFirstShown = 0;  // the first tune ever shown in a session was wrong
    let windows = 0;
    for (const session of sessions) {
        const { shownAt, final } = replay(session, cadence);
        windows += Math.floor((session.windows.length - cadence.first) / cadence.step) + 1;
        const played = new Set(session.truth.map(p => p.tuneId));
        for (const part of session.truth) {
            let lat = null;
            for (let s = Math.ceil(part.start) + 1; s <= Math.floor(part.end); s++) {
                if (shownAt[s] === part.tuneId) { lat = s - part.start; break; }
            }
            if (lat === null) neverShown++; else latencies.push(lat);
        }
        const firstShown = shownAt.find(x => x);
        if (firstShown && firstShown !== session.truth[0].tuneId) wrongFirstShown++;
        for (let s = 1; s < shownAt.length; s++) {
            const truth = truthAt(session, s);
            if (!truth) continue;
            totalSeconds++;
            const on = shownAt[s];
            if (on === null) blankSeconds++;
            else if (on === truth) { /* right */ }
            else if (played.has(on)) staleSeconds++;
            else wrongSeconds++;
        }
        const finalIds = final.map(d => d.tuneId);
        for (const p of played) if (finalIds.includes(p)) found++;
        spurious += finalIds.filter(id => !played.has(id)).length;
    }
    latencies.sort((a, b) => a - b);
    const q = f => latencies[Math.min(latencies.length - 1, Math.floor(f * latencies.length))];
    const pct = x => `${(100 * x / totalSeconds).toFixed(1)} %`;
    console.log(`  ${name.padEnd(42)} shown after ${q(0.5).toFixed(1)}/${q(0.9).toFixed(1)} s (median/90th) | right ${pct(totalSeconds - wrongSeconds - staleSeconds - blankSeconds)} | WRONG ${pct(wrongSeconds)} | prev ${pct(staleSeconds)} | list ${found}/${sessions.length * 3}, ${spurious} spurious`);
}
}
