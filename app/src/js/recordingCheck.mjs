// What a recording check found, as a verdict and as plain text.
//
// Pure, so it can be tested without a browser: the report comes from
// `inspectRecording()` in sessionAudioStore.js. The text form exists to be
// copied off the phone and pasted somewhere it can be read — on an installed
// iPhone app there is no console, and a screenshot of one error at a time is
// how the last several playback problems had to be diagnosed.

// A segment that could be played from this device as it stands.
export function segmentReadable(segment) {
    return segment.stored !== 'missing' && segment.stored !== 'unreadable record' &&
        !segment.error && segment.size > 0 && segment.readableBytes >= segment.size &&
        (!segment.expectedBytes || segment.size === segment.expectedBytes);
}

export function summariseCheck(report) {
    const segments = report.segments || [];
    const bad = segments.filter(s => !segmentReadable(s));
    const recoverable = bad.filter(s => s.inCloud === true);
    const lost = bad.filter(s => s.inCloud !== true);
    const tracksBad = (report.tracks || []).filter(t =>
        t.init.stored !== 'none' && (t.init.error || t.init.readableBytes < t.init.size));
    const legacy = segments.filter(s => s.stored === 'blob').length;

    let level;
    let verdict;
    if (!report.manifest || report.manifest.state !== 'ok') {
        level = 'error';
        verdict = {
            absent: 'This device holds no recording for this session.',
            unreadable: 'The recording\'s index could not be read on this device.',
            unsupported: 'This recording was saved by a newer version of the app.',
        }[report.manifest && report.manifest.state] || 'The recording could not be checked.';
    } else if (!segments.length) {
        level = 'info';
        verdict = 'The recording has no saved audio yet.';
    } else if (!bad.length && !tracksBad.length) {
        level = 'success';
        verdict = `All ${segments.length} pieces of this recording read correctly on this device.`;
    } else if (!lost.length) {
        level = 'warning';
        verdict = `${bad.length} of ${segments.length} pieces cannot be read on this device. ` +
            'All of them are in the Dropbox backup, so playback fetches them from there ' +
            'and repairs the copy on this device.';
    } else {
        level = 'error';
        verdict = `${bad.length} of ${segments.length} pieces cannot be read on this device, ` +
            `and ${lost.length} of those ${lost.length === 1 ? 'is' : 'are'} not in a backup` +
            (report.cloud && report.cloud.state !== 'ok' ? ` (Dropbox: ${report.cloud.state})` : '') + '.';
    }
    if (tracksBad.length && level !== 'error') {
        verdict += ` The header of ${tracksBad.length === 1 ? 'one part' : `${tracksBad.length} parts`} cannot be read either.`;
        if (level === 'success') level = 'warning';
    }
    return {
        level, verdict,
        total: segments.length,
        bad: bad.length, recoverable: recoverable.length, lost: lost.length,
        tracksBad: tracksBad.length, legacy,
    };
}

function clock(seconds) {
    const s = Math.max(0, Math.round(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const pad = n => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

const kb = n => `${Math.round((n || 0) / 1024)} kB`;

export function segmentLine(s) {
    const parts = [`#${s.index}`, `part ${s.trackIndex + 1}`, clock(s.startSeconds), s.stored];
    if (s.stored !== 'missing' && s.stored !== 'unreadable record') {
        parts.push(kb(s.size));
        if (s.expectedBytes && s.size !== s.expectedBytes) parts.push(`expected ${kb(s.expectedBytes)}`);
    }
    if (segmentReadable(s)) {
        parts.push('ok');
    } else if (s.error) {
        parts.push(`FAILS at ${kb(s.readableBytes)} (${s.error})`);
    } else {
        parts.push('NOT READABLE');
    }
    if (s.shape) parts.push(s.shape);
    if (s.chunksMatch === false) parts.push('chunk sizes disagree');
    if (s.inCloud === true) parts.push('in backup');
    if (s.inCloud === false) parts.push('NOT in backup');
    return parts.join(' · ');
}

export function formatCheckReport(report, env = {}) {
    const summary = summariseCheck(report);
    const lines = [
        'FolkFriend recording check',
        `Session ${report.sessionId}`,
        `Checked ${new Date(report.checkedAt).toISOString()}`,
    ];
    if (env.appVersion) lines.push(`App ${env.appVersion}`);
    if (env.userAgent) lines.push(`Device ${env.userAgent}`);
    if (env.canPlay) lines.push(`Can play: ${env.canPlay}`);
    lines.push('', summary.verdict, '');

    const m = report.manifest || {};
    if (m.state === 'ok') {
        lines.push(`Recording: ${m.mimeType || 'unknown format'}, ` +
            `${m.bitsPerSecond ? Math.round(m.bitsPerSecond / 1000) + ' kbps, ' : ''}` +
            `${clock(m.totalSeconds)}, ${kb(m.bytes)}` +
            `${m.finalized ? ', finished' : ', not finished'}` +
            `${m.stopped ? `, stopped: ${m.stopped}` : ''}`);
    } else {
        lines.push(`Recording index: ${m.state || 'unknown'}`);
    }
    const cloud = report.cloud || {};
    lines.push(`Dropbox backup: ${cloud.configured ? cloud.state : 'not connected'}` +
        (cloud.state === 'ok' ? ` (${cloud.listed} pieces)` : ''));
    if (report.storage) {
        const st = report.storage;
        lines.push(`Storage: ${st.usage != null ? kb(st.usage) : '?'} used of ` +
            `${st.quota != null ? kb(st.quota) : '?'}` +
            `${st.persisted === true ? ', protected' : st.persisted === false ? ', not protected' : ''}`);
    }
    if (summary.legacy) {
        lines.push(`${summary.legacy} ${summary.legacy === 1 ? 'piece is' : 'pieces are'} ` +
            'stored in the older format (a browser file reference).');
    }

    if ((report.tracks || []).length) {
        lines.push('', 'Parts:');
        for (const t of report.tracks) {
            const init = t.init;
            const initState = init.stored === 'none' ? 'no header stored'
                : init.error ? `header FAILS at ${kb(init.readableBytes)} (${init.error})`
                    : `header ${init.stored} ${kb(init.size)} ok${init.shape ? ' ' + init.shape : ''}`;
            lines.push(`part ${t.index + 1} · from ${clock(t.startSeconds)} · ${clock(t.durationSeconds)} · ` +
                `${t.mimeType || '?'} · ${t.channels ? t.channels + ' ch' : 'channels unknown'} · ${initState}`);
        }
    }
    if ((report.segments || []).length) {
        lines.push('', 'Pieces:');
        for (const s of report.segments) lines.push(segmentLine(s));
    }
    return lines.join('\n');
}
