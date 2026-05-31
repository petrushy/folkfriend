# FolkFriend — Claude Context

## Environment

### Rust

- Homebrew Rust (`/opt/homebrew/bin/rustc`) is on PATH and takes precedence over rustup.
- rustup is installed. Run `rustup default stable` if it has no default configured.
- The wasm32 target must be installed via rustup: `rustup target add wasm32-unknown-unknown`
- For `wasm-pack build`, force the rustup toolchain explicitly (Homebrew rustc has no wasm32 target):

  ```sh
  PATH="/Users/sepehy/.rustup/toolchains/stable-aarch64-apple-darwin/bin:$PATH" wasm-pack build
  ```

### Web App

- WASM output from `rust/pkg/` must be copied to `app/src/wasm/` before building the Vue app. **Now automated:** `npm run build` runs a `prebuild` hook (`app/build-wasm.sh`) that rebuilds the WASM (forcing the rustup toolchain, since Homebrew rustc lacks wasm32) and copies it in, so the deployed WASM can't go stale relative to the Rust source. `app/src/wasm/` is gitignored, so without this it was easy to ship an old build. `npm run build:wasm` rebuilds WASM only.
- Local tune index data must be downloaded before the dev server works:

  ```sh
  cd app && bash download_tune_data.sh
  ```

  This fetches `nud-meta.json` and `folkfriend-non-user-data.json` into `app/public/res/`.

- Dev server: `cd app && npm run serve` → <http://localhost:8080>
- Production build: `cd app && npm run build` → output in `app/dist/`

### Serving locally (desktop browser / PWA install)

**Quick local serve (no HTTPS, desktop only):**

```sh
cd app && npx serve dist -l tcp://0.0.0.0:3000
```

Open <http://localhost:3000>. Chrome will offer a PWA install icon in the address bar.

**HTTPS serve (required for mobile PWA install):**

One-time setup — install mkcert and create a trusted cert:

```sh
brew install mkcert
mkcert -install
cd app
mkcert 192.168.0.99   # replace with your Mac's IP: ipconfig getifaddr en0
```

Install the root CA on iPhone (one-time):

1. `mkcert -CAROOT` — AirDrop the `rootCA.pem` from that folder to your iPhone
2. On iPhone: tap the file → Settings → General → VPN & Device Management → Install
3. Settings → General → About → Certificate Trust Settings → toggle the mkcert entry **on**

Serve with HTTPS:

```sh
cd app/dist && python3 -c "
import ssl, http.server, os

class SPAHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if not os.path.exists(self.directory + self.path.split('?')[0]):
            self.path = '/index.html'
        return super().do_GET()

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain('../192.168.0.99.pem', '../192.168.0.99-key.pem')
server = http.server.HTTPServer(('0.0.0.0', 3000), SPAHandler)
server.socket = ctx.wrap_socket(server.socket, server_side=True)
print('Serving on https://192.168.0.99:3000')
server.serve_forever()
"
```

Open `https://192.168.0.99:3000` in Safari on iPhone → Share → Add to Home Screen.

After installing, the service worker caches all assets (including WASM) so the app works **offline** — the server does not need to keep running.

### Known issues

- `rust/wavs/soup_dragon.wav` has a corrupt WAV header in git (LIST chunk size and data chunk size are wrong). The file has a non-standard 78-byte header (LIST/INFO chunk from Lavf60.16.100 between fmt and data). Patched in-place by fixing offsets 0x04, 0x28, 0x4a.

## Caching strategy

The app is an offline-first PWA. Caching is configured in `app/vue.config.js` via Workbox (injected into the service worker at build time). The service worker only runs in **production** builds.

### Precache (automatic, build-time)

All static assets emitted by webpack — JS bundles, CSS, WASM, fonts, icons — are precached by the service worker on install. This covers the entire app shell and makes it available offline immediately after the first load.

### Runtime cache: tune index (`StaleWhileRevalidate`)

- **URL pattern:** `/res/folkfriend-non-user-data.json` (local dev) and `https://folkfriend-app-data.web.app/folkfriend-non-user-data.json` (production)
- **Cache name:** `folkfriend-tune-data`
- **Strategy:** StaleWhileRevalidate — served from cache instantly on startup, then a fresh copy is fetched in the background and stored for the next launch. Auto-updates every 28 days in-app (see `worker.js`).
- **Why:** The tune index is ~32 MB and must not block app startup.

### Runtime cache: ABCJS soundfonts (`CacheFirst`)

- **URL pattern:** `https://paulrosen.github.io/midi-js-soundfonts/**`
- **Cache name:** `abcjs-soundfonts`
- **Strategy:** CacheFirst — served from cache if present, otherwise fetched and cached. Max 500 entries, 1-year TTL.
- **Why:** ABCJS fetches individual MP3 files per note on first play (e.g. `FluidR3_GM/acoustic_grand_piano-mp3/A3.mp3`). After the user plays a tune once while online, all fetched notes are cached and playback works offline (e.g. on airplane mode).

### IndexedDB (idb-keyval)

Not part of the service worker — managed directly by `app/src/services/store.js`:

- `'favouriteItems'` — array of `FavouriteItem` objects
- `'historyItems'` — array of `HistoryItem` objects (capped at 100)
- `'tuneIndex'` / `'tuneIndexMetadata'` — cached tune index and its version (`v` = days since 2020-01-01)

### Firebase / Firestore

Only **favourites** are synced to Firestore (under `users/{uid}/data/favourites`). **History is local-only** — it lives in IndexedDB on the device and is never pushed to Firestore. Firestore SDK handles its own offline queue for favourites — writes made while offline are automatically replayed when connectivity returns. Security rules are in `firestore.rules`.

## Firebase setup (Petrus's fork)

This fork uses a separate Firebase project (`folkfriend-petrush-fork`) — not the original `folk-friend` project used by the upstream app.

- **Project:** `folkfriend-petrush-fork`
- **Hosting:** `https://folkfriend-petrush-fork.web.app`
- **Config:** `app/src/services/firebase.js` (shared instance for Auth, Firestore, Analytics)
- **Deploy:** `cd app && npm run build && firebase deploy --only hosting`

### Firebase services enabled

- **Authentication:** Google sign-in provider; authorized domains include `localhost` and `folkfriend-petrush-fork.web.app`. The local HTTPS IP (e.g. `192.168.0.99`) is **not** an authorized domain — auth only works on the deployed URL or localhost, not the local IP serve.
- **Firestore:** production mode; security rules in `firestore.rules` (users can only read/write their own data)
- **Analytics:** inherited from original app, wired through `store.loadAnalytics()`

### Google sign-in on iOS — IMPORTANT

**What works:** `signInWithPopup` with `browserPopupRedirectResolver` passed explicitly as the third argument. This is required on both Safari iOS and iOS PWA (WKWebView).

```js
import { signInWithPopup, browserPopupRedirectResolver } from 'firebase/auth';
await signInWithPopup(this.auth, provider, browserPopupRedirectResolver);
```

**Why:** WKWebView (iOS PWA) and some Safari environments cannot auto-detect the popup resolver — Firebase throws `"null is not an object (evaluating 't_popupRedirectResolver')"` without it. Passing it explicitly fixes both.

**What does NOT work on iOS:**

- `signInWithRedirect` — Google redirects back to Safari, not the PWA, so `getRedirectResult()` inside the PWA never sees the result. The page just flashes blank and returns to Settings with no auth state change.
- Detecting Safari via user-agent and switching to redirect — too broad, breaks desktop Safari.
- Detecting PWA via `window.navigator.standalone` and using redirect — same redirect problem.
- `initializeAuth()` with explicit persistence/resolver options instead of `getAuth()` — caused regressions.

**The auth instance** is created once in `app/src/services/firebase.js` via `getAuth(firebaseApp)` and exported as `firebaseAuth`. App.vue imports it directly — do not call `getAuth()` a second time elsewhere.

### Google sync architecture

**New files:**

- `app/src/services/firebase.js` — shared `FirebaseApp` instance
- `app/src/services/sync.js` — Firestore real-time sync logic

**How it works:**

- On sign-in: `sync.subscribe()` sets up an `onSnapshot` listener on `users/{uid}/data/favourites` only — **history is intentionally not synced**, it stays per-device in IndexedDB
- First snapshot: if Firestore has no data (first device ever), seeds from local IndexedDB; otherwise replaces local with Firestore data
- Subsequent snapshots: fire in real-time when any device writes favourites, update IndexedDB and emit `syncComplete` on `eventBus`
- On every favourites write (`addFavourite`, `removeFavourite`): pushes the full updated array to Firestore immediately, with a `clientUpdatedAt` millis timestamp mirrored to localStorage so a stale echoed snapshot can't overwrite newer local data
- `addToHistory` writes only to IndexedDB. There is no Firestore mirror and no `onSnapshot` listener for history.
- On sign-out: the favourites `onSnapshot` listener is unsubscribed
- Firestore is the source of truth for favourites — deletions propagate correctly; no additive-merge that would re-add removed items
- Firestore SDK queues writes made offline and replays them when connectivity returns

**Reactivity pattern:** `store.currentUser` is a plain object (not Vue reactive). Components listen to `eventBus.$on('authStateChanged', ...)` to update their local `data.currentUser`. Similarly, `eventBus.$on('syncComplete', ...)` triggers list reloads in `Favourites.vue`.

### User settings added

- `recordingTimeLimitSecs` (default: 10, range: 5–60) — max recording length before auto-stop. Note: the search algorithm is optimised for ~10s; longer recordings can reduce accuracy due to NW alignment scoring and quadratic query time.

### Help/About page additions

- Tune dataset date derived from `store.state.tuneIndexVersion` (set in `backend.js` after `setupTuneIndex`). The version `v` is days since 2020-01-01; convert with `new Date((1577836800 + v * 86400) * 1000)`.

## Tune detection v2.0 (ML transcriber) — architecture, gotchas & debugging

There are **two transcribers** (audio → contour). The query/index backend is shared.

- **DSP** (default): `feature/` autocorrelation → `decode/beam_search` + `decode/contour`. Level-robust (normalises per frame), forgiving of noisy/degraded audio.
- **ML** (opt-in): Spotify **basic-pitch** ONNX (`rust/models/nmp.onnx`, embedded via `include_bytes!`) run with **tract** (pure Rust, native + wasm). `decode/ml.rs` (`BasicPitch`) + `decode/note_events.rs` (note-creation port + monophonic melody selection) → reuses the same tempo quantiser (`contour_from_notes_fps`). Toggle: Settings → "Experimental: ML transcription" (`userSettings.useMlTranscriber`, default off).
- Full history/rationale: `docs/v2-detection/PROGRESS.md`. Design: `~/.claude/plans/how-can-tune-detection-*.md`.

### Gotchas that bit us (don't repeat)

1. **`app/src/wasm/` is gitignored** — it's the *compiled* Rust. Pulling source updates the JS + Rust source but NOT the WASM, so deploys silently shipped stale ML. **Now automated:** `npm run build` runs a `prebuild` hook (`app/build-wasm.sh`) that rebuilds + copies the WASM. Never hand-deploy without it. After deploy, the **PWA service worker caches the WASM hard** — a clean reinstall (delete app + Settings→Safari→clear Website Data + re-add) is the reliable cache-buster.
2. **Verify the live build on-device:** `ff_config::VERSION` (e.g. `1.4.1-ml`) shows on the **Help/About** page. **Bump it whenever you ship a behaviour change** so you can confirm which build is actually running (this is how we proved "stale WASM" vs "real bug"). Keep `ff_config.rs` VERSION and `Cargo.toml` version in sync.
3. **Query must be deterministic.** `query/heuristic.rs` shortlists the top `QUERY_REPASS_SIZE` candidates for the NW pass. It iterates a `HashMap` (random seed), so **never truncate mid-tie** — include the whole boundary tie group (capped at `QUERY_REPASS_MAX`). Splitting a tie made shortlist membership depend on HashMap order, so the same audio randomly found/missed a borderline tune (worst on weak ML/poor-audio contours). Any HashMap-order-dependent selection here is a bug.
4. **The CLI and the app use different ML entry points** — keep them equivalent. CLI/`bin.rs` (`FF_TRANSCRIBER=ml`) calls `BasicPitch::transcribe_contour` **directly**; the app/WASM goes `FolkFriend::feed_* → transcribe_pcm_buffer`. Guarded by test `ml_app_path_matches_direct_path`. ML is normalised internally, so it's far **less robust to degraded/playback audio than DSP** — clean clips can pass while field/speaker re-recordings fail.

### Debugging playbook (app-vs-CLI ML differences)

- **A/B benchmark:** `python3 scripts/run_benchmark.py` (DSP) vs `FF_TRANSCRIBER=ml python3 scripts/run_benchmark.py` (ML). Cases in `rust/bench/tunes.json`, WAVs in `rust/wavs/`.
- **Capture field data:** the Results page has a **"Save clip"** button (manual recordings) → WAV via the iOS Share sheet. Add the clip to `rust/wavs/` + a `tunes.json` entry to make a failure measurable.
- **Reproduce the exact WASM path in Node:** `cd rust && wasm-pack build --target nodejs --out-dir pkg-node` then `node rust/test_wasm_path.js <wav>`. Drives the app's exact WASM calls (`feed_single_pcm_window` → `transcribe_pcm_buffer` → `run_transcription_query`). If this matches the CLI but the app fails, it's stale WASM/cache; if it differs from the CLI, it's a real wasm-vs-native bug.
- The Results page shows a small debug line: transcriber (ML/DSP) + the contour string — compare against the CLI's `transcribe` output for the same clip.

## Recent changes

### Folkwiki audio detection fix (April 2026) — three-layer fix

This was a multi-cause failure: folkwiki tunes were not detectable from real audio at all. Three independent bugs were found and fixed.

#### 1. Heuristic scoring: distinct n-gram counts (`rust/src/query/heuristic.rs`)

**Root cause:** `ac.find_overlapping_iter(...).count()` counted raw overlapping occurrences. Long/repetitive tunes scored disproportionately high, causing an exact self-match to rank #94. Real-audio queries were worse, pushing correct matches below the 2000-result NW cutoff.

**Fix:** Two changes:

1. Deduplicate query n-grams before building the Aho-Corasick automaton.
2. Count **distinct** query patterns matched per candidate via `HashSet<usize>` over `m.pattern()`.

#### 2. Stored contour length mismatch: `dedup_runs` (`rust/src/query/heuristic.rs`)

**Root cause:** Folkwiki ABC files use `L:1/16` (sixteenth notes); thesession uses `L:1/8` (eighth notes). abc2midi quantises to `L:1/8` quavers in both cases, so a folkwiki dotted note like `A>B` stored 4 chars (`vvvt`) while audio transcription always produces 1 char per note (`vt`). The heuristic n-gram match rate was near zero.

**Fix:** Added `dedup_runs()` (collapses consecutive identical chars: `vvvt` → `vt`). Applied to both query and stored contour **in the heuristic only** before n-gram matching. Not applied in the NW second pass (see point 4 below).

#### 3. Contour data quality: two bugs fixed in `folkfriend-app-data`

**Chord symbol contamination** (`build/src/build_folkwiki_data.py` and `build/src/build_non_user_data.py`): Folkwiki (and some thesession) ABC has inline chord annotations (`"D"`, `"Am"`). abc2midi plays these as real MIDI notes on a second channel. Fix: `re.sub(r'"[^"]*"', '', abc_body)` before passing to abc2midi. Applied in both pipelines.

**Passing note dropout** (`build/src/midi.py`): `to_midi_contour`'s sync logic skipped short notes (e.g. B in `A>B`) when the preceding dotted note was rounded up, pushing `output_time` past the short note's end. Audio transcription always retains passing notes. Fix: instead of `continue`, always include the note as 1 quaver:

```python
if music_time <= output_time:
    output_time += quaver_duration
    midi_contour.append(note.rel_pitch())
    continue
```

After these fixes the data was rebuilt (60k settings) and copied to `app/public/res/`.

#### 4. NW score inflation fix (`rust/src/query/mod.rs`)

**Root cause:** After adding `dedup_runs` to the heuristic, it was also applied to both sides of the NW second pass. Shorter dedup'd strings reach the NW score ceiling more easily, inflating scores across the board — too many unrelated tunes showed "Very Close" in the web app.

**Fix:** Removed `dedup_runs` from the NW step entirely. The NW pass now uses raw contours. The rebuilt stored contours already include passing notes and are chord-stripped, so density matches audio-transcribed contours well enough for NW to work correctly without deduplication.

**Rule:** `dedup_runs` is used **only in the heuristic** (for discovery), never in NW (for scoring).

#### Integration tests (`rust/tests/integration_tests.rs`)

- `heuristic_self_match_ranks_first` — folkwiki settings 974588901 and 1402836401 must rank #1 or #2
- `thesession_self_match_ranks_first` — Kesh, Morning Dew, Silver Spear, Butterfly must rank top 3
- `audio_gumboda_schottis_detected` — real WAV recording (`rust/wavs/gumboda_schottis.wav`) must rank 974588901 in top 10
- Test WAV: `rust/wavs/gumboda_schottis.wav` — user-provided recording, converted from MP3 via ffmpeg at 48kHz mono

### Grace note stripping in contour pipeline (April 2026)

ABC grace notes (`{g}e2{f}e2…`) were being included in stored contours as extra characters, causing NW alignment mismatches against real-audio queries (which have no ornaments).

**Root cause:** Grace notes produce ~59 ms MIDI events. In `to_midi_contour`, `rel_duration ≈ 0.25 < 1.0` hit the "sub-quaver → emit as 1 quaver" path, inserting extra chars between melody notes. 18.7% of folkwiki ABCs contain `{...}` and 8.5% of their notes were sub-quaver ornaments.

**Fix — two-layer:**

1. **Strip `{...}` before abc2midi** (`build_folkwiki_data.py` and `build_non_user_data.py`):

   ```python
   abc_body = re.sub(r'\{[^}]*\}', '', abc_body)  # strip grace notes
   ```

   Applied after the existing chord-symbol and bracket-chord strips.

2. **Sub-quaver skip threshold in `midi.py`** (`to_midi_contour`): notes with `rel_duration < 0.35` are silently skipped instead of emitted as 1 quaver. Grace notes ≈ 0.25 quavers; semiquavers ≥ 0.5 — the threshold cleanly separates them.

Both pipelines rebuilt; 18 integration tests pass at ≥99% baseline thresholds.

### ABC thumbnails in search results (April 2026)

**`app/src/components/ResultRow.vue`** — Search result rows now show an ABC score preview thumbnail, matching the `FavouriteRow` pattern.

- `loadedAbc` reactive data property: pre-populated from `result.setting.abc` when the worker pre-attaches it (transcription results), otherwise lazily fetched via `ffBackend.settingsFromTuneID`.
- `ResizeObserver` tracks row width; thumbnail shown only when row ≥ 480 px (constant `ABC_PREVIEW_MIN_ROW_WIDTH`).
- `abcSvg` computed: strips chords/tempo, filters to voice 1, clips to 4 bars, renders via ABCJS at scale 0.65.
- **`app/src/views/Results.vue`** — fixed striping CSS selector from `.resultsTable > a:nth-child(odd)` to `.resultsTable > div:nth-child(odd)` (ResultRow root is a `div`).
- **`app/src/services/worker.js`** — `runTranscriptionQuery` and `runNameQuery` now re-attach ABC strings from `abcStringBySetting` to results that have a `setting_id`.

### Offline guard in Settings (April 2026)

**`app/src/views/Settings.vue`** — Two offline edge cases fixed:

- `_fetchRemoteMetadata` sets `{ unavailable: true }` on network failure; `remoteTuneDataLabel` returns `'unavailable (offline)'` instead of `'v? · v?'`.
- `refreshTuneData` checks `navigator.onLine` and returns an explanatory message rather than clearing IndexedDB when offline.

### Composer/origin display and cache-update fixes (April 2026)

**`app/src/views/Tune.vue`** — Composer and origin fields are now shown above the ABC score in each expansion panel, when present. Styled with `.settingMeta` / `.settingMetaLabel` CSS classes.

**`rust/src/index/schema.rs`** — Added `composer` field to the `Setting` struct. Both `origin` and `composer` now use a `null_as_empty_string` custom serde deserializer that handles both missing keys and explicit JSON `null` values (old cached IndexedDB data had `"composer": null` which caused a WASM panic with a plain `#[serde(default)]`).

**`app/src/services/worker.js`** — Fixed a silent bug where the update path fetched new data but never called `loadTuneIndex()`, so WASM kept running the old index until the next app launch. Also added a `bypassCacheVersion` parameter to `fetchTuneIndexData`: when a forced update is triggered, the URL gains a `?v={remoteVersion}` suffix so the service worker's StaleWhileRevalidate cache is bypassed and the fresh version is always fetched from the network.

**`app/vue.config.js`** — Added `$` anchors to both tune-index SW URL patterns (`/res/folkfriend-non-user-data\.json$` and the CDN URL) so requests with `?v=N` query strings are not intercepted by the service worker cache.

**`folkfriend-app-data/build/src/fill_missing_folkwiki.py`** — NEW gap-fill script. The Wayback CDX API missed ABC files whose URLs used Latin-1 percent-encoding (e.g. `%F6` for ö, `%E4` for ä). This script fetches each folkwiki page HTML, extracts the correctly-encoded `.abc` href, and downloads the file. Result: 7,885 ABC files (up from 6,103), adding 1,782 previously missing Swedish tunes.

**`folkfriend-app-data/build/src/build_folkwiki_data.py`** — Added `C:` (composer) field parsing: extracted from ABC headers and included in the output JSON alongside `origin`.

### Folkwiki integration and source links (April 2026)

Swedish folk music from folkwiki.se is included in the tune index. See `folkfriend-app-data/CLAUDE.md` for the full data pipeline description.

**App-side changes:**

- **`app/src/js/source.mjs`** — NEW helper module for source URL and label logic. Exports `isThesessionTuneID`, `sourceNameForTuneID`, `tuneSourceUrl`, `settingSourceUrl`. All source URL construction is centralised here.
  - For thesession tunes: `https://thesession.org/tunes/{tuneID}[#setting{settingID}]`
  - For folkwiki tunes: uses `source_url` from the index when set (72% of tunes get `/Musik/{pageID}`); falls back to title-based URL otherwise.
  - Tested in `app/test/source-links.test.mjs` (run with `node app/test/source-links.test.mjs`).

- **`app/src/views/Tune.vue`** — Source chip label changes to `thesession` or `folkwiki` based on tune origin. `sourceUrl` and `settingSourceUrl` now use `source.mjs`. Full-screen exit: added visible ✕ button (`exitFullScreenBtn`) and toggle icon on the expand button (`mdiArrowCollapse`).

- **`app/src/components/AbcDisplay.vue`** — Added `ref="abcTarget"` to the inner render div (fixes a Vue 2 `v-if` comment-node bug where `firstChild` traversal broke ABCJS rendering when the exit button was added).

- **`app/src/views/Favourites.vue`** — Share/export URLs now use `source.mjs` (supports folkwiki tunes correctly).

- **`app/src/services/worker.js`** — Extracts `source_url` from each setting as a sideband (same pattern as `abc`), stored in `sourceUrlBySetting`. Re-attached in `settingsFromTuneID`. Production data URLs updated to `https://folkfriend-data.web.app/...`. Update threshold changed from `daysSinceUpdate >= 28` to `remoteVersion > localVersion`. (Cache-busting `?v=N` and missing `loadTuneIndex()` call fixed in the April 2026 cache-update fix above.)

- **`app/vue.config.js`** — Added `StaleWhileRevalidate` runtime cache entries for both local and CDN tune index URLs. (`$`-anchored to exclude `?v=N` URLs — see April 2026 cache-update fix above.)

- **`docs/system-architecture.md`** — NEW: end-to-end architecture overview (repos, topology, data flow, service worker, Firebase, Rust/WASM).

### Firebase Hosting — multi-site deployment

Two sites in the `folkfriend-petrush-fork` Firebase project:

- **`folkfriend-data.web.app`** — hosts the tune index JSON. Deploy: `cd folkfriend-app-data && firebase deploy --only hosting`
- **`folkfriend-petrush-fork.web.app`** — hosts the Vue app. Deploy: `cd folkfriend/app && npm run build && firebase deploy --only hosting`

The data site is separate to avoid the SPA rewrite rule (`"**": "/index.html"`) intercepting static JSON requests.

### CLI: settingID in query output (`rust/src/bin.rs`)

The `query` command outputs 4 tab-separated columns: `tune_id`, `setting_id`, `display_name`, `score`.

### Web app: per-setting source links (`app/src/views/Tune.vue`)

Each expansion panel in the Tune view has a "Source" chip in the header, linking to:
`https://thesession.org/tunes/{tuneID}#setting{settingID}`
The chip is only visible when that panel is expanded.

### Web app: Favourites feature

Users can star individual settings to save them to a persistent Favourites list.

**New files:**

- `app/src/views/Favourites.vue` — list view, navigates to Tune on row click
- `app/src/components/FavouriteRow.vue` — row with amber star button to un-star

**Modified files:**

- `app/src/js/schema.js` — added `FavouriteItem` class (same shape as `HistoryItem`)
- `app/src/services/store.js` — added `getFavourites`, `addFavourite`, `removeFavourite`, `isFavourite`; favourited setting IDs are cached in a `_favouriteIDs` Set to avoid per-row IndexedDB reads
- `app/src/components/ResultRow.vue` — star button alongside each result row (outside the router-link so it doesn't trigger navigation)
- `app/src/views/Tune.vue` — star icon in each expansion panel header, left of the chord icon and Source chip; only visible when the panel is expanded
- `app/src/router/index.js` — added `/favourites` route
- `app/src/App.vue` — added Favourites nav entry

**Data model:** Favourites are stored in IndexedDB under the key `'favouriteItems'` as an array of `FavouriteItem` objects: `{ result: { settingID, setting, displayName }, timestamp }`.

**Type convention:** `setting_id` / `settingID` is consistently an integer throughout. Prop types in `ResultRow`, `FavouriteRow`, and `Tune.vue` are all `Number`.
