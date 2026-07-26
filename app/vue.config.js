const fs = require('fs');
const packageJson = fs.readFileSync('./package.json');
const version = JSON.parse(packageJson).version || '';
const webpack = require('webpack');

module.exports = {
    transpileDependencies: ['vuetify'],
    configureWebpack: {
        plugins: [
            // This is just to pull the version from package.json into ffConfig.js
            new webpack.DefinePlugin({
                'process.env': {
                    PACKAGE_VERSION: '"' + version + '"',
                },
            }),
        ],
        experiments: {
            asyncWebAssembly: true,
        }
    },
    chainWebpack: (config) => {
        // Getting PWA stuff like this to work with vue / webpack is a faff.
        //  It's super easy to just supply the manifest file in /public ourselves.
        config.plugins.delete('pwa');

        // if (process.env.NODE_ENV === 'production') {
        //     config.plugin('copy').tap((opts) => {
        //         opts[0][0].ignore.push({
        //             glob: 'folkfriend-non-user-data.json*',
        //         });
        //         opts[0][0].ignore.push({
        //             glob: 'nud-meta.json',
        //         });
        //         return opts;
        //     });
        // }
    },
    pwa: {
        name: 'FolkFriend',
        theme_color: '#055581',
        background_color: '#055581',
        workboxOptions: {
            // The ~42 MB tune index is deliberately NOT cached by the service
            // worker. It used to be (StaleWhileRevalidate, cache
            // 'folkfriend-tune-data') while ALSO being stored in IndexedDB by
            // services/tuneIndexStore.js — two copies of the same 42 MB, i.e.
            // ~84 MB of origin quota for one dataset. That roughly doubled the
            // chance of the browser evicting site data, which is precisely the
            // failure the offline copy exists to prevent. IndexedDB (plus
            // navigator.storage.persist()) is now the single durable store; the
            // worker never re-fetches the index unless the version changed.
            //
            // Delete the stale cache left over from previous builds so upgrading
            // users get that 42 MB back.
            runtimeCaching: [],
            cleanupOutdatedCaches: true,
            importScripts: ['sw-cleanup.js'],
        },
    },
};