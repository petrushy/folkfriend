import assert from 'node:assert/strict';

import {
    isThesessionTuneID,
    settingSourceUrl,
    sourceNameForTuneID,
    tuneSourceUrl,
} from '../src/js/source.mjs';

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

console.log('source-links.test.mjs passed');
