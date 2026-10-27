// Runs every unit test file and reports all of them, not just the first failure.
//
// `npm test` used to be a hand-maintained `node a && node b && ...` chain. Two
// problems with that: the first failing file hid every file after it, and a new
// test file did nothing until someone remembered to add it to the list. This
// discovers `test/*.test.mjs` instead, runs each in its own process (they all
// use top-level await and exit with their own status, so the exit code is the
// verdict), and fails if any file failed, hung or crashed.
//
// Usage:
//   node test/run.mjs                    every file, in parallel
//   node test/run.mjs sessionAudio mic   only files whose name contains one of these
//   node test/run.mjs --serial           one at a time (also -j 1)
//   node test/run.mjs -j 4               at most four at once
//   node test/run.mjs --verbose          print passing files' output too
//
// Files run in parallel by default. That is safe only because each one writes
// its scratch copies to a directory of its own; a shared one is a race (see
// helpers/loadSessionAnalysis.mjs, which had to become per-process for this).

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..');

// Files that match the pattern but cannot run here, with the reason.
const EXCLUDED = {
    // Needs the Firestore emulator, and therefore Java. Run via `npm run test:rules`.
    'firestoreRules.test.mjs': 'needs the Firestore emulator (npm run test:rules)',
};

// A file that never exits is a failure, not something to wait on for ever.
// The slowest file takes a few seconds; this is generous on a loaded CI box.
const FILE_TIMEOUT_MS = 180_000;

function parseArgs(argv) {
    const opts = { jobs: availableParallelism(), verbose: false, filters: [] };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--serial') opts.jobs = 1;
        else if (arg === '--verbose' || arg === '-v') opts.verbose = true;
        else if (arg === '-j' || arg === '--jobs') {
            const n = Number(argv[++i]);
            if (!Number.isInteger(n) || n < 1) throw new Error(`${arg} needs a positive integer`);
            opts.jobs = n;
        } else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
        else opts.filters.push(arg);
    }
    return opts;
}

function discover(filters) {
    const all = readdirSync(here).filter((name) => name.endsWith('.test.mjs')).sort();
    const matches = (name) => !filters.length
        || filters.some((f) => name.toLowerCase().includes(f.toLowerCase()));
    return {
        files: all.filter((name) => !EXCLUDED[name] && matches(name)),
        skipped: all.filter((name) => EXCLUDED[name] && matches(name)),
    };
}

function runFile(name) {
    return new Promise((resolve) => {
        const started = Date.now();
        // stdout and stderr into one buffer, in arrival order, so a failure
        // reads the way it would have on a terminal.
        const chunks = [];
        const child = spawn(process.execPath, [path.join('test', name)], {
            cwd: appDir,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', (d) => chunks.push(d));
        child.stderr.on('data', (d) => chunks.push(d));

        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, FILE_TIMEOUT_MS);

        child.on('close', (code, signal) => {
            clearTimeout(timer);
            resolve({
                name,
                ok: code === 0 && !timedOut,
                code,
                signal,
                timedOut,
                ms: Date.now() - started,
                output: Buffer.concat(chunks).toString('utf8'),
            });
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            resolve({ name, ok: false, code: null, signal: null, timedOut: false,
                ms: Date.now() - started, output: String(err && err.stack || err) });
        });
    });
}

function seconds(ms) {
    return `${(ms / 1000).toFixed(1)}s`;
}

function describeFailure(r) {
    if (r.timedOut) return `timed out after ${seconds(FILE_TIMEOUT_MS)}`;
    if (r.signal) return `killed by ${r.signal}`;
    return `exit code ${r.code}`;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const { files, skipped } = discover(opts.filters);
    if (!files.length) {
        console.error(opts.filters.length
            ? `No test files match: ${opts.filters.join(', ')}`
            : 'No test files found.');
        process.exit(1);
    }

    const started = Date.now();
    const results = [];
    let next = 0;

    // A fixed pool of workers pulling from one queue. Each file's output is
    // printed in one piece when it finishes, so parallel runs never interleave.
    async function worker() {
        while (next < files.length) {
            const r = await runFile(files[next++]);
            results.push(r);
            if (r.ok) {
                console.log(`✓ ${r.name} (${seconds(r.ms)})`);
                if (opts.verbose) process.stdout.write(indent(r.output));
            } else {
                console.log(`✗ ${r.name} — ${describeFailure(r)} (${seconds(r.ms)})`);
                process.stdout.write(indent(r.output));
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(opts.jobs, files.length) }, worker));

    const failed = results.filter((r) => !r.ok).sort((a, b) => a.name.localeCompare(b.name));
    if (skipped.length) console.log('');
    for (const name of skipped) console.log(`- skipped ${name}: ${EXCLUDED[name]}`);
    if (failed.length) {
        console.log(`\n${failed.length} of ${results.length} test files FAILED (${seconds(Date.now() - started)}):`);
        for (const r of failed) console.log(`  ✗ ${r.name} — ${describeFailure(r)}`);
        process.exit(1);
    }
    const count = results.length === 1 ? '1 test file' : `All ${results.length} test files`;
    console.log(`\n${count} passed (${seconds(Date.now() - started)}).`);
}

function indent(text) {
    if (!text) return '';
    // Trim first: with the m flag, ^ also matches after a trailing newline.
    return `${text.replace(/\n+$/, '').replace(/^/gm, '    ')}\n`;
}

main().catch((err) => {
    console.error(err && err.message || err);
    process.exit(1);
});
