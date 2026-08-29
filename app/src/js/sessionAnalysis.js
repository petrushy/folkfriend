import utils from '@/js/utils.js';
import { settingSourceUrl } from '@/js/source.mjs';

const DEFAULT_OPTIONS = {
    windowSeconds: 10,
    minTopScore: 0.56,
    minClusterHits: 2,
    minContourLength: 12,
    minRms: 0.008,
    maxAlternatives: 3,
};

export function getAnalysisOptions(durationSeconds) {
    const options = { ...DEFAULT_OPTIONS };

    // Step size trades off scan density against processing time.
    // Shorter recordings get a finer scan; very long ones coarsen it to keep
    // the total window count reasonable (~600 windows at most).
    // Rule of thumb: a tune must fall inside at least 2 windows to survive
    // the minClusterHits filter, so step <= windowSeconds is ideal — but for
    // long recordings we accept stepSeconds == windowSeconds (no overlap) and
    // rely on the strongScore single-hit fallback in clusterDetections.
    if (durationSeconds < 300) {
        options.stepSeconds = 5;        // < 5 min: dense scan
    } else if (durationSeconds < 7200) {
        options.stepSeconds = 10;       // 5 min – 2 h: standard session
    } else {
        options.stepSeconds = 15;       // > 2 h: coarser scan to stay fast
    }

    options.mergeGapSeconds = options.windowSeconds;
    return options;
}

// A tune that was only ever heard for a few seconds is almost always a
// one-window fluke rather than something that was played: at the live defaults
// (10 s window, 5 s step) a single spurious match spans 10 s and two
// consecutive ones span 15 s, so this threshold is what separates "the room
// briefly sounded like this" from "this was played".
export const MIN_PAST_DETECTION_SECONDS = 15;

/**
 * Drops short-lived detections from the *past* part of the list.
 *
 * The last entry is always kept, whatever its duration: it is the tune being
 * played right now, and it necessarily starts short. Dropping it would make a
 * newly started tune invisible for its first fifteen seconds — and the live
 * follow overlay reads exactly that entry to decide what to display.
 *
 * Display-only: the underlying window matches are untouched, so a detection
 * dropped here reappears on its own once it has accumulated enough span.
 *
 * @param {Array} detections - clustered detections, oldest first
 * @param {number} [minSeconds]
 */
export function filterShortPastDetections(detections, minSeconds = MIN_PAST_DETECTION_SECONDS) {
    if (!detections || detections.length <= 1) return detections || [];
    const lastIndex = detections.length - 1;
    return detections.filter((detection, index) =>
        index === lastIndex ||
        (detection.endSeconds - detection.startSeconds) >= minSeconds
    );
}

export function rmsOfSignal(signal) {
    if (!signal || signal.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < signal.length; i++) {
        sum += signal[i] * signal[i];
    }
    return Math.sqrt(sum / signal.length);
}

export function formatSecondsAsClock(totalSeconds) {
    const safe = Math.max(0, totalSeconds);
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const seconds = safe % 60;
    const secondText = seconds.toFixed(1).padStart(4, '0');
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${secondText.padStart(4, '0')}`;
    }
    return `${minutes}:${secondText.padStart(4, '0')}`;
}

export function formatSecondsAsDuration(totalSeconds) {
    const safe = Math.max(0, Math.round(totalSeconds));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const seconds = safe % 60;
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function formatSecondsAsXscTime(totalSeconds) {
    const safe = Math.max(0, totalSeconds);
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const seconds = safe % 60;
    return `${hours}:${String(minutes).padStart(2, '0')}:${seconds.toFixed(6).padStart(9, '0')}`;
}

export function parseClockTime(text) {
    if (!text) return Number.NaN;
    const trimmed = text.trim();
    const match = trimmed.match(/^(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)$/);
    if (!match) return Number.NaN;
    const hours = Number(match[1] || 0);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    if (Number.isNaN(hours) || Number.isNaN(minutes) || Number.isNaN(seconds)) {
        return Number.NaN;
    }
    return hours * 3600 + minutes * 60 + seconds;
}

function sanitizeMarkerTitle(title) {
    const cleaned = (title || 'Unknown Tune')
        .replace(/,/g, ' -')
        .replace(/\s+/g, ' ')
        .trim();
    return cleaned.slice(0, 96) || 'Unknown Tune';
}

export function parseXscMetadata(xscText) {
    const normalized = xscText.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');
    const soundFileLine = lines.find(line => line.startsWith('SoundFileName,'));
    let linkedAudioFileName = '';

    if (soundFileLine) {
        const parts = soundFileLine.split(',');
        linkedAudioFileName = parts[1] || '';
    }

    return {
        linkedAudioFileName,
    };
}

export function buildUpdatedXsc(xscText, detections) {
    const newline = xscText.includes('\r\n') ? '\r\n' : '\n';
    const normalized = xscText.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');
    const markerSection = [
        'SectionStart,Markers',
        `Howmany,${detections.length}`,
        ...detections.map(detection =>
            `S,-1,0,${sanitizeMarkerTitle(detection.title)},0,${formatSecondsAsXscTime(detection.startSeconds)},`
        ),
        'SectionEnd,Markers',
    ];

    let startIndex = -1;
    let endIndex = -1;

    for (let i = 0; i < lines.length; i++) {
        if (lines[i] === 'SectionStart,Markers') {
            startIndex = i;
        }
        if (startIndex !== -1 && lines[i] === 'SectionEnd,Markers') {
            endIndex = i;
            break;
        }
    }

    let outputLines;
    if (startIndex !== -1 && endIndex !== -1) {
        outputLines = [
            ...lines.slice(0, startIndex),
            ...markerSection,
            ...lines.slice(endIndex + 1),
        ];
    } else {
        const insertBefore = lines.findIndex(line => line === 'SectionStart,TextBlocks');
        if (insertBefore === -1) {
            outputLines = [...lines, ...markerSection];
        } else {
            outputLines = [
                ...lines.slice(0, insertBefore),
                ...markerSection,
                ...lines.slice(insertBefore),
            ];
        }
    }

    return outputLines.join(newline);
}

export function buildTuneListText(detections) {
    return detections
        .map(detection => {
            const url = settingSourceUrl({
                tuneID: detection.tuneId,
                settingID: detection.settingId,
                displayName: detection.title,
                sourceUrl: detection.sourceUrl || '',
                dataset: detection.dataset || '',
            });
            const safe = Math.max(0, Math.round(detection.durationSeconds));
            const duration = `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
            return `${detection.title} (${detection.bestScore.toFixed(2)}) ${duration}, ${url}`;
        })
        .join('\n');
}

export function tuneOptionValue(option) {
    return `${option.settingId || 'none'}::${option.tuneId || 'unknown'}::${option.title}`;
}

// Selectable candidates for one detection: its own best match first, then the
// merged alternatives, deduplicated by option value.
export function buildTuneOptions(detection) {
    const options = [];
    const seen = new Set();
    const candidates = [
        {
            tuneId: detection.tuneId,
            settingId: detection.settingId,
            sourceUrl: detection.sourceUrl || '',
            dataset: detection.dataset || '',
            title: detection.title,
            score: detection.bestScore,
        },
        ...(detection.alternatives || []),
    ];

    for (const candidate of candidates) {
        const value = tuneOptionValue(candidate);
        if (seen.has(value)) continue;
        seen.add(value);
        options.push({
            value,
            tuneId: candidate.tuneId,
            settingId: candidate.settingId ? String(candidate.settingId) : '',
            sourceUrl: candidate.sourceUrl || '',
            dataset: candidate.dataset || '',
            title: candidate.title,
            score: candidate.score,
            text: `${candidate.title} (${candidate.score.toFixed(2)})`,
        });
    }

    return options;
}

function mergeAlternatives(...alternativeLists) {
    const byTuneId = new Map();
    for (const alternatives of alternativeLists) {
        for (const alternative of alternatives || []) {
            const key = String(alternative.settingId || `${alternative.tuneId || alternative.title}`);
            const existing = byTuneId.get(key);
            if (!existing || alternative.score > existing.score) {
                byTuneId.set(key, { ...alternative });
            }
        }
    }
    return Array.from(byTuneId.values()).sort((a, b) => b.score - a.score);
}

function mergeAdjacentDetections(detections, options) {
    if (!detections.length) return [];

    const merged = [];

    for (const detection of detections) {
        const previous = merged[merged.length - 1];
        const gapSeconds = previous ? detection.startSeconds - previous.endSeconds : Number.POSITIVE_INFINITY;
        const shouldMerge = previous &&
            previous.tuneId === detection.tuneId &&
            gapSeconds <= options.mergeGapSeconds;

        if (!shouldMerge) {
            merged.push({ ...detection });
            continue;
        }

        previous.endSeconds = Math.max(previous.endSeconds, detection.endSeconds);
        previous.hits += detection.hits;
        previous.bestScore = Math.max(previous.bestScore, detection.bestScore);
        previous.averageScore = (previous.averageScore + detection.averageScore) / 2;
        previous.alternatives = mergeAlternatives(previous.alternatives, detection.alternatives);
        previous.id = `${previous.id}-m`;
    }

    return merged;
}

export function clusterDetections(windowMatches, options) {
    if (!windowMatches.length) return [];

    const sorted = [...windowMatches].sort((a, b) => a.startSeconds - b.startSeconds);
    const clusters = [];

    for (const match of sorted) {
        const lastCluster = clusters[clusters.length - 1];
        const canExtend = lastCluster &&
            lastCluster.tuneId === match.tuneId &&
            match.startSeconds - lastCluster.lastWindowStart <= options.stepSeconds * 1.6;

        if (!canExtend) {
            clusters.push({
                tuneId: match.tuneId,
                hits: [match],
                firstWindowStart: match.startSeconds,
                lastWindowStart: match.startSeconds,
            });
            continue;
        }

        lastCluster.hits.push(match);
        lastCluster.lastWindowStart = match.startSeconds;
    }

    const clustered = clusters
        .map((cluster, index) => {
            const bestHit = cluster.hits.reduce((best, hit) => hit.score > best.score ? hit : best, cluster.hits[0]);
            const averageScore = cluster.hits.reduce((sum, hit) => sum + hit.score, 0) / cluster.hits.length;
            return {
                id: `${cluster.tuneId}-${index}-${Math.round(cluster.firstWindowStart)}`,
                tuneId: cluster.tuneId,
                settingId: bestHit.settingId,
                sourceUrl: bestHit.sourceUrl || '',
                dataset: bestHit.dataset || '',
                title: bestHit.displayName,
                startSeconds: cluster.firstWindowStart,
                endSeconds: cluster.lastWindowStart + options.windowSeconds,
                bestScore: bestHit.score,
                averageScore,
                hits: cluster.hits.length,
                alternatives: mergeAlternatives(...cluster.hits.map(hit => hit.alternatives || [])),
            };
        })
        // Keep clusters with multiple hits (robust) or a single hit that
        // cleared the entry score threshold — short tunes can legitimately
        // appear in only one window when step >= window.
        .filter(cluster => cluster.hits >= options.minClusterHits || cluster.bestScore >= options.minTopScore)
        .sort((a, b) => a.startSeconds - b.startSeconds);

    return mergeAdjacentDetections(clustered, options);
}

export function normaliseQueryResults(results, options) {
    if (!results || !results.length) return null;
    const best = results[0];
    if (!best.setting || !best.setting.tune_id || best.score < options.minTopScore) {
        return null;
    }

    const alternatives = results
        .slice(0, options.maxAlternatives)
        .map(result => ({
            tuneId: result.setting ? result.setting.tune_id : null,
            settingId: result.setting_id != null ? String(result.setting_id) : '',
            sourceUrl: result.setting ? (result.setting.source_url || '') : '',
            dataset: result.setting ? (result.setting.dataset || '') : '',
            title: utils.parseDisplayableName(result.display_name || 'Unknown tune'),
            score: result.score || 0,
        }));

    return {
        tuneId: best.setting.tune_id,
        settingId: best.setting_id != null ? String(best.setting_id) : '',
        sourceUrl: best.setting ? (best.setting.source_url || '') : '',
        dataset: best.setting ? (best.setting.dataset || '') : '',
        displayName: utils.parseDisplayableName(best.display_name),
        score: best.score,
        alternatives,
    };
}
