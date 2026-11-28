// The one date format the app shows (src/js/dateFormat.mjs).
//
// Run with:  node app/test/dateFormat.test.mjs

import assert from 'node:assert/strict';
import { formatDate, formatTime, formatDateTime } from '../src/js/dateFormat.mjs';

const at = new Date(2026, 10, 28, 7, 5).getTime();
const evening = new Date(2026, 0, 3, 21, 40).getTime();

assert.equal(formatDateTime(at), '2026-11-28 07:05', 'zero-padded, 24-hour, no AM/PM');
assert.equal(formatDateTime(evening), '2026-01-03 21:40');
assert.equal(formatDate(evening), '2026-01-03');
assert.equal(formatTime(evening), '21:40');
assert.equal(formatDateTime(Number.NaN), '', 'nothing rather than "Invalid Date"');
console.log('  ✓ YYYY-MM-DD HH:MM, 24-hour, everywhere\n\n1 passed');
