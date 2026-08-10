// AI-generated tune background notes — deliberately bounded, and deliberately
// never automatic.
//
// Two network hops, neither of which needs a server component of our own:
//
//   1. thesession.org `?format=json` for hard facts (name, aliases, type,
//      meter, mode). This origin already serves CORS-permissive JSON to this
//      app — Settings.vue's bookmarks import has been fetching it from the
//      browser in production for months.
//   2. api.anthropic.com /v1/messages with the user's own API key, which works
//      from a browser when the request carries
//      `anthropic-dangerous-direct-browser-access: true`. The key never leaves
//      the device except to Anthropic.
//
// Both are bounded the way tuneIndexNetwork.js is bounded, and for the same
// reason: on captive-portal Wi-Fi the device reports itself online, TCP
// connects, and nothing ever arrives. An unbounded fetch there hangs for the
// platform default and the dialog sits on a spinner. So every request has a
// hard deadline and every failure path resolves to a typed error the UI can
// turn into one plain sentence.
//
// Cost is the other constraint. Nothing in this module runs unless the user
// taps Generate: there is no prefetch, no generate-on-navigate, and the page
// the model may read is capped (max_content_tokens) and domain-locked
// (allowed_domains) so a single summary cannot turn into an open-ended crawl.

import { isDefinitelyOffline } from './tuneIndexNetwork.js';
import { isThesessionTuneID, tuneSourceUrl } from '../js/source.mjs';

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Some deployments of the web_fetch server tool require an explicit beta
// opt-in. We do not hard-code an assumption either way — see requestWithLadder.
const WEB_FETCH_BETA = 'web-fetch-2025-09-10';

// Enough headroom for a ~10-line note plus any thinking the model does on the
// way (max_tokens caps thinking and visible text together).
const MAX_TOKENS = 1500;

// Caps how much of the tune page the model may pull into context. A thesession
// discussion thread can be long; 6k tokens is plenty for a program note and
// bounds the input cost of a summary.
const WEB_FETCH_MAX_CONTENT_TOKENS = 6000;

// A server-tool turn can come back `pause_turn` when the tool loop hits its
// iteration cap. Resume, but never indefinitely.
const MAX_CONTINUATIONS = 2;

export const TIMEOUTS = {
    // A tune's JSON is a few kilobytes. If it hasn't answered in 8s the network
    // is not usable, whatever navigator.onLine claims. Failure here is
    // non-fatal — the summary still generates without it.
    SESSION_JSON_MS: 8000,
    // The model may fetch and read a web page before writing, so this is much
    // longer than a plain API call would need. Still finite.
    CLAUDE_MS: 60000,
};

// The models offered in Settings. `webFetch` matters: the _20260209 web_fetch
// variant (dynamic filtering) requires Opus 4.6+ / Sonnet 4.6+, so Haiku 4.5
// must use the basic _20250910 variant or the request 400s. Prices are list
// USD per million tokens, used only for the approximate spend readout.
export const MODELS = {
    'claude-haiku-4-5': {
        label: 'Haiku 4.5 — cheapest',
        inputPerMTok: 1,
        outputPerMTok: 5,
        webFetch: 'web_fetch_20250910',
    },
    'claude-sonnet-5': {
        label: 'Sonnet 5 — better prose',
        inputPerMTok: 3,
        outputPerMTok: 15,
        webFetch: 'web_fetch_20260209',
    },
};

export const DEFAULT_MODEL = 'claude-haiku-4-5';

export function modelSpec(model) {
    return MODELS[model] || MODELS[DEFAULT_MODEL];
}

// kind is what the UI switches on to produce one plain sentence:
//   'no-key' | 'offline' | 'timeout' | 'network' | 'auth' | 'rate-limit'
//   | 'bad-request' | 'server' | 'http' | 'refusal' | 'empty' | 'incomplete'
export class AiSummaryError extends Error {
    constructor(kind, message) {
        super(message);
        this.name = 'AiSummaryError';
        this.kind = kind;
    }
}

const ERROR_MESSAGES = {
    'no-key': 'Add your Anthropic API key in Settings to generate background notes.',
    offline: 'No connection. Background notes need the internet, but any note you have already generated stays available offline.',
    timeout: 'The request took too long and was cancelled. Try again when the connection is better.',
    network: 'Could not reach the Claude API. Check your connection and try again.',
    auth: 'That API key was rejected. Check it in Settings.',
    'rate-limit': 'Rate limited by the Claude API. Wait a moment and try again.',
    'bad-request': 'The Claude API rejected the request.',
    server: 'The Claude API had a problem. Try again shortly.',
    refusal: 'The model declined to write a note for this tune.',
    empty: 'The model returned nothing. Try again, or switch model in Settings.',
    incomplete: 'The model ran out of steps before finishing. Try again.',
};

// One plain sentence per failure, so the dialog never shows a stack trace or an
// HTTP status to somebody who just wanted to read about a tune.
export function describeAiSummaryError(error) {
    const kind = error && error.kind;
    return ERROR_MESSAGES[kind] || 'Could not generate a background note. Please try again.';
}

function hostOf(url) {
    try {
        return new URL(url).host;
    } catch (e) {
        return null;
    }
}

// Both spellings of a host, because a site that redirects thesession.org ->
// www.thesession.org (or the reverse) would otherwise have the redirect blocked
// by our own allowlist, surfacing as an unexplained fetch failure.
function hostVariants(host) {
    const bare = host.replace(/^www\./, '');
    return bare === host ? [host, `www.${host}`] : [host, bare];
}

// The web_fetch tool definition for a given model, locked to the host we are
// actually asking about. Returns null when the URL has no parseable host,
// in which case the summary is generated without page access rather than
// handing the model an unrestricted fetch tool.
export function webFetchToolFor(model, url) {
    const host = hostOf(url);
    if (!host) return null;
    return {
        type: modelSpec(model).webFetch,
        name: 'web_fetch',
        max_uses: 1,
        max_content_tokens: WEB_FETCH_MAX_CONTENT_TOKENS,
        allowed_domains: hostVariants(host),
    };
}

function kindForStatus(status) {
    if (status === 401 || status === 403) return 'auth';
    if (status === 429) return 'rate-limit';
    if (status === 400) return 'bad-request';
    if (status >= 500) return 'server';
    return 'http';
}

// fetch() with a hard deadline. Every failure becomes an AiSummaryError so no
// caller has to reason about AbortError vs TypeError vs HTTP status.
async function fetchWithDeadline(url, timeoutMs, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } catch (e) {
        if (e && e.name === 'AbortError') {
            throw new AiSummaryError('timeout', `Request timed out after ${timeoutMs} ms`);
        }
        throw new AiSummaryError('network', `Request failed: ${e && e.message}`);
    } finally {
        clearTimeout(timer);
    }
}

export function sessionTuneJsonUrl(tuneID) {
    return `https://thesession.org/tunes/${encodeURIComponent(String(tuneID))}?format=json`;
}

function firstSetting(data) {
    return Array.isArray(data.settings) && data.settings.length ? data.settings[0] : {};
}

// Hard facts for the prompt, so the model has authoritative names/type/meter/
// mode even if its page read is poor. Every failure degrades to null: this is a
// nice-to-have, and a tune with an unreachable JSON endpoint should still get a
// summary.
export async function fetchSessionTuneFacts(tuneID) {
    if (!isThesessionTuneID(tuneID)) return null;
    if (isDefinitelyOffline()) return null;

    try {
        const response = await fetchWithDeadline(sessionTuneJsonUrl(tuneID), TIMEOUTS.SESSION_JSON_MS);
        if (!response.ok) return null;
        const data = await response.json();
        if (!data || typeof data !== 'object') return null;

        const setting = firstSetting(data);
        return {
            name: typeof data.name === 'string' ? data.name : '',
            aliases: Array.isArray(data.aliases)
                ? data.aliases.filter(a => typeof a === 'string').slice(0, 12)
                : [],
            type: typeof data.type === 'string' ? data.type : '',
            meter: data.meter || setting.meter || '',
            mode: data.mode || setting.mode || setting.key || '',
            settingCount: Array.isArray(data.settings) ? data.settings.length : 0,
        };
    } catch (e) {
        console.warn('thesession facts unavailable', e && e.message);
        return null;
    }
}

function factsBlock(facts) {
    if (!facts) return '';
    const lines = [];
    if (facts.name) lines.push(`Title: ${facts.name}`);
    if (facts.aliases.length) lines.push(`Also known as: ${facts.aliases.join('; ')}`);
    if (facts.type) lines.push(`Tune type: ${facts.type}`);
    if (facts.meter) lines.push(`Meter: ${facts.meter}`);
    if (facts.mode) lines.push(`Key/mode: ${facts.mode}`);
    if (facts.settingCount) lines.push(`Settings on record: ${facts.settingCount}`);
    if (!lines.length) return '';
    return `\n\nKnown facts from the source database (authoritative — prefer these over the page for names, type, meter and key):\n${lines.join('\n')}`;
}

export function buildPrompt({ displayName = '', url = '', facts = null, canFetch = true }) {
    const title = (facts && facts.name) || displayName || 'this tune';

    const fetchClause = canFetch
        ? [
            `Fetch ${url} first and prefer what it says — including the discussion comments, which is usually where the history is — over recollection.`,
            // Without this, a fetch that fails at runtime reliably produces a
            // meta-response: the model reports the network error and declines to
            // write anything, because the instruction above told it the page was
            // the authority and the honesty rule below told it not to guess.
            'If the fetch fails, returns nothing, or is blocked, do not mention that and do not decline — silently fall back to what you already know about the tune and write the note anyway.',
        ].join('\n')
        : `You have no way to fetch the source page (${url}), so write from what you already know about this tune. Do not mention lacking access.`;

    return [
        `You are writing a short program note about the traditional tune "${title}".`,
        '',
        'Summarize the tune\'s origin (geography, earliest documented date, composer if known), any key historical detail or story, and one notable aspect (musician, collection, or distinctive feature, specific musical instruments used). Keep to ~10 lines of prose suitable as a program note.',
        '',
        fetchClause,
        'Where the documented record is thin or contested, say so plainly in a clause and write a shorter note — but always write the note. Never decline, and never fill a gap with plausible invention.',
        // The output is rendered verbatim into a panel with no reply channel, so
        // asking a question or suggesting a retry is a dead end for the reader.
        'Your reply is displayed verbatim in a small information panel. Nobody can answer you, so never ask for information, never suggest trying again, and never describe your own process, tools or difficulties.',
        'Plain prose only: no headings, no bullet points, no markdown, no preamble such as "Here is". Start with the note itself.',
        factsBlock(facts),
    ].join('\n');
}

function textBlocksIn(content) {
    return content
        .filter(block => block && block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text.trim())
        .filter(Boolean);
}

function extractText(content) {
    if (!Array.isArray(content)) return '';

    // With a server tool in play the model typically narrates before calling it
    // ("I'll fetch that page to research the tune's history") and writes the real
    // answer after the result comes back. Joining every text block prepends that
    // narration to the note, so only prose after the last tool result counts.
    let afterLastResult = 0;
    content.forEach((block, i) => {
        if (block && block.type === 'web_fetch_tool_result') afterLastResult = i + 1;
    });

    const tail = textBlocksIn(content.slice(afterLastResult));
    // If the turn ended with the tool result and no prose followed, there is no
    // note — fall back to whatever text there was rather than returning empty,
    // and let the caller decide (a failed page read triggers a retry).
    const blocks = tail.length ? tail : textBlocksIn(content);

    return blocks.join('\n\n').trim();
}

// Did the model actually get to read the page? web_fetch failures do not raise
// — they arrive as HTTP 200 with an error object inside the result block — so
// this is the only way to know, and it is worth surfacing: a note written
// without page access deserves a caveat in the UI.
export function pageFetchOutcome(content) {
    if (!Array.isArray(content)) return 'none';
    let sawBlock = false;
    for (const block of content) {
        if (!block || block.type !== 'web_fetch_tool_result') continue;
        sawBlock = true;
        const inner = block.content;
        if (inner && inner.type === 'web_fetch_result') return 'ok';
    }
    return sawBlock ? 'error' : 'none';
}

const USAGE_FIELDS = [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
];

function emptyUsage() {
    return USAGE_FIELDS.reduce((acc, field) => ({ ...acc, [field]: 0 }), {});
}

function addUsage(total, usage) {
    if (!usage || typeof usage !== 'object') return total;
    for (const field of USAGE_FIELDS) {
        total[field] += Number(usage[field]) || 0;
    }
    return total;
}

// Approximate list-price cost of one call. Approximate is the honest word: we
// do not know the caller's contracted rates, and the intro pricing on some
// models moves. It exists so the running total in Settings is a real number
// rather than a shrug.
export function estimateCostUsd(usage, model) {
    const spec = modelSpec(model);
    const input = (Number(usage && usage.input_tokens) || 0) +
        (Number(usage && usage.cache_creation_input_tokens) || 0) +
        (Number(usage && usage.cache_read_input_tokens) || 0);
    const output = Number(usage && usage.output_tokens) || 0;
    return (input / 1e6) * spec.inputPerMTok + (output / 1e6) * spec.outputPerMTok;
}

async function postMessages(body, apiKey, beta = null) {
    const headers = {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        // Without this the browser preflight is refused. It is named
        // "dangerous" because it puts the key in the page; that is the user's
        // deliberate choice here, and the key is stored only on this device.
        'anthropic-dangerous-direct-browser-access': 'true',
    };
    if (beta) headers['anthropic-beta'] = beta;

    const response = await fetchWithDeadline(MESSAGES_URL, TIMEOUTS.CLAUDE_MS, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        let detail = '';
        try {
            const parsed = await response.json();
            detail = parsed && parsed.error && parsed.error.message ? parsed.error.message : '';
        } catch (e) {
            // Error body was not JSON. The status alone is enough.
        }
        throw new AiSummaryError(
            kindForStatus(response.status),
            `Anthropic API HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
        );
    }

    return response.json();
}

function looksLikeWebFetchRejection(error) {
    if (!(error instanceof AiSummaryError) || error.kind !== 'bad-request') return false;
    const message = String(error.message || '').toLowerCase();
    return message.includes('web_fetch') || message.includes('web fetch') || message.includes('beta');
}

// Send the request, degrading rather than failing when the deployment disagrees
// with us about web_fetch:
//
//   1. as built, no beta header
//   2. same, with the web-fetch beta header (some deployments require the
//      explicit opt-in and reject the bare request with a 400)
//   3. with the tool removed entirely — the note is then written from the
//      model's own knowledge plus the facts block, which is a worse note but
//      still a note
//
// This is why the module does not need to hard-code which variant a given model
// serves: it finds out once, per call, cheaply, and a 400 never reaches the user
// as "HTTP 400".
//
// `makeBody(canFetch)` rather than a fixed body, because rung 3 must rebuild the
// prompt as well as drop the tool: a prompt that still says "fetch this page
// first" while no fetch tool is attached is exactly what makes the model report a
// network problem and decline instead of writing a note.
async function requestWithLadder(makeBody, apiKey) {
    const withTool = makeBody(true);
    const hasTool = Array.isArray(withTool.tools) && withTool.tools.length > 0;

    try {
        return { response: await postMessages(withTool, apiKey), body: withTool };
    } catch (e) {
        if (!hasTool || !looksLikeWebFetchRejection(e)) throw e;

        try {
            return {
                response: await postMessages(withTool, apiKey, WEB_FETCH_BETA),
                body: withTool,
                beta: WEB_FETCH_BETA,
            };
        } catch (e2) {
            if (!looksLikeWebFetchRejection(e2)) throw e2;
            console.warn('web_fetch unavailable for this model; generating without page access');
            const withoutTool = makeBody(false);
            return { response: await postMessages(withoutTool, apiKey), body: withoutTool, degraded: true };
        }
    }
}

// Generate one background note. Throws AiSummaryError on every failure path.
export async function generateTuneSummary({
    tuneID,
    displayName = '',
    sourceUrl = '',
    facts = null,
    model = DEFAULT_MODEL,
    apiKey = '',
}) {
    if (!apiKey) {
        throw new AiSummaryError('no-key', 'No Anthropic API key configured');
    }
    if (isDefinitelyOffline()) {
        throw new AiSummaryError('offline', 'Device is offline');
    }

    const url = sourceUrl || tuneSourceUrl({ tuneID, displayName });
    const tool = webFetchToolFor(model, url);

    const makeBody = (canFetch) => {
        const body = {
            model,
            max_tokens: MAX_TOKENS,
            messages: [{
                role: 'user',
                content: buildPrompt({ displayName, url, facts, canFetch: canFetch && Boolean(tool) }),
            }],
        };
        if (canFetch && tool) body.tools = [tool];
        return body;
    };

    let attempt = await runAttempt(makeBody, apiKey, true);
    const usage = { ...attempt.usage };

    // A page fetch that fails at *runtime* is not covered by the ladder above —
    // that only handles the API rejecting the tool outright. Here the tool was
    // accepted and then could not reach the page, which leaves the model having
    // been told the page is the authority while holding nothing from it. Its
    // answer is written under a false premise and in practice is often a report
    // of the network problem rather than a note, so it is worth one more call
    // with the fetch instruction removed altogether.
    if (attempt.pageRead === 'error' && !attempt.degraded) {
        console.warn('web_fetch could not reach the page; regenerating without it');
        try {
            const retry = await runAttempt(makeBody, apiKey, false);
            addUsage(usage, retry.usage);
            attempt = { ...retry, degraded: true };
        } catch (e) {
            // Keep whatever the first attempt produced rather than turning a
            // usable-if-caveated note into an error.
            console.warn('fallback generation failed; keeping the first attempt', e && e.message);
        }
    }

    return {
        text: attempt.text,
        model,
        generatedAt: Date.now(),
        sourceUrl: url,
        usage,
        pageRead: attempt.pageRead,
        degraded: Boolean(attempt.degraded),
    };
}

// One generation attempt: send, resume any paused server-tool turn, and pull the
// prose out. `canFetch` false means no tool and a prompt that does not mention
// fetching.
async function runAttempt(makeBody, apiKey, canFetch) {
    let first;
    if (canFetch) {
        first = await requestWithLadder(makeBody, apiKey);
    } else {
        const body = makeBody(false);
        first = { response: await postMessages(body, apiKey), body };
    }

    let response = first.response;
    let requestBody = first.body;
    const usage = addUsage(emptyUsage(), response.usage);
    let pageRead = pageFetchOutcome(response.content);

    // A paused server-tool turn is resumed by re-sending with the assistant
    // turn appended — no extra user message, the API resumes on its own.
    let continuations = 0;
    while (response.stop_reason === 'pause_turn' && continuations < MAX_CONTINUATIONS) {
        continuations += 1;
        requestBody = {
            ...requestBody,
            messages: [...requestBody.messages, { role: 'assistant', content: response.content }],
        };
        response = await postMessages(requestBody, apiKey, first.beta || null);
        addUsage(usage, response.usage);
        if (pageRead !== 'ok') pageRead = pageFetchOutcome(response.content);
    }

    // Check stop_reason before touching content: on a refusal content can be
    // empty, and indexing it would throw a TypeError instead of telling the
    // user what happened.
    if (response.stop_reason === 'refusal') {
        throw new AiSummaryError('refusal', 'The model declined to answer for this tune');
    }

    const text = extractText(response.content);

    if (!text) {
        if (response.stop_reason === 'pause_turn') {
            throw new AiSummaryError('incomplete', 'The model did not finish within the allowed steps');
        }
        throw new AiSummaryError('empty', 'The model returned no prose');
    }

    return {
        text,
        usage,
        pageRead,
        degraded: Boolean(first.degraded),
    };
}
