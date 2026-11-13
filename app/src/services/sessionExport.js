// Browser wiring for the whole-session export (see js/sessionExport.mjs):
// clips from the audio store, decoding through an OfflineAudioContext, and MP3
// encoding in a worker.
import { buildClip, recordingParts } from '@/services/sessionAudioStore.js';
import { exportSession, mp3KbpsFor, EXPORT_SAMPLE_RATE } from '@/js/sessionExport.mjs';

export { canExportWholeSession, ExportCancelled } from '@/js/sessionExport.mjs';

// TWO channels, for the reason the player's channel probe gives: WebKit may
// remix decoded data to the context's channel count, and a one-channel
// context would hide which channel is dead. The sample rate is what the
// decoded buffer is resampled to, so every part arrives at one rate whatever
// it was recorded at.
function decodeBlob(blob) {
    const Offline = typeof window !== 'undefined' &&
        (window.OfflineAudioContext || window.webkitOfflineAudioContext);
    if (!Offline) return Promise.reject(new Error('this browser cannot decode audio'));
    const ctx = new Offline(2, 1, EXPORT_SAMPLE_RATE);
    return blob.arrayBuffer().then(bytes => new Promise((resolve, reject) => {
        let settled = false;
        const ok = (buffer) => { if (!settled) { settled = true; resolve(buffer); } };
        const fail = (e) => {
            if (!settled) { settled = true; reject(e || new Error('the browser could not decode this audio')); }
        };
        let maybePromise;
        try {
            // Callback form: the one older Safari implements most reliably.
            maybePromise = ctx.decodeAudioData(bytes, ok, fail);
        } catch (e) {
            fail(e);
            return;
        }
        if (maybePromise && maybePromise.then) maybePromise.then(ok, fail);
    }));
}

function workerEncoder(options) {
    const worker = new Worker(new URL('./mp3Worker.js', import.meta.url));
    let next = 0;
    const waiting = new Map();
    let broken = null;
    worker.onmessage = ({ data }) => {
        const waiter = waiting.get(data.id);
        if (!waiter) return;
        waiting.delete(data.id);
        if (data.ok) waiter.resolve(data);
        else waiter.reject(new Error(data.message || 'MP3 encoding failed'));
    };
    worker.onerror = (event) => {
        broken = new Error((event && event.message) || 'the MP3 encoder stopped');
        for (const w of waiting.values()) w.reject(broken);
        waiting.clear();
    };
    const call = (message, transfer = []) => {
        if (broken) return Promise.reject(broken);
        const id = ++next;
        return new Promise((resolve, reject) => {
            waiting.set(id, { resolve, reject });
            worker.postMessage({ ...message, id }, transfer);
        });
    };
    const ready = call({ type: 'init', options });
    return {
        async encode(samples) {
            await ready;
            await call({ type: 'encode', samples }, [samples.buffer]);
        },
        async finish() {
            await ready;
            return (await call({ type: 'finish' })).blob;
        },
        close() { worker.terminate(); },
    };
}

// Where workers are unavailable: the same encoder on the main thread.
async function inlineEncoder(options) {
    const [{ Mp3Encoder }, { createMp3Encoder }] = await Promise.all([
        import('@breezystack/lamejs'), import('@/js/mp3Encoder.mjs'),
    ]);
    const encoder = createMp3Encoder(Mp3Encoder, options);
    return {
        async encode(samples) {
            encoder.encode(samples);
            // Let the page breathe between windows.
            await new Promise(resolve => setTimeout(resolve, 0));
        },
        finish() { return new Blob(encoder.finish(), { type: 'audio/mpeg' }); },
        close() {},
    };
}

// The whole recording of `sessionId` as one MP3 File.
export async function exportWholeSessionMp3(sessionId, manifest, { onProgress, isCancelled, name, maxWindowSeconds } = {}) {
    const parts = recordingParts(manifest);
    const options = { sampleRate: EXPORT_SAMPLE_RATE, kbps: mp3KbpsFor(manifest.bitsPerSecond) };
    const encoder = typeof Worker !== 'undefined' ? workerEncoder(options) : await inlineEncoder(options);
    try {
        const { result, seconds } = await exportSession({
            manifest,
            parts,
            buildClip: (from, to) => buildClip(sessionId, from, to, manifest, { requireComplete: true }),
            decode: decodeBlob,
            encoder,
            onProgress,
            isCancelled,
            // Tests only: decoding windows of one segment.
            ...(maxWindowSeconds ? { maxWindowSeconds } : {}),
        });
        const file = new File([result], name || `folkfriend-session-${sessionId}.mp3`, { type: 'audio/mpeg' });
        return { file, seconds, parts: parts.length };
    } finally {
        encoder.close();
    }
}
