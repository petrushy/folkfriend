<template>
    <div class="volume-meter" role="img" :aria-label="ariaLabel">
        <div
            v-for="i in 8"
            :key="i"
            class="led"
            :class="ledClass(i)"
        />
    </div>
</template>

<script>
import micService from '@/services/mic.js';

// LED meter polled at ~1s. RMS is mapped to LED count via a dB scale so the
// indicator behaves naturally across quiet field recording and louder sources.
// -50 dB → 0 LEDs, -5 dB → 8 LEDs.
const DB_FLOOR = -50;
const DB_CEIL = -5;

export default {
    name: 'VolumeMeter',
    props: {
        active: { type: Boolean, default: true },
        intervalMs: { type: Number, default: 800 },
    },
    data() {
        return { ledCount: 0 };
    },
    watch: {
        active(val) {
            if (val) this._start();
            else this._stop();
        },
    },
    computed: {
        ariaLabel() {
            return `Volume meter, ${this.ledCount} of 8`;
        },
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
            this._timer = setInterval(() => this._tick(), this.intervalMs);
        },
        _stop() {
            if (this._timer) {
                clearInterval(this._timer);
                this._timer = null;
            }
            this.ledCount = 0;
        },
        _tick() {
            const rms = micService.getRmsLevel();
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
