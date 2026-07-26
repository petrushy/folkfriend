// Network access for the tune index — deliberately bounded.
//
// Every fetch here used to be unbounded. That is fine when you are offline
// (fetch rejects immediately) but catastrophic on the exact network people
// actually hit: aeroplane / hotel / captive-portal Wi-Fi, where the device
// reports itself online, TCP connects, and then nothing ever arrives. The
// request hangs for the platform default (a minute or more), the app sits in
// "loading" forever, and every view that waits on the index pays its own
// timeout on top.
//
// So: an overall deadline AND a stall deadline (abort if no bytes arrive for
// N seconds), on every request.

const META_PATH = 'nud-meta.json';
const INDEX_PATH = 'folkfriend-non-user-data.json';

// eslint-disable-next-line no-undef
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const BASE_URL = IS_PRODUCTION ? 'https://folkfriend-data.web.app/' : '/res/';

export const TIMEOUTS = {
    // nud-meta.json is ~50 bytes. If it hasn't answered in 8s the network is
    // not usable, whatever navigator.onLine claims.
    METADATA_MS: 8000,
    // The index is ~42 MB, so no useful overall deadline exists on a slow
    // link — but a connection that goes 20s without delivering a single byte
    // is dead, not slow.
    INDEX_STALL_MS: 20000,
    INDEX_TOTAL_MS: 10 * 60 * 1000,
};

export function tuneIndexMetadataUrl() {
    return BASE_URL + META_PATH;
}

export function tuneIndexDataUrl(bypassCacheVersion = null) {
    const url = BASE_URL + INDEX_PATH;
    return bypassCacheVersion === null ? url : `${url}?v=${bypassCacheVersion}`;
}

export class NetworkUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NetworkUnavailableError';
    }
}

// True when the platform is confident there is no network at all. Treated as
// authoritative for "don't even try" — but never as authoritative for the
// reverse: navigator.onLine === true means very little (a captive portal is
// "online"), which is why the timeouts above exist.
export function isDefinitelyOffline() {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
}

// fetch() with a hard deadline. Used for small responses only.
async function fetchWithDeadline(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { signal: controller.signal });
    } catch (e) {
        if (e && e.name === 'AbortError') {
            throw new NetworkUnavailableError(`Request timed out after ${timeoutMs} ms: ${url}`);
        }
        throw new NetworkUnavailableError(`Request failed: ${url} (${e && e.message})`);
    } finally {
        clearTimeout(timer);
    }
}

export async function fetchTuneIndexMetadata() {
    if (isDefinitelyOffline()) {
        throw new NetworkUnavailableError('Device is offline');
    }
    const response = await fetchWithDeadline(tuneIndexMetadataUrl(), TIMEOUTS.METADATA_MS);
    if (!response.ok) {
        throw new NetworkUnavailableError(`Tune index metadata HTTP ${response.status}`);
    }
    return response.json();
}

// Download the tune index as raw text, streaming so that a stalled connection
// is detected rather than waited on. `onProgress({ received, total })` is
// called as bytes arrive (total is 0 when the server sends no Content-Length).
export async function fetchTuneIndexText(bypassCacheVersion = null, onProgress = null) {
    if (isDefinitelyOffline()) {
        throw new NetworkUnavailableError('Device is offline');
    }

    const url = tuneIndexDataUrl(bypassCacheVersion);
    const controller = new AbortController();

    let stallTimer = null;
    const totalTimer = setTimeout(() => controller.abort(), TIMEOUTS.INDEX_TOTAL_MS);
    const bumpStallTimer = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => controller.abort(), TIMEOUTS.INDEX_STALL_MS);
    };
    const cleanup = () => {
        clearTimeout(totalTimer);
        if (stallTimer) clearTimeout(stallTimer);
    };

    console.time('index-download');
    bumpStallTimer();

    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            throw new NetworkUnavailableError(`Tune index HTTP ${response.status}`);
        }

        const total = Number(response.headers.get('content-length')) || 0;

        // Streaming path: lets us detect a connection that opens and then
        // delivers nothing, and lets us report download progress.
        if (!response.body || typeof response.body.getReader !== 'function') {
            const text = await response.text();
            if (onProgress) onProgress({ received: text.length, total: text.length });
            return text;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        const parts = [];
        let received = 0;

        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bumpStallTimer();
            received += value.byteLength;
            parts.push(decoder.decode(value, { stream: true }));
            if (onProgress) onProgress({ received, total });
        }
        parts.push(decoder.decode());

        return parts.join('');
    } catch (e) {
        if (e && e.name === 'AbortError') {
            throw new NetworkUnavailableError('Tune index download stalled and was aborted');
        }
        if (e instanceof NetworkUnavailableError) throw e;
        throw new NetworkUnavailableError(`Tune index download failed: ${e && e.message}`);
    } finally {
        cleanup();
        console.timeEnd('index-download');
    }
}
