// Colour themes (src/js/theme.mjs).
//
// Run with:  node app/test/theme.test.mjs

import assert from 'node:assert/strict';
import {
    THEMES, DEFAULT_THEME, THEME_LABELS, THEME_DESCRIPTIONS,
    normaliseTheme, isDarkTheme, vuetifyPalette, themeCssVars, themeMetaColor,
} from '../src/js/theme.mjs';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('  ✓ ' + name); }

// WCAG relative luminance / contrast, for opaque #rrggbb or rgba() over a ground.
function parse(c, over) {
    let m = /^#([0-9a-f]{6})$/i.exec(c);
    if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16));
    m = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/.exec(c);
    assert.ok(m, 'unparsed colour ' + c);
    const a = m[4] === undefined ? 1 : Number(m[4]);
    const base = over ? parse(over) : [255, 255, 255];
    return [1, 2, 3].map((i, k) => Math.round(Number(m[i]) * a + base[k] * (1 - a)));
}
function lum(rgb) {
    const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(fg, bg) {
    const [a, b] = [lum(parse(fg, bg)), lum(parse(bg))].sort((x, y) => y - x);
    return (a + 0.05) / (b + 0.05);
}

test('four themes, light is the default, unknown names fall back', () => {
    assert.deepEqual([...THEMES], ['light', 'warm', 'dim', 'dark']);
    assert.equal(DEFAULT_THEME, 'light');
    assert.equal(normaliseTheme('neon'), 'light');
    assert.equal(normaliseTheme(undefined), 'light');
    assert.equal(isDarkTheme('light'), false);
    assert.equal(isDarkTheme('warm'), false, 'warm is a light theme: dark text and score');
    assert.equal(isDarkTheme('dim'), true);
    assert.equal(isDarkTheme('dark'), true);
    for (const t of THEMES) { assert.ok(THEME_LABELS[t]); assert.ok(THEME_DESCRIPTIONS[t]); }
});

test('every theme defines the same CSS variables', () => {
    const keys = Object.keys(themeCssVars('light')).sort();
    for (const t of THEMES) assert.deepEqual(Object.keys(themeCssVars(t)).sort(), keys, t);
    assert.ok(keys.includes('--ff-bg') && keys.includes('--ff-text') && keys.includes('--ff-text-muted'));
});

test('dark is black, dim is not', () => {
    assert.equal(themeCssVars('dark')['--ff-bg'], '#000000');
    assert.notEqual(themeCssVars('dim')['--ff-bg'], '#000000');
    assert.equal(themeMetaColor('light'), '#ffffff');
});

test('text stays readable (WCAG AA) on every ground in every theme', () => {
    for (const t of THEMES) {
        const v = themeCssVars(t);
        for (const ground of ['--ff-bg', '--ff-surface', '--ff-surface2', '--ff-surface3']) {
            assert.ok(contrast(v['--ff-text'], v[ground]) >= 7, `${t} text on ${ground}: ${contrast(v['--ff-text'], v[ground]).toFixed(1)}`);
            assert.ok(contrast(v['--ff-text-muted'], v[ground]) >= 4.5, `${t} muted on ${ground}: ${contrast(v['--ff-text-muted'], v[ground]).toFixed(1)}`);
        }
    }
});

test('dim is softer than dark: lower text contrast, still AAA', () => {
    const dim = themeCssVars('dim'), dark = themeCssVars('dark');
    const cDim = contrast(dim['--ff-text'], dim['--ff-surface']);
    const cDark = contrast(dark['--ff-text'], dark['--ff-surface']);
    assert.ok(cDim < cDark, `dim ${cDim.toFixed(1)} vs dark ${cDark.toFixed(1)}`);
});

test('the primary colour is readable on each theme\'s surface', () => {
    for (const t of THEMES) {
        const c = contrast(vuetifyPalette(t).primary, themeCssVars(t)['--ff-surface']);
        assert.ok(c >= 4.5, `${t} primary: ${c.toFixed(1)}`);
    }
});

test('warm is a cream ground, not white, with dark text', () => {
    const v = themeCssVars('warm');
    assert.notEqual(v['--ff-bg'], '#ffffff');
    assert.notEqual(v['--ff-surface'], '#ffffff');
    assert.ok(lum(parse(v['--ff-text'])) < 0.05, 'text (and so the score) is near-black');
    assert.ok(lum(parse(v['--ff-bg'])) > 0.75, 'still a light ground');
    const [r, , b] = parse(v['--ff-bg']);
    assert.ok(r > b, 'warm: more red than blue');
});

test('every theme sets the same palette keys, so switching back restores them', () => {
    const keys = Object.keys(vuetifyPalette('light')).sort();
    for (const t of THEMES) assert.deepEqual(Object.keys(vuetifyPalette(t)).sort(), keys, t);
});

console.log(`\n${passed} passed`);
