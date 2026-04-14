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
            // The tune index is 32MB — too large to precache, but we want it
            // served from cache immediately after first load. CacheFirst means:
            // cold start → fetch from network + cache; all subsequent loads →
            // serve from cache instantly with no network round-trip.
            runtimeCaching: [{
                urlPattern: /\/res\/folkfriend-non-user-data\.json/,
                // Serve from cache immediately for fast startup, but fetch a
                // fresh copy in the background. The updated version is used on
                // the next app open.
                handler: 'StaleWhileRevalidate',
                options: {
                    cacheName: 'folkfriend-tune-data',
                },
            }],
        },
    },
};