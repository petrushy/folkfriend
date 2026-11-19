// The live view (the follow-score overlay) for the whole app.
//
// Mounted once, by LiveViewHost in App.vue, and opened from anywhere. It is
// independent of the session: opening it only LISTENS (the microphone and the
// analysis loop), it never creates, resumes or saves a session, and pausing a
// Session Capture leaves it running. See the listener/capture split in
// services/liveAnalysis.js.
import Vue from 'vue';
import liveAnalysisService from './liveAnalysis.js';
import ffBackend from './backend.js';
import { clearLastShown } from '@/js/liveScoreFollow.mjs';

export const liveView = Vue.observable({
    open: false,
    // While openLiveView() is opening the microphone, for the button's spinner.
    starting: false,
    // Why the last open did not reach the score. The host shows it; the
    // overlay never opens over a microphone that did not open, since a
    // full-screen score would hide the reason.
    error: '',
});

// One tap from anywhere to "show me what is playing".
//
// Every dependency is reached at call time, never captured at module
// evaluation: this module is imported from views that sit inside the
// backend → router → view import cycle (see practiceFollow.js).
export async function openLiveView() {
    if (liveView.open || liveView.starting) return;
    liveView.error = '';
    liveView.starting = true;
    try {
        if (!(await ffBackend.indexReady())) {
            liveView.error = 'The tune database is not available yet, so nothing can be recognised.';
            return;
        }
        // A fresh listening run starts with an empty list, and its first
        // detection can share a tuneId with whatever the overlay last showed —
        // which would read as "same tune, no reload" and could resurrect a
        // stale manual override.
        if (!liveAnalysisService.isListening) clearLastShown();
        await liveAnalysisService.setLiveViewActive(true);
    } catch (e) {
        console.warn('Live view could not start listening:', e && e.message);
        liveView.error = 'Could not access the microphone. Please check permissions.';
        return;
    } finally {
        liveView.starting = false;
    }
    liveView.open = true;
}

// Releases the microphone unless a Session Capture is still using it.
export function closeLiveView() {
    if (!liveView.open) return Promise.resolve();
    liveView.open = false;
    return liveAnalysisService.setLiveViewActive(false)
        .catch(e => console.warn('Could not stop listening:', e && e.message));
}
