// One location fix per capture session, for geo-tagging tune sightings.
//
// The battery question decided the whole shape of this file. What drains a
// phone is holding watchPosition() open with high accuracy — the navigation-app
// pattern. A *single* fix, even a high-accuracy one, is a few seconds of radio
// and is not measurable next to what this app already does during a session
// (microphone open, AudioContext running, every window through DSP or a 14 MB
// ONNX model). So: never watch, and take at most one fix per session.
//
// High accuracy is on deliberately, reversing the obvious instinct to save
// power with a coarse fix. The feature is "which pub", and a network-derived
// fix is 50-100 m — in a city centre that is several pubs. Paying for one
// accurate fix an evening buys the precision the feature actually needs; the
// saving from a coarse fix would be invisible and would make the data useless.
//
// Nothing here ever throws. A refused, unavailable or slow fix degrades to a
// sighting with no coordinates, which is still a record that the tune was
// heard.

import store from './store.js';

// How long a fix stays good for. You do not move between tunes, so re-fixing
// per detection is pure waste; but a session can run for hours and people do
// change venue, so it is not cached forever either.
export const FIX_MAX_AGE_MS = 30 * 60 * 1000;

// Hard deadline on a single fix attempt, matching the bounded-request
// discipline used for every network call in tuneIndexNetwork.js. Indoors a fix
// can take a long time or never arrive; the sighting must not wait on it.
export const FIX_TIMEOUT_MS = 15 * 1000;

// Accept an OS-cached position up to this old. Distinct from FIX_MAX_AGE_MS,
// which is *our* cache: this one lets the platform skip powering the radio at
// all if it already knows where it is, which is the single biggest battery
// saving available here and costs nothing in accuracy at pub granularity.
const PLATFORM_MAX_AGE_MS = 2 * 60 * 1000;

// A fix younger than this survives beginSession(). Short enough that a genuine
// change of venue is not papered over, long enough that starting three
// captures in a row costs one fix rather than three.
const SESSION_REUSE_MS = 3 * 60 * 1000;

class GeoService {
    constructor() {
        this._fix = null;          // { lat, lon, accuracy, at }
        this._inFlight = null;     // shared promise, so concurrent callers cost one fix
        this._denied = false;      // permission refused — stop asking for this run
        this.lastError = null;     // { kind, message } for the Settings panel
    }

    // Whether tagging is switched on AND possible. Read before every capture:
    // the user can turn it off mid-session and that must take effect at once.
    isEnabled() {
        return !!(store.userSettings && store.userSettings.geoTagDetections) && this.isSupported();
    }

    isSupported() {
        return typeof navigator !== 'undefined' && !!navigator.geolocation;
    }

    // Best-effort reading of the permission state without triggering a prompt.
    // Safari has historically not implemented permissions.query for
    // geolocation, hence the defensive shape and the 'unknown' fallback.
    async permissionState() {
        if (!this.isSupported()) return 'unsupported';
        if (this._denied) return 'denied';
        try {
            if (navigator.permissions && navigator.permissions.query) {
                const status = await navigator.permissions.query({ name: 'geolocation' });
                return status.state; // 'granted' | 'denied' | 'prompt'
            }
        } catch (e) {
            // Not supported for this name — fall through.
        }
        return 'unknown';
    }

    // Called when a capture opens. Clears the previous session's fix (the user
    // may have gone somewhere else since) and warms a new one in the
    // background, so the first tune recognised a minute later is tagged
    // immediately rather than waiting on the radio.
    //
    // Deliberately does NOT await: readiness of the session must never depend
    // on the location, exactly as app readiness never depends on the network.
    beginSession() {
        // A fix this recent is kept: several capture paths can open in quick
        // succession (record, search, record again), and discarding a fix taken
        // seconds ago would spin the radio again to learn the same thing.
        const fresh = this._fix && (Date.now() - this._fix.at) < SESSION_REUSE_MS;
        if (!fresh) this._fix = null;
        if (!this.isEnabled()) return;
        this.getFix().catch(() => {});
    }

    // The fix to stamp on a sighting. Returns null rather than throwing when
    // tagging is off, refused, backgrounded or simply slow.
    async getFix() {
        if (!this.isEnabled() || this._denied) return null;

        if (this._fix && (Date.now() - this._fix.at) < FIX_MAX_AGE_MS) return this._fix;

        // Requesting a position while backgrounded tends to hang or fail on
        // mobile, and on iOS it is also the wrong moment to raise a permission
        // prompt the user cannot see. The session keeps running; the next
        // sighting after the user returns picks up a fix.
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            return this._fix;
        }

        // Concurrent callers join the one attempt rather than each starting
        // their own — the same reasoning as micService._healthCheck. Assigned
        // before the first await so there is no window for a second caller to
        // slip past.
        if (!this._inFlight) {
            this._inFlight = this._acquire().finally(() => { this._inFlight = null; });
        }
        return this._inFlight;
    }

    // The fix as it stands, with no attempt to acquire one. For UI that wants
    // to show status without causing a prompt or a radio wake.
    peekFix() {
        return this._fix;
    }

    // Explicit, user-gesture-driven acquisition for the Settings panel. This is
    // where the OS prompt is meant to happen — asking mid-session, over a tune,
    // is the worst possible moment.
    async requestPermission() {
        if (!this.isSupported()) return { ok: false, error: 'This device has no location support.' };
        this._denied = false;
        this.lastError = null;
        const fix = await this._acquire();
        if (fix) return { ok: true, fix };
        return { ok: false, error: this.lastError ? this.lastError.message : 'Could not get a location.' };
    }

    _acquire() {
        return new Promise(resolve => {
            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };

            // Belt and braces alongside the `timeout` option: some
            // implementations have been known not to honour it, and a sighting
            // must never be blocked indefinitely by a pending callback.
            const timer = setTimeout(() => {
                this.lastError = { kind: 'timeout', message: 'Timed out waiting for a location.' };
                finish(this._fix);
            }, FIX_TIMEOUT_MS + 1000);

            navigator.geolocation.getCurrentPosition(
                (position) => {
                    clearTimeout(timer);
                    const fix = normalisePosition(position);
                    if (fix) {
                        this._fix = fix;
                        this.lastError = null;
                    }
                    finish(fix || this._fix);
                },
                (error) => {
                    clearTimeout(timer);
                    this.lastError = describeError(error);
                    // A refusal is sticky for this run. Retrying would re-prompt
                    // on some platforms and spin the radio on others, and the
                    // user has just said no.
                    if (error && error.code === 1) this._denied = true;
                    finish(this._fix);
                },
                {
                    enableHighAccuracy: true,
                    timeout: FIX_TIMEOUT_MS,
                    maximumAge: PLATFORM_MAX_AGE_MS,
                },
            );
        });
    }

    // Test seam: reset all cached state.
    _reset() {
        this._fix = null;
        this._inFlight = null;
        this._denied = false;
        this.lastError = null;
    }
}

export function normalisePosition(position) {
    const coords = position && position.coords;
    if (!coords) return null;
    const lat = Number(coords.latitude);
    const lon = Number(coords.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const accuracy = Number(coords.accuracy);
    return {
        lat,
        lon,
        accuracy: Number.isFinite(accuracy) ? Math.round(accuracy) : null,
        at: Date.now(),
    };
}

function describeError(error) {
    const code = error && error.code;
    if (code === 1) return { kind: 'denied', message: 'Location permission was refused.' };
    if (code === 2) return { kind: 'unavailable', message: 'No location available right now.' };
    if (code === 3) return { kind: 'timeout', message: 'Timed out waiting for a location.' };
    return { kind: 'error', message: (error && error.message) || 'Could not get a location.' };
}

const geoService = new GeoService();
export default geoService;
