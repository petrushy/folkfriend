export function repetitionsFor(entry) {
    const count = entry.repetitions === undefined ? 2 : entry.repetitions;
    if (!Number.isInteger(count) || count < 1 || count > 99) throw new Error('Times played must be a whole number from 1 to 99.');
    return count;
}

// Native synth completion drives the sequence: no duration timers or index
// search. Cache only the current and next tune; reuse each buffer for repeats.
export class SetMidiPlayer {
    constructor({ entries, prepare, onState = () => {} }) {
        this.entries = entries;
        this.prepare = prepare;
        this.onState = onState;
        this.generation = 0;
        this.turn = 0;
        this.cache = new Map(); this.handles = new Map();
        this.status = 'idle'; this.index = 0; this.repetition = 1; this.current = null;
    }
    state(error = '') {
        return { status: this.status, index: this.index, repetition: this.repetition,
            repetitions: this.entries[this.index] ? repetitionsFor(this.entries[this.index]) : 0, error };
    }
    emit(error = '') { this.onState(this.state(error)); }
    get(index, generation) {
        if (!this.cache.has(index)) {
            const task = Promise.resolve().then(() => generation === this.generation ? this.prepare(index) : null).then(handle => {
                if (!handle) return null;
                if (generation !== this.generation) { handle.dispose(); return null; }
                this.handles.set(index, handle);
                return handle;
            });
            task.catch(() => {}); // prefetch failures are reported when reached
            this.cache.set(index, task);
        }
        return this.cache.get(index);
    }
    async start() {
        this.stop(false);
        this.entries.forEach(repetitionsFor);
        if (!this.entries.length) return;
        this.index = 0; this.repetition = 1;
        const generation = this.generation;
        await this.play(generation);
    }
    async play(generation) {
        if (generation !== this.generation) return;
        this.status = 'preparing'; this.emit();
        try {
            const handle = await this.get(this.index, generation);
            if (generation !== this.generation || !handle) return;
            this.current = handle;
            const turn = ++this.turn;
            handle.start(() => this.ended(generation, turn));
            this.status = 'playing'; this.emit();
            if (this.index + 1 < this.entries.length) this.get(this.index + 1, generation);
        } catch (e) {
            if (generation !== this.generation) return;
            const message = `Tune ${this.index + 1}: ${e.message || 'Could not play this tune.'}`;
            this.stop(false); this.status = 'error'; this.emit(message);
        }
    }
    ended(generation, turn) {
        if (generation !== this.generation || turn !== this.turn || this.status !== 'playing') return;
        this.turn++;
        if (this.repetition < repetitionsFor(this.entries[this.index])) this.repetition++;
        else {
            this.current.dispose(); this.current = null; this.cache.delete(this.index); this.handles.delete(this.index);
            this.index++; this.repetition = 1;
            if (this.index === this.entries.length) {
                this.status = 'complete'; this.emit(); return;
            }
        }
        this.play(generation);
    }
    pause() {
        if (this.status !== 'playing') return;
        this.current.pause(); this.status = 'paused'; this.emit();
    }
    resume() {
        if (this.status !== 'paused') return;
        const generation = this.generation;
        const turn = ++this.turn;
        this.current.resume(() => this.ended(generation, turn));
        this.status = 'playing'; this.emit();
    }
    stop(notify = true) {
        this.generation++; this.turn++;
        // Already prepared handles stop synchronously; pending ones dispose
        // themselves when they complete with an obsolete generation.
        for (const handle of this.handles.values()) handle.dispose();
        this.handles.clear();
        this.current = null;
        this.cache.clear(); this.status = 'idle';
        if (notify) this.emit();
    }
    progress() { return this.status === 'playing' && this.current ? this.current.progress() : null; }
}
