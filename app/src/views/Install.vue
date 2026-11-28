<template>
    <v-container class="installView">
        <v-card class="pa-5 my-2">
            <h1>Install FolkFriend</h1>
            <p v-if="installState.installed" class="mt-3">
                <v-icon color="success" class="pb-1">{{ icons.checkCircle }}</v-icon>
                FolkFriend is installed on this device.
            </p>
            <template v-else>
                <p class="mt-3">
                    FolkFriend is a web app: you install it from the browser,
                    not from an app store. Installed, it opens from your Home
                    Screen like any other app, <b>works offline</b> (on a plane,
                    in a cellar pub), and the browser is far less likely to
                    clear the saved tune database.
                </p>

                <v-alert
                    v-if="installState.canPrompt"
                    type="info"
                    text
                    class="mt-2"
                >
                    Your browser can install FolkFriend directly.
                    <div class="mt-2">
                        <v-btn color="primary" @click="install">
                            <v-icon left>{{ icons.download }}</v-icon>
                            Install now
                        </v-btn>
                    </div>
                </v-alert>
                <p v-if="promptOutcome === 'dismissed'" class="text-caption">
                    Install was cancelled. You can still use the steps below.
                </p>

                <h2 class="mt-4">On this device</h2>
                <p class="text-caption mb-2">{{ platformLabel(installState.platform) }}</p>
                <ol class="steps">
                    <li v-for="(step, i) in stepsFor(installState.platform)" :key="i" v-html="step" />
                </ol>
            </template>
        </v-card>

        <v-card class="pa-5 my-2">
            <h2>Other devices</h2>
            <p class="text-caption">
                Helping someone else, or the steps above don't match your screen?
            </p>
            <v-expansion-panels accordion flat>
                <v-expansion-panel v-for="p in otherPlatforms" :key="p">
                    <v-expansion-panel-header>{{ platformLabel(p) }}</v-expansion-panel-header>
                    <v-expansion-panel-content>
                        <ol class="steps">
                            <li v-for="(step, i) in stepsFor(p)" :key="i" v-html="step" />
                        </ol>
                    </v-expansion-panel-content>
                </v-expansion-panel>
            </v-expansion-panels>
        </v-card>

        <v-card class="pa-5 my-2">
            <h2>After installing</h2>
            <ul class="steps">
                <li>Open FolkFriend <b>from the Home Screen icon</b>, not from the browser — the browser tab and the installed app keep separate data.</li>
                <li>Open it once with a connection so the tune database is downloaded. After that it works offline.</li>
                <li>Allow the microphone when asked; it is needed to recognise tunes.</li>
            </ul>
        </v-card>
    </v-container>
</template>

<script>
import { mdiCheckCircleOutline, mdiDownload } from '@mdi/js';
import { installState, promptInstall } from '@/services/installPrompt.js';
import { PLATFORMS } from '@/js/installPlatform.mjs';

const SHARE = '<b>Share</b> (the square with an arrow pointing up)';

// Step text per platform. Kept as data so every platform's instructions are
// in one place and the page renders them all the same way.
const STEPS = {
    'ios-safari': [
        `Tap ${SHARE} — at the bottom of the screen on iPhone, top right on iPad.`,
        'Scroll down the list and tap <b>Add to Home Screen</b>. (Not there? Tap <b>Edit Actions…</b> at the bottom and add it.)',
        'Tap <b>Add</b> in the top right corner.',
        'Open FolkFriend from its new icon on the Home Screen.',
    ],
    'ios-other': [
        `In Chrome or Edge, tap ${SHARE} in the address bar; in Firefox, tap the menu <b>☰</b> then <b>Share</b>.`,
        'Tap <b>Add to Home Screen</b>, then <b>Add</b>.',
        'If you do not see <b>Add to Home Screen</b> (iOS older than 16.4), open this page in <b>Safari</b> and follow the Safari steps.',
    ],
    'in-app': [
        'You are in a browser built into another app (Instagram, Facebook, Messenger, Gmail…). It cannot install web apps.',
        'Tap the <b>⋯</b> or <b>Share</b> menu and choose <b>Open in Safari</b> / <b>Open in browser</b> / <b>Open in Chrome</b>.',
        'Then follow the steps for that browser here (this page will show them).',
    ],
    'android-chrome': [
        'Tap the menu <b>⋮</b> (three dots, top right).',
        'Tap <b>Install app</b> or <b>Add to Home screen</b> (newer Chrome may put it under <b>Cast, save and share</b>).',
        'Tap <b>Install</b> to confirm.',
        'Open FolkFriend from the new icon on your Home screen or app drawer.',
    ],
    'android-samsung': [
        'Tap the menu <b>☰</b> (three lines, bottom right).',
        'Tap <b>Add page to</b>, then <b>Home screen</b>.',
        'Tap <b>Add</b> to confirm.',
    ],
    'android-firefox': [
        'Tap the menu <b>⋮</b> (three dots).',
        'Tap <b>Install</b> or <b>Add to Home screen</b>.',
        'Confirm with <b>Add</b>.',
    ],
    'android-other': [
        'Open the browser menu.',
        'Look for <b>Install app</b> or <b>Add to Home screen</b>.',
        'If there is neither, open this page in <b>Chrome</b> and follow the Chrome steps.',
    ],
    'desktop-chromium': [
        'Click the install icon <b>⊕</b> at the right end of the address bar.',
        'Or open the menu <b>⋮</b> / <b>⋯</b> → <b>Cast, save and share</b> (Chrome) or <b>Apps</b> (Edge) → <b>Install FolkFriend</b>.',
        'Click <b>Install</b>. FolkFriend opens in its own window and appears among your apps.',
    ],
    'desktop-safari': [
        'Needs macOS 14 (Sonoma) or newer.',
        'In the menu bar choose <b>File → Add to Dock…</b>.',
        'Click <b>Add</b>. FolkFriend appears in the Dock and Launchpad.',
    ],
    'desktop-other': [
        'This browser cannot install web apps (Firefox on the desktop, for example).',
        'You can keep using FolkFriend in the browser, or open it in <b>Chrome</b>, <b>Edge</b> or <b>Safari</b> (macOS 14+) to install it.',
    ],
};

const LABELS = {
    'ios-safari': 'iPhone / iPad — Safari',
    'ios-other': 'iPhone / iPad — Chrome, Edge or Firefox',
    'in-app': 'Opened inside another app',
    'android-chrome': 'Android — Chrome',
    'android-samsung': 'Android — Samsung Internet',
    'android-firefox': 'Android — Firefox',
    'android-other': 'Android — other browsers',
    'desktop-chromium': 'Computer — Chrome or Edge',
    'desktop-safari': 'Mac — Safari',
    'desktop-other': 'Computer — other browsers',
};

export default {
    name: 'InstallApp',
    data: () => ({
        installState,
        promptOutcome: null,
        icons: { checkCircle: mdiCheckCircleOutline, download: mdiDownload },
    }),
    computed: {
        otherPlatforms() {
            return PLATFORMS.filter(p => p !== this.installState.platform || this.installState.installed);
        },
    },
    methods: {
        stepsFor(p) { return STEPS[p] || STEPS['desktop-other']; },
        platformLabel(p) { return LABELS[p] || p; },
        async install() {
            this.promptOutcome = await promptInstall();
        },
    },
};
</script>

<style scoped>
.steps li {
    margin-bottom: 0.5em;
}
</style>
