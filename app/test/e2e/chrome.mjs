// Locating Chrome, and the flags every e2e script needs.
//
// These tests run both on a Mac (where Chrome lives in /Applications) and on a
// Linux CI runner (where it is on PATH, and sandboxing has to be relaxed
// because the runner is already containerised).

import { existsSync } from 'node:fs';

const CANDIDATES = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
].filter(Boolean);

export function resolveChrome() {
    for (const c of CANDIDATES) {
        if (existsSync(c)) return c;
    }
    console.error(
        'Could not find Chrome. Set CHROME_PATH to the binary, e.g.\n' +
        '  CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node <script>');
    process.exit(1);
}

export const CHROME = resolveChrome();

// Flags shared by every scenario.
//
// --disk-cache-size=1 is not an optimisation: Chrome's HTTP disk cache will
// happily serve the 40 MB tune index with the origin unreachable, which makes
// the offline tests pass for entirely the wrong reason. Safari/iOS will not
// hold a response that large, so we must not let Chrome rely on it either.
export const BASE_ARGS = [
    '--headless=new',
    '--no-first-run',
    '--disable-gpu',
    '--disk-cache-size=1',
    // GitHub runners are already sandboxed; Chrome's own sandbox fails there,
    // and /dev/shm is too small for its default shared-memory use.
    ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
];
