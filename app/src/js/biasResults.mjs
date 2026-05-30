// Promotes previousTuneId to results[0] when it's within delta of the current top.
// Returns a new array; never mutates input. No-op when previousTuneId is null,
// not in results, or trailing by more than delta.
export function biasResultsTowardPrevious(results, previousTuneId, delta) {
    if (!previousTuneId || !results || results.length === 0) return results;
    const top = results[0];
    if (top && top.setting && top.setting.tune_id === previousTuneId) return results;
    const idx = results.findIndex(r => r && r.setting && r.setting.tune_id === previousTuneId);
    if (idx <= 0) return results;
    if (results[idx].score < top.score - delta) return results;
    const promoted = results[idx];
    const rest = results.filter((_, i) => i !== idx);
    return [promoted, ...rest];
}
