// ONE session-audio player for the whole app, so playback survives leaving the
// page it was started from.
//
// The player used to live inside the Session Analysis view, so opening a tune's
// score — a route change — destroyed the view, the player and its <audio>
// element with it, and the recording stopped mid-tune. The instance now lives
// in App.vue for the life of the app. The view BORROWS it: while the view is
// on screen the player's element is moved into the view's recording card, and
// when the view goes away it is moved back into a hidden holder in App.vue.
// Moving the element never pauses it, and the component's logic (loading the
// next segment at a boundary, the time display) keeps running throughout.
//
// This module is the state the two share. It holds no audio of its own.
import Vue from 'vue';

export const playerHost = Vue.observable({
    // What the player is showing: set by the view while it is on screen and
    // deliberately LEFT as it was when the view goes away, which is what
    // lets the recording carry on.
    sessionId: '',
    // For the lock screen's "Now Playing" card.
    sessionName: '',
    detections: [],
    listening: false,
    // What the player reports: { playing, detectionId, label }.
    playback: { playing: false, detectionId: null, label: '' },
    // Whether the player is inside a view right now, rather than parked.
    shown: false,
});

let instance = null;
let home = null;
let wanted = null;

// App.vue, once mounted. A view that mounted first (it always does — children
// mount before their parents) has already asked for the player; honour that.
export function registerPlayer(vm, homeEl) {
    instance = vm;
    home = homeEl;
    if (wanted) showPlayerIn(wanted);
}

export function sessionPlayer() {
    return instance;
}

export function showPlayerIn(slot) {
    wanted = slot || null;
    if (!slot) { parkPlayer(); return; }
    playerHost.shown = true;
    if (instance && instance.$el && instance.$el.parentNode !== slot) slot.appendChild(instance.$el);
}

// Back into the hidden holder. Called when the view leaves, and when the
// view's recording card goes away while the view stays.
export function parkPlayer() {
    wanted = null;
    playerHost.shown = false;
    if (instance && instance.$el && home && instance.$el.parentNode !== home) home.appendChild(instance.$el);
}

// Plays one tune of a saved session, looped, from a page that does not show
// the player (a favourite's ▶). The session replaces whatever the player was
// holding, exactly as opening another session in the Session Analysis view
// does; the mini player then carries it on every page.
//
// `onError` hears about a failure that surfaces after this resolves — a clip
// that will not load, a Dropbox download that fails — since the player that
// would say so is parked out of sight. It stops listening once sound starts.
export async function playSessionTuneLooped({ sessionId, sessionName, detections, detectionId }, { onError } = {}) {
    const player = instance;
    if (!player) return { ok: false, error: 'The player is not ready yet.' };
    // While the tap is still a user gesture: resumes a graph iOS suspended.
    player._prepareAudioGraph();
    playerHost.sessionId = sessionId;
    playerHost.sessionName = sessionName || '';
    playerHost.detections = detections || [];
    playerHost.listening = false;
    // Lets App.vue pass the new props down, and the player start reloading.
    await Vue.nextTick();
    const ok = await player.playTuneLooped(detectionId);
    if (!ok) return { ok: false, error: player.error || 'Could not play that recording.' };
    if (onError && !player.playing) {
        const stop = [];
        const done = () => { stop.forEach(fn => fn()); };
        stop.push(player.$watch('error', message => { if (message) { done(); onError(message); } }));
        stop.push(player.$watch('playing', playing => { if (playing) done(); }));
        const timer = setTimeout(done, 60000);
        stop.push(() => clearTimeout(timer));
    }
    return { ok: true, error: '' };
}
