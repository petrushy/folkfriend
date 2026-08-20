// Where a tune came from, and how to link back to it.
//
// The index is published as one file per source, and the worker labels every
// tune with the dataset it was loaded from (see datasetByTune in worker.js).
// That label is authoritative. Everything here takes an optional `dataset` and
// prefers it.
//
// The ID-range fallback below is ONLY for tunes that came from a legacy merged
// blob — the pre-multi-dataset `folkfriend-non-user-data.json`, or a schema-1/2
// copy still in a user's IndexedDB. Those contain thesession and folkwiki and
// nothing else, by construction, which is why the fallback is a single
// threshold and why NORBECK IS DELIBERATELY NOT IN IT: adding a third range
// would create another place that has to agree with the data repo's ID bases,
// for a case that cannot arise.

export const DATASET_THESESSION = 'thesession';
export const DATASET_FOLKWIKI = 'folkwiki';
export const DATASET_NORBECK = 'norbeck';

const KNOWN_DATASETS = new Set([
    DATASET_THESESSION,
    DATASET_FOLKWIKI,
    DATASET_NORBECK,
]);

// Legacy-blob fallback only. See the note above.
const FOLKWIKI_TUNE_ID_BASE = 1000000;

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

function encodeFolkwikiTitle(displayName) {
    const title = safeString(displayName).trim().replace(/ /g, '_').replace(/[?#]/g, '');
    return encodeURIComponent(title).replace(/%2F/g, '/');
}

// Which dataset a tune belongs to. `dataset` wins when it is a known id.
export function datasetForTuneID(tuneID, dataset = '') {
    if (KNOWN_DATASETS.has(dataset)) {
        return dataset;
    }
    const n = parseInt(tuneID, 10);
    return (!Number.isNaN(n) && n < FOLKWIKI_TUNE_ID_BASE)
        ? DATASET_THESESSION
        : DATASET_FOLKWIKI;
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
    if (sourceUrl) {
        return sourceUrl;
    }

    if (id === DATASET_NORBECK) {
        return 'https://www.norbeck.nu/abc/';
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
