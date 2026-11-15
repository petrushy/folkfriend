// Replays simulated sessions through the set score follower, to measure how
// quickly it moves to the next tune in a set and how often it moves wrongly.
//
//   cd rust && DETECT_SIM_CONTOURS=1 ./target/release/examples/detect_sim \
//       ../app/public/res/thesession.json 80 11 > /tmp/setsim.jsonl
//   node app/test/bench/replaySetFollow.mjs /tmp/setsim.jsonl [more.jsonl...]
//
// Each session is three tunes played back to back; the SET is those three
// tunes in order. Three variants:
//   exact  — the set holds exactly the setting being played
//   other  — the set holds a different setting of each tune (how people play
//            rarely matches the stored setting note for note)
//   skip   — like exact, plus an unplayed same-type tune between tunes 1 and 2
//            (a tune skipped tonight); the follower must jump over it
//   confusable — like exact, plus an unplayed tune of the same type and key
//            after every played tune; measures false switches
// Windows arrive as the practice follower makes them: a 10 s window every
// 4 s, first at 4 s.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SetScoreFollower } from '../../src/js/setScoreFollower.mjs';
import { windowPosition } from '../../src/js/scorePosition.mjs';
import { PRACTICE_STEP_SECONDS, PRACTICE_FIRST_QUERY_SECONDS } from '../../src/js/practiceFollow.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const index = JSON.parse(readFileSync(path.join(here, '../../public/res/thesession.json'), 'utf8'));
const settings = index.settings;
const byTune = new Map();
for (const [sid, s] of Object.entries(settings)) {
    if (!byTune.has(s.tune_id)) byTune.set(s.tune_id, []);
    byTune.get(s.tune_id).push(sid);
}
const sessions = process.argv.slice(2).flatMap(f => readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l)));

function rng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }
const allSids = Object.keys(settings).filter(sid => (settings[sid].contour || '').length >= 80);

function buildSet(session, variant) {
    const r = rng(session.session * 7919 + 13);
    const pick = part => {
        if (variant !== 'other') return part.settingId;
        // Same key: a set holds the setting the player chose to play, so a
        // different key is not a realistic mismatch (contours are pitches).
        const others = byTune.get(part.tuneId).filter(sid => sid !== part.settingId && (settings[sid].contour || '').length >= 40
            && settings[sid].mode === settings[part.settingId].mode);
        return others.length ? others[Math.floor(r() * others.length)] : part.settingId;
    };
    const entries = session.truth.map(part => ({ tuneId: part.tuneId, sid: pick(part) }));
    if (variant === 'skip') {
        const dance = settings[session.truth[1].settingId].dance;
        const pool = allSids.filter(sid => settings[sid].dance === dance && !session.truth.some(t => t.tuneId === settings[sid].tune_id));
        const sid = pool[Math.floor(r() * pool.length)];
        entries.splice(1, 0, { tuneId: settings[sid].tune_id, sid, decoy: true });
    }
    if (variant === 'confusable') {
        // After every played tune, an unplayed tune of the same type AND key:
        // the follower must neither land on it nor be held up by it.
        for (let k = session.truth.length - 1; k >= 0; k--) {
            const played = settings[session.truth[k].settingId];
            const pool = allSids.filter(sid => settings[sid].dance === played.dance && settings[sid].mode === played.mode
                && !session.truth.some(t => t.tuneId === settings[sid].tune_id));
            const sid = pool[Math.floor(r() * pool.length)];
            entries.splice(k + 1, 0, { tuneId: settings[sid].tune_id, sid, decoy: true });
        }
    }
    return entries.map(e => ({ ...e, contour: settings[e.sid].contour }));
}

function replay(session, entries, options) {
    const follower = new SetScoreFollower(entries.map((e, i) => ({ id: String(i), contour: e.contour })), options);
    const playedAt = t => session.truth.find(p => t >= p.start && t < p.end);
    const shownEvery = [];
    const windows = new Map(session.windows.map(w => [w.t, w]));
    const last = Math.floor(session.truth.at(-1).end);
    let shown = 0;
    for (let t = 1; t <= last; t++) {
        if (t >= PRACTICE_FIRST_QUERY_SECONDS && (t - PRACTICE_FIRST_QUERY_SECONDS) % PRACTICE_STEP_SECONDS === 0) {
            const w = windows.get(t);
            const position = w && windowPosition(w.contour, { readAt: t * 1000, windowSeconds: Math.min(10, t) });
            // A transcription takes a moment; the view reads it shortly after.
            shown = follower.update({ position, timeline: () => null, nowMs: t * 1000 + 600 }).index;
        }
        shownEvery.push({ t, shown, played: playedAt(t - 0.5) });
    }
    return shownEvery;
}

function measure(variant, options) {
    const latencies = []; let transitions = 0, missed = 0, total = 0, lag = 0, wrong = 0;
    for (const session of sessions) {
        const entries = buildSet(session, variant);
        const trace = replay(session, entries, options);
        for (const row of trace) {
            if (!row.played) continue;
            total++;
            const shownTune = entries[row.shown].tuneId;
            if (shownTune === row.played.tuneId) continue;
            // Behind (a tune already played) is a delay; anything else — a tune
            // not played yet, or one never played — is a wrong claim.
            const k = session.truth.indexOf(row.played);
            if (session.truth.slice(0, k).some(p => p.tuneId === shownTune)) lag++; else wrong++;
        }
        for (let k = 1; k < session.truth.length; k++) {
            transitions++;
            const part = session.truth[k];
            const hit = trace.find(row => row.played === part && entries[row.shown].tuneId === part.tuneId);
            if (hit) latencies.push(hit.t - part.start); else missed++;
        }
    }
    latencies.sort((a, b) => a - b);
    const q = p => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))].toFixed(1) : '—';
    return { median: q(0.5), p90: q(0.9), missed: `${(100 * missed / transitions).toFixed(1)}%`,
             lagging: `${(100 * lag / total).toFixed(1)}%`, wrong: `${(100 * wrong / total).toFixed(2)}%` };
}

const grid = process.env.GRID ? JSON.parse(process.env.GRID) : [{}];
console.log(`${sessions.length} sessions, ${sessions.length * 2} tune changes per variant`);
console.log('options | variant | switch after (median / p90 s) | never switched | time behind | time on a WRONG tune');
for (const options of grid) {
    for (const variant of (process.env.VARIANTS || 'exact,other,skip,confusable').split(',')) {
        const m = measure(variant, options);
        console.log(`${JSON.stringify(options)} | ${variant} | ${m.median} / ${m.p90} | ${m.missed} | ${m.lagging} | ${m.wrong}`);
    }
}
