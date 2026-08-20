import assert from 'node:assert/strict';

import {
    datasetForTuneID,
    isThesessionTuneID,
    settingSourceUrl,
    sourceNameForTuneID,
    tuneSourceUrl,
} from '../src/js/source.mjs';

// --- Legacy ID-range fallback ------------------------------------------
// Everything below the dataset section must keep passing WITHOUT a dataset
// argument: it is how tunes loaded from a legacy merged blob are classified,
// and those blobs are still in users' IndexedDB.

assert.equal(isThesessionTuneID('15326'), true);
assert.equal(isThesessionTuneID('1000000'), false);

assert.equal(sourceNameForTuneID('15326'), 'thesession');
assert.equal(sourceNameForTuneID('1000000'), 'folkwiki');

assert.equal(
    tuneSourceUrl({
        tuneID: '15326',
        displayName: 'the maid behind the bar',
    }),
    'https://thesession.org/tunes/15326'
);

assert.equal(
    settingSourceUrl({
        tuneID: '15326',
        settingID: '28560',
        displayName: 'the maid behind the bar',
    }),
    'https://thesession.org/tunes/15326#setting28560'
);

assert.equal(
    tuneSourceUrl({
        tuneID: '1000001',
        displayName: 'på hedinsgården',
        sourceUrl: 'http://www.folkwiki.se/pub/cache/P%E5_Hedinsg%E5rden_0013c0.abc',
    }),
    'http://www.folkwiki.se/pub/cache/P%E5_Hedinsg%E5rden_0013c0.abc'
);

assert.equal(
    settingSourceUrl({
        tuneID: '1000001',
        settingID: '2000001',
        displayName: 'på hedinsgården',
        sourceUrl: 'http://www.folkwiki.se/pub/cache/P%E5_Hedinsg%E5rden_0013c0.abc',
    }),
    'http://www.folkwiki.se/pub/cache/P%E5_Hedinsg%E5rden_0013c0.abc'
);

assert.equal(
    tuneSourceUrl({
        tuneID: '1000001',
        displayName: 'på hedinsgården',
    }),
    'http://www.folkwiki.se/Musik/p%C3%A5_hedinsg%C3%A5rden'
);

// --- Explicit dataset labels -------------------------------------------
// The worker labels every tune with the dataset file it was loaded from. That
// label is authoritative and must beat the ID range, because the range cannot
// describe a third source: folkwiki's IDs run to ~1.68e9, so there is no
// "folkwiki is 1e6..2e6, norbeck is above" story to tell.

assert.equal(datasetForTuneID('15326'), 'thesession');
assert.equal(datasetForTuneID('1000000'), 'folkwiki');
assert.equal(datasetForTuneID('3001472672', 'norbeck'), 'norbeck');

// An explicit dataset overrides what the ID range would have said.
assert.equal(datasetForTuneID('15326', 'norbeck'), 'norbeck');
assert.equal(datasetForTuneID('1000000', 'thesession'), 'thesession');
assert.equal(sourceNameForTuneID('1000000', 'norbeck'), 'norbeck');
assert.equal(isThesessionTuneID('1000000', 'thesession'), true);
assert.equal(isThesessionTuneID('15326', 'folkwiki'), false);

// An unknown dataset id falls back rather than propagating nonsense into the
// UI — a stale label from an older build must not break the source chip.
assert.equal(datasetForTuneID('15326', 'not-a-dataset'), 'thesession');
assert.equal(datasetForTuneID('1000000', ''), 'folkwiki');

// Norbeck URLs are never derivable from the tune id, so source_url is
// mandatory in the data and is used verbatim.
assert.equal(
    tuneSourceUrl({
        tuneID: '3001472672',
        dataset: 'norbeck',
        displayName: 'flogging reel, the',
        sourceUrl: 'https://www.norbeck.nu/abc/display.asp?rhythm=reel&ref=1',
    }),
    'https://www.norbeck.nu/abc/display.asp?rhythm=reel&ref=1'
);

// A norbeck tune with no source_url must not fall through to a folkwiki URL.
assert.equal(
    tuneSourceUrl({
        tuneID: '3001472672',
        dataset: 'norbeck',
        displayName: 'flogging reel, the',
    }),
    'https://www.norbeck.nu/abc/'
);

// Settings links: thesession gets an anchor, the others do not.
assert.equal(
    settingSourceUrl({
        tuneID: '3001472672',
        settingID: '8001472672',
        dataset: 'norbeck',
        sourceUrl: 'https://www.norbeck.nu/abc/display.asp?rhythm=reel&ref=1',
    }),
    'https://www.norbeck.nu/abc/display.asp?rhythm=reel&ref=1'
);

console.log('source-links.test.mjs passed');
