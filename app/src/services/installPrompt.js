// Install state for the whole app: is it installed, and (on Chromium) the
// deferred `beforeinstallprompt` event that lets a button open the browser's
// own install dialog instead of sending the user hunting through a menu.
//
// The listeners are attached when this module is first imported, which is
// App.vue's import — before the mount. `beforeinstallprompt` fires early and
// only once per page load, so a listener added in a component's mounted()
// can simply miss it.
import Vue from 'vue';
import { detectInstallPlatform, isInstalled } from '@/js/installPlatform.mjs';

function readInstalled() {
    if (typeof window === 'undefined') return false;
    return isInstalled({
        matches: q => window.matchMedia && window.matchMedia(q).matches,
        navigatorStandalone: window.navigator && window.navigator.standalone,
    });
}

export const installState = Vue.observable({
    installed: readInstalled(),
    // True once the browser has handed us an install prompt we can show.
    canPrompt: false,
    platform: typeof navigator === 'undefined' ? 'desktop-other' : detectInstallPlatform({
        userAgent: navigator.userAgent,
        maxTouchPoints: navigator.maxTouchPoints,
    }),
});

let deferredPrompt = null;

if (typeof window !== 'undefined') {
    window.addEventListener('beforeinstallprompt', (event) => {
        // Keep the browser's mini-infobar from appearing on its own; the
        // Install page offers the same thing when the user asks for it.
        event.preventDefault();
        deferredPrompt = event;
        installState.canPrompt = true;
    });
    window.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        installState.canPrompt = false;
        installState.installed = true;
    });
    if (window.matchMedia) {
        try {
            const mq = window.matchMedia('(display-mode: standalone)');
            const onChange = () => { installState.installed = readInstalled(); };
            if (mq.addEventListener) mq.addEventListener('change', onChange);
            else if (mq.addListener) mq.addListener(onChange);
        } catch (e) { /* older browsers: the initial reading stands */ }
    }
}

/**
 * Open the browser's own install dialog. Resolves 'accepted', 'dismissed', or
 * 'unavailable' when there is no prompt to show. A prompt can be used once.
 */
export async function promptInstall() {
    if (!deferredPrompt) return 'unavailable';
    const event = deferredPrompt;
    deferredPrompt = null;
    installState.canPrompt = false;
    try {
        await event.prompt();
        const choice = await event.userChoice;
        return choice && choice.outcome === 'accepted' ? 'accepted' : 'dismissed';
    } catch (e) {
        return 'unavailable';
    }
}
