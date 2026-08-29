// src/js/sessionAnalysis.js is webpack-alias'd ('@/js/...'), which node cannot
// resolve, so it is copied to a temp file with those two imports rewritten to
// stubs. Neither stub is reached by anything tested here — parseDisplayableName
// is used only by normaliseQueryResults and settingSourceUrl only by
// buildTuneListText — but they have to resolve for the module to load at all.
//
// Asserting on each rewritten import means a future refactor of the module's
// imports fails loudly rather than silently testing a stale copy.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', '..', 'src');
const tmpDir = path.join(here, '..', '.tmp-session-analysis');

export async function loadSessionAnalysisModule() {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(path.join(tmpDir, 'fake-utils.mjs'),
        'export default { parseDisplayableName: (n) => n };\n');
    await writeFile(path.join(tmpDir, 'fake-source.mjs'),
        'export function settingSourceUrl() { return \'\'; }\n');

    let source = await readFile(path.join(srcDir, 'js', 'sessionAnalysis.js'), 'utf8');
    const replacements = [
        ["from '@/js/utils.js'", "from './fake-utils.mjs'"],
        ["from '@/js/source.mjs'", "from './fake-source.mjs'"],
    ];
    for (const [from, to] of replacements) {
        assert.ok(source.includes(from), `expected to find ${JSON.stringify(from)} in sessionAnalysis.js`);
        source = source.split(from).join(to);
    }

    const target = path.join(tmpDir, 'sessionAnalysis.mjs');
    await writeFile(target, source);
    return import(`${target}?v=${Math.random()}`);
}

export const sessionAnalysisTmpDir = tmpDir;
