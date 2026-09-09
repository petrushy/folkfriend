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

### Where ▶ starts

`audioStartSeconds` is the moment the *first matching window ended*, so the
audio that produced the match runs from a window earlier. Seeking to the bare
offset lands past the opening; the first attempt at fixing that subtracted a
fixed 12 s, which on a device turned out to start roughly **two seconds before
the analysed window had even opened**.

So each detection carries its own **`audioAnchorSeconds`**, computed when it is
clustered:

```text
audioAnchorSeconds = audioStartSeconds − windowSeconds / 2
```

The window's midpoint is the one place the tune is certainly playing: its
*start* can still be the tune before it, and anything earlier is audio the
detector never saw. It can clip an opening phrase, which is the right trade for
confirming a detection quickly.

It is computed at detection time and **persisted with the tune**, because the
right distance back depends on the window the session was analysed with — a
constant applied at playback is wrong as soon as that setting changes, and
cannot be recovered for a session already saved. Records written before anchors
existed fall back to half the 10 s default window, which is what the anchor
works out to for anything recorded at that setting.

The anchor is still clamped into the tune's own recorded stretch, so a long
window cannot seek back across a hole in the recording.

## Muting: recording without recording the conversation

Three hours in a pub is not three hours of tunes. Between sets there are
conversations that nobody agreed to have recorded, and the useful control there
is not "stop the session" — the user still wants the tunes that follow
identified. So **Mute audio** silences what is RECORDED while leaving capture,
and therefore detection, entirely alone.

### The mechanism: a cloned track

`MediaStreamTrack.clone()` produces a track that shares the microphone but
carries **its own `enabled` flag**, and a disabled audio track emits silence by
spec. So `mic.js` opens a second, cloned stream next to the capture one:

```text
getUserMedia ─┬─ original track → AudioContext → ScriptProcessor → detection
              └─ clone          → MediaStream  → MediaRecorder    → recording
                                   ▲ enabled = false silences ONLY this branch
```

The obvious implementations are all wrong in the same way: disabling the capture
track, stopping it, or pausing the microphone silences the ScriptProcessor too,
so the tune list quietly stops growing while the app still says "Listening".
`mic.test.mjs` asserts on the two tracks *separately*, and its fake models a
disabled track as emitting silence — without that the fake happily delivers
audio through a muted capture and the test passes against exactly that bug.

A `GainNode` between the source and a `MediaStreamAudioDestinationNode` would
also work and would allow a delay line (useful for an automatic music/speech
gate, which this is not). It was not used: recording from a destination node is
a different, historically flaky path through WebKit, and a manual control needs
no lookbehind because the user decides in advance.

### Silence is recorded, not skipped

Muting does **not** stop the recorder. Skipping the audio would compress the
timeline, and every tune offset after a mute would point at the wrong moment;
recording silence keeps the recording 1:1 with the evening, and compressed
silence costs almost nothing. The audio clock runs straight through.

Muted stretches are written to the manifest as `mutedRanges`, and the player
hatches them on the timeline strip. Seeking to a tune and getting silence with
no explanation is indistinguishable from a bug, and tunes detected during a mute
are still listed — detection never stopped.

### Rules that are not obvious

- **A mute survives a microphone rebuild and a reload.** A recovery that
  silently un-muted would record something the user believes is private, and
  they would never find out; that is the one unrecoverable failure this control
  can produce. A *new* session starts unmuted, though — a resumed session has
  the muted counter on screen, while a new one has nothing connecting it to a
  button pressed hours ago.
- **An open range is closed when the session ends**, or the player would grey
  out everything after it for ever.
- **The elapsed muted time is on screen.** A mute the user forgot is how a
  manual control loses an evening, and a running counter is the only defence.
- **A browser that cannot clone loses the CONTROL, not the recording.**
  `setMuted()` returns the state actually reached, and the bar hides the button
  rather than offering one that silently does nothing.

### What this is not

It is not a privacy guarantee, and the UI does not claim one. Talking over the
tunes is recorded, because there is no separating them. Automatic music/speech
detection was considered and deliberately not built: the literature's ~98% is on
broadcast radio, a pub is far worse, and the two error directions trade the
user's recording against their privacy with no setting that satisfies both. A
manual control has perfect precision when used, and the honest framing is that
it covers the conversation you *notice* wanting to keep.

## The mute button

An automatic music/speech classifier was considered and rejected for now: the
error rate in a pub is real in both directions, and the two errors are not
symmetric — muting real music costs the user the recording they asked for. A
**manual mute** has none of that risk and perfect precision when used.

The mechanism is `MediaStreamTrack.clone()`. A cloned track shares the
microphone but carries its **own `enabled` flag**, and a disabled audio track
emits silence by spec. So `mic.js` records from a clone and the analysis graph
reads the original:

```text
getUserMedia track ─┬─ original → AudioContext → ScriptProcessor → detection
                    └─ clone    → MediaStream  → MediaRecorder    (enabled=false to mute)
```

**Detection carries on through a mute.** That is the whole point: the user is
silencing the recording of a conversation, not asking the app to stop
identifying tunes. Muting the capture track instead would stop the tune list
dead.

This was chosen over the two obvious alternatives:

- **A `GainNode` into a `MediaStreamAudioDestinationNode`** would work, and
  would also allow a delay line for a future classifier — but it routes the
  recorded audio through the Web Audio graph, which is a different and
  historically flakier path through WebKit. Cloning needs no graph at all.
- **Stopping the recorder** removes the audio rather than silencing it, which
  compresses the timeline. Keeping the recorder running means the audio clock
  is unaffected and every tune offset after a mute still points at the right
  moment. Silence also costs almost nothing to encode.

Four rules, each mutation-verified:

1. **The recording keeps running while muted.** The timeline stays 1:1 with the
   evening.
2. **A microphone reacquired while muted comes back MUTED**, and so does a
   session resumed after a reload while a muted range was still open. The two
   errors are not symmetric: silently un-muting records something the user
   believes is private and cannot be undone, while staying muted loses audio
   the user can see is being lost — the bar shows the muted state and a running
   counter.
3. **A NEW session starts recording**, whatever the last one was doing. Not a
   contradiction of (2): a resumed session is visibly the same one, with the
   counter on screen, whereas a new session has nothing connecting it to a
   button pressed hours earlier.
4. **Mute reports failure rather than pretending.** On a browser with no
   `MediaStreamTrack.clone()` the control is not offered, and `recordingMuted`
   reads false — a bar claiming the room is not being recorded while it is
   would be the worst thing this control could do.

Muted stretches are stored in the manifest as `mutedRanges` and drawn as hatched
bands on the player's timeline, because seeking to a tune and getting
unexplained silence is indistinguishable from a bug. An open range is closed at
`end()`, or it would grey out everything after it for ever.

## Privacy

Three hours of a pub records the conversations of everyone in it.

- Off by default, and a **REC chip in the session bar** wherever the user
  navigates — the bar exists precisely because a session outlives the page that
  started it. The chip shows the MUTED state too, with the elapsed muted time:
  that is the claim the user most needs to be able to check at a glance.
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
- Muting is manual. There is no automatic gate on music vs speech — see above
  for why that was rejected rather than deferred.
- Whole-session export is one file per track. Remuxing several tracks into one
  file would need a muxer this repo does not have.
- **Not yet measured on a real device**: which container iOS records, whether
  `[init, ...midChunks]` plays standalone there, and whether an 86 MB
  `navigator.share` is accepted. The player degrades rather than breaks in each
  case, but these are the three things to check first.
