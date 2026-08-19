// Pure geometry and clustering for geo-tagged tune sightings.
//
// Deliberately dependency-free and side-effect-free: no IndexedDB, no
// geolocation, no network. Everything here is a plain function over plain
// objects so app/test/sightings.test.mjs can exercise the real logic without a
// browser, and so the naming/grouping rules stay testable as they get fussier.
//
// The central design decision lives here: place names are derived by
// clustering the user's own coordinates, NOT by reverse geocoding. Geocoding
// would mean a third-party request carrying the user's location off-device,
// and it would stop working exactly where this app is supposed to keep
// working — offline, in a cellar bar with no signal. Instead a sighting stores
// raw coordinates, the user names a spot once, and every past and future
// sighting within the radius adopts that name.

// How close a sighting has to be to a named place to be counted as "at" it.
// 150 m is a compromise. Larger and two pubs on the same street merge; smaller
// and a fix taken indoors (where accuracy degrades badly) misses its own
// place. Per-place overrides exist because a festival field and a back-room
// session are not the same size — see radiusForPlace().
export const DEFAULT_PLACE_RADIUS_M = 150;

// Used when grouping sightings that are not near any *named* place, so the UI
// can offer "somewhere you played 12 tunes — give it a name?". Tighter than
// DEFAULT_PLACE_RADIUS_M: an unnamed cluster is a proposal, and it is easier
// for a user to merge two proposals by giving them the same name than it is to
// split one that swallowed the pub next door.
export const UNNAMED_CLUSTER_RADIUS_M = 80;

const EARTH_RADIUS_M = 6371008.8;

function toRadians(degrees) {
    return degrees * Math.PI / 180;
}

export function isValidFix(fix) {
    return !!fix &&
        Number.isFinite(fix.lat) && Number.isFinite(fix.lon) &&
        Math.abs(fix.lat) <= 90 && Math.abs(fix.lon) <= 180 &&
        // 0,0 is in the Atlantic and is overwhelmingly more likely to be a
        // zeroed-out struct than a real fix. Nobody is playing reels there.
        !(fix.lat === 0 && fix.lon === 0);
}

// Great-circle distance in metres. The haversine form is used rather than the
// cheaper equirectangular approximation because it costs nothing at these list
// sizes and removes any need to reason about latitude-dependent error.
export function haversineMetres(a, b) {
    if (!isValidFix(a) || !isValidFix(b)) return Infinity;
    const dLat = toRadians(b.lat - a.lat);
    const dLon = toRadians(b.lon - a.lon);
    const lat1 = toRadians(a.lat);
    const lat2 = toRadians(b.lat);
    const h = Math.sin(dLat / 2) ** 2 +
        Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function radiusForPlace(place) {
    const r = place && Number(place.radiusM);
    return Number.isFinite(r) && r > 0 ? r : DEFAULT_PLACE_RADIUS_M;
}

// Nearest named place containing `fix`, or null. "Containing" is per-place, so
// a place with a wide radius can win over a nearer one with a tight radius
// only if the nearer one does not contain the fix at all.
export function matchPlace(fix, places) {
    if (!isValidFix(fix) || !Array.isArray(places)) return null;
    let best = null;
    let bestDistance = Infinity;
    for (const place of places) {
        const distance = haversineMetres(fix, place);
        if (distance <= radiusForPlace(place) && distance < bestDistance) {
            best = place;
            bestDistance = distance;
        }
    }
    return best;
}

// Sightings that should adopt `place` when it is first named or moved. This is
// what makes naming retroactive: the user plays six evenings somewhere, then
// names it once, and all six evenings are labelled.
//
// Only sightings with no placeID are adopted. An explicit assignment to a
// different place is the user's, and a new place's radius overlapping it must
// not silently steal it.
export function sightingsToAdopt(place, sightings) {
    if (!isValidFix(place) || !Array.isArray(sightings)) return [];
    const radius = radiusForPlace(place);
    return sightings.filter(s => !s.placeID && haversineMetres(place, s) <= radius);
}

// Greedy leader clustering over sightings with no place. Deterministic:
// sightings are processed oldest-first so the same input always produces the
// same clusters and the same leader, which matters because the UI offers these
// as nameable proposals and they must not reshuffle between renders.
export function clusterUnplacedSightings(sightings, radiusM = UNNAMED_CLUSTER_RADIUS_M) {
    const unplaced = (Array.isArray(sightings) ? sightings : [])
        .filter(s => !s.placeID && isValidFix(s))
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

    const clusters = [];
    for (const sighting of unplaced) {
        let target = null;
        let bestDistance = Infinity;
        for (const cluster of clusters) {
            const distance = haversineMetres(cluster, sighting);
            if (distance <= radiusM && distance < bestDistance) {
                target = cluster;
                bestDistance = distance;
            }
        }
        if (target) {
            target.sightings.push(sighting);
        } else {
            clusters.push({ lat: sighting.lat, lon: sighting.lon, sightings: [sighting] });
        }
    }

    return clusters
        .map(cluster => ({ ...summariseSightings(cluster.sightings), lat: cluster.lat, lon: cluster.lon }))
        .sort((a, b) => b.lastSeen - a.lastSeen);
}

function summariseSightings(sightings) {
    const tuneIDs = new Set();
    let firstSeen = Infinity;
    let lastSeen = -Infinity;
    for (const s of sightings) {
        if (s.tuneID != null) tuneIDs.add(String(s.tuneID));
        const t = s.timestamp || 0;
        if (t < firstSeen) firstSeen = t;
        if (t > lastSeen) lastSeen = t;
    }
    return {
        sightings,
        count: sightings.length,
        tuneCount: tuneIDs.size,
        firstSeen: firstSeen === Infinity ? 0 : firstSeen,
        lastSeen: lastSeen === -Infinity ? 0 : lastSeen,
    };
}

// Everywhere the user has heard tunes: one entry per named place that has any
// sightings, plus one per unnamed cluster. Sorted most-recent-first.
export function groupSightingsByPlace(sightings, places) {
    const list = Array.isArray(sightings) ? sightings : [];
    const placeList = Array.isArray(places) ? places : [];
    const byPlaceID = new Map();

    for (const sighting of list) {
        if (!sighting.placeID) continue;
        if (!byPlaceID.has(sighting.placeID)) byPlaceID.set(sighting.placeID, []);
        byPlaceID.get(sighting.placeID).push(sighting);
    }

    // Every named place appears, including ones with no hearings yet. A place
    // the user created deliberately — for a session they are going to, or to
    // tag tunes to by hand — must be visible the moment it is saved, or saving
    // it looks like it failed. Empty ones sort last, having lastSeen 0.
    const named = placeList.map(place => ({
        place,
        ...summariseSightings(byPlaceID.get(place.id) || []),
    }));

    // A sighting whose placeID names a place that no longer exists would
    // otherwise vanish from every view while still occupying storage. Treat it
    // as unplaced so it resurfaces and can be renamed.
    const orphaned = list.filter(s => s.placeID && !placeList.some(p => p.id === s.placeID));
    const unnamed = clusterUnplacedSightings(
        list.filter(s => !s.placeID).concat(orphaned.map(s => ({ ...s, placeID: null })))
    ).map(cluster => ({ place: null, ...cluster }));

    return [...named, ...unnamed].sort((a, b) => b.lastSeen - a.lastSeen);
}

// Where one tune has been heard — the "several places for the same tune" case
// this whole feature exists for. Unnamed sightings collapse into a single
// "unknown location" bucket rather than one row each.
export function placesForTune(sightings, places, tuneID) {
    const key = String(tuneID);
    const mine = (Array.isArray(sightings) ? sightings : [])
        .filter(s => String(s.tuneID) === key);
    if (!mine.length) return [];

    const placeList = Array.isArray(places) ? places : [];
    const groups = new Map();

    for (const sighting of mine) {
        const place = sighting.placeID
            ? placeList.find(p => p.id === sighting.placeID) || null
            : null;
        const groupKey = place ? place.id : '__unnamed__';
        if (!groups.has(groupKey)) groups.set(groupKey, { place, sightings: [] });
        groups.get(groupKey).sightings.push(sighting);
    }

    return [...groups.values()]
        .map(group => ({ place: group.place, ...summariseSightings(group.sightings) }))
        .sort((a, b) => b.lastSeen - a.lastSeen);
}

// Projects a set of points into a unit square for the tile-free mini-map. The
// app has no basemap (that would need a tile CDN and a network connection, and
// this feature has to work in the cellar bar it was designed for), so the map
// is a relative scatter: shape and grouping are real, absolute geography is
// not. Returns null when there is nothing to draw.
export function projectPoints(points, { padding = 0.08 } = {}) {
    const valid = (Array.isArray(points) ? points : []).filter(isValidFix);
    if (!valid.length) return null;

    const lats = valid.map(p => p.lat);
    const lons = valid.map(p => p.lon);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);

    // Longitude degrees shrink with latitude; without this correction a set of
    // points in Sweden looks stretched east-west.
    const midLatRad = toRadians((minLat + maxLat) / 2);
    const spanLat = maxLat - minLat;
    const spanLon = (maxLon - minLon) * Math.cos(midLatRad);
    // A single point, or several at the same spot, has no extent to scale by.
    const span = Math.max(spanLat, spanLon);
    const usable = 1 - 2 * padding;

    return valid.map(point => {
        if (span <= 0) return { ...point, x: 0.5, y: 0.5 };
        const x = padding + usable * (
            0.5 + ((point.lon - (minLon + maxLon) / 2) * Math.cos(midLatRad)) / span
        );
        // SVG y grows downward; north should be up.
        const y = padding + usable * (
            0.5 - (point.lat - (minLat + maxLat) / 2) / span
        );
        return { ...point, x, y };
    });
}
