// The app's one practice follower (js/practiceFollow.mjs), wired to the real
// microphone, backend and live session. Used by the Tune view.
//
// Every dependency is reached through a function or getter, never captured
// as a value: backend.js imports the router, the router the Tune view, and
// the Tune view this file — so while this module is evaluated, backend.js
// may still be half-loaded and its default export undefined. Captured, that
// undefined stayed for good and every window failed with "cannot read
// transcribePCMSignal of undefined" (found by a browser check).

import { PracticeFollow } from '@/js/practiceFollow.mjs';
import micService from '@/services/mic.js';
import ffBackend from '@/services/backend.js';
import liveAnalysisService from '@/services/liveAnalysis.js';
import store from '@/services/store.js';
import eventBus from '@/eventBus.js';

const practiceFollow = new PracticeFollow({
    mic: {
        startContinuous: (s) => micService.startContinuous(s),
        stopContinuous: () => micService.stopContinuous(),
        ensureMicHealthy: () => micService.ensureMicHealthy(),
        getContinuousAudio: () => micService.getContinuousAudio(),
        get sampleRate() {
            return micService.sampleRate || (micService.audioCtx && micService.audioCtx.sampleRate);
        },
        isListening: () => store.isListening(),
    },
    backend: {
        transcribePCMSignal: (pcm, rate) => ffBackend.transcribePCMSignal(pcm, rate),
    },
    live: {
        get isRunning() { return liveAnalysisService.isRunning; },
        get isPaused() { return liveAnalysisService.isPaused; },
        get scorePosition() { return liveAnalysisService.scorePosition; },
    },
    emit: (event, payload) => eventBus.$emit(event, payload),
    now: () => Date.now(),
    sleep: (ms) => new Promise(resolve => setTimeout(resolve, ms)),
});

export default practiceFollow;
