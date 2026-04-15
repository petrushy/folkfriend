const FOLKWIKI_TUNE_ID_BASE = 1000000;

function safeString(value) {
    return typeof value === 'string' ? value : '';
}

function encodeFolkwikiTitle(displayName) {
    const title = safeString(displayName).trim().replace(/ /g, '_').replace(/[?#]/g, '');
    return encodeURIComponent(title).replace(/%2F/g, '/');
}

export function isThesessionTuneID(tuneID) {
    const n = parseInt(tuneID, 10);
    return !Number.isNaN(n) && n < FOLKWIKI_TUNE_ID_BASE;
}

export function sourceNameForTuneID(tuneID) {
    return isThesessionTuneID(tuneID) ? 'thesession' : 'folkwiki';
}

export function tuneSourceUrl({ tuneID, displayName = '', sourceUrl = '' }) {
    if (isThesessionTuneID(tuneID)) {
        return `https://thesession.org/tunes/${tuneID}`;
    }

    if (sourceUrl) {
        return sourceUrl;
    }

    const encodedTitle = encodeFolkwikiTitle(displayName);
    return encodedTitle ? `http://www.folkwiki.se/Musik/${encodedTitle}` : 'http://www.folkwiki.se/';
}

export function settingSourceUrl({ tuneID, settingID = '', displayName = '', sourceUrl = '' }) {
    if (isThesessionTuneID(tuneID)) {
        return settingID
            ? `https://thesession.org/tunes/${tuneID}#setting${settingID}`
            : `https://thesession.org/tunes/${tuneID}`;
    }

    return tuneSourceUrl({ tuneID, displayName, sourceUrl });
}
