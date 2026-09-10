import Vue from 'vue';
import App from './App.vue';
import './registerServiceWorker';
import router from './router';
import vuetify from './plugins/vuetify';

import { handleDropboxCallback, startDropbox } from './services/dropbox.js';

Vue.config.productionTip = false;

if (!handleDropboxCallback()) {
    startDropbox();
    new Vue({
        router,
        vuetify,
        render: h => h(App)
    }).$mount('#app');
}
