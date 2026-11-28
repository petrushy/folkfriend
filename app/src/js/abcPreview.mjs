// The opening bars of a setting as ABC text, for the small one-line score
// previews in lists (favourites, a session plan). Pure: rendering it is the
// caller's (ABCJS.renderAbc), so this can be tested without a DOM.

// Bars to show for a preview of a given width in px at scale 0.65 (~110 px
// a bar).
export function previewBars(widthPx) {
    return widthPx < 300 ? 2 : widthPx < 390 ? 3 : 4;
}

export function previewAbc(setting, maxBars) {
    if (!setting || !setting.abc) return '';
    const lines = [];
    if (setting.mode) lines.push(`K:${setting.mode}`);
    if (setting.meter) lines.push(`M:${setting.meter}`);
    if (!/^L:/m.test(setting.abc)) lines.push('L:1/8');
    // Strip chord annotations and tempo — chords add vertical whitespace above the staff.
    let body = setting.abc;
    body = body.replace(/^Q:[^\n]*/gm, '');
    body = body.replace(/"[^"]*"/g, '');
    // Strip multi-voice ABC — keep only V:1 content so only one staff renders.
    if (/^V:/m.test(body)) {
        const filtered = [];
        let inV1 = true; // before any V: marker, include content
        for (const line of body.split('\n')) {
            if (/^V:1/.test(line)) { inV1 = true; continue; }
            if (/^V:/.test(line)) { inV1 = false; continue; }
            if (inV1) filtered.push(line);
        }
        body = filtered.join('\n');
    }
    // ONE line: in ABC a line break starts a new staff, so the stored tune's
    // own line breaks inside the first bars drew a two-staff preview. A field
    // line between music lines becomes the inline form ([K:G]) where ABC has
    // one, and is dropped otherwise (lyrics, parts, notes); a trailing
    // backslash (line continuation) goes with its break.
    body = body.split('\n').map(line => line.replace(/\\\s*$/, '').trim()).filter(Boolean).map(line => {
        if (!/^[A-Za-z]:/.test(line)) return line;
        return /^[KLMQ]:/.test(line) ? `[${line}]` : '';
    }).filter(Boolean).join(' ');
    // +1 to account for the leading |: repeat marker which counts as a pipe but isn't a bar.
    const targetPipes = maxBars + 1;
    let count = 0;
    let cutAt = body.length;
    for (let i = 0; i < body.length; i++) {
        if (body[i] === '|' && ++count >= targetPipes) { cutAt = i + 1; break; }
    }
    lines.push(body.slice(0, cutAt));
    return lines.join('\n');
}

// A time signature as a person reads it: C and C| are the ABC symbols for
// common and cut time.
export function meterLabel(meter) {
    const m = String(meter || '').trim();
    if (m === 'C') return '4/4';
    if (m === 'C|') return '2/2';
    return m;
}

// The options every list preview renders with.
export function previewRenderOptions(widthPx) {
    return {
        // Render at actual display width so no CSS scaling is needed.
        staffwidth: widthPx,
        scale: 0.65,
        paddingtop: 0,
        paddingbottom: 0,
        paddingleft: 0,
        paddingright: 0,
        // Force everything onto one line regardless of time signature width
        wrap: { minSpacing: 1, maxSpacing: 3, preferredMeasuresPerLine: 8 },
    };
}
