<template>
    <v-card ref="card" class="pa-4 my-3 session-plan">
        <!-- The tab above names the plan and counts it; only the switch here. -->
        <div v-if="progress.doneCount" class="d-flex align-center mb-1">
            <v-spacer />
            <v-switch
                v-model="hidePlayed"
                dense
                hide-details
                inset
                class="mt-0 pt-0"
                label="Hide played"
            />
        </div>
        <v-alert v-if="error" type="error" dense text class="mb-2">
            {{ error }}
        </v-alert>
        <!-- Finding a tune in a long plan mid-session: by name and by type.
             Display only; the plan itself is untouched. -->
        <div v-if="plan.length > 1" class="plan-filters mb-2">
            <v-text-field
                v-model="filterName"
                dense
                hide-details
                clearable
                :prepend-inner-icon="icons.search"
                label="Filter by name"
                class="mb-1"
            />
            <div v-if="planTypes.length > 1 || planTags.length" class="d-flex flex-wrap" style="gap: 4px;">
                <v-chip
                    v-for="type in planTypes"
                    :key="type"
                    small
                    :outlined="!filterTypes.includes(type)"
                    :color="filterTypes.includes(type) ? 'primary' : undefined"
                    @click="toggleType(type)"
                >
                    {{ typeLabel(type) }}
                </v-chip>
                <v-chip
                    v-for="tag in planTags"
                    :key="'tag:' + tag"
                    small
                    label
                    :outlined="!filterTags.includes(tag)"
                    :color="filterTags.includes(tag) ? 'secondary' : undefined"
                    @click="toggleTag(tag)"
                >
                    {{ tag }}
                </v-chip>
            </div>
        </div>
        <p v-if="!plan.length" class="caption text--secondary mb-0">
            Nothing planned yet. Add tunes from
            <router-link :to="{ name: 'favourites' }">Favourites</router-link> (filter by a tag, select all,
            then <em>Add to session</em>), from <router-link :to="{ name: 'sets' }">Sets</router-link>,
            or from a tune's page or a search result.
        </p>

        <div v-for="(item, index) in visibleItems" :key="item.id" class="plan-item">
            <!-- A set: a header, then its tunes, each crossed off on its own. -->
            <template v-if="item.kind === 'set'">
                <div class="plan-row plan-set-header" :class="{ played: entry(item).done }">
                    <v-icon small class="mr-2" :color="entry(item).done ? 'success' : ''">
                        {{ entry(item).done ? icons.done : icons.set }}
                    </v-icon>
                    <div class="plan-text">
                        <div class="plan-title">
                            <router-link v-if="item.setID" :to="{ name: 'sets', query: { setID: item.setID } }">
                                {{ item.title }}
                            </router-link>
                            <span v-else>{{ item.title }}</span>
                        </div>
                        <div class="caption text--secondary">
                            Set · {{ item.tunes.length }} {{ item.tunes.length === 1 ? 'tune' : 'tunes' }}
                        </div>
                        <div v-if="setTagsFor(item).length" class="plan-tags">
                            <v-chip v-for="tag in setTagsFor(item)" :key="tag" x-small outlined class="mr-1">{{ tag }}</v-chip>
                        </div>
                    </div>
                    <v-spacer />
                    <div class="plan-actions">
                        <v-btn v-if="!filtering" icon small :disabled="busy || index === 0" :aria-label="`Move ${item.title} up`" @click="move(item.id, -1)">
                            <v-icon small>{{ icons.up }}</v-icon>
                        </v-btn>
                        <v-btn v-if="!filtering" icon small :disabled="busy || index === visibleItems.length - 1" :aria-label="`Move ${item.title} down`" @click="move(item.id, 1)">
                            <v-icon small>{{ icons.down }}</v-icon>
                        </v-btn>
                        <v-btn icon small :disabled="busy" :aria-label="`Remove ${item.title} from the plan`" @click="remove(item.id)">
                            <v-icon small>{{ icons.remove }}</v-icon>
                        </v-btn>
                    </div>
                </div>
                <div
                    v-for="(tune, j) in visibleTunes(item)"
                    :key="tune.id"
                    class="plan-row plan-tune in-set"
                    :class="rowClass(tune)"
                >
                    <v-btn icon small class="mr-1" :aria-label="stateLabel(tune)" :disabled="busy" @click="toggleDone(tune)">
                        <v-icon small :color="stateColor(tune)">{{ stateIcon(tune) }}</v-icon>
                    </v-btn>
                    <div class="plan-text">
                        <div class="plan-title">
                            <router-link :to="tuneRoute(tune)">{{ displayName(tune.title) }}</router-link>
                        </div>
                        <div class="caption text--secondary">{{ describe(tune) }}</div>
                        <div v-if="tagsFor(tune).length" class="plan-tags">
                            <v-chip v-for="tag in tagsFor(tune)" :key="tag" x-small outlined class="mr-1">{{ tag }}</v-chip>
                        </div>
                    </div>
                    <!-- eslint-disable-next-line vue/no-v-html -->
                    <div v-if="showPreview(tune)" class="abc-preview" :style="{ width: previewWidth + 'px' }" v-html="previewSvg(tune)" />
                    <v-spacer />
                    <div class="plan-actions">
                        <v-btn v-if="!filtering" icon small :disabled="busy || j === 0" :aria-label="`Move ${tune.title} up within the set`" @click="move(tune.id, -1)">
                            <v-icon small>{{ icons.up }}</v-icon>
                        </v-btn>
                        <v-btn v-if="!filtering" icon small :disabled="busy || j === item.tunes.length - 1" :aria-label="`Move ${tune.title} down within the set`" @click="move(tune.id, 1)">
                            <v-icon small>{{ icons.down }}</v-icon>
                        </v-btn>
                        <v-btn icon small :disabled="busy" :aria-label="`Remove ${tune.title} from the plan`" @click="remove(tune.id)">
                            <v-icon small>{{ icons.remove }}</v-icon>
                        </v-btn>
                    </div>
                </div>
            </template>

            <div v-else class="plan-row plan-tune" :class="rowClass(item)">
                <v-btn icon small class="mr-1" :aria-label="stateLabel(item)" :disabled="busy" @click="toggleDone(item)">
                    <v-icon small :color="stateColor(item)">{{ stateIcon(item) }}</v-icon>
                </v-btn>
                <div class="plan-text">
                    <div class="plan-title">
                        <router-link :to="tuneRoute(item)">{{ displayName(item.title) }}</router-link>
                    </div>
                    <div class="caption text--secondary">{{ describe(item) }}</div>
                    <div v-if="tagsFor(item).length" class="plan-tags">
                        <v-chip v-for="tag in tagsFor(item)" :key="tag" x-small outlined class="mr-1">{{ tag }}</v-chip>
                    </div>
                </div>
                <!-- eslint-disable-next-line vue/no-v-html -->
                <div v-if="showPreview(item)" class="abc-preview" :style="{ width: previewWidth + 'px' }" v-html="previewSvg(item)" />
                <v-spacer />
                <div class="plan-actions">
                    <v-btn v-if="!filtering" icon small :disabled="busy || index === 0" :aria-label="`Move ${item.title} up`" @click="move(item.id, -1)">
                        <v-icon small>{{ icons.up }}</v-icon>
                    </v-btn>
                    <v-btn v-if="!filtering" icon small :disabled="busy || index === visibleItems.length - 1" :aria-label="`Move ${item.title} down`" @click="move(item.id, 1)">
                        <v-icon small>{{ icons.down }}</v-icon>
                    </v-btn>
                    <v-btn icon small :disabled="busy" :aria-label="`Remove ${item.title} from the plan`" @click="remove(item.id)">
                        <v-icon small>{{ icons.remove }}</v-icon>
                    </v-btn>
                </div>
            </div>
        </div>
        <p v-if="plan.length" class="caption text--secondary mt-2 mb-0">
            A tune is crossed off once it has been heard for {{ minPlayedSeconds }} s (Settings → Sessions) —
            in any setting, or a copy of it under the same name in another database. Tap the circle to mark it yourself; tap again to go back to automatic.
        </p>
    </v-card>
</template>

<script>
import ABCJS from 'abcjs';
import {
    mdiArrowUp, mdiArrowDown, mdiClose, mdiCheckCircle, mdiCheckCircleOutline, mdiCircleOutline,
    mdiCloseCircleOutline, mdiFormatListBulleted, mdiMagnify,
} from '@mdi/js';
import eventBus from '@/eventBus.js';
import store from '@/services/store.js';
import ffBackend from '@/services/backend.js';
import utils from '@/js/utils.js';
import { keyLabel, typeLabel } from '@/js/favouriteFacets.mjs';
import { meterLabel, previewAbc, previewBars, previewRenderOptions } from '@/js/abcPreview.mjs';
import {
    sanitisePlan, planProgress, moveItem, removeItem, setManualDone, nextManualState, DEFAULT_MIN_PLAYED_SECONDS,
} from '@/js/sessionPlan.mjs';

function planMinPlayedSeconds() {
    const value = Number(store.userSettings && store.userSettings.planMinPlayedSeconds);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MIN_PLAYED_SECONDS;
}

// Same bar as the favourites list: below this a preview crowds out the name.
const PREVIEW_MIN_WIDTH = 540;

export default {
    name: 'SessionPlan',
    props: {
        sessionId: { type: String, required: true },
        // The session's tune list as the table shows it: what was played.
        played: { type: Array, default: () => [] },
    },
    data() {
        return {
            plan: [],
            error: '',
            busy: false,
            hidePlayed: false,
            // userSettings is not reactive (see CLAUDE.md), so it is read into
            // data here and on every load.
            minPlayedSeconds: planMinPlayedSeconds(),
            width: 0,
            // tuneId -> aliases, for played tunes (name matching across datasets).
            playedAliases: {},
            // settingID -> setting (with abc), for the previews.
            settings: {},
            icons: {
                up: mdiArrowUp, down: mdiArrowDown, remove: mdiClose, done: mdiCheckCircle,
                autoDone: mdiCheckCircleOutline, todo: mdiCircleOutline, notDone: mdiCloseCircleOutline,
                set: mdiFormatListBulleted,
                search: mdiMagnify,
            },
            filterName: '',
            filterTypes: [],
            filterTags: [],
            // Tags as the user set them in Favourites and Sets — read here,
            // never edited or stored on the plan.
            favTagsBySetting: {},
            favTagsByTune: {},
            setTags: {},
        };
    },
    computed: {
        playedRows() {
            return this.played.map(r => ({
                tuneId: r.selectedTuneId != null ? r.selectedTuneId : r.tuneId,
                title: r.selectedTitle || r.title,
                startSeconds: r.startSeconds,
                endSeconds: r.endSeconds,
                startedAtMs: r.startedAtMs,
            }));
        },
        progress() {
            const aliases = new Map(Object.entries(this.playedAliases));
            return planProgress(this.plan, this.playedRows, aliases, { minPlayedSeconds: this.minPlayedSeconds });
        },
        filtering() {
            return !!(this.filterName && this.filterName.trim()) || this.filterTypes.length > 0 || this.filterTags.length > 0;
        },
        planTags() {
            const tags = new Set();
            for (const item of this.plan) {
                if (item.kind === 'set') {
                    this.setTagsFor(item).forEach(t => tags.add(t));
                    item.tunes.forEach(t => this.tagsFor(t).forEach(x => tags.add(x)));
                } else {
                    this.tagsFor(item).forEach(t => tags.add(t));
                }
            }
            return [...tags].sort((a, b) => a.localeCompare(b));
        },
        planTypes() {
            const types = new Set();
            for (const item of this.plan) {
                for (const t of item.kind === 'set' ? item.tunes : [item]) if (t.type) types.add(t.type);
            }
            return [...types].sort();
        },
        visibleItems() {
            return this.plan.filter(item => {
                if (this.hidePlayed && this.entry(item).done) return false;
                if (!this.filtering) return true;
                return item.kind === 'set' ? this.visibleTunes(item).length > 0 : this.matchesFilter(item, null);
            });
        },
        previewWidth() {
            // Name and type (~200) + state button (~40) + three actions (~110).
            return Math.min(420, Math.max(220, Math.floor((this.width - 350) * 0.6)));
        },
    },
    watch: {
        // For the Plan tab's count.
        progress: {
            immediate: true,
            handler(p) { this.$emit('progress', { done: p.doneCount, total: p.total }); },
        },
        sessionId: { handler() { this.load(); }, immediate: false },
        playedRows: { handler() { this.loadPlayedAliases(); }, immediate: true },
    },
    created() {
        this._onChanged = () => this.load();
        eventBus.$on('liveSessionsChanged', this._onChanged);
        this._onIndex = () => { this.loadPlayedAliases(); this.loadSettings(); };
        eventBus.$on('indexLoaded', this._onIndex);
        this._onTags = () => this.loadTags();
        eventBus.$on('tuneSetsChanged', this._onTags);
        eventBus.$on('syncComplete', this._onTags);
        this.load();
    },
    mounted() {
        const el = this.$el;
        // Small changes are ignored: drawing or dropping the previews can
        // itself move the width (a scrollbar appearing), and answering that
        // inside the same frame is a resize loop — the browser reports
        // "ResizeObserver loop completed with undelivered notifications".
        // Measured a frame later, and only when it really changed.
        const measure = () => {
            const width = Math.round(el.getBoundingClientRect().width);
            if (Math.abs(width - this.width) >= 8 || (width === 0) !== (this.width === 0)) this.width = width;
        };
        measure();
        if (typeof ResizeObserver !== 'undefined') {
            this._resize = new ResizeObserver(() => {
                if (this._resizeFrame) cancelAnimationFrame(this._resizeFrame);
                this._resizeFrame = requestAnimationFrame(() => { this._resizeFrame = null; measure(); });
            });
            this._resize.observe(el);
        }
    },
    beforeDestroy() {
        eventBus.$off('liveSessionsChanged', this._onChanged);
        eventBus.$off('indexLoaded', this._onIndex);
        eventBus.$off('tuneSetsChanged', this._onTags);
        eventBus.$off('syncComplete', this._onTags);
        if (this._resize) this._resize.disconnect();
        if (this._resizeFrame) cancelAnimationFrame(this._resizeFrame);
    },
    methods: {
        displayName: value => utils.parseDisplayableName(value || ''),
        async load() {
            const request = (this._request || 0) + 1;
            this._request = request;
            try {
                const sessions = await store.getLiveSessionsStrict();
                if (request !== this._request) return;
                const record = sessions.find(s => s.id === this.sessionId);
                this.plan = sanitisePlan(record && record.plan);
                this.minPlayedSeconds = planMinPlayedSeconds();
                this.error = '';
                this.loadSettings();
                this.loadTags();
            } catch (e) {
                if (request === this._request) this.error = `Could not read the plan: ${e.message}`;
            }
        },
        // Aliases of what was played, so a planned tune is crossed off by a
        // copy with another id but the same name. Fetched once per tune.
        async loadPlayedAliases() {
            const missing = [...new Set(this.playedRows.map(r => r.tuneId).filter(id => id != null).map(String))]
                .filter(id => !(id in this.playedAliases));
            for (const id of missing) {
                let aliases = [];
                try {
                    const got = await ffBackend.aliasesFromTuneID(id);
                    aliases = Array.isArray(got) ? got : [];
                } catch (e) { aliases = []; }
                // An empty answer (index not loaded yet) is not remembered.
                if (aliases.length) this.playedAliases = { ...this.playedAliases, [id]: aliases };
            }
        },
        async loadTags() {
            try {
                const [favourites, sets] = await Promise.all([store.getFavourites(), store.getTuneSets()]);
                const bySetting = {};
                const byTune = {};
                for (const f of favourites) {
                    const tags = Array.isArray(f.tags) ? f.tags : [];
                    if (!tags.length || !f.result) continue;
                    bySetting[f.result.settingID] = tags;
                    const tuneID = f.result.setting && String(f.result.setting.tune_id);
                    if (tuneID) byTune[tuneID] = [...new Set([...(byTune[tuneID] || []), ...tags])];
                }
                const setTags = {};
                for (const set of sets) if (Array.isArray(set.tags) && set.tags.length) setTags[set.id] = set.tags;
                this.favTagsBySetting = bySetting;
                this.favTagsByTune = byTune;
                this.setTags = setTags;
            } catch (e) { /* tags are a nicety; the plan stands without them */ }
        },
        // The ABC for each previewed setting: from favourites first (works with
        // no index), then the index.
        async loadSettings() {
            const tunes = [];
            for (const item of this.plan) {
                if (item.kind === 'set') tunes.push(...item.tunes);
                else tunes.push(item);
            }
            const wanted = tunes.filter(t => t.settingID != null && !this.settings[t.settingID]);
            if (!wanted.length) return;
            let favourites = [];
            try { favourites = await store.getFavourites(); } catch (e) { favourites = []; }
            const bySetting = new Map(favourites.map(f => [String(f.result.settingID), f.result.setting]));
            const found = {};
            for (const t of wanted) {
                let setting = bySetting.get(String(t.settingID));
                if (!setting && t.tuneID != null) {
                    try {
                        const settings = await ffBackend.settingsFromTuneID(t.tuneID);
                        // The index answers with the settings themselves.
                        setting = Array.isArray(settings) && settings.find(s => String(s.setting_id) === String(t.settingID));
                    } catch (e) { setting = null; }
                }
                if (setting && setting.abc) found[t.settingID] = setting;
            }
            if (Object.keys(found).length) this.settings = { ...this.settings, ...found };
        },
        entry(item) {
            return this.progress.byId.get(item.id) || { done: false, auto: false, manual: null };
        },
        visibleTunes(set) {
            return set.tunes.filter(t => (!this.hidePlayed || !this.entry(t).done) && (!this.filtering || this.matchesFilter(t, set)));
        },
        rowClass(tune) {
            // No "next": the plan is a list to pick from, not a queue — the
            // evening decides the order. Played is all a row says.
            return { played: this.entry(tune).done };
        },
        stateIcon(tune) {
            const e = this.entry(tune);
            if (e.manual === false) return this.icons.notDone;
            if (e.manual === true) return this.icons.done;
            return e.done ? this.icons.autoDone : this.icons.todo;
        },
        stateColor(tune) {
            const e = this.entry(tune);
            if (e.manual === false) return 'warning';
            return e.done ? 'success' : '';
        },
        stateLabel(tune) {
            const e = this.entry(tune);
            const name = tune.title;
            if (e.manual != null) return `${name}: marked ${e.manual ? 'played' : 'not played'} by hand. Tap to go back to automatic.`;
            return e.done ? `${name}: recognised as played. Tap to mark not played.` : `${name}: not played yet. Tap to mark played.`;
        },
        describe(tune) {
            const parts = [];
            if (tune.type) parts.push(typeLabel(tune.type));
            if (tune.mode) parts.push(keyLabel(tune.mode));
            if (tune.meter) parts.push(meterLabel(tune.meter));
            const e = this.entry(tune);
            if (e.done && e.auto && e.playedAt != null) parts.push(`played at ${formatClock(e.playedAt)}`);
            else if (e.manual === true) parts.push('marked played');
            else if (!e.done && e.heardSeconds > 0) parts.push('playing now');
            return parts.join(' · ') || 'Key and type unknown';
        },
        tuneRoute(tune) {
            const query = { tuneID: String(tune.tuneID), displayName: tune.title };
            if (tune.settingID != null) query.settingID = String(tune.settingID);
            return { name: 'tune', query };
        },
        showPreview(tune) {
            return this.width >= PREVIEW_MIN_WIDTH && !!this.settings[tune.settingID];
        },
        previewSvg(tune) {
            const setting = this.settings[tune.settingID];
            if (!setting) return '';
            this._svgCache = this._svgCache || new Map();
            const key = `${tune.settingID}:${this.previewWidth}`;
            if (this._svgCache.has(key)) return this._svgCache.get(key);
            const div = document.createElement('div');
            ABCJS.renderAbc(div, previewAbc(setting, previewBars(this.previewWidth)), previewRenderOptions(this.previewWidth));
            this._svgCache.set(key, div.innerHTML);
            return div.innerHTML;
        },
        async edit(mutate) {
            if (this.busy) return;
            this.busy = true;
            this.error = '';
            try {
                const saved = await store.updateSessionPlan(this.sessionId, mutate);
                this.plan = sanitisePlan(saved.plan);
            } catch (e) {
                this.error = `Could not save the plan: ${e.message}`;
            } finally {
                this.busy = false;
            }
        },
        typeLabel,
        toggleType(type) {
            this.filterTypes = this.filterTypes.includes(type)
                ? this.filterTypes.filter(t => t !== type) : [...this.filterTypes, type];
        },
        toggleTag(tag) {
            this.filterTags = this.filterTags.includes(tag)
                ? this.filterTags.filter(t => t !== tag) : [...this.filterTags, tag];
        },
        tagsFor(tune) {
            return this.favTagsBySetting[tune.settingID] || this.favTagsByTune[tune.tuneID] || [];
        },
        setTagsFor(set) {
            return (set.setID && this.setTags[set.setID]) || [];
        },
        // Tags combine with AND, as in Favourites; a tune in a set carries
        // the set's tags too.
        matchesFilter(tune, set) {
            if (this.filterTypes.length && !this.filterTypes.includes(tune.type)) return false;
            if (this.filterTags.length) {
                const tags = new Set([...this.tagsFor(tune), ...(set ? this.setTagsFor(set) : [])]);
                if (!this.filterTags.every(t => tags.has(t))) return false;
            }
            const q = fold(this.filterName).trim();
            return !q || fold(tune.title).includes(q);
        },
        move(id, delta) { return this.edit(plan => moveItem(plan, id, delta)); },
        remove(id) { return this.edit(plan => removeItem(plan, id)); },
        toggleDone(tune) {
            const value = nextManualState(tune, this.entry(tune));
            return this.edit(plan => setManualDone(plan, tune.id, value));
        },
    },
};

function fold(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function formatClock(seconds) {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}
</script>

<style scoped>
.plan-row {
    display: flex;
    align-items: center;
    padding: 4px 0;
    border-bottom: 1px solid rgba(128, 128, 128, 0.15);
    min-height: 44px;
}
.plan-row.in-set {
    padding-left: 20px;
}
.plan-set-header {
    margin-top: 6px;
    font-weight: 500;
}
.plan-text {
    min-width: 0;
    flex: 0 1 auto;
}
.plan-title {
    font-size: 1rem;
    line-height: 1.3;
    word-break: break-word;
}
.plan-row.played .plan-title,
.plan-row.played .plan-title a {
    text-decoration: line-through;
    opacity: 0.55;
}
.plan-tags {
    line-height: 1;
    margin-top: 2px;
}
.plan-actions {
    display: flex;
    flex: 0 0 auto;
}
.abc-preview {
    flex: 0 0 auto;
    margin-left: 12px;
    overflow: hidden;
}
.plan-row.played .abc-preview {
    opacity: 0.4;
}
</style>
