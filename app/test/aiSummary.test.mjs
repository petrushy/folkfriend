// Unit tests for the AI tune-summary network layer.
//
// Run with:  node app/test/aiSummary.test.mjs
//
// This module spends the user's money and talks to two third-party origins from
// the browser, so the things worth pinning down are not "does it return a
// string" but the failure modes that are invisible when they go wrong:
//
//   - a tool-result block sitting where the prose is expected, so a naive
//     content[0].text yields a tool result or a TypeError
//   - a refusal, where content is empty and indexing it throws instead of
//     reporting what happened
//   - a web_fetch error, which arrives as HTTP 200 and must not fail the call
//   - a paused server-tool turn, which must be resumed but not forever
//   - the model-gated web_fetch variant, which 400s on the wrong model
//   - an unbounded request, which on captive-portal Wi-Fi hangs on a spinner
//
// The module is loaded from source with its imports rewritten so no browser and
// no network are required.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src', 'services');
const jsDir = path.join(here, '..', 'src', 'js');
const tmpDir = path.join(here, '.tmp-ai-summary');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++;
        console.error(`  ✗ ${name}`);
        console.error(`      ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e}`);
    }
}

// aiSummary.js imports two sibling modules. Both are copied into the temp dir as
// .mjs — a bare `.js` cannot be imported as ESM here, because app/package.json
// has no "type": "module" — and the import specifiers are rewritten to match.
// The assert in rewrite() means a rename in the source fails loudly rather than
// silently testing a stale copy.
async function rewrite(fromPath, toName, replacements) {
    let source = await readFile(fromPath, 'utf8');
    for (const [from, to] of replacements) {
        assert.ok(source.includes(from), `expected to find ${JSON.stringify(from)} in ${fromPath}`);
        source = source.split(from).join(to);
    }
    await writeFile(path.join(tmpDir, toName), source);
}

async function loadAiSummary() {
    await rewrite(path.join(srcDir, 'tuneIndexNetwork.js'), 'tuneIndexNetwork.mjs', [
        ['process.env.NODE_ENV', "'test'"],
    ]);
    await rewrite(path.join(jsDir, 'source.mjs'), 'source.mjs', []);
    await rewrite(path.join(srcDir, 'aiSummary.js'), 'aiSummary.mjs', [
        ["from './tuneIndexNetwork.js'", "from './tuneIndexNetwork.mjs'"],
        ["from '../js/source.mjs'", "from './source.mjs'"],
    ]);
    // Cache-bust so each test gets a fresh module (TIMEOUTS is mutable).
    return import(`${path.join(tmpDir, 'aiSummary.mjs')}?v=${Math.random()}`);
}

// navigator is a read-only getter in recent Node versions.
function stubEnv({ onLine = true, fetchImpl }) {
    Object.defineProperty(globalThis, 'navigator', {
        value: { onLine },
        configurable: true,
        writable: true,
    });
    globalThis.fetch = fetchImpl;
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
    return { ok, status, json: async () => body };
}

function htmlResponse(html, { ok = true, status = 200 } = {}) {
    return { ok, status, text: async () => html };
}

// Records every call so tests can assert on request shape, not just the result.
function recordingFetch(responders) {
    const calls = [];
    const queue = Array.isArray(responders) ? [...responders] : [responders];
    const impl = async (url, opts) => {
        const body = opts && opts.body ? JSON.parse(opts.body) : null;
        calls.push({ url, headers: (opts && opts.headers) || {}, body });
        const next = queue.length > 1 ? queue.shift() : queue[0];
        return typeof next === 'function' ? next(calls.length, body) : next;
    };
    return { impl, calls };
}

const OK_MESSAGE = {
    stop_reason: 'end_turn',
    content: [
        { type: 'web_fetch_tool_result', content: { type: 'web_fetch_result', url: 'https://thesession.org/tunes/14109' } },
        { type: 'text', text: 'The Kesh is an Irish jig first printed in the 1850s.' },
    ],
    usage: { input_tokens: 4000, output_tokens: 300 },
};

const ARGS = {
    tuneID: '14109',
    displayName: 'The Kesh',
    model: 'claude-haiku-4-5',
    apiKey: 'sk-ant-test',
};

// The real thread that exposed the problem, trimmed. Every fact the note should
// contain is in here, and none of it is anywhere else.
const MAGGIES_COMMENTS = [
    'The original name for this tune was "Maggie\'s Pancakes". It\'s a Scottish tune composed by fiddler Stuart Morison of the Tannahill Weavers. The Maggie in the title is Maggie Moore who makes nice pancakes. I\'m sure out of all the places in the world, it is most often played in Cambridge, UK.\n— Dr. Dow',
    'For the record, the tune was written on the same day as Live Aid!\n— smorison',
    'D: Tannahill Weavers, "Dancing Feet"\n— Dr. Dow',
].join('\n\n');

await mkdir(tmpDir, { recursive: true });

console.log('\naiSummary — request construction');

await test('web_fetch variant is gated on the model (the wrong one 400s)', async () => {
    const ai = await loadAiSummary();
    const url = 'https://thesession.org/tunes/14109';

    // Haiku 4.5 is not in the _20260209 support list, so it must get the basic
    // variant. Getting this backwards is a 400 the user would see as "HTTP 400".
    assert.equal(ai.webFetchToolFor('claude-haiku-4-5', url).type, 'web_fetch_20250910');
    assert.equal(ai.webFetchToolFor('claude-sonnet-5', url).type, 'web_fetch_20260209');
    // Unknown models fall back to the default's variant rather than undefined.
    assert.equal(ai.webFetchToolFor('something-new', url).type, 'web_fetch_20250910');
});

await test('the fetch tool is locked to the host being asked about', async () => {
    const ai = await loadAiSummary();
    // Both spellings, or a www redirect is blocked by our own allowlist and
    // looks like an unexplained fetch failure.
    assert.deepEqual(
        ai.webFetchToolFor('claude-haiku-4-5', 'http://www.folkwiki.se/Musik/Foo').allowed_domains,
        ['www.folkwiki.se', 'folkwiki.se'],
    );
    assert.deepEqual(
        ai.webFetchToolFor('claude-haiku-4-5', 'https://thesession.org/tunes/1').allowed_domains,
        ['thesession.org', 'www.thesession.org'],
    );
    // Still an allowlist, though — not an open fetch tool.
    const tool = ai.webFetchToolFor('claude-haiku-4-5', 'https://thesession.org/tunes/1');
    assert.ok(!tool.allowed_domains.some(d => d.includes('example')));
    assert.equal(tool.max_uses, 1);
    assert.ok(tool.max_content_tokens > 0, 'page read must be capped');
    // No parseable host means no tool at all, rather than an unrestricted one.
    assert.equal(ai.webFetchToolFor('claude-haiku-4-5', 'not a url'), null);
});

await test('the browser-access header is sent (without it the preflight fails)', async () => {
    const ai = await loadAiSummary();
    const { impl, calls } = recordingFetch(jsonResponse(OK_MESSAGE));
    stubEnv({ fetchImpl: impl });

    await ai.generateTuneSummary(ARGS);

    assert.equal(calls[0].headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.equal(calls[0].headers['x-api-key'], 'sk-ant-test');
    assert.ok(calls[0].headers['anthropic-version'], 'anthropic-version is required');
    assert.equal(calls[0].headers['anthropic-beta'], undefined, 'no beta header on the first attempt');
});

await test('the prompt carries the source URL and identifying facts', async () => {
    const ai = await loadAiSummary();
    const facts = { name: 'The Kesh', aliases: ['Kincora'], type: 'jig' };
    const prompt = ai.buildPrompt({ displayName: 'The Kesh', url: 'https://thesession.org/tunes/14109', facts });

    assert.ok(prompt.includes('https://thesession.org/tunes/14109'));
    assert.ok(prompt.includes('Kincora'), 'aliases identify the tune');
    // ...but they are handed over as identification only. The first version of
    // this block told the model to "prefer these over the page", which is why
    // early notes read as a restatement of the metadata already on screen.
    assert.ok(/already shows all of this/i.test(prompt));
    assert.ok(!/prefer these/i.test(prompt));
    assert.ok(/no markdown/i.test(prompt), 'plain-prose instruction must survive edits');

    // When there is no fetch tool the prompt must not order a fetch it cannot do.
    const offlinePrompt = ai.buildPrompt({ displayName: 'x', url: 'https://x/1', facts: null, canFetch: false });
    assert.ok(!/^Fetch /m.test(offlinePrompt));
});

await test('the prompt forbids declining, asking, and narrating process', async () => {
    const ai = await loadAiSummary();
    // Observed in the field: with a failed fetch the model reported the network
    // error, declined to write a note, and asked the reader to paste the page in
    // — into a panel that has no reply channel. All three instructions below are
    // what prevent that, so each is pinned.
    for (const canFetch of [true, false]) {
        const prompt = ai.buildPrompt({ displayName: 'Donald Blue', url: 'https://thesession.org/tunes/1', canFetch });
        assert.ok(/never decline/i.test(prompt), `canFetch=${canFetch}: must forbid declining`);
        assert.ok(/never ask for information/i.test(prompt), `canFetch=${canFetch}: must forbid asking`);
        assert.ok(/never suggest trying again/i.test(prompt), `canFetch=${canFetch}: must forbid retry advice`);
        assert.ok(/displayed verbatim/i.test(prompt), `canFetch=${canFetch}: must say the output is rendered as-is`);
    }
    // With a tool attached the prompt must also pre-empt the failure case, or the
    // model treats "fetch failed" as "no record exists" and writes nothing.
    const fetchPrompt = ai.buildPrompt({ displayName: 'x', url: 'https://x/1', canFetch: true });
    assert.ok(/if the fetch fails/i.test(fetchPrompt));
});

await test('the prompt asks for history and forbids restating on-screen metadata', async () => {
    const ai = await loadAiSummary();
    const prompt = ai.buildPrompt({
        displayName: 'The Kesh',
        url: 'https://thesession.org/tunes/14109',
        facts: { name: 'The Kesh', aliases: ['Kincora'], type: 'jig' },
        canFetch: true,
    });

    // Notes were shallow because the model summarised the page header — aliases,
    // key, tune type — all of which the Tune view already renders inches away.
    for (const banned of [/other names or aliases/i, /key, mode or meter/i, /how many settings/i]) {
        assert.ok(banned.test(prompt), `must forbid restating: ${banned}`);
    }
    // And it must be pointed at the discussion, which is the only part of the
    // page carrying history at all.
    assert.ok(/discussion/i.test(prompt), 'must point at the discussion thread');
    for (const wanted of [/geograph/i, /earliest known printing/i, /collections/i, /who collected it/i]) {
        assert.ok(wanted.test(prompt), `must ask for: ${wanted}`);
    }
});

await test('the comment cap is big enough to hold a real thread', async () => {
    const ai = await loadAiSummary();
    // Maggie's Pancakes has 36 comments; the origin discussion is a few hundred
    // characters and sits near the top. This is the input that actually matters
    // now — the web_fetch budget only governs the fallback path, and raising it
    // was tried and did not fix anything.
    const comments = Array.from({ length: 36 }, (_, i) => `Comment ${i}: ${'z'.repeat(300)}`);
    stubEnv({ fetchImpl: async () => jsonResponse({ comments }) });
    const result = await ai.fetchSessionComments('1316');
    assert.ok(result.count >= 36, `a 36-comment thread must fit, got ${result.count}`);
});

console.log('\naiSummary — response handling');

await test('prose is extracted by block type, not by position', async () => {
    const ai = await loadAiSummary();
    // A thinking block and a tool result both sit ahead of the prose here, so
    // content[0].text would return undefined and content[0] is not even text.
    const { impl } = recordingFetch(jsonResponse({
        stop_reason: 'end_turn',
        content: [
            { type: 'thinking', thinking: '' },
            { type: 'web_fetch_tool_result', content: { type: 'web_fetch_result' } },
            { type: 'text', text: 'First paragraph.' },
            { type: 'text', text: 'Second paragraph.' },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
    }));
    stubEnv({ fetchImpl: impl });

    const result = await ai.generateTuneSummary(ARGS);
    assert.equal(result.text, 'First paragraph.\n\nSecond paragraph.');
    assert.equal(result.pageRead, 'ok');
    assert.equal(result.usage.input_tokens, 10);
    assert.equal(result.usage.output_tokens, 5);
});

await test('the tool-call preamble is not treated as the note', async () => {
    const ai = await loadAiSummary();
    // The model narrates before calling a server tool. Joining every text block
    // prepends that narration to the note — this is what put "I'll fetch that
    // page to research the tune's history" at the top of a real summary.
    const { impl } = recordingFetch(jsonResponse({
        stop_reason: 'end_turn',
        content: [
            { type: 'text', text: "I'll fetch that page to research the tune's history and origins." },
            { type: 'web_fetch_tool_result', content: { type: 'web_fetch_result' } },
            { type: 'text', text: 'Donald Blue is a Scottish strathspey.' },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
    }));
    stubEnv({ fetchImpl: impl });

    const result = await ai.generateTuneSummary(ARGS);
    assert.equal(result.text, 'Donald Blue is a Scottish strathspey.');
    assert.ok(!/I'll fetch/.test(result.text), 'the preamble must not reach the reader');
});

await test('a runtime fetch failure is regenerated without the tool', async () => {
    const ai = await loadAiSummary();
    // Observed in the field. The tool was accepted, the fetch then failed, and
    // the model spent the turn explaining that it could not access the page and
    // declining to write — because the prompt still told it the page was the
    // authority. That answer is unusable, so it is worth one more call.
    const { impl, calls } = recordingFetch([
        jsonResponse({
            stop_reason: 'end_turn',
            content: [
                { type: 'text', text: "I'll fetch that page to research the tune's history." },
                { type: 'web_fetch_tool_result', content: { type: 'web_fetch_tool_result_error', error_code: 'unavailable' } },
                { type: 'text', text: 'I am unable to access The Session database at the moment. Rather than fill gaps with plausible invention, I would recommend trying the URL again.' },
            ],
            usage: { input_tokens: 500, output_tokens: 200 },
        }),
        jsonResponse({
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Donald Blue is a Scottish strathspey of uncertain authorship.' }],
            usage: { input_tokens: 300, output_tokens: 150 },
        }),
    ]);
    stubEnv({ fetchImpl: impl });

    const result = await ai.generateTuneSummary(ARGS);

    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.tools, undefined, 'the retry must not offer a tool it cannot use');
    const retryPrompt = calls[1].body.messages[0].content;
    assert.ok(!/^Fetch /m.test(retryPrompt), 'the retry must not still order a fetch');
    assert.ok(/no way to fetch/i.test(retryPrompt));

    assert.equal(result.text, 'Donald Blue is a Scottish strathspey of uncertain authorship.');
    assert.equal(result.degraded, true, 'the UI must be able to caveat this');
    assert.notEqual(result.pageRead, 'ok');
    // Both calls are billed, so both must be counted.
    assert.equal(result.usage.input_tokens, 800);
    assert.equal(result.usage.output_tokens, 350);
});

await test('if the fallback also fails, the first attempt is kept', async () => {
    const ai = await loadAiSummary();
    const { impl, calls } = recordingFetch((n) => {
        if (n === 1) {
            return jsonResponse({
                stop_reason: 'end_turn',
                content: [
                    { type: 'web_fetch_tool_result', content: { type: 'web_fetch_tool_result_error', error_code: 'unavailable' } },
                    { type: 'text', text: 'A thin but usable note.' },
                ],
                usage: { input_tokens: 10, output_tokens: 5 },
            });
        }
        return jsonResponse({ error: { message: 'overloaded' } }, { ok: false, status: 529 });
    });
    stubEnv({ fetchImpl: impl });

    // Turning a caveated note into an error would be a worse outcome than
    // showing it, so the retry failing must not fail the whole call.
    const result = await ai.generateTuneSummary(ARGS);
    assert.equal(calls.length, 2);
    assert.equal(result.text, 'A thin but usable note.');
    assert.equal(result.pageRead, 'error');
});

await test('a refusal reports itself instead of throwing on empty content', async () => {
    const ai = await loadAiSummary();
    const { impl } = recordingFetch(jsonResponse({
        stop_reason: 'refusal',
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
    }));
    stubEnv({ fetchImpl: impl });

    await assert.rejects(
        () => ai.generateTuneSummary(ARGS),
        (e) => e.name === 'AiSummaryError' && e.kind === 'refusal',
    );
});

await test('an empty but successful response is reported as empty', async () => {
    const ai = await loadAiSummary();
    const { impl } = recordingFetch(jsonResponse({
        stop_reason: 'end_turn', content: [], usage: {},
    }));
    stubEnv({ fetchImpl: impl });

    await assert.rejects(
        () => ai.generateTuneSummary(ARGS),
        (e) => e.kind === 'empty',
    );
});

await test('a paused server-tool turn is resumed, and usage accumulates', async () => {
    const ai = await loadAiSummary();
    const { impl, calls } = recordingFetch([
        jsonResponse({ stop_reason: 'pause_turn', content: [], usage: { input_tokens: 100, output_tokens: 10 } }),
        jsonResponse(OK_MESSAGE),
    ]);
    stubEnv({ fetchImpl: impl });

    const result = await ai.generateTuneSummary(ARGS);
    assert.equal(calls.length, 2);
    // Resumed by appending the assistant turn — no synthetic "continue" message.
    assert.equal(calls[1].body.messages.length, 2);
    assert.equal(calls[1].body.messages[1].role, 'assistant');
    assert.equal(result.usage.input_tokens, 100 + 4000);
    assert.equal(result.usage.output_tokens, 10 + 300);
});

await test('a turn that never settles is capped rather than looping', async () => {
    const ai = await loadAiSummary();
    const { impl, calls } = recordingFetch(jsonResponse({
        stop_reason: 'pause_turn', content: [], usage: {},
    }));
    stubEnv({ fetchImpl: impl });

    await assert.rejects(
        () => ai.generateTuneSummary(ARGS),
        (e) => e.kind === 'incomplete',
    );
    // One initial request plus MAX_CONTINUATIONS, and no more.
    assert.equal(calls.length, 3);
});

console.log('\naiSummary — failure paths');

await test('HTTP status maps to a kind the UI can explain', async () => {
    for (const [status, kind] of [[401, 'auth'], [403, 'auth'], [429, 'rate-limit'], [500, 'server'], [418, 'http']]) {
        const ai = await loadAiSummary();
        const { impl } = recordingFetch(jsonResponse(
            { error: { message: 'nope' } },
            { ok: false, status },
        ));
        stubEnv({ fetchImpl: impl });
        await assert.rejects(
            () => ai.generateTuneSummary(ARGS),
            (e) => e.kind === kind,
            `status ${status} should map to ${kind}`,
        );
    }
});

await test('a non-JSON error body does not mask the status', async () => {
    const ai = await loadAiSummary();
    const { impl } = recordingFetch({
        ok: false,
        status: 502,
        json: async () => { throw new Error('not json'); },
    });
    stubEnv({ fetchImpl: impl });

    await assert.rejects(
        () => ai.generateTuneSummary(ARGS),
        (e) => e.kind === 'server' && /502/.test(e.message),
    );
});

await test('the request has a deadline and does not wait on the platform default', async () => {
    const ai = await loadAiSummary();
    ai.TIMEOUTS.CLAUDE_MS = 60;

    let aborted = false;
    stubEnv({
        fetchImpl: (url, opts) => new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => {
                aborted = true;
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
            });
        }),
    });

    const started = Date.now();
    await assert.rejects(
        () => ai.generateTuneSummary(ARGS),
        (e) => e.kind === 'timeout',
    );
    assert.equal(aborted, true, 'the request must actually be aborted');
    assert.ok(Date.now() - started < 2000, 'must not wait on the platform default');
});

await test('offline and missing-key are refused before any request is made', async () => {
    const ai = await loadAiSummary();
    let called = 0;
    stubEnv({ onLine: false, fetchImpl: async () => { called++; return jsonResponse(OK_MESSAGE); } });

    await assert.rejects(() => ai.generateTuneSummary(ARGS), (e) => e.kind === 'offline');

    stubEnv({ onLine: true, fetchImpl: async () => { called++; return jsonResponse(OK_MESSAGE); } });
    await assert.rejects(
        () => ai.generateTuneSummary({ ...ARGS, apiKey: '' }),
        (e) => e.kind === 'no-key',
    );

    assert.equal(called, 0, 'neither case may spend a request');
});

await test('every kind has a plain-sentence description', async () => {
    const ai = await loadAiSummary();
    const kinds = ['no-key', 'offline', 'timeout', 'network', 'auth', 'rate-limit',
        'bad-request', 'server', 'refusal', 'empty', 'incomplete'];
    for (const kind of kinds) {
        const message = ai.describeAiSummaryError({ kind });
        assert.ok(message.length > 10, `${kind} needs a real message`);
        assert.ok(!/HTTP|undefined|\[object/.test(message), `${kind} message leaks internals`);
    }
    // An unrecognised failure still gets a sentence rather than "undefined".
    assert.ok(ai.describeAiSummaryError(new Error('boom')).length > 10);
});

console.log('\naiSummary — web_fetch degradation ladder');

await test('a web_fetch 400 is retried with the beta header', async () => {
    const ai = await loadAiSummary();
    const { impl, calls } = recordingFetch([
        jsonResponse({ error: { message: 'tools.0: web_fetch_20250910 requires a beta header' } }, { ok: false, status: 400 }),
        jsonResponse(OK_MESSAGE),
    ]);
    stubEnv({ fetchImpl: impl });

    const result = await ai.generateTuneSummary(ARGS);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers['anthropic-beta'], undefined);
    assert.ok(calls[1].headers['anthropic-beta'], 'the retry must carry the beta opt-in');
    assert.equal(result.degraded, false, 'the tool was still used');
});

await test('a model that cannot fetch at all still produces a note', async () => {
    const ai = await loadAiSummary();
    const { impl, calls } = recordingFetch((n) => {
        if (n <= 2) {
            return jsonResponse({ error: { message: 'web_fetch is not supported for this model' } }, { ok: false, status: 400 });
        }
        return jsonResponse({
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'From knowledge only.' }],
            usage: { input_tokens: 200, output_tokens: 50 },
        });
    });
    stubEnv({ fetchImpl: impl });

    const result = await ai.generateTuneSummary(ARGS);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].body.tools, undefined, 'the third attempt drops the tool');
    // Dropping the tool without rebuilding the prompt would leave "Fetch this
    // page first" in a request with no fetch tool — the exact setup that makes
    // the model report a problem instead of writing a note.
    assert.ok(!/^Fetch /m.test(calls[2].body.messages[0].content),
        'rung 3 must rebuild the prompt, not just strip the tool');
    assert.equal(result.degraded, true);
    assert.equal(result.pageRead, 'none');
    assert.equal(result.text, 'From knowledge only.');
});

await test('a non-web_fetch 400 is not retried', async () => {
    const ai = await loadAiSummary();
    const { impl, calls } = recordingFetch(jsonResponse(
        { error: { message: 'max_tokens: must be greater than 0' } },
        { ok: false, status: 400 },
    ));
    stubEnv({ fetchImpl: impl });

    await assert.rejects(() => ai.generateTuneSummary(ARGS), (e) => e.kind === 'bad-request');
    assert.equal(calls.length, 1, 'an unrelated 400 must not be retried three times');
});

console.log('\naiSummary — thesession facts');

await test('facts are read from the JSON endpoint', async () => {
    const ai = await loadAiSummary();
    const { impl, calls } = recordingFetch(jsonResponse({
        name: 'The Kesh',
        aliases: ['Kincora', 'The Kesh Jig'],
        type: 'jig',
        settings: [{ key: 'Gmajor', meter: '6/8' }, { key: 'Amajor' }],
    }));
    stubEnv({ fetchImpl: impl });

    const facts = await ai.fetchSessionTuneFacts('14109');
    assert.ok(calls[0].url.includes('format=json'));
    assert.equal(facts.name, 'The Kesh');
    assert.deepEqual(facts.aliases, ['Kincora', 'The Kesh Jig']);
    assert.equal(facts.type, 'jig');
    // Meter, key/mode and the setting count are deliberately NOT collected: the
    // app displays them next to the note, and feeding them to the model is what
    // produced notes that just restated them.
    assert.equal(facts.meter, undefined);
    assert.equal(facts.mode, undefined);
    assert.equal(facts.settingCount, undefined);
});

await test('page stats expose whether the fetch reached the discussion', async () => {
    const ai = await loadAiSummary();
    const long = 'x'.repeat(400);

    // Truncated before the comments — the failure mode behind shallow notes.
    const notation = ai.pageFetchStats([{
        type: 'web_fetch_tool_result',
        content: {
            type: 'web_fetch_result',
            content: { type: 'document', source: { type: 'text', data: `X:1\nK:Gmaj\n${long}` } },
        },
    }]);
    assert.ok(notation.chars > 400);
    assert.equal(notation.looksLikeComments, false);

    // Reached them.
    const withComments = ai.pageFetchStats([{
        type: 'web_fetch_tool_result',
        content: {
            type: 'web_fetch_result',
            content: { type: 'document', source: { type: 'text', data: `${long}\n# Comments\nPosted by someone` } },
        },
    }]);
    assert.equal(withComments.looksLikeComments, true);

    assert.equal(ai.pageFetchStats([{ type: 'text', text: 'no tool ran' }]), null);
    assert.equal(ai.pageFetchStats(null), null);
});

await test('facts are optional — every failure degrades to null', async () => {
    const ai = await loadAiSummary();

    // Folkwiki tunes have no thesession page, so no request should be made.
    let called = 0;
    stubEnv({ fetchImpl: async () => { called++; return jsonResponse({}); } });
    assert.equal(await ai.fetchSessionTuneFacts('1402836401'), null);
    assert.equal(called, 0);

    // HTTP error, malformed body, and a thrown fetch all yield null rather than
    // aborting the summary — the note is still worth generating without them.
    stubEnv({ fetchImpl: async () => jsonResponse({}, { ok: false, status: 404 }) });
    assert.equal(await ai.fetchSessionTuneFacts('14109'), null);

    stubEnv({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => null }) });
    assert.equal(await ai.fetchSessionTuneFacts('14109'), null);

    stubEnv({ fetchImpl: async () => { throw new TypeError('network down'); } });
    assert.equal(await ai.fetchSessionTuneFacts('14109'), null);

    stubEnv({ onLine: false, fetchImpl: async () => jsonResponse({}) });
    assert.equal(await ai.fetchSessionTuneFacts('14109'), null);
});

console.log('\naiSummary — the discussion thread');

// DOMParser does not exist in Node. Rather than pull in a DOM library, the HTML
// path is tested two ways: extractCommentsFromDocument directly against a fake
// document (below), and fetchSessionComments with a stubbed global DOMParser.
function fakeDocument({ comments = [], body = '' }) {
    return {
        querySelectorAll: (selector) => {
            if (selector !== '[id^="comment"]') return [];
            return comments.map(text => ({ textContent: text }));
        },
        body: { textContent: body },
    };
}

function stubDomParser(docFor) {
    globalThis.DOMParser = class {
        parseFromString(html) { return docFor(html); }
    };
}

await test('comments are read from the JSON endpoint when it carries them', async () => {
    const ai = await loadAiSummary();
    const { impl, calls } = recordingFetch(jsonResponse({
        name: "Maggie's Pancakes",
        comments: [
            { content: 'Composed by Stuart Morison of the Tannahill Weavers.', member: { name: 'Dr. Dow' }, date: '2002' },
            { content: 'Written on the same day as Live Aid!', member: { name: 'smorison' } },
        ],
    }));
    stubEnv({ fetchImpl: impl });

    const result = await ai.fetchSessionComments('1316');
    assert.equal(result.source, 'json');
    assert.equal(result.count, 2);
    assert.ok(result.text.includes('Stuart Morison'));
    assert.ok(result.text.includes('Dr. Dow'), 'attribution matters — who said it is evidence');
    // No HTML request when the JSON already answered: that path is the fallback.
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.includes('format=json'));
});

await test('the HTML page is parsed when the JSON has no comments', async () => {
    const ai = await loadAiSummary();
    stubDomParser(() => fakeDocument({
        comments: [
            'The original name for this tune was Maggie\'s Pancakes. Composed by Stuart Morison.',
            'For the record, the tune was written on the same day as Live Aid!',
            'short',
        ],
    }));
    const { impl, calls } = recordingFetch([
        jsonResponse({ name: "Maggie's Pancakes" }),
        htmlResponse('<html><body>…</body></html>'),
    ]);
    stubEnv({ fetchImpl: impl });

    const result = await ai.fetchSessionComments('1316');
    assert.equal(result.source, 'html');
    assert.equal(result.count, 2, 'trivially short nodes are not comments');
    assert.ok(result.text.includes('Live Aid'));
    assert.equal(calls.length, 2);
    assert.ok(!calls[1].url.includes('format=json'), 'the second call is the HTML page');
});

await test('HTML with no comment ids falls back to the heading slice', async () => {
    const ai = await loadAiSummary();
    const body = 'X:1 K:Bm notation notation\nThirty-six comments\nOrigins: a Scottish tune by Stuart Morison.';
    stubDomParser(() => fakeDocument({ comments: [], body }));
    const { impl } = recordingFetch([
        jsonResponse({}),
        htmlResponse('<html><body>…</body></html>'),
    ]);
    stubEnv({ fetchImpl: impl });

    const result = await ai.fetchSessionComments('1316');
    assert.ok(result.text.includes('Stuart Morison'));
    // The notation above the heading is dropped — it is what crowded the comments
    // out of the budget when the model was doing the fetching.
    assert.ok(!result.text.includes('X:1'));
});

await test('extractCommentsFromDocument is directly testable', async () => {
    const ai = await loadAiSummary();
    assert.deepEqual(
        ai.extractCommentsFromDocument(fakeDocument({ comments: ['a comment long enough to count as one'] })),
        ['a comment long enough to count as one'],
    );
    assert.deepEqual(ai.extractCommentsFromDocument(null), []);
    assert.deepEqual(ai.extractCommentsFromDocument({}), []);
});

await test('an unreachable page degrades to null rather than throwing', async () => {
    const ai = await loadAiSummary();
    stubDomParser(() => fakeDocument({ comments: [] }));

    // CORS rejection presents to fetch() as a TypeError, which is the outcome
    // this whole path is a bet against — it must not break generation.
    stubEnv({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    assert.equal(await ai.fetchSessionComments('1316'), null);

    stubEnv({ fetchImpl: async (url) => (String(url).includes('format=json')
        ? jsonResponse({})
        : htmlResponse('', { ok: false, status: 403 })) });
    assert.equal(await ai.fetchSessionComments('1316'), null);

    // Folkwiki tunes have no thesession page at all.
    let called = 0;
    stubEnv({ fetchImpl: async () => { called++; return jsonResponse({}); } });
    assert.equal(await ai.fetchSessionComments('1402836401'), null);
    assert.equal(called, 0);
});

await test('a very long thread is capped', async () => {
    const ai = await loadAiSummary();
    const comments = Array.from({ length: 200 }, (_, i) => `Comment number ${i}: ${'y'.repeat(500)}`);
    stubEnv({ fetchImpl: async () => jsonResponse({ comments }) });

    const result = await ai.fetchSessionComments('1316');
    assert.ok(result.text.length <= 24000, `expected a cap, got ${result.text.length} chars`);
    assert.ok(result.count < 200, 'the tail is dropped, not the head');
    // Oldest-first is the page order and the origin discussion is near the top,
    // so the first comment must survive.
    assert.ok(result.text.startsWith('Comment number 0'));
});

console.log('\naiSummary — grounding');

await test('supplied comments go in the prompt and no tool is offered', async () => {
    const ai = await loadAiSummary();
    const { impl, calls } = recordingFetch(jsonResponse({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'A Scottish reel by Stuart Morison, written on Live Aid day 1985.' }],
        usage: { input_tokens: 3000, output_tokens: 200 },
    }));
    stubEnv({ fetchImpl: impl });

    const result = await ai.generateTuneSummary({
        ...ARGS,
        comments: { text: MAGGIES_COMMENTS, count: 3, source: 'html' },
    });

    // The tool must be gone: offering it invites a re-fetch, and the model's own
    // fetch is what lost the discussion in the first place.
    assert.equal(calls[0].body.tools, undefined);
    const prompt = calls[0].body.messages[0].content;
    assert.ok(prompt.includes('Stuart Morison'), 'the thread must reach the model');
    assert.ok(prompt.includes('Live Aid'));
    assert.ok(/discussion thread begins/.test(prompt), 'the thread must be delimited');
    assert.ok(/over what you think you remember/i.test(prompt));
    assert.ok(!/^Fetch /m.test(prompt), 'nothing left to fetch');

    assert.equal(result.grounding, 'comments');
    assert.equal(result.commentCount, 3);
});

await test('a successful web_fetch with no usable text is NOT reported as grounded', async () => {
    const ai = await loadAiSummary();
    // The exact failure that prompted this rewrite: pageRead came back 'ok', so
    // the dialog showed no caveat, while the model plainly had nothing — it wrote
    // that no documentary record existed for a tune whose composer is named in
    // the page's first line.
    const { impl } = recordingFetch(jsonResponse({
        stop_reason: 'end_turn',
        content: [
            { type: 'web_fetch_tool_result', content: { type: 'web_fetch_result', content: { type: 'document', source: { data: 'x'.repeat(300) } } } },
            { type: 'text', text: 'I have no reliable documentary record for a tune titled "Maggie\'s Pancakes".' },
        ],
        usage: { input_tokens: 10, output_tokens: 10 },
    }));
    stubEnv({ fetchImpl: impl });

    const result = await ai.generateTuneSummary(ARGS);
    assert.equal(result.pageRead, 'ok', 'the API did report success');
    assert.equal(result.grounding, 'knowledge',
        'but a token amount of page text must not be presented to the reader as sourced');
});

await test('a genuinely full page read is reported as grounded', async () => {
    const ai = await loadAiSummary();
    const page = `${'Origins: composed by Stuart Morison. '.repeat(80)}\n# Comments\nPosted by Dr. Dow`;
    const { impl } = recordingFetch(jsonResponse({
        stop_reason: 'end_turn',
        content: [
            { type: 'web_fetch_tool_result', content: { type: 'web_fetch_result', content: { type: 'document', source: { data: page } } } },
            { type: 'text', text: 'A Scottish reel by Stuart Morison.' },
        ],
        usage: { input_tokens: 10, output_tokens: 10 },
    }));
    stubEnv({ fetchImpl: impl });

    const result = await ai.generateTuneSummary(ARGS);
    assert.equal(result.grounding, 'page');
});

console.log('\naiSummary — cost estimate');

await test('cost is priced per model and counts cached input tokens', async () => {
    const ai = await loadAiSummary();
    const usage = { input_tokens: 1e6, output_tokens: 1e6 };

    assert.equal(ai.estimateCostUsd(usage, 'claude-haiku-4-5'), 1 + 5);
    assert.equal(ai.estimateCostUsd(usage, 'claude-sonnet-5'), 3 + 15);
    // Unknown model must not silently price at zero.
    assert.ok(ai.estimateCostUsd(usage, 'nonexistent') > 0);
    // Cache fields are input tokens too, and missing fields are not NaN.
    assert.equal(ai.estimateCostUsd({ cache_read_input_tokens: 1e6 }, 'claude-haiku-4-5'), 1);
    assert.equal(ai.estimateCostUsd({}, 'claude-haiku-4-5'), 0);
    assert.equal(ai.estimateCostUsd(undefined, 'claude-haiku-4-5'), 0);
});

await test('the per-note estimate tracks the comment cap', async () => {
    const ai = await loadAiSummary();
    // Derived, not hard-coded, so changing the cap cannot leave a stale (and
    // misleadingly cheap) number in the Settings hint. Bounded by the comment cap
    // rather than a whole page of notation, which is why it is cents not tens of
    // cents.
    const haiku = ai.estimateCostPerNoteUsd('claude-haiku-4-5');
    const sonnet = ai.estimateCostPerNoteUsd('claude-sonnet-5');
    assert.ok(haiku > 0.001 && haiku < 0.02, `haiku estimate ${haiku} looks wrong`);
    assert.ok(sonnet > haiku * 2.5, 'sonnet must be priced well above haiku');
    assert.ok(ai.estimateCostPerNoteUsd('unknown-model') > 0);
});

await rm(tmpDir, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
