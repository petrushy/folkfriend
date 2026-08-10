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

- **The WAV test fixtures were destroyed and have been removed** (July 2026);
  `rust/wavs/` now holds only a README. They were committed on 2026-04-17, when
  `.gitattributes` said `* text eol=lf` with no `*.wav binary` rule — that only
  arrived on 2026-05-31 (`b4a9e52`). Git's text filter converted every CRLF to
  LF *inside the audio* before storing it. The proof: zero `0D 0A` pairs across
  files with thousands of lone `0D` bytes, where chance would give 10–30.

  Measured, not assumed: with headers repaired the clips still parsed and the
  correct tune still ranked **6th, 16th, 23rd, 39th and 54th of ~62,000
  settings**, at roughly 40–65% of the recorded score baselines. So they were
  degraded rather than unusable — but well outside the thresholds the tests
  assert, and re-baselining against damaged audio would have locked in a corpus
  nobody could reason about. Retired instead, pending fresh recordings.

  `assert_audio_detects_one_of` skips when its WAV is absent, so the 15
  `audio_*` tests and `ml_app_path_matches_direct_path` report `ok` while
  printing `SKIP <label>` to stderr, and each returns to real coverage the
  moment its clip is restored. `scripts/run_benchmark.py` already skips missing
  files. **Until then there is no real-audio regression coverage**, and the v2.0
  ML-vs-DSP benchmark figures rest on that damaged corpus — treat them as
  unverified.

  See `rust/wavs/README.md` for how to add recordings back, including the
  clone-and-compare check that would have caught this.

  **Lesson:** add a new binary type's `*.ext binary` rule to `.gitattributes`
  *in the same commit as the first file of that type, or earlier*. The blanket
  `* text eol=lf` will silently eat it, and `git status` will not tell you —
  while `text` is in effect git compares the *filtered* working copy against the
  blob, so a pristine local file looks identical to a mangled stored one.

  Audited 2026-07-26: only `.wav` was affected. `rust/models/nmp.onnx`, the
  WASM, PNGs, SVGs, icons and archives are intact.

- `rust/wavs/soup_dragon.wav` (now removed) additionally had a non-standard
  78-byte header — a LIST/INFO chunk from Lavf60.16.100 between fmt and data —
  with wrong chunk sizes at offsets 0x04, 0x28, 0x4a. Worth remembering if a
  re-recorded clip comes out of ffmpeg: that header layout is legal but unusual,
  and some readers mis-handle it.

## Offline architecture (rewritten July 2026 — v3.6.0)

The app is an offline-first PWA. If it has been opened once with a connection,
everything must work on a plane. This section is the contract; the code that
implements it is `app/src/services/tuneIndexStore.js`, `tuneIndexNetwork.js` and
the index state machine in `worker.js`.

### The three rules

1. **One durable copy of the tune index, in IndexedDB.** Not two.
2. **The offline copy always wins the race.** Load from disk, declare the app
   usable, *then* touch the network. The network never gates readiness.
3. **Index availability is a state machine that always settles.** No caller ever
   waits on something that might never resolve.

### What went wrong before (the plane incident)

The user opened the app before boarding and still had no tunes in the air, with
every favourite taking 15 s to open. Four independent causes:

- **The index was stored twice** — once in IndexedDB and once in the service
  worker's `folkfriend-tune-data` StaleWhileRevalidate cache. ~84 MB of origin
  quota for one 42 MB dataset, roughly doubling the chance the browser evicts
  the copy that actually makes the app work.
- **No fetch had a timeout.** Offline, `fetch` rejects fast; behind a captive
  portal (plane/hotel Wi-Fi) it hangs for the platform default. `setupTuneIndex`
  awaited it, so the app sat in "loading" indefinitely.
- **`loadedIndex` was a promise that never settled on failure** — by design.
  Every `settingsFromTuneID` / `runNameQuery` call awaited it and hung forever.
  `Tune.vue` worked around this with a 15 s race; that timeout *was* the 15 s
  per favourite. `ResultRow.vue` and `Search.vue` had no workaround at all.
- **A failed IndexedDB write was invisible.** The index loaded fine that session
  and there was simply no offline copy next launch.

### Reliability rules for the offline copy (learned July 2026, the hard way)

The offline copy is the entire reason the app works without a connection. It
must be treated as sacred:

1. **Never delete anything on a failure path.** An update that fails must leave
   the previous copy exactly as it was. `writeIndex` originally deleted the
   manifest *first* and deleted the payload on error, so an interrupted or
   quota-failed update destroyed a working copy — which the user only
   discovered the next time they were offline, i.e. when they could not
   possibly recover it.
2. **Payload first, manifest second.** IndexedDB `set()` is a single
   transaction: it commits or aborts, so a payload can never be half-written.
   The worst case with this ordering is a manifest naming the previous version
   while the payload is the new one — both complete and valid, costing one
   redundant update. The old ordering had a window with a payload and no
   manifest, which `readIndex` treated as "no copy" and then garbage-collected.
3. **A payload that parses is usable, full stop.** Never discard one because its
   bookkeeping looks wrong. A missing or mismatched manifest means "version
   unknown" (report `v: 0` so an update is attempted when online), not "throw
   the user's only copy away". The only state worth clearing is a payload that
   genuinely fails to parse.
4. **Usability is not pipeline status.** `indexUsable` is tracked separately
   from `indexStatus`. During a background update the status is `downloading`
   while the loaded index still answers queries perfectly — conflating the two
   made every query return empty for the duration of an update, which on a poor
   connection is minutes, on every launch.
5. **Test the invariant, not the implementation.** The bug that stranded a user
   in a pub passed every existing test, because those tests asserted what
   `writeIndex` did rather than what must remain true. `npm test` now walks a
   simulated interruption across *every* storage operation in an update and
   asserts directly: **if a usable offline copy existed before, one exists
   after, wherever the update died.** Verified by reinstating the old
   destructive ordering — 3 tests fail; with the fix, 21 pass. Any future
   rewrite of the persistence layer is held to the same property.
6. Automatic update checking can be turned off entirely (Settings → *Check for
   new tune data automatically*, `userSettings.autoUpdateTuneData`). With it
   off, the saved copy is only ever replaced by an explicit tap.

### How the index is stored

`app/src/services/tuneIndexStore.js`, IndexedDB via idb-keyval:

- `ffIndexRaw` — the index as **raw JSON text, exactly as downloaded**. Storing
  text rather than a parsed object graph matters: structured-cloning 62 k
  setting objects is the operation most likely to be slow or to fail outright on
  iOS; cloning one big string is effectively a memcpy. The split into
  `{indexData, abcStrings, sourceUrls}` is re-derived on read by
  `splitIndexPayload()`, the same function the download path uses, so the two
  can never disagree.
- `ffIndexManifest` — `{schema, v, date, savedAt, bytes}`. This is the **commit
  marker**: deleted first, written last. There is no state where a manifest
  points at a half-written payload, so an interrupted or quota-failed write
  reads as "no offline copy" rather than as corruption. An orphaned payload with
  no manifest is garbage-collected on the next read.
- Reads never throw. Every failure resolves to `null`.
- **Legacy (`tuneIndex` / `tuneIndexMetadata`)** — the pre-3.6 single-object
  layout is still read, so upgrading users are never forced into a 40 MB
  re-download they might not be able to do. It is deleted the moment a
  schema-2 write succeeds (i.e. on the next data version bump, or when the user
  taps "Update offline copy").

### Network policy

`app/src/services/tuneIndexNetwork.js` — every request is bounded:

- `navigator.onLine === false` is authoritative for *don't even try*. It is
  never authoritative for the reverse: a captive portal is "online".
- Metadata (`nud-meta.json`, ~50 bytes): 8 s hard deadline. It doubles as a
  **reachability probe**, and its failure is deliberately fatal — if 50 bytes
  won't come off that host, a 42 MB download won't either, and failing at 8 s is
  what lets the app say "unavailable" quickly instead of grinding on a stalled
  transfer.
- Index download: streamed via `response.body.getReader()` with a **20 s stall
  timeout** (abort if no bytes arrive) plus a 10 min overall cap. Streaming also
  gives real download progress on the Search and Settings screens.

### Index state machine

`worker.js` owns `'loading' | 'downloading' | 'ready' | 'unavailable'`, pushed to
`store.state.indexStatus` by `backend._onIndexStatus` and broadcast as
`eventBus.$emit('indexStatusChanged')`. It always reaches a terminal state.

- `ffBackend.indexReady()` resolves `true`/`false` — never hangs. Use it instead
  of racing the one-shot `indexLoaded` event against your component's mount.
- Index-dependent worker calls (`settingsFromTuneID`, `aliasesFromTuneID`,
  `runNameQuery`, `runTranscriptionQuery`) **fail fast with `[]`** when the index
  is unavailable, so callers fall back immediately.
- `subscribeIndexStatus` fires once with the current state on subscribe, so a
  late subscriber cannot miss a transition.
- Coming back online auto-retries an index that failed to install (`'online'`
  listener in `backend.js`).
- `Tune.vue` falls back to the self-contained copy in the user's favourites and
  upgrades itself in place if the index later becomes available.

### Service worker (`app/vue.config.js`)

- **Precache:** all webpack-emitted assets — JS, CSS, WASM, fonts, icons,
  soundfonts. This is the app shell and it must be complete for offline start.
- **`runtimeCaching: []`** — deliberately empty for the tune index. See rule 1.
  `public/sw-cleanup.js` is `importScripts`-ed into the generated service worker
  and deletes the obsolete `folkfriend-tune-data` cache on activate, reclaiming
  ~42 MB from existing installs.
- ABCJS soundfonts are served from `public/soundfont/` and precached, so
  playback works offline without a runtime cache — **but only if the files are
  actually there at build time.** `public/soundfont/` is gitignored
  (`app/.gitignore`), so a fresh clone has none, and until August 2026 CI never
  fetched them: every deployed build shipped a `dist/` with no `soundfont/`
  directory while every local build worked, because the developer had run
  `download_soundfont.sh` once by hand.

  The failure mode is nastier than a 404. Firebase's SPA rewrite
  (`"**": "/index.html"`) answers a missing static file with **index.html at
  status 200**, so ABCJS receives a web page labelled `text/html`, tries to
  decode it as audio, and reports `Can't decode sound at
  /soundfont/…/B4.mp3` — 88 times, once per note. Nothing in the chain looks
  like a missing file.

  `.github/workflows/deploy.yml` now runs `download_soundfont.sh` before the
  build and then **verifies dist**: 88 notes present and each one really an
  MP3 per `file`. Checking existence alone is not enough here, precisely
  because the broken case is a 200 with a body.

  **Rule:** any asset that is gitignored *and* required by the deployed app
  needs both a CI fetch step and a post-build assertion. `res/nud-meta.json`
  and the WASM are the other two; the tune index is the deliberate exception
  (fetched at runtime from `folkfriend-data.web.app`).

### Diagnosing it on a device

Settings → **Offline Tune Database** is the pre-flight check. It reads
IndexedDB directly rather than inferring from in-memory state, and shows:
offline copy saved/not saved (+ size and when), saved vs latest version, whether
storage is protected from eviction (`navigator.storage.persist()`), the live
index status with download percentage, and any persist error (e.g. quota) —
which used to be swallowed entirely. **"Save offline copy" forces a fresh
download and re-save**, and is also how a legacy-format copy is migrated on
demand.

If a user reports "no tunes offline", that panel says which of the two failure
modes it was: never saved, or saved-then-evicted.

### Tests

- `npm test` — unit tests for the store and network layers, with in-memory
  fakes. Covers quota failure, partial writes, corrupt payloads, legacy reads,
  stall aborts.
- `npm run test:e2e` — real headless Chrome, driven over CDP. See
  `app/test/e2e/README.md`, which also documents the traps (CDP network
  emulation does not reach Web Workers; Chrome's HTTP cache masks the failure;
  `.app` is HSTS-preloaded).

### IndexedDB (idb-keyval) — full key list

- `'favouriteItems'` — array of `FavouriteItem` objects
- `'historyItems'` — array of `HistoryItem` objects (capped at 100)
- `'ffIndexRaw'` / `'ffIndexManifest'` — tune index and its commit marker
- `'tuneIndex'` / `'tuneIndexMetadata'` — legacy tune index (read-only, migrated away)
- `'aiTuneSummaries'` — AI background notes, `{ tuneID: { text, model, generatedAt, sourceUrl } }`

Not IndexedDB, but worth listing alongside — localStorage keys: `'userSettings'`,
`'favouritesLocalUpdatedAt'`, `'anthropicApiKey'` (deliberately outside
`userSettings` so it stays out of exported backups) and `'aiSummaryUsage'`.

### Firebase / Firestore

Only **favourites** are synced to Firestore (under `users/{uid}/data/favourites`). **History is local-only** — it lives in IndexedDB on the device and is never pushed to Firestore. Firestore SDK handles its own offline queue for favourites — writes made while offline are automatically replayed when connectivity returns. Security rules are in `firestore.rules`.

## CI/CD — GitHub Actions (July 2026)

`.github/workflows/deploy.yml`. Push to `master` deploys live; pull requests get
a Firebase Hosting **preview channel** (temporary URL, expires after 7 days) —
useful because the app is tested on a real iPhone and a preview lets you try a
branch without disturbing the installed PWA.

Pipeline: install Rust (+ wasm32) and Node → download tune index → `cargo test
--release` → `npm test` → **drop the tune index** → `npm run build` → serve
`dist` → `npm run test:e2e` → deploy.

Three things about it are non-obvious:

- **The Rust tests need the 42 MB index**, which is gitignored. CI runs
  `download_tune_data.sh` before `cargo test`, and `--release` because the tests
  run full NW queries over the whole index — debug builds make that the longest
  step in the job.
- **The index is then deleted before `npm run build`.** In production the app
  fetches it from `folkfriend-data.web.app`, so the copy webpack was pasting
  into `dist/` was never read — it was silently adding ~42 MB to every deploy.
  Dropping it takes `dist` from 65 MB to 24 MB. `app/firebase.json` also ignores
  `res/folkfriend-non-user-data.json` so local `firebase deploy` does the same.
- **`res/nud-meta.json` MUST survive.** It is in the service worker's precache
  manifest; a 404 there fails the service worker install and takes offline
  support down with it. Never exclude `res/` wholesale.

Chrome for the e2e tests is resolved by `app/test/e2e/chrome.mjs` (`CHROME_PATH`
env var, then the usual macOS/Linux locations), which also adds `--no-sandbox`
and `--disable-dev-shm-usage` when `CI` is set.

**The e2e tests need Node 22+.** They drive Chrome over the DevTools Protocol
using the global `WebSocket`, which Node only exposes from v22. `chrome.mjs`
checks this and says so, rather than failing with a bare
`WebSocket is not defined`.

### Required secret

`FIREBASE_SERVICE_ACCOUNT` — the JSON key for a service account **in the
`folkfriend-petrush-fork` project** with the Firebase Hosting Admin role.
Firebase console → Project settings → Service accounts → Generate new private
key, then paste the whole file into the GitHub repo secret. Check `project_id`
inside the JSON matches — a key from a different project fails with a
permissions error that reads like a broken workflow.

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
- `aiSummariesEnabled` (default: false) — shows the (i) tune-background button. See "AI tune background notes" under Recent changes.
- `aiSummaryModel` (default: `claude-haiku-4-5`) — which model writes the note.

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
3. **Query must be deterministic — twice over.** *Membership* and *order*.

   *Order (fixed July 2026):* `sort_by` is stable, so tied entries keep their
   input order — which came from iterating a `HashMap`, whose hasher Rust seeds
   randomly per process. Identical audio therefore reordered its tied results
   run to run: two tunes sharing a title and an exact score swapped rank, and a
   tune with several equally-scoring settings reported a different one each
   time. Scores themselves were never affected. Both sorts (`query/mod.rs` NW
   pass, `query/heuristic.rs` shortlist) now break ties on `setting_id`, giving
   a total order. The name-query path had always done this (ties broken by
   alias length). **Any new sort over query results needs a tiebreak.**

   *Membership:* `query/heuristic.rs` shortlists the top `QUERY_REPASS_SIZE` candidates for the NW pass. It iterates a `HashMap` (random seed), so **never truncate mid-tie** — include the whole boundary tie group (capped at `QUERY_REPASS_MAX`). Splitting a tie made shortlist membership depend on HashMap order, so the same audio randomly found/missed a borderline tune (worst on weak ML/poor-audio contours). Any HashMap-order-dependent selection here is a bug.
4. **ML vs DSP, re-measured on the clean corpus (July 2026).** The earlier
   finding that ML is "far less robust than DSP" was measured on the corrupted
   fixtures and does **not** hold on clean audio — they are equal on rank:

   | | top-1 | top-5 | top-10 |
   |---|---|---|---|
   | DSP | 11/12 | 12/12 | 12/12 |
   | ML  | 11/12 | 11/12 | 12/12 |

   Each wins some: ML gets `the_kid_on_the_mountain` to rank 1 where DSP manages
   only 4, and scores `the_kerfunten` higher; DSP is much stronger on
   `nåspolskan` (rank 1 vs 9). ML scores are systematically lower in absolute
   terms, but scores are not comparable across transcribers — only rank is.

   **Still untested:** the original claim was specifically about *degraded /
   speaker-re-recorded* audio, and the current corpus is all clean recordings.
   That claim is unverified, not disproven. Worth capturing some deliberately
   poor clips via the Results page "Save clip" button.

   Note `scripts/run_benchmark.py` names its output by commit, so a DSP run and
   an ML run at the same commit overwrite each other — copy the JSON aside
   between runs when comparing.

   **ML scores are NOT rescaled, deliberately.** They run systematically lower
   than DSP (median 0.660 vs 0.854 on the correct match), which makes the app's
   confidence labels read pessimistically under ML. Scaling them up looks like
   the obvious fix and is a trap: ML's *separation* is narrower, not just its
   scale (correct − best-wrong: DSP 0.348, ML 0.235), and a uniform rescale
   multiplies both sides. Measured over the corpus, every factor that improved
   label agreement also multiplied wrong tunes shown as "Very Close":

   | k | labels matching DSP | wrong tune shown "Very Close" |
   |---|---|---|
   | 1.00 (current) | 6/12 | 0 |
   | 1.29 (equalises medians) | 6/12 | 3 |
   | 1.40 (best agreement) | 8/12 | 4 |

   DSP's own baseline is 1. Scaling thresholds down instead is mathematically
   identical to scaling scores up — no free lunch. The residual disagreements
   are real per-clip differences, not calibration error (ML scores
   `the_arra_mountains` 0.272 vs DSP 0.875, but `the_kid_on_the_mountain` 0.676
   vs DSP 0.500), and no constant fixes those.

   `scripts/compare_transcribers.py` regenerates this analysis. Re-run it as the
   corpus grows — 12 clips is too few to calibrate on, and the question is worth
   revisiting once there is degraded audio in the set.

5. **The ML contour is unstable w.r.t. input length; the app and CLI feed
   different lengths (July 2026).** `contour_from_notes_fps` picks a tempo by
   argmax over a coarse 5-BPM grid. Candidates routinely score within a hair of
   each other, so a perturbation as small as **128 samples (2.9 ms)** flips the
   winner — and since the winner sets every note's quaver count, the *whole*
   contour changes, from its first symbol. Measured: `the_lounge_bar` went 43 →
   49 characters and its match score 0.721 → 0.612. **DSP is immune** (identical
   output across the same trims), which is why DSP holds up in the field and ML
   does not.

   The app feeds 1024-sample windows and drops the trailing partial one; the CLI
   and `scripts/run_benchmark.py` feed the whole signal. So **the benchmark has
   never measured what the app runs** — 4 of 6 clips produce different contours
   between the two paths.

   Two fixes were tried and both made matching *worse* on the corpus, so neither
   was kept:
   - epsilon tie-break preferring the faster tempo: 2 clips down, 0 up
   - excluding the final note from tempo scoring (its duration is set by where
     recording stopped, not by the music): 5 down, 1 up, one by 0.196

   `ml_app_path_finds_tunes` now drives the app's windowed feed over every
   fixture and asserts the tune is still found — a real guard on the path that
   ships. It deliberately does NOT assert contour equality with the CLI, because
   that does not hold; the old `ml_app_path_matches_direct_path` asserted
   equality on a single clip that happened to agree, which is how this stayed
   hidden.

6. **The CLI and the app use different ML entry points** — keep them equivalent. CLI/`bin.rs` (`FF_TRANSCRIBER=ml`) calls `BasicPitch::transcribe_contour` **directly**; the app/WASM goes `FolkFriend::feed_* → transcribe_pcm_buffer`. Guarded by test `ml_app_path_matches_direct_path`. ML is normalised internally, so it's far **less robust to degraded/playback audio than DSP** — clean clips can pass while field/speaker re-recordings fail.

### Debugging playbook (app-vs-CLI ML differences)

- **A/B benchmark:** `python3 scripts/run_benchmark.py` (DSP) vs `FF_TRANSCRIBER=ml python3 scripts/run_benchmark.py` (ML). Cases in `rust/bench/tunes.json`, WAVs in `rust/wavs/`.
- **Capture field data:** the Results page has a **"Save clip"** button (manual recordings) → WAV via the iOS Share sheet. Add the clip to `rust/wavs/` + a `tunes.json` entry to make a failure measurable.
- **Reproduce the exact WASM path in Node:** `cd rust && wasm-pack build --target nodejs --out-dir pkg-node` then `node rust/test_wasm_path.js <wav>`. Drives the app's exact WASM calls (`feed_single_pcm_window` → `transcribe_pcm_buffer` → `run_transcription_query`). If this matches the CLI but the app fails, it's stale WASM/cache; if it differs from the CLI, it's a real wasm-vs-native bug.
- The Results page shows a small debug line: transcriber (ML/DSP) + the contour string — compare against the CLI's `transcribe` output for the same clip.

## Recent changes

### AI tune background notes (August 2026 — v3.9.0)

An **(i)** button on the Tune view writes a ~10-line program note about the tune —
origin, earliest documented date, the story attached to it — via the Claude API
using the **user's own** API key. Off by default (Settings → *AI Tune Summaries*).

`app/src/services/aiSummary.js` is the whole network layer;
`app/src/views/Tune.vue` holds the button and dialog; `store.js` owns the cache,
the key and the spend counter.

**No proxy, no Cloud Function, and none needed.** Both hops go straight from the
browser:

- **thesession.org** `/tunes/{id}?format=json` for hard facts (name, aliases,
  type, meter, mode). This origin already serves CORS-permissive JSON to this
  app — `Settings.vue`'s bookmarks import has fetched it from the browser in
  production for months. Failure here is deliberately **non-fatal**: it resolves
  to `null` and the note is written anyway.
- **api.anthropic.com** `/v1/messages`, which permits browser calls when the
  request carries `anthropic-dangerous-direct-browser-access: true`. There is no
  server-side infrastructure in this repo (no `functions/`, hosting-only
  `app/firebase.json`) and this feature does not add any.

**The API key is deliberately NOT in `userSettings`.** `exportUserData()`
serialises `userSettings` wholesale into the downloadable backup users share, so
a key placed there would leak into that file. It lives under its own
localStorage key (`anthropicApiKey`) and is excluded from both export and
import. There is a test asserting the exported JSON does not contain it.

#### Three API details that 400 if you get them wrong

1. **The `web_fetch` tool version is model-gated.** The `_20260209` variant
   (dynamic filtering) requires Opus 4.6+ / Sonnet 4.6+, so **Haiku 4.5 must use
   `web_fetch_20250910`**. `webFetchToolFor()` encodes this and a unit test pins
   it, so adding a model can't silently 400.
2. **Some deployments require `anthropic-beta: web-fetch-2025-09-10`.** Rather
   than guess, `requestWithLadder()` degrades: bare request → retry with the beta
   header → retry with the tool removed entirely (note written from the model's
   own knowledge, `degraded: true`). A 400 therefore never reaches the user as
   "HTTP 400", and the open question of whether Haiku 4.5 serves `web_fetch` at
   all resolves itself at runtime.
3. **Thinking is left at each model's default.** Haiku 4.5 has no adaptive
   thinking; Sonnet 5 runs adaptive when `thinking` is omitted, which is *wanted*
   here because a thinking-disabled Sonnet 5 reaches for tools noticeably less
   often and `web_fetch` firing is the point. Hence `max_tokens: 1500` — that cap
   covers thinking *and* visible text together.

#### What the first on-device test actually broke (August 2026)

The unit tests fake `fetch`, so they could not have caught any of this. The first
real generation returned a *refusal* rather than a note, and it took three
separate bugs to produce it. All three are now pinned by tests, each verified by
reinstating the bug:

1. **The tool-call preamble was being treated as part of the note.** The model
   narrates before calling a server tool ("I'll fetch that page to research the
   tune's history"), and `extractText` joined *every* `text` block, so that
   narration was prepended to the summary. It now takes only prose **after the
   last `web_fetch_tool_result`**, falling back to all text when no tool ran.
   This affected successful notes too, not just failures.
2. **A fetch that failed at runtime made the model decline entirely.** The
   ladder below only covers the API *rejecting* the tool with a 400; a tool that
   is accepted and then cannot reach the page returns HTTP 200 with an error
   object. The prompt still said "fetch this page first and prefer what it says",
   so the model reported the network problem and refused to write — reinforced by
   the honesty rule ("don't fill gaps with invention"), which it read as "no
   record exists". Fixed at both levels: the prompt now says a failed fetch means
   silently fall back to knowledge and **never decline**, and
   `generateTuneSummary` **regenerates once with the tool and the fetch
   instruction removed** when `pageRead === 'error'`. If that retry also fails,
   the first attempt is kept rather than turning a caveated note into an error.
3. **It asked the reader to paste the page in.** The model had no idea it was
   writing into a one-shot panel. The prompt now states that the reply is
   rendered verbatim with no reply channel, so it must never ask a question,
   suggest retrying, or describe its own tools and difficulties.

A fourth, latent version of (2): rung 3 of the ladder dropped the tool but
**reused the prompt built for rung 1**, leaving "fetch this page first" in a
request with no fetch tool — precisely the state that causes the refusal. The
ladder now takes a `makeBody(canFetch)` function and rebuilds the prompt.

Also hardened: `allowed_domains` now carries **both** host spellings
(`thesession.org` and `www.thesession.org`), since a redirect between them would
be blocked by our own allowlist and would look like an unexplained fetch failure.

**The lesson:** a prompt that names an authority the model may not be able to
reach needs an explicit instruction for what to do when it cannot — and the
fallback path must rebuild the prompt, not just strip the tool. If Anthropic's
fetcher simply cannot reach thesession.org (bot protection, rate limits), notes
degrade to knowledge-based and the dialog says so; the browser-side
`?format=json` facts are then the only grounding.

#### Response-handling traps (all silent when got wrong)

- **Never `content[0].text`.** With a server tool in play, `content[0]` is a
  `web_fetch_tool_result` or a thinking block — and the *first* text block is
  usually the pre-tool preamble, not the answer. See (1) above.
- **`web_fetch` errors do not raise** — they arrive as HTTP 200 with an error
  object inside the result block. `pageRead` is the only way to detect it, and it
  now drives a regeneration rather than just a UI caveat. See (2) above.
- **Check `stop_reason` before reading `content`.** On a refusal `content` is
  empty, so indexing it throws a `TypeError` instead of reporting what happened.
- **`pause_turn` must be resumed** (re-send with the assistant turn appended, no
  synthetic "continue" message) but capped — 2 continuations, then `incomplete`.

#### Cost guardrails

Nothing is ever generated automatically: opening the dialog reads the cache and
stops, so a cache miss shows a Generate button and waits for a tap. Results are
cached permanently, so a tune costs at most one call per account. Default model
is Haiku 4.5 (~$0.009/note; Sonnet 5 ~$0.03). `max_content_tokens: 6000` bounds
the page read, `max_uses: 1` bounds the fetching, and `allowed_domains` is
derived from the tune's own URL so the model cannot be talked into fetching
anything else. Settings shows call count and approximate spend.

#### Storage, and the invariant that matters

Two copies, on purpose:

- **`aiTuneSummaries`** (IndexedDB, `{ tuneID: { text, model, generatedAt,
  sourceUrl } }`) is the durable copy. Covers every tune and survives
  un-favouriting.
- **`FavouriteItem.aiSummary`** is a mirror that exists *only* so the note rides
  the existing favourites Firestore sync to the user's other devices. `sync.js`
  knows about the favourites document and nothing else. Text is capped at 1200
  chars because that document is the whole array in one `setDoc`.

**The hazard:** an inbound snapshot replaces the local favourites array
wholesale, so a second device that has never generated a summary would strip
every mirror and propagate that deletion. `store.onChange` therefore
`_harvestAiSummaries` (take anything newer the remote knows) then
`_reapplyAiSummaries` (put back anything it does not) and re-pushes if it
restored something. `npm test` asserts the property directly — *if a summary
existed before a snapshot, it exists after* — and reinstating the naive
wholesale replace fails 3 tests.

#### Also fixed here: `userSettings` never picked up new defaults

`store.js` loaded settings as `JSON.parse(stored) || USER_SETTING_DEFAULTS` — an
`||`, not a merge. Any user who had ever saved settings read **every
subsequently added key as `undefined`**, which is why call sites throughout the
app coalesce with `|| false` / `?? 10`. Now spread over the defaults on load, and
`updateUserSettings()` fills in missing keys in place (mutating rather than
replacing, because several views hold a reference to that object and rely on its
identity). This is what makes the two new settings reach existing installs.

#### Tests

- `app/test/aiSummary.test.mjs` (21 cases) — the network layer with a faked
  `fetch`: block-type extraction, refusal, `pause_turn` resume and cap, the
  web_fetch error path, the three-rung ladder, status→kind mapping, the bounded
  deadline, and offline/no-key short-circuits that must not spend a request.
- `app/test/aiSummaryStore.test.mjs` (14 cases) — the sync invariant above, key
  exclusion from backups, truncation, mirror targeting, and spend accounting.
- `scripts/probe_tune_summary.mjs` — live probe (`ANTHROPIC_API_KEY=... node
  scripts/probe_tune_summary.mjs 14109 [model]`). Not in CI: it costs money.
  Prints which ladder rung served, whether the page was actually read, real
  token usage and cost. **This is the only way to confirm the `web_fetch` /
  beta-header behaviour for a given model** — the unit tests fake the network.

### Microphone capture recovery after app switching (July 2026 — v3.8.0)

**Symptom:** switch to another app and come back, and FolkFriend silently stops
hearing anything. The follow view stays stuck on the last tune it saw, the
volume meter sits at zero, and only stopping and restarting the session fixes
it.

**There are two independent causes with that one symptom, and the code only
handled the first:**

1. **The AudioContext suspends.** Browsers suspend a context that isn't
   producing audible output (ours never does) after a period of inactivity, and
   unconditionally when the tab is backgrounded. `resume()` fixes it, and
   `resumeIfSuspended()` already did.
2. **The MediaStreamTrack dies.** iOS hands the microphone to whatever the user
   switched to (a call, Siri, Voice Memos, another recorder). Our track either
   ends (`readyState === 'ended'`, terminal) or comes back **live but
   permanently muted**. Resuming the context achieves nothing here:
   `onaudioprocess` fires again and delivers digital silence forever. The only
   fix is a fresh `getUserMedia` and a rebuilt graph.

Case 2 is the one that looks most like a bug, because everything *claims* to be
healthy — context `running`, track `live`, buffers arriving on schedule.

**`micService.ensureMicHealthy()`** (`app/src/services/mic.js`) now covers both.
It resumes a suspended context, then checks for a fault (`no stream`, `track
ended`, `track muted`, `audio context closed`), and separately for a **stall** —
no buffer delivered for 1.5 s. A stall is confirmed rather than assumed: it
waits up to 750 ms for the next buffer first, because a just-resumed context
takes a few milliseconds to produce one. Any confirmed fault tears the pipeline
down and rebuilds it from a fresh `getUserMedia`.

It is called from four places, and is deliberately safe to call from all of them
at once: a `visibilitychange` → visible handler, a `MediaStreamTrack` `'ended'`
listener, a 2 s watchdog interval that runs while a capture is open, and the
live-analysis loop once per cycle (replacing its `resumeIfSuspended()` call).
Concurrent callers join the single in-flight check via `_healthCheck`, assigned
before the first `await` — without that, returning to the foreground fires three
of those paths at once and each races its own `getUserMedia`, leaving orphaned
microphones open.

Things that are easy to get wrong here, and how they're handled:

- **Never re-acquire while backgrounded.** It would fail, or snatch the mic back
  from whatever the user switched to. Both the watchdog and the `'ended'`
  listener check `document.visibilityState` first; the visibility handler covers
  the return trip.
- **Failed recovery backs off** (2/4/8/15/30 s) and emits `micLost` only on the
  first failure of a streak, so a denied mic doesn't spin `getUserMedia` or spam
  snackbars. The capture stays "wanted", so it recovers on its own once the other
  app lets go. `micRecovered` fires on success; `Search.vue` shows both.
- **The ring buffer survives recovery.** It *is* the analysis window — emptying
  it would throw away the audio the next query runs on.
- **Stops during recovery.** `_captureGeneration` is bumped by every stop, and an
  in-flight recovery that has already re-opened checks it and tears its own new
  pipeline down. Otherwise stopping mid-recovery leaves the microphone on.

The pipeline setup/teardown shared by `startRecording` and `startContinuous` was
factored into `_openPipeline(mode, durationSecs)` / `_teardownPipeline()` so
recovery rebuilds exactly what the original open built. The chunk handler binds
its `mode` at wiring time instead of reading `this._mode`, so a buffer arriving
mid-setup can't be routed to the wrong sink. `set_sample_rate` is a no-op in
WASM when the rate is unchanged, so re-opening mid-session doesn't disturb
audio already fed to the backend.

**Tests:** `app/test/mic.test.mjs` (14 cases, in the `npm test` chain). Fakes the
`getUserMedia`/Web Audio surface so the dead-track, muted-track, live-but-silent,
background, foreground-return, failed-recovery and stop-during-recovery paths are
all covered without a browser. Note that "live but silent" and "track ended" fail
for different reasons and need separate cases — a mutation that neuters
`_captureFault` still passes the stall test.

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

### Offline guard in Settings (April 2026) — superseded July 2026

Largely replaced by the offline-architecture rewrite above. `refreshTuneData`
(which deleted `tuneIndexMetadata` and reloaded the page) is gone; the Settings
panel now calls `ffBackend.refreshTuneIndex()`, which downloads and re-saves in
place with no reload. `_fetchRemoteMetadata` still degrades to
`'unavailable (offline)'`, but now via the bounded `fetchTuneIndexMetadata()`
from `tuneIndexNetwork.js` rather than a bare `fetch` that could spin
`'checking…'` forever behind a captive portal.

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

- **`app/src/services/worker.js`** — Extracts `source_url` from each setting as a sideband (same pattern as `abc`), stored in `sourceUrlBySetting`. Re-attached in `settingsFromTuneID`. Production data URLs updated to `https://folkfriend-data.web.app/...`. Update threshold changed from `daysSinceUpdate >= 28` to `remoteVersion > localVersion`. (Fetching, caching and the update check were rewritten in July 2026 — see "Offline architecture" above.)

- **`app/vue.config.js`** — Added `StaleWhileRevalidate` runtime cache entries for both local and CDN tune index URLs. **Removed in July 2026** — they were a second 42 MB copy of the IndexedDB data; see "Offline architecture" above.

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
