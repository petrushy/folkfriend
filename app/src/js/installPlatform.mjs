// Which install instructions apply to this browser, and whether the app is
// already installed. Pure: every browser fact is passed in, so it is tested in
// node (test/installPlatform.test.mjs).
//
// The platforms, and why each is separate:
//  - ios-safari   Share → Add to Home Screen. The only route on iOS for years.
//  - ios-other    Chrome/Edge/Firefox on iOS can add to the Home Screen from
//                 their own share button since iOS 16.4, but the menu differs,
//                 and on older iOS only Safari can — so we say both.
//  - in-app       A link opened inside Instagram, Facebook, Messenger, Gmail,
//                 LinkedIn, … The embedded browser cannot install anything at
//                 all; the only useful instruction is "open it in a browser".
//                 This is the commonest way people meet a shared link, and the
//                 commonest reason "the instructions don't match my screen".
//  - android-chrome / android-samsung / android-firefox / android-other
//  - desktop-chromium (Chrome, Edge), desktop-safari (macOS 14+, Add to Dock),
//    desktop-other (Firefox desktop cannot install web apps).

export const PLATFORMS = Object.freeze([
    'ios-safari', 'ios-other', 'in-app',
    'android-chrome', 'android-samsung', 'android-firefox', 'android-other',
    'desktop-chromium', 'desktop-safari', 'desktop-other',
]);

const IN_APP = /FBAN|FBAV|FB_IAB|Instagram|Messenger|LinkedInApp|Line\/|Snapchat|Twitter|GSA\/|MicroMessenger|; wv\)/i;

/**
 * @param {object} env
 * @param {string} env.userAgent
 * @param {number} [env.maxTouchPoints] — iPadOS 13+ claims to be a Mac; touch gives it away.
 * @returns {string} one of PLATFORMS
 */
export function detectInstallPlatform({ userAgent = '', maxTouchPoints = 0 } = {}) {
    const ua = String(userAgent);
    const isIPadAsMac = /Macintosh/.test(ua) && maxTouchPoints > 1;
    const isIOS = /iPhone|iPad|iPod/.test(ua) || isIPadAsMac;
    const isAndroid = /Android/.test(ua);

    if ((isIOS || isAndroid) && IN_APP.test(ua)) return 'in-app';

    if (isIOS) {
        // Every iOS browser is WebKit; the others announce themselves.
        if (/CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|YaBrowser|DuckDuckGo/.test(ua)) return 'ios-other';
        return 'ios-safari';
    }
    if (isAndroid) {
        if (/SamsungBrowser/.test(ua)) return 'android-samsung';
        if (/Firefox/.test(ua)) return 'android-firefox';
        if (/Chrome\//.test(ua) && !/EdgA|OPR|YaBrowser|UCBrowser/.test(ua)) return 'android-chrome';
        return 'android-other';
    }
    if (/Edg\/|Chrome\//.test(ua) && !/OPR\//.test(ua)) return 'desktop-chromium';
    if (/Safari\//.test(ua) && /Macintosh/.test(ua)) return 'desktop-safari';
    return 'desktop-other';
}

/**
 * Whether the page is running as an installed app.
 *
 * `display-mode` covers Android and desktop; iOS Safari has supported it for a
 * while but `navigator.standalone` is the long-standing answer there, so both
 * count. `minimal-ui` / `fullscreen` are what some browsers report for an
 * installed app whose manifest asks for them.
 *
 * @param {object} env
 * @param {(query: string) => boolean} [env.matches]
 * @param {boolean} [env.navigatorStandalone]
 */
export function isInstalled({ matches = () => false, navigatorStandalone = false } = {}) {
    if (navigatorStandalone === true) return true;
    return ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay']
        .some(mode => {
            try { return !!matches(`(display-mode: ${mode})`); } catch (e) { return false; }
        });
}

/** The group a platform's instructions are listed under on the Install page. */
export function platformGroup(platform) {
    if (platform === 'in-app') return 'in-app';
    if (platform.startsWith('ios')) return 'ios';
    if (platform.startsWith('android')) return 'android';
    return 'desktop';
}
