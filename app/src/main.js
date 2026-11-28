import Vue from 'vue';
import App from './App.vue';
import './registerServiceWorker';
import router from './router';
import vuetify from './plugins/vuetify';
import store from './services/store.js';
import { applyTheme } from './services/theme.js';

import { handleDropboxCallback, startDropbox } from './services/dropbox.js';

Vue.config.productionTip = false;

// The OAuth popup lands back on this origin, and that one tab must NOT become a
// second copy of the app: it hands the code to its opener and closes.
//
// Everything here is wrapped, and the app mounts whatever happens. Dropbox
// backup is opt-in and off by default, so a fault anywhere in it must cost the
// user that feature and nothing else — an unhandled throw at this point leaves
// a blank page with no way back, for a feature most people never turn on.
let isCallbackTab = false;
try {
    isCallbackTab = handleDropboxCallback();
} catch (e) {
    console.error('Dropbox callback handling failed', e);
}

if (!isCallbackTab) {
    // Before the mount, so the first paint is already in the chosen theme.
    try {
        applyTheme(vuetify, store.userSettings.colorTheme);
    } catch (e) {
        console.error('Could not apply colour theme', e);
    }

    new Vue({
        router,
        vuetify,
        render: h => h(App)
    }).$mount('#app');

    // AFTER the mount, for the same reason: nothing it does is worth a blank
    // screen, and it has no work to do until the app is running anyway.
    try {
        startDropbox();
    } catch (e) {
        console.error('Dropbox backup could not start', e);
    }
}
