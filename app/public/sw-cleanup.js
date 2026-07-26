/* eslint-disable no-undef */
// Imported into the generated service worker (see vue.config.js
// workboxOptions.importScripts).
//
// Up to v3.5.0 the ~42 MB tune index was stored twice: once by this service
// worker's 'folkfriend-tune-data' runtime cache and once in IndexedDB. The
// runtime cache has been removed, but Workbox only prunes caches it still
// manages, so the old one would linger forever and keep the origin near its
// storage quota — making eviction of the IndexedDB copy (the one that actually
// makes the app work offline) far more likely.
//
// Delete it explicitly on activate. Safe and idempotent: if it isn't there,
// caches.delete resolves false.
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.delete('folkfriend-tune-data').then(deleted => {
            if (deleted) {
                console.log('Removed obsolete folkfriend-tune-data cache (~42 MB reclaimed)');
            }
        }).catch(() => {})
    );
});
