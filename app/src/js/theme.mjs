// Colour themes (userSettings.colorTheme). Pure, tested by test/theme.test.mjs.
//
//  - light: the original look, white ground.
//  - warm:  cream paper with dark warm-brown text and score. Still a light
//           theme (Vuetify light mode), just without the glare of pure white.
//  - dim:   for a dark pub or a stage: a warm charcoal ground with off-white
//           text, deliberately lower contrast than black-on-white so it does
//           not glare, but every text colour still passes WCAG AA.
//  - dark:  true black ground (also saves power on OLED phones) with
//           light grey text.
//
// Vuetify's own dark mode does most of the work for dim and dark; the
// variables below cover what Vuetify does not reach: hand-written CSS in the
// components, and the score, which abcjs draws in `currentColor` and so follows
// `--ff-text` wherever the page's text colour is set.

export const THEMES = Object.freeze(['light', 'warm', 'dim', 'dark']);
export const DEFAULT_THEME = 'light';

export const THEME_LABELS = Object.freeze({
    light: 'Light',
    warm: 'Warm',
    dim: 'Dim',
    dark: 'Dark',
});

export const THEME_DESCRIPTIONS = Object.freeze({
    light: 'White background (the original look).',
    warm: 'Cream paper with dark text — softer than white, and the score stays dark ink on paper.',
    dim: 'Soft charcoal with warm text — easy on the eyes in a dark room.',
    dark: 'Black background, for the darkest rooms. Saves battery on OLED screens.',
});

// Vuetify palette per theme. Dark grounds need lighter brand colours: the
// original #055581 blue is unreadable on black.
const VUETIFY = {
    light: { primary: '#055581', secondary: '#FF3B3F', accent: '#3585C1', error: '#B71C1C' },
    warm: { primary: '#055581', secondary: '#c8372d', accent: '#3585C1', error: '#B71C1C' },
    dim: { primary: '#8fbcdb', secondary: '#e8777a', accent: '#7fb0d6', error: '#ef9a9a' },
    dark: { primary: '#6cb4ee', secondary: '#ff6b6e', accent: '#64a8e0', error: '#ef5350' },
};

// CSS custom properties, set on :root.
const VARS = {
    light: {
        bg: '#ffffff',
        surface: '#ffffff',
        surface2: '#f5f7fa',
        surface3: '#efefef',
        text: 'rgba(0, 0, 0, 0.87)',
        textMuted: 'rgba(0, 0, 0, 0.6)',
        border: '#e0e0e0',
        overlay: 'rgba(255, 255, 255, 0.92)',
        cursor: '#000000',
        tagBg: '#e8f0fe',
        tagText: '#1a56a0',
        logoFilter: 'none',
        themeColor: '#ffffff',
    },
    warm: {
        bg: '#f4ecdc',
        surface: '#fbf6ec',
        surface2: '#f2e9d8',
        surface3: '#ece2ce',
        text: '#2b241c',
        textMuted: '#5f5446',
        border: '#ddd0b8',
        overlay: 'rgba(251, 246, 236, 0.94)',
        cursor: '#2b241c',
        tagBg: '#ece0c8',
        tagText: '#5a3d12',
        logoFilter: 'none',
        themeColor: '#f4ecdc',
    },
    dim: {
        bg: '#25282c',
        surface: '#2e3237',
        surface2: '#363b40',
        surface3: '#3d4248',
        text: '#ddd6c8',
        textMuted: '#b5afa2',
        border: '#4a5057',
        overlay: 'rgba(46, 50, 55, 0.94)',
        cursor: '#ddd6c8',
        tagBg: '#3a4a5c',
        tagText: '#c5dcf0',
        // The logo is drawn in dark blue; on a dark ground it becomes the
        // warm text colour.
        logoFilter: 'brightness(0) invert(0.85) sepia(0.15)',
        themeColor: '#2e3237',
    },
    dark: {
        bg: '#000000',
        surface: '#121212',
        surface2: '#1c1c1c',
        surface3: '#242424',
        text: 'rgba(255, 255, 255, 0.87)',
        textMuted: 'rgba(255, 255, 255, 0.6)',
        border: '#333333',
        overlay: 'rgba(18, 18, 18, 0.94)',
        cursor: '#ffffff',
        tagBg: '#1e3550',
        tagText: '#a8d0f5',
        logoFilter: 'brightness(0) invert(0.87)',
        themeColor: '#000000',
    },
};

export function normaliseTheme(name) {
    return THEMES.includes(name) ? name : DEFAULT_THEME;
}

export function isDarkTheme(name) {
    const t = normaliseTheme(name);
    return t === 'dim' || t === 'dark';
}

export function vuetifyPalette(name) {
    return { ...VUETIFY[normaliseTheme(name)] };
}

const toKebab = s => s.replace(/[A-Z]/g, c => '-' + c.toLowerCase());

/** `{ '--ff-bg': '#000000', ... }` for the theme, ready for style.setProperty. */
export function themeCssVars(name) {
    const vars = VARS[normaliseTheme(name)];
    const out = {};
    for (const [k, v] of Object.entries(vars)) {
        if (k === 'themeColor') continue;
        out['--ff-' + toKebab(k)] = v;
    }
    return out;
}

/** Colour for `<meta name="theme-color">`: the browser chrome around the page. */
export function themeMetaColor(name) {
    return VARS[normaliseTheme(name)].themeColor;
}
