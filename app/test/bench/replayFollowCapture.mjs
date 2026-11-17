// Replays a "Save the run for diagnosis" capture from set Follow through the
// CURRENT rules, beside what the app showed at the time.
//
//   node app/test/bench/replayFollowCapture.mjs follow_x.json [options]
//
//   --truth truth.json    [{ "entry": 0, "start": 0 }, { "entry": 1, "start": 52.5 }, ...]
//                         which set entry was really being played from when
//                         (seconds of the WAV — listen to it and write them
//                         down). Scores the app and the current rules on it.
//   --windows w.jsonl     replace the captured window contours with ones
//                         re-transcribed from the WAV (detect_sim --wav), to
//                         measure a TRANSCRIBER change on real audio.
//   --quiet               summary only
//
// Lines are reported as quaver positions in the stored contour (pos/length):
// without the engraved score there are no staff lines, and the position is
// what decides the line anyway.
import { readFileSync } from 'node:fs';
import { SetScoreFollower } from '../../src/js/setScoreFollower.mjs';
import { windowPosition } from '../../src/js/scorePosition.mjs';

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const file = argv.find(a => a.endsWith('.json') && a !== opt('--truth'));
if (!file) { console.error('usage: replayFollowCapture.mjs capture.json [--truth t.json] [--windows w.jsonl] [--quiet]'); process.exit(2); }
const capture = JSON.parse(readFileSync(file, 'utf8'));
const truth = opt('--truth') ? JSON.parse(readFileSync(opt('--truth'), 'utf8')).sort((a, b) => a.start - b.start) : null;
const quiet = argv.includes('--quiet');
const entries = capture.set.entries;
const name = i => (i === null || i === undefined) ? '—' : `${i + 1}. ${entries[i]?.name || '?'}`;

// Windows: captured, or re-transcribed from the WAV.
let windows = capture.events.filter(e => e.type === 'window' && typeof e.contour === 'string')
    .map(e => ({ at: e.windowEndAudioSeconds ?? e.audioSeconds, contour: e.contour, windowSeconds: e.windowSeconds || 10 }));
if (opt('--windows')) {
    windows = readFileSync(opt('--windows'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
        .map(w => ({ at: w.t, contour: w.contour || '', windowSeconds: w.windowSeconds || 10 }));
}

// What the app showed, as a step function over audio time.
const shownEvents = capture.events.filter(e => e.type === 'shown');
const appAt = t => { let s = null; for (const e of shownEvents) { if (e.audioSeconds <= t) s = e; else break; } return s; };
const cues = capture.events.filter(e => e.type === 'cue');
const holds = capture.events.filter(e => e.type === 'hold');
const start = capture.events.find(e => e.type === 'start');

// The current rules, fed the same windows, re-projecting once a second.
const timeline = i => ({ totalMs: (entries[i].contour.length || 1) * 1000, lineCount: entries[i].contour.length,
    events: Array.from(entries[i].contour || 'x', (_, k) => ({ milliseconds: k * 1000, line: k })) });
const follower = new SetScoreFollower(entries.map(e => ({ id: e.id, contour: e.contour })));
follower.select(start?.index || 0);
const end = Math.max(capture.audioSeconds || 0, ...windows.map(w => w.at));
const nowRows = [];
let w = 0, last = { index: start?.index || 0, line: null };
for (let t = 0; t <= end; t += 1) {
    let position = null;
    while (w < windows.length && windows[w].at <= t) {
        position = windowPosition(windows[w].contour, { readAt: windows[w].at * 1000, windowSeconds: windows[w].windowSeconds });
        if (position) last = follower.update({ position, timeline, nowMs: windows[w].at * 1000 + 600 });
        w++;
    }
    if (!position) last = follower.update({ position: null, timeline, nowMs: t * 1000 });
    nowRows.push({ t, index: last.index, line: last.line });
}

const truthAt = t => { let s = null; if (!truth) return null; for (const r of truth) { if (r.start <= t) s = r.entry; else break; } return s; };
if (!quiet) {
    console.log(`${capture.set.name} · ${entries.length} tunes · ${end.toFixed(0)} s · app ${capture.appVersion || '?'} · rules then ${JSON.stringify(capture.rules || {})}`);
    console.log('  time | truth | app showed | current rules | events');
    for (const row of nowRows.filter(r => r.t % 4 === 0)) {
        const app = appAt(row.t);
        const marks = [...cues.filter(c => c.audioSeconds > row.t - 4 && c.audioSeconds <= row.t).map(c => `TAP Next → ${c.index + 1}`),
            ...holds.filter(h => h.audioSeconds > row.t - 4 && h.audioSeconds <= row.t).map(() => 'scrolled by hand')].join(', ');
        const len = i => entries[i]?.contour.length || 0;
        const pos = (i, l) => (l === null || l === undefined) ? 'no line' : `${l}/${len(i)}`;
        console.log(`${String(row.t).padStart(5)}s | ${truth ? String(truthAt(row.t) === null ? '—' : truthAt(row.t) + 1).padStart(5) : '    ?'} | ${(app ? `${app.index + 1} @ ${pos(app.index, app.line)}` : '—').padEnd(14)} | ${`${row.index + 1} @ ${pos(row.index, row.line)}`.padEnd(14)} | ${marks}`);
    }
}
console.log(`\nTaps on Next tune: ${cues.length} · scrolled by hand: ${holds.length} · windows: ${windows.length}`);
if (truth) {
    let appRight = 0, nowRight = 0, n = 0, appNoLine = 0, nowNoLine = 0;
    for (const row of nowRows) {
        const real = truthAt(row.t); if (real === null) continue;
        n++;
        const app = appAt(row.t);
        if (app && app.index === real) { appRight++; if (app.line === null) appNoLine++; }
        if (row.index === real) { nowRight++; if (row.line === null) nowNoLine++; }
    }
    const pct = x => `${(100 * x / Math.max(1, n)).toFixed(0)}%`;
    console.log(`Right tune: app ${pct(appRight)} · current rules ${pct(nowRight)}   (no line while on the right tune: app ${pct(appNoLine)} · now ${pct(nowNoLine)})`);
    for (let k = 1; k < truth.length; k++) {
        const t0 = truth[k].start;
        const appHit = shownEvents.find(e => e.audioSeconds >= t0 && e.index === truth[k].entry);
        const nowHit = nowRows.find(r => r.t >= t0 && r.index === truth[k].entry);
        const fmt = h => h ? `${((h.audioSeconds ?? h.t) - t0).toFixed(0)} s` : 'never';
        console.log(`  → ${name(truth[k].entry)} at ${t0}s: app after ${fmt(appHit)}, current rules after ${fmt(nowHit)}`);
    }
}
