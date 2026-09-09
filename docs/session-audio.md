# Recording session audio

An opt-in feature that keeps the audio of a live listening session so it can be
played back afterwards, jumped into at any tune the app recognised, and exported
to a player app. Off by default (Settings → **Session Recording**).

A session is routinely three hours. Everything below follows from that.

## What it is made of

| File | Role |
|---|---|
| `app/src/services/sessionAudioStore.js` | IndexedDB persistence, quota reserve, clip assembly |
| `app/src/services/sessionRecorder.js` | MediaRecorder lifecycle, the audio clock |
| `app/src/components/SessionAudioPlayer.vue` | Transport, timeline strip, export |
| `app/test/sessionAudio.test.mjs` | 52 cases, all mutation-verified |

## The encoder is the platform's, and the container is not our choice

`MediaRecorder` attaches to the same `MediaStream` the analysis pipeline reads,
so recording is genuinely parallel — the ScriptProcessor path in `mic.js` is
untouched, and the encoding runs on the platform's hardware encoder.

Encoding in JavaScript instead (lamejs, a libopus build) would give
sample-exact alignment with the analysis clock, and was rejected: it adds bundle
weight to an app already shipping a 14 MB WASM, and it costs three hours of CPU
and battery to buy an alignment the clock below already achieves.

There is no MP3 anywhere in `MediaRecorder`. `pickMimeType()` prefers
`audio/mp4` (AAC) because that opens in every player app, in iOS Files and in
Music; WebM/Opus plays fine inside the app but is awkward to hand to anything
else. iOS — the target platform — records MP4.

Bitrate is the user's choice, 32–160 kbps, default 64:

| kbps | per hour | 3 h |
|---|---|---|
| 32 | 14 MB | 43 MB |
| 64 | 29 MB | 86 MB |
| 160 | 72 MB | 216 MB |

64 is the default rather than the floor because stored audio makes a session
**re-analysable** later — against a better model, or an index that has since
gained the tune — and below 64 kbps that starts to suffer. `audioBitsPerSecond`
is a hint the encoder may ignore, so what it settled on is read back off the
recorder, in the manner of `micService.appliedAudioSettings`.

## Storage: the user's call, above one reserve that is not

Browsers evict per **origin**. An audio store that fills the quota takes the
offline tune index down with it — the plane incident, arriving from a new
direction. So `headroomBytes()` is free space *minus* `STORAGE_RESERVE_BYTES`
(150 MB), and the recorder spends only what is above it. Everything above the
reserve is the user's to spend; there is no cap and nothing is auto-pruned.

Checked before **every** segment write, not only at the start: a three-hour
recording spends its budget gradually, and the point at which it runs out is
exactly the point where it has to stop cleanly.

When it does run out, **the recording stops and the session carries on.** Audio
is the expendable half. The manifest records `stopped: { reason, message,
atSeconds }` so the player can say "audio covers the first 1 h 47 m" instead of
appearing to have lost it, and the session bar says so at the time — this
codebase has three scars from failures that were invisible for a session.

`headroomBytes()` returns `null`, not `0`, on a browser with no
`storage.estimate()`. Zero would read as "no room" and disable the feature
outright on every such browser; `null` means "cannot tell", and the recorder
proceeds and relies on catching `QuotaExceededError` instead.

## Segments, and why not one file

One 86 MB blob would be held in memory for the whole evening, committed in a
single transaction at exactly the moment the user believes the recording is
safe, and lost entirely to a crash. Worse, it would not be seekable:
MediaRecorder output carries no seek index (WebM has no Cues, Safari's
fragmented MP4 has no top-level index), so a three-hour file you cannot scrub
defeats the point.

So the recording is written in `SEGMENT_SECONDS` (180 s) pieces as they close.
`TIMESLICE_MS` (1000 ms) chunks are the smallest independently-appendable unit,
and each stored segment carries its own chunk offset table.

Keys:

- `sessionAudio:<sessionId>` — the manifest. Tracks (with their init blobs),
  segment metadata, totals, and the stop reason.
- `sessionAudioSeg:<sessionId>:<index>` — one segment: its blob and its chunk
  table.

**Payload first, manifest second**, exactly as `tuneIndexStore.js` does it: the
manifest names only segments already on disk, so an interrupted append reads as
"one segment shorter", never as a manifest pointing at audio that is not there.
The cost is an orphan segment, which `reclaimOrphans()` sweeps up when the
session list or the Settings panel is opened.

A **delete drops the manifest first**, for the same reason from the other
direction: an interrupted delete leaves reclaimable orphans rather than a
half-playable recording the user cannot fix.

## Tracks: why a clip never spans one

A **track** is one continuous `MediaRecorder` run. A session has one per
listening stretch — Pause ends one, Resume starts the next, and so does a
microphone reacquired after the OS handed it to another app. Each carries its
own container header, and two of them concatenated is not a playable file.

So `buildClip()` clips a range to the first track it meets, and whole-session
export is one file per track (the player says so when there is more than one).

The **first chunk of a track carries the header AND its first second of audio**,
so it is stored like any other chunk and marked `init: true`. A clip that
already begins there must not have the init blob prepended as well — writing the
header twice produces a file no decoder will accept. This is the one wart in the
format and it is load-bearing; two tests pin it.

## The audio clock

Detections are stamped with `audioSeconds`, read from `sessionRecorder`. It is
deliberately **not** `liveAnalysis.elapsedSeconds`:

- that is a `setInterval` tick, throttled whenever the tab is occluded, and the
  error accumulates over three hours;
- it keeps counting through a microphone outage during which nothing was
  recorded, so every marker after the outage would be shifted.

The recorder's clock advances only while a track is recording, and is measured
as a single subtraction from that track's origin rather than by accumulating
ticks. Time the recorder did not capture is time the clock did not count, so it
agrees with the recording by construction.

The stamp is taken **when the analysed window's PCM is read**, not after the
transcription returns — a backend call takes seconds, and a stamp taken
afterwards would place every tune that much late in the recording.

It is stamped on the **window match, not the detection**. Detections are rebuilt
from those matches on every cycle and their ids are not stable, so anything
recorded against a detection is gone within seconds — the same lesson as
corrections.

`clusterDetections()` then derives `audioStartSeconds` / `audioEndSeconds`
mirroring `startSeconds` / `endSeconds`. A collapsed row keeps the **earliest**
known start and the **latest** known end, unlike the displayed time column which
advances to the most recent cluster: "play this tune" means play it from the
start, and keeping the earliest offset is also what keeps a row playable when
only part of it was recorded.

## Playback

Segments are separate files, so the player walks them: load segment → seek →
on `ended`, load the next. Blob URLs load locally so the join is short, but it
is not gapless.

The one genuinely tricky part is **where a clip's timeline starts**. A clip cut
from mid-stream may keep its original timestamps or be rebased to zero, and
which happens differs between containers and browsers. Rather than assume, the
player reads `audio.seekable.start(0)` after `loadedmetadata` and seeks to
`base + (target - segmentStart)`, which is correct under both behaviours.

If a browser refuses to seek inside a segment at all, the worst case is bounded
by `SEGMENT_SECONDS`: the ▶ lands up to three minutes early, rather than
anywhere in a three-hour file.

`PLAY_PREROLL_SECONDS` (12 s) is why ▶ does not land mid-tune. A cluster's start
is the moment the *first matching window ended*, so the tune has already been
playing for at least a window by then; seeking to the bare offset reliably lands
past the opening phrase, which reads as a bug even though the detector is
working exactly as designed.

## Privacy

Three hours of a pub records the conversations of everyone in it.

- Off by default, and a **REC chip in the session bar** wherever the user
  navigates — the bar exists precisely because a session outlives the page that
  started it.
- **Local-only.** Nothing here is synced. `sync.js` never sees it, and the
  session record carries no "has audio" flag — on another device that would be a
  lie.
- **Not in backups.** `exportUserData` is untouched. A backup stays small, and a
  file people share does not carry three hours of a room.
- Deleted with the session it belongs to, from every delete path, because that
  is done in `store.deleteLiveSession()` rather than at the call sites.

## Known limitations

- **A web app stops running when the phone locks**, so recording pauses with
  detection. Settings says so. This is pre-existing for live sessions; the
  feature makes it acute.
- Turning the setting on mid-session takes effect at the next Resume.
- Whole-session export is one file per track. Remuxing several tracks into one
  file would need a muxer this repo does not have.
- **Not yet measured on a real device**: which container iOS records, whether
  `[init, ...midChunks]` plays standalone there, and whether an 86 MB
  `navigator.share` is accepted. The player degrades rather than breaks in each
  case, but these are the three things to check first.
