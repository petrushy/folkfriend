<template>
    <!-- ABCJS generates the SVG from a saved score. -->
    <!-- eslint-disable vue/no-v-html -->
    <div
        ref="host"
        class="set-score-preview"
        :style="{ width: width + 'px' }"
        v-html="visible ? svg : ''"
    />
</template>
<script>
import ABCJS from 'abcjs';
export default {
    name: 'SetScorePreview',
    props: { setting: { type: Object, required: true }, width: { type: Number, default: 300 } },
    data: () => ({ visible: false }),
    computed: {
        svg() {
            if (!this.setting || !this.setting.abc) return '';
            const lines = [];
            if (this.setting.mode) lines.push(`K:${this.setting.mode}`);
            if (this.setting.meter) lines.push(`M:${this.setting.meter}`);
            if (!/^L:/m.test(this.setting.abc)) lines.push('L:1/8');
            // Strip chord annotations and tempo — chords add vertical whitespace above the staff.
            let body = this.setting.abc;
            body = body.replace(/^Q:[^\n]*/gm, '');
            body = body.replace(/"[^"]*"/g, '');
            // Strip multi-voice ABC — keep only V:1 content so only one staff renders.
            if (/^V:/m.test(body)) {
                const filtered = [];
                let inV1 = true; // before any V: marker, include content
                for (const line of body.split('\n')) {
                    if (/^V:1/.test(line)) { inV1 = true; continue; }
                    if (/^V:/.test(line))  { inV1 = false; continue; }
                    if (inV1) filtered.push(line);
                }
                body = filtered.join('\n');
            }
            // Show more bars when more space is available.
            // Each bar is roughly 110px at scale 0.65, so derive bar count from width.
            // +1 to account for the leading |: repeat marker which counts as a pipe but isn't a bar.
            const maxBars = this.width < 300 ? 2
                : this.width < 390 ? 3
                    : 4;
            const targetPipes = maxBars + 1;
            let count = 0;
            let cutAt = body.length;
            for (let i = 0; i < body.length; i++) {
                if (body[i] === '|' && ++count >= targetPipes) { cutAt = i + 1; break; }
            }
            lines.push(body.slice(0, cutAt));

            const div = document.createElement('div');
            ABCJS.renderAbc(div, lines.join('\n'), {
                // Render at actual display width so no CSS scaling is needed.
                // scale zooms note size (1.0 = default); 0.65 gives compact but readable notation.
                staffwidth: this.width,
                scale: 0.65,
                paddingtop: 0,
                paddingbottom: 0,
                paddingleft: 0,
                paddingright: 0,
                // Force everything onto one line regardless of time signature width
                wrap: { minSpacing: 1, maxSpacing: 3, preferredMeasuresPerLine: 8 },
            });
            return div.innerHTML;
        },
    },
    mounted() {
        if (typeof IntersectionObserver === 'undefined') { this.visible = true; return; }
        this._observer = new IntersectionObserver(entries => {
            if (entries.some(e => e.isIntersecting)) { this.visible = true; this._observer.disconnect(); }
        }, { rootMargin: '400px 0px' });
        this._observer.observe(this.$refs.host);
    },
    beforeDestroy() { if (this._observer) this._observer.disconnect(); },
};
</script>
<style scoped>
.set-score-preview { overflow: hidden; height: 80px; flex-shrink: 0; opacity: 0.75; margin: 0 8px; cursor: pointer; }
</style>
