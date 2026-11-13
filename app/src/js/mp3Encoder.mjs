// A streaming mono MP3 encoder over lamejs's Mp3Encoder (passed in, so node
// tests and the worker share this exact code).
//
// encode() takes float samples in [-1, 1]; finish() flushes and returns the
// encoded bytes as an array of Uint8Arrays (copies — lamejs reuses its output
// buffer between calls).

// lamejs works in multiples of one MP3 frame's samples.
const BLOCK = 1152 * 16;

export function floatToInt16(samples, out = new Int16Array(samples.length)) {
    for (let i = 0; i < samples.length; i++) {
        const s = samples[i] > 1 ? 1 : samples[i] < -1 ? -1 : samples[i];
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
}

function copy(bytes) {
    return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

export function createMp3Encoder(Mp3Encoder, { sampleRate, kbps }) {
    const lame = new Mp3Encoder(1, sampleRate, kbps);
    const chunks = [];
    let bytes = 0;
    const block = new Int16Array(BLOCK);
    return {
        encode(samples) {
            for (let i = 0; i < samples.length; i += BLOCK) {
                const slice = samples.subarray(i, Math.min(samples.length, i + BLOCK));
                const pcm = floatToInt16(slice, slice.length === BLOCK ? block : new Int16Array(slice.length));
                const out = lame.encodeBuffer(pcm);
                if (out.length) { chunks.push(copy(out)); bytes += out.length; }
            }
        },
        finish() {
            const out = lame.flush();
            if (out.length) { chunks.push(copy(out)); bytes += out.length; }
            return chunks;
        },
        get bytes() { return bytes; },
    };
}
