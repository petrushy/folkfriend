// Applies a colour theme (js/theme.mjs) to the running app: Vuetify's dark
// flag and palette, the --ff-* CSS variables, and the browser's theme-color.
import { normaliseTheme, isDarkTheme, vuetifyPalette, themeCssVars, themeMetaColor } from '@/js/theme.mjs';

// `vuetify` is either the instance main.js creates (its services live on
// `.framework`) or a component's `this.$vuetify` (which IS the framework).
export function applyTheme(vuetify, name) {
    const theme = normaliseTheme(name);
    const dark = isDarkTheme(theme);
    const framework = vuetify && (vuetify.framework || vuetify);
    if (framework && framework.theme) {
        // Both dim and dark use Vuetify's dark mode; they differ in palette.
        Object.assign(framework.theme.themes[dark ? 'dark' : 'light'], vuetifyPalette(theme));
        framework.theme.dark = dark;
    }
    if (typeof document !== 'undefined') {
        const root = document.documentElement;
        root.dataset.theme = theme;
        for (const [k, v] of Object.entries(themeCssVars(theme))) root.style.setProperty(k, v);
        // Lets native controls (scrollbars, form widgets) match.
        root.style.colorScheme = dark ? 'dark' : 'light';
        // index.html may have painted a dark ground before the app loaded;
        // this replaces it either way, so switching back to light works.
        root.style.background = 'var(--ff-bg)';
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', themeMetaColor(theme));
    }
    return theme;
}
