// Reproduce the APP's WASM ML path in Node: same calls the worker makes
// (set_use_ml, set_sample_rate, feed_single_pcm_window per 1024, transcribe,
// run_transcription_query) on a saved clip. Tells us if the WASM path itself
// finds the tune — isolating wasm/wiring bugs from mic-capture bugs.
const fs = require('fs');
const path = require('path');
const wasm = require('./pkg-node/folkfriend.js');

const INDEX = path.join(__dirname, '../app/public/res/folkfriend-non-user-data.json');
const WAV = process.argv[2] || path.join(__dirname, 'wavs/Brännvinslåt_terrible_quality.wav');
const EXPECT = process.argv[3] || '1525005401';

function readWavMonoF32(file) {
    const buf = fs.readFileSync(file);
    const rate = buf.readUInt32LE(24);
    const bits = buf.readUInt16LE(34);
    const channels = buf.readUInt16LE(22);
    // find 'data' chunk
    let off = 12;
    while (off < buf.length) {
        const id = buf.toString('ascii', off, off + 4);
        const sz = buf.readUInt32LE(off + 4);
        if (id === 'data') { off += 8; var dataSz = sz; break; }
        off += 8 + sz;
    }
    const n = Math.floor(dataSz / 2);
    const out = new Float32Array(Math.floor(n / channels));
    for (let i = 0; i < out.length; i++) {
        let s = 0;
        for (let c = 0; c < channels; c++) s += buf.readInt16LE(off + (i * channels + c) * 2) / 32768;
        out[i] = s / channels;
    }
    return { pcm: out, rate, bits, channels };
}

console.log('loading index…');
const raw = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
for (const id in raw.settings) raw.settings[id].abc = ''; // mimic the app (ABC stripped before WASM)

const ff = new wasm.FolkFriendWASM();
ff.load_index_from_json_obj(raw);

const { pcm, rate, channels } = readWavMonoF32(WAV);
console.log(`wav: rate=${rate} channels=${channels} samples=${pcm.length} (~${(pcm.length / rate).toFixed(1)}s)`);

ff.set_use_ml(true);
ff.set_sample_rate(rate);

// Feed exactly like the worker: 1024-sample windows via the reusable buffer,
// re-fetching the memory view each window (memory may grow).
const WIN = 1024;
const ptr = ff.alloc_single_pcm_window();
const nWin = Math.floor(pcm.length / WIN);
for (let i = 0; i < nWin; i++) {
    const view = ff.get_allocated_pcm_window(ptr);
    view.set(pcm.subarray(i * WIN, i * WIN + WIN));
    ff.feed_single_pcm_window(ptr);
}

const contour = ff.transcribe_pcm_buffer();
console.log(`\nML contour (len ${contour.length}): ${contour}`);

const results = JSON.parse(ff.run_transcription_query(contour));
console.log('\nTop 5 results:');
results.slice(0, 5).forEach((r, i) => console.log(`  #${i + 1} ${r.setting.tune_id}\t${r.score.toFixed(3)}\t${r.display_name}`));

const rank = results.findIndex(r => String(r.setting.tune_id) === EXPECT);
console.log(`\nExpected tune ${EXPECT}: ${rank === -1 ? 'NOT FOUND in top ' + results.length : 'rank #' + (rank + 1)}`);
