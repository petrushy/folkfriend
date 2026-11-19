// The live view (the follow-score overlay) for the whole app.
//
// It used to be mounted inside the Session Tools view only, so the score was
// reachable only by routing there, and the overlay was destroyed with that
// route. It is mounted once now, by LiveViewHost in App.vue, and anything can
// open it — the Search screen's button opens it in place, with no route change.
//
// This module is the state the host and its openers share. It still goes
// through the session lifecycle to start listening (startForFollow): separating
// listening from the session is a later step.
import Vue from 'vue';
import liveAnalysisService from './liveAnalysis.js';
import ffBackend from './backend.js';
import { clearLastShown } from '@/js/liveScoreFollow.mjs';

export const liveView = Vue.observable({
    open: false,
    // While startLiveView() is opening the microphone, for the button's spinner.
    starting: false,
    // Why the last start did not reach the score. The host shows it; the
    // overlay never opens over a microphone that did not open, since a
    // full-screen score would hide the reason.
    error: '',
});

export function openLiveView() {
    liveView.error = '';
    liveView.open = true;
}

export function closeLiveView() {
    liveView.open = false;
}

const DEFAULT_WINDOW_SECONDS = 10;
const DEFAULT_STEP_SECONDS = 5;

// One tap from anywhere to "show me what is playing". Same rules as the
// Session Tools ?follow=1 entry point:
//
//   already listening    → just show the score
//   a session left open by a previous run of the app → restored, then
//                          continued or filed away by startForFollow's
//                          recency rule — never silently orphaned
//   nothing open         → start a session
//
// Every dependency is reached at call time, never captured at module
// evaluation: this module is imported from views that sit inside the
// backend → router → view import cycle (see practiceFollow.js).
export async function startLiveView() {
    if (liveView.starting) return;
    const svc = liveAnalysisService;
    if (svc.isRunning) { openLiveView(); return; }

    liveView.error = '';
    liveView.starting = true;
    try {
        if (!svc.sessionId) {
            try {
                await svc.restoreOpenSession();
            } catch (e) {
                // A failed read is not "no session": starting a new one here
                // could leave last night's behind, unfinished, for ever.
                console.warn('Could not check for an unfinished session:', e && e.message);
                liveView.error = 'Could not check for an unfinished session. Open Session Tools to resume or start one.';
                return;
            }
        }

        if (!(await ffBackend.indexReady())) {
            liveView.error = 'The tune database is not available yet, so nothing can be recognised.';
            return;
        }

        // A fresh session's first detection can share a tuneId with whatever
        // the overlay last showed, which would read as "same tune, no reload"
        // and could resurrect a stale manual override.
        if (!svc.sessionId) clearLastShown();

        const options = svc.options || {};
        const result = await svc.startForFollow(
            Number(options.windowSeconds) || DEFAULT_WINDOW_SECONDS,
            Number(options.stepSeconds) || DEFAULT_STEP_SECONDS,
        );
        if (!result.ok) {
            // The previous session could not be saved, so nothing new started.
            liveView.error = `The previous session could not be saved${result.error ? ` (${result.error})` : ''}. Open Session Tools to retry.`;
            return;
        }
    } catch (e) {
        liveView.error = 'Could not access the microphone. Please check permissions.';
        return;
    } finally {
        liveView.starting = false;
    }

    if (svc.isRunning) openLiveView();
}
