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

The “Played in sets with” list offers “Add to set” on every suggested tune.
Choose its key/setting (starred settings first) and an existing or new set.
Opened from the set editor, it defaults to the current draft and inserts after
the starting tune, without navigating away or saving unfinished edits.

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
the arrangement editor; saving returns to the score view. Unsaved edits remain
protected when navigating between set URLs as well as away from the page.

Tune pages show clickable membership chips with each set's name and the keys
used for that tune. Those chips open the complete set score view. Set snapshots
also supply the tune page's offline fallback independently of Favorite Tunes.

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
the stored document. Concurrent offline edits to the same set resolve to the
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
