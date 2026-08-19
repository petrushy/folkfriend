// Shared lazy loader for Leaflet, used by every map in the app.
//
// Dynamic rather than a top-level import so ~150 KB of mapping code never
// reaches a user who does not open Places, and so a failure to fetch the chunk
// (offline, first visit) is something the caller can degrade around rather than
// a broken view. The `webpackChunkName` comments put the library and its CSS in
// one chunk shared by every caller, so opening the picker after the map costs
// nothing.
//
// The module promise is cached, so the second map on screen reuses the first
// one's load instead of racing it.

let loading = null;

export function loadLeaflet() {
    if (!loading) {
        loading = Promise.all([
            import(/* webpackChunkName: "leaflet" */ 'leaflet'),
            import(/* webpackChunkName: "leaflet" */ 'leaflet/dist/leaflet.css'),
        ]).then(([leaflet]) => {
            // Interop: the ESM build exposes the namespace, older builds default.
            return leaflet.default || leaflet;
        }).catch(e => {
            // Do not cache a failure — the user may simply have been offline,
            // and reopening the view should try again.
            loading = null;
            throw e;
        });
    }
    return loading;
}

export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const TILE_ATTRIBUTION =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
export const TILE_MAX_ZOOM = 19;
