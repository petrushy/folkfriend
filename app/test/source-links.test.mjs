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

// An id this build does not recognise is PASSED THROUGH, not relabelled. A
// dataset added to the published manifest after this release must not be
// silently reported as folkwiki by the range fallback — that is precisely the
// mislabelling the explicit label exists to prevent.
assert.equal(datasetForTuneID('15326', 'a-later-dataset'), 'a-later-dataset');
assert.equal(sourceNameForTuneID('15326', 'a-later-dataset'), 'a-later-dataset');
assert.equal(datasetForTuneID('1000000', ''), 'folkwiki');

// ...and an unknown dataset has no derivable URL, so the caller gets '' and can
// hide the link rather than sending the user to a folkwiki page that has
// nothing to do with the tune.
assert.equal(tuneSourceUrl({ tuneID: '999', dataset: 'a-later-dataset' }), '');
assert.equal(
    tuneSourceUrl({
        tuneID: '999', dataset: 'a-later-dataset', sourceUrl: 'https://x/1',
    }),
    'https://x/1'
);

// An UNLABELLED norbeck tune — a favourite saved before labelling existed —
// must still be identified correctly. Without a norbeck range here it fell
// through to folkwiki, which is the bug this fallback is meant to prevent.
assert.equal(datasetForTuneID('3001472672'), 'norbeck');
assert.equal(datasetForTuneID('7292804357'), 'norbeck');
assert.equal(sourceNameForTuneID('3001472672'), 'norbeck');
// ...without swallowing folkwiki, whose hash term reaches ~1.68e9.
assert.equal(datasetForTuneID('1678715901'), 'folkwiki');
assert.equal(datasetForTuneID('1398101'), 'folkwiki');

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
