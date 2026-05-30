# Petrus Hyvönen Changelog

This changelog summarizes the work added by Petrus Hyvönen across the
`folkfriend` app/runtime repository and the companion `folkfriend-app-data`
dataset repository.

Scope:
- `folkfriend`: from the first Petrus commit on 2026-03-22 through 2026-04-16
- `folkfriend-app-data`: from the first Petrus commit on 2026-04-15 through 2026-04-16

## 2026-03-22: Favourites, Sharing, Playback Controls, and App Data Portability

In the first contribution wave, FolkFriend gained persistent favourites and a
much more complete tune-management workflow.

- Added support for favourites and setting-specific bookmarking.
- Standardized `settingID` storage so favourites and lookups behaved more consistently.
- Added favourite timestamps and chronological ordering.
- Added export of favourites as HTML for sharing.
- Added export and import of user data.
- Added clear-history controls.
- Added links to specific TheSession settings so bookmarks can target exact settings.

This same phase also improved playback ergonomics and data freshness:

- Added a tempo slider.
- Added default tempo handling for polkas that lacked `Q:` metadata.
- Added a background tune-data cache update path.
- Fixed chord-symbol matching.
- Updated project dependencies.

## 2026-03-24: Better Sharing UX

- Improved sharing from favourites, including better iOS share behavior.

## 2026-04-06: Sign-In, Cloud Sync, Import, and Continuous Listening

This phase expanded FolkFriend from a local-only app into a synced experience.

- Added Google sign-in.
- Added Firestore-backed sync and related security rules.
- Improved sync behavior by subscribing to updates instead of checking only at startup.
- Added import from TheSession bookmarks.
- Added 24-hour timestamps.
- Added Continuous Listening Mode.
- Extended documentation around the new auth and sync flows.

## 2026-04-07 to 2026-04-12: Organizing Favourites and Playback/UI Polish

Work during this period focused on making favourites easier to browse and tune
playback easier to control.

- Added favourite indicators in search results.
- Started with folder-based organization, then replaced folders with tags.
- Refined favourite-row thumbnails and related list presentation.
- Added sort options in favourites.
- Added more visible bars in favourite previews.
- Reduced play button size and tuned related controls.
- Lowered the minimum playback tempo.
- Added real-time tempo changes during playback.
- Improved playback resume behavior so play returns more naturally.
- Added landscape-view support.

Authentication and compatibility also got iterative fixes:

- Improved iOS sign-in behavior.
- Re-fixed Google login after regressions.
- Applied follow-up fixes from code review.

## 2026-04-13 to 2026-04-14: Guided Playback and Offline Audio Assets

This phase made score playback more usable offline and easier to follow while
listening.

- Added note-follow/highlight during playback.
- Switched from online soundfonts to locally hosted soundfonts for offline playback.
- Added a soundfont download script.
- Fixed soundfont integration details.
- Stopped checking generated soundfont assets into git.

## 2026-04-15 to 2026-04-16: Folkwiki Integration, Settings Visibility, and Runtime Robustness

This was the largest feature wave. It connected Folkwiki material into the app
and strengthened runtime feedback around cache updates, sync, and offline edge
cases.

### App and Runtime

- Added Folkwiki support and source-link handling in the app.
- Fixed source links and added architecture documentation.
- Added project docs covering Folkwiki integration and multi-site deployment.
- Fixed About/settings date display.
- Added a manual "Refresh tune data" button in Settings.
- Surfaced both cached and available tune dataset version/date in Settings.
- Fixed settings state that could get stuck at a loading value.
- Added composer and origin display in tune views.
- Fixed cache-update behavior and a WASM null panic tied to stale cached data.
- Improved error propagation to the UI, including previously silent hangs.
- Surfaced service-worker update and Firestore sync errors to users.
- Added offline-safe UI handling for unavailable data and refresh actions.
- Added thumbnails in search results.

### `folkfriend-app-data` Dataset Pipeline

Folkwiki was added as a first-class source in the dataset repository during the
same window.

- Added initial Folkwiki ingestion and processing support.
- Added Folkwiki page-ID source URLs so the app could link back to wiki pages.
- Added a `date` field to `nud-meta.json` for accurate UI display.
- Added page-crawl gap filling for Folkwiki tunes missed by CDX discovery.
- Added `fill_missing_folkwiki.py`.
- Added composer extraction to Folkwiki settings.
- Improved pipeline reliability with stricter build behavior, validation, and contour summaries.

## Impact Summary

Across these changes, Petrus substantially expanded FolkFriend in five areas:

- User features: favourites, sharing, tags, import/export, clear history.
- Playback UX: tempo control, follow-along highlighting, offline soundfonts.
- Account and sync: Google sign-in, Firestore sync, better iOS behavior.
- Dataset awareness: visible tune data versions, refresh controls, better cache handling.
- Folkwiki support: dataset ingestion, source links, composer/origin metadata, and app integration.

## Source History Used

This changelog was derived from git history in:

- `folkfriend`
- `folkfriend-app-data`

Primary author filter:

- `Petrus Hyvönen <petrus.hyvonen@gmail.com>`
