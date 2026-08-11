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
            // WITHOUT THIS THE APP DOES NOT WORK OFFLINE AT ALL.
            //
            // Workbox precaches nothing larger than 2 MiB by default, and the
            // WASM module is ~14 MB (tract, the ONNX runtime for the ML
            // transcriber, dominates it). So the single executable the whole
            // app runs on was being dropped from the precache manifest, with
            // only a build-log line to say so:
            //
            //   /<hash>.module.wasm is 13.9 MB, and won't be precached.
            //
            // Everything still appeared to work — including the offline e2e
            // tests — because Chrome's ordinary HTTP cache was serving it. That
            // cache is evictable and unrelated to the service worker, so the
            // real behaviour was: open the app on a plane after the HTTP cache
            // has turned over and there is no backend, no queries, and a
            // perfectly intact 42 MB tune index in IndexedDB that nothing can
            // read. Exactly the failure the offline work exists to prevent,
            // hiding behind the layer below it.
            //
            // 20 MB leaves headroom for the WASM to grow while still sitting
            // well below the 42 MB tune index, which must NOT be precached (see
            // runtimeCaching below) and which a local build does leave in
            // public/res/. So this limit doubles as the guard that keeps the
            // dataset out of the service worker.
            maximumFileSizeToCacheInBytes: 20 * 1024 * 1024,

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