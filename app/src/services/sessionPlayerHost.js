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
