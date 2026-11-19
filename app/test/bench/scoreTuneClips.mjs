// Scores detection on a folder of single-tune clips — one tune per recording,
// named in a tunes.json beside them — rather than on a tagged session. A
// benchmark, not a test (the runner only picks up *.test.mjs); the recordings
// and their list stay private, only the numbers come out. Driven by
// scripts/bench_tune_clips.sh, which transcribes and searches the clips first.
//
//   node app/test/bench/scoreTuneClips.mjs results.jsonl tunes.json --index merged.json [--review]
//
// results.jsonl: every clip's windows, each carrying `file` (the clip's file
// name) and `results`, as rust/examples/requery writes them.
//
// tunes.json:
//   { "clips": { "<file name>": { "tuneIds": ["56869501"], "how": "name", "note": "…" } } }
// `tuneIds` lists every tune that counts as right (a tune is often in several
// datasets, or in one twice). `how` says how the answer was established, so a
// guess is never mistaken for a fact:
//   name        the tune's own name is in the index
//   other-name  the search's pick, identified as the same tune by composer,
//               origin or contour, under another name
//   absent      not in any dataset searched (tuneIds empty): the clip then
//               measures false positives, the share of its time the live view
//               shows a tune at all, which is always a wrong one
//   harmony     a second voice, not the melody: scored like `absent`
// A clip missing from tunes.json is listed and not scored.
//
// Each clip is scored on its own (a fresh session per clip, so nothing shown
// for one leaks into the next) by scoreTaggedSession.mjs --json, i.e. the same
// two layers: the detector's raw top result per window, and the live view's
// own rules replayed over them.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSessionAnalysisModule } from '../helpers/loadSessionAnalysis.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--index');
const [resultsFile, tunesFile] = positional;
const indexFile = opt('--index');
if (!resultsFile || !tunesFile || !indexFile) {
    console.error('usage: scoreTuneClips.mjs results.jsonl tunes.json --index merged.json [--review]');
    process.exit(2);
}
const review = argv.includes('--review');

const index = JSON.parse(readFileSync(indexFile, 'utf8'));
const datasetOf = index.dataset_by_tune || {};
const nameOf = id => (index.aliases[id] || [id])[0];
// macOS file names come back decomposed (å as a + ring); compare composed.
const nfc = x => x.normalize('NFC');
const clips = Object.fromEntries(Object.entries(JSON.parse(readFileSync(tunesFile, 'utf8')).clips || {}).map(([k, v]) => [nfc(k), v]));
const { SESSION_ANALYSIS_DEFAULTS } = await loadSessionAnalysisModule();
const MIN_TOP = SESSION_ANALYSIS_DEFAULTS.minTopScore;

const byFile = new Map();
for (const line of readFileSync(resultsFile, 'utf8').trim().split('\n')) {
    const w = JSON.parse(line);
    w.file = nfc(w.file);
    if (!byFile.has(w.file)) byFile.set(w.file, []);
    byFile.get(w.file).push(w);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'tune-clips-'));
const pct = (x, n) => (n ? `${Math.round(100 * x / n)}%` : '—');
const median = a => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
const rows = [];
const unlisted = [];
try {
    for (const [file, windows] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0], 'sv'))) {
        const truth = clips[file];
        if (!truth) { unlisted.push(file); continue; }
        // Only tunes in the datasets searched can be found; a clip whose tune
        // is in none of them is scored as absent for this run.
        const listed = (truth.tuneIds || []).map(String);
        const ids = listed.filter(id => id in index.aliases);
        const notSearched = listed.length > 0 && !ids.length;
        const inIndex = ids.length > 0 && !['absent', 'harmony'].includes(truth.how);
        const w = path.join(tmp, 'w.jsonl');
        const t = path.join(tmp, 't.tags.json');
        writeFileSync(w, windows.sort((a, b) => a.t - b.t).map(x => JSON.stringify(x)).join('\n') + '\n');
        writeFileSync(t, JSON.stringify([inIndex ? { name: file, start: 0, tuneIds: ids } : { name: 'break', start: 0 }]));
        const s = JSON.parse(execFileSync('node', [path.join(here, 'scoreTaggedSession.mjs'), w, t, '--index', indexFile, '--json'], { encoding: 'utf8' }));
        // What the search put first most often, over whole windows.
        const votes = new Map();
        const topScores = [];
        for (const x of windows) {
            if ((x.windowSeconds || 10) < 10 || !x.results?.length) continue;
            topScores.push(x.results[0].score);
            const id = String(x.results[0].tune_id);
            votes.set(id, (votes.get(id) || 0) + 1);
        }
        const [voteId, voteN] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0];
        rows.push({ file, truth, ids, notSearched, inIndex, s, topScores, voteId, voteN, voteOf: [...votes.values()].reduce((a, b) => a + b, 0) });
    }
} finally {
    rmSync(tmp, { recursive: true, force: true });
}

const ds = ids => [...new Set(ids.map(id => datasetOf[id] || '?'))].join('+');
// "saved list": the session's tune list once the clip is over (the 15 s rule
// applied, as at Finish) — right tune in it, and how many unplayed tunes.
// For a clip of a tune that is in no dataset every saved tune is wrong, and
// "claims" is the share of whole windows scoring at the live view's
// minTopScore, i.e. windows that would have named a tune.
const savedOf = r => {
    const ids = r.s.finalIds;
    const wrong = ids.filter(id => !r.ids.includes(id)).length;
    return r.inIndex ? `${ids.some(id => r.ids.includes(id)) ? 'yes' : 'NO '} +${wrong}` : (wrong ? `${wrong} wrong` : 'none');
};
const claims = r => r.topScores.filter(x => x >= MIN_TOP).length;
console.log('clip                                          | how        | in dataset         | top-1 | top-5 | live right / wrong / none | saved list | shown most');
for (const r of rows) {
    const { s } = r;
    const shown = s.mostShown ? `${nameOf(s.mostShown).slice(0, 34)}${r.ids.includes(s.mostShown) ? '' : ' ✗'}` : '(nothing)';
    const live = r.inIndex
        ? `${pct(s.right, s.seconds).padStart(4)} / ${pct(s.wrong + s.stale, s.seconds).padStart(4)} / ${pct(s.blank, s.seconds).padStart(4)}`
        : `claims ${pct(claims(r), r.topScores.length).padStart(4)} of windows`;
    console.log(`${r.file.slice(0, 45).padEnd(45)} | ${(r.notSearched ? 'not here' : r.truth.how || '').padEnd(10)} | ${(r.inIndex ? ds(r.ids) : '—').slice(0, 18).padEnd(18)} | ${(r.inIndex ? pct(s.top1, s.windows) : '—').padStart(5)} | ${(r.inIndex ? pct(s.top5, s.windows) : '—').padStart(5)} | ${live.padEnd(25)} | ${savedOf(r).padEnd(10)} | ${shown}`);
}
if (rows.some(r => r.notSearched)) console.log(`\n"not here": the listed tune is in none of the datasets searched, so the clip is scored as absent.`);
if (unlisted.length) console.log(`\nNot in tunes.json (not scored): ${unlisted.join(', ')}`);

const sum = (list, key) => list.reduce((a, r) => a + r.s[key], 0);
const summarise = (label, list) => {
    if (!list.length) return;
    const found = list.filter(r => r.ids.includes(r.s.mostShown)).length;
    const saved = list.filter(r => r.s.finalIds.some(id => r.ids.includes(id))).length;
    const extra = list.reduce((a, r) => a + r.s.finalIds.filter(id => !r.ids.includes(id)).length, 0);
    console.log(`${label} (${list.length} clips): shown most of the time ${found}/${list.length}, in the saved list ${saved}/${list.length} (+${extra} wrong) · ` +
        `per window top-1 ${pct(sum(list, 'top1'), sum(list, 'windows'))}, top-5 ${pct(sum(list, 'top5'), sum(list, 'windows'))} · ` +
        `live right ${pct(sum(list, 'right'), sum(list, 'seconds'))}, wrong ${pct(sum(list, 'wrong') + sum(list, 'stale'), sum(list, 'seconds'))} · ` +
        `median time to show ${median(list.map(r => r.s.latency).filter(x => x !== null)) ?? '—'} s`);
};
console.log('');
const known = rows.filter(r => r.inIndex);
summarise('In the datasets searched', known);
summarise('  by name', known.filter(r => r.truth.how === 'name'));
summarise('  under another name', known.filter(r => r.truth.how === 'other-name'));
const absent = rows.filter(r => !r.inIndex);
if (absent.length) {
    const withWrong = absent.filter(r => r.s.finalIds.length).length;
    const total = absent.reduce((a, r) => a + r.s.finalIds.length, 0);
    console.log(`Not in the datasets searched (${absent.length} clips): ${pct(absent.reduce((a, r) => a + claims(r), 0), absent.reduce((a, r) => a + r.topScores.length, 0))} of windows claim a tune (≥ ${MIN_TOP}) · ` +
        `a wrong tune in the saved list for ${withWrong}/${absent.length} clips (${total} in all) · ` +
        `once something is on screen it stays: a wrong tune is up ${pct(sum(absent, 'breakShownNew'), sum(absent, 'breakSeconds'))} of the time`);
}
const right = known.flatMap(r => r.s.rightScores);
const wrongInAbsent = absent.flatMap(r => r.topScores);
if (right.length && wrongInAbsent.length) {
    const q = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(2);
    console.log(`Top score when the right tune is first: median ${q(right, 0.5)}, p10 ${q(right, 0.1)} · best (wrong) score in clips not in the index: median ${q(wrongInAbsent, 0.5)}, p90 ${q(wrongInAbsent, 0.9)}`);
}

if (review) {
    console.log('\nReview — what the search put first most often in each clip (whole windows)');
    for (const r of rows) {
        if (!r.voteId) continue;
        const ok = r.ids.includes(r.voteId);
        console.log(`  ${r.file.slice(0, 45).padEnd(45)} ${nameOf(r.voteId)} [${r.voteId}, ${datasetOf[r.voteId] || '?'}] ${r.voteN}/${r.voteOf}${ok ? '' : r.inIndex ? '  ← not the listed tune' : '  ← listed as absent'}`);
    }
}
