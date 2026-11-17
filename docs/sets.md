# Sets

Sets live at `/sets`, independently of Favorite Tunes (`/favourites`, whose URL
and stored data remain compatible). Each arrangement has its own identity,
name, tags, notes and ordered entries. Duplicate creates a separate draft;
changes to it do not affect the original. Empty and one-tune drafts are allowed.
The typical musical set is 2–8 tunes; the storage safety limit is 100 entries.

Entries retain their selected `settingID` and full setting, including ABC, key
(`mode`), and tune type (`dance`). Different settings of a tune, and deliberate
repeats, are allowed. Entry IDs identify occurrences, not tunes. Scores and
playback work from these snapshots without the tune database. Search puts starred settings first, followed by other settings of favorite tunes,
then remaining matches in database relevance order. Matching saved favorites are
also available when their database is unavailable. Set tags are independent of tune tags.

Opened from the set editor, the “Often played with” list offers “Add to set” on
every suggested tune: choose its key/setting (starred settings first); it
defaults to the current draft and inserts after the starting tune, without
navigating away or saving unfinished edits. Opened anywhere else (Tune view,
live view) the list is for reading only and has no Add to set button.

Favorite Tunes also offers an “Add to set” icon on every row. Selecting tunes
reveals an “Add to set” button beside the selection controls. The destination
dialog uses the exact saved settings and lets a selected group be reordered
before appending it to an existing or new set. This works offline and leaves
the favourites untouched.

### Adding from outside the editor

Search results (name and audio), Favorite Tunes and the Tune page all open the
same dialog. It lists the sets that already contain the exact setting (each
opens that set), and no set is preselected: a single tap must never add to
whichever set was touched last (with no sets yet, “Create a new set…” is the
only choice). Choosing a set that already holds the setting shows a warning;
adding again is still allowed, since repeats are legitimate. After adding you
stay where you are, and the confirmation offers **Open set**. Opened from the
set editor, the only destination is the draft being edited.

## Browsing and editing

The set list uses compact rows with the first tune's score on the right when
there is room, engraved only near the viewport. Use the same tag-plus icon as
Favorite Tunes to tag a set; tag chips above the list filter with AND semantics.
A row's overflow menu contains View scores, Edit set, Duplicate and Delete.

Clicking a set opens its own URL (`/sets?setID=…`) and all saved scores in order
on one scrollable page. Viewing never opens an editable draft. Edit set opens
the arrangement editor at its own URL (`?setID=…&edit=1`, or `?edit=new` for a
new or duplicated set), so Back — including the iPhone back-swipe — returns to
where editing started, after confirming any unsaved changes. Saving lands on
the set's score view and does not leave the editor in the history. Reloading an
`edit=1` URL reopens the editor from the stored set; an unsaved `edit=new`
draft cannot survive a reload and falls back to the list. During editing, the
top toolbar shows Save set and Cancel in place of New set and remains visible
while scrolling through search results. Unsaved edits remain
protected when navigating between set URLs as well as away from the page.

Favorite Tunes rows show clickable name-only membership chips, matched by exact
settingID. On the Tune page each setting has one set button beside its star,
shown on the same rule as the star (expanded, or already in a set): its menu
lists the containing sets, which open the complete set score view, and “Add to
a set…” for that exact setting. Set snapshots
also supply the tune page's offline fallback independently of Favorite Tunes.

## Following a performance

In the full score view, Follow my playing uses the existing practice microphone
and staff-line tracker. It highlights the current row and scrolls through the
complete arrangement **without any tapping**: playing with a whistle or fiddle
leaves no hand free. Every analysed window (10 s, every 4 s) is compared with
every saved tune in the set, so moving on, skipping a tune or going back to an
earlier one is followed by itself. It moves when one tune scores at least
**0.5** and beats every other tune by **0.15**, on a single window; anything
less ambiguous holds the current tune, so repeats and shared phrases stay put.
Next tune remains only for identical occurrences (the same setting twice in a
row), which audio cannot tell apart. Entry identity is kept separate from
setting identity.

**These numbers are measured.** `app/test/bench/replaySetFollow.mjs` replays
simulated sessions — real thesession tunes rendered with wrong notes, tempo
drift and room noise, transcribed by the real DSP — through the follower. The
earlier rule (0.8 on two windows) was hardly ever met by real transcriptions:

| 160 sessions, 320 tune changes | old: 0.8 × 2 windows | now: 0.5 × 1 window |
|---|---|---|
| set holds the setting played: never followed | 16 % normal / 80 % noisy | 0 % / 0 % |
| set holds a different same-key setting: never followed | 61 % / 89 % | 11 % / 17 % |
| median time to move after the tune changes | ~12 s | ~6–7 s |
| time on a tune not being played (unplayed same-type, same-key tune after every played one) | 0 % | 0 % |

The margin is what keeps it honest: the best of five unplayed same-key tunes
scores 0.09 at the median and 0.38 at the 99th percentile. To re-measure:

```sh
cd rust && cargo build --release --example detect_sim
DETECT_SIM_CONTOURS=1 ./target/release/examples/detect_sim ../app/public/res/thesession.json 80 11 > /tmp/setsim.jsonl
node ../app/test/bench/replaySetFollow.mjs /tmp/setsim.jsonl
```

⚠️ Synthetic audio says nothing absolute about a real whistle in a real room;
it compares rules fairly. A setting stored very differently from how it is
played (about one change in nine to seven) is still not followed and needs Next
tune.

The line shown follows the shared score tracker (see CLAUDE.md, "Measured on
transcriber output, and an octave fix"): semitone-tolerant and octave-invariant
matching, floors set to what the right tune actually scores.

### Save the run for diagnosis

A checkbox beside Follow my playing (remembered per device) records the run:
the microphone at reduced quality plus a log of every analysed window, what was
shown, Next-tune taps and manual scrolls. After stopping, **Share diagnosis**
sends a WAV and a JSON file through the share sheet (download on desktop). It
is kept only until leaving the set, and nothing is uploaded anywhere.

```sh
node app/test/bench/replayFollowCapture.mjs follow_x.json [--truth truth.json]
cd rust && ./target/release/examples/detect_sim --wav follow_x.wav > w.jsonl   # re-transcribe
node ../app/test/bench/replayFollowCapture.mjs follow_x.json --windows w.jsonl
```

`truth.json` is `[{ "entry": 0, "start": 0 }, { "entry": 1, "start": 52.5 }]`:
which set entry was being played from when, in seconds of the WAV.

Auto-scroll can be switched off independently. Touch/wheel browsing holds it
for eight seconds; Resume scrolling restores it immediately. Editing, changing
the scores, leaving the set, or stopping Follow clears marks and releases the
practice microphone if it owns it. A live session retains its own microphone.
Starting Follow stops score playback and hides playback controls while listening.
No tune index is needed: stored contours and scores are used locally. Missing
contours are reported instead of pretending to track them. Instrument shift
changes written notation, not the pitch expected from the saved setting.

The transition thresholds have deterministic matching tests; live playing
accuracy still needs validation on instruments, phrasing and device conditions.
The browser suite uses a fake microphone for capture and scrolling by default
(`FF_FOLLOW_TEST=0` skips those checks). To include real tune-database search, run:
`APP_URL=http://localhost:3000 FF_REAL_SEARCH=1 FF_FOLLOW_TEST=1 node app/test/e2e/sets.mjs`.

## Whole-set synthesized playback

Each entry stores `repetitions` (1–99), defaulting to 2 for new and older sets.
“Times played” counts complete runs through that tune, including repeats already
written in its ABC. These counts persist through duplication, sync and backups.
Play set runs the tunes in order, with pause/resume, stop and a playback-speed
control. One AudioContext and at most the current/next primed audio buffers are
used; repeating a tune reuses its buffer. Native audio completion, rather than
estimated timers, advances the sequence. MIDI note highlighting and optional
row scrolling track the audio clock. Stopping, editing, navigating away, starting
Follow or another score player cancels the playlist and stale preparation.

The set interface uses a consistent sans-serif hierarchy and a reading-width
score column rather than stretching scores across wide screens. Tune titles
are clickable; there are no per-tune Follow or Open tune buttons. The editor
search is clearable. Search-result rows offer Add to set; the destination dialog
links both numbered tune names and the selected existing set name to their views.

## Persistence and sync

IndexedDB `tuneSets` is the local source. All set writes and inbound merges use
the same serial mutation chain. A failed read or write rejects visibly rather
than replacing stored sets with an empty list. Draft edits are explicit saves,
with navigation/unload protection. Saving or deleting an out-of-date open draft
is refused, leaving the draft available for copying or reopening.

Signed-in sets sync as private documents at `users/{uid}/tuneSets/{id}`. Every
edit has a monotone `updatedAt`; deletes retain versioned tombstones locally and
remotely. Server snapshots reconcile the union and push newer local copies,
including offline edits and tombstones. Security rules reject writes older than
the stored document. A remote set that fails validation is skipped and reported; it never blocks the
rest of the snapshot. Concurrent offline edits to the same set resolve to the
newest version of the whole set; they do not merge individual tune moves. Equal
versions resolve deterministically using canonical map ordering. As with other
app records, timestamp ordering depends on device clocks.

User-data exports are version 6 and include sets and tombstones. Versions 1–5
remain importable. Missing set data leaves sets alone; importing sets merges
by ID, retaining arrangements absent from the backup. Restored copies are
stamped as new edits and sync when signed in. Set snapshots are capped below
Firestore's document size limit; save failures retain the draft.

## Release and validation

Deploy `app/firestore.rules` with this feature so the new collection is accepted.
The PR itself does not deploy production rules or the app.

- `cd app && npm test`
- `cd app && npm run test:rules` (Firebase CLI and Java 21+)
- `cd app && npm run build`
- With the app served on localhost:3000: `node app/test/e2e/sets.mjs`
