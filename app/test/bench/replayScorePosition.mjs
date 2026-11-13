// Replays simulated performances of real thesession settings through the
// follow view's position rules, the per-window rule it replaced (pass its
// source as OLD=path) and the tracker, and reports how often each puts the
// right line on screen.
//
//   node test/bench/replayScorePosition.mjs [sessions=300] [OLD=/path/to/old.mjs]
//
// Needs public/res/thesession.json (download_tune_data.sh).
//
// A performance plays a setting's played-out contour two or three times at a
// tempo that drifts, with transcription-like damage (wrong, missing and extra
// notes), optionally with a stretch of improvisation and a jump to another
// place. A window every `step` seconds is the last 10 s of what was played.
// Synthetic, so it compares the rules; it says nothing absolute about a pub.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as tracker from '../../src/js/scorePosition.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map(a => a.includes('=') ? a.split('=') : ['sessions', a]));
const SESSIONS = Number(args.sessions || 300);
const old = args.OLD ? await import(pathToFileURL(path.resolve(args.OLD))) : null;
const data = JSON.parse(readFileSync(path.join(here, '../../public/res/thesession.json'), 'utf8'));

let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const ALPH = 'mnopqrstuvwxyzABCDEFG';

const settings = Object.values(data.settings).filter(s => s.contour && s.contour.length >= 120 && s.contour.length <= 700);

function perform(stored, { hard }) {
    const notes = [];
    const truth = [];
    const times = [];
    let clock = 0;
    let pace = 4 + rnd() * 4;          // quavers per second
    let at = 0;
    const L = stored.length;
    const laps = 2 + Math.floor(rnd() * 2);
    const sub = process.env.CLEAN ? 0 : hard ? 0.14 : 0.07;
    const indel = process.env.CLEAN ? 0 : hard ? 0.06 : 0.03;
    const improvAt = !process.env.CLEAN && rnd() < 0.5 ? Math.floor(L * (0.3 + rnd() * laps * 0.6)) : -1;
    const jumpAt = !process.env.CLEAN && rnd() < 0.4 ? Math.floor(L * (0.4 + rnd() * laps * 0.5)) : -1;
    const push = (c) => { notes.push(c); truth.push(at); clock += 1 / pace; times.push(clock); };
    let played = 0;
    while (played < L * laps) {
        if (played === improvAt) {
            const n = Math.floor(pace * (6 + rnd() * 14));
            for (let k = 0; k < n; k++) { at++; push(ALPH[Math.floor(rnd() * ALPH.length)]); }
            played += n;
            continue;
        }
        if (played === jumpAt) at = Math.floor(rnd() * L);
        pace *= 1 + (rnd() - 0.5) * 0.01;
        const c = stored[at % L];
        at++;
        played++;
        const r = rnd();
        if (r < indel) continue;                                     // missed note
        if (r < 2 * indel) { push(ALPH[Math.floor(rnd() * ALPH.length)]); }  // extra note
        push(rnd() < sub ? ALPH[Math.floor(rnd() * ALPH.length)] : c);
    }
    return { notes, truth, times, L };
}

function timelineFor(stored) {
    // A line per 32 quavers (four bars of 4/4), as a played-out timeline. A
    // block identical to an earlier one is that block's line again, as a
    // written repeat is on a real score: both times through an A part are
    // the same written line, and either is a right answer.
    const L = stored.length;
    const blocks = Math.max(1, Math.round(L / 32));
    const size = L / blocks;
    const lineOfBlock = [];
    const seen = new Map();
    for (let b = 0; b < blocks; b++) {
        const text = stored.slice(Math.round(b * size), Math.round((b + 1) * size));
        if (!seen.has(text)) seen.set(text, seen.size);
        lineOfBlock.push(seen.get(text));
    }
    const events = [];
    for (let q = 0; q < L; q++) events.push({ milliseconds: q * 100, line: lineOfBlock[Math.floor(q / size)] });
    return { events, totalMs: L * 100, lineCount: seen.size };
}

function run(rule, hard) {
    seed = hard ? 991 : 7;
    let seconds = 0;
    let right = 0;
    let wrong = 0;
    let none = 0;
    let wrongJumps = 0;
    let nearby = 0;
    for (let i = 0; i < SESSIONS; i++) {
        const setting = settings[Math.floor(rnd() * settings.length)];
        const stored = setting.contour;
        const perf = perform(stored, { hard });
        const timeline = timelineFor(stored);
        const lineOfQ = (q) => tracker.lineAtFraction(timeline, (((q % perf.L) + perf.L) % perf.L) / perf.L);
        const end = perf.times[perf.times.length - 1];
        let state = null;
        let follow = null;
        let mark = null;
        let position = null;
        let lastShown = null;
        const step = 3;
        let nextWindow = 10;
        for (let t = 10; t <= end; t += 1) {
            if (t >= nextWindow) {
                nextWindow += step;
                const idx = perf.times.findIndex(x => x > t);
                const stop = idx < 0 ? perf.notes.length : idx;
                const startIdx = perf.times.findIndex(x => x > t - 10);
                const contour = perf.notes.slice(startIdx, stop).join('');
                position = tracker.windowPosition(contour, { readAt: t * 1000, windowSeconds: 10 });
                if (rule === 'new' && position) {
                    state = tracker.trackPosition(state, position, {
                        storedContour: stored,
                        lineOf: (e) => tracker.lineAtFraction(timeline, e / stored.length),
                    });
                }
            }
            let line = null;
            if (rule === 'new') {
                const p = tracker.followPoint(state, t * 1000, stored.length);
                const l = p ? tracker.lineAtFraction(timeline, p.fraction) : null;
                const m = p ? `${p.epoch}:${p.lap}` : null;
                follow = tracker.nextFollowLine(follow, l, position && position.readAt,
                    { force: !!p && mark !== null && m !== mark });
                mark = m;
                line = follow.line;
            } else {
                const d = old.decideLine(position, { storedContour: stored, nowMs: t * 1000, timeline });
                follow = old.nextFollowLine(follow, d.line, position && position.readAt);
                line = follow.line;
            }
            const idx = perf.times.findIndex(x => x > t);
            const truthQ = perf.truth[(idx < 0 ? perf.truth.length : idx) - 1];
            const want = lineOfQ(truthQ);
            seconds++;
            if (line === null) none++;
            else if (line === want) right++;
            else wrong++;
            // A move to a line more than one away from the music: a jump the
            // reader notices, not a boundary landing a second early or late.
            const off = line === null ? 0 : Math.min(Math.abs(line - want), timeline.lineCount - Math.abs(line - want));
            if (line !== null && lastShown !== null && line !== lastShown && off > 1) wrongJumps++;
            if (line !== null && off <= 1) nearby++;
            lastShown = line;
        }
    }
    const pct = (x) => `${(100 * x / seconds).toFixed(1)} %`;
    return { right: pct(right), 'within a line': pct(nearby), wrong: pct(wrong), none: pct(none), 'wrong moves/min': (60 * wrongJumps / seconds).toFixed(2) };
}

const rows = {};
for (const hard of [false, true]) {
    const label = hard ? 'hard' : 'normal';
    if (old) rows[`old · ${label}`] = run('old', hard);
    rows[`new · ${label}`] = run('new', hard);
}
console.table(rows);
