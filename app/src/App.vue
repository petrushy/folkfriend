<template>
    <v-app>
        <v-navigation-drawer
            v-model="drawer"
            app
        >
            <!-- By the way the @click="0" thing adds the ripple animation.
                  Guess otherwise vuetify thinks it's not clickable?
                  The 0 is insignificant I just needed any valid javascript-->
            <v-list dense>
                <router-link to="/">
                    <v-list-item @click="0">
                        <v-list-item-action>
                            <v-icon medium>
                                {{ icons.magnify }}
                            </v-icon>
                        </v-list-item-action>
                        <v-list-item-content>
                            <v-list-item-title class="navBarEntry">
                                Search
                            </v-list-item-title>
                        </v-list-item-content>
                    </v-list-item>
                </router-link>

                <router-link to="/notes">
                    <v-list-item @click="0">
                        <v-list-item-action>
                            <v-icon medium>
                                {{ icons.musicNote }}
                            </v-icon>
                        </v-list-item-action>
                        <v-list-item-content>
                            <v-list-item-title class="navBarEntry">
                                Notes
                            </v-list-item-title>
                        </v-list-item-content>
                    </v-list-item>
                </router-link>

                <router-link to="/results">
                    <v-list-item @click="0">
                        <v-list-item-action>
                            <v-icon medium>
                                {{ icons.formatListBulleted }}
                            </v-icon>
                        </v-list-item-action>
                        <v-list-item-content>
                            <v-list-item-title class="navBarEntry">
                                Results
                            </v-list-item-title>
                        </v-list-item-content>
                    </v-list-item>
                </router-link>

                <router-link to="/session-analysis">
                    <v-list-item @click="0">
                        <v-list-item-action>
                            <v-icon medium>
                                {{ icons.waveform }}
                            </v-icon>
                        </v-list-item-action>
                        <v-list-item-content>
                            <v-list-item-title class="navBarEntry">
                                Session Analysis
                            </v-list-item-title>
                        </v-list-item-content>
                    </v-list-item>
                </router-link>

                <router-link to="/history">
                    <v-list-item @click="0">
                        <v-list-item-action>
                            <v-icon medium>
                                {{ icons.history }}
                            </v-icon>
                        </v-list-item-action>
                        <v-list-item-content>
                            <v-list-item-title class="navBarEntry">
                                History
                            </v-list-item-title>
                        </v-list-item-content>
                    </v-list-item>
                </router-link>

                <router-link to="/favourites">
                    <v-list-item @click="0">
                        <v-list-item-action>
                            <v-icon medium>
                                {{ icons.star }}
                            </v-icon>
                        </v-list-item-action>
                        <v-list-item-content>
                            <v-list-item-title class="navBarEntry">
                                Favourites
                            </v-list-item-title>
                        </v-list-item-content>
                    </v-list-item>
                </router-link>

                <router-link to="/places">
                    <v-list-item @click="0">
                        <v-list-item-action>
                            <v-icon medium>
                                {{ icons.mapMarker }}
                            </v-icon>
                        </v-list-item-action>
                        <v-list-item-content>
                            <v-list-item-title class="navBarEntry">
                                Places
                            </v-list-item-title>
                        </v-list-item-content>
                    </v-list-item>
                </router-link>

                <router-link to="/settings">
                    <v-list-item @click="0">
                        <v-list-item-action>
                            <v-icon medium>
                                {{ icons.cog }}
                            </v-icon>
                        </v-list-item-action>
                        <v-list-item-content>
                            <v-list-item-title class="navBarEntry">
                                Settings
                            </v-list-item-title>
                        </v-list-item-content>
                    </v-list-item>
                </router-link>

                <router-link to="/help">
                    <v-list-item @click="0">
                        <v-list-item-action>
                            <v-icon medium>
                                {{ icons.help }}
                            </v-icon>
                        </v-list-item-action>
                        <v-list-item-content>
                            <v-list-item-title class="navBarEntry">
                                About
                            </v-list-item-title>
                        </v-list-item-content>
                    </v-list-item>
                </router-link>

                <a href="https://donorbox.org/help-support-development-of-folkfriend" target="_blank" rel="noopener noreferrer">
                    <v-list-item @click="0">
                        <v-list-item-action>
                            <v-icon medium>
                                {{ icons.heart }}
                            </v-icon>
                        </v-list-item-action>
                        <v-list-item-content>
                            <v-list-item-title class="navBarEntry">
                                Donate
                            </v-list-item-title>
                        </v-list-item-content>
                    </v-list-item>
                </a>
            </v-list>
        </v-navigation-drawer>

        <v-app-bar
            app
            color="white"
            elevate-on-scroll
        >
            <v-icon
                v-if="hamburgerState === hamburgerStates.hamburger"
                color="primary"
                @click.stop="drawer = !drawer"
            >
                {{ icons.menu }}
            </v-icon>
            <v-icon
                v-else-if="hamburgerState === hamburgerStates.back"
                color="primary"
                @click="hamburgerBack"
            >
                {{ icons.chevronLeft }}
            </v-icon>
            <v-icon
                v-else-if="hamburgerState === hamburgerStates.cancel"
                color="primary"
                @click="hamburgerCancel"
            >
                {{ icons.close }}
            </v-icon>

            <v-img
                src="@/assets/logo.svg"
                max-height="90%"
                max-width="75%"
                class="mx-auto MainLogo"
                align-center
                center
                contain
            />
            <v-icon
                color="primary"
                @click="clickSearch($event)"
            >
                {{ icons.magnify }}
            </v-icon>
        </v-app-bar>

        <v-main>
            <!-- Follows the user everywhere: a session survives navigating
                 away from Session Analysis, so its status and controls have to
                 as well. -->
            <SessionStatusBar />
            <router-view />
        </v-main>

        <!-- Persistent banner when a new app version is available -->
        <v-snackbar v-model="updateBanner" :timeout="-1" bottom>
            A new version is available.
            <template #action="{ attrs }">
                <v-btn text small v-bind="attrs" @click="reloadApp">Reload</v-btn>
            </template>
        </v-snackbar>

        <!-- Transient banner for Firestore sync errors -->
        <v-snackbar v-model="syncErrorSnackbar" :timeout="5000" bottom>
            {{ syncErrorText }}
        </v-snackbar>

        <!-- One dialog for the whole app, opened from any (i) button via the
             event bus. Mounted here so a list of favourites does not create one
             dialog per row. -->
        <TuneBackgroundDialog />
    </v-app>
</template>


<script>
import { getAnalytics } from 'firebase/analytics';
import { onAuthStateChanged } from 'firebase/auth';
import firebaseApp, { firebaseAuth } from '@/services/firebase.js';


import ffBackend from '@/services/backend.js';
import store from '@/services/store.js';
import eventBus from '@/eventBus.js';
import router from '@/router/index.js';
import {
    mdiChevronLeft,
    mdiCog,
    mdiClose,
    mdiDownload,
    mdiFormatListBulleted,
    mdiHelpCircleOutline,
    mdiHistory,
    mdiHeart,
    mdiMagnify,
    mdiMapMarker,
    mdiMenu,
    mdiMicrophone,
    mdiMusicNote,
    mdiStar,
    mdiWaveform,
    // mdiShareVariant,
} from '@mdi/js';
import utils from '@/js/utils.js';
import TuneBackgroundDialog from '@/components/TuneBackgroundDialog.vue';
import SessionStatusBar from '@/components/SessionStatusBar.vue';

export default {
    name: 'App',
    components: { TuneBackgroundDialog, SessionStatusBar },
    data: () => ({
        drawer: null,
        menu: null,
        hamburgerStates: {
            hamburger: 'hamburger',
            back: 'back',
            cancel: 'cancel',
        },
        hamburgerState: 'hamburger',
        updateBanner: false,
        // ServiceWorkerRegistration carrying the waiting worker, so Reload can
        // actually apply the update (see reloadApp).
        swRegistration: null,
        syncErrorSnackbar: false,
        syncErrorText: '',
        icons: {
            chevronLeft: mdiChevronLeft,
            cog: mdiCog,
            close: mdiClose,
            download: mdiDownload,
            formatListBulleted: mdiFormatListBulleted,
            heart: mdiHeart,
            help: mdiHelpCircleOutline,
            history: mdiHistory,
            magnify: mdiMagnify,
            mapMarker: mdiMapMarker,
            menu: mdiMenu,
            microphone: mdiMicrophone,
            musicNote: mdiMusicNote,
            star: mdiStar,
            waveform: mdiWaveform,
            // shareVariant: mdiShareVariant,
        },
        isPWA: utils.checkStandalone(),
    }),
    mounted: function () {
        initSetup().then();

        // We cannot interrupt long running queries in WASM so we prevent the
        //  user from navigating to different pages in the app whilst recording
        //  or working. Otherwise they could navigate back to the search page
        //  and trigger multiple concurrent requests to the worker backend.
        //  This could happen accidentally on slow devices. Instead we nudge
        //  the user towards sitting tight and waiting if it's taking a while
        //  by having the nice gears animation and disabling the navigation
        //  hamburger. As a fallback, the navigation hamburger becomes a cross
        //  which refreshes the page in case recording / working hangs completely.
        eventBus.$on('setSearchState', () => {
            if (store.isReady() || store.isListening()) {
                if (this.hamburgerState === this.hamburgerStates.cancel) {
                    this.hamburgerState = this.hamburgerStates.hamburger;
                }
            } else {
                this.hamburgerState = this.hamburgerStates.cancel;
            }
        });

        // When clicking on a link in a table, which is
        //  1.  Results table from audio query
        //  2.  Results table from name query
        //  3.  History of transcriptions / viewed tunes
        //  we navigate the user to a new page, without them having used
        //  the navbar directly. In these cases we smooth UX by having the
        //  hamburger convert to a back arrow which returns to the previous
        //  screen. For example when looking through tune results the user
        //  wants to check if an entry is the right tune, and if not then
        //  return to the results and try the next one down. This introduces
        //  a hierarchy for which hamburger navigation on its own becomes
        //  unintuitive and cumbersome.
        eventBus.$on('childViewActivated', () => {
            this.hamburgerState = this.hamburgerStates.back;
        });

        // Make sure hamburger is in the right state if we navigate back
        //  from a child view WITHOUT pressing the back button in app
        //  (e.g. physical back button on phone, alt + left shortcut on PC)
        eventBus.$on('parentViewActivated', () => {
            this.hamburgerState = this.hamburgerStates.hamburger;
        });

        // NB: store.state.indexLoaded / indexStatus are maintained centrally by
        // ffBackend._onIndexStatus — do not mirror index state here as well.

        eventBus.$on('swUpdated', (registration) => {
            this.swRegistration = registration || null;
            this.updateBanner = true;
        });

        eventBus.$on('syncError', (msg) => {
            this.syncErrorText = msg;
            this.syncErrorSnackbar = true;
        });
    },
    methods: {
        reloadApp() {
            // A new service worker installs into the "waiting" state and will
            // not take control while the old one still controls a client.
            // window.location.reload() does NOT release control — the page
            // reloads and the OLD worker still serves it — so tapping Reload
            // appeared to do nothing and the only way to pick up a deploy was
            // to fully close the app. Tell the waiting worker to activate
            // (it already listens for SKIP_WAITING), then reload once it has
            // actually taken over.
            const waiting = this.swRegistration && this.swRegistration.waiting;
            if (!waiting) {
                window.location.reload();
                return;
            }

            let reloaded = false;
            const reloadOnce = () => {
                if (reloaded) return;
                reloaded = true;
                window.location.reload();
            };
            navigator.serviceWorker.addEventListener(
                'controllerchange', reloadOnce, { once: true });
            // Safety net: if controllerchange never fires (an edge case rather
            // than the norm), reload anyway rather than leaving a dead button.
            setTimeout(reloadOnce, 3000);
            waiting.postMessage({ type: 'SKIP_WAITING' });
        },
        hamburgerBack() {
            router.back();
        },
        hamburgerCancel() {
            let result = window.confirm('Cancel this search?');
            if (result) {
                window.location.reload(false);
            }
        },
        clickSearch(e) {
            if (e && e.currentTarget) e.currentTarget.blur();
            if (this.$route.name !== 'search') {
                router.push({ name: 'search' });
                eventBus.$emit('parentViewActivated');
            }
        },
        clickSettings() {
            if(this.$route.name != 'settings') {
                // User can shortcut back to search if they tap the settings from there.
                //  If tapped from anywhere else just goes back to a normal hamburger state.
                if(this.$route.name == 'search') {
                    eventBus.$emit('childViewActivated');
                }

                router.push({ name: 'settings' });
            }
        },
    },
};

async function initAnalytics() {
    const analytics = getAnalytics(firebaseApp);
    store.loadAnalytics(analytics);
    store.logAnalyticsEvent('running_standalone', {'value': utils.checkStandalone()}).then();

    store.loadAuth(firebaseAuth);
    onAuthStateChanged(firebaseAuth, user => {
        if (user) {
            store.onSignedIn(user);
        } else {
            store.onSignedOut();
        }
    });
}

async function initSetup() {
    ffBackend.version().then((version) => {
        store.state.backendVersion = version;
        console.info('Loaded folkfriend backend version', version);
    });

    // Request durable (persistent) storage so the browser does not evict
    // IndexedDB under storage pressure. Especially important on iOS Safari,
    // which can clear site data for PWAs that haven't been opened recently.
    // Fire-and-forget — denial is silent and the app still works; it just
    // means the tune index could be evicted, requiring a re-download.
    if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().then(granted => {
            console.info('Persistent storage:', granted ? 'granted' : 'not granted');
        });
    }

    // Auth must be initialised immediately — do not wait for tune index setup,
    // which can take seconds. A user tapping "Sign in" before auth is ready
    // would hit store.signIn() with this.auth === null and crash.
    await initAnalytics();
    await ffBackend.setupTuneIndex();
}
</script>

<style>
.v-list > a {
    text-decoration: none;
}

h1 {
    color: var(--v-secondary-base);
}

html, body {
    overscroll-behavior-y: contain;  
}

.viewContainerWrapper {
    display: block;
    max-width: 90vw;
    padding-left: 0;
    padding-right: 0;
    margin-left: auto;
    margin-right: auto;
}
</style>
