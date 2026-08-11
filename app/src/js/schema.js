export class HistoryItem {
    constructor(result) {
        this.result = result;
        this.timestamp = Date.now();
    }
}

export class FavouriteItem {
    constructor(result) {
        this.result = result; // { settingID, setting, displayName }
        this.timestamp = Date.now();
        this.tags = []; // string[] — user-defined tags, e.g. ['to practice', 'for tuesday sessions']
        this.tempo = null; // number|null — persisted tempo slider value (% of default)
        // Not set in the constructor: `aiSummary`, an optional
        // { text, model, generatedAt, sourceUrl } record mirrored here by
        // store.setAiSummary purely so it rides the favourites Firestore sync to
        // the user's other devices. The durable copy lives in the
        // 'aiTuneSummaries' IndexedDB key. Like `tags` and `tempo` before it,
        // read it defensively — records stored before 3.9.0 do not have it.
        //
        // Also not set here: `aiSummaryDeletedAt`, a millis tombstone written by
        // store.clearAiSummaries. It exists because a favourite with no
        // `aiSummary` is indistinguishable from one on a device that never
        // generated the note, so deletion cannot be encoded as absence — see
        // _harvestAiSummaries / _reapplyAiSummaries.
    }
}
