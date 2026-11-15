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

## Browsing and editing

The set list uses compact rows with the first tune's score on the right when
there is room, engraved only near the viewport. Use the same tag-plus icon as
Favorite Tunes to tag a set; tag chips above the list filter with AND semantics.
A row's overflow menu contains View scores, Edit set, Duplicate and Delete.

Clicking a set opens its own URL (`/sets?setID=…`) and all saved scores in order
on one scrollable page. Viewing never opens an editable draft. Edit set opens
the arrangement editor; saving returns to the score view. During editing, the
top toolbar shows Save set and Cancel in place of New set and remains visible
while scrolling through search results. Unsaved edits remain
protected when navigating between set URLs as well as away from the page.

Tune settings and Favorite Tunes show clickable name-only membership chips,
matched by exact settingID. Collapsed tune settings have a set icon beside the
favourite star; its menu links to the containing sets. Those chips open the complete set score view. Set snapshots
also supply the tune page's offline fallback independently of Favorite Tunes.

## Following a performance

In the full score view, Follow my playing uses the existing practice microphone
and staff-line tracker. It highlights the current row and can scroll through
the complete arrangement. It compares every saved tune in the set; two strong, distinct windows must
favour one unambiguous tune before changing entries. Skips and restarts are
recognized, while shared phrases and repeats hold the current tune. There is
one Follow my playing control, with a Next tune cue for identical occurrences
that audio cannot distinguish. Entry identity is kept separate from setting identity.

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
