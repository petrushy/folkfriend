// Encodes the whole-session export to MP3 off the main thread. Several minutes
// of lamejs on a phone would otherwise freeze the page — and the session bar,
// and any live session's analysis — for the duration.
//
// Protocol (every message carries an `id`, answered once):
//   { type: 'init', options: { sampleRate, kbps } } -> { ok }
//   { type: 'encode', samples: Float32Array }      -> { ok }   (transferred)
//   { type: 'finish' }                             -> { ok, blob }
import { Mp3Encoder } from '@breezystack/lamejs';
import { createMp3Encoder } from '@/js/mp3Encoder.mjs';

let encoder = null;

self.onmessage = ({ data }) => {
    const { id, type } = data || {};
    try {
        if (type === 'init') {
            encoder = createMp3Encoder(Mp3Encoder, data.options);
            self.postMessage({ id, ok: true });
        } else if (type === 'encode') {
            encoder.encode(data.samples);
            self.postMessage({ id, ok: true });
        } else if (type === 'finish') {
            const blob = new Blob(encoder.finish(), { type: 'audio/mpeg' });
            encoder = null;
            self.postMessage({ id, ok: true, blob });
        } else {
            throw new Error(`unknown message ${type}`);
        }
    } catch (e) {
        self.postMessage({ id, ok: false, message: String((e && e.message) || e) });
    }
};
