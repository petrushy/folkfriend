// Live probe for the AI tune-summary path. Needs a real API key, costs real
// money (a fraction of a cent), and is deliberately NOT part of CI.
//
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/probe_tune_summary.mjs [tuneID] [model]
//
// Example:
//   ANTHROPIC_API_KEY=... node scripts/probe_tune_summary.mjs 14109 claude-sonnet-5
//
// What it answers that the unit tests cannot, because the unit tests fake the
// network:
//
//   - does web_fetch work for this model, and does it need the beta header?
//     aiSummary.js walks a ladder (bare -> +beta -> no tool) so it degrades
//     rather than failing, and this prints which rung actually served.
//   - did the model really read the page, or write from memory? (pageRead)
//   - what does a summary cost in practice? (usage + estimate)
//
// It drives the real app module rather than a copy: src/services/aiSummary.js is
// loaded from source with its two relative imports rewritten, because a bare
// .js cannot be imported as ESM (app/package.json has no "type": "module").

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..', 'app');
const tmpDir = path.join(here, '.tmp-probe-tune-summary');

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
    console.error('Set ANTHROPIC_API_KEY first. This makes a real, billed API call.');
    process.exit(2);
}

const tuneID = process.argv[2] || '14109';
const model = process.argv[3] || 'claude-haiku-4-5';

async function copyAsMjs(from, to, replacements = []) {
    let source = await readFile(from, 'utf8');
    for (const [a, b] of replacements) source = source.split(a).join(b);
    await writeFile(path.join(tmpDir, to), source);
}

await mkdir(tmpDir, { recursive: true });
await copyAsMjs(path.join(appDir, 'src/services/tuneIndexNetwork.js'), 'tuneIndexNetwork.mjs',
    [['process.env.NODE_ENV', "'probe'"]]);
await copyAsMjs(path.join(appDir, 'src/js/source.mjs'), 'source.mjs');
await copyAsMjs(path.join(appDir, 'src/services/aiSummary.js'), 'aiSummary.mjs', [
    ["from './tuneIndexNetwork.js'", "from './tuneIndexNetwork.mjs'"],
    ["from '../js/source.mjs'", "from './source.mjs'"],
]);

const ai = await import(path.join(tmpDir, 'aiSummary.mjs'));

try {
    console.log(`\ntune ${tuneID} — ${model}\n`);

    const facts = await ai.fetchSessionTuneFacts(tuneID);
    console.log('thesession facts:', facts ? JSON.stringify(facts) : 'unavailable (non-fatal)');

    const started = Date.now();
    const result = await ai.generateTuneSummary({ tuneID, model, apiKey });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    console.log(`page read:       ${result.pageRead}` +
        (result.pageRead === 'ok' ? '' : '   <-- written without the source page'));
    console.log(`web_fetch tool:  ${result.degraded ? 'UNAVAILABLE for this model (dropped)' : 'used'}`);

    // The question this probe exists to answer: the discussion thread sits below
    // a full ABC block per setting, so a fetch can succeed and still be truncated
    // before the comments — which produces a note restating the header metadata.
    if (result.pageStats) {
        console.log(`page text:       ${result.pageStats.chars.toLocaleString()} chars`);
        console.log(`comments found:  ${result.pageStats.looksLikeComments ? 'yes' : 'NO — raise WEB_FETCH_MAX_CONTENT_TOKENS'}`);
    } else if (result.pageRead === 'ok') {
        console.log('page text:       (not exposed in the tool result on this API version)');
    }
    console.log(`usage:           ${JSON.stringify(result.usage)}`);
    console.log(`est. cost:       $${ai.estimateCostUsd(result.usage, result.model).toFixed(4)}`);
    console.log(`elapsed:         ${seconds}s`);
    console.log(`length:          ${result.text.length} chars, ${result.text.split('\n').length} line(s)`);
    console.log(`\n${result.text}\n`);

    // The prompt asks for plain prose; flag it loudly if markdown leaks through,
    // because the dialog renders the text verbatim.
    if (/^\s*[#*\-|]|\*\*/m.test(result.text)) {
        console.log('WARNING: output looks like markdown — the dialog renders text verbatim.');
    }
} catch (e) {
    console.error(`\nFAILED (kind=${e && e.kind}): ${e && e.message}`);
    console.error(`UI would say: ${ai.describeAiSummaryError(e)}`);
    process.exitCode = 1;
} finally {
    await rm(tmpDir, { recursive: true, force: true });
}
