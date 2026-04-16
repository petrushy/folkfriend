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

- WASM output from `rust/pkg/` must be copied to `app/src/wasm/` before building the Vue app.
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

User data (favourites + history) is synced to Firestore under `users/{uid}/data/favourites` and `users/{uid}/data/history`. Firestore SDK handles its own offline queue — writes made while offline are automatically replayed when connectivity returns. Security rules are in `firestore.rules`.

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

- On sign-in: `sync.subscribe()` sets up an `onSnapshot` listener on `users/{uid}/data/favourites` only — **history is NOT synced in real-time**
- First snapshot: if Firestore has no data (first device ever), seeds from local IndexedDB; otherwise replaces local with Firestore data
- Subsequent snapshots: fire in real-time when any device writes favourites, update IndexedDB and emit `syncComplete` on `eventBus`
- On every favourites write (`addFavourite`, `removeFavourite`): pushes the full updated array to Firestore immediately
- History is written to Firestore on each `addToHistory` call but there is no `onSnapshot` listener — history changes from another device are not pulled in automatically
- On sign-out: the `onSnapshot` listener is unsubscribed
- Firestore is the source of truth — deletions propagate correctly; no additive-merge that would re-add removed items
- Firestore SDK queues writes made offline and replays them when connectivity returns

**Reactivity pattern:** `store.currentUser` is a plain object (not Vue reactive). Components listen to `eventBus.$on('authStateChanged', ...)` to update their local `data.currentUser`. Similarly, `eventBus.$on('syncComplete', ...)` triggers list reloads in `Favourites.vue`.

### User settings added

- `recordingTimeLimitSecs` (default: 10, range: 5–60) — max recording length before auto-stop. Note: the search algorithm is optimised for ~10s; longer recordings can reduce accuracy due to NW alignment scoring and quadratic query time.

### Help/About page additions

- Tune dataset date derived from `store.state.tuneIndexVersion` (set in `backend.js` after `setupTuneIndex`). The version `v` is days since 2020-01-01; convert with `new Date((1577836800 + v * 86400) * 1000)`.

## Recent changes

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
