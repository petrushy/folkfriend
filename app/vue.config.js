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
            // The ONE runtime cache, and the reasoning above is exactly why it
            // is safe: map tiles are small, bounded here by maxEntries, and —
            // unlike the tune index — they are not a second copy of something
            // already in IndexedDB. Nothing else in the app may be added here
            // without the same argument.
            //
            // CacheFirst, not StaleWhileRevalidate: a tile for a fixed
            // coordinate does not change in any way a user of this app cares
            // about, and revalidating would spend mobile data re-fetching
            // identical PNGs every time the Places view opens.
            //
            // 400 tiles is roughly 8 MB worst case — a few screenfuls at
            // several zoom levels for each place someone actually plays at.
            // That makes the pub you visit weekly work on a plane, while a
            // place you have never looked at does not, which is the honest
            // limit of what a tile server can offer offline.
            //
            // statuses [0, 200] because these are opaque cross-origin
            // responses; without the 0 the cache silently stores nothing.
            runtimeCaching: [{
                urlPattern: /^https:\/\/tile\.openstreetmap\.org\//,
                handler: 'CacheFirst',
                options: {
                    cacheName: 'folkfriend-map-tiles',
                    expiration: {
                        maxEntries: 400,
                        maxAgeSeconds: 60 * 60 * 24 * 60, // 60 days
                        purgeOnQuotaError: true,
                    },
                    cacheableResponse: { statuses: [0, 200] },
                },
            }],
            cleanupOutdatedCaches: true,
            importScripts: ['sw-cleanup.js'],
        },
    },
};