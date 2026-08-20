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

// The manifest listing every published dataset: id, filename, v, date, size.
// It also inherits nud-meta.json's role as the reachability probe — same host,
// ~600 bytes, and required before any download can start.
const DATASETS_MANIFEST_PATH = 'datasets.json';

// Legacy single-blob paths. Still published for installed apps that predate
// dataset selection; this build no longer fetches them.
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

function withCacheBuster(url, bypassCacheVersion) {
    return bypassCacheVersion === null ? url : `${url}?v=${bypassCacheVersion}`;
}

export function tuneIndexMetadataUrl() {
    return BASE_URL + META_PATH;
}

export function tuneIndexDataUrl(bypassCacheVersion = null) {
    return withCacheBuster(BASE_URL + INDEX_PATH, bypassCacheVersion);
}

export function datasetsManifestUrl(bypassCacheVersion = null) {
    return withCacheBuster(BASE_URL + DATASETS_MANIFEST_PATH, bypassCacheVersion);
}

// Filenames come from datasets.json rather than being derived from the dataset
// id, because the CDN owns its filenames and the manifest already carries them
// — deriving `${id}.json` here would be a second place that has to agree.
//
// But the filename goes straight into a URL, so it is validated: a garbled or
// hostile manifest must not be able to repoint a 35 MB download at another
// origin, or walk out of the hosting root.
export function safeDatasetFilename(name) {
    return typeof name === 'string'
        && /^[A-Za-z0-9._-]+\.json$/.test(name)
        && !name.includes('..');
}

export function datasetDataUrl(filename, bypassCacheVersion = null) {
    if (!safeDatasetFilename(filename)) {
        throw new NetworkUnavailableError(`Unsafe dataset filename: ${filename}`);
    }
    return withCacheBuster(BASE_URL + filename, bypassCacheVersion);
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

// Fetch and validate datasets.json.
//
// This is the reachability probe as well as the manifest — the role
// nud-meta.json used to play. Its failure is deliberately fatal before any
// download starts: if ~600 bytes will not come off that host, 35 MB will not
// either, and failing at 8 s is what lets the app say "unavailable" quickly
// instead of grinding on a stalled transfer behind a captive portal.
//
// A malformed manifest is a NetworkUnavailableError, i.e. "we could not find
// out what to install" — never "install nothing", which would look to every
// caller like the CDN legitimately publishes no datasets.
//
// Resolves to { byId: Map<id, entry>, order: [id, ...] }.
export async function fetchDatasetsManifest(bypassCacheVersion = null) {
    if (isDefinitelyOffline()) {
        throw new NetworkUnavailableError('Device is offline');
    }
    const url = datasetsManifestUrl(bypassCacheVersion);
    const response = await fetchWithDeadline(url, TIMEOUTS.METADATA_MS);
    if (!response.ok) {
        throw new NetworkUnavailableError(`datasets.json HTTP ${response.status}`);
    }

    let body;
    try {
        body = await response.json();
    } catch (e) {
        throw new NetworkUnavailableError(`datasets.json is not JSON (${e && e.message})`);
    }

    const entries = body && body.datasets;
    if (!Array.isArray(entries) || entries.length === 0) {
        throw new NetworkUnavailableError('datasets.json lists no datasets');
    }

    const byId = new Map();
    const order = [];
    for (const entry of entries) {
        if (!entry || typeof entry.id !== 'string' || !entry.id) continue;
        if (!safeDatasetFilename(entry.filename)) {
            console.warn(`Ignoring dataset ${entry.id}: unsafe filename `
                + `${entry.filename}`);
            continue;
        }
        byId.set(entry.id, entry);
        order.push(entry.id);
    }
    if (byId.size === 0) {
        throw new NetworkUnavailableError('datasets.json has no usable entries');
    }
    return { byId, order };
}

// Download one dataset as raw text, streaming so that a stalled connection is
// detected rather than waited on. `onProgress({ received, total })` is called
// as bytes arrive (total is 0 when the server sends no Content-Length).
export async function fetchDatasetText(filename, bypassCacheVersion = null, onProgress = null) {
    return await fetchTextStreaming(
        datasetDataUrl(filename, bypassCacheVersion), onProgress);
}

// Legacy single-blob download. Kept for the migration path and the recovery
// e2e test; new installs never call it.
export async function fetchTuneIndexText(bypassCacheVersion = null, onProgress = null) {
    return await fetchTextStreaming(
        tuneIndexDataUrl(bypassCacheVersion), onProgress);
}

// NOTE ON TIMEOUTS: INDEX_TOTAL_MS is now applied PER DATASET, so installing
// three of them can legitimately take three times as long. That is correct —
// a whole-install cap would abort a transfer that is making progress. The 20 s
// stall timer is the real guard against a dead connection, and it is per
// download, which is what we want.
async function fetchTextStreaming(url, onProgress) {
    if (isDefinitelyOffline()) {
        throw new NetworkUnavailableError('Device is offline');
    }

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

    console.time(`index-download:${url}`);
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
        console.timeEnd(`index-download:${url}`);
    }
}
