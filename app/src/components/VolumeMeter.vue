<template>
    <div class="volume-meter-wrap">
        <span v-if="label" class="volume-meter-label caption text--secondary">Mic</span>
        <div class="volume-meter" role="img" :aria-label="ariaLabel">
            <div
                v-for="i in 8"
                :key="i"
                class="led"
                :class="ledClass(i)"
            />
        </div>
        <!-- Separate from the LEDs on purpose. The bar is an RMS average of
             the last second, which cannot show clipping at all: a signal
             hitting full scale on every peak sits well down on RMS and lights
             the same LEDs as a comfortable one. This reads the PEAK, which is
             the only thing that can say the input has run out of headroom. -->
        <span v-if="clipping" class="volume-meter-clip caption" role="status">CLIP</span>
    </div>
</template>

<script>
import micService from '@/services/mic.js';

// LED meter polled at ~1s. RMS is mapped to LED count via a dB scale so the
// indicator behaves naturally across quiet field recording and louder sources.
// -50 dB → 0 LEDs, -5 dB → 8 LEDs.
const DB_FLOOR = -50;
const DB_CEIL = -5;

// Peak amplitude at which the input is at or within a hair of full scale.
// -0.1 dBFS: below this a sample is simply loud, at it the converter has
// nothing left and the waveform is being flattened.
const CLIP_PEAK = 0.988;
// How many polls a clip stays on screen. A clip is momentary and the meter
// only looks once a second, so without a hold it would flash and be gone
// before anyone glanced at the phone.
const CLIP_HOLD_TICKS = 4;

export default {
    name: 'VolumeMeter',
    props: {
        active: { type: Boolean, default: true },
        intervalMs: { type: Number, default: 800 },
        // Whether to say in words what this is a meter OF. It sits beside
        // transport buttons and a detection LED that mean entirely different
        // things, and an unlabelled bar of lights next to them reads as a
        // confidence or quality indicator, which it is not: it is the level
        // arriving from the microphone and it gates nothing.
        label: { type: Boolean, default: true },
    },
    data() {
        return { ledCount: 0, clipHold: 0 };
    },
    watch: {
        active(val) {
            if (val) this._start();
            else this._stop();
        },
    },
    computed: {
        ariaLabel() {
            return `Microphone input level, ${this.ledCount} of 8` +
                (this.clipping ? ', clipping' : '');
        },
        clipping() { return this.clipHold > 0; },
    },
    created() {
        if (this.active) this._start();
    },
    beforeDestroy() {
        this._stop();
    },
    methods: {
        _start() {
            if (this._timer) return;
            // Discard whatever was accumulated before the meter mounted so the
            // first reading reflects only audio captured while we were active.
            micService.getRmsLevel();
            if (micService.getPeakLevel) micService.getPeakLevel();
            this._timer = setInterval(() => this._tick(), this.intervalMs);
        },
        _stop() {
            if (this._timer) {
                clearInterval(this._timer);
                this._timer = null;
            }
            this.ledCount = 0;
            this.clipHold = 0;
        },
        _tick() {
            const rms = micService.getRmsLevel();
            // Read unconditionally, so the accumulator is cleared even on a
            // tick with no audio at all — otherwise one clip would be held in
            // the peak for ever and reported again the moment sound returned.
            const peak = micService.getPeakLevel ? micService.getPeakLevel() : 0;
            if (peak >= CLIP_PEAK) this.clipHold = CLIP_HOLD_TICKS;
            else if (this.clipHold > 0) this.clipHold--;
            if (rms <= 0) {
                this.ledCount = 0;
                return;
            }
            const db = 20 * Math.log10(rms);
            const fraction = (db - DB_FLOOR) / (DB_CEIL - DB_FLOOR);
            const n = Math.round(fraction * 8);
            this.ledCount = Math.max(0, Math.min(8, n));
        },
        ledClass(i) {
            const lit = i <= this.ledCount;
            if (!lit) return 'led--off';
            if (i <= 4) return 'led--low';
            if (i <= 6) return 'led--mid';
            return 'led--high';
        },
    },
};
</script>

<style scoped>
.volume-meter-wrap {
    display: inline-flex;
    gap: 6px;
    align-items: center;
}
.volume-meter-label {
    line-height: 1;
}
.volume-meter-clip {
    line-height: 1;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: #f44336;
}
.volume-meter {
    display: inline-flex;
    gap: 3px;
    align-items: center;
    height: 14px;
}
.led {
    width: 8px;
    height: 14px;
    border-radius: 2px;
    background: #e0e0e0;
    transition: background 250ms ease-out;
}
.led--off { background: #e0e0e0; }
.led--low { background: #4caf50; }
.led--mid { background: #ffc107; }
.led--high { background: #f44336; }
</style>
