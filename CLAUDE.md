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

## Recent changes

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
