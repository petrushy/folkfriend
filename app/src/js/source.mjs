// Where a tune came from, and how to link back to it.
//
// The index is published as one file per source, and the worker labels every
// tune with the dataset it was loaded from (see datasetByTune in worker.js).
// That label is authoritative. Everything here takes an optional `dataset` and
// prefers it.
//
// The ID-range fallback below applies when a tune carries no label: a legacy
// merged blob, or a favourite saved before labelling existed.
//
// It originally covered only thesession and folkwiki, on the argument that a
// merged blob contains nothing else by construction so a norbeck range would be
// a third place to keep in sync for a case that could not arise. That argument
// was wrong: a favourite is a self-contained snapshot, so one saved without a
// label reaches this code with a norbeck tune id and gets called folkwiki —
// which is exactly the mislabelling this fallback is supposed to prevent.
// Norbeck's range is included.

export const DATASET_THESESSION = 'thesession';
export const DATASET_FOLKWIKI = 'folkwiki';
export const DATASET_NORBECK = 'norbeck';

const KNOWN_DATASETS = new Set([
    DATASET_THESESSION,
    DATASET_FOLKWIKI,
    DATASET_NORBECK,
]);

// Unlabelled-tune fallback. These MUST match the ID bases in the data repo's
// builders (build_folkwiki_data.py, build_norbeck_data.py). Folkwiki is not the
// small block its base suggests — its hash term carries it to ~1.68e9 — which
// is why norbeck starts three billion up rather than at 3,000,000.
const FOLKWIKI_TUNE_ID_BASE = 1000000;
const NORBECK_TUNE_ID_BASE = 3000000000;

// Human names for the datasets, shared by every view that names one. Kept
// here rather than in a component so Settings and Search cannot drift apart.
export const DATASET_LABELS = {
    [DATASET_THESESSION]: 'The Session',
    [DATASET_FOLKWIKI]: 'Folkwiki',
    [DATASET_NORBECK]: 'Norbeck',
};

export const DATASET_DESCRIPTIONS = {
    [DATASET_THESESSION]: 'Irish and session tunes from thesession.org',
    [DATASET_FOLKWIKI]: 'Swedish folk music from folkwiki.se',
    [DATASET_NORBECK]: 'Henrik Norbeck\u2019s Irish and Swedish collection',
};

// The lowercase identifiers shown on the source chip, which match how each
// site is known rather than how it is titled.
const SOURCE_LABELS = {
    [DATASET_THESESSION]: 'thesession',
    [DATASET_FOLKWIKI]: 'folkwiki',
    [DATASET_NORBECK]: 'norbeck',
};

function safeString(value) {
    return typeof value === 'string' ? value : '';
}

// A source_url comes from a dataset file, and a dataset file can now be one the
// user imported from anywhere. It is put into href attributes and into exported
// HTML, so anything but a plain http(s) URL is dropped: `javascript:` is the
// obvious one, but `data:` is just as good for smuggling markup into a shared
// document. Returns '' for anything it will not vouch for, which every caller
// already handles as "no link".
export function safeSourceUrl(value) {
    const url = safeString(value).trim();
    if (!url) return '';
    let parsed;
    try {
        parsed = new URL(url);
    } catch (e) {
        return '';
    }
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
        ? parsed.toString()
        : '';
}

function encodeFolkwikiTitle(displayName) {
    const title = safeString(displayName).trim().replace(/ /g, '_').replace(/[?#]/g, '');
    return encodeURIComponent(title).replace(/%2F/g, '/');
}

// Which dataset a tune belongs to. An explicit label always wins — INCLUDING
// one this build does not recognise, so a dataset added to the manifest after
// this release is passed through rather than being silently relabelled as
// folkwiki by the range fallback below.
export function datasetForTuneID(tuneID, dataset = '') {
    if (typeof dataset === 'string' && dataset !== '') {
        return dataset;
    }
    const n = parseInt(tuneID, 10);
    if (Number.isNaN(n)) return DATASET_FOLKWIKI;
    if (n < FOLKWIKI_TUNE_ID_BASE) return DATASET_THESESSION;
    if (n >= NORBECK_TUNE_ID_BASE) return DATASET_NORBECK;
    return DATASET_FOLKWIKI;
}

export function isKnownDataset(id) {
    return KNOWN_DATASETS.has(id);
}

export function isThesessionTuneID(tuneID, dataset = '') {
    return datasetForTuneID(tuneID, dataset) === DATASET_THESESSION;
}

export function sourceNameForTuneID(tuneID, dataset = '') {
    const id = datasetForTuneID(tuneID, dataset);
    return SOURCE_LABELS[id] || id;
}

export function tuneSourceUrl({ tuneID, displayName = '', sourceUrl = '', dataset = '' }) {
    const id = datasetForTuneID(tuneID, dataset);

    if (id === DATASET_THESESSION) {
        return `https://thesession.org/tunes/${tuneID}`;
    }

    // folkwiki and norbeck both carry a source_url built at index time. For
    // norbeck it is the ONLY way to reach the tune — nothing about the URL is
    // derivable from the tune id — so it is always present in the data.
    const safe = safeSourceUrl(sourceUrl);
    if (safe) {
        return safe;
    }

    if (id === DATASET_NORBECK) {
        return 'https://www.norbeck.nu/abc/';
    }

    // A dataset this build does not know about has no derivable URL at all.
    // Guessing a folkwiki one would send the user somewhere actively wrong;
    // '' lets the caller hide the link instead.
    if (!KNOWN_DATASETS.has(id)) {
        return '';
    }

    const encodedTitle = encodeFolkwikiTitle(displayName);
    return encodedTitle ? `http://www.folkwiki.se/Musik/${encodedTitle}` : 'http://www.folkwiki.se/';
}

export function settingSourceUrl({ tuneID, settingID = '', displayName = '', sourceUrl = '', dataset = '' }) {
    if (isThesessionTuneID(tuneID, dataset)) {
        return settingID
            ? `https://thesession.org/tunes/${tuneID}#setting${settingID}`
            : `https://thesession.org/tunes/${tuneID}`;
    }

    return tuneSourceUrl({ tuneID, displayName, sourceUrl, dataset });
}
