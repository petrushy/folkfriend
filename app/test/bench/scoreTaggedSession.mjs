// Scores live detection on a REAL session recording tagged by hand, against the
// tune list a person wrote down. A benchmark, not a test (the runner only picks
// up *.test.mjs), and the recording and tags never enter the repo: they live
// wherever their owner keeps them, and only the numbers come out.
//
//   ffmpeg -i session.m4a -ac 1 -ar 44100 -c:a pcm_s16le session.wav
//   rust/target/release/examples/detect_sim --wav session.wav 2 app/public/res/thesession.json > windows.jsonl
//   node app/test/bench/scoreTaggedSession.mjs windows.jsonl tags.xsc [--index app/public/res/thesession.json] [--quiet]
//
// Tags: a Transcribe! .xsc (its Markers section: name + start time; each tune
// lasts until the next marker, the last until the end of the windows), or JSON
// [{ "name": "...", "start": seconds, "tuneIds": ["52"] }]. Names are resolved
// against the index's aliases; a marker named "break" (or "-", "chat",
// "pause") marks a stretch with no tune, excluded from the tune scores and
// reported on its own; a name matching several tunes accepts any of
// them, and the report says which one the detector picked, so the tags can be
// pinned with tuneIds.
//
// Two layers are scored separately, because they fail differently:
//   detector — each window's raw top result, no app logic;
//   live     — those windows replayed through the live loop's own decision
//              code (bias, normalise, buildLiveDetections with the fast
//              device's confirmation), i.e. what the screen would have shown.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSessionAnalysisModule } from '../helpers/loadSessionAnalysis.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', '..', 'src', 'js');
const { biasResultsTowardPrevious } = await import(path.join(src, 'biasResults.mjs'));
const { confirmSpanSeconds } = await import(path.join(src, 'liveCadence.mjs'));
const { normaliseQueryResults, buildSessionDetections, buildLiveDetections, SESSION_ANALYSIS_DEFAULTS } = await loadSessionAnalysisModule();

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const VALUE_FLAGS = ['--index', '--options', '--confirm', '--hold-strong'];
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(argv[i - 1]));
const [windowsFile, tagsFile] = positional;
if (!windowsFile || !tagsFile) {
    console.error('usage: scoreTaggedSession.mjs windows.jsonl tags.(xsc|json) [--index thesession.json] [--quiet]');
    process.exit(2);
}
const quiet = argv.includes('--quiet');
const indexFile = opt('--index') || path.join(here, '..', '..', 'public', 'res', 'thesession.json');

const windows = readFileSync(windowsFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
const end = windows[windows.length - 1].t;
const step = windows.length > 1 ? windows[1].t - windows[0].t : 2;

// ---- tags -------------------------------------------------------------------
const seconds = hms => hms.split(':').reduce((acc, x) => acc * 60 + Number(x), 0);
function readTags(file) {
    const text = readFileSync(file, 'utf8');
    if (file.endsWith('.json')) return JSON.parse(text);
    // Transcribe!: "S,-1,0,<name>,0,<h:mm:ss.frac>," inside SectionStart,Markers.
    // A name may itself contain commas, so the time is read from the end.
    const body = text.split('SectionStart,Markers')[1].split('SectionEnd,Markers')[0];
    return body.split('\n').filter(l => l.startsWith('S,')).map(l => {
        const parts = l.replace(/,\s*$/, '').split(',');
        return { name: parts.slice(3, -2).join(','), start: seconds(parts[parts.length - 1]) };
    });
}
const norm = s => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .trim().replace(/^(the) (.*)$/, '$2, $1').replace(/[^a-z0-9, ]/g, '').trim();
const index = JSON.parse(readFileSync(indexFile, 'utf8'));
const byName = new Map();
for (const [tuneId, names] of Object.entries(index.aliases)) {
    for (const n of names) {
        const k = norm(n);
        if (!byName.has(k)) byName.set(k, new Set());
        byName.get(k).add(tuneId);
    }
}
const BREAK = /^\s*(break|pause|chat|-+)\s*$/i;
const tags = readTags(tagsFile).sort((a, b) => a.start - b.start).map((tag, i, all) => ({
    ...tag,
    isBreak: BREAK.test(tag.name),
    end: i + 1 < all.length ? all[i + 1].start : end,
    tuneIds: new Set(BREAK.test(tag.name) ? [] : (tag.tuneIds || [...(byName.get(norm(tag.name)) || [])]).map(String)),
}));
const unresolved = tags.filter(t => !t.isBreak && !t.tuneIds.size);
const tagAt = t => tags.find(p => t >= p.start && t < p.end) || null;

// ---- detector layer ---------------------------------------------------------
// A window is labelled by the tag at its MIDPOINT and only scored when the
// whole window lies inside that tag: a window straddling a change is two
// tunes, and either answer is defensible.
const perTag = new Map(tags.map(t => [t, { windows: 0, top1: 0, top5: 0, picked: new Map(), wrongTop: 0, scores: [], wrongScores: [] }]));
let scored = 0, top1 = 0, top5 = 0, empty = 0;
for (const w of windows) {
    const from = w.t - (w.windowSeconds || 10);
    const tag = tagAt(from + 0.01);
    if (!tag || tagAt(w.t - 0.01) !== tag || !tag.tuneIds.size) continue;
    scored++;
    const s = perTag.get(tag);
    s.windows++;
    const results = w.results || [];
    if (!results.length) { empty++; continue; }
    const rank = results.findIndex(r => tag.tuneIds.has(String(r.tune_id)));
    if (rank === 0) { top1++; s.top1++; s.scores.push(results[0].score); }
    else { s.wrongTop++; s.wrongScores.push(results[0].score); }
    if (rank >= 0 && rank < 5) { top5++; s.top5++; }
    if (rank >= 0) {
        const id = String(results[rank].tune_id);
        s.picked.set(id, (s.picked.get(id) || 0) + 1);
    }
}

// ---- live layer -------------------------------------------------------------
// --options '{"minTopScore":0.35}' overrides the live defaults; --confirm N
// replaces the fast device's confirmation span (seconds), for trying rules.
// The window length is read from the data (detect_sim's fifth argument), and
// the rules that scale with it scale here too, as they do in the app.
const windowSeconds = Math.round(Math.max(...windows.map(w => w.windowSeconds || 10)));
const options = { ...SESSION_ANALYSIS_DEFAULTS, windowSeconds, stepSeconds: 5, mergeGapSeconds: windowSeconds, ...JSON.parse(opt('--options') || '{}') };
const confirmSpan = opt('--confirm') !== null ? Number(opt('--confirm')) : confirmSpanSeconds(options.stepSeconds, step);
const toResult = r => ({ setting_id: r.setting_id, setting: { tune_id: String(r.tune_id) }, display_name: r.display_name, score: r.score });
// By default these are the app's own rules (buildLiveDetections, biased
// toward the tune heard). Two switches bring back what it did before November
// 2026, to compare:
//   --bias-screen     bias toward the tune ON SCREEN rather than the one heard
//   --hold-strong X   release a held new tune at score X (the app: CONFIRM_RELEASE_SCORE)
const biasScreen = argv.includes('--bias-screen');
const holdStrong = opt('--hold-strong') !== null ? Number(opt('--hold-strong')) : null;
const matches = [];
let detections = [];
let heardTuneId = null;
const shown = new Map(); // second -> tune id on screen
let current = null, wi = 0;
for (let s = 1; s <= end; s++) {
    while (wi < windows.length && windows[wi].t <= s) {
        const w = windows[wi++];
        const results = (w.results || []).map(toResult);
        if (!results.length) continue;
        const prev = biasScreen ? (detections.length ? detections[detections.length - 1].tuneId : null) : heardTuneId;
        const n = normaliseQueryResults(biasResultsTowardPrevious(results, prev, options.previousTuneBiasDelta), options);
        if (!n) continue;
        matches.push({ startSeconds: w.t, audioSeconds: null, ...n });
        if (holdStrong === null) {
            ({ detections, heardTuneId } = buildLiveDetections(matches, options, { confirmSpanSeconds: confirmSpan }));
        } else {
            const all = buildSessionDetections(matches, options);
            const tail = all[all.length - 1];
            const span = all.length > 1 ? tail.endSeconds - options.windowSeconds - tail.startSeconds : Infinity;
            detections = (all.length > 1 && span < confirmSpan && tail.bestScore < holdStrong) ? all.slice(0, -1) : all;
            heardTuneId = all.length ? tail.tuneId : null;
        }
        current = detections.length ? detections[detections.length - 1].tuneId : null;
    }
    shown.set(s, current);
}
const final = buildSessionDetections(matches, options, { final: true });
const played = new Set(tags.flatMap(t => [...t.tuneIds]));
let right = 0, wrong = 0, stale = 0, blank = 0, total = 0, breakSeconds = 0, breakShownNew = 0;
const half = [{ right: 0, total: 0, wrong: 0 }, { right: 0, total: 0, wrong: 0 }];
let lastTuneShown = null;
for (let s = 1; s <= end; s++) {
    const tag = tagAt(s - 0.5);
    if (tag && tag.isBreak) {
        // In a break the last tune staying up is fine; a NEW tune appearing is not.
        breakSeconds++;
        if (shown.get(s) !== null && shown.get(s) !== lastTuneShown && !played.has(shown.get(s))) breakShownNew++;
        continue;
    }
    if (shown.get(s) !== null) lastTuneShown = shown.get(s);
    if (!tag || !tag.tuneIds.size) continue;
    total++;
    const on = shown.get(s);
    const h = half[s < end / 2 ? 0 : 1];
    h.total++;
    if (on === null) blank++;
    else if (tag.tuneIds.has(on)) { right++; h.right++; }
    else if (played.has(on)) stale++;
    else { wrong++; h.wrong++; }
}
const latency = tag => {
    for (let s = Math.ceil(tag.start) + 1; s <= tag.end; s++) if (tag.tuneIds.has(shown.get(s))) return s - tag.start;
    return null;
};
const finalIds = final.map(d => d.tuneId);
const detectorLatency = tag => {
    const w = windows.find(x => x.t > tag.start && x.t <= tag.end && x.results && x.results.length && tag.tuneIds.has(String(x.results[0].tune_id)));
    return w ? w.t - tag.start : null;
};

// ---- report -----------------------------------------------------------------
const pct = (x, n) => `${(100 * x / Math.max(1, n)).toFixed(0)}%`;
const median = a => a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null;
const mmss = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
if (!quiet) {
    console.log('start  | tune                            | windows | top-1 | top-5 | med score right/wrong | shown after | picked id');
    for (const tag of tags) {
        if (tag.isBreak) { console.log(`${mmss(tag.start).padStart(6)} | (break)`); continue; }
        const s = perTag.get(tag);
        const lat = latency(tag);
        const dlat = detectorLatency(tag);
        const picked = [...s.picked.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id}×${n}`).join(' ');
        const ms = x => (x === null ? '  — ' : x.toFixed(2));
        console.log(`${mmss(tag.start).padStart(6)} | ${tag.name.slice(0, 31).padEnd(31)} | ${String(s.windows).padStart(7)} | ${pct(s.top1, s.windows).padStart(5)} | ${pct(s.top5, s.windows).padStart(5)} | ${ms(median(s.scores))} / ${ms(median(s.wrongScores))}           | ${(lat === null ? 'never' : `${lat.toFixed(0)} s`).padStart(6)}${(dlat === null ? '' : ` (${dlat.toFixed(0)})`).padStart(5)} | ${tag.tuneIds.size ? picked : 'NOT IN INDEX?'}`);
    }
    console.log('');
}
if (unresolved.length) console.log(`Names not found in the index (not scored): ${unresolved.map(t => t.name).join(', ')}`);
const lats = tags.filter(t => t.tuneIds.size).map(latency);
if (breakSeconds) console.log(`Breaks: ${breakSeconds} s tagged · an unplayed tune on screen for ${pct(breakShownNew, breakSeconds)} of it`);
const found = lats.filter(x => x !== null);
console.log(`Window ${windowSeconds} s, step ${step} s`);
console.log(`Detector, per window (${scored} windows wholly inside one tune): top-1 ${pct(top1, scored)} · top-5 ${pct(top5, scored)} · no transcription ${pct(empty, scored)}`);
console.log(`Live view, per second: right ${pct(right, total)} · WRONG tune ${pct(wrong, total)} · another tune of the session ${pct(stale, total)} · nothing ${pct(blank, total)}`);
const dl = tags.filter(t => t.tuneIds.size).map(detectorLatency).filter(x => x !== null);
console.log(`Tunes shown at all: ${found.length}/${lats.length} · median time to show ${median(found)?.toFixed(0)} s (first right search result after ${median(dl)?.toFixed(0)} s)`);
console.log(`By half: right ${pct(half[0].right, half[0].total)} / ${pct(half[1].right, half[1].total)} · wrong ${pct(half[0].wrong, half[0].total)} / ${pct(half[1].wrong, half[1].total)}`);
console.log(`Saved list: ${tags.filter(t => t.tuneIds.size && finalIds.some(id => t.tuneIds.has(id))).length}/${lats.length} found, ${finalIds.filter(id => !played.has(id)).length} not tagged (of ${finalIds.length})`);
